import test from 'node:test';
import assert from 'node:assert/strict';
import { editionInfo, createCustomizationStatus, runCustomizationApply } from '../customization.js';

test('capabilities distinguish distributed local and development local editions', () => {
  const local = editionInfo(['twitch']);
  assert.equal(local.title, 'Windows ローカル配布版');
  assert.match(local.services, /Twitchのみ/);
  assert.match(local.speech, /別途インストール・起動が必要/);
  assert.match(local.files, /一覧から選べます/);
  const development = editionInfo(['twitch', 'kick']);
  assert.equal(development.title, 'ローカル開発版');
  assert.match(development.services, /Twitch・Kick/);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function statusFixture() {
  let message = '';
  const status = createCustomizationStatus(value => { message = value; });
  return { status, current: () => message };
}
function applyOptions(read, apply, label = 'old') {
  return { read, apply, loading: `${label}: loading`, success: `${label}: saved`, cancelled: `${label}: superseded` };
}

test('superseded CSS null and image false both settle their own loading status', async () => {
  for (const result of [null, false]) {
    const { status, current } = statusFixture();
    const input = deferred();
    const operation = runCustomizationApply(status, applyOptions(() => input.promise, () => result));
    assert.equal(current(), 'old: loading');
    input.resolve('file');
    await operation;
    assert.equal(current(), 'old: superseded');
  }
});

test('appearance reset replaces loading immediately and stale success, skips and failures cannot undo it', async () => {
  for (const result of [true, null, false, new Error('old failure')]) {
    const { status, current } = statusFixture();
    const input = deferred();
    const operation = runCustomizationApply(status, applyOptions(() => input.promise, () => result));
    status.clear('restored defaults');
    assert.equal(current(), 'restored defaults');
    if (result instanceof Error) input.reject(result); else input.resolve('file');
    await operation;
    assert.equal(current(), 'restored defaults');
  }
});

test('older same-channel completion cannot clear a newer loading or completed status', async () => {
  for (const result of [true, null, false, new Error('old failure')]) {
    for (const newerFinishesFirst of [true, false]) {
      const { status, current } = statusFixture();
      const older = deferred(), newer = deferred();
      const oldOperation = runCustomizationApply(status, applyOptions(() => older.promise, () => result, 'style'));
      const newOperation = runCustomizationApply(status, applyOptions(() => newer.promise, () => true, 'image'));
      if (newerFinishesFirst) { newer.resolve('new image'); await newOperation; }
      if (result instanceof Error) older.reject(result); else older.resolve('old style');
      await oldOperation;
      assert.equal(current(), newerFinishesFirst ? 'image: saved' : 'image: loading');
      if (!newerFinishesFirst) { newer.resolve('new image'); await newOperation; }
      assert.equal(current(), 'image: saved');
    }
  }
});

test('default-channel owners supersede older operations while explicit channels remain independent', async () => {
  const { status, current } = statusFixture();
  const input = deferred();
  const operation = runCustomizationApply(status, applyOptions(() => input.promise, () => null));
  const refresh = status.begin('refreshing');
  status.finish(refresh, 'files listed');
  input.resolve('file'); await operation;
  assert.equal(current(), 'files listed');
  const oldRefresh = status.begin('refreshing');
  await runCustomizationApply(status, applyOptions(async () => 'new', () => true, 'image'));
  assert.equal(status.finish(oldRefresh, 'old listing'), false);
  assert.equal(current(), 'image: saved');
});

test('CSS storage failure and current request failure both replace loading with useful results', async () => {
  const { status, current } = statusFixture();
  await runCustomizationApply(status, { ...applyOptions(async () => 'CSS', () => false), unsaved: 'applied without saving' });
  assert.equal(current(), 'applied without saving');
  await runCustomizationApply(status, applyOptions(async () => { throw new Error('missing file'); }, () => true));
  assert.equal(current(), '適用できませんでした：missing file');
});

test('independent CSS and image outcomes survive either completion order, but reset invalidates both', async () => {
  for (const cssFinishesFirst of [true, false]) {
    const messages = new Map();
    const status = createCustomizationStatus((message, channel) => {
      if (channel === null) messages.clear();
      messages.set(channel, message);
    });
    const css = deferred(), image = deferred();
    const cssOperation = runCustomizationApply(status, { ...applyOptions(() => css.promise, () => true, 'css'), channel: 'css' });
    const imageOperation = runCustomizationApply(status, { ...applyOptions(() => image.promise, () => true, 'image'), channel: 'image' });
    if (cssFinishesFirst) { css.reject(new Error('deleted CSS')); await cssOperation; }
    image.resolve('image'); await imageOperation;
    if (!cssFinishesFirst) { css.reject(new Error('deleted CSS')); await cssOperation; }
    assert.match(messages.get('css'), /deleted CSS/);
    assert.equal(messages.get('image'), 'image: saved');
    const pendingCSS = deferred(), pendingImage = deferred();
    const oldCSS = runCustomizationApply(status, { ...applyOptions(() => pendingCSS.promise, () => true), channel: 'css' });
    const oldImage = runCustomizationApply(status, { ...applyOptions(() => pendingImage.promise, () => true), channel: 'image' });
    status.clear('restored defaults');
    pendingCSS.reject(new Error('stale CSS failure')); pendingImage.resolve('old image');
    await Promise.all([oldCSS, oldImage]);
    assert.deepEqual([...messages], [[null, 'restored defaults']]);
  }
});
