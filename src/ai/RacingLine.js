import * as THREE from 'three';
import { clamp, clamp01, smoothstep, wrap01, sign, G } from '../core/MathUtils.js';

/**
 * The fast way round, solved rather than authored.
 *
 * Two things come out of here. First a path: a lateral offset field over the drivable
 * corridor found by minimising the discrete curvature of the resulting world-space
 * polyline, clamped to the corridor after every sweep. Minimum curvature is the whole
 * of the classic geometric racing line — wide entry, apex kerb, unwind to the far kerb —
 * so none of that has to be written down, it falls out of the solve.
 *
 * Second a speed profile: the largest speed the car can hold at every point, found by
 * a corner-speed pass followed by a backward braking pass and a forward traction pass
 * over the closed loop. The capability numbers are derived from the car's own config —
 * the Pacejka peak-friction coefficients, the ground-effect downforce curve, the fuel-
 * flow-limited engine power and the brake torque — not from tuned constants, so the
 * profile stays honest if the physics subsystem moves a number.
 *
 * Three alternate lines are solved alongside the primary one: a defensive line that
 * protects the inside of the next corner, and an overtaking line displaced to either
 * side. Nineteen cars on a single rail looks like a train set; nineteen cars choosing
 * between four lines looks like a race.
 *
 * Everything is built once, at construction, into flat typed arrays. Every query after
 * that is an array read and a lerp, so the AI's hot path never touches the track.
 */

export const LINE_RACE = 0;
export const LINE_DEFEND = 1;
export const LINE_LEFT = 2;
export const LINE_RIGHT = 3;
export const LINE_COUNT = 4;

export const PHASE_STRAIGHT = 0;
export const PHASE_BRAKE = 1;
export const PHASE_CORNER = 2;
export const PHASE_EXIT = 3;

/** Arc-length spacing of the solver grid, metres. 3 m resolves a hairpin apex. */
const SPACING = 3.0;

/** Metres of tarmac left outside the car's centre line at full commitment. */
const RACE_MARGIN = 1.55;
const ALT_MARGIN = 1.90;

/** Lateral displacement of the overtaking lines from the racing line, metres. */
const ATTACK_OFFSET = 2.35;
const DEFEND_OFFSET = 1.70;

const COARSE_STRIDE = 4;
const COARSE_ITERATIONS = 460;
const FINE_ITERATIONS = 160;
const ALT_ITERATIONS = 120;

/** Grip the driver leaves on the table: tyre temperature window, wear, and margin. */
const CORNER_MARGIN = 0.90;
const BRAKE_MARGIN = 0.90;
const TRACTION_MARGIN = 0.94;
const TEMPERATURE_FACTOR = 0.97;
/** Off the rubbered-in line there is dust and marbles. */
const OFFLINE_GRIP = 0.965;

const SPEED_TABLE_MAX = 125;      // m/s — comfortably past any F1 terminal velocity
const CURVATURE_CORNER = 0.0035;  // 1/m — below this the road counts as straight
const LOOK_FOR_TURN = 400;        // m of forward search for the next corner's direction
const BIG_DISTANCE = 9999;

const _sampleOut = {
  t: 0, distance: 0, lateral: 0, onTrack: false, index: 0,
  position: new THREE.Vector3(),
  tangent: new THREE.Vector3(),
  right: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  width: 0, banking: 0, curvature: 0, gradient: 0,
};

const _cache = new WeakMap();

/**
 * One shared solve per track. Nineteen drivers asking for the racing line must not run
 * nineteen relaxations; they all read the same tables.
 */
export function getRacingLine(track, config) {
  let line = _cache.get(track);
  if (!line) {
    line = new RacingLine(track, config);
    _cache.set(track, line);
  }
  return line;
}

