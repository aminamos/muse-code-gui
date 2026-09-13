// UI event model (docs/EXEC-CONTRACT.md) + transcribe event model + SSE encoding.

export type UiEvent =
  | { type: "started"; runId: string }
  | { type: "delta"; text: string }
  | { type: "log"; stream: "stderr" | "info"; text: string }
  | { type: "done"; text: string; terminal: string; exitCode: number }
  | { type: "error"; message: string };

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

export function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function sseResponse(
  events: AsyncIterable<unknown>,
  signal: AbortSignal,
): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const event of events) {
          if (signal.aborted) break;
          controller.enqueue(encoder.encode(sseFrame(event)));
        }
      } catch (err) {
        if (!signal.aborted) {
          controller.enqueue(
            encoder.encode(
              sseFrame({
                type: "error",
                message: err instanceof Error ? err.message : String(err),
              }),
            ),
          );
        }
      } finally {
        controller.close();
      }
    },
    cancel() {},
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
