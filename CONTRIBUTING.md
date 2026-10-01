# 貢献の案内

不具合報告・改善提案は[Issues](https://github.com/devunit47/pkm-comment-reader/issues)へお願いします。セキュリティ上の問題は[SECURITY.md](SECURITY.md)に従ってください。

報告には再現手順、期待した動作、実際の動作、OS・ブラウザを記載してください。スクリーンショットやログから個人情報・認証情報・非公開のコメントを取り除いてください。

## 開発とPull Request

1. Node.js 20以上で`npm start`を実行し、ローカルで確認します。外部パッケージのインストールは不要です。
2. 変更に関連するテストを追加・更新し、`npm run check`と`npm test`を実行します。
3. 公開版に影響する場合は`npm run build:pages`と`npm run preview:pages`でTwitch専用版も確認します。生成された`dist/`はコミットしません。
4. Pull Requestに変更の目的、動作の変更、確認内容を記載します。無関係な変更は分けてください。

Twitch・Kickのチャットと設定はサービス別に分離し、統合チャットは作成しません。GitHub Pages版はTwitch専用、ローカル開発版は両サービスに対応します。カメラ・マイク取得機能は追加しません。

貢献するコード・素材について必要な権利があることを確認してください。本プロジェクトへ提供する変更には、特に別の合意がない限り[MITライセンス](LICENSE)を適用します。
