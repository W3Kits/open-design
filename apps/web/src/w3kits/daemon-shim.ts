import { isW3KitsRuntimeAvailable } from './bridge';
import { listWorkspaceFiles, readWorkspaceFile, readWorkspaceText, syncWorkspaceToCore, writeWorkspaceFile } from './workspace';
import type { Project, SkillSummary } from '../types';
import { randomUUID } from '../utils/uuid';

const PROJECTS_INDEX = '/workspace/projects/index.json';
const DEFAULT_PROJECT_DIR = '/workspace/projects';
const EMPTY_SKILLS: SkillSummary[] = [];
const W3KITS_OPENAI_BASE_URL = 'https://w3kits.com/api/ai/openai/v1';
const W3KITS_PLUGIN_ID = 'opendesign';
const W3KITS_RUNTIME_SESSION_REQUEST = 'W3KITS_RUNTIME_SESSION_REQUEST';
const W3KITS_RESPONSE = 'W3KITS_RESPONSE';

interface W3KitsRuntimeSession {
  token: string;
  expiresIn: number;
  pluginId: string;
  pluginVersion: string;
  packageName?: string;
  packageIntegrity?: string;
  runtimeSessionHeader: string;
  identityHeaders?: Record<string, string | undefined>;
}

let cachedRuntimeSession: { value: W3KitsRuntimeSession; expiresAt: number } | null = null;

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

interface ProjectIndexEntry {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  skillId: string | null;
  designSystemId: string | null;
  pendingPrompt?: string;
  metadata?: Project['metadata'];
}

function jsonResponse(payload: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(payload: string, status = 200, contentType = 'text/plain;charset=utf-8'): Response {
  return new Response(payload, { status, headers: { 'content-type': contentType } });
}

function parentOrigin(): string {
  try {
    return new URL(W3KITS_OPENAI_BASE_URL).origin;
  } catch {
    return 'https://w3kits.com';
  }
}

function notifyAuthRequired(): void {
  try {
    window.parent?.postMessage({ type: 'W3KITS_AUTH_REQUIRED', version: 1, pluginId: W3KITS_PLUGIN_ID, reason: 'ai_request' }, parentOrigin());
  } catch {
    // Best-effort signal to the outer W3Kits shell.
  }
}

function bridgeRequest<T>(message: Record<string, unknown>, timeoutMs = 10000): Promise<T> {
  if (typeof window === 'undefined' || window.parent === window) return Promise.reject(new Error('W3Kits runtime bridge is unavailable.'));
  const requestId = 'opendesign-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const targetOrigin = parentOrigin();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      window.removeEventListener('message', onMessage);
      reject(new Error('W3Kits runtime bridge timed out.'));
    }, timeoutMs);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      if (event.origin !== targetOrigin) return;
      const data = event.data as { type?: unknown; requestId?: unknown; ok?: unknown; data?: unknown; error?: { code?: unknown; message?: unknown } };
      if (data?.type !== W3KITS_RESPONSE || data.requestId !== requestId) return;
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
      if (data.ok) resolve(data.data as T);
      else reject(new Error(typeof data.error?.message === 'string' ? data.error.message : typeof data.error?.code === 'string' ? data.error.code : 'W3Kits runtime bridge failed.'));
    };
    window.addEventListener('message', onMessage);
    window.parent.postMessage({ ...message, version: 1, requestId }, targetOrigin);
  });
}

async function getRuntimeSession(): Promise<W3KitsRuntimeSession> {
  const now = Date.now();
  if (cachedRuntimeSession && cachedRuntimeSession.expiresAt - now > 30000) return cachedRuntimeSession.value;
  const value = await bridgeRequest<W3KitsRuntimeSession>({
    type: W3KITS_RUNTIME_SESSION_REQUEST,
    pluginId: W3KITS_PLUGIN_ID,
    origin: window.location.origin,
  });
  cachedRuntimeSession = { value, expiresAt: now + Math.max(30, value.expiresIn - 30) * 1000 };
  return value;
}

async function w3kitsOpenAiHeaders(): Promise<Record<string, string>> {
  const session = await getRuntimeSession();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-w3kits-runtime-session': session.token,
    'x-w3kits-plugin-id': session.pluginId || W3KITS_PLUGIN_ID,
    'x-w3kits-plugin-version': session.pluginVersion,
  };
  for (const [key, value] of Object.entries(session.identityHeaders || {})) {
    if (typeof value === 'string' && value) headers[key] = value;
  }
  if (session.packageName) headers['x-w3kits-plugin-package'] = session.packageName;
  if (session.packageIntegrity) headers['x-w3kits-plugin-integrity'] = session.packageIntegrity;
  return headers;
}

function sseFrame(event: string, data: JsonValue): string {
  return 'event: ' + event + '\n' + 'data: ' + JSON.stringify(data) + '\n\n';
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  const text = await readWorkspaceText(path);
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, payload: JsonValue): Promise<void> {
  await writeWorkspaceFile(path, JSON.stringify(payload, null, 2), { contentType: 'application/json' });
}

