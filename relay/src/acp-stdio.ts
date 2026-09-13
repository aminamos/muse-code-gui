// ACP (Agent Client Protocol, v1) agent over stdio for `muse exec`.
// Wire format: JSON-RPC 2.0, one object per line on stdin/stdout; logs on
// stderr only. The host's `muse login` subscription bills every turn — the
// agent never sees or forwards an API key.
//
// Supported surface (baseline, text only):
//   initialize            -> protocolVersion 1, text prompt capabilities
//   session/new           -> { sessionId } (cwd becomes the exec workspace)
//   session/prompt        -> streams session/update agent_message_chunk,
//                            responds { stopReason: end_turn | cancelled }
//   session/cancel        -> notification; aborts the running turn
//   ping                  -> {} (client keepalive compat)
// Everything else (session/load, session/resume, authenticate, image/audio
// content blocks, client MCP servers) answers method-not-found or
// invalid-params honestly instead of pretending.
//
// Provider: subscription `meta` by default. Set MUSE_ACP_PROVIDER=echo for
// zero-spend protocol testing.

import { billingMode, loadConfig } from "./config.ts";
import { runMuseExec } from "./muse.ts";

const AGENT_INFO = { name: "muse-code-gui-acp", version: "0.1.0" };
const PROTOCOL_VERSION = 1;

interface AcpSession {
  cwd: string;
  controller: AbortController | null;
  busy: boolean;
}

const sessions = new Map<string, AcpSession>();

function provider(): string | undefined {
  const p = Deno.env.get("MUSE_ACP_PROVIDER") ?? "";
  return p !== "" ? p : undefined;
}

interface TextBlock {
  type: string;
  text?: unknown;
}

function promptToText(prompt: unknown): string {
  if (!Array.isArray(prompt)) throw new Error("session/prompt requires prompt[]");
  const parts: string[] = [];
  for (const b of prompt) {
    if (typeof b !== "object" || b === null) throw new Error("prompt blocks must be objects");
    const block = b as TextBlock;
    if (block.type === "text") {
      if (typeof block.text !== "string") throw new Error("text blocks require a string text field");
      parts.push(block.text);
    } else {
      throw new Error(`only text content blocks are supported (got '${block.type}'); transcribe audio first`);
    }
  }
  const text = parts.join("\n").trim();
  if (text === "") throw new Error("prompt has no text");
  if (text.length > 200_000) throw new Error("prompt exceeds 200000 chars");
  return text;
}

type Write = (obj: unknown) => Promise<void>;

type PromptOutcome =
  | { result: { stopReason: string } }
  | { error: { code: number; message: string } };

async function handlePrompt(
  sessionId: string,
  text: string,
  museBin: string,
  write: Write,
): Promise<PromptOutcome> {
  const session = sessions.get(sessionId);
  if (!session) {
    return { error: { code: -32602, message: `unknown session: ${sessionId}` } };
  }
  if (session.busy) {
    return { error: { code: -32602, message: "session already has a running turn" } };
  }
  const controller = new AbortController();
  session.controller = controller;
  session.busy = true;
  let cancelled = false;
  try {
    for await (
      const e of runMuseExec(
        museBin,
        { prompt: text, workspace: session.cwd, provider: provider() },
        controller.signal,
      )
    ) {
      if (e.type === "delta" && e.text !== "") {
        await write({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: e.text },
            },
          },
        });
      } else if (e.type === "error") {
        return { error: { code: -32603, message: e.message } };
      }
      // started/log/done carry no ACP update; completion lands in the response.
    }
    if (controller.signal.aborted) cancelled = true;
    return { result: { stopReason: cancelled ? "cancelled" : "end_turn" } };
  } catch (err) {
    if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
      return { result: { stopReason: "cancelled" } };
    }
    return { error: { code: -32603, message: err instanceof Error ? err.message : String(err) } };
  } finally {
    session.controller = null;
    session.busy = false;
  }
}

async function handleMessage(
  msg: unknown,
  museBin: string,
  write: Write,
): Promise<unknown> {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
    return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
  }
  const { jsonrpc, id, method, params } = msg as Record<string, unknown>;
  if (jsonrpc !== "2.0" || typeof method !== "string") {
    return { jsonrpc: "2.0", id: id ?? null, error: { code: -32600, message: "invalid request" } };
  }
  const p = (params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined;

  // session/cancel is a notification: never respond.
  if (method === "session/cancel") {
    if (typeof p.sessionId === "string") sessions.get(p.sessionId)?.controller?.abort();
    return null;
  }

  let out: { result: unknown } | { error: { code: number; message: string } };
  try {
    switch (method) {
      case "initialize": {
        const requested = typeof p.protocolVersion === "number" ? p.protocolVersion : 0;
        out = {
          result: {
            protocolVersion: requested === PROTOCOL_VERSION ? requested : PROTOCOL_VERSION,
            agentCapabilities: {
              promptCapabilities: { image: false, audio: false, embeddedContext: false },
            },
            agentInfo: AGENT_INFO,
          },
        };
        break;
      }
      case "session/new": {
        if (typeof p.cwd !== "string" || p.cwd === "") {
          throw new Error("session/new requires an absolute cwd");
        }
        let st: Deno.FileInfo;
        try {
          st = await Deno.stat(p.cwd);
        } catch {
          throw new Error(`cwd is not accessible: ${p.cwd}`);
        }
        if (!st.isDirectory) throw new Error("cwd must be a directory");
        const sessionId = crypto.randomUUID();
        sessions.set(sessionId, { cwd: p.cwd, controller: null, busy: false });
        out = { result: { sessionId } };
        break;
      }
      case "session/prompt": {
        if (typeof p.sessionId !== "string") throw new Error("session/prompt requires sessionId");
        const text = promptToText(p.prompt);
        const r = await handlePrompt(p.sessionId, text, museBin, write);
        if ("error" in r) out = { error: r.error };
        else out = { result: r.result };
        break;
      }
      case "ping": {
        out = { result: {} };
        break;
      }
      default: {
        out = { error: { code: -32601, message: `method not found: ${method}` } };
      }
    }
  } catch (err) {
    out = { error: { code: -32602, message: err instanceof Error ? err.message : String(err) } };
  }
  if (isNotification) return null;
  if ("error" in out) return { jsonrpc: "2.0", id, error: out.error };
  return { jsonrpc: "2.0", id, result: out.result };
}

async function main(): Promise<void> {
  const cfg = loadConfig([]);
  if (billingMode() === "api_key") {
    console.error("API-credit env detected (META_API_KEY/MUSE_API_TOKEN): muse will bill API credits, not the subscription login");
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const stdout = Deno.stdout;
  const write: Write = async (obj) => {
    await stdout.write(encoder.encode(JSON.stringify(obj) + "\n"));
  };
  let buffer = "";
  for await (const chunk of Deno.stdin.readable) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line === "") continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        await write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        continue;
      }
      const res = await handleMessage(msg, cfg.museBin, write);
      if (res !== null) await write(res);
    }
  }
}

if (import.meta.main) {
  await main();
}
