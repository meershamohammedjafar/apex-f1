import { clamp, clamp01 } from '../core/MathUtils.js';
import { Rng } from '../core/Rng.js';

/**
 * The shared WebAudio toolkit. Every sound in APEX is synthesised — there is not one
 * sample file in the build — so this module carries the primitives the rest of the
 * audio subsystem is assembled from: noise generation, filter and curve factories, a
 * synthesised convolution impulse, and a feedback delay line.
 *
 * The design constraint that shapes all of it: the graph is built once and then only
 * *parameters* move. Nothing here allocates or rewires per frame.
 */

/** Dry air at 20 C. Used by the Doppler shift on passing cars. */
export const SPEED_OF_SOUND = 343.2;

const TWO_PI = Math.PI * 2;

export function dbToGain(db) {
  return Math.pow(10, db * 0.05);
}

/**
 * Follow a target with a one-pole ramp, skipping the write when the parameter is
 * already effectively there. Physics moves a hair per 120 Hz tick, so gating on an
 * epsilon keeps each AudioParam's event list close to empty instead of appending a
 * ramp per parameter per tick.
 */
export function setParam(param, value, time, tau = 0.04, eps = 1e-3) {
  const v = param.value;
  if (v === value || Math.abs(v - value) < eps) return;
  if (tau <= 0) param.setValueAtTime(value, time);
  else param.setTargetAtTime(value, time, tau);
}

/** Immediate, un-smoothed write — for gates that must be sample-accurate. */
export function setParamNow(param, value, time) {
  param.setValueAtTime(value, time);
}

/**
 * Schedule a percussive envelope on a gain parameter. Used for every transient in the
 * game (shift clack, kerb strike, overrun crackle, impacts) so that transients cost a
 * few scheduled events rather than a new node graph.
 */
export function envBurst(param, time, peak, attack = 0.0015, decay = 0.08, floor = 1e-4) {
  const start = Math.max(floor, param.value);
  param.cancelScheduledValues(time);
  param.setValueAtTime(start, time);
  param.linearRampToValueAtTime(Math.max(floor, peak), time + attack);
  param.exponentialRampToValueAtTime(floor, time + attack + decay);
  param.setValueAtTime(0, time + attack + decay + 0.0005);
}

export function gainNode(actx, value = 1) {
  const g = actx.createGain();
  g.gain.value = value;
  return g;
}

export function biquad(actx, type, frequency, Q = 1, gainDb = 0) {
  const f = actx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = Q;
  f.gain.value = gainDb;
  return f;
}

export function shaperNode(actx, curve, oversample = 'none') {
  const s = actx.createWaveShaper();
  s.curve = curve;
  s.oversample = oversample;
  return s;
}

export function oscillator(actx, type, frequency = 440) {
  const o = actx.createOscillator();
  o.type = type;
  o.frequency.value = frequency;
  return o;
}

/** Connect a list of nodes head-to-tail and return the tail. Init-time only. */
export function chain(nodes) {
  for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
  return nodes[nodes.length - 1];
}

export function looper(actx, buffer, playbackRate = 1, offset = 0) {
  const src = actx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  src.playbackRate.value = playbackRate;
  src.__apexOffset = offset;
  return src;
}

/** Start a source exactly once; safe to call again after a context resume. */
export function startSource(src, when = 0) {
  if (src.__apexStarted) return;
  src.__apexStarted = true;
  try {
    src.start(when, src.__apexOffset ?? 0);
  } catch {
    // Already started by a racing resume() — the flag above makes this unreachable in
    // practice, but a double start throws rather than warning, so swallow it.
  }
}

export function stopSource(src) {
  if (!src.__apexStarted || src.__apexStopped) return;
  src.__apexStopped = true;
  try {
    src.stop();
  } catch {
    /* context already closed */
  }
}

/**
 * tanh soft clipper. `drive` above ~3 turns the exhaust stack from a clean additive
 * tone into something with the compressed, ragged edge a real exhaust has once the
 * pressure wave is nonlinear.
 */
export function createSaturationCurve(drive = 2.4, n = 2048) {
  const curve = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }
  return curve;
}

/**
 * Soft knee limiter for the master bus. Linear below the threshold so the mix is not
 * coloured at ordinary levels, tanh above it so a 20-car pile-up cannot clip.
 */
export function createLimiterCurve(threshold = 0.82, n = 4096) {
  const curve = new Float32Array(n);
  const span = 1 - threshold;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= threshold ? a : threshold + span * Math.tanh((a - threshold) / span);
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}

/** Maps a bipolar LFO to [0,1] so it can gate a gain parameter by addition. */
export function createUnipolarCurve() {
  const curve = new Float32Array(2);
  curve[0] = 0;
  curve[1] = 1;
  return curve;
}

/**
 * Turns a sawtooth into a narrow pulse train. This is how the kerb rumble is built:
 * one oscillator whose frequency is the serration strike rate, shaped into impulses,
 * rather than hundreds of scheduled one-shots.
 */
