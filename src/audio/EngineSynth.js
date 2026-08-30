import { clamp, clamp01 } from '../core/MathUtils.js';
import { Rng } from '../core/Rng.js';
import {
  biquad, chain, createSaturationCurve, createUnipolarCurve, disconnectAll, envBurst,
  gainNode, looper, oscillator, setParam, shaperNode, startSource, stopSource,
} from './DSP.js';

/**
 * A 1.6 L V6 turbo hybrid, synthesised.
 *
 * The core is a wave-table stack. A four-stroke six fires three times per crank
 * revolution, so the firing frequency is rpm/20 Hz — 200 Hz at 4000 rpm, 750 Hz at the
 * 15 000 rpm limiter. The oscillators run at the *half order* (rpm/120) so that the
 * harmonic index n maps to engine order n/2 and the table can carry the half-order
 * content a V6 has from bank-to-bank asymmetry as well as the integer orders. Order 3
 * and its multiples (n = 6, 12, 18 ...) are the firing orders and dominate; the half
 * orders sit underneath at about a third of the level and are what stops the result
 * sounding like a sawtooth.
 *
 * The scream, as opposed to a drone, comes from two things: the spectral tilt flattens
 * with rpm (a -2.4 dB/order rolloff at idle becomes -1.1 near the limiter, so the
 * 2-4 kHz orders survive), and a fixed formant chain models the 3-into-1 collector at
 * ~760 Hz and the tailpipe at ~2.4 kHz. Since the timbre between 4000 and 15 000 rpm is
 * a different instrument rather than a transposition, five tables are computed at rpm
 * anchors and equal-power crossfaded; only two are ever audible at once.
 *
 * Around that: resonant intake honk, turbo spool tracking boost, wastegate flutter on
 * lift, MGU-K whine gated by ERS deployment, randomised overrun crackle, a gear-cut
 * gate, and a hard stutter on the limiter.
 *
 * One ConstantSourceNode carries the crank frequency into every oscillator and every
 * rpm-tracking filter, so a whole engine is one parameter write per tick.
 */

const FULL_ANCHORS = [3000, 6200, 9200, 12000, 14600];
const LITE_ANCHORS = [4200, 9600, 14400];
const FULL_HARMONICS = 72;
const LITE_HARMONICS = 30;

const IDLE_RPM = 4200;
const LIMITER_RPM = 15000;
const RPM_SPAN = LIMITER_RPM - 1000;

const INTAKE_ORDER = 6;      // intake plenum resonance tracks the firing order
const MGUK_ORDER = 24;       // MGU-K step-up gearing puts its whine at order 12
const MGUK_ORDER_2 = 36;

const LIMITER_CUT_HZ = 33;   // soft-cut cycles fast enough to read as a stutter, not a wobble
const WASTEGATE_FLUTTER_HZ = 44;

const TWO_PI = Math.PI * 2;

/** Log-domain resonance bump; `bw` is the half-width in nepers of log-frequency. */
function logBump(f, fc, bw, amount) {
  const x = Math.log(f / fc) / bw;
  return 1 + amount * Math.exp(-0.5 * x * x);
}

/**
 * Fixed acoustic path of the exhaust: collector, tailpipe, and the upper edge that only
 * opens up once the engine is spinning hard enough to excite it.
 */
function spectralShape(f, rpmN) {
  let g = logBump(f, 760, 0.55, 1.55 + rpmN * 0.85);
  g *= logBump(f, 2380, 0.42, 0.95 + rpmN * 2.7);
  g *= logBump(f, 4600, 0.36, 0.25 + rpmN * 1.55);
  g *= 1 / (1 + Math.pow(95 / f, 2.4));
  return g;
}

/**
 * One wave table for a given rpm anchor. Phases follow a quadratic chirp rather than
 * being aligned or fully random: aligned phases give a buzzy impulse train with a huge
 * crest factor, random phases smear the firing pulses into noise, and the chirp keeps a
 * recognisable pulse per firing event while spreading the peak energy.
 */
