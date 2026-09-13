// Transcription pipeline: source resolution (path/url/rss) + whisper +ffmpeg
// + optional diarization. Engine default is the local `whisper` CLI.
//
// Parakeet note (AGENTS.md): no local Parakeet CLI was found. Inspected PATH,
// /opt/homebrew/bin, ~/bin, ~/.local/bin, ~/models, the HF cache (only the
// Handy GUI app's GGUF plus an unrelated model), and /Applications
// (Handy-orig.app is GUI-only). `whisper` with cached large-v3-turbo is the
// fallback engine. Set WHISPER_BIN / WHISPER_MODEL to override.

import type {
  TranscribeEvent,
  TranscriptResult,
  TranscriptSegment,
} from "./events.ts";
import type { RelayConfig } from "./config.ts";
import { deriveFfprobe, missingBinaryError } from "./config.ts";

export type AudioSourceKind = "url" | "path" | "rss";

export interface AudioSource {
  kind: AudioSourceKind;
  /** URL, relay-local file path, or RSS feed URL. */
  value: string;
  /** RSS episode index (default 0). */
  index?: number;
}

export interface TranscribeOptions {
  source: AudioSource;
  language?: string;
  diarize?: boolean;
  model?: string;
}

export interface RssEpisode {
  index: number;
  title: string;
  audioUrl: string;
}

