# AGENTS.md — 作業の引き継ぎと進め方

このリポジトリで作業するエージェント（Codex など）向けの案内です。最初に読み、続けて [docs/design/roadmap.md](docs/design/roadmap.md) を読んでください。

## 利用者とのやり取り

- 利用者への返答は日本語で書く。
- コミット・push・PR 作成・マージ・ブランチ削除は、そのたびに利用者の了承を得てから行う。前の了承を次の操作に流用しない。
- 新しい機能は、次の順で進めてきた。この流れを守る。
  1. 方針（目的・追加する設定・実装の考え方・範囲外・決めてほしいこと）を短くまとめ、利用者の確認を得る。大きい機能は `docs/design/<名前>.md` に仕様書を書く。
  2. master から `feat/<名前>` ブランチを切って実装し、テストを追加する。
  3. 自己レビューする（diff の読み直し、テーマとの組み合わせ、実ブラウザでの見た目）。
  4. 利用者の了承を得てコミット → push → PR 作成。
  5. 利用者が別にレビューとブラウザ確認を行い、指摘を貼ってくる。指摘ごとに「修正 → 修正前のコードで失敗し修正後に通る回帰テスト → 全テスト → 了承を得てコミット・push」を繰り返す。
  6. 利用者の了承を得て、マージコミット（`gh pr merge --merge`）でマージする。
- 判断に迷う仕様は、推測で決めずに選択肢を示して利用者に聞く。

## コマンド

| 用途 | コマンド |
| --- | --- |
| 開発サーバー（Twitch・Kick） | `npm start` → http://localhost:5173 （配信出力は `/output.html`） |
| 構文チェック | `npm run check` |
| 全テスト | `npm test`（`node --test`。Playwright と Chromium 系ブラウザがあればブラウザテストも実行。Windows では Edge を自動検出） |
| 1ファイルだけ | `node --test tests/<file>.test.js` |
| Windows 配布版 | `npm run build:local`（`dist-local/`） |

- 外部パッケージのインストールは不要（依存なし）。
- CI（`.github/workflows/ci.yml`）は PR で `npm run check`・`npm test`（Ubuntu）と `build:local`（Windows）を実行する。
- P1-B2最終版の [PR CI](https://github.com/devunit47/pkm-comment-reader/actions/runs/37166991572) は成功（2026-10-04）。Ubuntuの構文チェック・全テストと、Windowsの配布版ビルドを確認済み。

## コードの約束事

- 画面の文言・文書は日本語。コード中のコメントは英語で、「なぜ」を短く書く。
- 受け取ったコメントや設定は必ず正規化してから使う。描画は `textContent` のみで、`innerHTML` に利用者のデータを入れない。
- 見た目（配信デザイン・テーマCSS・雑談画面の配置・追加の文字と画像・出力の大きさ）は `customization/current/design.json` と画像ファイルに保存し、`design-client.js` の `createDesignStore` を通して読み書きする。localStorage に見た目を書かない。localStorage に残すのは接続先・音声・ユーザー管理・ホームの配置・履歴件数（`pokome-history-limit`）・配信出力の背景だけ。
- 雑談画面の配置と追加の文字・画像は比率（16:9・9:16・4:3）ごとに持つ。読み書きは `design-model.js` の `talkLayout`・`talkOverlays`・`withTalk` を使う（未作成の比率はその比率の標準。ほかの比率を流用しない）。雑談モードは「出力の大きさ」の比率、配信出力は自分の大きさに最も近い比率（`nearestRatio`）、配置の編集中は「編集する比率」を表示する。
- design.json の画像は `images/<SHA-256>.<拡張子>` の参照。正規化は `design-model.js` の `normalizeDesign`（画像目録で検査）を使い、`normalizeStudio`・`normalizeOverlays` を design.json に使うときは `studioOptions`・`overlayOptions` を渡す（渡さないと画像参照が消える）。保存済みの設計オブジェクトは直接書き換えず、複製してから編集する。
- 提供するのはローカル版だけ（Windows 配布版と開発版）。GitHub Pages は静的な移転案内（`pages/index.html`）だけを公開し、アプリは置かない。
- Windows 配布版は Twitch 専用。Kick は開発版だけで有効（Twitch 版の完成後に配布版へ追加する予定）。カメラ・マイクは扱わない。
- 新しいブラウザ用ファイルは `asset-manifest.js` の `BROWSER_ASSETS` に追加する。
- テーマCSS（`theme.js` の `compileTheme`）は `.pokome-workspace` 以下の通常ルール・`@media`・`@supports` だけを受け付ける。`@layer` は拒否する（次の項目の前提）。
- 「配信デザイン」の明示設定は、テーマCSSより優先する。`style.css` の先頭で宣言した `@layer pokome-settings` に、`!important` 付きで規則を書く。配信画面へ書き込む CSS 変数も `setProperty(name, value, 'important')` で書く。「テーマのまま」の項目は、属性も変数も書かない。
- 配信画面の見た目は `stage-appearance.js` の `renderStageAppearance` に集約し、雑談画面・デザインプレビュー（`design-preview.js` の iframe）・配信出力（`output.js`）の3か所で共用する。
- 改行コードは CRLF で揃う（コミット時の「LF will be replaced by CRLF」という警告は無視してよい）。
- コミットメッセージは英語の命令形1行（例: `Add comment list look settings and structural presets`）。

## 主なファイル

| ファイル | 役割 |
| --- | --- |
| `app.js` | 操作画面。接続・読み上げ・ユーザー管理・配信デザイン設定・雑談モード |
| `studio.js` | 配信デザイン設定の既定値・正規化・コメント欄プリセット・履歴件数 |
| `design-model.js` | design.json の形式・正規化・画像参照の検査と URL 変換（サーバーとブラウザで共用） |
| `design-storage.js` | `customization/current/` の読み書き API（`/api/design/*`）・画像の保存と検査・変更通知（SSE） |
| `design-client.js` | ブラウザ側の読み書き（保存の直列化・競合時の再読み込み・変更通知の購読） |
| `stage-appearance.js` | 配信画面の描画（見た目・追加画像・コメントカード・配置・コメント欄の見た目） |
| `output.html` / `output.js` | 配信出力。描画のみで、接続も音声もしない |
| `output-protocol.js` | 操作画面 → 配信出力の BroadcastChannel 同期（正規化・差分・再同期・操作画面の切替） |
| `output-panel.js` | 操作画面の「配信出力（OBS用）」欄 |
| `design-preview.js` | 文字・画像の追加とデザインプレビュー（iframe） |
| `workspace.js` / `workspace-model.js` | 枠の配置（％座標・重なり順・非表示） |
| `theme.js` | テーマCSSの検証と適用 |
| `chat-state.js` / `connections.js` | コメント履歴と Twitch・Kick 接続 |

仕様書は `docs/design/`、利用者向けの説明は `README.md` と `docs/customization.md`。
