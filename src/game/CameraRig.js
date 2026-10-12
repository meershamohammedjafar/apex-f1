import * as THREE from "three";
import { clamp, clamp01, damp, lerp, smoothstep, wrap01, deltaT, DEG, RAD } from "../core/MathUtils.js";
import { resolveCars } from "./Scenarios.js";
const MODES = ["cockpit", "helmet", "chase", "trackside", "replay"];
const NECK_OMEGA = 8.6;
const NECK_TRANSLATE_X = 0.01;
const NECK_TRANSLATE_Y = 6e-3;
const NECK_TRANSLATE_Z = 0.011;
const NECK_TRANSLATE_LIMIT = 0.028;
const NECK_ROLL_PER_G = 9e-3;
const NECK_ROLL_LIMIT = 0.028;
const NECK_PITCH_PER_G = 75e-4;
const NECK_PITCH_LIMIT = 0.023;
const HORIZON_LOCK = 0.18;
const LOOK_MAX = 12 * DEG;
const LOOK_MAX_HELMET = 16 * DEG;
const LOOK_MANUAL = 62 * DEG;
function verticalFov(horizontalDeg, aspect) {
  const halfTan = Math.tan(clamp(horizontalDeg, 8, 150) * 0.5 * DEG);
  const a = Number.isFinite(aspect) && aspect > 0.2 ? aspect : 16 / 9;
  return 2 * Math.atan(halfTan / a) * RAD;
}
const FOV_REF_SPEED = 340 / 3.6;
const FOV_SPEED_GAIN = 4.4;
const FOV_DRS_GAIN = 1.4;
const IMPACT_DECAY = 5;
const IMPACT_IMPULSE_REF = 9e3;
const SUSPENSION_REF = 1.35;
const CHASE_DISTANCE = 7.4;
const CHASE_STRETCH = 0.6;
const CHASE_HEIGHT = 1.95;
const CHASE_SIDE = 1.35;
const CHASE_AIM_AHEAD = 0.9;
const CHASE_AIM_RISE = -0.1;
const CHASE_FOV_SCALE = 0.62;
const TRACKSIDE_LEAD = 58;
const TRACKSIDE_HANDOVER = 20;
const TRACKSIDE_HEIGHT = 9;
const TRACKSIDE_FENCE_CLEAR = 2;
const TRACKSIDE_OFFSET_MIN = 7;
const TRACKSIDE_OFFSET_MAX = 17;
const TRACKSIDE_WALL_PROBE = 26;
const TRACKSIDE_WALL_STEP = 1.5;
const TRACKSIDE_SUBJECT = 17;
const TRACKSIDE_AIM_RISE = 1.05;
const TRACKSIDE_OPERATOR_LEAD = 0.06;
const TRACKSIDE_FOV_MIN = 15;
const TRACKSIDE_FOV_MAX = 40;
const COMPOSITIONS = {
  neutral: { yaw: 0, pitch: 0, offset: [0, 0, 0], fov: 1 },
  grid: { mode: "cockpit", yaw: -9, pitch: -1.5, offset: [0.032, 8e-3, 0], fov: 1 },
  straight: { mode: "cockpit", yaw: 5, pitch: 1, offset: [-0.024, 0, 0], fov: 0.98 },
  braking: { mode: "cockpit", yaw: -12, pitch: -3, offset: [0.034, -0.01, 0], fov: 1.02 },
  apex: { mode: "helmet", yaw: -4, pitch: -1, offset: [-0.03, 0, 0], fov: 0.97 },
  pack: { mode: "cockpit", yaw: -14, pitch: 0.5, offset: [0.036, 0, 0], fov: 1.03 },
  sunset: { mode: "cockpit", yaw: 5, pitch: 2.4, offset: [-0.036, 0.012, 0], fov: 0.96 },
  wet: { mode: "cockpit", yaw: -8, pitch: -1.6, offset: [0.028, 0, 0], fov: 1 },
  night: { mode: "helmet", yaw: 7, pitch: 1.8, offset: [-0.024, 0.01, 0], fov: 0.99 }
};
const WET_WEATHER = new Set(["wet", "rain", "storm"]);
function buildComposition(spec) {
  return {
    mode: spec.mode ?? null,
    yaw: (spec.yaw ?? 0) * DEG,
    pitch: (spec.pitch ?? 0) * DEG,
    offsetX: spec.offset?.[0] ?? 0,
    offsetY: spec.offset?.[1] ?? 0,
    offsetZ: spec.offset?.[2] ?? 0,
    fov: spec.fov ?? 1
  };
}
const COMPOSITION_CACHE = new Map();
function composition(name) {
  const spec = COMPOSITIONS[name] ?? COMPOSITIONS.neutral;
  let built = COMPOSITION_CACHE.get(spec);
  if (!built) {
    built = buildComposition(spec);
    COMPOSITION_CACHE.set(spec, built);
  }
  return built;
}
function compositionFor(params) {
  const explicit = params.get("composition");
  if (explicit && COMPOSITIONS[explicit]) return explicit;
  const scenario = params.get("scenario");
  if (!scenario) return "neutral";
  if (scenario === "straight") {
    if (WET_WEATHER.has(params.get("weather"))) return "wet";
    const tod = params.has("tod") ? Number(params.get("tod")) : NaN;
    if (Number.isFinite(tod)) {
      if (tod >= 19.5 || tod < 6.5) return "night";
      if (tod >= 16.8) return "sunset";
    }
    return "straight";
  }
  return COMPOSITIONS[scenario] ? scenario : "neutral";
}
const EYE_FALLBACK_Y = 0.44;
const EYE_FALLBACK_Z = -0.3;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _carPos = new THREE.Vector3();
const _carQuat = new THREE.Quaternion();
const _carScale = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _aimTarget = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");
const _shakeQuat = new THREE.Quaternion();
function hash1(n) {
  let h = n | 0;
  h = Math.imul(h ^ h >>> 15, 739982445);
  h ^= h >>> 12;
  h = Math.imul(h, 695872825);
  h ^= h >>> 15;
  return (h >>> 0) / 2147483648 - 1;
}
function valueNoise(seed, x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const base = seed * 1013;
  return lerp(hash1(i + base), hash1(i + 1 + base), u);
}
function roadNoise(seed, phase) {
  return valueNoise(seed, phase * 4) + 0.55 * valueNoise(seed + 7, phase * 9.5) + 0.3 * valueNoise(seed + 19, phase * 21);
}
export class CameraRig {
  static systemName = "cameraRig";
  constructor() {
    this.mode = "cockpit";
    this.camera = null;
    this.viewProjection = new THREE.Matrix4();
    this.viewProjectionPrev = new THREE.Matrix4();
    this._neck = new Float64Array(3);
    this._neckVel = new Float64Array(3);
    this._look = 0;
    this._lookManual = 0;
    this._shake = 0;
    this._shakeScale = 1;
    this._shakePhase = 0;
    this._stationFov = 34;
    this._impact = 0;
    this._impactPitch = 0;
    this._fov = 0;
    this._near = 0.06;
    this._orbit = 0;
    this._elapsed = 0;
    this._chasePos = new THREE.Vector3();
    this._chaseAim = new THREE.Vector3();
    this._chaseValid = false;
    this._stationPos = new THREE.Vector3();
    this._stationAim = new THREE.Vector3();
    this._stationT = -1;
    this._stationValid = false;
    this._stationSeated = false;
    this._composition = composition("neutral");
    this.compositionName = "neutral";
    this._modeLocked = false;
    this._locate = null;
    this._surface = null;
    this._sample = null;
    this._cut = true;
    this._vpValid = false;
    this._player = null;
    this._anchor = null;
  }
  async init(ctx) {
    this.ctx = ctx;
    this.camera = ctx.camera;
    this._fov = ctx.settings?.get?.("fov") ?? 82;
    const params = new URLSearchParams(globalThis.location?.search ?? "");
    const requested = params.get("camera");
    if (requested && MODES.includes(requested)) {
      this.mode = requested;
      this._modeLocked = true;
    }
    this.setComposition(compositionFor(params));
    this._onMode = (payload) => {
      if (payload?.mode && MODES.includes(payload.mode)) this.setMode(payload.mode);
      else if (payload?.cycle !== false) this.cycle();
    };
    this._onCollision = (payload) => this._registerImpact(payload);
    ctx.events?.on("camera:mode", this._onMode);
    ctx.events?.on("car:collision", this._onCollision);
    const track = ctx.track;
    if (track?.surface?.createLocateResult) {
      this._locate = track.surface.createLocateResult();
      this._surface = track.surface.createSurfaceResult();
      this._sample = track.surface.createLocateResult();
    } else if (track) {
      this._locate = track.locate(this.camera.position);
      this._surface = track.surfaceAt(this.camera.position);
      this._sample = track.sample(0);
    }
    this._bindPlayer(ctx);
  }
  get modes() {
    return MODES;
  }
  setComposition(name) {
    this._composition = composition(name);
    this.compositionName = COMPOSITIONS[name] ? name : "neutral";
    if (this._composition.mode && !this._modeLocked) this.setMode(this._composition.mode);
    this._cut = true;
  }
  setMode(mode) {
    if (!MODES.includes(mode) || mode === this.mode) return;
    this.mode = mode;
    this._chaseValid = false;
    this._stationValid = false;
    this._stationT = -1;
    this._lookManual = 0;
    this._cut = true;
    this.ctx?.events?.emit("camera:changed", { mode });
  }
  cycle() {
    const i = MODES.indexOf(this.mode);
    this.setMode(MODES[(i + 1) % MODES.length]);
  }
  _bindPlayer(ctx) {
    const cars = resolveCars(ctx);
    this._player = cars.length > 0 ? cars[0] : null;
    this._anchor = this._player?.cockpit?.cameraAnchor ?? null;
    return this._player;
  }
  _playerState(ctx) {
    if (ctx.vehicle?.state) return ctx.vehicle.state;
    return this._player?.physics?.state ?? null;
  }
  _registerImpact(payload) {
    const impulse = payload?.impulse ?? 0;
    if (impulse <= 0) return;
    const energy = clamp01(impulse / IMPACT_IMPULSE_REF);
    if (energy <= this._impact) return;
    this._impact = energy;
    this._impactPitch = payload?.section === "rear" ? energy : -energy;
  }
  update(dt, ctx) {
    if (!this._player || !this._anchor) this._bindPlayer(ctx);
    this._elapsed += dt;
    this._orbit += dt;
    const state = this._playerState(ctx);
    const settings = ctx.settings;
    const headScale = clamp(settings?.get?.("headMovement") ?? 1, 0, 2);
    const shakeScale = clamp(settings?.get?.("cameraShake") ?? 1, 0, 2);
    this._integrateNeck(dt, state);
    this._integrateLook(dt, state, ctx, headScale);
    this._integrateShake(dt, state, ctx, shakeScale);
    this._integrateFov(dt, state, settings);
    const impactDecay = this._impact > 1e-4 ? Math.exp(-dt * IMPACT_DECAY) : 0;
    this._impact *= impactDecay;
    this._impactPitch *= impactDecay;
    if (this.mode === "chase") this._integrateChase(dt, ctx, state);
    else if (this.mode === "trackside") this._integrateTrackside(dt, ctx, state);
  }
  _integrateNeck(dt, state) {
    const gx = state ? state.gForce.x : 0;
    const gy = state ? state.gForce.y - 1 : 0;
    const gz = state ? state.gForce.z : 0;
    const target0 = -gx;
    const target1 = -gy;
    const target2 = gz;
    const w2 = NECK_OMEGA * NECK_OMEGA;
    const twoW = 2 * NECK_OMEGA;
    this._neckVel[0] += (w2 * (target0 - this._neck[0]) - twoW * this._neckVel[0]) * dt;
    this._neckVel[1] += (w2 * (target1 - this._neck[1]) - twoW * this._neckVel[1]) * dt;
    this._neckVel[2] += (w2 * (target2 - this._neck[2]) - twoW * this._neckVel[2]) * dt;
    this._neck[0] += this._neckVel[0] * dt;
    this._neck[1] += this._neckVel[1] * dt;
    this._neck[2] += this._neckVel[2] * dt;
  }
  _integrateLook(dt, state, ctx, headScale) {
    const controls = ctx.input?.controls;
    const speed = state ? Math.abs(state.speed) : 0;
    const steer = state ? state.steer : 0;
    const cap = this.mode === "helmet" ? LOOK_MAX_HELMET : LOOK_MAX;
    const speedGate = smoothstep(6, 42, speed) * (1 - 0.35 * smoothstep(60, 95, speed));
    const target = clamp(-steer * cap * speedGate, -cap, cap) * headScale;
    this._look = damp(this._look, target, 6.5, dt);
    let manual = 0;
    if (controls) {
      if (controls.lookBack) manual = Math.PI;
      else manual = (controls.lookLeft ?? 0) * LOOK_MANUAL - (controls.lookRight ?? 0) * LOOK_MANUAL;
    }
    this._lookManual = damp(this._lookManual, manual, 11, dt);
  }
  _integrateShake(dt, state, ctx, shakeScale) {
    let target = 0;
    if (state) {
      let susp = 0;
      for (let i = 0; i < 4; i++) {
        const w = state.wheels[i];
        const v = w.suspension.velocity;
        susp += v < 0 ? -v : v;
      }
      susp *= 0.25;
      let roughness = 0.05;
      const track = ctx.track;
      if (track && this._surface) {
        track.surfaceAt(state.position, this._surface);
        roughness = this._surface.roughness;
      }
      const speedGate = smoothstep(3, 30, Math.abs(state.speed));
      const kerb = state.kerbContact ? 0.55 : 0;
      const air = state.airborne ? 0.25 : 0;
      target = clamp01(susp / SUSPENSION_REF) * (0.3 + roughness * 1.35) + kerb + air;
      target = clamp01(target) * speedGate;
    }
    const rate = target > this._shake ? 26 : 7;
    this._shake = damp(this._shake, target, rate, dt);
    this._shakeScale = shakeScale;
    this._shakePhase += dt * (0.7 + this._shake * 1.1);
  }
  _integrateFov(dt, state, settings) {
    const base = settings?.get?.("fov") ?? 82;
    let target = base * this._composition.fov;
    if (this.mode === "chase") target = base * CHASE_FOV_SCALE;
    else if (this.mode === "trackside") target = this._stationFov;
    else if (this.mode === "replay") target = 36;
    if (this.mode !== "trackside" && this.mode !== "replay") {
      const speed = state ? Math.abs(state.speed) : 0;
      const t = clamp01(speed / FOV_REF_SPEED);
      target += FOV_SPEED_GAIN * (t * t * (3 - 2 * t) * 0.55 + t * 0.45);
      if (state?.drs.open) target += FOV_DRS_GAIN;
      target += this._impact * 1.4;
    }
    const rate = this.mode === "trackside" ? 6 : 2.6;
    this._fov = damp(this._fov, target, rate, dt);
  }
  _integrateChase(dt, ctx, state) {
    const car = this._player;
    if (!car || !state) return;
    _carPos.copy(state.position);
    _carQuat.copy(state.quaternion);
    _fwd.set(0, 0, -1).applyQuaternion(_carQuat);
    _fwd.y *= 0.35;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    _up.set(0, 1, 0);
    _right.crossVectors(_fwd, _up);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    const speed = Math.abs(state.speed);
    const back = CHASE_DISTANCE + smoothstep(0, 90, speed) * CHASE_STRETCH;
    _desired.copy(_carPos).addScaledVector(_fwd, -back);
    _desired.addScaledVector(_right, CHASE_SIDE);
    _desired.y += CHASE_HEIGHT;
    const ground = ctx.track?.heightAt?.(_desired.x, _desired.z);
    if (Number.isFinite(ground) && _desired.y < ground + 0.85) _desired.y = ground + 0.85;
    _aimTarget.copy(_carPos).addScaledVector(_fwd, CHASE_AIM_AHEAD);
    _aimTarget.y += CHASE_AIM_RISE;
    if (!this._chaseValid) {
      this._chasePos.copy(_desired);
      this._chaseAim.copy(_aimTarget);
      this._chaseValid = true;
    }
    const follow = 6 + smoothstep(0, 90, speed) * 5;
    const leadFlat = 1 / follow;
    const leadRise = 1 / (follow * 0.7);
    _v.copy(state.velocity);
    this._chasePos.x = damp(this._chasePos.x, _desired.x + _v.x * leadFlat, follow, dt);
    this._chasePos.y = damp(this._chasePos.y, _desired.y + _v.y * leadRise, follow * 0.7, dt);
    this._chasePos.z = damp(this._chasePos.z, _desired.z + _v.z * leadFlat, follow, dt);
    _aimTarget.addScaledVector(_v, 1 / 9);
    this._chaseAim.x = damp(this._chaseAim.x, _aimTarget.x, 9, dt);
    this._chaseAim.y = damp(this._chaseAim.y, _aimTarget.y, 9, dt);
    this._chaseAim.z = damp(this._chaseAim.z, _aimTarget.z, 9, dt);
  }
  _integrateTrackside(dt, ctx, state) {
    const track = ctx.track;
    if (!track || !state || !this._locate || !this._sample) return;
    track.locate(state.position, this._locate);
    const carT = this._locate.t;
    const lead = TRACKSIDE_LEAD / track.length;
    const gap = deltaT(carT, this._stationT) * track.length;
    if (!this._stationValid || gap < TRACKSIDE_HANDOVER || gap > TRACKSIDE_LEAD + 2) {
      this._placeStation(track, wrap01(carT + lead));
    }
    _aimTarget.copy(state.position);
    _aimTarget.addScaledVector(state.velocity, TRACKSIDE_OPERATOR_LEAD + 1 / 7.5);
    _aimTarget.y += TRACKSIDE_AIM_RISE;
    if (!this._stationValid) {
      this._stationAim.copy(_aimTarget);
      this._stationValid = true;
    }
    this._stationAim.x = damp(this._stationAim.x, _aimTarget.x, 7.5, dt);
    this._stationAim.y = damp(this._stationAim.y, _aimTarget.y, 7.5, dt);
    this._stationAim.z = damp(this._stationAim.z, _aimTarget.z, 7.5, dt);
    const dist = Math.max(8, this._stationPos.distanceTo(state.position));
    this._stationFov = clamp(
      2 * Math.atan(TRACKSIDE_SUBJECT * 0.5 / dist) * RAD,
      TRACKSIDE_FOV_MIN,
      TRACKSIDE_FOV_MAX
    );
    if (this._stationSeated) {
      this._stationSeated = false;
      this._fov = this._stationFov;
    }
  }
  _wallOffset(track, s, side) {
    const out = this._surface;
    const fallback = s.width + TRACKSIDE_OFFSET_MAX;
    if (!out || typeof track.surfaceAt !== "function") return fallback;
    let lo = s.width;
    let hi = 0;
    for (let a = s.width + TRACKSIDE_WALL_STEP; a <= s.width + TRACKSIDE_WALL_PROBE; a += TRACKSIDE_WALL_STEP) {
      _v.copy(s.position).addScaledVector(s.right, side * a);
      track.surfaceAt(_v, out);
      if (out.type === "wall") {
        hi = a;
        break;
      }
      lo = a;
    }
    if (hi === 0) return fallback;
    for (let i = 0; i < 5; i++) {
      const mid = (lo + hi) * 0.5;
      _v.copy(s.position).addScaledVector(s.right, side * mid);
      track.surfaceAt(_v, out);
      if (out.type === "wall") hi = mid;
      else lo = mid;
    }
    return hi;
  }
  _placeStation(track, t) {
    const s = track.sample(t, this._sample);
    let side;
    if (Math.abs(s.curvature) > 25e-4) {
      side = s.curvature > 0 ? 1 : -1;
    } else {
      side = this._wallOffset(track, s, 1) >= this._wallOffset(track, s, -1) ? 1 : -1;
    }
    const wall = this._wallOffset(track, s, side);
    const offset = clamp(
      wall + TRACKSIDE_FENCE_CLEAR,
      s.width + TRACKSIDE_OFFSET_MIN,
      s.width + TRACKSIDE_OFFSET_MAX
    );
    _v.copy(s.position).addScaledVector(s.right, side * offset);
    const ground = track.heightAt(_v.x, _v.z);
    _v.y = (Number.isFinite(ground) ? ground : s.position.y) + TRACKSIDE_HEIGHT;
    this._stationPos.copy(_v);
    this._stationT = t;
    this._stationSeated = true;
    this._cut = true;
  }
  lateUpdate(alpha, ctx) {
    const camera = this.camera;
    if (!camera) return;
    if (!this._player || !this._anchor) this._bindPlayer(ctx);
    switch (this.mode) {
      case "cockpit":
      case "helmet":
        this._applyCockpit(ctx);
        break;
      case "chase":
        this._applyChase();
        break;
      case "trackside":
        this._applyTrackside();
        break;
      default:
        this._applyReplay(ctx);
        break;
    }
    this._applyProjection(camera);
    this._commitMatrices(camera, ctx);
  }
  _applyCockpit(ctx) {
    const camera = this.camera;
    const anchor = this._anchor;
    const state = this._playerState(ctx);
    const headScale = clamp(ctx.settings?.get?.("headMovement") ?? 1, 0, 2);
    if (anchor) {
      if (camera.parent !== anchor) {
        anchor.add(camera);
        this._cut = true;
      }
    } else {
      if (!state) return;
      if (camera.parent) {
        camera.removeFromParent();
        this._cut = true;
      }
    }
    const helmet = this.mode === "helmet";
    const gain = helmet ? 1.45 : 1;
    const tx = clamp(this._neck[0] * NECK_TRANSLATE_X * gain, -NECK_TRANSLATE_LIMIT, NECK_TRANSLATE_LIMIT);
    const ty = clamp(this._neck[1] * NECK_TRANSLATE_Y, -NECK_TRANSLATE_LIMIT, NECK_TRANSLATE_LIMIT);
    const tz = clamp(this._neck[2] * NECK_TRANSLATE_Z, -NECK_TRANSLATE_LIMIT, NECK_TRANSLATE_LIMIT);
    const amp = this._shake * this._shakeScale;
    const impact = this._impact * this._shakeScale;
    const phase = this._shakePhase;
    const nx = roadNoise(1, phase);
    const ny = roadNoise(2, phase);
    const nz = roadNoise(3, phase);
    const nr = roadNoise(4, phase);
    const comp = this._composition;
    const offsetX = tx * headScale + nx * amp * 6e-3 + comp.offsetX;
    const offsetY = ty * headScale + ny * amp * 0.016 + (helmet ? 0.02 : 0) + comp.offsetY;
    const offsetZ = tz * headScale + nz * amp * 4e-3 + (helmet ? -0.055 : 0) + comp.offsetZ;
    let pitch = clamp(this._neck[2] * -NECK_PITCH_PER_G, -NECK_PITCH_LIMIT, NECK_PITCH_LIMIT) * headScale;
    let roll = clamp(this._neck[0] * -NECK_ROLL_PER_G, -NECK_ROLL_LIMIT, NECK_ROLL_LIMIT) * headScale;
    if (state && headScale > 0) {
      _right.set(1, 0, 0).applyQuaternion(state.quaternion);
      _up.set(0, 1, 0).applyQuaternion(state.quaternion);
      const bodyRoll = -Math.atan2(_right.y, _up.y);
      roll += clamp(bodyRoll * HORIZON_LOCK, -0.09, 0.09) * headScale;
    }
    pitch += ny * amp * 0.01 + this._impactPitch * 0.035 + comp.pitch;
    roll += nr * amp * 0.012 + impact * roadNoise(6, phase * 3) * 0.02;
    const yaw = this._look + this._lookManual + nx * amp * 7e-3 + impact * roadNoise(5, phase * 3) * 0.015 + comp.yaw;
    if (anchor) {
      camera.position.set(offsetX, offsetY, offsetZ);
      camera.rotation.set(pitch, yaw, roll, "YXZ");
      return;
    }
    _euler.set(pitch, yaw, roll, "YXZ");
    _q.setFromEuler(_euler);
    camera.quaternion.copy(state.quaternion).multiply(_q);
    _v.set(offsetX, EYE_FALLBACK_Y + offsetY, EYE_FALLBACK_Z + offsetZ).applyQuaternion(state.quaternion);
    camera.position.copy(state.position).add(_v);
  }
  _applyChase() {
    const camera = this.camera;
    if (camera.parent) {
      camera.removeFromParent();
      this._cut = true;
    }
    if (!this._chaseValid) return;
    camera.position.copy(this._chasePos);
    camera.up.set(0, 1, 0);
    camera.lookAt(this._chaseAim);
    this._applyWorldShake(camera, 0.55);
  }
  _applyTrackside() {
    const camera = this.camera;
    if (camera.parent) {
      camera.removeFromParent();
      this._cut = true;
    }
    if (!this._stationValid) return;
    camera.position.copy(this._stationPos);
    camera.up.set(0, 1, 0);
    camera.lookAt(this._stationAim);
    const gain = 0.28 * (52 / Math.max(12, this._fov));
    _euler.set(
      roadNoise(11, this._elapsed * 0.35) * 16e-4 * gain,
      roadNoise(12, this._elapsed * 0.31) * 22e-4 * gain,
      0,
      "YXZ"
    );
    _shakeQuat.setFromEuler(_euler);
    camera.quaternion.multiply(_shakeQuat);
  }
  _applyReplay(ctx) {
    const camera = this.camera;
    const state = this._playerState(ctx);
    if (camera.parent) {
      camera.removeFromParent();
      this._cut = true;
    }
    if (!state) return;
    const angle = this._orbit * 0.21;
    const radius = 9.2 - 1.4 * Math.sin(this._orbit * 0.07);
    const height = 1.55 + 0.75 * Math.sin(this._orbit * 0.13 + 1.1);
    _v.set(Math.sin(angle) * radius, height, Math.cos(angle) * radius);
    _v.add(state.position);
    const ground = ctx.track?.heightAt?.(_v.x, _v.z);
    if (Number.isFinite(ground) && _v.y < ground + 0.5) _v.y = ground + 0.5;
    camera.position.copy(_v);
    camera.up.set(0, 1, 0);
    _aimTarget.copy(state.position);
    _aimTarget.y += 0.35;
    camera.lookAt(_aimTarget);
    this._applyWorldShake(camera, 0.35);
  }
  _applyWorldShake(camera, weight) {
    const amp = (this._shake * weight + this._impact) * this._shakeScale;
    if (amp < 1e-4) return;
    const phase = this._shakePhase;
    _euler.set(
      roadNoise(21, phase) * amp * 55e-4 + this._impactPitch * 0.02,
      roadNoise(22, phase) * amp * 45e-4,
      roadNoise(23, phase) * amp * 65e-4,
      "YXZ"
    );
    _shakeQuat.setFromEuler(_euler);
    camera.quaternion.multiply(_shakeQuat);
  }
  _applyProjection(camera) {
    const near = this.mode === "cockpit" || this.mode === "helmet" ? 0.06 : this.mode === "chase" ? 0.3 : 1;
    const fov = clamp(verticalFov(this._fov, camera.aspect), 8, 120);
    if (Math.abs(camera.fov - fov) > 2e-3 || camera.near !== near) {
      camera.fov = fov;
      camera.near = near;
      camera.updateProjectionMatrix();
    }
  }
  _commitMatrices(camera, ctx) {
    if (camera.parent) camera.parent.updateWorldMatrix(true, false);
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    if (this._vpValid && !this._cut) this.viewProjectionPrev.copy(this.viewProjection);
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (!this._vpValid || this._cut) this.viewProjectionPrev.copy(this.viewProjection);
    const pipeline = ctx.pipeline;
    if (pipeline) {
      pipeline.setPreviousViewProjection?.(this.viewProjectionPrev);
      if (this._cut && "_prevMatricesValid" in pipeline) pipeline._prevMatricesValid = false;
    }
    this._vpValid = true;
    this._cut = false;
  }
  resize() {
  }
  dispose() {
    this.ctx?.events?.off?.("camera:mode", this._onMode);
    this.ctx?.events?.off?.("car:collision", this._onCollision);
    this.camera?.removeFromParent();
    this._player = null;
    this._anchor = null;
  }
}
