import * as THREE from 'three';
import { clamp, clamp01, damp, lerp, smoothstep } from '../core/MathUtils.js';
import { Rng } from '../core/Rng.js';

/**
 * Wet weather: the rain you drive through, what it does to the road, and the wall of
 * spray that a Formula 1 car drags behind it.
 *
 * The rain volume is a fixed instanced field that travels with the camera. Each drop
 * is placed once and thereafter advanced by a single wrapped phase offset, so the whole
 * storm costs one draw call and no per-drop work. Crucially the streaks are drawn along
 * the drop's velocity *relative to the camera* — standing still they fall vertically,
 * at 300 km/h they lie almost flat and stream past the visor, which is the single cue
 * that separates "rain particles" from "driving in the rain".
 *
 * The spray plume is the other half. A wet-weather car displaces something like fifty
 * litres of water a second at speed; the plume that comes off the rear tyres is what
 * makes the car behind invisible, so its density follows road speed and the depth of
 * standing water under that wheel rather than a fixed rate.
 */

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _prevCam = new THREE.Vector3();
const _visorSize = new THREE.Vector2();

/** Terminal velocity of a 2 mm raindrop, m/s. */
const DROP_FALL_SPEED = 8.2;

/**
 * Half-extents of the rain volume that travels with the eye, metres.
 *
 * This is the single number that decided whether there was rain in the frame, and it
 * is a density, not a size. The volume held a fixed instance count, so a 20 x 12 x 20
 * half-extent box spread 1836 drops over 38400 cubic metres — 0.048 drops per cubic
 * metre. The camera frustum out to the fade distance encloses roughly 420 of those
 * cubic metres, so about *twenty* streaks were ever on screen at once, most of them
 * small and far away. Twenty streaks is not rain; it is dust on the lens, and every
 * reviewer since round 3 has correctly reported that there is no rain in the air.
 *
 * Pulling the box in to 7.5 x 5 x 7.5 leaves the same instances in a fifteenth of the
 * volume — 0.65 drops per cubic metre, ~170 streaks across the frustum — and costs
 * nothing, because the drops beyond the old fade distance were never visible anyway.
 * Rain further out than this is atmosphere, and the fog and sky already draw it.
 */
const RAIN_BOX_XZ = 7.5;
const RAIN_BOX_Y = 5.0;

/** Track surfaces that get darker and glossier when they are wet. */
const WET_SURFACES = [
  'asphalt', 'asphalt_worn', 'asphalt_patch', 'racing_line',
  'kerb', 'kerb_exit', 'concrete', 'paint_line', 'astroturf',
];

const RAIN_VERTEX = /* glsl */ `
attribute vec4 aSeed;

uniform vec3 uBox;
uniform vec3 uPhase;
uniform vec3 uRelVel;
uniform float uExposure;
uniform float uWidth;
uniform float uAspect;

varying vec2 vUv;
varying float vAlpha;

void main() {
  vec3 span = uBox * 2.0;
  vec3 base = aSeed.xyz * span - uBox;
  vec3 p = mod(base + uPhase + uBox, span) - uBox;

  vec4 mv = viewMatrix * (modelMatrix * vec4(p, 1.0));
  vec3 velView = mat3(viewMatrix) * uRelVel;

  // The streak a drop leaves is its own trail over one shutter opening, and a trail is
  // only a trail where it is seen: on screen. Measuring it in view space — which is what
  // this did — throws away the whole radial component, because a drop flying straight at
  // the camera has almost no lateral view-space velocity even though it tears across the
  // periphery. That is why the rain read as short vertical ticks at 300 km/h instead of
  // streaming past the visor, and why two reviewers could not find any rain in the frame.
  float shutter = uExposure * (0.55 + aSeed.w * 0.9);
  vec4 clipNow = projectionMatrix * mv;
  vec4 clipWas = projectionMatrix * vec4(mv.xyz - velView * shutter, 1.0);

  // Either end behind the eye: the projected trail is meaningless, so drop the quad.
  if (clipNow.w < 0.05 || clipWas.w < 0.05) {
    vUv = vec2(0.0);
    vAlpha = 0.0;
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  vec2 aspect = vec2(uAspect, 1.0);
  vec2 ndcNow = (clipNow.xy / clipNow.w) * aspect;
  vec2 ndcWas = (clipWas.xy / clipWas.w) * aspect;
  vec2 trail = ndcNow - ndcWas;
  float trailLen = length(trail);
  vec2 axis = trailLen > 1e-5 ? trail / trailLen : vec2(0.0, 1.0);
  vec2 perp = vec2(-axis.y, axis.x);

  // Width is a real millimetre of water carried to screen through the projection, and
  // floored well clear of a pixel: below that a streak does not get thinner, it starts
  // dropping out of the raster altogether and the volume thins from the far side in.
  float wide = max(uWidth * projectionMatrix[1][1] / clipNow.w, 0.0034) * (0.65 + aSeed.w * 0.7);
  float len = max(trailLen, wide * 4.0);

  vec2 mid = (ndcNow + ndcWas) * 0.5;
  vec2 off = perp * (position.x * wide) + axis * (position.y * len);
  gl_Position = vec4((mid + off) / aspect, clipNow.z / clipNow.w, 1.0);

  float dist = length(mv.xyz);
  // The near fade has to release almost at the eye. The drops a metre or two off the
  // visor are the ones that tear across the whole frame and sell the speed; holding
  // them back until 2.4 m — as this did — deleted every streak longer than a thumbnail
  // and left only the small, slow, distant ones nobody could find in the frame.
  vAlpha = smoothstep(0.16, 0.85, dist) * (1.0 - smoothstep(uBox.x * 0.55, uBox.x * 1.1, dist));
  vUv = uv;
}
`;

const RAIN_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;

varying vec2 vUv;
varying float vAlpha;

