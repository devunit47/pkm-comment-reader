import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { rasterDimensions } from '../src/shared/overlay-model.js';

const screenFiles = [
  'dense-body.webp',
  'portrait-chips.webp',
  'room-translucent.webp',
  'talk-materials.webp',
  'thin-left.webp',
  'thin-right.webp',
];

// GitHub Pages now hosts only a static moved notice. It must never ship app code.
test('Pages notice contains only static HTML and gallery images without scripts or external loads', async () => {
  assert.deepEqual((await readdir(new URL('../pages/', import.meta.url))).sort(), ['index.html', 'screens']);
  assert.deepEqual((await readdir(new URL('../pages/screens/', import.meta.url))).sort(), screenFiles);
  const html = await readFile(new URL('../pages/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /<(?:script|link|iframe|object|embed|audio|video|source|form)\b|\son\w+\s*=/i);
  assert.doesNotMatch(html, /@import|url\s*\(/i);
  const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
  assert.ok(csp);
  assert.equal(csp[1], "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'");
  assert.doesNotMatch(html, /\s(?:srcset|poster|data)\s*=/i);
  assert.deepEqual([...html.matchAll(/\ssrc="([^"]+)"/g)].map(match => match[1]).sort(),
    screenFiles.map(file => `/pkm-comment-reader/screens/${file}`));
  assert.match(html, /移転しました/);
  assert.match(html, /引き継がれません/);
  // The reasons are part of the notice: feature gap (OBS) and future services.
  assert.match(html, /OBS/);
  assert.match(html, /YouTube・Kick/);
  const links = [...html.matchAll(/href="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(links, ['https://github.com/devunit47/pkm-comment-reader']);
});

test('Pages gallery has six local images with descriptions, dimensions and a small file budget', async () => {
  const html = await readFile(new URL('../pages/index.html', import.meta.url), 'utf8');
  const images = [...html.matchAll(/<img\b([^>]+)>/g)];
  assert.equal(images.length, 6);
  const referenced = [];
  let totalSize = 0;
  for (const [, attributes] of images) {
    const attr = Object.fromEntries([...attributes.matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    assert.ok(attr.alt?.trim());
    assert.match(attr.src, /^\/pkm-comment-reader\/screens\/[a-z-]+\.webp$/);
    const file = attr.src.slice('/pkm-comment-reader/screens/'.length);
    referenced.push(file);
    const portrait = file === 'portrait-chips.webp';
    assert.equal(attr.width, portrait ? '720' : '1280', file);
    assert.equal(attr.height, portrait ? '1280' : '720', file);
    const image = await stat(new URL(`../pages/screens/${file}`, import.meta.url));
    assert.ok(image.isFile(), file);
    assert.deepEqual(rasterDimensions(await readFile(new URL(`../pages/screens/${file}`, import.meta.url)), 'image/webp'),
      [Number(attr.width), Number(attr.height)], file);
    assert.ok(image.size > 0 && image.size <= 300_000, `${file}: ${image.size} bytes`);
    totalSize += image.size;
  }
  assert.deepEqual(referenced.sort(), screenFiles);
  assert.ok(totalSize <= 1_500_000, `${totalSize} bytes`);
  assert.match(html, /ローカル版で作れる画面の例/);
  assert.match(html, /画面例の人物・背景は架空の素材です/);
  assert.equal([...html.matchAll(/<figcaption>/g)].length, 6);
  const intro = html.match(/<p class="gallery-intro">([^<]+)<\/p>/)?.[1];
  assert.ok(intro);
  assert.match(intro, /一部の画面は、テーマCSSで細かな見た目を調整しています。/);
  assert.doesNotMatch(html, /立ち絵の下端はテーマCSSで調整。|机の位置はテーマCSSで調整。/);
  assert.match(html, /投稿ごとの丸い背景と2行の表示は、テーマCSSで作っています。/);
});

test('Pages workflow publishes the notice for every path and never builds the app', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cp pages\/index\.html site\/index\.html/);
  assert.match(workflow, /cp pages\/index\.html site\/404\.html/);
  assert.match(workflow, /cp -R pages\/screens site\/screens/);
  assert.match(workflow, /path: site/);
  assert.doesNotMatch(workflow, /npm|build:pages|dist/);
});

// Old Pages data is not migrated automatically, but a settings backup made
// there restores in the local editions. Both facts must be stated separately.
test('notice and README separate automatic migration from restoring a backup', async () => {
  const html = await readFile(new URL('../pages/index.html', import.meta.url), 'utf8');
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const githubLink = html.indexOf('href="https://github.com/devunit47/pkm-comment-reader"');
  const migrationNote = html.indexOf('自動では引き継がれません');
  const gallery = html.indexOf('<section class="gallery-section"');
  assert.ok(githubLink < migrationNote && migrationNote < gallery, 'Migration guidance must follow the GitHub link and precede the gallery');
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
