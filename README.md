<!-- Improved compatibility of back to top link: See: https://github.com/othneildrew/Best-README-Template/pull/73 -->
<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->
[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]

<!-- PROJECT LOGO -->
<br />
<div align="center">

  <h3 align="center">muse-code-gui</h3>

  <p align="center">
    Graphical frontends for Muse Code that run on your subscription — Windows, macOS, iOS, Android.
    <br />
    <a href="https://github.com/aminamos/muse-code-gui/tree/main/docs"><strong>Explore the docs »</strong></a>
    <br />
    <br />
    <a href="https://github.com/aminamos/muse-code-gui/issues/new?labels=bug">Report Bug</a>
    &middot;
    <a href="https://github.com/aminamos/muse-code-gui/issues/new?labels=enhancement">Request Feature</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li>
      <a href="#about-the-project">About The Project</a>
      <ul>
        <li><a href="#built-with">Built With</a></li>
      </ul>
    </li>
    <li>
      <a href="#getting-started">Getting Started</a>
      <ul>
        <li><a href="#prerequisites">Prerequisites</a></li>
        <li><a href="#installation">Installation</a></li>
      </ul>
    </li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#contact">Contact</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
    <li><a href="#for-ai-agents">For AI Agents</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->
## About The Project

Four GUI apps plus one relay server. Every run executes through `muse` on the
relay host, inheriting its subscription login — no API key exists anywhere in
the system.

* **Apps:** Expo + TypeScript for iOS/Android (remote-relay-only), Tauri v2 +
  React + Vite for Windows/macOS (localhost relay default).
* **Relay:** one Deno server — the only exec/transcribe engine. Exec over SSE,
  transcription with speaker diarization, RSS podcast flow, document ingest
  (txt/md/epub/pdf), MCP tools, and an OpenAI-compatible provider endpoint.
* Every harness option (OMP, OpenCode, Claude Code, Codex, Command Code) talks
  to the same relay, so spend always lands on the subscription.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

* [![Deno][Deno.com]][Deno-url]
* [![React][React.js]][React-url]
* [![Expo][Expo.dev]][Expo-url]
* [![Tauri][Tauri.app]][Tauri-url]
* [![TypeScript][TypeScript.org]][TypeScript-url]
* [![Vite][Vite.dev]][Vite-url]

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- GETTING STARTED -->
## Getting Started

To get a local copy up and running, start the relay, then open any app.

### Prerequisites

* Deno 2+
* Node.js 20+
* `muse` CLI, signed in (`muse login` — subscription, no API key)
* Rust stable (Tauri desktop shells only)
* Xcode or EAS cloud builds (mobile installers only)

### Installation

1. Clone the repo
   ```sh
   git clone https://github.com/aminamos/muse-code-gui.git
   cd muse-code-gui
   ```
2. Generate a relay token and export it (any random string)
   ```sh
   export MUSE_GUI_RELAY_TOKEN="$(openssl rand -hex 32)"
   ```
3. Start the relay
   ```sh
   cd relay && deno task start
   ```
   Without a token a one-time token is generated and printed. Confirm
   `GET http://127.0.0.1:8787/api/health` returns `ok:true` and
   `billing:"subscription"`.
4. Install an app (example: macOS)
   ```sh
   cd ../apps/macos && npm install
   ```
   Desktop apps default to the localhost relay; mobile apps point at the
   relay over LAN/Tailscale plus the token from step 2.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- USAGE EXAMPLES -->
## Usage

* **Run a prompt:** open any app, enter the relay URL + token in Settings,
  type a prompt, Run. Output streams; Stop aborts the turn.
* **Transcribe:** the Transcribe view takes an audio/video URL, podcast RSS
  feed + episode index, relay-local path, or (desktop) file upload, and
  returns `[mm:ss.mmm SPEAKER] text` segments.
* **Ingest documents:** `POST /api/ingest` with txt/md/epub/pdf for plain text.
* **From another agent:** add the relay as an MCP server (stdio, no token) or
  as an OpenAI-compatible provider (`/v1`, token by env name). See below.

_Full references: [docs/PROVIDERS.md](docs/PROVIDERS.md) (per-harness entries),
[docs/TRANSCRIBE.md](docs/TRANSCRIBE.md) (transcription),
[docs/SDK.md](docs/SDK.md) (engine + fallback),
[docs/EXEC-CONTRACT.md](docs/EXEC-CONTRACT.md) (frozen wire contract),
[docs/WINDOWS.md](docs/WINDOWS.md) + [docs/WINDOWS-TEST.md](docs/WINDOWS-TEST.md) (Windows setup and test plan)._

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ROADMAP -->
## Roadmap

