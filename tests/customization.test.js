import test from 'node:test';
import assert from 'node:assert/strict';
import { editionInfo } from '../customization.js';

test('capabilities distinguish public Pages, distributed local and development local editions', () => {
  const pages = editionInfo('pages', ['twitch']);
  assert.equal(pages.title, 'GitHub Pages 公開版');
  assert.match(pages.services, /Twitchのみ/);
  assert.match(pages.speech, /ブラウザ標準音声のみ/);
  assert.match(pages.files, /一覧は取得できません/);
  assert.match(pages.files, /個別に読み込めます/);
  const local = editionInfo('local', ['twitch']);
  assert.equal(local.title, 'Windows ローカル配布版');
  assert.match(local.speech, /別途インストール・起動が必要/);
  assert.match(local.files, /一覧から選べます/);
  const development = editionInfo('local', ['twitch', 'kick']);
  assert.equal(development.title, 'ローカル開発版');
  assert.match(development.services, /Twitch・Kick/);
});
