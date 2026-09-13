<# muse-code-gui harness installer (PowerShell 5.1+/7, macOS/Linux/Windows).

Writes muse-code MCP (+ OpenAI-provider where supported) entries for every
detected harness, pointed at this repo's relay. Idempotent: existing
entries are left untouched. Every touched file is backed up first.

  Usage: .\install.ps1 [-Repo <path>] [-Harness <name>[,<name>...]] [-DryRun]

Never modifies shell rc/profile files; prints exact export lines.
Config entries reference the token by env NAME only, never by value.
No live model turns (zero spend).
#>
[CmdletBinding()]
param(
  [string]$Repo = "",
  [string[]]$Harness = @(),
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$Version      = "0.1.0"
$TokenEnv     = "MUSE_GUI_RELAY_TOKEN"
$McpName      = "muse-code"
$OmpProvider  = "mcg-relay" # OMP reserves "muse-code" for native Muse auth
$RelayBaseUrl = "http://127.0.0.1:8787/v1"
$ValidHarness = @("omp", "opencode", "claude", "codex", "cmd")

foreach ($h in $Harness) {
  if ($ValidHarness -notcontains $h) { throw "unknown harness: $h (want: $($ValidHarness -join ', '))" }
}
function Wanted([string]$Name) {
  if ($Harness.Count -eq 0) { return $true }
  return $Harness -contains $Name
}
function Say([string]$Msg) { Write-Output $Msg }

# --- repo root ---------------------------------------------------------------
if ([string]::IsNullOrWhiteSpace($Repo)) {
  $Repo = Split-Path -Parent $PSScriptRoot
}
$Repo = (Resolve-Path $Repo).Path
if (-not (Test-Path (Join-Path $Repo "relay/deno.json")) -and
    (Test-Path (Join-Path $Repo "relay/src/mcp-stdio.ts"))) {
  throw "not a muse-code-gui repo root: $Repo (missing relay/deno.json or relay/src/mcp-stdio.ts)"
}

# --- OS detection (5.1 has no $IsWindows; 5.1 is effectively Windows-only) ---
$OS = "windows"
if (Test-Path variable:global:IsWindows) {
  if ($IsMacOS) { $OS = "macos" } elseif ($IsLinux) { $OS = "linux" }
  else { $OS = "windows" }
} elseif ($env:OS -ne "Windows_NT" -and (Get-Variable -Name HOME -ErrorAction SilentlyContinue)) {
  $OS = "unix" # non-Windows PowerShell without automatic vars; treat as unix
}
$OnWindows = ($OS -eq "windows")
$HomeDir = if (Get-Variable -Name HOME -ErrorAction SilentlyContinue) { $HOME } else { $env:USERPROFILE }

# Absolute stdio paths, forward slashes (valid in JSON/TOML on every OS).
$RelayDenoJson = ((Join-Path $Repo "relay/deno.json") -replace "\\", "/")
$RelayMcpStdio = ((Join-Path $Repo "relay/src/mcp-stdio.ts") -replace "\\", "/")

$DenoCmd = Get-Command deno -ErrorAction SilentlyContinue
$DenoAbs = if ($DenoCmd) { ($DenoCmd.Source -replace "\\", "/") } else { "deno" }

function Have([string]$Name) { return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue) }

# --- prerequisites (pointers, never auto-install) ----------------------------
Say "muse-code-gui harness installer v$Version (os=$OS repo=$Repo)"
Say ""
Say "== prerequisites =="
if (Have "deno") { Say ("  deno:  " + (Get-Command deno).Source) }
else {
  Say "  deno:  MISSING (required: MCP stdio runs on deno)"
  if ($OnWindows) { Say "         install: winget install DenoLand.Deno  # or: irm https://deno.land/install.ps1 | iex" }
  elseif ($OS -eq "macos") { Say "         install: brew install deno" }
  else { Say "         install: curl -fsSL https://deno.land/install.sh | sh" }
}
if (Have "node") { Say ("  node:  " + (Get-Command node).Source + " (" + (node --version) + ")") }
else {
  Say "  node:  MISSING (recommended: some harnesses need it)"
  if ($OnWindows) { Say "         install: winget install OpenJS.NodeJS" }
  elseif ($OS -eq "macos") { Say "         install: brew install node" }
  else { Say "         install: https://nodejs.org/en/download" }
}
if (Have "muse") {
  Say ("  muse:  " + (Get-Command muse).Source)
  Say "         (run 'muse login' on the relay host so spend lands on the subscription)"
} else {
  Say "  muse:  MISSING (required on the relay host; harnesses reach it via the relay)"
}
Say ""

