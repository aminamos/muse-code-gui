// museexec: local CLI for `muse exec` (+ voice, transcribe, health, servers).
// Runs on this machine as you: host `muse login` subscription bills every
// turn. It never reads MUSE_API_TOKEN for auth (warns if set, since muse
// would then bill API credits instead of your subscription).
//
//   museexec exec "say hi" [--provider echo] [--json] ...
//   museexec voice ./note.m4a [--language en] [--no-diarize] ...
//   museexec transcribe ./ep.mp3 [--json]
//   museexec health [--json]
//   museexec mcp        # MCP server over stdio (for MCP clients)
//   museexec acp        # ACP v1 agent over stdio (for Zed etc.)
//
// Install once (cwd: relay/): deno task install-cli
// (wraps `deno install --global --config deno.json ... src/cli.ts`).

import { billingMode, loadConfig, type RelayConfig } from "./config.ts";
import { runMuseExec } from "./muse.ts";
import { runTranscribe } from "./transcribe.ts";
import { runVoiceCollect } from "./voice.ts";

const VERSION = "0.1.0";

const HELP = `museexec ${VERSION} — local CLI for muse exec (subscription-billed)

usage: museexec [--muse-bin PATH] [--provider meta|echo] <command> [options]

commands:
  exec <prompt...>     run one prompt (text streams to stdout)
    [--json] [--model ID] [--workspace PATH] [--session-id UUID]
    [--reasoning-effort E] [--approval-mode M] [--yolo] [--max-model-steps N]
  voice <audio>        transcribe audio locally, run transcript as a prompt
    [--language EN] [--no-diarize] [--transcribe-model M]
    [--prompt-prefix TEXT]  (plus the exec options above)
  transcribe <audio>   local whisper transcription only
    [--language EN] [--no-diarize] [--model M] [--json]
  health               binary audit + billing mode [--json]
  mcp                  MCP server over stdio
  acp                  ACP v1 agent over stdio

global:
  --muse-bin PATH      override the muse binary (default: PATH lookup)
  --provider MODE      meta (subscription, default) or echo (zero-spend test)
  -h, --help           this help
`;

interface GlobalOpts {
  museBin?: string;
  provider?: string;
}

function fail(msg: string): never {
  console.error(`museexec: ${msg}`);
  Deno.exit(2);
}

function parseArgs(argv: string[]): { globals: GlobalOpts; rest: string[] } {
  const globals: GlobalOpts = {};
  const rest: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      console.log(HELP);
      Deno.exit(0);
    } else if (a === "--muse-bin") {
      globals.museBin = argv[++i] ?? fail("--muse-bin needs a path");
    } else if (a.startsWith("--muse-bin=")) {
      globals.museBin = a.slice("--muse-bin=".length);
    } else if (a === "--provider") {
      globals.provider = argv[++i] ?? fail("--provider needs meta|echo");
    } else if (a.startsWith("--provider=")) {
      globals.provider = a.slice("--provider=".length);
    } else {
      rest.push(...argv.slice(i));
      break;
    }
    i++;
  }
  return { globals, rest };
}

/** --flag value / --flag=value / --bool-flag; returns {opts, positional}. */
function parseFlags(args: string[], bools: string[]): { opts: Record<string, string | boolean>; positional: string[] } {
  const opts: Record<string, string | boolean> = {};
  const positional: string[] = [];
  const boolSet = new Set(bools);
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      i++;
      continue;
    }
    const eq = a.indexOf("=");
    const name = (eq === -1 ? a.slice(2) : a.slice(2, eq)).replace(/-/g, "_");
    if (boolSet.has(name)) {
      opts[name] = true;
      i++;
      continue;
    }
    if (eq !== -1) {
      opts[name] = a.slice(eq + 1);
      i++;
      continue;
    }
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) fail(`--${name} needs a value`);
    opts[name] = next;
    i += 2;
  }
  return { opts, positional };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

function execOptsFrom(o: Record<string, string | boolean>, provider: string | undefined) {
  return {
    model: str(o.model),
    workspace: str(o.workspace),
    sessionId: str(o.session_id),
    reasoningEffort: str(o.reasoning_effort),
    approvalMode: str(o.approval_mode),
    yolo: o.yolo === true,
    maxModelSteps: typeof o.max_model_steps === "string" ? Number(o.max_model_steps) || undefined : undefined,
    provider,
  };
}

function loadLocal(globals: GlobalOpts): RelayConfig {
  const cfg = loadConfig([]);
  if (globals.museBin) cfg.museBin = globals.museBin;
  if (billingMode() === "api_key") {
    console.error("museexec: warning: MUSE_API_TOKEN/META_API_KEY is set — muse will bill API credits, not your subscription login");
  }
  return cfg;
}

