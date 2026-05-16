import { handleW3KitsDaemonRequest, installW3KitsDaemonShim } from './daemon-shim';
import { isW3KitsRuntimeAvailable, runtimeWrite } from './bridge';
import type { AppConfig } from '../types';

const STORAGE_KEY = 'open-design:config';
const W3KITS_OPENAI_BASE_URL = 'https://w3kits.com/api/ai/openai/v1';
const W3KITS_PLUGIN_API_KEY = 'w3kits-plugin-user';
const DEFAULT_MODEL = 'gpt-4o-mini';

function bytesToBase64(body: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < body.length; index += chunkSize) {
    binary += String.fromCharCode(...body.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value: string | undefined): ArrayBuffer | undefined {
  if (!value) return undefined;
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

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

async function handleServiceWorkerDaemonMessage(event: MessageEvent): Promise<void> {
  const port = event.ports[0];
  const payload = event.data as { type?: string; request?: { url?: string; method?: string; headers?: [string, string][]; bodyBase64?: string } } | undefined;
  if (!port || payload?.type !== 'W3KITS_DAEMON_REQUEST' || !payload.request?.url) return;
  try {
    const response = await handleW3KitsDaemonRequest(new Request(payload.request.url, {
      method: payload.request.method || 'GET',
      headers: payload.request.headers || [],
      body: base64ToArrayBuffer(payload.request.bodyBase64),
    }));
    port.postMessage({
      status: response.status,
      headers: Array.from(response.headers.entries()),
      bodyBase64: bytesToBase64(new Uint8Array(await response.arrayBuffer())),
    });
  } catch (error) {
    port.postMessage({
      status: 500,
      headers: [['content-type', 'application/json']],
      bodyBase64: bytesToBase64(new TextEncoder().encode(JSON.stringify({ error: error instanceof Error ? error.message : 'w3kits_daemon_error' }))),
    });
  }
}

function registerW3KitsDaemonServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    void handleServiceWorkerDaemonMessage(event);
  });
  void navigator.serviceWorker.register('/w3kits-daemon-sw.js', { scope: '/' }).catch(() => undefined);
}

let installed = false;

export function installW3KitsOpenDesignAdapter(): void {
  if (installed || typeof window === 'undefined' || !isW3KitsRuntimeAvailable()) return;
  installed = true;
  seedLocalConfig();
  installW3KitsDaemonShim();
  registerW3KitsDaemonServiceWorker();
  void persistDefaultConfigToRuntime();
}
