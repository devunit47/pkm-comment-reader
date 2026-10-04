import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeDesign, defaultDesign, defaultTalkLayout } from '../../src/shared/design-model.js';

// Small original raster drawings exercise the same structure as a portrait
// scene: presenter, full-screen backdrop, text overlays and themed chat chips.
const actor = readFileSync(new URL('./presets/actor.png', import.meta.url));
const background = readFileSync(new URL('./presets/background.png', import.meta.url));
const reference = bytes => `images/${createHash('sha256').update(bytes).digest('hex')}.png`;
export const actorRef = reference(actor), backgroundRef = reference(background);
export const fixtureFiles = { [actorRef]: actor, [backgroundRef]: background };
export const fixtureImages = {
  [actorRef]: { type: 'image/png', bytes: actor.length, width: 48, height: 72 },
  [backgroundRef]: { type: 'image/png', bytes: background.length, width: 64, height: 48 },
};

export function fixtureDesign() {
  const design = defaultDesign();
  const overlays = ratio => ({ version: 1, items: [
    { id: 'backdrop', type: 'image', assetId: 'backdrop-asset', x: 0, y: 0, w: 100, h: 100, z: 0 },
    { id: 'title', type: 'text', text: `小さな画面例 ${ratio}`, x: 5, y: 3, w: 85, h: 8, z: 5, color: '#24382e', fontSize: 24 },
  ], assets: { 'backdrop-asset': backgroundRef } });
  return normalizeDesign({ ...design, name: '自作の縦チップ', outputSize: '1080x1920',
    studio: { ...design.studio, image: actorRef, source: 'image', speechImage: backgroundRef, speechStyle: 'image',
      title: '画面例の確認', commentStyle: 'anonymous', commentPanel: 'none', maxVisible: 3, decoration: false },
    theme: `.pokome-workspace .stage-actor { background: none; border: 0; }
.pokome-workspace .actor-caption { display: none; }
.pokome-workspace #stage-chat-list { font-size: 56px; }
.pokome-workspace .stage-comment { background: #fff; border-radius: 40px; padding: 8px 16px; }
.pokome-workspace .pokome-comment__body { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }`,
    ratios: {
      '16:9': { layout: null, overlays: overlays('16:9') },
      '9:16': { layout: defaultTalkLayout('9:16'), overlays: overlays('9:16') },
      '4:3': { layout: null, overlays: overlays('4:3') },
    },
  }, fixtureImages);
}
