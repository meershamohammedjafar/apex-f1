import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { clamp01, smoothstep } from '../core/MathUtils.js';

/**
 * Screen-space refraction for hot air: the exhaust plume, the brake ducts, and the
 * shimmer that lies over distant asphalt on a hot afternoon.
 *
 * The scene is drawn in a single forward pass, so there is no mid-frame colour buffer
 * to refract. What there *is* is the pipeline's own scene target from the previous
 * present — linear HDR, the very space this quad is composited back into. One blit per
 * frame copies it aside (a quad inside the scene pass cannot sample the target it is
 * being drawn into), giving a source image that is one frame stale — invisible for an
 * effect made of low-frequency wobble, and available on any hardware, unlike the
 * drawing buffer, whose post-present contents are undefined without
 * `preserveDrawingBuffer`.
 *
 * Each patch adds the *difference* between the displaced and undisplaced samples of
 * that copy. Where the image is flat the difference is zero, so the patch can never
 * show its own edges; where there is contrast it warps like hot air. Source and
 * destination sharing one colour space is what makes the arithmetic mean something:
 * `scene + (warped - flat)` reconstructs the displaced image exactly where the two
 * frames agree. Where they disagree the difference is a colour error, not a
 * refraction, so a soft limiter bounds it relative to the local level — hot air bends
 * light; it never contributes colour of its own. (The previous incarnation differenced
 * the *tonemapped* previous frame into the linear buffer: over high-contrast livery
 * the mis-scaled residual came out as full-range confetti, the engine-cover "rainbow
 * corruption" that survived three car-side fix attempts.)
 */

/** Central exhaust exit above the diffuser, car-local metres (-Z forward). */
export const EXHAUST_LOCAL = [0, 0.315, 2.83];

/** Brake duct outlets, car-local, front axle. */
const DUCT_LOCAL = [
  [-0.72, 0.30, -1.944],
  [0.72, 0.30, -1.944],
];

const MAX_SOURCES = 40;
const FLOATS_PER_SOURCE = 8;

const _v = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _camDir = new THREE.Vector3();

const HAZE_VERTEX = /* glsl */ `
attribute vec3 aCentre;
attribute vec4 aParams;  // width, height, intensity, phase
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
`;

const HAZE_FRAGMENT = /* glsl */ `
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

  // A negative scroll rate marks a layer lying on the ground rather than a plume
  // rising off a hot part, and the two want opposite treatment at their lower edge.
  float rising = step(0.0, vScroll);
  float rate = abs(vScroll);

  // Two noise fields at different scales and rates: one is a texture, two is turbulence.
  vec2 a = texture2D(uNoise, vUv * vec2(1.7, 1.1) + vec2(vPhase, -uTime * rate)).rg;
  vec2 b = texture2D(uNoise, vUv * 3.3 + vec2(-uTime * rate * 0.42 + vPhase, -uTime * rate * 1.3)).rg;
  vec2 offset = (a * 2.0 - 1.0) * 0.72 + (b * 2.0 - 1.0) * 0.44;

  // Rising air is stretched vertically and dies out toward the edge of the patch.
  offset.y *= mix(0.85, 1.6, rising);
  vec2 d = vUv * 2.0 - 1.0;
  float edge = smoothstep(1.0, 0.15, length(d)) * mix(1.0, smoothstep(0.0, 0.35, vUv.y), rising);
  float amp = uStrength * vIntensity * edge;
  if (amp <= 0.0002) discard;

  vec2 base = gl_FragCoord.xy / uResolution;
  vec3 warped = texture2D(uScene, clamp(base + offset * amp, vec2(0.001), vec2(0.999))).rgb;
  vec3 flat_ = texture2D(uScene, base).rgb;

  // Both samples are linear HDR, so adding (warped - flat) onto this frame's pixel
  // reconstructs the displaced image wherever the two frames agree. Where they do not
  // — the frame is a present stale, and the plume overlays a car that moved — the
  // difference is a colour error, not a refraction, so it is soft-saturated against
  // the local level. Relative, not absolute: the same limiter has to hold in a dark
  // underpass and against an 11:1 HDR sky.
  vec3 delta = (warped - flat_) * uGain;
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  float level = 0.5 * (dot(warped, LUMA) + dot(flat_, LUMA)) + 0.015;
  vec3 limit = vec3(uDeltaMax * level);
  delta /= vec3(1.0) + abs(delta) / limit;
  gl_FragColor = vec4(delta, 0.0);
}
`;

function noiseTexture(size) {
  const data = new Uint8Array(size * size * 4);
  const hash = (x, y, seed) => {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const lattice = (x, y, period, seed) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const ux = fx * fx * (3 - 2 * fx);
    const uy = fy * fy * (3 - 2 * fy);
    const xa = ((x0 % period) + period) % period;
    const ya = ((y0 % period) + period) % period;
    const xb = (xa + 1) % period;
    const yb = (ya + 1) % period;
    const n00 = hash(xa, ya, seed);
    const n10 = hash(xb, ya, seed);
    const n01 = hash(xa, yb, seed);
    const n11 = hash(xb, yb, seed);
    return (n00 + (n10 - n00) * ux) + ((n01 + (n11 - n01) * ux) - (n00 + (n10 - n00) * ux)) * uy;
  };
  const fbm = (x, y, period, seed) => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let f = 1;
    for (let o = 0; o < 4; o++) {
      sum += lattice(x * f, y * f, period * f, seed + o * 71) * amp;
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  };

  const period = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * period;
      const v = (y / size) * period;
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
  tex.name = 'ApexHazeNoise';
  return tex;
}

