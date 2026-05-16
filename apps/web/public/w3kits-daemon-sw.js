const REQUEST_TIMEOUT_MS = 30000;

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value || '');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function requestPayload(request) {
  const body = request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : bytesToBase64(new Uint8Array(await request.arrayBuffer()));
  return {
    type: 'W3KITS_DAEMON_REQUEST',
    request: {
      url: request.url,
      method: request.method,
      headers: Array.from(request.headers.entries()),
      bodyBase64: body,
    },
  };
}

async function targetClient(event) {
  if (event.clientId) {
    const client = await self.clients.get(event.clientId);
    if (client) return client;
  }
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return clients[0] || null;
}

async function relayToClient(event) {
  const client = await targetClient(event);
  if (!client) return new Response(JSON.stringify({ error: 'w3kits_client_unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });

  const message = await requestPayload(event.request);
  const channel = new MessageChannel();
  const response = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve({ status: 504, headers: [['content-type', 'application/json']], bodyBase64: bytesToBase64(new TextEncoder().encode(JSON.stringify({ error: 'w3kits_daemon_timeout' }))) }), REQUEST_TIMEOUT_MS);
    channel.port1.onmessage = (reply) => {
      clearTimeout(timeout);
      resolve(reply.data || {});
    };
    client.postMessage(message, [channel.port2]);
  });

  return new Response(base64ToBytes(response.bodyBase64), {
    status: response.status || 200,
    headers: response.headers || [],
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/artifacts/')) return;
  event.respondWith(relayToClient(event));
});
