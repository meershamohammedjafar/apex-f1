# APEX Technical Notes

Knowledge extracted from in-source commentary before the comment-removal pass.
This document is the authoritative record of every bug workaround, justified
constant, and do-not-do trap that previously lived in comments. File references
are given for every entry. Companion documents: CONTRACT.md (interfaces),
docs/JOURNAL.md (history).

---

## 1. Global conventions

- **Car local frame**: -Z forward, +X right, +Y up, origin at the CG
  (CONTRACT.md §0). Wheel order is always [FL, FR, RL, RR]. Because -Z is
  forward, any basis built from a forward tangent uses the *reversed* tangent as
  its Z column (`src/game/Scenarios.js` poseAt, `src/ai/AIDriver.js` marshal
  teleport, `src/track/Track.js` grid slots).
- **World frame**: +X east, -Z north, +Y up — matches SkySystem's solar azimuth
  convention (azimuth clockwise from north). `src/track/CircuitData.js`.
- **Track curvature sign**: positive = left turn (CONTRACT.md). In a
  right-handed +Y-up frame a left turn is a *negative* cross product, so signs
  flip when computing Menger curvature (`src/ai/RacingLine.js`) and when
  deriving curvature from clockwise-from-north heading (`src/track/TrackSurface.js`:
  a right turn increases heading, so left-turn-positive curvature is the
  negative of the heading delta).
- **Lateral sign**: positive lateral is metres right of the centreline. The
  inside of a left-hander is the negative-lateral side (`src/ai/RacingLine.js`).
- **Tyre/slip conventions** (`src/physics/TyreModel.js`): +x forward along
  wheel heading, +y right; `kappa = (omega*R - Vx)/|Vx|` (positive drive,
  negative braking); `alpha = atan(-Vy/|Vx|)` (positive slipping left);
  `gamma` positive when the wheel top leans toward world +X; Fx > 0
  accelerates, Fy > 0 pushes the car right.
- **Body livery wrap UV** (`src/car/Teams.js`, shared with CarModel lofts):
  u around the section (0 = underside centreline, 0.25 = right flank, 0.5 =
  spine, 0.75 = left flank); v = 0 at the front-wing leading edge, 1 at the
  rear-wing trailing edge. `BODY_V_FRONT = -2.62`, `BODY_V_REAR = 3.01` map
  car-z to wrap v. One 2:1 canvas is a genuine unwrapped livery.
- **Texture orientation** (`src/render/textures/NoiseTextures.js`): every
  Float32Array field uses `index = y*width + x` with row 0 at v = 0, matching
  THREE.DataTexture (flipY ignored). Canvas content is row-flipped on import
  (`readCanvas`) so ALL textures share one orientation. Mixing flipY=true
  colour with flipY=false normals mirrors lighting against artwork — very hard
  to see, very easy to ship.
- **Timing model** (`src/core/Engine.js`, `src/main.js`): fixed 120 Hz tick
  (`update`), physics substeps at 240 Hz internally, presentation at display
  rate with `lateUpdate(alpha)` interpolation. System registration order = update
  order: input → track → cars (physics) → race → camera → fx → audio → hud →
  pipeline (pipeline last so it renders finished state).
- **Allocation rules**: no allocation in `update`/hot paths (CONTRACT §8.1).
  Track queries write into caller-supplied `out` objects; hot-path callers
  hoist via `createLocateResult`/`createSurfaceResult`. Timing, physics,
  velocity-buffer history, HUD and tower per-frame code are all allocation-free
  by design; several places deliberately avoid closures (e.g. CameraRig barrier
  probe is written out inline because a closure per tower placement is an
  allocation).
- **Determinism**: `src/core/Rng.js` — seeded mulberry32 PRNG used instead of
  Math.random so runs are reproducible and screenshots of a given seed are
  comparable across builds. Shared instance `rng` (seed 20260827) for
  non-physics procedural work. RaceDirector gives the starter's light-delay its
  own RNG stream so the grid must not shift because the starter chose a
  different hold time, and vice versa.

---

## 2. Critical bug workarounds (engine/three.js level)

### 2.1 three.js r185 PCFSoftShadowMap trap — `src/core/Engine.js` (_createRenderer)
three r185 removed PCFSoftShadowMap: WebGLShadowMap silently rewrites it to
PCFShadowMap on the first shadow render, but programs compiled before that
(the up-front `renderer.compile` in `src/main.js`) are built with the BASIC
shadow define and declare `sampler2D` where the depth texture is created in
comparison mode. That mismatch makes the driver reject every shadow-receiving
draw. **Ask for the shadow type the renderer is going to use anyway
(PCFShadowMap), never PCFSoftShadowMap.**

### 2.2 One shadow render per presented frame — `src/core/Engine.js`
`renderer.shadowMap.autoUpdate = false`; the cockpit mirror pass and the main
scene pass both call `WebGLRenderer.render`, and with autoUpdate on the sun's
shadow map would be rasterised twice per frame for an identical result.
`present()` re-arms `needsUpdate` each frame; it starts armed so renders during
init still get a real shadow map. Consequence: whichever render call sees the
flag first builds the map — see §2.4 for the ordering trap this creates.

### 2.3 `ctx.time.frame` is stamped in `present()`, not `_tick()` — `src/core/Engine.js`
`frame` counts frames *drawn*. Systems use it to do per-frame work exactly once
even when the scene is walked several times per frame by the pipeline. The
capture harness drives `step`/`present` directly with the rAF loop stopped —
if the counter lived in `_tick` it would freeze for a whole headless capture
and every once-per-frame job would run once and never again. Also in `_tick`:
dt is clamped (GC pause / backgrounded tab must not teleport the car;
spiral-of-death guard) and a backlog is dropped rather than accumulated.

### 2.4 Shadow fit must run before ANY shadow rasterisation — `src/render/SkySystem.js` + `src/render/sky/CascadedShadows.js`
Under `shadowMap.autoUpdate = false` the map is built by whichever
`renderer.render` sees `needsUpdate` first — the cockpit mirror renders from
Car's lateUpdate, *ahead* of the pipeline. The fit therefore runs in
SkySystem's lateUpdate/top-of-frame, NOT the scene onBeforeRender hook, so the
published lookup matrix describes the map about to be built. The old guard
that skipped the refit when the flag was already consumed pinned the shadow
volume at the camera's frame-one position (mirror wins the race every frame in
cockpit) — a scene permanently outside its own shadow volume, i.e. no shadows
anywhere. Fitting early costs at most one frame of camera lag on a ~96 m
sphere (1.4 m at 310 km/h) and cannot desynchronise. The sky-dome recentre
DOES live in the scene hook (dome is a unit sphere on the eye; it vanishes if
the camera moves >1 m from where it was last placed) — guarded by frame counter
AND camera-moved test, never the counter alone.

### 2.5 SunShadow (`src/render/sky/CascadedShadows.js`) — the whole saga
The class is named CascadedShadows for import compatibility but is one
DirectionalLight, not a cascade. Recorded so nobody re-bisects it:

- **Why not a hand-rolled 4-light CSM**: the old rig re-weighted four
  direction-sharing DirectionalLights via an injected `lights_fragment_begin`.
  If the injection missed any material (clone, `onBeforeCompile` reassignment,
  three chunk edit moving splice markers) that material was silently lit by all
  four suns: 4x direct illuminance, contact shadow diluted to ~¼ strength —
  the washed-out shadowless image that shipped. A rig whose correctness depends
  on string replacement succeeding in 500 materials is not a rig.
- **Why a custom depth path**: in this scene `light.shadow.map`'s
  DEPTH_COMPONENT24 comparison-mode texture reads 1.0 at every texel (bisected:
  not the fit, bias, map size, caster flags or receivers; a minimal stock scene
  in the same renderer/process works). The colour attachment arrives intact,
  so casters get a `customDepthMaterial` that packs 24-bit depth across RGBA,
  `light.shadow.intensity = 0` so three's own (broken here) term multiplies by
  exactly 1.0 and can never double up, and a shader patch samples the colour
  attachment. 24-bit depth over the fit volume (sub-millimetre) vs 0.8 m/step
  from three's default 8-bit `1-z` packing.
- **APEX_UNPACK layout tripwire**: three moved `packDepthToRGBA` to
  red-most-significant order once already; the old inverse constant assumed
  alpha-most-significant, and because a cleared texel is (1,1,1,1) under either
  order the failure looked like "shadows too weak", not "reading a low byte".
  Under the old layout every texel a caster wrote unpacked to its own low
  byte: about half the taps compared lit and half shadowed, so the cast shadow
  came through as a faint dither (measured as "a localised dip").
  `APEX_UNPACK` is a local constant rather than relying on `<packing>`, so the
  patch compiles the same way whatever chunk set a material pulled in. It must
  equal three's `UnpackFactors4 = ((255/256)/PackFactors.rgb, 1/PackFactors.a)`
  with `PackFactors = vec4(1, 256, 256², 256³)`, red most significant
  (matches three 0.185.1). `assertPackingLayout()` runs at construction: it
  searches the whitespace-stripped `THREE.ShaderChunk.packing` for
  `PackFactors=vec4(1.0,256.0,` (the old layout was a vec3 starting at 256³)
  and issues a `console.warn` if it is missing. It warns once per module load
  (module-level `_packingChecked`) and does not throw.
- **Program cache key**: three's default key is `onBeforeCompile.toString()`,
  which after patching is one identical wrapper string for every material —
  all materials would share the first compiled program. The key is built from
  the caller's own inner-callback source plus the patch-set id instead. The
  patch-set registration happens before anything else at construction so the
  id (and cache key) is stable. **Consistent comment stripping is fine (the
  key derives from the live function source uniformly), but the key logic must
  keep working after any source transform.**
- **onBeforeCompile is an accessor pair, not a plain property**: eleven places
  outside this file assign `material.onBeforeCompile = ...` (Trackside.js ×7,
  Cockpit.js, Wheels.js, Weather.js, MaterialLibrary.js); a plain assignment
  would silently evict the patch while bookkeeping claims coverage. The
  getter/setter wrapper is what the renderer always reads; later assignments
  are captured as the *inner* callback. Idempotent, re-entrant across quality
  rebuilds: idempotence is keyed on the non-enumerable `__apexSunPatch`
  (`HOOK`) state property. The wrapper and key functions are named
  `apexOnBeforeCompile` and `apexProgramCacheKey`; no code checks a
  function's identity or `.name`.
- **Injection strategy**: the directional-light chunk is taken from
  `THREE.ShaderChunk` at patch time (not transcribed) and the sun-shadow term
  is folded in right after `getDirectionalLightInfo`. If three changes so the
  replace no-ops, the frame loses its shadows — a visible regression — rather
  than multiple-counting the light, which is the whole reason the term is a
  patch and not extra lights.
- **shadowSide**: three rasterises a stock FrontSide caster's *back* faces into
  the shadow map; open shells (grandstand roof, fascia, wing planes) have no
  back face and cast nothing. Measured on cockpit-grid: 6.2% map occupancy
  with the default, 16.8% with DoubleSide — the difference is the entire
  grandstand. Casters with a null `shadowSide` are forced to DoubleSide; acne
  is handled by the normal-offset lookup and the receiver-plane depth
  prediction from the vertex patch instead (below).
- **Filtering**: packed depth must never be bilinearly interpolated (averages
  bytes of two different distances). Setting NearestFilter on the map texture
  does NOT achieve this on its own — three applies filter state while building
  the framebuffer and never revisits it. `apexFetch` samples at texel centres
  (exact texel even under a linear filter); the lookup does its own bilinear
  weighting of a 2x2 of the texel grid, giving an exactly one-texel penumbra
  (~4.7 cm on `high`) — deliberately narrow so the under-floor contact edge
  stays hard, weighted so it does not staircase.
- **Texel-grid PCF**: the bilinear weights (`apexW`) are applied to the four
  *comparisons*, not to the four depths, as a hardware comparison sampler
  does. Blending the packed bytes reads as a surface between the caster and
  the background. Not weighting at all quantises the term to five grey levels
  and paints the shadow-map grid across anything close enough to resolve a
  texel (e.g. a front tyre ~1.5 m from the eye).
- **Bias figures**: normalBias displaces the lookup along the surface normal;
  on a road lit from 30° up that slides the shadow edge sideways by
  normalBias/tan(elevation) ≈ 1.7x. The old 0.85-texel bias = 6.8 cm lateral
  slip + 1.6 cm depth vs the ~6 cm gap an F1 floor leaves — the cast shadow
  could not survive its own bias at the one place it matters.
- **Remaining receiver biases** (texel = `2·radius/mapSize` of the current
  fit): the lookup is offset along the world normal by `normalBias = 0.5
  texel`. Offsetting along the normal rather than in depth keeps near-grazing
  surfaces out of their own shadow without detaching the contact edge. The
  cast test is `step(planeZ - depthBias, depths)` with `depthBias = 0.15
  texel` of depth (`texel*0.15/(far-near)`, ~7 mm on `high`): about a sixth of
  a texel, where a slope-blind bias needed about a third of a metre.
  `uApexShadowParams` = (depthBias, normalBias, 1/mapSize, enabled).
- **Receiver-plane depth gradient** (`vApexShadowGrad`, vertex patch): the
  shadow-space depth the receiver gains per unit of shadow u and v if it
  carried on as the plane its normal describes. Each 2x2 tap's depth is
  predicted as `planeZ = coord.z + dot(vApexShadowGrad, offset)`, and both
  the cast test and the contact term compare against `planeZ`, not the
  fragment's own depth. Why: the 2x2 taps sit up to one texel from the
  lookup point on each axis (up to √2 ≈ 1.4 texels along the slope when
  it runs diagonally across the map), and on tarmac lit from 30° up one
  texel of lateral offset is ~1.7 texels of depth along the ray
  (1/tan 30°). Against the fragment's own depth the tarmac therefore reads
  as its own occluder: ~8 cm per texel of offset on `high` (4.7 cm texel),
  ~9.5 cm on `medium`/`ultra` (~5.5 cm) and ~18.5 cm on `low` (10.7 cm). A
  constant bias has to cover the farthest tap on every tier: up to
  ~11.5 cm on `high`, ~13 cm on `medium`/`ultra` and ~26 cm on `low` —
  about the whole ~120 mm ray gap under an F1 floor (60 mm floor at 30°) on
  `high`, and more than it on every other tier. Result: peter-panning, with no
  darkening at the contact patch while a dip survived a metre away. The
  plane prediction cancels the slope exactly, so the remaining bias only
  covers quantisation and curvature.
- Gradient source: the light is orthographic, so rows 0–2 of
  `uApexShadowMatrix` (`apexGu`/`apexGv`/`apexGz`) are the world gradients of
  u, v and depth and are mutually orthogonal. That makes the closed form
  valid, and taking them from the matrix means the gradient can never
  disagree with the map being sampled. An edge-on face has an unbounded
  slope, so `|n·Gz|` is clamped at `0.15·|Gz|` (normal within ~8.6° of
  edge-on). That caps the slope at ~6.6 m of depth per metre of lateral
  offset; beyond that the contact term is meaningless anyway.
- **Fit geometry**: fixed-radius sphere, `radius = clamp(shadowDistance·0.16,
  55, 110)` m, with `mapSize = resolveMapSize(shadowMapSize, cascades)` (the
  tier's square budget × cascade count, rounded down to a power of two in
  1024–4096) and texel = `2·radius/mapSize`. Per tier (`QUALITY_TIERS` in
  `src/core/Settings.js`): low 1024 map / 55 m → ~10.7 cm; medium 2048 /
  56 m → ~5.5 cm; high 4096 / 96 m → ~4.7 cm (same texel budget as 4×2048
  cascades); ultra 4096 / 110 m → ~5.4 cm. Centre snapped to whole shadow-map
  texels in a light-space basis
  derived from the sun direction alone (never the camera, or the snap is
  undone and edges crawl). Pushed forward by half the radius using the
  *horizontal* camera heading only (a glance at the sky must not swing the
  volume off the track). Light pulled back far enough that grandstands between
  sun and sphere still cast. `shadow.matrix` is derived at fit time from the
  just-written transforms (three recomputes the identical matrix later inside
  its own pass, which would otherwise be one frame stale).
- **Contact-shadow uniforms** (`uApexShadowContact`): x = depth range of the
  fit volume (m, `shadowCam.far - near`); y = contact falloff per metre, 3.2,
  applied as `exp(-lifted·y)` with `lifted = gap - contactBias` and multiplied
  by a smoothstep onset over `contactRise` (bias-free that is 0.68 at the
  0.12 m ray gap under a 60 mm floor at 30°, ≈0.72 on `high` after the 16 mm
  bias, 0.20 at 0.5 m, 0.04 at 1 m); z = ambient fraction a touching occluder
  removes — 0.85, not 0.62: under-floor tarmac sees a slit of sky, and at 0.62
  the tyre hovered; w = one shadow texel in world metres so self-occlusion
  guards behave identically at any map/fit combination. The contact term
  (ambient removal) fades out over the last ~4.6° of sun elevation
  (`clamp(sunDir.y/0.08, 0, 1)`) — unlike the cast term it would otherwise
  keep darkening all night under a meaningless sun direction.
- **Contact gap is in metres**: `gaps = (planeZ - depths) *
  uApexShadowContact.x` is how far in front of the receiver each tap's
  occluder sits along the sun ray. That is ~0.12 m under a 60 mm floor at 30°
  elevation and ~4 m under the shadow a wing mirror throws, so one number
  separates the contact patch from the body shadow without a second map or a
  screen-space trace.
- **Contact term is deliberately NOT gated on the cast `lit` result.** Where a
  tyre meets the road, occluder and receiver coincide. The depth bias pushes
  the reference past the occluder, the cast test reads lit, and the old
  `contact * (1.0 - lit)` fell to zero across the whole contact patch. The
  tyres then met the tarmac with no darkening while the broad shadow a metre
  away survived.
- `contactBias = 0.35 texel` (`uApexShadowContact.w * 0.35`, ~16 mm on
  `high`). The previous 0.75 texel (~35 mm on `high`) erased the one place the
  term exists for: tyre and road are the same distance from the sun, so the
  gap is ≈ 0, and any bias above the tyre's own rise puts the whole patch
  outside the term (the car hovers). With the plane prediction cancelling
  slope, only two things remain to cover: depth quantisation (~20 µm, i.e.
  2^24 steps over the ~336 m `high` depth range) and curvature across the
  ~1.5-texel tap radius.
- `contactRise = 0.5·contactBias + 0.01` m (~18 mm on `high`) is the
  smoothstep onset, and it must stay short. The term works over roughly the
  first 300 mm of gap, and a 100 mm fade-in left the tarmac under a floor at a
  third of the occlusion the geometry calls for. The ramp only has to stop the
  edge aliasing.
- Map-edge fade: the cast and contact terms both fade to unshadowed over the
  last 4% of the map (`smoothstep(0.46, 0.5, max |coord.xy - 0.5|)`). Ending
  the shadowed region on a hard line instead reads as a seam across the
  track.
- **The contact term removes ambient AND reflected sky, the latter weighted by
  roughness** (`AMBIENT_BODY`, spliced in just before
  `#include <lights_fragment_end>`). Under `RE_IndirectDiffuse` it does
  `irradiance`/`iblIrradiance *= apexContactAO`; under
  `RE_IndirectSpecular && STANDARD` it also does
  `radiance *= mix(1.0, apexContactAO, material.roughness)` (and
  `clearcoatRadiance` by `clearcoatRoughness`). Tarmac under a 60 mm floor
  cannot see the dome it mirrors. How much goes depends on lobe width: a
  mirror's narrow cone mostly misses a nearby occluder, while a rough surface
  gathers most of the hemisphere and loses what the hemisphere lost, so only
  near-mirror surfaces keep reflecting the sky. This term decides whether a
  shadowed road reads as asphalt in shade or as a grey wash. With specular
  left at full strength, the contact patch stayed milky and the shadows
  measured dark yet still looked pale.
- **One thing NOT this file's to fix**: at the scenarios' 15:12 the Spa sun
  stands 146° behind a car pointed up the pit straight
  (dot(cameraForward,sunDir) = -0.834, measured). Every shadow is thrown away
  from the eye behind its own caster; the road is lit everywhere the road is
  visible. No shadow implementation can fix that — the time of day has to move.

### 2.6 VelocityBuffer (`src/render/shaders/VelocityBuffer.js`)
Two-step velocity: fullscreen camera reprojection (exact for world-static
surfaces) + re-draw of registered dynamic hierarchies with their previous world
matrices. Step 2 is the correctness half: a cockpit rail 0.35 m from the lens
at 75 m/s reprojects to ~500 px of false motion per 25 ms shutter; one such
pixel poisons a whole 20×20 tile and the tile filter drags the background
across the cockpit. Everything rigidly carried by the car or camera must be
registered. Key rules:

- **Camera-attached geometry needs no special case** — its camera term cancels
  exactly in the general path, as long as the general path covers it. The
  camera itself is registered alongside the cars (visor surround, head-up
  furniture travel at 300 km/h while stationary on screen). Registration runs
  on the FIRST frame (a periodic sweep alone meant short sessions — captures,
  menus — could live and die without one).
- **Ownership test is two-sided** (fragment must *be* the depth-buffer surface
  within tolerance); one-sided rejection let unseen geometry stamp velocity
  over what was really there. The pass has no depth attachment.
- **Only depth-writing meshes are eligible**: a no-depth-write mesh (visor
  plane 9 cm from the lens, spray, HUD quads) owns no pixel; letting one in
  stamps its velocity across everything behind it — the visor alone would zero
  the entire buffer. Points/lines are excluded (velocity material declares no
  gl_PointSize).
- **Velocity is UV units per shutter, unjittered**, measured between the last
  two *simulated* states, not drawn ones. Each entry keeps two matrices
  (`latched`, `prev`); re-presenting a frozen frame reuses the pair instead of
  collapsing them — the collapse is what previously zeroed the buffer on any
  repeated present and left screenshots with no motion blur.
- **Jittered raster, unjittered velocity**: the object pass rasterises with
  the live (jittered) `projectionMatrix * viewMatrix`, so its manual depth
  test lines up with the main pass's depth buffer. The velocity itself comes
  from `uCurViewProj`/`uPrevViewProj` (RenderPipeline captures `_viewProjCur`
  before applying jitter). The camera pass unprojects with
  `uInvViewProjJittered` and subtracts `uJitterUv`.
- **Sky pinning**: the camera pass clamps depth to `0.99995` before
  unprojecting. The sky has no geometry to reproject; pinning it just short
  of the far plane gives it pure rotational velocity, which is what a panning
  camera sees.
- **Clip-w floor** (`APEX_MIN_CLIP_W = 1e-4` in `apexProjectUv`): perspective
  w is the view distance, so it crosses zero for a surface on the previous
  eye plane and goes negative behind it. Unguarded, the sign flip mirrors the
  point through the origin, so the velocity points backwards, and near zero
  it is unbounded. One such pixel wins its 20×20 tile, NeighbourMax spreads it
  a tile further each way, and ~60 px square of frame gather along an
  enormous backwards vector (the "veiling wash"). Flooring w keeps the
  projection on the correct side, pointing outward as a surface rushing past
  the lens really does; `apexClampVelocity` then bounds the length.
- **Teleport classification** (`advanceHistory`): a written pose is not motion.
  `Scenarios.js` placements and respawns jump hundreds of metres between
  consecutive matrices; differenced, that vector wins every tile it touches.
  A step is a teleport if: > `TELEPORT_STEP_RATIO` (8) times the previous
  accepted step (a rigid body at 5 g changes per-shutter displacement < 2%
  between shutters; only a frame-rate spike scales it, at worst ~3x); with a
  `TELEPORT_MIN_METRES` (2 m) floor so pull-away from rest (previous step 0)
  is not flagged; or > `TELEPORT_MAX_METRES` (50 m — 97 m/s over the longest
  0.5 s shutter the pipeline accepts) unconditionally; or the basis swings past
  `TELEPORT_BASIS_COS` (~30°/shutter = 900°/s — a spinning chassis does a tenth
  of that). A teleport collapses history onto the new pose: that frame reports
  exactly zero, the next measures one honest step. `entry.step` updates on
  every call so a discontinuity suppresses exactly one frame. Same bug class
  as the respawn that reported 583 km/h in first gear to the gameplay harness.
- **Instanced history** lives in a private `apexPrevInstanceMatrix` attribute,
  attached at registration and left attached (three uploads attribute buffers
  during the main pass from whatever is in `geometry.attributes` then; one
  swapped in at draw time has no buffer and binds as zero). A geometry already
  carrying a history belongs to another mesh — that mesh keeps it, this one
  falls back: it draws with `uPrevInstanceValid = 0`, uses its *current*
  instance matrix as history, and so reports only its parent object's rigid
  motion. Instance local translation > `1 m`/shutter
  (`MAX_INSTANCE_STEP_METRES`) = re-layout (damage swap, rebuilt link list),
  reported as its own history (zero velocity). Instance *rotation* past 6° per
  shutter (`MAX_INSTANCE_SPIN_COS = Math.cos(6°)`) is deliberately dropped —
  a rim turning 300°/25 ms has no straight streak; only its rigid translation
  is reported and MotionBlurShader's rotational filter handles the spin.
- **Batched meshes**: three publishes no previous batching matrix, so a
  `BatchedMesh` reports only the rigid motion of its batch root
  (`prevObjPos = batchingMatrix * prevObjPos`). Nothing in the project batches
  today (no `BatchedMesh` under `src/`).
- **Newly found meshes**: `obj.matrixWorld` at rescan time is last frame's
  value — correct history for an existing mesh, but for a mesh built THIS
  frame it is the constructor's identity, and taking that as history reports
  the whole world-origin→circuit distance as one shutter. So: compose the
  chain, keep the cached matrix as history only when it is within one shutter
  of travel, otherwise start from rest.
- **Cull side**: the pass matches each object's own material side per draw
  (read live in onBeforeRender, not cached — LOD/livery swaps change it),
  default DoubleSide for anything unreadable. `BackSide` maps to `DoubleSide`
  on purpose: `side === BackSide` sets three's `flipSided` define and would
  fork the program cache for a term this shader never reads.
- **`apexClampVelocity` is a sanity bound, not a look.** The target is
  `RGFormat`/`HalfFloatType` (largest finite value 65504). An overflowing
  velocity stores as Inf, which wins every TileMax comparison and becomes NaN
  when the blur rescales it. One such pixel blackens a neighbourhood and
  poisons TAA history, because the TAA resolve reads the same buffer. Any
  non-finite value is set to zero. The test is written `!(abs(v.x) < 1e6)` so
  that NaN, which compares false against everything, takes the reject branch.
  Everything else is limited to `uMaxVelocityPx = 2·sqrt(w²+h²)` (twice the
  frame diagonal, set in `setSize`): long enough that a clamped vector still
  carries a pixel off-frame in any direction, so the resolve's off-screen
  `prevUv` test (feedback = 0) still sees "no history"; short enough to keep
  a vanishing clip-w out of half-float overflow.

### 2.7 Motion-blur history latching — `src/render/RenderPipeline.js` (_advanceMotionHistory)
Roll motion history ONLY when the simulation advanced, and always before the
velocity pass reads it. The old code latched `prev = cur` after drawing,
unconditionally: drawing the same simulated state twice compared the camera
against itself, zeroed every reprojected velocity, the blur early-outed and the
frame was pin-sharp at 310 km/h. Not a capture-only quirk — any present without
a tick behind it (pause, menu, fps above tick rate) hit it. Everything
temporal keys off the *simulation* clock, not the wall clock, so a re-present
is treated as a re-present of the previous shutter, not a zero-length one.
Shutter divisor is guarded against scenario-reset clock jumps and
sub-millisecond spans. A camera cut (mode change/scenario reset) teleports the
lens: those metres are not speed — gate them or the first post-cut frame
flashes full-strength blur. Also: TAA history is invalidated on a hard cut
(CameraRig `_applyProjection` note: previous view-projection must survive the
cut check; a cut has no valid history and would smear the whole screen).

### 2.8 Uninitialised half-float targets — `src/render/RenderPipeline.js`
Half-float render targets come back from the driver with undefined contents.
The two read-before-written targets — exposure ping-pong and TAA history —
must be cleared to zero at (re)allocation or the first frame adapts to
garbage; the adaptation shader also has a `uReset`/first-frame adopt (see
§5.4). The godray shaft buffers are cleared too even on frames where shafts
are not rendered: intensity is zero, but Inf (undriven half-float) × 0 = NaN,
and one NaN pixel poisons the whole bloom pyramid.

### 2.9 HeatHaze / ScreenCapture — `src/fx/HeatHaze.js`
- **Capture source**: the haze quad draws inside the scene pass, into the
  pipeline's scene target, and cannot sample the target it is drawing into.
  So `HeatHaze.captureFrame` blits the PREVIOUS frame's linear-HDR scene
  colour (`RenderPipeline.sceneColorTexture`, §5.1) aside every frame it is
  needed (§10.1). One frame stale is invisible for low-frequency wobble. The
  capture never touches the drawing buffer, so it does not depend on
  `preserveDrawingBuffer`. That flag is on only with `?shot=1`
  (`src/core/Engine.js`); in live play the drawing buffer's contents after
  present are undefined. The old capture copied the presented,
  display-referred frame out of the default framebuffer, which was only
  defined under the screenshot harness.
- **Quad blit, not a framebuffer copy**: `ScreenCapture.capture(renderer,
  sourceTexture)` renders a fullscreen quad (`ApexSceneCopy`, NoBlending, no
  depth test or write) into a HalfFloat `WebGLRenderTarget` (texture name
  `ApexPreviousScene`) and then restores the previous render target. A
  half-float source needs a half-float destination, which the copy path
  cannot guarantee. Nothing under `src/` calls `copyTexSubImage2D` or
  `copyFramebufferToTexture` any more.
- **Sizing**: `captureFrame` sizes the capture and `uResolution` from
  `pipeline.width/height`. The haze quad draws into the scene target, so that
  size is what `gl_FragCoord` spans. During a resize a one-frame size
  mismatch only stretches the image; it does not raise a GL error. With no
  `ctx.pipeline` or no `sceneColorTexture` the capture never becomes ready:
  the haze stays hidden and the visor film gets no scene texture.
- `captureFrame` is separate from `commit` because the visor film refracts
  the same capture even when no haze source is active. `ready` needs two
  captured frames, or the first frame refracts black. `ScreenCapture.resize`
  returns early when the size is unchanged, so the count resets only on a
  real size change (or `dispose`). `sceneTexture` is null until then.
- **`sceneTexture` is also null while HeatHaze is disabled**
  (`this.enabled && this.capture.ready`). `captureFrame` stops refreshing
  the copy when haze is off (EffectsSystem gates it on `heat.enabled`,
  §10.1) while `capture.ready` stays true, so a mid-race drop to a tier
  without haze would otherwise leave the wet visor refracting a frozen
  frame. While enabled, `EffectsSystem.lateUpdate` runs the capture
  (`needScene` = enabled && (sources > 0 || rain > 0.02)) before it reads
  `sceneTexture` in the same frame, so `Weather._updateVisor` (drawn only
  from rain 0.02 up) gets that frame's capture once `ready` (2 frames after
  a resize). Re-enabling hands out no stale frame for the same reason.
- **Main camera only — `HAZE_LAYER` = 6** (exported): the mesh sits on
  layer 6 alone (`mesh.layers.set`) and the constructor enables that layer
  on `ctx.camera`. The `gl_FragCoord / uResolution` lookup assumes the
  pipeline's scene target. The cockpit mirrors (§6.2) render the whole
  scene from their own cameras into a 512 px target, where the same lookup
  lands on an unrelated corner of the main view and differences it into the
  glass. The player's own exhaust plume sits squarely in the left mirror:
  diff up to 83 levels before the layer, 0 after.
- Layer audit: the only other layer in use is `VELOCITY_LAYER` = 7 (§2.6).
  `VelocityBuffer.render` saves `camera.layers.mask`, draws layer 7 only and
  restores the mask, so layer 6 on the main camera survives. The haze mesh
  is a direct child of `ctx.scene`, not under the camera or a car group, so
  `registerDynamic` never tags it. The mirror cameras
  (`Cockpit._buildMirrors`) are fresh PerspectiveCameras with the default
  mask (layer 0 only): they skip the haze and still see everything else.
  The SkySystem CubeCamera renders the separate `_skyScene`. The only
  `renderer.render(scene, …)` calls are the main pipeline pass, the velocity
  pass, the mirrors and Engine's no-pipeline fallback (main camera, where
  the haze never becomes ready). Nothing else uses layer 6. A new camera
  that should see the haze must enable `HAZE_LAYER`; anything else put on
  layer 6 disappears from the mirrors too.
- **Difference composite**: each patch adds `(warped − flat) × uGain` (0.85)
  with additive blending. This adds nothing where the image is flat, so a
  patch can never show its own edges. `scene + (warped − flat)` rebuilds the
  displaced image ONLY because source and destination share a colour space.
  Never difference a tonemapped/display-referred frame into the linear HDR
  buffer: doing so caused the engine-cover "rainbow corruption" confetti over
  high-contrast livery (docs/JOURNAL.md, Aug 30).
- **Soft limiter**: `delta /= 1 + |delta| / (uDeltaMax · level)`, where
  level = mean luma of the two samples + 0.015. It covers the stale frame
  disagreeing with the current one (e.g. a moving car under the plume):
  there the difference is a colour error, not refraction. The limit is
  relative, not absolute, so it holds both in a dark underpass and against a
  bright HDR sky. `uDeltaMax = 0.35` is the asymptotic bound on |delta| as a
  fraction of the local level: hot air may brighten or darken a pixel by
  about a third of what is there. Beyond that it reads as chroma noise, not
  shimmer. Measured engine-cover speckle: 4.50% with haze on vs 4.88% off
  (`tools/speckle-oracle.mjs`, §3.7); with matched cameras 4.68% on, 5.04%
  off, 5.05% gain0; on the merged build (Oct 12) 3.86% on, 4.16% off,
  4.16% gain0.
- **Instance layout** (8 floats, `MAX_SOURCES` 40): `aCentre` = world
  position; `aParams` = (width, height, intensity, phase); `aScroll` = scroll
  rate. A NEGATIVE scroll marks a ground-lying layer (horizon mirage,
  `addHorizon` −0.22). A positive scroll marks a rising plume (exhaust 0.85,
  brake ducts 0.65). Rising plumes stretch the vertical offset ×1.6 and fade
  in from their lower edge (`smoothstep(0, 0.35, vUv.y)`). Ground layers
  compress it ×0.85 (`mix(0.85, 1.6, rising)`) and get no lower-edge fade.
- **Exhaust source** (`addCar`; `EXHAUST_LOCAL` [0, 0.315, 2.83]
  car-local, quad 0.85 × 1.25 m raised 0.34 m, intensity `gas × 0.7`):
  `gas = clamp01(0.18 + 0.62·throttle + 0.35·rpmTerm)`, `rpmTerm =
  clamp01((rpm − 4000) / 8000)`. Gas leaving a turbo V6 exit is ~700 C on
  power and still ~400 C on a trailing throttle, so the plume never dies
  off throttle: the 0.18 floor is the lifted-throttle plume.
- **Brake-duct sources** (`addCar`; front pair only, `DUCT_LOCAL` x ±0.72,
  quad 0.55 × 0.85 m raised 0.3 m, intensity `duct × 0.55`): `duct =
  clamp01((brakeTemp − 380) / 620)`, zero at 380 C, full at 1000 C,
  skipped at ≤ 0.02. Carbon brakes glow past ~900 C and shed a column of
  hot air straight up out of the duct, so the ramp is most of the way up
  (~0.84) by the time the disc glows. Exhaust and ducts both fade with
  camera distance (`1 − smoothstep(55, 90, distance)`); a car beyond 90 m
  adds nothing.
- **Horizon mirage** (`addHorizon`): `heat = smoothstep(0.30, 0.85,
  sunDir.y) × (1 − 0.8·cloudCover) × (1 − rain)`, nothing at ≤ 0.03. Only a
  high sun (elevation ~17°→58°) on a dry, clear day makes the road boil.
  Three bands planted on the road 60/115/170 m ahead along the camera's
  horizontal heading, 0.85 m above the ground, `range × 0.9` wide,
  2.4/3.6/4.8 m tall, intensity `heat × 0.42/0.33/0.24`, scroll −0.22.
- The two noise lookups at different scales and rates (uv×(1.7, 1.1) and
  uv×3.3, weights 0.72/0.44) are deliberate: one field reads as a texture,
  two read as turbulence.
- Source quads are billboarded in the vertex shader using the view matrix
  bound at draw time — reading the camera inverse on the CPU is a frame stale
  and smears at 300 km/h.

### 2.10 Weather visor film & puddles — `src/fx/Weather.js`
- **Visor film unit error**: `uScene` is HeatHaze's capture of the
  pipeline's previous-frame linear-HDR scene target (`HeatHaze.sceneTexture`,
  §2.9; null until two frames are captured, which sets `uHasScene` 0 and
  gives no refraction). It was originally the display-referred 0..1
  presented frame. The overlay is drawn into the HDR scene buffer where an
  overcast sky sits above 1.3 scene-referred, and *adding* a 0..1 difference
  there was a unit error (~a tenth of a stop, then compressed to nothing —
  three reviewers saw no droplets because in scene-referred terms there were
  none). Fix: the film **multiplies** — blend configured `dst * (1 + src)`,
  which is what a lens on glass physically does. A ratio has no units:
  correct at any exposure, bounded by construction, cannot run away frame
  over frame, and correct whether `uScene` is display-referred or linear
  HDR. Alpha is left exactly as the scene wrote it (later passes read it).
  Tint carries hue only (normalised to unit luminance) — a bright overcast
  must not double the gain behind the shader's back.
- **Visor `dropLayer`** returns xy = bead surface normal, z = coverage,
  w = meniscus ring. Run direction blends from gravity (straight down) at a
  standstill to up/outward with airflow (`uAirflow` = smoothstep(4, 46 m/s)).
  Airflow stretches the bead ALONG the drag direction (the along-flow
  distance is ÷ (1 + 2.1·airflow)). Squashing it in screen y instead reads as
  round beads sitting in a lattice.
