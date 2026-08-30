/**
 * Physical parameters for a 2026-regulation Formula 1 car.
 *
 * Every number here is a real engineering quantity, not a tuning knob invented to make
 * the handling feel nice. Where a value is a compromise (damper knees, ground-effect
 * stall thresholds) the comment says what real behaviour it is reproducing.
 *
 * Frames: car local is -Z forward, +X right, +Y up, origin at the centre of gravity.
 * Wheel order is always [FL, FR, RL, RR].
 */

import { DEG, G } from '../core/MathUtils.js';

export const AIR_DENSITY = 1.2041; // kg/m^3, ISA at 20 C and sea level

/**
 * Pacejka MF-96 style coefficient sets. Shape factors are per-construction; the peak
 * friction terms carry the load sensitivity that makes weight transfer matter
 * (PD*2 is negative, so mu falls as the normalised load dfz rises).
 */
const FRONT_TYRE_MF = {
  FZ0: 3600,        // N, nominal wheel load the coefficients are normalised to
  // Longitudinal
  PCX1: 1.62,
  PDX1: 1.95, PDX2: -0.20, PDX3: 0.9,
  PEX1: 0.16, PEX2: -0.30, PEX3: 0.0, PEX4: 0.05,
  PKX1: 44.0, PKX2: -2.1, PKX3: -0.12,
  PHX1: 0.0, PVX1: 0.0,
  // Lateral
  PCY1: 1.44,
  PDY1: 1.90, PDY2: -0.18, PDY3: 3.6,
  PEY1: -0.62, PEY2: -0.10, PEY3: 0.06, PEY4: -3.5,
  PKY1: 55.0, PKY2: 2.15, PKY3: 1.15,
  PHY1: 0.0, PHY3: 0.028,
  PVY1: 0.0, PVY3: -0.20, PVY4: -0.12,
  // Self-aligning moment (pneumatic trail + residual torque)
  QBZ1: 9.4, QBZ2: -0.9, QBZ9: 12.0, QBZ10: 0.6,
  QCZ1: 1.18,
  QDZ1: 0.098, QDZ2: -0.010, QDZ3: -0.30, QDZ4: 3.0,
  QDZ6: 0.0, QDZ8: -0.10,
  QEZ1: -1.6, QEZ2: 0.2, QEZ5: -1.4,
  QHZ1: 0.0, QHZ3: 0.02,
};

const REAR_TYRE_MF = {
  FZ0: 4400,
  PCX1: 1.60,
  PDX1: 1.99, PDX2: -0.18, PDX3: 0.8,
  PEX1: 0.14, PEX2: -0.28, PEX3: 0.0, PEX4: 0.05,
  PKX1: 42.0, PKX2: -2.0, PKX3: -0.11,
  PHX1: 0.0, PVX1: 0.0,
  PCY1: 1.42,
  PDY1: 1.95, PDY2: -0.165, PDY3: 3.2,
  PEY1: -0.58, PEY2: -0.09, PEY3: 0.05, PEY4: -3.2,
  PKY1: 52.0, PKY2: 2.30, PKY3: 1.05,
  PHY1: 0.0, PHY3: 0.024,
  PVY1: 0.0, PVY3: -0.17, PVY4: -0.10,
  QBZ1: 8.9, QBZ2: -0.85, QBZ9: 11.0, QBZ10: 0.6,
  QCZ1: 1.16,
  QDZ1: 0.104, QDZ2: -0.011, QDZ3: -0.28, QDZ4: 2.6,
  QDZ6: 0.0, QDZ8: -0.09,
  QEZ1: -1.5, QEZ2: 0.2, QEZ5: -1.2,
  QHZ1: 0.0, QHZ3: 0.018,
};

/**
 * Pirelli-style dry compounds. `gripScale` multiplies peak mu, `optimumTemp` is the
 * centre of the working window measured on the blended (surface/core) temperature.
 * Softer compounds make more grip, work colder, and shed rubber far faster.
 */
