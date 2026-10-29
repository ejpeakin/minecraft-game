// Procedural sound: filtered noise bursts for blocks and steps, simple synth voices
// for mobs and UI, and a sparse generative piano-like score in the background.

const MATERIAL = {
  stone: { type: 'bandpass', freq: 1700, q: 1.2, dur: 0.12, gain: 0.5 },
  wood: { type: 'bandpass', freq: 650, q: 2.2, dur: 0.14, gain: 0.55, tone: 180 },
  grass: { type: 'highpass', freq: 2400, q: 0.7, dur: 0.16, gain: 0.35 },
  gravel: { type: 'bandpass', freq: 1000, q: 0.6, dur: 0.16, gain: 0.5 },
  sand: { type: 'highpass', freq: 1500, q: 0.5, dur: 0.18, gain: 0.32 },
  snow: { type: 'lowpass', freq: 1200, q: 0.5, dur: 0.18, gain: 0.35 },
  glass: { type: 'highpass', freq: 3000, q: 1, dur: 0.22, gain: 0.45, tone: 1800 },
  cloth: { type: 'lowpass', freq: 900, q: 0.4, dur: 0.14, gain: 0.35 },
};

const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21];

export class Audio {
  constructor() {
    this.ctx = null;
    this.volume = 0.7;
    this.musicVolume = 0.4;
    this.nextSong = 20;
  }

