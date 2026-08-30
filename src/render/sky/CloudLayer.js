import * as THREE from 'three';
import { Rng } from '../../core/Rng.js';
import { clamp, clamp01 } from '../../core/MathUtils.js';

/**
 * Two parallax cloud decks — a cumulus layer at 2.2 km and a cirrus layer at
 * 8 km — evaluated analytically against a single tiling noise atlas.
 *
 * Evaluating four or five octaves of procedural fBm per layer per pixel is the
 * obvious implementation and the wrong one: it costs 40+ ALU-heavy noise samples
 * on every sky pixel. Instead the octaves are baked once, on the CPU, into the
 * four channels of a repeat-wrapped atlas, and the shader recombines them at
 * mutually non-harmonic frequencies with a domain warp on top. That is ~11
 * bilinear fetches for the cumulus deck including its three-tap light march,
 * and the hardware's trilinear filtering antialiases the deck at the horizon
 * for free.
 *
 * Keeping the generator on the CPU also means the same field can be evaluated in
 * JavaScript, which is how the sun's cloud occlusion is computed without a GPU
 * readback.
 */

const ATLAS_PERIODS = [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 128];

/** Octave tables: [lattice period, weight]. Weights are normalised at build time. */
const CUMULUS_BASE_OCTAVES = [[4, 0.5], [8, 0.25], [16, 0.125], [32, 0.0625], [64, 0.0625]];
const CUMULUS_DETAIL_OCTAVES = [[16, 0.48], [32, 0.26], [64, 0.16], [128, 0.1]];
const WARP_OCTAVES = [[2, 0.6], [4, 0.28], [8, 0.12]];
const CIRRUS_OCTAVES = [[3, 0.46], [6, 0.28], [12, 0.16], [24, 0.1]];

