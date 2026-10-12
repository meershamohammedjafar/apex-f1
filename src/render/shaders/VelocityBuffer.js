import * as THREE from "three";
export const VELOCITY_LAYER = 7;
const PREV_INSTANCE_ATTRIBUTE = "apexPrevInstanceMatrix";
const MAX_INSTANCE_SPIN_COS = Math.cos(6 * (Math.PI / 180));
const TELEPORT_STEP_RATIO = 8;
const TELEPORT_MIN_METRES = 2;
const TELEPORT_MAX_METRES = 50;
const TELEPORT_BASIS_COS = Math.cos(30 * (Math.PI / 180));
const MAX_INSTANCE_STEP_METRES = 1;
const VELOCITY_COMMON = (
  `
  uniform float uNear;
  uniform float uFar;
  uniform vec2 uResolution;
  uniform float uMaxVelocityPx;

  float apexViewDist(float d) {
    float ndc = d * 2.0 - 1.0;
    return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
  }

  const float APEX_MIN_CLIP_W = 1e-4;

  vec2 apexProjectUv(vec4 clip) {
    return (clip.xy / max(clip.w, APEX_MIN_CLIP_W)) * 0.5 + 0.5;
  }

  vec2 apexClampVelocity(vec2 v) {
    if (!(abs(v.x) < 1e6) || !(abs(v.y) < 1e6)) return vec2(0.0);
    float lenPx = length(v * uResolution);
    return lenPx > uMaxVelocityPx ? v * (uMaxVelocityPx / lenPx) : v;
  }
`
);
const CAMERA_VERTEX = (
  `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`
);
const CAMERA_FRAGMENT = (
  `
  precision highp float;
  uniform sampler2D tDepth;
  uniform mat4 uInvViewProjJittered;
  uniform mat4 uPrevViewProj;
  uniform vec2 uJitterUv;
  varying vec2 vUv;
${VELOCITY_COMMON}
  void main() {
    float d = texture2D(tDepth, vUv).x;

    d = min(d, 0.99995);

    vec4 clip = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 world = uInvViewProjJittered * clip;
    world /= world.w;

    vec2 prevUv = apexProjectUv(uPrevViewProj * world);

    gl_FragColor = vec4(apexClampVelocity((vUv - uJitterUv) - prevUv), 0.0, 1.0);
  }
`
);
const OBJECT_VERTEX = (
  `
  uniform mat4 uPrevModelMatrix;
  uniform mat4 uPrevViewProj;
  uniform mat4 uCurViewProj;
  varying vec4 vCurClip;
  varying vec4 vPrevClip;

  #include <common>
  #include <batching_pars_vertex>
  #include <skinning_pars_vertex>
  #include <morphtarget_pars_vertex>

  #ifdef USE_INSTANCING
    attribute mat4 apexPrevInstanceMatrix;
    uniform float uPrevInstanceValid;
  #endif

  void main() {
    #include <batching_vertex>
    #include <skinbase_vertex>
    #include <morphinstance_vertex>
    #include <begin_vertex>
    #include <morphtarget_vertex>
    #include <skinning_vertex>

    vec4 objPos = vec4(transformed, 1.0);
    vec4 prevObjPos = objPos;
    #ifdef USE_BATCHING
      objPos = batchingMatrix * objPos;
      prevObjPos = batchingMatrix * prevObjPos;
    #endif
    #ifdef USE_INSTANCING
      vec4 curInstance = instanceMatrix * prevObjPos;
      vec4 histInstance = apexPrevInstanceMatrix * prevObjPos;
      objPos = instanceMatrix * objPos;
      prevObjPos = mix(curInstance, histInstance, uPrevInstanceValid);
    #endif

    vec4 worldPos = modelMatrix * objPos;
    vCurClip = uCurViewProj * worldPos;
    vPrevClip = uPrevViewProj * (uPrevModelMatrix * prevObjPos);

    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`
);
const OBJECT_FRAGMENT = (
  `
  precision highp float;
  uniform sampler2D tDepth;
  varying vec4 vCurClip;
  varying vec4 vPrevClip;
${VELOCITY_COMMON}
  void main() {
    vec2 screenUv = gl_FragCoord.xy / uResolution;
    float sceneZ = apexViewDist(texture2D(tDepth, screenUv).x);
    float fragZ = apexViewDist(gl_FragCoord.z);

    float tol = max(0.03, sceneZ * 0.02);
    if (abs(fragZ - sceneZ) > tol) discard;

    vec2 cur = apexProjectUv(vCurClip);
    vec2 prev = apexProjectUv(vPrevClip);
    gl_FragColor = vec4(apexClampVelocity(cur - prev), 0.0, 1.0);
  }
`
);
function rollInstanceHistory(out, latched, current) {
  const maxStepSq = MAX_INSTANCE_STEP_METRES * MAX_INSTANCE_STEP_METRES;
  for (let o = 0; o + 15 < out.length; o += 16) {
    const tx = current[o + 12] - latched[o + 12];
    const ty = current[o + 13] - latched[o + 13];
    const tz = current[o + 14] - latched[o + 14];
    if (tx * tx + ty * ty + tz * tz > maxStepSq) {
      for (let k = 0; k < 16; k++) out[o + k] = current[o + k];
      continue;
    }
    let aligned = true;
    for (let c = 0; c < 3 && aligned; c++) {
      const i = o + c * 4;
      const ax = latched[i], ay = latched[i + 1], az = latched[i + 2];
      const bx = current[i], by = current[i + 1], bz = current[i + 2];
      const la = Math.sqrt(ax * ax + ay * ay + az * az);
      const lb = Math.sqrt(bx * bx + by * by + bz * bz);
      if (la < 1e-8 || lb < 1e-8) continue;
      aligned = (ax * bx + ay * by + az * bz) / (la * lb) >= MAX_INSTANCE_SPIN_COS;
    }
    if (aligned) {
      for (let k = 0; k < 16; k++) out[o + k] = latched[o + k];
    } else {
      for (let k = 0; k < 12; k++) out[o + k] = current[o + k];
      out[o + 12] = latched[o + 12];
      out[o + 13] = latched[o + 13];
      out[o + 14] = latched[o + 14];
      out[o + 15] = current[o + 15];
    }
  }
  latched.set(current);
}
const _staleWorld = new THREE.Matrix4();
function originDistance(a, b) {
  const ea = a.elements;
  const eb = b.elements;
  const dx = ea[12] - eb[12];
  const dy = ea[13] - eb[13];
  const dz = ea[14] - eb[14];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
function isTeleport(entry, current) {
  const l = entry.latched.elements;
  const c = current.elements;
  const dx = c[12] - l[12];
  const dy = c[13] - l[13];
  const dz = c[14] - l[14];
  const step = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const previous = entry.step;
  entry.step = step;
  if (step > TELEPORT_MAX_METRES) return true;
  if (step > TELEPORT_MIN_METRES && step > previous * TELEPORT_STEP_RATIO) return true;
  for (let col = 0; col < 3; col++) {
    const i = col * 4;
    const ax = l[i], ay = l[i + 1], az = l[i + 2];
    const bx = c[i], by = c[i + 1], bz = c[i + 2];
    const la = Math.sqrt(ax * ax + ay * ay + az * az);
    const lb = Math.sqrt(bx * bx + by * by + bz * bz);
    if (la < 1e-8 || lb < 1e-8) continue;
    if ((ax * bx + ay * by + az * bz) / (la * lb) < TELEPORT_BASIS_COS) return true;
  }
  return false;
}
function writesDepth(object) {
  const material = object.material;
  if (!material) return false;
  if (Array.isArray(material)) {
    for (let i = 0; i < material.length; i++) {
      const m = material[i];
      if (m && m.depthWrite !== false && m.colorWrite !== false) return true;
    }
    return false;
  }
  return material.depthWrite !== false && material.colorWrite !== false;
}
function cullSide(object) {
  const material = object.material;
  if (!material) return THREE.DoubleSide;
  if (Array.isArray(material)) {
    for (let i = 0; i < material.length; i++) {
      const m = material[i];
      if (!m || m.side !== THREE.FrontSide) return THREE.DoubleSide;
    }
    return THREE.FrontSide;
  }
  return material.side === THREE.FrontSide ? THREE.FrontSide : THREE.DoubleSide;
}
export class VelocityBuffer {
  constructor() {
    this.target = null;
    this.width = 1;
    this.height = 1;
    this._roots = [];
    this._entries = [];
    this._byObject = new Map();
    this.cameraMaterial = new THREE.ShaderMaterial({
      name: "ApexVelocityCamera",
      uniforms: {
        tDepth: { value: null },
        uInvViewProjJittered: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uJitterUv: { value: new THREE.Vector2() },
        uNear: { value: 0.05 },
        uFar: { value: 12e3 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uMaxVelocityPx: { value: 1 }
      },
      vertexShader: CAMERA_VERTEX,
      fragmentShader: CAMERA_FRAGMENT,
      depthTest: false,
      depthWrite: false
    });
    this.objectMaterial = new THREE.ShaderMaterial({
      name: "ApexVelocityObject",
      uniforms: {
        tDepth: { value: null },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uPrevModelMatrix: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uCurViewProj: { value: new THREE.Matrix4() },
        uPrevInstanceValid: { value: 0 },
        uNear: { value: 0.05 },
        uFar: { value: 12e3 },
        uMaxVelocityPx: { value: 1 }
      },
      vertexShader: OBJECT_VERTEX,
      fragmentShader: OBJECT_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      lights: false
    });
    const uniforms = this.objectMaterial.uniforms;
    const uPrev = uniforms.uPrevModelMatrix;
    const uPrevInstanceValid = uniforms.uPrevInstanceValid;
    const byObject = this._byObject;
    this.objectMaterial.onBeforeRender = (renderer, scene, camera, geometry, object) => {
      const entry = byObject.get(object);
      uPrev.value.copy(entry ? entry.prev : object.matrixWorld);
      uPrevInstanceValid.value = entry !== void 0 && entry.prevInstance !== null ? 1 : 0;
      this.objectMaterial.side = cullSide(object);
      this.objectMaterial.uniformsNeedUpdate = true;
    };
    this._collectVisitor = (obj) => {
      if (!obj.isMesh) return;
      if (this._byObject.has(obj)) return;
      if (!writesDepth(obj)) return;
      _staleWorld.copy(obj.matrixWorld);
      obj.updateWorldMatrix(true, false);
      const historic = originDistance(_staleWorld, obj.matrixWorld) <= TELEPORT_MAX_METRES ? _staleWorld : obj.matrixWorld;
      const entry = {
        object: obj,
        prev: new THREE.Matrix4().copy(historic),
        latched: new THREE.Matrix4().copy(obj.matrixWorld),
        step: 0,
        prevInstance: null,
        latchedInstance: null
      };
      const geometry = obj.geometry;
      if (obj.isInstancedMesh && obj.instanceMatrix && geometry && geometry.getAttribute(PREV_INSTANCE_ATTRIBUTE) === void 0) {
        const source = obj.instanceMatrix.array;
        const attribute = new THREE.InstancedBufferAttribute(new Float32Array(source), 16);
        attribute.name = PREV_INSTANCE_ATTRIBUTE;
        attribute.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute(PREV_INSTANCE_ATTRIBUTE, attribute);
        entry.prevInstance = attribute;
        entry.latchedInstance = new Float32Array(source);
      }
      this._byObject.set(obj, entry);
      this._entries.push(entry);
      obj.layers.enable(VELOCITY_LAYER);
    };
  }
  init(width, height) {
    this.setSize(width, height);
  }
  setSize(width, height) {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    if (this.target && this.width === w && this.height === h) return;
    this.width = w;
    this.height = h;
    if (this.target) this.target.dispose();
    this.target = new THREE.WebGLRenderTarget(w, h, {
      format: THREE.RGFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false
    });
    this.target.texture.name = "ApexVelocity";
    const maxVelocityPx = 2 * Math.sqrt(w * w + h * h);
    this.objectMaterial.uniforms.uResolution.value.set(w, h);
    this.objectMaterial.uniforms.uMaxVelocityPx.value = maxVelocityPx;
    this.cameraMaterial.uniforms.uResolution.value.set(w, h);
    this.cameraMaterial.uniforms.uMaxVelocityPx.value = maxVelocityPx;
  }
  get texture() {
    return this.target ? this.target.texture : null;
  }
  registerDynamic(root) {
    if (!root || this._roots.indexOf(root) >= 0) return;
    this._roots.push(root);
    root.traverse(this._collectVisitor);
  }
  unregisterDynamic(root) {
    const i = this._roots.indexOf(root);
    if (i < 0) return;
    this._roots.splice(i, 1);
    root.traverse((obj) => {
      const entry = this._byObject.get(obj);
      if (!entry) return;
      this._byObject.delete(obj);
      const j = this._entries.indexOf(entry);
      if (j >= 0) this._entries.splice(j, 1);
      this._detachInstanceHistory(entry);
      obj.layers.disable(VELOCITY_LAYER);
    });
  }
  rescan() {
    for (let i = 0; i < this._roots.length; i++) this._roots[i].traverse(this._collectVisitor);
  }
  setCameraPlanes(near, far) {
    this.cameraMaterial.uniforms.uNear.value = near;
    this.cameraMaterial.uniforms.uFar.value = far;
    this.objectMaterial.uniforms.uNear.value = near;
    this.objectMaterial.uniforms.uFar.value = far;
  }
  setMatrices(invViewProjJittered, prevViewProj, curViewProj, jitterUvX, jitterUvY) {
    const cam = this.cameraMaterial.uniforms;
    cam.uInvViewProjJittered.value.copy(invViewProjJittered);
    cam.uPrevViewProj.value.copy(prevViewProj);
    cam.uJitterUv.value.set(jitterUvX, jitterUvY);
    const obj = this.objectMaterial.uniforms;
    obj.uPrevViewProj.value.copy(prevViewProj);
    obj.uCurViewProj.value.copy(curViewProj);
  }
  setDepthTexture(depthTexture) {
    this.cameraMaterial.uniforms.tDepth.value = depthTexture;
    this.objectMaterial.uniforms.tDepth.value = depthTexture;
  }
  render(renderer, scene, camera, quad, drawDynamic) {
    renderer.setRenderTarget(this.target);
    quad.material = this.cameraMaterial;
    quad.render(renderer);
    if (!drawDynamic || this._entries.length === 0) return;
    const prevOverride = scene.overrideMaterial;
    const prevBackground = scene.background;
    const prevMask = camera.layers.mask;
    const prevAutoClear = renderer.autoClear;
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const prevShadowNeeds = renderer.shadowMap.needsUpdate;
    scene.overrideMaterial = this.objectMaterial;
    scene.background = null;
    camera.layers.disableAll();
    camera.layers.enable(VELOCITY_LAYER);
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = false;
    renderer.render(scene, camera);
    renderer.shadowMap.needsUpdate = prevShadowNeeds;
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    renderer.autoClear = prevAutoClear;
    camera.layers.mask = prevMask;
    scene.background = prevBackground;
    scene.overrideMaterial = prevOverride;
  }
  advanceHistory() {
    const entries = this._entries;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const world = entry.object.matrixWorld;
      const teleported = isTeleport(entry, world);
      entry.prev.copy(teleported ? world : entry.latched);
      entry.latched.copy(world);
      const prevInstance = entry.prevInstance;
      if (prevInstance === null) continue;
      const source = entry.object.instanceMatrix;
      if (!source || source.array.length !== entry.latchedInstance.length) {
        this._detachInstanceHistory(entry);
        continue;
      }
      if (teleported) {
        prevInstance.array.set(source.array);
        entry.latchedInstance.set(source.array);
      } else {
        rollInstanceHistory(prevInstance.array, entry.latchedInstance, source.array);
      }
      prevInstance.needsUpdate = true;
    }
  }
  _detachInstanceHistory(entry) {
    if (entry.prevInstance === null) return;
    const geometry = entry.object.geometry;
    if (geometry && geometry.getAttribute(PREV_INSTANCE_ATTRIBUTE) === entry.prevInstance) {
      geometry.deleteAttribute(PREV_INSTANCE_ATTRIBUTE);
    }
    entry.prevInstance = null;
    entry.latchedInstance = null;
  }
  dispose() {
    for (let i = 0; i < this._entries.length; i++) {
      const entry = this._entries[i];
      this._detachInstanceHistory(entry);
      entry.object.layers.disable(VELOCITY_LAYER);
    }
    this._entries.length = 0;
    this._roots.length = 0;
    this._byObject.clear();
    this.objectMaterial.onBeforeRender = () => {
    };
    this.cameraMaterial.dispose();
    this.objectMaterial.dispose();
    if (this.target) this.target.dispose();
    this.target = null;
  }
}