export const TYRE_COMPOUNDS = {
  soft: {
    name: 'soft',
    code: 'C4',
    gripScale: 1.035,
    optimumTemp: 98,
    windowCold: 28,      // K half-width on the cold side of the window
    windowHot: 24,       // K half-width on the hot side — overheating hurts sooner
    coldGrip: 0.72,      // grip multiplier far below the window
    hotGrip: 0.68,       // grip multiplier far above the window
    wearRate: 1.85,
    heatRate: 1.14,      // builds temperature faster (softer, more hysteresis)
    coolRate: 0.96,
    peakLossPerWear: 0.26,
    optimumRisePerWear: 11,
  },
  medium: {
    name: 'medium',
    code: 'C3',
    gripScale: 1.0,
    optimumTemp: 108,
    windowCold: 32,
    windowHot: 28,
    coldGrip: 0.70,
    hotGrip: 0.72,
    wearRate: 1.0,
    heatRate: 1.0,
    coolRate: 1.0,
    peakLossPerWear: 0.21,
    optimumRisePerWear: 9,
  },
  hard: {
    name: 'hard',
    code: 'C2',
    gripScale: 0.962,
    optimumTemp: 117,
    windowCold: 36,
    windowHot: 32,
    coldGrip: 0.66,
    hotGrip: 0.76,
    wearRate: 0.60,
    heatRate: 0.86,
    coolRate: 1.05,
    peakLossPerWear: 0.16,
    optimumRisePerWear: 7,
  },
};

/**
 * ICE torque at full boost, before the fuel-flow clamp. 1.6 L V6 turbo running to a
 * 15 000 rpm limiter: ~500 Nm plateau around 10 500 rpm, ~575 kW peak power near
 * 11 500 rpm, then falling as the 100 kg/h fuel flow limit and valve train bite.
 */
const TORQUE_CURVE = [
  [0, 0],
  [2500, 190],
  [3500, 250],
  [4000, 290],
  [5000, 335],
  [6000, 380],
  [7000, 420],
  [8000, 455],
  [9000, 480],
  [10000, 495],
  [10500, 500],
  [11000, 492],
  [11500, 478],
  [12000, 440],
  [13000, 400],
  [14000, 355],
  [15000, 305],
  [15600, 0],
];

/**
 * Deep clone that keeps arrays as arrays. Configs are plain data, so this is enough and
 * avoids dragging in a dependency. Runs once at construction, never in `step`.
 */
function cloneDeep(value) {
  if (Array.isArray(value)) return value.map(cloneDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = cloneDeep(value[key]);
    return out;
  }
  return value;
}

function mergeDeep(base, patch) {
  if (!patch) return base;
  for (const key of Object.keys(patch)) {
    const pv = patch[key];
    if (pv && typeof pv === 'object' && !Array.isArray(pv) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      mergeDeep(base[key], pv);
    } else {
      base[key] = cloneDeep(pv);
    }
  }
  return base;
}

const WHEELBASE = 3.600;
const TRACK_FRONT = 2.000;
const TRACK_REAR = 1.960;   // rear track is regulated slightly narrower than the front
const MASS = 798;           // kg, minimum weight including driver and fuel-empty
const FRONT_WEIGHT_FRACTION = 0.46;
const CG_HEIGHT = 0.280;

// Distance from the CG to each axle follows from the static weight split.
const CG_TO_FRONT = WHEELBASE * (1 - FRONT_WEIGHT_FRACTION);
const CG_TO_REAR = WHEELBASE * FRONT_WEIGHT_FRACTION;

const UNSPRUNG_FRONT = 26;  // kg per corner: wheel, tyre, upright, disc, caliper
const UNSPRUNG_REAR = 32;

const SPRUNG_MASS = MASS - 2 * UNSPRUNG_FRONT - 2 * UNSPRUNG_REAR;
const SPRUNG_FRONT_CORNER = (SPRUNG_MASS * FRONT_WEIGHT_FRACTION) / 2;
const SPRUNG_REAR_CORNER = (SPRUNG_MASS * (1 - FRONT_WEIGHT_FRACTION)) / 2;

