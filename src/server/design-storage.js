import { constants } from 'node:fs';
import { lstat, open, readdir, rename, rmdir, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { safeDirectory, imageSignatureMatches, ensureCustomizationDirectories } from './local-customization.js';
import { rasterDimensions } from '../shared/overlay-model.js';
import { MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_THEME_CSS_BYTES, IMAGE_TYPES, RATIOS, imageExtension, normalizeDesign, defaultDesign, designImageRefs, normalizePresetName, validPresetId, validImageRef } from '../shared/design-model.js';

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
const directoryChanged = () => Object.assign(failure(422, '操作中にフォルダーが変更されました。通常のフォルダーか確認して一覧を更新してください。'), { code: 'EDIRECTORYCHANGED' });

// Checking just the leaf can miss a replaced ancestor: its ordinary child
// files would then belong to another directory tree. Keep the whole chain's
// identity and recheck it before each path-based mutation and retry.
async function guardDirectory(root, directory) {
  root = resolve(root); directory = resolve(directory);
  const remainder = relative(root, directory);
  if (remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) throw directoryChanged();
  const paths = [root];
  for (const part of remainder.split(sep).filter(Boolean)) paths.push(join(paths.at(-1), part));
  const snapshots = [];
  for (const path of paths) snapshots.push(await safeDirectory(path));
  const check = async () => {
    for (let index = 0; index < paths.length; index++) {
      let actual;
      try { actual = await safeDirectory(paths[index]); } catch { throw directoryChanged(); }
      const before = snapshots[index];
      if (before.real !== actual.real || before.info.dev !== actual.info.dev || before.info.ino !== actual.info.ino) throw directoryChanged();
    }
  };
  await check();
  return check;
}

async function touchRegularFile(path, expected, date, check) {
  return retryTransient(async () => {
    await check();
    const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const opened = await handle.stat(), actual = await lstat(path);
      if (!opened.isFile() || actual.isSymbolicLink() || opened.dev !== expected.dev || opened.ino !== expected.ino ||
          actual.dev !== opened.dev || actual.ino !== opened.ino) throw changed();
      await check();
      await handle.utimes(date, date);
    } finally { await handle.close(); }
  });
}

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
    const after = await lstat(path);
    if (!after.isFile() || after.isSymbolicLink() || after.dev !== opened.dev || after.ino !== opened.ino) throw changed();
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

async function atomicWrite(path, content, root = dirname(path), checkAncestor = async () => {}) {
  await checkAncestor();
  const checkLocal = await guardDirectory(root, dirname(path));
  const check = async () => { await checkAncestor(); await checkLocal(); };
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    await check();
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0));
    await check();
    await handle.writeFile(content);
    await handle.close(); handle = null;
    await renameWithRetry(temporary, path, { renameFile: async (from, to) => { await check(); return rename(from, to); } });
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await check().then(() => unlink(temporary)).catch(() => {});
    throw error;
  }
}

// Generated transaction folders are removed only after checking every entry;
// recursive filesystem removal must never follow a junction or a symlink.
async function removeDirectory(path, root = dirname(path), checkAncestor = async () => {}) {
  await checkAncestor();
  const checkLocal = await guardDirectory(root, path);
  const check = async () => { await checkAncestor(); await checkLocal(); };
  const entries = await readdir(path, { withFileTypes: true });
  await check();
  for (const entry of entries) {
    const child = join(path, entry.name), info = await lstat(child);
    await check();
    if (info.isSymbolicLink()) throw failure(422, 'リンクを含むフォルダーは操作できません。');
    if (info.isDirectory()) await removeDirectory(child, root, check);
    else if (info.isFile()) await retryTransient(async () => { await check(); return unlink(child); });
    else throw failure(422, '通常のファイルとフォルダーだけを使用してください。');
  }
  await retryTransient(async () => { await check(); return rmdir(path); });
}

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// The previous folder is kept until the complete staged design has replaced
// it. A crash between renames is recovered before the next preset read.
export async function replacePresetDirectory(target, staged, backup, { renameDirectory = renameWithRetry, root = dirname(target) } = {}) {
  const check = await guardDirectory(root, dirname(target));
  const guardedRename = (from, to) => renameDirectory(from, to, { renameFile: async (from, to) => { await check(); return rename(from, to); } });
  await safeDirectory(target);
  await safeDirectory(staged);
  if (await exists(backup)) throw failure(409, '前の保存処理を完了できません。一覧を更新してください。');
  await check(); await guardedRename(target, backup);
  try { await check(); await safeDirectory(staged); await guardedRename(staged, target); }
  catch (error) {
    await check();
    if (!await exists(target)) { await safeDirectory(backup); await renameWithRetry(backup, target, { renameFile: async (from, to) => { await check(); return rename(from, to); } }); }
    throw error;
  }
  // A cleanup failure leaves the backup for the recovery pass; the new design
  // is already committed and must not be reported as an unsuccessful save.
  await removeDirectory(backup, root).catch(() => {});
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
  return localHost(host) && req.headers.origin === `http://${host}` && site === 'same-origin';
}

