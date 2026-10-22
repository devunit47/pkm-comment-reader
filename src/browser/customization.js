// Every edition runs on the local server; only the enabled services differ.
export function editionInfo(platforms) {
  return {
    title: platforms.includes('kick') ? 'ローカル開発版' : 'Windows ローカル配布版',
    services: platforms.includes('kick') ? 'Twitch・Kick（個別のチャット）' : 'Twitchのみ。Kickはローカル開発版のみ対応',
    speech: 'ブラウザ標準音声、VOICEVOX・COEIROINK v2（別途インストール・起動が必要）',
    files: 'customizationフォルダーのCSS・画像を一覧から選べます。ファイル選択での個別読み込みもできます',
  };
}

export function initializeCustomization({ platforms, designStore }) {
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
  document.querySelector('#setup-dialog .setup-actions').before(capabilities);
  document.getElementById('edition-label').textContent = `ぽこめ Reader / ${edition.title}`;
  document.getElementById('platform-help').textContent = `${edition.title} · ${platforms.includes('kick') ? 'Twitch・Kick' : 'Twitch専用'}`;

  // Keep protected-original guidance visible outside page navigation.
  const recovery = document.createElement('p'); recovery.id = 'appearance-recovery';
  recovery.setAttribute('role', 'status');
  document.body.append(recovery);
  const updateRecovery = () => {
    const protectedOriginal = designStore?.available && designStore.writable === false;
    recovery.textContent = protectedOriginal ? designStore.warning : '';
    recovery.hidden = !protectedOriginal || document.body.classList.contains('talk-mode');
  };
  designStore?.subscribe(updateRecovery);
  new MutationObserver(updateRecovery).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  updateRecovery();
}
