import * as THREE from "three";
import { clamp, clamp01, smoothstep, lerp } from "../core/MathUtils.js";
import { Rng } from "../core/Rng.js";
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const SMOKE_THRESHOLD = 7500;
const SMOKE_SATURATION = 115e3;
const SMOKE_RATE_MAX = 96;
const DUST_RATE_MAX = 72;
const DEBRIS_RATE_MAX = 26;
const BRAKE_DUST_RATE_MAX = 16;
const SMOKE_LIFE = 2.5;
const SURFACE_DUST = {
  grass: { dust: [0.34, 0.33, 0.19], chunk: [0.2, 0.26, 0.1], yield: 0.85, chunks: 0.55, drag: 2.2 },
  astroturf: { dust: [0.3, 0.36, 0.24], chunk: [0.18, 0.3, 0.14], yield: 0.35, chunks: 0.18, drag: 2.6 },
  gravel: { dust: [0.53, 0.48, 0.4], chunk: [0.34, 0.31, 0.27], yield: 1, chunks: 1, drag: 1.9 },
  sand: { dust: [0.7, 0.61, 0.44], chunk: [0.58, 0.5, 0.36], yield: 1.15, chunks: 0.35, drag: 2.4 },
  concrete: { dust: [0.55, 0.54, 0.52], chunk: [0.45, 0.44, 0.42], yield: 0.22, chunks: 0.1, drag: 2 },
  kerb: { dust: [0.52, 0.44, 0.44], chunk: [0.3, 0.14, 0.14], yield: 0.2, chunks: 0.22, drag: 2 }
};
export class TyreSmoke {
  constructor(particles) {
    this.particles = particles;
    this.rng = new Rng(731730407);
    this.smoke = null;
    this.dust = null;
    this.debris = null;
    this.intensity = 1;
    this.wetness = 0;
    this._rateScale = 1;
  }
  init(ctx) {
    this.smoke = this.particles.pool("smoke");
    this.dust = this.particles.pool("dust");
    this.debris = this.particles.pool("debris");
    this.setQuality(ctx.quality);
    return this;
  }
  setQuality(tier) {
    this._rateScale = clamp((tier?.particleBudget ?? 9e3) / 9e3, 0.2, 1.8);
  }
  update(dt, ctx, fx) {
    const car = fx.car;
    const state = car.physics.state;
    if (!state) return;
    const speed = Math.abs(state.speed);
    const q = state.quaternion;
    _fwd.set(0, 0, -1).applyQuaternion(q);
    _right.set(1, 0, 0).applyQuaternion(q);
    const lod = fx.emissionScale;
    if (lod <= 0.02) return;
    const cfg = car.config;
    const roadSpeed = Math.max(1.2, speed);
    for (let i = 0; i < 4; i++) {
      const w = state.wheels[i];
      if (!w.contact) continue;
      const front = i < 2;
      const radius = front ? cfg.tyres.front.radius : cfg.tyres.rear.radius;
      const groundY = w.worldPosition.y - radius;
      const slipLong = w.slipRatio * roadSpeed;
      const slipLat = roadSpeed * Math.tan(clamp(w.slipAngle, -1.2, 1.2));
      const power = Math.abs(w.fx * slipLong) + Math.abs(w.fy * slipLat);
      const surface = w.surface;
      if (surface === "asphalt" || surface === "kerb" || surface === "concrete") {
        this._rubber(dt, fx, state, w, i, front, power, roadSpeed, groundY, lod);
      }
      const dustCfg = SURFACE_DUST[surface];
      if (dustCfg && dustCfg.yield > 0.05) {
        this._offTrack(dt, fx, state, w, i, dustCfg, roadSpeed, groundY, lod);
      }
      this._brakeDust(dt, fx, state, w, i, front, groundY, lod);
    }
  }
  _rubber(dt, fx, state, w, index, front, power, roadSpeed, groundY, lod) {
    const pool = this.smoke;
    if (!pool) return;
    const load = clamp01(w.load / 5200);
    const temp = w.temperature.surface;
    const heat = 0.45 + 0.55 * smoothstep(80, 132, temp);
    const powerTerm = clamp01((power - SMOKE_THRESHOLD) / (SMOKE_SATURATION - SMOKE_THRESHOLD));
    const lockup = front ? clamp01((w.lockup - 0.18) / 0.62) : 0;
    const spin = !front ? clamp01((w.spin - 0.12) / 0.68) : 0;
    const slide = clamp01((Math.abs(w.slipAngle) - 0.13) / 0.22) * load;
    let mode = 0;
    let strength = powerTerm * 0.55;
    if (lockup > 0.02) {
      strength = Math.max(strength, lockup * (0.35 + 0.65 * powerTerm));
      mode = 1;
    }
    if (spin > 0.02) {
      strength = Math.max(strength, spin * (0.3 + 0.7 * powerTerm));
      mode = 2;
    }
    if (slide > 0.02 && mode === 0) mode = 3;
    strength *= heat * clamp01(0.25 + roadSpeed / 24) * (1 - this.wetness * 0.75);
    strength *= this.intensity;
    if (strength <= 0.015) return;
    const acc = fx.smokeAcc;
    acc[index] += SMOKE_RATE_MAX * strength * this._rateScale * lod * dt;
    let count = acc[index] | 0;
    if (count <= 0) return;
    if (count > 6) count = 6;
    acc[index] -= count;
    const rng = this.rng;
    const b = pool.brush;
    if (mode === 1) {
      b.color(0.9, 0.9, 0.92);
      b.alpha = lerp(0.24, 0.62, strength);
    } else if (mode === 2) {
      b.color(0.66, 0.645, 0.68);
      b.alpha = lerp(0.2, 0.5, strength);
    } else {
      b.color(0.74, 0.735, 0.75);
      b.alpha = lerp(0.1, 0.26, strength);
    }
    b.drag = 1.15;
    b.gravity = -0.55;
    b.groundY = groundY;
    b.turbulence = 0.55 + strength * 0.55;
    b.wind = 0.85;
    b.brightness = 1;
    b.stretch = 0;
    const wake = 0.34 + 0.16 * clamp01(roadSpeed / 70);
    const lateralSign = index % 2 === 0 ? -1 : 1;
    for (let k = 0; k < count; k++) {
      const jitter = rng.next();
      const kick = (mode === 1 ? 2.2 : mode === 2 ? 3.4 : 1.5) * (0.5 + jitter);
      _pos.copy(w.worldPosition);
      _pos.y = groundY + 0.06 + rng.next() * 0.12;
      _pos.addScaledVector(_fwd, -0.22 - rng.next() * 0.35);
      _pos.addScaledVector(_right, lateralSign * (0.06 + rng.next() * 0.14));
      _vel.copy(state.velocity).multiplyScalar(wake);
      _vel.addScaledVector(_fwd, -kick);
      _vel.addScaledVector(_right, lateralSign * (0.7 + rng.next() * 1.5));
      _vel.y += 0.75 + rng.next() * 1.5 + strength * 1.2;
      b.life = SMOKE_LIFE * (0.82 + rng.next() * 0.36);
      b.size0 = 0.2 + rng.next() * 0.16;
      b.size1 = b.size0 + 1.35 + rng.next() * 1.25 + strength * 0.9;
      b.rot = rng.next() * Math.PI * 2;
      b.spin = rng.signed(0.9);
      b.seed = rng.next();
      pool.spawn(_pos.x, _pos.y, _pos.z, _vel.x, _vel.y, _vel.z);
    }
  }
  _offTrack(dt, fx, state, w, index, cfg, roadSpeed, groundY, lod) {
    const pool = this.dust;
    if (!pool) return;
    const load = clamp01(w.load / 4800);
    const surfaceSpeed = Math.max(Math.abs(w.angularVelocity) * 0.36, roadSpeed);
    const strength = clamp01(surfaceSpeed / 26) * (0.35 + 0.65 * load) * cfg.yield * this.intensity * (1 - this.wetness * 0.9);
    if (strength <= 0.02) return;
    const rng = this.rng;
    const acc = fx.dustAcc;
    acc[index] += DUST_RATE_MAX * strength * this._rateScale * lod * dt;
    let count = acc[index] | 0;
    if (count > 5) count = 5;
    acc[index] -= count;
    const b = pool.brush;
    b.color(cfg.dust[0], cfg.dust[1], cfg.dust[2]);
    b.alpha = 0.3 + strength * 0.34;
    b.drag = cfg.drag;
    b.gravity = 1.35;
    b.groundY = groundY;
    b.turbulence = 0.45;
    b.wind = 0.7;
    b.brightness = 1;
    b.stretch = 0;
    const lateralSign = index % 2 === 0 ? -1 : 1;
    for (let k = 0; k < count; k++) {
      _pos.copy(w.worldPosition);
      _pos.y = groundY + 0.05 + rng.next() * 0.1;
      _pos.addScaledVector(_fwd, -0.15 - rng.next() * 0.4);
      _vel.copy(state.velocity).multiplyScalar(0.22);
      _vel.addScaledVector(_fwd, -(1.5 + rng.next() * 4.5));
      _vel.addScaledVector(_right, lateralSign * (1 + rng.next() * 2.2));
      _vel.y += 1.6 + rng.next() * 3.2;
      b.life = 1.5 + rng.next() * 1.4;
      b.size0 = 0.16 + rng.next() * 0.14;
      b.size1 = b.size0 + 0.9 + rng.next() * 1.5;
      b.rot = rng.next() * Math.PI * 2;
      b.spin = rng.signed(1.4);
      b.seed = rng.next();
      pool.spawn(_pos.x, _pos.y, _pos.z, _vel.x, _vel.y, _vel.z);
    }
    if (cfg.chunks > 0.05) this._chunks(dt, fx, state, w, index, cfg, strength, groundY, lod);
  }
  _chunks(dt, fx, state, w, index, cfg, strength, groundY, lod) {
    const pool = this.debris;
    if (!pool) return;
    const acc = fx.debrisAcc;
    acc[index] += DEBRIS_RATE_MAX * strength * cfg.chunks * this._rateScale * lod * dt;
    let count = acc[index] | 0;
    if (count > 4) count = 4;
    acc[index] -= count;
    if (count <= 0) return;
    const rng = this.rng;
    const b = pool.brush;
    b.color(cfg.chunk[0], cfg.chunk[1], cfg.chunk[2]);
    b.alpha = 1;
    b.gravity = 9.80665;
    b.groundY = groundY;
    b.drag = 0;
    b.turbulence = 0;
    b.wind = 0.05;
    b.brightness = 1;
    b.stretch = 0;
    const lateralSign = index % 2 === 0 ? -1 : 1;
    for (let k = 0; k < count; k++) {
      _pos.copy(w.worldPosition);
      _pos.y = groundY + 0.04;
      _vel.copy(state.velocity).multiplyScalar(0.3);
      _vel.addScaledVector(_fwd, -(2.5 + rng.next() * 7));
      _vel.addScaledVector(_right, lateralSign * (1.5 + rng.next() * 3.5));
      _vel.y += 3 + rng.next() * 5.5;
      b.life = 1.1 + rng.next() * 0.9;
      b.size0 = 0.02 + rng.next() * 0.045;
      b.size1 = b.size0;
      b.rot = rng.next() * Math.PI * 2;
      b.spin = rng.signed(9);
      b.seed = rng.next();
      pool.spawn(_pos.x, _pos.y, _pos.z, _vel.x, _vel.y, _vel.z);
    }
  }
  _brakeDust(dt, fx, state, w, index, front, groundY, lod) {
    const pool = this.dust;
    if (!pool) return;
    const temp = state.brakeTemp[index];
    const heat = clamp01((temp - 620) / 380);
    const braking = clamp01(state.brake * 1.4 - 0.15);
    const strength = heat * braking * this.intensity;
    if (strength <= 0.03) return;
    const acc = fx.brakeDustAcc;
    acc[index] += BRAKE_DUST_RATE_MAX * strength * this._rateScale * lod * dt;
    let count = acc[index] | 0;
    if (count > 2) count = 2;
    acc[index] -= count;
    if (count <= 0) return;
    const rng = this.rng;
    const b = pool.brush;
    b.color(0.1, 0.095, 0.1);
    b.alpha = 0.16 + strength * 0.18;
    b.drag = 2.6;
    b.gravity = 0.4;
    b.groundY = groundY;
    b.turbulence = 0.3;
    b.wind = 0.6;
    b.brightness = 1;
    b.stretch = 0;
    const lateralSign = index % 2 === 0 ? -1 : 1;
    for (let k = 0; k < count; k++) {
      _pos.copy(w.worldPosition);
      _pos.addScaledVector(_right, lateralSign * (front ? 0.16 : 0.2));
      _pos.y += rng.signed(0.06);
      _vel.copy(state.velocity).multiplyScalar(0.5);
      _vel.addScaledVector(_fwd, -(1 + rng.next() * 2));
      _vel.addScaledVector(_right, lateralSign * (0.4 + rng.next()));
      _vel.y += 0.4 + rng.next() * 0.8;
      b.life = 0.75 + rng.next() * 0.55;
      b.size0 = 0.06 + rng.next() * 0.05;
      b.size1 = b.size0 + 0.35 + rng.next() * 0.4;
      b.rot = rng.next() * Math.PI * 2;
      b.spin = rng.signed(1.8);
      b.seed = rng.next();
      pool.spawn(_pos.x, _pos.y, _pos.z, _vel.x, _vel.y, _vel.z);
    }
  }
  marbles(dt, fx, state, lateral, width, lod) {
    const pool = this.debris;
    if (!pool) return;
    const speed = Math.abs(state.speed);
    if (speed < 24) return;
    _fwd.set(0, 0, -1).applyQuaternion(state.quaternion);
    _right.set(1, 0, 0).applyQuaternion(state.quaternion);
    const offLine = clamp01((Math.abs(lateral) - width * 0.42) / Math.max(0.8, width * 0.5));
    const strength = offLine * clamp01(speed / 55) * this.intensity;
    if (strength <= 0.05) return;
    fx.marbleAcc += 22 * strength * this._rateScale * lod * dt;
    let count = fx.marbleAcc | 0;
    if (count > 3) count = 3;
    fx.marbleAcc -= count;
    if (count <= 0) return;
    const rng = this.rng;
    const b = pool.brush;
    b.color(0.055, 0.052, 0.055);
    b.alpha = 1;
    b.gravity = 9.80665;
    b.drag = 0;
    b.turbulence = 0;
    b.wind = 0.05;
    b.brightness = 1;
    b.stretch = 0;
    for (let k = 0; k < count; k++) {
      const rear = state.wheels[2 + (rng.next() < 0.5 ? 0 : 1)];
      if (!rear.contact) continue;
      const groundY = rear.worldPosition.y - 0.3625;
      b.groundY = groundY;
      _pos.copy(rear.worldPosition);
      _pos.y = groundY + 0.03;
      _vel.copy(state.velocity).multiplyScalar(0.18);
      _vel.addScaledVector(_fwd, -(1.5 + rng.next() * 4));
      _vel.addScaledVector(_right, rng.signed(2.5));
      _vel.y += 1.8 + rng.next() * 3;
      b.life = 0.9 + rng.next() * 0.7;
      b.size0 = 0.014 + rng.next() * 0.02;
      b.size1 = b.size0;
      b.rot = rng.next() * Math.PI * 2;
      b.spin = rng.signed(11);
      b.seed = rng.next();
      pool.spawn(_pos.x, _pos.y, _pos.z, _vel.x, _vel.y, _vel.z);
    }
  }
  wake(dt, fx, state, lod) {
    const pool = this.smoke;
    if (!pool) return;
    const speed = Math.abs(state.speed);
    if (speed < 32 || this.wetness > 0.25) return;
    _fwd.set(0, 0, -1).applyQuaternion(state.quaternion);
    _right.set(1, 0, 0).applyQuaternion(state.quaternion);
    const strength = clamp01((speed - 32) / 60) * this.intensity;
    fx.wakeAcc += 7 * strength * this._rateScale * lod * dt;
    let count = fx.wakeAcc | 0;
    if (count > 2) count = 2;
    fx.wakeAcc -= count;
    if (count <= 0) return;
    const rng = this.rng;
    const b = pool.brush;
    b.color(0.62, 0.6, 0.58);
    b.alpha = 0.035 + strength * 0.045;
    b.drag = 0.9;
    b.gravity = -0.2;
    b.turbulence = 0.7;
    b.wind = 0.95;
    b.brightness = 1;
    b.stretch = 0;
    for (let k = 0; k < count; k++) {
      const rear = state.wheels[2 + (rng.next() < 0.5 ? 0 : 1)];
      const groundY = rear.worldPosition.y - 0.3625;
      b.groundY = groundY;
      _pos.copy(state.position);
      _pos.addScaledVector(_fwd, -2.6 - rng.next() * 1.2);
      _pos.addScaledVector(_right, rng.signed(0.9));
      _pos.y = groundY + 0.25 + rng.next() * 0.5;
      _vel.copy(state.velocity).multiplyScalar(0.14);
      _vel.y += 0.4 + rng.next() * 0.9;
      b.life = 1.8 + rng.next() * 1.4;
      b.size0 = 0.5 + rng.next() * 0.5;
      b.size1 = b.size0 + 2.4 + rng.next() * 2;
      b.rot = rng.next() * Math.PI * 2;
      b.spin = rng.signed(0.4);
      b.seed = rng.next();
      pool.spawn(_pos.x, _pos.y, _pos.z, _vel.x, _vel.y, _vel.z);
    }
  }
  setWetness(w) {
    this.wetness = clamp01(w);
  }
  dispose() {
    this.smoke = null;
    this.dust = null;
    this.debris = null;
  }
}
