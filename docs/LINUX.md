# Linux setup — muse-code-gui

Target: run the relay (and optionally Expo dev) on Debian/Ubuntu or
Fedora. Companion docs: [PROVIDERS.md](PROVIDERS.md),
[TRANSCRIBE.md](TRANSCRIBE.md), [SDK.md](SDK.md),
[EXEC-CONTRACT.md](EXEC-CONTRACT.md). Windows-specific notes live in
[WINDOWS.md](WINDOWS.md).

> Command provenance: every repo-derived command, path, and env name
> below was read from this repo (see the per-section "Source" notes) or
> from a local binary's `--help`. Distro installer commands (apt, dnf,
> install scripts) could not be executed from the Mac used to write this
> guide and are marked UNVERIFIED where they appear.

## 0. Prerequisites (from README)

`README.md` ("Prerequisites") requires: Deno 2+, Node.js 20+,
`muse` CLI signed in (`muse login` — subscription, no API key),
Rust stable (Tauri shells only), Xcode or EAS cloud builds
(mobile installers only).

There is **no Linux Tauri shell** in this repo: `apps/` contains
`ios`, `android`, `windows`, `macos` only (verified by listing
`apps/*/package.json`). On Linux you run the relay headless (GUI via a
Mac/Windows desktop app or a phone over LAN, or Expo web).

Source: `README.md:87-93`; app list from repo directory listing.

## 1. Install the toolchain

### 1a. Debian / Ubuntu (apt)

```bash
# UNVERIFIED: standard distro/vendor installs, not executed here
sudo apt update && sudo apt install -y curl git unzip ffmpeg poppler-utils python3-pip

# Node 20+ via NodeSource (or your preferred manager) — UNVERIFIED
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Deno 2+ — UNVERIFIED: vendor installer, not executed here
curl -fsSL https://deno.land/install.sh | sh

# Rust stable (only needed if you hack on the Tauri shells) — UNVERIFIED
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### 1b. Fedora (dnf)

```bash
# UNVERIFIED: standard distro/vendor installs, not executed here
sudo dnf install -y curl git unzip ffmpeg poppler-utils python3-pip nodejs

# Deno 2+ — UNVERIFIED: vendor installer, not executed here
curl -fsSL https://deno.land/install.sh | sh

# Rust stable (Tauri-shell hacking only) — UNVERIFIED
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Fedora note: if the distro `nodejs` is older than 20, use NodeSource or
nvm instead (README floor is Node 20+). Version-manager availability is
vendor-documented, UNVERIFIED here.

Confirm (floors from `README.md:87-93`):

```bash
deno --version   # want 2.x (repo runs Deno 2.9.6)
node --version   # want 20+
```

## 2. Clone the repo and set the relay token

```bash
git clone https://github.com/aminamos/muse-code-gui.git
cd muse-code-gui
export MUSE_GUI_RELAY_TOKEN="$(openssl rand -hex 32)"
```

Token rules (verified in `relay/src/config.ts:82-89`): `RELAY_TOKEN`
wins if both are set; `MUSE_GUI_RELAY_TOKEN` lets all harnesses share one
name. Without either, the relay generates a one-time token and prints it
(`README.md:110`). Persist with
`echo 'export MUSE_GUI_RELAY_TOKEN="<hex>"' >> ~/.bashrc`
(shell mechanics, UNVERIFIED here).

## 3. `muse` on Linux (native — no WSL needed)

The `muse` launcher is a bash script whose `detect_platform` maps
`Linux:aarch64 → aarch64_linux` and `Linux:x86_64 → x86_linux`
(source: `~/.local/bin/muse:105-113`, read on the Mac used to write
this). Both desktop Linux arches are first-class.