export const CLOUD_GLSL = /* glsl */ `
uniform sampler2D uCloudNoise;
uniform float uCloudCover;
uniform vec2  uCloudOffsetLow;
uniform vec2  uCloudOffsetHigh;
uniform float uCloudBaseHeight;
uniform float uCloudCirrusHeight;
uniform float uCloudThickness;
uniform float uCloudScaleLow;
uniform float uCloudScaleHigh;
uniform vec3  uCloudSunColor;
uniform vec3  uCloudAmbient;
uniform float uCloudAbsorption;
uniform float uCloudOpacity;
uniform float uCloudCirrusOpacity;
uniform float uOvercast;

/** Distance from the viewer to a concentric shell at the given altitude. */
float cloudShellDistance( vec3 dir, float height ) {
  if ( dir.y <= 0.004 ) return -1.0;
  float b = ATM_RG * dir.y;
  return - b + sqrt( b * b + 2.0 * ATM_RG * height + height * height );
}

vec2 cloudWarp( vec2 p, float amp ) {
  float a = texture2D( uCloudNoise, p * 0.031 ).b;
  float b = texture2D( uCloudNoise, p * 0.031 + vec2( 0.43, 0.17 ) ).b;
  return ( vec2( a, b ) - 0.5 ) * amp;
}

float cloudThreshold( float cover ) {
  return mix( 0.80, 0.14, cover );
}

/**
 * Full-detail cumulus density at an already-warped field position. The soften
 * argument widens the coverage decision with distance: past ten kilometres the
 * deck is sub-pixel and a hard threshold aliases into radial streaks that
 * converge on the horizon, so the far field is turned back into haze.
 */
float cloudCumulus( vec2 p, float cover, float soften ) {
  float base = texture2D( uCloudNoise, p * 0.25 ).r;
  float mid  = texture2D( uCloudNoise, p * 0.617 + vec2( 0.13, 0.71 ) ).r;
  float det  = texture2D( uCloudNoise, p * 1.873 ).g;
  float f = base * 0.66 + mid * 0.24 + det * 0.10;
  float t = cloudThreshold( cover );
  return smoothstep( t - soften * 0.22, t + mix( 0.20, 0.08, cover ) + soften * 0.55, f );
}

/** Two-fetch variant for the light march, where detail octaves are invisible. */
float cloudCumulusCoarse( vec2 p, float cover, float soften ) {
  float base = texture2D( uCloudNoise, p * 0.25 ).r;
  float mid  = texture2D( uCloudNoise, p * 0.617 + vec2( 0.13, 0.71 ) ).r;
  float f = base * 0.72 + mid * 0.28;
  float t = cloudThreshold( cover );
  return smoothstep( t - soften * 0.22, t + mix( 0.20, 0.08, cover ) + soften * 0.55, f );
}

float cloudCirrus( vec2 p, float cover, float soften ) {
  vec2 q = p + cloudWarp( p * 0.45, 1.4 );
  q = vec2( q.x * 0.35, q.y * 1.25 );
  float a = texture2D( uCloudNoise, q * 0.45 ).a;
  float b = texture2D( uCloudNoise, q * 1.351 + vec2( 0.31, 0.62 ) ).a;
  float f = a * 0.66 + b * 0.34;
  float t = mix( 0.74, 0.40, cover );
  return smoothstep( t - soften * 0.2, t + 0.24 + soften * 0.6, f );
}

/** Henyey-Greenstein normalised so an isotropic phase returns 1.0. */
float cloudPhase( float mu, float g ) {
  float g2 = g * g;
  return ( 1.0 - g2 ) / pow( max( 1.0 + g2 - 2.0 * g * mu, 1e-4 ), 1.5 );
}

vec3 cloudComposite( vec3 dir, vec3 sky, vec3 sunDir ) {
  if ( uCloudOpacity <= 0.002 && uCloudCirrusOpacity <= 0.002 ) return sky;

  float cover = uCloudCover;
  float mu = dot( dir, sunDir );
  // A strong forward lobe plus a weak back lobe: the first is the silver lining,
  // the second keeps the anti-solar side from going flat.
  float phase = 0.62 + 2.4 * cloudPhase( mu, 0.78 ) + 0.35 * cloudPhase( mu, -0.28 );
  vec3 result = sky;

  float tHigh = cloudShellDistance( dir, uCloudCirrusHeight );
  if ( tHigh > 0.0 && uCloudCirrusOpacity > 0.002 ) {
    float spanHigh = max( tHigh - uCloudCirrusHeight, 0.0 );
    float softHigh = min( spanHigh * 8.0e-6, 1.2 );
    float reachHigh = exp( - spanHigh * 1.6e-5 );
    vec2 p = dir.xz * ( tHigh * uCloudScaleHigh ) + uCloudOffsetHigh;
    float d = cloudCirrus( p, cover, softHigh );
    if ( d > 0.001 ) {
      // Ice crystals are optically thin: mostly forward-scattered sunlight with
      // very little self-shadowing, which is why cirrus glows rather than darkens.
      // The single-scatter albedo of a cirrus deck is a few percent, not unity —
      // treating it as an opaque white sheet is what makes fake skies look painted.
      vec3 col = uCloudSunColor * ( 0.06 + 0.13 * phase ) + uCloudAmbient * 0.35;
      float aerial = 1.0 - exp( - spanHigh * 3.0e-5 );
      col = mix( col, sky, aerial * 0.9 );
      float a = d * uCloudCirrusOpacity * reachHigh * smoothstep( 0.028, 0.16, dir.y );
      result = mix( result, col, clamp( a, 0.0, 1.0 ) );
    }
  }

  float tLow = cloudShellDistance( dir, uCloudBaseHeight );
  if ( tLow > 0.0 && uCloudOpacity > 0.002 ) {
    float spanLow = max( tLow - uCloudBaseHeight, 0.0 );
    float softLow = min( spanLow * 2.6e-5, 1.2 );
    float reachLow = exp( - spanLow * 4.2e-5 );
    vec2 p = dir.xz * ( tLow * uCloudScaleLow ) + uCloudOffsetLow;
    p += cloudWarp( p, 0.60 );
    float d = cloudCumulus( p, cover, softLow );
    if ( d > 0.002 ) {
      // Horizontal offset the sunlight travels while crossing the deck: the
      // cotangent of the solar elevation, so shadows rake across at sunset.
      vec2 sunStep = sunDir.xz * ( uCloudThickness * uCloudScaleLow / max( sunDir.y, 0.06 ) );
      float tau = d * 0.45;
      tau += cloudCumulusCoarse( p + sunStep * 0.35, cover, softLow ) * 0.40;
      #if CLOUD_LIGHT_TAPS > 1
        tau += cloudCumulusCoarse( p + sunStep * 0.90, cover, softLow ) * 0.28;
      #endif
      #if CLOUD_LIGHT_TAPS > 2
        tau += cloudCumulusCoarse( p + sunStep * 1.85, cover, softLow ) * 0.17;
      #endif
      float T = exp( - tau * uCloudAbsorption );
      // Powder term: multiple scattering brightens optically thick cores while
      // the wispy edges stay dark, which is what reads as volume.
      float powder = 1.0 - exp( - d * 2.6 );
      vec3 lit = uCloudSunColor * T * ( 0.34 + 0.66 * powder ) * phase;
      vec3 amb = uCloudAmbient * ( 0.50 + 0.50 * ( 1.0 - d ) );
      vec3 col = lit + amb;
      float aerial = 1.0 - exp( - spanLow * 1.1e-4 );
      col = mix( col, sky, aerial * 0.9 );
      float a = d * uCloudOpacity * reachLow * smoothstep( 0.018, 0.10, dir.y );
      result = mix( result, col, clamp( a, 0.0, 1.0 ) );
    }
  }

  if ( uOvercast > 0.001 ) {
    // Full overcast is not "lots of clouds", it is a featureless luminance ramp,
    // so the last stretch of coverage flattens the whole dome towards one.
    // Keep a zenith-to-horizon luminance ramp: a perfectly uniform grey dome is
    // the giveaway that overcast was faked with a flat colour.
    vec3 deck = ( uCloudAmbient * 1.25 + uCloudSunColor * 0.05 ) * ( 0.62 + 0.5 * clamp( dir.y, 0.0, 1.0 ) );
    result = mix( result, deck, uOvercast * smoothstep( -0.05, 0.22, dir.y ) );
  }

  return result;
}
`;