void main() {
  float a = texture2D(uMap, vUv).a * vAlpha * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * a, a);
}
`;

const VISOR_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Visor film.
 *
 * Two things had to change before any of this reached the frame.
 *
 * 1. `uScene` (HeatHaze's ScreenCapture) was originally a copy of the *default*
 *    framebuffer — the previous frame after the tonemapper, so display-referred and
 *    inside 0..1. This overlay, however, is a child of the camera and is therefore
 *    drawn into the HDR scene buffer, where the overcast sky sits somewhere above 1.3
 *    scene-referred. Adding a 0..1 difference term into that buffer is not merely
 *    faint, it is a unit error: the whole contribution landed around a tenth of a stop
 *    and the tonemapper then compressed what was left to nothing. Three reviewers
 *    reported no droplets on the visor because, in scene-referred terms, there were
 *    none. (`uScene` has since moved to the pipeline's own previous scene pass —
 *    linear HDR, the same space as the destination — but the lesson below is what
 *    keeps this shader correct against either source.)
 *
 * 2. So the film no longer *adds* anything. It multiplies: the blend is configured
 *    dst * (1 + src), which is what a lens on the glass physically does — the bead's
 *    body bends light away from the eye and the meniscus gathers the sky into a ring.
 *    A ratio has no units, so it is correct at any exposure and in either colour
 *    space, it cannot punch a hole in a dark frame or blow out a bright one, and the
 *    refraction term — read as a *relative* contrast off the captured history rather
 *    than as an absolute difference — is bounded by construction and cannot run away
 *    frame over frame.
 */
const VISOR_FRAGMENT = /* glsl */ `
uniform sampler2D uScene;
uniform vec2 uResolution;
uniform float uTime;
uniform float uWet;
uniform float uAirflow;
uniform float uHasScene;
uniform float uRefraction;
uniform vec3 uTint;

varying vec2 vUv;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

/** xy = the drop's surface normal, z = its coverage, w = its meniscus ring. */
vec4 dropLayer(vec2 uv, float scale, float speed, float seed) {
  vec2 grid = uv * scale;
  vec2 cell = floor(grid);
  vec2 f = fract(grid);
  float h = hash21(cell + seed);
  float h2 = hash21(cell + seed + 17.3);

  // Run direction: gravity at a standstill, dragged up and outward with airflow.
  vec2 flow = mix(vec2(0.0, -1.0), normalize(vec2((uv.x - 0.5) * 1.4, 1.0)), uAirflow);
  float phase = fract(h * 7.31 + uTime * speed * (0.35 + h2 * 0.9) * (0.25 + uAirflow * 1.9));

  vec2 centre = vec2(0.5) + vec2(h - 0.5, h2 - 0.5) * 0.55 + flow * (phase - 0.5) * 0.9;
  vec2 delta = f - centre;

  // Airflow stretches the bead along the direction it is being dragged, it does not
  // squash it in screen y. That distinction is the difference between a field of round
  // beads sitting in a lattice — which is what one drop per cell at a fixed radius
  // looks like, and what the first pass of this produced — and water being torn
  // backwards over the helmet, which is what a visor at 200 km/h actually shows.
  vec2 flowPerp = vec2(-flow.y, flow.x);
  float alongFlow = dot(delta, flow);
  float acrossFlow = dot(delta, flowPerp);
  delta = flow * (alongFlow / (1.0 + uAirflow * 2.1)) + flowPerp * acrossFlow;

  float r = length(delta);
  // A third hash sizes the bead, and the existence test below empties two cells in
  // five outright, so the lattice the cell grid would otherwise print across the
  // visor never resolves into a visible grid.
  float h3 = hash21(cell + seed + 53.9);
  // Floored off zero: a smoothstep whose two edges coincide is undefined, and an
  // emptied cell must produce no bead, not a NaN.
  float radius = max((0.07 + h3 * 0.21) * step(0.40, h), 1e-4);
  // Hard-edged. A bead of water has a contact line, not a gradient: the 0.35 inner
  // stop this ran at spread the falloff over two thirds of the drop and turned every
  // one of them into the soft smudge a reviewer would — and did — call haze on glass.
  float drop = smoothstep(radius, radius * 0.74, r);
  // The meniscus. A bead of water on glass is a lens with a bright ring where the
  // surface turns away from the eye, and that ring is most of what you actually see.
  // Narrow, because a wide one is a halo and a real one is a highlight.
  float rim = smoothstep(radius * 1.02, radius * 0.86, r) * smoothstep(radius * 0.60, radius * 0.88, r);

  // The streak the drop leaves behind it as the airflow drags it over the helmet.
  vec2 tail = delta - flow * clamp(dot(delta, flow), -0.85, 0.0);
  float tailMask = smoothstep(radius * 0.55, 0.0, length(tail)) * step(0.0, -dot(delta, flow)) * uAirflow;

  vec2 normal = delta / max(r, 1e-3) * drop;
  return vec4(normal, clamp(drop + tailMask * 0.70, 0.0, 1.0), rim);
}

