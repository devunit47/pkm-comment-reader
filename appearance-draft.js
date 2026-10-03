// localStorage has no transactions. Snapshot first, then roll back every touched
// key if a synchronous write fails. Callers change live state only after success.
export function writeAppearanceAtomically(storage, entries) {
  if (!storage || typeof storage.getItem !== 'function' || typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function') {
    throw new Error('ブラウザに見た目を保存できません。');
  }
  const changes = Array.isArray(entries) ? entries : Object.entries(entries || {});
  const seen = new Set();
  for (const entry of changes) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || !entry[0] || seen.has(entry[0]) || (entry[1] !== null && typeof entry[1] !== 'string')) {
      throw new Error('保存する見た目の形式が正しくありません。');
    }
    seen.add(entry[0]);
  }
  // Do not write anything if even one original value cannot be read.
  const snapshots = changes.map(([key]) => [key, storage.getItem(key)]);
  const touched = [];
  try {
    for (let index = 0; index < changes.length; index++) {
      const [key, value] = changes[index];
      if (value === snapshots[index][1]) continue;
      touched.push(index);
      if (value === null) storage.removeItem(key);
      else storage.setItem(key, value);
    }
  } catch (cause) {
    const rollbackErrors = [], restore = [];
    // Clear every changed value first: restoring a formerly large value before
    // removing another newly enlarged value can itself exceed the storage quota.
    for (const index of touched.reverse()) {
      const [key, previous] = snapshots[index];
      try { if (storage.getItem(key) === previous) continue; }
      catch { /* Still attempt restoration if the storage reader also failed. */ }
      let cleared = false;
      try { storage.removeItem(key); cleared = true; }
      catch { /* A subsequent restoring write can still succeed. */ }
      restore.push({ key, previous, cleared });
    }
    for (const { key, previous, cleared } of restore) {
      try {
        if (previous !== null) storage.setItem(key, previous);
        else if (!cleared) storage.removeItem(key);
      } catch (error) { rollbackErrors.push(error); }
    }
    const error = new Error(rollbackErrors.length
      ? '保存に失敗し、元の設定も復元できませんでした。ブラウザの保存設定を確認してください。'
      : '見た目を保存できませんでした。変更は保存されていません。小さい画像やブラウザの保存設定を確認してください。', { cause });
    error.rollbackFailed = rollbackErrors.length > 0;
    error.rollbackErrors = rollbackErrors;
    throw error;
  }
  return true;
}
