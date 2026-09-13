// Smoke test (Node, no network): parses ../../testdata/exec-stream.jsonl per
// docs/EXEC-CONTRACT.md and asserts the fixture facts. Run: npm run smoke.
const fs = require("fs");
const path = require("path");

const FIXTURE = path.join(__dirname, "..", "..", "..", "testdata", "exec-stream.jsonl");
const EXPECTED_TEXT = "echo: say hi";
const EXPECTED_TERMINAL = "completed";

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  process.exitCode = 1;
}

function main() {
  let source;
  try {
    source = fs.readFileSync(FIXTURE, "utf8");
  } catch (err) {
    fail(`cannot read fixture: ${err.message}`);
    return;
  }

  let lines = 0;
  let deltas = 0;
  let logs = 0;
  let dones = 0;
  let parseErrors = 0;
  let text = "";
  let terminal = null;
  let terminalText = null;

  const rawLines = source.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const lineNumber = i + 1;
    const line = rawLines[i].trim();
    if (line.length === 0) {
      continue;
    }
    lines += 1;

    let value;
    try {
      value = JSON.parse(line);
    } catch {
      parseErrors += 1;
      fail(`line ${lineNumber}: unparseable JSON`);
      continue;
    }
    if (
      value === null ||
      typeof value !== "object" ||
      typeof value.payload_type !== "string" ||
      value.payload === null ||
      typeof value.payload !== "object"
    ) {
      parseErrors += 1;
      fail(`line ${lineNumber}: missing payload_type/payload`);
      continue;
    }

    const payloadType = value.payload_type;
    const payload = value.payload;

    if (payloadType === "run.output.delta") {
      deltas += 1;
      text += typeof payload.text === "string" ? payload.text : "";
    } else if (payloadType.startsWith("run.terminal.")) {
      dones += 1;
      terminal = typeof payload.terminal === "string" ? payload.terminal : "";
      terminalText = typeof payload.text === "string" ? payload.text : "";
    } else if (
      payloadType.startsWith("task.lifecycle.") ||
      payloadType === "task.stream.linked" ||
      payloadType === "session.run.linked" ||
      payloadType === "run.lifecycle.started" ||
      payloadType === "turn.input.user" ||
      payloadType === "runtime.command.accepted"
    ) {
      logs += 1;
    } else {
      logs += 1;
    }
  }

  if (deltas < 1) {
    fail(`expected at least one delta, got ${deltas}`);
  }
  if (text !== EXPECTED_TEXT) {
    fail(`concatenated text ${JSON.stringify(text)} !== ${JSON.stringify(EXPECTED_TEXT)}`);
  }
  if (terminal !== EXPECTED_TERMINAL) {
    fail(`terminal ${JSON.stringify(terminal)} !== ${JSON.stringify(EXPECTED_TERMINAL)}`);
  }
  if (terminalText !== text) {
    fail(
      `terminal text ${JSON.stringify(terminalText)} !== concatenated text ${JSON.stringify(text)}`,
    );
  }

  if (process.exitCode) {
    return;
  }
  console.log(
    `SMOKE PASS lines=${lines} deltas=${deltas} logs=${logs} dones=${dones} ` +
      `parseErrors=${parseErrors} terminal=${terminal} text=${JSON.stringify(text)}`,
  );
}

main();
