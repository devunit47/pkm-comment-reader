import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server.js';

async function serve(t, fetchImpl) {
  const server = createServer({ fetchImpl });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('the app forbids camera and microphone access and serves the studio module', async t => {
  const base = await serve(t);
  const page = await fetch(base);
  assert.equal(page.headers.get('permissions-policy'), 'camera=(), microphone=()');
  const studio = await fetch(`${base}/studio.js`);
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
