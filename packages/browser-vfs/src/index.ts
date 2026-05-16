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
    const etag = await sha256Hex(body);
    const updatedAt = new Date().toISOString();
    const metadata: WorkspaceFileStat = {
      path: normalized,
      size: body.byteLength,
      etag,
      revision: updatedAt + "-" + etag.slice(0, 12),
      updatedAt,
      ...(options.contentType ? { contentType: options.contentType } : {}),
    };
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
