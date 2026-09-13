// Stateful SDK session manager: multi-turn continuity over one shared
// `muse serve` host (MSP). Lazily spawns a single MuseClient; each start()
// opens a server session whose handle is kept in an in-memory registry so
// later send() calls on the same sessionId continue the conversation.
//
// DUPLICATION NOTE (for the lead to merge): the turn-item → UiEvent mapping
// below (agentMessage text → delta, other items/fields → info logs, turn
// outcome → done) intentionally duplicates the one-shot mapping in the
// sibling muse-sdk.ts module, which was written concurrently and must not be
// imported here. Unify both behind one shared mapper.

import { MuseClient } from "@muse-code/sdk";
import type { FoldedItem, Session, Turn, TurnOutcome } from "@muse-code/sdk";
import type { UiEvent } from "./events.ts";

export interface SdkSessionStartArgs {
  workspaceRoot?: string;
}

export interface SdkSessionSendArgs {
  sessionId: string;
  prompt: string;
  signal: AbortSignal;
}

function describeOutcomeTerminal(outcome: TurnOutcome): string {
  if (outcome.kind === "completed") return outcome.params.terminal;
  return outcome.kind;
}

// DUPLICATED with muse-sdk.ts (see header): keep in sync until merged.
function itemOpenLog(item: FoldedItem): string {
  const base = `item ${item.kind} ${item.status}`;
  if (item.kind === "toolCall" && item.tool) return `${base} (${item.tool})`;
  if (item.kind === "subagent" && item.role) return `${base} (${item.role})`;
  return base;
}

// DUPLICATED with muse-sdk.ts (see header): keep in sync until merged.
function itemCloseLog(item: FoldedItem): string {
  const base = `item ${item.kind} → ${item.status}`;
  if (item.failureReason) return `${base}: ${item.failureReason}`;
  if (item.kind === "toolCall" && item.tool) return `${base} (${item.tool})`;
  return base;
}

export class SdkSessionManager {
  readonly #museBin: string;
  readonly #clientName: string;
  readonly #clientVersion: string;
  #client: MuseClient | null = null;
  #clientPromise: Promise<MuseClient> | null = null;
  readonly #sessions = new Map<string, Session>();

  constructor(
    opts: { museBin: string; clientName?: string; clientVersion?: string },
  ) {
    this.#museBin = opts.museBin;
    // SS1.4.1: clientInfo.name must match ^[a-z0-9_]+$.
    this.#clientName = opts.clientName ?? "muse_code_ui_relay";
    this.#clientVersion = opts.clientVersion ?? "0.1.0";
  }

