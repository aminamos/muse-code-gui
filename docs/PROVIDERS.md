# muse-code providers (subscription login, no API credits)

Every harness below talks to the relay, which runs `muse` on its host
under `muse login`. No provider entry carries Muse API material; spend
lands on the subscription. If `META_API_KEY` or `MUSE_API_TOKEN` is set
in the relay's environment it prints a startup warning and reports
`billing:"api_key"` on `/api/health` (stored `muse auth set`
credentials are invisible to that check).

## Relay contract (harness-facing)

- Provider endpoint: `POST http://127.0.0.1:8787/v1/chat/completions`
  (OpenAI shape; `GET /v1/models` lists `muse-code`). Auth: relay
  Bearer token. `user` field = managed-session continuity key.
- MCP stdio (no daemon, no token):
  `deno run --allow-run --allow-read --allow-write --allow-env --allow-net
  --config <repo>/relay/deno.json <repo>/relay/src/mcp-stdio.ts`
- Relay must be running for provider + HTTP use:
  `MUSE_UI_RELAY_TOKEN=<token> deno task start` (cwd `relay/`).
  Harnesses reference the token by env NAME, never by value.

## OMP (`~/.omp/agent/`)

- Provider id is `mcu-relay`, NOT `muse-code`: OMP v18.1.19 reserves
  `muse-code` for native Muse auth and fails closed with "Muse Code
  credential is invalid" without calling the relay (verified via
  binary strings + renamed-provider success). Model: `mcu-relay/muse-code`.
- Entry in `models.yml` (`openai-completions`, baseUrl relay `/v1`,
  apiKey `MUSE_UI_RELAY_TOKEN`, authHeader). MCP entry in `mcp.json`.
- Verified: `omp models mcu-relay` lists it; live `say hi` turn exit 0.

## OpenCode (`~/.config/opencode/opencode.jsonc`)

- Provider `muse-code` (`@ai-sdk/openai-compatible`, relay `/v1`,
  apiKey `{env:MUSE_UI_RELAY_TOKEN}`), model `muse-code/muse-code`.
  MCP `muse-code` local stdio entry (shape per opencode.ai/config.json).
- Verified: parse OK, `opencode debug config` resolves both,
  `opencode mcp list` CONNECTED, live `say hi` turn exit 0 ("Hi!").

## Claude Code + Codex (MCP-only; fixed model lists)

- Claude: `claude mcp add muse-code -s user -- <stdio command>`.
  `claude mcp list/get` show Connected.
- Codex: `[mcp_servers.muse-code]` stdio entry in `~/.codex/config.toml`
  (+ backup). `codex mcp list/get` show enabled/stdio.
- No live turns run here (relay MCP already proven live elsewhere).

## Adding another harness ("etc")

MCP stdio works anywhere a harness accepts a command-based server
(same deno line, no token). A model-provider entry needs
OpenAI-compat baseURL + Bearer token fields pointed at the relay's
`/v1` with `MUSE_UI_RELAY_TOKEN`, plus a live `say hi` to prove it.
