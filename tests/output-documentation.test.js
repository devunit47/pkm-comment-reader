import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const customization=await readFile(new URL('../docs/customization.md',import.meta.url),'utf8');
const readme=await readFile(new URL('../README.md',import.meta.url),'utf8');
function section(markdown, title) {
  const headings=[...markdown.matchAll(/^(#{1,6}) (.+)$/gm)];
  const heading=headings.find(item=>item[2].trim()===title);
  assert.ok(heading,`Missing section: ${title}`);
  const next=headings.find(item=>item.index>heading.index && item[1].length<=heading[1].length);
  return {index:heading.index,text:markdown.slice(heading.index,next?.index??markdown.length)};
}
test('display limits belong with design guidance and explain unlimited defaults and receipt time', () => {
  const display=section(customization,'配信出力の表示件数と表示時間');
  assert.ok(display.index>section(customization,'デザインエディタと追加の文字・画像').index);
  assert.ok(display.index<section(customization,'ローカルフォルダーの素材を使う').index);
  for (const concept of ['制限なし','1～30','受信時刻','履歴','読み上げ']) assert.ok(display.text.includes(concept),concept);
  assert.match(display.text,/標準[^。]*制限なし|制限なし[^。]*標準/);
});
test('OBS output instructions link directly to display limits and mention retained history', async () => {
  const output=section(readme,'配信出力（OBS用）').text;
  const link=output.match(/\]\((docs\/customization\.md)#([^)]*)\)/);
  assert.ok(link,'OBS output instructions need a customization section link');
  assert.equal(link[2],'配信出力の表示件数と表示時間');
  await readFile(new URL('../'+link[1],import.meta.url),'utf8');
  for (const concept of ['表示件数','表示時間','制限なし','履歴']) assert.ok(output.includes(concept),concept);
});
