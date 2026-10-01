# 自由配置とCSSテーマ（バージョン1）

画面右下の「配置を編集」で、ホームまたは雑談画面のパネルを動かせます。
移動ハンドルをドラッグし、↘をドラッグするとサイズを変更できます。
矢印キーで移動、Shift＋矢印キーでサイズを変更できます。
パネル選択欄から座標・幅・高さ・重なり順・非表示を設定できます。
座標とサイズは画面の割合（%）で保存し、2%への吸着を切り替えられます。
ホームと雑談画面の配置は独立しています。「配置を戻す」は表示中の画面を初期配置に戻します。
非表示にしたパネルも編集時には半透明で表示し、再表示できます。

接続設定やユーザー一覧の専用ページは従来の配置を使います。
ホームのユーザー管理パネルは自由配置できます。テーマCSSは専用ページやサイドバーにも適用できます。

## CSSの公開契約

「配信デザイン」のCSS欄で編集・適用できます。CSSファイルの読み込み・書き出しにも対応します。
Theme API 1のセレクターは次のとおりです。

| セレクター | 対象 |
| --- | --- |
| `.pokome-workspace` | 操作画面、サイドバー、ホームの配置領域、雑談画面 |
| `.pokome-panel[data-panel-type="comments"]` | ホームのコメント一覧 |
| `.pokome-panel[data-panel-type="now"]` | 読み上げプレビュー |
| `.pokome-panel[data-panel-type="reading"]` | 読み上げ設定 |
| `.pokome-panel[data-panel-type="moderation"]` | ユーザー管理 |
| `.pokome-panel[data-panel-type="header"]` | 雑談画面のタイトル・接続状態 |
| `.pokome-panel[data-panel-type="chat"]` | 雑談画面のコメント一覧 |
| `.pokome-panel[data-panel-type="speech"]` | 雑談画面の読み上げ |
| `.pokome-panel[data-panel-type="actor"]` | 立ち絵・ワイプ |
| `.pokome-panel[data-panel-type="footer"]` | 雑談画面のフッター |
| `.pokome-comment` | コメント1件 |
| `.pokome-comment__author` | コメントのユーザー名 |
| `.pokome-comment__body` | コメント本文 |

全セレクターは `.pokome-workspace` またはその子孫を指定してください。
通常ルールと `@media`、`@supports` に対応します。ネストした通常ルールは展開してください。
外部URL、画像URL、`@import`、`@font-face`、キーフレームはこの版では対応しません。
CSSは100KB、読み込みファイルは200KBまでです。ブラウザが解釈できない宣言は適用されません。

```css
/* Pokome Theme API: 1 */
.pokome-workspace {
  --pk-font-family: sans-serif;
  --pk-accent-color: #ffd19a;
}
.pokome-workspace .pokome-panel {
  background: #20232b;
  border: 1px solid #ffd19a;
  border-radius: 8px;
  color: #fff;
}
.pokome-workspace .pokome-comment__body {
  line-height: 1.6;
}
```

`--pk-font-family`、`--pk-text-color`、`--pk-accent-color`を提供します。
詳細な外観は公開セレクターに直接指定できます。位置・サイズはレイアウト編集で管理します。
既存のテーマや配信デザイン設定の上にCSSを適用します。
画面を隠すCSSを指定した場合でも、右下の編集・復元・雑談終了ボタンは操作できます。

## 保存と共有

配置は `pokome-workspace-v1`、CSSは `pokome-theme-v1` というlocalStorageキーに保存します。
ブラウザが保存を拒否した場合は通知し、ファイルへの書き出しで保管できます。
配置JSONだけ、CSSだけ、または「CSSと配置を書き出す」でデザインJSONを共有できます。

```json
{
  "manifest": { "format": "pokome-design", "version": 1, "themeApi": 1 },
  "theme": ".pokome-workspace { --pk-accent-color: gold; }",
  "layout": { "version": 1, "home": null, "talk": null }
}
```

配置の `null` は初期配置です。自由配置では各画面の `panels` に全パネルの
`x`, `y`, `w`, `h`, `z`, `hidden` を保存します。
位置・サイズは画面内に収め、幅・高さは5〜100%、重なり順は0〜99に制限します。
未知のデータは取り込みません。対応しないバージョンや不足したパネルは拒否します。

共有ファイルに接続先、コメント履歴、ユーザー管理データは含めません。
この版の共有対象はCSSと配置です。立ち絵・背景画像、既存の配信タイトルや読み上げ設定、
作者情報、画像・フォントのアセット同梱は共有対象に含まれません。

ブラウザCSSOMの検証テストは同梱PlaywrightとローカルEdgeを利用し、利用できない環境ではスキップします。