function projectFromEntry(entry: ProjectIndexEntry): Project {
  return {
    id: entry.id,
    name: entry.name,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    skillId: entry.skillId,
    designSystemId: entry.designSystemId,
    ...(entry.pendingPrompt ? { pendingPrompt: entry.pendingPrompt } : {}),
    ...(entry.metadata ? { metadata: entry.metadata } : {}),
  } as Project;
}

function projectDir(projectId: string): string {
  return DEFAULT_PROJECT_DIR + '/' + projectId;
}

function filePath(projectId: string, path: string): string {
  const clean = path.replace(/^\/+/, '');
  return projectDir(projectId) + '/files/' + clean;
}

function safeRelativePath(path: string): string | null {
  if (!path || path.includes('\\') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return null;
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null;
  return segments.join('/');
}

async function listProjectIndex(): Promise<ProjectIndexEntry[]> {
  return readJson<ProjectIndexEntry[]>(PROJECTS_INDEX, []);
}

async function saveProjectIndex(index: ProjectIndexEntry[]): Promise<void> {
  await writeJson(PROJECTS_INDEX, index);
}

async function handleProjects(request: Request, url: URL): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean);
  const index = await listProjectIndex();
  if (request.method === 'GET' && parts.length === 2) {
    return jsonResponse({ projects: index.map(projectFromEntry) });
  }
  if (request.method === 'POST' && parts.length === 2) {
    const body = await request.json().catch(() => ({})) as Partial<ProjectIndexEntry> & { id?: string };
    const now = Date.now();
    const entry: ProjectIndexEntry = {
      id: body.id || randomUUID(),
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Untitled design',
      createdAt: now,
      updatedAt: now,
      skillId: body.skillId ?? null,
      designSystemId: body.designSystemId ?? null,
      pendingPrompt: typeof body.pendingPrompt === 'string' ? body.pendingPrompt : undefined,
      metadata: body.metadata,
    };
    await saveProjectIndex([entry, ...index.filter((item) => item.id !== entry.id)]);
    await writeJson(projectDir(entry.id) + '/project.json', entry as unknown as JsonValue);
    await writeWorkspaceFile(filePath(entry.id, 'DESIGN.md'), '# ' + entry.name + '\n', { contentType: 'text/markdown;charset=utf-8' });
    return jsonResponse({ project: projectFromEntry(entry), conversationId: randomUUID() });
  }
  const projectId = parts[2];
  if (!projectId) return jsonResponse({ error: 'not_found' }, 404);
  const entry = index.find((item) => item.id === projectId);
  if (!entry) return jsonResponse({ error: 'project_not_found' }, 404);
  if (request.method === 'GET' && parts.length === 3) return jsonResponse({ project: projectFromEntry(entry) });
  if (request.method === 'PATCH' && parts.length === 3) {
    const patch = await request.json().catch(() => ({})) as Partial<ProjectIndexEntry>;
    const next = { ...entry, ...patch, id: entry.id, updatedAt: Date.now() };
    await saveProjectIndex(index.map((item) => (item.id === entry.id ? next : item)));
    await writeJson(projectDir(entry.id) + '/project.json', next as unknown as JsonValue);
    return jsonResponse({ project: projectFromEntry(next) });
  }
  if (request.method === 'GET' && parts[3] === 'files') {
    const entries = await listWorkspaceFiles(projectDir(projectId) + '/files');
    return jsonResponse({ files: entries.filter((item) => item.kind === 'file').map((item) => ({ name: item.path.split('/').pop() || item.path, path: item.path.replace(projectDir(projectId) + '/files/', ''), kind: 'file', size: item.size ?? 0 })) });
  }
  if (request.method === 'POST' && parts[3] === 'files') {
    const body = await request.json().catch(() => ({})) as { path?: string; name?: string; content?: string };
    const targetPath = body.path || body.name || 'untitled.txt';
    await writeWorkspaceFile(filePath(projectId, targetPath), body.content ?? '', { contentType: 'text/plain;charset=utf-8' });
    return jsonResponse({ ok: true });
  }
  if (request.method === 'GET' && parts[3] === 'raw') {
    const rawPath = decodeURIComponent(parts.slice(4).join('/'));
    const body = await readWorkspaceText(filePath(projectId, rawPath));
    return body == null ? textResponse('Not found', 404) : textResponse(body, 200, contentTypeFor(rawPath));
  }
  return jsonResponse({ error: 'unsupported_in_w3kits_web_mode' }, 404);
}

function contentTypeFor(path: string): string {
  if (path.endsWith('.html')) return 'text/html;charset=utf-8';
  if (path.endsWith('.css')) return 'text/css;charset=utf-8';
  if (path.endsWith('.js') || path.endsWith('.mjs')) return 'application/javascript;charset=utf-8';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.md')) return 'text/markdown;charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  return 'text/plain;charset=utf-8';
}

