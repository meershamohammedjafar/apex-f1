import { clamp, clamp01, smoothstep } from "../core/MathUtils.js";
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
    this.drsOpen = 0;
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
  setWake(distance = Infinity, lateral = 0) {
    this.wakeDistance = distance;
    this.wakeLateral = lateral;
  }
  setDamage(front, rear, floor) {
    this.damageFront = clamp01(front);
    this.damageRear = clamp01(rear);
    this.damageFloor = clamp01(floor);
  }
  setDrsZone(active, available) {
    this.drsZoneActive = active;
    this.drsAvailable = available;
  }
  requestDrs(open) {
    this.drsCommanded = open;
  }
  step(dt, speed, rhFront, rhRear, roll, sideslip, lateralSpeed) {
    const cfg = this.cfg;
    const v = Math.abs(speed);
    const q = 0.5 * cfg.airDensity * v * v;
    const wantOpen = this.drsCommanded && this.drsAvailable && v > cfg.drs.minSpeed;
    const rate = wantOpen ? dt / cfg.drs.openTime : -dt / cfg.drs.closeTime;
    this.drsOpen = clamp01(this.drsOpen + rate);
    this._rhFrontRate = dt > 1e-6 ? (rhFront - this._rhFront) / dt : 0;
    this._rhFront = rhFront;
    this._rhRear = rhRear;
    const approach = smoothstep(cfg.groundEffectOnset, cfg.groundEffectPeak, rhFront);
    const sealed = smoothstep(cfg.stallHeight, cfg.stallRecoverHeight, rhFront);
    const heightStall = 1 - cfg.stallDepth * (1 - sealed);
    const rollStall = 1 - cfg.rollStallDepth * smoothstep(cfg.rollStallAngle, cfg.rollStallFull, Math.abs(roll));
    const yawStall = 1 - cfg.yawStallDepth * smoothstep(cfg.yawStallAngle, cfg.yawStallAngle * 3.2, Math.abs(sideslip));
    this.stallFactor = heightStall * rollStall * yawStall;
    this._geTarget = 1 + cfg.groundEffectGain * approach * this.stallFactor;
    const k = dt / (cfg.responseTime + dt);
    this._geActual += (this._geTarget - this._geActual) * k;
    const damp = clamp(cfg.heaveDamping * this._rhFrontRate, -0.25, 0.25);
    this.groundEffect = Math.max(0.35, this._geActual + damp);
    this.stalled = this.stallFactor < 0.94;
    this._updateWake();
    const dmg = cfg.damage;
    const frontDamageMul = 1 - dmg.frontLossPerUnit * this.damageFront;
    const rearDamageMul = 1 - dmg.rearLossPerUnit * this.damageRear;
    const floorDamageMul = 1 - dmg.floorLossPerUnit * this.damageFloor;
    const speedShift = cfg.balanceSpeedShift * (v / 100) * (v / 100);
    const rhShift = cfg.balanceRideHeightGain * (rhFront - cfg.referenceRideHeightFront);
    let balance = cfg.frontBalance - speedShift + rhShift;
    balance = clamp(balance, cfg.balanceMin, cfg.balanceMax);
    const clA = cfg.clA * this.groundEffect * floorDamageMul;
    let dfFront = q * clA * balance * frontDamageMul * this.wakeFrontFactor;
    let dfRear = q * clA * (1 - balance) * rearDamageMul * this.wakeRearFactor;
    dfRear *= 1 - cfg.drs.rearDownforceLoss * this.drsOpen;
    this.downforceFront = dfFront;
    this.downforceRear = dfRear;
    this.downforce = dfFront + dfRear;
    this.balance = this.downforce > 1 ? dfFront / this.downforce : balance;
    const df10 = this.downforce / 1e4;
    let cdA = cfg.cdA + cfg.inducedDrag * df10 * df10;
    cdA -= cfg.drs.dragDelta * this.drsOpen;
    cdA *= 1 + dmg.dragGainPerUnit * (this.damageFront + this.damageRear) * 0.5;
    cdA = Math.max(0.35, cdA);
    this.drag = q * cdA * this.wakeDragFactor;
    const vy = clamp(lateralSpeed, -60, 60);
    this.sideForce = -0.5 * cfg.airDensity * cfg.sideForceArea * vy * Math.abs(vy);
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
  get oneGSpeed() {
    const w = this.config.chassis.mass * 9.80665;
    return Math.sqrt(w / (0.5 * this.cfg.airDensity * this.cfg.clA));
  }
}