- **Lattice hiding**: a third hash sizes each bead (radius 0.07–0.28 cell),
  and `step(0.40, h)` empties 2 cells in 5, so the cell grid never resolves
  visibly. The radius is floored at 1e-4 because smoothstep with coincident
  edges is undefined, and an emptied cell must give no bead, not NaN.
- Beads are hard-edged (inner stop 0.74 of the radius). An inner stop of
  0.35 turned beads into a soft smudge that reads as haze. The meniscus ring
  stays narrow (0.86–1.02 of the radius) because a wide ring reads as a halo.
- Scale 8.5 on aspect-widened uv gives ≈15 cells across a 16:9 frame (a
  coarse bead ≈12–50 px across at 720p). A second layer at scale 17 adds
  misting. At speed, airflow sweeps the visor centre clear: wetness drops by
  up to 0.55·airflow inside the ellipse around (0.5, 0.54). Stationary, drops
  cover everything.
- **Refraction term**: `bend = clamp((l1 − l0) / (l0 + 0.10), ±0.85)`, a
  dimensionless luma ratio. It is valid whether `uScene` is display-referred
  or the linear-HDR scene copy it now is, and it cannot feed back on itself
  frame to frame. The variable is named `bend` because `refract` is a GLSL
  built-in, and shadowing it depends on the driver compiler's leniency. With
  no scene texture (`uHasScene` 0) bend is 0, so beads only darken and show
  the rim. EffectsSystem captures only while HeatHaze is enabled, so a
  session that STARTS on the low tier (`heatHaze: false`) never refracts. A
  live switch down to low (`HeatHaze.setQuality`) stops capture and leaves
  `capture.ready` true, but `sceneTexture` checks `enabled` and returns
  null, so the film drops to the no-refraction path instead of refracting
  the last captured, frozen frame (§2.9).
- **Squared-Fresnel puddle bug** (`PUDDLE_SPECULAR_PATCH`): a water film
  composites `road*(1-R) + sky*R`. Alpha blending gives `colour*a +
  road*(1-a)`, so `a = R` is right — but only if `colour` is the *unweighted*
  sky radiance. The standard specular BRDF has already multiplied by its own
  Fresnel, so the shipped composite was `road*(1-R) + sky*R²`: at ~2% grazing
  R the film removed 2% of road and returned 4e-4 of sky — puddles
  unconditionally darker than the road, at every angle, by construction. No
  coverage/intensity tuning can fix a squared Fresnel; the patch replaces
  indirect specular with raw environment radiance. Coverage ≠ reflectance:
  the mask drives *coverage* (pools deepen after it saturates), Schlick drives
  how much sky comes back.
- Puddle reflectance is Schlick with water F0 = 0.02
  (`0.02 + 0.98·(1 − n·v)^5`), multiplied into ALPHA only, never into colour
  (see squared-Fresnel above).
- **Puddle layout** (`PUDDLE_FRAGMENT_PATCH`): pool centres stay inside their
  cell (x 0.36–0.64, y 0.42–0.58). Ellipses that cross the cell edge get cut
  off square and leave lattice steps along the drainage line. The ellipse
  factor is `vec2(1.35, 1.15)`; a larger factor SHRINKS that axis, and the
  old (1.35, 2.30) made pools wide and stubby. 14% of cells stay dry
  (`step(0.14, h2)`). The camber ramp `smoothstep(0.02, 0.26)` across the
  ribbon is short because holding water off until 42% of the ~6 m ribbon put
  every pool outside the cockpit view.
- **`vPuddleUv`** is a dedicated varying carrying the raw track UV (x across
  ribbon, y = 0.16 units/metre along) — three's `vNormalMapUv` arrives with
  the animated ripple offset folded in and the pools would crawl with the
  ripples.
- **Water-ribbon winding**: `right = tangent × up`, so `tangent × right` is
  *down* — emitting both side ribbons with one vertex order gave the +right
  side a downward face normal, back-face-culled from the cockpit. Half of
  every wet circuit since round 2 was culled before rasterisation. The +right
  ribbon is wound the other way; the material is additionally double-sided
  (belt and braces — a horizontal sheet culled once does not get culled again
  over a sign convention).
- The camera is added to the scene graph explicitly — it is not part of it by
  default, and the visor overlay would otherwise be left at the world origin.
- Ribbon camber: 4 lateral spans per side; a ribbon spanned by its two edges
  interpolates *under* the road crown (several cm — enough to bury the water).
- USE_CLEARCOAT is a compile-time define: the frame the wet film first exists
  rebuilds those programs, latched so later wetness ticks only move the value.

### 2.11 Renderer/material misc traps
- **`aoMap` defaults to the second UV set**; APEX geometry ships uv0 only —
  every packed ORM texture forces `channel = 0`
  (`src/render/MaterialLibrary.js`, `src/car/DriverModel.js` glove maps).
- **three's MultiplyBlending preset** is only implemented on the
  premultiplied-alpha path; on straight alpha it logs an error and leaves the
  blend func at whatever the previous draw set — silently wrong. The contact
  shadow spells out CustomBlending: `dst = 0*src + SRC_COLOR*dst`
  (`src/render/MaterialLibrary.js` contactShadow).
- **Instanced per-instance emissive**: three only routes `vColor` through when
  the material declares vertex colours — brake-disc geometry gets a white
  colour attribute and a fragment patch routes vColor to emissive only
  (`src/car/Wheels.js`).
- **`applyMatrix4` on geometry already runs normals through the
  inverse-transpose** — after mirroring through x=0 only the triangle winding
  is left to fix, or every mirrored face is backface-culled
  (`src/car/DriverModel.js` flipGeometry). A right hand rotated onto the left
  grip is still a right hand — the mirror must be baked into a second
  geometry.
- **Negative-scale mirroring inverts instanced winding**: left wheels are
  pre-rotated 180° about vertical instead, which also puts the aero cover and
  sidewall lettering outboard on both sides for free (`src/car/Wheels.js`).
- **`mergeGeometries` refuses attribute mismatches**: glove lofts/sweeps carry
  position+uv only; normals are computed once on the merged whole (also makes
  group boundaries not shading breaks); stitch beads come from a primitive
  that ships normals — strip them first (`src/car/DriverModel.js`).
- **Lights are created once and never added/removed at runtime**: changing the
  light count forces every material in the scene to recompile — a visible
  hitch (`src/fx/Sparks.js`).
- **Sun-disc mesh is deliberately NOT `transparent`**: three routes transparent
  materials into the after-opaque pass, where a depth-test-free quad would sit
  ON TOP of the grandstand. Left opaque with renderOrder -999 (dome -1000) it
  draws right after the dome and every opaque draw covers it. No culling — the
  billboard basis flips handedness with the sun's hemisphere. Emitted as a
  direction with w = 0 (point at infinity): no far-plane clipping, no distance
  to choose, and a camera facing away produces w ≤ 0 and clips the primitive
  free. Billboard basis is built from the sun direction in *view space* via
  `viewMatrix` so the cockpit mirror draws the sun in its own correct place
  (`src/render/SkySystem.js`).
- **Behind-the-eye projection lies**: a point behind the eye projects through
  negative w; the perspective divide mirrors it through the optical centre
  (a sun 140° behind the camera published at NDC (0.63,-1.29) — "just off the
  top of the frame" to anything reading numbers). SkySystem undoes the mirror
  and pushes the result outside every consumer's cutoff so the published sun
  position always says which way, never lies about how near
  (`src/render/SkySystem.js` _cameraSync).
- **Renderer output stays linear**: the pipeline does its own filmic grade and
  receives an HDR buffer (`src/core/Engine.js`).
- **`renderer.compile` up front** (`src/main.js`) so first laps are not a
  stutter-fest; one presented frame before hiding the loader so an empty
  canvas never flashes. Engine resizes once at end of init, before main.js
  warms shaders — cheapest place to guarantee every material is patched before
  first compile (`src/render/SkySystem.js`).
- **OffscreenCanvas 2d context** can be behind a flag on some engines —
  `createCanvas` falls back (`src/render/textures/NoiseTextures.js`).
- **Settings persistence**: localStorage writes are wrapped — private browsing
  throws; settings become session-only (`src/core/Settings.js`).
- **AudioContext.close() / source.start() double-calls throw** — swallowed in
  `stopSource`/`startSource`/AudioEngine dispose paths (`src/audio/DSP.js`,
  `src/audio/AudioEngine.js`).

---

## 3. Capture, verification and tooling protocols

### 3.1 TAA capture convergence protocol — `tools/screenshot.mjs`
Presents during warmup exist ONLY to hand the temporal passes a *moving*
history right before the grab (velocity buffer for motion blur, reprojected
TAA frames). That takes a fixed number of frames, not a number proportional to
warmup length: presenting every 4th step for the whole warmup put 30 presents
behind the 1 s grid shot and 180 behind the 6 s pack shot for an identical
result, and at 1080p/high a present costs ~45 s under contended SwiftShader.
Presents are restricted to the last `presentWindow` steps.

**The numbers are load-bearing: 96 warmup-window steps / 24 moving presents /
12 settled frames.** RenderPipeline holds the TAA jitter ON for the first
`CAPTURE_CONVERGENCE_FRAMES = 24` presented frames and only switches it off
*after* that. Round 4's halving to 48/8 topped out at 20 presents, `_frame`
never passed 24, and every grabbed frame was a sub-pixel-jittered,
still-accumulating image — soft and offset up to half a pixel. 96/12 gives 24
jittered frames (a full Halton-16 cycle and a half) plus 12 unjittered frames
to converge — the protocol round 3 was judged under. Physics is untouched
either way: every step still runs; step size stays 1/120 even in --fast.

Other harness rules:
- Profile values. FULL: `presentEvery` 4, `presentWindow` 96,
  `settleFrames` 12, `settleMs` 250, `timeoutSec` 2400 (one 1920×1080 ultra
  scenario measured ≈850 s). FAST: 1280×720, quality `medium` (no TAA, `env`
  rather than `probe` reflections), `warmupScale` 0.4 with a 0.5 s floor,
  `presentEvery`/`presentWindow` 0, 4 settle frames, 100 ms settle,
  `timeoutSec` 200, `skipPasses` godrays/motionBlur/ao.
- The settled frames must be the LAST thing to touch the canvas. Deliberately
  no trailing requestAnimationFrame: the settle presents must be the last
  thing drawn; under SwiftShader the first compositor frame costs tens of
  seconds and `page.screenshot` forces one anyway.
- Chromium launch flags (SwiftShader-ANGLE): `--use-gl=angle`,
  `--use-angle=swiftshader`, `--enable-unsafe-swiftshader`,
  `--ignore-gpu-blocklist`, `--enable-gpu-rasterization`,
  `--disable-dev-shm-usage`, `--no-sandbox`. `tools/speckle-oracle.mjs`
  passes the same seven (§3.7); `tools/make-gif.mjs` passes a subset (§3.8).
- `presentEvery = 0` skips warmup presents entirely (--fast, TAA off — the
  converged history buys nothing and each present re-renders shadows/mirrors).
- Input is disabled during capture to stop it overwriting scripted controls
  (see §3.5).
- Explicit CLI flags win over the --fast preset regardless of argument order.
- --fast renders 1280×720 (≈44% of the 1920×1080 default's pixels, 2.25×
  fewer), drops TAA/probe tier, shortens warmups, disables
  godrays/motion-blur/AO. Every pass is guarded on config at render time,
  feature-detected, so a pipeline refactor degrades to "fast is merely
  lower-res" instead of throwing.
- `skipPasses` clears flags on `APEX.ctx.pipeline._config`, which every pass
  checks at render time, then calls `_applyConfig()` if it exists. The keys
  it cleared come back as `skippedPasses`.
- Timeout is a hang guard, not a performance target: solo budget × number of
  concurrent pages (N pages under SwiftShader legitimately take ~N× as long).
  Measured: one 1080p ultra scenario ≈ 850 s under SwiftShader, almost all in
  the interleaved presents. On a 4-core box, 10 fast scenarios: 945 s at
  --jobs 4 vs 800 s at --jobs 1 — SwiftShader already uses every core. With
  `jobs > 1` and fewer than 2 cores per job (`availableParallelism()`), the
  CLI prints a `--jobs 1` hint.
- Navigation goes through a single promise-chain gate (`createGate`) plus
  `NAV_STAGGER_MS` = 350 ms, so N cold module loads do not overwhelm the one
  preview server (a cold dist/ load can time out otherwise). This is the only
  point where pages compete for it.
- Blank-frame gate: luminance sigma below `BLANK_STD` 1.5 or fewer than
  `BLANK_COLOURS` 48 distinct colours = fail (a real render has tens of
  thousands). An undecodable capture is a FAILURE — an unverified frame must
  never be reported clean. PNG decode is done in-repo from zlib (no image
  dependency); the distinct-colour count uses a 2^24-bit bitset (`seen`,
  `1 << 21` bytes) allocated per call (scenarios are analysed concurrently).
  High byte of 16-bit samples is plenty for a blank check; palette samples
  must not be rescaled (they are indices).
- The PNG decoder handles non-interlaced images only, colour types
  0/2/3/4/6, and bit depths 1/2/4/8/16. Palette indices are read with
  `sampleAt(..., scale = false)`.
- Per-scenario runs never throw: timeout/boot failure/blank frame all return
  `ok: false` so one bad scenario cannot stall or abort the run. If the
  timeout guard wins `Promise.race([work, guard])` in `runScenario`, the
  capture promise keeps running until the page is closed in `finally`; its
  no-op `.catch` keeps its rejection from surfacing unhandled. The
  `setTimeout` guard is what catches a wedged renderer process that hangs
  outside every awaited call.
- `__APEX_READY__` / `__APEX_ERROR__` globals gate boot; the wait is bounded
  by the scenario budget, not a fixed cap (N-way SwiftShader shader compiles
  can outlast any constant). `page.screenshot` also gets the remaining
  scenario budget (never < 1 s) instead of Playwright's 30 s default, because
  compositing a 1080p WebGL canvas under N-way SwiftShader takes longer.
- Module is import-safe: capture only runs when invoked as the CLI
  (`invokedDirectly`), so tests and tools import `SCENARIOS`, `frameStats`
  and `decodePng` without starting a capture (§3.7 uses `decodePng`).
- **Windows path trap**: `new URL(import.meta.url).pathname` is `/D:/...`, and
  `path.resolve` turns it into `D:\D:\...`. Always convert with
  `fileURLToPath`/`pathToFileURL` (`ROOT`, `invokedDirectly`). The old CLI
  self-check silently never matched, so the tool exited 0 without capturing
  anything.
- **Windows spawn**: npm shims resolve only through a shell and only under the
  `.cmd` name, so both `vite build` and `vite preview` are spawned as
  `npx.cmd` with `shell: true` on win32.

### 3.2 Preview-server checkout verification — `tools/screenshot.mjs`
The preview port is a shared well-known number; a `vite preview` left running
by a benchmark clone or sibling worktree answers on it just as happily.
Reusing it silently captures a DIFFERENT BUILD — frames come back plausible,
the blank check passes, and a whole round gets judged against code not in this
repository (round 5 was captured against /home/user/perfrepo's dist exactly
this way). The check: vite's served index names its content-hashed entry
bundle; if that file is not in our own dist/, the server is not ours.
- `servesOurBuild` fetches the index on 127.0.0.1:4173 and requires EVERY
  `assets/` file it names (src/href) to exist in this checkout's dist/. An
  index that names none also fails. A foreign server makes `ensureServer`
  throw and refuse to capture; `--url` bypasses the local server entirely.
- The other tools do not run this check: `tools/speckle-oracle.mjs` starts
  its own server on a private port (§3.7), and `tools/make-gif.mjs` reuses
  whatever answers on 4173 (§3.8).

### 3.3 Spa sunset: UTC vs CEST — `tools/screenshot.mjs` (sunset scenario)
SkySystem solves the sun from the circuit's real coordinates (Spa, 50.44 N
5.97 E) with the whole-hour timezone its longitude implies — which is **UTC**,
so scenario `timeOfDay` is UTC, not the CEST wall time the paddock would read.
18.9 landed the sun 4° BELOW the horizon with intensity already ramped to zero
(indistinguishable from cockpit-night, nothing to flare); **17.5** puts it
8.8° up and still on full colour-temperature swing — the low sun the scenario
exists to stress. (SkySystem: `timeOfDay` is local clock time at a whole-hour
zone offset derived from longitude, NOAA solar position.)

### 3.4 verify-gameplay — `tools/verify-gameplay.mjs`
Steps the sim headless WITHOUT rendering (minutes of racing in seconds):
`simSeconds` (argv[2], default 420) of fixed 1/120 steps from
`?quality=low&autostart=1`, a fixed stretch of time, not a whole race.
Reports what screenshots cannot show: player and field top speed/gear/rpm,
field speed percentiles (p50–p99.9), a player trace every 5 s, off-track and
airborne share, up to five non-finite player samples, the session,
standings and per-car laps. It REPORTS, it does not judge: the output is
one JSON object on stdout plus up to ten console errors, with no
thresholds and no non-zero exit for bad numbers (it only fails if the page
never loads or the script throws). Requires a built dist/ and a preview
server already on 127.0.0.1:4173 (`npm run preview`, or
`npx vite preview --host 127.0.0.1 --port 4173 --strictPort`); it starts
neither, and neither does the VS Code task "APEX: verify gameplay".
- No applyScenario — the race director runs its own start sequence.
- Input.update's disabled branch zeroes shiftUp/shiftDown every tick and Input
  runs first, so scripted shifts never survive to physics: the harness stubs
  the whole Input.update out and authors ControlState directly.
- The player is pinned to throttle 1, brake 0, steer 0, and the harness
  scripts its upshifts (`shiftUp` pulsed on every other tick above
  13 800 rpm in gears 1–7): it drives flat out, and without them the car
  sits on the first-gear limiter and reveals nothing about box/top end.
- Read the FIELD figures, not the player's: the straight-steered player
  parks in the La Source barrier and tells us nothing.
- Judge field speed by the PERCENTILES, not the max (both are printed;
  samples are kept only between 0 and 450 km/h): a respawn writes a pose
  discontinuity that shows one frame of impossible velocity (583 km/h in first
  gear) which a max would report as top speed.

### 3.5 The capture rail — `src/game/Scenarios.js` + friends
`tools/screenshot.mjs` → `RaceDirector.applyScenario(setup)` → `warmup`
seconds of fixed-step sim with scripted controls before the grab.
- Cars start `speed * warmup` metres short of their marks and arrive exactly
  on them (a car placed on its mark would have driven off it).
- Scripted controls do not drive a lap (4 s of full brake stops the car; 4 s
  of constant steering leaves the circuit), so railed cars have pose and
  velocity written from the centreline each tick at the scripted speed.
  Physics still runs underneath: wheels lock and smoke under a scripted
  brake, tyres/brakes heat, aero loads, DRS opens. Only the trajectory is
  authored, and only for screenshots. Only rail runs get a pre-roll (only
  they cover a predictable distance).
- **Velocity/teleport rule**: writing pose directly is a teleport —
  AIDriver's jump detector (`TELEPORT_SQ` = 30², a one-tick position jump
  that can only mean grid placement/scenario/marshal) resets every integrator
  ("describing a journey that did not happen"); VelocityBuffer classifies it
  (§2.6); RaceDirector `_resync(timed)` (called on session set-up, grid
  placement and lights out, and by `setupGridShot`/`setupRunningShot`)
  re-reads every car's position and
  restarts timing so the first tick after a move cannot be mistaken for a lap
  (a gap measured before the move describes a race that no longer exists);
  the AI marshal recovery marks its own teleport so the jump detector does not
  wipe the recovery state it is about to set up; the rail matches the
  physics' previous-velocity cache so `accel` (camera + HUD g-force) stays
  honest across a teleport.
- **Powertrain hold** (`railDrivetrain(phys, speed)`, module-private in
  Scenarios.js, run by `ScenarioRail.update(dt)` for every entry every tick):
  the rail writes road speed but the powertrain derives engine speed from the
  wheels. Scripted full brake locks the wheels → gearbox input drops below
  clutch lock threshold → crank freewheels to idle → cluster prints 2300 rpm
  beside an eighth-gear 270 km/h. Gear and rpm are re-derived from the railed
  road speed through the transmission's `overall` ratios every tick (wheels
  untouched, so scripted brakes still lock and smoke). Called AFTER the
  physics step (RaceDirector updates after CarManager) so HUD/audio read the
  corrected values this frame. A railed car is never mid-shift (shift timers
  zeroed), never on the limiter (rpm clamped to idle..0.99 × limiter). A
  parked grid car left to the free-engine integrator settled at 2310 rpm —
  below its own declared idle — so fixed entries are held too
  (`railDrivetrain(phys, 0)`). `primeDrivetrain(phys, speed)` runs once at
  placement: it seeds the four wheel speeds, gear, rpm and clutch from the
  placed speed and pre-spools the turbo for cars seeded above 20 m/s
  (otherwise the first second of every capture is spent spooling).
- Railed rivals get an authored ControlState (`car.scriptedControls`, set by
  the rail on cars whose pose it authors — see `src/car/Car.js` /
  `src/car/CarManager.js`): a driver whose pose is written every tick sees a
  hairpin it can never reach and stands on the brakes at 310 km/h, hiding the
  composition behind four locked tyres. Dragged-at-speed = on power
  (throttle 1 above 25 m/s, 0.35 above 1 m/s, DRS above 60 m/s); parked
  (`addFixed`) = throttle 0 and brake 0; neither ever gets scripted brake (a
  locked stationary wheel reads as a smoking tyre to the effects system). The
  player keeps its own input. Steering follows the rail's
  curvature so front wheels point where the corner goes (curvature positive
  left, steer positive left — both rotations about the surface normal).
- Weather snaps rather than crossfading — a capture cannot wait 2 s for the
  sky.
- The tail of the field runs behind the shot at the director's own
  field-spread intervals so the tower reads as a grand prix to P20; intervals
  are compressed uniformly if the tail would reach further back than the
  circuit is long (tightens but stays irregular). Cap: tail never strung out
  more than a fraction of the lap or it comes back round into frame.
- The placement *plan* (pre-wrap centreline distances) is returned because the
  director needs it to compute which lap each car is on — a rival authored
  200 m up the road from a player near the line has crossed it; classification
  from wrapped distance alone puts the leader last.
- `Number(null) === 0` trap: a scenario that never asked for a time of day
  must not be framed as a midnight shot (`src/game/CameraRig.js` composition
  resolution).
- `input.enabled = false` during capture means "stop reading devices", NOT
  "zero the controls": `Input.update` then clears shiftUp/shiftDown, the
  held/pressed/released key sets and the keyboard ramp accumulators (nothing
  held across the gap replays on re-enable) but leaves `controls.throttle`,
  `brake` and `steer` to whoever authors them — the harness's scripted
  ControlState must survive the tick. The in-game pause menu that disables
  Input also sets ctx.paused so no system consumes a stale axis
  (`src/ui/Menu.js`, `src/core/Input.js`).

### 3.6 analyse.mjs — `tools/analyse.mjs`
`shadow` scans a horizontal band and prints mean luminance per x-bin (a cast
shadow is a sustained dip; a shadowless frame is flat) — exists because two
reviewers disagreed and the eye is not an instrument. `stats` prints per-image
stats. Arg parsing: a flag consumes the token after it, so that token is a
value, not a file — without this `shadow shot.png --y0 0.50` printed the
profile then died ENOENT opening a file called "0.50".

### 3.7 Engine-cover speckle oracle — `tools/speckle-oracle.mjs`
This is the acceptance metric for the heat-haze rework (§2.9; the story is in
docs/JOURNAL.md, Aug 30 and Oct 12). It replicates the round-8 bisection
protocol that traced the engine-cover "rainbow corruption" to HeatHaze.
- Usage: `node tools/speckle-oracle.mjs [on|off|gain0 ...]`. The default run
  is `on` vs `off`; any subset can be named (e.g. `on gain0`). Unknown
  arguments are ignored. `APEX_CHROMIUM=/path/to/chrome node
  tools/speckle-oracle.mjs` launches an explicit browser binary, for a
  machine whose installed Chromium is not the build this Playwright expects;
  unset, Playwright's own Chromium runs. (make-gif's override is named
  `APEX_CHROME`, §3.8.)
- Framing: chase-hero, `?shot=1&quality=medium&scenario=straight&camera=chase`
  at 1280×720, DPR 1. Order per variant: the engine is stopped FIRST, then
  the fast profile (pipeline `_config` godrays / motionBlur / ao forced
  false, then `_applyConfig()`), then the variant hook, then the `straight`
  scenario is applied (speed 80 m/s, full throttle, chase camera), 2
  simulated seconds run at 1/120 steps with input disabled and throttle
  pinned, then `present(0)` runs 4 times before the screenshot.
- **Why the stop comes first**: the rAF loop steps the sim on wall-clock
  time, and some of what it advances survives `applyScenario` (the camera
  rig's damped FOV and shake). A variant that spent one more page
  round-trip before the stop than another was measured through a different
  camera. That was the hookless `on` variant: FOV 32.573° against 32.563°
  for `off`/`gain0`, seen as a frame-wide difference with chromatic fringes
  growing toward the corners. Numbers taken while the stop still came last
  (in the scenario step) compared `on` through a slightly different camera
  from `off`/`gain0`.
- Measure: the engine-cover box at x 0.33–0.52, y 0.35–0.60 of the frame
  (kept one pixel inside the image). There are three speckle fractions, each
  counting pixels whose 3×3-neighbourhood deviation exceeds 39/255: max
  channel vs the 3×3 mean (`devMean`), Rec.709 luma vs the 3×3 mean luma
  (`devLuma`), and max channel vs any of the 8 neighbours (`devMaxN`). It
  also prints `fx.heat.sourceCount`, the box and up to five console errors.
- Variants: `on` (untouched), `off` (`fx.heat.enabled = false`) and `gain0`
  (`uGain = 0`: the effect still draws but contributes nothing). The variant
  hook runs after the engine stop and the pass skip, before the scenario.
- Round-8 reference (pre-fix build): baseline 15.16%, heat disabled 3.25%.
  Acceptance: `on` within ~0.5 points of `off`. Post-fix runs in the
  JOURNAL: 4.50% on vs 4.88% off (Aug 30) and 4.75% vs 5.06% (merge, Oct 12),
  both taken before the camera fix above; with matched cameras (1280×720 /
  medium, SwiftShader) 4.68% on, 5.04% off, 5.05% gain0, and on the merged
  build (Oct 12) 3.86% on, 4.16% off, 4.16% gain0. The on/off diff is
  confined to the plume and the horizon band. The round-8 3.25%
  `off` figure does not reproduce on later builds (off is ~5%), so a "below
  2%" target is not the haze's to reach: what is left is edge aliasing in a
  no-TAA tier (medium has `taa: false`). Compare runs only on the same
  machine and build.
- Assumes dist/ is built (it never builds). It starts its own `vite preview`
  on private port 4189 (`--strictPort`; `npx.cmd` with a shell on win32) and
  waits up to 60 s for it. Off Windows the server is spawned `detached`, in
  its own process group: npx runs vite as a grandchild, and signalling npx
  alone left vite holding the port and kept the script's event loop open
  after the last variant had printed (the script used to hang there on
  Linux). `stopServer` (in `finally`) sends SIGTERM to the whole group
  (`process.kill(-server.pid)`); on win32 it still kills only the direct
  child. Outside the terminal's process group Ctrl-C no longer reaches vite
  by itself, so SIGINT/SIGTERM handlers stop the group and exit 130. It
  launches Chromium with the SwiftShader-ANGLE flags the capture harness
  uses and decodes with `decodePng` from `tools/screenshot.mjs`. PNGs go to
  shots-oracle/chase-<variant>.png. There is no §3.2 checkout check: if
  another server already holds 4189, vite exits and the oracle measures
  whatever answers on that port.

### 3.8 GIF clips — `tools/make-gif.mjs`
Renders a deterministic clip from the built game and encodes it as a GIF.
- Flags (defaults): `--shot straight|chase|apex|pack|grid` (straight),
  `--frames` (60), `--fps` (20), `--width`/`--height` (640×360), `--quality`
  (low), `--warmup` seconds (3), `--out` (media/apex.gif), `--gif-width`
  (720), `--keep` (keep the frame PNGs). An unknown shot exits 1. Shots reuse
  the capture scenarios' setups: `straight` = cockpit at 86 m/s with DRS,
  `chase` = the chase-hero setup, plus `apex`, `pack` and `grid`.
- Deterministic clip: the engine is stopped, the scenario applied, controls
  pinned from the shot with input disabled, `warmup` seconds stepped at
  1/120, then 8 presents. Each GIF frame then steps the sim clock
  `max(1, round(120/fps))` ticks (re-pinning controls every tick), presents
  once and screenshots. At the default 20 fps that is 6 ticks = 50 ms of sim
  per frame, so the clip plays back in real time. Exact only when 120/fps is
  an integer: the README clip's 18 fps rounds to 7 ticks (58.3 ms of sim per
  55.6 ms frame, ~5% fast).
- Frames go to `.gifframes/fNNNN.png` (wiped at start, deleted after encoding
  unless `--keep`). Encoding is a two-pass ffmpeg palette (ffmpeg must be on
  PATH): `fps,scale=<gif-width>:-1:flags=lanczos,palettegen=stats_mode=diff`,
  then `paletteuse=dither=bayer:bayer_scale=3` with `-loop 0`.
- Browser: prefers an installed Chromium — `APEX_CHROME` env override, then
  `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`, then
  `/opt/pw-browsers/chromium/chrome-linux/chrome` — and falls back to
  Playwright's own. Launch flags are a subset of §3.1's: `--use-gl=angle`,
  `--use-angle=swiftshader`, `--enable-unsafe-swiftshader`, `--no-sandbox`,
  `--disable-dev-shm-usage` (no `--ignore-gpu-blocklist`, no
  `--enable-gpu-rasterization`).
- Server: builds dist/ (`npx vite build`) if `dist/index.html` is missing;
  reuses anything already answering on 127.0.0.1:4173 (1.2 s probe, no §3.2
  checkout check), otherwise starts `vite preview` there and kills it at the
  end.
- Not Windows-safe: it derives `ROOT` from `new URL(import.meta.url).pathname`
  and spawns plain `npx` without a shell, the two traps §3.1 describes.

---

## 4. Physics: justified constants and model reasoning

### 4.1 CarConfig (`src/physics/CarConfig.js`)
Every number is a real engineering quantity, not a feel knob. Frames: car
local -Z forward; wheel order [FL, FR, RL, RR]. `AIR_DENSITY = 1.2041` kg/m³
(ISA, 20 C, sea level).

- **Pacejka MF-96 sets**: shape factors per construction; PD*2 (load
  sensitivity) is negative so mu falls as normalised load dfz rises — the
  entire reason weight transfer matters. FZ0 is the nominal load the
  coefficients are normalised to.
- **Compounds** (`TYRE_COMPOUNDS`): `gripScale` multiplies peak mu;
  `optimumTemp` is the centre of the working window on the blended
  surface/core temperature; asymmetric half-widths (overheating hurts sooner
  than cold); softer compounds grip more, work colder, wear much faster, and
  build temperature faster (more hysteresis). Tyre blankets are gone in 2026
  but the out-lap is not modelled.
- **Chassis**: 798 kg minimum incl. driver, fuel-empty; rear track regulated
  slightly narrower than front; axle distances follow from the static weight
  split; ~12 kg unsprung per corner (wheel+tyre+upright+disc+caliper).
  Inertia radii of gyration ≈ 1.10 m pitch, 1.15 m yaw, 0.39 m roll. Body
  extents (nose tip ahead of CG, rear-wing TE behind) feed barrier probes and
  floor-strike tests.
- **Steering**: ratio wheel:road; 240° lock-to-lock at the rim (matches
  Cockpit); near-parallel steer with a touch of Ackermann; finite road-wheel
  slew rate; centring comes from the tyre Mz feedback, not an artificial
  spring.
- **Suspension rates** are quoted AT THE DAMPER; wheel rate =
  rate × motionRatio². The tyre carcass sits in series, which is why the
  numbers look huge. Resulting ride rates ≈ 235 N/mm front / 208 N/mm rear:
  6.2 / 5.3 Hz on the sprung corner masses — where a ground-effect car has to
  live to keep the floor working. Camber gain in rad per metre of bump
  (-0.060 deg/mm); front toe negative = toe-out, rear positive = toe-in for
  straight-line stability; ARB rates in N/m of differential wheel travel.
- **Tyre thermals — the 1.0 mm active tread ring**: rubber diffusivity
  k/(rho·c) = 0.25/(1150·1900) = 1.14e-7 m²/s, so heat from a 3–4 s corner
  penetrates √(αt) ≈ 0.7 mm. The tread node is that ring:
  2π·0.360·0.305·0.0010·1150 = 0.80 kg at 1900 J/kgK → 1520 J/K, a ~6 s time
  constant against ~250 W/K of sink. The old 4500 J/K was a 3 mm ring (the
  depth that equilibrates over a LAP): an 18 s low-pass on everything — the
  loaded outside front (3.6 g, 6.8 kN) read 1.3 K over the inside (2.0 kN),
  and a four-wheel lock-up at 270 km/h moved the widget 15 K in three seconds
  — i.e. "nothing is happening". Rear ring: 2π·0.3625·0.405·0.001·1150 =
  1.06 kg.
- **Tyre convection**: Nu = 0.076·Re^0.7 (cylinder in crossflow) → h ≈ 115
  W/m²K at 300 km/h over 0.69 m² of exposed ring ≈ 65 W/K — NOT the 318 W/K
  the old 3.5 W/K-per-m/s implied, which refrigerated a front tyre down a
  straight.
- **Patch conductance**: 750 W/m²K rubber-on-asphalt contact → ~35 W/K lightly
  loaded, ~55 W/K fully loaded — same order as ring convection, not twice it.
- **roadHeatPartition = 0.40**: effusivity ratio √(kρc)_rubber/(rubber+asphalt)
  = 739/2332 = 0.317, carried up to 0.40 because TyreModel divides it by
  √(1 + slide/slideRenewalSpeed): at the 3–5 m/s a working tyre slides,
  0.40/√1.5 ≈ 0.327 — operating point unchanged, runaway case bounded.
  `slideRenewalSpeed` = sliding speed at which the road's share has doubled.
- **Wear**: slip-energy based, calibrated so a hard lap costs ~4% of a soft.
- **Aero (free-air ClA/CdA)**: ground-effect multiplier applied on top; at
  ~25 mm working front ride height the car makes ~5.5 m² effective ClA —
  ~2.3 t at 300 km/h. Induced drag: extra CdA per (downforce/10 kN)² — what
  stops the car gearing its way to 400 km/h. Balance: front fraction at
  reference, migrating rearward with speed² (per (v/100 m/s)²) and with front
  ride height (front wing runs out first → push at end of a long straight).
  Ground effect: onset height (free air above), peak height (max suction),
  stall (edge seal lost) with fraction-of-gain lost when fully stalled; roll
  kills the seal on the unloaded side; yaw spills the floor. Aero lag time
  constant: the pressure field cannot follow the platform instantly — this
  lag is what turns the stall into porpoising rather than a static loss.
  Heave-rate feedback positive (rising = more load = damping). Drag acts
  above the CG (nose-down pitch couple with speed); crosswind CyA applied
  ahead of the CG so yaw is mildly destabilising (no self-rescuing spins).
- **Team setups** (`TEAM_SETUPS`): deliberately small deltas — F1 cars are
  within a couple of percent; character comes from balance, not one team
  having twice the grip. One car (aggressive-floor team) has a knife-edge
  stall exactly at its high-speed ride height: seals/unseals a few mm either
  side of equilibrium and the aero lag turns that into ~10 Hz heave — the
  designated porpoising car.
- **Powertrain numbers**: ICE ~500 Nm plateau near 10 500 rpm, ~575 kW near
  11 500, 15 000 limiter; fuel flow 100 kg/h regulation (0.02778 kg/s) applied
  as an explicit clamp on delivered torque (the regulation, not airflow, caps
  the top end); LHV J/kg; thermal efficiency just over 50% BTE. Turbo: spool
  time constants (no exhaust energy vs full), dump time (wastegate+blow-off),
  MGU-H-assisted spool time, boost fraction MGU-H alone can hold, torque
  fraction with the turbo asleep. Gearbox: 8 ratios + 3.90 final; overall
  15.65:1 → 5.91:1; limiter at 131 km/h in 1st, 347 km/h in 8th on 725 mm
  rears; ~ seamless-shift torque-cut seconds; shift lockout; auto-upshift
  point. Clutch: launch torque, lock time, capacity. LSD: preload + power and
  coast ramps (locking torque per Nm of drive), viscous Nm per rad/s
  cross-axle, plate capacity ceiling. ERS: 4 MJ-class store (J), MGU-K deploy
  W and harvest W (120 kW regulation), per-lap deploy J and 2 MJ-class
  harvest cap (regulation), MGU-H turbine recovery W (no per-lap cap under
  the regulations), store conversion efficiency, deploy taper near the
  limiter.
- **Brakes**: total axle-pair torque 21 kNm ≈ 5.9 g fully loaded
  aerodynamically; very progressive pedal-to-pressure curve. **Disc heat
  capacity**: a 330×32 mm carbon-carbon front annulus at 1800 kg/m³ is 3.1 kg
  solid; vanes + ~1200 radial holes take about half → ~1.5 kg → 1470 J/K, so
  the ~480 kJ a front disc takes from 340 km/h is +325 K — the real swing of a
  braking zone. The old 2950 J/K (a solid iron GT rotor) halved that and no
  stop could leave the warm-up band. Rear disc is the smaller 280 mm part
  (~1.05 kg): carrying a front-sized 1.30 kg on an axle that sees 40% of the
  pedal minus MGU-K harvest left the rears 240 K too cool over a stint.
  **Duct cooling**: lap-average brake power at Spa ≈ 30 kW per front disc; a
  disc holding 400–600 C while rejecting that can only have 80–90 W/K. The
  old 3.4 W/K·per·m/s = 212 W/K at speed pinned discs near ambient and left
  disc glow/brake dust with nothing to trigger on. **Cold bite = 0.78, not
  0.66**: cold-bite is self-reinforcing (cold disc → less torque → less heat →
  never leaves the cold band); measured over a 260 s stint, 0.66 held the
  rears at 218 C average vs fronts 461 C. Real carbon at 300 C is down but
  not by a third; 0.78 lets the rear axle climb out under its own braking.
  **Soak temperature**: the disc's floor/sink is ~100 C, not ambient — a disc
  lives in a duct fed by air that already crossed a hot assembly and never
  sees 26 C again once the session starts (`brakes.ambient` = 100). Above
  `brakes.fadeTemp` (1050 C) torque falls away, to `fadeTorqueFactor` 0.72 of
  nominal over the next 250 C (`Powertrain._brakeTempFactor`). Damage: normal-impulse thresholds — below the scrape threshold
  a contact is not an impact (a long wall-ride must not total a car that only
  loses paint); a destroy-impulse fully kills a section; bottoming at speed
  grinds the plank.
