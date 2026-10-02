import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createServer } from '../server.js';
import { readSpeechEngines, LocalSpeechPlayer } from '../speech-engine.js';
const wav = Buffer.from('RIFF0000WAVEdata');
async function serve(t, fetchImpl) {
  const server = createServer({ fetchImpl }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}
const post = input => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });

test('oversized streaming request returns 413 and closes its connection', async t => {
  const base = await serve(t, () => { throw new Error('unexpected upstream request'); });
  await new Promise((resolve, reject) => {
    const request = http.request(base + '/api/speech/voicevox/synthesis', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    request.on('error', reject);
    request.on('response', response => {
      assert.equal(response.statusCode, 413);
      assert.equal(response.headers.connection, 'close');
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        try {
          assert.match(response.headers['content-type'], /^application\/json/);
          assert.deepEqual(JSON.parse(body), { error: '読み上げ本文が長すぎます。' });
        } catch (error) { reject(error); return; }
        if (request.socket.destroyed) resolve();
        else request.socket.once('close', resolve);
      });
    });
    request.write('x'.repeat(13000));
    // Keep the body unfinished: the server must reject without waiting for EOF.
    request.setTimeout(2000, () => request.destroy(new Error('Response timed out')));
  });
});
test('VOICEVOX voices and two-step synthesis preserve text and apply speed', async t => {
  const calls = [];
  const base = await serve(t, async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/speakers')) return Response.json([{ name: 'テスト', styles: [{ id: 3, name: 'ノーマル' }] }]);
    if (url.includes('/audio_query?')) return Response.json({ accent_phrases: [], speedScale: 1 });
    return new Response(wav);
  });
  assert.deepEqual(await (await fetch(base + '/api/speech/voicevox/voices')).json(), { voices: [{ id: '3', name: 'テスト / ノーマル' }] });
  const response = await fetch(base + '/api/speech/voicevox/synthesis', post({ text: 'こんにちは & !', voice: '3', rate: 1.5 }));
  assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'audio/wav');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), wav);
  assert.equal(new URL(calls[1].url).searchParams.get('text'), 'こんにちは & !');
  assert.equal(JSON.parse(calls[2].options.body).speedScale, 1.5);
  assert.ok(calls.every(call => call.url.startsWith('http://127.0.0.1:50021/')));
});
test('COEIROINK v2 uses UUID and style together and returns generated WAV', async t => {
  let body;
  const uuid = '3c37646f-3881-5374-2a83-149267990abc';
  const base = await serve(t, async (url, options) => {
    assert.ok(url.startsWith('http://127.0.0.1:50032/'));
    if (url.endsWith('/speakers')) return Response.json([{ speakerName: '話者', speakerUuid: uuid, styles: [{ styleId: 0, styleName: 'れいせい' }] }]);
    body = JSON.parse(options.body); return new Response(wav);
  });
  const voices = await (await fetch(base + '/api/speech/coeiroink/voices')).json();
  assert.equal(voices.voices[0].id, uuid + ':0');
  const response = await fetch(base + '/api/speech/coeiroink/synthesis', post({ text: '音声', voice: uuid + ':0', rate: .8 }));
  assert.equal(response.status, 200); assert.equal(body.speakerUuid, uuid); assert.equal(body.styleId, 0); assert.equal(body.speedScale, .8); assert.deepEqual(body.prosodyDetail, []);
});
test('speech proxy rejects untrusted origins, destinations and invalid inputs without upstream requests', async t => {
  let calls = 0; const base = await serve(t, () => { calls++; throw new Error('unexpected'); });
  assert.equal((await fetch(base + '/api/speech/voicevox/voices', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/speech/other/voices')).status, 404);
  assert.equal((await fetch(base + '/api/speech/voicevox/synthesis')).status, 405);
  for (const input of [{ text: 'x', voice: 'http://evil', rate: 1 }, { text: 'x', voice: '1', rate: 0 }, { text: '', voice: '1', rate: 1 }]) assert.equal((await fetch(base + '/api/speech/voicevox/synthesis', post(input))).status, 400);
  const oversized = await fetch(base + '/api/speech/voicevox/synthesis', post({ text: 'x'.repeat(13000) }));
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: '読み上げ本文が長すぎます。' });
  assert.equal(calls, 0);
});
test('engine failures do not expose upstream errors or treat non-audio as WAV', async t => {
  const base = await serve(t, async url => url.includes('audio_query') ? Response.json({}) : new Response('secret internal error'));
  const response = await fetch(base + '/api/speech/voicevox/synthesis', post({ text: 'x', voice: '1', rate: 1 }));
  assert.equal(response.status, 502); assert.doesNotMatch(await response.text(), /secret/);
});
test('saved engines stay platform-specific and Pages always selects browser', () => {
  const storage = { getItem: () => JSON.stringify({ twitch: { engine: 'voicevox', voicevox: '4' }, kick: { engine: 'coeiroink', coeiroink: 'bad' } }) };
  assert.equal(readSpeechEngines(storage).twitch.voicevox, '4'); assert.equal(readSpeechEngines(storage).kick.coeiroink, '');
  assert.equal(readSpeechEngines(storage, false).twitch.engine, 'browser');
  assert.equal(readSpeechEngines({ getItem: () => '{' }).twitch.engine, 'browser');
});
test('local playback starts display only when playing, runs serially and revokes URLs', async () => {
  const audio = []; const revoked = []; const events = [];
  const player = new LocalSpeechPlayer({ fetchImpl: async () => new Response(wav), urls: { createObjectURL: () => 'blob:test', revokeObjectURL: url => revoked.push(url) }, createAudio: () => {
    const item = { play() { this.onplaying(); return Promise.resolve(); }, pause() {}, removeAttribute() {} }; audio.push(item); return item;
  } });
  const utterance = n => ({ text: 'x', rate: 1, volume: .4, onstart: () => events.push('start' + n), onend: () => events.push('end' + n) });
  player.speak(utterance(1), 'voicevox', '3'); player.speak(utterance(2), 'voicevox', '3');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(events, ['start1']); assert.equal(audio[0].volume, .4);
  audio[0].onended(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(events, ['start1', 'end1', 'start2']);
  player.cancel(); await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(events, ['start1', 'end1', 'start2']); assert.equal(revoked.length, 2);
});
test('cancel during synthesis suppresses stale playback and queued jobs', async () => {
  let finish; let plays = 0;
  const player = new LocalSpeechPlayer({ fetchImpl: () => new Promise(resolve => { finish = resolve; }), createAudio: () => { plays++; } });
  player.speak({ text: 'x', rate: 1 }, 'voicevox', '1'); player.speak({ text: 'y', rate: 1 }, 'voicevox', '1');
  player.cancel(); finish(new Response(wav)); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(plays, 0);
});