function buildTable(actx, anchorRpm, count, rng) {
  const real = new Float32Array(count + 1);
  const imag = new Float32Array(count + 1);
  const rpmN = clamp01((anchorRpm - 2200) / 12500);
  const rolloff = 2.42 - 1.32 * rpmN;
  const f0 = anchorRpm / 120;

  for (let n = 1; n <= count; n++) {
    const order = n * 0.5;
    let a = Math.pow(order, -rolloff);

    if (n % 6 === 0) a *= 2.55 + 1.85 * rpmN;         // firing order 3, 6, 9 ...
    else if (n % 3 === 0) a *= 0.58 + 0.30 * rpmN;    // 1.5, 4.5 ... bank asymmetry
    else if (n % 2 === 0) a *= 0.24;                  // crank and valvetrain orders
    else a *= 0.13;                                   // mechanical grit between them

    const f = f0 * n;
    a *= spectralShape(f, rpmN);
    a *= 1 + 0.17 * rng.signed(1);                    // cylinder-to-cylinder variance
    if (f > 10500) a *= Math.exp(-(f - 10500) / 3800);

    const phase = TWO_PI * (0.31 * n + 0.0415 * n * n) + rng.signed(0.4);
    real[n] = a * Math.cos(phase);
    imag[n] = a * Math.sin(phase);
  }

  return actx.createPeriodicWave(real, imag, { disableNormalization: false });
}

