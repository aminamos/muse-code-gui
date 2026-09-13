// Node smoke test (no network): parses ../../testdata/exec-stream.jsonl per
// docs/EXEC-CONTRACT.md and asserts the five-event mapping.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "..", "..", "..", "testdata", "exec-stream.jsonl");
const raw = readFileSync(fixture, "utf8");

let lines = 0;
let deltas = 0;
let terminals = 0;
let lifecycle = 0;
let text = "";
let terminal = null;
let terminalText = null;
const failures = [];

for (const [i, record] of raw.split("\n").entries()) {
  if (!record.trim()) continue;
  lines += 1;
  let parsed;
  try {
    parsed = JSON.parse(record);
  } catch {
    failures.push(`line ${i + 1}: unparseable JSON`);
    continue;
  }
  const { payload_type: type, payload } = parsed;
  if (type === "run.output.delta") {
    deltas += 1;
    text += payload.text;
  } else if (typeof type === "string" && type.startsWith("run.terminal.")) {
    terminals += 1;
    terminal = payload.terminal;
    terminalText = payload.text;
  } else if (typeof type === "string" && type.length > 0) {
    lifecycle += 1;
  }
}

function check(name, actual, expected) {
  if (actual !== expected) {
    failures.push(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

if (deltas < 1) failures.push(`expected at least one delta, got ${deltas}`);
check("concatenated text", text, "echo: say hi");
check("terminal", terminal, "completed");
check("terminal text equals concatenated text", terminalText, text);

if (failures.length > 0) {
  console.error("SMOKE FAIL");
  for (const f of failures) console.error(`- ${f}`);
  process.exit(1);
}
console.log(
  `SMOKE PASS lines=${lines} deltas=${deltas} terminals=${terminals} lifecycle=${lifecycle} text=${JSON.stringify(text)} terminal=${JSON.stringify(terminal)}`,
);
