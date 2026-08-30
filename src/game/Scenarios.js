import * as THREE from 'three';
import { clamp, wrap01 } from '../core/MathUtils.js';
import { Rng } from '../core/Rng.js';

/**
 * Deterministic scenario placement — the mechanism every visual review runs through.
 *
 * `tools/screenshot.mjs` calls `RaceDirector.applyScenario(setup)` and then steps the
 * simulation for `setup.warmup` seconds with scripted controls before it grabs the
 * frame. Two consequences shape everything below.
 *
 * First, a car placed on its mark would have driven off it by the time the shutter
 * opens, so each car starts `speed * warmup` metres short and arrives exactly on it.
 *
 * Second, scripted controls do not drive a lap: four seconds of full brake stops the
 * car dead, and four seconds of constant steering leaves the circuit. So in capture
 * mode the cars run on a rail — pose and velocity written from the centreline each
 * tick, at the scripted speed. The physics still runs underneath: wheels lock and
 * smoke under the scripted brake, tyres and brakes heat, the aero platform loads up,
 * the DRS flap opens. Only the trajectory is authored, and only for screenshots.
 */

const EMPTY_CARS = [];

/**
 * Where each scenario puts the field. `distance` is metres along the centreline;
 * `lateral` is metres right of it; `lateralFromEdge` is measured in from the left-hand
 * track edge instead, so a kerb placement follows the width wherever it is used.
 */
const PLACEMENTS = {
  grid: { camera: 'cockpit' },
  straight: {
    camera: 'cockpit',
    distance: 6890,          // main straight: pit wall, grandstands, La Source ahead
    lateral: -1.2,
    others: [
      { ahead: 58, lateral: 1.9 },
      { ahead: 112, lateral: -2.6 },
      { ahead: 174, lateral: 1.1 },
      { ahead: 246, lateral: -1.8 },
      { ahead: -34, lateral: 2.8 },
      { ahead: -76, lateral: -2.2 },
    ],
  },
  braking: {
    camera: 'cockpit',
    corner: 5,               // Les Combes — the heaviest stop on the lap
    fallbackDistance: 2392,
    cornerOffset: -92,       // hard on the brakes with the corner filling the screen
    lateral: -4.1,           // out on the left, setting up for the right-hander
    others: [
      { ahead: 46, lateral: -1.4 },
      { ahead: 96, lateral: -3.6 },
      { ahead: -28, lateral: -4.6 },
    ],
  },
  apex: {
    camera: 'cockpit',
    corner: 10,              // Pouhon — a double-apex left taken in sixth
    fallbackDistance: 3732,
    cornerOffset: 12,
    lateralFromEdge: -0.55,  // left wheels over the inside kerb
    yawOffset: 2.6,          // degrees of slip: the car is rotated into the corner
    others: [
      { ahead: 62, lateralFromEdge: -0.9 },
      { ahead: 128, lateralFromEdge: -0.4 },
      { ahead: -40, lateralFromEdge: -1.8 },
    ],
  },
  pack: {
    camera: 'cockpit',
    distance: 1780,          // mid-Kemmel: DRS open, forest either side, Les Combes ahead
    lateral: -1.6,
    others: [
      { ahead: 13.5, lateral: 1.2 },
      { ahead: 25.0, lateral: -2.9 },
      { ahead: 38.5, lateral: 1.8 },
      { ahead: 0.5, lateral: 3.3 },   // alongside, wheel to wheel
      { ahead: -15, lateral: -3.1 },
      { ahead: 62, lateral: -0.4 },
    ],
  },
};

/**
 * Weather names the harness may pass, resolved to a SkySystem preset plus the values
 * needed to snap the sky there instead of crossfading over two seconds.
 */
const WEATHER = {
  clear: { preset: 'clear', values: { cloudCover: 0.12, rain: 0, windSpeed: 3.5, windDir: 1.05, turbidity: 1.1 } },
  dry: { preset: 'clear', values: { cloudCover: 0.12, rain: 0, windSpeed: 3.5, windDir: 1.05, turbidity: 1.1 } },
  scattered: { preset: 'scattered', values: { cloudCover: 0.42, rain: 0, windSpeed: 6.0, windDir: 2.3, turbidity: 1.6 } },
  cloudy: { preset: 'cloudy', values: { cloudCover: 0.72, rain: 0, windSpeed: 8.5, windDir: 2.9, turbidity: 2.1 } },
  overcast: { preset: 'overcast', values: { cloudCover: 0.95, rain: 0.05, windSpeed: 9.0, windDir: 3.4, turbidity: 2.6 } },
  wet: { preset: 'rain', values: { cloudCover: 0.92, rain: 0.65, windSpeed: 11.0, windDir: 3.9, turbidity: 3.2 } },
  rain: { preset: 'rain', values: { cloudCover: 0.92, rain: 0.65, windSpeed: 11.0, windDir: 3.9, turbidity: 3.2 } },
  storm: { preset: 'storm', values: { cloudCover: 1.0, rain: 1.0, windSpeed: 17.0, windDir: 4.4, turbidity: 3.8 } },
};

