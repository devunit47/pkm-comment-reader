import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { unwatchFile, watchFile } from 'node:fs';
import { lstat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeDirectory } from './local-customization.js';
import { atomicWrite, failure, guardDirectory, readStable } from './storage-utils.js';

const directories = new Map();
const maxPlainBytes = 65536, maxFileBytes = 131072;
const defaultDirectory = fileURLToPath(new URL('../../data/', import.meta.url));
const storageError = () => failure(503, '認証情報を保存できません。dataフォルダーのアクセス権を確認してください。');
const empty = () => ({ value: null, revision: 'default' });
const revisionOf = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 32);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function decodeBase64(value) {
  if (typeof value !== 'string' || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw storageError();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw storageError();
  return bytes;
}

function dpapi(bytes, operation) {
  // Only fixed code enters the command line; secret bytes use standard streams.
  const script = `$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName System.Security; $inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $outputBytes=[Security.Cryptography.ProtectedData]::${operation}($inputBytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($outputBytes)) } catch { exit 1 }`;
  return new Promise((resolveResult, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let output = '', failed = false;
    const fail = () => { failed = true; child.kill(); };
    const timer = setTimeout(fail, 15000); timer.unref();
    child.on('error', () => { failed = true; });
    child.stdin.on('error', () => { failed = true; });
    child.stdout.setEncoding('ascii');
    child.stdout.on('data', chunk => { output += chunk; if (output.length > maxFileBytes) fail(); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) { reject(storageError()); return; }
      try { resolveResult(decodeBase64(output.trim())); } catch { reject(storageError()); }
    });
    child.stdin.end(Buffer.from(bytes).toString('base64'));
  });
}

export function createAuthStorage(directory = defaultDirectory, { platform = process.platform,
  protect = bytes => dpapi(bytes, 'Protect'), unprotect = bytes => dpapi(bytes, 'Unprotect') } = {}) {
  const root = resolve(directory instanceof URL ? fileURLToPath(directory) : directory), auth = join(root, 'auth');
  const disk = platform === 'win32';
  const key = `${disk ? 'disk' : 'memory'}:${disk ? root.toLowerCase() : root}`;
  let shared = directories.get(key);
  if (!shared) { shared = { users: 0, services: new Map() }; directories.set(key, shared); }
  shared.users++;
  let closed = false, closing;
  const subscriptions = new Set();

  function serviceEntry(service) {
    if (typeof service !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(service)) throw failure(400, 'サービス名が正しくありません。');
    if (closed) throw failure(503, '認証情報の保存を終了しています。');
    let entry = shared.services.get(service);
    if (!entry) {
      entry = { queue: Promise.resolve(), value: null, revision: 'default', listeners: new Set(), path: join(auth, `${service}.json`) };
      shared.services.set(service, entry);
    }
    return entry;
  }
  function exclusive(entry, task) {
    const run = entry.queue.then(task, task); entry.queue = run.catch(() => {}); return run;
  }
  function notify(entry, revision) {
    if (entry.revision === revision) return;
    entry.revision = revision;
    for (const callback of entry.listeners) {
      try { callback(revision); } catch { /* A subscriber must not interrupt storage. */ }
    }
  }
  async function read(entry) {
    if (!disk) return entry.value === null ? empty() : { value: structuredClone(entry.value), revision: entry.revision };
    let revision = 'unreadable';
    try {
      const check = await guardDirectory(dirname(root), auth);
      const raw = (await readStable(entry.path, maxFileBytes)).bytes;
      await check(); revision = revisionOf(raw);
      const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      if (document?.format !== 'pokome-auth' || document.version !== 1) throw storageError();
      const bytes = await unprotect(decodeBase64(document.encrypted));
      if (!Buffer.isBuffer(bytes) || bytes.length > maxPlainBytes) throw storageError();
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!isObject(value)) throw storageError();
      return { value, revision };
    } catch (error) {
      if (error.code === 'ENOENT') return empty();
      return { value: null, unreadable: true, revision };
    }
  }
  async function load(service) { return read(serviceEntry(service)); }
  async function save(service, value) {
    const entry = serviceEntry(service);
    let bytes, copied;
    try {
      if (!isObject(value)) throw storageError();
      bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > maxPlainBytes) throw storageError();
      copied = JSON.parse(bytes.toString('utf8'));
      if (!isObject(copied)) throw storageError();
    } catch { throw storageError(); }
    return exclusive(entry, async () => {
      try {
        if (!disk) {
          entry.value = copied;
          const revision = revisionOf(bytes); notify(entry, revision);
          return { value: structuredClone(copied), revision };
        }
        const encrypted = await protect(bytes);
        if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw storageError();
        const content = JSON.stringify({ format: 'pokome-auth', version: 1, encrypted: encrypted.toString('base64') });
        if (Buffer.byteLength(content) > maxFileBytes) throw storageError();
        const checkParent = await guardDirectory(dirname(root), dirname(root));
        await safeDirectory(root, true); await checkParent();
        const checkRoot = await guardDirectory(dirname(root), root);
        await safeDirectory(auth, true); await checkRoot();
        const check = await guardDirectory(dirname(root), auth);
        try {
          const info = await lstat(entry.path);
          if (!info.isFile() || info.isSymbolicLink()) throw storageError();
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await atomicWrite(entry.path, content, auth, check);
        const revision = revisionOf(Buffer.from(content)); notify(entry, revision);
        return { value: structuredClone(copied), revision };
      } catch { throw storageError(); }
    });
  }
  async function remove(service) {
    const entry = serviceEntry(service);
    return exclusive(entry, async () => {
      if (disk) {
        try {
          const check = await guardDirectory(dirname(root), auth);
          const info = await lstat(entry.path);
          if (!info.isFile() || info.isSymbolicLink()) throw storageError();
          await check(); await unlink(entry.path);
        } catch (error) { if (error.code !== 'ENOENT') throw storageError(); }
      }
      entry.value = null; notify(entry, 'default'); return empty();
    });
  }
  function subscribe(service, callback) {
    const entry = serviceEntry(service);
    const listener = revision => callback(revision);
    entry.listeners.add(listener);
    const unsubscribe = () => { entry.listeners.delete(listener); subscriptions.delete(unsubscribe); };
    subscriptions.add(unsubscribe);
    if (disk && !entry.watch) {
      // Polling follows atomic replacements without creating data/auth at startup.
      entry.watch = () => { exclusive(entry, async () => notify(entry, (await read(entry)).revision)).catch(() => {}); };
      watchFile(entry.path, { persistent: false, interval: 200 }, entry.watch);
    }
    return unsubscribe;
  }
  function close() {
    if (closing) return closing;
    closed = true;
    for (const unsubscribe of subscriptions) unsubscribe();
    shared.users--;
    if (!shared.users) for (const entry of shared.services.values()) if (entry.watch) unwatchFile(entry.path, entry.watch);
    closing = Promise.all([...shared.services.values()].map(entry => entry.queue)).then(() => {
      if (!shared.users && directories.get(key) === shared) directories.delete(key);
    });
    return closing;
  }
  return { load, save, remove, subscribe, close };
}
