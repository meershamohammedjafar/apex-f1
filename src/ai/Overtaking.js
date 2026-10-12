import * as THREE from "three";
import { clamp, clamp01, smoothstep, sign } from "../core/MathUtils.js";
import { LINE_RACE, LINE_DEFEND, LINE_LEFT, LINE_RIGHT, PHASE_CORNER } from "./RacingLine.js";
const MAX_CARS = 24;
const NEIGHBOURS = 6;
const CAR_LENGTH = 5.63;
const CAR_WIDTH = 2;
const SIDE_CLEARANCE = 2.15;
const DIRTY_AIR_RANGE = 34;
const DIRTY_AIR_WIDTH = 3;
const TOW_RANGE = 60;
const STUDY_RANGE = 26;
const LUNGE_GAP = 12;
const DEFEND_RANGE = 16;
const BLUE_FLAG_RANGE = 55;
const AVOID_LONG = 11;
const AVOID_LAT = 3.4;
const ATT_NONE = 0;
const ATT_STUDY = 1;
const ATT_COMMIT = 2;
const ATT_ALONGSIDE = 3;
const ATT_CONCEDE = 4;
const ERS_BALANCED = 1;
const ERS_OVERTAKE = 3;
const _models = new WeakMap();
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
export function getTrafficModel(track) {
  let model = _models.get(track);
  if (!model) {
    model = new TrafficModel(track);
    _models.set(track, model);
  }
  return model;
}
export class TrafficModel {
  constructor(track) {
    this.track = track;
    this.count = 0;
    this.t = new Float32Array(MAX_CARS);
    this.lateral = new Float32Array(MAX_CARS);
    this.speed = new Float32Array(MAX_CARS);
    this.lap = new Int16Array(MAX_CARS);
    this.onTrack = new Uint8Array(MAX_CARS);
    this.order = new Int16Array(MAX_CARS);
    this.aheadIdx = new Int16Array(MAX_CARS);
    this.behindIdx = new Int16Array(MAX_CARS);
    this.gapAhead = new Float32Array(MAX_CARS);
    this.gapBehind = new Float32Array(MAX_CARS);
    this.neighbours = new Int16Array(MAX_CARS * NEIGHBOURS);
    this.neighbourGap = new Float32Array(MAX_CARS * NEIGHBOURS);
    this._loc = makeLocateResult();
    this._stamp = -1;
    this._sorted = false;
  }
  sync(ctx) {
    const stamp = ctx.time.elapsed;
    if (stamp === this._stamp) return;
    this._stamp = stamp;
    const track = this.track;
    const list = ctx.cars?.cars ?? ctx.cars;
    if (!track || !list) {
      this.count = 0;
      return;
    }
    const n = Math.min(list.length | 0, MAX_CARS);
    if (n !== this.count) {
      this.count = n;
      this._sorted = false;
    }
    if (!this._sorted) {
      for (let i = 0; i < n; i++) this.order[i] = i;
      this._sorted = true;
    }
    const loc = this._loc;
    for (let i = 0; i < n; i++) {
      const car = list[i];
      const state = car.physics.state;
      track.locate(state.position, loc);
      this.t[i] = loc.t;
      this.lateral[i] = loc.lateral;
      this.speed[i] = state.speed;
      this.lap[i] = car.lap | 0;
      this.onTrack[i] = loc.onTrack ? 1 : 0;
    }
    const order = this.order;
    const t = this.t;
    for (let k = 1; k < n; k++) {
      const idx = order[k];
      const key = t[idx];
      let j = k - 1;
      while (j >= 0 && t[order[j]] > key) {
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = idx;
    }
    const length = track.length;
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const aheadK = n > 1 ? (k + 1) % n : k;
      const behindK = n > 1 ? (k - 1 + n) % n : k;
      const a = order[aheadK];
      const b = order[behindK];
      this.aheadIdx[i] = n > 1 ? a : -1;
      this.behindIdx[i] = n > 1 ? b : -1;
      this.gapAhead[i] = n > 1 ? this._forward(t[i], t[a]) * length : length;
      this.gapBehind[i] = n > 1 ? this._forward(t[b], t[i]) * length : length;
      const base = i * NEIGHBOURS;
      for (let s = 0; s < 3; s++) {
        const na = order[(k + 1 + s) % n];
        const nb = order[(k - 1 - s + 2 * n) % n];
        this.neighbours[base + s] = n > 1 ? na : -1;
        this.neighbours[base + 3 + s] = n > 1 ? nb : -1;
        this.neighbourGap[base + s] = n > 1 ? this._forward(t[i], t[na]) * length : length;
        this.neighbourGap[base + 3 + s] = n > 1 ? -this._forward(t[nb], t[i]) * length : -length;
      }
    }
  }
  _forward(from, to) {
    let d = to - from;
    if (d < 0) d += 1;
    return d;
  }
  approachingBehind(index, metres, minClosing = 2) {
    const n = this.count;
    if (n < 2) return false;
    const base = index * NEIGHBOURS;
    for (let s = 3; s < NEIGHBOURS; s++) {
      const j = this.neighbours[base + s];
      if (j < 0) continue;
      if (!this.onTrack[j]) continue;
      const gap = -this.neighbourGap[base + s];
      if (gap > 0 && gap < metres && this.speed[j] > this.speed[index] + minClosing) return true;
    }
    return false;
  }
}
export class Racecraft {
  constructor(car, line, rng, { aggression = 0.8 } = {}) {
    this.car = car;
    this.index = car.index;
    this.line = line;
    this.rng = rng;
    this.aggression = clamp01(aggression);
    this.commitThreshold = 5.2 - 2.6 * this.aggression;
    this.patience = 1.6 - 0.9 * this.aggression;
    this.reset();
  }
  reset() {
    this.attackState = ATT_NONE;
    this.attackSide = 0;
    this.attackTimer = 0;
    this.studyTimer = 0;
    this.cooldown = 0;
    this.target = -1;
    this._sideRoll = 0.5;
    this.defendSide = 0;
    this.defendTimer = 0;
    this.defendUsed = false;
    this.yieldTimer = 0;
    this.yieldSide = 0;
    this.towSide = 0;
  }
  evaluate(dt, ctx, traffic, loc, plan) {
    const line = this.line;
    const idx = this.index;
    const state = this.car.physics.state;
    const speed = state.speed;
    const t = loc.t;
    plan.lineId = LINE_RACE;
    plan.lateralBias = 0;
    plan.speedScale = 1;
    plan.brakePointScale = 1;
    plan.ersTarget = ERS_BALANCED;
    plan.attacking = false;
    plan.defending = false;
    plan.yielding = false;
    plan.alongside = false;
    if (this.cooldown > 0) this.cooldown -= dt;
    if (traffic.count < 2) {
      this.attackState = ATT_NONE;
      this.defendUsed = false;
      return plan;
    }
    const ahead = traffic.aheadIdx[idx];
    const behind = traffic.behindIdx[idx];
    const gapAhead = traffic.gapAhead[idx];
    const gapBehind = traffic.gapBehind[idx];
    if (this._blueFlag(dt, traffic, loc, plan, behind, gapBehind)) return plan;
    this._follow(traffic, loc, plan, ahead, gapAhead, speed);
    this._attack(dt, traffic, loc, plan, ahead, gapAhead, speed);
    if (!plan.attacking) this._defend(dt, traffic, loc, plan, behind, gapBehind, speed);
    if (plan.attacking || plan.defending) plan.ersTarget = ERS_OVERTAKE;
    plan.drs = true;
    const limit = line.limitAt(t);
    plan.lateralBias = clamp(plan.lateralBias, -limit, limit);
    return plan;
  }
  _follow(traffic, loc, plan, ahead, gapAhead, speed) {
    if (ahead < 0 || gapAhead > TOW_RANGE) {
      this.towSide = 0;
      return;
    }
    const line = this.line;
    const t = loc.t;
    const lateralGap = Math.abs(traffic.lateral[ahead] - loc.lateral);
    const kappa = Math.abs(line.curvatureAt(LINE_RACE, t));
    if (gapAhead < DIRTY_AIR_RANGE && lateralGap < DIRTY_AIR_WIDTH && kappa > 35e-4) {
      const bite = Math.exp(-gapAhead / 16) * (1 - clamp01(lateralGap / DIRTY_AIR_WIDTH));
      plan.speedScale *= 1 - 0.055 * bite;
      plan.lateralBias += sign(loc.lateral - traffic.lateral[ahead] || 1) * 0.55 * bite;
      return;
    }
    if (kappa < 25e-4 && speed > 45 && gapAhead < TOW_RANGE) {
      const side = this.attackSide !== 0 ? this.attackSide : traffic.lateral[ahead] > 0 ? -1 : 1;
      this.towSide = side;
      const towTarget = traffic.lateral[ahead] + side * 0.9;
      plan.lateralBias += clamp(towTarget - line.offsetAt(LINE_RACE, t), -2.2, 2.2) * (1 - smoothstep(12, TOW_RANGE, gapAhead));
    }
  }
  _attack(dt, traffic, loc, plan, ahead, gapAhead, speed) {
    const line = this.line;
    const t = loc.t;
    if (ahead < 0 || this.cooldown > 0) {
      this.attackState = ATT_NONE;
      return;
    }
    const closing = speed - traffic.speed[ahead];
    const inRange = gapAhead < STUDY_RANGE;
    switch (this.attackState) {
      case ATT_NONE:
        if (inRange && (closing > 0.6 || gapAhead < LUNGE_GAP)) {
          this.attackState = ATT_STUDY;
          this.studyTimer = 0;
          this.target = ahead;
          this.attackSide = 0;
          this._sideRoll = this.rng.next();
        }
        break;
      case ATT_STUDY: {
        this.studyTimer += dt;
        if (!inRange || this.target !== ahead) {
          this.attackState = ATT_NONE;
          break;
        }
        if (this.attackSide === 0) this.attackSide = this._chooseSide(traffic, loc, ahead);
        const brakeDist = line.brakeDistanceAt(t);
        const timeToBrake = brakeDist / Math.max(12, speed);
        const projected = gapAhead - closing * Math.min(timeToBrake, 4);
        const brakeT = t + brakeDist / line.length;
        const room = line.limitAt(brakeT) - Math.abs(line.clampedOffsetAt(LINE_RACE, brakeT, this.attackSide * 2.35));
        const ready = this.studyTimer > this.patience && brakeDist < 140 && projected < this.commitThreshold && room > -0.2 && this.attackSide !== 0;
        if (ready) {
          this.attackState = ATT_COMMIT;
          this.attackTimer = 0;
        }
        break;
      }
      case ATT_COMMIT: {
        this.attackTimer += dt;
        plan.attacking = true;
        plan.lineId = this.attackSide < 0 ? LINE_LEFT : LINE_RIGHT;
        plan.brakePointScale = 1 + 0.045 * this.aggression;
        plan.speedScale *= 1.005;
        const overlap = CAR_LENGTH - gapAhead;
        if (overlap > CAR_LENGTH * 0.35) {
          this.attackState = ATT_ALONGSIDE;
          this.attackTimer = 0;
        } else if (this.attackTimer > 3.2 || gapAhead > STUDY_RANGE || line.phaseAt(LINE_RACE, t) === PHASE_CORNER && overlap < CAR_LENGTH * 0.3) {
          this.attackState = ATT_CONCEDE;
          this.attackTimer = 0;
        }
        break;
      }
      case ATT_ALONGSIDE: {
        this.attackTimer += dt;
        plan.attacking = true;
        plan.alongside = true;
        plan.lineId = this.attackSide < 0 ? LINE_LEFT : LINE_RIGHT;
        plan.brakePointScale = 1;
        if (gapAhead > CAR_LENGTH * 1.6 && traffic.gapBehind[this.index] > CAR_LENGTH * 1.6) {
          this.attackState = ATT_NONE;
          this.cooldown = 1.2;
          this.attackSide = 0;
        } else if (this.attackTimer > 6) {
          this.attackState = ATT_NONE;
          this.cooldown = 2.5;
        }
        break;
      }
      case ATT_CONCEDE:
        this.attackTimer += dt;
        plan.brakePointScale = 0.94;
        plan.speedScale *= 0.985;
        plan.lineId = LINE_RACE;
        if (this.attackTimer > 1.6) {
          this.attackState = ATT_NONE;
          this.cooldown = 2 + this.rng.next() * 2.5;
          this.attackSide = 0;
        }
        break;
      default:
        this.attackState = ATT_NONE;
        break;
    }
  }
  _chooseSide(traffic, loc, ahead) {
    const line = this.line;
    const t = loc.t;
    const turn = line.turnSignAt(t);
    const inside = turn !== 0 ? -turn : this.towSide || (loc.lateral > 0 ? -1 : 1);
    const rivalLateral = traffic.lateral[ahead];
    const raceOffset = line.offsetAt(LINE_RACE, t);
    const limit = line.limitAt(t);
    const covered = sign(rivalLateral - raceOffset) === inside && Math.abs(rivalLateral - raceOffset) > 0.8;
    const wanted = covered ? -inside : inside;
    const room = limit - Math.abs(clamp(raceOffset + wanted * 2.35, -limit, limit));
    if (room < -0.3) return -wanted;
    if (covered && this._sideRoll > 0.35 + this.aggression * 0.5) return 0;
    return wanted;
  }
  _defend(dt, traffic, loc, plan, behind, gapBehind, speed) {
    const line = this.line;
    const t = loc.t;
    if (behind < 0 || gapBehind > DEFEND_RANGE) {
      this.defendTimer = 0;
      this.defendSide = 0;
      if (line.phaseAt(LINE_RACE, t) === PHASE_CORNER) this.defendUsed = false;
      return;
    }
    const closing = traffic.speed[behind] - speed;
    if (closing < -1.5 && gapBehind > CAR_LENGTH * 1.5) {
      this.defendTimer = 0;
      return;
    }
    plan.defending = true;
    this.defendTimer += dt;
    if (gapBehind < CAR_LENGTH * 1.1) {
      plan.alongside = true;
      const theirSide = sign(traffic.lateral[behind] - loc.lateral);
      if (theirSide !== 0) plan.lateralBias -= theirSide * 0.35;
      return;
    }
    if (this.defendUsed && this.defendSide !== 0) {
      plan.lateralBias += this.defendSide * 1.5;
      plan.lineId = LINE_DEFEND;
      return;
    }
    const brakeDist = line.brakeDistanceAt(t);
    if (brakeDist > 260 || this.defendTimer < 0.35) return;
    const turn = line.turnSignAt(t);
    const inside = turn !== 0 ? -turn : sign(traffic.lateral[behind] - loc.lateral) || 1;
    this.defendSide = inside;
    this.defendUsed = true;
    plan.lineId = LINE_DEFEND;
    plan.lateralBias += inside * 1.5;
    plan.brakePointScale = 0.985;
  }
  _blueFlag(dt, traffic, loc, plan, behind, gapBehind) {
    if (this.yieldTimer > 0) this.yieldTimer -= dt;
    const lapped = behind >= 0 && gapBehind < BLUE_FLAG_RANGE && traffic.lap[behind] > traffic.lap[this.index];
    if (lapped) {
      this.yieldTimer = 2.5;
      const line = this.line;
      const t = loc.t;
      const raceOffset = line.offsetAt(LINE_RACE, t);
      this.yieldSide = raceOffset > 0 ? -1 : 1;
      const limit = line.limitAt(t);
      plan.yielding = true;
      plan.lineId = LINE_RACE;
      const settled = line.phaseAt(LINE_RACE, t) !== PHASE_CORNER;
      const step = settled ? 2.2 : 1;
      plan.lateralBias = clamp(this.yieldSide * step, -limit, limit);
      plan.speedScale = 0.92;
      plan.brakePointScale = 0.94;
      plan.ersTarget = ERS_BALANCED;
      plan.drs = false;
      this.attackState = ATT_NONE;
      return true;
    }
    if (this.yieldTimer > 0) {
      plan.yielding = true;
      plan.lateralBias = this.yieldSide * 1.6;
      plan.speedScale = 0.96;
      return true;
    }
    return false;
  }
  avoid(dt, ctx, traffic, loc, plan) {
    plan.avoidBias = 0;
    plan.brakeFloor = 0;
    plan.throttleCap = 1;
    const n = traffic.count;
    if (n < 2) return;
    const idx = this.index;
    const base = idx * NEIGHBOURS;
    const state = this.car.physics.state;
    const speed = state.speed;
    const myLateral = loc.lateral;
    const limit = this.line.limitAt(loc.t) + 0.8;
    let push = 0;
    let brake = 0;
    for (let s = 0; s < NEIGHBOURS; s++) {
      const j = traffic.neighbours[base + s];
      if (j < 0 || j === idx) continue;
      const dLong = traffic.neighbourGap[base + s];
      if (dLong > AVOID_LONG || dLong < -AVOID_LONG) continue;
      const dLat = traffic.lateral[j] - myLateral;
      const absLat = Math.abs(dLat);
      if (absLat > AVOID_LAT) continue;
      const longWeight = 1 - clamp01(Math.abs(dLong) / AVOID_LONG);
      const latWeight = 1 - clamp01(absLat / SIDE_CLEARANCE);
      if (latWeight > 0) {
        const away = absLat > 0.05 ? -sign(dLat) : myLateral > 0 ? 1 : -1;
        const headroom = clamp01((limit - away * myLateral) / 2.5);
        push += away * latWeight * longWeight * 1.15 * headroom;
      }
      if (dLong > 0.5 && absLat < CAR_WIDTH * 0.95) {
        const closing = speed - traffic.speed[j];
        if (closing > 0.5) {
          const clearance = Math.max(0.8, dLong - CAR_LENGTH * 0.85);
          const required = closing * closing / (2 * clearance);
          const capable = Math.max(4, this.line.brakeAccelAt(speed));
          brake = Math.max(brake, clamp01(required / capable));
        }
      }
    }
    plan.avoidBias = clamp(push, -1.25, 1.25);
    plan.brakeFloor = Math.min(brake, 0.78);
    if (plan.brakeFloor > 0.05) plan.throttleCap = 0;
  }
}
