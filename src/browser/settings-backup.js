import { normalizeHistoryLimit } from '../shared/studio.js';
import { MAX_SETTINGS_BYTES, normalizeSettings, SETTINGS_FIELDS } from '../shared/settings-model.js';

// Only backup import understands these obsolete names. Browser storage is never read.
const LEGACY_FIELDS = Object.freeze({
  'pokome-connections': 'connections', 'pokome-auto-speech': 'autoSpeech', 'pokome-voices': 'voices',
  'pokome-speech-engines': 'speechEngines', 'pokome-speech-options': 'speechOptions',
  'pokome-users-v2': 'users', 'pokome-history-limit': 'historyLimit',
});
export const LEGACY_APPEARANCE_KEYS = Object.freeze(['pokome-studio', 'pokome-theme-v1', 'pokome-overlays-v1', 'pokome-workspace-v1']);
export const MAX_SETTINGS_FILE_BYTES = MAX_SETTINGS_BYTES;
export function exportSettings(settings) {
  const normalized = normalizeSettings(settings);
  return { format: 'pokome-settings', version: 1,
    settings: Object.fromEntries(Object.entries(LEGACY_FIELDS).map(([key, field]) => [key, JSON.stringify(normalized[field])])) };
}

export function parseSettings(text) {
  if (new TextEncoder().encode(text).length > MAX_SETTINGS_FILE_BYTES) throw new Error('設定ファイルは12MB以下にしてください。');
  const data = JSON.parse(text);
  if (data?.format !== 'pokome-settings' || data.version !== 1 || !data.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) throw new Error('対応する設定バックアップではありません。');
  const allowed = [...Object.keys(LEGACY_FIELDS), ...LEGACY_APPEARANCE_KEYS];
  if (Object.keys(data.settings).some(key => !allowed.includes(key)) || Object.keys(LEGACY_FIELDS).filter(key => key !== 'pokome-history-limit').some(key => !Object.hasOwn(data.settings, key))) throw new Error('必要な設定が不足しています。');
  const settings = {};
  for (const [key, field] of Object.entries(LEGACY_FIELDS)) {
    const value = data.settings[key];
    if (value === null || value === undefined) continue;
    if (typeof value !== 'string') throw new Error('設定の形式が正しくありません。');
    const parsed = JSON.parse(value);
    if (field === 'historyLimit' ? !Number.isInteger(parsed) : !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('設定の形式が正しくありません。');
    settings[field] = parsed;
  }
  if (!Object.hasOwn(settings, 'historyLimit')) {
    try {
      const count = JSON.parse(data.settings['pokome-studio'])?.listCount;
      if (Number.isInteger(count)) settings.historyLimit = normalizeHistoryLimit(count);
    } catch { /* Obsolete appearance must not prevent restoring operating settings. */ }
  }
  return normalizeSettings(settings);
}

export async function restoreSettings(store, settings) {
  const normalized = normalizeSettings(settings);
  try {
    for (const field of SETTINGS_FIELDS) await store.set(field, normalized[field]);
  } catch (error) {
    // Rolling back here would overwrite another page's newer field values.
    throw new Error(`設定の復元に失敗しました。一部の項目だけ復元されている可能性があります。バックアップを保持して、保存先を確認してからもう一度復元してください。${error.message}`, { cause: error });
  }
}
