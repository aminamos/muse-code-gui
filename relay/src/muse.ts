// Spawns `muse exec --json` and normalizes stdout JSONL + stderr into the
// five UI events. Inherits the relay host's muse login (subscription tokens);
// never passes an API key.

import type { UiEvent } from "./events.ts";

export interface ExecOptions {
  prompt: string;
  workspace?: string;
  model?: string;
  reasoningEffort?: string;
  approvalMode?: string;
  sessionId?: string;
  provider?: string;
  yolo?: boolean;
  maxModelSteps?: number;
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

export function wireLineToUiEvents(line: string, lineNumber: number): UiEvent[] {
  let record: {
    payload_type?: unknown;
    payload?: Record<string, unknown> | null;
  };
  try {
    record = JSON.parse(line);
  } catch {
    return [{ type: "error", message: `line ${lineNumber}: unparseable JSON` }];
  }
  if (typeof record !== "object" || record === null) {
    return [{ type: "error", message: `line ${lineNumber}: not an object` }];
  }
  if (typeof record.payload_type !== "string") {
    return [{ type: "error", message: `line ${lineNumber}: missing payload_type` }];
  }
  const payloadType = record.payload_type;
  const payload = (record.payload ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");

  if (payloadType === "run.output.delta") {
    return [{ type: "delta", text: str(payload.text) }];
  }
  if (payloadType.startsWith("run.terminal.")) {
    return [{
      type: "done",
      text: str(payload.text),
      terminal: str(payload.terminal) || payloadType.slice("run.terminal.".length),
      exitCode: 0,
    }];
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
    const kind = typeof event?.kind === "string" ? event.kind : "update";
    const taskKind = typeof event?.task_kind === "string"
      ? ` (${event.task_kind.split(".").pop()})`
      : "";
    const reason = typeof event?.reason === "string" ? `: ${event.reason}` : "";
    return [{ type: "log", stream: "info", text: `task ${kind}${taskKind}${reason}` }];
  }
  return [{ type: "log", stream: "info", text: lifecycleText(payloadType) }];
}

export function stderrLineToUiEvent(line: string): UiEvent | null {
  if (!line.startsWith("muse: ")) return null;
  return { type: "log", stream: "stderr", text: line };
}

export function buildExecArgs(opts: ExecOptions): string[] {
  const args = ["exec", "--json", "--user-input-auto-resolve"];
  if (opts.provider) args.push("--provider", opts.provider);
  if (opts.model) args.push("--model", opts.model);
  if (opts.reasoningEffort) args.push("--reasoning-effort", opts.reasoningEffort);
  if (opts.workspace) args.push("--workspace", opts.workspace);
  if (opts.sessionId) args.push("--session-id", opts.sessionId);
  if (opts.approvalMode) args.push("--approval-mode", opts.approvalMode);
  if (opts.maxModelSteps) args.push("--max-model-steps", String(opts.maxModelSteps));
  if (opts.yolo) args.push("--yolo");
  args.push(opts.prompt);
  return args;
}

export async function getMuseVersion(museBin: string): Promise<string | null> {
  try {
    const cmd = new Deno.Command(museBin, {
      args: ["--version"],
      stdout: "piped",
      stderr: "null",
    });
    const out = await cmd.output();
    if (!out.success) return null;
    return new TextDecoder().decode(out.stdout).trim().split("\n")[0] ?? null;
  } catch {
    return null;
  }
}

async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        yield buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer !== "") yield buffer.replace(/\r$/, "");
  } finally {
    reader.releaseLock();
  }
}

export async function* runMuseExec(
  museBin: string,
  opts: ExecOptions,
  signal: AbortSignal,
): AsyncGenerator<UiEvent> {
  const runId = crypto.randomUUID();
  yield { type: "started", runId };
  const child = new Deno.Command(museBin, {
    args: buildExecArgs(opts),
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).spawn();

  const queue: UiEvent[] = [];
  let stdoutDone = false;
  let stderrDone = false;
  let notify: (() => void) | null = null;
  const wake = () => notify?.();
  const push = (e: UiEvent) => {
    queue.push(e);
    wake();
  };
  const onAbort = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const outTask = (async () => {
    let n = 0;
    try {
      for await (const line of linesOf(child.stdout)) {
        n++;
        if (line.trim() === "") continue;
        for (const e of wireLineToUiEvents(line, n)) push(e);
      }
    } catch (err) {
      if (!signal.aborted) {
        push({
          type: "error",
          message: `stdout read failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    } finally {
      stdoutDone = true;
      wake();
    }
  })();
  const errTask = (async () => {
    try {
      for await (const line of linesOf(child.stderr)) {
        const e = stderrLineToUiEvent(line);
        if (e) push(e);
      }
    } catch {
      // stderr is diagnostics-only; ignore read failures
    } finally {
      stderrDone = true;
      wake();
    }
  })();

  let deltas = "";
  let terminal: { text: string; terminal: string } | null = null;
  for (;;) {
    while (queue.length > 0) {
      const e = queue.shift()!;
      if (e.type === "delta") {
        deltas += e.text;
        yield e;
      } else if (e.type === "done") {
        terminal = { text: e.text, terminal: e.terminal };
      } else {
        yield e;
      }
      if (signal.aborted) break;
    }
    if (signal.aborted) break;
    if (stdoutDone && stderrDone && queue.length === 0) break;
    await new Promise<void>((resolve) => {
      notify = resolve;
    });
    notify = null;
  }
  signal.removeEventListener("abort", onAbort);
  await Promise.all([outTask, errTask]);
  const status = await child.status;
  if (signal.aborted) return;
  if (terminal) {
    yield {
      type: "done",
      text: deltas !== "" ? deltas : terminal.text,
      terminal: terminal.terminal,
      exitCode: status.code,
    };
  } else if (status.success) {
    yield { type: "done", text: deltas, terminal: "completed", exitCode: 0 };
  } else {
    yield { type: "error", message: `muse exec exited ${status.code} without a terminal event` };
  }
}
