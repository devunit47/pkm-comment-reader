import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink, utimes, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { safeDirectory, imageSignatureMatches, ensureCustomizationDirectories } from './local-customization.js';
import { rasterDimensions } from '../shared/overlay-model.js';
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, IMAGE_TYPES, imageExtension, normalizeDesign, defaultDesign, designImageRefs } from '../shared/design-model.js';

// The applied design lives in customization/current: design.json plus images
// named by their SHA-256. Pages read it through this API and follow changes
// over Server-Sent Events, so OBS browser sources stay in sync too.
export const MAX_DESIGN_JSON_BYTES = 4 * 1024 * 1024;
// Images uploaded for a draft are unreferenced until it is applied. Only
// older unreferenced images are removed, so another tab's save cannot delete them.
export const UNREFERENCED_IMAGE_GRACE_MS = 24 * 60 * 60 * 1000;
const IMAGE_NAME = /^([0-9a-f]{64})\.(png|jpg|webp|gif)$/;
const HEARTBEAT_MS = 25000;

const failure = (status, message) => Object.assign(new Error(message), { status });
// The file was replaced between checks (a save renamed a new one into place).
const changed = () => Object.assign(failure(422, 'ファイルを読み込めません。'), { code: 'ECHANGED' });

async function readRegularFile(path, maxBytes) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw failure(422, 'ファイルを読み込めません。');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) throw failure(422, 'ファイルを読み込めません。');
    if (opened.dev !== before.dev || opened.ino !== before.ino) throw changed();
    const buffer = Buffer.alloc(opened.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size !== opened.size) throw changed();
    return { bytes: buffer.subarray(0, size), mtimeMs: opened.mtimeMs };
  } finally { await handle.close(); }
}

// Validates bytes for a given extension: signature, header pixels and size.
export function inspectImageBytes(bytes, extension) {
  const type = IMAGE_TYPES[extension];
  if (!type || bytes.length < 1 || bytes.length > MAX_IMAGE_BYTES) return null;
  if (!imageSignatureMatches(extension === 'jpg' ? '.jpg' : `.${extension}`, bytes)) return null;
  const dimensions = rasterDimensions(bytes, type);
  if (!dimensions) return null;
  const [width, height] = dimensions;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_IMAGE_PIXELS) return null;
  return { type, bytes: bytes.length, width, height };
}

// Windows refuses to replace a file while another request reads it, and to
// open one while it is being replaced (EPERM/EBUSY/EACCES). Those clear within
// milliseconds, so both sides retry briefly instead of failing the request.
export async function retryTransient(task, { attempts = 20, codes = ['EPERM', 'EBUSY', 'EACCES'], delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await task(); }
    catch (error) {
      if (attempt >= attempts || !codes.includes(error.code)) throw error;
      await delay(Math.min(100, attempt * 10));
    }
  }
}
export const renameWithRetry = (from, to, { renameFile = rename, ...options } = {}) => retryTransient(() => renameFile(from, to), options);
// A read that saw the file being replaced simply reads the new file.
const readStable = (path, maxBytes) => retryTransient(() => readRegularFile(path, maxBytes), { codes: ['EPERM', 'EBUSY', 'EACCES', 'ECHANGED'] });