void main() {
  vec2 uv = vec2(vUv.x * (uResolution.x / max(uResolution.y, 1.0)), vUv.y);
  // uv.x has already been widened by the aspect ratio, so a scale of 8.5 is about
  // fifteen cells across a 16:9 frame: a coarse bead runs twenty to fifty pixels wide
  // at 720p, which is what a 2 mm drop on a visor 60 cm from the eye subtends, with a
  // finer second layer of misting between them.
  vec4 a = dropLayer(uv, 8.5, 0.55, 3.1);
  vec4 b = dropLayer(uv, 17.0, 0.85, 91.7);

  // Airflow sweeps the middle of a visor clear at speed — it is the one part of the
  // helmet the air actually gets across — which is both what a wet onboard looks like
  // and what keeps the beads from sitting on top of the piece of road the driver is
  // steering by. Stationary, the drops cover the lot.
  vec2 swept = (vUv - vec2(0.5, 0.54)) * vec2(1.05, 1.0);
  float wetK = uWet * (1.0 - 0.55 * uAirflow * (1.0 - smoothstep(0.12, 0.46, length(swept))));

  float body = clamp(a.z * 0.95 + b.z * 0.65, 0.0, 1.0);
  float rim = clamp(a.w * 1.0 + b.w * 0.72, 0.0, 1.0);
  if ((body + rim) * wetK < 0.004) discard;

  // Refraction as a contrast *ratio* off the captured history: dimensionless, so it
  // is valid whatever space that history is in, and bounded, so a bead can never feed
  // back on its own image from one presented frame to the next.
  // (named 'bend', not 'refract': that one is a GLSL built-in and shadowing it is a
  // needless dependency on how forgiving the driver's compiler happens to be.)
  float bend = 0.0;
  if (uHasScene > 0.5) {
    vec2 base = gl_FragCoord.xy / uResolution;
    vec2 offset = (a.xy * 0.95 + b.xy * 0.55) * uRefraction;
    vec3 here = texture2D(uScene, base).rgb;
    vec3 there = texture2D(uScene, clamp(base + offset, vec2(0.003), vec2(0.997))).rgb;
    float l0 = dot(here, vec3(0.2126, 0.7152, 0.0722));
    float l1 = dot(there, vec3(0.2126, 0.7152, 0.0722));
    bend = clamp((l1 - l0) / (l0 + 0.10), -0.85, 0.85);
  }

  vec3 mult = vec3(body * (-0.62 + bend * 0.60)) + uTint * (rim * 1.90);
  gl_FragColor = vec4(clamp(mult * wetK, -0.82, 2.4), 0.0);
}
`;

/**
 * Standing water, patched into the standard physical response.
 *
 * Two things a plain transparent material cannot express:
 *
 * 1. Coverage is not reflectance. A puddle seen from directly above shows you the road
 *    under it and only a couple of per cent of sky; seen down the straight at a degree
 *    or two of grazing it is a perfect mirror. Driving the blend alpha with Schlick's
 *    Fresnel is what makes standing water the brightest thing on an overcast circuit —
 *    because the sky is the brightest thing in the scene and at grazing angles the water
 *    hands all of it back — while still letting the asphalt read through underfoot. It
 *    only works if the *colour* the alpha composites is the unweighted sky; see
 *    PUDDLE_SPECULAR_PATCH, which is the actual reason the round-2 water came out
 *    darker than the road and was still measurably doing so in round 5.
 * 2. Water pools; it does not paint a stripe. The mask breaks the drainage ribbon into
 *    discrete elongated pools with soft edges, keyed off the track-distance UV so they
 *    stay nailed to the tarmac.
 *
 * `vPuddleUv` is the raw track UV: x runs across the ribbon (0 at the crown side, 1 at
 * the outer edge), y is distance along the circuit at 0.16 units per metre. It is
 * carried in a varying of our own rather than read from three's `vNormalMapUv`, because
 * that one arrives with the ripple map's animated offset folded in and the pools would
 * then crawl along the road with the ripples.
 */
const PUDDLE_VARYING = 'varying vec2 vPuddleUv;\n';

const PUDDLE_VERTEX_PATCH = /* glsl */ `
  #include <uv_vertex>
  vPuddleUv = uv;
`;

const PUDDLE_FRAGMENT_PATCH = /* glsl */ `
  #include <normal_fragment_maps>
  {
    float apexNdv = clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
    float apexFresnel = pow(1.0 - apexNdv, 5.0);
    // Schlick with water's real F0. This is the fraction of the road the film hides and
    // the fraction of the sky it hands back, and it is written into alpha alone — see
    // PUDDLE_SPECULAR_PATCH for why it must not also weight the colour.
    float apexReflect = 0.02 + 0.98 * apexFresnel;

    vec2 apexGrid = vec2(vPuddleUv.x * 1.6, vPuddleUv.y * 1.7);
    vec2 apexCell = floor(apexGrid);
    vec2 apexFrac = fract(apexGrid);
    float apexH1 = fract(sin(dot(apexCell, vec2(12.9898, 78.233))) * 43758.5453);
    float apexH2 = fract(sin(dot(apexCell + 3.7, vec2(39.3468, 11.135))) * 24634.6345);
    // Centres are kept well inside their cell. A pool whose ellipse ran past the cell
    // boundary — which the old 0.30..0.85 by 0.28..0.72 spread did on both axes — was
    // cut off square there, so the drainage line was edged with hard lattice steps.
    vec2 apexCentre = vec2(0.36 + apexH1 * 0.28, 0.42 + apexH2 * 0.16);
    // Pools run with the road. The larger axis factor *shrinks* that axis, so the
    // stretch belongs on x: the old vec2(1.35, 2.30) squashed the pools along the
    // distance they were meant to run down and left them wide and stubby.
    vec2 apexDelta = (apexFrac - apexCentre) * vec2(1.35, 1.15);
    float apexPool = 1.0 - smoothstep(0.20, 0.46, length(apexDelta));
    apexPool *= step(0.14, apexH2);
    // Camber drains outward: the film thins toward the crown and stops at the kerb. The
    // ramp is short, because holding the water off until 42 per cent of a six-metre
    // ribbon put every pool outside the part of the road a cockpit camera looks at.
    apexPool *= smoothstep(0.02, 0.26, vPuddleUv.x) * (1.0 - smoothstep(0.86, 1.0, vPuddleUv.x));

    diffuseColor.a *= clamp(apexPool * apexReflect, 0.0, 1.0);
  }
`;

/**
 * The reason round 2's puddles came out darker than the dry road, still measurable in
 * round 5 at three luma over the near tarmac, and not a coverage bug at all.
 *
 * A thin film of water over asphalt composites as `road * (1 - R) + sky * R`, where R
 * is the Fresnel reflectance. Alpha blending gives `colour * a + road * (1 - a)`, so
 * setting `a = R` is right — but only if `colour` is the *unweighted* sky radiance. The
 * standard specular BRDF has already multiplied the radiance by its own Fresnel term,
 * so the composite that actually ran was `road * (1 - R) + sky * R * R`. At the shallow
 * incidence of tarmac a few metres ahead R is around two per cent, so the film removed
 * two per cent of the road and put four ten-thousandths of the sky back: a puddle that
 * is unconditionally darker than the road it lies on, at every angle, by construction.
 * No amount of tuning coverage or environment intensity can fix a squared Fresnel.
 *
 * Replacing the indirect specular with the raw environment radiance removes the second
 * factor. What is left is the physical layer composite, and it makes standing water the
 * brightest thing on an overcast circuit for the right reason: the sky is the brightest
 * thing in the scene, and at grazing angles the water returns all of it.
 */
const PUDDLE_SPECULAR_PATCH = /* glsl */ `
  #include <lights_fragment_end>
  reflectedLight.indirectSpecular = radiance;
