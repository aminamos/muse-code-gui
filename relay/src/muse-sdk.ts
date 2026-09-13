// SDK-backed one-shot exec: same UiEvent contract as runMuseExec (muse.ts),
// but driving `muse serve` through @muse-code/sdk instead of `muse exec`.
//
// ERROR CONTRACT: THROWS on spawn/handshake/startSession failure (the
// caller's exec fallback depends on catching that); yields {type:"error"}
// only for turn-level failure (submit rejected, stream failure, unqueued or
// terminal-unknown turn, rejected turn wait).

import { MuseClient } from "@muse-code/sdk";
import type { SendUserTurnOptions, StartSessionOptions, Turn } from "@muse-code/sdk";
import type { ExecOptions } from "./muse.ts";
import type { UiEvent } from "./events.ts";

const CLIENT_NAME = "muse_code_gui_relay";
const CLIENT_VERSION = "0.1.0";

function errorText(prefix: string, err: unknown): string {
  return `${prefix}: ${err instanceof Error ? err.message : String(err)}`;
}

export async function* runSdkExec(
  museBin: string,
  opts: ExecOptions,
  signal: AbortSignal,
): AsyncGenerator<UiEvent> {
  // Exec-only options: fail fast so the caller falls back to the
  // subprocess rather than silently dropping them (the echo test
  // provider, yolo posture, step caps, and one-shot resume identity
  // have no SDK surface here).
  if (opts.provider === "echo") throw new Error("provider 'echo' is exec-only");
  if (opts.yolo) throw new Error("yolo is exec-only");
  if (opts.maxModelSteps !== undefined) throw new Error("maxModelSteps is exec-only");
  if (opts.sessionId) throw new Error("one-shot sessionId resume is exec-only");
  const runId = crypto.randomUUID();
  yield { type: "started", runId };

  // Race helper: the SDK never locally settles a turn (INV-006) and an
  // orderly close() discharges nothing, so every await must also lose to
  // the AbortSignal or an abort would hang the generator mid-turn.
  const aborted = new Error("aborted");
  const withAbort = <T>(promise: Promise<T>): Promise<T> => {
    if (signal.aborted) return Promise.reject(aborted);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(aborted);
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  };

  const stderrPending: string[] = [];
  let stderrRemainder = "";
  const drainStderr = function* (): Generator<UiEvent> {
    while (stderrPending.length > 0) {
      yield { type: "log", stream: "stderr", text: stderrPending.shift()! };
    }
  };

  // Spawn + SS1.4 handshake. Rejection here THROWS (setup failure).
  const client = await MuseClient.spawn({
    museBin,
    args: ["serve"],
    clientInfo: { name: CLIENT_NAME, version: CLIENT_VERSION },
    onStderr: (chunk: string) => {
      stderrRemainder += chunk;
      let idx: number;
      while ((idx = stderrRemainder.indexOf("\n")) !== -1) {
        const line = stderrRemainder.slice(0, idx).replace(/\r$/, "");
        stderrRemainder = stderrRemainder.slice(idx + 1);
        if (line !== "") stderrPending.push(line);
      }
    },
  });

  let closed = false;
  const closeQuietly = (): Promise<void> => {
    if (closed) return Promise.resolve();
    closed = true;
    return client.close().then(
      () => {},
      () => {},
    );
  };
  const onAbortClose = () => {
    void closeQuietly();
  };
  signal.addEventListener("abort", onAbortClose, { once: true });

  try {
    // session/start. Rejection here THROWS (setup failure, not turn-level).
    // Unmapped: opts.sessionId (exec resume identity != start identity for a
    // NEW session), opts.yolo, opts.maxModelSteps (no SDK surface).
    const session = await withAbort(
      client.startSession({
        ...(opts.workspace ? { workspaceRoot: opts.workspace } : {}),
        ...(opts.model ? { modelId: opts.model } : {}),
        ...(opts.provider ? { providerId: opts.provider } : {}),
        ...(opts.approvalMode
          ? { approvalMode: opts.approvalMode as StartSessionOptions["approvalMode"] }
          : {}),
      } satisfies StartSessionOptions),
    ).catch((err: unknown) => {
      if (err === aborted || signal.aborted) return null;
      throw err;
    });
    if (session === null) return;
    yield* drainStderr();
    yield { type: "log", stream: "info", text: `session started (${session.sessionId})` };

    // Approvals: auto-pick the first server-offered choice (exec parity with
    // --user-input-auto-resolve) and note each decision as a log line.
    const approvalLogs: string[] = [];
    const drainApprovals = function* (): Generator<UiEvent> {
      while (approvalLogs.length > 0) {
        yield { type: "log", stream: "info", text: approvalLogs.shift()! };
      }
    };
    session.onApproval((request) => {
      const first = request.availableChoices[0];
      if (!first) {
        approvalLogs.push(
          `approval ${request.approvalId} (${request.toolName}): no choices offered; leaving undecided`,
        );
        return { choiceId: "" };
      }
      approvalLogs.push(
        `approval auto-resolved: ${request.toolName} -> ${first.label} (${first.choiceId})`,
      );
      return { choiceId: first.choiceId };
    });
    session.onApprovalError((failure) => {
      approvalLogs.push(`approval round trip failed (${failure.kind}): ${failure.approvalId}`);
    });

    let turn: Turn;
    try {
      turn = await withAbort(
        session.sendUserTurn({
          input: [{ type: "text", text: opts.prompt }],
          ...(opts.reasoningEffort
            ? {
              reasoningEffort: opts.reasoningEffort as NonNullable<
                SendUserTurnOptions<unknown>["reasoningEffort"]
              >,
            }
            : {}),
        }),
      );
    } catch (err) {
      if (err === aborted || signal.aborted) return;
      yield* drainStderr();
      yield* drainApprovals();
      yield { type: "error", message: errorText("turn submit failed", err) };
      return;
    }
    yield { type: "log", stream: "info", text: `turn started (${turn.turnId})` };

    // Live tail: text-field deltas on agentMessage items only. Other fields
    // (reasoning summary parts, toolCall/userShell output) and other kinds
    // are skipped; the reconcile pass below recovers agentMessage text.
    let text = "";
    const streamedByItem = new Map<string, string>();
    const deltas = turn.deltas();
    try {
      for (;;) {
        let result: IteratorResult<unknown, unknown>;
        try {
          result = await withAbort(deltas.next());
        } catch (err) {
          if (err === aborted || signal.aborted) {
            await deltas.return?.(undefined);
            return;
          }
          throw err;
        }
        if (result.done) break;
        const d = result.value as { itemId: string; field?: string; delta: string };
        if (d.field !== undefined && d.field !== "text") continue;
        const item = session.fold.items.get(d.itemId);
        if (!item || item.kind !== "agentMessage") continue;
        text += d.delta;
        yield { type: "delta", text: d.delta };
        streamedByItem.set(d.itemId, (streamedByItem.get(d.itemId) ?? "") + d.delta);
      }
    } catch (err) {
      if (err === aborted || signal.aborted) return;
      yield* drainStderr();
      yield* drainApprovals();
      yield { type: "error", message: errorText("turn stream failed", err) };
      return;
    }

    // Reconcile: replay settled items (ends immediately post-settle) and emit
    // any agentMessage text the live tail missed.
    if (!signal.aborted) {
      try {
        for await (const item of turn.items()) {
          if (item.kind !== "agentMessage") continue;
          const full = item.text ?? "";
          const streamed = streamedByItem.get(item.itemId) ?? "";
          if (full.length > streamed.length && full.startsWith(streamed)) {
            const rest = full.slice(streamed.length);
            text += rest;
            yield { type: "delta", text: rest };
          } else if (streamed === "" && full !== "") {
            text += full;
            yield { type: "delta", text: full };
          }
        }
      } catch (err) {
        if (err === aborted || signal.aborted) return;
        yield* drainStderr();
        yield* drainApprovals();
        yield { type: "error", message: errorText("turn replay failed", err) };
        return;
      }
    }

    yield* drainStderr();
    yield* drainApprovals();

    let outcome: Awaited<typeof turn.completed>;
    try {
      outcome = await withAbort(turn.completed);
    } catch (err) {
      if (err === aborted || signal.aborted) return;
      yield { type: "error", message: errorText("turn failed", err) };
      return;
    }
    if (signal.aborted) return;

    if (outcome.kind === "completed") {
      const terminal: string = outcome.params.terminal;
      if (terminal !== "completed") {
        const detail = outcome.params.error?.message ?? outcome.params.reason ?? "";
        yield {
          type: "log",
          stream: "info",
          text: `turn ${terminal}${detail !== "" ? `: ${detail}` : ""}`,
        };
      } else {
        yield { type: "log", stream: "info", text: "turn completed" };
      }
      yield { type: "done", text, terminal, exitCode: terminal === "completed" ? 0 : 1 };
    } else if (outcome.kind === "unqueued") {
      yield { type: "error", message: "turn unqueued before launch" };
    } else {
      yield { type: "error", message: "host died; turn terminal unknown" };
    }
  } finally {
    signal.removeEventListener("abort", onAbortClose);
    await closeQuietly();
  }
}
