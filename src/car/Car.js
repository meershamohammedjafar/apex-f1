import * as THREE from 'three';
import { VehiclePhysics } from '../physics/VehiclePhysics.js';
import { wheelLocalPositions } from '../physics/CarConfig.js';
import { clamp, clamp01, damp, wrapAngle, lerp } from '../core/MathUtils.js';
import { CarModel, suspensionLinks, strutGeometry, COCKPIT_ANCHORS } from './CarModel.js';
import { WheelSet } from './Wheels.js';
import { DriverBust } from './DriverModel.js';
import { Cockpit } from './Cockpit.js';

/**
 * One car: its physics body, its visual representation at three levels of detail, and
 * the interpolation that ties them together (CONTRACT.md §6).
 *
 * The visual state is double-buffered. `update` snapshots the previous physics state
 * before stepping, `lateUpdate` blends between the two by the engine's alpha, so the
 * car never judders when the 120 Hz tick and the display rate disagree — and the wheel
 * spin, suspension travel, steering and body attitude all interpolate together rather
 * than the body sliding while the wheels snap.
 */

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _scale = new THREE.Vector3();
const _outboard = new THREE.Vector3();
const _inboard = new THREE.Vector3();
const _AXIS_X = new THREE.Vector3(1, 0, 0);

const DETAIL_NEAR = 2;
const DETAIL_MID = 1;
const DETAIL_FAR = 0;

/** Per-corner visual scalars that have to interpolate alongside the rigid body. */
function makeSnapshot() {
  return {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    travel: new Float32Array(4),
    steer: new Float32Array(4),
    camber: new Float32Array(4),
    spin: new Float32Array(4),
  };
}

export class Car {
  constructor(ctx, { config, livery, driver = null, isPlayer = false, index = 0 }) {
    this.ctx = ctx;
    this.config = config;
    this.livery = livery;
    this.driver = driver;
    this.isPlayer = isPlayer;
    this.index = index;
    this.name = driver?.name ?? config.name ?? `Car ${index + 1}`;

    this.physics = new VehiclePhysics(config);
    this.controls = null;
    /** Set by the capture rail to override the AI on a car whose pose it authors. */
    this.scriptedControls = null;

    this.group = new THREE.Group();
    this.group.name = `car-${index}-${driver?.code ?? 'apex'}`;
    this.group.matrixAutoUpdate = true;

    this._wheelBase = [
      new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
    ];
    wheelLocalPositions(config, this._wheelBase);
    this._wheelPos = [
      new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
    ];

    this._prev = makeSnapshot();
    this._curr = makeSnapshot();
    this._drs = 0;
    this._drsTarget = 0;

    this._levels = [null, null, null];
    this._detail = -1;
    this._links = suspensionLinks();

    // Telemetry the steering-wheel display and the HUD read off the car rather than
    // reaching into the physics state.
    this.delta = NaN;
    this.lastLapTime = 0;
    this.bestLapTime = 0;
    this.lap = 0;
    this.position = index + 1;
    this.trackT = 0;
    this.distance = 0;

    if (isPlayer) {
      this.physics.setEventBus(ctx.events);
      this.cockpit = new Cockpit(ctx, this);
      this.group.add(this.cockpit.group);
    } else {
      this.cockpit = null;
    }

    this.setDetail(isPlayer ? DETAIL_NEAR : DETAIL_FAR);
    this._snapshot(this._prev);
    this._snapshot(this._curr);
  }

  // --- level of detail ------------------------------------------------------------------