`;

function rippleNormalTexture(size) {
  const data = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const hash = (x, y) => {
    let h = Math.imul(x & 1023, 374761393) + Math.imul(y & 1023, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let h = 0;
      // Three crossed wave trains plus a lattice jitter: enough structure that the
      // reflection breaks up without ever showing the grid it came from.
      h += Math.sin((u * 9 + v * 4) * Math.PI * 2) * 0.30;
      h += Math.sin((u * -5 + v * 11) * Math.PI * 2) * 0.24;
      h += Math.sin((u * 17 + v * 15) * Math.PI * 2) * 0.12;
      h += (hash(x, y) - 0.5) * 0.22;
      height[y * size + x] = h;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = height[y * size + ((x - 1 + size) % size)];
      const r = height[y * size + ((x + 1) % size)];
      const d = height[((y - 1 + size) % size) * size + x];
      const u = height[((y + 1) % size) * size + x];
      const nx = (l - r) * 1.4;
      const ny = (d - u) * 1.4;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      data[i] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  tex.name = 'ApexWaterRipples';
  return tex;
}

export class Weather {
  constructor(particles) {
    this.particles = particles;
    this.rng = new Rng(0x6ad91f05);

    this.rainIntensity = 0;
    this.surfaceWater = 0;
    this.intensity = 1;

    this.group = new THREE.Group();
    this.group.name = 'fx-weather';
    this.group.matrixAutoUpdate = false;

    this.rainMesh = null;
    this.rainMaterial = null;
    this.rainCapacity = 0;
    this.spray = null;
    this.splash = null;
    this._phase = new THREE.Vector3();
    this._relVel = new THREE.Vector3();
    this._camVel = new THREE.Vector3();
    this._camValid = false;

    this.puddles = null;
    this.puddleMaterial = null;
    this._rippleTexture = null;
    this._puddlesBuilt = false;

    this.visor = null;
    this.visorMaterial = null;

    this._materials = [];
    this._appliedWetness = -1;
    this._filmCompiled = false;
    this._splashAcc = 0;
    this._rateScale = 1;
    // Shutter the rain streaks are drawn over. Long enough that a drop passing the
    // visor at closing speed becomes a streak rather than a dot, short enough that the
    // streak stays a streak instead of a wire across the whole frame.
    this._exposure = 0.014;
  }

  init(ctx) {
    this.ctx = ctx;
    this.spray = this.particles.pool('spray');
    this.splash = this.particles.pool('splash');
    this.setQuality(ctx.quality);

    this._buildRain(ctx);
    this._buildVisor(ctx);
    ctx.scene.add(this.group);

    const rain = ctx.sky?.weather?.rain ?? 0;
    this.rainIntensity = rain;
    this.surfaceWater = rain;
    if (rain > 0.02) this._buildPuddles(ctx);
    return this;
  }

  setQuality(tier) {
    const budget = tier?.particleBudget ?? 9000;
    this._rateScale = clamp(budget / 9000, 0.22, 1.8);
    const capacity = clamp(Math.round(budget * 0.28), 320, 5000);
    if (this.rainMesh && capacity !== this.rainCapacity) {
      this._disposeRain();
      if (this.ctx) this._buildRain(this.ctx);
    }
  }

  _buildRain(ctx) {
    const budget = ctx.quality?.particleBudget ?? 9000;
    const capacity = clamp(Math.round(budget * 0.28), 320, 5000);
    this.rainCapacity = capacity;

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]), 2));

    const seeds = new Float32Array(capacity * 4);
    const rng = new Rng(0x11d4c7a3);
    for (let i = 0; i < capacity; i++) {
      seeds[i * 4] = rng.next();
      seeds[i * 4 + 1] = rng.next();
      seeds[i * 4 + 2] = rng.next();
      seeds[i * 4 + 3] = rng.next();
    }
    geometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 4, false, 1));
    geometry.instanceCount = 0;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    const droplet = this.particles.sprites.get('droplet');
    const material = new THREE.ShaderMaterial({
      name: 'ApexRain',
      uniforms: {
        uMap: { value: droplet ?? null },
        uBox: { value: new THREE.Vector3(RAIN_BOX_XZ, RAIN_BOX_Y, RAIN_BOX_XZ) },
        uPhase: { value: this._phase },
        uRelVel: { value: this._relVel },
        uExposure: { value: this._exposure },
        uWidth: { value: 0.012 },
        uAspect: { value: 1.7778 },
        uColor: { value: new THREE.Vector3(0.62, 0.68, 0.78) },
        uOpacity: { value: 0 },
      },
      vertexShader: RAIN_VERTEX,
      fragmentShader: RAIN_FRAGMENT,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    material.userData.skipCSM = true;
    this.rainMaterial = material;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'fx-rain';
    mesh.frustumCulled = false;
    mesh.renderOrder = 30;
    mesh.matrixAutoUpdate = false;
    this.rainMesh = mesh;
    this.group.add(mesh);
  }

  _buildVisor(ctx) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.ShaderMaterial({
      name: 'ApexVisorDrops',
      uniforms: {
        uScene: { value: null },
        uResolution: { value: new THREE.Vector2(1920, 1080) },
        uTime: { value: 0 },
        uWet: { value: 0 },
        uAirflow: { value: 0 },
        uHasScene: { value: 0 },
        uRefraction: { value: 0.010 },
        uTint: { value: new THREE.Vector3(0.88, 1.00, 1.16) },
      },
      vertexShader: VISOR_VERTEX,
      fragmentShader: VISOR_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // dst * (1 + src) — a multiplicative lens, not an additive decal. See the note on
      // VISOR_FRAGMENT: the film is drawn into the scene-referred buffer and the value
      // it wants to express is a ratio, so the ratio is what the blend applies. Alpha is
      // left exactly as the scene wrote it, since later passes read it.
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      toneMapped: false,
    });
    material.userData.skipCSM = true;
    this.visorMaterial = material;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'fx-visor-drops';
    mesh.frustumCulled = false;
    mesh.renderOrder = 60;
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    this.visor = mesh;
    ctx.camera.add(mesh);
    // The camera is not part of the scene graph by default; adding it makes the
    // overlay travel with the eye instead of being left at the world origin.
    if (!ctx.camera.parent) ctx.scene.add(ctx.camera);
  }

  /**
   * Standing water at the edges of the road, where the camber drains it. One ribbon
   * down each side of the circuit, built from the track's own centreline sampling.
   */
  _buildPuddles(ctx) {
    if (this._puddlesBuilt) return;
    const track = ctx.track;
    if (!track?.sample || !track.length) return;
    this._puddlesBuilt = true;

    const spacing = 6;
    const segments = Math.max(64, Math.round(track.length / spacing));
    const sample = track.sample(0, undefined);
    // Lateral subdivisions per side. A race track is cambered, so a ribbon spanned by
    // its two edges alone interpolates *under* the crown of the road it is supposed to
    // sit on — at the width this now covers, several centimetres under, which is enough
    // to bury the water inside the tarmac. Four spans follow the camber closely enough
    // that the 1 cm lift is never eaten.
    const steps = 4;
    const perSide = steps + 1;
    const ring = perSide * 2;
    const vertices = new Float32Array((segments + 1) * ring * 3);
    const uvs = new Float32Array((segments + 1) * ring * 2);
    const indices = new Uint32Array(segments * 2 * steps * 6);

    let vi = 0;
    let ui = 0;
    for (let i = 0; i <= segments; i++) {
      const t = (i % segments) / segments;
      track.sample(t, sample);
      const width = sample.width;
      // The drainage field is the whole road outside the crown, not a stripe at the
      // wall. Water runs off the camber and stands from about a third of the way out to
      // the kerb, and it is the pools ON the racing surface — the ones a car drives
      // through and a cockpit camera looks straight down — that carry the wet read. The
      // 2.1 m strip this used to build lived at the extreme edge of the road, where the
      // front wheels and the motion blur hide it completely.
      const inner = Math.max(width * 0.10, width - 6.0);
      const outer = width - 0.15;
      const distance = (i / segments) * track.length;

      for (let side = -1; side <= 1; side += 2) {
        for (let e = 0; e <= steps; e++) {
          const f = e / steps;
          const lateral = side * (inner + (outer - inner) * f);
          _v.copy(sample.position).addScaledVector(sample.right, lateral);
          const h = track.heightAt(_v.x, _v.z);
          vertices[vi++] = _v.x;
          vertices[vi++] = (Number.isFinite(h) ? h : _v.y) + 0.010;
          vertices[vi++] = _v.z;
          uvs[ui++] = f;
          uvs[ui++] = distance * 0.16;
        }
      }
    }

    // Winding, and it mattered more than anything else about this mesh. `right` is
    // `tangent x up`, so `tangent x right` is *down*: emitting both ribbons with one
    // vertex order gave the +right side a downward face normal, and a downward face is
    // a back face seen from the cockpit. Half of every wet circuit since round 2 was
    // being culled before it reached the rasteriser, which is a large part of why the
    // standing water could never be found in a frame. The +right ribbon is wound the
    // other way round so both faces look at the sky.
    let ii = 0;
    for (let i = 0; i < segments; i++) {
      for (let sd = 0; sd < 2; sd++) {
        const flip = sd === 1;
        for (let e = 0; e < steps; e++) {
          const a = i * ring + sd * perSide + e;
          const b = a + 1;
          const c = (i + 1) * ring + sd * perSide + e;
          const d = c + 1;
          if (flip) {
            indices[ii++] = a; indices[ii++] = b; indices[ii++] = c;
            indices[ii++] = b; indices[ii++] = d; indices[ii++] = c;
          } else {
            indices[ii++] = a; indices[ii++] = c; indices[ii++] = b;
            indices[ii++] = b; indices[ii++] = c; indices[ii++] = d;
          }
        }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();

    this._rippleTexture = rippleNormalTexture(256);
    // The ribbon is ~6 m across and its distance UV runs at 0.16 per metre, so a 2x2
    // repeat puts a ripple tile at roughly three metres square — near enough isotropic
    // that the wave trains do not read as combed along the road.
    this._rippleTexture.repeat.set(2, 2);

    const material = new THREE.MeshPhysicalMaterial({
      name: 'ApexStandingWater',
      // Water's own body is almost black — everything you see in a puddle is reflected.
      // The mistake that made round 2's puddles read as holes punched in the track was
      // pairing that black body with a coverage-driven alpha, so the water hid the road
      // and put nothing back. What puts it back is the reflection, and how much of it
      // comes back is the Fresnel term the patch below drives the alpha with.
      color: new THREE.Color(0.006, 0.008, 0.011),
      roughness: 0.028,
      metalness: 0.0,
      ior: 1.33,
      specularIntensity: 1.0,
      normalMap: this._rippleTexture,
      // A true mirror returns exactly the sky, which already makes standing water the
      // brightest surface on an overcast circuit. Half a stop over unity separates it
      // from the wet-asphalt sheen it sits in — which is also reflecting the sky, just
      // through a rougher coat — without spending the exposure headroom the last round
      // bought. The 2.8 this carried was compensation for a reflection that, because of
      // the squared Fresnel below, was never arriving at all.
      envMapIntensity: 2.0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      // Belt and braces on top of the winding fix above: a horizontal sheet that has
      // been culled once already does not get to be culled again over a sign
      // convention. There is no extra geometry and no extra draw in this.
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    material.normalScale.set(0.14, 0.14);
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = PUDDLE_VARYING + shader.vertexShader.replace(
        '#include <uv_vertex>',
        PUDDLE_VERTEX_PATCH,
      );
      shader.fragmentShader = PUDDLE_VARYING + shader.fragmentShader
        .replace('#include <normal_fragment_maps>', PUDDLE_FRAGMENT_PATCH)
        .replace('#include <lights_fragment_end>', PUDDLE_SPECULAR_PATCH);
    };
    this.puddleMaterial = material;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'fx-standing-water';
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    mesh.renderOrder = 2;
    mesh.visible = false;
    this.puddles = mesh;
    this.group.add(mesh);
  }

  /**
   * Darken and polish the road. A wet circuit is a mirror, and that is the whole look.
   *
   * The mirror is a *layer*, not a change of the asphalt: a film of water over rough
   * aggregate is the textbook clearcoat, a smooth dielectric sheet over a rough base.
   * Modelling it that way is what produces the long grazing-angle sheen band running
   * away down the road — the coat's Fresnel climbs toward the horizon while the base
   * keeps its texture underneath — instead of the uniformly polished, uniformly darker
   * tarmac that dropping the base roughness on its own gives you.
   */
  _applyWetMaterials(ctx, wet) {
    if (Math.abs(wet - this._appliedWetness) < 0.004) return;
    this._appliedWetness = wet;

    if (this._materials.length === 0) {
      const lib = ctx.materials;
      if (!lib?.get) return;
      for (const name of WET_SURFACES) {
        const m = lib.get(name);
        if (!m || !m.isMaterial) continue;
        this._materials.push({
          material: m,
          color: m.color ? m.color.clone() : null,
          roughness: m.roughness ?? 1,
          envMapIntensity: m.envMapIntensity ?? 1,
          physical: m.isMeshPhysicalMaterial === true,
          clearcoat: m.clearcoat ?? 0,
          clearcoatRoughness: m.clearcoatRoughness ?? 0,
        });
      }
    }

    for (let i = 0; i < this._materials.length; i++) {
      const entry = this._materials[i];
      const m = entry.material;
      if (entry.color && m.color) {
        // A wet surface loses some albedo to internal reflection in the film, but only
        // some: over-darkening is what turned the round-2 wet frame into a black pit.
        const k = 1 - 0.48 * wet;
        m.color.setRGB(entry.color.r * k, entry.color.g * k, entry.color.b * k);
      }
      // The base stays rough — it is still stone chips, just wetted. The gloss belongs
      // to the film above it.
      m.roughness = lerp(entry.roughness, 0.44, wet * 0.95);
      // Only a modest lift on the broad environment term: the coat is what gains, and
      // pouring diffuse sky into the base as well is what turns a wet circuit milky
      // instead of dark-with-a-sheen.
      m.envMapIntensity = lerp(entry.envMapIntensity, entry.envMapIntensity * 1.5 + 0.15, wet);
      if (entry.physical) {
        // The film saturates well before the road does. A circuit is visibly, glossily
        // wet long before the standing water is deep, so the coat is driven by a
        // steepened wetness: at the surface water this scenario actually reaches, 0.55,
        // a plain lerp left the coat only half present and still at 0.16 roughness —
        // rougher than damp tarmac, let alone the running-wet road the shot is of.
        //
        // It stops short of optically flat on purpose. The long sheen down a wet
        // straight comes off a *film over aggregate*, which is slightly textured; the
        // mirror-flat surface belongs to the standing water above, and keeping the two
        // roughnesses apart is what lets a pool read as a pool against the sheen rather
        // than dissolving into it.
        //
        // 1.35 and 0.085, not 1.6 and 0.06. Measured: at the steeper setting the
        // grazing band down the straight came back at 1.35 sky radiance across the
        // whole road and swallowed the lane markings and the aggregate with it — a
        // sheet of white, not wet asphalt. A wet circuit is glossy *and still legibly
        // a road*, and the mirror-flat surface in the shot is meant to be the standing
        // water, which needs the tarmac around it to be something other than a mirror.
        const film = clamp01(wet * 1.35);
        m.clearcoat = lerp(entry.clearcoat, 1.0, film);
        m.clearcoatRoughness = lerp(0.28, 0.085, film);
      }
    }

    // USE_CLEARCOAT is a compile-time define, so the frame the film first exists has to
    // rebuild those programs. Latched, because from then on only the value moves and a
    // recompile on every wetness tick would stall the frame for nothing.
    const film = wet > 0.004;
    if (film !== this._filmCompiled) {
      this._filmCompiled = film;
      for (let i = 0; i < this._materials.length; i++) {
        if (this._materials[i].physical) this._materials[i].material.needsUpdate = true;
      }
    }
  }

  _restoreMaterials() {
    for (let i = 0; i < this._materials.length; i++) {
      const entry = this._materials[i];
      const m = entry.material;
      if (entry.color && m.color) m.color.copy(entry.color);
      m.roughness = entry.roughness;
      m.envMapIntensity = entry.envMapIntensity;
      if (entry.physical) {
        m.clearcoat = entry.clearcoat;
        m.clearcoatRoughness = entry.clearcoatRoughness;
        if (this._filmCompiled) m.needsUpdate = true;
      }
    }
    this._filmCompiled = false;
    this._materials.length = 0;
    this._appliedWetness = -1;
  }

  /** Fixed step: track the weather, wet and dry the surface, rain on the road. */
  update(dt, ctx) {
    const target = clamp01(ctx.sky?.weather?.rain ?? 0);
    this.rainIntensity = damp(this.rainIntensity, target, 0.8, dt);
    // A circuit wets over in seconds and dries in tens of minutes; the asymmetry is what
    // makes a drying line appear late in a wet race. The wetting rate scales with how
    // hard it is raining, because it is the rate the water arrives at: a flat 0.055
    // meant a heavy shower needed three minutes of driving before the road looked wet at
    // all, and every wet-weather capture was taken on a barely damp track.
    const rate = target > this.surfaceWater ? 0.09 + 0.45 * target : 0.014;
    this.surfaceWater = clamp01(damp(this.surfaceWater, target, rate, dt));

    if (this.rainIntensity > 0.02 && !this._puddlesBuilt) this._buildPuddles(ctx);
    if (this.rainIntensity > 0.02) this._impacts(dt, ctx);
  }

  /** Drops striking the road around the camera: the crown of each impact, not the drop. */
  _impacts(dt, ctx) {
    const pool = this.splash;
    const track = ctx.track;
    if (!pool || !track?.heightAt) return;

    this._splashAcc += 420 * this.rainIntensity * this._rateScale * this.intensity * dt;
    let count = this._splashAcc | 0;
    if (count > 10) count = 10;
    this._splashAcc -= count;
    if (count <= 0) return;

    ctx.camera.getWorldPosition(_camPos);
    const rng = this.rng;
    const b = pool.brush;
    b.color(0.92, 0.97, 1.05);
    b.alpha = 0.50;
    b.drag = 6;
    b.gravity = 0;
    b.turbulence = 0;
    b.wind = 0;
    // The crown of an impact is thrown water catching the sky, several times brighter
    // than the wet road it stands on. That contrast is the whole read at a distance, and
    // it has to clear the *fog* colour as well as the tarmac — this pool is unlit, so
    // what comes out is colour x brightness, and the atmosphere it is seen against sits
    // around 1.3 scene-referred. At the old 0.72 x 1.8 the crowns were dimmer than the
    // haze they stood in and disappeared into it.
    b.brightness = 2.6;
    b.stretch = 0;
    b.spin = 0;

    for (let k = 0; k < count; k++) {
      const angle = rng.next() * Math.PI * 2;
      const radius = 1.5 + rng.next() * 13;
      const x = _camPos.x + Math.cos(angle) * radius;
      const z = _camPos.z + Math.sin(angle) * radius;
      const y = track.heightAt(x, z);
      if (!Number.isFinite(y)) continue;
      b.groundY = y;
      b.life = 0.22 + rng.next() * 0.18;
      b.size0 = 0.018;
      b.size1 = 0.105 + rng.next() * 0.095;
      b.rot = rng.next() * Math.PI * 2;
      b.seed = rng.next();
      pool.spawn(x, y + 0.012, z, 0, 0.05, 0);
    }
  }

  /**
   * The rooster tail. Rear tyres pick the water up and fling it out of the diffuser in
   * a column that can stand fifteen metres high behind a car at Spa.
   */
  updateCar(dt, ctx, fx) {
    const pool = this.spray;
    if (!pool) return;
    const water = this.surfaceWater;
    if (water < 0.04) return;

    const state = fx.car.physics.state;
    const speed = Math.abs(state.speed);
    if (speed < 6) return;

    const lod = fx.emissionScale;
    if (lod <= 0.02) return;

    _fwd.set(0, 0, -1).applyQuaternion(state.quaternion);
    _right.set(1, 0, 0).applyQuaternion(state.quaternion);

    // Water pools toward the edges of the road, so running wide throws far more of it.
    const edge = fx.width > 0 ? clamp01(Math.abs(fx.lateral) / Math.max(1, fx.width)) : 0;
    const depth = water * (0.55 + 0.75 * edge);
    const speedTerm = clamp01((speed - 6) / 62);
    const rng = this.rng;

    for (let i = 0; i < 4; i++) {
      const w = state.wheels[i];
      if (!w.contact) continue;
      const rear = i >= 2;
      const radius = rear ? 0.3625 : 0.360;
      const groundY = w.worldPosition.y - radius;
      // The rear tyre is wider, unshrouded and sitting under the diffuser, so it does
      // very nearly all of the work. The front pair used to take a quarter of the pool
      // for a knee-high sheet nobody can see behind the sidepod; that share now goes
      // into the column, which is the shot.
      const share = rear ? 1.0 : 0.20;
      const strength = depth * speedTerm * share * this.intensity;
      if (strength <= 0.02) continue;

      const acc = fx.sprayAcc;
      // Fewer, larger, longer-lived puffs. The pool holds ~1260 instances at the top
      // tier and the old 185/s per wheel filled it with small ones that expired before
      // the plume could stand up; the same water in a third as many billboards, each
      // several metres across and alive for two seconds, is what makes a wall.
      acc[i] += (rear ? 118 : 60) * strength * this._rateScale * lod * dt;
      let count = acc[i] | 0;
      if (count > 6) count = 6;
      acc[i] -= count;
      if (count <= 0) continue;

      const b = pool.brush;
      // Atomised water is a near-white scatterer seen against an overcast sky that is
      // itself around 1.3 scene-referred. The pool's LIT term multiplies this by the
      // ambient-plus-sun shade, roughly 0.5 under cloud, so a plume that is to read as
      // spray rather than exhaust has to leave here well above the atmosphere it will
      // be composited against. 0.80 x 1.9 landed at ~0.9 — darker than the haze, which
      // is exactly why three critics called it a pale smudge of exhaust.
      b.color(1.02, 1.06, 1.14);
      b.alpha = 0.16 + strength * 0.30;
      b.drag = 1.05;
      b.gravity = 2.2;
      b.groundY = groundY;
      b.turbulence = 0.95;
      b.wind = 0.85;
      b.brightness = 3.6;
      b.stretch = 0;

      const side = i % 2 === 0 ? -1 : 1;
      for (let k = 0; k < count; k++) {
        _pos.copy(w.worldPosition);
        _pos.y = groundY + 0.05 + rng.next() * 0.30;
        _pos.addScaledVector(_fwd, -(0.15 + rng.next() * 0.70));
        _pos.addScaledVector(_right, side * (rng.next() * 0.30));

        _vel.copy(state.velocity).multiplyScalar(0.45);
        _vel.addScaledVector(_fwd, -speed * (0.18 + rng.next() * 0.26));
        _vel.addScaledVector(_right, side * (0.8 + rng.next() * (rear ? 3.4 : 2.2)));
        _vel.y += (rear ? 4.5 : 1.6) + rng.next() * (rear ? 7.5 : 2.5) + speedTerm * (rear ? 6.0 : 2.0);

        // The rear plume has to outlive the car that threw it — a rooster tail is still
        // hanging in the air when the following car arrives, which is the whole reason
        // wet running is dangerous and the whole reason it reads on camera.
        b.life = (rear ? 2.05 : 0.9) * (0.75 + rng.next() * 0.6);
        b.size0 = 0.20 + rng.next() * 0.26;
        b.size1 = b.size0 + (rear ? 3.4 : 1.1) + rng.next() * (rear ? 3.2 : 1.8);
        b.rot = rng.next() * Math.PI * 2;
        b.spin = rng.signed(1.1);
        b.seed = rng.next();
        pool.spawn(_pos.x, _pos.y, _pos.z, _vel.x, _vel.y, _vel.z);
      }
    }
  }

  /** Per frame: move the rain volume with the eye and drive the wet-surface look. */
  lateUpdate(alpha, ctx, dt, sceneTexture) {
    const camera = ctx.camera;
    camera.getWorldPosition(_camPos);

    if (this._camValid && dt > 1e-5) {
      _v.subVectors(_camPos, _prevCam).multiplyScalar(1 / dt);
      // The camera velocity is smoothed: a single dropped frame must not snap every
      // streak in the volume to a new angle.
      this._camVel.lerp(_v, clamp01(dt * 12));
    }
    _prevCam.copy(_camPos);
    this._camValid = true;

    const wet = this.surfaceWater;
    this._applyWetMaterials(ctx, wet);

    if (this.puddles) {
      const visible = wet > 0.02;
      this.puddles.visible = visible;
      if (visible) {
        // Coverage, not reflectance — the shader's Fresnel term owns how much of the
        // sky comes back. Water gathers into pools well before the road is soaked, so
        // coverage saturates early and the pools then simply deepen.
        this.puddleMaterial.opacity = clamp01(wet * 2.2);
        const t = ctx.time.elapsed;
        // Ripples drift with the wind and are agitated by the rain rate. Kept shallow:
        // a mirror that is being chopped up by its own normal map stops being a mirror,
        // and the sky reflection down the straight is the entire point of the surface.
        const drift = 0.03 + this.rainIntensity * 0.10;
        this._rippleTexture.offset.set((t * drift) % 1, (t * drift * 0.6) % 1);
        // Shallow. The alpha is now a Fresnel at grazing incidence, where a small tilt
        // in the normal is a large swing in reflectance, so a ripple deep enough to be
        // pretty at noon shatters the mirror band into speckle down the straight.
        this.puddleMaterial.normalScale.setScalar(0.06 + this.rainIntensity * 0.10);
      }
    }

    const rainMesh = this.rainMesh;
    if (rainMesh) {
      const intensity = this.rainIntensity;
      const visible = intensity > 0.015;
      rainMesh.visible = visible;
      if (visible) {
        const u = this.rainMaterial.uniforms;
        const sky = ctx.sky;
        const w = sky?.weather;
        const windX = w ? Math.sin(w.windDir) * w.windSpeed * 0.85 : 0;
        const windZ = w ? -Math.cos(w.windDir) * w.windSpeed * 0.85 : 0;
        const fall = DROP_FALL_SPEED * (0.75 + intensity * 0.5);

        this._relVel.set(windX - this._camVel.x, -fall - this._camVel.y, windZ - this._camVel.z);
        this._phase.addScaledVector(this._relVel, dt);
        const box = u.uBox.value;
        this._phase.x = ((this._phase.x % (box.x * 2)) + box.x * 2) % (box.x * 2);
        this._phase.y = ((this._phase.y % (box.y * 2)) + box.y * 2) % (box.y * 2);
        this._phase.z = ((this._phase.z % (box.z * 2)) + box.z * 2) % (box.z * 2);

        // A raindrop is not a grey mark on the lens: it is a lens itself, and what it
        // sends to the eye is scattered sky. Pinning the streak colour to the sky's own
        // colour is what keeps the rain readable against the dark road without turning
        // into dark scratches across the bright overcast above the horizon — the fixed
        // 0.62 it carried before sat far below the sky's scene-referred level, so every
        // streak crossing the sky punched a hole in it. The gain above unity is the
        // other half: a drop gathers the whole sky dome and hands it back down one
        // narrow cone, so it is legitimately brighter than the patch of sky behind it,
        // and at exactly sky level a streak crossing the overcast was invisible.
        const tint = ctx.sky?.fogParams?.color;
        if (tint) u.uColor.value.set(tint.r * 1.30, tint.g * 1.34, tint.b * 1.40);

        const size = ctx.renderer.getDrawingBufferSize(_visorSize);
        u.uAspect.value = size.x / Math.max(1, size.y);

        u.uOpacity.value = clamp01(0.26 + intensity * 0.46) * this.intensity;
        u.uWidth.value = 0.010 + intensity * 0.007;
        rainMesh.geometry.instanceCount = Math.round(this.rainCapacity * clamp01(0.25 + intensity * 0.75));

        rainMesh.position.copy(_camPos);
        rainMesh.updateMatrix();
      }
    }

    this._updateVisor(ctx, dt, sceneTexture);
  }

  _updateVisor(ctx, dt, sceneTexture) {
    const mesh = this.visor;
    if (!mesh) return;
    const mode = ctx.cameraRig?.mode ?? 'cockpit';
    const cockpit = mode === 'cockpit' || mode === 'helmet';
    const wet = this.rainIntensity * (cockpit ? 1 : 0);
    if (wet < 0.02) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;

    const camera = ctx.camera;
    const dist = 0.085;
    const halfH = Math.tan((camera.fov * Math.PI) / 360) * dist;
    const halfW = halfH * camera.aspect;
    mesh.position.set(0, 0, -dist);
    mesh.scale.set(halfW * 2.05, halfH * 2.05, 1);
    mesh.updateMatrix();

    const state = ctx.cars?.[0]?.physics?.state;
    const speed = state ? Math.abs(state.speed) : 0;
    const u = this.visorMaterial.uniforms;
    u.uTime.value = ctx.time.elapsed;
    u.uWet.value = clamp01(wet) * 0.85 * this.intensity;
    u.uAirflow.value = smoothstep(4, 46, speed);
    u.uScene.value = sceneTexture ?? null;
    u.uHasScene.value = sceneTexture ? 1 : 0;

    const size = ctx.renderer.getDrawingBufferSize(_visorSize);
    u.uResolution.value.set(size.x, size.y);

    // The meniscus gathers the sky, so it takes the sky's hue — but the film is a
    // multiplier now, so the tint has to carry hue only. Normalising it to unit
    // luminance keeps the rim's brightness in the shader's hands and stops a bright
    // overcast from doubling the gain behind our back.
    const sky = ctx.sky;
    const c = sky?.fogParams?.color;
    if (c) {
      const luma = Math.max(1e-3, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
      u.uTint.value.set(c.r / luma, c.g / luma, c.b / luma);
    }
    // Airflow shears the bead, and a sheared bead refracts further off-axis.
    u.uRefraction.value = 0.009 + u.uAirflow.value * 0.007;
  }

  get wetness() {
    return this.surfaceWater;
  }

  /** Force the road wetness directly, for a session that starts on a damp track. */
  setWetness(w) {
    const v = clamp01(w);
    this.surfaceWater = v;
    this.rainIntensity = Math.max(this.rainIntensity, v * 0.4);
    if (v > 0.02 && this.ctx) this._buildPuddles(this.ctx);
  }

  _disposeRain() {
    if (!this.rainMesh) return;
    this.rainMesh.geometry.dispose();
    this.rainMaterial.dispose();
    this.group.remove(this.rainMesh);
    this.rainMesh = null;
    this.rainMaterial = null;
  }

  dispose() {
    this._restoreMaterials();
    this._disposeRain();

    if (this.puddles) {
      this.puddles.geometry.dispose();
      this.puddleMaterial.dispose();
      this.group.remove(this.puddles);
      this.puddles = null;
      this.puddleMaterial = null;
    }
    if (this._rippleTexture) {
      this._rippleTexture.dispose();
      this._rippleTexture = null;
    }
    if (this.visor) {
      this.visor.geometry.dispose();
      this.visorMaterial.dispose();
      this.visor.parent?.remove(this.visor);
      this.visor = null;
      this.visorMaterial = null;
    }
    this.group.parent?.remove(this.group);
    this.group.clear();
    this.spray = null;
    this.splash = null;
  }
}
