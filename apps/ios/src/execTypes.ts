/**
 * Shared exec UI event model (docs/EXEC-CONTRACT.md).
 *
 * Every platform renders these five events. iOS receives them as SSE
 * `data: <json>` frames from the relay (`POST /api/exec`); the parser in
 * `./execParser` produces the same shapes from raw `muse exec --json` JSONL.
 */

export interface ExecStartedEvent {
  type: 'started';
  runId: string;
}

export interface ExecDeltaEvent {
  type: 'delta';
  text: string;
}

export interface ExecLogEvent {
  type: 'log';
  stream: 'stderr' | 'info';
  text: string;
}

export interface ExecDoneEvent {
  type: 'done';
  text: string;
  terminal: string;
  exitCode: number;
}

export interface ExecErrorEvent {
  type: 'error';
  message: string;
}

export type ExecUIEvent =
  | ExecStartedEvent
  | ExecDeltaEvent
  | ExecLogEvent
  | ExecDoneEvent
  | ExecErrorEvent;

/** Relay `POST /api/exec` request body (docs/EXEC-CONTRACT.md). */
export interface RelayExecRequest {
  prompt: string;
  workspace?: string;
  model?: string;
  reasoningEffort?: string;
  approvalMode?: string;
  sessionId?: string;
  provider?: string;
}

/** Relay `GET /api/health` response body (docs/EXEC-CONTRACT.md). */
export interface RelayHealth {
  ok: boolean;
  museBin: string | null;
  museVersion: string | null;
}
