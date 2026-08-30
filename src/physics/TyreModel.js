/**
 * Pacejka MF-96 tyre with transient slip, load sensitivity, combined-slip friction
 * ellipse, camber thrust, self-aligning moment, a tread/carcass/road thermal model
 * across three tread bands, and slip-energy wear.
 *
 * Sign conventions (all in the wheel/contact frame):
 *   +x  forward along the wheel heading
 *   +y  to the right of the wheel heading
 *   kappa = (omega * R - Vx) / |Vx|      positive under drive, negative under braking
 *   alpha = atan(-Vy / |Vx|)             positive when the tyre is slipping to the left
 *   gamma = inclination angle, positive when the wheel top leans toward world +X
 *   Fx > 0 accelerates, Fy > 0 pushes the car to its right.
 *
 * The transient slip states are integrated with a semi-implicit relaxation-length ODE
 * and a velocity floor in the denominator. That single change removes the classic
 * kappa = 0/0 singularity: at a standstill the states behave as carcass deflections and
 * produce a genuine holding force, so the car sits still on a hill instead of buzzing.
 */

import { clamp, clamp01 } from '../core/MathUtils.js';
import { TYRE_COMPOUNDS } from './CarConfig.js';

const BAND_COUNT = 3; // inner shoulder, centre, outer shoulder

/**
 * Fraction of the bounding rectangle of the contact patch that is actually rubber on
 * road. A slick's patch is a rounded rectangle, not a rectangle, and the tread grooves
 * and shoulder radius take the rest.
 */
const PATCH_FILL = 0.78;

/**
 * Hard envelope on the tread and carcass nodes. These are numerical guards, not the
 * working model: tread rubber reverts and blisters through the 200s and a carcass that
 * reached 220 C has delaminated, so anything touching these limits is a destroyed tyre.
 * With the road partition and the patch conduction below in place the model no longer
 * lives on its clamp: the worst case the game can produce — four seconds of a fully
 * locked wheel at 270 km/h on 3.5 kN of load — settles at 180 C of tread and 99 C of
 * carcass, where the old model pinned the tread at its 340 C limit inside one second.
 */
const SURFACE_MAX = 260;
const CORE_MAX = 220;

/**
 * Carcass deflection at which the tyre is bottomed out: 55 mm of squash on a 360 mm
 * radius puts the rim on the road. Past this point the excess load goes through the rim
 * rather than through rubber, the contact patch cannot grow any further, and the tread
 * cannot flex any further either — so both the patch area and the hysteretic loss per
 * revolution saturate here. `updateLoadedRadius` and the thermal model share the number
 * so the heat the tyre makes and the heat it can lose stop growing at the same load.
 */
const MAX_DEFLECTION = 0.055;

/** Evaluate the MF sine form. `E` is clamped because E > 1 makes the curve non-monotonic. */
function magicSin(B, C, D, E, x) {
  const Bx = B * x;
  const e = E > 0.999 ? 0.999 : E < -3 ? -3 : E;
  return D * Math.sin(C * Math.atan(Bx - e * (Bx - Math.atan(Bx))));
}

/** Slip at which a magic-formula curve peaks, ignoring the curvature factor. */
function peakSlip(B, C) {
  if (B <= 1e-6) return 1;
  return Math.tan(Math.PI / (2 * C)) / B;
}

