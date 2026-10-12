import * as THREE from "three";
import { clamp, clamp01, damp } from "../core/MathUtils.js";
import { Rng } from "../core/Rng.js";
import {
  biquad,
  chain,
  createImpulseResponse,
  createLimiterCurve,
  createNoiseBuffer,
  createSaturationCurve,
  dbToGain,
  disconnectAll,
  envBurst,
  gainNode,
  looper,
  oscillator,
  RingBuffer,
  RingDelay,
  setListenerPose,
  setParam,
  shaperNode,
  startSource,
  stopSource
} from "./DSP.js";
import { EngineSynth } from "./EngineSynth.js";
import { TyreAudio } from "./TyreAudio.js";
import { Ambience } from "./Ambience.js";
const _camPos = new THREE.Vector3();
const _camPrev = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const VOICE_BUDGET = { low: 4, medium: 6, high: 8, ultra: 8 };
const CROWD_VOICES = { low: 1, medium: 2, high: 3, ultra: 3 };
const NOISE_SECONDS = { white: 3, pink: 3, brown: 2, sparse: 2 };
const ENGINE_VOLUME_MAX = 1.5;
export class AudioEngine {
  static systemName = "audio";
  constructor() {
    this.enabled = false;
    this.actx = null;
    this.voiceBudget = 8;
    this._ctx = null;
    this._started = false;
    this._resumePromise = null;
    this._pendingDt = 0;
    this._unsubscribe = [];
    this._nodes = [];
    this._sources = [];
    this._rng = new Rng(20947);
    this._listener = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
    this._velX = new RingBuffer(6);
    this._velY = new RingBuffer(6);
    this._velZ = new RingBuffer(6);
    this._havePrev = false;
    this._duck = 1;
    this._onShift = (e) => this._handleShift(e);
    this._onCollision = (e) => this._handleCollision(e);
    this._onKerb = (e) => this._handleKerb(e);
    this._onLap = () => this._handleCheer(0.8);
    this._onRaceStart = () => this._handleCheer(1);
    this._onVisibility = () => {
      const visible = !globalThis.document?.hidden;
      if (visible && this._started && this.actx?.state === "suspended") this.resume();
      this._applyVolumes();
    };
  }
  async init(ctx) {
    this._ctx = ctx;
    const AC = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!AC) {
      console.warn("[audio] WebAudio unavailable — audio disabled");
      return;
    }
    this.actx = new AC({ latencyHint: "interactive" });
    this.enabled = true;
    const tier = ctx.quality?.name ?? "high";
    this.voiceBudget = VOICE_BUDGET[tier] ?? 8;
    this._buildNoiseBank();
    this._buildMaster(tier);
    this._buildImpacts();
    const cfg = ctx.vehicle?.config ?? ctx.cars?.at?.(0)?.config;
    this.engine = new EngineSynth(this.actx, {
      detail: "full",
      noise: this.noise,
      seed: 126989,
      gain: 1,
      upshiftCutSeconds: cfg?.transmission?.shiftTime ?? 0.04,
      downshiftCutSeconds: cfg?.transmission?.downshiftTime ?? 0.055
    });
    this._buildPlayerEngineWidth();
    this.tyres = new TyreAudio(this.actx, {
      noise: this.noise,
      seed: 32485,
      frontRadius: cfg?.tyres?.front?.radius ?? 0.36,
      rearRadius: cfg?.tyres?.rear?.radius ?? 0.3625
    });
    this.tyres.output.connect(this.tyreBus);
    this.ambience = new Ambience(this.actx, {
      noise: this.noise,
      ambienceBus: this.ambienceBus,
      worldBus: this.worldBus,
      seed: 15375,
      crowdVoices: CROWD_VOICES[tier] ?? 3,
      carVoices: this.voiceBudget
    });
    this.ambience.bindTrack(ctx.track);
    this.ambience.setRain(ctx.sky?.weather?.rain ?? 0);
    const events = ctx.events;
    this._unsubscribe.push(events.on("car:shift", this._onShift));
    this._unsubscribe.push(events.on("car:collision", this._onCollision));
    this._unsubscribe.push(events.on("car:kerb", this._onKerb));
    this._unsubscribe.push(events.on("race:lap", this._onLap));
    this._unsubscribe.push(events.on("race:start", this._onRaceStart));
    this._unsubscribe.push(events.on("quality:change", (q) => this._applyQuality(q)));
    this._unsubscribe.push(ctx.settings.onChange((key) => {
      if (key === "masterVolume" || key === "engineVolume") this._applyVolumes();
    }));
    globalThis.document?.addEventListener("visibilitychange", this._onVisibility);
    this._applyVolumes();
    if (this.actx.state === "running") this.resume();
  }
  _buildNoiseBank() {
    const actx = this.actx;
    const rng = this._rng;
    this.noise = {
      white: createNoiseBuffer(actx, NOISE_SECONDS.white, "white", rng),
      pink: createNoiseBuffer(actx, NOISE_SECONDS.pink, "pink", rng),
      brown: createNoiseBuffer(actx, NOISE_SECONDS.brown, "brown", rng),
      sparse: createNoiseBuffer(actx, NOISE_SECONDS.sparse, "sparse", rng)
    };
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
  _buildMaster(tier) {
    const actx = this.actx;
    this.masterIn = this._track(gainNode(actx, 0));
    this.duckGain = this._track(gainNode(actx, 1));
    this.compressor = this._track(actx.createDynamicsCompressor());
    this.compressor.threshold.value = -16;
    this.compressor.knee.value = 8;
    this.compressor.ratio.value = 3.5;
    this.compressor.attack.value = 6e-3;
    this.compressor.release.value = 0.22;
    this.limiter = this._track(shaperNode(
      actx,
      createLimiterCurve(0.8),
      tier === "low" ? "none" : "2x"
    ));
    this.makeup = this._track(gainNode(actx, dbToGain(1.5)));
    chain([this.masterIn, this.duckGain, this.compressor, this.limiter, this.makeup]);
    this.makeup.connect(actx.destination);
    this.engineBus = this._track(gainNode(actx, 0.85));
    this.tyreBus = this._track(gainNode(actx, 0.9));
    this.worldBus = this._track(gainNode(actx, 0.8));
    this.ambienceBus = this._track(gainNode(actx, 0.75));
    this.engineBus.connect(this.masterIn);
    this.tyreBus.connect(this.masterIn);
    this.worldBus.connect(this.masterIn);
    this.ambienceBus.connect(this.masterIn);
    this.reverbReturn = this._track(gainNode(actx, 0.9));
    this.reverbReturn.connect(this.masterIn);
    if (tier === "low") {
      this._cheapVerb = new RingDelay(actx, {
        time: 0.085,
        feedback: 0.42,
        damping: 2600,
        mix: 1,
        maxTime: 0.5
      });
      this._cheapVerb.dry.gain.value = 0;
      this._track(this._cheapVerb.input);
      this._track(this._cheapVerb.output);
      this.reverbIn = this._cheapVerb.input;
      this._cheapVerb.output.connect(this.reverbReturn);
    } else {
      this.convolver = this._track(actx.createConvolver());
      this.convolver.normalize = false;
      this.convolver.buffer = createImpulseResponse(actx, {
        duration: 1.5,
        decay: 3.1,
        preDelay: 0.013,
        damping: 0.62,
        diffusion: 0.7,
        width: 0.9,
        earlyGain: 0.55,
        earlyCount: 11,
        seed: 23458
      });
      this.reverbPre = this._track(biquad(actx, "highpass", 190, 0.7));
      this.reverbIn = this.reverbPre;
      chain([this.reverbPre, this.convolver, this.reverbReturn]);
    }
    this.engineSend = this._track(gainNode(actx, 0.16));
    this.tyreSend = this._track(gainNode(actx, 0.1));
    this.worldSend = this._track(gainNode(actx, 0.24));
    this.engineBus.connect(this.engineSend).connect(this.reverbIn);
    this.tyreBus.connect(this.tyreSend).connect(this.reverbIn);
    this.worldBus.connect(this.worldSend).connect(this.reverbIn);
  }
  _buildPlayerEngineWidth() {
    const actx = this.actx;
    this._engDry = this._track(actx.createStereoPanner());
    this._engDry.pan.value = -0.18;
    this._engWide = this._track(actx.createStereoPanner());
    this._engWide.pan.value = 0.42;
    this._engDelay = this._track(actx.createDelay(0.05));
    this._engDelay.delayTime.value = 0.011;
    this._engWideGain = this._track(gainNode(actx, 0.4));
    this.engine.output.connect(this._engDry).connect(this.engineBus);
    this.engine.output.connect(this._engDelay);
    chain([this._engDelay, this._engWideGain, this._engWide, this.engineBus]);
  }
  _buildImpacts() {
    const actx = this.actx;
    this._crashSrc = this._source(looper(actx, this.noise.white, 1, 1.93));
    this._crashBp = this._track(biquad(actx, "bandpass", 1400, 0.9));
    this._crashSat = this._track(shaperNode(actx, createSaturationCurve(4.5)));
    this._crashGain = this._track(gainNode(actx, 0));
    chain([this._crashSrc, this._crashBp, this._crashSat, this._crashGain, this.tyreBus]);
    this._crackA = this._source(oscillator(actx, "triangle", 340));
    this._crackB = this._source(oscillator(actx, "triangle", 811));
    this._crackGain = this._track(gainNode(actx, 0));
    this._crackA.connect(this._crackGain);
    this._crackB.connect(this._crackGain);
    this._crackGain.connect(this.tyreBus);
  }
  _startSources() {
    if (this._started || !this.enabled) return;
    this._started = true;
    const when = this.actx.currentTime + 0.02;
    for (let i = 0; i < this._sources.length; i++) startSource(this._sources[i], when);
    this.engine.start(when);
    this.tyres.start(when);
    this.ambience.start(when);
  }
  resume() {
    if (!this.enabled) return Promise.resolve();
    if (this._started && this.actx.state === "running") {
      this._applyVolumes();
      return Promise.resolve();
    }
    if (this._resumePromise) return this._resumePromise;
    const finish = () => {
      this._startSources();
      const now = this.actx.currentTime;
      this.masterIn.gain.cancelScheduledValues(now);
      this.masterIn.gain.setValueAtTime(0, now);
      this.masterIn.gain.linearRampToValueAtTime(this._masterTarget(), now + 0.45);
      this._resumePromise = null;
    };
    if (this.actx.state === "running") {
      finish();
      return Promise.resolve();
    }
    this._resumePromise = this.actx.resume().then(finish).catch((err) => {
      this._resumePromise = null;
      console.warn("[audio] resume rejected", err);
    });
    return this._resumePromise;
  }
  suspend() {
    if (!this.enabled || this.actx.state !== "running") return Promise.resolve();
    return this.actx.suspend();
  }
  _masterTarget() {
    const s = this._ctx?.settings;
    const v = s ? clamp01(s.get("masterVolume") ?? 0.8) : 0.8;
    const hidden = globalThis.document?.hidden ? 0 : 1;
    return v * v * hidden;
  }
  _applyVolumes() {
    if (!this.enabled) return;
    const now = this.actx.currentTime;
    if (this._started) setParam(this.masterIn.gain, this._masterTarget(), now, 0.06, 1e-4);
    const ev = clamp(this._ctx?.settings?.get("engineVolume") ?? 1, 0, ENGINE_VOLUME_MAX);
    setParam(this.engineBus.gain, 0.85 * ev, now, 0.06, 1e-4);
    setParam(this.worldBus.gain, 0.8 * (0.35 + 0.65 * ev), now, 0.06, 1e-4);
  }
  _applyQuality(tier) {
    const name = tier?.name ?? "high";
    const wanted = VOICE_BUDGET[name] ?? 8;
    this.voiceBudget = this.ambience ? this.ambience.setVoiceBudget(wanted) : wanted;
  }
  update(dt) {
    this._pendingDt += dt;
  }
  lateUpdate(alpha, ctx) {
    if (!this.enabled || !this._started) {
      this._pendingDt = 0;
      return;
    }
    const dt = clamp(this._pendingDt, 1 / 240, 0.1);
    this._pendingDt = 0;
    const actx = this.actx;
    if (actx.state !== "running") return;
    const now = actx.currentTime;
    this._updateListener(ctx, dt, now);
    const state = ctx.vehicle?.state;
    if (state) {
      this.engine.update(now, dt, state, 1);
      this.tyres.update(now, dt, state);
    }
    this.ambience.setRain(ctx.sky?.weather?.rain ?? 0);
    this.ambience.update(now, dt, ctx, this._listener);
    const target = ctx.paused ? 0.12 : 1;
    this._duck = damp(this._duck, target, 6, dt);
    setParam(this.duckGain.gain, this._duck, now, 0.05, 2e-3);
  }
  _updateListener(ctx, dt, now) {
    const camera = ctx.camera;
    camera.updateWorldMatrix(true, false);
    _mat.copy(camera.matrixWorld);
    const e = _mat.elements;
    _camPos.set(e[12], e[13], e[14]);
    const l = this._listener;
    if (this._havePrev) {
      const inv = 1 / dt;
      this._velX.push((_camPos.x - _camPrev.x) * inv);
      this._velY.push((_camPos.y - _camPrev.y) * inv);
      this._velZ.push((_camPos.z - _camPrev.z) * inv);
      l.vx = this._velX.mean;
      l.vy = this._velY.mean;
      l.vz = this._velZ.mean;
    } else {
      this._havePrev = true;
    }
    _camPrev.copy(_camPos);
    l.x = _camPos.x;
    l.y = _camPos.y;
    l.z = _camPos.z;
    setListenerPose(
      this.actx.listener,
      l.x,
      l.y,
      l.z,
      -e[8],
      -e[9],
      -e[10],
      e[4],
      e[5],
      e[6],
      now
    );
  }
  _handleShift(e) {
    if (!this.enabled || !this._started) return;
    this.engine.shift(this.actx.currentTime, e?.direction ?? 1);
  }
  _handleKerb(e) {
    if (!this.enabled || !this._started) return;
    this.tyres.kerbStrike(this.actx.currentTime, e?.speed ?? 0);
  }
  _handleCollision(e) {
    if (!this.enabled || !this._started) return;
    const now = this.actx.currentTime;
    const amount = clamp01((e?.impulse ?? 0) / 9e3);
    if (amount < 0.02) return;
    this.tyres.impact(now, amount);
    this._crashBp.frequency.setValueAtTime(this._rng.range(700, 2400), now);
    envBurst(
      this._crashGain.gain,
      now,
      0.35 + amount * 0.9,
      1e-3,
      0.08 + amount * 0.45
    );
    this._crackA.frequency.setValueAtTime(this._rng.range(260, 480), now);
    this._crackB.frequency.setValueAtTime(this._rng.range(620, 1150), now);
    envBurst(this._crackGain.gain, now, 0.12 + amount * 0.3, 8e-4, 0.05 + amount * 0.1);
  }
  _handleCheer(intensity) {
    if (!this.enabled || !this._started) return;
    this.ambience.cheer(this.actx.currentTime, intensity);
  }
  resize() {
  }
  dispose() {
    for (let i = 0; i < this._unsubscribe.length; i++) {
      const off = this._unsubscribe[i];
      if (typeof off === "function") off();
    }
    this._unsubscribe.length = 0;
    globalThis.document?.removeEventListener("visibilitychange", this._onVisibility);
    if (!this.enabled) return;
    this.engine?.dispose();
    this.tyres?.dispose();
    this.ambience?.dispose();
    this._cheapVerb?.dispose();
    for (let i = 0; i < this._sources.length; i++) stopSource(this._sources[i]);
    disconnectAll(this._nodes);
    this._nodes.length = 0;
    this._sources.length = 0;
    if (this.convolver) this.convolver.buffer = null;
    this.noise = null;
    this.enabled = false;
    this._started = false;
    this.actx.close().catch(() => {
    });
    this.actx = null;
  }
}
