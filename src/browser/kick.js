export const KICK_SOCKET_URL = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';

export function parseKickMessage(event, room) {
  if (event.event !== 'App\\Events\\ChatMessageEvent' || event.channel !== room) return null;
  try {
    const data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    if (typeof data?.sender?.username !== 'string' || typeof data.content !== 'string') return null;
    const login = typeof data.sender.slug === 'string' && data.sender.slug ? data.sender.slug : data.sender.username;
    return { user: data.sender.username, login, text: data.content, id: data.id, createdAt: data.created_at };
  } catch { return null; }
}
