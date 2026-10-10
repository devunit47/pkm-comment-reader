import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { temporaryDataDirectory } from './browser-support.js';

async function serve(t, fetchImpl) {
  const server = createServer({ fetchImpl, dataDirectory: await temporaryDataDirectory(t) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('the app forbids camera and microphone access and serves the studio module', async t => {
  const base = await serve(t);
  const page = await fetch(base);
  assert.equal(page.headers.get('permissions-policy'), 'camera=(), microphone=()');
  const studio = await fetch(`${base}/src/shared/studio.js`);
  assert.equal(studio.status, 200);
  assert.match(studio.headers.get('content-type'), /javascript/);
});

test('Kick lookup returns only the room ID and always uses the fixed Kick destination', async t => {
  let upstreamUrl;
  const base = await serve(t, async url => {
    upstreamUrl = url;
    return { ok: true, json: async () => ({ chatroom: { id: 123 }, playback_url: 'private-or-unnecessary' }) };
  });
  const response = await fetch(`${base}/api/kick/channel/Some-Channel`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { chatroomId: 123 });
  assert.equal(upstreamUrl, 'https://kick.com/api/v2/channels/some-channel');
});

test('invalid inputs, cross-origin requests and unsupported methods do not reach Kick', async t => {
  let calls = 0;
  const base = await serve(t, async () => { calls++; throw new Error('Should not fetch'); });
  assert.equal((await fetch(`${base}/api/kick/channel/invalid%2Fname`)).status, 400);
  assert.equal((await fetch(`${base}/api/kick/channel/safe`, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/kick/channel/safe`, { method: 'POST' })).status, 405);
  assert.equal(calls, 0);
});

test('lookup errors have usable messages without exposing upstream content', async t => {
  const base = await serve(t, async () => ({ ok: false, status: 404 }));
  const response = await fetch(`${base}/api/kick/channel/missing`);
  assert.equal(response.status, 404);
  assert.match((await response.json()).error, /見つかりません/);
});

// A server that is closed right away must leave no background folder work behind,
// so the folders appear with the first request that needs them.
test('creating a server writes no customization folders until a request needs them', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pokome-lazy-customization-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const customizationDirectory = join(folder, 'customization');
  const server = createServer({ customizationDirectory, dataDirectory: await temporaryDataDirectory(t) });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/settings`)).status, 200);
  assert.equal(existsSync(customizationDirectory), false, 'settings requests leave customization untouched');
  assert.equal((await fetch(`${base}/api/design/current`)).status, 200);
  for (const kind of ['styles', 'images', 'current']) assert.equal(existsSync(join(customizationDirectory, kind)), true, kind);
});