async function cmdExec(cfg: RelayConfig, args: string[], provider: string | undefined): Promise<void> {
  const { opts, positional } = parseFlags(args, ["json", "yolo"]);
  const prompt = positional.join(" ").trim();
  if (prompt === "") fail("exec needs a prompt");
  if (prompt.length > 200_000) fail("prompt exceeds 200000 chars");
  const asJson = opts.json === true;
  for await (
    const e of runMuseExec(cfg.museBin, { prompt, ...execOptsFrom(opts, provider) }, AbortSignal.timeout(30 * 60_000))
  ) {
    if (e.type === "delta") {
      if (asJson) console.log(JSON.stringify(e));
      else await Deno.stdout.write(new TextEncoder().encode(e.text));
    } else if (e.type === "log") {
      console.error(`[${e.stream}] ${e.text}`);
    } else if (e.type === "done") {
      if (asJson) console.log(JSON.stringify(e));
      else if (e.text !== "") await Deno.stdout.write(new TextEncoder().encode(e.text));
      console.error(`done: ${e.terminal} (exit ${e.exitCode})`);
    } else if (e.type === "error") {
      fail(e.message);
    }
  }
  if (!asJson) await Deno.stdout.write(new TextEncoder().encode("\n"));
}

async function cmdVoice(cfg: RelayConfig, args: string[], provider: string | undefined): Promise<void> {
  const { opts, positional } = parseFlags(args, ["json", "yolo", "no_diarize"]);
  const value = positional[0] ?? fail("voice needs an audio path or URL");
  const kind = /https?:\/\//i.test(value) ? "url" as const : "path" as const;
  const asJson = opts.json === true;
  const result = await runVoiceCollect(cfg, {
    source: { kind, value },
    language: str(opts.language),
    diarize: opts.no_diarize === true ? false : undefined,
    transcribeModel: str(opts.transcribe_model),
    promptPrefix: str(opts.prompt_prefix),
    exec: execOptsFrom(opts, provider),
  }, AbortSignal.timeout(30 * 60_000));
  if (asJson) {
    console.log(JSON.stringify({
      transcript: result.transcript.text,
      speakers: result.transcript.speakers,
      text: result.text,
      terminal: result.terminal,
      exitCode: result.exitCode,
    }));
  } else {
    console.error(`heard ${result.transcript.text.length} chars (${result.transcript.speakers.join(", ") || "no speakers"})`);
    console.log(result.text);
    console.error(`done: ${result.terminal} (exit ${result.exitCode})`);
  }
}

async function cmdTranscribe(cfg: RelayConfig, args: string[]): Promise<void> {
  const { opts, positional } = parseFlags(args, ["json", "no_diarize"]);
  const value = positional[0] ?? fail("transcribe needs an audio path or URL");
  const kind = /https?:\/\//i.test(value) ? "url" as const : "path" as const;
  const asJson = opts.json === true;
  for await (
    const e of runTranscribe(cfg, {
      source: { kind, value },
      language: str(opts.language),
      diarize: opts.no_diarize === true ? false : undefined,
      model: str(opts.model),
    }, AbortSignal.timeout(30 * 60_000))
  ) {
    if (e.type === "done") {
      if (asJson) {
        console.log(JSON.stringify(e.result));
      } else {
        for (const s of e.result.segments) {
          console.log(`[${s.start.toFixed(1)} ${s.speaker}] ${s.text}`);
        }
      }
    } else if (e.type === "progress") {
      console.error(`${e.stage}: ${e.detail}`);
    } else if (e.type === "log") {
      console.error(`[${e.stream}] ${e.text}`);
    } else if (e.type === "error") {
      fail(e.message);
    }
  }
}

async function cmdHealth(cfg: RelayConfig, args: string[]): Promise<void> {
  const { opts } = parseFlags(args, ["json"]);
  const { auditBinaries, billingMode: mode } = await import("./config.ts");
  const info = {
    museexec: VERSION,
    billing: mode(),
    museBin: cfg.museBin,
    transcribe: {
      whisperBin: cfg.whisperBin ?? null,
      whisperModel: cfg.whisperModel,
      diarizer: cfg.diarizeHelper ?? null,
      ffmpegBin: cfg.ffmpegBin ?? null,
    },
    binaries: auditBinaries(cfg),
  };
  if (opts.json === true) console.log(JSON.stringify(info, null, 2));
  else {
    console.log(`museexec ${VERSION} — billing: ${info.billing}, muse: ${info.museBin}`);
    for (const [name, entry] of Object.entries(info.binaries)) {
      console.log(`  ${name}: ${(entry as { found?: boolean }).found ? "found" : "MISSING"}`);
    }
  }
}

async function cmdServer(sibling: string): Promise<void> {
  const path = new URL(`./${sibling}`, import.meta.url).pathname;
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-net",
      path,
    ],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const status = await child.status;
  Deno.exit(status.code);
}

async function main(): Promise<void> {
  const { globals, rest } = parseArgs(Deno.args);
  const [command, ...args] = rest;
  if (!command) {
    console.log(HELP);
    Deno.exit(0);
  }
  if (globals.provider !== undefined && globals.provider !== "meta" && globals.provider !== "echo") {
    fail("--provider must be meta|echo");
  }
  const provider = globals.provider === "echo" ? "echo" : undefined;
  switch (command) {
    case "exec":
      await cmdExec(loadLocal(globals), args, provider);
      break;
    case "voice":
      await cmdVoice(loadLocal(globals), args, provider);
      break;
    case "transcribe":
      await cmdTranscribe(loadLocal(globals), args);
      break;
    case "health":
      await cmdHealth(loadLocal(globals), args);
      break;
    case "mcp":
      await cmdServer("mcp-stdio.ts");
      break;
    case "acp":
      await cmdServer("acp-stdio.ts");
      break;
    default:
      fail(`unknown command: ${command} (see --help)`);
  }
}

if (import.meta.main) {
  await main();
}
