import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStudio, applyCommentPreset } from '../studio.js';
import { selectOutputComments } from '../stage-appearance.js';
import { createOutputView, applyOutputMessage, normalizeOutputMessage } from '../output-protocol.js';
const messages = Array.from({length:100}, (_,i) => ({id:String(i),user:'u',text:'text',receivedAt:1000+i*100}));
test('output defaults, boundaries and invalid settings recover safely', () => {
  assert.deepEqual([normalizeStudio().maxVisible,normalizeStudio().holdSeconds,normalizeStudio().newestPosition],[0,0,'bottom']);
  for (const maxVisible of [0,1,30]) assert.equal(normalizeStudio({maxVisible}).maxVisible,maxVisible);
  for (const maxVisible of [31,-1,1.5,'8',null]) assert.equal(normalizeStudio({maxVisible}).maxVisible,0);
  for (const holdSeconds of [0,5,15,30]) assert.equal(normalizeStudio({holdSeconds}).holdSeconds,holdSeconds);
  for (const holdSeconds of [1,-1,Infinity,'15',null]) assert.equal(normalizeStudio({holdSeconds}).holdSeconds,0);
  assert.equal(normalizeStudio({newestPosition:'side'}).newestPosition,'bottom');
});
test('latest eligible cards are selected without mutating history, including empty and hidden input', () => {
  const before=structuredClone(messages);
  assert.deepEqual(selectOutputComments([],{}),[]);
  assert.equal(selectOutputComments(messages,{}).length,100);
  assert.deepEqual(selectOutputComments(messages,{maxVisible:1}).map(m=>m.id),['99']);
  assert.deepEqual(selectOutputComments(messages,{maxVisible:2,newestPosition:'top'}).map(m=>m.id),['99','98']);
  const hidden=messages.map(m=>({...m,hidden:Number(m.id)>=95}));
  assert.deepEqual(selectOutputComments(hidden,{maxVisible:2}).map(m=>m.id),['93','94']);
  assert.deepEqual(messages,before);
});
test('receipt time expires at the boundary; zero hold and preview do not expire', () => {
  const one=[{id:'x',receivedAt:1000}];
  assert.equal(selectOutputComments(one,{holdSeconds:15},15999).length,1);
  assert.equal(selectOutputComments(one,{holdSeconds:15},16000).length,0);
  assert.equal(selectOutputComments(one,{holdSeconds:0},1000000).length,1);
  assert.equal(selectOutputComments([{receivedAt:0},{receivedAt:NaN},{receivedAt:undefined}],{holdSeconds:5},2000).length,0);
  assert.equal(selectOutputComments(one,{holdSeconds:5},1000000,false).length,1);
  assert.equal(selectOutputComments(one,{holdSeconds:5},10000).length,0);
  assert.equal(selectOutputComments(one,{holdSeconds:15},10000).length,1);
  assert.equal(selectOutputComments(messages.slice(-3),{maxVisible:30}).length,3);
});
test('resync and controller snapshots preserve receipt time, speech and credit despite expiry', () => {
  const view=createOutputView();
  const snapshot=(controllerId,receivedAt)=>normalizeOutputMessage({v:1,type:'snapshot',controllerId,seq:1,platform:'twitch',received:1,messages:[{id:'x',user:'u',text:'t',receivedAt}],speech:{user:'speaker',text:'keep',speaking:true},credit:'credit'});
  applyOutputMessage(view,snapshot('a',1000),1000);
  const saved=structuredClone(view);
  assert.equal(selectOutputComments(view.messages,{holdSeconds:5},6000).length,0);
  assert.deepEqual(view,saved);
  applyOutputMessage(view,snapshot('a',1000),7000);
  assert.equal(selectOutputComments(view.messages,{holdSeconds:5},7000).length,0);
  applyOutputMessage(view,snapshot('b',1000),40000);
  assert.equal(view.controllerId,'b');
  assert.equal(selectOutputComments(view.messages,{holdSeconds:5},40000).length,0);
  assert.equal(view.speech.text,'keep'); assert.equal(view.credit,'credit');
});
test('look presets preserve independent output limits and validated image references', () => {
  const settings=normalizeStudio({maxVisible:3,holdSeconds:15,newestPosition:'top'});
  for (const preset of ['theme','outline','light','dark','dense']) {
    const applied=applyCommentPreset(settings,preset);
    assert.deepEqual([applied.maxVisible,applied.holdSeconds,applied.newestPosition],[3,15,'top']);
  }
  const keep={image:()=>true}, withImage=normalizeStudio({image:'images/'+'a'.repeat(64)+'.png'},keep);
  assert.equal(applyCommentPreset(withImage,'dark',keep).image,withImage.image);
  assert.deepEqual([normalizeStudio({listCount:12}).maxVisible,normalizeStudio({listCount:12}).holdSeconds],[0,0]);
});


test('unlimited selects all retained eligible messages and keeps expiration and order active', () => {
  assert.equal(selectOutputComments(messages,{maxVisible:0,holdSeconds:0}).length,100);
  assert.equal(selectOutputComments(messages,{maxVisible:8,holdSeconds:0}).length,8);
  const expired=messages.map(message=>({...message,receivedAt:1000}));
  assert.equal(selectOutputComments(expired,{maxVisible:0,holdSeconds:5},6000).length,0);
  assert.deepEqual(selectOutputComments(messages.slice(-3),{maxVisible:0,newestPosition:'top'}).map(m=>m.id),['99','98','97']);
  for (const value of [{}, {maxVisible:null}, {maxVisible:-1}]) assert.equal(normalizeStudio(value).maxVisible,0);
});

test('selection reads only the three normalized visibility fields, never embedded images', () => {
  const settings={maxVisible:8,holdSeconds:0,newestPosition:'bottom'};
  Object.defineProperty(settings,'image',{get(){throw new Error('image must not be normalized per comment');}});
  Object.defineProperty(settings,'speechImage',{get(){throw new Error('speechImage must not be normalized per comment');}});
  assert.equal(selectOutputComments(messages,settings).length,8);
});