function makeLattice(period, rng) {
  const data = new Float32Array(period * period);
  for (let i = 0; i < data.length; i++) data[i] = rng.next();
  return data;
}

function sampleLattice(data, period, x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  let x0 = xi % period;
  if (x0 < 0) x0 += period;
  let y0 = yi % period;
  if (y0 < 0) y0 += period;
  const x1 = x0 + 1 === period ? 0 : x0 + 1;
  const y1 = y0 + 1 === period ? 0 : y0 + 1;
  const r0 = y0 * period;
  const r1 = y1 * period;
  const a = data[r0 + x0];
  const b = data[r0 + x1];
  const c = data[r1 + x0];
  const d = data[r1 + x1];
  const top = a + (b - a) * sx;
  const bottom = c + (d - c) * sx;
  return top + (bottom - top) * sy;
}

export class CloudLayer {
  constructor(options = {}) {
    this.size = options.size ?? 256;
    this.baseHeight = options.baseHeight ?? 2200;
    this.cirrusHeight = options.cirrusHeight ?? 8000;
    this.thickness = options.thickness ?? 950;
    this.scaleLow = options.scaleLow ?? 0.0012;
    this.scaleHigh = options.scaleHigh ?? 0.00028;

    this._rng = new Rng(options.seed ?? 0x51c0d5);
    this._lattices = new Map();
    this.texture = null;

    this._offsetLow = new THREE.Vector2();
    this._offsetHigh = new THREE.Vector2();
    this._cover = 0.25;

    this.uniforms = {
      uCloudNoise: { value: null },
      uCloudCover: { value: this._cover },
      uCloudOffsetLow: { value: this._offsetLow },
      uCloudOffsetHigh: { value: this._offsetHigh },
      uCloudBaseHeight: { value: this.baseHeight },
      uCloudCirrusHeight: { value: this.cirrusHeight },
      uCloudThickness: { value: this.thickness },
      uCloudScaleLow: { value: this.scaleLow },
      uCloudScaleHigh: { value: this.scaleHigh },
      uCloudSunColor: { value: new THREE.Vector3(1, 1, 1) },
      uCloudAmbient: { value: new THREE.Vector3(0.2, 0.24, 0.32) },
      uCloudAbsorption: { value: 3.4 },
      uCloudOpacity: { value: 1.0 },
      uCloudCirrusOpacity: { value: 0.55 },
      uOvercast: { value: 0.0 },
    };
  }

