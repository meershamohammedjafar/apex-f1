import * as THREE from "three";
import { clamp, wrap01 } from "../core/MathUtils.js";
import { Rng } from "../core/Rng.js";
const EMPTY_CARS = [];
const PLACEMENTS = {
  grid: { camera: "cockpit" },
  straight: {
    camera: "cockpit",
    distance: 6890,
    lateral: -1.2,
    others: [
      { ahead: 58, lateral: 1.9 },
      { ahead: 112, lateral: -2.6 },
      { ahead: 174, lateral: 1.1 },
      { ahead: 246, lateral: -1.8 },
      { ahead: -34, lateral: 2.8 },
      { ahead: -76, lateral: -2.2 }
    ]
  },
  braking: {
    camera: "cockpit",
    corner: 5,
    fallbackDistance: 2392,
    cornerOffset: -92,
    lateral: -4.1,
    others: [
      { ahead: 46, lateral: -1.4 },
      { ahead: 96, lateral: -3.6 },
      { ahead: -28, lateral: -4.6 }
    ]
  },
  apex: {
    camera: "cockpit",
    corner: 10,
    fallbackDistance: 3732,
    cornerOffset: 12,
    lateralFromEdge: -0.55,
    yawOffset: 2.6,
    others: [
      { ahead: 62, lateralFromEdge: -0.9 },
      { ahead: 128, lateralFromEdge: -0.4 },
      { ahead: -40, lateralFromEdge: -1.8 }
    ]
  },
  pack: {
    camera: "cockpit",
    distance: 1780,
    lateral: -1.6,
    others: [
      { ahead: 13.5, lateral: 1.2 },
      { ahead: 25, lateral: -2.9 },
      { ahead: 38.5, lateral: 1.8 },
      { ahead: 0.5, lateral: 3.3 },
      { ahead: -15, lateral: -3.1 },
      { ahead: 62, lateral: -0.4 }
    ]
  }
};
const WEATHER = {
  clear: { preset: "clear", values: { cloudCover: 0.12, rain: 0, windSpeed: 3.5, windDir: 1.05, turbidity: 1.1 } },
  dry: { preset: "clear", values: { cloudCover: 0.12, rain: 0, windSpeed: 3.5, windDir: 1.05, turbidity: 1.1 } },
  scattered: { preset: "scattered", values: { cloudCover: 0.42, rain: 0, windSpeed: 6, windDir: 2.3, turbidity: 1.6 } },
  cloudy: { preset: "cloudy", values: { cloudCover: 0.72, rain: 0, windSpeed: 8.5, windDir: 2.9, turbidity: 2.1 } },
  overcast: { preset: "overcast", values: { cloudCover: 0.95, rain: 0.05, windSpeed: 9, windDir: 3.4, turbidity: 2.6 } },
  wet: { preset: "rain", values: { cloudCover: 0.92, rain: 0.65, windSpeed: 11, windDir: 3.9, turbidity: 3.2 } },
  rain: { preset: "rain", values: { cloudCover: 0.92, rain: 0.65, windSpeed: 11, windDir: 3.9, turbidity: 3.2 } },
  storm: { preset: "storm", values: { cloudCover: 1, rain: 1, windSpeed: 17, windDir: 4.4, turbidity: 3.8 } }
};
const WET_WEATHER_NAMES = new Set(["wet", "rain", "storm"]);
const GOLDEN_HOUR_TOD_MIN = 16.8;
const GOLDEN_HOUR_TOD_MAX = 19.5;
const SUN_AIM_SCAN_STEP = 4;
const SUN_AIM_SAMPLE_STEP = 16;
const SUN_AIM_MAX_RUNUP = 340;
const SUN_AIM_ROAD_AHEAD = 120;
const SUNSET_FALLBACK_DISTANCE = 3110;
const RAIL_CONTROLS = {
  throttle: 0,
  brake: 0,
  steer: 0,
  clutch: 0,
  shiftUp: false,
  shiftDown: false,
  drs: false,
  ers: true,
  pitLimiter: false,
  lookLeft: 0,
  lookRight: 0,
  lookBack: false,
  reset: false
};
const TRAIL_MIN_SPEED = 30;
const TRAIL_MAX_LAP_FRACTION = 0.55;
const TRAIL_LATERAL = 2.4;
const TRAIL_LATERAL_JITTER = 0.9;
const MAX_FIELD = 32;
const TRAIL_SEED = 1597673927;
const _intervals = new Float64Array(MAX_FIELD);
const _trailRng = new Rng(TRAIL_SEED);
const RPM_TO_RADS = Math.PI / 30;
const RADS_TO_RPM = 30 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
const _pos = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _back = new THREE.Vector3();
const _up = new THREE.Vector3();
const _side = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _yaw = new THREE.Quaternion();
const _vel = new THREE.Vector3();
export function resolveCars(ctx) {
  const c = ctx?.cars;
  if (Array.isArray(c)) return c;
  if (Array.isArray(c?.cars)) return c.cars;
  if (Array.isArray(c?.list)) return c.list;
  if (Array.isArray(ctx?.carManager?.cars)) return ctx.carManager.cars;
  return EMPTY_CARS;
}
export function physicsOf(car) {
  if (!car) return null;
  if (car.physics) return car.physics;
  return typeof car.step === "function" && car.state ? car : null;
}
function makePose() {
  return {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    forward: new THREE.Vector3(),
    up: new THREE.Vector3(),
    curvature: 0,
    width: 0
  };
}
function poseFromTrack(track, sample, distance, lateral, yawOffset, out) {
  track.sample(wrap01(distance / track.length), sample);
  _pos.copy(sample.position).addScaledVector(sample.right, lateral);
  const ground = track.heightAt(_pos.x, _pos.z);
  if (Number.isFinite(ground)) _pos.y = ground;
  _fwd.copy(sample.tangent).normalize();
  _up.copy(sample.normal).normalize();
  _side.crossVectors(_fwd, _up).normalize();
  _up.crossVectors(_side, _fwd).normalize();
  _back.copy(_fwd).negate();
  _basis.makeBasis(_side, _up, _back);
  _quat.setFromRotationMatrix(_basis);
  if (yawOffset) {
    _yaw.setFromAxisAngle(_up, yawOffset);
    _quat.premultiply(_yaw);
  }
  out.position.copy(_pos);
  out.quaternion.copy(_quat);
  out.forward.copy(_fwd);
  out.up.copy(_up);
  out.curvature = sample.curvature;
  out.width = sample.width;
  return out;
}
function gearForOmega(cfg, omegaRear) {
  const overall = cfg.transmission.overall;
  const upshift = cfg.transmission.upshiftRpm;
  const downshift = cfg.transmission.downshiftRpm;
  for (let g = overall.length; g >= 1; g--) {
    const rpm = omegaRear * overall[g - 1] * RADS_TO_RPM;
    if (rpm > upshift) return Math.min(overall.length, g + 1);
    if (rpm >= downshift) return g;
  }
  return 1;
}
function rpmForOmega(cfg, omegaRear, gear) {
  return clamp(
    omegaRear * cfg.transmission.overall[gear - 1] * RADS_TO_RPM,
    cfg.engine.idleRpm,
    cfg.engine.limiterRpm * 0.99
  );
}
function primeDrivetrain(phys, speed) {
  const cfg = phys.config;
  const omegaRear = speed / cfg.tyres.rear.radius;
  const omegaFront = speed / cfg.tyres.front.radius;
  if (phys._wheelOmega) {
    phys._wheelOmega[0] = omegaFront;
    phys._wheelOmega[1] = omegaFront;
    phys._wheelOmega[2] = omegaRear;
    phys._wheelOmega[3] = omegaRear;
  }
  const pt = phys.powertrain;
  if (!pt) return;
  const gear = gearForOmega(cfg, omegaRear);
  const rpm = rpmForOmega(cfg, omegaRear, gear);
  pt.gear = gear;
  pt.rpm = rpm;
  pt.engineOmega = rpm * RPM_TO_RADS;
  pt.clutchLocked = speed > 3;
  pt.boost = speed > 20 ? 1 : 0;
  pt.boostBar = speed > 20 ? cfg.engine.boost.maxPressureRatio : 1;
}
function railDrivetrain(phys, speed) {
  const pt = phys.powertrain;
  if (!pt) return;
  const cfg = phys.config;
  const omegaRear = speed / cfg.tyres.rear.radius;
  const gear = gearForOmega(cfg, omegaRear);
  const rpm = rpmForOmega(cfg, omegaRear, gear);
  pt.gear = gear;
  pt.rpm = rpm;
  pt.engineOmega = rpm * RPM_TO_RADS;
  pt.clutchLocked = speed > 3;
  pt.shiftTimer = 0;
  pt.shiftInhibit = 0;
  pt.limiterActive = false;
  pt.limiterCut = 0;
  const s = phys.state;
  s.rpm = rpm;
  s.gear = gear;
  s.shiftTimer = 0;
  s.limiterActive = false;
}
function writeMotion(phys, forward, speed, curvature, up) {
  const s = phys.state;
  _vel.copy(forward).multiplyScalar(speed);
  s.velocity.copy(_vel);
  phys._prevVel?.copy(_vel);
  s.localVelocity.set(0, 0, -speed);
  s.speed = speed;
  s.speedKph = speed * 3.6;
  s.angularVelocity.copy(up).multiplyScalar(speed * curvature);
}
export class ScenarioRail {
  constructor(track) {
    this.track = track;
    this.entries = [];
    this.active = false;
    this._sample = track.surface?.createLocateResult?.() ?? track.sample(0);
    this._pose = makePose();
  }
  addRail(phys, distance, lateral, speed, yawOffset, car = null) {
    const entry = {
      phys,
      car,
      distance,
      lateral,
      speed,
      yawOffset,
      fixed: false,
      cgHeight: phys.config?.chassis?.cgHeight ?? 0.28,
      position: null,
      quaternion: null,
      controls: null
    };
    if (car && !car.isPlayer) {
      entry.controls = { ...RAIL_CONTROLS };
      entry.controls.throttle = speed > 25 ? 1 : speed > 1 ? 0.35 : 0;
      entry.controls.brake = 0;
      entry.controls.drs = speed > 60;
      car.scriptedControls = entry.controls;
    }
    this.entries.push(entry);
  }
  addFixed(phys, car = null) {
    const held = car && !car.isPlayer ? { ...RAIL_CONTROLS, throttle: 0, brake: 0 } : null;
    if (held) car.scriptedControls = held;
    this.entries.push({
      phys,
      car,
      controls: held,
      distance: 0,
      lateral: 0,
      speed: 0,
      yawOffset: 0,
      fixed: true,
      cgHeight: phys.config?.chassis?.cgHeight ?? 0.28,
      position: phys.state.position.clone(),
      quaternion: phys.state.quaternion.clone()
    });
  }
  clear() {
    for (let i = 0; i < this.entries.length; i++) {
      const car = this.entries[i].car;
      if (car && car.scriptedControls === this.entries[i].controls) car.scriptedControls = null;
    }
    this.entries.length = 0;
    this.active = false;
  }
  update(dt) {
    if (!this.active) return;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      const s = e.phys.state;
      if (e.fixed) {
        s.position.copy(e.position);
        s.quaternion.copy(e.quaternion);
        s.velocity.set(0, 0, 0);
        s.angularVelocity.set(0, 0, 0);
        s.localVelocity.set(0, 0, 0);
        s.speed = 0;
        s.speedKph = 0;
        e.phys._prevVel?.set(0, 0, 0);
        railDrivetrain(e.phys, 0);
        continue;
      }
      e.distance += e.speed * dt;
      const pose = poseFromTrack(this.track, this._sample, e.distance, e.lateral, e.yawOffset, this._pose);
      s.position.copy(pose.position);
      s.position.y += e.cgHeight;
      s.quaternion.copy(pose.quaternion);
      writeMotion(e.phys, pose.forward, e.speed, pose.curvature, pose.up);
      railDrivetrain(e.phys, e.speed);
      if (e.controls) {
        const st = e.phys.config?.steering;
        const wheelbase = e.phys.config?.chassis?.wheelbase ?? 3.6;
        const maxAngle = st?.maxRoadWheelAngle ?? 0.37;
        e.controls.steer = clamp(Math.atan(wheelbase * pose.curvature) / maxAngle, -1, 1);
      }
    }
  }
}
function cornerDistance(track, number, fallback) {
  const corners = track.corners;
  if (Array.isArray(corners)) {
    for (let i = 0; i < corners.length; i++) {
      if (corners[i].number === number && Number.isFinite(corners[i].apexDistance)) {
        return corners[i].apexDistance;
      }
    }
  }
  return fallback;
}
function goldenHourShot(name, setup) {
  return name === "straight" && Number.isFinite(setup.tod) && setup.tod >= GOLDEN_HOUR_TOD_MIN && setup.tod < GOLDEN_HOUR_TOD_MAX && !WET_WEATHER_NAMES.has(setup.weather);
}
function adoptTrackLocation(sky, track) {
  if (!sky?.setLocation) return;
  if (!Number.isFinite(track.latitude) && !Number.isFinite(track.longitude)) return;
  sky.setLocation({
    latitude: track.latitude,
    longitude: track.longitude,
    dayOfYear: track.dayOfYear
  });
}
function sunFacingDistance(sky, track, speed, warmup) {
  const sun = sky?.sunDirection;
  const sunFlat = sun ? Math.hypot(sun.x, sun.z) : 0;
  if (sunFlat < 1e-4) return SUNSET_FALLBACK_DISTANCE;
  const sunX = sun.x / sunFlat;
  const sunZ = sun.z / sunFlat;
  const sample = track.surface?.createLocateResult?.() ?? track.sample(0);
  const runup = Math.min(SUN_AIM_MAX_RUNUP, Math.max(speed, TRAIL_MIN_SPEED) * Math.max(warmup, 1));
  let bestDistance = SUNSET_FALLBACK_DISTANCE;
  let bestScore = -Infinity;
  for (let distance = 0; distance < track.length; distance += SUN_AIM_SCAN_STEP) {
    let worstFacing = Infinity;
    for (let behind = -SUN_AIM_ROAD_AHEAD; behind <= runup; behind += SUN_AIM_SAMPLE_STEP) {
      track.sample(wrap01((distance - behind) / track.length), sample);
      const tangent = sample.tangent;
      const tangentFlat = Math.hypot(tangent.x, tangent.z);
      const facing = tangentFlat > 1e-6 ? (tangent.x * sunX + tangent.z * sunZ) / tangentFlat : -1;
      if (facing < worstFacing) worstFacing = facing;
    }
    if (worstFacing > bestScore) {
      bestScore = worstFacing;
      bestDistance = distance;
    }
  }
  return bestDistance;
}
function applyEnvironment(ctx, setup, cameraMode) {
  if (Number.isFinite(setup.tod)) {
    ctx.settings?.set?.("timeOfDay", setup.tod);
    ctx.sky?.setTimeOfDay?.(setup.tod);
  }
  const weather = WEATHER[setup.weather];
  if (weather) {
    ctx.settings?.set?.("weather", weather.preset);
    ctx.sky?.setWeather?.(weather.values);
    if (ctx.sky?.weather) Object.assign(ctx.sky.weather, weather.values);
  }
  if (cameraMode) ctx.cameraRig?.setMode?.(cameraMode);
}
export function applyScenario(ctx, director, setup = {}) {
  const track = ctx.track;
  const cars = resolveCars(ctx);
  if (!track || cars.length === 0) return null;
  const name = PLACEMENTS[setup.scenario] ? setup.scenario : "straight";
  let plan = PLACEMENTS[name];
  const speed = Math.max(0, Number.isFinite(setup.speed) ? setup.speed : 0);
  const capture = ctx.captureMode === true;
  const warmup = capture && Number.isFinite(setup.warmup) ? setup.warmup : 0;
  applyEnvironment(ctx, setup, setup.camera ?? plan.camera);
  if (goldenHourShot(name, setup)) {
    adoptTrackLocation(ctx.sky, track);
    plan = { ...plan, distance: sunFacingDistance(ctx.sky, track, speed, warmup) };
  }
  const rail = new ScenarioRail(track);
  rail.active = capture;
  if (name === "grid") {
    placeGrid(track, cars, rail, director);
    director?.setupGridShot?.();
  } else {
    const placement = placeRunning(track, cars, rail, plan, speed, warmup, capture, director);
    director?.setupRunningShot?.(name, speed, placement);
  }
  return rail;
}
function placeGrid(track, cars, rail, director) {
  const slots = track.startGrid ?? [];
  if (slots.length === 0) return;
  for (let i = 0; i < cars.length; i++) {
    const phys = physicsOf(cars[i]);
    if (!phys) continue;
    const index = director?.gridSlotFor?.(i) ?? i;
    const slot = slots[index % slots.length];
    phys.reset(slot.position, slot.quaternion, track);
    primeDrivetrain(phys, 0);
    rail.addFixed(phys, cars[i]);
  }
}
function randomInterval(rng) {
  return rng.next() < 0.62 ? rng.range(0.16, 0.55) : rng.range(0.9, 3.2);
}
function trailIntervals(director, first, count, pace, lapLength) {
  if (count <= 0) return 0;
  _trailRng.seed(TRAIL_SEED ^ Math.imul(first + 1, 2654435761));
  let written = director?.fieldIntervals?.(first, count, _intervals) ?? 0;
  for (let j = written; j < count; j++) _intervals[j] = randomInterval(_trailRng);
  written = count;
  let total = 0;
  for (let j = 0; j < count; j++) total += _intervals[j];
  const limit = lapLength * TRAIL_MAX_LAP_FRACTION / pace;
  if (total > limit && total > 0) {
    const scale = limit / total;
    for (let j = 0; j < count; j++) _intervals[j] *= scale;
  }
  return written;
}
function placeRunning(track, cars, rail, plan, speed, warmup, capture, director) {
  const base = Number.isFinite(plan.distance) ? plan.distance : cornerDistance(track, plan.corner, plan.fallbackDistance) + (plan.cornerOffset ?? 0);
  const pose = makePose();
  const sample = track.surface?.createLocateResult?.() ?? track.sample(0);
  const others = plan.others ?? [];
  const yaw = (plan.yawOffset ?? 0) * DEG_TO_RAD;
  const placement = [];
  const pace = Math.max(speed, TRAIL_MIN_SPEED);
  let rearmost = 0;
  for (let i = 0; i < others.length; i++) rearmost = Math.min(rearmost, others[i].ahead ?? 0);
  let trailDistance = base + rearmost;
  let trailIndex = 0;
  const composed = 1 + others.length;
  const trailCount = Math.max(0, Math.min(cars.length, MAX_FIELD) - composed);
  trailIntervals(director, composed, trailCount, pace, track.length);
  for (let i = 0; i < cars.length; i++) {
    const phys = physicsOf(cars[i]);
    if (!phys) continue;
    const spec = i === 0 ? plan : others[i - 1];
    let distance;
    let lateral;
    let carSpeed;
    if (spec) {
      distance = base + (i === 0 ? 0 : spec.ahead);
      lateral = spec.lateral;
      carSpeed = speed;
      if (lateral === void 0) {
        poseFromTrack(track, sample, distance, 0, 0, pose);
        lateral = -(pose.width + (spec.lateralFromEdge ?? 0));
      }
    } else {
      const interval = trailIndex < trailCount ? _intervals[trailIndex] : randomInterval(_trailRng);
      trailDistance -= interval * pace;
      trailIndex++;
      distance = trailDistance;
      lateral = (trailIndex & 1) === 0 ? -TRAIL_LATERAL : TRAIL_LATERAL;
      lateral += _trailRng.signed(TRAIL_LATERAL_JITTER);
      carSpeed = speed;
    }
    const carYaw = i === 0 ? yaw : yaw * 0.4;
    const start = distance - carSpeed * warmup;
    poseFromTrack(track, sample, start, lateral, carYaw, pose);
    phys.reset(pose.position, pose.quaternion, track);
    primeDrivetrain(phys, carSpeed);
    writeMotion(phys, pose.forward, carSpeed, pose.curvature, pose.up);
    if (capture) rail.addRail(phys, start, lateral, carSpeed, carYaw, cars[i]);
    placement.push({ index: i, distance: start, speed: carSpeed, lateral });
  }
  return placement;
}
export { PLACEMENTS, WEATHER };
