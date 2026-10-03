import { HISTORY_LIMIT_KEY, normalizeStudio, normalizeHistoryLimit } from './studio.js';
import { normalizeWorkspace } from './workspace-model.js';
import { normalizeOverlays } from './overlay-model.js';

// Backups hold operating settings only. The appearance lives in the
// customization folder and is shared by copying that folder instead.
export const SETTINGS_KEYS = Object.freeze(['pokome-connections', 'pokome-auto-speech', 'pokome-voices', 'pokome-speech-engines', 'pokome-speech-options', 'pokome-users-v2', 'pokome-workspace-v1', HISTORY_LIMIT_KEY]);
const OPTIONAL_KEYS = [HISTORY_LIMIT_KEY];
// Backups from the browser-only era also carry the appearance and its images.
// Restoring imports them into the folder, so those files may still be large.
export const LEGACY_APPEARANCE_KEYS = Object.freeze(['pokome-studio', 'pokome-theme-v1', 'pokome-overlays-v1']);
export const MAX_SETTINGS_FILE_BYTES = 12 * 1024 * 1024;

export function exportSettings(storage) {
  if (!storage) throw new Error('ブラウザの保存機能を有効にしてください。');
  return { format: 'pokome-settings', version: 1, settings: Object.fromEntries(SETTINGS_KEYS.map(key => [key, storage.getItem(key)])) };
}

export function parseSettings(text) {
  if (text.length > MAX_SETTINGS_FILE_BYTES) throw new Error('設定ファイルは12MB以下にしてください。');
  const data = JSON.parse(text);
  if (data?.format !== 'pokome-settings' || data.version !== 1 || !data.settings || Array.isArray(data.settings)) throw new Error('対応する設定バックアップではありません。');
  const allowed = [...SETTINGS_KEYS, ...LEGACY_APPEARANCE_KEYS];
  if (Object.keys(data.settings).some(key => !allowed.includes(key)) || SETTINGS_KEYS.filter(key => !OPTIONAL_KEYS.includes(key)).some(key => !Object.hasOwn(data.settings, key))) throw new Error('必要な設定が不足しています。');
  const settings = Object.fromEntries(allowed.map(key => [key, Object.hasOwn(data.settings, key) ? data.settings[key] : null]));
  for (const key of allowed) {
    const value = settings[key];
    if (value !== null && typeof value !== 'string') throw new Error('設定の形式が正しくありません。');
    if (value !== null && key !== 'pokome-theme-v1') {
      const parsed = JSON.parse(value);
      if (key === HISTORY_LIMIT_KEY ? !Number.isInteger(parsed) : !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('設定の形式が正しくありません。');
    }
  }
  // Older backups kept the history limit inside the appearance settings.
  if (settings[HISTORY_LIMIT_KEY] === null && settings['pokome-studio'] !== null) {
    const legacy = JSON.parse(settings['pokome-studio']).listCount;
    if (Number.isInteger(legacy)) settings[HISTORY_LIMIT_KEY] = JSON.stringify(normalizeHistoryLimit(legacy));
  }
  return settings;
}

// Data URLs stay as they were saved; the caller uploads them as image files.
export function extractLegacyAppearance(settings) {
  if (LEGACY_APPEARANCE_KEYS.every(key => settings[key] === null)) return null;
  const parse = key => settings[key] === null ? null : JSON.parse(settings[key]);
  const workspace = parse('pokome-workspace-v1');
  return {
    studio: normalizeStudio(parse('pokome-studio') || {}),
    theme: settings['pokome-theme-v1'] || '',
    talk: workspace ? normalizeWorkspace(workspace).talk : null,
    overlays: normalizeOverlays(parse('pokome-overlays-v1')),
  };
}

export function dataUrlToBlob(dataURL) {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataURL);
  if (!match) throw new Error('画像の形式が正しくありません。');
  return new Blob([Uint8Array.from(atob(match[2]), character => character.charCodeAt(0))], { type: match[1] });
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
