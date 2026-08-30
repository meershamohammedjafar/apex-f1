import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';

import { QUALITY_TIERS } from '../core/Settings.js';
import { clamp, clamp01, smoothstep } from '../core/MathUtils.js';
import { Rng } from '../core/Rng.js';

import { VelocityBuffer } from './shaders/VelocityBuffer.js';
import {
  TileMaxShader,
  NeighbourMaxShader,
  MotionBlurShader,
  GodrayOnlyShader,
  FULLSCREEN_VERTEX,
} from './shaders/MotionBlurShader.js';
import {
  LuminanceShader,
  LuminanceReduceShader,
  ExposureAdaptShader,
} from './shaders/TonemapShader.js';
import { FinalCompositeShader, createLensDirtTexture } from './shaders/LensShader.js';
import {
  GodrayOcclusionShader,
  GodrayBlurShader,
  sunScreenFade,
} from './shaders/GodrayShader.js';

/**
 * APEX post-processing pipeline.
 *
 * Chain, in execution order:
 *
 *   scene (HDR + depth)
 *     -> velocity buffer (camera reprojection + per-object history matrices)
 *     -> GTAO
 *     -> TAA resolve (folds the AO apply in; see below)
 *     -> tile max / neighbour max -> motion blur (folds the godray composite in)
 *     -> bloom pyramid + auto-exposure metering
 *     -> tonemap + grade + lens + flare + vignette + grain  [one pass]
 *     -> SMAA / FXAA
 *     -> screen
 *
 * Two deliberate departures from the naive reading of the required order:
 *
 *  - The TAA resolve sits before motion blur rather than at the end. Temporal
 *    accumulation has to happen on the jittered, pre-blur image or the history buffer
 *    accumulates smear and every frame re-blurs the previous frame's blur. SMAA still
 *    runs last, on the display-referred image, which is where spatial AA belongs.
 *  - Godrays are composited inside the motion-blur pass rather than as their own
 *    fullscreen round trip. They still land before bloom, so the shafts bloom.
 *
 * Everything runs at HalfFloatType until the final pass writes display-referred sRGB.
 *
 * The chain is driven explicitly rather than through EffectComposer's implicit
 * read/write ping-pong. The composer cannot express a pass that reads two of our
 * private buffers at once (the resolve reads scene + AO + velocity + history) or a
 * pass that consumes a target it did not write, and its buffer clone would hand the
 * scene target a second depth attachment we would then have to keep in sync. What is
 * here is the same structure — a shared FullScreenQuad, `Pass`-compatible stages, an
 * A/B pair of HDR buffers — with the buffer routing stated instead of inferred.
 */

const TILE_SIZE = 20;
const HISTORY_JITTER_COUNT = 16;
const CAPTURE_CONVERGENCE_FRAMES = 24;

/**
 * Grade compensation once the sun is down, as a multiplier on the metered exposure.
 *
 * Auto-exposure is a normaliser: point it at a night lap and it will hand back the same
 * median a sunlit lap gets, and the night race renders as a grey day. The meter cannot
 * tell the two apart either — a floodlit night frame carries brighter highlights than a
 * chase frame in daylight, so its log-average reads *higher*, and raising the exposure
 * ceiling far enough to expose the chase shot correctly takes the night frame with it.
 * The one thing that does separate them is not in the image at all: the sun is below the
 * horizon. So the grade, not the meter, carries the difference.
 */
const NIGHT_EXPOSURE_COMP = 0.72;
/** Sun elevation (sin) over which the night compensation is released. */
const NIGHT_COMP_RAMP = [-0.02, 0.06];

/**
 * Motion-blur art direction, pinned rather than derived.
 *
 * `MAX_BLUR_PX_1080` is the furthest, in pixels of a 1920x1080 frame, that the
 * reconstruction filter may gather from — every fast pixel is clamped to it, so it is the
 * single number that decides whether the effect reads as speed or as a smudge. It scales
 * with the frame height.
 *
 * The speed gate exists because blur is a *speed* cue: below `BLUR_SPEED_MIN_KPH` there
 * is nothing to cue and the frame should be clean, and it should not reach full strength
 * until the car is genuinely quick. In between it ramps linearly.
 */
const MAX_BLUR_PX_1080 = 24;
const BLUR_SPEED_MIN_KPH = 80;
const BLUR_SPEED_FULL_KPH = 320;

/** Halton(2,3) in [-0.5, 0.5]. Low discrepancy, so 16 frames cover the pixel evenly. */
const JITTER = buildHaltonTable(HISTORY_JITTER_COUNT);

function radicalInverse(index, base) {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

function buildHaltonTable(count) {
  const table = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    table[i * 2] = radicalInverse(i + 1, 2) - 0.5;
    table[i * 2 + 1] = radicalInverse(i + 1, 3) - 0.5;
  }
  return table;
}

/**
 * Per-tier sample budgets. The boolean feature flags come from `ctx.quality` so the
 * settings panel stays authoritative; only the sample counts live here.
 */
const TIER_SAMPLES = {
  low: { aoScale: 0.5, aoDirs: 4, aoSteps: 3, mbSamples: 8, wheelSamples: 6, godraySamples: 12, dirt: 256 },
  medium: { aoScale: 0.5, aoDirs: 5, aoSteps: 3, mbSamples: 10, wheelSamples: 8, godraySamples: 16, dirt: 512 },
  high: { aoScale: 0.5, aoDirs: 6, aoSteps: 4, mbSamples: 14, wheelSamples: 10, godraySamples: 16, dirt: 512 },
  ultra: { aoScale: 1.0, aoDirs: 8, aoSteps: 4, mbSamples: 20, wheelSamples: 12, godraySamples: 24, dirt: 1024 },
};

