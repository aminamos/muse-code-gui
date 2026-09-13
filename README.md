# muse-code-ui

Graphical frontends (Windows, macOS, iOS, Android) for Muse Code that
execute through `muse exec`, so runs use the host's subscription login.
The relay also serves transcription with speaker diarization, document
ingest, and MCP tools.

## Contents

- [Layout](#layout)
- [Run the relay](#run-the-relay)
- [Verify](#verify)
- [MCP](#mcp)
- [Status](#status)
- [For AI agents](#for-ai-agents)

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
submission, and per-harness installer repos are still open.

## For AI agents

Give your agent this repo link plus everything below the line.

---

Set up muse-exec-gui (Muse subscription only — no API credits):

1. Clone https://github.com/aminamos/muse-exec-gui and open `relay/`.
2. Confirm prerequisites: Deno 2+, Node 20+, and `muse --version` runs.
   Login is proven at step 8 — a credential error there means `muse login`
   is missing, so stop and tell the user to sign in.
3. Generate a relay token and export it as `MUSE_UI_RELAY_TOKEN`
   (the relay also accepts it as `RELAY_TOKEN`).
4. Start the relay: `MUSE_UI_RELAY_TOKEN=<token> deno task start`
   (working directory `relay/`). Confirm `GET /api/health` returns
   `ok:true` and `billing:"subscription"`.
5. If `META_API_KEY` or `MUSE_API_TOKEN` is set anywhere in the
   environment, STOP and warn the user: Muse will bill API credits
   instead of the subscription login.
6. Add the MCP server to the user's harness (stdio, no token needed):
   `deno run --allow-run --allow-read --allow-write --allow-env --allow-net
   --config <repo>/relay/deno.json <repo>/relay/src/mcp-stdio.ts`
   (replace `<repo>` with the clone path; back up any config first).
7. If the harness supports OpenAI-compatible providers, add model
   `muse-code` at baseURL `http://127.0.0.1:8787/v1`, referencing the
   token by env NAME `MUSE_UI_RELAY_TOKEN` (never paste the value).
   The relay must be running for provider calls.
8. Prove it: one tiny turn ("say hi") through the new provider, or the
   harness's provider/MCP list command. Report what was spent.
9. Details: `docs/PROVIDERS.md` (per-harness entries), `docs/SDK.md`
   (engine + fallback), `docs/TRANSCRIBE.md` (transcription).

---
