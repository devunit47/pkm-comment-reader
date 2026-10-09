import { PANEL_IDS, normalizeLayout } from './workspace-model.js';
import { defaultActorImage, defaultTalkLayout, talkLayout, talkOverlays, talkActorImage, withTalk } from './design-model.js';

const orderZ = value => Number.isFinite(value) ? Math.max(0, Math.min(99, Math.round(value))) : 1;

// Reserve tie slots for six panels and at most twenty overlays.
export const canvasZIndex = (z, index) => orderZ(z) * 32 + index;

// Stable ties match the shared stage DOM: fixed panels, then overlay array order.
export function canvasOrder(layout, overlays) {
  return [
    ...PANEL_IDS.talk.map(id => ({ kind: 'panel', id, z: orderZ(layout ? layout.panels[id]?.z : 0) })),
    ...(overlays?.items ?? []).map(item => ({ kind: 'overlay', id: item.id, z: orderZ(item.z) })),
  ].sort((a, b) => a.z - b.z);
}

export function moveCanvasTarget(layout, overlays, target, direction) {
  const next = structuredClone({ layout, overlays });
  const order = canvasOrder(layout, overlays);
  const index = order.findIndex(item => item.kind === target.kind && item.id === target.id);
  const neighbor = index + (direction === 'forward' ? 1 : -1);
  if (!layout || index < 0 || neighbor < 0 || neighbor >= order.length) return next;
  const setZ = (item, z) => {
    const value = item.kind === 'panel' ? next.layout.panels[item.id] : next.overlays.items.find(overlay => overlay.id === item.id);
    value.z = z;
  };
  const a = order[index], b = order[neighbor];
  // Swapping duplicate values can jump past more than one neighbor.
  if (order.filter(item => item.z === a.z).length > 1 || order.filter(item => item.z === b.z).length > 1) {
    [order[index], order[neighbor]] = [b, a];
    order.forEach((item, z) => setZ(item, z));
  } else { setZ(a, b.z); setZ(b, a.z); }
  return next;
}

// Rectangles share the same coordinate space, including any preview scaling.
export function layoutFromRects(stageRect, panelRects) {
  if (![stageRect?.left, stageRect?.top, stageRect?.width, stageRect?.height].every(Number.isFinite) || stageRect.width <= 0 || stageRect.height <= 0) return null;
  const panels = {};
  for (const id of PANEL_IDS.talk) {
    const rect = panelRects[id];
    if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) return null;
    panels[id] = {
      x: (rect.left - stageRect.left) / stageRect.width * 100,
      y: (rect.top - stageRect.top) / stageRect.height * 100,
      w: rect.width / stageRect.width * 100, h: rect.height / stageRect.height * 100,
      z: 0, hidden: false,
    };
  }
  return normalizeLayout({ panels }, PANEL_IDS.talk);
}

export function copyTalkRatio(design, source, target) {
  const sourceLayout = talkLayout(design, source);
  return withTalk(design, target, {
    layout: sourceLayout ?? talkLayout(design, target),
    overlays: talkOverlays(design, source), actorImage: talkActorImage(design, source),
  });
}

export function resetTalkRatio(design, ratio) {
  return withTalk(design, ratio, { layout: defaultTalkLayout(ratio), actorImage: defaultActorImage() });
}