- **Derived quantities** (`finaliseConfig(cfg)`, run once per config by
  `createCarConfig`/`createTeamConfig` — nothing in the hot path
  recomputes): cgToFront/cgToRear, sprung mass, wheel rates (spring ×
  motion ratio²), static corner loads; tyre carcass as a series spring (the
  suspension's push is attenuated by the series factor; geometric ray travel
  = strut travel + tyre deflection), ride rates and static travel;
  precomputed overall gear ratios (`transmission.overall`, gears × final
  drive, and `reverseOverall`). Wheel-centre local positions come from the
  separate `wheelLocalPositions(cfg, out)` (front axle at -cgToFront because
  -Z is forward), called once in the VehiclePhysics and Car constructors.

### 4.2 VehiclePhysics (`src/physics/VehiclePhysics.js`)
- Semi-implicit Euler; Euler's equations solved in the body frame with the
  full inertia tensor (chassis gyroscopic coupling exact); the four wheels'
  gyroscopic couple added on top (spin axis chassis +X, rolling forward is
  negative about it) — small, not zero, free. NOTHING about handling is
  scripted: lift-off oversteer is the pitch moment unloading the rear, not a
  term that fires.
- Per-instance working arrays: several cars step in sequence, so scratch may
  NOT live at module scope. Allocated in the constructor, never in step().
- Suspension geometry first each substep: ray hits feed both spring forces and
  the ride heights the aero map needs.
- Wheel rays use the UNDEFORMED radius: carcass compliance is already in the
  suspension's series rate; feeding loaded radius back through the ray would
  make the damper react to its own tyre deflection. Physics therefore puts
  the wheel centre exactly one unloaded radius above the contact point — a
  fact Wheels.js (contact shadow road plane) and MaterialLibrary
  (applyContactPatch) both rely on.
- Ray nearly parallel to the surface (car on its side) = no support.
- Downforce acts along body -Y at the front/rear aero centres — roll/pitch
  tilt the load vector as in reality. Tyre load = strut force + weight of its
  own unsprung corner. Wheel heading: chassis forward, steered about body up,
  then flattened into the contact plane (banking and kerb faces handled).
  Inclination = static + travel camber + chassis lean relative to that
  particular patch.
- Wheel spin integration: drive + tyre reaction first, then brake as a torque
  that can stop the wheel but never drive it backwards through zero.
- Rack has a finite slew rate + Ackermann — a keyboard slam cannot teleport
  the front wheels; the inside wheel always carries more lock.
- Barrier response: normal impulse with restitution + Coulomb friction (what
  scrubs speed in a wall ride) + damage above the impact threshold. Effective
  contact mass: inverse of (1/m + n·((I⁻¹(r×n))×r)).
- Penetration recovery is a last resort so a 250 km/h kerb landing cannot
  tunnel through the world; bump stops are stiff enough it should never fire.
- Specific force published = what an accelerometer bolted to the chassis
  reads (1 g vertical at rest) — what the cockpit head model and HUD want.
- Wheel visual quaternion: steer about body up, camber about heading, spin
  about wheel axis; spinAngle is forward-positive with the visual sign baked
  in so consumers apply it with no correction.
- NaN safety net (`_guard()`, end of every `step`): one non-finite value
  poisons the whole state; the last known-good position and quaternion are
  restored (velocities, wheel spins and tyre slip states zeroed, the
  `recoveries` counter bumped) rather than shipping a NaN to the renderer.
  Must never fire; exists because "must never" ≠ "cannot".
- Grinding the plank wears the floor (damage-linked).

### 4.3 TyreModel (`src/physics/TyreModel.js`)
- Transient slip: semi-implicit relaxation-length ODE with a velocity floor in
  the denominator — removes the kappa = 0/0 singularity; at standstill the
  states behave as carcass deflections and produce a genuine holding force
  (car sits still on a hill instead of buzzing). In the air the carcass
  unwinds toward zero over the relaxation length. Lateral uses tan(alpha);
  -Vy so sliding right gives a negative slip angle and a leftward restoring
  force.
- `magicSin` (the MF sine form) clamps E to [−3, 0.999] (E > 1 makes the
  curve non-monotonic).
- Combined slip by the similarity method: normalise both slips by their peaks,
  evaluate pure curves at the combined magnitude, project — force locus is an
  ellipse with semi-axes Dx, Dy (braking really costs cornering). Ky
  saturates with load (cornering stiffness per newton falls on the loaded
  outside tyre). PHY3 carries camber thrust into the slip-angle axis.
- Mz: pneumatic trail acts on the lateral force ACTUALLY generated, not the
  pure-slip one — the wheel goes light exactly when the front saturates.
  Residual torque = camber/conicity couple surviving past peak slip.
- Thermal model: three lumped nodes + one boundary — tread ring split across 3
  bands (inner shoulder/centre/outer), carcass core, road as a moving
  semi-infinite sink at track temperature. Every heat term is a function of
  load, sliding speed, airspeed and disc temperature ONLY. `side` appears
  exactly once (band tilt) and cancels: static camber flips sign across the
  car so `gamma*side` is identical both sides — two tyres given the same load
  and slip return the same temperature to the last bit (verified 0.000000 K
  split over 6 s of symmetric braking).
- **Jaeger interface partition**: static effusivity split holds only at rest;
  once the patch slides the road is renewed at the sliding speed and its
  conductance rises with √Peclet, so tyre share falls as
  partition/√(1+slide/renewal). At 3–5 m/s (cornering) within 1% of static
  0.33 — corners heat as measured. At 75 m/s (locked wheel) it falls to 0.11
  — a lock-up gets a finite equilibrium (~170–180 C tread, 99 C carcass for
  4 s locked at 270 km/h on 3.5 kN) instead of the 340 C clamp the old model
  pinned, or the 105 C a flat partition + heavy node gave.
- **MAX_DEFLECTION = 55 mm** (rim on road at 360 mm radius): past it excess
  load goes through the rim; the contact patch and the hysteretic loss per
  revolution BOTH saturate there (same clamp shared with
  `updateLoadedRadius`) so heat made and heat lost stop growing at the same
  load. This bound is not decoration: the capture rail hands the model wheel
  loads of 52/86 kN in the `apex` scenario; unclamped, 86 kN of rolling
  hysteresis alone is 70 kW into the tread — the 235 C the reviewers saw on
  the round-5 apex frame.
- Hysteresis is the heat that keeps a tyre alive down a straight (no slip);
  split between tread ring and carcass by config fractions; rolling loss =
  fraction of Fz·|v|.
- Contact-patch conduction: patch half-length = chord of a circle of radius R
  cut at the carcass deflection — pressed harder = more heat AND more area to
  lose it through; above track temperature the patch is the tyre's single
  largest cooling path and is what gives a sliding tyre any equilibrium.
- Camber tilts the band load distribution (loaded shoulder works/heats/wears
  first); wear tracks slip energy per band, accelerated once overheated.
- Reported grip blends tread surface (reacts in corners) with carcass (sets
  stint-scale behaviour); bell-shaped working window asymmetric (overheating
  hurts more). Temp limits (tread ~200s revert/blister, carcass 220 C
  delaminated) are numerical guards, not the working model — anything touching
  them is a destroyed tyre.
- Loaded radius: squash with load, growth with centrifugal force
  (rad⁻²·s² term ≈ 8 mm at 260 rad/s); drives rolling speed and torque arm
  only (suspension already carries the carcass spring).
- PATCH_FILL fraction: a slick's patch is a rounded rectangle; grooves and
  shoulder radius take the rest.

### 4.4 Suspension (`src/physics/Suspension.js`)
- Per-corner: linear main spring on a pushrod motion ratio, digressive dampers
  (firm low-speed knee for platform control, then blow-off) with independent
  bump/rebound, progressive bump stops (rate rises linearly with crush →
  quadratic force → bottoming is violent, not a soft clip), droop stops,
  ARBs, travel-dependent camber/toe. Travel sign: + is compression; 0 is
  design ride height where the spring exactly carries the static corner
  weight.
- Damper velocity is taken from the GEOMETRIC travel, unfiltered — the kerb
  impulse must reach the damper or kerbs stop upsetting the car. Wheel
  velocity is converted to damper velocity, the curve evaluated, force
  converted back.
- Toe convention: config + is toe-in, so a right-hand wheel points left; SIDE
  = +1 right / -1 left sets static camber/toe signs.
- Front-biased ARB stiffness = the car's baseline understeer.
- Anti-dive/anti-squat: part of the longitudinal tyre force is reacted through
  the wishbones (side-view swing-arm jacking at the patch), keeping the
  platform flat under braking/traction.
- Bump-stop energy is accumulated for the caller's floor-damage model.
- Exposes geometric travel limits (droop detection) and per-axle roll
  stiffness for telemetry.

### 4.5 Aerodynamics (`src/physics/Aerodynamics.js`)
- Outputs are magnitudes in newtons in the car frame: downforce along
  -Y_local, drag opposing travel, side force along ±X_local.
- Ground-effect suction climbs from `groundEffectOnset` to peak, then the
  diffuser chokes and the edge seal breaks (stall from too low/too much
  roll/too much yaw). First-order lag = the phase shift that lets the stall
  pump energy into heave (porpoising is emergent, not scripted); light
  rate-feedback damping keeps it felt rather than nauseating.
- DRS: will not open below minimum speed; slams shut the instant the driver
  brakes (caller clears the request). Open flap gives up rear load and its
  drag (~1300 N at 300 km/h CdA reduction).
- Balance migrates with rake and speed (front wing runs out of ride height
  first — the car pushes on at the end of a long straight).
- Drag = parasitic + induced (∝ load²) + DRS delta, scaled by slipstream and
  bodywork damage; acts above the CG (nose-down couple with speed).
- Wake model: exponential decay with an e-folding distance (metres of gap);
  lateral offset before the wake stops biting; slipstream reduces drag as
  well as downforce. `setWake(distance = Infinity, lateral = 0)` (reached
  through `VehiclePhysics.setWake`) once per tick: CarManager passes the
  nearest car 0.5–60 m ahead, else (999, 99). Any distance past four
  e-folding lengths (48 m with the 12 m config) switches the wake off.
- Damage fractions 0..1 (`setDamage(front, rear, floor)`, each clamped) cost
  downforce and add drag.
- `oneGSpeed` getter: speed at which the car generates its own weight, from
  the base ClA (`sqrt(m·g / (0.5·ρ·ClA))`, no ground-effect gain).

### 4.6 Powertrain (`src/physics/Powertrain.js`)
- Torque path: ICE + MGU-K on the crank → clutch → gearbox → final drive →
  LSD → rear wheels. When the clutch is locked, engine speed is a kinematic
  function of the rear wheels and crank inertia is reflected onto the axle —
  stable at 240 Hz and why first gear feels heavier than eighth.
- Clutch lock hysteresis: locks once gearbox input catches idle, stays locked
  until well below it — without hysteresis it chatters on every torque
  reversal at walking pace. Slipping capacity is modulated by throttle
  (controllable launch) and releases entirely off-pedal — that IS the
  anti-stall, and why the car does not creep at idle.
- Fuel-flow clamp applied to delivered torque (regulation caps the top end,
  not airflow). Fuel metered off shaft power: flow = P/(BTE·LHV), clamped at
  fuelFlowMax.
- Reverse only from near standstill, only through neutral. Downshifts that
  would bounce the engine off the limiter are refused. Auto-upshift is
  supported by ROAD SPEED, not just rpm — during a burnout the crank
  genuinely is on the limiter and an unguarded box runs to 8th at 50 km/h.
- MGU-H spins the compressor directly (removes turbo lag) but only while the
  store has energy; recovers off the turbine whenever exhaust does more work
  than the compressor needs (no per-lap cap by regulation). MGU-K deploy is a
  crank torque stacking on the ICE; tapers near the limiter.
- Traction control (assist, default off) trims throttle on MEASURED rear slip
  — at 1.0 the car still spins its wheels, it just stops making it worse.
- Brake-by-wire: MGU-K takes as much of the rear demand as it can, calipers
  make the remainder — why modern F1 rears run cool. ABS (assist, off by
  default — a real F1 car has none) releases the caliper on incipient lock.
- LSD: Salisbury type — preload + separate power/coast ramps, saturating at
  plate capacity; the faster wheel gives torque up.
- Disc thermal balance: friction work in, forced convection out (§4.1 duct
  numbers). `notifyLap()` zeroes the per-lap ERS counters
  (`ers.deployedThisLap`, `ers.harvestedThisLap`). RaceDirector calls it
  whenever its timing advances a lap (first thing in `_onLap`, before the
  counted-lap check and the `race:lap` emit), and CarManager's own lap bookkeeping calls it through
  `VehiclePhysics.notifyLap()`.
- `step(dt, controls, wheelOmega, slipRatio, speed, airSpeed, events)`:
  wheelOmega forward-positive rad/s; events bus raises `car:shift`.

---

## 5. Rendering: pipeline, sky, materials

### 5.1 RenderPipeline (`src/render/RenderPipeline.js`)
Chain: scene (HDR+depth) → velocity buffer → GTAO → TAA resolve (folds AO
apply) → tile-max/neighbour-max → motion blur (folds godray composite) →
bloom pyramid + auto-exposure metering → tonemap+grade+lens+flare+vignette+
grain (ONE pass) → SMAA/FXAA → screen. All HalfFloatType until the final
display-referred sRGB write.
- **TAA resolve sits BEFORE motion blur** — accumulation must happen on the
  jittered pre-blur image or the history accumulates smear and every frame
  re-blurs the last frame's blur. SMAA still runs last on the
  display-referred image.
- **Godrays composite inside the motion-blur pass** (no separate fullscreen
  round trip) but still land before bloom so the shafts bloom.
- **Why not EffectComposer**: it cannot express a pass reading two private
  buffers at once (resolve reads scene+AO+velocity+history) or consuming a
  target it did not write; its buffer clone would add a second depth
  attachment to keep in sync. Same structure, explicit routing.
- Halton(2,3) jitter in [-0.5,0.5]: 16 frames cover the pixel evenly.
- Per-tier SAMPLE budgets live here; boolean feature flags come from
  `ctx.quality` (settings panel stays authoritative).
- Bloom sampling is clamped to the source's half-texel-inset interior:
  ClampToEdge + fixed texel offsets turn the outermost row/column into an
  infinite smear, and the chain cannot halve exactly at odd sizes
  (1620→810→405→202→101) so offsets do not land where the filter assumes.
  Filter degrades to a narrower kernel at the border instead. Bloom chain
  stops before degenerating (a 2×4 mip carries no usable low frequency).
- Exposure readback target is RGBA8 (readRenderTargetPixelsAsync only accepts
  unsigned-byte RGBA); the godray occlusion reduction is read back
  asynchronously (one allocation every sixth frame — the price of not
  stalling; a two-frame-old value is imperceptible on an effect SkySystem
  already damps). On frames with no shaft buffer, hand the sky a CLEAR
  result rather than freezing the last one.
- `SHUTTER_SECONDS = 1/100`: broadcast F1 is shot nearer 1/100 than the
  1/120 a 180° shutter at 60 fps implies; the extra fifth of a stop of
  movement is most of what makes onboards read fast. Normalising the blur to
  a fixed shutter (a) stops blur doubling when frame rate halves, (b) makes
  captures (several physics steps between presents) expose like gameplay:
  the velocity buffer holds displacement over `_historySpan` sim seconds and
  is rescaled to the shutter.
- `MAX_BLUR_PX_1080` (24 px at 1080) is art-directed and pinned in PIXELS at
  the reference height, scaled with vertical resolution (a UV ceiling is
  anisotropic: 0.022 UV was 42 px across and 24 px down the same frame).
- Speed gate: zero below ~80 km/h, full at ~320. Camera travel is the honest
  measure across camera modes, but a broadcast tower camera is stationary
  while the cars are not — the player's road speed sets a floor. Below the
  gate the whole blur pass is skipped and this is EXACT, not approximate:
  zero speed scale zeroes every gathered vector, lenVmax lands under the
  one-pixel floor, the reconstruction block never runs, and what the pass
  writes is character-for-character what GodrayOnlyShader writes (shared
  GODRAY_MASK_CHUNK). No shafts + no blur = pass the source through; shafts +
  no blur = one-quad shaft composite. Both bit-identical to the full chain,
  saving two tile-max reductions, neighbour-max and a full-res gather on
  every grid/pit/slow frame.
- `SHAFT_EDGE_FULL`: the shaft pass is a radial blur about the sun's screen
  position; once that origin leaves the viewport the blur drags whatever is
  on the nearest screen edge across everything. `sunVisibility` is a FLARE
  term (nonzero out to NDC 1.7, correctly — off-frame sun really does put
  veiling glare in). Driving shafts off it washed cockpit-pack to a white
  smear (sun at NDC y=1.27 still reporting 0.68). Shafts get their own term:
  full while the disc is on screen, gone shortly after.
- `SHAFT_STRENGTH = 0.25` is the shaft radiance as a fraction of the sky it
  is cut from: the composite intensity is `SHAFT_STRENGTH /
  _shaftChainGain × _shaftFade`, i.e. 0.25 × the weighted average of the
  mask along the ray to the sun (§5.2). The old constant was 0.85 on the
  raw blur sum, adding about 256× the masked sky at 16 taps and 648× at 24.
  No stock scenario had the disc in frame until the sunset shot was aimed
  at the sun (`src/game/Scenarios.js` `goldenHourShot` /
  `sunFacingDistance`). With it in frame (cockpit-sunset down the descent
  to Bruxelles, high quality) the old sum laid a white veil: exposure was
  pulled from 2.0 to 0.3 and the p50 still rose from 130 to 232. Measured
  p50 at strength 0.25 / 0.5 / 1.0: 138 / 143 / 149, against 130 with
  shafts off. At 0.25 the beams are clear (through cloud, round the halo);
  at 0.5 the disc starts to glow; at 1.0 the road hazes. The median moves
  more than the mean there (mean lift 1.0 at 0.25): that frame's histogram
  is steep through the middle, about four counts per percentile.
- `_shaftChainGain` = `shaftChainGain(cfg.samples.godraySamples)`, set in
  `_applyConfig` (1 until then). Only the composite intensity is
  normalised: `_godrayRT[0]` still holds the raw (clamped, §5.2) sum,
  because the lens flare's visibility gate is calibrated against that scale
  (§5.3). The final material's `tGodray` is still `_godrayRT[0]`, and
  `uGodrayIntensity` does not affect it.
- `uGodrayIntensity` is a normalised value of order 1e-4 to 1e-3 (0.25 ÷ a
  chain gain of 147–763; ~3e-7 on ultra at fade 1e-3). Any on/off test on
  it must be `<= 0`, never an absolute epsilon. `_renderShafts` runs every
  frame before `_renderMotionBlur` and writes exactly 0 when shafts are
  disabled or `_shaftFade <= 1e-3`, so the `<= 0` godrayOnly early-out in
  `_renderMotionBlur` skips exactly the frames with no shafts. The fade
  threshold lives in `_renderShafts`, not on the scaled intensity; the old
  `<= 1e-3` there would now skip every shaft frame at 16 or 24 taps.
- Wheel rotational blur: a hub barely moves relative to a cockpit camera but
  the rim turns ~240 rad/s at 310 km/h (a rev every 4 frames) — screen-space
  velocity is enormous and aliased, so tread/spokes look parked. The blur
  pass sweeps the tyre along its own arc (uWheel0..3: disc centre UV, radius
  in aspect-corrected UV, arc swept during the shutter; plus per-hub view
  distances). Rolling radius comes from |v|/|omega| (slip is 1–2%, good to a
  pixel, no new WheelState field). Sphere → NDC: half-height of frustum =
  viewDist/p11, so a sphere subtends radius·p11/viewDist in NDC-y. A hub just
  off-frustum still has tread in frame — generous margin, or a hard edge runs
  down the border. Wheel arc capped (`WHEEL_MAX_ARC` = 0.85 rad); below
  `WHEEL_MIN_RATE` = 12 rad/s hub rate there is nothing to smear. GLSL ES
  1.00 forbids dynamic vector indexing — the JS side unpacks uniforms
  accordingly (shader side: §5.2).
- `sceneColorTexture` (`_sceneRT.texture`) is the linear-HDR colour of the
  most recent completed scene pass: pre-AO and pre-exposure, and it includes
  that frame's haze and visor draws. Every system's `lateUpdate` runs before
  `pipeline.render` (`Engine.present`), so reading it there gives the
  previous frame. That one-frame-stale image is what the screen-space
  refractors (heat haze, visor film) need: it is in the same colour space as
  the buffer they composite into, and unlike the drawing buffer it is
  available on any hardware (§2.9).
- AO normal reconstruction takes the closer-depth neighbour on each axis
  (best-of-two derivatives). Without this the normal folds over at
  silhouettes and draws a bright halo around every wing element.
- AO bilateral blur taps are clamped to `uSourceMin/uSourceMax` (half-texel
  inset of the AO target). An unclamped separable tap repeats the edge texel
  along the blur axis and creates a border streak.
- The TAA resolve multiplies AO into the 3×3 neighbourhood samples as well as
  the centre, so history stores post-AO colour. Otherwise occlusion compounds
  every frame and the cockpit turns black.
- The TAA blend uses Karis weights `1/(1 + luma)` (YCoCg Y) on current and
  history, so a firefly is down-weighted before it is locked into history and
  smeared over many frames. `uSharpen` (0.22, TAA only) is an unsharp mask
  against the YCoCg neighbourhood mean. YCoCg is linear, so that mean
  converts back to RGB exactly. The mask restores edge contrast lost to
  bilinear history resampling without bringing back aliasing.
- The bloom prefilter takes a Karis average of its 4 taps, so one sub-pixel
  specular on a wing endplate cannot pump the whole pyramid and cause
  flicker. `uThreshold` 1.25 and `uKnee` 0.6 are divided by the current
  exposure, so a tunnel that opens the iris does not make the whole frame
  glow.
- Matrix autoUpdate is suspended across the two render calls (world matrices
  are already up to date), restored in `finally` so a throw inside a pass
  cannot leave the scene without matrix updates for the session.
- Every depth-linearising pass gets the same camera planes the scene was
  drawn with — module defaults silently mis-scale blur and shaft masks.
- Camera near plane per mode: cockpit needs 6 cm (wheel rim); distant modes
  push it out for depth precision (`src/game/CameraRig.js`).
- `NIGHT_EXPOSURE_*`: auto-exposure is a normaliser — pointed at a night lap
  it hands back the daylight median and renders a grey day. The meter cannot
  tell them apart (a floodlit night frame's log-average reads HIGHER). The
  one separating fact is not in the image: the sun is below the horizon — so
  the GRADE, not the meter, carries the night compensation, released above a
  sun-elevation threshold.

### 5.2 Motion blur / godray shaders (`src/render/shaders/MotionBlurShader.js`, `GodrayShader.js`)
- McGuire 2012 reconstruction: TileMax collapses velocity to one dominant
  vector per 20×20 tile (separable: two 20-tap passes, not one 400-tap),
  NeighbourMax dilates 3×3, reconstruction walks the dominant vector even for
  stationary pixels — a barrier can smear over the sky behind it.
- TileMax tap origin is `vUv - step·(TILE_SIZE/2 - 0.5)`: vUv sits at the
  centre of a destination texel that spans TILE_SIZE source texels along
  `uAxis`, so this walks back to the first of them. NeighbourMax: edge
  neighbours always count; a DIAGONAL neighbour counts only when its vector
  points at this tile (`dot(-offset, v) >= 0`), otherwise a corner tile drags
  blur into pixels it never covers.
- Every length in the reconstruction is a pixel count (`apexLenPx` =
  `length(v * uResolution)`): comparing in UV made a horizontal streak count
  1.78× a vertical one of the same visual size.
- `apexSoftZExtent = max(0.15, 0.03 × nearer distance)` m is the separation
  at which two surfaces stop occluding each other — the number that decides
  whether a solid object stays solid. Each tap is classified against the
  centre pixel: foreground = "tap is in front, let its streak cover me",
  background = "tap is behind, I may reveal it if I am moving". The old fixed
  1.6 m (a car length) still scored a tap 1 m BEHIND the centre 0.375
  foreground; the tarmac behind a rear tyre moves at 300 km/h while the
  chase-carried tyre does not, so 12 taps (the shader's default
  `MB_SAMPLES`; the tiers set 8/10/14/20) × 0.375 = 4.5 against a stationary
  centre weight of 1/0.5 = 2.0 — 69% of the rear tyre was road (the
  semi-transparent tyre). Now 150 mm on a cockpit rail, 180 mm on a rear tyre
  6 m out, 0.9 m at 30 m. Scaled off `min(zc, zs)`: near-against-far gets a
  hard silhouette, two distant surfaces still blend softly, and a barrier
  8 m out against far-plane sky still scores a full 1.0 and streaks over it.
- Centre weight is `1/lenVc` with `lenVc` floored at 0.5 px: a stationary
  pixel divides by something finite, and its cone stays half a pixel wide —
  that is what keeps a fast tile from gathering the background over a cockpit
  rail that has not moved. Taps alternate between the tile-dominant vector
  (even i) and the pixel's own vector (odd i) so both "something fast passes
  over me" and "I am the fast thing" reconstruct. Tap positions are jittered
  per pixel by interleaved gradient noise (`apexIGN`, seed `frame % 64 ×
  13.7`): cheap, stable under motion, no visible tiling.
- Shader caps the shutter fraction: `shutter = min(uStrength, 1.5)`.
  uStrength is the shutter time (`SHUTTER_SECONDS`) ÷ the interval the
  velocity buffer spans; the pipeline's guard lets it reach 4 (then × the
  0–2 `motionBlurStrength` setting) when a capture presents faster than it
  simulates, and uncapped that blurred a still frame up to four times harder
  than the same corner looks in motion. A shutter longer than the velocity
  interval is not something a camera does.
- Depth-masked shaft composite shared by both owning passes: shafts are
  in-scattered light integrated along the view ray; a surface 2 m away has
  almost no air in front of it. Unmasked adds put bright bands across front
  tyres/halo/cockpit. Nothing inside 4 m receives shaft; full strength past
  30 m.
- `apexShaft` (GODRAY_MASK_CHUNK) returns early when `uGodrayIntensity <= 0`
  instead of multiplying by zero: on a frame where shafts were not rendered
  the buffer holds whatever the driver left there, and Inf × 0 = NaN. This is
  the shader-side half of the clear in §2.8. It forms `uGodrayIntensity ×
  mask` before multiplying by the texel, and both MotionBlurShader and
  GodrayOnlyShader declare `precision highp float`, so the normalised
  intensity (down to ~3e-7, §5.1) keeps full precision.
- `uCentreClarity`/`uCentreRadius`: the apex is mid-frame and must stay
  readable; the periphery carries the speed. Live defaults (RenderPipeline
  never overrides them): 0.35 of the computed blur out to normalised radius
  0.2, smoothstepped to full strength at the frame corners — the radius is
  normalised (0 dead centre, 1 in the corners, whatever the aspect).
- `uBlurFar`/`uFarBlurFloor`: blur is a near-field effect (trackside
  furniture); past the far distance the only motion is camera rotation
  dragging a static backdrop — keep a token floor so a barrier can streak
  over the hills, never enough to mush sky/rooflines. Live defaults: blur × 1
  → `uFarBlurFloor` 0.15 over view distance `uBlurNear` 100 m → `uBlurFar`
  300 m, so a foreground object can still streak over the far field without
  the sky going with it.
- Wheel pick: `apexWheelPick` is called four times rather than looped over a
  uniform array so every index stays a compile-time constant (all GLSL ES
  1.00 guarantees); the best-covering wheel wins. Cover = rim feather
  (smoothstep 0.80→1.0 of disc radius, so the blurred disc does not end on a
  hard circle) × hub-depth test, so the blur cannot leak onto the track
  behind. `apexWheelTolerance = max(0.45, 0.12 × hubDist)` m: a tyre occupies
  a slab one diameter deep about its hub (0.72 m on a front), so 0.45 m
  either side covers it; the relative term keeps the test meaningful at 30 m
  in a chase shot. The old 1 m of slack swept in the whole inboard corner —
  wishbones, brake duct and upright all sit inside the wheel's projected disc
  within ~0.25 m of the hub.
- Arc-sample depth test `apexArcTolerance = max(0.20, 0.08 × dist)` m is
  measured against THIS pixel's depth, not the hub's — it decides whether the
  filter blurs a wheel or paints the suspension through it. Rotating about
  the hub keeps screen radius, so on a rolling tyre a sample lands on the
  same annulus of the same part at essentially the same distance; anything at
  a materially different distance (wishbone crossing the sidewall, duct,
  tarmac between spokes) is another object, and averaging it in put the front
  suspension on top of the tyre in every moving frame. The 0.20 m floor
  survives the depth a legitimate sample gains from the rotation itself: half
  of `WHEEL_MAX_ARC` (0.85 rad) ≈ 24°, which on an obliquely-seen 0.36 m
  radius tyre moves a tread pixel up to ~0.15 m in view depth; 0.20 keeps
  those and rejects a wishbone 0.25 m proud of the flank.
- The arc accumulator is seeded with the pixel's own colour at weight 1 and
  the result mixes in by `cover × clamp(wsum - 1, 0, 1)`. A pixel inside the
  disc that is not the rolling part (wishbone in front of the sidewall,
  caliper, tarmac between spokes) finds nothing along its arc to agree with
  and collapses back to exactly itself, instead of taking its colour from one
  stray tap that cleared the depth test. Below one full-weight agreeing
  neighbour the filter stands down rather than averaging a pixel with itself
  and calling the result motion.
- Godray occlusion stage keeps only bright sky pixels near the sun —
  geometry silhouettes cut shafts for free. `GodrayOcclusionShader` seed =
  sky (`step(uDepthCutoff 0.9994, depth)`) × `smoothstep(uThreshold 0.9,
  0.9 × 2.6)` of pre-exposure scene luminance × `(1 - d/uRadius 0.85)²`
  about the sun: only genuinely bright sky seeds a shaft; overcast haze must
  not glow. Alpha carries the bare depth mask, not the weighted colour:
  RenderPipeline's `SUN_OCCLUSION_SHADER` averages it over 5×5 taps (±0.035
  × ±0.06 UV) round the sun every 6th frame and hands it to
  `SkySystem.setExternalOcclusion` — colour alone cannot say whether the disc
  is behind a grandstand, because a dim sky is not an occluded one. The
  reduction runs straight after the occlusion blit, before the blur passes
  overwrite `_godrayRT[1]` (GodrayBlurShader writes alpha 1). With shafts
  off, the pipeline sets the external occlusion to 1.
- Radial blur: `GodrayBlurShader` runs once per entry of
  `GODRAY_BLUR_PASSES` (three), and each pass's span SHRINKS — `density`
  0.55 → 0.22 → 0.09, `decay` 0.962/0.975/0.985, `weight` 0.38/0.55/0.62.
  `density` is the share of the pixel-to-sun distance a pass spans: the
  first pass gives the shaft its reach and the next two fill in between its
  taps, without 48 taps in one loop. The loop reads `_godrayRT[(i & 1) ^ 1]`
  and writes `_godrayRT[i & 1]`, i.e. `[1]` → `[0]` → `[1]` → `[0]`, and
  relies on GODRAY_BLUR_PASSES having an ODD length so the result lands in
  `_godrayRT[0]`, where motionBlur, godrayOnly and final read it; an even
  count would leave it in `[1]`. Taps are dithered per pixel so they do not
  band; `GODRAY_SAMPLES` is 16 by default and on medium/high, 12 on low, 24
  on ultra. The composite fades by off-screen drift, surviving occlusion,
  and receiver depth; `sunScreenFade` ramps so the effect never pops at a
  frame boundary.
- **Chain gain** — `shaftChainGain(samples, passes = GODRAY_BLUR_PASSES)`:
  each pass SUMS its taps, so a uniform mask comes out multiplied by the
  product over the passes of `weight × Σ decay^i` = `weight × (1 −
  decay^samples) / (1 − decay)`: 146.9 at 12 taps (low), 300.6 at 16
  (medium/high), 762.6 at 24 (ultra). Dividing the blurred buffer by it (in
  the composite intensity, §5.1) turns it into a weighted average of the
  mask along the screen-space ray to the sun: bounded by the brightest
  masked sky on the ray and independent of tap count. Without it the same
  frame drew its shafts ~2.5× brighter on ultra than on high. Clamping a
  tap's UV to the frame edge changes where the tap reads, not its weight,
  so the quotient is a true average for every pixel.
- **Blur output clamp**: `min(acc × uWeight, vec3(65000.0))`, just under the
  largest finite half float (65504). At 24 taps the sunset disc texel
  summed to about 52000 in green and +Inf in red; that Inf reached the
  bloom prefilter's Karis weights as Inf × 0 and knocked out bloom and lens
  ghosts around the disc on ultra. Wherever the sum fits, the clamp does
  nothing.

### 5.3 Lens/final pass (`src/render/shaders/LensShader.js`)
- One folded fullscreen shader (tonemap, grade, CA, distortion, flare, dirt,
  vignette, grain, sRGB): five more full-res 16-bit round trips would be most
  of the post budget in bandwidth alone.
- Broadcast prime basis: barrel distortion -1.5% at the corner; lateral CA
  grows with r² (uniform CA reads instantly as a filter) — 0.0016·r2max ≈
  3.2 px on a 1920 frame, not nine.
- Bloom contribution ceiling in post-exposure units (prefilter clamps
  relative to exposure; a high-exposure frame could otherwise hand the
  composite a halo brighter than the source).
- Bloom ghosts: three taps of the bloom pyramid reflected back through the
  optical centre (`uvG + (0.5 - uvG) × 0.62 / 1.35 / 1.86`), tinted blue /
  amber / green per element the way a real multi-group lens splits a bright
  source; `uGhostStrength` 0.028.
- Veiling glare / anamorphic streak gated on uSunFade (costs nothing without
  the sun). Raised 0.12/0.09 → 0.34/0.20: the scene buffer is pre-exposure
  scene-linear (white ≈ 1.0, asphalt ≈ 0.05); 0.09 put the streak at 2% of a
  clear sky — mathematically present, invisible in every capture. Now ~a
  tenth of the sky it crosses and several times the asphalt under it.
- The whole sun-flare block (core, veil, streak, halo, ghost train) is an
  `if (vis > 0.0008)`, and `vis = uSunFade` = SkySystem's own
  `sunVisibility` (horizon, off-screen edge fade, cloud transmittance and the
  depth-based occlusion factor read back round the disc, §5.2). So the
  optical response switches off the moment a grandstand roof crosses the sun,
  and a frame with the sun behind the camera pays for none of it and is left
  bit-identical. When the shaft pass ran (`uUseGodrayVis`), vis is further ×
  `clamp(3.2 × luma(tGodray at the sun))`. That is a branch, not a `mix()`:
  on a frame with no shaft pass the buffer is undriven and mix() would still
  evaluate its NaN into the result (§2.8). `tGodray` is `_godrayRT[0]`, the
  RAW (clamped) blur sum, and the 3.2 is calibrated against that scale: the
  shaft normalisation lives in `uGodrayIntensity` (§5.1); normalising the
  buffer itself would silently recalibrate this gate.
- Flare terms (r in aspect-corrected UV; × `uFlareStrength` 0.34 unless
  noted): veiling glare in two lobes — tight core `exp(-r²·340)` × 3.0 (the
  bloom round the source) and wide faint veil `exp(-r·4)` × 0.25 (what a sun
  just outside the frame puts into the picture; why shooting into a low sun
  lifts the blacks across the whole image, not only next to the disc).
  Anamorphic streak (× `uStreakStrength` 0.20): a cylindrical front element
  smears a point source along one axis; two stacked falloffs — hard line
  `exp(-|y|·150)·exp(-|x|·4)` inside a soft bar
  `0.30·exp(-|y|·24)·exp(-|x|·1.8)` — avoid a single stripe with a visible
  edge; tinted 55% toward (0.40, 0.58, 1.00) because those elements' coatings
  make the bar blue, not sun-coloured. Iris halo (the ring the aperture blades
  throw): `exp(-(r - 0.215)²·900)` × 0.30.
- Sun ghost train: five internal reflections on the line from the sun
  through the optical centre (`axis = 0.5 - uSunUv`, at 0.52 / 0.88 / 1.26 /
  1.72 / 2.30), spaced by which surface pair they bounced between and tinted
  by that group's coating; × `uSunGhostStrength` 0.07. Five is what a modern
  coated prime throws into a low sun — more reads as a screensaver. Unrolled,
  not looped, so the compiler folds the constants (fullscreen pass, every
  pixel). `apexGhost` profile: an aperture ghost is not a soft blob but a
  near-flat disc (body 0.55, full inside 0.55 R, gone at R) with a brighter
  rim (×1.10, band 0.66–1.0 R peaking at 0.86 R) where the defocused iris
  edge piles up — the rim is why it reads as glass rather than a smear of
  bloom. The train is × `(0.55 + 1.20·dirt)`: a reflection lands on the front
  element, and whatever is smeared on the glass scatters it into the picture.
- Vignette (natural falloff: `uVignette` 0.34 over aspect-corrected radius
  `uVignetteSoft` 0.28 → 1.05) is applied to the HDR BEFORE `apexGrade`, so
  the tonemapper rolls the darkened corners rather than the grade being
  multiplied after the shoulder has already been applied.
- Film grain lives in the toe and nowhere else: 1% peak-to-peak (`uGrain` =
  0.01 × the `filmGrain` setting), weight `smoothstep(0, 0.045, luma) × (1 -
  smoothstep(0.05, 0.34, luma))` on the graded display-linear colour. Silver
  halide is coarsest just off the floor, absent in true black (no exposed
  grain there) and gone by the mid-tones, so a clear sky stays clean while
  the shadowed cockpit breathes; 0.028 crawled visibly across a clear sky,
  and the previous curve still left 22% of full amplitude in the sky, which
  read as noise crawling over flat blue. Noise is two hash octaves (0.66 at
  pixel scale + 0.34 at 0.47× scale) so it has clump structure instead of
  reading as TV static.
