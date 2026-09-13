#!/usr/bin/env bash
# muse-code-gui harness installer (bash/zsh, incl. Windows Git Bash).
#
# Writes muse-code MCP (+ OpenAI-provider where supported) entries for every
# detected harness, pointed at this repo's relay. Idempotent: existing
# entries are left untouched. Every touched file is backed up first.
#
#   Usage: install.sh [--repo <path>] [--harness <name>[,<name>...]]
#                     [--dry-run] [--help]
#
#   --repo     repo root (default: parent dir of this script)
#   --harness  limit scope: omp, opencode, claude, codex, cmd (repeatable)
#   --dry-run  print planned writes + parse-validate snippets; change nothing
#
# Never modifies shell rc files; prints the exact export line for your shell.
# Config entries reference the token by env NAME only, never by value.
# No live model turns (zero spend).

set -u

VERSION="0.1.0"
TOKEN_ENV="MUSE_GUI_RELAY_TOKEN"
MCP_NAME="muse-code"
OMP_PROVIDER_ID="mcg-relay" # OMP reserves "muse-code" for native Muse auth
RELAY_BASE_URL="http://127.0.0.1:8787/v1"
RELAY_PORT="8787"

REPO=""
DRY_RUN=0
HARNESS_FILTER=""

say()  { printf '%s\n' "$*"; }
warn() { printf 'note: %s\n' "$*" >&2; }
die()  { printf 'error: %s\n' "$*" >&2; exit "${2:-1}"; }

usage() {
  sed -n '2,20p' "$0"
  say ""
  say "Harness configs touched (only when that harness is detected):"
  say "  omp      ~/.omp/agent/models.yml + mcp.json"
  say "  opencode <config>/opencode/opencode.json[c]"
  say "  claude   ~/.claude.json (mcpServers)"
  say "  codex    ~/.codex/config.toml"
  say "  cmd      ~/.commandcode/providers.json + mcp.json"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)     REPO="${2:-}"; shift 2 ;;
    --repo=*)   REPO="${1#--repo=}"; shift ;;
    --harness)  HARNESS_FILTER="${HARNESS_FILTER:+$HARNESS_FILTER,}${2:-}"; shift 2 ;;
    --harness=*) HARNESS_FILTER="${HARNESS_FILTER:+$HARNESS_FILTER,}${1#--harness=}"; shift ;;
    --dry-run)  DRY_RUN=1; shift ;;
    -h|--help)  usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" 2 ;;
  esac
done

if [ -n "$HARNESS_FILTER" ]; then
  case ",$HARNESS_FILTER," in
    *,,*) die "--harness got an empty value (want omp, opencode, claude, codex, cmd)" 2 ;;
  esac
fi
# Validate filter names.
if [ -n "$HARNESS_FILTER" ]; then
  OLDIFS="$IFS"; IFS=","
  for h in $HARNESS_FILTER; do
    case "$h" in
      omp|opencode|claude|codex|cmd) ;;
      *) die "unknown harness: $h (want omp, opencode, claude, codex, cmd)" 2 ;;
    esac
  done
  IFS="$OLDIFS"
fi
wanted() { # wanted <name>: true when no filter or name in filter
  [ -z "$HARNESS_FILTER" ] && return 0
  case ",$HARNESS_FILTER," in *,"$1",*) return 0;; *) return 1;; esac
}

# --- repo root ---------------------------------------------------------------
if [ -z "$REPO" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  REPO="$(cd "$SCRIPT_DIR/.." && pwd)"
else
  REPO="$(cd "$REPO" 2>/dev/null && pwd)" || die "--repo not found: $REPO"
fi
[ -f "$REPO/relay/deno.json" ] && [ -f "$REPO/relay/src/mcp-stdio.ts" ] \
  || die "not a muse-code-gui repo root: $REPO (missing relay/deno.json or relay/src/mcp-stdio.ts)"

# --- OS + shell detection ----------------------------------------------------
OS="unknown"
case "$(uname -s)" in
  Darwin*) OS="macos" ;;
  Linux*)  OS="linux" ;;
  MINGW*|MSYS*|CYGWIN*) OS="windows-gitbash" ;;