```bash
# Install the launcher — PARTLY VERIFIED: the URL is the launcher's own
# MUSE_LAUNCHER_URL default (read from the script); the install flow
# itself was not executed here.
mkdir -p ~/.local/bin
curl -fsSL https://api.meta.ai/muse-launcher.sh -o ~/.local/bin/muse
chmod +x ~/.local/bin/muse
export PATH="$HOME/.local/bin:$PATH"

muse --version   # e.g. "Muse Code 1.2.1 (...)" (verified on Mac)
muse login       # browser device-code approval; see `muse login --help`
```

`muse login --help` (verified locally): login is a browser device-code
approval and `META_API_KEY` always takes priority — which is why the
relay warns and reports `billing:"api_key"` when `META_API_KEY` or
`MUSE_API_TOKEN` is set (`relay/src/config.ts:73-77`).

Launcher-side knobs (read from the script header; they tune the
launcher, not the relay): `MUSE_LAUNCHER_URL`, `MUSE_CHANNEL_URL`
(default `https://api.meta.ai/muse-code/channels/muse-stable`),
`MUSE_AUTH_URL`, `MUSE_AUTH_PATH` (default
`$XDG_CONFIG_HOME/muse/auth.json` else `~/.config/muse/auth.json`).
There is no `MUSE_LAUNCHER` variable in the relay: the name appears
nowhere in `relay/src`, `docs`, or `apps` (searched 2026-09-13).

### MUSE_BIN wiring (verified in repo)

`relay/src/config.ts:48-55`: `MUSE_BIN`, else `muse` on `PATH`, else
throw `"muse binary not found (set MUSE_BIN)"`. The default search also
probes `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`
(`config.ts:19-46`) — on Linux the `~/.local/bin/muse` fallback covers
the §3 install even without a `PATH` edit. To pin:
`export MUSE_BIN="$HOME/.local/bin/muse"`.

## 4. Start and verify the relay

```bash
cd relay && MUSE_GUI_RELAY_TOKEN=<token> deno task start
```

Task source: `relay/deno.json` — `start` runs
`deno run --allow-net --allow-run --allow-read --allow-write --allow-env
src/server.ts` (read in repo). Other tasks: `start-remote` (adds
`--allow-remote`), `mcp-stdio`, `check`, `test`, `test-unit`.

```bash
curl http://127.0.0.1:8787/api/health
```

Expect `ok:true`, `billing:"subscription"`, plus `museBin`/
`museVersion` and the `transcribe`/`ingest` capability blocks
(`relay/src/server.ts:33-48`, `docs/TRANSCRIBE.md:22-23`).

