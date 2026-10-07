import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { createServer } from '../server.js';
import { normalizeSettings, settingsDocument, MAX_SETTINGS_BYTES } from '../src/shared/settings-model.js';

async function serve(t, shared = null) {
  const folder = shared || await mkdtemp(join(tmpdir(), 'pokome-settings-'));
  if (!shared) t.after(() => rm(folder, { recursive: true, force: true }));
  const directory = join(folder, 'data');
  const server = createServer({ customizationDirectory: join(folder, 'customization'), dataDirectory: directory });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const current = async () => (await fetch(`${base}/api/settings`)).json();
  const save = (field, value, headers = {}) => fetch(`${base}/api/settings/${field}`, { method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin', ...headers }, body: JSON.stringify(value) });
  return { base, folder, directory, current, save };
}

test('missing settings serves defaults without creating the data folder, and saves normalized fields atomically', async t => {
  const { base, directory, current, save } = await serve(t);
  const response = await fetch(`${base}/api/settings`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await response.json(), { settings: normalizeSettings({}), revision: 'default' });
  await assert.rejects(stat(directory), { code: 'ENOENT' });
  const result = await save('historyLimit', 200); assert.equal(result.status, 200);
  const saved = await result.json();
  assert.equal(saved.settings.historyLimit, 200); assert.notEqual(saved.revision, 'default');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')), settingsDocument(saved.settings));
  assert.deepEqual(await readdir(directory), ['settings.json']);
  assert.deepEqual(await current(), saved);
  assert.equal((await save('setupComplete', true)).status, 200);
  assert.equal((await current()).settings.setupComplete, true);
  assert.equal((await save('unknown', 'x')).status, 404);
  assert.equal((await save('connections', { twitch: 'Valid_Channel', kick: 'valid-kick', extra: 'drop' })).status, 200);
  assert.deepEqual((await current()).settings.connections, normalizeSettings({ connections: { twitch: 'Valid_Channel', kick: 'valid-kick' } }).connections);
});

test('different ports share settings, serialize distinct fields and notify every event stream', async t => {
  const first = await serve(t), second = await serve(t, first.folder);
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`${second.base}/api/settings/events`, { signal: controller.signal });
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const [connections, users] = await Promise.all([
    first.save('connections', { twitch: 'shared_channel', kick: '' }),
    second.save('users', { twitch: { viewer: { hidden: true, muted: true } }, kick: {} }),
  ]);
  assert.equal(connections.status, 200); assert.equal(users.status, 200);
  const value = await first.current(); assert.deepEqual(await second.current(), value);
  assert.equal(value.settings.connections.twitch, 'shared_channel');
  assert.deepEqual(value.settings.users.twitch.viewer, { hidden: true, muted: true });
  let text = '';
  while (!text.includes(value.revision)) {
    const chunk = await reader.read(); assert.equal(chunk.done, false); text += decoder.decode(chunk.value);
  }
  assert.match(text, /event: change/);
  controller.abort();
});

test('every successful save sends SSE even when the normalized value is unchanged', { timeout: 5000 }, async t => {
  const { base, save } = await serve(t);
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`${base}/api/settings/events`, {
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
  });
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffered = '';
  async function nextChange(revision) {
    for (;;) {
      const end = buffered.indexOf('\n\n');
      if (end >= 0) {
        const frame = buffered.slice(0, end); buffered = buffered.slice(end + 2);
        if (frame.startsWith('event: change\n')) {
          const event = JSON.parse(frame.split('\ndata: ')[1]);
          if (event.revision === revision) return event;
        }
        continue;
      }
      const chunk = await reader.read().catch(error => {
        throw new Error('Every successful save must send an SSE change event', { cause: error });
      });
      assert.equal(chunk.done, false);
      buffered += decoder.decode(chunk.value);
    }
  }
  const first = await (await save('historyLimit', 42)).json();
  assert.deepEqual(await nextChange(first.revision), { revision: first.revision });
  const repeated = await (await save('historyLimit', 42)).json();
  assert.equal(repeated.revision, first.revision);
  assert.deepEqual(await nextChange(repeated.revision), { revision: repeated.revision });
  controller.abort();
});

async function startChild(t, script, args) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { errors += value; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill(); await exited; });
  const ready = await Promise.race([once(child.stdout, 'data').then(([bytes]) => bytes.toString().trim()),
    exited.then(() => { throw new Error(`Child server stopped before startup: ${errors}`); })]);
  return { child, ready, exited };
}