- Final ±½-LSB hash dither after the sRGB encode: 16-bit linear collapsing
  to 8-bit sRGB bands visibly across a clear sky without it.
- Lens dirt modulates bloom (`1 + dirt·uDirtAmount` and
  `dirt·bloomLum·uDirtGlow`) and the sun ghost train — visible only where
  something bright is behind it, like a real dirty front element. Smudges
  concentrate in the outer thirds (where thumbs/spray land), wipe arcs,
  scratches, dust.

### 5.4 Tonemap and auto-exposure (`src/render/shaders/TonemapShader.js`)
- Hill fit of the full ACES RRT+ODT (both 3×3 matrices around the rational
  fit), NOT single-expression Narkowicz: the matrices desaturate blown
  highlights toward white instead of clipping to a flat primary — carbon
  airbox as metal vs magenta blob.
- Grade: broadcast-F1 look — zero black lift, log-space mid slope 1.52,
  hyperbolic pre-roll + max-channel soft clip so no channel reaches 1.0.
  Response on a neutral ramp at exposure 1: 0.003→0, 0.02→1, 0.045→11,
  0.09→36, 0.36→164, 0.72→223, 6→250, 32→250.
- White point 24 (a 9.0 white point rolled specular off two stops below
  display white: 0.05% of pixels over 250 = no specular at all) — 24 keeps
  the ODT input under where the Hill fit saturates (~25.6). The soft-clip
  knee/ceiling pair sets where display 250 lands: at 0.97/1.0 the crossing
  (0.9546) sat BELOW the knee, so the roll never engaged and 9% of a sunlit
  braking frame clipped; the tuned pair moves the crossing to 0.9655 on a
  very steep population edge (measured: 4.4% of the frame above 0.9546,
  0.08% above 0.9745). Ceiling deliberately above the crossing — a frame
  with zero pixels over 250 has no specular top end (the round-2 complaint).
- White balance (`apexWhiteBalance`, `uTemperature` 0.1 = slightly warm):
  per-channel gains (1 + 0.175t, 1 + 0.02t, 1 − 0.2t), then renormalised to
  the input's Rec.709 luma, so warming never also brightens. The meter reads
  the ungraded HDR buffer, so auto-exposure would not correct a grade that
  brightened.
- Contrast (`uContrast` 1.52) is `0.18·pow(c/0.18, k)`: a power pivoted on
  scene mid-grey, applied after the white-point pre-roll and before the ACES
  fit. A power in linear is a straight slope in log2, so it is pure mid-tone
  gamma: it opens the separation between surfaces a third of a stop apart
  (racing line against tarmac).
- Toe/shoulder (`uToeShoulder` 0.1) mixes the display value toward
  smoothstep x²(3 − 2x): an S about 0.5 with zero slope at both ends, so it
  pulls the bottom toward black and softens the top while the mid-tone slope
  stays `uContrast`'s job.
- `uLift` is zero by default: a lifted black is what made every frame read
  as washed-out mid-grey.
- Lift/gamma/gain, then a per-channel curve, all on the display value after
  toe/shoulder and before the split tone: `uLift + disp·(uGain − uLift)`
  (gain (1, 0.996, 0.986)), `pow(disp, 1/uGammaCtl)` (gamma (1, 1, 1.006)),
  then `pow(disp, uChannelCurve)` with `uChannelCurve` (0.99, 1, 1.014) —
  a touch more shoulder in blue, less in red. Both ends (0 and 1) stay put.
- Split tone is multiplicative (`disp *= mix(uShadowTint, uHighlightTint,
  split)`, split = smoothstep of luma^0.55): black stays black while low
  mid-tones go cool (0.945, 1, 1.07) and highlights warm (1.045, 1.01,
  0.945). That is the broadcast look without tinting the black point.
- Why the max-channel soft clip runs last: the warm highlight tint and the
  1.1 saturation boost can push a channel past 1.0 after everything above.
  Only the largest channel is rolled and the whole triple is scaled by the
  same factor (channel ratios kept, no per-channel hue skew). The ceiling
  (0.982) sits below 1.0, so a highlight always keeps some colour instead of
  becoming a flat white hole.
- **EXPOSURE_METER_POWER = 0.5 — the metering statistic, and the fix that
  mattered**: the old log-mean (p→0) is dominated by the darkest pixels; a
  braking shot with a deep cockpit metered BELOW a grid shot it renders 60%
  brighter than (log-avgs 0.0728 vs 0.0877 at matched exposure, medians 129
  vs 81), so correction went the wrong way — daylight medians ranged 75–148.
  p = 0.5 (mean of √L) tracks the display curve's mid-tone slope: frames
  whose displayed means agree have medians within a couple of counts.
  Reduction and adaptation must share the exponent — both read this constant.
- `EXPOSURE_KEY_BIAS = 0.0`, deliberately: with the right meter the residual
  is gone — fitting exposure-for-median-100 against metered L across three
  shots spanning 2.3× gives E ∝ L^-0.99, the textbook key/L law within a
  percent; anything nonzero fits noise. Mechanism kept for future scenes.
- `EXPOSURE_MIN_LUMINANCE = 0.0625`: the adaptation floor is the only thing
  between a night race and daylight; set between the low-sun cockpit (meters
  0.058, wants all its exposure) and the night race (0.041, would be handed
  ~1.5 stops too much). Clamps night to low-40s median while costing the
  sunset ~10 counts — both inside their bands, little room either side.
  `uMaxExposure` is DERIVED as `key(min)/min` so the floor is the only clamp
  that can bind — when the two disagreed, night metered below the floor,
  saturated at a separate higher ceiling, and every faint edge was gained
  into the bloom threshold ("amplified grey fog").
- Metering window clamps L to [0.004, 6.0] (~six stops under mid-grey to
  ~five over) BEFORE the exponent: frames run from 3e-3 footwell to 100+
  solar disc inside one 64×64 reduction and either tail can own the mean —
  a handful of sun texels move it half a stop. Centre-weighted (a broadcast
  operator exposes for the car, not the sky).
- `LuminanceShader` takes four rotated-grid bilinear taps (±0.5/±1.5 source
  texels) per 64×64 destination texel, which is dense enough for a stable
  mean. Luma is clamped as `clamp(max(raw, lo), lo, hi)` on purpose: a NaN
  or negative value out of the HDR buffer lands on the 0.004 floor instead of
  poisoning the whole reduction. Do not simplify it to a bare clamp.
- The reduction carries the weighted means of L^p·w and w in R/G, and
  adaptation takes (R/G)^(1/p). That is the weighted power mean back in real
  luminance units, so `uMinLuminance`/`uMaxLuminance` (0.0625/12) read as
  luminances. The exponent guard `abs(p) < 1e-3 ? 1e-3 : p` keeps the sign:
  a negative power mean stays usable and only the 1/p blow-up near zero is
  replaced. Do not rewrite it as `max(p, 1e-3)`.
- `ExposureAdaptShader` NaN guards are negated comparisons
  (`if (!(x > 0.0))`) on target, previous and adapted. A NaN from an empty or
  half-float-degenerate meter fails every comparison, so it falls through to
  the floor (or to target, for previous) instead of poisoning the 1×1
  ping-pong for the rest of the session. `x <= 0.0` would let the NaN
  through.
- Adaptation: rising light adapts faster than falling (iris/broadcast
  behaviour); `uReset` adopts the meter outright on the first frame after
  (re)allocation (undefined half-float seed, and a 1×1 ping-pong can only
  slew out of a bad seed); above `uSnapStops.y` stops of disagreement the
  frame is treated as a CUT and adopted immediately (camera change, scenario
  load, tree line at 300 km/h) — without it a cockpit→chase cut spent over a
  second exposed for the previous shot, and few-frame consumers (capture
  harness, photo mode, paused menu) never re-exposed at all, 1–3 stops off.
  Below `uSnapStops.x` it slews (meter noise band). GPU-only reduction
  (L^p power mean → 16 → 4 → 1 → smoothed 1×1 ping-pong): nothing read back
  to the CPU, no stall.

### 5.5 SkySystem (`src/render/SkySystem.js`) + AtmosphereShader + CloudLayer
- One physical quantity drives everything: top-of-atmosphere solar irradiance
  in renderer units (`SUN_TOA_IRRADIANCE = 4.6` puts a white lambertian in
  noon sun at ~1.0 linear — where an ACES grade at unit exposure expects
  diffuse white). Sun light, dome, hemisphere fill, fog and cloud shading all
  derive through the same scattering model — a sunset reddens barriers, fog
  and tyre smoke together.
- `SUN_DISC_SCALE = 0.0015`: true disc radiance is E/6.8e-5 sr ≈ 67 000 —
  bloom eats the frame and the auto-grade collapses; 0.0015 keeps it ~100
  against a 0.15 sky, still blowing out hard and driving bloom.
- The disc is a mesh, not the dome's ray-march disc: occludable by geometry,
  carries spectral transmittance (a low sun goes RED on its way to dim —
  resolved against the very transmittance dimming the beam), authored
  aureole. The dome's own sunDisc is off in BOTH the on-screen dome and the
  environment capture — the env capture drops it because the
  DirectionalLight already carries the direct sun and baking the disc into
  the PMREM would count it twice (hot blob smeared across every glossy
  surface). Leaving both disc paths on draws the sun twice at two
  brightnesses.
- Disc is NOT gated on the flare `visibility` term — that would dim it as it
  approaches the viewport edge, which nothing in the world does. What hides
  it: horizon (`horizonFade`), cloud (`cloudT`), and draw order — the
  sun-disc material has depthTest and depthWrite off and renderOrder −999, so
  scene geometry hides it by drawing over it later, not by a depth test
  (§2.11).
- Sun quad vertex: built around the view-space sun direction, projected with
  w = 0 (at infinity) and z = 0.999999·w, which pins it just inside the far
  plane. With depthTest/depthWrite off, the pin only keeps the primitive
  inside the clip volume. Geometry hides the sun by drawing over it:
  renderOrder −999, after the dome at −1000 and before everything else.
- `limbDarkening` uses the Neckel & Labs visible-band fit, with per-channel
  exponents (0.397, 0.503, 0.652) on μ. Blue falls fastest, so the limb goes
  red before the centre does: the one detail that separates a rendered sun
  from a white circle. The dome's `atmLimbDarkening` has the same exponents
  but only compiles under `SUN_DISC`, which is off for both dome and capture.
- Limb antialiasing uses `fwidth(radii)`, giving one pixel of limb at any
  resolution. The 0.53° disc is ~10 px across at 1080p (default 82°
  horizontal FOV), so a fixed softening constant either aliases or eats the
  disc.
- Aureole: driven by Kasten-Young air mass (1 overhead, 6 at 9°) — the glow
  is fed by the same column reddening the disc. Gain ∝ √airmass (linear runs
  away into a white sky: past a couple of air masses the feeding beam is
  extinguished about as fast as it is scattered in). `SUN_GLARE_RADII` 56
  solar radii = 15° (quad span = `SUN_ANGULAR_RADIUS · SUN_GLARE_RADII`): a
  9° quad cut the low-sun skirt with a visible circular step;
  `SUN_GLARE_FRACTION` 0.24 of disc radiance at the limb = hazy-clear day;
  air mass clamped at `SUN_GLARE_MAX_AIRMASS` 12 (formula runs to 38 at the
  horizon where the disc is gone anyway).
- `aureole(r)` (r in solar radii) has two lobes. The steep core
  `(1/(1 + 0.30r²))² × 0.75` is single-scattered aerosol and near-forward
  diffraction and dominates within a couple of radii. The shallow skirt
  `exp(−0.22r·uInvGlareSpread) × 0.25` is multiply-scattered aerosol that
  carries out several degrees: what you see through haze. The spread
  stretches the skirt only, because the core width barely moves with air
  mass while the skirt swells into a lantern round a setting sun. Spread =
  1 + 0.16·(airmass − 1), up to 2.76 at the air-mass clamp.
- The skirt is windowed by `1 − smoothstep(0.72, 1.0, t)` on the quad radius
  (fragments past t = 1 are discarded). Without it the quad's circular edge
  is a visible step wherever the aureole has not decayed. With the spread up
  at low sun, that is most of the way to the rim.
- Ambient solve: cosine-weighted hemispherical illuminance quadratured over
  three elevation bands (the golden horizon band contributes almost nothing
  to a flat surface). Diffuse-fraction correction: the multi-scatter term
  over-predicts diffuse under clean air (~¼ of light from the dome where
  pyranometer data says ~⅛) — uncorrected it floored car shadows at ~26% of
  sunlit road (a smudge). Closes to unity as cloud rises (under a deck the
  dome genuinely is the source). Same correction applied to
  envMapIntensity — intentionally scales glossy reflection too. Hemisphere
  fill is deliberately small (at 0.15 it was a second unshadowed sky).
  Overcast trades beam for bright dome (never flat AND dark). Under thick
  cloud ambient loses the blue cast (overcast vs blue-sky-with-a-lid).
  Clouds catch a cleaner brighter sun than the ground (above most aerosol),
  and their horizon is depressed √(2h/R) ≈ 1.5° at 2.2 km — why the deck
  burns pink minutes after the ground loses the sun.
- Fog: clear-day Rayleigh haze is far too thin at track scale — aerosol,
  cloud and rain thicken it. Scene fog is `THREE.FogExp2`, extinction
  1 − exp(−ρ²d²); density = 3e-4 + 1.3e-4·(turbidity − 1) + 1.2e-4·cover +
  8.5e-4·rain. At 1 km: the 3e-4 base ≈ 8.6%, the clear preset (3.27e-4)
  ≈ 10%, storm (1.634e-3) ≈ 93%.
- Aerial perspective (`_applyAerialPatch` replaces `#include <fog_fragment>`
  on materials that carry both fog chunks): distant geometry converges on the
  sky capture (`uApSky` = `_cubeRT`) sampled in its own view direction, not
  on a flat fog colour, so a barrier at 800 m dissolves into the exact
  horizon band behind it. The factor matches three's fog (FogExp2
  1 − exp(−ρ²d²), linear smoothstep(near, far)) on true distance, scaled by
  `uApStrength`.
- `vApDir = mvPosition.xyz * mat3(viewMatrix)`: right-multiplying applies
  the transpose, and the view rotation is orthonormal, so this turns the
  view-space offset into the world-space camera-to-fragment vector without an
  inverse-matrix uniform.
- CPU atmosphere evaluation is throttled to 10 Hz (feeds ambient + fog, which
  cannot change meaningfully in 100 ms); PMREM rebuilds a few times a second
  at most; `_sampleSky` directions: zenith, 30° up toward the sun, 30° up
  away from the sun (y = 0.5), and one low sample toward the sun only
  (y = 0.063, ~3.6°) — they carry most of the hemisphere's energy.
- Aerial-perspective hook sweep: systems that build geometry after startup
  and materials cloned from patched ones arrive without the hook — re-swept a
  few times a second; the per-material check makes repeat visits cheap.
- Weather crossfade rate: 98% of target in 2 s; coverage/rain imply aerosol
  (turbidity kept consistent when the caller names only headline numbers);
  wind direction lerps the short way round the circle.
- AtmosphereShader: Bruneton/Hillaire sRGB-primary coefficients (inverse
  metres, sea level); ozone is the only species absorbing green while
  leaving blue — what turns twilight violet instead of muddy brown (tent
  profile: peak 25 km, zero at 10/40 km). Sun-ward optical depth uses
  Schuler's analytic Chapman function (GPU Pro 3) — fraction-of-a-percent
  accuracy for two exponentials instead of a per-pixel secondary march that
  would triple instruction count. CPU mirrors (`sunTransmittance`,
  `skyRadiance`; `_sampleSky` calls it with 8 steps) run the same maths so
  light colour and sky always agree. `kelvinToLinearRGB`: Kim et al. cubic
  fit, 1667–25000 K, normalised to max channel 1.
- `SKY_VERTEX_SHADER` sets `gl_Position.z = gl_Position.w`, pinning the
  unit-radius, camera-centred dome to the far plane so it never intersects
  distant track geometry.
- Below the horizon, Chapman clamps its exponent at 60 (`min(X − x0, 60)`,
  in both the GLSL and the CPU copy). A sun far below the horizon saturates
  to "opaque" (e^60 is finite in fp32) instead of inf.
- The Mie phase is Cornette-Shanks (better forward-lobe shape than plain
  Henyey-Greenstein), g = `ATMOSPHERE.mieG` 0.76. CPU `skyRadiance` mirrors
  it.
- View march: quadratic sample spacing t = (i/N)²·tMax, because the first km
  holds most of the mass and the tail to the atmosphere boundary contributes
  almost nothing per metre. Each segment is integrated analytically
  ((1 − e^(−σΔs))/σ, energy-conserving) rather than as a midpoint sum.
- Multiple scattering uses a cheap stand-in for a LUT: isotropic re-emission
  `(βR + βM)·uMultiScatter·0.25/π` of the sunlight reaching each sample
  (`uMultiScatter` 1.8; the CPU `iso` term is identical). Without it the
  zenith reads near-black and the horizon loses its milky band. This is the
  term whose clean-air diffuse excess the ambient solve corrects.
- `atmScatter` returns radiance as a multiple of TOA irradiance (callers
  scale by `uSunIrradiance` or `SUN_TOA_IRRADIANCE`). Rays that hit the
  ground get haze-lit ground behind the in-scatter (`uGroundAlbedo` 0.11 ×
  (sun transmittance·cos + 0.06·uMultiScatter)/π) and zero transmittance.
  Below the horizon, trackside geometry silhouettes against plausible
  ground, not deep space.
- Night sky: airglow (`uNightRadiance` 0.016/0.026/0.058) and stars are
  added behind the in-scatter and multiplied by the same view-path
  transmittance. Stars fade in through `uStarIntensity` = smoothstep(0.03,
  −0.1, sunDir.y) × 0.55 × (1 − 0.85·cover), set by SkySystem.
- Stars (`atmStars`) are a cell hash on a 260-cells-per-unit direction grid
  (27-cell neighbourhood). A cell holds a star only where the hash ≥ 0.9935,
  jittered inside the cell. Magnitude is hash⁴, biased hard toward faint
  stars (no sequinned curtain). Gaussian width comes from the `fwidth`
  footprint: a fixed width vanishes into aliasing at 4K and bloats into a
  blob at 720p. The colour index is `smoothstep(0.12, 0.5, ci)` from amber
  to blue-white: half the stars are fully blue-white and ~12% fully amber
  (an even split reads as embers).
- Dome dither: interleaved gradient noise on `gl_FragCoord`, applied
  multiplicatively as `1 + n·uDither` (0.006, so ±0.3%). The
  horizon-to-zenith ramp is the one place the linear HDR buffer bands after
  the filmic grade.
- CloudLayer: octaves baked once on CPU into a 4-channel repeat-wrapped atlas;
  shader recombines at mutually non-harmonic frequencies with a domain warp —
  ~11 bilinear fetches for cumulus incl. a 3-tap light march vs 40+ ALU noise
  samples/pixel; hardware trilinear antialiases the horizon free. CPU-side
  evaluation of the same field gives sun occlusion with no GPU readback (the
  flare dims exactly when a cloud crosses the disc). Billow = the base fBm
  remapped through smoothstep, f²(3 − 2f) (`fbmBase`: flat-bottomed domed
  cells); cirrus = ridged (ice-crystal filaments). Offsets kept small so
  single-precision UVs stay exact; decks run faster than surface wind,
  cirrus fastest (jet stream).
- Cloud coverage softens with distance. `soften` = min(span·2.6e-5, 1.2)
  for cumulus and min(span·8e-6, 1.2) for cirrus (span = shell distance −
  deck height), and it widens the coverage smoothstep. Past ~10 km the deck
  is sub-pixel and a hard threshold aliases into radial streaks converging
  on the horizon, so the far field is turned back into haze.
- Light-march taps use `cloudCumulusCoarse` (two fetches, no detail octave,
  which is invisible in the shadow term). The tap offset `sunStep` = sun xz ×
  thickness·scaleLow / max(sunDir.y, 0.06) is the cotangent of solar
  elevation (clamped near 3.4°), so self-shadowing rakes across the deck at
  sunset.
- `cloudPhase` is Henyey-Greenstein normalised so isotropic = 1.0 (no
  1/4π). Cumulus phase is 0.62 + 2.4·HG(0.78) + 0.35·HG(−0.28): the strong
  forward lobe is the silver lining, and the weak back lobe keeps the
  anti-solar side from going flat. The powder term `1 − exp(−2.6d)` (lit ×
  (0.34 + 0.66·powder)) brightens thick cores while wispy edges stay dark,
  which reads as volume.
- Cirrus has no light march: sun × (0.06 + 0.13·phase) + ambient × 0.35.
  Ice crystals are optically thin and mostly forward-scatter with little
  self-shadowing, so cirrus glows rather than darkens. The sun term is a few
  percent, not unity: an opaque white sheet is what makes fake skies look
  painted.
- Overcast (`uOvercast` = ((cover − 0.8)/0.2)^1.4 × 0.72, set in
  `CloudLayer.update`): full overcast is a featureless luminance ramp, not
  "lots of clouds". The last 20% of coverage therefore flattens the dome
  toward one deck colour, which keeps a zenith-to-horizon ramp
  (0.62 + 0.5·dir.y). A perfectly uniform grey dome gives away a faked
  overcast.
- Solar position: NOAA equations; `timeOfDay` is local clock at the
  whole-hour zone from longitude (see §3.3). Default date/site: 1 September,
  Monza (the module default — Track supplies Spa).

### 5.6 MaterialLibrary (`src/render/MaterialLibrary.js`)
- **ORM packing**: three samples aoMap=R, roughnessMap=G, metalnessMap=B —
  one RGBA upload feeds all three, cutting sampler count; `channel = 0`
  forced (aoMap defaults to uv1).
- **Field sharing**: the tarmac cellular pass is the most expensive thing
  here; it runs once and every asphalt wear state re-colours the same
  height/stone/id fields ('asphalt' and 'asphalt_worn' share one normal).
  Generation is staged with frame yields so the loading screen animates.
- **`_pinRoughness`**: three evaluates roughness as min(1, scalar·texel), so
  a scalar > 1 clips the top of the distribution and the achieved mean lands
  UNDER the target. The scalar is solved against the map's own histogram by
  bisection (monotonic; ten steps exact to 4 decimals) so the post-clamp
  mean lands exactly on the reviewed figure while keeping all authored
  variation. Pinned figures: tread mean 0.72 (map authors 0.66 glazed band
  vs 0.83 torn shoulders; the 0.16 step tread-vs-sidewall-0.88 is what
  separates a worked slick from an extruded cylinder).
- **Tyres**: NO clearcoat on the tread — a clearcoat is a lacquer with its
  own Fresnel/roughness that base roughness does not widen; at
  clearcoatRoughness 0.5 its GGX peak returned 4× the base specular from an
  albedo-0.028 surface — measured sRGB 152 on a sunlit rear slick vs 79
  tarmac ("tyre looks like a film"). A slick's glaze is a roughness change,
  which the pinned 0.72 already carries. `specularIntensity 0.55`: F0 = 0.04
  is a SMOOTH dielectric; torn/marbled/dusted rubber scatters most coherent
  specular below texel size.
- **Tarmac** `specularIntensity 0.6`: porous open-graded surfacing loses
  coherent specular into sub-texel voids; at full strength a clear sky made
  dry tarmac read freshly rained on. 0.6 and NOT lower: Weather drives the
  wet look by dropping roughness/raising env and does NOT touch
  specularIntensity, so this number scales the wet mirror too.
- **Racing line decal**: alpha-blended, depth-tested not written, pushed
  toward the camera (never z-fights). Rubber IS a continuous dielectric film
  (full specular intensity) but roughness never below 0.5 — the mirror-flat
  0.30 + 1.35 env turned the line into a wet sheen brighter than the tarmac,
  when rubber is the darkest thing on a track.
- **Wheel rim**: forged magnesium, real conductor F0 (~0x9aa0a6, not the
  near-black that read as painted plastic), mean roughness pinned 0.44 (map
  authored ~0.30 at scalar 1 + 1.35 env = a mirror; a mirror has no shading
  of its own, so the inboard face returned one flat disc of reflected
  infield with ribs/webbing invisible — "wheel reads flat"). 0.44 = hot,
  brake-dusted, rubber-flecked machined magnesium: bead flange still glints
  (the "wheel" cue at distance) but the ten cover ribs and spoke webbing
  each shade differently.
- **Titanium (halo)**: a conductor's map colour is its F0, not albedo;
  Ti reflects ~0.55 (sRGB ~0xc2bcb4) — the old 0x2b2d33 was a fifth of that
  (dark clay). Anisotropy along u (the hoop): drawn tube grain stretches the
  lobe lengthways so the sun smears down the arc as the car turns. 0.44
  roughness base is load-bearing: Cockpit multiplies the map by 0.68 to land
  its halo on ~0.32 — the base must stay put. tile 0.22 = real ~0.2 mm draw
  pitch legible on a 45 mm tube.
- **Nomex**: 0.88 roughness (dyed aramid staple is one of the flattest
  surfaces on the car; glossier = vinyl = the plasticine arms). The white
  sheen at 0.72 sheen-roughness was polished latex; real nomex has a weak,
  broad, COLOUR-TINTED fibre sheen (the fuzz is the same dyed staple).
  Sheen colour is derived from the suit's own colour per team, never left
  white. 0.32 m tile ≈ 2.1 mm thread pitch — survives minification at arm's
  length.
- **Carbon**: two surfaces — woven substrate (tow relief normal) + lacquer
  film (its own orange-peel clearcoat normal) — or the panel collapses into
  one flat facet; the mirrored sky must ripple ACROSS the tows. Cockpit copy
  runs full-strength relief (driver's eye 400 mm away).
- **Clearcoat micro-normal repeat trap**: the flake texture is authored for
  the 0..1 livery wrap over a 5 m car (16 repeats = 250 mm tile). Carbon
  parts are box-projected in WORLD units at 42 uv/m (CarModel.ROLE_TILING),
  so the same texture at repeat 16 lands 672 tiles/m — a 1.5 mm flake finer
  than any texel, mips to flat, deletes the orange peel: a lacquered carbon
  panel had a geometrically perfect reflection and read as painted card.
  Clone with its own repeat (shares the upload). The clearcoat micro-normal
  also needs the vector-averaged renormalised mip chain: box-filtered in
  byte space it drifts off the unit sphere, the clearcoat lobe loses its
  tilt, and clearcoat-1.0 paint reads as flat card at chase distance.
- **Toksvig filtering** (`opts.filtered`): custom mip chain — colour averaged
  in linear light, normals as renormalised vectors, and roughness RAISED by
  the normal variance each level discarded. Without it any surface whose
  relief lives in its normal map keeps mirror-flat roughness at distance and
  sparkles — tarmac above all. Roughness histogram + mean are measured at
  upload for `_pinRoughness`.
- Fencing is alpha-tested (drawn hundreds of metres deep; blending would
  demand an unaffordable sort) — but see §6.4 for the catch-fence veil.
- Duct/inlet interiors: double-sided, near-black whatever the livery (seen
  from the front they are backfaces).
- Wings: satin lacquer, much less clearcoat than bodywork (stay dark instead
  of mirroring the sky); floors/undertrays satin; mirror faces are
  near-perfect env mirrors — consumers with a live render target assign it
  to `map` and drop metalness to 0.
- Paint: two-lobe automotive finish — base coat with trace metallic flake +
  near-mirror clearcoat with its own micro-normal (orange peel). Visor:
  polycarbonate n = 1.585, 2.5 mm.
- `clone(name)` gives an independent material sharing textures (userData
  copied; the library tracks it for dispose) — for per-instance state (the
  glowing brake disc in Wheels, the cockpit LED strip, trackside variants)
  instead of mutating the shared instance and changing every car.
- Livery sets cached by colour triple: twenty cars share ten sets.
  Sidewall-only regeneration (1024×256) keeps a compound swap under 1 ms.
- **Contact patch shader** (`applyContactPatch` + `contactShadow`): a shadow
  map cannot resolve the 190 mm slot under a tyre (2048 texels over 600 m).
  Two parts: (1) a per-fragment occlusion of the INDIRECT terms only,
  measured from how far below the wheel axis the surface lies (direct sun is
  already N·L-dark down there), carrying the patch SHAPE — each vertex
  within the contact window is pushed DOWN onto the plane the tyre already
  touches (R - L·cosθ), released by height between 1× and 2.2× the squash
  (12 to 26.4 mm above the road plane, ≈14.8°→22.1° off straight-down on a
  360 mm tyre), so the flat blends back as a bulge.
  Formulated so the lowest point never moves — lifting tread INTO the
  carcass would float every wheel by the deflection (physics puts the wheel
  centre exactly one unloaded radius up). Bead and rim are outside the
  window. Done in shader because the tyre spins and the patch does not.
  (2) the ground-side quad: an occlusion MULTIPLIER `mix(1, uCore, occl)`
  into the HDR buffer — scales with whatever light reaches that road (barely
  reads in shade, near-black under low sun, follows floodlights) — never a
  painted grey blob/sticker. uCore 0.24 leaves ~0.35 of lit value with sky
  counted — the brief wants the patch darker than the cast shadow.
  `squash` 12 mm on a 360 mm tyre → 186 mm flat (measured on a loaded F1
  slick); the same 0.012 as Wheels' module-private `CONTACT_SQUASH` (two
  separate constants that must stay equal) so the shadow is exactly as long
  as the flat that casts it. `applyContactPatch(material, cosStart, aoFloor,
  squash = 0.012)` is module-private in MaterialLibrary.js and applied to
  `tyre_rubber` (0.9, 0.46), `tyre_sidewall` and every per-compound sidewall
  (0.94, 0.58). One program serves every tyre material
  (`customProgramCacheKey` "apex_tyre_contact_patch") — the constants ride
  as uniforms so the cache key (patch source) cannot go stale if strings
  diverge.
- Contact patch vertex stage (`applyContactPatch`) runs in WORLD space
  against the instance origin (`modelMatrix * instanceMatrix`, origin =
  wheel centre). The instance matrix carries the wheel's spin, so an
  object-space "down" would turn with the tread. Outer radius =
  `length(apexWheel[1].xyz)`: Wheels instances the unit tyre at scale
  (width, r, r), so the length of column 1 is that corner's radius in world
  metres. This is what lets ONE shared program flatten a 360 mm front and a
  362.5 mm rear by the same `uApexSquash` without knowing which corner it
  draws. `apexGap` = height above the road plane (outer + radial.y). The
  push is the whole gap while gap ≤ squash and is released between 1× and
  2.2× squash (`smoothstep(1.0, 2.2, apexGap/uApexSquash)`). It goes back
  to object space through `inverse(mat3(apexWheel))`.
- `contactShadow()` fragment: `coreD = length(p / uPatch)` is the
  elliptical distance in units of the contact patch. It is exactly 1.0 on
  the edge of the flat, because Wheels sizes the quad so that uPatch
  (0.48, 0.39) is the tread half-width and half the 186 mm flat (§6.4). The
  core darkening fades over 0.75–1.30 of that, straddling the flat's edge. A
  circular skirt out to the quad's inscribed circle (fragments past it are
  discarded) adds `uSkirt` 0.55 of occlusion.
- Tier changes scale filtering + expensive optional features; alias table
  maps registry names whose pixels live under differently-named internal
  sets.

---

## 6. Cars, track, trackside: geometry and texture knowledge

### 6.1 CarModel (`src/car/CarModel.js`)
Everything is a loft (station sections swept and skinned) — continuous
curvature so highlights travel, one consistent UV wrap for the livery.
Sections are superellipses (exponent squares a section off without a
zero-radius corner — every edge carries a chamfer that catches light; nothing
is a razor edge). Authoring is in the ground frame (y=0 at road), shifted
down by CG height (0.280 m) on output via `GY()`. Geometry is built once per
detail level and shared by all twenty cars; only materials differ
(`disposeSharedGeometry()` at teardown). Detail: 2 hero, 1 mid, 0 impostor.

Key traps and measured fixes:
- **Cockpit-arc seam**: the open tub arc crosses the wrap's own seam (underside
  centreline). The wrap coordinate must JUMP there; interpolating it drags ¾
  of the livery across the one straddling quad. The seam gets a duplicated
  zero-width column: two copies of the underside vertex carry the two sides
  of the jump; the seam sample is pinned (not lerped) so the copies are
  bit-identical and the column has exactly no area.
- **Aerofoil trailing edges**: the NACA polynomial closes to a mathematical
  point = a one-pixel aliasing razor with no highlight. Real elements have a
  regulation minimum TE thickness — `teThickness` is ramped in along the
  chord; then the blunt tail (two 90° corners, 3.4 mm flat = one hard dark
  line at chase distance) is replaced by an elliptical cap meeting both
  surfaces tangentially: the normal rotates 180° across 3.4 mm and puts a
  continuous specular highlight along every trailing edge. Cap costs
  2·cap-1 points; hero affords 3/side, impostor 1 (degrades to the blunt
  tail). Cosine spacing packs LE points; f=1 lands exactly on the cap
  tangent.
- **Cap-fan UVs**: a cap fan whose vertices share one sweep value has ZERO UV
  area — every triangle collapses to a line in texture space, sampling a
  one-texel column of livery that shatters under minification. The apex
  takes the coordinate the loft would reach one cap radius further along
  (sweep-rate per metre measured at each end), clamped to the loft's own
  span (a two-section plate must not project its faces off the wrap). A
  closed ring gets an extra rim vertex carrying the full-turn coordinate or
  the closing wedge straddles the branch cut through the entire livery. Cap
  vertices are never welded to the ring: the shading break stays crisp.
- **Sidepod wrap** (`podUv(side)`, `POD_V_SPAN` 0.46; anchor v 0.25 right /
  0.75 left): the outer face lands dead-centre of the 0.46-wide sponsor band;
  the remaining 0.54 is eased in (smoothstep over 0.25–0.5 of a turn from the
  anchor) over the hidden inboard quarters so v advances exactly one per ring
  turn — monotone,
  continuous, no seam. Taking the shortest way round spends it all on one
  quad opposite the outer face: 470 texels of livery over 13 mm of inboard
  flank, exactly where the chase camera looks. `turns` moves the wrap into a
  whole texture repeat (tiled, invisible). v must be monotone in the ring
  parameter or the rasteriser interpolates through the whole livery on
  whichever quad the branch cut lands. Similarly, reversing a mirrored ring:
  the first vertex maps to itself and reversal hands it u=1 — the array is
  no longer sorted and the wrap reads a fold across the first edge; a ring
  starts at the start of the ring.
- **Tub/sidepod band split**: the wrap reserves separate bands for sidepod
  flank vs tub/engine-cover flank — without it both sample the same texels
  and the title sponsor prints twice, stacked.
- **Duct insetting** (`sectionAt`/`insetStation`): a duct built from a scaled
  copy of its INLET climbs relative to the parent surface (airbox mouth
  cy 0.815, cover drops to 0.736 two hundred mm later; the throat crown
  ended 3 mm PROUD over a hand-sized near-parallel patch → depth-buffer
  stipple, the round-3 speckle). Every ring past the rim is the parent
  section AT THAT Z moved `DUCT_WALL` inside and tapered — inside by a real
  wall thickness at every station. The shoulder term needs correction when
  insetting: it drops the upper surface by shoulder·hhT, so a smaller-hhT
  inset section would be dropped LESS and surface through the ramp —
  preserve the absolute drop.
- **Mirrored ducts**: scaling x by -1 negates every triangle's handedness —
  the left duct rendered its far wall and culled the near one. Build left
  throats from mirrored, re-ordered rings the way sectionsFrom builds the
  left pod.
- **seatOnBody / louvre panels**: a flat panel at fixed height + guessed rake
  crosses a doubly-curved cover; the old 150 mm louvre sank through the
  cover mid-length and stood 10 mm proud at the tail (110 cm² within 4 mm
  and 8° of parallel = a decal shell). Rake/roll are read off the surface;
  the plane is lifted clear of the WORST point under the whole footprint
  (the cover is convex both ways — a plane through edge midpoints dips below
  it). Panel narrowed to 90 mm (a 150 mm plate cannot follow a cover rolling
  13° across its width). Solved on the right and mirrored — seatOnBody reads
  roll off the sign of x; asking for negative x returns the wrong sense.
- **Front wing packaging** (numbers, all measured): front axle z = -1.944; a
  720 mm tyre reaches 360 mm ahead, so anything past z = -2.304 with
  |x| > 0.848 is inside the tyre. `tipSweep` puts every outboard TE at
  z = -2.36 (56 mm clear). Element stack spread -12/-4/+10/+30 mm: authored
  flat, elements 3–4 interpenetrated across the whole span (measured
  separation 1.2 mm and 0.0 mm over 350 cm²) — one lump with an intersection
  curve, the second-largest coincident patch on the car. Real slot gaps now
  26.8/14.6/8.0 mm. Endplate at |x| = 0.95 (inside the tyre's 0.848–1.153
  band) so its whole outline lives ahead of z = -2.304. Element tips stop
  1.5 mm short of each other, all finishing inside the endplate's 16 mm
  thickness: four fans in one plane is the one arrangement a depth buffer
  genuinely cannot resolve. Footplate shortened/pulled forward (the tyre's
  lower surface drops to y = 0.055 by z = -2.14, which the old 310 mm plate
  ran into). Diveplane mounted OUTBOARD of the endplate thickness (at
  |x| = 0.898 it ran 100 mm into the wing elements — 73 cm² of plate inside
  an aerofoil).
- **Diffuser strakes**: 0.475 laid the outer strake flat against the tunnel
  flank (98 cm² within 4 mm, near-parallel); strakes stand inside the tunnel
  roof where real ones do.
- **Clearance constants** (all exist because two surfaces were measured lying
  within mm and near-parallel): `DUCT_WALL` (intake throat wall), panel
  standoff, panel extra rake (reads as a gill, not a decal), minimum duct
  half-extent.
