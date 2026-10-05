import test from 'node:test';
import assert from 'node:assert/strict';
import { editionInfo } from '../src/browser/customization.js';

test('capabilities distinguish distributed local and development local editions', () => {
  const local = editionInfo(['twitch']);
  assert.equal(local.title, 'Windows ローカル配布版');
  assert.match(local.services, /Twitchのみ/);
  assert.match(local.speech, /別途インストール・起動が必要/);
  assert.match(local.files, /一覧から選べます/);
  const development = editionInfo(['twitch', 'kick']);
  assert.equal(development.title, 'ローカル開発版');
  assert.match(development.services, /Twitch・Kick/);
});