esac
ON_WINDOWS=0; [ "$OS" = "windows-gitbash" ] && ON_WINDOWS=1

CURRENT_SHELL="sh"
if [ -n "${ZSH_VERSION:-}" ]; then CURRENT_SHELL="zsh";
elif [ -n "${BASH_VERSION:-}" ]; then CURRENT_SHELL="bash";
elif [ -n "${FISH_VERSION:-}" ]; then CURRENT_SHELL="fish";
else
  case "${SHELL:-}" in *fish) CURRENT_SHELL="fish";; *zsh) CURRENT_SHELL="zsh";;
    *bash) CURRENT_SHELL="bash";; esac
fi

# Absolute stdio paths, forward slashes (valid in JSON/TOML on every OS).
RELAY_DENO_JSON="$REPO/relay/deno.json"
RELAY_MCP_STDIO="$REPO/relay/src/mcp-stdio.ts"
if [ "$ON_WINDOWS" = 1 ] && command -v cygpath >/dev/null 2>&1; then
  RELAY_DENO_JSON="$(cygpath -m "$RELAY_DENO_JSON")"
  RELAY_MCP_STDIO="$(cygpath -m "$RELAY_MCP_STDIO")"
fi

DENO_ABS=""
if command -v deno >/dev/null 2>&1; then
  DENO_ABS="$(command -v deno)"
  if [ "$ON_WINDOWS" = 1 ] && command -v cygpath >/dev/null 2>&1; then
    DENO_ABS="$(cygpath -m "$DENO_ABS")"
  fi
fi
[ -n "$DENO_ABS" ] || DENO_ABS="deno" # PATH fallback, resolved at harness runtime

# --- prerequisite checks (pointers, never auto-install) ----------------------
say "muse-code-gui harness installer v$VERSION (os=$OS shell=$CURRENT_SHELL repo=$REPO)"
say ""
say "== prerequisites =="
if command -v deno >/dev/null 2>&1; then
  say "  deno:  $(command -v deno) ($(deno --version 2>/dev/null | head -n1))"
else
  say "  deno:  MISSING (required: MCP stdio runs on deno)"
  case "$OS" in
    macos)   say "         install: brew install deno  # or: curl -fsSL https://deno.land/install.sh | sh" ;;
    linux)   say "         install: curl -fsSL https://deno.land/install.sh | sh" ;;
    *)       say "         install (Git Bash): winget install DenoLand.Deno  # or: irm https://deno.land/install.ps1 | iex" ;;
  esac
fi
if command -v node >/dev/null 2>&1; then
  say "  node:  $(command -v node) ($(node --version 2>/dev/null))"
else
  say "  node:  MISSING (recommended: some harnesses need it)"
  case "$OS" in
    macos)   say "         install: brew install node" ;;
    linux)   say "         install: https://nodejs.org/en/download" ;;
    *)       say "         install (Git Bash): winget install OpenJS.NodeJS" ;;
  esac
fi
if command -v muse >/dev/null 2>&1; then
  say "  muse:  $(command -v muse)"
  say "         (run 'muse login' on the relay host so spend lands on the subscription)"
else
  say "  muse:  MISSING (required on the relay host; harnesses shell out to it via the relay)"
fi
if command -v python3 >/dev/null 2>&1; then
  say "  python3: $(command -v python3) (used for JSON merge + validation)"
else
  say "  python3: MISSING — JSON harness entries will be printed for manual paste instead of written"
  case "$OS" in
    macos)   say "         install: brew install python" ;;
    linux)   say "         install: apt/dnf install python3 (or pyenv)" ;;
    *)       say "         install (Git Bash): winget install Python.Python.3" ;;
  esac
fi
say ""

