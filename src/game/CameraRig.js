import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, smoothstep, wrap01, deltaT, DEG, RAD } from '../core/MathUtils.js';
import { resolveCars } from './Scenarios.js';

/**
 * Camera rig.
 *
 * The camera is the player's body. Everything here exists to make the car feel heavy:
 * a neck that lags acceleration instead of tracking it, eyes that lead into the apex,
 * a chassis that rattles over a kerb and goes quiet on clean asphalt, and a field of
 * view that opens as the speed builds. Every layer is deliberately under-driven — the
 * test is a still frame: if it looks tilted or seasick standing still, it is too strong.
 *
 * Modes: cockpit (the game's identity), helmet (adds real head-look), chase,
 * trackside (broadcast towers on the outside of the corner), replay (cinematic orbit).
 */

const MODES = ['cockpit', 'helmet', 'chase', 'trackside', 'replay'];

/** Neck response. ~1.4 Hz, critically damped: the head settles without a second swing. */
const NECK_OMEGA = 8.6;

/**
 * Metres of eye travel per g. Small on purpose — the driver is belted into the tub, and
 * Cockpit's own neck model is already moving the anchor these layers hang off. The
 * signs deliberately match that model so the two reinforce rather than cancel.
 */
const NECK_TRANSLATE_X = 0.010;
const NECK_TRANSLATE_Y = 0.006;
const NECK_TRANSLATE_Z = 0.011;
const NECK_TRANSLATE_LIMIT = 0.028;

/** Radians of head rotation per g, and their hard limits (1.6 deg roll, 1.3 deg pitch). */
const NECK_ROLL_PER_G = 0.0090;
const NECK_ROLL_LIMIT = 0.028;
const NECK_PITCH_PER_G = 0.0075;
const NECK_PITCH_LIMIT = 0.023;

/** Fraction of chassis roll the driver cancels by keeping his head upright. */
const HORIZON_LOCK = 0.18;

const LOOK_MAX = 12 * DEG;
const LOOK_MAX_HELMET = 16 * DEG;
const LOOK_MANUAL = 62 * DEG;

/**
 * Every FOV in this file is a HORIZONTAL angle, converted to the vertical angle Three
 * wants exactly once, in `_applyProjection`.
 *
 * This is not bookkeeping: `fov: 82` read as a vertical angle is 114 degrees across a
 * 16:9 frame, which is a fisheye. It magnifies everything close to the eye — it was
 * what dragged the halo's side rails into two bands across the top of the cockpit shot
 * and blew the front tyres up into slabs — while making the track itself look distant.
 * 82 degrees horizontal is the number a player means when they type 82, and it holds
 * its framing when the window is not 16:9 instead of cropping the sides away.
 */
function verticalFov(horizontalDeg, aspect) {
  const halfTan = Math.tan(clamp(horizontalDeg, 8, 150) * 0.5 * DEG);
  // The camera has no aspect until the first resize; 16:9 is the right guess for the
  // one frame that could otherwise be projected through a NaN.
  const a = Number.isFinite(aspect) && aspect > 0.2 ? aspect : 16 / 9;
  return 2 * Math.atan(halfTan / a) * RAD;
}

/**
 * Speed at which the FOV bonus is fully applied: 340 km/h.
 *
 * The bonus used to be 10 degrees, which put the cockpit at 92 degrees horizontal down
 * a straight. Everything within a metre of the eye is magnified by that: it is what
 * spread the halo rails into bands across the top of the frame and squared the front
 * tyres off into slabs, while the circuit itself only got further away. Four degrees
 * still reads as the world opening up under power without distorting the driver's own
 * car, which is the half of the frame the player looks at all race.
 */
const FOV_REF_SPEED = 340 / 3.6;
const FOV_SPEED_GAIN = 4.4;
const FOV_DRS_GAIN = 1.4;

const IMPACT_DECAY = 5.0;          // e-folds/s: a hit is gone in about 0.6 s
const IMPACT_IMPULSE_REF = 9000;   // N.s that saturates the shake

/** Suspension velocity, m/s, that saturates the road-surface shake. */
const SUSPENSION_REF = 1.35;

/**
 * Chase camera. The old arm aimed 2.6 m *past* the car through an 82-degree lens and,
 * because of the filter lag dealt with in `_integrateChase`, actually trailed it by
 * nearly 15 m: the subject came out 15 percent of the frame wide, low in an empty
 * expanse of tarmac, with no read on the rear wing, the floor or the diffuser.
 *
 * These are the numbers a broadcast operator holds. The arm is the same length, but it
 * is now the real length rather than a nominal one; the lens is long enough to compress
 * the background behind the car instead of pushing it to the horizon; the camera is
 * offset off the centreline for a three-quarter rear that shows the flank and the
 * floor; and the aim sits just under the car so the subject rides above the HUD rather
 * than through it. The car lands about 40 percent of the frame wide and 40 percent
 * tall, centred a little above the middle.
 */
const CHASE_DISTANCE = 7.4;        // metres behind the CG, 4.7 m behind the rear wing
const CHASE_STRETCH = 0.6;         // metres the arm gives up at racing speed
const CHASE_HEIGHT = 1.95;         // metres above the CG, i.e. 2.23 m above the road
const CHASE_SIDE = 1.35;           // metres right of the centreline: the three-quarter
const CHASE_AIM_AHEAD = 0.90;      // aim just forward of the CG, not past the nose
const CHASE_AIM_RISE = -0.10;      // and a touch under it, which lifts the car off the HUD
const CHASE_FOV_SCALE = 0.62;      // 51 degrees horizontal off an 82-degree setting

