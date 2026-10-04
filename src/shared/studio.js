export const THEME_ACCENTS = Object.freeze({ mint: '#ace5cd', rose: '#efb4c5', violet: '#c8b4f1', paper: '#527250' });
export const DEFAULT_STUDIO = Object.freeze({
  theme: 'mint', accentMode: 'theme', accent: '#ace5cd', title: 'お茶でも飲みながら、', subtitle: 'みんなと、のんびり雑談。',
  maxVisible: 0, holdSeconds: 0, newestPosition: 'bottom',
  fontSize: 20, commentStyle: 'stacked', layout: 'right', actorWidth: 42, actorAppearance: 'theme', decoration: true, source: 'space', image: '',
  speechTitle: 'いま、届いた声', speechFontSize: 22,
  speechStyle: 'image', speechBackground: '#f3f1dc', speechImage: '', speechTextColor: '#25382f',
  footer: 'ひとつのコメントから、おしゃべりが広がる。',
  // Comment list look. '' and null keep the theme's own value.
  commentPanel: 'theme', commentPanelOpacity: 90, commentTextColor: '', commentAuthorColor: '',
  commentItemBackground: 'theme', commentItemOpacity: 92, commentMaxLines: null,
  commentOutline: 'none', commentOutlineColor: '#000000', commentLineHeight: null, commentGap: null,
  commentDivider: true, commentLabel: true,
});

export const COMMENT_PANELS = Object.freeze(['theme', 'none', 'light', 'dark']);
export const COMMENT_OUTLINES = Object.freeze(['none', 'thin', 'thick']);
export const COMMENT_LINE_HEIGHTS = Object.freeze([1.2, 1.35, 1.5, 1.75, 2]);
export const COMMENT_GAPS = Object.freeze([0, 4, 8, 12, 14, 16, 24]);
export const COMMENT_MAX_LINES = Object.freeze([0, 1, 2, 3, 4, 5]);
const COMMENT_KEYS = ['commentPanel', 'commentPanelOpacity', 'commentItemBackground', 'commentItemOpacity', 'commentMaxLines', 'commentTextColor', 'commentAuthorColor', 'commentOutline', 'commentOutlineColor', 'commentLineHeight', 'commentGap', 'commentDivider', 'commentLabel'];
const themeLook = Object.fromEntries(COMMENT_KEYS.map(key => [key, DEFAULT_STUDIO[key]]));
// Structural presets, named by layout rather than after any streamer's design.
// Each one also fixes the comment format, so returning to a preset shows
// exactly that preset (for example, names reappear after 本文だけ高密度).
export const COMMENT_PRESETS = Object.freeze({
  theme: { label: 'テーマ標準', values: themeLook, commentStyle: DEFAULT_STUDIO.commentStyle },
  outline: { label: '縁取り文字だけ', values: { ...themeLook, commentPanel: 'none', commentTextColor: '#ffffff', commentAuthorColor: '#ffffff', commentOutline: 'thin', commentOutlineColor: '#000000', commentDivider: false, commentLabel: false }, commentStyle: 'stacked' },
  light: { label: '白パネル', values: { ...themeLook, commentPanel: 'light', commentPanelOpacity: 90, commentTextColor: '#1f2a24', commentAuthorColor: '#3b6e58' }, commentStyle: 'stacked' },
  dark: { label: '半透明の暗パネル', values: { ...themeLook, commentPanel: 'dark', commentPanelOpacity: 35, commentTextColor: '#ffffff', commentAuthorColor: '#ffffff', commentOutline: 'thin', commentOutlineColor: '#000000' }, commentStyle: 'stacked' },
  dense: { label: '本文だけ高密度', values: { ...themeLook, commentPanel: 'none', commentLineHeight: 1.35, commentGap: 4, commentDivider: false, commentLabel: false }, commentStyle: 'anonymous' },
  chips: { label: '丸いチップ（本文2行）', values: { ...themeLook, commentPanel: 'none', commentItemBackground: 'light', commentItemOpacity: 92, commentMaxLines: 2, commentTextColor: '#24382e', commentLineHeight: 1.35, commentGap: 14, commentDivider: false, commentLabel: false }, commentStyle: 'anonymous' },
});

export function applyCommentPreset(studio, name, options) {
  const preset = COMMENT_PRESETS[name];
  if (!preset) return normalizeStudio(studio, options);
  return normalizeStudio({ ...studio, ...preset.values, commentStyle: preset.commentStyle }, options);
}

// The preset whose values the studio currently matches, or '' for a custom mix.
export function matchCommentPreset(studio) {
  return Object.keys(COMMENT_PRESETS).find(name => {
    const preset = COMMENT_PRESETS[name];
    return COMMENT_KEYS.every(key => studio[key] === preset.values[key]) && studio.commentStyle === preset.commentStyle;
  }) || '';
}

const dataImage = value => value.length <= 2800000 && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value);

