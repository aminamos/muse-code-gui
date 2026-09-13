import type { UIEvent } from "./events";

// Normalizes `muse exec --json` stdout JSONL (see testdata/exec-stream.jsonl)
// into the five UI events. Used here as the documented mapping reference and
// mirrored by scripts/smoke.js; the Android app itself renders relay SSE
// frames, which already carry these five events.
export interface JsonlParseResult {
  events: UIEvent[];
  lines: number;
  deltas: number;
  logs: number;
  parseErrors: number;
  text: string;
  terminal: string | null;
  terminalText: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function lifecycleLog(payloadType: string, payload: unknown): string {
  const p = asRecord(payload);
  const event = asRecord(p.event);
  const kind =
    typeof event.task_kind === "string"
      ? event.task_kind
      : typeof p.task_id === "string"
        ? `task ${p.task_id.slice(0, 8)}`
        : "task";
  const transition =
    typeof event.kind === "string" ? event.kind : payloadType.split(".").pop();
  const reason = typeof event.reason === "string" ? ` (${event.reason})` : "";
  return `${kind}: ${transition}${reason}`;
}

export function parseExecJsonl(source: string): JsonlParseResult {
  const result: JsonlParseResult = {
    events: [],
    lines: 0,
    deltas: 0,
    logs: 0,
    parseErrors: 0,
    text: "",
    terminal: null,
    terminalText: null,
  };

  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const line = (lines[i] ?? "").trim();
    if (line.length === 0) {
      continue;
    }
    result.lines += 1;

    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      result.parseErrors += 1;
      result.events.push({
        type: "error",
        message: `unparseable JSON on line ${lineNumber}`,
      });
      continue;
    }
    if (!isRecord(value)) {
      result.parseErrors += 1;
      result.events.push({
        type: "error",
        message: `unparseable record on line ${lineNumber}`,
      });
      continue;
    }
    const payloadType =
      typeof value.payload_type === "string" ? value.payload_type : "";
    const payload = value.payload;
    if (payloadType.length === 0 || !isRecord(payload)) {
      result.parseErrors += 1;
      result.events.push({
        type: "error",
        message: `missing payload_type/payload on line ${lineNumber}`,
      });
      continue;
    }

    if (payloadType === "run.output.delta") {
      const text = typeof payload.text === "string" ? payload.text : "";
      result.text += text;
      result.deltas += 1;
      result.events.push({ type: "delta", text });
      continue;
    }

    if (payloadType.startsWith("run.terminal.")) {
      result.terminal =
        typeof payload.terminal === "string" ? payload.terminal : "";
      result.terminalText =
        typeof payload.text === "string" ? payload.text : "";
      result.events.push({
        type: "done",
        text: result.text,
        terminal: result.terminal,
        exitCode: 0,
      });
      continue;
    }

    if (
      payloadType.startsWith("task.lifecycle.") ||
      payloadType === "task.stream.linked" ||
      payloadType === "session.run.linked" ||
      payloadType === "run.lifecycle.started" ||
      payloadType === "turn.input.user" ||
      payloadType === "runtime.command.accepted"
    ) {
      let text: string;
      if (payloadType.startsWith("task.lifecycle.")) {
        text = lifecycleLog(payloadType, payload);
      } else if (
        payloadType === "turn.input.user" ||
        payloadType === "run.lifecycle.started"
      ) {
        const prompt =
          typeof payload.prompt === "string"
            ? ` prompt=${JSON.stringify(payload.prompt)}`
            : "";
        text = `${payloadType}${prompt}`;
      } else {
        text = payloadType;
      }
      result.logs += 1;
      result.events.push({ type: "log", stream: "info", text });
      continue;
    }

    // Unknown payload types are progress metadata at best; surface them as
    // best-effort info logs rather than user-visible text.
    result.logs += 1;
    result.events.push({
      type: "log",
      stream: "info",
      text: `unrecognized ${payloadType}`,
    });
  }

  return result;
}

// stderr lines starting with `muse: ` are diagnostics: log lines, never
// assistant text.
export function parseStderrLine(line: string): UIEvent | null {
  if (line.startsWith("muse: ")) {
    return { type: "log", stream: "stderr", text: line };
  }
  return null;
}