# --- token: reuse env or generate; never stored, never in configs ------------
$TokenValue = "(reuse-env)"
$TokenSource = "existing environment"
if ([string]::IsNullOrEmpty($env:MUSE_GUI_RELAY_TOKEN)) {
  if ($DryRun) { $TokenValue = "<generated-at-install-time>"; $TokenSource = "generated (dry-run placeholder)" }
  else {
    $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $Bytes = New-Object byte[] 32
    $Rng.GetBytes($Bytes)
    $Rng.Dispose()
    $TokenValue = -join ($Bytes | ForEach-Object { $_.ToString("x2") })
    $TokenSource = "generated via RNGCryptoServiceProvider"
  }
}
Say "== relay token =="
if ($TokenValue -eq "(reuse-env)") {
  Say "  $TokenEnv is already set in this environment — reusing it (value not shown)."
} else {
  Say "  $TokenEnv $TokenSource."
  Say "  Save one of these lines (shown once; the installer never stores it):"
  Say "    `$env:$TokenEnv = `"$TokenValue`""
  Say "    export $TokenEnv=`"$TokenValue`"   # bash/zsh/Git Bash"
  Say "    set -Ux $TokenEnv `"$TokenValue`"  # fish"
}
Say "  Start the relay with:  $TokenEnv=<token> deno task start   (cwd: $Repo/relay)"
Say ""

# --- helpers -----------------------------------------------------------------
function Backup-File([string]$Path) {
  if ($DryRun) { Say "    backup: $Path -> $Path.bak-mcu-<timestamp> (planned)"; return }
  $Ts = Get-Date -Format "yyyyMMdd-HHmmss"
  Copy-Item -Path $Path -Destination "$Path.bak-mcu-$Ts" -Force
  Say "    backup: $Path.bak-mcu-$Ts"
}

function Strip-Jsonc([string]$Text) {
  # String-aware removal of // and /* */ comments (JSON " strings only).
  $Sb = New-Object System.Text.StringBuilder
  $InStr = $false; $Esc = $false; $i = 0
  while ($i -lt $Text.Length) {
    $c = $Text[$i]
    if ($InStr) {
      [void]$Sb.Append($c)
      if ($Esc) { $Esc = $false }
      elseif ($c -eq "\") { $Esc = $true }
      elseif ($c -eq '"') { $InStr = $false }
      $i++; continue
    }
    if ($c -eq '"') { $InStr = $true; [void]$Sb.Append($c); $i++; continue }
    if ($c -eq "/" -and $i + 1 -lt $Text.Length -and $Text[$i+1] -eq "/") {
      while ($i -lt $Text.Length -and $Text[$i] -ne "`n") { $i++ }
      continue
    }
    if ($c -eq "/" -and $i + 1 -lt $Text.Length -and $Text[$i+1] -eq "*") {
      $i += 2
      while ($i + 1 -lt $Text.Length -and -not ($Text[$i] -eq "*" -and $Text[$i+1] -eq "/")) { $i++ }
      $i += 2; continue
    }
    [void]$Sb.Append($c); $i++
  }
  return $Sb.ToString()
}

function Test-JsonHas([string]$File, [string]$Key1, [string]$Key2) {
  # True when the key path already exists (so callers can skip a pointless backup).
  if (-not (Test-Path $File)) { return $false }
  try { $Doc = Strip-Jsonc ([IO.File]::ReadAllText($File)) | ConvertFrom-Json }
  catch { return $false }
  return ($null -ne $Doc.$Key1 -and $null -ne $Doc.$Key1.$Key2)
}

