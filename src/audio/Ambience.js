import { clamp, clamp01, damp, smoothstep } from '../core/MathUtils.js';
import { Rng } from '../core/Rng.js';
import {
  biquad, chain, createPanner, disconnectAll, dopplerRatio, envBurst, gainNode, looper,
  oscillator, setPannerPosition, setParam, startSource, stopSource,
} from './DSP.js';
import { EngineSynth } from './EngineSynth.js';

/**
 * The world around the car: wind over the helmet, rain, the crowd in the grandstands,
 * the pit lane, and the engines of every car near enough to hear.
 *
 * The AI engine field is the expensive and the important part. Twenty cars cannot each
 * have a full synth, so a pool of lite EngineSynths is bound to the nearest cars by
 * distance and recycled with a short crossfade when the order changes. Each voice runs
 * through a PannerNode for placement and distance, and its crank frequency is scaled by
 * a properly computed Doppler ratio — WebAudio dropped its own Doppler implementation in
 * 2015, so the shift is applied to the source frequency instead, which is both cheaper
 * and gives control over the amount.
 */

const MAX_CARS = 32;
const VOICE_FADE_RATE = 9;        // per second; ~0.12 s to swap a voice without a click
const SELECT_INTERVAL = 0.2;      // s between re-sorts of the nearest-car list
const CROWD_RANGE = 240;          // m at which a grandstand stops contributing
const PIT_RANGE = 150;

