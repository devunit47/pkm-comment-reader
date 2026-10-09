import { normalizeCommentContent, parseTwitchEmotes } from '../shared/comment-model.js';
import { normalizeStudio, applyCommentPreset, matchCommentPreset, COMMENT_PRESETS } from '../shared/studio.js';
import { compileTheme, DEFAULT_THEME_CSS, MAX_THEME_CSS_BYTES } from '../shared/theme.js';
import { OUTPUT_SIZES } from '../shared/output-protocol.js';
import { renderStageAppearance, renderOverlays, renderStageComments, renderPinnedComment, selectOutputComments, markClippedComments, applyTalkLayout } from './stage-appearance.js';
import { MAX_OVERLAYS, normalizeOverlays, createOverlay, removeOverlay, addOverlayAsset, overlayBounds } from '../shared/overlay-model.js';
import { resolveStudioImages, resolveOverlayAssets, studioOptions, overlayOptions, PREVIEW_SIZES, PORTRAIT_COVERED, nearestRatio, talkLayout, talkOverlays, talkActorImage, normalizeActorImage, withTalk, defaultDesign } from '../shared/design-model.js';
import { checkImageFile, STALE_DRAFT } from './design-client.js';
import { PANEL_IDS, normalizeLayout, talkSpeechStyles } from '../shared/workspace-model.js';
import { canvasOrder, layoutFromRects, moveCanvasTarget, copyTalkRatio, resetTalkRatio } from '../shared/canvas-model.js';
import { createDraftSession } from '../shared/design-draft.js';

const clone = value => structuredClone(value);
// Stable numbered samples reveal ordering without copying private chat.
const SAMPLE_COMMENTS = Object.freeze([
  'こんにちは。表示の大きさを確認しています。', '文字と背景の組み合わせを試しています。',
  '少し長めの文章でも読みやすい配置にできます。', '名前と本文の間隔を確認しましょう。',
  '新しいコメントがどちらに出るかを試しています。', '画面の端に文字が寄りすぎないか確認します。',
  'コメント欄の幅で折り返しが変わります。', '背景が明るい場面と暗い場面で確認しましょう。',
  '表示件数は履歴の保持件数とは別の設定です。', 'これが最後に届いたサンプルコメントです。',
].map((text, index) => {
  if ((index === 0 || index === 9)) text += ' 😀 Kappa';
  const start = Array.from(text).length - 5;
  return { id: `sample-${index + 1}`, user: `サンプル${String(index + 1).padStart(2, '0')}`, receivedAt: index + 1,
    ...normalizeCommentContent({ text, badges: (index === 0 || index === 9) ? ['broadcaster', 'moderator', 'vip', 'subscriber'] : [], color: ['#ffffff', '#000000', '#9146ff', '#23f995'][index % 4], parts: parseTwitchEmotes(text, (index === 0 || index === 9) ? `25:${start}-${start + 4}` : '') }) };
}));
const SAMPLE_PINNED = Object.freeze({ id: 'sample-pinned', user: '固定のサンプル',
  ...normalizeCommentContent({ text: '取り上げたいコメントをここに固定できます。 😀 Kappa', color: '#ffffff',
    badges: ['broadcaster', 'moderator', 'vip', 'subscriber'],
    parts: [{ type: 'text', text: '取り上げたいコメントをここに固定できます。 😀 ' }, { type: 'emote', id: '25', name: 'Kappa' }] }) });
const SAMPLE_EVENTS = Object.freeze(Object.fromEntries([
  ['sub', 'サブスク', { kind: 'sub', plan: 'Prime', cumulativeMonths: 1 }],
  ['resub', '再サブスク', { kind: 'resub', plan: '1000', cumulativeMonths: 6, streakMonths: 3 }],
  ['gift', 'サブスクギフト', { kind: 'gift', plan: '2000', giftMonths: 3, recipient: 'ギフトを受け取ったサンプルさん' }],
  ['giftBomb', 'まとめてギフト', { kind: 'giftBomb', plan: '1000' }],
  ['bits', 'ビッツ', { kind: 'bits', bits: 100 }],
  ['anonymousGift', '匿名ギフト', { kind: 'gift', anonymous: true, plan: '1000', recipient: '匿名ギフトを受け取ったサンプルさん' }],
].map(([key, label, event]) => [key, { label, message: { id: `sample-event-${key}`, user: '表示の折り返しを確認する長い名前のサンプルさん', receivedAt: 11, event,
  ...normalizeCommentContent({ text: ['resub', 'bits'].includes(key) ? 'いつも楽しい配信をありがとう！ 😀 Kappa' : '', color: '#9146ff', badges: ['subscriber'] }) } }])));
const size = value => value.split('x').map(Number);
// Panels and additions share the same canvas controls.
const PANEL_TARGETS = Object.freeze([['screen', '画面全体'], ['header', 'ヘッダー（タイトル）'], ['chat', 'コメント欄'], ['speech', '読み上げ'], ['actor', '立ち絵'], ['footer', 'フッター'], ['pinned', '固定コメント']]);
// Colons cannot occur in saved overlay IDs, so reserved panel names get an unambiguous edit key.
const overlayKey = id => PANEL_TARGETS.some(([panel]) => panel === id) ? `overlay:${id}` : id;
const overlayId = key => key.startsWith('overlay:') ? key.slice(8) : key;
const TYPED_KEYS = ['title', 'subtitle', 'footer', 'speechTitle', 'accent', 'speechBackground', 'speechTextColor', 'fontSize', 'commentItemOpacity', 'commentPanelOpacity', 'commentOutlineColor'];
const NUMBER_KEYS = ['fontSize', 'speechFontSize', 'maxVisible', 'holdSeconds', 'commentItemOpacity', 'commentPanelOpacity'], NULLABLE_KEYS = ['commentMaxLines', 'commentGap', 'commentLineHeight'];
// '' keeps the theme's color; the mode select chooses between it and the color input.
const COLOR_MODE_KEYS = ['commentTextColor', 'commentAuthorColor'];
const FIELD_KEYS = ['theme', 'accentMode', 'accent', 'decoration', 'title', 'subtitle', 'footer', 'speechTitle', 'fontSize', 'speechFontSize', 'speechStyle', 'speechBackground', 'speechTextColor', 'commentStyle', 'maxVisible', 'holdSeconds', 'newestPosition', 'source', 'actorAppearance', 'commentPanel', 'commentPanelOpacity', 'commentItemBackground', 'commentItemOpacity', 'commentOutline', 'commentOutlineColor', 'commentLineHeight', 'commentMaxLines', 'commentGap', 'commentDivider', 'commentLabel', 'commentEmotes', 'commentBadges', 'commentEvents'];
const OUTPUT_LABELS = { '1920x1080': '1920 × 1080（横）', '1280x720': '1280 × 720（横）', '1080x1920': '1080 × 1920（縦）', '1440x1080': '1440 × 1080（4:3）' };
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const ACTOR_KEYS = ['mode', 'scale', 'alignX', 'alignY', 'offsetX', 'offsetY', 'overflow'];
const options = pairs => pairs.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
const textField = (key, label, max) => `<label>${label}<input id="draft-${key}" type="text" maxlength="${max}"></label>`;

const LOCAL_PICKERS = { css: 'styles', actor: 'images', speech: 'images', overlay: 'images' };
const localPicker = id => `<section id="local-${id}" class="local-picker"><details><summary>customizationフォルダーから選ぶ</summary><p><small>保存場所：<span class="local-directory">取得中…</span><br>${id === 'css' ? 'customization/styles のCSS（UTF-8・1MBまで）' : 'customization/images のPNG・JPEG・WebP・GIF（20MB・1600万画素まで）'}。直下のファイルだけが対象です。元ファイルを変えたら読み込み直してください。</small></p><button class="local-refresh" type="button">一覧を更新</button><p class="local-status" role="status"></p><label>${id === 'css' ? 'CSS' : '画像'}<select id="local-${id}-select" disabled></select></label><button id="local-${id}-load" type="button" disabled>下書きに読み込む</button></details></section>`;