async function handleArtifacts(request: Request, url: URL): Promise<Response> {
  if (request.method !== 'GET') return jsonResponse({ error: 'method_not_allowed' }, 405);
  const parts = url.pathname.split('/').filter(Boolean);
  const projectId = parts[1];
  let artifactPath: string;
  try {
    artifactPath = decodeURIComponent(parts.slice(2).join('/'));
  } catch {
    return textResponse('Not found', 404);
  }
  artifactPath = safeRelativePath(artifactPath) ?? '';
  if (!projectId || !artifactPath) return textResponse('Not found', 404);

  const candidates = [
    filePath(projectId, '.od/artifacts/' + artifactPath),
    projectDir(projectId) + '/.od/artifacts/' + artifactPath,
    filePath(projectId, artifactPath),
  ];
  for (const path of candidates) {
    const body = await readWorkspaceFile(path);
    if (!body) continue;
    const payload = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    return new Response(payload, { status: 200, headers: { 'content-type': contentTypeFor(artifactPath) } });
  }
  return textResponse('Not found', 404);
}

async function handleOpenAiProxy(request: Request): Promise<Response> {
  if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);
  const body = await request.json().catch(() => ({})) as {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    systemPrompt?: string;
    messages?: Array<{ role: string; content: string }>;
    maxTokens?: number;
  };
  const messages = [
    ...(body.systemPrompt ? [{ role: 'system', content: body.systemPrompt }] : []),
    ...((body.messages ?? []).map((message) => ({ role: message.role, content: message.content }))),
  ];
  const baseUrl = (body.baseUrl || W3KITS_OPENAI_BASE_URL).replace(/\/+$/, '');
  const upstream = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    credentials: 'include',
    headers: await w3kitsOpenAiHeaders(),
    body: JSON.stringify({
      model: body.model || 'gpt-4o-mini',
      messages,
      stream: true,
      ...(body.maxTokens ? { max_tokens: body.maxTokens } : {}),
    }),
  });
  if (upstream.status === 401) notifyAuthRequired();
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    return textResponse(sseFrame('error', { message: text || 'OpenAI proxy failed (' + upstream.status + ')' }), 200, 'text/event-stream;charset=utf-8');
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      let buffer = '';
      let acc = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          while (true) {
            const match = buffer.match(/\r?\n\r?\n/);
            if (!match || match.index === undefined) break;
            const frame = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            for (const line of frame.split(/\r?\n/)) {
              if (!line.startsWith('data:')) continue;
              const data = line.slice('data:'.length).trim();
              if (!data || data === '[DONE]') continue;
              const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> };
              const delta = parsed.choices?.[0]?.delta?.content ?? '';
              if (delta) {
                acc += delta;
                controller.enqueue(encoder.encode(sseFrame('delta', { delta })));
              }
            }
          }
        }
        controller.enqueue(encoder.encode(sseFrame('end', { text: acc })));
        controller.close();
      } catch (error) {
        controller.enqueue(encoder.encode(sseFrame('error', { message: error instanceof Error ? error.message : 'OpenAI stream failed' })));
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream;charset=utf-8' } });
}

export async function handleW3KitsDaemonRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/health') return jsonResponse({ ok: true, mode: 'w3kits-web' });
  if (url.pathname === '/api/active') return jsonResponse({ ok: true });
  if (url.pathname === '/api/app-config') return jsonResponse({ config: { onboardingCompleted: true } });
  if (url.pathname === '/api/agents') return jsonResponse({ agents: [] });
  if (url.pathname === '/api/skills') return jsonResponse({ skills: EMPTY_SKILLS });
  if (url.pathname === '/api/design-templates') return jsonResponse({ designTemplates: [] });
  if (url.pathname === '/api/design-systems') return jsonResponse({ designSystems: [] });
  if (url.pathname === '/api/templates') return jsonResponse({ templates: [] });
  if (url.pathname === '/api/prompt-templates') return jsonResponse({ promptTemplates: [] });
  if (url.pathname === '/api/version') return jsonResponse({ version: 'w3kits-web' });
  if (url.pathname === '/api/proxy/openai/stream') return handleOpenAiProxy(request);
  if (url.pathname === '/api/w3kits/sync' && request.method === 'POST') return jsonResponse(await syncWorkspaceToCore() as unknown as JsonValue);
  if (url.pathname.startsWith('/api/projects')) return handleProjects(request, url);
  if (url.pathname.startsWith('/artifacts/')) return handleArtifacts(request, url);
  return fetch(request);
}

function installFetchShim(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === window.location.origin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/artifacts/'))) {
      return handleW3KitsDaemonRequest(request);
    }
    return originalFetch(input, init);
  }) as typeof window.fetch;
}

let installed = false;

export function installW3KitsDaemonShim(): void {
  if (installed || typeof window === 'undefined' || !isW3KitsRuntimeAvailable()) return;
  installed = true;
  installFetchShim();
}
