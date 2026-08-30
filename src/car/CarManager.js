import * as THREE from 'three';
import { createTeamConfig } from '../physics/CarConfig.js';
import { clamp, clamp01, wrap01, deltaT } from '../core/MathUtils.js';
import { Rng } from '../core/Rng.js';
import { Car, DETAIL_NEAR, DETAIL_MID, DETAIL_FAR } from './Car.js';
import { DRIVERS, LiveryFactory } from './Teams.js';
import { disposeSharedGeometry, disposeStrutGeometry } from './CarModel.js';
import { disposeSharedWheelGeometry } from './Wheels.js';
import {
  disposeSharedDriverGeometry, disposeHelmetMaterials, disposeSharedArmGeometry,
} from './DriverModel.js';

/**
 * Owns the twenty cars on the grid (CONTRACT.md §6) and everything that has to be
 * decided for all of them at once: which detail level each one draws at, who is close
 * enough behind whom to be in dirty air, and who has DRS.
 *
 * The manager registers as `ctx.cars` and behaves as an array — index 0 is the player —
 * so consumers can iterate it exactly as the contract's `Car[]` describes.
 *
 * Detail budget: the player and the two closest *visible* rivals draw the hero model,
 * the next eight draw a merged mid model, and the rest draw an impostor. Every level
 * builds a whole car — paint, wings, carbon, suspension, wheels with rims — so a car
 * changing level changes resolution, never composition.
 */

const _camPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _side = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _target = new THREE.Vector3();
const _local = new THREE.Vector3();
const _qInv = new THREE.Quaternion();

/**
 * The AI is owned by another subsystem. `import.meta.glob` resolves it at build time
 * when it is present and yields an empty map when it is not, so the grid still runs on
 * the pace driver below rather than failing to bundle.
 */
const AI_MODULE = import.meta.glob('../ai/AIDriver.js');

// Hoisted so the per-frame detail sort does not allocate a comparator closure.
let _sortDist = null;
const byDistance = (a, b) => _sortDist[a] - _sortDist[b];

const NEAR_HERO_COUNT = 2;      // AI cars allowed the hero model alongside the player
const MID_COUNT = 8;
const HERO_RANGE_SQ = 55 * 55;
const MID_RANGE_SQ = 220 * 220;

/**
 * Detail is budgeted by rank, so the ranking has to be over cars that are actually on
 * screen. Sorting the whole field by raw distance spends the budget on the cars filling
 * the mirrors — in a midfield pack half the grid is behind the camera — and drops the
 * cars the player is looking at to the impostor level. Anything behind the camera plane
 * is pushed past every visible car by this penalty instead.
 */
const BEHIND_PENALTY_SQ = 1e7;
const BEHIND_MARGIN = 6;        // metres of slack, so a car alongside is still "ahead"

/**
 * Hysteresis on the tier boundaries. A car sitting on a range edge, or swapping rank
 * with a rival in a pack, would otherwise change model every frame; the tiers differ in
 * silhouette, so that reads as the car flickering apart. A promotion has to beat the
 * threshold outright, a demotion has to fall 18 % past it.
 */
const LOD_HOLD = 1.18 * 1.18;

const COMPOUND_ROTATION = ['medium', 'soft', 'hard', 'medium', 'soft'];
const PLAYER_GRID_SLOT = 3;
const DELTA_BINS = 240;

function makeLocateResult() {
  return {
    t: 0, distance: 0, lateral: 0, onTrack: false, index: 0,
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    right: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    width: 0, banking: 0, curvature: 0, gradient: 0,
  };
}

const EMPTY_CONTROLS = {
  throttle: 0, brake: 0, steer: 0, clutch: 0,
  shiftUp: false, shiftDown: false,
  drs: false, ers: false, pitLimiter: false,
  lookLeft: 0, lookRight: 0, lookBack: false, reset: false,
};

/**
 * Fallback race driver, used when no AIDriver module is present. It is a real
 * controller, not a placeholder: pure pursuit on the racing line for steering, and a
 * forward scan of the corridor curvature for the speed target, so the field runs
 * representative lap times and brakes in the right places.
 */
class PaceDriver {
  constructor(car, track, { skill = 0.9, aggression = 0.8 } = {}) {
    this.car = car;
    this.track = track;
    this.skill = clamp01(skill);
    this.aggression = clamp01(aggression);
    this.rng = new Rng(0x9a1c00 + car.index * 2654435761);
    this.controls = { ...EMPTY_CONTROLS };
    this._sample = makeLocateResult();
    this._noise = 0;
    this._noisePhase = this.rng.next() * 100;
    this._lineOffset = (this.rng.next() * 2 - 1) * 0.6;
  }

