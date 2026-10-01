import { mkdir, readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Only browser assets belong in the public artifact. Never copy the repository.
const assets = ['index.html', 'style.css', 'app.js', 'connections.js', 'chat-state.js', 'speech-options.js', 'studio.js', 'speech-background.svg'];

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
  await writeFile(new URL('index.html', destination), html.replaceAll('data-service="kick"', 'data-service="kick" hidden'));
  await writeFile(new URL('.nojekyll', destination), '');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildPages();
  console.log('Built Twitch-only GitHub Pages assets in dist/');
}
