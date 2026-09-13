// Five UI events from docs/EXEC-CONTRACT.md. Every platform renders these;
// the relay emits them as `data: <json>\n\n` SSE frames from POST /api/exec.

export type UiEvent =
  | { type: "started"; runId: string }
  | { type: "delta"; text: string }
  | { type: "log"; stream: "stderr" | "info"; text: string }
  | { type: "done"; text: string; terminal: string; exitCode: number }
  | { type: "error"; message: string };

export interface ExecRequest {
  prompt: string;
  workspace?: string;
  model?: string;
  reasoningEffort?: string;
  approvalMode?: string;
  sessionId?: string;
  provider?: string;
}

export interface ExecClientOptions {
  relayUrl: string;
  token: string;
  signal: AbortSignal;
  onEvent: (event: UiEvent) => void;
}

// Subscription-token rule (EXEC-CONTRACT.md): the only credential ever sent
// is the relay Bearer token. Never a provider API key.
export async function runExec(
  body: ExecRequest,
  opts: ExecClientOptions,
): Promise<void> {
  const base = opts.relayUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/exec`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`relay ${res.status}: ${res.statusText || "request failed"}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Iterate SSE frames; a frame ends at a blank line.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice("data:".length).trim();
        if (payload === "[DONE]") return;
        try {
          opts.onEvent(JSON.parse(payload) as UiEvent);
        } catch {
          opts.onEvent({
            type: "error",
            message: `unparseable SSE frame: ${payload.slice(0, 120)}`,
          });
        }
      }
    }
  }
}

// Transcribe events from POST /api/transcribe (docs/TRANSCRIBE.md).

export interface TranscriptSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

export interface TranscriptResult {
  engine: string;
  diarization: "external" | "none";
  language: string;
  duration: number | null;
  speakers: string[];
  segments: TranscriptSegment[];
  text: string;
}

export type TranscribeEvent =
  | { type: "started"; jobId: string }
  | { type: "progress"; stage: string; detail: string }
  | { type: "log"; stream: "stderr" | "info"; text: string }
  | { type: "done"; result: TranscriptResult }
  | { type: "error"; message: string };

export interface TranscribeRequest {
  kind: "url" | "rss" | "path";
  value: string;
  index?: number;
  language?: string;
  diarize?: boolean;
  model?: string;
}

export interface TranscribeClientOptions {
  relayUrl: string;
  token: string;
  signal: AbortSignal;
  onEvent: (event: TranscribeEvent) => void;
}

async function streamTranscribeBody(res: Response, opts: TranscribeClientOptions): Promise<void> {
  if (!res.body) throw new Error("transcribe request failed: empty body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice("data:".length).trim();
        if (payload === "[DONE]") return;
        try {
          opts.onEvent(JSON.parse(payload) as TranscribeEvent);
        } catch {
          opts.onEvent({ type: "error", message: `unparseable SSE frame: ${payload.slice(0, 120)}` });
        }
      }
    }
  }
}

export async function runTranscribe(body: TranscribeRequest, opts: TranscribeClientOptions): Promise<void> {
  const base = opts.relayUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/api/transcribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.token}`,
    },
    body: JSON.stringify({
      source: { kind: body.kind, value: body.value.trim(), index: body.index },
      language: body.language,
      diarize: body.diarize,
      model: body.model,
    }),
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`relay ${res.status}: ${res.statusText || "transcribe failed"}`);
  await streamTranscribeBody(res, opts);
}

export async function runTranscribeUpload(
  file: File,
  options: { language?: string; diarize?: boolean; model?: string },
  opts: TranscribeClientOptions,
): Promise<void> {
  const base = opts.relayUrl.replace(/\/+$/, "");
  const form = new FormData();
  form.append("audio", file, file.name);
  if (options.language) form.append("language", options.language);
  if (options.diarize === false) form.append("diarize", "false");
  if (options.model) form.append("model", options.model);
  const res = await fetch(`${base}/api/transcribe`, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.token}` },
    body: form,
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`relay ${res.status}: ${res.statusText || "upload failed"}`);
  await streamTranscribeBody(res, opts);
}

export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const m = Math.floor(s / 60);
  const sec = (s - m * 60).toFixed(3).padStart(6, "0");
  return `${String(m).padStart(2, "0")}:${sec}`;
}
