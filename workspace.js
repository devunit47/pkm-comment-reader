import { WORKSPACE_KEY, PANEL_IDS, normalizeWorkspace, normalizeLayout } from './workspace-model.js';
export { WORKSPACE_KEY, normalizeWorkspace, normalizeLayout } from './workspace-model.js';

export function initializeWorkspace(storage, { resetTheme = () => {} } = {}) {
  const roots = { home: document.querySelector('.workspace'), talk: document.querySelector('#talk-stage') };
  const selectors = { home: ['.comments', '.now', '.reading', '.moderation'], talk: ['.stage-header', '.stage-chat', '.stage-speech', '.stage-actor', '.stage-footer'] };
  let layouts = { version: 1, home: null, talk: null }, editing = false, snap = true, selected = 'comments', lastMode = '';
  try { const saved = storage.getItem(WORKSPACE_KEY); if (saved) layouts = normalizeWorkspace(JSON.parse(saved)); } catch { /* Keep the original layout when saved data is unusable. */ }
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
  host.style.cssText = 'position:fixed!important;right:12px!important;bottom:12px!important;z-index:2147483647!important;display:block!important;visibility:visible!important;opacity:1!important;';
  document.body.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>:host{font:13px system-ui;color:#172b25}*{box-sizing:border-box}section{background:#fff;border:2px solid #3b7965;border-radius:10px;padding:8px;max-width:min(460px,95vw);box-shadow:0 4px 20px #0004}button,select,input{font:inherit;margin:3px;padding:5px;border:1px solid #6e8a80;border-radius:4px;background:#fff;color:#172b25}button{cursor:pointer}label{display:inline-flex;align-items:center}input[type=number]{width:65px}.fields[hidden]{display:none}p{margin:4px;font-size:12px}input[type=file]{max-width:220px}</style><section aria-label="レイアウト編集"><button id="edit" aria-pressed="false">配置を編集</button><button id="reset">配置を戻す</button><button id="css">CSSを解除</button><button id="export">配置を書き出す</button><label>配置を読み込む<input id="import" type="file" accept="application/json,.json"></label><div class="fields" hidden><p>パネルを選び、移動・サイズ変更できます。矢印キーでも移動、Shift＋矢印でサイズ変更。</p><select id="panel" aria-label="編集するパネル"></select><label><input id="snap" type="checkbox" checked>2%に吸着</label><label><input id="hidden" type="checkbox">非表示</label><div id="numbers"></div></div><p id="status" role="status" aria-live="polite"></p></section>`;
  const $ = id => shadow.getElementById(id);
  const leave = document.createElement('button'); leave.textContent = '雑談モードを終了'; leave.hidden = roots.talk.hidden; leave.onclick = () => document.getElementById('leave-talk').click();
  shadow.querySelector('section').prepend(leave);
  for (const field of ['x', 'y', 'w', 'h', 'z']) {
    const label = document.createElement('label'); label.textContent = field === 'z' ? '重なり' : `${field} %`;
    const input = document.createElement('input'); input.type = 'number'; input.min = field === 'w' || field === 'h' ? 5 : 0; input.max = field === 'z' ? 99 : 100; input.step = 1; input.id = field; label.append(input); $('numbers').append(label);
    input.addEventListener('change', () => { const mode = currentMode(); ensure(mode); layouts[mode].panels[selected][field] = Number(input.value); layouts[mode] = normalizeLayout(layouts[mode], PANEL_IDS[mode]); apply(mode); save(); fields(); });
  }
  function currentMode() { return roots.talk.hidden ? 'home' : 'talk'; }
  function available() { return !roots.talk.hidden || !document.getElementById('home-page').hidden; }
  function save() { try { storage.setItem(WORKSPACE_KEY, JSON.stringify(layouts)); $('status').textContent = '配置を保存しました。'; } catch { $('status').textContent = '保存できません。配置を書き出して保管してください。'; } }
  function ensure(mode) {
    if (layouts[mode]) return;
    const rect = roots[mode].getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    layouts[mode] = normalizeLayout({ panels: Object.fromEntries(panels[mode].map(element => { const p = element.getBoundingClientRect(); return [element.dataset.panelType, { x: (p.left - rect.left) / rect.width * 100, y: (p.top - rect.top) / rect.height * 100, w: p.width / rect.width * 100, h: p.height / rect.height * 100, z: 1, hidden: false }]; })) }, PANEL_IDS[mode]);
  }
  function apply(mode) {
    const root = roots[mode];
    if (layouts[mode]) {
      if (mode === 'home') { root.style.position = 'relative'; root.style.display = 'block'; root.style.height = 'max(700px, 80vh)'; }
      for (const element of panels[mode]) { const p = layouts[mode].panels[element.dataset.panelType]; element.style.setProperty('position', 'absolute'); for (const [property, value] of Object.entries({ left: p.x, top: p.y, width: p.w, height: p.h })) element.style.setProperty(property, `${value}%`); element.style.zIndex = p.z; element.style.maxHeight = 'none'; element.style.margin = '0'; element.style.display = p.hidden && !editing ? 'none' : ''; element.style.opacity = p.hidden && editing ? '.45' : ''; }
    } else { if (mode === 'home') { root.style.removeProperty('position'); root.style.removeProperty('display'); root.style.removeProperty('height'); } for (const element of panels[mode]) { const original = originals.get(element); original == null ? element.removeAttribute('style') : element.setAttribute('style', original); } }
    for (const element of panels[mode]) element.querySelector('[data-layout-handle]').hidden = !editing || mode !== currentMode();
  }
  function fields() {
    leave.hidden = roots.talk.hidden;
    for (const id of ['edit', 'reset', 'panel', 'hidden', 'x', 'y', 'w', 'h', 'z']) $(id).disabled = !available();
    const mode = currentMode(); if (lastMode !== mode) { selected = PANEL_IDS[mode][0]; $('panel').replaceChildren(...PANEL_IDS[mode].map(id => { const option = document.createElement('option'); option.value = id; option.textContent = id; return option; })); lastMode = mode; }
    $('panel').value = selected; $('edit').setAttribute('aria-pressed', String(editing)); $('edit').textContent = editing ? '編集を終了' : '配置を編集'; shadow.querySelector('.fields').hidden = !editing || !available();
    const panel = layouts[mode]?.panels[selected]; if (panel) { for (const field of ['x', 'y', 'w', 'h', 'z']) $(field).value = Math.round(panel[field] * 100) / 100; $('hidden').checked = panel.hidden; }
  }
  for (const mode of Object.keys(roots)) for (const element of panels[mode]) {
    const handleHost = document.createElement('div'); handleHost.dataset.layoutHandle = ''; handleHost.style.cssText = 'position:absolute;top:0;left:0;z-index:1000;';
    const handleShadow = handleHost.attachShadow({ mode: 'open' }); handleShadow.innerHTML = `<style>button{font:12px system-ui;background:#fff;color:#172b25;border:2px solid #3b7965;padding:5px;cursor:move;touch-action:none}button:last-child{cursor:nwse-resize}</style><button aria-label="${element.dataset.panelType} を移動">↔ ${element.dataset.panelType}</button><button aria-label="${element.dataset.panelType} のサイズ変更">↘</button>`; element.append(handleHost);
    for (const [index, button] of [...handleShadow.querySelectorAll('button')].entries()) {
      button.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !editing || !available()) return; ensure(mode); selected = element.dataset.panelType; fields(); const start = { ...layouts[mode].panels[selected] }, rect = roots[mode].getBoundingClientRect(); button.setPointerCapture(event.pointerId);
        const move = e => { const dx = (e.clientX - event.clientX) / rect.width * 100, dy = (e.clientY - event.clientY) / rect.height * 100; const p = { ...start }; for (const [field, delta] of index ? [['w', dx], ['h', dy]] : [['x', dx], ['y', dy]]) p[field] = snap ? Math.round((start[field] + delta) / 2) * 2 : start[field] + delta; layouts[mode].panels[selected] = p; layouts[mode] = normalizeLayout(layouts[mode], PANEL_IDS[mode]); apply(mode); fields(); };
        const finish = e => { button.removeEventListener('pointermove', move); button.removeEventListener('pointerup', finish); button.removeEventListener('pointercancel', finish); if (e.type === 'pointercancel') { layouts[mode].panels[selected] = start; apply(mode); fields(); } else save(); };
        button.addEventListener('pointermove', move); button.addEventListener('pointerup', finish); button.addEventListener('pointercancel', finish);
      });
      button.addEventListener('keydown', event => { if (!editing || !available()) return; const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]; if (!delta) return; event.preventDefault(); ensure(mode); selected = element.dataset.panelType; const p = layouts[mode].panels[selected], resize = index || event.shiftKey; p[resize ? 'w' : 'x'] += delta[0] * (snap ? 2 : 1); p[resize ? 'h' : 'y'] += delta[1] * (snap ? 2 : 1); layouts[mode] = normalizeLayout(layouts[mode], PANEL_IDS[mode]); apply(mode); fields(); save(); });
    }
  }
  $('edit').onclick = () => { if (!available()) return; editing = !editing; if (editing) ensure(currentMode()); for (const mode of Object.keys(roots)) apply(mode); fields(); save(); };
  $('reset').onclick = () => { layouts[currentMode()] = null; editing = false; apply(currentMode()); fields(); save(); };
  $('css').onclick = resetTheme;
  $('snap').onchange = () => { snap = $('snap').checked; };
  $('panel').onchange = () => { selected = $('panel').value; fields(); };
  $('hidden').onchange = () => { layouts[currentMode()].panels[selected].hidden = $('hidden').checked; apply(currentMode()); save(); };
  $('export').onclick = () => { const url = URL.createObjectURL(new Blob([JSON.stringify(layouts, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'layout.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  function applyLayouts(value) { layouts = normalizeWorkspace(value); for (const mode of Object.keys(roots)) apply(mode); fields(); save(); }
  $('import').onchange = async () => { try { const file = $('import').files[0]; if (!file) return; if (file.size > 100000) throw new Error('配置ファイルは100KBまでです。'); applyLayouts(JSON.parse(await file.text())); } catch (error) { $('status').textContent = error.message; } finally { $('import').value = ''; } };
  const observer = new MutationObserver(() => { if (lastMode !== currentMode()) { if (editing && available()) ensure(currentMode()); for (const mode of Object.keys(roots)) apply(mode); } fields(); });
  observer.observe(roots.talk, { attributes: true, attributeFilter: ['hidden'] });
  observer.observe(document.getElementById('home-page'), { attributes: true, attributeFilter: ['hidden'] });
  for (const mode of Object.keys(roots)) apply(mode); fields();
  return { getLayouts: () => normalizeWorkspace(layouts), applyLayouts, reset: () => applyLayouts({ version: 1, home: null, talk: null }) };
}
