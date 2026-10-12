import * as THREE from "three";
const FULLSCREEN_VERTEX = (
  `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`
);
export const TileMaxShader = {
  name: "ApexTileMax",
  defines: { TILE_SIZE: 20 },
  uniforms: {
    tVelocity: { value: null },
    uSourceTexel: { value: new THREE.Vector2() },
    uAxis: { value: new THREE.Vector2(1, 0) }
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: (
    `
    precision highp float;
    uniform sampler2D tVelocity;
    uniform vec2 uSourceTexel;
    uniform vec2 uAxis;
    varying vec2 vUv;

    void main() {
      vec2 stepUv = uAxis * uSourceTexel;
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
  `
  )
};
export const NeighbourMaxShader = {
  name: "ApexNeighbourMax",
  uniforms: {
    tTileMax: { value: null },
    uTexel: { value: new THREE.Vector2() }
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: (
    `
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
  `
  )
};
const GODRAY_MASK_CHUNK = (
  `
  uniform sampler2D tGodray;
  uniform sampler2D tDepth;
  uniform float uGodrayIntensity;
  uniform vec3 uGodrayTint;
  uniform float uGodrayNear;
  uniform float uGodrayFar;

  vec3 apexShaft(vec2 uv, float viewDist) {
    if (uGodrayIntensity <= 0.0) return vec3(0.0);
    float mask = smoothstep(uGodrayNear, uGodrayFar, viewDist);
    return texture2D(tGodray, uv).rgb * uGodrayTint * (uGodrayIntensity * mask);
  }
`
);
function godrayUniforms() {
  return {
    tGodray: { value: null },
    tDepth: { value: null },
    uGodrayIntensity: { value: 0 },
    uGodrayTint: { value: new THREE.Color(1, 1, 1) },
    uGodrayNear: { value: 4 },
    uGodrayFar: { value: 30 }
  };
}
export const MotionBlurShader = {
  name: "ApexMotionBlur",
  defines: { MB_SAMPLES: 12, WHEEL_SAMPLES: 9 },
  uniforms: Object.assign(
    {
      tDiffuse: { value: null },
      tVelocity: { value: null },
      tNeighbourMax: { value: null },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uTexel: { value: new THREE.Vector2() },
      uStrength: { value: 0.5 },
      uMaxBlurPx: { value: 24 },
      uCentreClarity: { value: 0.35 },
      uCentreRadius: { value: 0.2 },
      uBlurNear: { value: 100 },
      uBlurFar: { value: 300 },
      uFarBlurFloor: { value: 0.15 },
      uSpeedScale: { value: 0 },
      uAspect: { value: 1.7778 },
      uNear: { value: 0.05 },
      uFar: { value: 12e3 },
      uFrameSeed: { value: 0 },
      uWheel0: { value: new THREE.Vector4() },
      uWheel1: { value: new THREE.Vector4() },
      uWheel2: { value: new THREE.Vector4() },
      uWheel3: { value: new THREE.Vector4() },
      uWheelDepth: { value: new THREE.Vector4() },
      uWheelActive: { value: 0 }
    },
    godrayUniforms()
  ),
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: (
    `
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

    float apexSoftZExtent(float dist) {
      return max(0.15, dist * 0.03);
    }

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

    float apexIGN(vec2 p) {
      return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
    }

    float apexWheelTolerance(float hubDist) {
      return max(0.45, hubDist * 0.12);
    }

    float apexArcTolerance(float dist) {
      return max(0.20, dist * 0.08);
    }

    void apexWheelPick(
      vec4 wheel, float hubDist, vec2 uv, float pixelDist,
      inout float bestCover, inout vec2 bestCentre, inout float bestArc, inout float bestDist
    ) {
      if (wheel.w <= 0.0 || wheel.z <= 0.0) return;
      vec2 rel = (uv - wheel.xy) * vec2(uAspect, 1.0);
      float rr = length(rel) / wheel.z;
      if (rr >= 1.0) return;
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

      vec2 radial = (vUv - 0.5) * vec2(uAspect, 1.0);
      float rn = length(radial) / max(length(vec2(uAspect, 1.0) * 0.5), 1e-4);

      float clarity = mix(uCentreClarity, 1.0, smoothstep(uCentreRadius, 1.0, rn));

      float shutter = min(uStrength, 1.5);

      float depthScale = mix(1.0, uFarBlurFloor, smoothstep(uBlurNear, uBlurFar, zc));

      vec2 vcRaw = texture2D(tVelocity, vUv).xy;
      vec2 vmaxRaw = texture2D(tNeighbourMax, vUv).xy;
      float strength = shutter * uSpeedScale * clarity * depthScale;

      float jitter = apexIGN(gl_FragCoord.xy + uFrameSeed) - 0.5;

      vec3 result = centre;

      vec2 vmax = vmaxRaw * strength;
      float lenVmax = apexLenPx(vmax);

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
        lenVc = max(lenVc, 0.5);

        float totalWeight = 1.0 / lenVc;
        vec3 sum = centre * totalWeight;

        for (int i = 0; i < MB_SAMPLES; i++) {
          float fi = float(i);
          vec2 dir = mod(fi, 2.0) < 0.5 ? vmax : vc;
          float t = mix(-1.0, 1.0, (fi + jitter + 1.0) / (float(MB_SAMPLES) + 1.0));

          vec2 sampleUv = vUv + dir * t * 0.5;
          sampleUv = clamp(sampleUv, vec2(0.0), vec2(1.0));

          float zs = apexViewDist(texture2D(tDepth, sampleUv).x);
          vec2 vs = texture2D(tVelocity, sampleUv).xy * strength;
          float lenVs = min(apexLenPx(vs), uMaxBlurPx);

          float dist = abs(t) * lenVmax * 0.5;

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
            float w = 1.0 - smoothstep(0.0, 1.0, abs(sz - zc) / tol);
            acc += texture2D(tDiffuse, suv).rgb * w;
            wsum += w;
          }
          float agree = clamp(wsum - 1.0, 0.0, 1.0);
          result = mix(result, acc / wsum, cover * agree);
        }
      }

      result += apexShaft(vUv, zc);
      gl_FragColor = vec4(result, 1.0);
    }
  `
  )
};
export const GodrayOnlyShader = {
  name: "ApexGodrayOnly",
  uniforms: Object.assign(
    {
      tDiffuse: { value: null },
      uNear: { value: 0.05 },
      uFar: { value: 12e3 }
    },
    godrayUniforms()
  ),
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: (
    `
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
  `
  )
};
export { FULLSCREEN_VERTEX };
