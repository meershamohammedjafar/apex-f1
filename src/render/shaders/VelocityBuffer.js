import * as THREE from 'three';

/**
 * Screen-space velocity buffer.
 *
 * Two-step construction, which is what shipping engines do because a full second
 * geometry pass just to move pixels is not worth 400 extra draw calls:
 *
 *  1. A fullscreen reprojection pass turns the depth buffer into camera-relative
 *     velocity. That is exact for every pixel whose surface is *static in world space* —
 *     track, barriers, grandstands, sky — for the cost of one quad.
 *  2. Every registered hierarchy that is **not** static in world space is re-drawn on top
 *     with its own previous world matrix, so its velocity is the honest difference
 *     between where it projected last shutter and where it projects now.
 *
 * Step 2 is not an optimisation, it is the correctness half. The reprojection in step 1
 * assumes the surface under a pixel has not moved, and its error grows without bound as
 * the surface approaches the eye: a cockpit rail 0.35 m from the lens, on a camera
 * travelling at 75 m/s, reprojects to roughly 500 px of screen motion over a 25 ms
 * shutter even though it has not moved a millimetre relative to the driver's head. One
 * such pixel is enough to poison a whole 20x20 tile, and the tile filter then drags the
 * background across the cockpit. Anything rigidly carried by the car — the tub, the
 * wheel, the driver's hands, and anything parented straight to the camera — has to come
 * through step 2 or it smears.
 *
 * Camera-attached geometry needs no special case at all. Its world matrix is
 * `cameraWorld * local`, and the view-projection it is measured against is
 * `projection * inverse(cameraWorld)`, so the camera term cancels in both the current and
 * the previous clip position and the difference is exactly zero. It falls out of the
 * general path as long as the general path actually covers it.
 *
 * The dynamic pass has no depth attachment; it decides ownership by comparing its own
 * linear view distance against the scene depth texture. The comparison is two-sided: a
 * fragment owns a pixel only if it *is* the surface the main pass left in the depth
 * buffer. One-sided rejection let geometry the main pass never showed at that pixel stamp
 * its velocity over whatever was really there.
 *
 * Only geometry that writes depth is eligible. A mesh that draws without a depth write —
 * the visor plane 9 cm from the lens, spray, a HUD overlay quad — owns no pixel, and if
 * it were allowed into this pass it would stamp its own velocity across everything behind
 * it. The visor alone would zero the entire buffer.
 *
 * Velocity is stored in **UV units per shutter interval**, unjittered: `curUv - prevUv`,
 * where "prev" is the last state the *simulation* was in — not the last state that
 * happened to be drawn. Each entry therefore carries two matrices: `latched` is where
 * the object was at the most recent simulated frame, `prev` where it was at the one
 * before. Re-presenting a frozen frame reuses the same pair instead of collapsing them
 * onto each other, which is what previously zeroed the whole buffer on any repeated
 * present and left screenshots with no motion blur at all.
 *
 * Instanced meshes carry the same two-stage history for their instance transforms, in a
 * private `apexPrevInstanceMatrix` attribute, so a suspension link that swung between the
 * two shutters is measured against where it actually was rather than against itself.
 *
 * A pose *written* rather than integrated is not motion and must report no velocity at
 * all. `Scenarios.js` places the field by assigning `state.position`/`state.quaternion`
 * directly, and a respawn does the same; the object jumps hundreds of metres between two
 * consecutive world matrices. Differencing that pair yields a screen-space vector orders
 * of magnitude larger than anything the reconstruction filter can represent, it wins
 * every tile it touches and its dilated neighbourhood drags the background across the
 * car. `advanceHistory` therefore classifies each step before it rolls it: a step that is
 * a large multiple of the one before it, or one longer than anything a car could travel
 * in a shutter, or a basis that has swung further in one shutter than any chassis turns
 * in a second, is a teleport. A teleport collapses the history onto the new pose, so that
 * frame reports exactly zero and the next frame measures one honest step from the new
 * place. This is the same class of bug that had a respawn reporting 583 km/h in first
 * gear to the gameplay harness.
 *
 * Instance *rotation* is deliberately dropped once it passes a few degrees per shutter.
 * A linear velocity buffer stores one vector per pixel and the reconstruction filter
 * walks it in a straight line; a wheel rim turning 300 degrees in 25 ms has no straight
 * line to walk, and feeding its true per-vertex displacement in only guarantees that the
 * tile filter smears the tyre and everything within three tiles of it across the frame.
 * Fast rotation is the rotational filter's job — MotionBlurShader sweeps the tyre along
 * its own arc from the hub and the swept angle — so what this pass reports for a spinning
 * instance is its rigid translation, which is the part a straight line can carry.
 */

