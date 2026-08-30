import * as THREE from 'three';
import { clamp, clamp01 } from '../core/MathUtils.js';
import { Rng } from '../core/Rng.js';
import { ParticleSystem } from './ParticleSystem.js';
import { TyreSmoke } from './TyreSmoke.js';
import { Sparks } from './Sparks.js';
import { Weather } from './Weather.js';
import { HeatHaze, EXHAUST_LOCAL } from './HeatHaze.js';

/**
 * EffectsSystem (CONTRACT.md §6).
 *
 * Owns one GPU particle engine and the emitters that drive it from vehicle state. It
 * reads `ctx.cars[i].physics.state` and never simulates anything the physics already
 * knows: every rate in here is a function of slip power, load, temperature, ride
 * height or water depth.
 *
 * Ordering matters. `update` runs on the fixed tick and only ever *spawns*; the GPU
 * evaluates every trajectory. `lateUpdate` runs at display rate and does the work that
 * has to agree with the frame being drawn — the particle clock, the screen capture the
 * refraction effects sample, and the camera-locked rain volume.
 */

const _camPos = new THREE.Vector3();
const _v = new THREE.Vector3();
const _exhaust = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/** Beyond this a car's emitters go quiet: it is a speck and its smoke is fog. */
const EMIT_RANGE = 420;

function makeCarFx(car, index) {
  return {
    car,
    index,
    smokeAcc: new Float32Array(4),
    dustAcc: new Float32Array(4),
    debrisAcc: new Float32Array(4),
    brakeDustAcc: new Float32Array(4),
    sprayAcc: new Float32Array(4),
    sparkAcc: 0,
    kerbSparkAcc: 0,
    marbleAcc: 0,
    wakeAcc: 0,
    distance: 0,
    emissionScale: 1,
    lateral: 0,
    width: 8,
    onTrack: true,
    locate: null,
    prevGear: 1,
    popCooldown: 0,
    prevDamage: new Float32Array(3),
  };
}

/** Where on the car each damage section lives, in car-local metres (-Z forward). */
const DAMAGE_SECTIONS = [
  { key: 'front', z: -2.45, y: 0.15 },
  { key: 'rear', z: 2.70, y: 0.35 },
  { key: 'floor', z: 0.40, y: -0.20 },
];

export class EffectsSystem {
  static systemName = 'fx';

  constructor() {
    this.particles = new ParticleSystem();
    this.tyreSmoke = new TyreSmoke(this.particles);
    this.sparks = new Sparks(this.particles);
    this.weather = new Weather(this.particles);
    this.heat = new HeatHaze();

    this.rng = new Rng(0x3d7f21a9);
    this.intensity = 1;
    this.enabled = true;

    this._cars = [];
    this._carCount = -1;
    this._frame = 0;
    this._lastTime = 0;
    this._onQuality = null;
    this._onCollision = null;
    this._onStart = null;
    this.ctx = null;
  }

  async init(ctx) {
    this.ctx = ctx;

    // Pool capacities are fixed here from the starting tier. A later tier change scales
    // emission rates instead of reallocating: dropping several megabytes of instance
    // buffers and regenerating every sprite mid-race would cost a visible hitch, and
    // thinning the cloud gets the same frame time.
    this.particles.init(ctx, ctx.quality?.particleBudget ?? 9000);

    this.tyreSmoke.init(ctx);
    this.sparks.init(ctx);
    this.weather.init(ctx);
    this.heat.init(ctx);

    this._syncCars(ctx);

    this._onQuality = (tier) => {
      this.tyreSmoke.setQuality(tier);
      this.sparks.setQuality(tier);
      this.weather.setQuality(tier);
      this.heat.setQuality(tier);
    };
    ctx.events.on('quality:change', this._onQuality);

    this._onCollision = (payload) => this._collision(payload);
    ctx.events.on('car:collision', this._onCollision);

    this._onStart = () => this.particles.clear();
    ctx.events.on('race:start', this._onStart);

    this._lastTime = (globalThis.performance ?? Date).now();
  }

  /** Build or grow the per-car emitter state. Only allocates when the field changes. */
  _syncCars(ctx) {
    const cars = ctx.cars;
    const n = cars?.length ?? 0;
    // Compare against the field size we last consumed, not against the number of
    // emitters we built: a car without physics is skipped, and comparing lengths would
    // then rebuild the whole table every tick.
    if (n === this._carCount) return;
    this._carCount = n;

    this._cars.length = 0;
    for (let i = 0; i < n; i++) {
      const car = cars[i];
      if (!car?.physics) continue;
      const fx = makeCarFx(car, i);
      // Track.locate allocates its result when none is handed in, so claim one object
      // per car here and reuse it for the rest of the session.
      if (ctx.track?.locate) fx.locate = ctx.track.locate(car.physics.state.position);
      this._cars.push(fx);
    }
  }

