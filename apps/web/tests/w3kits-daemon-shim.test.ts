// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildW3KitsDefaultConfig, installW3KitsOpenDesignAdapter } from '../src/w3kits/init';

interface RuntimeFile {
  body: string;
  contentType?: string;
}

function installRuntimeBridge(files = new Map<string, RuntimeFile>(), parentMessages: unknown[] = []) {
  delete (window as typeof window & { __w3kitsBridgeListenerInstalled?: boolean }).__w3kitsBridgeListenerInstalled;
  const listeners: Array<(event: MessageEvent) => void> = [];
  const parent = {
    postMessage(message: { type: string; requestId: string; path?: string; bodyBase64?: string; contentType?: string }, _targetOrigin: string) {
      parentMessages.push(message);
      const decoder = new TextDecoder();
      const respond = (data: unknown, ok = true) => {
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({ origin: 'https://w3kits.com', source: parent, data: { type: 'W3KITS_RESPONSE', version: 1, requestId: message.requestId, ok, data } } as unknown as MessageEvent);
          }
        });
      };
      if (message.type === 'W3KITS_RUNTIME_FS_WRITE') {
        const body = decoder.decode(Uint8Array.from(atob(message.bodyBase64 || ''), (char) => char.charCodeAt(0)));
        files.set(message.path || '', { body, contentType: message.contentType });
        respond({ metadata: { path: message.path, size: body.length, etag: 'etag', revision: 'rev', updatedAt: new Date(0).toISOString(), dirty: true, contentType: message.contentType } });
        return;
      }
      respond({}, false);
    },
  };
  Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  const originalAddEventListener = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === 'message' && typeof listener === 'function') listeners.push(listener as (event: MessageEvent) => void);
    return originalAddEventListener(type, listener, options);
  });
  return { files, parentMessages };
}

describe('W3Kits OpenDesign adapter', () => {
  afterEach(() => {
    delete (window as typeof window & { __w3kitsBridgeListenerInstalled?: boolean }).__w3kitsBridgeListenerInstalled;
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('seeds OpenDesign with the W3Kits OpenAI-compatible endpoint', () => {
    const config = buildW3KitsDefaultConfig({ model: '' });
    expect(config.mode).toBe('api');
    expect(config.apiProtocol).toBe('openai');
    expect(config.baseUrl).toBe('https://w3kits.com/api/ai/openai/v1');
    expect(config.apiKey).toBe('w3kits-plugin-user');
    expect(config.apiProtocolConfigs?.openai).toMatchObject({
      baseUrl: 'https://w3kits.com/api/ai/openai/v1',
      apiKey: 'w3kits-plugin-user',
      model: 'gpt-5.4-mini',
    });
  });

  it('persists default config through the W3Kits runtime VFS bridge without installing a fake daemon', async () => {
    const bridge = installRuntimeBridge();
    installW3KitsOpenDesignAdapter();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const localConfig = JSON.parse(window.localStorage.getItem('open-design:config') || '{}') as { baseUrl?: string };
    expect(localConfig.baseUrl).toBe('https://w3kits.com/api/ai/openai/v1');
    expect(bridge.files.get('/home/agent/.config/opendesign/config/open-design.json')?.body).toContain('https://w3kits.com/api/ai/openai/v1');
    expect(bridge.parentMessages).toEqual([expect.objectContaining({ type: 'W3KITS_RUNTIME_FS_WRITE' })]);
  });

  it('does not ship the removed fake daemon relay source or Service Worker', () => {
    const initSource = readFileSync(join(process.cwd(), 'src/w3kits/init.ts'), 'utf8');
    expect(initSource).not.toContain('daemon-shim');
    expect(initSource).not.toContain('W3KITS_DAEMON_REQUEST');
    expect(initSource).not.toContain('w3kits-daemon-sw');
    expect(existsSync(join(process.cwd(), 'src/w3kits/daemon-shim.ts'))).toBe(false);
    expect(existsSync(join(process.cwd(), 'public/w3kits-daemon-sw.js'))).toBe(false);
  });
});
