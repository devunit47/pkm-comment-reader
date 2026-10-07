import { createHash, randomUUID } from 'node:crypto';
import { watchFile, unwatchFile } from 'node:fs';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeDirectory } from './local-customization.js';
import { atomicWrite, createEventStream, failure, guardDirectory, readAllowed, readBody, readStable, retryTransient, writeAllowed } from './storage-utils.js';
import { MAX_SETTINGS_BYTES, SETTINGS_FIELDS, normalizeSettings, settingsDocument } from '../shared/settings-model.js';

export const DEFAULT_DATA_DIRECTORY = fileURLToPath(new URL('../../data/', import.meta.url));
const directories = new Map();
const TICKET_NAME = /^\.settings-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.ticket\.json$/;
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
    const check = await guardDirectory(dirname(root), root), token = randomUUID();
    const ticketPath = join(root, `.settings-${token}.ticket.json`);
    const invalid = () => failure(409, '保存用のロックを確認できません。アプリを終了してdataフォルダーを確認してください。');
    const discard = async (path, expected) => {
      await check();
      const actual = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!actual) return;
      if (!actual.isFile() || actual.isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino) return;
      await retryTransient(async () => {
        await check();
        try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      });
    };
    const running = pid => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; }
    };
    async function participants(cleanDead) {
      await check();
      const entries = await readdir(root, { withFileTypes: true }), result = [];
      await check();
      for (const entry of entries) {
        if (!entry.name.startsWith('.settings-') || !entry.name.endsWith('.ticket.json')) continue;
        const match = TICKET_NAME.exec(entry.name);
        if (!match || !entry.isFile() || entry.isSymbolicLink()) throw invalid();
        const path = join(root, entry.name);
        try {
          const info = await lstat(path), owner = JSON.parse((await readStable(path, 1024)).bytes.toString('utf8'));
          await check();
          if (!owner || owner.token !== match[1] || !Number.isSafeInteger(owner.pid) || owner.pid < 1 ||
              typeof owner.choosing !== 'boolean' || !Number.isSafeInteger(owner.ticket) ||
              (owner.choosing ? owner.ticket !== 0 : owner.ticket < 1)) throw invalid();
          if (running(owner.pid)) result.push(owner);
          // Unique names are never reused, so simultaneous recovery can only
          // remove the dead participant's file, never a new owner's lock.
          else if (cleanDead) await discard(path, info);
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          if (error.code === 'EDIRECTORYCHANGED') throw error;
          throw invalid();
        }
      }
      return result;
    }
    async function release() {
      await check();
      let info, owner;
      try { info = await lstat(ticketPath); owner = JSON.parse((await readStable(ticketPath, 1024)).bytes.toString('utf8')); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (owner.token === token && owner.pid === process.pid) await discard(ticketPath, info);
    }
    let published = false;
    try {
      // Publish the doorway before reading others. A participant arriving
      // after the wait snapshot must then choose a larger ticket.
      await atomicWrite(ticketPath, JSON.stringify({ pid: process.pid, token, choosing: true, ticket: 0 }), root, check);
      published = true;
      const maximum = (await participants(false)).reduce((max, owner) => Math.max(max, owner.ticket), 0);
      if (maximum >= Number.MAX_SAFE_INTEGER) throw invalid();
      const ticket = maximum + 1;
      await atomicWrite(ticketPath, JSON.stringify({ pid: process.pid, token, choosing: false, ticket }), root, check);
      for (let attempt = 0; attempt < 100; attempt++) {
        // Read a fresh list after choosing, and compare UUIDs by ASCII order
        // so equal tickets have the same ordering in every process.
        const others = (await participants(true)).filter(owner => owner.token !== token);
        if (!others.some(owner => owner.choosing || owner.ticket < ticket || (owner.ticket === ticket && owner.token < token))) return release;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw failure(409, 'ほかの画面が設定を保存中です。少し待ってからやり直してください。');
    } catch (error) {
      if (published) await release().catch(() => {});
      throw error;
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
