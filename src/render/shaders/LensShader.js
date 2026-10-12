import * as THREE from "three";
import { FULLSCREEN_VERTEX } from "./MotionBlurShader.js";
import { TONEMAP_CHUNK, createGradeUniforms } from "./TonemapShader.js";
const LENS_CHUNK = (
  `
  float apexHash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  float apexGrainNoise(vec2 p) {
    return apexHash21(p) * 0.66 + apexHash21(p * 0.47 + 19.7) * 0.34;
  }

  float apexGhost(float d) {
    float body = smoothstep(1.0, 0.55, d);
    float rim = smoothstep(1.0, 0.86, d) - smoothstep(0.86, 0.66, d);
    return body * 0.55 + max(rim, 0.0) * 1.10;
  }
`
);
export const LensShader = {
  name: "ApexLens",
  uniforms: {
    tDiffuse: { value: null },
    uAspect: { value: 1.7778 },
    uDistortion: { value: -0.015 },
    uChroma: { value: 16e-4 },
    uVignette: { value: 0.34 },
    uVignetteSoft: { value: 0.28 }
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: (
    `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uAspect;
    uniform float uDistortion;
    uniform float uChroma;
    uniform float uVignette;
    uniform float uVignetteSoft;
    varying vec2 vUv;

    void main() {
      vec2 d = vUv - 0.5;
      vec2 dAsp = d * vec2(uAspect, 1.0);
      float r2 = dot(dAsp, dAsp);
      float distort = 1.0 + uDistortion * r2 + uDistortion * 0.35 * r2 * r2;
      float ca = uChroma * r2;

      vec3 c;
      c.r = texture2D(tDiffuse, clamp(0.5 + d * (distort + ca), 0.0, 1.0)).r;
      c.g = texture2D(tDiffuse, clamp(0.5 + d * distort, 0.0, 1.0)).g;
      c.b = texture2D(tDiffuse, clamp(0.5 + d * (distort - ca), 0.0, 1.0)).b;

      c *= 1.0 - uVignette * smoothstep(uVignetteSoft, 1.05, length(dAsp));
      gl_FragColor = vec4(c, 1.0);
    }
  `
  )
};
export const FinalCompositeShader = {
  name: "ApexFinalComposite",
  uniforms: Object.assign(
    {
      tDiffuse: { value: null },
      tBloom: { value: null },
      tDirt: { value: null },
      tExposure: { value: null },
      tGodray: { value: null },
      uAspect: { value: 1.7778 },
      uTime: { value: 0 },
      uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
      uSunColor: { value: new THREE.Color(1, 0.96, 0.9) },
      uSunFade: { value: 0 },
      uUseGodrayVis: { value: 0 },
      uDistortion: { value: -0.015 },
      uChroma: { value: 16e-4 },
      uBloomStrength: { value: 0.048 },
      uBloomMax: { value: 6 },
      uDirtAmount: { value: 1.35 },
      uDirtGlow: { value: 0.035 },
      uFlareStrength: { value: 0.34 },
      uStreakStrength: { value: 0.2 },
      uGhostStrength: { value: 0.028 },
      uSunGhostStrength: { value: 0.07 },
      uVignette: { value: 0.34 },
      uVignetteSoft: { value: 0.28 },
      uGrain: { value: 0.01 },
      uGrainScale: { value: 1 }
    },
    createGradeUniforms()
  ),
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: (
    `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform sampler2D tBloom;
    uniform sampler2D tDirt;
    uniform sampler2D tExposure;
    uniform sampler2D tGodray;

    uniform float uAspect;
    uniform float uTime;

    uniform vec2 uSunUv;
    uniform vec3 uSunColor;
    uniform float uSunFade;
    uniform float uUseGodrayVis;

    uniform float uDistortion;
    uniform float uChroma;

    uniform float uBloomStrength;
    uniform float uBloomMax;
    uniform float uDirtAmount;
    uniform float uDirtGlow;

    uniform float uFlareStrength;
    uniform float uStreakStrength;
    uniform float uGhostStrength;
    uniform float uSunGhostStrength;

    uniform float uVignette;
    uniform float uVignetteSoft;

    uniform float uGrain;
    uniform float uGrainScale;

    varying vec2 vUv;

${TONEMAP_CHUNK}
${LENS_CHUNK}

    void main() {
      vec2 d = vUv - 0.5;
      vec2 dAsp = d * vec2(uAspect, 1.0);
      float r2 = dot(dAsp, dAsp);

      float distort = 1.0 + uDistortion * r2 + uDistortion * 0.35 * r2 * r2;
      float ca = uChroma * r2;

      vec2 uvG = clamp(0.5 + d * distort, 0.0, 1.0);
      vec2 uvR = clamp(0.5 + d * (distort + ca), 0.0, 1.0);
      vec2 uvB = clamp(0.5 + d * (distort - ca), 0.0, 1.0);

      float exposure = texture2D(tExposure, vec2(0.5)).g;

      vec3 hdr;
      hdr.r = texture2D(tDiffuse, uvR).r;
      hdr.g = texture2D(tDiffuse, uvG).g;
      hdr.b = texture2D(tDiffuse, uvB).b;

      vec3 bloom = min(texture2D(tBloom, uvG).rgb, vec3(uBloomMax / max(exposure, 1e-3)));
      vec3 dirt = texture2D(tDirt, vUv).rgb;
      float bloomLum = apexLuma(bloom);

      hdr += bloom * uBloomStrength * (1.0 + dirt * uDirtAmount);
      hdr += dirt * bloomLum * uDirtGlow;

      vec2 ghostVec = vec2(0.5) - uvG;
      vec3 ghosts = texture2D(tBloom, clamp(uvG + ghostVec * 0.62, 0.0, 1.0)).rgb * vec3(0.52, 0.74, 1.00);
      ghosts += texture2D(tBloom, clamp(uvG + ghostVec * 1.35, 0.0, 1.0)).rgb * vec3(1.00, 0.70, 0.40);
      ghosts += texture2D(tBloom, clamp(uvG + ghostVec * 1.86, 0.0, 1.0)).rgb * vec3(0.44, 1.00, 0.62);
      hdr += ghosts * uGhostStrength;

      float vis = uSunFade;
      if (uUseGodrayVis > 0.5) {
        vis *= clamp(apexLuma(texture2D(tGodray, uSunUv).rgb) * 3.2, 0.0, 1.0);
      }

      if (vis > 0.0008) {
        vec2 fd = (vUv - uSunUv) * vec2(uAspect, 1.0);
        float fdl = length(fd);

        float core = exp(-fdl * fdl * 340.0);
        float veil = exp(-fdl * 4.0);

        float streak = exp(-abs(fd.y) * 150.0) * exp(-abs(fd.x) * 4.0)
                     + exp(-abs(fd.y) * 24.0) * exp(-abs(fd.x) * 1.8) * 0.30;
        vec3 streakTint = mix(uSunColor, vec3(0.40, 0.58, 1.00), 0.55);

        float ring = fdl - 0.215;
        float halo = exp(-ring * ring * 900.0);

        vec2 axis = vec2(0.5) - uSunUv;
        vec2 g;
        vec3 sunGhosts = vec3(0.0);
        g = (vUv - (uSunUv + axis * 0.52)) * vec2(uAspect, 1.0);
        sunGhosts += vec3(0.44, 0.68, 1.00) * apexGhost(length(g) / 0.085) * 0.60;
        g = (vUv - (uSunUv + axis * 0.88)) * vec2(uAspect, 1.0);
        sunGhosts += vec3(1.00, 0.84, 0.56) * apexGhost(length(g) / 0.032) * 1.00;
        g = (vUv - (uSunUv + axis * 1.26)) * vec2(uAspect, 1.0);
        sunGhosts += vec3(0.50, 1.00, 0.74) * apexGhost(length(g) / 0.145) * 0.26;
        g = (vUv - (uSunUv + axis * 1.72)) * vec2(uAspect, 1.0);
        sunGhosts += vec3(1.00, 0.58, 0.44) * apexGhost(length(g) / 0.055) * 0.55;
        g = (vUv - (uSunUv + axis * 2.30)) * vec2(uAspect, 1.0);
        sunGhosts += vec3(0.62, 0.70, 1.00) * apexGhost(length(g) / 0.105) * 0.22;

        sunGhosts *= 0.55 + dirt * 1.20;

        hdr += vis * (
            uSunColor * core * uFlareStrength * 3.0
          + uSunColor * veil * uFlareStrength * 0.25
          + streakTint * streak * uStreakStrength
          + uSunColor * halo * uFlareStrength * 0.30
          + sunGhosts * uSunGhostStrength
        );
      }

      float vr = length(dAsp);
      hdr *= 1.0 - uVignette * smoothstep(uVignetteSoft, 1.05, vr);

      vec3 col = apexGrade(hdr, exposure);

      vec2 gp = gl_FragCoord.xy * uGrainScale;
      float g = apexGrainNoise(gp + vec2(uTime * 71.13, uTime * 53.71));
      float luma = apexLuma(col);
      float grainWeight = smoothstep(0.0, 0.045, luma) * (1.0 - smoothstep(0.05, 0.34, luma));
      col += (g - 0.5) * uGrain * grainWeight;

      col = clamp(col, 0.0, 1.0);
      vec3 srgb = apexLinearToSrgb(col);

      float dither = (apexHash21(gl_FragCoord.xy + 3.17) - 0.5) * (1.0 / 255.0);
      gl_FragColor = vec4(srgb + dither, 1.0);
    }
  `
  )
};
export function createLensDirtTexture(size, rng) {
  const doc = globalThis.document;
  if (!doc) return null;
  const canvas = doc.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d");
  g.fillStyle = "#000000";
  g.fillRect(0, 0, size, size);
  const s = size / 512;
  for (let i = 0; i < 46; i++) {
    const edgeBias = rng.next() < 0.65;
    const a = rng.range(0, Math.PI * 2);
    const rad = edgeBias ? rng.range(0.3, 0.52) : rng.range(0, 0.3);
    const cx = size * (0.5 + Math.cos(a) * rad);
    const cy = size * (0.5 + Math.sin(a) * rad);
    const r = rng.range(14, 78) * s;
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    const tint = rng.range(0.82, 1);
    const alpha = rng.range(0.05, 0.2);
    grad.addColorStop(0, `rgba(255,${Math.round(255 * tint)},${Math.round(245 * tint)},${alpha})`);
    grad.addColorStop(0.55, `rgba(220,225,255,${alpha * 0.35})`);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.save();
    g.translate(cx, cy);
    g.rotate(rng.range(0, Math.PI));
    g.scale(1, rng.range(0.32, 0.85));
    g.translate(-cx, -cy);
    g.fillRect(cx - r, cy - r, r * 2, r * 2);
    g.restore();
  }
  g.lineCap = "round";
  for (let i = 0; i < 22; i++) {
    const cx = rng.range(-0.3, 1.3) * size;
    const cy = rng.range(-0.3, 1.3) * size;
    const r = rng.range(0.25, 1.1) * size;
    const a0 = rng.range(0, Math.PI * 2);
    g.strokeStyle = `rgba(230,236,255,${rng.range(0.02, 0.07)})`;
    g.lineWidth = rng.range(1.2, 7) * s;
    g.beginPath();
    g.arc(cx, cy, r, a0, a0 + rng.range(0.25, 1.4));
    g.stroke();
  }
  for (let i = 0; i < 34; i++) {
    const x = rng.next() * size;
    const y = rng.next() * size;
    const a = rng.range(0, Math.PI * 2);
    const len = rng.range(10, 130) * s;
    g.strokeStyle = `rgba(255,250,240,${rng.range(0.03, 0.11)})`;
    g.lineWidth = rng.range(0.5, 1.8) * s;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    g.stroke();
  }
  for (let i = 0; i < 900; i++) {
    const x = rng.next() * size;
    const y = rng.next() * size;
    const r = rng.range(0.4, 2.6) * s;
    const v = rng.range(0.1, 0.55);
    g.fillStyle = `rgba(255,252,246,${v})`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = "ApexLensDirt";
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
