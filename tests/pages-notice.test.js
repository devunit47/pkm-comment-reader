import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// GitHub Pages now hosts only a static moved notice. It must never ship app code.
test('Pages notice is a single static page without scripts or external loads', async () => {
  assert.deepEqual(await readdir(new URL('../pages/', import.meta.url)), ['index.html']);
  const html = await readFile(new URL('../pages/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<script|<link|<iframe|<img|<form|\son\w+=/i);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.match(html, /移転しました/);
  assert.match(html, /引き継がれません/);
  // The reasons are part of the notice: feature gap (OBS) and future services.
  assert.match(html, /OBS/);
  assert.match(html, /YouTube・Kick/);
  const links = [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(links, ['https://github.com/devunit47/pkm-comment-reader']);
});

test('Pages workflow publishes the notice for every path and never builds the app', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cp pages\/index\.html site\/index\.html/);
  assert.match(workflow, /cp pages\/index\.html site\/404\.html/);
  assert.match(workflow, /path: site/);
  assert.doesNotMatch(workflow, /npm|build:pages|dist/);
});

// Old Pages data is not migrated automatically, but a settings backup made
// there restores in the local editions. Both facts must be stated separately.
test('notice and README separate automatic migration from restoring a backup', async () => {
  const html = await readFile(new URL('../pages/index.html', import.meta.url), 'utf8');
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  for (const text of [html, readme.slice(readme.indexOf('## 提供している版'), readme.indexOf('## ローカルで動かす'))]) {
    assert.match(text, /自動では引き継がれません/);
    assert.match(text, /設定のバックアップ/);
    assert.match(text, /復元できます/);
    assert.doesNotMatch(text, /設定し直してください/);
  }
});

test('user documentation no longer explains how to use the retired Pages edition', async () => {
  for (const file of ['../docs/customization.md', '../PRIVACY.md', '../DISCLAIMER.md', '../CONTRIBUTING.md']) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /GitHub Pages/, file);
  }
  // README may mention Pages only where it explains the end and the notice.
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const usage = readme.slice(0, readme.indexOf('## 提供している版'))
    + readme.slice(readme.indexOf('## ローカルで動かす'), readme.indexOf('## GitHub Pagesの移転案内'))
    + readme.slice(readme.indexOf('## 更新情報')).replace('GitHub Pagesの移転案内は別の手動ワークフローで更新します。', '');
  assert.doesNotMatch(usage, /GitHub Pages/);
});
