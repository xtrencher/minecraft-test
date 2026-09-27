// Procedural Web Audio sound effects, no audio files.
//
// Almost everything is shaped noise: short filtered bursts with natural
// envelopes (fast attack, exponential decay), resonant band-pass filters for
// "material" (a woody knock, a glassy chink), and several layered hits for
// grains and debris. The only pitched sounds are creature voices, which run a
// buzzy source through vowel-like formant filters with a little vibrato, the
// way a throat shapes sound, rather than bare oscillator sweeps.
//
// Everything routes through a master gain and a dynamics compressor, so loud
// layered sounds (explosions) can peak hard without clipping.

const NOISE_SECONDS = 2.5;

// Block material sounds: layers of filtered noise.
//   f: filter frequency, q: resonance, type: filter type, d: duration (s),
//   v: volume, n: number of staggered grains, spread: seconds between grains.
const MATERIALS = {
  stone: [
    { type: "bandpass", f: 1700, q: 1.1, d: 0.08, v: 1 },
    { type: "lowpass", f: 420, q: 0.7, d: 0.1, v: 0.7 },
  ],
  wood: [
    { type: "bandpass", f: 320, q: 4, d: 0.14, v: 1.2 },
    { type: "bandpass", f: 1100, q: 1.2, d: 0.05, v: 0.5 },
  ],
  grass: [{ type: "bandpass", f: 2800, q: 0.8, d: 0.07, v: 0.7, n: 3, spread: 0.035 }],
  plant: [{ type: "bandpass", f: 3400, q: 0.9, d: 0.05, v: 0.5, n: 2, spread: 0.03 }],
  dirt: [{ type: "lowpass", f: 500, q: 0.8, d: 0.11, v: 1.1, n: 2, spread: 0.025 }],
  sand: [{ type: "bandpass", f: 3200, q: 0.6, d: 0.05, v: 0.6, n: 4, spread: 0.028 }],
  glass: [
    { type: "highpass", f: 2500, q: 0.7, d: 0.05, v: 0.5 },
    { type: "bandpass", f: 4200, q: 14, d: 0.12, v: 1.4, n: 4, spread: 0.03, jitter: 0.5 },
  ],
  cloth: [{ type: "lowpass", f: 380, q: 0.7, d: 0.12, v: 0.9 }],
};

// Creature voices. Each call: f0 -> f1 pitch glide, formants [freq, q, gain]
// (vowel shape), vib: vibrato depth (fraction), breath: noise mixed in.
const VOICES = {
  fluffalo: {
    // A low, nasal grumble.
    idle: [{ f0: 92, f1: 78, d: 0.9, v: 0.32, formants: [[260, 5, 1.2], [620, 6, 0.5]], vib: 0.02, breath: 0.2 }],
    hurt: [{ f0: 150, f1: 110, d: 0.3, v: 0.36, formants: [[320, 5, 1], [760, 5, 0.5]], vib: 0.03, breath: 0.3 }],
    death: [{ f0: 130, f1: 60, d: 0.9, v: 0.34, formants: [[280, 5, 1], [640, 6, 0.4]], vib: 0.03, breath: 0.3 }],
  },
  hoplet: {
    // Tiny squeaks: short, breathy whistles.
    idle: [
      { f0: 1500, f1: 1800, d: 0.06, v: 0.1, formants: [[1700, 8, 1]], breath: 0.5 },
      { f0: 1600, f1: 1950, d: 0.05, v: 0.08, formants: [[1800, 8, 1]], breath: 0.5, delay: 0.1 },
    ],
    hurt: [{ f0: 2100, f1: 1400, d: 0.13, v: 0.16, formants: [[1900, 6, 1]], breath: 0.5 }],
    death: [{ f0: 1700, f1: 700, d: 0.3, v: 0.16, formants: [[1500, 5, 1]], breath: 0.5 }],
  },
  mossback: {
    // Clicks and a slow hiss.
    idle: [{ noise: { type: "bandpass", f: 900, q: 3, d: 0.04, v: 0.35, n: 2, spread: 0.09 } }],
    hurt: [{ noise: { type: "bandpass", f: 2600, q: 0.8, d: 0.35, v: 0.3, attack: 0.05 } }],
    death: [{ noise: { type: "bandpass", f: 2200, q: 0.8, d: 0.7, v: 0.3, attack: 0.08 } }],
  },
  zombie: {
    // A hollow, breathy moan ("uhh") with a slow waver.
    idle: [{ f0: 105, f1: 82, d: 1.2, v: 0.38, formants: [[480, 6, 1], [900, 7, 0.6], [2400, 9, 0.15]], vib: 0.035, breath: 0.35 }],
    hurt: [{ f0: 160, f1: 115, d: 0.28, v: 0.38, formants: [[560, 5, 1], [1000, 6, 0.5]], vib: 0.02, breath: 0.4 }],
    death: [{ f0: 130, f1: 48, d: 1.3, v: 0.4, formants: [[440, 5, 1], [820, 6, 0.5]], vib: 0.05, breath: 0.4 }],
    attack: [{ f0: 190, f1: 140, d: 0.22, v: 0.36, formants: [[620, 4, 1], [1150, 5, 0.6]], vib: 0.02, breath: 0.5 }],
  },
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

  // One filtered noise hit (or `n` staggered grains of it) into `dest`.
  _hit({ type = "lowpass", f = 1000, q = 1, d = 0.1, v = 0.3, n = 1, spread = 0.03, jitter = 0.15, attack = 0.004, fEnd = null }, when = 0, dest = null) {
    if (!this.ctx) return;
    const out = dest || this.master;
    for (let i = 0; i < n; i++) {
      const t = this.ctx.currentTime + when + i * spread * (0.7 + Math.random() * 0.6);
      const src = this._noise(t, d + attack);
      const filter = this.ctx.createBiquadFilter();
      filter.type = type;
      const freq = f * (1 + (Math.random() - 0.5) * 2 * jitter);
      filter.frequency.setValueAtTime(freq, t);
      if (fEnd) filter.frequency.exponentialRampToValueAtTime(fEnd, t + d);
      filter.Q.value = q;
      const g = this.ctx.createGain();
      const peak = v * (n > 1 ? 0.75 + Math.random() * 0.5 : 1);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t + attack + d);
      src.connect(filter).connect(g).connect(out);
    }
  }

  // A creature voice: a buzzy source through formant filters.
  _voice({ f0, f1, d, v, formants, vib = 0, breath = 0, delay = 0 }, gainScale = 1) {
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.exponentialRampToValueAtTime(v * gainScale, t + Math.min(0.06, d * 0.3));
    bus.gain.setValueAtTime(v * gainScale, t + d * 0.55);
    bus.gain.exponentialRampToValueAtTime(0.0001, t + d);
    bus.connect(this.master);

    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    const jitter = 0.94 + Math.random() * 0.12;
    osc.frequency.setValueAtTime(f0 * jitter, t);
    osc.frequency.exponentialRampToValueAtTime(f1 * jitter, t + d);
    if (vib > 0) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5 + Math.random() * 2;
      const depth = ctx.createGain();
      depth.gain.value = f0 * vib;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + d + 0.05);
    }
    // Soften the raw buzz, then shape it with the formants.
    const soften = ctx.createBiquadFilter();
    soften.type = "lowpass";
    soften.frequency.value = Math.max(formants[formants.length - 1][0] * 1.6, 800);
    osc.connect(soften);
    for (const [ff, q, g] of formants) {
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = ff;
      bp.Q.value = q;
      const fg = ctx.createGain();
      fg.gain.value = g * 2.2;
      soften.connect(bp).connect(fg).connect(bus);
    }
    osc.start(t);
    osc.stop(t + d + 0.05);
    if (breath > 0) {
      // Breath: noise through the main formant.
      const src = this._noise(t, d);
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = formants[0][0] * 1.4;
      bp.Q.value = 1.2;
      const bg = ctx.createGain();
      bg.gain.value = breath;
      src.connect(bp).connect(bg).connect(bus);
    }
  }

  // Break/place/dig/step sounds per block material.
  _material(sound, { volume = 0.25, duration = 1, pitch = 1 } = {}) {
    const layers = MATERIALS[sound] || MATERIALS.stone;
    for (const layer of layers) {
      this._hit({ ...layer, f: layer.f * pitch, d: layer.d * duration, v: layer.v * volume });
    }
  }

  playBreak(sound = "stone") {
    this._material(sound, { volume: 0.34, duration: 1.5, pitch: 0.95 });
    // Crumbs settling after the break.
    this._hit({ type: "bandpass", f: 1800, q: 1, d: 0.03, v: 0.06, n: 3, spread: 0.05 }, 0.08);
  }

  playPlace(sound = "stone") {
    this._material(sound, { volume: 0.26, duration: 0.8, pitch: 1.1 });
  }

  playDig(sound = "stone") {
    this._material(sound, { volume: 0.15, duration: 0.6, pitch: 1.05 });
  }

  playFootstep(sound = "grass") {
    this._material(sound, { volume: 0.1, duration: 0.6, pitch: 0.8 });
  }

  // Picking up an item: a soft little pop.
  playPickup() {
    this._hit({ type: "bandpass", f: 1400, q: 3, d: 0.035, v: 0.16, jitter: 0.2 });
  }

  // UI click: a quiet tick.
  playClick() {
    this._hit({ type: "bandpass", f: 3200, q: 1.5, d: 0.015, v: 0.08, jitter: 0.1 });
  }

  // Crafting: two quick woody taps.
  playCraft() {
    this._hit({ type: "bandpass", f: 700, q: 3, d: 0.05, v: 0.22, n: 2, spread: 0.08 });
  }

  // A crunchy bite.
  playEat() {
    this._hit({ type: "bandpass", f: 1400, q: 1.2, d: 0.05, v: 0.14, n: 3, spread: 0.022, jitter: 0.4 });
  }

  // A tool breaking: a sharp snap and a few small bits.
  playToolBreak() {
    this._hit({ type: "highpass", f: 2200, q: 0.8, d: 0.06, v: 0.3 });
    this._hit({ type: "bandpass", f: 900, q: 2, d: 0.05, v: 0.2, n: 3, spread: 0.04 }, 0.04);
  }

  // Getting hurt: a dull body thud.
  playHurt() {
    this._hit({ type: "lowpass", f: 320, q: 1.2, d: 0.14, v: 0.55, fEnd: 120 });
    this._hit({ type: "bandpass", f: 900, q: 1, d: 0.05, v: 0.1 });
  }

  // Dying: a heavier thud as the body hits the ground, and a low rumble.
  playDeath() {
    this._hit({ type: "lowpass", f: 380, q: 1.2, d: 0.25, v: 0.7, fEnd: 90 });
    this._hit({ type: "lowpass", f: 180, q: 0.8, d: 0.8, v: 0.35, attack: 0.05 }, 0.12);
  }

  playSplash() {
    this._hit({ type: "lowpass", f: 1400, q: 0.7, d: 0.4, v: 0.3, fEnd: 400, attack: 0.01 });
    this._hit({ type: "bandpass", f: 2600, q: 1.5, d: 0.04, v: 0.08, n: 5, spread: 0.06, jitter: 0.4 }, 0.1); // droplets
  }

  // Flight on/off (creative): a short soft rush of air.
  playFlightToggle(enabled) {
    this._hit({ type: "bandpass", f: enabled ? 700 : 1200, fEnd: enabled ? 1400 : 600, q: 1.2, d: 0.22, v: 0.1, attack: 0.05 });
  }

  // Throwing: an airy whoosh.
  playThrow() {
    this._hit({ type: "bandpass", f: 700, fEnd: 1600, q: 1.4, d: 0.2, v: 0.16, attack: 0.03 });
  }

  // Mob voices: `event` is "idle", "hurt", "death" or "attack"; quieter
  // with distance (blocks), silent beyond 40.
  playMob(kind, event, distance = 0) {
    if (!this.ctx || distance > 40) return;
    const gain = 1 / (1 + distance / 7);
    const parts = VOICES[kind]?.[event];
    if (!parts) return;
    for (const part of parts) {
      if (part.noise) this._hit({ ...part.noise, v: part.noise.v * gain }, part.delay || 0);
      else this._voice(part, gain);
    }
  }

  // The player's weapon landing (a heavier crack on a critical hit).
  playHit(crit = false) {
    this._hit({ type: "lowpass", f: 700, q: 1, d: 0.08, v: 0.35, fEnd: 200 });
    this._hit({ type: "bandpass", f: 1600, q: 1.2, d: 0.03, v: 0.12 });
    if (crit) this._hit({ type: "highpass", f: 3000, q: 0.8, d: 0.1, v: 0.2 });
  }

  // A swing that hits nothing.
  playSwing() {
    this._hit({ type: "bandpass", f: 1100, fEnd: 700, q: 1.5, d: 0.12, v: 0.08, attack: 0.02 });
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