# --- token: reuse env or generate; never stored, never in configs ------------
TOKEN_VALUE="(reuse-env)"
TOKEN_SOURCE="existing environment"
if [ -z "${MUSE_GUI_RELAY_TOKEN:-}" ]; then
  if [ "$DRY_RUN" = 1 ]; then
    TOKEN_VALUE="<generated-at-install-time>"
    TOKEN_SOURCE="generated (dry-run placeholder)"
  elif command -v openssl >/dev/null 2>&1; then
    TOKEN_VALUE="$(openssl rand -hex 32)"
    TOKEN_SOURCE="generated via openssl"
  elif [ -r /dev/urandom ] && command -v od >/dev/null 2>&1; then
    TOKEN_VALUE="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
    TOKEN_SOURCE="generated via /dev/urandom"
  elif command -v python3 >/dev/null 2>&1; then
    TOKEN_VALUE="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
    TOKEN_SOURCE="generated via python3"
  else
    die "cannot generate $TOKEN_ENV: need openssl, /dev/urandom+od, or python3"
  fi
fi

say "== relay token =="
if [ "$TOKEN_VALUE" = "(reuse-env)" ]; then
  say "  $TOKEN_ENV is already set in this environment — reusing it (value not shown)."
else
  say "  $TOKEN_ENV $TOKEN_SOURCE."
  say "  Save this line (shown once; the installer never stores it, rc files untouched):"
  case "$CURRENT_SHELL" in
    fish) say "    set -Ux $TOKEN_ENV \"$TOKEN_VALUE\"" ;;
    *)    say "    export $TOKEN_ENV=\"$TOKEN_VALUE\"" ;;
  esac
  [ "$CURRENT_SHELL" = "fish" ] || say "  (fish users: set -Ux $TOKEN_ENV \"<token>\")"
fi
say "  Start the relay with:  $TOKEN_ENV=<token> deno task start   (cwd: $REPO/relay)"
say ""

# --- helpers -----------------------------------------------------------------
backup_file() { # backup_file <path>: copy to <path>.bak-mcu-<timestamp>
  if [ "$DRY_RUN" = 1 ]; then
    say "    backup: $1 -> $1.bak-mcu-<timestamp> (planned)"
    return 0
  fi
  local ts; ts="$(date +%Y%m%d-%H%M%S)"
  cp -p "$1" "$1.bak-mcu-$ts" || die "backup failed for $1"
  say "    backup: $1.bak-mcu-$ts"
}

have_bin() { command -v "$1" >/dev/null 2>&1; }

# Config locations (Windows %APPDATA% equivalents included).
APPDATA_DIR="${APPDATA:-$HOME/AppData/Roaming}"
OMP_DIR="$HOME/.omp/agent"
CLAUDE_JSON="$HOME/.claude.json"
CODEX_TOML="$HOME/.codex/config.toml"
CMD_DIR="$HOME/.commandcode"
OPENCODE_JSON=""
for cand in \
  "$HOME/.config/opencode/opencode.jsonc" \
  "$HOME/.config/opencode/opencode.json" \
  "$APPDATA_DIR/opencode/opencode.jsonc" \
  "$APPDATA_DIR/opencode/opencode.json" ; do
  if [ -f "$cand" ]; then OPENCODE_JSON="$cand"; break; fi
done
if [ -z "$OPENCODE_JSON" ]; then
  if [ "$ON_WINDOWS" = 1 ]; then OPENCODE_JSON="$APPDATA_DIR/opencode/opencode.json";
  else OPENCODE_JSON="$HOME/.config/opencode/opencode.json"; fi
fi

# json_has <file> <key1> <key2>: exit 0 when the key path already exists.
# (Plain-JSON probe; on JSONC/parse failure exits 1 so callers back up first.)
json_has() {
  have_bin python3 || return 1
  KEY1="$2" KEY2="$3" python3 -c '
import json, os, sys
try:
    doc = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
k1, k2 = os.environ["KEY1"], os.environ.get("KEY2")
ok = isinstance(doc.get(k1), dict) and (not k2 or k2 in doc[k1])
sys.exit(0 if ok else 1)
' "$1" 2>/dev/null
}

