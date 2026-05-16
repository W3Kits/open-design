import { createPersistentBrowserWorkspace, type BrowserWorkspace, type WorkspaceEntry } from '@open-design/browser-vfs';
import { runtimeDelete, runtimeList, runtimeRead, runtimeWrite, type W3KitsRuntimeListEntry } from './bridge';

const WORKSPACE_NAMESPACE = 'opendesign-w3kits-web-mode-v1';
const workspacePromise = createPersistentBrowserWorkspace({ namespace: WORKSPACE_NAMESPACE });

function corePath(path: string): string {
  const normalized = path.startsWith('/') ? path : '/' + path;
  return '/workspace' + normalized;
}

function localPath(path: string): string {
  if (path === '/workspace') return '/';
  if (path.startsWith('/workspace/')) return path.slice('/workspace'.length);
  return path.startsWith('/') ? path : '/' + path;
}

function toRuntimeEntry(entry: WorkspaceEntry): W3KitsRuntimeListEntry {
  return { ...entry, path: corePath(entry.path) };
}

export async function getW3KitsBrowserWorkspace(): Promise<BrowserWorkspace> {
  return workspacePromise;
}

export async function readWorkspaceFile(path: string): Promise<Uint8Array | null> {
  const workspace = await getW3KitsBrowserWorkspace();
  const cached = await workspace.readFile(localPath(path));
  if (cached) return cached;
  const remote = await runtimeRead(corePath(localPath(path)));
  if (remote) await workspace.writeFile(localPath(path), remote);
  return remote;
}

export async function readWorkspaceText(path: string): Promise<string | null> {
  const body = await readWorkspaceFile(path);
  return body ? new TextDecoder().decode(body) : null;
}

export async function writeWorkspaceFile(path: string, body: Uint8Array | string, options: { contentType?: string } = {}) {
  const workspace = await getW3KitsBrowserWorkspace();
  return workspace.writeFile(localPath(path), body, options);
}

export async function deleteWorkspaceFile(path: string): Promise<boolean> {
  const workspace = await getW3KitsBrowserWorkspace();
  const deleted = await workspace.deleteFile(localPath(path));
  if (deleted) await runtimeDelete(corePath(localPath(path))).catch(() => false);
  return deleted;
}

export async function listWorkspaceFiles(path = '/'): Promise<W3KitsRuntimeListEntry[]> {
  const workspace = await getW3KitsBrowserWorkspace();
  const localEntries = await workspace.listFiles(localPath(path));
  if (localEntries.length) return localEntries.map(toRuntimeEntry);
  const remoteEntries = await runtimeList(corePath(localPath(path))).catch(() => []);
  for (const entry of remoteEntries) {
    if (entry.kind !== 'file') continue;
    const body = await runtimeRead(entry.path).catch(() => null);
    if (body) await workspace.writeFile(localPath(entry.path), body, entry.contentType ? { contentType: entry.contentType } : {});
  }
  return remoteEntries;
}

export async function syncWorkspaceToCore(): Promise<{ uploaded: number; deleted: number; retained: number; unauthenticated: boolean; errors: Array<{ path: string; status?: number; error: string }> }> {
  const workspace = await getW3KitsBrowserWorkspace();
  let uploaded = 0;
  const errors: Array<{ path: string; status?: number; error: string }> = [];
  for (const path of workspace.dirtyPaths()) {
    const body = await workspace.readFile(path);
    if (!body) continue;
    const metadata = await workspace.stat(path);
    try {
      await runtimeWrite(corePath(path), body, metadata?.contentType ? { contentType: metadata.contentType } : {});
      uploaded += 1;
    } catch (error) {
      errors.push({ path, error: error instanceof Error ? error.message : 'upload_failed' });
    }
  }
  if (errors.length === 0) workspace.markClean();
  return { uploaded, deleted: 0, retained: errors.length, unauthenticated: false, errors };
}
