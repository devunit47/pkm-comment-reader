import test from 'node:test';
import assert from 'node:assert/strict';
import { matrixCases } from './browser-support.js';

const axes = { scheme: ['light', 'dark'], theme: ['mint', 'rose', 'violet', 'paper'], ratio: ['16:9', '9:16', '4:3'] };
const pairs = (rows, names) => new Set(rows.flatMap(row => names.flatMap((a, i) => names.slice(i + 1).map(b => `${a}=${row[a]}|${b}=${row[b]}`))));
const withFullMatrix = (value, run) => {
  const previous = process.env.FULL_MATRIX;
  if (value === undefined) delete process.env.FULL_MATRIX; else process.env.FULL_MATRIX = value;
  try { return run(); } finally { if (previous === undefined) delete process.env.FULL_MATRIX; else process.env.FULL_MATRIX = previous; }
};

test('ordinary runs keep every value pair of any two axes with fewer cases', () => {
  const names = Object.keys(axes);
  const full = withFullMatrix('1', () => matrixCases(axes));
  const ordinary = withFullMatrix(undefined, () => matrixCases(axes));
  assert.equal(full.length, 24);
  assert.ok(ordinary.length < full.length, `${ordinary.length} cases`);
  assert.deepEqual(pairs(ordinary, names), pairs(full, names));
  assert.deepEqual(withFullMatrix(undefined, () => matrixCases(axes)), ordinary, 'the subset is deterministic');
});

test('two axes and FULL_MATRIX=1 keep every combination', () => {
  const two = { theme: axes.theme, scheme: axes.scheme };
  assert.equal(withFullMatrix(undefined, () => matrixCases(two)).length, 8);
  assert.equal(withFullMatrix('1', () => matrixCases(axes)).length, 24);
});
