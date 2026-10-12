import { clamp, clamp01 } from "../core/MathUtils.js";
import { TYRE_COMPOUNDS } from "./CarConfig.js";
const BAND_COUNT = 3;
const PATCH_FILL = 0.78;
const SURFACE_MAX = 260;
const CORE_MAX = 220;
const MAX_DEFLECTION = 0.055;
function magicSin(B, C, D, E, x) {
  const Bx = B * x;
  const e = E > 0.999 ? 0.999 : E < -3 ? -3 : E;
  return D * Math.sin(C * Math.atan(Bx - e * (Bx - Math.atan(Bx))));
}
function peakSlip(B, C) {
  if (B <= 1e-6) return 1;
  return Math.tan(Math.PI / (2 * C)) / B;
}
export class Tyre {
  constructor(spec, compoundName, side, tyresCfg) {
    this.spec = spec;
    this.mf = spec.mf;
    this.side = side >= 0 ? 1 : -1;
    this.tyresCfg = tyresCfg;
    this.compound = TYRE_COMPOUNDS[compoundName] ?? TYRE_COMPOUNDS.medium;
    this.kappa = 0;
    this.alpha = 0;
    this.slipRatio = 0;
    this.slipAngle = 0;
    this.slipSpeedX = 0;
    this.slipSpeedY = 0;
    this.fx = 0;
    this.fy = 0;
    this.mz = 0;
    this.trail = 0;
    this.load = 0;
    this.loadedRadius = spec.radius;
    this.deflection = 0;
    this.deflectRate = 0;
    this.bandTemp = new Float64Array(BAND_COUNT);
    this.bandWear = new Float64Array(BAND_COUNT);
    this.bandShare = new Float64Array(BAND_COUNT);
    this.bandGrip = new Float64Array(BAND_COUNT);
    this.coreTemp = 80;
    this.surfaceTemp = 80;
    this.wear = 0;
    this.gripFactor = 1;
    this.tempFactor = 1;
    this.wearFactor = 1;
    this.slipPower = 0;
    this.peakSlipRatio = 0.12;
    this.peakSlipAngle = 0.14;
    this.saturation = 0;
    this.reset(tyresCfg?.startTemp ?? 90, 0);
  }
  setCompound(name) {
    const c = TYRE_COMPOUNDS[name];
    if (c) this.compound = c;
  }
  reset(temp = 90, wear = 0) {
    this.kappa = 0;
    this.alpha = 0;
    this.slipRatio = 0;
    this.slipAngle = 0;
    this.slipSpeedX = 0;
    this.slipSpeedY = 0;
    this.fx = 0;
    this.fy = 0;
    this.mz = 0;
    this.load = 0;
    this.wear = wear;
    this.coreTemp = temp;
    this.surfaceTemp = temp;
    this.slipPower = 0;
    this.saturation = 0;
    for (let i = 0; i < BAND_COUNT; i++) {
      this.bandTemp[i] = temp;
      this.bandWear[i] = wear;
      this.bandShare[i] = 1 / BAND_COUNT;
      this.bandGrip[i] = 1;
    }
    this.loadedRadius = this.spec.radius;
    this.deflection = 0;
    this.deflectRate = 0;
    this.tempFactor = 1;
    this.wearFactor = 1;
    this.gripFactor = 1;
  }
  integrateSlip(dt, vx, vy, omega, contact) {
    const spec = this.spec;
    const r = this.loadedRadius;
    const rollSpeed = omega * r;
    const absVx = Math.abs(vx);
    const denom = absVx + spec.lowSpeedFloor;
    if (!contact) {
      const decay = Math.exp(-dt * 14);
      this.kappa *= decay;
      this.alpha *= decay;
      this.slipRatio = this.kappa;
      this.slipAngle = this.alpha;
      this.slipSpeedX = 0;
      this.slipSpeedY = 0;
      return;
    }
    const ak = dt * denom / spec.relaxLong;
    this.kappa = (this.kappa + dt / spec.relaxLong * (rollSpeed - vx)) / (1 + ak);
    this.kappa = clamp(this.kappa, -2.5, 2.5);
    const aa = dt * denom / spec.relaxLat;
    const tanTarget = -vy;
    let tanAlpha = Math.tan(this.alpha);
    tanAlpha = (tanAlpha + dt / spec.relaxLat * tanTarget) / (1 + aa);
    tanAlpha = clamp(tanAlpha, -6, 6);
    this.alpha = Math.atan(tanAlpha);
    this.slipRatio = this.kappa;
    this.slipAngle = this.alpha;
    this.slipSpeedX = rollSpeed - vx;
    this.slipSpeedY = vy;
  }
  solve(fz, gamma, surfaceGrip) {
    const mf = this.mf;
    this.load = fz;
    if (fz <= 1) {
      this.fx = 0;
      this.fy = 0;
      this.mz = 0;
      this.trail = 0;
      this.saturation = 0;
      return;
    }
    const dfz = (fz - mf.FZ0) / mf.FZ0;
    const g = clamp(gamma, -0.35, 0.35);
    const g2 = g * g;
    const mu = this._gripMultiplier() * surfaceGrip;
    const Cx = mf.PCX1;
    const Dx = Math.max(1, (mf.PDX1 + mf.PDX2 * dfz) * (1 - mf.PDX3 * g2) * mu * fz);
    const Kx = fz * (mf.PKX1 + mf.PKX2 * dfz) * Math.exp(mf.PKX3 * dfz);
    const Bx = Kx / (Cx * Dx);
    const Cy = mf.PCY1;
    const Dy = Math.max(1, (mf.PDY1 + mf.PDY2 * dfz) * (1 - mf.PDY3 * g2) * mu * fz);
    const Ky = mf.PKY1 * mf.FZ0 * Math.sin(2 * Math.atan(fz / (mf.PKY2 * mf.FZ0))) * (1 - mf.PKY3 * Math.abs(g));
    const By = Ky / (Cy * Dy);
    const kPeak = clamp(peakSlip(Bx, Cx), 0.025, 0.45);
    const aPeak = clamp(peakSlip(By, Cy), 0.02, 0.5);
    this.peakSlipRatio = kPeak;
    this.peakSlipAngle = aPeak;
    const SHx = mf.PHX1;
    const SHy = mf.PHY1 + mf.PHY3 * g;
    const SVy = fz * (mf.PVY1 + (mf.PVY3 + mf.PVY4 * dfz) * g) * mu;
    const kx = this.kappa + SHx;
    const ay = this.alpha + SHy;
    const nk = kx / kPeak;
    const na = ay / aPeak;
    let rho = Math.sqrt(nk * nk + na * na);
    if (rho < 1e-7) rho = 1e-7;
    this.saturation = clamp01(rho);
    const combK = rho * kPeak;
    const combA = rho * aPeak;
    const sgnK = kx >= 0 ? 1 : -1;
    const sgnA = ay >= 0 ? 1 : -1;
    const Ex = (mf.PEX1 + mf.PEX2 * dfz + mf.PEX3 * dfz * dfz) * (1 - mf.PEX4 * sgnK);
    const Ey = (mf.PEY1 + mf.PEY2 * dfz) * (1 - (mf.PEY3 + mf.PEY4 * g) * sgnA);
    const fxMag = magicSin(Bx, Cx, Dx, Ex, combK);
    const fyMag = magicSin(By, Cy, Dy, Ey, combA);
    const latShare = Math.min(1, Math.abs(na) / rho);
    this.fx = nk / rho * fxMag;
    this.fy = na / rho * fyMag + SVy * latShare;
    this._alignMoment(fz, dfz, g, mu, By, Cy, Dy, Ey);
  }
  _alignMoment(fz, dfz, g, mu, By, Cy, Dy, Ey) {
    const mf = this.mf;
    const R0 = this.spec.radius;
    const alphaT = this.alpha + mf.QHZ1 + mf.QHZ3 * g;
    const Bt = Math.max(0.5, (mf.QBZ1 + mf.QBZ2 * dfz) * (1 + mf.QBZ10 * Math.abs(g)));
    const Ct = mf.QCZ1;
    const Dt = fz * (mf.QDZ1 + mf.QDZ2 * dfz) * (1 + mf.QDZ3 * Math.abs(g) + mf.QDZ4 * g * g) * (R0 / mf.FZ0);
    let Et = (mf.QEZ1 + mf.QEZ2 * dfz) * (1 + mf.QEZ5 * g * (2 / Math.PI) * Math.atan(Bt * Ct * alphaT));
    if (Et > 0.98) Et = 0.98;
    const BtA = Bt * alphaT;
    const t = Dt * Math.cos(Ct * Math.atan(BtA - Et * (BtA - Math.atan(BtA)))) * Math.cos(this.alpha);
    this.trail = t;
    const Br = mf.QBZ9;
    const Dr = fz * (mf.QDZ6 + mf.QDZ8 * g) * R0 * mu;
    const Mzr = Dr * Math.cos(Math.atan(Br * alphaT));
    this.mz = -t * this.fy + Mzr;
  }
  _gripMultiplier() {
    return this.compound.gripScale * this.tempFactor * this.wearFactor;
  }
  thermal(dt, airSpeed, ambient, trackTemp, brakeTemp, gamma) {
    const spec = this.spec;
    const comp = this.compound;
    const v = Math.abs(airSpeed);
    const px = Math.abs(this.fx * this.slipSpeedX);
    const py = Math.abs(this.fy * this.slipSpeedY);
    const friction = px + py;
    this.slipPower = friction;
    const slide = Math.sqrt(
      this.slipSpeedX * this.slipSpeedX + this.slipSpeedY * this.slipSpeedY
    );
    const partition = spec.roadHeatPartition / Math.sqrt(1 + slide / spec.slideRenewalSpeed);
    const intoTyre = friction * partition * comp.heatRate;
    const bottomOut = spec.verticalStiffness * MAX_DEFLECTION;
    const flexLoad = this.load > bottomOut ? bottomOut : this.load;
    const rollPower = spec.rollingHysteresis * flexLoad * v;
    const toSurface = intoTyre * spec.surfaceHeatFraction + rollPower * spec.hysteresisTreadShare;
    const toCore = intoTyre * (1 - spec.surfaceHeatFraction) + rollPower * (1 - spec.hysteresisTreadShare);
    const tilt = clamp(-gamma * this.side * 5.5, -0.85, 0.85);
    let wSum = 0;
    for (let i = 0; i < BAND_COUNT; i++) {
      const pos = i - 1;
      const w = Math.max(0.08, 1 - pos * tilt);
      this.bandShare[i] = w;
      wSum += w;
    }
    const invW = 1 / wSum;
    const conv = (spec.convectionBase + spec.convectionPerSpeed * v) * comp.coolRate;
    const patchHalf = Math.sqrt(Math.max(0, 2 * spec.radius * this.deflection));
    const road = this.load > 1 ? spec.roadConductance * 2 * patchHalf * spec.width * PATCH_FILL : 0;
    const bandCap = spec.surfaceHeatCapacity / BAND_COUNT;
    let tempSum = 0;
    let wearSum = 0;
    let gripSum = 0;
    for (let i = 0; i < BAND_COUNT; i++) {
      const share = this.bandShare[i] * invW;
      let ts = this.bandTemp[i];
      const qIn = toSurface * share;
      const qCond = spec.conductionSurfaceCore * (ts - this.coreTemp) / BAND_COUNT;
      const qConv = conv * (ts - ambient) / BAND_COUNT;
      const qRoad = road * (ts - trackTemp) / BAND_COUNT;
      ts += dt * (qIn - qCond - qConv - qRoad) / bandCap;
      ts = clamp(ts, -20, SURFACE_MAX);
      this.bandTemp[i] = ts;
      const overheat = 1 + clamp01((ts - (comp.optimumTemp + comp.windowHot)) / 60) * 2.4;
      const bandSlipEnergy = friction * share * dt;
      let w = this.bandWear[i] + bandSlipEnergy * this.tyresCfg.wearPerJoule * comp.wearRate * overheat;
      w = clamp01(w);
      this.bandWear[i] = w;
      this.bandGrip[i] = this._tempGrip(ts, w);
      tempSum += ts * share;
      wearSum += w * share;
      gripSum += this.bandGrip[i] * share;
    }
    this.surfaceTemp = tempSum;
    this.wear = wearSum;
    let qc = 0;
    for (let i = 0; i < BAND_COUNT; i++) {
      qc += spec.conductionSurfaceCore * (this.bandTemp[i] - this.coreTemp) / BAND_COUNT;
    }
    qc += toCore;
    qc += spec.brakeToCore * (brakeTemp - this.coreTemp);
    qc -= spec.coreToAmbient * comp.coolRate * (this.coreTemp - ambient) * (1 + 0.03 * v);
    this.coreTemp = clamp(this.coreTemp + dt * qc / spec.coreHeatCapacity, -20, CORE_MAX);
    const blended = 0.68 * gripSum + 0.32 * this._tempGrip(this.coreTemp, this.wear);
    this.tempFactor = clamp(blended, 0.35, 1.06);
    this.wearFactor = clamp(1 - comp.peakLossPerWear * Math.pow(this.wear, 1.25), 0.5, 1);
    this.gripFactor = this.tempFactor * this.wearFactor * comp.gripScale;
  }
  _tempGrip(temp, wear) {
    const comp = this.compound;
    const opt = comp.optimumTemp + comp.optimumRisePerWear * wear;
    const d = temp - opt;
    if (d < 0) {
      const x2 = d / comp.windowCold;
      return comp.coldGrip + (1 - comp.coldGrip) * Math.exp(-x2 * x2 * 0.85);
    }
    const x = d / comp.windowHot;
    return comp.hotGrip + (1 - comp.hotGrip) * Math.exp(-x * x * 0.85);
  }
  updateLoadedRadius(fz, omega) {
    const spec = this.spec;
    const defl = clamp(fz / spec.verticalStiffness, 0, MAX_DEFLECTION);
    const growth = spec.radialGrowth * omega * omega * spec.radius;
    this.deflection = defl;
    this.loadedRadius = spec.radius + Math.min(growth, 0.012) - defl;
    return this.loadedRadius;
  }
}
export { magicSin, peakSlip, BAND_COUNT };