  /** Bake the noise atlas. Runs once, behind the loading screen. */
  build() {
    for (const p of ATLAS_PERIODS) this._lattices.set(p, makeLattice(p, this._rng));

    const n = this.size;
    const data = new Uint8Array(n * n * 4);
    const inv = 1 / n;
    for (let j = 0; j < n; j++) {
      const v = j * inv;
      for (let i = 0; i < n; i++) {
        const u = i * inv;
        const o = (j * n + i) * 4;
        data[o] = Math.round(255 * clamp01(this.fbmBase(u, v)));
        data[o + 1] = Math.round(255 * clamp01(this.fbmDetail(u, v)));
        data[o + 2] = Math.round(255 * clamp01(this.fbmWarp(u, v)));
        data[o + 3] = Math.round(255 * clamp01(this.fbmCirrus(u, v)));
      }
    }

    const tex = new THREE.DataTexture(data, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;

    this.texture = tex;
    this.uniforms.uCloudNoise.value = tex;
    return this;
  }

  _octaves(table, u, v) {
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < table.length; i++) {
      const period = table[i][0];
      const w = table[i][1];
      sum += sampleLattice(this._lattices.get(period), period, u * period, v * period) * w;
      norm += w;
    }
    return sum / norm;
  }

  fbmBase(u, v) {
    // Billow shaping: squaring the fBm pushes the histogram towards flat-bottomed,
    // domed cells instead of the symmetric blobs raw value noise produces.
    const f = this._octaves(CUMULUS_BASE_OCTAVES, u, v);
    return f * f * (3 - 2 * f);
  }

  fbmDetail(u, v) {
    return this._octaves(CUMULUS_DETAIL_OCTAVES, u, v);
  }

  fbmWarp(u, v) {
    return this._octaves(WARP_OCTAVES, u, v);
  }

