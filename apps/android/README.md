# muse-code-ui — Android

Expo SDK (managed workflow) + TypeScript app. Remote-relay-only: Android
cannot spawn the `muse` binary, so every run goes to a relay URL (LAN or
Tailscale) authenticated with a bearer token. The token authorizes relay
access; this app never handles a provider API key.

## UI

- Prompt input, Run/Stop, streaming output view, log view.
- Settings: relay URL + relay token, with a Test connection button
  (`GET /api/health`).

## Events

`src/exec/` implements the five UI events from
`docs/EXEC-CONTRACT.md` (`started`, `delta`, `log`, `done`, `error`).
Relay SSE `data:` frames already carry these events; `jsonl.ts` documents
the `muse exec --json` mapping and is mirrored by the smoke test.

## Verify (inside `apps/android`)

```sh
npm install --no-audit --no-fund && npx tsc --noEmit && npm run smoke && npx expo export --platform android
```

EAS profiles for the android platform live in `eas.json`.
