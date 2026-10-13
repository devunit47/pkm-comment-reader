import { validBadgeId, normalizeBadges, normalizeBadgeUrl, normalizeRoomId } from '../shared/comment-model.js';
import { failure, readAllowed } from './storage-utils.js';

const HOUR = 3600000, RETRY = 300000, MAX_BYTES = 1024 * 1024;
const key = badge => JSON.stringify([badge.set, badge.version]);
async function readList(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('Oversized response');
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Oversized response');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!Array.isArray(data?.data)) throw new Error('Invalid response');
  const result = new Map();
  for (const set of data.data) {
    if (!validBadgeId(set?.set_id) || !Array.isArray(set.versions)) continue;
    for (const version of set.versions) {
      const url = normalizeBadgeUrl(version?.image_url_4x);
      if (!validBadgeId(version?.id) || !url) continue;
      const badge = normalizeBadges([{ set: set.set_id, version: version.id, url, title: version.title }])[0];
      if (!result.has(key(badge))) result.set(key(badge), badge);
    }
  }
  return result;
}

export function createTwitchBadges({ auth, clientId, fetchImpl = globalThis.fetch, now = Date.now }) {
  const entry = () => ({ data: new Map(), expiresAt: 0, retryAt: 0, status: 'failed', pending: null });
  let global = entry(), epoch = 0, stopped = false;
  const channels = new Map(), controllers = new Set();
  const identity = () => auth.sessionId();
  let account = identity();
  function reset() {
    epoch++; global = entry(); channels.clear();
    for (const controller of controllers) controller.abort();
  }
  const unsubscribe = auth.subscribe(() => { const current = identity(); if (current !== account) { account = current; reset(); } });
  async function load(cache, destination) {
    if (cache.pending) return cache.pending;
    if (cache.expiresAt > now() || cache.retryAt > now()) return;
    const generation = epoch;
    const current = () => !stopped && generation === epoch && !!account;
    cache.pending = (async () => {
      const controller = new AbortController(); controllers.add(controller);
      try {
        let token = await auth.getAccessToken();
        if (!current()) return;
        if (!token) throw new Error('Authentication unavailable');
        let response;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (!current()) return;
          response = await fetchImpl(destination, { redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
            headers: { Accept: 'application/json', 'Client-Id': clientId, Authorization: `Bearer ${token}` } });
          if (response.status !== 401 || attempt === 1) break;
          await response.body?.cancel();
          token = await auth.getAccessToken({ forceRefresh: true, rejectedToken: token });
          if (!token || !current()) throw new Error('Authentication unavailable');
        }
        if (!response.ok) {
          if (response.status === 429) {
            const resetAt = Number(response.headers.get('Ratelimit-Reset')) * 1000;
            const retryAfter = response.headers.get('Retry-After');
            const retryAt = retryAfter && /^\d+$/.test(retryAfter) ? now() + Number(retryAfter) * 1000 : Date.parse(retryAfter);
            if (current()) cache.retryAt = Math.max(now() + RETRY, Number.isFinite(resetAt) ? resetAt : 0, Number.isFinite(retryAt) ? retryAt : 0);
          }
          await response.body?.cancel(); throw new Error('List unavailable');
        }
        const data = await readList(response);
        if (current()) { cache.data = data; cache.expiresAt = now() + HOUR; cache.retryAt = 0; cache.status = 'ready'; }
      } catch {
        if (current()) { cache.status = 'failed'; cache.retryAt = Math.max(cache.retryAt, now() + RETRY); }
      } finally { controllers.delete(controller); cache.pending = null; }
    })();
    return cache.pending;
  }
  async function get(broadcasterId) {
    if (!normalizeRoomId(broadcasterId)) throw failure(400, 'Twitch のチャンネルIDを確認してください。');
    await auth.ready;
    const currentAccount = identity();
    if (currentAccount !== account) { account = currentAccount; reset(); }
    const generation = epoch;
    const empty = { broadcasterId, badges: [], global: 'unavailable', channel: 'unavailable', nextRefreshAt: now() + RETRY };
    if (stopped || !account) return empty;
    let channel = channels.get(broadcasterId);
    if (!channel) {
      if (channels.size >= 8) {
        const oldest = [...channels].find(([, cache]) => !cache.pending)?.[0];
        // Keep in-flight promises addressable; a later trigger can retry a ninth room.
        if (!oldest) return empty;
        channels.delete(oldest);
      }
      channel = entry();
    }
    channels.delete(broadcasterId); channels.set(broadcasterId, channel);
    const shared = global;
    await Promise.all([load(shared, 'https://api.twitch.tv/helix/chat/badges/global'), load(channel, `https://api.twitch.tv/helix/chat/badges?broadcaster_id=${broadcasterId}`)]);
    if (stopped || generation !== epoch || identity() !== account) return empty;
    const merged = new Map([...shared.data, ...channel.data]);
    return { broadcasterId, badges: [...merged.values()], global: shared.status, channel: channel.status,
      nextRefreshAt: Math.min(...[shared, channel].map(cache => Math.max(cache.expiresAt, cache.retryAt))) };
  }
  async function handle(req, res, url) {
    const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' }); res.end(JSON.stringify(data)); };
    if (!readAllowed(req)) { json(403, { error: 'このアプリから接続してください。' }); return; }
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); json(405, { error: 'この操作には対応していません。' }); return; }
    try { json(200, await get(url.searchParams.get('broadcasterId'))); }
    catch (error) { json(error.status === 400 ? 400 : 503, { error: error.status === 400 ? error.message : 'バッジの一覧を取得できません。' }); }
  }
  return { get, handle, close() { if (stopped) return; stopped = true; reset(); unsubscribe(); } };
}
