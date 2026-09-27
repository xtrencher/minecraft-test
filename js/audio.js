// Small procedural Web Audio sound effects — no external audio files.
//
// Everything routes through a master gain and a dynamics compressor, so loud
// layered sounds (like the Blast Orb explosion) can peak hard without
// clipping or drowning out everything else.

const NOISE_SECONDS = 2.5;

// Mob voices: lists of tones (or noise bursts) played together.
const MOB_VOICES = {
  fluffalo: {
    idle: [{ freq: 105, slideTo: 82, duration: 0.8, volume: 0.2, type: "sawtooth" }, { freq: 210, slideTo: 160, duration: 0.6, volume: 0.05, type: "sine" }],
    hurt: [{ freq: 180, slideTo: 115, duration: 0.3, volume: 0.24, type: "sawtooth" }],
    death: [{ freq: 150, slideTo: 50, duration: 0.9, volume: 0.24, type: "sawtooth" }],
  },
  hoplet: {
    idle: [{ freq: 1500, slideTo: 1900, duration: 0.07, volume: 0.07, type: "sine" }, { freq: 1600, slideTo: 2100, duration: 0.06, volume: 0.06, type: "sine", delay: 0.11 }],
    hurt: [{ freq: 2300, slideTo: 1300, duration: 0.14, volume: 0.12, type: "sine" }],
    death: [{ freq: 1900, slideTo: 420, duration: 0.35, volume: 0.13, type: "sine" }],
  },
  mossback: {
    idle: [{ noise: { duration: 0.05, volume: 0.12, filterFreq: 700, filterType: "bandpass", q: 3 } }, { freq: 90, slideTo: 70, duration: 0.25, volume: 0.1, type: "triangle", delay: 0.08 }],
    hurt: [{ freq: 320, slideTo: 200, duration: 0.12, volume: 0.2, type: "triangle" }, { noise: { duration: 0.08, volume: 0.2, filterFreq: 800, filterType: "bandpass", q: 2 } }],
    death: [{ freq: 220, slideTo: 55, duration: 0.7, volume: 0.2, type: "triangle" }],
  },
  zombie: {
    idle: [{ freq: 118, slideTo: 82, duration: 1.1, volume: 0.2, type: "sawtooth" }, { freq: 123, slideTo: 86, duration: 1.0, volume: 0.12, type: "sawtooth", delay: 0.05 }],
    hurt: [{ freq: 190, slideTo: 115, duration: 0.3, volume: 0.24, type: "sawtooth" }],
    death: [{ freq: 150, slideTo: 38, duration: 1.3, volume: 0.26, type: "sawtooth" }, { freq: 75, slideTo: 30, duration: 1.0, volume: 0.2, type: "sine" }],
    attack: [{ freq: 210, slideTo: 140, duration: 0.22, volume: 0.22, type: "sawtooth" }],
  },
};

// Filtered-noise recipes for block materials (see Audio._material).
const MATERIAL_SOUNDS = {
  stone: { filter: "bandpass", freq: 1500, q: 0.9, duration: 0.1, volume: 1 },
  wood: { filter: "lowpass", freq: 800, q: 2, duration: 0.1, volume: 1, knock: 170 },
  grass: { filter: "highpass", freq: 1800, q: 0.7, duration: 0.13, volume: 0.8 },
  plant: { filter: "highpass", freq: 2600, q: 0.7, duration: 0.09, volume: 0.6 },
  dirt: { filter: "lowpass", freq: 520, q: 1, duration: 0.12, volume: 1.1 },
  sand: { filter: "highpass", freq: 3000, q: 0.5, duration: 0.16, volume: 0.7 },
  glass: { filter: "highpass", freq: 4000, q: 1, duration: 0.07, volume: 0.7, tinkle: true },
  cloth: { filter: "lowpass", freq: 380, q: 0.7, duration: 0.12, volume: 0.9 },
};

