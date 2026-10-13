import { normalizeBadges, normalizeRoomId } from '../shared/comment-model.js';

const key = badge => JSON.stringify([badge.set, badge.version]);
export function createTwitchBadgeClient({ state, onChange = () => {}, fetchImpl = (...args) => globalThis.fetch(...args), now = Date.now }) {
  let roomId = '', account = '', enabled = false, connected = false, closed = false;
  let generation = 0, pending = null, controller, nextRefreshAt = 0, catalog = new Map();
  function invalidate() { generation++; controller?.abort(); controller = null; pending = null; }
  function update(room, lookup) {
    let changed = false;
    for (const message of new Set([...state.messages, state.selected, state.pinned].filter(Boolean))) {
      if (room && message.roomId !== room) continue;
      const badges = normalizeBadges(message.badges).map(badge => ({ ...badge, url: '', title: '', ...lookup.get(key(badge)) }));
      if (JSON.stringify(badges) !== JSON.stringify(message.badges)) { message.badges = badges; changed = true; }
    }
    if (changed) onChange();
  }
  function ensure() {
    if (closed || !connected || !enabled || !account || !roomId || pending || nextRefreshAt > now()) return;
    const epoch = generation, room = roomId;
    controller = new AbortController();
    const current = () => !closed && epoch === generation && room === roomId;
    const request = (async () => {
      try {
        const response = await fetchImpl(`/api/twitch/badges?broadcasterId=${encodeURIComponent(room)}`, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error('List unavailable');
        const data = await response.json();
        if (!current()) return;
        if (data?.broadcasterId !== room || !Array.isArray(data.badges) || data.badges.length > 10000) throw new Error('Invalid list');
        const next = new Map();
        // Each catalog entry is normalized independently; comment limits do not limit a catalog.
        for (const value of data.badges) {
          const badge = normalizeBadges([value])[0];
          if (badge?.url && !next.has(key(badge))) next.set(key(badge), badge);
        }
        catalog = next;
        nextRefreshAt = Number.isFinite(data.nextRefreshAt) && data.nextRefreshAt > now() ? data.nextRefreshAt : now() + 300000;
        update(room, catalog);
      } catch { if (current()) nextRefreshAt = now() + 300000; }
    })().finally(() => { if (epoch === generation) pending = null; });
    pending = request;
  }
  return {
    setAuth(value) {
      const next = value?.status === 'signed-in' ? value.login : '';
      if (next !== account) { account = next; invalidate(); catalog = new Map(); nextRefreshAt = 0; update('', catalog); ensure(); }
    },
    setEnabled(value) { if (enabled !== !!value) { enabled = !!value; invalidate(); ensure(); } },
    connect() { invalidate(); connected = true; roomId = ''; catalog = new Map(); nextRefreshAt = 0; },
    disconnect() { invalidate(); connected = false; roomId = ''; catalog = new Map(); nextRefreshAt = 0; },
    clear() { invalidate(); nextRefreshAt = 0; },
    setRoomId(value) {
      const room = normalizeRoomId(value); if (!room) return;
      if (room !== roomId) { invalidate(); roomId = room; catalog = new Map(); nextRefreshAt = 0; }
      ensure();
    },
    resolve(value) {
      const room = normalizeRoomId(value.roomId) || roomId;
      if (room === roomId) ensure();
      return { ...value, roomId: room, badges: normalizeBadges(value.badges).map(badge => ({ ...badge, url: '', title: '', ...(room === roomId && account ? catalog.get(key(badge)) : {}) })) };
    },
    close() { closed = true; invalidate(); catalog.clear(); },
  };
}
