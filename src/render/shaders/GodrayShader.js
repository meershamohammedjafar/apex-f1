import * as THREE from "three";
import { FULLSCREEN_VERTEX } from "./MotionBlurShader.js";
export const GodrayOcclusionShader = {
  name: "ApexGodrayOcclusion",
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
    uAspect: { value: 1.7778 },
    uRadius: { value: 0.85 },
    uThreshold: { value: 0.9 },
    uDepthCutoff: { value: 0.9994 }
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: (
    `
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

      float bright = smoothstep(uThreshold, uThreshold * 2.6, l);

      float dist = length((vUv - uSunUv) * vec2(uAspect, 1.0));
      float radial = 1.0 - clamp(dist / uRadius, 0.0, 1.0);
      radial *= radial;

      gl_FragColor = vec4(c * (sky * bright * radial), sky);
    }
  `
  )
};
export const GodrayBlurShader = {
  name: "ApexGodrayBlur",
  defines: { GODRAY_SAMPLES: 16 },
  uniforms: {
    tDiffuse: { value: null },
    uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
    uDensity: { value: 0.6 },
    uDecay: { value: 0.955 },
    uWeight: { value: 0.28 },
    uJitter: { value: 1 },
    uFrameSeed: { value: 0 }
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: (
    `
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
  `
  )
};
export const GodrayCompositeShader = {
  name: "ApexGodrayComposite",
  uniforms: {
    tGodray: { value: null },
    tDepth: { value: null },
    uIntensity: { value: 1 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uNear: { value: 0.05 },
    uFar: { value: 12e3 },
    uGodrayNear: { value: 4 },
    uGodrayFar: { value: 30 }
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: (
    `
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
  `
  )
};
export function sunScreenFade(sunUvX, sunUvY, behindCamera) {
  if (behindCamera) return 0;
  const dx = Math.max(0, Math.abs(sunUvX - 0.5) - 0.5);
  const dy = Math.max(0, Math.abs(sunUvY - 0.5) - 0.5);
  const outside = Math.sqrt(dx * dx + dy * dy);
  return Math.max(0, 1 - outside / 0.45);
}
