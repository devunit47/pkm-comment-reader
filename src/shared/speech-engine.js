const ENGINE_NAMES = Object.freeze({ voicevox: 'VOICEVOX', coeiroink: 'COEIROINK' });

export function validLocalVoiceId(engine, id) {
  if (typeof id !== 'string') return false;
  if (engine === 'voicevox') return /^\d{1,9}$/.test(id);
  return engine === 'coeiroink' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}:\d{1,9}$/i.test(id);
}

function voiceMetadataText(value) {
  return typeof value === 'string' && value.trim() && value.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value.trim() : '';
}

// Keep character and style separate. Display labels may contain slashes and are
// never parsed as identity or trusted as HTML. Metadata is refreshed per session.
export function normalizeLocalVoices(engine, voices) {
  if (!Array.isArray(voices)) return [];
  const seen = new Set();
  return voices.flatMap(voice => {
    if (!validLocalVoiceId(engine, voice?.id) || seen.has(voice.id)) return [];
    seen.add(voice.id);
    const speakerName = voiceMetadataText(voice.speakerName);
    const styleName = voiceMetadataText(voice.styleName);
    const name = (speakerName || '音声名未取得') + (styleName ? ' / ' + styleName : '') + (!speakerName ? ` (ID: ${voice.id})` : '');
    return [{ id: voice.id, name, speakerName, styleName }];
  });
}

export function speechCredit(engine, voiceId, voices) {
  if (!Object.hasOwn(ENGINE_NAMES, engine)) return '';
  const voice = normalizeLocalVoices(engine, voices).find(item => item.id === voiceId);
  return ENGINE_NAMES[engine] + ':' + (voice?.speakerName || '音声名未取得');
}

// Played text retains its captured credit until it is cleared. Empty browser
// credits must also win over a later local-engine selection.
export function speechDisplayCredits(preference, voices, currentSpeech = null, previewCredit = null) {
  const selected = speechCredit(preference.engine, preference[preference.engine], voices);
  return { preview: previewCredit ?? selected, stage: currentSpeech?.credit ?? selected };
}

export function normalizeSpeechEngines(saved) {
  const result = { twitch: { engine: 'browser', voicevox: '', coeiroink: '' }, kick: { engine: 'browser', voicevox: '', coeiroink: '' } };
    for (const platform of Object.keys(result)) {
      if (['browser', 'voicevox', 'coeiroink'].includes(saved?.[platform]?.engine)) result[platform].engine = saved[platform].engine;
      for (const engine of ['voicevox', 'coeiroink']) {
        const voice = saved?.[platform]?.[engine];
        if (validLocalVoiceId(engine, voice)) result[platform][engine] = voice;
      }
    }
  return result;
}

export function readSpeechEngines(storage) {
  try { return normalizeSpeechEngines(JSON.parse(storage?.getItem('pokome-speech-engines') || '{}')); }
  catch { return normalizeSpeechEngines(); }
}

export class LocalSpeechPlayer {
  constructor({ fetchImpl = (...args) => fetch(...args), createAudio = () => new Audio(), urls = URL, onError = () => {} } = {}) {
    Object.assign(this, { fetchImpl, createAudio, urls, onError });
    this.queue = []; this.generation = 0; this.running = false;
  }
  speak(utterance, engine, voice) { this.queue.push({ utterance, engine, voice }); this.pump(); }
  cancel() {
    this.generation++; this.queue.length = 0;
    this.controller?.abort(); this.finish?.();
    this.audio?.pause();
  }
  async pump() {
    if (this.running) return;
    this.running = true;
    const generation = this.generation;
    try {
      while (this.queue.length && generation === this.generation) {
        const { utterance, engine, voice } = this.queue.shift();
        this.controller = new AbortController();
        let audioUrl;
        try {
          const response = await this.fetchImpl('./api/speech/' + engine + '/synthesis', { method: 'POST', signal: this.controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: utterance.text, voice, rate: utterance.rate }) });
          if (!response.ok) { const data = await response.json(); throw new Error(data.error || '音声を生成できません。'); }
          const blob = await response.blob();
          if (generation !== this.generation) break;
          audioUrl = this.urls.createObjectURL(blob);
          const audio = this.audio = this.createAudio();
          audio.src = audioUrl; audio.volume = utterance.volume;
          await new Promise((resolve, reject) => {
            this.finish = resolve;
            audio.onplaying = () => { if (generation === this.generation) utterance.onstart?.(); };
            audio.onended = resolve;
            audio.onerror = () => reject(new Error('音声を再生できません。'));
            Promise.resolve(audio.play()).catch(() => reject(new Error('音声を再生できません。画面を操作してから再度お試しください。')));
          });
          if (generation === this.generation) utterance.onend?.();
        } catch (error) {
          if (generation === this.generation) { utterance.onerror?.({ error: 'local-speech' }); this.onError(error.message); }
        } finally {
          if (audioUrl) this.urls.revokeObjectURL(audioUrl);
          if (this.audio) { this.audio.onplaying = this.audio.onended = this.audio.onerror = null; this.audio.pause(); this.audio.removeAttribute('src'); }
          this.audio = null; this.finish = null; this.controller = null;
        }
      }
    } finally { this.running = false; if (this.queue.length) this.pump(); }
  }
}
