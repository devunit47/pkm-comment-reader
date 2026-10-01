# ぽこめ Reader

Twitchのコメント表示・音声読み上げ・ローカルのユーザー管理アプリ。

## 起動

Node.js 20以上で `npm start` を実行して http://localhost:5173 を開きます。外部パッケージのインストールは不要です。

## 使い方

- 初期表示はサンプルコメントです。「デモコメント追加」で追加できます。
- 「接続設定」にTwitchチャンネル名を入力すると公開チャットを匿名で受信します。自動再接続は行いません。
- コメントを選択して個別に読み上げたり、自動読み上げを有効にできます。日本語音声はOS・ブラウザに依存します。読み上げ待ちは最大20件です。
- 非表示と読み上げ除外はこのブラウザに保存され、「ユーザー管理」で解除できます。Twitch上のBAN・タイムアウトとは別です。
- コメントは直近300件をメモリに保持し、ページを閉じると消えます。初コメントはこのセッションでの初登場です。

Twitch接続は外部通信が必要です。認証、コメント送信、Twitch上でのモデレーション、Kick連携は未実装です。Webフォントが使えない場合はシステムフォントで表示します。

接続方式の参考: [TwitchのWebSocket接続に関する告知](https://discuss.dev.twitch.com/t/decommission-of-non-secure-websocket-connections-to-twitch-irc-servers/64142)、[匿名接続に関する開発者フォーラム](https://discuss.dev.twitch.com/t/can-i-use-wss-irc-ws-chat-twitch-tv-with-justifan/63732)。匿名接続はサービス側の変更で使えなくなる可能性があります。

## 確認

`npm run check` でJavaScript構文を検証できます。