  update(dt, ctx) {
    if (!this.enabled) return;
    this._syncCars(ctx);
    this._frame++;

    this.particles.update(dt, ctx);
    this.weather.update(dt, ctx);

    const wet = this.weather.wetness;
    this.tyreSmoke.setWetness(wet);
    this.sparks.setWetness(wet);

    ctx.camera.getWorldPosition(_camPos);
    const track = ctx.track;

    for (let i = 0; i < this._cars.length; i++) {
      const fx = this._cars[i];
      const state = fx.car.physics.state;
      const distance = state.position.distanceTo(_camPos);
      fx.distance = distance;
      // Distant cars still emit — you have to see the spray of the car ahead — but the
      // rate falls off quickly with distance so the pack behind cannot spend the pool
      // that the car you are actually looking at needs.
      fx.emissionScale = distance > EMIT_RANGE ? 0
        : clamp(1.1 - distance / 130, i === 0 ? 0.9 : 0.10, 1);

      if (fx.emissionScale <= 0) continue;

      // The lateral position only feeds marble pickup and spray depth, so a fifteen-hertz
      // refresh staggered across the field is far more than it needs.
      if (track?.locate && fx.locate && ((this._frame + i) & 7) === 0) {
        track.locate(state.position, fx.locate);
        fx.lateral = fx.locate.lateral;
        fx.width = fx.locate.width;
        fx.onTrack = fx.locate.onTrack;
      }

      this.tyreSmoke.update(dt, ctx, fx);
      this.tyreSmoke.marbles(dt, fx, state, fx.lateral, fx.width, fx.emissionScale);
      this.tyreSmoke.wake(dt, fx, state, fx.emissionScale);
      this.sparks.update(dt, ctx, fx);
      this.weather.updateCar(dt, ctx, fx);
      this._exhaust(dt, fx, state);
      if (i !== 0) this._contact(fx, state);
    }
  }

  /**
   * Overrun and downshift pops. Closing the throttle at high rpm dumps unburnt fuel
   * into a 700 C exhaust and it lights in the pipe — the crack and the flame you get
   * on every downshift into a slow corner.
   */
  _exhaust(dt, fx, state) {
    const pool = this.particles.pool('flame');
    if (!pool) return;

    if (fx.popCooldown > 0) fx.popCooldown -= dt;

    const gear = state.gear;
    const downshift = gear < fx.prevGear && gear > 0;
    fx.prevGear = gear;

    const overrun = state.throttle < 0.22 && state.rpm > 8200 && Math.abs(state.speed) > 18;
    let strength = 0;
    if (downshift && overrun) strength = 1;
    else if (overrun && fx.popCooldown <= 0 && this.rng.next() < dt * 3.2) strength = 0.45 + this.rng.next() * 0.35;
    if (strength <= 0) return;
    fx.popCooldown = 0.08;

    const q = state.quaternion;
    _exhaust.set(EXHAUST_LOCAL[0], EXHAUST_LOCAL[1], EXHAUST_LOCAL[2]).applyQuaternion(q).add(state.position);
    _fwd.set(0, 0, -1).applyQuaternion(q);

    const rng = this.rng;
    const b = pool.brush;
    b.color(2.6, 0.92, 0.26);
    b.alpha = 0.85;
    b.drag = 5.5;
    b.gravity = -1.6;
    b.groundY = _exhaust.y - 1.5;
    b.turbulence = 0.2;
    b.wind = 0.3;
    b.stretch = 0;
    b.spin = 0;

    const count = Math.round((5 + rng.next() * 7) * strength * this.intensity);
    for (let k = 0; k < count; k++) {
      _v.copy(state.velocity).multiplyScalar(0.85);
      _v.addScaledVector(_fwd, -(5 + rng.next() * 11) * strength);
      _v.x += rng.signed(1.2);
      _v.y += rng.signed(0.9) + 0.6;
      _v.z += rng.signed(1.2);

      b.life = 0.075 + rng.next() * 0.13;
      b.size0 = 0.05 + rng.next() * 0.05;
      b.size1 = b.size0 + 0.18 + rng.next() * 0.30 * strength;
      b.rot = rng.next() * Math.PI * 2;
      b.brightness = 1.3 + rng.next() * 1.5;
      b.seed = rng.next();
      pool.spawn(
        _exhaust.x + rng.signed(0.04),
        _exhaust.y + rng.signed(0.04),
        _exhaust.z + rng.signed(0.04),
        _v.x, _v.y, _v.z,
      );
    }

    // A hard pop pushes a little soot out with the flame.
    if (strength > 0.9) {
      const smoke = this.particles.pool('smoke');
      if (!smoke) return;
      const sb = smoke.brush;
      sb.color(0.11, 0.105, 0.10);
      sb.alpha = 0.30;
      sb.drag = 3.2;
      sb.gravity = -0.9;
      sb.groundY = _exhaust.y - 1.5;
      sb.turbulence = 0.5;
      sb.wind = 0.8;
      sb.brightness = 1;
      sb.stretch = 0;
      for (let k = 0; k < 2; k++) {
        _v.copy(state.velocity).multiplyScalar(0.8);
        _v.addScaledVector(_fwd, -(2 + rng.next() * 4));
        _v.y += 0.5 + rng.next();
        sb.life = 0.55 + rng.next() * 0.4;
        sb.size0 = 0.09;
        sb.size1 = 0.7 + rng.next() * 0.5;
        sb.rot = rng.next() * Math.PI * 2;
        sb.spin = rng.signed(1.5);
        sb.seed = rng.next();
        smoke.spawn(_exhaust.x, _exhaust.y, _exhaust.z, _v.x, _v.y, _v.z);
      }
    }
  }

