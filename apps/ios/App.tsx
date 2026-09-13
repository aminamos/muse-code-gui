/**
 * muse-code-ui (iOS): exec-runner UI against a remote relay.
 *
 * Remote-relay-only: runs stream from POST {relayUrl}/api/exec as SSE UI
 * events (docs/EXEC-CONTRACT.md). Auth is the relay bearer token entered
 * in Settings — this app never handles a provider API key.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  Button,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import * as DocumentPicker from 'expo-document-picker';

import { checkHealth, streamExec } from './src/relayClient';
import {
  formatTimestamp,
  streamTranscribe,
  streamTranscribeUpload,
  type TranscribeUploadFile,
  type TranscriptSegment,
} from './src/transcribeClient';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type ExecSettings,
} from './src/settings';

interface LogLine {
  id: number;
  stream: string;
  text: string;
}

let logId = 0;

export default function App() {
  const [settings, setSettings] = useState<ExecSettings>(DEFAULT_SETTINGS);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [output, setOutput] = useState('');
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [status, setStatus] = useState('idle');
  const [health, setHealth] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    loadSettings().then((loaded) => {
      setSettings(loaded);
      setSettingsLoaded(true);
    });
  }, []);

  useEffect(() => {
    if (settingsLoaded) {
      void saveSettings(settings);
    }
  }, [settings, settingsLoaded]);

  const appendLog = useCallback((stream: string, text: string) => {
    logId += 1;
    const id = logId;
    setLogs((prev) => [...prev.slice(-199), { id, stream, text }]);
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => stop, [stop]);

  const run = useCallback(async () => {
    if (running) {
      return;
    }
    const relayUrl = settings.relayUrl.trim();
    const relayToken = settings.relayToken.trim();
    if (relayUrl === '' || relayToken === '') {
      setStatus('error: set relay URL and token in Settings first');
      return;
    }
    if (prompt.trim() === '') {
      setStatus('error: prompt must not be empty');
      return;
    }
    setRunning(true);
    setOutput('');
    setLogs([]);
    setStatus('starting…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const events = streamExec(
        { baseUrl: relayUrl, token: relayToken },
        { prompt: prompt.trim(), signal: controller.signal },
      );
      for await (const event of events) {
        if (controller.signal.aborted) {
          break;
        }
        switch (event.type) {
          case 'started':
            setStatus(`running (${event.runId})`);
            break;
          case 'delta':
            setOutput((prev) => prev + event.text);
            break;
          case 'log':
            appendLog(event.stream, event.text);
            break;
          case 'done':
            setOutput((prev) =>
              event.text !== '' && prev === '' ? event.text : prev,
            );
            setStatus(
              `done: terminal=${event.terminal} exit=${event.exitCode}`,
            );
            break;
          case 'error':
            appendLog('error', event.message);
            setStatus(`error: ${event.message}`);
            break;
        }
      }
      if (controller.signal.aborted) {
        setStatus('stopped');
      }
    } catch (err) {
      if (controller.signal.aborted) {
        setStatus('stopped');
      } else {
        const message = err instanceof Error ? err.message : String(err);
        appendLog('error', message);
        setStatus(`error: ${message}`);
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setRunning(false);
    }
  }, [appendLog, prompt, running, settings.relayToken, settings.relayUrl]);

  const [tKind, setTKind] = useState<'url' | 'rss' | 'path'>('url');
  const [tValue, setTValue] = useState('');
  const [tIndex, setTIndex] = useState('0');
  const [tLanguage, setTLanguage] = useState('en');
  const [tDiarize, setTDiarize] = useState(true);
  const [tFile, setTFile] = useState<TranscribeUploadFile | null>(null);
  const [tRunning, setTRunning] = useState(false);
  const [tStatus, setTStatus] = useState('idle');
  const [tSegments, setTSegments] = useState<TranscriptSegment[]>([]);
  const [tMeta, setTMeta] = useState('');
  const tAbortRef = useRef<AbortController | null>(null);

  const stopTranscribe = useCallback(() => {
    tAbortRef.current?.abort();
    tAbortRef.current = null;
  }, []);

  useEffect(() => stopTranscribe, [stopTranscribe]);

  const pickTranscribeFile = useCallback(async () => {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['audio/*', 'video/*'],
        copyToCacheDirectory: true,
      });
      if (result.canceled) {
        return;
      }
      const asset = result.assets[0];
      if (!asset) {
        return;
      }
      setTFile({
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType,
      });
    } catch (err) {
      setTStatus(
        `error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, []);

  const clearTranscribeFile = useCallback(() => {
    setTFile(null);
  }, []);

  const runTranscribe = useCallback(async () => {
    if (tRunning) {
      return;
    }
    const relayUrl = settings.relayUrl.trim();
    const relayToken = settings.relayToken.trim();
    if (relayUrl === '' || relayToken === '') {
      setTStatus('error: set relay URL and token in Settings first');
      return;
    }
    const pickedFile = tFile;
    if (pickedFile === null && tValue.trim() === '') {
      setTStatus('error: pick an audio file or enter a transcribe source');
      return;
    }
    setTRunning(true);
    setTSegments([]);
    setTMeta('');
    setTStatus('starting…');
    const controller = new AbortController();
    tAbortRef.current = controller;
    try {
      const language =
        tLanguage.trim() === '' ? undefined : tLanguage.trim();
      const events =
        pickedFile !== null
          ? streamTranscribeUpload(
              { baseUrl: relayUrl, token: relayToken },
              pickedFile,
              { language, diarize: tDiarize },
              controller.signal,
            )
          : streamTranscribe(
              { baseUrl: relayUrl, token: relayToken },
              {
                kind: tKind,
                value: tValue.trim(),
                index:
                  tKind === 'rss'
                    ? Number.parseInt(tIndex, 10) || 0
                    : undefined,
                language,
                diarize: tDiarize,
              },
              controller.signal,
            );
      for await (const event of events) {
        if (controller.signal.aborted) {
          break;
        }
        switch (event.type) {
          case 'started':
            setTStatus(`running (${event.jobId})`);
            break;
          case 'progress':
            setTStatus(`${event.stage}: ${event.detail}`);
            break;
          case 'log':
            appendLog(event.stream, event.text);
            break;
          case 'done':
            setTSegments(event.result.segments);
            setTMeta(
              `${event.result.engine} · lang=${event.result.language} · diarization=${event.result.diarization} · speakers=${event.result.speakers.join(', ') || '—'}`,
            );
            setTStatus(`done: ${event.result.segments.length} segments`);
            break;
          case 'error':
            setTStatus(`error: ${event.message}`);
            break;
        }
      }
      if (controller.signal.aborted) {
        setTStatus('stopped');
      }
    } catch (err) {
      setTStatus(
        controller.signal.aborted
          ? 'stopped'
          : `error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (tAbortRef.current === controller) {
        tAbortRef.current = null;
      }
      setTRunning(false);
    }
  }, [appendLog, settings.relayToken, settings.relayUrl, tDiarize, tFile, tIndex, tKind, tLanguage, tRunning, tValue]);

  const onCheckHealth = useCallback(async () => {
    setHealth('checking…');
    try {
      const result = await checkHealth({
        baseUrl: settings.relayUrl,
        token: settings.relayToken,
      });
      setHealth(
        result.ok
          ? `ok (muse: ${result.museVersion ?? 'unknown'} @ ${result.museBin ?? 'unknown'})`
          : 'relay reports ok=false',
      );
    } catch (err) {
      setHealth(`unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [settings.relayToken, settings.relayUrl]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="auto" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>muse-code-ui · iOS (remote relay)</Text>

        <Text style={styles.heading}>Settings</Text>
        <Text style={styles.label}>Relay URL</Text>
        <TextInput
          style={styles.input}
          value={settings.relayUrl}
          onChangeText={(relayUrl) =>
            setSettings((prev) => ({ ...prev, relayUrl }))
          }
          placeholder="https://relay.tailnet.ts.net"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Text style={styles.label}>Relay token</Text>
        <TextInput
          style={styles.input}
          value={settings.relayToken}
          onChangeText={(relayToken) =>
            setSettings((prev) => ({ ...prev, relayToken }))
          }
          placeholder="relay bearer token (never an API key)"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
        <View style={styles.row}>
          <Button title="Check health" onPress={onCheckHealth} />
        </View>
        {health !== null && <Text style={styles.health}>{health}</Text>}

        <Text style={styles.heading}>Prompt</Text>
        <TextInput
          style={[styles.input, styles.prompt]}
          value={prompt}
          onChangeText={setPrompt}
          placeholder="say hi"
          multiline
          editable={!running}
        />
        <View style={styles.row}>
          <View style={styles.button}>
            <Button title="Run" onPress={run} disabled={running} />
          </View>
          <View style={styles.button}>
            <Button title="Stop" onPress={stop} disabled={!running} />
          </View>
        </View>
        <Text style={styles.status}>{status}</Text>

        <Text style={styles.heading}>Output</Text>
        <ScrollView style={styles.outputBox} nestedScrollEnabled>
          <Text selectable>{output === '' ? '(no output yet)' : output}</Text>
        </ScrollView>

        <Text style={styles.heading}>Logs</Text>
        <ScrollView style={styles.logBox} nestedScrollEnabled>
          {logs.length === 0 ? (
            <Text>(no log lines yet)</Text>
          ) : (
            logs.map((line) => (
              <Text key={line.id} selectable>
                [{line.stream}] {line.text}
              </Text>
            ))
          )}
        </ScrollView>

        <Text style={styles.heading}>Transcribe</Text>
        <View style={styles.row}>
          <View style={styles.button}>
            <Button
              title="Pick audio file"
              onPress={() => void pickTranscribeFile()}
              disabled={tRunning}
            />
          </View>
          {tFile !== null && (
            <View style={styles.button}>
              <Button
                title="Clear file"
                onPress={clearTranscribeFile}
                disabled={tRunning}
              />
            </View>
          )}
        </View>
        {tFile !== null && (
          <Text style={styles.health}>file: {tFile.name} (upload; URL/RSS/path ignored)</Text>
        )}
        <View style={styles.row}>
          {(['url', 'rss', 'path'] as const).map((k) => (
            <View key={k} style={styles.button}>
              <Button
                title={tKind === k ? `● ${k}` : k}
                onPress={() => setTKind(k)}
                disabled={tRunning}
              />
            </View>
          ))}
        </View>
        <Text style={styles.label}>
          {tKind === 'url'
            ? 'Audio/video URL (mp3, m4a, mp4, m4b, …)'
            : tKind === 'rss'
              ? 'Podcast RSS feed URL'
              : 'Relay-local file path'}
        </Text>
        <TextInput
          style={styles.input}
          value={tValue}
          onChangeText={setTValue}
          placeholder={tKind === 'path' ? '/path/on/relay/host/episode.m4a' : 'https://…'}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!tRunning}
        />
        {tKind === 'rss' && (
          <>
            <Text style={styles.label}>Episode index</Text>
            <TextInput
              style={styles.input}
              value={tIndex}
              onChangeText={setTIndex}
              keyboardType="numeric"
              editable={!tRunning}
            />
          </>
        )}
        <Text style={styles.label}>Language (whisper code)</Text>
        <TextInput
          style={styles.input}
          value={tLanguage}
          onChangeText={setTLanguage}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!tRunning}
        />
        <View style={styles.row}>
          <View style={styles.button}>
            <Button
              title={tDiarize ? '● diarize' : 'diarize'}
              onPress={() => setTDiarize((v) => !v)}
              disabled={tRunning}
            />
          </View>
          <View style={styles.button}>
            <Button title="Transcribe" onPress={() => void runTranscribe()} disabled={tRunning} />
          </View>
          <View style={styles.button}>
            <Button title="Stop" onPress={stopTranscribe} disabled={!tRunning} />
          </View>
        </View>
        <Text style={styles.status}>{tStatus}</Text>
        {tMeta !== '' && <Text style={styles.health}>{tMeta}</Text>}

        <Text style={styles.heading}>Segments</Text>
        <ScrollView style={styles.logBox} nestedScrollEnabled>
          {tSegments.length === 0 ? (
            <Text>(no segments yet)</Text>
          ) : (
            tSegments.map((s, i) => (
              <Text key={i} selectable>
                [{formatTimestamp(s.start)} {s.speaker}] {s.text}
              </Text>
            ))
          )}
        </ScrollView>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#fff',
  },
  container: {
    padding: 16,
    paddingBottom: 48,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 12,
  },
  heading: {
    fontSize: 15,
    fontWeight: '600',
    marginTop: 16,
    marginBottom: 8,
  },
  label: {
    fontSize: 13,
    marginBottom: 4,
  },
  input: {
    borderWidth: 1,
    borderColor: '#999',
    borderRadius: 6,
    padding: 8,
    marginBottom: 8,
  },
  prompt: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  row: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  button: {
    flex: 1,
  },
  status: {
    marginTop: 8,
    fontSize: 13,
  },
  health: {
    marginTop: 4,
    fontSize: 13,
  },
  outputBox: {
    borderWidth: 1,
    borderColor: '#999',
    borderRadius: 6,
    padding: 8,
    minHeight: 120,
    maxHeight: 260,
  },
  logBox: {
    borderWidth: 1,
    borderColor: '#999',
    borderRadius: 6,
    padding: 8,
    minHeight: 100,
    maxHeight: 220,
  },
});