  update(dt, ctx, loc) {
    const track = this.track;
    const c = this.controls;
    const state = this.car.state;
    const speed = Math.max(0, state.speed);

    if (!track || !loc) {
      c.throttle = 0.4;
      c.brake = 0;
      c.steer = 0;
      return c;
    }

    // Pure pursuit: aim at a point on the racing line that runs away with speed.
    const lookahead = 7 + speed * 0.52 + (1 - this.skill) * 6;
    const tAhead = wrap01(loc.t + lookahead / track.length);
    track.racingLine.getPointAt(tAhead, _target);

    _qInv.copy(state.quaternion).invert();
    _local.copy(_target).sub(state.position).applyQuaternion(_qInv);
    // Car local is -Z forward, so a positive X error means the target is to the right.
    const heading = Math.atan2(_local.x, Math.max(0.5, -_local.z));

    this._noisePhase += dt * (0.7 + this.rng.next() * 0.05);
    this._noise = Math.sin(this._noisePhase * 2.1) * (1 - this.skill) * 0.045;

    const maxRoad = this.car.config.steering.maxRoadWheelAngle;
    c.steer = clamp(heading / maxRoad * 0.85 + this._noise, -1, 1);

    // Speed target: the tightest thing within braking range wins.
    const brakeAccel = 34 + this.skill * 9;
    let target = 96;
    for (let i = 1; i <= 14; i++) {
      const d = 8 + i * i * 1.05;
      track.sample(wrap01(loc.t + d / track.length), this._sample);
      const k = Math.abs(this._sample.curvature);
      // Lateral capability climbs with speed because the floor makes more load.
      const latCap = (26 + 26 * clamp01(speed / 78)) * (0.86 + 0.14 * this.skill);
      const corner = k > 1e-4 ? Math.sqrt(latCap / k) : 110;
      const allowed = Math.sqrt(corner * corner + 2 * brakeAccel * d);
      if (allowed < target) target = allowed;
    }
    target = Math.min(target, 96) * (0.955 + 0.045 * this.skill);

    const err = target - speed;
    if (err > 0.6) {
      c.throttle = clamp01(err * 0.35);
      c.brake = 0;
    } else if (err < -0.6) {
      c.throttle = 0;
      c.brake = clamp01(-err * 0.22);
    } else {
      c.throttle = clamp01(0.35 + err * 0.3);
      c.brake = 0;
    }

    // Recover a spin or an excursion rather than sitting in the gravel forever.
    if (!loc.onTrack && Math.abs(loc.lateral) > loc.width + 2.5) {
      c.throttle = Math.min(c.throttle, 0.4);
    }
    c.drs = true;
    c.ers = true;
    return c;
  }
}

export class CarManager {
  static systemName = 'cars';

  constructor() {
    this.cars = [];
    this.player = null;
    this.ai = [];
    this.length = 0;
    this._locate = [];
    this._order = [];
    this._distSq = new Float64Array(20);
    this._tier = new Int8Array(20).fill(DETAIL_FAR);
    this._lapTimer = new Float64Array(20);
    this._lastT = new Float64Array(20);
    this._deltaTable = new Float32Array(DELTA_BINS).fill(-1);
    this._deltaLive = new Float32Array(DELTA_BINS).fill(-1);
    this._tick = 0;
    this._AIDriver = null;
  }

  async init(ctx) {
    this.ctx = ctx;
    this.liveries = new LiveryFactory(ctx);
    const track = ctx.track ?? null;

    const loader = Object.values(AI_MODULE)[0];
    if (loader) {
      try {
        const mod = await loader();
        this._AIDriver = mod?.AIDriver ?? null;
      } catch (err) {
        console.warn('[cars] AIDriver failed to load, falling back to the pace driver', err);
        this._AIDriver = null;
      }
    }

    const seat = Math.max(0, Math.min(DRIVERS.length - 1, ctx.settings?.get?.('playerDriver') ?? 0));
    const gridOrder = DRIVERS.slice();
    if (seat > 0) gridOrder.unshift(gridOrder.splice(seat, 1)[0]);

    for (let i = 0; i < gridOrder.length; i++) {
      const driver = gridOrder[i];
      const isPlayer = i === 0;
      const compound = isPlayer ? 'medium' : COMPOUND_ROTATION[i % COMPOUND_ROTATION.length];
      const config = createTeamConfig(driver.team.setup, compound);
      config.name = driver.name;
      config.team = driver.teamId;
      config.brakes.abs = ctx.settings?.get?.('abs') ?? 0;
      // The field gets a slice of traction control so a twenty-car race does not turn
      // into twenty spins out of the first hairpin; the player gets what they asked for.
      config.assists.tractionControl = isPlayer ? (ctx.settings?.get?.('tractionControl') ?? 0) : 0.25;

      const livery = this.liveries.get(driver.team);
      const car = new Car(ctx, { config, livery, driver, isPlayer, index: i });
      ctx.scene.add(car.group);
      this.cars.push(car);
      this._locate.push(makeLocateResult());
      this._order.push(i);
      this[i] = car;

      if (isPlayer) {
        this.player = car;
      } else {
        const opts = { skill: driver.skill, aggression: driver.aggression };
        this.ai.push(this._AIDriver
          ? new this._AIDriver(car, track, opts)
          : new PaceDriver(car, track, opts));
      }
    }
    this.length = this.cars.length;

    ctx.vehicle = this.player.physics;
    ctx.player = this.player;

    this.spawnOnGrid(track);

    this._onQuality = (tier) => {
      for (const car of this.cars) car.cockpit?.setQuality?.(tier);
    };
    ctx.events?.on('quality:change', this._onQuality);
  }