/** The ControlState a railed car is handed in place of its driver's. */
const RAIL_CONTROLS = {
  throttle: 0, brake: 0, steer: 0, clutch: 0,
  shiftUp: false, shiftDown: false,
  drs: false, ers: true, pitLimiter: false,
  lookLeft: 0, lookRight: 0, lookBack: false, reset: false,
};

/**
 * Cars the composition does not need still belong to the race. They run down the road
 * behind the shot at the same speed as the rest of the field, at the intervals the race
 * director's own field spread produces — trains of cars a couple of tenths apart with
 * clear air between them — so the timing tower reads as a grand prix all the way to P20
 * instead of stopping at the edge of the frame.
 *
 * Nothing here decides what the tower prints. These intervals put cars on the road; the
 * director then measures the gaps back off the road with Track.locate, exactly as it
 * does for a race nobody staged.
 */
const TRAIL_MIN_SPEED = 30;      // m/s used for spacing when the scenario speed is lower
/**
 * The tail may not be strung out further behind the shot than this much of the lap: a
 * car placed further back than the circuit is long comes back round into the frame.
 */
const TRAIL_MAX_LAP_FRACTION = 0.55;
const TRAIL_LATERAL = 2.4;       // metres either side of the centreline the tail runs at
const TRAIL_LATERAL_JITTER = 0.9;
const MAX_FIELD = 32;
const TRAIL_SEED = 0x5f3a91c7;

/** Intervals in seconds, one per car of the tail. Hoisted: applyScenario may re-run. */
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

/** The player is index 0; the car manager may expose the array directly or wrap it. */
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
  return typeof car.step === 'function' && car.state ? car : null;
}

function makePose() {
  return {
    position: new THREE.Vector3(),
    quaternion: new THREE.Quaternion(),
    forward: new THREE.Vector3(),
    up: new THREE.Vector3(),
    curvature: 0,
    width: 0,
  };
}

/**
 * Pose on the centreline at `distance`, offset `lateral` metres to the right. `y` comes
 * back at road level; callers add the CG height. The basis is built exactly the way
 * Track builds its grid slots, so a car placed here sits as a car on the grid does.
 */
function poseFromTrack(track, sample, distance, lateral, yawOffset, out) {
  track.sample(wrap01(distance / track.length), sample);

  _pos.copy(sample.position).addScaledVector(sample.right, lateral);
  const ground = track.heightAt(_pos.x, _pos.z);
  if (Number.isFinite(ground)) _pos.y = ground;

  _fwd.copy(sample.tangent).normalize();
  _up.copy(sample.normal).normalize();
  _side.crossVectors(_fwd, _up).normalize();
  _up.crossVectors(_side, _fwd).normalize();
  // Car local -Z is forward, so the basis's Z column is the reversed tangent.
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

/**
 * The gear a driver would actually be in at this rear-axle speed: the highest one that
 * still has the engine above its downshift point.
 */
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

/** Engine speed the gearbox imposes at this road speed, clamped to the engine's range. */
function rpmForOmega(cfg, omegaRear, gear) {
  return clamp(omegaRear * cfg.transmission.overall[gear - 1] * RADS_TO_RPM,
    cfg.engine.idleRpm, cfg.engine.limiterRpm * 0.99);
}

/**
 * Give the drivetrain a state consistent with the speed it has been handed, so the
 * first physics step does not find a stalled engine at 300 km/h.
 */
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
  // A car at racing speed has been on the throttle, so the turbo is lit; without this
  // the first second of every capture is spent spooling.
  pt.boost = speed > 20 ? 1 : 0;
  pt.boostBar = speed > 20 ? cfg.engine.boost.maxPressureRatio : 1;
}

