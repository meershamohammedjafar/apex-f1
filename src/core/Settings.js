export const QUALITY_TIERS = {
  low: {
    name: "low",
    pixelRatio: 1,
    shadowMapSize: 1024,
    cascades: 2,
    shadowDistance: 220,
    anisotropy: 4,
    textureScale: 0.5,
    ssao: false,
    motionBlur: false,
    bloom: true,
    bloomQuality: 3,
    taa: false,
    antialias: "fxaa",
    particleBudget: 1200,
    crowdDetail: 0.25,
    mirrorResolution: 0,
    reflections: "env",
    volumetrics: false,
    grassDensity: 0,
    heatHaze: false
  },
  medium: {
    name: "medium",
    pixelRatio: 1,
    shadowMapSize: 2048,
    cascades: 3,
    shadowDistance: 350,
    anisotropy: 8,
    textureScale: 0.75,
    ssao: true,
    motionBlur: true,
    bloom: true,
    bloomQuality: 4,
    taa: false,
    antialias: "smaa",
    particleBudget: 4e3,
    crowdDetail: 0.5,
    mirrorResolution: 256,
    reflections: "env",
    volumetrics: true,
    grassDensity: 0.4,
    heatHaze: true
  },
  high: {
    name: "high",
    pixelRatio: 1,
    shadowMapSize: 2048,
    cascades: 4,
    shadowDistance: 600,
    anisotropy: 16,
    textureScale: 1,
    ssao: true,
    motionBlur: true,
    bloom: true,
    bloomQuality: 5,
    taa: true,
    antialias: "smaa",
    particleBudget: 9e3,
    crowdDetail: 1,
    mirrorResolution: 512,
    reflections: "probe",
    volumetrics: true,
    grassDensity: 1,
    heatHaze: true
  },
  ultra: {
    name: "ultra",
    pixelRatio: 1.5,
    shadowMapSize: 4096,
    cascades: 4,
    shadowDistance: 900,
    anisotropy: 16,
    textureScale: 1,
    ssao: true,
    motionBlur: true,
    bloom: true,
    bloomQuality: 5,
    taa: true,
    antialias: "smaa",
    particleBudget: 16e3,
    crowdDetail: 1,
    mirrorResolution: 1024,
    reflections: "probe",
    volumetrics: true,
    grassDensity: 1.4,
    heatHaze: true
  }
};
const STORAGE_KEY = "apex.settings.v1";
const DEFAULTS = {
  quality: "high",
  fov: 82,
  steerAssist: 0,
  tractionControl: 0,
  abs: 0,
  masterVolume: 0.8,
  engineVolume: 1,
  cameraShake: 1,
  headMovement: 1,
  motionBlurStrength: 1,
  filmGrain: 1,
  chromaticAberration: 1,
  showHud: true,
  units: "metric",
  timeOfDay: 15.2,
  weather: "clear",
  seed: 20260827,
  playerDriver: 0
};
export class Settings {
  static systemName = "settings";
  constructor(overrides = {}) {
    this.values = { ...DEFAULTS, ...this._load(), ...overrides };
    this._listeners = [];
  }
  _load() {
    try {
      const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }
  save() {
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(this.values));
    } catch {
    }
  }
  get(key) {
    return this.values[key];
  }
  set(key, value) {
    if (this.values[key] === value) return;
    this.values[key] = value;
    this.save();
    for (const fn of this._listeners) fn(key, value);
  }
  onChange(fn) {
    this._listeners.push(fn);
    return () => {
      const i = this._listeners.indexOf(fn);
      if (i >= 0) this._listeners.splice(i, 1);
    };
  }
  get tier() {
    return QUALITY_TIERS[this.values.quality] ?? QUALITY_TIERS.high;
  }
}
export function detectQualityTier() {
  const nav = globalThis.navigator;
  if (!nav) return "high";
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent ?? "");
  if (mobile) return "low";
  const mem = nav.deviceMemory ?? 8;
  const cores = nav.hardwareConcurrency ?? 8;
  if (mem >= 8 && cores >= 8) return "high";
  if (mem >= 4 && cores >= 4) return "medium";
  return "low";
}
