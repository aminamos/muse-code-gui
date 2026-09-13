/**
 * Chat screen: message list + prompt box against a remote relay.
 *
 * Each turn streams from POST {relayUrl}/api/exec as SSE UI events
 * (docs/EXEC-CONTRACT.md). Auth is the relay Bearer [REDACTED] passed in
 * from Settings — this screen never handles a provider API key.
 *
 * Session continuation: one relay sessionId per conversation, rotated by
 * "New chat". The relay passes it to `muse exec --session-id`, so turns in
 * one conversation share server-side context.
 *
 * Streaming uses the shared RelayClient (XMLHttpRequest progress events,
 * because React Native fetch has no incremental byte stream).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { RelayClient } from "../exec/relay";

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  state: "done" | "streaming" | "error" | "stopped";
}

/** Bound rendered history (modest device memory): oldest turns are dropped. */
const MAX_MESSAGES = 100;

function newSessionId(): string {
  // UUID v4 shape (the relay passes it to `muse exec --session-id`).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

interface ChatScreenProps {
  relayUrl: string;
  relayToken: string;
}

let messageId = 0;

function nextId(): number {
  messageId += 1;
  return messageId;
}

export function ChatScreen({ relayUrl, relayToken }: ChatScreenProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<string>(newSessionId());
  const cancelRef = useRef<(() => void) | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);

  const configured =
    relayUrl.trim() !== "" && relayToken.trim() !== "";

  useEffect(() => {
    return () => {
      cancelRef.current?.();
      cancelRef.current = null;
    };
  }, []);

  const updateMessage = useCallback(
    (id: number, patch: Partial<ChatMessage>): void => {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      );
    },
    [],
  );

  const appendAssistantText = useCallback(
    (id: number, piece: string): void => {
      if (piece === "") {
        return;
      }
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, text: m.text + piece } : m)),
      );
    },
    [],
  );

  const send = useCallback(
    (promptOverride?: string): void => {
      if (running) {
        return;
      }
      const text = (promptOverride ?? input).trim();
      if (text === "") {
        return;
      }
      if (!configured) {
        setError("Set the relay URL and token in Settings first.");
        return;
      }
      if (!/^https?:\/\/.+/.test(relayUrl.trim())) {
        setError("Relay URL must be an http(s) URL to a remote relay.");
        return;
      }
      setError(null);
      const userMsg: ChatMessage = {
        id: nextId(),
        role: "user",
        text,
        state: "done",
      };
      const assistantMsg: ChatMessage = {
        id: nextId(),
        role: "assistant",
        text: "",
        state: "streaming",
      };
      setMessages((prev) =>
        [...prev, userMsg, assistantMsg].slice(-MAX_MESSAGES),
      );
      if (promptOverride === undefined) {
        setInput("");
      }
      setRunning(true);
      let finished = false;
      const finish = (): void => {
        if (!finished) {
          finished = true;
          cancelRef.current = null;
          setRunning(false);
        }
      };
      try {
        const client = new RelayClient(relayUrl.trim(), relayToken.trim());
        cancelRef.current = client.run(
          (event) => {
            switch (event.type) {
              case "delta":
                appendAssistantText(assistantMsg.id, event.text);
                break;
              case "done":
                // Backends emit the full text as deltas AND done; only use
                // done.text when no deltas arrived, to avoid doubling content.
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsg.id
                      ? {
                          ...m,
                          text: m.text === "" ? event.text : m.text,
                          state: "done" as const,
                        }
                      : m,
                  ),
                );
                finish();
                break;
              case "error":
                updateMessage(assistantMsg.id, { state: "error" });
                setError(event.message);
                finish();
                break;
              default:
                break;
            }
          },
          { prompt: text, sessionId: sessionRef.current },
        );
      } catch (err) {
        updateMessage(assistantMsg.id, { state: "error" });
        setError(err instanceof Error ? err.message : String(err));
        finish();
      }
    },
    [
      appendAssistantText,
      configured,
      input,
      relayToken,
      relayUrl,
      running,
      updateMessage,
    ],
  );

  const stop = useCallback((): void => {
    cancelRef.current?.();
    cancelRef.current = null;
    setRunning(false);
    setMessages((prev) =>
      prev.map((m) =>
        m.state === "streaming" ? { ...m, state: "stopped" as const } : m,
      ),
    );
  }, []);

  const retry = useCallback((): void => {
    if (running) {
      return;
    }
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) {
      return;
    }
    send(lastUser.text);
  }, [messages, running, send]);

  const newChat = useCallback((): void => {
    cancelRef.current?.();
    cancelRef.current = null;
    setMessages([]);
    setError(null);
    setRunning(false);
    sessionRef.current = newSessionId();
  }, []);

  const lastUserExists = messages.some((m) => m.role === "user");

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      {!configured ? (
        <Text style={styles.hint}>
          Chat needs a relay: enter the relay URL and token in Settings above,
          then send a prompt.
        </Text>
      ) : null}
      <ScrollView
        ref={scrollRef}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        onContentSizeChange={() =>
          scrollRef.current?.scrollToEnd({ animated: true })
        }
      >
        {messages.length === 0 ? (
          <Text style={styles.empty}>
            No messages yet. Type a prompt below to start chatting.
          </Text>
        ) : (
          messages.map((m) => (
            <View
              key={m.id}
              style={[
                styles.bubble,
                m.role === "user" ? styles.userBubble : styles.assistantBubble,
              ]}
            >
              <Text style={styles.role}>
                {m.role === "user" ? "You" : "Assistant"}
                {m.state === "streaming"
                  ? " (typing…)"
                  : m.state === "error"
                    ? " (error)"
                    : m.state === "stopped"
                      ? " (stopped)"
                      : ""}
              </Text>
              <Text selectable>{m.text === "" ? "…" : m.text}</Text>
            </View>
          ))
        )}
      </ScrollView>
      {error !== null ? (
        <View style={styles.errorRow}>
          <Text style={styles.errorText} selectable>
            Error: {error}
          </Text>
          <View style={styles.errorButtons}>
            {lastUserExists ? (
              <View style={styles.errorButton}>
                <Button
                  title="Retry"
                  onPress={retry}
                  disabled={running || !configured}
                />
              </View>
            ) : null}
            <View style={styles.errorButton}>
              <Button title="Dismiss" onPress={() => setError(null)} />
            </View>
          </View>
        </View>
      ) : null}
      <View style={styles.composer}>
        <TextInput
          style={styles.composerInput}
          value={input}
          onChangeText={setInput}
          placeholder={
            configured ? "Type a prompt…" : "Set relay URL + token first…"
          }
          multiline
          editable={!running}
          textAlignVertical="top"
        />
        <View style={styles.composerRow}>
          <View style={styles.composerButton}>
            <Button
              title={running ? "Stop" : "Send"}
              onPress={() => {
                if (running) {
                  stop();
                } else {
                  send();
                }
              }}
              disabled={running ? false : !configured || input.trim() === ""}
            />
          </View>
          <View style={styles.composerButton}>
            <Button title="New chat" onPress={newChat} disabled={running} />
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  hint: {
    fontSize: 13,
    marginBottom: 8,
  },
  list: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#999",
    borderRadius: 6,
    padding: 8,
  },
  listContent: {
    paddingBottom: 8,
    gap: 8,
  },
  empty: {
    fontSize: 13,
    color: "#555",
  },
  bubble: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 6,
    padding: 8,
  },
  userBubble: {
    backgroundColor: "#eee",
    marginLeft: 32,
  },
  assistantBubble: {
    backgroundColor: "#fafafa",
    marginRight: 8,
  },
  role: {
    fontSize: 12,
    fontWeight: "600",
    marginBottom: 4,
  },
  errorRow: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: "#b00020",
    borderRadius: 6,
    padding: 8,
  },
  errorText: {
    fontSize: 13,
    color: "#b00020",
  },
  errorButtons: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
  },
  errorButton: {
    flex: 1,
  },
  composer: {
    marginTop: 8,
  },
  composerInput: {
    borderWidth: 1,
    borderColor: "#999",
    borderRadius: 6,
    padding: 8,
    minHeight: 56,
    maxHeight: 140,
  },
  composerRow: {
    flexDirection: "row",
    gap: 8,
    marginTop: 8,
  },
  composerButton: {
    flex: 1,
  },
});
