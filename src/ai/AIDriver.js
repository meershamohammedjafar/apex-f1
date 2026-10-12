import * as THREE from "three";
import {
  clamp,
  clamp01,
  damp,
  lerp,
  moveTowards,
  sign,
  wrap01,
  deltaT,
  G
} from "../core/MathUtils.js";
import { Rng } from "../core/Rng.js";
import { getRacingLine, LINE_RACE } from "./RacingLine.js";
import { getTrafficModel, Racecraft } from "./Overtaking.js";
const _target = new THREE.Vector3();
const _local = new THREE.Vector3();
const _qInv = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _sideAxis = new THREE.Vector3();
const _mat = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const STATE_RACE = 0;
const STATE_OFF = 1;
const STATE_SPIN = 2;
const STATE_REJOIN = 3;
const SCAN_PERIOD = 2;
const REACTION_RING = 64;
const START_BLEND_DISTANCE = 240;
const TELEPORT_SQ = 30 * 30;
const PLAN_PERIOD = 6;
const BETA_LINEAR = 0.13;
const LAUNCH_RPM = 10600;
const MISTAKE_LOCKUP = 0;
const MISTAKE_WIDE = 1;
const MISTAKE_LATE = 2;
const MISTAKE_SNAP = 3;
const MISTAKE_LIFT = 4;
function makeLocateResult() {
  return {
    t: 0,
    distance: 0,
    lateral: 0,
    onTrack: false,
    index: 0,
    position: new THREE.Vector3(),
    tangent: new THREE.Vector3(),
    right: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    width: 0,
    banking: 0,
    curvature: 0,
    gradient: 0
  };
}
export class AIDriver {
  constructor(car, track, { skill = 0.9, aggression = 0.8 } = {}) {
    this.car = car;
    this.track = track;
    this.config = car.config;
    this.index = car.index | 0;
    this.skill = clamp01(skill);
    this.aggression = clamp01(aggression);
    const seed = car.ctx?.settings?.get?.("seed") ?? 20260827;
    this.rng = new Rng((seed ^ 1095356416) + this.index * 2654435761);
    this.controls = {
      throttle: 0,
      brake: 0,
      steer: 0,
      clutch: 0,
      shiftUp: false,
      shiftDown: false,
      drs: false,
      ers: false,
      pitLimiter: false,
      lookLeft: 0,
      lookRight: 0,
      lookBack: false,
      reset: false
    };
    this.plan = {
      lineId: LINE_RACE,
      lateralBias: 0,
      avoidBias: 0,
      speedScale: 1,
      brakePointScale: 1,
      brakeFloor: 0,
      throttleCap: 1,
      ersTarget: this.config.ers.defaultMode,
      drs: true,
      attacking: false,
      defending: false,
      yielding: false,
      alongside: false
    };
    this._personality();
    const chassis = this.config.chassis;
    this.mass = chassis.mass;
    this.wheelbase = chassis.wheelbase;
    this.maxRoadWheelAngle = this.config.steering.maxRoadWheelAngle;
    this._wheelRadius = 0.5 * (this.config.tyres.front.radius + this.config.tyres.rear.radius);
    this._brakeTorqueCap = this.config.brakes.maxTorqueTotal;
    this._invGamma = 1 / this.config.brakes.pedalGamma;
    this._ersModes = this.config.ers.modes.length;
    this._loc = makeLocateResult();
    this._sample = makeLocateResult();
    this._demandRing = new Float32Array(REACTION_RING);
    this._lastPos = new THREE.Vector3();
    this.line = null;
    this.traffic = null;
    this.racecraft = null;
    if (track) this._bind(track);
    this._reset();
  }
  _personality() {
    const rng = this.rng;
    const skillN = clamp01((this.skill - 0.78) / 0.22);
    this.skillN = skillN;
    this.p = {
      speedScale: clamp(0.962 + 0.042 * skillN + rng.gaussian() * 45e-4, 0.948, 1.006),
      brakePoint: clamp(0.8 + 0.13 * skillN + rng.gaussian() * 0.014, 0.77, 0.94),
      trailExp: lerp(2.1, 1.05, skillN) + rng.signed(0.12),
      exitConfidence: clamp(0.86 + 0.18 * skillN + rng.gaussian() * 0.022, 0.83, 1.06),
      throttleRate: 2.3 + 4.4 * skillN,
      reaction: clamp(0.3 - 0.19 * skillN + rng.gaussian() * 0.018, 0.075, 0.36),
      steerLag: 0.026 + 0.034 * (1 - skillN),
      lockGuard: clamp(0.9 + 0.075 * skillN + rng.gaussian() * 0.012, 0.86, 0.99),
      mistakeRate: 12e-4 + 0.11 * (1 - this.skill) * (1 - this.skill),
      lineBias: rng.signed(0.3),
      latP: 4.2 + 2.4 * skillN,
      latD: 3.6 + 1.5 * skillN,
      latI: 0.45 + 0.35 * skillN,
      moodRate: 0.035 + rng.next() * 0.05,
      moodDepth: 0.01 + 0.016 * (1 - skillN),
      moodPhase: rng.next() * Math.PI * 2
    };
    this.p.launchDelay = clamp(0.16 + 0.22 * (1 - skillN) + rng.gaussian() * 0.03, 0.1, 0.55);
  }
  _bind(track) {
    this.track = track;
    this.line = getRacingLine(track, this.config);
    this.traffic = getTrafficModel(track);
    this.racecraft = new Racecraft(this.car, this.line, this.rng, { aggression: this.aggression });
  }
  _reset() {
    this._tick = 0;
    this._rstate = STATE_RACE;
    this._offSide = 1;
    this._offTimer = 0;
    this._stuckTimer = 0;
    this._rejoinTimer = 0;
    this._crawlTimer = 0;
    this._forcedOffset = NaN;
    this._bias = 0;
    this._avoid = 0;
    this._steerOut = 0;
    this._throttle = 0;
    this._brake = 0;
    this._eInt = 0;
    this._eDot = 0;
    this._localLimit = 60;
    this._bindT = -1;
    this._bindSpeed = 1e4;
    this._speedInt = 0;
    this._decelInt = 0;
    this._paceLimit = Infinity;
    this._ringHead = 0;
    if (this._demandRing) this._demandRing.fill(0);
    this._launched = false;
    this._launchTimer = 0;
    this._clutch = 0;
    this._startOffset = 0;
    this._startBlend = 1;
    this._scaledPoint = 0.85;
    this._scale = 1;
    this._holdForTraffic = false;
    this._reversed = false;
    this._mistake = -1;
    this._mistakeTimer = 0;
    this._mistakeCooldown = 6;
    this._mistakeSide = 1;
    this._ersMode = this.config.ers.defaultMode;
    this._ersHigh = false;
    this._ersCooldown = 0;
    this._mood = 0;
  }
  update(dt, ctx, loc) {
    const c = this.controls;
    const track = ctx.track ?? this.track;
    if (!track) {
      c.throttle = 0;
      c.brake = 1;
      c.steer = 0;
      c.clutch = 1;
      return c;
    }
    if (!this.line || this.track !== track) this._bind(track);
    const state = this.car.physics.state;
    let where = loc;
    if (!where || where.width === void 0) {
      where = track.locate(state.position, this._loc);
    }
    if (this._tick > 0 && state.position.distanceToSquared(this._lastPos) > TELEPORT_SQ) {
      this._reset();
      this.racecraft.reset();
    }
    this._lastPos.copy(state.position);
    this._tick++;
    this.traffic.sync(ctx);
    const session = ctx.race?.session ?? null;
    const phase = session ? session.state : "racing";
    c.shiftUp = false;
    c.shiftDown = false;
    c.pitLimiter = false;
    c.reset = false;
    c.lookBack = false;
    if (phase === "grid" || phase === "countdown") {
      this._gridHold(dt, state, where);
      return c;
    }
    if (this._startBlend < 1) {
      this._startBlend = Math.min(1, this._startBlend + Math.max(0, state.speed) * dt / START_BLEND_DISTANCE);
    }
    if (phase === "formation") this._launched = true;
    this._mood = Math.sin(ctx.time.elapsed * this.p.moodRate + this.p.moodPhase) * this.p.moodDepth;
    const plan = this.plan;
    if (this._updateRecovery(dt, where, state)) {
      this.racecraft.avoid(dt, ctx, this.traffic, where, plan);
      this._updateErs(dt, plan);
      c.drs = false;
      return c;
    }
    this._updateMistake(dt, where);
    if (this._rstate === STATE_RACE) {
      if ((this._tick + this.index) % PLAN_PERIOD === 0) {
        this.racecraft.evaluate(PLAN_PERIOD * dt, ctx, this.traffic, where, plan);
      }
      this.racecraft.avoid(dt, ctx, this.traffic, where, plan);
    } else {
      plan.lineId = LINE_RACE;
      plan.lateralBias = 0;
      plan.brakePointScale = 0.86;
      plan.attacking = false;
      plan.defending = false;
      plan.drs = false;
      this.racecraft.avoid(dt, ctx, this.traffic, where, plan);
    }
    const paceLimit = ctx.race?.paceLimit ?? 0;
    this._paceLimit = paceLimit > 0 ? paceLimit : Infinity;
    if ((this._tick + this.index) % SCAN_PERIOD === 0 || this._bindT < 0) {
      this._scan(where, plan);
    }
    this._steer(dt, where, state, plan);
    this._pedals(dt, where, state, plan, phase);
    this._updateErs(dt, plan);
    c.drs = plan.drs && this._rstate === STATE_RACE;
    return c;
  }
  _gridHold(dt, state, loc) {
    const c = this.controls;
    this._startOffset = loc.lateral;
    this._startBlend = 0;
    c.brake = 1;
    c.clutch = 1;
    c.steer = damp(c.steer, 0, 8, dt);
    c.drs = false;
    c.ers = false;
    c.throttle = clamp01((LAUNCH_RPM - state.rpm) / 3e3 + 0.12);
    this._launched = false;
    this._launchTimer = 0;
    this._clutch = 1;
    this._throttle = c.throttle;
    this._brake = 1;
    this._bindT = -1;
  }
  _launch(dt, state, plan) {
    this._launchTimer += dt;
    if (this._launchTimer < this.p.launchDelay) {
      this.controls.brake = 1;
      this.controls.throttle = clamp01((LAUNCH_RPM - state.rpm) / 3e3 + 0.12);
      this.controls.clutch = 1;
      return true;
    }
    const spin = Math.max(state.wheels[2].slipRatio, state.wheels[3].slipRatio);
    const release = spin > 0.35 ? 0.25 : 1.35 + 0.6 * this.skillN;
    this._clutch = Math.max(0, this._clutch - release * dt);
    this.controls.clutch = this._clutch;
    this.controls.brake = 0;
    this.controls.throttle = clamp01(1 - clamp01((spin - 0.28) / 0.3) * 0.45);
    this.controls.steer = damp(this.controls.steer, 0, 6, dt);
    if (this._clutch <= 1e-3 && state.speed > 12) this._launched = true;
    if (plan.brakeFloor > 0.05) {
      this.controls.brake = Math.max(this.controls.brake, plan.brakeFloor);
      this.controls.throttle *= 0.25;
    }
    return !this._launched;
  }
  _steer(dt, loc, state, plan) {
    const line = this.line;
    const speed = Math.max(0, state.speed);
    const targetBias = plan.lateralBias + this.p.lineBias + this._mistakeBias();
    this._bias = damp(this._bias, targetBias, 3, dt);
    this._avoid = damp(this._avoid, plan.avoidBias, 9, dt);
    const lineId = plan.lineId;
    const t = loc.t;
    let look = clamp(4.5 + speed * (0.4 + 0.16 * this.skillN), 4.5, 58);
    const kHere = Math.abs(line.curvatureAt(lineId, t));
    if (kHere > 2e-3) look = Math.min(look, 0.62 / kHere);
    const tAhead = wrap01(t + look / line.length);
    let aim = this._bias + this._avoid;
    if (Number.isFinite(this._forcedOffset)) {
      aim = this._forcedOffset - line.offsetAt(LINE_RACE, tAhead) + this._avoid;
    } else if (lineId !== LINE_RACE) {
      aim += line.offsetAt(lineId, tAhead) - line.offsetAt(LINE_RACE, tAhead);
    }
    line.pointAt(LINE_RACE, tAhead, aim, _target);
    _qInv.copy(state.quaternion).invert();
    _local.copy(_target).sub(state.position).applyQuaternion(_qInv);
    const forward = -_local.z;
    if (forward < 1) {
      const cmdBack = sign(_local.x || 1);
      this._steerOut = damp(this._steerOut, cmdBack, 1 / this.p.steerLag, dt);
      this.controls.steer = clamp(this._steerOut, -1, 1);
      return;
    }
    const ld2 = _local.x * _local.x + forward * forward;
    let kappa = 2 * _local.x / ld2;
    const want = Number.isFinite(this._forcedOffset) ? this._forcedOffset : line.clampedOffsetAt(lineId, t, this._bias + this._avoid);
    const e = want - loc.lateral;
    const lineRate = Number.isFinite(this._forcedOffset) ? 0 : line.offsetSlopeAt(lineId, t) * speed;
    const carRate = state.velocity.dot(loc.right);
    this._eDot = damp(this._eDot, lineRate - carRate, 26, dt);
    if (Math.abs(e) < 2.5 && speed > 12) {
      this._eInt = clamp(this._eInt + e * dt, -1.8, 1.8);
    } else {
      this._eInt *= 1 - Math.min(1, dt * 4);
    }
    const trimAccel = clamp(
      this.p.latP * e + this.p.latD * this._eDot + this.p.latI * this._eInt,
      -20,
      20
    );
    kappa += trimAccel / Math.max(64, speed * speed);
    const kappaMax = 1.32 * line.latAccelAt(speed) / Math.max(36, speed * speed);
    kappa = clamp(kappa, -kappaMax, kappaMax);
    let delta = Math.atan(kappa * this.wheelbase);
    const beta = Math.atan2(state.localVelocity.x, Math.max(2, Math.abs(state.speed)));
    const excess = beta - clamp(beta, -BETA_LINEAR, BETA_LINEAR);
    delta += excess * (0.95 + 0.55 * this.skillN);
    const cmd = clamp(delta / this.maxRoadWheelAngle, -1, 1);
    this._steerOut = damp(this._steerOut, cmd, 1 / this.p.steerLag, dt);
    this.controls.steer = clamp(this._steerOut, -1, 1);
  }
  _scan(loc, plan) {
    const line = this.line;
    const state = this.car.physics.state;
    const speed = Math.max(4, state.speed);
    const scale = this.p.speedScale * plan.speedScale * (1 + this._mood);
    this._scale = scale;
    const lineId = plan.lineId;
    const t = loc.t;
    this._localLimit = line.speedForLateral(lineId, t, loc.lateral) * scale;
    const brakeCap = Math.max(8, line.brakeAccelAt(speed));
    const horizon = clamp(28 + speed * speed / (2 * brakeCap) * 1.45, 45, 540);
    const steps = 16;
    const invLength = 1 / line.length;
    let demand = 0;
    let bestT = -1;
    let bestSpeed = 1e4;
    const scaledPoint = this.p.brakePoint * plan.brakePointScale * this._mistakeBrakeScale();
    this._scaledPoint = scaledPoint;
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      const d = horizon * f * f;
      const vt = line.speedAt(lineId, t + d * invLength) * scale;
      if (vt >= speed) continue;
      const a = (speed * speed - vt * vt) / (2 * Math.max(3, d * scaledPoint));
      if (a > demand) {
        demand = a;
        bestT = wrap01(t + d * invLength);
        bestSpeed = vt;
      }
    }
    if (bestT < 0) {
      this._bindT = -1;
      this._bindSpeed = 1e4;
      return;
    }
    this._bindT = bestT;
    this._bindSpeed = bestSpeed;
  }
  _demandFor(loc, speed, bindT, bindSpeed, scaledPoint) {
    if (bindT < 0 || bindSpeed > 1e3) return 0;
    const dist = deltaT(loc.t, bindT) * this.line.length;
    if (dist <= 0.4 || speed <= bindSpeed) return 0;
    return (speed * speed - bindSpeed * bindSpeed) / (2 * Math.max(2, dist * scaledPoint));
  }
  _pedals(dt, loc, state, plan, phase) {
    const c = this.controls;
    const line = this.line;
    const v = Math.max(0, state.speed);
    if (!this._launched) {
      if (phase === "racing") {
        if (this._launch(dt, state, plan)) return;
      } else if (v > 12) {
        this._launched = true;
      }
    }
    c.clutch = 0;
    const scaledPoint = this._scaledPoint;
    let target = Math.min(this._localLimit, this._paceLimit, this._recoverySpeedCap());
    if (phase === "finished") target *= 0.94;
    const raw = this._demandFor(loc, v, this._bindT, this._bindSpeed, scaledPoint);
    const ring = this._demandRing;
    ring[this._ringHead] = raw;
    this._ringHead = (this._ringHead + 1) % REACTION_RING;
    const lag = clamp(Math.round(this.p.reaction / Math.max(1e-4, dt)), 0, REACTION_RING - 1);
    let demand = ring[(this._ringHead - 1 - lag + REACTION_RING * 2) % REACTION_RING];
    if (v > target + 0.5) demand = Math.max(demand, (v - target) * 2.4);
    const leadT = wrap01(loc.t + Math.max(4, v * 0.3) / line.length);
    const kappaAhead = Math.abs(line.curvatureAt(plan.lineId, leadT));
    const vAhead = Math.min(v, line.speedAt(plan.lineId, leadT) * this._scale);
    const latCap = Math.max(4, line.latAccelAt(v));
    const latAhead = vAhead * vAhead * kappaAhead;
    const latNow = Math.abs(state.gForce.x) * G;
    const latUse = clamp01(Math.max(latAhead, latNow * 0.85) / latCap);
    const share = Math.sqrt(Math.max(0.03, 1 - latUse * latUse));
    const coast = line.coastDecelAt(v);
    const tyreBrake = Math.max(2, line.brakeAccelAt(v) - coast);
    let pedal = 0;
    if (demand > coast + 0.15) {
      const needForce = this.mass * (demand - coast);
      pedal = Math.pow(clamp01(needForce * this._wheelRadius / this._brakeTorqueCap), this._invGamma);
      this._decelInt = clamp(
        this._decelInt + (demand - Math.max(0, state.accel.z)) * dt * 0.055,
        -0.12,
        0.34
      );
      pedal = clamp01(pedal + this._decelInt);
      const trailShare = Math.pow(share, this.p.trailExp);
      const guard = this._mistake === MISTAKE_LOCKUP ? 1.4 : this.p.lockGuard;
      const gripForce = this.mass * tyreBrake * trailShare * guard;
      const gripPedal = Math.pow(clamp01(gripForce * this._wheelRadius / this._brakeTorqueCap), this._invGamma);
      pedal = Math.min(pedal, gripPedal);
      const lock = Math.max(state.wheels[0].lockup, state.wheels[1].lockup);
      if (lock > 0.28 && this._mistake !== MISTAKE_LOCKUP) {
        pedal *= 1 - clamp01((lock - 0.28) / 0.45) * (0.3 + 0.4 * this.skillN);
      }
    }
    if (pedal <= 0.05) this._decelInt *= 1 - Math.min(1, dt * 6);
    pedal = Math.max(pedal, plan.brakeFloor);
    this._brake = moveTowards(this._brake, clamp01(pedal), (7 + 9 * this.skillN) * dt);
    c.brake = this._brake;
    let throttle = 0;
    if (this._brake < 0.05) {
      const err = target - v;
      if (Math.abs(err) < 8) this._speedInt = clamp(this._speedInt + err * dt, -14, 14);
      else this._speedInt *= 1 - Math.min(1, dt * 3);
      throttle = clamp01(0.1 + err * 0.16 + this._speedInt * 0.035);
      const driveGross = Math.max(0.5, line.driveAccelAt(v) + coast);
      const longAvailable = tyreBrake * share * this.p.exitConfidence;
      const cap = clamp01(longAvailable / driveGross);
      throttle = Math.min(throttle, cap);
      const spin = Math.max(state.wheels[2].slipRatio, state.wheels[3].slipRatio);
      if (spin > 0.18) throttle *= 1 - clamp01((spin - 0.18) / 0.26) * (0.55 + 0.3 * this.skillN);
      const slide = Math.abs(Math.atan2(state.localVelocity.x, Math.max(2, Math.abs(state.speed))));
      if (slide > 0.1) throttle *= 1 - clamp01((slide - 0.1) / 0.14) * (0.5 + 0.35 * this.skillN);
      if (this._mistake === MISTAKE_SNAP) throttle = Math.min(1, throttle + 0.55);
      if (this._mistake === MISTAKE_LIFT) throttle = Math.min(throttle, 0.35);
      throttle = Math.min(throttle, plan.throttleCap);
      throttle = moveTowards(this._throttle, clamp01(throttle), this.p.throttleRate * dt);
    } else {
      throttle = moveTowards(this._throttle, 0, 12 * dt);
    }
    this._throttle = throttle;
    c.throttle = clamp01(throttle);
  }
  _updateErs(dt, plan) {
    const c = this.controls;
    if (this._ersCooldown > 0) this._ersCooldown -= dt;
    if (this._ersHigh) {
      c.ers = false;
      this._ersHigh = false;
      return;
    }
    c.ers = false;
    if (this._ersMode !== plan.ersTarget && this._ersCooldown <= 0) {
      c.ers = true;
      this._ersHigh = true;
      this._ersMode = (this._ersMode + 1) % this._ersModes;
      this._ersCooldown = 0.06;
    }
  }
  _updateMistake(dt, loc) {
    if (this._mistakeTimer > 0) {
      this._mistakeTimer -= dt;
      if (this._mistakeTimer <= 0) {
        this._scaledPoint = 0.85;
        this._scale = 1;
        this._holdForTraffic = false;
        this._reversed = false;
        this._mistake = -1;
        this._mistakeCooldown = 8 + this.rng.next() * 14;
      }
      return;
    }
    if (this._mistakeCooldown > 0) {
      this._mistakeCooldown -= dt;
      return;
    }
    if (this._rstate !== STATE_RACE) return;
    const state = this.car.physics.state;
    const load = clamp01((Math.abs(state.gForce.x) + Math.abs(state.gForce.z)) / 3.5);
    const rate = this.p.mistakeRate * (0.3 + 0.7 * load);
    if (this.rng.next() >= rate * dt) return;
    const roll = this.rng.next();
    if (roll < 0.3) {
      this._mistake = MISTAKE_LOCKUP;
      this._mistakeTimer = 0.35 + this.rng.next() * 0.5;
    } else if (roll < 0.55) {
      this._mistake = MISTAKE_WIDE;
      this._mistakeTimer = 0.9 + this.rng.next() * 0.9;
      this._mistakeSide = sign(this.line.turnSignAt(loc.t)) || (this.rng.next() < 0.5 ? -1 : 1);
    } else if (roll < 0.78) {
      this._mistake = MISTAKE_LATE;
      this._mistakeTimer = 1.4 + this.rng.next() * 1.2;
    } else if (roll < 0.92) {
      this._mistake = MISTAKE_SNAP;
      this._mistakeTimer = 0.18 + this.rng.next() * 0.18;
    } else {
      this._mistake = MISTAKE_LIFT;
      this._mistakeTimer = 0.3 + this.rng.next() * 0.4;
    }
  }
  _mistakeBias() {
    return this._mistake === MISTAKE_WIDE ? this._mistakeSide * 1.8 : 0;
  }
  _mistakeBrakeScale() {
    return this._mistake === MISTAKE_LATE ? 1.16 : 1;
  }
  _updateRecovery(dt, loc, state) {
    const beta = Math.atan2(state.localVelocity.x, Math.max(1, Math.abs(state.speed)));
    const speed = Math.abs(state.speed);
    const off = Math.abs(loc.lateral) > loc.width + 0.9;
    _fwd.set(0, 0, -1).applyQuaternion(state.quaternion);
    const facing = _fwd.dot(loc.tangent);
    this._reversed = facing < 0.15;
    this._forcedOffset = NaN;
    switch (this._rstate) {
      case STATE_RACE:
        if (Math.abs(beta) > 0.85 && speed > 5) {
          this._rstate = STATE_SPIN;
        } else if (off || this._reversed && speed < 30) {
          this._rstate = STATE_OFF;
          this._offSide = sign(loc.lateral) || 1;
          this._offTimer = 0;
          this._stuckTimer = 0;
        } else if (speed < 3) {
          this._crawlTimer += dt;
          if (this._crawlTimer > 6) this._marshalRecover(loc);
        } else {
          this._crawlTimer = 0;
        }
        break;
      case STATE_SPIN:
        if (Math.abs(beta) < 0.3 || speed < 3) {
          this._rstate = off ? STATE_OFF : STATE_REJOIN;
          this._offSide = sign(loc.lateral) || this._offSide;
          this._rejoinTimer = 2.2;
          this._offTimer = 0;
          this._stuckTimer = 0;
        }
        break;
      case STATE_OFF: {
        this._offTimer += dt;
        this._stuckTimer = speed < 1.5 ? this._stuckTimer + dt : Math.max(0, this._stuckTimer - dt * 0.5);
        const deep = Math.abs(loc.lateral) > loc.width + 9;
        if (!off && !this._reversed && Math.abs(loc.lateral) < loc.width - 0.4) {
          this._rstate = STATE_REJOIN;
          this._rejoinTimer = 2.4;
        } else if (this._stuckTimer > 5 || this._offTimer > (deep ? 8 : 18)) {
          this._marshalRecover(loc);
        }
        break;
      }
      case STATE_REJOIN:
        this._rejoinTimer -= dt;
        if (off) {
          this._rstate = STATE_OFF;
          this._offSide = sign(loc.lateral) || this._offSide;
        } else if (this._rejoinTimer <= 0) {
          this._rstate = STATE_RACE;
          this._eInt = 0;
        }
        break;
      default:
        this._rstate = STATE_RACE;
        break;
    }
    if (this._rstate === STATE_SPIN) {
      const c = this.controls;
      c.steer = clamp(beta / this.maxRoadWheelAngle, -1, 1);
      c.brake = 0.9;
      c.throttle = 0;
      c.clutch = speed < 12 ? 1 : 0;
      c.drs = false;
      this._steerOut = c.steer;
      this._brake = c.brake;
      this._throttle = 0;
      this._bindT = -1;
      this._holdForTraffic = false;
      return true;
    }
    if (this._rstate === STATE_RACE && this._startBlend < 1) {
      const b = this._startBlend * this._startBlend * (3 - 2 * this._startBlend);
      this._forcedOffset = lerp(this._startOffset, this.line.offsetAt(LINE_RACE, loc.t), b);
      this._holdForTraffic = false;
      return false;
    }
    if (this._rstate === STATE_OFF || this._rstate === STATE_REJOIN) {
      const edge = this._offSide * Math.max(0.5, loc.width - 2);
      if (this._rstate === STATE_OFF) {
        this._forcedOffset = edge;
      } else {
        const blend = clamp01(1 - this._rejoinTimer / 2.4);
        this._forcedOffset = lerp(edge, this.line.offsetAt(LINE_RACE, loc.t), blend);
      }
      this._holdForTraffic = this.traffic.approachingBehind(this.index, 85, -2);
    } else {
      this._holdForTraffic = false;
    }
    return false;
  }
  _recoverySpeedCap() {
    if (this._rstate === STATE_RACE) return Infinity;
    const grip = this.car.physics.state.surfaceGrip ?? 1;
    if (this._rstate === STATE_OFF) {
      if (this._reversed) return 6;
      const base = 10 + 24 * clamp01(grip);
      return this._holdForTraffic ? Math.min(base, 8) : base;
    }
    if (this._rstate === STATE_REJOIN) {
      const blend = clamp01(1 - this._rejoinTimer / 2.4);
      const base = lerp(26, this._localLimit, blend);
      return this._holdForTraffic && blend < 0.4 ? Math.min(base, 16) : base;
    }
    return Infinity;
  }
  _marshalRecover(loc) {
    const track = this.track;
    if (!track) return;
    if (this._offTimer < 30 && this.traffic.approachingBehind(this.index, 95, -1e4)) return;
    track.sample(loc.t, this._sample);
    const s = this._sample;
    const lateral = (sign(loc.lateral) || 1) * Math.max(0, s.width - 2.2);
    const x = s.position.x + s.right.x * lateral;
    const z = s.position.z + s.right.z * lateral;
    const y = track.heightAt(x, z) + this.config.chassis.cgHeight + 0.04;
    _fwd.copy(s.tangent).normalize();
    _up.copy(s.normal).normalize();
    _sideAxis.crossVectors(_fwd, _up).normalize();
    _up.crossVectors(_sideAxis, _fwd).normalize();
    _mat.makeBasis(_sideAxis, _up, _pos.copy(_fwd).negate());
    _quat.setFromRotationMatrix(_mat);
    _pos.set(x, y, z);
    this.car.reset(_pos, _quat, track);
    this._lastPos.copy(_pos);
    this._rstate = STATE_REJOIN;
    this._rejoinTimer = 2.6;
    this._stuckTimer = 0;
    this._crawlTimer = 0;
    this._offTimer = 0;
    this._bindT = -1;
    this._eInt = 0;
    this._bias = 0;
    this.racecraft?.reset();
    this.car.ctx?.events?.emit?.("car:recovered", { car: this.car, index: this.index });
  }
  reset() {
    this._reset();
    this.racecraft?.reset();
  }
  dispose() {
    this.line = null;
    this.traffic = null;
    this.racecraft = null;
  }
}
