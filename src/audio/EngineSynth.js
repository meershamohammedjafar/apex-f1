import { clamp, clamp01 } from "../core/MathUtils.js";
import { Rng } from "../core/Rng.js";
import {
  biquad,
  chain,
  createSaturationCurve,
  createUnipolarCurve,
  disconnectAll,
  envBurst,
  gainNode,
  looper,
  oscillator,
  setParam,
  shaperNode,
  startSource,
  stopSource
} from "./DSP.js";
const FULL_ANCHORS = [3e3, 6200, 9200, 12e3, 14600];
const LITE_ANCHORS = [4200, 9600, 14400];
const FULL_HARMONICS = 72;
const LITE_HARMONICS = 30;
const IDLE_RPM = 4200;
const LIMITER_RPM = 15e3;
const RPM_SPAN = LIMITER_RPM - 1e3;
const INTAKE_ORDER = 6;
const MGUK_ORDER = 24;
const MGUK_ORDER_2 = 36;
const LIMITER_CUT_HZ = 33;
const WASTEGATE_FLUTTER_HZ = 44;
const DEFAULT_UPSHIFT_CUT_SECONDS = 0.04;
const DEFAULT_DOWNSHIFT_CUT_SECONDS = 0.055;
const UPSHIFT_GATE_FLOOR = 0.1;
const DOWNSHIFT_GATE_FLOOR = 0.24;
const SHIFT_GATE_DIP_FRACTION = 0.4;
const VOICE_SILENCE_RAMP_SECONDS = 4e-3;
const TWO_PI = Math.PI * 2;
function logBump(f, fc, bw, amount) {
  const x = Math.log(f / fc) / bw;
  return 1 + amount * Math.exp(-0.5 * x * x);
}
function spectralShape(f, rpmN) {
  let g = logBump(f, 760, 0.55, 1.55 + rpmN * 0.85);
  g *= logBump(f, 2380, 0.42, 0.95 + rpmN * 2.7);
  g *= logBump(f, 4600, 0.36, 0.25 + rpmN * 1.55);
  g *= 1 / (1 + Math.pow(95 / f, 2.4));
  return g;
}
function buildTable(actx, anchorRpm, count, rng) {
  const real = new Float32Array(count + 1);
  const imag = new Float32Array(count + 1);
  const rpmN = clamp01((anchorRpm - 2200) / 12500);
  const rolloff = 2.42 - 1.32 * rpmN;
  const f0 = anchorRpm / 120;
  for (let n = 1; n <= count; n++) {
    const order = n * 0.5;
    let a = Math.pow(order, -rolloff);
    if (n % 6 === 0) a *= 2.55 + 1.85 * rpmN;
    else if (n % 3 === 0) a *= 0.58 + 0.3 * rpmN;
    else if (n % 2 === 0) a *= 0.24;
    else a *= 0.13;
    const f = f0 * n;
    a *= spectralShape(f, rpmN);
    a *= 1 + 0.17 * rng.signed(1);
    if (f > 10500) a *= Math.exp(-(f - 10500) / 3800);
    const phase = TWO_PI * (0.31 * n + 0.0415 * n * n) + rng.signed(0.4);
    real[n] = a * Math.cos(phase);
    imag[n] = a * Math.sin(phase);
  }
  return actx.createPeriodicWave(real, imag, { disableNormalization: false });
}
export class EngineSynth {
  constructor(actx, options = {}) {
    const {
      detail = "full",
      noise,
      seed = 1265,
      gain = 1,
      upshiftCutSeconds = DEFAULT_UPSHIFT_CUT_SECONDS,
      downshiftCutSeconds = DEFAULT_DOWNSHIFT_CUT_SECONDS
    } = options;
    this._upshiftCut = upshiftCutSeconds;
    this._downshiftCut = downshiftCutSeconds;
    this.actx = actx;
    this.detail = detail;
    this.full = detail === "full";
    this.noise = noise;
    this.rng = new Rng(seed);
    this._nodes = [];
    this._sources = [];
    this._disposed = false;
    this._anchors = this.full ? FULL_ANCHORS : LITE_ANCHORS;
    this._tableGains = [];
    this._weights = new Float32Array(this._anchors.length);
    this._crackleTimer = 0;
    this._prevThrottle = 0;
    this._prevRpm = IDLE_RPM;
    this._popsPending = 0;
    this._popTimer = 0;
    this._doppler = 1;
    this.output = gainNode(actx, gain);
    this._track(this.output);
    this._buildCore();
    if (this.full) this._buildLayers();
  }
  _track(node) {
    this._nodes.push(node);
    return node;
  }
  _source(node) {
    this._sources.push(node);
    this._nodes.push(node);
    return node;
  }
  _buildCore() {
    const actx = this.actx;
    const count = this.full ? FULL_HARMONICS : LITE_HARMONICS;
    this._freq = this._source(actx.createConstantSource());
    this._freq.offset.value = IDLE_RPM / 120;
    this._exhaustSum = this._track(gainNode(actx, 1));
    for (let i = 0; i < this._anchors.length; i++) {
      const osc = this._source(oscillator(actx, "sine"));
      osc.setPeriodicWave(buildTable(actx, this._anchors[i], count, this.rng));
      osc.frequency.value = 0;
      this._freq.connect(osc.frequency);
      const g = this._track(gainNode(actx, i === 0 ? 1 : 0));
      osc.connect(g).connect(this._exhaustSum);
      this._tableGains.push(g);
    }
    this._drive = this._track(gainNode(actx, 0.9));
    this._sat = this._track(shaperNode(
      actx,
      createSaturationCurve(this.full ? 2.6 : 1.9),
      this.full ? "2x" : "none"
    ));
    this._satTrim = this._track(gainNode(actx, 0.5));
    if (this.full) {
      this._hollow = this._track(biquad(actx, "peaking", 540, 1.1, 0));
      this._body = this._track(biquad(actx, "peaking", 210, 0.9, 4.5));
      this._tone = this._track(biquad(actx, "lowpass", 7e3, 0.72));
      chain([
        this._exhaustSum,
        this._drive,
        this._sat,
        this._satTrim,
        this._body,
        this._hollow,
        this._tone
      ]);
      this._exhaustGain = this._track(gainNode(actx, 0));
      this._tone.connect(this._exhaustGain);
    } else {
      this._tone = this._track(biquad(actx, "lowpass", 5200, 0.7));
      chain([this._exhaustSum, this._drive, this._sat, this._satTrim, this._tone]);
      this._exhaustGain = this._track(gainNode(actx, 0));
      this._tone.connect(this._exhaustGain);
    }
    this._bus = this._track(gainNode(actx, 1));
    this._exhaustGain.connect(this._bus);
    this._rumbleCut = this._track(biquad(actx, "highpass", 52, 0.6));
    this._intakeSrc = this._source(looper(actx, this.noise.pink, 1, 0.31));
    this._intakeBp = this._track(biquad(actx, "bandpass", 140, this.full ? 9 : 5));
    this._intakeTrack = this._track(gainNode(actx, INTAKE_ORDER));
    this._freq.connect(this._intakeTrack).connect(this._intakeBp.frequency);
    this._intakeGain = this._track(gainNode(actx, 0));
    if (this.full) {
      this._intakePeak = this._track(biquad(actx, "peaking", 2100, 1.4, 5));
      chain([this._intakeSrc, this._intakeBp, this._intakePeak, this._intakeGain, this._bus]);
    } else {
      chain([this._intakeSrc, this._intakeBp, this._intakeGain, this._bus]);
    }
    this._muffle = this._track(biquad(actx, "lowpass", 2e4, 0.6));
    this._bus.connect(this._rumbleCut).connect(this._muffle);
    if (this.full) {
      this._limGate = this._track(gainNode(actx, 1));
      this._shiftGate = this._track(gainNode(actx, 1));
      chain([this._muffle, this._limGate, this._shiftGate, this.output]);
    } else {
      this._muffle.connect(this.output);
    }
  }
  _buildLayers() {
    const actx = this.actx;
    this._turboOsc = this._source(oscillator(actx, "sine", 1400));
    this._turboOscGain = this._track(gainNode(actx, 0));
    this._turboSrc = this._source(looper(actx, this.noise.white, 1, 0.77));
    this._turboBp = this._track(biquad(actx, "bandpass", 3200, 14));
    this._turboNoiseGain = this._track(gainNode(actx, 0));
    this._turboSum = this._track(gainNode(actx, 1));
    this._turboOsc.connect(this._turboOscGain).connect(this._turboSum);
    chain([this._turboSrc, this._turboBp, this._turboNoiseGain, this._turboSum]);
    this._turboSum.connect(this._bus);
    this._wgSrc = this._source(looper(actx, this.noise.white, 1, 1.4));
    this._wgBp = this._track(biquad(actx, "bandpass", 2600, 5.5));
    this._wgFlutter = this._track(gainNode(actx, 0.35));
    this._wgGain = this._track(gainNode(actx, 0));
    chain([this._wgSrc, this._wgBp, this._wgFlutter, this._wgGain, this._bus]);
    this._wgLfo = this._source(oscillator(actx, "square", WASTEGATE_FLUTTER_HZ));
    this._wgUni = this._track(shaperNode(actx, createUnipolarCurve()));
    this._wgDepth = this._track(gainNode(actx, 0.6));
    chain([this._wgLfo, this._wgUni, this._wgDepth, this._wgFlutter.gain]);
    this._crackSrc = this._source(looper(actx, this.noise.white, 1, 2.05));
    this._crackBp = this._track(biquad(actx, "bandpass", 2200, 1.6));
    this._crackSat = this._track(shaperNode(actx, createSaturationCurve(5.5)));
    this._crackGain = this._track(gainNode(actx, 0));
    chain([this._crackSrc, this._crackBp, this._crackSat, this._crackGain, this._bus]);
    this._clackSrc = this._source(looper(actx, this.noise.white, 1, 0.09));
    this._clackBp = this._track(biquad(actx, "bandpass", 3400, 2.2));
    this._clackHp = this._track(biquad(actx, "highpass", 900, 0.7));
    this._clackGain = this._track(gainNode(actx, 0));
    chain([this._clackSrc, this._clackBp, this._clackHp, this._clackGain, this._bus]);
    this._mgukA = this._source(oscillator(actx, "sine"));
    this._mgukB = this._source(oscillator(actx, "sine"));
    this._mgukA.frequency.value = 0;
    this._mgukB.frequency.value = 0;
    this._mgukTrackA = this._track(gainNode(actx, MGUK_ORDER));
    this._mgukTrackB = this._track(gainNode(actx, MGUK_ORDER_2));
    this._freq.connect(this._mgukTrackA).connect(this._mgukA.frequency);
    this._freq.connect(this._mgukTrackB).connect(this._mgukB.frequency);
    this._mgukMix = this._track(gainNode(actx, 1));
    this._mgukBGain = this._track(gainNode(actx, 0.45));
    this._mgukA.connect(this._mgukMix);
    this._mgukB.connect(this._mgukBGain).connect(this._mgukMix);
    this._mgukGain = this._track(gainNode(actx, 0));
    chain([this._mgukMix, this._mgukGain, this._bus]);
    this._limLfo = this._source(oscillator(actx, "square", LIMITER_CUT_HZ));
    this._limUni = this._track(shaperNode(actx, createUnipolarCurve()));
    this._limDepth = this._track(gainNode(actx, 0));
    chain([this._limLfo, this._limUni, this._limDepth, this._limGate.gain]);
  }
  start(when = 0) {
    for (let i = 0; i < this._sources.length; i++) startSource(this._sources[i], when);
  }
  setGain(v, when = 0, tau = 0.05) {
    setParam(this.output.gain, Math.max(0, v), when, tau, 1e-4);
  }
  setMuffle(cutoffHz, when = 0) {
    setParam(this._muffle.frequency, clamp(cutoffHz, 300, 2e4), when, 0.06, 8);
  }
  update(now, dt, s, doppler = 1) {
    if (this._disposed) return;
    const rpm = clamp(s.rpm, 900, 15800);
    const rpmN = clamp01((rpm - 1e3) / RPM_SPAN);
    const throttle = clamp01(s.throttle);
    const brake = clamp01(s.brake);
    this._doppler = doppler;
    setParam(this._freq.offset, rpm / 120 * doppler, now, 0.012, 0.05);
    this._updateTables(now, rpm);
    const loud = 0.1 + 0.9 * Math.pow(rpmN, 0.72);
    const loadGain = 0.34 + 0.66 * throttle;
    setParam(this._exhaustGain.gain, loud * loadGain * 0.85, now, 0.025, 5e-4);
    setParam(this._drive.gain, 0.42 + 1.65 * throttle, now, 0.04, 3e-3);
    const toneHz = this.full ? 1500 + 9200 * throttle + 3600 * rpmN : 1300 + 4200 * throttle + 2600 * rpmN;
    setParam(this._tone.frequency, toneHz * doppler, now, 0.05, 15);
    const intake = Math.pow(throttle, 1.15) * (0.22 + 0.78 * rpmN);
    setParam(this._intakeGain.gain, intake * (this.full ? 0.42 : 0.3), now, 0.035, 5e-4);
    if (!this.full) {
      this._prevThrottle = throttle;
      this._prevRpm = rpm;
      return;
    }
    setParam(this._hollow.gain, -9.5 * (1 - throttle) * (0.4 + 0.6 * rpmN), now, 0.05, 0.05);
    setParam(this._body.gain, 3 + 3 * throttle, now, 0.05, 0.05);
    this._updateTurbo(now, s, rpmN, throttle);
    this._updateHybrid(now, s, rpmN);
    this._updateCrackle(now, dt, s, rpmN, throttle, brake);
    const dThr = (throttle - this._prevThrottle) / Math.max(dt, 1e-4);
    if (dThr < -3.5 && s.boost > 0.28 && rpmN > 0.35) {
      this._wgLfo.frequency.setValueAtTime(
        WASTEGATE_FLUTTER_HZ * this.rng.range(0.78, 1.28),
        now
      );
      envBurst(
        this._wgGain.gain,
        now + 4e-3,
        0.16 * s.boost * (0.5 + 0.5 * rpmN),
        0.01,
        0.2 + 0.18 * s.boost
      );
    }
    const limiting = s.limiterActive || rpm > LIMITER_RPM - 40;
    setParam(this._limDepth.gain, limiting ? -0.82 : 0, now, limiting ? 4e-3 : 0.02, 0.01);
    this._prevThrottle = throttle;
    this._prevRpm = rpm;
  }
  _updateTables(now, rpm) {
    const anchors = this._anchors;
    const last = anchors.length - 1;
    let seg = 0;
    while (seg < last - 1 && rpm > anchors[seg + 1]) seg++;
    const a = anchors[seg];
    const b = anchors[seg + 1];
    const t = clamp01((rpm - a) / (b - a));
    const wHi = Math.sin(t * Math.PI * 0.5);
    const wLo = Math.cos(t * Math.PI * 0.5);
    for (let i = 0; i <= last; i++) {
      const w = i === seg ? wLo : i === seg + 1 ? wHi : 0;
      const g = this._tableGains[i];
      if (w === 0) setParam(g.gain, 0, now, 0.03, 1e-3);
      else setParam(g.gain, w, now, 0.02, 1e-3);
    }
  }
  _updateTurbo(now, s, rpmN, throttle) {
    const boost = clamp01(s.boost ?? 0);
    const whistle = (1150 + boost * 3900 + rpmN * 2700) * this._doppler;
    setParam(this._turboOsc.frequency, whistle, now, 0.06, 4);
    setParam(this._turboBp.frequency, whistle * 1.35, now, 0.06, 6);
    const spool = Math.pow(boost, 1.6) * (0.25 + 0.75 * throttle);
    setParam(this._turboOscGain.gain, spool * 0.055, now, 0.06, 2e-4);
    setParam(this._turboNoiseGain.gain, spool * 0.1 + boost * 0.02, now, 0.06, 2e-4);
  }
  _updateHybrid(now, s, rpmN) {
    const ers = s.ers;
    const deploy = ers ? clamp01(ers.deploy) : 0;
    const harvest = ers ? clamp01(Math.abs(ers.harvestMGUK) / 12e4) : 0;
    const level = (deploy * 0.85 + harvest * 0.45) * (0.35 + 0.65 * rpmN);
    setParam(this._mgukGain.gain, level * 0.075, now, 0.05, 2e-4);
  }
  _updateCrackle(now, dt, s, rpmN, throttle, brake) {
    const off = 1 - throttle;
    const limiting = s.limiterActive || s.rpm > LIMITER_RPM - 40;
    let rate = off * rpmN * (0.25 + 1.05 * brake) * 34;
    if (limiting) rate += 26;
    if (this._popsPending > 0) {
      this._popTimer -= dt;
      if (this._popTimer <= 0) {
        this._popsPending--;
        this._popTimer = this.rng.range(0.028, 0.085);
        this._fireCrackle(now, this.rng.range(0.22, 0.55));
      }
    }
    if (rate < 0.5) return;
    this._crackleTimer -= dt;
    while (this._crackleTimer <= 0) {
      this._fireCrackle(now, this.rng.range(0.06, 0.34) * (0.4 + 0.6 * rpmN));
      this._crackleTimer += -Math.log(Math.max(1e-3, this.rng.next())) / rate;
    }
  }
  _fireCrackle(now, amp) {
    const t = now + this.rng.range(2e-3, 0.012);
    this._crackBp.frequency.setValueAtTime(this.rng.range(1500, 4200), t);
    envBurst(this._crackGain.gain, t, amp, 8e-4, this.rng.range(0.012, 0.045));
  }
  shift(now, direction) {
    if (!this.full || this._disposed) return;
    const g = this._shiftGate.gain;
    const cut = direction > 0 ? this._upshiftCut : this._downshiftCut;
    const gateFloor = direction > 0 ? UPSHIFT_GATE_FLOOR : DOWNSHIFT_GATE_FLOOR;
    const held = clamp(g.value, gateFloor, 1);
    g.cancelScheduledValues(now);
    g.setValueAtTime(held, now);
    g.linearRampToValueAtTime(gateFloor, now + cut * SHIFT_GATE_DIP_FRACTION);
    g.linearRampToValueAtTime(1, now + cut);
    envBurst(this._clackGain.gain, now, direction > 0 ? 0.42 : 0.3, 6e-4, 0.03);
    this._clackBp.frequency.setValueAtTime(direction > 0 ? 3400 : 2600, now);
    if (direction < 0) {
      this._popsPending = 2 + Math.floor(this.rng.next() * 3);
      this._popTimer = 0.03;
    }
  }
  silence(now) {
    const g = this.output.gain;
    const held = Math.max(0, g.value);
    g.cancelScheduledValues(now);
    g.setValueAtTime(held, now);
    g.linearRampToValueAtTime(0, now + VOICE_SILENCE_RAMP_SECONDS);
  }
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (let i = 0; i < this._sources.length; i++) stopSource(this._sources[i]);
    disconnectAll(this._nodes);
    this._nodes.length = 0;
    this._sources.length = 0;
    this._tableGains.length = 0;
  }
}
export const ENGINE_LIMITER_RPM = LIMITER_RPM;
export const ENGINE_IDLE_RPM = IDLE_RPM;
