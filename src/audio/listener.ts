/**
 * Listener — turns whatever is playing into a small set of expressive numbers.
 *
 * Everything downstream (shaders, typography, poetry) reads only from `Features`.
 * Levels are auto-gained: a quiet lo-fi tab and a loud master should both fill
 * the same 0..1 range within a few seconds.
 */

export type SourceKind = "resting" | "tab" | "mic" | "file";

export type Features = {
  /** Overall loudness, auto-gained. */
  level: number;
  /** Auto-gained band energies. */
  sub: number;
  bass: number;
  lowMid: number;
  mid: number;
  high: number;
  air: number;
  /** Brightness of the spectrum, 0 dark .. 1 brilliant. */
  centroid: number;
  /** Noisiness: 0 tonal .. 1 noisy (cymbals, texture, breath). */
  noise: number;
  /** Rising spectral energy — general sense of "something is happening". */
  flux: number;
  /** Percussive envelopes, fast attack, musical decay. */
  kick: number;
  snare: number;
  hat: number;
  /** Beat-locked oscillation, 0..1, peaks on the beat. */
  pulse: number;
  /** Continuous beat phase 0..1 and its estimate. */
  beatPhase: number;
  /** Beats elapsed, unwrapped — lets shaders emit one event per beat. */
  beatTime: number;
  bpm: number;
  /** Short-term loudness against long-term: swells and drops. */
  dynamics: number;
  /** 1 while nothing is audible. */
  silence: number;
  /** Seconds since a marked structural change (drop, breakdown, entry). */
  sinceShift: number;
  /** How fast the piece wants the image to move, roughly 0.25 .. 1.45. */
  motion: number;
  /** Loudness on a long fuse — how big a thing should be, not how bright. */
  swell: number;
  /** Log-spaced magnitude spectrum, 0..1. Fast: transients and light. */
  spectrum: Float32Array;
  /** The same spectrum, slowly followed. Shape and geometry read from this. */
  spectrumSlow: Float32Array;
};

const SPECTRUM_BINS = 256;
const F_MIN = 28;
const F_MAX = 16000;

function clamp(v: number, lo = 0, hi = 1) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** One-pole smoother with separate attack and release times, in seconds. */
function follow(current: number, target: number, dt: number, attack: number, release: number) {
  const tau = target > current ? attack : release;
  const k = 1 - Math.exp(-dt / Math.max(tau, 1e-4));
  return current + (target - current) * k;
}

/**
 * Automatic gain: tracks a ceiling and a floor, and reports where the signal
 * currently sits between them.
 *
 * The ceiling jumps to new peaks and decays slowly; the floor drops to new
 * troughs and rises very slowly. The two must not be allowed to converge —
 * under sustained music they otherwise close on the mean, the span goes to
 * nothing, and every band flatlines after a minute of listening.
 */
class AutoGain {
  private ceil = 1e-3;
  private floor = 0;

  constructor(
    private readonly attack = 0.12,
    private readonly decay = 9,
    /** Smallest range we will ever divide by, in analyser units. */
    private readonly minSpan = 0.03,
  ) {}

  push(value: number, dt: number): number {
    // Peak: straight up, then a long decay.
    this.ceil = follow(this.ceil, value, dt, this.attack, this.decay);
    // Trough: straight down, then a very reluctant climb.
    this.floor = follow(this.floor, value, dt, 16, 0.35);

    // Keep them apart no matter how steady the material is.
    if (this.ceil - this.floor < this.minSpan) {
      this.floor = this.ceil - this.minSpan;
    }

    return clamp((value - this.floor) / (this.ceil - this.floor));
  }
}

/** Percussive onset envelope for one frequency region. */
class Onset {
  private prev: Float32Array | null = null;
  private gain = new AutoGain(0.08, 3.2);
  value = 0;

  constructor(
    private readonly lo: number,
    private readonly hi: number,
    private readonly decay: number,
    private readonly threshold: number,
  ) {}

