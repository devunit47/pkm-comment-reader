import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_CUSTOM_CSS_BYTES = 100000;
export const MAX_CUSTOM_IMAGE_BYTES = 512 * 1024;
export const DEFAULT_CUSTOMIZATION_DIRECTORY = resolve(fileURLToPath(new URL('./customization/', import.meta.url)));
const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function invalidFile() { return Object.assign(new Error('Unsupported customization file'), { code: 'INVALID_CUSTOMIZATION' }); }
function directoryPath(directory) { return resolve(directory instanceof URL ? fileURLToPath(directory) : directory); }

async function safeDirectory(path, create = false) {
  if (create) {
    // Do not use recursive mkdir: it can follow a pre-existing directory symlink.
    try { await mkdir(path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalidFile();
  return { info, real: await realpath(path) };
}

export async function ensureCustomizationDirectories(directory = DEFAULT_CUSTOMIZATION_DIRECTORY) {
  const root = directoryPath(directory);
  await safeDirectory(root, true);
  for (const kind of ['styles', 'images']) await safeDirectory(join(root, kind), true);
  return root;
}

function allowedName(kind, name) {
  // Windows device names, alternate data streams, and hidden files are excluded on every OS.
  if (!name || name.startsWith('.') || /[<>:"/\\|?*\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) return false;
  const extension = extname(name).toLowerCase();
  return kind === 'styles' ? extension === '.css' : Object.hasOwn(imageTypes, extension);
}

function imageSignatureMatches(extension, bytes) {
  if (extension === '.png') return bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0;
  if (extension === '.jpg' || extension === '.jpeg') return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  if (extension === '.gif') return bytes.length >= 14 && /^(?:GIF87a|GIF89a)$/.test(bytes.toString('ascii', 0, 6)) && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0;
  return extension === '.webp' && bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.readUInt32LE(4) + 8 === bytes.length && bytes.toString('ascii', 8, 12) === 'WEBP' &&
    ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16));
}

async function readCustomization(root, kind, name) {
  if (!allowedName(kind, name)) throw invalidFile();
  const rootBefore = await safeDirectory(root);
  const folder = join(root, kind);
  const folderBefore = await safeDirectory(folder);
  const path = join(folder, name);
  const before = await lstat(path);
  const maxBytes = kind === 'styles' ? MAX_CUSTOM_CSS_BYTES : MAX_CUSTOM_IMAGE_BYTES;
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw invalidFile();
  // NOFOLLOW prevents a file symlink swap on platforms that support it. NONBLOCK also
  // prevents a swapped special file from blocking the server before fstat rejects it.
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes || opened.dev !== before.dev || opened.ino !== before.ino) throw invalidFile();
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw invalidFile();
    const after = await lstat(path);
    const rootAfter = await safeDirectory(root);
    const folderAfter = await safeDirectory(folder);
    if (after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino ||
        rootBefore.real !== rootAfter.real || rootBefore.info.ino !== rootAfter.info.ino ||
        folderBefore.real !== folderAfter.real || folderBefore.info.ino !== folderAfter.info.ino) throw invalidFile();
    const bytes = buffer.subarray(0, size);
    if (kind === 'styles') {
      try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalidFile(); }
      if (bytes.includes(0)) throw invalidFile();
    } else if (!imageSignatureMatches(extname(name).toLowerCase(), bytes)) throw invalidFile();
    return bytes;
  } finally { await handle.close(); }
}

export function createLocalCustomizationHandler(directory = DEFAULT_CUSTOMIZATION_DIRECTORY) {
  const root = directoryPath(directory);
  // Initialize when the server is created; retain failure without an unhandled rejection.
  const initialized = ensureCustomizationDirectories(root).then(() => true, () => false);
  return async function handleLocalCustomization(req, res, url) {
    const json = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const host = req.headers.host || '';
    const site = req.headers['sec-fetch-site'];
    if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host) ||
        (req.headers.origin && req.headers.origin !== `http://${host}`) ||
        (site && site !== 'same-origin' && site !== 'none')) {
      json(403, { error: 'このアプリから接続してください。' }); return;
    }
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); json(405, { error: '読み取りのみ利用できます。' }); return; }
    await initialized;
    try { await ensureCustomizationDirectories(root); } catch {
      json(503, { error: 'customizationフォルダーを利用できません。通常のフォルダーか、アクセス権を確認してください。' }); return;
    }
    if (url.pathname === '/api/customizations') {
      try {
        const result = { directory: root, styles: [], images: [], skipped: 0 };
        for (const kind of ['styles', 'images']) {
          for (const entry of await readdir(join(root, kind), { withFileTypes: true })) {
            if (!entry.isFile() || entry.isSymbolicLink() || !allowedName(kind, entry.name)) { result.skipped++; continue; }
            try {
              const bytes = await readCustomization(root, kind, entry.name);
              result[kind].push({ name: entry.name, size: bytes.length });
            } catch { result.skipped++; }
          }
          result[kind].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
        }
        json(200, result);
      } catch { json(503, { error: 'customizationフォルダーを読み取れません。アクセス権を確認してください。' }); }
      return;
    }
    const match = /^\/api\/customizations\/(styles|images)\/([^/]+)$/.exec(url.pathname);
    if (!match) { json(404, { error: 'ファイルが見つかりません。' }); return; }
    let name;
    try { name = decodeURIComponent(match[2]); } catch { json(400, { error: 'ファイル名が不正です。' }); return; }
    const kind = match[1];
    if (!allowedName(kind, name)) { json(400, { error: '対応していないファイル名または形式です。' }); return; }
    try {
      const content = await readCustomization(root, kind, name);
      res.writeHead(200, { 'Content-Type': kind === 'styles' ? 'text/css; charset=utf-8' : imageTypes[extname(name).toLowerCase()] });
      res.end(content);
    } catch (error) {
      json(error.code === 'ENOENT' ? 404 : 422, { error: error.code === 'ENOENT'
        ? 'ファイルが見つかりません。一覧を更新してください。'
        : 'このファイルは読み込めません。形式・サイズ・アクセス権を確認してください。' });
    }
  };
}