const COPY_FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
varying vec2 vUv;
void main() {
  gl_FragColor = texture2D(tDiffuse, vUv);
}
`;

const COPY_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Holds a copy of the previous frame's linear HDR scene pass. A UV blit rather than
 * copyTexSubImage2D: it never touches the drawing buffer (whose contents outside
 * capture mode are undefined — `preserveDrawingBuffer` is off in live play), a
 * half-float source needs a half-float destination the copy path cannot promise, and
 * a one-frame size mismatch during a resize stretches instead of raising a GL error.
 */
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
      generateMipmaps: false,
    });
    this.target.texture.name = 'ApexPreviousScene';
    this.width = w;
    this.height = h;
    this.frames = 0;
  }

  capture(renderer, sourceTexture) {
    if (!this.target || !sourceTexture) return;
    if (!this._quad) {
      this._material = new THREE.ShaderMaterial({
        name: 'ApexSceneCopy',
        uniforms: { tDiffuse: { value: null } },
        vertexShader: COPY_VERTEX,
        fragmentShader: COPY_FRAGMENT,
        blending: THREE.NoBlending,
        depthTest: false,
        depthWrite: false,
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

  /** Two frames of history before anyone samples it, or the first frame refracts black. */
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
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
      -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
    ]), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([
      0, 0, 1, 0, 1, 1, 0, 1,
    ]), 2));

    const buffer = new THREE.InstancedInterleavedBuffer(this._data, FLOATS_PER_SOURCE, 1);
    buffer.setUsage(THREE.DynamicDrawUsage);
    this._buffer = buffer;
    geometry.setAttribute('aCentre', new THREE.InterleavedBufferAttribute(buffer, 3, 0));
    geometry.setAttribute('aParams', new THREE.InterleavedBufferAttribute(buffer, 4, 3));
    geometry.setAttribute('aScroll', new THREE.InterleavedBufferAttribute(buffer, 1, 7));
    geometry.instanceCount = 0;
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);

    const material = new THREE.ShaderMaterial({
      name: 'ApexHeatHaze',
      uniforms: {
        uScene: { value: null },
        uNoise: { value: this.noise },
        uResolution: { value: new THREE.Vector2(1920, 1080) },
        uTime: { value: 0 },
        uStrength: { value: 0.008 },
        uGain: { value: 0.85 },
        // Asymptotic bound on |delta| as a fraction of the local scene level. Hot air
        // may darken or brighten a pixel by about a third of what is already there;
        // anything past that reads as chroma noise, not shimmer.
        uDeltaMax: { value: 0.35 },
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
      toneMapped: false,
    });
    material.userData.skipCSM = true;
    this.material = material;

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'fx-heat-haze';
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

  /**
   * Record one source in world space. The quad is turned to face the eye in the vertex
   * shader, using the view matrix the renderer binds at draw time — reading the
   * camera's inverse here would be a frame stale and would smear at 300 km/h.
   */
  _push(worldX, worldY, worldZ, width, height, intensity, phase, scroll) {
    if (this._count >= MAX_SOURCES || intensity <= 0.002) return;
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

  /**
   * Exhaust plume and brake ducts for one car. Gas leaving a turbocharged V6 exit is
   * around 700 C on power and still 400 C on a trailing throttle, which is what sets
   * the intensity curve; carbon brakes glow past 900 C and shed a column of hot air
   * straight up out of the duct.
   */
  addCar(ctx, fx) {
    if (!this.enabled) return;
    const state = fx.car.physics.state;
    const distance = fx.distance;
    if (distance > 90) return;

    const fade = 1 - smoothstep(55, 90, distance);
    const rpmTerm = clamp01((state.rpm - 4000) / 8000);
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
      this._push(_v.x, _v.y + 0.30, _v.z, 0.55, 0.85, duct * 0.55, phase + i * 0.61, 0.65);
    }
  }

  /**
   * The mirage over distant tarmac. It lives on a wide band planted on the road ahead
   * of the camera, so the horizon and everything standing on it swims a little.
   */
  addHorizon(ctx) {
    if (!this.enabled) return;
    const sky = ctx.sky;
    if (!sky) return;
    const w = sky.weather;
    // Only a high sun on a dry, clear day makes the road boil.
    const heat = clamp01(smoothstep(0.30, 0.85, sky.sunDirection.y))
      * (1 - clamp01(w.cloudCover) * 0.8) * (1 - clamp01(w.rain));
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
      const y = (Number.isFinite(ground) ? ground : _camPos.y - 1.0) + 0.85;
      this._push(x, y, z, range * 0.9, 2.4 + i * 1.2, heat * (0.42 - i * 0.09), i * 2.13, -0.22);
    }
  }

  /**
   * Copy last frame's scene pass aside. Separate from `commit` because the visor film
   * refracts the same image and has to be able to ask for it when no haze source is
   * active. Without a pipeline there is nothing in the right colour space to refract,
   * so the capture simply never becomes ready and the haze stays invisible.
   */
  captureFrame(ctx) {
    if (!this.material) return;
    const pipeline = ctx.pipeline;
    const source = pipeline?.sceneColorTexture;
    if (!source) return;
    // The haze quad draws into the pipeline's scene target, so that target's size is
    // what gl_FragCoord runs up to and what the copy should match.
    const w = pipeline.width;
    const h = pipeline.height;
    if (w < 2 || h < 2) return;
    if (w !== this.capture.width || h !== this.capture.height) this.capture.resize(w, h);
    this.material.uniforms.uResolution.value.set(w, h);
    this.capture.capture(ctx.renderer, source);
  }

  /** Upload the frame's sources and point the shader at the captured frame. */
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

  /** How many heat sources were recorded this frame. */
  get sourceCount() {
    return this._count;
  }

  /** Screen texture for anything else that wants to refract, notably the visor film. */
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