export function createDesignStorage(root) {
  const current = join(root, 'current'), images = join(current, 'images'), designPath = join(current, 'design.json');
  const presets = join(root, 'presets');
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

  async function cleanup(design, directory = images) {
    const used = new Set([...designImageRefs(design)].map(ref => ref.slice('images/'.length)));
    const now = Date.now();
    const check = await guardDirectory(root, directory);
    const entries = await readdir(directory, { withFileTypes: true });
    await check();
    for (const entry of entries) {
      if (!IMAGE_NAME.test(entry.name) || used.has(entry.name) || !entry.isFile()) continue;
      try {
        const info = await lstat(join(directory, entry.name));
        await check();
        if (!info.isSymbolicLink() && info.isFile() && now - info.mtimeMs > UNREFERENCED_IMAGE_GRACE_MS) await retryTransient(async () => {
          await check(); return unlink(join(directory, entry.name));
        });
      } catch (error) {
        if (error.code === 'EDIRECTORYCHANGED') throw error;
        // A file removed meanwhile needs no cleanup.
      }
    }
  }

  async function protectReleasedImages(before, after, directory = images) {
    const retained = designImageRefs(after), now = new Date();
    const check = await guardDirectory(root, directory);
    for (const ref of designImageRefs(before)) {
      if (retained.has(ref)) continue;
      const path = join(directory, ref.slice(7));
      const info = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      await check();
      if (info?.isFile() && !info.isSymbolicLink()) await touchRegularFile(path, info, now, check);
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
      await protectReleasedImages(before.design, design);
      await atomicWrite(designPath, JSON.stringify(design, null, 2), root);
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
      const check = await guardDirectory(root, images);
      const path = join(images, name);
      try {
        const existing = await lstat(path);
        if (!existing.isFile() || existing.isSymbolicLink()) throw failure(422, '画像を保存できません。');
        // Refresh the time so the grace period protects a re-uploaded image.
        const now = new Date(); await touchRegularFile(path, existing, now, check);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await atomicWrite(path, bytes, root, check);
      }
      return { ref: `images/${name}`, ...info };
    });
  }

  const presetPath = id => {
    if (!validPresetId(id)) throw failure(400, 'プリセットのidが正しくありません。');
    return join(presets, id);
  };
  const presetName = value => {
    try { return normalizePresetName(value); }
    catch (error) { throw failure(400, error.message); }
  };
  const backupName = id => `.${id}.backup`;
  const transactionId = '[a-z0-9-]{1,64}';
  const backupPattern = new RegExp(`^\\.(${transactionId})\\.backup$`);
  const stagePattern = new RegExp(`^\\.(${transactionId})\\.stage-[0-9a-f-]{36}$`);
  const deletedPattern = /^\.deleted-[0-9a-f-]{36}$/;

  async function renamePresetFolder(from, to) {
    const check = await guardDirectory(root, presets);
    await safeDirectory(from);
    return renameWithRetry(from, to, { renameFile: async (from, to) => { await check(); await safeDirectory(from); return rename(from, to); } });
  }

  async function presetDirectories() {
    await directories();
    await safeDirectory(presets, true);
    const check = await guardDirectory(root, presets);
    // Reads share the save queue, so they never see the gap between renames.
    // Only our generated names are recovered or removed; unrelated hidden
    // folders belong to the user and remain untouched.
    const entries = await readdir(presets, { withFileTypes: true });
    await check();
    for (const entry of entries) {
      const match = backupPattern.exec(entry.name);
      if (!match || !validPresetId(match[1])) continue;
      const backup = join(presets, entry.name), target = presetPath(match[1]);
      await safeDirectory(backup);
      await check();
      if (!await exists(target)) await renamePresetFolder(backup, target);
      else { await safeDirectory(target); await removeDirectory(backup, root); }
    }
    for (const entry of entries) {
      const match = stagePattern.exec(entry.name);
      if (match && validPresetId(match[1])) { await check(); await removeDirectory(join(presets, entry.name), root); }
    }
    await cleanupDeleted();
  }

  async function cleanupDeleted() {
    const check = await guardDirectory(root, presets);
    const entries = await readdir(presets, { withFileTypes: true });
    await check();
    for (const entry of entries) {
      if (!deletedPattern.test(entry.name)) continue;
      await removeDirectory(join(presets, entry.name), root, check);
    }
  }

  async function directorySnapshot(folder) {
    return Promise.all([root, presets, folder, join(folder, 'images')].map(path => safeDirectory(path)));
  }
  const sameDirectories = (before, after) => before.every((value, index) => value.real === after[index].real &&
    value.info.dev === after[index].info.dev && value.info.ino === after[index].info.ino);

  async function presetCatalog(folder) {
    const list = {}, imageFolder = join(folder, 'images');
    for (const entry of await readdir(imageFolder, { withFileTypes: true })) {
      const match = IMAGE_NAME.exec(entry.name), path = join(imageFolder, entry.name);
      if (!match) throw failure(422, '画像名または形式が対応していません。PNG・JPEG・WebP・GIFのハッシュ名を使用してください。');
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw failure(422, '画像にリンクや通常のファイルでないものが含まれています。');
      if (info.size > MAX_IMAGE_BYTES) throw failure(422, '20MBを超える画像が含まれています。');
      const { bytes } = await readStable(path, MAX_IMAGE_BYTES), inspected = inspectImageBytes(bytes, match[2]);
      if (!inspected) throw failure(422, '画像の形式または画素数が正しくありません。1600万画素以内の画像を使用してください。');
      if (createHash('sha256').update(bytes).digest('hex') !== match[1]) throw failure(422, '画像の内容とハッシュ名が一致しません。');
      list[`images/${entry.name}`] = inspected;
    }
    return list;
  }

  function requireImageReferences(value, list) {
    const record = value => value && typeof value === 'object' && !Array.isArray(value);
    if ((value.studio != null && !record(value.studio)) || (value.ratios != null && !record(value.ratios)) ||
        (value.theme != null && (typeof value.theme !== 'string' || Buffer.byteLength(value.theme, 'utf8') > MAX_THEME_CSS_BYTES))) {
      throw failure(422, 'design.jsonのデザイン設定またはテーマCSSの形式・サイズが正しくありません。');
    }
    const candidates = [value.studio?.image, value.studio?.speechImage];
    for (const ratio of RATIOS) {
      const entry = value.ratios?.[ratio];
      if (entry == null) continue;
      if (!record(entry)) throw failure(422, 'design.jsonの比率ごとの設定が正しくありません。');
      const overlays = entry.overlays;
      if (overlays == null) continue;
      if (!record(overlays) || overlays.version !== 1 || !Array.isArray(overlays.items) || !record(overlays.assets)) {
        throw failure(422, 'design.jsonの追加の文字と画像の形式が正しくありません。');
      }
      candidates.push(...Object.values(overlays.assets));
      for (const item of overlays.items) {
        if (item?.type === 'image' && !Object.hasOwn(overlays.assets, item.assetId)) throw failure(422, '追加画像の参照先がdesign.jsonにありません。');
      }
    }
    for (const ref of candidates) {
      if (ref === undefined || ref === '') continue;
      if (!validImageRef(ref) || !Object.hasOwn(list, ref)) throw failure(422, 'デザインが参照する画像を読み込めません。画像名・形式・サイズを確認してください。');
    }
  }

  async function loadPreset(id) {
    const folder = presetPath(id);
    if (!await exists(folder)) throw failure(404, 'プリセットが見つかりません。一覧を更新してください。');
    let before;
    try { before = await directorySnapshot(folder); }
    catch { throw failure(422, '通常のフォルダーとimagesフォルダーを使用してください。リンク・ジャンクションは使用できません。'); }
    const list = await presetCatalog(folder);
    let raw, design, updatedAt;
    try {
      const file = await readStable(join(folder, 'design.json'), MAX_DESIGN_JSON_BYTES);
      raw = file.bytes; updatedAt = new Date(file.mtimeMs).toISOString();
      const value = JSON.parse(raw.toString('utf8'));
      if (!value || typeof value !== 'object') throw failure(422, 'design.jsonの形式が正しくありません。');
      const name = presetName(value.name);
      requireImageReferences(value, list);
      design = normalizeDesign({ ...value, name }, list);
    } catch (error) {
      if (error.status === 422) throw error;
      throw failure(422, `design.jsonを読み込めません。${error.status === 400 ? error.message : '形式・バージョン・サイズを確認してください。'}`);
    }
    if (!sameDirectories(before, await directorySnapshot(folder))) throw failure(422, '読み込み中にフォルダーが変更されました。一覧を更新してください。');
    // Images affect what a preview displays too, so their hashes are part of
    // its revision instead of trusting the design.json timestamp alone.
    const revision = createHash('sha256').update(raw).update([...designImageRefs(design)].sort().join('\n')).digest('hex').slice(0, 32);
    return { id, design, images: list, revision, updatedAt };
  }

  async function listPresets() {
    return exclusive(async () => {
      await presetDirectories();
      const list = [];
      for (const entry of await readdir(presets, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;
        const item = { id: entry.name, name: entry.name, updatedAt: null, revision: null };
        try {
          const value = await loadPreset(entry.name);
          Object.assign(item, { name: value.design.name, updatedAt: value.updatedAt, revision: value.revision });
          await cleanup(value.design, join(presetPath(entry.name), 'images'));
        } catch (error) { item.error = error.status ? error.message : 'プリセットを読み込めません。ファイルとアクセス権を確認してください。'; }
        list.push(item);
      }
      await cleanup((await load()).design);
      list.sort((a, b) => a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id));
      return { presets: list, directory: presets };
    });
  }

  async function getPreset(id) {
    return exclusive(async () => { await presetDirectories(); return loadPreset(id); });
  }

  async function copyImage(ref, fromFolder, toFolder, preserveTime = false) {
    const name = ref.slice(7), match = IMAGE_NAME.exec(name);
    if (!match) throw failure(422, '画像の参照が正しくありません。');
    const checkSource = await guardDirectory(root, fromFolder), checkTarget = await guardDirectory(root, toFolder);
    const check = async () => { await checkSource(); await checkTarget(); };
    const file = await readStable(join(fromFolder, name), MAX_IMAGE_BYTES);
    await check();
    if (!inspectImageBytes(file.bytes, match[2]) || createHash('sha256').update(file.bytes).digest('hex') !== match[1]) throw failure(422, 'コピーする画像の内容を確認できません。');
    const target = join(toFolder, name);
    // Replacing a destination symlink with a regular file is safe, but a
    // pre-existing link is an invalid customization folder and is rejected.
    if (await exists(target)) {
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) throw failure(422, '画像にリンクは使用できません。');
    }
    await atomicWrite(target, file.bytes, root, check);
    if (preserveTime) {
      const date = new Date(file.mtimeMs), info = await lstat(target);
      await touchRegularFile(target, info, date, check);
    }
  }

  async function createStagedPreset(id, design, sourceImages, previous = null) {
    const staged = join(presets, `.${id}.stage-${randomUUID()}`), stagedImages = join(staged, 'images');
    await safeDirectory(staged, true);
    try {
      await safeDirectory(stagedImages, true);
      // Keep formerly used images through their grace period even when the
      // replacement no longer references them.
      if (previous) for (const ref of Object.keys(previous.images)) await copyImage(ref, join(presetPath(id), 'images'), stagedImages, true);
      for (const ref of designImageRefs(design)) await copyImage(ref, sourceImages, stagedImages);
      if (previous) await protectReleasedImages(previous.design, design, stagedImages);
      await cleanup(design, stagedImages);
      const list = await presetCatalog(staged);
      const normalized = normalizeDesign(structuredClone(design), list);
      await atomicWrite(join(staged, 'design.json'), JSON.stringify(normalized, null, 2), root);
      return staged;
    } catch (error) { await removeDirectory(staged, root).catch(() => {}); throw error; }
  }

  function checkRevision(expected, value, currentDesign = false) {
    if (typeof expected !== 'string' || !expected) throw failure(428, '更新前の版を指定してください。');
    if (expected !== value.revision) throw Object.assign(failure(409, currentDesign
      ? '別の画面で見た目が変更されました。最新の内容を読み込み直してください。'
      : 'プリセットが変更されました。一覧を更新して読み込み直してください。'), { revision: value.revision });
  }

  async function newPreset(name, currentRevision) {
    return exclusive(async () => {
      await presetDirectories();
      name = presetName(name);
      const value = await load(); checkRevision(currentRevision, value, true);
      const id = randomUUID(), staged = await createStagedPreset(id, { ...structuredClone(value.design), name }, images);
      try {
        if (await exists(presetPath(id))) throw failure(409, 'プリセットのidが重なりました。もう一度保存してください。');
        await renamePresetFolder(staged, presetPath(id));
      }
      catch (error) { await removeDirectory(staged, root).catch(() => {}); throw error; }
      await cleanup(value.design);
      return loadPreset(id);
    });
  }

  async function updatePreset(id, update, expected) {
    return exclusive(async () => {
      await presetDirectories();
      const before = await loadPreset(id); checkRevision(expected, before);
      let design, sourceImages;
      if (update.overwrite === true) {
        const value = await load(); checkRevision(update.currentRevision, value, true);
        design = { ...structuredClone(value.design), name: before.design.name }; sourceImages = images;
      } else if (Object.hasOwn(update, 'name')) {
        design = { ...structuredClone(before.design), name: presetName(update.name) }; sourceImages = join(presetPath(id), 'images');
      } else throw failure(400, '上書き保存または名前の変更を指定してください。');
      const staged = await createStagedPreset(id, design, sourceImages, before);
      try { await replacePresetDirectory(presetPath(id), staged, join(presets, backupName(id)), { root }); }
      catch (error) { await removeDirectory(staged, root).catch(() => {}); throw error; }
      await cleanup((await load()).design);
      return loadPreset(id);
    });
  }

  async function deletePreset(id, expected) {
    return exclusive(async () => {
      await presetDirectories();
      const value = await loadPreset(id); checkRevision(expected, value);
      const deleted = join(presets, `.deleted-${randomUUID()}`);
      await renamePresetFolder(presetPath(id), deleted);
      await removeDirectory(deleted, root);
      await cleanup((await load()).design);
      return { deleted: id };
    });
  }

  async function applyPreset(id, presetRevision, currentRevision) {
    return exclusive(async () => {
      await presetDirectories();
      const before = await load(); checkRevision(currentRevision, before, true);
      const value = await loadPreset(id); checkRevision(presetRevision, value);
      for (const ref of designImageRefs(value.design)) await copyImage(ref, join(presetPath(id), 'images'), images);
      const list = await catalog(), design = normalizeDesign(structuredClone(value.design), list);
      await protectReleasedImages(before.design, design);
      await atomicWrite(designPath, JSON.stringify(design, null, 2), root);
      const after = await load();
      await cleanup(after.design);
      broadcast(after.revision);
      return after;
    });
  }

  async function openFolder(id) {
    return exclusive(async () => {
      await presetDirectories();
      const folder = id === undefined ? presets : presetPath(id);
      try { await safeDirectory(folder); }
      catch { throw failure(422, '通常のプリセットフォルダーだけを開けます。'); }
      const check = await guardDirectory(root, folder);
      if (process.platform !== 'win32') return { directory: folder, opened: false };
      await check();
      await new Promise((resolve, reject) => {
        const child = spawn('explorer.exe', [folder], { shell: false, windowsHide: true, stdio: 'ignore' });
        child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
      });
      return { directory: folder, opened: true };
    });
  }

  async function sendPresetImage(res, id, name) {
    const match = IMAGE_NAME.exec(name);
    if (!match) throw failure(404, '画像が見つかりません。');
    const imageFolder = join(presetPath(id), 'images');
    let bytes;
    try {
      // Content-addressed reads need only one file. Recheck its parent chain
      // after reading, so they can run outside the save queue without following links.
      const check = await guardDirectory(root, imageFolder);
      ({ bytes } = await readStable(join(imageFolder, name), MAX_IMAGE_BYTES));
      await check();
    } catch (error) {
      if (error.code === 'ENOENT') throw failure(404, '画像が見つかりません。');
      throw error;
    }
    if (!inspectImageBytes(bytes, match[2]) || createHash('sha256').update(bytes).digest('hex') !== match[1]) throw failure(404, '画像が見つかりません。');
    res.writeHead(200, { 'Content-Type': IMAGE_TYPES[match[2]], 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.end(bytes);
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
    const parseJSON = async () => {
      const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') throw failure(415, 'JSONで送ってください。');
      let value;
      try { value = JSON.parse((await readBody(req, MAX_DESIGN_JSON_BYTES)).toString('utf8')); }
      catch (error) { throw error.status ? error : failure(400, 'データの形式が正しくありません。'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure(400, 'データの形式が正しくありません。');
      return value;
    };
    const decodeId = value => {
      let id;
      try { id = decodeURIComponent(value); } catch { throw failure(400, 'プリセットのidが正しくありません。'); }
      presetPath(id);
      return id;
    };
    try {
      if (req.method === 'GET') {
        if (!readAllowed(req)) throw failure(403, 'このアプリから接続してください。');
        if (path === '/api/design/current') { json(200, await load()); return; }
        if (path === '/api/design/events') { events(req, res); return; }
        if (path === '/api/design/presets') { json(200, await listPresets()); return; }
        const preset = /^\/api\/design\/presets\/([^/]+)$/.exec(path);
        if (preset) { json(200, await getPreset(decodeId(preset[1]))); return; }
        const presetImage = /^\/api\/design\/presets\/([^/]+)\/images\/([^/]+)$/.exec(path);
        if (presetImage) { await sendPresetImage(res, decodeId(presetImage[1]), presetImage[2]); return; }
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
          const value = await parseJSON();
          json(200, Object.hasOwn(value, 'presetId')
            ? await applyPreset(value.presetId, value.presetRevision, expected)
            : await save(value, expected));
          return;
        }
        if (path === '/api/design/images') {
          if (!Object.values(IMAGE_TYPES).includes(type)) throw failure(415, 'PNG・JPEG・WebP・GIFの画像を送ってください。');
          json(200, await addImage(await readBody(req, MAX_IMAGE_BYTES), type));
          return;
        }
        const preset = /^\/api\/design\/presets\/([^/]+)$/.exec(path);
        if (preset) { json(200, await updatePreset(decodeId(preset[1]), await parseJSON(), req.headers['if-match'])); return; }
        throw failure(404, '見つかりません。');
      }
      if (req.method === 'POST') {
        if (!writeAllowed(req)) throw failure(403, 'このアプリから操作してください。');
        if (path === '/api/design/presets') {
          const value = await parseJSON(); json(201, await newPreset(value.name, value.currentRevision)); return;
        }
        if (path === '/api/design/open-folder') {
          const value = await parseJSON(); json(200, await openFolder(value.id)); return;
        }
        throw failure(404, '見つかりません。');
      }
      if (req.method === 'DELETE') {
        const preset = /^\/api\/design\/presets\/([^/]+)$/.exec(path);
        if (preset) {
          if (!writeAllowed(req)) throw failure(403, 'このアプリから操作してください。');
          await parseJSON(); json(200, await deletePreset(decodeId(preset[1]), req.headers['if-match'])); return;
        }
      }
      res.setHeader('Allow', 'GET, PUT, POST, DELETE');
      throw failure(405, 'この操作には対応していません。');
    } catch (error) {
      if (error.status) json(error.status, { error: error.message, ...(error.revision ? { revision: error.revision } : {}) });
      else json(503, { error: 'customizationフォルダーを利用できません。通常のフォルダーか、アクセス権を確認してください。' });
    }
  }

  // Event streams never finish on their own; end them so server.close() can.
  function closeEvents() { for (const client of clients) client.end(); clients.clear(); }

  return { handle, load, save, addImage, listPresets, getPreset, newPreset, updatePreset, deletePreset, applyPreset, closeEvents };
}
