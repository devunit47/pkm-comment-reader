import { LOCAL_FILES } from './asset-manifest.js';
import { mkdir, readdir, copyFile, writeFile, readFile, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export async function buildLocal(destination = new URL('./dist-local/', import.meta.url)) {
  if (process.platform !== 'win32') throw new Error('Windows上でWindows配布版を作成してください。');
  const files = LOCAL_FILES;
  const extra = ['node.exe', 'node-LICENSE.txt', 'Start.cmd', 'Start.ps1', 'Readme.txt'];
  await mkdir(destination, { recursive: true });
  if ((await readdir(destination)).some(file => ![...files, ...extra, 'kick.js'].includes(file))) throw new Error('空の出力先を使用してください。');
  for (const file of files) await copyFile(new URL(file, import.meta.url), new URL(file, destination));
  await unlink(new URL('kick.js', destination)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await writeFile(new URL('app-config.js', destination), "export const enabledPlatforms = Object.freeze(['twitch']);\nexport const publication = 'local';\n");
  const html = await readFile(new URL('index.html', destination), 'utf8');
  await writeFile(new URL('index.html', destination), html.replaceAll('data-service="kick"', 'data-service="kick" hidden'));
  const runtime = await readFile(process.execPath);
  const runtimePath = new URL('node.exe', destination);
  let unchanged = false;
  try { unchanged = runtime.equals(await readFile(runtimePath)); } catch { /* First build. */ }
  if (!unchanged) await writeFile(runtimePath, runtime);
  await writeFile(new URL('node-LICENSE.txt', destination), await readFile(new URL('./NODE-LICENSE.txt', import.meta.url)));
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
  await writeFile(new URL('Readme.txt', destination), 'Start.cmdをダブルクリックして起動します（http://localhost:5174/）。Node.jsのインストールは不要です。\r\n音声ソフトは別途インストールして起動してください。\r\nブラウザを閉じてもローカルサーバーは動作します。PCの終了時に停止します。\r\n設定バックアップには接続先・ユーザー名・画像が含まれるため、共有先にご注意ください。\r\n', 'utf8');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildLocal(); console.log('Windows local package: dist-local/');
}