function Merge-JsonKey([string]$File, [string]$SkeletonJson, [string]$Key1, [string]$Key2, [string]$ValueJson) {
  $Value = $ValueJson | ConvertFrom-Json
  $Existed = Test-Path $File
  if ($Existed) {
    try { $Doc = Strip-Jsonc ([IO.File]::ReadAllText($File)) | ConvertFrom-Json }
    catch { Say "    SKIP: $File does not parse as JSON; fix it manually and re-run"; return }
  } else {
    $Doc = $SkeletonJson | ConvertFrom-Json
  }
  if ($null -eq $Doc.$Key1) { $Doc | Add-Member -NotePropertyName $Key1 -NotePropertyValue ([pscustomobject]@{}) }
  if ($Doc.$Key1 -isnot [pscustomobject]) {
    Say "    SKIP: $File [$Key1] is not an object; fix it manually and re-run"; return
  }
  if ($null -ne $Doc.$Key1.$Key2) {
    Say "    exists: [$Key1.$Key2] already present in $File — untouched"; return
  }
  $Snippet = $Value | ConvertTo-Json -Depth 20
  # Validate: merged doc must serialize + reparse.
  $Doc.$Key1 | Add-Member -NotePropertyName $Key2 -NotePropertyValue $Value
  try { ($Doc | ConvertTo-Json -Depth 20) | ConvertFrom-Json | Out-Null }
  catch { Say "    SKIP: merged doc fails re-parse for $File — leaving untouched"; return }
  if ($DryRun) {
    if ($Existed) { Say "    planned: merge [$Key1.$Key2] in $File" }
    else { Say "    planned: create $File with [$Key1.$Key2]" }
    Say "    snippet (valid JSON, parses OK):"
    ($Snippet -split "`n") | ForEach-Object { Say ("      " + $_) }
    Say "    merged doc re-parses OK"
  } else {
    if (-not $Existed) {
      $Dir = Split-Path -Parent $File
      if ($Dir -and -not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }
      Say "    create: $File"
    } else { Say "    merge: [$Key1.$Key2] into $File" }
    [IO.File]::WriteAllText($File, (($Doc | ConvertTo-Json -Depth 20) + "`n"))
    Say "    wrote: $File (re-parsed OK)"
  }
}

# --- config locations (Windows %APPDATA% equivalents included) ----------------
$AppDataDir = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $HomeDir "AppData/Roaming" }
$OmpDir     = Join-Path $HomeDir ".omp/agent"
$ClaudeJson = Join-Path $HomeDir ".claude.json"
$CodexToml   = Join-Path $HomeDir ".codex/config.toml"
$CmdDir      = Join-Path $HomeDir ".commandcode"
$OpencodeCandidates = @(
  (Join-Path $HomeDir ".config/opencode/opencode.jsonc"),
  (Join-Path $HomeDir ".config/opencode/opencode.json"),
  (Join-Path $AppDataDir "opencode/opencode.jsonc"),
  (Join-Path $AppDataDir "opencode/opencode.json")
)
$OpencodeJson = $OpencodeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $OpencodeJson) {
  if ($OnWindows) { $OpencodeJson = Join-Path $AppDataDir "opencode/opencode.json" }
  else { $OpencodeJson = Join-Path $HomeDir ".config/opencode/opencode.json" }
}

# --- stdio args (shared shapes) ------------------------------------------------
$StdioArgs = @("run", "--allow-run", "--allow-read", "--allow-write", "--allow-env", "--allow-net",
  "--config", $RelayDenoJson, $RelayMcpStdio)
$StdioArgsJson = ($StdioArgs | ForEach-Object { '"' + $_ + '"' }) -join ", "

# --- YAML/TOML writers ---------------------------------------------------------
function Get-OmpModelsBlock {
  return @"
  ${OmpProvider}:
    baseUrl: $RelayBaseUrl
    apiKey: $TokenEnv
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
    - id: $McpName
      name: Muse Code via relay (subscription login)
      reasoning: false
      input:
      - text
"@
}

function Test-Yaml([string]$File) {
  $Py = Get-Command python3 -ErrorAction SilentlyContinue
  if (-not $Py) { $Py = Get-Command python -ErrorAction SilentlyContinue }
  if ($Py) {
    & $Py.Source -c 'import yaml,sys; yaml.safe_load(open(sys.argv[1]))' $File 2>$null
    if ($LASTEXITCODE -eq 0) { Say "    YAML parses OK: $File"; return }
    # pyyaml itself may be missing (import error) vs real parse error; fall through
  }
  $Text = [IO.File]::ReadAllText($File)
  if ($Text -match "(?m)^providers:" -and $Text -match "(?m)^  $([regex]::Escape($OmpProvider)):") {
    Say "    YAML structural check OK (providers: + 2-space ${OmpProvider}:); full parse unavailable (no pyyaml)"
  } else {
    Say "    YAML check inconclusive (no pyyaml) — OMP will validate on next run"
  }
}

