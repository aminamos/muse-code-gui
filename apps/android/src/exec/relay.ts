import type { TranscribeEvent, UIEvent } from "./events";
import { SseFrameParser, parseTranscribeEventPayload, parseUIEventPayload } from "./sse";

// Relay API from docs/EXEC-CONTRACT.md. Android is remote-relay-only: it
// cannot spawn the `muse` binary, so every run goes to a relay URL over LAN
// or Tailscale with a bearer token.
//
// Subscription-token rule: the token here authorizes relay access only. This
// client never carries, injects, or persists a provider API key.
export interface ExecRequest {
  prompt: string;
  workspace?: string;
  model?: string;
  reasoningEffort?: string;
  approvalMode?: string;
  sessionId?: string;
  provider?: string;
}

export interface HealthResponse {
  ok: boolean;
  museBin: string;
  museVersion: string;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export class RelayClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
    this.token = token;
  }

  async health(signal?: AbortSignal): Promise<HealthResponse> {
    const res = await fetch(joinUrl(this.baseUrl, "/api/health"), {
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}` },
      signal,
    });
    if (!res.ok) {
      throw new Error(`relay GET /api/health failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as Partial<HealthResponse>;
    return {
      ok: body.ok === true,
      museBin: typeof body.museBin === "string" ? body.museBin : "",
      museVersion:
        typeof body.museVersion === "string" ? body.museVersion : "",
    };
  }

  // Starts a run. Relay SSE `data:` frames already carry the five UI events,
  // so each frame maps 1:1. Returns a cancel function (Stop button).
  //
  // Streaming uses XMLHttpRequest progress events because React Native's
  // fetch does not expose an incremental byte stream; responseText slices
  // are fed to the SSE parser as they arrive.
  run(onEvent: (event: UIEvent) => void, request: ExecRequest): () => void {
    const xhr = new XMLHttpRequest();
    const parser = new SseFrameParser();
    let seen = 0;
    let cancelled = false;

    const emitAvailable = (final: boolean): void => {
      const text = xhr.responseText ?? "";
      const chunk = text.slice(seen);
      seen = text.length;
      const frames = final
        ? [...parser.feed(chunk), ...parser.flush()]
        : parser.feed(chunk);
      for (const data of frames) {
        onEvent(parseUIEventPayload(data));
      }
    };

    xhr.open("POST", joinUrl(this.baseUrl, "/api/exec"));
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Accept", "text/event-stream");
    xhr.setRequestHeader("Authorization", `Bearer ${this.token}`);
    xhr.onprogress = (): void => {
      if (!cancelled) {
        emitAvailable(false);
      }
    };
    xhr.onload = (): void => {
      if (cancelled) {
        return;
      }
      emitAvailable(true);
      if (xhr.status < 200 || xhr.status >= 300) {
        onEvent({
          type: "error",
          message: `relay POST /api/exec failed: HTTP ${xhr.status}`,
        });
      }
    };
    xhr.onerror = (): void => {
      if (!cancelled) {
        onEvent({ type: "error", message: "relay request failed" });
      }
    };
    xhr.ontimeout = (): void => {
      if (!cancelled) {
        onEvent({ type: "error", message: "relay request timed out" });
      }
    };
    xhr.send(JSON.stringify(request));

    return () => {
      cancelled = true;
      xhr.abort();
    };
  }

  // Transcribe via POST /api/transcribe (docs/TRANSCRIBE.md). Same XHR
  // streaming approach as run(); JSON sources only (url/rss/relay-local
  // path). Returns a cancel function (Stop button).
  transcribe(
    onEvent: (event: TranscribeEvent) => void,
    request: {
      kind: "url" | "rss" | "path";
      value: string;
      index?: number;
      language?: string;
      diarize?: boolean;
      model?: string;
    },
  ): () => void {
    const xhr = new XMLHttpRequest();
    const parser = new SseFrameParser();
    let seen = 0;
    let cancelled = false;

    const emitAvailable = (final: boolean): void => {
      const text = xhr.responseText ?? "";
      const chunk = text.slice(seen);
      seen = text.length;
      const frames = final
        ? [...parser.feed(chunk), ...parser.flush()]
        : parser.feed(chunk);
      for (const data of frames) {
        onEvent(parseTranscribeEventPayload(data));
      }
    };

    xhr.open("POST", joinUrl(this.baseUrl, "/api/transcribe"));
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Accept", "text/event-stream");
    xhr.setRequestHeader("Authorization", `Bearer ${this.token}`);
    xhr.onprogress = (): void => {
      if (!cancelled) {
        emitAvailable(false);
      }
    };
    xhr.onload = (): void => {
      if (cancelled) {
        return;
      }
      emitAvailable(true);
      if (xhr.status < 200 || xhr.status >= 300) {
        onEvent({
          type: "error",
          message: `relay POST /api/transcribe failed: HTTP ${xhr.status}`,
        });
      }
    };
    xhr.onerror = (): void => {
      if (!cancelled) {
        onEvent({ type: "error", message: "relay request failed" });
      }
    };
    xhr.send(
      JSON.stringify({
        source: { kind: request.kind, value: request.value.trim(), index: request.index },
        language: request.language,
        diarize: request.diarize,
        model: request.model,
      }),
    );

    return () => {
      cancelled = true;
      xhr.abort();
    };
  }

  // Transcribe via multipart upload to POST /api/transcribe
  // (docs/TRANSCRIBE.md field `audio` plus optional language/diarize/model
  // fields). Same XHR streaming approach as transcribe(); the relay streams
  // the same transcribe SSE events. Do NOT set Content-Type manually —
  // XHR derives the multipart boundary from the FormData body.
  // Returns a cancel function (Stop button).
  transcribeUpload(
    onEvent: (event: TranscribeEvent) => void,
    file: { uri: string; name: string; mimeType?: string },
    options: { language?: string; diarize?: boolean; model?: string },
  ): () => void {
    const xhr = new XMLHttpRequest();
    const parser = new SseFrameParser();
    let seen = 0;
    let cancelled = false;

    const emitAvailable = (final: boolean): void => {
      const text = xhr.responseText ?? "";
      const chunk = text.slice(seen);
      seen = text.length;
      const frames = final
        ? [...parser.feed(chunk), ...parser.flush()]
        : parser.feed(chunk);
      for (const data of frames) {
        onEvent(parseTranscribeEventPayload(data));
      }
    };

    xhr.open("POST", joinUrl(this.baseUrl, "/api/transcribe"));
    xhr.setRequestHeader("Accept", "text/event-stream");
    xhr.setRequestHeader("Authorization", `Bearer ${this.token}`);
    xhr.onprogress = (): void => {
      if (!cancelled) {
        emitAvailable(false);
      }
    };
    xhr.onload = (): void => {
      if (cancelled) {
        return;
      }
      emitAvailable(true);
      if (xhr.status < 200 || xhr.status >= 300) {
        onEvent({
          type: "error",
          message: `relay POST /api/transcribe failed: HTTP ${xhr.status}`,
        });
      }
    };
    xhr.onerror = (): void => {
      if (!cancelled) {
        onEvent({ type: "error", message: "relay request failed" });
      }
    };

    const form = new FormData();
    form.append("audio", {
      uri: file.uri,
      name: file.name,
      type: file.mimeType ?? "application/octet-stream",
    } as unknown as Blob);
    if (options.language) {
      form.append("language", options.language);
    }
    if (options.diarize === false) {
      form.append("diarize", "false");
    }
    if (options.model) {
      form.append("model", options.model);
    }
    xhr.send(form);

    return () => {
      cancelled = true;
      xhr.abort();
    };
  }
}
