import { useRef, useState } from "react";
import {
  DEFAULT_RELAY_URL,
  checkRelayHealth,
  runTranscribeStream,
  runTranscribeUpload,
  type RelayHealth,
} from "./lib/relay";
import {
  formatTimestamp,
  type TranscribeEvent,
  type TranscriptSegment,
} from "./lib/transcribeEvents";
import Chat from "./components/Chat";
import "./index.css";

interface LogLine {
  id: number;
  stream: "stderr" | "info";
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
  const [health, setHealth] = useState<RelayHealth | null>(null);
  const [healthError, setHealthError] = useState("");

  const usingLocalhostDefault =
    relayUrl.trim() === "" || relayUrl.trim() === DEFAULT_RELAY_URL;

  function handleResetLocalhost() {
    setRelayUrl(DEFAULT_RELAY_URL);
    window.localStorage.setItem("relayUrl", DEFAULT_RELAY_URL);
  }

  async function handleHealthCheck() {
    setHealth(null);
    setHealthError("");
    try {
      const baseUrl =
        relayUrl.trim() === "" ? DEFAULT_RELAY_URL : relayUrl.trim();
      const result = await checkRelayHealth({ baseUrl, token });
      setHealth(result);
    } catch (err) {
      setHealthError((err as Error).message);
    }
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
        setLogs((prev) => [...prev, { id: logId++, stream: event.stream, text: event.text }]);
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
    if (token.trim() === "") {
      setTStatus("refusing to run: relay token is empty");
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
    const baseUrl = relayUrl.trim() === "" ? DEFAULT_RELAY_URL : relayUrl.trim();
    try {
      if (file !== null) {
        await runTranscribeUpload(
          { baseUrl, token },
          file,
          { language: tLanguage.trim() || undefined, diarize: tDiarize },
          handleTranscribeEvent,
          controller.signal,
        );
      } else {
        await runTranscribeStream(
          { baseUrl, token },
          {
            kind: tKind,
            value: tValue.trim(),
            index: tKind === "rss" ? Number.parseInt(tIndex, 10) || 0 : undefined,
            language: tLanguage.trim() || undefined,
            diarize: tDiarize,
          },
          handleTranscribeEvent,
          controller.signal,
        );
      }
      setTStatus((prev) => (prev.startsWith("running") || prev === "starting…" ? "stream closed" : prev));
    } catch (err) {
      setTStatus(controller.signal.aborted ? "stopped by user" : `failed: ${(err as Error).message}`);
    } finally {
      tAbortRef.current = null;
      setTRunning(false);
    }
  }

  function handleTranscribeStop() {
    tAbortRef.current?.abort();
  }

  return (
    <div className="app">
      <header>
        <h1>Muse Code GUI</h1>
        <span className="platform">Windows · Tauri</span>
        <span className={`conn ${token.trim() === "" ? "off" : "on"}`}>
          {token.trim() === "" ? "no relay token" : "relay token set"}
        </span>
      </header>

      <section className="settings">
        <h2>Relay settings</h2>
        <label>
          Relay URL
          <input
            type="text"
            value={relayUrl}
            placeholder={DEFAULT_RELAY_URL}
            onChange={(e) => setRelayUrl(e.target.value)}
            spellCheck={false}
          />
        </label>
        <label>
          Relay token
          <input
            type="password"
            value={token}
            autoComplete="off"
            placeholder="subscription token (never an API key)"
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <div className="settings-row">
          <button type="button" onClick={handleResetLocalhost}>
            Reset to localhost
          </button>
          <button type="button" onClick={handleHealthCheck}>
            Check health
          </button>
          <span className="hint">
            {usingLocalhostDefault
              ? "using localhost relay"
              : "using remote relay override"}
          </span>
        </div>
        {health !== null && (
          <p className="health">
            ok={String(health.ok)} bin={health.museBin} version=
            {health.museVersion}
          </p>
        )}
        {healthError !== "" && <p className="error">health: {healthError}</p>}
      </section>

      <section className="chat-panel">
        <Chat
          relayUrl={relayUrl}
          token={token}
          defaultRelayUrl={DEFAULT_RELAY_URL}
        />
      </section>

      <section className="logs">
        <h2>Log</h2>
        <pre className="log-view">
          {logs.length === 0
            ? "…"
            : logs.map((line) => `[${line.stream}] ${line.text}`).join("\n")}
        </pre>
      </section>

      <section className="transcribe">
        <h2>Transcribe</h2>
        <label>
          Audio/video file (mp3, m4a, mp4, m4b, wav, …) — overrides the source below
          <input type="file" ref={fileRef} accept="audio/*,video/*,.m4b,.m4a,.mp3,.mp4,.wav" />
        </label>
        <div className="settings-row">
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
          <button type="button" onClick={handleTranscribeRun} disabled={tRunning}>
            Transcribe
          </button>
          <button type="button" onClick={handleTranscribeStop} disabled={!tRunning}>
            Stop
          </button>
          <span className="status">{tStatus}</span>
        </div>
        {tMeta !== "" && <p className="health">{tMeta}</p>}
        <h3>Segments</h3>
        <pre className="text-view" aria-live="polite">
          {tSegments.length === 0
            ? "…"
            : tSegments.map((s) => `[${formatTimestamp(s.start)} ${s.speaker}] ${s.text}`).join("\n")}
        </pre>
      </section>
    </div>
  );
}
