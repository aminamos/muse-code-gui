// MSP conformance: cross-check relay exec mapping vs official MSP wire schema.
//
// Source of truth: `muse schema generate-json-schema --out DIR` (offline,
// instant, embedded in the binary; stable surface). The test shells out to the
// muse CLI, reads msp.schema.json, and takes the declared wire vocabulary as
// keys(methods) ∪ keys(notifications) ∪ keys(requests).
//
// Fallback NOT taken: the task's fallback was the @muse-code/msp npm package,
// but it does not exist on the npm registry (`npm view @muse-code/msp version`
// → 404, checked 2026-09-13), and `muse schema` already yields machine-usable
// JSON, so no npm: import is used and deno.json is untouched.
//
// Zero token spend: this test runs only `muse schema ...` (offline export)
// and replays the recorded fixture. It never runs `muse exec`.
//
// Permissions: --allow-run (muse CLI) --allow-read (schema bundle + fixture)
// --allow-env (MUSE_BIN/TMPDIR). No --allow-write needed: the export dir is
// created by the muse child process itself, Deno only reads it back.

import { assert, assertEquals } from "@std/assert";
import { wireLineToUiEvents } from "../src/muse.ts";

const FIXTURE = new URL("../../testdata/exec-stream.jsonl", import.meta.url);

// Documented gap: every payload_type in testdata/exec-stream.jsonl that is NOT
// a declared MSP schema method/notification/request name.
//
// Root cause: namespace mismatch, not a relay bug. The MSP schema declares the
// JSON-RPC command plane (`session/start`, `item/delta`, `turn/completed`,
// ... slash-form names). `muse exec --json` instead emits trace-record
// envelopes whose `payload_type` uses the dotted record vocabulary
// (`run.output.delta`, `task.lifecycle.*`, `run.terminal.completed`, ...).
// Neither the JSON-Schema nor the TS export of `muse schema` (muse 1.2.1,
// stable surface) contains any dotted payload_type, so the gap is total: all
// 14 distinct fixture types resolve here instead of to the schema.
//
// Maintenance rule enforced below: this list must equal exactly the set of
// fixture payload_types absent from the schema. If a future `muse schema`
// export declares any of these names, the test fails until the entry is
// removed from this list (a good failure: it means coverage improved).
const DOCUMENTED_GAPS: readonly string[] = [
  "run.lifecycle.started",
  "run.output.delta",
  "run.terminal.completed",
  "runtime.command.accepted",
  "session.run.linked",
  "task.lifecycle.accepted",
  "task.lifecycle.completed",
  "task.lifecycle.failed",
  "task.lifecycle.proposed",
  "task.lifecycle.scheduled",
  "task.lifecycle.side_effect_intent",
  "task.lifecycle.started",
  "task.stream.linked",
  "turn.input.user",
];

async function exportDeclaredWireNames(): Promise<Set<string>> {
  const museBin = Deno.env.get("MUSE_BIN") ?? "muse";
  const tmpBase = Deno.env.get("TMPDIR") ?? "/tmp";
  // Created by the muse child process (--out dirs are created if absent),
  // so Deno needs no --allow-write; it only reads the bundle back.
  const outDir =
    `${tmpBase}/msp-schema-conformance-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const cmd = new Deno.Command(museBin, {
    args: ["schema", "generate-json-schema", "--out", outDir],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  const stdout = new TextDecoder().decode(out.stdout);
  const stderr = new TextDecoder().decode(out.stderr);
  assert(out.success, `muse schema export failed: ${stdout}${stderr}`);
  try {
    const bundle = JSON.parse(
      await Deno.readTextFile(`${outDir}/msp.schema.json`),
    ) as {
      methods?: Record<string, unknown>;
      notifications?: Record<string, unknown>;
      requests?: Record<string, unknown>;
    };
    const names = new Set<string>();
    for (const section of [bundle.methods, bundle.notifications, bundle.requests]) {
      if (section) for (const name of Object.keys(section)) names.add(name);
    }
    assert(names.size > 0, "schema bundle declared zero wire names");
    return names;
  } finally {
    // Best-effort cleanup; fails closed without --allow-write, which is fine
    // (a small stale dir under TMPDIR, no background process).
    try {
      await Deno.remove(outDir, { recursive: true });
    } catch {
      // no write permission or already gone: leave the inert export dir
    }
  }
}

Deno.test("msp conformance: fixture payload_types vs official schema + mapping", async () => {
  // (1) Official schema export → declared wire names.
  const declared = await exportDeclaredWireNames();

  // (2) Fixture coverage: each distinct payload_type must be declared in the
  // schema or recorded in DOCUMENTED_GAPS. Exact coverage is printed.
  const text = await Deno.readTextFile(FIXTURE);
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  assertEquals(lines.length, 34);
  const fixtureTypes = new Set<string>();
  for (const line of lines) {
    const rec = JSON.parse(line) as { payload_type: string };
    fixtureTypes.add(rec.payload_type);
  }
  const matched = [...fixtureTypes].filter((t) => declared.has(t)).sort();
  const unmatched = [...fixtureTypes].filter((t) => !declared.has(t)).sort();
  console.log(`coverage: matched ${matched.length}/${fixtureTypes.size}; unmatched: ${JSON.stringify(unmatched)}`);
  console.log(`matched: ${JSON.stringify(matched)}`);
  console.log(`declared schema wire names (${declared.size}): ${JSON.stringify([...declared].sort())}`);
  for (const t of fixtureTypes) {
    assert(
      declared.has(t) || (DOCUMENTED_GAPS as readonly string[]).includes(t),
      `payload_type ${t} is neither schema-declared nor a documented gap`,
    );
  }
  // Gap-list freshness: exactly the unmatched set, no stale entries.
  assertEquals(unmatched, [...DOCUMENTED_GAPS].sort());

  // (3) Mapping check: every fixture line through wireLineToUiEvents yields
  // zero errors, ≥1 delta, and a terminal `completed` done event.
  let deltas = 0;
  let errors: string[] = [];
  let terminals: Array<{ text: string; terminal: string }> = [];
  lines.forEach((line, i) => {
    for (const e of wireLineToUiEvents(line, i + 1)) {
      if (e.type === "delta") deltas++;
      else if (e.type === "done") terminals.push({ text: e.text, terminal: e.terminal });
      else if (e.type === "error") errors.push(e.message);
    }
  });
  assertEquals(errors, []);
  assert(deltas >= 1, `expected ≥1 delta, got ${deltas}`);
  assertEquals(terminals.length, 1);
  assertEquals(terminals[0].terminal, "completed");
});
