import { talkSpeechStyles } from '../shared/workspace-model.js';
import { nearestRatio, talkLayout } from '../shared/design-model.js';
import { applyTalkLayout } from './stage-appearance.js';
import { OUTPUT_SIZES } from '../shared/output-protocol.js';

// Home keeps its responsive stylesheet layout; only the saved talk design is rendered here.
export function initializeWorkspace(designStore, { talk, talkView, onTalkRatioChange = () => {} } = {}) {
  const home = document.querySelector('.workspace');
  home.classList.add('pokome-workspace'); talk.classList.add('pokome-workspace');
  for (const [id, selector] of [['comments', '.comments'], ['now', '.now'], ['reading', '.reading']]) {
    const element = home.querySelector(selector);
    element.classList.add('pokome-panel'); element.dataset.panelType = id;
  }
  let shownRatio = '', layout = null;
  // Browser windows vary; the output size chooses the talk screen's ratio.
  const outputRatio = () => nearestRatio(...(OUTPUT_SIZES[designStore.design.outputSize] ?? OUTPUT_SIZES['1280x720']));

  function reload() {
    const ratio = outputRatio(), changed = ratio !== shownRatio;
    shownRatio = ratio; layout = talkLayout(designStore.design, ratio);
    talkView.setSize(...OUTPUT_SIZES[designStore.design.outputSize]);
    talk.ownerDocument.body.dataset.ratio = ratio;
    applyTalkLayout(talk, layout);
    if (changed) onTalkRatioChange(ratio);
  }

  function clampTalkSpeech() {
    if (!layout) return;
    const styles = talkSpeechStyles(layout.panels, parseFloat(talk.ownerDocument.defaultView.getComputedStyle(talk.querySelector('.stage-speech')).minHeight) || 0);
    for (const [id, values] of Object.entries(styles)) {
      const panel = talk.querySelector(`.stage-${id}`);
      for (const [property, value] of Object.entries(values)) panel.style.setProperty(property, value);
    }
  }

  // CSS and responsive minimums can change without reapplying the saved layout.
  new ResizeObserver(clampTalkSpeech).observe(talk.querySelector('.stage-speech'));
  reload();
  return { reload, talkRatio: () => shownRatio };
}