  push(mag: Float32Array, dt: number): number {
    if (!this.prev || this.prev.length !== mag.length) {
      this.prev = new Float32Array(mag.length);
      this.prev.set(mag);
      return 0;
    }
    let rise = 0;
    for (let i = this.lo; i < this.hi; i++) {
      const d = mag[i] - this.prev[i];
      if (d > 0) rise += d;
    }
    this.prev.set(mag);
    const normalized = this.gain.push(rise / Math.max(1, this.hi - this.lo), dt);
    const hit = smoothstep(this.threshold, Math.min(this.threshold + 0.42, 1), normalized);
    this.value = Math.max(hit, this.value - dt / this.decay);
    return clamp(this.value);
  }
}

/** Tempo from autocorrelation of the onset envelope, resampled to a steady 60 Hz. */
class Tempo {
  private static RATE = 60;
  private static SIZE = 512;
  private history = new Float32Array(Tempo.SIZE);
  private write = 0;
  private carry = 0;
  private sinceEstimate = 0;
  period = 0.5;
  confidence = 0;
  phase = 0;
  /** Unwrapped beat count; never runs backwards. */
  count = 0;

  push(strength: number, dt: number) {
    this.carry += dt;
    const step = 1 / Tempo.RATE;
    let guard = 0;
    while (this.carry >= step && guard++ < 8) {
      this.carry -= step;
      this.history[this.write] = strength;
      this.write = (this.write + 1) % Tempo.SIZE;
    }

    this.sinceEstimate += dt;
    if (this.sinceEstimate > 0.5) {
      this.sinceEstimate = 0;
      this.estimate();
    }

    // With no lock, run slowly rather than inventing a brisk tempo.
    const effective = this.confidence > 0.25 ? this.period : this.period * 2.4;
    const advance = dt / effective;
    this.count += advance;
    this.phase = (this.phase + advance) % 1;
  }

  /** Pull the beat phase toward zero when a strong onset lands. */
  align(strength: number) {
    if (strength < 0.6) return;
    const drift = this.phase > 0.5 ? this.phase - 1 : this.phase;
    const nudge = drift * 0.18 * this.confidence;
    this.phase -= nudge;
    // Keep the unwrapped counter in step, but only ever pull it forward —
    // a ring that shrank mid-flight would read as a glitch.
    if (nudge < 0) this.count -= nudge;
    if (this.phase < 0) this.phase += 1;
  }

  private estimate() {
    const n = Tempo.SIZE;
    const buf = new Float32Array(n);
    let mean = 0;
    for (let i = 0; i < n; i++) {
      buf[i] = this.history[(this.write + i) % n];
      mean += buf[i];
    }
    mean /= n;
    for (let i = 0; i < n; i++) buf[i] -= mean;

    // 60 Hz frames: lag 20 -> 180 BPM, lag 75 -> 48 BPM.
    let bestLag = 0;
    let best = 0;
    for (let lag = 20; lag <= 78; lag++) {
      let sum = 0;
      for (let i = lag; i < n; i++) sum += buf[i] * buf[i - lag];
      // Mild preference for the 90–140 BPM range where most music sits.
      const bias = 1 - 0.25 * Math.abs(lag - 40) / 40;
      const score = (sum / (n - lag)) * bias;
      if (score > best) {
        best = score;
        bestLag = lag;
      }
    }

    let energy = 0;
    for (let i = 0; i < n; i++) energy += buf[i] * buf[i];
    energy /= n;

    const strength = energy > 1e-6 ? clamp(best / energy) : 0;
    this.confidence = follow(this.confidence, strength, 0.5, 1.5, 3.0);
    if (bestLag > 0 && strength > 0.12) {
      const candidate = bestLag / Tempo.RATE;
      // Track smoothly, but jump if the estimate is far from the current lock.
      const ratio = candidate / this.period;
      this.period = ratio > 1.4 || ratio < 0.7 ? candidate : this.period * 0.82 + candidate * 0.18;
    }
  }
}

