export const PANEL_IDS = { talk: ['header', 'chat', 'speech', 'actor', 'footer', 'pinned'] };
const bounded = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

// Coordinates and dimensions are percentages of the workspace canvas.
export function normalizeLayout(value, panelIds) {
  if (!value || typeof value !== 'object' || !value.panels || typeof value.panels !== 'object') return null;
  const panels = {};
  for (const id of panelIds) {
    const panel = value.panels[id];
    if (id === 'pinned' && !Object.hasOwn(value.panels, id)) continue;
    if (!panel || typeof panel !== 'object') return null;
    const w = bounded(panel.w, 30, 5, 100), h = bounded(panel.h, 30, 5, 100);
    panels[id] = { x: bounded(panel.x, 0, 0, 100 - w), y: bounded(panel.y, 0, 0, 100 - h), w, h, z: Math.round(bounded(panel.z, 1, 0, 99)), hidden: panel.hidden === true };
  }
  if (panelIds.includes('pinned') && !panels.pinned) {
    const chat = panels.chat;
    if (!chat) return null;
    // Existing layouts gain only this panel; reading never moves saved panels.
    panels.pinned = { x: chat.x, y: chat.y, w: chat.w, h: Math.min(15, chat.h), z: Math.min(99, chat.z + 1), hidden: false };
  }
  return { panels };
}

// The speech panel's CSS minimum height can exceed its saved percentage on a
// short screen. Its top is clamped to stay on screen, and panels that start
// below it (overlapping horizontally) give up the space it grows into, keeping
// their bottom edge, so the minimum never covers them. Saved data is unchanged.
export function talkSpeechStyles(panels, minimum) {
  const s = panels?.speech;
  if (!s) return {};
  const styles = { speech: { top: `min(${s.y}%, max(0px, calc(100% - max(${s.h}%, ${minimum}px))))` } };
  if (s.hidden || !(minimum > 0)) return styles;
  for (const [id, p] of Object.entries(panels)) {
    if (id === 'speech' || p.y < s.y + s.h - 1e-6 || p.x >= s.x + s.w || p.x + p.w <= s.x) continue;
    const top = `max(${p.y}%, calc(${s.y}% + ${minimum}px))`;
    styles[id] = { top, height: `max(0px, calc(${p.y + p.h}% - ${top}))` };
  }
  return styles;
}