- [x] Four apps: Expo iOS/Android, Tauri Windows/macOS
- [x] Relay: exec, transcribe + diarization, ingest, MCP, provider endpoint
- [x] SDK engine primary with `muse exec` fallback
- [x] Harness providers: OMP, OpenCode, Claude Code, Codex, Command Code
- [ ] Signed installers (Apple side unblocked; Windows needs a cert)
- [ ] EAS / TestFlight submission
- [ ] Per-harness installer repos (`muse-opencode`, `muse-omp`, …)

See the [open issues](https://github.com/aminamos/muse-code-gui/issues) for a full list of proposed features (and known issues).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTRIBUTING -->
## Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

If you have a suggestion that would make this better, please fork the repo and create a pull request. You can also simply open an issue with the tag "enhancement".
Don't forget to give the project a star! Thanks again!

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

Verify before pushing — relay suite must be green:

```sh
cd relay && deno task check && deno task test
```

Per-app checks (from the repo root, one line per app):

```sh
cd apps/ios && npm install && npx tsc --noEmit && npm run smoke
cd ../android && npm install && npx tsc --noEmit && npm run smoke
cd ../windows && npm install && npx tsc --noEmit && npm run build && npm run smoke && (cd src-tauri && cargo check)
cd ../macos && npm install && npx tsc --noEmit && npm run build && npm run smoke && (cd src-tauri && cargo check)
```

### Top contributors:

<a href="https://github.com/aminamos/muse-code-gui/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=aminamos/muse-code-gui" alt="contrib.rocks image" />
</a>

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTACT -->
## Contact

Project Link: [https://github.com/aminamos/muse-code-gui](https://github.com/aminamos/muse-code-gui)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ACKNOWLEDGMENTS -->
## Acknowledgments

* [Best-README-Template](https://github.com/othneildrew/Best-README-Template) — this file's structure
* [@muse-code/sdk](https://meta-models.github.io/muse-code-sdk) — typed MSP client
* [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) — offline diarization
* [pyannote.audio](https://github.com/pyannote/pyannote-audio) — reference diarizer
* [OpenAI Whisper](https://github.com/openai/whisper) — transcription fallback
* [Expo](https://expo.dev) and [Tauri](https://v2.tauri.app) — app shells
* [Deno](https://deno.com) — relay runtime

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- FOR AI AGENTS -->
## For AI Agents

Give your agent this repo link plus everything below the line.

---

Set up muse-code-gui (Muse subscription only — no API credits):

1. Clone https://github.com/aminamos/muse-code-gui and open `relay/`.
2. Confirm prerequisites: Deno 2+, Node 20+, and `muse --version` runs.
   Login is proven at step 8 — a credential error there means `muse login`
   is missing, so stop and tell the user to sign in.
3. Generate a relay token and export it as `MUSE_GUI_RELAY_TOKEN`
   (the relay also accepts it as `RELAY_TOKEN`).
4. Start the relay: `MUSE_GUI_RELAY_TOKEN=<token> deno task start`
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
   token by env NAME `MUSE_GUI_RELAY_TOKEN` (never paste the value).
   The relay must be running for provider calls.
8. Prove it: one tiny turn ("say hi") through the new provider, or the
   harness's provider/MCP list command. Report what was spent.
9. Details: `docs/PROVIDERS.md` (per-harness entries), `docs/SDK.md`
   (engine + fallback), `docs/TRANSCRIBE.md` (transcription).

---

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->
[contributors-shield]: https://img.shields.io/github/contributors/aminamos/muse-code-gui.svg?style=for-the-badge
[contributors-url]: https://github.com/aminamos/muse-code-gui/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/aminamos/muse-code-gui.svg?style=for-the-badge
[forks-url]: https://github.com/aminamos/muse-code-gui/network/members
[stars-shield]: https://img.shields.io/github/stars/aminamos/muse-code-gui.svg?style=for-the-badge
[stars-url]: https://github.com/aminamos/muse-code-gui/stargazers
[issues-shield]: https://img.shields.io/github/issues/aminamos/muse-code-gui.svg?style=for-the-badge
[issues-url]: https://github.com/aminamos/muse-code-gui/issues
[Deno.com]: https://img.shields.io/badge/Deno-000000?style=for-the-badge&logo=deno&logoColor=white
[Deno-url]: https://deno.com/
[React.js]: https://img.shields.io/badge/React-20232A?style=for-the-badge&logo=react&logoColor=61DAFB
[React-url]: https://reactjs.org/
[Expo.dev]: https://img.shields.io/badge/Expo-000020?style=for-the-badge&logo=expo&logoColor=white
[Expo-url]: https://expo.dev/
[Tauri.app]: https://img.shields.io/badge/Tauri-FFC131?style=for-the-badge&logo=tauri&logoColor=black
[Tauri-url]: https://v2.tauri.app/
[TypeScript.org]: https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white
[TypeScript-url]: https://www.typescriptlang.org/
[Vite.dev]: https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white
[Vite-url]: https://vite.dev/
