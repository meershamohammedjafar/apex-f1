import { DEG, G } from "../core/MathUtils.js";
export const AIR_DENSITY = 1.2041;
const FRONT_TYRE_MF = {
  FZ0: 3600,
  PCX1: 1.62,
  PDX1: 1.95,
  PDX2: -0.2,
  PDX3: 0.9,
  PEX1: 0.16,
  PEX2: -0.3,
  PEX3: 0,
  PEX4: 0.05,
  PKX1: 44,
  PKX2: -2.1,
  PKX3: -0.12,
  PHX1: 0,
  PVX1: 0,
  PCY1: 1.44,
  PDY1: 1.9,
  PDY2: -0.18,
  PDY3: 3.6,
  PEY1: -0.62,
  PEY2: -0.1,
  PEY3: 0.06,
  PEY4: -3.5,
  PKY1: 55,
  PKY2: 2.15,
  PKY3: 1.15,
  PHY1: 0,
  PHY3: 0.028,
  PVY1: 0,
  PVY3: -0.2,
  PVY4: -0.12,
  QBZ1: 9.4,
  QBZ2: -0.9,
  QBZ9: 12,
  QBZ10: 0.6,
  QCZ1: 1.18,
  QDZ1: 0.098,
  QDZ2: -0.01,
  QDZ3: -0.3,
  QDZ4: 3,
  QDZ6: 0,
  QDZ8: -0.1,
  QEZ1: -1.6,
  QEZ2: 0.2,
  QEZ5: -1.4,
  QHZ1: 0,
  QHZ3: 0.02
};
const REAR_TYRE_MF = {
  FZ0: 4400,
  PCX1: 1.6,
  PDX1: 1.99,
  PDX2: -0.18,
  PDX3: 0.8,
  PEX1: 0.14,
  PEX2: -0.28,
  PEX3: 0,
  PEX4: 0.05,
  PKX1: 42,
  PKX2: -2,
  PKX3: -0.11,
  PHX1: 0,
  PVX1: 0,
  PCY1: 1.42,
  PDY1: 1.95,
  PDY2: -0.165,
  PDY3: 3.2,
  PEY1: -0.58,
  PEY2: -0.09,
  PEY3: 0.05,
  PEY4: -3.2,
  PKY1: 52,
  PKY2: 2.3,
  PKY3: 1.05,
  PHY1: 0,
  PHY3: 0.024,
  PVY1: 0,
  PVY3: -0.17,
  PVY4: -0.1,
  QBZ1: 8.9,
  QBZ2: -0.85,
  QBZ9: 11,
  QBZ10: 0.6,
  QCZ1: 1.16,
  QDZ1: 0.104,
  QDZ2: -0.011,
  QDZ3: -0.28,
  QDZ4: 2.6,
  QDZ6: 0,
  QDZ8: -0.09,
  QEZ1: -1.5,
  QEZ2: 0.2,
  QEZ5: -1.2,
  QHZ1: 0,
  QHZ3: 0.018
};
export const TYRE_COMPOUNDS = {
  soft: {
    name: "soft",
    code: "C4",
    gripScale: 1.035,
    optimumTemp: 98,
    windowCold: 28,
    windowHot: 24,
    coldGrip: 0.72,
    hotGrip: 0.68,
    wearRate: 1.85,
    heatRate: 1.14,
    coolRate: 0.96,
    peakLossPerWear: 0.26,
    optimumRisePerWear: 11
  },
  medium: {
    name: "medium",
    code: "C3",
    gripScale: 1,
    optimumTemp: 108,
    windowCold: 32,
    windowHot: 28,
    coldGrip: 0.7,
    hotGrip: 0.72,
    wearRate: 1,
    heatRate: 1,
    coolRate: 1,
    peakLossPerWear: 0.21,
    optimumRisePerWear: 9
  },
  hard: {
    name: "hard",
    code: "C2",
    gripScale: 0.962,
    optimumTemp: 117,
    windowCold: 36,
    windowHot: 32,
    coldGrip: 0.66,
    hotGrip: 0.76,
    wearRate: 0.6,
    heatRate: 0.86,
    coolRate: 1.05,
    peakLossPerWear: 0.16,
    optimumRisePerWear: 7
  }
};
const TORQUE_CURVE = [
  [0, 0],
  [2500, 190],
  [3500, 250],
  [4e3, 290],
  [5e3, 335],
  [6e3, 380],
  [7e3, 420],
  [8e3, 455],
  [9e3, 480],
  [1e4, 495],
  [10500, 500],
  [11e3, 492],
  [11500, 478],
  [12e3, 440],
  [13e3, 400],
  [14e3, 355],
  [15e3, 305],
  [15600, 0]
];
function cloneDeep(value) {
  if (Array.isArray(value)) return value.map(cloneDeep);
  if (value && typeof value === "object") {
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
    if (pv && typeof pv === "object" && !Array.isArray(pv) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      mergeDeep(base[key], pv);
    } else {
      base[key] = cloneDeep(pv);
    }
  }
  return base;
}
const WHEELBASE = 3.6;
const TRACK_FRONT = 2;
const TRACK_REAR = 1.96;
const MASS = 798;
const FRONT_WEIGHT_FRACTION = 0.46;
const CG_HEIGHT = 0.28;
const CG_TO_FRONT = WHEELBASE * (1 - FRONT_WEIGHT_FRACTION);
const CG_TO_REAR = WHEELBASE * FRONT_WEIGHT_FRACTION;
const UNSPRUNG_FRONT = 26;
const UNSPRUNG_REAR = 32;
const SPRUNG_MASS = MASS - 2 * UNSPRUNG_FRONT - 2 * UNSPRUNG_REAR;
const SPRUNG_FRONT_CORNER = SPRUNG_MASS * FRONT_WEIGHT_FRACTION / 2;
const SPRUNG_REAR_CORNER = SPRUNG_MASS * (1 - FRONT_WEIGHT_FRACTION) / 2;
const BASE_CONFIG = {
  name: "APEX-26",
  team: "apex",
  chassis: {
    mass: MASS,
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
    length: 5.63,
    width: 2,
    height: 0.95,
    noseOffset: 2.62,
    tailOffset: 3.01,
    floorHalfWidth: 0.75,
    rollingResistance: 0.0125
  },
  steering: {
    maxRoadWheelAngle: 21 * DEG,
    ratio: 11.5,
    wheelRangeDeg: 240,
    ackermann: 0.12,
    rackSpeed: 7.5,
    selfCentreGain: 0
  },
  suspension: {
    frontMountX: TRACK_FRONT / 2,
    rearMountX: TRACK_REAR / 2,
    front: {
      springRate: 62e4,
      motionRatio: 0.88,
      bumpLow: 14500,
      bumpHigh: 7400,
      bumpKnee: 0.055,
      reboundLow: 25e3,
      reboundHigh: 11e3,
      reboundKnee: 0.045,
      bumpStopGap: 0.018,
      bumpStopRate: 32e5,
      droopStopGap: 0.026,
      droopStopRate: 22e5,
      maxBump: 0.038,
      maxDroop: 0.032,
      staticCamber: -3.4 * DEG,
      camberGain: -1.05,
      staticToe: -0.1 * DEG,
      toeGain: 0.28,
      antiRoll: 19e4,
      antiDive: 0.18,
      staticLoad: SPRUNG_FRONT_CORNER * G,
      rideHeight: 0.04
    },
    rear: {
      springRate: 416e3,
      motionRatio: 0.93,
      bumpLow: 10400,
      bumpHigh: 5400,
      bumpKnee: 0.055,
      reboundLow: 17600,
      reboundHigh: 8e3,
      reboundKnee: 0.045,
      bumpStopGap: 0.024,
      bumpStopRate: 26e5,
      droopStopGap: 0.03,
      droopStopRate: 19e5,
      maxBump: 0.042,
      maxDroop: 0.036,
      staticCamber: -1.8 * DEG,
      camberGain: -0.85,
      staticToe: 0.22 * DEG,
      toeGain: 0.2,
      antiRoll: 95e3,
      antiSquat: 0.22,
      staticLoad: SPRUNG_REAR_CORNER * G,
      rideHeight: 0.085
    },
    rayLift: 0.06
  },
  tyres: {
    compound: "medium",
    front: {
      radius: 0.36,
      width: 0.305,
      rimRadius: 0.1651,
      inertia: 1.12,
      verticalStiffness: 46e4,
      verticalDamping: 3200,
      radialGrowth: 33e-8,
      relaxLong: 0.28,
      relaxLat: 0.42,
      lowSpeedFloor: 0.85,
      mf: FRONT_TYRE_MF,
      mass: 11.5,
      surfaceHeatCapacity: 1520,
      coreHeatCapacity: 15200,
      conductionSurfaceCore: 150,
      convectionBase: 11,
      convectionPerSpeed: 0.52,
      coreToAmbient: 11,
      brakeToCore: 4.2,
      roadConductance: 750,
      roadHeatPartition: 0.4,
      slideRenewalSpeed: 8,
      rollingHysteresis: 0.0155,
      hysteresisTreadShare: 0.55,
      surfaceHeatFraction: 0.8
    },
    rear: {
      radius: 0.3625,
      width: 0.405,
      rimRadius: 0.1651,
      inertia: 1.58,
      verticalStiffness: 49e4,
      verticalDamping: 3500,
      radialGrowth: 31e-8,
      relaxLong: 0.31,
      relaxLat: 0.46,
      lowSpeedFloor: 0.85,
      mf: REAR_TYRE_MF,
      mass: 14.2,
      surfaceHeatCapacity: 2020,
      coreHeatCapacity: 18600,
      conductionSurfaceCore: 178,
      convectionBase: 12,
      convectionPerSpeed: 0.6,
      coreToAmbient: 12,
      brakeToCore: 4.6,
      roadConductance: 750,
      roadHeatPartition: 0.4,
      slideRenewalSpeed: 8,
      rollingHysteresis: 0.0165,
      hysteresisTreadShare: 0.55,
      surfaceHeatFraction: 0.8
    },
    wearPerJoule: 82e-9,
    startTemp: 90,
    ambientTemp: 26,
    trackTemp: 38
  },
  aero: {
    airDensity: AIR_DENSITY,
    clA: 3.4,
    cdA: 1.08,
    inducedDrag: 0.032,
    frontBalance: 0.445,
    balanceSpeedShift: 0.022,
    balanceRideHeightGain: 1.9,
    balanceMin: 0.3,
    balanceMax: 0.55,
    referenceRideHeightFront: 0.04,
    referenceRideHeightRear: 0.085,
    groundEffectGain: 0.62,
    groundEffectOnset: 0.1,
    groundEffectPeak: 0.022,
    stallHeight: 95e-4,
    stallRecoverHeight: 0.019,
    stallDepth: 0.46,
    rollStallAngle: 0.022,
    rollStallFull: 0.058,
    rollStallDepth: 0.34,
    yawStallAngle: 0.1,
    yawStallDepth: 0.3,
    responseTime: 0.042,
    heaveDamping: 0.55,
    dragCentreHeight: 0.31,
    sideForceArea: 1.05,
    sideCentreOffset: -0.28,
    drs: {
      dragDelta: 0.312,
      rearDownforceLoss: 0.255,
      openTime: 0.28,
      closeTime: 0.12,
      minSpeed: 27
    },
    wake: {
      length: 12,
      frontLoss: 0.42,
      rearLoss: 0.24,
      dragLoss: 0.3,
      lateralWidth: 2.6
    },
    damage: {
      frontLossPerUnit: 0.55,
      rearLossPerUnit: 0.4,
      floorLossPerUnit: 0.35,
      dragGainPerUnit: 0.3
    }
  },
  engine: {
    displacement: 1.6,
    torqueCurve: TORQUE_CURVE,
    idleRpm: 4200,
    limiterRpm: 15e3,
    limiterCutTime: 0.045,
    limiterRecoverRpm: 14550,
    inertia: 0.135,
    frictionBase: 12,
    frictionPerRpm: 42e-4,
    engineBrakeGain: 85e-4,
    fuelFlowMax: 100 / 3600,
    fuelLHV: 43e6,
    thermalEfficiency: 0.51,
    startFuel: 104,
    boost: {
      maxPressureRatio: 3.45,
      thresholdRpm: 3e3,
      fullSpoolRpm: 7e3,
      spoolTimeCold: 0.8,
      spoolTimeHot: 0.105,
      decayTime: 0.19,
      mguhSpoolTime: 0.05,
      mguhFloor: 0.48,
      torqueAtZeroBoost: 0.3
    }
  },
  transmission: {
    finalDrive: 3.9,
    gears: [4.013, 3.326, 2.811, 2.434, 2.145, 1.911, 1.718, 1.515],
    reverse: 3.2,
    efficiency: 0.955,
    shiftTime: 0.04,
    downshiftTime: 0.055,
    shiftInhibit: 0.06,
    upshiftRpm: 14700,
    downshiftRpm: 9600,
    clutchTorqueCapacity: 950,
    clutchEngageTime: 0.55,
    differential: {
      preload: 65,
      powerRamp: 0.42,
      coastRamp: 0.26,
      viscous: 62,
      maxLock: 2600
    }
  },
  brakes: {
    maxTorqueTotal: 21e3,
    bias: 0.6,
    biasMin: 0.5,
    biasMax: 0.68,
    pedalGamma: 1.22,
    discRadiusFront: 0.132,
    discRadiusRear: 0.128,
    discMassFront: 1.55,
    discMassRear: 1.05,
    discHeatCapacity: 950,
    coolingBase: 12,
    coolingPerSpeed: 1.25,
    coldTemp: 350,
    optimumTemp: 650,
    fadeTemp: 1050,
    coldTorqueFactor: 0.78,
    fadeTorqueFactor: 0.72,
    ambient: 100,
    abs: 0
  },
  assists: {
    tractionControl: 0,
    tcSlipTarget: 0.16
  },
  ers: {
    storeCapacity: 4e6,
    deployPowerMax: 12e4,
    harvestPowerMax: 12e4,
    deployPerLap: 4e6,
    harvestKPerLap: 2e6,
    mguhPowerMax: 32e3,
    mguhToStore: 0.88,
    startCharge: 0.85,
    deployTaper: 0.9,
    modes: [
      { name: "off", deploy: 0, harvest: 1.15 },
      { name: "balanced", deploy: 0.55, harvest: 1 },
      { name: "attack", deploy: 0.85, harvest: 0.85 },
      { name: "overtake", deploy: 1, harvest: 0.7 }
    ],
    defaultMode: 1
  },
  pitLimiter: {
    speed: 80 / 3.6,
    gain: 1.6
  },
  damage: {
    impactThreshold: 900,
    frontImpulse: 26e3,
    rearImpulse: 3e4,
    floorImpulse: 42e3,
    floorScrapePerJoule: 45e-8,
    restitution: 0.28,
    friction: 0.55
  }
};
export const TEAM_SETUPS = {
  apex: { label: "Apex Racing", patch: {} },
  vermilion: {
    label: "Vermilion",
    patch: {
      aero: { clA: 3.47, cdA: 1.11, frontBalance: 0.432, groundEffectGain: 0.66 },
      suspension: { front: { springRate: 596e3, antiRoll: 172e3 }, rear: { antiRoll: 106e3 } },
      transmission: { differential: { powerRamp: 0.46 } }
    }
  },
  argent: {
    label: "Argent Motorsport",
    patch: {
      aero: { clA: 3.3, cdA: 1.02, frontBalance: 0.462, balanceSpeedShift: 0.026 },
      suspension: { front: { staticCamber: -3.7 * DEG, antiRoll: 206e3 }, rear: { antiRoll: 83e3 } },
      brakes: { bias: 0.612 }
    }
  },
  scuderia: {
    label: "Scuderia Rossa",
    patch: {
      aero: { clA: 3.37, cdA: 1.06, referenceRideHeightRear: 0.093 },
      engine: { boost: { spoolTimeHot: 0.1 } },
      suspension: { rear: { springRate: 434e3, staticToe: 0.28 * DEG } },
      transmission: { differential: { preload: 78, coastRamp: 0.3 } }
    }
  },
  meridian: {
    label: "Meridian GP",
    patch: {
      aero: { clA: 3.34, cdA: 1.07 },
      suspension: {
        front: { springRate: 6e5, bumpLow: 13400 },
        rear: { springRate: 402e3, bumpLow: 9700 }
      },
      tyres: { wearPerJoule: 71e-9 }
    }
  },
  kestrel: {
    label: "Kestrel",
    patch: {
      aero: {
        clA: 3.45,
        cdA: 1.09,
        referenceRideHeightFront: 0.034,
        groundEffectGain: 0.72,
        groundEffectOnset: 0.072,
        stallHeight: 0.0135,
        stallRecoverHeight: 0.0175,
        stallDepth: 0.72,
        responseTime: 0.035,
        heaveDamping: 0
      },
      suspension: { front: { springRate: 652e3 }, rear: { springRate: 438e3 } }
    }
  }
};
export function createCarConfig(overrides = null) {
  const cfg = cloneDeep(BASE_CONFIG);
  if (overrides) mergeDeep(cfg, overrides);
  finaliseConfig(cfg);
  return cfg;
}
export function createTeamConfig(teamId, compound = "medium", overrides = null) {
  const team = TEAM_SETUPS[teamId] ?? TEAM_SETUPS.apex;
  const cfg = cloneDeep(BASE_CONFIG);
  mergeDeep(cfg, team.patch);
  cfg.team = teamId;
  cfg.name = team.label;
  cfg.tyres.compound = TYRE_COMPOUNDS[compound] ? compound : "medium";
  if (overrides) mergeDeep(cfg, overrides);
  finaliseConfig(cfg);
  return cfg;
}
export function teamIds() {
  return Object.keys(TEAM_SETUPS);
}
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
  f.staticLoad = sprung * c.frontWeightFraction * 0.5 * G;
  r.staticLoad = sprung * (1 - c.frontWeightFraction) * 0.5 * G;
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
  const t = cfg.transmission;
  t.overall = t.gears.map((g) => g * t.finalDrive);
  t.reverseOverall = t.reverse * t.finalDrive;
  cfg.tyres.compoundData = TYRE_COMPOUNDS[cfg.tyres.compound] ?? TYRE_COMPOUNDS.medium;
  return cfg;
}
export function wheelLocalPositions(cfg, out) {
  const c = cfg.chassis;
  const halfF = c.trackFront * 0.5;
  const halfR = c.trackRear * 0.5;
  const rf = cfg.tyres.front.radius;
  const rr = cfg.tyres.rear.radius;
  out[0].set(-halfF, rf - c.cgHeight, -c.cgToFront);
  out[1].set(halfF, rf - c.cgHeight, -c.cgToFront);
  out[2].set(-halfR, rr - c.cgHeight, c.cgToRear);
  out[3].set(halfR, rr - c.cgHeight, c.cgToRear);
  return out;
}
export { TORQUE_CURVE, FRONT_TYRE_MF, REAR_TYRE_MF };
