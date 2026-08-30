import * as THREE from 'three';
import { clamp, clamp01, smoothstep, sign } from '../core/MathUtils.js';
import { LINE_RACE, LINE_DEFEND, LINE_LEFT, LINE_RIGHT, PHASE_CORNER } from './RacingLine.js';

/**
 * Racecraft: everything a driver does because there is another car near them.
 *
 * All of it works in track-relative coordinates. World-space distance is the wrong
 * measure on a circuit — two cars ten metres apart across a hairpin are not fighting,
 * and two cars ten metres apart down Kemmel are — so every query here is expressed as
 * a gap along the centreline and a lateral offset across it.
 *
 * `TrafficModel` does the neighbour search once per tick for the whole field and hands
 * every driver its answers. Twenty cars sorted by lap position is a nearly-sorted array
 * every tick, so an insertion sort is linear and the ahead/behind neighbours are simply
 * the adjacent entries. That is cheaper and far more useful than any spatial hash.
 */

const MAX_CARS = 24;
const NEIGHBOURS = 6;             // 3 ahead, 3 behind, per car

const CAR_LENGTH = 5.63;
const CAR_WIDTH = 2.00;
/** Centre-to-centre offset at which the wheels are just clear of each other. */
const SIDE_CLEARANCE = 2.15;

const DIRTY_AIR_RANGE = 34;       // metres of wake that actually costs front load
const DIRTY_AIR_WIDTH = 3.0;
const TOW_RANGE = 60;
const STUDY_RANGE = 26;
const LUNGE_GAP = 12.0;
const DEFEND_RANGE = 16.0;
const BLUE_FLAG_RANGE = 55.0;
const AVOID_LONG = 11.0;
const AVOID_LAT = 3.4;

const ATT_NONE = 0;
const ATT_STUDY = 1;
const ATT_COMMIT = 2;
const ATT_ALONGSIDE = 3;
const ATT_CONCEDE = 4;

/** ERS modes from CarConfig: 0 off, 1 balanced, 2 attack, 3 overtake. */
const ERS_BALANCED = 1;
const ERS_OVERTAKE = 3;

const _models = new WeakMap();

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

/** One traffic model per track, shared by every driver on it. */
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

  /**
   * Refresh the whole field. Guarded on the simulation clock so nineteen drivers calling
   * it in the same tick pay for it once.
   */
  sync(ctx) {
    const stamp = ctx.time.elapsed;
    if (stamp === this._stamp) return;
    this._stamp = stamp;

    const track = this.track;
    const list = ctx.cars?.cars ?? ctx.cars;
    if (!track || !list) { this.count = 0; return; }

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

    // Insertion sort on lap position. The array is already ordered from last tick apart
    // from whoever just crossed the line, so this is linear in practice.
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

  /** Forward distance from `from` to `to` around the lap, normalised, always >= 0. */
  _forward(from, to) {
    let d = to - from;
    if (d < 0) d += 1;
    return d;
  }

  /** Is anyone bearing down on `index` from behind within `metres`? */
  approachingBehind(index, metres, minClosing = 2) {
    const n = this.count;
    if (n < 2) return false;
    const base = index * NEIGHBOURS;
    for (let s = 3; s < NEIGHBOURS; s++) {
      const j = this.neighbours[base + s];
      if (j < 0) continue;
      // A car that is itself in the run-off is not the one you are waiting for.
      if (!this.onTrack[j]) continue;
      const gap = -this.neighbourGap[base + s];
      if (gap > 0 && gap < metres && this.speed[j] > this.speed[index] + minClosing) return true;
    }
    return false;
  }
}

/**
 * One driver's racecraft. Owns the tactical state that has to persist between decisions
 * — which side a move was committed to, whether a defensive move has already been used,
 * whether a blue flag is being honoured — because racing rules are about commitment, and
 * a controller that re-decides every tick weaves.
 */
