import { createPresetClient } from './design-client.js';
import { normalizePresetName } from '../shared/design-model.js';

export function initializeDesignPresets({ designStore, designPreview }) {
  const client = createPresetClient(designStore), host = document.createElement('div');
  host.id = 'design-presets'; document.getElementById('studio-page').prepend(host, document.getElementById('design-preview-editor'));
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{display:block;color:var(--text,#edf4e9);font:14px system-ui;margin-bottom:24px}*{box-sizing:border-box}[hidden],dialog:not([open]){display:none}section{background:var(--panel,#1a2325);border:1px solid #506960;border-radius:12px;padding:24px}h2{font-size:20px;margin:0 0 12px}p{line-height:1.7;margin:8px 0;overflow-wrap:anywhere}.muted,small{color:#b2c2b8}label{display:grid;gap:8px;margin:14px 0}button,input,select{font:inherit;background:#101b18;color:#edf4e9;border:1px solid #70877b;border-radius:6px;padding:10px;min-height:44px;max-width:100%}select,input{width:100%;min-width:0}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #ace5cd;outline-offset:2px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.primary{background:#ace5cd;color:#11271e;font-weight:700}.danger{border-color:#e798a6;color:#ffc7d0}#preset-status{min-height:24px}ul{padding-left:20px;line-height:1.7;overflow-wrap:anywhere}dialog{background:#101a18;color:#edf4e9;border:1px solid #ace5cd;border-radius:12px;width:calc(100vw - 24px);max-width:560px;max-height:calc(100dvh - 24px);padding:24px;overflow:auto}dialog::backdrop{background:#000b}.error{color:#ffc7d0}@media(max-width:540px){section,dialog{padding:16px}.actions button{flex:1 1 140px}}
  </style><section aria-labelledby="presets-title"><h2 id="presets-title">デザインのプリセット</h2><p class="muted">画像・テーマCSS・すべての比率の配置をまとめて保存します。読み込みはプレビューで確認してから適用します。</p><div class="actions"><button id="preset-save" class="primary" type="button">今のデザインを保存</button><button id="preset-reset" type="button">標準へ戻す</button></div><label>保存したプリセット<select id="preset-select"><option value="">プリセットを選んでください</option></select></label><p id="preset-details" class="muted"></p><div class="actions"><button id="preset-load" class="primary" type="button">読み込む</button><button id="preset-overwrite" type="button">上書き保存</button><button id="preset-rename" type="button">名前を変える</button><button id="preset-delete" class="danger" type="button">削除</button></div><div class="actions"><button id="preset-refresh" type="button">一覧を更新</button><button id="preset-folder" type="button">フォルダーを開く</button></div><p id="preset-status" role="status" aria-live="polite"></p><ul id="preset-errors" aria-label="読み込めないプリセット" hidden></ul><p><small>配信出力の背景モード・クロマキー色、接続先・音声・コメント履歴はプリセットに含みません。</small></p></section>
  <dialog id="preset-name-dialog" aria-labelledby="preset-name-title"><form id="preset-name-form"><h2 id="preset-name-title">今のデザインを保存</h2><label>プリセットの名前<input id="preset-name" type="text" required aria-describedby="preset-name-help preset-name-error" autocomplete="off"></label><p id="preset-name-help" class="muted">1〜40文字。絵文字も1文字として数えます。同じ名前で保存できます。改行・制御文字は使えません。</p><p id="preset-name-error" class="error" role="status"></p><div class="actions"><button id="preset-name-submit" class="primary" type="submit">保存する</button><button id="preset-name-cancel" type="button">キャンセル</button></div></form></dialog>
  <dialog id="preset-confirm-dialog" aria-labelledby="preset-confirm-title" aria-describedby="preset-confirm-message"><h2 id="preset-confirm-title">デザインを確認</h2><p id="preset-confirm-message"></p><div class="actions"><button id="preset-confirm" class="primary" type="button">実行する</button><button id="preset-confirm-cancel" type="button">キャンセル</button></div></dialog>`;
  const $ = id => shadow.getElementById(id);
  let presets = [], busy = false, nameAction = null, confirmation = null;
  const selected = () => presets.find(preset => preset.id === $('preset-select').value && !preset.error);
  const status = message => { $('preset-status').textContent = message; };
  function buttons() {
    for (const id of ['save', 'reset']) $(`preset-${id}`).disabled = busy || !designStore.available || designStore.writable === false;
    for (const id of ['refresh', 'folder']) $(`preset-${id}`).disabled = busy || !designStore.available;
    for (const id of ['load', 'overwrite']) $(`preset-${id}`).disabled = busy || !selected() || !designStore.available || designStore.writable === false;
    for (const id of ['rename', 'delete']) $(`preset-${id}`).disabled = busy || !selected() || !designStore.available;
    $('preset-select').disabled = busy;
    const preset = selected();
    $('preset-details').textContent = preset ? `id: ${preset.id} ／ 更新: ${formatDate(preset.updatedAt)}` : '';
  }
  function formatDate(value) {
    const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString('ja-JP') : '日時不明';
  }
  function renderList(wanted = $('preset-select').value) {
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = presets.length ? 'プリセットを選んでください' : '保存したプリセットはありません';
    $('preset-select').replaceChildren(placeholder, ...presets.map(preset => {
      const option = document.createElement('option'); option.value = preset.id; option.disabled = !!preset.error;
      option.textContent = preset.error ? `${preset.name || preset.id}（読み込み不可: ${preset.error}）` : `${preset.name} ／ ${formatDate(preset.updatedAt)} ／ ${preset.id}`;
      return option;
    }));
    $('preset-select').value = presets.some(preset => preset.id === wanted && !preset.error) ? wanted : '';
    const invalid = presets.filter(preset => preset.error);
    $('preset-errors').replaceChildren(...invalid.map(preset => {
      const item = document.createElement('li'); item.textContent = `${preset.name || preset.id}: ${preset.error}`; return item;
    }));
    $('preset-errors').hidden = !invalid.length; buttons();
  }
  async function refresh(wanted) {
    const value = await client.list(); presets = value.presets; renderList(wanted);
  }
  async function run(operation) {
    if (busy) return;
    busy = true; buttons(); status('処理しています…');
    try { await operation(); }
    catch (error) { status(error.message); }
    finally { busy = false; buttons(); }
  }
  function confirm(title, message, action) {
    const dialog = $('preset-confirm-dialog');
    $('preset-confirm-title').textContent = title; $('preset-confirm-message').textContent = message; $('preset-confirm').textContent = action;
    return new Promise(resolve => { confirmation = resolve; dialog.showModal(); $('preset-confirm-cancel').focus(); });
  }
  function finishConfirmation(accepted) {
    const resolve = confirmation; confirmation = null;
    $('preset-confirm-dialog').close(); resolve?.(accepted);
  }
  $('preset-confirm').onclick = () => finishConfirmation(true);
  $('preset-confirm-cancel').onclick = () => finishConfirmation(false);
  $('preset-confirm-dialog').addEventListener('cancel', event => { event.preventDefault(); finishConfirmation(false); });
  $('preset-confirm-dialog').addEventListener('close', () => { if (confirmation) finishConfirmation(false); });
  function askName(preset = null) {
    nameAction = preset;
    $('preset-name-title').textContent = preset ? 'プリセットの名前を変える' : '今のデザインを保存';
    $('preset-name-submit').textContent = preset ? '名前を変える' : '保存する';
    $('preset-name').value = preset?.name || designStore.design.name; $('preset-name-error').textContent = '';
    $('preset-name-dialog').showModal(); $('preset-name').focus(); $('preset-name').select();
  }
  $('preset-save').onclick = () => askName();
  $('preset-rename').onclick = () => { if (selected()) askName(selected()); };
  $('preset-name-cancel').onclick = () => $('preset-name-dialog').close();
  $('preset-name-form').onsubmit = event => {
    event.preventDefault(); let name;
    try { name = normalizePresetName($('preset-name').value); }
    catch (error) { $('preset-name-error').textContent = error.message; $('preset-name').focus(); return; }
    const preset = nameAction;
    $('preset-name-dialog').close();
    run(async () => {
      const result = preset ? await client.rename(preset, name) : await client.create(name);
      await refresh(result.id || preset?.id); status(preset ? 'プリセットの名前を変更しました。' : '今のデザインをプリセットに保存しました。');
    });
  };
  $('preset-select').onchange = buttons;
  $('preset-refresh').onclick = () => run(async () => { await refresh(); status('プリセットの一覧を更新しました。'); });
  $('preset-load').onclick = () => run(async () => {
    const choice = selected(); if (!choice) return;
    await designStore.waitForSaves();
    let preset;
    try { preset = await client.read(choice.id); }
    catch (error) { choice.error = error.message; renderList(); throw error; }
    await designPreview.openPreset(preset, async (draft, currentRevision) => {
      if (!await confirm('プリセットを適用', `「${draft.design.name}」を適用しますか？ 今のデザイン全体が置き換わります。`, '適用する')) return false;
      await designStore.applyPreset(draft, currentRevision); status('プリセットを適用しました。'); return true;
    });
    status('プリセットをプレビューに読み込みました。適用するまでは今のデザインを変えません。');
  });
  $('preset-overwrite').onclick = () => run(async () => {
    const preset = selected(); if (!preset) return;
    if (!await confirm('プリセットを上書き', `「${preset.name}」を今のデザインで上書きしますか？`, '上書き保存')) { status('上書きをキャンセルしました。'); return; }
    await client.overwrite(preset); await refresh(preset.id); status('プリセットを上書き保存しました。');
  });
  $('preset-delete').onclick = () => run(async () => {
    const preset = selected(); if (!preset) return;
    if (!await confirm('プリセットを削除', `「${preset.name}」を削除しますか？ このプリセットのフォルダーを削除します。`, '削除する')) { status('削除をキャンセルしました。'); return; }
    await client.remove(preset); await refresh(''); status('プリセットを削除しました。');
  });
  $('preset-reset').onclick = () => run(async () => {
    const currentRevision = await designStore.waitForSaves();
    if (!await confirm('標準へ戻す', '今のデザイン全体を標準に戻しますか？ 保存済みのプリセットは残ります。', '標準へ戻す')) { status('標準へ戻す操作をキャンセルしました。'); return; }
    await designStore.reset(currentRevision); status('今のデザイン全体を標準へ戻しました。');
  });
  $('preset-folder').onclick = () => run(async () => {
    const result = await client.openFolder(selected()?.id);
    status(result.opened ? 'プリセットのフォルダーを開きました。' : `フォルダーの場所: ${result.directory}`);
  });
  designStore.subscribe(buttons);
  run(async () => { await refresh(); status(''); });
  return { refresh: () => run(async () => { await refresh(); status('プリセットの一覧を更新しました。'); }) };
}
