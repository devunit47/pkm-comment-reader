export const SETTINGS_KEYS = Object.freeze(['pokome-connections', 'pokome-auto-speech', 'pokome-voices', 'pokome-speech-engines', 'pokome-speech-options', 'pokome-users-v2', 'pokome-studio', 'pokome-workspace-v1', 'pokome-theme-v1']);

export function exportSettings(storage) {
  if (!storage) throw new Error('ブラウザの保存機能を有効にしてください。');
  return { format: 'pokome-settings', version: 1, settings: Object.fromEntries(SETTINGS_KEYS.map(key => [key, storage.getItem(key)])) };
}

export function parseSettings(text) {
  if (text.length > 12 * 1024 * 1024) throw new Error('設定ファイルは12MB以下にしてください。');
  const data = JSON.parse(text);
  if (data?.format !== 'pokome-settings' || data.version !== 1 || !data.settings || Array.isArray(data.settings)) throw new Error('対応する設定バックアップではありません。');
  if (Object.keys(data.settings).length !== SETTINGS_KEYS.length || SETTINGS_KEYS.some(key => !Object.hasOwn(data.settings, key))) throw new Error('必要な設定が不足しています。');
  for (const key of SETTINGS_KEYS) {
    const value = data.settings[key];
    if (value !== null && typeof value !== 'string') throw new Error('設定の形式が正しくありません。');
    if (value !== null && key !== 'pokome-theme-v1') {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('設定の形式が正しくありません。');
    }
  }
  return data.settings;
}

export function restoreSettings(storage, settings) {
  if (!storage) throw new Error('ブラウザの保存機能を有効にしてください。');
  const previous = exportSettings(storage).settings;
  const write = (key, value) => value === null ? storage.removeItem(key) : storage.setItem(key, value);
  try { for (const key of SETTINGS_KEYS) write(key, settings[key]); }
  catch (error) {
    for (const key of SETTINGS_KEYS) write(key, previous[key]);
    throw error;
  }
}
