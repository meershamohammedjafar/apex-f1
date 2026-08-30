import { clamp, clamp01, smoothstep } from '../core/MathUtils.js';
import { Rng } from '../core/Rng.js';
import {
  biquad, chain, createPulseCurve, createSaturationCurve, disconnectAll, envBurst, gainNode,
  looper, oscillator, setParam, shaperNode, startSource, stopSource,
} from './DSP.js';

/**
 * Everything the car makes through its contact patches and its springs.
 *
 * Layers, each with its own excitation model rather than a level curve:
 *  - road roar: brown noise lowpassed by speed, the level set by the surface's roughness
 *  - scrub: bandpassed noise whose centre rises with slip angle, split front/rear so
 *    understeer and oversteer sound different from the seat
 *  - lock-up squeal: a high-Q band plus a tonal partial at the tread-block resonance,
 *    pitching with the wheel's surface speed as the brief demands
 *  - wheelspin: the same idea an octave up, with the frequency riding slip ratio
 *  - kerb rumble: a sawtooth at the serration strike rate (speed / 0.42 m pitch) shaped
 *    into an impulse train, which both sounds the thumps and amplitude-modulates a noise
 *    band for the abrasive top — one oscillator instead of a hundred scheduled one-shots
 *  - gravel and grass: velvet noise and a soft swish band respectively
 *  - suspension impacts: scheduled thumps from kerb strikes and landings
 *
 * All of it is one static graph. `update` only writes parameters.
 */

const KERB_PITCH = 0.42;        // metres between kerb serrations
const MAX_SPEED = 96;           // m/s reference (~345 km/h) for normalising level curves
const SQUEAL_BASE = 620;        // Hz, tread-block resonance of an 18-inch slick at temperature

const SURFACE_ROUGHNESS = {
  asphalt: 0.35, kerb: 0.9, astroturf: 0.55, grass: 0.7, gravel: 1.0,
  concrete: 0.28, wall: 0.5,
};

export class TyreAudio {
  constructor(actx, options = {}) {
    const { noise, seed = 0x7c9e, frontRadius = 0.360, rearRadius = 0.3625 } = options;

    this.actx = actx;
    this.noise = noise;
    this.rng = new Rng(seed);
    this.frontRadius = frontRadius;
    this.rearRadius = rearRadius;

    this._nodes = [];
    this._sources = [];
    this._disposed = false;

    this._kerbCooldown = 0;
    this._prevCompression = new Float32Array(4);
    this._surfaceMix = new Float32Array(5); // asphalt, kerb, grass, gravel, astroturf

    this.output = gainNode(actx, 1);
    this._track(this.output);

    this._build();
  }

  _track(n) {
    this._nodes.push(n);
    return n;
  }

  _source(n) {
    this._sources.push(n);
    this._nodes.push(n);
    return n;
  }