export class Tyre {
  /**
   * @param {object} spec  cfg.tyres.front or cfg.tyres.rear
   * @param {string} compoundName
   * @param {number} side  +1 for a right-hand wheel, -1 for a left-hand wheel
   * @param {object} tyresCfg  cfg.tyres (for wear rate and ambient conditions)
   */
  constructor(spec, compoundName, side, tyresCfg) {
    this.spec = spec;
    this.mf = spec.mf;
    this.side = side >= 0 ? 1 : -1;
    this.tyresCfg = tyresCfg;
    this.compound = TYRE_COMPOUNDS[compoundName] ?? TYRE_COMPOUNDS.medium;

    // Transient slip states (carcass deflection expressed as slip).
    this.kappa = 0;
    this.alpha = 0;

    // Reported slip (identical to the states, kept separate for clarity of intent).
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

  /**
   * Advance the relaxation-length slip states.
   * @param {number} vx contact-patch longitudinal velocity, m/s
   * @param {number} vy contact-patch lateral velocity, m/s
   * @param {number} omega wheel spin rate, rad/s, positive when rolling forward
   * @param {boolean} contact
   */
  integrateSlip(dt, vx, vy, omega, contact) {
    const spec = this.spec;
    const r = this.loadedRadius;
    const rollSpeed = omega * r;
    const absVx = Math.abs(vx);
    const denom = absVx + spec.lowSpeedFloor;

    if (!contact) {
      // In the air the carcass unwinds toward zero over the relaxation length.
      const decay = Math.exp(-dt * 14);
      this.kappa *= decay;
      this.alpha *= decay;
      this.slipRatio = this.kappa;
      this.slipAngle = this.alpha;
      this.slipSpeedX = 0;
      this.slipSpeedY = 0;
      return;
    }

    // sigma * d(kappa)/dt + (|Vx| + floor) * kappa = (omega*R - Vx), solved implicitly.
    const ak = dt * denom / spec.relaxLong;
    this.kappa = (this.kappa + (dt / spec.relaxLong) * (rollSpeed - vx)) / (1 + ak);
    this.kappa = clamp(this.kappa, -2.5, 2.5);

    // Lateral uses tan(alpha) as the deflection variable; -Vy so that sliding right
    // gives a negative slip angle and therefore a leftward restoring force.
    const aa = dt * denom / spec.relaxLat;
    const tanTarget = -vy;
    let tanAlpha = Math.tan(this.alpha);
    tanAlpha = (tanAlpha + (dt / spec.relaxLat) * tanTarget) / (1 + aa);
    tanAlpha = clamp(tanAlpha, -6, 6);
    this.alpha = Math.atan(tanAlpha);

    this.slipRatio = this.kappa;
    this.slipAngle = this.alpha;
    this.slipSpeedX = rollSpeed - vx;
    this.slipSpeedY = vy;
  }

  /**
   * Solve tyre forces for the current slip state.
   * @param {number} fz vertical load, N (>= 0)
   * @param {number} gamma inclination angle, rad
   * @param {number} surfaceGrip surface multiplier from Track.surfaceAt
   */
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

    // Longitudinal pure-slip parameters.
    const Cx = mf.PCX1;
    const Dx = Math.max(1, (mf.PDX1 + mf.PDX2 * dfz) * (1 - mf.PDX3 * g2) * mu * fz);
    const Kx = fz * (mf.PKX1 + mf.PKX2 * dfz) * Math.exp(mf.PKX3 * dfz);
    const Bx = Kx / (Cx * Dx);

    // Lateral pure-slip parameters. Ky saturates with load, which is why cornering
    // stiffness per newton falls on the loaded outside tyre.
    const Cy = mf.PCY1;
    const Dy = Math.max(1, (mf.PDY1 + mf.PDY2 * dfz) * (1 - mf.PDY3 * g2) * mu * fz);
    const Ky = mf.PKY1 * mf.FZ0 * Math.sin(2 * Math.atan(fz / (mf.PKY2 * mf.FZ0)))
      * (1 - mf.PKY3 * Math.abs(g));
    const By = Ky / (Cy * Dy);

    const kPeak = clamp(peakSlip(Bx, Cx), 0.025, 0.45);
    const aPeak = clamp(peakSlip(By, Cy), 0.020, 0.50);
    this.peakSlipRatio = kPeak;
    this.peakSlipAngle = aPeak;

    // Horizontal shifts. PHY3 carries the camber thrust into the slip-angle axis.
    const SHx = mf.PHX1;
    const SHy = mf.PHY1 + mf.PHY3 * g;
    const SVy = fz * (mf.PVY1 + (mf.PVY3 + mf.PVY4 * dfz) * g) * mu;

    const kx = this.kappa + SHx;
    const ay = this.alpha + SHy;

    // Similarity-method combined slip: normalise both slips by their peak, evaluate the
    // pure curves at the combined magnitude, and project. The force locus is then an
    // ellipse with semi-axes Dx and Dy, so braking really does cost you cornering.
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
    this.fx = (nk / rho) * fxMag;
    this.fy = (na / rho) * fyMag + SVy * latShare;

    this._alignMoment(fz, dfz, g, mu, By, Cy, Dy, Ey);
  }

