// Smoke test: Node only, no network. Parses the frozen parser fixture
// ../../testdata/exec-stream.jsonl per docs/EXEC-CONTRACT.md and asserts:
// at least one delta, concatenated text "echo: say hi", terminal
// "completed", and terminal text equal to the concatenated text.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// Contract path is ../../testdata/exec-stream.jsonl relative to apps/windows.
const appRoot = path.resolve(here, "..");
const fixturePath = path.resolve(appRoot, "../../testdata/exec-stream.jsonl");

const raw = readFileSync(fixturePath, "utf8");
const lines = raw.split("\n").filter((line) => line.length > 0);

let deltas = 0;
let lifecycle = 0;
let other = 0;
let text = "";
let terminal = null;
let terminalText = null;
const errors = [];

lines.forEach((line, index) => {
  const lineNumber = index + 1;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    errors.push(`line ${lineNumber}: unparseable JSON`);
    return;
  }
  const payloadType = record.payload_type;
  const payload = record.payload ?? {};
  if (payloadType === "run.output.delta") {
    deltas += 1;
    text += payload.text ?? "";
  } else if (
    typeof payloadType === "string" &&
    payloadType.startsWith("run.terminal.")
  ) {
    terminal = payload.terminal;
    terminalText = payload.text;
  } else if (
    typeof payloadType === "string" &&
    (payloadType.startsWith("task.lifecycle.") ||
      payloadType === "task.stream.linked" ||
      payloadType === "session.run.linked" ||
      payloadType === "run.lifecycle.started" ||
      payloadType === "turn.input.user" ||
      payloadType === "runtime.command.accepted")
  ) {
    lifecycle += 1;
  } else {
    other += 1;
  }
});

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  process.exit(1);
}

if (errors.length > 0) fail(errors.join("; "));
if (deltas < 1) fail(`expected at least one delta, got ${deltas}`);
if (text !== "echo: say hi") fail(`expected text "echo: say hi", got ${JSON.stringify(text)}`);
if (terminal !== "completed") fail(`expected terminal "completed", got ${JSON.stringify(terminal)}`);
if (terminalText !== text) {
  fail(
    `terminal text ${JSON.stringify(terminalText)} != concatenated ${JSON.stringify(text)}`,
  );
}

console.log(
  `SMOKE PASS lines=${lines.length} deltas=${deltas} lifecycle=${lifecycle} other=${other} text=${JSON.stringify(text)} terminal=${terminal}`,
);
