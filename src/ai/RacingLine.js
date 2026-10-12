import * as THREE from "three";
import { clamp, clamp01, smoothstep, wrap01, sign, G } from "../core/MathUtils.js";
export const LINE_RACE = 0;
export const LINE_DEFEND = 1;
export const LINE_LEFT = 2;
export const LINE_RIGHT = 3;
export const LINE_COUNT = 4;
export const PHASE_STRAIGHT = 0;
export const PHASE_BRAKE = 1;
export const PHASE_CORNER = 2;
export const PHASE_EXIT = 3;
const SPACING = 3;
const RACE_MARGIN = 1.55;
const ALT_MARGIN = 1.9;
const ATTACK_OFFSET = 2.35;
const DEFEND_OFFSET = 1.7;
const COARSE_STRIDE = 4;
const COARSE_ITERATIONS = 460;
const FINE_ITERATIONS = 160;
const ALT_ITERATIONS = 120;
const CORNER_MARGIN = 0.9;
const BRAKE_MARGIN = 0.9;
const TRACTION_MARGIN = 0.94;
const TEMPERATURE_FACTOR = 0.97;
const OFFLINE_GRIP = 0.965;
const SPEED_TABLE_MAX = 125;
const CURVATURE_CORNER = 35e-4;
const LOOK_FOR_TURN = 400;
const BIG_DISTANCE = 9999;
const _sampleOut = {
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
const _cache = new WeakMap();
export function getRacingLine(track, config) {
  let line = _cache.get(track);
  if (!line) {
    line = new RacingLine(track, config);
    _cache.set(track, line);
  }
  return line;
}
export class RacingLine {
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
  _buildAeroTable(config) {
    const a = config.aero;
    const susp = config.suspension;
    const N = SPEED_TABLE_MAX + 1;
    this.downforce = new Float32Array(N);
    this.dragForce = new Float32Array(N);
    this.aeroBalance = new Float32Array(N);
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
        rh = clamp(a.referenceRideHeightFront - df * balance / frontRate, floorHeight, a.referenceRideHeightFront);
      }
      const df10 = df / 1e4;
      const cdA = Math.max(0.35, a.cdA + a.inducedDrag * df10 * df10);
      this.downforce[v] = df;
      this.dragForce[v] = q * cdA;
      this.aeroBalance[v] = balance;
    }
  }
  _buildGripTables(config) {
    const N = SPEED_TABLE_MAX + 1;
    const c = config.chassis;
    const t = config.tyres;
    const mass = c.mass;
    const weight = mass * G;
    const wf = c.frontWeightFraction;
    const trackAvg = (c.trackFront + c.trackRear) * 0.5;
    const rollShareFront = config.suspension.front.antiRoll / Math.max(1, config.suspension.front.antiRoll + config.suspension.rear.antiRoll);
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
    const brakeForceCap = config.brakes.maxTorqueTotal / (0.5 * (t.front.radius + t.rear.radius));
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
      let aLat = 0;
      for (let iter = 0; iter < 2; iter++) {
        const transfer = mass * aLat * c.cgHeight / trackAvg;
        const df_f = Math.min(nf * 0.5, transfer * rollShareFront);
        const df_r = Math.min(nr * 0.5, transfer * (1 - rollShareFront));
        const fy = this._axleForce(nf, dyf, dyf2, fz0f, df_f) + this._axleForce(nr, dyr, dyr2, fz0r, df_r);
        aLat = fy * surfaceScale * CORNER_MARGIN / mass;
      }
      this.latAccel[v] = aLat;
      const fxF = this._axleForce(nf, dxf, dxf2, fz0f, 0);
      const fxR = this._axleForce(nr, dxr, dxr2, fz0r, 0);
      const tyreBrake = Math.min((fxF + fxR) * surfaceScale, brakeForceCap);
      const dragDecel = this.dragForce[v] / mass;
      const rollDecel = c.rollingResistance * (weight + df) / mass;
      this.coastDecel[v] = dragDecel + rollDecel;
      this.brakeAccel[v] = tyreBrake * BRAKE_MARGIN / mass + this.coastDecel[v];
      const muR = this._axleMu(nr, dxr, dxr2, fz0r) * surfaceScale;
      const squat = 1 - muR * c.cgHeight / c.wheelbase;
      const gripAccel = squat > 0.15 ? muR * nr / mass / squat : muR * nr / mass;
      const powerAccel = v > 1 ? power / (mass * v) : 1e4;
      this.driveAccel[v] = Math.min(gripAccel, powerAccel) * TRACTION_MARGIN - this.coastDecel[v];
    }
    this.vMax = SPEED_TABLE_MAX;
    for (let v = 30; v <= SPEED_TABLE_MAX; v++) {
      if (this.driveAccel[v] <= 0) {
        this.vMax = v;
        break;
      }
    }
  }
  _axleMu(n, pd1, pd2, fz0) {
    const perWheel = Math.max(1, n * 0.5);
    return Math.max(0.4, pd1 + pd2 * ((perWheel - fz0) / fz0));
  }
  _axleForce(n, pd1, pd2, fz0, transfer) {
    const perWheel = Math.max(1, n * 0.5);
    const d = Math.min(transfer, perWheel);
    const outer = perWheel + d;
    const inner = perWheel - d;
    const muO = Math.max(0.4, pd1 + pd2 * ((outer - fz0) / fz0));
    const muI = Math.max(0.4, pd1 + pd2 * ((inner - fz0) / fz0));
    return muO * outer + muI * inner;
  }
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
  _relax(offset, limit, cx, cz, rx, rz, m, iterations, omega) {
    const px = this._relaxX && this._relaxX.length >= m ? this._relaxX : this._relaxX = new Float32Array(m);
    const pz = this._relaxZ && this._relaxZ.length >= m ? this._relaxZ : this._relaxZ = new Float32Array(m);
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
      const kappa = this.baseCurvature[i];
      coff[k] = clamp(-sign(kappa) * clim[k] * clamp01(Math.abs(kappa) * 90), -clim[k], clim[k]);
    }
    this._relax(coff, clim, ccx, ccz, crx, crz, m, COARSE_ITERATIONS, 0.55);
    const off = this.offset[LINE_RACE];
    for (let i = 0; i < n; i++) {
      const f = i / stride % m;
      const a = Math.floor(f) % m;
      const b = (a + 1) % m;
      const u = f - Math.floor(f);
      off[i] = clamp(coff[a] + (coff[b] - coff[a]) * u, -this.raceLimit[i], this.raceLimit[i]);
    }
    this._relax(off, this.raceLimit, this.cx, this.cz, this.rx, this.rz, n, FINE_ITERATIONS, 0.42);
  }
  _deriveAlternates() {
    const n = this.count;
    const race = this.offset[LINE_RACE];
    const target = this._altTarget || (this._altTarget = new Float32Array(n));
    for (let l = 1; l < LINE_COUNT; l++) {
      const off = this.offset[l];
      for (let i = 0; i < n; i++) {
        let want;
        if (l === LINE_DEFEND) {
          const inside = -this.turnSign[i];
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
  _relaxToward(offset, target, limit, iterations, omega, pull) {
    const n = this.count;
    const cx = this.cx;
    const cz = this.cz;
    const rx = this.rx;
    const rz = this.rz;
    const px = this._relaxX && this._relaxX.length >= n ? this._relaxX : this._relaxX = new Float32Array(n);
    const pz = this._relaxZ && this._relaxZ.length >= n ? this._relaxZ : this._relaxZ = new Float32Array(n);
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
      const kappa = denom > 1e-6 ? 2 * cross / denom : 0;
      out[i] = -kappa;
    }
    const tmp = this._curveBlur && this._curveBlur.length >= n ? this._curveBlur : this._curveBlur = new Float32Array(n);
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < n; i++) {
        const a = i === 0 ? n - 1 : i - 1;
        const b = i === n - 1 ? 0 : i + 1;
        tmp[i] = (out[a] + out[i] * 2 + out[b]) * 0.25;
      }
      out.set(tmp.subarray(0, n));
    }
  }
  _offsetSlope(offset, out) {
    const n = this.count;
    const inv = 1 / (2 * this.spacing);
    for (let i = 0; i < n; i++) {
      const a = i === 0 ? n - 1 : i - 1;
      const b = i === n - 1 ? 0 : i + 1;
      out[i] = (offset[b] - offset[a]) * inv;
    }
  }
  _lookup(table, v) {
    if (!(v > 0)) return table[0];
    if (v >= SPEED_TABLE_MAX) return table[SPEED_TABLE_MAX];
    const i = v | 0;
    const f = v - i;
    return table[i] + (table[i + 1] - table[i]) * f;
  }
  latAccelAt(v) {
    return this._lookup(this.latAccel, v);
  }
  brakeAccelAt(v) {
    return this._lookup(this.brakeAccel, v);
  }
  driveAccelAt(v) {
    return this._lookup(this.driveAccel, v);
  }
  coastDecelAt(v) {
    return this._lookup(this.coastDecel, v);
  }
  _cornerSpeed(kappa, banking, gripScale) {
    const k = Math.abs(kappa);
    if (k < 1e-5) return this.vMax;
    const bankAssist = Math.max(0, Math.sin(Math.abs(banking))) * G;
    let v = Math.sqrt(this.latAccel[0] * gripScale / k);
    for (let iter = 0; iter < 4; iter++) {
      const cap = this._lookup(this.latAccel, v) * gripScale + bankAssist;
      v = Math.sqrt(cap / k);
      if (v > this.vMax) {
        v = this.vMax;
        break;
      }
    }
    return Math.min(v, this.vMax);
  }
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
      const latUse = clamp01(vNext * vNext * Math.abs(kappa[j]) / Math.max(1, this._lookup(this.latAccel, vNext) * gripScale));
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
      const latUse = clamp01(vPrev * vPrev * Math.abs(kappa[p]) / Math.max(1, this._lookup(this.latAccel, vPrev) * gripScale));
      const share = Math.sqrt(Math.max(0.04, 1 - latUse * latUse));
      const slope = Math.sin(this.gradient[p]);
      const a = this._lookup(this.driveAccel, vPrev) * share * gripScale - G * slope;
      if (a <= 0) continue;
      const allowed = Math.sqrt(Math.max(0, vPrev * vPrev + 2 * a * ds));
      if (allowed < speed[i]) speed[i] = allowed;
    }
  }
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
        if (Math.abs(kappa[i]) > CURVATURE_CORNER) {
          s = sign(kappa[i]);
          td = 0;
        } else td += ds;
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
  offsetAt(lineId, t) {
    return this._lerpArray(this.offset[lineId], t);
  }
  speedAt(lineId, t) {
    return this._lerpArray(this.speed[lineId], t);
  }
  curvatureAt(lineId, t) {
    return this._lerpArray(this.curvature[lineId], t);
  }
  offsetSlopeAt(lineId, t) {
    return this._lerpArray(this.slope[lineId], t);
  }
  limitAt(t) {
    return this._lerpArray(this.raceLimit, t);
  }
  brakeDistanceAt(t) {
    return this._lerpArray(this.brakeDistance, t);
  }
  phaseAt(lineId, t) {
    return this.phase[lineId][this.indexAt(t)];
  }
  turnSignAt(t) {
    return this.turnSign[this.indexAt(t)];
  }
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
    rxv /= l;
    rzv /= l;
    const bank = this.tanBank[a] + (this.tanBank[b] - this.tanBank[a]) * u;
    return out.set(x + rxv * o, y - o * bank, z + rzv * o);
  }
  clampedOffsetAt(lineId, t, extra) {
    const base = this.offsetAt(lineId, t);
    const limit = this.limitAt(t);
    return clamp(base + extra, -limit, limit);
  }
  speedForLateral(lineId, t, lateral) {
    const base = this.speedAt(lineId, t);
    const k = Math.abs(this.curvatureAt(lineId, t));
    if (k < CURVATURE_CORNER) return base;
    const err = Math.abs(lateral - this.offsetAt(lineId, t));
    const u = clamp01(err / 4.5);
    return base * (1 - 0.17 * u * u);
  }
  dispose() {
    this.cx = null;
    this.cy = null;
    this.cz = null;
    this.rx = null;
    this.rz = null;
    this.offset = null;
    this.speed = null;
    this.curvature = null;
    this.phase = null;
    this.slope = null;
    this._relaxX = null;
    this._relaxZ = null;
    this._curveBlur = null;
    this._altTarget = null;
    _cache.delete(this.track);
  }
}
