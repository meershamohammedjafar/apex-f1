import * as THREE from 'three';
import { FULLSCREEN_VERTEX } from './MotionBlurShader.js';

/**
 * Screen-space light shafts.
 *
 * Three stages, all at quarter resolution because shafts are inherently low frequency:
 *
 *  1. Occlusion: keep only sky pixels (depth at the far plane) that are both bright and
 *     near the sun. Everything the geometry covers becomes black, so the trackside
 *     trees, the debris fence and the grandstand roof cut the shafts for free — that
 *     silhouette is the whole effect.
 *  2. Radial blur toward the sun, run twice with a widening stride, dithered so the
 *     16 taps do not band across a clear sky.
 *  3. Additive composite, faded by how far the sun has drifted off screen, by how much
 *     of it survived stage 1, and — the part that makes it read as air rather than as a
 *     decal — by the depth of the pixel it lands on, so near geometry occludes it.
 *
 * The composite is folded into the motion-blur pass so the shafts still feed bloom,
 * which is the ordering the chain requires; this module owns stages 1 and 2 plus a
 * standalone composite for the no-motion-blur path.
 */

export const GodrayOcclusionShader = {
  name: 'ApexGodrayOcclusion',
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
    uAspect: { value: 1.7778 },
    uRadius: { value: 0.85 },
    uThreshold: { value: 0.9 },
    uDepthCutoff: { value: 0.9994 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uSunUv;
    uniform float uAspect;
    uniform float uRadius;
    uniform float uThreshold;
    uniform float uDepthCutoff;
    varying vec2 vUv;

    void main() {
      float d = texture2D(tDepth, vUv).x;
      vec3 c = texture2D(tDiffuse, vUv).rgb;

      float sky = step(uDepthCutoff, d);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));

      // Only genuinely bright sky seeds a shaft; overcast haze must not glow.
      float bright = smoothstep(uThreshold, uThreshold * 2.6, l);

      float dist = length((vUv - uSunUv) * vec2(uAspect, 1.0));
      float radial = 1.0 - clamp(dist / uRadius, 0.0, 1.0);
      radial *= radial;

      // Alpha carries the pure depth mask. The pipeline reduces it around the sun to
      // tell SkySystem whether the disc is behind a grandstand, which colour alone
      // cannot answer because a dim sky is not an occluded one.
      gl_FragColor = vec4(c * (sky * bright * radial), sky);
    }
  `,
};

export const GodrayBlurShader = {
  name: 'ApexGodrayBlur',
  defines: { GODRAY_SAMPLES: 16 },
  uniforms: {
    tDiffuse: { value: null },
    uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
    uDensity: { value: 0.6 },
    uDecay: { value: 0.955 },
    uWeight: { value: 0.28 },
    uJitter: { value: 1.0 },
    uFrameSeed: { value: 0 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uSunUv;
    uniform float uDensity;
    uniform float uDecay;
    uniform float uWeight;
    uniform float uJitter;
    uniform float uFrameSeed;
    varying vec2 vUv;

    float apexIGN(vec2 p) {
      return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
    }

    void main() {
      vec2 delta = (vUv - uSunUv) * (uDensity / float(GODRAY_SAMPLES));
      float jitter = apexIGN(gl_FragCoord.xy + uFrameSeed);

      vec2 uv = vUv - delta * jitter * uJitter;
      float illumination = 1.0;
      vec3 acc = vec3(0.0);

      for (int i = 0; i < GODRAY_SAMPLES; i++) {
        uv -= delta;
        acc += texture2D(tDiffuse, clamp(uv, vec2(0.0), vec2(1.0))).rgb * illumination;
        illumination *= uDecay;
      }

      gl_FragColor = vec4(acc * uWeight, 1.0);
    }
  `,
};

/**
 * Additive shaft layer on its own, for a chain that composites it separately.
 *
 * Depth-masked like every other shaft composite in the pipeline: the shaft a pixel
 * receives is the in-scattering integrated along its view ray, so a surface a couple of
 * metres from the lens gets essentially none. Without the mask the shafts paint over the
 * near field — front tyres, halo, cockpit surround — instead of sitting behind it.
 */
export const GodrayCompositeShader = {
  name: 'ApexGodrayComposite',
  uniforms: {
    tGodray: { value: null },
    tDepth: { value: null },
    uIntensity: { value: 1.0 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uNear: { value: 0.05 },
    uFar: { value: 12000 },
    uGodrayNear: { value: 4.0 },
    uGodrayFar: { value: 30.0 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tGodray;
    uniform sampler2D tDepth;
    uniform float uIntensity;
    uniform vec3 uTint;
    uniform float uNear;
    uniform float uFar;
    uniform float uGodrayNear;
    uniform float uGodrayFar;
    varying vec2 vUv;

    void main() {
      float d = texture2D(tDepth, vUv).x;
      float ndc = d * 2.0 - 1.0;
      float viewDist = (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
      float mask = smoothstep(uGodrayNear, uGodrayFar, viewDist);
      gl_FragColor = vec4(texture2D(tGodray, vUv).rgb * uTint * (uIntensity * mask), 1.0);
    }
  `,
};

/**
 * Fade the shafts out as the sun leaves the frustum. Returns 0 behind the camera,
 * 1 when the sun is comfortably inside the frame, and ramps between the two so the
 * effect never pops on at a frame boundary.
 */
export function sunScreenFade(sunUvX, sunUvY, behindCamera) {
  if (behindCamera) return 0;
  const dx = Math.max(0, Math.abs(sunUvX - 0.5) - 0.5);
  const dy = Math.max(0, Math.abs(sunUvY - 0.5) - 0.5);
  const outside = Math.sqrt(dx * dx + dy * dy);
  return Math.max(0, 1 - outside / 0.45);
}
