import { OUTPUT_PREFERENCES_KEY, OUTPUT_SIZES, normalizeOutputPreferences, outputUrl } from '../shared/output-protocol.js';

const SIZE_LABELS = { '1920x1080': '1920 × 1080（横）', '1280x720': '1280 × 720（横）', '1080x1920': '1080 × 1920（縦）', '1440x1080': '1440 × 1080（4:3）' };

// Controls for opening the stream output. The output itself has no controls,
// so everything a streamer needs to set up OBS lives on this page.
// The output size belongs to the design (saved in the customization folder);
// the background mode and key color depend on this PC's OBS setup and stay here.
export function initializeOutputPanel({ storage, designStore, publisher, getStudio = () => null, openEditor = () => {} }) {
  let preferences;
  try { preferences = normalizeOutputPreferences(JSON.parse(storage?.getItem(OUTPUT_PREFERENCES_KEY) || 'null')); }
  catch { preferences = normalizeOutputPreferences(); }
  preferences.size = designStore.design.outputSize;
  const section = document.createElement('section');
  section.className = 'panel studio-form';
  section.id = 'stream-output-panel';
  section.setAttribute('aria-labelledby', 'stream-output-title');
  section.innerHTML = `<div class="panel-heading"><h2 id="stream-output-title">✧ 配信出力（OBS用）</h2></div><div class="studio-fields">
    <p class="muted">配信に映す画面だけを、別に開きます。ボタンや案内は映りません。チャットの接続と読み上げはこの画面が行い、出力からは音が出ません。</p>
    <p id="output-status" role="status" aria-live="polite"></p>
    <fieldset class="studio-category"><legend>① ウィンドウキャプチャで取り込む</legend>
    <p class="muted">このブラウザで出力ウィンドウを開き、OBSの「ウィンドウキャプチャ」で取り込みます。</p>
    <label>背景<select id="output-background"><option value="theme">テーマの背景をそのまま映す</option><option value="key">単色にする（OBSのクロマキーで抜く）</option></select></label>
    <label>抜く色<select id="output-key" aria-describedby="output-key-help"><option value="00ff00">緑</option><option value="ff00ff">マゼンタ</option><option value="0000ff">青</option></select></label>
    <p class="muted" id="output-key-help">OBSで取り込んだソースに「クロマキー」フィルターを追加し、同じ色を選びます。文字の縁取り・影・半透明の枠には背景色がにじむことがあります。きれいに重ねたい場合は②を使ってください。</p>
    <p>適用中の出力の大きさ：<span id="output-size-value"></span></p><div><button id="edit-output-size" class="button" type="button">エディタで変更</button></div>
    <div><button id="open-output-window" class="button primary" type="button">配信出力ウィンドウを開く</button></div>
    <ul class="muted output-notes"><li>OBSのキャプチャ方式は「Windows 10（1903以降）」を選んでください。</li><li>上端のアドレス表示は、OBSでソースをAltキーを押しながらドラッグして切り取ります。</li><li>出力ウィンドウを最小化したり、ほかのウィンドウで完全に隠したりすると、表示が止まることがあります。</li><li>画面より大きいサイズは、ブラウザが画面に収まる大きさに縮めます。実際の大きさは上の状態表示で確認できます。</li></ul>
    </fieldset>
    <fieldset class="studio-category"><legend>② OBSのブラウザソースで取り込む（背景を透明にする）</legend>
    <p class="muted">OBSは普段のブラウザと保存先が別のため、この操作画面もOBSの中で開きます。</p>
    <ol class="muted output-notes"><li>OBSの「ドック」→「カスタムブラウザドック」に、操作画面のURLを追加します。チャンネルの接続や見た目の設定は、そのドックで行います。</li><li>シーンに「ブラウザ」ソースを追加し、出力のURLと大きさ（例：1920 × 1080）を入力します。</li><li>読み上げの音はドックから鳴ります。配信に音が入っているか、OBSの音声ミキサーで確認してください。</li></ol>
    <label>操作画面のURL（ドック用）<input id="output-control-url" readonly></label><div><button id="copy-control-url" class="button" type="button">操作画面のURLをコピー</button></div>
    <label>出力のURL（ブラウザソース用）<input id="output-source-url" readonly></label><div><button id="copy-source-url" class="button" type="button">出力のURLをコピー</button></div>
    <p class="muted">OBS以外のブラウザで出力のURLを開くと、透明の部分は白く見えます。</p>
    </fieldset></div>`;
  document.getElementById('studio-page').prepend(section);
  const $ = id => section.querySelector(`#${id}`);
  const status = $('output-status');
  let message = '';
  $('output-control-url').value = new URL('./', location.href).href;
  $('output-source-url').value = outputUrl(location.href, { background: 'transparent' });

  function render() {
    $('output-background').value = preferences.background;
    $('output-key').value = preferences.key;
    $('output-key').disabled = preferences.background !== 'key';
    $('output-size-value').textContent = SIZE_LABELS[preferences.size];
  }
  function update() {
    preferences = normalizeOutputPreferences({ background: $('output-background').value, key: $('output-key').value, size: designStore.design.outputSize });
    try { storage?.setItem(OUTPUT_PREFERENCES_KEY, JSON.stringify({ background: preferences.background, key: preferences.key })); } catch { /* Preferences are a convenience. */ }
    render();
    setStatus(publisher.status());
  }
  for (const id of ['output-background', 'output-key']) $(id).onchange = update;
  $('edit-output-size').onclick = openEditor;
  $('open-output-window').onclick = () => {
    const [width, height] = OUTPUT_SIZES[preferences.size];
    // A fixed name reuses one output window instead of opening another.
    const output = window.open(outputUrl(location.href, preferences), 'pokome-output', `popup,width=${width},height=${height}`);
    if (!output) { message = 'ポップアップがブロックされました。ブラウザのアドレスバーからポップアップを許可して、もう一度押してください。'; setStatus(publisher.status()); return; }
    message = '';
    // A reused named window ignores the size features, so resize it to the
    // chosen viewport size, accounting for its own frame and address bar.
    if (output.innerWidth && output.innerHeight && (output.innerWidth !== width || output.innerHeight !== height)) {
      try { output.resizeTo(width + output.outerWidth - output.innerWidth, height + output.outerHeight - output.innerHeight); }
      catch { /* The status shows the actual size reported by the output. */ }
    }
    output.focus();
  };
  for (const [button, input] of [['copy-control-url', 'output-control-url'], ['copy-source-url', 'output-source-url']]) {
    $(button).onclick = async () => {
      try { await navigator.clipboard.writeText($(input).value); message = 'URLをコピーしました。'; }
      catch { $(input).select(); message = 'コピーできませんでした。選択したURLを Ctrl+C でコピーしてください。'; }
      setStatus(publisher.status());
    };
  }

  function setStatus(value) {
    const parts = [];
    if (!value.supported) parts.push('このブラウザは配信出力に対応していません。');
    else if (!value.outputs.length) parts.push('配信出力：未接続');
    else {
      const sizes = value.outputs.map(output => output.width && output.height ? `${output.width} × ${output.height}` : '大きさ不明');
      parts.push(`配信出力：${value.outputs.length}個 接続中（${sizes.join('、')}）`);
    }
    // A chroma key leaves fringes around a half-transparent comment panel.
    const look = getStudio();
    if (preferences.background === 'key' && look && ['light', 'dark'].includes(look.commentPanel) && look.commentPanelOpacity < 100) {
      parts.push('コメント欄のパネルが半透明のため、単色の背景を抜くと色がにじみます。不透明度を100%にするか、②のブラウザソースを使ってください。');
    }
    if (value.otherControllers) parts.push('別の操作画面も配信出力に接続しています。表示が切り替わらないよう、操作画面は1つだけ開いてください。');
    if (message) parts.push(message);
    status.textContent = parts.join(' ');
  }
  render();
  setStatus(publisher.status());
  return { setStatus, refresh: () => setStatus(publisher.status()), reload() { preferences.size = designStore.design.outputSize; render(); setStatus(publisher.status()); } };
}
