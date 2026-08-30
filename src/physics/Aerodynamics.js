/**
 * Aerodynamics for a ground-effect Formula 1 car.
 *
 * Downforce and drag both scale with v^2. Front and rear centres of pressure are
 * separate, so aero balance migrates as speed and ride height change instead of being a
 * fixed number. The venturi floor gains hard as it approaches the road and then STALLS
 * when the edge seal is lost — too low, too much roll, or too much yaw. That stall,
 * combined with the finite time the pressure field takes to re-establish, is what makes
 * porpoising an emergent behaviour of the platform rather than a scripted wobble.
 *
 * All outputs are magnitudes in newtons in the car frame: downforce pushes along -Y_local,
 * drag opposes the direction of travel, side force acts along +/-X_local.
 */

import { clamp, clamp01, smoothstep } from '../core/MathUtils.js';

export class Aerodynamics {
  constructor(config) {
    this.config = config;
    this.cfg = config.aero;
    this.wheelbase = config.chassis.wheelbase;

    this.downforceFront = 0;
    this.downforceRear = 0;
    this.downforce = 0;
    this.drag = 0;
    this.sideForce = 0;
    this.balance = this.cfg.frontBalance;
    this.stalled = false;
    this.stallFactor = 1;
    this.groundEffect = 1;
    this.pitchMoment = 0;

    this._geTarget = 1;
    this._geActual = 1;
    this._rhFront = this.cfg.referenceRideHeightFront;
    this._rhRear = this.cfg.referenceRideHeightRear;
    this._rhFrontRate = 0;

    this.drsOpen = 0;         // 0..1 flap position
    this.drsCommanded = false;
    this.drsAvailable = false;
    this.drsZoneActive = false;

    this.wakeDistance = Infinity;
    this.wakeLateral = 0;
    this.wakeFrontFactor = 1;
    this.wakeRearFactor = 1;
    this.wakeDragFactor = 1;

    this.damageFront = 0;
    this.damageRear = 0;
    this.damageFloor = 0;
  }

  reset() {
    this.downforceFront = 0;
    this.downforceRear = 0;
    this.downforce = 0;
    this.drag = 0;
    this.sideForce = 0;
    this.balance = this.cfg.frontBalance;
    this.stalled = false;
    this.stallFactor = 1;
    this.groundEffect = 1;
    this._geTarget = 1;
    this._geActual = 1;
    this._rhFront = this.cfg.referenceRideHeightFront;
    this._rhRear = this.cfg.referenceRideHeightRear;
    this._rhFrontRate = 0;
    this.drsOpen = 0;
    this.drsCommanded = false;
    this.wakeDistance = Infinity;
    this.wakeFrontFactor = 1;
    this.wakeRearFactor = 1;
    this.wakeDragFactor = 1;
  }

  /**
   * Report the car ahead so the wake can be applied. Call once per tick; pass
   * `Infinity` (or nothing) when there is nobody in front.
   * @param {number} distance metres of gap, nose to tail
   * @param {number} lateral metres of lateral offset between the two cars
   */
  setWake(distance = Infinity, lateral = 0) {
    this.wakeDistance = distance;
    this.wakeLateral = lateral;
  }

  /** Damage fractions 0..1 from VehiclePhysics; they cost downforce and add drag. */
  setDamage(front, rear, floor) {
    this.damageFront = clamp01(front);
    this.damageRear = clamp01(rear);
    this.damageFloor = clamp01(floor);
  }

  /** Race director / DRS zone logic drives these two. */
  setDrsZone(active, available) {
    this.drsZoneActive = active;
    this.drsAvailable = available;
  }

  requestDrs(open) {
    this.drsCommanded = open;
  }

