// OpenAI-compatible provider endpoint for the relay.
//
// Routes (registered in server.ts, same Bearer auth as /api/*):
//   GET  /v1/models
//   POST /v1/chat/completions
//
// PROMPT CHOICE (documented): the muse backend is single-turn per request —
// it takes one prompt string, not a message list. So buildChatPrompt keeps
// every system-role message (joined with blank lines, in order) plus ONLY
// the last user-role message, joined with a blank line. Earlier user/assistant
// turns are dropped from the prompt; multi-turn continuity comes from the
// `user` key instead (a module-level SdkSessionManager keeps one stateful
// SDK session per `user` value, so the server already holds the history).
// Without `user`, each request is a one-shot runMuseExec turn.

import { runMuseExec } from "./muse.ts";
import type { RelayConfig } from "./config.ts";
import { SdkSessionManager } from "./sessions.ts";

export const OPENAI_MODEL_ID = "muse-code";

// ---------------------------------------------------------------------------
// Pure functions (unit-tested in tests/openai_test.ts)
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: string;
  content: unknown;
}

/** Extract plain text from an OpenAI message content field.
 *  Accepts a string, or an array of parts where every part is
 *  {type:"text", text:string} (joined with ""). Returns null when the
 *  content uses unsupported part types (e.g. image_url) or shapes. */
export function extractTextContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const pieces: string[] = [];
  for (const part of content) {
    if (
      typeof part !== "object" || part === null ||
      (part as Record<string, unknown>).type !== "text" ||
      typeof (part as Record<string, unknown>).text !== "string"
    ) {
      return null;
    }
    pieces.push((part as Record<string, unknown>).text as string);
  }
  return pieces.join("");
}

export type PromptResult =
  | { ok: true; prompt: string }
  | { ok: false; message: string };

const SUPPORTED_ROLES = new Set(["system", "user", "assistant"]);

/** Build the single backend prompt from an OpenAI messages array.
 *  System texts (in order) joined with blank lines, then the last user
 *  message, joined with a blank line. Assistant messages are accepted but
 *  not included (see module doc). Anything else is a 400-class error. */
export function buildChatPrompt(messages: unknown): PromptResult {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, message: "messages must be a non-empty array" };
  }
  const systemParts: string[] = [];
  let lastUser: string | null = null;
  for (const m of messages) {
    if (typeof m !== "object" || m === null) {
      return { ok: false, message: "each message must be an object with role and content" };
    }
    const { role, content } = m as ChatMessage;
    if (typeof role !== "string" || !SUPPORTED_ROLES.has(role)) {
      return {
        ok: false,
        message: `unsupported role ${JSON.stringify(role)} (supported: system, user, assistant)`,
      };
    }
    const text = extractTextContent(content);
    if (text === null) {
      return {
        ok: false,
        message: "message content must be a string or an array of {type:\"text\", text} parts",
      };
    }
    if (role === "system") {
      if (text.trim() !== "") systemParts.push(text);
    } else if (role === "user") {
      lastUser = text;
    }
    // assistant messages: accepted, not forwarded (see module doc).
  }
  if (lastUser === null || lastUser.trim() === "") {
    return { ok: false, message: "messages must include a non-empty user message" };
  }
  const prompt = [...systemParts, lastUser].join("\n\n");
  if (prompt.trim() === "") return { ok: false, message: "prompt is empty" };
  if (prompt.length > 200_000) return { ok: false, message: "prompt exceeds 200000 chars" };
  return { ok: true, prompt };
}

/** OpenAI-shaped error body: {error:{message, type}}. */
export function openAiError(message: string, type = "invalid_request_error"): Record<string, unknown> {
  return { error: { message, type } };
}

export interface ChunkOpts {
  id: string;
  created: number;
  model: string;
  content: string;
  finishReason: string | null;
}

/** One OpenAI chat.completion.chunk SSE frame (`data: {...}\n\n`). */
export function formatChatChunkFrame(opts: ChunkOpts): string {
  return `data: ${
    JSON.stringify({
      id: opts.id,
      object: "chat.completion.chunk",
      created: opts.created,
      model: opts.model,
      choices: [{
        index: 0,
        delta: opts.content !== "" ? { content: opts.content } : {},
        finish_reason: opts.finishReason,
      }],
    })
  }\n\n`;
}

/** Terminal SSE frame for OpenAI streams. */
export function formatChatDoneFrame(): string {
  return "data: [DONE]\n\n";
}

/** Full non-streaming chat.completion body (usage deliberately omitted:
 *  the backend reports no token counts). */
