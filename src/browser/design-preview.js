import { normalizeStudio } from '../shared/studio.js';
import { compileTheme } from '../shared/theme.js';
import { renderStageAppearance, renderOverlays, renderStageComments, selectOutputComments, markClippedComments, applyTalkLayout } from './stage-appearance.js';
import { MAX_OVERLAYS, normalizeOverlays, createOverlay, removeOverlay, addOverlayAsset } from '../shared/overlay-model.js';
import { resolveStudioImages, resolveOverlayAssets, studioOptions, overlayOptions, RATIOS, PREVIEW_SIZES, SAFE_AREAS, nearestRatio, talkLayout, talkOverlays, withTalk } from '../shared/design-model.js';
import { checkImageFile } from './design-client.js';

const VISUAL_KEYS = Object.keys(normalizeStudio());
const visual = studio => Object.fromEntries(VISUAL_KEYS.map(key => [key, studio[key]]));
const clone = value => structuredClone(value);
// Stable numbered samples reveal ordering without copying private chat.
const SAMPLE_COMMENTS = Object.freeze([
  'こんにちは。表示の大きさを確認しています。', '文字と背景の組み合わせを試しています。',
  '少し長めの文章でも読みやすい配置にできます。', '名前と本文の間隔を確認しましょう。',
  '新しいコメントがどちらに出るかを試しています。', '画面の端に文字が寄りすぎないか確認します。',
  'コメント欄の幅で折り返しが変わります。', '背景が明るい場面と暗い場面で確認しましょう。',
  '表示件数は履歴の保持件数とは別の設定です。', 'これが最後に届いたサンプルコメントです。',
].map((text, index) => ({ id: `sample-${index + 1}`, user: `サンプル${String(index + 1).padStart(2, '0')}`, text, receivedAt: index + 1 })));
const size = value => value.split('x').map(Number);

