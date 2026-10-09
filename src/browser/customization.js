// Every edition runs on the local server; only the enabled services differ.
export function editionInfo(platforms) {
  return {
    title: platforms.includes('kick') ? 'ローカル開発版' : 'Windows ローカル配布版',
    services: platforms.includes('kick') ? 'Twitch・Kick（個別のチャット）' : 'Twitchのみ。Kickはローカル開発版のみ対応',
    speech: 'ブラウザ標準音声、VOICEVOX・COEIROINK v2（別途インストール・起動が必要）',
    files: 'customizationフォルダーのCSS・画像を一覧から選べます。ファイル選択での個別読み込みもできます',
  };
}

export function initializeCustomization({ platforms, designStore, resetAppearance, notify }) {
  const edition = editionInfo(platforms);
  const capabilities = document.createElement('section');
  capabilities.className = 'panel studio-form';
  capabilities.id = 'edition-capabilities';
  const fields = document.createElement('div'); fields.className = 'studio-fields';
  const heading = document.createElement('h2'); heading.textContent = `この版でできること：${edition.title}`;
  const list = document.createElement('ul');
  for (const text of [edition.services, edition.speech, edition.files,
    '配色・画像・CSS・配置の変更ができます。見た目はアプリのcustomizationフォルダー、接続先・音声などの設定はdata/settings.jsonに保存されます。同じアプリのフォルダーなら、ブラウザ・ポート・OBSのドックで同じ設定を使えます',
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
  recovery.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;max-width:calc(100vw - 24px);';
  const shadow = recovery.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>:host{font:14px system-ui}*{box-sizing:border-box}button{max-width:100%;overflow-wrap:anywhere;font:inherit;cursor:pointer;border:1px solid #ace5cd;border-radius:8px;background:#172b25;color:#f2fff8;padding:10px 14px}button:focus-visible{outline:3px solid #ace5cd;outline-offset:3px}dialog{font:15px system-ui;background:#1a2325;color:#edf4e9;border:1px solid #ace5cd;border-radius:12px;width:calc(100vw - 24px);max-width:460px;max-height:calc(100dvh - 24px);overflow:auto;padding:16px;line-height:1.7}dialog::backdrop{background:#0009}.actions{display:flex;flex-wrap:wrap;gap:12px}#result{max-width:min(320px,100%);overflow-wrap:anywhere;background:#172b25;color:#f2fff8;font:13px system-ui;line-height:1.6}#result:empty{display:none}</style>
    <button id="open-reset" type="button">見た目を標準に戻す</button><p id="result" role="status"></p>
    <dialog aria-labelledby="reset-title"><h2 id="reset-title">見た目を標準に戻しますか？</h2><p>出力の大きさ・配色・文章・画像・追加CSS・すべての比率の雑談画面の配置を標準に戻します。開いている下書きは適用できなくなります。接続先・音声・ユーザー管理設定と、customizationフォルダーの素材（styles・images）は残ります。</p><div class="actions"><button id="confirm-reset" type="button">標準に戻す</button><button id="cancel-reset" type="button">キャンセル</button></div></dialog>`;
  document.body.append(recovery);
  const dialog = shadow.querySelector('dialog');
  let protectedOriginal = false;
  const updateProtection = () => {
    const blocked = designStore?.available && designStore.writable === false;
    shadow.getElementById('open-reset').disabled = !!blocked;
    shadow.getElementById('confirm-reset').disabled = !!blocked;
    if (blocked) {
      dialog.close();
      shadow.getElementById('result').textContent = designStore.warning;
    } else if (protectedOriginal) shadow.getElementById('result').textContent = '';
    protectedOriginal = !!blocked;
  };
  // Only theme CSS can hide the operating page, so the control is offered while
  // CSS is applied, or while the protected original needs its warning.
  const updateRecovery = () => {
    const needed = !!designStore?.design.theme.trim() || (designStore?.available && designStore.writable === false);
    recovery.style.display = needed && !document.body.classList.contains('talk-mode') ? 'block' : 'none';
  };
  designStore?.subscribe(() => { updateProtection(); updateRecovery(); });
  updateProtection();
  shadow.getElementById('open-reset').onclick = () => { if (!dialog.open) dialog.showModal(); };
  shadow.getElementById('cancel-reset').onclick = () => dialog.close();
  shadow.getElementById('confirm-reset').onclick = async () => {
    dialog.close();
    // Cleared first, so the message always describes this reset once it is saved.
    shadow.getElementById('result').textContent = '';
    try {
      await resetAppearance();
      // The reset clears the CSS and hides this control, so announce it on the page.
      notify('標準の見た目に戻しました。');
    } catch (error) {
      shadow.getElementById('result').textContent = `標準に戻せませんでした：${error.message}`;
      shadow.getElementById('open-reset').focus();
    }
  };
  new MutationObserver(updateRecovery).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  updateRecovery();

}
