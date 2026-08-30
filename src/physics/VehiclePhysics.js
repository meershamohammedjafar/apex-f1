/**
 * Rigid-body Formula 1 vehicle physics.
 *
 * One `step` at the engine's 120 Hz tick is integrated as N substeps at 240 Hz with
 * semi-implicit Euler. The body carries a full inertia tensor and Euler's equations are
 * solved in the body frame, so the chassis' own gyroscopic coupling is exact and the four
 * spinning wheels add their couple on top of it.
 *
 * Nothing about the handling is scripted. Weight transfer is whatever the suspension
 * forces and the CG height produce; tyre load sensitivity then decides how much grip that
 * leaves. Lift off mid-corner and the rear steps out because the pitch moment unloaded it,
 * not because a "snap oversteer" term fired.
 *
 * Car local frame: -Z forward, +X right, +Y up, origin at the CG (CONTRACT.md §0).
 * Wheel order: 0 FL, 1 FR, 2 RL, 3 RR.
 */

import * as THREE from 'three';
import { clamp, clamp01, moveTowards, G } from '../core/MathUtils.js';
import { createCarConfig, wheelLocalPositions } from './CarConfig.js';
import { Tyre } from './TyreModel.js';
import { Suspension, SIDE, IS_FRONT } from './Suspension.js';
import { Aerodynamics } from './Aerodynamics.js';
import { Powertrain } from './Powertrain.js';

const SUBSTEP_DT = 1 / 240;
const MAX_SUBSTEPS = 8;

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_FWD = new THREE.Vector3(0, 0, -1);

const EMPTY_CONTROLS = {
  throttle: 0, brake: 0, steer: 0, clutch: 0,
  shiftUp: false, shiftDown: false,
  drs: false, ers: false, pitLimiter: false,
  lookLeft: 0, lookRight: 0, lookBack: false, reset: false,
};

const PROBE_RADIUS = [0.62, 1.05, 0.72];
const PROBE_DAMAGE = ['front', 'floor', 'rear'];

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _query = new THREE.Vector3();
const _wheelCentre = new THREE.Vector3();
const _contactPoint = new THREE.Vector3();
const _arm = new THREE.Vector3();
const _vContact = new THREE.Vector3();
const _tyreFwd = new THREE.Vector3();
const _tyreLat = new THREE.Vector3();
const _force = new THREE.Vector3();
const _torque = new THREE.Vector3();
const _forceAcc = new THREE.Vector3();
const _torqueAcc = new THREE.Vector3();
const _avgNormal = new THREE.Vector3();
const _localVel = new THREE.Vector3();
const _localOmega = new THREE.Vector3();
const _localTorque = new THREE.Vector3();
const _localAlpha = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _accel = new THREE.Vector3();
const _qTmp = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
const _probe = new THREE.Vector3();
const _impulse = new THREE.Vector3();
const _tangent = new THREE.Vector3();

function makeSurfaceOut() {
  return {
    height: 0,
    normal: new THREE.Vector3(0, 1, 0),
    grip: 1,
    type: 'asphalt',
    roughness: 0.03,
    drag: 0,
  };
}

export class VehiclePhysics {
  constructor(config) {
    this.config = config && config.chassis ? config : createCarConfig(config ?? null);
    const cfg = this.config;

    this.suspension = new Suspension(cfg);
    this.aero = new Aerodynamics(cfg);
    this.powertrain = new Powertrain(cfg);

    this.tyres = [
      new Tyre(cfg.tyres.front, cfg.tyres.compound, SIDE[0], cfg.tyres),
      new Tyre(cfg.tyres.front, cfg.tyres.compound, SIDE[1], cfg.tyres),
      new Tyre(cfg.tyres.rear, cfg.tyres.compound, SIDE[2], cfg.tyres),
      new Tyre(cfg.tyres.rear, cfg.tyres.compound, SIDE[3], cfg.tyres),
    ];

    this._wheelLocal = [
      new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
    ];
    wheelLocalPositions(cfg, this._wheelLocal);

    this._probeLocal = [
      new THREE.Vector3(0, 0.05, -cfg.chassis.noseOffset),
      new THREE.Vector3(0, 0.10, 0),
      new THREE.Vector3(0, 0.15, cfg.chassis.tailOffset),
    ];

    this._surf = [makeSurfaceOut(), makeSurfaceOut(), makeSurfaceOut(), makeSurfaceOut()];
    this._barrierOut = { hit: false, normal: new THREE.Vector3(), penetration: 0 };

    // Per-instance working arrays: several cars step in sequence, so none of this may
    // live at module scope. Allocated once here, never inside step().
    this._travel = new Float64Array(4);
    this._rideHeight = new Float64Array(4);
    this._contactFlag = new Uint8Array(4);
    this._prevFx = new Float64Array(4);
    this._slipRatios = new Float64Array(4);
    this._gamma = new Float64Array(4);
    this._wheelOmega = new Float64Array(4);
    this._steerAngle = new Float64Array(4);
    this._spinAngle = new Float64Array(4);
    this._steerBase = 0;
    this._prevVel = new THREE.Vector3();

    this.events = null;
    this.recoveries = 0;
    this._offTrack = false;
    this._kerbFlag = false;
    this._kerbLatch = false;
    this._lockupLatch = false;
    this._spinLatch = false;

    const I = cfg.chassis.inertia;
    this._invIx = 1 / I.x;
    this._invIy = 1 / I.y;
    this._invIz = 1 / I.z;
    this._invMass = 1 / cfg.chassis.mass;

    this.state = this._createState();
    this._safePosition = new THREE.Vector3();
    this._safeQuaternion = new THREE.Quaternion();

    this.reset(new THREE.Vector3(0, 0, 0), new THREE.Quaternion());
  }

