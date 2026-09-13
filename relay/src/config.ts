// Relay configuration: env vars + CLI flags. Single source of truth for
// ports, tokens, and engine binary resolution.
//
// Portability: Windows-safe PATH search (semicolon split, PATHEXT-style
// suffixes, %VAR% expansion), os-aware workspace-roots split, and a
// startup binary audit with per-OS install hints. WSL note: when
// MUSE_LAUNCHER is set (e.g. "wsl"), --workspace paths are WSL paths
// (user responsibility); the launcher wraps the `muse exec` subprocess.

import { fromFileUrl } from "@std/path";

export interface RelayConfig {
  port: number;
  bindHost: string;
  token: string;
  tokenGenerated: boolean;
  museBin: string;
  museLauncher: string | null;
  whisperBin: string | null;
  whisperModel: string;
  ffmpegBin: string | null;
  ffprobeBin: string | null;
  pdftotextBin: string | null;
  unzipBin: string | null;
  diarizeHelper: string | null;
  workspaceRoots: string[] | null;
}

function osName(override?: string): string {
  return override ?? Deno.build.os;
}

/** Expand %VAR% (Windows) and a leading ~/ in explicit bin/helper paths. */
export function expandBinPath(raw: string): string {
  let out = raw.replace(/%([^%]+)%/g, (_m, name) => Deno.env.get(name) ?? _m);
  if (out.startsWith("~/") || out === "~") {
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";
    if (home) out = home + out.slice(1);
  }
  return out;
}

/** Split a PATH-style env value; ";" on Windows, ":" elsewhere. */
export function splitPathEnv(pathEnv: string, os?: string): string[] {
  const delim = osName(os) === "windows" ? ";" : ":";
  return pathEnv.split(delim).map((s) => s.trim()).filter(Boolean);
}

