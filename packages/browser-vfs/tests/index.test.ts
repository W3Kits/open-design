import { describe, expect, it } from "vitest";

const TEST_DECODER = new TextDecoder();

function testText(bytes: Uint8Array | null): string | null {
  return bytes ? TEST_DECODER.decode(bytes) : null;
}

import {
  BrowserVfsError,
  IndexedDbWorkspaceBackend,
  MemoryWorkspaceBackend,
  OpfsWorkspaceBackend,
  createBrowserWorkspace,
  createPersistentBrowserWorkspaceBackend,
  isIndexedDbAvailable,
  isOpfsAvailable,
  normalizeWorkspacePath,
  projectWorkspaceRoot,
} from "../src/index.js";

describe("browser workspace path security", () => {
  it("normalizes safe workspace paths", () => {
    expect(normalizeWorkspacePath("projects/p_1/DESIGN.md")).toBe("/projects/p_1/DESIGN.md");
    expect(normalizeWorkspacePath("/.od/artifacts/a/index.html")).toBe("/.od/artifacts/a/index.html");
  });

  it("rejects traversal, URLs, backslashes, and unsafe project ids", () => {
    expect(() => normalizeWorkspacePath("../secrets.txt")).toThrow(BrowserVfsError);
    expect(() => normalizeWorkspacePath("https://example.com/file")).toThrow("Workspace path must not be a URL");
    expect(() => normalizeWorkspacePath("projects\\p_1")).toThrow("Workspace path must use forward slashes");
    expect(() => projectWorkspaceRoot("p_1/other")).toThrow("Project id must be a single safe path segment");
  });
});

describe("MemoryWorkspaceBackend", () => {
  it("writes, reads, lists, deletes, and tracks dirty paths", async () => {
    const workspace = createBrowserWorkspace(new MemoryWorkspaceBackend());
    await workspace.writeFile("/projects/p_1/DESIGN.md", "hello", { contentType: "text/markdown" });
    await workspace.writeFile("/projects/p_1/.od/artifacts/a/index.html", "<main>A</main>", { contentType: "text/html" });

    await expect(workspace.readText("/projects/p_1/DESIGN.md")).resolves.toBe("hello");
    await expect(workspace.stat("/projects/p_1/DESIGN.md")).resolves.toMatchObject({ path: "/projects/p_1/DESIGN.md", size: 5, contentType: "text/markdown" });
    await expect(workspace.listFiles("/projects/p_1")).resolves.toMatchObject([
      { kind: "directory", path: "/projects/p_1/.od" },
      { kind: "file", path: "/projects/p_1/DESIGN.md" },
    ]);
    expect(workspace.dirtyPaths()).toEqual(["/projects/p_1/.od/artifacts/a/index.html", "/projects/p_1/DESIGN.md"]);

    workspace.markClean(["/projects/p_1/DESIGN.md"]);
    expect(workspace.dirtyPaths()).toEqual(["/projects/p_1/.od/artifacts/a/index.html"]);
    await expect(workspace.deleteFile("/projects/p_1/.od/artifacts/a/index.html")).resolves.toBe(true);
    expect(workspace.dirtyPaths()).toEqual(["/projects/p_1/.od/artifacts/a/index.html"]);
  });

  it("exports and imports JSON snapshots", async () => {
    const source = createBrowserWorkspace();
    await source.writeFile("/projects/p_1/DESIGN.md", "hello", { contentType: "text/markdown" });
    await source.writeFile("/projects/p_1/.od/history.jsonl", "{}\n", { contentType: "application/jsonl" });
    source.markClean();

    const snapshot = await source.exportSnapshot();
    const target = createBrowserWorkspace();
    await target.importSnapshot(snapshot);

    await expect(target.readText("/projects/p_1/DESIGN.md")).resolves.toBe("hello");
    await expect(target.readText("/projects/p_1/.od/history.jsonl")).resolves.toBe("{}\n");
    expect(target.dirtyPaths()).toEqual([]);

    await target.importSnapshot(snapshot, { markDirty: true });
    expect(target.dirtyPaths()).toEqual(["/projects/p_1/.od/history.jsonl", "/projects/p_1/DESIGN.md"]);
  });
});

describe("browser storage feature detection", () => {
  it("detects OPFS and IndexedDB support from the provided global scope", () => {
    expect(isOpfsAvailable({ navigator: { storage: { getDirectory: async () => ({}) as FileSystemDirectoryHandle } } as Navigator })).toBe(true);
    expect(isOpfsAvailable({ navigator: {} as Navigator })).toBe(false);
    expect(isIndexedDbAvailable({ indexedDB: { open: (() => ({})) as unknown as IDBFactory["open"] } as IDBFactory })).toBe(true);
    expect(isIndexedDbAvailable({ indexedDB: undefined as unknown as IDBFactory })).toBe(false);
  });
});