export class RacingLine {
  /**
   * @param {object} track Track (CONTRACT.md §2)
   * @param {object} config CarConfig used to derive the capability tables
   */
  constructor(track, config) {
    this.track = track;
    this.length = track.length;
    this.spacing = SPACING;
    this.count = Math.max(64, Math.round(track.length / SPACING));
    this.spacing = track.length / this.count;

    this._buildCorridor(track);
    this._buildAeroTable(config);
    this._buildGripTables(config);

    const n = this.count;
    this.offset = [];
    this.curvature = [];
    this.speed = [];
    this.phase = [];
    this.slope = [];
    for (let l = 0; l < LINE_COUNT; l++) {
      this.offset.push(new Float32Array(n));
      this.curvature.push(new Float32Array(n));
      this.speed.push(new Float32Array(n));
      this.phase.push(new Uint8Array(n));
      this.slope.push(new Float32Array(n));
    }

    this._solvePrimary();
    this._buildTurnField();
    this._deriveAlternates();
    for (let l = 0; l < LINE_COUNT; l++) {
      this._pathCurvature(this.offset[l], this.curvature[l]);
      this._offsetSlope(this.offset[l], this.slope[l]);
      this._speedProfile(l, l === LINE_RACE ? 1 : OFFLINE_GRIP);
      this._classify(l);
    }
    this._buildBrakeField();
  }

  // --- corridor ---------------------------------------------------------------------

