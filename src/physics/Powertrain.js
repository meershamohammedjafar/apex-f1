/**
 * 1.6 L V6 turbo hybrid power unit, eight-speed seamless gearbox, limited-slip
 * differential, brake-by-wire with MGU-K regeneration, and the pit lane limiter.
 *
 * Torque path: ICE + MGU-K on the crank -> clutch -> gearbox -> final drive -> LSD ->
 * rear wheels. When the clutch is locked the engine speed is a kinematic function of the
 * rear wheels and the crank inertia is reflected onto the axle, which is both stable at
 * 240 Hz and the reason first gear feels so much heavier than eighth.
 */

import { clamp, clamp01, smoothstep, lerp } from '../core/MathUtils.js';

const RPM_TO_RADS = Math.PI / 30;
const RADS_TO_RPM = 30 / Math.PI;
const MGUK_EFFICIENCY = 0.92;
const TWO_PI = Math.PI * 2;

const SHIFT_TORQUE_DIP_UPSHIFT = 0.30;
const SHIFT_TORQUE_DIP_DOWNSHIFT = 0.45;
const SHIFT_MIN_DURATION = 1e-4;

const DRIVELINE_STIFFNESS_NM_PER_RAD = 22000;
const DRIVELINE_INERTIA_KGM2 = 3.9;
const DRIVELINE_DAMPING_RATIO = 1.0;
const DRIVELINE_TWIST_LIMIT_RAD = 1.0;

const DIFF_RAMP_BLEND_NM = 120;
const DIFF_SATURATION_SHARPNESS = 6;
const DIFF_SATURATION_INV_SHARPNESS = 1 / DIFF_SATURATION_SHARPNESS;

