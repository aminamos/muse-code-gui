/**
 * Smoke test (Node, no network): parses ../../testdata/exec-stream.jsonl
 * per docs/EXEC-CONTRACT.md and asserts the fixture facts:
 * - at least one run.output.delta
 * - concatenated delta text === "echo: say hi"
 * - terminal === "completed"
 * - terminal payload text === concatenated text
 *
 * Prints SMOKE PASS plus counts; exits non-zero on any mismatch.
 */
const fs = require('fs');
const path = require('path');

const FIXTURE = path.join(__dirname, '..', '..', '..', 'testdata', 'exec-stream.jsonl');
const EXPECTED_TEXT = 'echo: say hi';
const EXPECTED_TERMINAL = 'completed';

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  process.exit(1);
}

const raw = fs.readFileSync(FIXTURE, 'utf8');
const lines = raw.split('\n').filter((line) => line.trim() !== '');

let deltas = 0;
let concatenated = '';
let terminal = null;
let terminalText = null;
let lifecycle = 0;

lines.forEach((line, index) => {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    fail(`line ${index + 1} is not valid JSON`);
    return;
  }
  if (typeof record.payload_type !== 'string' || typeof record.payload !== 'object' || record.payload === null) {
    fail(`line ${index + 1} missing payload_type/payload`);
    return;
  }
  const { payload_type: payloadType, payload } = record;
  if (payloadType === 'run.output.delta') {
    deltas += 1;
    concatenated += typeof payload.text === 'string' ? payload.text : '';
  } else if (payloadType.startsWith('run.terminal.')) {
    terminal = payload.terminal;
    terminalText = payload.text;
  } else if (
    payloadType.startsWith('task.lifecycle.') ||
    payloadType === 'task.stream.linked' ||
    payloadType === 'session.run.linked' ||
    payloadType === 'run.lifecycle.started' ||
    payloadType === 'turn.input.user' ||
    payloadType === 'runtime.command.accepted'
  ) {
    lifecycle += 1;
  }
});

if (deltas < 1) {
  fail(`expected at least one delta, saw ${deltas}`);
}
if (concatenated !== EXPECTED_TEXT) {
  fail(`concatenated text ${JSON.stringify(concatenated)} !== ${JSON.stringify(EXPECTED_TEXT)}`);
}
if (terminal !== EXPECTED_TERMINAL) {
  fail(`terminal ${JSON.stringify(terminal)} !== ${JSON.stringify(EXPECTED_TERMINAL)}`);
}
if (terminalText !== concatenated) {
  fail(`terminal text ${JSON.stringify(terminalText)} !== concatenated ${JSON.stringify(concatenated)}`);
}

console.log(`SMOKE PASS lines=${lines.length} deltas=${deltas} lifecycle=${lifecycle} text=${JSON.stringify(concatenated)} terminal=${JSON.stringify(terminal)}`);
