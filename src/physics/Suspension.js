import { clamp, clamp01 } from "../core/MathUtils.js";
const ARB_PARTNER = [1, 0, 3, 2];
const IS_FRONT = [true, true, false, false];
const SIDE = [-1, 1, -1, 1];
function damperForce(v, lowC, highC, knee) {
  const a = Math.abs(v);
  const f = a <= knee ? lowC * a : lowC * knee + highC * (a - knee);
  return v < 0 ? -f : f;
}
export class Suspension {
  constructor(config) {
    this.config = config;
    this.front = config.suspension.front;
    this.rear = config.suspension.rear;
    this.wheelbase = config.chassis.wheelbase;
    this.cgHeight = config.chassis.cgHeight;
    this.travel = new Float64Array(4);
    this.velocity = new Float64Array(4);
    this.force = new Float64Array(4);
    this.springForce = new Float64Array(4);
    this.damperForceOut = new Float64Array(4);
    this.bumpStopForce = new Float64Array(4);
    this.antiRollForce = new Float64Array(4);
    this.camber = new Float64Array(4);
    this.toe = new Float64Array(4);
    this.compression = new Float64Array(4);
    this._prevTravel = new Float64Array(4);
    this.bumpStopEnergy = 0;
    this.bottomedOut = false;
    this.reset();
  }
  spec(i) {
    return IS_FRONT[i] ? this.front : this.rear;
  }
  side(i) {
    return SIDE[i];
  }
  isFront(i) {
    return IS_FRONT[i];
  }
  reset() {
    for (let i = 0; i < 4; i++) {
      this.travel[i] = 0;
      this._prevTravel[i] = 0;
      this.velocity[i] = 0;
      const s = this.spec(i);
      this.force[i] = s.staticLoad;
      this.springForce[i] = 0;
      this.damperForceOut[i] = 0;
      this.bumpStopForce[i] = 0;
      this.antiRollForce[i] = 0;
      this.camber[i] = s.staticCamber * SIDE[i];
      this.toe[i] = -s.staticToe * SIDE[i];
      this.compression[i] = clamp01((0 + s.maxDroop) / (s.maxDroop + s.maxBump));
    }
    this.bumpStopEnergy = 0;
    this.bottomedOut = false;
  }
  maxDroop(i) {
    return this.spec(i).maxDroop;
  }
  maxBump(i) {
    return this.spec(i).maxBump;
  }
  solve(dt, travelIn, contact, longForce) {
    const invDt = dt > 1e-6 ? 1 / dt : 0;
    this.bottomedOut = false;
    for (let i = 0; i < 4; i++) {
      const s = this.spec(i);
      const t = clamp(travelIn[i], -s.maxDroop, s.maxBump);
      this.travel[i] = t;
      const v = clamp((t - this._prevTravel[i]) * invDt, -12, 12);
      this.velocity[i] = v;
      this._prevTravel[i] = t;
      this.compression[i] = clamp01((t + s.maxDroop) / (s.maxDroop + s.maxBump));
      this.camber[i] = s.staticCamber * SIDE[i] + s.camberGain * t * SIDE[i];
      this.toe[i] = -(s.staticToe + s.toeGain * t) * SIDE[i];
    }
    for (let i = 0; i < 4; i++) {
      const s = this.spec(i);
      const t = this.travel[i];
      const v = this.velocity[i];
      const mr = s.motionRatio;
      const spring = s.wheelRate * t;
      const dv = v * mr;
      const damper = (dv >= 0 ? damperForce(dv, s.bumpLow, s.bumpHigh, s.bumpKnee) : damperForce(dv, s.reboundLow, s.reboundHigh, s.reboundKnee)) * mr;
      let stop = 0;
      const over = t - s.bumpStopGap;
      if (over > 0) {
        stop = s.bumpStopRate * over * (1 + over / 0.01);
        this.bumpStopEnergy += stop * Math.max(0, v) * dt;
        if (over > 6e-3) this.bottomedOut = true;
      }
      const under = -t - s.droopStopGap;
      if (under > 0) stop -= s.droopStopRate * under * (1 + under / 0.012);
      this.springForce[i] = spring;
      this.damperForceOut[i] = damper;
      this.bumpStopForce[i] = stop;
    }
    for (let i = 0; i < 4; i++) {
      const s = this.spec(i);
      const j = ARB_PARTNER[i];
      this.antiRollForce[i] = s.antiRoll * (this.travel[i] - this.travel[j]) * 0.5;
    }
    for (let i = 0; i < 4; i++) {
      if (!contact[i]) {
        this.force[i] = 0;
        continue;
      }
      const s = this.spec(i);
      const fx = longForce ? longForce[i] : 0;
      const jack = (IS_FRONT[i] ? -s.antiDive : s.antiSquat) * (this.cgHeight / this.wheelbase) * fx;
      const f = s.staticLoad + (this.springForce[i] + this.damperForceOut[i] + this.bumpStopForce[i] + this.antiRollForce[i] + jack) * s.seriesFactor;
      this.force[i] = f > 0 ? f : 0;
    }
  }
  rollStiffness(front) {
    const s = front ? this.front : this.rear;
    const track = front ? this.config.chassis.trackFront : this.config.chassis.trackRear;
    return (s.wheelRate + s.antiRoll * 0.5) * s.seriesFactor * track * track * 0.5;
  }
}
export { SIDE, IS_FRONT, damperForce };