/**
 * Broadcast towers.
 *
 * The previous rig stood 5.2 m up and a fixed 11.5 m out from the *track edge*, which on
 * this circuit is not a position — it is whatever the barrier table happens to put there.
 * On the main straight the armco is authored 10.5 m out, so the platform ended up one
 * metre behind a four-metre debris fence with its eye 1.2 m over the top rail, looking
 * 96 m down the road on a 13-degree lens. The consequences were all one consequence: the
 * sightline to the car grazed the fence for eighty of those ninety-six metres, the posts
 * ran from the middle of the frame to the bottom of it, and the car — a 3.6 m apparent
 * width in a 22 m frame — came out six percent wide. The review called it "framed from
 * behind a steel debris fence, the two race cars thumbnail-sized", which is exactly what
 * the numbers say it was.
 *
 * What replaces it is the geometry an outside-broadcast platform is actually built to.
 *
 *  - It is placed off the *barrier line*, found per station by probing `surfaceAt`
 *    outward until the surface reads `wall`, not off the track edge. Two metres clear of
 *    the barrier keeps it inside the three-metre grandstand setback and is the closest a
 *    tower ever stands.
 *  - It is 9 m up, which is 5 m over the top of a 4 m catch fence. The ray from the eye
 *    to a car on the far side of the road crosses the fence line 13 percent of the way
 *    along it, at 7.9 m, and clears the top rail by four metres; for a car hugging the
 *    near edge the crossing is a quarter of the way along, at 7.4 m, and it still clears
 *    by three. 6.4 m was tried and is worse: two metres of clearance is not enough at
 *    this lens, and the near fence's top rail comes back up through the middle of the
 *    frame and cuts the subject in half. It does not buy sky either — what is above the
 *    far side of this circuit is grandstand, not horizon.
 *  - It leads by 58 m rather than 96, and hands over to the next tower while the car is
 *    still 20 m short, so the shot is always the approach and never a fly-by.
 *  - The lens holds 17 m of scene across the frame instead of 6.5 m clamped up to 13
 *    degrees. That is a 23-degree lens at the far end of the run and 40 at the near one,
 *    and it is what puts the car at a quarter of the frame width all the way through.
 *    Measured on the reviewed frame: 24.5 percent, against 6 percent in round 5.
 *  - Because that lens holds a fixed *world* width, the frame is a fixed 17 x 9.6 m at
 *    the subject however far away it is, so the aim rise is a fixed composition rather
 *    than a distance-dependent one.
 *
 * The composite result is that the near fence is reduced to a diagonal across the bottom
 * corner. Its top rail only crosses the horizontal field between 3 m and 12 m ahead of
 * the tower, and by 12 m ahead it has fallen 22 degrees below the horizon against a
 * lower frame edge at 15 — so what is left of it is a sliver of foreground, which is
 * what a television frame actually contains. The far-side fence stays where it belongs,
 * behind the cars and across the circuit, which is also where its mesh has to read.
 */
const TRACKSIDE_LEAD = 58;         // metres the tower sits ahead of the car
const TRACKSIDE_HANDOVER = 20;     // ...and how close the car gets before the next one
const TRACKSIDE_HEIGHT = 9.0;      // metres above local ground: 5 m over the fence top
const TRACKSIDE_FENCE_CLEAR = 2.0; // metres the platform stands outside the barrier line
const TRACKSIDE_OFFSET_MIN = 7.0;  // ...clamped to this much beyond the track edge
const TRACKSIDE_OFFSET_MAX = 17.0; // ...and no further, or the shot loses the circuit
const TRACKSIDE_WALL_PROBE = 26.0; // metres of run-off searched for the barrier line
const TRACKSIDE_WALL_STEP = 1.5;   // coarse march before the bisection refines it
const TRACKSIDE_SUBJECT = 17.0;    // metres of scene the lens holds across the frame
const TRACKSIDE_AIM_RISE = 1.05;   // aim above the CG, which drops the car below centre
const TRACKSIDE_OPERATOR_LEAD = 0.06; // seconds the operator is ahead of the subject
const TRACKSIDE_FOV_MIN = 15;
const TRACKSIDE_FOV_MAX = 40;

/**
 * Composition presets.
 *
 * A driver's head is not a tripod bolted to the centreline. He looks across the grid at
 * the car beside him, turns into the corner before he gets to it, and lifts his eyes to
 * the sky when the light goes. Every one of those is a different, better-composed frame
 * than the same dead-centre symmetric shot repeated, and none of them is a camera trick:
 * the bias below is a head pose, applied on top of the neck and the steering-driven
 * head-look rather than instead of them.
 *
 * A preset is selected by name through `setComposition`, or resolved from the capture
 * harness's own scenario parameters — the same ones `RaceDirector.applyScenario` reads —
 * so one reviewed frame per scenario gets its own viewpoint. Angles are degrees;
 * positive yaw is to the left, positive pitch is up. `fov` multiplies the player's own
 * field-of-view setting, so a preset changes the lens without overriding the player.
 */
