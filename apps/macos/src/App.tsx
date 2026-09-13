import { useRef, useState } from "react";
import {
  formatTimestamp,
  runTranscribe,
  runTranscribeUpload,
  type TranscribeEvent,
  type TranscriptSegment,
} from "./lib/execClient";
import Chat from "./components/Chat";

const DEFAULT_RELAY_URL = "http://127.0.0.1:8787";

interface LogLine {
  id: number;
  stream: string;
  text: string;
}

let logId = 0;

const initialRelayUrl =
  window.localStorage.getItem("relayUrl") ?? DEFAULT_RELAY_URL;
const initialToken = window.localStorage.getItem("relayToken") ?? "";

export default function App() {
  const [relayUrl, setRelayUrl] = useState(initialRelayUrl);
  const [token, setToken] = useState(initialToken);
  const [logs, setLogs] = useState<LogLine[]>([]);

  const tokenMissing = token.trim() === "";

  function updateRelayUrl(value: string) {
    setRelayUrl(value);
    window.localStorage.setItem("relayUrl", value);
  }

  function updateToken(value: string) {
    setToken(value);
    window.localStorage.setItem("relayToken", value);
  }

  function pushLog(stream: string, text: string) {
    logId += 1;
    const id = logId;
    setLogs((prev) => [...prev, { id, stream, text }]);
  }

  const [tKind, setTKind] = useState<"url" | "rss" | "path">("url");
  const [tValue, setTValue] = useState("");
  const [tIndex, setTIndex] = useState("0");
  const [tLanguage, setTLanguage] = useState("en");
  const [tDiarize, setTDiarize] = useState(true);
  const [tRunning, setTRunning] = useState(false);
  const [tStatus, setTStatus] = useState("idle");
  const [tSegments, setTSegments] = useState<TranscriptSegment[]>([]);
  const [tMeta, setTMeta] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const tAbortRef = useRef<AbortController | null>(null);

  function handleTranscribeEvent(event: TranscribeEvent) {
    switch (event.type) {
      case "started":
        setTStatus(`running (${event.jobId})`);
        break;
      case "progress":
        setTStatus(`${event.stage}: ${event.detail}`);
        break;
      case "log":
        pushLog(event.stream, event.text);
        break;
      case "done":
        setTSegments(event.result.segments);
        setTMeta(
          `${event.result.engine} · lang=${event.result.language} · diarization=${event.result.diarization} · speakers=${event.result.speakers.join(", ") || "—"}`,
        );
        setTStatus(`done: ${event.result.segments.length} segments`);
        break;
      case "error":
        setTStatus(`error: ${event.message}`);
        break;
    }
  }

  async function handleTranscribeRun() {
    if (tRunning) return;
    if (!token.trim()) {
      setTStatus("refusing to run: relay token is required");
      return;
    }
    const file = fileRef.current?.files?.[0] ?? null;
    if (file === null && tValue.trim() === "") {
      setTStatus("refusing to run: pick a file or enter a source");
      return;
    }
    const controller = new AbortController();
    tAbortRef.current = controller;
    setTRunning(true);
    setTSegments([]);
    setTMeta("");
    setTStatus("starting…");
    try {
      const opts = {
        relayUrl,
        token: token.trim(),
        signal: controller.signal,
        onEvent: handleTranscribeEvent,
      };
      if (file !== null) {
        await runTranscribeUpload(
          file,
          { language: tLanguage.trim() || undefined, diarize: tDiarize },
          opts,
        );
      } else {
        await runTranscribe(
          {
            kind: tKind,
            value: tValue.trim(),
            index: tKind === "rss" ? Number.parseInt(tIndex, 10) || 0 : undefined,
            language: tLanguage.trim() || undefined,
            diarize: tDiarize,
          },
          opts,
        );
      }
    } catch (err) {
      if (controller.signal.aborted) {
        setTStatus("stopped");
      } else {
        setTStatus("error");
        pushLog("stderr", err instanceof Error ? err.message : String(err));
      }
    } finally {
      tAbortRef.current = null;
      setTRunning(false);
    }
  }

  function handleTranscribeStop() {
    tAbortRef.current?.abort();
  }

  return (
    <main className="app">
      <header className="app-header">
        <h1>Muse Code GUI</h1>
        <span className="platform">macOS · Tauri</span>
        <span className={`conn ${tokenMissing ? "off" : "on"}`}>
          {tokenMissing ? "no relay token" : "relay token set"}
        </span>
      </header>

      <details className="panel" open={tokenMissing}>
        <summary>Relay settings</summary>
        <label>
          Relay URL
          <input
            value={relayUrl}
            onChange={(e) => setRelayUrl(e.target.value)}
            onBlur={(e) => updateRelayUrl(e.target.value)}
            placeholder={DEFAULT_RELAY_URL}
            spellCheck={false}
          />
        </label>
        <label>
          Relay token (subscription token, never a provider API key)
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onBlur={(e) => updateToken(e.target.value)}
            placeholder="relay token"
            autoComplete="off"
          />
        </label>
      </details>

      <section className="panel chat-panel">
        <Chat
          relayUrl={relayUrl}
          token={token}
          defaultRelayUrl={DEFAULT_RELAY_URL}
        />
      </section>

      <details className="panel">
        <summary>Log</summary>
        <pre className="log">
          {logs.length === 0 ? (
            " "
          ) : (
            logs.map((l) => `[${l.stream}] ${l.text}`).join("\n")
          )}
        </pre>
      </details>

      <section className="panel">
        <h2>Transcribe</h2>
        <label>
          Audio/video file (mp3, m4a, mp4, m4b, wav, …) — overrides the source below
          <input type="file" ref={fileRef} accept="audio/*,video/*,.m4b,.m4a,.mp3,.mp4,.wav" />
        </label>
        <div className="controls">
          <label>
            Kind
            <select value={tKind} onChange={(e) => setTKind(e.target.value as "url" | "rss" | "path")}>
              <option value="url">url</option>
              <option value="rss">rss</option>
              <option value="path">path</option>
            </select>
          </label>
          <label>
            Language
            <input type="text" value={tLanguage} onChange={(e) => setTLanguage(e.target.value)} size={6} />
          </label>
          <label>
            <input type="checkbox" checked={tDiarize} onChange={(e) => setTDiarize(e.target.checked)} />
            diarize
          </label>
        </div>
        <label>
          {tKind === "url" ? "Audio/video URL" : tKind === "rss" ? "Podcast RSS feed URL" : "Relay-local file path"}
          <input
            type="text"
            value={tValue}
            placeholder={tKind === "path" ? "/path/on/relay/host/episode.m4a" : "https://…"}
            onChange={(e) => setTValue(e.target.value)}
            spellCheck={false}
          />
        </label>
        {tKind === "rss" && (
          <label>
            Episode index
            <input type="number" value={tIndex} min={0} onChange={(e) => setTIndex(e.target.value)} />
          </label>
        )}
        <div className="controls">
          <button onClick={handleTranscribeRun} disabled={tRunning}>
            Transcribe
          </button>
          <button onClick={handleTranscribeStop} disabled={!tRunning}>
            Stop
          </button>
          <span className="status">{tStatus}</span>
        </div>
        {tMeta !== "" && <p>{tMeta}</p>}
        <h3>Segments</h3>
        <pre className="output">
          {tSegments.length === 0
            ? " "
            : tSegments.map((s) => `[${formatTimestamp(s.start)} ${s.speaker}] ${s.text}`).join("\n")}
        </pre>
      </section>
    </main>
  );
}
