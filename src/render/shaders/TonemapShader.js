import * as THREE from "three";
import { FULLSCREEN_VERTEX } from "./MotionBlurShader.js";
export const TONEMAP_CHUNK = (
  `
  uniform float uExposureComp;
  uniform float uContrast;
  uniform float uSaturation;
  uniform float uTemperature;
  uniform float uWhitePoint;
  uniform float uToeShoulder;
  uniform float uHighlightKnee;
  uniform float uHighlightCeil;
  uniform vec3 uLift;
  uniform vec3 uGammaCtl;
  uniform vec3 uGain;
  uniform vec3 uShadowTint;
  uniform vec3 uHighlightTint;
  uniform float uSplitBalance;
  uniform vec3 uChannelCurve;

  const mat3 APEX_ACES_IN = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );

  const mat3 APEX_ACES_OUT = mat3(
     1.60475, -0.10208, -0.00327,
    -0.53108,  1.10813, -0.07276,
    -0.07367, -0.00605,  1.07602
  );

  float apexLuma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
  }

  vec3 apexWhiteBalance(vec3 c, float t) {
    vec3 gains = vec3(1.0 + 0.175 * t, 1.0 + 0.020 * t, 1.0 - 0.200 * t);
    vec3 shifted = c * gains;
    float before = apexLuma(c);
    float after = apexLuma(shifted);
    return shifted * (before / max(after, 1e-5));
  }

  vec3 apexRRTAndODTFit(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }

  vec3 apexACESFilmic(vec3 c) {
    c = APEX_ACES_IN * c;
    c = apexRRTAndODTFit(c);
    c = APEX_ACES_OUT * c;
    return clamp(c, 0.0, 1.0);
  }

  vec3 apexGrade(vec3 hdr, float exposure) {
    vec3 c = max(hdr, vec3(0.0)) * exposure * uExposureComp;

    c = apexWhiteBalance(c, uTemperature);

    c = c / (1.0 + c / uWhitePoint);

    c = 0.18 * pow(c / 0.18 + 1e-6, vec3(uContrast));

    vec3 disp = apexACESFilmic(c);

    disp = mix(disp, disp * disp * (3.0 - 2.0 * disp), uToeShoulder);

    disp = uLift + disp * (uGain - uLift);
    disp = pow(max(disp, vec3(0.0)), 1.0 / max(uGammaCtl, vec3(1e-3)));

    disp = pow(max(disp, vec3(0.0)), uChannelCurve);

    float l = apexLuma(disp);
    float split = smoothstep(0.0, 1.0, pow(clamp(l, 0.0, 1.0), uSplitBalance));
    disp *= mix(uShadowTint, uHighlightTint, split);

    float l2 = apexLuma(disp);
    disp = mix(vec3(l2), disp, uSaturation);

    float mx = max(max(disp.r, disp.g), disp.b);
    if (mx > uHighlightKnee) {
      float t = (mx - uHighlightKnee) / max(1.0 - uHighlightKnee, 1e-4);
      float rolled = uHighlightKnee + (uHighlightCeil - uHighlightKnee) * (1.0 - exp(-t));
      disp *= rolled / max(mx, 1e-5);
    }

    return clamp(disp, 0.0, 1.0);
  }

  vec3 apexLinearToSrgb(vec3 c) {
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055;
    return mix(lo, hi, step(vec3(0.0031308), c));
  }
`
);
export const EXPOSURE_METER_POWER = 0.5;
export const EXPOSURE_KEY_PIVOT = 0.127;
export const EXPOSURE_KEY = 0.386;
export const EXPOSURE_KEY_BIAS = 0;
export const EXPOSURE_MIN_LUMINANCE = 0.0625;
export function exposureFor(luminance) {
  const l = Math.max(luminance, 1e-4);
  return EXPOSURE_KEY * Math.pow(EXPOSURE_KEY_PIVOT / l, EXPOSURE_KEY_BIAS) / l;
}
export function createGradeUniforms() {
  return {
    uExposureComp: { value: 1 },
    uContrast: { value: 1.52 },
    uSaturation: { value: 1.1 },
    uTemperature: { value: 0.1 },
    uWhitePoint: { value: 24 },
    uToeShoulder: { value: 0.1 },
    uHighlightKnee: { value: 0.94 },
    uHighlightCeil: { value: 0.982 },
    uLift: { value: new THREE.Vector3(0, 0, 0) },
    uGammaCtl: { value: new THREE.Vector3(1, 1, 1.006) },
    uGain: { value: new THREE.Vector3(1, 0.996, 0.986) },
    uShadowTint: { value: new THREE.Vector3(0.945, 1, 1.07) },
    uHighlightTint: { value: new THREE.Vector3(1.045, 1.01, 0.945) },
    uSplitBalance: { value: 0.55 },
    uChannelCurve: { value: new THREE.Vector3(0.99, 1, 1.014) }
  };
}
export const TonemapShader = {
  name: "ApexTonemap",
  uniforms: Object.assign(
    {
      tDiffuse: { value: null },
      tExposure: { value: null }
    },
    createGradeUniforms()
  ),
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: (
    `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform sampler2D tExposure;
    varying vec2 vUv;
${TONEMAP_CHUNK}
    void main() {
      float exposure = texture2D(tExposure, vec2(0.5)).g;
      vec3 c = apexGrade(texture2D(tDiffuse, vUv).rgb, exposure);
      gl_FragColor = vec4(apexLinearToSrgb(c), 1.0);
    }
  `
  )
};
export const LuminanceShader = {
  name: "ApexLuminance",
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uCentreBias: { value: 0.22 },
    uMeterClamp: { value: new THREE.Vector2(4e-3, 6) },
    uMeterPower: { value: EXPOSURE_METER_POWER }
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: (
    `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uCentreBias;
    uniform vec2 uMeterClamp;
    uniform float uMeterPower;
    varying vec2 vUv;

    void main() {
      vec3 c = texture2D(tDiffuse, vUv + vec2(-1.5,  0.5) * uTexel).rgb
             + texture2D(tDiffuse, vUv + vec2( 0.5,  1.5) * uTexel).rgb
             + texture2D(tDiffuse, vUv + vec2( 1.5, -0.5) * uTexel).rgb
             + texture2D(tDiffuse, vUv + vec2(-0.5, -1.5) * uTexel).rgb;
      c *= 0.25;

      float raw = dot(c, vec3(0.2126, 0.7152, 0.0722));
      float l = clamp(max(raw, uMeterClamp.x), uMeterClamp.x, uMeterClamp.y);

      vec2 d = (vUv - 0.5) * vec2(1.0, 0.82);
      float w = mix(1.0, uCentreBias, clamp(length(d) * 2.0, 0.0, 1.0));

      gl_FragColor = vec4(pow(l, uMeterPower) * w, w, 0.0, 1.0);
    }
  `
  )
};
export const LuminanceReduceShader = {
  name: "ApexLuminanceReduce",
  uniforms: {
    tDiffuse: { value: null },
    uSourceTexel: { value: new THREE.Vector2() }
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: (
    `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uSourceTexel;
    varying vec2 vUv;

    void main() {
      vec2 base = vUv - uSourceTexel * 1.5;
      vec2 acc = vec2(0.0);
      for (int y = 0; y < 4; y++) {
        for (int x = 0; x < 4; x++) {
          acc += texture2D(tDiffuse, base + vec2(float(x), float(y)) * uSourceTexel).rg;
        }
      }
      gl_FragColor = vec4(acc * 0.0625, 0.0, 1.0);
    }
  `
  )
};
export const ExposureAdaptShader = {
  name: "ApexExposureAdapt",
  uniforms: {
    tCurrent: { value: null },
    tPrevious: { value: null },
    uDt: { value: 0.016 },
    uSpeedUp: { value: 5 },
    uSpeedDown: { value: 3 },
    uMinLuminance: { value: EXPOSURE_MIN_LUMINANCE },
    uMaxLuminance: { value: 12 },
    uKey: { value: EXPOSURE_KEY },
    uKeyPivot: { value: EXPOSURE_KEY_PIVOT },
    uKeyBias: { value: EXPOSURE_KEY_BIAS },
    uMeterPower: { value: EXPOSURE_METER_POWER },
    uMinExposure: { value: 0.06 },
    uMaxExposure: { value: exposureFor(EXPOSURE_MIN_LUMINANCE) },
    uReset: { value: 1 },
    uSnapStops: { value: new THREE.Vector2(0.25, 1) }
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: (
    `
    precision highp float;
    uniform sampler2D tCurrent;
    uniform sampler2D tPrevious;
    uniform float uDt;
    uniform float uSpeedUp;
    uniform float uSpeedDown;
    uniform float uMinLuminance;
    uniform float uMaxLuminance;
    uniform float uKey;
    uniform float uKeyPivot;
    uniform float uKeyBias;
    uniform float uMeterPower;
    uniform float uMinExposure;
    uniform float uMaxExposure;
    uniform float uReset;
    uniform vec2 uSnapStops;
    varying vec2 vUv;

    void main() {
      vec2 s = texture2D(tCurrent, vec2(0.5)).rg;
      float pe = abs(uMeterPower) < 1e-3 ? 1e-3 : uMeterPower;
      float target = pow(max(s.r / max(s.g, 1e-4), 1e-8), 1.0 / pe);
      if (!(target > 0.0)) target = uMinLuminance;
      target = clamp(target, uMinLuminance, uMaxLuminance);

      float prev = texture2D(tPrevious, vec2(0.5)).r;
      if (!(prev > 0.0)) prev = target;
      prev = clamp(prev, uMinLuminance, uMaxLuminance);

      float speed = target > prev ? uSpeedUp : uSpeedDown;
      float alpha = 1.0 - exp(-uDt * max(speed, 0.0));
      float stops = abs(log2(target / max(prev, 1e-4)));
      alpha = mix(alpha, 1.0, max(smoothstep(uSnapStops.x, uSnapStops.y, stops), uReset));
      float adapted = prev + (target - prev) * alpha;
      adapted = clamp(adapted, uMinLuminance, uMaxLuminance);
      if (!(adapted > 0.0)) adapted = uMinLuminance;

      float key = uKey * pow(uKeyPivot / max(adapted, 1e-4), uKeyBias);
      float exposure = clamp(key / max(adapted, 1e-4), uMinExposure, uMaxExposure);
      gl_FragColor = vec4(adapted, exposure, 0.0, 1.0);
    }
  `
  )
};
