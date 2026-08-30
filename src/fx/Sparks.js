import * as THREE from 'three';
import { clamp, clamp01, smoothstep, damp } from '../core/MathUtils.js';
import { Rng } from '../core/Rng.js';

/**
 * Skid-block and kerb sparks.
 *
 * Modern cars run a wooden plank under the floor with titanium skid blocks bolted
 * through it. At speed the aerodynamic load squeezes the ride height to nothing and
 * those blocks grind the asphalt: titanium burns at a much lower temperature than the
 * old steel skids, which is exactly why the sparks come out white and stay lit long
 * enough to bounce down the track behind the car. Reproducing that means three things
 * the effect cannot cheat — the sparks must leave the floor and not the bodywork, they
 * must bounce off the road, and they must cool from white through orange to red inside
 * their half-second life.
 */

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();

/**
 * Ride height, in metres, at which the skid blocks start and finish touching down.
 *
 * The physics reports ride height at the aero reference plane, and the titanium blocks
 * bolted through the plank hang roughly two centimetres below it, so the road arrives
 * at the blocks while the reference plane still reads about 30 mm. Telemetry over a
 * full-field run bottoms the front axle out at 18 mm, which is where the shower is at
 * its hardest.
 */
const PLANK_CLEARANCE = 0.030;
const PLANK_CONTACT = 0.016;

/** Particles per second at a full-load, full-speed floor strike. */
const FLOOR_RATE_MAX = 340;
const KERB_RATE_MAX = 210;

export class Sparks {
  constructor(particles) {
    this.particles = particles;
    this.rng = new Rng(0x71c3ab19);
    this.pool = null;
    this.lights = [];
    this._sources = [];
    this._rateScale = 1;
    this.intensity = 1;
    this.wetness = 0;
    this._night = 0.4;
  }

