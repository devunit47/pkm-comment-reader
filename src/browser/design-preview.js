import { normalizeStudio, applyCommentPreset, matchCommentPreset, COMMENT_PRESETS } from '../shared/studio.js';
import { compileTheme, DEFAULT_THEME_CSS, MAX_THEME_CSS_BYTES } from '../shared/theme.js';
import { OUTPUT_SIZES } from '../shared/output-protocol.js';
import { renderStageAppearance, renderOverlays, renderStageComments, selectOutputComments, markClippedComments, applyTalkLayout } from './stage-appearance.js';
import { MAX_OVERLAYS, normalizeOverlays, createOverlay, removeOverlay, addOverlayAsset, overlayBounds } from '../shared/overlay-model.js';
import { resolveStudioImages, resolveOverlayAssets, studioOptions, overlayOptions, PREVIEW_SIZES, SAFE_AREAS, nearestRatio, talkLayout, talkOverlays, talkActorImage, normalizeActorImage, withTalk, defaultDesign } from '../shared/design-model.js';
import { checkImageFile, STALE_DRAFT } from './design-client.js';
import { createDraftSession } from '../shared/design-draft.js';

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
// The five panels are chosen from the list; their placement is edited in E3.
const PANEL_TARGETS = Object.freeze([['screen', '画面全体'], ['header', 'ヘッダー（タイトル）'], ['chat', 'コメント欄'], ['speech', '読み上げ'], ['actor', '立ち絵'], ['footer', 'フッター']]);
const TYPED_KEYS = ['title', 'subtitle', 'footer', 'speechTitle', 'accent', 'speechBackground', 'speechTextColor', 'fontSize', 'commentItemOpacity', 'commentPanelOpacity', 'commentOutlineColor'];
const NUMBER_KEYS = ['fontSize', 'speechFontSize', 'maxVisible', 'holdSeconds', 'commentItemOpacity', 'commentPanelOpacity'], NULLABLE_KEYS = ['commentMaxLines', 'commentGap', 'commentLineHeight'];
// '' keeps the theme's color; the mode select chooses between it and the color input.
const COLOR_MODE_KEYS = ['commentTextColor', 'commentAuthorColor'];
const FIELD_KEYS = ['theme', 'accentMode', 'accent', 'decoration', 'title', 'subtitle', 'footer', 'speechTitle', 'fontSize', 'speechFontSize', 'speechStyle', 'speechBackground', 'speechTextColor', 'commentStyle', 'maxVisible', 'holdSeconds', 'newestPosition', 'source', 'actorAppearance', 'commentPanel', 'commentPanelOpacity', 'commentItemBackground', 'commentItemOpacity', 'commentOutline', 'commentOutlineColor', 'commentLineHeight', 'commentMaxLines', 'commentGap', 'commentDivider', 'commentLabel'];
const OUTPUT_LABELS = { '1920x1080': '1920 × 1080（横）', '1280x720': '1280 × 720（横）', '1080x1920': '1080 × 1920（縦）', '1440x1080': '1440 × 1080（4:3）' };
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const ACTOR_KEYS = ['mode', 'scale', 'alignX', 'alignY', 'offsetX', 'offsetY', 'overflow'];
const options = pairs => pairs.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
const textField = (key, label, max) => `<label>${label}<input id="draft-${key}" type="text" maxlength="${max}"></label>`;

const STYLE = `:host{display:block;color:#edf4e9;font:14px system-ui;margin-bottom:24px}*{box-sizing:border-box}section.entry{background:#1a2325;border:1px solid #506960;border-radius:12px;padding:24px}h2,h3,p{margin:0 0 12px}h2{font-size:18px}h3{font-size:15px}p{line-height:1.7;color:#c0d0c8}
button,input,select,textarea{font:inherit;background:#101b18;color:#edf4e9;border:1px solid #70877b;border-radius:6px;padding:8px;max-width:100%}button{cursor:pointer}button:disabled,input:disabled,select:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #ace5cd;outline-offset:2px}
label{display:grid;min-width:0;gap:5px;margin:10px 0}textarea{width:100%;resize:vertical}input[type=file]{width:100%;min-width:0}input[type=color]{width:100%;height:40px;padding:3px}.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.primary{background:#ace5cd;color:#11271e;font-weight:700}.danger{border-color:#e6a0a0}
dialog{background:#101a18;color:#edf4e9;padding:0;border:0}#design-dialog{position:fixed;inset:0;margin:0;width:100%;height:100%;max-width:none;max-height:none;overflow:hidden}#design-dialog[open]{display:grid;grid-template-rows:auto auto minmax(0,1fr)}dialog::backdrop{background:#000b}dialog:not([open]){display:none}
.bar{display:flex;gap:8px 16px;justify-content:space-between;align-items:center;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid #40554b}.bar h2{margin:0}.title{display:flex;gap:4px 12px;align-items:baseline;flex-wrap:wrap;min-width:0}#draft-state{color:#ffd88a;font-weight:700}
#design-status{margin:0;padding:6px 16px;min-height:24px}.editor{display:grid;grid-template-columns:200px minmax(0,1fr) 320px;min-height:0}.side,.center{min-width:0;min-height:0;overflow:auto;padding:12px 14px}.left{border-right:1px solid #40554b}.right{border-left:1px solid #40554b}
.center{display:flex;flex-direction:column;gap:6px}.center label{margin:0}.view{display:flex;gap:4px 12px;flex-wrap:wrap;align-items:end}.stage-box{flex:1;min-height:160px;overflow:hidden;display:flex;justify-content:center;align-items:flex-start}.viewport{position:relative;overflow:hidden;background:#080e0c;border:1px solid #5d776b;border-radius:8px;flex:none}
iframe{position:absolute;left:0;top:0;border:0;transform-origin:top left;background:#122321}#target-select{width:100%;min-height:200px;padding:4px}#target-select option{padding:4px 6px}#target-select optgroup{color:#c0d0c8}.numbers{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 10px}.numbers input{width:100%}
details{margin:12px 0;border-top:1px solid #40554b;padding-top:10px}summary{cursor:pointer}small{line-height:1.6;color:#c0d0c8}.check{display:flex;gap:8px;align-items:center}.scope{display:inline-block;font-size:12px;border:1px solid #70877b;border-radius:999px;padding:1px 8px;margin:4px 0 2px;color:#c0d0c8}[data-target][hidden],#overlay-text-fields[hidden],#restart-design[hidden]{display:none}.tabs{display:none}
#editor-confirm{max-width:min(480px,calc(100vw - 32px));border:1px solid #ace5cd;border-radius:12px;padding:20px}
dialog[data-mode=preset] .side,dialog[data-mode=preset] .edit-only{display:none}dialog[data-mode=preset] .editor{grid-template-columns:minmax(0,1fr)}
@media(max-width:1199px){.editor{grid-template-columns:170px minmax(0,1fr) 290px}}
@media(max-width:767px){#design-dialog[open]{display:block;overflow:auto}.bar{position:sticky;top:0;z-index:1;background:#101a18}.editor{display:flex;flex-direction:column}.center{order:-1}.side,.center{overflow:visible}.left,.right{border:0}.stage-box{flex:none;min-height:0}.tabs{display:flex;gap:8px;padding:8px 14px 0}.tabs button[aria-pressed=true]{background:#ace5cd;color:#11271e}#design-dialog[data-tab=targets] .right,#design-dialog[data-tab=settings] .left{display:none}dialog[data-mode=preset] .tabs{display:none}}`;

