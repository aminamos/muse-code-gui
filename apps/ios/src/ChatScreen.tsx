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
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { streamExec } from './relayClient';

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  state: 'done' | 'streaming' | 'error' | 'stopped';
}

/** Bound rendered history (modest device memory): oldest turns are dropped. */
const MAX_MESSAGES = 100;

function newSessionId(): string {
  // UUID v4 shape (the relay passes it to `muse exec --session-id`).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
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
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<string>(newSessionId());
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<ScrollView | null>(null);

  const configured =
    relayUrl.trim() !== '' && relayToken.trim() !== '';

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const updateMessage = useCallback(
    (id: number, patch: Partial<ChatMessage>) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      );
    },
    [],
  );

  const appendAssistantText = useCallback((id: number, piece: string) => {
    if (piece === '') {
      return;
    }
    setMessages((prev) =>
      prev.map((m) =>
        m.id === id ? { ...m, text: m.text + piece } : m,
      ),
    );
  }, []);

  const send = useCallback(
    async (promptOverride?: string) => {
      if (running) {
        return;
      }
      const text = (promptOverride ?? input).trim();
      if (text === '') {
        return;
      }
      if (!configured) {
        setError('Set the relay URL and token in Settings first.');
        return;
      }
      setError(null);
      const userMsg: ChatMessage = {
        id: nextId(),
        role: 'user',
        text,
        state: 'done',
      };
      const assistantMsg: ChatMessage = {
        id: nextId(),
        role: 'assistant',
        text: '',
        state: 'streaming',
      };
      setMessages((prev) =>
        [...prev, userMsg, assistantMsg].slice(-MAX_MESSAGES),
      );
      if (promptOverride === undefined) {
        setInput('');
      }
      setRunning(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const events = streamExec(
          { baseUrl: relayUrl.trim(), token: relayToken.trim() },
          {
            prompt: text,
            sessionId: sessionRef.current,
            signal: controller.signal,
          },
        );
        for await (const event of events) {
          if (controller.signal.aborted) {
            break;
          }
          switch (event.type) {
            case 'delta':
              appendAssistantText(assistantMsg.id, event.text);
              break;
            case 'done':
              // Backends emit the full text as deltas AND done; only use
              // done.text when no deltas arrived, to avoid doubling content.
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsg.id
                    ? {
                        ...m,
                        text: m.text === '' ? event.text : m.text,
                        state: 'done' as const,
                      }
                    : m,
                ),
              );
              break;
            case 'error':
              updateMessage(assistantMsg.id, { state: 'error' });
              setError(event.message);
              break;
            default:
              break;
          }
        }
        if (controller.signal.aborted) {
          updateMessage(assistantMsg.id, { state: 'stopped' });
        }
      } catch (err) {
        if (controller.signal.aborted) {
          updateMessage(assistantMsg.id, { state: 'stopped' });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          updateMessage(assistantMsg.id, { state: 'error' });
          setError(message);
        }
      } finally {
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        setRunning(false);
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

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const retry = useCallback(() => {
    if (running) {
      return;
    }
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    if (!lastUser) {
      return;
    }
    void send(lastUser.text);
  }, [messages, running, send]);

  const newChat = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setError(null);
    setRunning(false);
    sessionRef.current = newSessionId();
  }, []);

  const lastUserExists = messages.some((m) => m.role === 'user');

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {!configured && (
        <Text style={styles.hint}>
          Chat needs a relay: enter the relay URL and token in Settings above,
          then send a prompt.
        </Text>
      )}
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
                m.role === 'user' ? styles.userBubble : styles.assistantBubble,
              ]}
            >
              <Text style={styles.role}>
                {m.role === 'user' ? 'You' : 'Assistant'}
                {m.state === 'streaming'
                  ? ' (typing…)'
                  : m.state === 'error'
                    ? ' (error)'
                    : m.state === 'stopped'
                      ? ' (stopped)'
                      : ''}
              </Text>
              <Text selectable>{m.text === '' ? '…' : m.text}</Text>
            </View>
          ))
        )}
      </ScrollView>
      {error !== null && (
        <View style={styles.errorRow}>
          <Text style={styles.errorText} selectable>
            Error: {error}
          </Text>
          <View style={styles.errorButtons}>
            {lastUserExists && (
              <View style={styles.errorButton}>
                <Button
                  title="Retry"
                  onPress={retry}
                  disabled={running || !configured}
                />
              </View>
            )}
            <View style={styles.errorButton}>
              <Button title="Dismiss" onPress={() => setError(null)} />
            </View>
          </View>
        </View>
      )}
      <View style={styles.composer}>
        <TextInput
          style={styles.composerInput}
          value={input}
          onChangeText={setInput}
          placeholder={
            configured ? 'Type a prompt…' : 'Set relay URL + token first…'
          }
          multiline
          editable={!running}
          textAlignVertical="top"
        />
        <View style={styles.composerRow}>
          <View style={styles.composerButton}>
            <Button
              title={running ? 'Stop' : 'Send'}
              onPress={() => {
                if (running) {
                  stop();
                } else {
                  void send();
                }
              }}
              disabled={running ? false : !configured || input.trim() === ''}
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
    borderColor: '#999',
    borderRadius: 6,
    padding: 8,
  },
  listContent: {
    paddingBottom: 8,
    gap: 8,
  },
  empty: {
    fontSize: 13,
    color: '#555',
  },
  bubble: {
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 6,
    padding: 8,
  },
  userBubble: {
    backgroundColor: '#eee',
    marginLeft: 32,
  },
  assistantBubble: {
    backgroundColor: '#fafafa',
    marginRight: 8,
  },
  role: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
  },
  errorRow: {
    marginTop: 8,
    borderWidth: 1,
    borderColor: '#b00020',
    borderRadius: 6,
    padding: 8,
  },
  errorText: {
    fontSize: 13,
    color: '#b00020',
  },
  errorButtons: {
    flexDirection: 'row',
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
    borderColor: '#999',
    borderRadius: 6,
    padding: 8,
    minHeight: 56,
    maxHeight: 140,
  },
  composerRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  composerButton: {
    flex: 1,
  },
});