  _createState() {
    const wheels = [];
    for (let i = 0; i < 4; i++) {
      wheels.push({
        worldPosition: new THREE.Vector3(),
        worldQuaternion: new THREE.Quaternion(),
        steerAngle: 0,
        spinAngle: 0,
        angularVelocity: 0,
        slipRatio: 0,
        slipAngle: 0,
        load: 0,
        fx: 0,
        fy: 0,
        mz: 0,
        contact: false,
        suspension: { compression: 0, travel: 0, velocity: 0 },
        temperature: { surface: 90, core: 90 },
        wear: 0,
        surface: 'asphalt',
        lockup: 0,
        spin: 0,
        camber: 0,
        rideHeight: 0,
      });
    }

    return {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      velocity: new THREE.Vector3(),
      angularVelocity: new THREE.Vector3(),
      localVelocity: new THREE.Vector3(),
      speed: 0,
      speedKph: 0,
      accel: new THREE.Vector3(),
      gForce: new THREE.Vector3(0, 1, 0),

      rpm: 0,
      gear: 1,
      throttle: 0,
      brake: 0,
      steer: 0,
      clutch: 0,
      engineTorque: 0,
      wheelTorque: 0,
      shiftTimer: 0,
      limiterActive: false,

      wheels,

      aero: { downforceFront: 0, downforceRear: 0, drag: 0, balance: 0.45, stalled: false },
      drs: { open: false, available: false, zoneActive: false },
      ers: { charge: 0, deploy: 0, harvestMGUK: 0, harvestMGUH: 0, mode: 1 },
      fuel: 0,
      brakeTemp: [0, 0, 0, 0],

      onTrack: true,
      surfaceGrip: 1,
      kerbContact: false,
      airborne: false,
      damage: { front: 0, rear: 0, floor: 0 },

      // Telemetry beyond the contract, consumed by the HUD, audio and effects.
      boost: 0,
      slipAngleBody: 0,
      steeringTorque: 0,
      rideHeightFront: 0,
      rideHeightRear: 0,
      groundEffect: 1,
      pitLimiter: false,
    };
  }

  /** Give the car an EventBus so it can raise the `car:*` events. */
  setEventBus(events) {
    this.events = events;
  }

  setCompound(name) {
    this.config.tyres.compound = name;
    for (const t of this.tyres) t.setCompound(name);
  }

  /** Mirror the player's driving assists from Settings. Both default to off. */
  setAssists({ abs = null, tractionControl = null } = {}) {
    if (abs !== null) this.config.brakes.abs = clamp01(abs);
    if (tractionControl !== null) {
      this.config.assists.tractionControl = clamp01(tractionControl);
    }
  }

  /** Brake balance, as the driver would move it on the wheel. */
  setBrakeBias(bias) {
    this.powertrain.setBrakeBias(bias);
  }

  setErsMode(mode) {
    this.powertrain.setErsMode(mode);
  }

  /**
   * @param {THREE.Vector3} position centre-of-gravity position
   * @param {THREE.Quaternion} quaternion
   * @param {object|null} track optional, used to lift the car onto the surface when the
   *        caller hands in a grid slot measured at road level rather than at the CG.
   */
  reset(position, quaternion, track = null) {
    const s = this.state;
    if (position) s.position.copy(position);
    if (quaternion) s.quaternion.copy(quaternion).normalize();
    if (track && typeof track.heightAt === 'function') {
      const ground = track.heightAt(s.position.x, s.position.z);
      if (Number.isFinite(ground)) {
        s.position.y = Math.max(s.position.y, ground + this.config.chassis.cgHeight);
      }
    }
    s.velocity.set(0, 0, 0);
    s.angularVelocity.set(0, 0, 0);
    s.localVelocity.set(0, 0, 0);
    s.accel.set(0, 0, 0);
    s.gForce.set(0, 1, 0);
    s.speed = 0;
    s.speedKph = 0;
    s.damage.front = 0;
    s.damage.rear = 0;
    s.damage.floor = 0;
    s.airborne = false;
    s.onTrack = true;

    this.suspension.reset();
    this.aero.reset();
    this.powertrain.reset();

    const t0 = this.config.tyres.startTemp;
    for (let i = 0; i < 4; i++) {
      this.tyres[i].reset(t0, 0);
      this._wheelOmega[i] = 0;
      this._steerAngle[i] = this.suspension.toe[i];
      this._spinAngle[i] = 0;
      this._prevFx[i] = 0;
      this._slipRatios[i] = 0;
      this._travel[i] = 0;
      this._contactFlag[i] = 1;
      this._rideHeight[i] = IS_FRONT[i]
        ? this.config.aero.referenceRideHeightFront
        : this.config.aero.referenceRideHeightRear;
      this._gamma[i] = this.suspension.camber[i];
    }
    this._steerBase = 0;
    this._prevVel.set(0, 0, 0);
    this._offTrack = false;
    this._safePosition.copy(s.position);
    this._safeQuaternion.copy(s.quaternion);
    this._publish(SUBSTEP_DT, null);
  }