describe("persistent browser workspace backend selection", () => {
  it("prefers OPFS when available", async () => {
    const root = new TestOpfsDirectory();
    const backend = await createPersistentBrowserWorkspaceBackend({
      namespace: "opendesign-test",
      globalScope: { navigator: { storage: { getDirectory: async () => root } } as unknown as Navigator, indexedDB: undefined as unknown as IDBFactory },
    });

    expect(backend).toBeInstanceOf(OpfsWorkspaceBackend);
    await backend.writeFile("/projects/p_1/DESIGN.md", new TextEncoder().encode("hello"));
    await expect(Promise.resolve(testText(await backend.readFile("/projects/p_1/DESIGN.md")))).resolves.toBe("hello");
  });

  it("falls back to memory when OPFS and IndexedDB are unavailable", async () => {
    const backend = await createPersistentBrowserWorkspaceBackend({ globalScope: { navigator: {} as Navigator, indexedDB: undefined as unknown as IDBFactory } });
    expect(backend).toBeInstanceOf(MemoryWorkspaceBackend);
  });

  it("can create IndexedDB backend when provided a browser IndexedDB factory", async () => {
    const indexedDB = new TestIndexedDbFactory();
    const backend = await IndexedDbWorkspaceBackend.create({ namespace: "idb-test", globalScope: { navigator: {} as Navigator, indexedDB: indexedDB as unknown as IDBFactory } });

    await backend.writeFile("/projects/p_1/DESIGN.md", new TextEncoder().encode("indexed"));
    await expect(Promise.resolve(testText(await backend.readFile("/projects/p_1/DESIGN.md")))).resolves.toBe("indexed");
    await expect(backend.listFiles("/projects/p_1")).resolves.toMatchObject([{ kind: "file", path: "/projects/p_1/DESIGN.md" }]);
  });
});

class TestOpfsFile {
  constructor(private data = new Uint8Array()) {}

  async createWritable() {
    return {
      write: async (data: Uint8Array) => { this.data = new Uint8Array(data); },
      close: async () => {},
    };
  }

  async getFile() {
    return { arrayBuffer: async () => this.data.buffer.slice(this.data.byteOffset, this.data.byteOffset + this.data.byteLength) };
  }
}

class TestOpfsDirectory {
  private readonly directories = new Map<string, TestOpfsDirectory>();
  private readonly files = new Map<string, TestOpfsFile>();

  async getDirectoryHandle(name: string, options?: { create?: boolean }) {
    const existing = this.directories.get(name);
    if (existing) return existing;
    if (!options?.create) throw new Error("Directory not found");
    const directory = new TestOpfsDirectory();
    this.directories.set(name, directory);
    return directory;
  }

  async getFileHandle(name: string, options?: { create?: boolean }) {
    const existing = this.files.get(name);
    if (existing) return existing;
    if (!options?.create) throw new Error("File not found");
    const file = new TestOpfsFile();
    this.files.set(name, file);
    return file;
  }

  async removeEntry(name: string) {
    this.files.delete(name);
    this.directories.delete(name);
  }
}

type TestRequest<T = unknown> = IDBRequest<T> & { succeed(value: T): void };
type WritableTestRequest<T = unknown> = { -readonly [K in keyof IDBRequest<T>]: IDBRequest<T>[K] } & { succeed(value: T): void };

function testRequest<T = unknown>(): TestRequest<T> {
  const request = { result: undefined as T, error: null, onsuccess: null, onerror: null, onupgradeneeded: null } as unknown as WritableTestRequest<T>;
  request.succeed = (value: T) => {
    request.result = value;
    queueMicrotask(() => request.onsuccess?.(new Event("success")));
  };
  return request as TestRequest<T>;
}

class TestObjectStore {
  constructor(private readonly records: Map<string, unknown>, private readonly transaction: TestTransaction) {}

  get(path: string) {
    const request = testRequest();
    request.succeed(this.records.get(path));
    return request;
  }

  put(record: { path: string }) {
    const request = testRequest();
    this.records.set(record.path, record);
    request.succeed(record.path);
    this.transaction.complete();
    return request;
  }

  delete(path: string) {
    const request = testRequest();
    this.records.delete(path);
    request.succeed(undefined);
    this.transaction.complete();
    return request;
  }

  getAll() {
    const request = testRequest();
    request.succeed(Array.from(this.records.values()));
    return request;
  }

  clear() {
    const request = testRequest();
    this.records.clear();
    request.succeed(undefined);
    this.transaction.complete();
    return request;
  }
}

class TestTransaction {
  error = null;
  oncomplete: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(private readonly records: Map<string, unknown>) {}

  objectStore() {
    return new TestObjectStore(this.records, this);
  }

  complete() {
    queueMicrotask(() => this.oncomplete?.());
  }
}

class TestIdbDatabase {
  readonly objectStoreNames = { contains: (name: string) => name === "files" };
  readonly records = new Map<string, unknown>();
  createObjectStore() {}
  transaction() {
    const transaction = new TestTransaction(this.records);
    queueMicrotask(() => transaction.complete());
    return transaction;
  }
}

class TestIndexedDbFactory {
  open() {
    const request = testRequest<TestIdbDatabase>();
    request.succeed(new TestIdbDatabase());
    return request;
  }
}
