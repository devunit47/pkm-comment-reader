import { createHash } from 'node:crypto';
import { watchFile, unwatchFile } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeDirectory } from './local-customization.js';
import { atomicWrite, createEventStream, failure, guardDirectory, readAllowed, readBody, readStable, writeAllowed } from './storage-utils.js';
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
  const notify = (revision, saved = false) => {
    if (!saved && revision === shared.revision) return;
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

  async function save(field, value) {
    if (!SETTINGS_FIELDS.includes(field)) throw failure(404, '設定項目が見つかりません。');
    return exclusive(async () => {
      if ((await load()).writable === false) throw Object.assign(failure(422, warning), { writable: false });
      await safeDirectory(root, true);
      const before = await load();
      if (before.writable === false) throw Object.assign(failure(422, before.warning), { writable: false });
      const document = settingsDocument({ ...before.settings, [field]: value }), content = JSON.stringify(document, null, 2);
      if (Buffer.byteLength(content) > MAX_SETTINGS_BYTES) throw failure(413, '設定のデータが大きすぎます。ユーザー管理の件数を減らしてください。');
      const check = await guardDirectory(dirname(root), root);
      await atomicWrite(path, content, root, check);
      const after = await load();
      if (after.writable === false) throw Object.assign(failure(422, after.warning), { writable: false });
      notify(after.revision, true); return after;
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
