import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readText(relativePath) {
  const file = path.join(dist, relativePath);
  assert(fs.existsSync(file), `missing ${relativePath}`);
  return fs.readFileSync(file, 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

const launcher = readText('browser-daemon.js');
const runtime = readJson('__w3kits/webcontainer-runtime.json');
const runtimePackage = readJson('__w3kits/webcontainer-runtime/package.json');

assert(!launcher.includes('w3kits-webcontainer-placeholder'), 'browser-daemon.js still declares placeholder mode');
assert(!launcher.includes('handleW3KitsDaemonRequest'), 'browser-daemon.js must not import or call fake daemon request handlers');
assert(!launcher.includes('W3KITS_DAEMON_REQUEST'), 'browser-daemon.js must not use the old window-postMessage fake daemon protocol');
assert(launcher.includes('bootW3KitsOpenDesignWebContainer'), 'browser-daemon.js must export the WebContainer boot adapter');
assert(launcher.includes('upstream-daemon-webcontainer'), 'browser-daemon.js must declare upstream daemon WebContainer mode');
assert(launcher.includes('webcontainer.spawn'), 'browser-daemon.js must start the daemon through WebContainer spawn');
assert(launcher.includes('server-ready'), 'browser-daemon.js must wait for WebContainer server-ready');
assert(!launcher.includes('waitForHealth'), 'browser-daemon.js must not fetch the cross-origin WebContainer preview URL for health checks');
assert(!launcher.includes('registerDaemonProxy'), 'browser-daemon.js must not proxy daemon APIs through the W3Kits origin');
assert(launcher.includes('OD_ALLOWED_ORIGINS'), 'browser-daemon.js must pass the host origin to daemon CORS policy');
assert(launcher.includes('OD_DATA_DIR'), 'browser-daemon.js must pin the OpenDesign data directory for persistence');
assert(launcher.includes('OD_RESOURCE_ROOT'), 'browser-daemon.js must pin daemon resource roots for bundled templates');
assert(launcher.includes('W3KITS_RUNTIME_SESSION'), 'browser-daemon.js must pass the W3Kits runtime session to the daemon');
assert(launcher.includes('/home/w3kits-webcontainer-host/.w3kits/opendesign/.od'), 'browser-daemon.js must use a writable WebContainer home data directory');
assert(launcher.includes('/workspace/.od'), 'browser-daemon.js must persist OpenDesign data under the stable R2 disk root');
assert(launcher.includes('startWebContainerAutosave'), 'browser-daemon.js must start periodic WebContainer autosave');
assert(launcher.includes('w3kits_disk_autosave_upload_failed'), 'browser-daemon.js must upload persisted files through the WebContainer disk route');
assert(launcher.includes('/webcontainer/disk/files'), 'browser-daemon.js must target the WebContainer disk file route');
assert(launcher.includes('visibilitychange'), 'browser-daemon.js must flush on lifecycle events');
assert(launcher.includes('readdir('), 'browser-daemon.js must recursively scan the WebContainer filesystem');
assert(launcher.includes('readFile('), 'browser-daemon.js must read WebContainer files for autosave');
assert(launcher.includes('Using packaged runtime dependencies'), 'browser-daemon.js must skip npm install when packaged runtime dependencies are mounted');

assert(runtime.schemaVersion === 1, 'runtime manifest schemaVersion must be 1');
assert(runtime.pluginId === 'opendesign', 'runtime manifest pluginId must be opendesign');
assert(runtime.mode === 'upstream-daemon-webcontainer', 'runtime manifest mode must be upstream-daemon-webcontainer');
assert(runtime.requiresCrossOriginIsolation === true, 'runtime manifest must require cross-origin isolation');
assert(runtime.daemon?.entry === '__w3kits/webcontainer-runtime/apps/daemon/dist/cli.js', 'runtime manifest must point at upstream daemon cli');
assert(Array.isArray(runtime.daemon?.startCommand), 'runtime manifest must include daemon startCommand');
assert(runtime.daemon.startCommand.join(' ').includes('apps/daemon/dist/cli.js'), 'daemon startCommand must launch upstream daemon cli');
assert(runtime.daemon.startCommand.includes('--no-open'), 'daemon startCommand must disable host browser opening');
assert(runtime.daemon.healthPath === '/api/health', 'daemon healthPath must be /api/health');
assert(runtime.daemon.proxiedPaths?.includes('/api/*'), 'daemon proxiedPaths must include /api/*');
assert(runtime.daemon.proxiedPaths?.includes('/artifacts/*'), 'daemon proxiedPaths must include /artifacts/*');
assert(runtime.unsupportedLocalOnlyFeatures?.error?.code === 'unsupported_in_w3kits_webcontainer_v1', 'runtime manifest must declare stable unsupported error code');
assert(runtime.ai?.openaiBaseUrl === 'https://w3kits.com/api/ai/openai/v1', 'runtime manifest must use unified W3Kits OpenAI base URL');
assert(runtime.resources?.root === '__w3kits/webcontainer-runtime/resources', 'runtime manifest must expose daemon-visible resource root');
assert(runtime.persistence?.dataDir === '/home/w3kits-webcontainer-host/.w3kits/opendesign/.od', 'runtime manifest must declare the writable OpenDesign data directory');
assert(runtime.persistence?.diskRoot === '/workspace/.od', 'runtime manifest must declare the stable OpenDesign R2 disk root');
assert(runtime.persistence?.authority === 'w3kits-r2-virtual-disk', 'runtime manifest must declare R2 virtual disk as persistence authority');
assert(runtime.persistence?.localCache === 'opfs-indexeddb-writeback', 'runtime manifest must declare OPFS/IndexedDB write-back cache');
assert(runtime.persistence?.flushPolicy?.intervalMs === 30000, 'runtime manifest must declare periodic persistence flush interval');
assert(runtime.persistence?.include?.includes('app.sqlite'), 'runtime manifest must include app.sqlite in persisted files');
assert(runtime.persistence?.include?.includes('app.sqlite-wal'), 'runtime manifest must include app.sqlite-wal in persisted files');
assert(runtime.persistence?.include?.includes('app.sqlite-shm'), 'runtime manifest must include app.sqlite-shm in persisted files');
assert(runtime.persistence?.sqliteGroups?.some((group) => Array.isArray(group) && group.includes('app.sqlite') && group.includes('app.sqlite-wal') && group.includes('app.sqlite-shm')), 'runtime manifest must persist sqlite main/WAL/SHM files as a group');
assert(!runtimePackage.dependencies?.['better-sqlite3'], 'WebContainer runtime must not install native better-sqlite3');

const requiredFiles = [
  '__w3kits/webcontainer-runtime/apps/daemon/dist/cli.js',
  '__w3kits/webcontainer-runtime/apps/daemon/dist/server.js',
  '__w3kits/webcontainer-runtime/apps/web/out/index.html',
  '__w3kits/webcontainer-runtime/package.json',
  '__w3kits/webcontainer-runtime/vendor_node_modules/express/package.json',
  '__w3kits/webcontainer-runtime/vendor_node_modules/undici/package.json',
  '__w3kits/webcontainer-runtime/vendor_node_modules/@open-design/contracts/dist/index.mjs',
  '__w3kits/webcontainer-runtime/vendor_node_modules/@open-design/platform/dist/index.mjs',
  '__w3kits/webcontainer-runtime/vendor_node_modules/@open-design/sidecar/dist/index.mjs',
  '__w3kits/webcontainer-runtime/vendor_node_modules/@open-design/sidecar-proto/dist/index.mjs',
  '__w3kits/webcontainer-runtime/vendor_node_modules/@open-design/browser-vfs/dist/index.mjs',
  '__w3kits/webcontainer-runtime/workspace-packages/@open-design/contracts/package.json',
  '__w3kits/webcontainer-runtime/workspace-packages/@open-design/platform/package.json',
  '__w3kits/webcontainer-runtime/workspace-packages/@open-design/sidecar/package.json',
  '__w3kits/webcontainer-runtime/workspace-packages/@open-design/sidecar-proto/package.json',
  '__w3kits/webcontainer-runtime/workspace-packages/@open-design/browser-vfs/package.json',
  '__w3kits/assets/skills',
  '__w3kits/assets/design-templates',
  '__w3kits/assets/design-systems',
  '__w3kits/assets/prompt-templates',
  '__w3kits/webcontainer-runtime/resources/skills',
  '__w3kits/webcontainer-runtime/resources/design-templates',
  '__w3kits/webcontainer-runtime/resources/design-systems',
  '__w3kits/webcontainer-runtime/resources/prompt-templates',
  '__w3kits/webcontainer-runtime/resources/design-templates/dashboard/SKILL.md',
  '__w3kits/daemon-proxy-sw.js',
];

for (const relativePath of requiredFiles) {
  assert(fs.existsSync(path.join(dist, relativePath)), `missing packaged runtime asset ${relativePath}`);
}

for (const packageName of ['contracts', 'platform', 'sidecar', 'sidecar-proto', 'browser-vfs']) {
  assert(
    runtimePackage.dependencies?.[`@open-design/${packageName}`] === `file:./workspace-packages/@open-design/${packageName}`,
    `runtime package must install @open-design/${packageName} from packaged workspace files`,
  );
}

const proxy = readText('__w3kits/daemon-proxy-sw.js');
assert(proxy.includes('W3KITS_DAEMON_PROXY_SET_TARGET'), 'daemon proxy service worker must accept daemon target messages');
assert(proxy.includes('w3kits_opendesign_daemon_not_ready'), 'daemon proxy service worker must return a typed not-ready error');
assert(!proxy.includes('W3KITS_DAEMON_REQUEST'), 'daemon proxy service worker must not use old fake daemon relay protocol');

const daemonServer = readText('__w3kits/webcontainer-runtime/apps/daemon/dist/server.js');
assert(daemonServer.includes('W3KITS_WEBCONTAINER'), 'packaged daemon must include the WebContainer runtime branch');
assert(daemonServer.includes('Access-Control-Allow-Origin'), 'packaged daemon must include WebContainer CORS headers for W3Kits proxying');
assert(daemonServer.includes('OD_RESOURCE_ROOT'), 'packaged daemon must support OD_RESOURCE_ROOT for bundled templates');
const chatRoutes = readText('__w3kits/webcontainer-runtime/apps/daemon/dist/chat-routes.js');
assert(chatRoutes.includes('x-w3kits-runtime-session'), 'packaged daemon proxy must forward the W3Kits runtime session header');
assert(chatRoutes.includes('x-w3kits-plugin-id'), 'packaged daemon proxy must forward W3Kits plugin identity headers');

console.log('[w3kits] OpenDesign WebContainer package contract verified');
