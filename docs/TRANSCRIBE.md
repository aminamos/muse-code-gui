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
- Diarization default: sherpa-onnx helper at `relay/scripts/sherpa/diarize`
  (auto-detected when executable; models in `relay/models/sherpa/`,
  venv in `relay/.venv-sherpa/`). `DIARIZE_HELPER` overrides the path;
  `DIARIZE_HELPER=off` forces single-speaker (`SPEAKER_00`,
  `diarization:"none"`). Helper contract: argv is a wav path, stdout is
  JSON `[{start,end,speaker}]`; any failure falls back to single-speaker
  with a log line.
- Verified: 17s single-speaker clip → 1 turn in ~2s; pitch-shifted
  two-voice concat → 2 turns with the boundary at the splice; same-voice
  DE+EN concat → correctly 1 speaker.
- pyannote alternative: `relay/scripts/pyannote/diarize.py` +
  `SETUP.md` (weights are HF-gated, HTTP 401 without login; needs user
  terms-accept + token, then point `DIARIZE_HELPER` at it).
- Muse Voice engine (opt-in): Meta's `muse-voice-transcribe-1.0` over
  `POST https://api.meta.ai/v1/asr/transcribe` (files) and
  `wss://api.meta.ai/v1/asr/realtime` (live mic, proxied at relay
  `GET /api/asr/realtime`). Select per request (`engine:
  "local"|"muse-voice"`) or by default (`TRANSCRIBE_ENGINE=muse-voice`).
  Needs `MUSE_VOICE_API_KEY` (else `META_API_KEY`) on the relay host and
  refuses loudly without one. API-billed ($0.18/audio-hour), never
  subscription; WAV caps 32 MB / 10 min (relay ffmpeg-converts to 24 kHz
  mono). Realtime proxy keeps the key server-side: the browser opens
  `/api/asr/realtime?token=<relay-token>&mode=<mode>` and streams 24 kHz
  int16 mono frames; the relay injects the Meta credential upstream.

## MCP + API use from an agent

- Stdio (any MCP client): run `deno task mcp-stdio` with cwd `relay/`.
  Tools: `muse_exec`, `voice_exec`, `transcribe_audio`,
  `ingest_document`, `rss_episodes`. Stdio trusts the local caller (no
  token). `transcribe_audio`/`voice_exec` take `engine:
  "local"|"muse-voice".
- Streamable HTTP: `POST http://127.0.0.1:8744/mcp` with the relay
  Bearer [REDACTED] JSON-RPC (`initialize`, `tools/list`,
  `tools/call`). Stateless; no SDK dependency.
- Muse settings snippet (shape inferred from `muse mcp --help`;
  confirm against Muse on first connect):
  `{ "mcpServers": { "muse-code-gui": {
    "url": "http://127.0.0.1:8744/mcp",
    "headers": { "Authorization": "Bearer <relay-token>" } } } }`
- Example agent flow: `rss_episodes` → `transcribe_audio` (rss source +
  index) → `muse_exec` to summarize the transcript on the subscription.

## GUI

- All four apps have a Transcribe view: url/rss/path source, language,
  diarize toggle, run/stop, progress status, `[mm:ss.mmm SPEAKER] text`
  segments. It shares each app's relay URL/token settings.
- macOS shell adds an engine selector (local free/offline vs Muse Voice
  API-billed) and a Live mic mode (realtime proxy, partial + final lines).
  macOS mic permission is not a Tauri config key: after building, run
  `npm run tauri:mic` (adds NSMicrophoneUsageDescription + re-signs).
- Desktop apps also accept a file upload (multipart); mobile is
  URL/RSS/relay-path only in v1 (no document picker yet).
- Android puts Exec/Transcribe behind a mode toggle; the other three
  apps stack both sections on one screen.

## Limits

- Downloads: 2 GiB cap. Documents: 100 MiB cap. Prompts: 200 k chars.
- `path` sources are relay-host paths, not client paths — mobile
  clients must use URL/RSS unless the file is on the relay host.