const COMPOSITIONS = {
  neutral: { yaw: 0, pitch: 0, offset: [0, 0, 0], fov: 1.00 },
  // Lights out: the head is turned across the grid at the car on the row alongside.
  grid: { mode: 'cockpit', yaw: -9, pitch: -1.5, offset: [0.032, 0.008, 0], fov: 1.00 },
  // Flat out down the straight, eyes left onto the grandstand side of the circuit.
  straight: { mode: 'cockpit', yaw: 5, pitch: 1.0, offset: [-0.024, 0, 0], fov: 0.98 },
  // Hard on the brakes: eyes already at the turn-in point, chin down on the marker.
  braking: { mode: 'cockpit', yaw: -12, pitch: -3.0, offset: [0.034, -0.010, 0], fov: 1.02 },
  // Mid-corner, with the car rotated: the head is looking out of the far side of the
  // visor at the exit, which is where the steering-driven look is already pointing.
  apex: { mode: 'helmet', yaw: -4, pitch: -1.0, offset: [-0.030, 0, 0], fov: 0.97 },
  // Wheel to wheel: the shot is about the car alongside, not about the road ahead.
  pack: { mode: 'cockpit', yaw: -14, pitch: 0.5, offset: [0.036, 0, 0], fov: 1.03 },
  // Low sun: raked across the halo and the visor rather than flat behind the frame.
  sunset: { mode: 'cockpit', yaw: 15, pitch: 2.4, offset: [-0.036, 0.012, 0], fov: 0.96 },
  // Rain: down into the spray coming off the car ahead.
  wet: { mode: 'cockpit', yaw: -8, pitch: -1.6, offset: [0.028, 0, 0], fov: 1.00 },
  // Under the lights: eyes up, so the floodlights and the sky are in the frame.
  night: { mode: 'helmet', yaw: 7, pitch: 1.8, offset: [-0.024, 0.010, 0], fov: 0.99 },
};

const WET_WEATHER = new Set(['wet', 'rain', 'storm']);

function buildComposition(spec) {
  return {
    mode: spec.mode ?? null,
    yaw: (spec.yaw ?? 0) * DEG,
    pitch: (spec.pitch ?? 0) * DEG,
    offsetX: spec.offset?.[0] ?? 0,
    offsetY: spec.offset?.[1] ?? 0,
    offsetZ: spec.offset?.[2] ?? 0,
    fov: spec.fov ?? 1,
  };
}

const COMPOSITION_CACHE = new Map();

function composition(name) {
  const spec = COMPOSITIONS[name] ?? COMPOSITIONS.neutral;
  let built = COMPOSITION_CACHE.get(spec);
  if (!built) {
    built = buildComposition(spec);
    COMPOSITION_CACHE.set(spec, built);
  }
  return built;
}

/**
 * The three lighting variants of the main straight are one placement under three skies,
 * so the scenario name alone cannot tell them apart — the time of day and the weather
 * the harness asked for are what distinguish them, and they are the reason each wants a
 * different frame in the first place.
 */
function compositionFor(params) {
  const explicit = params.get('composition');
  if (explicit && COMPOSITIONS[explicit]) return explicit;

  const scenario = params.get('scenario');
  if (!scenario) return 'neutral';
  if (scenario === 'straight') {
    if (WET_WEATHER.has(params.get('weather'))) return 'wet';
    // Number(null) is 0, which is a perfectly finite midnight: a scenario that never
    // asked for a time of day must not be framed as a night shot.
    const tod = params.has('tod') ? Number(params.get('tod')) : NaN;
    if (Number.isFinite(tod)) {
      if (tod >= 19.5 || tod < 6.5) return 'night';
      if (tod >= 16.8) return 'sunset';
    }
    return 'straight';
  }
  return COMPOSITIONS[scenario] ? scenario : 'neutral';
}

/** Fallback eye point, car-local, when a car has no Cockpit (AI cars, spectator seats). */
const EYE_FALLBACK_Y = 0.44;
const EYE_FALLBACK_Z = -0.30;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _carPos = new THREE.Vector3();
const _carQuat = new THREE.Quaternion();
const _carScale = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _aimTarget = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _shakeQuat = new THREE.Quaternion();

/**
 * Hash-based value noise. Filtered noise, not a sine: a sine reads as a machine
 * oscillation, whereas road texture is broadband and never repeats a period.
 */
function hash1(n) {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return ((h >>> 0) / 2147483648) - 1;
}

function valueNoise(seed, x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const base = seed * 1013;
  return lerp(hash1(i + base), hash1(i + 1 + base), u);
}

/**
 * Three octaves of road texture: body float, tyre patter, and the buzz that comes up
 * the steering column. The top octave lands near 38 Hz at full amplitude, which is as
 * fast as a 60 Hz frame can carry without aliasing into a strobe.
 */
function roadNoise(seed, phase) {
  return valueNoise(seed, phase * 4.0)
    + 0.55 * valueNoise(seed + 7, phase * 9.5)
    + 0.30 * valueNoise(seed + 19, phase * 21.0);
}

export class CameraRig {
  static systemName = 'cameraRig';

  constructor() {
    this.mode = 'cockpit';
    this.camera = null;
    this.viewProjection = new THREE.Matrix4();
    this.viewProjectionPrev = new THREE.Matrix4();

    this._neck = new Float64Array(3);
    this._neckVel = new Float64Array(3);
    this._look = 0;
    this._lookManual = 0;
    this._shake = 0;
    this._shakeScale = 1;
    this._shakePhase = 0;
    this._stationFov = 34;
    this._impact = 0;
    this._impactPitch = 0;
    this._fov = 0;
    this._near = 0.06;
    this._orbit = 0;
    this._elapsed = 0;

    this._chasePos = new THREE.Vector3();
    this._chaseAim = new THREE.Vector3();
    this._chaseValid = false;
    this._stationPos = new THREE.Vector3();
    this._stationAim = new THREE.Vector3();
    this._stationT = -1;
    this._stationValid = false;
    this._stationSeated = false;

    this._composition = composition('neutral');
    this.compositionName = 'neutral';
    this._modeLocked = false;

    this._locate = null;
    this._surface = null;
    this._sample = null;
    this._cut = true;
    this._vpValid = false;
    this._player = null;
    this._anchor = null;
  }