- **ROLE_TILING**: repeats/metre are reciprocals of the library's own tile
  sizes (carbon 24 mm 12-tow twill → ~42/m; anodised 300 mm machining tile;
  halo Ti 220 mm). Guessing turns a wishbone into rope. Cockpit-range weave
  is a separate 8-tow 16 mm tile → 62.5/m; reusing the body's 42 stretches
  16 mm over 24 mm and puts tows at 3 mm — 2×2 twill vs corduroy at 400 mm.
- **Level composition**: every level builds a WHOLE car (paint, wings,
  carbon, suspension, wheels) so a level change changes resolution, never
  composition. Role collapsing may only fold into a material that is a
  reasonable stand-in: folding wings/floor/halo onto clearcoated `body`
  paint turned distant cars into chrome slabs (flat carbon wearing show-car
  lacquer mirrors the sky). Three materials at every level: paint, wing
  lacquer, carbon. The distant level bakes wishbones at ride height (Car
  only builds the instanced strut mesh from mid up; without them a car at
  100 m is a tub with four floating blocks). DRS flap: own pivot, never
  merged; impostor gets none (a fifth of a degree is unresolvable); takes
  the full-chord wrap — open (47°, the regulation slot gap) does not reverse
  the screen sense of v, so the wordmark reads the same and the open flap is
  the largest flat face shown to a following camera. Every level RECEIVES
  shadow (a distant unshaded car reads washed-out; the shader variant is
  shared, costs nothing). Meshes are NAMED per role so a capture/inspector
  can attribute a defect without matching material identities.
- Superellipse ring: `e` < 2 diamond, 2 ellipse, 4+ rounded rectangle;
  independent exponents/half-extents above/below centre describe nose, tub
  and sidepod with one function. `undercut` scallops the lower flank (the
  2022+ shape); `shoulder` flattens the top into the downwash ramp. Station
  tables carry `rim` = cockpit cut height (null = closed). Polyline sections
  (floor tunnels, diffuser) are arc-length parameterised so the livery does
  not stretch over the tunnels. Curved plates: outlines are authored
  anticlockwise in (z,y) (how you read a drawing); the +X sweep needs the
  opposite sense, so the ring is walked backwards in one place rather than
  every table being reversed.
- `COCKPIT_ANCHORS`: mirror housing/glass centre/yaw shared with Cockpit so
  the live mirror quad floats mm-proud of the same glass plane both views
  agree on; column tilt; helmet anchor. `suspensionLinks()` publishes CG
  frame; fronts pushrod, rears pullrod (2026); `steers` marks links whose
  outboard end swings with the kingpin; strut geometry is a unit aerofoil
  along +X (52×16 mm flattened teardrop, real wishbone proportion) stretched
  by instance matrices — one ~200-tri geometry articulates the whole car in
  one draw.

### 6.2 Cockpit (`src/car/Cockpit.js`)
Owns TWO scene graphs: `group` (interior — tub shell, pads, belts, legs,
mirror panes, camera anchor), switched off when the camera leaves the seat;
`driverGroup` (wheel, forearms, gloves, helmet+shoulders), NEVER switched off
— round two's chase shot was an empty black tub because all three lived on
the gated group. The upper arm alone stays gated (its elbow end swings
outboard of the tub wall where the chase camera would catch it clipping).
- **Eye point**: y = 0.523 car-local (0.803 m above road — a few cm over a
  720 mm tyre); z belongs directly ABOVE the shoulder anchor (-0.150), not
  ahead: the old -0.285 head-forward crouch cost the frame twice — 0.13 m
  closer to the halo (hoop projected as a girder) and dropped
  wheel/hands/mirrors below the frame edge. Reach to the rim now 0.50 m —
  real arm's length, 0.08 m inside the 0.582 m chain limit.
- **Halo**: one continuous Catmull-Rom sweep (right rail mirrored to left,
  crown an ordinary interior point — no front mitre, no V); first station
  buried in its clevis (the flat end cap never shows). Height pinned by
  clearance: helmet crown y = 0.6319 (0.132 m radius × 1.06 vertical scale),
  apex 275 mm clear = 0.9069, rails scaled about the clevis (1.4095) keeping
  plan footprint. Section is structure, not styling: 20 mm across × 32 deep
  at mid-span → 26×40 at the clevis (where the bending moment is); never a
  round pipe (scaffolding) or flat ribbon (chrome trim). Front vane 18 mm
  across × 45 mm chord (18 mm is all the driver sees). The blade is held
  against the hoop's plane normal — recomputed for the raised arch:
  (0, -0.9128, -0.4083) from clevis (0.268, 0.3685, 0.098) and crown
  (0, 0.8731, -1.030) — so the deep axis lies in the bending plane and the
  thin 20 mm axis faces the eye all the way round. 16 segments round × 160
  along (a facet per 4 mm / 17 mm), held across ALL quality tiers: 8.2k
  triangles is not worth a tier switch and a faceted halo is visible from
  the one camera that matters. Mount hardware (foot plate, pedestal,
  two-eared clevis with a pin, front pad + fairing + bolts) is sized off the
  26×40 clevis section (ears clear the rail by 4 mm a side) — without it the
  hoop reads as a wire stopping in mid-air. Parented to the CAR, not
  `group`. The shared body mesh carries its own halo for exteriors: the
  player car hides that one (two would z-fight and the body's copy filled
  the driver's view) — only at the top tier, where the halo is its own mesh
  (below it the halo is merged into carbon/body and hiding it takes half the
  car). Hidden BEFORE the visibility gate each frame (the LOD root is not
  built until after construction).
- **Halo material** (pinned, deliberately dull): the previous bead-blast ORM
  over near-cream F0 at env 0.78 produced a mirror brighter than the sky
  behind it. Coated matte-satin: roughness 0.42 (spreads sun+dome into a
  broad highlight varying along the curve; sub-0.3 gives one clipped line),
  F0 0x4a4a4e (costs the reflection ~⅔ of its energy), envMapIntensity 0.6.
  No emissive, no clearcoat (a clearcoat lobe is a second sharper mirror).
- **sweepSection** exists because TubeGeometry cannot: constant circle only,
  u spans 0..1 regardless of length (machining maps smear or repeat). It
  sweeps an elliptical section with a held reference axis (`ref`; cross with
  tangent = halfWidth direction) or, when `ref` is null, a
  parallel-transported frame (a held axis goes degenerate where the curve
  runs along it — the hoop runs vertically at both mounts; minimal-rotation
  transport accumulates no twist so seam and grain run straight down a tube
  turning 180°). u runs along ARC LENGTH at `uPerMetre`; `profile(t,out)`
  writes independent semi-axis scales (a beam deepening into its mounts
  without fattening across the view). The arc-length table must resolve
  finer than the sampling that reads it or getPointAt quantises and the
  sweep ripples periodically. Ellipse normal swaps semi-axes
  ((h·cos, w·sin), renormalised). (side, up, tangent) is right-handed — the
  stated triangle order is what faces outward under three's CCW front-face
  rule, collapsed end rings included.
- **Steering wheel**: anchor +80 mm (`WHEEL_OFFSET`) — the published anchor
  put the wheel centre 0.558 m above road, 80 mm low (9° at 0.5 m), dropping
  rim/display/hands to the frame bottom under the HUD delta bar. Eye now
  0.16 m above and 0.50 m behind the wheel centre; rim crosses at ~⅔ frame
  height. 240° lock-to-lock about the raked column axis (+Z of the wheel
  plane points at the driver). Control layout in mm off console centre:
  display is 116×68 in a 172×124 console with the shift lights on top; the
  old layout planted toggles on the screen and 17 mm buttons overhanging its
  borders. Controls occupy the three bare bands (28 mm columns each side,
  28 mm strip below). Caps pinned: rotary 18 mm, push 13.6 (old 23.6 mm caps
  projected 49 px of raw team accent — brightest thing in the lower third).
  Exactly four saturated caps (pit-limiter red, DRS amber, radio blue,
  overtake green — the four a driver's thumbs find blind), all ≤ 78% value
  so the display's white numerals stay brightest. Palette fixed, NOT from
  livery (a near-white or near-black accent is not a button). Ten caps in
  one mesh — colour rides a vertex attribute, one draw call. Cap env held
  down (accent at 1.35 glowed brighter than the screen).
- **Wheel surfaces built locally, not from the registry**: the registry
  publishes tile size in userData and leaves repeat at 1 for the placer to
  set — nothing here did, so a 16 mm carbon tile stretched across 172 mm of
  console (one weave cell = flat plastic moulding — "wheel untextured").
  GRIP pinned: 0x14141a, roughness 0.85, metalness 0, no clearcoat, env
  0.35 (a grip must never shine; the 30 mm diamond knurl carries it — repeat
  6.7×4.7, a knurl pyramid ≈ 6 px at cockpit range). WEAVE: 2 mm-tow twill,
  16 mm cell = 10.75 repeats across the console (a tow every 2 mm ≈ 4 px —
  legible); clearcoat 0.55 at 0.14 roughness = satin lacquer (gloss would
  mirror the sky and hide the weave).
- **Shift lights**: 15 LEDs, 5 green/5 red/5 blue (FIA convention); the
  emissive mask samples the emissive map's UV set, which only exists when
  the library supplied that map — guard, or the strip fails to compile.
  Blue block flashes together only when the limiter actually cuts.
- **Hands** (`_updateHands`): quarter-to-three, grip frame built from the two
  physically fixed axes — rim tangent (fingers lie along it; vertical at
  both grips so one tangent serves both) and the FOREARM from the SOLVED
  elbow, not the shoulder (the elbow swings far outboard under lock; a
  shoulder-aimed wrist rolls the glove 30° off the rim exactly when the
  player looks). Solve chain first, build frame from its elbow, orient hand
  after. Torso rotates with the wheel (keeps the outside arm inside full
  extension). The rim tangent has no inherent sign — chosen so the glove
  back faces the driver (fixes both grips from one rule, keeps the basis
  right-handed). The forearm meets the rim at ~50° — X sits off the rim, and
  the glove is rolled back HALF the difference, splitting error between
  fingers (want to lie across the tube) and cuff (wants the sleeve). **That
  half is a contract, not taste**: the glove mesh carries a wrist bent by
  DriverModel's WRIST_BEND and rolled back by half of it — change one and
  the other must change (WRIST_ROLL).
- **Head model**: eye translates a few mm under load, horizon rolls slightly
  INTO the corner — an order of magnitude below chassis motion so it reads
  as a neck, not a camera effect; what makes the car feel like 798 kg.
- **Mirrors**: half-float linear render target (mirror image stays in the
  HDR space the pipeline grades — highlights do not self-clip); a mirror
  reverses handedness — flip u (cheaper than an oblique projection); pane
  sits a couple of mm proud of the body-mesh housing glass; render reflects
  the eye→mirror ray about the glass normal; shadow-map update flag and
  previous render target both restored (the ONE place outside RenderPipeline
  that touches the renderer, and only into its own offscreen target); one
  mirror refreshed per frame; shadow maps NOT rebuilt for the mirror (built
  this frame already — rebuilding doubles shadow cost for 512 px nobody
  studies); the driver rig is hidden during the mirror pass (the mirror
  looks back past the shoulder — half a 114 mm pane would be helmet). The
  mirror cameras keep the default layer mask (layer 0 only), which is what
  keeps the screen-space heat haze (`HAZE_LAYER` 6, §2.9) out of the glass.
- **Visor**: quad fitted to the LIVE frustum — CameraRig moves fov with
  speed/braking, so a one-shot at boot (82°) sat outside the ~52° the rig
  projects and never showed. Refit behind an equality check (two float
  compares; rebuild only when the lens moved). Effect cut back to ONE thing,
  pinned: neutral pure-grey edge darkening, exactly zero inside 85% of frame
  radius, 6% opacity at the edge, held to the corners (previous pass — an
  aperture band, scratches, dust, 80% corner falloff — read as a wash over
  everything below the rim). Texture is square on a frame-aspect quad → the
  circle becomes an inscribed ellipse: an aspect-normalised vignette, which
  a helmet aperture is.
- Harness: six-point; shoulder straps sell being strapped in. Legs stay on
  the interior group (nobody outside can see shins under bodywork).

### 6.3 DriverModel (`src/car/DriverModel.js`)
- Helmet: shell with the aperture painted into an equirect texture (u = 0.75
  faces -Z forward) + a real curved visor floated over — reads correctly
  from every angle without cutting a hole. Bust = only what clears the tub.
  Car.js deliberately never builds the player's bust on LOD levels (it would
  fill the cockpit camera); Cockpit builds it and hides it only while the
  camera is in the seat. Drivers brace: head leans INTO the corner, not
  with it. Helmet paint cached per driver across every car that shows them.
- Limbs: unit-length tapered geometry along +Y serving both bones; `rRoot`
  (proximal) is the larger radius (an arm thickening toward the wrist is a
  balloon). 24 sides, not 16 — a forearm is ~120 px at arm's length and 16
  shows facets down the sleeve. UV multiplier puts nomex at real scale
  (1.7×1.5 → two flat-felled seams round a sleeve, not ten). The knitted-
  rope look was the WEAVE DEPTH, not pitch — fixed on the material
  (cockpitSuitMaterial: registry nomex is authored for 10 m viewing; at
  300 mm it is a string vest. Normal scale ×0.42, occlusion 0.55; colour,
  map, sheen untouched so arms match shoulders from every camera).
- **Glove** (the "mitten" fix, all measured): hand+wrist+cuff are ONE swept
  solid (rounded-rect loft: 92 mm cuff crown → 64 mm wrist → 80×31 mm
  metacarpal slab). The old glove's 100 mm ellipsoid palm stood 29 mm proud
  (+Z) of the finger arc; from the eye at (0.09, 0.30, 0.95) every finger
  was behind the palm — one smooth blob. HAND_LOFT's last four stations fall
  away so ~30 mm of every finger, all knuckles and grooves stand proud.
  Five material groups in a fixed order = the contract with
  `gloveMaterials`: 0 FABRIC, 1 PALM, 2 GUARD, 3 ACCENT, 4 STITCH. The
  stitching must exist even at the low tier or the group order shifts and
  the palm renders in thread.
- **Glove wrist bend**: the grip frame meets the forearm at 41° straight /
  32–44° at lock (measured off the live rig). A straight-tube glove forced
  the frame to split the difference → the cuff 20° off the sleeve = 33 mm of
  offset over a 90 mm cuff, the sleeve emerging through the SIDE. The loft's
  spine turns WRIST_BEND between BEND_Y0/Y1 and the glove is rolled back
  half of it — same half as Cockpit (§6.2). Curvature profile is a
  trapezoid (¼ ease-in, ½ constant, ¼ ease-out; peaks at 4/3 of mean vs
  smoothstep's 3/2): the tightest bend radius must exceed the hand's half
  width or the inside folds through itself — 34° over 36 mm gives 45 mm peak
  radius vs 32 mm half-width → the inside gathers to 30% (a crease, which is
  what a wrist does) instead of inverting. Spine keeps unit-speed arc length
  so the cuff neither grows nor shrinks under tuning. Below BEND_Y0 nothing
  moves; above BEND_Y1 the spine runs straight (the cuff is a true cylinder
  round the sleeve). Residual at the three review steering angles: 3.3, 1.0,
  5.1°; worst sleeve-outside-cuff from 24 mm to 0.5 mm.
- GLOVE_TILE 30 mm against 26 authored threads = 1.15 mm thread ≈ 3 px at
  cockpit range (all UVs generated in real units / divided by this — the
  per-primitive wraps caused moire and pitch changes). Rim in glove-local
  metres: axis 15 mm below and 26 mm ahead of the grip origin (solved off
  the pivot and anchor, not guessed); 49×40 mm ellipse section, finger arc
  37.5/33.5 mm so a 12 mm finger sits on rubber all the way round. Fingers:
  live-radius rotation-minimised sweeps (no twist through a 160° turn),
  flattened 0.86 so closed fingers touch along their length with the groove
  open; index reaches furthest, little finger least (a line, not a fringe);
  tips rounded over the last 11%; roots buried under the knuckle; sweep seam
  at theta=0 on the shared-face side. Fingers converge as they close (tips
  on knuckle pitch = a rake). Wound outward (both loft and sweeps): the
  naive order renders everything inside out — section walk anticlockwise in
  x-z with stations running downward, and the ring turning side-axis→
  binormal faces into the tube.
- Panels are OFFSET SHELLS OF THE LOFT ITSELF (padding, knuckle guard,
  leather palm, strap): negative offset = buried in the knit; the visible
  edge is the zero-crossing contour — cannot float, z-fight or leave the
  silhouette. Loft normal adds the taper tilt from a central difference
  along t; the difference pair must not land in `outP` (callers read it
  back). Creases are baked into a VERTEX COLOUR from the joints the builders
  actually placed (a texture cannot know where a joint is — UVs are unrolled
  per piece; no shared frame). Deepest crease wins, squared falloff.
  Topstitching: 3.2×1.2 mm beads 0.6 mm proud placed ON the surface from
  seam parameters — a countable stitch at the 2.8 px/mm a cockpit camera
  resolves; planar UVs in real metres keep the weave off the thread.
- Glove colour (`GLOVE_FABRIC_REF` #8a3b1e): pinned muted burnt orange (hue
  16°, S 64%, L 33%); a team colour is pulled to exactly that S/L with hue
  kept. Raw Scuderia red (86% S, 46% L) under open sky rendered #f2634a —
  plastic; normalised #8a1e2d. Below 12% saturation there is no hue worth
  keeping — warm charcoal fallback (`GLOVE_FABRIC_NEUTRAL` #3a3630). Knit
  vs palm separate by RESPONSE, not colour
  (leather roughness map mean ~0.56 vs knit 0.78) — the cue that stops a
  hand reading as one moulded object. Sheen/env both low (either turned up
  goes pale grey = prop). Strap: team accent pulled 62% toward the fabric,
  env right down (raw accent clipped to #fcf3c2 on the torus crown —
  brighter than everything on the wheel bar the shift lights); webbing is
  matte (roughness up from 0.66). Thread derived from the fabric (a shade
  lighter, much glossier — the only reason 1 mm of it is legible), never
  invented (never fights the team colour). Both glove map sets are
  mip-chained with Toksvig — the weave is ~3 px/thread, near Nyquist; an
  unfiltered chain beats against it (the old crosshatch). No colour map:
  albedo is a flat pinned value someone can read in the file.
- ArmChain: closed-form two-bone IK; pole points DOWN AND OUTBOARD — the only
  place an elbow fits in a survival cell and the only pole that never
  inverts at full lock. The old pole (140 mm below the grips) put the
  forearm at 43° to the rim — a wrist angle no driver holds. Solve leaves
  hand orientation alone; elbow is PUBLISHED because the hand cannot be
  oriented until it is known. Forearm starts slightly behind the elbow so
  the tapers overlap (no gap at full bend; `ELBOW_OVERLAP` 26 mm). The
  sleeve stops short of the grip point: the forearm mesh is
  `foreLength + ELBOW_OVERLAP − WRIST_INSET` long, `WRIST_INSET` = 0.055 m.
  Run to the grip point, the 64 mm cone stood 4 mm out of the hand's back
  and 20 mm out of the palm. The design note behind it (written for a 45 mm
  stop) put the flat tip inside the 74 mm cuff with 5 mm cover all round
  and 57 mm of overlap through the hem.
- Legs: effectively static (strapped in) — one merged mesh, no rig; same
  calmed suit material as the sleeves (same garment).

### 6.4 Wheels (`src/car/Wheels.js`)
- Five InstancedMeshes per car (slick, sidewall, rim, disc, caliper): 5 draw
  calls, distant level 3. Tyre authored in unit space (radius 1, width 1);
  the instance matrix carries real dimensions (one geometry serves 360/305
  fronts and 362.5/405 rears).
- `BEAD_R = 0.632` of tyre radius (≈ an 18-inch, 457 mm flange in a
  725 mm slick; it also anchors the sidewall profile and UV) — the
  0.46 it carried was a 13-inch rim under a 2021 tyre and buried the one
  bright hard-edged feature that reads "wheel" at distance under 200 mm of
  extra sidewall.
- Tread crown is CONTINUOUS (~2.5 mm fall centre→patch edge) — a cylindrical
  middle holds one normal across 60% of the band and shades as a flat grey
  wall ("smooth faceted cylinders"). Sidewall max section a little over
  half-way up (where a loaded tyre bulges — kills the extruded-cylinder
  read). The compound channel EXISTS IN GEOMETRY (2.0 mm recess, 0.8 mm
  proud lips on a 305 mm section — real moulding measurements) as well as in
  the texture: a colour-ramp-plus-normal band still reads as a decal because
  its silhouette runs dead straight past the shoulder. CarTextures paints
  the band at v = 0.69 ± 0.085 (r = 0.825..0.879 here) — keep in step.
- Tread UVs: u around the tyre (grain runs with rolling direction; 7 repeats
  of a 0.32 m tile on a 2.26 m circumference); v maps the tread band to
  EXACTLY [0,1], non-tiling — the texture authors the cross-tread wear
  profile (glazed centre, torn shoulders, marble edges) and only lands if v
  is anchored to the shoulders (the old (x+0.5)·1.35 wrapped mid-band — "no
  width to the slick"). Sidewall v keyed off RADIUS, not profile index, so
  moulded lettering sits at the same height on both sides despite the
  reversed profile.
- Revolve winding: a profile walked with rising radius faces inboard —
  outboard sidewall is walked shoulder→bead, inboard bead→shoulder; get it
  backwards and BOTH sidewalls vanish.
- SEGMENTS: 72 hero (48 put a 23 px flat on a 350 px silhouette at 3 m chase
  range), floor 64 at EVERY level incl. impostor — shared geometry means
  raising the far level costs one 975-vertex buffer for the whole grid and
  removes the one case (chase camera catching a backmarker) that could show
  facets.
- Impostor keeps tread/sidewall/rim materials — collapsing to one black
  rubber turned the back of the field into floating blocks (compound band +
  rim flange are the two high-contrast "wheel" features at 100 m). Impostor
  rim closes the inboard face (no disc behind it — an open barrel shows
  daylight through the hub). Rim inboard opening = 0.36 = disc radius
  exactly (wider leaks daylight; narrower hides the disc that says "brakes").
  Radial cover ribs exist so the motion-blur pass has something to smear
  (a featureless cover reads as a static disc at any speed). Inboard spoke
  webbing: a flat annulus of one metal reflects only the dark underside —
  the featureless-dark-hub bug; spokes give it normals that face the sky.
  Discs from mid level up (an empty 180 mm opening at 40–150 m reads as a
  hole punched through the car); caliper hero-only (90 mm of hidden metal).
- Tread casts shadow at EVERY level (one extra shadow draw puts a distant
  car ON the road — the cheapest cue there is). Everything RECEIVES (a tyre
  never darkening under floor/wing overhang = pasted-on photograph).
- Contact shadow quad: unit square in the wheel's XZ plane (PlaneGeometry is
  XY facing +Z; -90° about X lays it flat, width on X, normal up). Drawn at
  every level (two triangles, instanced — the standing-vs-hovering cue for
  the twentieth car too). Rendered AFTER the racing line decal: the
  occlusion must multiply the line as well as the tarmac, and
  distance-sorted transparency orders the two arbitrarily. Extents:
  quad = patch / patch-fraction; ACROSS = TREAD_HALF·2/0.48; ALONG = the
  186 mm flat / 0.39 — these must stay in step with `contactShadow()`'s
  uPatch (0.48, 0.39). CONTACT_SQUASH 12 mm shared with the material patch
  (§5.6). Quad held 12 mm above the road: physics puts the wheel centre
  exactly one unloaded radius up so `position.y - r` IS the road plane
  (car-local), and 12 mm keeps the far edge of a 290 mm half-extent above
  tarmac out to 2.4° of body attitude (more than a wing car runs) while
  invisible on a 360 mm tyre. Placed BEFORE camber joins the chain: the
  patch lies in the road plane and turns with steering only. Per-corner quad
  extents precomputed (setWheel runs 4×/car/frame).
- Disc glow (`glowColor(celsius, out)`, exported; fed by `setBrakeTemp`):
  ramp exponent 1.25, NOT 1.7 — 1.7 (plus the old
  380 C start) put the disc at 0.3% emission 100 C into the window (black
  when the spec says dull red). Nothing below 400 C, visibly red by 500,
  cherry by 700, (1.00, 0.55, 0.12) at 1000 — hue walks red→cherry→orange
  via t²/t³ green/blue terms instead of snapping orange. The brake_disc
  material clone reroutes instance colour from albedo to emission so four
  discs glow at their own temperatures in one draw.
- One generous shared bound per geometry (instances sit ≤1.2 m from origin) —
  culling stays correct without per-frame bound recompute. Wheel quaternion
  rebuilt so the caliper shares steer+camber without inheriting spin.
  Caliper geometry deliberately symmetric across the axle (no mirrored
  instance matrix). `commit()` flushes instance buffers once per frame.

### 6.5 Teams / livery painting (`src/car/Teams.js`)
- Colours come from MaterialLibrary.TEAM_LIVERIES so garage doors, pit
  boards and the HUD land on one palette. All teams/drivers/sponsors are
  invented — no real trademark anywhere in APEX. `skill` scales corner speed
  and consistency, `aggression` overtaking appetite and late braking; helmet
  fields drive the procedural helmet paint. Grid order: team-by-team, lead
  driver first, index 0 = player's seat.
- **Decal flip derivation** (drawMark) — both facts were guessed wrong before
  and every mark read backwards: (1) `readCanvas` row-flips, so canvasX = u,
  canvasY = 1 - v (+canvasX = +u, -canvasY = +v). (2) `c.scale(sx,sy)`
  before fillText sends reading direction to (sx,0) and up to (0,-sy). So:
  'none' reads +u/up -v; 'h' -u/-v; 'v' +u/+v; 'hv' -u/+v. Each surface
  answers only "which way does +u run for the intended viewer, which way
  +v" — every choice was verified by projecting the band's front-facing
  triangles and reading the Jacobian sign, not by eye.
- Flank text: right flank (v=0.25) reads along -u with up = -v; left flank
  (v=0.75) reads -u with up = +v — the flanks are mirror images but the text
  on them must not be. Engine-cover spine decals can only be upright from
  one side; set for the right (broadcast side, chase camera side).
- Wing wrap: u = span straight off world X (can never mirror); v around the
  section (0 LE → 0.5 TE upper → 1.0 LE lower). Which rows a following
  camera sees was MEASURED (projected front-facing triangles, screen area
  integrated per v): raked rear elements show v 0.00–0.20 (upper aft of LE)
  and 0.55–0.72 (lower ahead of TE) — the title is set in both, as a real
  wing carries it. Front and beam wings squeeze their whole section into
  v 0.24–0.36, chosen because no rear element shows it (they used to share
  rows — the mainplane wore the front wing's pinstripes). ALL wing marks are
  drawn 'v': +v projects downward on screen for a viewer behind the car, so
  an upright canvas mark lands upside down — the bug that had the rear-wing
  wordmark backwards. Endplate margins stay dark (in shadow, carry the FIA
  number panel). DRS flap shares the full-chord wrap and lands on the lower
  band — with the flap open the same wordmark is what a following driver
  reads.
- Body wrap v must REPEAT (v crosses the underside seam); floor edge and
  undertray satin black on every car; suit sheen tinted toward the team
  colour (white sheen at grazing angles washes a coloured arm to grey).

### 6.6 Car / CarManager (`src/car/Car.js`, `src/car/CarManager.js`)
- Car double-buffers visual state: `update` snapshots the previous physics
  state, `lateUpdate` blends by alpha — body, wheels, suspension, steering
  interpolate TOGETHER (no judder, no wheels snapping while the body
  slides). Wheel spin wraps at 2π — interpolate the shortest signed delta or
  the wheel snaps backwards once per revolution. Suspension links stretch
  between fixed chassis pickups and outboard ends riding travel (and
  kingpin swing on steered links). The player's own helmet bust is never
  built into the car's LODs (would fill the cockpit camera; Cockpit builds
  it — §6.3). `scriptedControls` is set by the capture rail (§3.5).
- CarManager registers as `ctx.cars` and behaves as an array (index 0 =
  player) per CONTRACT §1. AI is resolved via `import.meta.glob` at build
  time — an empty map when absent, so the grid runs on the built-in pace
  driver instead of failing to bundle. The pace fallback is a real
  controller (pure pursuit + curvature-scan speed target + spin recovery) so
  the field brakes in the right places even without the AI module.
- Detail budget: player + two closest VISIBLE rivals get hero, next eight
  mid, rest impostor. Ranking must be over cars actually ON SCREEN: raw
  distance spends the budget on mirror-filling cars behind the camera (half
  the grid in a midfield pack) — behind-the-plane cars are pushed past every
  visible one by a distance penalty (with slack so a car alongside is still
  "ahead"). Hysteresis on tier boundaries (promotion beats the threshold
  outright; demotion must fall 18% past it; the band a car is in is widened)
  — tiers differ in silhouette and a boundary-sitting car otherwise flickers
  apart every frame. Comparator hoisted (no per-frame closure).
- Slipstream + DRS computed together in one O(n²) pass (190 comparisons for
  20 cars — cheaper than any structure at this size). The field gets a slice
  of traction control so 20 cars survive the first hairpin; the player gets
  what they asked for. Lap bookkeeping here is only the per-lap ERS reset
  and the live delta for the wheel display — RaceDirector owns official
  timing. spawnOnGrid puts the player at a mid-front slot (rivals in shot);
  PLAYER_GRID_SLOT mirrors RaceDirector's (classification must agree with
  the cars standing on the tarmac).

### 6.7 Track stack (`src/track/*`)
- **Track.js**: read-only owner of geometry and queries; all queries write
  into caller `out`, allocation-free (defaults exist only for tools/tests).
  Racing line = constrained Laplacian smoothing (minimising discrete
  Laplacian of the world path = minimising curvature; clamping to the
  corridor each sweep is what makes it a racing line, not a straight line) —
  wide entry/apex/exit fall out unauthored. Seeded on the inside of each
  turn scaled by how much corridor the corner justifies (a cold start takes
  thousands of sweeps to discover which side the apex is on). Rubbered-in
  stripe width comes from the same solve (cars fan out braking/exit, funnel
  to single file at the apex — darkest strip is thinnest) + short box blur.
  Grid: 20 staggered FIA slots behind the line, pole on the left as at Spa.
- **CircuitData.js**: Spa as a TRAVERSE (ordered straights + constant-radius
  arcs), chosen because arc radii are the number that decides how a corner
  feels; the lap length is the exact sum (7004 m to the metre); and the
  traverse CLOSES — fitted by damped Gauss-Newton against position closure,
  360° heading closure and the 7004 m lap, with a prior per parameter, so
  each value sits within a few percent of hand-authored intent while the
  loop shuts exactly. Elevation/width/banking are keyed to arc distance
  through a Fritsch–Carlson monotone cubic — C1 and CANNOT overshoot between
  knots (an overshoot in elevation is a phantom crest the suspension would
  find); secant slopes wrap so the start/finish join is smooth; tangents
  clamped; queries walk the lap in order (last interval almost always
  right). Elevation spans 80 m of the real ~100 m, keeping every gradient
  buildable while preserving the two that matter (-8.7% into Eau Rouge,
  +16.5% up Raidillon). Banking positive = right edge lower (correct camber
  for a right-hander); away from corners it is the drainage crown. DRS zone
  2 straddles the line (detection Blanchimont, activation pit straight) so
  end < start — `Track.drsZoneAt` resolves the wrap. Pit lane narrows and
  pulls in through La Source (a 12 m corridor 14 m inside a 22 m hairpin
  would turn inside out — the real road threads the same gap). Control-point
  spacing is curvature-driven: sagitta of chord s on radius R is s²/8R, so
  s = √(8·R·tol) — the whole adaptive-tessellation argument applied once,
  inherited by mesh, physics table and racing line. The closing duplicate
  point is dropped and FP residue folded back into the loop (no seam).
  Marshal posts every ~400 m (sporting regs). Rotation applied so the pit
  straight faces north-east.
- **TrackSurface.js**: parallel Float32Arrays, uniform grid, O(1) `locate` —
  it runs ~5×/car/240 Hz substep = 24 000 calls/s; structs-vs-typed-arrays is
  the difference between shipping and not. Spline walked finely once into an
  arc-length table, resampled at uniform arc length (what makes central
  differences valid derivatives and lets locate jump to a neighbourhood).
  Curvature from the HEADING (sign free) — see §1. Projection is in PLAN
  (XZ) so an airborne car or a terrain query 100 m up lands on the right
  ribbon point. Nearest-cell search rings outward with one clear ring past
  the first hit (guarantees the true nearest); far-outside queries fall back
  to a bounded strided scan. Direction fields lerp+normalise (near-parallel
  neighbours — cheaper and stabler than slerp). Margins: kerbs follow
  corners (apex kerb inside across the arc; exit kerb outside from apex to
  well past exit — where a car running wide arrives); gravel sits in a
  scoop whose depth is its own SMOOTHED field (surface classification may
  step; geometry may not); margin widths are step changes blurred along the
  track into tens-of-metres ramps (a step in margin is a cliff, because
  moving laterally across a corner changes which sample a point projects
  to). Regional elevation: centreline heights splatted into a coarse grid,
  240 Laplace sweeps outward — terrain and track can never disagree (no
  seam, no floating grass, no edge of the world). The corridor cross-section
  is ALSO baked+blurred into a 2D field: nearest-centreline projection is
  discontinuous where the circuit doubles back (foot of Eau Rouge, Fagnes)
  — tens of metres of jump across a line one point wide = a 2 m cliff in a
  run-off; on the racing surface the analytic cross-section stays authority
  (exact), beyond it the blurred field takes over (the 12 m ramp the real
  ground has). Ardennes relief: 4 octaves, shortest 68 m (reads as hillside,
  does not alias the terrain mesh), faded in over the first 300 m of
  clearance (a circuit is cut into graded ground). Crown is PARABOLIC (zero
  slope on the centreline — a linear crown is a ridge every crossing car
  feels). Pit lane is declared as a second drivable corridor (else a pit car
  is "standing in the grass 18 m off the circuit"); where they overlap the
  racing surface wins (else a 4 cm step across the Bus Stop exit). Kerb rib
  slope dominates the bank angle in the surface normal (it is what a wheel
  actually climbs). `barrierAt` is authored from the racing-surface EDGE,
  not the centreline (widening the track never puts a wall on it). Grip per
  surface is pinned by CONTRACT §2; roughness/drag are free.
- **TrackMeshBuilder.js**: the ribbon is separate sweeps per physical thing
  (asphalt, kerb, astroturf, run-off, apron) with curvature-driven stations
  (20 mm sagitta tolerance: ~1.7 m through La Source, 12 m cap down Kemmel).
  Normals are ANALYTIC from the same cross-section functions physics queries
  (n = normalize(n0 - right·dy/dlateral)) — continuous across chunk
  boundaries and matching what the tyres stand on; never face-averaged.
  Along-track tiling is snapped so a whole number of tiles fits the lap (no
  seam at the line). Kerbs: geometry carries chamfers/plateau/section joints
  (silhouette + shadow); the 250 mm serration lives in the normal map
  (matches texture and physics rumble pitch); kerbs taper into the tarmac
  over 1.2 m (never start as a step). Racing-line mesh follows the solved
  line with solved width. The grass apron samples `surface.heightAt` — the
  same function terrain and suspension rays use (ground never disagrees with
  itself); every second station (halves the biggest mesh); where run-off is
  already grass the apron covers that band itself. Pit-lane inner edge is
  clamped outside the racing surface (no overlap/z-fight at entry/exit).
  Painted markings are merged into one buffer (hundreds of trivial meshes
  otherwise). Grid-box numerals use a stroke-outline canvas atlas as an
  alpha mask over paint_line so numbers weather like every other marking;
  digit quads carry paint tiling in `uv` and the atlas cell in `uv1` (the
  material pins its alpha map to the second channel). Quad winding helper
  (shared with Barriers/Trackside): decide winding per QUAD from the
  analytic normal — where a band pinches to nothing (pit entry, fading
  kerb) the sweep can change hand mid-strip.
- **Barriers.js**: one pass builds both representations — extruded visual
  profiles (real 310 mm W-beam with 83 mm relief; tyre wall as a slab
  scalloped on the 0.72 m tyre pitch + texture, one draw call instead of
  half a million torus triangles; conveyor-belt strapping bands) and a 2D
  segment list bucketed in a uniform grid (collide is O(1) per query,
  allocation-free, scratch at module scope because it runs on the physics
  hot path). Runs tighten spacing through corners (a 26 m hairpin must not
  be fenced by a chord). Offsets authored from the racing-surface edge
  outward. Barrier strips are OPEN (the back faces earth/fence/grandstand,
  never seen). The visible face points back at the track: right =
  (-tz, tx); a run on the right faces -right. Segment bucketing counts
  first, then fills one flat Int32Array (no nested arrays). Dead-centre
  segment hits push out along the segment's 2D normal. TecPro has no
  library material — tinted anodised metal.
- **Trackside.js** (selected, everything measured): terrain quads inside the
  apron hole are dropped, not z-fought. TERRAIN_CHUNKS 2×2, walked down from
  4×4/3×3 BY MEASUREMENT: the hole already removed the near quads; finer
  chunks culled empty hillside while costing draws — and this scene is over
  CONTRACT §8.4's 400-CALL budget, not its triangle budget (drawing 20k more
  triangles to save three calls is the right side of that trade).
  Instancing-vs-merging rule: instancing is right when one geometry repeats
  thousands of times and wrong at a dozen — seven never-culled lap-spanning
  instanced objects (fence rails, hoarding stiles, camera masts, TV rigs,
  floodlight masts, braking-board posts, stand fascia) became TWO merged
  meshes (galvanised section + printed vinyl). Fence Beer–Lambert:
  coverage a' = 1-(1-a)^(1/cos θ) against the GEOMETRIC panel normal (not
  the normal-mapped strand crown) — 0.233 authored normal-incidence, 0.52 at
  70° (the reviewed frame), floored at cos 0.16 → saturates at 0.79 (a fence
  edge-on is dense but never a wall; the cars behind must stay readable).
  Catch-fence veil: blended, NOT alpha-tested — the coverage-renormalised
  alpha-test chain collapsed (measured: coverage 0.31–0.39 down to 16×16,
  then 0.000 at 8×8 — every texel within a few units of the cutoff flipped
  at once), and a trackside camera looks ALONG a fence, hitting those levels
  30–40 m out: "posts with nothing between them". depthWrite off /
  depthTest on (hidden behind opaques; no self-occlusion in arbitrary
  triangle order). Fence metalness DOWN (1.0 gave no diffuse term: the veil
  composited a colour indistinguishable from the road — measured 99–112
  through and beside the panels); posts at 0.72 metalness rendered rgb(0,1,2)
  against 150-grey tarmac (a metal reflects the dark ground in front, not
  sky); galvanising a season old is largely diffuse grey; env multiplier
  well above unity ON PURPOSE (env bound at 0.52 vs sun 3.75; a shaded post
  is otherwise unlit, not dark) but short of raw metal for the night rig
  (bright steel at grazing floodlight = blown-white catenaries).
  Fence/verge textures get DOUBLE the tier's anisotropy (floored at 4,
  capped at device) — everything trackside is seen at raking angles, the
  case a low cap cannot filter (the shimmer/fizz note). `flipU` on signage:
  a driver reads a right-side board facing the other way round the path —
  symmetric UVs mirror every wordmark on one side. Hoardings: 8 m per board
  (artwork is 8:1; stretched vinyl is the first "wrong" tell); never the
  same brand twice running (a repeat across a joint reads as one 16 m
  strip); shared joints emit ONE stile (two identical instances at one
  transform z-fight); stiles stand a cm proud to take their own highlight
  (separates boards down a run). Night hoarding atlas is rebuilt at
  2048×1024 (library's 1024×512 gives 64 texels of board height — type dies
  in the mip chain; at 128 texels a 0.62-band cap ≈ 60 texels survives).
  Hoardings get a small daytime emissive floor 0.07 (measured shaded boards
  at rgb(39,13,19)/rgb(26,39,53) — unreadable; raising env did nothing
  measurable; much real advertising is internally lit anyway) and self-light
  after dark (a dark board is the clearest "no lights" tell). Grandstands:
  0.45 m risers on 0.85 m treads (standard temporary-stand geometry), 2.35 m
  front wall puts the first row of heads above the catch fencing; crowd
  placed ON the seat grid (a real stand is visibly gridded; scattering reads
  as noise) with gaps (full house = wallpaper) and only slight along-row
  shuffle; back rows lose skylight under the roof; roof deck dark (only
  large upward-facing surface behind the barrier — floodlights hit it and
  it is seen edge-on from the car: bright cladding = a clipped white line
  the length of the stand); trusses darker than the soffit (galvanised
  turned the roof underside into a venetian blind); one truss per column
  bay (closely spaced purlins alias into stripes). Crowd cards: billboarded
  with a camera-facing NORMAL too (else the sun rakes the stand and half
  the crowd goes black); blend toward a muted average with distance and let
  the alpha cutout close up (per-pixel cutout on a 4 px card is sub-pixel
  noise — sparkling edges). Spectator banks: terracing opposite the
  grandstand of each clearing; marquees BEHIND the crest (on the skyline a
  unit is nine metres of white roof across the treeline); trodden-grass and
  marquee-canvas values deliberately held down (0.70-luminance ground and
  near-white canvas both read as flat cards in the treeline). Forest: four
  plantings (spruce spire / pine umbrella / beech dome / birch column) —
  the review's "identical dark lollipops" was one crown scaled three ways;
  stands drift by a ~110 m noise cell with a minority species mixed in
  (independent draws = salt-and-pepper noise); stand height drifts on a
  longer wavelength (canopy line undulates); every card is grown/shrunk/
  displaced/dropped in the vertex shader from a hash of index+position;
  per-instance tint spans deep blue-green→yellow-green; tint blue term held
  ≥ 0.52 (0.42 × a blue-poor hue-94 card = rgb(83,146,1) crowns clipping to
  white — no leaf has zero blue). Golden-angle card spiral (2.39996 rad —
  never lines two cards up) with a slow beat against it; cards sit off-axis
  (through-centre crowns are hollow from every direction but two); card
  count scaling floored at 0.88 of authored height (the raw sqrt thinned the
  skyline into a picket of spires — Spa's treeline must read as a mass);
  alternate cards mirror U (no repeated art orientation within a crown).
  One instanced trunk mesh for all species (`aStem` = height + radius
  multiplier restoring real metre figures under the instance matrix): 8
  draws → 1; trunks cast no shadow (a trunk stands inside its own crown's
  shadow). Crown material overdrives env response as the cheap stand-in for
  leaf transmission (a BRDF with no transmission term turns the shaded half
  of every crown into a stencil against a blown sky). Second thinned
  planting band beyond the dense one (a bare hillside is why the world
  "ended behind the barrier"). Floodlights: pools are BAKED additive decals
  (forty shadow-casting lights is not a budget); only the masts nearest the
  camera get real SpotLights, handed over where the outgoing mast has faded
  to nothing (the fade is also what dims the car between pools); pool decay
  is deliberately shallower than inverse-square (a 30 m mast over a 50 m
  radius at physical decay makes the near end 4× the far — the halo clips
  white under the mast while the road ahead is dark); spot cones
  deliberately tight and throw cut off just past the far side of the road
  (the cone that covers the road from 30 m up also reaches the grandstand at
  60 m and clips its roofline to white); alternating sides (one-handed
  lighting leaves a permanent shadow that reads as a bug); pool texture: U
  across the road clamps, V along repeats, elliptical falloff reaching zero
  at every edge (tiling leaves dark road between pools, no seam); streaking
  constant down V, noisy across U (wet tarmac smears a light along the
  road, never across); a few stops of brightness variation between masts
  (identical pools never happen — lamps age, aim, get dirty); pit-lane
  spill in discrete garage-mouth blobs; night fittings (lenses, roof lamps,
  fascia bands, marshal lamps) only EXIST after dark (unlit they are black
  boxes costing a draw in every pass); decals sit 6 cm over the road AND
  need polygonOffset (far-straight depth precision); additive decal colours
  are set LINEAR (radiance multipliers — not through setHex's sRGB
  transfer); night factor pushed only when the sun moves (once a session);
  tier changes re-zero orphaned spots (a spot left at old intensity lights
  the circuit from a mast nothing aims). Marshal posts merged as one object
  (three instanced meshes for 21 posts = draws spent on nothing); signal
  board faces up the road (the only direction its number reads); flags need
  motion or they read as painted boards. Distance boards: U along the
  track's `right` (the approaching driver's right — backwards turns 100
  into "001"); blank aluminium band on the back (single-sided face, no
  mirrored numbers). Camera towers/floodlight masts baked into the shared
  section mesh; no shadows (a 12 m open lattice renders as a scribble on
  grass; a 30 m mast throws a 100 m × 200 mm shadow no frame resolves).
  LED boards: near-black albedo + bright emissive (the picture is the
  emissive map) — a saturated flat fill reads as a debug material; runs
  with gaps (a solid glowing kerb-to-horizon line reads as a bug). Verge
  re-skin swaps MAPS on the shared astroturf material (keeps the solved
  geometry/UV/tile); verge is a rough dielectric with env < 1 (a synthetic
  pile scatters; any grazing specular made it glow like a light source).
  Build-time accumulators are dropped after `build()` closes them out (MB of
  boxed numbers already copied into BufferAttributes); nothing may add to
  them after. `_bakeInstances` pushes normals through the inverse-transpose
  (non-uniform scales — stretched unit cylinders — must shade as what they
  became). Placement noise is position-seeded (`valueNoise2`), not sequential
  Rng: two passes at different spacings must agree where the beech stand is.
  drawCallEstimate feeds CONTRACT §8.4.
