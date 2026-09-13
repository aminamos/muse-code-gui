import { assert, assertEquals } from "@std/assert";
import { runSdkExec } from "../src/muse-sdk.ts";
import type { UiEvent } from "../src/events.ts";

const MUSE_BIN = Deno.env.get("MUSE_BIN") ?? "muse";

Deno.test({
  name: "sdk-exec: live one-shot turn yields started then done with text",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000);
    try {
      const events: UiEvent[] = [];
      for await (const e of runSdkExec(MUSE_BIN, { prompt: "say hi" }, controller.signal)) {
        events.push(e);
      }
      assert(events.length >= 2, `expected >=2 events, got ${events.length}`);
      assertEquals(events[0].type, "started");
      const last = events[events.length - 1];
      assert(last.type === "done", `expected final done, got ${JSON.stringify(last)}`);
      assert(last.text.trim().length > 0, "expected non-empty done.text");
      assertEquals(last.terminal, "completed");
      assertEquals(last.exitCode, 0);
      for (const e of events) {
        assert(e.type !== "error", `unexpected error event: ${JSON.stringify(e)}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  },
});