/** Layer bit used to isolate dynamic geometry for the object velocity pass. */
export const VELOCITY_LAYER = 7;

/** Instanced-history attribute added to tracked InstancedMesh geometry. */
const PREV_INSTANCE_ATTRIBUTE = 'apexPrevInstanceMatrix';

/**
 * cos of the largest per-shutter instance rotation still reported as a rotation. Beyond
 * this the instance keeps its current orientation and only its translation is historic,
 * because a straight streak cannot represent the arc anyway.
 */
const MAX_INSTANCE_SPIN_COS = Math.cos(6 * (Math.PI / 180));

/**
 * Teleport classification, applied to one object's world transform per simulated step.
 *
 * `TELEPORT_STEP_RATIO` is the growth over the previous accepted step that marks a
 * discontinuity. A rigid body under real forces barely changes its per-shutter
 * displacement between two consecutive shutters — 5 g over 33 ms is under two per cent —
 * so the only thing that legitimately scales a step is the shutter interval itself
 * changing, which a frame-rate spike can at worst double or treble. Eight is comfortably
 * clear of that and nowhere near the four-orders-of-magnitude jump a placement makes.
 *
 * `TELEPORT_MIN_METRES` keeps the ratio test off the noise floor: a car pulling away from
 * rest has a previous step of zero, and without a floor every one of those first steps
 * would read as a teleport. Two metres in one shutter is 60 m/s at a 33 ms present and
 * 240 m/s at gameplay rates — no car reaches either from a standstill in one step.
 *
 * `TELEPORT_MAX_METRES` is the unconditional bound: 97 m/s is past the top speed of
 * anything on this circuit and 0.5 s is the longest interval RenderPipeline will accept
 * as a shutter, so nothing that is travelling rather than jumping covers 50 m between two
 * consecutive histories, whatever the frame rate did.
 *
 * `TELEPORT_BASIS_COS` catches a placement that rotates without translating much — a car
 * dropped onto a grid slot facing the other way. Thirty degrees per shutter is 900 deg/s
 * at a 33 ms present; a chassis in a spin turns at a tenth of that.
 */
const TELEPORT_STEP_RATIO = 8;
const TELEPORT_MIN_METRES = 2;
const TELEPORT_MAX_METRES = 50;
const TELEPORT_BASIS_COS = Math.cos(30 * (Math.PI / 180));

/**
 * Largest translation, in the instanced mesh's own local space, that a single instance can
 * make in one shutter and still be motion rather than a rebuild.
 *
 * Instance transforms here are car-local: a wheel travels its suspension stroke, a
 * suspension link swings about its inboard pickup. The fastest of those move at a couple
 * of metres per second, so a shutter is centimetres. A metre means the mesh was re-laid
 * out — a damage part swapped, a link list rebuilt in place — and the difference against
 * the old layout is not a velocity.
 */
const MAX_INSTANCE_STEP_METRES = 1;

