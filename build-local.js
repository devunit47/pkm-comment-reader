import { mkdir, readdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function buildLocal(destination = new URL('./dist-local/', import.meta.url)) {
  if (process.platform !== 'win32') throw new Error('Windows上でWindows配布版を作成してください。');
  const files = ['index.html', 'style.css', 'app.js', 'settings-backup.js', 'connections.js', 'kick.js', 'chat-state.js', 'speech-options.js', 'speech-engine.js', 'local-speech.js', 'studio.js', 'workspace.js', 'workspace-model.js', 'theme.js', 'app-config.js', 'speech-background.svg', 'server.js', 'package.json', 'LICENSE', 'PRIVACY.md'];
  const extra = ['node.exe', 'node-LICENSE.txt', 'Start.cmd', 'Start.ps1', 'Readme.txt'];
  await mkdir(destination, { recursive: true });
  if ((await readdir(destination)).some(file => ![...files, ...extra].includes(file))) throw new Error('空の出力先を使用してください。');
  for (const file of files) await copyFile(new URL(file, import.meta.url), new URL(file, destination));
  await copyFile(process.execPath, new URL('node.exe', destination));
  await writeFile(new URL('node-LICENSE.txt', destination), await readFile(new URL('./NODE-LICENSE.txt', import.meta.url)));
  await writeFile(new URL('Start.cmd', destination), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start.ps1"\r\n');
  await writeFile(new URL('Start.ps1', destination), `﻿$ErrorActionPreference = 'Stop'
Write-Host 'ぽこめ Reader の起動を確認しています…'
try {
  $readerResponse = Invoke-WebRequest 'http://localhost:5173/' -UseBasicParsing -TimeoutSec 2
  if ($readerResponse.Content -notmatch 'ぽこめ') { throw 'ポート5173は別のアプリが使用しています。' }
  Write-Host '起動済みのぽこめ Reader を開きます。'
} catch {
  if ($_.Exception.Message -like '*別のアプリ*') { Write-Host $_.Exception.Message; Read-Host 'Enterで閉じる'; exit 1 }
  Write-Host 'ローカルサーバーを起動しています…'
  Start-Process -FilePath (Join-Path $PSScriptRoot 'node.exe') -ArgumentList 'server.js' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
  $readerReady = $false
  for ($readerAttempt = 0; $readerAttempt -lt 20; $readerAttempt++) {
    Start-Sleep -Milliseconds 250
    try { $readerResponse = Invoke-WebRequest 'http://localhost:5173/' -UseBasicParsing -TimeoutSec 1; $readerReady = $readerResponse.Content -match 'ぽこめ'; if ($readerReady) { break } } catch {}
  }
  if (!$readerReady) { Write-Host '起動できませんでした。ポート5173を確認してください。'; Read-Host 'Enterで閉じる'; exit 1 }
}
Start-Process 'http://localhost:5173/'
Write-Host 'ブラウザで http://localhost:5173/ を開きました。'
Write-Host 'このウィンドウを閉じてもアプリは動作します。'
Read-Host 'Enterでこのウィンドウを閉じる' | Out-Null
`, 'utf8');
  await writeFile(new URL('Readme.txt', destination), 'Start.cmdをダブルクリックして起動します。Node.jsのインストールは不要です。\r\n音声ソフトは別途インストールして起動してください。\r\nブラウザを閉じてもローカルサーバーは動作します。PCの終了時に停止します。\r\n設定バックアップには接続先・ユーザー名・画像が含まれるため、共有先にご注意ください。\r\n', 'utf8');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildLocal(); console.log('Windows local package: dist-local/');
}
