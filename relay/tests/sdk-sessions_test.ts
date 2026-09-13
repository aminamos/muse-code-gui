// Live SDK session-manager test: spends subscription tokens, keep tiny.
import { assert, assertRejects, assertStringIncludes } from "@std/assert";
import { SdkSessionManager } from "../src/sessions.ts";
import type { UiEvent } from "../src/events.ts";

const MUSE_BIN = Deno.env.get("MUSE_BIN") ?? "muse";

async function collect(
  gen: AsyncGenerator<UiEvent>,
): Promise<{ events: UiEvent[]; text: string; terminal: string }> {
  const events: UiEvent[] = [];
  let text = "";
  let terminal = "";
  for await (const e of gen) {
    events.push(e);
    if (e.type === "delta") text += e.text;
    if (e.type === "done") {
      text = e.text !== "" ? e.text : text;
      terminal = e.terminal;
    }
    if (e.type === "error") throw new Error(`stream error: ${e.message}`);
  }
  return { events, text, terminal };
}

Deno.test({
  name: "sdk sessions: two turns on one session keep continuity",
  sanitizeOps: false,
  sanitizeResources: false,
  timeout: 180_000,
  fn: async () => {
    const mgr = new SdkSessionManager({ museBin: MUSE_BIN });
    try {
      const { sessionId } = await mgr.start({});
      assert(sessionId.length > 0, "expected a sessionId");

      const c = new AbortController();
      const t1 = await collect(
        mgr.send({ sessionId, prompt: "Remember this word: quokka. Reply with exactly: ok", signal: c.signal }),
      );
      assert(t1.events[0]?.type === "started", "turn 1 must start with started");
      assert(t1.events.at(-1)?.type === "done", "turn 1 must end with done");
      assert(t1.terminal === "completed", `turn 1 terminal=${t1.terminal}`);

      const t2 = await collect(
        mgr.send({ sessionId, prompt: "What word did I ask you to remember? Reply with just that word.", signal: c.signal }),
      );
      assert(t2.events[0]?.type === "started", "turn 2 must start with started");
      assert(t2.events.at(-1)?.type === "done", "turn 2 must end with done");
      assert(t2.terminal === "completed", `turn 2 terminal=${t2.terminal}`);
      assertStringIncludes(
        t2.text.toLowerCase(),
        "quokka",
        `turn 2 should recall turn 1 (got: ${JSON.stringify(t2.text)})`,
      );

      mgr.close({ sessionId });
    } finally {
      await mgr.closeAll();
    }
  },
});

Deno.test({
  name: "sdk sessions: unknown sessionId throws on send/close",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const mgr = new SdkSessionManager({ museBin: MUSE_BIN });
    try {
      const c = new AbortController();
      await assertRejects(
        async () => {
          const gen = mgr.send({ sessionId: "nope", prompt: "hi", signal: c.signal });
          await gen.next();
        },
        Error,
        "unknown session",
      );
      let threw = false;
      try {
        mgr.close({ sessionId: "nope" });
      } catch {
        threw = true;
      }
      assert(threw, "close on unknown session must throw");
    } finally {
      await mgr.closeAll();
    }
  },
});
