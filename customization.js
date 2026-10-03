// Every edition runs on the local server; only the enabled services differ.
export function editionInfo(platforms) {
  return {
    title: platforms.includes('kick') ? 'ローカル開発版' : 'Windows ローカル配布版',
    services: platforms.includes('kick') ? 'Twitch・Kick（個別のチャット）' : 'Twitchのみ。Kickはローカル開発版のみ対応',
    speech: 'ブラウザ標準音声、VOICEVOX・COEIROINK v2（別途インストール・起動が必要）',
    files: 'customizationフォルダーのCSS・画像を一覧から選べます。ファイル選択での個別読み込みもできます',
  };
}

// Independent operations retain their own outcome. A newer operation in the
// same channel or a full appearance reset invalidates only stale completions.
export function createCustomizationStatus(write) {
  let epoch = 0;
  const generations = new Map();
  return {
    begin(message, channel = 'shared') {
      const generation = (generations.get(channel) || 0) + 1;
      generations.set(channel, generation); write(message, channel);
      return { epoch, channel, generation };
    },
    finish(request, message) {
      if (request.epoch !== epoch || generations.get(request.channel) !== request.generation) return false;
      write(message, request.channel); return true;
    },
    clear(message = '') { epoch++; generations.clear(); write(message, null); },
  };
}

export async function runCustomizationApply(status, { loading, read, apply, success, cancelled, unsaved = cancelled, channel = 'shared' }) {
  const request = status.begin(loading, channel);
  try {
    const result = await apply(await read());
    status.finish(request, result === null ? cancelled : result ? success : unsaved);
  } catch (error) {
    status.finish(request, `適用できませんでした：${error.message}`);
  }
}

