# APEX — Module Interface Contract

**This file is authoritative.** Every module must conform to the signatures below so that
subsystems developed in parallel integrate without modification. Do not change a public
signature without updating this file in the same commit.

---

## 0. Global conventions

### Units
| Quantity | Unit |
|---|---|
| Distance | metres |
| Time | seconds |
| Mass | kilograms |
| Force | newtons |
| Torque | newton-metres |
| Angle | radians (except where a field name ends in `Deg`) |
| Speed | metres/second (`speed`); `speedKph` is derived for display only |
| Engine speed | rev/min (`rpm`) |

### Coordinate frames
* World frame is Three.js default: **+Y is up**, right-handed.
* **Car local frame: `-Z` = forward, `+X` = right, `+Y` = up.**
  This matches the Three.js camera convention, so a cockpit camera parented to the car
  body with an identity quaternion looks out of the windscreen with no correction.
* Wheel indices are **always** `0 = front-left, 1 = front-right, 2 = rear-left, 3 = rear-right`.

### Module style
* ES modules, `export class` / `export function`. No default exports.
* `import * as THREE from 'three';` — addons from `three/examples/jsm/...`.
* No top-level side effects other than `const` tables. Construction happens in `init()`.
* Never call `renderer.render()` outside `RenderPipeline`.

---

## 1. System lifecycle

Every subsystem is a class implementing this shape. `Engine` drives them in registration order.

```js
class SomeSystem {
  static systemName = 'someSystem';   // key it is exposed under on ctx
  async init(ctx) {}                  // may be async; awaited before the loop starts
  update(dt, ctx) {}                  // fixed-step logic (dt is the fixed step)
  lateUpdate(alpha, ctx) {}           // per-frame, alpha = interpolation factor [0,1)
  resize(width, height, ctx) {}       // on viewport change
  dispose() {}
}
```

`ctx` (the shared context object) has:

```js
ctx = {
  engine,        // Engine
  renderer,      // THREE.WebGLRenderer
  scene,         // THREE.Scene
  camera,        // THREE.PerspectiveCamera  (the cockpit camera)
  canvas,        // HTMLCanvasElement
  ui,            // HTMLElement  (#ui-root) — all DOM UI mounts here
  input,         // Input
  settings,      // Settings
  events,        // EventBus
  time: { elapsed, dt, frame, alpha },
  quality,       // resolved quality tier object (see §7)

  // Populated by systems as they init, keyed by static systemName:
  track,         // Track
  vehicle,       // VehiclePhysics  (the player car)
  cars,          // Car[]           (index 0 is the player)
  materials,     // MaterialLibrary
  sky,           // SkySystem
  pipeline,      // RenderPipeline
  fx,            // EffectsSystem
  audio,         // AudioEngine
  hud,           // HUD
  race,          // RaceDirector
}
```

### EventBus
```js
events.on(name, fn) -> unsubscribe
events.off(name, fn)
events.emit(name, payload)
```
Reserved event names: `race:start`, `race:lap`, `race:sector`, `race:finish`, `car:offtrack`,
`car:kerb`, `car:collision`, `car:shift`, `car:lockup`, `car:wheelspin`, `car:drs`,
`quality:change`, `camera:mode`.

---

## 2. Track — `src/track/Track.js`

Owned by the **track** subsystem. Everything else consumes it read-only.

```js
export class Track {
  static systemName = 'track';

  async init(ctx)

  // --- geometry queries (hot path — must be allocation-free) ---

  /** Centreline curve, arc-length parameterised. */
  curve            // THREE.CatmullRomCurve3
  length           // number — centreline length in metres
  name             // string
  country          // string

  /**
   * Sample the centreline at normalised arc length t in [0,1).
   * Writes into `out` and returns it. MUST NOT allocate.
   */
  sample(t, out = {}) -> {
    position: Vector3, tangent: Vector3, normal: Vector3, right: Vector3,
    width: number,        // half-width of racing surface, metres
    banking: number,      // radians, positive = right side lower
    curvature: number,    // 1/metres, signed (+ = left turn)
    gradient: number,     // radians, + = uphill
  }

  /**
   * Project a world position onto the track. MUST NOT allocate. Hot path: called
   * ~5x per car per physics step.
   */
  locate(worldPos, out = {}) -> {
    t: number,             // normalised arc length [0,1)
    distance: number,      // metres along centreline
    lateral: number,       // signed metres from centreline, + = right
    onTrack: boolean,      // |lateral| <= width
    position: Vector3,     // closest point on centreline
    tangent: Vector3, right: Vector3, normal: Vector3,
    width: number, banking: number,
  }

  /**
   * Surface properties under a world position. MUST NOT allocate.
   * `grip` is a multiplier on tyre peak force: asphalt 1.0, kerb 0.85,
   * astroturf 0.55, grass 0.38, gravel 0.30.
   */
  surfaceAt(worldPos, out = {}) -> {
    height: number,        // world Y of the surface
    normal: Vector3,       // surface normal
    grip: number,
    type: 'asphalt'|'kerb'|'astroturf'|'grass'|'gravel'|'concrete'|'wall',
    roughness: number,     // 0..1, drives suspension noise + rumble audio
    drag: number,          // extra rolling resistance coefficient off-track
  }

  /** World-Y of the drivable surface only — cheap path for suspension rays. */
  heightAt(x, z) -> number

  // --- race structure ---
  racingLine       // THREE.CatmullRomCurve3 — AI + ghost reference
  startGrid        // [{ position: Vector3, quaternion: Quaternion }] — 20 slots
  sectors          // [number, number, number] — normalised t of sector boundaries
  drsZones         // [{ detect: number, start: number, end: number }]
  pitLane          // { entry: number, exit: number, curve: CatmullRomCurve3, speedLimit: number }
  corners          // [{ t, name, number, apexT, entryT, exitT, radius }]

  /** Scene graph for all static track geometry. Added to ctx.scene by Track itself. */
  group            // THREE.Group
}
```

