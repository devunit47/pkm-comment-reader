import { talkSpeechStyles } from '../shared/workspace-model.js';
import { nearestRatio, talkLayout } from '../shared/design-model.js';
import { applyTalkLayout, TALK_PANEL_SELECTORS } from './stage-appearance.js';
import { OUTPUT_SIZES } from '../shared/output-protocol.js';

// Home keeps its responsive stylesheet layout; only the saved talk design is rendered here.
export function initializeWorkspace(designStore, { onTalkRatioChange = () => {} } = {}) {
  const home = document.querySelector('.workspace'), talk = document.querySelector('#talk-stage');
  home.classList.add('pokome-workspace'); talk.classList.add('pokome-workspace');
  for (const [id, selector] of [['comments', '.comments'], ['now', '.now'], ['reading', '.reading']]) {
    const element = home.querySelector(selector);
    element.classList.add('pokome-panel'); element.dataset.panelType = id;
  }
  const panels = Object.fromEntries(Object.entries(TALK_PANEL_SELECTORS).map(([id, selector]) => [id, talk.querySelector(selector)]));
  let shownRatio = '', layout = null;
  // Browser windows vary; the output size chooses the talk screen's ratio.
  const outputRatio = () => nearestRatio(...(OUTPUT_SIZES[designStore.design.outputSize] ?? OUTPUT_SIZES['1280x720']));

  function reload() {
    const ratio = outputRatio(), changed = ratio !== shownRatio;
    shownRatio = ratio; layout = talkLayout(designStore.design, ratio);
    talk.dataset.frameRatio = ratio; talk.style.setProperty('--frame', ratio.replace(':', ' / '));
    applyTalkLayout(talk, layout);
    if (changed) onTalkRatioChange(ratio);
  }

  function clampTalkSpeech() {
    if (!layout) return;
    const styles = talkSpeechStyles(layout.panels, parseFloat(getComputedStyle(panels.speech).minHeight) || 0);
    for (const [id, values] of Object.entries(styles)) {
      for (const [property, value] of Object.entries(values)) panels[id].style.setProperty(property, value);
    }
  }

  const observer = new MutationObserver(() => { if (outputRatio() !== shownRatio) reload(); });
  observer.observe(talk, { attributes: true, attributeFilter: ['hidden'] });
  // CSS and responsive minimums can change without reapplying the saved layout.
  new ResizeObserver(clampTalkSpeech).observe(panels.speech);
  reload();
  return { reload, talkRatio: () => shownRatio };
}
