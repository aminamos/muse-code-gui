# Exec contract (frozen shared input, read-only for platform children)

All four platform apps execute prompts through the same path: spawn
`muse exec --json <prompt>` (subscription login inherited, never an API key)
and normalize its stdout JSONL into the UI event stream below.

## Fixture (recorded, immutable)

- `testdata/exec-stream.jsonl`: 34 lines, one JSON object per line, from
  `muse exec --provider echo --json "say hi"` (exit 0).
- `testdata/exec-stderr.log`: the process stderr for that run.
- Do not edit either file. Test parsers against them.

## Observed wire facts (from the fixture)

- stdout: JSONL. Every line parses as JSON with `payload_type` + `payload`.
- Assistant text arrives as `payload_type: "run.output.delta"` with
  `payload.text` (concatenate in order; fixture total: `"echo: say hi"`).
- Run end arrives as `payload_type: "run.terminal.completed"` with
  `payload.terminal` (`"completed"`) and full `payload.text`.
- Task lifecycle events (`task.lifecycle.*`, `task.stream.linked`,
  `session.run.linked`, `run.lifecycle.started`, `turn.input.user`,
  `runtime.command.accepted`) are progress metadata, not user-visible text.
- stderr lines starting with `muse: ` are diagnostics, surfaced as log lines,
  never as assistant text.

## UI event model (every platform renders these five)

1. `started { runId }` — process spawned.
2. `delta { text }` — one per `run.output.delta`, appended verbatim.
3. `log { stream: "stderr" | "info", text }` — stderr lines and lifecycle
   milestones (`task_kind` + state transitions, best effort).
4. `done { text, terminal, exitCode }` — on `run.terminal.*`; `text` is the
   concatenated deltas; `terminal` is the raw terminal string.
5. `error { message }` — spawn failure, non-zero exit without terminal event,
   or unparseable line (include line number, keep parsing the rest).

## Relay API (implemented later by the lead; clients target this shape now)

- `POST /api/exec` with
  `{ prompt, workspace?, model?, reasoningEffort?, approvalMode?,
     sessionId?, provider? }`
  returns `text/event-stream` emitting the five UI events as
  `data: <json>\n\n` frames.
- `GET /api/health` returns `{ ok, museBin, museVersion }`.
- Auth: `Authorization: Bearer <token>`. No token, no execution.

## Remote-exec decision (frozen)

- iOS and Android cannot spawn the `muse` binary: they are remote-only and
  connect to a relay over LAN or Tailscale with a token.
- Windows and macOS default to a localhost relay and allow a remote override.
- Subscription-token rule: the relay inherits the host's `muse` login from its
  environment. No client and no relay request may carry, inject, or persist a
  provider API key. `MUSE_BIN` env (or relay setting) may override the binary
  path; default search is `PATH`, `~/.local/bin/muse`, `/opt/homebrew/bin/muse`.