  _buildLevel(detail) {
    const ctx = this.ctx;
    const level = { root: new THREE.Group(), detail };
    level.root.name = `lod${detail}`;

    level.model = new CarModel(this.livery, detail, { castShadow: detail >= 1 });
    level.root.add(level.model.group);

    level.wheels = new WheelSet(ctx, {
      detail,
      compound: this.config.tyres.compound,
      front: this.config.tyres.front,
      rear: this.config.tyres.rear,
      discRadiusFront: this.config.brakes.discRadiusFront,
      discRadiusRear: this.config.brakes.discRadiusRear,
    });
    level.root.add(level.wheels.group);

    if (detail >= DETAIL_MID) {
      const geo = strutGeometry(detail);
      const mesh = new THREE.InstancedMesh(geo, this.livery.suspension, this._links.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = detail >= 2;
      mesh.frustumCulled = true;
      level.suspension = mesh;
      level.root.add(mesh);
    } else {
      level.suspension = null;
    }

    // The player's own helmet would fill the cockpit camera, so it is never built.
    if (detail >= DETAIL_MID && !this.isPlayer && this.driver) {
      level.driver = new DriverBust(ctx, this.driver, this.livery, detail, COCKPIT_ANCHORS.helmet);
      if (detail < 2) level.driver.visor.visible = false;
      level.root.add(level.driver.group);
    } else {
      level.driver = null;
    }

    this.group.add(level.root);
    return level;
  }

  setDetail(detail) {
    const d = clamp(detail | 0, 0, 2);
    if (d === this._detail) return;
    this._detail = d;
    for (let i = 0; i < 3; i++) {
      if (this._levels[i]) this._levels[i].root.visible = i === d;
    }
    if (!this._levels[d]) {
      this._levels[d] = this._buildLevel(d);
      this._levels[d].root.visible = true;
    }
  }

  get active() {
    return this._levels[this._detail];
  }

  // --- simulation ------------------------------------------------------------------------

  reset(position, quaternion, track) {
    this.physics.reset(position, quaternion, track);
    this._snapshot(this._prev);
    this._snapshot(this._curr);
    this._applyVisual(1);
  }

  _snapshot(dst) {
    const s = this.physics.state;
    dst.position.copy(s.position);
    dst.quaternion.copy(s.quaternion);
    for (let i = 0; i < 4; i++) {
      const w = s.wheels[i];
      dst.travel[i] = w.suspension.travel;
      dst.steer[i] = w.steerAngle;
      dst.camber[i] = w.camber;
      dst.spin[i] = w.spinAngle;
    }
  }

  /** @param {number} dt fixed step seconds */
  update(dt, ctx) {
    const prev = this._prev;
    this._prev = this._curr;
    this._curr = prev;
    this._snapshot(this._prev);

    this.physics.step(dt, this.controls ?? null, ctx.track ?? null);
    this._snapshot(this._curr);

    const state = this.physics.state;
    this._drsTarget = state.drs.open ? 1 : 0;
    const drsCfg = this.config.aero.drs;
    const rate = this._drsTarget > this._drs ? 1 / Math.max(0.02, drsCfg.openTime) : 1 / Math.max(0.02, drsCfg.closeTime);
    this._drs = damp(this._drs, this._drsTarget, rate * 3.2, dt);

    if (this.cockpit) this.cockpit.update(dt, ctx);
  }

  /** @param {number} alpha interpolation factor between the last two fixed states */
  lateUpdate(alpha, ctx) {
    this._applyVisual(alpha);
    if (this.cockpit) this.cockpit.renderMirrors(ctx);
  }

  _applyVisual(alpha) {
    const a = clamp01(alpha);
    const p = this._prev;
    const c = this._curr;

    this.group.position.lerpVectors(p.position, c.position, a);
    this.group.quaternion.copy(p.quaternion).slerp(c.quaternion, a);

    const level = this.active;
    if (!level) return;

    const state = this.physics.state;
    for (let i = 0; i < 4; i++) {
      const travel = lerp(p.travel[i], c.travel[i], a);
      const steer = lerp(p.steer[i], c.steer[i], a);
      const camber = lerp(p.camber[i], c.camber[i], a);
      // Spin wraps at 2*PI; interpolating the shortest signed delta keeps the wheel from
      // snapping backwards once per revolution.
      const spin = p.spin[i] + wrapAngle(c.spin[i] - p.spin[i]) * a;

      const base = this._wheelBase[i];
      this._wheelPos[i].set(base.x, base.y + travel, base.z);
      level.wheels.setWheel(i, this._wheelPos[i], steer, camber, spin);
      if (level.wheels.disc) level.wheels.setBrakeTemp(i, state.brakeTemp[i]);
    }
    level.wheels.commit();

    if (level.suspension) this._updateSuspension(level.suspension, a);

    level.model.setDrs(this._drs);

    if (level.driver) {
      level.driver.setHeadLean(state.gForce.x, state.gForce.z);
    }
  }

  /**
   * Stretch each link between its fixed chassis pickup and its outboard end, which
   * rides with that corner's suspension travel and, on the steered links, swings about
   * the kingpin. This is the detail that makes a car look like it has real geometry
   * rather than wheels glued to a body.
   */
  _updateSuspension(mesh, alpha) {
    const p = this._prev;
    const c = this._curr;
    const links = this._links;
    for (let k = 0; k < links.length; k++) {
      const l = links[k];
      const w = l.wheel;
      const travel = lerp(p.travel[w], c.travel[w], alpha);
      _outboard.set(l.outboard[0], l.outboard[1] + travel, l.outboard[2]);
      if (l.steers) {
        const steer = lerp(p.steer[w], c.steer[w], alpha);
        const dx = _outboard.x - l.hub[0];
        const dz = _outboard.z - l.hub[2];
        const cs = Math.cos(-steer);
        const sn = Math.sin(-steer);
        _outboard.x = l.hub[0] + dx * cs + dz * sn;
        _outboard.z = l.hub[2] - dx * sn + dz * cs;
      }
      _inboard.set(l.inboard[0], l.inboard[1], l.inboard[2]);
      _dir.subVectors(_outboard, _inboard);
      const len = _dir.length();
      _dir.multiplyScalar(1 / Math.max(1e-5, len));
      _q.setFromUnitVectors(_AXIS_X, _dir);
      _scale.set(len, l.chord, l.chord);
      _m.compose(_inboard, _q, _scale);
      mesh.setMatrixAt(k, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  // --- helpers ---------------------------------------------------------------------------

  setCompound(name) {
    this.physics.setCompound(name);
    for (const level of this._levels) level?.wheels.setCompound(name);
  }

  /** Squared distance from a world point, used by the manager to pick a detail level. */
  distanceSqTo(point) {
    _v.copy(this.physics.state.position);
    return _v.distanceToSquared(point);
  }

  get state() {
    return this.physics.state;
  }

  setVisible(v) {
    this.group.visible = v;
  }

  dispose() {
    this.cockpit?.dispose();
    for (const level of this._levels) {
      if (!level) continue;
      level.model.dispose();
      level.wheels.dispose();
      level.driver?.dispose();
      level.suspension?.dispose();
      level.root.clear();
    }
    this._levels.length = 0;
    this.group.clear();
    this.physics.dispose();
  }
}

export { DETAIL_NEAR, DETAIL_MID, DETAIL_FAR };