export class EngineSynth {
  /**
   * @param {BaseAudioContext} actx
   * @param {object} options
   *   detail  'full' for the player car, 'lite' for AI voices (about a quarter the nodes)
   *   noise   shared NoiseBank { white, pink, brown, sparse }
   *   seed    per-car seed so two cars never phase-lock into a flanger
   */
  constructor(actx, options = {}) {
    const {
      detail = 'full', noise, seed = 0x4f1, gain = 1,
    } = options;

    this.actx = actx;
    this.detail = detail;
    this.full = detail === 'full';
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

    // The single frequency driver. Every oscillator sits at 0 Hz intrinsic and is
    // summed with this, so rpm is one AudioParam write for the entire engine.
    this._freq = this._source(actx.createConstantSource());
    this._freq.offset.value = IDLE_RPM / 120;

    this._exhaustSum = this._track(gainNode(actx, 1));

    for (let i = 0; i < this._anchors.length; i++) {
      const osc = this._source(oscillator(actx, 'sine'));
      osc.setPeriodicWave(buildTable(actx, this._anchors[i], count, this.rng));
      osc.frequency.value = 0;
      this._freq.connect(osc.frequency);
      const g = this._track(gainNode(actx, i === 0 ? 1 : 0));
      osc.connect(g).connect(this._exhaustSum);
      this._tableGains.push(g);
    }

    this._drive = this._track(gainNode(actx, 0.9));
    this._sat = this._track(shaperNode(actx, createSaturationCurve(this.full ? 2.6 : 1.9),
      this.full ? '2x' : 'none'));
    this._satTrim = this._track(gainNode(actx, 0.5));

    if (this.full) {
      // A negative peaking band that opens on the overrun: closing the throttle plates
      // pulls the midrange out and leaves the hollow, papery note behind.
      this._hollow = this._track(biquad(actx, 'peaking', 540, 1.1, 0));
      this._body = this._track(biquad(actx, 'peaking', 210, 0.9, 4.5));
      this._tone = this._track(biquad(actx, 'lowpass', 7000, 0.72));
      chain([this._exhaustSum, this._drive, this._sat, this._satTrim, this._body,
        this._hollow, this._tone]);
      this._exhaustGain = this._track(gainNode(actx, 0));
      this._tone.connect(this._exhaustGain);
    } else {
      this._tone = this._track(biquad(actx, 'lowpass', 5200, 0.7));
      chain([this._exhaustSum, this._drive, this._sat, this._satTrim, this._tone]);
      this._exhaustGain = this._track(gainNode(actx, 0));
      this._tone.connect(this._exhaustGain);
    }

    this._bus = this._track(gainNode(actx, 1));
    this._exhaustGain.connect(this._bus);

    // The half and first orders land at 25-60 Hz down at idle. That is real content in a
    // real engine bay and completely unreproducible on anything the game will be played
    // through, so it is cut rather than left to eat headroom in the master compressor.
    this._rumbleCut = this._track(biquad(actx, 'highpass', 52, 0.6));

    // Intake honk: noise through a high-Q band that rides the firing order. Present on
    // AI voices too — without it a distant car is a pure tone and reads as synthetic.
    this._intakeSrc = this._source(looper(actx, this.noise.pink, 1, 0.31));
    this._intakeBp = this._track(biquad(actx, 'bandpass', 140, this.full ? 9 : 5));
    this._intakeTrack = this._track(gainNode(actx, INTAKE_ORDER));
    this._freq.connect(this._intakeTrack).connect(this._intakeBp.frequency);
    this._intakeGain = this._track(gainNode(actx, 0));
    if (this.full) {
      this._intakePeak = this._track(biquad(actx, 'peaking', 2100, 1.4, 5));
      chain([this._intakeSrc, this._intakeBp, this._intakePeak, this._intakeGain, this._bus]);
    } else {
      chain([this._intakeSrc, this._intakeBp, this._intakeGain, this._bus]);
    }

    // Per-voice muffle. Distance and the barriers between you and a car eat the top end
    // long before they eat the level; this is what makes a car three corners away sound
    // three corners away rather than just quiet.
    this._muffle = this._track(biquad(actx, 'lowpass', 20000, 0.6));
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

    // Turbo: a whistle at the compressor's audible order plus the broadband rush of air
    // through the intercooler, both driven by boost rather than rpm.
    this._turboOsc = this._source(oscillator(actx, 'sine', 1400));
    this._turboOscGain = this._track(gainNode(actx, 0));
    this._turboSrc = this._source(looper(actx, this.noise.white, 1, 0.77));
    this._turboBp = this._track(biquad(actx, 'bandpass', 3200, 14));
    this._turboNoiseGain = this._track(gainNode(actx, 0));
    this._turboSum = this._track(gainNode(actx, 1));
    this._turboOsc.connect(this._turboOscGain).connect(this._turboSum);
    chain([this._turboSrc, this._turboBp, this._turboNoiseGain, this._turboSum]);
    this._turboSum.connect(this._bus);

    // Wastegate flutter: a band of noise chopped by a square LFO. The LFO runs forever
    // and the burst is one scheduled envelope, so a lift costs no allocation.
    this._wgSrc = this._source(looper(actx, this.noise.white, 1, 1.4));
    this._wgBp = this._track(biquad(actx, 'bandpass', 2600, 5.5));
    this._wgFlutter = this._track(gainNode(actx, 0.35));
    this._wgGain = this._track(gainNode(actx, 0));
    chain([this._wgSrc, this._wgBp, this._wgFlutter, this._wgGain, this._bus]);
    this._wgLfo = this._source(oscillator(actx, 'square', WASTEGATE_FLUTTER_HZ));
    this._wgUni = this._track(shaperNode(actx, createUnipolarCurve()));
    this._wgDepth = this._track(gainNode(actx, 0.6));
    chain([this._wgLfo, this._wgUni, this._wgDepth, this._wgFlutter.gain]);

    // Overrun crackle: unburnt fuel lighting in the hot exhaust. Bursts are scheduled
    // from a Poisson-ish timer whose rate follows rpm and how hard you are off the gas.
    this._crackSrc = this._source(looper(actx, this.noise.white, 1, 2.05));
    this._crackBp = this._track(biquad(actx, 'bandpass', 2200, 1.6));
    this._crackSat = this._track(shaperNode(actx, createSaturationCurve(5.5)));
    this._crackGain = this._track(gainNode(actx, 0));
    chain([this._crackSrc, this._crackBp, this._crackSat, this._crackGain, this._bus]);

    // Gearshift transient: the dog ring engaging is a hard, dry click, not a tone.
    this._clackSrc = this._source(looper(actx, this.noise.white, 1, 0.09));
    this._clackBp = this._track(biquad(actx, 'bandpass', 3400, 2.2));
    this._clackHp = this._track(biquad(actx, 'highpass', 900, 0.7));
    this._clackGain = this._track(gainNode(actx, 0));
    chain([this._clackSrc, this._clackBp, this._clackHp, this._clackGain, this._bus]);

    // MGU-K: two partials an order apart beat against each other into the electric
    // warble you hear when the deployment comes in out of a slow corner.
    this._mgukA = this._source(oscillator(actx, 'sine'));
    this._mgukB = this._source(oscillator(actx, 'sine'));
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

    // Limiter stutter. A square LFO drives the gate's gain by summation: depth 0 leaves
    // the gate wide open, depth -0.82 chops it to 18% at 33 Hz.
    this._limLfo = this._source(oscillator(actx, 'square', LIMITER_CUT_HZ));
    this._limUni = this._track(shaperNode(actx, createUnipolarCurve()));
    this._limDepth = this._track(gainNode(actx, 0));
    chain([this._limLfo, this._limUni, this._limDepth, this._limGate.gain]);
  }

