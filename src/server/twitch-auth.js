import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuthStorage } from './auth-storage.js';
import { createEventStream, failure, readAllowed, readBody, writeAllowed } from './storage-utils.js';

const systemClock = { now: Date.now, setTimeout, clearTimeout };
const reasons = {
  expired: '確認コードの期限が切れました。再ログインしてください。',
  denied: 'ログインが拒否されました。再ログインしてください。',
  invalid: 'ログインの有効性を確認できません。再ログインしてください。',
  network: 'Twitch に通信できません。時間をおいて再ログインしてください。',
  storage: 'ログイン情報を保存できません。data フォルダーのアクセス権を確認してください。',
  unreadable: '保存したログイン情報を読めません。別の PC・ユーザー、または壊れたファイルのため再ログインが必要です。',
};
const secret = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x20\x7f]/.test(value);
const seconds = value => Number.isSafeInteger(value) && value > 0 && value <= 604800;
const loginName = value => typeof value === 'string' && /^[a-z0-9_]{1,25}$/.test(value);
const userId = value => typeof value === 'string' && /^\d{1,30}$/.test(value);
const displayName = value => typeof value === 'string' && value.length > 0 && value.length <= 100 && !/[\x00-\x1f\x7f]/.test(value);
const emptyScopes = value => Array.isArray(value) && value.length === 0;

function pendingData(value, now) {
  if (!secret(value?.device_code) || !/^[A-Z0-9-]{1,32}$/.test(value?.user_code) || !seconds(value?.expires_in) || !seconds(value?.interval)) throw new Error('Invalid device response');
  const url = new URL(value.verification_uri);
  if (url.origin !== 'https://www.twitch.tv' || url.pathname !== '/activate' || url.username || url.password) throw new Error('Invalid verification URL');
  // Rebuild the query so unexpected upstream fields cannot leak into the page.
  const verification = new URL('https://www.twitch.tv/activate');
  verification.searchParams.set('public', 'true'); verification.searchParams.set('device-code', value.user_code);
  return { device_code: value.device_code, user_code: value.user_code, verification_uri: verification.href, expiresAt: now + value.expires_in * 1000, interval: value.interval * 1000 };
}
function tokenPair(value, now) {
  if (!secret(value?.access_token) || !secret(value?.refresh_token) || !seconds(value?.expires_in) || value.token_type?.toLowerCase() !== 'bearer' || !emptyScopes(value.scope)) throw new Error('Invalid token response');
  return { accessToken: value.access_token, refreshToken: value.refresh_token, expiresAt: now + value.expires_in * 1000 };
}
function normalizeRecord(value, clientId) {
  if (!value || typeof value !== 'object' || value.clientId !== clientId || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id)) return null;
  if (value.status === 'reauth' && Object.hasOwn(reasons, value.reason)) return { id: value.id, clientId, status: 'reauth', reason: value.reason };
  if (value.status === 'pending') {
    const pending = value.pending;
    try {
      const normalized = pendingData({ ...pending, expires_in: 1, interval: pending.interval / 1000 }, 0);
      if (!Number.isSafeInteger(pending.expiresAt) || pending.expiresAt < 0) return null;
      return { id: value.id, clientId, status: 'pending', pending: { ...normalized, expiresAt: pending.expiresAt } };
    } catch { return null; }
  }
  if (value.status === 'signed-in') {
    const session = value.session;
    if (!secret(session?.accessToken) || !secret(session?.refreshToken) || !Number.isSafeInteger(session?.expiresAt) || session.expiresAt < 0 || !userId(session.userId) || !loginName(session.login) || !displayName(session.displayName)) return null;
    return { id: value.id, clientId, status: 'signed-in', session: { accessToken: session.accessToken, refreshToken: session.refreshToken, expiresAt: session.expiresAt, userId: session.userId, login: session.login, displayName: session.displayName } };
  }
  return null;
}