  _build() {
    const actx = this.actx;
    const n = this.noise;

    // Road roar. Brown noise has the -6 dB/octave tilt that tyre carcass noise actually
    // has; the lowpass opens with speed so the surface gets brighter as it goes past.
    this._roarSrc = this._source(looper(actx, n.brown, 1, 0.11));
    this._roarLp = this._track(biquad(actx, 'lowpass', 320, 0.8));
    this._roarPeak = this._track(biquad(actx, 'peaking', 128, 1.1, 6));
    this._roarHp = this._track(biquad(actx, 'highpass', 48, 0.7));
    this._roarGain = this._track(gainNode(actx, 0));
    chain([this._roarSrc, this._roarHp, this._roarLp, this._roarPeak, this._roarGain,
      this.output]);

    // Tread grain riding on top of the roar: pink noise through a band that tracks the
    // tread pitch frequency, so the texture speeds up rather than just getting louder.
    this._grainSrc = this._source(looper(actx, n.pink, 1, 1.83));
    this._grainBp = this._track(biquad(actx, 'bandpass', 900, 1.1));
    this._grainGain = this._track(gainNode(actx, 0));
    chain([this._grainSrc, this._grainBp, this._grainGain, this.output]);

    this._scrubFront = this._makeScrub(0.53, 3.4);
    this._scrubRear = this._makeScrub(1.27, 2.6);

    // Lock-up squeal: noise through a very high Q, plus a sine at the same centre. The
    // tonal partial is what makes a lock-up cut through an engine at 12 000 rpm.
    this._squealSrc = this._source(looper(actx, n.white, 1, 0.61));
    this._squealBp = this._track(biquad(actx, 'bandpass', SQUEAL_BASE, 22));
    this._squealBp2 = this._track(biquad(actx, 'peaking', SQUEAL_BASE * 2, 8, 9));
    this._squealNoiseGain = this._track(gainNode(actx, 0));
    chain([this._squealSrc, this._squealBp, this._squealBp2, this._squealNoiseGain,
      this.output]);
    this._squealOsc = this._source(oscillator(actx, 'sine', SQUEAL_BASE));
    this._squealOscGain = this._track(gainNode(actx, 0));
    chain([this._squealOsc, this._squealOscGain, this.output]);

    // Wheelspin: brighter, wider band, and it chirps as the slip ratio breaks and grabs.
    this._spinSrc = this._source(looper(actx, n.white, 1, 2.41));
    this._spinBp = this._track(biquad(actx, 'bandpass', 1800, 7));
    this._spinSat = this._track(shaperNode(actx, createSaturationCurve(3.2)));
    this._spinGain = this._track(gainNode(actx, 0));
    chain([this._spinSrc, this._spinBp, this._spinSat, this._spinGain, this.output]);

    // Kerb impulse train.
    this._kerbOsc = this._source(oscillator(actx, 'sawtooth', 40));
    this._kerbPulse = this._track(shaperNode(actx, createPulseCurve(7), '2x'));
    this._kerbBody = this._track(biquad(actx, 'lowpass', 320, 1.4));
    this._kerbGain = this._track(gainNode(actx, 0));
    chain([this._kerbOsc, this._kerbPulse, this._kerbBody, this._kerbGain, this.output]);

    this._kerbNoiseSrc = this._source(looper(actx, n.white, 1, 1.09));
    this._kerbNoiseBp = this._track(biquad(actx, 'bandpass', 1200, 1.3));
    this._kerbAm = this._track(gainNode(actx, 0));
    this._kerbTexGain = this._track(gainNode(actx, 0));
    chain([this._kerbNoiseSrc, this._kerbNoiseBp, this._kerbAm, this._kerbTexGain,
      this.output]);
    // The same pulse train modulates the noise band, so texture and thump are locked.
    this._kerbAmDepth = this._track(gainNode(actx, 1));
    this._kerbPulse.connect(this._kerbAmDepth).connect(this._kerbAm.gain);

    // Suspension / chassis impacts: a filtered noise crack over a low sine thud.
    this._thumpSrc = this._source(looper(actx, n.white, 1, 0.29));
    this._thumpLp = this._track(biquad(actx, 'lowpass', 260, 1.1));
    this._thumpGain = this._track(gainNode(actx, 0));
    chain([this._thumpSrc, this._thumpLp, this._thumpGain, this.output]);
    this._thudOsc = this._source(oscillator(actx, 'sine', 58));
    this._thudGain = this._track(gainNode(actx, 0));
    chain([this._thudOsc, this._thudGain, this.output]);

    // Off-track surfaces.
    this._gravelSrc = this._source(looper(actx, n.sparse, 1, 0.07));
    this._gravelBp = this._track(biquad(actx, 'bandpass', 1900, 1.0));
    this._gravelSat = this._track(shaperNode(actx, createSaturationCurve(2.0)));
    this._gravelGain = this._track(gainNode(actx, 0));
    chain([this._gravelSrc, this._gravelBp, this._gravelSat, this._gravelGain, this.output]);

    this._grassSrc = this._source(looper(actx, n.pink, 1, 2.63));
    this._grassBp = this._track(biquad(actx, 'bandpass', 760, 0.85));
    this._grassHp = this._track(biquad(actx, 'highpass', 240, 0.6));
    this._grassGain = this._track(gainNode(actx, 0));
    chain([this._grassSrc, this._grassBp, this._grassHp, this._grassGain, this.output]);
  }

  _makeScrub(offset, q) {
    const actx = this.actx;
    const src = this._source(looper(actx, this.noise.white, 1, offset));
    const bp = this._track(biquad(actx, 'bandpass', 700, q));
    const peak = this._track(biquad(actx, 'peaking', 1750, 2.0, 7));
    const sat = this._track(shaperNode(actx, createSaturationCurve(2.6)));
    const gain = this._track(gainNode(actx, 0));
    chain([src, bp, peak, sat, gain, this.output]);
    return { bp, gain };
  }

  start(when = 0) {
    for (let i = 0; i < this._sources.length; i++) startSource(this._sources[i], when);
  }

  setGain(v, when = 0) {
    setParam(this.output.gain, Math.max(0, v), when, 0.05, 1e-4);
  }

