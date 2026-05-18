import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const out = path.join(root, 'apps/web/out');
const dist = path.join(root, 'dist');

function listFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(full));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function sanitizeFileName(name) {
  return name.replace(/\.\.+/g, '-');
}

function rewriteStaticReferences(replacements) {
  if (replacements.size === 0) return;
  const textExtensions = new Set(['.css', '.html', '.js', '.json', '.map', '.txt']);
  for (const file of listFiles(dist)) {
    if (!textExtensions.has(path.extname(file))) continue;
    let content = fs.readFileSync(file, 'utf8');
    const original = content;
    for (const [from, to] of replacements) content = content.split(from).join(to);
    if (content !== original) fs.writeFileSync(file, content);
  }
}

function sanitizeObjectPaths() {
  const replacements = new Map();
  for (const file of listFiles(dist)) {
    const fileName = path.basename(file);
    const sanitized = sanitizeFileName(fileName);
    if (sanitized === fileName) continue;
    const nextFile = path.join(path.dirname(file), sanitized);
    if (fs.existsSync(nextFile)) throw new Error('Static asset rename collision: ' + nextFile);
    fs.renameSync(file, nextFile);
    replacements.set(fileName, sanitized);
  }
  rewriteStaticReferences(replacements);
}

function parseFrontmatter(raw) {
  if (!raw.startsWith('---\n')) return { data: '', body: raw };
  const end = raw.indexOf('\n---', 4);
  if (end < 0) return { data: '', body: raw };
  return { data: raw.slice(4, end), body: raw.slice(end + 4).replace(/^\n/, '') };
}

