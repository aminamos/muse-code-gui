# muse-code-ui

Graphical frontends (Windows, macOS, iOS, Android) for Muse Code that
execute through `muse exec`, so runs use the host's subscription login.
The relay also serves transcription with speaker diarization, document
ingest, and MCP tools.

## Layout

- `apps/ios`, `apps/android`: Expo + TypeScript (remote-relay-only).
- `apps/windows`, `apps/macos`: Tauri v2 desktop shells + React + Vite.
- `relay/`: Deno server — the only exec/transcribe engine.
- `docs/EXEC-CONTRACT.md`, `docs/ARCHITECTURE.md`: frozen contracts.
- `docs/TRANSCRIBE.md`: transcribe/ingest/MCP reference.
- `testdata/`: recorded `muse exec --json` fixture + stderr.

## Run the relay

```bash
cd relay
RELAY_TOKEN=secret deno task start        # http://127.0.0.1:8787
```

Without `RELAY_TOKEN` a token is generated and printed once. Desktop
apps default to the localhost relay; mobile points at the relay over
LAN/Tailscale. `DIARIZE_HELPER` enables real speaker labels (see
`docs/TRANSCRIBE.md`); otherwise segments are `SPEAKER_00`.

## Verify

```bash
cd relay && deno task check && deno task test
cd ../apps/ios && npm install && npx tsc --noEmit && npm run smoke
cd ../android && npm install && npx tsc --noEmit && npm run smoke
cd ../windows && npm install && npx tsc --noEmit && npm run build && npm run smoke && (cd src-tauri && cargo check)
cd ../macos && npm install && npx tsc --noEmit && npm run build && npm run smoke && (cd src-tauri && cargo check)
```

## MCP

Stdio: `cd relay && deno task mcp-stdio`. Streamable HTTP:
`POST /mcp` on the relay with the Bearer [REDACTED] Tools:
`muse_exec`, `transcribe_audio`, `ingest_document`, `rss_episodes`.

## Status

Scaffolds verified per-app (tsc, smoke, expo export / vite build /
cargo check). Transcribe UI added on all four. Signed installers, EAS
submission, and multi-speaker diarization enablement are still open.