const RESTING: Features = {
  level: 0.12,
  sub: 0.1,
  bass: 0.12,
  lowMid: 0.1,
  mid: 0.08,
  high: 0.06,
  air: 0.05,
  centroid: 0.3,
  noise: 0.2,
  flux: 0,
  kick: 0,
  snare: 0,
  hat: 0,
  pulse: 0,
  beatPhase: 0,
  beatTime: 0,
  bpm: 0,
  dynamics: 0.3,
  silence: 1,
  sinceShift: 0,
  motion: 0.45,
  swell: 0.12,
  spectrum: new Float32Array(SPECTRUM_BINS),
  spectrumSlow: new Float32Array(SPECTRUM_BINS),
};

export class Listener {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private element: HTMLAudioElement | null = null;
  private freq = new Float32Array(0);
  private time = new Float32Array(0);
  private mag = new Float32Array(0);
  private binIndex: Int32Array = new Int32Array(0);

  private gains = {
    level: new AutoGain(),
    sub: new AutoGain(),
    bass: new AutoGain(),
    lowMid: new AutoGain(),
    mid: new AutoGain(),
    high: new AutoGain(),
    air: new AutoGain(),
    flux: new AutoGain(0.1, 4),
  };
  private spectrumGain = new AutoGain(0.2, 6);
  private onsets = {
    kick: new Onset(0, 1, 0.24, 0.45),
    snare: new Onset(0, 1, 0.17, 0.5),
    hat: new Onset(0, 1, 0.1, 0.55),
  };
  private tempo = new Tempo();
  private smoothed: Features = {
    ...RESTING,
    spectrum: new Float32Array(SPECTRUM_BINS),
    spectrumSlow: new Float32Array(SPECTRUM_BINS),
  };
  private shortLoud = 0;
  private longLoud = 0;
  private clock = 0;
  private shiftAt = 0;
  private ready = false;

  kind: SourceKind = "resting";
  /** Set when a file is playing so the UI can show a real timeline. */
  duration = 0;
  position = 0;

  get features(): Features {
    return this.smoothed;
  }

  get audioElement() {
    return this.element;
  }