export class Ambience {
  constructor(actx, options = {}) {
    const {
      noise, ambienceBus, worldBus, seed = 0x2b17, crowdVoices = 3, carVoices = 8,
    } = options;

    this.actx = actx;
    this.noise = noise;
    this.ambienceBus = ambienceBus;
    this.worldBus = worldBus;
    this.rng = new Rng(seed);

    this._nodes = [];
    this._sources = [];
    this._disposed = false;
    this._started = false;

    this.rain = 0;
    this._rainTarget = 0;
    this._selectTimer = 0;
    this._gunTimer = 4;
    this._pitLevel = 0;

    this._crowdVoices = [];
    this._carVoices = [];
    this._voiceCap = carVoices;

    this._standCount = 0;
    this._standPos = new Float32Array(3 * 16);
    this._standWeight = new Float32Array(16);
    this._pitPos = new Float32Array(3);
    this._hasPit = false;

    this._best = new Int32Array(Math.max(1, carVoices));
    this._bestDist = new Float32Array(Math.max(1, carVoices));
    this._bestCount = 0;

    this._buildWind();
    this._buildRain();
    this._buildPit();
    for (let i = 0; i < crowdVoices; i++) this._crowdVoices.push(this._buildCrowdVoice(i));
    for (let i = 0; i < carVoices; i++) this._carVoices.push(this._buildCarVoice(i));
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

  _buildWind() {
    const actx = this.actx;
    // Two decorrelated noise streams so the wind has width. Reading the same buffer from
    // different offsets at slightly different rates costs nothing and never phases.
    this._wind = [];
    for (let i = 0; i < 2; i++) {
      const src = this._source(looper(actx, this.noise.pink, i === 0 ? 1.0 : 0.973,
        i === 0 ? 0.13 : 1.61));
      const hp = this._track(biquad(actx, 'highpass', 150, 0.7));
      const lp = this._track(biquad(actx, 'lowpass', 500, 0.6));
      const pan = this._track(actx.createStereoPanner());
      pan.pan.value = i === 0 ? -0.75 : 0.75;
      const g = this._track(gainNode(actx, 0));
      chain([src, hp, lp, pan, g, this.ambienceBus]);
      this._wind.push({ lp, gain: g });
    }

    // Helmet buffet: the low pressure rumble that arrives through the shell rather than
    // around it, resonant at the helmet's own cavity mode.
    this._buffetSrc = this._source(looper(actx, this.noise.brown, 1, 0.41));
    this._buffetPeak = this._track(biquad(actx, 'peaking', 175, 1.6, 9));
    this._buffetLp = this._track(biquad(actx, 'lowpass', 420, 0.8));
    this._buffetGain = this._track(gainNode(actx, 0));
    chain([this._buffetSrc, this._buffetPeak, this._buffetLp, this._buffetGain,
      this.ambienceBus]);

    // A resonance where the airflow separates off the halo and hits the visor edge.
    this._visorPeak = this._track(biquad(actx, 'peaking', 880, 2.2, 0));
    this._wind[0].gain.disconnect();
    this._wind[1].gain.disconnect();
    this._wind[0].gain.connect(this._visorPeak);
    this._wind[1].gain.connect(this._visorPeak);
    this._visorPeak.connect(this.ambienceBus);
  }

  _buildRain() {
    const actx = this.actx;
    this._rainHissSrc = this._source(looper(actx, this.noise.white, 1, 0.83));
    this._rainHissHp = this._track(biquad(actx, 'highpass', 1500, 0.6));
    this._rainHissGain = this._track(gainNode(actx, 0));
    chain([this._rainHissSrc, this._rainHissHp, this._rainHissGain, this.ambienceBus]);

    this._rainBodySrc = this._source(looper(actx, this.noise.pink, 1, 2.17));
    this._rainBodyBp = this._track(biquad(actx, 'bandpass', 520, 0.8));
    this._rainBodyGain = this._track(gainNode(actx, 0));
    chain([this._rainBodySrc, this._rainBodyBp, this._rainBodyGain, this.ambienceBus]);

    // Individual drops striking the helmet and the halo.
    this._rainDropSrc = this._source(looper(actx, this.noise.sparse, 1.35, 0.05));
    this._rainDropPeak = this._track(biquad(actx, 'peaking', 2400, 1.8, 8));
    this._rainDropGain = this._track(gainNode(actx, 0));
    chain([this._rainDropSrc, this._rainDropPeak, this._rainDropGain, this.ambienceBus]);
  }

  _buildPit() {
    const actx = this.actx;
    this._pitBus = this._track(gainNode(actx, 0));
    this._pitBus.connect(this.ambienceBus);

    // Garage compressors and generators: a low sawtooth through a tight lowpass.
    this._pitHum = this._source(oscillator(actx, 'sawtooth', 62));
    this._pitHumLp = this._track(biquad(actx, 'lowpass', 210, 1.5));
    this._pitHumGain = this._track(gainNode(actx, 0.11));
    chain([this._pitHum, this._pitHumLp, this._pitHumGain, this._pitBus]);

    // Tannoy: a mid band with a slow amplitude wander standing in for speech.
    this._pitTanSrc = this._source(looper(actx, this.noise.pink, 1, 1.31));
    this._pitTanBp = this._track(biquad(actx, 'bandpass', 1150, 2.4));
    this._pitTanAm = this._track(gainNode(actx, 0.5));
    this._pitTanGain = this._track(gainNode(actx, 0.07));
    chain([this._pitTanSrc, this._pitTanBp, this._pitTanAm, this._pitTanGain, this._pitBus]);
    this._pitTanLfoSrc = this._source(looper(actx, this.noise.brown, 0.035, 0.9));
    this._pitTanDepth = this._track(gainNode(actx, 2.6));
    chain([this._pitTanLfoSrc, this._pitTanDepth, this._pitTanAm.gain]);

    // Wheel gun: a noise band chopped at the gun's hammer rate.
    this._gunSrc = this._source(looper(actx, this.noise.white, 1, 1.77));
    this._gunBp = this._track(biquad(actx, 'bandpass', 1750, 3.2));
    this._gunFlutter = this._track(gainNode(actx, 0));
    this._gunGain = this._track(gainNode(actx, 0));
    chain([this._gunSrc, this._gunBp, this._gunFlutter, this._gunGain, this._pitBus]);
    this._gunLfo = this._source(oscillator(actx, 'square', 21));
    this._gunDepth = this._track(gainNode(actx, 0.5));
    this._gunLfo.connect(this._gunDepth).connect(this._gunFlutter.gain);
    this._gunFlutter.gain.value = 0.5;
  }

  _buildCrowdVoice(i) {
    const actx = this.actx;
    const src = this._source(looper(actx, this.noise.pink, 0.94 + i * 0.05, 0.37 + i * 0.71));
    const bp = this._track(biquad(actx, 'bandpass', 700, 0.7));
    const peak = this._track(biquad(actx, 'peaking', 2500, 1.2, 7));
    const swell = this._track(gainNode(actx, 0.55));
    const cheer = this._track(gainNode(actx, 0));
    const level = this._track(gainNode(actx, 0));
    const panner = this._track(createPanner(actx, {
      refDistance: 26, rolloffFactor: 1.1, maxDistance: CROWD_RANGE * 1.6,
    }));
    chain([src, bp, peak, swell, level, panner, this.worldBus]);
    // A cheer is the same crowd through a brighter, louder path, so a lap or an
    // overtake lifts the same voice rather than layering a second one.
    peak.connect(cheer).connect(level);

    // Slow amplitude wander: brown noise played back a hundred times slow is a free,
    // non-repeating LFO with exactly the right lazy character for a crowd swell.
    const lfo = this._source(looper(actx, this.noise.brown, 0.011 + i * 0.003, i * 0.5));
    const depth = this._track(gainNode(actx, 1.9));
    chain([lfo, depth, swell.gain]);

    return { panner, level, cheer, bp, stand: -1, gain: 0, target: 0 };
  }

  _buildCarVoice(i) {
    const actx = this.actx;
    const synth = new EngineSynth(actx, {
      detail: 'lite', noise: this.noise, seed: 0x9a11 + i * 7919, gain: 0,
    });
    const panner = this._track(createPanner(actx, {
      refDistance: 7, rolloffFactor: 1.35, maxDistance: 620,
    }));
    synth.output.connect(panner);
    panner.connect(this.worldBus);
    return { synth, panner, carIndex: -1, level: 0, target: 0, releasing: false };
  }

  /** Resolve the world positions of the crowd and pit sources from the built track. */
  bindTrack(track) {
    if (!track) return;
    const stands = track.circuit?.grandstands;
    const length = track.length || 1;
    if (Array.isArray(stands)) {
      const n = Math.min(stands.length, 16);
      for (let i = 0; i < n; i++) {
        const st = stands[i];
        const mid = ((st.from + st.to) * 0.5) / length;
        const s = track.sample(mid - Math.floor(mid));
        const lateral = (st.side ?? 1) * ((st.offset ?? 25) + 12);
        this._standPos[i * 3] = s.position.x + s.right.x * lateral;
        this._standPos[i * 3 + 1] = s.position.y + 9;
        this._standPos[i * 3 + 2] = s.position.z + s.right.z * lateral;
        // Bigger stands hold more people and carry further.
        this._standWeight[i] = clamp01(((st.rows ?? 18) - 10) / 20) * 0.6 + 0.4;
      }
      this._standCount = n;
    }

    const pit = track.pitLane;
    if (pit?.curve) {
      const p = pit.curve.getPointAt(0.5);
      this._pitPos[0] = p.x;
      this._pitPos[1] = p.y + 2;
      this._pitPos[2] = p.z;
      this._hasPit = true;
    }
  }

  start(when = 0) {
    if (this._started) return;
    this._started = true;
    for (let i = 0; i < this._sources.length; i++) startSource(this._sources[i], when);
    for (let i = 0; i < this._carVoices.length; i++) this._carVoices[i].synth.start(when);
  }

  setRain(amount) {
    this._rainTarget = clamp01(amount);
  }

  /**
   * Cap how many pooled voices may sound. The pool itself is allocated once at init, so
   * a quality change only silences the tail of it — it never rebuilds the graph.
   */
  setVoiceBudget(n) {
    const cap = clamp(Math.floor(n), 0, this._carVoices.length);
    this._voiceCap = cap;
    for (let i = cap; i < this._carVoices.length; i++) {
      const v = this._carVoices[i];
      v.target = 0;
      v.releasing = true;
    }
    return cap;
  }

  /** A lap completed or a place gained — lift whichever grandstands are in earshot. */
  cheer(now, intensity = 1) {
    const a = clamp01(intensity);
    for (let i = 0; i < this._crowdVoices.length; i++) {
      const v = this._crowdVoices[i];
      if (v.gain < 0.02) continue;
      envBurst(v.cheer.gain, now + this.rng.range(0, 0.25), 1.4 * a, 0.35,
        this.rng.range(2.5, 4.5));
    }
  }

  /**
   * @param {number} now      audio context time
   * @param {number} dt       seconds
   * @param {object} ctx      engine context
   * @param {object} listener preallocated { x, y, z, vx, vy, vz, speed }
   */
  update(now, dt, ctx, listener) {
    if (this._disposed) return;

    this.rain = damp(this.rain, this._rainTarget, 1.4, dt);

    const state = ctx.vehicle?.state;
    const speed = state ? Math.abs(state.speed) : 0;
    this._updateWind(now, speed, state);
    this._updateRain(now, speed);
    this._updateCrowd(now, dt, listener);
    this._updatePit(now, dt, listener);

    this._selectTimer -= dt;
    if (this._selectTimer <= 0) {
      this._selectTimer = SELECT_INTERVAL;
      this._selectCars(ctx, listener);
      this._assignVoices();
    }
    this._updateCarVoices(now, dt, ctx, listener);
  }

  _updateWind(now, speed, state) {
    // Wind noise power goes as roughly the sixth power of velocity, which is a fifth
    // power in amplitude; 1.7 here is the tamed version that still leaves headroom for
    // the engine at 340 km/h.
    const sN = clamp01(speed / 96);
    const level = Math.pow(sN, 1.7);
    const airborne = state?.airborne ? 1.25 : 1;
    const cutoff = 420 + speed * 52;
    for (let i = 0; i < this._wind.length; i++) {
      setParam(this._wind[i].lp.frequency, cutoff * (i === 0 ? 1 : 0.88), now, 0.08, 12);
      setParam(this._wind[i].gain.gain, level * 0.30 * airborne, now, 0.07, 5e-4);
    }
    setParam(this._visorPeak.gain, 3 + level * 7, now, 0.12, 0.05);
    setParam(this._buffetLp.frequency, 320 + speed * 4.5, now, 0.1, 5);
    setParam(this._buffetGain.gain, Math.pow(sN, 1.3) * 0.24, now, 0.08, 5e-4);
  }

  _updateRain(now, speed) {
    const r = this.rain;
    if (r < 0.005) {
      setParam(this._rainHissGain.gain, 0, now, 0.2, 1e-4);
      setParam(this._rainBodyGain.gain, 0, now, 0.2, 1e-4);
      setParam(this._rainDropGain.gain, 0, now, 0.2, 1e-4);
      return;
    }
    const sN = clamp01(speed / 96);
    // Driving into rain multiplies both the impact rate and the impact energy.
    const drive = 1 + sN * 2.2;
    setParam(this._rainHissGain.gain, r * 0.10 * drive, now, 0.12, 5e-4);
    setParam(this._rainHissHp.frequency, 1200 + sN * 2600, now, 0.15, 15);
    setParam(this._rainBodyGain.gain, r * 0.07 * (1 + sN), now, 0.12, 5e-4);
    setParam(this._rainDropGain.gain, r * 0.09 * drive, now, 0.12, 5e-4);
    setParam(this._rainDropSrc.playbackRate, 1 + sN * 1.6, now, 0.15, 0.02);
  }

  _updateCrowd(now, dt, listener) {
    const voices = this._crowdVoices;
    if (this._standCount === 0 || voices.length === 0) return;

    // Assign each voice the n-th nearest grandstand. With three voices and eight stands
    // this is a linear scan of twenty-four distances, once per frame, no allocation.
    for (let v = 0; v < voices.length; v++) {
      let bestIdx = -1;
      let bestD = Infinity;
      for (let i = 0; i < this._standCount; i++) {
        let taken = false;
        for (let u = 0; u < v; u++) {
          if (voices[u].stand === i) { taken = true; break; }
        }
        if (taken) continue;
        const dx = this._standPos[i * 3] - listener.x;
        const dy = this._standPos[i * 3 + 1] - listener.y;
        const dz = this._standPos[i * 3 + 2] - listener.z;
        const d = dx * dx + dy * dy + dz * dz;
        if (d < bestD) { bestD = d; bestIdx = i; }
      }
      const voice = voices[v];
      const dist = Math.sqrt(bestD);
      const audible = bestIdx >= 0 && dist < CROWD_RANGE;
      if (audible && voice.stand !== bestIdx && voice.gain < 0.03) voice.stand = bestIdx;
      const bound = voice.stand;
      if (bound < 0) continue;

      const bx = this._standPos[bound * 3];
      const by = this._standPos[bound * 3 + 1];
      const bz = this._standPos[bound * 3 + 2];
      const bdx = bx - listener.x;
      const bdy = by - listener.y;
      const bdz = bz - listener.z;
      const bdist = Math.sqrt(bdx * bdx + bdy * bdy + bdz * bdz);
      voice.target = bound === bestIdx
        ? this._standWeight[bound] * smoothstep(CROWD_RANGE, CROWD_RANGE * 0.35, bdist)
        : 0;
      voice.gain = damp(voice.gain, voice.target, 2.5, dt);
      setPannerPosition(voice.panner, bx, by, bz, now, 0.05);
      setParam(voice.level.gain, voice.gain * 0.5, now, 0.15, 5e-4);
      // Distance rolls the top off the crowd long before it quietens it.
      setParam(voice.bp.frequency, 760 - clamp(bdist, 0, CROWD_RANGE) * 0.9, now, 0.2, 4);
    }
  }

  _updatePit(now, dt, listener) {
    if (!this._hasPit) return;
    const dx = this._pitPos[0] - listener.x;
    const dy = this._pitPos[1] - listener.y;
    const dz = this._pitPos[2] - listener.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const target = smoothstep(PIT_RANGE, PIT_RANGE * 0.25, dist);
    this._pitLevel = damp(this._pitLevel, target, 1.8, dt);
    setParam(this._pitBus.gain, this._pitLevel, now, 0.2, 1e-3);

    if (this._pitLevel < 0.05) return;
    this._gunTimer -= dt;
    if (this._gunTimer <= 0) {
      this._gunTimer = this.rng.range(1.6, 6.5);
      this._gunLfo.frequency.setValueAtTime(this.rng.range(17, 27), now);
      this._gunBp.frequency.setValueAtTime(this.rng.range(1400, 2300), now);
      envBurst(this._gunGain.gain, now + 0.01, this.rng.range(0.18, 0.4), 0.02,
        this.rng.range(0.35, 0.9));
    }
  }

  /** Nearest `_maxCarVoices` rivals by squared distance, insertion-sorted in place. */
  _selectCars(ctx, listener) {
    const cars = ctx.cars;
    const count = cars ? Math.min(cars.length, MAX_CARS) : 0;
    this._bestCount = 0;
    const cap = Math.max(1, Math.min(this._best.length, this._voiceCap));

    for (let i = 1; i < count; i++) {
      const car = cars.at ? cars.at(i) : cars[i];
      const st = car?.physics?.state;
      if (!st) continue;
      const dx = st.position.x - listener.x;
      const dy = st.position.y - listener.y;
      const dz = st.position.z - listener.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > 620 * 620) continue;

      let slot = this._bestCount < cap ? this._bestCount : cap - 1;
      if (this._bestCount === cap && d >= this._bestDist[cap - 1]) continue;
      while (slot > 0 && this._bestDist[slot - 1] > d) {
        this._bestDist[slot] = this._bestDist[slot - 1];
        this._best[slot] = this._best[slot - 1];
        slot--;
      }
      this._bestDist[slot] = d;
      this._best[slot] = i;
      if (this._bestCount < cap) this._bestCount++;
    }
  }

