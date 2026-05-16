const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export class BrowserVfsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrowserVfsError";
  }
}

export interface WorkspaceFileStat {
  path: string;
  size: number;
  etag: string;
  revision: string;
  updatedAt: string;
  contentType?: string;
}

export interface WorkspaceFileEntry extends WorkspaceFileStat {
  kind: "file";
}

export interface WorkspaceDirectoryEntry {
  kind: "directory";
  path: string;
  size: 0;
  etag: "";
  revision: "";
  updatedAt: string;
}

export type WorkspaceEntry = WorkspaceFileEntry | WorkspaceDirectoryEntry;

export interface WorkspaceWriteOptions {
  contentType?: string;
}

export interface BrowserWorkspaceSnapshotFile {
  path: string;
  contentBase64: string;
  contentType?: string;
  updatedAt: string;
}

export interface BrowserWorkspaceSnapshot {
  version: 1;
  files: BrowserWorkspaceSnapshotFile[];
}

export interface BrowserWorkspaceBackend {
  stat(path: string): Promise<WorkspaceFileStat | null>;
  readFile(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, data: Uint8Array, options?: WorkspaceWriteOptions): Promise<WorkspaceFileStat>;
  deleteFile(path: string): Promise<boolean>;
  listFiles(prefix?: string): Promise<WorkspaceEntry[]>;
  clear(): Promise<void>;
}

export interface BrowserWorkspace {
  readFile(path: string): Promise<Uint8Array | null>;
  readText(path: string): Promise<string | null>;
  writeFile(path: string, data: Uint8Array | string, options?: WorkspaceWriteOptions): Promise<WorkspaceFileStat>;
  deleteFile(path: string): Promise<boolean>;
  stat(path: string): Promise<WorkspaceFileStat | null>;
  listFiles(prefix?: string): Promise<WorkspaceEntry[]>;
  dirtyPaths(): string[];
  markClean(paths?: Iterable<string>): void;
  exportSnapshot(): Promise<Uint8Array>;
  importSnapshot(data: Uint8Array | string, options?: { markDirty?: boolean }): Promise<void>;
}

export interface PersistentWorkspaceOptions {
  namespace?: string;
  globalScope?: Pick<typeof globalThis, "indexedDB" | "navigator">;
}

interface FileSystemFileHandleLike {
  createWritable(): Promise<{ write(data: Uint8Array): Promise<void> | void; close(): Promise<void> | void }>;
  getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>;
}

interface FileSystemDirectoryHandleLike {
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandleLike>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileSystemFileHandleLike>;
  removeEntry?(name: string, options?: { recursive?: boolean }): Promise<void>;
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export function normalizeWorkspacePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new BrowserVfsError("invalid_path", "Workspace path is required");
  if (trimmed === "/") return "/";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) throw new BrowserVfsError("invalid_path", "Workspace path must not be a URL");
  if (trimmed.includes("\\")) throw new BrowserVfsError("invalid_path", "Workspace path must use forward slashes");

  const segments = splitPath(trimmed);
  if (segments.length === 0) throw new BrowserVfsError("invalid_path", "Workspace path is required");
  for (const segment of segments) {
    if (segment === "." || segment === "..") throw new BrowserVfsError("path_traversal", "Workspace path must not traverse directories");
    if (!/^[A-Za-z0-9._@=,+~ -]+$/.test(segment)) throw new BrowserVfsError("invalid_path", "Workspace path contains unsupported characters");
  }
  return "/" + segments.join("/");
}

export function projectWorkspaceRoot(projectId: string): string {
  const normalized = normalizeWorkspacePath("/projects/" + projectId);
  const segments = splitPath(normalized);
  if (segments.length !== 2 || segments[0] !== "projects") throw new BrowserVfsError("invalid_project_id", "Project id must be a single safe path segment");
  return normalized;
}

function pathWithinPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/");
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? TEXT_ENCODER.encode(data) : data;
}

