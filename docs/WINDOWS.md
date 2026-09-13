# Windows setup — muse-code-gui

Target: run the relay and/or the Windows desktop GUI on Windows 11.
Companion docs: [PROVIDERS.md](PROVIDERS.md), [TRANSCRIBE.md](TRANSCRIBE.md),
[SDK.md](SDK.md), [EXEC-CONTRACT.md](EXEC-CONTRACT.md).

> Command provenance: every repo-derived command, path, and env name below
> was read from this repo (see the per-section "Source" notes) or from a
> local binary's `--help`. OS-installer commands (winget, WSL, EAS) could not
> be executed from the Mac used to write this guide and are marked
> UNVERIFIED where they appear.

## 0. Prerequisites (from README)

`README.md` ("Prerequisites") requires: Deno 2+, Node.js 20+,
`muse` CLI signed in (`muse login` — subscription, no API key),
Rust stable (Tauri shells only), Xcode or EAS cloud builds
(mobile installers only).

Source: `README.md:87-93` (read in repo).

## 1. Install the toolchain

Do the installs in **one** shell family and stay in it. PowerShell and
Git Bash need different commands.

### 1a. PowerShell (native Windows)

```powershell
# Node 20+ (LTS) — UNVERIFIED: vendor installer command, not executed here
winget install OpenJS.NodeJS.LTS

# Deno 2+ — UNVERIFIED: vendor installer command, not executed here
irm https://deno.land/install.ps1 | iex

# Rust stable (needed for the Tauri shell) — UNVERIFIED, not executed here
winget install Rustlang.Rustup
```

Close and reopen the terminal after installing, then confirm:

```powershell
deno --version   # want 2.x (repo runs Deno 2.9.6; README wants 2+)
node --version   # want 20+
cargo --version  # Rust stable
```

### 1b. Git Bash

Git Bash ships with Git for Windows (`winget install Git.Git` —
UNVERIFIED). Inside Git Bash, prefer winget-installed binaries (they are
on `PATH` already); for Deno the Unix installer works in Git Bash:

```bash
# Deno 2+ under Git Bash — UNVERIFIED: vendor installer, not executed here
curl -fsSL https://deno.land/install.sh | sh
```

Then confirm with the same `deno --version`, `node --version`,
`cargo --version` checks as above.

Source: version floors from `README.md:87-93`; installer URLs/commands
are vendor-documented (UNVERIFIED).

## 2. Clone the repo and set the relay token

```powershell
# PowerShell
git clone https://github.com/aminamos/muse-code-gui.git
cd muse-code-gui
# PowerShell has no `openssl rand`; .NET RNG one-liner — UNVERIFIED here
$env:MUSE_GUI_RELAY_TOKEN = [Convert]::ToHexString(
  [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

```bash
# Git Bash (openssl ships with Git for Windows — UNVERIFIED here)
git clone https://github.com/aminamos/muse-code-gui.git
cd muse-code-gui
export MUSE_GUI_RELAY_TOKEN="$(openssl rand -hex 32)"
```

Token rules (verified in `relay/src/config.ts:82-89`): `RELAY_TOKEN`
wins if both are set; `MUSE_GUI_RELAY_TOKEN` lets all harnesses share one
name. Without either, the relay generates a one-time token and prints it
(`README.md:110`).

Persist the token for future shells (both UNVERIFIED shell mechanics):

```powershell
# PowerShell — user-level persistence
[Environment]::SetEnvironmentVariable(
  "MUSE_GUI_RELAY_TOKEN", $env:MUSE_GUI_RELAY_TOKEN, "User")
```

```bash
# Git Bash — persist via ~/.bashrc
echo 'export MUSE_GUI_RELAY_TOKEN="<paste-hex>"' >> ~/.bashrc
```

## 3. `muse` on Windows runs under WSL2

Why: the `muse` launcher on this project's machines is a **bash script**
(`~/.local/bin/muse`, `muse-launcher.sh`) whose `detect_platform`
accepts only `Darwin:*` and `Linux:*` — there is no Windows target, and
Git Bash reports `MINGW*` so the launcher refuses to run there too.
Source: launcher script `detect_platform` (read from
`~/.local/bin/muse:105-113` on the Mac used to write this).

```powershell
# Enable WSL2 + default Ubuntu — UNVERIFIED: not executed here
wsl --install -d Ubuntu
wsl --update
```

Inside the WSL2 Ubuntu shell:

```bash
# Install the launcher — PARTLY VERIFIED: the URL below is the launcher's
# own MUSE_LAUNCHER_URL default (read from the script); the install flow
# itself was not executed here.
curl -fsSL https://api.meta.ai/muse-launcher.sh -o ~/.local/bin/muse
chmod +x ~/.local/bin/muse
export PATH="$HOME/.local/bin:$PATH"

