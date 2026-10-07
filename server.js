import { DEVELOPMENT_ASSETS } from './src/server/asset-manifest.js';
import { enabledPlatforms } from './src/shared/app-config.js';
import { handleLocalSpeech } from './src/server/local-speech.js';
import { createLocalCustomizationHandler, DEFAULT_CUSTOMIZATION_DIRECTORY } from './src/server/local-customization.js';
import { createDesignStorage } from './src/server/design-storage.js';
import { createSettingsStorage, DEFAULT_DATA_DIRECTORY } from './src/server/settings-storage.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validChannel } from './src/shared/connections.js';
const files = Object.fromEntries(DEVELOPMENT_ASSETS.map(file => [file === 'index.html' ? '/' : '/' + file, file]));
const types = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml' };

export function createServer({ fetchImpl = globalThis.fetch, customizationDirectory = DEFAULT_CUSTOMIZATION_DIRECTORY, dataDirectory = DEFAULT_DATA_DIRECTORY } = {}) {
  const handleLocalCustomization = createLocalCustomizationHandler(customizationDirectory);
  const design = createDesignStorage(resolve(customizationDirectory instanceof URL ? fileURLToPath(customizationDirectory) : customizationDirectory));
  const settings = createSettingsStorage(dataDirectory);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=()');
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); res.end('Bad request'); return; }
    if (url.pathname === '/api/customizations' || url.pathname.startsWith('/api/customizations/')) { await handleLocalCustomization(req, res, url); return; }
    if (url.pathname.startsWith('/api/design/')) { await design.handle(req, res, url); return; }
    if (url.pathname === '/api/settings' || url.pathname.startsWith('/api/settings/')) { await settings.handle(req, res, url); return; }
    if (!enabledPlatforms.includes('kick') && (url.pathname === '/src/browser/kick.js' || url.pathname.startsWith('/api/kick/'))) { res.writeHead(404); res.end('Not found'); return; }
    if (url.pathname.startsWith('/api/speech/')) { await handleLocalSpeech(req, res, url, fetchImpl); return; }
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
    if (url.pathname.startsWith('/api/kick/channel/')) {
      const json = (code, data) => {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(data));
      };
      // Only same-origin browser requests may use this fixed-destination lookup.
      const origin = req.headers.origin;
      const host = req.headers.host || '';
      if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host) ||
          (origin && origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
        json(403, { error: 'このアプリから接続してください。' }); return;
      }
      const channel = url.pathname.slice('/api/kick/channel/'.length);
      if (!validChannel('kick', channel)) { json(400, { error: 'Kickのチャンネル名を確認してください。' }); return; }
      try {
        const upstream = await fetchImpl(`https://kick.com/api/v2/channels/${channel.toLowerCase()}`, {
          signal: AbortSignal.timeout(10000), redirect: 'error', headers: { Accept: 'application/json' },
        });
        if (!upstream.ok) {
          json(upstream.status === 404 ? 404 : 502, { error: upstream.status === 404
            ? 'Kickのチャンネルが見つかりません。'
            : 'Kickのチャンネル情報を取得できません。時間をおいて再接続してください。' });
          return;
        }
        const data = await upstream.json();
        if (!Number.isSafeInteger(data?.chatroom?.id) || data.chatroom.id < 1) {
          json(502, { error: 'Kickのチャットルーム情報が見つかりません。' }); return;
        }
        json(200, { chatroomId: data.chatroom.id });
      } catch {
        json(502, { error: 'Kickに通信できません。通信環境を確認して再接続してください。' });
      }
      return;
    }
    const file = Object.hasOwn(files, url.pathname) ? files[url.pathname] : null;
    if (!file) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    try {
      const content = await readFile(new URL(file, import.meta.url));
      res.writeHead(200, { 'Content-Type': types[file.split('.').pop()] });
      res.end(content);
    } catch (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500);
      res.end(error.code === 'ENOENT' ? 'Not found' : 'Unable to load file');
    }
  });
  // Open event streams would otherwise keep close() waiting forever.
  const close = server.close.bind(server);
  server.close = callback => {
    design.closeEvents();
    settings.closeEvents();
    const result = close(callback);
    server.closeIdleConnections();
    return result;
  };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 5173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535');
  createServer().listen(port, '127.0.0.1', () => console.log(`Open http://localhost:${port}`));
}
