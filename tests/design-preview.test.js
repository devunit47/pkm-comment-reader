import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOverlaySet } from '../design-preview.js';
import { createOverlay } from '../overlay-model.js';

test('overlay-only import roundtrips text without importing appearance or executable fields', () => {
  const item = createOverlay('text', { text: '<script>alert(1)</script>\n日本語', color: '#123456' });
  const input = {version:1,items:[{...item,onclick:'bad'}],assets:{},theme:'bad',studio:{listCount:1}};
  const parsed = parseOverlaySet(JSON.stringify(input));
  assert.deepEqual(parsed,{version:1,items:[item],assets:{}});
});

test('invalid overlay imports reject instead of silently replacing a draft with a partial set', () => {
  const item = createOverlay('text');
  for (const invalid of [null, {}, {version:1}, {version:1,items:[],assets:[]},
    {version:1,items:[item,item],assets:{}},
    {version:1,items:[{id:'image1',type:'image',assetId:'bad'}],assets:{bad:'https://example.com/image.png'}},
    {version:1,items:Array.from({length:21},(_,index)=>({...item,id:`text-${index}`})),assets:{}}]) {
    assert.throws(() => parseOverlaySet(JSON.stringify(invalid)));
  }
  assert.throws(() => parseOverlaySet('x'.repeat(3*1024*1024+1)), /3MB/);
});