const MARKUP = `<section class="entry"><h2>デザインエディタ</h2><p>配色・文章・コメント欄・読み上げ・立ち絵の見た目と、追加の文字・画像、テーマCSSを、配信画面を見ながら1つの下書きで編集します。「適用」を押すまで配信画面には反映されません。</p><button id="open-design-preview" class="primary" type="button">デザインを編集</button><p id="preview-result" role="status"></p><p><small>このページの「画面の配置」と「配信出力（OBS用）」の出力の大きさは、移行中のため変更するとすぐに保存されます。</small></p></section>
<dialog id="design-dialog" aria-labelledby="design-title" data-tab="targets"><div class="bar"><div class="title"><h2 id="design-title">デザインエディタ</h2><span id="draft-state" role="status"></span><div class="actions edit-only"><button id="undo-design" type="button" aria-keyshortcuts="Control+Z">取り消し</button><button id="redo-design" type="button" aria-keyshortcuts="Control+Shift+Z Control+Y">やり直し</button></div></div><div class="actions"><button id="restart-design" type="button" hidden>最新のデザインからやり直す</button><button id="discard-design" class="edit-only danger" type="button">変更をすべて破棄</button><button id="apply-design" class="primary" type="button">適用</button><button id="cancel-design" type="button">閉じる</button></div></div>
<p id="design-status" role="status" aria-live="polite"></p>
<div class="editor"><div class="tabs edit-only" role="group" aria-label="表示する欄"><button id="show-targets" type="button" aria-pressed="true">対象</button><button id="show-settings" type="button" aria-pressed="false">設定</button></div>
<aside class="side left" aria-label="道具と対象"><h3>道具</h3><div class="actions"><button id="add-text" type="button">文字を追加</button></div><label>画像を追加<input id="overlay-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label><p><small>追加は各比率20個まで。画像はPNG・JPEG・WebP・GIF、1枚20MB・1600万画素まで。</small></p><details id="target-details" open><summary>対象一覧</summary><label>編集する対象<select id="target-select" size="12"></select></label></details></aside>
<div class="center"><div class="view"><label>確認サイズ（編集する比率）<select id="preview-width">${PREVIEW_SIZES.map(value => `<option value="${value}">${value.replace('x', ' × ')}（${nearestRatio(...size(value))}）</option>`).join('')}</select></label><label class="check"><input id="preview-guides" type="checkbox" checked>画面端のガイドを表示</label></div><p id="preview-ratio-help"><small>比率ごとに、配置・追加の文字と画像・立ち絵画像の配置を別々に保存します。</small></p><div class="stage-box" id="stage-box"><div class="viewport" id="preview-viewport"><iframe id="design-preview-frame" title="雑談画面のデザインプレビュー" sandbox="allow-same-origin"></iframe></div></div><p class="edit-only"><small>サンプル表示です。チャット接続・音声再生は行いません。外部フォントを読み込まないため、文字の折り返しは適用後も確認してください。追加した文字・画像は「移動」「大きさ」をドラッグできます。矢印キーで移動、Shift＋矢印でサイズ変更。画面収録・ウィンドウキャプチャ中は、この編集画面も映るためOBSの別シーンなどで編集してください。</small></p></div>
<aside class="side right" aria-labelledby="target-heading"><h3 id="target-heading">画面全体</h3>
<div data-target="screen"><span class="scope">全比率共通の見た目</span><label>テーマ<select id="draft-theme">${options([['mint', 'ミントの夜'], ['rose', 'ローズの夜'], ['violet', 'すみれの夜'], ['paper', 'お昼の喫茶室']])}</select></label><label>配色モード<select id="draft-accentMode">${options([['theme', 'テーマに合わせる'], ['custom', '自分で設定']])}</select></label><label>アクセントカラー<input id="draft-accent" type="color"></label><label class="check"><input id="draft-decoration" type="checkbox">星やハートの装飾を表示</label>
<label>出力の大きさ<select id="draft-outputSize">${options(Object.keys(OUTPUT_SIZES).map(value => [value, OUTPUT_LABELS[value]]))}</select></label><p><small>配信出力と雑談画面はこの大きさの比率で表示します。確認サイズを変えても出力の大きさは変わりません。</small></p>
<details><summary>詳細：テーマCSS</summary><label>CSS<textarea id="draft-css" rows="8" spellcheck="false" placeholder="${DEFAULT_THEME_CSS.replace(/"/g, '&quot;')}"></textarea></label><p><small>.pokome-workspace 以下のCSSだけを使えます。画像URL・外部フォントは使えません。CSSエラー中は最後の有効なプレビューを表示し、適用できません。CSSで位置や大きさを指定すると、設定と重なる場合があります。動かせないときはCSSを解除または編集してください。</small></p><label>CSSファイルを読み込む<input id="draft-css-file" type="file" accept=".css,text/css"></label><div class="actions"><button id="draft-css-clear" type="button">CSSを解除</button><button id="draft-css-export" type="button">編集中のCSSを書き出す</button></div><p><small>書き出すのはCSSだけです。配置・画像・そのほかの設定は含みません。</small></p></details>
<button id="draft-reset" type="button">デザイン全体を標準に戻す</button><p><small>出力の大きさ・テーマCSS・すべての比率の配置と追加の文字・画像を含めて、標準のデザインを下書きに読み込みます。「適用」までは保存しません。</small></p></div>
<div data-target="header" hidden><span class="scope">全比率共通の見た目</span>${textField('title', 'タイトル', 60)}${textField('subtitle', 'サブタイトル', 100)}</div>
<div data-target="chat" hidden><span class="scope">全比率共通の見た目</span><label>コメント欄の見た目をまとめて切り替え<select id="draft-commentPreset">${options([...Object.entries(COMMENT_PRESETS).map(([value, preset]) => [value, preset.label]), ['', '個別に調整中']])}</select></label><p><small>選ぶと下の見た目とコメントの表示をまとめて変更します。配置・文字サイズ・表示件数は変えません。</small></p><label>コメントの表示<select id="draft-commentStyle">${options([['stacked', '名前を上に表示'], ['anonymous', '名前なし'], ['inline', '名前と本文を横並び'], ['compact', '1行コンパクト']])}</select></label><label>コメントの文字サイズ<input id="draft-fontSize" type="number" min="16" max="64" step="1"></label><p><small>テーマCSSに文字サイズの指定がある場合は、その指定が優先されます。</small></p>
<label>配信出力の表示件数<select id="draft-maxVisible">${options([['0', '制限なし'], ...Array.from({ length: 30 }, (_, index) => [String(index + 1), `${index + 1}件`])])}</select></label><label>配信出力の表示時間<select id="draft-holdSeconds">${options([['0', '時間では消さない'], ['5', '5秒'], ['15', '15秒'], ['30', '30秒']])}</select></label><label>配信出力の新着位置<select id="draft-newestPosition">${options([['bottom', '下'], ['top', '上']])}</select></label><p><small>サンプルは時間で消えません。雑談画面の履歴表示は変わりません。</small></p>
<label>投稿ごとの背景<select id="draft-commentItemBackground">${options([['theme', 'テーマのまま'], ['none', 'なし'], ['light', '白い丸い背景'], ['dark', '黒い丸い背景']])}</select></label><label>投稿背景の不透明度（%）<input id="draft-commentItemOpacity" type="number" min="0" max="100" step="1"></label><label>本文の最大行数<select id="draft-commentMaxLines">${options([['', 'テーマのまま'], ['0', '制限なし'], ...[1, 2, 3, 4, 5].map(lines => [String(lines), `${lines}行`])])}</select></label><p><small>本文だけを省略して表示します。保存した本文と読み上げには影響しません。「1行コンパクト」にも優先します。</small></p><label>コメント同士の間隔<select id="draft-commentGap">${options([['', 'テーマのまま'], ...[0, 4, 8, 12, 14, 16, 24].map(gap => [String(gap), `${gap}px`])])}</select></label>
<label>パネルの背景<select id="draft-commentPanel">${options([['theme', 'テーマのまま'], ['none', 'なし（枠も消す）'], ['light', '白'], ['dark', '黒']])}</select></label><label>パネルの不透明度（%）<input id="draft-commentPanelOpacity" type="number" min="0" max="100" step="5"></label>
${COLOR_MODE_KEYS.map(key => { const label = key === 'commentTextColor' ? '本文の色' : '名前の色'; return `<label>${label}<select id="draft-${key}Mode">${options([['theme', 'テーマのまま'], ['custom', '色を指定']])}</select></label><label>${label}（指定色）<input id="draft-${key}" type="color"></label>`; }).join('')}
<label>文字の縁取り<select id="draft-commentOutline">${options([['none', 'なし'], ['thin', '細い'], ['thick', '太い']])}</select></label><label>縁取りの色<input id="draft-commentOutlineColor" type="color"></label><label>行間<select id="draft-commentLineHeight">${options([['', 'テーマのまま'], ['1.2', '1.2（詰める）'], ['1.35', '1.35'], ['1.5', '1.5'], ['1.75', '1.75'], ['2', '2.0（広い）']])}</select></label>
<label class="check"><input id="draft-commentDivider" type="checkbox">コメントの区切り線を表示</label><label class="check"><input id="draft-commentLabel" type="checkbox">見出し（「みんなのコメント」と件数）を表示</label><p><small>「テーマのまま」以外を選んだ項目は、テーマCSSより優先します。</small></p></div>
<div data-target="speech" hidden><span class="scope">全比率共通の見た目</span>${textField('speechTitle', '読み上げ枠の見出し', 40)}<label>読み上げの文字サイズ<select id="draft-speechFontSize">${options([16, 22, 28, 32].map(px => [String(px), `${px}px`]))}</select></label><label>読み上げ枠<select id="draft-speechStyle">${options([['panel', '通常のパネル'], ['bubble', 'セリフの吹き出し'], ['image', '背景画像']])}</select></label><label>吹き出し背景<input id="draft-speechBackground" type="color"></label><label>背景画像内の文字色<input id="draft-speechTextColor" type="color"></label><label>名前・コメントの背景画像<input id="draft-speechImage" type="file" accept="${IMAGE_ACCEPT}"></label><p id="speech-image-status" role="status"></p><button id="draft-speechImage-reset" type="button">標準の背景画像に戻す</button><p><small>PNG・JPEG・WebP・GIF、20MB・1600万画素まで。画像は名前と本文だけの背景に表示します。</small></p></div>
<div data-target="actor" hidden><span class="scope">全比率共通の見た目</span><label>表示するもの<select id="draft-source">${options([['space', '空き枠 / OBSで映像を重ねる'], ['image', '立ち絵画像']])}</select></label><label>立ち絵画像<input id="draft-image" type="file" accept="${IMAGE_ACCEPT}"></label><p id="actor-image-status" role="status"></p><button id="draft-image-remove" type="button">画像を削除</button><p><small>PNG・JPEG・WebP・GIF、20MB・1600万画素まで。透過PNGにも対応します。動くVtuberモデルや外部のワイプ映像は、空き枠にOBSのソースを重ねて使えます。</small></p><label>立ち絵の枠・背景・キャプション<select id="draft-actorAppearance">${options([['theme', 'テーマのまま'], ['none', 'すべて消す']])}</select></label>
<h3 id="draft-actor-heading">この比率の立ち絵画像の配置</h3><span class="scope">この比率の配置</span><label>画像の配置方法<select id="actor-mode">${options([['theme', 'テーマのまま'], ['custom', '自分で調整']])}</select></label><label>拡大率（%）<input id="actor-scale" type="number" min="100" max="200" step="1"></label><label>横位置合わせ<select id="actor-alignX">${options([['left', '左'], ['center', '中央'], ['right', '右']])}</select></label><label>縦位置合わせ<select id="actor-alignY">${options([['top', '上'], ['center', '中央'], ['bottom', '下（画像ファイルの下端）']])}</select></label><div class="numbers"><label>横の微調整（%）<input id="actor-offsetX" type="number" min="-100" max="100" step="any"></label><label>縦の微調整（%）<input id="actor-offsetY" type="number" min="-100" max="100" step="any"></label></div><label class="check"><input id="actor-overflow" type="checkbox">枠からはみ出す</label><p><small id="draft-actor-help"></small></p></div>
<div data-target="footer" hidden><span class="scope">全比率共通の見た目</span>${textField('footer', '画面下のひとこと', 100)}</div>
<div data-target="overlay" hidden><span class="scope">この比率の配置</span><label class="check"><input id="overlay-hidden" type="checkbox">この項目を非表示</label><div id="overlay-text-fields"><label>表示する文章<textarea id="overlay-text" maxlength="1000" rows="3"></textarea></label><label>文字の色<input id="overlay-color" type="color"></label><label>文字の大きさ（px）<input id="overlay-font-size" type="number" min="12" max="160"></label></div><div class="numbers">${[['x', '横位置（%）'], ['y', '縦位置（%）'], ['w', '幅（%）'], ['h', '高さ（%）'], ['z', '重なり順 0〜99']].map(([key, label]) => `<label>${label}<input id="overlay-${key}" type="number" min="${['w', 'h'].includes(key) ? 2 : 0}" max="${key === 'z' ? 99 : 100}" step="1"></label>`).join('')}</div><p><small>画像は各辺に画面1枚分まで、幅・高さ200%まで置けます。枠は画面内に幅・高さ各2%残すよう補正します。文字は画面内に収めます。大きい重なり順の項目ほど手前に表示します。既存の枠の位置は、このページの下の「画面の配置」で変更できます。</small></p><button id="delete-overlay" class="danger" type="button">この項目を削除</button></div>
</aside></div></dialog>
<dialog id="editor-confirm" aria-labelledby="editor-confirm-title" aria-describedby="editor-confirm-message"><h3 id="editor-confirm-title"></h3><p id="editor-confirm-message"></p><div class="actions"><button id="editor-confirm-accept" class="danger" type="button"></button><button id="editor-confirm-cancel" class="primary" type="button"></button></div></dialog>`;