  async init(ctx) {
    this.ctx = ctx;
    this.camera = ctx.camera;
    this._fov = ctx.settings?.get?.('fov') ?? 82;

    const params = new URLSearchParams(globalThis.location?.search ?? '');
    const requested = params.get('camera');
    if (requested && MODES.includes(requested)) {
      // An explicitly requested camera outranks whatever the composition would pick:
      // the chase and trackside frames are asked for by name.
      this.mode = requested;
      this._modeLocked = true;
    }
    this.setComposition(compositionFor(params));

    this._onMode = (payload) => {
      if (payload?.mode && MODES.includes(payload.mode)) this.setMode(payload.mode);
      else if (payload?.cycle !== false) this.cycle();
    };
    this._onCollision = (payload) => this._registerImpact(payload);
    ctx.events?.on('camera:mode', this._onMode);
    ctx.events?.on('car:collision', this._onCollision);

    // Scratch results for the track queries, allocated once through the track's own
    // factories so the layout matches whatever TrackSurface hands back.
    const track = ctx.track;
    if (track?.surface?.createLocateResult) {
      this._locate = track.surface.createLocateResult();
      this._surface = track.surface.createSurfaceResult();
      this._sample = track.surface.createLocateResult();
    } else if (track) {
      this._locate = track.locate(this.camera.position);
      this._surface = track.surfaceAt(this.camera.position);
      this._sample = track.sample(0);
    }

    this._bindPlayer(ctx);
  }

  /** The mode list, in cycle order — the HUD labels the active one. */
  get modes() {
    return MODES;
  }

  /**
   * Select a composition preset by name. Unknown names fall back to `neutral`, so a
   * scenario the table does not cover is framed straight ahead rather than not at all.
   */
  setComposition(name) {
    this._composition = composition(name);
    this.compositionName = COMPOSITIONS[name] ? name : 'neutral';
    if (this._composition.mode && !this._modeLocked) this.setMode(this._composition.mode);
    this._cut = true;
  }

  setMode(mode) {
    if (!MODES.includes(mode) || mode === this.mode) return;
    this.mode = mode;
    this._chaseValid = false;
    this._stationValid = false;
    this._stationT = -1;
    this._lookManual = 0;
    this._cut = true;
    this.ctx?.events?.emit('camera:changed', { mode });
  }

  cycle() {
    const i = MODES.indexOf(this.mode);
    this.setMode(MODES[(i + 1) % MODES.length]);
  }

  _bindPlayer(ctx) {
    const cars = resolveCars(ctx);
    this._player = cars.length > 0 ? cars[0] : null;
    this._anchor = this._player?.cockpit?.cameraAnchor ?? null;
    return this._player;
  }

  _playerState(ctx) {
    if (ctx.vehicle?.state) return ctx.vehicle.state;
    return this._player?.physics?.state ?? null;
  }

  _registerImpact(payload) {
    const impulse = payload?.impulse ?? 0;
    if (impulse <= 0) return;
    const energy = clamp01(impulse / IMPACT_IMPULSE_REF);
    if (energy <= this._impact) return;
    this._impact = energy;
    // A nose-first hit throws the head down; a rear hit snaps it back.
    this._impactPitch = payload?.section === 'rear' ? energy : -energy;
  }

  update(dt, ctx) {
    if (!this._player || !this._anchor) this._bindPlayer(ctx);
    this._elapsed += dt;
    this._orbit += dt;

    const state = this._playerState(ctx);
    const settings = ctx.settings;
    const headScale = clamp(settings?.get?.('headMovement') ?? 1, 0, 2);
    const shakeScale = clamp(settings?.get?.('cameraShake') ?? 1, 0, 2);

    this._integrateNeck(dt, state);
    this._integrateLook(dt, state, ctx, headScale);
    this._integrateShake(dt, state, ctx, shakeScale);
    this._integrateFov(dt, state, settings);

    const impactDecay = this._impact > 1e-4 ? Math.exp(-dt * IMPACT_DECAY) : 0;
    this._impact *= impactDecay;
    this._impactPitch *= impactDecay;

    if (this.mode === 'chase') this._integrateChase(dt, ctx, state);
    else if (this.mode === 'trackside') this._integrateTrackside(dt, ctx, state);
  }

  /**
   * Second-order neck. Driving the head with a spring rather than a smoothing filter is
   * what produces the lag: the eye point is still moving outward a tenth of a second
   * after the car has taken the load, exactly as a helmet does on a real neck.
   */
  _integrateNeck(dt, state) {
    const gx = state ? state.gForce.x : 0;
    const gy = state ? state.gForce.y - 1 : 0;
    const gz = state ? state.gForce.z : 0;
    const target0 = -gx;
    const target1 = -gy;
    const target2 = gz;
    const w2 = NECK_OMEGA * NECK_OMEGA;
    const twoW = 2 * NECK_OMEGA;

    this._neckVel[0] += (w2 * (target0 - this._neck[0]) - twoW * this._neckVel[0]) * dt;
    this._neckVel[1] += (w2 * (target1 - this._neck[1]) - twoW * this._neckVel[1]) * dt;
    this._neckVel[2] += (w2 * (target2 - this._neck[2]) - twoW * this._neckVel[2]) * dt;
    this._neck[0] += this._neckVel[0] * dt;
    this._neck[1] += this._neckVel[1] * dt;
    this._neck[2] += this._neckVel[2] * dt;
  }

  _integrateLook(dt, state, ctx, headScale) {
    const controls = ctx.input?.controls;
    const speed = state ? Math.abs(state.speed) : 0;
    const steer = state ? state.steer : 0;
    const cap = this.mode === 'helmet' ? LOOK_MAX_HELMET : LOOK_MAX;

    // Below walking pace there is nothing to look into, and at speed the head barely
    // needs to move because the corner is already in the windscreen.
    const speedGate = smoothstep(6, 42, speed) * (1 - 0.35 * smoothstep(60, 95, speed));
    const target = clamp(-steer * cap * speedGate, -cap, cap) * headScale;
    this._look = damp(this._look, target, 6.5, dt);

    let manual = 0;
    if (controls) {
      if (controls.lookBack) manual = Math.PI;
      else manual = (controls.lookLeft ?? 0) * LOOK_MANUAL - (controls.lookRight ?? 0) * LOOK_MANUAL;
    }
    this._lookManual = damp(this._lookManual, manual, 11, dt);
  }

