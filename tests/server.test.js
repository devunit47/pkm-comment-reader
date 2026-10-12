import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { temporaryDataDirectory } from './browser-support.js';
import { fakeClock } from './auth-support.js';
import { request as httpRequest } from 'node:http';

test('Twitch auth API guards requests, shares state, and never returns private credentials in JSON or SSE', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pokome-auth-api-')), clock = fakeClock();
  let calls = 0;
  const options = { dataDirectory: join(directory, 'data'), customizationDirectory: join(directory, 'customization'), twitchClientId: 'test-client', authPlatform: 'linux', authClock: clock,
    fetchImpl: async url => {
      calls++;
      const data = url.endsWith('/device') ? { device_code: 'private-device-code', user_code: 'USER-CODE', verification_uri: 'https://www.twitch.tv/activate', expires_in: 600, interval: 5 }
        : url.endsWith('/token') ? { access_token: 'private-access-token', refresh_token: 'private-refresh-token', expires_in: 3600, token_type: 'bearer', scope: [] }
        : url.endsWith('/validate') ? { client_id: 'test-client', user_id: '1', login: 'reader', expires_in: 3600, scopes: [] }
        : { data: [{ id: '1', login: 'reader', display_name: 'Reader' }] };
      return { ok: true, status: 200, json: async () => data };
    } };
  const servers = [createServer(options), createServer(options)];
  t.after(async () => { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); await rm(directory, { recursive: true, force: true }); });
  for (const server of servers) await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const bases = servers.map(server => `http://127.0.0.1:${server.address().port}`), base = bases[0];
  const request = (body, headers = {}) => fetch(`${base}/api/auth/twitch`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin', ...headers } });
  for (const headers of [{ Host: 'evil.example' }, { Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
    for (const method of ['GET', 'POST']) {
      const code = await new Promise((resolve, reject) => {
        const req = httpRequest(`${base}/api/auth/twitch`, { method, headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin', ...headers } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', reject); req.end(method === 'POST' ? '{"action":"start"}' : undefined);
      });
      assert.equal(code, 403, JSON.stringify(headers));
    }
  }
  assert.equal((await request({ action: 'unknown' })).status, 400);
  assert.equal((await request({ action: 'start', device_code: 'injected' })).status, 400);
  assert.equal(calls, 0);
  for (const subpath of ['events', 'unknown']) {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/auth/twitch/${subpath}`, { signal: controller.signal });
    controller.abort(); assert.equal(response.status, 404);
  }
  const abort = new AbortController();
  t.after(() => abort.abort());
  const stream = await fetch(`${bases[1]}/api/settings/events`, { signal: abort.signal });
  const reader = stream.body.getReader(); let wire = '';
  await reader.read();
  const started = await request({ action: 'start' });
  assert.equal(started.status, 200);
  const state = await started.json(); assert.equal(state.status, 'pending');
  wire += new TextDecoder().decode((await reader.read()).value);
  assert.match(wire, /event: auth\ndata: \{"revision":0\}/);
  assert.doesNotMatch(wire + JSON.stringify(state), /private-device-code|accessToken|refreshToken|device_code/);
  assert.deepEqual(await (await fetch(`${bases[1]}/api/auth/twitch`)).json(), state);
  await clock.tick(5000);
  wire += new TextDecoder().decode((await reader.read()).value);
  const signedIn = await (await fetch(`${bases[1]}/api/auth/twitch`)).json();
  assert.equal(signedIn.status, 'signed-in');
  const settings = await (await fetch(`${bases[1]}/api/settings`)).text();
  assert.doesNotMatch(wire + settings + JSON.stringify(signedIn), /private-|access[_T]oken|refresh[_T]oken|device_code|USER-CODE/);
  assert.equal(JSON.parse(settings).auth, undefined);
  await request({ action: 'logout' });
  assert.deepEqual(await (await fetch(`${bases[1]}/api/auth/twitch`)).json(), { status: 'signed-out' });
  abort.abort(); await reader.cancel().catch(() => {});
});

test('empty Twitch client ID cannot initiate an upstream request', async t => {
  const base = await serve(t, () => { throw new Error('Must not contact Twitch'); });
  assert.deepEqual(await (await fetch(`${base}/api/auth/twitch`)).json(), { status: 'disabled' });
  const response = await fetch(`${base}/api/auth/twitch`, { method: 'POST', body: '{"action":"start"}', headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(response.status, 503); assert.match((await response.json()).error, /使えません/);
});

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
