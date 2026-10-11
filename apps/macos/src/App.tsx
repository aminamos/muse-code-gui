import { useRef, useState } from "react";
import {
  formatTimestamp,
  runTranscribe,
  runTranscribeUpload,
  type TranscribeEvent,
  type TranscriptSegment,
} from "./lib/execClient";
import Chat from "./components/Chat";
import MicLive from "./components/MicLive";

const DEFAULT_RELAY_URL = "http://127.0.0.1:8744";

interface LogLine {
  id: number;
  stream: string;
  text: string;
}

interface Thread {
  id: string;
  title: string;
}

let logId = 0;

function newSessionId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `chat-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function load(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function loadThreads(): Thread[] {
  try {
    const raw = window.localStorage.getItem("threads");
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Thread[];
    return Array.isArray(parsed) ? parsed.slice(0, 50) : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [relayUrl, setRelayUrl] = useState(() => load("relayUrl", DEFAULT_RELAY_URL));
  const [token, setToken] = useState(() => load("relayToken", ""));
  const [workspace, setWorkspace] = useState(() => load("workspace", ""));
  const [model, setModel] = useState(() => load("model", ""));
  const [reasoningEffort, setReasoningEffort] = useState(() => load("reasoningEffort", ""));
  const [approvalMode, setApprovalMode] = useState(() => load("approvalMode", "on-request"));
  const [view, setView] = useState<"chat" | "transcribe">("chat");
  const [threads, setThreads] = useState<Thread[]>(loadThreads);
  const [activeId, setActiveId] = useState<string>(() => threads[0]?.id ?? newSessionId());
  const [logs, setLogs] = useState<LogLine[]>([]);

  const tokenMissing = token.trim() === "";

  function persistThreads(next: Thread[]) {
    setThreads(next);
    save("threads", JSON.stringify(next.slice(0, 50)));
  }

  function handleNewChat() {
    const id = newSessionId();
    persistThreads([{ id, title: "New chat" }, ...threads].slice(0, 50));
    setActiveId(id);
    setView("chat");
  }

  function handleSessionTitle(id: string, title: string) {
    persistThreads(threads.map((t) => (t.id === id ? { ...t, title } : t)));
  }

  function update(key: string, setter: (v: string) => void) {
    return (value: string) => {
      setter(value);
      save(key, value);
    };
  }
  const updateRelayUrl = update("relayUrl", setRelayUrl);
  const updateToken = update("relayToken", setToken);
  const updateWorkspace = update("workspace", setWorkspace);
  const updateModel = update("model", setModel);
  const updateReasoning = update("reasoningEffort", setReasoningEffort);
  const updateApproval = update("approvalMode", setApprovalMode);

  function pushLog(stream: string, text: string) {
    logId += 1;
    const id = logId;
    setLogs((prev) => [...prev.slice(-199), { id, stream, text }]);
  }

  const [tKind, setTKind] = useState<"url" | "rss" | "path">("url");
  const [tValue, setTValue] = useState("");
  const [tIndex, setTIndex] = useState("0");
  const [tLanguage, setTLanguage] = useState("en");
  const [tDiarize, setTDiarize] = useState(true);
  const [tEngine, setTEngine] = useState("local");
  const [tRunning, setTRunning] = useState(false);
  const [tStatus, setTStatus] = useState("idle");
  const [tSegments, setTSegments] = useState<TranscriptSegment[]>([]);
  const [tMeta, setTMeta] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const tAbortRef = useRef<AbortController | null>(null);

  function displayEngineText(s: string): string {
    return s.replace(/whisper(\s+\S+)?/gi, "local transcription");
  }

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
          { language: tLanguage.trim() || undefined, diarize: tDiarize, engine: tEngine },
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
            engine: tEngine,
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
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" />
          <div>
            <h1>Muse Code</h1>
            <p>macOS · Tauri</p>
          </div>
        </div>
        <span className={`conn ${tokenMissing ? "off" : "on"}`}>
          {tokenMissing ? "no relay token" : "relay token set"}
        </span>
        <div className="nav">
          <button type="button" className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}>
            Chat
          </button>
          <button type="button" className={view === "transcribe" ? "active" : ""} onClick={() => setView("transcribe")}>
            Transcribe
          </button>
          <button type="button" onClick={handleNewChat}>
            + New
          </button>
        </div>
        <div className="thread-list">
          <h2>Chats</h2>
          {threads.length === 0 && (
            <button type="button" className="thread-btn" disabled>
              No chats yet
            </button>
          )}
          {threads.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`thread-btn ${t.id === activeId ? "active" : ""}`}
              onClick={() => {
                setActiveId(t.id);
                setView("chat");
              }}
            >
              {t.title}
            </button>
          ))}
        </div>
        <details className="settings">
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
            Relay token
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onBlur={(e) => updateToken(e.target.value)}
              placeholder="relay token"
              autoComplete="off"
            />
          </label>
          <label>
            Workspace path (relay host)
            <input
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              onBlur={(e) => updateWorkspace(e.target.value)}
              placeholder="/path/on/relay/host"
              spellCheck={false}
            />
          </label>
          <div className="settings-row">
            <label>
              Model
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                onBlur={(e) => updateModel(e.target.value)}
                placeholder="default"
                spellCheck={false}
              />
            </label>
            <label>
              Reasoning
              <select value={reasoningEffort} onChange={(e) => updateReasoning(e.target.value)}>
                <option value="">default</option>
                <option value="none">none</option>
                <option value="minimal">minimal</option>
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="max">max</option>
              </select>
            </label>
          </div>
          <label>
            Approval mode
            <select value={approvalMode} onChange={(e) => updateApproval(e.target.value)}>
              <option value="on-request">on-request</option>
              <option value="untrusted">untrusted</option>
              <option value="never">never</option>
            </select>
          </label>
        </details>
      </aside>

      <main className="main">
        <div className="main-body">
          {view === "chat" ? (
            <section className="panel chat-panel">
              <Chat
                key={activeId}
                relayUrl={relayUrl}
                token={token}
                defaultRelayUrl={DEFAULT_RELAY_URL}
                workspace={workspace}
                model={model}
                reasoningEffort={reasoningEffort}
                approvalMode={approvalMode}
                sessionId={activeId}
                onSessionTitle={handleSessionTitle}
              />
            </section>
          ) : (
            <section className="panel">
              <h2>Transcribe</h2>
              <label>
                Audio/video file — overrides the source below
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
                <label>
                  Engine
                  <select value={tEngine} onChange={(e) => setTEngine(e.target.value)}>
                    <option value="local">local (free, offline)</option>
                    <option value="muse-voice">Muse Voice (API-billed)</option>
                  </select>
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
                <span className="status">{displayEngineText(tStatus)}</span>
              </div>
              {tMeta !== "" && <p>{displayEngineText(tMeta)}</p>}
              <h3>Live mic (Muse Voice realtime, API-billed)</h3>
              <MicLive relayUrl={relayUrl} token={token} />
              <h3>Segments</h3>
              <pre className="output">
                {tSegments.length === 0
                  ? " "
                  : tSegments.map((s) => `[${formatTimestamp(s.start)} ${s.speaker}] ${s.text}`).join("\n")}
              </pre>
              <h3>Log</h3>
              <pre className="log">
                {logs.length === 0 ? " " : logs.map((l) => `[${l.stream}] ${l.text}`).join("\n")}
              </pre>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