const AO_SHADER = {
  uniforms: {
    tDepth: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTexel: { value: new THREE.Vector2() },
    uP00: { value: 1 },
    uP11: { value: 1 },
    uNear: { value: 0.05 },
    uFar: { value: 12000 },
    uRadius: { value: 0.85 },
    uBias: { value: 0.09 },
    uIntensity: { value: 1.55 },
    uPower: { value: 1.35 },
    uFrameSeed: { value: 0 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDepth;
    uniform vec2 uResolution;
    uniform vec2 uTexel;
    uniform float uP00;
    uniform float uP11;
    uniform float uNear;
    uniform float uFar;
    uniform float uRadius;
    uniform float uBias;
    uniform float uIntensity;
    uniform float uPower;
    uniform float uFrameSeed;
    varying vec2 vUv;

    float apexViewDist(float d) {
      float ndc = d * 2.0 - 1.0;
      return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
    }

    vec3 apexViewPos(vec2 uv) {
      float z = apexViewDist(texture2D(tDepth, uv).x);
      vec2 ndc = uv * 2.0 - 1.0;
      return vec3(ndc.x / uP00, ndc.y / uP11, -1.0) * z;
    }

    float apexIGN(vec2 p) {
      return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
    }

    void main() {
      float centreDepth = texture2D(tDepth, vUv).x;
      if (centreDepth >= 0.99999) {
        gl_FragColor = vec4(1.0);
        return;
      }

      vec3 c = apexViewPos(vUv);
      float zc = -c.z;

      // Best-of-two derivatives on each axis: taking the closer neighbour stops the
      // reconstructed normal from folding over at silhouettes, which would otherwise
      // draw a bright halo around every wing element.
      vec3 nl = apexViewPos(vUv - vec2(uTexel.x, 0.0));
      vec3 nr = apexViewPos(vUv + vec2(uTexel.x, 0.0));
      vec3 nd = apexViewPos(vUv - vec2(0.0, uTexel.y));
      vec3 nu = apexViewPos(vUv + vec2(0.0, uTexel.y));
      vec3 ddx = abs(nl.z - c.z) < abs(nr.z - c.z) ? (c - nl) : (nr - c);
      vec3 ddy = abs(nd.z - c.z) < abs(nu.z - c.z) ? (c - nd) : (nu - c);
      vec3 n = normalize(cross(ddx, ddy));
      if (n.z < 0.0) n = -n;

      float radiusUv = uRadius * uP00 * 0.5 / max(zc, 0.05);
      float radiusPx = clamp(radiusUv * uResolution.x, 2.0, 110.0);

      float rot = apexIGN(gl_FragCoord.xy + uFrameSeed) * 6.2831853;
      float jitter = apexIGN(gl_FragCoord.yx * 1.371 + uFrameSeed * 1.7);

      float occlusion = 0.0;
      for (int di = 0; di < AO_DIRS; di++) {
        float ang = rot + float(di) * (6.2831853 / float(AO_DIRS));
        vec2 dir = vec2(cos(ang), sin(ang));
        for (int si = 1; si <= AO_STEPS; si++) {
          float t = (float(si) - jitter) / float(AO_STEPS);
          vec2 suv = vUv + dir * (radiusPx * t) / uResolution;
          vec3 sp = apexViewPos(suv);
          vec3 v = sp - c;
          float dist2 = dot(v, v);
          float ndotv = dot(n, v) * inversesqrt(max(dist2, 1e-6));
          float falloff = 1.0 - clamp(dist2 / (uRadius * uRadius), 0.0, 1.0);
          occlusion += clamp(ndotv - uBias, 0.0, 1.0) * falloff;
        }
      }

      float ao = 1.0 - occlusion * uIntensity / float(AO_DIRS * AO_STEPS);
      gl_FragColor = vec4(vec3(pow(clamp(ao, 0.0, 1.0), uPower)), 1.0);
    }
  `,
};

const AO_BLUR_SHADER = {
  uniforms: {
    tAO: { value: null },
    tDepth: { value: null },
    uAxis: { value: new THREE.Vector2() },
    uNear: { value: 0.05 },
    uFar: { value: 12000 },
    uDepthSigma: { value: 0.55 },
    uSourceMin: { value: new THREE.Vector2() },
    uSourceMax: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tAO;
    uniform sampler2D tDepth;
    uniform vec2 uAxis;
    uniform float uNear;
    uniform float uFar;
    uniform float uDepthSigma;
    uniform vec2 uSourceMin;
    uniform vec2 uSourceMax;
    varying vec2 vUv;

    float apexViewDist(float d) {
      float ndc = d * 2.0 - 1.0;
      return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
    }

    void main() {
      float zc = apexViewDist(texture2D(tDepth, vUv).x);
      float sum = 0.0;
      float wsum = 0.0;
      for (int i = -3; i <= 3; i++) {
        // Clamped to the interior: an unclamped separable tap replicates the edge texel
        // along the blur axis, which is exactly how a border streak gets manufactured.
        vec2 uv = clamp(vUv + uAxis * float(i), uSourceMin, uSourceMax);
        float w = exp(-float(i * i) * 0.18);
        float z = apexViewDist(texture2D(tDepth, uv).x);
        w *= exp(-abs(z - zc) / uDepthSigma);
        sum += texture2D(tAO, uv).r * w;
        wsum += w;
      }
      gl_FragColor = vec4(vec3(sum / max(wsum, 1e-4)), 1.0);
    }
  `,
};

const RESOLVE_SHADER = {
  defines: { APEX_TAA: 1 },
  uniforms: {
    tScene: { value: null },
    tAO: { value: null },
    tVelocity: { value: null },
    tHistory: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uTexel: { value: new THREE.Vector2() },
    uJitterUv: { value: new THREE.Vector2() },
    uAoStrength: { value: 0.85 },
    uFeedbackMin: { value: 0.74 },
    uFeedbackMax: { value: 0.93 },
    uClampGamma: { value: 1.15 },
    uHistoryValid: { value: 0 },
    uSharpen: { value: 0.22 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tScene;
    uniform sampler2D tAO;
    uniform sampler2D tVelocity;
    uniform sampler2D tHistory;
    uniform vec2 uResolution;
    uniform vec2 uTexel;
    uniform vec2 uJitterUv;
    uniform float uAoStrength;
    uniform float uFeedbackMin;
    uniform float uFeedbackMax;
    uniform float uClampGamma;
    uniform float uHistoryValid;
    uniform float uSharpen;
    varying vec2 vUv;

    vec3 apexToYCoCg(vec3 c) {
      return vec3(
        0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
        0.5 * c.r - 0.5 * c.b,
        -0.25 * c.r + 0.5 * c.g - 0.25 * c.b
      );
    }

    vec3 apexToRGB(vec3 c) {
      float t = c.x - c.z;
      return vec3(t + c.y, c.x + c.z, t - c.y);
    }

    void main() {
      float ao = mix(1.0, texture2D(tAO, vUv).r, uAoStrength);
      vec3 current = max(texture2D(tScene, vUv).rgb, vec3(0.0)) * ao;

      #if APEX_TAA == 0
        gl_FragColor = vec4(current, 1.0);
      #else
        // AO is applied to the neighbourhood as well as the centre so that the history
        // buffer stores post-AO colour; otherwise the occlusion term compounds every
        // frame and the cockpit turns black.
        vec3 m1 = vec3(0.0);
        vec3 m2 = vec3(0.0);
        vec3 nmin = vec3(1e9);
        vec3 nmax = vec3(-1e9);
        for (int y = -1; y <= 1; y++) {
          for (int x = -1; x <= 1; x++) {
            vec3 s = max(texture2D(tScene, vUv + vec2(float(x), float(y)) * uTexel).rgb, vec3(0.0)) * ao;
            s = apexToYCoCg(s);
            m1 += s;
            m2 += s * s;
            nmin = min(nmin, s);
            nmax = max(nmax, s);
          }
        }
        m1 /= 9.0;
        m2 /= 9.0;
        vec3 sigma = sqrt(max(m2 - m1 * m1, vec3(0.0)));
        vec3 lo = max(m1 - uClampGamma * sigma, nmin);
        vec3 hi = min(m1 + uClampGamma * sigma, nmax);

        vec2 velocity = texture2D(tVelocity, vUv).xy;
        vec2 prevUv = (vUv - uJitterUv) - velocity;

        vec3 history = max(texture2D(tHistory, prevUv).rgb, vec3(0.0));
        vec3 clamped = apexToRGB(clamp(apexToYCoCg(history), lo, hi));
        clamped = max(clamped, vec3(0.0));

        float speedPx = length(velocity * uResolution);
        float feedback = mix(uFeedbackMax, uFeedbackMin, clamp(speedPx / 40.0, 0.0, 1.0));
        feedback *= uHistoryValid;
        if (prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0) feedback = 0.0;

        // Karis weighting: a firefly in the current frame is down-weighted before it
        // can be locked into history and smeared across the next twenty frames.
        float wCur = (1.0 - feedback) / (1.0 + max(apexToYCoCg(current).x, 0.0));
        float wHist = feedback / (1.0 + max(apexToYCoCg(clamped).x, 0.0));
        vec3 result = (current * wCur + clamped * wHist) / max(wCur + wHist, 1e-5);

        // Resampling history bilinearly every frame is what makes naive TAA mushy.
        // A mild unsharp against this frame's neighbourhood mean (the YCoCg transform
        // is linear, so the mean converts back exactly) restores the edge contrast
        // without reintroducing the aliasing TAA just removed.
        result += (result - apexToRGB(m1)) * uSharpen;

        gl_FragColor = vec4(max(result, vec3(0.0)), 1.0);
      #endif
    }
  `,
};

/**
 * Every bloom stage samples its source at fixed texel offsets, so every stage can walk
 * off the edge of that source. With ClampToEdge that turns the outermost row and column
 * into an infinitely wide smear, and because the mip chain cannot halve exactly at odd
 * sizes (1620 -> 810 -> 405 -> 202 -> 101) the offsets do not even land where the filter
 * assumes. Clamping every fetch to the source's half-texel-inset interior fixes both:
 * the filter degrades to a narrower kernel at the border instead of replicating an edge
 * texel across the frame.
 */
const BLOOM_CLAMP_CHUNK = /* glsl */ `
  uniform vec2 uSourceMin;
  uniform vec2 uSourceMax;
  vec2 apexBloomUv(vec2 uv) { return clamp(uv, uSourceMin, uSourceMax); }
`;

const BLOOM_PREFILTER_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    tExposure: { value: null },
    uSourceTexel: { value: new THREE.Vector2() },
    uSourceMin: { value: new THREE.Vector2() },
    uSourceMax: { value: new THREE.Vector2(1, 1) },
    uThreshold: { value: 1.25 },
    uKnee: { value: 0.6 },
    uClamp: { value: 8.0 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform sampler2D tExposure;
    uniform vec2 uSourceTexel;
    uniform float uThreshold;
    uniform float uKnee;
    uniform float uClamp;
    varying vec2 vUv;
${BLOOM_CLAMP_CHUNK}

    float apexLuma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    void main() {
      vec3 a = texture2D(tDiffuse, apexBloomUv(vUv + vec2(-1.0, -1.0) * uSourceTexel)).rgb;
      vec3 b = texture2D(tDiffuse, apexBloomUv(vUv + vec2( 1.0, -1.0) * uSourceTexel)).rgb;
      vec3 c = texture2D(tDiffuse, apexBloomUv(vUv + vec2(-1.0,  1.0) * uSourceTexel)).rgb;
      vec3 d = texture2D(tDiffuse, apexBloomUv(vUv + vec2( 1.0,  1.0) * uSourceTexel)).rgb;

      // Karis average: without it a single sub-pixel specular on a wing endplate
      // pumps the whole bloom pyramid and the frame flickers.
      float wa = 1.0 / (1.0 + apexLuma(a));
      float wb = 1.0 / (1.0 + apexLuma(b));
      float wc = 1.0 / (1.0 + apexLuma(c));
      float wd = 1.0 / (1.0 + apexLuma(d));
      vec3 col = (a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd);

      // The threshold is exposure-relative so a tunnel does not make the whole frame
      // glow the instant the iris opens.
      float exposure = max(texture2D(tExposure, vec2(0.5)).g, 1e-3);
      float threshold = uThreshold / exposure;
      float knee = max(uKnee / exposure, 1e-4);

      float brightest = max(max(col.r, col.g), col.b);
      float soft = clamp(brightest - threshold + knee, 0.0, 2.0 * knee);
      soft = soft * soft / (4.0 * knee);
      float contribution = max(soft, brightest - threshold) / max(brightest, 1e-5);

      col *= contribution;
      col = min(col, vec3(uClamp / exposure));
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

const BLOOM_DOWN_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uSourceTexel: { value: new THREE.Vector2() },
    uSourceMin: { value: new THREE.Vector2() },
    uSourceMax: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uSourceTexel;
    varying vec2 vUv;
${BLOOM_CLAMP_CHUNK}

    void main() {
      vec2 t = uSourceTexel;
      vec3 a = texture2D(tDiffuse, apexBloomUv(vUv + vec2(-2.0, -2.0) * t)).rgb;
      vec3 b = texture2D(tDiffuse, apexBloomUv(vUv + vec2( 0.0, -2.0) * t)).rgb;
      vec3 c = texture2D(tDiffuse, apexBloomUv(vUv + vec2( 2.0, -2.0) * t)).rgb;
      vec3 d = texture2D(tDiffuse, apexBloomUv(vUv + vec2(-1.0, -1.0) * t)).rgb;
      vec3 e = texture2D(tDiffuse, apexBloomUv(vUv + vec2( 1.0, -1.0) * t)).rgb;
      vec3 f = texture2D(tDiffuse, apexBloomUv(vUv + vec2(-2.0,  0.0) * t)).rgb;
      vec3 g = texture2D(tDiffuse, apexBloomUv(vUv)).rgb;
      vec3 h = texture2D(tDiffuse, apexBloomUv(vUv + vec2( 2.0,  0.0) * t)).rgb;
      vec3 i = texture2D(tDiffuse, apexBloomUv(vUv + vec2(-1.0,  1.0) * t)).rgb;
      vec3 j = texture2D(tDiffuse, apexBloomUv(vUv + vec2( 1.0,  1.0) * t)).rgb;
      vec3 k = texture2D(tDiffuse, apexBloomUv(vUv + vec2(-2.0,  2.0) * t)).rgb;
      vec3 l = texture2D(tDiffuse, apexBloomUv(vUv + vec2( 0.0,  2.0) * t)).rgb;
      vec3 m = texture2D(tDiffuse, apexBloomUv(vUv + vec2( 2.0,  2.0) * t)).rgb;

      vec3 result = (d + e + i + j) * 0.125;
      result += (a + b + g + f) * 0.03125;
      result += (b + c + h + g) * 0.03125;
      result += (f + g + l + k) * 0.03125;
      result += (g + h + m + l) * 0.03125;
      gl_FragColor = vec4(result, 1.0);
    }
  `,
};

const BLOOM_UP_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uSourceTexel: { value: new THREE.Vector2() },
    uSourceMin: { value: new THREE.Vector2() },
    uSourceMax: { value: new THREE.Vector2(1, 1) },
    uRadius: { value: 1.0 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uSourceTexel;
    uniform float uRadius;
    varying vec2 vUv;
${BLOOM_CLAMP_CHUNK}

    void main() {
      vec2 t = uSourceTexel * uRadius;
      vec3 s = texture2D(tDiffuse, apexBloomUv(vUv + vec2(-1.0, -1.0) * t)).rgb;
      s += texture2D(tDiffuse, apexBloomUv(vUv + vec2(0.0, -1.0) * t)).rgb * 2.0;
      s += texture2D(tDiffuse, apexBloomUv(vUv + vec2(1.0, -1.0) * t)).rgb;
      s += texture2D(tDiffuse, apexBloomUv(vUv + vec2(-1.0, 0.0) * t)).rgb * 2.0;
      s += texture2D(tDiffuse, apexBloomUv(vUv)).rgb * 4.0;
      s += texture2D(tDiffuse, apexBloomUv(vUv + vec2(1.0, 0.0) * t)).rgb * 2.0;
      s += texture2D(tDiffuse, apexBloomUv(vUv + vec2(-1.0, 1.0) * t)).rgb;
      s += texture2D(tDiffuse, apexBloomUv(vUv + vec2(0.0, 1.0) * t)).rgb * 2.0;
      s += texture2D(tDiffuse, apexBloomUv(vUv + vec2(1.0, 1.0) * t)).rgb;
      gl_FragColor = vec4(s * 0.0625, 1.0);
    }
  `,
};

/**
 * Reduce the godray occlusion mask around the sun to a single visibility number.
 * Read back asynchronously and handed to SkySystem, which cannot test the depth
 * buffer itself.
 */
const SUN_OCCLUSION_SHADER = {
  uniforms: {
    tOcclusion: { value: null },
    uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
    uRadius: { value: new THREE.Vector2(0.035, 0.06) },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tOcclusion;
    uniform vec2 uSunUv;
    uniform vec2 uRadius;
    varying vec2 vUv;

    void main() {
      float sum = 0.0;
      for (int y = -2; y <= 2; y++) {
        for (int x = -2; x <= 2; x++) {
          vec2 offset = vec2(float(x), float(y)) * 0.5 * uRadius;
          sum += texture2D(tOcclusion, clamp(uSunUv + offset, 0.0, 1.0)).a;
        }
      }
      gl_FragColor = vec4(vec3(sum / 25.0), 1.0);
    }
  `,
};

const _size = new THREE.Vector2();
const _viewProjCur = new THREE.Matrix4();
const _viewProjJittered = new THREE.Matrix4();
const _invViewProjJittered = new THREE.Matrix4();
const _sunWorld = new THREE.Vector3();
const _sunProjected = new THREE.Vector3();
const _camForward = new THREE.Vector3();
const _wheelView = new THREE.Vector3();
const _wheelNdc = new THREE.Vector3();
const _blackData = new Uint8Array([0, 0, 0, 255]);
const _whiteData = new Uint8Array([255, 255, 255, 255]);

/**
 * Shutter interval, seconds. A 180-degree shutter at 60 fps would be 1/120 s; broadcast
 * F1 is shot nearer 1/100, and that extra fifth of a stop of movement is most of what
 * makes onboard footage read as fast, so 1/100 is what the blur is normalised to.
 *
 * Normalising at all matters twice over: it stops the blur doubling when the frame rate
 * halves, and it makes a screenshot match gameplay — the capture harness runs several
 * physics steps between presents, so the raw frame-to-frame reprojection is not a
 * shutter at all.
 */
const SHUTTER_SECONDS = 1 / 100;

/**
 * How far outside the viewport the sun may sit and still throw light shafts.
 *
 * `sunVisibility` is a *flare* term: it stays non-zero out to an NDC edge of 1.7 because
 * a sun just off-frame really does put veiling glare into the frame. A shaft is a
 * different thing. The shaft pass is a radial blur about the sun's screen position, so
 * once that origin leaves the viewport the blur no longer traces rays through the frame
 * — it drags whatever sits on the nearest screen edge (here, the sky) straight across
 * everything. Driving shaft intensity off the flare term is what washed cockpit-pack out
 * to a white smear: the sun was at NDC y = 1.27, a quarter-screen above the top edge,
 * still reporting 0.68 visibility.
 *
 * So the shaft gets its own term, at full strength while the disc is on screen and gone
 * shortly after it leaves. The flare term is deliberately left alone.
 */
const SHAFT_EDGE_FULL = 0.95;
const SHAFT_EDGE_GONE = 1.15;

/** Peak arc a wheel may sweep during the shutter, radians. */
const WHEEL_MAX_ARC = 0.85;
/** Below this hub angular rate there is nothing to smear. rad/s. */
const WHEEL_MIN_RATE = 12.0;

export class RenderPipeline {
  static systemName = 'pipeline';

  constructor() {
    this.ctx = null;
    this.renderer = null;

    this.width = 1;
    this.height = 1;

    this._quad = new FullScreenQuad(null);
    this._velocity = new VelocityBuffer();
    this._rng = new Rng(0x5f3a17c1);

    this._config = null;
    this._tierName = 'high';

    this._sceneRT = null;
    this._depthTexture = null;
    this._rtA = null;
    this._rtB = null;
    this._historyRT = [null, null];
    this._historyIndex = 0;
    this._historyValid = 0;

    this._aoRT = null;
    this._aoBlurRT = null;

    this._tileTmpRT = null;
    this._tileMaxRT = null;
    this._neighbourMaxRT = null;

    this._godrayRT = [null, null];

    this._bloomRT = [];

    this._sunOccRT = null;
    this._sunOccPixels = new Uint8Array(4);
    this._sunOccPending = false;

    this._lumRT = null;
    this._lumReduceRT = [];
    this._exposureRT = [null, null];
    this._exposureIndex = 0;
    /**
     * False until a metered value has been written into the ping-pong this allocation.
     * The adaptation shader adopts the meter outright on that first frame instead of
     * slewing away from whatever the driver left in the buffer.
     */
    this._exposureSeeded = false;

    this._materials = {};
    this._smaaPass = null;
    this._fxaaMaterial = null;

    this._dirtTexture = null;
    this._blackTexture = null;
    this._whiteTexture = null;

    this._frame = 0;
    this._lastTime = 0;
    this._motionBlurScale = 1;
    this._sunUvX = 0.5;
    this._sunUvY = 0.5;
    this._shaftFade = 0;
    this._sunFade = 0;
    this._viewProjPrev = new THREE.Matrix4();
    this._viewProjLatched = new THREE.Matrix4();
    // Camera world position at the same two latch points as the view-projections, and
    // the speed derived from them. The blur gate keys off how fast the *lens* is
    // travelling, which is the only thing that is true for every camera mode.
    this._camPosPrev = new THREE.Vector3();
    this._camPosLatched = new THREE.Vector3();
    this._cameraSpeedKph = 0;
    // Simulation time the velocity history was latched at, and the interval it spans.
    // Both drive the shutter; see _advanceMotionHistory.
    this._historyTime = -1;
    this._historySpan = SHUTTER_SECONDS;
    // Bound to the motion-blur material's uWheel0..3 in _buildMaterials so the per-frame
    // update can index them without touching the uniform dictionary.
    this._wheelSlots = null;
    this._settingsUnsub = null;
    this._prevMatricesValid = false;
    this._registeredCars = new Set();
    this._onQualityChange = null;

    this.enabled = true;
  }

  async init(ctx) {
    this.ctx = ctx;
    this.renderer = ctx.renderer;

    this._blackTexture = new THREE.DataTexture(_blackData, 1, 1, THREE.RGBAFormat);
    this._blackTexture.name = 'ApexBlack1x1';
    this._blackTexture.needsUpdate = true;

    this._whiteTexture = new THREE.DataTexture(_whiteData, 1, 1, THREE.RGBAFormat);
    this._whiteTexture.name = 'ApexWhite1x1';
    this._whiteTexture.needsUpdate = true;

    this._buildMaterials();

    this._tierName = ctx.quality?.name ?? ctx.settings?.get('quality') ?? 'high';
    this._config = this._resolveConfig(this._tierName);

    this._dirtTexture = createLensDirtTexture(this._config.samples.dirt, this._rng);
    const finalUniforms = this._materials.final.uniforms;
    finalUniforms.tDirt.value = this._dirtTexture ?? this._blackTexture;

    this.renderer.getDrawingBufferSize(_size);
    this._allocate(_size.x, _size.y);
    this._applyConfig();
    this._applySettings();

    this._onQualityChange = (tier) => this.setQuality(tier);
    ctx.events.on('quality:change', this._onQualityChange);

    this._settingsUnsub = ctx.settings?.onChange?.((key) => {
      if (key === 'motionBlurStrength' || key === 'filmGrain' || key === 'chromaticAberration') {
        this._applySettings();
      }
    }) ?? null;

    this._syncDynamics();
    this._lastTime = (globalThis.performance ?? Date).now();
  }

  _buildMaterials() {
    const make = (def) =>
      new THREE.ShaderMaterial({
        name: def.name ?? 'ApexPost',
        defines: Object.assign({}, def.defines),
        uniforms: THREE.UniformsUtils.clone(def.uniforms),
        vertexShader: def.vertexShader,
        fragmentShader: def.fragmentShader,
        blending: THREE.NoBlending,
        depthTest: false,
        depthWrite: false,
      });

    this._materials.ao = make(AO_SHADER);
    this._materials.ao.defines.AO_DIRS = 6;
    this._materials.ao.defines.AO_STEPS = 4;

    this._materials.aoBlur = make(AO_BLUR_SHADER);
    this._materials.resolve = make(RESOLVE_SHADER);

    this._materials.tileMax = make(TileMaxShader);
    this._materials.tileMax.defines.TILE_SIZE = TILE_SIZE;
    this._materials.neighbourMax = make(NeighbourMaxShader);
    this._materials.motionBlur = make(MotionBlurShader);
    this._materials.godrayOnly = make(GodrayOnlyShader);

    this._materials.godrayOcclusion = make(GodrayOcclusionShader);
    this._materials.godrayBlur = make(GodrayBlurShader);

    this._materials.bloomPrefilter = make(BLOOM_PREFILTER_SHADER);
    this._materials.bloomDown = make(BLOOM_DOWN_SHADER);
    this._materials.bloomUp = make(BLOOM_UP_SHADER);
    this._materials.bloomUp.blending = THREE.AdditiveBlending;

    this._materials.luminance = make(LuminanceShader);
    this._materials.luminanceReduce = make(LuminanceReduceShader);
    this._materials.exposureAdapt = make(ExposureAdaptShader);

    this._materials.sunOcclusion = make(SUN_OCCLUSION_SHADER);
    this._materials.final = make(FinalCompositeShader);

    const mbu = this._materials.motionBlur.uniforms;
    this._wheelSlots = [mbu.uWheel0.value, mbu.uWheel1.value, mbu.uWheel2.value, mbu.uWheel3.value];

    this._fxaaMaterial = make(FXAAShader);
  }

  _resolveConfig(name) {
    const tier = QUALITY_TIERS[name] ?? QUALITY_TIERS.high;
    const samples = TIER_SAMPLES[tier.name] ?? TIER_SAMPLES.high;
    return {
      tier,
      samples,
      ao: tier.ssao === true,
      motionBlur: tier.motionBlur === true,
      taa: tier.taa === true,
      bloom: tier.bloom !== false,
      bloomMips: clamp((tier.bloomQuality ?? 5) + 1, 3, 7),
      godrays: tier.volumetrics === true,
      aa: tier.antialias ?? 'smaa',
    };
  }

  /** Reconfigure the chain live. Targets that are no longer needed are released here. */
  setQuality(tier) {
    const name = typeof tier === 'string' ? tier : tier?.name;
    if (!name || !QUALITY_TIERS[name]) return;
    if (name === this._tierName && this._config) return;

    this._tierName = name;
    this._config = this._resolveConfig(name);

    if (this._dirtTexture && this._dirtTexture.image?.width !== this._config.samples.dirt) {
      this._dirtTexture.dispose();
      this._dirtTexture = createLensDirtTexture(this._config.samples.dirt, this._rng);
      this._materials.final.uniforms.tDirt.value = this._dirtTexture ?? this._blackTexture;
    }

    this.renderer.getDrawingBufferSize(_size);
    this._allocate(_size.x, _size.y);
    this._applyConfig();
    this._applySettings();
    this._historyValid = 0;
  }

  _applyConfig() {
    const cfg = this._config;
    const m = this._materials;

    if (m.ao.defines.AO_DIRS !== cfg.samples.aoDirs || m.ao.defines.AO_STEPS !== cfg.samples.aoSteps) {
      m.ao.defines.AO_DIRS = cfg.samples.aoDirs;
      m.ao.defines.AO_STEPS = cfg.samples.aoSteps;
      m.ao.needsUpdate = true;
    }

    const taaDefine = cfg.taa ? 1 : 0;
    if (m.resolve.defines.APEX_TAA !== taaDefine) {
      m.resolve.defines.APEX_TAA = taaDefine;
      m.resolve.needsUpdate = true;
    }

    if (
      m.motionBlur.defines.MB_SAMPLES !== cfg.samples.mbSamples ||
      m.motionBlur.defines.WHEEL_SAMPLES !== cfg.samples.wheelSamples
    ) {
      m.motionBlur.defines.MB_SAMPLES = cfg.samples.mbSamples;
      m.motionBlur.defines.WHEEL_SAMPLES = cfg.samples.wheelSamples;
      m.motionBlur.needsUpdate = true;
    }

    if (m.godrayBlur.defines.GODRAY_SAMPLES !== cfg.samples.godraySamples) {
      m.godrayBlur.defines.GODRAY_SAMPLES = cfg.samples.godraySamples;
      m.godrayBlur.needsUpdate = true;
    }

    m.resolve.uniforms.uAoStrength.value = cfg.ao ? 0.85 : 0.0;
    m.resolve.uniforms.uSharpen.value = cfg.taa ? 0.22 : 0.0;
    m.motionBlur.uniforms.uGodrayIntensity.value = 0;
    m.godrayOnly.uniforms.uGodrayIntensity.value = 0;
    m.motionBlur.uniforms.uWheelActive.value = 0;

    if (cfg.aa === 'smaa') {
      if (!this._smaaPass) {
        this._smaaPass = new SMAAPass();
        this._smaaPass.renderToScreen = true;
        this._smaaPass.setSize(this.width, this.height);
      }
    } else if (this._smaaPass) {
      this._smaaPass.dispose();
      this._smaaPass = null;
    }
  }

  _applySettings() {
    const settings = this.ctx?.settings;
    const final = this._materials.final.uniforms;
    const grainScale = settings?.get('filmGrain') ?? 1;
    const caScale = settings?.get('chromaticAberration') ?? 1;

    final.uGrain.value = 0.010 * clamp01(grainScale);
    final.uChroma.value = 0.0016 * clamp(caScale, 0, 3);
    final.uBloomStrength.value = this._config?.bloom ? 0.048 : 0.0;

    this._motionBlurScale = clamp(settings?.get('motionBlurStrength') ?? 1, 0, 2);
  }

  resize(width, height, ctx) {
    const renderer = ctx?.renderer ?? this.renderer;
    if (!renderer) return;
    renderer.getDrawingBufferSize(_size);
    this._allocate(_size.x, _size.y);
    this._historyValid = 0;
  }

  _allocate(rawWidth, rawHeight) {
    const width = Math.max(2, Math.floor(rawWidth));
    const height = Math.max(2, Math.floor(rawHeight));
    const cfg = this._config;

    this.width = width;
    this.height = height;

    this._freeTargets();

    this._depthTexture = new THREE.DepthTexture(width, height, THREE.UnsignedIntType);
    this._depthTexture.format = THREE.DepthFormat;
    this._depthTexture.minFilter = THREE.NearestFilter;
    this._depthTexture.magFilter = THREE.NearestFilter;
    this._depthTexture.name = 'ApexSceneDepth';

    this._sceneRT = this._makeColorTarget(width, height, 'ApexScene', true);
    this._sceneRT.depthTexture = this._depthTexture;

    this._rtA = this._makeColorTarget(width, height, 'ApexPostA', false);
    this._rtB = this._makeColorTarget(width, height, 'ApexPostB', false);

    if (cfg.taa) {
      this._historyRT[0] = this._makeColorTarget(width, height, 'ApexHistory0', false);
      this._historyRT[1] = this._makeColorTarget(width, height, 'ApexHistory1', false);
    }

    this._velocity.setSize(width, height);
    this._velocity.setDepthTexture(this._depthTexture);

    if (cfg.ao) {
      const aw = Math.max(2, Math.round(width * cfg.samples.aoScale));
      const ah = Math.max(2, Math.round(height * cfg.samples.aoScale));
      this._aoRT = this._makeMaskTarget(aw, ah, 'ApexAO');
      this._aoBlurRT = this._makeMaskTarget(aw, ah, 'ApexAOBlur');
    }

    if (cfg.motionBlur) {
      const tw = Math.max(1, Math.ceil(width / TILE_SIZE));
      const th = Math.max(1, Math.ceil(height / TILE_SIZE));
      this._tileTmpRT = this._makeVelocityTarget(tw, height, 'ApexTileMaxX');
      this._tileMaxRT = this._makeVelocityTarget(tw, th, 'ApexTileMax');
      this._neighbourMaxRT = this._makeVelocityTarget(tw, th, 'ApexNeighbourMax');
    }

    if (cfg.godrays) {
      const gw = Math.max(4, Math.round(width * 0.25));
      const gh = Math.max(4, Math.round(height * 0.25));
      this._godrayRT[0] = this._makeColorTarget(gw, gh, 'ApexGodray0', false);
      this._godrayRT[1] = this._makeColorTarget(gw, gh, 'ApexGodray1', false);
      // RGBA8: readRenderTargetPixelsAsync only accepts unsigned-byte RGBA.
      this._sunOccRT = this._makeMaskTarget(1, 1, 'ApexSunOcclusion');
    }

    if (cfg.bloom) {
      let bw = width;
      let bh = height;
      for (let i = 0; i < cfg.bloomMips; i++) {
        // Stop before the chain degenerates. A 2x4 mip carries no usable low frequency
        // and its texel offsets span most of the target, so every tap in the level above
        // it lands on the same handful of texels.
        if (bw < 16 || bh < 16) break;
        bw = Math.max(8, Math.floor(bw / 2));
        bh = Math.max(8, Math.floor(bh / 2));
        this._bloomRT.push(this._makeColorTarget(bw, bh, `ApexBloom${i}`, false));
      }
    }

    this._lumRT = this._makeMeterTarget(64, 64, 'ApexLuminance');
    this._lumReduceRT.push(this._makeMeterTarget(16, 16, 'ApexLuminance16'));
    this._lumReduceRT.push(this._makeMeterTarget(4, 4, 'ApexLuminance4'));
    this._lumReduceRT.push(this._makeMeterTarget(1, 1, 'ApexLuminance1'));
    this._exposureRT[0] = this._makeMeterTarget(1, 1, 'ApexExposure0');
    this._exposureRT[1] = this._makeMeterTarget(1, 1, 'ApexExposure1');

    if (this._smaaPass) this._smaaPass.setSize(width, height);
    if (this._fxaaMaterial) this._fxaaMaterial.uniforms.resolution.value.set(1 / width, 1 / height);

    this._wireUniforms();
    this._clearPersistentTargets();
    this._prevMatricesValid = false;
    this._historyTime = -1;
    this._historySpan = SHUTTER_SECONDS;
    this._historyValid = 0;
  }

  /**
   * Half-float targets come back from the driver with undefined contents. The two that
   * are read before they are written in a frame — the exposure ping-pong and the TAA
   * history — have to start at zero or the first frame can adapt to garbage.
   */
  _clearPersistentTargets() {
    const renderer = this.renderer;
    if (!renderer) return;
    const clear = (target) => {
      if (!target) return;
      renderer.setRenderTarget(target);
      renderer.clear(true, false, false);
    };
    clear(this._exposureRT[0]);
    clear(this._exposureRT[1]);
    this._exposureSeeded = false;
    clear(this._historyRT[0]);
    clear(this._historyRT[1]);
    // The shaft buffers are sampled by the composite even on a frame where the shafts
    // were not rendered (the intensity is zero, but an Inf out of undriven half-float
    // memory times zero is a NaN, and one NaN pixel poisons the bloom pyramid).
    clear(this._godrayRT[0]);
    clear(this._godrayRT[1]);
    for (let i = 0; i < this._bloomRT.length; i++) clear(this._bloomRT[i]);
    renderer.setRenderTarget(null);
  }

  _makeColorTarget(w, h, name, depth) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: depth,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    rt.texture.name = name;
    return rt;
  }

  _makeMaskTarget(w, h, name) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    rt.texture.name = name;
    return rt;
  }

  _makeVelocityTarget(w, h, name) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    rt.texture.name = name;
    return rt;
  }

  _makeMeterTarget(w, h, name) {
    const rt = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    rt.texture.name = name;
    return rt;
  }

  _wireUniforms() {
    const m = this._materials;
    const w = this.width;
    const h = this.height;
    const aspect = w / Math.max(1, h);

    m.ao.uniforms.tDepth.value = this._depthTexture;
    if (this._aoRT) {
      m.ao.uniforms.uResolution.value.set(this._aoRT.width, this._aoRT.height);
      m.ao.uniforms.uTexel.value.set(1 / this._aoRT.width, 1 / this._aoRT.height);
    }
    m.aoBlur.uniforms.tDepth.value = this._depthTexture;
    if (this._aoRT) {
      m.aoBlur.uniforms.uSourceMin.value.set(0.5 / this._aoRT.width, 0.5 / this._aoRT.height);
      m.aoBlur.uniforms.uSourceMax.value.set(
        1 - 0.5 / this._aoRT.width,
        1 - 0.5 / this._aoRT.height,
      );
    }

    m.resolve.uniforms.tScene.value = this._sceneRT.texture;
    m.resolve.uniforms.tAO.value = this._aoRT ? this._aoRT.texture : this._whiteTexture;
    m.resolve.uniforms.tVelocity.value = this._velocity.texture;
    m.resolve.uniforms.uResolution.value.set(w, h);
    m.resolve.uniforms.uTexel.value.set(1 / w, 1 / h);

    m.tileMax.uniforms.tVelocity.value = this._velocity.texture;
    m.motionBlur.uniforms.tVelocity.value = this._velocity.texture;
    m.motionBlur.uniforms.tDepth.value = this._depthTexture;
    m.motionBlur.uniforms.tNeighbourMax.value = this._neighbourMaxRT
      ? this._neighbourMaxRT.texture
      : this._blackTexture;
    m.motionBlur.uniforms.uResolution.value.set(w, h);
    m.motionBlur.uniforms.uTexel.value.set(1 / w, 1 / h);
    m.motionBlur.uniforms.uAspect.value = aspect;
    // The blur ceiling is an art-directed pixel count at the reference frame height, so
    // it has to travel with the resolution: the same streak has to occupy the same
    // fraction of the picture at 720p, at 1080p and on an ultrawide.
    m.motionBlur.uniforms.uMaxBlurPx.value = MAX_BLUR_PX_1080 * (h / 1080);
    m.motionBlur.uniforms.tGodray.value = this._godrayRT[0]
      ? this._godrayRT[0].texture
      : this._blackTexture;

    m.godrayOnly.uniforms.tGodray.value = m.motionBlur.uniforms.tGodray.value;
    m.godrayOnly.uniforms.tDepth.value = this._depthTexture;

    m.godrayOcclusion.uniforms.tDiffuse.value = this._sceneRT.texture;
    m.godrayOcclusion.uniforms.tDepth.value = this._depthTexture;
    m.godrayOcclusion.uniforms.uAspect.value = aspect;

    m.neighbourMax.uniforms.tTileMax.value = this._tileMaxRT ? this._tileMaxRT.texture : this._blackTexture;
    if (this._tileMaxRT) {
      m.neighbourMax.uniforms.uTexel.value.set(1 / this._tileMaxRT.width, 1 / this._tileMaxRT.height);
    }

    m.luminance.uniforms.uTexel.value.set(1 / w, 1 / h);

    m.final.uniforms.uAspect.value = aspect;
    m.final.uniforms.tBloom.value = this._bloomRT.length ? this._bloomRT[0].texture : this._blackTexture;
    m.final.uniforms.tGodray.value = this._godrayRT[0] ? this._godrayRT[0].texture : this._blackTexture;
    m.final.uniforms.tExposure.value = this._exposureRT[0].texture;
    m.final.uniforms.uGrainScale.value = 1080 / Math.max(1, h);
  }

  _freeTargets() {
    const dispose = (rt) => {
      if (rt) rt.dispose();
    };
    dispose(this._sceneRT);
    this._sceneRT = null;
    if (this._depthTexture) this._depthTexture.dispose();
    this._depthTexture = null;
    dispose(this._rtA);
    this._rtA = null;
    dispose(this._rtB);
    this._rtB = null;
    dispose(this._historyRT[0]);
    dispose(this._historyRT[1]);
    this._historyRT[0] = null;
    this._historyRT[1] = null;
    dispose(this._aoRT);
    this._aoRT = null;
    dispose(this._aoBlurRT);
    this._aoBlurRT = null;
    dispose(this._tileTmpRT);
    this._tileTmpRT = null;
    dispose(this._tileMaxRT);
    this._tileMaxRT = null;
    dispose(this._neighbourMaxRT);
    this._neighbourMaxRT = null;
    dispose(this._godrayRT[0]);
    dispose(this._godrayRT[1]);
    this._godrayRT[0] = null;
    this._godrayRT[1] = null;
    dispose(this._sunOccRT);
    this._sunOccRT = null;
    for (let i = 0; i < this._bloomRT.length; i++) dispose(this._bloomRT[i]);
    this._bloomRT.length = 0;
    dispose(this._lumRT);
    this._lumRT = null;
    for (let i = 0; i < this._lumReduceRT.length; i++) dispose(this._lumReduceRT[i]);
    this._lumReduceRT.length = 0;
    dispose(this._exposureRT[0]);
    dispose(this._exposureRT[1]);
    this._exposureRT[0] = null;
    this._exposureRT[1] = null;
  }

  _blit(material, target) {
    this._quad.material = material;
    this.renderer.setRenderTarget(target);
    this._quad.render(this.renderer);
  }

  /**
   * Pick up hierarchies that move through the world, and re-scan for meshes added since.
   *
   * The camera is registered alongside the cars, and not as a courtesy: everything hung
   * off it — the visor surround, the head-up furniture, anything a camera mode parks in
   * front of the lens — travels through the world at 300 km/h while sitting perfectly
   * still on screen. The fullscreen reprojection reads that as the fastest motion in the
   * frame. Per-object matrices cancel the camera term and hand back the zero those
   * pixels are owed, but only for meshes the velocity buffer actually knows about.
   *
   * Registration used to depend on a periodic sweep, which meant a short session — a
   * capture, a menu, the first half-second of a race — could draw its whole life without
   * ever having run one. It runs on the first frame now.
   */
  _syncDynamics() {
    const camera = this.ctx?.camera;
    if (camera && !this._registeredCars.has(camera)) {
      this._registeredCars.add(camera);
      this._velocity.registerDynamic(camera);
    }
    const cars = this.ctx?.cars;
    if (!cars) return;
    const list = Array.isArray(cars) ? cars : cars.cars;
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i++) {
      const group = list[i]?.group;
      if (group && !this._registeredCars.has(group)) {
        this._registeredCars.add(group);
        this._velocity.registerDynamic(group);
      }
    }
    this._velocity.rescan();
  }

  /**
   * Linear HDR colour of the most recently completed scene pass. Read during
   * `lateUpdate` it is one frame stale, which is what the screen-space refractors
   * (heat haze, visor film) want: a source in the same colour space as the buffer
   * they composite into, available on any hardware — unlike the drawing buffer,
   * whose post-present contents are undefined without `preserveDrawingBuffer`.
   */
  get sceneColorTexture() {
    return this._sceneRT ? this._sceneRT.texture : null;
  }

  render(ctx) {
    const renderer = this.renderer;
    const scene = ctx.scene;
    const camera = ctx.camera;
    if (!renderer || !this._sceneRT) return;

    const now = (globalThis.performance ?? Date).now();
    let dt = (now - this._lastTime) / 1000;
    this._lastTime = now;
    if (!(dt > 0) || dt > 0.25) dt = 1 / 60;

    this._frame++;
    if (this._frame === 1 || (this._frame & 31) === 0) this._syncDynamics();

    // Simulation clock, not the wall clock. Everything temporal in the chain keys off
    // this so a frame drawn without the sim advancing (a paused frame, an editor scrub,
    // the capture harness presenting the same state a dozen times) is treated as a
    // re-present of the previous shutter rather than as a zero-length one.
    const simTime = ctx.time?.elapsed ?? this._historyTime + dt;
    const simAdvanced = !(this._historyTime >= 0) || simTime > this._historyTime + 1e-6;

    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();

    const capture = ctx.captureMode === true;
    const useJitter = this._config.taa && !(capture && this._frame > CAPTURE_CONVERGENCE_FRAMES);

    // Unjittered view-projection: the reference frame every reprojection works in.
    _viewProjCur.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this._advanceMotionHistory(simTime, simAdvanced, camera);

    let jitterUvX = 0;
    let jitterUvY = 0;
    const projElements = camera.projectionMatrix.elements;
    const savedM02 = projElements[8];
    const savedM12 = projElements[9];

    if (useJitter) {
      const index = (this._frame % HISTORY_JITTER_COUNT) * 2;
      const jx = JITTER[index];
      const jy = JITTER[index + 1];
      projElements[8] -= (2 * jx) / this.width;
      projElements[9] -= (2 * jy) / this.height;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      jitterUvX = jx / this.width;
      jitterUvY = jy / this.height;
    }

    _viewProjJittered.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _invViewProjJittered.copy(_viewProjJittered).invert();

    // The world matrices were brought up to date at the top of this method and nothing
    // between there and here moves an object, so neither of the two `renderer.render`
    // calls below needs to walk the whole graph again to establish that. Held only
    // across those two calls, and in a `finally` so a throw inside a pass cannot leave
    // the scene with its matrix updates switched off for the rest of the session.
    const sceneAutoUpdate = scene.matrixWorldAutoUpdate;
    scene.matrixWorldAutoUpdate = false;
    try {
      renderer.autoClear = true;
      renderer.setRenderTarget(this._sceneRT);
      renderer.render(scene, camera);

      renderer.autoClear = false;

      const needsVelocity = this._config.motionBlur || this._config.taa;
      if (needsVelocity) {
        this._velocity.setCameraPlanes(camera.near, camera.far);
        this._velocity.setMatrices(_invViewProjJittered, this._viewProjPrev, _viewProjCur, jitterUvX, jitterUvY);
        this._velocity.render(renderer, scene, camera, this._quad, true);
      }
    } finally {
      scene.matrixWorldAutoUpdate = sceneAutoUpdate;
    }

    projElements[8] = savedM02;
    projElements[9] = savedM12;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

    // Every pass that linearises the depth buffer needs the same planes the scene was
    // drawn with; leaving them at the module defaults silently mis-scales the depth
    // comparisons in the blur and the shaft mask.
    const mbu = this._materials.motionBlur.uniforms;
    const gou = this._materials.godrayOnly.uniforms;
    mbu.uNear.value = camera.near;
    mbu.uFar.value = camera.far;
    gou.uNear.value = camera.near;
    gou.uFar.value = camera.far;

    this._renderAO(camera);
    this._updateSun(ctx, camera);
    this._renderShafts(ctx);
    this._updateWheelBlur(ctx, camera);

    const seed = (this._frame % 64) * 13.7;

    const resolve = this._materials.resolve.uniforms;
    resolve.uJitterUv.value.set(jitterUvX, jitterUvY);
    resolve.uHistoryValid.value = this._historyValid;

    let src;
    if (this._config.taa) {
      const read = this._historyRT[this._historyIndex];
      const write = this._historyRT[this._historyIndex ^ 1];
      resolve.tHistory.value = read.texture;
      this._blit(this._materials.resolve, write);
      this._historyIndex ^= 1;
      this._historyValid = 1;
      src = write;
    } else {
      this._blit(this._materials.resolve, this._rtA);
      src = this._rtA;
    }

    src = this._renderMotionBlur(src, seed);

    this._renderMeter(src, dt);
    this._renderBloom(src);

    const useSmaa = this._config.aa === 'smaa' && this._smaaPass !== null;
    const useFxaa = this._config.aa === 'fxaa';
    const dst = useSmaa || useFxaa ? this._pick(src) : null;

    this._renderFinal(ctx, src, dst);

    if (useSmaa) {
      this._smaaPass.renderToScreen = true;
      this._smaaPass.render(renderer, null, dst);
    } else if (useFxaa) {
      this._fxaaMaterial.uniforms.tDiffuse.value = dst.texture;
      this._blit(this._fxaaMaterial, null);
    }

    renderer.setRenderTarget(null);
    renderer.autoClear = true;
  }

  /**
   * Roll the motion history on — but only when the simulation actually moved, and always
   * before the velocity pass reads it.
   *
   * The old code latched `prev = cur` *after* drawing, unconditionally. Draw the same
   * simulated state twice and the second draw compared the camera against itself: every
   * reprojected velocity came out zero, the blur pass early-outed on every pixel, and
   * the frame was pin-sharp at 310 km/h. That is not a capture-harness quirk — any
   * present without a tick behind it (paused, menu open, a frame-rate above the tick
   * rate) hit it. Keeping two matrices per source and only rotating them on a simulated
   * step means a re-presented frame reuses the last real shutter interval instead.
   */
  _advanceMotionHistory(simTime, simAdvanced, camera) {
    if (!this._prevMatricesValid) {
      this._viewProjPrev.copy(_viewProjCur);
      this._viewProjLatched.copy(_viewProjCur);
      this._camPosPrev.setFromMatrixPosition(camera.matrixWorld);
      this._camPosLatched.copy(this._camPosPrev);
      this._cameraSpeedKph = 0;
      this._historyTime = simTime;
      this._prevMatricesValid = true;
      return;
    }
    if (!simAdvanced) return;

    const span = simTime - this._historyTime;
    // Guard the shutter divisor against a scenario reset jumping the clock and against
    // the sub-millisecond spans a very high tick rate can produce.
    if (span > 1e-4 && span < 0.5) this._historySpan = span;
    this._historyTime = simTime;

    this._viewProjPrev.copy(this._viewProjLatched);
    this._viewProjLatched.copy(_viewProjCur);

    this._camPosPrev.copy(this._camPosLatched);
    this._camPosLatched.setFromMatrixPosition(camera.matrixWorld);
    // A camera cut (mode change, scenario reset) teleports the lens; the metres it
    // covered are not speed, and letting them through would flash a full-strength blur
    // over the first frame after the cut.
    const travel = this._camPosLatched.distanceTo(this._camPosPrev);
    const kph = (travel / Math.max(this._historySpan, 1e-4)) * 3.6;
    this._cameraSpeedKph = kph > 700 ? 0 : kph;

    this._velocity.advanceHistory();
  }

  _pick(exclude) {
    return exclude === this._rtA ? this._rtB : this._rtA;
  }

  _renderAO(camera) {
    if (!this._config.ao || !this._aoRT) return;
    const m = this._materials;
    const proj = camera.projectionMatrix.elements;

    m.ao.uniforms.uP00.value = proj[0];
    m.ao.uniforms.uP11.value = proj[5];
    m.ao.uniforms.uNear.value = camera.near;
    m.ao.uniforms.uFar.value = camera.far;
    m.ao.uniforms.uFrameSeed.value = (this._frame % 64) * 7.13;
    this._blit(m.ao, this._aoRT);

    m.aoBlur.uniforms.uNear.value = camera.near;
    m.aoBlur.uniforms.uFar.value = camera.far;
    m.aoBlur.uniforms.tAO.value = this._aoRT.texture;
    m.aoBlur.uniforms.uAxis.value.set(1 / this._aoRT.width, 0);
    this._blit(m.aoBlur, this._aoBlurRT);

    m.aoBlur.uniforms.tAO.value = this._aoBlurRT.texture;
    m.aoBlur.uniforms.uAxis.value.set(0, 1 / this._aoRT.height);
    this._blit(m.aoBlur, this._aoRT);
  }

  /**
   * Project the sun into screen space and drive everything that depends on it: the
   * flare, the streak, the shaft origin and the shaft fade. Runs on every tier, since
   * the lens flare is not conditional on volumetrics being affordable.
   */
  _updateSun(ctx, camera) {
    const m = this._materials;
    const sky = ctx.sky;
    const finalU = m.final.uniforms;

    if (!sky?.sunDirection) {
      finalU.uSunFade.value = 0;
      finalU.uUseGodrayVis.value = 0;
      this._sunFade = 0;
      this._shaftFade = 0;
      return;
    }

    let sunUvX;
    let sunUvY;
    let fade;
    // Distance from the centre of the screen in NDC, along whichever axis leaves the
    // viewport first: <= 1 means the disc is on screen.
    let edge;

    if (sky.sunScreenPosition && typeof sky.sunVisibility === 'number') {
      // SkySystem already projects the disc and folds in horizon, cloud transmittance
      // and its own temporal smoothing. Recomputing it here would give a second,
      // slightly different answer and the flare would fight the sky.
      sunUvX = sky.sunScreenPosition.x * 0.5 + 0.5;
      sunUvY = sky.sunScreenPosition.y * 0.5 + 0.5;
      fade = clamp01(sky.sunVisibility);
      edge = Math.max(Math.abs(sky.sunScreenPosition.x), Math.abs(sky.sunScreenPosition.y));
    } else {
      _sunWorld.copy(camera.position).addScaledVector(sky.sunDirection, 9000);
      _sunProjected.copy(_sunWorld).project(camera);
      camera.getWorldDirection(_camForward);
      const behind = _camForward.dot(sky.sunDirection) <= 0.02;
      sunUvX = _sunProjected.x * 0.5 + 0.5;
      sunUvY = _sunProjected.y * 0.5 + 0.5;
      fade = sunScreenFade(sunUvX, sunUvY, behind) * clamp01(sky.sunDirection.y * 6.0);
      edge = behind ? Infinity : Math.max(Math.abs(_sunProjected.x), Math.abs(_sunProjected.y));
    }

    this._sunUvX = clamp(sunUvX, -0.6, 1.6);
    this._sunUvY = clamp(sunUvY, -0.6, 1.6);
    this._sunFade = fade;
    // Shafts only while the disc is in (or barely out of) frame — see SHAFT_EDGE_FULL.
    this._shaftFade = fade * (1 - smoothstep(SHAFT_EDGE_FULL, SHAFT_EDGE_GONE, edge));

    finalU.uSunUv.value.set(clamp01(sunUvX), clamp01(sunUvY));
    finalU.uSunFade.value = fade;
    if (sky.sunLight?.color) finalU.uSunColor.value.copy(sky.sunLight.color);
  }

  /**
   * Reduce the sky mask around the sun to one texel and read it back without blocking.
   * The promise costs one allocation every sixth frame, which is the price of not
   * stalling the GPU on a synchronous readPixels; a two-frame-old occlusion value is
   * imperceptible on an effect that is already temporally damped inside SkySystem.
   */
  _updateSunOcclusion(ctx) {
    const sky = ctx.sky;
    if (!sky?.setExternalOcclusion || !this._sunOccRT) return;

    const m = this._materials;
    m.sunOcclusion.uniforms.tOcclusion.value = this._godrayRT[1].texture;
    m.sunOcclusion.uniforms.uSunUv.value.set(clamp01(this._sunUvX), clamp01(this._sunUvY));
    this._blit(m.sunOcclusion, this._sunOccRT);

    if (this._sunOccPending || this._frame % 6 !== 0) return;
    this._sunOccPending = true;
    this.renderer
      .readRenderTargetPixelsAsync(this._sunOccRT, 0, 0, 1, 1, this._sunOccPixels)
      .then(() => {
        this._sunOccPending = false;
        ctx.sky?.setExternalOcclusion?.(this._sunOccPixels[0] / 255);
      })
      .catch(() => {
        this._sunOccPending = false;
      });
  }

  _renderShafts(ctx) {
    const m = this._materials;
    const enabled = this._config.godrays && this._godrayRT[0] && this._shaftFade > 0.001;

    m.final.uniforms.uUseGodrayVis.value = enabled ? 1 : 0;

    if (!enabled) {
      m.motionBlur.uniforms.uGodrayIntensity.value = 0;
      m.godrayOnly.uniforms.uGodrayIntensity.value = 0;
      // No shaft buffer this frame, so we have nothing to say about the disc: hand
      // the sky back a clear result rather than freezing the last one.
      ctx.sky?.setExternalOcclusion?.(1);
      return;
    }

    const sunX = this._sunUvX;
    const sunY = this._sunUvY;

    m.godrayOcclusion.uniforms.uSunUv.value.set(sunX, sunY);
    this._blit(m.godrayOcclusion, this._godrayRT[1]);
    this._updateSunOcclusion(ctx);

    const blur = m.godrayBlur.uniforms;
    blur.uSunUv.value.set(sunX, sunY);
    blur.uFrameSeed.value = (this._frame % 64) * 3.71;

    // Three widening passes: a tight one to build the shaft, then two that stretch it
    // out to the frame edge without needing 48 taps in a single loop.
    blur.tDiffuse.value = this._godrayRT[1].texture;
    blur.uDensity.value = 0.55;
    blur.uWeight.value = 0.38;
    blur.uDecay.value = 0.962;
    this._blit(m.godrayBlur, this._godrayRT[0]);

    blur.tDiffuse.value = this._godrayRT[0].texture;
    blur.uDensity.value = 0.22;
    blur.uWeight.value = 0.55;
    blur.uDecay.value = 0.975;
    this._blit(m.godrayBlur, this._godrayRT[1]);

    blur.tDiffuse.value = this._godrayRT[1].texture;
    blur.uDensity.value = 0.09;
    blur.uWeight.value = 0.62;
    blur.uDecay.value = 0.985;
    this._blit(m.godrayBlur, this._godrayRT[0]);

    const intensity = 0.85 * this._shaftFade;
    m.motionBlur.uniforms.uGodrayIntensity.value = intensity;
    m.godrayOnly.uniforms.uGodrayIntensity.value = intensity;

    const sunColor = ctx.sky?.sunLight?.color;
    if (sunColor) {
      m.motionBlur.uniforms.uGodrayTint.value.copy(sunColor);
      m.godrayOnly.uniforms.uGodrayTint.value.copy(sunColor);
    }
  }

  /**
   * Project each wheel of the player car into screen space and hand the motion-blur pass
   * the arc it sweeps during the shutter.
   *
   * The reprojection field cannot supply this on its own. A wheel hub travels with the
   * car, so relative to a cockpit camera it barely moves — but its rim is turning at
   * ~240 rad/s at 310 km/h, which is a full revolution every four frames. Screen-space
   * velocity for that is both enormous and aliased, so the tread and the rim spokes come
   * out looking stationary. Blurring along the wheel's own arc instead is what every
   * racing title does, and it is the difference between a rolling tyre and a photograph
   * of a parked one.
   */
  _updateWheelBlur(ctx, camera) {
    const u = this._materials.motionBlur.uniforms;
    u.uWheelActive.value = 0;

    if (!this._config.motionBlur || this._motionBlurScale <= 0.001) return;

    const car = Array.isArray(ctx.cars) ? ctx.cars[0] : ctx.cars?.cars?.[0];
    const wheels = (ctx.vehicle ?? car?.physics)?.state?.wheels;
    if (!wheels) return;

    const shutter = SHUTTER_SECONDS * this._motionBlurScale;
    const p11 = camera.projectionMatrix.elements[5];
    const speed = Math.abs((ctx.vehicle ?? car?.physics)?.state?.speed ?? 0);
    let any = 0;

    for (let i = 0; i < 4; i++) {
      const slot = this._wheelSlots[i];
      slot.set(0, 0, 0, 0);
      this._setWheelDepth(u.uWheelDepth.value, i, 0);

      const wheel = i < wheels.length ? wheels[i] : null;
      const pos = wheel?.worldPosition;
      if (!pos) continue;

      const rate = Math.abs(wheel.angularVelocity ?? 0);
      if (rate < WHEEL_MIN_RATE) continue;

      _wheelView.copy(pos).applyMatrix4(camera.matrixWorldInverse);
      const viewDist = -_wheelView.z;
      if (!(viewDist > camera.near)) continue;

      _wheelNdc.copy(pos).project(camera);
      // A generous off-frame margin: a wheel whose hub is just outside the frustum still
      // has tread inside it, and rejecting it would put a hard edge down the border.
      if (Math.abs(_wheelNdc.x) > 1.6 || Math.abs(_wheelNdc.y) > 1.6) continue;

      // Rolling radius from the kinematics the physics already solved: at these rates
      // slip is a percent or two, so |v| / |omega| is the tyre radius to well inside a
      // pixel, and it needs no new field on WheelState.
      const radius = clamp(speed / rate, 0.20, 0.60);

      // Half-height of the frustum at this distance is viewDist / p11, so a sphere of
      // `radius` subtends radius * p11 / viewDist in NDC-y, half that in UV.
      const radiusUv = (0.5 * radius * p11) / viewDist;
      if (radiusUv < 0.004) continue;

      slot.set(
        _wheelNdc.x * 0.5 + 0.5,
        _wheelNdc.y * 0.5 + 0.5,
        radiusUv,
        Math.min(rate * shutter, WHEEL_MAX_ARC),
      );
      this._setWheelDepth(u.uWheelDepth.value, i, viewDist);
      any = 1;
    }

    u.uWheelActive.value = any;
  }

  /** GLSL ES 1.00 forbids dynamic indexing of a vector, so the JS side unpacks it too. */
  _setWheelDepth(vec, index, value) {
    if (index === 0) vec.x = value;
    else if (index === 1) vec.y = value;
    else if (index === 2) vec.z = value;
    else vec.w = value;
  }

  _renderMotionBlur(src, seed) {
    const m = this._materials;
    const cfg = this._config;
    const mb = m.motionBlur.uniforms;

    // Speed gate. The camera's own travel is the honest measure and covers every camera
    // mode, but a broadcast camera bolted to a post is stationary while the cars it is
    // watching are not, so the player's road speed sets a floor.
    const carKph = Math.abs(this.ctx?.vehicle?.state?.speedKph ?? 0);
    const refKph = Math.max(this._cameraSpeedKph, carKph);
    const speedScale = clamp(
      (refKph - BLUR_SPEED_MIN_KPH) / (BLUR_SPEED_FULL_KPH - BLUR_SPEED_MIN_KPH),
      0,
      1,
    );
    mb.uSpeedScale.value = speedScale;

    /*
     * Below the gate the blur pass is the identity, exactly, and running it is four
     * render targets of wasted fill.
     *
     * That is not an approximation to check by eye. `strength` in MotionBlurShader is
     * `shutter * uSpeedScale * clarity * depthScale`, so a zero speed scale zeroes the
     * gathered vector for every pixel, `lenVmax` lands under the one-pixel floor and the
     * reconstruction block never runs; the rotational block is gated separately on
     * `uWheelActive`. What the pass then writes is `centre + apexShaft(...)`, which is
     * character for character what GodrayOnlyShader writes — the two share
     * GODRAY_MASK_CHUNK — and with no shafts either it is a copy of its own input.
     *
     * So: no shafts and no blur, hand the source straight on; shafts but no blur, take
     * the one-quad shaft composite. Both are bit-identical to the full chain, and they
     * skip the two tile-max reductions, the neighbour-max pass and a full-resolution
     * gather. It is a real saving on every grid, pit-lane and slow-corner frame, and it
     * costs nothing on the fast ones, which still take the full path.
     */
    const blurActive =
      cfg.motionBlur && this._motionBlurScale > 0.001 &&
      (speedScale > 0 || mb.uWheelActive.value > 0.5);

    if (!blurActive) {
      if (m.godrayOnly.uniforms.uGodrayIntensity.value <= 0.001) return src;
      const dst = this._pick(src);
      m.godrayOnly.uniforms.tDiffuse.value = src.texture;
      this._blit(m.godrayOnly, dst);
      return dst;
    }

    const tile = m.tileMax.uniforms;
    tile.uSourceTexel.value.set(1 / this.width, 1 / this.height);
    tile.uAxis.value.set(1, 0);
    tile.tVelocity.value = this._velocity.texture;
    this._blit(m.tileMax, this._tileTmpRT);

    tile.tVelocity.value = this._tileTmpRT.texture;
    tile.uSourceTexel.value.set(1 / this._tileTmpRT.width, 1 / this._tileTmpRT.height);
    tile.uAxis.value.set(0, 1);
    this._blit(m.tileMax, this._tileMaxRT);

    this._blit(m.neighbourMax, this._neighbourMaxRT);

    // The velocity buffer holds displacement over `_historySpan` seconds of simulation.
    // Rescaling it to the fixed SHUTTER_SECONDS exposure makes the amount of blur a
    // property of the camera rather than of the frame rate, and makes a capture — where
    // several physics steps separate two presents — expose the same as gameplay does.
    mb.uStrength.value =
      clamp(SHUTTER_SECONDS / Math.max(this._historySpan, 1e-4), 0.05, 4.0) * this._motionBlurScale;

    mb.uFrameSeed.value = seed;
    mb.tDiffuse.value = src.texture;

    const dst = this._pick(src);
    this._blit(m.motionBlur, dst);
    return dst;
  }

  _renderMeter(src, dt) {
    const m = this._materials;

    m.luminance.uniforms.tDiffuse.value = src.texture;
    this._blit(m.luminance, this._lumRT);

    const reduce = m.luminanceReduce.uniforms;
    let source = this._lumRT;
    for (let i = 0; i < this._lumReduceRT.length; i++) {
      reduce.tDiffuse.value = source.texture;
      reduce.uSourceTexel.value.set(1 / source.width, 1 / source.height);
      this._blit(m.luminanceReduce, this._lumReduceRT[i]);
      source = this._lumReduceRT[i];
    }

    const read = this._exposureRT[this._exposureIndex];
    const write = this._exposureRT[this._exposureIndex ^ 1];
    const adapt = m.exposureAdapt.uniforms;
    adapt.tCurrent.value = source.texture;
    adapt.tPrevious.value = read.texture;
    adapt.uDt.value = dt;
    adapt.uReset.value = this._exposureSeeded ? 0 : 1;
    this._exposureSeeded = true;
    this._blit(m.exposureAdapt, write);
    this._exposureIndex ^= 1;

    m.final.uniforms.tExposure.value = write.texture;
    m.bloomPrefilter.uniforms.tExposure.value = write.texture;
  }

  /** Half-texel-inset sampling bounds for a source of the given size. */
  _setSourceBounds(uniforms, width, height) {
    uniforms.uSourceTexel.value.set(1 / width, 1 / height);
    uniforms.uSourceMin.value.set(0.5 / width, 0.5 / height);
    uniforms.uSourceMax.value.set(1 - 0.5 / width, 1 - 0.5 / height);
  }

  _renderBloom(src) {
    if (!this._config.bloom || this._bloomRT.length === 0) return;
    const m = this._materials;

    const pre = m.bloomPrefilter.uniforms;
    pre.tDiffuse.value = src.texture;
    this._setSourceBounds(pre, this.width, this.height);
    this._blit(m.bloomPrefilter, this._bloomRT[0]);

    const down = m.bloomDown.uniforms;
    for (let i = 1; i < this._bloomRT.length; i++) {
      const source = this._bloomRT[i - 1];
      down.tDiffuse.value = source.texture;
      this._setSourceBounds(down, source.width, source.height);
      this._blit(m.bloomDown, this._bloomRT[i]);
    }

    // Progressive upsample: each mip is tent-filtered and added onto the next larger
    // one, so mip 0 ends up holding the whole pyramid summed.
    const up = m.bloomUp.uniforms;
    for (let i = this._bloomRT.length - 1; i > 0; i--) {
      const source = this._bloomRT[i];
      up.tDiffuse.value = source.texture;
      this._setSourceBounds(up, source.width, source.height);
      this._blit(m.bloomUp, this._bloomRT[i - 1]);
    }
  }

  _renderFinal(ctx, src, dst) {
    const u = this._materials.final.uniforms;
    u.tDiffuse.value = src.texture;
    u.uTime.value = ctx.captureMode === true ? 12.75 : (this._frame % 4096) * 0.0163;
    const sunHeight = ctx.sky?.sunDirection?.y;
    const daylight = sunHeight === undefined
      ? 1
      : smoothstep(NIGHT_COMP_RAMP[0], NIGHT_COMP_RAMP[1], sunHeight);
    u.uExposureComp.value = NIGHT_EXPOSURE_COMP + (1 - NIGHT_EXPOSURE_COMP) * daylight;
    this._blit(this._materials.final, dst);
  }

  dispose() {
    if (this._onQualityChange && this.ctx?.events) {
      this.ctx.events.off('quality:change', this._onQualityChange);
      this._onQualityChange = null;
    }
    if (this._settingsUnsub) {
      this._settingsUnsub();
      this._settingsUnsub = null;
    }

    this._freeTargets();
    this._velocity.dispose();

    for (const key in this._materials) this._materials[key].dispose();
    this._materials = {};

    if (this._fxaaMaterial) this._fxaaMaterial.dispose();
    this._fxaaMaterial = null;

    if (this._smaaPass) this._smaaPass.dispose();
    this._smaaPass = null;

    if (this._dirtTexture) this._dirtTexture.dispose();
    this._dirtTexture = null;
    if (this._blackTexture) this._blackTexture.dispose();
    this._blackTexture = null;
    if (this._whiteTexture) this._whiteTexture.dispose();
    this._whiteTexture = null;

    this._quad.dispose();
    this._registeredCars.clear();
  }
}