  /**
   * Advance one fixed tick, substepping internally to 240 Hz.
   * @param {number} dt seconds
   * @param {object} controls ControlState (CONTRACT.md §4)
   * @param {object|null} track Track, or null for a flat test plane at y = 0
   */
  step(dt, controls, track) {
    if (!(dt > 0)) return;
    const n = clamp(Math.round(dt / SUBSTEP_DT), 1, MAX_SUBSTEPS);
    const h = dt / n;
    const ctrl = controls ?? EMPTY_CONTROLS;

    this._prevVel.copy(this.state.velocity);

    for (let i = 0; i < n; i++) this._substep(h, ctrl, track);

    this._collide(track);
    this._publish(dt, ctrl);
    this._guard();
  }

  _substep(h, controls, track) {
    const s = this.state;
    const cfg = this.config;

    _qInv.copy(s.quaternion).invert();
    _fwd.copy(AXIS_FWD).applyQuaternion(s.quaternion);
    _right.copy(AXIS_X).applyQuaternion(s.quaternion);
    _up.copy(AXIS_Y).applyQuaternion(s.quaternion);
    _rayDir.copy(_up).multiplyScalar(-1);

    _localVel.copy(s.velocity).applyQuaternion(_qInv);
    const speed = -_localVel.z;
    const lateral = _localVel.x;
    const airSpeed = Math.abs(speed);

    this._updateSteering(h, controls);

    // Suspension geometry first: the ray hits feed both the spring forces and the ride
    // heights that the aero map depends on.
    this._castWheels(track);
    this.suspension.solve(h, this._travel, this._contactFlag, this._prevFx);

    const rh = this._rideHeight;
    const rhFront = 0.5 * (rh[0] + rh[1]);
    const rhRear = 0.5 * (rh[2] + rh[3]);

    _avgNormal.set(0, 0, 0);
    let contacts = 0;
    for (let i = 0; i < 4; i++) {
      if (this._contactFlag[i]) {
        _avgNormal.add(this._surf[i].normal);
        contacts++;
      }
    }
    if (contacts > 0) _avgNormal.multiplyScalar(1 / contacts);
    else _avgNormal.copy(WORLD_UP);

    const roll = Math.asin(clamp(_right.dot(_avgNormal), -1, 1));
    const sideslip = Math.atan2(lateral, Math.max(1, airSpeed));

    this.aero.setDamage(s.damage.front, s.damage.rear, s.damage.floor);
    this.aero.requestDrs(!!controls.drs && (controls.brake ?? 0) < 0.05);
    this.aero.step(h, airSpeed, rhFront, rhRear, roll, sideslip, lateral);

    this.powertrain.step(h, controls, this._wheelOmega, this._slipRatios,
      speed, airSpeed, this.events);

    _forceAcc.set(0, -cfg.chassis.mass * G, 0);
    _torqueAcc.set(0, 0, 0);

    this._applyAero();
    this._solveWheels(h, airSpeed);
    this._applyGyroscopic(s.angularVelocity);
    this._integrate(h);
  }

  /**
   * Rack with a finite slew rate plus Ackermann, so a keyboard slam cannot teleport the
   * front wheels and the inside wheel always carries more lock than the outside one.
   */
  _updateSteering(h, controls) {
    const st = this.config.steering;
    const input = clamp(controls.steer ?? 0, -1, 1);
    const target = input * st.maxRoadWheelAngle;
    const base = moveTowards(this._steerBase, target, st.rackSpeed * h);
    this._steerBase = base;

    const ack = st.ackermann * Math.abs(base);
    if (base >= 0) {
      this._steerAngle[0] = base + this.suspension.toe[0];
      this._steerAngle[1] = base + ack + this.suspension.toe[1];
    } else {
      this._steerAngle[0] = base - ack + this.suspension.toe[0];
      this._steerAngle[1] = base + this.suspension.toe[1];
    }
    this._steerAngle[2] = this.suspension.toe[2];
    this._steerAngle[3] = this.suspension.toe[3];
  }