export class Racecraft {
  constructor(car, line, rng, { aggression = 0.8 } = {}) {
    this.car = car;
    this.index = car.index;
    this.line = line;
    this.rng = rng;
    this.aggression = clamp01(aggression);

    /** Appetite for a move that is only 70 % there. Aggression buys optimism. */
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

  /**
   * The tactical pass. Runs on a round robin — decisions at 20 Hz are far faster than a
   * racing driver makes them, and the plan it writes is held between calls.
   */
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

    // A car that is genuinely racing spends its battery on it.
    if (plan.attacking || plan.defending) plan.ersTarget = ERS_OVERTAKE;

    // DRS is a level request; the race director decides whether it is allowed and the
    // aerodynamics decide whether the flap will physically open at this speed.
    plan.drs = true;

    const limit = line.limitAt(t);
    plan.lateralBias = clamp(plan.lateralBias, -limit, limit);
    return plan;
  }

  /**
   * Following. Dirty air costs the front axle load, so a driver who is stapled to the
   * gearbox of the car ahead through a corner simply washes out — the answer is to sit
   * a little wider and carry a little less. On a straight the same proximity is worth
   * having, so the driver tucks into the tow instead.
   */
  _follow(traffic, loc, plan, ahead, gapAhead, speed) {
    if (ahead < 0 || gapAhead > TOW_RANGE) { this.towSide = 0; return; }

    const line = this.line;
    const t = loc.t;
    const lateralGap = Math.abs(traffic.lateral[ahead] - loc.lateral);
    const kappa = Math.abs(line.curvatureAt(LINE_RACE, t));

    if (gapAhead < DIRTY_AIR_RANGE && lateralGap < DIRTY_AIR_WIDTH && kappa > 0.0035) {
      // Exponential wake decay, matching the aerodynamics model's e-folding length.
      const bite = Math.exp(-gapAhead / 16) * (1 - clamp01(lateralGap / DIRTY_AIR_WIDTH));
      plan.speedScale *= 1 - 0.055 * bite;
      // Move fractionally off line to get the front wing into clean air.
      plan.lateralBias += sign(loc.lateral - traffic.lateral[ahead] || 1) * 0.55 * bite;
      return;
    }

    if (kappa < 0.0025 && speed > 45 && gapAhead < TOW_RANGE) {
      // The tow: line up behind, but a metre offset so the move out is already half made.
      const side = this.attackSide !== 0 ? this.attackSide : (traffic.lateral[ahead] > 0 ? -1 : 1);
      this.towSide = side;
      const towTarget = traffic.lateral[ahead] + side * 0.9;
      plan.lateralBias += clamp(towTarget - line.offsetAt(LINE_RACE, t), -2.2, 2.2)
        * (1 - smoothstep(12, TOW_RANGE, gapAhead));
    }
  }