  /**
   * @param {number} dt
   * @param {number} speed forward air speed, m/s (magnitude used for q)
   * @param {number} rhFront floor height at the front axle, metres
   * @param {number} rhRear floor height at the rear axle, metres
   * @param {number} roll roll angle, rad
   * @param {number} sideslip body slip angle, rad
   * @param {number} lateralSpeed car-frame lateral velocity, m/s
   */
  step(dt, speed, rhFront, rhRear, roll, sideslip, lateralSpeed) {
    const cfg = this.cfg;
    const v = Math.abs(speed);
    const q = 0.5 * cfg.airDensity * v * v;

    // DRS flap actuation. It will not open below the minimum speed and it slams shut the
    // instant the driver touches the brakes (handled by the caller clearing the request).
    const wantOpen = this.drsCommanded && this.drsAvailable && v > cfg.drs.minSpeed;
    const rate = wantOpen ? dt / cfg.drs.openTime : -dt / cfg.drs.closeTime;
    this.drsOpen = clamp01(this.drsOpen + rate);

    this._rhFrontRate = dt > 1e-6 ? (rhFront - this._rhFront) / dt : 0;
    this._rhFront = rhFront;
    this._rhRear = rhRear;

    // Ground effect. Suction climbs from free-air conditions at `groundEffectOnset` down
    // to the peak, then the diffuser chokes and the edge seal breaks.
    const approach = smoothstep(cfg.groundEffectOnset, cfg.groundEffectPeak, rhFront);
    const sealed = smoothstep(cfg.stallHeight, cfg.stallRecoverHeight, rhFront);
    const heightStall = 1 - cfg.stallDepth * (1 - sealed);

    const rollStall = 1 - cfg.rollStallDepth
      * smoothstep(cfg.rollStallAngle, cfg.rollStallFull, Math.abs(roll));
    const yawStall = 1 - cfg.yawStallDepth
      * smoothstep(cfg.yawStallAngle, cfg.yawStallAngle * 3.2, Math.abs(sideslip));

    this.stallFactor = heightStall * rollStall * yawStall;
    this._geTarget = 1 + cfg.groundEffectGain * approach * this.stallFactor;

    // First-order lag: the pressure field cannot follow the platform instantly, which is
    // exactly the phase shift that lets the stall pump energy into a heave oscillation.
    const k = dt / (cfg.responseTime + dt);
    this._geActual += (this._geTarget - this._geActual) * k;

    // Rate feedback. Rising away from the road briefly makes more load, which pulls the
    // car back down: light damping keeps porpoising felt rather than nauseating.
    const damp = clamp(cfg.heaveDamping * this._rhFrontRate, -0.25, 0.25);
    this.groundEffect = Math.max(0.35, this._geActual + damp);
    this.stalled = this.stallFactor < 0.94;

    this._updateWake();

    const dmg = cfg.damage;
    const frontDamageMul = 1 - dmg.frontLossPerUnit * this.damageFront;
    const rearDamageMul = 1 - dmg.rearLossPerUnit * this.damageRear;
    const floorDamageMul = 1 - dmg.floorLossPerUnit * this.damageFloor;

    // Aero balance. Rake and speed both move the centre of pressure; the front wing runs
    // out of ride height first, so the car pushes on at the end of a long straight.
    const speedShift = cfg.balanceSpeedShift * (v / 100) * (v / 100);
    const rhShift = cfg.balanceRideHeightGain * (rhFront - cfg.referenceRideHeightFront);
    let balance = cfg.frontBalance - speedShift + rhShift;
    balance = clamp(balance, cfg.balanceMin, cfg.balanceMax);

    const clA = cfg.clA * this.groundEffect * floorDamageMul;
    let dfFront = q * clA * balance * frontDamageMul * this.wakeFrontFactor;
    let dfRear = q * clA * (1 - balance) * rearDamageMul * this.wakeRearFactor;

    // DRS: the rear flap lies down, giving up rear load and, with it, the drag.
    dfRear *= 1 - cfg.drs.rearDownforceLoss * this.drsOpen;

    this.downforceFront = dfFront;
    this.downforceRear = dfRear;
    this.downforce = dfFront + dfRear;
    this.balance = this.downforce > 1 ? dfFront / this.downforce : balance;

    // Drag: parasitic + induced (proportional to the square of the load being made) and
    // the DRS delta, all scaled by the slipstream and by bodywork damage.
    const df10 = this.downforce / 10000;
    let cdA = cfg.cdA + cfg.inducedDrag * df10 * df10;
    cdA -= cfg.drs.dragDelta * this.drsOpen;
    cdA *= 1 + dmg.dragGainPerUnit * (this.damageFront + this.damageRear) * 0.5;
    cdA = Math.max(0.35, cdA);
    this.drag = q * cdA * this.wakeDragFactor;

    // Crosswind / big-yaw side force, applied ahead of the CG so a slide is mildly
    // divergent — the car will not self-rescue a spin for you.
    const vy = clamp(lateralSpeed, -60, 60);
    this.sideForce = -0.5 * cfg.airDensity * cfg.sideForceArea * vy * Math.abs(vy);

    // Drag acts above the CG, so it pitches the nose down as speed rises.
    this.pitchMoment = this.drag * (cfg.dragCentreHeight - this.config.chassis.cgHeight);
  }

  _updateWake() {
    const w = this.cfg.wake;
    const d = this.wakeDistance;
    if (!(d < w.length * 4)) {
      this.wakeFrontFactor = 1;
      this.wakeRearFactor = 1;
      this.wakeDragFactor = 1;
      return;
    }
    const axial = Math.exp(-Math.max(0, d) / w.length);
    const lateral = 1 - clamp01(Math.abs(this.wakeLateral) / w.lateralWidth);
    const s = axial * lateral * lateral;
    this.wakeFrontFactor = 1 - w.frontLoss * s;
    this.wakeRearFactor = 1 - w.rearLoss * s;
    this.wakeDragFactor = 1 - w.dragLoss * s;
  }

  /** Speed at which the car generates its own weight in downforce — a useful readout. */
  get oneGSpeed() {
    const w = this.config.chassis.mass * 9.80665;
    return Math.sqrt(w / (0.5 * this.cfg.airDensity * this.cfg.clA));
  }
}
