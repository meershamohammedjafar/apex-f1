import * as THREE from 'three';
import { FULLSCREEN_VERTEX } from './MotionBlurShader.js';
import { TONEMAP_CHUNK, createGradeUniforms } from './TonemapShader.js';

/**
 * Lens simulation, and the single folded final pass.
 *
 * Tonemap, grade, chromatic aberration, barrel distortion, flare, lens dirt, vignette,
 * grain and sRGB encode are one fullscreen shader. Splitting them would mean five more
 * full-resolution round trips through a 16-bit target for no image benefit; at 1080p
 * that is most of the post budget spent on bandwidth alone.
 *
 * Physical basis for the defaults: a broadcast prime is close to rectilinear, so the
 * distortion is a barely-there -1.5% at the corner. Lateral chromatic aberration is
 * zero on axis and grows with r^2, which is why the CA term is scaled by r^2 rather
 * than applied uniformly — uniform CA reads instantly as a filter, not as glass.
 */

const LENS_CHUNK = /* glsl */ `
  float apexHash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  // Two octaves so the grain has clump structure instead of reading as TV static.
  float apexGrainNoise(vec2 p) {
    return apexHash21(p) * 0.66 + apexHash21(p * 0.47 + 19.7) * 0.34;
  }

  /**
   * One internal reflection, as a function of distance from its centre in units of
   * its own radius. An aperture ghost is not a soft blob: it is a near-flat disc of
   * light carrying a brighter rim where the defocused iris edge piles up. That rim is
   * the whole reason a ghost reads as glass rather than as a smear of bloom.
   */
  float apexGhost(float d) {
    float body = smoothstep(1.0, 0.55, d);
    float rim = smoothstep(1.0, 0.86, d) - smoothstep(0.86, 0.66, d);
    return body * 0.55 + max(rim, 0.0) * 1.10;
  }
`;

