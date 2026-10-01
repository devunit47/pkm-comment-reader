export function readSpeechEngines(storage, local = true) {
  const result = { twitch: { engine: 'browser', voicevox: '', coeiroink: '' }, kick: { engine: 'browser', voicevox: '', coeiroink: '' } };
  try {
    const saved = JSON.parse(storage?.getItem('pokome-speech-engines') || '{}');
    for (const platform of Object.keys(result)) {
      if (local && ['browser', 'voicevox', 'coeiroink'].includes(saved?.[platform]?.engine)) result[platform].engine = saved[platform].engine;
      for (const engine of ['voicevox', 'coeiroink']) {
        const voice = saved?.[platform]?.[engine];
        if (typeof voice === 'string' && (engine === 'voicevox' ? /^\d{1,9}$/ : /^[a-f\d-]{36}:\d{1,9}$/i).test(voice)) result[platform][engine] = voice;
      }
    }
  } catch { /* Ignore unavailable storage and malformed preferences. */ }
  return result;
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
          if (generation === this.generation) { utterance.onerror?.(); this.onError(error.message); }
        } finally {
          if (audioUrl) this.urls.revokeObjectURL(audioUrl);
          if (this.audio) { this.audio.onplaying = this.audio.onended = this.audio.onerror = null; this.audio.pause(); this.audio.removeAttribute('src'); }
          this.audio = null; this.finish = null; this.controller = null;
        }
      }
    } finally { this.running = false; if (this.queue.length) this.pump(); }
  }
}