  /** Bind free voices to unbound cars and release voices whose car dropped out. */
  _assignVoices() {
    const voices = this._carVoices;
    for (let v = 0; v < voices.length; v++) {
      const voice = voices[v];
      if (voice.carIndex < 0) continue;
      if (v >= this._voiceCap) {
        voice.releasing = true;
        voice.target = 0;
        continue;
      }
      let stillNear = false;
      for (let b = 0; b < this._bestCount; b++) {
        if (this._best[b] === voice.carIndex) { stillNear = true; break; }
      }
      if (!stillNear) {
        voice.releasing = true;
        voice.target = 0;
      } else {
        voice.releasing = false;
        voice.target = 1;
      }
    }

    for (let b = 0; b < this._bestCount; b++) {
      const carIndex = this._best[b];
      let bound = false;
      for (let v = 0; v < voices.length; v++) {
        if (voices[v].carIndex === carIndex) { bound = true; break; }
      }
      if (bound) continue;
      for (let v = 0; v < Math.min(voices.length, this._voiceCap); v++) {
        const voice = voices[v];
        if (voice.carIndex >= 0 || voice.level > 0.02) continue;
        voice.carIndex = carIndex;
        voice.releasing = false;
        voice.target = 1;
        break;
      }
    }
  }

  _updateCarVoices(now, dt, ctx, listener) {
    const cars = ctx.cars;
    const voices = this._carVoices;
    for (let v = 0; v < voices.length; v++) {
      const voice = voices[v];
      voice.level = damp(voice.level, voice.target, VOICE_FADE_RATE, dt);

      if (voice.carIndex < 0) {
        if (voice.level > 1e-3) voice.synth.setGain(0, now, 0.05);
        continue;
      }
      if (voice.releasing && voice.level < 0.02) {
        voice.synth.silence(now);
        voice.carIndex = -1;
        continue;
      }

      const car = cars.at ? cars.at(voice.carIndex) : cars[voice.carIndex];
      const st = car?.physics?.state;
      if (!st) {
        voice.releasing = true;
        voice.target = 0;
        continue;
      }

      const px = st.position.x;
      const py = st.position.y + 0.35;
      const pz = st.position.z;
      let dx = px - listener.x;
      let dy = py - listener.y;
      let dz = pz - listener.z;
      const dist = Math.max(1e-3, Math.sqrt(dx * dx + dy * dy + dz * dz));
      dx /= dist; dy /= dist; dz /= dist;

      // Radial components along the listener->source axis. The listener closing on the
      // source raises the pitch; the source running away from it lowers it.
      const listenerRadial = listener.vx * dx + listener.vy * dy + listener.vz * dz;
      const sourceRadial = st.velocity.x * dx + st.velocity.y * dy + st.velocity.z * dz;
      const ratio = dopplerRatio(listenerRadial, sourceRadial);

      setPannerPosition(voice.panner, px, py, pz, now, 0.016);
      // Air absorption: about 3 dB per 100 m at 4 kHz, far more above it. A one-pole
      // sweep on the voice's own muffle filter is a close enough model and free.
      voice.synth.setMuffle(clamp(19000 * Math.exp(-dist / 190), 700, 19000), now);
      voice.synth.setGain(voice.level, now, 0.05);
      voice.synth.update(now, dt, st, ratio);
    }
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (let i = 0; i < this._carVoices.length; i++) this._carVoices[i].synth.dispose();
    this._carVoices.length = 0;
    this._crowdVoices.length = 0;
    for (let i = 0; i < this._sources.length; i++) stopSource(this._sources[i]);
    disconnectAll(this._nodes);
    this._nodes.length = 0;
    this._sources.length = 0;
  }
}