const STYLE = `:host{display:block;color:#edf4e9;font:14px system-ui;margin-bottom:24px}*{box-sizing:border-box}section.entry{overflow-wrap:anywhere;background:#1a2325;border:1px solid #506960;border-radius:12px;padding:24px}h2,h3,p{margin:0 0 12px}h2{font-size:18px}h3{font-size:15px}p{line-height:1.7;color:#c0d0c8}
button,input,select,textarea{font:inherit;background:#101b18;color:#edf4e9;border:1px solid #70877b;border-radius:6px;padding:8px;max-width:100%}button{cursor:pointer}button:disabled,input:disabled,select:disabled{opacity:.5;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid #ace5cd;outline-offset:2px}
label{display:grid;grid-template-columns:minmax(0,1fr);min-width:0;gap:5px;margin:10px 0}select{width:100%;min-width:0}textarea{width:100%;resize:vertical}input[type=file]{width:100%;min-width:0}input[type=color]{width:100%;height:40px;padding:3px}.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.primary{background:#ace5cd;color:#11271e;font-weight:700}.danger{border-color:#e6a0a0}
dialog{background:#101a18;color:#edf4e9;padding:0;border:0}#design-dialog{position:fixed;inset:0;margin:0;width:100%;height:100%;max-width:none;max-height:none;overflow:hidden}#design-dialog[open]{display:grid;grid-template-rows:auto auto minmax(0,1fr)}dialog::backdrop{background:#000b}dialog:not([open]){display:none}
.bar{display:flex;gap:8px 16px;justify-content:space-between;align-items:center;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid #40554b}.bar h2{margin:0}.title{display:flex;gap:4px 12px;align-items:baseline;flex-wrap:wrap;min-width:0}#draft-state{color:#ffd88a;font-weight:700}
#design-status{margin:0;padding:6px 16px;min-height:24px}.editor{display:grid;grid-template-columns:200px minmax(0,1fr) 320px;min-height:0}.side,.center{min-width:0;min-height:0;overflow:auto;padding:12px 14px}.left{border-right:1px solid #40554b}.right{border-left:1px solid #40554b}
.center{display:flex;flex-direction:column;gap:6px}.center label{margin:0}.view{display:flex;gap:4px 12px;flex-wrap:wrap;align-items:end}.view>label{flex:0 1 auto;min-width:0;max-width:100%}.stage-box{flex:1;min-height:160px;overflow:hidden;display:flex;justify-content:center;align-items:flex-start}.viewport{position:relative;overflow:hidden;background:#080e0c;border:1px solid #5d776b;border-radius:8px;flex:none}
iframe{position:absolute;left:0;top:0;border:0;transform-origin:top left;background:#122321}#target-select{width:100%;min-height:200px;padding:4px}#target-select option{padding:4px 6px}#target-select optgroup{color:#c0d0c8}.numbers{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 10px}.numbers input{width:100%}
details{margin:12px 0;border-top:1px solid #40554b;padding-top:10px}summary{cursor:pointer}small{line-height:1.6;color:#c0d0c8}.check{display:flex;gap:8px;align-items:center}.scope{display:inline-block;font-size:12px;border:1px solid #70877b;border-radius:999px;padding:1px 8px;margin:4px 0 2px;color:#c0d0c8}[data-target][hidden],#overlay-text-fields[hidden],#restart-design[hidden]{display:none}.tabs{display:none}
#editor-confirm{max-width:min(480px,calc(100vw - 32px));border:1px solid #ace5cd;border-radius:12px;padding:20px}
dialog[data-mode=preset] .side,dialog[data-mode=preset] .edit-only{display:none}dialog[data-mode=preset] .editor{grid-template-columns:minmax(0,1fr)}
@media(max-width:1199px){.editor{grid-template-columns:170px minmax(0,1fr) 290px}}
@media(max-width:767px){#design-dialog[open]{display:block;overflow:auto}.bar{position:sticky;top:0;z-index:1;background:#101a18}.editor{display:flex;flex-direction:column}.center{order:-1}.side,.center{overflow:visible}.left,.right{border:0}.stage-box{flex:none;min-height:0}.tabs{display:flex;gap:8px;padding:8px 14px 0}.tabs button[aria-pressed=true]{background:#ace5cd;color:#11271e}#design-dialog[data-tab=targets] .right,#design-dialog[data-tab=settings] .left{display:none}dialog[data-mode=preset] .tabs{display:none}}`;

const SNAP_STYLE = `#canvas-order[hidden],#snap-lines[hidden]{display:none}#snap-lines{position:absolute;inset:0;pointer-events:none;z-index:100}#snap-lines i{position:absolute;border-color:#ffcc6f;border-style:solid}#snap-lines i:first-child{top:0;bottom:0;border-width:0 0 0 1px}#snap-lines i:last-child{left:0;right:0;border-width:1px 0 0}.canvas-target[data-selected=true]>.canvas-handle{z-index:100}`;
const CANVAS_STYLE = "\n#canvas-layer{position:absolute;inset:0;pointer-events:none;isolation:isolate}.canvas-target{position:absolute;pointer-events:auto;touch-action:none;outline:0;cursor:move}.canvas-target[data-selected=true]{outline:2px solid #fff;box-shadow:0 0 0 3px #245a46}.canvas-target:focus-visible{outline:3px solid #ffcc6f}.canvas-target[hidden],#panel-placement[hidden],#preview-guides-option[hidden]{display:none}.canvas-handle{display:none;position:absolute;width:16px;height:16px;background:#fff;border:2px solid #245a46;touch-action:none;transform:translate(-50%,-50%)}.canvas-target[data-selected=true]>.canvas-handle{display:block}.canvas-handle[data-edge=n]{left:50%;top:0;cursor:ns-resize}.canvas-handle[data-edge=s]{left:50%;top:100%;cursor:ns-resize}.canvas-handle[data-edge=e]{left:100%;top:50%;cursor:ew-resize}.canvas-handle[data-edge=w]{left:0;top:50%;cursor:ew-resize}.canvas-handle[data-edge=ne]{left:100%;top:0;cursor:nesw-resize}.canvas-handle[data-edge=nw]{left:0;top:0;cursor:nwse-resize}.canvas-handle[data-edge=se]{left:100%;top:100%;cursor:nwse-resize}.canvas-handle[data-edge=sw]{left:0;top:100%;cursor:nesw-resize}.stage-box{padding:28px;align-items:center;min-width:0;background:#080e0c}.viewport{overflow:visible;border-radius:0;border:0;outline:1px solid #c0d0c8}iframe{pointer-events:none}.bar,.side,.center{overflow-wrap:anywhere}@media(max-width:300px){.numbers{grid-template-columns:minmax(0,1fr)}.bar{padding:8px}.side,.center{padding:8px}.stage-box{padding:12px}}\n";