  /**
   * Only the player's physics carries the event bus, so a rival scraping a barrier is
   * detected from the damage it takes instead. Without this the pack can pile into turn
   * one in complete silence, which is the one place the sparks matter most.
   */
  _contact(fx, state) {
    const damage = state.damage;
    const prev = fx.prevDamage;
    let worst = -1;
    let delta = 0;
    for (let s = 0; s < 3; s++) {
      const value = damage[DAMAGE_SECTIONS[s].key];
      const d = value - prev[s];
      prev[s] = value;
      if (d > delta) {
        delta = d;
        worst = s;
      }
    }
    if (worst < 0 || delta < 0.0015) return;

    const section = DAMAGE_SECTIONS[worst];
    _v.set(0, section.y, section.z).applyQuaternion(state.quaternion).add(state.position);
    _fwd.set(0, 0, -1).applyQuaternion(state.quaternion);
    const energy = clamp01(delta * 55);
    const ground = this.ctx?.track?.heightAt ? this.ctx.track.heightAt(_v.x, _v.z) : _v.y - 0.4;
    this.sparks.burst(
      _v.x, _v.y, _v.z,
      -_fwd.x * 0.6 + this.rng.signed(0.5), 0.4, -_fwd.z * 0.6 + this.rng.signed(0.5),
      energy,
      Number.isFinite(ground) ? ground : _v.y - 0.4,
    );
  }

  _collision(payload) {
    if (!payload || !this.enabled) return;
    const p = payload.position;
    if (!p) return;
    // Carbon and metal on a steel barrier: the harder the hit, the wider the shower.
    const energy = clamp01((payload.impulse ?? 0) / 5200);
    if (energy < 0.05) return;
    const ctx = this.ctx;
    const ground = ctx?.track?.heightAt ? ctx.track.heightAt(p.x, p.z) : p.y - 0.4;
    this.sparks.burst(
      p.x, p.y, p.z,
      this.rng.signed(0.6), 0.35, this.rng.signed(0.6),
      energy,
      Number.isFinite(ground) ? ground : p.y - 0.4,
    );
  }

  lateUpdate(alpha, ctx) {
    if (!this.enabled) return;

    const now = (globalThis.performance ?? Date).now();
    let frameDt = (now - this._lastTime) / 1000;
    this._lastTime = now;
    if (!(frameDt > 0) || frameDt > 0.25) frameDt = 1 / 60;

    this.particles.lateUpdate(alpha, ctx);

    this.heat.begin();
    for (let i = 0; i < this._cars.length; i++) this.heat.addCar(ctx, this._cars[i]);
    this.heat.addHorizon(ctx);

    // One framebuffer copy serves both refraction consumers, and only when one of them
    // is actually going to sample it.
    const needScene = this.heat.enabled
      && (this.heat.sourceCount > 0 || this.weather.rainIntensity > 0.02);
    if (needScene) this.heat.captureFrame(ctx);
    this.heat.commit(ctx);

    this.weather.lateUpdate(alpha, ctx, frameDt, this.heat.sceneTexture);
    this.sparks.lateUpdate(alpha, ctx, frameDt);
  }

  resize(width, height, ctx) {
    this.heat.resize(width, height, ctx);
  }

  /** Public: a one-off spark shower, for anything outside the physics collision path. */
  sparkBurst(x, y, z, nx, ny, nz, energy, groundY) {
    this.sparks.burst(x, y, z, nx, ny, nz, energy, groundY);
  }

  /** Public: force the road wetness, independent of the sky's rain rate. */
  setWetness(w) {
    this.weather.setWetness(w);
  }

  get wetness() {
    return this.weather.wetness;
  }

  /** Global scale on every emitter, for photo mode and the performance fallback. */
  setIntensity(value) {
    const k = clamp(value, 0, 2);
    this.intensity = k;
    this.tyreSmoke.intensity = k;
    this.sparks.intensity = k;
    this.weather.intensity = k;
  }

  stats() {
    const s = this.particles.stats();
    s.hazeSources = this.heat.sourceCount;
    s.wetness = this.weather.wetness;
    return s;
  }

  dispose() {
    const ctx = this.ctx;
    if (ctx?.events) {
      if (this._onQuality) ctx.events.off('quality:change', this._onQuality);
      if (this._onCollision) ctx.events.off('car:collision', this._onCollision);
      if (this._onStart) ctx.events.off('race:start', this._onStart);
    }
    this._onQuality = null;
    this._onCollision = null;
    this._onStart = null;

    this.tyreSmoke.dispose();
    this.sparks.dispose();
    this.weather.dispose();
    this.heat.dispose();
    this.particles.dispose();
    this._cars.length = 0;
    this._carCount = -1;
    this.ctx = null;
  }
}