/** Candidate filenames for a bare binary name (Windows tries suffixes). */
export function candidateNames(name: string, os?: string): string[] {
  if (osName(os) !== "windows") return [name];
  const lower = name.toLowerCase();
  if (
    lower.endsWith(".exe") || lower.endsWith(".cmd") || lower.endsWith(".bat") ||
    lower.endsWith(".ps1") || lower.endsWith(".com")
  ) return [name];
  return [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`];
}

/** True when the string is already a path (slash, backslash, drive letter). */
export function isExplicitPath(name: string): boolean {
  return name.includes("/") || name.includes("\\") || /^[a-zA-Z]:/.test(name);
}

function homeDir(): string {
  return Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ??
    ((Deno.env.get("HOMEDRIVE") ?? "") + (Deno.env.get("HOMEPATH") ?? ""));
}

export function whichBin(explicit: string | null, ...names: string[]): string | null {
  if (explicit) return expandBinPath(explicit);
  const os = Deno.build.os;
  const path = Deno.env.get("PATH") ?? "";
  const dirs = splitPathEnv(path, os);
  const extra: string[] = [];
  if (os !== "windows") extra.push("/opt/homebrew/bin", "/usr/local/bin");
  const home = homeDir();
  if (home) extra.push(`${home}/.local/bin`);
  for (const name of names) {
    if (isExplicitPath(name)) {
      try {
        Deno.statSync(expandBinPath(name));
        return expandBinPath(name);
      } catch {
        continue;
      }
    }
    for (const candidateName of candidateNames(name, os)) {
      for (const dir of [...dirs, ...extra]) {
        const sep = dir.endsWith("/") || dir.endsWith("\\") ? "" : "/";
        const candidate = `${dir}${sep}${candidateName}`;
        try {
          const st = Deno.statSync(candidate);
          if (st.isFile) return candidate;
        } catch {
          // keep searching
        }
      }
    }
  }
  return null;
}

/** Per-OS install step for a missing external binary. Pure (os-overridable). */
export function installHint(bin: string, os?: string): string {
  const o = osName(os);
  switch (bin) {
    case "muse":
      if (o === "windows") return "install the muse CLI for Windows and ensure it is on PATH (or set MUSE_BIN to its full path; with WSL set MUSE_LAUNCHER=wsl and MUSE_BIN to the WSL-side path)";
      if (o === "darwin") return "install the muse CLI (brew or the official installer) and ensure it is on PATH (or set MUSE_BIN)";
      return "install the muse CLI and ensure it is on PATH (or set MUSE_BIN)";
    case "whisper":
      if (o === "windows") return "install whisper: pip install openai-whisper (or set WHISPER_BIN to its full path)";
      if (o === "darwin") return "install whisper: pip install openai-whisper or brew install openai-whisper (or set WHISPER_BIN)";
      return "install whisper: pip install openai-whisper (or set WHISPER_BIN)";
    case "ffmpeg":
    case "ffprobe":
      if (o === "windows") return "install ffmpeg (includes ffprobe): winget install Gyan.FFmpeg (or set FFMPEG_BIN / FFPROBE_BIN)";
      if (o === "darwin") return "install ffmpeg: brew install ffmpeg (or set FFMPEG_BIN / FFPROBE_BIN)";
      return "install ffmpeg: apt install ffmpeg / dnf install ffmpeg (or set FFMPEG_BIN / FFPROBE_BIN)";
    case "pdftotext":
      if (o === "windows") return "install poppler (pdftotext): winget install poppler (or set PDFTOTEXT_BIN); PDF ingest stays disabled until present";
      if (o === "darwin") return "install poppler: brew install poppler (or set PDFTOTEXT_BIN); PDF ingest stays disabled until present";
      return "install poppler: apt install poppler-utils (or set PDFTOTEXT_BIN); PDF ingest stays disabled until present";
    case "unzip":
      if (o === "windows") return "install unzip (Git for Windows bundles it) and ensure it is on PATH; EPUB ingest stays disabled until present";
      if (o === "darwin") return "install unzip: brew install unzip (usually preinstalled); EPUB ingest stays disabled until present";
      return "install unzip: apt install unzip; EPUB ingest stays disabled until present";
    case "diarizer":
      return "set DIARIZE_HELPER to a diarizer script (relay/scripts/sherpa needs its Python venv), or DIARIZE_HELPER=off for single-speaker output";
    default:
      return `install ${bin} and ensure it is on PATH`;
  }
}

/** Error for a missing binary, naming the per-OS install step. Pure. */
export function missingBinaryError(bin: string, os?: string): Error {
  return new Error(`${bin} binary not found: ${installHint(bin, os)}`);
}

export function resolveMuseLauncher(): string | null {
  const v = (Deno.env.get("MUSE_LAUNCHER") ?? "").trim();
  return v !== "" ? v : null;
}

export function resolveMuseBin(): string {
  const explicit = Deno.env.get("MUSE_BIN") ?? null;
  const found = whichBin(explicit, "muse");
  if (found) return found;
  // With a launcher (e.g. WSL), the binary lives on the launcher side and
  // is not visible to host PATH probing; assume the bare name there.
  if (resolveMuseLauncher()) return explicit ? expandBinPath(explicit) : "muse";
  throw missingBinaryError("muse");
}

/** Derive the sibling ffprobe path from an ffmpeg path (handles .exe). */
export function deriveFfprobe(ffmpegBin: string): string {
  return ffmpegBin.replace(/ffmpeg(\.exe)?$/i, (_m, exe) => `ffprobe${exe ?? ""}`);
}

function resolveFfprobe(ffmpegBin: string | null): string | null {
  const direct = whichBin(Deno.env.get("FFPROBE_BIN") ?? null, "ffprobe");
  if (direct) return direct;
  if (ffmpegBin && isExplicitPath(ffmpegBin)) {
    const sibling = deriveFfprobe(expandBinPath(ffmpegBin));
    try {
      const st = Deno.statSync(sibling);
      if (st.isFile) return sibling;
    } catch {
      // fall through to null
    }
  }
  return null;
}

function resolveDiarizeHelper(env: string): string | null {
  if (env === "off" || env === "none") return null;
  if (env !== "") return expandBinPath(env);
  try {
    const candidate = fromFileUrl(new URL("../scripts/sherpa/diarize", import.meta.url));
    Deno.statSync(candidate);
    return candidate;
  } catch {
    // Windows checkout without the POSIX wrapper: try the .py entrypoint.
    try {
      const py = fromFileUrl(new URL("../scripts/sherpa/diarize.py", import.meta.url));
      Deno.statSync(py);
      return py;
    } catch {
      return null;
    }
  }
}

/** Split MUSE_GUI_WORKSPACES; ";" on Windows (drive letters), ":" elsewhere. */
export function splitWorkspaceRoots(raw: string, os?: string): string[] {
  const delim = osName(os) === "windows" ? ";" : ":";
  return raw.split(delim).map((s) => s.trim()).filter(Boolean);
}

export interface BinaryAuditEntry {
  bin: string | null;
  found: boolean;
}

export function auditBinaries(cfg: RelayConfig): Record<string, BinaryAuditEntry> {
  return {
    muse: { bin: cfg.museBin, found: true },
    whisper: { bin: cfg.whisperBin, found: cfg.whisperBin !== null },
    ffmpeg: { bin: cfg.ffmpegBin, found: cfg.ffmpegBin !== null },
    ffprobe: { bin: cfg.ffprobeBin, found: cfg.ffprobeBin !== null },
    pdftotext: { bin: cfg.pdftotextBin, found: cfg.pdftotextBin !== null },
    unzip: { bin: cfg.unzipBin, found: cfg.unzipBin !== null },
    diarizer: { bin: cfg.diarizeHelper, found: cfg.diarizeHelper !== null },
  };
}

export function formatBinaryAudit(cfg: RelayConfig): string {
  const audit = auditBinaries(cfg);
  const parts: string[] = [];
  for (const [name, entry] of Object.entries(audit)) {
    parts.push(`${name}=${entry.found ? entry.bin : "missing"}`);
  }
  if (cfg.museLauncher) parts.push(`launcher=${cfg.museLauncher}`);
  return parts.join(" ");
}

// Which account the muse backend bills. NOTE: credentials stored via
// `muse auth set` live in the OS keychain / muse config files, not in the
// environment, so they are invisible to this check — "subscription" here
// means "no API-credit env vars", not "provably on subscription billing".
export function billingMode(): "api_key" | "subscription" {
  const apiKey = Deno.env.get("META_API_KEY") ?? "";
  const token = Deno.env.get("MUSE_API_TOKEN") ?? "";
  return apiKey !== "" || token !== "" ? "api_key" : "subscription";
}

export function loadConfig(args: string[]): RelayConfig {
  const allowRemote =
    args.includes("--allow-remote") || Deno.env.get("RELAY_ALLOW_REMOTE") === "1";
  // Token alias: RELAY_TOKEN wins; MUSE_GUI_RELAY_TOKEN lets all harnesses share one env name.
  let token = Deno.env.get("RELAY_TOKEN") || Deno.env.get("MUSE_GUI_RELAY_TOKEN") || "";
  let generated = false;
  if (!token) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    generated = true;
  }
  const roots = Deno.env.get("MUSE_GUI_WORKSPACES");
  const diarizeHelper = resolveDiarizeHelper(Deno.env.get("DIARIZE_HELPER") ?? "");
  const ffmpegBin = whichBin(Deno.env.get("FFMPEG_BIN") ?? null, "ffmpeg");
  return {
    port: Number(Deno.env.get("RELAY_PORT") ?? "8787"),
    bindHost: allowRemote ? "0.0.0.0" : "127.0.0.1",
    token,
    tokenGenerated: generated,
    museBin: resolveMuseBin(),
    museLauncher: resolveMuseLauncher(),
    whisperBin: whichBin(Deno.env.get("WHISPER_BIN") ?? null, "whisper"),
    whisperModel: Deno.env.get("WHISPER_MODEL") ?? "turbo",
    ffmpegBin,
    ffprobeBin: resolveFfprobe(ffmpegBin),
    pdftotextBin: whichBin(Deno.env.get("PDFTOTEXT_BIN") ?? null, "pdftotext"),
    unzipBin: whichBin(null, "unzip"),
    diarizeHelper: diarizeHelper && diarizeHelper !== "" ? diarizeHelper : null,
    workspaceRoots: roots ? splitWorkspaceRoots(roots) : null,
  };
}