  /**
   * Drive every layer from one physics state. Allocation-free: the surface histogram
   * lives in a preallocated Float32Array and the wheel loop reads fields in place.
   */
  update(now, dt, s) {
    if (this._disposed) return;

    const speed = Math.abs(s.speed);
    const speedN = clamp01(speed / MAX_SPEED);

    const mix = this._surfaceMix;
    mix[0] = 0; mix[1] = 0; mix[2] = 0; mix[3] = 0; mix[4] = 0;

    let roughness = 0;
    let contact = 0;
    let frontSlip = 0;
    let rearSlip = 0;
    let lockup = 0;
    let spin = 0;
    let spinRatio = 0;
    let wheelSurfaceSpeed = 0;
    let loadTotal = 0;

    for (let i = 0; i < 4; i++) {
      const w = s.wheels[i];
      if (!w.contact) {
        this._prevCompression[i] = w.suspension.compression;
        continue;
      }
      contact++;
      loadTotal += w.load;

      const surf = w.surface;
      if (surf === 'kerb') mix[1] += 0.25;
      else if (surf === 'grass') mix[2] += 0.25;
      else if (surf === 'gravel') mix[3] += 0.25;
      else if (surf === 'astroturf') mix[4] += 0.25;
      else mix[0] += 0.25;
      roughness += (SURFACE_ROUGHNESS[surf] ?? 0.35) * 0.25;

      const sa = Math.abs(w.slipAngle);
      if (i < 2) frontSlip = Math.max(frontSlip, sa);
      else rearSlip = Math.max(rearSlip, sa);

      lockup = Math.max(lockup, w.lockup);
      if (w.spin > spin) {
        spin = w.spin;
        spinRatio = Math.abs(w.slipRatio);
      }

      const radius = i < 2 ? this.frontRadius : this.rearRadius;
      wheelSurfaceSpeed += Math.abs(w.angularVelocity) * radius * 0.25;

      // A step change in compression is a bump strike. The derivative is what you feel;
      // the absolute travel is not audible on its own.
      const dc = w.suspension.compression - this._prevCompression[i];
      this._prevCompression[i] = w.suspension.compression;
      if (dc > 0.09 && dt > 0 && this._kerbCooldown <= 0) {
        this._fireThump(now, clamp01(dc * 3.4) * (0.35 + 0.65 * speedN));
        this._kerbCooldown = 0.045;
      }
    }
    if (this._kerbCooldown > 0) this._kerbCooldown -= dt;

    const grounded = contact > 0 ? 1 : 0;
    const loadN = clamp01(loadTotal / 12000); // ~12 kN static plus downforce at speed

    this._updateRoar(now, speed, speedN, roughness, grounded, loadN);
    this._updateScrub(now, speed, frontSlip, rearSlip, loadN, mix[0] + mix[1]);
    this._updateSquealAndSpin(now, speed, lockup, spin, spinRatio, wheelSurfaceSpeed);
    this._updateKerb(now, speed, mix[1], loadN);
    this._updateOffTrack(now, speedN, mix[2], mix[3], mix[4]);
  }

  _updateRoar(now, speed, speedN, roughness, grounded, loadN) {
    // Rolling noise power grows roughly with the cube of speed; the exponent below is
    // the amplitude equivalent, tempered so it is still audible in the pits.
    const level = grounded * (0.04 + 0.62 * Math.pow(speedN, 1.35))
      * (0.45 + 0.9 * roughness) * (0.55 + 0.45 * loadN);
    setParam(this._roarGain.gain, level, now, 0.05, 5e-4);
    setParam(this._roarLp.frequency, 200 + speed * 26 + roughness * 900, now, 0.06, 8);
    setParam(this._roarPeak.gain, 4 + roughness * 6, now, 0.1, 0.1);

    // Tread pitch frequency: block pitch is roughly 55 mm on a slick's shoulder wear
    // pattern, so the grain band sits at speed / 0.055.
    const grainHz = clamp(300 + speed / 0.055 * 0.25, 300, 5200);
    setParam(this._grainBp.frequency, grainHz, now, 0.06, 10);
    setParam(this._grainGain.gain, grounded * roughness * (0.03 + 0.30 * speedN), now, 0.06, 5e-4);
  }

  _updateScrub(now, speed, frontSlip, rearSlip, loadN, hardSurface) {
    // Below about 2 degrees the tyre is deforming elastically and silent; past 9 degrees
    // it is fully sliding and the scrub saturates.
    const fAmt = smoothstep(0.035, 0.16, frontSlip);
    const rAmt = smoothstep(0.035, 0.16, rearSlip);
    const move = smoothstep(2, 14, speed);
    const base = move * hardSurface * (0.45 + 0.55 * loadN);

    setParam(this._scrubFront.gain.gain, fAmt * base * 0.42, now, 0.035, 5e-4);
    setParam(this._scrubFront.bp.frequency, 620 + frontSlip * 4200 + speed * 6, now, 0.05, 8);
    setParam(this._scrubRear.gain.gain, rAmt * base * 0.40, now, 0.035, 5e-4);
    setParam(this._scrubRear.bp.frequency, 520 + rearSlip * 3400 + speed * 5, now, 0.05, 8);
  }

