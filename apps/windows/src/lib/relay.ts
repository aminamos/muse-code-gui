// Relay client targeting the SSE API in docs/EXEC-CONTRACT.md.
// Auth is a relay subscription token (Bearer). Never a provider API key:
// the relay inherits the host's `muse` login from its own environment.

import { sseDataToUiEvent, type ExecUiEvent } from "./execEvents";
import {
  sseDataToTranscribeEvent,
  type TranscribeEvent,
  type TranscribeRequest,
} from "./transcribeEvents";

/** Desktop default: localhost relay. Remote override via settings. */
export const DEFAULT_RELAY_URL = "http://127.0.0.1:8787";

export interface RelaySettings {
  baseUrl: string;
  token: string;
}

export interface RelayHealth {
  ok: boolean;
  museBin: string;
  museVersion: string;
}

export interface ExecRequest {
  prompt: string;
  workspace?: string;
  model?: string;
  reasoningEffort?: string;
  approvalMode?: string;
  sessionId?: string;
  provider?: string;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export async function checkRelayHealth(
  settings: RelaySettings,
): Promise<RelayHealth> {
  const res = await fetch(joinUrl(settings.baseUrl, "/api/health"), {
    headers: settings.token
      ? { Authorization: `Bearer ${settings.token}` }
      : undefined,
  });
  if (!res.ok) throw new Error(`health check failed: HTTP ${res.status}`);
  const body = (await res.json()) as Partial<RelayHealth>;
  return {
    ok: body.ok === true,
    museBin: String(body.museBin ?? ""),
    museVersion: String(body.museVersion ?? ""),
  };
}

/**
 * POST /api/exec and stream the five UI events. Resolves when the stream
 * closes; rejects on HTTP errors. Abort via `signal` (Stop button).
 */
export async function runExecStream(
  settings: RelaySettings,
  request: ExecRequest,
  onEvent: (event: ExecUiEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(joinUrl(settings.baseUrl, "/api/exec"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.token}`,
    },
    body: JSON.stringify(request),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `exec request failed: HTTP ${res.status}${text ? ` ${text}` : ""}`,
    );
  }
  if (res.body === null) throw new Error("exec request failed: empty body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let frameEnd = buffer.indexOf("\n\n");
    while (frameEnd !== -1) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      for (const line of frame.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) {
          const data = trimmed.slice("data:".length).trim();
          if (data === "[DONE]") continue;
          const event = sseDataToUiEvent(data);
          if (event !== null) onEvent(event);
        }
      }
      frameEnd = buffer.indexOf("\n\n");
    }
  }
}

async function streamTranscribeResponse(
  res: Response,
  onEvent: (event: TranscribeEvent) => void,
): Promise<void> {
  if (res.body === null) throw new Error("transcribe request failed: empty body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let frameEnd = buffer.indexOf("\n\n");
    while (frameEnd !== -1) {
      const frame = buffer.slice(0, frameEnd);
      buffer = buffer.slice(frameEnd + 2);
      for (const line of frame.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("data:")) {
          const data = trimmed.slice("data:".length).trim();
          if (data === "[DONE]") continue;
          const event = sseDataToTranscribeEvent(data);
          if (event !== null) onEvent(event);
        }
      }
      frameEnd = buffer.indexOf("\n\n");
    }
  }
}

/** POST /api/transcribe with a JSON source; stream transcribe events. */
export async function runTranscribeStream(
  settings: RelaySettings,
  request: TranscribeRequest,
  onEvent: (event: TranscribeEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(joinUrl(settings.baseUrl, "/api/transcribe"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.token}`,
    },
    body: JSON.stringify({
      source: { kind: request.kind, value: request.value.trim(), index: request.index },
      language: request.language,
      diarize: request.diarize,
      model: request.model,
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`transcribe request failed: HTTP ${res.status}${text ? ` ${text}` : ""}`);
  }
  await streamTranscribeResponse(res, onEvent);
}

/** POST /api/transcribe with multipart file upload; stream transcribe events. */
export async function runTranscribeUpload(
  settings: RelaySettings,
  file: File,
  options: { language?: string; diarize?: boolean; model?: string },
  onEvent: (event: TranscribeEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const form = new FormData();
  form.append("audio", file, file.name);
  if (options.language) form.append("language", options.language);
  if (options.diarize === false) form.append("diarize", "false");
  if (options.model) form.append("model", options.model);
  const res = await fetch(joinUrl(settings.baseUrl, "/api/transcribe"), {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.token}` },
    body: form,
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`transcribe upload failed: HTTP ${res.status}${text ? ` ${text}` : ""}`);
  }
  await streamTranscribeResponse(res, onEvent);
}
