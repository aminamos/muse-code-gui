// Local normalizer for `muse exec --json` stdout JSONL, mirroring the relay's
// mapping in docs/EXEC-CONTRACT.md. Used for offline replay/dev; the live
// path consumes relay SSE frames via execClient.ts.
import type { UiEvent } from "./execClient";

export interface ParseStats {
  lines: number;
  deltas: number;
  terminals: number;
  errors: number;
}

export function parseExecJsonl(
  input: string,
  onEvent: (event: UiEvent) => void,
): ParseStats {
  const stats: ParseStats = { lines: 0, deltas: 0, terminals: 0, errors: 0 };
  let text = "";
  for (const [i, raw] of input.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    stats.lines += 1;
    let record: { payload_type?: unknown; payload?: Record<string, unknown> };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      stats.errors += 1;
      onEvent({ type: "error", message: `unparseable line ${i + 1}` });
      continue;
    }
    const payloadType = record.payload_type;
    const payload = record.payload ?? {};
    if (payloadType === "run.output.delta") {
      const chunk = typeof payload.text === "string" ? payload.text : "";
      stats.deltas += 1;
      text += chunk;
      onEvent({ type: "delta", text: chunk });
    } else if (
      typeof payloadType === "string" &&
      payloadType.startsWith("run.terminal.")
    ) {
      stats.terminals += 1;
      const terminal =
        typeof payload.text === "string" || typeof payload.terminal === "string"
          ? String(payload.terminal ?? payloadType.slice("run.terminal.".length))
          : payloadType.slice("run.terminal.".length);
      onEvent({ type: "done", text, terminal, exitCode: 0 });
    } else if (typeof payloadType === "string") {
      const milestone = describeLifecycle(payloadType, payload);
      if (milestone) onEvent({ type: "log", stream: "info", text: milestone });
    }
  }
  return stats;
}

function describeLifecycle(
  payloadType: string,
  payload: Record<string, unknown>,
): string | null {
  if (
    payloadType.startsWith("task.lifecycle.") ||
    payloadType === "task.stream.linked" ||
    payloadType === "session.run.linked" ||
    payloadType === "run.lifecycle.started" ||
    payloadType === "turn.input.user" ||
    payloadType === "runtime.command.accepted"
  ) {
    const event = payload.event as { kind?: unknown } | undefined;
    const kind =
      typeof event?.kind === "string"
        ? event.kind
        : payloadType.split(".").pop() ?? payloadType;
    const taskKind =
      typeof (payload.event as { task_kind?: unknown } | undefined)
        ?.task_kind === "string"
        ? ` (${String((payload.event as { task_kind: string }).task_kind)})`
        : "";
    return `${payloadType}: ${kind}${taskKind}`;
  }
  return null;
}
