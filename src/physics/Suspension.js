/**
 * Per-corner suspension: linear main spring on a pushrod motion ratio, digressive
 * dampers with independent bump and rebound curves, progressive bump stops and droop
 * stops, front and rear anti-roll bars, and camber/toe that change with travel.
 *
 * The geometric compression comes in from VehiclePhysics, which ray-casts each wheel
 * against Track.surfaceAt. Everything here is a force computation on that travel, so a
 * kerb genuinely shoves the corner up and the load appears on the opposite wheel through
 * the bar rather than being scripted.
 *
 * Travel sign: + is compression (bump), 0 is the design ride height where the spring
 * exactly carries the static corner weight.
 */

import { clamp, clamp01 } from '../core/MathUtils.js';

const ARB_PARTNER = [1, 0, 3, 2];
const IS_FRONT = [true, true, false, false];
/** +1 for the right-hand wheels, -1 for the left. Sets the sign of static camber/toe. */
const SIDE = [-1, 1, -1, 1];

/** Digressive damper: a firm low-speed knee for platform control, then blow-off. */
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

    /** Energy dumped into the bump stops, used by the caller for floor damage. */
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

  /** Geometric travel limits, so the caller knows when the wheel has run out of droop. */
  maxDroop(i) {
    return this.spec(i).maxDroop;
  }

  maxBump(i) {
    return this.spec(i).maxBump;
  }

  /**
   * Solve all four corners.
   * @param {number} dt
   * @param {Float64Array} travelIn geometric compression per wheel, metres
   * @param {Uint8Array} contact 1 if the wheel is touching a surface
   * @param {Float64Array} longForce per-wheel longitudinal tyre force from the previous
   *        substep, used for the anti-dive / anti-squat link jacking
   */
  solve(dt, travelIn, contact, longForce) {
    const invDt = dt > 1e-6 ? 1 / dt : 0;
    this.bottomedOut = false;

    for (let i = 0; i < 4; i++) {
      const s = this.spec(i);
      const t = clamp(travelIn[i], -s.maxDroop, s.maxBump);
      this.travel[i] = t;
      // Damper velocity is taken from the geometric travel, not from a filtered value:
      // the kerb impulse has to reach the damper or kerbs stop upsetting the car.
      const v = clamp((t - this._prevTravel[i]) * invDt, -12, 12);
      this.velocity[i] = v;
      this._prevTravel[i] = t;
      this.compression[i] = clamp01((t + s.maxDroop) / (s.maxDroop + s.maxBump));

      this.camber[i] = s.staticCamber * SIDE[i] + s.camberGain * t * SIDE[i];
      // Toe convention: config is + for toe-in, so a right-hand wheel points left.
      this.toe[i] = -(s.staticToe + s.toeGain * t) * SIDE[i];
    }

    for (let i = 0; i < 4; i++) {
      const s = this.spec(i);
      const t = this.travel[i];
      const v = this.velocity[i];
      const mr = s.motionRatio;

      const spring = s.wheelRate * t;

      // Convert wheel velocity to damper velocity, evaluate, convert force back.
      const dv = v * mr;
      const damper = (dv >= 0
        ? damperForce(dv, s.bumpLow, s.bumpHigh, s.bumpKnee)
        : damperForce(dv, s.reboundLow, s.reboundHigh, s.reboundKnee)) * mr;

      let stop = 0;
      const over = t - s.bumpStopGap;
      if (over > 0) {
        // Progressive rubber packer: rate rises linearly with crush, so the force is
        // quadratic and bottoming out is violent rather than a soft clip.
        stop = s.bumpStopRate * over * (1 + over / 0.010);
        this.bumpStopEnergy += stop * Math.max(0, v) * dt;
        if (over > 0.006) this.bottomedOut = true;
      }
      const under = -t - s.droopStopGap;
      if (under > 0) stop -= s.droopStopRate * under * (1 + under / 0.012);

      this.springForce[i] = spring;
      this.damperForceOut[i] = damper;
      this.bumpStopForce[i] = stop;
    }

    // Anti-roll bars couple the two wheels on an axle. Front-biased bar stiffness is
    // what gives the car its baseline understeer.
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

      // Anti-dive / anti-squat: part of the longitudinal tyre force is reacted through
      // the wishbones instead of the spring, so the platform stays flatter under braking
      // and traction. Modelled as a side-view-swing-arm jacking force at the patch.
      const fx = longForce ? longForce[i] : 0;
      const jack = (IS_FRONT[i] ? -s.antiDive : s.antiSquat) * (this.cgHeight / this.wheelbase) * fx;

      const f = s.staticLoad + (this.springForce[i] + this.damperForceOut[i]
        + this.bumpStopForce[i] + this.antiRollForce[i] + jack) * s.seriesFactor;

      this.force[i] = f > 0 ? f : 0;
    }
  }

  /** Total roll stiffness contribution of an axle, exposed for setup telemetry. */
  rollStiffness(front) {
    const s = front ? this.front : this.rear;
    const track = front ? this.config.chassis.trackFront : this.config.chassis.trackRear;
    return (s.wheelRate + s.antiRoll * 0.5) * s.seriesFactor * track * track * 0.5;
  }
}

export { SIDE, IS_FRONT, damperForce };