  async listenToTab(): Promise<void> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: "browser" },
      audio: {
        // Keep the tab audible in the user's speakers while we analyse it.
        suppressLocalAudioPlayback: false,
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
      },
      systemAudio: "include",
      selfBrowserSurface: "exclude",
      surfaceSwitching: "include",
      preferCurrentTab: false,
    } as DisplayMediaStreamOptions);

    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("no-audio-shared");
    }
    this.attachStream(stream, "tab");
  }

  async listenToMic(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { autoGainControl: false, echoCancellation: false, noiseSuppression: false },
    });
    this.attachStream(stream, "mic");
  }

  async listenToFile(file: File): Promise<void> {
    this.release();
    const context = this.makeContext();
    const element = new Audio();
    element.src = URL.createObjectURL(file);
    element.crossOrigin = "anonymous";
    element.loop = false;
    const source = context.createMediaElementSource(element);
    const analyser = this.makeAnalyser(context);
    source.connect(analyser);
    // Files need to reach the speakers; captured streams already do.
    source.connect(context.destination);
    this.element = element;
    this.analyser = analyser;
    this.kind = "file";
    this.ready = true;
    await element.play();
  }

  /** Called when a capture stream ends on its own (user stopped sharing). */
  onended: (() => void) | null = null;

  release() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.element) {
      this.element.pause();
      URL.revokeObjectURL(this.element.src);
      this.element = null;
    }
    this.analyser = null;
    this.ready = false;
    this.kind = "resting";
    this.duration = 0;
    this.position = 0;
    void this.context?.close().catch(() => undefined);
    this.context = null;
  }

  private makeContext() {
    const context = new AudioContext({ latencyHint: "interactive" });
    void context.resume();
    this.context = context;
    return context;
  }

  private makeAnalyser(context: AudioContext) {
    const analyser = context.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.62;
    analyser.minDecibels = -96;
    analyser.maxDecibels = -14;
    this.freq = new Float32Array(analyser.frequencyBinCount);
    this.time = new Float32Array(analyser.fftSize);
    this.mag = new Float32Array(analyser.frequencyBinCount);
    this.buildBinIndex(context.sampleRate, analyser.frequencyBinCount);
    return analyser;
  }

  private attachStream(stream: MediaStream, kind: SourceKind) {
    this.release();
    const context = this.makeContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = this.makeAnalyser(context);
    source.connect(analyser);
    this.stream = stream;
    this.analyser = analyser;
    this.kind = kind;
    this.ready = true;
    stream.getTracks().forEach((track) =>
      track.addEventListener("ended", () => {
        if (this.stream !== stream) return;
        this.release();
        this.onended?.();
      }, { once: true }),
    );
  }

  /** Precompute which FFT bin each log-spaced spectrum bin starts at. */
  private buildBinIndex(sampleRate: number, bins: number) {
    const nyquist = sampleRate / 2;
    this.binIndex = new Int32Array(SPECTRUM_BINS + 1);
    for (let i = 0; i <= SPECTRUM_BINS; i++) {
      const f = F_MIN * Math.pow(F_MAX / F_MIN, i / SPECTRUM_BINS);
      this.binIndex[i] = Math.min(bins - 1, Math.max(0, Math.round((f / nyquist) * bins)));
    }
  }

  private hzToBin(hz: number) {
    if (!this.context || !this.analyser) return 0;
    const nyquist = this.context.sampleRate / 2;
    return Math.min(this.analyser.frequencyBinCount - 1, Math.round((hz / nyquist) * this.analyser.frequencyBinCount));
  }

  private bandEnergy(loHz: number, hiHz: number) {
    const lo = this.hzToBin(loHz);
    const hi = Math.max(lo + 1, this.hzToBin(hiHz));
    let sum = 0;
    for (let i = lo; i < hi; i++) sum += this.mag[i];
    return sum / (hi - lo);
  }

  update(dt: number): Features {
    this.clock += dt;
    // Chrome suspends audio contexts on its own — a suspended analyser returns
    // silence forever, which looks exactly like a broken visualiser.
    if (this.context && this.context.state === "suspended") {
      void this.context.resume().catch(() => undefined);
    }
    const target = this.ready && this.analyser ? this.measure(dt) : this.rest(dt);
    return this.blend(target, dt);
  }

  private measure(dt: number): Features {
    const analyser = this.analyser!;
    analyser.getFloatFrequencyData(this.freq);
    analyser.getFloatTimeDomainData(this.time);

    // dB -> linear amplitude, floored at the analyser's noise floor.
    const floor = analyser.minDecibels;
    const span = analyser.maxDecibels - floor;
    for (let i = 0; i < this.freq.length; i++) {
      this.mag[i] = clamp((this.freq[i] - floor) / span);
    }

    let rms = 0;
    for (let i = 0; i < this.time.length; i++) rms += this.time[i] * this.time[i];
    rms = Math.sqrt(rms / this.time.length);

    const raw = {
      sub: this.bandEnergy(20, 62),
      bass: this.bandEnergy(62, 170),
      lowMid: this.bandEnergy(170, 460),
      mid: this.bandEnergy(460, 1500),
      high: this.bandEnergy(1500, 5200),
      air: this.bandEnergy(5200, 15000),
    };

    // Spectral centroid and flatness over the audible span.
    let weighted = 0;
    let total = 0;
    let logSum = 0;
    let linSum = 0;
    const lo = this.hzToBin(40);
    const hi = this.hzToBin(14000);
    for (let i = lo; i < hi; i++) {
      const m = this.mag[i];
      weighted += m * i;
      total += m;
      logSum += Math.log(m + 1e-5);
      linSum += m;
    }
    const centroidBin = total > 1e-5 ? weighted / total : lo;
    const centroid = clamp(Math.log(centroidBin / lo + 1) / Math.log(hi / lo + 1));
    const count = Math.max(1, hi - lo);
    const flatness = clamp(Math.exp(logSum / count) / (linSum / count + 1e-6));

    const level = this.gains.level.push(rms, dt);
    const kick = this.onsets.kick.push(this.mag.subarray(this.hzToBin(28), this.hzToBin(140)), dt);
    const snare = this.onsets.snare.push(this.mag.subarray(this.hzToBin(180), this.hzToBin(2400)), dt);
    const hat = this.onsets.hat.push(this.mag.subarray(this.hzToBin(5200), this.hzToBin(13000)), dt);

    const onsetStrength = kick * 0.6 + snare * 0.3 + hat * 0.1;
    this.tempo.push(onsetStrength, dt);
    this.tempo.align(kick);

    // Swell: short-term loudness against a slow average.
    this.shortLoud = follow(this.shortLoud, rms, dt, 0.08, 0.25);
    this.longLoud = follow(this.longLoud, rms, dt, 3.0, 6.0);
    const dynamics = clamp(0.5 + (this.shortLoud - this.longLoud) / Math.max(this.longLoud * 2, 1e-3) * 0.5);
    if (Math.abs(dynamics - 0.5) > 0.34 && this.clock - this.shiftAt > 6) this.shiftAt = this.clock;

    // Log-spaced spectrum for the shaders.
    const spectrum = this.smoothed.spectrum;
    const spectrumSlow = this.smoothed.spectrumSlow;
    let peak = 0;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const a = this.binIndex[i];
      const b = Math.max(a + 1, this.binIndex[i + 1]);
      let sum = 0;
      for (let j = a; j < b; j++) sum += this.mag[j];
      const value = sum / (b - a);
      peak = Math.max(peak, value);
      // Fast: rises immediately, falls like a meter needle. Drives light.
      spectrum[i] = follow(spectrum[i], value, dt, 0.02, 0.16);
      // Slow: hears sustained instruments rather than transients. Drives shape.
      spectrumSlow[i] = follow(spectrumSlow[i], value, dt, 0.45, 1.10);
    }
    const spectrumScale = 1 / Math.max(this.spectrumGain.push(peak, dt) * 0.6 + 0.4, 0.25);
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      spectrum[i] = clamp(spectrum[i] * spectrumScale);
      spectrumSlow[i] = clamp(spectrumSlow[i] * spectrumScale);
    }

    const silence = smoothstep(0.004, 0.0008, rms);

    return {
      level,
      sub: this.gains.sub.push(raw.sub, dt),
      bass: this.gains.bass.push(raw.bass, dt),
      lowMid: this.gains.lowMid.push(raw.lowMid, dt),
      mid: this.gains.mid.push(raw.mid, dt),
      high: this.gains.high.push(raw.high, dt),
      air: this.gains.air.push(raw.air, dt),
      centroid,
      noise: flatness,
      flux: this.gains.flux.push(onsetStrength, dt),
      kick,
      snare,
      hat,
      pulse: Math.pow(0.5 + 0.5 * Math.cos(this.tempo.phase * Math.PI * 2), 2.2) * this.tempo.confidence,
      beatPhase: this.tempo.phase,
      beatTime: this.tempo.count,
      bpm: this.tempo.confidence > 0.2 ? 60 / this.tempo.period : 0,
      dynamics,
      silence,
      sinceShift: this.clock - this.shiftAt,
      motion: this.motionRate(level, silence),
      swell: level,
      spectrum,
      spectrumSlow,
    };
  }

  /**
   * How fast this piece wants the image to move. A slow, quiet record should
   * not be animated at the same rate as a fast, loud one — this is what stops
   * the presets feeling nervous under music that is not.
   */
  private motionRate(level: number, silence: number) {
    const locked = this.tempo.confidence > 0.25;
    const tempoRate = locked ? clamp(60 / this.tempo.period / 118, 0.45, 1.5) : 0.55;
    const energyRate = 0.32 + level * 0.85;
    const rate = clamp(tempoRate * 0.5 + energyRate * 0.5, 0.20, 1.45);
    // Nothing audible: wind the clock almost all the way down.
    return rate * (0.10 + 0.90 * (1 - silence));
  }

  /**
   * With nothing connected the instrument still breathes: a slow synthetic
   * signal so the resting screen is alive rather than frozen.
   */
  private rest(dt: number): Features {
    const t = this.clock;
    // Very slow, very small. With nothing playing the image should barely
    // move — a sign of life, not a performance.
    const breath = 0.5 + 0.5 * Math.sin(t * 0.055);
    const swell = 0.5 + 0.5 * Math.sin(t * 0.021 + 1.3);
    const drift = 0.5 + 0.5 * Math.sin(t * 0.013 + 2.6);
    const period = 7.5;
    const phase = (t / period) % 1;
    const spectrum = this.smoothed.spectrum;
    const spectrumSlow = this.smoothed.spectrumSlow;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const f = i / SPECTRUM_BINS;
      const shape = Math.exp(-f * 2.4) * (0.5 + 0.5 * Math.sin(f * 26 + t * 0.09));
      const target = clamp(shape * (0.16 + breath * 0.18));
      spectrum[i] = follow(spectrum[i], target, dt, 0.3, 0.6);
      spectrumSlow[i] = follow(spectrumSlow[i], target, dt, 0.9, 1.4);
    }
    this.tempo.push(0, dt);
    return {
      level: 0.06 + breath * 0.04,
      sub: 0.05 + swell * 0.05,
      bass: 0.06 + breath * 0.05,
      lowMid: 0.05 + drift * 0.04,
      mid: 0.04 + breath * 0.03,
      high: 0.03 + drift * 0.03,
      air: 0.02 + swell * 0.03,
      centroid: 0.26 + drift * 0.08,
      noise: 0.24,
      flux: 0.01 + breath * 0.02,
      kick: 0,
      snare: 0,
      hat: 0,
      pulse: Math.pow(0.5 + 0.5 * Math.cos(phase * Math.PI * 2), 3) * 0.10,
      beatPhase: phase,
      beatTime: t / period,
      bpm: 0,
      dynamics: 0.46 + swell * 0.05,
      silence: 1,
      sinceShift: 0,
      motion: 0.12,
      swell: 0.05 + breath * 0.03,
      spectrum,
      spectrumSlow: this.smoothed.spectrumSlow,
    };
  }

  /** Final smoothing pass so nothing in the visuals ever steps. */
  private blend(target: Features, dt: number): Features {
    const s = this.smoothed;
    s.level = follow(s.level, target.level, dt, 0.05, 0.2);
    s.sub = follow(s.sub, target.sub, dt, 0.05, 0.22);
    s.bass = follow(s.bass, target.bass, dt, 0.04, 0.18);
    s.lowMid = follow(s.lowMid, target.lowMid, dt, 0.05, 0.2);
    s.mid = follow(s.mid, target.mid, dt, 0.05, 0.2);
    s.high = follow(s.high, target.high, dt, 0.04, 0.16);
    s.air = follow(s.air, target.air, dt, 0.03, 0.14);
    s.centroid = follow(s.centroid, target.centroid, dt, 0.35, 0.6);
    s.noise = follow(s.noise, target.noise, dt, 0.4, 0.7);
    s.flux = follow(s.flux, target.flux, dt, 0.02, 0.12);
    s.kick = target.kick;
    s.snare = target.snare;
    s.hat = target.hat;
    s.pulse = target.pulse;
    s.beatPhase = target.beatPhase;
    s.beatTime = target.beatTime;
    s.bpm = target.bpm;
    s.dynamics = follow(s.dynamics, target.dynamics, dt, 0.25, 0.8);
    // Deliberately sluggish: the rate of the image should not flicker.
    s.motion = follow(s.motion, target.motion, dt, 2.5, 3.5);
    // Slower still: geometry driven by this grows and shrinks over phrases,
    // not over beats.
    s.swell = follow(s.swell, target.swell, dt, 1.4, 2.2);
    s.silence = follow(s.silence, target.silence, dt, 0.8, 0.4);
    s.sinceShift = target.sinceShift;

    if (this.element) {
      this.duration = Number.isFinite(this.element.duration) ? this.element.duration : 0;
      this.position = this.element.currentTime;
    }
    return s;
  }
}

export const SPECTRUM_SIZE = SPECTRUM_BINS;