  start(when = 0) {
    for (let i = 0; i < this._sources.length; i++) startSource(this._sources[i], when);
  }

  /** Master level for this voice, before distance attenuation. */
  setGain(v, when = 0, tau = 0.05) {
    setParam(this.output.gain, Math.max(0, v), when, tau, 1e-4);
  }

  /** Air absorption / occlusion cutoff in Hz. */
  setMuffle(cutoffHz, when = 0) {
    setParam(this._muffle.frequency, clamp(cutoffHz, 300, 20000), when, 0.06, 8);
  }

  /**
   * Advance the whole engine from a VehiclePhysics state. Allocation-free; every branch
   * writes at most a handful of already-existing AudioParams.
   */
  update(now, dt, s, doppler = 1) {
    if (this._disposed) return;

    const rpm = clamp(s.rpm, 900, 15800);
    const rpmN = clamp01((rpm - 1000) / RPM_SPAN);
    const throttle = clamp01(s.throttle);
    const brake = clamp01(s.brake);
    this._doppler = doppler;

    setParam(this._freq.offset, (rpm / 120) * doppler, now, 0.012, 0.05);

    this._updateTables(now, rpm);

    // Level: an F1 engine at 15 000 rpm is roughly 20 dB above idle, and closing the
    // throttle drops it another 8 dB without changing the pitch.
    const loud = 0.10 + 0.90 * Math.pow(rpmN, 0.72);
    const loadGain = 0.34 + 0.66 * throttle;
    setParam(this._exhaustGain.gain, loud * loadGain * 0.85, now, 0.025, 5e-4);

    setParam(this._drive.gain, 0.42 + 1.65 * throttle, now, 0.04, 3e-3);

    const toneHz = this.full
      ? 1500 + 9200 * throttle + 3600 * rpmN
      : 1300 + 4200 * throttle + 2600 * rpmN;
    setParam(this._tone.frequency, toneHz * doppler, now, 0.05, 15);

    const intake = Math.pow(throttle, 1.15) * (0.22 + 0.78 * rpmN);
    setParam(this._intakeGain.gain, intake * (this.full ? 0.42 : 0.30), now, 0.035, 5e-4);

    if (!this.full) {
      this._prevThrottle = throttle;
      this._prevRpm = rpm;
      return;
    }

    setParam(this._hollow.gain, -9.5 * (1 - throttle) * (0.4 + 0.6 * rpmN), now, 0.05, 0.05);
    setParam(this._body.gain, 3.0 + 3.0 * throttle, now, 0.05, 0.05);

    this._updateTurbo(now, s, rpmN, throttle);
    this._updateHybrid(now, s, rpmN);
    this._updateCrackle(now, dt, s, rpmN, throttle, brake);

    // Lift off boost and the wastegate dumps. Threshold on the throttle *derivative* so
    // a gentle roll-out does not chatter.
    const dThr = (throttle - this._prevThrottle) / Math.max(dt, 1e-4);
    if (dThr < -3.5 && s.boost > 0.28 && rpmN > 0.35) {
      this._wgLfo.frequency.setValueAtTime(
        WASTEGATE_FLUTTER_HZ * this.rng.range(0.78, 1.28), now,
      );
      envBurst(this._wgGain.gain, now + 0.004,
        0.16 * s.boost * (0.5 + 0.5 * rpmN), 0.010, 0.20 + 0.18 * s.boost);
    }

    const limiting = s.limiterActive || rpm > LIMITER_RPM - 40;
    setParam(this._limDepth.gain, limiting ? -0.82 : 0, now, limiting ? 0.004 : 0.02, 0.01);

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
    // Equal power, so the crossfade does not dip in the middle of a rev sweep.
    const wHi = Math.sin(t * Math.PI * 0.5);
    const wLo = Math.cos(t * Math.PI * 0.5);

    for (let i = 0; i <= last; i++) {
      const w = i === seg ? wLo : i === seg + 1 ? wHi : 0;
      const g = this._tableGains[i];
      // Silent tables get an immediate zero: a lingering tail from a table three anchors
      // away is exactly the muddy "one sample stretched over the rev range" artefact
      // this whole approach exists to avoid.
      if (w === 0) setParam(g.gain, 0, now, 0.03, 1e-3);
      else setParam(g.gain, w, now, 0.02, 1e-3);
    }
  }