  /** Ray-cast every wheel against the surface and fill travel, ride height and contact. */
  _castWheels(track) {
    const s = this.state;
    const lift = this.config.suspension.rayLift;
    const aeroCfg = this.config.aero;

    for (let i = 0; i < 4; i++) {
      const tyre = this.tyres[i];
      const susp = this.suspension.spec(i);
      const r0 = tyre.spec.radius;

      _rayOrigin.copy(this._wheelLocal[i]).applyQuaternion(s.quaternion).add(s.position);
      _rayOrigin.addScaledVector(_up, lift);
      _query.copy(_rayOrigin).addScaledVector(_rayDir, lift + r0);

      const surf = this._sampleSurface(track, _query, this._surf[i]);
      const n = surf.normal;

      // Signed perpendicular offset from the ray origin to the sampled surface plane.
      const dPerp = (_query.x - _rayOrigin.x) * n.x
        + (surf.height - _rayOrigin.y) * n.y
        + (_query.z - _rayOrigin.z) * n.z;

      this._rideHeight[i] = (IS_FRONT[i]
        ? aeroCfg.referenceRideHeightFront
        : aeroCfg.referenceRideHeightRear) - dPerp - r0 - lift;

      const dd = _rayDir.dot(n);
      if (dd > -0.2) {
        // The ray is nearly parallel to the surface (car on its side): no support.
        this._travel[i] = -susp.maxDroop - 0.001;
        this._contactFlag[i] = 0;
        continue;
      }

      // Geometry uses the undeformed radius: the carcass compliance is already in the
      // suspension's series rate, and feeding it back through the ray would make the
      // damper react to its own tyre deflection.
      const sRay = (dPerp + r0) / dd;
      const travel = lift - sRay;
      this._travel[i] = clamp(travel, -susp.maxDroop - 0.05, susp.maxBump + 0.06);
      this._contactFlag[i] = travel > -susp.maxDroop ? 1 : 0;
    }
  }

  _sampleSurface(track, pos, out) {
    if (track && typeof track.surfaceAt === 'function') {
      return track.surfaceAt(pos, out) || out;
    }
    out.height = 0;
    out.normal.set(0, 1, 0);
    out.grip = 1;
    out.type = 'asphalt';
    out.roughness = 0.02;
    out.drag = 0;
    return out;
  }

  _applyAero() {
    const cfg = this.config;
    const aero = this.aero;
    const s = this.state;

    // Downforce acts along the body -Y at the front and rear aero centres, so rolling or
    // pitching the car tilts the load vector exactly as it does in reality.
    _force.copy(_up).multiplyScalar(-aero.downforceFront);
    this._applyForceAtLocal(_force, 0, 0, -cfg.chassis.cgToFront);
    _force.copy(_up).multiplyScalar(-aero.downforceRear);
    this._applyForceAtLocal(_force, 0, 0, cfg.chassis.cgToRear);

    const vLen = s.velocity.length();
    if (vLen > 0.05) {
      _force.copy(s.velocity).multiplyScalar(-aero.drag / vLen);
      this._applyForceAtLocal(_force, 0,
        cfg.aero.dragCentreHeight - cfg.chassis.cgHeight, 0);
    }

    if (Math.abs(aero.sideForce) > 1) {
      _force.copy(_right).multiplyScalar(aero.sideForce);
      this._applyForceAtLocal(_force, 0, 0, cfg.aero.sideCentreOffset);
    }
  }