- **Trackside terrain grass** (`_terrainMaterial`, cache key
  `terrainMownV2`): the shared grass map carries a large-scale dryness drift
  (lush green → bare grey-brown, `buildGrass`). On a 10 m tile over 15 m
  terrain cells it landed as hard-edged olive and khaki blotches ~20 m
  across: measured rgb(144,171,109) two metres from rgb(153,142,131), which
  reads as a debug splat map, not a field. The fix steers chroma 55% toward
  one mown-grass green, `vec3(0.702, 1.160, 0.301) × luma`. That vector has
  Rec.709 luminance ≈1.0, so all of the map's luminance detail survives and
  the blotches become tonal variation. Near-terrain UVs (`_buildTerrain`)
  are world-scaled at 0.1/m (`1 / (tileU · 2.5)`, grass tileU 4), so one UV
  unit = 10 m. Every mow constant below is in those units. The far ring
  (`terrainFar`) uses the same material at `1 / (tileU · 6)` = 1/24 per m,
  so there the mow pattern is 2.4× larger in world terms.
- Terrain mowing bands are painted into albedo, on top of the grass
  texture's normal-lean stripes (§6.8). The cut pattern is the one thing a
  head-height camera actually resolves on infield grass. Band tones are
  0.845 / 1.175 (the dark pass sits ~28% under the light one), varying along
  a direction ~20° off world X, ~3.5 m per stripe. The old ±11% sat inside
  the map's own noise; a gang mower's nap lies toward the machine on one
  pass and away on the next, and the two differ by about a quarter in tone.
  Band contrast is modulated 0.55–1.0 by a ~50 m wave, because a mower turns
  at the end of a run and the banding is not endless. A ±5.5% tonal drift
  (~100 × 134 m) keeps the field off one value out to the treeline. Bands
  fade over 260→900 m of view distance: the infield opposite a broadcast
  camera is 200–300 m away, and the old 420 m cut-off had faded it to
  nothing well before that.
- Crown cards (canopy vertex shader, `canopyAtlasV1`): `cardA < 0.11` scales
  a card to zero, so about one card in nine is simply not there. The rest
  are scaled `0.58 + 0.92·cardA`, i.e. 0.68–1.50, about their own
  `aCardCentre`, not the tree origin,
  then jittered ±7.5% of tree height in X/Z and ±8% in Y. The hash mixes the
  card id with a per-tree hash of the instance origin. This is what makes a
  thousand instances of one crown all different.

### 6.8 Textures (`src/render/textures/*`)
- **SurfaceTextures**: 0/11 stone-mastic asphalt (FIA-grade): coarse 10–14 mm
  chippings in 5–7 mm fines — 184 cells across a 2.4 m tile = 13 mm pitch
  (WorleyGrid draws stones at 0.78–1.12 of cell); the old 96/216 put the
  coarse fraction at 19–28 mm (kerbstone) with nothing at the fine end —
  scale-less pepper noise. Aggregate lookup is domain-warped or stones read
  as a grid of dots from low cameras. Cavity radius sized to the ~9 mm void
  between stones, not a stone. Tarmac roughness must not depend on v: the
  tile repeats every 2.4 m ACROSS a 15 m track, so a longitudinal polish
  band at v=0.5 was six false wet stripes — where the cars run is the
  racing-line decal's job ONLY. Racing-line albedo: laid rubber is the
  darkest thing on a circuit — well under half the tarmac's ~0x40; core
  roughness 0.52, not 0.30 (mirror → brighter than the road). Rubber fills
  the voids so relief drops as coverage rises. Paint lines carry glass
  beads (glossier than tarmac, never mirror); alpha carries chipping. Kerbs:
  ribs are a raised cosine (continuous slope — |sin| leaves a cusp line per
  rib); cast joints every painted block; chamfer shading baked; rubber lands
  in streaks along travel, on the track edge and rib crests. Grass stripes
  are combed blade direction flipping the normal lean — they appear/
  disappear correctly as the sun moves, not painted bands. Gravel: 20–45 mm
  rounded river pebbles (FIA traps), two cellular layers for the size
  distribution and inter-stone shadow. Concrete: 2 m saw-cut joints,
  shrinkage cracks from ridged noise, per-pour tone, rain-streaking
  (vertical staining meaningful on walls, harmless on slabs).
- **CarTextures**: 2×2 twill from a continuous phase ((tx+ty) mod 4) so the
  over/under transition can be softened (a hard step is pixel noise at
  grazing angles); filaments run along the tow and swap with the interlace;
  tow section is a flattened cosine (a tow is a ribbon, not a rod); an
  explicit groove along the top-tow boundary or a pair renders as one flat
  facet; resin valleys darker and glossier, crowns show fibre grey.
  Tyre-tread map: authors the three-zone wear profile (scrubbed/glazed
  middle ~60% at roughness ~0.60–0.66; torn graining shoulders ~0.86–0.90;
  cool marble-picking edges), zone boundaries noise-pushed (a ruler-straight
  wear band is a painted stripe); graining tears only where worked, not
  glazed. RUBBER VALUES ARE ABSOLUTE: rubber photographs sRGB 0x28–0x40 in
  sun; authoring at 0x13–0x16 is below the tonemap's shoulder — every
  shading cue crushed to one black = the felt-donut bug (tread AND
  sidewall). Sidewall: lettering drawn to canvas and MOULDED into the
  height field (raised type catches light; a flat decal does not); moulded
  type is the same rubber but glossier (brighter, never white); compound
  band is paint IN a moulded channel with proud parting lips, collecting
  dust and lip shadow (what stops it reading as a decal); three repeats
  around (as moulded tyres carry); fine radial mould ribs on the lower
  sidewall only; base roughness 0.78, not 0.90 (a sidewall has a low broad
  sheen); tileV = the real 116 mm flank (18-inch rim in a 720 mm tyre),
  ~125 mm of arc, so type and band come out real-size. Brake disc: 278 mm
  front ≈ 400×3.6 mm drillings in four rows on this map (real part carries
  ~1000 in several rows); heat lives in the friction band, hottest at the
  outer radius; drillings stay cooler (where the air flows). Exhaust:
  straw→rose→violet→blue→grey→raw inconel with distance from the turbine;
  weld beads a function of position along the pipe; bands wobble (a pipe
  never heats evenly). Nomex kit: seam layout in real units — 6 mm
  flat-felled welts with two topstitch rows; the SEAMS, not the weave, are
  what tells the eye a limb is dressed (an uninterrupted surface is a
  moulded tube). Glove leather: Worley pebble field (f2-f1 = pebble height
  without a second query) over a fold field (pebbles stretch into creases —
  hide, not dimple wallpaper); 45 mm tile at 22 cells ≈ 2 mm grain; crowns
  burnished by the rim, creases hold dye and stay matte; leather ≈ ⅓
  smoother than the knit (the silhouette highlight that separates palm from
  back). Wheel-grip knurl: crowns polished by palms, valleys dead matte.
  Display: sub-pixel grid so the panel reads as an emissive TFT, not a lit
  decal; rev bar 5/5/5 green/red/blue. Visor map: smoke tint deepening into
  a near-opaque sun strip; anti-fog insert with a faintly visible stepped
  perimeter; optically flat except scratches/insert.
- **TracksideTextures**: crowd palette is MUTED (denim/grey/khaki/off-white
  with rationed team accents — saturated primaries are coloured static past
  fifty metres); one atlas cell = three seats at 0.70 m pitch × 1.55 m card
  (Trackside builds billboards at exactly these dimensions → life-sized
  spectators, spatial frequency that survives mipping). The dark
  silhouette behind every figure and the hard seat-back base band ARE the
  crowd (the gaps read as people; rows stay legible); occupancy lives in
  the atlas (one bare + three thin cells = empty seats for an index lookup);
  arms-up figures rare on purpose. Hoarding palette weighted LIGHT: six of
  eight grounds were dark navy/maroon/near-black and measured rgb(15,20,27)
  on the frame — black rectangles; real trackside advertising is white or
  one saturated primary with a huge wordmark (read from a moving car
  through a long lens); five light/bright, two mid, one deliberately black.
  Frame bands top+bottom of every row are real folded-geometry aluminium
  (`SPONSOR_FRAME_BAND` 0.11 in `TracksideTextures.js`, matched by
  Trackside's profile — its frame segments are
  11% of arc length; change one and the other follows); vinyl sags between
  fixings, the frame does not; vinyl semi-gloss vs mill-finish aluminium
  (same roughness made the board one flat card). Wordmarks fitted by
  MEASURING (no layout overruns); cap height 0.62 of the artwork band
  (~0.5 m on a 1.02 m board — real signage size; smaller is grey texture by
  draw time). Armco: galvanising spangle (flat zinc crystal facets each
  catching light at its own angle — the offset to the Worley feature point
  is the facet slope), bolt line at 3 m post spacing, filth along the
  bottom flange. Debris-fence texture: 50 mm aperture, 3.15 mm wire; alpha
  silhouette deliberately a shade wider than the shaded wire (a 3 px wire
  mips to nothing by level 3 — fencing that vanishes at 80 m looks like a
  bug even though the real thing nearly does). Catch fence (blended veil):
  4.6 mm wire / 50 mm diamond / 0.5 m tile (~25% square-on occlusion); wire
  is a ROUND section in the height field (√ of the linear ramp is a
  circle's profile — the specular line down every strand's crown is what
  says steel, not stencil); opaque core + one-texel alpha ramp (free
  antialiasing on a blended sheet; impossible on alpha-test); interlace
  alternates by cell (a real weave, not X junctions). `veilMipChain`: alpha
  averaged LINEARLY (a lattice becomes a veil of the same optical density,
  not a fence that thins and vanishes) and colour averaged WEIGHTED BY
  ALPHA (transparent texels are transparent BLACK — a plain box filter
  drags the wire toward soot level by level; same fix on the foliage atlas,
  where the treeline got darker with distance — the exact opposite of
  aerial perspective). `preserveCoverage(levels, alphaTest)` (a pass over a
  finished mip chain; alpha-tested sheets, now only foliage — the canopy
  atlas's `veilMipChain` levels at `CANOPY_ALPHA_TEST`; a canopy must write
  depth and cast shadow): preserves level-0 coverage per level by 12-step
  bisection on the alpha multiplier over [1, 8], taking the `hi`
  end of the bracket (coverage vs scale is a STEP once a level's alpha range
  collapses near the cutoff — bisecting a step lands on whichever side the
  last probe fell; measured 0.000 coverage at 8×8 on the shipped fence:
  the whole sheet vanished in one step; failure mode must be "slightly too
  dense", invisible, not "gone"); multiplier capped at 8 (uncapped, a
  coarse level multiplies by fifty to hit target → alpha 255 everywhere →
  every distant foliage card becomes a solid flat fully-lit quad — pale
  rectangles and ladders in the canopy, worse than slight thinning). The
  unrolled per-texel loop exists because a four-element array per texel is
  a million short-lived allocations on the fence tile alone. Foliage atlas:
  four cells (spruce needle spray, pine tuft, beech mass, birch) because a
  forest from one card is one shape repeated a thousand times — visible
  along a treeline long before any individual tree; hues 82–112 (real mixed
  Ardennes spread; below 80 reads autumn, above 130 reads filter);
  lightness 15–39%, saturation DOWN to 20–42% — both calibrated against
  measurements: the reviewed canopy was rgb(13,26,16) against a 249 sky (a
  stencil), but a pass that raised the ceiling to 52% L clipped sunlit
  crowns to rgb(239,243,239) (hue-94 at high saturation has no blue; the
  tonemap takes the rest to white). Real sunlit broadleaf ≈ 0.14 linear
  with blue ≈ 45% of green — 39% L / 42% S lands there. Feathered rim on
  the cluster cards (thin the outer fifth, let a few clusters stand ¼ past
  the envelope) — a clean ellipse of clusters makes every crown a drawn
  outline (tree vs lollipop). Conifers drawn denser for a mechanical
  reason: the spire clip rejects most placements near the apex. Two-texel
  atlas gutters (bilinear bleed). LED faces carry wordmarks on a dark
  field with visible pixel pitch (a pure-colour rectangle is a debug
  material; the dark diode grid is what makes it a board). Marker boards:
  the atlas is drawn bottom-up because readCanvas flips rows — a board that
  must be sampled upside down is a bug waiting to be re-introduced.
  Astroturf verge: grey-olive ~12% saturation (a season of rain and sun —
  ⅓ of real grass), pile streaks authored ALONG U (a cross-travel grain
  strobes at 300 km/h; along-travel smears cleanly); 0.75 m roll seams
  running along the road (the one cue that says laid mat, not paint);
  20 mm tufting rows — the direction without which noise reads as flat
  fill; gloss flat (grazing gloss made the verge glow). Tunnel lining:
  2 m shutter boards, soot streaks, cable channels. Marshal cladding: FIA
  hazard striping, faded.
- **NoiseTextures**: 8 evenly spaced gradients (classic Perlin's axis/
  diagonal mix biases along diagonals — visible cross-hatching on tarmac);
  every generator has a period-wrapped variant (a 1024 px map over 5 km
  shows no seam); fields build in ms so the loading screen animates.
  WorleyGrid: baked jittered feature points (hashing 9 cells/pixel over a
  megapixel is measurably slower); distances compared squared, rooted twice
  at the end (9 sqrt/pixel = 400 ms vs 1.4 s tarmac). Box blur keeps one
  running sum per column while walking memory row-by-row (a per-column
  sliding window is a cache miss per texel — the dominant term). fbm/ridged
  rasterisers sample at the resolution the fractal needs and upsample (a
  period-3 field on a 1024 map is 64× cheaper). `normalFromHeight` strength
  is height-per-texel — raise it when metres-per-pixel grows. sRGB
  encode is tabulated (4096 buckets) — it is the inner loop of every colour
  mip level. Mip chains: see Toksvig (§5.6); three uploads `mipmaps[i]`
  levels for DataTextures and skips glGenerateMipmap; odd sizes clamp the
  second tap so non-POT tiers (768/384) still get complete chains.

---

## 7. AI and race direction

### 7.1 AIDriver (`src/ai/AIDriver.js`)
Architecture: pure-pursuit path follower + lateral-error PID trim + a
friction-ellipse budget arbitrating brake/steer/throttle, with a seeded
personality (braking confidence, trail-braking bravery, throttle smoothness,
reaction time, error rate) so nineteen cars produce nineteen lap times and
nineteen different mistakes. Cost control: racing line + speed profile solved
once for the grid; neighbour search once per tick for the field; the two
expensive per-driver passes (forward speed scan ~17 ms cadence, tactical
decision ~50 ms) on staggered round robins; physical constants cached at
construction (hot path never walks the config tree).
- Personality spread calibrated on real qualifying pace: slowest ≈ 2.5 s off
  the quickest over a Spa lap ≈ 3% of corner speed once braking/traction
  fold in. Commitment drifts slowly across a stint (laps never identical).
- Reaction: 0.53 s transport-delay ring at 120 Hz applied to the braking
  DECISION (demand recomputed every tick, read back late) — 0.2 s at
  300 km/h is 17 m of braking zone, the quick/slow driver difference.
- PID works in commanded lateral ACCELERATION per metre (and per m/s) of
  error — what keeps the loop stable across the speed range (2° of lock is
  nothing at 60 km/h and six lateral g at 300). Error rate measured against
  the line's own lateral rate (`lineRate` = `line.offsetSlopeAt(lineId, t)`
  × speed, in m/s; 0 while an offset is forced) minus the car's
  (`velocity · loc.right`), not the raw derivative — on
  turn-in the target sweeps the road at 10 m/s and a naive derivative reads
  that as error. Commanded curvature capped near tyre capability WITH
  headroom (correcting error needs transient load above steady state; the
  driver pays in a moment of understeer, not a refusal). Opposite lock only
  on body slip EXCEEDING honest cornering (~silent otherwise).
- Lookahead grows with speed but never past a fraction of corner radius (a
  15 m chord across a 17 m hairpin aims straight over the apex — the classic
  pure-pursuit failure). Alternate-line choice is evaluated as a
  displacement AT THE LOOKAHEAD POINT so the car follows the alternate's
  shape, not a parallel of the racing line. Target beside/behind = pure
  pursuit undefined: full lock at it, recovery states do the rest.
- Forward scan: quadratic sample spacing — finest right in front (braking
  points are hit or missed), coarse at the horizon. Braking: anticipated
  lateral load evaluated at the speed the car WILL be doing there (into a
  hairpin they differ 2×; using current speed convinces the controller the
  tyre is saturated and takes the brakes away). Closed-loop squeeze when
  measured deceleration lags demand (cold carbon = ⅔ torque, worn tyre,
  downhill — open-loop pedal is wrong every lap for a different reason).
  Front-axle cap (no ABS — a flat spot) + lock-catch modulation (how fast is
  most of what separates the field). Traction budget in FORCE, not pedal (at
  300 km/h full throttle asks a fraction of grip — the ellipse must not gate
  it). Power-oversteer trim: past what the corner asks, throttle is cause
  and cure.
- Start: held on brakes, clutch in, engine at launch rpm (anything else is a
  jump start); remembers its grid column and drives straight down it for the
  first couple hundred metres (both real and the only way 20 cars survive);
  clutch up over ~0.75 s, slowed when the rears spin up. Off the line the
  car ahead is still the car ahead (avoidance active).
- Free-running sessions (capture rail) skip the launch state — the car is
  already moving.
- ERS overtake mode is a button that CYCLES — switching means pulsing it the
  right number of times and remembering the cycle position.
- Mistakes: Poisson process whose rate rises with commitment; every error
  costs real lap time and is recoverable; none is a scripted spin. Running
  wide = drifting toward the OUTSIDE of the corner.
- Recovery: a car that left the road slows properly before rejoining and
  never rejoins while somebody is arriving (rejoining at full commitment
  into the pack is THE cheap-AI tell). Pointing back down the road counts as
  an excursion even on tarmac (a controller that floors it drives the wrong
  way). Spin response: full opposite lock at direction of travel, brakes,
  clutch in (textbook; recovers many). Rejoin blends from the edge back to
  the line over a window; a wrong-way car crawls until turned. Marshals:
  beached 9 s = teleported to the road edge facing forward (waiting for a
  gap unless it has sat so long that leaving it is the bigger hazard); the
  marshal teleport marks itself so the jump detector does not wipe the
  recovery state (§3.5). `reset()` after any teleport so nothing carries
  over. `TELEPORT_SQ` = 30 × 30: squared metres of one-tick jump that can
  only be a teleport.

### 7.2 Overtaking (`src/ai/Overtaking.js`)
- ALL racecraft in track-relative coordinates (gap along centreline +
  lateral): world distance is wrong on a circuit (10 m apart across a
  hairpin is not a fight; 10 m down Kemmel is).
- TrafficModel: one per track (getTrafficModel), refreshed once per tick for
  the whole field (guarded on the sim clock — nineteen callers pay once);
  insertion sort on lap position (nearly sorted every tick → linear);
  neighbours are adjacent entries (cheaper and more useful than any spatial
  hash); 3 ahead / 3 behind per car. A car itself in the run-off is not the
  one you wait for when rejoining.
- Racecraft holds tactical state BETWEEN decisions (side committed, defensive
  move used, blue flag honoured) — racing rules are about commitment; a
  controller that re-decides every tick weaves. Decisions at 20 Hz round
  robin (already faster than a human). One roll per overtake attempt
  (re-rolling every tick = a driver willing to try the outside for 1/60 s —
  never commits). Commitment test: projected overlap at the braking point
  must work out ("never dive from four car lengths back"). Wheel-to-wheel:
  hold the chosen side, leave a car's width (avoidance does fine spacing).
  Landed or not, both end the fight; give the corner up rather than take
  both cars off.
- Side choice: the inside of the COMING corner beats everything, unless the
  defender covers it — then outside or nothing; outside is low-percentage
  (only the brave); refuse a side with no road; on a straight the tow's
  existing offset is the cheapest move.
- Defending (the real regulation): one move, made early on the approach,
  toward the inside of what is coming; no moving under braking; a car's
  width once the attacker is alongside; moving back is the forbidden weave;
  resets when the corner passes; the defensive line is slower in and
  everybody knows it.
- Blue flags: move to the side the racing line is NOT on (the leader keeps
  his line), off throttle, on the straight, never mid-corner (a jinking
  backmarker takes the leader with him); stays there until clear.
- Following: dirty air costs front load, so through corners sit slightly
  wide and carry a little less (exponential wake decay matched to the
  aerodynamics' e-folding length); on straights tuck into the tow a metre
  offset (the move out already half made). Racing cars spend their battery;
  DRS is a LEVEL REQUEST (director decides legality, aero decides if the
  flap physically opens).
- Avoidance is deliberately soft — nudges and lifts, no swerves; cars are
  allowed to touch (a race with no wheel-rubbing reads fake) but a car about
  to be rear-ended lifts. Lateral separation strongest at longitudinal
  overlap; never push a car toward an edge it has no room on; closing brake
  on TIME TO COLLISION, not distance, capped short of a panic stop (contact
  stays possible, pile-ups do not).
- Constants: `CAR_WIDTH`-derived clear offset; wake length that costs front
  load; ERS mode ids from CarConfig (0 off / 1 balanced / 2 attack /
  3 overtake); aggression buys appetite for a 70%-there move.

### 7.3 RacingLine (`src/ai/RacingLine.js`)
- One shared solve per track (`getRacingLine`) into flat typed arrays; every
  later query is an array read + lerp. Path: minimum-curvature relaxation
  (pull each point toward the neighbour midpoint — the discrete Laplacian —
  projected onto the corridor's lateral axis, clamped to drivable width each
  sweep; what survives the clamp at a corner is the apex). Coarse-to-fine:
  relaxation propagates one sample per sweep, so the 3 m grid direct would
  need thousands of sweeps for a long straight to reach its corner —
  decimate, solve, upsample = same answer for a fifth of the work; seed on
  the inside proportional to corner severity.
- Speed profile: corner-speed pass, then backward braking and forward
  traction/power passes wrapping the closed loop TWICE (a braking zone
  before the line still constrains the straight before it). Corner speed is
  implicit (capability rises with downforce): four fixed-point iterations
  converge inside 0.1 m/s. Friction ellipse in the backward pass (turning
  spend is unavailable for stopping — fast corners get long shallow brakes,
  hairpins short violent ones). Banking adds the weight component along the
  slope. Terminal velocity where power-after-drag runs out (else the AI aims
  at the table ceiling down every straight).
- Capability tables derived from the CAR'S OWN CONFIG (Pacejka peak +
  load-sensitivity terms, ground-effect downforce curve, fuel-flow-limited
  power, brake torque), never tuned constants — the profile stays honest if
  physics moves a number. Aero table solves the ride-height/load fixed point
  (3 iterations/entry): ~5.2 m² ClA at rest → ~5.5 m² squatting = 2.3 t at
  300 km/h, what the chassis config says. Load transfer charged against
  axle capacity: mu falls with load, so moving d newtons inner→outer costs
  2·|PDY2|·d²/FZ0 — why a stiff car is slow and why the numbers are
  believable rather than mu·weight. Braking uses all four wheels
  (longitudinal transfer roughly self-cancelling — front gains load, loses
  mu); traction rear-only with transfer onto it. Engine power for the
  profile = qualifying-style deployment: fuel-flow-capped ICE peak + MOST of
  the MGU-K (the profile must not assume flat-out deployment everywhere).
- Alternates (defend + left/right overtake): start displaced, short
  relaxation with a spring to the target (pure min-curvature collapses onto
  the racing line; a raw parallel offset is undrivable through a hairpin).
  Defensive line protects the inside of the COMING corner (not what the
  road does under the car), faded in over the last 300 m (smooth and
  legal). Menger curvature (4·area/product of sides) + three box-blur
  passes (3 m-grid curvature noise would make the profile brake for
  quantisation). `offsetSlopeAt(lineId, t)` (d offset / d arc, central
  difference, dimensionless) published for the lateral controller (§7.1).
  Phase labels (straight/brake/corner/exit, `phaseAt(lineId, t)`) + two
  forward fields: distance to next braking zone (`brakeDistanceAt(t)`; the
  only overtake setup spot) and next corner direction (`turnSignAt(t)`;
  decides which side is inside; sign of next corner within
  `LOOK_FOR_TURN` = 400 m, else 0). `pointAt(lineId, t, extra, out)` and
  `clampedOffsetAt(lineId, t, extra)` clamp offset + extra to the corridor
  (`limitAt(t)`; an avoidance nudge can never aim a car into the gravel).
  `speedForLateral(lineId, t, lateral)`: off-line costs corner speed (worse
  geometry; up to 17% at 4.5 m off, only where the line is curved) — and
  giving up that speed is what buys back the grip to return.
- Constants: 3 m solver grid (resolves a hairpin apex); tarmac margin left
  outside the centre line at commitment; ±overtake displacement; driver
  grip margin (temperature window, wear, margin); off-line dust/marble
  penalty; straight-curvature threshold (1/m); corner-search horizon.

### 7.4 RaceDirector (`src/game/RaceDirector.js`)
- Lap counting: sector 1 → 2 → 3 → 1 in order, and NOTHING else counts a lap
  — cutting, rejoining past a loop, or spinning back across the line cannot
  manufacture one.
- Start: one red per second (FIA gantry), dark gantry beat first, the
  starter's hold delay drawn from its own RNG stream (§1 determinism).
  Formation lap counts as a lap (one crossing ends it); the standing start
  does not (the grid is BEHIND the line — the crossing to come opens lap 1;
  the cars go out untimed). At lights-out the qualifying times STOP being
  the reference (a full tank never beats its own quali lap — keeping them
  paints every race lap yellow all afternoon).
- Track limits: the CG must be half-track-width + 0.85 m past the line
  before all four wheels are beyond it (car is 2.0 m wide — the actual
  regulation test); hysteresis metres back inside before re-arming; three
  warnings delete the lap. DRS armed from lap 3.
- Gaps: "how long ago was the car ahead standing where I am now" (what a
  timing screen means; distance-over-speed balloons every time the leader
  brakes). Below walking pace there is no honest speed → NaN → the tower
  prints a dash (twenty stationary cars all reading "+0.533" is the guarded
  failure). Fallback conversion speed = mean of both cars' HISTORY speeds
  (the stretch is covered partly at each; history beats instantaneous —
  what the car averaged, not what one corner shows); a stationary car
  contributes nothing. Gap-to-leader is ACCUMULATED intervals, not measured
  directly: two cars converted through two different speeds can order-invert
  (P14 closer than P13 while the interval column says the opposite);
  accumulation keeps both columns describing one race. Laps-down is a
  classification fact, not a lap-counter difference (those disagree by one
  for every car past the line the leader has not crossed). Gaps publish at
  10 Hz but an overtake forces a recompute (a swap with tenth-stale
  intervals mis-orders the tower). On the grid the published intervals are
  the qualifying gaps the field formed up with.
- Session seeding (grid + mid-race scenarios describe ONE coherent session):
  pole pace 66 m/s ≈ 1:46 around Spa's 7 km; seconds of lap time per skill
  unit (0.16 spread → ~2.6 s); scatter so the order is not a strict skill
  ranking; race-trim multiplier over quali (fuel, engine mode, management).
  Sector time shares MEASURED off the circuit (walk the centreline, cap
  speed by local curvature — optimistic in absolute terms, so only the
  RATIOS are used; cornering model ~4.3 g / speed caps / hairpin floor).
  Per-driver sector shape drawn ONCE per driver (a driver strong in S2 is
  strong there all afternoon — that is what makes one car own a purple
  sector) + per-lap wobble. Player slotted into PLAYER_GRID_SLOT with a
  time BETWEEN the two neighbours — anywhere inside the interval EXCEPT the
  middle (an exact split prints the same delta twice in the tower, which a
  real session never produces).