// `image` decides which actor/speech images are kept. The default accepts raster
// data URLs; design.json passes a check for validated file references.
export function normalizeStudio(value = {}, { image = dataImage } = {}) {
  const options = { ...DEFAULT_STUDIO };
  if (!value || typeof value !== 'object') return options;
  if (['stacked', 'anonymous', 'inline', 'compact'].includes(value.commentStyle)) options.commentStyle = value.commentStyle;
  for (const [key, allowed] of Object.entries({ theme: ['mint', 'rose', 'violet', 'paper'], layout: ['left', 'right'], source: ['space', 'image'], speechStyle: ['panel', 'bubble', 'image'], actorAppearance: ['theme', 'none'] })) {
    if (allowed.includes(value[key])) options[key] = value[key];
  }
  if (typeof value.accent === 'string' && /^#[\da-f]{6}$/i.test(value.accent)) options.accent = value.accent;
  options.accentMode = ['theme', 'custom'].includes(value.accentMode) ? value.accentMode
    : options.accent.toLowerCase() === THEME_ACCENTS[options.theme] ? 'theme' : 'custom';
  if (typeof value.speechBackground === 'string' && /^#[\da-f]{6}$/i.test(value.speechBackground)) options.speechBackground = value.speechBackground;
  if (typeof value.speechTextColor === 'string' && /^#[\da-f]{6}$/i.test(value.speechTextColor)) options.speechTextColor = value.speechTextColor;
  for (const [key, limit] of [['title', 60], ['subtitle', 100], ['speechTitle', 40], ['footer', 100]]) {
    if (typeof value[key] === 'string') options[key] = value[key].slice(0, limit);
  }
  if (Number.isInteger(value.fontSize) && value.fontSize >= 16 && value.fontSize <= 64) options.fontSize = value.fontSize;
  if (Number.isInteger(value.speechFontSize) && value.speechFontSize >= 16 && value.speechFontSize <= 32) options.speechFontSize = value.speechFontSize;
  if (Number.isInteger(value.maxVisible) && value.maxVisible >= 0 && value.maxVisible <= 30) options.maxVisible = value.maxVisible;
  if ([0, 5, 15, 30].includes(value.holdSeconds)) options.holdSeconds = value.holdSeconds;
  if (['bottom', 'top'].includes(value.newestPosition)) options.newestPosition = value.newestPosition;
  if (Number.isInteger(value.actorWidth) && value.actorWidth >= 30 && value.actorWidth <= 60) options.actorWidth = value.actorWidth;
  if (typeof value.decoration === 'boolean') options.decoration = value.decoration;
  if (COMMENT_PANELS.includes(value.commentPanel)) options.commentPanel = value.commentPanel;
  if (COMMENT_PANELS.includes(value.commentItemBackground)) options.commentItemBackground = value.commentItemBackground;
  if (Number.isInteger(value.commentItemOpacity) && value.commentItemOpacity >= 0 && value.commentItemOpacity <= 100) options.commentItemOpacity = value.commentItemOpacity;
  if (COMMENT_MAX_LINES.includes(value.commentMaxLines)) options.commentMaxLines = value.commentMaxLines;
  if (COMMENT_OUTLINES.includes(value.commentOutline)) options.commentOutline = value.commentOutline;
  if (Number.isInteger(value.commentPanelOpacity) && value.commentPanelOpacity >= 0 && value.commentPanelOpacity <= 100) options.commentPanelOpacity = value.commentPanelOpacity;
  for (const key of ['commentTextColor', 'commentAuthorColor', 'commentOutlineColor']) {
    if (typeof value[key] === 'string' && /^#[\da-f]{6}$/i.test(value[key])) options[key] = value[key].toLowerCase();
  }
  if (COMMENT_LINE_HEIGHTS.includes(value.commentLineHeight)) options.commentLineHeight = value.commentLineHeight;
  if (COMMENT_GAPS.includes(value.commentGap)) options.commentGap = value.commentGap;
  for (const key of ['commentDivider', 'commentLabel']) if (typeof value[key] === 'boolean') options[key] = value[key];
  // Raster images only: uploaded SVG/HTML must never become executable content.
  for (const key of ['image', 'speechImage']) if (typeof value[key] === 'string' && value[key] && image(value[key])) options[key] = value[key];
  return options;
}

// Comment history is an operating setting, not part of a shareable design.
export const HISTORY_LIMIT_KEY = 'pokome-history-limit';
export const DEFAULT_HISTORY_LIMIT = 300;
export function normalizeHistoryLimit(value) {
  return Number.isInteger(value) && value >= 1 && value <= 300 ? value : DEFAULT_HISTORY_LIMIT;
}
export function readHistoryLimit(storage) {
  try { return normalizeHistoryLimit(JSON.parse(storage?.getItem(HISTORY_LIMIT_KEY) ?? 'null')); }
  catch { return DEFAULT_HISTORY_LIMIT; }
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
