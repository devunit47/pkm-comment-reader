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
  await writeFile(new URL('Readme.txt', destination), 'Start.cmdをダブルクリックして起動します（http://localhost:5174/）。Node.jsのインストールは不要です。\r\n音声ソフトは別途インストールして起動してください。\r\nデザインエディタの「コメント欄」でTwitchの名前の色（テーマのまま・サービスの色・色を指定）、エモート（画像で表示・文字のまま）、役割バッジを設定できます。初期値はテーマの名前の色・画像エモート・バッジ非表示です。バッジは配信者・モデレーター・VIP・サブスクの記号4種だけです。操作画面のコメント一覧とKickは文字のままです。エモートは読み上げず、エモートだけの投稿は名前を読む設定でも読み上げません。画像エモートは操作画面とOBSのブラウザソースからstatic-cdn.jtvnw.netへ通信します。「文字のまま」では画像を取得しません。\r\n更新後は OBS のブラウザソースを更新（右クリック→「更新」）してください。配信出力の同期形式を更新しています。\r\nブラウザを閉じてもローカルサーバーは動作します。PCの終了時に停止します。\r\n\r\nカスタマイズ素材は、このアプリと同じ場所のcustomization/stylesにCSS（UTF-8・1,000,000バイト以下）、customization/imagesにPNG・JPEG・WebP・GIF（20 MiB・1600万画素以下）を入れてください。直下の通常ファイルのみ対応します。\r\n配信デザインページまたは雑談画面の「デザインを編集」を開き、CSSは「画面全体」の「詳細：テーマCSS」、画像は「立ち絵」「読み上げ」または「画像を追加」の「customizationフォルダーから選ぶ」で一覧を更新して選びます。素材は下書きに読み込み、エディタの「適用」で見た目をまとめて保存します。読み込み中は適用できません。ファイル編集後も同じ手順で読み込み直してください。画像は選んだ時点でcustomization/current/imagesにコピーされ、下書きには参照を入れます。適用済みの見た目は元ファイルを削除しても保持されます。新しい版へ更新するときは、customizationとdataフォルダーごとコピーしてください。\r\n標準デザインのstyle.css・src/shared/theme.js・src/shared/studio.js・speech-background.svgはcustomizationの外にあります。変更せず、独自の素材だけをcustomizationに置いてください。\r\nソース側のcustomization内の素材とdataの設定は配布用フォルダーへコピーしません。再ビルド時は出力先に既にあるcustomizationとdataの内容を保持します。出力先を他の人へ渡す前に、個人の素材やdataの設定が残っていないか確認してください。\r\n出力の大きさはエディタの「画面全体」で変更します。配信出力欄は適用中の大きさを表示し、「エディタで変更」から開けます。ホームは標準の配置を使います。dataフォルダーと設定バックアップには接続先・ユーザー名が含まれるため、人に渡さないでください。更新前のブラウザ設定は自動では移しません。更新前に旧版の「設定のバックアップ」を保存して、新版で復元してください。見た目と画像はバックアップに入らず、customization/currentにあります。接続先・音声・ユーザー管理・履歴件数・初回案内・配信出力の背景はdata/settings.jsonへ保存し、ブラウザ・ポート・OBSのドックで共有します。新しいバックアップはversion 2です。旧バックアップ（version 1）からも接続先・音声・ユーザー管理・履歴件数を復元し、含まれていない初回案内と配信出力の背景は標準に戻します。古い見た目・画像・配置は取り込みません。\r\n', 'utf8');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildLocal(); console.log('Windows local package: dist-local/');
}