Full verification (the repo's own gates, `README.md:170-183`):

```bash
cd relay && deno task check && deno task test
```

Expo smoke checks from the repo root (scripts verified in
`apps/*/package.json`):

```bash
cd apps/ios && npm install && npx tsc --noEmit && npm run smoke
cd ../android && npm install && npx tsc --noEmit && npm run smoke
```

## 5. Serving GUI clients over LAN

Desktop (macOS/Windows) and mobile apps all accept a relay URL + token
in Settings. Defaults (verified): desktop defaults to localhost
(`DEFAULT_RELAY_URL = "http://127.0.0.1:8787"`,
`apps/windows/src/lib/relay.ts:12-13`); iOS/Android are
remote-relay-only with no localhost default
(`apps/ios/src/settings.ts:4`, `docs/EXEC-CONTRACT.md:50-51`).

To serve LAN clients, bind all interfaces (verified in
`relay/src/config.ts:80-81` — either form):

```bash
RELAY_ALLOW_REMOTE=1 MUSE_GUI_RELAY_TOKEN=<token> deno task start
# or equivalently:
MUSE_GUI_RELAY_TOKEN=<token> deno task start-remote
```

`bindHost` becomes `0.0.0.0` (default port `8787` via `RELAY_PORT`,
`config.ts:93`). Clients then use `http://<linux-lan-ip>:8787` + token.
Firewall (UNVERIFIED): open 8787/tcp for the LAN as appropriate, e.g.
`sudo ufw allow from 192.168.0.0/16 to any port 8787`
(Ubuntu `ufw` example, not executed here) or the equivalent
`firewalld` rule on Fedora.

## 6. Optional: systemd user unit for the relay

UNVERIFIED — authored for this guide, not executed here. It encodes
only verified repo facts (working directory `relay/`, `deno task
start`, env names from `relay/src/config.ts`):

```ini
# ~/.config/systemd/user/muse-relay.service
[Unit]
Description=muse-code-gui relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/development/muse-code-gui/relay
Environment=MUSE_GUI_RELAY_TOKEN=<paste-token>
Environment=MUSE_BIN=%h/.local/bin/muse
# Uncomment to serve LAN clients (RELAY_ALLOW_REMOTE, config.ts:80-81):
# Environment=RELAY_ALLOW_REMOTE=1
ExecStart=%h/.deno/bin/deno task start
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
# UNVERIFIED: not executed here
systemctl --user daemon-reload
systemctl --user enable --now muse-relay
systemctl --user status muse-relay
curl http://127.0.0.1:8787/api/health
```

Notes: `~/.deno/bin/deno` is the vendor installer's default location
(UNVERIFIED — confirm with `command -v deno` and adjust `ExecStart`);
`deno task` resolves `deno.json` from the working directory
(`deno task --help`, verified locally). Keep the token out of shell
history by writing the unit file with an editor rather than `echo`.

## 7. Transcribe/ingest engines (incl. CUDA-less whisper)

Env overrides (verified in `relay/src/config.ts:98-102` and
`docs/TRANSCRIBE.md:25-47`): `WHISPER_BIN` (default `whisper`),
`WHISPER_MODEL` (default `turbo`), `FFMPEG_BIN` (default `ffmpeg`),
`PDFTOTEXT_BIN` (default `pdftotext`, optional), `unzip` (no override;
optional, enables epub). §1 already installs `ffmpeg`,
`poppler-utils` (`pdftotext`), and `unzip`:

```bash
# UNVERIFIED: standard pip install, not executed here
pip install openai-whisper
```

CUDA-less note (verified in repo): the relay invokes
`whisper <wav> --model … --language … --output_format json --output_dir
… --fp16 False --verbose False` (`relay/src/transcribe.ts:259`) — it
forces `--fp16 False`, and the local `whisper --help` (verified)
confirms `--fp16`/`--device`/`--model` flags exist, so CPU-only boxes
work; expect slower-than-GPU turns on large models. `WHISPER_MODEL`
default is `turbo` (`config.ts:99`); the Mac caches large-v3-turbo
weights (`docs/TRANSCRIBE.md:28-29`) — on a fresh Linux box the first
run downloads weights (HuggingFace/network behavior, UNVERIFIED here).

Decode path (verified): `ffmpeg -y -v error -i … -ar 16000 -ac 1 -c:a
pcm_s16le …` (`transcribe.ts:253`); `ffprobe` is derived from the
ffmpeg path by string replacement (`transcribe.ts:198-199`), so keep
the two side by side.

Diarization: default helper `relay/scripts/sherpa/diarize`
(auto-detected when executable; models `relay/models/sherpa/`, venv
`relay/.venv-sherpa/`); `DIARIZE_HELPER` overrides the path and
`DIARIZE_HELPER=off` forces single-speaker fallback (`SPEAKER_00`,
`diarization:"none"`) — all verified in `docs/TRANSCRIBE.md:35-41` and
`relay/src/config.ts:57-67`. The pyannote alternative
(`relay/scripts/pyannote/diarize.py` + `SETUP.md`) needs HF-gated
weights and a user token (`docs/TRANSCRIBE.md:45-47`).

## 8. Expo / EAS from Linux

```bash
cd apps/android   # or apps/ios
npm install
npx tsc --noEmit
npm run smoke    # node scripts/smoke.js (package.json, verified)
npm start        # expo start — dev server + QR
```

Scripts source: `apps/ios/package.json`, `apps/android/package.json`
(`start`/`android`/`ios`/`web`/`smoke`, all `expo …` except smoke).
Point the app at `http://<linux-lan-ip>:8787` + token (mobile is
remote-relay-only, §5).

Cloud builds (EAS) — commands UNVERIFIED here; profiles verified in
repo (`apps/android/eas.json`, `apps/ios/eas.json`, CLI `>= 16.0.0`):

```bash
# UNVERIFIED: not executed here
npm install -g eas-cli
eas login
eas build -p android --profile preview   # internal apk
eas build -p ios --profile preview       # internal, device (simulator=false)
```

Repo facts: Android `development`/`preview` are internal APKs,
`production` is an app-bundle; iOS `development` targets simulator,
`preview` device-internal, `production` store with a `submit.production`
block. Package: `com.musecode.gui.android` (`apps/android/app.json:10`).
"EAS / TestFlight submission" is still a roadmap TODO (`README.md:149`).
Native iOS builds need Xcode/macOS (`README.md:93`) — EAS cloud builds
are the Linux path.

## 9. Harness provider paths on Linux

The Unix config paths in `docs/PROVIDERS.md` apply directly on Linux
(verified in that doc): OMP `~/.omp/agent/` (provider id `mcg-relay`,
model `mcg-relay/muse-code` — NOT `muse-code`, per the v18.1.19
reservation note), OpenCode `~/.config/opencode/opencode.jsonc`,
Codex `~/.codex/config.toml` (`[mcp_servers.muse-code]`), Command Code
`~/.commandcode/`; Claude via `claude mcp add muse-code -s user -- …`.

MCP stdio line (verbatim from `docs/PROVIDERS.md:15-17`):

```bash
deno run --allow-run --allow-read --allow-write --allow-env --allow-net --config <repo>/relay/deno.json <repo>/relay/src/mcp-stdio.ts
```

Provider entries point at `http://127.0.0.1:8787/v1` (or the LAN URL
from §5), model `muse-code`, referencing the token by env NAME
`MUSE_GUI_RELAY_TOKEN` — never pasted (`docs/PROVIDERS.md:18-20`).
The relay must be running for provider calls. Prove each new entry with
a tiny `say hi` turn, per `docs/PROVIDERS.md:57-62` and the README
agent checklist (`README.md:242-243`).

## 10. Troubleshooting

| Symptom | Cause / fix (sources inline) |
|---|---|
| `muse binary not found (set MUSE_BIN)` | `~/.local/bin` not on `PATH` (the relay probes it as a fallback, `config.ts:19-46`, so this is rare) or launcher not installed (§3). Set `MUSE_BIN=$HOME/.local/bin/muse`. Error text: `config.ts:52`. |
| Health shows `billing:"api_key"` | `META_API_KEY`/`MUSE_API_TOKEN` set in relay env (`config.ts:73-77`). Unset; subscription login must be the only credential. |
| LAN clients can't connect | Relay bound to `127.0.0.1` (default) — use §5 `RELAY_ALLOW_REMOTE=1`; check host firewall (UNVERIFIED rules). |
| First transcription downloads weights / is slow | Expected on a fresh box: no cached weights (cf. `docs/TRANSCRIBE.md:28-29`); CPU-only is supported via forced `--fp16 False` (`transcribe.ts:259`). |
| `workspace outside MUSE_GUI_WORKSPACES allowlist` | `MUSE_GUI_WORKSPACES` is `:`-separated (`config.ts:90-104`); unset means allow-all (`server.ts:26-31`). |
| `deno task start` prints an unexpected token | Normal one-time generation when no token env is set (`config.ts:84-89`). Copy it into client Settings. |
| systemd unit fails with `deno: command not found` | `ExecStart` path wrong — use the absolute path from `command -v deno`. (Unit UNVERIFIED, §6.) |
