import * as THREE from 'three';
import { clamp, clamp01 } from '../core/MathUtils.js';
import { Rng } from '../core/Rng.js';

/**
 * GPU-simulated pooled particle engine.
 *
 * One draw call per effect type. Every particle is an instance carrying its whole
 * trajectory as constants — origin, launch velocity, drag, gravity, ground height,
 * turbulence, colour and life — and the vertex shader evaluates the closed-form
 * solution of that trajectory at `uTime`. The CPU therefore writes an instance once
 * at spawn and never touches it again, which is what keeps twenty cars throwing smoke
 * inside a 16 ms frame.
 *
 * Two integrators are compiled from the same source:
 *   SIM_DRAG      linear drag toward a wind-carried terminal velocity (smoke, spray,
 *                 dust) — exact for dv/dt = -k(v - v_inf).
 *   SIM_BALLISTIC parabolic flight with up to two analytic ground bounces (sparks,
 *                 debris) — the skittering is the entire point of the effect.
 *
 * Sorting: additive effects are order-independent by construction, and the alpha
 * effects are separated into pools that carry an explicit render order (dust behind
 * smoke behind spray behind rain), so the only unsorted blending left is between
 * particles of one effect, which share a colour ramp and premultiplied alpha and so
 * cannot produce a visible seam whichever order they land in.
 *
 * Soft particles are solved analytically rather than against the depth buffer: the
 * renderer draws the whole scene in a single forward pass, so its depth attachment is
 * live and sampling it would be a framebuffer feedback loop. Instead each particle is
 * treated as a sphere (Umenhoffer's spherical billboards) and the view ray's chord
 * through that sphere is clipped against the eye's near distance and against the local
 * ground plane the particle was emitted on. That removes exactly the two hard edges
 * that betray a billboard — the line where smoke meets the track, and the guillotine
 * when the camera drives through a cloud — and it costs no extra pass.
 */

const FLOATS_PER_PARTICLE = 24;
const O_ORIGIN = 0;   // vec3 world spawn point
const O_VEL = 3;      // vec3 launch velocity, m/s
const O_TIMING = 6;   // birth seconds, 1/life, seed
const O_SIZE = 9;     // start radius, end radius, metres
const O_SPIN = 11;    // phase radians, rate rad/s
const O_COLOR = 13;   // linear rgb, peak alpha
const O_PHYS = 17;    // drag 1/s, gravity m/s^2, ground world Y, turbulence metres
const O_EXTRA = 21;   // stretch s, brightness, wind influence

