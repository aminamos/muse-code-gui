/**
 * Normalizes raw `muse exec --json` stdout JSONL into the five UI events
 * defined in docs/EXEC-CONTRACT.md.
 *
 * Wire facts (from testdata/exec-stream.jsonl):
 * - every stdout line is JSON with `payload_type` + `payload`
 * - assistant text: `payload_type: "run.output.delta"`, `payload.text`
 * - run end: `payload_type: "run.terminal.*"` with `payload.terminal`
 *   and full `payload.text`
 * - lifecycle/linked events are progress metadata -> `log` (info)
 * - stderr lines starting with `muse: ` are diagnostics -> `log` (stderr)
 */

import type {
  ExecDoneEvent,
  ExecErrorEvent,
  ExecUIEvent,
} from './execTypes';

interface WireRecord {
  payload_type?: unknown;
  payload?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Stateful parser: feed stdout lines in order, concatenate deltas, emit
 * `done` when a `run.terminal.*` record arrives.
 */
export class ExecStreamParser {
  private deltas = 0;
  private text = '';

  get deltaCount(): number {
    return this.deltas;
  }

  get concatenatedText(): string {
    return this.text;
  }

  /** Parse one stdout JSONL line (1-based line number for error context). */
  feedLine(line: string, lineNumber: number): ExecUIEvent[] {
    if (line.trim() === '') {
      return [];
    }
    let record: WireRecord;
    try {
      record = JSON.parse(line) as WireRecord;
    } catch {
      const error: ExecErrorEvent = {
        type: 'error',
        message: `unparseable stdout line ${lineNumber}: ${line.slice(0, 120)}`,
      };
      return [error];
    }
    if (!isRecord(record)) {
      const error: ExecErrorEvent = {
        type: 'error',
        message: `unparseable stdout line ${lineNumber}: expected a JSON object`,
      };
      return [error];
    }

    const payloadType = asString(record.payload_type);
    const payload = isRecord(record.payload) ? record.payload : null;
    if (payloadType === null || payload === null) {
      const error: ExecErrorEvent = {
        type: 'error',
        message: `unparseable stdout line ${lineNumber}: missing payload_type/payload`,
      };
      return [error];
    }

    if (payloadType === 'run.output.delta') {
      const text = asString(payload.text) ?? '';
      this.deltas += 1;
      this.text += text;
      return [{ type: 'delta', text }];
    }

    if (payloadType.startsWith('run.terminal.')) {
      const terminal = asString(payload.terminal) ?? payloadType;
      const done: ExecDoneEvent = {
        type: 'done',
        text: this.text,
        terminal,
        exitCode: 0,
      };
      return [done];
    }

    const milestone = describeLifecycle(payloadType, payload);
    if (milestone !== null) {
      return [{ type: 'log', stream: 'info', text: milestone }];
    }
    return [];
  }

  /** Parse one stderr line into a `log` event, or null when not a diagnostic. */
  feedStderrLine(line: string): ExecUIEvent | null {
    if (line.startsWith('muse: ')) {
      return { type: 'log', stream: 'stderr', text: line };
    }
    return null;
  }
}

/**
 * Best-effort one-line summary of lifecycle/linked records
 * (`task_kind` + state transition). Returns null for records that carry
 * no user-meaningful milestone.
 */
function describeLifecycle(
  payloadType: string,
  payload: Record<string, unknown>,
): string | null {
  if (
    payloadType === 'task.stream.linked' ||
    payloadType === 'session.run.linked' ||
    payloadType === 'run.lifecycle.started' ||
    payloadType === 'turn.input.user' ||
    payloadType === 'runtime.command.accepted'
  ) {
    return `${payloadType}`;
  }
  if (payloadType.startsWith('task.lifecycle.')) {
    const event = isRecord(payload.event) ? payload.event : null;
    const kind = event !== null ? asString(event.kind) : null;
    const taskKind = asString(payload.task_kind) ?? asString(event?.task_kind);
    const detail = taskKind !== null ? ` ${taskKind}` : '';
    const reason =
      event !== null && typeof event.reason === 'string'
        ? `: ${event.reason}`
        : '';
    return `task ${kind ?? payloadType}${detail}${reason}`;
  }
  return null;
}