  /**
   * Road-surface shake. The inputs are physical: how fast the dampers are moving and
   * how coarse the surface under the car is. Smooth asphalt at 300 km/h is nearly
   * still; a kerb makes the frame rattle.
   */
  _integrateShake(dt, state, ctx, shakeScale) {
    let target = 0;
    if (state) {
      let susp = 0;
      for (let i = 0; i < 4; i++) {
        const w = state.wheels[i];
        const v = w.suspension.velocity;
        susp += v < 0 ? -v : v;
      }
      susp *= 0.25;

      let roughness = 0.05;
      const track = ctx.track;
      if (track && this._surface) {
        track.surfaceAt(state.position, this._surface);
        roughness = this._surface.roughness;
      }

      const speedGate = smoothstep(3, 30, Math.abs(state.speed));
      const kerb = state.kerbContact ? 0.55 : 0;
      const air = state.airborne ? 0.25 : 0;
      target = clamp01(susp / SUSPENSION_REF) * (0.30 + roughness * 1.35) + kerb + air;
      target = clamp01(target) * speedGate;
    }
    // Asymmetric: a kerb strike must arrive on the frame it happens, and fade out.
    const rate = target > this._shake ? 26 : 7;
    this._shake = damp(this._shake, target, rate, dt);
    this._shakeScale = shakeScale;
    this._shakePhase += dt * (0.7 + this._shake * 1.1);
  }

  _integrateFov(dt, state, settings) {
    const base = settings?.get?.('fov') ?? 82;
    let target = base * this._composition.fov;
    if (this.mode === 'chase') target = base * CHASE_FOV_SCALE;
    else if (this.mode === 'trackside') target = this._stationFov;
    else if (this.mode === 'replay') target = 36;

    if (this.mode !== 'trackside' && this.mode !== 'replay') {
      const speed = state ? Math.abs(state.speed) : 0;
      const t = clamp01(speed / FOV_REF_SPEED);
      // Slightly super-linear so the last 60 km/h are where it really opens up.
      target += FOV_SPEED_GAIN * (t * t * (3 - 2 * t) * 0.55 + t * 0.45);
      if (state?.drs.open) target += FOV_DRS_GAIN;
      target += this._impact * 1.4;
    }
    // Trackside zooms fast because it is a real lens; the cockpit eases.
    const rate = this.mode === 'trackside' ? 6 : 2.6;
    this._fov = damp(this._fov, target, rate, dt);
  }

  _integrateChase(dt, ctx, state) {
    const car = this._player;
    if (!car || !state) return;
    _carPos.copy(state.position);
    _carQuat.copy(state.quaternion);

    _fwd.set(0, 0, -1).applyQuaternion(_carQuat);
    // Flatten the follow axis: inheriting body roll in a chase camera reads as a bug.
    _fwd.y *= 0.35;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    // World-flat right, so the three-quarter offset does not roll with the chassis.
    _up.set(0, 1, 0);
    _right.crossVectors(_fwd, _up);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();

    const speed = Math.abs(state.speed);
    const back = CHASE_DISTANCE + smoothstep(0, 90, speed) * CHASE_STRETCH;
    _desired.copy(_carPos).addScaledVector(_fwd, -back);
    _desired.addScaledVector(_right, CHASE_SIDE);
    _desired.y += CHASE_HEIGHT;

    // Only enough clearance to keep the lens out of the asphalt: any more and the camera
    // climbs off a crest and loses the low, heavy angle the shot is built on.
    const ground = ctx.track?.heightAt?.(_desired.x, _desired.z);
    if (Number.isFinite(ground) && _desired.y < ground + 0.85) _desired.y = ground + 0.85;

    _aimTarget.copy(_carPos).addScaledVector(_fwd, CHASE_AIM_AHEAD);
    _aimTarget.y += CHASE_AIM_RISE;

    if (!this._chaseValid) {
      this._chasePos.copy(_desired);
      this._chaseAim.copy(_aimTarget);
      this._chaseValid = true;
    }
    // Tighter at speed so the car cannot outrun the arm on the straight.
    const follow = 6.0 + smoothstep(0, 90, speed) * 5.0;

    // Lead both targets by one time constant of their own filter.
    //
    // This is the whole reason the hero shot was a speck in an empty car park. An
    // exponential filter chasing a target that moves at a constant v settles a fixed
    // v/k behind it and never catches up: at 80 m/s with k = 11 the arm sat 7.3 m
    // further back than CHASE_DISTANCE asked for, and the aim point — filtered at 9 —
    // trailed 8.9 m, landing on bare asphalt behind the car and tipping the subject up
    // out of the middle of the frame. Feeding the target forward by v/k cancels that
    // steady-state error exactly, so the framing at 300 km/h is the framing that was
    // authored, and the filters go back to doing only what they are for: absorbing
    // kerbs, slides and gear changes. Transients still move the camera — the arm pushes
    // in under braking and stretches on the exit — because feed-forward only cancels
    // the constant-velocity term. The vertical filter is deliberately the slower of the
    // two, to soak up kerbs, so it gets its own, larger lead.
    const leadFlat = 1 / follow;
    const leadRise = 1 / (follow * 0.7);
    _v.copy(state.velocity);
    this._chasePos.x = damp(this._chasePos.x, _desired.x + _v.x * leadFlat, follow, dt);
    this._chasePos.y = damp(this._chasePos.y, _desired.y + _v.y * leadRise, follow * 0.7, dt);
    this._chasePos.z = damp(this._chasePos.z, _desired.z + _v.z * leadFlat, follow, dt);

    _aimTarget.addScaledVector(_v, 1 / 9);
    this._chaseAim.x = damp(this._chaseAim.x, _aimTarget.x, 9, dt);
    this._chaseAim.y = damp(this._chaseAim.y, _aimTarget.y, 9, dt);
    this._chaseAim.z = damp(this._chaseAim.z, _aimTarget.z, 9, dt);
  }

