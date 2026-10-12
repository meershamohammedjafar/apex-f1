import { clamp, clamp01 } from "../core/MathUtils.js";
import { Rng } from "../core/Rng.js";
export const SPEED_OF_SOUND = 343.2;
const TWO_PI = Math.PI * 2;
export function dbToGain(db) {
  return Math.pow(10, db * 0.05);
}
export function setParam(param, value, time, tau = 0.04, eps = 1e-3) {
  const v = param.value;
  if (v === value || Math.abs(v - value) < eps) return;
  if (tau <= 0) param.setValueAtTime(value, time);
  else param.setTargetAtTime(value, time, tau);
}
export function setParamNow(param, value, time) {
  param.setValueAtTime(value, time);
}
export function envBurst(param, time, peak, attack = 15e-4, decay = 0.08, floor = 1e-4) {
  const start = Math.max(floor, param.value);
  param.cancelScheduledValues(time);
  param.setValueAtTime(start, time);
  param.linearRampToValueAtTime(Math.max(floor, peak), time + attack);
  param.exponentialRampToValueAtTime(floor, time + attack + decay);
  param.setValueAtTime(0, time + attack + decay + 5e-4);
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
export function shaperNode(actx, curve, oversample = "none") {
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
export function startSource(src, when = 0) {
  if (src.__apexStarted) return;
  src.__apexStarted = true;
  try {
    src.start(when, src.__apexOffset ?? 0);
  } catch {
  }
}
export function stopSource(src) {
  if (!src.__apexStarted || src.__apexStopped) return;
  src.__apexStopped = true;
  try {
    src.stop();
  } catch {
  }
}
export function createSaturationCurve(drive = 2.4, n = 2048) {
  const curve = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1) * 2 - 1;
    curve[i] = Math.tanh(drive * x) / norm;
  }
  return curve;
}
export function createLimiterCurve(threshold = 0.82, n = 4096) {
  const curve = new Float32Array(n);
  const span = 1 - threshold;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= threshold ? a : threshold + span * Math.tanh((a - threshold) / span);
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}
export function createUnipolarCurve() {
  const curve = new Float32Array(2);
  curve[0] = 0;
  curve[1] = 1;
  return curve;
}
export function createPulseCurve(exponent = 8, n = 2048) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1) * 2 - 1;
    curve[i] = x <= 0 ? 0 : Math.pow(x, exponent);
  }
  return curve;
}
export function createNoiseBuffer(actx, seconds = 3, kind = "white", rng = new Rng(24301)) {
  const rate = actx.sampleRate;
  const n = Math.max(1024, Math.floor(rate * seconds));
  const buffer = actx.createBuffer(1, n, rate);
  const d = buffer.getChannelData(0);
  if (kind === "pink") {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < n; i++) {
      const w = rng.next() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  } else if (kind === "brown") {
    let last = 0;
    for (let i = 0; i < n; i++) {
      last = (last + 0.017 * (rng.next() * 2 - 1)) * 0.9985;
      d[i] = last * 12;
    }
  } else if (kind === "sparse") {
    const density = 0.014;
    for (let i = 0; i < n; i++) {
      if (rng.next() < density) {
        const a = (rng.next() * 2 - 1) * (0.35 + rng.next() * 0.65);
        d[i] = a;
        if (i + 1 < n) d[i + 1] = -a * 0.6;
      }
    }
  } else {
    for (let i = 0; i < n; i++) d[i] = rng.next() * 2 - 1;
  }
  if (kind === "pink" || kind === "brown") {
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
export function createImpulseResponse(actx, options = {}) {
  const {
    duration = 1.35,
    decay = 3.4,
    preDelay = 8e-3,
    damping = 0.55,
    diffusion = 0.75,
    width = 0.85,
    earlyGain = 0.5,
    earlyCount = 9,
    seed = 7727
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
      const a = clamp01(0.06 + damping * tn * 0.9);
      lp += a * (chanRng.next() * 2 - 1 - lp);
      const env = Math.exp(-decay * t) * (1 - tn * 0.15);
      const build = clamp01(t / (6e-3 + 0.05 * diffusion));
      d[i] = lp * env * build;
    }
    for (let e = 0; e < earlyCount; e++) {
      const tap = pre + Math.floor(rng.range(4e-3, 0.085) * rate);
      if (tap >= n) continue;
      const g = earlyGain * (1 - e / earlyCount) * (rng.next() < 0.5 ? -1 : 1);
      d[tap] += g * (ch === 0 ? 1 : 1 - width * rng.next());
    }
    if (pre > 0) d[Math.max(0, pre - 1)] += 0.12;
  }
  let energy = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < n; i++) energy += d[i] * d[i];
  }
  const norm = energy > 0 ? 1 / Math.sqrt(energy / n) : 1;
  const scale = clamp(norm * 0.045, 1e-3, 12);
  for (let ch = 0; ch < 2; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = 0; i < n; i++) d[i] *= scale;
  }
  return buffer;
}
export class RingDelay {
  constructor(actx, options = {}) {
    const {
      time = 0.14,
      feedback = 0.32,
      damping = 3600,
      mix = 0.3,
      maxTime = 1
    } = options;
    this.actx = actx;
    this.input = gainNode(actx, 1);
    this.output = gainNode(actx, 1);
    this.delay = actx.createDelay(Math.max(maxTime, time * 2));
    this.delay.delayTime.value = time;
    this.feedback = gainNode(actx, clamp01(feedback));
    this.damp = biquad(actx, "lowpass", damping, 0.5);
    this.wet = gainNode(actx, mix);
    this.dry = gainNode(actx, 1 - mix * 0.5);
    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.delay);
    this.delay.connect(this.damp).connect(this.feedback).connect(this.delay);
    this.damp.connect(this.wet).connect(this.output);
  }
  setTime(seconds, when = 0) {
    setParam(this.delay.delayTime, clamp(seconds, 1e-3, this.delay.delayTime.maxValue), when, 0.08, 1e-4);
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
    refDistance = 6,
    rolloffFactor = 1.25,
    maxDistance = 520,
    coneInner = 360,
    coneOuter = 360,
    coneOuterGain = 0.4,
    panningModel = "equalpower"
  } = options;
  const p = actx.createPanner();
  p.panningModel = panningModel;
  p.distanceModel = "inverse";
  p.refDistance = refDistance;
  p.rolloffFactor = rolloffFactor;
  p.maxDistance = maxDistance;
  p.coneInnerAngle = coneInner;
  p.coneOuterAngle = coneOuter;
  p.coneOuterGain = coneOuterGain;
  return p;
}
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
    setParam(listener.forwardX, fx, when, 0.015, 2e-3);
    setParam(listener.forwardY, fy, when, 0.015, 2e-3);
    setParam(listener.forwardZ, fz, when, 0.015, 2e-3);
    setParam(listener.upX, ux, when, 0.015, 2e-3);
    setParam(listener.upY, uy, when, 0.015, 2e-3);
    setParam(listener.upZ, uz, when, 0.015, 2e-3);
  } else {
    listener.setPosition(px, py, pz);
    listener.setOrientation(fx, fy, fz, ux, uy, uz);
  }
}
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
    }
  }
}
export { TWO_PI };