export class Audio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this._noiseBuffer = null;
    this._shaperCurve = null;
  }

  ensureStarted() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      const compressor = this.ctx.createDynamicsCompressor();
      compressor.threshold.value = -14;
      compressor.knee.value = 8;
      compressor.ratio.value = 5;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
      compressor.connect(this.ctx.destination);
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(compressor);
      this._noiseBuffer = this._makeNoiseBuffer();
      this._shaperCurve = this._makeShaperCurve(2.5);
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
  }

  _makeNoiseBuffer() {
    const length = Math.floor(this.ctx.sampleRate * NOISE_SECONDS);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  // Soft-clipping curve (tanh) used to add grit to the explosion body.
  _makeShaperCurve(drive) {
    const n = 1024;
    const curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(drive * x) / Math.tanh(drive);
    }
    return curve;
  }

  // A noise source starting at a random offset in the shared buffer (so
  // repeated sounds don't sound identical), playing for `duration` seconds.
  _noise(when, duration) {
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    const maxOffset = Math.max(0, NOISE_SECONDS - duration - 0.05);
    src.start(when, Math.random() * maxOffset, duration + 0.05);
    return src;
  }

  _playNoiseBurst({ duration = 0.12, volume = 0.3, filterFreq = 1200, filterType = "lowpass", q = 1 } = {}) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const src = this._noise(now, duration);
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    filter.Q.value = q;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
  }

  _playTone({ freq = 220, duration = 0.1, volume = 0.2, type = "sine", slideTo = null, delay = 0 } = {}) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    if (slideTo !== null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), now + duration);
    }
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  // Break/place/dig/step sounds per block material: filtered noise shaped
  // differently for stone, wood, soil, sand, plants, glass and cloth.
  _material(sound, { volume = 0.25, duration = 1, pitch = 1 } = {}) {
    const m = MATERIAL_SOUNDS[sound] || MATERIAL_SOUNDS.stone;
    const jitter = 0.85 + Math.random() * 0.3;
    this._playNoiseBurst({
      duration: m.duration * duration,
      volume: volume * m.volume,
      filterFreq: m.freq * pitch * jitter,
      filterType: m.filter,
      q: m.q,
    });
    if (m.knock) this._playTone({ freq: m.knock * pitch * jitter, slideTo: m.knock * 0.6, duration: 0.07 * duration, volume: volume * 0.5, type: "triangle" });
    if (m.tinkle) {
      for (let i = 0; i < 3; i++) {
        this._playTone({ freq: (2200 + Math.random() * 1800) * pitch, duration: 0.08 + Math.random() * 0.12, volume: volume * 0.18, type: "sine", delay: i * 0.035 });
      }
    }
  }

  playBreak(sound = "stone") {
    this._material(sound, { volume: 0.32, duration: 1.4 });
  }

  playPlace(sound = "stone") {
    this._material(sound, { volume: 0.24, duration: 0.8, pitch: 1.25 });
  }

  playDig(sound = "stone") {
    this._material(sound, { volume: 0.14, duration: 0.6, pitch: 1.1 });
  }

  playFootstep(sound = "grass") {
    this._material(sound, { volume: 0.1, duration: 0.6, pitch: 0.8 });
  }

  playPickup() {
    this._playTone({ freq: 620 + Math.random() * 180, slideTo: 1250, duration: 0.09, volume: 0.1, type: "sine" });
  }

  playClick() {
    this._playTone({ freq: 1500, slideTo: 900, duration: 0.03, volume: 0.06, type: "square" });
  }

  playCraft() {
    this._playNoiseBurst({ duration: 0.07, volume: 0.12, filterFreq: 1500, filterType: "bandpass" });
    this._playTone({ freq: 520, slideTo: 880, duration: 0.12, volume: 0.09, type: "triangle", delay: 0.04 });
  }

  playEat() {
    this._playNoiseBurst({ duration: 0.08, volume: 0.16, filterFreq: 900 + Math.random() * 700, filterType: "bandpass", q: 2 });
  }

  playBurp() {
    this._playTone({ freq: 140, slideTo: 90, duration: 0.25, volume: 0.16, type: "sawtooth" });
  }

  playToolBreak() {
    this._playTone({ freq: 1800, slideTo: 600, duration: 0.18, volume: 0.14, type: "square" });
    this._playNoiseBurst({ duration: 0.2, volume: 0.2, filterFreq: 3000, filterType: "highpass" });
  }

  // A short grunt: a low, falling buzz.
  playHurt() {
    this._playTone({ freq: 230, slideTo: 120, duration: 0.18, volume: 0.22, type: "sawtooth" });
    this._playNoiseBurst({ duration: 0.08, volume: 0.12, filterFreq: 600 });
  }

  // Death: a long falling tone over a low thud.
  playDeath() {
    this._playTone({ freq: 440, slideTo: 55, duration: 1.2, volume: 0.22, type: "sawtooth" });
    this._playTone({ freq: 90, slideTo: 40, duration: 0.5, volume: 0.35, type: "sine" });
  }

  playSplash() {
    this._playNoiseBurst({ duration: 0.45, volume: 0.28, filterFreq: 1100, filterType: "lowpass" });
    this._playNoiseBurst({ duration: 0.25, volume: 0.12, filterFreq: 3500, filterType: "bandpass" });
  }

  playJump() {
    this._playTone({ freq: 300, slideTo: 420, duration: 0.1, volume: 0.12, type: "triangle" });
  }

  playFlightToggle(enabled) {
    if (enabled) this._playTone({ freq: 260, slideTo: 620, duration: 0.25, volume: 0.16, type: "sine" });
    else this._playTone({ freq: 500, slideTo: 180, duration: 0.2, volume: 0.14, type: "sine" });
  }

  playThrow() {
    this._playTone({ freq: 420, slideTo: 900, duration: 0.14, volume: 0.15, type: "sine" });
    // A short airy whoosh under the tone.
    this._playNoiseBurst({ duration: 0.22, volume: 0.12, filterFreq: 1400, filterType: "bandpass" });
  }

  // Mob voices: `event` is "idle", "hurt", "death" or "attack"; quieter
  // with distance (blocks), silent beyond 40.
  playMob(kind, event, distance = 0) {
    if (!this.ctx || distance > 40) return;
    const v = 1 / (1 + distance / 7);
    const voice = MOB_VOICES[kind]?.[event];
    if (!voice) return;
    for (const part of voice) {
      if (part.noise) this._playNoiseBurst({ ...part.noise, volume: part.noise.volume * v });
      else this._playTone({ ...part, freq: part.freq * (0.92 + Math.random() * 0.16), volume: part.volume * v });
    }
  }

  // The player's weapon landing (a heavier crack on a critical hit).
  playHit(crit = false) {
    this._playNoiseBurst({ duration: 0.09, volume: 0.3, filterFreq: 900, filterType: "lowpass" });
    this._playTone({ freq: 150, slideTo: 80, duration: 0.08, volume: 0.25, type: "triangle" });
    if (crit) this._playNoiseBurst({ duration: 0.12, volume: 0.2, filterFreq: 3500, filterType: "highpass" });
  }

  // A swing that hits nothing.
  playSwing() {
    this._playNoiseBurst({ duration: 0.12, volume: 0.07, filterFreq: 1300, filterType: "bandpass", q: 1.5 });
  }

  // Layered explosion: a sub-bass thump, a distorted low-passed noise body
  // with a falling cutoff, a sharp crack on top, a long rumble tail, and a
  // patter of falling debris. `distance` (blocks) attenuates the volume and
  // delays the sound slightly, like sound travelling through air.
  playExplosion(distance = 0) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = ctx.currentTime + Math.min(distance / 343, 0.3);
    const out = ctx.createGain();
    out.gain.value = 1.3 / (1 + distance / 22);
    out.connect(this.master);

    const env = (gainNode, attackEnd, peak, decayEnd) => {
      gainNode.gain.setValueAtTime(0.0001, t0);
      gainNode.gain.exponentialRampToValueAtTime(peak, attackEnd);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, decayEnd);
    };

    // Sub-bass thump.
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(95, t0);
    sub.frequency.exponentialRampToValueAtTime(28, t0 + 0.9);
    const subGain = ctx.createGain();
    env(subGain, t0 + 0.012, 1.1, t0 + 1.4);
    sub.connect(subGain).connect(out);
    sub.start(t0);
    sub.stop(t0 + 1.5);

    // Distorted body with a falling low-pass cutoff.
    const body = this._noise(t0, 2.0);
    const bodyFilter = ctx.createBiquadFilter();
    bodyFilter.type = "lowpass";
    bodyFilter.Q.value = 0.8;
    bodyFilter.frequency.setValueAtTime(3200, t0);
    bodyFilter.frequency.exponentialRampToValueAtTime(160, t0 + 1.4);
    const shaper = ctx.createWaveShaper();
    shaper.curve = this._shaperCurve;
    const bodyGain = ctx.createGain();
    env(bodyGain, t0 + 0.008, 1.5, t0 + 1.9);
    body.connect(bodyFilter).connect(shaper).connect(bodyGain).connect(out);

    // Sharp crack transient.
    const crack = this._noise(t0, 0.12);
    const crackFilter = ctx.createBiquadFilter();
    crackFilter.type = "highpass";
    crackFilter.frequency.value = 1800;
    const crackGain = ctx.createGain();
    env(crackGain, t0 + 0.003, 0.9, t0 + 0.1);
    crack.connect(crackFilter).connect(crackGain).connect(out);

    // Long low rumble tail.
    const rumble = this._noise(t0, 2.4);
    const rumbleFilter = ctx.createBiquadFilter();
    rumbleFilter.type = "lowpass";
    rumbleFilter.frequency.value = 140;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.setValueAtTime(0.0001, t0);
    rumbleGain.gain.exponentialRampToValueAtTime(0.9, t0 + 0.15);
    rumbleGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 2.4);
    rumble.connect(rumbleFilter).connect(rumbleGain).connect(out);

    // Debris patter: a handful of tiny ticks as chunks rain back down.
    for (let i = 0; i < 9; i++) {
      const when = t0 + 0.35 + Math.random() * 1.3;
      const tick = this._noise(when, 0.05);
      const tickFilter = ctx.createBiquadFilter();
      tickFilter.type = "bandpass";
      tickFilter.frequency.value = 700 + Math.random() * 2200;
      const tickGain = ctx.createGain();
      tickGain.gain.setValueAtTime(0.05 + Math.random() * 0.12, when);
      tickGain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
      tick.connect(tickFilter).connect(tickGain).connect(out);
    }
  }
}
