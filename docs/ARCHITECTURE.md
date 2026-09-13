# Architecture (frozen)

Project root: `/Users/amin/development/muse-code-gui`.
Per-platform apps live in `apps/windows`, `apps/macos`, `apps/ios`,
`apps/android`. Shared frozen inputs (`docs/`, `testdata/`) are read-only.

## Stack

- iOS + Android: Expo SDK (managed workflow) + TypeScript. One JS codebase,
  per-platform EAS build profiles. Expo Go covers dev iteration; EAS cloud
  Macs produce the iOS artifact (Apple Developer membership already held).
- Windows + macOS: Tauri v2 (desktop targets only) + React + Vite +
  TypeScript. No mobile init from these shells; the iOS-from-Windows question
  does not apply to them.
- Exec engine (lead builds next): one Deno relay that spawns
  `muse exec --json` and exposes the SSE API in `docs/EXEC-CONTRACT.md`.
  Desktop bundles or starts a localhost relay; mobile points at a relay URL.
- All four UIs implement the same five-event model against the same fixture.
  Transport differs (localhost vs remote), rendering does not.

## What each platform child owns

- Scaffold in `apps/<platform>` only: package/manifest files, config,
  source, and tests for that app.
- An exec-runner UI: prompt input, run/stop, streaming text view, log view,
  settings (relay URL + token; desktop defaults URL to localhost).
- A `smoke` script (Node, no network) that parses
  `../../testdata/exec-stream.jsonl` per the contract and asserts: at least
  one delta, concatenated text `"echo: say hi"`, terminal `"completed"`,
  terminal text equals concatenated text. Prints `SMOKE PASS` plus counts.
- TypeScript clean (`tsc --noEmit`) and the platform build command below.

## Verify commands (run inside `apps/<platform>`)

- ios: `npm install --no-audit --no-fund && npx tsc --noEmit && npm run smoke && npx expo export --platform ios`
- android: `npm install --no-audit --no-fund && npx tsc --noEmit && npm run smoke && npx expo export --platform android`
- windows/macos: `npm install --no-audit --no-fund && npx tsc --noEmit && npm run build && npm run smoke && (cd src-tauri && cargo check)`

## Out of scope for platform children

Relay server, EAS/TestFlight submission, signed installers, store assets,
changes to `docs/`, `testdata/`, or another `apps/*` directory.