  async #ensureClient(): Promise<MuseClient> {
    if (this.#client) return this.#client;
    if (!this.#clientPromise) {
      this.#clientPromise = MuseClient.spawn({
        museBin: this.#museBin,
        args: ["serve"],
        clientInfo: { name: this.#clientName, version: this.#clientVersion },
      }).then((client) => {
        this.#client = client;
        return client;
      }).catch((err) => {
        this.#clientPromise = null;
        throw err;
      });
    }
    return this.#clientPromise;
  }

  /** Open a new server session and register it. Returns its sessionId. */
  async start(args: SdkSessionStartArgs = {}): Promise<{ sessionId: string }> {
    const client = await this.#ensureClient();
    const session = await client.startSession(
      args.workspaceRoot ? { workspaceRoot: args.workspaceRoot } : {},
    );
    session.onApprovalError((failure) => {
      console.error(
        `muse-sdk: approval ${failure.kind} approvalId=${failure.approvalId}`,
      );
    });
    this.#sessions.set(session.sessionId, session);
    return { sessionId: session.sessionId };
  }

  #require(sessionId: string): Session {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    return session;
  }

  /**
   * Send one user turn on a registered session and stream UiEvents.
   * Emits started{runId} first and done{...} last, mirroring runMuseExec.
   */
  async *send(args: SdkSessionSendArgs): AsyncGenerator<UiEvent> {
    const session = this.#require(args.sessionId);
    const { prompt, signal } = args;
    const runId = crypto.randomUUID();
    yield { type: "started", runId };
    if (signal.aborted) return;

    const queue: UiEvent[] = [];
    let notify: (() => void) | null = null;
    const wake = () => notify?.();
    const push = (e: UiEvent) => {
      queue.push(e);
      wake();
    };

    // Approvals: auto-pick the first server-offered choice + a log line.
    // Registered per send (onApproval replaces); the queue is send-local.
    session.onApproval((request) => {
      const choice = request.availableChoices[0];
      push({
        type: "log",
        stream: "info",
        text: `approval auto-decided: ${request.toolName} → ${choice.label}`,
      });
      return { choiceId: choice.choiceId };
    });

    let turn: Turn;
    try {
      turn = await session.sendUserTurn({
        input: [{ type: "text", text: prompt }],
      });
    } catch (err) {
      if (!signal.aborted) {
        yield {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
      return;
    }
    push({ type: "log", stream: "info", text: "prompt accepted" });

    // Per-item streamed-text bookkeeping shared by the delta and item pumps
    // so late-attached deltas() iterators (live-only) are reconciled from
    // item state without double-emitting.
    const emittedText = new Map<string, number>();
    let deltas = "";
    const emitText = (itemId: string, text: string) => {
      const seen = emittedText.get(itemId) ?? 0;
      if (text.length > seen) {
        const piece = text.slice(seen);
        emittedText.set(itemId, text.length);
        deltas += piece;
        push({ type: "delta", text: piece });
      }
    };

    let itemsDone = false;
    let deltasDone = false;
    const itemsSeen = new Map<string, string>(); // itemId -> last status

    const itemsTask = (async () => {
      try {
        for await (const item of turn.items()) {
          if (signal.aborted) break;
          // DUPLICATED mapping with muse-sdk.ts (see header).
          if (item.kind === "agentMessage" && typeof item.text === "string") {
            emitText(item.itemId, item.text);
          } else {
            const prev = itemsSeen.get(item.itemId);
            const status = String(item.status);
            if (prev === undefined) {
              push({ type: "log", stream: "info", text: itemOpenLog(item) });
            } else if (prev !== status) {
              push({ type: "log", stream: "info", text: itemCloseLog(item) });
            }
            itemsSeen.set(item.itemId, status);
          }
        }
      } catch (err) {
        if (!signal.aborted) {
          push({
            type: "error",
            message: `item stream failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } finally {
        itemsDone = true;
        wake();
      }
    })();

    const deltasTask = (async () => {
      try {
        for await (const d of turn.deltas()) {
          if (signal.aborted) break;
          // DUPLICATED mapping with muse-sdk.ts (see header).
          const field = d.field ?? "text";
          if (field === "text") {
            const seen = emittedText.get(d.itemId) ?? 0;
            emittedText.set(d.itemId, seen + d.delta.length);
            deltas += d.delta;
            push({ type: "delta", text: d.delta });
          } else {
            push({ type: "log", stream: "info", text: `${field}: ${d.delta}` });
          }
        }
      } catch (err) {
        if (!signal.aborted) {
          push({
            type: "error",
            message: `delta stream failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      } finally {
        deltasDone = true;
        wake();
      }
    })();

    const completedTask = turn.completed.then(
      (outcome): TurnOutcome | null => outcome,
      (err): null => {
        if (!signal.aborted) {
          push({
            type: "error",
            message: `turn failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
        return null;
      },
    ).finally(() => wake());

    const box: { outcome: TurnOutcome | null } = { outcome: null };
    let outcomeSettled = false;
    void completedTask.then((o) => {
      box.outcome = o;
      outcomeSettled = true;
      wake();
    });

    for (;;) {
      while (queue.length > 0) {
        const e = queue.shift()!;
        if (e.type !== "done") yield e;
        if (signal.aborted) break;
      }
      if (signal.aborted) break;
      if (outcomeSettled && itemsDone && deltasDone && queue.length === 0) {
        break;
      }
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      notify = null;
    }

    await Promise.all([itemsTask, deltasTask]);
    if (signal.aborted) return;
    while (queue.length > 0) yield queue.shift()!;

    // DUPLICATED terminal mapping with muse-sdk.ts (see header).
    const outcome = box.outcome;
    if (outcome === null) {
      yield { type: "error", message: "turn ended without an outcome" };
      return;
    }
    const terminal = describeOutcomeTerminal(outcome);
    if (outcome.kind === "completed" && outcome.params.error) {
      yield {
        type: "log",
        stream: "stderr",
        text: `${outcome.params.error.kind}: ${outcome.params.error.message}`,
      };
    }
    yield {
      type: "done",
      text: deltas,
      terminal,
      exitCode: terminal === "completed" ? 0 : 1,
    };
  }

  /** Drop a registered session handle. Unknown sessionId throws. */
  close(args: { sessionId: string }): void {
    if (!this.#sessions.has(args.sessionId)) {
      throw new Error(`unknown session: ${args.sessionId}`);
    }
    this.#sessions.delete(args.sessionId);
  }

  /** Drop all sessions and shut down the shared host. Idempotent. */
  async closeAll(): Promise<void> {
    this.#sessions.clear();
    const client = this.#client;
    this.#client = null;
    this.#clientPromise = null;
    if (client) await client.close();
  }
}
