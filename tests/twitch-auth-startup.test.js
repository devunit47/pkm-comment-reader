import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createAuthStorage } from '../src/server/auth-storage.js';
import { startupPending } from './auth-startup-support.js';

async function runChild(t, mode, directory, repair) {
  const child = fork(new URL('./auth-startup-support.js', import.meta.url), [mode, directory || ''], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '', repairError;
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  child.on('message', async message => {
    if (!message.repair) return;
    try { await repair(); child.send({ repaired: true }); }
    catch (error) { repairError = error; child.kill(); }
  });
  const [code, signal] = await once(child, 'exit');
  if (repairError) throw repairError;
  assert.equal(signal, null, output);
  assert.equal(code, 0, output);
  assert.match(output, /Startup storage failure survived; start\/logout recovered/);
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'pokome-auth-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

for (const operation of ['load', 'remove']) {
  test(`an unawaited authentication startup survives a storage ${operation} rejection and recovers`, { timeout: 15000 }, async t => {
    await runChild(t, operation);
  });
}

test('the real auth API reports a startup read failure as storage reauth and recovers after repair', { timeout: 15000 }, async t => {
  const directory = await temporaryDirectory(t), data = join(directory, 'data');
  await mkdir(data);
  const blocked = join(data, 'auth');
  await writeFile(blocked, 'A regular file cannot be an authentication directory.');
  await runChild(t, 'api-load', directory, () => rm(blocked));
});

test('a Windows read-share lock on pending authentication cannot terminate the server and recovery works after release', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const directory = await temporaryDirectory(t), data = join(directory, 'data');
  const storage = createAuthStorage(data, { platform: 'win32', protect: async bytes => Buffer.from(bytes), unprotect: async bytes => Buffer.from(bytes) });
  await storage.save('twitch', startupPending);
  await storage.close();
  const script = "$f=[IO.File]::Open($env:POKOME_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); Write-Output 'locked'; [Console]::In.ReadLine() | Out-Null; $f.Close(); Write-Output 'released'";
  const locker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, POKOME_LOCK_FILE: join(data, 'auth', 'twitch.json') }, windowsHide: true,
  });
  const lines = createInterface({ input: locker.stdout });
  let errors = '';
  locker.stderr.on('data', bytes => { errors += bytes; });
  const exited = once(locker, 'exit');
  t.after(async () => { lines.close(); if (locker.exitCode === null) { locker.kill(); await exited; } });
  assert.equal(await Promise.race([once(lines, 'line').then(([line]) => line), exited.then(() => { throw new Error(errors || 'Lock process exited before opening the file'); })]), 'locked');
  await runChild(t, 'api-remove', directory, async () => {
    const released = once(lines, 'line');
    locker.stdin.end('\n');
    assert.equal((await released)[0], 'released');
    assert.equal((await exited)[0], 0, errors);
  });
});