**Collision:** barriers are queried through `surfaceAt` returning `type: 'wall'`, plus
`Track.barrierCollide(worldPos, radius, out)` returning `{hit, normal, penetration}` or `null`.

---

## 3. Vehicle physics — `src/physics/VehiclePhysics.js`

Owned by the **physics** subsystem.

```js
export class VehiclePhysics {
  constructor(config)     // config: CarConfig, see src/physics/CarConfig.js

  /** Advance one fixed step. `controls` is a ControlState (§4). */
  step(dt, controls, track)

  reset(position, quaternion)

  state = {
    position: Vector3, quaternion: Quaternion,
    velocity: Vector3,          // world m/s
    angularVelocity: Vector3,   // world rad/s
    localVelocity: Vector3,     // car frame m/s (-Z forward)
    speed: number,              // forward m/s (signed)
    speedKph: number,
    accel: Vector3,             // car-frame acceleration, m/s^2
    gForce: Vector3,            // car-frame, in g (x = lateral, y = vertical, z = longitudinal)

    rpm: number, gear: number,  // gear: -1 = reverse, 0 = neutral, 1..8
    throttle: number, brake: number, steer: number, clutch: number,
    engineTorque: number, wheelTorque: number,
    shiftTimer: number, limiterActive: boolean,

    wheels: [ WheelState x4 ],

    aero: { downforceFront, downforceRear, drag, balance, stalled },
    drs:  { open: boolean, available: boolean, zoneActive: boolean },
    ers:  { charge: 0..1, deploy: 0..1, harvestMGUK: number, harvestMGUH: number, mode: 0..3 },
    fuel: number,               // kg
    brakeTemp: [f, f, f, f],    // celsius

    onTrack: boolean, surfaceGrip: number, kerbContact: boolean,
    airborne: boolean, damage: { front, rear, floor },
  }
}

// WheelState
{
  worldPosition: Vector3, worldQuaternion: Quaternion,
  steerAngle: number, spinAngle: number, angularVelocity: number,
  slipRatio: number,          // (wheelSpeed - roadSpeed) / |roadSpeed|
  slipAngle: number,          // radians
  load: number,               // newtons, >= 0
  fx: number, fy: number,     // tyre forces in wheel frame, newtons
  contact: boolean,
  suspension: { compression: 0..1, travel: number, velocity: number },
  temperature: { surface, core },   // celsius
  wear: number,               // 0 = new, 1 = destroyed
  surface: string,            // surface type under this wheel
  lockup: number,             // 0..1
  spin: number,               // 0..1
}
```

Physics runs at a **fixed 240 Hz** substep inside a 120 Hz system tick (see `Engine`).

---

## 4. Input — `src/core/Input.js` (owned by core)

```js
export class Input {
  static systemName = 'input';
  /** ControlState, freshly filled each tick. */
  controls = {
    throttle: 0..1, brake: 0..1, steer: -1..1, clutch: 0..1,
    shiftUp: boolean,   // edge-triggered, consumed by physics
    shiftDown: boolean,
    drs: boolean, ers: boolean, pitLimiter: boolean,
    lookLeft: 0..1, lookRight: 0..1, lookBack: boolean,
    reset: boolean,
  }
  isDown(action) -> boolean
  wasPressed(action) -> boolean
}
```

---

## 5. Rendering