  /**
   * Broadcast towers. Each station is planted on the outside of whatever the car is
   * about to drive through, a fixed distance up the road, so the shot always opens on
   * the car approaching rather than departing.
   */
  _integrateTrackside(dt, ctx, state) {
    const track = ctx.track;
    if (!track || !state || !this._locate || !this._sample) return;

    track.locate(state.position, this._locate);
    const carT = this._locate.t;
    const lead = TRACKSIDE_LEAD / track.length;

    // Metres of centreline from the car to the tower it is driving at. Signed: a tower
    // the car has already passed reads negative, which is the first case below.
    const gap = deltaT(carT, this._stationT) * track.length;

    // Two reasons to hand over, and the second one is the bug that made this shot
    // unreadable for five rounds.
    //
    // The first is the ordinary one: the car is within TRACKSIDE_HANDOVER of the tower,
    // so cut to the next one before the shot becomes a steeply-down fly-by.
    //
    // The second is that the car is *further* away than a tower was ever planted. A
    // station is only ever seated `lead` ahead, so a gap above that means the subject
    // moved without driving there — a scenario placement, a session reset, a pit-lane
    // teleport, a car put back on the circuit after a spin. The capture harness does
    // exactly this: `applyScenario` seats the field 400 m back up the road *after* the
    // rig has already planted its first tower, and with no re-seat the camera then held
    // that stale tower for the whole run-up. Measured on the round-5 build the shutter
    // opened with the car 144 m from a station meant to be 96 m from it, on a lens
    // clamped hard against its long stop — which is precisely the "two race cars,
    // thumbnail-sized" the review reported, and no amount of reframing fixes it while
    // the camera is standing somewhere the framing never assumed.
    if (!this._stationValid || gap < TRACKSIDE_HANDOVER || gap > TRACKSIDE_LEAD + 2) {
      this._placeStation(track, wrap01(carT + lead));
    }

    _aimTarget.copy(state.position);
    // Lead the subject slightly — a human operator is never behind, and an approaching
    // car belongs a little back from centre with the road it is arriving on ahead of it.
    // The second term is the aim filter's own steady-state lag at this speed, which it
    // cancels exactly, so what is left is the operator's lead and nothing else. The old
    // 0.12 s was authored against a 13-degree lens 96 m out; on a 23-degree lens at 40 m
    // the same 9.6 m of lead is most of a half-frame and throws the car off the edge.
    _aimTarget.addScaledVector(state.velocity, TRACKSIDE_OPERATOR_LEAD + 1 / 7.5);
    _aimTarget.y += TRACKSIDE_AIM_RISE;
    if (!this._stationValid) {
      this._stationAim.copy(_aimTarget);
      this._stationValid = true;
    }
    this._stationAim.x = damp(this._stationAim.x, _aimTarget.x, 7.5, dt);
    this._stationAim.y = damp(this._stationAim.y, _aimTarget.y, 7.5, dt);
    this._stationAim.z = damp(this._stationAim.z, _aimTarget.z, 7.5, dt);

    // A constant subject width: the lens opens as the car arrives so that the same
    // TRACKSIDE_SUBJECT metres of scene span the frame at every point of the run, which
    // is what holds the car at a quarter of the frame width from 58 m down to 20. Over
    // that range this solves to 16-36 degrees and never reaches either clamp; the clamps
    // are there for the corner cases, a car stopped beside a tower or one three hundred
    // metres away because the station has not handed over yet.
    const dist = Math.max(8, this._stationPos.distanceTo(state.position));
    this._stationFov = clamp(
      2 * Math.atan(TRACKSIDE_SUBJECT * 0.5 / dist) * RAD,
      TRACKSIDE_FOV_MIN, TRACKSIDE_FOV_MAX,
    );
    // A cut is a different camera, not the same one racking its zoom across 20 degrees
    // in a sixth of a second. Snapping on the cut is both what a gallery looks like and
    // what makes the framing at any moment of the run a function of where the car is
    // rather than of how the last shot happened to end.
    if (this._stationSeated) {
      this._stationSeated = false;
      this._fov = this._stationFov;
    }
  }

  /**
   * Where the barrier line is, in metres from the centreline, on one hand of a station.
   *
   * `surfaceAt` is the only public thing on Track that knows: it reports `wall` for any
   * point at or beyond the authored barrier offset, and that offset varies from 3.4 m
   * behind the pit wall to 36 m behind a tyre stack at Blanchimont. A coarse march
   * outward finds the first sample that reads `wall`, then five bisections resolve it to
   * under 5 cm — which is well inside the tolerance a two-metre standoff needs.
   *
   * Called once per tower placement, roughly twice a second, and allocation-free: the
   * probe writes into the same pre-allocated surface result `_integrateShake` uses,
   * which has already been read by the time this runs.
   */
  _wallOffset(track, s, side) {
    const out = this._surface;
    const fallback = s.width + TRACKSIDE_OFFSET_MAX;
    if (!out || typeof track.surfaceAt !== 'function') return fallback;

    // Written out rather than closed over a helper: this runs off `update`, where
    // CONTRACT §8.1 forbids allocation, and a closure per placement is an allocation.
    let lo = s.width;               // on the racing surface: never a wall
    let hi = 0;
    for (let a = s.width + TRACKSIDE_WALL_STEP; a <= s.width + TRACKSIDE_WALL_PROBE;
      a += TRACKSIDE_WALL_STEP) {
      _v.copy(s.position).addScaledVector(s.right, side * a);
      track.surfaceAt(_v, out);
      if (out.type === 'wall') { hi = a; break; }
      lo = a;
    }
    if (hi === 0) return fallback;
    for (let i = 0; i < 5; i++) {
      const mid = (lo + hi) * 0.5;
      _v.copy(s.position).addScaledVector(s.right, side * mid);
      track.surfaceAt(_v, out);
      if (out.type === 'wall') hi = mid;
      else lo = mid;
    }
    return hi;
  }

