// Five UI events from docs/EXEC-CONTRACT.md. Every platform renders these;
// transport differs (localhost vs remote relay), rendering does not.

export type UIEvent =
  | { type: "started"; runId: string }
  | { type: "delta"; text: string }
  | { type: "log"; stream: "stderr" | "info"; text: string }
  | { type: "done"; text: string; terminal: string; exitCode: number }
  | { type: "error"; message: string };

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

export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const m = Math.floor(s / 60);
  const sec = (s - m * 60).toFixed(3).padStart(6, "0");
  return `${String(m).padStart(2, "0")}:${sec}`;
}
