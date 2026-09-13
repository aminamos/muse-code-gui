# Muse Code GUI — Windows

Tauri v2 desktop-only shell + React + Vite + TypeScript exec-runner UI.

Implements the frozen five-event model from `docs/EXEC-CONTRACT.md`
(`started`, `delta`, `log`, `done`, `error`) against the relay SSE API
(`POST /api/exec`, `GET /api/health`). Auth is the relay subscription
token (`Authorization: Bearer <token>`); this app never handles a
provider API key.

## Settings

- Relay URL defaults to the localhost relay (`http://127.0.0.1:8787`).
  Enter any LAN/Tailscale URL as a remote override, or reset to localhost.
- Relay token is stored in `localStorage` (`relayToken`).

## Scripts

- `npm run dev` — Vite dev server (used by `tauri dev`).
- `npm run build` — frontend production build.
- `npm run smoke` — Node-only fixture check (no network).
- `npm run tauri -- …` — Tauri CLI (desktop targets only, no mobile init).

## Verify

Inside `apps/windows`:

```sh
npm install --no-audit --no-fund && npx tsc --noEmit && npm run build && npm run smoke && (cd src-tauri && cargo check)
```

Windows bundle targets (`nsis`, `msi`) are configured in
`src-tauri/tauri.conf.json`. Packaging/signing is out of scope.
