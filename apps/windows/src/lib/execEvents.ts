// Five-event UI model from docs/EXEC-CONTRACT.md (frozen shared contract).
// The relay emits these as SSE `data: <json>` frames; the UI renders them.

export type ExecUiEvent =
  | { type: "started"; runId: string }
  | { type: "delta"; text: string }
  | { type: "log"; stream: "stderr" | "info"; text: string }
  | { type: "done"; text: string; terminal: string; exitCode: number }
  | { type: "error"; message: string };

export interface ExecWireRecord {
  payload_type?: unknown;
  payload?: Record<string, unknown> | null;
}

/** Map one `muse exec --json` JSONL line to UI events (best effort). */
export function wireLineToUiEvents(
  line: string,
  lineNumber: number,
): ExecUiEvent[] {
  let record: ExecWireRecord;
  try {
    record = JSON.parse(line) as ExecWireRecord;
  } catch {
    return [{ type: "error", message: `line ${lineNumber}: unparseable JSON` }];
  }
  if (
    typeof record !== "object" ||
    record === null ||
    typeof record.payload_type !== "string"
  ) {
    return [
      { type: "error", message: `line ${lineNumber}: missing payload_type` },
    ];
  }
  const payloadType = record.payload_type;
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  if (payloadType === "run.output.delta") {
    return [{ type: "delta", text: str(payload.text) }];
  }
  if (payloadType.startsWith("run.terminal.")) {
    return [
      {
        type: "done",
        text: str(payload.text),
        terminal: str(payload.terminal),
        exitCode: 0,
      },
    ];
  }
  if (
    payloadType === "run.lifecycle.started" ||
    payloadType === "session.run.linked" ||
    payloadType === "task.stream.linked" ||
    payloadType === "turn.input.user" ||
    payloadType === "runtime.command.accepted"
  ) {
    return [{ type: "log", stream: "info", text: lifecycleText(payloadType) }];
  }
  if (payloadType.startsWith("task.lifecycle.")) {
    const event = payload.event as Record<string, unknown> | undefined;
    const kind =
      typeof event?.kind === "string" ? (event.kind as string) : "update";
    const taskKind =
      typeof event?.task_kind === "string"
        ? `(${(event.task_kind as string).split(".").pop()})`
        : "";
    const reason =
      typeof event?.reason === "string" ? `: ${event.reason as string}` : "";
    return [
      {
        type: "log",
        stream: "info",
        text: `task ${kind}${taskKind ? ` ${taskKind}` : ""}${reason}`,
      },
    ];
  }
  return [
    {
      type: "log",
      stream: "info",
      text: lifecycleText(payloadType),
    },
  ];
}

function lifecycleText(payloadType: string): string {
  switch (payloadType) {
    case "run.lifecycle.started":
      return "run started";
    case "session.run.linked":
      return "run linked";
    case "task.stream.linked":
      return "task linked";
    case "turn.input.user":
      return "prompt accepted";
    case "runtime.command.accepted":
      return "command accepted";
    default:
      return payloadType;
  }
}

/** Map one stderr line to a UI log event. Diagnostics only, never text. */
export function stderrLineToUiEvent(line: string): ExecUiEvent | null {
  if (!line.startsWith("muse: ")) return null;
  return { type: "log", stream: "stderr", text: line };
}

/** Parse one relay SSE `data:` frame payload into a UI event. */
export function sseDataToUiEvent(data: string): ExecUiEvent | null {
  let obj: unknown;
  try {
    obj = JSON.parse(data);
  } catch {
    return { type: "error", message: `unparseable SSE frame: ${data}` };
  }
  if (typeof obj !== "object" || obj === null) return null;
  const event = obj as { type?: unknown } & Record<string, unknown>;
  switch (event.type) {
    case "started":
      return { type: "started", runId: String(event.runId ?? "") };
    case "delta":
      return { type: "delta", text: String(event.text ?? "") };
    case "log":
      return {
        type: "log",
        stream: event.stream === "stderr" ? "stderr" : "info",
        text: String(event.text ?? ""),
      };
    case "done":
      return {
        type: "done",
        text: String(event.text ?? ""),
        terminal: String(event.terminal ?? ""),
        exitCode:
          typeof event.exitCode === "number" ? (event.exitCode as number) : 0,
      };
    case "error":
      return { type: "error", message: String(event.message ?? "error") };
    default:
      return null;
  }
}

/** Concatenate delta text in order (contract: fixture total "echo: say hi"). */
export function concatDeltas(events: ExecUiEvent[]): string {
  let text = "";
  for (const event of events) {
    if (event.type === "delta") text += event.text;
  }
  return text;
}
