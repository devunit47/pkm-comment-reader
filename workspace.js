import { WORKSPACE_KEY, PANEL_IDS, normalizeWorkspace, normalizeLayout } from './workspace-model.js';
import { nearestRatio, talkLayout, defaultTalkLayout, talkOverlays, withTalk } from './design-model.js';
import { OUTPUT_SIZES } from './output-protocol.js';
export { WORKSPACE_KEY, normalizeWorkspace, normalizeLayout } from './workspace-model.js';

// The home layout is an operating preference kept in this browser. The talk
// (stream) layout is part of the design and is saved in the customization folder,
// one per ratio. The talk screen previews the stream: it shows the ratio of the
// chosen output size, framed to that shape, and while editing the chosen ratio.
export function initializeWorkspace(storage, designStore, { onTalkRatioChange = () => {} } = {}) {
  const roots = { home: document.querySelector('.workspace'), talk: document.querySelector('#talk-stage') };
  const selectors = { home: ['.comments', '.now', '.reading'], talk: ['.stage-header', '.stage-chat', '.stage-speech', '.stage-actor', '.stage-footer'] };
  let layouts = { version: 1, home: null, talk: null }, editing = false, snap = true, selected = 'comments', lastMode = '', target = 'home';
  let layoutGeneration = 0;
  const names = { comments: 'コメント一覧', now: '読み上げプレビュー', reading: '読み上げ設定', header: 'タイトル・接続状態', chat: '配信用コメント一覧', speech: '読み上げ中のコメント', actor: '立ち絵・映像のスペース', footer: '画面下のひとこと' };
  try { const saved = storage?.getItem(WORKSPACE_KEY); if (saved) layouts.home = normalizeWorkspace(JSON.parse(saved)).home; } catch { /* Keep the original layout when saved data is unusable. */ }
  let editRatio = '16:9', shownRatio = '';
  // Not the window's shape: browser windows vary, and the stream has a fixed size.
  const liveRatio = () => nearestRatio(...(OUTPUT_SIZES[designStore.design.outputSize] ?? OUTPUT_SIZES['1280x720']));
  const framing = () => editing && target === 'talk';
  // While the talk stage is not on screen, the numeric fields and reset work on the
  // ratio chosen for editing; on screen it previews the output size's ratio.
  const talkRatio = () => framing() || (target === 'talk' && roots.talk.hidden) ? editRatio : liveRatio();
  // talkLayout returns a copy: edits mutate panels in place and must not touch the store.
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
  shadow.innerHTML = `<style>:host{display:block;margin-bottom:24px;font:14px system-ui;color:#e4eeea}*{box-sizing:border-box}section{background:#1a2325;border:1px solid #2c3739;border-radius:12px;padding:24px}h2{margin:0 0 12px;font-size:18px}button,select,input{font:inherit;padding:9px;border:1px solid #647a72;border-radius:6px;background:#101718;color:#e4eeea}button{cursor:pointer}button:disabled,input:disabled,select:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid #ace5cd;outline-offset:3px}.actions{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}label{display:grid;gap:6px;margin:12px 0}input[type=number]{width:100%}p,small{line-height:1.7;color:#b2c2b8}p{margin:8px 0}small{font-size:12px}#numbers{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:0 16px}.check{display:flex;align-items:center;gap:8px}details{margin-top:20px}summary{cursor:pointer}input[type=file]{max-width:100%}</style><section aria-label="画面の配置"><h2>画面の配置</h2><p>コメントや立ち絵などの枠を、好きな場所に動かせます。変更は自動で保存されます（ホームの配置はこのブラウザ、雑談画面の配置はcustomizationフォルダー）。</p><label>配置を変える画面<select id="mode"><option value="home">ホーム（コメントを操作する画面）</option><option value="talk">雑談画面（配信に映す画面）</option></select></label><div id="ratio-fields" hidden><label>編集する比率<select id="ratio" aria-describedby="ratio-help"><option value="16:9">16:9（横長。1920×1080・1280×720など）</option><option value="9:16">9:16（縦長。1080×1920など）</option><option value="4:3">4:3（1440×1080など）</option></select></label><p id="ratio-help">配置は比率ごとに保存します。雑談画面は「配信出力（OBS用）」で選んだ「出力の大きさ」の比率の配置を使い、その比率の枠で表示します。配信出力は、自分の大きさにいちばん近い比率の配置を使います。編集中は、選んだ比率の枠で雑談画面を表示します。</p><details id="copy-ratio"><summary>ほかの比率からコピー</summary><p>コピー元の比率の配置と追加の文字・画像を、上で選んだ「編集する比率」へ写します。コピー先の配置と追加の文字・画像は置き換わります。</p><label>コピー元<select id="copy-source"><option value="16:9">16:9</option><option value="9:16">9:16</option><option value="4:3">4:3</option></select></label><div class="actions"><button id="copy-ratio-button" type="button">この比率へコピー</button></div></details></div><p>「画面を見ながら配置を変える」を押し、枠の「移動」をつかんで動かしてください。「大きさ」で枠を広げたり縮めたりできます。終わったら「完了して設定に戻る」を押します。</p><div class="actions"><button id="edit">画面を見ながら配置を変える</button><button id="reset">選んだ画面の配置を元に戻す</button></div><p>元に戻すと、選んだ画面の枠の位置・大きさ・表示が初期状態になります。色や文字は変わりません。</p><details class="fields"><summary>枠ごとに表示や位置を調整する</summary><p id="layout-help">最初に画面を見ながら配置を変えると、ここでも調整できます。</p><label>調整する枠<select id="panel" aria-label="調整する枠"></select></label><label class="check"><input id="hidden" type="checkbox">この枠を表示しない</label><p>配置を変えている間は、表示しない枠も薄く表示されます。チェックを外すと再表示できます。</p><label class="check"><input id="snap" type="checkbox" checked>動かすときに位置をそろえる</label><p>細かいずれを減らすため、画面の2%ずつの間隔にそろえます。自由に微調整する場合はチェックを外してください。</p><div id="numbers"></div><p>矢印キーでも枠を動かせます。Shiftキーを押しながら矢印キーを押すと、大きさを変えられます。</p></details><p id="status" role="status" aria-live="polite"></p></section>`;
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
    input.addEventListener('change', () => { const mode = currentMode(); ensure(mode); layouts[mode].panels[selected][field] = Number(input.value); layouts[mode] = normalizeLayout(layouts[mode], PANEL_IDS[mode]); apply(mode); save(); fields(); });
  }
  function currentMode() { return target; }
  function available() { return !roots.talk.hidden || !document.getElementById('home-page').hidden; }
  function save() {
    layoutGeneration++;
    try { storage?.setItem(WORKSPACE_KEY, JSON.stringify({ version: 1, home: layouts.home, talk: null })); $('status').textContent = '配置を保存しました。'; }
    catch { $('status').textContent = 'ホームの配置を保存できません。ブラウザの保存設定を確認してください。'; }
    if (JSON.stringify(layouts.talk) === JSON.stringify(talkLayout(designStore.design, shownRatio))) return;
    designStore.save(withTalk(designStore.design, shownRatio, { layout: layouts.talk }))
      .catch(error => { $('status').textContent = `雑談画面の配置を保存できません。${error.message}`; });
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
    const p = layouts.talk.panels.speech;
    const minimum = parseFloat(getComputedStyle(talkSpeech).minHeight) || 0;
    talkSpeech.style.top = `min(${p.y}%, max(0px, calc(100% - max(${p.h}%, ${minimum}px))))`;
  }
  function interactionStart(mode, element, resize, axes = [1, 1]) {
    const p = { ...layouts[mode].panels[element.dataset.panelType] };
    if (mode !== 'talk' || element !== talkSpeech) return p;
    const root = roots[mode], canvas = root.getBoundingClientRect(), visible = element.getBoundingClientRect();
    // Reconcile only the dimensions the user is editing. A viewport resize or
    // a click without movement must not rewrite the saved desktop percentages.
    if (resize) {
      if (axes[0]) p.w = visible.width / canvas.width * 100;
      if (axes[1]) p.h = visible.height / canvas.height * 100;
    }
    else { p.x = (visible.left - canvas.left + root.scrollLeft) / canvas.width * 100; p.y = (visible.top - canvas.top + root.scrollTop) / canvas.height * 100; }
    return p;
  }
  function apply(mode) {
    const root = roots[mode];
    if (layouts[mode]) {
      if (mode === 'home') { root.style.position = 'relative'; root.style.display = 'block'; root.style.height = 'max(700px, 80vh)'; }
      for (const element of panels[mode]) { const p = layouts[mode].panels[element.dataset.panelType]; element.style.setProperty('position', 'absolute'); for (const [property, value] of Object.entries({ left: p.x, top: p.y, width: p.w, height: p.h })) element.style.setProperty(property, `${value}%`); element.style.zIndex = p.z; element.style.maxHeight = 'none'; element.style.margin = '0'; element.style.display = p.hidden && !editing ? 'none' : ''; element.style.opacity = p.hidden && editing ? '.45' : ''; }
      // The speech minimum can exceed a saved percentage height. Clamp its
      // rendered position using both dimensions, without rewriting saved data.
      if (mode === 'talk') clampTalkSpeech();
    } else { if (mode === 'home') { root.style.removeProperty('position'); root.style.removeProperty('display'); root.style.removeProperty('height'); } for (const element of panels[mode]) { const original = originals.get(element); original == null ? element.removeAttribute('style') : element.setAttribute('style', original); } }
    for (const element of panels[mode]) element.querySelector('[data-layout-handle]').hidden = !editing || mode !== currentMode();
  }
  function frame() {
    const ratio = talkRatio();
    roots.talk.dataset.frameRatio = ratio; roots.talk.style.setProperty('--frame', ratio.replace(':', ' / '));
    if (framing()) roots.talk.dataset.frameEditing = ''; else delete roots.talk.dataset.frameEditing;
  }
  // Show the talk layout of the ratio this screen should use now.
  function showTalk() {
    frame();
    if (talkRatio() !== shownRatio) { loadTalk(); apply('talk'); }
  }
  function fields() {
    sessionHost.style.setProperty('display', editing ? 'block' : 'none', 'important');
    $('ratio-fields').hidden = target !== 'talk';
    $('ratio').value = editRatio;
    for (const id of ['panel', 'hidden', 'x', 'y', 'w', 'h', 'z']) $(id).disabled = !layouts[target];
    $('layout-help').textContent = layouts[target] ? '枠を選んで調整してください。変更はすぐに保存されます。' : '最初に画面を見ながら配置を変えると、ここでも調整できます。';
    const mode = currentMode(); if (lastMode !== mode) { selected = PANEL_IDS[mode][0]; $('panel').replaceChildren(...PANEL_IDS[mode].map(id => { const option = document.createElement('option'); option.value = id; option.textContent = names[id]; return option; })); lastMode = mode; }
    $('panel').value = selected;
    const panel = layouts[mode]?.panels[selected]; if (panel) { for (const field of ['x', 'y', 'w', 'h', 'z']) $(field).value = Math.round(panel[field] * 100) / 100; $('hidden').checked = panel.hidden; }
  }
  for (const mode of Object.keys(roots)) for (const element of panels[mode]) {
    const handleHost = document.createElement('div'); handleHost.dataset.layoutHandle = ''; handleHost.style.cssText = 'position:absolute;top:0;left:0;z-index:1000;';
    const panelName = names[element.dataset.panelType];
    const handleShadow = handleHost.attachShadow({ mode: 'open' }); handleShadow.innerHTML = `<style>button{font:12px system-ui;background:#fff;color:#172b25;border:2px solid #3b7965;padding:5px;cursor:move;touch-action:none}button:last-child{cursor:nwse-resize}</style><button aria-label="${panelName} を移動">↔ 移動：${panelName}</button><button aria-label="${panelName} のサイズ変更">↘ 大きさ</button>`; element.append(handleHost);
    for (const [index, button] of [...handleShadow.querySelectorAll('button')].entries()) {
      button.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !editing || !available()) return; ensure(mode); selected = element.dataset.panelType; fields(); const original = { ...layouts[mode].panels[selected] }, start = interactionStart(mode, element, index), rect = roots[mode].getBoundingClientRect(); button.setPointerCapture(event.pointerId);
        const move = e => { const dx = (e.clientX - event.clientX) / rect.width * 100, dy = (e.clientY - event.clientY) / rect.height * 100; const p = { ...(index ? original : start) }; for (const [field, delta] of index ? [['w', dx], ['h', dy]] : [['x', dx], ['y', dy]]) { if (index && delta === 0) continue; p[field] = snap ? Math.round((start[field] + delta) / 2) * 2 : start[field] + delta; } layouts[mode].panels[selected] = p; layouts[mode] = normalizeLayout(layouts[mode], PANEL_IDS[mode]); apply(mode); fields(); };
        const finish = e => { button.removeEventListener('pointermove', move); button.removeEventListener('pointerup', finish); button.removeEventListener('pointercancel', finish); if (e.type === 'pointercancel') { layouts[mode].panels[selected] = original; apply(mode); fields(); } else save(); };
        button.addEventListener('pointermove', move); button.addEventListener('pointerup', finish); button.addEventListener('pointercancel', finish);
      });
      button.addEventListener('keydown', event => { if (!editing || !available()) return; const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]; if (!delta) return; event.preventDefault(); ensure(mode); selected = element.dataset.panelType; const resize = index || event.shiftKey, p = interactionStart(mode, element, resize, delta); p[resize ? 'w' : 'x'] += delta[0] * (snap ? 2 : 1); p[resize ? 'h' : 'y'] += delta[1] * (snap ? 2 : 1); layouts[mode].panels[selected] = p; layouts[mode] = normalizeLayout(layouts[mode], PANEL_IDS[mode]); apply(mode); fields(); save(); });
    }
  }
  function finish() {
    editing = false; showTalk();
    if (!roots.talk.hidden) document.getElementById('leave-talk').click();
    for (const mode of Object.keys(roots)) apply(mode);
    document.querySelector('[data-page="studio"]').click(); fields(); save(); $('edit').focus();
  }
  sessionShadow.getElementById('finish').onclick = finish;
  $('mode').onchange = () => { target = $('mode').value; showTalk(); fields(); };
  $('edit').onclick = () => {
    document.querySelector('[data-page="home"]').click();
    if (target === 'talk') document.getElementById('enter-talk').click();
    editing = true; showTalk(); ensure(target); for (const mode of Object.keys(roots)) apply(mode); fields(); save();
    sessionShadow.getElementById('finish').focus();
  };
  $('reset').onclick = () => {
    const mode = currentMode();
    editing = false; showTalk();
    layouts[mode] = mode === 'talk' ? defaultTalkLayout(shownRatio) : null;
    apply(mode); fields(); save();
  };
  $('ratio').onchange = () => { editRatio = $('ratio').value; showTalk(); fields(); };
  // Copying is the only way one ratio's layout reaches another.
  $('copy-ratio-button').onclick = () => {
    const source = $('copy-source').value;
    if (source === editRatio) { $('status').textContent = 'コピー元と編集する比率が同じです。別の比率を選んでください。'; return; }
    const design = designStore.design, layout = talkLayout(design, source);
    // The landscape default is the stylesheet's grid, which has no positions to copy.
    const next = withTalk(design, editRatio, { overlays: talkOverlays(design, source), ...(layout ? { layout } : {}) });
    designStore.save(next).catch(error => { $('status').textContent = `コピーを保存できません。${error.message}`; });
    layoutGeneration++;
    if (shownRatio === editRatio) { loadTalk(editRatio); apply('talk'); }
    onTalkRatioChange(shownRatio);
    $('status').textContent = layout ? `${source} の配置と追加の文字・画像を ${editRatio} にコピーしました。` : `${source} は標準の並びのため、追加の文字・画像だけを ${editRatio} にコピーしました。`;
    fields();
  };
  $('snap').onchange = () => { snap = $('snap').checked; };
  $('panel').onchange = () => { selected = $('panel').value; fields(); };
  $('hidden').onchange = () => { layouts[currentMode()].panels[selected].hidden = $('hidden').checked; apply(currentMode()); save(); };
  function applyLayouts(value) { layouts = normalizeWorkspace(value); layouts.talk ??= defaultTalkLayout(shownRatio); for (const mode of Object.keys(roots)) apply(mode); fields(); save(); }
  const observer = new MutationObserver(() => {
    if (editing && (target === 'talk' ? roots.talk.hidden : document.getElementById('home-page').hidden)) {
      editing = false; showTalk(); for (const mode of Object.keys(roots)) apply(mode);
    }
    // Entering or leaving talk mode switches between the output ratio and the edit ratio.
    showTalk(); fields();
  });
  observer.observe(roots.talk, { attributes: true, attributeFilter: ['hidden'] });
  observer.observe(document.getElementById('home-page'), { attributes: true, attributeFilter: ['hidden'] });
  // CSS application/removal and responsive minimums can change the rendered
  // size without reapplying a layout. Updating top does not change panel size.
  new ResizeObserver(clampTalkSpeech).observe(talkSpeech);

  frame(); for (const mode of Object.keys(roots)) apply(mode); fields();
  return { cancelPending() { layoutGeneration++; }, getLayouts: () => normalizeWorkspace(layouts), applyLayouts, reset: () => { editing = false; applyLayouts({ version: 1, home: null, talk: null }); },
    // Shows a talk layout saved elsewhere without writing it back.
    // Also follows a new output size, which decides the talk screen's ratio.
    reload() { layoutGeneration++; frame(); loadTalk(talkRatio()); apply('talk'); fields(); },
    // The ratio whose layout and overlays the talk screen shows now.
    talkRatio: () => shownRatio };
}