const BASE_CONFIG = {
  name: 'APEX-26',
  team: 'apex',

  chassis: {
    mass: MASS,
    /**
     * Inertia about the CG in car-local axes. X is lateral (pitch), Y is vertical (yaw),
     * Z is longitudinal (roll). Radii of gyration: ~1.10 m pitch, ~1.15 m yaw, 0.39 m roll.
     */
    inertia: { x: 965, y: 1055, z: 121 },
    wheelbase: WHEELBASE,
    trackFront: TRACK_FRONT,
    trackRear: TRACK_REAR,
    cgHeight: CG_HEIGHT,
    cgToFront: CG_TO_FRONT,
    cgToRear: CG_TO_REAR,
    frontWeightFraction: FRONT_WEIGHT_FRACTION,
    sprungMass: SPRUNG_MASS,
    unsprungFront: UNSPRUNG_FRONT,
    unsprungRear: UNSPRUNG_REAR,
    // Body extents used for barrier probes and floor-strike tests.
    length: 5.63,
    width: 2.00,
    height: 0.95,
    noseOffset: 2.62,       // metres ahead of the CG (-Z) to the nose tip
    tailOffset: 3.01,       // metres behind the CG (+Z) to the rear-wing trailing edge
    floorHalfWidth: 0.75,
    rollingResistance: 0.0125,
  },

  steering: {
    maxRoadWheelAngle: 21 * DEG,
    ratio: 11.5,            // steering wheel : road wheel
    wheelRangeDeg: 240,     // total lock to lock at the rim
    ackermann: 0.12,        // F1 runs close to parallel steer, a touch of Ackermann
    rackSpeed: 7.5,         // rad/s at the road wheel, limits how fast input can slew
    selfCentreGain: 0.0,    // the Mz feedback does the centring, not an artificial spring
  },

  suspension: {
    // Wheel-centre positions at design ride height, relative to the CG.
    frontMountX: TRACK_FRONT / 2,
    rearMountX: TRACK_REAR / 2,
    // Damper-side rates; wheel rate = rate * motionRatio^2.
    /**
     * Rates are quoted at the damper; the wheel rate is rate * motionRatio^2 and the tyre
     * carcass then sits in series with it, which is why the numbers look so large. The
     * resulting ride rates are ~235 N/mm front and ~208 N/mm rear: 6.2 Hz and 5.3 Hz on
     * the sprung corner masses, which is where a ground-effect car has to live to keep
     * the floor working.
     */
    front: {
      springRate: 620000,   // N/m at the damper (480 N/mm at the wheel)
      motionRatio: 0.880,
      bumpLow: 14500, bumpHigh: 7400, bumpKnee: 0.055,
      reboundLow: 25000, reboundHigh: 11000, reboundKnee: 0.045,
      bumpStopGap: 0.018,
      bumpStopRate: 3.2e6,
      droopStopGap: 0.026,
      droopStopRate: 2.2e6,
      maxBump: 0.038,
      maxDroop: 0.032,
      staticCamber: -3.4 * DEG,
      camberGain: -1.05,    // rad per metre of bump travel (-0.060 deg/mm)
      staticToe: -0.10 * DEG, // negative = toe-out at the front
      toeGain: 0.28,
      antiRoll: 190000,     // N/m of differential wheel travel
      antiDive: 0.18,
      staticLoad: SPRUNG_FRONT_CORNER * G,
      rideHeight: 0.040,
    },
    rear: {
      springRate: 416000,   // 360 N/mm at the wheel
      motionRatio: 0.930,
      bumpLow: 10400, bumpHigh: 5400, bumpKnee: 0.055,
      reboundLow: 17600, reboundHigh: 8000, reboundKnee: 0.045,
      bumpStopGap: 0.024,
      bumpStopRate: 2.6e6,
      droopStopGap: 0.030,
      droopStopRate: 1.9e6,
      maxBump: 0.042,
      maxDroop: 0.036,
      staticCamber: -1.8 * DEG,
      camberGain: -0.85,
      staticToe: 0.22 * DEG,  // positive = toe-in at the rear, for straight-line stability
      toeGain: 0.20,
      antiRoll: 95000,
      antiSquat: 0.22,
      staticLoad: SPRUNG_REAR_CORNER * G,
      rideHeight: 0.085,
    },
    rayLift: 0.060,         // how far above the design wheel centre the contact ray starts
  },

  tyres: {
    compound: 'medium',
    front: {
      radius: 0.360,        // 720 mm outer diameter
      width: 0.305,
      rimRadius: 0.1651,    // 13 inch
      inertia: 1.12,        // kg m^2, wheel + tyre + disc
      verticalStiffness: 460000,
      verticalDamping: 3200,
      radialGrowth: 3.3e-7,  // rad^-2 s^2: centrifugal growth, ~8 mm at 260 rad/s
      relaxLong: 0.28,
      relaxLat: 0.42,
      lowSpeedFloor: 0.85,  // m/s added to |Vx| in the relaxation denominator
      mf: FRONT_TYRE_MF,
      mass: 11.5,
      /**
       * Thermal nodes. The tread node is the layer that actually swings across a corner,
       * not the whole tread depth. Rubber's diffusivity is k/(rho*c) = 0.25/(1150*1900)
       * = 1.14e-7 m^2/s, so the heat put in over a 3-4 s corner penetrates
       * sqrt(alpha*t) ~ 0.7 mm before the corner is over. That is the ring this node
       * models: 2*pi*0.360 * 0.305 m * 0.0010 m * 1150 kg/m^3 = 0.80 kg at 1900 J/kgK,
       * so 1520 J/K, giving a 6 s time constant against the ~250 W/K of sink below.
       *
       * The 4500 J/K this was set to is a 3 mm ring — the depth that equilibrates over a
       * whole lap, not over a corner. With that mass the node was an 18 s low-pass on
       * everything: the outside front of a car pulling 3.6 g with 6.8 kN on it came back
       * 1.3 K hotter than the inside front on 2.0 kN, and a four-wheel lock-up at
       * 270 km/h moved the reading by 15 K in three seconds. Both of those are visible
       * on the tyre widget as "nothing is happening".
       */
      surfaceHeatCapacity: 1520,  // J/K of the thermally active tread ring
      coreHeatCapacity: 15200,    // J/K of the carcass and contained air
      /** Tread bonded to the belt: k*A/L with k = 0.25 W/mK over ~1.2 mm of rubber. */
      conductionSurfaceCore: 150, // W/K
      /**
       * Forced convection over the tread ring. Nu = 0.076 Re^0.7 for a cylinder in
       * crossflow gives h ~ 115 W/m^2K at 300 km/h over the 0.69 m^2 of exposed ring,
       * i.e. about 65 W/K — not the 318 W/K the old 3.5 W/K per m/s asked for, which
       * refrigerated a front tyre down a straight.
       */
      convectionBase: 11,         // W/K at rest
      convectionPerSpeed: 0.52,   // W/K per m/s of airflow
      coreToAmbient: 11,          // W/K
      brakeToCore: 4.2,           // W/K from the disc through the rim
      /**
       * W/m^2K between tread rubber and asphalt across the contact patch. Contact
       * conductance across a dry rubber-on-asphalt interface is set by how much of the
       * nominal area is really touching; 750 W/m^2K puts the patch at ~35 W/K on a
       * lightly loaded front and ~55 W/K on a fully loaded one, which is the same order
       * as the convection over the rest of the ring rather than twice it.
       */
      roadConductance: 750,
      /**
       * Share of contact-patch friction work that heats the tyre rather than the road at
       * rest, from the effusivity ratio sqrt(k rho c)_rubber / (rubber + asphalt) =
       * 739/2332 = 0.317, carried up to 0.40 because TyreModel now divides it by
       * sqrt(1 + slide/slideRenewalSpeed): at the 3-5 m/s of slide a working tyre lives
       * at, 0.40 / sqrt(1 + 4/8) = 0.327, so the operating point is unchanged and only
       * the runaway case is bounded.
       */
      roadHeatPartition: 0.40,
      /** Sliding speed at which the road's share of the friction work has doubled. */
      slideRenewalSpeed: 8.0,     // m/s
      /** Rolling loss coefficient: fraction of Fz*|v| dissipated as heat in the tyre. */
      rollingHysteresis: 0.0155,
      /** Split of that loss between the tread ring and the carcass. */
      hysteresisTreadShare: 0.55,
      /** Split of the frictional share between the tread ring and the carcass. */
      surfaceHeatFraction: 0.80,
    },
    rear: {
      radius: 0.3625,       // 725 mm outer diameter
      width: 0.405,
      rimRadius: 0.1651,
      inertia: 1.58,
      verticalStiffness: 490000,
      verticalDamping: 3500,
      radialGrowth: 3.1e-7,
      relaxLong: 0.31,
      relaxLat: 0.46,
      lowSpeedFloor: 0.85,
      mf: REAR_TYRE_MF,
      mass: 14.2,
      /** Same 1.0 mm active ring on the wider rear: 2*pi*0.3625 * 0.405 * 0.001 * 1150
       *  = 1.06 kg at 1900 J/kgK. */
      surfaceHeatCapacity: 2020,
      coreHeatCapacity: 18600,
      conductionSurfaceCore: 178,
      convectionBase: 12,
      convectionPerSpeed: 0.60,
      coreToAmbient: 12,
      brakeToCore: 4.6,
      roadConductance: 750,
      roadHeatPartition: 0.40,
      slideRenewalSpeed: 8.0,
      rollingHysteresis: 0.0165,
      hysteresisTreadShare: 0.55,
      surfaceHeatFraction: 0.80,
    },
    // Slip energy to wear. Calibrated so a hard-driven lap costs ~4 % of a soft tyre.
    wearPerJoule: 8.2e-8,
    startTemp: 90,          // blankets are gone in 2026 but the out-lap is not modelled
    ambientTemp: 26,
    trackTemp: 38,
  },

  aero: {
    airDensity: AIR_DENSITY,
    /**
     * FREE-AIR ClA and CdA. The ground-effect multiplier below is applied on top, so at
     * a working front ride height of ~25 mm the car makes about 5.5 m^2 of effective ClA
     * — roughly 2.3 t of downforce at 300 km/h. CdA rises with the square of the load
     * being made, which is what stops the car simply gearing its way to 400 km/h.
     */
    clA: 3.40,
    cdA: 1.08,
    /** Induced drag: extra CdA per (downforce/10 kN)^2, the price of a loaded floor. */
    inducedDrag: 0.032,
    frontBalance: 0.445,    // fraction of downforce carried by the front axle at reference
    /** Balance migrates rearward with speed as the front wing tips down and stalls. */
    balanceSpeedShift: 0.022,   // per (v/100 m/s)^2
    balanceRideHeightGain: 1.9, // per metre of front ride-height change
    balanceMin: 0.30, balanceMax: 0.55,

    referenceRideHeightFront: 0.040,
    referenceRideHeightRear: 0.085,

    /** Ground effect: the venturi floor gains hard as it approaches the road ... */
    groundEffectGain: 0.62,
    groundEffectOnset: 0.100,   // m — above this the floor is working in free air
    groundEffectPeak: 0.022,    // m — maximum suction
    /** ... and stalls when the edge seals and the diffuser chokes. */
    stallHeight: 0.0095,
    stallRecoverHeight: 0.0190,
    stallDepth: 0.46,           // fraction of ground-effect gain lost when fully stalled
    /** Roll kills the floor edge seal on the unloaded side. */
    rollStallAngle: 0.022,
    rollStallFull: 0.058,
    rollStallDepth: 0.34,
    /** Yaw spills the floor. */
    yawStallAngle: 0.10,
    yawStallDepth: 0.30,
    /** Aero lag: the pressure field cannot follow the platform instantly. This lag is
     *  what turns the stall into porpoising rather than a static loss. */
    responseTime: 0.042,
    /** Heave rate feedback. Positive means rising = more load, which damps the bounce. */
    heaveDamping: 0.55,

    dragCentreHeight: 0.31,     // m above the ground, sets the drag pitch couple
    sideForceArea: 1.05,        // CyA for crosswind / big yaw angles
    sideCentreOffset: -0.28,    // m ahead of the CG, so yaw is mildly destabilising

    drs: {
      dragDelta: 0.312,         // CdA reduction: ~1300 N at 300 km/h
      rearDownforceLoss: 0.255, // fraction of rear downforce given up
      openTime: 0.28,
      closeTime: 0.12,
      minSpeed: 27.0,           // m/s below which the flap will not open
    },

    wake: {
      length: 12.0,             // e-folding distance of the dirty air, metres
      frontLoss: 0.42,
      rearLoss: 0.24,
      dragLoss: 0.30,           // slipstream: less drag as well as less downforce
      lateralWidth: 2.6,        // metres of offset before the wake stops biting
    },

    damage: {
      frontLossPerUnit: 0.55,
      rearLossPerUnit: 0.40,
      floorLossPerUnit: 0.35,
      dragGainPerUnit: 0.30,
    },
  },

  engine: {
    displacement: 1.6,
    torqueCurve: TORQUE_CURVE,
    idleRpm: 4200,
    limiterRpm: 15000,
    limiterCutTime: 0.045,
    limiterRecoverRpm: 14550,
    inertia: 0.135,            // kg m^2 of crank, clutch and primary gears
    frictionBase: 12,          // Nm of pumping/friction at idle
    frictionPerRpm: 0.0042,    // Nm per rpm
    engineBrakeGain: 0.0085,   // Nm per rpm of closed-throttle retardation
    fuelFlowMax: 100 / 3600,   // kg/s — the 100 kg/h regulation
    fuelLHV: 43.0e6,           // J/kg
    thermalEfficiency: 0.51,   // race-spec F1 hybrids are just over 50 % BTE
    startFuel: 104,            // kg
    boost: {
      maxPressureRatio: 3.45,  // absolute, wastegate limited
      thresholdRpm: 3000,      // below this the turbine cannot make useful boost
      fullSpoolRpm: 7000,
      spoolTimeCold: 0.80,     // s time constant with no exhaust energy
      spoolTimeHot: 0.105,     // s time constant on full exhaust energy
      decayTime: 0.19,         // s, wastegate + blow-off dump
      mguhSpoolTime: 0.050,    // s when the MGU-H is spinning the compressor
      mguhFloor: 0.48,         // boost fraction the MGU-H alone can hold at low rpm
      torqueAtZeroBoost: 0.30, // fraction of full-boost torque with the turbo asleep
    },
  },

  transmission: {
    /**
     * Eight forward ratios plus a 3.90 final drive. Overall ratios run 15.65 : 1 in
     * first to 5.91 : 1 in eighth, which puts the limiter at 131 km/h in first and
     * 347 km/h in eighth on 725 mm rear tyres.
     */
    finalDrive: 3.90,
    gears: [4.013, 3.326, 2.811, 2.434, 2.145, 1.911, 1.718, 1.515],
    reverse: 3.20,
    efficiency: 0.955,
    shiftTime: 0.040,          // s of torque cut — seamless shift barrels
    downshiftTime: 0.055,
    shiftInhibit: 0.06,        // s before another shift is accepted
    upshiftRpm: 14700,         // auto-upshift point when the assist is on
    downshiftRpm: 9600,
    clutchTorqueCapacity: 950, // Nm
    clutchEngageTime: 0.55,    // s from launch to fully locked
    differential: {
      preload: 65,             // Nm
      powerRamp: 0.42,         // locking torque per Nm of drive torque
      coastRamp: 0.26,
      viscous: 62,             // Nm per rad/s of cross-axle speed difference
      maxLock: 2600,           // Nm the ramps and plates can physically hold
    },
  },

  brakes: {
    /** Total axle-pair torque at maximum pedal, split by bias. 21 kNm gives ~5.9 g of
     *  retardation with the car fully loaded aerodynamically. */
    maxTorqueTotal: 21000,
    bias: 0.600,
    biasMin: 0.50, biasMax: 0.68,
    pedalGamma: 1.22,          // pedal travel to pressure — F1 pedals are very progressive
    discRadiusFront: 0.132,
    discRadiusRear: 0.128,
    /**
     * A current front disc is 330 mm across and 32 mm thick — the 0.132 m effective
     * friction radius above. As a solid carbon-carbon annulus at 1800 kg/m^3 that is
     * 3.1 kg, but the internal vanes and the ~1200 radial cooling holes take about half
     * of it, so the disc actually bolted to the upright is ~1.5 kg. The mass is what
     * sets the value of a stop in kelvin: at 1470 J/K the ~480 kJ each front disc takes
     * from 340 km/h is +325 K, which is the swing a real disc makes across a braking
     * zone. At the old 2950 J/K — a solid iron GT rotor — it was half that, and no stop
     * on the lap could carry a disc out of the warm-up band.
     *
     * The rear disc is the smaller 280 mm part, not a second 330 mm one: the same 32 mm
     * of thickness over a 25 mm smaller radius and the same vane and drilling fraction
     * comes out at ~1.05 kg. Carrying a front-sized 1.30 kg on the rear axle, which only
     * ever sees 40 % of the pedal minus whatever the MGU-K has already harvested, left
     * the rear discs 240 K cooler than they should be over a stint.
     */
    discMassFront: 1.55, discMassRear: 1.05,
    discHeatCapacity: 950,     // J/kgK for carbon-carbon at working temperature
    /**
     * Duct cooling. The lap-average brake power at Spa comes out near 30 kW per front
     * disc, and a disc holding the 400-600 C working band while rejecting that can only
     * have 80-90 W/K of conductance to give. The old 3.4 W/K per m/s was 212 W/K at
     * racing speed, which pinned every disc within a hundred kelvin of ambient and left
     * the disc glow and the brake-dust effects with nothing to trigger on.
     */
    coolingBase: 12,           // W/K static
    coolingPerSpeed: 1.25,     // W/K per m/s
    coldTemp: 350,             // below this carbon does not bite properly
    optimumTemp: 650,
    fadeTemp: 1050,            // above this the torque starts falling away
    /**
     * Carbon-carbon bite below the working window. 0.66 was too deep a hole and it is
     * self-reinforcing: a cold disc makes less torque, less torque makes less heat, and
     * the disc never leaves the cold band. Measured over a 260 s race stint that trap is
     * what held the rear discs at a 218 C average while the fronts averaged 461 C. Real
     * carbon at 300 C is down on its hot mu but not by a third, and 0.78 lets the rear
     * axle climb out under its own braking.
     */
    coldTorqueFactor: 0.78,
    fadeTorqueFactor: 0.72,
    /**
     * Soak temperature of the disc inside the wheel: the floor it is initialised to,
     * and the sink its cooling term runs down to. This is not free-stream air. A disc
     * lives in a duct fed by air that has already crossed the brake assembly, inside a
     * rim, between a caliper and an upright that are themselves hot; a car rolled out
     * of the garage reads about 100 C on the discs and never sees 26 C again once the
     * session has started.
     */
    ambient: 100,
    abs: 0,                    // 0..1 assist level, set from Settings by the car
  },

  /** Driving assists, mirrored from Settings by whoever owns the car. 0 = off. */
  assists: {
    tractionControl: 0,        // 0..1, cuts throttle on rear slip
    tcSlipTarget: 0.16,        // slip ratio the assist aims to hold
  },

  ers: {
    storeCapacity: 4.0e6,      // J usable in the energy store
    deployPowerMax: 120000,    // W, MGU-K
    harvestPowerMax: 120000,   // W, MGU-K under braking
    deployPerLap: 4.0e6,       // J
    harvestKPerLap: 2.0e6,     // J — the regulation cap on MGU-K recovery
    mguhPowerMax: 32000,       // W recovered off the turbine
    mguhToStore: 0.88,         // conversion efficiency into the store
    startCharge: 0.85,
    deployTaper: 0.90,         // deploy stops taking effect near the limiter
    modes: [
      { name: 'off',      deploy: 0.00, harvest: 1.15 },
      { name: 'balanced', deploy: 0.55, harvest: 1.00 },
      { name: 'attack',   deploy: 0.85, harvest: 0.85 },
      { name: 'overtake', deploy: 1.00, harvest: 0.70 },
    ],
    defaultMode: 1,
  },

  pitLimiter: {
    speed: 80 / 3.6,           // 80 km/h
    gain: 1.6,
  },

  damage: {
    /** Normal impulse (N s) below which a contact is a scrape, not an impact. */
    impactThreshold: 900,
    /** Impulse (N s) that fully destroys a section. */
    frontImpulse: 26000,
    rearImpulse: 30000,
    floorImpulse: 42000,
    /** Bottoming out at speed grinds the plank away. */
    floorScrapePerJoule: 4.5e-7,
    restitution: 0.28,
    friction: 0.55,
  },
};