  _solveWheels(h, airSpeed) {
    const s = this.state;
    const cfg = this.config;
    const pt = this.powertrain;
    const tyresCfg = cfg.tyres;
    const lift = cfg.suspension.rayLift;

    let steeringTorque = 0;
    let anyKerb = false;
    let onTrackWheels = 0;
    let gripSum = 0;
    let airborneCount = 0;

    for (let i = 0; i < 4; i++) {
      const tyre = this.tyres[i];
      const surf = this._surf[i];
      const contact = this._contactFlag[i] === 1;
      const unsprung = IS_FRONT[i] ? cfg.chassis.unsprungFront : cfg.chassis.unsprungRear;

      if (!contact) airborneCount++;
      if (surf.type === 'kerb') anyKerb = true;
      if (surf.type === 'asphalt' || surf.type === 'kerb' || surf.type === 'concrete') {
        onTrackWheels++;
      }
      gripSum += surf.grip;

      const sRay = lift - this.suspension.travel[i];
      _rayOrigin.copy(this._wheelLocal[i]).applyQuaternion(s.quaternion).add(s.position);
      _rayOrigin.addScaledVector(_up, lift);
      _wheelCentre.copy(_rayOrigin).addScaledVector(_rayDir, sRay);
      _contactPoint.copy(_wheelCentre).addScaledVector(surf.normal, -tyre.spec.radius);

      // The tyre carries the strut force plus the weight of its own unsprung corner.
      const load = contact
        ? this.suspension.force[i] + unsprung * G * Math.max(0, surf.normal.y)
        : 0;
      tyre.updateLoadedRadius(load, this._wheelOmega[i]);

      _arm.copy(_contactPoint).sub(s.position);
      _vContact.copy(s.angularVelocity).cross(_arm).add(s.velocity);

      // Wheel heading: chassis forward, steered about the body up axis, then flattened
      // into the contact plane so banking and kerb faces are handled correctly.
      _qTmp.setFromAxisAngle(_up, -this._steerAngle[i]);
      _tyreFwd.copy(_fwd).applyQuaternion(_qTmp);
      _tyreFwd.addScaledVector(surf.normal, -_tyreFwd.dot(surf.normal));
      if (_tyreFwd.lengthSq() < 1e-8) _tyreFwd.copy(_fwd);
      _tyreFwd.normalize();
      _tyreLat.copy(_tyreFwd).cross(surf.normal).normalize();

      const vx = _vContact.dot(_tyreFwd);
      const vy = _vContact.dot(_tyreLat);

      // Inclination angle: static and travel-induced camber plus however the chassis is
      // leaning relative to this particular contact patch.
      const bank = Math.atan2(_up.dot(_tyreLat), Math.max(1e-4, _up.dot(surf.normal)));
      const gamma = this.suspension.camber[i] + bank;
      this._gamma[i] = gamma;

      tyre.integrateSlip(h, vx, vy, this._wheelOmega[i], contact);
      this._slipRatios[i] = tyre.slipRatio;

      tyre.solve(load, gamma, contact ? surf.grip : 0);
      tyre.thermal(h, airSpeed, tyresCfg.ambientTemp, tyresCfg.trackTemp,
        pt.brakeTemp[i], gamma);

      const fx = contact ? tyre.fx : 0;
      const fy = contact ? tyre.fy : 0;
      this._prevFx[i] = fx;

      // Wheel spin: drive plus tyre reaction first, then the brake as a torque that can
      // stop the wheel but can never drive it backwards through zero.
      const inertia = tyre.spec.inertia + pt.reflectedInertia[i];
      let w = this._wheelOmega[i];
      w += h * (pt.driveTorque[i] - fx * tyre.loadedRadius) / inertia;
      const brakeCapacity = Math.abs(w) * inertia / h;
      const brakeApplied = Math.min(pt.brakeTorque[i], brakeCapacity);
      w -= (w >= 0 ? 1 : -1) * brakeApplied * h / inertia;
      if (!Number.isFinite(w)) w = 0;
      this._wheelOmega[i] = clamp(w, -700, 700);
      this._spinAngle[i] = (this._spinAngle[i] + this._wheelOmega[i] * h) % (Math.PI * 2);

      if (!contact) continue;

      // Rolling resistance, multiplied up by whatever the wheel is ploughing through.
      const rr = cfg.chassis.rollingResistance * (1 + surf.drag * 12) * load
        * Math.tanh(vx * 3);

      _force.copy(_tyreFwd).multiplyScalar(fx - rr);
      _force.addScaledVector(_tyreLat, fy);
      _force.addScaledVector(surf.normal, load);
      _forceAcc.add(_force);
      _torque.copy(_arm).cross(_force);
      _torqueAcc.add(_torque);

      _torqueAcc.addScaledVector(surf.normal, tyre.mz);
      if (IS_FRONT[i]) steeringTorque += tyre.mz;
    }

    s.steeringTorque = steeringTorque;
    s.surfaceGrip = gripSum * 0.25;
    s.onTrack = onTrackWheels >= 3;
    s.airborne = airborneCount === 4;
    this._kerbFlag = anyKerb;
  }

  /**
   * Gyroscopic couple from the four spinning wheels: yawing a car carrying 250 rad/s of
   * wheel speed makes a real roll moment. Small, but it is not zero and it is free.
   */
  _applyGyroscopic(omega) {
    for (let i = 0; i < 4; i++) {
      // The spin axis is the chassis +X; rolling forward is negative about it.
      const L = -this.tyres[i].spec.inertia * this._wheelOmega[i];
      _tmp.copy(_right).multiplyScalar(L);
      _tmp2.copy(omega).cross(_tmp);
      _torqueAcc.sub(_tmp2);
    }
  }

  _applyForceAtLocal(force, lx, ly, lz) {
    _forceAcc.add(force);
    _tmp.set(lx, ly, lz).applyQuaternion(this.state.quaternion);
    _tmp2.copy(_tmp).cross(force);
    _torqueAcc.add(_tmp2);
  }

