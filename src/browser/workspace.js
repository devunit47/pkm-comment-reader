import { WORKSPACE_KEY, PANEL_IDS, normalizeWorkspace, normalizeLayout, talkSpeechStyles } from '../shared/workspace-model.js';
import { nearestRatio, talkLayout } from '../shared/design-model.js';
import { applyTalkLayout } from './stage-appearance.js';
import { OUTPUT_SIZES } from '../shared/output-protocol.js';
export { WORKSPACE_KEY, normalizeWorkspace, normalizeLayout } from '../shared/workspace-model.js';

// The home layout is an operating preference kept in this browser. The talk
// (stream) layout is part of the design and is saved in the customization folder,
// one per ratio. Talk rendering follows the output size; only home is edited here.
export function initializeWorkspace(storage, designStore, { onTalkRatioChange = () => {} } = {}) {
  const roots = { home: document.querySelector('.workspace'), talk: document.querySelector('#talk-stage') };
  const selectors = { home: ['.comments', '.now', '.reading'], talk: ['.stage-header', '.stage-chat', '.stage-speech', '.stage-actor', '.stage-footer'] };
  let layouts = { version: 1, home: null, talk: null }, editing = false, snap = true, selected = 'comments';
  const names = { comments: 'コメント一覧', now: '読み上げプレビュー', reading: '読み上げ設定' };
  try { const saved = storage?.getItem(WORKSPACE_KEY); if (saved) layouts.home = normalizeWorkspace(JSON.parse(saved)).home; } catch { /* Keep the original layout when saved data is unusable. */ }
  let shownRatio = '';
  // Not the window's shape: browser windows vary, and the stream has a fixed size.
  const talkRatio = () => nearestRatio(...(OUTPUT_SIZES[designStore.design.outputSize] ?? OUTPUT_SIZES['1280x720']));
  function loadTalk(ratio = talkRatio()) {
    const changed = ratio !== shownRatio;
    shownRatio = ratio; layouts.talk = talkLayout(designStore.design, ratio);
    if (changed) onTalkRatioChange(ratio);
  }
  loadTalk();
  const panels = {}, originals = new Map();
  for (const mode of Object.keys(roots)) {
    roots[mode].classList.add('pokome-workspace');
    panels[mode] = PANEL_IDS[mode].map((id, index) => {
      const element = roots[mode].querySelector(selectors[mode][index]);
      element.classList.add('pokome-panel'); element.dataset.panelType = id;
      originals.set(element, element.getAttribute('style'));
      return element;
    });
  }
  const host = document.createElement('div'); host.id = 'workspace-editor';
  document.getElementById('studio-page').prepend(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>:host{display:block;margin-bottom:24px;font:14px system-ui;color:#e4eeea}*{box-sizing:border-box}section{background:#1a2325;border:1px solid #2c3739;border-radius:12px;padding:24px}h2{margin:0 0 12px;font-size:18px}button,select,input{font:inherit;padding:9px;border:1px solid #647a72;border-radius:6px;background:#101718;color:#e4eeea}button{cursor:pointer}button:disabled,input:disabled,select:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid #ace5cd;outline-offset:3px}.actions{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}label{display:grid;gap:6px;margin:12px 0}input[type=number]{width:100%}p,small{line-height:1.7;color:#b2c2b8}p{margin:8px 0}small{font-size:12px}#numbers{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:0 16px}.check{display:flex;align-items:center;gap:8px}details{margin-top:20px}summary{cursor:pointer}input[type=file]{max-width:100%}</style><section aria-label="ホームの配置"><h2>ホームの配置</h2><p>ホームの枠を好きな場所に動かせます。変更はこのブラウザに自動で保存されます。雑談画面の配置はデザインエディタで変更します。</p><p>「画面を見ながら配置を変える」を押し、枠の「移動」をつかんで動かしてください。「大きさ」で枠を広げたり縮めたりできます。終わったら「完了して設定に戻る」を押します。</p><div class="actions"><button id="edit">画面を見ながら配置を変える</button><button id="reset">ホームの配置を元に戻す</button></div><p>元に戻すと、ホームの枠の位置・大きさ・表示が初期状態になります。雑談画面は変わりません。</p><details class="fields"><summary>枠ごとに表示や位置を調整する</summary><p id="layout-help">最初に画面を見ながら配置を変えると、ここでも調整できます。</p><label>調整する枠<select id="panel" aria-label="調整する枠"></select></label><label class="check"><input id="hidden" type="checkbox">この枠を表示しない</label><p>配置を変えている間は、表示しない枠も薄く表示されます。チェックを外すと再表示できます。</p><label class="check"><input id="snap" type="checkbox" checked>動かすときに位置をそろえる</label><p>細かいずれを減らすため、画面の2%ずつの間隔にそろえます。自由に微調整する場合はチェックを外してください。</p><div id="numbers"></div><p>矢印キーでも枠を動かせます。Shiftキーを押しながら矢印キーを押すと、大きさを変えられます。</p></details><p id="status" role="status" aria-live="polite"></p></section>`;
  const $ = id => shadow.getElementById(id);
  const sessionHost = document.createElement('div'); sessionHost.id = 'layout-session';
  sessionHost.style.cssText = 'position:fixed!important;top:12px!important;left:50%!important;transform:translateX(-50%)!important;z-index:2147483647!important;';
  document.body.append(sessionHost);
  const sessionShadow = sessionHost.attachShadow({ mode: 'open' });
  sessionShadow.innerHTML = '<style>:host{font:14px system-ui}div{background:#172b25;color:white;padding:10px 16px;border:1px solid #ace5cd;border-radius:8px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;max-width:90vw}button{font:inherit;background:#ace5cd;color:#172b25;border:0;border-radius:5px;padding:9px;cursor:pointer}p{margin:0;font-size:12px;line-height:1.6}</style><div><p>「移動」で場所を、「大きさ」でサイズを変えられます。</p><button id="finish">完了して設定に戻る</button></div>';
  const descriptions = { x: ['横位置（%）', '左端が0です。数値を増やすと右へ動きます。'], y: ['縦位置（%）', '上端が0です。数値を増やすと下へ動きます。'], w: ['幅（%）', '画面いっぱいの幅が100です。'], h: ['高さ（%）', '画面いっぱいの高さが100です。'], z: ['重なり順', '枠が重なるとき、大きい数値の枠が手前に出ます。'] };
  for (const field of ['x', 'y', 'w', 'h', 'z']) {
    const label = document.createElement('label'); label.textContent = descriptions[field][0];
    const input = document.createElement('input'); input.type = 'number'; input.min = field === 'w' || field === 'h' ? 5 : 0; input.max = field === 'z' ? 99 : 100; input.step = 1; input.id = field; const help = document.createElement('small'); help.id = `${field}-help`; help.textContent = descriptions[field][1]; input.setAttribute('aria-describedby', help.id); label.append(input, help); $('numbers').append(label);
    input.addEventListener('change', () => { const mode = 'home'; ensure(mode); layouts[mode].panels[selected][field] = Number(input.value); layouts[mode] = normalizeLayout(layouts[mode], PANEL_IDS[mode]); apply(mode); save(); fields(); });
  }
  $('panel').replaceChildren(...PANEL_IDS.home.map(id => { const option = document.createElement('option'); option.value = id; option.textContent = names[id]; return option; }));
  function available() { return !document.getElementById('home-page').hidden; }
  function save() {
    try { storage?.setItem(WORKSPACE_KEY, JSON.stringify({ version: 1, home: layouts.home, talk: null })); $('status').textContent = '配置を保存しました。'; }
    catch { $('status').textContent = 'ホームの配置を保存できません。ブラウザの保存設定を確認してください。'; }
  }
  function ensure(mode) {
    if (layouts[mode]) return;
    const rect = roots[mode].getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    layouts[mode] = normalizeLayout({ panels: Object.fromEntries(panels[mode].map(element => { const p = element.getBoundingClientRect(); return [element.dataset.panelType, { x: (p.left - rect.left) / rect.width * 100, y: (p.top - rect.top) / rect.height * 100, w: p.width / rect.width * 100, h: p.height / rect.height * 100, z: 1, hidden: false }]; })) }, PANEL_IDS[mode]);
  }
  const talkSpeech = panels.talk.find(element => element.dataset.panelType === 'speech');
  function clampTalkSpeech() {
    if (!layouts.talk) return;
    const minimum = parseFloat(getComputedStyle(talkSpeech).minHeight) || 0;
    const styles = talkSpeechStyles(layouts.talk.panels, minimum);
    for (const element of panels.talk) for (const [property, value] of Object.entries(styles[element.dataset.panelType] || {})) element.style.setProperty(property, value);
  }
  function apply(mode) {
    if (mode === 'talk') { applyTalkLayout(roots.talk, layouts.talk); return; }
    const root = roots[mode];
    if (layouts[mode]) {
      if (mode === 'home') { root.style.position = 'relative'; root.style.display = 'block'; root.style.height = 'max(700px, 80vh)'; }
      for (const element of panels[mode]) { const p = layouts[mode].panels[element.dataset.panelType]; element.style.setProperty('position', 'absolute'); for (const [property, value] of Object.entries({ left: p.x, top: p.y, width: p.w, height: p.h })) element.style.setProperty(property, `${value}%`); element.style.zIndex = p.z; element.style.maxHeight = 'none'; element.style.margin = '0'; element.style.display = p.hidden && !editing ? 'none' : ''; element.style.opacity = p.hidden && editing ? '.45' : ''; }
    } else { if (mode === 'home') { root.style.removeProperty('position'); root.style.removeProperty('display'); root.style.removeProperty('height'); } for (const element of panels[mode]) { const original = originals.get(element); original == null ? element.removeAttribute('style') : element.setAttribute('style', original); } }
    for (const element of panels[mode]) element.querySelector('[data-layout-handle]').hidden = !editing || mode !== 'home';
  }
  function frame() {
    const ratio = talkRatio();
    roots.talk.dataset.frameRatio = ratio; roots.talk.style.setProperty('--frame', ratio.replace(':', ' / '));
  }
  // Show the talk layout of the ratio this screen should use now.
  function showTalk() {
    frame();
    if (talkRatio() !== shownRatio) { loadTalk(); apply('talk'); }
  }
  function fields() {
    sessionHost.style.setProperty('display', editing ? 'block' : 'none', 'important');
    for (const id of ['panel', 'hidden', 'x', 'y', 'w', 'h', 'z']) $(id).disabled = !layouts.home;
    $('layout-help').textContent = layouts.home ? '枠を選んで調整してください。変更はすぐに保存されます。' : '最初に画面を見ながら配置を変えると、ここでも調整できます。';
    $('panel').value = selected;
    const panel = layouts.home?.panels[selected]; if (panel) { for (const field of ['x', 'y', 'w', 'h', 'z']) $(field).value = Math.round(panel[field] * 100) / 100; $('hidden').checked = panel.hidden; }
  }
  for (const mode of ['home']) for (const element of panels[mode]) {
    const handleHost = document.createElement('div'); handleHost.dataset.layoutHandle = ''; handleHost.style.cssText = 'position:absolute;top:0;left:0;z-index:1000;';
    const panelName = names[element.dataset.panelType];
    const handleShadow = handleHost.attachShadow({ mode: 'open' }); handleShadow.innerHTML = `<style>button{font:12px system-ui;background:#fff;color:#172b25;border:2px solid #3b7965;padding:5px;cursor:move;touch-action:none}button:last-child{cursor:nwse-resize}</style><button aria-label="${panelName} を移動">↔ 移動：${panelName}</button><button aria-label="${panelName} のサイズ変更">↘ 大きさ</button>`; element.append(handleHost);
    for (const [index, button] of [...handleShadow.querySelectorAll('button')].entries()) {
      button.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !editing || !available()) return; ensure(mode); selected = element.dataset.panelType; fields(); const original = { ...layouts[mode].panels[selected] }, start = { ...original }, rect = roots[mode].getBoundingClientRect(); button.setPointerCapture(event.pointerId);
        const move = e => { const dx = (e.clientX - event.clientX) / rect.width * 100, dy = (e.clientY - event.clientY) / rect.height * 100; const p = { ...(index ? original : start) }; for (const [field, delta] of index ? [['w', dx], ['h', dy]] : [['x', dx], ['y', dy]]) { if (index && delta === 0) continue; p[field] = snap ? Math.round((start[field] + delta) / 2) * 2 : start[field] + delta; } layouts[mode].panels[selected] = p; layouts[mode] = normalizeLayout(layouts[mode], PANEL_IDS[mode]); apply(mode); fields(); };
        const finish = e => { button.removeEventListener('pointermove', move); button.removeEventListener('pointerup', finish); button.removeEventListener('pointercancel', finish); if (e.type === 'pointercancel') { layouts[mode].panels[selected] = original; apply(mode); fields(); } else save(); };
        button.addEventListener('pointermove', move); button.addEventListener('pointerup', finish); button.addEventListener('pointercancel', finish);
      });
      button.addEventListener('keydown', event => { if (!editing || !available()) return; const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]; if (!delta) return; event.preventDefault(); ensure(mode); selected = element.dataset.panelType; const resize = index || event.shiftKey, p = { ...layouts[mode].panels[selected] }; p[resize ? 'w' : 'x'] += delta[0] * (snap ? 2 : 1); p[resize ? 'h' : 'y'] += delta[1] * (snap ? 2 : 1); layouts[mode].panels[selected] = p; layouts[mode] = normalizeLayout(layouts[mode], PANEL_IDS[mode]); apply(mode); fields(); save(); });
    }
  }
  function finish() {
    editing = false; showTalk();
    for (const mode of Object.keys(roots)) apply(mode);
    document.querySelector('[data-page="studio"]').click(); fields(); save(); $('edit').focus();
  }
  sessionShadow.getElementById('finish').onclick = finish;
  $('edit').onclick = () => {
    document.querySelector('[data-page="home"]').click();
    editing = true; showTalk(); ensure('home'); for (const mode of Object.keys(roots)) apply(mode); fields(); save();
    sessionShadow.getElementById('finish').focus();
  };
  $('reset').onclick = () => {
    editing = false; layouts.home = null; apply('home'); fields(); save();
  };
  $('snap').onchange = () => { snap = $('snap').checked; };
  $('panel').onchange = () => { selected = $('panel').value; fields(); };
  $('hidden').onchange = () => { layouts.home.panels[selected].hidden = $('hidden').checked; apply('home'); save(); };
  const observer = new MutationObserver(() => {
    if (editing && document.getElementById('home-page').hidden) {
      editing = false; showTalk(); for (const mode of Object.keys(roots)) apply(mode);
    }
    showTalk(); fields();
  });
  observer.observe(roots.talk, { attributes: true, attributeFilter: ['hidden'] });
  observer.observe(document.getElementById('home-page'), { attributes: true, attributeFilter: ['hidden'] });
  // CSS application/removal and responsive minimums can change the rendered
  // size without reapplying a layout. Updating top does not change panel size.
  new ResizeObserver(clampTalkSpeech).observe(talkSpeech);

  frame(); for (const mode of Object.keys(roots)) apply(mode); fields();
  return { reset() { editing = false; layouts.home = null; loadTalk(); for (const mode of Object.keys(roots)) apply(mode); fields(); save(); },
    // Shows a talk layout saved elsewhere without writing it back.
    // Also follows a new output size, which decides the talk screen's ratio.
    reload() { frame(); loadTalk(talkRatio()); apply('talk'); fields(); },
    // The ratio whose layout and overlays the talk screen shows now.
    talkRatio: () => shownRatio };
}
