import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setImmediate as immediate } from 'node:timers/promises';
import { join } from 'node:path';
import { createServer } from '../server.js';
import { createTwitchAuth } from '../src/server/twitch-auth.js';
import { fakeClock } from './auth-support.js';

const [mode, directory] = process.argv.slice(2);
const pending = {
  id: '00000000-0000-4000-8000-000000000000', clientId: 'test-client', status: 'pending',
  pending: { device_code: 'private-device', user_code: 'ABCD-EFGH', verification_uri: 'https://www.twitch.tv/activate', expiresAt: 1600000, interval: 5000 },
};
export const startupPending = pending;
const fetchImpl = async url => {
  assert.equal(url, 'https://id.twitch.tv/oauth2/device', 'startup and recovery must not request a token');
  return { ok: true, status: 200, json: async () => ({ device_code: 'private-device', user_code: 'NEW-CODE', verification_uri: 'https://www.twitch.tv/activate', expires_in: 600, interval: 5 }) };
};
function storageState(state) {
  assert.equal(state.status, 'reauth');
  assert.match(state.reason, /保存できません/);
}

async function directStartup() {
  let broken = true, value = mode === 'remove' ? pending : null, revision = 'initial';
  const storage = {
    subscribe: () => () => {},
    async load() { if (mode === 'load' && broken) throw new Error('Read unavailable'); return { value, revision }; },
    async save(key, next) { value = next; revision += '-saved'; return { revision }; },
    async remove() { if (broken) throw new Error('Remove unavailable'); value = null; revision = 'default'; return { revision }; },
  };
  const auth = createTwitchAuth({ storage, clientId: 'test-client', fetchImpl, clock: fakeClock() });
  // Deliberately leave ready unobserved through a full event-loop turn.
  await immediate();
  storageState(auth.status());
  broken = false;
  assert.equal((await auth.start()).status, 'pending');
  assert.deepEqual(await auth.logout(), { status: 'signed-out' });
  await auth.close();
}

async function apiStartup() {
  const server = createServer({
    dataDirectory: join(directory, 'data'), customizationDirectory: join(directory, 'customization'),
    twitchClientId: 'test-client', authClock: fakeClock(), authPlatform: 'win32',
    authProtect: async bytes => Buffer.from(bytes), authUnprotect: async bytes => Buffer.from(bytes), fetchImpl,
  });
  // createServer starts authentication without awaiting its ready promise.
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const initial = await fetch(`${base}/api/auth/twitch`);
  assert.equal(initial.status, 200);
  storageState(await initial.json());
  assert.equal((await fetch(`${base}/api/settings`)).status, 200);
  const repaired = once(process, 'message');
  process.send({ repair: true });
  assert.deepEqual((await repaired)[0], { repaired: true });
  const action = async name => {
    const response = await fetch(`${base}/api/auth/twitch`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify({ action: name }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await action('start')).status, 'pending');
  assert.deepEqual(await action('logout'), { status: 'signed-out' });
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

if (['load', 'remove', 'api-load', 'api-remove'].includes(mode)) {
  try {
    await (mode.startsWith('api-') ? apiStartup() : directStartup());
    console.log('Startup storage failure survived; start/logout recovered.');
    process.disconnect();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