function Test-Toml([string]$File) {
  $Py = Get-Command python3 -ErrorAction SilentlyContinue
  if (-not $Py) { $Py = Get-Command python -ErrorAction SilentlyContinue }
  if ($Py) {
    & $Py.Source -c 'import tomllib,sys; tomllib.load(open(sys.argv[1],"rb"))' $File 2>$null
    if ($LASTEXITCODE -eq 0) { Say "    TOML parses OK: $File"; return }
    Say "    TOML parse-check unavailable/failed (need python3.11+ with tomllib) — inspect before use"
  } else {
    Say "    TOML parse-check skipped (no python on PATH)"
  }
}

function Write-OmpModels {
  $F = Join-Path $OmpDir "models.yml"
  Say "  [$F]"
  if ((Test-Path $F) -and ([IO.File]::ReadAllText($F) -match "(?m)^  $([regex]::Escape($OmpProvider)):")) {
    Say "    exists: provider $OmpProvider already present — untouched"; return
  }
  $Block = Get-OmpModelsBlock
  if ($DryRun) {
    Say "    planned: append provider $OmpProvider"
    if (-not (Test-Path $F)) { Say "    (models.yml missing — would create with providers: root + block)" }
    Say "    snippet (block to append):"
    ($Block.Trim() -split "`n") | ForEach-Object { Say ("      " + $_) }
    if (Test-Path $F) {
      $Tmp = [IO.Path]::GetTempFileName()
      $Orig = [IO.File]::ReadAllText($F)
      if (-not $Orig.EndsWith("`n")) { $Orig += "`n" }
      [IO.File]::WriteAllText($Tmp, $Orig + $Block)
      Test-Yaml $Tmp
      Remove-Item $Tmp -Force
    } else { Say "    merged YAML structural check only (file would be created fresh)" }
    return
  }
  if (Test-Path $F) { Backup-File $F }
  else {
    if (-not (Test-Path $OmpDir)) { New-Item -ItemType Directory -Path $OmpDir -Force | Out-Null }
    [IO.File]::WriteAllText($F, "providers:`n")
    Say "    create: $F"
  }
  $Orig = [IO.File]::ReadAllText($F)
  if (-not $Orig.EndsWith("`n")) { $Orig += "`n" }
  [IO.File]::WriteAllText($F, $Orig + $Block)
  Say "    appended provider $OmpProvider"
  Test-Yaml $F
}

function Get-CodexTomlBlock {
  return @"
[mcp_servers.$McpName]
command = "$DenoAbs"
args = [$StdioArgsJson]
startup_timeout_sec = 30.0
"@
}

function Write-CodexToml {
  $F = $CodexToml
  Say "  [$F]"
  if ((Test-Path $F) -and ([IO.File]::ReadAllText($F) -match "(?m)^\[mcp_servers\.$([regex]::Escape($McpName))\]")) {
    Say "    exists: [mcp_servers.$McpName] already present — untouched"; return
  }
  $Block = Get-CodexTomlBlock
  if ($DryRun) {
    Say "    planned: append [mcp_servers.$McpName]"
    Say "    snippet (valid TOML block):"
    ($Block.Trim() -split "`n") | ForEach-Object { Say ("      " + $_) }
    $Tmp = [IO.Path]::GetTempFileName()
    $Orig = if (Test-Path $F) { [IO.File]::ReadAllText($F) } else { "" }
    if ($Orig -and -not $Orig.EndsWith("`n")) { $Orig += "`n" }
    [IO.File]::WriteAllText($Tmp, $Orig + $Block)
    Test-Toml $Tmp
    Remove-Item $Tmp -Force
    return
  }
  if (Test-Path $F) { Backup-File $F }
  else {
    $Dir = Split-Path -Parent $F
    if ($Dir -and -not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }
    Say "    create: $F"
  }
  $Orig = if (Test-Path $F) { [IO.File]::ReadAllText($F) } else { "" }
  if ($Orig -and -not $Orig.EndsWith("`n")) { $Orig += "`n" }
  [IO.File]::WriteAllText($F, $Orig + $Block)
  Say "    appended [mcp_servers.$McpName]"
  Test-Toml $F
}