# --- JSON worker (python3): merge one key, or print+validate in dry-run ------
# Args: <file> <create-skeleton-json> <key1> [<key2>] <value-json>
# Key path is 1-2 levels (enough for all harnesses here). JSONC comments in
# the existing file are tolerated for READING (string-aware strip); a file we
# must rewrite is written back as plain JSON (noted in output).
json_merge() {
  local file="$1" skeleton="$2" key1="$3"
  local key2="" value
  if [ "$#" = 5 ]; then key2="$4"; value="$5"; else value="$4"; fi
  if ! have_bin python3; then
    say "    SKIP (no python3): would ensure [$key1${key2:+.$key2}] in $file"
    say "    manual snippet to paste:"
    printf '%s\n' "$value" | sed 's/^/      /'
    return 0
  fi
  SKELETON="$skeleton" KEY1="$key1" KEY2="$key2" VALUE_JSON="$value" \
  DRY_RUN="$DRY_RUN" TARGET="$file" python3 - <<'PYEOF'
import json, os, sys

target = os.environ["TARGET"]
skeleton = json.loads(os.environ["SKELETON"])
key1 = os.environ["KEY1"]
key2 = os.environ.get("KEY2") or None
value = json.loads(os.environ["VALUE_JSON"])
dry = os.environ.get("DRY_RUN") == "1"

def strip_jsonc(text):
    out, i, n = [], 0, len(text)
    s = None  # active string quote char
    while i < n:
        c = text[i]
        if s:
            out.append(c)
            if c == "\\":
                i += 1
                if i < n: out.append(text[i])
            elif c == s:
                s = None
            i += 1
            continue
        if c == '"':  # JSON strings only; a ' never opens one
            s = c
            out.append(c); i += 1
            continue
        if c == "/" and i + 1 < n and text[i+1] == "/":
            while i < n and text[i] != "\n": i += 1
            continue
        if c == "/" and i + 1 < n and text[i+1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i+1] == "/"): i += 1
            i += 2
            continue
        out.append(c); i += 1
    return "".join(out)

existed = os.path.isfile(target)
try:
    doc = json.loads(strip_jsonc(open(target, encoding="utf-8").read())) if existed else dict(skeleton)
except Exception as e:
    print(f"    SKIP: {target} does not parse as JSON ({e}); fix it manually and re-run")
    sys.exit(0)
if not isinstance(doc, dict):
    print(f"    SKIP: {target} has a non-object root; fix it manually and re-run")
    sys.exit(0)

node = doc.setdefault(key1, {})
if key2:
    if not isinstance(node, dict):
        print(f"    SKIP: {target} [{key1}] is not an object; fix it manually and re-run")
        sys.exit(0)
    cur = node.get(key2)
    if isinstance(cur, dict):
        print(f"    exists: [{key1}.{key2}] already present in {target} — untouched")
        sys.exit(0)
else:
    cur = doc.get(key1)
    if isinstance(cur, dict) and key1 not in skeleton:
        print(f"    exists: [{key1}] already present in {target} — untouched")
        sys.exit(0)

snippet = json.dumps(value, indent=2)
# Validate: merged doc must serialize + reparse.
merged = json.loads(json.dumps(doc))
if key2: merged[key1][key2] = value
else: merged[key1] = value
json.loads(json.dumps(merged))
if dry:
    print(f"    planned: {'create' if not existed else 'merge'} [{key1}{('.'+key2) if key2 else ''}] in {target}")
    print("    snippet (valid JSON, parses OK):")
    print("\n".join("      " + ln for ln in snippet.splitlines()))
    print("    merged doc re-parses OK")
else:
    if existed:
        print(f"    merge: [{key1}{('.'+key2) if key2 else ''}] into {target}")
    else:
        os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
        print(f"    create: {target}")
    if key2: doc[key1][key2] = value
    else: doc[key1] = value
    open(target, "w", encoding="utf-8").write(json.dumps(doc, indent=2) + "\n")
    print(f"    wrote: {target} (re-parsed OK)")
