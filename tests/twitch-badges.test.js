import test from 'node:test';
import assert from 'node:assert/strict';
import { createTwitchBadges } from '../src/server/twitch-badges.js';

const url = id => `https://static-cdn.jtvnw.net/badges/v1/${id}/3`;
const globalUrl = url('b817aba4-fad8-49e2-b88a-7cc744dfa6ec');
const channelUrl = url('eb4a8a4c-eacd-4f5e-b9f2-394348310442');
const helix = (image = globalUrl, set = 'subscriber', version = '0') => ({ data: [{ set_id: set, versions: [{ id: version, image_url_1x: image.slice(0, -1) + '1', image_url_2x: image.slice(0, -1) + '2', image_url_4x: image, title: 'Subscriber', description: 'unused', click_url: 'https://unused.example' }] }] });
const response = (status, data, headers = {}) => new Response(JSON.stringify(data), { status, headers });
function fixture(t, fetchImpl) {
  let time = 1000, identity = 'one', token = 'secret-one', refreshes = 0;
  const listeners = new Set(), calls = [];
  const auth = { sessionId: () => identity,
    getAccessToken: async ({ forceRefresh = false, rejectedToken } = {}) => {
      if (!identity) return null;
      if (forceRefresh && (!rejectedToken || rejectedToken === token)) { refreshes++; token = 'secret-two'; }
      return token;
    }, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); } };
  const badges = createTwitchBadges({ auth, clientId: 'test-client', now: () => time, fetchImpl: async (destination, init) => {
    calls.push({ destination, token: init.headers.Authorization });
    return fetchImpl ? fetchImpl(destination, init) : response(200, helix(destination.includes('global') ? globalUrl : channelUrl));
  } });
  t.after(() => badges.close());
  return { badges, calls, advance: ms => { time += ms; }, refreshes: () => refreshes,
    change: value => { identity = value; for (const fn of listeners) fn(); } };
}

test('lists share in-flight fetches, channel versions win, and cache expires after one hour', async t => {
  const f = fixture(t);
  const results = await Promise.all([f.badges.get('123'), f.badges.get('123')]);
  assert.equal(f.calls.length, 2); assert.equal(results[0].badges[0].url, channelUrl);
  assert.doesNotMatch(JSON.stringify(results), /secret-|click_url|description|Authorization/);
  await f.badges.get('456'); assert.equal(f.calls.length, 3);
  f.advance(3599999); await f.badges.get('123'); assert.equal(f.calls.length, 3);
  f.advance(1); await f.badges.get('123'); assert.equal(f.calls.length, 5);
});

test('offline, partial and empty lists retain only the right successful data and suppress retries', async t => {
  let failed = false;
  const f = fixture(t, destination => destination.includes('global') ? response(200, helix()) : failed ? response(503, { private: 'secret' }) : response(200, helix(channelUrl)));
  await f.badges.get('123'); failed = true; f.advance(3600000);
  let result = await f.badges.get('123'); assert.equal(result.channel, 'failed'); assert.equal(result.badges[0].url, channelUrl);
  const count = f.calls.length; await f.badges.get('123'); assert.equal(f.calls.length, count);
  result = await f.badges.get('456'); assert.equal(result.badges[0].url, globalUrl);
  f.advance(300000); await f.badges.get('123'); assert.equal(f.calls.length, count + 2);
  const empty = fixture(t, () => response(200, { data: [] }));
  assert.deepEqual((await empty.badges.get('1')).badges, []); assert.equal((await empty.badges.get('1')).channel, 'ready');
});

test('429 respects rate-limit reset and 401 retries once with the shared current token', async t => {
  const limited = fixture(t, () => response(429, {}, { 'Ratelimit-Reset': '601' }));
  await limited.badges.get('1'); limited.advance(300000); await limited.badges.get('1'); assert.equal(limited.calls.length, 2);
  limited.advance(300000); await limited.badges.get('1'); assert.equal(limited.calls.length, 4);
  const rejected = fixture(t, (_url, init) => response(init.headers.Authorization === 'Bearer secret-one' ? 401 : 200, helix()));
  assert.equal((await rejected.badges.get('1')).global, 'ready'); assert.equal(rejected.refreshes(), 1);
  const always = fixture(t, () => response(401, {}));
  assert.equal((await always.badges.get('1')).global, 'failed'); assert.equal(always.refreshes(), 1);
});

test('logout and account changes discard delayed results and signed-out requests never fetch', async t => {
  const pending = [];
  const f = fixture(t, () => new Promise(resolve => pending.push(resolve)));
  const result = f.badges.get('1');
  while (pending.length < 2) await new Promise(setImmediate);
  f.change(''); for (const resolve of pending) resolve(response(200, helix()));
  assert.deepEqual((await result).badges, []);
  await f.badges.get('1'); assert.equal(f.calls.length, 2);
  f.change('other'); const next = f.badges.get('1');
  while (pending.length < 4) await new Promise(setImmediate);
  for (const resolve of pending.slice(2)) resolve(response(200, helix()));
  assert.equal((await next).badges.length, 1);
});

test('invalid inputs, malformed JSON, excessive bodies and unsafe image URLs never escape', async t => {
  const f = fixture(t);
  for (const id of ['0', '-1', '1'.repeat(21), 'https://evil.example']) await assert.rejects(f.badges.get(id));
  assert.equal(f.calls.length, 0);
  for (const data of [{ other: [] }, helix('https://evil.example'), helix(globalUrl + '?x=1')]) {
    const invalid = fixture(t, () => response(200, data)); assert.deepEqual((await invalid.badges.get('1')).badges, []);
  }
  const huge = fixture(t, () => new Response(' '.repeat(1024 * 1024 + 1)));
  assert.equal((await huge.badges.get('1')).global, 'failed');
});

test('eight pending channel slots never evict an in-flight lookup and duplicate its request', async t => {
  const pending = [];
  const f = fixture(t, () => new Promise(resolve => pending.push(resolve)));
  const work = Array.from({ length: 9 }, (_, i) => f.badges.get(String(i + 1)));
  await new Promise(setImmediate);
  const busy = await work[8];
  work.push(f.badges.get('1')); await new Promise(setImmediate);
  const first = f.calls.filter(call => call.destination.endsWith('broadcaster_id=1')).length;
  for (const resolve of pending) resolve(response(200, helix())); await Promise.all(work);
  assert.equal(first, 1);
  assert.equal(f.calls.filter(call => call.destination.includes('broadcaster_id=')).length, 8);
  assert.equal(busy.channel, 'busy', 'capacity is distinct from an empty or failed list');
  assert.equal(busy.nextRefreshAt, 1000, 'capacity does not impose a failure cooldown');
  const retry = f.badges.get('9'); await new Promise(setImmediate);
  assert.equal(f.calls.filter(call => call.destination.endsWith('broadcaster_id=9')).length, 1);
  pending.at(-1)(response(200, helix(channelUrl)));
  assert.equal((await retry).badges[0].url, channelUrl);
});