test('separate server processes send external file changes over SSE', { timeout: 10000 }, async t => {
  const first = await serve(t);
  const script = `import { createServer } from ${JSON.stringify(new URL('../server.js', import.meta.url).href)};
    const server = createServer({ dataDirectory: process.argv[1], customizationDirectory: process.argv[2] });
    server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));`;
  const { ready: base } = await startChild(t, script, [first.directory, join(first.folder, 'other-customization')]);
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(`${base}/api/settings/events`, { signal: controller.signal });
  const reader = response.body.getReader(), decoder = new TextDecoder();
  for (let index = 0; index < 8; index++) {
    const one = await first.save('historyLimit', 100 + index);
    const two = await fetch(`${base}/api/settings/setupComplete`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base,
        'Sec-Fetch-Site': 'same-origin' }, body: JSON.stringify(index % 2 === 0) });
    assert.equal(one.status, 200); assert.equal(two.status, 200);
    const value = await first.current(); assert.equal(value.settings.historyLimit, 100 + index);
    assert.equal(value.settings.setupComplete, index % 2 === 0);
  }
  const saved = await (await first.save('connections', { twitch: 'external_change' })).json();
  let text = '';
  while (!text.includes(saved.revision)) {
    const chunk = await reader.read(); assert.equal(chunk.done, false); text += decoder.decode(chunk.value);
  }
  assert.match(text, /event: change/); controller.abort();
});

test('malformed, unsupported and oversized files are read-only and never replaced', async t => {
  const { directory, current, save } = await serve(t);
  await mkdir(directory);
  const path = join(directory, 'settings.json');
  for (const raw of ['{broken', JSON.stringify({ format: 'other', version: 2, settings: {} }),
    JSON.stringify({ format: 'pokome-settings', version: 1, settings: {} }), ' '.repeat(MAX_SETTINGS_BYTES + 1)]) {
    await writeFile(path, raw); const before = await stat(path);
    const value = await current(); assert.deepEqual(value.settings, normalizeSettings({}));
    assert.equal(value.writable, false); assert.match(value.warning, /設定ファイルを読めません/);
    assert.equal((await save('historyLimit', 200)).status, 422);
    assert.equal(await readFile(path, 'utf8'), raw); assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
  }
});

test('settings writes reject cross-origin, remote hosts, missing credentials, wrong types and oversized bodies', async t => {
  const { base, directory, save } = await serve(t);
  for (const headers of [{ Origin: 'http://evil.example' }, { Origin: 'null' }, { Host: 'evil.example', Origin: 'http://evil.example' },
    { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
    assert.equal((await save('setupComplete', true, headers)).status, 403, JSON.stringify(headers));
  }
  const noOrigin = await new Promise((resolve, reject) => {
    const req = request(`${base}/api/settings/setupComplete`, { method: 'PUT', headers: { 'Content-Type': 'application/json' } }, resolve);
    req.on('error', reject); req.end('true');
  });
  assert.equal(noOrigin.statusCode, 403); noOrigin.resume();
  assert.equal((await save('setupComplete', true, { 'Content-Type': 'text/plain' })).status, 415);
  const send = body => fetch(`${base}/api/settings/setupComplete`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' }, body });
  assert.equal((await send('{broken')).status, 400);
  assert.equal((await send(' '.repeat(MAX_SETTINGS_BYTES + 1))).status, 413);
  assert.equal((await fetch(`${base}/api/settings`, { headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/settings`, { method: 'DELETE' })).status, 405);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('a normalized file that would exceed the read limit is rejected without replacing the previous settings', async t => {
  const { directory, current, save } = await serve(t);
  await save('historyLimit', 200);
  const before = await readFile(join(directory, 'settings.json'), 'utf8');
  const users = { twitch: Object.fromEntries(Array.from({ length: 170000 }, (_, index) => [`u${index}`, { hidden: true, muted: false }])), kick: {} };
  assert.ok(Buffer.byteLength(JSON.stringify(users)) < MAX_SETTINGS_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(settingsDocument({ users }), null, 2)) > MAX_SETTINGS_BYTES);
  assert.equal((await save('users', users)).status, 413);
  assert.equal(await readFile(join(directory, 'settings.json'), 'utf8'), before);
  assert.equal((await current()).settings.historyLimit, 200);
  assert.deepEqual(await readdir(directory), ['settings.json']);
});

test('symlinked settings files and data directories never modify their targets', async t => {
  const { directory, folder, current, save } = await serve(t);
  const outside = join(folder, 'outside'); await mkdir(outside);
  const raw = JSON.stringify(settingsDocument({ historyLimit: 200 })); await writeFile(join(outside, 'settings.json'), raw);
  try { await symlink(outside, directory, 'dir'); } catch (error) {
    if (error.code === 'EPERM') { t.skip('This Windows account cannot create symbolic links'); return; } throw error;
  }
  assert.equal((await current()).writable, false);
  assert.equal((await save('historyLimit', 300)).status, 422);
  assert.equal(await readFile(join(outside, 'settings.json'), 'utf8'), raw);
  await rm(directory); await mkdir(directory);
  await symlink(join(outside, 'settings.json'), join(directory, 'settings.json'));
  assert.equal((await current()).writable, false);
  assert.equal((await save('historyLimit', 300)).status, 422);
  assert.equal(await readFile(join(outside, 'settings.json'), 'utf8'), raw);
});
