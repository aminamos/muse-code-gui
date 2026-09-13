// Relay configuration: env vars + CLI flags. Single source of truth for
// ports, tokens, and engine binary resolution.

export interface RelayConfig {
  port: number;
  bindHost: string;
  token: string;
  tokenGenerated: boolean;
  museBin: string;
  whisperBin: string;
  whisperModel: string;
  ffmpegBin: string;
  pdftotextBin: string | null;
  unzipBin: string | null;
  diarizeHelper: string | null;
  workspaceRoots: string[] | null;
}

function whichBin(explicit: string | null, ...names: string[]): string | null {
  if (explicit) return explicit;
  const path = Deno.env.get("PATH") ?? "";
  const dirs = path.split(":").filter(Boolean);
  const extra = ["/opt/homebrew/bin", "/usr/local/bin"];
  const home = Deno.env.get("HOME") ?? "";
  if (home) extra.push(`${home}/.local/bin`);
  for (const name of names) {
    if (name.includes("/")) {
      try {
        Deno.statSync(name);
        return name;
      } catch {
        continue;
      }
    }
    for (const dir of [...dirs, ...extra]) {
      const candidate = `${dir}/${name}`;
      try {
        const st = Deno.statSync(candidate);
        if (st.isFile) return candidate;
      } catch {
        // keep searching
      }
    }
  }
  return null;
}

export function resolveMuseBin(): string {
  return (
    whichBin(Deno.env.get("MUSE_BIN") ?? null, "muse") ??
    (() => {
      throw new Error("muse binary not found (set MUSE_BIN)");
    })()
  );
}

function resolveDiarizeHelper(env: string): string | null {
  if (env === "off" || env === "none") return null;
  if (env !== "") return env;
  try {
    const candidate = new URL("../scripts/sherpa/diarize", import.meta.url).pathname;
    Deno.statSync(candidate);
    return candidate;
  } catch {
    return null;
  }
}

export function loadConfig(args: string[]): RelayConfig {
  const allowRemote =
    args.includes("--allow-remote") || Deno.env.get("RELAY_ALLOW_REMOTE") === "1";
  let token = Deno.env.get("RELAY_TOKEN") ?? "";
  let generated = false;
  if (!token) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    generated = true;
  }
  const roots = Deno.env.get("MUSE_UI_WORKSPACES");
  const diarizeHelper = resolveDiarizeHelper(Deno.env.get("DIARIZE_HELPER") ?? "");
  return {
    port: Number(Deno.env.get("RELAY_PORT") ?? "8787"),
    bindHost: allowRemote ? "0.0.0.0" : "127.0.0.1",
    token,
    tokenGenerated: generated,
    museBin: resolveMuseBin(),
    whisperBin: whichBin(Deno.env.get("WHISPER_BIN") ?? null, "whisper") ?? "whisper",
    whisperModel: Deno.env.get("WHISPER_MODEL") ?? "turbo",
    ffmpegBin: whichBin(Deno.env.get("FFMPEG_BIN") ?? null, "ffmpeg") ?? "ffmpeg",
    pdftotextBin: whichBin(Deno.env.get("PDFTOTEXT_BIN") ?? null, "pdftotext"),
    unzipBin: whichBin(null, "unzip"),
    diarizeHelper: diarizeHelper && diarizeHelper !== "" ? diarizeHelper : null,
    workspaceRoots: roots ? roots.split(":").filter(Boolean) : null,
  };
}
