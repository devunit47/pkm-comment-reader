import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { fakeClock } from './auth-support.js';
import { createDesignStorage } from '../src/server/design-storage.js';
import { createSettingsStorage } from '../src/server/settings-storage.js';

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pokome-shutdown-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function within(promise, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

async function listen(t, server) {
  const connections = new Set();
  server.on('connection', socket => {
    connections.add(socket); socket.on('close', () => connections.delete(socket));
  });
  const closed = once(server, 'close');
  t.after(async () => {
    // A failing shutdown regression must not leave the test process hanging.
    for (const socket of connections) socket.destroy();
    if (server.listening) server.close();
    await within(closed, 'forced test cleanup did not finish');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

for (const [kind, createStorage] of [['design', createDesignStorage], ['settings', createSettingsStorage]]) {
test(`${kind} server close completes when a late SSE request arrives on an active keep-alive connection`, { timeout: 7000 }, async t => {
  const directory = await temporary(t);
  const server = createServer({ customizationDirectory: join(directory, 'customization'), dataDirectory: join(directory, 'data') });
  const handler = server.listeners('request')[0];
  server.removeListener('request', handler);
  const first = Promise.withResolvers(), events = Promise.withResolvers();
  let heldResponse, initialSocket;
  server.on('request', (req, res) => {
    if (req.url === '/hold') {
      initialSocket = req.socket; heldResponse = res;
      // Keep the existing HTTP connection active while close() stops listening.
      res.writeHead(200, { Connection: 'keep-alive' }); res.write('held');
      first.resolve();
    } else {
      handler(req, res);
      events.resolve(req.socket);
    }
  });
  const base = await listen(t, server), url = new URL(base);
  const socket = connect(Number(url.port), url.hostname);
  t.after(() => socket.destroy());
  await within(once(socket, 'connect'), 'HTTP connection did not open');
  let wire = '';
  socket.setEncoding('utf8'); socket.on('data', text => { wire += text; });
  const ended = once(socket, 'end');
  const send = path => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: keep-alive\r\n\r\n`);
  send('/hold'); await within(first.promise, 'initial HTTP request did not arrive');
  const closed = new Promise((resolve, reject) => {
    assert.equal(server.close(error => error ? reject(error) : resolve()), server);
  });
  assert.equal(server.listening, false);
  send(`/api/${kind}/events`);
  assert.equal(await within(events.promise, 'late SSE request did not arrive'), initialSocket);
  heldResponse.end();
  await within(closed, 'server.close callback timed out after a late SSE request');
  await within(ended, 'shutdown response did not end');
  assert.match(wire, /HTTP\/1\.1 503 Service Unavailable/);
  assert.doesNotMatch(wire, /text\/event-stream|retry:|: ping/);
});

test(`${kind} events received after closeEvents return a finite 503 response instead of SSE`, { timeout: 7000 }, async t => {
  const storage = createStorage(await temporary(t));
  const server = http.createServer((req, res) => storage.handle(req, res, new URL(req.url, 'http://localhost')));
  t.after(() => storage.closeEvents());
  const base = await listen(t, server);
  storage.closeEvents(); storage.closeEvents();
  const response = await fetch(`${base}/api/${kind}/events`, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 503);
  assert.match(response.headers.get('content-type'), /^text\/plain; charset=utf-8/);
  assert.equal(await response.text(), 'サーバーを停止しています。');
  await within(new Promise(resolve => server.close(resolve)), '503 response kept the HTTP server open');
});

test(`${kind} SSE heartbeats stop on request or response disconnect and shutdown admits no clients`, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const disconnect of ['request', 'response']) {
    const storage = createStorage(await temporary(t));
    const req = Object.assign(new EventEmitter(), { method: 'GET', headers: { host: 'localhost' } });
    const writes = [], ends = [];
    const res = Object.assign(new EventEmitter(), {
      setHeader() {}, writeHead() {},
      write: text => writes.push(text), end: text => ends.push(text),
    });
    await storage.handle(req, res, new URL(`http://localhost/api/${kind}/events`));
    assert.deepEqual(writes, ['retry: 2000\n\n']);
    t.mock.timers.tick(25000);
    assert.deepEqual(writes, ['retry: 2000\n\n', ': ping\n\n']);
    (disconnect === 'request' ? req : res).emit('close');
    t.mock.timers.tick(50000);
    assert.equal(writes.length, 2);
    storage.closeEvents();
    assert.equal(ends.length, 0, 'disconnected clients were removed');
    await storage.handle(req, res, new URL(`http://localhost/api/${kind}/events`));
    storage.closeEvents(); t.mock.timers.tick(50000);
    assert.deepEqual(ends, ['サーバーを停止しています。']);
    assert.equal(writes.length, 2, 'shutdown starts no stream or heartbeat');
  }
});
}

test('server shutdown closes the settings auth stream and stops pending login timers', async t => {
  const directory = await temporary(t), clock = fakeClock(); let calls = 0;
  const server = createServer({ customizationDirectory: join(directory, 'customization'), dataDirectory: join(directory, 'data'), twitchClientId: 'test-client', authPlatform: 'linux', authClock: clock,
    fetchImpl: async () => { calls++; return { ok: true, status: 200, json: async () => ({ device_code: 'private-code', user_code: 'USER-CODE', verification_uri: 'https://www.twitch.tv/activate', expires_in: 600, interval: 5 }) }; } });
  const base = await listen(t, server), abort = new AbortController();
  t.after(() => abort.abort());
  const stream = await fetch(`${base}/api/settings/events`, { signal: abort.signal });
  const reader = stream.body.getReader(); await reader.read();
  await fetch(`${base}/api/auth/twitch`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' }, body: '{"action":"start"}' });
  assert.ok(clock.size > 0);
  await within(new Promise(resolve => server.close(resolve)), 'auth shutdown kept the settings stream open');
  while (!(await reader.read()).done) { /* Drain the final auth notification before EOF. */ }
  assert.equal(clock.size, 0);
  await clock.tick(600000); assert.equal(calls, 1);
});
