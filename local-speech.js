// JSON envelope limit includes escaped text and voice metadata; text has its own limit.
const MAX_REQUEST_BYTES = 12000;
const MAX_TEXT_LENGTH = 1000;
const engines = { voicevox: { port: 50021, speakers: '/speakers' }, coeiroink: { port: 50032, speakers: '/v1/speakers' } };

export async function handleLocalSpeech(req, res, url, fetchImpl) {
  const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const host = req.headers.host || '';
  if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(host) || (req.headers.origin && req.headers.origin !== 'http://' + host) || req.headers['sec-fetch-site'] === 'cross-site') { json(403, { error: 'このアプリから接続してください。' }); return; }
  const match = url.pathname.match(/^\/api\/speech\/(voicevox|coeiroink)\/(voices|synthesis)$/);
  if (!match) { json(404, { error: '読み上げ方式が不正です。' }); return; }
  const [, engine, action] = match;
  if (req.method !== (action === 'voices' ? 'GET' : 'POST')) { res.writeHead(405); res.end(); return; }
  if (action === 'synthesis' && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { json(415, { error: 'JSONで送信してください。' }); return; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  const cancelled = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', cancelled);
  const base = 'http://127.0.0.1:' + engines[engine].port;
  const request = async (path, body) => {
    const response = await fetchImpl(base + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) throw new Error('engine');
    return response;
  };
  try {
    if (action === 'voices') {
      const speakers = await (await request(engines[engine].speakers)).json();
      if (!Array.isArray(speakers)) throw new Error('voices');
      const voices = speakers.flatMap(speaker => (speaker.styles || []).filter(style => Number.isSafeInteger(engine === 'voicevox' ? style.id : style.styleId)).map(style => ({
        id: engine === 'voicevox' ? String(style.id) : speaker.speakerUuid + ':' + style.styleId,
        name: (engine === 'voicevox' ? speaker.name : speaker.speakerName) + ' / ' + (engine === 'voicevox' ? style.name : style.styleName),
      })));
      json(200, { voices }); return;
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        res.setHeader('Connection', 'close');
        res.once('finish', () => req.destroy());
        json(413, { error: '読み上げ本文が長すぎます。' });
        return;
      }
      chunks.push(chunk);
    }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json(400, { error: '入力が不正です。' }); return; }
    const { text, voice, rate } = input || {};
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT_LENGTH || typeof voice !== 'string' || !Number.isFinite(rate) || rate < .5 || rate > 2 || !(engine === 'voicevox' ? /^\d{1,9}$/ : /^[a-f\d-]{36}:\d{1,9}$/i).test(voice)) { json(400, { error: '本文・声・速さを確認してください。' }); return; }
    let response;
    if (engine === 'voicevox') {
      const queryResponse = await fetchImpl(base + '/audio_query?text=' + encodeURIComponent(text) + '&speaker=' + voice, { method: 'POST', redirect: 'error', signal: controller.signal });
      if (!queryResponse.ok) throw new Error('query');
      const query = await queryResponse.json();
      query.speedScale = rate;
      response = await request('/synthesis?speaker=' + voice, query);
    } else {
      const [speakerUuid, styleId] = voice.split(':');
      response = await request('/v1/synthesis', { text, speakerUuid, styleId: Number(styleId), speedScale: rate, volumeScale: 1, pitchScale: 0, intonationScale: 1, prePhonemeLength: 0, postPhonemeLength: 0, outputSamplingRate: 44100, sampledIntervalValue: 0, adjustedF0: [], processingAlgorithm: 'coeiroink', prosodyDetail: [] });
    }
    const audio = Buffer.from(await response.arrayBuffer());
    if (audio.length > 20000000 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') throw new Error('audio');
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' }); res.end(audio);
  } catch {
    if (!res.destroyed) json(502, { error: (engine === 'voicevox' ? 'VOICEVOX' : 'COEIROINK v2') + 'に接続できないか、音声生成に失敗しました。起動状態・声の設定を確認してください。' });
  } finally { clearTimeout(timer); res.off('close', cancelled); }
}
