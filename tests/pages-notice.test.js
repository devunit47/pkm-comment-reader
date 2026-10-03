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