const VELOCITY_COMMON = /* glsl */ `
  uniform float uNear;
  uniform float uFar;
  uniform vec2 uResolution;
  uniform float uMaxVelocityPx;

  // Positive view-space distance from a window-space depth sample.
  float apexViewDist(float d) {
    float ndc = d * 2.0 - 1.0;
    return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
  }

  /**
   * Smallest clip-space w this pass will divide by.
   *
   * A perspective w *is* the view distance, so it passes through zero for any surface on
   * the previous eye plane and goes negative behind it. Dividing by it unguarded does not
   * merely produce a large number: the sign flip mirrors the point through the origin, so
   * the reported velocity points the wrong way, and at w near zero it is unbounded — one
   * such pixel becomes the dominant vector of its 20x20 tile, the neighbour dilation
   * spreads it another tile in every direction, and sixty pixels square of frame then
   * gather along a vector that is both enormous and backwards. That is the veiling wash.
   *
   * Flooring w at a small positive number keeps the projection on the correct side and
   * therefore pointing outward, which is what a surface rushing past the lens genuinely
   * does; apexClampVelocity() then gives the result a finite length.
   */
  const float APEX_MIN_CLIP_W = 1e-4;

  vec2 apexProjectUv(vec4 clip) {
    return (clip.xy / max(clip.w, APEX_MIN_CLIP_W)) * 0.5 + 0.5;
  }

  /**
   * Sanity bound on what this buffer is allowed to store.
   *
   * The target is half float, whose largest finite value is 65504; a velocity that
   * overflows it stores as Inf, and Inf wins every comparison in the tile reduction and
   * turns into NaN the moment the blur filter rescales it — one pixel of Inf blackens a
   * whole neighbourhood of the frame and poisons the TAA history that reads the same
   * buffer. Anything non-finite is dropped to zero, and everything else is limited to
   * uMaxVelocityPx, which the CPU side sets to twice the frame diagonal.
   *
   * Twice the diagonal is a bound, not a look: it is long enough that a clamped vector
   * still carries a pixel off the frame in any direction — so a consumer that treats an
   * off-screen reprojection as "no history" still sees one — while being four orders of
   * magnitude below the numbers a divide by a vanishing w produces.
   */
  vec2 apexClampVelocity(vec2 v) {
    // Written as a rejected less-than so that NaN, which compares false against
    // everything, takes this branch instead of slipping through it.
    if (!(abs(v.x) < 1e6) || !(abs(v.y) < 1e6)) return vec2(0.0);
    float lenPx = length(v * uResolution);
    return lenPx > uMaxVelocityPx ? v * (uMaxVelocityPx / lenPx) : v;
  }
`;

const CAMERA_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const CAMERA_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D tDepth;
  uniform mat4 uInvViewProjJittered;
  uniform mat4 uPrevViewProj;
  uniform vec2 uJitterUv;
  varying vec2 vUv;
${VELOCITY_COMMON}
  void main() {
    float d = texture2D(tDepth, vUv).x;

    // The sky has no geometry to reproject; pinning it just short of the far plane
    // gives it pure rotational velocity, which is exactly what a panning camera sees.
    d = min(d, 0.99995);

    vec4 clip = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 world = uInvViewProjJittered * clip;
    world /= world.w;

    vec2 prevUv = apexProjectUv(uPrevViewProj * world);

    gl_FragColor = vec4(apexClampVelocity((vUv - uJitterUv) - prevUv), 0.0, 1.0);
  }