export function createPulseCurve(exponent = 8, n = 2048) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = x <= 0 ? 0 : Math.pow(x, exponent);
  }
  return curve;
}

/**
 * Noise buffers. `pink` and `brown` get a wrap crossfade so a looping source has no
 * audible seam; white does not need one, and `sparse` is a velvet-noise impulse cloud
 * used for gravel rattle and rain patter where individual grains must be discernible.
 */
export function createNoiseBuffer(actx, seconds = 3, kind = 'white', rng = new Rng(0x5eed)) {
  const rate = actx.sampleRate;
  const n = Math.max(1024, Math.floor(rate * seconds));
  const buffer = actx.createBuffer(1, n, rate);
  const d = buffer.getChannelData(0);

  if (kind === 'pink') {
    // Paul Kellet's economy pink filter: -3 dB/octave to within 0.05 dB above 10 Hz.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng.next() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else if (kind === 'brown') {
    let last = 0;
    for (let i = 0; i < n; i++) {
      last = (last + 0.017 * (rng.next() * 2 - 1)) * 0.9985; // leak kills the DC walk
      d[i] = last * 12;
    }
  } else if (kind === 'sparse') {
    const density = 0.014; // ~670 grains/second at 48 kHz
    for (let i = 0; i < n; i++) {
      if (rng.next() < density) {
        const a = (rng.next() * 2 - 1) * (0.35 + rng.next() * 0.65);
        d[i] = a;
        if (i + 1 < n) d[i + 1] = -a * 0.6; // a doublet reads as a hard grain, not a click
      }
    }
  } else {
    for (let i = 0; i < n; i++) d[i] = rng.next() * 2 - 1;
  }

  if (kind === 'pink' || kind === 'brown') {
    const fade = Math.min(Math.floor(rate * 0.05), Math.floor(n * 0.25));
    for (let i = 0; i < fade; i++) {
      const w = i / fade;
      d[i] = d[i] * w + d[n - fade + i] * (1 - w);
    }
  }

  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  if (peak > 0) {
    const s = 0.92 / peak;
    for (let i = 0; i < n; i++) d[i] *= s;
  }
  return buffer;
}

/**
 * Synthesised convolution impulse. Exponentially decaying noise is the textbook
 * starting point, but a flat decay sounds like a plate; a real space loses its high
 * frequencies faster than its lows, so the noise runs through a one-pole lowpass whose
 * cutoff falls across the tail. Discrete early reflections in front of the diffuse tail
 * are what actually tell you the size of the space.
 *
 * `damping` 0..1 = how fast the top end dies. `width` decorrelates the two channels.
 */
export function createImpulseResponse(actx, options = {}) {
  const {
    duration = 1.35,
    decay = 3.4,
    preDelay = 0.008,
    damping = 0.55,
    diffusion = 0.75,
    width = 0.85,
    earlyGain = 0.5,
    earlyCount = 9,
    seed = 0x1e2f,
  } = options;

  const rate = actx.sampleRate;
  const n = Math.max(64, Math.floor(rate * duration));
  const buffer = actx.createBuffer(2, n, rate);
  const rng = new Rng(seed);
  const pre = Math.floor(rate * preDelay);

  for (let ch = 0; ch < 2; ch++) {
    const d = buffer.getChannelData(ch);
    let lp = 0;
    const chanRng = new Rng(seed + ch * 7919);
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / rate;
      const tn = t / duration;
      // Cutoff sweeps from open to closed across the tail: air and surfaces eat treble.
      const a = clamp01(0.06 + damping * tn * 0.9);
      lp += a * ((chanRng.next() * 2 - 1) - lp);
      const env = Math.exp(-decay * t) * (1 - tn * 0.15);
      // Build-up: the diffuse field takes a few milliseconds to become dense.
      const build = clamp01(t / (0.006 + 0.05 * diffusion));
      d[i] = lp * env * build;
    }

    // Early reflections. Their spacing is what gives the space its apparent size.
    for (let e = 0; e < earlyCount; e++) {
      const tap = pre + Math.floor(rng.range(0.004, 0.085) * rate);
      if (tap >= n) continue;
      const g = earlyGain * (1 - e / earlyCount) * (rng.next() < 0.5 ? -1 : 1);
      d[tap] += g * (ch === 0 ? 1 : 1 - width * rng.next());
    }
    if (pre > 0) d[Math.max(0, pre - 1)] += 0.12;
  }

  // Normalise on the summed energy so swapping environments does not change level.
  let energy = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < n; i++) energy += d[i] * d[i];
  }
  const norm = energy > 0 ? 1 / Math.sqrt(energy / n) : 1;
  const scale = clamp(norm * 0.045, 0.001, 12);
  for (let ch = 0; ch < 2; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < n; i++) d[i] *= scale;
  }
  return buffer;
}

/**
 * Feedback delay line with a damping lowpass in the loop — the cheap reverb used on the
 * low quality tier where a convolver is too expensive, and the slapback that gives the
 * trackside barriers their hard early echo everywhere else.
 */
