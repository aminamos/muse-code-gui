/**
 * Relay client for the exec SSE API (docs/EXEC-CONTRACT.md).
 *
 * iOS is remote-relay-only: it cannot spawn the `muse` binary, so every run
 * goes to `POST {relayUrl}/api/exec`, which returns `text/event-stream`
 * emitting the five UI events as `data: <json>` frames.
 *
 * Auth is a relay bearer token (`Authorization: Bearer <token>`).
 * Subscription-token rule: neither the client nor any relay request may
 * carry, inject, or persist a provider API key.
 */

import { fetch as expoFetch } from 'expo/fetch';

import type {
  ExecUIEvent,
  RelayExecRequest,
  RelayHealth,
} from './execTypes';

export interface RelayConfig {
  /** Base URL of the relay, e.g. https://relay.tailnet.ts.net (no default). */
  baseUrl: string;
  /** Relay bearer token. Never a provider API key. */
  token: string;
}

export interface ExecStreamOptions extends RelayExecRequest {
  signal?: AbortSignal;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (trimmed === '') {
    throw new Error('relay URL is required (iOS is remote-relay-only)');
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('relay URL must start with http:// or https://');
  }
  return trimmed;
}

function authHeaders(config: RelayConfig): Record<string, string> {
  const token = config.token.trim();
  if (token === '') {
    throw new Error('relay token is required');
  }
  return { Authorization: `Bearer ${token}` };
}

function isExecUIEvent(value: unknown): value is ExecUIEvent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const type = (value as { type?: unknown }).type;
  return (
    type === 'started' ||
    type === 'delta' ||
    type === 'log' ||
    type === 'done' ||
    type === 'error'
  );
}

/**
 * Parse one SSE `data:` payload into a UI event. Throws on unparseable
 * payloads so the caller can surface `error` and keep reading the stream.
 */
function parseSseData(data: string): ExecUIEvent {
  const event = JSON.parse(data) as unknown;
  if (!isExecUIEvent(event)) {
    throw new Error(`unexpected SSE event payload: ${data.slice(0, 120)}`);
  }
  return event;
}

async function throwForBadStatus(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 200);
  } catch {
    detail = '';
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`relay auth failed (HTTP ${response.status}): ${detail}`);
  }
  throw new Error(`relay request failed (HTTP ${response.status}): ${detail}`);
}

/**
 * Run a prompt on the relay and yield UI events as SSE frames arrive.
 * Pass an AbortSignal (from AbortController) to implement Stop.
 */
export async function* streamExec(
  config: RelayConfig,
  options: ExecStreamOptions,
): AsyncGenerator<ExecUIEvent, void, void> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const { signal, ...body } = options;
  if (body.prompt.trim() === '') {
    throw new Error('prompt must not be empty');
  }

  const response = await expoFetch(`${baseUrl}/api/exec`, {
    method: 'POST',
    headers: {
      ...authHeaders(config),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body satisfies RelayExecRequest),
    signal,
  });
  await throwForBadStatus(response);

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
            yield parseSseData(data);
          } catch (err) {
            yield {
              type: 'error',
              message:
                err instanceof Error ? err.message : 'unparseable SSE frame',
            };
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Check relay reachability and auth via `GET /api/health`. */
export async function checkHealth(config: RelayConfig): Promise<RelayHealth> {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const response = await expoFetch(`${baseUrl}/api/health`, {
    headers: authHeaders(config),
  });
  await throwForBadStatus(response);
  const health = (await response.json()) as Partial<RelayHealth>;
  return {
    ok: health.ok === true,
    museBin: typeof health.museBin === 'string' ? health.museBin : null,
    museVersion:
      typeof health.museVersion === 'string' ? health.museVersion : null,
  };
}