export interface DiarTurn {
  start: number;
  end: number;
  speaker: string;
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Best-effort RSS enclosure discovery (no XML parser in the relay). */
export function parseRssEpisodes(xml: string, limit = 200): RssEpisode[] {
  const episodes: RssEpisode[] = [];
  const items = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const item of items) {
    if (episodes.length >= limit) break;
    const enc =
      item.match(/<enclosure[^>]*?\surl=(["'])(.*?)\1/i) ??
      item.match(/<media:content[^>]*?\surl=(["'])(.*?)\1/i);
    if (!enc) continue;
    const titleMatch = item.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    episodes.push({
      index: episodes.length,
      title: titleMatch ? decodeEntities(stripCdata(titleMatch[1])).slice(0, 300) : "",
      audioUrl: decodeEntities(enc[2].trim()),
    });
  }
  return episodes;
}

interface WhisperJson {
  text?: unknown;
  language?: unknown;
  segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }>;
}

export function whisperJsonToSegments(json: WhisperJson): {
  segments: Array<{ start: number; end: number; text: string }>;
  language: string;
  text: string;
} {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const segments = Array.isArray(json.segments)
    ? json.segments.map((s) => ({
      start: num(s.start),
      end: num(s.end),
      text: typeof s.text === "string" ? s.text.trim() : "",
    })).filter((s) => s.text !== "" && s.end > s.start)
    : [];
  return {
    segments,
    language: typeof json.language === "string" ? json.language : "",
    text: typeof json.text === "string" ? json.text.trim() : segments.map((s) => s.text).join(" "),
  };
}

/** Assign each segment the diarizer turn with max time overlap. */
export function assignSpeakers(
  segments: Array<{ start: number; end: number; text: string }>,
  turns: DiarTurn[] | null,
): TranscriptSegment[] {
  if (!turns || turns.length === 0) {
    return segments.map((s) => ({ ...s, speaker: "SPEAKER_00" }));
  }
  return segments.map((s) => {
    let best = "SPEAKER_00";
    let bestOverlap = 0;
    for (const t of turns) {
      const overlap = Math.min(s.end, t.end) - Math.max(s.start, t.start);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = t.speaker;
      }
    }
    return { ...s, speaker: best };
  });
}

export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const m = Math.floor(s / 60);
  const sec = (s - m * 60).toFixed(3).padStart(6, "0");
  return `${String(m).padStart(2, "0")}:${sec}`;
}

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

async function runCmd(
  bin: string,
  args: string[],
  signal: AbortSignal,
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = new Deno.Command(bin, {
    args,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
    cwd,
  }).spawn();
  const onAbort = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const out = await child.output();
    const decoder = new TextDecoder();
    return {
      code: out.code,
      stdout: decoder.decode(out.stdout),
      stderr: decoder.decode(out.stderr),
    };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function downloadToFile(url: string, dir: string, signal: AbortSignal): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`not a URL: ${url.slice(0, 120)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`only http(s) URLs are fetchable: ${parsed.protocol}`);
  }
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const ext = (parsed.pathname.split(".").pop() ?? "").replace(/[^a-z0-9]/gi, "").slice(0, 8);
  const dest = `${dir}/source.${ext || "bin"}`;
  const file = await Deno.open(dest, { write: true, create: true });
  let bytes = 0;
  try {
    for await (const chunk of res.body) {
      bytes += chunk.byteLength;
      if (bytes > MAX_DOWNLOAD_BYTES) throw new Error("download exceeds 2 GiB cap");
      await file.write(chunk);
    }
  } finally {
    file.close();
  }
  return dest;
}

/** True when a spawn throw looks like a missing binary (cross-OS). Pure. */
export function isSpawnNotFound(err: unknown): boolean {
  if (err instanceof Deno.errors.NotFound) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /not found|no such file|ENOENT|cannot find the file/i.test(msg);
}

/**
 * Windows-safe diarizer invocation list. Never relies on shebang/exec-bit:
 * try direct first (POSIX fast path, unchanged), then the helper through
 * python3, then python. Pure for unit testing.
 */
export function buildDiarizerCommands(
  helper: string,
  wav: string,
): Array<{ bin: string; args: string[] }> {
  return [
    { bin: helper, args: [wav] },
    { bin: "python3", args: [helper, wav] },
    { bin: "python", args: [helper, wav] },
  ];
}

/**
 * Run the diarizer, falling through interpreter candidates when direct exec
 * throws (shebang/exec-bit on Windows, missing exec bit on POSIX). A spawned
 * process that exits non-zero is returned as-is (caller falls back to
 * single-speaker); only spawn throws advance to the next candidate.
 */
export async function runDiarizer(
  helper: string,
  wav: string,
  signal: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string; used: string }> {
  const candidates = buildDiarizerCommands(helper, wav);
  let lastErr: unknown = null;
  for (const c of candidates) {
    try {
      const r = await runCmd(c.bin, c.args, signal);
      return { ...r, used: c.bin === helper ? "direct" : c.bin };
    } catch (err) {
      lastErr = err;
      if (signal.aborted) throw err;
      continue;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function probeDuration(
  ffmpegBin: string | null,
  ffprobeBin: string | null,
  file: string,
  signal: AbortSignal,
): Promise<number | null> {
  const ffprobe = ffprobeBin ?? (ffmpegBin ? deriveFfprobe(ffmpegBin) : null);
  if (!ffprobe) return null;
  try {
    const out = await runCmd(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], signal);
    const v = Number.parseFloat(out.stdout.trim());
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

function parseDiarTurns(json: unknown): DiarTurn[] | null {
  if (!Array.isArray(json)) return null;
  const turns: DiarTurn[] = [];
  for (const t of json) {
    if (typeof t !== "object" || t === null) return null;
    const { start, end, speaker } = t as Record<string, unknown>;
    if (typeof start !== "number" || typeof end !== "number" || typeof speaker !== "string") return null;
    if (!(end > start)) continue;
    turns.push({ start, end, speaker: speaker.slice(0, 64) });
  }
  return turns;
}

export async function* runTranscribe(
  cfg: RelayConfig,
  opts: TranscribeOptions,
  signal: AbortSignal,
): AsyncGenerator<TranscribeEvent> {
  const jobId = crypto.randomUUID();
  yield { type: "started", jobId };
  const tmp = await Deno.makeTempDir({ prefix: "mcu-transcribe-" });
  try {
    yield { type: "progress", stage: "fetch", detail: opts.source.kind };
    let input: string;
    if (opts.source.kind === "path") {
      const st = await Deno.stat(opts.source.value);
      if (!st.isFile) throw new Error("path source is not a file");
      input = opts.source.value;
    } else if (opts.source.kind === "url") {
      input = await downloadToFile(opts.source.value, tmp, signal);
    } else {
      const feedRes = await fetch(opts.source.value, { signal });
      if (!feedRes.ok) throw new Error(`feed fetch failed: HTTP ${feedRes.status}`);
      const episodes = parseRssEpisodes(await feedRes.text());
      const idx = opts.source.index ?? 0;
      const ep = episodes[idx];
      if (!ep) throw new Error(`rss episode ${idx} not found (${episodes.length} with audio)`);
      yield { type: "log", stream: "info", text: `episode ${idx}: ${ep.title || ep.audioUrl}`.slice(0, 300) };
      input = await downloadToFile(ep.audioUrl, tmp, signal);
    }
    if (signal.aborted) return;
    if (!cfg.ffmpegBin) throw missingBinaryError("ffmpeg");
    if (!cfg.whisperBin) throw missingBinaryError("whisper");
    yield { type: "progress", stage: "decode", detail: "ffmpeg 16k mono wav" };
    const wav = `${tmp}/audio.wav`;
    const duration = await probeDuration(cfg.ffmpegBin, cfg.ffprobeBin, input, signal);
    let dec: { code: number; stdout: string; stderr: string };
    try {
      dec = await runCmd(cfg.ffmpegBin, ["-y", "-v", "error", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], signal);
    } catch (err) {
      if (isSpawnNotFound(err)) throw missingBinaryError("ffmpeg");
      throw err;
    }
    if (dec.code !== 0) throw new Error(`ffmpeg decode failed: ${dec.stderr.slice(0, 400)}`);
    if (signal.aborted) return;
    const model = opts.model ?? cfg.whisperModel;
    const language = opts.language ?? "en";
    yield { type: "progress", stage: "transcribe", detail: `whisper ${model} lang=${language}` };
    let w: { code: number; stdout: string; stderr: string };
    try {
      w = await runCmd(cfg.whisperBin, [wav, "--model", model, "--language", language, "--output_format", "json", "--output_dir", tmp, "--fp16", "False", "--verbose", "False"], signal);
    } catch (err) {
      if (isSpawnNotFound(err)) throw missingBinaryError("whisper");
      throw err;
    }
    for (const line of `${w.stdout}\n${w.stderr}`.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 60)) {
      yield { type: "log", stream: "info", text: line.slice(0, 300) };
    }
    if (w.code !== 0) throw new Error(`whisper failed (exit ${w.code}): ${w.stderr.slice(0, 400)}`);
    const wj = JSON.parse(await Deno.readTextFile(`${tmp}/audio.json`));
    const { segments, language: detected, text } = whisperJsonToSegments(wj);
    if (signal.aborted) return;
    let turns: DiarTurn[] | null = null;
    let diarization: TranscriptResult["diarization"] = "none";
    if (opts.diarize !== false && cfg.diarizeHelper) {
      yield { type: "progress", stage: "diarize", detail: cfg.diarizeHelper };
      try {
        const d = await runDiarizer(cfg.diarizeHelper, wav, signal);
        if (d.used !== "direct") {
          yield { type: "log", stream: "info", text: `diarizer direct exec failed, ran via ${d.used} (${Deno.build.os})` };
        }
        if (d.code === 0) {
          try {
            turns = parseDiarTurns(JSON.parse(d.stdout));
            if (turns) diarization = "external";
          } catch {
            turns = null;
          }
        }
        if (!turns) yield { type: "log", stream: "stderr", text: `diarizer failed, single-speaker fallback: ${d.stderr.slice(0, 300)}` };
      } catch (err) {
        yield { type: "log", stream: "stderr", text: `diarizer failed (direct + python3 + python), single-speaker fallback: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}` };
      }
    } else if (opts.diarize !== false) {
      yield { type: "log", stream: "info", text: "no diarizer configured (DIARIZE_HELPER), single-speaker fallback" };
    }
    const finalSegments = assignSpeakers(segments, turns);
    const speakers = [...new Set(finalSegments.map((s) => s.speaker))].sort();
    const fullText = finalSegments.map((s) => `[${formatTimestamp(s.start)} ${s.speaker}] ${s.text}`).join("\n");
    yield {
      type: "done",
      result: {
        engine: `whisper/${model}`,
        diarization,
        language: detected || language,
        duration,
        speakers,
        segments: finalSegments,
        text: text !== "" ? text : fullText,
      },
    };
  } finally {
    try {
      await Deno.remove(tmp, { recursive: true });
    } catch {
      // best effort
    }
  }
}