PYEOF
}

# --- YAML/TOML textual writers (idempotent append) ---------------------------
validate_toml() { # validate_toml <file>: parse-check, best effort
  if have_bin python3 && python3 -c 'import tomllib' 2>/dev/null; then
    python3 -c 'import tomllib,sys; tomllib.load(open(sys.argv[1],"rb"))' "$1" \
      && say "    TOML parses OK: $1" \
      || say "    WARNING: $1 does not parse as TOML — inspect before use"
  else
    say "    TOML parse-check skipped (need python3.11+ with tomllib)"
  fi
}

validate_yaml() { # validate_yaml <file>: parse-check, best effort
  if have_bin python3 && python3 -c 'import yaml' 2>/dev/null; then
    python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' "$1" \
      && say "    YAML parses OK: $1" \
      || say "    WARNING: $1 does not parse as YAML — inspect before use"
  elif have_bin ruby && ruby -ryaml -e '' 2>/dev/null; then
    ruby -ryaml -e 'YAML.load_file(ARGV[0])' "$1" >/dev/null 2>&1 \
      && say "    YAML parses OK: $1" \
      || say "    WARNING: $1 does not parse as YAML — inspect before use"
  else
    # Structural fallback: root key present + block indent consistent.
    if grep -q '^providers:' "$1" 2>/dev/null \
       && grep -q "^  $OMP_PROVIDER_ID:" "$1" 2>/dev/null; then
      say "    YAML structural check OK (providers: + 2-space $OMP_PROVIDER_ID:); full parse unavailable (no pyyaml/ruby)"
    else
      say "    YAML check inconclusive (no pyyaml/ruby) — OMP will validate on next run"
    fi
  fi
}

# OMP provider block (models.yml), per docs/PROVIDERS.md + live config shape.
omp_models_block() {
  cat <<EOF
  $OMP_PROVIDER_ID:
    baseUrl: $RELAY_BASE_URL
    apiKey: $TOKEN_ENV
    authHeader: true
    api: openai-completions
    discovery:
      type: openai-models-list
    compat:
      maxTokensField: max_tokens
      supportsStore: false
      supportsDeveloperRole: false
      supportsReasoningEffort: false
    models:
    - id: $MCP_NAME
      name: Muse Code via relay (subscription login)
      reasoning: false
      input:
      - text
EOF
}

write_omp_models() {
  local f="$OMP_DIR/models.yml"
  say "  [$f]"
  if grep -q "^  $OMP_PROVIDER_ID:" "$f" 2>/dev/null; then
    say "    exists: provider $OMP_PROVIDER_ID already present — untouched"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "    planned: append provider $OMP_PROVIDER_ID"
    if [ -f "$f" ]; then
      local tmp; tmp="$(mktemp)"
      cp -p "$f" "$tmp"
      [ -n "$(tail -c1 "$tmp")" ] && printf '\n' >> "$tmp"
      omp_models_block >> "$tmp"
      say "    snippet (block to append):"
      omp_models_block | sed 's/^/      /'
      # validate merged temp copy
      if have_bin python3 && python3 -c 'import yaml' 2>/dev/null; then
        python3 -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' "$tmp" \
          && say "    merged YAML parses OK" \
          || say "    WARNING: merged YAML does not parse — inspect before use"
      else
        say "    merged YAML structural check only (no pyyaml/ruby on PATH)"
      fi
      rm -f "$tmp"
    else
      say "    (models.yml missing — would create with providers: root + block)"
      say "    snippet (block to append):"
      omp_models_block | sed 's/^/      /'
    fi
    return 0
  fi
  if [ -f "$f" ]; then backup_file "$f"
  else mkdir -p "$OMP_DIR"; printf 'providers:\n' > "$f"; say "    create: $f"; fi
  [ -n "$(tail -c1 "$f")" ] && printf '\n' >> "$f"
  omp_models_block >> "$f"
  say "    appended provider $OMP_PROVIDER_ID"
  validate_yaml "$f"
}

