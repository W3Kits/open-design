import { describe, expect, it } from "vitest";

import {
  BrowserVfsError,
  MemoryWorkspaceBackend,
  createBrowserWorkspace,
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
