import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPages } from '../build-pages.js';
import { enabledPlatforms } from '../app-config.js';
import { ChatConnection } from '../connections.js';
import { once } from 'node:events';
import { createPreviewServer } from '../preview-pages.js';

test('Pages output is Twitch-only, works below a repository path, and excludes local and Kick assets', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'pokome-pages-'));
  assert.equal(dirname(folder), tmpdir());
  assert.ok(basename(folder).startsWith('pokome-pages-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const destination = pathToFileURL(folder + '/');
  await buildPages(destination);
  assert.deepEqual(enabledPlatforms, ['twitch', 'kick']);
  const files = await readdir(folder);
  assert.deepEqual(files.sort(), ['.nojekyll', 'app-config.js', 'app.js', 'chat-state.js', 'connections.js', 'index.html', 'speech-options.js', 'speech-engine.js', 'studio.js', 'workspace.js', 'workspace-model.js', 'theme.js', 'style.css', 'settings-backup.js', 'speech-background.svg'].sort());
  const config = await import(new URL('app-config.js', destination));
  assert.deepEqual(config.enabledPlatforms, ['twitch']);
  assert.equal(config.publication, 'pages');
  const html = await readFile(new URL('index.html', destination), 'utf8');
  const version = html.match(/app\.js\?v=([a-f0-9]{16})/)[1];
  const app = await readFile(new URL('app.js', destination), 'utf8');
  for (const [, modulePath] of app.matchAll(/from ['"]([^'"]+)['"]/g)) {
    assert.ok(modulePath.endsWith(`?v=${version}`), modulePath);
  }
  for (const [, path] of html.matchAll(/(?:src|href)="(\.[^\"]+)"/g)) {
    assert.ok(new URL(path, 'https://example.github.io/reader/').pathname.startsWith('/reader/'));
  }
  assert.doesNotMatch(html, /(?:src|href)="\//);
  assert.match(html, /id="local-speech-controls" hidden/);
  assert.ok(!files.includes('local-speech.js'));
  assert.equal((html.match(/data-service="kick" hidden/g) || []).length, 3);
  const connections = await readFile(new URL('connections.js', destination), 'utf8');
  assert.doesNotMatch(connections, /pusher\.com|32cbd69e4b950bf97679/);
  const server = createPreviewServer(destination);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/preview/`)).status, 200);
  for (const file of files.filter(file => !file.startsWith('.'))) {
    assert.equal((await fetch(`${base}/preview/${file}`)).status, 200, file);
  }
  for (const path of ['/api/kick/channel/test', '/preview/kick.js', '/preview/server.js', '/app.js']) {
    assert.equal((await fetch(`${base}${path}`)).status, 404, path);
  }
  await buildPages(destination); // Rebuilding its own output is supported.
  await writeFile(new URL('private.env', destination), 'test-only');
  await assert.rejects(buildPages(destination), /unexpected files/);
});

test('Twitch uses browser WebSocket without fetching the omitted Kick module or local API', async () => {
  let socket;
  const statuses = [];
  class FakeSocket {
    constructor(url) { socket = this; this.url = url; this.sent = []; }
    send(value) { this.sent.push(value); }
    close() {}
  }
  const connection = new ChatConnection('twitch', {
    WebSocketClass: FakeSocket,
    fetchImpl() { throw new Error('Twitch must not need a server'); },
    onStatus: value => statuses.push(value), onMessage() {}, onConnected() {},
  });
  try {
    await connection.connect('test_channel');
    assert.equal(socket.url, 'wss://irc-ws.chat.twitch.tv:443');
    socket.onopen();
    assert.ok(socket.sent.includes('JOIN #test_channel'));
    socket.onmessage({ data: ':server 366 anon #test_channel :End of names\r\n' });
    assert.equal(statuses.at(-1), '接続中');
  } finally { connection.disconnect(false); }
});
