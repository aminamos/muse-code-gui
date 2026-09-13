/**
 * Transcribe client for POST {relayUrl}/api/transcribe (docs/TRANSCRIBE.md).
 *
 * Same auth and SSE framing as the exec client: Bearer [REDACTED] relay token,
 * `data: <json>` frames. iOS sends JSON sources (url/rss/relay-local path)
 * or a multipart file upload (`audio` field) picked via expo-document-picker.
 */

import { fetch as expoFetch } from 'expo/fetch';

import type { RelayConfig } from './relayClient';

export interface TranscriptSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

export interface TranscriptResult {
  engine: string;
  diarization: 'external' | 'none';
  language: string;
  duration: number | null;
  speakers: string[];
  segments: TranscriptSegment[];
  text: string;
}

export type TranscribeEvent =
  | { type: 'started'; jobId: string }
  | { type: 'progress'; stage: string; detail: string }
  | { type: 'log'; stream: 'stderr' | 'info'; text: string }
  | { type: 'done'; result: TranscriptResult }
  | { type: 'error'; message: string };

export interface TranscribeRequest {
  kind: 'url' | 'rss' | 'path';
  value: string;
  index?: number;
  language?: string;
  diarize?: boolean;
  model?: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed === '' || !/^https?:\/\//i.test(trimmed)) {
    throw new Error('relay URL must be an http(s) URL');
  }
  return trimmed;
}

export interface TranscribeUploadFile {
  uri: string;
  name: string;
  mimeType?: string;
}

export interface TranscribeUploadOptions {
  language?: string;
  diarize?: boolean;
  model?: string;
}

function validatedConfig(config: RelayConfig): {
  baseUrl: string;
  token: string;
} {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const token = config.token.trim();
  if (token === '') {
    throw new Error('relay token is required');
  }
  return { baseUrl, token };
}

async function throwForBadStatus(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  const detail = await response.text().catch(() => '');
  throw new Error(
    `transcribe request failed (HTTP ${response.status}): ${detail.slice(0, 200)}`,
  );
}

async function* yieldTranscribeEvents(
  response: Response,
): AsyncGenerator<TranscribeEvent, void, void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('relay response has no readable body');
  }
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) {
            continue;
          }
          const data = trimmed.slice('data:'.length).trim();
          if (data === '' || data === '[DONE]') {
            continue;
          }
          try {
            yield JSON.parse(data) as TranscribeEvent;
          } catch {
            yield { type: 'error', message: 'unparseable SSE frame' };
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* streamTranscribe(
  config: RelayConfig,
  request: TranscribeRequest,
  signal?: AbortSignal,
): AsyncGenerator<TranscribeEvent, void, void> {
  const { baseUrl, token } = validatedConfig(config);
  if (request.value.trim() === '') {
    throw new Error('transcribe source must not be empty');
  }
  const response = await expoFetch(`${baseUrl}/api/transcribe`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      source: {
        kind: request.kind,
        value: request.value.trim(),
        index: request.index,
      },
      language: request.language,
      diarize: request.diarize,
      model: request.model,
    }),
    signal,
  });
  await throwForBadStatus(response);
  yield* yieldTranscribeEvents(response);
}

/**
 * Upload a locally picked audio file (multipart `audio` field) to
 * POST {relayUrl}/api/transcribe and yield the same SSE events as
 * streamTranscribe. No Content-Type header: fetch sets the multipart
 * boundary automatically.
 */
export async function* streamTranscribeUpload(
  config: RelayConfig,
  file: TranscribeUploadFile,
  options: TranscribeUploadOptions,
  signal?: AbortSignal,
): AsyncGenerator<TranscribeEvent, void, void> {
  const { baseUrl, token } = validatedConfig(config);
  if (file.uri.trim() === '') {
    throw new Error('transcribe file uri must not be empty');
  }
  const form = new FormData();
  form.append('audio', {
    uri: file.uri,
    name: file.name,
    type: file.mimeType ?? 'application/octet-stream',
  } as unknown as Blob);
  if (options.language !== undefined && options.language.trim() !== '') {
    form.append('language', options.language.trim());
  }
  if (options.diarize !== undefined) {
    form.append('diarize', String(options.diarize));
  }
  if (options.model !== undefined && options.model.trim() !== '') {
    form.append('model', options.model.trim());
  }
  const response = await expoFetch(`${baseUrl}/api/transcribe`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'text/event-stream',
    },
    body: form,
    signal,
  });
  await throwForBadStatus(response);
  yield* yieldTranscribeEvents(response);
}

export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const m = Math.floor(s / 60);
  const sec = (s - m * 60).toFixed(3).padStart(6, '0');
  return `${String(m).padStart(2, '0')}:${sec}`;
}
