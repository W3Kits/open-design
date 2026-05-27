import { isW3KitsRuntimeAvailable, runtimeWrite } from './bridge';
import type { AppConfig } from '../types';

const STORAGE_KEY = 'open-design:config';
const W3KITS_OPENAI_BASE_URL = 'https://w3kits.com/api/ai/openai/v1';
const W3KITS_PLUGIN_API_KEY = 'w3kits-plugin-user';
const W3KITS_PLUGIN_CONFIG_PATH = '/home/agent/.config/opendesign/config/open-design.json';
const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_IMAGE_MODEL = 'gpt-image-2';

function runtimeOpenAiBaseUrl(): string {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('w3kitsOpenAiBaseUrl') || params.get('openaiBaseUrl') || W3KITS_OPENAI_BASE_URL;
  } catch {
    return W3KITS_OPENAI_BASE_URL;
  }
}

function runtimeLocale(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('w3kitsLocale') || params.get('locale');
  } catch {
    return null;
  }
}

export function buildW3KitsDefaultConfig(current: Partial<AppConfig> = {}): Partial<AppConfig> {
  const openaiBaseUrl = typeof window === 'undefined' ? W3KITS_OPENAI_BASE_URL : runtimeOpenAiBaseUrl();
  return {
    ...current,
    mode: 'api',
    apiProtocol: 'openai',
    apiKey: current.apiKey || W3KITS_PLUGIN_API_KEY,
    baseUrl: current.baseUrl || openaiBaseUrl,
    model: current.model || DEFAULT_MODEL,
    apiProviderBaseUrl: null,
    onboardingCompleted: true,
    apiProtocolConfigs: {
      ...(current.apiProtocolConfigs ?? {}),
      openai: {
        apiKey: current.apiKey || W3KITS_PLUGIN_API_KEY,
        baseUrl: current.baseUrl || openaiBaseUrl,
        model: current.model || DEFAULT_MODEL,
        apiProviderBaseUrl: null,
      },
    },
    mediaProviders: {
      ...(current.mediaProviders ?? {}),
      openai: {
        ...(current.mediaProviders?.openai ?? {}),
        apiKey: current.mediaProviders?.openai?.apiKey || W3KITS_PLUGIN_API_KEY,
        baseUrl: current.mediaProviders?.openai?.baseUrl || openaiBaseUrl,
        model: current.mediaProviders?.openai?.model || DEFAULT_IMAGE_MODEL,
      },
    },
  };
}

function seedLocalConfig(): void {
  try {
    const locale = runtimeLocale();
    if (locale) window.localStorage.setItem('open-design:locale', locale);
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
    await runtimeWrite(W3KITS_PLUGIN_CONFIG_PATH, raw || JSON.stringify(buildW3KitsDefaultConfig()), { contentType: 'application/json' });
  } catch {
    // Runtime persistence is best effort during first paint.
  }
}

let installed = false;

export function installW3KitsOpenDesignAdapter(): void {
  if (typeof window === 'undefined' || !isW3KitsRuntimeAvailable()) return;
  if (installed) {
    seedLocalConfig();
    void persistDefaultConfigToRuntime();
    return;
  }
  installed = true;
  seedLocalConfig();
  void persistDefaultConfigToRuntime();
}