  fbmCirrus(u, v) {
    // Ridged noise gives the sharp filament edges that read as ice crystal streaks.
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < CIRRUS_OCTAVES.length; i++) {
      const period = CIRRUS_OCTAVES[i][0];
      const w = CIRRUS_OCTAVES[i][1];
      const s = sampleLattice(this._lattices.get(period), period, u * period, v * period);
      sum += (1 - Math.abs(s * 2 - 1)) * w;
      norm += w;
    }
    return sum / norm;
  }

  /**
   * Advance the decks. `windX`/`windZ` are the world-space wind velocity in m/s;
   * cloud layers run faster than the surface wind, and the cirrus deck faster
   * still because it sits in the jet stream. Allocation-free.
   */
  update(dt, windX, windZ, cover) {
    this._cover = cover;
    this.uniforms.uCloudCover.value = cover;
    this.uniforms.uOvercast.value = clamp01((cover - 0.80) / 0.20) ** 1.4 * 0.72;

    const low = 1.45;
    const high = 3.2;
    this._offsetLow.x -= windX * dt * this.scaleLow * low;
    this._offsetLow.y -= windZ * dt * this.scaleLow * low;
    this._offsetHigh.x -= windX * dt * this.scaleHigh * high;
    this._offsetHigh.y -= windZ * dt * this.scaleHigh * high;

    // Keep the offsets small so single-precision texture coordinates stay exact.
    if (Math.abs(this._offsetLow.x) > 4096) this._offsetLow.x %= 4096;
    if (Math.abs(this._offsetLow.y) > 4096) this._offsetLow.y %= 4096;
    if (Math.abs(this._offsetHigh.x) > 4096) this._offsetHigh.x %= 4096;
    if (Math.abs(this._offsetHigh.y) > 4096) this._offsetHigh.y %= 4096;
  }

  _cumulusDensity(px, py, cover) {
    const base = this.fbmBase(px * 0.25, py * 0.25);
    const mid = this.fbmBase(px * 0.617 + 0.13, py * 0.617 + 0.71);
    const det = this.fbmDetail(px * 1.873, py * 1.873);
    const f = base * 0.66 + mid * 0.24 + det * 0.1;
    const t = 0.8 + (0.14 - 0.8) * cover;
    const w = 0.2 + (0.08 - 0.2) * cover;
    const x = clamp01((f - t) / Math.max(w, 1e-4));
    return x * x * (3 - 2 * x);
  }

  _cirrusDensity(px, py, cover) {
    const wx = (this.fbmWarp(px * 0.45 * 0.031, py * 0.45 * 0.031) - 0.5) * 1.4;
    const wy = (this.fbmWarp(px * 0.45 * 0.031 + 0.43, py * 0.45 * 0.031 + 0.17) - 0.5) * 1.4;
    const qx = (px + wx) * 0.35;
    const qy = (py + wy) * 1.25;
    const a = this.fbmCirrus(qx * 0.45, qy * 0.45);
    const b = this.fbmCirrus(qx * 1.351 + 0.31, qy * 1.351 + 0.62);
    const f = a * 0.66 + b * 0.34;
    const t = 0.66 + (0.34 - 0.66) * cover;
    const x = clamp01((f - t) / 0.24);
    return x * x * (3 - 2 * x);
  }

  /**
   * CPU evaluation of how much of the sun the decks are hiding, 0..1. This is the
   * same field the shader draws, so the lens flare dims exactly when a cloud
   * crosses the disc — no depth read-back, no GPU query latency.
   */
  sunTransmittance(sunX, sunY, sunZ) {
    if (sunY <= 0.02) return 0;
    const cover = this._cover;
    let tau = 0;

    if (this.uniforms.uCloudOpacity.value > 0.002) {
      const b = 6360000 * sunY;
      const t = -b + Math.sqrt(b * b + 2 * 6360000 * this.baseHeight + this.baseHeight * this.baseHeight);
      const s = t * this.scaleLow;
      const px = sunX * s + this._offsetLow.x;
      const py = sunZ * s + this._offsetLow.y;
      const wx = (this.fbmWarp(px * 0.031, py * 0.031) - 0.5) * 0.6;
      const wy = (this.fbmWarp(px * 0.031 + 0.43, py * 0.031 + 0.17) - 0.5) * 0.6;
      tau += this._cumulusDensity(px + wx, py + wy, cover) * 2.6 * this.uniforms.uCloudOpacity.value;
    }

    if (this.uniforms.uCloudCirrusOpacity.value > 0.002) {
      const b = 6360000 * sunY;
      const t = -b + Math.sqrt(b * b + 2 * 6360000 * this.cirrusHeight + this.cirrusHeight * this.cirrusHeight);
      const s = t * this.scaleHigh;
      tau += this._cirrusDensity(sunX * s + this._offsetHigh.x, sunZ * s + this._offsetHigh.y, cover)
        * 0.55 * this.uniforms.uCloudCirrusOpacity.value;
    }

    return clamp(Math.exp(-tau), 0, 1);
  }

  dispose() {
    this.texture?.dispose();
    this.texture = null;
    this.uniforms.uCloudNoise.value = null;
    this._lattices.clear();
  }
}
