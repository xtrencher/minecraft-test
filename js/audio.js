// Small procedural Web Audio sound effects — no external audio files.

export class Audio {
  constructor() {
    this.ctx = null;
    this._noiseBuffer = null;
  }

  ensureStarted() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this._noiseBuffer = this._makeNoiseBuffer();
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
  }

  _makeNoiseBuffer() {
    const length = this.ctx.sampleRate * 0.3;
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  _playNoiseBurst({ duration = 0.12, volume = 0.3, filterFreq = 1200, filterType = "lowpass" } = {}) {
    if (!this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = filterFreq;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    src.start();
    src.stop(this.ctx.currentTime + duration + 0.02);
  }

  _playTone({ freq = 220, duration = 0.1, volume = 0.2, type = "sine", slideTo = null } = {}) {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
    if (slideTo !== null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), this.ctx.currentTime + duration);
    }
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(volume, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start();
    osc.stop(this.ctx.currentTime + duration + 0.02);
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

  playThrow() {
    this._playTone({ freq: 500, slideTo: 800, duration: 0.12, volume: 0.15, type: "sine" });
  }

  playExplosion() {
    this._playNoiseBurst({ duration: 0.45, volume: 0.4, filterFreq: 300, filterType: "lowpass" });
    this._playTone({ freq: 90, slideTo: 40, duration: 0.4, volume: 0.25, type: "sawtooth" });
  }
}