export function createTwitchAuth({ storage, clientId = '', fetchImpl = globalThis.fetch, clock = systemClock }) {
  let record = null, revision = 'default', generation = 0, stopping = false, pollTimer, validationTimer, expiryTimer;
  let refreshPromise = null, validationPromise = null, queue = Promise.resolve();
  const listeners = new Set(), requests = new Set();
  const enabled = typeof clientId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(clientId);
  const status = () => {
    if (!enabled) return { status: 'disabled' };
    if (!record) return { status: 'signed-out' };
    if (record.status === 'pending') {
      const { user_code, verification_uri, expiresAt } = record.pending;
      return { status: 'pending', user_code, verification_uri, expiresAt };
    }
    if (record.status === 'signed-in') return { status: 'signed-in', displayName: record.session.displayName, login: record.session.login };
    return { status: 'reauth', reason: reasons[record.reason] };
  };
  const notify = () => { for (const listener of listeners) listener(); };
  const exclusive = task => { const result = queue.then(task, task); queue = result.catch(() => {}); return result; };
  const timer = (task, delay) => { const handle = clock.setTimeout(task, Math.max(0, delay)); handle?.unref?.(); return handle; };
  function clearTimers() { for (const handle of [pollTimer, validationTimer, expiryTimer]) clock.clearTimeout(handle); pollTimer = validationTimer = expiryTimer = undefined; }
  function invalidate() {
    generation++; clearTimers();
    for (const controller of requests) controller.abort();
  }
  function schedule() {
    clearTimers();
    if (stopping) return;
    if (record?.status === 'signed-in') validationTimer = timer(() => validate(), 3600000);
    if (record?.status === 'pending') {
      const epoch = generation, id = record.id;
      expiryTimer = timer(() => fail('expired', epoch, id), record.pending.expiresAt - clock.now());
    }
  }
  async function retryValidation(epoch, before) {
    await exclusive(async () => {
      if (!await current(epoch, before.id, before.session.accessToken)) return;
      clock.clearTimeout(validationTimer);
      validationTimer = timer(() => validate(), 300000);
    });
  }
  const identityMismatch = (user, expectedUserId) =>
    (typeof user?.client_id === 'string' && user.client_id !== clientId) ||
    (userId(user?.user_id) && expectedUserId && user.user_id !== expectedUserId) ||
    !emptyScopes(user?.scopes);
  async function request(url, form, headers = {}, parse = true) {
    if (stopping) throw new Error('Authentication stopped');
    const controller = new AbortController(); requests.add(controller);
    try {
      const response = await fetchImpl(url, {
        method: form ? 'POST' : 'GET', redirect: 'error',
        headers: { Accept: 'application/json', ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...headers },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
      });
      let data = null;
      if (parse) {
        try { data = await response.json(); }
        catch (error) { if (response.ok) throw error; }
      }
      return { ok: response.ok, status: response.status, data };
    } finally { requests.delete(controller); }
  }
  const oauth = (path, form, parse = true) => request(`https://id.twitch.tv/oauth2/${path}`, { client_id: clientId, ...form }, {}, parse);
  async function current(epoch, id, accessToken) {
    if (stopping || epoch !== generation || (id && record?.id !== id) || (accessToken && record?.session?.accessToken !== accessToken)) return false;
    const saved = await storage.load('twitch');
    return !stopping && epoch === generation && saved.revision === revision && (!accessToken || record?.session?.accessToken === accessToken);
  }
  async function persist(next, epoch, id, accessToken) {
    return exclusive(async () => {
      if (!await current(epoch, id, accessToken)) return false;
      let result;
      try {
        const condition = { expectedRevision: revision };
        result = next ? await storage.save('twitch', next, condition) : await storage.remove('twitch', condition);
      } catch (error) {
        if (error.status !== 409) throw error;
        // Reload after releasing this queue; an external operation owns the state.
        queueMicrotask(() => { sync().catch(() => {}); });
        return false;
      }
      // A later cancel/logout is queued behind this write and must remove it.
      revision = result?.revision ?? (await storage.load('twitch')).revision;
      if (stopping || epoch !== generation) return false;
      record = next; schedule(); notify(); return true;
    });
  }
  async function fail(reason, epoch = generation, id = record?.id, accessToken) {
    try { await persist({ id: randomUUID(), clientId, status: 'reauth', reason }, epoch, id, accessToken); }
    catch {
      if (!stopping && epoch === generation && (!accessToken || record?.session?.accessToken === accessToken)) { record = { status: 'reauth', reason: 'storage' }; clearTimers(); notify(); }
    }
  }
  async function sync() {
    return exclusive(async () => {
      if (stopping || !enabled) return;
      const saved = await storage.load('twitch');
      if (stopping || saved.revision === revision) return;
      invalidate(); revision = saved.revision;
      record = saved.unreadable ? { status: 'reauth', reason: 'unreadable' } : normalizeRecord(saved.value, clientId);
      if (saved.value && !record) record = { status: 'reauth', reason: 'unreadable' };
      schedule(); notify();
    });
  }
  const unsubscribe = enabled ? storage.subscribe('twitch', () => { sync().catch(() => {}); }) : () => {};
  const ready = (async () => {
    if (!enabled) return;
    // File notifications must follow the initial read, including slow decryption.
    await exclusive(async () => {
      const saved = await storage.load('twitch');
      if (stopping) return;
      revision = saved.revision;
      record = saved.unreadable ? { status: 'reauth', reason: 'unreadable' } : normalizeRecord(saved.value, clientId);
      if (saved.value && !record) record = { status: 'reauth', reason: 'unreadable' };
      schedule();
    });
    if (record?.status === 'signed-in') await validate();
  })();

  async function start() {
    await ready;
    if (!enabled || stopping) throw failure(503, 'このビルドでは Twitch のログインを使えません');
    if (record?.status === 'signed-in') return status();
    invalidate(); const epoch = generation;
    try {
      const response = await oauth('device', { scopes: '' });
      if (stopping || epoch !== generation) return status();
      if (!response.ok) throw new Error('Device request failed');
      const pending = pendingData(response.data, clock.now()), id = randomUUID();
      if (await persist({ id, clientId, status: 'pending', pending }, epoch)) pollTimer = timer(() => poll(epoch, id), pending.interval);
      return status();
    } catch {
      if (epoch === generation && !stopping) { await fail('network', epoch); throw failure(502, 'Twitch のログインを開始できません。時間をおいて試してください。'); }
      return status();
    }
  }
  async function identify(pair, expectedUserId) {
    const checked = await request('https://id.twitch.tv/oauth2/validate', null, { Authorization: `OAuth ${pair.accessToken}` });
    const user = checked.data;
    if (checked.ok && identityMismatch(user, expectedUserId)) throw Object.assign(new Error('Invalid identity'), { invalidIdentity: true });
    if (!checked.ok || user?.client_id !== clientId || !userId(user?.user_id) || !loginName(user?.login) || !seconds(user?.expires_in)) throw new Error('Invalid identity response');
    return { userId: user.user_id, login: user.login, expiresAt: clock.now() + user.expires_in * 1000 };
  }
  async function poll(epoch, id) {
    if (!await current(epoch, id) || record?.status !== 'pending') return;
    const pending = record.pending;
    if (pending.expiresAt <= clock.now()) { await fail('expired', epoch, id); return; }
    try {
      const response = await oauth('token', { scopes: '', device_code: pending.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      if (!await current(epoch, id)) return;
      if (!response.ok) {
        const error = response.data?.message || response.data?.error;
        if (error === 'authorization_pending' || error === 'slow_down') {
          if (error === 'slow_down') pending.interval += 5000;
          pollTimer = timer(() => poll(epoch, id), pending.interval); return;
        }
        await fail(error === 'access_denied' ? 'denied' : ['expired_token', 'invalid device code'].includes(error) ? 'expired' : 'invalid', epoch, id); return;
      }
      const pair = tokenPair(response.data, clock.now()), identity = await identify(pair);
      if (!await current(epoch, id)) return;
      const profile = await request('https://api.twitch.tv/helix/users', null, { Authorization: `Bearer ${pair.accessToken}`, 'Client-Id': clientId });
      const user = profile.data?.data?.[0];
      if (!profile.ok || user?.id !== identity.userId || user?.login !== identity.login || !displayName(user?.display_name)) throw new Error('Invalid profile');
      await persist({ id: randomUUID(), clientId, status: 'signed-in', session: { ...pair, ...identity, displayName: user.display_name } }, epoch, id);
    } catch { await fail('network', epoch, id); }
  }
  async function refresh() {
    if (refreshPromise) return refreshPromise;
    if (record?.status !== 'signed-in' || stopping) return null;
    const epoch = generation, before = record, session = before.session;
    refreshPromise = (async () => {
      try {
        const response = await oauth('token', { grant_type: 'refresh_token', refresh_token: session.refreshToken });
        if (!await current(epoch, before.id, session.accessToken)) return null;
        if (!response.ok) {
          if ([400, 401].includes(response.status)) await fail('invalid', epoch, before.id, session.accessToken);
          else await retryValidation(epoch, before);
          return null;
        }
        const pair = tokenPair(response.data, clock.now());
        const identity = await identify(pair, session.userId);
        const saved = await persist({ ...before, session: { ...session, ...pair, ...identity } }, epoch, before.id, session.accessToken);
        return saved ? pair.accessToken : null;
      } catch (error) {
        if (error.invalidIdentity) await fail('invalid', epoch, before.id, session.accessToken);
        else await retryValidation(epoch, before);
        return null;
      }
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }
  async function validate() {
    if (validationPromise) return validationPromise;
    if (record?.status !== 'signed-in' || stopping) return;
    const epoch = generation, before = record;
    validationPromise = (async () => {
      try {
        const checked = await request('https://id.twitch.tv/oauth2/validate', null, { Authorization: `OAuth ${before.session.accessToken}` });
        if (!await current(epoch, before.id, before.session.accessToken)) return;
        if (checked.status === 401) { await refresh(); return; }
        if (!checked.ok) { await retryValidation(epoch, before); return; }
        const user = checked.data;
        if (identityMismatch(user, before.session.userId)) { await fail('invalid', epoch, before.id, before.session.accessToken); return; }
        if (user?.client_id !== clientId || user?.user_id !== before.session.userId || !loginName(user?.login) || !seconds(user?.expires_in)) { await retryValidation(epoch, before); return; }
        await persist({ ...before, session: { ...before.session, login: user.login, expiresAt: clock.now() + user.expires_in * 1000 } }, epoch, before.id, before.session.accessToken);
      } catch { await retryValidation(epoch, before); }
    })().finally(() => { validationPromise = null; });
    return validationPromise;
  }
  async function cancel() {
    await ready;
    if (record?.status === 'signed-in') return status();
    invalidate(); const epoch = generation;
    await persist(null, epoch); return status();
  }
  async function logout() {
    await ready; const token = record?.session?.accessToken;
    invalidate(); const epoch = generation;
    try { if (token) await oauth('revoke', { token }, false); } catch { /* Local logout must succeed even if Twitch is unavailable. */ }
    await persist(null, epoch); return status();
  }
  async function getAccessToken({ forceRefresh = false } = {}) {
    await ready;
    if (stopping || record?.status !== 'signed-in') return null;
    if (forceRefresh || record.session.expiresAt <= clock.now() + 60000) return refresh();
    return record.session.accessToken;
  }
  async function close() { if (stopping) return queue; stopping = true; invalidate(); unsubscribe(); listeners.clear(); await queue; }
  return { ready, status, start, cancel, logout, getAccessToken, validate, close, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}

const directories = new Map();
export function createTwitchAuthHandler(directory, options = {}) {
  const root = resolve(directory instanceof URL ? fileURLToPath(directory) : directory);
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  let shared = directories.get(key);
  if (!shared) {
    const storage = createAuthStorage(directory, { platform: options.platform, protect: options.protect, unprotect: options.unprotect });
    shared = { storage, auth: createTwitchAuth({ storage, clientId: options.clientId, fetchImpl: options.fetchImpl, clock: options.clock }), users: 0 };
    directories.set(key, shared);
  }
  shared.users++;
  const streams = createEventStream(); let revision = 0, closed = false;
  const unsubscribe = shared.auth.subscribe(() => streams.broadcast(++revision));
  async function handle(req, res, url) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const json = (status, data) => { if (!res.headersSent) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); } };
    try {
      if (req.method === 'GET') {
        if (!readAllowed(req)) throw failure(403, 'このアプリから接続してください。');
        if (url.pathname === '/api/auth/twitch/events') { streams.events(req, res); return; }
        if (url.pathname !== '/api/auth/twitch') throw failure(404, '見つかりません。');
        await shared.auth.ready; json(200, shared.auth.status()); return;
      }
      if (req.method === 'POST') {
        if (!writeAllowed(req)) throw failure(403, 'このアプリから操作してください。');
        if (url.pathname !== '/api/auth/twitch') throw failure(404, '見つかりません。');
        if (closed) throw failure(503, 'サーバーを停止しています。');
        if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw failure(415, 'JSONで送ってください。');
        let body;
        try { body = JSON.parse((await readBody(req, 1024)).toString('utf8')); } catch (error) { throw error.status ? error : failure(400, 'データの形式が正しくありません。'); }
        if (!body || !['start', 'cancel', 'logout'].includes(body.action) || Object.keys(body).some(key => key !== 'action')) throw failure(400, 'ログインの操作が正しくありません。');
        json(200, await shared.auth[body.action]()); return;
      }
      res.setHeader('Allow', 'GET, POST'); throw failure(405, 'この操作には対応していません。');
    } catch (error) { json(error.status || 503, { error: error.status ? error.message : 'ログイン情報を処理できません。data フォルダーのアクセス権を確認してください。' }); }
  }
  async function closeEvents() {
    if (closed) return;
    closed = true; streams.closeEvents(); unsubscribe(); shared.users--;
    if (!shared.users) { directories.delete(key); await shared.auth.close(); await shared.storage.close(); }
  }
  return { handle, closeEvents, subscribe: shared.auth.subscribe };
}