muse --version   # Launcher prints e.g. "Muse Code 1.2.1 (...)"
muse login       # Browser device-code approval; see `muse login --help`
```

`muse login --help` (verified locally) says login is a browser
device-code approval and that `META_API_KEY` always takes priority —
which is exactly why the relay warns and reports `billing:"api_key"`
when `META_API_KEY`/`MUSE_API_TOKEN` is set
(`relay/src/config.ts:73-77`, `docs/PROVIDERS.md:5-8`).

### MUSE_BIN wiring (verified in repo)

`relay/src/config.ts:48-55`: the relay resolves the binary from
`MUSE_BIN`, else `muse` on `PATH`, else it throws
`"muse binary not found (set MUSE_BIN)"`.

- Relay running **inside WSL2**: `muse` is on `PATH` after the install
  above, so no `MUSE_BIN` is needed. To pin it:
  `export MUSE_BIN="$HOME/.local/bin/muse"`.
- Relay running as a **native Windows process** cannot spawn the
  bash-only launcher directly. A `wsl muse …` shim (e.g. a `.cmd`
  wrapper pointed to by `MUSE_BIN`) is a plausible pattern but
  UNVERIFIED — it was not tested here. Prefer topology A below.

### MUSE_LAUNCHER: no such relay variable

`MUSE_LAUNCHER` appears nowhere in `relay/src`, `docs`, or `apps`
(searched 2026-09-13: zero matches). The only launcher-adjacent names
are the launcher script's own knobs (`MUSE_LAUNCHER_URL`,
`MUSE_CHANNEL_URL`, `MUSE_AUTH_URL`, `MUSE_AUTH_PATH`, …), which tune
the launcher, not the relay. Wire the relay with `MUSE_BIN` only.

## 4. Two topologies

### Topology A — relay in WSL2, GUI native on Windows (recommended)

WSL2 forwards localhost both ways, so a relay bound to `127.0.0.1`
inside WSL2 (the default — `relay/src/config.ts:80-94`) is reachable
from native Windows apps at `http://127.0.0.1:8787`.
(WSL2 localhost-forwarding behavior is platform-documented, UNVERIFIED
here.)

```bash
# Inside WSL2, from the repo clone
cd relay && MUSE_GUI_RELAY_TOKEN=<token> deno task start
```

Task source: `relay/deno.json` — `start` runs
`deno run --allow-net --allow-run --allow-read --allow-write --allow-env
src/server.ts` (read in repo). Confirm from PowerShell:

```powershell
curl.exe http://127.0.0.1:8787/api/health
```

Expect `ok:true`, `billing:"subscription"`, plus `museBin`/`museVersion`
and the `transcribe`/`ingest` blocks
(`relay/src/server.ts:33-48`, `docs/TRANSCRIBE.md:22-23`).

The Windows GUI defaults to exactly this URL:
`DEFAULT_RELAY_URL = "http://127.0.0.1:8787"`
(`apps/windows/src/lib/relay.ts:12-13`), so no settings change is
needed for topology A. Remote override is via the app's Settings field
(`apps/windows/src/App.tsx`, `relayUrl` in localStorage).

### Topology B — relay on the Mac, Windows GUI over LAN

On the Mac, bind the relay to all interfaces (verified in
`relay/src/config.ts:80-81` — either form works):

```bash
# From the Mac, in relay/
RELAY_ALLOW_REMOTE=1 MUSE_GUI_RELAY_TOKEN=<token> deno task start
# or equivalently (deno.json "start-remote" passes --allow-remote):
MUSE_GUI_RELAY_TOKEN=<token> deno task start-remote
```

`bindHost` becomes `0.0.0.0` (default port `8787` from `RELAY_PORT`,
`config.ts:93`). In the Windows app's Settings, set the relay URL to
`http://<mac-lan-ip>:8787` and paste the same token.

Firewall (UNVERIFIED, not changeable from here): macOS prompts on first
`0.0.0.0` bind — accept it; Windows needs no inbound rule for an
outbound LAN client. If the GUI cannot connect, check the Mac's
Firewall settings and that both machines share the LAN (or use
Tailscale, per `README.md:118`).