export class RingDelay {
  constructor(actx, options = {}) {
    const {
      time = 0.14, feedback = 0.32, damping = 3600, mix = 0.3, maxTime = 1.0,
    } = options;

    this.actx = actx;
    this.input = gainNode(actx, 1);
    this.output = gainNode(actx, 1);
    this.delay = actx.createDelay(Math.max(maxTime, time * 2));
    this.delay.delayTime.value = time;
    this.feedback = gainNode(actx, clamp01(feedback));
    this.damp = biquad(actx, 'lowpass', damping, 0.5);
    this.wet = gainNode(actx, mix);
    this.dry = gainNode(actx, 1 - mix * 0.5);

    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.delay);
    this.delay.connect(this.damp).connect(this.feedback).connect(this.delay);
    this.damp.connect(this.wet).connect(this.output);
  }

  setTime(seconds, when = 0) {
    setParam(this.delay.delayTime, clamp(seconds, 0.001, this.delay.delayTime.maxValue), when, 0.08, 1e-4);
  }

  setFeedback(v, when = 0) {
    setParam(this.feedback.gain, clamp01(v), when, 0.08);
  }

  setMix(v, when = 0) {
    setParam(this.wet.gain, clamp01(v), when, 0.08);
  }

  dispose() {
    this.input.disconnect();
    this.delay.disconnect();
    this.damp.disconnect();
    this.feedback.disconnect();
    this.wet.disconnect();
    this.dry.disconnect();
    this.output.disconnect();
  }
}

/** Fixed-size scalar ring with an O(1) running mean. Used to de-jitter Doppler input. */
export class RingBuffer {
  constructor(size = 8) {
    this.data = new Float32Array(Math.max(1, size));
    this.index = 0;
    this.filled = 0;
    this.total = 0;
  }

  push(v) {
    const i = this.index;
    if (this.filled === this.data.length) this.total -= this.data[i];
    else this.filled++;
    this.data[i] = v;
    this.total += v;
    this.index = (i + 1) % this.data.length;
    return this;
  }

  get mean() {
    return this.filled === 0 ? 0 : this.total / this.filled;
  }

  reset() {
    this.data.fill(0);
    this.index = 0;
    this.filled = 0;
    this.total = 0;
  }
}

export function createPanner(actx, options = {}) {
  const {
    refDistance = 6, rolloffFactor = 1.25, maxDistance = 520,
    coneInner = 360, coneOuter = 360, coneOuterGain = 0.4, panningModel = 'equalpower',
  } = options;
  const p = actx.createPanner();
  p.panningModel = panningModel;
  p.distanceModel = 'inverse';
  p.refDistance = refDistance;
  p.rolloffFactor = rolloffFactor;
  p.maxDistance = maxDistance;
  p.coneInnerAngle = coneInner;
  p.coneOuterAngle = coneOuter;
  p.coneOuterGain = coneOuterGain;
  return p;
}

/** Panner placement across both the AudioParam and the deprecated setter APIs. */
export function setPannerPosition(panner, x, y, z, when, tau = 0.02) {
  if (panner.positionX) {
    setParam(panner.positionX, x, when, tau, 0.01);
    setParam(panner.positionY, y, when, tau, 0.01);
    setParam(panner.positionZ, z, when, tau, 0.01);
  } else {
    panner.setPosition(x, y, z);
  }
}

export function setListenerPose(listener, px, py, pz, fx, fy, fz, ux, uy, uz, when) {
  if (listener.positionX) {
    setParam(listener.positionX, px, when, 0.015, 0.01);
    setParam(listener.positionY, py, when, 0.015, 0.01);
    setParam(listener.positionZ, pz, when, 0.015, 0.01);
    setParam(listener.forwardX, fx, when, 0.015, 0.002);
    setParam(listener.forwardY, fy, when, 0.015, 0.002);
    setParam(listener.forwardZ, fz, when, 0.015, 0.002);
    setParam(listener.upX, ux, when, 0.015, 0.002);
    setParam(listener.upY, uy, when, 0.015, 0.002);
    setParam(listener.upZ, uz, when, 0.015, 0.002);
  } else {
    listener.setPosition(px, py, pz);
    listener.setOrientation(fx, fy, fz, ux, uy, uz);
  }
}

/**
 * Doppler ratio for a source at `dir` (unit, listener -> source) with the given radial
 * velocities. Clamped hard: an F1 car closing at 90 m/s would otherwise shift a passing
 * engine by a musical fourth and sound like a cartoon.
 */
export function dopplerRatio(listenerRadial, sourceRadial) {
  const num = SPEED_OF_SOUND + listenerRadial;
  const den = SPEED_OF_SOUND + sourceRadial;
  if (den <= 1) return 1.6;
  return clamp(num / den, 0.62, 1.62);
}

export function disconnectAll(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    try {
      nodes[i].disconnect();
    } catch {
      /* already detached */
    }
  }
}

export { TWO_PI };
