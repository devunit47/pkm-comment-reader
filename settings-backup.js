const OPTIONAL_KEYS = ['pokome-overlays-v1'];
export const SETTINGS_KEYS = Object.freeze(['pokome-connections', 'pokome-auto-speech', 'pokome-voices', 'pokome-speech-engines', 'pokome-speech-options', 'pokome-users-v2', 'pokome-studio', 'pokome-workspace-v1', 'pokome-theme-v1', ...OPTIONAL_KEYS]);

export function exportSettings(storage) {
  if (!storage) throw new Error('ブラウザの保存機能を有効にしてください。');
  return { format: 'pokome-settings', version: 1, settings: Object.fromEntries(SETTINGS_KEYS.map(key => [key, storage.getItem(key)])) };
}

export function parseSettings(text) {
  if (text.length > 12 * 1024 * 1024) throw new Error('設定ファイルは12MB以下にしてください。');
  const data = JSON.parse(text);
  if (data?.format !== 'pokome-settings' || data.version !== 1 || !data.settings || Array.isArray(data.settings)) throw new Error('対応する設定バックアップではありません。');
  if (Object.keys(data.settings).some(key => !SETTINGS_KEYS.includes(key)) || SETTINGS_KEYS.filter(key => !OPTIONAL_KEYS.includes(key)).some(key => !Object.hasOwn(data.settings, key))) throw new Error('必要な設定が不足しています。');
  for (const key of OPTIONAL_KEYS) if (!Object.hasOwn(data.settings, key)) data.settings[key] = null;
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
  const clear = () => { for (const key of SETTINGS_KEYS) storage.removeItem(key); };
  try { clear(); for (const key of SETTINGS_KEYS) write(key, settings[key]); }
  catch (error) {
    try {
      clear();
      for (const key of SETTINGS_KEYS) write(key, previous[key]);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], '設定の復元と元の設定への書き戻しに失敗しました。バックアップを保持して、ブラウザの保存設定を確認してください。', { cause: error });
    }
    throw error;
  }
}
