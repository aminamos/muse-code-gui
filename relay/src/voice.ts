// Voice pipeline: transcribe spoken audio locally, then run the transcript
// as a `muse exec` prompt. This is the "voice input option, any way you
// want it": audio never leaves the machine for transcription (local whisper),
// and the prompt bills the relay host's `muse login` subscription — never an
// API key.
//
// Shared by the MCP `voice_exec` tool, POST /api/voice_exec, and the
// `museexec voice` CLI command.

import type { RelayConfig } from "./config.ts";
import type { UiEvent, TranscriptResult } from "./events.ts";
import { runMuseExec, type ExecOptions } from "./muse.ts";
import { runTranscribe, type AudioSource } from "./transcribe.ts";

export interface VoiceOptions {
  source: AudioSource;
  language?: string;
  diarize?: boolean;
  transcribeModel?: string;
  /** Overrides the default "follow this instruction" framing. */
  promptPrefix?: string;
  exec?: Omit<ExecOptions, "prompt">;
}

export interface VoiceResult {
  transcript: TranscriptResult;
  text: string;
  terminal: string;
  exitCode: number;
  logs: string[];
}

export const VOICE_DEFAULT_PREFIX = "Follow this voice instruction. The transcript follows.\n\nTranscript:\n";
const DEFAULT_PREFIX = VOICE_DEFAULT_PREFIX;

function log(text: string): UiEvent {
  return { type: "log", stream: "info", text };
}

/** Streaming form: stage logs, then the raw exec events verbatim. */
export async function* runVoiceEvents(
  cfg: RelayConfig,
  opts: VoiceOptions,
  signal: AbortSignal,
): AsyncGenerator<UiEvent> {
  yield log(`voice: transcribing ${opts.source.kind} source`);
  let transcript: TranscriptResult | null = null;
  for await (
    const e of runTranscribe(cfg, {
      source: opts.source,
      language: opts.language,
      diarize: opts.diarize,
      model: opts.transcribeModel,
    }, signal)
  ) {
    if (e.type === "done") {
      transcript = e.result;
    } else if (e.type === "progress") {
      yield log(`voice: transcribe ${e.stage}: ${e.detail}`);
    } else if (e.type === "log") {
      yield e;
    } else if (e.type === "error") {
      yield { type: "error", message: `transcribe failed: ${e.message}` };
      return;
    }
    // "started" events from the transcriber are noise here; skip them.
  }
  if (!transcript) {
    yield { type: "error", message: "transcription ended without a result" };
    return;
  }
  const heard = transcript.text.trim();
  if (heard === "") {
    yield { type: "error", message: "transcript is empty; nothing to run" };
    return;
  }
  yield log(`voice: heard ${heard.length} chars, running prompt`);
  const prompt = `${opts.promptPrefix ?? DEFAULT_PREFIX}${transcript.text}`;
  yield* runMuseExec(cfg.museBin, { ...(opts.exec ?? {}), prompt }, signal);
}

/** Collecting form for MCP tools and other non-streaming callers. */
export async function runVoiceCollect(
  cfg: RelayConfig,
  opts: VoiceOptions,
  signal: AbortSignal,
): Promise<VoiceResult> {
  const logs: string[] = [];
  let transcript: TranscriptResult | null = null;
  for await (
    const e of runTranscribe(cfg, {
      source: opts.source,
      language: opts.language,
      diarize: opts.diarize,
      model: opts.transcribeModel,
    }, signal)
  ) {
    if (e.type === "done") {
      transcript = e.result;
    } else if (e.type === "progress") {
      logs.push(`[info] voice: transcribe ${e.stage}: ${e.detail}`.slice(0, 300));
    } else if (e.type === "log") {
      logs.push(`[${e.stream}] ${e.text}`.slice(0, 300));
    } else if (e.type === "error") {
      throw new Error(`transcribe failed: ${e.message}`);
    }
  }
  if (!transcript) throw new Error("transcription ended without a result");
  if (transcript.text.trim() === "") throw new Error("transcript is empty; nothing to run");
  const prompt = `${opts.promptPrefix ?? DEFAULT_PREFIX}${transcript.text}`;
  let text = "";
  let terminal = "";
  let exitCode = 0;
  for await (const e of runMuseExec(cfg.museBin, { ...(opts.exec ?? {}), prompt }, signal)) {
    if (e.type === "delta") {
      text += e.text;
      if (text.length > 200_000) text = text.slice(0, 200_000);
    } else if (e.type === "log") {
      logs.push(`[${e.stream}] ${e.text}`.slice(0, 300));
    } else if (e.type === "done") {
      if (text === "") text = e.text;
      terminal = e.terminal;
      exitCode = e.exitCode;
    } else if (e.type === "error") {
      throw new Error(e.message);
    }
  }
  return { transcript, text, terminal, exitCode, logs: logs.slice(0, 100) };
}