/**
 * Per-team setup and philosophy. These are deliberately small deltas: in F1 the cars
 * are within a couple of per cent of each other and the character comes from balance,
 * not from one team having twice the grip.
 */
export const TEAM_SETUPS = {
  apex: { label: 'Apex Racing', patch: {} },

  vermilion: {
    label: 'Vermilion',
    // Big rear stability, softest front, strong high-speed floor.
    patch: {
      aero: { clA: 3.47, cdA: 1.11, frontBalance: 0.432, groundEffectGain: 0.66 },
      suspension: { front: { springRate: 596000, antiRoll: 172000 }, rear: { antiRoll: 106000 } },
      transmission: { differential: { powerRamp: 0.46 } },
    },
  },

  argent: {
    label: 'Argent Motorsport',
    // Low drag, pointy front, nervous rear on entry.
    patch: {
      aero: { clA: 3.30, cdA: 1.02, frontBalance: 0.462, balanceSpeedShift: 0.026 },
      suspension: { front: { staticCamber: -3.7 * DEG, antiRoll: 206000 }, rear: { antiRoll: 83000 } },
      brakes: { bias: 0.612 },
    },
  },

  scuderia: {
    label: 'Scuderia Rossa',
    // Power biased, high rake, strong traction out of slow corners.
    patch: {
      aero: { clA: 3.37, cdA: 1.06, referenceRideHeightRear: 0.093 },
      engine: { boost: { spoolTimeHot: 0.100 } },
      suspension: { rear: { springRate: 434000, staticToe: 0.28 * DEG } },
      transmission: { differential: { preload: 78, coastRamp: 0.30 } },
    },
  },

  meridian: {
    label: 'Meridian GP',
    // Kind to its tyres, softer platform, less peak but flatter degradation.
    patch: {
      aero: { clA: 3.34, cdA: 1.07 },
      suspension: {
        front: { springRate: 600000, bumpLow: 13400 },
        rear: { springRate: 402000, bumpLow: 9700 },
      },
      tyres: { wearPerJoule: 7.1e-8 },
    },
  },

  kestrel: {
    label: 'Kestrel',
    // Aggressive floor, closest to the ground, most prone to porpoising.
    patch: {
      aero: {
        clA: 3.45, cdA: 1.09,
        referenceRideHeightFront: 0.034,
        // A knife-edge stall right at the ride height this car runs at speed: the floor
        // seals and unseals a few millimetres either side of equilibrium, and the aero
        // lag turns that into a ~10 Hz heave oscillation. This is the porpoising car.
        groundEffectGain: 0.72, groundEffectOnset: 0.072,
        stallHeight: 0.0135, stallRecoverHeight: 0.0175,
        stallDepth: 0.72, responseTime: 0.035, heaveDamping: 0.0,
      },
      suspension: { front: { springRate: 652000 }, rear: { springRate: 438000 } },
    },
  },
};