const PARTICLE_VERTEX = /* glsl */ `
attribute vec3 aOrigin;
attribute vec3 aVelocity;
attribute vec3 aTiming;
attribute vec2 aSize;
attribute vec2 aSpin;
attribute vec4 aColor;
attribute vec4 aPhys;
attribute vec3 aExtra;

uniform float uTime;
uniform vec3 uWind;
uniform float uFadeIn;
uniform float uFadeOut;
uniform float uGrowth;
uniform float uFogDensity;
uniform float uRestitution;
uniform float uFriction;
uniform vec3 uHot;
uniform vec3 uCool;
uniform float uCoolPower;

varying vec2 vUv;
varying vec4 vColor;
varying vec3 vCenter;
varying vec3 vWorld;
varying float vRadius;
varying float vGround;
varying float vFog;

vec3 apexTurbulence(float seed, float age) {
  float a = seed * 63.71;
  return vec3(
    sin(a + age * 1.90),
    sin(a * 1.7 + age * 1.27) * 0.55,
    cos(a * 2.3 + age * 1.55));
}

#ifdef SIM_BALLISTIC
vec3 apexBallistic(float age, vec3 launch, out vec3 velOut) {
  float g = max(aPhys.y, 0.0);
  float gy = aPhys.z;
  vec3 p = aOrigin;
  vec3 v = launch;
  float remaining = age;

  // Two bounces is where the eye stops counting; the third is always sub-pixel.
  for (int i = 0; i < 2; i++) {
    if (v.y <= 0.0 && p.y <= gy) break;
    float disc = v.y * v.y + 2.0 * g * (p.y - gy);
    if (disc <= 0.0) break;
    float tHit = (v.y + sqrt(disc)) / max(g, 1e-3);
    if (tHit <= 0.0 || tHit >= remaining) break;
    p += v * tHit;
    p.y = gy;
    float vy = v.y - g * tHit;
    v.y = -vy * uRestitution;
    v.x *= uFriction;
    v.z *= uFriction;
    remaining -= tHit;
  }

  p += v * remaining;
  p.y -= 0.5 * g * remaining * remaining;
  velOut = vec3(v.x, v.y - g * remaining, v.z);
  if (p.y < gy) {
    p.y = gy;
    velOut = vec3(0.0);
  }
  return p;
}
#endif

void main() {
  float t = (uTime - aTiming.x) * aTiming.y;

  // Dead and unborn instances collapse behind the far plane: zero fragments, and no
  // branch cost anywhere else in the shader.
  if (t < 0.0 || t >= 1.0) {
    vUv = vec2(0.0);
    vColor = vec4(0.0);
    vCenter = vec3(0.0);
    vWorld = vec3(0.0);
    vRadius = 0.0;
    vGround = 0.0;
    vFog = 0.0;
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  float age = uTime - aTiming.x;
  vec3 vel;
  vec3 p;

  #ifdef SIM_BALLISTIC
    p = apexBallistic(age, aVelocity + uWind * aExtra.z, vel);
  #else
    float k = max(aPhys.x, 0.02);
    vec3 term = uWind * aExtra.z - vec3(0.0, aPhys.y / k, 0.0);
    float decay = exp(-k * age);
    p = aOrigin + (aVelocity - term) * ((1.0 - decay) / k) + term * age;
    vel = (aVelocity - term) * decay + term;
    p += apexTurbulence(aTiming.z, age) * (aPhys.w * age);
  #endif

  float grow = 1.0 - pow(1.0 - t, uGrowth);
  float radius = mix(aSize.x, aSize.y, grow);

  float fadeIn = uFadeIn > 0.0 ? clamp(t / uFadeIn, 0.0, 1.0) : 1.0;
  float alpha = aColor.a * fadeIn * pow(1.0 - t, uFadeOut);

  vec3 tint = aColor.rgb * aExtra.y;
  #ifdef COOLING
    tint *= mix(uHot, uCool, pow(t, uCoolPower));
  #endif

  vec4 world = modelMatrix * vec4(p, 1.0);
  vec4 mv = viewMatrix * world;

  vec2 q = position.xy;
  #ifdef STRETCH
    vec3 velView = mat3(viewMatrix) * mat3(modelMatrix) * vel;
    vec2 d = velView.xy;
    float dl = length(d);
    vec2 axis = dl > 1e-4 ? d / dl : vec2(0.0, 1.0);
    vec2 perp = vec2(-axis.y, axis.x);
    // Streak length is the distance the particle covers in one shutter interval,
    // measured on screen so it foreshortens correctly when it flies at the camera.
    float streak = radius + dl * aExtra.x;
    vec2 off = perp * (q.x * radius * 2.0) + axis * (q.y * streak * 2.0);
  #else
    float rot = aSpin.x + aSpin.y * age;
    float cs = cos(rot);
    float sn = sin(rot);
    vec2 off = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs) * (radius * 2.0);
  #endif

  mv.xy += off;
  gl_Position = projectionMatrix * mv;

  vUv = uv;
  vColor = vec4(tint, alpha);
  vCenter = world.xyz;
  // The view basis is orthonormal, so right-multiplying by it transposes the rotation
  // and lifts the screen-space corner offset back into world space for the ray setup.
  vWorld = world.xyz + vec3(off, 0.0) * mat3(viewMatrix);
  vRadius = radius;
  vGround = aPhys.z;
  vFog = 1.0 - exp(-uFogDensity * uFogDensity * dot(mv.xyz, mv.xyz));
}
`;

const PARTICLE_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uOpacity;
uniform float uSoftness;
uniform float uNearFade;
uniform float uScatter;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uAmbient;
uniform vec3 uFogColor;

varying vec2 vUv;
varying vec4 vColor;
varying vec3 vCenter;
varying vec3 vWorld;
varying float vRadius;
varying float vGround;
varying float vFog;

