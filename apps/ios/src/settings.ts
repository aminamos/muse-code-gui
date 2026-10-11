/**
 * Persisted settings: relay URL + relay bearer token.
 *
 * iOS is remote-relay-only, so the relay URL has no localhost default —
 * the user must enter their relay address (LAN or Tailscale). The token is
 * the relay's own bearer token, never a provider API key.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export interface ExecSettings {
  relayUrl: string;
  relayToken: string;
  workspace: string;
  model: string;
  reasoningEffort: string;
  approvalMode: string;
}

export const DEFAULT_SETTINGS: ExecSettings = {
  relayUrl: '',
  relayToken: '',
  workspace: '',
  model: '',
  reasoningEffort: '',
  approvalMode: 'on-request',
};

const KEYS = {
  relayUrl: 'muse-code-gui.relayUrl',
  relayToken: 'muse-code-gui.relayToken',
  workspace: 'muse-code-gui.workspace',
  model: 'muse-code-gui.model',
  reasoningEffort: 'muse-code-gui.reasoningEffort',
  approvalMode: 'muse-code-gui.approvalMode',
};

export async function loadSettings(): Promise<ExecSettings> {
  try {
    const pairs = await AsyncStorage.multiGet(Object.values(KEYS));
    const map = new Map(pairs.map(([k, v]) => [k, v ?? '']));
    return {
      relayUrl: map.get(KEYS.relayUrl) ?? '',
      relayToken: map.get(KEYS.relayToken) ?? '',
      workspace: map.get(KEYS.workspace) ?? '',
      model: map.get(KEYS.model) ?? '',
      reasoningEffort: map.get(KEYS.reasoningEffort) ?? '',
      approvalMode: map.get(KEYS.approvalMode) ?? 'on-request',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: ExecSettings): Promise<void> {
  await AsyncStorage.multiSet([
    [KEYS.relayUrl, settings.relayUrl],
    [KEYS.relayToken, settings.relayToken],
    [KEYS.workspace, settings.workspace],
    [KEYS.model, settings.model],
    [KEYS.reasoningEffort, settings.reasoningEffort],
    [KEYS.approvalMode, settings.approvalMode],
  ]);
}