/**
 * Hold the power unit consistent with the speed the rail is writing.
 *
 * The rail authors the road speed directly, but the powertrain still derives engine
 * speed from the wheels it is bolted to. Four seconds of scripted full brake locks
 * those wheels, the gearbox input falls below the clutch's lock threshold, the crank
 * freewheels down to idle — and the cluster ends up printing 2300 rpm next to an
 * eighth-gear 270 km/h, which is the telemetry of no car that has ever existed.
 *
 * Re-deriving gear and rpm from the railed road speed through the current overall ratio
 * every tick is what keeps speed, gear and rpm describing one car. The wheels are left
 * alone, so a scripted brake still locks and smokes the tyres exactly as before; only
 * the engine stops taking its orders from them.
 *
 * Called after the physics step (RaceDirector updates after CarManager), so the values
 * written here are the ones the HUD and the audio engine read this frame, and the ones
 * the next step starts from.
 */
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
  // A railed car is never mid-shift and never on the limiter: rpm is clamped below it.
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
  // Matching the physics' own previous-velocity cache keeps `accel` — and with it the
  // g-force the camera and HUD read — honest across a teleport.
  phys._prevVel?.copy(_vel);
  s.localVelocity.set(0, 0, -speed);
  s.speed = speed;
  s.speedKph = speed * 3.6;
  s.angularVelocity.copy(up).multiplyScalar(speed * curvature);
}

/**
 * One entry per car. `fixed` entries hold a pose (the grid); the rest advance along the
 * centreline at a constant speed, which preserves the composition exactly: every car
 * covers the same ground during the warm-up, so the gaps at the shutter are the gaps
 * that were authored.
 */
export class ScenarioRail {
  constructor(track) {
    this.track = track;
    this.entries = [];
    this.active = false;
    this._sample = track.surface?.createLocateResult?.() ?? track.sample(0);
    this._pose = makePose();
  }