function bytesToBase64(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function fileStat(path: string, data: Uint8Array, options: WorkspaceWriteOptions = {}): Promise<WorkspaceFileStat> {
  return sha256Hex(data).then((etag) => {
    const updatedAt = new Date().toISOString();
    return {
      path,
      size: data.byteLength,
      etag,
      revision: updatedAt + "-" + etag.slice(0, 12),
      updatedAt,
      ...(options.contentType ? { contentType: options.contentType } : {}),
    };
  });
}

function directoryEntriesFor(files: WorkspaceFileEntry[], prefix: string): WorkspaceDirectoryEntry[] {
  const directories = new Set<string>();
  const root = prefix === "/" ? "/" : prefix.replace(/\/$/, "");
  for (const file of files) {
    if (!pathWithinPrefix(file.path, root)) continue;
    const relative = root === "/" ? file.path.slice(1) : file.path.slice(root.length + 1);
    const [first] = relative.split("/");
    if (first && relative.includes("/")) directories.add((root === "/" ? "" : root) + "/" + first);
  }
  const updatedAt = new Date(0).toISOString();
  return Array.from(directories, (path): WorkspaceDirectoryEntry => ({ kind: "directory", path, size: 0, etag: "", revision: "", updatedAt })).sort((a, b) => a.path.localeCompare(b.path));
}

export class MemoryWorkspaceBackend implements BrowserWorkspaceBackend {
  private readonly files = new Map<string, { body: Uint8Array; metadata: WorkspaceFileStat }>();

  async stat(path: string): Promise<WorkspaceFileStat | null> {
    return this.files.get(normalizeWorkspacePath(path))?.metadata ?? null;
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const file = this.files.get(normalizeWorkspacePath(path));
    return file ? new Uint8Array(file.body) : null;
  }

  async writeFile(path: string, data: Uint8Array, options: WorkspaceWriteOptions = {}): Promise<WorkspaceFileStat> {
    const normalized = normalizeWorkspacePath(path);
    if (normalized === "/") throw new BrowserVfsError("invalid_path", "Workspace file path must not be root");
    const body = new Uint8Array(data);
    const metadata = await fileStat(normalized, body, options);
    this.files.set(normalized, { body, metadata });
    return metadata;
  }

  async deleteFile(path: string): Promise<boolean> {
    return this.files.delete(normalizeWorkspacePath(path));
  }

  async listFiles(prefix = "/"): Promise<WorkspaceEntry[]> {
    const normalized = normalizeWorkspacePath(prefix);
    const files = Array.from(this.files.values(), (file): WorkspaceFileEntry => ({ ...file.metadata, kind: "file" }));
    const directFiles = files.filter((file) => {
      if (!pathWithinPrefix(file.path, normalized)) return false;
      const relative = normalized === "/" ? file.path.slice(1) : file.path.slice(normalized.length + 1);
      return relative.length > 0 && !relative.includes("/");
    });
    return [...directoryEntriesFor(files, normalized), ...directFiles].sort((a, b) => a.path.localeCompare(b.path));
  }

  async clear(): Promise<void> {
    this.files.clear();
  }
}

export class OpfsWorkspaceBackend implements BrowserWorkspaceBackend {
  private index: Map<string, WorkspaceFileStat> | null = null;

  private constructor(private readonly root: FileSystemDirectoryHandleLike) {}

  static async create(options: PersistentWorkspaceOptions = {}): Promise<OpfsWorkspaceBackend> {
    const scope = options.globalScope ?? globalThis;
    const getDirectory = scope.navigator?.storage?.getDirectory;
    if (typeof getDirectory !== "function") throw new BrowserVfsError("opfs_unavailable", "OPFS is not available");
    const storageRoot = await getDirectory.call(scope.navigator.storage) as FileSystemDirectoryHandleLike;
    const namespaceRoot = await storageRoot.getDirectoryHandle(options.namespace ?? "default", { create: true });
    return new OpfsWorkspaceBackend(namespaceRoot);
  }

  private async filesDirectory(): Promise<FileSystemDirectoryHandleLike> {
    return this.root.getDirectoryHandle("files", { create: true });
  }

  private async readIndex(): Promise<Map<string, WorkspaceFileStat>> {
    if (this.index) return this.index;
    try {
      const handle = await this.root.getFileHandle("index.json");
      const file = await handle.getFile();
      const json = TEXT_DECODER.decode(await file.arrayBuffer());
      const records = JSON.parse(json) as WorkspaceFileStat[];
      this.index = new Map(records.map((record) => [record.path, record]));
    } catch {
      this.index = new Map();
    }
    return this.index;
  }

  private async writeIndex(): Promise<void> {
    const index = await this.readIndex();
    const handle = await this.root.getFileHandle("index.json", { create: true });
    const writable = await handle.createWritable();
    await writable.write(TEXT_ENCODER.encode(JSON.stringify(Array.from(index.values()).sort((a, b) => a.path.localeCompare(b.path)))));
    await writable.close();
  }

  private fileName(path: string): string {
    return encodeURIComponent(path);
  }

  async stat(path: string): Promise<WorkspaceFileStat | null> {
    return (await this.readIndex()).get(normalizeWorkspacePath(path)) ?? null;
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const normalized = normalizeWorkspacePath(path);
    if (!(await this.readIndex()).has(normalized)) return null;
    try {
      const handle = await (await this.filesDirectory()).getFileHandle(this.fileName(normalized));
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async writeFile(path: string, data: Uint8Array, options: WorkspaceWriteOptions = {}): Promise<WorkspaceFileStat> {
    const normalized = normalizeWorkspacePath(path);
    if (normalized === "/") throw new BrowserVfsError("invalid_path", "Workspace file path must not be root");
    const body = new Uint8Array(data);
    const metadata = await fileStat(normalized, body, options);
    const handle = await (await this.filesDirectory()).getFileHandle(this.fileName(normalized), { create: true });
    const writable = await handle.createWritable();
    await writable.write(body);
    await writable.close();
    (await this.readIndex()).set(normalized, metadata);
    await this.writeIndex();
    return metadata;
  }

  async deleteFile(path: string): Promise<boolean> {
    const normalized = normalizeWorkspacePath(path);
    const index = await this.readIndex();
    const existed = index.delete(normalized);
    if (!existed) return false;
    await (await this.filesDirectory()).removeEntry?.(this.fileName(normalized));
    await this.writeIndex();
    return true;
  }

  async listFiles(prefix = "/"): Promise<WorkspaceEntry[]> {
    const normalized = normalizeWorkspacePath(prefix);
    const files = Array.from((await this.readIndex()).values(), (file): WorkspaceFileEntry => ({ ...file, kind: "file" }));
    const directFiles = files.filter((file) => {
      if (!pathWithinPrefix(file.path, normalized)) return false;
      const relative = normalized === "/" ? file.path.slice(1) : file.path.slice(normalized.length + 1);
      return relative.length > 0 && !relative.includes("/");
    });
    return [...directoryEntriesFor(files, normalized), ...directFiles].sort((a, b) => a.path.localeCompare(b.path));
  }

  async clear(): Promise<void> {
    const paths = Array.from((await this.readIndex()).keys());
    for (const path of paths) await (await this.filesDirectory()).removeEntry?.(this.fileName(path));
    this.index = new Map();
    await this.writeIndex();
  }
}

type IndexedDbRecord = { path: string; body: ArrayBuffer; metadata: WorkspaceFileStat };

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new BrowserVfsError("indexeddb_error", "IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new BrowserVfsError("indexeddb_aborted", "IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new BrowserVfsError("indexeddb_error", "IndexedDB transaction failed"));
  });
}