### `src/render/RenderPipeline.js` — **the only place `renderer.render` is called**
```js
export class RenderPipeline {
  static systemName = 'pipeline';
  async init(ctx)
  render(ctx)                       // called by Engine once per frame, after lateUpdate
  resize(width, height, ctx)
  setQuality(tier)                  // 'low' | 'medium' | 'high' | 'ultra'
}
```
Required chain, in order: render → GTAO/SSAO → motion blur → bloom → tonemap+grade
(ACES-derived filmic, LUT-capable) → chromatic aberration + lens distortion → vignette →
film grain → SMAA/TAA → output. Motion blur consumes a velocity buffer; the pipeline owns it.

### `src/render/MaterialLibrary.js`
```js
export class MaterialLibrary {
  static systemName = 'materials';
  async init(ctx)
  get(name) -> THREE.Material       // cached, shared
  texture(name) -> THREE.Texture    // procedurally generated, cached
}
```
All textures are generated procedurally (no binary assets in the repo). Every surface
material must supply `map`, `normalMap`, `roughnessMap` and, where relevant, `aoMap`.
Colour textures use `SRGBColorSpace`; data textures (normal/roughness/AO) use `NoColorSpace`.

### `src/render/SkySystem.js`
```js
export class SkySystem {
  static systemName = 'sky';
  async init(ctx)
  setTimeOfDay(hours)               // 0..24
  setWeather(w)                     // { cloudCover 0..1, rain 0..1, windSpeed, windDir }
  environment                       // PMREM-filtered THREE.Texture, assigned to scene.environment
  sunLight                          // THREE.DirectionalLight  (the sun; owned by SunShadow)
  sunDirection                      // THREE.Vector3
}
```

---

## 6. Other subsystems

```js
// src/car/Car.js
export class Car {
  constructor(ctx, { config, livery, isPlayer })
  physics                 // VehiclePhysics
  group                   // THREE.Group — the visual car
  cockpit                 // Cockpit | null (player only)
  update(dt, ctx)
  lateUpdate(alpha, ctx)  // visual interpolation, wheel spin, suspension, steering
}

// src/car/Cockpit.js  — first-person interior: halo, wheel, mirrors, driver arms
export class Cockpit {
  constructor(ctx, car)
  group
  cameraAnchor            // THREE.Object3D — the camera parents here
  update(dt, ctx)         // wheel rotation, display refresh, head bob/g-force lean
}

// src/fx/EffectsSystem.js
export class EffectsSystem {
  static systemName = 'fx';
  async init(ctx)
  update(dt, ctx)
  // Emitters driven from vehicle state: tyre smoke, lock-up smoke, kerb sparks,
  // floor sparks, gravel/grass debris, rain spray, brake glow, exhaust heat haze.
}

// src/audio/AudioEngine.js  — fully procedural (WebAudio), no sample files
export class AudioEngine {
  static systemName = 'audio';
  async init(ctx)
  resume()                // must be called from a user gesture
  update(dt, ctx)
}

// src/ai/AIDriver.js
export class AIDriver {
  constructor(car, track, { skill 0..1, aggression 0..1 })
  update(dt, ctx) -> ControlState
}

// src/ui/HUD.js  — DOM + canvas overlay, mounts into ctx.ui
export class HUD {
  static systemName = 'hud';
  async init(ctx)
  update(dt, ctx)
}

// src/game/RaceDirector.js
export class RaceDirector {
  static systemName = 'race';
  async init(ctx)
  update(dt, ctx)
  standings              // [{ car, position, gap, lap, lastLap, bestLap, sectors }]
  session                // { type, state, lap, totalLaps, timeElapsed, flag }
}
```

---

## 7. Quality tiers

`ctx.quality` is one of the tiers in `src/core/Settings.js`:

```js
{ name, pixelRatio, shadowMapSize, cascades, anisotropy, ssao, motionBlur,
  bloom, taa, particleBudget, crowdDetail, mirrorResolution, reflections }
```

Systems read `ctx.quality` in `init` and react to the `quality:change` event.

---

## 8. Determinism & performance rules

1. **No allocation in `update`/`lateUpdate`/`step`.** Pre-allocate scratch vectors as
   module-level `const _v = new THREE.Vector3()`. This is enforced by review.
2. Physics is deterministic given `(state, controls, dt)` — no `Math.random()` inside `step`.
   Use the seeded `Rng` from `src/core/Rng.js` for anything stochastic.
3. Target: **60 fps at 1920×1080 on `high`**. Frame budget 16.6 ms; render ≤ 11 ms.
4. Draw calls ≤ 400. Use instancing for crowds, trees, barriers, fences, kerb segments.
5. Every `dispose()` must release geometries, materials, textures and render targets.