  _updateSquealAndSpin(now, speed, lockup, spin, spinRatio, wheelSurfaceSpeed) {
    // A locked wheel's excitation is a blend of how fast the carcass is still turning
    // and how fast the contact patch is being dragged over the asphalt.
    const excite = 0.35 * wheelSurfaceSpeed + 0.65 * speed;
    const squealHz = clamp(SQUEAL_BASE + excite * 26, SQUEAL_BASE, 3200);
    const lockAmt = clamp01(lockup) * smoothstep(3, 12, speed);
    setParam(this._squealBp.frequency, squealHz, now, 0.03, 6);
    setParam(this._squealBp2.frequency, squealHz * 2, now, 0.03, 10);
    setParam(this._squealOsc.frequency, squealHz, now, 0.03, 6);
    setParam(this._squealNoiseGain.gain, lockAmt * 0.30, now, 0.025, 5e-4);
    setParam(this._squealOscGain.gain, lockAmt * lockAmt * 0.075, now, 0.025, 2e-4);

    const spinAmt = clamp01(spin) * smoothstep(1.5, 8, speed + spinRatio * 12);
    setParam(this._spinBp.frequency,
      clamp(1400 + spinRatio * 900 + speed * 14, 900, 4600), now, 0.03, 8);
    setParam(this._spinGain.gain, spinAmt * 0.26, now, 0.025, 5e-4);
  }

  _updateKerb(now, speed, kerbShare, loadN) {
    const rate = clamp(speed / KERB_PITCH, 6, 160);
    setParam(this._kerbOsc.frequency, rate, now, 0.02, 0.5);
    const amt = kerbShare * smoothstep(1.5, 10, speed);
    setParam(this._kerbGain.gain, amt * (0.35 + 0.65 * loadN) * 0.55, now, 0.02, 5e-4);
    setParam(this._kerbTexGain.gain, amt * 0.22, now, 0.02, 5e-4);
    setParam(this._kerbNoiseBp.frequency, 900 + speed * 22, now, 0.05, 10);
    setParam(this._kerbBody.frequency, 190 + speed * 5.5, now, 0.05, 5);
  }

  _updateOffTrack(now, speedN, grass, gravel, astro) {
    setParam(this._gravelGain.gain, gravel * (0.10 + 0.85 * speedN) * 0.7, now, 0.05, 5e-4);
    setParam(this._gravelBp.frequency, 1500 + speedN * 1800, now, 0.08, 12);
    const soft = grass + astro * 0.7;
    setParam(this._grassGain.gain, soft * (0.08 + 0.72 * speedN) * 0.55, now, 0.05, 5e-4);
    setParam(this._grassBp.frequency, 620 + speedN * 1100, now, 0.08, 10);
  }

  _fireThump(now, amount) {
    const a = clamp01(amount);
    if (a < 0.05) return;
    const t = now + 0.002;
    this._thumpLp.frequency.setValueAtTime(this.rng.range(180, 420), t);
    envBurst(this._thumpGain.gain, t, a * 0.55, 0.0012, this.rng.range(0.05, 0.12));
    this._thudOsc.frequency.setValueAtTime(this.rng.range(44, 72), t);
    envBurst(this._thudGain.gain, t, a * 0.30, 0.004, this.rng.range(0.08, 0.16));
  }

  /** Kerb strike from the physics event — a harder hit than the per-wheel bump detector. */
  kerbStrike(now, speed) {
    this._fireThump(now, clamp01(0.25 + Math.abs(speed) / 70));
  }

  /** Landing or barrier contact. `intensity` is 0..1. */
  impact(now, intensity) {
    const a = clamp01(intensity);
    const t = now + 0.001;
    this._thumpLp.frequency.setValueAtTime(120 + a * 500, t);
    envBurst(this._thumpGain.gain, t, 0.25 + a * 0.85, 0.0008, 0.09 + a * 0.22);
    this._thudOsc.frequency.setValueAtTime(38 + a * 26, t);
    envBurst(this._thudGain.gain, t, 0.2 + a * 0.7, 0.003, 0.16 + a * 0.3);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (let i = 0; i < this._sources.length; i++) stopSource(this._sources[i]);
    disconnectAll(this._nodes);
    this._nodes.length = 0;
    this._sources.length = 0;
  }
}
