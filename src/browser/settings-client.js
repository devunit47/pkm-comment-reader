import { normalizeSettings, SETTINGS_FIELDS } from '../shared/settings-model.js';

async function failure(response, fallback) {
  try { return (await response.json()).error || fallback; } catch { return fallback; }
}

// Pending edits overlay the last server response, so another page cannot erase
// a setting that is still waiting to be saved on this page.
export async function createSettingsStore({ fetchImpl = (...args) => globalThis.fetch(...args), EventSourceClass = globalThis.EventSource, watch = true } = {}) {
  let confirmed = normalizeSettings(), revision = 'default', available = false, writable = false, warning = '';
  let queue = Promise.resolve(), events;
  const pending = [], listeners = new Set();
  const visible = () => normalizeSettings({ ...confirmed, ...Object.fromEntries(pending.map(edit => [edit.field, edit.value])) });
  const emit = (before, detail = {}) => {
    const after = visible();
    const fields = SETTINGS_FIELDS.filter(field => JSON.stringify(before[field]) !== JSON.stringify(after[field]));
    if (fields.length || detail.status) for (const listener of listeners) listener({ ...detail, fields });
  };
  function accept(value) {
    confirmed = normalizeSettings(value.settings);
    revision = typeof value.revision === 'string' ? value.revision : 'default';
    available = true;
    writable = value.writable !== false;
    warning = typeof value.warning === 'string' ? value.warning : '';
  }
  async function load() {
    const response = await fetchImpl('/api/settings', { cache: 'no-store' });
    if (!response.ok) throw new Error(await failure(response, '設定を読み込めません。'));
    accept(await response.json());
  }
  try { await load(); }
  catch (error) { warning = `${error.message} 標準の設定を使っています。ローカルサーバーから開いているか確認してください。`; }

  // Reads and writes share a queue: a GET that started during a PUT must never
  // replace its successful result with a snapshot taken before that save.
  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  function reload() {
    return enqueue(async () => {
      const before = visible(), oldWritable = writable, oldWarning = warning;
      try { await load(); }
      catch { return; /* A later stream event retries the read. */ }
      emit(before, { external: true, status: oldWritable !== writable || oldWarning !== warning });
    });
  }
  const store = {
    get settings() { return visible(); },
    get revision() { return revision; },
    get available() { return available; },
    get writable() { return available && writable; },
    get warning() { return warning; },
    async set(field, value) {
      if (!SETTINGS_FIELDS.includes(field)) throw new Error('設定項目が正しくありません。');
      if (!available) throw new Error('設定を保存できません。ローカルサーバーから開いているか確認してください。');
      if (!writable) throw new Error(warning || '設定ファイルを読めません。');
      const before = visible();
      const edit = { field, value: normalizeSettings({ ...before, [field]: value })[field] };
      pending.push(edit);
      emit(before, { optimistic: true });
      return enqueue(async () => {
        const previous = visible();
        let error;
        try {
          if (!writable) throw new Error(warning || '設定ファイルを読めません。');
          const response = await fetchImpl(`/api/settings/${field}`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edit.value),
          });
          if (!response.ok) {
            const reason = await failure(response, '設定を保存できません。');
            if (response.status === 422) await load().catch(() => {});
            throw new Error(reason);
          }
          accept(await response.json());
        } catch (caught) { error = caught; }
        pending.splice(pending.indexOf(edit), 1);
        emit(previous, { applied: !error, failed: !!error, status: !!error });
        if (error) throw error;
      });
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { events?.close(); listeners.clear(); },
  };
  if (watch && typeof EventSourceClass === 'function') {
    events = new EventSourceClass('/api/settings/events');
    events.addEventListener('change', event => {
      let announced;
      try { announced = JSON.parse(event.data).revision; } catch { return; }
      if (announced !== revision) reload();
    });
    // Also cover changes between the initial GET and the first stream opening.
    events.addEventListener('open', () => { reload(); });
  }
  return store;
}
