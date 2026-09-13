// MCP tools over JSON-RPC (no SDK dependency). Shared by stdio
// (mcp-stdio.ts) and Streamable HTTP (POST /mcp in server.ts).
// Protocol: newline-delimited JSON-RPC 2.0 on stdio; single JSON-RPC
// request/response on HTTP. Stateless; notifications return null (202).

import { runMuseExec } from "./muse.ts";
import { runTranscribe, parseRssEpisodes } from "./transcribe.ts";
import { runIngest } from "./ingest.ts";
import type { RelayConfig } from "./config.ts";

const SERVER_INFO = { name: "muse-code-ui-relay", version: "0.1.0" };
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const TOOLS = [
  {
    name: "muse_exec",
    description: "Run one prompt with `muse exec` on the relay host (uses the host's Muse subscription login). Returns the final text plus terminal status.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "Prompt to run" },
        workspace: { type: "string" },
        model: { type: "string" },
        reasoningEffort: { type: "string" },
        approvalMode: { type: "string" },
        sessionId: { type: "string" },
        yolo: { type: "boolean" },
      },
    },
  },
  {
    name: "transcribe_audio",
    description: "Transcribe audio/video (mp3, m4a, mp4, m4b, wav, ...) with local whisper and optional speaker diarization. Source may be an http(s) URL, a relay-local path, or an RSS feed URL.",
    inputSchema: {
      type: "object",
      required: ["source"],
      properties: {
        source: {
          type: "object",
          required: ["kind", "value"],
          properties: {
            kind: { type: "string", enum: ["url", "path", "rss"] },
            value: { type: "string" },
            index: { type: "number", description: "RSS episode index, default 0" },
          },
        },
        language: { type: "string", default: "en" },
        diarize: { type: "boolean", default: true },
        model: { type: "string", description: "whisper model, default relay WHISPER_MODEL" },
      },
    },
  },
  {
    name: "ingest_document",
    description: "Extract plain text from txt/md/epub/pdf supplied inline, by relay-local path, or by http(s) URL.",
    inputSchema: {
      type: "object",
      required: ["source"],
      properties: {
        source: {
          type: "object",
          required: ["kind", "value"],
          properties: {
            kind: { type: "string", enum: ["text", "path", "url"] },
            value: { type: "string" },
            filename: { type: "string" },
          },
        },
      },
    },
  },
  {
    name: "rss_episodes",
    description: "List audio episodes (index, title, audio URL) from a podcast RSS feed URL.",
    inputSchema: {
      type: "object",
      required: ["feedUrl"],
      properties: {
        feedUrl: { type: "string" },
        limit: { type: "number", default: 50 },
      },
    },
  },
];

function textResult(text: string) {
  return { content: [{ type: "text", text }] };
}

async function callTool(cfg: RelayConfig, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
  switch (name) {
    case "muse_exec": {
      if (typeof args.prompt !== "string" || args.prompt === "") throw new Error("prompt is required");
      const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
      let text = "";
      let terminal = "";
      let exitCode = 0;
      const logs: string[] = [];
      for await (
        const e of runMuseExec(cfg.museBin, {
          prompt: args.prompt,
          workspace: str(args.workspace),
          model: str(args.model),
          reasoningEffort: str(args.reasoningEffort),
          approvalMode: str(args.approvalMode),
          sessionId: str(args.sessionId),
          yolo: args.yolo === true,
        }, signal)
      ) {
        if (e.type === "delta") {
          text += e.text;
          if (text.length > 200_000) text = text.slice(0, 200_000);
        } else if (e.type === "log") logs.push(`[${e.stream}] ${e.text}`.slice(0, 300));
        else if (e.type === "done") {
          if (text === "") text = e.text;
          terminal = e.terminal;
          exitCode = e.exitCode;
        } else if (e.type === "error") throw new Error(e.message);
      }
      return textResult(JSON.stringify({ text, terminal, exitCode, logs: logs.slice(0, 100) }));
    }
    case "transcribe_audio": {
      const src = args.source as Record<string, unknown> | undefined;
      if (!src || (src.kind !== "url" && src.kind !== "path" && src.kind !== "rss") || typeof src.value !== "string") {
        throw new Error("source must be { kind: url|path|rss, value, index? }");
      }
      for await (
        const e of runTranscribe(cfg, {
          source: { kind: src.kind, value: src.value, index: typeof src.index === "number" ? src.index : undefined },
          language: typeof args.language === "string" ? args.language : undefined,
          diarize: args.diarize === false ? false : undefined,
          model: typeof args.model === "string" ? args.model : undefined,
        }, signal)
      ) {
        if (e.type === "done") return textResult(JSON.stringify(e.result));
        if (e.type === "error") throw new Error(e.message);
      }
      throw new Error("transcription ended without a result");
    }
    case "ingest_document": {
      const src = args.source as Record<string, unknown> | undefined;
      if (!src || (src.kind !== "text" && src.kind !== "path" && src.kind !== "url") || typeof src.value !== "string") {
        throw new Error("source must be { kind: text|path|url, value, filename? }");
      }
      const result = await runIngest(cfg, {
        kind: src.kind,
        value: src.value,
        filename: typeof src.filename === "string" ? src.filename : undefined,
      }, signal);
      return textResult(JSON.stringify(result));
    }
    case "rss_episodes": {
      if (typeof args.feedUrl !== "string") throw new Error("feedUrl is required");
      const res = await fetch(args.feedUrl, { signal });
      if (!res.ok) throw new Error(`feed fetch failed: HTTP ${res.status}`);
      const limit = typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 200) : 50;
      return textResult(JSON.stringify(parseRssEpisodes(await res.text(), limit)));
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export async function handleJsonRpc(cfg: RelayConfig, msg: unknown, signal: AbortSignal): Promise<unknown> {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
  }
  const { jsonrpc, id, method, params } = msg as Record<string, unknown>;
  if (jsonrpc !== "2.0" || typeof method !== "string") {
    return { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "invalid request" } };
  }
  const isNotification = id === undefined;
  try {
    let result: unknown = null;
    if (method === "initialize") {
      const requested = (params as Record<string, unknown> | undefined)?.protocolVersion;
      result = {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(requested as string) ? requested : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    } else if (method === "notifications/initialized" || method.startsWith("notifications/")) {
      return null;
    } else if (method === "ping") {
      result = {};
    } else if (method === "tools/list") {
      result = { tools: TOOLS };
    } else if (method === "tools/call") {
      const p = (params ?? {}) as Record<string, unknown>;
      if (typeof p.name !== "string") throw new Error("tools/call requires name");
      result = await callTool(cfg, p.name, (p.arguments ?? {}) as Record<string, unknown>, signal);
    } else {
      return isNotification ? null : { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
    }
    return isNotification ? null : { jsonrpc: "2.0", id, result };
  } catch (err) {
    if (isNotification) return null;
    return { jsonrpc: "2.0", id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } };
  }
}
