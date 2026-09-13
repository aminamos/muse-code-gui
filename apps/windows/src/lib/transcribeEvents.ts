// Transcribe event model for POST /api/transcribe (docs/TRANSCRIBE.md).
// Same SSE `data: <json>` framing as the exec stream.

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Parse one relay SSE `data:` frame payload into a transcribe event. */
export function sseDataToTranscribeEvent(data: string): TranscribeEvent | null {
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    return { type: "error", message: `unparseable SSE frame: ${data}` };
  }
  if (!isRecord(obj)) return null;
  switch (obj.type) {
    case "started":
      return { type: "started", jobId: String(obj.jobId ?? "") };
    case "progress":
      return {
        type: "progress",
        stage: String(obj.stage ?? ""),
        detail: String(obj.detail ?? ""),
      };
    case "log":
      return {
        type: "log",
        stream: obj.stream === "stderr" ? "stderr" : "info",
        text: String(obj.text ?? ""),
      };
    case "done":
      return { type: "done", result: obj.result as TranscriptResult };
    case "error":
      return { type: "error", message: String(obj.message ?? "error") };
    default:
      return null;
  }
}

export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const m = Math.floor(s / 60);
  const sec = (s - m * 60).toFixed(3).padStart(6, "0");
  return `${String(m).padStart(2, "0")}:${sec}`;
}
