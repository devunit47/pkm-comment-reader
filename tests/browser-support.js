import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