# --- per-harness installers ------------------------------------------------------
function Do-Omp {
  Say "== harness: omp =="
  if (-not ((Have "omp") -or (Test-Path $OmpDir))) {
    Say "  SKIP: omp not detected (no 'omp' on PATH, no $OmpDir)"; return
  }
  Write-OmpModels
  $F = Join-Path $OmpDir "mcp.json"
  Say "  [$F]"
  if ((Test-Path $F) -and -not $DryRun -and -not (Test-JsonHas $F "mcpServers" $McpName)) { Backup-File $F }
  Merge-JsonKey $F '{"mcpServers":{}}' "mcpServers" $McpName `
    "{`"command`": `"deno`", `"args`": [$StdioArgsJson]}"
}

function Do-Opencode {
  Say "== harness: opencode =="
  if (-not ((Have "opencode") -or (Test-Path $OpencodeJson))) {
    Say "  SKIP: opencode not detected (no 'opencode' on PATH, no $OpencodeJson)"; return
  }
  $F = $OpencodeJson
  Say "  [$F]"
  if ((Test-Path $F) -and -not $DryRun -and -not ((Test-JsonHas $F "provider" $McpName) -and (Test-JsonHas $F "mcp" $McpName))) { Backup-File $F }
  Merge-JsonKey $F '{"provider":{},"mcp":{}}' "provider" $McpName `
    "{`"npm`": `"@ai-sdk/openai-compatible`", `"name`": `"Muse Code (subscription)`", `"options`": {`"baseURL`": `"$RelayBaseUrl`", `"apiKey`": `"{env:$TokenEnv}`"}, `"models`": {`"$McpName`": {`"name`": `"Muse Code`"}}}"
  Merge-JsonKey $F '{"provider":{},"mcp":{}}' "mcp" $McpName `
    "{`"type`": `"local`", `"command`": [`"deno`", $StdioArgsJson]}"
  if ((Test-Path $F) -and $F.EndsWith(".jsonc") -and -not $DryRun) {
    Say "    note: $F rewritten as plain JSON (JSONC comments not preserved)"
  }
}

function Do-Claude {
  Say "== harness: claude (MCP-only; fixed model list) =="
  if (-not ((Have "claude") -or (Test-Path $ClaudeJson))) {
    Say "  SKIP: claude not detected (no 'claude' on PATH, no $ClaudeJson)"; return
  }
  $F = $ClaudeJson
  Say "  [$F]"
  if ((Test-Path $F) -and -not $DryRun -and -not (Test-JsonHas $F "mcpServers" $McpName)) { Backup-File $F }
  Merge-JsonKey $F '{"mcpServers":{}}' "mcpServers" $McpName `
    "{`"type`": `"stdio`", `"command`": `"$DenoAbs`", `"args`": [$StdioArgsJson], `"env`": {}}"
}

function Do-Codex {
  Say "== harness: codex (MCP-only; fixed model list) =="
  if (-not ((Have "codex") -or (Test-Path (Join-Path $HomeDir ".codex")))) {
    Say ("  SKIP: codex not detected (no 'codex' on PATH, no " + (Join-Path $HomeDir ".codex") + ")"); return
  }
  Write-CodexToml
}

function Do-Cmd {
  Say "== harness: cmd (Command Code) =="
  if (-not ((Have "cmd") -or (Test-Path $CmdDir))) {
    Say "  SKIP: cmd not detected (no 'cmd' on PATH, no $CmdDir)"; return
  }
  $Pf = Join-Path $CmdDir "providers.json"
  $Mf = Join-Path $CmdDir "mcp.json"
  Say "  [$Pf]"
  if ((Test-Path $Pf) -and -not $DryRun -and -not (Test-JsonHas $Pf "provider" $McpName)) { Backup-File $Pf }
  Merge-JsonKey $Pf '{"provider":{}}' "provider" $McpName `
    "{`"name`": `"Muse Code`", `"baseURL`": `"$RelayBaseUrl`", `"apiKey`": `"`$($TokenEnv)`", `"models`": {`"$McpName`": {}}}"
  Say "  [$Mf]"
  if ((Test-Path $Mf) -and -not $DryRun -and -not (Test-JsonHas $Mf "mcpServers" $McpName)) { Backup-File $Mf }
  Merge-JsonKey $Mf '{"mcpServers":{}}' "mcpServers" $McpName `
    "{`"transport`": `"stdio`", `"enabled`": true, `"command`": `"$DenoAbs`", `"args`": [$StdioArgsJson]}"
}

# --- main --------------------------------------------------------------------------
if (Wanted "omp") { Do-Omp }
if (Wanted "opencode") { Do-Opencode }
if (Wanted "claude") { Do-Claude }
if (Wanted "codex") { Do-Codex }
if (Wanted "cmd") { Do-Cmd }

Say ""
if ($DryRun) {
  Say "dry-run complete: nothing was written. Re-run without -DryRun to apply."
} else {
  Say "done. Then start the relay:  $TokenEnv=<token> deno task start   (cwd: $Repo/relay)"
}
