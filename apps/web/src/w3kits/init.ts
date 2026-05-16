import { isW3KitsRuntimeAvailable, runtimeWrite } from './bridge';
import type { AppConfig } from '../types';

const STORAGE_KEY = 'open-design:config';
const W3KITS_OPENAI_BASE_URL = 'https://w3kits.com/api/ai/openai/v1';
const W3KITS_PLUGIN_API_KEY = 'w3kits-plugin-user';
const DEFAULT_MODEL = 'gpt-4o-mini';

export function buildW3KitsDefaultConfig(current: Partial<AppConfig> = {}): Partial<AppConfig> {
  return {
    ...current,
    mode: 'api',
    apiProtocol: 'openai',
    apiKey: current.apiKey || W3KITS_PLUGIN_API_KEY,
    baseUrl: current.baseUrl || W3KITS_OPENAI_BASE_URL,
    model: current.model || DEFAULT_MODEL,
    apiProviderBaseUrl: null,
    onboardingCompleted: true,
    apiProtocolConfigs: {
      ...(current.apiProtocolConfigs ?? {}),
      openai: {
        apiKey: current.apiKey || W3KITS_PLUGIN_API_KEY,
        baseUrl: current.baseUrl || W3KITS_OPENAI_BASE_URL,
        model: current.model || DEFAULT_MODEL,
        apiProviderBaseUrl: null,
      },
    },
  };
}

function seedLocalConfig(): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<AppConfig> : {};
    const next = buildW3KitsDefaultConfig(parsed);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Open Design already tolerates localStorage failures; keep adapter best effort.
  }
}

async function persistDefaultConfigToRuntime(): Promise<void> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    await runtimeWrite('/workspace/config/open-design.json', raw || JSON.stringify(buildW3KitsDefaultConfig()), { contentType: 'application/json' });
  } catch {
    // Runtime persistence is best effort during first paint.
  }
}

let installed = false;

export function installW3KitsOpenDesignAdapter(): void {
  if (installed || typeof window === 'undefined' || !isW3KitsRuntimeAvailable()) return;
  installed = true;
  seedLocalConfig();
  void persistDefaultConfigToRuntime();
}