  resume() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = this.musicVolume;
      const delay = this.ctx.createDelay();
      delay.delayTime.value = 0.38;
      const fb = this.ctx.createGain();
      fb.gain.value = 0.35;
      this.musicBus.connect(this.ctx.destination);
      this.musicBus.connect(delay);
      delay.connect(fb);
      fb.connect(delay);
      delay.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.value = v;
  }

  setMusicVolume(v) {
    this.musicVolume = v;
    if (this.musicBus) this.musicBus.gain.value = v;
  }

  // Distance attenuation for positional sounds.
  att(pos, listener) {
    if (!pos || !listener) return 1;
    const d = Math.hypot(pos.x - listener.x, pos.y - listener.y, pos.z - listener.z);
    return Math.max(0, 1 - d / 24);
  }

  burst({ type, freq, q, dur, gain, tone }, scale = 1, pitch = 1) {
    if (!this.ctx || scale <= 0) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = pitch;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq * pitch;
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain * scale, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5, dur + 0.05);
    if (tone) {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = tone * pitch;
      const og = this.ctx.createGain();
      og.gain.setValueAtTime(gain * 0.25 * scale, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + dur * 0.8);
      o.connect(og).connect(this.master);
      o.start(t);
      o.stop(t + dur);
    }
  }

  block(material, kind = 'break', pos, listener) {
    const m = MATERIAL[material] ?? MATERIAL.stone;
    const a = this.att(pos, listener);
    if (kind === 'break') this.burst({ ...m, dur: m.dur * 1.6 }, a, 0.9 + Math.random() * 0.2);
    else if (kind === 'place') this.burst(m, a * 0.9, 0.8 + Math.random() * 0.2);
    else if (kind === 'hit') this.burst({ ...m, dur: m.dur * 0.6 }, a * 0.45, 1 + Math.random() * 0.3);
    else if (kind === 'step') this.burst({ ...m, dur: m.dur * 0.7 }, a * 0.28, 0.9 + Math.random() * 0.3);
  }

  tone(freq, dur, { type = 'square', gain = 0.2, slide = 0, pos, listener, delay = 0 } = {}) {
    if (!this.ctx) return;
    const a = this.att(pos, listener);
    if (a <= 0) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain * a, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  pop() { this.tone(500 + Math.random() * 500, 0.08, { type: 'sine', gain: 0.18, slide: 1.6 }); }
  // Menu click: a short bright tick with a little body under it.
  click() {
    this.burst({ type: 'bandpass', freq: 2400, q: 1.6, dur: 0.035, gain: 0.32 }, 1, 1);
    this.tone(1250, 0.035, { type: 'triangle', gain: 0.07, slide: 0.55 });
  }
  door(open, pos, listener) {
    this.burst({ type: 'bandpass', freq: open ? 560 : 430, q: 2.4, dur: 0.17, gain: 0.55, tone: open ? 170 : 125 }, this.att(pos, listener), 0.9 + Math.random() * 0.15);
  }
  hurt() { this.tone(220, 0.18, { type: 'sawtooth', gain: 0.22, slide: 0.6 }); }
  eat() { this.burst({ type: 'bandpass', freq: 900, q: 1.5, dur: 0.1, gain: 0.3 }, 1, 0.7 + Math.random() * 0.5); }
  burp() { this.tone(140, 0.3, { type: 'sawtooth', gain: 0.18, slide: 0.7 }); }
  splash(pos, listener) { this.burst({ type: 'lowpass', freq: 1400, q: 0.6, dur: 0.5, gain: 0.5 }, this.att(pos, listener)); }
  fuse(pos, listener) { this.burst({ type: 'highpass', freq: 4000, q: 0.5, dur: 1.4, gain: 0.35 }, this.att(pos, listener)); }
  explode(pos, listener) {
    const a = Math.max(0.25, this.att(pos, listener));
    this.burst({ type: 'lowpass', freq: 400, q: 0.8, dur: 1.6, gain: 1.2 }, a, 0.5);
    this.tone(70, 0.9, { type: 'sine', gain: 0.6, slide: 0.4 });
  }
  sleep() { [0, 4, 7, 12].forEach((n, i) => this.tone(262 * 2 ** (n / 12), 0.6, { type: 'sine', gain: 0.12, delay: i * 0.18 })); }

  mob(kind, sound, pos, listener) {
    if (kind === 'pig') this.tone(sound === 'hurt' ? 420 : 300 + Math.random() * 60, 0.22, { type: 'square', gain: 0.12, slide: 0.75, pos, listener });
    else if (kind === 'sheep') this.tone(sound === 'hurt' ? 520 : 440, 0.35, { type: 'sawtooth', gain: 0.08, slide: 0.92, pos, listener });
    else if (kind === 'zombie') this.tone(sound === 'hurt' ? 160 : 95 + Math.random() * 20, sound === 'hurt' ? 0.25 : 0.7, { type: 'sawtooth', gain: 0.16, slide: 0.8, pos, listener });
    else if (kind === 'creeper' && sound === 'hurt') this.burst({ type: 'highpass', freq: 2000, q: 0.5, dur: 0.25, gain: 0.3 }, this.att(pos, listener));
  }

  // Generative background music: short, sparse phrases every couple of minutes.
  updateMusic(dt) {
    if (!this.ctx || this.musicVolume <= 0) return;
    this.nextSong -= dt;
    if (this.nextSong > 0) return;
    this.nextSong = 90 + Math.random() * 120;
    const root = [196, 220, 247, 262][Math.floor(Math.random() * 4)];
    let t = 0;
    const notes = 10 + Math.floor(Math.random() * 10);
    let step = Math.floor(Math.random() * 5);
    for (let i = 0; i < notes; i++) {
      step = Math.max(0, Math.min(SCALE.length - 1, step + Math.floor(Math.random() * 5) - 2));
      const f = root * 2 ** (SCALE[step] / 12);
      this.note(f, t, 2.4);
      if (Math.random() < 0.3) this.note(f / 2, t, 3);
      t += [0.6, 0.9, 1.2, 1.8][Math.floor(Math.random() * 4)];
    }
  }

  note(freq, delay, dur) {
    const t = this.ctx.currentTime + delay;
    for (const [mult, g0] of [[1, 0.09], [2, 0.025], [3, 0.012]]) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * mult;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(g0, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.musicBus);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }
}
