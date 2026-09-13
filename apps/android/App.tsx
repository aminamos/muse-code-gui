import { useRef, useState } from "react";
import {
  Button,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import * as DocumentPicker from "expo-document-picker";
import type { UIEvent as Event } from "./src/exec/events";
import type { TranscribeEvent, TranscriptSegment } from "./src/exec/events";
import { formatTimestamp } from "./src/exec/events";
import { RelayClient } from "./src/exec/relay";

interface LogLine {
  id: number;
  stream: "stderr" | "info" | "error";
  text: string;
}

type RunStatus = "idle" | "running" | "done" | "error";

export default function App() {
  // Remote-relay-only: Android cannot spawn `muse`, so no localhost default.
  // The relay inherits the host's `muse` login; the token below authorizes
  // relay access and is never a provider API key.
  const [relayUrl, setRelayUrl] = useState("");
  const [token, setToken] = useState("");
  const [showSettings, setShowSettings] = useState(true);
  const [prompt, setPrompt] = useState("say hi");
  const [output, setOutput] = useState("");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [status, setStatus] = useState<RunStatus>("idle");
  const [runId, setRunId] = useState("");
  const [terminal, setTerminal] = useState("");
  const [exitCode, setExitCode] = useState<number | null>(null);

  const cancelRef = useRef<(() => void) | null>(null);
  const logIdRef = useRef(0);
  const outputScrollRef = useRef<ScrollView | null>(null);
  const logScrollRef = useRef<ScrollView | null>(null);

  const appendLog = (stream: LogLine["stream"], text: string): void => {
    logIdRef.current += 1;
    const id = logIdRef.current;
    setLogs((prev) => [...prev.slice(-499), { id, stream, text }]);
  };

  const handleEvent = (event: Event): void => {
    switch (event.type) {
      case "started":
        setRunId(event.runId);
        appendLog("info", `run started: ${event.runId}`);
        break;
      case "delta":
        setOutput((prev) => prev + event.text);
        break;
      case "log":
        appendLog(event.stream, event.text);
        break;
      case "done":
        setStatus("done");
        setTerminal(event.terminal);
        setExitCode(event.exitCode);
        appendLog(
          "info",
          `done: terminal=${event.terminal} exit=${event.exitCode}`,
        );
        cancelRef.current = null;
        break;
      case "error":
        setStatus("error");
        appendLog("error", event.message);
        break;
    }
  };

  const validHttpUrl = (value: string): boolean =>
    /^https?:\/\/.+/.test(value.trim());

  const handleRun = (): void => {
    if (status === "running") {
      return;
    }
    if (prompt.trim().length === 0) {
      appendLog("error", "prompt is empty");
      return;
    }
    if (!validHttpUrl(relayUrl)) {
      appendLog("error", "relay URL must be an http(s) URL to a remote relay");
      setShowSettings(true);
      return;
    }
    if (token.length === 0) {
      appendLog("error", "relay token is required");
      setShowSettings(true);
      return;
    }
    setOutput("");
    setRunId("");
    setTerminal("");
    setExitCode(null);
    setStatus("running");
    appendLog("info", `POST ${relayUrl.trim().replace(/\/+$/, "")}/api/exec`);
    const client = new RelayClient(relayUrl, token);
    cancelRef.current = client.run(handleEvent, { prompt: prompt.trim() });
  };

  const handleStop = (): void => {
    cancelRef.current?.();
    cancelRef.current = null;
    if (status === "running") {
      setStatus("idle");
      appendLog("info", "stopped by user");
    }
  };

  const handleHealth = async (): Promise<void> => {
    if (!validHttpUrl(relayUrl)) {
      appendLog("error", "relay URL must be an http(s) URL to a remote relay");
      return;
    }
    if (token.length === 0) {
      appendLog("error", "relay token is required");
      return;
    }
    try {
      const health = await new RelayClient(relayUrl, token).health();
      appendLog(
        "info",
        `health: ok=${health.ok} museBin=${health.museBin} museVersion=${health.museVersion}`,
      );
    } catch (err) {
      appendLog(
        "error",
        `health check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const [mode, setMode] = useState<"exec" | "transcribe">("exec");
  const [tKind, setTKind] = useState<"url" | "rss" | "path">("url");
  const [tValue, setTValue] = useState("");
  const [tIndex, setTIndex] = useState("0");
  const [tLanguage, setTLanguage] = useState("en");
  const [tDiarize, setTDiarize] = useState(true);
  const [tStatus, setTStatus] = useState("idle");
  const [tSegments, setTSegments] = useState<TranscriptSegment[]>([]);
  const [tMeta, setTMeta] = useState("");
  const [tFile, setTFile] = useState<{
    uri: string;
    name: string;
    mimeType?: string;
  } | null>(null);
  const tCancelRef = useRef<(() => void) | null>(null);

  const handleTranscribeEvent = (event: TranscribeEvent): void => {
    switch (event.type) {
      case "started":
        setTStatus(`running (${event.jobId})`);
        break;
      case "progress":
        setTStatus(`${event.stage}: ${event.detail}`);
        break;
      case "log":
        appendLog(event.stream, event.text);
        break;
      case "done":
        setTSegments(event.result.segments);
        setTMeta(
          `${event.result.engine} · lang=${event.result.language} · diarization=${event.result.diarization} · speakers=${event.result.speakers.join(", ") || "—"}`,
        );
        setTStatus(`done: ${event.result.segments.length} segments`);
        tCancelRef.current = null;
        break;
      case "error":
        setTStatus(`error: ${event.message}`);
        appendLog("error", event.message);
        tCancelRef.current = null;
        break;
    }
  };

  const handlePickFile = (): void => {
    void (async () => {
      try {
        const res = await DocumentPicker.getDocumentAsync({
          type: ["audio/*", "video/*"],
          copyToCacheDirectory: true,
        });
        if (res.canceled || res.assets === null || res.assets.length === 0) {
          return;
        }
        const asset = res.assets[0];
        setTFile({
          uri: asset.uri,
          name: asset.name,
          mimeType: asset.mimeType,
        });
        appendLog("info", `picked file: ${asset.name}`);
      } catch (err) {
        appendLog(
          "error",
          `pick file failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    })();
  };

  const handleTranscribeRun = (): void => {
    if (tCancelRef.current !== null) {
      return;
    }
    if (tFile === null && tValue.trim().length === 0) {
      appendLog("error", "transcribe source is empty (enter a URL/RSS/path or pick a file)");
      return;
    }
    if (!validHttpUrl(relayUrl)) {
      appendLog("error", "relay URL must be an http(s) URL to a remote relay");
      setShowSettings(true);
      return;
    }
    if (token.length === 0) {
      appendLog("error", "relay token is required");
      setShowSettings(true);
      return;
    }
    setTSegments([]);
    setTMeta("");
    setTStatus("starting…");
    const client = new RelayClient(relayUrl, token);
    const language = tLanguage.trim() === "" ? undefined : tLanguage.trim();
    if (tFile !== null) {
      tCancelRef.current = client.transcribeUpload(handleTranscribeEvent, tFile, {
        language,
        diarize: tDiarize,
      });
    } else {
      tCancelRef.current = client.transcribe(handleTranscribeEvent, {
        kind: tKind,
        value: tValue.trim(),
        index: tKind === "rss" ? Number.parseInt(tIndex, 10) || 0 : undefined,
        language,
        diarize: tDiarize,
      });
    }
  };

  const handleTranscribeStop = (): void => {
    tCancelRef.current?.();
    tCancelRef.current = null;
    setTStatus("stopped");
  };

  const statusText =
    status === "running"
      ? `running${runId.length > 0 ? ` (${runId})` : ""}`
      : status === "done"
        ? `done: terminal=${terminal} exit=${exitCode}`
        : status;

  return (
    <View style={styles.root}>
      <Text style={styles.title}>muse code — Android (remote relay)</Text>

      <View style={styles.section}>
        <Button
          title={showSettings ? "Hide settings" : "Show settings"}
          onPress={() => setShowSettings((v) => !v)}
        />
        {showSettings ? (
          <View style={styles.settings}>
            <Text style={styles.label}>Relay URL (LAN or Tailscale)</Text>
            <TextInput
              style={styles.input}
              value={relayUrl}
              onChangeText={setRelayUrl}
              placeholder="http://<relay-host>:<port>"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.label}>Relay token</Text>
            <TextInput
              style={styles.input}
              value={token}
              onChangeText={setToken}
              placeholder="bearer token for the relay"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
            />
            <Button title="Test connection" onPress={() => void handleHealth()} />
          </View>
        ) : null}
      </View>

      <View style={styles.buttons}>
        <View style={styles.button}>
          <Button title="Exec" onPress={() => setMode("exec")} disabled={mode === "exec"} />
        </View>
        <View style={styles.button}>
          <Button
            title="Transcribe"
            onPress={() => setMode("transcribe")}
            disabled={mode === "transcribe"}
          />
        </View>
      </View>
      {mode === "exec" ? (
        <>
      <View style={styles.section}>
        <Text style={styles.label}>Prompt</Text>
        <TextInput
          style={[styles.input, styles.prompt]}
          value={prompt}
          onChangeText={setPrompt}
          multiline
          placeholder="Ask muse to do something…"
        />
        <View style={styles.buttons}>
          <View style={styles.button}>
            <Button
              title="Run"
              onPress={handleRun}
              disabled={status === "running"}
            />
          </View>
          <View style={styles.button}>
            <Button
              title="Stop"
              onPress={handleStop}
              disabled={status !== "running"}
            />
          </View>
        </View>
        <Text style={styles.status}>Status: {statusText}</Text>
      </View>

      <View style={styles.pane}>
        <Text style={styles.label}>Output (streaming)</Text>
        <ScrollView
          ref={outputScrollRef}
          style={styles.box}
          onContentSizeChange={() =>
            outputScrollRef.current?.scrollToEnd({ animated: true })
          }
        >
          <Text style={styles.mono} selectable>
            {output.length > 0 ? output : "—"}
          </Text>
        </ScrollView>
      </View>

      <View style={styles.pane}>
        <Text style={styles.label}>Log</Text>
        <ScrollView
          ref={logScrollRef}
          style={styles.box}
          onContentSizeChange={() =>
            logScrollRef.current?.scrollToEnd({ animated: true })
          }
        >
          {logs.length === 0 ? (
            <Text style={styles.mono}>—</Text>
          ) : (
            logs.map((line) => (
              <Text
                key={line.id}
                style={[
                  styles.mono,
                  line.stream === "error"
                    ? styles.logError
                    : line.stream === "stderr"
                      ? styles.logStderr
                      : styles.logInfo,
                ]}
                selectable
              >
                [{line.stream}] {line.text}
              </Text>
            ))
          )}
        </ScrollView>
      </View>
        </>
      ) : (
        <>
          <View style={styles.section}>
            <Text style={styles.label}>Source kind</Text>
            <View style={styles.buttons}>
              {(["url", "rss", "path"] as const).map((k) => (
                <View key={k} style={styles.button}>
                  <Button
                    title={tKind === k ? `● ${k}` : k}
                    onPress={() => setTKind(k)}
                    disabled={tCancelRef.current !== null}
                  />
                </View>
              ))}
            </View>
            <Text style={styles.label}>
              {tKind === "url" ? "Audio/video URL" : tKind === "rss" ? "Podcast RSS feed URL" : "Relay-local file path"}
            </Text>
            <TextInput
              style={styles.input}
              value={tValue}
              onChangeText={setTValue}
              placeholder={tKind === "path" ? "/path/on/relay/host/episode.m4a" : "https://…"}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {tKind === "rss" ? (
              <>
                <Text style={styles.label}>Episode index</Text>
                <TextInput
                  style={styles.input}
                  value={tIndex}
                  onChangeText={setTIndex}
                  keyboardType="numeric"
                />
              </>
            ) : null}
            <Text style={styles.label}>Or pick an audio file (upload)</Text>
            <View style={styles.buttons}>
              <View style={styles.button}>
                <Button
                  title="Pick file"
                  onPress={handlePickFile}
                  disabled={tCancelRef.current !== null}
                />
              </View>
              {tFile !== null ? (
                <View style={styles.button}>
                  <Button title="Clear file" onPress={() => setTFile(null)} />
                </View>
              ) : null}
            </View>
            {tFile !== null ? (
              <Text style={styles.status}>File: {tFile.name}</Text>
            ) : null}
            <Text style={styles.label}>Language (whisper code)</Text>
            <TextInput
              style={styles.input}
              value={tLanguage}
              onChangeText={setTLanguage}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={styles.buttons}>
              <View style={styles.button}>
                <Button
                  title={tDiarize ? "● diarize" : "diarize"}
                  onPress={() => setTDiarize((v) => !v)}
                />
              </View>
              <View style={styles.button}>
                <Button
                  title="Transcribe"
                  onPress={handleTranscribeRun}
                  disabled={tCancelRef.current !== null}
                />
              </View>
              <View style={styles.button}>
                <Button title="Stop" onPress={handleTranscribeStop} />
              </View>
            </View>
            <Text style={styles.status}>Status: {tStatus}</Text>
            {tMeta.length > 0 ? <Text style={styles.status}>{tMeta}</Text> : null}
          </View>
          <View style={styles.pane}>
            <Text style={styles.label}>Segments</Text>
            <ScrollView style={styles.box}>
              {tSegments.length === 0 ? (
                <Text style={styles.mono}>—</Text>
              ) : (
                tSegments.map((s, i) => (
                  <Text key={i} style={styles.mono} selectable>
                    [{formatTimestamp(s.start)} {s.speaker}] {s.text}
                  </Text>
                ))
              )}
            </ScrollView>
          </View>
        </>
      )}

      <StatusBar barStyle="dark-content" />
      <ExpoStatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: "#fff",
    paddingTop: 48,
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  title: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 12,
  },
  section: {
    marginBottom: 12,
  },
  settings: {
    marginTop: 8,
    gap: 4,
  },
  label: {
    fontSize: 13,
    fontWeight: "600",
    marginTop: 6,
    marginBottom: 2,
  },
  input: {
    borderWidth: 1,
    borderColor: "#999",
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
  },
  prompt: {
    minHeight: 64,
    textAlignVertical: "top",
  },
  buttons: {
    flexDirection: "row",
    gap: 12,
    marginTop: 8,
  },
  button: {
    flex: 1,
  },
  status: {
    marginTop: 6,
    fontSize: 13,
  },
  pane: {
    flex: 1,
    marginBottom: 8,
  },
  box: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#999",
    borderRadius: 6,
    padding: 8,
    backgroundColor: "#fafafa",
  },
  mono: {
    fontFamily: "monospace",
    fontSize: 13,
  },
  logInfo: {
    color: "#333",
  },
  logStderr: {
    color: "#8a6d00",
  },
  logError: {
    color: "#b00020",
  },
});
