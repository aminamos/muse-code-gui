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
}

export const DEFAULT_SETTINGS: ExecSettings = {
  relayUrl: '',
  relayToken: '',
};

const RELAY_URL_KEY = 'muse-code-gui.relayUrl';
const RELAY_TOKEN_KEY = 'muse-code-gui.relayToken';

export async function loadSettings(): Promise<ExecSettings> {
  try {
    const [relayUrl, relayToken] = await AsyncStorage.multiGet([
      RELAY_URL_KEY,
      RELAY_TOKEN_KEY,
    ]);
    return {
      relayUrl: relayUrl[1] ?? '',
      relayToken: relayToken[1] ?? '',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: ExecSettings): Promise<void> {
  await AsyncStorage.multiSet([
    [RELAY_URL_KEY, settings.relayUrl],
    [RELAY_TOKEN_KEY, settings.relayToken],
  ]);
}