## 5. Tauri Windows shell — build from source

Prereqs: Node 20+, Rust stable (§1), plus WebView2 (ships with Windows
10/11; the Tauri prerequisite list itself is vendor-documented,
UNVERIFIED here).

```powershell
cd apps\windows
npm install
npx tsc --noEmit
npm run build    # vite build (package.json "scripts", verified)
npm run smoke    # Node-only fixture check, no network (scripts/smoke.mjs)
npx tauri dev    # dev window at http://localhost:1420
npx tauri build  # release bundles
```

Source: scripts from `apps/windows/package.json` (`dev`/`build`/
`preview`/`smoke`/`tauri`); `dev`/`build` CLI verbs confirmed via local
`npx tauri --help`; `devUrl http://localhost:1420` and
`beforeDevCommand npm run dev` / `beforeBuildCommand npm run build`
from `apps/windows/src-tauri/tauri.conf.json:6-11`; the repo's own
per-app check line is `npm install && npx tsc --noEmit && npm run build
&& npm run smoke && (cd src-tauri && cargo check)` (`README.md:181`).

Bundles: `tauri.conf.json:26-36` sets
`"targets": ["nsis", "msi"]` — `npx tauri build` emits an NSIS `.exe`
and an MSI under `apps\windows\src-tauri\target\release\bundle\`
(bundle output dir is standard Tauri layout, UNVERIFIED here).

Signed-installer expectation: `README.md:148` roadmap says
"Signed installers (Apple side unblocked; Windows needs a cert)" —
until that lands, expect a Windows SmartScreen "unknown publisher"
prompt on first run of a locally built installer. (SmartScreen behavior
is platform-documented, UNVERIFIED here.)

Git Bash note: run the same commands with `/` separators
(`cd apps/windows && npm install …`). `npx tauri build` shells out to
`cargo`, which handles either separator; if a build script chokes on a
mixed path, retry from PowerShell.

## 6. Expo / EAS from Windows

Mobile apps are remote-relay-only: no localhost default
(`apps/ios/src/settings.ts:4`, `docs/EXEC-CONTRACT.md:50-51`), so point
them at topology A (`http://<windows-lan-ip>:8787` — note: from a
physical phone, `127.0.0.1` is the phone itself) or topology B.

```powershell
cd apps\android   # or apps\ios
npm install
npx tsc --noEmit
npm run smoke    # node scripts/smoke.js (package.json, verified)
npm start        # expo start — dev server + QR
```

Scripts source: `apps/ios/package.json` and `apps/android/package.json`
(`start`/`android`/`ios`/`web`/`smoke`, all `expo …` except smoke).

Cloud builds (EAS) — commands UNVERIFIED here; profiles verified in
repo (`apps/android/eas.json`, `apps/ios/eas.json`, both requiring CLI
`>= 16.0.0`):

```powershell
# UNVERIFIED: not executed here
npm install -g eas-cli
eas login
eas build -p android --profile preview   # android: internal apk
eas build -p ios --profile preview       # ios: internal, device (simulator=false)
```

Profile facts from the repo: Android `development`/`preview` are
internal-distribution APKs, `production` is an app-bundle; iOS
`development` targets simulator, `preview` targets device-internal,
`production` is store distribution with a `submit.production` block.
Package ids: `com.musecode.gui.android` (`apps/android/app.json:10`).
The repo roadmap still lists "EAS / TestFlight submission" as TODO
(`README.md:149`).

## 7. Harness provider paths on Windows

The relay contract is OS-independent (`docs/PROVIDERS.md:10-20`):
provider endpoint `POST http://127.0.0.1:8787/v1/chat/completions`,
`GET /v1/models` lists `muse-code`, Bearer token referenced by env
NAME `MUSE_GUI_RELAY_TOKEN` (never pasted); MCP stdio needs no token.

What changes on Windows is where each harness keeps config.
The Unix paths in `docs/PROVIDERS.md` (`~/.omp/agent/`,
`~/.config/opencode/opencode.jsonc`, `~/.codex/config.toml`,
`~/.commandcode/`, `claude mcp add -s user`) are verified only for
Unix; the Windows equivalents (`%APPDATA%`, `%USERPROFILE%`, …) are
UNVERIFIED — check each harness's own docs on first connect.

MCP stdio line adapted for a native-Windows harness (shape from
`docs/PROVIDERS.md:15-17`; Windows path + `deno` resolution UNVERIFIED):

