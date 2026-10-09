import { LOCAL_FILES } from '../src/server/asset-manifest.js';
import { ensureCustomizationDirectories, safeDirectory } from '../src/server/local-customization.js';
import { mkdir, readdir, copyFile, writeFile, readFile, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// The asset-only phase is also testable on non-Windows hosts. Never copy user files
// from the source customization or data directory into the distributable.
export async function stageLocalFiles(destination = new URL('../dist-local/', import.meta.url)) {
  const files = LOCAL_FILES;
  const extra = ['node.exe', 'node-LICENSE.txt', 'Start.cmd', 'Start.ps1', 'Readme.txt'];
  const directories = ['src', 'src/browser', 'src/server', 'src/shared'];
  const allowed = [...files, ...extra, ...directories, 'src/browser/kick.js', 'customization', 'data'];
  await mkdir(destination, { recursive: true });
  for (const directory of ['', ...directories]) {
    const prefix = directory ? directory + '/' : '';
    let entries;
    try { entries = await readdir(new URL(prefix || './', destination), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (entries.some(entry => {
      const path = prefix + entry.name;
      return !allowed.includes(path) || entry.isSymbolicLink() ||
        entry.isDirectory() !== [...directories, 'customization', 'data'].includes(path);
    })) throw new Error('空の出力先を使用してください。');
  }
  // Preserve this destination's user folder during rebuilds, but never follow links.
  await ensureCustomizationDirectories(new URL('customization/', destination));
  await safeDirectory(new URL('data/', destination), true);
  for (const directory of directories) await safeDirectory(new URL(directory + '/', destination), true);
  for (const file of files) await copyFile(new URL('../' + file, import.meta.url), new URL(file, destination));
  await unlink(new URL('src/browser/kick.js', destination)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await writeFile(new URL('src/shared/app-config.js', destination), "export const enabledPlatforms = Object.freeze(['twitch']);\n");
  const html = await readFile(new URL('index.html', destination), 'utf8');
  await writeFile(new URL('index.html', destination), html.replaceAll('data-service="kick"', 'data-service="kick" hidden'));
}

export async function buildLocal(destination = new URL('../dist-local/', import.meta.url)) {
  if (process.platform !== 'win32') throw new Error('Windows上でWindows配布版を作成してください。');
  await stageLocalFiles(destination);
  const runtime = await readFile(process.execPath);
  const runtimePath = new URL('node.exe', destination);
  let unchanged = false;
  try { unchanged = runtime.equals(await readFile(runtimePath)); } catch { /* First build. */ }
  if (!unchanged) await writeFile(runtimePath, runtime);
  await writeFile(new URL('node-LICENSE.txt', destination), await readFile(new URL('../NODE-LICENSE.txt', import.meta.url)));
  await writeFile(new URL('Start.cmd', destination), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start.ps1"\r\n');
  await writeFile(new URL('Start.ps1', destination), `﻿$ErrorActionPreference = 'Stop'
if (!$env:PORT) { $env:PORT = '5174' }
$readerPort = 0
if (![int]::TryParse($env:PORT, [ref]$readerPort) -or $readerPort -lt 1 -or $readerPort -gt 65535) { Write-Host 'PORTは1〜65535で指定してください。'; Read-Host 'Enterで閉じる'; exit 1 }
$readerProbeUrl = 'http://127.0.0.1:' + $readerPort + '/'
$readerBrowserUrl = 'http://localhost:' + $readerPort + '/'
Write-Host 'ぽこめ Reader の起動を確認しています…'
try {
  $readerResponse = Invoke-WebRequest $readerProbeUrl -UseBasicParsing -TimeoutSec 2
  if ($readerResponse.Content -notmatch 'ぽこめ') { throw '指定ポートは別のアプリが使用しています。' }
  Write-Host '起動済みのぽこめ Reader を開きます。'
} catch {
  if ($_.Exception.Message -like '*別のアプリ*') { Write-Host $_.Exception.Message; Read-Host 'Enterで閉じる'; exit 1 }
  Write-Host 'ローカルサーバーを起動しています…'
  $env:PORT = [string]$readerPort
  Start-Process -FilePath (Join-Path $PSScriptRoot 'node.exe') -ArgumentList 'server.js' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
  $readerReady = $false
  for ($readerAttempt = 0; $readerAttempt -lt 20; $readerAttempt++) {
    Start-Sleep -Milliseconds 250
    try { $readerResponse = Invoke-WebRequest $readerProbeUrl -UseBasicParsing -TimeoutSec 1; $readerReady = $readerResponse.Content -match 'ぽこめ'; if ($readerReady) { break } } catch {}
  }
  if (!$readerReady) { Write-Host '起動できませんでした。指定ポートを確認してください。'; Read-Host 'Enterで閉じる'; exit 1 }
}
Start-Process $readerBrowserUrl
Write-Host ('ブラウザで ' + $readerBrowserUrl + ' を開きました。')
Write-Host 'このウィンドウを閉じてもアプリは動作します。'
Read-Host 'Enterでこのウィンドウを閉じる' | Out-Null
`, 'utf8');
  await writeFile(new URL('Readme.txt', destination), 'Start.cmdをダブルクリックして起動します（http://localhost:5174/）。Node.jsのインストールは不要です。\r\n音声ソフトは別途インストールして起動してください。\r\nTwitchのサブスク・再サブスク・サブスクギフト・まとめてギフト・ビッツを特別なカードで表示します。匿名ギフトは匿名として扱い、受信したプラン・月数・受取人・ビッツ数だけを示します。ビッツは投稿のタグで判定し、本文のCheer100などから推測しません。金額換算・レイド・Kickのイベントは対象外です。\r\n読み上げは投稿者の本文だけで、イベントの見出し・説明文は自動・手動とも読みません。本文がない場合は「読み上げる本文がありません」と表示し、読み上げボタンを無効にします。イベント全体を手動で固定できますが、受信だけで固定は変わりません。匿名ギフトではカードの非表示と固定だけができ、ユーザーの非表示・読み上げ除外はできません。\r\nデザインエディタの「コメント欄」の「特別なカードを表示する」は初期値オンです。オフでは雑談画面・プレビュー・配信出力で本文のあるイベントを通常のコメントとして表示し、本文のないイベントは表示しません。ホームの一覧・読み上げ・固定内容・履歴は保持します。固定枠も同じ表示設定に従い、本文のない固定枠は隠れますが、オンに戻すと再表示します。オフでもホームから固定を解除できます。設定はcustomization/current/design.jsonに保存し、プリセットにも含みます。イベントの履歴と固定内容は保存・バックアップしません。プレビューで種類別の架空の見本を選べ、表示件数1件でも確認できます。見本の選択は保存しません。\r\n履歴の保持件数1〜300件（初期値300件）は通常のコメントとイベントの合計です。イベントが多いと通常のコメントの保持件数が減ります。受信コメント数・初コメント判定・初コメントの絞り込みには通常の投稿とビッツを含め、サブスク・ギフトなどのUSERNOTICEは含めません。表示中の件数は両方の合計です。配信出力の表示件数・時間・新着位置はイベントにも適用し、固定したイベントは件数・時間の制限から外します。\r\n匿名IRC接続で届く通知だけが対象です。購入や更新のすべてを検知するものではなく、未共有・未送信、接続前・切断中のイベントは補完しません。まとめてギフトと個別ギフトの関連を確かめられないため、それぞれ表示します。人数を確認できる項目もないため、まとめカードの人数は表示しません。欠けた月数などは推測で補いません。\r\nコメント一覧の名前・本文から「このコメントを固定」で専用枠に1件を固定し、別のコメントの固定で差し替えます。固定中のメニュー、ホームの「固定中のコメント」欄、雑談モードの「固定を解除」で解除できます。音声は鳴らしません。固定はサービス別のメモリーだけで、保存・バックアップされず、操作画面の再読み込み・再起動で消えます。固定したコメントやユーザーの非表示（別画面の設定反映も含む）、履歴クリア、接続時の履歴初期化でも解除します。検索・読み上げ除外・表示件数や時間・履歴削減・一時切断・サービスや画面の切り替え・デザインやプリセットの適用では固定を保ちます。非表示を戻しても固定は戻りません。デザインエディタの「固定コメント」で比率ごとの位置・大きさ・重なり順・非表示を編集できます。見た目はコメント欄と共用し、プレビューは架空の見本です。枠を非表示にしても固定は残ります。配信出力の再読み込みでは固定を取り直します。操作画面を閉じても配信出力に最後の表示が残ることがあるため、配信を終える前に固定を解除してください。\r\nデザインエディタの「コメント欄」でTwitchの名前の色（テーマのまま・サービスの色・色を指定）、エモート（画像で表示・文字のまま）、役割バッジを設定できます。初期値はテーマの名前の色・画像エモート・バッジ非表示です。バッジは配信者・モデレーター・VIP・サブスクの記号4種だけです。操作画面のコメント一覧とKickは文字のままです。エモートは読み上げず、エモートだけの投稿は名前を読む設定でも読み上げません。画像エモートは操作画面とOBSのブラウザソースからstatic-cdn.jtvnw.netへ通信します。「文字のまま」では画像を取得しません。\r\n更新後は OBS のブラウザソースを更新（右クリック→「更新」）してください。更新前の出力では、本文のあるイベントは通常のコメントとして表示され、本文のないイベントは表示されません。\r\nブラウザを閉じてもローカルサーバーは動作します。PCの終了時に停止します。\r\n\r\nカスタマイズ素材は、このアプリと同じ場所のcustomization/stylesにCSS（UTF-8・1,000,000バイト以下）、customization/imagesにPNG・JPEG・WebP・GIF（20 MiB・1600万画素以下）を入れてください。直下の通常ファイルのみ対応します。\r\n配信デザインページまたは雑談画面の「デザインを編集」を開き、CSSは「画面全体」の「詳細：テーマCSS」、画像は「立ち絵」「読み上げ」または「画像を追加」の「customizationフォルダーから選ぶ」で一覧を更新して選びます。素材は下書きに読み込み、エディタの「適用」で見た目をまとめて保存します。読み込み中は適用できません。ファイル編集後も同じ手順で読み込み直してください。画像は選んだ時点でcustomization/current/imagesにコピーされ、下書きには参照を入れます。適用済みの見た目は元ファイルを削除しても保持されます。新しい版へ更新するときは、customizationとdataフォルダーごとコピーしてください。\r\n標準デザインのstyle.css・src/shared/theme.js・src/shared/studio.js・speech-background.svgはcustomizationの外にあります。変更せず、独自の素材だけをcustomizationに置いてください。\r\nソース側のcustomization内の素材とdataの設定は配布用フォルダーへコピーしません。再ビルド時は出力先に既にあるcustomizationとdataの内容を保持します。出力先を他の人へ渡す前に、個人の素材やdataの設定が残っていないか確認してください。\r\n雑談画面は、適用済みの「出力の大きさ」で描き、完成画面全体を窓の中央に収めます。小さな窓では縮小し、出力の大きさより大きな窓では窓いっぱいまで拡大します。文字・画像・余白も一緒に拡大・縮小し、窓のリサイズでは見た目を保存し直しません。同じ確認サイズ・表示内容・フォント条件のデザインプレビューと見え方を比べられます。\r\n終了・自動読み上げ・デザイン編集・接続・音量は、完成画面に重ねた右上の操作領域にあります。ボタンやダイアログは画面と一緒に拡大・縮小しません。マウスを重ねるか、ボタンにフォーカスすると表示し、タッチ環境では常時表示します。狭い幅では折り返しと操作領域内のスクロールですべてのボタンへ移動できます。Escapeキー・ブラウザの「戻る」でも終了できます。配信出力（OBS用）は従来どおり実際の窓の大きさで描きます。\r\n出力の大きさはエディタの「画面全体」で変更します。配信出力欄は適用中の大きさを表示し、「エディタで変更」から開けます。ホームは標準の配置を使います。dataフォルダーと設定バックアップには接続先・ユーザー名が含まれるため、人に渡さないでください。更新前のブラウザ設定は自動では移しません。更新前に旧版の「設定のバックアップ」を保存して、新版で復元してください。見た目と画像はバックアップに入らず、customization/currentにあります。接続先・音声・ユーザー管理・履歴件数・初回案内・配信出力の背景はdata/settings.jsonへ保存し、ブラウザ・ポート・OBSのドックで共有します。新しいバックアップはversion 2です。旧バックアップ（version 1）からも接続先・音声・ユーザー管理・履歴件数を復元し、含まれていない初回案内と配信出力の背景は標準に戻します。古い見た目・画像・配置は取り込みません。\r\n', 'utf8');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildLocal(); console.log('Windows local package: dist-local/');
}
