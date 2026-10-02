import { mkdir, readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

// Only browser assets belong in the public artifact. Never copy the repository.
const assets = ['index.html', 'style.css', 'app.js', 'connections.js', 'chat-state.js', 'speech-options.js', 'speech-engine.js', 'studio.js', 'workspace.js', 'workspace-model.js', 'theme.js', 'settings-backup.js', 'speech-background.svg'];

export async function buildPages(destination = new URL('./dist/', import.meta.url)) {
  await mkdir(destination, { recursive: true });
  const allowed = new Set([...assets, 'app-config.js', '.nojekyll']);
  const unexpected = (await readdir(destination)).filter(file => !allowed.has(file));
  if (unexpected.length) throw new Error(`Public output contains unexpected files: ${unexpected.join(', ')}. Use an empty output directory.`);
  for (const file of assets) {
    await copyFile(new URL(file, import.meta.url), new URL(file, destination));
  }
  await writeFile(new URL('app-config.js', destination),
    "export const enabledPlatforms = Object.freeze(['twitch']);\nexport const publication = 'pages';\n");
  // Hide unavailable controls before JavaScript loads as well.
  const html = await readFile(new URL('index.html', destination), 'utf8');
  await writeFile(new URL('index.html', destination), html.replaceAll('data-service="kick"', 'data-service="kick" hidden').replace('id="local-speech-controls"', 'id="local-speech-controls" hidden').replaceAll('data-local-only', 'data-local-only hidden'));
  // Version the entire module graph together: HTML and cached modules must agree.
  const publicFiles = [...assets, 'app-config.js'];
  const contents = await Promise.all(publicFiles.map(file => readFile(new URL(file, destination), 'utf8')));
  const version = createHash('sha256').update(contents.join('\n')).digest('hex').slice(0, 16);
  for (let index = 0; index < publicFiles.length; index++) {
    const file = publicFiles[index];
    if (!file.endsWith('.js') && file !== 'index.html') continue;
    const versioned = contents[index].replace(/(["'])(\.\/[^"'?#]+\.(?:js|css|svg))\1/g,
      (_, quote, path) => `${quote}${path}?v=${version}${quote}`);
    await writeFile(new URL(file, destination), versioned);
  }
  await writeFile(new URL('.nojekyll', destination), '');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildPages();
  console.log('Built Twitch-only GitHub Pages assets in dist/');
}