export class IndexedDbWorkspaceBackend implements BrowserWorkspaceBackend {
  private constructor(private readonly db: IDBDatabase) {}

  static async create(options: PersistentWorkspaceOptions = {}): Promise<IndexedDbWorkspaceBackend> {
    const scope = options.globalScope ?? globalThis;
    const indexedDB = scope.indexedDB;
    if (typeof indexedDB?.open !== "function") throw new BrowserVfsError("indexeddb_unavailable", "IndexedDB is not available");
    const request = indexedDB.open("w3kits-browser-vfs:" + (options.namespace ?? "default"), 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "path" });
    };
    return new IndexedDbWorkspaceBackend(await requestResult(request));
  }

  private store(mode: IDBTransactionMode): { store: IDBObjectStore; done: Promise<void> } {
    const transaction = this.db.transaction("files", mode);
    return { store: transaction.objectStore("files"), done: transactionDone(transaction) };
  }

  async stat(path: string): Promise<WorkspaceFileStat | null> {
    const { store } = this.store("readonly");
    const record = await requestResult(store.get(normalizeWorkspacePath(path))) as IndexedDbRecord | undefined;
    return record?.metadata ?? null;
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    const { store } = this.store("readonly");
    const record = await requestResult(store.get(normalizeWorkspacePath(path))) as IndexedDbRecord | undefined;
    return record ? new Uint8Array(record.body) : null;
  }

  async writeFile(path: string, data: Uint8Array, options: WorkspaceWriteOptions = {}): Promise<WorkspaceFileStat> {
    const normalized = normalizeWorkspacePath(path);
    if (normalized === "/") throw new BrowserVfsError("invalid_path", "Workspace file path must not be root");
    const body = new Uint8Array(data);
    const metadata = await fileStat(normalized, body, options);
    const { store, done } = this.store("readwrite");
    const buffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    await requestResult(store.put({ path: normalized, body: buffer, metadata } satisfies IndexedDbRecord));
    await done;
    return metadata;
  }

  async deleteFile(path: string): Promise<boolean> {
    const normalized = normalizeWorkspacePath(path);
    const existing = await this.stat(normalized);
    if (!existing) return false;
    const { store, done } = this.store("readwrite");
    await requestResult(store.delete(normalized));
    await done;
    return true;
  }

  async listFiles(prefix = "/"): Promise<WorkspaceEntry[]> {
    const normalized = normalizeWorkspacePath(prefix);
    const { store } = this.store("readonly");
    const records = await requestResult(store.getAll()) as IndexedDbRecord[];
    const files = records.map((record): WorkspaceFileEntry => ({ ...record.metadata, kind: "file" }));
    const directFiles = files.filter((file) => {
      if (!pathWithinPrefix(file.path, normalized)) return false;
      const relative = normalized === "/" ? file.path.slice(1) : file.path.slice(normalized.length + 1);
      return relative.length > 0 && !relative.includes("/");
    });
    return [...directoryEntriesFor(files, normalized), ...directFiles].sort((a, b) => a.path.localeCompare(b.path));
  }

  async clear(): Promise<void> {
    const { store, done } = this.store("readwrite");
    await requestResult(store.clear());
    await done;
  }
}

