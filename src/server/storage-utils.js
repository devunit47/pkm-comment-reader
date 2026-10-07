import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { safeDirectory } from './local-customization.js';

export const failure = (status, message) => Object.assign(new Error(message), { status });
// A save can rename a new file into place between the read checks.
export const changed = () => Object.assign(failure(422, 'ファイルを読み込めません。'), { code: 'ECHANGED' });
export const directoryChanged = () => Object.assign(failure(422, '操作中にフォルダーが変更されました。通常のフォルダーか確認して一覧を更新してください。'), { code: 'EDIRECTORYCHANGED' });

// Recheck every ancestor before path-based mutations and retries, because
// checking only the leaf misses a directory tree replaced by a junction.
export async function guardDirectory(root, directory) {
  root = resolve(root); directory = resolve(directory);
  const remainder = relative(root, directory);
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) throw directoryChanged();
  const paths = [root];
  for (const part of remainder.split(sep).filter(Boolean)) paths.push(join(paths.at(-1), part));
  const snapshots = [];
  for (const path of paths) snapshots.push(await safeDirectory(path));
  const check = async () => {
    for (let index = 0; index < paths.length; index++) {
      let actual;
      try { actual = await safeDirectory(paths[index]); } catch { throw directoryChanged(); }
      const before = snapshots[index];
      if (before.real !== actual.real || before.info.dev !== actual.info.dev || before.info.ino !== actual.info.ino) throw directoryChanged();
    }
  };
  await check();
  return check;
}

async function readRegularFile(path, maxBytes) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw failure(422, 'ファイルを読み込めません。');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) throw failure(422, 'ファイルを読み込めません。');
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw changed();
    const buffer = Buffer.alloc(opened.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== opened.size) throw changed();
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) throw changed();
    return { bytes: buffer.subarray(0, size), mtimeMs: opened.mtimeMs };
  } finally { await handle.close(); }
}

// Windows sharing errors during replacement normally clear within milliseconds.
export async function retryTransient(task, { attempts = 20, codes = ['EPERM', 'EBUSY', 'EACCES'], delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await task(); }
    catch (error) {
      if (attempt >= attempts || !codes.includes(error.code)) throw error;
      await delay(Math.min(100, attempt * 10));
    }
  }
}
export const renameWithRetry = (from, to, { renameFile = rename, ...options } = {}) => retryTransient(() => renameFile(from, to), options);
export const readStable = (path, maxBytes) => retryTransient(() => readRegularFile(path, maxBytes), { codes: ['EPERM', 'EBUSY', 'EACCES', 'ECHANGED'] });

export async function atomicWrite(path, content, root = dirname(path), checkAncestor = async () => {}) {
  await checkAncestor();
  const checkLocal = await guardDirectory(root, dirname(path));
  const check = async () => { await checkAncestor(); await checkLocal(); };
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    await check();
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0));
    await check();
    await handle.writeFile(content);
    await handle.close(); handle = null;
    await renameWithRetry(temporary, path, { renameFile: async (from, to) => { await check(); return rename(from, to); } });
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await check().then(() => unlink(temporary)).catch(() => {});
    throw error;
  }
}

export async function readBody(req, maxBytes) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw failure(413, '送られたデータが大きすぎます。');
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw failure(413, '送られたデータが大きすぎます。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const localHost = host => /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host);
// OBS and address-bar reads are allowed; writes require this app's own page.
export function readAllowed(req) {
  const host = req.headers.host || '', site = req.headers['sec-fetch-site'];
  return localHost(host) && (!req.headers.origin || req.headers.origin === `http://${host}`) && (!site || site === 'same-origin' || site === 'none');
}
export function writeAllowed(req) {
  const host = req.headers.host || '', site = req.headers['sec-fetch-site'];
  return localHost(host) && req.headers.origin === `http://${host}` && site === 'same-origin';
}

export function createEventStream() {
  const clients = new Map();
  let stopping = false;
  function events(req, res) {
    // A keep-alive request may arrive after server.close() stops listening.
    if (stopping) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      res.end('サーバーを停止しています。'); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
    const close = () => { clearInterval(heartbeat); clients.delete(res); };
    clients.set(res, close);
    req.on('close', close); res.on('close', close);
  }
  const broadcast = revision => {
    for (const client of clients.keys()) client.write(`event: change\ndata: ${JSON.stringify({ revision })}\n\n`);
  };
  function closeEvents() {
    stopping = true;
    for (const [client, close] of clients) { close(); client.end(); }
  }
  return { events, broadcast, closeEvents };
}