  /** Semi-implicit Euler; rotation solved with Euler's equations in the body frame. */
  _integrate(h) {
    const s = this.state;

    s.velocity.addScaledVector(_forceAcc, this._invMass * h);
    const vLen = s.velocity.lengthSq();
    if (vLen > 40000) s.velocity.multiplyScalar(200 / Math.sqrt(vLen));
    s.position.addScaledVector(s.velocity, h);

    _qInv.copy(s.quaternion).invert();
    _localOmega.copy(s.angularVelocity).applyQuaternion(_qInv);
    _localTorque.copy(_torqueAcc).applyQuaternion(_qInv);

    const I = this.config.chassis.inertia;
    const wx = _localOmega.x;
    const wy = _localOmega.y;
    const wz = _localOmega.z;

    _localAlpha.set(
      (_localTorque.x - (wy * (I.z * wz) - wz * (I.y * wy))) * this._invIx,
      (_localTorque.y - (wz * (I.x * wx) - wx * (I.z * wz))) * this._invIy,
      (_localTorque.z - (wx * (I.y * wy) - wy * (I.x * wx))) * this._invIz,
    );

    _localOmega.addScaledVector(_localAlpha, h);
    s.angularVelocity.copy(_localOmega).applyQuaternion(s.quaternion);
    const wLen = s.angularVelocity.lengthSq();
    if (wLen > 400) s.angularVelocity.multiplyScalar(20 / Math.sqrt(wLen));

    _qTmp.set(s.angularVelocity.x, s.angularVelocity.y, s.angularVelocity.z, 0);
    _qTmp.multiply(s.quaternion);
    s.quaternion.x += _qTmp.x * 0.5 * h;
    s.quaternion.y += _qTmp.y * 0.5 * h;
    s.quaternion.z += _qTmp.z * 0.5 * h;
    s.quaternion.w += _qTmp.w * 0.5 * h;
    s.quaternion.normalize();

    this._resolvePenetration();
  }

  /**
   * Last-resort penetration recovery. The bump stops are stiff enough that this should
   * not fire in normal driving; it exists so a 250 km/h landing on a kerb cannot tunnel
   * the car through the world.
   */
  _resolvePenetration() {
    let worst = 0;
    for (let i = 0; i < 4; i++) {
      if (!this._contactFlag[i]) continue;
      const over = this._travel[i] - this.suspension.maxBump(i);
      if (over > worst) worst = over;
    }
    if (worst <= 0.002) return;
    const s = this.state;
    s.position.addScaledVector(_up, worst);
    const vn = s.velocity.dot(_up);
    if (vn < 0) s.velocity.addScaledVector(_up, -vn * 0.8);
    for (let i = 0; i < 4; i++) this._travel[i] -= worst;
  }

  /** Barrier response: normal impulse with restitution, Coulomb friction, and damage. */
  _collide(track) {
    if (!track || typeof track.barrierCollide !== 'function') return;
    const s = this.state;
    const dcfg = this.config.damage;

    for (let p = 0; p < 3; p++) {
      _probe.copy(this._probeLocal[p]).applyQuaternion(s.quaternion).add(s.position);
      const hit = track.barrierCollide(_probe, PROBE_RADIUS[p], this._barrierOut);
      if (!hit || hit.hit === false) continue;

      const n = hit.normal;
      const pen = hit.penetration || 0;
      if (pen > 0) s.position.addScaledVector(n, pen);

      _arm.copy(_probe).sub(s.position);
      _vContact.copy(s.angularVelocity).cross(_arm).add(s.velocity);
      const vn = _vContact.dot(n);
      if (vn >= 0) continue;

      const j = -(1 + dcfg.restitution) * vn * this._effectiveMass(_arm, n);
      _impulse.copy(n).multiplyScalar(j);
      this._applyImpulse(_impulse, _arm);

      // Coulomb friction along the wall — this is what scrubs speed off in a wall ride.
      _tangent.copy(_vContact).addScaledVector(n, -vn);
      const vtLen = _tangent.length();
      if (vtLen > 0.01) {
        _tangent.multiplyScalar(1 / vtLen);
        const jt = Math.min(dcfg.friction * j, vtLen * this._effectiveMass(_arm, _tangent));
        _impulse.copy(_tangent).multiplyScalar(-jt);
        this._applyImpulse(_impulse, _arm);
      }

      // Only genuine impacts break the car. Sliding along a barrier applies a small
      // impulse every tick, and without this threshold a long wall-ride would total a
      // car that in reality only loses paint.
      const section = PROBE_DAMAGE[p];
      if (j > dcfg.impactThreshold) {
        const scale = section === 'front' ? dcfg.frontImpulse
          : section === 'rear' ? dcfg.rearImpulse : dcfg.floorImpulse;
        s.damage[section] = clamp01(s.damage[section]
          + (j - dcfg.impactThreshold) / scale);
      }

      if (this.events) {
        this.events.emit('car:collision', {
          section, impulse: j, speed: -vn, position: _probe,
        });
      }
    }
  }