  /**
   * Resample the centreline at uniform arc length into flat arrays. Everything after
   * this point works on the arrays, so the solver and the runtime queries never call
   * back into the track.
   */
  _buildCorridor(track) {
    const n = this.count;
    this.cx = new Float32Array(n);
    this.cy = new Float32Array(n);
    this.cz = new Float32Array(n);
    this.rx = new Float32Array(n);
    this.rz = new Float32Array(n);
    this.tanBank = new Float32Array(n);
    this.gradient = new Float32Array(n);
    this.banking = new Float32Array(n);
    this.baseCurvature = new Float32Array(n);
    this.raceLimit = new Float32Array(n);
    this.altLimit = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      track.sample(i / n, _sampleOut);
      this.cx[i] = _sampleOut.position.x;
      this.cy[i] = _sampleOut.position.y;
      this.cz[i] = _sampleOut.position.z;
      this.rx[i] = _sampleOut.right.x;
      this.rz[i] = _sampleOut.right.z;
      this.banking[i] = _sampleOut.banking;
      this.tanBank[i] = Math.tan(_sampleOut.banking);
      this.gradient[i] = _sampleOut.gradient;
      this.baseCurvature[i] = _sampleOut.curvature;
      this.raceLimit[i] = Math.max(0.35, _sampleOut.width - RACE_MARGIN);
      this.altLimit[i] = Math.max(0.25, _sampleOut.width - ALT_MARGIN);
    }
  }

  // --- car capability ---------------------------------------------------------------

  /**
   * Downforce and drag against speed, tabulated at 1 m/s.
   *
   * The floor's suction depends on ride height and ride height depends on the load the
   * floor is making, so the pair is solved by three fixed-point iterations per entry.
   * At the reference platform that lands on ~5.2 m^2 of effective ClA at rest rising to
   * the ground-effect peak of ~5.5 m^2 once the car is squatting at speed: 2.3 tonnes of
   * downforce at 300 km/h, which is what the chassis config says the car makes.
   */
  _buildAeroTable(config) {
    const a = config.aero;
    const susp = config.suspension;
    const N = SPEED_TABLE_MAX + 1;
    this.downforce = new Float32Array(N);
    this.dragForce = new Float32Array(N);
    this.aeroBalance = new Float32Array(N);

    // Both front corners resist the front axle's share of the load.
    const frontRate = Math.max(1, susp.front.rideRate * 2);
    const floorHeight = a.groundEffectPeak;

    for (let v = 0; v < N; v++) {
      const q = 0.5 * a.airDensity * v * v;
      const speedShift = a.balanceSpeedShift * (v / 100) * (v / 100);
      let rh = a.referenceRideHeightFront;
      let df = 0;
      let balance = clamp(a.frontBalance - speedShift, a.balanceMin, a.balanceMax);

      for (let iter = 0; iter < 3; iter++) {
        const ge = 1 + a.groundEffectGain * smoothstep(a.groundEffectOnset, a.groundEffectPeak, rh);
        df = q * a.clA * ge;
        const rhShift = a.balanceRideHeightGain * (rh - a.referenceRideHeightFront);
        balance = clamp(a.frontBalance - speedShift + rhShift, a.balanceMin, a.balanceMax);
        rh = clamp(a.referenceRideHeightFront - (df * balance) / frontRate, floorHeight, a.referenceRideHeightFront);
      }

      const df10 = df / 10000;
      const cdA = Math.max(0.35, a.cdA + a.inducedDrag * df10 * df10);
      this.downforce[v] = df;
      this.dragForce[v] = q * cdA;
      this.aeroBalance[v] = balance;
    }
  }

  /**
   * Peak lateral, braking and traction acceleration against speed.
   *
   * Peak friction comes straight out of the Pacejka load-sensitivity terms the tyre
   * model uses (`PDY1 + PDY2 * dfz`), evaluated at the axle loads the aero table says
   * the car carries at that speed. Lateral load transfer is then charged against the
   * result: because mu falls with load, moving `d` newtons from the inner wheel to the
   * outer one costs `2 * |PDY2| * d^2 / FZ0` of axle capacity, which is the reason a
   * stiff car is a slow car and the reason the numbers here are believable rather than
   * simply "mu times weight".
   */
  _buildGripTables(config) {
    const N = SPEED_TABLE_MAX + 1;
    const c = config.chassis;
    const t = config.tyres;
    const mass = c.mass;
    const weight = mass * G;
    const wf = c.frontWeightFraction;
    const trackAvg = (c.trackFront + c.trackRear) * 0.5;
    const rollShareFront = config.suspension.front.antiRoll
      / Math.max(1, config.suspension.front.antiRoll + config.suspension.rear.antiRoll);

    const fz0f = t.front.mf.FZ0;
    const fz0r = t.rear.mf.FZ0;
    const dyf = t.front.mf.PDY1;
    const dyf2 = t.front.mf.PDY2;
    const dyr = t.rear.mf.PDY1;
    const dyr2 = t.rear.mf.PDY2;
    const dxf = t.front.mf.PDX1;
    const dxf2 = t.front.mf.PDX2;
    const dxr = t.rear.mf.PDX1;
    const dxr2 = t.rear.mf.PDX2;

    const compound = t.compoundData?.gripScale ?? 1;
    const surfaceScale = compound * TEMPERATURE_FACTOR;

    // Brake force ceiling from the calipers, ignoring which axle it lands on.
    const brakeForceCap = config.brakes.maxTorqueTotal
      / (0.5 * (t.front.radius + t.rear.radius));

    const power = this._peakPower(config);

    this.latAccel = new Float32Array(N);
    this.brakeAccel = new Float32Array(N);
    this.driveAccel = new Float32Array(N);
    this.coastDecel = new Float32Array(N);

    for (let v = 0; v < N; v++) {
      const df = this.downforce[v];
      const balance = this.aeroBalance[v];
      const nf = weight * wf + df * balance;
      const nr = weight * (1 - wf) + df * (1 - balance);

      // Lateral: iterate once on the transfer, which depends on the answer.
      let aLat = 0;
      for (let iter = 0; iter < 2; iter++) {
        const transfer = mass * aLat * c.cgHeight / trackAvg;
        const df_f = Math.min(nf * 0.5, transfer * rollShareFront);
        const df_r = Math.min(nr * 0.5, transfer * (1 - rollShareFront));
        const fy = this._axleForce(nf, dyf, dyf2, fz0f, df_f)
          + this._axleForce(nr, dyr, dyr2, fz0r, df_r);
        aLat = (fy * surfaceScale * CORNER_MARGIN) / mass;
      }
      this.latAccel[v] = aLat;

      // Braking: all four wheels, longitudinal load transfer roughly self-cancelling
      // because what the front gains in load it loses in mu.
      const fxF = this._axleForce(nf, dxf, dxf2, fz0f, 0);
      const fxR = this._axleForce(nr, dxr, dxr2, fz0r, 0);
      const tyreBrake = Math.min((fxF + fxR) * surfaceScale, brakeForceCap);
      const dragDecel = this.dragForce[v] / mass;
      const rollDecel = c.rollingResistance * (weight + df) / mass;
      this.coastDecel[v] = dragDecel + rollDecel;
      this.brakeAccel[v] = (tyreBrake * BRAKE_MARGIN) / mass + this.coastDecel[v];

      // Traction: rear axle only, with longitudinal transfer onto it under power.
      const muR = this._axleMu(nr, dxr, dxr2, fz0r) * surfaceScale;
      const squat = 1 - muR * c.cgHeight / c.wheelbase;
      const gripAccel = squat > 0.15
        ? (muR * nr / mass) / squat
        : muR * nr / mass;
      const powerAccel = v > 1 ? power / (mass * v) : 1e4;
      this.driveAccel[v] = Math.min(gripAccel, powerAccel) * TRACTION_MARGIN - this.coastDecel[v];
    }

    // Terminal velocity: where the power left after drag runs out. Without this the
    // profile would tell the AI to aim at the table ceiling down every straight.
    this.vMax = SPEED_TABLE_MAX;
    for (let v = 30; v <= SPEED_TABLE_MAX; v++) {
      if (this.driveAccel[v] <= 0) { this.vMax = v; break; }
    }
  }

  /** Peak friction coefficient of one axle at total axle load `n`. */
  _axleMu(n, pd1, pd2, fz0) {
    const perWheel = Math.max(1, n * 0.5);
    return Math.max(0.4, pd1 + pd2 * ((perWheel - fz0) / fz0));
  }

  /**
   * Axle lateral/longitudinal capacity with `transfer` newtons moved from the inner
   * wheel to the outer one. Falls back to a single loaded wheel once the inner lifts.
   */
  _axleForce(n, pd1, pd2, fz0, transfer) {
    const perWheel = Math.max(1, n * 0.5);
    const d = Math.min(transfer, perWheel);
    const outer = perWheel + d;
    const inner = perWheel - d;
    const muO = Math.max(0.4, pd1 + pd2 * ((outer - fz0) / fz0));
    const muI = Math.max(0.4, pd1 + pd2 * ((inner - fz0) / fz0));
    return muO * outer + muI * inner;
  }

  /**
   * Crank power available on a qualifying-style deployment: the peak of the ICE torque
   * curve capped by the fuel-flow regulation, plus most of the MGU-K, through the
   * gearbox. The AI's profile assumes it is not deploying flat out everywhere.
   */
  _peakPower(config) {
    const curve = config.engine.torqueCurve;
    let best = 0;
    for (let i = 0; i < curve.length; i++) {
      const p = curve[i][1] * curve[i][0] * (Math.PI / 30);
      if (p > best) best = p;
    }
    const fuelCap = config.engine.fuelFlowMax * config.engine.fuelLHV * config.engine.thermalEfficiency;
    const ice = Math.min(best, fuelCap);
    const hybrid = config.ers.deployPowerMax * 0.6;
    return (ice + hybrid) * config.transmission.efficiency;
  }

  // --- line solve -------------------------------------------------------------------

  /**
   * Minimum-curvature relaxation. Each sweep pulls every control point toward the
   * midpoint of its neighbours — the discrete Laplacian, whose magnitude is the
   * curvature — projected onto the corridor's lateral axis so the point can only move
   * across the road, then clamps it back inside the drivable width. What survives the
   * clamp on a corner is the apex; what survives on a straight is a straight.
   */
  _relax(offset, limit, cx, cz, rx, rz, m, iterations, omega) {
    const px = this._relaxX && this._relaxX.length >= m ? this._relaxX : (this._relaxX = new Float32Array(m));
    const pz = this._relaxZ && this._relaxZ.length >= m ? this._relaxZ : (this._relaxZ = new Float32Array(m));
    for (let iter = 0; iter < iterations; iter++) {
      for (let k = 0; k < m; k++) {
        px[k] = cx[k] + rx[k] * offset[k];
        pz[k] = cz[k] + rz[k] * offset[k];
      }
      for (let k = 0; k < m; k++) {
        const a = k === 0 ? m - 1 : k - 1;
        const b = k === m - 1 ? 0 : k + 1;
        const lx = (px[a] + px[b]) * 0.5 - px[k];
        const lz = (pz[a] + pz[b]) * 0.5 - pz[k];
        const dn = lx * rx[k] + lz * rz[k];
        offset[k] = clamp(offset[k] + omega * dn, -limit[k], limit[k]);
      }
    }
  }

  /**
   * Coarse-to-fine solve. Relaxation propagates information one sample per sweep, so
   * solving the 3 m grid directly would need thousands of sweeps to let a long
   * straight influence the corner at its end. Solving a decimated grid first and
   * upsampling gets the same answer for a fifth of the work.
   */
  _solvePrimary() {
    const n = this.count;
    const stride = COARSE_STRIDE;
    const m = Math.floor(n / stride);

    const ccx = new Float32Array(m);
    const ccz = new Float32Array(m);
    const crx = new Float32Array(m);
    const crz = new Float32Array(m);
    const clim = new Float32Array(m);
    const coff = new Float32Array(m);

    for (let k = 0; k < m; k++) {
      const i = k * stride;
      ccx[k] = this.cx[i];
      ccz[k] = this.cz[i];
      crx[k] = this.rx[i];
      crz[k] = this.rz[i];
      clim[k] = this.raceLimit[i];
      // Seeding on the inside of the turn, proportional to how hard the turn is, saves
      // a few thousand sweeps: from a cold start the solve has to discover which side
      // of the road the apex is on before it can converge on where.
      const kappa = this.baseCurvature[i];
      coff[k] = clamp(-sign(kappa) * clim[k] * clamp01(Math.abs(kappa) * 90), -clim[k], clim[k]);
    }

    this._relax(coff, clim, ccx, ccz, crx, crz, m, COARSE_ITERATIONS, 0.55);

    const off = this.offset[LINE_RACE];
    for (let i = 0; i < n; i++) {
      const f = (i / stride) % m;
      const a = Math.floor(f) % m;
      const b = (a + 1) % m;
      const u = f - Math.floor(f);
      off[i] = clamp(coff[a] + (coff[b] - coff[a]) * u, -this.raceLimit[i], this.raceLimit[i]);
    }

    this._relax(off, this.raceLimit, this.cx, this.cz, this.rx, this.rz, n, FINE_ITERATIONS, 0.42);
  }

  /**
   * The three alternates. Each starts from the racing line displaced toward its target
   * side, then gets a short relaxation with a spring back to that target: pure
   * minimum-curvature would simply collapse them all onto the racing line again, and a
   * raw parallel offset would be undrivable through a hairpin.
   */
  _deriveAlternates() {
    const n = this.count;
    const race = this.offset[LINE_RACE];
    const target = this._altTarget || (this._altTarget = new Float32Array(n));

    for (let l = 1; l < LINE_COUNT; l++) {
      const off = this.offset[l];
      for (let i = 0; i < n; i++) {
        let want;
        if (l === LINE_DEFEND) {
          // Inside of the corner that is coming, not of whatever the road is doing
          // underneath the car: a defensive line is a commitment made on the approach.
          // Positive curvature turns left, and lateral is positive to the right, so the
          // inside is the negative side of a left-hander.
          const inside = -this.turnSign[i];
          // Fade the move in over the last 300 m so the line stays smooth and legal.
          const commit = 1 - smoothstep(90, 300, this.turnDistance[i]);
          want = race[i] + inside * DEFEND_OFFSET * commit;
        } else if (l === LINE_LEFT) {
          want = race[i] - ATTACK_OFFSET;
        } else {
          want = race[i] + ATTACK_OFFSET;
        }
        target[i] = clamp(want, -this.altLimit[i], this.altLimit[i]);
        off[i] = target[i];
      }
      this._relaxToward(off, target, this.altLimit, ALT_ITERATIONS, 0.34, 0.18);
    }
  }

  /** Relaxation with an attractor, so the line smooths without losing its identity. */
  _relaxToward(offset, target, limit, iterations, omega, pull) {
    const n = this.count;
    const cx = this.cx; const cz = this.cz;
    const rx = this.rx; const rz = this.rz;
    const px = this._relaxX && this._relaxX.length >= n ? this._relaxX : (this._relaxX = new Float32Array(n));
    const pz = this._relaxZ && this._relaxZ.length >= n ? this._relaxZ : (this._relaxZ = new Float32Array(n));
    for (let iter = 0; iter < iterations; iter++) {
      for (let k = 0; k < n; k++) {
        px[k] = cx[k] + rx[k] * offset[k];
        pz[k] = cz[k] + rz[k] * offset[k];
      }
      for (let k = 0; k < n; k++) {
        const a = k === 0 ? n - 1 : k - 1;
        const b = k === n - 1 ? 0 : k + 1;
        const lx = (px[a] + px[b]) * 0.5 - px[k];
        const lz = (pz[a] + pz[b]) * 0.5 - pz[k];
        const dn = lx * rx[k] + lz * rz[k];
        const next = offset[k] + omega * dn + pull * (target[k] - offset[k]);
        offset[k] = clamp(next, -limit[k], limit[k]);
      }
    }
  }

  /**
   * Signed curvature of the offset path, from the circumscribed circle of each triple
   * of points in plan. The sign follows the track's convention: positive turns left.
   */
  _pathCurvature(offset, out) {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      const a = i === 0 ? n - 1 : i - 1;
      const b = i === n - 1 ? 0 : i + 1;
      const ax = this.cx[a] + this.rx[a] * offset[a];
      const az = this.cz[a] + this.rz[a] * offset[a];
      const bx = this.cx[i] + this.rx[i] * offset[i];
      const bz = this.cz[i] + this.rz[i] * offset[i];
      const cx2 = this.cx[b] + this.rx[b] * offset[b];
      const cz2 = this.cz[b] + this.rz[b] * offset[b];

      const v1x = bx - ax, v1z = bz - az;
      const v2x = cx2 - bx, v2z = cz2 - bz;
      const cross = v1x * v2z - v1z * v2x;
      const l1 = Math.hypot(v1x, v1z);
      const l2 = Math.hypot(v2x, v2z);
      const l3 = Math.hypot(cx2 - ax, cz2 - az);
      const denom = l1 * l2 * l3;
      // Menger curvature: |4 * area| / (product of the three side lengths).
      const kappa = denom > 1e-6 ? (2 * cross) / denom : 0;
      // The track calls a left turn positive; a left turn is a negative cross product
      // in a right-handed frame with +Y up, so the sign flips here.
      out[i] = -kappa;
    }

    // Three light box-blur passes: Menger curvature on a 3 m grid is noisy enough that
    // the speed profile would otherwise brake for quantisation.
    const tmp = this._curveBlur && this._curveBlur.length >= n ? this._curveBlur : (this._curveBlur = new Float32Array(n));
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < n; i++) {
        const a = i === 0 ? n - 1 : i - 1;
        const b = i === n - 1 ? 0 : i + 1;
        tmp[i] = (out[a] + out[i] * 2 + out[b]) * 0.25;
      }
      out.set(tmp.subarray(0, n));
    }
  }

  /**
   * Rate of change of the lateral offset with arc length. The lateral controller needs
   * this: without it, the error derivative on corner entry is dominated by the target
   * sweeping across the road rather than by the car failing to follow it.
   */
  _offsetSlope(offset, out) {
    const n = this.count;
    const inv = 1 / (2 * this.spacing);
    for (let i = 0; i < n; i++) {
      const a = i === 0 ? n - 1 : i - 1;
      const b = i === n - 1 ? 0 : i + 1;
      out[i] = (offset[b] - offset[a]) * inv;
    }
  }

  // --- speed profile ----------------------------------------------------------------

  /** Table lookup with linear interpolation, clamped at both ends. */
  _lookup(table, v) {
    if (!(v > 0)) return table[0];
    if (v >= SPEED_TABLE_MAX) return table[SPEED_TABLE_MAX];
    const i = v | 0;
    const f = v - i;
    return table[i] + (table[i + 1] - table[i]) * f;
  }

  latAccelAt(v) { return this._lookup(this.latAccel, v); }

  brakeAccelAt(v) { return this._lookup(this.brakeAccel, v); }

  driveAccelAt(v) { return this._lookup(this.driveAccel, v); }

  coastDecelAt(v) { return this._lookup(this.coastDecel, v); }

  /**
   * Corner-limiting speed where `v^2 * |kappa| = aLat(v)`. Because the capability rises
   * with speed through downforce, this is implicit; four fixed-point iterations from a
   * low-speed guess converge to well inside a tenth of a metre per second.
   */
  _cornerSpeed(kappa, banking, gripScale) {
    const k = Math.abs(kappa);
    if (k < 1e-5) return this.vMax;
    // Banking on a road course is small, but it is free lateral force: the component of
    // weight down the slope adds to what the tyres have to find.
    const bankAssist = Math.max(0, Math.sin(Math.abs(banking))) * G;
    let v = Math.sqrt(this.latAccel[0] * gripScale / k);
    for (let iter = 0; iter < 4; iter++) {
      const cap = this._lookup(this.latAccel, v) * gripScale + bankAssist;
      v = Math.sqrt(cap / k);
      if (v > this.vMax) { v = this.vMax; break; }
    }
    return Math.min(v, this.vMax);
  }

  /**
   * Corner speeds, then a backward pass applying the braking limit and a forward pass
   * applying traction and power. Both passes wrap the closed loop twice so a braking
   * zone that starts before the start-finish line still constrains the straight that
   * precedes it.
   */
  _speedProfile(lineId, gripScale) {
    const n = this.count;
    const ds = this.spacing;
    const speed = this.speed[lineId];
    const kappa = this.curvature[lineId];

    for (let i = 0; i < n; i++) {
      speed[i] = this._cornerSpeed(kappa[i], this.banking[i], gripScale);
    }

    for (let k = 2 * n - 1; k >= 0; k--) {
      const i = k % n;
      const j = (i + 1) % n;
      const vNext = speed[j];
      // Friction ellipse: whatever the tyres are already spending on turning is not
      // available for stopping, which is what makes the entry to a fast corner a long
      // shallow brake and the entry to a hairpin a short violent one.
      const latUse = clamp01((vNext * vNext * Math.abs(kappa[j])) / Math.max(1, this._lookup(this.latAccel, vNext) * gripScale));
      const share = Math.sqrt(Math.max(0.04, 1 - latUse * latUse));
      const slope = Math.sin(this.gradient[j]);
      const a = this._lookup(this.brakeAccel, vNext) * share * gripScale + G * slope;
      const allowed = Math.sqrt(Math.max(0, vNext * vNext + 2 * Math.max(0.5, a) * ds));
      if (allowed < speed[i]) speed[i] = allowed;
    }

    for (let k = 0; k < 2 * n; k++) {
      const i = k % n;
      const p = (i - 1 + n) % n;
      const vPrev = speed[p];
      const latUse = clamp01((vPrev * vPrev * Math.abs(kappa[p])) / Math.max(1, this._lookup(this.latAccel, vPrev) * gripScale));
      const share = Math.sqrt(Math.max(0.04, 1 - latUse * latUse));
      const slope = Math.sin(this.gradient[p]);
      const a = this._lookup(this.driveAccel, vPrev) * share * gripScale - G * slope;
      if (a <= 0) continue;
      const allowed = Math.sqrt(Math.max(0, vPrev * vPrev + 2 * a * ds));
      if (allowed < speed[i]) speed[i] = allowed;
    }
  }

  /** Label every point so the AI can ask "am I braking, turning or driving out?". */
  _classify(lineId) {
    const n = this.count;
    const speed = this.speed[lineId];
    const kappa = this.curvature[lineId];
    const phase = this.phase[lineId];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dv = speed[j] - speed[i];
      if (dv < -0.12) phase[i] = PHASE_BRAKE;
      else if (Math.abs(kappa[i]) > CURVATURE_CORNER) phase[i] = dv > 0.12 ? PHASE_EXIT : PHASE_CORNER;
      else phase[i] = PHASE_STRAIGHT;
    }
  }

  /**
   * Two forward-looking fields the racecraft needs: how far to the next braking zone
   * (the only place an overtake can be set up) and which way the next corner goes (the
   * only thing that decides which side is the inside).
   */
  _buildTurnField() {
    const n = this.count;
    const ds = this.spacing;
    this.turnSign = new Float32Array(n);
    this.turnDistance = new Float32Array(n);

    let s = 0;
    let td = BIG_DISTANCE;
    const kappa = this.baseCurvature;
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 2 * n - 1; k >= 0; k--) {
        const i = k % n;
        if (Math.abs(kappa[i]) > CURVATURE_CORNER) { s = sign(kappa[i]); td = 0; } else td += ds;
        if (pass === 1) {
          this.turnDistance[i] = Math.min(td, BIG_DISTANCE);
          this.turnSign[i] = td <= LOOK_FOR_TURN ? s : 0;
        }
      }
    }
  }

  _buildBrakeField() {
    const n = this.count;
    const ds = this.spacing;
    this.brakeDistance = new Float32Array(n);
    const phase = this.phase[LINE_RACE];
    let d = BIG_DISTANCE;
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 2 * n - 1; k >= 0; k--) {
        const i = k % n;
        if (phase[i] === PHASE_BRAKE) d = 0;
        else d += ds;
        if (pass === 1) this.brakeDistance[i] = Math.min(d, BIG_DISTANCE);
      }
    }
  }

  // --- queries (allocation-free) ----------------------------------------------------

  indexAt(t) {
    const n = this.count;
    const i = Math.floor(wrap01(t) * n);
    return i >= n ? n - 1 : i;
  }

  _lerpArray(arr, t) {
    const n = this.count;
    const f = wrap01(t) * n;
    let a = Math.floor(f);
    const u = f - a;
    a %= n;
    const b = a === n - 1 ? 0 : a + 1;
    return arr[a] + (arr[b] - arr[a]) * u;
  }

  offsetAt(lineId, t) { return this._lerpArray(this.offset[lineId], t); }

  speedAt(lineId, t) { return this._lerpArray(this.speed[lineId], t); }

  curvatureAt(lineId, t) { return this._lerpArray(this.curvature[lineId], t); }

  /** d(offset)/d(arc length) on `lineId`, dimensionless. */
  offsetSlopeAt(lineId, t) { return this._lerpArray(this.slope[lineId], t); }

  limitAt(t) { return this._lerpArray(this.raceLimit, t); }

  brakeDistanceAt(t) { return this._lerpArray(this.brakeDistance, t); }

  phaseAt(lineId, t) { return this.phase[lineId][this.indexAt(t)]; }

  /** Sign of the next corner within 400 m: +1 turns left, -1 turns right, 0 straight. */
  turnSignAt(t) { return this.turnSign[this.indexAt(t)]; }

  /**
   * World point on `lineId` at `t`, displaced laterally by `extra` metres and clamped
   * to the drivable corridor so an avoidance nudge can never aim a car into the gravel.
   */
  pointAt(lineId, t, extra, out) {
    const n = this.count;
    const f = wrap01(t) * n;
    let a = Math.floor(f);
    const u = f - a;
    a %= n;
    const b = a === n - 1 ? 0 : a + 1;

    const base = this.offset[lineId][a] + (this.offset[lineId][b] - this.offset[lineId][a]) * u;
    const limit = this.raceLimit[a] + (this.raceLimit[b] - this.raceLimit[a]) * u;
    const o = clamp(base + extra, -limit, limit);

    const x = this.cx[a] + (this.cx[b] - this.cx[a]) * u;
    const y = this.cy[a] + (this.cy[b] - this.cy[a]) * u;
    const z = this.cz[a] + (this.cz[b] - this.cz[a]) * u;
    let rxv = this.rx[a] + (this.rx[b] - this.rx[a]) * u;
    let rzv = this.rz[a] + (this.rz[b] - this.rz[a]) * u;
    const l = Math.hypot(rxv, rzv) || 1;
    rxv /= l; rzv /= l;
    const bank = this.tanBank[a] + (this.tanBank[b] - this.tanBank[a]) * u;
    return out.set(x + rxv * o, y - o * bank, z + rzv * o);
  }

  /** The lateral offset `lineId` would use at `t`, already clamped to the corridor. */
  clampedOffsetAt(lineId, t, extra) {
    const base = this.offsetAt(lineId, t);
    const limit = this.limitAt(t);
    return clamp(base + extra, -limit, limit);
  }

  /**
   * Target speed for a car that is `lateral` metres from the centreline rather than on
   * `lineId`. Being off line costs corner speed because the geometry is worse; on a
   * straight it costs nothing.
   */
  speedForLateral(lineId, t, lateral) {
    const base = this.speedAt(lineId, t);
    const k = Math.abs(this.curvatureAt(lineId, t));
    if (k < CURVATURE_CORNER) return base;
    // A car that is not on its line is on a worse radius than the one the profile was
    // solved for, so it has to take less speed into the corner — and, just as usefully,
    // giving up that speed is what buys back the grip to get back on line.
    const err = Math.abs(lateral - this.offsetAt(lineId, t));
    const u = clamp01(err / 4.5);
    return base * (1 - 0.17 * u * u);
  }

  dispose() {
    this.cx = null; this.cy = null; this.cz = null;
    this.rx = null; this.rz = null;
    this.offset = null; this.speed = null; this.curvature = null;
    this.phase = null; this.slope = null;
    this._relaxX = null; this._relaxZ = null; this._curveBlur = null; this._altTarget = null;
    _cache.delete(this.track);
  }
}