# Codex TOML block, per live ~/.codex/config.toml shape.
codex_toml_block() {
  cat <<EOF
[mcp_servers.$MCP_NAME]
command = "$DENO_ABS"
args = ["run", "--allow-run", "--allow-read", "--allow-write", "--allow-env", "--allow-net", "--config", "$RELAY_DENO_JSON", "$RELAY_MCP_STDIO"]
startup_timeout_sec = 30.0
EOF
}

write_codex_toml() {
  local f="$CODEX_TOML"
  say "  [$f]"
  if grep -q "^\[mcp_servers\.$MCP_NAME\]" "$f" 2>/dev/null; then
    say "    exists: [mcp_servers.$MCP_NAME] already present — untouched"
    return 0
  fi
  if [ "$DRY_RUN" = 1 ]; then
    say "    planned: append [mcp_servers.$MCP_NAME]"
    say "    snippet (valid TOML block):"
    codex_toml_block | sed 's/^/      /'
    if have_bin python3 && python3 -c 'import tomllib' 2>/dev/null; then
      local tmp; tmp="$(mktemp)"
      { [ -f "$f" ] && cat "$f"; codex_toml_block; } > "$tmp"
      python3 -c 'import tomllib,sys; tomllib.load(open(sys.argv[1],"rb"))' "$tmp" \
        && say "    merged TOML parses OK" \
        || say "    WARNING: merged TOML does not parse — inspect before use"
      rm -f "$tmp"
    else
      say "    TOML parse-check skipped (need python3.11+ with tomllib)"
    fi
    return 0
  fi
  if [ -f "$f" ]; then backup_file "$f"
  else mkdir -p "$(dirname "$f")"; say "    create: $f"; fi
  [ -f "$f" ] && [ -n "$(tail -c1 "$f" 2>/dev/null)" ] && printf '\n' >> "$f"
  codex_toml_block >> "$f"
  say "    appended [mcp_servers.$MCP_NAME]"
  validate_toml "$f"
}

# --- per-harness installers --------------------------------------------------
STDIO_ARGS_JSON="\"run\", \"--allow-run\", \"--allow-read\", \"--allow-write\", \"--allow-env\", \"--allow-net\", \"--config\", \"$RELAY_DENO_JSON\", \"$RELAY_MCP_STDIO\""

do_omp() {
  say "== harness: omp =="
  if ! have_bin omp && [ ! -d "$OMP_DIR" ]; then
    say "  SKIP: omp not detected (no 'omp' on PATH, no $OMP_DIR)"; return 0
  fi
  write_omp_models
  local f="$OMP_DIR/mcp.json"
  say "  [$f]"
  if [ -f "$f" ] && [ "$DRY_RUN" = 0 ] && ! json_has "$f" "mcpServers" "$MCP_NAME"; then
    backup_file "$f"
  fi
  json_merge "$f" '{"mcpServers":{}}' "mcpServers" "$MCP_NAME" \
    "{\"command\": \"deno\", \"args\": [$STDIO_ARGS_JSON]}"
}

do_opencode() {
  say "== harness: opencode =="
  if ! have_bin opencode && [ ! -f "$OPENCODE_JSON" ]; then
    say "  SKIP: opencode not detected (no 'opencode' on PATH, no $OPENCODE_JSON)"; return 0
  fi
  local f="$OPENCODE_JSON"
  say "  [$f]"
  if [ -f "$f" ] && [ "$DRY_RUN" = 0 ] \
     && ! { json_has "$f" "provider" "$MCP_NAME" && json_has "$f" "mcp" "$MCP_NAME"; }; then
    backup_file "$f"
  fi
  json_merge "$f" '{"provider":{},"mcp":{}}' "provider" "$MCP_NAME" \
    "{\"npm\": \"@ai-sdk/openai-compatible\", \"name\": \"Muse Code (subscription)\", \"options\": {\"baseURL\": \"$RELAY_BASE_URL\", \"apiKey\": \"{env:$TOKEN_ENV}\"}, \"models\": {\"$MCP_NAME\": {\"name\": \"Muse Code\"}}}"
  json_merge "$f" '{"provider":{},"mcp":{}}' "mcp" "$MCP_NAME" \
    "{\"type\": \"local\", \"command\": [\"deno\", $STDIO_ARGS_JSON]}"
  [ -f "$f" ] && [[ "$f" == *.jsonc ]] && [ "$DRY_RUN" = 0 ] \
    && say "    note: $f rewritten as plain JSON (JSONC comments not preserved)"
}