  /**
   * Plant a tower. Outside of the corner, clear of the fence, above the top rail.
   *
   * Side: curvature is positive for a left turn, so the camera belongs on the right of
   * one. On a straight the old rule alternated on a hash of `t`, which is arbitrary and
   * put half the shots on the pit wall — 3.4 m of run-off, a building immediately behind
   * the lens and no circuit in the background. The roomier hand is both the side a real
   * platform stands on and the side that has the grandstands opposite it.
   */
  _placeStation(track, t) {
    const s = track.sample(t, this._sample);
    let side;
    if (Math.abs(s.curvature) > 0.0025) {
      side = s.curvature > 0 ? 1 : -1;
    } else {
      side = this._wallOffset(track, s, 1) >= this._wallOffset(track, s, -1) ? 1 : -1;
    }

    // Stand off the barrier, not off the track edge. The clamp keeps the platform out of
    // a pit lane at one extreme and out of the middle of a 30 m run-off at the other;
    // where the barrier is further out than the clamp allows the camera simply ends up
    // inside the barrier line, which is a clean sightline by construction.
    const wall = this._wallOffset(track, s, side);
    const offset = clamp(
      wall + TRACKSIDE_FENCE_CLEAR,
      s.width + TRACKSIDE_OFFSET_MIN,
      s.width + TRACKSIDE_OFFSET_MAX,
    );
    _v.copy(s.position).addScaledVector(s.right, side * offset);
    const ground = track.heightAt(_v.x, _v.z);
    _v.y = (Number.isFinite(ground) ? ground : s.position.y) + TRACKSIDE_HEIGHT;
    this._stationPos.copy(_v);
    this._stationT = t;
    this._stationSeated = true;
    this._cut = true;
  }

  lateUpdate(alpha, ctx) {
    const camera = this.camera;
    if (!camera) return;
    if (!this._player || !this._anchor) this._bindPlayer(ctx);

    switch (this.mode) {
      case 'cockpit':
      case 'helmet':
        this._applyCockpit(ctx);
        break;
      case 'chase':
        this._applyChase();
        break;
      case 'trackside':
        this._applyTrackside();
        break;
      default:
        this._applyReplay(ctx);
        break;
    }

    this._applyProjection(camera);
    this._commitMatrices(camera, ctx);
  }

  _applyCockpit(ctx) {
    const camera = this.camera;
    const anchor = this._anchor;
    const state = this._playerState(ctx);
    const headScale = clamp(ctx.settings?.get?.('headMovement') ?? 1, 0, 2);

    if (anchor) {
      if (camera.parent !== anchor) {
        anchor.add(camera);
        this._cut = true;
      }
    } else {
      if (!state) return;
      if (camera.parent) {
        camera.removeFromParent();
        this._cut = true;
      }
    }

    // The helmet cam sits a fraction higher and further forward than the neutral eye
    // point, and its head is allowed to move more, because the player asked for it.
    const helmet = this.mode === 'helmet';
    const gain = helmet ? 1.45 : 1.0;

    const tx = clamp(this._neck[0] * NECK_TRANSLATE_X * gain, -NECK_TRANSLATE_LIMIT, NECK_TRANSLATE_LIMIT);
    const ty = clamp(this._neck[1] * NECK_TRANSLATE_Y, -NECK_TRANSLATE_LIMIT, NECK_TRANSLATE_LIMIT);
    const tz = clamp(this._neck[2] * NECK_TRANSLATE_Z, -NECK_TRANSLATE_LIMIT, NECK_TRANSLATE_LIMIT);

    const amp = this._shake * this._shakeScale;
    const impact = this._impact * this._shakeScale;
    const phase = this._shakePhase;
    const nx = roadNoise(1, phase);
    const ny = roadNoise(2, phase);
    const nz = roadNoise(3, phase);
    const nr = roadNoise(4, phase);

    const comp = this._composition;
    const offsetX = tx * headScale + nx * amp * 0.006 + comp.offsetX;
    const offsetY = ty * headScale + ny * amp * 0.016 + (helmet ? 0.020 : 0) + comp.offsetY;
    const offsetZ = tz * headScale + nz * amp * 0.004 + (helmet ? -0.055 : 0) + comp.offsetZ;

    let pitch = clamp(this._neck[2] * -NECK_PITCH_PER_G, -NECK_PITCH_LIMIT, NECK_PITCH_LIMIT) * headScale;
    let roll = clamp(this._neck[0] * -NECK_ROLL_PER_G, -NECK_ROLL_LIMIT, NECK_ROLL_LIMIT) * headScale;

    // Horizon lock: a driver holds his head upright against part of the body roll.
    if (state && headScale > 0) {
      _right.set(1, 0, 0).applyQuaternion(state.quaternion);
      _up.set(0, 1, 0).applyQuaternion(state.quaternion);
      const bodyRoll = -Math.atan2(_right.y, _up.y);
      roll += clamp(bodyRoll * HORIZON_LOCK, -0.09, 0.09) * headScale;
    }

    pitch += ny * amp * 0.0100 + this._impactPitch * 0.035 + comp.pitch;
    roll += nr * amp * 0.0120 + impact * roadNoise(6, phase * 3) * 0.02;
    const yaw = this._look + this._lookManual + nx * amp * 0.0070
      + impact * roadNoise(5, phase * 3) * 0.015 + comp.yaw;

    if (anchor) {
      camera.position.set(offsetX, offsetY, offsetZ);
      camera.rotation.set(pitch, yaw, roll, 'YXZ');
      return;
    }

    // No Cockpit on this car: rebuild the same pose in world space off the chassis.
    _euler.set(pitch, yaw, roll, 'YXZ');
    _q.setFromEuler(_euler);
    camera.quaternion.copy(state.quaternion).multiply(_q);
    _v.set(offsetX, EYE_FALLBACK_Y + offsetY, EYE_FALLBACK_Z + offsetZ)
      .applyQuaternion(state.quaternion);
    camera.position.copy(state.position).add(_v);
  }

