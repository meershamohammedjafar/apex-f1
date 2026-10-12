import * as THREE from "three";
import { clamp, clamp01, damp, lerp, smoothstep } from "../core/MathUtils.js";
import { Rng } from "../core/Rng.js";
const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _prevCam = new THREE.Vector3();
const _visorSize = new THREE.Vector2();
const DROP_FALL_SPEED = 8.2;
const RAIN_BOX_XZ = 7.5;
const RAIN_BOX_Y = 5;
const WET_SURFACES = [
  "asphalt",
  "asphalt_worn",
  "asphalt_patch",
  "racing_line",
  "kerb",
  "kerb_exit",
  "concrete",
  "paint_line",
  "astroturf"
];
const RAIN_VERTEX = (
  `
attribute vec4 aSeed;

uniform vec3 uBox;
uniform vec3 uPhase;
uniform vec3 uRelVel;
uniform float uExposure;
uniform float uWidth;
uniform float uAspect;

varying vec2 vUv;
varying float vAlpha;

void main() {
  vec3 span = uBox * 2.0;
  vec3 base = aSeed.xyz * span - uBox;
  vec3 p = mod(base + uPhase + uBox, span) - uBox;

  vec4 mv = viewMatrix * (modelMatrix * vec4(p, 1.0));
  vec3 velView = mat3(viewMatrix) * uRelVel;

  float shutter = uExposure * (0.55 + aSeed.w * 0.9);
  vec4 clipNow = projectionMatrix * mv;
  vec4 clipWas = projectionMatrix * vec4(mv.xyz - velView * shutter, 1.0);

  if (clipNow.w < 0.05 || clipWas.w < 0.05) {
    vUv = vec2(0.0);
    vAlpha = 0.0;
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    return;
  }

  vec2 aspect = vec2(uAspect, 1.0);
  vec2 ndcNow = (clipNow.xy / clipNow.w) * aspect;
  vec2 ndcWas = (clipWas.xy / clipWas.w) * aspect;
  vec2 trail = ndcNow - ndcWas;
  float trailLen = length(trail);
  vec2 axis = trailLen > 1e-5 ? trail / trailLen : vec2(0.0, 1.0);
  vec2 perp = vec2(-axis.y, axis.x);

  float wide = max(uWidth * projectionMatrix[1][1] / clipNow.w, 0.0034) * (0.65 + aSeed.w * 0.7);
  float len = max(trailLen, wide * 4.0);

  vec2 mid = (ndcNow + ndcWas) * 0.5;
  vec2 off = perp * (position.x * wide) + axis * (position.y * len);
  gl_Position = vec4((mid + off) / aspect, clipNow.z / clipNow.w, 1.0);

  float dist = length(mv.xyz);
  vAlpha = smoothstep(0.16, 0.85, dist) * (1.0 - smoothstep(uBox.x * 0.55, uBox.x * 1.1, dist));
  vUv = uv;
}
`
);
const RAIN_FRAGMENT = (
  `
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;

varying vec2 vUv;
varying float vAlpha;

void main() {
  float a = texture2D(uMap, vUv).a * vAlpha * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(uColor * a, a);
}
`
);
const VISOR_VERTEX = (
  `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`
);
const VISOR_FRAGMENT = (
  `
uniform sampler2D uScene;
uniform vec2 uResolution;
uniform float uTime;
uniform float uWet;
uniform float uAirflow;
uniform float uHasScene;
uniform float uRefraction;
uniform vec3 uTint;

varying vec2 vUv;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec4 dropLayer(vec2 uv, float scale, float speed, float seed) {
  vec2 grid = uv * scale;
  vec2 cell = floor(grid);
  vec2 f = fract(grid);
  float h = hash21(cell + seed);
  float h2 = hash21(cell + seed + 17.3);

  vec2 flow = mix(vec2(0.0, -1.0), normalize(vec2((uv.x - 0.5) * 1.4, 1.0)), uAirflow);
  float phase = fract(h * 7.31 + uTime * speed * (0.35 + h2 * 0.9) * (0.25 + uAirflow * 1.9));

  vec2 centre = vec2(0.5) + vec2(h - 0.5, h2 - 0.5) * 0.55 + flow * (phase - 0.5) * 0.9;
  vec2 delta = f - centre;

  vec2 flowPerp = vec2(-flow.y, flow.x);
  float alongFlow = dot(delta, flow);
  float acrossFlow = dot(delta, flowPerp);
  delta = flow * (alongFlow / (1.0 + uAirflow * 2.1)) + flowPerp * acrossFlow;

  float r = length(delta);
  float h3 = hash21(cell + seed + 53.9);
  float radius = max((0.07 + h3 * 0.21) * step(0.40, h), 1e-4);
  float drop = smoothstep(radius, radius * 0.74, r);
  float rim = smoothstep(radius * 1.02, radius * 0.86, r) * smoothstep(radius * 0.60, radius * 0.88, r);

  vec2 tail = delta - flow * clamp(dot(delta, flow), -0.85, 0.0);
  float tailMask = smoothstep(radius * 0.55, 0.0, length(tail)) * step(0.0, -dot(delta, flow)) * uAirflow;

  vec2 normal = delta / max(r, 1e-3) * drop;
  return vec4(normal, clamp(drop + tailMask * 0.70, 0.0, 1.0), rim);
}

void main() {
  vec2 uv = vec2(vUv.x * (uResolution.x / max(uResolution.y, 1.0)), vUv.y);
  vec4 a = dropLayer(uv, 8.5, 0.55, 3.1);
  vec4 b = dropLayer(uv, 17.0, 0.85, 91.7);

  vec2 swept = (vUv - vec2(0.5, 0.54)) * vec2(1.05, 1.0);
  float wetK = uWet * (1.0 - 0.55 * uAirflow * (1.0 - smoothstep(0.12, 0.46, length(swept))));

  float body = clamp(a.z * 0.95 + b.z * 0.65, 0.0, 1.0);
  float rim = clamp(a.w * 1.0 + b.w * 0.72, 0.0, 1.0);
  if ((body + rim) * wetK < 0.004) discard;

  float bend = 0.0;
  if (uHasScene > 0.5) {
    vec2 base = gl_FragCoord.xy / uResolution;
    vec2 offset = (a.xy * 0.95 + b.xy * 0.55) * uRefraction;
    vec3 here = texture2D(uScene, base).rgb;
    vec3 there = texture2D(uScene, clamp(base + offset, vec2(0.003), vec2(0.997))).rgb;
    float l0 = dot(here, vec3(0.2126, 0.7152, 0.0722));
    float l1 = dot(there, vec3(0.2126, 0.7152, 0.0722));
    bend = clamp((l1 - l0) / (l0 + 0.10), -0.85, 0.85);
  }

  vec3 mult = vec3(body * (-0.62 + bend * 0.60)) + uTint * (rim * 1.90);
  gl_FragColor = vec4(clamp(mult * wetK, -0.82, 2.4), 0.0);
}
`
);
const PUDDLE_VARYING = "varying vec2 vPuddleUv;\n";
const PUDDLE_VERTEX_PATCH = (
  `
  #include <uv_vertex>
  vPuddleUv = uv;
`
);
const PUDDLE_FRAGMENT_PATCH = (
  `
  #include <normal_fragment_maps>
  {
    float apexNdv = clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0);
    float apexFresnel = pow(1.0 - apexNdv, 5.0);
    float apexReflect = 0.02 + 0.98 * apexFresnel;

    vec2 apexGrid = vec2(vPuddleUv.x * 1.6, vPuddleUv.y * 1.7);
    vec2 apexCell = floor(apexGrid);
    vec2 apexFrac = fract(apexGrid);
    float apexH1 = fract(sin(dot(apexCell, vec2(12.9898, 78.233))) * 43758.5453);
    float apexH2 = fract(sin(dot(apexCell + 3.7, vec2(39.3468, 11.135))) * 24634.6345);
    vec2 apexCentre = vec2(0.36 + apexH1 * 0.28, 0.42 + apexH2 * 0.16);
    vec2 apexDelta = (apexFrac - apexCentre) * vec2(1.35, 1.15);
    float apexPool = 1.0 - smoothstep(0.20, 0.46, length(apexDelta));
    apexPool *= step(0.14, apexH2);
    apexPool *= smoothstep(0.02, 0.26, vPuddleUv.x) * (1.0 - smoothstep(0.86, 1.0, vPuddleUv.x));

    diffuseColor.a *= clamp(apexPool * apexReflect, 0.0, 1.0);
  }
`
);
const PUDDLE_SPECULAR_PATCH = (
  `
  #include <lights_fragment_end>
  reflectedLight.indirectSpecular = radiance;
`
);
function rippleNormalTexture(size) {
  const data = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const hash = (x, y) => {
    let h = Math.imul(x & 1023, 374761393) + Math.imul(y & 1023, 668265263);
    h = Math.imul(h ^ h >>> 13, 1274126177);
    return ((h ^ h >>> 16) >>> 0) / 4294967296;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      let h = 0;
      h += Math.sin((u * 9 + v * 4) * Math.PI * 2) * 0.3;
      h += Math.sin((u * -5 + v * 11) * Math.PI * 2) * 0.24;
      h += Math.sin((u * 17 + v * 15) * Math.PI * 2) * 0.12;
      h += (hash(x, y) - 0.5) * 0.22;
      height[y * size + x] = h;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = height[y * size + (x - 1 + size) % size];
      const r = height[y * size + (x + 1) % size];
      const d = height[(y - 1 + size) % size * size + x];
      const u = height[(y + 1) % size * size + x];
      const nx = (l - r) * 1.4;
      const ny = (d - u) * 1.4;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      data[i] = Math.round((nx * inv * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round((ny * inv * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round((nz * inv * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  tex.name = "ApexWaterRipples";
  return tex;
}
export class Weather {
  constructor(particles) {
    this.particles = particles;
    this.rng = new Rng(1792614149);
    this.rainIntensity = 0;
    this.surfaceWater = 0;
    this.intensity = 1;
    this.group = new THREE.Group();
    this.group.name = "fx-weather";
    this.group.matrixAutoUpdate = false;
    this.rainMesh = null;
    this.rainMaterial = null;
    this.rainCapacity = 0;
    this.spray = null;
    this.splash = null;
    this._phase = new THREE.Vector3();
    this._relVel = new THREE.Vector3();
    this._camVel = new THREE.Vector3();
    this._camValid = false;
    this.puddles = null;
    this.puddleMaterial = null;
    this._rippleTexture = null;
    this._puddlesBuilt = false;
    this.visor = null;
    this.visorMaterial = null;
    this._materials = [];
    this._appliedWetness = -1;
    this._filmCompiled = false;
    this._splashAcc = 0;
    this._rateScale = 1;
    this._exposure = 0.014;
  }
  init(ctx) {
    this.ctx = ctx;
    this.spray = this.particles.pool("spray");
    this.splash = this.particles.pool("splash");
    this.setQuality(ctx.quality);
    this._buildRain(ctx);
    this._buildVisor(ctx);
    ctx.scene.add(this.group);
    const rain = ctx.sky?.weather?.rain ?? 0;
    this.rainIntensity = rain;
    this.surfaceWater = rain;
    if (rain > 0.02) this._buildPuddles(ctx);
    return this;
  }
  setQuality(tier) {
    const budget = tier?.particleBudget ?? 9e3;
    this._rateScale = clamp(budget / 9e3, 0.22, 1.8);
    const capacity = clamp(Math.round(budget * 0.28), 320, 5e3);
    if (this.rainMesh && capacity !== this.rainCapacity) {
      this._disposeRain();
      if (this.ctx) this._buildRain(this.ctx);
    }
  }
  _buildRain(ctx) {
    const budget = ctx.quality?.particleBudget ?? 9e3;
    const capacity = clamp(Math.round(budget * 0.28), 320, 5e3);
    this.rainCapacity = capacity;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([
      -0.5,
      -0.5,
      0,
      0.5,
      -0.5,
      0,
      0.5,
      0.5,
      0,
      -0.5,
      0.5,
      0
    ]), 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([
      0,
      0,
      1,
      0,
      1,
      1,
      0,
      1
    ]), 2));
    const seeds = new Float32Array(capacity * 4);
    const rng = new Rng(299157411);
    for (let i = 0; i < capacity; i++) {
      seeds[i * 4] = rng.next();
      seeds[i * 4 + 1] = rng.next();
      seeds[i * 4 + 2] = rng.next();
      seeds[i * 4 + 3] = rng.next();
    }
    geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 4, false, 1));
    geometry.instanceCount = 0;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    const droplet = this.particles.sprites.get("droplet");
    const material = new THREE.ShaderMaterial({
      name: "ApexRain",
      uniforms: {
        uMap: { value: droplet ?? null },
        uBox: { value: new THREE.Vector3(RAIN_BOX_XZ, RAIN_BOX_Y, RAIN_BOX_XZ) },
        uPhase: { value: this._phase },
        uRelVel: { value: this._relVel },
        uExposure: { value: this._exposure },
        uWidth: { value: 0.012 },
        uAspect: { value: 1.7778 },
        uColor: { value: new THREE.Vector3(0.62, 0.68, 0.78) },
        uOpacity: { value: 0 }
      },
      vertexShader: RAIN_VERTEX,
      fragmentShader: RAIN_FRAGMENT,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      side: THREE.DoubleSide,
      toneMapped: false
    });
    material.userData.skipCSM = true;
    this.rainMaterial = material;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "fx-rain";
    mesh.frustumCulled = false;
    mesh.renderOrder = 30;
    mesh.matrixAutoUpdate = false;
    this.rainMesh = mesh;
    this.group.add(mesh);
  }
  _buildVisor(ctx) {
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.ShaderMaterial({
      name: "ApexVisorDrops",
      uniforms: {
        uScene: { value: null },
        uResolution: { value: new THREE.Vector2(1920, 1080) },
        uTime: { value: 0 },
        uWet: { value: 0 },
        uAirflow: { value: 0 },
        uHasScene: { value: 0 },
        uRefraction: { value: 0.01 },
        uTint: { value: new THREE.Vector3(0.88, 1, 1.16) }
      },
      vertexShader: VISOR_VERTEX,
      fragmentShader: VISOR_FRAGMENT,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      toneMapped: false
    });
    material.userData.skipCSM = true;
    this.visorMaterial = material;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "fx-visor-drops";
    mesh.frustumCulled = false;
    mesh.renderOrder = 60;
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    this.visor = mesh;
    ctx.camera.add(mesh);
    if (!ctx.camera.parent) ctx.scene.add(ctx.camera);
  }
  _buildPuddles(ctx) {
    if (this._puddlesBuilt) return;
    const track = ctx.track;
    if (!track?.sample || !track.length) return;
    this._puddlesBuilt = true;
    const spacing = 6;
    const segments = Math.max(64, Math.round(track.length / spacing));
    const sample = track.sample(0, void 0);
    const steps = 4;
    const perSide = steps + 1;
    const ring = perSide * 2;
    const vertices = new Float32Array((segments + 1) * ring * 3);
    const uvs = new Float32Array((segments + 1) * ring * 2);
    const indices = new Uint32Array(segments * 2 * steps * 6);
    let vi = 0;
    let ui = 0;
    for (let i = 0; i <= segments; i++) {
      const t = i % segments / segments;
      track.sample(t, sample);
      const width = sample.width;
      const inner = Math.max(width * 0.1, width - 6);
      const outer = width - 0.15;
      const distance = i / segments * track.length;
      for (let side = -1; side <= 1; side += 2) {
        for (let e = 0; e <= steps; e++) {
          const f = e / steps;
          const lateral = side * (inner + (outer - inner) * f);
          _v.copy(sample.position).addScaledVector(sample.right, lateral);
          const h = track.heightAt(_v.x, _v.z);
          vertices[vi++] = _v.x;
          vertices[vi++] = (Number.isFinite(h) ? h : _v.y) + 0.01;
          vertices[vi++] = _v.z;
          uvs[ui++] = f;
          uvs[ui++] = distance * 0.16;
        }
      }
    }
    let ii = 0;
    for (let i = 0; i < segments; i++) {
      for (let sd = 0; sd < 2; sd++) {
        const flip = sd === 1;
        for (let e = 0; e < steps; e++) {
          const a = i * ring + sd * perSide + e;
          const b = a + 1;
          const c = (i + 1) * ring + sd * perSide + e;
          const d = c + 1;
          if (flip) {
            indices[ii++] = a;
            indices[ii++] = b;
            indices[ii++] = c;
            indices[ii++] = b;
            indices[ii++] = d;
            indices[ii++] = c;
          } else {
            indices[ii++] = a;
            indices[ii++] = c;
            indices[ii++] = b;
            indices[ii++] = b;
            indices[ii++] = c;
            indices[ii++] = d;
          }
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    this._rippleTexture = rippleNormalTexture(256);
    this._rippleTexture.repeat.set(2, 2);
    const material = new THREE.MeshPhysicalMaterial({
      name: "ApexStandingWater",
      color: new THREE.Color(6e-3, 8e-3, 0.011),
      roughness: 0.028,
      metalness: 0,
      ior: 1.33,
      specularIntensity: 1,
      normalMap: this._rippleTexture,
      envMapIntensity: 2,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
    material.normalScale.set(0.14, 0.14);
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = PUDDLE_VARYING + shader.vertexShader.replace(
        "#include <uv_vertex>",
        PUDDLE_VERTEX_PATCH
      );
      shader.fragmentShader = PUDDLE_VARYING + shader.fragmentShader.replace("#include <normal_fragment_maps>", PUDDLE_FRAGMENT_PATCH).replace("#include <lights_fragment_end>", PUDDLE_SPECULAR_PATCH);
    };
    this.puddleMaterial = material;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "fx-standing-water";
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    mesh.renderOrder = 2;
    mesh.visible = false;
    this.puddles = mesh;
    this.group.add(mesh);
  }
  _applyWetMaterials(ctx, wet) {
    if (Math.abs(wet - this._appliedWetness) < 4e-3) return;
    this._appliedWetness = wet;
    if (this._materials.length === 0) {
      const lib = ctx.materials;
      if (!lib?.get) return;
      for (const name of WET_SURFACES) {
        const m = lib.get(name);
        if (!m || !m.isMaterial) continue;
        this._materials.push({
          material: m,
          color: m.color ? m.color.clone() : null,
          roughness: m.roughness ?? 1,
          envMapIntensity: m.envMapIntensity ?? 1,
          physical: m.isMeshPhysicalMaterial === true,
          clearcoat: m.clearcoat ?? 0,
          clearcoatRoughness: m.clearcoatRoughness ?? 0
        });
      }
    }
    for (let i = 0; i < this._materials.length; i++) {
      const entry = this._materials[i];
      const m = entry.material;
      if (entry.color && m.color) {
        const k = 1 - 0.48 * wet;
        m.color.setRGB(entry.color.r * k, entry.color.g * k, entry.color.b * k);
      }
      m.roughness = lerp(entry.roughness, 0.44, wet * 0.95);
      m.envMapIntensity = lerp(entry.envMapIntensity, entry.envMapIntensity * 1.5 + 0.15, wet);
      if (entry.physical) {
        const film2 = clamp01(wet * 1.35);
        m.clearcoat = lerp(entry.clearcoat, 1, film2);
        m.clearcoatRoughness = lerp(0.28, 0.085, film2);
      }
    }
    const film = wet > 4e-3;
    if (film !== this._filmCompiled) {
      this._filmCompiled = film;
      for (let i = 0; i < this._materials.length; i++) {
        if (this._materials[i].physical) this._materials[i].material.needsUpdate = true;
      }
    }
  }
  _restoreMaterials() {
    for (let i = 0; i < this._materials.length; i++) {
      const entry = this._materials[i];
      const m = entry.material;
      if (entry.color && m.color) m.color.copy(entry.color);
      m.roughness = entry.roughness;
      m.envMapIntensity = entry.envMapIntensity;
      if (entry.physical) {
        m.clearcoat = entry.clearcoat;
        m.clearcoatRoughness = entry.clearcoatRoughness;
        if (this._filmCompiled) m.needsUpdate = true;
      }
    }
    this._filmCompiled = false;
    this._materials.length = 0;
    this._appliedWetness = -1;
  }
  update(dt, ctx) {
    const target = clamp01(ctx.sky?.weather?.rain ?? 0);
    this.rainIntensity = damp(this.rainIntensity, target, 0.8, dt);
    const rate = target > this.surfaceWater ? 0.09 + 0.45 * target : 0.014;
    this.surfaceWater = clamp01(damp(this.surfaceWater, target, rate, dt));
    if (this.rainIntensity > 0.02 && !this._puddlesBuilt) this._buildPuddles(ctx);
    if (this.rainIntensity > 0.02) this._impacts(dt, ctx);
  }
  _impacts(dt, ctx) {
    const pool = this.splash;
    const track = ctx.track;
    if (!pool || !track?.heightAt) return;
    this._splashAcc += 420 * this.rainIntensity * this._rateScale * this.intensity * dt;
    let count = this._splashAcc | 0;
    if (count > 10) count = 10;
    this._splashAcc -= count;
    if (count <= 0) return;
    ctx.camera.getWorldPosition(_camPos);
    const rng = this.rng;
    const b = pool.brush;
    b.color(0.92, 0.97, 1.05);
    b.alpha = 0.5;
    b.drag = 6;
    b.gravity = 0;
    b.turbulence = 0;
    b.wind = 0;
    b.brightness = 2.6;
    b.stretch = 0;
    b.spin = 0;
    for (let k = 0; k < count; k++) {
      const angle = rng.next() * Math.PI * 2;
      const radius = 1.5 + rng.next() * 13;
      const x = _camPos.x + Math.cos(angle) * radius;
      const z = _camPos.z + Math.sin(angle) * radius;
      const y = track.heightAt(x, z);
      if (!Number.isFinite(y)) continue;
      b.groundY = y;
      b.life = 0.22 + rng.next() * 0.18;
      b.size0 = 0.018;
      b.size1 = 0.105 + rng.next() * 0.095;
      b.rot = rng.next() * Math.PI * 2;
      b.seed = rng.next();
      pool.spawn(x, y + 0.012, z, 0, 0.05, 0);
    }
  }
  updateCar(dt, ctx, fx) {
    const pool = this.spray;
    if (!pool) return;
    const water = this.surfaceWater;
    if (water < 0.04) return;
    const state = fx.car.physics.state;
    const speed = Math.abs(state.speed);
    if (speed < 6) return;
    const lod = fx.emissionScale;
    if (lod <= 0.02) return;
    _fwd.set(0, 0, -1).applyQuaternion(state.quaternion);
    _right.set(1, 0, 0).applyQuaternion(state.quaternion);
    const edge = fx.width > 0 ? clamp01(Math.abs(fx.lateral) / Math.max(1, fx.width)) : 0;
    const depth = water * (0.55 + 0.75 * edge);
    const speedTerm = clamp01((speed - 6) / 62);
    const rng = this.rng;
    for (let i = 0; i < 4; i++) {
      const w = state.wheels[i];
      if (!w.contact) continue;
      const rear = i >= 2;
      const radius = rear ? 0.3625 : 0.36;
      const groundY = w.worldPosition.y - radius;
      const share = rear ? 1 : 0.2;
      const strength = depth * speedTerm * share * this.intensity;
      if (strength <= 0.02) continue;
      const acc = fx.sprayAcc;
      acc[i] += (rear ? 118 : 60) * strength * this._rateScale * lod * dt;
      let count = acc[i] | 0;
      if (count > 6) count = 6;
      acc[i] -= count;
      if (count <= 0) continue;
      const b = pool.brush;
      b.color(1.02, 1.06, 1.14);
      b.alpha = 0.16 + strength * 0.3;
      b.drag = 1.05;
      b.gravity = 2.2;
      b.groundY = groundY;
      b.turbulence = 0.95;
      b.wind = 0.85;
      b.brightness = 3.6;
      b.stretch = 0;
      const side = i % 2 === 0 ? -1 : 1;
      for (let k = 0; k < count; k++) {
        _pos.copy(w.worldPosition);
        _pos.y = groundY + 0.05 + rng.next() * 0.3;
        _pos.addScaledVector(_fwd, -(0.15 + rng.next() * 0.7));
        _pos.addScaledVector(_right, side * (rng.next() * 0.3));
        _vel.copy(state.velocity).multiplyScalar(0.45);
        _vel.addScaledVector(_fwd, -speed * (0.18 + rng.next() * 0.26));
        _vel.addScaledVector(_right, side * (0.8 + rng.next() * (rear ? 3.4 : 2.2)));
        _vel.y += (rear ? 4.5 : 1.6) + rng.next() * (rear ? 7.5 : 2.5) + speedTerm * (rear ? 6 : 2);
        b.life = (rear ? 2.05 : 0.9) * (0.75 + rng.next() * 0.6);
        b.size0 = 0.2 + rng.next() * 0.26;
        b.size1 = b.size0 + (rear ? 3.4 : 1.1) + rng.next() * (rear ? 3.2 : 1.8);
        b.rot = rng.next() * Math.PI * 2;
        b.spin = rng.signed(1.1);
        b.seed = rng.next();
        pool.spawn(_pos.x, _pos.y, _pos.z, _vel.x, _vel.y, _vel.z);
      }
    }
  }
  lateUpdate(alpha, ctx, dt, sceneTexture) {
    const camera = ctx.camera;
    camera.getWorldPosition(_camPos);
    if (this._camValid && dt > 1e-5) {
      _v.subVectors(_camPos, _prevCam).multiplyScalar(1 / dt);
      this._camVel.lerp(_v, clamp01(dt * 12));
    }
    _prevCam.copy(_camPos);
    this._camValid = true;
    const wet = this.surfaceWater;
    this._applyWetMaterials(ctx, wet);
    if (this.puddles) {
      const visible = wet > 0.02;
      this.puddles.visible = visible;
      if (visible) {
        this.puddleMaterial.opacity = clamp01(wet * 2.2);
        const t = ctx.time.elapsed;
        const drift = 0.03 + this.rainIntensity * 0.1;
        this._rippleTexture.offset.set(t * drift % 1, t * drift * 0.6 % 1);
        this.puddleMaterial.normalScale.setScalar(0.06 + this.rainIntensity * 0.1);
      }
    }
    const rainMesh = this.rainMesh;
    if (rainMesh) {
      const intensity = this.rainIntensity;
      const visible = intensity > 0.015;
      rainMesh.visible = visible;
      if (visible) {
        const u = this.rainMaterial.uniforms;
        const sky = ctx.sky;
        const w = sky?.weather;
        const windX = w ? Math.sin(w.windDir) * w.windSpeed * 0.85 : 0;
        const windZ = w ? -Math.cos(w.windDir) * w.windSpeed * 0.85 : 0;
        const fall = DROP_FALL_SPEED * (0.75 + intensity * 0.5);
        this._relVel.set(windX - this._camVel.x, -fall - this._camVel.y, windZ - this._camVel.z);
        this._phase.addScaledVector(this._relVel, dt);
        const box = u.uBox.value;
        this._phase.x = (this._phase.x % (box.x * 2) + box.x * 2) % (box.x * 2);
        this._phase.y = (this._phase.y % (box.y * 2) + box.y * 2) % (box.y * 2);
        this._phase.z = (this._phase.z % (box.z * 2) + box.z * 2) % (box.z * 2);
        const tint = ctx.sky?.fogParams?.color;
        if (tint) u.uColor.value.set(tint.r * 1.3, tint.g * 1.34, tint.b * 1.4);
        const size = ctx.renderer.getDrawingBufferSize(_visorSize);
        u.uAspect.value = size.x / Math.max(1, size.y);
        u.uOpacity.value = clamp01(0.26 + intensity * 0.46) * this.intensity;
        u.uWidth.value = 0.01 + intensity * 7e-3;
        rainMesh.geometry.instanceCount = Math.round(this.rainCapacity * clamp01(0.25 + intensity * 0.75));
        rainMesh.position.copy(_camPos);
        rainMesh.updateMatrix();
      }
    }
    this._updateVisor(ctx, dt, sceneTexture);
  }
  _updateVisor(ctx, dt, sceneTexture) {
    const mesh = this.visor;
    if (!mesh) return;
    const mode = ctx.cameraRig?.mode ?? "cockpit";
    const cockpit = mode === "cockpit" || mode === "helmet";
    const wet = this.rainIntensity * (cockpit ? 1 : 0);
    if (wet < 0.02) {
      mesh.visible = false;
      return;
    }
    mesh.visible = true;
    const camera = ctx.camera;
    const dist = 0.085;
    const halfH = Math.tan(camera.fov * Math.PI / 360) * dist;
    const halfW = halfH * camera.aspect;
    mesh.position.set(0, 0, -dist);
    mesh.scale.set(halfW * 2.05, halfH * 2.05, 1);
    mesh.updateMatrix();
    const state = ctx.cars?.[0]?.physics?.state;
    const speed = state ? Math.abs(state.speed) : 0;
    const u = this.visorMaterial.uniforms;
    u.uTime.value = ctx.time.elapsed;
    u.uWet.value = clamp01(wet) * 0.85 * this.intensity;
    u.uAirflow.value = smoothstep(4, 46, speed);
    u.uScene.value = sceneTexture ?? null;
    u.uHasScene.value = sceneTexture ? 1 : 0;
    const size = ctx.renderer.getDrawingBufferSize(_visorSize);
    u.uResolution.value.set(size.x, size.y);
    const sky = ctx.sky;
    const c = sky?.fogParams?.color;
    if (c) {
      const luma = Math.max(1e-3, 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
      u.uTint.value.set(c.r / luma, c.g / luma, c.b / luma);
    }
    u.uRefraction.value = 9e-3 + u.uAirflow.value * 7e-3;
  }
  get wetness() {
    return this.surfaceWater;
  }
  setWetness(w) {
    const v = clamp01(w);
    this.surfaceWater = v;
    this.rainIntensity = Math.max(this.rainIntensity, v * 0.4);
    if (v > 0.02 && this.ctx) this._buildPuddles(this.ctx);
  }
  _disposeRain() {
    if (!this.rainMesh) return;
    this.rainMesh.geometry.dispose();
    this.rainMaterial.dispose();
    this.group.remove(this.rainMesh);
    this.rainMesh = null;
    this.rainMaterial = null;
  }
  dispose() {
    this._restoreMaterials();
    this._disposeRain();
    if (this.puddles) {
      this.puddles.geometry.dispose();
      this.puddleMaterial.dispose();
      this.group.remove(this.puddles);
      this.puddles = null;
      this.puddleMaterial = null;
    }
    if (this._rippleTexture) {
      this._rippleTexture.dispose();
      this._rippleTexture = null;
    }
    if (this.visor) {
      this.visor.geometry.dispose();
      this.visorMaterial.dispose();
      this.visor.parent?.remove(this.visor);
      this.visor = null;
      this.visorMaterial = null;
    }
    this.group.parent?.remove(this.group);
    this.group.clear();
    this.spray = null;
    this.splash = null;
  }
}