function smootherstep01(t) {
  const x = t <= 0 ? 0 : (t >= 1 ? 1 : t);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function raisedCosine01(t) {
  const x = t <= 0 ? 0 : (t >= 1 ? 1 : t);
  return 0.5 - 0.5 * Math.cos(TWO_PI * x);
}

function softSaturate(value, limit) {
  if (!(limit > 0)) return 0;
  const u = value / limit;
  const u2 = u * u;
  return value / Math.pow(1 + u2 * u2 * u2, DIFF_SATURATION_INV_SHARPNESS);
}

export class Powertrain {
  constructor(config) {
    this.config = config;
    this.eng = config.engine;
    this.trans = config.transmission;
    this.brakesCfg = config.brakes;
    this.ersCfg = config.ers;

    const curve = this.eng.torqueCurve;
    this._curveRpm = new Float64Array(curve.length);
    this._curveNm = new Float64Array(curve.length);
    for (let i = 0; i < curve.length; i++) {
      this._curveRpm[i] = curve[i][0];
      this._curveNm[i] = curve[i][1];
    }

    this.driveTorque = new Float64Array(4);
    this.brakeTorque = new Float64Array(4);
    this.regenTorque = new Float64Array(4);
    this.reflectedInertia = new Float64Array(4);
    this.brakeTemp = new Float64Array(4);

    this.autoShift = true;
    this.gear = 1;
    this.engineOmega = this.eng.idleRpm * RPM_TO_RADS;
    this.rpm = this.eng.idleRpm;
    this.boost = 0;
    this.boostBar = 1;
    this.engineTorque = 0;
    this.wheelTorque = 0;
    this.shiftTimer = 0;
    this.shiftInhibit = 0;
    this.shiftDuration = 0;
    this.shiftDirection = 0;
    this.shiftBlend = 1;
    this.limiterActive = false;
    this.limiterCut = 0;
    this.clutchLocked = true;
    this.clutchSlip = 0;
    this.fuel = this.eng.startFuel;
    this.fuelRate = 0;
    this.brakeBias = this.brakesCfg.bias;
    this.pitLimiterActive = false;
    this.diffLock = 0;
    this.diffTransfer = 0;
    this._pendingHarvestPower = 0;
    this._syncError = 0;
    this._syncErrorAtShiftStart = 0;
    this._captureSyncError = false;
    this._ratioSqBeforeShift = 0;
    this._drivelineTwist = 0;
    this._drivelineTwistRate = 0;

    const drivelineNaturalOmega = Math.sqrt(
      DRIVELINE_STIFFNESS_NM_PER_RAD / DRIVELINE_INERTIA_KGM2);
    this._drivelineDamping = 2 * DRIVELINE_DAMPING_RATIO
      * DRIVELINE_INERTIA_KGM2 * drivelineNaturalOmega;

    this.ers = {
      charge: this.ersCfg.startCharge,
      deploy: 0,
      harvestMGUK: 0,
      harvestMGUH: 0,
      mode: this.ersCfg.defaultMode,
      deployedThisLap: 0,
      harvestedThisLap: 0,
      power: 0,
    };
    this._storeJ = this.ersCfg.storeCapacity * this.ersCfg.startCharge;

    this._prevShiftUp = false;
    this._prevShiftDown = false;
    this._prevErs = false;
    this._prevLimiter = false;

    this.reset();
  }

  reset() {
    this.gear = 1;
    this.engineOmega = this.eng.idleRpm * RPM_TO_RADS;
    this.rpm = this.eng.idleRpm;
    this.boost = 0;
    this.boostBar = 1;
    this.engineTorque = 0;
    this.wheelTorque = 0;
    this.shiftTimer = 0;
    this.shiftInhibit = 0;
    this.shiftDuration = 0;
    this.shiftDirection = 0;
    this.shiftBlend = 1;
    this.limiterActive = false;
    this.limiterCut = 0;
    this.clutchLocked = false;
    this.clutchSlip = 0;
    this.fuel = this.eng.startFuel;
    this.fuelRate = 0;
    this.brakeBias = this.brakesCfg.bias;
    this.pitLimiterActive = false;
    this.diffLock = 0;
    this.diffTransfer = 0;
    this._pendingHarvestPower = 0;
    this._syncError = 0;
    this._syncErrorAtShiftStart = 0;
    this._captureSyncError = false;
    this._ratioSqBeforeShift = 0;
    this._drivelineTwist = 0;
    this._drivelineTwistRate = 0;
    this._storeJ = this.ersCfg.storeCapacity * this.ersCfg.startCharge;
    this.ers.charge = this.ersCfg.startCharge;
    this.ers.deploy = 0;
    this.ers.harvestMGUK = 0;
    this.ers.harvestMGUH = 0;
    this.ers.mode = this.ersCfg.defaultMode;
    this.ers.deployedThisLap = 0;
    this.ers.harvestedThisLap = 0;
    this.ers.power = 0;
    for (let i = 0; i < 4; i++) {
      this.driveTorque[i] = 0;
      this.brakeTorque[i] = 0;
      this.regenTorque[i] = 0;
      this.reflectedInertia[i] = 0;
      this.brakeTemp[i] = this.brakesCfg.ambient;
    }
    this._prevShiftUp = false;
    this._prevShiftDown = false;
    this._prevErs = false;
    this._prevLimiter = false;
  }

  /** Reset the per-lap ERS budgets. RaceDirector calls this on `race:lap`. */
  notifyLap() {
    this.ers.deployedThisLap = 0;
    this.ers.harvestedThisLap = 0;
  }

  setBrakeBias(bias) {
    this.brakeBias = clamp(bias, this.brakesCfg.biasMin, this.brakesCfg.biasMax);
  }

  setErsMode(mode) {
    this.ers.mode = clamp(mode | 0, 0, this.ersCfg.modes.length - 1);
  }

  /** Overall ratio including the final drive; negative in reverse. */
  ratioFor(gear) {
    if (gear > 0) return this.trans.overall[gear - 1];
    if (gear < 0) return -this.trans.reverseOverall;
    return 0;
  }

  _torqueAtRpm(rpm) {
    const r = this._curveRpm;
    const n = this._curveNm;
    if (rpm <= r[0]) return n[0];
    const last = r.length - 1;
    if (rpm >= r[last]) return n[last];
    let i = 1;
    while (i < last && r[i] < rpm) i++;
    const t = (rpm - r[i - 1]) / (r[i] - r[i - 1]);
    return n[i - 1] + (n[i] - n[i - 1]) * t;
  }

  /**
   * Advance the power unit one substep.
   * @param {number} dt
   * @param {object} controls ControlState
   * @param {Float64Array} wheelOmega forward-positive wheel spin rates, rad/s
   * @param {Float64Array} slipRatio per-wheel slip ratio, for ABS and traction limiting
   * @param {number} speed forward road speed, m/s
   * @param {number} airSpeed m/s of cooling flow
   * @param {object|null} events EventBus for `car:shift`
   */
  step(dt, controls, wheelOmega, slipRatio, speed, airSpeed, events) {
    this._handleDiscreteInputs(controls, speed, events);

    const trans = this.trans;
    const ratio = this.ratioFor(this.gear);
    const rearOmega = 0.5 * (wheelOmega[2] + wheelOmega[3]);
    const inputOmega = rearOmega * ratio;
    const idleOmega = this.eng.idleRpm * RPM_TO_RADS;
    const limitOmega = this.eng.limiterRpm * RPM_TO_RADS;

    if (this.shiftTimer > 0) this.shiftTimer = Math.max(0, this.shiftTimer - dt);
    if (this.shiftInhibit > 0) this.shiftInhibit = Math.max(0, this.shiftInhibit - dt);

    const clutchPedal = clamp01(controls.clutch ?? 0);
    const inGear = this.gear !== 0;
    const shifting = this.shiftTimer > 0;

    const shiftProgress = shifting && this.shiftDuration > SHIFT_MIN_DURATION
      ? clamp01(1 - this.shiftTimer / this.shiftDuration)
      : 1;

    if (this._captureSyncError) {
      this._captureSyncError = false;
      this._syncErrorAtShiftStart = this.engineOmega - inputOmega;
    }
    if (shifting && inGear) {
      this._syncError = this._syncErrorAtShiftStart * (1 - smootherstep01(shiftProgress));
    } else {
      this._syncError = 0;
      this._syncErrorAtShiftStart = 0;
    }

    // The clutch locks once the gearbox input has caught up with idle and stays locked
    // until the speed falls well below it. The hysteresis matters: without it the clutch
    // chatters in and out of lock on every torque reversal at walking pace.
    const lockThreshold = this.clutchLocked ? idleOmega * 0.92 : idleOmega * 0.995;
    this.clutchLocked = inGear && clutchPedal < 0.02 && inputOmega >= lockThreshold;

    let throttle = clamp01(controls.throttle ?? 0);
    throttle = this._applyPitLimiter(throttle, speed);
    throttle = this._applyTractionControl(throttle, slipRatio);

    if (this.clutchLocked) {
      this.engineOmega = clamp(inputOmega + this._syncError, idleOmega, limitOmega * 1.02);
    }
    this.rpm = this.engineOmega * RADS_TO_RPM;

    const dip = this.shiftDirection < 0
      ? SHIFT_TORQUE_DIP_DOWNSHIFT
      : SHIFT_TORQUE_DIP_UPSHIFT;
    this.shiftBlend = shifting && inGear ? 1 - dip * raisedCosine01(shiftProgress) : 1;

    this._updateBoost(dt, throttle, this.rpm);
    this._updateLimiter(dt);

    const ersOut = this._updateDeploy(dt, throttle, controls);

    // Combustion torque. The fuel-flow regulation, not the airflow, is what caps the top
    // end of the curve, so it is applied as an explicit clamp on the delivered torque.
    const cut = this.limiterCut > 0 ? 0 : 1;
    const boostMul = this.eng.boost.torqueAtZeroBoost
      + (1 - this.eng.boost.torqueAtZeroBoost) * this.boost;
    const wot = this._torqueAtRpm(this.rpm) * boostMul;
    const friction = this.eng.frictionBase + this.eng.frictionPerRpm * this.rpm;
    const overrun = -this.eng.engineBrakeGain * this.rpm;

    let ice = throttle * cut * (wot + friction) - friction + (1 - throttle * cut) * overrun;

    if (ice > 0) {
      const shaftPower = ice * this.engineOmega;
      const flow = shaftPower / (this.eng.thermalEfficiency * this.eng.fuelLHV);
      if (flow > this.eng.fuelFlowMax) {
        ice *= this.eng.fuelFlowMax / flow;
        this.fuelRate = this.eng.fuelFlowMax;
      } else {
        this.fuelRate = flow;
      }
      this.fuel = Math.max(0, this.fuel - this.fuelRate * dt);
      if (this.fuel <= 0) ice = Math.min(ice, 0);
    } else {
      this.fuelRate = 0;
    }

    // MGU-K deploy is a crank torque, so it stacks straight on top of the ICE.
    const mgukTorque = this.engineOmega > 50 ? ersOut / this.engineOmega : 0;
    this.engineTorque = ice + mgukTorque;

    let axleTorque = 0;
    if (!inGear) {
      this._integrateFreeEngine(dt, idleOmega, limitOmega);
      this.reflectedInertia[2] = 0;
      this.reflectedInertia[3] = 0;
    } else if (this.clutchLocked) {
      axleTorque = this.engineTorque * ratio * trans.efficiency * this.shiftBlend;
      const ratioSq = ratio * ratio;
      const blendedRatioSq = shifting
        ? lerp(this._ratioSqBeforeShift, ratioSq, smootherstep01(shiftProgress))
        : ratioSq;
      const reflected = this.eng.inertia * blendedRatioSq * 0.5;
      this.reflectedInertia[2] = reflected;
      this.reflectedInertia[3] = reflected;
      this.clutchSlip = this._syncError;
    } else {
      // Slipping clutch: capacity is modulated by throttle so a launch is controllable,
      // and it releases entirely off the pedal — that is what the anti-stall does, and it
      // is why the car does not creep away from a standstill at idle.
      const dw = this.engineOmega - inputOmega;
      const engagement = (1 - clutchPedal) * clamp01((throttle - 0.04) * 2.2);
      const capacity = trans.clutchTorqueCapacity * engagement;
      const clutchTorque = capacity * Math.tanh(dw * 0.35);
      this.clutchSlip = dw;
      axleTorque = clutchTorque * ratio * trans.efficiency;
      this.engineOmega = clamp(
        this.engineOmega + dt * (this.engineTorque - clutchTorque) / this.eng.inertia,
        idleOmega * 0.55, limitOmega * 1.02,
      );
      this.reflectedInertia[2] = 0;
      this.reflectedInertia[3] = 0;
    }

    const deliveredTorque = this._advanceDriveline(dt, axleTorque);
    this.wheelTorque = deliveredTorque;
    this._applyDifferential(deliveredTorque, wheelOmega);
    this._updateBrakes(dt, controls, wheelOmega, slipRatio, speed, airSpeed);
    this._updateHarvest(dt, throttle, wheelOmega);

    this.ers.charge = clamp01(this._storeJ / this.ersCfg.storeCapacity);
    this.boostBar = 1 + (this.eng.boost.maxPressureRatio - 1) * this.boost;
  }

  _handleDiscreteInputs(controls, speed, events) {
    const up = !!controls.shiftUp;
    const down = !!controls.shiftDown;

    if (up && !this._prevShiftUp) {
      this.autoShift = false;
      this._requestShift(1, speed, events);
    }
    if (down && !this._prevShiftDown) {
      this.autoShift = false;
      this._requestShift(-1, speed, events);
    }
    this._prevShiftUp = up;
    this._prevShiftDown = down;

    const ersBtn = !!controls.ers;
    if (ersBtn && !this._prevErs) {
      this.ers.mode = (this.ers.mode + 1) % this.ersCfg.modes.length;
    }
    this._prevErs = ersBtn;

    const lim = !!controls.pitLimiter;
    if (lim && !this._prevLimiter) this.pitLimiterActive = !this.pitLimiterActive;
    this._prevLimiter = lim;

    if (this.autoShift) this._autoShift(speed, controls, events);
  }

  _requestShift(dir, speed, events) {
    if (this.shiftTimer > 0 || this.shiftInhibit > 0) return;
    const max = this.trans.gears.length;
    let target = this.gear + dir;

    // Reverse is only reachable from a near standstill, and only through neutral.
    if (target < 0 && Math.abs(speed) > 1.5) target = 0;
    if (target > max) return;
    if (target < -1) return;
    if (target === this.gear) return;

    // Refuse a downshift that would bounce the engine off the limiter.
    if (dir < 0 && target > 0) {
      const ratio = this.ratioFor(target);
      const wheelOmega = Math.abs(speed) / this.config.tyres.rear.radius;
      if (wheelOmega * ratio * (30 / Math.PI) > this.eng.limiterRpm * 1.005) return;
    }

    const outgoingRatio = this.ratioFor(this.gear);
    this._ratioSqBeforeShift = outgoingRatio * outgoingRatio;

    this.gear = target;
    this.shiftTimer = dir > 0 ? this.trans.shiftTime : this.trans.downshiftTime;
    this.shiftDuration = this.shiftTimer;
    this.shiftDirection = dir;
    this._captureSyncError = true;
    this.shiftInhibit = this.shiftTimer + this.trans.shiftInhibit;
    if (events) events.emit('car:shift', { gear: this.gear, direction: dir });
  }

  /**
   * The automatic gearbox shifts on the tachometer like a driver does, but every upshift
   * has to be supported by road speed. Without that guard a wheelspinning start would
   * run the box up to eighth with the car still doing 50 km/h, because during a burnout
   * the crank genuinely is against the limiter.
   */
  _autoShift(speed, controls, events) {
    if (this.shiftTimer > 0 || this.shiftInhibit > 0) return;
    const braking = (controls.brake ?? 0) > 0.2;

    if (this.gear === 0 && Math.abs(speed) < 0.5) {
      this.gear = 1;
      return;
    }
    if (this.gear <= 0) return;

    const wheelOmega = Math.abs(speed) / this.config.tyres.rear.radius;
    const roadRpm = wheelOmega * this.ratioFor(this.gear) * RADS_TO_RPM;
    const top = this.trans.gears.length;

    if (this.gear < top) {
      const nextRoadRpm = wheelOmega * this.ratioFor(this.gear + 1) * RADS_TO_RPM;
      const tachoReady = this.rpm > this.trans.upshiftRpm || this.limiterActive;
      if (tachoReady && roadRpm > this.trans.upshiftRpm * 0.90
        && nextRoadRpm > this.trans.downshiftRpm) {
        this._requestShift(1, speed, events);
        return;
      }
    }

    if (this.gear > 1) {
      const wouldBe = wheelOmega * this.ratioFor(this.gear - 1) * RADS_TO_RPM;
      const threshold = braking ? this.eng.limiterRpm * 0.965 : this.trans.downshiftRpm;
      if (roadRpm < this.trans.downshiftRpm && wouldBe < threshold) {
        this._requestShift(-1, speed, events);
      }
    }
  }

  _advanceDriveline(dt, commandTorque) {
    const stiffness = DRIVELINE_STIFFNESS_NM_PER_RAD;
    const springTorque = stiffness * this._drivelineTwist;
    const damperTorque = this._drivelineDamping * this._drivelineTwistRate;
    const twistAccel = (commandTorque - springTorque - damperTorque)
      / DRIVELINE_INERTIA_KGM2;

    let rate = this._drivelineTwistRate + dt * twistAccel;
    let twist = this._drivelineTwist + dt * rate;
    if (!Number.isFinite(twist) || !Number.isFinite(rate)) {
      twist = 0;
      rate = 0;
    }
    if (twist > DRIVELINE_TWIST_LIMIT_RAD) {
      twist = DRIVELINE_TWIST_LIMIT_RAD;
      if (rate > 0) rate = 0;
    } else if (twist < -DRIVELINE_TWIST_LIMIT_RAD) {
      twist = -DRIVELINE_TWIST_LIMIT_RAD;
      if (rate < 0) rate = 0;
    }
    this._drivelineTwistRate = rate;
    this._drivelineTwist = twist;
    return stiffness * twist;
  }

  _integrateFreeEngine(dt, idleOmega, limitOmega) {
    const drag = this.eng.frictionBase + this.eng.frictionPerRpm * this.rpm;
    const net = this.engineTorque - drag * 0.35;
    this.engineOmega = clamp(this.engineOmega + dt * net / this.eng.inertia,
      idleOmega, limitOmega * 1.02);
    this.clutchSlip = 0;
  }

  _updateLimiter(dt) {
    if (this.limiterCut > 0) {
      this.limiterCut -= dt;
      this.limiterActive = true;
      if (this.rpm < this.eng.limiterRecoverRpm) this.limiterCut = 0;
      return;
    }
    if (this.rpm >= this.eng.limiterRpm) {
      this.limiterCut = this.eng.limiterCutTime;
      this.limiterActive = true;
    } else {
      this.limiterActive = false;
    }
  }

  _updateBoost(dt, throttle, rpm) {
    const b = this.eng.boost;
    const ceiling = smoothstep(b.thresholdRpm, b.fullSpoolRpm, rpm);

    // The MGU-H can spin the compressor directly, which is what removes turbo lag on a
    // modern power unit — but only while there is energy in the store to do it with.
    const mode = this.ersCfg.modes[this.ers.mode];
    const mguhActive = this.ers.charge > 0.08 && mode.deploy > 0;

    let target = throttle * ceiling;
    if (mguhActive) target = Math.max(target, throttle * Math.max(ceiling, b.mguhFloor));

    let tau;
    if (target > this.boost) {
      const exhaustEnergy = clamp01(rpm / b.fullSpoolRpm) * throttle;
      tau = mguhActive
        ? b.mguhSpoolTime
        : lerp(b.spoolTimeCold, b.spoolTimeHot, exhaustEnergy);
    } else {
      tau = b.decayTime;
    }
    this.boost = clamp01(this.boost + (target - this.boost) * (dt / (tau + dt)));
  }

  /** MGU-K deploy. Returns the electrical power added at the crank, in watts. */
  _updateDeploy(dt, throttle, controls) {
    const cfg = this.ersCfg;
    const mode = cfg.modes[this.ers.mode];
    const braking = (controls.brake ?? 0) > 0.05;

    const lapLeft = Math.max(0, cfg.deployPerLap - this.ers.deployedThisLap);
    if (mode.deploy <= 0 || braking || this._storeJ <= 0 || lapLeft <= 0 || this.pitLimiterActive) {
      this.ers.deploy = 0;
      this.ers.power = 0;
      return 0;
    }

    // Deploy tapers off near the limiter: there is nothing left to gain up there.
    const taper = 1 - clamp01((this.rpm - this.eng.limiterRpm * cfg.deployTaper)
      / (this.eng.limiterRpm * (1 - cfg.deployTaper))) * 0.65;
    let power = cfg.deployPowerMax * mode.deploy * throttle * taper;

    const maxFromStore = this._storeJ / dt;
    const maxFromLap = lapLeft / dt;
    power = Math.min(power, maxFromStore, maxFromLap);
    if (power < 0) power = 0;

    this._storeJ -= power * dt;
    this.ers.deployedThisLap += power * dt;
    this.ers.deploy = power / cfg.deployPowerMax;
    this.ers.power = power;
    return power;
  }

  _updateHarvest(dt, throttle, wheelOmega) {
    const cfg = this.ersCfg;

    // MGU-H recovers off the turbine whenever the exhaust is doing more work than the
    // compressor needs. It has no per-lap cap under the regulations.
    const h = cfg.mguhPowerMax * throttle * this.boost
      * clamp01(this.rpm / this.eng.boost.fullSpoolRpm);
    const space = cfg.storeCapacity - this._storeJ;
    const hAccepted = Math.min(h * cfg.mguhToStore * dt, Math.max(0, space));
    this._storeJ += hAccepted;
    this.ers.harvestMGUH = dt > 0 ? hAccepted / dt : 0;

    // MGU-K harvest was already committed as rear brake torque in _updateBrakes.
    const kPower = this._pendingHarvestPower;
    this._pendingHarvestPower = 0;
    const kAccepted = Math.min(kPower * MGUK_EFFICIENCY * dt,
      Math.max(0, cfg.storeCapacity - this._storeJ),
      Math.max(0, cfg.harvestKPerLap - this.ers.harvestedThisLap));
    this._storeJ += kAccepted;
    this.ers.harvestedThisLap += kAccepted;
    this.ers.harvestMGUK = dt > 0 ? kAccepted / dt : 0;
  }

  /**
   * Traction control, off unless the player turns it on in Settings. It trims throttle
   * on measured rear slip rather than faking grip, so with the assist at 1.0 the car
   * still spins its wheels — it just stops making the problem worse.
   */
  _applyTractionControl(throttle, slipRatio) {
    const assists = this.config.assists;
    if (!assists || assists.tractionControl <= 0 || !slipRatio) return throttle;
    const slip = Math.max(slipRatio[2], slipRatio[3]);
    const excess = slip - assists.tcSlipTarget;
    if (excess <= 0) return throttle;
    const cut = clamp01(excess / 0.25) * assists.tractionControl;
    return throttle * (1 - cut * 0.92);
  }

  _applyPitLimiter(throttle, speed) {
    if (!this.pitLimiterActive) return throttle;
    const limit = this.config.pitLimiter.speed;
    const err = limit - Math.abs(speed);
    const allowed = clamp01(err * this.config.pitLimiter.gain);
    return Math.min(throttle, allowed);
  }

  /**
   * Salisbury-type limited-slip differential: preload plus separate power and coast
   * ramps, saturating at the plate capacity. The faster wheel gives torque up.
   */
  _applyDifferential(axleTorque, wheelOmega) {
    const d = this.trans.differential;
    const base = axleTorque * 0.5;
    const powerFraction = smoothstep(-DIFF_RAMP_BLEND_NM, DIFF_RAMP_BLEND_NM, axleTorque);
    const ramp = lerp(d.coastRamp, d.powerRamp, powerFraction);
    const lock = Math.min(d.maxLock, d.preload + ramp * Math.abs(axleTorque));
    const dw = wheelOmega[2] - wheelOmega[3];
    const transfer = softSaturate(d.viscous * dw, lock);

    this.diffLock = lock;
    this.diffTransfer = transfer;
    this.driveTorque[0] = 0;
    this.driveTorque[1] = 0;
    this.driveTorque[2] = base - transfer;
    this.driveTorque[3] = base + transfer;
  }

  _updateBrakes(dt, controls, wheelOmega, slipRatio, speed, airSpeed) {
    const cfg = this.brakesCfg;
    const pedal = clamp01(controls.brake ?? 0);
    const demand = Math.pow(pedal, cfg.pedalGamma);
    const total = cfg.maxTorqueTotal * demand;

    const frontEach = total * this.brakeBias * 0.5;
    const rearEach = total * (1 - this.brakeBias) * 0.5;

    // Brake-by-wire: the MGU-K takes as much of the rear demand as it can, and the rear
    // calipers make up the remainder. This is why the rears stay cool in a modern F1 car.
    const mode = this.ersCfg.modes[this.ers.mode];
    const rearOmega = 0.5 * (Math.abs(wheelOmega[2]) + Math.abs(wheelOmega[3]));
    let regenEach = 0;
    if (pedal > 0.02 && rearOmega > 6 && !this.pitLimiterActive
      && this.ers.harvestedThisLap < this.ersCfg.harvestKPerLap
      && this._storeJ < this.ersCfg.storeCapacity) {
      const powerCap = this.ersCfg.harvestPowerMax * mode.harvest;
      regenEach = Math.min(rearEach, powerCap / (2 * rearOmega), 1400);
    }
    this._pendingHarvestPower = regenEach * 2 * rearOmega;

    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const friction = (front ? frontEach : rearEach - regenEach);
      const tempFactor = this._brakeTempFactor(this.brakeTemp[i]);
      let torque = Math.max(0, friction) * tempFactor;

      // ABS releases the caliper when the wheel starts to lock. Off by default: a real
      // F1 car has none, so this only bites when the assist is turned on in Settings.
      if (cfg.abs > 0 && slipRatio) {
        const lock = clamp01((-slipRatio[i] - 0.14) / 0.10);
        torque *= 1 - lock * cfg.abs;
      }

      this.regenTorque[i] = front ? 0 : regenEach;
      this.brakeTorque[i] = torque + (front ? 0 : regenEach);

      // Carbon disc thermal balance: friction work in, forced convection out.
      const mass = front ? cfg.discMassFront : cfg.discMassRear;
      const capacity = mass * cfg.discHeatCapacity;
      const power = torque * Math.abs(wheelOmega[i]);
      const cooling = (cfg.coolingBase + cfg.coolingPerSpeed * Math.abs(airSpeed))
        * (this.brakeTemp[i] - cfg.ambient);
      this.brakeTemp[i] = clamp(
        this.brakeTemp[i] + dt * (power - cooling) / capacity, cfg.ambient, 1400);
    }
  }

  _brakeTempFactor(temp) {
    const cfg = this.brakesCfg;
    if (temp < cfg.optimumTemp) {
      return lerp(cfg.coldTorqueFactor, 1, smoothstep(cfg.ambient, cfg.optimumTemp, temp));
    }
    return lerp(1, cfg.fadeTorqueFactor, smoothstep(cfg.fadeTemp, cfg.fadeTemp + 250, temp));
  }
}

export { RPM_TO_RADS, RADS_TO_RPM };
