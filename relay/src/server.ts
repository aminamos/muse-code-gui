// Relay HTTP server: exec + transcribe + ingest + MCP (Streamable HTTP) + OpenAI (/v1/*).
// Auth: `Authorization: Bearer <token>` on every /api/*, /v1/*, and /mcp route.

import { getMuseVersion, runMuseExec, type ExecOptions } from "./muse.ts";
import { sseResponse } from "./events.ts";
import { auditBinaries, billingMode, formatBinaryAudit, loadConfig, type RelayConfig } from "./config.ts";
import { handleChatCompletions, handleModels } from "./openai.ts";
import { runTranscribe, type TranscribeOptions } from "./transcribe.ts";
import { runVoiceEvents } from "./voice.ts";
import { runIngest, type IngestSource } from "./ingest.ts";
import { handleJsonRpc } from "./mcp.ts";

// Browsers (Tauri WebView, Expo web) call the relay cross-origin with
// `Authorization` + JSON bodies, which triggers a CORS preflight. The relay
// binds localhost and authenticates every non-OPTIONS request, so a wildcard
// origin is safe here.
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function preflight(): Response {
  return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
}

function isManagedPath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/v1/") ||
    pathname === "/mcp"
  );
}

function checkAuth(req: Request, cfg: RelayConfig): boolean {
  const header = req.headers.get("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  return token !== "" && token === cfg.token;
}

function normalizeWorkspacePath(p: string, os: string): string {
  let n = p.replace(/\\/g, "/");
  // Strip trailing slashes (but keep bare drive root like C:/).
  while (n.length > 1 && n.endsWith("/") && !/^[a-zA-Z]:\/$/.test(n)) n = n.slice(0, -1);
  if (os === "windows") n = n.toLowerCase();
  return n;
}

export function workspaceAllowed(cfg: RelayConfig, workspace: string, os?: string): boolean {
  if (!cfg.workspaceRoots) return true;
  const o = os ?? Deno.build.os;
  const ws = normalizeWorkspacePath(workspace, o);
  return cfg.workspaceRoots.some((root) => {
    const r = normalizeWorkspacePath(root, o);
    return ws === r || ws.startsWith(r.endsWith("/") ? r : r + "/");
  });
}

async function handleHealth(cfg: RelayConfig): Promise<Response> {
  return json(200, {
    ok: true,
    billing: billingMode(),
    museBin: cfg.museBin,
    museLauncher: cfg.museLauncher ?? null,
    museVersion: await getMuseVersion(cfg.museBin),
    transcribe: {
      engine: "whisper",
      whisperBin: cfg.whisperBin ?? null,
      whisperModel: cfg.whisperModel,
      diarizer: cfg.diarizeHelper ?? null,
      ffmpegBin: cfg.ffmpegBin ?? null,
      ffprobeBin: cfg.ffprobeBin ?? null,
    },
    ingest: { pdf: cfg.pdftotextBin !== null, epub: cfg.unzipBin !== null },
    binaries: auditBinaries(cfg),
  });
}

async function handleExec(req: Request, cfg: RelayConfig): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  if (typeof body.prompt !== "string" || body.prompt.trim() === "") {
    return json(400, { error: "prompt must be a non-empty string" });
  }
  if (body.prompt.length > 200_000) {
    return json(400, { error: "prompt exceeds 200000 chars" });
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
  const workspace = str(body.workspace);
  if (workspace && !workspaceAllowed(cfg, workspace)) {
    return json(403, { error: "workspace outside MUSE_GUI_WORKSPACES allowlist" });
  }
  const opts: ExecOptions = {
    prompt: body.prompt,
    workspace,
    model: str(body.model),
    reasoningEffort: str(body.reasoningEffort),
    approvalMode: str(body.approvalMode),
    sessionId: str(body.sessionId),
    provider: str(body.provider),
    yolo: body.yolo === true,
    maxModelSteps: typeof body.maxModelSteps === "number" ? body.maxModelSteps : undefined,
  };
  return sseResponse(runMuseExec(cfg.museBin, opts, req.signal), req.signal);
}

async function handleTranscribe(req: Request, cfg: RelayConfig): Promise<Response> {
  const contentType = req.headers.get("Content-Type") ?? "";
  let opts: TranscribeOptions;
  let uploadTmp: string | null = null;
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("audio");
    if (!(file instanceof File)) return json(400, { error: 'multipart field "audio" is required' });
    uploadTmp = await Deno.makeTempFile({ prefix: "mcu-upload-", suffix: `-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}` });
    await Deno.writeFile(uploadTmp, new Uint8Array(await file.arrayBuffer()));
    opts = {
      source: { kind: "path", value: uploadTmp },
      language: typeof form.get("language") === "string" ? String(form.get("language")) : undefined,
      diarize: form.get("diarize") !== "false",
      model: typeof form.get("model") === "string" ? String(form.get("model")) : undefined,
    };
  } else {
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    const src = body.source as Record<string, unknown> | undefined;
    if (!src || (src.kind !== "url" && src.kind !== "path" && src.kind !== "rss") || typeof src.value !== "string" || src.value === "") {
      return json(400, { error: "source must be { kind: url|path|rss, value, index? }" });
    }
    opts = {
      source: { kind: src.kind, value: src.value, index: typeof src.index === "number" ? src.index : undefined },
      language: typeof body.language === "string" ? body.language : undefined,
      diarize: body.diarize === false ? false : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
    };
  }
  async function* events() {
    try {
      yield* runTranscribe(cfg, opts, req.signal);
    } finally {
      if (uploadTmp) await Deno.remove(uploadTmp).catch(() => {});
    }
  }
  return sseResponse(events(), req.signal);
}