// The draft keeps the additions of every ratio; the preview size picks which
// ratio is shown and edited. getLiveRatio tells which ratio the talk screen shows.
export function initializeDesignPreview({ designStore, themeEditor, getStudio, commitStudio, getLiveRatio = () => '16:9', beginDraft = () => {} }) {
  const live = document.getElementById('talk-stage');
  let presetDraft = null, presetApply = null, returnFocus = null;
  const assetOptions = () => overlayOptions(presetDraft?.images || designStore.images), imageOptions = () => studioOptions(presetDraft?.images || designStore.images);
  const imageScope = () => presetDraft ? `presets/${presetDraft.id}` : 'current';
  const storedOverlays = () => talkOverlays(designStore.design, getLiveRatio());
  const previewRatio = () => nearestRatio(...size($('preview-width').value));
  let overlays = storedOverlays(), draft = null, baseline, selected = '', epoch = 0, pending = 0, stale = false, revision = 0;
  let commentResizeObserver, previewStage, frameDoc, previewCSS, defaultImage, compiledCSS = '', renderedStudio = null, dragCleanup;
  const requests = new Map();
  renderOverlays(live, resolveOverlayAssets(overlays));
  const host = document.createElement('div'); host.id = 'design-preview-editor';
  document.getElementById('studio-page').prepend(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{display:block;color:#edf4e9;font:14px system-ui;margin-bottom:24px}*{box-sizing:border-box}section{background:#1a2325;border:1px solid #506960;border-radius:12px;padding:24px}h2,h3,p{margin:0 0 12px}p{line-height:1.7;color:#c0d0c8}button,input,select,textarea{font:inherit;background:#101b18;color:#edf4e9;border:1px solid #70877b;border-radius:6px;padding:9px;max-width:100%}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #ace5cd;outline-offset:2px}label{display:grid;gap:5px;margin:10px 0}textarea{width:100%;resize:vertical}input[type=color]{width:100%;height:40px;padding:3px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.primary{background:#ace5cd;color:#11271e;font-weight:700}dialog{background:#101a18;color:#edf4e9;border:1px solid #ace5cd;border-radius:12px;width:calc(100vw - 24px);max-width:1500px;height:calc(100dvh - 24px);max-height:calc(100dvh - 24px);padding:20px;overflow:auto}dialog::backdrop{background:#000b}.bar{display:flex;gap:12px;justify-content:space-between;align-items:center;flex-wrap:wrap}.editor{display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:20px}.preview-pane{min-width:0;position:sticky;top:0;align-self:start}.viewport{position:relative;overflow:hidden;background:#080e0c;border:1px solid #5d776b;border-radius:8px;width:100%}iframe{position:absolute;left:0;top:0;border:0;transform-origin:top left;background:#122321}.controls{min-width:0}.numbers{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 10px}.numbers input{width:100%}details{margin:16px 0;border-top:1px solid #40554b;padding-top:12px}summary{cursor:pointer}small{line-height:1.6;color:#c0d0c8}.check{display:flex;gap:8px;align-items:center}#design-status{margin:10px 0;min-height:24px}#overlay-text-fields[hidden],dialog:not([open]){display:none}@media(max-width:850px){.editor{grid-template-columns:1fr}.preview-pane{position:static}dialog{padding:12px}.controls{display:grid;grid-template-columns:minmax(0,1fr)}}
  </style><section><h2>文字・画像とデザインのプレビュー</h2><p>雑談画面に好きな文章や画像を複数追加できます。プレビュー内で移動・サイズ・重なりを調整し、「適用する」でまとめて保存します。</p><button id="open-design-preview" class="primary" type="button">プレビューでデザインを編集</button><p id="preview-result" role="status"></p><p><small>この編集画面での変更は適用まで配信画面に反映されません。下の従来の設定・配置操作は、これまでどおり即時反映されます。</small></p></section>
  <dialog id="design-dialog" aria-labelledby="design-title"><div class="bar"><h2 id="design-title">デザインを試す</h2><div class="actions"><button id="apply-design" class="primary" type="button">適用する</button><button id="cancel-design" type="button">キャンセル</button></div></div><p>サンプル表示です。チャット接続・音声再生は行いません。外部フォントを読み込まないため、文字の折り返しは適用後も確認してください。画面収録・ウィンドウキャプチャ中は、この編集画面自体も映るためOBSの別シーンなどで編集してください。</p><p id="design-status" role="status" aria-live="polite"></p><div class="editor"><div class="preview-pane"><label>確認する画面サイズ<select id="preview-width">${PREVIEW_SIZES.map(value => `<option value="${value}"${value === '1280x720' ? ' selected' : ''}>${value.replace('x', ' × ')}（${nearestRatio(...size(value))}）</option>`).join('')}</select></label><label class="check"><input id="preview-guides" type="checkbox" checked>画面端のガイドを表示</label><p id="preview-ratio-help"><small>比率ごとに、配置と追加の文字・画像を別々に保存します。サイズを変えると、その比率の内容を表示・編集します。</small></p><div class="viewport" id="preview-viewport"><iframe id="design-preview-frame" title="雑談画面のデザインプレビュー" sandbox="allow-same-origin"></iframe></div><p><small>追加した文字・画像の「移動」「大きさ」をドラッグできます。矢印キーで移動、Shift＋矢印でサイズ変更。位置は画面に対する割合で保存します。</small></p></div><div class="controls"><h3>追加する文字・画像</h3><p><small>最大20個。画像はPNG・JPEG・WebP・GIF、1枚20MB・1600万画素まで。</small></p><div class="actions"><button id="add-text" type="button">文字を追加</button><button id="delete-overlay" type="button">選んだ項目を削除</button></div><label>画像を追加<input id="overlay-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label><label>編集する項目<select id="overlay-select"></select></label><label class="check"><input id="overlay-hidden" type="checkbox">この項目を非表示</label><div id="overlay-text-fields"><label>表示する文章<textarea id="overlay-text" maxlength="1000" rows="3"></textarea></label><label>文字の色<input id="overlay-color" type="color"></label><label>文字の大きさ（px）<input id="overlay-font-size" type="number" min="12" max="160"></label></div><div class="numbers">${[['x','横位置（%）'],['y','縦位置（%）'],['w','幅（%）'],['h','高さ（%）'],['z','重なり順 0〜99']].map(([key,label]) => `<label>${label}<input id="overlay-${key}" type="number" min="${['w','h'].includes(key)?2:0}" max="${key==='z'?99:100}" step="1"></label>`).join('')}</div><p><small>大きい重なり順の項目ほど手前に表示します。既存の枠は下の「画面の配置」で変更できます。</small></p>
  <details><summary>画面のデザインも試す</summary><label>テーマ<select id="draft-theme"><option value="mint">ミントの夜</option><option value="rose">ローズの夜</option><option value="violet">すみれの夜</option><option value="paper">お昼の喫茶室</option></select></label><label>配色モード<select id="draft-accentMode"><option value="theme">テーマに合わせる</option><option value="custom">自分で設定</option></select></label><label>アクセントカラー<input id="draft-accent" type="color"></label><label class="check"><input id="draft-decoration" type="checkbox">星やハートの装飾を表示</label>${[['title','タイトル',60],['subtitle','サブタイトル',100],['footer','画面下のひとこと',100],['speechTitle','読み上げ枠の見出し',40]].map(([key,label,max]) => `<label>${label}<input id="draft-${key}" type="text" maxlength="${max}"></label>`).join('')}<label>コメントの文字サイズ<input id="draft-fontSize" type="number" min="16" max="28"></label><label>読み上げの文字サイズ<select id="draft-speechFontSize"><option value="16">16px</option><option value="22">22px</option><option value="28">28px</option><option value="32">32px</option></select></label><label>読み上げ枠<select id="draft-speechStyle"><option value="panel">通常のパネル</option><option value="bubble">セリフの吹き出し</option><option value="image">背景画像</option></select></label><label>吹き出し背景<input id="draft-speechBackground" type="color"></label><label>背景画像内の文字色<input id="draft-speechTextColor" type="color"></label><label>コメントの表示<select id="draft-commentStyle"><option value="stacked">名前を上に表示</option><option value="anonymous">名前なし</option><option value="inline">名前と本文を横並び</option><option value="compact">1行コンパクト</option></select></label></details>
  <label>配信出力の表示件数<select id="draft-maxVisible"><option value="0">制限なし</option><option value="1">1件</option><option value="2">2件</option><option value="3">3件</option><option value="4">4件</option><option value="5">5件</option><option value="6">6件</option><option value="7">7件</option><option value="8">8件</option><option value="9">9件</option><option value="10">10件</option><option value="11">11件</option><option value="12">12件</option><option value="13">13件</option><option value="14">14件</option><option value="15">15件</option><option value="16">16件</option><option value="17">17件</option><option value="18">18件</option><option value="19">19件</option><option value="20">20件</option><option value="21">21件</option><option value="22">22件</option><option value="23">23件</option><option value="24">24件</option><option value="25">25件</option><option value="26">26件</option><option value="27">27件</option><option value="28">28件</option><option value="29">29件</option><option value="30">30件</option></select></label><label>配信出力の表示時間<select id="draft-holdSeconds"><option value="0">時間では消さない</option><option value="5">5秒</option><option value="15">15秒</option><option value="30">30秒</option></select></label><label>配信出力の新着位置<select id="draft-newestPosition"><option value="bottom">下</option><option value="top">上</option></select></label><p><small>サンプルは時間で消えません。雑談画面の履歴表示は変わりません。</small></p><details><summary>追加CSSをプレビュー</summary><label>CSS<textarea id="draft-css" rows="8" spellcheck="false"></textarea></label><p><small>.pokome-workspace 以下のCSSだけを使えます。画像URL・外部フォントは使えません。CSSエラー中は最後の有効なプレビューを表示し、適用できません。</small></p></details><button id="draft-reset" type="button">追加項目・配色・文章・画像・CSSを標準に戻して試す</button><p><small>既存の枠の配置は変わりません。「適用する」までは元のデザインを保持します。</small></p></div></div></dialog>`;
  const $ = id => shadow.getElementById(id), dialog = $('design-dialog'), frame = $('design-preview-frame');
  const modeCSS = document.createElement('style');
  modeCSS.textContent = 'dialog[data-mode=preset] .controls,dialog[data-mode=preset] .preview-pane>.viewport+p{display:none}dialog[data-mode=preset] .editor{grid-template-columns:minmax(0,1fr)}';
  shadow.append(modeCSS);
  const status = message => { $('design-status').textContent = message; };
  const currentItem = () => draft?.overlays.items.find(item => item.id === selected);
  const isCurrent = token => !!draft && token === epoch;
  const fieldKeys = ['theme','accentMode','accent','decoration','title','subtitle','footer','speechTitle','fontSize','speechFontSize','speechStyle','speechBackground','speechTextColor','commentStyle','maxVisible','holdSeconds','newestPosition'];
  function buttons() {
    $('apply-design').disabled = !previewStage || pending > 0 || !draft;
    $('draft-reset').disabled = !previewStage || !draft;
    $('add-text').disabled = !draft || draft.overlays.items.length >= MAX_OVERLAYS;
    $('overlay-image').disabled = !draft || draft.overlays.items.length >= MAX_OVERLAYS;
  }
  function fields() {
    if (!draft) return;
    const item = currentItem();
    $('overlay-select').replaceChildren(...draft.overlays.items.map((entry,index) => {
      const option = document.createElement('option'); option.value = entry.id;
      option.textContent = `${index+1}. ${entry.type === 'text' ? entry.text.slice(0,24) || '空の文字' : '画像'}${entry.hidden?'（非表示）':''}`; return option;
    }));
    $('overlay-select').value = selected;
    for (const key of ['x','y','w','h','z','text','color','font-size','hidden']) $(`overlay-${key}`).disabled = !item;
    $('delete-overlay').disabled = !item;
    $('overlay-text-fields').hidden = item?.type !== 'text';
    if (item) {
      for (const key of ['x','y','w','h','z']) $(`overlay-${key}`).value = Math.round(item[key]*100)/100;
      $('overlay-hidden').checked = item.hidden;
      if (item.type === 'text') { if ($('overlay-text').value !== item.text) $('overlay-text').value = item.text; $('overlay-color').value = item.color; $('overlay-font-size').value = item.fontSize; }
    }
    buttons();
  }
  function studioFields() {
    for (const key of fieldKeys) { const element = $(`draft-${key}`); if (element.type === 'checkbox') element.checked = draft.studio[key]; else element.value = draft.studio[key]; }
    $('draft-css').value = draft.theme;
  }
  // Portrait previews fit the height instead of stretching across the width.
  function scale() {
    const [width, height] = size($('preview-width').value), available = $('preview-viewport').parentElement.clientWidth;
    const factor = Math.min(available / width, Math.max(240, innerHeight * .7) / height);
    frame.style.width = `${width}px`; frame.style.height = `${height}px`; frame.style.transform = `scale(${factor})`;
    $('preview-viewport').style.width = `${width * factor}px`; $('preview-viewport').style.height = `${height * factor}px`;
  }
  new ResizeObserver(scale).observe($('preview-viewport').parentElement);
  // Edges viewers' apps may cover, drawn only in the preview.
  function drawGuides() {
    if (!frameDoc) return;
    let guides = frameDoc.getElementById('safe-guides');
    if (!guides) { guides = frameDoc.createElement('div'); guides.id = 'safe-guides'; frameDoc.body.append(guides); }
    guides.hidden = !$('preview-guides').checked;
    const area = SAFE_AREAS[draft?.ratio || previewRatio()];
    if (guides.dataset.ratio === (draft?.ratio || previewRatio())) return;
    guides.dataset.ratio = draft?.ratio || previewRatio();
    const box = (className, style, text) => { const element = frameDoc.createElement('div'); element.className = className; Object.assign(element.style, style); element.textContent = text; return element; };
    guides.replaceChildren(...(area.shade
      ? [box('guide-shade', { top: '0', height: `${area.top}%` }, 'アプリの表示で隠れやすい範囲'), box('guide-shade', { bottom: '0', height: `${area.bottom}%` }, 'アプリの表示で隠れやすい範囲')]
      : [box('guide-line', { top: `${area.top}%`, bottom: `${area.bottom}%`, left: `${area.left}%`, right: `${area.right}%` }, '文字を置かない目安')]));
  }
  function draw() {
    if (!previewStage || !draft) return;
    if (renderedStudio !== draft.studio) { renderStageAppearance(previewStage, resolveStudioImages(draft.studio, imageScope()), defaultImage); renderedStudio = draft.studio; }
    renderOverlays(previewStage, resolveOverlayAssets(draft.overlays, imageScope()));
    const sampleList = previewStage.querySelector('#stage-chat-list');
    renderStageComments(sampleList, selectOutputComments(SAMPLE_COMMENTS, draft.studio, 0, false));
    const themeStyle = frameDoc.getElementById('preview-theme');
    if (themeStyle.textContent !== compiledCSS) themeStyle.textContent = compiledCSS;
    // The draft CSS can change the speech minimum, which moves the panels below it.
    applyTalkLayout(previewStage, baseline.layouts[draft.ratio]);
    const old = new Map([...frameDoc.querySelectorAll('.overlay-hit')].map(element => [element.dataset.overlayId, element]));
    for (const item of presetDraft ? [] : draft.overlays.items) {
      let hit = old.get(item.id);
      if (!hit) {
        hit = frameDoc.createElement('div'); hit.className = 'overlay-hit'; hit.dataset.overlayId = item.id;
        for (const [resize,label] of [[false,'移動'],[true,'大きさ']]) {
          const button = frameDoc.createElement('button'); button.textContent = label; button.type = 'button'; button.dataset.resize = String(resize);
          button.setAttribute('aria-label', `${item.type === 'text' ? '文字' : '画像'}を${label}`);
          button.addEventListener('pointerdown', event => startMove(event,item.id,resize));
          button.addEventListener('keydown', event => keyMove(event,item.id,resize));
          hit.append(button);
        }
        frameDoc.body.append(hit);
      }
      old.delete(item.id);
      hit.dataset.selected = String(item.id === selected);
      hit.style.zIndex = 1000 + item.z; hit.style.opacity = item.hidden ? '.5' : '1';
    }
    for (const hit of old.values()) hit.remove();
    positionHits(); drawGuides();
    // Match the live workspace's responsive speech minimum without changing its
    // saved desktop coordinates when previewing another resolution.
    const speech = previewStage.querySelector('.stage-speech');
    if (speech.style.position === 'absolute') {
      const panel = baseline.layouts[draft.ratio]?.panels.speech;
      if (panel) speech.style.top = `min(${panel.y}%, max(0px, calc(100% - max(${panel.h}%, ${parseFloat(frame.contentWindow.getComputedStyle(speech).minHeight)||0}px))))`;
    }
    updateSampleVisibility(true);
  }
  function updateSampleVisibility(followNewest = false) {
    if (!previewStage || !draft) return;
    const list = previewStage.querySelector('#stage-chat-list');
    if (followNewest) list.scrollTop = draft.studio.newestPosition === 'top' ? 0 : list.scrollHeight;
    markClippedComments(list);
  }
  function positionHits() {
    if (!draft || !previewStage) return;
    const canvas = previewStage.getBoundingClientRect();
    for (const item of draft.overlays.items) {
      const hit = frameDoc.querySelector(`.overlay-hit[data-overlay-id="${item.id}"]`);
      const element = previewStage.querySelector(`.pokome-overlay[data-overlay-id="${item.id}"]`);
      if (!hit || !element) continue;
      const rect = item.hidden ? {
        left: canvas.left + item.x / 100 * previewStage.clientWidth - previewStage.scrollLeft,
        top: canvas.top + item.y / 100 * previewStage.clientHeight - previewStage.scrollTop,
        width: item.w / 100 * previewStage.clientWidth, height: item.h / 100 * previewStage.clientHeight,
      } : element.getBoundingClientRect();
      for (const key of ['left','top','width','height']) hit.style[key] = `${rect[key]}px`;
    }
  }
  function changedItem(id, patch) {
    if (!draft) return;
    revision++;
    draft.overlays = normalizeOverlays({ ...draft.overlays, items: draft.overlays.items.map(item => item.id === id ? {...item,...patch} : item) }, assetOptions());
    draw(); fields();
  }
  const resizePatch = (item, dx, dy) => ({
    w: Math.min(item.w + dx, 100 - item.x), h: Math.min(item.h + dy, 100 - item.y),
  });
  function startMove(event, id, resize) {
    if (!draft || event.button !== 0) return;
    event.preventDefault(); dragCleanup?.(); selected = id; fields(); draw();
    const original = clone(currentItem()), token = epoch, button = event.currentTarget;
    const canvas = previewStage.getBoundingClientRect();
    const width = previewStage.clientWidth * canvas.width / previewStage.offsetWidth, height = previewStage.clientHeight * canvas.height / previewStage.offsetHeight;
    if (!width || !height) return;
    // Pointer client coordinates inside the iframe use its unscaled CSS pixels.
    button.setPointerCapture(event.pointerId);
    const move = e => {
      if (!isCurrent(token)) return;
      const dx = (e.clientX-event.clientX)/width*100, dy = (e.clientY-event.clientY)/height*100;
      changedItem(id, resize ? resizePatch(original, dx, dy) : {x:original.x+dx,y:original.y+dy});
    };
    const finish = e => { cleanup(); if (e.type === 'pointercancel' && isCurrent(token)) changedItem(id, original); };
    const cleanup = () => { button.removeEventListener('pointermove',move); button.removeEventListener('pointerup',finish); button.removeEventListener('pointercancel',finish); dragCleanup = null; };
    dragCleanup = cleanup; button.addEventListener('pointermove',move); button.addEventListener('pointerup',finish); button.addEventListener('pointercancel',finish);
  }
  function keyMove(event,id,resize) {
    const delta = {ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
    if (!delta || !draft) return;
    event.preventDefault(); selected = id; const item = currentItem(), size = resize || event.shiftKey;
    changedItem(id, size ? resizePatch(item, ...delta) : {x:item.x+delta[0],y:item.y+delta[1]});
  }
  function invalidate() { epoch++; requests.clear(); pending = 0; dragCleanup?.(); }
  function close() {
    commentResizeObserver?.disconnect(); commentResizeObserver = null;
    invalidate(); draft = null; previewStage = null; renderedStudio = null; frameDoc = null; frame.removeAttribute('srcdoc');
    presetDraft = null; presetApply = null;
    if (dialog.open) dialog.close(); (returnFocus || $('open-design-preview')).focus(); returnFocus = null;
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('close', () => { if (draft) close(); });
  $('cancel-design').onclick = close;
  window.addEventListener('popstate', () => { if (draft) close(); });

  async function openPreview(preset = null, onApply = null) {
    if (draft) return;
    beginDraft(); if (!preset) themeEditor.beginChange(); invalidate(); const token = epoch; stale = false;
    presetDraft = preset; presetApply = onApply; returnFocus = document.activeElement;
    while (returnFocus?.shadowRoot?.activeElement) returnFocus = returnFocus.shadowRoot.activeElement;
    dialog.dataset.mode = preset ? 'preset' : 'editor';
    $('design-title').textContent = preset ? `「${preset.design.name}」を確認` : 'デザインを試す';
    $('preview-ratio-help').textContent = preset ? '比率を切り替えて配置と追加の文字・画像を確認してください。この画面では編集しません。「適用する」までは今のデザインを変えません。' : '比率ごとに、配置と追加の文字・画像を別々に保存します。サイズを変えると、その比率の内容を表示・編集します。';
    const design = preset?.design || designStore.design, ratio = previewRatio();
    baseline = {studio:visual(getStudio()), theme:themeEditor.getTheme(), layouts:Object.fromEntries(RATIOS.map(r => [r, talkLayout(design, r)])), revision:designStore.revision};
    const byRatio = Object.fromEntries(RATIOS.map(r => [r, talkOverlays(design, r)]));
    draft = {studio:clone(preset ? design.studio : getStudio()),theme:preset ? design.theme : baseline.theme,ratio,byRatio,overlays:byRatio[ratio]};
    selected = draft.overlays.items[0]?.id || ''; compiledCSS = compileTheme(draft.theme);
    dialog.showModal(); status('プレビューを準備しています…'); fields(); studioFields(); scale();
    try {
      if (!previewCSS) {
        const [cssResponse,imageResponse] = await Promise.all([fetch('./style.css'),fetch('./speech-background.svg')]);
        if (!cssResponse.ok || !imageResponse.ok) throw new Error('プレビュー用のデザインを読み込めません。');
        previewCSS = (await cssResponse.text()).replace(/^@import[^\r\n]*(?:\r?\n|$)/gm,'');
        defaultImage = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(await imageResponse.text())))}`;
      }
      if (!isCurrent(token)) return;
      await new Promise(resolve => {
        frame.onload = resolve;
        frame.srcdoc = '<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: \'self\'; font-src \'none\'; connect-src \'none\'; form-action \'none\'; base-uri \'none\'"></head><body class="talk-mode pokome-preview"></body></html>';
      });
      if (!isCurrent(token)) return;
      frameDoc = frame.contentDocument;
      const css = frameDoc.createElement('style'); css.textContent = previewCSS;
      const theme = frameDoc.createElement('style'); theme.id = 'preview-theme';
      const controls = frameDoc.createElement('style'); controls.textContent = `html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}.stage-controls,.stage-switch,.stage-font-controls,[data-layout-handle]{visibility:hidden!important}#talk-stage button{pointer-events:none}.overlay-hit{position:absolute;border:1px dashed #ace5cd;box-sizing:border-box;pointer-events:none}.overlay-hit[data-selected=true]{outline:2px solid #fff}.overlay-hit button{font:14px system-ui;padding:5px;background:#fff;color:#10291e;border:1px solid #174b39;cursor:move;touch-action:none;pointer-events:auto}.overlay-hit button:last-child{position:absolute;right:0;bottom:0;cursor:nwse-resize}.overlay-hit button:focus-visible{outline:3px solid #ffcc6f}#safe-guides{position:fixed;inset:0;pointer-events:none;z-index:900;font:12px system-ui}#safe-guides[hidden]{display:none}.guide-shade{position:absolute;left:0;right:0;background:repeating-linear-gradient(135deg,#ff4f6d55 0 10px,#ff4f6d22 10px 20px);color:#fff;text-shadow:0 1px 2px #000;display:flex;align-items:center;justify-content:center}.guide-line{position:absolute;border:2px dashed #ffcc6fcc;color:#ffcc6f;text-shadow:0 1px 2px #000;padding:4px}`;
      frameDoc.head.append(css, theme, controls);
      previewStage = frameDoc.importNode(live,true); previewStage.hidden = false;
      // The copy carries the live ratio's layout and edit frame; show the preview ratio's own.
      delete previewStage.dataset.frameRatio; previewStage.style.removeProperty('--frame');
      applyTalkLayout(previewStage, baseline.layouts[draft.ratio]);
      for (const element of previewStage.querySelectorAll('dialog,[popover],[data-layout-handle],.pokome-overlay,script,iframe,object,embed,link')) element.remove();
      for (const element of previewStage.querySelectorAll('button,input,select,textarea,a')) { element.setAttribute('tabindex','-1'); element.removeAttribute('href'); }
      previewStage.querySelector('#stage-speech-user').textContent = 'サンプルさん'; previewStage.querySelector('#stage-speech-text').textContent = '表示の色と大きさを確認しています。';
      previewStage.querySelector('#stage-speech-status').textContent = 'プレビュー'; previewStage.querySelector('.stage-speech').dataset.speaking = 'false';
      previewStage.querySelector('#stage-count').textContent = `${SAMPLE_COMMENTS.length} COMMENTS`;
      const main = frameDoc.createElement('main'); main.className = 'pokome-workspace'; main.append(previewStage); frameDoc.body.append(main);
      const sampleList = previewStage.querySelector('#stage-chat-list');
      sampleList.addEventListener('scroll', () => updateSampleVisibility(), { passive: true });
      commentResizeObserver = new ResizeObserver(() => updateSampleVisibility(true));
      commentResizeObserver.observe(sampleList);
      previewStage.addEventListener('scroll', positionHits, {passive:true});
      // Escape inside a nested browsing context does not reach the parent.
      frameDoc.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); close(); } });
      draw(); buttons(); status(preset ? 'プリセットの下書きを表示しています。比率を確認して「適用する」を押してください。' : 'プレビュー内だけの変更です。確認できたら「適用する」を押してください。');
    } catch (error) { if (isCurrent(token)) status(`プレビューを開けませんでした：${error.message}`); }
  }
  $('open-design-preview').onclick = () => openPreview();
  $('preview-width').onchange = () => {
    dragCleanup?.(); scale();
    const ratio = previewRatio();
    if (draft && ratio !== draft.ratio) {
      // Keep this ratio's edits and switch to the other ratio's own additions and layout.
      draft.byRatio[draft.ratio] = draft.overlays; draft.ratio = ratio; draft.overlays = draft.byRatio[ratio];
      selected = draft.overlays.items[0]?.id || ''; fields();
      if (previewStage) applyTalkLayout(previewStage, baseline.layouts[ratio]);
    }
    requestAnimationFrame(draw);
  };
  $('preview-guides').onchange = drawGuides;
  $('overlay-select').onchange = () => { selected = $('overlay-select').value; fields(); draw(); };
  $('add-text').onclick = () => {
    if (!draft || draft.overlays.items.length >= MAX_OVERLAYS) return;
    revision++; const item = createOverlay('text',{},draft.overlays.items); draft.overlays.items.push(item); selected = item.id; fields(); draw();
  };
  $('delete-overlay').onclick = () => {
    if (!currentItem()) return; revision++; draft.overlays = removeOverlay(draft.overlays,selected,assetOptions()); selected = draft.overlays.items[0]?.id || ''; fields(); draw();
  };
  for (const key of ['x','y','w','h','z','font-size','text','color','hidden']) {
    $(`overlay-${key}`).addEventListener(key === 'text' || key === 'color' ? 'input' : 'change', () => {
      const item = currentItem(); if (!item) return; const element = $(`overlay-${key}`);
      if (key === 'w' || key === 'h') {
        changedItem(selected, resizePatch(item, key === 'w' ? Number(element.value) - item.w : 0, key === 'h' ? Number(element.value) - item.h : 0));
        return;
      }
      changedItem(selected,{[key === 'font-size' ? 'fontSize' : key]: key === 'hidden' ? element.checked : ['text','color'].includes(key) ? element.value : Number(element.value)});
    });
  }
  $('overlay-image').onchange = async () => {
    const file = $('overlay-image').files[0]; $('overlay-image').value = '';
    if (!file || !draft || draft.overlays.items.length >= MAX_OVERLAYS) return;
    // The image belongs to the ratio shown when it was chosen, even if the view switches meanwhile.
    const token = epoch, request = Symbol(), ratio = draft.ratio;
    const target = () => ratio === draft.ratio ? draft.overlays : draft.byRatio[ratio];
    if (requests.has('add-image')) pending--;
    requests.set('add-image',request); pending++; buttons(); status('画像を確認しています…');
    try {
      await checkImageFile(file);
      if (!isCurrent(token) || requests.get('add-image') !== request) return;
      // The file is stored now, but stays unused until the draft is applied.
      const { ref } = await designStore.uploadImage(file);
      if (!isCurrent(token) || requests.get('add-image') !== request) return;
      const state = target();
      if (state.items.length >= MAX_OVERLAYS) throw new Error('追加できる項目は20個までです。');
      const asset = addOverlayAsset(state,ref,undefined,assetOptions()), item = createOverlay('image',{assetId:asset.assetId},state.items);
      const next = normalizeOverlays({...asset.state,items:[...asset.state.items,item]},assetOptions()); revision++;
      if (ratio !== draft.ratio) { draft.byRatio[ratio] = next; status(`画像を${ratio}の配置に追加しました。適用するまでは見た目に反映されません。`); return; }
      draft.overlays = next; selected = item.id; fields(); draw(); status('画像を追加しました。適用するまでは見た目に反映されません。');
    } catch (error) { if (isCurrent(token) && requests.get('add-image') === request) status(error.message); }
    finally { if (isCurrent(token) && requests.get('add-image') === request) { requests.delete('add-image'); pending--; buttons(); } }
  };
  for (const key of fieldKeys) $(`draft-${key}`).addEventListener('input', () => {
    if (!draft) return; revision++; const element = $(`draft-${key}`); draft.studio = normalizeStudio({...draft.studio,[key]:element.type === 'checkbox' ? element.checked : ['fontSize','speechFontSize','maxVisible','holdSeconds'].includes(key) ? Number(element.value) : element.value},imageOptions()); draw();
  });
  $('draft-css').oninput = () => {
    if (!draft) return; revision++; draft.theme = $('draft-css').value;
    try { compiledCSS = compileTheme(draft.theme); draw(); status('CSSをプレビューしました。適用するまでは保存されません。'); }
    catch (error) { status(error.message); }
  };
  $('draft-reset').onclick = () => {
    if (!draft || !previewStage) return; invalidate(); draft = {studio:normalizeStudio(),theme:'',ratio:draft.ratio,byRatio:Object.fromEntries(RATIOS.map(r => [r, normalizeOverlays()]))}; draft.overlays = draft.byRatio[draft.ratio]; compiledCSS = ''; selected = ''; fields(); studioFields(); draw(); status('標準の見た目をプレビューしています。キャンセルで戻せます。');
  };
  $('apply-design').onclick = async () => {
    if (!draft || pending || !previewStage) return;
    const token = epoch;
    pending++; buttons();
    try {
      if (stale || designStore.revision !== baseline.revision) throw new Error('別の画面で見た目が変更されました。キャンセルして開き直してください。');
      if (JSON.stringify(visual(getStudio())) !== JSON.stringify(baseline.studio) || themeEditor.getTheme() !== baseline.theme) throw new Error('編集開始後に見た目が変更されました。キャンセルして開き直してください。');
      compileTheme(draft.theme);
      if (presetDraft) {
        if (!await presetApply(presetDraft, baseline.revision)) return;
        if (!isCurrent(token)) return;
        close(); $('preview-result').textContent = 'プリセットを適用・保存しました。';
        return;
      }
      const next = normalizeStudio(draft.studio,imageOptions());
      draft.byRatio[draft.ratio] = draft.overlays;
      // One design.json write: studio, theme and every ratio's additions change together or not at all.
      let design = { ...designStore.design, studio: next, theme: draft.theme };
      for (const r of RATIOS) {
        const overlaysForRatio = normalizeOverlays(draft.byRatio[r],assetOptions());
        if (JSON.stringify(overlaysForRatio) !== JSON.stringify(talkOverlays(design, r))) design = withTalk(design, r, { overlays: overlaysForRatio });
      }
      await designStore.save(design);
      if (!isCurrent(token)) return;
      // All validation and persistence finishes before changing the live stage.
      themeEditor.reflectTheme(draft.theme); commitStudio(next); showLive(); close(); $('preview-result').textContent = 'デザインを適用・保存しました。';
    } catch (error) { if (isCurrent(token)) status(`適用できませんでした：${error.message}`); }
    finally { if (isCurrent(token)) { pending--; buttons(); } }
  };
  function showLive() { overlays = storedOverlays(); renderOverlays(live,resolveOverlayAssets(overlays)); }
  return {
    openPreset(preset, onApply) { return openPreview(structuredClone(preset), onApply); },
    reset() { if (draft) close(); overlays = normalizeOverlays(); renderOverlays(live,overlays); },
    // The talk screen switched ratio: show that ratio's additions.
    showLive,
    getOverlays: () => clone(overlays),
    // Another page saved the design: show it, and refuse to apply an older draft.
    // A failed save only restores the saved design; an open draft stays usable.
    reload(detail = { external: true }) {
      overlays = storedOverlays(); renderOverlays(live,resolveOverlayAssets(overlays));
      if (draft && detail.external) { stale = true; status('別の画面で見た目が変更されました。キャンセルして開き直してください。'); }
    },
  };
}