```powershell
deno run --allow-run --allow-read --allow-write --allow-env --allow-net --config C:\path\to\muse-code-gui\relay\deno.json C:\path\to\muse-code-gui\relay\src\mcp-stdio.ts
```

If the harness runs inside WSL2 instead, use the Unix line verbatim
with the WSL2 clone path.

## 8. Transcribe/ingest engines on Windows

Env overrides (verified in `relay/src/config.ts:98-102` and
`docs/TRANSCRIBE.md:25-47`): `WHISPER_BIN` (default `whisper`),
`WHISPER_MODEL` (default `turbo`), `FFMPEG_BIN` (default `ffmpeg`),
`PDFTOTEXT_BIN` (default `pdftotext`, optional), `unzip` (no override;
optional, enables epub). The relay invokes
`whisper <wav> --model … --language … --output_format json --output_dir …
--fp16 False --verbose False` and `ffmpeg -y -v error -i … -ar 16000
-ac 1 -c:a pcm_s16le …` (`relay/src/transcribe.ts:253-259`); it derives
`ffprobe` from the ffmpeg path by string replacement
(`transcribe.ts:198-199`), so keep `ffmpeg`/`ffprobe` side by side.

Topology A installs them inside WSL2 (Ubuntu):

```bash
# UNVERIFIED: standard Ubuntu package/pip installs, not executed here
sudo apt install ffmpeg poppler-utils unzip python3-pip
pip install openai-whisper
```

Diarization: the default helper is the Unix script
`relay/scripts/sherpa/diarize` (auto-detected when executable;
`docs/TRANSCRIBE.md:35-41`). Under topology A it runs in WSL2; for a
native-Windows relay set `DIARIZE_HELPER=off` for single-speaker
fallback (`SPEAKER_00`, `diarization:"none"`) — verified semantics in
`docs/TRANSCRIBE.md:37-41` and `relay/src/config.ts:57-67`.

## 9. Troubleshooting

| Symptom | Cause / fix (sources inline) |
|---|---|
| `muse binary not found (set MUSE_BIN)` | Relay (native Windows) cannot see the WSL2 launcher. Run the relay inside WSL2 (§4A) or set `MUSE_BIN` to a shim (UNVERIFIED). Error text: `relay/src/config.ts:52`. |
| Launcher dies with `unsupported platform` in Git Bash | Expected: `detect_platform` accepts only Darwin/Linux (`~/.local/bin/muse`). Use WSL2, not Git Bash, for `muse`. |
| Token works in one shell, empty in another | PowerShell `$env:X` is process-scoped; bash `export` is shell-scoped. See §2 persistence. (Shell mechanics, UNVERIFIED here.) |
| Health shows `billing:"api_key"` | `META_API_KEY` or `MUSE_API_TOKEN` is set in the relay's environment (`relay/src/config.ts:73-77`). Unset it; subscription login must be the only credential. `muse login --help` confirms `META_API_KEY` takes priority (verified). |
| `muse` found in WSL2 but relay says "not found" | `whichBin` splits `PATH` on `:` and also probes `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` (`relay/src/config.ts:19-46`). On native Windows `PATH` uses `;`, so PATH-search is unreliable there — set explicit `MUSE_BIN`/`WHISPER_BIN`/`FFMPEG_BIN`. (Unix separators verified in code; Windows breakage inferred, UNVERIFIED at runtime.) |
| `workspace outside MUSE_GUI_WORKSPACES allowlist` | `MUSE_GUI_WORKSPACES` splits on `:` (`config.ts:90-104`), which collides with Windows drive letters (`C:\…`). Prefer WSL2-style paths for workspaces on Windows, or leave the allowlist unset (allow-all, `relay/src/server.ts:26-31`). |
| GUI connects locally but phone/Expo can't reach relay | Phone needs the host's LAN IP, not `127.0.0.1`; relay may need `RELAY_ALLOW_REMOTE=1` (topology B). |
| SmartScreen warning on installer | Expected until the Windows signing cert lands (`README.md:148`). |
| `deno task start` prints a token you didn't set | Normal: no `RELAY_TOKEN`/`MUSE_GUI_RELAY_TOKEN` in env, so a one-time token was generated (`config.ts:84-89`). Copy it into the app's Settings. |
| Backslash vs slash confusion | PowerShell accepts both for most commands; Git Bash needs `/` or escaped `\\`. Quote paths with spaces in both. (Shell mechanics, UNVERIFIED here.) |