async function handleVoiceExec(req: Request, cfg: RelayConfig): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  const audio = body.audio as Record<string, unknown> | undefined;
  if (!audio || (audio.kind !== "url" && audio.kind !== "path" && audio.kind !== "rss") || typeof audio.value !== "string" || audio.value === "") {
    return json(400, { error: "audio must be { kind: url|path|rss, value, index? }" });
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
  const workspace = str(body.workspace);
  if (workspace && !workspaceAllowed(cfg, workspace)) {
    return json(403, { error: "workspace outside MUSE_GUI_WORKSPACES allowlist" });
  }
  return sseResponse(
    runVoiceEvents(cfg, {
      source: { kind: audio.kind, value: audio.value, index: typeof audio.index === "number" ? audio.index : undefined },
      language: typeof body.language === "string" ? body.language : undefined,
      diarize: body.diarize === false ? false : undefined,
      transcribeModel: str(body.transcribeModel),
      promptPrefix: str(body.promptPrefix),
      exec: {
        workspace,
        model: str(body.model),
        reasoningEffort: str(body.reasoningEffort),
        approvalMode: str(body.approvalMode),
        sessionId: str(body.sessionId),
        provider: str(body.provider),
        yolo: body.yolo === true,
        maxModelSteps: typeof body.maxModelSteps === "number" ? body.maxModelSteps : undefined,
      },
    }, req.signal),
    req.signal,
  );
}

async function handleIngest(req: Request, cfg: RelayConfig): Promise<Response> {
  const contentType = req.headers.get("Content-Type") ?? "";
  let src: IngestSource;
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("document");
    if (!(file instanceof File)) return json(400, { error: 'multipart field "document" is required' });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const tmp = await Deno.makeTempFile({ prefix: "mcu-doc-", suffix: `-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}` });
    try {
      await Deno.writeFile(tmp, bytes);
      src = { kind: "path", value: tmp, filename: file.name };
      return json(200, await runIngest(cfg, src, req.signal));
    } catch (err) {
      return json(422, { error: err instanceof Error ? err.message : String(err) });
    } finally {
      await Deno.remove(tmp).catch(() => {});
    }
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: "invalid JSON body" });
  }
  const s = body.source as Record<string, unknown> | undefined;
  if (!s || (s.kind !== "text" && s.kind !== "path" && s.kind !== "url") || typeof s.value !== "string" || s.value === "") {
    return json(400, { error: "source must be { kind: text|path|url, value, filename? }" });
  }
  src = { kind: s.kind, value: s.value, filename: typeof s.filename === "string" ? s.filename : undefined };
  try {
    return json(200, await runIngest(cfg, src, req.signal));
  } catch (err) {
    return json(422, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleMcp(req: Request, cfg: RelayConfig): Promise<Response> {
  if (req.method !== "POST") {
    return json(405, { error: "MCP uses POST with JSON-RPC bodies" });
  }
  let msg: unknown;
  try {
    msg = await req.json();
  } catch {
    return json(200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  const res = await handleJsonRpc(cfg, msg, req.signal);
  if (res === null) return new Response(null, { status: 202 });
  return json(200, res);
}

function router(cfg: RelayConfig) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!isManagedPath(url.pathname)) {
      return json(404, { error: "not found" });
    }
    // Preflight carries no auth; real requests are still Bearer-gated below.
    if (req.method === "OPTIONS") return preflight();
    if (!checkAuth(req, cfg)) {
      return json(401, { error: "missing or invalid bearer token" });
    }
    try {
      if (req.method === "GET" && url.pathname === "/api/health") return await handleHealth(cfg);
      if (req.method === "POST" && url.pathname === "/api/exec") return await handleExec(req, cfg);
      if (req.method === "POST" && url.pathname === "/api/transcribe") return await handleTranscribe(req, cfg);
      if (req.method === "POST" && url.pathname === "/api/voice_exec") return await handleVoiceExec(req, cfg);
      if (req.method === "POST" && url.pathname === "/api/ingest") return await handleIngest(req, cfg);
      if (req.method === "GET" && url.pathname === "/v1/models") return handleModels();
      if (url.pathname === "/v1/chat/completions") return await handleChatCompletions(req, cfg);
      if (url.pathname === "/mcp") return await handleMcp(req, cfg);
      return json(404, { error: "not found" });
    } catch (err) {
      return json(500, { error: err instanceof Error ? err.message : String(err) });
    }
  };
}

if (import.meta.main) {
  const cfg = loadConfig(Deno.args);
  console.error(`muse-code-gui relay on http://${cfg.bindHost}:${cfg.port}`);
  console.error(`binaries: ${formatBinaryAudit(cfg)}`);
  console.error(`whisper model: ${cfg.whisperModel}`);
  if (!cfg.whisperBin) console.error("whisper: missing (transcribe disabled until installed)");
  if (!cfg.ffmpegBin) console.error("ffmpeg: missing (transcribe disabled until installed)");
  if (!cfg.diarizeHelper) console.error("diarizer: none (single-speaker fallback)");
  if (cfg.tokenGenerated) console.error(`relay token (generated, this run only): ${cfg.token}`);
  if (billingMode() === "api_key") console.error("API-credit env detected (META_API_KEY/MUSE_API_TOKEN): muse will bill API credits, not the subscription login");
  Deno.serve({ port: cfg.port, hostname: cfg.bindHost }, router(cfg));
}