  _updateTurbo(now, s, rpmN, throttle) {
    const boost = clamp01(s.boost ?? 0);
    // Compressor whine climbs with shaft speed, which tracks boost far more than rpm.
    const whistle = (1150 + boost * 3900 + rpmN * 2700) * this._doppler;
    setParam(this._turboOsc.frequency, whistle, now, 0.06, 4);
    setParam(this._turboBp.frequency, whistle * 1.35, now, 0.06, 6);
    const spool = Math.pow(boost, 1.6) * (0.25 + 0.75 * throttle);
    setParam(this._turboOscGain.gain, spool * 0.055, now, 0.06, 2e-4);
    setParam(this._turboNoiseGain.gain, spool * 0.10 + boost * 0.02, now, 0.06, 2e-4);
  }

  _updateHybrid(now, s, rpmN) {
    const ers = s.ers;
    const deploy = ers ? clamp01(ers.deploy) : 0;
    // Harvest is in watts on the crank; 120 kW is the MGU-K's regulation ceiling.
    const harvest = ers ? clamp01(Math.abs(ers.harvestMGUK) / 120000) : 0;
    const level = (deploy * 0.85 + harvest * 0.45) * (0.35 + 0.65 * rpmN);
    setParam(this._mgukGain.gain, level * 0.075, now, 0.05, 2e-4);
  }

  _updateCrackle(now, dt, s, rpmN, throttle, brake) {
    const off = 1 - throttle;
    const limiting = s.limiterActive || s.rpm > LIMITER_RPM - 40;
    // Off the gas at high rpm with the brakes on is where the exhaust actually pops.
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
      // Exponential spacing rather than a metronome; a regular tick reads as a machine
      // gun, not combustion.
      this._crackleTimer += -Math.log(Math.max(1e-3, this.rng.next())) / rate;
    }
  }

  _fireCrackle(now, amp) {
    const t = now + this.rng.range(0.002, 0.012);
    this._crackBp.frequency.setValueAtTime(this.rng.range(1500, 4200), t);
    envBurst(this._crackGain.gain, t, amp, 0.0008, this.rng.range(0.012, 0.045));
  }

  /**
   * Gear change. The physics supplies the rpm step from the ratio change; this supplies
   * the 40 ms ignition cut around it, the dog-ring transient, and — on a downshift —
   * the throttle blip's exhaust pops as the revs are matched.
   */
  shift(now, direction) {
    if (!this.full || this._disposed) return;
    const g = this._shiftGate.gain;
    const cut = 0.040;
    g.cancelScheduledValues(now);
    g.setValueAtTime(1, now);
    g.linearRampToValueAtTime(direction > 0 ? 0.07 : 0.22, now + 0.0035);
    g.setValueAtTime(direction > 0 ? 0.07 : 0.22, now + cut * 0.7);
    g.linearRampToValueAtTime(1, now + cut + 0.028);

    envBurst(this._clackGain.gain, now, direction > 0 ? 0.42 : 0.30, 0.0006, 0.030);
    this._clackBp.frequency.setValueAtTime(direction > 0 ? 3400 : 2600, now);

    if (direction < 0) {
      this._popsPending = 2 + Math.floor(this.rng.next() * 3);
      this._popTimer = 0.03;
    }
  }

  /** Silence this voice instantly — used when a pooled AI voice is rebound to a new car. */
  silence(now) {
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setValueAtTime(0, now);
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

/** Exposed so the mixer can key its ducking off the same numbers the synth uses. */
export const ENGINE_LIMITER_RPM = LIMITER_RPM;
export const ENGINE_IDLE_RPM = IDLE_RPM;
