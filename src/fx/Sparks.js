import * as THREE from "three";
import { clamp, clamp01, smoothstep, damp } from "../core/MathUtils.js";
import { Rng } from "../core/Rng.js";
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const PLANK_CLEARANCE = 0.03;
const PLANK_CONTACT = 0.016;
const FLOOR_RATE_MAX = 340;
const KERB_RATE_MAX = 210;
export class Sparks {
  constructor(particles) {
    this.particles = particles;
    this.rng = new Rng(1908648729);
    this.pool = null;
    this.lights = [];
    this._sources = [];
    this._rateScale = 1;
    this.intensity = 1;
    this.wetness = 0;
    this._night = 0.4;
  }
  init(ctx) {
    this.pool = this.particles.pool("sparks");
    this.setQuality(ctx.quality);
    const tier = ctx.quality;
    const count = tier?.particleBudget >= 8e3 ? 3 : tier?.particleBudget >= 3e3 ? 2 : 0;
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(16742946, 0, 9, 2);
      light.name = `fx-spark-light-${i}`;
      light.castShadow = false;
      light.visible = false;
      ctx.scene.add(light);
      this.lights.push(light);
      this._sources.push({ position: new THREE.Vector3(), weight: 0, target: 0, current: 0 });
    }
    return this;
  }
  setQuality(tier) {
    this._rateScale = clamp((tier?.particleBudget ?? 9e3) / 9e3, 0.25, 1.8);
  }
  setWetness(w) {
    this.wetness = clamp01(w);
  }
  _noteLight(x, y, z, weight) {
    const sources = this._sources;
    if (sources.length === 0) return;
    let weakest = 0;
    for (let i = 0; i < sources.length; i++) {
      const s2 = sources[i];
      const dx = s2.position.x - x;
      const dz = s2.position.z - z;
      if (s2.weight > 0 && dx * dx + dz * dz < 9) {
        s2.weight = Math.max(s2.weight, weight);
        s2.position.set(x, y, z);
        return;
      }
      if (s2.weight < sources[weakest].weight) weakest = i;
    }
    const s = sources[weakest];
    if (weight > s.weight) {
      s.weight = weight;
      s.position.set(x, y, z);
    }
  }
  update(dt, ctx, fx) {
    const car = fx.car;
    const state = car.physics.state;
    const speed = Math.abs(state.speed);
    if (speed < 12 || this.wetness > 0.6) return;
    const lod = fx.emissionScale;
    if (lod <= 0.02) return;
    _fwd.set(0, 0, -1).applyQuaternion(state.quaternion);
    _right.set(1, 0, 0).applyQuaternion(state.quaternion);
    this._floor(dt, fx, state, speed, lod);
    this._kerbs(dt, fx, state, speed, lod);
  }
  _floor(dt, fx, state, speed, lod) {
    const pool = this.pool;
    if (!pool) return;
    let grounding = 0;
    let contactX = 0;
    let contactZ = 0;
    let groundY = 0;
    let found = 0;
    for (let i = 0; i < 4; i++) {
      const w = state.wheels[i];
      if (!w.contact) continue;
      const radius = i < 2 ? 0.36 : 0.3625;
      const squash = clamp01((PLANK_CLEARANCE - w.rideHeight) / (PLANK_CLEARANCE - PLANK_CONTACT));
      const bump = clamp01((w.suspension.compression - 0.68) / 0.14) * clamp01((w.suspension.velocity - 0.3) * 2);
      const local = Math.max(squash, bump * 0.85);
      if (local > 0.02) {
        grounding = Math.max(grounding, local);
        contactX += w.worldPosition.x;
        contactZ += w.worldPosition.z;
        groundY += w.worldPosition.y - radius;
        found++;
      }
    }
    if (found === 0 || grounding <= 0.02) return;
    contactX /= found;
    contactZ /= found;
    groundY /= found;
    const speedTerm = clamp01((speed - 14) / 55);
    const strength = grounding * speedTerm * this.intensity * (1 - this.wetness);
    if (strength <= 0.02) return;
    fx.sparkAcc += FLOOR_RATE_MAX * strength * this._rateScale * lod * dt;
    let count = fx.sparkAcc | 0;
    if (count > 14) count = 14;
    fx.sparkAcc -= count;
    if (count <= 0) return;
    const rng = this.rng;
    const b = pool.brush;
    b.gravity = 9.80665;
    b.drag = 0;
    b.turbulence = 0;
    b.wind = 0.02;
    b.groundY = groundY;
    b.alpha = 1;
    for (let k = 0; k < count; k++) {
      const along = -0.4 + rng.next() * 2.4;
      _pos.set(state.position.x, groundY + 0.012, state.position.z);
      _pos.addScaledVector(_fwd, -along);
      _pos.addScaledVector(_right, rng.signed(0.32));
      _vel.copy(state.velocity).multiplyScalar(0.3 + rng.next() * 0.26);
      _vel.addScaledVector(_right, rng.signed(1.4 + speed * 0.03));
      _vel.y = 0.5 + rng.next() * 2.8;
      b.life = 0.42 + rng.next() * 0.55;
      b.size0 = 0.016 + rng.next() * 0.022;
      b.size1 = b.size0 * 0.55;
      b.stretch = 0.012 + rng.next() * 0.016;
      b.brightness = 1.6 + rng.next() * 1.4;
      b.color(1, 0.86, 0.62);
      b.rot = 0;
      b.spin = 0;
      b.seed = rng.next();
      pool.spawn(_pos.x, _pos.y, _pos.z, _vel.x, _vel.y, _vel.z);
    }
    this._noteLight(contactX, groundY + 0.15, contactZ, strength);
  }
  _kerbs(dt, fx, state, speed, lod) {
    const pool = this.pool;
    if (!pool) return;
    let strength = 0;
    let x = 0;
    let y = 0;
    let z = 0;
    let side = 1;
    for (let i = 0; i < 4; i++) {
      const w = state.wheels[i];
      if (!w.contact || w.surface !== "kerb") continue;
      const impact = clamp01((w.suspension.compression - 0.5) / 0.3) * clamp01(0.35 + Math.abs(w.suspension.velocity) * 0.6);
      if (impact > strength) {
        strength = impact;
        x = w.worldPosition.x;
        y = w.worldPosition.y - (i < 2 ? 0.36 : 0.3625);
        z = w.worldPosition.z;
        side = i % 2 === 0 ? -1 : 1;
      }
    }
    strength *= clamp01((speed - 12) / 40) * this.intensity * (1 - this.wetness);
    if (strength <= 0.03) return;
    fx.kerbSparkAcc += KERB_RATE_MAX * strength * this._rateScale * lod * dt;
    let count = fx.kerbSparkAcc | 0;
    if (count > 10) count = 10;
    fx.kerbSparkAcc -= count;
    if (count <= 0) return;
    const rng = this.rng;
    const b = pool.brush;
    b.gravity = 9.80665;
    b.drag = 0;
    b.turbulence = 0;
    b.wind = 0.02;
    b.groundY = y;
    b.alpha = 1;
    for (let k = 0; k < count; k++) {
      _pos.set(x, y + 0.02, z);
      _pos.addScaledVector(_fwd, -(0.1 + rng.next() * 0.6));
      _pos.addScaledVector(_right, side * rng.next() * 0.18);
      _vel.copy(state.velocity).multiplyScalar(0.22 + rng.next() * 0.3);
      _vel.addScaledVector(_right, side * (1.5 + rng.next() * 4.5));
      _vel.y = 1.4 + rng.next() * 4.6;
      b.life = 0.34 + rng.next() * 0.46;
      b.size0 = 0.014 + rng.next() * 0.02;
      b.size1 = b.size0 * 0.5;
      b.stretch = 0.01 + rng.next() * 0.014;
      b.brightness = 1.4 + rng.next() * 1.2;
      b.color(1, 0.82, 0.55);
      b.rot = 0;
      b.spin = 0;
      b.seed = rng.next();
      pool.spawn(_pos.x, _pos.y, _pos.z, _vel.x, _vel.y, _vel.z);
    }
    this._noteLight(x, y + 0.2, z, strength * 0.8);
  }
  burst(x, y, z, nx, ny, nz, energy, groundY) {
    const pool = this.pool;
    if (!pool) return;
    const e = clamp01(energy);
    let count = Math.round(10 + e * 46 * this._rateScale);
    if (count > 60) count = 60;
    const rng = this.rng;
    const b = pool.brush;
    b.gravity = 9.80665;
    b.drag = 0;
    b.turbulence = 0;
    b.wind = 0.02;
    b.groundY = Number.isFinite(groundY) ? groundY : y - 0.4;
    b.alpha = 1;
    for (let k = 0; k < count; k++) {
      const spread = 0.75;
      _vel.set(
        nx + rng.signed(spread),
        ny + rng.signed(spread) + 0.4,
        nz + rng.signed(spread)
      ).normalize().multiplyScalar(3 + e * 22 * (0.4 + rng.next()));
      b.life = 0.35 + rng.next() * 0.6;
      b.size0 = 0.014 + rng.next() * 0.024;
      b.size1 = b.size0 * 0.5;
      b.stretch = 0.01 + rng.next() * 0.018;
      b.brightness = 1.5 + rng.next() * 1.5;
      b.color(1, 0.84, 0.58);
      b.rot = 0;
      b.spin = 0;
      b.seed = rng.next();
      pool.spawn(x, y, z, _vel.x, _vel.y, _vel.z);
    }
    this._noteLight(x, y, z, 0.5 + e * 0.5);
  }
  lateUpdate(alpha, ctx, dt) {
    const sky = ctx.sky;
    if (sky) {
      this._night = 1 - smoothstep(-0.05, 0.28, sky.sunDirection.y);
    }
    const scale = 0.22 + this._night * 0.78;
    for (let i = 0; i < this.lights.length; i++) {
      const s = this._sources[i];
      const light = this.lights[i];
      s.target = s.weight * 14 * scale;
      s.current = damp(s.current, s.target, s.target > s.current ? 26 : 7, dt);
      s.weight *= 0.55;
      if (s.current < 0.02) {
        if (light.visible) light.visible = false;
        continue;
      }
      light.visible = true;
      light.position.copy(s.position);
      light.intensity = s.current;
      const heat = clamp01(s.current / 8);
      light.color.setRGB(1, 0.34 + heat * 0.26, 0.06 + heat * 0.12);
    }
  }
  dispose() {
    for (const light of this.lights) {
      light.parent?.remove(light);
      light.dispose?.();
    }
    this.lights.length = 0;
    this._sources.length = 0;
    this.pool = null;
  }
}
