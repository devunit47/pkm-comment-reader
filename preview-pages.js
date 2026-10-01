import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// A repository subpath, with no backend API, matches the Pages hosting model.
export function createPreviewServer(directory = new URL('./dist/', import.meta.url)) {
  const assets = new Set(['index.html', 'style.css', 'app.js', 'connections.js', 'chat-state.js', 'speech-options.js', 'studio.js', 'app-config.js']);
  return http.createServer(async (req, res) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=()');
    const url = new URL(req.url, 'http://localhost');
    const file = url.pathname.startsWith('/preview/') ? url.pathname.slice('/preview/'.length) || 'index.html' : '';
    if (req.method !== 'GET' || !assets.has(file)) { res.writeHead(404); res.end('Not found'); return; }
    try {
      const content = await readFile(new URL(file, directory));
      const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript';
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
      res.end(content);
    } catch { res.writeHead(404); res.end('Build the Pages version first'); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createPreviewServer().listen(5174, '127.0.0.1', () => console.log('Twitch-only preview: http://localhost:5174/preview/'));
}
