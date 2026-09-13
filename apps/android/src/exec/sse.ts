import type { TranscribeEvent, TranscriptResult, UIEvent } from "./events";

// Incremental Server-Sent Events frame parser. Feed arbitrary text chunks
// (e.g. XMLHttpRequest.responseText slices); complete `data:` payloads are
// returned in order. Comment/heartbeat lines are dropped.
export class SseFrameParser {
  private buffer = "";

  feed(chunk: string): string[] {
    const frames: string[] = [];
    this.buffer += chunk.replace(/\r\n/g, "\n");
    let idx = this.buffer.indexOf("\n\n");
    while (idx !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const data = raw
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data.length > 0) {
        frames.push(data);
      }
      idx = this.buffer.indexOf("\n\n");
    }
    return frames;
  }

  flush(): string[] {
    if (this.buffer.trim().length === 0) {
      this.buffer = "";
      return [];
    }
    const rest = this.buffer;
    this.buffer = "";
    const data = rest
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    return data.length > 0 ? [data] : [];
  }
}

const EVENT_TYPES = new Set(["started", "delta", "log", "done", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Parse one relay SSE `data:` payload into a UI event. Unparseable or
// unrecognized frames become `error` events so the stream keeps flowing,
// mirroring the contract's per-line error rule for JSONL.
export function parseUIEventPayload(data: string): UIEvent {
  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    return {
      type: "error",
      message: `unparseable relay frame: ${data.slice(0, 120)}`,
    };
  }
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    !EVENT_TYPES.has(value.type)
  ) {
    return {
      type: "error",
      message: `unrecognized relay event: ${data.slice(0, 120)}`,
    };
  }
  switch (value.type) {
    case "started":
      return {
        type: "started",
        runId: typeof value.runId === "string" ? value.runId : "",
      };
    case "delta":
      return {
        type: "delta",
        text: typeof value.text === "string" ? value.text : "",
      };
    case "log":
      return {
        type: "log",
        stream: value.stream === "stderr" ? "stderr" : "info",
        text: typeof value.text === "string" ? value.text : "",
      };
    case "done":
      return {
        type: "done",
        text: typeof value.text === "string" ? value.text : "",
        terminal: typeof value.terminal === "string" ? value.terminal : "",
        exitCode: typeof value.exitCode === "number" ? value.exitCode : 0,
      };
    default:
      return {
        type: "error",
        message:
          typeof value.message === "string" ? value.message : "relay error",
      };
  }
}

const TRANSCRIBE_TYPES = new Set(["started", "progress", "log", "done", "error"]);

// Parse one relay SSE `data:` payload into a transcribe event.
export function parseTranscribeEventPayload(data: string): TranscribeEvent {
  let value: unknown;
  try {
    value = JSON.parse(data) as unknown;
  } catch {
    return { type: "error", message: `unparseable relay frame: ${data.slice(0, 120)}` };
  }
  if (!isRecord(value) || typeof value.type !== "string" || !TRANSCRIBE_TYPES.has(value.type)) {
    return { type: "error", message: `unrecognized relay event: ${data.slice(0, 120)}` };
  }
  switch (value.type) {
    case "started":
      return { type: "started", jobId: typeof value.jobId === "string" ? value.jobId : "" };
    case "progress":
      return {
        type: "progress",
        stage: typeof value.stage === "string" ? value.stage : "",
        detail: typeof value.detail === "string" ? value.detail : "",
      };
    case "log":
      return {
        type: "log",
        stream: value.stream === "stderr" ? "stderr" : "info",
        text: typeof value.text === "string" ? value.text : "",
      };
    case "done":
      return { type: "done", result: value.result as TranscriptResult };
    default:
      return { type: "error", message: typeof value.message === "string" ? value.message : "relay error" };
  }
}