export const LensShader = {
  name: 'ApexLens',
  uniforms: {
    tDiffuse: { value: null },
    uAspect: { value: 1.7778 },
    uDistortion: { value: -0.015 },
    uChroma: { value: 0.0016 },
    uVignette: { value: 0.34 },
    uVignetteSoft: { value: 0.28 },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
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
  `,
};

/**
 * The shipping final pass: HDR in, display-referred sRGB out, everything folded.
 */
export const FinalCompositeShader = {
  name: 'ApexFinalComposite',
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
      // Lateral CA on a broadcast prime is a pixel or two at the corner, not nine.
      // 0.0016 * r2max(1.04) = 0.0017 UV, which is 3.2 px on a 1920 frame.
      uChroma: { value: 0.0016 },

      uBloomStrength: { value: 0.048 },
      // Ceiling on the bloom contribution in post-exposure units. The prefilter clamps
      // relative to exposure, so on its own a high-exposure frame can hand the composite
      // a halo brighter than the source; this bounds it at any exposure.
      uBloomMax: { value: 6.0 },
      uDirtAmount: { value: 1.35 },
      uDirtGlow: { value: 0.035 },

      // Veiling glare and the anamorphic streak. Both are gated on uSunFade, which is
      // zero unless the sun is in (or barely out of) frame and unoccluded, so these
      // numbers cost exactly nothing on a frame that is not looking at the sun.
      //
      // They were 0.12 / 0.09 through round 6. The scene buffer these are added into is
      // pre-exposure scene-linear, where a white surface in noon sun sits at 1.0 and
      // asphalt sits near 0.05; 0.09 put the peak of the anamorphic bar at two percent
      // of a clear sky, which is mathematically present and invisible in every capture
      // ever taken of this game. 0.34 / 0.20 puts the bar at roughly a tenth of the sky
      // it crosses and several times the asphalt underneath it — a streak you can see,
      // still well short of the source it comes from.
      uFlareStrength: { value: 0.34 },
      uStreakStrength: { value: 0.20 },
      /** Bloom-pyramid ghosts. Always on; they need a bright source, not the sun. */
      uGhostStrength: { value: 0.028 },
      /** The sun's own ghost train — internal reflections, see the flare block. */
      uSunGhostStrength: { value: 0.07 },

      uVignette: { value: 0.34 },
      uVignetteSoft: { value: 0.28 },

      // Grain amplitude in display-linear. A shipped title lands around 1% peak-to-peak
      // in the toe and effectively nothing above the mid-tones; 0.028 was crawling
      // visibly across a clear sky.
      uGrain: { value: 0.010 },
      uGrainScale: { value: 1.0 },
    },
    createGradeUniforms(),
  ),
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
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

      // Bounded in post-exposure terms so the halo can never out-run the image it sits
      // on, whatever the metering did.
      vec3 bloom = min(texture2D(tBloom, uvG).rgb, vec3(uBloomMax / max(exposure, 1e-3)));
      vec3 dirt = texture2D(tDirt, vUv).rgb;
      float bloomLum = apexLuma(bloom);

      hdr += bloom * uBloomStrength * (1.0 + dirt * uDirtAmount);
      hdr += dirt * bloomLum * uDirtGlow;

      // Ghosts: the bloom pyramid reflected back through the optical centre, tinted per
      // element the way a real multi-group lens splits a bright source.
      vec2 ghostVec = vec2(0.5) - uvG;
      vec3 ghosts = texture2D(tBloom, clamp(uvG + ghostVec * 0.62, 0.0, 1.0)).rgb * vec3(0.52, 0.74, 1.00);
      ghosts += texture2D(tBloom, clamp(uvG + ghostVec * 1.35, 0.0, 1.0)).rgb * vec3(1.00, 0.70, 0.40);
      ghosts += texture2D(tBloom, clamp(uvG + ghostVec * 1.86, 0.0, 1.0)).rgb * vec3(0.44, 1.00, 0.62);
      hdr += ghosts * uGhostStrength;

      // ------------------------------------------------------------------- sun flare
      // Branched, not mixed: on a frame with no shaft pass the buffer is undriven, and
      // mix() would still evaluate its NaN into the result.
      float vis = uSunFade;
      if (uUseGodrayVis > 0.5) {
        vis *= clamp(apexLuma(texture2D(tGodray, uSunUv).rgb) * 3.2, 0.0, 1.0);
      }

      // Everything below is gated on vis, and vis is SkySystem's own visibility
      // term: horizon, cloud transmittance and the depth-buffer occlusion factor the
      // pipeline reads back around the disc. So the entire optical response switches
      // off the moment a grandstand roof crosses the sun, and a frame with the sun
      // behind the camera pays for none of it and is left bit-identical.
      if (vis > 0.0008) {
        vec2 fd = (vUv - uSunUv) * vec2(uAspect, 1.0);
        float fdl = length(fd);

        // Veiling glare in two lobes. The tight one is the bloom of light around the
        // source itself; the wide, faint one is what a sun just outside the frame
        // actually puts into the picture, and it is why shooting into a low sun lifts
        // the blacks across the whole image rather than only next to the disc.
        float core = exp(-fdl * fdl * 340.0);
        float veil = exp(-fdl * 4.0);

        // Anamorphic streak. A cylindrical front element smears a point source along
        // one axis only. Two stacked falloffs give a hard bright line sitting inside a
        // soft wide bar instead of a single stripe with a visible edge; the coatings
        // on those elements are why the bar is blue and not the colour of the sun.
        float streak = exp(-abs(fd.y) * 150.0) * exp(-abs(fd.x) * 4.0)
                     + exp(-abs(fd.y) * 24.0) * exp(-abs(fd.x) * 1.8) * 0.30;
        vec3 streakTint = mix(uSunColor, vec3(0.40, 0.58, 1.00), 0.55);

        // Iris halo: the ring the aperture blades throw around a bright source.
        float ring = fdl - 0.215;
        float halo = exp(-ring * ring * 900.0);

        // Ghost train. Internal reflections between element groups land on the line
        // running from the source through the optical centre, spaced by which pair of
        // surfaces they bounced between and tinted by that group's coating. Five is
        // what a modern coated prime throws into a low sun; more reads as a
        // screensaver. Unrolled rather than looped so the compiler can fold the
        // constants — this is a fullscreen pass and it runs on every pixel.
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

        // The dirt map modulates the ghost train the same way it modulates bloom: a
        // reflection lands on the front element, and whatever is smeared on the glass
        // is what scatters it into the picture.
        sunGhosts *= 0.55 + dirt * 1.20;

        hdr += vis * (
            uSunColor * core * uFlareStrength * 3.0
          + uSunColor * veil * uFlareStrength * 0.25
          + streakTint * streak * uStreakStrength
          + uSunColor * halo * uFlareStrength * 0.30
          + sunGhosts * uSunGhostStrength
        );
      }

      // Natural falloff first, so the tonemapper rolls the darkened corners rather than
      // the grade being multiplied after the shoulder has already been applied.
      float vr = length(dAsp);
      hdr *= 1.0 - uVignette * smoothstep(uVignetteSoft, 1.05, vr);

      vec3 col = apexGrade(hdr, exposure);

      vec2 gp = gl_FragCoord.xy * uGrainScale;
      float g = apexGrainNoise(gp + vec2(uTime * 71.13, uTime * 53.71));
      float luma = apexLuma(col);
      // Film grain lives in the toe and nowhere else. Silver halide is coarsest just off
      // the floor: it fades out again in true black (there is no exposed grain there),
      // and by the mid-tones it is gone, so a clear sky stays clean while the shadowed
      // cockpit breathes. The previous curve still left 22% of full amplitude in the
      // sky, which is what read as noise crawling over flat blue.
      float grainWeight = smoothstep(0.0, 0.045, luma) * (1.0 - smoothstep(0.05, 0.34, luma));
      col += (g - 0.5) * uGrain * grainWeight;

      col = clamp(col, 0.0, 1.0);
      vec3 srgb = apexLinearToSrgb(col);

      // Ordered-ish dither: 16-bit linear collapsing to 8-bit sRGB bands visibly across
      // a clear sky without it.
      float dither = (apexHash21(gl_FragCoord.xy + 3.17) - 0.5) * (1.0 / 255.0);
      gl_FragColor = vec4(srgb + dither, 1.0);
    }
  `,
};

/**
 * Procedural lens dirt: smudges, wipe arcs and dust. Modulates bloom, so it is only
 * ever visible where something bright is behind it — which is exactly how a dirty
 * front element behaves.
 */
export function createLensDirtTexture(size, rng) {
  const doc = globalThis.document;
  if (!doc) return null;

  const canvas = doc.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');

  g.fillStyle = '#000000';
  g.fillRect(0, 0, size, size);

  const s = size / 512;

  // Broad greasy smudges, concentrated where a thumb or spray lands: the outer thirds.
  for (let i = 0; i < 46; i++) {
    const edgeBias = rng.next() < 0.65;
    const a = rng.range(0, Math.PI * 2);
    const rad = edgeBias ? rng.range(0.3, 0.52) : rng.range(0, 0.3);
    const cx = size * (0.5 + Math.cos(a) * rad);
    const cy = size * (0.5 + Math.sin(a) * rad);
    const r = rng.range(14, 78) * s;
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, r);
    const tint = rng.range(0.82, 1.0);
    const alpha = rng.range(0.05, 0.20);
    grad.addColorStop(0, `rgba(255,${Math.round(255 * tint)},${Math.round(245 * tint)},${alpha})`);
    grad.addColorStop(0.55, `rgba(220,225,255,${alpha * 0.35})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.save();
    g.translate(cx, cy);
    g.rotate(rng.range(0, Math.PI));
    g.scale(1, rng.range(0.32, 0.85));
    g.translate(-cx, -cy);
    g.fillRect(cx - r, cy - r, r * 2, r * 2);
    g.restore();
  }

  // Wipe arcs: the signature of a cloth dragged across the element.
  g.lineCap = 'round';
  for (let i = 0; i < 22; i++) {
    const cx = rng.range(-0.3, 1.3) * size;
    const cy = rng.range(-0.3, 1.3) * size;
    const r = rng.range(0.25, 1.1) * size;
    const a0 = rng.range(0, Math.PI * 2);
    g.strokeStyle = `rgba(230,236,255,${rng.range(0.020, 0.070)})`;
    g.lineWidth = rng.range(1.2, 7.0) * s;
    g.beginPath();
    g.arc(cx, cy, r, a0, a0 + rng.range(0.25, 1.4));
    g.stroke();
  }

  // Fine scratches.
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

  // Dust and rubber flecks.
  for (let i = 0; i < 900; i++) {
    const x = rng.next() * size;
    const y = rng.next() * size;
    const r = rng.range(0.4, 2.6) * s;
    const v = rng.range(0.10, 0.55);
    g.fillStyle = `rgba(255,252,246,${v})`;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.name = 'ApexLensDirt';
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}