function yamlString(block, key, fallback = '') {
  const match = new RegExp('^' + key + ':\\s*(.+)$', 'm').exec(block);
  if (!match) return fallback;
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

function yamlBlockString(block, key, fallback = '') {
  const literal = new RegExp('^' + key + ':\\s*\\|\\s*\\n((?:\\s{2,}.*\\n?)*)', 'm').exec(block);
  if (!literal) return yamlString(block, key, fallback);
  return literal[1]
    .split('\n')
    .map((line) => line.replace(/^\s{2}/, ''))
    .join('\n')
    .trim();
}

function yamlBool(block, key, fallback = false) {
  const value = yamlString(block, key, '');
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function yamlNumber(block, key) {
  const value = Number(yamlString(block, key, ''));
  return Number.isFinite(value) ? value : null;
}

function yamlList(block, key) {
  const inline = new RegExp('^' + key + ':\\s*\\[(.*?)\\]\\s*$', 'm').exec(block);
  if (inline) {
    return inline[1].split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  const list = new RegExp('^' + key + ':\\s*\\n((?:\\s{2}-\\s*.*\\n?)*)', 'm').exec(block);
  if (!list) return [];
  return list[1]
    .split('\n')
    .map((line) => /^\s{2}-\s*(.*)$/.exec(line)?.[1]?.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function yamlSection(block, key) {
  const lines = block.split('\n');
  const start = lines.findIndex((line) => line.trim() === key + ':');
  if (start < 0) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line && !line.startsWith(' ')) break;
    out.push(line.replace(/^\s{2}/, ''));
  }
  return out.join('\n');
}

function derivePrompt(frontmatter) {
  const od = yamlSection(frontmatter, 'od');
  const prompt = yamlString(od, 'example_prompt', '');
  if (prompt) return prompt;
  const description = yamlBlockString(frontmatter, 'description', '');
  return description || yamlString(frontmatter, 'name', '');
}

function normalizeSkill(rootDir, entryName, source = 'built-in') {
  const file = path.join(rootDir, entryName, 'SKILL.md');
  const raw = fs.readFileSync(file, 'utf8');
  const { data, body } = parseFrontmatter(raw);
  const od = yamlSection(data, 'od');
  const designSystem = yamlSection(od, 'design_system');
  const preview = yamlSection(od, 'preview');
  const id = yamlString(data, 'name', entryName);
  const mode = yamlString(od, 'mode', body.includes('<artifact') ? 'prototype' : 'prototype');
  return {
    id,
    name: id,
    description: yamlBlockString(data, 'description', ''),
    triggers: yamlList(data, 'triggers'),
    mode,
    surface: yamlString(od, 'surface', mode === 'image' || mode === 'video' || mode === 'audio' ? mode : 'web'),
    source,
    craftRequires: yamlList(yamlSection(od, 'craft'), 'requires'),
    platform: yamlString(od, 'platform', '') || null,
    scenario: yamlString(od, 'scenario', '') || null,
    category: yamlString(od, 'category', '') || null,
    previewType: yamlString(preview, 'type', 'html'),
    designSystemRequired: yamlBool(designSystem, 'requires', true),
    defaultFor: yamlList(od, 'default_for'),
    upstream: yamlString(od, 'upstream', '') || null,
    featured: yamlNumber(od, 'featured'),
    fidelity: yamlString(od, 'fidelity', '') || null,
    speakerNotes: yamlBool(od, 'speaker_notes', false),
    animations: yamlBool(od, 'animations', false),
    hasBody: body.trim().length > 0,
    examplePrompt: derivePrompt(data),
    aggregatesExamples: false,
    body,
  };
}

function listSkillCatalog(relativeRoot) {
  const rootDir = path.join(root, relativeRoot);
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (!fs.existsSync(path.join(rootDir, entry.name, 'SKILL.md'))) continue;
    try {
      out.push(normalizeSkill(rootDir, entry.name));
    } catch {
      // Keep plugin catalog generation best-effort, matching daemon discovery.
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function cleanTitle(value) {
  return String(value || '').replace(/[`*_]/g, '').trim();
}

function summarizeMarkdown(raw) {
  const body = raw.replace(/^#\s+.*$/m, '').replace(/^>\s*Category:.*$/m, '').trim();
  const paragraph = body.split(/\n\s*\n/).find((part) => part.trim() && !part.trim().startsWith('#')) || '';
  return paragraph.replace(/^>\s?/gm, '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function listDesignSystemCatalog() {
  const rootDir = path.join(root, 'design-systems');
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const file = path.join(rootDir, entry.name, 'DESIGN.md');
    if (!fs.existsSync(file)) continue;
    try {
      const body = fs.readFileSync(file, 'utf8');
      out.push({
        id: entry.name,
        title: cleanTitle(/^#\s+(.+)$/m.exec(body)?.[1] || entry.name),
        category: /^>\s*Category:\s*(.+)$/m.exec(body)?.[1]?.trim() || 'Uncategorized',
        summary: summarizeMarkdown(body),
        swatches: Array.from(new Set(body.match(/#[0-9a-fA-F]{6}\b/g) || [])).slice(0, 8),
        surface: /^>\s*Surface:\s*(image|video|audio|web)\b/im.exec(body)?.[1]?.toLowerCase() || 'web',
        body,
      });
    } catch {
      // Keep plugin catalog generation best-effort.
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

function copyRequiredDir(sourceRelative, targetRelative) {
  const source = path.join(root, sourceRelative);
  if (!fs.existsSync(source)) throw new Error('Missing required runtime directory: ' + sourceRelative);
  const target = path.join(dist, targetRelative);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function removeIfExists(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function pruneDirectoryNames(rootDir, names) {
  if (!fs.existsSync(rootDir)) return;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (!entry.isDirectory()) continue;
    if (names.has(entry.name)) {
      removeIfExists(full);
      continue;
    }
    pruneDirectoryNames(full, names);
  }
}

function pruneFiles(rootDir, shouldRemove) {
  if (!fs.existsSync(rootDir)) return;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      pruneFiles(full, shouldRemove);
    } else if (entry.isFile() && shouldRemove(full, entry.name)) {
      fs.rmSync(full, { force: true });
    }
  }
}

function pruneBundledResources(resourcesRoot) {
  const nonRuntimeDirectoryNames = new Set([
    '.git',
    '.github',
    '.preview',
    '__screenshots__',
    '__snapshots__',
    'coverage',
    'docs',
    'readme',
    'screenshots',
    'verify-output',
  ]);
  pruneDirectoryNames(resourcesRoot, nonRuntimeDirectoryNames);
  pruneFiles(resourcesRoot, (_full, name) =>
    /^readme(\.|$)/i.test(name) ||
    /\.(map|tsbuildinfo)$/i.test(name),
  );
}

function copyRequiredFile(sourceRelative, targetRelative) {
  const source = path.join(root, sourceRelative);
  if (!fs.existsSync(source)) throw new Error('Missing required runtime file: ' + sourceRelative);
  const target = path.join(dist, targetRelative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

function readPackageJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath, 'package.json'), 'utf8'));
}

function writeJsonFile(targetRelative, data) {
  const target = path.join(dist, targetRelative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n');
}

function installPackagedRuntimeDependencies(runtimeRoot) {
  const nodeModules = path.join(runtimeRoot, 'node_modules');
  const vendorNodeModules = path.join(runtimeRoot, 'vendor_node_modules');
  fs.rmSync(nodeModules, { recursive: true, force: true });
  fs.rmSync(vendorNodeModules, { recursive: true, force: true });
  execFileSync('npm', ['install', '--ignore-scripts', '--omit=dev', '--package-lock=false', '--no-fund', '--no-audit'], {
    cwd: runtimeRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    },
  });
  if (!fs.existsSync(nodeModules)) throw new Error('Runtime dependency install did not create node_modules');
  fs.renameSync(nodeModules, vendorNodeModules);
  pruneVendorNodeModules(vendorNodeModules);
}

function pruneVendorNodeModules(vendorNodeModules) {
  const nonRuntimeDirectoryNames = new Set([
    '.github',
    '.nyc_output',
    'benchmark',
    'benchmarks',
    'bench',
    'coverage',
    'demo',
    'demos',
    'doc',
    'docs',
    'example',
    'examples',
    'perf',
    'scripts',
    'test',
    'tests',
    '__tests__',
  ]);
  pruneDirectoryNames(vendorNodeModules, nonRuntimeDirectoryNames);
  pruneFiles(vendorNodeModules, (full, name) => {
    if (name === 'package.json') return false;
    if (/\.(map|md|markdown|ts|tsx|d\.ts|mts|cts|tsbuildinfo)$/i.test(name)) return true;
    if (/^(license|licence|notice|readme|changelog|changes|history|authors|contributing|security)(\.|$)/i.test(name)) return true;
    if (full.includes(`${path.sep}.bin${path.sep}`)) return false;
    return false;
  });
}

function workspaceRuntimePackageJson(packagePath) {
  const packageJson = readPackageJson(packagePath);
  return {
    name: packageJson.name,
    version: packageJson.version,
    type: packageJson.type,
    main: packageJson.main,
    exports: packageJson.exports,
  };
}

function writeOpenDesignWebContainerLauncher() {
  const source = `const DEFAULT_RUNTIME_MANIFEST_PATH = "__w3kits/webcontainer-runtime.json";
const DEFAULT_SERVICE_WORKER_URL = "__w3kits/daemon-proxy-sw.js";
const DEFAULT_SERVICE_WORKER_SCOPE = "/";
const DEFAULT_DAEMON_PORT = 7456;
const DEFAULT_OD_DATA_DIR = "/home/w3kits-webcontainer-host/.w3kits/opendesign/.od";
const DEFAULT_OD_DISK_ROOT = "/workspace/.od";

export const w3kitsOpenDesignDaemon = {
  pluginId: "opendesign",
  mode: "upstream-daemon-webcontainer",
  runtimeManifest: DEFAULT_RUNTIME_MANIFEST_PATH,
  serviceWorker: DEFAULT_SERVICE_WORKER_URL,
  daemonEntry: "__w3kits/webcontainer-runtime/apps/daemon/dist/cli.js",
  startCommand: ["node", "__w3kits/webcontainer-runtime/apps/daemon/dist/cli.js", "--host", "0.0.0.0", "--port", "7456", "--no-open"],
  healthPath: "/api/health",
  proxiedPaths: ["/api/*", "/artifacts/*"],
  unsupportedErrorCode: "unsupported_in_w3kits_webcontainer_v1",
};

function assertCrossOriginIsolated() {
  if (typeof globalThis.crossOriginIsolated !== "undefined" && !globalThis.crossOriginIsolated) {
    throw new Error("w3kits_webcontainer_requires_cross_origin_isolation");
  }
}

function packageAssetUrl(relativePath, options = {}) {
  if (options.assetUrl) return options.assetUrl(relativePath);
  if (options.runtimeBaseUrl) return new URL(relativePath, options.runtimeBaseUrl).toString();
  return relativePath;
}

async function loadRuntimeManifest(manifestPath = DEFAULT_RUNTIME_MANIFEST_PATH, options = {}) {
  const response = await fetch(packageAssetUrl(manifestPath, options), { cache: "force-cache" });
  if (!response.ok) throw new Error("w3kits_webcontainer_manifest_unavailable");
  return response.json();
}

async function installRuntimeDependencies(webcontainer, runtimeRoot, options = {}) {
  const markers = [
    "node_modules/express/package.json",
    "node_modules/undici/package.json",
    "node_modules/@open-design/platform/package.json",
  ];
  const packaged = await Promise.all(markers.map(async (marker) => {
    try {
      await webcontainer.fs.readFile(runtimeRoot.replace(/\\/+$/, "") + "/" + marker);
      return true;
    } catch {
      return false;
    }
  }));
  if (packaged.every(Boolean)) {
    options.onLog?.("Using packaged runtime dependencies in " + runtimeRoot);
    return;
  }

  const installProcess = await webcontainer.spawn("npm", ["install", "--ignore-scripts", "--no-package-lock", "--no-fund", "--no-audit"], {
    cwd: runtimeRoot,
    env: { W3KITS_WEBCONTAINER: "1" },
  });
  installProcess.output?.pipeTo?.(new WritableStream({
    write(chunk) {
      options.onLog?.(String(chunk));
    },
  })).catch((error) => options.onError?.(error));
  const exitCode = await installProcess.exit;
  if (exitCode !== 0) {
    throw new Error("w3kits_opendesign_runtime_install_failed_" + exitCode);
  }
}

async function waitForServerReady(webcontainer, expectedPort, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("w3kits_opendesign_daemon_start_timeout")), timeoutMs);
    const dispose = webcontainer.on("server-ready", (port, url) => {
      if (port !== expectedPort) return;
      clearTimeout(timeout);
      dispose?.();
      resolve(url);
    });
  });
}

function mergeEnv(runtime, inputEnv) {
  const hostOrigin = globalThis.location?.origin || "https://w3kits.com";
  return {
    ...inputEnv,
    OD_BIND_HOST: "0.0.0.0",
    OD_PORT: String(runtime.daemon.port || DEFAULT_DAEMON_PORT),
    OD_ALLOWED_ORIGINS: hostOrigin,
    OD_DATA_DIR: runtime.persistence?.dataDir || DEFAULT_OD_DATA_DIR,
    OD_RESOURCE_ROOT: runtime.resources?.root || "__w3kits/webcontainer-runtime/resources",
    W3KITS_WEBCONTAINER: "1",
    W3KITS_UNSUPPORTED_ERROR_CODE: runtime.unsupportedLocalOnlyFeatures?.error?.code || "unsupported_in_w3kits_webcontainer_v1",
    W3KITS_OPENAI_BASE_URL: runtime.ai?.openaiBaseUrl || "https://w3kits.com/api/ai/openai/v1",
    W3KITS_RUNTIME_SESSION: inputEnv.W3KITS_RUNTIME_SESSION || runtime.ai?.runtimeSession || "",
    W3KITS_PLUGIN_ID: runtime.pluginId || inputEnv.W3KITS_PLUGIN_ID || "",
    W3KITS_PLUGIN_VERSION: runtime.version || inputEnv.W3KITS_PLUGIN_VERSION || "",
    W3KITS_PLUGIN_PACKAGE: runtime.packageName || inputEnv.W3KITS_PLUGIN_PACKAGE || "",
    W3KITS_PLUGIN_INTEGRITY: runtime.packageIntegrity || inputEnv.W3KITS_PLUGIN_INTEGRITY || "",
  };
}

function pathJoin(...parts) {
  return parts.join("/").replace(/\\\\/g, "/").replace(/\\/+/g, "/");
}

function parentPath(filePath) {
  const normalized = filePath.replace(/\\\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}

function relativePath(root, filePath) {
  const normalizedRoot = root.replace(/\\/+$/, "");
  return filePath === normalizedRoot ? "" : filePath.slice(normalizedRoot.length + 1);
}

function bytesSignature(bytes) {
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return bytes.byteLength + ":" + (hash >>> 0).toString(16);
}

async function listFiles(webcontainer, root) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await webcontainer.fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = typeof entry.name === "string" ? entry.name : new TextDecoder().decode(entry.name);
      const next = pathJoin(dir, name);
      if (entry.isDirectory?.()) {
        await walk(next);
      } else if (entry.isFile?.()) {
        files.push(next);
      }
    }
  }
  await walk(root);
  return files;
}

async function ensureDataDir(webcontainer, runtime, options = {}) {
  const dataDir = runtime.persistence?.dataDir || DEFAULT_OD_DATA_DIR;
  try {
    await webcontainer.fs.mkdir(dataDir, { recursive: true });
  } catch (error) {
    options.onError?.(error);
  }
}

function shouldPersistFile(runtime, dataDir, filePath) {
  const rel = relativePath(dataDir, filePath);
  if (!rel || rel.startsWith("node_modules/") || rel.includes("/node_modules/")) return false;
  const includes = runtime.persistence?.include || [];
  if (!includes.length) return true;
  return includes.some((pattern) => {
    if (pattern.endsWith("/**")) return rel === pattern.slice(0, -3) || rel.startsWith(pattern.slice(0, -2));
    return rel === pattern;
  });
}

function diskFilesEndpoint(runtime, options) {
  if (options.diskFilesEndpoint) return options.diskFilesEndpoint;
  const pluginId = options.pluginId || runtime.pluginId || "opendesign";
  return "/api/plugins/" + encodeURIComponent(pluginId) + "/webcontainer/disk/files";
}

function startWebContainerAutosave(webcontainer, runtime, options = {}) {
  const token = options.r2DiskSession?.token || options.runtimeSession;
  if (!token || typeof fetch !== "function") return { stop() {} };
  const dataDir = runtime.persistence?.dataDir || DEFAULT_OD_DATA_DIR;
  const diskRoot = runtime.persistence?.diskRoot || DEFAULT_OD_DISK_ROOT;
  const workspaceId = options.r2DiskSession?.workspaceId || options.workspaceId || "default";
  const endpoint = diskFilesEndpoint(runtime, options);
  const intervalMs = runtime.persistence?.flushPolicy?.intervalMs || 30000;
  const seen = new Map();
  let stopped = false;
  let flushing = false;

  async function upload(filePath, bytes) {
    const relativeFilePath = relativePath(dataDir, filePath);
    const url = new URL(endpoint, globalThis.location?.origin || "https://w3kits.com");
    url.searchParams.set("workspaceId", workspaceId);
    url.searchParams.set("path", pathJoin(diskRoot, relativeFilePath));
    const response = await fetch(url.toString(), {
      method: "PUT",
      credentials: "same-origin",
      headers: {
        "content-type": "application/octet-stream",
        "x-w3kits-runtime-session": token,
      },
      body: bytes,
    });
    if (!response.ok) throw new Error("w3kits_disk_autosave_upload_failed:" + response.status + ":" + filePath);
  }

  async function flush(reason = "interval") {
    if (stopped || flushing) return;
    flushing = true;
    try {
      const files = await listFiles(webcontainer, dataDir);
      for (const filePath of files) {
        if (!shouldPersistFile(runtime, dataDir, filePath)) continue;
        let bytes;
        try {
          bytes = await webcontainer.fs.readFile(filePath);
        } catch {
          continue;
        }
        const signature = bytesSignature(bytes);
        if (seen.get(filePath) === signature) continue;
        await upload(filePath, bytes);
        seen.set(filePath, signature);
      }
      options.onLog?.("[w3kits autosave] flushed " + files.length + " files (" + reason + ")");
    } catch (error) {
      options.onError?.(error);
    } finally {
      flushing = false;
    }
  }

  const timer = globalThis.setInterval?.(() => void flush("interval"), intervalMs);
  const lifecycleFlush = () => void flush("lifecycle");
  globalThis.addEventListener?.("visibilitychange", lifecycleFlush);
  globalThis.addEventListener?.("pagehide", lifecycleFlush);
  void flush("startup");
  return {
    flush,
    stop() {
      stopped = true;
      if (timer) globalThis.clearInterval?.(timer);
      globalThis.removeEventListener?.("visibilitychange", lifecycleFlush);
      globalThis.removeEventListener?.("pagehide", lifecycleFlush);
    },
  };
}

export async function bootW3KitsOpenDesignWebContainer(options = {}) {
  assertCrossOriginIsolated();
  const runtime = options.runtimeManifest || await loadRuntimeManifest(options.runtimeManifestPath || DEFAULT_RUNTIME_MANIFEST_PATH, options);
  const WebContainer = options.WebContainer || globalThis.WebContainer;
  if (!WebContainer?.boot) throw new Error("w3kits_webcontainer_api_unavailable");

  const webcontainer = options.webcontainer || await WebContainer.boot(options.bootOptions || {});
  if (options.mountTree) await webcontainer.mount(options.mountTree);
  if (options.mounts) {
    for (const mount of options.mounts) await webcontainer.mount(mount.tree, mount.options);
  }

  const runtimeRoot = runtime.runtimeRoot || "__w3kits/webcontainer-runtime";
  options.onLog?.("Installing runtime dependencies in " + runtimeRoot);
  await installRuntimeDependencies(webcontainer, runtimeRoot, options);

  const env = mergeEnv(runtime, options.env || {});
  const command = options.command || runtime.daemon.startCommand;
  await ensureDataDir(webcontainer, runtime, options);
  const process = await webcontainer.spawn(command[0], command.slice(1), { env });
  process.output?.pipeTo?.(new WritableStream({
    write(chunk) {
      options.onLog?.(String(chunk));
    },
  })).catch((error) => options.onError?.(error));

  const daemonUrl = await waitForServerReady(webcontainer, runtime.daemon.port || DEFAULT_DAEMON_PORT, options.startTimeoutMs || 30000);
  const autosave = startWebContainerAutosave(webcontainer, runtime, options);
  return { webcontainer, process, daemonUrl, runtime, autosave };
}
`;
  fs.writeFileSync(path.join(dist, 'browser-daemon.js'), source);
}

function writeDaemonProxyServiceWorker() {
  const source = `let daemonUrl = null;

function jsonError(code, status) {
  return new Response(JSON.stringify({ error: { code, message: code } }), {
    status,
    headers: { "content-type": "application/json;charset=UTF-8" },
  });
}

function shouldProxy(url) {
  return url.origin === self.location.origin && (url.pathname.startsWith("/api/") || url.pathname.startsWith("/artifacts/"));
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "W3KITS_DAEMON_PROXY_SET_TARGET") return;
  try {
    const target = new URL(event.data.daemonUrl);
    daemonUrl = target.toString();
  } catch {
    daemonUrl = null;
  }
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (!shouldProxy(url)) return;
  event.respondWith((async () => {
    if (!daemonUrl) return jsonError("w3kits_opendesign_daemon_not_ready", 503);
    const target = new URL(url.pathname + url.search, daemonUrl);
    return fetch(target, {
      method: event.request.method,
      headers: event.request.headers,
      body: event.request.method === "GET" || event.request.method === "HEAD" ? undefined : event.request.body,
      redirect: "manual",
    });
  })().catch(() => jsonError("w3kits_opendesign_daemon_proxy_failed", 502)));
});
`;
  fs.writeFileSync(path.join(dist, '__w3kits', 'daemon-proxy-sw.js'), source);
}

function writeW3KitsRuntimeMetadata() {
  const w3kitsDir = path.join(dist, '__w3kits');
  fs.mkdirSync(w3kitsDir, { recursive: true });

  const iconCandidates = [
    path.join(dist, 'app-icon.svg'),
    path.join(dist, 'logo.svg'),
  ];
  const icon = iconCandidates.find((candidate) => fs.existsSync(candidate));
  if (!icon) throw new Error('Missing OpenDesign icon in dist.');
  fs.copyFileSync(icon, path.join(w3kitsDir, 'icon.svg'));

  copyRequiredDir('apps/web/out', '__w3kits/webcontainer-runtime/apps/web/out');
  copyRequiredDir('apps/daemon/dist', '__w3kits/webcontainer-runtime/apps/daemon/dist');
  copyRequiredFile('apps/daemon/package.json', '__w3kits/webcontainer-runtime/apps/daemon/package.json');
  const workspacePackageNames = ['contracts', 'platform', 'sidecar', 'sidecar-proto', 'browser-vfs'];
  for (const packageName of workspacePackageNames) {
    copyRequiredDir(`packages/${packageName}/dist`, `__w3kits/webcontainer-runtime/node_modules/@open-design/${packageName}/dist`);
    writeJsonFile(
      `__w3kits/webcontainer-runtime/node_modules/@open-design/${packageName}/package.json`,
      workspaceRuntimePackageJson(`packages/${packageName}`),
    );
    copyRequiredDir(`packages/${packageName}/dist`, `__w3kits/webcontainer-runtime/workspace-packages/@open-design/${packageName}/dist`);
    writeJsonFile(
      `__w3kits/webcontainer-runtime/workspace-packages/@open-design/${packageName}/package.json`,
      workspaceRuntimePackageJson(`packages/${packageName}`),
    );
  }
  copyRequiredDir('skills', '__w3kits/webcontainer-runtime/resources/skills');
  copyRequiredDir('design-templates', '__w3kits/webcontainer-runtime/resources/design-templates');
  copyRequiredDir('design-systems', '__w3kits/webcontainer-runtime/resources/design-systems');
  copyRequiredDir('prompt-templates', '__w3kits/webcontainer-runtime/resources/prompt-templates');
  pruneBundledResources(path.join(dist, '__w3kits/webcontainer-runtime/resources'));

  const daemonPackage = readPackageJson('apps/daemon');
  const runtimeDependencies = Object.fromEntries(
    Object.entries(daemonPackage.dependencies || {}).filter(([name]) => !name.startsWith('@open-design/') && name !== 'better-sqlite3'),
  );
  for (const packageName of workspacePackageNames) {
    runtimeDependencies[`@open-design/${packageName}`] = `file:./workspace-packages/@open-design/${packageName}`;
  }
  writeJsonFile('__w3kits/webcontainer-runtime/package.json', {
    type: 'module',
    private: true,
    scripts: {
      start: 'node ./apps/daemon/dist/cli.js --host 0.0.0.0 --port 7456 --no-open',
    },
    dependencies: runtimeDependencies,
  });
  installPackagedRuntimeDependencies(path.join(dist, '__w3kits/webcontainer-runtime'));

  writeJsonFile('__w3kits/webcontainer-runtime.json', {
    schemaVersion: 1,
    pluginId: 'opendesign',
    mode: 'upstream-daemon-webcontainer',
    runtimeRoot: '__w3kits/webcontainer-runtime',
    daemon: {
      entry: '__w3kits/webcontainer-runtime/apps/daemon/dist/cli.js',
      startCommand: ['node', '__w3kits/webcontainer-runtime/apps/daemon/dist/cli.js', '--host', '0.0.0.0', '--port', '7456', '--no-open'],
      port: 7456,
      healthPath: '/api/health',
      proxiedPaths: ['/api/*', '/artifacts/*'],
    },
    serviceWorker: {
      url: '__w3kits/daemon-proxy-sw.js',
      scope: '/',
    },
    requiresCrossOriginIsolation: true,
    ai: {
      providerName: 'W3Kits AI',
      openaiBaseUrl: 'https://w3kits.com/api/ai/openai/v1',
      modelsPath: '/models',
      runtimeSessionHeader: 'X-W3Kits-Runtime-Session',
      identityHeaders: ['X-W3Kits-Plugin-Id', 'X-W3Kits-Plugin-Version', 'X-W3Kits-Plugin-Commit'],
    },
    resources: {
      root: '__w3kits/webcontainer-runtime/resources',
    },
    mounts: {
      writableWorkspace: '/workspace',
      readOnlyAssets: {
        skills: '__w3kits/webcontainer-runtime/resources/skills',
        designTemplates: '__w3kits/webcontainer-runtime/resources/design-templates',
        designSystems: '__w3kits/webcontainer-runtime/resources/design-systems',
      },
    },
    persistence: {
      dataDir: '/home/w3kits-webcontainer-host/.w3kits/opendesign/.od',
      diskRoot: '/workspace/.od',
      authority: 'w3kits-r2-virtual-disk',
      localCache: 'opfs-indexeddb-writeback',
      flushPolicy: {
        debounceMs: 2000,
        intervalMs: 30000,
        lifecycleEvents: ['visibilitychange', 'pagehide', 'daemon-ready', 'run-complete', 'daemon-stop', 'daemon-crash'],
      },
      include: [
        'app.sqlite',
        'app.sqlite-wal',
        'app.sqlite-shm',
        'app-config.json',
        'media-config.json',
        'mcp-config.json',
        'projects/**',
        'artifacts/**',
        'memory/**',
        'skills/**',
        'design-systems/**',
        'design-templates/**',
      ],
      sqliteGroups: [
        ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm'],
      ],
    },
    unsupportedLocalOnlyFeatures: {
      error: {
        code: 'unsupported_in_w3kits_webcontainer_v1',
        message: 'This OpenDesign daemon feature requires the local daemon and is not available in W3Kits Web Mode yet.',
      },
      features: [
        'host_child_process_cli',
        'native_folder_dialog',
        'local_repo_import',
        'stdio_mcp',
        'host_shell_open_path',
        'native_file_watching',
        'native_only_storage',
      ],
    },
    knownWebContainerBlockers: [
      'OpenDesign sqlite/config/project state under the writable WebContainer data dir must be flushed through the W3Kits R2 virtual disk at /workspace/.od before reload persistence can pass.',
      'host child_process agent adapters must be gated or replaced with W3Kits AI provider calls.',
      'native dialog, local repo import, stdio MCP, host shell/openPath, and native file watching must return unsupported_in_w3kits_webcontainer_v1.',
    ],
  });

  writeOpenDesignWebContainerLauncher();
  writeDaemonProxyServiceWorker();
}

function writeW3KitsCatalog() {
  const catalogDir = path.join(dist, '__w3kits', 'catalog');
  fs.mkdirSync(catalogDir, { recursive: true });
  fs.writeFileSync(path.join(catalogDir, 'skills.json'), JSON.stringify({ skills: listSkillCatalog('skills') }));
  fs.writeFileSync(path.join(catalogDir, 'design-templates.json'), JSON.stringify({ designTemplates: listSkillCatalog('design-templates') }));
  fs.writeFileSync(path.join(catalogDir, 'design-systems.json'), JSON.stringify({ designSystems: listDesignSystemCatalog() }));
}

if (!fs.existsSync(out)) throw new Error('Missing apps/web/out; run the W3Kits plugin build first.');
fs.rmSync(dist, { recursive: true, force: true });
fs.cpSync(out, dist, { recursive: true });
sanitizeObjectPaths();
writeW3KitsCatalog();
writeW3KitsRuntimeMetadata();

const index = path.join(dist, 'index.html');
if (!fs.existsSync(index)) throw new Error('Missing dist/index.html after copy.');
