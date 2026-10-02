// Shared UI: Pages never requests the local file API.
export function editionInfo(publication, platforms) {
  const pages = publication === 'pages';
  return {
    title: pages ? 'GitHub Pages 公開版' : platforms.includes('kick') ? 'ローカル開発版' : 'Windows ローカル配布版',
    services: platforms.includes('kick') ? 'Twitch・Kick（個別のチャット）' : 'Twitchのみ。Kickはローカル開発版のみ対応',
    speech: pages ? 'ブラウザ標準音声のみ。VOICEVOX・COEIROINK v2は利用できません' : 'ブラウザ標準音声、VOICEVOX・COEIROINK v2（別途インストール・起動が必要）',
    files: pages ? 'PCのフォルダー一覧は取得できません。CSS・画像はファイル選択で個別に読み込めます' : 'customizationフォルダーのCSS・画像を一覧から選べます。ファイル選択での個別読み込みもできます',
  };
}

export function initializeCustomization({ publication, platforms, themeEditor, beginImageChange, applyImageFile, resetAppearance }) {
  const edition = editionInfo(publication, platforms);
  let styleRequest = 0, imageRequest = 0;
  const capabilities = document.createElement('section');
  capabilities.className = 'panel studio-form';
  capabilities.id = 'edition-capabilities';
  const fields = document.createElement('div'); fields.className = 'studio-fields';
  const heading = document.createElement('h2'); heading.textContent = `この版でできること：${edition.title}`;
  const list = document.createElement('ul');
  for (const text of [edition.services, edition.speech, edition.files,
    '両版とも配色・画像・CSS・配置の変更、設定の保存／復元ができます。設定はブラウザ内に保存され、公開URLとlocalhostでは別です',
    'コメントの送信・配信サービス側のBAN、カメラ／マイクの取得はできません。チャット接続にはインターネットが必要です']) {
    const item = document.createElement('li'); item.textContent = text; list.append(item);
  }
  fields.append(heading, list); capabilities.append(fields);
  document.getElementById('settings-page').prepend(capabilities);
  document.getElementById('edition-label').textContent = `ぽこめ Reader / ${edition.title}`;
  document.getElementById('platform-help').textContent = `${edition.title} · ${platforms.includes('kick') ? 'Twitch・Kick' : 'Twitch専用'}`;
  document.getElementById('setup-speech-help').textContent = publication === 'pages'
    ? '公開版はブラウザ標準音声で使えます。VOICEVOX・COEIROINKを使う場合はローカル版をご利用ください。'
    : '最初はブラウザ標準で使えます。VOICEVOX・COEIROINKは音声ソフトを起動してから声を取得します。';

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
    styleRequest++; imageRequest++;
    const saved = resetAppearance();
    dialog.close();
    shadow.getElementById('result').textContent = saved ? '標準の見た目に戻しました。' : '標準に戻しましたが保存できません。再起動前にブラウザの保存設定を確認してください。';
    shadow.getElementById('open-reset').focus();
  };
  const updateRecovery = () => { recovery.style.display = document.body.classList.contains('talk-mode') ? 'none' : 'block'; };
  new MutationObserver(updateRecovery).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  updateRecovery();

  if (publication === 'pages') {
    const note = document.createElement('p'); note.id = 'pages-customization-help'; note.className = 'studio-note';
    note.textContent = 'GitHub Pages公開版ではPCのカスタマイズフォルダーを一覧表示できません。下のファイル選択でCSS・画像を個別に読み込めます。フォルダー一覧とローカル音声ソフトはローカル版で使えます。';
    document.getElementById('studio-page').prepend(note);
    return;
  }

  const panel = document.createElement('section'); panel.id = 'local-customization'; panel.className = 'panel studio-form';
  panel.innerHTML = `<div class="studio-fields"><h2>ローカルのカスタマイズファイル</h2>
    <p>保存場所：<span id="customization-directory">取得中…</span></p>
    <p>CSSを customization/styles、画像を customization/images に置いて「一覧を更新」を押してください。フォルダー直下のファイルが対象です。ファイルはエクスプローラーなどで追加します。</p>
    <p>CSSは100KB、PNG・JPEG・WebP・GIFは512KBまで。適用した内容はこのブラウザにコピーして保存します。元ファイルを変更したら、もう一度適用してください。削除・移動しても適用済みの見た目は残ります。</p>
    <button id="refresh-customizations" class="button" type="button">一覧を更新</button>
    <label>スタイル（CSS）<select id="customization-style" disabled></select></label><button id="apply-customization-style" class="button" type="button" disabled>選んだスタイルを適用</button>
    <label>画像<select id="customization-image" disabled></select></label><label>画像を使う場所<select id="customization-image-target"><option value="image">立ち絵</option><option value="speechImage">名前・コメントの背景</option></select></label><button id="apply-customization-image" class="button" type="button" disabled>選んだ画像を適用</button>
    <p>標準のデザインと背景画像はアプリ本体に含まれ、このフォルダーには置きません。「見た目を標準に戻す」でいつでも復元できます。</p>
    <p id="customization-status" role="status" aria-live="polite"></p></div>`;
  document.getElementById('studio-page').prepend(panel);
  const $ = id => panel.querySelector(`#${id}`);
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
    $('customization-status').textContent = '一覧を取得しています…';
    try {
      const listing = await (await request('')).json();
      if (expected !== refreshGeneration) return;
      $('customization-directory').textContent = listing.directory;
      populate('customization-style', listing.styles, 'CSSファイルがありません');
      populate('customization-image', listing.images, '画像ファイルがありません');
      updateButtons();
      $('customization-status').textContent = `スタイル${listing.styles.length}件、画像${listing.images.length}件。${listing.skipped ? '対象外・読み込めないファイルは除外しました。' : ''}${listing.warnings?.join(' ') || ''}`;
    } catch (error) {
      if (expected !== refreshGeneration) return;
      $('customization-directory').textContent = '取得できませんでした';
      populate('customization-style', [], '一覧を取得できません'); populate('customization-image', [], '一覧を取得できません'); updateButtons();
      $('customization-status').textContent = `${error.message} ローカルサーバーから開いているか確認して「一覧を更新」で再試行してください。`;
    }
  }
  $('refresh-customizations').onclick = refresh;
  $('customization-style').onchange = updateButtons;
  $('customization-image').onchange = updateButtons;
  $('apply-customization-style').onclick = async () => {
    const name = $('customization-style').value; if (!name) return;
    const expected = themeEditor.beginChange(), requestId = ++styleRequest;
    $('customization-status').textContent = 'スタイルを読み込んでいます…';
    try {
      const css = await (await request(`/styles/${encodeURIComponent(name)}`)).text();
      const saved = themeEditor.applyTheme(css, expected);
      if (saved === null) return;
      $('customization-status').textContent = saved ? `${name} を適用・保存しました。` : 'スタイルを適用しましたが、保存できません。ブラウザの保存設定を確認してください。';
    } catch (error) { if (requestId === styleRequest) $('customization-status').textContent = `適用できませんでした：${error.message}`; }
  };
  $('apply-customization-image').onclick = async () => {
    const name = $('customization-image').value, target = $('customization-image-target').value; if (!name) return;
    const expected = beginImageChange(target), requestId = ++imageRequest;
    $('customization-status').textContent = '画像を読み込んでいます…';
    try {
      const blob = await (await request(`/images/${encodeURIComponent(name)}`)).blob();
      if (!await applyImageFile(blob, target, expected)) return;
      $('customization-status').textContent = `${name} を${target === 'image' ? '立ち絵' : '名前・コメントの背景'}に適用・保存しました。`;
    } catch (error) { if (requestId === imageRequest) $('customization-status').textContent = `適用できませんでした：${error.message}`; }
  };
  refresh();
}
