// Voice pipeline: full audio -> transcript -> echo-exec round trip when the
// machine has whisper plus macOS `say` for speech synthesis; otherwise the
// missing-binary path is asserted (zero model spend in all cases).

import { assert } from "@std/assert";
import { loadConfig } from "../src/config.ts";
import { runVoiceCollect, VOICE_DEFAULT_PREFIX } from "../src/voice.ts";

async function have(cmd: string): Promise<boolean> {
  try {
    const out = await new Deno.Command(cmd, { args: ["--version"], stdout: "null", stderr: "null" }).output();
    void out;
    return true;
  } catch {
    return false;
  }
}

Deno.test("voice: default prompt framing is an instruction, not a bare echo", () => {
  assert(VOICE_DEFAULT_PREFIX.includes("Transcript:"));
  assert(!VOICE_DEFAULT_PREFIX.includes("repeat"));
});

Deno.test("voice: transcribe-then-echo end to end (or missing-binary error)", async () => {
  const cfg = loadConfig([]);
  const signal = AbortSignal.timeout(10 * 60_000);
  if (cfg.whisperBin === null) {
    // No whisper here: the pipeline must fail loudly naming the binary.
    let msg = "";
    try {
      await runVoiceCollect(cfg, { source: { kind: "path", value: "/nonexistent.wav" } }, signal);
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    assert(/whisper|path|not a file|no such/i.test(msg), `unexpected error: ${msg}`);
    return;
  }
  if (!(await have("say"))) {
    console.log("voice_test: whisper present but no `say` synthesizer; skipping live round trip");
    return;
  }
  const wav = await Deno.makeTempFile({ prefix: "mcu-voice-", suffix: ".aiff" });
  try {
    const said = await new Deno.Command("say", {
      args: ["-o", wav, "turn on the kitchen light"],
    }).output();
    assert(said.code === 0, "say synthesis failed");
    const result = await runVoiceCollect(cfg, {
      source: { kind: "path", value: wav },
      language: "en",
      diarize: false,
      exec: { provider: "echo" },
    }, signal);
    assert(result.transcript.text.trim().length > 0, "transcript is empty");
    assert(result.text.includes(result.transcript.text.trim().split(/\s+/)[0]), "echo output should contain transcript words");
    assert(result.terminal !== "", "terminal status missing");
  } finally {
    await Deno.remove(wav).catch(() => {});
  }
});
