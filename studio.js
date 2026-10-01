export const DEFAULT_STUDIO = Object.freeze({
  theme: 'mint', accent: '#ace5cd', title: 'お茶でも飲みながら、', subtitle: 'みんなと、のんびり雑談。',
  fontSize: 20, chatCount: 30, layout: 'right', actorWidth: 42, decoration: true, source: 'space', image: '',
});

export function normalizeStudio(value = {}) {
  const options = { ...DEFAULT_STUDIO };
  if (!value || typeof value !== 'object') return options;
  for (const [key, allowed] of Object.entries({ theme: ['mint', 'rose', 'violet', 'paper'], layout: ['left', 'right'], source: ['space', 'image'] })) {
    if (allowed.includes(value[key])) options[key] = value[key];
  }
  if (typeof value.accent === 'string' && /^#[\da-f]{6}$/i.test(value.accent)) options.accent = value.accent;
  for (const [key, limit] of [['title', 60], ['subtitle', 100]]) {
    if (typeof value[key] === 'string') options[key] = value[key].slice(0, limit);
  }
  if (Number.isInteger(value.fontSize) && value.fontSize >= 16 && value.fontSize <= 28) options.fontSize = value.fontSize;
  if (Number.isInteger(value.chatCount) && value.chatCount >= 1 && value.chatCount <= 100) options.chatCount = value.chatCount;
  if (Number.isInteger(value.actorWidth) && value.actorWidth >= 30 && value.actorWidth <= 60) options.actorWidth = value.actorWidth;
  if (typeof value.decoration === 'boolean') options.decoration = value.decoration;
  // Raster images only: uploaded SVG/HTML must never become executable content.
  if (typeof value.image === 'string' && value.image.length <= 2800000 && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value.image)) options.image = value.image;
  return options;
}

export function readStudio(storage) {
  try { return normalizeStudio(JSON.parse(storage?.getItem('pokome-studio') || '{}')); }
  catch { return normalizeStudio(); }
}

export function readSavedVoices(storage) {
  const result = { twitch: '', kick: '' };
  try {
    const saved = JSON.parse(storage?.getItem('pokome-voices') || '{}');
    for (const platform of Object.keys(result)) {
      if (typeof saved?.[platform] === 'string' && saved[platform].length <= 500) result[platform] = saved[platform];
    }
  } catch { /* Use the system voice when storage is unavailable. */ }
  return result;
}
