export const KICK_SOCKET_URL = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';

export function validChannel(platform, channel) {
  return typeof channel === 'string' && (platform === 'twitch'
    ? /^[a-z0-9_]{1,25}$/i.test(channel)
    : platform === 'kick' && /^[a-z0-9_-]{1,50}$/i.test(channel));
}

export function readSavedConnections(storage) {
  const result = { twitch: '', kick: '' };
  try {
    const saved = JSON.parse(storage.getItem('pokome-connections') || '{}');
    for (const platform of Object.keys(result)) {
      if (validChannel(platform, saved?.[platform])) result[platform] = saved[platform].toLowerCase();
    }
  } catch { /* Invalid or unavailable storage leaves the fields empty. */ }
  return result;
}

export function parseTwitchMessage(line, channel) {
  const match = line.match(/^(?:@([^ ]+) )?:([^! ]+)![^ ]+ PRIVMSG #([^ ]+) :([\s\S]*)$/);
  if (!match || match[3].toLowerCase() !== channel) return null;
  const tags = Object.fromEntries((match[1] || '').split(';').filter(tag => tag.includes('='))
    .map(tag => { const index = tag.indexOf('='); return [tag.slice(0, index), tag.slice(index + 1)]; }));
  const displayName = (tags['display-name'] || match[2]).replace(/\\([s:rn\\])/g,
    (_, value) => ({ s: ' ', ':': ';', r: '\r', n: '\n', '\\': '\\' })[value]);
  return { user: displayName, login: match[2], text: match[4] };
}

export function parseKickMessage(event, room) {
  if (event.event !== 'App\\Events\\ChatMessageEvent' || event.channel !== room) return null;
  try {
    const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    if (typeof data?.sender?.username !== 'string' || typeof data.content !== 'string') return null;
    const login = typeof data.sender.slug === 'string' && data.sender.slug ? data.sender.slug : data.sender.username;
    return { user: data.sender.username, login, text: data.content, id: data.id, createdAt: data.created_at };
  } catch { return null; }
}

// Each instance owns one service's socket, lookup, timers and callbacks.
export class ChatConnection {
  constructor(platform, { onStatus, onMessage, onConnected, WebSocketClass = globalThis.WebSocket,
    fetchImpl = (...args) => globalThis.fetch(...args), timeoutMs = 15000 }) {
    this.platform = platform;
    this.onStatus = onStatus;
    this.onMessage = onMessage;
    this.onConnected = onConnected;
    this.WebSocketClass = WebSocketClass;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.generation = 0;
    this.socket = null;
  }

  disconnect(report = true) {
    this.generation++;
    this.lookup?.abort();
    this.lookup = null;
    clearTimeout(this.timer);
    clearTimeout(this.heartbeat);
    clearTimeout(this.pongTimer);
    const old = this.socket;
    this.socket = null;
    old?.close();
    if (report) this.onStatus('未接続', '');
  }

  async connect(channel) {
    channel = channel.trim().toLowerCase();
    if (!validChannel(this.platform, channel)) throw new Error('チャンネル名を確認してください。');
    this.disconnect(false);
    const generation = this.generation;
    const current = () => generation === this.generation;
    const fail = message => {
      if (!current()) return;
      this.disconnect(false);
      this.onStatus(message, channel);
    };
    this.onStatus('接続準備中', channel);
    let room;
    if (this.platform === 'kick') {
      const controller = new AbortController();
      this.lookup = controller;
      this.timer = setTimeout(() => fail('チャンネル情報の取得タイムアウト'), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`/api/kick/channel/${encodeURIComponent(channel)}`, {
          signal: controller.signal,
        });
        const data = await response.json();
        if (!current()) return;
        if (!response.ok || !Number.isSafeInteger(data.chatroomId) || data.chatroomId < 1) {
          throw new Error(typeof data.error === 'string' ? data.error : 'Kickのチャンネル情報を取得できません。');
        }
        room = `chatrooms.${data.chatroomId}.v2`;
      } catch (error) {
        if (current()) fail(error.message || 'Kickのチャンネル情報を取得できません。');
        return;
      }
      clearTimeout(this.timer);
      this.lookup = null;
    }
    if (!current()) return;
    let ws;
    try {
      ws = new this.WebSocketClass(this.platform === 'kick' ? KICK_SOCKET_URL : 'wss://irc-ws.chat.twitch.tv:443');
    } catch { fail('接続失敗'); return; }
    this.socket = ws;
    this.timer = setTimeout(() => fail('接続タイムアウト — 再接続してください'), this.timeoutMs);
    const connected = () => {
      clearTimeout(this.timer);
      this.onStatus('接続中', channel);
      this.onConnected(channel);
    };
    const messageIds = new Set();
    let joined = false;
    let activityTimeout = 120000;
    const heartbeat = () => {
      clearTimeout(this.heartbeat);
      clearTimeout(this.pongTimer);
      this.heartbeat = setTimeout(() => {
        if (!current()) return;
        ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
        this.pongTimer = setTimeout(() => fail('接続応答なし — 再接続してください'), 15000);
      }, activityTimeout);
    };
    ws.onopen = () => {
      if (!current() || this.platform !== 'twitch') return;
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send(`NICK justinfan${Math.floor(Math.random() * 900000) + 100000}`);
      ws.send(`JOIN #${channel}`);
    };
    ws.onmessage = event => {
      if (!current()) return;
      if (this.platform === 'twitch') {
        for (const line of String(event.data).split('\r\n')) {
          if (line.startsWith('PING ')) { ws.send(line.replace(/^PING/, 'PONG')); continue; }
          if (!joined && line.includes(' 366 ') && line.includes(` #${channel} `)) {
            joined = true;
            connected();
          }
          const message = parseTwitchMessage(line, channel);
          if (joined && message) this.onMessage(message);
          if (line.includes(' NOTICE ') && /Login authentication failed|Improperly formatted auth/.test(line)) {
            fail('認証エラー'); return;
          }
          if (line.includes(' RECONNECT')) { fail('再接続が必要です'); return; }
        }
        return;
      }
      let packet;
      try { packet = JSON.parse(event.data); } catch { return; }
      if (!packet || typeof packet !== 'object') return;
      heartbeat();
      if (packet.event === 'pusher:connection_established') {
        try {
          const data = typeof packet.data === 'string' ? JSON.parse(packet.data) : packet.data;
          if (Number.isFinite(data?.activity_timeout) && data.activity_timeout > 0) {
            activityTimeout = Math.min(data.activity_timeout, 120) * 1000;
          }
        } catch { /* Use the default activity timeout. */ }
        heartbeat();
        ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel: room } }));
      } else if (packet.event === 'pusher:ping') {
        ws.send(JSON.stringify({ event: 'pusher:pong', data: {} }));
      } else if (packet.event === 'pusher:error' || packet.event === 'pusher:subscription_error') {
        fail('Kickのチャット購読に失敗しました');
      } else if (packet.event === 'pusher_internal:subscription_succeeded' && packet.channel === room && !joined) {
        joined = true;
        connected();
      } else if (joined) {
        const message = parseKickMessage(packet, room);
        if (!message || (message.id && messageIds.has(message.id))) return;
        if (message.id) {
          messageIds.add(message.id);
          if (messageIds.size > 300) messageIds.delete(messageIds.values().next().value);
        }
        this.onMessage(message);
      }
    };
    ws.onerror = () => fail('接続エラー — 通信環境を確認してください');
    ws.onclose = () => fail('切断されました — 再接続してください');
  }
}