  /**
   * `car` is optional and only used to author the ControlState of a rival: a car whose
   * pose is written every tick gives its driver nonsense to react to — the AI sees a
   * hairpin it can never reach and stands on the brakes at 310 km/h, and the composition
   * disappears behind four locked tyres. A railed rival therefore drives to the rail
   * instead of to the AI, which is the same deal the player already has in capture mode.
   */
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
      controls: null,
    };
    if (car && !car.isPlayer) {
      entry.controls = { ...RAIL_CONTROLS };
      // A car being dragged along at racing speed is a car on the power; a parked one
      // is stopped on the brakes.
      entry.controls.throttle = speed > 25 ? 1 : (speed > 1 ? 0.35 : 0);
      // No brake, ever: the rail already pins the pose, and a locked stationary wheel
      // reads as a smoking tyre to the effects system.
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
      quaternion: phys.state.quaternion.clone(),
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

  /** Called once per fixed step by the race director while a capture is running. */
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
        // A car on its grid box is not being driven by its wheels either: left to the
        // free-engine integrator it settled at 2310 rpm, which is below the idle speed
        // its own config declares and below anything a running V6 can hold.
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
        // Steer to the curvature the rail is actually following, so the front wheels of
        // the cars ahead point where the corner does. Curvature is positive for a left
        // turn and so is steer: both are rotations about the surface normal.
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

function applyEnvironment(ctx, setup, cameraMode) {
  if (Number.isFinite(setup.tod)) {
    ctx.settings?.set?.('timeOfDay', setup.tod);
    ctx.sky?.setTimeOfDay?.(setup.tod);
  }
  const weather = WEATHER[setup.weather];
  if (weather) {
    ctx.settings?.set?.('weather', weather.preset);
    ctx.sky?.setWeather?.(weather.values);
    // Snap rather than crossfade: a capture cannot wait two seconds for the sky.
    if (ctx.sky?.weather) Object.assign(ctx.sky.weather, weather.values);
  }
  if (cameraMode) ctx.cameraRig?.setMode?.(cameraMode);
}

/**
 * Place the field for `setup.scenario`. Returns the rail that holds the composition
 * together through the harness warm-up, or null when there is nothing to place.
 */
export function applyScenario(ctx, director, setup = {}) {
  const track = ctx.track;
  const cars = resolveCars(ctx);
  if (!track || cars.length === 0) return null;

  const name = PLACEMENTS[setup.scenario] ? setup.scenario : 'straight';
  const plan = PLACEMENTS[name];
  const speed = Math.max(0, Number.isFinite(setup.speed) ? setup.speed : 0);
  const capture = ctx.captureMode === true;
  // Only a rail run covers a predictable distance, so only a rail run gets a pre-roll.
  const warmup = capture && Number.isFinite(setup.warmup) ? setup.warmup : 0;

  applyEnvironment(ctx, setup, setup.camera ?? plan.camera);

  const rail = new ScenarioRail(track);
  rail.active = capture;

  if (name === 'grid') {
    placeGrid(track, cars, rail, director);
    director?.setupGridShot?.();
  } else {
    const placement = placeRunning(track, cars, rail, plan, speed, warmup, capture, director);
    director?.setupRunningShot?.(name, speed, placement);
  }

  return rail;
}

/**
 * Form the field up on the grid in the order it qualified. The director owns that order
 * — it is the same one the classification and the grid intervals are read from — so the
 * cars on the tarmac and the cars in the tower are one field, not two.
 */
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

/**
 * One plausible interval to the car ahead: most cars are stuck in a train a couple of
 * tenths from the gearbox in front, and every so often one has clear air.
 */
function randomInterval(rng) {
  return rng.next() < 0.62 ? rng.range(0.16, 0.55) : rng.range(0.9, 3.2);
}

/**
 * Fill `_intervals` with the seconds between each car of the tail and the one ahead of
 * it, and return how many were written.
 *
 * The race director owns the field's pace, so the spread its own race produced is the
 * answer; the loop below only covers a scenario placed without a director (a unit test,
 * a tool), and reproduces the same shape — mostly cars stuck in a train, occasionally a
 * stretch of clear air — rather than an even fan.
 *
 * `pace` is the speed the intervals are turned into metres at, and the whole tail is
 * scaled to fit if it would otherwise reach further back than the circuit is long.
 */
function trailIntervals(director, first, count, pace, lapLength) {
  if (count <= 0) return 0;
  _trailRng.seed(TRAIL_SEED ^ Math.imul(first + 1, 2654435761));

  let written = director?.fieldIntervals?.(first, count, _intervals) ?? 0;
  for (let j = written; j < count; j++) _intervals[j] = randomInterval(_trailRng);
  written = count;

  let total = 0;
  for (let j = 0; j < count; j++) total += _intervals[j];
  const limit = (lapLength * TRAIL_MAX_LAP_FRACTION) / pace;
  if (total > limit && total > 0) {
    // Compress uniformly: every interval keeps its share of the spread, so the field is
    // tighter but no more regular than the race that produced it.
    const scale = limit / total;
    for (let j = 0; j < count; j++) _intervals[j] *= scale;
  }
  return written;
}

/**
 * Returns the placement plan: the centreline distance every car was put down at, before
 * the wrap at the start line. The director needs it to work out which lap each car is
 * on — 200 m up the road from a player sitting near the line is a lap ahead, and a
 * classification built from the wrapped distance alone would put the leader last.
 */
function placeRunning(track, cars, rail, plan, speed, warmup, capture, director) {
  const base = Number.isFinite(plan.distance)
    ? plan.distance
    : cornerDistance(track, plan.corner, plan.fallbackDistance) + (plan.cornerOffset ?? 0);

  const pose = makePose();
  const sample = track.surface?.createLocateResult?.() ?? track.sample(0);
  const others = plan.others ?? [];
  const yaw = (plan.yawOffset ?? 0) * DEG_TO_RAD;
  const placement = [];
  const pace = Math.max(speed, TRAIL_MIN_SPEED);
  // The tail of the field resumes behind the rearmost car the composition places, at the
  // intervals the field spread hands over — the first of which is the gap from that car.
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
      if (lateral === undefined) {
        // Measured in from the left-hand edge: read the width where the car will sit.
        poseFromTrack(track, sample, distance, 0, 0, pose);
        lateral = -(pose.width + (spec.lateralFromEdge ?? 0));
      }
    } else {
      // Metres of road from an interval in seconds: the inverse of the conversion the
      // director does when it measures the gap back off the circuit. A field wider than
      // the buffer keeps drawing rather than stacking cars on top of each other.
      const interval = trailIndex < trailCount ? _intervals[trailIndex] : randomInterval(_trailRng);
      trailDistance -= interval * pace;
      trailIndex++;
      distance = trailDistance;
      lateral = (trailIndex & 1) === 0 ? -TRAIL_LATERAL : TRAIL_LATERAL;
      lateral += _trailRng.signed(TRAIL_LATERAL_JITTER);
      carSpeed = speed;
    }

    // Only the player carries the authored slip angle at full strength; the others get
    // a fraction of it so the pack does not read as a synchronised drift.
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