export async function createPersistentBrowserWorkspaceBackend(options: PersistentWorkspaceOptions = {}): Promise<BrowserWorkspaceBackend> {
  if (isOpfsAvailable(options.globalScope ?? globalThis)) {
    try {
      return await OpfsWorkspaceBackend.create(options);
    } catch {
      // Fall through to IndexedDB when OPFS exists but is unavailable for this context.
    }
  }
  if (isIndexedDbAvailable(options.globalScope ?? globalThis)) {
    try {
      return await IndexedDbWorkspaceBackend.create(options);
    } catch {
      // Fall through to memory so the plugin can keep an anonymous draft alive.
    }
  }
  return new MemoryWorkspaceBackend();
}

export async function createPersistentBrowserWorkspace(options: PersistentWorkspaceOptions = {}): Promise<BrowserWorkspace> {
  return createBrowserWorkspace(await createPersistentBrowserWorkspaceBackend(options));
}

export function createBrowserWorkspace(backend: BrowserWorkspaceBackend = new MemoryWorkspaceBackend()): BrowserWorkspace {
  const dirty = new Set<string>();
  return {
    async readFile(path) {
      return backend.readFile(path);
    },
    async readText(path) {
      const bytes = await backend.readFile(path);
      return bytes ? TEXT_DECODER.decode(bytes) : null;
    },
    async writeFile(path, data, options) {
      const metadata = await backend.writeFile(path, toBytes(data), options);
      dirty.add(metadata.path);
      return metadata;
    },
    async deleteFile(path) {
      const normalized = normalizeWorkspacePath(path);
      const deleted = await backend.deleteFile(normalized);
      if (deleted) dirty.add(normalized);
      return deleted;
    },
    stat(path) {
      return backend.stat(path);
    },
    listFiles(prefix) {
      return backend.listFiles(prefix);
    },
    dirtyPaths() {
      return Array.from(dirty).sort();
    },
    markClean(paths) {
      if (!paths) {
        dirty.clear();
        return;
      }
      for (const path of paths) dirty.delete(normalizeWorkspacePath(path));
    },
    async exportSnapshot() {
      const entries = await backend.listFiles("/");
      const allFiles = await collectFilesRecursive(backend, entries);
      const files: BrowserWorkspaceSnapshotFile[] = [];
      for (const entry of allFiles) {
        const body = await backend.readFile(entry.path);
        if (!body) continue;
        files.push({
          path: entry.path,
          contentBase64: bytesToBase64(body),
          ...(entry.contentType ? { contentType: entry.contentType } : {}),
          updatedAt: entry.updatedAt,
        });
      }
      return TEXT_ENCODER.encode(JSON.stringify({ version: 1, files } satisfies BrowserWorkspaceSnapshot));
    },
    async importSnapshot(data, options = {}) {
      const json = typeof data === "string" ? data : TEXT_DECODER.decode(data);
      const snapshot = JSON.parse(json) as BrowserWorkspaceSnapshot;
      if (snapshot.version !== 1 || !Array.isArray(snapshot.files)) throw new BrowserVfsError("invalid_snapshot", "Unsupported workspace snapshot");
      await backend.clear();
      dirty.clear();
      for (const file of snapshot.files) {
        const metadata = await backend.writeFile(file.path, base64ToBytes(file.contentBase64), file.contentType ? { contentType: file.contentType } : {});
        if (options.markDirty) dirty.add(metadata.path);
      }
    },
  };
}

async function collectFilesRecursive(backend: BrowserWorkspaceBackend, entries: WorkspaceEntry[]): Promise<WorkspaceFileEntry[]> {
  const files: WorkspaceFileEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "file") {
      files.push(entry);
      continue;
    }
    files.push(...await collectFilesRecursive(backend, await backend.listFiles(entry.path)));
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function isOpfsAvailable(globalScope: Pick<typeof globalThis, "navigator"> = globalThis): boolean {
  return typeof globalScope.navigator?.storage?.getDirectory === "function";
}

export function isIndexedDbAvailable(globalScope: Pick<typeof globalThis, "indexedDB"> = globalThis): boolean {
  return typeof globalScope.indexedDB?.open === "function";
}
