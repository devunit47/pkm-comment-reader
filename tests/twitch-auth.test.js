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

for (const operation of ['poll', 'validate', 'sync']) {
  test(`background ${operation} converts a storage read failure into recoverable status`, async t => {
    const { auth, clock, storage, calls } = await fixture(t);
    await auth.start();
    if (operation !== 'poll') await clock.tick(5000);
    const load = storage.load;
    storage.load = async () => { throw new Error('private-storage-failure'); };
    if (operation === 'sync') {
      const saved = (await load('twitch')).value;
      await storage.save('twitch', { ...saved, session: { ...saved.session, displayName: '更新名' } });
      await new Promise(setImmediate);
    } else await clock.tick(operation === 'poll' ? 5000 : 3600000);
    assert.equal(auth.status().status, 'reauth'); assert.match(auth.status().reason, /保存できません/);
    assert.doesNotMatch(JSON.stringify(auth.status()), /private-/);
    assert.equal(clock.size, 0);
    storage.load = load;
    await auth.logout(); assert.equal(auth.status().status, 'signed-out');
    assert.equal(callCount(calls, '/revoke'), operation === 'poll' ? 0 : 1);
    await auth.start(); assert.equal(auth.status().status, 'pending');
  });
}

for (const operation of ['load', 'save']) {
  test(`a storage ${operation} failure after token rotation becomes recoverable storage reauth`, async t => {
    let validations = 0;
    const { auth, clock, storage, calls } = await fixture(t, { fetch(url, init) {
      if (url.endsWith('/validate') && ++validations === 2) return response(401, {});
      if (url.endsWith('/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') return response(200, tokens('rotated'));
    } });
    await auth.start(); await clock.tick(5000);
    const load = storage.load, save = storage.save;
    storage.load = async service => {
      const saved = await load(service);
      if (operation === 'load' && saved.value?.session?.accessToken === 'access-rotated') throw new Error('private-storage-failure');
      return saved;
    };
    storage.save = async (service, value, condition) => {
      if (operation === 'save' && value.session?.accessToken === 'access-rotated' && value.session.expiresAt > 0) throw new Error('private-storage-failure');
      return save(service, value, condition);
    };
    await clock.tick(3600000);
    assert.equal(auth.status().status, 'reauth'); assert.match(auth.status().reason, /保存できません/);
    assert.equal(await auth.getAccessToken(), null); assert.equal(clock.size, 0);
    assert.equal((await load('twitch')).value.session.refreshToken, 'refresh-rotated');
    storage.load = load; storage.save = save;
    await auth.logout(); assert.equal(auth.status().status, 'signed-out');
    assert.equal(calls.find(call => call.url.endsWith('/revoke')).form.get('token'), 'access-rotated');
  });
}

for (const shape of ['empty', 'null', 'missing']) {
  test(`scope-free ${shape} responses support login, periodic validation and refresh`, async t => {
    const scopeField = key => shape === 'missing' ? {} : { [key]: shape === 'null' ? null : [] };
    const { auth, clock, storage } = await fixture(t, { fetch(url) {
      if (url.endsWith('/token')) { const { scope, ...pair } = tokens(); return response(200, { ...pair, ...scopeField('scope') }); }
      if (url.endsWith('/validate')) { const { scopes, ...identity } = account; return response(200, { ...identity, ...scopeField('scopes') }); }
    } });
    await auth.start(); await clock.tick(5000); assert.equal(auth.status().status, 'signed-in');
    await clock.tick(3600000); assert.equal(auth.status().status, 'signed-in');
    assert.equal(await auth.getAccessToken({ forceRefresh: true }), 'access-one');
    assert.equal((await storage.load('twitch')).value.session.refreshToken, 'refresh-one');
  });
}

for (const endpoint of ['token', 'validate']) {
  test(`a nonempty scope in ${endpoint} is rejected`, async t => {
    let scoped = endpoint === 'token';
    const { auth, clock, storage } = await fixture(t, { fetch(url) {
      if (scoped && url.endsWith(`/${endpoint}`)) return response(200, endpoint === 'token' ? { ...tokens(), scope: ['user:read:email'] } : { ...account, scopes: ['user:read:email'] });
    } });
    await auth.start(); await clock.tick(5000);
    if (endpoint === 'validate') { assert.equal(auth.status().status, 'signed-in'); scoped = true; await clock.tick(3600000); }
    assert.equal(auth.status().status, 'reauth'); assert.equal((await storage.load('twitch')).value.session, undefined);
  });
}

test('empty client ID disables login without upstream communication or timers', async t => {
  const { auth, calls, clock } = await fixture(t, { clientId: '' });
  assert.deepEqual(auth.status(), { status: 'disabled' });
  await assert.rejects(auth.start(), /使えません/);
  assert.equal(calls.length, 0); assert.equal(clock.size, 0);
});

test('Helix rejection of an already rotated token reuses the current token without another refresh', async t => {
  const { auth, clock, calls } = await fixture(t, { fetch(url) { if (url.endsWith('/token')) return response(200, tokens('rotated')); } });
  await auth.start(); await clock.tick(5000);
  assert.equal(await auth.getAccessToken({ forceRefresh: true, rejectedToken: 'access-old' }), 'access-rotated');
  assert.equal(callCount(calls, '/token'), 1);
});
test('logout invalidates the badge session before a delayed revoke completes', async t => {
  let release, started;
  const revokeStarted = new Promise(resolve => { started = resolve; });
  const { auth, clock } = await fixture(t, { fetch(url) {
    if (url.endsWith('/revoke')) { started(); return new Promise(resolve => { release = resolve; }); }
  } });
  await auth.start(); await clock.tick(5000);
  const session = auth.sessionId(); const logout = auth.logout(); await revokeStarted;
  const during = auth.sessionId(), token = await auth.getAccessToken();
  release(response(200, {})); await logout;
  assert.ok(session); assert.equal(during, ''); assert.equal(token, null);
});
test('an older logout cannot restore the badge session while a newer logout still awaits revoke', async t => {
  const pending = [];
  const { auth, clock } = await fixture(t, { fetch(url) { if (url.endsWith('/revoke')) return new Promise(resolve => pending.push(resolve)); } });
  await auth.start(); await clock.tick(5000);
  const first = auth.logout(); await new Promise(setImmediate);
  const second = auth.logout(); await new Promise(setImmediate);
  pending[0](response(200, {})); await first;
  const during = auth.sessionId(), state = auth.status(); pending[1](response(200, {})); await second;
  assert.equal(during, '');
  assert.deepEqual(state, { status: 'signing-out' });
  assert.deepEqual(auth.status(), { status: 'signed-out' });
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

for (const failure of ['network', 503, 429]) {
  test(`device polling retries ${failure} at the current interval and then signs in`, async t => {
    let polls = 0;
    const { auth, clock, calls, storage } = await fixture(t, { fetch(url) {
      if (!url.endsWith('/token')) return;
      if (++polls === 1) return response(400, { error: 'slow_down' });
      if (polls === 2) {
        if (failure === 'network') throw new Error('private-network-failure');
        return response(failure, { error: 'private-upstream-failure' });
      }
    } });
    await auth.start(); await clock.tick(5000); await clock.tick(10000);
    assert.equal(auth.status().status, 'pending');
    assert.equal((await storage.load('twitch')).value.status, 'pending');
    assert.doesNotMatch(JSON.stringify(auth.status()), /private-/);
    await clock.tick(9999); assert.equal(polls, 2);
    await clock.tick(1); assert.equal(auth.status().status, 'signed-in');
    assert.deepEqual(calls.filter(call => call.url.endsWith('/token')).map(call => call.at), [1005000, 1015000, 1025000]);
  });
}

test('device polling network failures stop at the original code expiry', async t => {
  const { auth, clock, calls, storage } = await fixture(t, { fetch(url) {
    if (url.endsWith('/device')) return response(200, { device_code: 'private-device', user_code: 'ABCD-EFGH', verification_uri: 'https://www.twitch.tv/activate', expires_in: 12, interval: 5 });
    if (url.endsWith('/token')) throw new Error('private-network-failure');
  } });
  await auth.start(); await clock.tick(10000);
  assert.equal(auth.status().status, 'pending'); assert.equal(callCount(calls, '/token'), 2);
  await clock.tick(2000);
  assert.equal(auth.status().status, 'reauth'); assert.match(auth.status().reason, /期限/);
  assert.equal((await storage.load('twitch')).value.session, undefined);
  await clock.tick(10000); assert.equal(callCount(calls, '/token'), 2); assert.equal(clock.size, 0);
});

for (const endpoint of ['validate', 'users']) {
  test(`initial ${endpoint} network failure discards the unverified device token pair`, async t => {
    const { auth, clock, storage } = await fixture(t, { fetch(url) {
      if (url.endsWith(`/${endpoint}`)) throw new Error('access-one refresh-one private-device');
    } });
    await auth.start(); await clock.tick(5000);
    assert.equal(auth.status().status, 'reauth');
    assert.equal((await storage.load('twitch')).value.session, undefined);
    assert.doesNotMatch(JSON.stringify(auth.status()), /access-one|refresh-one|private-device/);
    assert.equal(clock.size, 0);
  });
}

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

for (const failure of ['network', 'timeout']) test(`logout clears local storage despite revoke ${failure} and discards late refresh`, async t => {
  const delayed = Promise.withResolvers(), started = Promise.withResolvers();
  const { auth, clock, storage } = await fixture(t, { fetch(url, init) {
    if (url.endsWith('/revoke')) throw failure === 'timeout' ? new DOMException('private-timeout', 'TimeoutError') : new Error('access-one refresh-one private-device');
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

test('offline startup preserves saved credentials and retries every five minutes until hourly validation resumes', async t => {
  const { auth, clock, storage } = await fixture(t);
  await auth.start(); await clock.tick(5000); await auth.close();
  const before = await storage.load('twitch'); let offline = true, validations = 0;
  const restored = createTwitchAuth({ storage, clock, clientId: 'test-client', fetchImpl: async () => {
    validations++; if (offline) throw new TypeError('private-network-error'); return response(200, account);
  } });
  t.after(() => restored.close()); await restored.ready;
  assert.equal(restored.status().status, 'signed-in'); assert.deepEqual(await storage.load('twitch'), before);
  await clock.tick(299999); assert.equal(validations, 1);
  await clock.tick(1); assert.equal(validations, 2);
  assert.deepEqual(await storage.load('twitch'), before);
  offline = false; await clock.tick(300000); assert.equal(validations, 3);
  await clock.tick(3599999); assert.equal(validations, 3);
  await clock.tick(1); assert.equal(validations, 4);
  await restored.close(); assert.equal(clock.size, 0);
});

for (const code of [503, 429]) {
  test(`hourly validate ${code} keeps the token pair and retries until recovery`, async t => {
    let outage = false, validations = 0;
    const { auth, clock, storage } = await fixture(t, { fetch(url) {
      if (url.endsWith('/validate')) { validations++; if (outage) return response(code, { message: 'private-response' }); }
    } });
    await auth.start(); await clock.tick(5000); const before = await storage.load('twitch');
    outage = true; await clock.tick(3600000);
    assert.equal(auth.status().status, 'signed-in'); assert.deepEqual(await storage.load('twitch'), before);
    await clock.tick(300000); assert.equal(validations, 3); assert.deepEqual(await storage.load('twitch'), before);
    outage = false; await clock.tick(300000); assert.equal(validations, 4);
    assert.equal((await storage.load('twitch')).value.session.refreshToken, 'refresh-one');
    await clock.tick(3600000); assert.equal(validations, 5);
  });
}

for (const failure of ['503', '429', 'network', 'timeout']) {
  test(`expired-token refresh ${failure} returns null, retains login and recovers on retry`, async t => {
    let expired = false, outage = true, refreshes = 0;
    const { auth, clock, storage } = await fixture(t, { fetch(url, init) {
      if (expired && url.endsWith('/validate') && init.headers.Authorization === 'OAuth access-one') return response(401, {});
      if (url.endsWith('/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') {
        refreshes++;
        if (outage) {
          if (failure === 'network') throw new TypeError('private-network-error');
          if (failure === 'timeout') throw new DOMException('private-timeout', 'TimeoutError');
          return response(Number(failure), {});
        }
        return response(200, tokens('recovered'));
      }
    } });
    await auth.start(); await clock.tick(5000); const before = (await storage.load('twitch')).value;
    expired = true; await storage.save('twitch', { ...before, session: { ...before.session, expiresAt: clock.now() - 1 } });
    await new Promise(setImmediate); const retained = await storage.load('twitch');
    assert.equal(await auth.getAccessToken(), null);
    assert.equal(auth.status().status, 'signed-in'); assert.deepEqual(await storage.load('twitch'), retained);
    await clock.tick(300000); assert.equal(refreshes, 2); assert.deepEqual(await storage.load('twitch'), retained);
    outage = false; await clock.tick(300000); assert.equal(refreshes, 3);
    assert.equal(await auth.getAccessToken(), 'access-recovered');
    assert.equal((await storage.load('twitch')).value.session.refreshToken, 'refresh-recovered');
    await auth.close(); assert.equal(clock.size, 0);
  });
}

for (const code of [400, 401]) {
  test(`refresh rejection ${code} requires reauthentication even with an empty response`, async t => {
    const { auth, clock, storage } = await fixture(t, { fetch(url, init) {
      if (url.endsWith('/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') return { ...response(code), json: async () => { throw new SyntaxError('empty'); } };
    } });
    await auth.start(); await clock.tick(5000);
    assert.equal(await auth.getAccessToken({ forceRefresh: true }), null);
    assert.equal(auth.status().status, 'reauth'); assert.match(auth.status().reason, /有効性/);
    assert.equal((await storage.load('twitch')).value.session, undefined);
  });
}

test('restart clears saved device authorization without polling and permits a new code', async t => {
  const { auth, clock, storage } = await fixture(t);
  await auth.start(); await auth.close();
  let polls = 0;
  const restored = createTwitchAuth({ storage, clock, clientId: 'test-client', fetchImpl: async url => {
    if (url.endsWith('/token')) { polls++; return response(400, { message: 'authorization_pending' }); }
    if (url.endsWith('/device')) return response(200, { device_code: 'new-private-code', user_code: 'NEW-CODE', verification_uri: 'https://www.twitch.tv/activate', expires_in: 600, interval: 5 });
    throw new Error('Unexpected request');
  } });
  t.after(() => restored.close()); await restored.ready;
  assert.equal(restored.status().status, 'signed-out'); assert.equal((await storage.load('twitch')).value, null);
  await clock.tick(600000); assert.equal(polls, 0);
  assert.equal((await restored.start()).user_code, 'NEW-CODE');
});

test('a rotated token pair survives failed validation and recovers without reusing the consumed refresh token', async t => {
  let outage = false, exchanged = false;
  const { auth, clock, storage, calls } = await fixture(t, { fetch(url, init) {
    if (url.endsWith('/token') && new URLSearchParams(init.body).get('grant_type') === 'refresh_token') {
      if (exchanged) return response(400, {});
      exchanged = true; return response(200, tokens('rotated'));
    }
    if (url.endsWith('/validate') && outage) throw new TypeError('private-network-error');
  } });
  await auth.start(); await clock.tick(5000); outage = true;
  assert.equal(await auth.getAccessToken({ forceRefresh: true }), null);
  assert.equal(auth.status().status, 'signed-in');
  const saved = (await storage.load('twitch')).value;
  assert.equal(saved.session.refreshToken, 'refresh-rotated');
  assert.ok(saved.session.expiresAt <= clock.now());
  await clock.tick(300000); assert.equal(auth.status().status, 'signed-in');
  outage = false; await clock.tick(300000);
  assert.equal(await auth.getAccessToken(), 'access-rotated');
  assert.equal(calls.filter(call => call.form?.get('grant_type') === 'refresh_token').length, 1);
  await clock.tick(3599999); assert.equal(callCount(calls, '/validate'), 4);
  await clock.tick(1); assert.equal(callCount(calls, '/validate'), 5);
});