/**
 * Build a fresh, fully independent config. `overrides` is merged deeply so callers can
 * patch a single nested field without restating the tree.
 */
export function createCarConfig(overrides = null) {
  const cfg = cloneDeep(BASE_CONFIG);
  if (overrides) mergeDeep(cfg, overrides);
  finaliseConfig(cfg);
  return cfg;
}

/** Build a config for a named team, optionally on a named compound. */
export function createTeamConfig(teamId, compound = 'medium', overrides = null) {
  const team = TEAM_SETUPS[teamId] ?? TEAM_SETUPS.apex;
  const cfg = cloneDeep(BASE_CONFIG);
  mergeDeep(cfg, team.patch);
  cfg.team = teamId;
  cfg.name = team.label;
  cfg.tyres.compound = TYRE_COMPOUNDS[compound] ? compound : 'medium';
  if (overrides) mergeDeep(cfg, overrides);
  finaliseConfig(cfg);
  return cfg;
}

export function teamIds() {
  return Object.keys(TEAM_SETUPS);
}

/**
 * Derive the quantities that depend on other config fields. Called once per config so
 * that nothing in the hot path has to recompute them.
 */
export function finaliseConfig(cfg) {
  const c = cfg.chassis;
  c.cgToFront = c.wheelbase * (1 - c.frontWeightFraction);
  c.cgToRear = c.wheelbase * c.frontWeightFraction;

  const sprung = c.mass - 2 * c.unsprungFront - 2 * c.unsprungRear;
  c.sprungMass = sprung;

  const f = cfg.suspension.front;
  const r = cfg.suspension.rear;
  f.wheelRate = f.springRate * f.motionRatio * f.motionRatio;
  r.wheelRate = r.springRate * r.motionRatio * r.motionRatio;
  f.staticLoad = (sprung * c.frontWeightFraction * 0.5) * G;
  r.staticLoad = (sprung * (1 - c.frontWeightFraction) * 0.5) * G;
  /**
   * The tyre carcass is a spring in series with the suspension, so the ride rate the
   * chassis actually feels is the series combination. Everything the suspension pushes
   * with is attenuated by this factor, and the geometric travel measured by the wheel
   * ray is the sum of strut travel and tyre deflection.
   */
  f.tyreRate = cfg.tyres.front.verticalStiffness;
  r.tyreRate = cfg.tyres.rear.verticalStiffness;
  f.seriesFactor = 1 / (1 + f.wheelRate / f.tyreRate);
  r.seriesFactor = 1 / (1 + r.wheelRate / r.tyreRate);
  f.rideRate = f.wheelRate * f.seriesFactor;
  r.rideRate = r.wheelRate * r.seriesFactor;
  f.staticTravel = f.staticLoad / f.rideRate;
  r.staticTravel = r.staticLoad / r.rideRate;

  cfg.suspension.frontMountX = c.trackFront * 0.5;
  cfg.suspension.rearMountX = c.trackRear * 0.5;

  // Overall gear ratios, precomputed so the powertrain never multiplies in the loop.
  const t = cfg.transmission;
  t.overall = t.gears.map((g) => g * t.finalDrive);
  t.reverseOverall = t.reverse * t.finalDrive;

  cfg.tyres.compoundData = TYRE_COMPOUNDS[cfg.tyres.compound] ?? TYRE_COMPOUNDS.medium;
  return cfg;
}

/** Wheel-centre local positions at design ride height, [FL, FR, RL, RR]. */
export function wheelLocalPositions(cfg, out) {
  const c = cfg.chassis;
  const halfF = c.trackFront * 0.5;
  const halfR = c.trackRear * 0.5;
  const rf = cfg.tyres.front.radius;
  const rr = cfg.tyres.rear.radius;
  // -Z is forward, so the front axle sits at -cgToFront.
  out[0].set(-halfF, rf - c.cgHeight, -c.cgToFront);
  out[1].set(halfF, rf - c.cgHeight, -c.cgToFront);
  out[2].set(-halfR, rr - c.cgHeight, c.cgToRear);
  out[3].set(halfR, rr - c.cgHeight, c.cgToRear);
  return out;
}

export { TORQUE_CURVE, FRONT_TYRE_MF, REAR_TYRE_MF };
