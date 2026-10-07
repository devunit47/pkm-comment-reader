import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { after } from 'node:test';

const require = createRequire(import.meta.url);
// Optional browser checks work with an installed Playwright, a supplied runtime,
// or the bundled development runtime. No dependency download during tests.
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright',
  join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'),
  '/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch { /* Try another available runtime. */ }
}
export const chromium = playwright?.chromium;
export const executablePath = [process.env.BROWSER_EXECUTABLE, chromium?.executablePath(),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean).find(existsSync);
export const browserAvailable = process.env.SKIP_BROWSER_TESTS !== '1' && !!chromium && !!executablePath;

// Remove private fixtures after individual tests have closed their pages and
// servers; deleting a watched file during a test could trigger another save.
const settingsDirectories = [];
after(() => Promise.all(settingsDirectories.map(directory => rm(directory, { recursive: true, force: true }))));
export async function temporaryDataDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'pokome-settings-browser-'));
  settingsDirectories.push(directory);
  return directory;
}

export async function readSettings(base) {
  return (await (await fetch(`${base}/api/settings`)).json()).settings;
}
export async function saveSetting(base, field, value) {
  const response = await fetch(`${base}/api/settings/${field}`, {
    method: 'PUT', body: JSON.stringify(value),
    headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' },
  });
  if (!response.ok) throw new Error(`saveSetting failed: ${response.status} ${await response.text()}`);
  return (await response.json()).settings;
}
export async function waitForSettings(base, predicate, timeout = 8000) {
  const end = Date.now() + timeout;
  let settings;
  while (Date.now() < end) {
    settings = await readSettings(base);
    if (predicate(settings)) return settings;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`settings did not reach the expected state: ${JSON.stringify(settings)}`);
}

// The applied design lives on the local server (customization/current). These
// helpers seed and read it the same way the app does, through the API.
export async function readDesign(base) {
  return (await (await fetch(`${base}/api/design/current`)).json()).design;
}
export async function saveDesign(base, change) {
  const current = await (await fetch(`${base}/api/design/current`)).json();
  const design = typeof change === 'function' ? change(current.design) : { ...current.design, ...change };
  const response = await fetch(`${base}/api/design/current`, {
    method: 'PUT', body: JSON.stringify(design),
    headers: { 'Content-Type': 'application/json', 'If-Match': current.revision, Origin: base, 'Sec-Fetch-Site': 'same-origin' },
  });
  if (!response.ok) throw new Error(`saveDesign failed: ${response.status} ${await response.text()}`);
  return (await response.json()).design;
}
export async function saveStudio(base, studio) {
  return saveDesign(base, design => ({ ...design, studio: { ...design.studio, ...studio } }));
}
export async function saveTalk(base, { layout, overlays } = {}) {
  return saveDesign(base, design => {
    const entry = design.ratios['16:9'] ?? { layout: null, overlays: { version: 1, items: [], assets: {} } };
    return { ...design, ratios: { ...design.ratios, '16:9': { layout: layout === undefined ? entry.layout : layout, overlays: overlays ?? entry.overlays } } };
  });
}
export async function uploadDesignImage(base, bytes, type = 'image/png') {
  const response = await fetch(`${base}/api/design/images`, { method: 'PUT', body: bytes, headers: { 'Content-Type': type, Origin: base, 'Sec-Fetch-Site': 'same-origin' } });
  if (!response.ok) throw new Error(`upload failed: ${response.status}`);
  return response.json();
}
// Saves from the page are asynchronous; poll the server until it agrees.
export async function waitForDesign(base, predicate, timeout = 8000) {
  const end = Date.now() + timeout;
  let design;
  while (Date.now() < end) {
    design = await readDesign(base);
    if (predicate(design)) return design;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`design did not reach the expected state: ${JSON.stringify({ theme: design?.theme, ratios: design?.ratios, studio: design?.studio }).slice(0, 3000)}`);
}

// The page loads the design from the server before it finishes starting. The
// recovery button is created last, so its presence means the page is ready.
export const appReady = page => page.locator('#appearance-recovery').waitFor({ state: 'attached' });

// The app links Google Fonts; a slow external stylesheet delays its scripts.
// Tests block it so start-up never depends on the network.
export async function blockExternalFonts(page) {
  await page.route('https://fonts.googleapis.com/**', route => route.abort());
  await page.route('https://fonts.gstatic.com/**', route => route.abort());
}

// The design editor shows one target's settings at a time. Narrow docks list
// targets and settings on separate tabs; choosing a target opens its settings.
export async function editorTarget(editor, target) {
  if (await editor.locator('#show-targets').isVisible()) await editor.locator('#show-targets').click();
  await editor.locator('#target-select').selectOption(target);
}
export async function editorThemeCSS(editor) {
  await editorTarget(editor, 'screen');
  if (!await editor.locator('#draft-css').isVisible()) await editor.getByText('詳細：テーマCSS', { exact: true }).click();
}
// Closes the editor; a changed draft is discarded after its confirmation.
export async function closeEditor(editor) {
  await editor.locator('#cancel-design').click();
  if (await editor.locator('#editor-confirm').isVisible()) await editor.locator('#editor-confirm-accept').click();
  await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
}
// Changes the design through the editor and applies it in one write.
export async function applyInEditor(page, steps) {
  const editor = page.locator('#design-preview-editor');
  await page.locator('[data-page="studio"]').click();
  await editor.locator('#open-design-preview').click();
  await editor.locator('#apply-design:not(:disabled)').waitFor();
  await steps(editor);
  await editor.locator('#apply-design').click();
  await editor.locator('#design-dialog').waitFor({ state: 'hidden' });
}