export function buildChatCompletionBody(
  opts: { id: string; created: number; model: string; content: string },
): Record<string, unknown> {
  return {
    id: opts.id,
    object: "chat.completion",
    created: opts.created,
    model: opts.model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: opts.content },
      finish_reason: "stop",
    }],
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function handleModels(): Response {
  return new Response(
    JSON.stringify({
      object: "list",
      data: [{
        id: OPENAI_MODEL_ID,
        object: "model",
        created: 0,
        owned_by: "muse-code-gui-relay",
      }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// Managed continuity: one shared SDK host, one server session per `user` key.
let sharedManager: SdkSessionManager | null = null;
const userSessions = new Map<string, string>(); // user key -> SDK sessionId

function managerFor(cfg: RelayConfig): SdkSessionManager {
  if (!sharedManager) sharedManager = new SdkSessionManager({ museBin: cfg.museBin });
  return sharedManager;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleChatCompletions(req: Request, cfg: RelayConfig): Promise<Response> {
  if (req.method !== "POST") return json(405, openAiError("method not allowed", "invalid_request_error"));
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(400, openAiError("invalid JSON body"));
  }
  const built = buildChatPrompt(body.messages);
  if (!built.ok) return json(400, openAiError(built.message));
  const prompt = built.prompt;
  const stream = body.stream === true;
  // `model` passes through to the backend, except our own pseudo-model id
  // which just means "relay default".
  const model = typeof body.model === "string" && body.model !== "" && body.model !== OPENAI_MODEL_ID
    ? body.model
    : undefined;
  const userKey = typeof body.user === "string" && body.user !== "" ? body.user : null;

  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const modelName = typeof body.model === "string" && body.model !== "" ? body.model : OPENAI_MODEL_ID;

  async function* turnEvents() {
    if (userKey !== null) {
      const manager = managerFor(cfg);
      let sessionId = userSessions.get(userKey);
      if (!sessionId) {
        try {
          ({ sessionId } = await manager.start({}));
        } catch (err) {
          yield {
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          } as const;
          return;
        }
        userSessions.set(userKey, sessionId);
      }
      try {
        yield* manager.send({ sessionId, prompt, signal: req.signal });
      } catch (err) {
        // Stale handle (e.g. host restart): drop it so the next turn opens
        // a fresh session, and report this turn as failed.
        userSessions.delete(userKey);
        if (!req.signal.aborted) {
          yield {
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          } as const;
        }
      }
    } else {
      yield* runMuseExec(cfg.museBin, { prompt, model }, req.signal);
    }
  }

  if (!stream) {
    let text = "";
    let sawDone = false;
    for await (const e of turnEvents()) {
      if (req.signal.aborted) return new Response(null, { status: 499 });
      if (e.type === "delta") text += e.text;
      else if (e.type === "done") {
        if (text === "") text = e.text;
        sawDone = true;
      } else if (e.type === "error") {
        return json(502, openAiError(e.message, "server_error"));
      }
    }
    if (req.signal.aborted) return new Response(null, { status: 499 });
    if (!sawDone && text === "") return json(502, openAiError("turn produced no output", "server_error"));
    return json(200, buildChatCompletionBody({ id, created, model: modelName, content: text }));
  }

  const events = turnEvents();
  const streamBody = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (frame: string) => controller.enqueue(encoder.encode(frame));
      let sawDelta = false;
      try {
        for await (const e of events) {
          if (req.signal.aborted) break;
          if (e.type === "delta") {
            if (e.text !== "") {
              sawDelta = true;
              send(formatChatChunkFrame({ id, created, model: modelName, content: e.text, finishReason: null }));
            }
          } else if (e.type === "done") {
            // Backends emit the full text as deltas AND done; only emit
            // done.text when no deltas arrived, to avoid doubling content.
            if (!sawDelta && e.text !== "") {
              send(formatChatChunkFrame({ id, created, model: modelName, content: e.text, finishReason: null }));
            }
            break;
          } else if (e.type === "error") {
            send(`data: ${JSON.stringify(openAiError(e.message, "server_error"))}\n\n`);
            break;
          }
          // started/log events have no OpenAI mapping; skip.
        }
        if (!req.signal.aborted) {
          send(formatChatChunkFrame({ id, created, model: modelName, content: "", finishReason: "stop" }));
          send(formatChatDoneFrame());
        }
      } catch (err) {
        if (!req.signal.aborted) {
          const msg = err instanceof Error ? err.message : String(err);
          send(`data: ${JSON.stringify(openAiError(msg, "server_error"))}\n\n`);
        }
      } finally {
        controller.close();
      }
    },
    cancel() {},
  });
  return new Response(streamBody, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