  /** Inverse of (1/m + n . ((I^-1 (r x n)) x r)) — the standard contact effective mass. */
  _effectiveMass(arm, dir) {
    _tmp.copy(arm).cross(dir);
    _qInv.copy(this.state.quaternion).invert();
    _tmp.applyQuaternion(_qInv);
    _tmp.set(_tmp.x * this._invIx, _tmp.y * this._invIy, _tmp.z * this._invIz);
    _tmp.applyQuaternion(this.state.quaternion);
    _tmp2.copy(_tmp).cross(arm);
    const denom = this._invMass + _tmp2.dot(dir);
    return denom > 1e-6 ? 1 / denom : this.config.chassis.mass;
  }

  _applyImpulse(impulse, arm) {
    const s = this.state;
    s.velocity.addScaledVector(impulse, this._invMass);
    _tmp.copy(arm).cross(impulse);
    _qInv.copy(s.quaternion).invert();
    _tmp.applyQuaternion(_qInv);
    _tmp.set(_tmp.x * this._invIx, _tmp.y * this._invIy, _tmp.z * this._invIz);
    _tmp.applyQuaternion(s.quaternion);
    s.angularVelocity.add(_tmp);
  }

  /** Copy the internal solution into the public state object. Allocation free. */
  _publish(dt, controls) {
    const s = this.state;
    const cfg = this.config;
    const pt = this.powertrain;
    const aero = this.aero;

    _qInv.copy(s.quaternion).invert();
    _up.copy(AXIS_Y).applyQuaternion(s.quaternion);
    _rayDir.copy(_up).multiplyScalar(-1);

    s.localVelocity.copy(s.velocity).applyQuaternion(_qInv);
    s.speed = -s.localVelocity.z;
    s.speedKph = s.speed * 3.6;

    // Specific force — what an accelerometer bolted to the chassis reads. It shows 1 g
    // vertical at rest, which is what the cockpit head model and the HUD both want.
    _accel.copy(s.velocity).sub(this._prevVel).multiplyScalar(dt > 0 ? 1 / dt : 0);
    _accel.y += G;
    s.accel.copy(_accel).applyQuaternion(_qInv);
    s.gForce.copy(s.accel).multiplyScalar(1 / G);

    s.rpm = pt.rpm;
    s.gear = pt.gear;
    s.throttle = controls ? clamp01(controls.throttle ?? 0) : 0;
    s.brake = controls ? clamp01(controls.brake ?? 0) : 0;
    s.steer = controls ? clamp(controls.steer ?? 0, -1, 1) : 0;
    s.clutch = controls ? clamp01(controls.clutch ?? 0) : 0;
    s.engineTorque = pt.engineTorque;
    s.wheelTorque = pt.wheelTorque;
    s.shiftTimer = pt.shiftTimer;
    s.limiterActive = pt.limiterActive;
    s.boost = pt.boost;
    s.fuel = pt.fuel;
    s.pitLimiter = pt.pitLimiterActive;

    s.aero.downforceFront = aero.downforceFront;
    s.aero.downforceRear = aero.downforceRear;
    s.aero.drag = aero.drag;
    s.aero.balance = aero.balance;
    s.aero.stalled = aero.stalled;
    s.groundEffect = aero.groundEffect;
    s.rideHeightFront = 0.5 * (this._rideHeight[0] + this._rideHeight[1]);
    s.rideHeightRear = 0.5 * (this._rideHeight[2] + this._rideHeight[3]);

    s.drs.open = aero.drsOpen > 0.5;
    s.drs.available = aero.drsAvailable;
    s.drs.zoneActive = aero.drsZoneActive;

    s.ers.charge = pt.ers.charge;
    s.ers.deploy = pt.ers.deploy;
    s.ers.harvestMGUK = pt.ers.harvestMGUK;
    s.ers.harvestMGUH = pt.ers.harvestMGUH;
    s.ers.mode = pt.ers.mode;

    for (let i = 0; i < 4; i++) s.brakeTemp[i] = pt.brakeTemp[i];

    s.slipAngleBody = Math.atan2(s.localVelocity.x, Math.max(1, Math.abs(s.speed)));
    s.kerbContact = this._kerbFlag;

    const lift = cfg.suspension.rayLift;
    let lockup = 0;
    let spin = 0;

    for (let i = 0; i < 4; i++) {
      const w = s.wheels[i];
      const tyre = this.tyres[i];

      const sRay = lift - this.suspension.travel[i];
      _rayOrigin.copy(this._wheelLocal[i]).applyQuaternion(s.quaternion).add(s.position);
      _rayOrigin.addScaledVector(_up, lift);
      w.worldPosition.copy(_rayOrigin).addScaledVector(_rayDir, sRay);

      w.steerAngle = this._steerAngle[i];
      w.spinAngle = this._spinAngle[i];
      w.angularVelocity = this._wheelOmega[i];

      // Steer about the body up, camber about the heading, spin about the wheel axis.
      // `spinAngle` is forward-positive; the visual sign is baked in here so a consumer
      // can apply this quaternion to a wheel mesh with no correction.
      w.worldQuaternion.copy(s.quaternion);
      _qTmp.setFromAxisAngle(AXIS_Y, -this._steerAngle[i]);
      w.worldQuaternion.multiply(_qTmp);
      _qTmp.setFromAxisAngle(AXIS_FWD, this._gamma[i]);
      w.worldQuaternion.multiply(_qTmp);
      _qTmp.setFromAxisAngle(AXIS_X, -this._spinAngle[i]);
      w.worldQuaternion.multiply(_qTmp);

      w.slipRatio = tyre.slipRatio;
      w.slipAngle = tyre.slipAngle;
      w.load = tyre.load;
      w.fx = tyre.fx;
      w.fy = tyre.fy;
      w.mz = tyre.mz;
      w.contact = this._contactFlag[i] === 1;
      w.camber = this._gamma[i];
      w.rideHeight = this._rideHeight[i];

      w.suspension.compression = this.suspension.compression[i];
      w.suspension.travel = this.suspension.travel[i];
      w.suspension.velocity = this.suspension.velocity[i];

      w.temperature.surface = tyre.surfaceTemp;
      w.temperature.core = tyre.coreTemp;
      w.wear = tyre.wear;
      w.surface = this._surf[i].type;

      const roadSpeed = Math.max(2, Math.abs(s.speed));
      const rollSpeed = this._wheelOmega[i] * tyre.loadedRadius;
      w.lockup = w.contact ? clamp01((roadSpeed - rollSpeed) / roadSpeed * 3.2) : 0;
      w.spin = w.contact ? clamp01((rollSpeed - roadSpeed) / roadSpeed * 3.2) : 0;
      if (w.lockup > lockup) lockup = w.lockup;
      if (w.spin > spin) spin = w.spin;
    }

    // Grinding the plank along the road wears the floor away.
    const scrape = this.suspension.bumpStopEnergy;
    this.suspension.bumpStopEnergy = 0;
    if (scrape > 0 && Math.abs(s.speed) > 12) {
      s.damage.floor = clamp01(s.damage.floor
        + scrape * this.config.damage.floorScrapePerJoule);
    }

    this._emitEvents(lockup, spin);
  }