- Field spread: intervals are NOT chosen — SHOT_LAP laps are actually raced
  (a couple hundred lap times, once per session): lap scatter, a stuck-car
  rule (within ~2 tenths of dirty air, pinned), an occasional pass
  (swap + loser drops into the dirty air), a standing-start cost per row, a
  per-lap gain cap (nobody finds more on their own pace however the dice
  fall). Result: three or four trains a couple of tenths apart with clear
  air between — never an even fan. Re-classification is an insertion sort
  carrying pace with time so position k keeps describing one driver.
  `fieldIntervals(first, count, out)` hands the un-composed tail's gaps
  (the spread from position `first` on, wrapping past the field) to
  Scenarios' module-private `trailIntervals(director, first, count, pace,
  lapLength)`, which fills any it was not given with seeded random gaps and
  compresses them to the lap cap; placeRunning converts to metres at the
  shot pace.
- Fuel seeding (`FUEL_*`): a scenario teleports the field to lap 12 but no
  car burned a gram — the cluster read 104.0 kg on the grid and 103.9 on
  lap 13. Wind the tank by THIS SIMULATOR'S OWN burn rate, measured, not
  guessed: three consecutive AI Spa race laps burned 1.753/1.851/1.831 kg
  over 113.52/113.38/113.85 s → mean 0.01596 kg/s against the 0.02778 kg/s
  ceiling (Powertrain meters flow = P/(BTE·LHV) clamped at fuelFlowMax).
  Eleven laps in ≈ 84 kg, and the readout keeps falling at the metered
  rate. `laps` is fractional (the readout moves through a capture). A
  seeded tank never reads empty (the FIA sample stays in the cell). The
  seed is a READOUT, not a handicap (VehiclePhysics carries fixed race
  weight).
- applyScenario dressing: the plan's pre-wrap distances decide each car's
  lap (§3.5); splits shown are the splits of the lap shown (lap + sectors
  add up); nobody's last lap beats their own best (that pair disagreeing
  paints a slower lap green); a split beating the driver's best IS their
  best; colours only once every time is in (a session best is not known
  until then); `upTo` limits current-lap splits to sectors actually driven,
  falling back to last lap (a split stands until overwritten — exactly what
  a live tower shows; stops early-lap shots printing blank columns).
- Grid teleport is the honest shortcut (nothing in the sim reliably parks
  twenty cars on their boxes; the alternative is a formation-lap pile-up).
  Session set up against an empty grid is re-run when the field arrives
  after init. The capture rail runs before anything reads a position.
  paceLimit is advisory while the safety-car-ish state is live.
- Per-car sampling: a lap crossing closes the final sector too (both fire,
  in order); `crossings` (not `lap`) measures progress — it counts the
  untimed grid-release crossing, so race distance never steps back a lap at
  the start; delta needs a begun lap (subtracting a reference from a zero
  clock reports 100 s in hand); sector validity is read from where advance()
  recorded it (`valid` may already be re-armed by the lap close).
- Some Track implementations do not publish result factories — borrow a
  result object from the query rather than allocating per tick.
- Standings: insertion sort (nearly sorted, twenty cars, no allocation).
  Blue flag: the car classified ahead is a lap up AND closing on the road.
  `setupGridShot()`: gantry frozen all-reds, field stationary, tower showing
  the quali result. `setupRunningShot(name, speed, plan)`: green flag,
  lights out, DRS live, field classified on the placed lap.

### 7.5 Timing (`src/game/Timing.js`)
- Everything numeric and pre-allocated; called every tick for twenty cars —
  no method may allocate.
- DeltaTrace: a lap stored as elapsed-time vs distance (the only form that
  lets two different-speed laps subtract); 512 bins over 7 km = 13.7 m —
  finer than the delta bar can show. Bins skipped by a fast straight are
  back-filled. Only a lap watched FROM THE LINE may become the reference
  (`DELTA_ORIGIN_TOLERANCE` = 8 bins ≈ 110 m, checked in `commit`): a car dropped
  mid-circuit has no data behind it, and back-filling would invent a lap it
  never drove. `seed(bounds, splits)`: a dressed session has no lap behind
  it — piecewise-linear through the splits is exact at each timing line and
  within a tenth between (inside the bar's width); a straight line
  line-to-flag reports seconds of phantom delta at every boundary.
- CarTiming: progress accepted ONE sector at a time, forward only — the
  single rule that makes the counter uncheatable. Out-lap splits are
  stepped through, not recorded (partials would poison session bests).
  `crossings` vs `lap` as in §7.4. `seed(spec)` installs an un-driven
  history (clocks included so currentLapTime is plausible immediately);
  `started` stays under caller control because the grid sits behind the
  line. Track-limit strikes: 3 per deletion (`strike()`); `invalidate()`
  kills without a warning (pit lane, reset). `theoreticalBest()` = sum of
  own best sectors.
- SessionBests: submit FIRST, then classify — a time that just took the
  session best compares equal and reads purple.
- ProgressHistory: ring of (total distance, session time); `seed(distance,
  time, speed, span)` fills the ring with the constant-speed run the car would have made (a
  placed car has no past; the first frame is the only frame a screenshot
  sees) at one sample per metre (closer coalesces); samples must arrive
  with non-decreasing distance (stationary skipped); `recentSpeed(now,
  seconds)` is the fallback speed reference.
- `sectorLengthShares`: length-proportional fallback shape (right order of
  magnitude, sums to one). `splitLap` jitter is what stops a seeded field
  handing every purple to one car; splits renormalised to still sum to the
  lap. `lapTimeFraction` is the inverse of DeltaTrace.seed's mapping.

### 7.6 CameraRig (`src/game/CameraRig.js`)
- Design test: a still frame that looks tilted or seasick is too strong —
  every layer deliberately under-driven. Neck ~1.4 Hz critically damped
  (second-order spring, not a smoothing filter — the lag IS the effect: the
  eye still moving outward a tenth after the load arrives). Eye travel per
  g small (belted in; Cockpit's neck already moves the anchor — signs match
  so they reinforce). Head rotation hard limits 1.6° roll / 1.3° pitch;
  driver cancels a fraction of body roll (horizon lock). Head-look fades
  below walking pace and at speed (the corner is already in the windscreen).
- **All FOVs in this file are HORIZONTAL**, converted to three's vertical
  exactly once in `_applyProjection` (aspect read live: resize reframes, not
  crops). `fov: 82` read as vertical is 114° across 16:9 — a fisheye that
  dragged the halo rails into bands and blew the tyres into slabs while
  pushing the track away. 16:9 is assumed for the one frame before the
  first resize (otherwise a NaN projection). Speed FOV bonus: 4°, not 10
  (92° horizontal magnified everything within a metre), fully applied at
  340 km/h, slightly super-linear (the last 60 km/h is where it opens).
- Chase: real numbers a broadcast operator holds — arm behind the CG (its
  REAL length: see feed-forward below), some give at speed, 2.23 m above
  road, offset right for a three-quarter rear (flank + floor visible), aim
  just forward of and under the CG (car rides above the HUD), 51°
  horizontal lens. Camera clearance above the road only just enough
  (climbing off a crest loses the low heavy angle). Follow axis flattened
  (inheriting body roll in a chase camera reads as a bug); world-flat right
  for the offset. **Filter feed-forward**: an exponential filter chasing a
  constant-velocity target settles v/k BEHIND it forever — at 80 m/s with
  k=11 the arm sat 7.3 m further back and the aim trailed 8.9 m onto bare
  asphalt (the hero shot as "a speck in an empty car park"). Feed the
  target forward by v/k (each filter's own constant): cancels the
  steady-state error exactly, leaves transients (the arm still pushes in
  under braking). The vertical filter is slower (soaks kerbs) so it gets
  its own larger lead.
- Trackside towers: planted off the BARRIER LINE (probe `surfaceAt` outward
  until `wall`, coarse march + five bisections < 5 cm), 2 m clear (inside
  the 3 m grandstand setback), clamped between just-beyond-track-edge and
  a max (beyond the clamp the platform simply stands inside the barrier
  line — a clean sightline by construction). 9 m up = 5 m over a 4 m catch
  fence: the eye→car ray crosses the fence line at 7.4–7.9 m, clearing by
  3–4 m (6.4 m was tried and is worse — the near top rail cuts the subject
  in half; there is no sky above this circuit anyway, only grandstand).
  Leads 58 m, hands over 20 m short (always the approach, never a fly-by).
  Constant SUBJECT width: the lens holds 17 m of scene at the car (23–40°
  over the run) → the car is a quarter of the frame width throughout
  (measured 24.5% vs round-5's 6%); a fixed world width makes the aim rise
  a fixed composition. The old rig (5.2 m up, 11.5 m off the TRACK EDGE —
  not a position; the armco table varies 3.4–36 m) stood behind the debris
  fence with a 13° lens 96 m out — "framed from behind a steel debris
  fence, the two race cars thumbnail-sized", exactly what the numbers say.
  **Handover has two triggers, and the second was the five-round bug**: (1)
  within handover distance; (2) the car is FURTHER than a tower was ever
  planted (placement/reset/pit teleport — the capture harness seats the
  field 400 m back AFTER the rig planted its first tower; unhandled, the
  camera held the stale tower for the whole run-up: shutter opened at
  144 m on a lens clamped at its long stop). Operator lead = a small
  constant + the aim filter's own steady-state lag at this speed (cancelled
  exactly); the old 0.12 s was authored against a 13° lens at 96 m — on a
  23° lens at 40 m the same 9.6 m is most of a half-frame. Cuts SNAP zoom
  (a cut is a different camera, not one racking 20° in a sixth of a
  second). Tower camera shake = a tripod with a long lens: only the
  operator's hand, magnified by focal length. Side: outside of the corner
  (curvature positive left → camera right); on straights the ROOMIER hand
  (the old hash alternation put half the shots on the pit wall: 3.4 m of
  run-off, a building behind the lens, no circuit in the background).
- Shake: hash-based value noise, never a sine (a sine reads as machine
  oscillation; road texture is broadband and never repeats). Three octaves;
  the top lands ~38 Hz — as fast as a 60 Hz frame carries without aliasing
  into a strobe. Inputs physical: damper speed + surface roughness (smooth
  asphalt at 300 km/h nearly still; a kerb rattles the frame). Impact
  shake asymmetric (arrives on the frame it happens, fades out); nose-first
  throws the head down, rear hits snap it back; decay ~0.6 s; saturation
  in N·s.
- Composition presets are head poses (looking across the grid, at the
  turn-in point, into the spray), applied ON TOP of neck + steering
  head-look; resolved from scenario parameters (the three main-straight
  lighting variants are one placement under three skies — the name alone
  cannot distinguish them; time-of-day and weather do). Unknown names fall
  back to `neutral`. Explicit camera requests outrank composition.
- Near planes: cockpit 6 cm (wheel rim), distant modes pushed out for depth
  precision. Track query scratch allocated once via the track's own
  factories.

### 7.7 UI (`src/ui/*`)
- HUD: split by refresh rate — canvas cluster/tyre glyphs redrawn per
  presented frame; DOM text written only on change (120 Hz must not be 120
  layout passes). Nothing allocates per frame: prebuilt string tables for
  integers ≤ 1023, rpm quantised to 100 (steady readout + no allocation),
  colour ramps prebuilt, static chrome on an offscreen canvas rebuilt only
  on resize/units change, font strings composed once (`ctx.font =` per
  frame with a template literal is an allocation per draw). Cluster: wide
  opaque three-cell panel (speed | gear | engine+pedals) with the rev bar
  spanning the top — the old transparent near-square box over the wheel put
  both numerals on the 3D dash's pixels. Pedal bars start clear of the
  widest caption MEASURED in the fallback face (58.6/59.1 px). No webfonts
  ship: numerals in monospace (the only way to get non-jittering tabular
  figures from a fallback font); chrome is redrawn when the webfont arrives.
  Logical 760-wide space presents at ~514 CSS px (0.677 scale) — caption
  sizes are set for the ON-SCREEN cap height (measured 11.5/14.2 px).
  Backing store: both axes measured independently (if CSS box and logical
  box disagree, drawing still lands inside the element — the clipped-glyph
  class of bug); assigning width/height resets the transform (re-establish
  every rebuild). Rev cells discrete (countable like shift lights);
  two-logical-px rules (1 px blends away at 0.68 downscale); at the shift
  point the bar strobes WHITE (ramp owns amber and red; white is the only
  value left that reads "now"). Tyre widget: blended surface+core (surface
  = grip now, core = three corners from now); tread band = surface only (a
  locked front reads instantly); wear drains from the top like a
  tread-depth gauge. Pedal trough alpha 0.16-ish, not 0.07 (vanished under
  grain). letterSpacing is a recent Canvas2D addition — layout must not
  depend on it; explicit roundRect path (recent engines only).
- TimingTower: one row element per car, created once, NEVER reordered in
  the DOM — position is pure translateY so the browser animates the slide
  (re-appending snaps). VIEW window (9 rows), not 20 (589 px = 55% of a
  1080 frame down the side the driver looks through). The window must
  never drop the LEADER: cut layout = leader pinned at slot 0, break
  marker at slot 1, window around the player below; uncut from P1 when the
  player is near the top (or one row off — cutting a single position
  spends a row saying so). The break carries NO row gradient (the plate
  shows through = missing rows, not a car with no data; three dots at a
  third of row ink). Row transforms prebuilt as strings (composing per
  placement allocates in update()). Hidden rows are hidden WITHOUT moving
  (a leaving row must not slide the tower's length). Rows the
  classification stopped naming give their slot back (else they sit on a
  live row forever). Team bar luminance floor 0.11 (≈3:1 on the plate —
  the non-text glance threshold at 1080p): lifted in HSL raising LIGHTNESS
  only (blending toward white washes saturation, and two desaturated bars
  are far harder to tell apart); eight bisections (luminance is monotone in
  lightness at fixed H/S), once per car. Interval printed IFF finite —
  RaceDirector publishes NaN when there is no honest answer and the dash
  is the right reading; finiteness is the WHOLE test (gating on session
  state would blank the pre-race quali deltas in the shot that matters
  most). Compound pip carries the LETTER (at 11 px only soft-red/wet-blue
  separate by hue); sector pip state 0 is a hollow slot (the absence of a
  time is not a colour). Gap quantised before compare (float-bit wobble).
  Per-row cache in parallel typed arrays (contiguous, no allocation).
  Cars are not on ctx until CarManager runs — binding deferred to first
  use. Placement runs every tick (a change must start its transition the
  instant it happens). The pinned leader is refreshed alongside the run
  (it is on the plate; its data must stay live).
- hud.css (all measured): plate opacity 0.94/0.975 — the brightest backdrop
  bleeds ≤15/255 so white text keeps >15:1 against every frame, not just
  dark ones. Label size 0.86vw = 12 px cap at 1080 (broadcast graphics are
  read across a room; the package was set at half that). Tower width
  246 px (at 214 the driver code clipped MAR/FER at 720p). Row 2.72vh =
  29 px at 1080 (17 px cap; 2.06vh gave an 8 px cap — a caption). Interval
  track FIXED width sized to "+2 LAPS" (auto columns let one row's string
  pull its own pips out of line). Rows share a BASELINE, not centring
  (three faces at three sizes; centred boxes sit digits pixels apart). The
  plate lives on the BODY, not the rows (absolutely positioned sliding rows
  with their own translucent fills showed raw sky through the 1 px seams
  and through mid-slide bands). Player row identity lives in the position
  block + a leading-edge marker PAINTED OVER the plate (as border-left it
  was part of the box and the one row the driver reads was the one row 3 px
  out of column). PIT badge takes the sector pips' place (a pit car sets no
  sectors; both together pushed that row out of line) and is collapsed, not
  transparent (an invisible badge still reserved width). DRS panel is a
  plate (idle on a 3% white fill was dark-grey letters over a sunlit kerb —
  the least readable panel is the one that must be read the instant it
  changes). Tyre-widget crop: the numeral cap height is a VERTICAL scale —
  the box stays 207 px tall for the type while negative margins under
  overflow:hidden crop the canvas's empty frame (fractions a shade under
  the true margins so rounding cannot bite the lock-up ring); 130% canvas
  width × the 76.5% visible after trim = 99.5%. Value columns two-column,
  not space-between (numerals stack; a ragged right edge costs a corner at
  300 km/h); minmax(0,1fr) lets the label yield before the number. Delta
  readout fixed-width tabular (sign and leading digit come and go; a
  shrink-to-fit readout drags the strike pips). Scanline tint = broadcast
  feed, not a flat web page.
- Minimap: static layer (outline, DRS, sector ticks, chequer) rendered once
  offscreen and blitted; only the 20 dots are live. North-up (+X right, +Z
  down = plan view down -Y). Canvas aspect follows the circuit's bounding
  box (Spa's diagonal not squashed square). DRS zone straddling the line is
  walked with wraparound as one run. Heading tick follows velocity, holding
  its last direction when nearly stopped (no spinning on the grid).
- LoadingScreen: runs BEFORE the engine exists (own rAF loop, imports
  nothing from the engine); circuit outline pulled via dynamic import — a
  track-data failure degrades to the generated harmonic loop, not a blank
  screen. The outline is built from the same traverse the Track uses (the
  circuit the player is about to drive, not an illustration). Progress bar
  never walks backwards (a stage reporting less than the last still reads
  as progress if the bar only grows). Line widths divided by scale (stay in
  pixels).

### 7.8 Front end — `index.html`
- Fonts are resolved from the system font stack (`font-family: 'Barlow',
  system-ui, -apple-system, sans-serif`; Barlow only if installed locally).
  The page links no webfont or external stylesheet because the build must
  run fully offline (headless capture harness, CI) with no external
  requests. The only script is the `/src/main.js` module.

---

## 8. Audio

### 8.1 AudioEngine (`src/audio/AudioEngine.js`)
Signal flow: engineBus/tyreBus/worldBus/ambience → masterIn → compressor →
soft limiter → makeup → destination, with a reverb return (synthesised
impulse) fed as a SEND from the three buses with anything to reflect (the
dry path must not double back). Rules:
- The graph is built once in init() and never rewired; every frame writes
  AudioParams only — no node churn in the frame budget.
- All audio work happens once per FRAME in lateUpdate (after CameraRig has
  posed the camera, so the listener is not a frame stale), never per 120 Hz
  tick (writing params twice a frame buys nothing audible and doubles event
  traffic — `update` only banks time).
- At most eight AI engines audible, chosen by distance, recycled with a
  crossfade (Ambience owns the pool, AudioEngine owns the budget). The pool
  is sized at init: raising quality mid-session cannot grow it;
  `Ambience.setVoiceBudget(n)` returns the cap it honoured, which
  AudioEngine keeps as `voiceBudget` (a quality change silences the tail of
  the pool, never rebuilds the graph).
- resume() is idempotent from any number of gesture handlers (Chrome starts
  suspended until a gesture; a context handed over already running comes up
  straight away); level fades in rather than arriving mid-sample; the
  resume flag is cleared so a later suspension (tab switch, OS interrupt)
  can resume again. Headless/audio-less: every public method stays callable
  and does nothing.
- Master compressor: glue, not pumping — enough ratio to hold a full grid,
  release slow enough the engine does not breathe against the tyres.
  Convolver (1.5 s stereo impulse) is the most expensive node in the graph;
  the low tier substitutes a damped feedback delay carrying the same cue.
  Trackside acoustic: hard barriers and stands close, open sky above —
  short tail, early reflections carry the information.
- Player engine spatialisation: a Haas pair (dry side + short delayed
  opposite side) widens the engine around the head — the honest cue without
  HRTF for a source a metre behind the helmet.
- Pause ducks rather than cutting (the reverb tail rings out). Volume
  slider is squared (perceptual). Doppler input runs through a rolling mean
  (a single-frame difference at 60 fps warbles audibly on a passing car).
  Three.js cameras look down local -Z — negate the third basis column for
  the listener forward.
- Impacts: contact impulses run from a few hundred N·s (kerb clout) to tens
  of thousands (barrier); scale = `impulse / 9000` clamped to 1, which puts a
  normal wheel-to-wheel touch at about half scale (below 0.02 nothing
  plays).
  Carbon breaks with an inharmonic crack over a broadband crunch, not a
  note.

### 8.2 DSP toolkit (`src/audio/DSP.js`)
Every sound in APEX is synthesised — not one sample file in the build. The
design constraint: build the graph once, then only parameters move.
- `setParam`: one-pole ramp that SKIPS the write when already within
  epsilon — physics moves a hair per tick, and gating keeps each
  AudioParam's event list near empty instead of a ramp per param per tick.
  `setParamNow` for sample-accurate gates. `envBurst`: every transient in
  the game (shift clack, kerb strike, crackle, impacts) as a few scheduled
  events, never a new node graph.
- `startSource` guards double-start (a racing resume(): a second start()
  THROWS rather than warns — swallowed); `stopSource`/`disconnectAll`
  swallow already-closed/detached errors.
- Saturation: tanh clipper — drive above ~3 gives the exhaust the
  compressed ragged edge of a nonlinear pressure wave. Limiter curve:
  linear below threshold (no colour at ordinary levels), tanh above (a
  20-car pile-up cannot clip). Pulse curve turns one sawtooth into an
  impulse train — the kerb rumble is one oscillator at the serration strike
  rate, not hundreds of one-shots.
- Noise: pink/brown get a wrap crossfade (loop seam inaudible); pink is
  Paul Kellet's economy filter (-3 dB/oct within 0.05 dB above 10 Hz);
  brown has a leak (kills DC walk); `sparse` is velvet noise (~670
  grains/s at 48 kHz, doublet impulses — a doublet reads as a hard grain,
  not a click) for gravel rattle and rain patter where grains must be
  discernible.
- Impulse response: exponentially decaying noise through a one-pole lowpass
  whose cutoff FALLS across the tail (a flat decay is a plate; real spaces
  lose highs faster), a few ms of build-up (diffuse field densifies),
  discrete early reflections in front (their spacing IS the apparent size),
  normalised on summed energy (swapping environments does not change
  level). `RingDelay`: feedback delay + damping lowpass in the loop — the
  low-tier reverb and the barrier slapback everywhere.
- `RingBuffer`: fixed-size scalar ring, O(1) running mean (de-jitters
  Doppler). `setPannerPosition` writes both the AudioParam and the
  deprecated setter APIs. `dopplerRatio`: WebAudio dropped its own Doppler
  in 2015, so the shift is applied to source frequency — cheaper, and
  clamped hard (an F1 car closing at 90 m/s would shift a passing engine a
  musical fourth — cartoon). SPEED_OF_SOUND 343.2 m/s (dry air, 20 C).

### 8.3 EngineSynth (`src/audio/EngineSynth.js`)
A 1.6 L V6 turbo hybrid as a wave-table stack:
- A four-stroke six fires 3×/rev → firing frequency rpm/20 Hz (200 Hz at
  4000, 750 Hz at the 15 000 limiter). Oscillators run at the HALF ORDER
  (rpm/120) so harmonic n maps to engine order n/2: the table carries the
  half-order bank-asymmetry content as well as integer orders. Order 3 and
  multiples dominate (firing orders); half orders sit ~⅓ level underneath —
  what stops it being a sawtooth.
- The scream vs drone: spectral tilt flattens with rpm (-2.4 dB/order at
  idle → -1.1 near the limiter, so 2–4 kHz orders survive) + a fixed
  formant chain (3-into-1 collector ~760 Hz, tailpipe ~2.4 kHz, an upper
  edge that opens only at high rpm). The timbre between 4000 and 15 000 is
  a different instrument, not a transposition: five tables at rpm anchors,
  equal-power crossfaded (no dip mid-sweep), only two audible at once —
  silent tables get an IMMEDIATE zero (a lingering tail three anchors away
  is exactly the "one sample stretched over the rev range" artefact the
  approach exists to avoid).
- Table phases follow a quadratic chirp: aligned phases = buzzy impulse
  train with huge crest factor; random = firing pulses smeared to noise;
  the chirp keeps a recognisable pulse per firing while spreading peak
  energy. Per-car seed so two cars never phase-lock into a flanger.
- ONE ConstantSourceNode carries crank frequency into every oscillator and
  rpm-tracking filter (all at 0 Hz intrinsic, summed) — a whole engine is
  one AudioParam write per tick.
- Sub-25–60 Hz half/first orders at idle are CUT: real content, but
  unreproducible on anything the game is played through — otherwise it eats
  master-compressor headroom.
- Level: 15 000 rpm ≈ +20 dB over idle; closing the throttle -8 dB with no
  pitch change. Overrun: a negative peaking band opens (closed plates pull
  the midrange out — the hollow papery note). Intake honk (high-Q band
  riding the firing order) is on AI voices too — without it a distant car
  is a pure tone and reads synthetic. Per-voice muffle filter: distance and
  barriers eat the top long before the level — what makes a car three
  corners away SOUND three corners away. Turbo: compressor whistle +
  intercooler rush driven by BOOST, not rpm (whine tracks shaft speed).
  Wastegate flutter: noise chopped by an ever-running square LFO; a lift
  is one scheduled envelope, no allocation — thresholded on the throttle
  DERIVATIVE so a gentle roll-out does not chatter. Overrun crackle:
  Poisson-ish exponential spacing (a metronome reads as a machine gun, not
  combustion), rate follows rpm × off-throttle; pops live off-gas at high
  rpm with brakes on. MGU-K: two partials an order apart beating into the
  electric warble out of slow corners; whine at order 12 (step-up gearing);
  harvest is watts on the crank, 120 kW regulation ceiling. Limiter
  stutter: square LFO driving the gate by summation (depth 0 = open;
  -0.82 = chopped to 18% at 33 Hz — reads as a stutter, not a wobble).
  Gear change: physics supplies the rpm step; the synth supplies the
  ignition cut (`shift(now, direction)`: 40 ms up / 55 ms down by default,
  gate dipping to 0.10 / 0.24), the dog-ring click (hard and dry, not a
  tone) and downshift blip pops. The cut lengths are constructor options
  (`upshiftCutSeconds`/`downshiftCutSeconds`); AudioEngine passes the player
  car config's `transmission.shiftTime`/`downshiftTime` so the cut matches
  the gearbox (lite voices ignore `shift`). `detail: 'lite'` for AI voices
  (~¼ the nodes); `silence(now)`
  ramps the output to zero in 4 ms when Ambience releases a pool voice.

### 8.4 TyreAudio (`src/audio/TyreAudio.js`)
One static graph; update writes parameters. Layers with real excitation
models:
- Road roar: brown noise (has the -6 dB/oct tilt carcass noise actually
  has) lowpassed open with speed; level ∝ surface roughness; rolling noise
  power ≈ speed³ (amplitude exponent tempered to stay audible in the pits).
- Tread grain: pink noise through a band tracking tread-pitch frequency
  (55 mm shoulder-wear block pitch → speed/0.055) — texture speeds up, not
  just louder.
- Scrub: bandpassed noise, centre rising with slip angle, split front/rear
  (understeer and oversteer sound different from the seat). Below ~2° the
  tyre deforms elastically and is silent; past ~9° fully sliding,
  saturated.
- Lock-up: very-high-Q band + a tonal partial at the tread-block resonance
  (the sine is what cuts through an engine at 12 000 rpm), pitched by a
  blend of remaining carcass rotation and drag speed. Wheelspin: same idea
  an octave up, frequency riding slip ratio, chirping as it breaks/grabs.
- Kerb: sawtooth at the serration strike rate (speed / 0.42 m pitch) shaped
  to an impulse train — sounds the thumps AND amplitude-modulates the
  abrasive noise band so texture and thump are locked; one oscillator.
- Suspension impacts: a step change in COMPRESSION is the bump strike (the
  derivative is what you feel; absolute travel is inaudible); static load
  reference ~12 kN + downforce.
- Off-track: velvet-noise gravel, soft grass swish, astroturf. Surface
  histogram in a preallocated Float32Array (allocation-free update).
  Event hooks, called by AudioEngine: `kerbStrike(now, speed)` on `car:kerb`
  (a thump of 0.25 + speed/70, clamped to 1, on top of the per-wheel
  compression-step detector) and `impact(now, intensity 0..1)` on
  `car:collision` (impulse / 9000 N·s).

### 8.5 Ambience (`src/audio/Ambience.js`)
- AI engine field: a pool of lite EngineSynths bound to the nearest cars,
  re-sorted at intervals, rebound with a ~0.12 s crossfade; each voice
  through a PannerNode with the Doppler ratio applied to source frequency
  (§8.2). Radial components along listener→source: listener closing raises
  pitch, source fleeing lowers it. Air absorption ≈ 3 dB/100 m at 4 kHz
  (far more above): a one-pole sweep on the voice's own muffle filter is a
  close-enough model and free. Nearest-rival selection: squared-distance
  insertion sort in place.
- Wind: two decorrelated streams (same buffer, different offsets, slightly
  different rates — costs nothing, never phases) for width; helmet buffet
  resonant at the shell's cavity mode; a halo-separation resonance at the
  visor edge. Wind noise power ≈ v^6 (v^5 amplitude); the exponent used is
  1.7 — tamed to leave headroom for the engine at 340 km/h.
- Rain: drops striking helmet and halo; driving into rain multiplies rate
  AND energy. Pit: compressors (sawtooth through a tight lowpass), tannoy
  (mid band with slow amplitude wander standing in for speech), wheel-gun
  chop at hammer rate.
- Crowd: bigger stands hold more people and carry further; a cheer is the
  SAME crowd through a brighter louder path (never a second layered voice);
  the swell LFO is brown noise played back 100× slow (free, non-repeating,
  exactly the lazy character); distance rolls the TOP off a crowd long
  before it quietens it; three voices assigned the n-th nearest stands by a
  24-distance linear scan per frame, no allocation; grandstand contribution
  cut past a distance cap. `cheer(now, intensity = 1)` lifts whichever crowd
  voices are in earshot (gain above 0.02); AudioEngine calls it on
  `race:lap` (0.8) and `race:start` (1).

---

## 9. Do-not-do list (quick reference)

- Do NOT request PCFSoftShadowMap on three r185 (§2.1).
- Do NOT move the shadow fit back into the scene hook, or re-add the
  "already consumed" refit guard (§2.4).
- Do NOT reintroduce a multi-light hand-rolled CSM or trust three's own
  shadow lookup path here (§2.5). Do NOT assume NearestFilter assignment on
  a live shadow map does anything (§2.5). Do NOT let `shadow.intensity`
  become nonzero (double-counting on hardware where three's path works).
- Do NOT plain-assign `material.onBeforeCompile` on patched materials — the
  accessor captures it, but new code must not rely on ordering (§2.5).
- Do NOT key anything on a patched material's function identity or `.name`:
  the shadow patch keys idempotence on the `__apexSunPatch` state property
  and its program cache key on the inner callback's source text plus the
  patch-set id (§2.5).
- Do NOT gate the contact-shadow term on the cast `lit` result, and do NOT
  raise `contactBias` back toward 0.75 texel — either one erases the tyre
  contact patch (§2.5).
- Do NOT let a no-depth-write mesh into the velocity pass (§2.6). Do NOT
  latch motion history on frames the sim did not advance (§2.7).
- Do NOT source the heat-haze/visor capture from the drawing buffer or any
  tonemapped frame. Blit `RenderPipeline.sceneColorTexture` (linear HDR)
  (§2.9). Do NOT enable `HAZE_LAYER` on any camera but the main one, and do
  NOT hand out `sceneTexture` while HeatHaze is disabled (§2.9).
- Do NOT gate on `uGodrayIntensity` with an absolute epsilon (`<= 0` only),
  do NOT normalise the shaft buffer itself (the flare gate reads its raw
  scale), and keep `GODRAY_BLUR_PASSES` an odd length (§5.1–§5.3).
- Do NOT sample three's `vNormalMapUv` for puddle placement (§2.10). Do NOT
  alpha-blend water with the BRDF's own Fresnel-weighted specular as the
  colour (squared Fresnel, §2.10). Do NOT add a 0..1 refraction term into
  the HDR buffer — the visor film multiplies (§2.10).
- Do NOT use MultiplyBlending presets on straight-alpha materials (§2.11).
- Do NOT capture with fewer than 24 moving presents + 12 settled frames
  (§3.1). Do NOT trust a preview server without the dist-hash check (§3.2).
  Scenario timeOfDay is UTC (§3.3).
- Do NOT report max speed in harnesses — use a percentile (§3.4).
- Do NOT give railed/parked cars a scripted brake, and re-derive gear/rpm
  from railed road speed after the physics step (§3.5).
- Do NOT feed the loaded tyre radius back into the suspension ray (§4.2).
  Do NOT put per-car physics scratch at module scope (§4.2).
- Do NOT lower tarmac specularIntensity below ~0.6 (it scales the wet
  mirror too) (§5.6). Do NOT re-add clearcoat to tyre treads (§5.6).
- Do NOT scale roughness maps with a plain scalar to hit a reviewed mean —
  use `_pinRoughness` (§5.6).
- Do NOT let cap fans/mirrored rings produce non-monotone wrap u/v (§6.1).
  Do NOT build ducts from scaled inlet copies (§6.1). Do NOT fold
  wings/floor/halo onto body paint at low LODs (§6.1).
- Do NOT move the Cockpit half-roll or DriverModel WRIST_BEND/WRIST_ROLL
  independently — they are one contract (§6.2/§6.3).
- Do NOT reorder the glove material groups; the stitch group must exist at
  every tier (§6.3).
- Do NOT tile tyre tread v, and keep the geometric compound channel in step
  with the texture band at v = 0.69 ± 0.085 (§6.4). Keep the contact-shadow
  quad fractions in step with contactShadow's uPatch (§6.4).
- Do NOT make tarmac roughness depend on v (§6.8). Author rubber albedo at
  its real 0x28–0x40 (§6.8).
- Do NOT alpha-test the catch-fence veil, and keep foliage alpha-test with
  the coverage-preserving chain (cap 8, take the covering side) (§6.8/§6.7).
- Do NOT count laps by anything but the forward sector state machine (§7.4,
  §7.5). Submit bests before classifying (§7.5). Print an interval only
  when finite (§7.7).
- Do NOT treat CameraRig FOVs as vertical (§7.6). Do NOT reintroduce
  distance-only tower handover (§7.6).
- Do NOT rewire audio graphs at runtime; only parameters move (§8). Do NOT
  write audio params per tick (per frame only, in lateUpdate) (§8.1).
- Do NOT add or remove lights at runtime (§2.11 / Sparks).

---

## 10. Effects systems (fx/)

### 10.1 EffectsSystem (`src/fx/EffectsSystem.js`)
- Reads `ctx.cars[i].physics.state` and never simulates what physics already
  knows — every rate is a function of slip power, load, temperature, ride
  height or water depth. Ordering: `update` (fixed tick) only SPAWNS; the
  GPU evaluates trajectories. `lateUpdate` (display rate) does what must
  agree with the drawn frame: the particle clock, the screen capture the
  refraction effects sample, the camera-locked rain volume.
- Pool capacities are FIXED from the starting tier; a later tier change
  scales emission rates instead of reallocating (dropping megabytes of
  instance buffers and regenerating sprites mid-race is a visible hitch;
  thinning the cloud gets the same frame time).
- Emitter-state growth compares against the field size last CONSUMED, not
  the emitter count (a car without physics is skipped; comparing lengths
  rebuilds the table every tick). Track.locate results are claimed once per
  car and reused (locate allocates when handed nothing).
- Distant cars still emit (you must see the spray of the car ahead) but the
  rate falls off with distance so the pack cannot spend the pool the near
  car needs; beyond a cutoff a car's emitters go quiet (a speck's smoke is
  fog). Lateral position feeds only marble pickup and spray depth — a 15 Hz
  staggered refresh is plenty.
- Overrun/downshift pops: closing the throttle at high rpm lights unburnt
  fuel in a 700 C pipe; a hard pop pushes soot out with the flame. Only the
  player's physics carries the event bus, so a RIVAL scraping a barrier is
  detected from the damage it takes — without this the pack piles into turn
  one in silence, the one place sparks matter most.
- One scene-target blit (`HeatHaze.captureFrame` of
  `RenderPipeline.sceneColorTexture`, §2.9) serves both refraction
  consumers. It is taken only when one will sample it: HeatHaze enabled AND
  (haze sources present OR rain intensity > 0.02). The capture runs before
  `weather.lateUpdate` reads `heat.sceneTexture` in the same frame, and that
  getter is null while HeatHaze is disabled (§2.9). Damage-section positions
  in car-local metres (-Z forward). Public: one-off spark shower; forced
  road wetness; global emitter scale (photo mode, performance fallback).

### 10.2 ParticleSystem (`src/fx/ParticleSystem.js`)
- GPU-simulated pools, one draw call per effect. Every particle is an
  instance carrying its whole trajectory as constants (origin, velocity,
  drag, gravity, ground Y, turbulence, colour, life); the vertex shader
  evaluates the CLOSED FORM at uTime — the CPU writes an instance once at
  spawn and never touches it again. Two integrators compiled from one
  source, switched by the single define `SIM_BALLISTIC` (set when a pool is
  created with `ballistic: true`): the default drag branch (the `#else`;
  exact for dv/dt = -k(v - v_inf) with k = max(drag, 0.02) and v_inf =
  wind·windScale − (0, gravity/k, 0), plus a turbulence offset growing with
  age: smoke, dust, spray, flame, splash) and `SIM_BALLISTIC` (parabola + up
  to two analytic ground bounces — the skittering is the point: sparks,
  debris).
- SIM_BALLISTIC stops at TWO bounces (`for i < 2`). Two is where the eye
  stops counting, and a third hop is always sub-pixel. After the loop the
  particle finishes its parabola and is clamped onto `groundY` at rest
  (velocity zeroed) rather than sinking.
- Dead and unborn instances (t outside [0,1)) write
  `gl_Position = vec4(0, 0, 2, 1)`. With z/w = 2 they sit behind the far
  plane and clip to zero fragments, and nothing else in the shader needs a
  branch for them. This matters because `instanceCount` runs to the pool's
  high-water mark, so dead slots inside that range are still vertex-shaded.
- STRETCH (sparks): the streak extends by `radius + |velView.xy| · stretch`
  along the projected velocity. `stretch` is a shutter interval in seconds
  (Sparks sets 0.010–0.028 s), so the streak is the distance the particle
  covers in one shutter interval. It is measured in the view plane so it
  foreshortens correctly: a spark flying at the camera shrinks to a dot.
  Stretched particles ignore spin.
- Ray setup for SOFT/LIT: `vWorld = world + vec3(off, 0) * mat3(viewMatrix)`.
  The view basis is orthonormal, so the row-vector multiply is the
  transpose, which is the inverse rotation. It lifts the view-space corner
  offset back into world space, so the fragment shader can build its view
  ray against `cameraPosition` without an inverse view matrix.
- LIT shading uses the sphere's own normal at the ray's entry point
  (`cameraPosition + ray·(b − h) − centre`), with a wrapped
  `smoothstep(-0.55, 0.85, N·L)` plus a forward-scatter lobe
  `pow(ray·sun, 8) · uScatter` weighted by (1 − alpha). The sunlit crown and
  the shadowed underside are what make a smoke column read as volume rather
  than as a grey decal.
- Sorting: additive effects are order-independent; alpha effects are
  separated into pools with explicit render order (dust behind smoke behind
  spray behind rain); within one effect a shared ramp + premultiplied alpha
  cannot seam in any order. One shader serves alpha and additive — both
  emit premultiplied alpha, only the destination factor differs.
- Soft particles are ANALYTIC, not depth-buffer: the single forward pass's
  depth is live and sampling it is a framebuffer feedback loop. Each
  particle is a sphere (Umenhoffer spherical billboards); the view ray's
  chord is clipped against the eye's near distance and the local ground
  plane the particle was emitted on — removes exactly the two billboard
  tells (the line where smoke meets track; the guillotine driving through a
  cloud) for no extra pass.
- The simulation clock runs at DISPLAY rate (particles judder against a
  120 Hz spawn clock on a 60 Hz screen); fixed step only advances the spawn
  clock and recycles. Draw ranges are cleared first each frame (a frame in
  which the mesh never reached the renderer would leave its range behind
  and grow the list without bound). Pool reclaim: full sweep O(capacity)
  only when dry; saturated pools steal round-robin (the oldest visible
  particle goes). Spawn brush: caller mutates fields and calls spawn; every
  field persists (a 40-particle burst writes its colour once) — mutating a
  long-lived object keeps the hot path allocation-free.
- Budget split: pool fractions sum to 0.72; the other 0.28 belongs to
  Weather's rain volume so the worst simultaneous case fits the tier.
- Smoke is lit by borrowing the sun's colour and a fraction of its
  intensity — never a second sun. Sprites are MASKS, not colour (the
  particle's linear tint colours them); lattice-hash noise is deterministic
  per (x, y, seed).

### 10.3 Sparks (`src/fx/Sparks.js`)
- Titanium skid blocks burn at a much lower temperature than old steel
  skids — sparks come out white and stay lit long enough to bounce. Three
  non-negotiables: sparks leave the FLOOR (not bodywork), bounce off the
  road, and cool white→orange→red within their half-second life.
- Plank window `PLANK_CLEARANCE` 0.030 → `PLANK_CONTACT` 0.016 m (squash
  ramps 0→1 as ride height falls through it): physics reports ride height
  at the aero reference plane; the blocks hang ~2 cm below, so the road arrives while
  the plane still reads ~30 mm; telemetry bottoms the front axle at 18 mm —
  where the shower is hardest. Two routes to the road: aero squash at
  speed, and a compression-rate spike over a crest/kerb (positive travel
  rate = floor driven down). A wet track quenches the spark before it
  leaves the floor.
- A spark keeps ⅓–½ of the car's momentum: in the world frame it still
  travels forward while the car pulls away — the stream-backwards-on-camera
  look. Sparks start under the car and stream from beneath the diffuser.
- Dynamic lights: created once (§2.11); bids — strongest simultaneous
  sources win, and a bid close to an existing source MERGES (a shower does
  not fight itself); unclaimed lights fade rather than blink; sparks light
  the road at any hour but only own it at dusk; the pool light tints
  toward red as a shower thins.

### 10.4 TyreSmoke (`src/fx/TyreSmoke.js`)
- Emission driven by real slip power P = |Fx·Vslip_long| + |Fy·Vslip_lat|
  (watts), per wheel from physics. Calibration anchors: a rear spinning up
  off the line ≈ 60–100 kW; a front locked from 300 km/h > 150 kW — those
  two set the whole response curve (smoke arrives when the driving does,
  never on a timer). Hot rubber gives up volatiles more readily but a cold
  dragged tyre still burns its surface (curve never hits zero).
- A locked FRONT is the densest whitest smoke on an F1 car and only comes
  from the front axle (the rears are still rolling under the engine).
  White/dense = lock-up; blue-grey = spun rubber; thin grey = slide. Hot
  smoke is buoyant before it cools; the car's wake drags it along the
  track off the trailing edge of the patch.
- Rates scale with the quality budget (a low tier thins the cloud rather
  than clipping at a ceiling mid-lock-up). Surface response table: dust
  colour (linear), chunk colour, yield per surface. Brake dust: above
  ~700 C discs shed a fine dark cloud in the wheel wake. Marbles: shed
  rubber off-line, kicked up when a car runs wide. Speed haze: the faint
  rubber haze every car leaves — individually invisible, in a pack it
  makes the air look used.

### 10.5 Weather (`src/fx/Weather.js`) — beyond §2.10
- Rain volume: fixed instanced field travelling with the camera, one draw,
  each drop advanced by a wrapped phase. Streaks are drawn along velocity
  RELATIVE TO THE CAMERA (vertical standing still, near-flat at 300 km/h) —
  the single cue separating "rain particles" from "driving in rain".
  The half-extents `RAIN_BOX_XZ` 7.5 / `RAIN_BOX_Y` 5 m (passed as `uBox`)
  are a DENSITY, not a size: the old 20×12×20 half-extent box spread 1836
  drops over 38 400 m³ = 0.048/m³; the frustum to fade distance holds
  ~420 m³ → ~20 streaks on screen ("dust on the lens"; every reviewer since
  round 3 correctly said there was no rain). 7.5×5×7.5 (2250 m³) packs the
  same drops ~17× denser, ~170 streaks, at no cost (drops beyond the old
  fade distance were never visible; further rain is atmosphere — fog and
  sky draw it). Drop count: capacity `clamp(round(particleBudget · 0.28),
  320, 5000)`, drawn `capacity · (0.25 + 0.75·intensity)`.
- Fall speed: `DROP_FALL_SPEED` 8.2 m/s (terminal velocity of a 2 mm
  drop), scaled on every use by `0.75 + 0.5·intensity` (6.15 m/s in a
  drizzle, 10.25 m/s at full rain), plus wind (0.85 × wind speed) and minus
  the smoothed camera velocity. Streak shutter: long enough a passing drop
  is a streak not a dot, short enough it is not a wire.
- Streak length is the drop's trail over one shutter (`uExposure` 0.014 s ×
  0.55–1.45 per drop), measured in SCREEN space from the projected now/was
  positions, not in view space. View space discards the radial component,
  so drops flying at the camera became short vertical ticks at 300 km/h. If
  either end of the trail is behind the eye (clip.w < 0.05), the quad is
  culled.
- Streak width is a world-space width (`uWidth` 0.010–0.017 m, rising with
  rain intensity) projected to screen and floored at 0.0034 (aspect-scaled
  NDC, ~1–2 px). Below about a pixel, streaks drop out of the raster and the
  volume thins from the far side. The near fade is
  `smoothstep(0.16, 0.85, dist)` m because drops 1–2 m off the visor sell
  the speed; a 2.4 m near fade deleted every long streak.
  Camera velocity smoothed (one dropped frame must not snap every streak).
  Streak colour pinned to the SKY'S OWN colour with gain above unity: a
  drop is a lens handing the whole sky dome down one cone — legitimately
  brighter than the sky patch behind it; the fixed 0.62 sat far below the
  sky's level and every streak punched a hole in the overcast.
- Wetting: `surfaceWater` is `damp`ed toward the rain amount at
  `0.09 + 0.45·rain` while rising (τ ≈ 1.9 s in full rain) and at a flat
  0.014 while falling (τ ≈ 71 s: ~95 % dry in ~3.5 min, effectively dry by
  10 min). The asymmetry is what makes a drying line appear late; wetting
  rate scales with rain rate (a flat rate needed three minutes of heavy
  shower before the road looked damp — every wet capture was on a barely
  damp track).
- Wet road = a clearcoat LAYER over rough aggregate (film over stone), not
  a change of the asphalt: the coat's Fresnel climbs toward the horizon
  (the long grazing sheen) while the base keeps its texture. Albedo loses
  only SOME to internal reflection (over-darkening was round 2's black
  pit); base stays rough (wetted stone chips); only a modest lift on the
  broad environment term (pouring sky into the base goes milky). The coat
  is driven by a STEEPENED wetness (at the 0.55 this scenario reaches, a
  plain lerp left the coat half-present at 0.16 roughness — rougher than
  damp tarmac); stops short of optically flat (the mirror-flat surface is
  the standing water's; keeping the two roughnesses apart lets pools read
  against the sheen). Coat gain/roughness 1.35/0.085, NOT 1.6/0.06 —
  measured: the steeper pair returned 1.35× sky radiance across the whole
  road and swallowed markings and aggregate (a sheet of white; a wet
  circuit is glossy AND still legibly a road).
- Standing water: body is near-black (everything seen in a puddle is
  reflection — pairing the black body with coverage-driven alpha made
  round-2 puddles holes in the track); mirror env held ~half a stop over
  unity (a true mirror already returns exactly the sky — the 2.8 it
  carried was compensating for the squared-Fresnel reflection that never
  arrived); ripples deliberately shallow (alpha is now a grazing Fresnel
  where a small normal tilt is a large reflectance swing — a pretty-at-noon
  ripple shatters the mirror band into speckle); drainage field is the
  road OUTSIDE the crown from ~⅓ out to the kerb (the old 2.1 m
  extreme-edge strip was hidden by wheels and motion blur); ripple tile
  ~3 m² (near-isotropic — wave trains must not read combed); three crossed
  wave trains + lattice jitter (structure without showing its grid).
- Rain impacts on the road draw the CROWN, not the drop: thrown water
  catching the sky, several times brighter than the wet road, and it must
  clear the FOG colour too (the pool is unlit; the atmosphere it is seen
  against sits ~1.3 scene-referred — at the old 0.72×1.8 the crowns were
  dimmer than the haze and vanished).
- Rooster tail: rear tyres do nearly all the work (wide, unshrouded, under
  the diffuser); the front pair's old quarter share went into the column.
  Fewer, larger, longer-lived puffs (the 1260-instance pool at 185/s per
  wheel filled with small ones that expired before the plume stood up; the
  same water in a third the billboards, metres across, two seconds alive,
  is what makes a wall). Plume brightness must leave WELL ABOVE the
  atmosphere it composites against (atomised water is a near-white
  scatterer; the pool's LIT term multiplies by ~0.5 under cloud; 0.80×1.9
  landed at ~0.9 — darker than the haze — "a pale smudge of exhaust").
  The rear plume outlives the car that threw it (a rooster tail still
  hangs when the next car arrives — why wet running is dangerous and why
  it reads). Water pools toward the road edges, so running wide throws far
  more. `setWetness` forces a damp-track session start.

---

## 11. Module reference (exported API)

JSDoc no longer lives in the source; this is the surviving reference.
Units: metres, seconds, radians, newtons, watts, kelvin/celsius as noted;
speeds m/s unless stated. "ctx" is the shared engine context.

### 11.1 core/
- **Engine** (`src/core/Engine.js`): owns the WebGL context, shared `ctx`,
  and the frame loop. `add(system)` — registers it as
  `ctx[systemName]` (the class's static `systemName`) and returns it; order
  matters (`init`, `update` and `lateUpdate` run in add order). `get(name)`
  → `ctx[name]`. `init()` awaits each system's `init(ctx)` in turn.
  `start()` / `stop()` the rAF loop. `step(dt)` — one fixed logic step
  (every `update(dt, ctx)`, then `ctx.input.endFrame()`), exposed so
  headless/deterministic harnesses can drive it. `present(alpha)` — stamps
  `ctx.time.frame`, runs every `lateUpdate(alpha, ctx)`, then draws one
  frame. 120 Hz fixed tick (`FIXED_HZ`/`FIXED_DT` exported), at most 6 steps
  per frame, frame time clamped to 0.25 s.
- **EventBus** (`src/core/EventBus.js`): minimal synchronous bus.
  `on(name, fn)` → unsubscribe fn; `once`, `off`, `clear`;
  `emit(name, payload)`. With more than one listener the array is copied on
  emit so a handler may unsubscribe itself mid-dispatch; a throwing handler
  is logged and the rest still run.
- **Rng** (`src/core/Rng.js`): seeded mulberry32. `seed(s)`; `next()`
  uniform [0,1); `range(min,max)` uniform [min,max); `int(min,max)` integer
  inclusive; `gaussian()` Irwin–Hall sum of 4, centred and scaled by √2
  (σ ≈ 0.82, not exactly unit); `signed(a = 1)` uniform [-a,a);
  `pick(arr)`. Shared `rng` instance for non-physics procedural work.
- **MathUtils** (`src/core/MathUtils.js`): DEG/RAD, MPS_TO_KPH/KPH_TO_MPS,
  G. clamp, clamp01, lerp, invLerp, remap, smoothstep, smootherstep;
  `damp(current,target,rate,dt)` frame-rate-independent exponential
  approach (rate in 1/s: the remaining gap shrinks by exp(-rate·dt));
  `moveTowards`; `sign`; `wrapAngle` → [-PI, PI); `wrap01` normalised track
  parameter → [0,1); `deltaT(from,to)` shortest signed difference of track
  parameters; `formatLapTime(s)` → `1:23.456`; `formatGap(s, showPlus =
  true)` → `+1.234`.
- **Input** (`src/core/Input.js`): keyboard/gamepad → ControlState
  (CONTRACT §4). Digital keys ramp into analogue axes (steering rate falls
  with speed; reversing snaps through centre faster than building lock;
  throttle/brake quick to apply, quicker to release). `isDown(action)` /
  `wasPressed(action)` / `wasReleased(action)` (edges last one tick).
  `endFrame()`, called by `Engine.step` after every system's update, clears
  the edge sets. `enabled = false` = stop reading devices, NOT zero the
  controls (§3.5). Gamepad: the first connected pad, standard mapping —
  stick axis 0 steers (8% deadzone), triggers are read as analogue BUTTON
  values (7 throttle, 6 brake); pedals that report as axes give nothing.
  Only mapped keys call preventDefault, so the browser keeps
  F-keys/devtools/reload.
- **Settings** (`src/core/Settings.js`): QUALITY_TIERS; systems read
  `ctx.quality` at init and subscribe to `quality:change`.
  `detectQualityTier()` device-conservative (mobile low).
- **AudioEngine / DSP / EngineSynth / TyreAudio / Ambience**: see §8 for
  behaviour. Key signatures: `EngineSynth(actx, {detail:'full'|'lite',
  noise, seed, gain, upshiftCutSeconds, downshiftCutSeconds})`;
  `EngineSynth.update(now, dt, state, doppler = 1)` allocation-free from
  VehiclePhysics state; `shift(now, direction)` (full detail only);
  `silence(now)`; `setGain(v, when, tau)` / `setMuffle(cutoffHz, when)`;
  exports ENGINE_LIMITER_RPM / ENGINE_IDLE_RPM. TyreAudio
  `update(now, dt, state)`, `kerbStrike(now, speed)`,
  `impact(now, intensity)`. `Ambience.update(now, dt, ctx, listener)` with
  preallocated listener {x,y,z,vx,vy,vz}; `Ambience.setVoiceBudget(n)`
  returns the honoured cap; `cheer(now, intensity)`. DSP: `setParam(param,
  value, time, tau=0.04, eps=1e-3)`; `envBurst(param, time, peak,
  attack=0.0015, decay=0.08, floor=1e-4)`;
  `createImpulseResponse(actx, {seconds, damping 0..1, width, ...})`;
  `createNoiseBuffer(actx, seconds, 'white'|'pink'|'brown'|'sparse', rng)`;
  `dopplerRatio(listenerRadial, sourceRadial)` clamped; `RingDelay`
  (feedback delay + damping LP); `RingBuffer` O(1) running mean;
  `chain(nodes)` connect head-to-tail, returns tail (init-time only).

### 11.2 physics/
- **VehiclePhysics** (`src/physics/VehiclePhysics.js`):
  `constructor(config)`; `reset(position: Vector3 (CG), quaternion, track?)`
  — track lifts the car onto the surface when handed a road-level grid
  slot. `step(dt, controls, track|null)` — one 120 Hz tick, substepped to
  240 Hz (`SUBSTEP_DT`, at most 8 substeps); null track = flat plane at
  y 0. `setEventBus(bus)` (raises `car:*`); `setAssists({abs,
  tractionControl})` (each clamped 0..1); `setBrakeBias(bias)`;
  `setErsMode(mode)`; `setCompound(name)`; `setWake(distance m, lateral m)`
  for dirty air and `setDrsZone(active, available)` (both forwarded to
  Aerodynamics); `notifyLap()` (forwarded to Powertrain). Public `state`:
  position/quaternion/velocity, per-wheel WheelState, telemetry (specific
  force = accelerometer reading, 1 g vertical at rest).
- **Tyre** (`src/physics/TyreModel.js`): `constructor(spec, compoundName,
  side ±1, tyresCfg)`. `integrateSlip(dt, vx, vy, omega rad/s, contact)`;
  `solve(fz N, gamma rad, surfaceGrip)` → Fx/Fy/Mz via MF-96 + combined
  slip; `thermal(dt, airSpeed, ambient C, trackTemp C, brakeTemp C, gamma)`
  after solve; `updateLoadedRadius(fz, omega)`; `setCompound(name)`;
  `reset(temp = 90, wear = 0)`. Sign conventions §1.
- **Suspension** (`src/physics/Suspension.js`): `solve(dt, travelIn m
  (+ = bump), contact Uint8Array, longForce N per wheel)` → per-wheel
  `force`, `camber`/`toe`, `compression`, accumulated `bumpStopEnergy`,
  `bottomedOut`; `rollStiffness(front: boolean)` for telemetry;
  `maxDroop(i)` / `maxBump(i)` geometric travel limits.
- **Aerodynamics** (`src/physics/Aerodynamics.js`): `step(dt, speed m/s,
  rhFront m, rhRear m, roll rad, sideslip rad, lateralSpeed m/s)` →
  `downforce` (+ `downforceFront/Rear`), `drag`, `sideForce` magnitudes
  (car frame, §4.5), `balance`, `pitchMoment`; `setWake(distance =
  Infinity, lateral = 0)`; `setDamage(front, rear, floor)`;
  `requestDrs(open)` (VehiclePhysics passes the DRS button, dropped under
  brake) + `setDrsZone(active, available)` entitlement flags (CarManager and
  RaceDirector); `oneGSpeed` getter.
- **Powertrain** (`src/physics/Powertrain.js`): `step(dt, controls,
  wheelOmega Float64Array (forward-positive rad/s), slipRatio, speed,
  airSpeed, events|null)`; `notifyLap()` zeroes the per-lap ERS counters;
  `ratioFor(gear)` overall ratio incl. final drive, negative in reverse,
  0 in neutral; `setBrakeBias(bias)` (clamped to biasMin..biasMax);
  `setErsMode(mode)`.
- **CarConfig** (`src/physics/CarConfig.js`): `createCarConfig(overrides)` —
  deep-merged fresh config; `createTeamConfig(teamId, compound='medium',
  overrides)`; `teamIds()`; TYRE_COMPOUNDS, TEAM_SETUPS, AIR_DENSITY.
  `finaliseConfig(cfg)` runs once per config (both factories call it:
  CG split, wheel/ride rates, series factors, static loads/travel, overall
  ratios); `wheelLocalPositions(cfg, out)` fills four wheel-centre
  Vector3s.

### 11.3 ai/
- **AIDriver** (`src/ai/AIDriver.js`): `constructor(car, track|null,
  {skill 0..1, aggression 0..1})`. `update(dt, ctx, loc?)` → ControlState
  (loc = caller's Track.locate result if it has one). `reset()` after any
  teleport. `paceLimit` respected under advisory pace.
- **RacingLine** (`src/ai/RacingLine.js`): `getRacingLine(track, config)` —
  one shared solve per track (WeakMap-cached). Line ids
  LINE_RACE/DEFEND/LEFT/RIGHT (LINE_COUNT 4); phases
  PHASE_STRAIGHT/BRAKE/CORNER/EXIT. Allocation-free queries, line id first:
  `offsetAt(lineId, t)`, `speedAt(lineId, t)`, `curvatureAt(lineId, t)`,
  `offsetSlopeAt(lineId, t)` (d offset/d arc, dimensionless),
  `speedForLateral(lineId, t, lateral m)` (off-line costs speed),
  `pointAt(lineId, t, extra m, out)` and `clampedOffsetAt(lineId, t, extra)`
  clamped to the corridor (`limitAt(t)`), `phaseAt(lineId, t)`,
  `brakeDistanceAt(t)`, `turnSignAt(t)` (+1 left / -1 right / 0 straight
  within 400 m), `indexAt(t)`; capability tables `latAccelAt(v)`,
  `brakeAccelAt(v)`, `driveAccelAt(v)`, `coastDecelAt(v)`.
- **Overtaking** (`src/ai/Overtaking.js`): `getTrafficModel(track)` shared
  per track; `TrafficModel.sync(ctx)` — every AIDriver calls it every tick,
  stamped on `ctx.time.elapsed` so only the first call per tick does the
  work; per-car typed arrays `aheadIdx`/`behindIdx`, `gapAhead`/`gapBehind`
  (forward metres around the lap ≥ 0) and three neighbours each way;
  `approachingBehind(index, metres, minClosing = 2)` → true when an on-track
  car within `metres` behind is closing faster than `minClosing` m/s.
  `Racecraft(car, line, rng, {aggression})` — `evaluate(dt, ctx, traffic,
  loc, plan)` on the tactical round robin (every `PLAN_PERIOD` = 6 ticks,
  20 Hz); per-tick `avoid(dt, ctx, traffic, loc, plan)` proximity handling;
  `reset()`.

### 11.4 track/
- **Track** (`src/track/Track.js`): CONTRACT §2 queries, allocation-free
  with `out`: `locate(pos, out)` (t, lateral m signed right, tangent…),
  `sample(t, out)`, `surfaceAt(pos, out)` (surface name, grip, normal,
  wall), `heightAt(x, z)` cheap Y for suspension rays;
  `barrierCollide(worldPos, radius, out)` → {hit, normal, penetration}
  (null before the barriers are built); `sectorAt(t)` → 0/1/2,
  `drsZoneAt(t)` (handles the wrap), `inDrsZone(t)`, `cornerAt(t)` (the
  corner containing t, else the next one ahead), `racingLineOffsetAt(t)`
  (interpolates the `racingLineOffset` array), `racingLinePoint(t, out)`;
  createLocateResult/createSurfaceResult factories live on `track.surface`;
  `startGrid` slots ({position, quaternion}) and `gridBoxes`.
- **TrackSurface** (`src/track/TrackSurface.js`): the query layer
  (§6.7); exports KERB_HEIGHT 0.052, KERB_RIB_PITCH 0.25 (matches texture
  and rumble), KERB_RIB_AMPLITUDE, KERB_CHAMFER, ASTRO_DROP, RUNOFF_FALL,
  CROWN 0.011, BARRIER_NAMES.
- **CircuitData** (`src/track/CircuitData.js`): SPA tables (§6.7);
  `buildLayout(circuit=SPA)` walks the traverse → centreline control
  points, samplers, marks; `makePeriodicSpline(knots, period)` →
  monotone-cubic sampler (distance)→value, wrapping; `cornerSpan(corner,
  marks, total)` → [entry, apex, exit] distances.
- **TrackMeshBuilder / Barriers / Trackside**: builders (§6.7);
  `Barriers.collide(worldPos, radius, out)` O(1) allocation-free (+
  `probe(worldPos, groundY)`); `Trackside.animate(elapsed)`, called from
  `Track.lateUpdate` every frame, allocates nothing (time and wind uniforms,
  night factor, floodlight spots); `Trackside.drawCalls` getter counts the
  meshes under its group.

### 11.5 car/
- **Car** (`src/car/Car.js`): one car — physics body + three detail levels +
  interpolation. `update(dt, ctx)` fixed step (steps the physics with
  `controls`); `lateUpdate(alpha, ctx)` blends the two buffered states;
  `setDetail(0|1|2)` (builds a level on first use); `reset(position,
  quaternion, track)`; `setCompound(name)`; `setVisible(v)`;
  `distanceSqTo(point)` for detail ranking; `scriptedControls` (capture
  rail, §3.5).
- **CarManager** (`src/car/CarManager.js`): registers as `ctx.cars`,
  array-like, index 0 = player (CONTRACT §1). spawnOnGrid (player at
  mid-front slot), respawnPlayer (back on the racing line facing forward);
  per-frame detail budgeting, slipstream/DRS pass, lap bookkeeping (§6.6).
- **CarModel** (`src/car/CarModel.js`): CAR_DIMENSIONS, COCKPIT_ANCHORS,
  DRS_PIVOT, DRS_OPEN_ANGLE (47°); `buildCarGeometry(detail 2|1|0)` cached
  shared geometry; `cockpitInteriorGeometry(ring)`; `cockpitRimPoints
  (side)` (shared with Cockpit trim); `suspensionLinks()` both sides CG
  frame; `strutGeometry(detail)` unit strut along +X;
  dispose{Shared,Strut}Geometry. `CarModel` class: one car's bodywork at a
  level — geometry shared, per-team materials; `setDrs(open 0..1)` (flap
  lies flat near 1); dispose leaves shared resources (CarManager releases
  centrally).
- **Cockpit** (`src/car/Cockpit.js`): `update(dt, ctx)` (visibility from
  the private `_cameraIsInCockpit(ctx)`: camera within 0.6 m of the eye
  anchor); `renderMirrors(ctx)` (restores render target + shadow
  auto-update); `resize()`; `setQuality(tier)`; owns `group` (gated) and
  `driverGroup` (never gated) — §6.2.
- **Wheels** (`src/car/Wheels.js`): `WheelSet(ctx, {detail, compound,
  front:{radius m, width m}, rear:{...}, discRadiusFront, discRadiusRear})`;
  `setWheel(i, position car-local, steer, camber, spin)` (quaternion rebuilt
  so the caliper shares steer/camber, not spin); `setBrakeTemp(i, celsius)`;
  `setCompound(name)`; `setVisible(v)`; `commit()` once per frame;
  `glowColor(celsius, out)` ramp §6.4; disposeSharedWheelGeometry.
- **DriverModel** (`src/car/DriverModel.js`): `helmetMaterial(driver,
  quality)` cached per driver; `DriverBust(ctx, driver, livery, detail = 2,
  anchor = [0, 0.48, -0.23])` (anchor = car-local head centre) —
  `setHeadLean(lateralG, longitudinalG)` head leans INTO the corner (roll
  clamped to ±0.14 rad, pitch to ±0.06); `ArmChain(ctx, livery, side,
  shoulder, detail = 2)` with bone lengths from the exported
  UPPER_LENGTH/FORE_LENGTH — `solve(targetPos in root space)` places both
  bones and the hand at the target, returns and publishes `elbow`; the
  caller orients the hand from it with `orientHand(q)`;
  `gloveMaterials(ctx, livery)` (group order contract §6.3);
  `cockpitSuitMaterial(livery)`; `legsGeometry(detail, knee, ankle, hip)`;
  dispose* for every shared set.
- **Teams** (`src/car/Teams.js`): TEAMS, DRIVERS (flat, grid order, 0 =
  player), teamById(id); BODY_V_FRONT/REAR; `LiveryFactory(ctx)` —
  `get(team)` cached by team id (ten sets serve twenty cars; body/wing
  wrap textures plus the set's paint, carbon and metal materials); suit
  material per team (a clone of MaterialLibrary `makeLivery(team.colors)
  .suit` with its sheen retuned); `numberDecal(driver)` canvas texture
  cached on the driver record (`driver._numberTexture`).

### 11.6 game/
- **Timing** (`src/game/Timing.js`): SECTOR_COUNT 3;
  ADVANCE_NONE/SECTOR/LAP; COLOUR_*; STRIKES_PER_DELETION 3. `DeltaTrace`
  (512 bins): begin(); clear(); record(fraction [0,1), elapsed s);
  `commit(lapTime)` (candidate → reference when faster); `seed(bounds,
  splits, count)` (bounds = normalised timing-line positions, ascending,
  bounds[0]===0); `lookup(fraction)` → s or NaN. `CarTiming`:
  reset(time, sector, timed); `seed({now, lap, crossings?, sector,
  started?, lapElapsed?, sectorElapsed?, bestLap?, lastLap?, bestSectors?,
  lastSectors?, currentSectors?, bounds?})`; `advance(sector, time)` →
  ADVANCE_*; `currentLapTime(now)`; `invalidate()`; `strike()` → true on
  the strike that deletes; `theoreticalBest()`. `SessionBests`:
  submitLap/submitSector then classifyLap/classifySector (§7.5);
  theoretical(). `ProgressHistory`: clear(); push(distance, time);
  `seed(distance, time, speed, span)`; `timeAt(d)` → s or NaN;
  `recentSpeed(now, seconds)`. Helpers: sectorLengthShares, splitLap(lapTime,
  shares, out, rng, jitter), lapTimeFraction(t, bounds, shares).
- **RaceDirector** (`src/game/RaceDirector.js`): session control
  (`setSession(type, options)`, `restart()`), binding to ctx.cars, flags,
  DRS, track limits, standings, gaps (§7.4). Capture API:
  `applyScenario(setup)` (via Scenarios; keeps the returned rail and runs
  its `update(dt)` first thing in its own update), `setupGridShot()`,
  `setupRunningShot(name, speed m/s, plan?)` (plan = [{index, distance,
  speed, lateral}] as placed); both re-read positions through the private
  `_resync(timed)`; `fieldIntervals(first, count, out)` (field-spread
  intervals for the trailing cars, §7.4) and `gridSlotFor(carIndex)`
  (qualifying grid slot), both read by Scenarios; queries:
  `entryFor(car)` (the car's classification entry or null), getter
  `playerDelta` (s, NaN before a reference lap).
- **Scenarios** (`src/game/Scenarios.js`): `applyScenario(ctx, director,
  setup)` → ScenarioRail | null; `ScenarioRail.update(dt)` called once per
  fixed step by the director, a no-op unless the rail is active (capture
  mode); `addRail`/`addFixed`/`clear()`; `resolveCars(ctx)`
  (manager may expose or wrap the array); `physicsOf(car)`. Scenario
  entries: distance m along centreline, lateral m right, lateralFromEdge
  (measured in from the LEFT edge — kerb placements follow the width),
  speed, warmup s, slip deg (player full strength, rivals a fraction — no
  synchronised drift), weather name, timeOfDay UTC (§3.3).
- **CameraRig** (`src/game/CameraRig.js`): modes cockpit/helmet/chase/
  trackside/replay (cycle order published for HUD); `setComposition(name)`
  (unknown → neutral); FOVs horizontal (§7.6); handles cut history
  invalidation for TAA/motion blur.

### 11.7 render/ and ui/
- **MaterialLibrary** (`src/render/MaterialLibrary.js`): async
  `init(ctx)` staged with frame yields; `get(name)` cached shared material
  (CONTRACT §5); `texture(name, channel 'map'|'normal'|'orm'|'emissive')`
  ('roughness'/'ao' also return the ORM map); `tileSize(name, out = {u,
  v})` metres per tile; `clone(name)` independent copy sharing textures;
  `makeLivery(teamColors)` ({primary, secondary, accent}, the
  base/trim/detail aliases, or a 3-array; cached by colour triple);
  `tyreSidewall(compound = "soft")` per-compound sidewall, built on first
  request and cached (unknown compound → shared `tyre_sidewall`);
  `contactShadow()` ground-quad material (§5.6); `setQuality(tier)`;
  `dispose()`. The tyre patch is the module-private `applyContactPatch
  (material, cosStart, aoFloor, squash = 0.012)` — positional, not exported
  (§5.6). Exports TEAM_LIVERIES, MATERIAL_NAMES, COMPOUND_COLORS.
- **RenderPipeline / SkySystem / SunShadow / CloudLayer /
  AtmosphereShader / VelocityBuffer / shader modules**: see §5 (SunShadow
  §2.5, VelocityBuffer §2.6). Notable API: `SunShadow.update(camera,
  renderer = null)` once per drawn frame BEFORE any shadow rasterisation;
  `setSunDirection(dir)` (dir points toward the sun); `setLight(color,
  intensity)` (the scene's entire direct illuminance); `setShadowsEnabled
  (enabled)`; `setQuality({cascades, shadowMapSize, shadowDistance})`;
  `registerPatch(id, fn)` (id enters the program cache key);
  `syncMaterials(root, forceRecompile)` (walks a subtree: casters get the
  packed-depth material and DoubleSide, every material is patched) plus
  per-material `patchMaterial(material, forceRecompile)`; exported as both
  `SunShadow` and `CascadedShadows`. `VelocityBuffer.registerDynamic(root)`
  (register a moving hierarchy — cars AND the camera; de-duplicated per
  root) / `unregisterDynamic(root)`; `rescan()`; `advanceHistory()` only on
  simulated steps; `render(renderer, scene, camera, quad, drawDynamic)` uses
  the pipeline's shared FullScreenQuad. `RenderPipeline.sceneColorTexture`
  (§5.1). `SkySystem.setWeather({cloudCover, rain, windSpeed, windDir,
  turbidity})` sets the crossfade targets (~2 s; turbidity derived from
  cover/rain when not named); `setLocation({latitude, longitude,
  dayOfYear})`; `setTimeOfDay(hours 0..24 local/UTC §3.3)`; `setExternalOcclusion(value)`
  (clamped 0..1 and multiplied into `sunVisibility`) is fed by the pipeline
  from the 5×5 reduction of the godray occlusion alpha mask, and set to 1
  when shafts are off (§5.2). `sunTransmittance(cosZenith, altitude,
  turbidity, ozone, out)`; `skyRadiance(dir…, sun…, altitude, turbidity,
  ozone, multiScatter, steps, out)` — CPU mirrors of the shader;
  `kelvinToLinearRGB(K, out)`; `sunScreenFade(x, y, behind)`;
  `GODRAY_BLUR_PASSES` (three `{density, weight, decay}`) and
  `shaftChainGain(samples, passes = GODRAY_BLUR_PASSES)` (§5.2);
  `exposureFor(luminance)`; `createGradeUniforms()`;
  `createLensDirtTexture(size, rng)`.
- **Texture builders** (`src/render/textures/*`): every builder returns
  TexData `{width, height, color: Uint8Array RGBA, normal, orm, tileU m,
  tileV m}` — tile sizes in real metres so geometry sets UVs in world
  units. Noise: `Noise(seed)` (perlin/simplex/fbm/ridged + wrapped
  variants; warp/warpWrapped), `WorleyGrid(cells, seed)` (`sample(u, v)` →
  shared scratch {f1, f2, id} — read before the next call), field helpers
  (createField/sampleField/blurField/upsampleField/fbmField/ridgedField/
  normaliseField/normalFromHeight/packORM/aoFromHeight/makeDataTexture/
  mipChain/normalMipChain/applyToksvig/createCanvas/textureFromCanvas/
  readCanvas/canvasToField/yieldFrame). Trackside: CROWD_CELL_W/H (2.10 ×
  1.55 m — Trackside builds billboards at exactly these), FENCE_ALPHA_TEST,
  CANOPY_ALPHA_TEST, CANOPY_ATLAS, DISTANCE_MARKS.
- **UI**: `HUD(ctx)`, `TimingTower(ctx, mount)`, `Minimap(ctx)`,
  `LoadingScreen` (pre-engine, own rAF), `Menu`, `MainMenu`/`RowList`/
  `addSettingsRows`/`el(tag, className, text)`. Behaviour in §7.7.
- **fx**: `EffectsSystem` (registers as `ctx.fx`; `init(ctx)`; public:
  `sparkBurst(x, y, z, nx, ny, nz, energy, groundY)`, `setWetness(w)` /
  `wetness` getter, `setIntensity(value)` — clamped 0..2 and copied to the
  `intensity` field of TyreSmoke, Sparks and Weather. TyreSmoke and Sparks
  scale their emission by it; Weather scales splash spawn rate,
  rooster-tail strength, rain-streak opacity and visor wetness by it — and
  `stats()`);
  `ParticleSystem` (`init(ctx, budget)`: EffectsSystem passes
  `ctx.quality.particleBudget`, default 9000, floored at 400; each pool's
  capacity is a fixed fraction of it and there is no later resize;
  `createPool(name, options)` / `pool(name)` over ParticlePool(name,
  options, shared uniforms, rng)); sprite factories
  create{Smoke,Dust,Streak,Chunk,Droplet,Splash,Flame}Sprite; `Sparks`
  (`burst(...)`), `TyreSmoke` (`update(dt, ctx, fx)` with EffectsSystem's
  per-car state), `Weather` (setWetness), `HeatHaze` (`captureFrame(ctx)`
  blits `ctx.pipeline.sceneColorTexture`; `sceneTexture` getter, null until
  ready and while disabled, feeds the visor film; `sourceCount`) +
  `ScreenCapture` (`capture(renderer, sourceTexture)` quad-blits into a
  HalfFloat target; `ready` after two frames; `texture`); EXHAUST_LOCAL
  car-local exhaust exit; `HAZE_LAYER` (6, main camera only, §2.9).

### 11.8 tools/
- **screenshot.mjs** exports `SCENARIOS`, `frameStats`, `decodePng`; CLI
  §3.1. Flags: `--scenario NAME` (default cockpit-straight) | `--all`;
  `--fast`; `--jobs N` (default 4); `--timeout SEC`; `--width`/`--height`/
  `--quality` (default 1920×1080 ultra); `--url URL` (skips the local
  preview server); `--list`; `--out DIR` (default `shots`, also writes
  `report.json`). Exits non-zero on page error, no __APEX_READY__, timeout,
  or blank/flat frame.
- **verify-gameplay.mjs**: `node tools/verify-gameplay.mjs [simSeconds]`
  (default 420) — §3.4. Prints a JSON report; no pass/fail. Requires a
  built dist/ and the preview server on 4173 (so does the VS Code task).
- **analyse.mjs**: `shadow <png> [--y0 --y1 --bins]`, `stats <pngs...>` —
  §3.6.
- **speckle-oracle.mjs**: `node tools/speckle-oracle.mjs [on|off|gain0 ...]`
  (default: on vs off), §3.7. Needs a built dist/ and starts its own
  preview server on 4189, which it stops (whole process group off Windows)
  before exiting. `APEX_CHROMIUM` sets the browser binary.
- **make-gif.mjs**: `node tools/make-gif.mjs [--shot straight|chase|apex|
  pack|grid] [--frames N] [--fps N] [--width/--height] [--quality]
  [--warmup s] [--out file] [--gif-width px] [--keep]`, §3.8. Needs ffmpeg
  on PATH.
- **probe-shift.mjs / tmp-menucheck.mjs**: one-off Playwright probes
  against the preview server.

---

## 12. Comment-removal pass

The code carries no comments of any kind; this document holds the reasoning.

- The 2026-08-30 strip (esbuild transform, no minify, no name mangling,
  esnext target, + a tokenizer pass for the class-body comments esbuild's
  printer preserves) removed every JS/CSS comment under src/ and
  desktop/main.cjs, and in the tools that line carried (`analyse.mjs`,
  `probe-shift.mjs`, `screenshot.mjs`, `tmp-menucheck.mjs`,
  `verify-gameplay.mjs`). `tools/speckle-oracle.mjs` and
  `tools/make-gif.mjs` came from the other line and were never on it.
- A later pass removed what that strip had kept or never saw: the JS
  comments in `tools/speckle-oracle.mjs` (its JSDoc header and the
  `/* not up yet */` in `waitForServer`; `make-gif.mjs` had none), the
  `/* @__PURE__ */` bundler pragmas (none remain under src/, tools/ or
  desktop/), the GLSL comments inside template-literal shader strings
  (RenderPipeline,
  MotionBlurShader, TonemapShader, VelocityBuffer, GodrayShader, LensShader,
  AtmosphereShader, CloudLayer, CascadedShadows, SkySystem, Weather,
  HeatHaze, ParticleSystem, MaterialLibrary, Trackside), and the HTML
  comment in index.html. The JS comments that the other line still
  carried in the files the merge combined (HeatHaze, Weather,
  RenderPipeline, screenshot.mjs) were dropped while resolving the merge.
  Their knowledge now lives in §2 (including §2.9/§2.10), §3.1–§3.3, §3.7
  (the speckle-oracle header), §5, §6.7, §7.8 and §10. Removing the shader
  comments changed the runtime shader strings, so shader compile-error line
  numbers differ from older builds.
- What remains is not commentary: the `#!/usr/bin/env node` hashbang on
  line 1 of `analyse.mjs`, `make-gif.mjs`, `screenshot.mjs`,
  `speckle-oracle.mjs` and `verify-gameplay.mjs` (an interpreter directive;
  ECMAScript calls it a HashbangComment and acorn reports it through
  `onComment`, so an acorn-based comment check reports these lines), GLSL
  preprocessor directives, and the prose files — docs/, CONTRACT.md,
  README.md — which were never stripped. All the tools are committed as
  mode 100644, so the hashbang does nothing unless the executable bit is
  set: run them with `node tools/<name>.mjs`.
