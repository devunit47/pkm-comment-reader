import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('tracked text files contain no personal absolute paths', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  // Build the directory name so the detector does not match its own source.
  const directory = String.fromCharCode(85, 115, 101, 114, 115);
  const personalPath = new RegExp(String.raw`[a-z]:[/\\]+${directory}[/\\]+`, 'i');
  const matches = [];
  for (const file of files) {
    let content;
    try {
      content = await readFile(join(root, file));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (content.includes(0)) continue;
    if (personalPath.test(content.toString('utf8'))) matches.push(file);
  }
  assert.deepEqual(matches, [], 'Tracked text files must not contain personal absolute paths');
});