// The full-screen design editor. Everything edited here stays in one draft
// (every ratio) until Apply stores it with a single revision-checked write.
// getLiveRatio tells which ratio the talk screen shows.
export function initializeDesignPreview({ designStore, themeEditor, getLiveRatio = () => '16:9', beginDraft = () => {} }) {
  const live = document.getElementById('talk-stage');
  let presetDraft = null, presetApply = null, returnFocus = null;
  const assetOptions = () => overlayOptions(presetDraft?.images || designStore.images), imageOptions = () => studioOptions(presetDraft?.images || designStore.images);
  const imageScope = () => presetDraft ? `presets/${presetDraft.id}` : 'current';
  const storedOverlays = () => talkOverlays(designStore.design, getLiveRatio());
  const previewRatio = () => nearestRatio(...size($('preview-width').value));
  let overlays = storedOverlays(), session = null, ratio = '16:9', selected = 'screen', epoch = 0, pending = 0, saving = false, gesture = 0;
  let commentResizeObserver, previewStage, frameDoc, previewCSS, defaultImage, compiledCSS = '', compiledSource = '', cssError = '', renderedStudio = null, renderedActorImage = null, renderedRatio = null, dragCleanup, confirmation = null;
  const requests = new Map();
  renderOverlays(live, resolveOverlayAssets(overlays));
  const host = document.createElement('div'); host.id = 'design-preview-editor';
  document.getElementById('studio-page').prepend(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${STYLE}</style>${MARKUP}`;
  const $ = id => shadow.getElementById(id), dialog = $('design-dialog'), frame = $('design-preview-frame');
  const status = message => { $('design-status').textContent = message; };
  const design = () => session.design;
  const ratioOverlays = (r = ratio) => talkOverlays(design(), r);
  const currentItem = () => session ? ratioOverlays().items.find(item => item.id === selected) : undefined;
  const isCurrent = token => !!session && token === epoch;
  const editable = () => !!session && !presetDraft && !saving;
  // An empty or non-finite number keeps the value it replaces.
  const numberOr = (element, current) => element.value === '' || !Number.isFinite(Number(element.value)) ? current : Number(element.value);
  // Number inputs follow the old settings: whole numbers within the field's range.
  const bounded = (element, current) => element.type !== 'number' ? numberOr(element, current) : Math.min(Number(element.max), Math.max(Number(element.min), Math.round(numberOr(element, current))));

  // `typing` is the field being typed in; it is corrected only once committed.
  function edit(next, settings, typing = null) {
    if (!editable()) return;
    session.change(next, settings);
    refresh(typing);
  }
  const editStudio = (patch, settings, typing) => edit({ ...design(), studio: normalizeStudio({ ...design().studio, ...patch }, imageOptions()) }, settings, typing);

  function confirmAction(title, message, accept, cancel) {
    $('editor-confirm-title').textContent = title; $('editor-confirm-message').textContent = message;
    $('editor-confirm-accept').textContent = accept; $('editor-confirm-cancel').textContent = cancel;
    confirmation?.(false);
    return new Promise(resolve => { confirmation = resolve; $('editor-confirm').showModal(); $('editor-confirm-cancel').focus(); });
  }
  function finishConfirmation(accepted) {
    const resolve = confirmation; confirmation = null;
    if ($('editor-confirm').open) $('editor-confirm').close();
    resolve?.(accepted);
  }
  $('editor-confirm-accept').onclick = () => finishConfirmation(true);
  $('editor-confirm-cancel').onclick = () => finishConfirmation(false);
  $('editor-confirm').addEventListener('cancel', event => { event.preventDefault(); finishConfirmation(false); });
  $('editor-confirm').addEventListener('close', () => finishConfirmation(false));

  function buttons() {
    const ready = !!previewStage && !!session;
    $('apply-design').disabled = !ready || pending > 0 || saving || session.stale || (!presetDraft && !!cssError);
    $('discard-design').disabled = !ready || saving || !session.dirty;
    $('undo-design').disabled = !editable() || !session.canUndo;
    $('redo-design').disabled = !editable() || !session.canRedo;
    $('restart-design').hidden = !session?.stale || !!presetDraft;
    $('restart-design').disabled = saving;
    $('cancel-design').disabled = saving;
    $('draft-reset').disabled = !ready || !editable();
    const full = !session || ratioOverlays().items.length >= MAX_OVERLAYS;
    $('add-text').disabled = !editable() || full;
    $('overlay-image').disabled = !editable() || full;
    $('draft-state').textContent = !session ? '' : presetDraft ? 'プリセットを確認（編集不可）' : saving ? '適用中…' : session.stale ? '別の画面で変更されました' : session.dirty ? '下書き・未適用' : '変更なし';
  }
  function targets() {
    const items = ratioOverlays().items;
    if (!PANEL_TARGETS.some(([id]) => id === selected) && !items.some(item => item.id === selected)) selected = 'screen';
    const group = (label, entries) => {
      const element = document.createElement('optgroup'); element.label = label;
      element.append(...entries.map(([value, text]) => { const option = document.createElement('option'); option.value = value; option.textContent = text; return option; }));
      return element;
    };
    $('target-select').replaceChildren(group('画面の枠', PANEL_TARGETS), group(`追加した文字・画像（${ratio}）`, items.map((entry, index) => [entry.id, `${index + 1}. ${entry.type === 'text' ? entry.text.slice(0, 24) || '空の文字' : '画像'}${entry.hidden ? '（非表示）' : ''}`])));
    $('target-select').value = selected;
    const item = currentItem(), kind = item ? 'overlay' : selected;
    $('target-heading').textContent = item ? `選択中：追加した${item.type === 'text' ? '文字' : '画像'}（${ratio}）` : PANEL_TARGETS.find(([id]) => id === selected)[1];
    for (const section of shadow.querySelectorAll('[data-target]')) section.hidden = section.dataset.target !== kind;
  }
  function overlayFields() {
    const item = currentItem();
    if (!item) return;
    $('overlay-text-fields').hidden = item.type !== 'text';
    const bounds = overlayBounds(item.type, item.w, item.h);
    for (const [key, min, max] of [['x', bounds.minX, bounds.maxX], ['y', bounds.minY, bounds.maxY], ['w', bounds.minSize, bounds.maxSize], ['h', bounds.minSize, bounds.maxSize]]) {
      const input = $(`overlay-${key}`); input.min = min; input.max = max; input.step = 'any';
    }
    for (const key of ['x', 'y', 'w', 'h', 'z']) $(`overlay-${key}`).value = item[key];
    $('overlay-hidden').checked = item.hidden;
    if (item.type === 'text') {
      // Rewriting the field while typing would move the caret.
      if ($('overlay-text').value !== item.text) $('overlay-text').value = item.text;
      $('overlay-color').value = item.color; $('overlay-font-size').value = item.fontSize;
    }
  }
  function studioFields(typing = null) {
    const studio = design().studio;
    for (const key of FIELD_KEYS) {
      const element = $(`draft-${key}`);
      if (element === typing) continue;
      const value = element.type === 'checkbox' ? studio[key] : String(studio[key] ?? '');
      if (element.type === 'checkbox') element.checked = value; else if (element.value !== value) element.value = value;
    }
    for (const key of COLOR_MODE_KEYS) {
      $(`draft-${key}Mode`).value = studio[key] ? 'custom' : 'theme';
      $(`draft-${key}`).disabled = !studio[key];
      if (studio[key] && $(`draft-${key}`) !== typing) $(`draft-${key}`).value = studio[key];
    }
    $('draft-commentPreset').value = matchCommentPreset(studio);
    $('draft-outputSize').value = design().outputSize;
    if ($('draft-css').value !== design().theme) $('draft-css').value = design().theme;
    $('draft-commentItemOpacity').disabled = !['light', 'dark'].includes(studio.commentItemBackground);
    $('draft-commentPanelOpacity').disabled = !['light', 'dark'].includes(studio.commentPanel);
    $('draft-commentOutlineColor').disabled = studio.commentOutline === 'none';
    $('draft-speechBackground').disabled = studio.speechStyle !== 'bubble';
    $('speech-image-status').textContent = studio.speechImage ? 'ユーザーの背景画像を登録済みです。' : '標準の背景画像を使用します。';
    $('actor-image-status').textContent = studio.image ? '立ち絵画像を登録済みです。' : '画像は未登録です。';
    $('draft-speechImage-reset').disabled = !studio.speechImage;
    $('draft-image-remove').disabled = !studio.image;
    actorFields();
  }
  function actorFields() {
    const actorImage = talkActorImage(design(), ratio), studio = design().studio;
    $('draft-actor-heading').textContent = `この比率の立ち絵画像の配置（${ratio}）`;
    for (const key of ACTOR_KEYS) {
      const element = $(`actor-${key}`);
      if (element.type === 'checkbox') element.checked = actorImage[key]; else element.value = actorImage[key];
      element.disabled = !!presetDraft || (key !== 'mode' && actorImage.mode === 'theme');
    }
    $('draft-actor-help').textContent = studio.source !== 'image' ? '空き枠では画像の配置を描画しません。調整値は保持します。' : !studio.image ? '立ち絵画像がありません。画像を選ぶと、この比率の調整値を使います。' : '「下」は人物の足元ではなく、透過余白を含む画像ファイルの下端です。微調整は枠の幅・高さに対する割合で、右・下が正です。';
  }
  // The last valid CSS stays on the canvas while the typed CSS has an error.
  function compileDraftCSS() {
    if (design().theme === compiledSource) return;
    try { compiledCSS = compileTheme(design().theme); cssError = ''; }
    catch (error) { cssError = error.message; }
    compiledSource = design().theme;
  }
  function refresh(typing = null) {
    if (!session) return;
    compileDraftCSS(); targets(); overlayFields(); studioFields(typing); draw(); buttons();
  }
  function scale() {
    const [width, height] = size($('preview-width').value), box = $('stage-box');
    // A narrow dock stacks the canvas above the settings, so it cannot fill the height.
    const tall = matchMedia('(max-width: 767px)').matches ? innerHeight * .45 : box.clientHeight;
    const factor = Math.max(.05, Math.min(box.clientWidth / width, Math.max(160, tall) / height));
    frame.style.width = `${width}px`; frame.style.height = `${height}px`; frame.style.transform = `scale(${factor})`;
    $('preview-viewport').style.width = `${width * factor}px`; $('preview-viewport').style.height = `${height * factor}px`;
  }
  new ResizeObserver(() => { scale(); positionHits(); }).observe($('stage-box'));
  // Edges viewers' apps may cover, drawn only in the preview.
  function drawGuides() {
    if (!frameDoc) return;
    let guides = frameDoc.getElementById('safe-guides');
    if (!guides) { guides = frameDoc.createElement('div'); guides.id = 'safe-guides'; frameDoc.body.append(guides); }
    guides.hidden = !$('preview-guides').checked;
    const area = SAFE_AREAS[ratio];
    if (guides.dataset.ratio === ratio) return;
    guides.dataset.ratio = ratio;
    const box = (className, style, text) => { const element = frameDoc.createElement('div'); element.className = className; Object.assign(element.style, style); element.textContent = text; return element; };
    guides.replaceChildren(...(area.shade
      ? [box('guide-shade', { top: '0', height: `${area.top}%` }, 'アプリの表示で隠れやすい範囲'), box('guide-shade', { bottom: '0', height: `${area.bottom}%` }, 'アプリの表示で隠れやすい範囲')]
      : [box('guide-line', { top: `${area.top}%`, bottom: `${area.bottom}%`, left: `${area.left}%`, right: `${area.right}%` }, '文字を置かない目安')]));
  }
  function draw() {
    if (!previewStage || !session) return;
    const studio = design().studio, actorImage = talkActorImage(design(), ratio), layout = talkLayout(design(), ratio), state = ratioOverlays();
    if (renderedStudio !== studio || JSON.stringify(renderedActorImage) !== JSON.stringify(actorImage) || renderedRatio !== ratio) {
      renderStageAppearance(previewStage, resolveStudioImages(studio, imageScope()), defaultImage, { actorImage });
      renderedStudio = studio; renderedActorImage = actorImage; renderedRatio = ratio;
    }
    renderOverlays(previewStage, resolveOverlayAssets(state, imageScope()));
    renderStageComments(previewStage.querySelector('#stage-chat-list'), selectOutputComments(SAMPLE_COMMENTS, studio, 0, false));
    const themeStyle = frameDoc.getElementById('preview-theme');
    if (themeStyle.textContent !== compiledCSS) themeStyle.textContent = compiledCSS;
    // The draft CSS can change the speech minimum, which moves the panels below it.
    applyTalkLayout(previewStage, layout);
    const old = new Map([...frameDoc.querySelectorAll('.overlay-hit')].map(element => [element.dataset.overlayId, element]));
    for (const item of presetDraft ? [] : state.items) {
      let hit = old.get(item.id);
      if (!hit) {
        hit = frameDoc.createElement('div'); hit.className = 'overlay-hit'; hit.dataset.overlayId = item.id;
        for (const [resize, label] of [[false, '移動'], [true, '大きさ']]) {
          const button = frameDoc.createElement('button'); button.textContent = label; button.type = 'button'; button.dataset.resize = String(resize);
          button.setAttribute('aria-label', `${item.type === 'text' ? '文字' : '画像'}を${label}`);
          button.addEventListener('pointerdown', event => startMove(event, item.id, resize));
          button.addEventListener('keydown', event => keyMove(event, item.id, resize));
          button.addEventListener('keyup', () => session?.seal());
          button.addEventListener('blur', () => session?.seal());
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
      const panel = layout?.panels.speech;
      if (panel) speech.style.top = `min(${panel.y}%, max(0px, calc(100% - max(${panel.h}%, ${parseFloat(frame.contentWindow.getComputedStyle(speech).minHeight) || 0}px))))`;
    }
    updateSampleVisibility(true);
  }
  function updateSampleVisibility(followNewest = false) {
    if (!previewStage || !session) return;
    const list = previewStage.querySelector('#stage-chat-list');
    if (followNewest) list.scrollTop = design().studio.newestPosition === 'top' ? 0 : list.scrollHeight;
    markClippedComments(list);
  }
  function positionHits() {
    if (!session || !previewStage) return;
    const canvas = previewStage.getBoundingClientRect();
    for (const item of ratioOverlays().items) {
      const hit = frameDoc.querySelector(`.overlay-hit[data-overlay-id="${item.id}"]`);
      const element = previewStage.querySelector(`.pokome-overlay[data-overlay-id="${item.id}"]`);
      if (!hit || !element) continue;
      const rect = item.hidden ? {
        left: canvas.left + item.x / 100 * previewStage.clientWidth - previewStage.scrollLeft,
        top: canvas.top + item.y / 100 * previewStage.clientHeight - previewStage.scrollTop,
        width: item.w / 100 * previewStage.clientWidth, height: item.h / 100 * previewStage.clientHeight,
      } : element.getBoundingClientRect();
      for (const key of ['left', 'top', 'width', 'height']) hit.style[key] = `${rect[key]}px`;
    }
  }
  function changedItem(id, patch, settings = {}) {
    if (!session) return;
    const state = ratioOverlays();
    const next = normalizeOverlays({ ...state, items: state.items.map(item => item.id === id ? { ...item, ...patch } : item) }, assetOptions());
    edit(withTalk(design(), ratio, { overlays: next }), { label: '追加した項目', ratio, ...settings });
  }
  const resizePatch = (item, dx, dy) => ({
    w: item.type === 'image' ? item.w + dx : Math.min(item.w + dx, 100 - item.x),
    h: item.type === 'image' ? item.h + dy : Math.min(item.h + dy, 100 - item.y),
  });
  function select(target) { selected = target; refresh(); }
  function startMove(event, id, resize) {
    if (!editable() || event.button !== 0) return;
    event.preventDefault(); dragCleanup?.(); session.seal(); select(id);
    const original = clone(currentItem()), token = epoch, button = event.currentTarget, merge = `drag:${++gesture}`;
    const canvas = previewStage.getBoundingClientRect();
    const width = previewStage.clientWidth * canvas.width / previewStage.offsetWidth, height = previewStage.clientHeight * canvas.height / previewStage.offsetHeight;
    if (!width || !height) return;
    // Pointer client coordinates inside the iframe use its unscaled CSS pixels.
    button.setPointerCapture(event.pointerId);
    const move = e => {
      if (!isCurrent(token)) return;
      const dx = (e.clientX - event.clientX) / width * 100, dy = (e.clientY - event.clientY) / height * 100;
      changedItem(id, resize ? resizePatch(original, dx, dy) : { x: original.x + dx, y: original.y + dy }, { merge });
    };
    // One drag is one operation; a cancelled one returns to where it began.
    const finish = e => { cleanup(); if (!isCurrent(token)) return; if (e.type === 'pointercancel') session.cancelOpen(); else session.seal(); refresh(); };
    const cleanup = () => { button.removeEventListener('pointermove', move); button.removeEventListener('pointerup', finish); button.removeEventListener('pointercancel', finish); dragCleanup = null; };
    dragCleanup = () => { cleanup(); if (isCurrent(token)) { session.cancelOpen(); refresh(); } };
    button.addEventListener('pointermove', move); button.addEventListener('pointerup', finish); button.addEventListener('pointercancel', finish);
  }
  function keyMove(event, id, resize) {
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta || !editable()) return;
    event.preventDefault();
    if (selected !== id) { session.seal(); selected = id; }
    const item = currentItem(), sizing = resize || event.shiftKey;
    // Held keys form one operation until the key is released.
    changedItem(id, sizing ? resizePatch(item, ...delta) : { x: item.x + delta[0], y: item.y + delta[1] }, { merge: `key:${id}:${sizing}` });
  }
  function invalidate() { epoch++; requests.clear(); pending = 0; dragCleanup?.(); }
  function close() {
    commentResizeObserver?.disconnect(); commentResizeObserver = null;
    finishConfirmation(false);
    invalidate(); session = null; saving = false; previewStage = null; renderedStudio = null; renderedActorImage = null; renderedRatio = null; frameDoc = null; frame.removeAttribute('srcdoc');
    presetDraft = null; presetApply = null; compiledSource = ''; cssError = '';
    if (dialog.open) dialog.close(); (returnFocus || $('open-design-preview')).focus(); returnFocus = null;
  }
  // Leaving with changes asks first; the draft is never written back.
  async function requestClose() {
    if (!session || saving) return;
    if (dragCleanup) { dragCleanup(); return; }
    if (!presetDraft && session.dirty && !await confirmAction('下書きを破棄して閉じますか？', 'この編集での変更はすべての比率で破棄され、元に戻せません。適用済みのデザインは変わりません。', '下書きを破棄して閉じる', '編集を続ける')) return;
    if (session) close();
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
  dialog.addEventListener('close', () => { if (session) close(); });
  $('cancel-design').onclick = requestClose;
  window.addEventListener('popstate', () => { if (session) requestClose(); });
  $('show-targets').onclick = () => tab('targets');
  $('show-settings').onclick = () => tab('settings');
  function tab(name) { dialog.dataset.tab = name; $('show-targets').setAttribute('aria-pressed', String(name === 'targets')); $('show-settings').setAttribute('aria-pressed', String(name === 'settings')); }

  async function openPreview(preset = null, onApply = null) {
    if (session) return;
    beginDraft(); if (!preset) themeEditor.beginChange(); invalidate(); const token = epoch;
    presetDraft = preset; presetApply = onApply; returnFocus = document.activeElement;
    while (returnFocus?.shadowRoot?.activeElement) returnFocus = returnFocus.shadowRoot.activeElement;
    dialog.dataset.mode = preset ? 'preset' : 'editor';
    $('design-title').textContent = preset ? `プリセットを確認：「${preset.design.name}」` : 'デザインエディタ';
    $('preview-ratio-help').textContent = preset ? '比率を切り替えて配置・追加の文字と画像・立ち絵画像の配置を確認してください。この画面では編集しません。「適用」までは今のデザインを変えません。' : '比率ごとに、配置・追加の文字と画像・立ち絵画像の配置を別々に保存します。サイズを変えると、その比率の内容を表示・編集します。';
    // Edits from the older inputs may still be saving; start from what is stored.
    if (!preset) { try { await designStore.waitForSaves(); } catch { /* The store shows the saved design. */ } }
    if (epoch !== token) return;
    const start = preset?.design || designStore.design;
    // A preset is applied over the current design, so both modes guard its revision.
    session = createDraftSession(start, designStore.revision);
    $('preview-width').value = PREVIEW_SIZES.includes(start.outputSize) ? start.outputSize : '1280x720';
    ratio = previewRatio(); selected = 'screen'; compiledCSS = ''; compiledSource = null; cssError = '';
    compileDraftCSS(); tab('targets');
    dialog.showModal(); status('プレビューを準備しています…'); refresh(); scale();
    try {
      if (!previewCSS) {
        const [cssResponse, imageResponse] = await Promise.all([fetch('./style.css'), fetch('./speech-background.svg')]);
        if (!cssResponse.ok || !imageResponse.ok) throw new Error('プレビュー用のデザインを読み込めません。');
        previewCSS = (await cssResponse.text()).replace(/^@import[^\r\n]*(?:\r?\n|$)/gm, '');
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
      const controls = frameDoc.createElement('style'); controls.textContent = `html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}.stage-controls,.stage-switch,.stage-font-controls,.stage-edit-pencil,[data-layout-handle]{visibility:hidden!important}#talk-stage button{pointer-events:none}.overlay-hit{position:absolute;border:1px dashed #ace5cd;box-sizing:border-box;pointer-events:none}.overlay-hit[data-selected=true]{outline:2px solid #fff}.overlay-hit button{font:14px system-ui;padding:5px;background:#fff;color:#10291e;border:1px solid #174b39;cursor:move;touch-action:none;pointer-events:auto}.overlay-hit button:last-child{position:absolute;right:0;bottom:0;cursor:nwse-resize}.overlay-hit button:focus-visible{outline:3px solid #ffcc6f}#safe-guides{position:fixed;inset:0;pointer-events:none;z-index:900;font:12px system-ui}#safe-guides[hidden]{display:none}.guide-shade{position:absolute;left:0;right:0;background:repeating-linear-gradient(135deg,#ff4f6d55 0 10px,#ff4f6d22 10px 20px);color:#fff;text-shadow:0 1px 2px #000;display:flex;align-items:center;justify-content:center}.guide-line{position:absolute;border:2px dashed #ffcc6fcc;color:#ffcc6f;text-shadow:0 1px 2px #000;padding:4px}`;
      frameDoc.head.append(css, theme, controls);
      previewStage = frameDoc.importNode(live, true); previewStage.hidden = false;
      // The copy carries the live ratio's layout and edit frame; show the preview ratio's own.
      delete previewStage.dataset.frameRatio; previewStage.style.removeProperty('--frame');
      applyTalkLayout(previewStage, talkLayout(design(), ratio));
      for (const element of previewStage.querySelectorAll('dialog,[popover],[data-layout-handle],.pokome-overlay,script,iframe,object,embed,link')) element.remove();
      for (const element of previewStage.querySelectorAll('button,input,select,textarea,a')) { element.setAttribute('tabindex', '-1'); element.removeAttribute('href'); }
      previewStage.querySelector('#stage-speech-user').textContent = 'サンプルさん'; previewStage.querySelector('#stage-speech-text').textContent = '表示の色と大きさを確認しています。';
      previewStage.querySelector('#stage-speech-status').textContent = 'プレビュー'; previewStage.querySelector('.stage-speech').dataset.speaking = 'false';
      previewStage.querySelector('#stage-count').textContent = `${SAMPLE_COMMENTS.length} COMMENTS`;
      const main = frameDoc.createElement('main'); main.className = 'pokome-workspace'; main.append(previewStage); frameDoc.body.append(main);
      const sampleList = previewStage.querySelector('#stage-chat-list');
      sampleList.addEventListener('scroll', () => updateSampleVisibility(), { passive: true });
      commentResizeObserver = new ResizeObserver(() => updateSampleVisibility(true));
      commentResizeObserver.observe(sampleList);
      previewStage.addEventListener('scroll', positionHits, { passive: true });
      // Escape inside a nested browsing context does not reach the parent.
      frameDoc.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); requestClose(); } else historyKey(event); });
      refresh(); status(preset ? 'プリセットの内容を表示しています。比率を確認して「適用」を押してください。' : 'この画面での変更は「適用」を押すまで配信画面に反映されません。');
    } catch (error) { if (isCurrent(token)) status(`プレビューを開けませんでした：${error.message}`); }
  }
  $('open-design-preview').onclick = () => openPreview();
  $('preview-width').onchange = () => {
    dragCleanup?.(); session?.seal(); scale();
    // Each ratio keeps its own additions, layout and actor placement in the draft.
    ratio = previewRatio(); refresh();
    // The iframe lays out at its new size on the next frame.
    requestAnimationFrame(() => { scale(); draw(); });
  };
  $('preview-guides').onchange = drawGuides;
  $('target-select').onchange = () => { session?.seal(); select($('target-select').value); if (matchMedia('(max-width: 767px)').matches) tab('settings'); };
  $('add-text').onclick = () => {
    if (!editable() || ratioOverlays().items.length >= MAX_OVERLAYS) return;
    const state = ratioOverlays(), item = createOverlay('text', {}, state.items);
    selected = item.id;
    edit(withTalk(design(), ratio, { overlays: normalizeOverlays({ ...state, items: [...state.items, item] }, assetOptions()) }), { label: '文字の追加', ratio });
  };
  $('delete-overlay').onclick = () => {
    if (!editable() || !currentItem()) return;
    const next = removeOverlay(ratioOverlays(), selected, assetOptions());
    selected = 'screen';
    edit(withTalk(design(), ratio, { overlays: next }), { label: '項目の削除', ratio });
  };
  for (const key of ['x', 'y', 'w', 'h', 'z', 'font-size', 'text', 'color', 'hidden']) {
    const element = $(`overlay-${key}`), typed = key === 'text' || key === 'color';
    const update = () => {
      const item = currentItem(); if (!item || !editable()) return;
      if (key === 'w' || key === 'h') {
        changedItem(selected, resizePatch(item, key === 'w' ? numberOr(element, item.w) - item.w : 0, key === 'h' ? numberOr(element, item.h) - item.h : 0));
        overlayFields(); return;
      }
      const field = key === 'font-size' ? 'fontSize' : key;
      changedItem(selected, { [field]: key === 'hidden' ? element.checked : typed ? element.value : numberOr(element, item[field]) }, typed ? { merge: `overlay:${selected}:${key}` } : {});
      overlayFields();
    };
    if (typed) { element.addEventListener('input', update); element.addEventListener('change', () => session?.seal()); }
    else element.addEventListener('change', update);
  }
  $('overlay-image').onchange = async () => {
    const file = $('overlay-image').files[0]; $('overlay-image').value = '';
    if (!file || !editable() || ratioOverlays().items.length >= MAX_OVERLAYS) return;
    // The image belongs to the ratio shown when it was chosen, even if the view switches meanwhile.
    const token = epoch, request = Symbol(), target = ratio;
    if (requests.has('add-image')) pending--;
    requests.set('add-image', request); pending++; buttons(); status('画像を確認しています…');
    try {
      await checkImageFile(file);
      if (!isCurrent(token) || requests.get('add-image') !== request) return;
      // The file is stored now, but stays unused until the draft is applied.
      const { ref } = await designStore.uploadImage(file);
      if (!isCurrent(token) || requests.get('add-image') !== request) return;
      const state = ratioOverlays(target);
      if (state.items.length >= MAX_OVERLAYS) throw new Error('追加できる項目は20個までです。');
      const asset = addOverlayAsset(state, ref, undefined, assetOptions()), item = createOverlay('image', { assetId: asset.assetId }, state.items);
      const next = normalizeOverlays({ ...asset.state, items: [...asset.state.items, item] }, assetOptions());
      session.seal();
      if (target === ratio) selected = item.id;
      edit(withTalk(design(), target, { overlays: next }), { label: '画像の追加', ratio: target });
      status(target === ratio ? '画像を追加しました。適用するまでは見た目に反映されません。' : `画像を${target}の配置に追加しました。適用するまでは見た目に反映されません。`);
    } catch (error) { if (isCurrent(token) && requests.get('add-image') === request) status(error.message); }
    finally { if (isCurrent(token) && requests.get('add-image') === request) { requests.delete('add-image'); pending--; buttons(); } }
  };
  for (const key of FIELD_KEYS) {
    const element = $(`draft-${key}`), typed = TYPED_KEYS.includes(key);
    const value = () => element.type === 'checkbox' ? element.checked
      : NULLABLE_KEYS.includes(key) ? (element.value === '' ? null : Number(element.value))
      : NUMBER_KEYS.includes(key) ? bounded(element, design().studio[key]) : element.value;
    if (typed) {
      // Typing forms one operation until the field is committed or left.
      element.addEventListener('input', () => { if (session) editStudio({ [key]: value() }, { label: '見た目', merge: `studio:${key}` }, element); });
      // Committing shows the stored value, such as a clamped number.
      element.addEventListener('change', () => { if (session) { session.seal(); studioFields(); } });
    } else element.addEventListener('change', () => { if (session) { session.seal(); editStudio({ [key]: value() }, { label: '見た目' }); studioFields(); } });
  }
  for (const key of COLOR_MODE_KEYS) {
    const mode = $(`draft-${key}Mode`), color = $(`draft-${key}`);
    mode.addEventListener('change', () => { if (session) { session.seal(); editStudio({ [key]: mode.value === 'custom' ? color.value : '' }, { label: '見た目' }); } });
    color.addEventListener('input', () => { if (session && mode.value === 'custom') editStudio({ [key]: color.value }, { label: '見た目', merge: `studio:${key}` }, color); });
    color.addEventListener('change', () => session?.seal());
  }
  $('draft-commentPreset').addEventListener('change', () => {
    if (!session || !$('draft-commentPreset').value) return;
    session.seal();
    edit({ ...design(), studio: applyCommentPreset(design().studio, $('draft-commentPreset').value, imageOptions()) }, { label: 'コメント欄の見た目' });
  });
  $('draft-outputSize').addEventListener('change', () => { if (session) { session.seal(); edit({ ...design(), outputSize: $('draft-outputSize').value }, { label: '出力の大きさ' }); } });
  // Images are stored as files first; the draft only refers to them until Apply.
  async function draftImage(input, key, patch) {
    const file = input.files[0]; input.value = '';
    if (!file || !editable()) return;
    const token = epoch, request = Symbol();
    if (requests.has(key)) pending--;
    requests.set(key, request); pending++; buttons(); status('画像を確認しています…');
    const current = () => isCurrent(token) && requests.get(key) === request;
    try {
      await checkImageFile(file);
      if (!current()) return;
      const { ref } = await designStore.uploadImage(file);
      if (!current()) return;
      session.seal(); editStudio(patch(ref), { label: '画像' });
      status('画像を下書きに入れました。適用するまでは見た目に反映されません。');
    } catch (error) { if (current()) status(error.message); }
    finally { if (current()) { requests.delete(key); pending--; buttons(); } }
  }
  // A newer choice wins over an upload still in progress.
  function dropImageRequest(key) { if (requests.delete(key)) { pending--; buttons(); } }
  $('draft-image').onchange = () => draftImage($('draft-image'), 'actor-image', ref => ({ source: 'image', image: ref }));
  $('draft-speechImage').onchange = () => draftImage($('draft-speechImage'), 'speech-image', ref => ({ speechStyle: 'image', speechImage: ref }));
  $('draft-image-remove').onclick = () => { if (session) { dropImageRequest('actor-image'); session.seal(); editStudio({ image: '' }, { label: '画像の削除' }); } };
  $('draft-speechImage-reset').onclick = () => { if (session) { dropImageRequest('speech-image'); session.seal(); editStudio({ speechImage: '', speechStyle: 'image' }, { label: '標準の背景画像' }); } };
  for (const key of ACTOR_KEYS) $(`actor-${key}`).addEventListener('change', () => {
    if (!editable()) return;
    const element = $(`actor-${key}`), current = talkActorImage(design(), ratio);
    const value = element.type === 'checkbox' ? element.checked : element.type === 'number' ? numberOr(element, current[key]) : element.value;
    session.seal();
    edit(withTalk(design(), ratio, { actorImage: normalizeActorImage({ ...current, [key]: value }) }), { label: '立ち絵画像の配置', ratio });
    actorFields();
  });
  $('draft-css').addEventListener('input', () => {
    if (!editable()) return;
    edit({ ...design(), theme: $('draft-css').value }, { label: 'テーマCSS', merge: 'css' });
    status(cssError ? `入力したCSSは未反映です：${cssError}` : 'CSSをプレビューしました。適用するまでは保存されません。');
  });
  $('draft-css').addEventListener('change', () => session?.seal());
  $('draft-css-file').onchange = async () => {
    const file = $('draft-css-file').files[0]; $('draft-css-file').value = '';
    if (!file || !editable()) return;
    const token = epoch, request = Symbol();
    requests.set('css-file', request);
    try {
      if (file.size > MAX_THEME_CSS_BYTES) throw new Error('CSSは1MB以内にしてください。');
      const css = await file.text();
      if (!isCurrent(token) || requests.get('css-file') !== request) return;
      session.seal(); edit({ ...design(), theme: css }, { label: 'CSSファイル' });
      status(cssError ? `入力したCSSは未反映です：${cssError}` : 'CSSファイルを下書きに読み込みました。適用するまでは保存されません。');
    } catch (error) { if (isCurrent(token)) status(`読み込めませんでした：${error.message}`); }
    finally { if (isCurrent(token) && requests.get('css-file') === request) requests.delete('css-file'); }
  };
  $('draft-css-clear').onclick = () => { if (session) { requests.delete('css-file'); session.seal(); edit({ ...design(), theme: '' }, { label: 'CSSの解除' }); status('CSSを解除しました。適用するまでは保存されません。'); } };
  $('draft-css-export').onclick = () => {
    if (!session) return;
    const url = URL.createObjectURL(new Blob([design().theme], { type: 'text/css' }));
    const link = document.createElement('a'); link.href = url; link.download = 'pokome-theme.css'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $('draft-reset').onclick = async () => {
    if (!editable() || !previewStage) return;
    if (!await confirmAction('デザイン全体を標準に戻しますか？', '出力の大きさ・テーマCSS・すべての比率の配置と追加の文字・画像・立ち絵画像の配置を含めて、標準のデザインを下書きに読み込みます。「適用」するまで保存しません。', '標準を下書きに読み込む', 'キャンセル') || !editable()) return;
    invalidate(); session.seal(); selected = 'screen';
    edit({ ...defaultDesign(), name: design().name }, { label: 'デザイン全体を標準に戻す' });
    status('標準のデザインを下書きに読み込みました。「取り消し」で戻せます。');
  };
  // Shows the ratio an undone or redone operation belongs to.
  function showRatio(target) {
    if (!target || target === ratio) return;
    $('preview-width').value = PREVIEW_SIZES.find(value => nearestRatio(...size(value)) === target);
    ratio = target; scale();
  }
  function step(direction) {
    if (!editable()) return;
    dragCleanup?.();
    const entry = direction === 'undo' ? session.undo() : session.redo();
    if (!entry) return;
    showRatio(entry.ratio); refresh();
    status(`「${entry.label || '変更'}」を${direction === 'undo' ? '取り消しました' : 'やり直しました'}${entry.ratio ? `（${entry.ratio}）` : ''}。`);
  }
  $('undo-design').onclick = () => step('undo');
  $('redo-design').onclick = () => step('redo');
  // Text and number fields keep their own Ctrl+Z while they have focus.
  function historyKey(event) {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || !session) return;
    const key = event.key.toLowerCase();
    if (key !== 'z' && key !== 'y') return;
    if (event.composedPath()[0]?.matches?.('textarea, input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=button])')) return;
    event.preventDefault();
    step(key === 'z' && !event.shiftKey ? 'undo' : 'redo');
  }
  dialog.addEventListener('keydown', historyKey);
  // Reloading or closing the tab would lose the draft.
  window.addEventListener('beforeunload', event => { if (session && !presetDraft && session.dirty) { event.preventDefault(); event.returnValue = ''; } });
  $('discard-design').onclick = async () => {
    if (!session || saving || !session.dirty) return;
    if (!await confirmAction('変更をすべて破棄しますか？', 'この編集での変更をすべて破棄します。すべての比率の変更と、取り消し・やり直しの履歴が消えます。エディタは開いたままです。', '変更をすべて破棄', 'キャンセル') || !session) return;
    invalidate(); session.discard(); refresh();
    status(session.stale ? STALE_DRAFT : '変更をすべて破棄しました。編集を始めたときの内容を表示しています。');
  };
  $('restart-design').onclick = async () => {
    if (!session?.stale || saving) return;
    if (session.dirty && (!await confirmAction('最新のデザインからやり直しますか？', 'この下書きの変更はすべての比率で破棄されます。', '下書きを破棄してやり直す', 'キャンセル') || !session)) return;
    invalidate();
    try { await designStore.waitForSaves(); } catch { /* The store shows the saved design. */ }
    if (!session) return;
    session.restart(designStore.design, designStore.revision); compiledSource = null; refresh();
    status('最新のデザインから編集をやり直しています。');
  };
  $('apply-design').onclick = async () => {
    if (!session || pending || saving || !previewStage) return;
    const token = epoch;
    if (presetDraft) {
      pending++; buttons();
      try {
        if (session.stale || designStore.revision !== session.revision) throw new Error('別の画面で見た目が変更されました。キャンセルして開き直してください。');
        if (!await presetApply(presetDraft, session.revision)) return;
        if (!isCurrent(token)) return;
        close(); $('preview-result').textContent = 'プリセットを適用・保存しました。';
      } catch (error) { if (isCurrent(token)) status(`適用できませんでした：${error.message}`); }
      finally { if (isCurrent(token)) { pending--; buttons(); } }
      return;
    }
    if (!session.dirty) { close(); $('preview-result').textContent = '変更はありませんでした。'; return; }
    session.seal(); saving = true; buttons(); status('適用しています…');
    try {
      if (cssError) throw new Error(`入力したCSSは未反映です：${cssError}`);
      compileTheme(design().theme);
      await designStore.applyDraft(design(), session.revision);
      if (!isCurrent(token)) return;
      // The store has already shown the stored design on every page.
      saving = false; close(); $('preview-result').textContent = 'デザインを適用・保存しました。';
    } catch (error) {
      if (!isCurrent(token)) return;
      saving = false;
      if (error.conflict) session.markStale();
      status(`適用できませんでした：${error.message}`); buttons();
    }
  };
  function showLive() { overlays = storedOverlays(); renderOverlays(live, resolveOverlayAssets(overlays)); }
  return {
    openPreset(preset, onApply) { return openPreview(structuredClone(preset), onApply); },
    reset() { if (session) close(); overlays = normalizeOverlays(); renderOverlays(live, overlays); },
    // The talk screen switched ratio: show that ratio's additions.
    showLive,
    getOverlays: () => clone(overlays),
    // Another page saved the design: show it, and refuse to apply an older draft.
    // A failed save only restores the saved design; an open draft stays usable.
    reload(detail = { external: true }) {
      showLive();
      if (session && detail.external && !saving) { session.markStale(); status(STALE_DRAFT); buttons(); }
    },
  };
}
