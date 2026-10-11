// Muse Voice Transcribe engine (Meta Model API, API-billed — NOT subscription).
// Two transports, same model:
//   - file: POST https://api.meta.ai/v1/asr/transcribe (multipart, WAV only)
//   - live: wss://api.meta.ai/v1/asr/realtime (PCM int16 mono 24kHz frames)
//
// Pricing is $0.18/audio-hour, metered separately from tokens and from the
// `muse login` subscription. Every entry point refuses to run without an
// explicit key (MUSE_VOICE_API_KEY, else META_API_KEY) and says so loudly.
// Local whisper stays the default engine; Voice is opt-in per request or via
// TRANSCRIBE_ENGINE=muse-voice.

import { missingBinaryError } from "./config.ts";
import type { RelayConfig } from "./config.ts";
import type { TranscriptSegment } from "./events.ts";

export const VOICE_MODEL = "muse-voice-transcribe-1.0";
const VOICE_API_BASE = "https://api.meta.ai/v1";
export const VOICE_WS_URL = "wss://api.meta.ai/v1/asr/realtime";
const VOICE_MAX_BYTES = 32 * 1024 * 1024;
const VOICE_MAX_SECONDS = 600;

export type VoiceMode = "PUSH_TO_TALK" | "ENDPOINTING" | "DIARIZATION";

export function voiceApiKey(): string | null {
  const key = Deno.env.get("MUSE_VOICE_API_KEY") ?? Deno.env.get("META_API_KEY") ?? "";
  return key !== "" ? key : null;
}

/** Throws naming the setup step when no Voice key is configured. */
export function requireVoiceKey(): string {
  const key = voiceApiKey();
  if (!key) {
    throw new Error(
      "Muse Voice needs a Model API key: create one in the Model API dashboard and export MUSE_VOICE_API_KEY. " +
        "Voice is API-billed ($0.18/audio-hour), never subscription.",
    );
  }
  return key;
}

export function resolveVoiceMode(diarize: boolean | undefined): VoiceMode {
  return diarize === false ? "ENDPOINTING" : "DIARIZATION";
}

/** First JSON text frame on the realtime socket (credential travels here, never in headers). */
export function buildVoiceHandshake(mode: VoiceMode, key: string): Record<string, unknown> {
  return {
    authorization: { accessToken: `Bearer ${key}` },
    audioEncoding: "PCM_24KHZ",
    model: VOICE_MODEL,
    mode,
    partialMode: "CUMULATIVE",
    emitAudioProgress: false,
  };
}

/** The `request` part of the multipart file upload. */
export function buildVoiceRequestPart(
  mode: VoiceMode,
  opts?: { keywords?: string[]; languageBias?: string[] },
): Record<string, unknown> {
  const part: Record<string, unknown> = { model: VOICE_MODEL, audioEncoding: "WAV", mode };
  if (opts?.keywords?.length) part.keywords = opts.keywords;
  if (opts?.languageBias?.length) part.languageBias = opts.languageBias;
  return part;
}

export interface VoiceTurn {
  turnId: number;
  startMs: number;
  endMs: number;
  transcript: string;
  speaker?: string;
}

/** Map Voice turns onto the relay's segment/speaker model (seconds, sorted speakers). */
export function mapVoiceTurns(turns: VoiceTurn[]): { segments: TranscriptSegment[]; speakers: string[]; text: string } {
  const segments: TranscriptSegment[] = turns.map((t) => ({
    start: t.startMs / 1000,
    end: t.endMs / 1000,
    speaker: t.speaker && t.speaker !== "" ? t.speaker : "SPEAKER_00",
    text: t.transcript,
  }));
  const speakers = [...new Set(segments.map((s) => s.speaker))].sort();
  return { segments, speakers, text: segments.map((s) => s.text).join("\n") };
}

async function runFfmpeg(ffmpegBin: string, args: string[], signal: AbortSignal): Promise<void> {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(ffmpegBin, { args, stdout: "null", stderr: "piped", signal }).spawn();
  } catch {
    throw missingBinaryError("ffmpeg");
  }
  const { code, stderr } = await child.output();
  if (code !== 0) {
    throw new Error(`ffmpeg convert failed: ${new TextDecoder().decode(stderr).slice(0, 400)}`);
  }
}

/** Convert any input to the Voice-required WAV: mono 16-bit PCM at 24 kHz. Enforces 32 MB / 10 min caps. */
export async function convertToVoiceWav(
  cfg: RelayConfig,
  input: string,
  outWav: string,
  signal: AbortSignal,
): Promise<number> {
  if (!cfg.ffmpegBin) throw missingBinaryError("ffmpeg");
  await runFfmpeg(cfg.ffmpegBin, ["-y", "-v", "error", "-i", input, "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", outWav], signal);
  const st = await Deno.stat(outWav);
  if (st.size > VOICE_MAX_BYTES) {
    throw new Error(`audio exceeds the Voice 32 MB cap (${st.size} bytes after convert)`);
  }
  // 24 kHz mono s16 = 48000 bytes/sec; cap 600 s.
  const seconds = st.size / 48000;
  if (seconds > VOICE_MAX_SECONDS) {
    throw new Error(`audio exceeds the Voice 10-minute cap (~${Math.round(seconds)} s)`);
  }
  return seconds;
}

export interface VoiceFileResult {
  transcript: string;
  audioDurationMs: number;
  turns: VoiceTurn[];
}

/** Upload one WAV file to the Voice API (buffered JSON response). */
export async function transcribeVoiceFile(
  wavPath: string,
  mode: VoiceMode,
  opts: { keywords?: string[]; languageBias?: string[]; sessionId?: string; signal?: AbortSignal },
): Promise<VoiceFileResult> {
  const key = requireVoiceKey();
  const form = new FormData();
  form.append(
    "request",
    new Blob([JSON.stringify(buildVoiceRequestPart(mode, opts))], { type: "application/json" }),
  );
  form.append("audio", new Blob([await Deno.readFile(wavPath)], { type: "audio/wav" }), "audio.wav");
  const url = `${VOICE_API_BASE}/asr/transcribe?sessionId=${encodeURIComponent(opts.sessionId ?? crypto.randomUUID())}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    body: form,
    signal: opts.signal,
  });
  if (!res.ok) {
    throw new Error(`voice transcribe failed: HTTP ${res.status} ${await res.text().then((t) => t.slice(0, 300))}`);
  }
  const body = await res.json() as { transcript?: unknown; audioDurationMs?: unknown; turns?: unknown };
  const turns = Array.isArray(body.turns)
    ? (body.turns as Record<string, unknown>[]).map((t, i) => ({
      turnId: typeof t.turnId === "number" ? t.turnId : i,
      startMs: typeof t.startMs === "number" ? t.startMs : 0,
      endMs: typeof t.endMs === "number" ? t.endMs : 0,
      transcript: typeof t.transcript === "string" ? t.transcript : "",
      speaker: typeof t.speaker === "string" ? t.speaker : undefined,
    }))
    : [];
  return {
    transcript: typeof body.transcript === "string" ? body.transcript : "",
    audioDurationMs: typeof body.audioDurationMs === "number" ? body.audioDurationMs : 0,
    turns,
  };
}