const MARKUP = `<section class="entry"><h2>デザインエディタ</h2><p>配色・文章・コメント欄・読み上げ・立ち絵の見た目と、追加の文字・画像、テーマCSSを、配信画面を見ながら1つの下書きで編集します。「適用」を押すまで配信画面には反映されません。</p><button id="open-design-preview" class="primary" type="button">デザインを編集</button><p id="preview-result" role="status"></p><p id="applied-design-summary"></p><p><small>雑談画面の配置と出力の大きさも、ここで下書きとして編集します。画面収録中はエディタも映るため、OBSの別シーンなどで編集してください。</small></p></section>
<dialog id="design-dialog" aria-labelledby="design-title" data-tab="targets"><div class="bar"><div class="title"><h2 id="design-title">デザインエディタ</h2><span id="draft-state" role="status"></span><div class="actions edit-only"><button id="undo-design" type="button" aria-keyshortcuts="Control+Z">取り消し</button><button id="redo-design" type="button" aria-keyshortcuts="Control+Shift+Z Control+Y">やり直し</button></div></div><div class="actions"><button id="restart-design" type="button" hidden>最新のデザインからやり直す</button><button id="discard-design" class="edit-only danger" type="button">変更をすべて破棄</button><button id="apply-design" class="primary" type="button">適用</button><button id="cancel-design" type="button">閉じる</button></div></div>
<p id="design-status" role="status" aria-live="polite"></p>
<div class="editor"><div class="tabs edit-only" role="group" aria-label="表示する欄"><button id="show-targets" type="button" aria-pressed="true">対象</button><button id="show-settings" type="button" aria-pressed="false">設定</button></div>
<aside class="side left" aria-label="道具と対象"><h3>道具</h3><div class="actions"><button id="add-text" type="button">文字を追加</button></div><label>画像を追加<input id="overlay-image" type="file" accept="image/png,image/jpeg,image/webp,image/gif"></label>${localPicker('overlay')}<p><small>追加は各比率20個まで。画像はPNG・JPEG・WebP・GIF、1枚20MB・1600万画素まで。</small></p><details id="target-details" open><summary>対象一覧</summary><label>編集する対象<select id="target-select" size="12"></select></label></details></aside>
<div class="center"><div class="view"><label>編集する比率<select id="preview-ratio">${options([["16:9", "16:9"], ["9:16", "9:16"], ["4:3", "4:3"]])}</select></label><label>確認サイズ<select id="preview-width">${PREVIEW_SIZES.map(value => `<option value="${value}">${value.replace('x', ' × ')}（${nearestRatio(...size(value))}）</option>`).join('')}</select></label><label class="check" id="preview-guides-option"><input id="preview-guides" type="checkbox" checked>アプリで隠れやすい範囲を表示</label></div><p id="preview-ratio-help"><small>比率ごとに、配置・追加の文字と画像・立ち絵画像の配置を別々に保存します。</small></p><div class="stage-box" id="stage-box"><div class="viewport" id="preview-viewport"><iframe id="design-preview-frame" title="雑談画面のデザインプレビュー" sandbox="allow-same-origin"></iframe><div id="canvas-layer" class="edit-only"></div><div id="snap-lines" hidden aria-hidden="true"><i></i><i></i></div></div></div><p class="edit-only"><small>サンプル表示です。チャット接続・音声再生は行いません。外部フォントを読み込まないため、文字の折り返しは適用後も確認してください。選択枠の内側で移動、辺・角のハンドルでサイズ変更できます。画像の角をShiftとドラッグすると縦横比を保ちます。狭い画面では右欄の数値を使ってください。矢印キーで移動、Shift＋矢印でサイズ変更。画面収録・ウィンドウキャプチャ中は、この編集画面も映るためOBSの別シーンなどで編集してください。</small></p></div>
<aside class="side right" aria-labelledby="target-heading"><h3 id="target-heading">画面全体</h3><div id="canvas-order" class="actions" hidden><button id="canvas-backward" type="button">後ろへ</button><button id="canvas-forward" type="button">前へ</button></div><section id="panel-placement" hidden><span class="scope">この比率の配置</span><div class="numbers">${[["x", "横位置（%）"], ["y", "縦位置（%）"], ["w", "幅（%）"], ["h", "高さ（%）"], ["z", "重なり順 0〜99"]].map(([key, label]) => `<label>${label}<input id="panel-${key}" type="number" min="${["w", "h"].includes(key) ? 5 : 0}" max="${key === "z" ? 99 : 100}" step="any"></label>`).join("")}</div><label class="check"><input id="panel-hidden" type="checkbox">このパネルを非表示</label></section>
<div data-target="screen"><section><h3>この比率の配置</h3><label>コピー元の比率<select id="copy-ratio-source"></select></label><button id="copy-ratio" type="button">別の比率からコピー</button><button id="reset-ratio" type="button">この比率の配置を標準に戻す</button><p><small>標準に戻すのはこの比率の6パネルと立ち絵画像の配置です。追加の文字・画像と、全比率共通の見た目は残します。</small></p></section><span class="scope">全比率共通の見た目</span><label>テーマ<select id="draft-theme">${options([['mint', 'ミントの夜'], ['rose', 'ローズの夜'], ['violet', 'すみれの夜'], ['paper', 'お昼の喫茶室']])}</select></label><label>配色モード<select id="draft-accentMode">${options([['theme', 'テーマに合わせる'], ['custom', '自分で設定']])}</select></label><label>アクセントカラー<input id="draft-accent" type="color"></label><label class="check"><input id="draft-decoration" type="checkbox">星やハートの装飾を表示</label>
<label>出力の大きさ<select id="draft-outputSize">${options(Object.keys(OUTPUT_SIZES).map(value => [value, OUTPUT_LABELS[value]]))}</select></label><p><small>配信出力と雑談画面はこの大きさの比率で表示します。確認サイズを変えても出力の大きさは変わりません。</small></p>
<details><summary>詳細：テーマCSS</summary><label>CSS<textarea id="draft-css" rows="8" spellcheck="false" placeholder="${DEFAULT_THEME_CSS.replace(/"/g, '&quot;')}"></textarea></label><p><small>.pokome-workspace 以下のCSSだけを使えます。画像URL・外部フォントは使えません。CSSエラー中は最後の有効なプレビューを表示し、適用できません。CSSで位置や大きさを指定すると、設定と重なる場合があります。動かせないときはCSSを解除または編集してください。</small></p><label>CSSファイルを読み込む<input id="draft-css-file" type="file" accept=".css,text/css"></label>${localPicker('css')}<div class="actions"><button id="draft-css-clear" type="button">CSSを解除</button><button id="draft-css-export" type="button">編集中のCSSを書き出す</button></div><p><small>書き出すのはCSSだけです。配置・画像・そのほかの設定は含みません。</small></p></details>
<button id="draft-reset" type="button">デザイン全体を標準に戻す</button><p><small>出力の大きさ・テーマCSS・すべての比率の配置と追加の文字・画像を含めて、標準のデザインを下書きに読み込みます。「適用」までは保存しません。</small></p></div>
<div data-target="header" hidden><span class="scope">全比率共通の見た目</span>${textField('title', 'タイトル', 60)}${textField('subtitle', 'サブタイトル', 100)}</div>
<div data-target="chat" hidden><span class="scope">全比率共通の見た目</span><label>コメント欄の見た目をまとめて切り替え<select id="draft-commentPreset">${options([...Object.entries(COMMENT_PRESETS).map(([value, preset]) => [value, preset.label]), ['', '個別に調整中']])}</select></label><p><small>選ぶと下の見た目とコメントの表示をまとめて変更します。配置・文字サイズ・表示件数は変えません。</small></p><label>コメントの表示<select id="draft-commentStyle">${options([['stacked', '名前を上に表示'], ['anonymous', '名前なし'], ['inline', '名前と本文を横並び'], ['compact', '1行コンパクト']])}</select></label><label>コメントの文字サイズ<input id="draft-fontSize" type="number" min="16" max="64" step="1"></label><p><small>テーマCSSに文字サイズの指定がある場合は、その指定が優先されます。</small></p>
<label class="check"><input id="draft-commentEvents" type="checkbox">特別なカードを表示する</label><p><small>オフでも投稿者の本文は通常のコメントとして表示します。ホームの一覧・読み上げ・固定内容・履歴は保持します。本文のない固定枠は隠れますが、オンに戻すと再表示します。</small></p><label>確認する見本<select id="preview-comment-sample">${options([['normal', '通常のコメント'], ...Object.entries(SAMPLE_EVENTS).map(([key, value]) => [key, value.label])])}</select></label><p><small>選んだ通知を新着と固定欄に表示します。見本の選択は保存しません。</small></p>
<label>配信出力の表示件数<select id="draft-maxVisible">${options([['0', '制限なし'], ...Array.from({ length: 30 }, (_, index) => [String(index + 1), `${index + 1}件`])])}</select></label><label>配信出力の表示時間<select id="draft-holdSeconds">${options([['0', '時間では消さない'], ['5', '5秒'], ['15', '15秒'], ['30', '30秒']])}</select></label><label>配信出力の新着位置<select id="draft-newestPosition">${options([['bottom', '下'], ['top', '上']])}</select></label><p><small>サンプルは時間で消えません。雑談画面の履歴表示は変わりません。</small></p>
<label>投稿ごとの背景<select id="draft-commentItemBackground">${options([['theme', 'テーマのまま'], ['none', 'なし'], ['light', '白い丸い背景'], ['dark', '黒い丸い背景']])}</select></label><label>投稿背景の不透明度（%）<input id="draft-commentItemOpacity" type="number" min="0" max="100" step="1"></label><label>本文の最大行数<select id="draft-commentMaxLines">${options([['', 'テーマのまま'], ['0', '制限なし'], ...[1, 2, 3, 4, 5].map(lines => [String(lines), `${lines}行`])])}</select></label><p><small>本文だけを省略して表示します。保存した本文と読み上げには影響しません。「1行コンパクト」にも優先します。</small></p><label>コメント同士の間隔<select id="draft-commentGap">${options([['', 'テーマのまま'], ...[0, 4, 8, 12, 14, 16, 24].map(gap => [String(gap), `${gap}px`])])}</select></label>
<label>パネルの背景<select id="draft-commentPanel">${options([['theme', 'テーマのまま'], ['none', 'なし（枠も消す）'], ['light', '白'], ['dark', '黒']])}</select></label><label>パネルの不透明度（%）<input id="draft-commentPanelOpacity" type="number" min="0" max="100" step="5"></label>
${COLOR_MODE_KEYS.map(key => { const label = key === 'commentTextColor' ? '本文の色' : '名前の色'; return `<label>${label}<select id="draft-${key}Mode">${options([['theme', 'テーマのまま'], ...(key === 'commentAuthorColor' ? [['service', 'サービスの色']] : []), ['custom', '色を指定']])}</select></label><label>${label}（指定色）<input id="draft-${key}" type="color"></label>`; }).join('')}
<label class="check"><input id="draft-commentBadges" type="checkbox">Twitchの役割バッジを表示</label><p class="muted">配信者・モデレーター・VIP・サブスクの記号だけを表示します。チャンネル独自の画像や月数は表示しません。</p>
<label>Twitchエモート<select id="draft-commentEmotes">${options([['image', '画像で表示'], ['text', '文字のまま']])}</select></label><p class="muted">エモートは読み上げません。画像表示ではTwitchのCDNへ通信します。</p>
<label>文字の縁取り<select id="draft-commentOutline">${options([['none', 'なし'], ['thin', '細い'], ['thick', '太い']])}</select></label><label>縁取りの色<input id="draft-commentOutlineColor" type="color"></label><label>行間<select id="draft-commentLineHeight">${options([['', 'テーマのまま'], ['1.2', '1.2（詰める）'], ['1.35', '1.35'], ['1.5', '1.5'], ['1.75', '1.75'], ['2', '2.0（広い）']])}</select></label>
<label class="check"><input id="draft-commentDivider" type="checkbox">コメントの区切り線を表示</label><label class="check"><input id="draft-commentLabel" type="checkbox">見出し（「みんなのコメント」と件数）を表示</label><p><small>「テーマのまま」以外を選んだ項目は、テーマCSSより優先します。</small></p></div>
<div data-target="speech" hidden><span class="scope">全比率共通の見た目</span>${textField('speechTitle', '読み上げ枠の見出し', 40)}<label>読み上げの文字サイズ<select id="draft-speechFontSize">${options([16, 22, 28, 32].map(px => [String(px), `${px}px`]))}</select></label><label>読み上げ枠<select id="draft-speechStyle">${options([['panel', '通常のパネル'], ['bubble', 'セリフの吹き出し'], ['image', '背景画像']])}</select></label><label>吹き出し背景<input id="draft-speechBackground" type="color"></label><label>背景画像内の文字色<input id="draft-speechTextColor" type="color"></label><label>名前・コメントの背景画像<input id="draft-speechImage" type="file" accept="${IMAGE_ACCEPT}"></label>${localPicker('speech')}<p id="speech-image-status" role="status"></p><button id="draft-speechImage-reset" type="button">標準の背景画像に戻す</button><p><small>PNG・JPEG・WebP・GIF、20MB・1600万画素まで。画像は名前と本文だけの背景に表示します。</small></p></div>
<div data-target="actor" hidden><span class="scope">全比率共通の見た目</span><label>表示するもの<select id="draft-source">${options([['space', '空き枠 / OBSで映像を重ねる'], ['image', '立ち絵画像']])}</select></label><label>立ち絵画像<input id="draft-image" type="file" accept="${IMAGE_ACCEPT}"></label>${localPicker('actor')}<p id="actor-image-status" role="status"></p><button id="draft-image-remove" type="button">画像を削除</button><p><small>PNG・JPEG・WebP・GIF、20MB・1600万画素まで。透過PNGにも対応します。動くVtuberモデルや外部のワイプ映像は、空き枠にOBSのソースを重ねて使えます。</small></p><label>立ち絵の枠・背景・キャプション<select id="draft-actorAppearance">${options([['theme', 'テーマのまま'], ['none', 'すべて消す']])}</select></label>
<h3 id="draft-actor-heading">この比率の立ち絵画像の配置</h3><span class="scope">この比率の配置</span><label>画像の配置方法<select id="actor-mode">${options([['theme', 'テーマのまま'], ['custom', '自分で調整']])}</select></label><label>拡大率（%）<input id="actor-scale" type="number" min="100" max="200" step="1"></label><label>横位置合わせ<select id="actor-alignX">${options([['left', '左'], ['center', '中央'], ['right', '右']])}</select></label><label>縦位置合わせ<select id="actor-alignY">${options([['top', '上'], ['center', '中央'], ['bottom', '下（画像ファイルの下端）']])}</select></label><div class="numbers"><label>横の微調整（%）<input id="actor-offsetX" type="number" min="-100" max="100" step="any"></label><label>縦の微調整（%）<input id="actor-offsetY" type="number" min="-100" max="100" step="any"></label></div><label class="check"><input id="actor-overflow" type="checkbox">枠からはみ出す</label><p><small id="draft-actor-help"></small></p></div>
<div data-target="footer" hidden><span class="scope">全比率共通の見た目</span>${textField('footer', '画面下のひとこと', 100)}</div>
<div data-target="pinned" hidden><p>固定コメントの配置・大きさ・重なり順・非表示を、この比率で設定します。文字・名前・バッジ・エモート・背景などの見た目は「コメント欄」の設定を共用します。</p><p><small>架空の見本を表示しています。実際の固定内容は使いません。枠を非表示にしても固定は解除されません。</small></p></div>
<div data-target="overlay" hidden><span class="scope">この比率の配置</span><label class="check"><input id="overlay-hidden" type="checkbox">この項目を非表示</label><div id="overlay-text-fields"><label>表示する文章<textarea id="overlay-text" maxlength="1000" rows="3"></textarea></label><label>文字の色<input id="overlay-color" type="color"></label><label>文字の大きさ（px）<input id="overlay-font-size" type="number" min="12" max="160"></label></div><div class="numbers">${[['x', '横位置（%）'], ['y', '縦位置（%）'], ['w', '幅（%）'], ['h', '高さ（%）'], ['z', '重なり順 0〜99']].map(([key, label]) => `<label>${label}<input id="overlay-${key}" type="number" min="${['w', 'h'].includes(key) ? 2 : 0}" max="${key === 'z' ? 99 : 100}" step="1"></label>`).join('')}</div><p><small>画像は各辺に画面1枚分まで、幅・高さ200%まで置けます。枠は画面内に幅・高さ各2%残すよう補正します。文字は画面内に収めます。大きい重なり順の項目ほど手前に表示します。パネルも同じキャンバスで選んで配置できます。</small></p><button id="delete-overlay" class="danger" type="button">この項目を削除</button></div>
</aside></div></dialog>
<dialog id="editor-confirm" aria-labelledby="editor-confirm-title" aria-describedby="editor-confirm-message"><h3 id="editor-confirm-title"></h3><p id="editor-confirm-message"></p><div class="actions"><button id="editor-confirm-accept" class="danger" type="button"></button><button id="editor-confirm-cancel" class="primary" type="button"></button></div></dialog>`;

