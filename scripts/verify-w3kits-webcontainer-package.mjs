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
assert(launcher.includes('/api/health'), 'browser-daemon.js must wait for upstream daemon health');
assert(launcher.includes('W3KITS_DAEMON_PROXY_SET_TARGET'), 'browser-daemon.js must configure the daemon proxy service worker');

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

const requiredFiles = [
  '__w3kits/webcontainer-runtime/apps/daemon/dist/cli.js',
  '__w3kits/webcontainer-runtime/apps/daemon/dist/server.js',
  '__w3kits/webcontainer-runtime/package.json',
  '__w3kits/webcontainer-runtime/node_modules/@open-design/contracts/dist/index.mjs',
  '__w3kits/webcontainer-runtime/node_modules/@open-design/platform/dist/index.mjs',
  '__w3kits/webcontainer-runtime/node_modules/@open-design/sidecar/dist/index.mjs',
  '__w3kits/webcontainer-runtime/node_modules/@open-design/sidecar-proto/dist/index.mjs',
  '__w3kits/webcontainer-runtime/node_modules/@open-design/browser-vfs/dist/index.mjs',
  '__w3kits/webcontainer-runtime/workspace-packages/@open-design/contracts/package.json',
  '__w3kits/webcontainer-runtime/workspace-packages/@open-design/platform/package.json',
  '__w3kits/webcontainer-runtime/workspace-packages/@open-design/sidecar/package.json',
  '__w3kits/webcontainer-runtime/workspace-packages/@open-design/sidecar-proto/package.json',
  '__w3kits/webcontainer-runtime/workspace-packages/@open-design/browser-vfs/package.json',
  '__w3kits/assets/skills',
  '__w3kits/assets/design-templates',
  '__w3kits/assets/design-systems',
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

console.log('[w3kits] OpenDesign WebContainer package contract verified');