export function initializeCustomization({ platforms, themeEditor, beginImageChange, applyImageFile, resetAppearance }) {
  const edition = editionInfo(platforms);
  let localStatus;
  const capabilities = document.createElement('section');
  capabilities.className = 'panel studio-form';
  capabilities.id = 'edition-capabilities';
  const fields = document.createElement('div'); fields.className = 'studio-fields';
  const heading = document.createElement('h2'); heading.textContent = `この版でできること：${edition.title}`;
  const list = document.createElement('ul');
  for (const text of [edition.services, edition.speech, edition.files,
    '配色・画像・CSS・配置の変更、設定の保存／復元ができます。設定はこのブラウザ内に保存されます',
    'コメントの送信・配信サービス側のBAN、カメラ／マイクの取得はできません。チャット接続にはインターネットが必要です']) {
    const item = document.createElement('li'); item.textContent = text; list.append(item);
  }
  fields.append(heading, list); capabilities.append(fields);
  document.getElementById('settings-page').prepend(capabilities);
  document.getElementById('edition-label').textContent = `ぽこめ Reader / ${edition.title}`;
  document.getElementById('platform-help').textContent = `${edition.title} · ${platforms.includes('kick') ? 'Twitch・Kick' : 'Twitch専用'}`;

  // Outside the theme's permitted scope, with a Shadow DOM and modal top layer:
  // even a theme hiding main/sidebar cannot hide the recovery controls.
  const recovery = document.createElement('div'); recovery.id = 'appearance-recovery';
  recovery.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;';
  const shadow = recovery.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>:host{font:14px system-ui}button{font:inherit;cursor:pointer;border:1px solid #ace5cd;border-radius:8px;background:#172b25;color:#f2fff8;padding:10px 14px}button:focus-visible{outline:3px solid #ace5cd;outline-offset:3px}dialog{font:15px system-ui;background:#1a2325;color:#edf4e9;border:1px solid #ace5cd;border-radius:12px;width:min(460px,80vw);line-height:1.7}dialog::backdrop{background:#0009}.actions{display:flex;flex-wrap:wrap;gap:12px}#result{max-width:320px;background:#172b25;color:#f2fff8;font:13px system-ui;line-height:1.6}#result:empty{display:none}</style>
    <button id="open-reset" type="button">見た目を標準に戻す</button><p id="result" role="status"></p>
    <dialog aria-labelledby="reset-title"><h2 id="reset-title">見た目を標準に戻しますか？</h2><p>配色・文章・画像・追加CSS・ホームと雑談画面の配置を組み込みの標準に戻します。接続先・音声・ユーザー管理設定と、フォルダー内のファイルは残ります。</p><div class="actions"><button id="confirm-reset" type="button">標準に戻す</button><button id="cancel-reset" type="button">キャンセル</button></div></dialog>`;
  document.body.append(recovery);
  const dialog = shadow.querySelector('dialog');
  shadow.getElementById('open-reset').onclick = () => { if (!dialog.open) dialog.showModal(); };
  shadow.getElementById('cancel-reset').onclick = () => dialog.close();
  shadow.getElementById('confirm-reset').onclick = () => {
    const saved = resetAppearance();
    dialog.close();
    const message = saved ? '標準の見た目に戻しました。' : '標準に戻しましたが保存できません。再起動前にブラウザの保存設定を確認してください。';
    shadow.getElementById('result').textContent = message;
    localStatus?.clear(message);
    shadow.getElementById('open-reset').focus();
  };
  const updateRecovery = () => { recovery.style.display = document.body.classList.contains('talk-mode') ? 'none' : 'block'; };
  new MutationObserver(updateRecovery).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  updateRecovery();

  const panel = document.createElement('section'); panel.id = 'local-customization'; panel.className = 'panel studio-form';
  panel.innerHTML = `<div class="studio-fields"><h2>ローカルのカスタマイズファイル</h2>
    <p>保存場所：<span id="customization-directory">取得中…</span></p>
    <p>CSSを customization/styles、画像を customization/images に置いて「一覧を更新」を押してください。フォルダー直下のファイルが対象です。ファイルはエクスプローラーなどで追加します。</p>
    <p>CSSは100KB、PNG・JPEG・WebP・GIFは512KBまで。適用した内容はこのブラウザにコピーして保存します。元ファイルを変更したら、もう一度適用してください。削除・移動しても適用済みの見た目は残ります。</p>
    <button id="refresh-customizations" class="button" type="button">一覧を更新</button>
    <label>スタイル（CSS）<select id="customization-style" disabled></select></label><button id="apply-customization-style" class="button" type="button" disabled>選んだスタイルを適用</button>
    <label>画像<select id="customization-image" disabled></select></label><label>画像を使う場所<select id="customization-image-target"><option value="image">立ち絵</option><option value="speechImage">名前・コメントの背景</option></select></label><button id="apply-customization-image" class="button" type="button" disabled>選んだ画像を適用</button>
    <p>標準のデザインと背景画像はアプリ本体に含まれ、このフォルダーには置きません。「見た目を標準に戻す」でいつでも復元できます。</p>
    <div id="customization-status" role="status" aria-live="polite"></div></div>`;
  document.getElementById('studio-page').prepend(panel);
  const $ = id => panel.querySelector(`#${id}`);
  localStatus = createCustomizationStatus((message, channel) => {
    const container = $('customization-status');
    if (channel === null) { container.textContent = message; return; }
    let result = container.querySelector(`[data-status-channel="${channel}"]`);
    if (!result) {
      // Remove the plain reset notification when the next operation begins.
      if (!container.children.length) container.textContent = '';
      result = document.createElement('p'); result.dataset.statusChannel = channel;
      container.append(result);
    }
    result.textContent = message;
  });
  let refreshGeneration = 0;
  async function request(path) {
    const response = await fetch(`./api/customizations${path}`, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      let message = 'ファイルを取得できません。一覧を更新し、保存場所とファイルを確認してください。';
      try { message = (await response.json()).error || message; } catch { /* Static or interrupted servers may return text. */ }
      throw new Error(message);
    }
    return response;
  }
  function populate(id, files, empty) {
    const select = $(id), previous = select.value;
    select.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = files.length ? 'ファイルを選択してください' : empty; select.append(placeholder);
    for (const file of files) { const option = document.createElement('option'); option.value = file.name; option.textContent = `${file.name}（${Math.ceil(file.size / 1024)}KB）`; select.append(option); }
    if (files.some(file => file.name === previous)) select.value = previous;
    select.disabled = !files.length;
  }
  function updateButtons() {
    $('apply-customization-style').disabled = !$('customization-style').value;
    $('apply-customization-image').disabled = !$('customization-image').value;
  }
  async function refresh() {
    const expected = ++refreshGeneration;
    const statusRequest = localStatus.begin('一覧を取得しています…', 'listing');
    try {
      const listing = await (await request('')).json();
      if (expected !== refreshGeneration) return;
      $('customization-directory').textContent = listing.directory;
      populate('customization-style', listing.styles, 'CSSファイルがありません');
      populate('customization-image', listing.images, '画像ファイルがありません');
      updateButtons();
      localStatus.finish(statusRequest, `スタイル${listing.styles.length}件、画像${listing.images.length}件。${listing.skipped ? '対象外・読み込めないファイルは除外しました。' : ''}${listing.warnings?.join(' ') || ''}`);
    } catch (error) {
      if (expected !== refreshGeneration) return;
      $('customization-directory').textContent = '取得できませんでした';
      populate('customization-style', [], '一覧を取得できません'); populate('customization-image', [], '一覧を取得できません'); updateButtons();
      localStatus.finish(statusRequest, `${error.message} ローカルサーバーから開いているか確認して「一覧を更新」で再試行してください。`);
    }
  }
  $('refresh-customizations').onclick = refresh;
  $('customization-style').onchange = updateButtons;
  $('customization-image').onchange = updateButtons;
  $('apply-customization-style').onclick = () => {
    const name = $('customization-style').value; if (!name) return;
    const expected = themeEditor.beginChange();
    return runCustomizationApply(localStatus, {
      channel: 'css',
      loading: 'スタイルを読み込んでいます…',
      read: async () => (await request(`/styles/${encodeURIComponent(name)}`)).text(),
      apply: css => themeEditor.applyTheme(css, expected),
      success: `${name} を適用・保存しました。`,
      cancelled: '別の操作が優先されたため、スタイルの読み込みを中止しました。',
      unsaved: 'スタイルを適用しましたが、保存できません。ブラウザの保存設定を確認してください。',
    });
  };
  $('apply-customization-image').onclick = () => {
    const name = $('customization-image').value, target = $('customization-image-target').value; if (!name) return;
    const expected = beginImageChange(target);
    return runCustomizationApply(localStatus, {
      channel: target,
      loading: '画像を読み込んでいます…',
      read: async () => (await request(`/images/${encodeURIComponent(name)}`)).blob(),
      apply: blob => applyImageFile(blob, target, expected),
      success: `${name} を${target === 'image' ? '立ち絵' : '名前・コメントの背景'}に適用・保存しました。`,
      cancelled: '別の操作が優先されたため、画像の読み込みを中止しました。',
    });
  };
  refresh();
}