do_claude() {
  say "== harness: claude (MCP-only; fixed model list) =="
  if ! have_bin claude && [ ! -f "$CLAUDE_JSON" ]; then
    say "  SKIP: claude not detected (no 'claude' on PATH, no $CLAUDE_JSON)"; return 0
  fi
  local f="$CLAUDE_JSON"
  say "  [$f]"
  if [ -f "$f" ] && [ "$DRY_RUN" = 0 ] && ! json_has "$f" "mcpServers" "$MCP_NAME"; then
    backup_file "$f"
  fi
  json_merge "$f" '{"mcpServers":{}}' "mcpServers" "$MCP_NAME" \
    "{\"type\": \"stdio\", \"command\": \"$DENO_ABS\", \"args\": [$STDIO_ARGS_JSON], \"env\": {}}"
}

do_codex() {
  say "== harness: codex (MCP-only; fixed model list) =="
  if ! have_bin codex && [ ! -d "$HOME/.codex" ]; then
    say "  SKIP: codex not detected (no 'codex' on PATH, no $HOME/.codex)"; return 0
  fi
  write_codex_toml
}

do_cmd() {
  say "== harness: cmd (Command Code) =="
  if ! have_bin cmd && [ ! -d "$CMD_DIR" ]; then
    say "  SKIP: cmd not detected (no 'cmd' on PATH, no $CMD_DIR)"; return 0
  fi
  local pf="$CMD_DIR/providers.json" mf="$CMD_DIR/mcp.json"
  say "  [$pf]"
  if [ -f "$pf" ] && [ "$DRY_RUN" = 0 ] && ! json_has "$pf" "provider" "$MCP_NAME"; then
    backup_file "$pf"
  fi
  json_merge "$pf" '{"provider":{}}' "provider" "$MCP_NAME" \
    "{\"name\": \"Muse Code\", \"baseURL\": \"$RELAY_BASE_URL\", \"apiKey\": \"\$$TOKEN_ENV\", \"models\": {\"$MCP_NAME\": {}}}"
  say "  [$mf]"
  if [ -f "$mf" ] && [ "$DRY_RUN" = 0 ] && ! json_has "$mf" "mcpServers" "$MCP_NAME"; then
    backup_file "$mf"
  fi
  json_merge "$mf" '{"mcpServers":{}}' "mcpServers" "$MCP_NAME" \
    "{\"transport\": \"stdio\", \"enabled\": true, \"command\": \"$DENO_ABS\", \"args\": [$STDIO_ARGS_JSON]}"
}

# --- main --------------------------------------------------------------------
wanted omp      && do_omp
wanted opencode && do_opencode
wanted claude   && do_claude
wanted codex    && do_codex
wanted cmd      && do_cmd

say ""
if [ "$DRY_RUN" = 1 ]; then
  say "dry-run complete: nothing was written. Re-run without --dry-run to apply."
else
  say "done. Verify with, e.g.:"
  say "  omp models mcg-relay | head            # provider listed"
  say "  opencode mcp list 2>/dev/null | head   # muse-code CONNECTED"
  say "  claude mcp list 2>/dev/null | head     # muse-code Connected"
  say "  codex mcp list 2>/dev/null | head      # muse-code enabled"
  say "  cmd mcp list 2>/dev/null | head        # muse-code enabled"
  say "Then start the relay:  $TOKEN_ENV=<token> deno task start   (cwd: $REPO/relay)"
fi

