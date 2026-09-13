// Chat view: message list + prompt box over POST /api/exec (one-shot turns).
// Relay URL + token come from the App settings state (props).

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { runExecStream } from "../lib/relay";
import type { ExecUiEvent } from "../lib/execEvents";

export interface ChatProps {
  relayUrl: string;
  token: string;
  defaultRelayUrl: string;
}

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
}

let messageId = 0;
function nextId(): number {
  messageId += 1;
  return messageId;
}

/** Minimal markdown-lite: fenced code blocks, inline code, bold. Elements only, no HTML injection. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g);
  return parts.map((part, i) => {
    const key = `${keyPrefix}-i${i}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={key}>{part.slice(1, -1)}</code>;
    }
    return <span key={key}>{part}</span>;
  });
}

function renderMessageText(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const fence = /```(\w*)\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  const pushProse = (prose: string, key: string) => {
    const lines = prose.split("\n");
    lines.forEach((line, li) => {
      if (li > 0) nodes.push(<br key={`${key}-br${li}`} />);
      nodes.push(
        <span key={`${key}-l${li}`}>{renderInline(line, `${key}-l${li}`)}</span>,
      );
    });
  };
  while ((m = fence.exec(text)) !== null) {
    if (m[0] === "") break;
    if (m.index > last) pushProse(text.slice(last, m.index), `b${k}`);
    nodes.push(
      <pre key={`b${k}-code`} className="chat-code">
        {m[2].replace(/\n$/, "")}
      </pre>,
    );
    k += 1;
    last = m.index + m[0].length;
  }
  if (last < text.length) pushProse(text.slice(last), `b${k}`);
  if (nodes.length === 0) nodes.push(<span key="empty"> </span>);
  return nodes;
}

export default function Chat({ relayUrl, token, defaultRelayUrl }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("idle");
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const retryRef = useRef<string | null>(null);

  const tokenMissing = token.trim() === "";

  // Instant jump (no smooth scrolling), safe under prefers-reduced-motion.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, running]);

  function appendDelta(id: number, chunk: string) {
    setMessages((prev) =>
      prev.map((msg) =>
        msg.id === id ? { ...msg, text: msg.text + chunk } : msg,
      ),
    );
  }

  function handleEvent(assistantId: number, event: ExecUiEvent) {
    switch (event.type) {
      case "started":
        setStatus(`running (${event.runId})`);
        break;
      case "delta":
        appendDelta(assistantId, event.text);
        break;
      case "log":
        break;
      case "done":
        setStatus(
          `done: terminal=${event.terminal} exit=${event.exitCode}`,
        );
        break;
      case "error":
        setError(event.message);
        break;
    }
  }

  async function send(promptText: string) {
    const prompt = promptText.trim();
    if (running || prompt === "") return;
    if (tokenMissing) {
      setError("Set the relay token in Settings above to enable chat.");
      return;
    }
    const baseUrl =
      relayUrl.trim() === "" ? defaultRelayUrl : relayUrl.trim();
    const controller = new AbortController();
    abortRef.current = controller;
    const userMsg: ChatMessage = { id: nextId(), role: "user", text: prompt };
    const assistantMsg: ChatMessage = {
      id: nextId(),
      role: "assistant",
      text: "",
    };
    retryRef.current = prompt;
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setDraft("");
    setError("");
    setRunning(true);
    setStatus("starting…");
    try {
      await runExecStream(
        { baseUrl, token },
        { prompt },
        (event) => handleEvent(assistantMsg.id, event),
        controller.signal,
      );
      setStatus((prev) =>
        prev.startsWith("running") || prev === "starting…"
          ? "stream closed"
          : prev,
      );
    } catch (err) {
      if (controller.signal.aborted) {
        setStatus("stopped by user");
      } else {
        setError((err as Error).message);
        setStatus("failed");
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  function handleRetry() {
    const last = retryRef.current;
    if (running || last === null) return;
    setMessages((prev) => {
      const next = [...prev];
      if (next.length > 0 && next[next.length - 1].role === "assistant") {
        next.pop();
      }
      if (next.length > 0 && next[next.length - 1].role === "user") {
        next.pop();
      }
      return next;
    });
    setError("");
    void send(last);
  }

  function handleKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(draft);
    }
  }

  return (
    <div className="chat">
      <div className="chat-list" ref={listRef} aria-live="polite">
        {messages.length === 0 ? (
          <p className="chat-empty">
            No messages yet. Type a prompt below to start.
          </p>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`chat-msg ${msg.role}`}>
              <div className="chat-role">
                {msg.role === "user" ? "You" : "Assistant"}
              </div>
              <div className="chat-text">
                {msg.text === "" ? (
                  running ? (
                    "…"
                  ) : (
                    <span> </span>
                  )
                ) : (
                  renderMessageText(msg.text)
                )}
              </div>
            </div>
          ))
        )}
      </div>
      {tokenMissing && (
        <p className="chat-hint">
          Chat is disabled until the relay token is set in Settings above.
        </p>
      )}
      {error !== "" && (
        <div className="chat-error" role="alert">
          <span>Error: {error}</span>
          <button type="button" onClick={handleRetry} disabled={running}>
            Retry
          </button>
        </div>
      )}
      <div className="chat-form">
        <textarea
          value={draft}
          rows={3}
          placeholder="Message Muse… (Enter to send, Shift+Enter for a new line)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={running}
        />
        <div className="controls">
          <button
            type="button"
            onClick={() => void send(draft)}
            disabled={running || draft.trim() === "" || tokenMissing}
          >
            Send
          </button>
          <button type="button" onClick={handleStop} disabled={!running}>
            Stop
          </button>
          <span className="status">{status}</span>
        </div>
      </div>
      <p className="chat-note">
        One-shot turns: each message starts a new run; the relay returns no
        session handle on /api/exec, so no history carries between messages.
      </p>
    </div>
  );
}