  /** Pneumatic trail and residual torque, giving the Mz the steering feedback uses. */
  _alignMoment(fz, dfz, g, mu, By, Cy, Dy, Ey) {
    const mf = this.mf;
    const R0 = this.spec.radius;
    const alphaT = this.alpha + mf.QHZ1 + mf.QHZ3 * g;

    const Bt = Math.max(0.5, (mf.QBZ1 + mf.QBZ2 * dfz) * (1 + mf.QBZ10 * Math.abs(g)));
    const Ct = mf.QCZ1;
    const Dt = fz * (mf.QDZ1 + mf.QDZ2 * dfz)
      * (1 + mf.QDZ3 * Math.abs(g) + mf.QDZ4 * g * g) * (R0 / mf.FZ0);
    let Et = (mf.QEZ1 + mf.QEZ2 * dfz)
      * (1 + mf.QEZ5 * g * (2 / Math.PI) * Math.atan(Bt * Ct * alphaT));
    if (Et > 0.98) Et = 0.98;

    const BtA = Bt * alphaT;
    const t = Dt * Math.cos(Ct * Math.atan(BtA - Et * (BtA - Math.atan(BtA))))
      * Math.cos(this.alpha);
    this.trail = t;

    // Residual torque: the camber and conicity couple that survives past peak slip.
    const Br = mf.QBZ9;
    const Dr = fz * (mf.QDZ6 + mf.QDZ8 * g) * R0 * mu;
    const Mzr = Dr * Math.cos(Math.atan(Br * alphaT));

    // The trail acts on the lateral force actually generated, not the pure-slip one, so
    // the wheel goes light in the driver's hands exactly when the front tyre saturates.
    this.mz = -t * this.fy + Mzr;
  }

  /** Combined temperature, wear and compound multiplier on peak friction. */
  _gripMultiplier() {
    return this.compound.gripScale * this.tempFactor * this.wearFactor;
  }

