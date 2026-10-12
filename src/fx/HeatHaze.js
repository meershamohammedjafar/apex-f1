import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { clamp01, smoothstep } from "../core/MathUtils.js";
export const EXHAUST_LOCAL = [0, 0.315, 2.83];
const DUCT_LOCAL = [
  [-0.72, 0.3, -1.944],
  [0.72, 0.3, -1.944]
];
const MAX_SOURCES = 40;
const FLOATS_PER_SOURCE = 8;
const _v = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const HAZE_VERTEX = (
  `
attribute vec3 aCentre;
attribute vec4 aParams;
attribute float aScroll;

varying vec2 vUv;
varying float vIntensity;
varying float vPhase;
varying float vScroll;

void main() {
  vec4 mv = viewMatrix * vec4(aCentre, 1.0);
  mv.xy += position.xy * aParams.xy;
  gl_Position = projectionMatrix * mv;
  vUv = uv;
  vIntensity = aParams.z;
  vPhase = aParams.w;
  vScroll = aScroll;
}
`
);
const HAZE_FRAGMENT = (
  `
uniform sampler2D uScene;
uniform sampler2D uNoise;
uniform vec2 uResolution;
uniform float uTime;
uniform float uStrength;
uniform float uGain;
uniform float uDeltaMax;

varying vec2 vUv;
varying float vIntensity;
varying float vPhase;
varying float vScroll;

void main() {
  if (vIntensity <= 0.001) discard;

  float rising = step(0.0, vScroll);
  float rate = abs(vScroll);

  vec2 a = texture2D(uNoise, vUv * vec2(1.7, 1.1) + vec2(vPhase, -uTime * rate)).rg;
  vec2 b = texture2D(uNoise, vUv * 3.3 + vec2(-uTime * rate * 0.42 + vPhase, -uTime * rate * 1.3)).rg;
  vec2 offset = (a * 2.0 - 1.0) * 0.72 + (b * 2.0 - 1.0) * 0.44;

  offset.y *= mix(0.85, 1.6, rising);
  vec2 d = vUv * 2.0 - 1.0;
  float edge = smoothstep(1.0, 0.15, length(d)) * mix(1.0, smoothstep(0.0, 0.35, vUv.y), rising);
  float amp = uStrength * vIntensity * edge;
  if (amp <= 0.0002) discard;

  vec2 base = gl_FragCoord.xy / uResolution;
  vec3 warped = texture2D(uScene, clamp(base + offset * amp, vec2(0.001), vec2(0.999))).rgb;
  vec3 flat_ = texture2D(uScene, base).rgb;

  vec3 delta = (warped - flat_) * uGain;
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  float level = 0.5 * (dot(warped, LUMA) + dot(flat_, LUMA)) + 0.015;
  vec3 limit = vec3(uDeltaMax * level);
  delta /= vec3(1.0) + abs(delta) / limit;
  gl_FragColor = vec4(delta, 0.0);
}
`
);
function noiseTexture(size) {
  const data = new Uint8Array(size * size * 4);
  const hash = (x, y, seed) => {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed, 1442695041);
    h = Math.imul(h ^ h >>> 13, 1274126177);
    return ((h ^ h >>> 16) >>> 0) / 4294967296;
  };
  const lattice = (x, y, period2, seed) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const xa = (x0 % period2 + period2) % period2;
    const ya = (y0 % period2 + period2) % period2;
    const xb = (xa + 1) % period2;
    const yb = (ya + 1) % period2;
    const n00 = hash(xa, ya, seed);
    const n10 = hash(xb, ya, seed);
    const n01 = hash(xa, yb, seed);
    const n11 = hash(xb, yb, seed);
    return n00 + (n10 - n00) * ux + (n01 + (n11 - n01) * ux - (n00 + (n10 - n00) * ux)) * uy;
  };
  const fbm = (x, y, period2, seed) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let f = 1;
    for (let o = 0; o < 4; o++) {
      sum += lattice(x * f, y * f, period2 * f, seed + o * 71) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  };
  const period = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size * period;
      const v = y / size * period;
      const i = (y * size + x) * 4;
      data[i] = Math.round(clamp01(fbm(u, v, period, 17)) * 255);
      data[i + 1] = Math.round(clamp01(fbm(u + 5.7, v - 3.1, period, 913)) * 255);
      data[i + 2] = 0;
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
  tex.name = "ApexHazeNoise";
  return tex;
}
const COPY_FRAGMENT = (
  `
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tDiffuse, vUv);
}
`
);
const COPY_VERTEX = (
  `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`
);
export class ScreenCapture {
  constructor() {
    this.target = null;
    this.width = 0;
    this.height = 0;
    this.frames = 0;
    this._quad = null;
    this._material = null;
  }
  get texture() {
    return this.target ? this.target.texture : null;
  }
  resize(width, height) {
    const w = Math.max(2, width | 0);
    const h = Math.max(2, height | 0);
    if (this.target && this.width === w && this.height === h) return;
    if (this.target) this.target.dispose();
    this.target = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false
    });
    this.target.texture.name = "ApexPreviousScene";
    this.width = w;
    this.height = h;
    this.frames = 0;
  }
  capture(renderer, sourceTexture) {
    if (!this.target || !sourceTexture) return;
    if (!this._quad) {
      this._material = new THREE.ShaderMaterial({
        name: "ApexSceneCopy",
        uniforms: { tDiffuse: { value: null } },
        vertexShader: COPY_VERTEX,
        fragmentShader: COPY_FRAGMENT,
        blending: THREE.NoBlending,
        depthTest: false,
        depthWrite: false
      });
      this._quad = new FullScreenQuad(this._material);
    }
    const previous = renderer.getRenderTarget();
    this._material.uniforms.tDiffuse.value = sourceTexture;
    renderer.setRenderTarget(this.target);
    this._quad.render(renderer);
    renderer.setRenderTarget(previous);
    if (this.frames < 4) this.frames++;
  }
  get ready() {
    return this.target !== null && this.frames >= 2;
  }
  dispose() {
    if (this.target) this.target.dispose();
    this.target = null;
    if (this._quad) this._quad.dispose();
    this._quad = null;
    if (this._material) this._material.dispose();
    this._material = null;
    this.width = 0;
    this.height = 0;
    this.frames = 0;
  }
}
export class HeatHaze {
  constructor() {
    this.enabled = true;
    this.mesh = null;
    this.material = null;
    this.noise = null;
    this.capture = new ScreenCapture();
    this._data = new Float32Array(MAX_SOURCES * FLOATS_PER_SOURCE);
    this._count = 0;
    this._buffer = null;
    this._heat = 0.5;
  }
  init(ctx) {
    this.enabled = ctx.quality?.heatHaze !== false;
    this.noise = noiseTexture(128);
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
    const buffer = new THREE.InstancedInterleavedBuffer(this._data, FLOATS_PER_SOURCE, 1);
    buffer.setUsage(THREE.DynamicDrawUsage);
    this._buffer = buffer;
    geometry.setAttribute("aCentre", new THREE.InterleavedBufferAttribute(buffer, 3, 0));
    geometry.setAttribute("aParams", new THREE.InterleavedBufferAttribute(buffer, 4, 3));
    geometry.setAttribute("aScroll", new THREE.InterleavedBufferAttribute(buffer, 1, 7));
    geometry.instanceCount = 0;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    const material = new THREE.ShaderMaterial({
      name: "ApexHeatHaze",
      uniforms: {
        uScene: { value: null },
        uNoise: { value: this.noise },
        uResolution: { value: new THREE.Vector2(1920, 1080) },
        uTime: { value: 0 },
        uStrength: { value: 8e-3 },
        uGain: { value: 0.85 },
        uDeltaMax: { value: 0.35 }
      },
      vertexShader: HAZE_VERTEX,
      fragmentShader: HAZE_FRAGMENT,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      side: THREE.DoubleSide,
      toneMapped: false
    });
    material.userData.skipCSM = true;
    this.material = material;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = "fx-heat-haze";
    mesh.frustumCulled = false;
    mesh.renderOrder = 40;
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    this.mesh = mesh;
    ctx.scene.add(mesh);
    const gl = ctx.renderer.getContext();
    this.capture.resize(gl.drawingBufferWidth, gl.drawingBufferHeight);
    return this;
  }
  setQuality(tier) {
    this.enabled = tier?.heatHaze !== false;
  }
  resize(width, height, ctx) {
    const gl = ctx.renderer.getContext();
    if (gl.drawingBufferWidth < 2) return;
    this.capture.resize(gl.drawingBufferWidth, gl.drawingBufferHeight);
    this.material.uniforms.uResolution.value.set(gl.drawingBufferWidth, gl.drawingBufferHeight);
  }
  _push(worldX, worldY, worldZ, width, height, intensity, phase, scroll) {
    if (this._count >= MAX_SOURCES || intensity <= 2e-3) return;
    const o = this._count * FLOATS_PER_SOURCE;
    const d = this._data;
    d[o] = worldX;
    d[o + 1] = worldY;
    d[o + 2] = worldZ;
    d[o + 3] = width;
    d[o + 4] = height;
    d[o + 5] = intensity;
    d[o + 6] = phase;
    d[o + 7] = scroll;
    this._count++;
  }
  begin() {
    this._count = 0;
  }
  addCar(ctx, fx) {
    if (!this.enabled) return;
    const state = fx.car.physics.state;
    const distance = fx.distance;
    if (distance > 90) return;
    const fade = 1 - smoothstep(55, 90, distance);
    const rpmTerm = clamp01((state.rpm - 4e3) / 8e3);
    const gas = clamp01(0.18 + state.throttle * 0.62 + rpmTerm * 0.35) * fade;
    const q = state.quaternion;
    _v.set(EXHAUST_LOCAL[0], EXHAUST_LOCAL[1], EXHAUST_LOCAL[2]).applyQuaternion(q).add(state.position);
    const phase = fx.index * 0.37;
    this._push(_v.x, _v.y + 0.34, _v.z, 0.85, 1.25, gas * 0.7, phase, 0.85);
    for (let i = 0; i < 2; i++) {
      const temp = state.brakeTemp[i];
      const duct = clamp01((temp - 380) / 620) * fade;
      if (duct <= 0.02) continue;
      const l = DUCT_LOCAL[i];
      _v.set(l[0], l[1], l[2]).applyQuaternion(q).add(state.position);
      this._push(_v.x, _v.y + 0.3, _v.z, 0.55, 0.85, duct * 0.55, phase + i * 0.61, 0.65);
    }
  }
  addHorizon(ctx) {
    if (!this.enabled) return;
    const sky = ctx.sky;
    if (!sky) return;
    const w = sky.weather;
    const heat = clamp01(smoothstep(0.3, 0.85, sky.sunDirection.y)) * (1 - clamp01(w.cloudCover) * 0.8) * (1 - clamp01(w.rain));
    this._heat = heat;
    if (heat <= 0.03) return;
    const camera = ctx.camera;
    camera.getWorldPosition(_camPos);
    camera.getWorldDirection(_camDir);
    _camDir.y = 0;
    if (_camDir.lengthSq() < 1e-6) return;
    _camDir.normalize();
    const track = ctx.track;
    for (let i = 0; i < 3; i++) {
      const range = 60 + i * 55;
      const x = _camPos.x + _camDir.x * range;
      const z = _camPos.z + _camDir.z * range;
      const ground = track?.heightAt ? track.heightAt(x, z) : 0;
      const y = (Number.isFinite(ground) ? ground : _camPos.y - 1) + 0.85;
      this._push(x, y, z, range * 0.9, 2.4 + i * 1.2, heat * (0.42 - i * 0.09), i * 2.13, -0.22);
    }
  }
  captureFrame(ctx) {
    if (!this.material) return;
    const pipeline = ctx.pipeline;
    const source = pipeline?.sceneColorTexture;
    if (!source) return;
    const w = pipeline.width;
    const h = pipeline.height;
    if (w < 2 || h < 2) return;
    if (w !== this.capture.width || h !== this.capture.height) this.capture.resize(w, h);
    this.material.uniforms.uResolution.value.set(w, h);
    this.capture.capture(ctx.renderer, source);
  }
  commit(ctx) {
    const mesh = this.mesh;
    if (!mesh) return;
    if (!this.enabled || this._count === 0 || !this.capture.ready) {
      mesh.visible = false;
      return;
    }
    const u = this.material.uniforms;
    u.uTime.value = ctx.time.elapsed;
    u.uScene.value = this.capture.texture;
    this._buffer.needsUpdate = true;
    mesh.geometry.instanceCount = this._count;
    mesh.visible = true;
  }
  get sourceCount() {
    return this._count;
  }
  get sceneTexture() {
    return this.capture.ready ? this.capture.texture : null;
  }
  dispose() {
    if (this.mesh) {
      this.mesh.geometry.dispose();
      this.mesh.parent?.remove(this.mesh);
      this.mesh = null;
    }
    if (this.material) {
      this.material.dispose();
      this.material = null;
    }
    if (this.noise) {
      this.noise.dispose();
      this.noise = null;
    }
    this.capture.dispose();
  }
}
