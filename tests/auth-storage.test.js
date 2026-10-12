import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthStorage } from '../src/server/auth-storage.js';

const tokens = { accessToken: 'private-access', refreshToken: 'private-refresh', account: { login: 'sample' } };
const crypt = {
  platform: 'win32',
  protect: async bytes => Buffer.from(bytes).map(byte => byte ^ 91),
  unprotect: async bytes => Buffer.from(bytes).map(byte => byte ^ 91),
};
async function setup(t, options = crypt) {
  const folder = await mkdtemp(join(tmpdir(), 'pokome-auth-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const directory = join(folder, 'data');
  const storage = createAuthStorage(directory, options);
  t.after(() => storage.close());
  return { folder, directory, storage, path: join(directory, 'auth', 'twitch.json') };
}

test('auth storage creates folders only on save and replaces one encrypted document atomically', async t => {
  const { directory, path, storage } = await setup(t);
  assert.deepEqual(await storage.load('twitch'), { value: null, revision: 'default' });
  await storage.remove('twitch');
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  const saved = await storage.save('twitch', tokens);
  assert.deepEqual(saved.value, tokens);
  const raw = await readFile(path, 'utf8');
  assert.ok(!raw.includes(tokens.accessToken)); assert.ok(!raw.includes(tokens.refreshToken));
  assert.deepEqual(await storage.load('twitch'), saved);
  assert.deepEqual(await readdir(join(directory, 'auth')), ['twitch.json']);
  await storage.remove('twitch');
  assert.deepEqual(await storage.load('twitch'), { value: null, revision: 'default' });
});

test('non-Windows auth is memory-only, shared until the last storage closes, and copied at boundaries', async t => {
  const { directory, storage } = await setup(t, { platform: 'linux' });
  const second = createAuthStorage(directory, { platform: 'linux' });
  t.after(() => second.close());
  const input = structuredClone(tokens);
  const saving = storage.save('twitch', input); input.accessToken = 'mutated';
  await saving;
  const loaded = await second.load('twitch'); assert.deepEqual(loaded.value, tokens);
  loaded.value.accessToken = 'mutated-again';
  assert.deepEqual((await storage.load('twitch')).value, tokens);
  await storage.close(); assert.deepEqual((await second.load('twitch')).value, tokens);
  await second.close();
  const third = createAuthStorage(directory, { platform: 'linux' }); t.after(() => third.close());
  assert.equal((await third.load('twitch')).value, null);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('auth writes serialize by service across instances and close waits for a pending save', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const { directory, storage } = await setup(t, { ...crypt, protect: async bytes => {
    calls++; if (calls === 1) { entered(); await blocked; } return crypt.protect(bytes);
  } });
  const second = createAuthStorage(directory, crypt); t.after(() => second.close());
  const first = storage.save('twitch', tokens); await started;
  const last = second.save('twitch', { accessToken: 'new-access', refreshToken: 'new-refresh' });
  const closing = storage.close();
  release(); await Promise.all([first, last, closing]);
  assert.deepEqual((await second.load('twitch')).value, { accessToken: 'new-access', refreshToken: 'new-refresh' });
});

test('unreadable auth is retained, including invalid envelopes and decrypted non-objects', async t => {
  const { directory, path, storage } = await setup(t);
  await mkdir(join(directory, 'auth'), { recursive: true });
  const documents = ['{broken', JSON.stringify({ format: 'other', version: 1, encrypted: 'abcd' }),
    JSON.stringify({ format: 'pokome-auth', version: 1, encrypted: 'invalid!' }),
    JSON.stringify({ format: 'pokome-auth', version: 1, encrypted: (await crypt.protect(Buffer.from('[]'))).toString('base64') })];
  for (const raw of documents) {
    await writeFile(path, raw);
    const loaded = await storage.load('twitch');
    assert.equal(loaded.value, null); assert.equal(loaded.unreadable, true);
    assert.equal(await readFile(path, 'utf8'), raw);
  }
  await storage.save('twitch', tokens);
  const otherUser = createAuthStorage(directory, { ...crypt, unprotect: () => { throw new Error('private-access'); } });
  t.after(() => otherUser.close());
  const before = await readFile(path);
  assert.equal((await otherUser.load('twitch')).unreadable, true);
  assert.deepEqual(await readFile(path), before);
  await otherUser.save('twitch', { status: 'waiting', deviceCode: 'private-code' });
  assert.equal((await storage.load('twitch')).value.status, 'waiting');
});

test('invalid service names and values are rejected without creating files or exposing secrets', async t => {
  const { directory, storage } = await setup(t, { ...crypt, protect: () => { throw new Error('private-access'); } });
  for (const service of ['', '../twitch', 'Twitch', 'twitch/x', 'a'.repeat(33)]) {
    for (const action of [() => storage.load(service), () => storage.save(service, tokens), () => storage.remove(service)]) {
      await assert.rejects(action, /サービス/);
    }
    assert.throws(() => storage.subscribe(service, () => {}), /サービス/);
  }
  for (const value of [null, [], 'private-access', { accessToken: 'x'.repeat(65536) }]) await assert.rejects(() => storage.save('twitch', value));
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  await assert.rejects(() => storage.save('twitch', tokens), error => !error.message.includes('private-access'));
});

test('subscribers see shared saves and external file replacement without receiving secrets', { timeout: 5000 }, async t => {
  const { directory, path, storage } = await setup(t);
  const second = createAuthStorage(directory, crypt); t.after(() => second.close());
  let next;
  const changes = [];
  const unsubscribe = second.subscribe('twitch', revision => { changes.push(revision); next?.(revision); });
  const saved = await storage.save('twitch', tokens);
  assert.ok(changes.includes(saved.revision));
  const external = new Promise(resolve => { next = revision => { if (revision !== saved.revision) resolve(revision); }; });
  const encrypted = (await crypt.protect(Buffer.from(JSON.stringify({ status: 'reauth', reason: 'expired' })))).toString('base64');
  await writeFile(path, JSON.stringify({ format: 'pokome-auth', version: 1, encrypted }));
  await external;
  assert.equal((await second.load('twitch')).value.status, 'reauth');
  assert.ok(changes.every(value => typeof value === 'string' && !value.includes('private')));
  unsubscribe();
  const count = changes.length; await storage.remove('twitch'); assert.equal(changes.length, count);
});

test('auth storage refuses linked data/auth directories and linked files without modifying targets', async t => {
  const { folder, directory, storage } = await setup(t);
  const outside = join(folder, 'outside'); await mkdir(outside);
  const original = 'unreadable-secret'; await writeFile(join(outside, 'twitch.json'), original);
  await mkdir(directory);
  try { await symlink(outside, join(directory, 'auth'), 'junction'); } catch (error) {
    if (error.code === 'EPERM') { t.skip('This account cannot create directory links'); return; } throw error;
  }
  assert.equal((await storage.load('twitch')).unreadable, true);
  await assert.rejects(() => storage.save('twitch', tokens)); await assert.rejects(() => storage.remove('twitch'));
  assert.equal(await readFile(join(outside, 'twitch.json'), 'utf8'), original);
  const linkedRoot = join(folder, 'linked-data'); await symlink(outside, linkedRoot, 'junction');
  const rootStorage = createAuthStorage(linkedRoot, crypt); t.after(() => rootStorage.close());
  assert.equal((await rootStorage.load('twitch')).unreadable, true);
  await assert.rejects(() => rootStorage.save('twitch', tokens)); await assert.rejects(() => rootStorage.remove('twitch'));
  const fileRoot = join(folder, 'file-data'); await mkdir(join(fileRoot, 'auth'), { recursive: true });
  try { await symlink(join(outside, 'twitch.json'), join(fileRoot, 'auth', 'twitch.json')); } catch (error) {
    if (error.code === 'EPERM') { t.diagnostic('This account cannot create file links'); return; } throw error;
  }
  const fileStorage = createAuthStorage(fileRoot, crypt); t.after(() => fileStorage.close());
  assert.equal((await fileStorage.load('twitch')).unreadable, true);
  await assert.rejects(() => fileStorage.save('twitch', tokens)); await assert.rejects(() => fileStorage.remove('twitch'));
  assert.equal(await readFile(join(outside, 'twitch.json'), 'utf8'), original);
});

test('Windows DPAPI CurrentUser encrypts and decrypts auth with real PowerShell', { skip: process.platform !== 'win32' }, async t => {
  const { directory, path, storage } = await setup(t, {});
  await storage.save('twitch', tokens);
  const raw = await readFile(path, 'utf8'); assert.ok(!raw.includes('private-access')); assert.ok(!raw.includes('private-refresh'));
  const other = createAuthStorage(directory); t.after(() => other.close());
  assert.deepEqual((await other.load('twitch')).value, tokens);
});
