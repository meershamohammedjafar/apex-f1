import * as THREE from 'three';

/**
 * Tile-based motion-blur reconstruction (McGuire et al. 2012, "A Reconstruction Filter
 * for Plausible Motion Blur"), adapted for a cockpit camera.
 *
 * Why tiles: a single pixel only knows its own velocity, so a fast-moving object cannot
 * bleed *outwards* past its own silhouette. TileMax collapses the velocity field to one
 * dominant vector per 20x20 block, NeighbourMax dilates that by one tile, and the
 * reconstruction filter then walks the dominant vector even for pixels that are
 * themselves stationary. That is what lets a barrier flick past the cockpit rail and
 * smear over the sky behind it instead of stopping dead at its own edge.
 *
 * TileMax is separable: pass one takes the max along X into a (w/TILE, h) buffer, pass
 * two along Y. Two 20-tap passes instead of one 400-tap pass.
 *
 * Velocity is in unjittered UV units per frame.
 */

const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/** Separable max-magnitude reduction. Run once with uAxis = (1,0), once with (0,1). */
export const TileMaxShader = {
  name: 'ApexTileMax',
  defines: { TILE_SIZE: 20 },
  uniforms: {
    tVelocity: { value: null },
    uSourceTexel: { value: new THREE.Vector2() },
    uAxis: { value: new THREE.Vector2(1, 0) },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tVelocity;
    uniform vec2 uSourceTexel;
    uniform vec2 uAxis;
    varying vec2 vUv;

    void main() {
      vec2 stepUv = uAxis * uSourceTexel;
      // vUv sits at the centre of the destination texel, which spans TILE_SIZE source
      // texels along uAxis. Walk back to the first of them.
      vec2 base = vUv - stepUv * (float(TILE_SIZE) * 0.5 - 0.5);

      vec2 best = vec2(0.0);
      float bestLen = -1.0;
      for (int i = 0; i < TILE_SIZE; i++) {
        vec2 v = texture2D(tVelocity, base + stepUv * float(i)).xy;
        float l = dot(v, v);
        if (l > bestLen) {
          bestLen = l;
          best = v;
        }
      }
      gl_FragColor = vec4(best, 0.0, 1.0);
    }
  `,
};

/** 3x3 dilation of the tile grid so blur can cross a tile boundary. */
export const NeighbourMaxShader = {
  name: 'ApexNeighbourMax',
  uniforms: {
    tTileMax: { value: null },
    uTexel: { value: new THREE.Vector2() },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tTileMax;
    uniform vec2 uTexel;
    varying vec2 vUv;

    void main() {
      vec2 best = vec2(0.0);
      float bestLen = -1.0;
      for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
          vec2 v = texture2D(tTileMax, vUv + vec2(float(x), float(y)) * uTexel).xy;
          float l = dot(v, v);
          // Diagonal neighbours only contribute when their vector actually points at
          // this tile; otherwise a corner tile drags blur into pixels it never covers.
          if (x != 0 && y != 0) {
            vec2 toCentre = -vec2(float(x), float(y));
            if (dot(toCentre, v) < 0.0) l = -1.0;
          }
          if (l > bestLen) {
            bestLen = l;
            best = v;
          }
        }
      }
      gl_FragColor = vec4(best, 0.0, 1.0);
    }
  `,
};

/**
 * Depth-masked shaft composite, shared by the two passes that can own it.
 *
 * Light shafts are an integral of in-scattered light along the view ray. A pixel whose
 * first surface is two metres away has almost no air in front of it, so it must receive
 * almost no shaft — which is also what makes the effect read as *behind* the near field
 * instead of painted over it. Adding the buffer unmasked is what put broad bright bands
 * across the front tyres, the halo legs and the cockpit surround.
 */
const GODRAY_MASK_CHUNK = /* glsl */ `
  uniform sampler2D tGodray;
  uniform sampler2D tDepth;
  uniform float uGodrayIntensity;
  uniform vec3 uGodrayTint;
  uniform float uGodrayNear;
  uniform float uGodrayFar;

  vec3 apexShaft(vec2 uv, float viewDist) {
    // Early out rather than multiplying by zero: on a frame where the shafts were not
    // rendered the buffer holds whatever the driver left there, and Inf * 0 is NaN.
    if (uGodrayIntensity <= 0.0) return vec3(0.0);
    float mask = smoothstep(uGodrayNear, uGodrayFar, viewDist);
    return texture2D(tGodray, uv).rgb * uGodrayTint * (uGodrayIntensity * mask);
  }
`;

/** Uniforms every shaft-compositing pass needs. Kept in one place so they stay in step. */
function godrayUniforms() {
  return {
    tGodray: { value: null },
    tDepth: { value: null },
    uGodrayIntensity: { value: 0 },
    uGodrayTint: { value: new THREE.Color(1, 1, 1) },
    // Metres. Nothing inside 4 m — cockpit, halo, front tyres, mirrors — receives any
    // shaft; the effect reaches full strength only past 30 m, out in the trackside air.
    uGodrayNear: { value: 4.0 },
    uGodrayFar: { value: 30.0 },
  };
}

export const MotionBlurShader = {
  name: 'ApexMotionBlur',
  defines: { MB_SAMPLES: 12, WHEEL_SAMPLES: 9 },
  uniforms: Object.assign(
    {
      tDiffuse: { value: null },
      tVelocity: { value: null },
      tNeighbourMax: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uTexel: { value: new THREE.Vector2() },
      uStrength: { value: 0.5 },
      // Blur ceiling, in PIXELS of the frame the filter is running on: no pixel is ever
      // gathered from further than this along the streak. Held in pixels rather than UV
      // because a UV ceiling is anisotropic — 0.022 UV was 42 px across and 24 px down
      // the same 1080p frame — and because the number the art direction is pinned to is
      // a pixel count. The pipeline writes 24 px at 1920x1080 and scales it with the
      // vertical resolution.
      uMaxBlurPx: { value: 24.0 },
      // Fraction of the computed blur that survives inside `uCentreRadius`. The driver's
      // eye is on the apex and the apex is in the middle of the frame; it has to stay
      // readable while the periphery carries the speed.
      uCentreClarity: { value: 0.35 },
      // Normalised radius, 0 at frame centre and 1 in the corners, inside which the
      // centre clarity holds flat before ramping to full strength at the frame edge.
      uCentreRadius: { value: 0.20 },
      // Metres. Blur here is a near-field effect: the trackside furniture whipping past
      // is the thing that should streak. Past `uBlurFar` the only motion is the camera's
      // own rotation dragging a static backdrop, so the far field keeps a token
      // `uFarBlurFloor` of the computed blur and no more — enough that a barrier can
      // still streak over the hills behind it, nowhere near enough to turn the sky and
      // the grandstand roofline into mush.
      uBlurNear: { value: 100.0 },
      uBlurFar: { value: 300.0 },
      uFarBlurFloor: { value: 0.15 },
      // Speed gate, 0..1. Zero below 80 km/h, full at 320 km/h and above. Written by the
      // pipeline from the camera's own travel through the world.
      uSpeedScale: { value: 0.0 },
      uAspect: { value: 1.7778 },
      uNear: { value: 0.05 },
      uFar: { value: 12000 },
      uFrameSeed: { value: 0 },

      // Wheel rotation. xy = disc centre in UV, z = disc radius in the aspect-corrected
      // UV metric, w = arc swept during the shutter in radians (0 disables the wheel).
      uWheel0: { value: new THREE.Vector4() },
      uWheel1: { value: new THREE.Vector4() },
      uWheel2: { value: new THREE.Vector4() },
      uWheel3: { value: new THREE.Vector4() },
      // View distance of each hub, metres, in the same order.
      uWheelDepth: { value: new THREE.Vector4() },
      uWheelActive: { value: 0 },
    },
    godrayUniforms(),
  ),
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform sampler2D tVelocity;
    uniform sampler2D tNeighbourMax;
    uniform vec2 uResolution;
    uniform vec2 uTexel;
    uniform float uStrength;
    uniform float uMaxBlurPx;
    uniform float uCentreClarity;
    uniform float uCentreRadius;
    uniform float uBlurNear;
    uniform float uBlurFar;
    uniform float uFarBlurFloor;
    uniform float uSpeedScale;
    uniform float uAspect;
    uniform float uNear;
    uniform float uFar;
    uniform float uFrameSeed;
    uniform vec4 uWheel0;
    uniform vec4 uWheel1;
    uniform vec4 uWheel2;
    uniform vec4 uWheel3;
    uniform vec4 uWheelDepth;
    uniform float uWheelActive;
    varying vec2 vUv;

${GODRAY_MASK_CHUNK}

    /**
     * Separation over which two surfaces stop occluding each other, in metres, measured
     * at the distance of whichever of the two is nearer.
     *
     * This is the number that decides whether a solid object stays solid. The filter
     * classifies every tap against the centre pixel: the foreground term says "the tap
     * is in front of me, let its streak cover me", the background term says "the tap is
     * behind me, I may reveal it if *I* am moving". A fixed 1.6 m extent — a car length —
     * meant a tap one metre BEHIND the centre pixel still scored 0.375 of foreground, and
     * the tarmac behind a rear tyre is moving at 300 km/h while the tyre, carried by the
     * chase camera, is not. Twelve such taps at 0.375 against a stationary centre pixel
     * whose own weight is 1/0.5 = 2.0 is 4.5 against 2.0: sixty-nine per cent of a
     * rear tyre was the road behind it. That is the semi-transparent tyre, arithmetically.
     *
     * 3 % of the near surface's distance, floored at 150 mm, is the separation at which
     * two surfaces genuinely stop being the same surface — 150 mm on a cockpit rail,
     * 180 mm on a rear tyre 6 m out, 0.9 m out at the far end of the track where a metre
     * is a pixel and a soft transition is still wanted. A fast object still smears over
     * everything genuinely behind it: a barrier 8 m away against sky at the far plane
     * scores a full 1.0 and streaks across it exactly as before.
     */
    float apexSoftZExtent(float dist) {
      return max(0.15, dist * 0.03);
    }

    // Every length in this filter is a pixel count. Doing the comparisons in UV made a
    // horizontal streak count for 1.78x a vertical one of the same visual size.
    float apexLenPx(vec2 v) {
      return length(v * uResolution);
    }

    float apexViewDist(float d) {
      float ndc = d * 2.0 - 1.0;
      return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
    }

    float softDepthCompare(float za, float zb, float extent) {
      return clamp(1.0 - (za - zb) / extent, 0.0, 1.0);
    }

    float coneWeight(float dist, float speed) {
      return clamp(1.0 - dist / max(speed, 1e-5), 0.0, 1.0);
    }

    float cylinderWeight(float dist, float speed) {
      return 1.0 - smoothstep(0.95 * speed, 1.05 * speed, dist);
    }

    // Interleaved gradient noise: cheap, stable under motion, no visible tiling.
    float apexIGN(vec2 p) {
      return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
    }

    // Depth tolerance for "this pixel belongs to that wheel". A tyre occupies a slab one
    // diameter deep about its hub — 0.72 m on a front — so 0.45 m either side of the hub
    // covers the whole of it, and the relative term keeps the test meaningful when the
    // car is 30 m away in a chase shot rather than 2 m out of the cockpit. The metre of
    // slack this used to carry swept in the whole inboard corner: the wishbones, the
    // brake duct and the upright all sit inside the wheel's projected disc and within a
    // quarter of a metre of its hub.
    float apexWheelTolerance(float hubDist) {
      return max(0.45, hubDist * 0.12);
    }

    // Depth agreement between an arc sample and the pixel it is being smeared into.
    //
    // This is the test that decides whether the rotational filter is blurring a wheel or
    // painting the suspension through it. Rotating a pixel about the hub keeps it at the
    // same screen radius, so on a rolling tyre it lands on the same annulus of the same
    // part and the surface under it is at essentially the same distance. Anything at a
    // materially different distance — the wishbone crossing in front of the sidewall, the
    // duct, the tarmac visible between two spokes — is a different object, and averaging
    // it in is what put the front suspension on top of the tyre in every moving frame.
    //
    // The tolerance has to survive the depth a legitimate sample gains from the rotation
    // itself: half of WHEEL_MAX_ARC is 24 degrees, which on an obliquely-seen 360 mm tyre
    // moves a tread pixel by up to ~0.15 m in view depth. 0.20 m keeps those and rejects
    // a wishbone a quarter of a metre proud of the flank.
    float apexArcTolerance(float dist) {
      return max(0.20, dist * 0.08);
    }

    /**
     * Accumulate the best-covering wheel for this pixel. Written as a call rather than a
     * loop over a uniform array so every index stays a compile-time constant, which is
     * all GLSL ES 1.00 guarantees.
     */
    void apexWheelPick(
      vec4 wheel, float hubDist, vec2 uv, float pixelDist,
      inout float bestCover, inout vec2 bestCentre, inout float bestArc, inout float bestDist
    ) {
      if (wheel.w <= 0.0 || wheel.z <= 0.0) return;
      vec2 rel = (uv - wheel.xy) * vec2(uAspect, 1.0);
      float rr = length(rel) / wheel.z;
      if (rr >= 1.0) return;
      // Feather the rim so the blurred disc does not end on a hard circle, and reject
      // anything at a different depth so the blur cannot leak onto the track behind.
      float cover = (1.0 - smoothstep(0.80, 1.0, rr))
                  * (1.0 - smoothstep(0.0, 1.0, abs(pixelDist - hubDist) / apexWheelTolerance(hubDist)));
      if (cover <= bestCover) return;
      bestCover = cover;
      bestCentre = wheel.xy;
      bestArc = wheel.w;
      bestDist = hubDist;
    }

    void main() {
      vec3 centre = texture2D(tDiffuse, vUv).rgb;
      float zc = apexViewDist(texture2D(tDepth, vUv).x);

      // Normalised frame radius: 0 dead centre, 1 in the corners, whatever the aspect.
      vec2 radial = (vUv - 0.5) * vec2(uAspect, 1.0);
      float rn = length(radial) / max(length(vec2(uAspect, 1.0) * 0.5), 1e-4);

      // The eye is on the apex, near the middle of the frame. The middle stays readable
      // at uCentreClarity of the computed blur out to uCentreRadius, then ramps to
      // full strength at the frame edge, where the speed actually reads.
      float clarity = mix(uCentreClarity, 1.0, smoothstep(uCentreRadius, 1.0, rn));

      // uStrength is a shutter fraction: the exposure divided by the interval the
      // velocity buffer spans. A shutter longer than that interval is not a thing a
      // camera does, and the pipeline's own guard allows up to 4 when a capture presents
      // faster than it simulates — which is how a still frame ends up blurred four times
      // harder than the same corner looks in motion.
      float shutter = min(uStrength, 1.5);

      // Distance falloff. Out past uBlurFar the only motion is the camera's own rotation
      // dragging a static backdrop; the far field keeps uFarBlurFloor of the blur so a
      // foreground object can still streak over it without the sky going with it.
      float depthScale = mix(1.0, uFarBlurFloor, smoothstep(uBlurNear, uBlurFar, zc));

      vec2 vcRaw = texture2D(tVelocity, vUv).xy;
      vec2 vmaxRaw = texture2D(tNeighbourMax, vUv).xy;
      float strength = shutter * uSpeedScale * clarity * depthScale;

      float jitter = apexIGN(gl_FragCoord.xy + uFrameSeed) - 0.5;

      vec3 result = centre;

      vec2 vmax = vmaxRaw * strength;
      float lenVmax = apexLenPx(vmax);

      // Under a pixel of travel is not a blur, it is a resample.
      if (lenVmax >= 1.0) {
        if (lenVmax > uMaxBlurPx) {
          vmax *= uMaxBlurPx / lenVmax;
          lenVmax = uMaxBlurPx;
        }

        vec2 vc = vcRaw * strength;
        float lenVc = apexLenPx(vc);
        if (lenVc > uMaxBlurPx) {
          vc *= uMaxBlurPx / lenVc;
          lenVc = uMaxBlurPx;
        }
        // Floored at half a pixel so a stationary pixel divides by something finite —
        // and so its cone stays half a pixel wide, which is what keeps a fast tile from
        // gathering the background over a cockpit rail that has not moved.
        lenVc = max(lenVc, 0.5);

        float totalWeight = 1.0 / lenVc;
        vec3 sum = centre * totalWeight;

        for (int i = 0; i < MB_SAMPLES; i++) {
          float fi = float(i);
          // Alternate between the tile-dominant vector and this pixel's own vector so
          // both "something fast passes over me" and "I am the fast thing" reconstruct.
          vec2 dir = mod(fi, 2.0) < 0.5 ? vmax : vc;
          float t = mix(-1.0, 1.0, (fi + jitter + 1.0) / (float(MB_SAMPLES) + 1.0));

          vec2 sampleUv = vUv + dir * t * 0.5;
          sampleUv = clamp(sampleUv, vec2(0.0), vec2(1.0));

          float zs = apexViewDist(texture2D(tDepth, sampleUv).x);
          vec2 vs = texture2D(tVelocity, sampleUv).xy * strength;
          float lenVs = min(apexLenPx(vs), uMaxBlurPx);

          float dist = abs(t) * lenVmax * 0.5;

          // Scaled off whichever surface is nearer, so a near object against a far one
          // gets a hard silhouette and two distant surfaces still transition softly.
          float extent = apexSoftZExtent(min(zc, zs));
          float foreground = softDepthCompare(zs, zc, extent);
          float background = softDepthCompare(zc, zs, extent);

          float w = foreground * coneWeight(dist, lenVs)
                  + background * coneWeight(dist, lenVc)
                  + cylinderWeight(dist, lenVs) * cylinderWeight(dist, lenVc) * 2.0;

          sum += texture2D(tDiffuse, sampleUv).rgb * w;
          totalWeight += w;
        }

        result = sum / max(totalWeight, 1e-5);
      }

      // Rotational blur. A wheel's rim spins at a few hundred rad/s while its hub is
      // nearly static relative to the camera, so the linear field above sees almost no
      // motion there — the spokes have to be smeared along their own arc instead.
      if (uWheelActive > 0.5) {
        float cover = 0.0;
        vec2 hub = vec2(0.0);
        float arc = 0.0;
        float hubDist = 1.0;
        apexWheelPick(uWheel0, uWheelDepth.x, vUv, zc, cover, hub, arc, hubDist);
        apexWheelPick(uWheel1, uWheelDepth.y, vUv, zc, cover, hub, arc, hubDist);
        apexWheelPick(uWheel2, uWheelDepth.z, vUv, zc, cover, hub, arc, hubDist);
        apexWheelPick(uWheel3, uWheelDepth.w, vUv, zc, cover, hub, arc, hubDist);

        if (cover > 0.001) {
          vec2 rel = (vUv - hub) * vec2(uAspect, 1.0);
          float tol = apexArcTolerance(zc);
          // Seeded with the pixel's own value at unit weight. A pixel that sits inside a
          // wheel's projected disc without belonging to the rolling part of it — the
          // wishbone in front of the sidewall, the caliper, a sliver of tarmac between
          // two spokes — then finds nothing along its arc to average with and collapses
          // back to exactly what it already was, instead of taking its colour from one
          // stray tap that happened to clear the depth test.
          vec3 acc = centre;
          float wsum = 1.0;
          for (int i = 0; i < WHEEL_SAMPLES; i++) {
            float t = (float(i) + jitter + 0.5) / float(WHEEL_SAMPLES) - 0.5;
            float a = t * arc;
            float ca = cos(a);
            float sa = sin(a);
            vec2 rot = vec2(rel.x * ca - rel.y * sa, rel.x * sa + rel.y * ca);
            vec2 suv = clamp(hub + rot / vec2(uAspect, 1.0), vec2(0.0), vec2(1.0));
            float sz = apexViewDist(texture2D(tDepth, suv).x);
            // Measured against *this pixel's* depth, not the hub's. Two points on the
            // same rolling annulus agree; a wishbone a quarter of a metre proud of the
            // flank does not, and it is that comparison — not the hub's — that keeps the
            // suspension out of the tyre.
            float w = 1.0 - smoothstep(0.0, 1.0, abs(sz - zc) / tol);
            acc += texture2D(tDiffuse, suv).rgb * w;
            wsum += w;
          }
          // How much of the arc actually agreed. Below one full-weight neighbour there is
          // no arc to smear along, and the filter stands down rather than averaging a
          // pixel with itself and calling the result motion.
          float agree = clamp(wsum - 1.0, 0.0, 1.0);
          result = mix(result, acc / wsum, cover * agree);
        }
      }

      result += apexShaft(vUv, zc);
      gl_FragColor = vec4(result, 1.0);
    }
  `,
};

/** Additive shaft composite used when motion blur is off but volumetrics are on. */
export const GodrayOnlyShader = {
  name: 'ApexGodrayOnly',
  uniforms: Object.assign(
    {
      tDiffuse: { value: null },
      uNear: { value: 0.05 },
      uFar: { value: 12000 },
    },
    godrayUniforms(),
  ),
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uNear;
    uniform float uFar;
    varying vec2 vUv;

${GODRAY_MASK_CHUNK}

    float apexViewDist(float d) {
      float ndc = d * 2.0 - 1.0;
      return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
    }

    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c += apexShaft(vUv, apexViewDist(texture2D(tDepth, vUv).x));
      gl_FragColor = vec4(c, 1.0);
    }
  `,
};

export { FULLSCREEN_VERTEX };