  /** Put the field on Track.startGrid, player at a mid-front slot so rivals are in shot. */
  spawnOnGrid(track) {
    const grid = track?.startGrid;
    if (!grid || grid.length === 0) {
      for (const car of this.cars) car.reset(_v.set(0, 0.3, car.index * -8), _q.identity(), track);
      return;
    }
    let slot = 0;
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      let gridIndex;
      if (i === 0) {
        gridIndex = PLAYER_GRID_SLOT;
      } else {
        if (slot === PLAYER_GRID_SLOT) slot++;
        gridIndex = slot++;
      }
      const g = grid[Math.min(gridIndex, grid.length - 1)];
      _v.copy(g.position);
      _v.y += car.config.chassis.cgHeight;
      car.reset(_v, g.quaternion, track);
      this._lastT[i] = 0;
      this._lapTimer[i] = 0;
    }
    this._deltaTable.fill(-1);
    this._deltaLive.fill(-1);
  }

  /** Drop the player back on the racing line facing forward. */
  respawnPlayer(track) {
    const car = this.player;
    const loc = this._locate[0];
    if (!track) return;
    track.locate(car.state.position, loc);
    track.sample(loc.t, loc);
    _fwd.copy(loc.tangent).normalize();
    _up.copy(loc.normal).normalize();
    _side.crossVectors(_fwd, _up).normalize();
    _up.crossVectors(_side, _fwd).normalize();
    _mat.makeBasis(_side, _up, _v.copy(_fwd).negate());
    _q.setFromRotationMatrix(_mat);
    _v.copy(loc.position);
    _v.y += car.config.chassis.cgHeight + 0.05;
    car.reset(_v, _q, track);
  }

  update(dt, ctx) {
    const track = ctx.track ?? null;
    this._tick++;

    if (ctx.input?.controls?.reset && track) this.respawnPlayer(track);

    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      const loc = this._locate[i];
      if (track) {
        track.locate(car.state.position, loc);
        car.trackT = loc.t;
        car.distance = loc.distance;
      }
      // `scriptedControls` is set by the capture rail (src/game/Scenarios.js) on cars
      // whose pose it authors: their driver has nothing sane to react to, so the rail
      // drives them instead.
      car.controls = i === 0
        ? (ctx.input?.controls ?? EMPTY_CONTROLS)
        : (car.scriptedControls ?? this.ai[i - 1].update(dt, ctx, loc) ?? EMPTY_CONTROLS);
    }

    if (track) {
      this._updateInteractions(track);
      this._updateLaps(dt);
    }

    for (let i = 0; i < this.cars.length; i++) this.cars[i].update(dt, ctx);
  }

  /**
   * Slipstream and DRS. Both need the same answer — who is directly ahead and how far —
   * so they are computed together in one O(n^2) pass over twenty cars, which is 190
   * comparisons and cheaper than any acceleration structure at this size.
   */
  _updateInteractions(track) {
    const n = this.cars.length;
    for (let i = 0; i < n; i++) {
      const car = this.cars[i];
      const li = this._locate[i];
      let bestGap = Infinity;
      let bestLateral = 99;

      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const lj = this._locate[j];
        const d = deltaT(li.t, lj.t) * track.length;
        if (d <= 0.5 || d > 60) continue;
        if (d < bestGap) {
          bestGap = d;
          bestLateral = Math.abs(lj.lateral - li.lateral);
        }
      }

      if (bestGap < 60) car.physics.setWake(bestGap, bestLateral);
      else car.physics.setWake(999, 99);

      const zone = track.drsZoneAt ? track.drsZoneAt(li.t) : null;
      const speed = Math.max(1, car.state.speed);
      const gapSeconds = bestGap < 60 ? bestGap / speed : 99;
      car.physics.setDrsZone(!!zone, !!zone && gapSeconds < 1.0);
    }
  }

  /**
   * Lap bookkeeping. RaceDirector owns the official timing; this is the minimum the car
   * itself needs — the per-lap ERS budget reset, and the live delta the steering-wheel
   * display shows against the driver's own best lap.
   */
  _updateLaps(dt) {
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      const t = this._locate[i].t;
      const prev = this._lastT[i];
      this._lapTimer[i] += dt;

      if (prev > 0.85 && t < 0.15) {
        const lapTime = this._lapTimer[i];
        this._lapTimer[i] = 0;
        car.lap++;
        if (lapTime > 20) {
          car.lastLapTime = lapTime;
          if (car.bestLapTime === 0 || lapTime < car.bestLapTime) {
            car.bestLapTime = lapTime;
            if (i === 0) this._deltaTable.set(this._deltaLive);
          }
        }
        if (i === 0) this._deltaLive.fill(-1);
        car.physics.notifyLap();
      }
      this._lastT[i] = t;

      if (i === 0) {
        const bin = clamp(Math.floor(t * DELTA_BINS), 0, DELTA_BINS - 1);
        this._deltaLive[bin] = this._lapTimer[0];
        const ref = this._deltaTable[bin];
        car.delta = ref >= 0 ? this._lapTimer[0] - ref : NaN;
      }
    }
  }

  lateUpdate(alpha, ctx) {
    const camera = ctx.camera;
    if (camera) {
      camera.getWorldPosition(_camPos);
      camera.getWorldDirection(_camDir);
    } else {
      _camPos.set(0, 0, 0);
      _camDir.set(0, 0, -1);
    }

    const n = this.cars.length;
    for (let i = 0; i < n; i++) {
      const car = this.cars[i];
      _v.copy(car.state.position).sub(_camPos);
      const d = _v.lengthSq();
      this._distSq[i] = _v.dot(_camDir) > -BEHIND_MARGIN ? d : d + BEHIND_PENALTY_SQ;
      this._order[i] = i;
    }
    const dist = this._distSq;
    _sortDist = dist;
    this._order.sort(byDistance);

    let heroes = 0;
    let mids = 0;
    for (let k = 0; k < n; k++) {
      const idx = this._order[k];
      const car = this.cars[idx];
      if (car.isPlayer) {
        car.setDetail(DETAIL_NEAR);
        continue;
      }
      // Widen whichever band the car is already in, so the boundary it has to cross to
      // drop a level is further out than the one that promoted it.
      const held = this._tier[idx];
      const heroRange = held >= DETAIL_NEAR ? HERO_RANGE_SQ * LOD_HOLD : HERO_RANGE_SQ;
      const midRange = held >= DETAIL_MID ? MID_RANGE_SQ * LOD_HOLD : MID_RANGE_SQ;
      const d = dist[idx];
      let tier;
      if (heroes < NEAR_HERO_COUNT && d < heroRange) {
        tier = DETAIL_NEAR;
        heroes++;
      } else if (mids < MID_COUNT && d < midRange) {
        tier = DETAIL_MID;
        mids++;
      } else {
        tier = DETAIL_FAR;
      }
      this._tier[idx] = tier;
      car.setDetail(tier);
    }

    for (let i = 0; i < n; i++) this.cars[i].lateUpdate(alpha, ctx);
  }

  resize(width, height, ctx) {
    this.player?.cockpit?.resize(width, height, ctx);
  }

  // --- Car[] interface (CONTRACT.md §1) --------------------------------------------------

  at(i) {
    return this.cars[i < 0 ? this.cars.length + i : i];
  }

  indexOf(car) {
    return this.cars.indexOf(car);
  }

  includes(car) {
    return this.cars.includes(car);
  }

  find(fn) {
    return this.cars.find(fn);
  }

  filter(fn) {
    return this.cars.filter(fn);
  }

  map(fn) {
    return this.cars.map(fn);
  }

  forEach(fn) {
    this.cars.forEach(fn);
  }

  slice(a, b) {
    return this.cars.slice(a, b);
  }

  [Symbol.iterator]() {
    return this.cars[Symbol.iterator]();
  }

  dispose() {
    this.ctx?.events?.off?.('quality:change', this._onQuality);
    for (let i = 0; i < this.cars.length; i++) {
      const car = this.cars[i];
      car.group.parent?.remove(car.group);
      car.dispose();
      delete this[i];
    }
    this.cars.length = 0;
    this.ai.length = 0;
    this.length = 0;
    this.liveries?.dispose();
    disposeSharedGeometry();
    disposeStrutGeometry();
    disposeSharedWheelGeometry();
    disposeSharedDriverGeometry();
    disposeSharedArmGeometry();
    disposeHelmetMaterials();
  }
}

export { PaceDriver, EMPTY_CONTROLS };