  _applyChase() {
    const camera = this.camera;
    if (camera.parent) {
      camera.removeFromParent();
      this._cut = true;
    }
    if (!this._chaseValid) return;
    camera.position.copy(this._chasePos);
    camera.up.set(0, 1, 0);
    camera.lookAt(this._chaseAim);
    this._applyWorldShake(camera, 0.55);
  }

  _applyTrackside() {
    const camera = this.camera;
    if (camera.parent) {
      camera.removeFromParent();
      this._cut = true;
    }
    if (!this._stationValid) return;
    camera.position.copy(this._stationPos);
    camera.up.set(0, 1, 0);
    camera.lookAt(this._stationAim);
    // A tower camera is on a tripod with a long lens: the only movement is the
    // operator's hand, and the longer the lens the more it magnifies it.
    const gain = 0.28 * (52 / Math.max(12, this._fov));
    _euler.set(
      roadNoise(11, this._elapsed * 0.35) * 0.0016 * gain,
      roadNoise(12, this._elapsed * 0.31) * 0.0022 * gain,
      0,
      'YXZ',
    );
    _shakeQuat.setFromEuler(_euler);
    camera.quaternion.multiply(_shakeQuat);
  }

  _applyReplay(ctx) {
    const camera = this.camera;
    const state = this._playerState(ctx);
    if (camera.parent) {
      camera.removeFromParent();
      this._cut = true;
    }
    if (!state) return;

    const angle = this._orbit * 0.21;
    const radius = 9.2 - 1.4 * Math.sin(this._orbit * 0.07);
    const height = 1.55 + 0.75 * Math.sin(this._orbit * 0.13 + 1.1);

    _v.set(Math.sin(angle) * radius, height, Math.cos(angle) * radius);
    _v.add(state.position);
    const ground = ctx.track?.heightAt?.(_v.x, _v.z);
    if (Number.isFinite(ground) && _v.y < ground + 0.5) _v.y = ground + 0.5;

    camera.position.copy(_v);
    camera.up.set(0, 1, 0);
    _aimTarget.copy(state.position);
    _aimTarget.y += 0.35;
    camera.lookAt(_aimTarget);
    this._applyWorldShake(camera, 0.35);
  }

  /** Shake for the unparented modes, applied after lookAt so it is a true offset. */
  _applyWorldShake(camera, weight) {
    const amp = (this._shake * weight + this._impact) * this._shakeScale;
    if (amp < 1e-4) return;
    const phase = this._shakePhase;
    _euler.set(
      roadNoise(21, phase) * amp * 0.0055 + this._impactPitch * 0.02,
      roadNoise(22, phase) * amp * 0.0045,
      roadNoise(23, phase) * amp * 0.0065,
      'YXZ',
    );
    _shakeQuat.setFromEuler(_euler);
    camera.quaternion.multiply(_shakeQuat);
  }

  _applyProjection(camera) {
    // Near plane per mode: the cockpit needs 6 cm to avoid clipping the wheel rim,
    // while the distant modes buy depth precision by pushing it out.
    const near = this.mode === 'cockpit' || this.mode === 'helmet' ? 0.06
      : this.mode === 'chase' ? 0.30 : 1.0;
    // `_fov` is horizontal; the aspect is read live so a resize reframes rather than
    // crops, and the vertical angle Three needs falls out of the two.
    const fov = clamp(verticalFov(this._fov, camera.aspect), 8, 120);
    if (Math.abs(camera.fov - fov) > 0.002 || camera.near !== near) {
      camera.fov = fov;
      camera.near = near;
      camera.updateProjectionMatrix();
    }
  }

  /**
   * The pipeline reprojects last frame's pixels for motion blur and TAA, so the camera
   * has to be final — matrixWorld included — before render() is entered, and the
   * previous frame's view-projection has to survive the cut check.
   */
  _commitMatrices(camera, ctx) {
    if (camera.parent) camera.parent.updateWorldMatrix(true, false);
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    if (this._vpValid && !this._cut) this.viewProjectionPrev.copy(this.viewProjection);
    this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (!this._vpValid || this._cut) this.viewProjectionPrev.copy(this.viewProjection);

    const pipeline = ctx.pipeline;
    if (pipeline) {
      pipeline.setPreviousViewProjection?.(this.viewProjectionPrev);
      // A hard cut has no valid history; without this the first frame of a new camera
      // smears the whole screen through the motion blur.
      if (this._cut && '_prevMatricesValid' in pipeline) pipeline._prevMatricesValid = false;
    }
    this._vpValid = true;
    this._cut = false;
  }

  resize() {}

  dispose() {
    this.ctx?.events?.off?.('camera:mode', this._onMode);
    this.ctx?.events?.off?.('car:collision', this._onCollision);
    this.camera?.removeFromParent();
    this._player = null;
    this._anchor = null;
  }
}
