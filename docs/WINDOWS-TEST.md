# Windows agent test plan — muse-code-gui

You are running on Windows. This file is your full handoff: repo state,
what macOS already proved, and exactly what to verify here. Work through
the phases in order, record outcomes in the Results section at the bottom,
and commit this file with your results.

Repo: https://github.com/aminamos/muse-code-gui — test HEAD (`7f31261`
or later; note the exact commit you tested).

## 1. Context snapshot

- **What this is:** four GUI apps (Tauri Windows/macOS shells, Expo
  iOS/Android) plus one Deno relay (`relay/`). Every model run executes
  through the `muse` CLI on the relay host via `muse login`
  subscription. No API key exists anywhere; `MUSE_API_TOKEN`-style env
  passthrough is rejected by design.
- **Names that matter:** product `Muse Code GUI`, token
  `MUSE_GUI_RELAY_TOKEN`, OMP provider id `mcg-relay`, MCP server name
  `muse-code`, WSL launcher flag `MUSE_LAUNCHER`.
- **Proved on macOS (do not re-prove, only check for Windows skew):**
  `deno task check` clean, relay suite 44/44 green (incl. live
  subscription turns), `install.sh --dry-run` idempotent across all 5
  harnesses (OMP, OpenCode, Claude Code, Codex, Command Code), Tauri
  `.app`+`.dmg` builds, Expo export, chat UIs stream via the relay echo
  provider with zero spend.
- **Never verified — this is your job:** everything below. The guide in
  [WINDOWS.md](WINDOWS.md) marks OS-installer commands UNVERIFIED;
  confirm or correct each one.

## 2. Ground rules

- Prefer free tiers; the Apple $99 fee is approved if TestFlight is
  needed (out of scope for this pass).
- Never print secret values. The relay token is name-referenced only.
- The relay bills the **host's** `muse login` subscription. Keep live
  test turns tiny (`say hi` scale).
- Fix repo bugs you find (small, in-scope edits welcome); do not
  redesign. Record anything you deliberately left alone under Results.

## 3. Phase A — toolchain (correct WINDOWS.md §1)

1. In **PowerShell**, run each install command from `docs/WINDOWS.md`
   §1a (Node LTS, Deno, Rust). Record the exact commands that worked;
   if a `winget` id is wrong, find the right one (`winget search …`)
   and note the correction.
2. Repeat with **Git Bash** per §1b.
3. Confirm: `node --version` (≥20), `deno --version` (2+),
   `rustc --version`, `git --version` in both shells. Paste versions.

## 4. Phase B — installer

1. `cd` to the repo clone. PowerShell:
   `.\installer\install.ps1 -DryRun`. This script has **never
   executed** — expect bugs; fix them in the repo.
2. Re-run without `-DryRun`. It must back up every touched harness
   config first and never print the token value.
3. Git Bash: `bash installer/install.sh --dry-run`, then real apply.
4. Generate the token if absent (`openssl rand -hex 32` or the
   installer's printed line) and export `MUSE_GUI_RELAY_TOKEN` in the
   shell you will use. Record which shells you exported it in.

## 5. Phase C — relay on Windows

1. `cd relay && deno task start` (or `start-remote` for LAN tests).
   Check `GET /api/health`: `billing` should read `subscription` and
   the `binaries{}` audit should list each binary found/missing.
2. Zero-spend turn: `POST /api/exec` with `{"prompt":"say hi",
   "provider":"echo"}` and the token header — expect streamed
   `started → deltas → done{terminal:completed}`.
3. One tiny live turn (no `provider` key, subscription-billed).
4. If `muse` is only inside WSL2: set
   `MUSE_LAUNCHER=wsl` (+ `MUSE_BIN` if needed) and repeat steps 2–3.
   Note that `--workspace` paths must then be WSL paths.

## 6. Phase D — Windows desktop GUI

1. `cd apps/windows && npm install && npm run tauri:build`.
   Expect `nsis`/`msi` bundles. If the build fails, capture the first
   error verbatim.
2. Install/run the bundle, point it at the relay (localhost default),
   send one chat message. Record what renders.
3. `cargo check --target x86_64-pc-windows-msvc` is informational only.

## 7. Phase E — transcribe deps (optional this pass)

`ffmpeg` + `whisper` per `docs/WINDOWS.md` §8, then one short local
audio file through the relay transcribe endpoint. Diarization falls
back to single-speaker without the helper — record which path ran.

## 8. Results (fill in on Windows)

- Tested commit:
- Shell(s) used:
- Phase A (working install commands + versions):
- Phase B (install.ps1 fixes / install.sh notes):
- Phase C (health output, echo + live turn outcomes, WSL notes):
- Phase D (bundle built? chat worked? first error if not):
- Phase E (if attempted):
- Repo edits made (files):
- Left for later:
