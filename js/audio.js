// Small procedural Web Audio sound effects — no external audio files.
//
// Everything routes through a master gain and a dynamics compressor, so loud
// layered sounds (like the Blast Orb explosion) can peak hard without
// clipping or drowning out everything else.

const NOISE_SECONDS = 2.5;

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

  _playNoiseBurst({ duration = 0.12, volume = 0.3, filterFreq = 1200, filterType = "lowpass" } = {}) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const src = this._noise(now, duration);
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
  }

  _playTone({ freq = 220, duration = 0.1, volume = 0.2, type = "sine", slideTo = null } = {}) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
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

  playBreak() {
    this._playNoiseBurst({ duration: 0.15, volume: 0.28, filterFreq: 900 + Math.random() * 400 });
  }

  playPlace() {
    this._playNoiseBurst({ duration: 0.09, volume: 0.22, filterFreq: 1800 + Math.random() * 400 });
  }

  playFootstep() {
    this._playNoiseBurst({ duration: 0.07, volume: 0.12, filterFreq: 400 + Math.random() * 200 });
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
