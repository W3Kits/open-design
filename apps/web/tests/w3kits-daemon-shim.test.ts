// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildW3KitsDefaultConfig } from '../src/w3kits/init';

interface RuntimeFile {
  body: string;
  contentType?: string;
}

function installRuntimeBridge(files = new Map<string, RuntimeFile>(), parentMessages: unknown[] = []) {
  delete (window as typeof window & { __w3kitsBridgeListenerInstalled?: boolean }).__w3kitsBridgeListenerInstalled;
  const listeners: Array<(event: MessageEvent) => void> = [];
  let syncCalls = 0;
  const parent = {
    postMessage(message: { type: string; requestId: string; path?: string; bodyBase64?: string; contentType?: string }, _targetOrigin: string) {
      parentMessages.push(message);
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      const respond = (data: unknown, ok = true) => {
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener({ origin: 'https://w3kits.com', source: parent, data: { type: 'W3KITS_RESPONSE', version: 1, requestId: message.requestId, ok, data } } as unknown as MessageEvent);
          }
        });
      };
      if (message.type === 'W3KITS_RUNTIME_SESSION_REQUEST') {
        respond({
          token: 'runtime-token',
          expiresIn: 900,
          pluginId: 'opendesign',
          pluginVersion: '0.1.0',
          packageName: '@w3kits/plugin-opendesign',
          packageIntegrity: 'sha512-opendesign',
          runtimeSessionHeader: 'x-w3kits-runtime-session',
          identityHeaders: {
            'x-w3kits-plugin-id': 'opendesign',
            'x-w3kits-plugin-version': '0.1.0',
            'x-w3kits-plugin-package': '@w3kits/plugin-opendesign',
            'x-w3kits-plugin-integrity': 'sha512-opendesign',
          },
        });
        return;
      }
      if (message.type === 'W3KITS_RUNTIME_FS_READ') {
        const file = files.get(message.path || '');
        if (!file) {
          queueMicrotask(() => {
            for (const listener of listeners) {
              listener({ origin: 'https://w3kits.com', source: parent, data: { type: 'W3KITS_RESPONSE', version: 1, requestId: message.requestId, ok: false, error: { code: 'not_found', message: 'Runtime file was not found.' } } } as unknown as MessageEvent);
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
        syncCalls += 1;
        respond({ uploaded: 0, deleted: 0, retained: 0, unauthenticated: false, errors: [], syncCalls });
      }
    },
  };
  Object.defineProperty(window, 'parent', { value: parent, configurable: true });
  const originalAddEventListener = window.addEventListener.bind(window);
  vi.spyOn(window, 'addEventListener').mockImplementation((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
    if (type === 'message' && typeof listener === 'function') listeners.push(listener as (event: MessageEvent) => void);
    return originalAddEventListener(type, listener, options);
  });
  return { files, getSyncCalls: () => syncCalls };
}

describe('W3Kits OpenDesign adapter', () => {
  afterEach(() => {
    delete (window as typeof window & { __w3kitsBridgeListenerInstalled?: boolean }).__w3kitsBridgeListenerInstalled;
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

  it('handles project create locally and syncs dirty files through the W3Kits runtime VFS bridge', async () => {
    const bridge = installRuntimeBridge();
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
    expect(bridge.files.get('/workspace/projects/p_1/files/DESIGN.md')).toBeUndefined();

    const rawResponse = await handleW3KitsDaemonRequest(new Request('https://plugin-opendesign.w3kits.com/api/projects/p_1/raw/DESIGN.md'));
    expect(await rawResponse.text()).toBe('# Landing\n');

    const listResponse = await handleW3KitsDaemonRequest(new Request('https://plugin-opendesign.w3kits.com/api/projects'));
    const listed = await listResponse.json() as { projects: Array<{ id: string; name: string }> };
    expect(listed.projects).toEqual([{ id: 'p_1', name: 'Landing', createdAt: expect.any(Number), updatedAt: expect.any(Number), skillId: null, designSystemId: null }]);

    const syncResponse = await handleW3KitsDaemonRequest(new Request('https://plugin-opendesign.w3kits.com/api/w3kits/sync', { method: 'POST' }));
    expect(syncResponse.status).toBe(200);
    expect(await syncResponse.json()).toMatchObject({ uploaded: 3, errors: [] });
    expect(bridge.getSyncCalls()).toBe(1);
    expect(bridge.files.get('/workspace/projects/p_1/files/DESIGN.md')?.body).toBe('# Landing\n');
  });

  it('serves project artifacts from the browser VFS workspace', async () => {
    installRuntimeBridge();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('fallback', { status: 599 })));
    const { handleW3KitsDaemonRequest } = await import('../src/w3kits/daemon-shim');

    await handleW3KitsDaemonRequest(new Request('https://plugin-opendesign.w3kits.com/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'p_artifact', name: 'Artifact project' }),
    }));
    await handleW3KitsDaemonRequest(new Request('https://plugin-opendesign.w3kits.com/api/projects/p_artifact/files', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '.od/artifacts/a/index.html', content: '<main>Artifact</main>' }),
    }));

    const response = await handleW3KitsDaemonRequest(new Request('https://plugin-opendesign.w3kits.com/artifacts/p_artifact/a/index.html'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toBe('<main>Artifact</main>');

    const escaped = await handleW3KitsDaemonRequest(new Request('https://plugin-opendesign.w3kits.com/artifacts/p_artifact/../index.html'));
    expect(escaped.status).toBe(404);
  });

  it('reloads projects and artifacts from the W3Kits runtime VFS bridge', async () => {
    const now = Date.now();
    installRuntimeBridge(new Map<string, RuntimeFile>([
      ['/workspace/projects/index.json', { body: JSON.stringify([{ id: 'p_remote', name: 'Remote project', createdAt: now, updatedAt: now, skillId: null, designSystemId: null }]), contentType: 'application/json' }],
      ['/workspace/projects/p_remote/files/DESIGN.md', { body: '# Remote project\n', contentType: 'text/markdown;charset=utf-8' }],
      ['/workspace/projects/p_remote/files/.od/artifacts/remote/index.html', { body: '<main>Remote artifact</main>', contentType: 'text/html;charset=utf-8' }],
    ]));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('fallback', { status: 599 })));
    const { handleW3KitsDaemonRequest } = await import('../src/w3kits/daemon-shim');

    const projectsResponse = await handleW3KitsDaemonRequest(new Request('https://plugin-opendesign.w3kits.com/api/projects'));
    expect(await projectsResponse.json()).toEqual({ projects: [{ id: 'p_remote', name: 'Remote project', createdAt: now, updatedAt: now, skillId: null, designSystemId: null }] });

    const rawResponse = await handleW3KitsDaemonRequest(new Request('https://plugin-opendesign.w3kits.com/api/projects/p_remote/raw/DESIGN.md'));
    expect(await rawResponse.text()).toBe('# Remote project\n');

    const artifactResponse = await handleW3KitsDaemonRequest(new Request('https://plugin-opendesign.w3kits.com/artifacts/p_remote/remote/index.html'));
    expect(artifactResponse.status).toBe(200);
    expect(await artifactResponse.text()).toBe('<main>Remote artifact</main>');
  });

  it('ships the plugin-scoped Service Worker daemon relay asset', () => {
    const source = readFileSync(join(process.cwd(), 'public/w3kits-daemon-sw.js'), 'utf8');

    expect(source).toContain('W3KITS_DAEMON_REQUEST');
    expect(source).toContain("url.pathname.startsWith('/api/')");
    expect(source).toContain("url.pathname.startsWith('/artifacts/')");
  });

  it('proxies OpenAI-compatible streaming through W3Kits and signals auth when needed', async () => {
    const parentMessages: unknown[] = [];
    installRuntimeBridge(new Map(), parentMessages);
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
      headers: expect.objectContaining({
        'x-w3kits-runtime-session': 'runtime-token',
        'x-w3kits-plugin-id': 'opendesign',
        'x-w3kits-plugin-version': '0.1.0',
        'x-w3kits-plugin-package': '@w3kits/plugin-opendesign',
        'x-w3kits-plugin-integrity': 'sha512-opendesign',
      }),
    }));
    expect(await readText(response)).toContain('event: error');
    expect(parentMessages).toContainEqual(expect.objectContaining({ type: 'W3KITS_AUTH_REQUIRED', reason: 'ai_request', pluginId: 'opendesign' }));
  });
});

function readText(response: Response): Promise<string> {
  return response.text();
}
