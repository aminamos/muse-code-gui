# Transcribe + ingest + MCP (relay extension to the exec contract)

The relay also serves transcription/diarization, document ingest, and MCP
tools. Auth is the same relay Bearer [REDACTED] on every route.

## HTTP API

- `POST /api/transcribe` → `text/event-stream` of
  `started{jobId}`, `progress{stage,detail}`, `log{stream,text}`,
  `done{result}`, `error{message}`.
  - JSON body: `{ source: { kind: "url"|"path"|"rss", value, index? },
    language?, diarize?, model? }`.
    `path` is relay-host-local. `rss` takes a feed URL + episode `index`.
  - Multipart: field `audio` (mp3, m4a, mp4, m4b, wav, …) plus optional
    `language`, `diarize`, `model` fields.
  - `result`: `{ engine, diarization: "external"|"none", language,
    duration, speakers[], segments[{start,end,speaker,text}], text }`.
- `POST /api/ingest` → JSON `{ format, title, text, chars }`.
  - JSON body: `{ source: { kind: "text"|"path"|"url", value, filename? } }`.
  - Multipart: field `document`. Formats: txt, md, epub (spine-ordered),
    pdf (via `pdftotext -layout`).
- `GET /api/health` adds `transcribe` and `ingest` capability blocks to the
  contract's `{ ok, museBin, museVersion }`.

## Engines

- Transcription default: local `whisper` CLI (`WHISPER_BIN`, model
  `WHISPER_MODEL`, default `turbo`). Large-v3-turbo weights are cached on
  this machine, so the default runs offline.
- Parakeet: no local Parakeet CLI exists here (Handy.app is GUI-only; the
  HF cache holds only its model). Whisper is the fallback for that reason.
  If a Parakeet CLI appears, point `WHISPER_BIN` at a whisper-compatible
  wrapper or extend `relay/src/transcribe.ts`.
- Decode: `ffmpeg` to 16 kHz mono wav (`FFMPEG_BIN`).
- Diarization is a subprocess stage: `DIARIZE_HELPER` points at an
  executable taking a wav path and printing JSON
  `[{start,end,speaker}]` on stdout. Without it, segments are labeled
  `SPEAKER_00` and `diarization` is `"none"`.
- pyannote weights (`pyannote/speaker-diarization-community-1`) return
  HTTP 401 without an HF login, so a stock install cannot fetch them. To
  enable: accept the model terms on Hugging Face, install
  `pyannote.audio` + `torch` (e.g. `uv pip install`), write the helper
  script per the contract above, and set `DIARIZE_HELPER`.

## MCP + API use from an agent

- Stdio (any MCP client): run `deno task mcp-stdio` with cwd `relay/`.
  Tools: `muse_exec`, `transcribe_audio`, `ingest_document`,
  `rss_episodes`. Stdio trusts the local caller (no token).
- Streamable HTTP: `POST http://127.0.0.1:8787/mcp` with the relay
  Bearer [REDACTED] JSON-RPC (`initialize`, `tools/list`,
  `tools/call`). Stateless; no SDK dependency.
- Muse settings snippet (shape inferred from `muse mcp --help`;
  confirm against Muse on first connect):
  `{ "mcpServers": { "muse-code-ui": {
    "url": "http://127.0.0.1:8787/mcp",
    "headers": { "Authorization": "Bearer <relay-token>" } } } }`
- Example agent flow: `rss_episodes` → `transcribe_audio` (rss source +
  index) → `muse_exec` to summarize the transcript on the subscription.

## GUI

- All four apps have a Transcribe view: url/rss/path source, language,
  diarize toggle, run/stop, progress status, `[mm:ss.mmm SPEAKER] text`
  segments. It shares each app's relay URL/token settings.
- Desktop apps also accept a file upload (multipart); mobile is
  URL/RSS/relay-path only in v1 (no document picker yet).
- Android puts Exec/Transcribe behind a mode toggle; the other three
  apps stack both sections on one screen.

## Limits

- Downloads: 2 GiB cap. Documents: 100 MiB cap. Prompts: 200 k chars.
- `path` sources are relay-host paths, not client paths — mobile
  clients must use URL/RSS unless the file is on the relay host.
