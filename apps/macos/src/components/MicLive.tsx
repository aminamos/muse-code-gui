// Live mic over the relay's Muse Voice realtime proxy.
// Browser captures 24 kHz mono int16 PCM and streams binary frames to
//   ws(s)://<relay>/api/asr/realtime?token=<relay-token>&mode=<mode>
// The relay injects the Meta API key upstream; the browser never sees it.
// API-billed ($0.18/audio-hour), never subscription — said on screen.

import { useEffect, useRef, useState } from "react";

export interface MicLiveProps {
  relayUrl: string;
  token: string;
}

interface MicLine {
  id: number;
  text: string;
  final: boolean;
}

let lineId = 0;

const WORKLET = `
class Cap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      const out = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(out.buffer, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('cap', Cap);
`;

function wsUrl(relayUrl: string, token: string, mode: string): string {
  const base = relayUrl.trim().replace(/\/+$/, "");
  const ws = base.replace(/^http/, "ws");
  return `${ws}/api/asr/realtime?token=${encodeURIComponent(token)}&mode=${mode}`;
}

export default function MicLive({ relayUrl, token }: MicLiveProps) {
  const [mode, setMode] = useState("DIARIZATION");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("idle");
  const [lines, setLines] = useState<MicLine[]>([]);
  const stopRef = useRef<(() => void) | null>(null);
  const linesRef = useRef<HTMLDivElement | null>(null);

  const tokenMissing = token.trim() === "";

  useEffect(() => {
    const el = linesRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  useEffect(() => {
    return () => {
      stopRef.current?.();
    };
  }, []);

  function pushLine(text: string, final: boolean) {
    setLines((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last && !last.final) {
        next[next.length - 1] = { ...last, text, final };
        return next;
      }
      lineId += 1;
      return [...next, { id: lineId, text, final }];
    });
  }

  async function start() {
    if (running || tokenMissing) return;
    setLines([]);
    setStatus("requesting microphone…");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      setStatus("microphone denied or unavailable");
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: 24000 });
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      setStatus("WebAudio unavailable");
      return;
    }
    const ws = new WebSocket(wsUrl(relayUrl, token.trim(), mode));
    let wsOpen = false;
    const queue: ArrayBuffer[] = [];
    const workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    let node: AudioWorkletNode | null = null;
    let stopped = false;

    const teardown = () => {
      if (stopped) return;
      stopped = true;
      try {
        ws.send(JSON.stringify({ type: "endStream" }));
      } catch {
        // closing anyway
      }
      setTimeout(() => {
        try {
          ws.close(1000);
        } catch {
          // already closed
        }
      }, 1500);
      node?.disconnect();
      void ctx.close().catch(() => {});
      stream.getTracks().forEach((t) => t.stop());
      URL.revokeObjectURL(workletUrl);
      stopRef.current = null;
      setRunning(false);
    };
    stopRef.current = teardown;

    ws.onopen = () => {
      wsOpen = true;
      setStatus("live — speak now");
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      try {
        const msg = JSON.parse(ev.data) as Record<string, unknown>;
        if (msg.type === "transcript" && typeof msg.transcript === "string") {
          pushLine(msg.transcript, msg.final === true);
        } else if (msg.type === "error") {
          setStatus(`error: ${typeof msg.message === "string" ? msg.message : "voice failed"}`);
        }
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      setStatus((prev) => (prev.startsWith("live") ? "ended" : prev));
      if (!stopped) teardown();
    };
    ws.onerror = () => {
      setStatus("connection failed (is the relay running with a Voice key?)");
    };

    try {
      await ctx.audioWorklet.addModule(workletUrl);
    } catch {
      setStatus("audio capture unavailable");
      teardown();
      return;
    }
    const src = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, "cap");
    const sink = ctx.createGain();
    sink.gain.value = 0;
    node.port.onmessage = (ev: MessageEvent) => {
      const buf = ev.data as ArrayBuffer;
      if (wsOpen && ws.readyState === WebSocket.OPEN) ws.send(buf);
      else queue.push(buf);
      if (wsOpen && queue.length > 0 && ws.readyState === WebSocket.OPEN) {
        for (const q of queue.splice(0)) {
          try {
            ws.send(q);
          } catch {
            break;
          }
        }
      }
    };
    src.connect(node);
    node.connect(sink);
    sink.connect(ctx.destination);
    setRunning(true);
  }

  return (
    <div className="mic">
      <div className="controls">
        <label>
          Mode
          <select value={mode} onChange={(e) => setMode(e.target.value)} disabled={running}>
            <option value="DIARIZATION">diarization (speakers)</option>
            <option value="ENDPOINTING">endpointing (turns)</option>
            <option value="PUSH_TO_TALK">push-to-talk (single turn)</option>
          </select>
        </label>
        {!running ? (
          <button type="button" onClick={() => void start()} disabled={tokenMissing}>
            Start live mic
          </button>
        ) : (
          <button type="button" onClick={() => stopRef.current?.()}>
            Stop
          </button>
        )}
        <span className="status">{status}</span>
      </div>
      <p className="mic-billing">Live mic is API-billed ($0.18/audio-hour), never subscription.</p>
      <div className="mic-lines" ref={linesRef} aria-live="polite">
        {lines.length === 0 ? (
          <p className="chat-empty">Press Start and speak — partial lines update live.</p>
        ) : (
          lines.map((l) => (
            <p key={l.id} className={l.final ? "mic-final" : "mic-partial"}>
              {l.text}
            </p>
          ))
        )}
      </div>
    </div>
  );
}