void main() {
  vec4 texel = texture2D(uMap, vUv);
  float alpha = texel.a * vColor.a * uOpacity;
  if (alpha < 0.0025) discard;

  vec3 col = vColor.rgb * texel.rgb;

  #if defined(SOFT) || defined(LIT)
    vec3 ray = vWorld - cameraPosition;
    float rayLen = length(ray);
    ray /= max(rayLen, 1e-4);
    vec3 toCentre = vCenter - cameraPosition;
    float b = dot(ray, toCentre);
    float disc = b * b - (dot(toCentre, toCentre) - vRadius * vRadius);
    if (disc <= 0.0) discard;
    float h = sqrt(disc);
  #endif

  #ifdef SOFT
    float t0 = max(b - h, uNearFade);
    float t1 = b + h;
    float dy = ray.y;
    float toGround = vGround - cameraPosition.y;
    if (dy > 1e-5) t0 = max(t0, toGround / dy);
    else if (dy < -1e-5) t1 = min(t1, toGround / dy);
    else if (toGround > 0.0) t1 = t0;
    float thickness = max(t1 - t0, 0.0);
    alpha *= clamp(thickness / max(2.0 * vRadius * uSoftness, 1e-3), 0.0, 1.0);
    if (alpha < 0.0025) discard;
  #endif

  #ifdef LIT
    // Shade off the sphere's own normal: the sunlit crown and the shadowed underside
    // are what make a smoke column read as volume instead of as a grey decal.
    vec3 normal = normalize((cameraPosition + ray * (b - h)) - vCenter);
    float ndl = dot(normal, uSunDir);
    vec3 shade = uAmbient + uSunColor * smoothstep(-0.55, 0.85, ndl);
    float forward = pow(clamp(dot(ray, uSunDir), 0.0, 1.0), 8.0) * uScatter;
    col *= shade + uSunColor * forward * (1.0 - alpha);
  #endif

  #ifdef ADDITIVE
    col *= 1.0 - vFog;
  #else
    col = mix(col, uFogColor, vFog);
  #endif

  gl_FragColor = vec4(col * alpha, alpha);
}
`;

/** Shared lattice hash. Deterministic per (x, y, seed) so textures are reproducible. */
function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable value noise on a `period` lattice. */
function valueNoise(x, y, period, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const xa = ((x0 % period) + period) % period;
  const ya = ((y0 % period) + period) % period;
  const xb = (xa + 1) % period;
  const yb = (ya + 1) % period;
  const n00 = hash2(xa, ya, seed);
  const n10 = hash2(xb, ya, seed);
  const n01 = hash2(xa, yb, seed);
  const n11 = hash2(xb, yb, seed);
  const a = n00 + (n10 - n00) * ux;
  const b = n01 + (n11 - n01) * ux;
  return a + (b - a) * uy;
}

function fbm(x, y, period, seed, octaves) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * freq, y * freq, period * freq, seed + o * 97) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

function makeSpriteTexture(size, name, fill) {
  const data = new Uint8Array(size * size * 4);
  fill(data, size);
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  // Sprites are masks, not colour: the particle's own linear tint does the colouring.
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  tex.name = name;
  return tex;
}

/**
 * Billowing puff: an fbm-warped disc whose interior carries a self-occlusion term so
 * the sprite still has structure when a hundred of them overlap into one column.
 */
export function createSmokeSprite(size, seed) {
  return makeSpriteTexture(size, 'ApexSmokeSprite', (data, n) => {
    const inv = 1 / n;
    const period = 8;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = (x + 0.5) * inv * 2 - 1;
        const v = (y + 0.5) * inv * 2 - 1;
        const r = Math.sqrt(u * u + v * v);
        const warp = fbm(x * inv * period, y * inv * period, period, seed, 4);
        const edge = clamp01(1.15 - r * (1.0 + warp * 0.55));
        let a = edge * edge * (1.0 - 0.42 * fbm(x * inv * period * 2.2 + 11, y * inv * period * 2.2 + 7, period * 2, seed + 31, 3));
        a = clamp01(a * 1.35);
        const occ = 1.0 - 0.30 * clamp01(1.0 - r * 1.6) * warp;
        const i = (y * n + x) * 4;
        const c = Math.round(clamp01(occ) * 255);
        data[i] = c;
        data[i + 1] = c;
        data[i + 2] = c;
        data[i + 3] = Math.round(a * 255);
      }
    }
  });
}

/** Grittier, harder-edged than smoke: dust hangs in clumps rather than billowing. */
export function createDustSprite(size, seed) {
  return makeSpriteTexture(size, 'ApexDustSprite', (data, n) => {
    const inv = 1 / n;
    const period = 12;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = (x + 0.5) * inv * 2 - 1;
        const v = (y + 0.5) * inv * 2 - 1;
        const r = Math.sqrt(u * u + v * v);
        const grain = fbm(x * inv * period, y * inv * period, period, seed, 5);
        const edge = clamp01(1.05 - r * (0.85 + grain * 0.75));
        const a = clamp01(Math.pow(edge, 1.35) * (0.55 + grain * 0.85));
        const i = (y * n + x) * 4;
        const c = Math.round(clamp01(0.82 + grain * 0.25) * 255);
        data[i] = c;
        data[i + 1] = c;
        data[i + 2] = c;
        data[i + 3] = Math.round(a * 255);
      }
    }
  });
}

/**
 * Streak sprite for stretched billboards: a hot needle down V with a hard falloff
 * across U, so a spark reads as a line of light rather than a smear.
 */
export function createStreakSprite(size, seed) {
  return makeSpriteTexture(size, 'ApexStreakSprite', (data, n) => {
    const inv = 1 / n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = (x + 0.5) * inv * 2 - 1;
        const v = (y + 0.5) * inv * 2 - 1;
        const across = clamp01(1.0 - Math.abs(u));
        const along = clamp01(1.0 - Math.abs(v));
        const flicker = 0.72 + 0.28 * valueNoise(v * 9.0, seed * 0.11, 16, seed);
        const core = Math.pow(across, 3.4) * Math.pow(along, 0.85) * flicker;
        const halo = Math.pow(across, 1.15) * Math.pow(along, 1.6) * 0.30;
        const a = clamp01(core + halo);
        const i = (y * n + x) * 4;
        const white = clamp01(0.55 + core * 0.75);
        data[i] = Math.round(clamp01(white * 1.0) * 255);
        data[i + 1] = Math.round(clamp01(white * 0.94) * 255);
        data[i + 2] = Math.round(clamp01(white * 0.86) * 255);
        data[i + 3] = Math.round(a * 255);
      }
    }
  });
}

/** Solid chunk with a chipped silhouette — gravel, kerb rubber, carbon shards. */
export function createChunkSprite(size, seed) {
  return makeSpriteTexture(size, 'ApexChunkSprite', (data, n) => {
    const inv = 1 / n;
    const period = 6;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = (x + 0.5) * inv * 2 - 1;
        const v = (y + 0.5) * inv * 2 - 1;
        const ang = Math.atan2(v, u);
        const r = Math.sqrt(u * u + v * v);
        const facet = 0.62 + 0.30 * valueNoise(Math.cos(ang) * 3 + 4, Math.sin(ang) * 3 + 4, period, seed);
        const a = r < facet ? 1.0 : clamp01((facet + 0.08 - r) / 0.08);
        const shade = clamp01(0.55 + 0.45 * (1.0 - r / Math.max(facet, 1e-3)) * fbm(x * inv * 5, y * inv * 5, 5, seed + 9, 2) * 1.6);
        const i = (y * n + x) * 4;
        data[i] = Math.round(shade * 255);
        data[i + 1] = Math.round(shade * 255);
        data[i + 2] = Math.round(shade * 255);
        data[i + 3] = Math.round(clamp01(a) * 255);
      }
    }
  });
}

/** Rain and spray droplet: a bright meniscus with a dark core, elongated down V. */
export function createDropletSprite(size) {
  return makeSpriteTexture(size, 'ApexDropletSprite', (data, n) => {
    const inv = 1 / n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = ((x + 0.5) * inv * 2 - 1) * 2.1;
        const v = (y + 0.5) * inv * 2 - 1;
        const r = Math.sqrt(u * u + v * v);
        const body = clamp01(1.0 - r);
        const rim = Math.pow(clamp01(1.0 - Math.abs(r - 0.72) * 4.0), 2.0);
        const a = clamp01(body * 0.55 + rim * 0.8);
        const i = (y * n + x) * 4;
        const c = Math.round(clamp01(0.70 + rim * 0.6) * 255);
        data[i] = c;
        data[i + 1] = c;
        data[i + 2] = c;
        data[i + 3] = Math.round(a * 255);
      }
    }
  });
}

/** Impact crown: a thin ring that expands, for drops striking the track. */
export function createSplashSprite(size) {
  return makeSpriteTexture(size, 'ApexSplashSprite', (data, n) => {
    const inv = 1 / n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = (x + 0.5) * inv * 2 - 1;
        const v = (y + 0.5) * inv * 2 - 1;
        const r = Math.sqrt(u * u + v * v);
        const ring = Math.pow(clamp01(1.0 - Math.abs(r - 0.78) * 5.2), 1.6);
        const spokes = 0.55 + 0.45 * Math.abs(Math.sin(Math.atan2(v, u) * 9.0));
        const a = clamp01(ring * spokes);
        const i = (y * n + x) * 4;
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = Math.round(a * 255);
      }
    }
  });
}

/** Combustion blob: white-hot core, ragged edge, for exhaust pops. */
export function createFlameSprite(size, seed) {
  return makeSpriteTexture(size, 'ApexFlameSprite', (data, n) => {
    const inv = 1 / n;
    const period = 7;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const u = (x + 0.5) * inv * 2 - 1;
        const v = (y + 0.5) * inv * 2 - 1;
        const r = Math.sqrt(u * u + v * v);
        const turb = fbm(x * inv * period, y * inv * period, period, seed, 4);
        const edge = clamp01(1.0 - r * (0.9 + turb * 0.6));
        const a = clamp01(Math.pow(edge, 1.6) * 1.3);
        const core = Math.pow(clamp01(1.0 - r * 2.4), 2.0);
        const i = (y * n + x) * 4;
        data[i] = 255;
        data[i + 1] = Math.round(clamp01(0.45 + core * 0.55 + turb * 0.15) * 255);
        data[i + 2] = Math.round(clamp01(0.12 + core * 0.80) * 255);
        data[i + 3] = Math.round(a * 255);
      }
    }
  });
}

const _quadPositions = new Float32Array([
  -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
]);
const _quadUvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
const _quadIndices = new Uint16Array([0, 1, 2, 0, 2, 3]);

/**
 * A spawn brush. The caller mutates the fields it cares about and calls `spawn`; every
 * field persists, so a burst of forty particles sharing a colour writes that colour
 * once. Mutating a long-lived object is what keeps the hot path allocation-free.
 */
class Brush {
  constructor() {
    this.life = 1;
    this.size0 = 0.2;
    this.size1 = 0.6;
    this.rot = 0;
    this.spin = 0;
    this.r = 1;
    this.g = 1;
    this.b = 1;
    this.alpha = 1;
    this.drag = 1.2;
    this.gravity = 0;
    this.groundY = 0;
    this.turbulence = 0;
    this.stretch = 0;
    this.brightness = 1;
    this.wind = 1;
    this.seed = 0;
  }

  color(r, g, b) {
    this.r = r;
    this.g = g;
    this.b = b;
    return this;
  }
}

export class ParticlePool {
  /**
   * @param {string} name
   * @param {object} options
   * @param {object} shared shared uniform slots owned by the ParticleSystem
   */
  constructor(name, options, shared, rng) {
    this.name = name;
    this.capacity = Math.max(8, options.capacity | 0);
    this.brush = new Brush();
    this.rng = rng;

    this._data = new Float32Array(this.capacity * FLOATS_PER_PARTICLE);
    this._death = new Float32Array(this.capacity);
    this._alive = new Uint8Array(this.capacity);
    this._free = new Int32Array(this.capacity);
    this._freeCount = this.capacity;
    for (let i = 0; i < this.capacity; i++) this._free[i] = this.capacity - 1 - i;

    this._sweepCursor = 0;
    this._ringCursor = 0;
    this._highWater = 0;
    this._dirtyLo = 0;
    this._dirtyHi = -1;
    this._range = { start: 0, count: 0 };
    this.live = 0;
    this.spawned = 0;
    this.now = 0;

    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(new THREE.BufferAttribute(_quadIndices.slice(), 1));
    geometry.setAttribute('position', new THREE.BufferAttribute(_quadPositions.slice(), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(_quadUvs.slice(), 2));

    const buffer = new THREE.InstancedInterleavedBuffer(this._data, FLOATS_PER_PARTICLE, 1);
    buffer.setUsage(THREE.DynamicDrawUsage);
    this._buffer = buffer;
    geometry.setAttribute('aOrigin', new THREE.InterleavedBufferAttribute(buffer, 3, O_ORIGIN));
    geometry.setAttribute('aVelocity', new THREE.InterleavedBufferAttribute(buffer, 3, O_VEL));
    geometry.setAttribute('aTiming', new THREE.InterleavedBufferAttribute(buffer, 3, O_TIMING));
    geometry.setAttribute('aSize', new THREE.InterleavedBufferAttribute(buffer, 2, O_SIZE));
    geometry.setAttribute('aSpin', new THREE.InterleavedBufferAttribute(buffer, 2, O_SPIN));
    geometry.setAttribute('aColor', new THREE.InterleavedBufferAttribute(buffer, 4, O_COLOR));
    geometry.setAttribute('aPhys', new THREE.InterleavedBufferAttribute(buffer, 4, O_PHYS));
    geometry.setAttribute('aExtra', new THREE.InterleavedBufferAttribute(buffer, 3, O_EXTRA));
    geometry.instanceCount = 0;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = geometry;

    const additive = options.blending === 'additive';
    const defines = {};
    if (options.ballistic) defines.SIM_BALLISTIC = '';
    if (options.stretch) defines.STRETCH = '';
    if (options.lit) defines.LIT = '';
    if (options.soft !== false) defines.SOFT = '';
    if (options.cooling) defines.COOLING = '';
    if (additive) defines.ADDITIVE = '';

    const material = new THREE.ShaderMaterial({
      name: `ApexParticles_${name}`,
      defines,
      uniforms: {
        uTime: shared.uTime,
        uWind: shared.uWind,
        uSunDir: shared.uSunDir,
        uSunColor: shared.uSunColor,
        uAmbient: shared.uAmbient,
        uFogColor: shared.uFogColor,
        uFogDensity: shared.uFogDensity,
        uMap: { value: options.map ?? null },
        uOpacity: { value: options.opacity ?? 1 },
        uSoftness: { value: options.softness ?? 1 },
        uNearFade: { value: options.nearFade ?? 0.35 },
        uScatter: { value: options.scatter ?? 0.9 },
        uFadeIn: { value: options.fadeIn ?? 0.12 },
        uFadeOut: { value: options.fadeOut ?? 1.4 },
        uGrowth: { value: options.growth ?? 1.8 },
        uRestitution: { value: options.restitution ?? 0.35 },
        uFriction: { value: options.friction ?? 0.62 },
        uHot: { value: new THREE.Vector3(1, 1, 1) },
        uCool: { value: new THREE.Vector3(1, 0.22, 0.04) },
        uCoolPower: { value: options.coolPower ?? 0.75 },
      },
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      // Both variants emit premultiplied alpha; only the destination factor differs,
      // which is what lets one shader serve alpha and additive effects.
      blendDst: additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    material.userData.skipCSM = true;
    this.material = material;

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = `fx-${name}`;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = options.renderOrder ?? 10;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  setHotCool(hr, hg, hb, cr, cg, cb) {
    this.material.uniforms.uHot.value.set(hr, hg, hb);
    this.material.uniforms.uCool.value.set(cr, cg, cb);
  }

  set opacity(v) {
    this.material.uniforms.uOpacity.value = v;
  }

  get opacity() {
    return this.material.uniforms.uOpacity.value;
  }

  /** Reclaim a slice of the pool. Full sweep costs O(capacity) and only runs when dry. */
  _sweep(portion) {
    const n = this.capacity;
    const count = portion >= 1 ? n : Math.max(64, Math.ceil(n * portion));
    const now = this.now;
    let cursor = this._sweepCursor;
    for (let s = 0; s < count; s++) {
      if (this._alive[cursor] === 1 && now >= this._death[cursor]) {
        this._alive[cursor] = 0;
        this._free[this._freeCount++] = cursor;
        this.live--;
      }
      cursor++;
      if (cursor >= n) cursor = 0;
    }
    this._sweepCursor = cursor;
  }

  _alloc() {
    if (this._freeCount > 0) return this._free[--this._freeCount];
    this._sweep(1);
    if (this._freeCount > 0) return this._free[--this._freeCount];
    // Saturated: steal round-robin so the oldest visible particle is the one that goes.
    const index = this._ringCursor;
    this._ringCursor = (this._ringCursor + 1) % this.capacity;
    return index;
  }

  /** True while the pool still has room, so callers can skip building a spawn. */
  get saturated() {
    return this._freeCount === 0 && this.live >= this.capacity;
  }

  spawn(x, y, z, vx, vy, vz) {
    const i = this._alloc();
    const b = this.brush;
    const o = i * FLOATS_PER_PARTICLE;
    const d = this._data;

    d[o + O_ORIGIN] = x;
    d[o + O_ORIGIN + 1] = y;
    d[o + O_ORIGIN + 2] = z;
    d[o + O_VEL] = vx;
    d[o + O_VEL + 1] = vy;
    d[o + O_VEL + 2] = vz;

    const life = Math.max(0.02, b.life);
    d[o + O_TIMING] = this.now;
    d[o + O_TIMING + 1] = 1 / life;
    d[o + O_TIMING + 2] = b.seed || this.rng.next();

    d[o + O_SIZE] = b.size0;
    d[o + O_SIZE + 1] = b.size1;
    d[o + O_SPIN] = b.rot;
    d[o + O_SPIN + 1] = b.spin;

    d[o + O_COLOR] = b.r;
    d[o + O_COLOR + 1] = b.g;
    d[o + O_COLOR + 2] = b.b;
    d[o + O_COLOR + 3] = b.alpha;

    d[o + O_PHYS] = b.drag;
    d[o + O_PHYS + 1] = b.gravity;
    d[o + O_PHYS + 2] = b.groundY;
    d[o + O_PHYS + 3] = b.turbulence;

    d[o + O_EXTRA] = b.stretch;
    d[o + O_EXTRA + 1] = b.brightness;
    d[o + O_EXTRA + 2] = b.wind;

    if (this._alive[i] === 0) {
      this._alive[i] = 1;
      this.live++;
    }
    this._death[i] = this.now + life;
    if (i + 1 > this._highWater) this._highWater = i + 1;
    if (i < this._dirtyLo) this._dirtyLo = i;
    if (i > this._dirtyHi) this._dirtyHi = i;
    this.spawned++;
    return i;
  }

  /** Advance the pool clock and recycle expired slots. Called once per fixed step. */
  update(now) {
    this.now = now;
    this._sweep(0.2);
  }

  /** Upload the frame's spawns and size the draw to the live high-water mark. */
  flush() {
    if (this._dirtyHi >= this._dirtyLo) {
      const start = this._dirtyLo * FLOATS_PER_PARTICLE;
      const count = (this._dirtyHi - this._dirtyLo + 1) * FLOATS_PER_PARTICLE;
      this._range.start = start;
      this._range.count = count;
      // Clear first: a frame in which the mesh never reached the renderer would
      // otherwise leave its range behind and grow the list without bound.
      this._buffer.clearUpdateRanges();
      this._buffer.updateRanges.push(this._range);
      this._buffer.needsUpdate = true;
      this._dirtyLo = this.capacity;
      this._dirtyHi = -1;
    }
    if (this.live === 0) this._highWater = 0;
    this.geometry.instanceCount = this._highWater;
  }

  clear() {
    this._alive.fill(0);
    this._death.fill(0);
    this._freeCount = this.capacity;
    for (let i = 0; i < this.capacity; i++) this._free[i] = this.capacity - 1 - i;
    this.live = 0;
    this._highWater = 0;
    this.geometry.instanceCount = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

const _sunTmp = new THREE.Vector3();

export class ParticleSystem {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'fx-particles';
    this.group.matrixAutoUpdate = false;

    this.pools = new Map();
    this.sprites = new Map();
    this.rng = new Rng(0x4f1a77c3);
    this.time = 0;
    this.simTime = 0;
    this.budget = 9000;

    this.shared = {
      uTime: { value: 0 },
      uWind: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0.3, 0.86, 0.4) },
      uSunColor: { value: new THREE.Vector3(1.0, 0.95, 0.86) },
      uAmbient: { value: new THREE.Vector3(0.30, 0.34, 0.40) },
      uFogColor: { value: new THREE.Vector3(0.62, 0.70, 0.80) },
      uFogDensity: { value: 0.00032 },
    };
  }

  /** @param {number} budget total instances across every pool, from ctx.quality */
  init(ctx, budget) {
    this.budget = Math.max(400, budget | 0);
    const texSize = this.budget >= 8000 ? 128 : 64;

    this.sprites.set('smoke', createSmokeSprite(texSize, 1337));
    this.sprites.set('dust', createDustSprite(texSize, 4211));
    this.sprites.set('streak', createStreakSprite(Math.max(32, texSize >> 1), 7717));
    this.sprites.set('chunk', createChunkSprite(Math.max(32, texSize >> 1), 9091));
    this.sprites.set('droplet', createDropletSprite(Math.max(32, texSize >> 1)));
    this.sprites.set('splash', createSplashSprite(Math.max(32, texSize >> 1)));
    this.sprites.set('flame', createFlameSprite(texSize, 5533));

    // The fractions below sum to 0.72; the remaining 0.28 of the budget belongs to
    // Weather's rain volume, so the worst simultaneous case still fits the tier.
    const cap = (fraction) => Math.max(48, Math.round(this.budget * fraction));

    this.createPool('smoke', {
      capacity: cap(0.24),
      map: this.sprites.get('smoke'),
      lit: true,
      soft: true,
      softness: 1.15,
      scatter: 1.35,
      fadeIn: 0.10,
      fadeOut: 1.65,
      growth: 1.55,
      renderOrder: 12,
    });

    this.createPool('dust', {
      capacity: cap(0.10),
      map: this.sprites.get('dust'),
      lit: true,
      soft: true,
      softness: 0.95,
      scatter: 0.55,
      fadeIn: 0.08,
      fadeOut: 1.9,
      growth: 1.4,
      renderOrder: 11,
    });

    this.createPool('spray', {
      capacity: cap(0.14),
      map: this.sprites.get('smoke'),
      lit: true,
      soft: true,
      softness: 1.0,
      scatter: 2.1,
      fadeIn: 0.06,
      fadeOut: 1.5,
      growth: 1.35,
      renderOrder: 13,
    });

    this.createPool('debris', {
      capacity: cap(0.05),
      map: this.sprites.get('chunk'),
      lit: true,
      soft: false,
      ballistic: true,
      restitution: 0.32,
      friction: 0.55,
      fadeIn: 0,
      fadeOut: 0.35,
      growth: 1.0,
      renderOrder: 14,
    });

    this.createPool('sparks', {
      capacity: cap(0.12),
      map: this.sprites.get('streak'),
      blending: 'additive',
      ballistic: true,
      stretch: true,
      cooling: true,
      soft: false,
      restitution: 0.42,
      friction: 0.74,
      fadeIn: 0,
      fadeOut: 0.9,
      growth: 1.0,
      coolPower: 0.62,
      renderOrder: 22,
    });
    this.pools.get('sparks').setHotCool(1.6, 1.35, 1.05, 1.15, 0.16, 0.02);

    this.createPool('flame', {
      capacity: cap(0.04),
      map: this.sprites.get('flame'),
      blending: 'additive',
      soft: false,
      fadeIn: 0.05,
      fadeOut: 2.4,
      growth: 2.2,
      renderOrder: 21,
    });

    this.createPool('splash', {
      capacity: cap(0.03),
      map: this.sprites.get('splash'),
      lit: false,
      soft: false,
      fadeIn: 0.02,
      fadeOut: 1.2,
      growth: 2.6,
      renderOrder: 13,
    });

    ctx.scene.add(this.group);
    return this;
  }

  createPool(name, options) {
    const pool = new ParticlePool(name, options, this.shared, this.rng);
    this.pools.set(name, pool);
    this.group.add(pool.mesh);
    return pool;
  }

  pool(name) {
    return this.pools.get(name) ?? null;
  }

  /** Fixed-step: advance the spawn clock and recycle. */
  update(dt, ctx) {
    this.simTime = ctx.time.elapsed;
    for (const pool of this.pools.values()) pool.update(this.simTime);
  }

  /**
   * Per-frame: the simulation clock must run at display rate or particles judder
   * against a 120 Hz spawn clock on a 60 Hz screen.
   */
  lateUpdate(alpha, ctx) {
    this.time = ctx.time.elapsed + alpha * ctx.time.dt;
    this.shared.uTime.value = this.time;

    const sky = ctx.sky;
    if (sky) {
      _sunTmp.copy(sky.sunDirection);
      this.shared.uSunDir.value.copy(_sunTmp);
      const w = sky.weather;
      const windX = Math.sin(w.windDir) * w.windSpeed;
      const windZ = -Math.cos(w.windDir) * w.windSpeed;
      this.shared.uWind.value.set(windX, 0, windZ);

      const fog = sky.fogParams;
      if (fog) {
        this.shared.uFogDensity.value = fog.density;
        this.shared.uFogColor.value.set(fog.color.r, fog.color.g, fog.color.b);
      }

      // Smoke is lit by the same disc that lights the car; borrow its colour and a
      // fraction of its intensity rather than inventing a second sun.
      const light = sky.sunLight;
      if (light) {
        const k = clamp(light.intensity * 0.28, 0.08, 2.6);
        this.shared.uSunColor.value.set(light.color.r * k, light.color.g * k, light.color.b * k);
      }
      const amb = 0.16 + 0.30 * clamp01(sky.sunDirection.y + 0.15);
      this.shared.uAmbient.value.set(amb * 0.92, amb * 0.97, amb * 1.12);
    }

    for (const pool of this.pools.values()) pool.flush();
  }

  clear() {
    for (const pool of this.pools.values()) pool.clear();
  }

  stats() {
    let live = 0;
    let capacity = 0;
    for (const pool of this.pools.values()) {
      live += pool.live;
      capacity += pool.capacity;
    }
    return { live, capacity };
  }

  dispose() {
    for (const pool of this.pools.values()) pool.dispose();
    this.pools.clear();
    for (const tex of this.sprites.values()) tex.dispose();
    this.sprites.clear();
    this.group.parent?.remove(this.group);
    this.group.clear();
  }
}