  /**
   * Attacking. A move is set up over several seconds, committed to at one braking zone,
   * and either lands or is given up. The one thing this must never do is dive down the
   * inside from four car lengths back, which is what "commit only when the gap is
   * genuinely there" means: the projected overlap at the braking point has to work out.
   */
  _attack(dt, traffic, loc, plan, ahead, gapAhead, speed) {
    const line = this.line;
    const t = loc.t;

    if (ahead < 0 || this.cooldown > 0) { this.attackState = ATT_NONE; return; }

    const closing = speed - traffic.speed[ahead];
    const inRange = gapAhead < STUDY_RANGE;

    switch (this.attackState) {
      case ATT_NONE:
        if (inRange && (closing > 0.6 || gapAhead < LUNGE_GAP)) {
          this.attackState = ATT_STUDY;
          this.studyTimer = 0;
          this.target = ahead;
          this.attackSide = 0;
          // One roll per attempt. Re-rolling every tick makes a driver who is willing to
          // try the outside for a sixtieth of a second and then change their mind, which
          // is how an AI ends up never committing to anything.
          this._sideRoll = this.rng.next();
        }
        break;

      case ATT_STUDY: {
        this.studyTimer += dt;
        if (!inRange || this.target !== ahead) { this.attackState = ATT_NONE; break; }
        // Stick with a side once one has been found: a move is a commitment.
        if (this.attackSide === 0) this.attackSide = this._chooseSide(traffic, loc, ahead);

        // Commitment test. Where will the two cars be when the braking zone arrives, and
        // is there room on that side of the road when they get there?
        const brakeDist = line.brakeDistanceAt(t);
        const timeToBrake = brakeDist / Math.max(12, speed);
        const projected = gapAhead - closing * Math.min(timeToBrake, 4);
        const brakeT = t + brakeDist / line.length;
        const room = line.limitAt(brakeT) - Math.abs(line.clampedOffsetAt(LINE_RACE, brakeT, this.attackSide * 2.35));

        const ready = this.studyTimer > this.patience
          && brakeDist < 140
          && projected < this.commitThreshold
          && room > -0.2
          && this.attackSide !== 0;

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
        // Brake later than the reference, in proportion to how much they want it.
        plan.brakePointScale = 1 + 0.045 * this.aggression;
        plan.speedScale *= 1.005;

        const overlap = CAR_LENGTH - gapAhead;
        if (overlap > CAR_LENGTH * 0.35) {
          this.attackState = ATT_ALONGSIDE;
          this.attackTimer = 0;
        } else if (this.attackTimer > 3.2 || gapAhead > STUDY_RANGE
          || (line.phaseAt(LINE_RACE, t) === PHASE_CORNER && overlap < CAR_LENGTH * 0.3)) {
          this.attackState = ATT_CONCEDE;
          this.attackTimer = 0;
        }
        break;
      }

      case ATT_ALONGSIDE: {
        this.attackTimer += dt;
        plan.attacking = true;
        plan.alongside = true;
        // Wheel to wheel: hold the chosen side of the road and leave a car's width. The
        // avoidance pass does the fine spacing; this just refuses to drift across.
        plan.lineId = this.attackSide < 0 ? LINE_LEFT : LINE_RIGHT;
        plan.brakePointScale = 1;
        if (gapAhead > CAR_LENGTH * 1.6 && traffic.gapBehind[this.index] > CAR_LENGTH * 1.6) {
          // Either the move landed or it did not; both end the fight.
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
        // Give the corner up rather than take both cars off: back out, tuck in behind.
        plan.brakePointScale = 0.94;
        plan.speedScale *= 0.985;
        plan.lineId = LINE_RACE;
        if (this.attackTimer > 1.6) {
          this.attackState = ATT_NONE;
          this.cooldown = 2.0 + this.rng.next() * 2.5;
          this.attackSide = 0;
        }
        break;

      default:
        this.attackState = ATT_NONE;
        break;
    }
  }

  /**
   * Which side to attack from. The inside of the next corner is worth more than any
   * other consideration, but only if the defender has not already taken it; if they
   * have, the choice is the outside or nothing.
   */
  _chooseSide(traffic, loc, ahead) {
    const line = this.line;
    const t = loc.t;
    const turn = line.turnSignAt(t);
    // With a corner coming, the inside is the only side worth having. On a straight,
    // the side the tow already has this car sitting on is the cheapest move to make.
    const inside = turn !== 0 ? -turn : (this.towSide || (loc.lateral > 0 ? -1 : 1));
    const rivalLateral = traffic.lateral[ahead];
    const raceOffset = line.offsetAt(LINE_RACE, t);
    const limit = line.limitAt(t);

    // Is the defender covering the inside already?
    const covered = sign(rivalLateral - raceOffset) === inside && Math.abs(rivalLateral - raceOffset) > 0.8;
    const wanted = covered ? -inside : inside;

    // Refuse a side there is no road on.
    const room = limit - Math.abs(clamp(raceOffset + wanted * 2.35, -limit, limit));
    if (room < -0.3) return -wanted;

    // Going round the outside is a low-percentage move; only the brave try it.
    if (covered && this._sideRoll > 0.35 + this.aggression * 0.5) return 0;
    return wanted;
  }

  /**
   * Defending. One move, made early, held to the corner. The regulation the AI is
   * written to is the real one: you may take a defensive line, you may not move under
   * braking, and you must leave a car's width once the attacker has a wheel alongside.
   */
  _defend(dt, traffic, loc, plan, behind, gapBehind, speed) {
    const line = this.line;
    const t = loc.t;

    if (behind < 0 || gapBehind > DEFEND_RANGE) {
      this.defendTimer = 0;
      this.defendSide = 0;
      // The move resets once the corner that prompted it is behind us.
      if (line.phaseAt(LINE_RACE, t) === PHASE_CORNER) this.defendUsed = false;
      return;
    }

    const closing = traffic.speed[behind] - speed;
    if (closing < -1.5 && gapBehind > CAR_LENGTH * 1.5) { this.defendTimer = 0; return; }

    plan.defending = true;
    this.defendTimer += dt;

    // Already alongside: no move is legal, and the rule is a car's width of room.
    if (gapBehind < CAR_LENGTH * 1.1) {
      plan.alongside = true;
      const theirSide = sign(traffic.lateral[behind] - loc.lateral);
      if (theirSide !== 0) plan.lateralBias -= theirSide * 0.35;
      return;
    }

    if (this.defendUsed && this.defendSide !== 0) {
      // Hold whatever was chosen. Moving back is the weave the rules forbid.
      plan.lateralBias += this.defendSide * 1.5;
      plan.lineId = LINE_DEFEND;
      return;
    }

    // One move, made on the approach, toward the inside of what is coming.
    const brakeDist = line.brakeDistanceAt(t);
    if (brakeDist > 260 || this.defendTimer < 0.35) return;

    const turn = line.turnSignAt(t);
    const inside = turn !== 0 ? -turn : sign(traffic.lateral[behind] - loc.lateral) || 1;
    this.defendSide = inside;
    this.defendUsed = true;
    plan.lineId = LINE_DEFEND;
    plan.lateralBias += inside * 1.5;
    // The defensive line is slower into the corner and everybody knows it.
    plan.brakePointScale = 0.985;
  }

  /**
   * Blue flags. A lapped car gets out of the way: off the racing line, off the throttle,
   * and it stays there until the leader is clear. Nothing looks more like a toy than a
   * back marker holding up the winner for three corners.
   */
  _blueFlag(dt, traffic, loc, plan, behind, gapBehind) {
    if (this.yieldTimer > 0) this.yieldTimer -= dt;

    const lapped = behind >= 0 && gapBehind < BLUE_FLAG_RANGE
      && traffic.lap[behind] > traffic.lap[this.index];

    if (lapped) {
      this.yieldTimer = 2.5;
      const line = this.line;
      const t = loc.t;
      // Move to the side the racing line is not on, so the lead car keeps its line.
      const raceOffset = line.offsetAt(LINE_RACE, t);
      this.yieldSide = raceOffset > 0 ? -1 : 1;
      const limit = line.limitAt(t);
      plan.yielding = true;
      plan.lineId = LINE_RACE;
      // Move over on the straight, not mid-corner: a back marker that jinks sideways at
      // the apex takes the car it is trying to help off the road with it.
      const settled = line.phaseAt(LINE_RACE, t) !== PHASE_CORNER;
      const step = settled ? 2.2 : 1.0;
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

  /**
   * Per-tick proximity handling. This is deliberately soft: it nudges and it lifts, it
   * does not swerve. Cars are allowed to touch — an F1 race where nobody ever rubs a
   * wheel reads as fake — but a car that is genuinely about to be rear-ended lifts.
   */
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

      // Lateral separation: strongest when the two cars overlap longitudinally.
      const longWeight = 1 - clamp01(Math.abs(dLong) / AVOID_LONG);
      const latWeight = 1 - clamp01(absLat / SIDE_CLEARANCE);
      if (latWeight > 0) {
        const away = absLat > 0.05 ? -sign(dLat) : (myLateral > 0 ? 1 : -1);
        // Never push a car toward the edge of the road it has no room on.
        const headroom = clamp01((limit - away * myLateral) / 2.5);
        push += away * latWeight * longWeight * 1.15 * headroom;
      }

      // Closing on a car directly ahead: brake on time to collision, not on distance.
      if (dLong > 0.5 && absLat < CAR_WIDTH * 0.95) {
        const closing = speed - traffic.speed[j];
        if (closing > 0.5) {
          const clearance = Math.max(0.8, dLong - CAR_LENGTH * 0.85);
          const required = (closing * closing) / (2 * clearance);
          const capable = Math.max(4, this.line.brakeAccelAt(speed));
          brake = Math.max(brake, clamp01(required / capable));
        }
      }
    }

    plan.avoidBias = clamp(push, -1.25, 1.25);
    // Capped short of a panic stop so contact stays possible and pile-ups do not.
    plan.brakeFloor = Math.min(brake, 0.78);
    if (plan.brakeFloor > 0.05) plan.throttleCap = 0;
  }
}