async function atomicWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx' });
    await renameWithRetry(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readBody(req, maxBytes) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw failure(413, '送られたデータが大きすぎます。');
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw failure(413, '送られたデータが大きすぎます。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const localHost = host => /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host);
// Reads may come from an address bar or an OBS source; writes must come from
// a page of this app. JSON and image bodies also force a CORS preflight.
function readAllowed(req) {
  const host = req.headers.host || '', site = req.headers['sec-fetch-site'];
  return localHost(host) && (!req.headers.origin || req.headers.origin === `http://${host}`) && (!site || site === 'same-origin' || site === 'none');
}
function writeAllowed(req) {
  const host = req.headers.host || '', site = req.headers['sec-fetch-site'];
  return localHost(host) && req.headers.origin === `http://${host}` && (!site || site === 'same-origin');
}

export function createDesignStorage(root) {
  const current = join(root, 'current'), images = join(current, 'images'), designPath = join(current, 'design.json');
  const catalogCache = new Map();
  const clients = new Set();
  let queue = Promise.resolve();
  // Saves and cleanup run one at a time so If-Match checks cannot interleave.
  const exclusive = task => { const run = queue.then(task, task); queue = run.catch(() => {}); return run; };

  async function directories() {
    await ensureCustomizationDirectories(root);
    await safeDirectory(current, true);
    await safeDirectory(images, true);
  }

  async function catalog() {
    const result = {};
    const seen = new Set();
    for (const entry of await readdir(images, { withFileTypes: true })) {
      const match = IMAGE_NAME.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink()) continue;
      seen.add(entry.name);
      const path = join(images, entry.name);
      try {
        const info = await lstat(path);
        const cached = catalogCache.get(entry.name);
        if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
          if (cached.entry) result[`images/${entry.name}`] = cached.entry;
          continue;
        }
        const { bytes } = await readStable(path, MAX_IMAGE_BYTES);
        const inspected = inspectImageBytes(bytes, match[2]);
        // The name must be the content hash: a renamed or edited file is ignored.
        const valid = inspected && createHash('sha256').update(bytes).digest('hex') === match[1];
        catalogCache.set(entry.name, { size: info.size, mtimeMs: info.mtimeMs, entry: valid ? inspected : null });
        if (valid) result[`images/${entry.name}`] = inspected;
      } catch { catalogCache.delete(entry.name); }
    }
    for (const name of catalogCache.keys()) if (!seen.has(name)) catalogCache.delete(name);
    return result;
  }

  async function load() {
    await directories();
    const list = await catalog();
    let raw;
    try { raw = (await readStable(designPath, MAX_DESIGN_JSON_BYTES)).bytes; }
    catch (error) {
      if (error.code === 'ENOENT') return { design: defaultDesign(), images: list, revision: 'default' };
      throw error;
    }
    const revision = createHash('sha256').update(raw).digest('hex').slice(0, 32);
    try { return { design: normalizeDesign(JSON.parse(raw.toString('utf8')), list), images: list, revision }; }
    catch { return { design: defaultDesign(), images: list, revision, warning: '保存されていたデザインを読み込めなかったため、標準の見た目を表示しています。' }; }
  }

  async function cleanup(design) {
    const used = new Set([...designImageRefs(design)].map(ref => ref.slice('images/'.length)));
    const now = Date.now();
    for (const entry of await readdir(images, { withFileTypes: true })) {
      if (!IMAGE_NAME.test(entry.name) || used.has(entry.name) || !entry.isFile()) continue;
      try {
        const info = await lstat(join(images, entry.name));
        if (!info.isSymbolicLink() && now - info.mtimeMs > UNREFERENCED_IMAGE_GRACE_MS) await unlink(join(images, entry.name));
      } catch { /* A file removed meanwhile needs no cleanup. */ }
    }
  }

  function broadcast(revision) {
    for (const client of clients) client.write(`event: change\ndata: ${JSON.stringify({ revision })}\n\n`);
  }

  async function save(value, expected) {
    return exclusive(async () => {
      const before = await load();
      if (expected !== before.revision) throw Object.assign(failure(409, '別の画面で見た目が変更されました。最新の内容を読み込み直してください。'), { revision: before.revision });
      let design;
      try { design = normalizeDesign(value, before.images); }
      catch (error) { throw failure(400, error.message); }
      await atomicWrite(designPath, JSON.stringify(design, null, 2));
      const after = await load();
      await cleanup(after.design);
      broadcast(after.revision);
      return after;
    });
  }

  async function addImage(bytes, type) {
    const extension = imageExtension(type);
    const info = extension && inspectImageBytes(bytes, extension);
    if (!info || info.type !== type) throw failure(422, 'PNG・JPEG・WebP・GIFの20MB以下、1600万画素以内の画像を選んでください。');
    const name = `${createHash('sha256').update(bytes).digest('hex')}.${extension}`;
    return exclusive(async () => {
      await directories();
      const path = join(images, name);
      try {
        const existing = await lstat(path);
        if (!existing.isFile() || existing.isSymbolicLink()) throw failure(422, '画像を保存できません。');
        // Refresh the time so the grace period protects a re-uploaded image.
        const now = new Date(); await utimes(path, now, now);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await atomicWrite(path, bytes);
      }
      return { ref: `images/${name}`, ...info };
    });
  }

  async function sendImage(res, name) {
    const match = IMAGE_NAME.exec(name);
    if (!match) throw failure(404, '画像が見つかりません。');
    await directories();
    const list = await catalog();
    if (!list[`images/${name}`]) throw failure(404, '画像が見つかりません。');
    const { bytes } = await readStable(join(images, name), MAX_IMAGE_BYTES);
    if (createHash('sha256').update(bytes).digest('hex') !== match[1]) throw failure(404, '画像が見つかりません。');
    // Content-addressed: the same URL always has the same bytes.
    res.writeHead(200, { 'Content-Type': IMAGE_TYPES[match[2]], 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.end(bytes);
  }

  function events(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const close = () => { clearInterval(heartbeat); clients.delete(res); };
    req.on('close', close);
    res.on('close', close);
  }

  async function handle(req, res, url) {
    const json = (status, data) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const path = url.pathname;
    try {
      if (req.method === 'GET') {
        if (!readAllowed(req)) throw failure(403, 'このアプリから接続してください。');
        if (path === '/api/design/current') { json(200, await load()); return; }
        if (path === '/api/design/events') { events(req, res); return; }
        const image = /^\/api\/design\/current\/images\/([^/]+)$/.exec(path);
        if (image) { await sendImage(res, image[1]); return; }
        throw failure(404, '見つかりません。');
      }
      if (req.method === 'PUT') {
        if (!writeAllowed(req)) throw failure(403, 'このアプリから操作してください。');
        const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (path === '/api/design/current') {
          if (type !== 'application/json') throw failure(415, 'JSONで送ってください。');
          const expected = req.headers['if-match'];
          if (typeof expected !== 'string' || !expected) throw failure(428, '更新前の版を指定してください。');
          let value;
          try { value = JSON.parse((await readBody(req, MAX_DESIGN_JSON_BYTES)).toString('utf8')); }
          catch (error) { throw error.status ? error : failure(400, 'デザインの形式が正しくありません。'); }
          json(200, await save(value, expected));
          return;
        }
        if (path === '/api/design/images') {
          if (!Object.values(IMAGE_TYPES).includes(type)) throw failure(415, 'PNG・JPEG・WebP・GIFの画像を送ってください。');
          json(200, await addImage(await readBody(req, MAX_IMAGE_BYTES), type));
          return;
        }
        throw failure(404, '見つかりません。');
      }
      res.setHeader('Allow', 'GET, PUT');
      throw failure(405, 'この操作には対応していません。');
    } catch (error) {
      if (error.status) json(error.status, { error: error.message, ...(error.revision ? { revision: error.revision } : {}) });
      else json(503, { error: 'customizationフォルダーを利用できません。通常のフォルダーか、アクセス権を確認してください。' });
    }
  }

  // Event streams never finish on their own; end them so server.close() can.
  function closeEvents() { for (const client of clients) client.end(); clients.clear(); }

  return { handle, load, save, addImage, closeEvents };
}
