const W3KITS_RESPONSE = 'W3KITS_RESPONSE';
const W3KITS_RUNTIME_FS_READ = 'W3KITS_RUNTIME_FS_READ';
const W3KITS_RUNTIME_FS_WRITE = 'W3KITS_RUNTIME_FS_WRITE';
const W3KITS_RUNTIME_FS_DELETE = 'W3KITS_RUNTIME_FS_DELETE';
const W3KITS_RUNTIME_FS_LIST = 'W3KITS_RUNTIME_FS_LIST';
const W3KITS_RUNTIME_FS_SYNC = 'W3KITS_RUNTIME_FS_SYNC';
const W3KITS_RUNTIME_API_CALL = 'W3KITS_RUNTIME_API_CALL';

export interface W3KitsBridgeResponse<T = unknown> {
  type: typeof W3KITS_RESPONSE;
  version: 1;
  requestId: string;
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export interface W3KitsRuntimeFileMetadata {
  path: string;
  size: number;
  etag: string;
  revision: string;
  updatedAt: string;
  contentType?: string;
  dirty: boolean;
  readonly?: boolean;
}

export interface W3KitsRuntimeListEntry extends Partial<W3KitsRuntimeFileMetadata> {
  kind: 'file' | 'directory';
  path: string;
}

export interface W3KitsRuntimeSyncResult {
  uploaded: number;
  deleted: number;
  retained: number;
  unauthenticated: boolean;
  errors: Array<{ path: string; status?: number; error: string }>;
}

interface PendingRequest {
  resolve: (value: W3KitsBridgeResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const REQUEST_TIMEOUT_MS = 30_000;
let requestSequence = 0;
const pending = new Map<string, PendingRequest>();

function bytesToBase64(body: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < body.length; index += chunkSize) {
    binary += String.fromCharCode(...body.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bridgeTarget(): Window | null {
  if (typeof window === 'undefined') return null;
  return window.parent && window.parent !== window ? window.parent : null;
}

export function isW3KitsRuntimeAvailable(): boolean {
  return Boolean(bridgeTarget());
}

function nextRequestId(): string {
  requestSequence += 1;
  return `opendesign_${Date.now().toString(36)}_${requestSequence.toString(36)}`;
}

function ensureListener(): void {
  if (typeof window === 'undefined') return;
  const marker = '__w3kitsBridgeListenerInstalled';
  const globalWindow = window as typeof window & { [marker]?: boolean };
  if (globalWindow[marker]) return;
  globalWindow[marker] = true;
  window.addEventListener('message', (event) => {
    const data = event.data as Partial<W3KitsBridgeResponse> | undefined;
    if (!data || data.type !== W3KITS_RESPONSE || typeof data.requestId !== 'string') return;
    const request = pending.get(data.requestId);
    if (!request) return;
    pending.delete(data.requestId);
    clearTimeout(request.timeout);
    request.resolve(data as W3KitsBridgeResponse);
  });
}

export async function sendW3KitsRuntimeMessage<T = unknown>(message: Record<string, unknown>): Promise<T> {
  ensureListener();
  const target = bridgeTarget();
  if (!target) throw new Error('W3Kits runtime is only available inside the W3Kits plugin iframe.');
  const requestId = nextRequestId();
  const response = await new Promise<W3KitsBridgeResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('W3Kits runtime request timed out.'));
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, { resolve, reject, timeout });
    target.postMessage({ version: 1, ...message, requestId }, '*');
  });
  if (!response.ok) throw new Error(response.error?.message || response.error?.code || 'W3Kits runtime request failed.');
  return response.data as T;
}

export async function runtimeRead(path: string): Promise<Uint8Array | null> {
  try {
    const data = await sendW3KitsRuntimeMessage<{ bodyBase64?: string; body?: string }>({ type: W3KITS_RUNTIME_FS_READ, path });
    if (data.bodyBase64) return base64ToBytes(data.bodyBase64);
    return TEXT_ENCODER.encode(data.body ?? '');
  } catch (error) {
    if (error instanceof Error && /not found/i.test(error.message)) return null;
    throw error;
  }
}

export async function runtimeReadText(path: string): Promise<string | null> {
  const body = await runtimeRead(path);
  return body ? TEXT_DECODER.decode(body) : null;
}

export async function runtimeWrite(path: string, body: Uint8Array | string, options: { contentType?: string; expectedEtag?: string } = {}): Promise<W3KitsRuntimeFileMetadata> {
  const bytes = typeof body === 'string' ? TEXT_ENCODER.encode(body) : body;
  const data = await sendW3KitsRuntimeMessage<{ metadata: W3KitsRuntimeFileMetadata }>({
    type: W3KITS_RUNTIME_FS_WRITE,
    path,
    bodyBase64: bytesToBase64(bytes),
    contentType: options.contentType,
    expectedEtag: options.expectedEtag,
  });
  return data.metadata;
}

export async function runtimeDelete(path: string, expectedEtag?: string): Promise<boolean> {
  const data = await sendW3KitsRuntimeMessage<{ deleted: boolean }>({ type: W3KITS_RUNTIME_FS_DELETE, path, expectedEtag });
  return data.deleted;
}

export async function runtimeList(path = '/workspace'): Promise<W3KitsRuntimeListEntry[]> {
  const data = await sendW3KitsRuntimeMessage<{ entries: W3KitsRuntimeListEntry[] }>({ type: W3KITS_RUNTIME_FS_LIST, path });
  return data.entries ?? [];
}

export async function runtimeSync(): Promise<W3KitsRuntimeSyncResult> {
  return sendW3KitsRuntimeMessage<W3KitsRuntimeSyncResult>({ type: W3KITS_RUNTIME_FS_SYNC });
}

export async function runtimeApiCall(input: { method: string; path: string; headers?: Record<string, string>; body?: Uint8Array | string }): Promise<{ status: number; headers?: Record<string, string>; body: Uint8Array }> {
  const bytes = typeof input.body === 'string' ? TEXT_ENCODER.encode(input.body) : input.body;
  const data = await sendW3KitsRuntimeMessage<{ status: number; headers?: Record<string, string>; bodyBase64?: string; body?: string }>({
    type: W3KITS_RUNTIME_API_CALL,
    method: input.method,
    path: input.path,
    headers: input.headers,
    bodyBase64: bytes ? bytesToBase64(bytes) : undefined,
  });
  return {
    status: data.status,
    headers: data.headers,
    body: data.bodyBase64 ? base64ToBytes(data.bodyBase64) : TEXT_ENCODER.encode(data.body ?? ''),
  };
}
