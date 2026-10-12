const endpoint = '/api/auth/twitch';
const statuses = new Set(['disabled', 'signed-out', 'pending', 'signed-in', 'reauth']);
const text = (value, limit) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, limit) : '';

function normalizeState(value) {
  if (!value || !statuses.has(value.status)) throw new Error('Invalid login state');
  const result = { status: value.status, reason: text(value.reason, 500), displayName: text(value.displayName, 200), login: text(value.login, 25) };
  if (value.status === 'pending') {
    const url = new URL(value.verification_uri);
    if (url.origin !== 'https://www.twitch.tv' || url.pathname !== '/activate' || url.username || url.password ||
        typeof value.user_code !== 'string' || !/^[a-z0-9-]{1,64}$/i.test(value.user_code) ||
        !Number.isFinite(value.expiresAt) || value.expiresAt <= 0) throw new Error('Invalid login code');
    Object.assign(result, { user_code: value.user_code, verification_uri: url.href, expiresAt: value.expiresAt });
  }
  return result;
}

export function initializeTwitchLogin(root) {
  if (!root) return;
  const find = id => root.querySelector(`#twitch-login-${id}`);
  const status = find('status'), pending = find('pending'), code = find('code'), link = find('link'), remaining = find('remaining');
  const start = find('start'), cancel = find('cancel'), logout = find('logout'), retry = find('retry'), error = find('error');
  const controller = new AbortController();
  let state, busy = false, warning = '', closed = false, timer, expired;
  let queue = Promise.resolve();

  function countdown() {
    const seconds = Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000));
    remaining.textContent = seconds ? `残り ${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒` : '確認コードの期限が切れました。';
    if (!seconds && expired !== state.expiresAt) { expired = state.expiresAt; reload(); }
  }
  function render() {
    if (closed) return;
    clearInterval(timer);
    const kind = state?.status ?? 'loading';
    root.dataset.status = kind;
    root.setAttribute('aria-busy', String(busy || !state && !warning));
    status.textContent = {
      disabled: 'このビルドでは Twitch のログインを使えません',
      'signed-out': '未ログイン',
      pending: 'Twitch の確認ページでコードを入力してください。',
      'signed-in': `ログイン中：${state?.displayName || state?.login || 'Twitch アカウント'}`,
      reauth: '再ログインが必要です。',
      loading: warning ? 'ログインの状態は未確認です。' : 'ログインの状態を確認しています…',
    }[kind];
    if (state?.reason && ['signed-out', 'reauth'].includes(kind)) status.textContent += ` ${state.reason}`;
    pending.hidden = kind !== 'pending';
    code.textContent = kind === 'pending' ? state.user_code : '';
    if (kind === 'pending') {
      link.setAttribute('href', state.verification_uri);
      countdown(); timer = setInterval(countdown, 1000);
    } else {
      link.removeAttribute('href'); remaining.textContent = '';
    }
    start.hidden = ['pending', 'signed-in'].includes(kind);
    start.textContent = kind === 'reauth' ? '再ログイン' : 'Twitch にログイン（任意）';
    start.disabled = busy || !state || kind === 'disabled';
    cancel.hidden = kind !== 'pending'; cancel.disabled = busy;
    logout.hidden = kind !== 'signed-in'; logout.disabled = busy;
    error.textContent = warning; error.hidden = !warning;
    retry.hidden = !warning; retry.disabled = busy;
  }
  async function request(action) {
    const response = await fetch(endpoint, { cache: 'no-store', signal: controller.signal,
      ...(action ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) } : {}) });
    if (!response.ok) throw new Error('Login request failed');
    const next = normalizeState(await response.json());
    if (!closed) { state = next; warning = ''; }
  }
  // Reads and commands share a queue so a late GET cannot undo a command.
  function enqueue(operation) {
    const result = queue.then(() => closed ? undefined : operation());
    queue = result.catch(() => {}); return result;
  }
  function reload() {
    return enqueue(async () => {
      try { await request(); }
      catch { if (!closed) warning = 'ログインの状態を確認できません。もう一度確認してください。'; }
      render();
    });
  }
  function command(action) {
    if (busy || closed) return;
    busy = true; render();
    enqueue(async () => {
      try { await request(action); }
      catch { if (!closed) warning = 'ログインの操作を完了できません。もう一度お試しください。'; }
      finally { busy = false; render(); }
    });
  }
  const actions = [[start, () => command('start')], [cancel, () => command('cancel')], [logout, () => command('logout')], [retry, reload]];
  for (const [button, action] of actions) button.addEventListener('click', action);
  const events = new EventSource(`${endpoint}/events`);
  events.addEventListener('change', reload);
  // Reconnecting also covers changes while the page had no event stream.
  events.addEventListener('open', reload);
  function close() {
    if (closed) return;
    closed = true; controller.abort(); events.close(); clearInterval(timer);
    for (const [button, action] of actions) button.removeEventListener('click', action);
    window.removeEventListener('pagehide', close);
  }
  window.addEventListener('pagehide', close, { once: true });
  render(); reload();
  return { close };
}
