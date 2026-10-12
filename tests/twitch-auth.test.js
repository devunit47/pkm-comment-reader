import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthStorage } from '../src/server/auth-storage.js';
import { createTwitchAuth } from '../src/server/twitch-auth.js';

import { fakeClock } from './auth-support.js';
const response = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const tokens = (suffix = 'one') => ({ access_token: `access-${suffix}`, refresh_token: `refresh-${suffix}`, expires_in: 14400, token_type: 'bearer', scope: [] });
const account = { client_id: 'test-client', user_id: '123', login: 'test_login', scopes: [], expires_in: 14400 };

async function fixture(t, overrides = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'pokome-twitch-auth-'));
  const storage = createAuthStorage(folder, { platform: 'linux' }), clock = fakeClock(), calls = [];
  await overrides.before?.(storage);
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, form: init.body ? new URLSearchParams(init.body) : null, at: clock.now() });
    const result = await overrides.fetch?.(url, init, calls.at(-1));
    if (result) return result;
    if (url.endsWith('/device')) return response(200, { device_code: 'private-device', user_code: 'ABCD-EFGH', verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=ABCD-EFGH', expires_in: 1800, interval: 5 });
    if (url.endsWith('/token')) return response(200, tokens());
    if (url.endsWith('/validate')) return response(200, account);
    if (url.endsWith('/users')) return response(200, { data: [{ id: '123', login: 'test_login', display_name: '確認アカウント', email: 'must-not-copy' }] });
    if (url.endsWith('/revoke')) return response(200, undefined);
    throw new Error('Unexpected destination');
  };
  const auth = createTwitchAuth({ storage, clock, fetchImpl, clientId: overrides.clientId ?? 'test-client' });
  t.after(async () => { await auth.close(); await storage.close(); await rm(folder, { recursive: true, force: true }); });
  await auth.ready;
  return { auth, clock, calls, storage };
}
const callCount = (calls, suffix) => calls.filter(call => call.url.endsWith(suffix)).length;

test('empty client ID disables login without upstream communication or timers', async t => {
  const { auth, calls, clock } = await fixture(t, { clientId: '' });
  assert.deepEqual(auth.status(), { status: 'disabled' });
  await assert.rejects(auth.start(), /使えません/);
  assert.equal(calls.length, 0); assert.equal(clock.size, 0);
});

test('device pending and slow_down obey polling intervals then login saves a token pair', async t => {
  let polls = 0;
  const { auth, calls, clock, storage } = await fixture(t, { fetch(url) {
    if (url.endsWith('/token') && ++polls <= 2) return response(400, { message: polls === 1 ? 'authorization_pending' : 'slow_down' });
  } });
  const waiting = await auth.start();
  assert.equal(waiting.status, 'pending'); assert.equal(waiting.user_code, 'ABCD-EFGH');
  assert.doesNotMatch(JSON.stringify(waiting), /private-device|access-|refresh-/);
  await clock.tick(4999); assert.equal(polls, 0);
  await clock.tick(1); assert.equal(polls, 1);
  await clock.tick(5000); assert.equal(polls, 2);
  await clock.tick(9999); assert.equal(polls, 2);
  await clock.tick(1); assert.equal(auth.status().status, 'signed-in');
  assert.equal(auth.status().displayName, '確認アカウント');
  const saved = (await storage.load('twitch')).value;
  assert.equal(saved.session.accessToken, 'access-one'); assert.equal(saved.session.refreshToken, 'refresh-one');
  for (const call of calls.filter(call => call.url.endsWith('/device') || call.url.endsWith('/token'))) {
    assert.equal(call.form.get('scopes'), ''); assert.equal(call.form.has('client_secret'), false);
  }
});

for (const [error, reason] of [['expired_token', /期限/], ['access_denied', /拒否/], ['invalid device code', /期限/]]) {
  test(`device ${error} becomes reauth with a safe reason`, async t => {
    const { auth, clock } = await fixture(t, { fetch: url => url.endsWith('/token') ? response(400, { message: error }) : undefined });
    await auth.start(); await clock.tick(5000);
    assert.equal(auth.status().status, 'reauth'); assert.match(auth.status().reason, reason);
  });
}

