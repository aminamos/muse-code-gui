// Muse Voice engine: framing unit tests + realtime proxy against a mock
// upstream socket. No Meta key, zero spend.

import { assert, assertEquals } from "@std/assert";
import {
  buildVoiceHandshake,
  buildVoiceRequestPart,
  mapVoiceTurns,
  requireVoiceKey,
  resolveVoiceMode,
  VOICE_MODEL,
} from "../src/asr.ts";
import { proxyAsrSession } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { runTranscribe } from "../src/transcribe.ts";

Deno.test("asr: handshake carries credential in frame, 24k PCM", () => {
  const h = buildVoiceHandshake("DIARIZATION", "k123") as Record<string, unknown>;
  assertEquals((h.authorization as Record<string, unknown>).accessToken, "Bearer k123");
  assertEquals(h.audioEncoding, "PCM_24KHZ");
  assertEquals(h.model, VOICE_MODEL);
  assertEquals(h.mode, "DIARIZATION");
});

Deno.test("asr: file request part shape", () => {
  const p = buildVoiceRequestPart("ENDPOINTING", { keywords: ["Amin"] }) as Record<string, unknown>;
  assertEquals(p.model, VOICE_MODEL);
  assertEquals(p.audioEncoding, "WAV");
  assertEquals(p.mode, "ENDPOINTING");
  assertEquals(p.keywords, ["Amin"]);
});

Deno.test("asr: diarize maps to DIARIZATION, off maps to ENDPOINTING", () => {
  assertEquals(resolveVoiceMode(undefined), "DIARIZATION");
  assertEquals(resolveVoiceMode(true), "DIARIZATION");
  assertEquals(resolveVoiceMode(false), "ENDPOINTING");
});

Deno.test("asr: turn mapping to segments/speakers/text", () => {
  const m = mapVoiceTurns([
    { turnId: 0, startMs: 0, endMs: 1500, transcript: "hello", speaker: "A" },
    { turnId: 1, startMs: 1500, endMs: 3000, transcript: "hi", speaker: "" },
  ]);
  assertEquals(m.segments.length, 2);
  assertEquals(m.segments[0].start, 0);
  assertEquals(m.segments[0].end, 1.5);
  assertEquals(m.segments[1].speaker, "SPEAKER_00");
  assertEquals(m.speakers, ["A", "SPEAKER_00"]);
  assert(m.text.includes("hello") && m.text.includes("hi"));
});

Deno.test("asr: missing key refuses loudly (no silent billing)", () => {
  const savedVoice = Deno.env.get("MUSE_VOICE_API_KEY");
  const savedMeta = Deno.env.get("META_API_KEY");
  Deno.env.delete("MUSE_VOICE_API_KEY");
  Deno.env.delete("META_API_KEY");
  try {
    let msg = "";
    try {
      requireVoiceKey();
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    assert(msg.includes("MUSE_VOICE_API_KEY"), `unexpected: ${msg}`);
  } finally {
    if (savedVoice !== undefined) Deno.env.set("MUSE_VOICE_API_KEY", savedVoice);
    if (savedMeta !== undefined) Deno.env.set("META_API_KEY", savedMeta);
  }
});

Deno.test("asr: unknown engine rejected before any spend", async () => {
  const cfg = loadConfig([]);
  let msg = "";
  try {
    const gen = runTranscribe(cfg, {
      source: { kind: "path", value: new URL("../../testdata/exec-stream.jsonl", import.meta.url).pathname },
      engine: "bogus",
    }, AbortSignal.timeout(30_000));
    for await (const _ of gen) {
      // drain
    }
  } catch (err) {
    msg = err instanceof Error ? err.message : String(err);
  }
  assert(msg.includes("unknown transcribe engine"), `unexpected: ${msg}`);
});

Deno.test("asr: realtime proxy pipes frames via mock upstream (no Meta)", async () => {
  // Mock upstream mimicking the Voice realtime contract.
  const mock = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
    const { socket, response } = Deno.upgradeWebSocket(req);
    let gotHandshake = false;
    socket.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const msg = JSON.parse(ev.data) as Record<string, unknown>;
        if (!gotHandshake) {
          gotHandshake = true;
          assertEquals((msg.authorization as Record<string, unknown>).accessToken, "Bearer test-key");
          assertEquals(msg.audioEncoding, "PCM_24KHZ");
          socket.send(JSON.stringify({ sessionId: "mock-1" }));
        } else if ((msg as Record<string, unknown>).type === "endStream") {
          socket.send(JSON.stringify({ type: "transcript", transcript: "hello mock", final: true }));
          socket.close(1000);
        }
      }
      // binary audio frames: accepted, ignored
    };
    return response;
  });
  const mockPort = (mock.addr as Deno.NetAddr).port;

  // Front door: accepts the test client, proxies to the mock.
  const front = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, (req) => {
    const { socket, response } = Deno.upgradeWebSocket(req);
    void proxyAsrSession(socket, `ws://127.0.0.1:${mockPort}`, "PUSH_TO_TALK", "test-key")
      .catch((err) => console.error(err));
    return response;
  });
  const frontPort = (front.addr as Deno.NetAddr).port;

  try {
    const client = new WebSocket(`ws://127.0.0.1:${frontPort}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("client open timeout")), 10_000);
      client.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      client.onerror = () => reject(new Error("client open failed"));
    });
    const received: string[] = [];
    const closed = new Promise<void>((resolve) => {
      client.onclose = () => resolve();
    });
    client.onmessage = (ev) => {
      if (typeof ev.data === "string") received.push(ev.data);
    };
    client.send(new Uint8Array([1, 2, 3, 4]).buffer);
    client.send(JSON.stringify({ type: "endStream" }));
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("proxy close timeout")), 10_000)),
    ]);
    const transcripts = received
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((m) => m !== null && m.type === "transcript");
    assertEquals(transcripts.length, 1);
    const only = transcripts[0] as Record<string, unknown>;
    assertEquals(only.transcript, "hello mock");
    assertEquals(only.final, true);
  } finally {
    await mock.shutdown();
    await front.shutdown();
  }
});