  _emitEvents(lockup, spin) {
    const events = this.events;
    if (!events) return;
    const s = this.state;

    if (!s.onTrack && !this._offTrack) {
      this._offTrack = true;
      events.emit('car:offtrack', { surface: s.wheels[0].surface, speed: s.speed });
    } else if (s.onTrack && this._offTrack) {
      this._offTrack = false;
    }

    if (this._kerbFlag && !this._kerbLatch) {
      this._kerbLatch = true;
      events.emit('car:kerb', { speed: s.speed });
    } else if (!this._kerbFlag) {
      this._kerbLatch = false;
    }

    if (lockup > 0.55 && !this._lockupLatch) {
      this._lockupLatch = true;
      events.emit('car:lockup', { amount: lockup });
    } else if (lockup < 0.30) {
      this._lockupLatch = false;
    }

    if (spin > 0.45 && !this._spinLatch) {
      this._spinLatch = true;
      events.emit('car:wheelspin', { amount: spin });
    } else if (spin < 0.20) {
      this._spinLatch = false;
    }
  }

  /**
   * Numerical safety net. One non-finite value would poison the entire state, so the
   * last known-good pose is restored rather than shipping a NaN to the renderer. This
   * must never fire; it is here because "must never" is not the same as "cannot".
   */
  _guard() {
    const s = this.state;
    const ok = Number.isFinite(s.position.x) && Number.isFinite(s.position.y)
      && Number.isFinite(s.position.z) && Number.isFinite(s.velocity.x)
      && Number.isFinite(s.velocity.y) && Number.isFinite(s.velocity.z)
      && Number.isFinite(s.quaternion.x) && Number.isFinite(s.quaternion.w)
      && Number.isFinite(s.angularVelocity.x) && Number.isFinite(s.angularVelocity.y)
      && Number.isFinite(s.angularVelocity.z);

    if (ok) {
      this._safePosition.copy(s.position);
      this._safeQuaternion.copy(s.quaternion);
      return;
    }

    s.position.copy(this._safePosition);
    s.quaternion.copy(this._safeQuaternion);
    s.velocity.set(0, 0, 0);
    s.angularVelocity.set(0, 0, 0);
    for (let i = 0; i < 4; i++) {
      this._wheelOmega[i] = 0;
      this.tyres[i].kappa = 0;
      this.tyres[i].alpha = 0;
    }
    this.recoveries++;
  }

  /** Report the car ahead so the aero map can apply its dirty air. */
  setWake(distance, lateral) {
    this.aero.setWake(distance, lateral);
  }

  setDrsZone(active, available) {
    this.aero.setDrsZone(active, available);
  }

  notifyLap() {
    this.powertrain.notifyLap();
  }

  dispose() {
    this.events = null;
  }
}

export { SUBSTEP_DT, EMPTY_CONTROLS };
