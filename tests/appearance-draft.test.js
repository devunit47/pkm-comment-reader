import test from 'node:test';
import assert from 'node:assert/strict';
import { writeAppearanceAtomically } from '../appearance-draft.js';

function memoryStorage(initial = {}, shouldThrow = () => false) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values, writes,
    getItem: key => values.get(key) ?? null,
    setItem(key, value) {
      writes.push([key, value]);
      if (shouldThrow(key, value, writes.length)) throw new Error('quota');
      values.set(key, value);
    },
    removeItem(key) {
      writes.push([key, null]);
      if (shouldThrow(key, null, writes.length)) throw new Error('denied');
      values.delete(key);
    },
  };
}

test('atomic appearance write updates only supplied keys including removals', () => {
  const storage = memoryStorage({ theme: 'old', layout: 'old', overlay: 'old', unrelated: 'leave-me' });
  assert.equal(writeAppearanceAtomically(storage, { theme: 'new', layout: null, overlay: 'new' }), true);
  assert.deepEqual(Object.fromEntries(storage.values), { theme: 'new', overlay: 'new', unrelated: 'leave-me' });
  storage.writes.length = 0;
  assert.equal(writeAppearanceAtomically(storage, [['theme', 'new']]), true);
  assert.equal(storage.writes.length, 0);
});

test('atomic appearance write restores prior keys after failure at every position', () => {
  const initial = { theme: 'old-theme', layout: 'old-layout', unrelated: 'unchanged' };
  for (const failAt of [1, 2, 3, 4]) {
    const storage = memoryStorage(initial, (_key, _value, count) => count === failAt);
    assert.throws(() => writeAppearanceAtomically(storage, [['theme', 'new'], ['added', 'image-bytes'], ['layout', null], ['overlays', 'new']]), error => error.rollbackFailed === false && /保存できません/.test(error.message));
    assert.deepEqual(Object.fromEntries(storage.values), initial);
  }
});

test('bad input and unreadable snapshots cannot start writes', () => {
  const storage = memoryStorage({ theme: 'old' });
  for (const entries of [[['theme', 'a'], ['theme', 'b']], { theme: {} }, [['', 'x']], [['theme']]]) {
    assert.throws(() => writeAppearanceAtomically(storage, entries));
  }
  assert.equal(storage.writes.length, 0);
  assert.throws(() => writeAppearanceAtomically(undefined, { theme: 'new' }));
  storage.getItem = () => { throw new Error('read denied'); };
  assert.throws(() => writeAppearanceAtomically(storage, { theme: 'new' }));
  assert.equal(storage.writes.length, 0);
});

test('atomic writer reports an unrecoverable browser rollback failure explicitly', () => {
  const storage = memoryStorage({ theme: 'old' }, (_key, _value, count) => count >= 2);
  assert.throws(() => writeAppearanceAtomically(storage, { theme: 'new', overlays: 'new' }), error => {
    assert.equal(error.rollbackFailed, true);
    assert.equal(error.rollbackErrors.length, 1);
    assert.equal(error.cause.message, 'quota');
    return true;
  });
});

test('quota rollback frees all temporary grown values before restoring larger originals', () => {
  const initial = { first: 'a', second: 'bbbbbbbb', third: 'c' };
  const storage = memoryStorage(initial);
  storage.setItem = (key, value) => {
    const next = new Map(storage.values); next.set(key, value);
    if ([...next.values()].join('').length > 15) throw new Error('quota');
    storage.values.set(key, value);
  };
  // first grows using spare capacity, second shrinks, then third exceeds quota.
  // A reverse write-only rollback would overflow while restoring second first.
  assert.throws(() => writeAppearanceAtomically(storage, { first: 'aaaaaa', second: 'b', third: 'ccccccccc' }), error => error.rollbackFailed === false);
  assert.deepEqual(Object.fromEntries(storage.values), initial);
});

test('atomic rollback also handles a storage implementation that throws after mutation', () => {
  const storage = memoryStorage({ original: 'old' });
  const setItem = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    setItem(key, value);
    if (key === 'new-key' && value === 'new-value') throw new Error('post-write failure');
  };
  assert.throws(() => writeAppearanceAtomically(storage, { original: 'new', 'new-key': 'new-value' }), error => !error.rollbackFailed);
  assert.deepEqual(Object.fromEntries(storage.values), { original: 'old' });
});