test('local code expiry stops polling even while authorization is pending', async t => {
  const { auth, clock, calls } = await fixture(t, { fetch: url => url.endsWith('/token') ? response(400, { error: 'authorization_pending' }) : undefined });
  await auth.start(); await clock.tick(1800000);
  assert.equal(auth.status().status, 'reauth'); assert.match(auth.status().reason, /期限/);
  const count = calls.length; await clock.tick(10000); assert.equal(calls.length, count);
});

test('concurrent token requests share a single refresh and save the new pair together', async t => {
  const refresh = Promise.withResolvers(); let refreshStarted;
  const started = new Promise(resolve => { refreshStarted = resolve; });
  const { auth, clock, calls, storage } = await fixture(t, { fetch(url, init) {
    if (url.endsWith('/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') { refreshStarted(); return refresh.promise; }
  } });
  await auth.start(); await clock.tick(5000);
  const requests = [auth.getAccessToken({ forceRefresh: true }), auth.getAccessToken({ forceRefresh: true })];
  await started; refresh.resolve(response(200, tokens('two')));
  assert.deepEqual(await Promise.all(requests), ['access-two', 'access-two']);
  assert.equal(calls.filter(call => call.form?.get('grant_type') === 'refresh_token').length, 1);
  const saved = (await storage.load('twitch')).value;
  assert.equal(saved.session.accessToken, 'access-two'); assert.equal(saved.session.refreshToken, 'refresh-two');
});

for (const action of ['cancel', 'logout']) {
  test(`${action} discards an in-flight successful device poll`, async t => {
    const delayed = Promise.withResolvers(), started = Promise.withResolvers();
    const { auth, clock, storage } = await fixture(t, { fetch(url) {
      if (url.endsWith('/token')) { started.resolve(); return delayed.promise; }
    } });
    await auth.start(); const tick = clock.tick(5000); await started.promise;
    await auth[action](); delayed.resolve(response(200, tokens())); await tick;
    assert.equal(auth.status().status, 'signed-out'); assert.equal((await storage.load('twitch')).value, null);
  });
}

test('logout clears local storage despite revoke failure and discards late refresh', async t => {
  const delayed = Promise.withResolvers(), started = Promise.withResolvers();
  const { auth, clock, storage } = await fixture(t, { fetch(url, init) {
    if (url.endsWith('/revoke')) throw new Error('access-one refresh-one private-device');
    if (url.endsWith('/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') { started.resolve(); return delayed.promise; }
  } });
  await auth.start(); await clock.tick(5000);
  const refreshing = auth.getAccessToken({ forceRefresh: true }); await started.promise;
  await auth.logout(); delayed.resolve(response(200, tokens('late')));
  assert.equal(await refreshing, null); assert.equal(auth.status().status, 'signed-out');
  assert.equal((await storage.load('twitch')).value, null);
});

for (const failRefresh of [false, true]) {
  test(`hourly validate 401 refresh ${failRefresh ? 'failure requires login' : 'recovers'}`, async t => {
    let validations = 0;
    const { auth, clock, calls } = await fixture(t, { fetch(url, init) {
      if (url.endsWith('/validate') && ++validations === 2) return response(401, { message: 'secret must not escape' });
      if (failRefresh && url.endsWith('/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') return response(400, { message: 'secret must not escape' });
    } });
    await auth.start(); await clock.tick(5000); await clock.tick(3600000);
    assert.equal(auth.status().status, failRefresh ? 'reauth' : 'signed-in');
    assert.doesNotMatch(JSON.stringify(auth.status()), /secret|access-|refresh-|private-device/);
    assert.equal(calls.filter(call => call.form?.get('grant_type') === 'refresh_token').length, 1);
  });
}

test('startup validates saved credentials and close cancels all timers', async t => {
  const { auth, clock, storage, calls } = await fixture(t);
  await auth.start(); await clock.tick(5000); await auth.close();
  assert.equal(clock.size, 0);
  const restored = createTwitchAuth({ storage, clock, clientId: 'test-client', fetchImpl: async url => { calls.push({ url }); return response(200, account); } });
  await restored.ready; assert.equal(restored.status().status, 'signed-in');
  await restored.close(); assert.equal(clock.size, 0); assert.equal(callCount(calls, '/validate'), 2);
});

test('untrusted activation URLs never become a login', async t => {
  const { auth } = await fixture(t, { fetch: url => url.endsWith('/device') ? response(200, { device_code: 'private', user_code: 'CODE', verification_uri: 'https://evil.example/', expires_in: 100, interval: 5 }) : undefined });
  await assert.rejects(auth.start(), /ログイン/); assert.notEqual(auth.status().status, 'pending');
});

test('a late validation cannot overwrite the token pair already replaced by a refresh', async t => {
  const delayed = Promise.withResolvers(), started = Promise.withResolvers(); let holdValidation = false;
  const { auth, clock, storage } = await fixture(t, { fetch(url, init) {
    if (url.endsWith('/validate') && holdValidation && init.headers.Authorization === 'OAuth access-one') { started.resolve(); return delayed.promise; }
    if (url.endsWith('/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') return response(200, tokens('new'));
  } });
  await auth.start(); await clock.tick(5000); holdValidation = true;
  const checking = auth.validate(); await started.promise;
  assert.equal(await auth.getAccessToken({ forceRefresh: true }), 'access-new');
  delayed.resolve(response(200, account)); await checking;
  const saved = (await storage.load('twitch')).value;
  assert.equal(saved.session.accessToken, 'access-new'); assert.equal(saved.session.refreshToken, 'refresh-new');
});

test('validation rejects a different client or account and unexpected scopes', async t => {
  for (const invalid of [{ ...account, client_id: 'other' }, { ...account, scopes: ['user:read:email'] }]) {
    const { auth, clock } = await fixture(t, { fetch: url => url.endsWith('/validate') ? response(200, invalid) : undefined });
    await auth.start(); await clock.tick(5000); assert.equal(auth.status().status, 'reauth');
  }
});

test('close during refresh prevents any follow-up validation request or save', async t => {
  const delayed = Promise.withResolvers(), started = Promise.withResolvers();
  const { auth, clock, calls, storage } = await fixture(t, { fetch(url, init) {
    if (url.endsWith('/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') { started.resolve(); return delayed.promise; }
  } });
  await auth.start(); await clock.tick(5000);
  const refreshing = auth.getAccessToken({ forceRefresh: true }); await started.promise;
  await auth.close(); const count = calls.length, before = await storage.load('twitch');
  delayed.resolve(response(200, tokens('late'))); await refreshing;
  assert.equal(calls.length, count); assert.deepEqual(await storage.load('twitch'), before); assert.equal(clock.size, 0);
});

test('cancel cannot remove authenticated credentials without revocation', async t => {
  const { auth, clock, storage } = await fixture(t);
  await auth.start(); await clock.tick(5000); await auth.cancel();
  assert.equal(auth.status().status, 'signed-in'); assert.ok((await storage.load('twitch')).value.session);
});

test('logout during a pending encrypted save still deletes that save after it finishes', async t => {
  const revokeStarted = Promise.withResolvers();
  const { auth, clock, storage } = await fixture(t, { fetch(url, init) {
    if (url.endsWith('/revoke')) { revokeStarted.resolve(); return response(200); }
    if (url.endsWith('/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') return response(200, tokens('new'));
  } });
  await auth.start(); await clock.tick(5000);
  const delayed = Promise.withResolvers(), started = Promise.withResolvers(), save = storage.save;
  storage.save = async (...args) => { const result = await save(...args); started.resolve(); await delayed.promise; return result; };
  const refreshing = auth.getAccessToken({ forceRefresh: true }); await started.promise;
  const loggingOut = auth.logout();
  await revokeStarted.promise;
  delayed.resolve(); await Promise.all([refreshing, loggingOut]);
  assert.equal(auth.status().status, 'signed-out'); assert.equal((await storage.load('twitch')).value, null);
});

test('a queued failure from an old validation cannot replace a freshly saved token pair', async t => {
  const delayed = Promise.withResolvers(), started = Promise.withResolvers(); let hold = false;
  const { auth, clock, storage } = await fixture(t, { fetch(url, init) {
    if (url.endsWith('/validate') && hold && init.headers.Authorization === 'OAuth access-one') { started.resolve(); return delayed.promise; }
    if (url.endsWith('/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') return response(200, tokens('new'));
  } });
  await auth.start(); await clock.tick(5000); hold = true;
  const checking = auth.validate(); await started.promise;
  const releaseSave = Promise.withResolvers(), saveStarted = Promise.withResolvers(), save = storage.save;
  storage.save = async (...args) => { saveStarted.resolve(); await releaseSave.promise; return save(...args); };
  const refreshing = auth.getAccessToken({ forceRefresh: true }); await saveStarted.promise;
  delayed.resolve(response(500, { error: 'temporary' }));
  // Flush the already-resolved validation chain into the occupied save queue.
  await new Promise(setImmediate);
  releaseSave.resolve(); await Promise.all([checking, refreshing]);
  assert.equal(auth.status().status, 'signed-in');
  assert.equal((await storage.load('twitch')).value.session.accessToken, 'access-new');
});

test('startup refreshes saved tokens when validate returns 401', async t => {
  const { auth, clock, storage } = await fixture(t);
  await auth.start(); await clock.tick(5000); await auth.close();
  let validations = 0, refreshes = 0;
  const restored = createTwitchAuth({ storage, clock, clientId: 'test-client', fetchImpl: async (url, init) => {
    if (url.endsWith('/validate')) return ++validations === 1 ? response(401, {}) : response(200, account);
    if (url.endsWith('/token')) { refreshes++; assert.equal(new URLSearchParams(init.body).get('grant_type'), 'refresh_token'); return response(200, tokens('restored')); }
    throw new Error('Unexpected request');
  } });
  await restored.ready;
  assert.equal(restored.status().status, 'signed-in'); assert.equal(refreshes, 1);
  assert.equal((await storage.load('twitch')).value.session.refreshToken, 'refresh-restored');
  await restored.close();
});

test('an unreadable encrypted record requires reauthentication without clearing it', async t => {
  let writes = 0;
  const { auth, calls } = await fixture(t, { before(storage) {
    storage.load = async () => ({ value: null, unreadable: true, revision: 'broken' });
    storage.remove = storage.save = async () => { writes++; throw new Error('Must preserve unreadable file'); };
  } });
  assert.equal(auth.status().status, 'reauth'); assert.match(auth.status().reason, /別の PC/);
  assert.equal(writes, 0); assert.equal(calls.length, 0);
});

test('code expiry queued during a successful login save cannot replace the signed-in session', async t => {
  const { auth, clock, storage } = await fixture(t);
  await auth.start();
  const started = Promise.withResolvers(), release = Promise.withResolvers(), save = storage.save;
  storage.save = async (...args) => { started.resolve(); await release.promise; return save(...args); };
  const polling = clock.tick(5000); await started.promise;
  const expiring = clock.tick(1795000);
  await new Promise(setImmediate);
  release.resolve(); await Promise.all([polling, expiring]);
  assert.equal(auth.status().status, 'signed-in');
  assert.equal((await storage.load('twitch')).value.session.accessToken, 'access-one');
});

test('a refreshed session cannot overwrite an external logout during encryption', async t => {
  const { auth, clock, storage } = await fixture(t, { fetch(url, init) {
    if (url.endsWith('/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') return response(200, tokens('new'));
  } });
  await auth.start(); await clock.tick(5000);
  const started = Promise.withResolvers(), release = Promise.withResolvers(), save = storage.save;
  storage.save = async (...args) => { started.resolve(); await release.promise; return save(...args); };
  const refreshing = auth.getAccessToken({ forceRefresh: true }); await started.promise;
  await storage.remove('twitch'); release.resolve(); await refreshing;
  await new Promise(setImmediate);
  assert.equal((await storage.load('twitch')).value, null);
  assert.equal(auth.status().status, 'signed-out');
});

test('external logout during the initial credential read takes precedence over its stale result', async t => {
  const { auth, clock, storage } = await fixture(t);
  await auth.start(); await clock.tick(5000); await auth.close();
  const saved = await storage.load('twitch'), release = Promise.withResolvers();
  const load = storage.load; let first = true, changed;
  storage.load = async (...args) => { if (first) { first = false; return release.promise; } return load(...args); };
  storage.subscribe = (_service, listener) => { changed = listener; return () => {}; };
  const restored = createTwitchAuth({ storage, clock, clientId: 'test-client', fetchImpl: async () => response(200, account) });
  t.after(() => restored.close());
  await storage.remove('twitch'); changed();
  await new Promise(setImmediate);
  release.resolve(saved); await restored.ready;
  await new Promise(setImmediate);
  assert.equal(restored.status().status, 'signed-out');
  assert.equal(await restored.getAccessToken(), null);
});
