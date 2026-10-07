import { createHash, randomUUID } from 'node:crypto';
import { constants, watchFile, unwatchFile } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeDirectory } from './local-customization.js';
import { atomicWrite, createEventStream, failure, guardDirectory, readAllowed, readBody, readStable, retryTransient, writeAllowed } from './storage-utils.js';
import { MAX_SETTINGS_BYTES, SETTINGS_FIELDS, normalizeSettings, settingsDocument } from '../shared/settings-model.js';

export const DEFAULT_DATA_DIRECTORY = fileURLToPath(new URL('../../data/', import.meta.url));
const directories = new Map();
const warning = '設定ファイルを読めません。標準の設定を使っています。原本を保護するため保存を止めています。アプリを終了し、data/settings.jsonを別の場所へ退避してから、ファイルを修正するか対応する版で開き直してください。';

export function createSettingsStorage(directory = DEFAULT_DATA_DIRECTORY) {
  const root = resolve(directory instanceof URL ? fileURLToPath(directory) : directory), path = join(root, 'settings.json');
  // Servers on different ports in the same process share the file and save queue.
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  let shared = directories.get(key);
  if (!shared) {
    shared = { queue: Promise.resolve(), listeners: new Set(), revision: null, watching: false };
    directories.set(key, shared);
  }
  const streams = createEventStream(); shared.listeners.add(streams.broadcast);
  const exclusive = task => {
    const run = shared.queue.then(task, task); shared.queue = run.catch(() => {}); return run;
  };
  const defaults = () => ({ settings: normalizeSettings({}), revision: 'default' });
  const unreadable = revision => ({ settings: normalizeSettings({}), revision, writable: false, warning });
  const notify = revision => {
    if (revision === shared.revision) return;
    shared.revision = revision;
    for (const broadcast of shared.listeners) broadcast(revision);
  };

  async function load() {
    let raw, revision = 'unreadable';
    try {
      const check = await guardDirectory(dirname(root), root);
      try { raw = (await readStable(path, MAX_SETTINGS_BYTES)).bytes; }
      catch (error) { await check(); if (error.code === 'ENOENT') return defaults(); throw error; }
      await check();
      revision = createHash('sha256').update(raw).digest('hex').slice(0, 32);
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      if (value?.format !== 'pokome-settings' || value.version !== 2 || !value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) return unreadable(revision);
      return { settings: normalizeSettings(value.settings), revision };
    } catch (error) {
      if (error.code === 'ENOENT' && !raw) return defaults();
      return unreadable(revision);
    }
  }

  async function lock() {
    const check = await guardDirectory(dirname(root), root), lockPath = join(root, '.settings.lock'), token = randomUUID();
    const temporary = join(root, `.settings-${process.pid}-${token}.lock.tmp`);
    const discard = async (path, expected) => {
      await check();
      const actual = await lstat(path);
      if (!actual.isFile() || actual.isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino) return;
      await retryTransient(async () => { await check(); return unlink(path); });
    };
    const remove = async (expected, ownerToken) => {
      await check();
      const actual = await lstat(lockPath);
      if (!actual.isFile() || actual.isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino) return;
      const owner = JSON.parse((await readStable(lockPath, 1024)).bytes.toString('utf8'));
      if (owner.token !== ownerToken) return;
      await discard(lockPath, expected);
    };
    let info, handle;
    try {
      await check();
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0));
      info = await handle.stat();
      await check();
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      await handle.close(); handle = null;
      for (let attempt = 0; attempt < 100; attempt++) {
        await check();
        // Publishing an already-written inode avoids a crash leaving an empty
        // shared lock whose owner cannot be identified safely.
        try { await link(temporary, lockPath); return () => remove(info, token); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          try {
            const existing = await lstat(lockPath), raw = (await readStable(lockPath, 1024)).bytes;
            const owner = JSON.parse(raw.toString('utf8'));
            if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== 'string' || !owner.token) throw failure(409, '保存用のロックを確認できません。アプリを終了してdataフォルダーを確認してください。');
            let running = true;
            try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') running = false; else if (error.code !== 'EPERM') throw error; }
            if (!running) { await remove(existing, owner.token); continue; }
          } catch (error) {
            if (!['ENOENT', 'ECHANGED'].includes(error.code)) throw error instanceof SyntaxError
              ? failure(409, '保存用のロックを確認できません。アプリを終了してdataフォルダーを確認してください。') : error;
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      throw failure(409, 'ほかの画面が設定を保存中です。少し待ってからやり直してください。');
    } finally {
      if (handle) await handle.close().catch(() => {});
      if (info) await discard(temporary, info).catch(() => {});
    }
  }

  async function save(field, value) {
    if (!SETTINGS_FIELDS.includes(field)) throw failure(404, '設定項目が見つかりません。');
    return exclusive(async () => {
      if ((await load()).writable === false) throw Object.assign(failure(422, warning), { writable: false });
      await safeDirectory(root, true);
      const release = await lock();
      try {
        const before = await load();
        if (before.writable === false) throw Object.assign(failure(422, before.warning), { writable: false });
        const document = settingsDocument({ ...before.settings, [field]: value }), content = JSON.stringify(document, null, 2);
        if (Buffer.byteLength(content) > MAX_SETTINGS_BYTES) throw failure(413, '設定のデータが大きすぎます。ユーザー管理の件数を減らしてください。');
        const check = await guardDirectory(dirname(root), root);
        await atomicWrite(path, content, root, check);
        const after = await load();
        if (after.writable === false) throw Object.assign(failure(422, after.warning), { writable: false });
        notify(after.revision); return after;
      } finally { await release(); }
    });
  }

  async function handle(req, res, url) {
    const json = (status, data) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    try {
      if (req.method === 'GET') {
        if (!readAllowed(req)) throw failure(403, 'このアプリから接続してください。');
        if (url.pathname === '/api/settings') { json(200, await load()); return; }
        if (url.pathname === '/api/settings/events') { streams.events(req, res); return; }
        throw failure(404, '見つかりません。');
      }
      if (req.method === 'PUT') {
        if (!writeAllowed(req)) throw failure(403, 'このアプリから操作してください。');
        const field = /^\/api\/settings\/([^/]+)$/.exec(url.pathname)?.[1];
        if (!SETTINGS_FIELDS.includes(field)) throw failure(404, '設定項目が見つかりません。');
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/json') throw failure(415, 'JSONで送ってください。');
        let value;
        try { value = JSON.parse((await readBody(req, MAX_SETTINGS_BYTES)).toString('utf8')); }
        catch (error) { throw error.status ? error : failure(400, 'データの形式が正しくありません。'); }
        json(200, await save(field, value)); return;
      }
      res.setHeader('Allow', 'GET, PUT'); throw failure(405, 'この操作には対応していません。');
    } catch (error) {
      json(error.status || 503, { error: error.status ? error.message : '設定を保存できません。dataフォルダーのアクセス権を確認してください。', ...(error.writable === false ? { writable: false } : {}) });
    }
  }

  function closeEvents() {
    streams.closeEvents(); shared.listeners.delete(streams.broadcast);
    // Existing saves retain their shared queue until the last server finishes.
    if (!shared.listeners.size) shared.queue.finally(() => {
      if (!shared.listeners.size && directories.get(key) === shared) { unwatchFile(path, shared.watch); directories.delete(key); }
    });
  }
  if (!shared.watching) {
    shared.watching = true;
    // Polling also follows atomic rename and a data folder created by another
    // process, without creating a folder merely to attach a watcher.
    shared.watch = () => { load().then(value => notify(value.revision)).catch(() => {}); };
    watchFile(path, { persistent: false, interval: 200 }, shared.watch);
  }
  return { handle, load, save, closeEvents };
}