  /**
   * Thermal and wear update. Call after `solve` so the slip power is current.
   *
   * Three lumped nodes and one boundary: the tread ring split across `BAND_COUNT` bands,
   * the carcass core, and the road the patch is pressed against. Every heat term below
   * is a function of load, sliding speed, airspeed and disc temperature and of nothing
   * else. `this.side` appears exactly once, in the band tilt, and it cancels there:
   * static camber flips sign across the car, so `gamma * side` is the same number on
   * both sides and the band weights come out identical. Two tyres given the same load
   * and the same slip therefore return the same temperature to the last bit — verified
   * at 0.000000 K of split over six seconds of symmetric braking.
   *
   * @param {number} airSpeed m/s of airflow over the tyre
   * @param {number} ambient celsius of the free air
   * @param {number} trackTemp celsius of the road surface
   * @param {number} brakeTemp celsius of the disc, conducted through the rim
   * @param {number} gamma inclination angle, rad
   */
  thermal(dt, airSpeed, ambient, trackTemp, brakeTemp, gamma) {
    const spec = this.spec;
    const comp = this.compound;
    const v = Math.abs(airSpeed);

    // Frictional work done in the contact patch, longitudinal and lateral. Both terms
    // are |force x sliding speed|, so both are even in the sign of the slip.
    const px = Math.abs(this.fx * this.slipSpeedX);
    const py = Math.abs(this.fy * this.slipSpeedY);
    const friction = px + py;
    this.slipPower = friction;

    /*
     * Interface partition, Jaeger's moving-heat-source form.
     *
     * Two bodies rubbing together divide the frictional work in the ratio of their
     * thermal effusivities sqrt(k*rho*c) — about 740 W s^0.5 m^-2 K^-1 for tread rubber
     * against about 1590 for asphalt — which is where `roadHeatPartition` comes from.
     * That ratio only holds while the two surfaces are effectively at rest against each
     * other. Once the patch slides, the road under it is renewed at the sliding speed and
     * its effective conductance rises with the square root of the Peclet number, so the
     * road takes a steadily larger share and the tyre a smaller one. `slideRenewalSpeed`
     * is the sliding speed at which the road's share has doubled.
     *
     * This is the term that separates a tyre working hard from a tyre being destroyed.
     * At the 3-5 m/s of patch slide a loaded tyre runs at through a corner the partition
     * is within a per cent of the static 0.33, so cornering and traction heat exactly as
     * measured. At the 75 m/s of a fully locked wheel it falls to 0.11, which is what
     * gives a lock-up a finite equilibrium — 170 C rather than the 340 C clamp the model
     * used to sit on, or the 105 C a flat partition plus a heavy tread node gave it.
     */
    const slide = Math.sqrt(
      this.slipSpeedX * this.slipSpeedX + this.slipSpeedY * this.slipSpeedY);
    const partition = spec.roadHeatPartition
      / Math.sqrt(1 + slide / spec.slideRenewalSpeed);
    const intoTyre = friction * partition * comp.heatRate;

    /*
     * Hysteresis. The tread blocks and the carcass are each strained once per revolution
     * and neither returns all of that energy, which is the heat that keeps a tyre alive
     * down a straight where there is no slip to speak of.
     *
     * The load that does the flexing is the load the carcass is still absorbing. Past
     * MAX_DEFLECTION the rim is carrying the excess and the rubber cannot deform any
     * further, so the loss per revolution stops rising with load — which is also where
     * the patch conduction below stops rising, because it is the same clamp.
     *
     * This bound is not decoration. The capture rail in src/game/Scenarios.js teleports
     * the body onto a pose the suspension cannot satisfy and hands this model wheel
     * loads of 52 kN and 86 kN in the `apex` scenario; unclamped, 86 kN of rolling
     * hysteresis alone is 70 kW into the tread, which is where the 235 C the panel saw
     * on the round-5 apex frame came from.
     */
    const bottomOut = spec.verticalStiffness * MAX_DEFLECTION;
    const flexLoad = this.load > bottomOut ? bottomOut : this.load;
    const rollPower = spec.rollingHysteresis * flexLoad * v;

    const toSurface = intoTyre * spec.surfaceHeatFraction
      + rollPower * spec.hysteresisTreadShare;
    const toCore = intoTyre * (1 - spec.surfaceHeatFraction)
      + rollPower * (1 - spec.hysteresisTreadShare);

    // Camber tilts the contact patch load distribution across the three tread bands;
    // the loaded shoulder does more work, runs hotter and wears out first. Static camber
    // is negative on both sides of the car and `gamma` therefore already carries the
    // sign of the side, so multiplying by `side` cancels it: the inner shoulder is the
    // loaded one on the left and on the right, and the weights come out identical.
    const tilt = clamp(-gamma * this.side * 5.5, -0.85, 0.85);
    let wSum = 0;
    for (let i = 0; i < BAND_COUNT; i++) {
      const pos = i - 1; // -1 inner, 0 centre, +1 outer
      const w = Math.max(0.08, 1 - pos * tilt);
      this.bandShare[i] = w;
      wSum += w;
    }
    const invW = 1 / wSum;

    const conv = (spec.convectionBase + spec.convectionPerSpeed * v) * comp.coolRate;

    /*
     * Contact-patch conduction into the road. The patch half-length is the chord of a
     * circle of radius R cut at the carcass deflection, so a tyre pressed harder into
     * the road both makes more heat and has more area to lose it through. The road is a
     * moving semi-infinite sink held at track temperature: below that the patch warms a
     * cold tread, above it the patch is the single largest cooling path the tyre has,
     * and it is the term that gives a sliding tyre a finite equilibrium at all.
     */
    const patchHalf = Math.sqrt(Math.max(0, 2 * spec.radius * this.deflection));
    const road = this.load > 1
      ? spec.roadConductance * 2 * patchHalf * spec.width * PATCH_FILL
      : 0;

    const bandCap = spec.surfaceHeatCapacity / BAND_COUNT;
    let tempSum = 0;
    let wearSum = 0;
    let gripSum = 0;

    for (let i = 0; i < BAND_COUNT; i++) {
      const share = this.bandShare[i] * invW;
      let ts = this.bandTemp[i];

      // The band takes its share of the work but always has the same third of the tread
      // mass, area and patch to spread it into.
      const qIn = toSurface * share;
      const qCond = spec.conductionSurfaceCore * (ts - this.coreTemp) / BAND_COUNT;
      const qConv = conv * (ts - ambient) / BAND_COUNT;
      const qRoad = road * (ts - trackTemp) / BAND_COUNT;

      ts += dt * (qIn - qCond - qConv - qRoad) / bandCap;
      ts = clamp(ts, -20, SURFACE_MAX);
      this.bandTemp[i] = ts;

      // Wear tracks slip energy in that band, accelerated once the rubber is overheated.
      const overheat = 1 + clamp01((ts - (comp.optimumTemp + comp.windowHot)) / 60) * 2.4;
      const bandSlipEnergy = friction * share * dt;
      let w = this.bandWear[i]
        + bandSlipEnergy * this.tyresCfg.wearPerJoule * comp.wearRate * overheat;
      w = clamp01(w);
      this.bandWear[i] = w;

      this.bandGrip[i] = this._tempGrip(ts, w);

      tempSum += ts * share;
      wearSum += w * share;
      gripSum += this.bandGrip[i] * share;
    }

    this.surfaceTemp = tempSum;
    this.wear = wearSum;

    // Core: fed by the tread, the carcass hysteresis and the brake disc; bled to air.
    let qc = 0;
    for (let i = 0; i < BAND_COUNT; i++) {
      qc += spec.conductionSurfaceCore * (this.bandTemp[i] - this.coreTemp) / BAND_COUNT;
    }
    qc += toCore;
    qc += spec.brakeToCore * (brakeTemp - this.coreTemp);
    qc -= spec.coreToAmbient * comp.coolRate * (this.coreTemp - ambient)
      * (1 + 0.03 * v);
    this.coreTemp = clamp(this.coreTemp + dt * qc / spec.coreHeatCapacity, -20, CORE_MAX);

    // Grip reported to the solver blends the tread surface (which reacts in corners)
    // with the carcass (which sets the long-run behaviour of the stint).
    const blended = 0.68 * gripSum + 0.32 * this._tempGrip(this.coreTemp, this.wear);
    this.tempFactor = clamp(blended, 0.35, 1.06);
    this.wearFactor = clamp(1 - comp.peakLossPerWear * Math.pow(this.wear, 1.25), 0.5, 1);
    this.gripFactor = this.tempFactor * this.wearFactor * comp.gripScale;
  }

  /** Bell-shaped working window, asymmetric because overheating hurts more than cold. */
  _tempGrip(temp, wear) {
    const comp = this.compound;
    const opt = comp.optimumTemp + comp.optimumRisePerWear * wear;
    const d = temp - opt;
    if (d < 0) {
      const x = d / comp.windowCold;
      return comp.coldGrip + (1 - comp.coldGrip) * Math.exp(-x * x * 0.85);
    }
    const x = d / comp.windowHot;
    return comp.hotGrip + (1 - comp.hotGrip) * Math.exp(-x * x * 0.85);
  }

  /**
   * Rolling radius under load. The carcass squashes with vertical load and grows again
   * with centrifugal force, which is why an F1 tyre is a different size on the straight
   * than it is in the pit lane. The suspension already accounts for the carcass as a
   * series spring, so this radius only drives the rolling speed and the torque arm.
   */
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