  init(ctx) {
    this.pool = this.particles.pool('sparks');
    this.setQuality(ctx.quality);

    // Lights are created once and never added or removed afterwards: changing the light
    // count in a scene forces every material in it to recompile, which is a hitch you
    // would see the first time anyone touched a kerb.
    const tier = ctx.quality;
    const count = tier?.particleBudget >= 8000 ? 3 : tier?.particleBudget >= 3000 ? 2 : 0;
    for (let i = 0; i < count; i++) {
      const light = new THREE.PointLight(0xff7a22, 0, 9, 2);
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
    this._rateScale = clamp((tier?.particleBudget ?? 9000) / 9000, 0.25, 1.8);
  }

  setWetness(w) {
    // A wet track quenches the spark before it has left the floor.
    this.wetness = clamp01(w);
  }

  /**
   * Bid for one of the dynamic lights. The strongest simultaneous sources win, and a
   * bid close to an existing source merges into it so a shower does not fight itself.
   */
  _noteLight(x, y, z, weight) {
    const sources = this._sources;
    if (sources.length === 0) return;
    let weakest = 0;
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const dx = s.position.x - x;
      const dz = s.position.z - z;
      if (s.weight > 0 && dx * dx + dz * dz < 9) {
        s.weight = Math.max(s.weight, weight);
        s.position.set(x, y, z);
        return;
      }
      if (s.weight < sources[weakest].weight) weakest = i;
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

  /** Plank strike: ride height at any corner squeezed below the skid blocks. */
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
      const radius = i < 2 ? 0.360 : 0.3625;
      // Two independent routes to the road: aero squash at speed, and a compression
      // spike over a crest or a kerb.
      const squash = clamp01((PLANK_CLEARANCE - w.rideHeight) / (PLANK_CLEARANCE - PLANK_CONTACT));
      // Travel is positive into bump, so a positive rate is the floor being driven
      // down onto the road — a crest, a kerb, or the landing after one.
      const bump = clamp01((w.suspension.compression - 0.68) / 0.14)
        * clamp01((w.suspension.velocity - 0.30) * 2.0);
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

    // The block is behind the front axle and the sparks leave along the floor, so they
    // start under the car and stream out from beneath the diffuser.
    for (let k = 0; k < count; k++) {
      const along = -0.4 + rng.next() * 2.4;
      _pos.set(state.position.x, groundY + 0.012, state.position.z);
      _pos.addScaledVector(_fwd, -along);
      _pos.addScaledVector(_right, rng.signed(0.32));

      // A spark is scraped off the block and keeps a third to a half of the car's own
      // momentum, so in the world frame it still travels forward while the car pulls
      // away from it — which is what makes the shower stream backwards on camera.
      _vel.copy(state.velocity).multiplyScalar(0.30 + rng.next() * 0.26);
      _vel.addScaledVector(_right, rng.signed(1.4 + speed * 0.03));
      _vel.y = 0.5 + rng.next() * 2.8;

      b.life = 0.42 + rng.next() * 0.55;
      b.size0 = 0.016 + rng.next() * 0.022;
      b.size1 = b.size0 * 0.55;
      b.stretch = 0.012 + rng.next() * 0.016;
      b.brightness = 1.6 + rng.next() * 1.4;
      b.color(1.0, 0.86, 0.62);
      b.rot = 0;
      b.spin = 0;
      b.seed = rng.next();
      pool.spawn(_pos.x, _pos.y, _pos.z, _vel.x, _vel.y, _vel.z);
    }

    this._noteLight(contactX, groundY + 0.15, contactZ, strength);
  }

  /** Kerb strike: the floor edge slapping down onto a raised kerb. */
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
      if (!w.contact || w.surface !== 'kerb') continue;
      const impact = clamp01((w.suspension.compression - 0.50) / 0.30)
        * clamp01(0.35 + Math.abs(w.suspension.velocity) * 0.6);
      if (impact > strength) {
        strength = impact;
        x = w.worldPosition.x;
        y = w.worldPosition.y - (i < 2 ? 0.360 : 0.3625);
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

      _vel.copy(state.velocity).multiplyScalar(0.22 + rng.next() * 0.30);
      _vel.addScaledVector(_right, side * (1.5 + rng.next() * 4.5));
      _vel.y = 1.4 + rng.next() * 4.6;

      b.life = 0.34 + rng.next() * 0.46;
      b.size0 = 0.014 + rng.next() * 0.020;
      b.size1 = b.size0 * 0.5;
      b.stretch = 0.010 + rng.next() * 0.014;
      b.brightness = 1.4 + rng.next() * 1.2;
      b.color(1.0, 0.82, 0.55);
      b.rot = 0;
      b.spin = 0;
      b.seed = rng.next();
      pool.spawn(_pos.x, _pos.y, _pos.z, _vel.x, _vel.y, _vel.z);
    }

    this._noteLight(x, y + 0.2, z, strength * 0.8);
  }

  /**
   * A one-shot shower: carbon on barrier, wheel on wheel, anything that grinds.
   * @param {number} energy 0..1
   */
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
        nz + rng.signed(spread),
      ).normalize().multiplyScalar(3 + e * 22 * (0.4 + rng.next()));

      b.life = 0.35 + rng.next() * 0.6;
      b.size0 = 0.014 + rng.next() * 0.024;
      b.size1 = b.size0 * 0.5;
      b.stretch = 0.010 + rng.next() * 0.018;
      b.brightness = 1.5 + rng.next() * 1.5;
      b.color(1.0, 0.84, 0.58);
      b.rot = 0;
      b.spin = 0;
      b.seed = rng.next();
      pool.spawn(x, y, z, _vel.x, _vel.y, _vel.z);
    }

    this._noteLight(x, y, z, 0.5 + e * 0.5);
  }

  /** Drive the dynamic lights and let the unclaimed ones fade out rather than blink. */
  lateUpdate(alpha, ctx, dt) {
    const sky = ctx.sky;
    if (sky) {
      // Sparks light the road at any hour, but only at dusk do they own it.
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
      // Cooling sparks tint their pool of light down toward red as the shower thins.
      const heat = clamp01(s.current / 8);
      light.color.setRGB(1.0, 0.34 + heat * 0.26, 0.06 + heat * 0.12);
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