`;

const OBJECT_VERTEX = /* glsl */ `
  uniform mat4 uPrevModelMatrix;
  uniform mat4 uPrevViewProj;
  uniform mat4 uCurViewProj;
  varying vec4 vCurClip;
  varying vec4 vPrevClip;

  #include <common>
  #include <batching_pars_vertex>
  #include <skinning_pars_vertex>
  #include <morphtarget_pars_vertex>

  #ifdef USE_INSTANCING
    attribute mat4 apexPrevInstanceMatrix;
    // 1 when this draw's instance history is live, 0 when it is not — a geometry shared
    // between two instanced meshes can only carry one history, so the meshes that do not
    // own it fall back to their current instance transform, which reports the parent
    // object's rigid motion and nothing finer.
    uniform float uPrevInstanceValid;
  #endif

  void main() {
    #include <batching_vertex>
    #include <skinbase_vertex>
    #include <morphinstance_vertex>
    #include <begin_vertex>
    #include <morphtarget_vertex>
    #include <skinning_vertex>

    vec4 objPos = vec4(transformed, 1.0);
    vec4 prevObjPos = objPos;
    #ifdef USE_BATCHING
      objPos = batchingMatrix * objPos;
      // No previous batching matrix is published by three, so a batched mesh reports the
      // rigid motion of its batch root only. Nothing in this project batches.
      prevObjPos = batchingMatrix * prevObjPos;
    #endif
    #ifdef USE_INSTANCING
      vec4 curInstance = instanceMatrix * prevObjPos;
      vec4 histInstance = apexPrevInstanceMatrix * prevObjPos;
      objPos = instanceMatrix * objPos;
      prevObjPos = mix(curInstance, histInstance, uPrevInstanceValid);
    #endif

    vec4 worldPos = modelMatrix * objPos;
    vCurClip = uCurViewProj * worldPos;
    vPrevClip = uPrevViewProj * (uPrevModelMatrix * prevObjPos);

    // Rasterise with the jittered camera so the manual depth test lines up with the
    // depth buffer produced by the main scene pass.
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const OBJECT_FRAGMENT = /* glsl */ `
  precision highp float;
  uniform sampler2D tDepth;
  varying vec4 vCurClip;
  varying vec4 vPrevClip;
${VELOCITY_COMMON}
  void main() {
    vec2 screenUv = gl_FragCoord.xy / uResolution;
    float sceneZ = apexViewDist(texture2D(tDepth, screenUv).x);
    float fragZ = apexViewDist(gl_FragCoord.z);

    // Ownership test, in place of the depth attachment this target does not carry. The
    // fragment owns the pixel only if it is the surface the main pass left in the depth
    // buffer: too far behind means it is occluded, too far in front means the main pass
    // never drew it there and it has no business writing velocity over what did.
    float tol = max(0.03, sceneZ * 0.02);
    if (abs(fragZ - sceneZ) > tol) discard;

    vec2 cur = apexProjectUv(vCurClip);
    vec2 prev = apexProjectUv(vPrevClip);
    gl_FragColor = vec4(apexClampVelocity(cur - prev), 0.0, 1.0);
  }
`;

/**
 * Roll one instanced mesh's transform history on by a shutter, writing the matrices the
 * shader will use as "previous" into `out` and re-latching `latched` to `current`.
 *
 * Column alignment between the latched and current orientations is the spin test. A
 * suspension link swings a degree or two per shutter and keeps its true previous
 * orientation; a wheel turns most of a revolution, and reporting that as a straight
 * screen-space vector is worse than useless — it becomes the dominant vector for every
 * tile it touches. Those instances keep their current orientation and contribute only
 * the translation they actually made, which is the part a linear streak can carry.
 *
 * Allocation-free: three Float32Arrays in, arithmetic out.
 */
function rollInstanceHistory(out, latched, current) {
  const maxStepSq = MAX_INSTANCE_STEP_METRES * MAX_INSTANCE_STEP_METRES;
  for (let o = 0; o + 15 < out.length; o += 16) {
    // A local translation this large is a re-layout, not a stroke: report the current
    // transform as its own history so the instance contributes no velocity this shutter.
    const tx = current[o + 12] - latched[o + 12];
    const ty = current[o + 13] - latched[o + 13];
    const tz = current[o + 14] - latched[o + 14];
    if (tx * tx + ty * ty + tz * tz > maxStepSq) {
      for (let k = 0; k < 16; k++) out[o + k] = current[o + k];
      continue;
    }

    let aligned = true;
    for (let c = 0; c < 3 && aligned; c++) {
      const i = o + c * 4;
      const ax = latched[i], ay = latched[i + 1], az = latched[i + 2];
      const bx = current[i], by = current[i + 1], bz = current[i + 2];
      const la = Math.sqrt(ax * ax + ay * ay + az * az);
      const lb = Math.sqrt(bx * bx + by * by + bz * bz);
      if (la < 1e-8 || lb < 1e-8) continue;
      aligned = (ax * bx + ay * by + az * bz) / (la * lb) >= MAX_INSTANCE_SPIN_COS;
    }

    if (aligned) {
      for (let k = 0; k < 16; k++) out[o + k] = latched[o + k];
    } else {
      // Current orientation and scale, previous position.
      for (let k = 0; k < 12; k++) out[o + k] = current[o + k];
      out[o + 12] = latched[o + 12];
      out[o + 13] = latched[o + 13];
      out[o + 14] = latched[o + 14];
      out[o + 15] = current[o + 15];
    }
  }
  latched.set(current);
}

/**
 * Scratch for the world matrix a newly found mesh was carrying before its chain was
 * composed. Module scope so that a rescan, which runs inside the render loop, allocates
 * nothing beyond the two matrices each genuinely new entry needs.
 */
const _staleWorld = /* @__PURE__ */ new THREE.Matrix4();

/** Straight-line distance between the origins of two world matrices, in metres. */
function originDistance(a, b) {
  const ea = a.elements;
  const eb = b.elements;
  const dx = ea[12] - eb[12];
  const dy = ea[13] - eb[13];
  const dz = ea[14] - eb[14];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Was this entry's world transform *written* between the last history and this one,
 * rather than integrated towards it?
 *
 * Called once per tracked mesh per simulated step, so it does its own arithmetic on the
 * matrix elements rather than allocating vectors or quaternions. `entry.step` is updated
 * on every call, teleport or not, so a discontinuity suppresses exactly one frame: the
 * step that follows a 340 m placement is measured against that 340 m and passes the ratio
 * test on its own merits, which is what stops one placement from muting a car for two.
 */
function isTeleport(entry, current) {
  const l = entry.latched.elements;
  const c = current.elements;

  const dx = c[12] - l[12];
  const dy = c[13] - l[13];
  const dz = c[14] - l[14];
  const step = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const previous = entry.step;
  entry.step = step;

  if (step > TELEPORT_MAX_METRES) return true;
  if (step > TELEPORT_MIN_METRES && step > previous * TELEPORT_STEP_RATIO) return true;

  // Basis columns carry rotation and scale together; comparing them normalised tests the
  // rotation alone, which is the part that can be discontinuous without the origin moving.
  for (let col = 0; col < 3; col++) {
    const i = col * 4;
    const ax = l[i], ay = l[i + 1], az = l[i + 2];
    const bx = c[i], by = c[i + 1], bz = c[i + 2];
    const la = Math.sqrt(ax * ax + ay * ay + az * az);
    const lb = Math.sqrt(bx * bx + by * by + bz * bz);
    if (la < 1e-8 || lb < 1e-8) continue;
    if ((ax * bx + ay * by + az * bz) / (la * lb) < TELEPORT_BASIS_COS) return true;
  }
  return false;
}

/** True when this mesh contributes to the scene depth buffer, and so owns pixels. */
function writesDepth(object) {
  const material = object.material;
  if (!material) return false;
  if (Array.isArray(material)) {
    for (let i = 0; i < material.length; i++) {
      const m = material[i];
      if (m && m.depthWrite !== false && m.colorWrite !== false) return true;
    }
    return false;
  }
  return material.depthWrite !== false && material.colorWrite !== false;
}

/**
 * Which faces of this mesh can legitimately own a pixel in the velocity buffer.
 *
 * The pass has no depth attachment, so it decides ownership by comparing its own view
 * distance against the scene depth texture — and the only faces that can *match* that
 * texture are the faces the main pass rasterised. A mesh drawn `FrontSide` in the main
 * pass left no depth from its back faces, so every back-face fragment here is shaded
 * only to be discarded, at full frame resolution, for every tracked mesh in the frame.
 * On the tracked set that is the whole car interior wrapped around the lens, which is
 * the most overdrawn geometry in a cockpit shot.
 *
 * Matching the object's own side therefore removes work the ownership test was already
 * throwing away. The one case it changes is a shell thin enough that its hidden face
 * lands inside the depth tolerance of its visible one — and there the two faces are
 * fractions of a millimetre apart on the same rigid body, so the velocity they report
 * is the same value to well past half-float precision.
 *
 * `BackSide` maps to `DoubleSide` rather than to itself on purpose: `side === BackSide`
 * is what sets three's `flipSided` define, so selecting it here would fork the program
 * cache for a term this shader never reads. `DoubleSide` is a superset of the faces that
 * can own a pixel, so it stays correct — it just does not save anything for those meshes.
 */
function cullSide(object) {
  const material = object.material;
  if (!material) return THREE.DoubleSide;
  if (Array.isArray(material)) {
    for (let i = 0; i < material.length; i++) {
      const m = material[i];
      if (!m || m.side !== THREE.FrontSide) return THREE.DoubleSide;
    }
    return THREE.FrontSide;
  }
  return material.side === THREE.FrontSide ? THREE.FrontSide : THREE.DoubleSide;
}

export class VelocityBuffer {
  constructor() {
    this.target = null;
    this.width = 1;
    this.height = 1;

    this._roots = [];
    this._entries = [];
    this._byObject = new Map();

    this.cameraMaterial = new THREE.ShaderMaterial({
      name: 'ApexVelocityCamera',
      uniforms: {
        tDepth: { value: null },
        uInvViewProjJittered: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uJitterUv: { value: new THREE.Vector2() },
        uNear: { value: 0.05 },
        uFar: { value: 12000 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uMaxVelocityPx: { value: 1 },
      },
      vertexShader: CAMERA_VERTEX,
      fragmentShader: CAMERA_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });

    this.objectMaterial = new THREE.ShaderMaterial({
      name: 'ApexVelocityObject',
      uniforms: {
        tDepth: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uPrevModelMatrix: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uCurViewProj: { value: new THREE.Matrix4() },
        uPrevInstanceValid: { value: 0 },
        uNear: { value: 0.05 },
        uFar: { value: 12000 },
        uMaxVelocityPx: { value: 1 },
      },
      vertexShader: OBJECT_VERTEX,
      fragmentShader: OBJECT_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      // Per draw, `onBeforeRender` narrows this to the object's own side. It starts at
      // DoubleSide because that is the safe answer for anything the scan cannot read a
      // side from, and because a single-sided default would leave holes wherever the
      // main scene shows the inside of a shell — which, in a cockpit, is most of what
      // the driver can see. See cullSide().
      side: THREE.DoubleSide,
      fog: false,
      lights: false,
    });

    const uniforms = this.objectMaterial.uniforms;
    const uPrev = uniforms.uPrevModelMatrix;
    const uPrevInstanceValid = uniforms.uPrevInstanceValid;
    const byObject = this._byObject;
    // Uniform push happens per draw call; the renderer calls this immediately before
    // it binds the program, and `uniformsNeedUpdate` forces the re-upload.
    this.objectMaterial.onBeforeRender = (renderer, scene, camera, geometry, object) => {
      const entry = byObject.get(object);
      uPrev.value.copy(entry ? entry.prev : object.matrixWorld);
      uPrevInstanceValid.value = entry !== undefined && entry.prevInstance !== null ? 1 : 0;
      // Read live rather than cached at registration: an LOD swap or a livery rebuild
      // can put a different material on a mesh between two rescans, and three reads
      // `side` out of the material after this hook and before it binds the state.
      this.objectMaterial.side = cullSide(object);
      this.objectMaterial.uniformsNeedUpdate = true;
    };

    this._collectVisitor = (obj) => {
      // Meshes only: the velocity material declares no gl_PointSize, so points and
      // lines would rasterise undefined.
      if (!obj.isMesh) return;
      if (this._byObject.has(obj)) return;
      // A mesh that leaves no depth owns no pixel. Letting one in would stamp its
      // velocity over everything visible behind it.
      if (!writesDepth(obj)) return;

      // `obj.matrixWorld` still holds whatever the last scene update left in it, and the
      // rescan that finds a mesh runs at the top of the frame, before this frame's update.
      // For a mesh that was already in the graph, that stale value is precisely the
      // history this entry wants: where the mesh was one frame ago. For a mesh *built*
      // during this frame — an LOD swap, a damage part, a rebuilt livery — it is the
      // identity its constructor gave it, and taking that as "where it was" reports the
      // entire distance from the world origin to the circuit, several thousand metres of
      // it, as one shutter of motion. That vector owns every tile it touches and washes
      // the mesh and everything around it out until something rolls the history on, which
      // on a re-presented frame never happens. So: compose the chain, keep the cached
      // matrix as history only when it is near enough to be one shutter of travel, and
      // otherwise start the entry from rest. The scene's own update recomputes the same
      // world matrix moments later, so the extra compose costs one multiply per new mesh.
      _staleWorld.copy(obj.matrixWorld);
      obj.updateWorldMatrix(true, false);
      const historic = originDistance(_staleWorld, obj.matrixWorld) <= TELEPORT_MAX_METRES
        ? _staleWorld
        : obj.matrixWorld;

      const entry = {
        object: obj,
        prev: new THREE.Matrix4().copy(historic),
        latched: new THREE.Matrix4().copy(obj.matrixWorld),
        // Length of the last accepted world-space step, metres. Zero here means the first
        // step this entry takes is measured against no history at all and is treated as a
        // placement — which is exactly what it is, whatever put the mesh in the scene.
        step: 0,
        prevInstance: null,
        latchedInstance: null,
      };

      // The attribute is attached here and left attached. three uploads a geometry's
      // attribute buffers once per frame, during the main scene pass, from whatever is
      // in `geometry.attributes` at that moment — an attribute swapped in later, at draw
      // time, has no buffer yet and binds as zero. A geometry already carrying a history
      // belongs to another mesh; that mesh keeps it and this one falls back.
      const geometry = obj.geometry;
      if (obj.isInstancedMesh && obj.instanceMatrix && geometry
          && geometry.getAttribute(PREV_INSTANCE_ATTRIBUTE) === undefined) {
        const source = obj.instanceMatrix.array;
        const attribute = new THREE.InstancedBufferAttribute(new Float32Array(source), 16);
        attribute.name = PREV_INSTANCE_ATTRIBUTE;
        attribute.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute(PREV_INSTANCE_ATTRIBUTE, attribute);
        entry.prevInstance = attribute;
        entry.latchedInstance = new Float32Array(source);
      }

      this._byObject.set(obj, entry);
      this._entries.push(entry);
      obj.layers.enable(VELOCITY_LAYER);
    };
  }

  init(width, height) {
    this.setSize(width, height);
  }

  setSize(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (this.target && this.width === w && this.height === h) return;
    this.width = w;
    this.height = h;

    if (this.target) this.target.dispose();
    this.target = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.target.texture.name = 'ApexVelocity';
    // Twice the frame diagonal: long enough that a clamped vector still reprojects clear
    // of the frame in any direction, short enough to keep a vanishing clip w out of
    // half-float overflow. See apexClampVelocity.
    const maxVelocityPx = 2 * Math.sqrt(w * w + h * h);
    this.objectMaterial.uniforms.uResolution.value.set(w, h);
    this.objectMaterial.uniforms.uMaxVelocityPx.value = maxVelocityPx;
    this.cameraMaterial.uniforms.uResolution.value.set(w, h);
    this.cameraMaterial.uniforms.uMaxVelocityPx.value = maxVelocityPx;
  }

  get texture() {
    return this.target ? this.target.texture : null;
  }

  /**
   * Track a hierarchy whose transform changes between frames.
   *
   * That means the cars, and it means the camera: anything parented to the camera moves
   * through the world with it, so the fullscreen reprojection is wrong for those pixels
   * even though the result it should produce is zero. Registering the same subtree twice
   * — the camera is usually a descendant of the player's car — is harmless, meshes are
   * de-duplicated by identity.
   */
  registerDynamic(root) {
    if (!root || this._roots.indexOf(root) >= 0) return;
    this._roots.push(root);
    root.traverse(this._collectVisitor);
  }

  unregisterDynamic(root) {
    const i = this._roots.indexOf(root);
    if (i < 0) return;
    this._roots.splice(i, 1);
    root.traverse((obj) => {
      const entry = this._byObject.get(obj);
      if (!entry) return;
      this._byObject.delete(obj);
      const j = this._entries.indexOf(entry);
      if (j >= 0) this._entries.splice(j, 1);
      this._detachInstanceHistory(entry);
      obj.layers.disable(VELOCITY_LAYER);
    });
  }

  /** Re-scan registered roots for meshes added after registration (LOD swaps, damage parts). */
  rescan() {
    for (let i = 0; i < this._roots.length; i++) this._roots[i].traverse(this._collectVisitor);
  }

  setCameraPlanes(near, far) {
    this.cameraMaterial.uniforms.uNear.value = near;
    this.cameraMaterial.uniforms.uFar.value = far;
    this.objectMaterial.uniforms.uNear.value = near;
    this.objectMaterial.uniforms.uFar.value = far;
  }

  setMatrices(invViewProjJittered, prevViewProj, curViewProj, jitterUvX, jitterUvY) {
    const cam = this.cameraMaterial.uniforms;
    cam.uInvViewProjJittered.value.copy(invViewProjJittered);
    cam.uPrevViewProj.value.copy(prevViewProj);
    cam.uJitterUv.value.set(jitterUvX, jitterUvY);

    const obj = this.objectMaterial.uniforms;
    obj.uPrevViewProj.value.copy(prevViewProj);
    obj.uCurViewProj.value.copy(curViewProj);
  }

  setDepthTexture(depthTexture) {
    this.cameraMaterial.uniforms.tDepth.value = depthTexture;
    this.objectMaterial.uniforms.tDepth.value = depthTexture;
  }

  /**
   * Fill the buffer. `quad` is the pipeline's shared FullScreenQuad so we never
   * allocate a second one.
   */
  render(renderer, scene, camera, quad, drawDynamic) {
    renderer.setRenderTarget(this.target);

    quad.material = this.cameraMaterial;
    quad.render(renderer);

    if (!drawDynamic || this._entries.length === 0) return;

    const prevOverride = scene.overrideMaterial;
    const prevBackground = scene.background;
    const prevMask = camera.layers.mask;
    const prevAutoClear = renderer.autoClear;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevShadowNeeds = renderer.shadowMap.needsUpdate;

    scene.overrideMaterial = this.objectMaterial;
    scene.background = null;
    camera.layers.disableAll();
    camera.layers.enable(VELOCITY_LAYER);
    renderer.autoClear = false;
    // Shadow maps were already resolved by the main scene pass this frame.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;

    renderer.render(scene, camera);

    renderer.shadowMap.needsUpdate = prevShadowNeeds;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.autoClear = prevAutoClear;
    camera.layers.mask = prevMask;
    scene.background = prevBackground;
    scene.overrideMaterial = prevOverride;
  }

  /**
   * Roll the per-object history on one simulated step. Call this after the scene's world
   * matrices are up to date and before `render`, and only on frames where the simulation
   * actually advanced — a re-presented frame must keep the interval it already has.
   */
  advanceHistory() {
    const entries = this._entries;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const world = entry.object.matrixWorld;
      // A pose written straight into the object is a teleport, and a teleport is not a
      // velocity. Collapsing both histories onto the new pose makes this frame report
      // exactly zero for every pixel the object owns; the next frame measures one honest
      // step from where it now is.
      const teleported = isTeleport(entry, world);
      entry.prev.copy(teleported ? world : entry.latched);
      entry.latched.copy(world);

      const prevInstance = entry.prevInstance;
      if (prevInstance === null) continue;
      const source = entry.object.instanceMatrix;
      // An InstancedMesh can be re-allocated (a livery rebuild, a count change); fall
      // back to the current transforms rather than reading past the end of the array.
      if (!source || source.array.length !== entry.latchedInstance.length) {
        this._detachInstanceHistory(entry);
        continue;
      }
      if (teleported) {
        // The instance transforms are read against `prev`, which now holds the object's
        // current world matrix. Anything but the current instance transforms here would
        // reintroduce, per instance, the velocity the collapse above just removed.
        prevInstance.array.set(source.array);
        entry.latchedInstance.set(source.array);
      } else {
        rollInstanceHistory(prevInstance.array, entry.latchedInstance, source.array);
      }
      prevInstance.needsUpdate = true;
    }
  }

  _detachInstanceHistory(entry) {
    if (entry.prevInstance === null) return;
    const geometry = entry.object.geometry;
    if (geometry && geometry.getAttribute(PREV_INSTANCE_ATTRIBUTE) === entry.prevInstance) {
      geometry.deleteAttribute(PREV_INSTANCE_ATTRIBUTE);
    }
    entry.prevInstance = null;
    entry.latchedInstance = null;
  }

  dispose() {
    for (let i = 0; i < this._entries.length; i++) {
      const entry = this._entries[i];
      this._detachInstanceHistory(entry);
      entry.object.layers.disable(VELOCITY_LAYER);
    }
    this._entries.length = 0;
    this._roots.length = 0;
    this._byObject.clear();
    this.objectMaterial.onBeforeRender = () => {};
    this.cameraMaterial.dispose();
    this.objectMaterial.dispose();
    if (this.target) this.target.dispose();
    this.target = null;
  }
}
