// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildW3KitsDefaultConfig } from '../src/w3kits/init';

interface RuntimeFile {
  body: string;
  contentType?: string;
}

function installRuntimeBridge(files = new Map<string, RuntimeFile>()) {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const parent = {
    postMessage(message: { type: string; requestId: string; path?: string; bodyBase64?: string; contentType?: string }, _targetOrigin: string) {
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const respond = (data: unknown, ok = true) => {
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({ data: { type: 'W3KITS_RESPONSE', version: 1, requestId: message.requestId, ok, data } } as MessageEvent);
          }
        });
      };
      if (message.type === 'W3KITS_RUNTIME_FS_READ') {
        const file = files.get(message.path || '');
        if (!file) {
          queueMicrotask(() => {
            for (const listener of listeners) {
              listener({ data: { type: 'W3KITS_RESPONSE', version: 1, requestId: message.requestId, ok: false, error: { code: 'not_found', message: 'Runtime file was not found.' } } } as MessageEvent);
            }
          });
          return;
        }
        respond({ body: file.body, bodyBase64: btoa(file.body) });
        return;
      }
      if (message.type === 'W3KITS_RUNTIME_FS_WRITE') {
        const body = decoder.decode(Uint8Array.from(atob(message.bodyBase64 || ''), (char) => char.charCodeAt(0)));
        files.set(message.path || '', { body, contentType: message.contentType });
        respond({ metadata: { path: message.path, size: encoder.encode(body).byteLength, etag: 'etag', revision: 'rev', updatedAt: new Date(0).toISOString(), dirty: true, contentType: message.contentType } });
        return;
      }
      if (message.type === 'W3KITS_RUNTIME_FS_LIST') {
        const prefix = message.path || '/workspace';
        respond({ entries: Array.from(files.entries()).filter(([path]) => path.startsWith(prefix + '/')).map(([path, file]) => ({ kind: 'file', path, size: encoder.encode(file.body).byteLength, contentType: file.contentType, etag: 'etag', revision: 'rev', updatedAt: new Date(0).toISOString(), dirty: false })) });
        return;
      }
      if (message.type === 'W3KITS_RUNTIME_FS_SYNC') {
        respond({ uploaded: 0, deleted: 0, retained: 0, unauthenticated: false, errors: [] });
      }
    },
  };
  Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  const originalAddEventListener = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === 'message' && typeof listener === 'function') listeners.push(listener as (event: MessageEvent) => void);
    return originalAddEventListener(type, listener, options);
  });
  return files;
}

describe('W3Kits OpenDesign adapter', () => {
  afterEach(() => {
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
  });

  it('handles project create and list through the W3Kits runtime VFS bridge', async () => {
    const files = installRuntimeBridge();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('fallback', { status: 599 })));
    const { handleW3KitsDaemonRequest } = await import('../src/w3kits/daemon-shim');

    const createResponse = await handleW3KitsDaemonRequest(new Request('https://plugin-opendesign.w3kits.com/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'p_1', name: 'Landing', skillId: null, designSystemId: null }),
    }));

    expect(createResponse.status).toBe(200);
    const created = await createResponse.json() as { project: { id: string; name: string } };
    expect(created.project).toMatchObject({ id: 'p_1', name: 'Landing' });
    expect(files.get('/workspace/projects/p_1/files/DESIGN.md')?.body).toBe('# Landing\n');

    const listResponse = await handleW3KitsDaemonRequest(new Request('https://plugin-opendesign.w3kits.com/api/projects'));
    const listed = await listResponse.json() as { projects: Array<{ id: string; name: string }> };
    expect(listed.projects).toEqual([{ id: 'p_1', name: 'Landing', createdAt: expect.any(Number), updatedAt: expect.any(Number), skillId: null, designSystemId: null }]);
  });

  it('proxies OpenAI-compatible streaming through W3Kits and signals auth when needed', async () => {
    const parentMessages: unknown[] = [];
    Object.defineProperty(window, 'parent', { value: { postMessage: (message: unknown) => parentMessages.push(message) }, configurable: true });
    const fetchMock = vi.fn(async () => new Response('login required', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const { handleW3KitsDaemonRequest } = await import('../src/w3kits/daemon-shim');

    const response = await handleW3KitsDaemonRequest(new Request('https://plugin-opendesign.w3kits.com/api/proxy/openai/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://w3kits.com/api/ai/openai/v1', apiKey: 'w3kits-plugin-user', model: 'gpt-test', systemPrompt: 'system', messages: [{ role: 'user', content: 'hi' }] }),
    }));

    expect(fetchMock).toHaveBeenCalledWith('https://w3kits.com/api/ai/openai/v1/chat/completions', expect.objectContaining({
      credentials: 'include',
      headers: expect.objectContaining({ 'x-w3kits-plugin-id': 'opendesign' }),
    }));
    expect(await readText(response)).toContain('event: error');
    expect(parentMessages).toContainEqual(expect.objectContaining({ type: 'W3KITS_AUTH_REQUIRED', reason: 'ai_request', pluginId: 'opendesign' }));
  });
});

function readText(response: Response): Promise<string> {
  return response.text();
}
