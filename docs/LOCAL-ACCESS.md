# Local access: MCP, ACP, API, CLI for `muse exec`

One relay, four doors. Everything bills the relay host's `muse login`
subscription. No door accepts or forwards an API key: if `MUSE_API_TOKEN`
or `META_API_KEY` is set, the tools warn on stderr that muse would bill
API credits instead of your subscription.

Repo root: `muse-code-gui/relay`. All commands below run with cwd `relay/`
unless stated.

## MCP (Model Context Protocol)

For MCP clients (Claude Code, Codex, OpenCode, Command Code, OMP).

- stdio (local, no token — it runs as you):
  `deno task mcp-stdio`
- Streamable HTTP (needs relay + token):
  `POST http://127.0.0.1:8787/mcp` with `Authorization: Bearer $MUSE_GUI_RELAY_TOKEN`
- Tools: `muse_exec`, `voice_exec`, `transcribe_audio`, `ingest_document`, `rss_episodes`
- `installer/install.sh` (or `install.ps1` on Windows) registers the stdio
  server in all five harnesses. Re-run it with `--dry-run` first.

## ACP (Agent Client Protocol, v1)

For ACP clients (e.g. Zed). Newline-delimited JSON-RPC 2.0 over stdio,
no token — it runs as you.

- `deno task acp-stdio` (or `museexec acp` once the CLI is installed)
- Flow: `initialize` (protocolVersion 1) → `session/new` {cwd, mcpServers[]}
  → `session/prompt` {sessionId, prompt:[{type:"text",text}]} with
  `session/update` `agent_message_chunk` streaming back →
  `{stopReason:"end_turn"}`. `session/cancel` aborts the turn
  (`stopReason:"cancelled"`).
- Text only: image/audio blocks are rejected honestly (transcribe audio
  first via MCP/API/CLI). `session/load`, `session/resume`, and
  `authenticate` are unadvertised (not implemented, no host login needed).
- Billing: subscription `meta` by default. `MUSE_ACP_PROVIDER=echo` runs
  the zero-spend echo path for protocol testing.

## HTTP API

Relay must be running: `MUSE_GUI_RELAY_TOKEN=<token> deno task start`
(Bearer token on every route; CORS preflights pass for Tauri/Expo webviews).

- `GET /api/health` — billing mode, binaries, versions
- `POST /api/exec` — SSE `{prompt, workspace?, model?, sessionId?, ...}`
- `POST /api/voice_exec` — SSE; `{audio:{kind:url|path|rss,value,index?}, ...exec fields}`.
  Transcribes locally, then runs the transcript as the prompt.
- `POST /api/transcribe`, `POST /api/ingest`, `POST /mcp`, `/v1/*`
  (OpenAI-compatible chat completions + models)

```sh
curl -N -H "Authorization: Bearer $MUSE_GUI_RELAY_TOKEN" \
  -H "Content-Type: application/json" -d '{"prompt":"say hi"}' \
  http://127.0.0.1:8787/api/exec
```

## CLI (`museexec`)

Local, no token — runs as you. Subscription `meta` by default.

- Install once:
  `deno task install-cli` (puts `museexec` on PATH via `deno install --global`)
- `museexec exec "say hi"` — streams text to stdout (`--json` for JSONL events)
- `museexec voice ./note.m4a` — transcribe locally, run transcript as prompt
  (`--language`, `--no-diarize`, `--prompt-prefix`, plus exec options)
- `museexec transcribe ./ep.mp3` — whisper only, prints timestamped segments
- `museexec health` — binary audit + billing mode
- `museexec mcp` / `museexec acp` — run the bundled stdio servers
- `--provider echo` — zero-spend echo path for testing plumbing
- `--muse-bin PATH` — override the muse binary (or `MUSE_LAUNCHER=wsl`
  setups keep working through the relay config)

## Voice input

Your subscription includes TUI voice input (Option+V), but that lives
inside the interactive terminal. The local equivalent is the voice
pipeline: local whisper transcription (free, offline, diarized) feeding
`muse exec`. Same framing everywhere (`voice.ts`): "Follow this voice
instruction…", overridable via `promptPrefix`. Pure transcription without
running a prompt is `transcribe_audio` / `museexec transcribe`.