// The full-screen design editor. Everything edited here stays in one draft
// (every ratio) until Apply stores it with a single revision-checked write.
// getLiveRatio tells which ratio the talk screen shows.
export function initializeDesignPreview({ designStore, live, getLiveRatio = () => '16:9' }) {
  let presetDraft = null, presetApply = null, returnFocus = null, hostOrigin = null;
  const assetOptions = () => overlayOptions(presetDraft?.images || designStore.images), imageOptions = () => studioOptions(presetDraft?.images || designStore.images);
  const imageScope = () => presetDraft ? `presets/${presetDraft.id}` : 'current';
  const storedOverlays = () => talkOverlays(designStore.design, getLiveRatio());
  const previewRatio = () => $('preview-ratio').value;
  let overlays = storedOverlays(), session = null, ratio = '16:9', selected = 'screen', epoch = 0, pending = 0, saving = false, gesture = 0;
  let commentResizeObserver, previewStage, frameDoc, previewCSS, defaultImage, compiledCSS = '', compiledSource = '', cssError = '', renderedStudio = null, renderedActorImage = null, renderedRatio = null, dragCleanup, confirmation = null;
  const requests = new Map();
  const host = document.createElement('div'); host.id = 'design-preview-editor';
  document.getElementById('studio-page').prepend(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${STYLE}${CANVAS_STYLE}${SNAP_STYLE}</style>${MARKUP}`;
  shadow.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
  const $ = id => shadow.getElementById(id), dialog = $('design-dialog'), frame = $('design-preview-frame');
  const status = message => { $('design-status').textContent = message; };
  const design = () => session.design;
  const ratioOverlays = (r = ratio) => talkOverlays(design(), r);
  const currentItem = () => session ? ratioOverlays().items.find(item => overlayKey(item.id) === selected) : undefined;
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
    for (const id of Object.keys(LOCAL_PICKERS)) $('local-' + id + '-load').disabled = !editable() || !$('local-' + id + '-select').value || (id === 'overlay' && full);
    $('draft-state').textContent = !session ? '' : presetDraft ? 'プリセットを確認（編集不可）' : saving ? '適用中…' : session.stale ? '別の画面で変更されました' : session.dirty ? '下書き・未適用' : '変更なし';
  }
  function targets() {
    const items = ratioOverlays().items;
    if (!PANEL_TARGETS.some(([id]) => id === selected) && !items.some(item => overlayKey(item.id) === selected)) selected = 'screen';
    const ordered = canvasOrder(talkLayout(design(), ratio), ratioOverlays()).map(target => {
      const item = target.kind === 'overlay' ? items.find(entry => entry.id === target.id) : null;
      const name = item ? (item.type === 'text' ? item.text.slice(0,24) || '空の文字' : '画像') : PANEL_TARGETS.find(([id]) => id === target.id)[1];
      const hidden = item?.hidden ?? talkLayout(design(), ratio)?.panels[target.id]?.hidden;
      return [target.kind === 'overlay' ? overlayKey(target.id) : target.id, name + (hidden ? '（非表示）' : '')];
    });
    $('target-select').replaceChildren(...[['screen', '画面全体'], ...ordered].map(([value,text]) => { const option = document.createElement('option'); option.value = value; option.textContent = text; return option; }));
    $('canvas-order').hidden = selected === 'screen';
    const index = ordered.findIndex(([id]) => id === selected);
    $('canvas-backward').disabled = index <= 0 || !editable(); $('canvas-forward').disabled = index === ordered.length - 1 || !editable();
    const source = $('copy-ratio-source').value;
    $('copy-ratio-source').replaceChildren(...['16:9', '9:16', '4:3'].filter(r => r !== ratio).map(r => { const option = document.createElement('option'); option.value = r; option.textContent = r; return option; }));
    if (source !== ratio && source) $('copy-ratio-source').value = source;
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
      $(`draft-${key}Mode`).value = studio[key] === 'service' ? 'service' : studio[key] ? 'custom' : 'theme';
      $(`draft-${key}`).disabled = !studio[key] || studio[key] === 'service';
      if (studio[key] && studio[key] !== 'service' && $(`draft-${key}`) !== typing) $(`draft-${key}`).value = studio[key];
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
    compileDraftCSS(); targets(); overlayFields(); studioFields(typing); draw(); panelFields(); buttons();
  }
  function scale() {
    const [width, height] = size($('preview-width').value), box = $('stage-box');
    // A narrow dock stacks the canvas above the settings, so it cannot fill the height.
    const tall = matchMedia('(max-width: 767px)').matches ? innerHeight * .45 : box.clientHeight;
    const factor = Math.max(.005, Math.min(Math.max(1, box.clientWidth - 56) / width, Math.max(100, tall - 56) / height));
    frame.style.width = `${width}px`; frame.style.height = `${height}px`; frame.style.transform = `scale(${factor})`;
    $('preview-viewport').style.width = `${width * factor}px`; $('preview-viewport').style.height = `${height * factor}px`;
  }
  new ResizeObserver(() => { scale(); positionHits(); }).observe($('stage-box'));
  // Portrait apps cover the top and bottom; landscape players keep every edge.
  function drawGuides() {
    if (!frameDoc) return;
    const portrait = ratio === '9:16';
    let guides = frameDoc.getElementById('safe-guides');
    if (!guides) { guides = frameDoc.createElement('div'); guides.id = 'safe-guides'; frameDoc.body.append(guides); }
    guides.hidden = !$('preview-guides').checked;
    if (guides.dataset.ratio === ratio) return;
    guides.dataset.ratio = ratio;
    const shade = (edge, height) => { const element = frameDoc.createElement('div'); element.className = 'guide-shade'; element.style[edge] = '0'; element.style.height = `${height}%`; element.textContent = 'アプリの表示で隠れやすい範囲'; return element; };
    guides.replaceChildren(...(portrait ? [shade('top', PORTRAIT_COVERED.top), shade('bottom', PORTRAIT_COVERED.bottom)] : []));
  }
  function draw() {
    if (!previewStage || !session) return;
    const studio = design().studio, actorImage = talkActorImage(design(), ratio), layout = talkLayout(design(), ratio), state = ratioOverlays();
    if (renderedStudio !== studio || JSON.stringify(renderedActorImage) !== JSON.stringify(actorImage) || renderedRatio !== ratio) {
      renderStageAppearance(previewStage, resolveStudioImages(studio, imageScope()), defaultImage, { actorImage });
      renderedStudio = studio; renderedActorImage = actorImage; renderedRatio = ratio;
    }
    renderOverlays(previewStage, resolveOverlayAssets(state, imageScope()));
    const sample = SAMPLE_EVENTS[$('preview-comment-sample').value]?.message;
    const messages = sample ? [...SAMPLE_COMMENTS, sample] : SAMPLE_COMMENTS;
    renderStageComments(previewStage.querySelector('#stage-chat-list'), selectOutputComments(messages, studio, 0, false), studio);
    renderPinnedComment(previewStage, sample || SAMPLE_PINNED, studio);
    previewStage.querySelector('#stage-count').textContent = `${messages.length} COMMENTS`;
    const themeStyle = frameDoc.getElementById('preview-theme');
    if (themeStyle.textContent !== compiledCSS) themeStyle.textContent = compiledCSS;
    // The draft CSS can change the speech minimum, which moves the panels below it.
    applyTalkLayout(previewStage, layout);
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
  function changedItem(id, patch, settings = {}) {
    if (!session) return;
    const state = ratioOverlays();
    const next = normalizeOverlays({ ...state, items: state.items.map(item => item.id === overlayId(id) ? { ...item, ...patch } : item) }, assetOptions());
    edit(withTalk(design(), ratio, { overlays: next }), { label: '追加した項目', ratio, ...settings });
  }
  const resizePatch = (item, dx, dy) => ({
    w: item.type === 'image' ? item.w + dx : Math.min(item.w + dx, 100 - item.x),
    h: item.type === 'image' ? item.h + dy : Math.min(item.h + dy, 100 - item.y),
  });
  const panelElement = id => previewStage?.querySelector(`.stage-${id}`);
  const isPanel = id => PANEL_IDS.talk.includes(id);
  function measuredLayout() {
    if (!previewStage) return null;
    const rect = previewStage.getBoundingClientRect();
    return layoutFromRects(rect, Object.fromEntries(PANEL_IDS.talk.map(id => [id, panelElement(id).getBoundingClientRect()])));
  }
  const canvasLayout = () => talkLayout(design(), ratio) || measuredLayout();
  function panelFields(typing = null) {
    const panel = isPanel(selected) ? canvasLayout()?.panels[selected] : null;
    $('panel-placement').hidden = !panel;
    if (!panel) return;
    for (const key of ['x', 'y', 'w', 'h', 'z']) {
      if (`panel-${key}` !== typing) $(`panel-${key}`).value = Math.round(panel[key] * 100) / 100;
    }
    $('panel-hidden').checked = panel.hidden;
  }
  function changedTarget(id, patch, settings = {}) {
    if (!isPanel(id)) { changedItem(id, patch, settings); return; }
    const layout = canvasLayout();
    if (!layout) return;
    layout.panels[id] = { ...layout.panels[id], ...patch };
    edit(withTalk(design(), ratio, { layout: normalizeLayout(layout, PANEL_IDS.talk) }), { label: 'パネルの配置', ratio, ...settings });
  }
  function targetValue(id) { return isPanel(id) ? canvasLayout()?.panels[id] : ratioOverlays().items.find(item => overlayKey(item.id) === id); }
  function shownValue(id, resize, axes = [1, 1]) {
    const p = clone(targetValue(id));
    if (!isPanel(id) || p.hidden) return p;
    const stage = previewStage.getBoundingClientRect(), rect = panelElement(id).getBoundingClientRect();
    const shown = { x: (rect.left - stage.left + previewStage.scrollLeft) / stage.width * 100, y: (rect.top - stage.top + previewStage.scrollTop) / stage.height * 100, w: rect.width / stage.width * 100, h: rect.height / stage.height * 100 };
    if (id === 'speech') {
      if (resize) { if (axes[0]) { p.x = shown.x; p.w = shown.w; } if (axes[1]) { p.y = shown.y; p.h = shown.h; } }
      else { p.x = shown.x; p.y = shown.y; }
    } else if (!resize && Math.abs(shown.y - p.y) > .01) { p.y = shown.y; p.h = shown.h; }
    return p;
  }
  function limitPanelMove(id, patch) {
    if (!isPanel(id) || id === 'speech') return patch;
    const layout = canvasLayout(), minimum = parseFloat(frame.contentWindow.getComputedStyle(panelElement('speech')).minHeight) || 0;
    if (talkSpeechStyles({ ...layout.panels, [id]: patch }, minimum)[id]) patch.y = Math.max(patch.y, layout.panels.speech.y + minimum / previewStage.getBoundingClientRect().height * 100);
    return patch;
  }
  function positionHits() {
    const layer = $('canvas-layer');
    if (!session || !previewStage) { layer.replaceChildren(); return; }
    const canvas = previewStage.getBoundingClientRect(), factor = frame.getBoundingClientRect().width / frame.offsetWidth;
    const state = ratioOverlays(), layout = canvasLayout();
    const order = canvasOrder(layout, state);
    const old = new Map([...layer.children].map(element => [element.dataset.targetId, element]));
    for (const [index, entry] of (presetDraft ? [] : order).entries()) {
      const target = { ...entry, id: entry.kind === 'overlay' ? overlayKey(entry.id) : entry.id };
      const item = targetValue(target.id); if (!item) continue;
      let hit = old.get(target.id);
      if (!hit) {
        hit = document.createElement('div'); hit.className = 'canvas-target'; hit.dataset.targetId = target.id;
        hit.setAttribute('role', 'group');
        hit.addEventListener('pointerdown', event => startMove(event, target.id, event.target.dataset.edge || ''));
        hit.addEventListener('keydown', event => keyMove(event, target.id));
        hit.addEventListener('keyup', () => session?.seal());
        hit.addEventListener('focusout', () => session?.seal());
        for (const edge of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
          const handle = document.createElement('span'); handle.className = 'canvas-handle'; handle.dataset.edge = edge; handle.setAttribute('aria-hidden', 'true'); hit.append(handle);
        }
        layer.append(hit);
      }
      old.delete(target.id);
      hit.hidden = item.hidden && selected !== target.id;
      hit.dataset.selected = String(selected === target.id); hit.tabIndex = selected === target.id ? 0 : -1;
      hit.setAttribute('aria-label', `${PANEL_TARGETS.find(([id]) => id === target.id)?.[1] || (item.type === 'image' ? '追加した画像' : '追加した文字')}：矢印キーで移動、Shiftと矢印キーでサイズ変更`);
      const element = isPanel(target.id) ? panelElement(target.id) : previewStage.querySelector(`.pokome-overlay[data-overlay-id="${overlayId(target.id)}"]`);
      const rect = item.hidden ? { left: canvas.left + canvas.width * item.x / 100 - previewStage.scrollLeft, top: canvas.top + canvas.height * item.y / 100 - previewStage.scrollTop, width: canvas.width * item.w / 100, height: canvas.height * item.h / 100 } : element.getBoundingClientRect();
      // DOM order controls hit testing; an auto z lets the selected handles sit above every hit area.
      Object.assign(hit.style, { left: `${rect.left * factor}px`, top: `${rect.top * factor}px`, width: `${rect.width * factor}px`, height: `${rect.height * factor}px` });
      if (layer.children[index] !== hit) layer.insertBefore(hit, layer.children[index] || null);
    }
    for (const hit of old.values()) hit.remove();
    // Background layout must not discard a number before its change event.
    panelFields(shadow.activeElement?.id);
  }
  function resizeTarget(item, dx, dy, edge, keepRatio = false) {
    const image = item.type === 'image', minimum = isPanel(selected) ? 5 : 2, maximum = image ? 200 : 100;
    let w = item.w + (edge.includes('w') ? -dx : edge.includes('e') ? dx : 0), h = item.h + (edge.includes('n') ? -dy : edge.includes('s') ? dy : 0);
    const maxW = image ? maximum : edge.includes('w') ? item.x + item.w : 100 - item.x;
    const maxH = image ? maximum : edge.includes('n') ? item.y + item.h : 100 - item.y;
    if (keepRatio && image && edge.length === 2) {
      // Ratios of logical pixel dimensions cancel to the same common scale.
      let factor = Math.abs(w / item.w - 1) > Math.abs(h / item.h - 1) ? w / item.w : h / item.h;
      factor = Math.max(Math.max(minimum / item.w, minimum / item.h), Math.min(factor, maximum / item.w, maximum / item.h));
      w = item.w * factor; h = item.h * factor;
    } else { w = Math.max(minimum, Math.min(maxW, w)); h = Math.max(minimum, Math.min(maxH, h)); }
    return { w, h, x: edge.includes('w') ? item.x + item.w - w : item.x, y: edge.includes('n') ? item.y + item.h - h : item.y };
  }
  function select(target) { selected = target; refresh(); }
  function startMove(event, id, edge) {
    if (!editable() || event.button !== 0) return;
    event.preventDefault(); dragCleanup?.(); session.seal(); select(id);
    const button = event.currentTarget; button.focus();
    const saved = clone(targetValue(id)), original = shownValue(id, !!edge, [Number(/[ew]/.test(edge)), Number(/[ns]/.test(edge))]), token = epoch, merge = `drag:${++gesture}`;
    const canvas = previewStage.getBoundingClientRect(), factor = frame.getBoundingClientRect().width / frame.offsetWidth;
    const width = canvas.width * factor, height = canvas.height * factor;
    if (!width || !height) return;
    button.setPointerCapture(event.pointerId);
    const move = e => {
      if (!isCurrent(token)) return;
      const dx = (e.clientX - event.clientX) / width * 100, dy = (e.clientY - event.clientY) / height * 100;
      if (!dx && !dy) {
        // Returning to the origin restores the whole gesture, including a materialized layout.
        if (session.cancelOpen()) refresh();
        $('snap-lines').hidden = true;
        return;
      }
      const patch = edge ? resizeTarget(original, dx, dy, edge, e.shiftKey) : limitPanelMove(id, { ...original, x: original.x + dx, y: original.y + dy });
      // A CSS minimum may expand the other dimension; leave an untouched axis stored as it was.
      if (edge && !(e.shiftKey && original.type === 'image')) {
        if (!dx || !/[ew]/.test(edge)) { patch.x = saved.x; patch.w = saved.w; }
        if (!dy || !/[ns]/.test(edge)) { patch.y = saved.y; patch.h = saved.h; }
      }
      const snap = $('canvas-snap').checked && !e.altKey;
      if (snap) {
        for (const key of edge ? ['w', 'h'] : ['x', 'y']) {
          if (edge && ((key === 'w' && (!dx || !/[ew]/.test(edge))) || (key === 'h' && (!dy || !/[ns]/.test(edge))))) continue;
          patch[key] = Math.round(patch[key] / 2) * 2;
        }
        // Bounds take priority when snapping would round past the opposite edge.
        if (original.type !== 'image') {
          if (edge.includes('e')) patch.w = Math.min(patch.w, 100 - original.x);
          if (edge.includes('s')) patch.h = Math.min(patch.h, 100 - original.y);
        }
        if (edge.includes('w')) {
          if (original.type !== 'image') patch.w = Math.min(patch.w, original.x + original.w);
          patch.x = original.x + original.w - patch.w;
        }
        if (edge.includes('n')) {
          if (original.type !== 'image') patch.h = Math.min(patch.h, original.y + original.h);
          patch.y = original.y + original.h - patch.h;
        }
        if (e.shiftKey && original.type === 'image' && edge.length === 2) Object.assign(patch, resizeTarget(original, (patch.w - original.w) * (edge.includes('w') ? -1 : 1), (patch.h - original.h) * (edge.includes('n') ? -1 : 1), edge, true));
      }
      changedTarget(id, patch, { merge });
      const current = targetValue(id); $('snap-lines').hidden = !snap;
      $('snap-lines').children[0].style.left = (edge.includes('e') ? current.x + current.w : current.x) + '%';
      $('snap-lines').children[1].style.top = (edge.includes('s') ? current.y + current.h : current.y) + '%';
    };
    const finish = e => { cleanup(); if (!isCurrent(token)) return; if (e.type === 'pointercancel') session.cancelOpen(); else session.seal(); refresh(); };
    const cleanup = () => { $('snap-lines').hidden = true; button.removeEventListener('pointermove', move); button.removeEventListener('pointerup', finish); button.removeEventListener('pointercancel', finish); if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId); dragCleanup = null; };
    dragCleanup = () => { cleanup(); if (isCurrent(token)) { session.cancelOpen(); refresh(); } };
    button.addEventListener('pointermove', move); button.addEventListener('pointerup', finish); button.addEventListener('pointercancel', finish);
  }
  function keyMove(event, id) {
    if (event.key === 'Delete' && editable() && !isPanel(id)) { event.preventDefault(); $('delete-overlay').click(); return; }
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta || !editable()) return;
    event.preventDefault();
    if ($('canvas-snap').checked) { delta[0] *= 2; delta[1] *= 2; }
    const item = shownValue(id, event.shiftKey, delta), patch = event.shiftKey ? resizeTarget(item, ...delta, 'se') : limitPanelMove(id, { ...item, x: item.x + delta[0], y: item.y + delta[1] });
    changedTarget(id, patch, { merge: `key:${id}` });
  }

  function invalidate() { epoch++; requests.clear(); pending = 0; dragCleanup?.(); }
  function close() {
    commentResizeObserver?.disconnect(); commentResizeObserver = null;
    finishConfirmation(false);
    invalidate(); session = null; saving = false; previewStage = null; renderedStudio = null; renderedActorImage = null; renderedRatio = null; frameDoc = null; frame.removeAttribute('srcdoc');
    presetDraft = null; presetApply = null; compiledSource = ''; cssError = '';
    if (dialog.open) dialog.close();
    if (hostOrigin) { hostOrigin.replaceWith(host); hostOrigin = null; shadow.querySelector('.entry').hidden = false; }
    (returnFocus || $('open-design-preview')).focus(); returnFocus = null;
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
    invalidate(); const token = epoch;
    presetDraft = preset; presetApply = onApply; returnFocus = document.activeElement;
    while (returnFocus?.shadowRoot?.activeElement) returnFocus = returnFocus.shadowRoot.activeElement;
    dialog.dataset.mode = preset ? 'preset' : 'editor';
    $('cancel-design').textContent = preset ? 'キャンセル' : '閉じる';
    $('design-title').textContent = preset ? `プリセットを確認：「${preset.design.name}」` : 'デザインエディタ';
    $('preview-ratio-help').textContent = preset ? '比率を切り替えて配置・追加の文字と画像・立ち絵画像の配置を確認してください。この画面では編集しません。「適用」までは今のデザインを変えません。' : '比率ごとに、配置・追加の文字と画像・立ち絵画像の配置を別々に保存します。確認サイズは見え方の確認だけに使い、配置と出力の大きさを変更しません。';
    if (epoch !== token) return;
    const start = preset?.design || designStore.design;
    // A preset is applied over the current design, so both modes guard its revision.
    session = createDraftSession(start, designStore.revision);
    ratio = nearestRatio(...size(start.outputSize)); setPreviewSize(ratio, start.outputSize); selected = 'screen'; compiledCSS = ''; compiledSource = null; cssError = '';
    compileDraftCSS(); tab('targets');
    // A hidden operating page would hide even a top-layer dialog opened from talk mode.
    hostOrigin = document.createComment('design editor'); host.before(hostOrigin); document.body.append(host); shadow.querySelector('.entry').hidden = true;
    dialog.showModal(); status('プレビューを準備しています…'); refresh(); scale();
    if (!preset) refreshLocal();
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
        frame.srcdoc = '<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data: \'self\' https://static-cdn.jtvnw.net; font-src \'none\'; connect-src \'none\'; form-action \'none\'; base-uri \'none\'"></head><body class="talk-mode pokome-preview"></body></html>';
      });
      if (!isCurrent(token)) return;
      frameDoc = frame.contentDocument;
      const css = frameDoc.createElement('style'); css.textContent = previewCSS;
      const theme = frameDoc.createElement('style'); theme.id = 'preview-theme';
      const guides = frameDoc.createElement('style'); guides.textContent = `html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}#safe-guides{position:fixed;inset:0;pointer-events:none;z-index:900;font:12px system-ui}#safe-guides[hidden]{display:none}.guide-shade{position:absolute;left:0;right:0;background:repeating-linear-gradient(135deg,#ff4f6d55 0 10px,#ff4f6d22 10px 20px);color:#fff;text-shadow:0 1px 2px #000;display:flex;align-items:center;justify-content:center}`;
      frameDoc.head.append(css, theme, guides);
      previewStage = frameDoc.importNode(live, true); previewStage.hidden = false;
      // The copy starts with the preview ratio's own layout.
      applyTalkLayout(previewStage, talkLayout(design(), ratio));
      for (const element of previewStage.querySelectorAll('dialog,[popover],.pokome-overlay,script,iframe,object,embed,link')) element.remove();
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
  function setPreviewSize(target, resolution) {
    $('preview-ratio').value = target;
    // Set with the ratio so the toggle is right before the preview finishes loading.
    $('preview-guides-option').hidden = target !== '9:16';
    $('preview-width').replaceChildren(...PREVIEW_SIZES.filter(value => nearestRatio(...size(value)) === target).map(value => { const option = document.createElement('option'); option.value = value; option.textContent = value.replace('x', ' × '); return option; }));
    if (resolution) $('preview-width').value = resolution;
  }
  $('preview-ratio').onchange = () => { dragCleanup?.(); session?.seal(); ratio = previewRatio(); setPreviewSize(ratio); scale(); refresh(); requestAnimationFrame(() => { scale(); draw(); }); };
  $('preview-width').onchange = () => {
    dragCleanup?.(); session?.seal(); scale();
    // Each ratio keeps its own additions, layout and actor placement in the draft.
    ratio = previewRatio(); refresh();
    // The iframe lays out at its new size on the next frame.
    requestAnimationFrame(() => { scale(); draw(); });
  };
  const snapLabel = document.createElement('label'); snapLabel.className = 'check edit-only';
  const snapInput = document.createElement('input'); snapInput.type = 'checkbox'; snapInput.id = 'canvas-snap'; snapInput.checked = true;
  snapLabel.append(snapInput, document.createTextNode('2%に位置をそろえる')); shadow.querySelector('.view').append(snapLabel);
  $('preview-guides').onchange = drawGuides;
  $('preview-comment-sample').onchange = draw;
  $('target-select').onchange = () => { session?.seal(); select($('target-select').value); if (matchMedia('(max-width: 767px)').matches) tab('settings'); };
  $('add-text').onclick = () => {
    if (!editable() || ratioOverlays().items.length >= MAX_OVERLAYS) return;
    const state = ratioOverlays(), item = createOverlay('text', {}, state.items);
    selected = overlayKey(item.id);
    edit(withTalk(design(), ratio, { overlays: normalizeOverlays({ ...state, items: [...state.items, item] }, assetOptions()) }), { label: '文字の追加', ratio });
  };
  $('delete-overlay').onclick = () => {
    if (!editable() || !currentItem()) return;
    const next = removeOverlay(ratioOverlays(), overlayId(selected), assetOptions());
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
  for (const key of ['x', 'y', 'w', 'h', 'z', 'hidden']) $(`panel-${key}`).addEventListener('change', () => {
    if (!editable() || !isPanel(selected)) return;
    const element = $(`panel-${key}`), current = targetValue(selected);
    if (key !== 'hidden' && element.value === '') { panelFields(); return; }
    const patch = key === 'w' || key === 'h'
      ? resizePatch(current, key === 'w' ? numberOr(element, current.w) - current.w : 0, key === 'h' ? numberOr(element, current.h) - current.h : 0)
      : { [key]: key === 'hidden' ? element.checked : numberOr(element, current[key]) };
    session.seal(); changedTarget(selected, patch);
  });
  dialog.addEventListener('keydown', event => { if (event.key === 'Escape' && dragCleanup) { event.preventDefault(); event.stopPropagation(); dragCleanup(); } });
  for (const [id, direction] of [['canvas-forward', 'forward'], ['canvas-backward', 'backward']]) $(id).onclick = () => {
    if (!editable() || selected === 'screen') return;
    const layout = canvasLayout(); if (!layout) return;
    session.seal();
    const next = moveCanvasTarget(layout, ratioOverlays(), { kind: isPanel(selected) ? 'panel' : 'overlay', id: isPanel(selected) ? selected : overlayId(selected) }, direction);
    edit(withTalk(design(), ratio, next), { label: direction === 'forward' ? '前へ' : '後ろへ', ratio });
  };
  $('copy-ratio').onclick = async () => {
    if (!editable()) return;
    const source = $('copy-ratio-source').value, destination = ratio;
    const scope = talkLayout(design(), source) ? 'パネル配置・追加の文字と画像・立ち絵画像の配置を置き換えます。' : 'コピー元は標準の並びです。コピー先のパネル配置は残し、追加の文字と画像・立ち絵画像の配置だけを置き換えます。';
    if (!await confirmAction('別の比率からコピーしますか？', source + 'から' + destination + 'へ' + scope, 'コピーする', 'キャンセル') || !editable()) return;
    session.seal(); edit(copyTalkRatio(design(), source, destination), { label: '別の比率からコピー', ratio: destination });
  };
  $('reset-ratio').onclick = async () => {
    if (!editable()) return;
    const destination = ratio;
    if (!await confirmAction('この比率の配置を標準に戻しますか？', destination + 'の6パネルと立ち絵画像の配置を標準に戻します。追加の文字・画像と全比率共通の見た目、ほかの比率は残します。', 'この比率の配置を標準に戻す', 'キャンセル') || !editable()) return;
    session.seal(); edit(resetTalkRatio(design(), destination), { label: 'この比率の配置を標準に戻す', ratio: destination });
  };
  async function addImage(read) {
    if (!editable() || ratioOverlays().items.length >= MAX_OVERLAYS) return;
    // The image belongs to the ratio shown when it was chosen, even if the view switches meanwhile.
    const token = epoch, request = Symbol(), target = ratio;
    if (requests.has('add-image')) pending--;
    requests.set('add-image', request); pending++; buttons(); status('画像を確認しています…');
    try {
      const file = await read();
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
      if (target === ratio) selected = overlayKey(item.id);
      edit(withTalk(design(), target, { overlays: next }), { label: '画像の追加', ratio: target });
      status(target === ratio ? '画像を追加しました。適用するまでは見た目に反映されません。' : `画像を${target}の配置に追加しました。適用するまでは見た目に反映されません。`);
    } catch (error) { if (isCurrent(token) && requests.get('add-image') === request) status(error.message); }
    finally { if (isCurrent(token) && requests.get('add-image') === request) { requests.delete('add-image'); pending--; buttons(); } }
  }
  $('overlay-image').onchange = () => { const file = $('overlay-image').files[0]; $('overlay-image').value = ''; if (file) return addImage(() => file); };
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
    mode.addEventListener('change', () => { if (session) { session.seal(); editStudio({ [key]: mode.value === 'custom' ? color.value : mode.value === 'service' ? 'service' : '' }, { label: '見た目' }); } });
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
  async function draftImage(read, key, patch) {
    if (!editable()) return;
    const token = epoch, request = Symbol();
    if (requests.has(key)) pending--;
    requests.set(key, request); pending++; buttons(); status('画像を確認しています…');
    const current = () => isCurrent(token) && requests.get(key) === request;
    try {
      const file = await read();
      await checkImageFile(file);
      if (!current()) return;
      const { ref } = await designStore.uploadImage(file);
      if (!current()) return;
      session.seal(); editStudio(patch(ref), { label: '画像' });
      status('画像を下書きに入れました。適用するまでは見た目に反映されません。');
    } catch (error) { if (current()) status(error.message); }
    finally { if (current()) { requests.delete(key); pending--; buttons(); } }
  }
  // Explicit edits or removals invalidate a file still being read or uploaded.
  function dropRequest(key) { if (requests.delete(key)) { pending--; buttons(); } }
  for (const [id, key, patch] of [['draft-image', 'actor-image', ref => ({ source: 'image', image: ref })], ['draft-speechImage', 'speech-image', ref => ({ speechStyle: 'image', speechImage: ref })]]) {
    $(id).onchange = () => { const file = $(id).files[0]; $(id).value = ''; if (file) return draftImage(() => file, key, patch); };
  }
  $('draft-image-remove').onclick = () => { if (session) { dropRequest('actor-image'); session.seal(); editStudio({ image: '' }, { label: '画像の削除' }); } };
  $('draft-speechImage-reset').onclick = () => { if (session) { dropRequest('speech-image'); session.seal(); editStudio({ speechImage: '', speechStyle: 'image' }, { label: '標準の背景画像' }); } };
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
    dropRequest('css-file');
    edit({ ...design(), theme: $('draft-css').value }, { label: 'テーマCSS', merge: 'css' });
    status(cssError ? `入力したCSSは未反映です：${cssError}` : 'CSSをプレビューしました。適用するまでは保存されません。');
  });
  $('draft-css').addEventListener('change', () => session?.seal());
  async function draftCSS(read) {
    if (!editable()) return;
    const token = epoch, request = Symbol();
    if (requests.has('css-file')) pending--;
    requests.set('css-file', request); pending++; buttons(); status('CSSを読み込んでいます…');
    const current = () => isCurrent(token) && requests.get('css-file') === request;
    try {
      const file = await read();
      if (file.size > MAX_THEME_CSS_BYTES) throw new Error('CSSは1MB以内にしてください。');
      const css = await file.text();
      if (!current()) return;
      session.seal(); edit({ ...design(), theme: css }, { label: 'CSSファイル' });
      status(cssError ? `入力したCSSは未反映です：${cssError}` : 'CSSファイルを下書きに読み込みました。適用するまでは保存されません。');
    } catch (error) { if (current()) status(`読み込めませんでした：${error.message}`); }
    finally { if (current()) dropRequest('css-file'); }
  }
  $('draft-css-file').onchange = () => { const file = $('draft-css-file').files[0]; $('draft-css-file').value = ''; if (file) return draftCSS(() => file); };
  async function localRequest(path = '') {
    const response = await fetch('./api/customizations' + path, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      let message = 'ファイルを取得できません。一覧を更新し、保存場所とファイルを確認してください。';
      try { const body = await response.json(); if (typeof body.error === 'string') message = body.error; } catch { /* Interrupted servers may return text. */ }
      throw new Error(message);
    }
    return response;
  }
  let listingGeneration = 0;
  async function refreshLocal() {
    const token = epoch, generation = ++listingGeneration;
    const current = () => isCurrent(token) && generation === listingGeneration;
    const nodes = selector => shadow.querySelectorAll(selector);
    for (const node of nodes('.local-status')) node.textContent = '一覧を取得しています…';
    try {
      const listing = await (await localRequest()).json();
      if (!current()) return;
      for (const node of nodes('.local-directory')) node.textContent = typeof listing.directory === 'string' ? listing.directory : 'customization';
      for (const [id, kind] of Object.entries(LOCAL_PICKERS)) {
        const select = $('local-' + id + '-select'), previous = select.value;
        const files = Array.isArray(listing[kind]) ? listing[kind].filter(file => typeof file?.name === 'string' && Number.isFinite(file.size) && file.size >= 0) : [];
        select.replaceChildren();
        for (const file of [{ name: '', label: files.length ? 'ファイルを選択してください' : 'ファイルがありません' }, ...files]) {
          const option = document.createElement('option'); option.value = file.name; option.textContent = file.label || `${file.name}（${Math.ceil(file.size / 1024)}KB）`; select.append(option);
        }
        if (files.some(file => file.name === previous)) select.value = previous;
        select.disabled = !files.length;
        $('local-' + id).querySelector('.local-status').textContent = `${files.length}件。${listing.skipped ? '対象外・読み込めないファイルは除外しました。' : ''}`;
      }
    } catch (error) {
      if (!current()) return;
      for (const node of nodes('.local-directory')) node.textContent = '取得できませんでした';
      for (const node of nodes('.local-status')) node.textContent = error.message + '「一覧を更新」で再試行してください。';
      for (const id of Object.keys(LOCAL_PICKERS)) { $('local-' + id + '-select').replaceChildren(); $('local-' + id + '-select').disabled = true; }
    }
    if (current()) buttons();
  }
  for (const [id, kind] of Object.entries(LOCAL_PICKERS)) {
    const select = $('local-' + id + '-select'), key = { css: 'css-file', actor: 'actor-image', speech: 'speech-image', overlay: 'add-image' }[id];
    $('local-' + id).querySelector('.local-refresh').onclick = refreshLocal;
    select.onchange = buttons;
    $('local-' + id + '-load').onclick = () => {
      const name = select.value; if (!name || !editable()) return;
      const read = async () => (await localRequest('/' + kind + '/' + encodeURIComponent(name))).blob();
      if (id === 'css') return draftCSS(read);
      if (id === 'overlay') return addImage(read);
      return draftImage(read, key, ref => id === 'actor' ? { source: 'image', image: ref } : { speechStyle: 'image', speechImage: ref });
    };
  }
  $('draft-css-clear').onclick = () => { if (session) { dropRequest('css-file'); session.seal(); edit({ ...design(), theme: '' }, { label: 'CSSの解除' }); status('CSSを解除しました。適用するまでは保存されません。'); } };
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
    ratio = target; setPreviewSize(target); scale();
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
  function showLive() {
    overlays = storedOverlays(); renderOverlays(live, resolveOverlayAssets(overlays));
    const applied = designStore.design;
    const theme = [...$('draft-theme').options].find(option => option.value === applied.studio.theme).textContent;
    $('applied-design-summary').textContent = `適用中：${theme} · 出力 ${applied.outputSize.replace('x', ' × ')}`;
  }
  showLive();
  return {
    openEditor() { return openPreview(); },
    openPreset(preset, onApply) { return openPreview(structuredClone(preset), onApply); },
    // The talk screen switched ratio: show that ratio's additions.
    showLive,
    getOverlays: () => clone(overlays),
    // Another page saved the design: show it, and refuse to apply an older draft.
    // A failed save only restores the saved design; an open draft stays usable.
    reload(detail = { external: true }) {
      showLive();
      if (session && (detail.external || detail.applied) && !saving) { session.markStale(); status(STALE_DRAFT); buttons(); }
    },
  };
}
