export const WORKSPACE_KEY = 'pokome-workspace-v1';
export const PANEL_IDS = { home: ['comments', 'now', 'reading'], talk: ['header', 'chat', 'speech', 'actor', 'footer'] };
const bounded = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

// Coordinates and dimensions are percentages of the workspace canvas.
export function normalizeLayout(value, panelIds) {
  if (!value || typeof value !== 'object' || !value.panels || typeof value.panels !== 'object') return null;
  const panels = {};
  for (const id of panelIds) {
    const panel = value.panels[id];
    if (!panel || typeof panel !== 'object') return null;
    const w = bounded(panel.w, 30, 5, 100), h = bounded(panel.h, 30, 5, 100);
    panels[id] = { x: bounded(panel.x, 0, 0, 100 - w), y: bounded(panel.y, 0, 0, 100 - h), w, h, z: Math.round(bounded(panel.z, 1, 0, 99)), hidden: panel.hidden === true };
  }
  return { panels };
}

export function normalizeWorkspace(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) throw new Error('レイアウトの形式またはバージョンが対応していません。');
  const result = { version: 1 };
  for (const key of Object.keys(PANEL_IDS)) {
    result[key] = value[key] == null ? null : normalizeLayout(value[key], PANEL_IDS[key]);
    if (value[key] != null && !result[key]) throw new Error('必要なパネルの配置がありません。');
  }
  // Reclaim the removed user panel's space in older stacked home layouts.
  const legacy = value.home?.panels?.moderation;
  const home = result.home?.panels;
  if (legacy && home) {
    const { now, reading, comments } = home;
    const aligned = Math.abs(now.x - reading.x) < 1 && Math.abs(now.w - reading.w) < 1;
    const stacked = reading.y >= now.y + now.h && comments.x + comments.w <= now.x;
    if (aligned && stacked && !now.hidden && !reading.hidden) {
      const extra = Math.max(0, 100 - reading.y - reading.h);
      now.h += extra;
      reading.y += extra;
    }
  }
  return result;
}
