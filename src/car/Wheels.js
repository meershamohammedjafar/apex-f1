import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { clamp, clamp01 } from "../core/MathUtils.js";
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _axisX = new THREE.Vector3(1, 0, 0);
const _axisY = new THREE.Vector3(0, 1, 0);
const _axisZ = new THREE.Vector3(0, 0, 1);
const _flip = new THREE.Quaternion().setFromAxisAngle(_axisY, Math.PI);
const IS_LEFT = [true, false, true, false];
const TREAD_PROFILE = [
  [-0.476, 0.9505],
  [-0.464, 0.97],
  [-0.446, 0.9835],
  [-0.42, 0.9915],
  [-0.372, 0.9955],
  [-0.29, 0.998],
  [-0.16, 0.9995],
  [0, 1],
  [0.16, 0.9995],
  [0.29, 0.998],
  [0.372, 0.9955],
  [0.42, 0.9915],
  [0.446, 0.9835],
  [0.464, 0.97],
  [0.476, 0.9505]
];
const BEAD_R = 0.632;
const SHOULDER_R = 0.951;
const SIDEWALL_PROFILE = [
  [0.404, 0.632],
  [0.462, 0.7],
  [0.494, 0.766],
  [0.5017, 0.806],
  [0.5067, 0.818],
  [0.5052, 0.8235],
  [0.4992, 0.83],
  [0.4939, 0.874],
  [0.4995, 0.88],
  [0.5004, 0.886],
  [0.494, 0.9],
  [0.489, 0.918],
  [0.476, 0.951]
];
const RIM_PROFILE = [
  [-0.412, 0.36],
  [-0.426, 0.47],
  [-0.43, 0.56],
  [-0.43, 0.618],
  [-0.402, 0.632],
  [-0.38, 0.622],
  [0.38, 0.622],
  [0.402, 0.632],
  [0.418, 0.618],
  [0.404, 0.545],
  [0.386, 0.42],
  [0.378, 0.27],
  [0.392, 0.15],
  [0.43, 0.1],
  [0.446, 0.058],
  [0.436, 0]
];
const RIM_PROFILE_FAR = [
  [-0.412, 0],
  [-0.416, 0.36],
  [-0.424, 0.56],
  [-0.402, 0.632],
  [0.402, 0.632],
  [0.418, 0.618],
  [0.392, 0.43],
  [0.386, 0.18],
  [0.436, 0]
];
function revolve(profile, segments, uvFn) {
  const rows = profile.length;
  const cols = segments + 1;
  const position = new Float32Array(rows * cols * 3);
  const uv = new Float32Array(rows * cols * 2);
  let k = 0;
  let t = 0;
  for (let i = 0; i < rows; i++) {
    const x = profile[i][0];
    const r = profile[i][1];
    const fi = i / (rows - 1);
    for (let j = 0; j < cols; j++) {
      const a = j / segments * Math.PI * 2;
      position[k * 3] = x;
      position[k * 3 + 1] = r * Math.cos(a);
      position[k * 3 + 2] = r * Math.sin(a);
      const st = uvFn(fi, j / segments, x, r);
      uv[t++] = st[0];
      uv[t++] = st[1];
      k++;
    }
  }
  const idx = [];
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}
const _uvOut = [0, 0];
const TREAD_HALF = 0.476;
function treadUv(fi, fa, x) {
  _uvOut[0] = fa * 7;
  _uvOut[1] = (x + TREAD_HALF) / (TREAD_HALF * 2);
  return _uvOut;
}
function sidewallUv(fi, fa, x, r) {
  _uvOut[0] = fa;
  _uvOut[1] = (r - BEAD_R) / (SHOULDER_R - BEAD_R);
  return _uvOut;
}
function rimUv(fi, fa, x, r) {
  _uvOut[0] = fa * 5;
  _uvOut[1] = r * 3.2 + x * 0.8;
  return _uvOut;
}
function discUv(fi, fa, x, r) {
  _uvOut[0] = fa * 4;
  _uvOut[1] = (r - 0.4) * 1.6;
  return _uvOut;
}
function discGeometry(segments) {
  const geo = revolve([
    [-0.5, 0.4],
    [-0.5, 0.98],
    [-0.46, 1],
    [0.46, 1],
    [0.5, 0.98],
    [0.5, 0.4]
  ], segments, discUv);
  const white = new Float32Array(geo.getAttribute("position").count * 3).fill(1);
  geo.setAttribute("color", new THREE.BufferAttribute(white, 3));
  return geo;
}
function caliperGeometry(detail) {
  const parts = [];
  const body = new THREE.BoxGeometry(0.086, 0.104, 0.046, 1, 2, 1);
  body.translate(0, 0.152, 0.03);
  parts.push(body);
  const bridge = new THREE.BoxGeometry(0.096, 0.03, 0.086, 1, 1, 1);
  bridge.translate(0, 0.176, 0.01);
  parts.push(bridge);
  if (detail >= 2) {
    for (const sx of [-0.036, 0.036]) {
      for (const sz of [-6e-3, 0.056]) {
        const boss = new THREE.CylinderGeometry(0.01, 0.01, 0.098, 8);
        boss.rotateZ(Math.PI * 0.5);
        boss.translate(sx * 0.4, 0.152, sz);
        parts.push(boss);
      }
    }
  }
  const duct = new THREE.CylinderGeometry(0.148, 0.148, 0.03, detail >= 2 ? 24 : 14, 1, true);
  duct.rotateZ(Math.PI * 0.5);
  parts.push(duct);
  const scoop = new THREE.BoxGeometry(0.038, 0.12, 0.06);
  scoop.translate(0, 0.04, -0.15);
  parts.push(scoop);
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  merged.computeVertexNormals();
  return merged;
}
const _wheelGeoCache = new Map();
let _contactGeo = null;
function contactGeometry() {
  if (_contactGeo) return _contactGeo;
  const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
  geo.rotateX(-Math.PI * 0.5);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 3.2);
  _contactGeo = geo;
  return geo;
}
const WHEEL_SEGMENTS = [64, 64, 72];
const CONTACT_SQUASH = 0.012;
const CONTACT_WIDTH_SCALE = TREAD_HALF * 2 / 0.48;
const CONTACT_PATCH_V = 0.39;
const CONTACT_LIFT = 0.012;
function wheelGeometries(detail) {
  const cached = _wheelGeoCache.get(detail);
  if (cached) return cached;
  const seg = WHEEL_SEGMENTS[clamp(detail, 0, 2)];
  const tread = revolve(TREAD_PROFILE, seg, treadUv);
  const left = revolve(SIDEWALL_PROFILE.map((p) => [-p[0], p[1]]), seg, sidewallUv);
  const right = revolve(SIDEWALL_PROFILE.slice().reverse(), seg, sidewallUv);
  const sidewall = mergeGeometries([left, right], false);
  left.dispose();
  right.dispose();
  let rim;
  if (detail === 0) {
    rim = revolve(RIM_PROFILE_FAR, seg, rimUv);
  } else {
    const barrel = revolve(RIM_PROFILE, seg, rimUv);
    const ribs = [];
    const ribCount = detail >= 2 ? 10 : 6;
    for (let i = 0; i < ribCount; i++) {
      const rib = new THREE.BoxGeometry(0.016, 0.026, 0.4);
      rib.translate(0.398, 0, 0.25);
      rib.rotateX(i / ribCount * Math.PI * 2);
      ribs.push(rib);
      const spoke = new THREE.BoxGeometry(0.018, 0.022, 0.22);
      spoke.translate(-0.436, 0, 0.49);
      spoke.rotateX((i + 0.5) / ribCount * Math.PI * 2);
      ribs.push(spoke);
    }
    rim = mergeGeometries([barrel, ...ribs], false);
    barrel.dispose();
    for (const r of ribs) r.dispose();
    rim.computeVertexNormals();
  }
  const disc = detail >= 1 ? discGeometry(detail >= 2 ? Math.max(24, seg >> 1) : 18) : null;
  const caliper = detail >= 2 ? caliperGeometry(detail) : null;
  const bounds = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 3.2);
  for (const g of [tread, sidewall, rim, disc, caliper]) {
    if (g) g.boundingSphere = bounds.clone();
  }
  const set = { tread, sidewall, rim, disc, caliper, segments: seg };
  _wheelGeoCache.set(detail, set);
  return set;
}
export function disposeSharedWheelGeometry() {
  for (const set of _wheelGeoCache.values()) {
    for (const key of ["tread", "sidewall", "rim", "disc", "caliper"]) set[key]?.dispose();
  }
  _wheelGeoCache.clear();
  _contactGeo?.dispose();
  _contactGeo = null;
}
function glowColor(celsius, out) {
  const t = clamp01((celsius - 400) / 600);
  const i = Math.pow(t, 1.25);
  out.setRGB(i, i * (0.06 + 0.49 * t * t), i * (5e-3 + 0.115 * t * t * t));
  return out;
}
export class WheelSet {
  constructor(ctx, spec) {
    const detail = clamp(spec.detail ?? 2, 0, 2);
    this.detail = detail;
    this.ctx = ctx;
    this.materials = ctx.materials ?? null;
    this.group = new THREE.Group();
    this.group.name = "wheels";
    this.radius = [spec.front.radius, spec.front.radius, spec.rear.radius, spec.rear.radius];
    this.width = [spec.front.width, spec.front.width, spec.rear.width, spec.rear.width];
    this.discRadius = [
      spec.discRadiusFront,
      spec.discRadiusFront,
      spec.discRadiusRear,
      spec.discRadiusRear
    ];
    const geo = wheelGeometries(detail);
    this._ownedMaterials = [];
    const treadMat = this.materials?.get("tyre_rubber") ?? new THREE.MeshStandardMaterial({ color: 1710622, roughness: 0.9 });
    this._sidewallMat = this.materials?.tyreSidewall?.(spec.compound ?? "medium") ?? this.materials?.get("tyre_sidewall") ?? treadMat;
    const rimMat = this.materials?.get("wheel_rim") ?? new THREE.MeshStandardMaterial({ color: 9278620, metalness: 1, roughness: 0.35 });
    this.tread = this._instanced(geo.tread, treadMat, true);
    this.sidewall = geo.sidewall ? this._instanced(geo.sidewall, this._sidewallMat, detail >= 1) : null;
    this.rim = geo.rim ? this._instanced(geo.rim, rimMat, detail >= 1) : null;
    if (geo.disc) {
      this.disc = this._instanced(geo.disc, this._brakeMaterial(), false);
      this.disc.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(12), 3);
      this.disc.instanceColor.setUsage(THREE.DynamicDrawUsage);
      const caliperMat = this.materials?.get("brake_caliper") ?? new THREE.MeshStandardMaterial({ color: 3948614, metalness: 1, roughness: 0.4 });
      this.caliper = geo.caliper ? this._instanced(geo.caliper, caliperMat, true) : null;
    } else {
      this.disc = null;
      this.caliper = null;
    }
    const contactMat = this.materials?.contactShadow?.() ?? null;
    if (contactMat) {
      const mesh = new THREE.InstancedMesh(contactGeometry(), contactMat, 4);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.contact = mesh;
    } else {
      this.contact = null;
    }
    this._contactScale = new Float32Array(8);
    for (let i = 0; i < 4; i++) {
      this._contactScale[i * 2] = this.width[i] * CONTACT_WIDTH_SCALE;
      this._contactScale[i * 2 + 1] = 2 * Math.sqrt(2 * this.radius[i] * CONTACT_SQUASH) / CONTACT_PATCH_V;
    }
    this._brakeTemp = new Float32Array(4);
    this._dirtyGlow = true;
  }
  _instanced(geometry, material, castShadow) {
    const mesh = new THREE.InstancedMesh(geometry, material, 4);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    return mesh;
  }
  _brakeMaterial() {
    const base = this.materials?.clone?.("brake_disc");
    const mat = base ?? new THREE.MeshStandardMaterial({
      color: 1776672,
      metalness: 0.6,
      roughness: 0.55,
      emissive: new THREE.Color(16777215),
      emissiveIntensity: 3.2
    });
    mat.vertexColors = true;
    mat.emissive.setRGB(1, 1, 1);
    mat.emissiveIntensity = mat.userData?.emissiveIntensityHot ?? 3.2;
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace("#include <color_fragment>", "").replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n	totalEmissiveRadiance *= vColor.rgb;"
      );
    };
    mat.customProgramCacheKey = () => "apex_brake_glow";
    mat.needsUpdate = true;
    if (!base) this._ownedMaterials.push(mat);
    return mat;
  }
  setCompound(name) {
    if (!this.sidewall) return;
    const mat = this.materials?.tyreSidewall?.(name);
    if (mat && mat !== this._sidewallMat) {
      this._sidewallMat = mat;
      this.sidewall.material = mat;
    }
  }
  setWheel(i, position, steer, camber, spin) {
    const flip = IS_LEFT[i];
    const r = this.radius[i];
    const w = this.width[i];
    _q.setFromAxisAngle(_axisY, -steer);
    if (this.contact) {
      _p.set(position.x, position.y - r + CONTACT_LIFT, position.z);
      _s.set(this._contactScale[i * 2], 1, this._contactScale[i * 2 + 1]);
      _m.compose(_p, _q, _s);
      this.contact.setMatrixAt(i, _m);
    }
    _qb.setFromAxisAngle(_axisZ, -camber);
    _q.multiply(_qb);
    if (this.caliper) {
      _s.set(this.discRadius[i] / 0.132, this.discRadius[i] / 0.132, this.discRadius[i] / 0.132);
      _m.compose(position, _q, _s);
      this.caliper.setMatrixAt(i, _m);
    }
    if (this.disc) {
      _s.set(0.03, this.discRadius[i], this.discRadius[i]);
      _qb.setFromAxisAngle(_axisX, -spin);
      _q.multiply(_qb);
      if (flip) _q.multiply(_flip);
      _m.compose(position, _q, _s);
      this.disc.setMatrixAt(i, _m);
    } else {
      _qb.setFromAxisAngle(_axisX, -spin);
      _q.multiply(_qb);
      if (flip) _q.multiply(_flip);
    }
    _s.set(w, r, r);
    _m.compose(position, _q, _s);
    this.tread.setMatrixAt(i, _m);
    if (this.sidewall) this.sidewall.setMatrixAt(i, _m);
    if (this.rim) this.rim.setMatrixAt(i, _m);
  }
  setBrakeTemp(i, celsius) {
    if (this._brakeTemp[i] !== celsius) {
      this._brakeTemp[i] = celsius;
      this._dirtyGlow = true;
    }
  }
  commit() {
    this.tread.instanceMatrix.needsUpdate = true;
    if (this.sidewall) this.sidewall.instanceMatrix.needsUpdate = true;
    if (this.rim) this.rim.instanceMatrix.needsUpdate = true;
    if (this.contact) this.contact.instanceMatrix.needsUpdate = true;
    if (this.disc) {
      this.disc.instanceMatrix.needsUpdate = true;
      if (this.caliper) this.caliper.instanceMatrix.needsUpdate = true;
      if (this._dirtyGlow) {
        for (let i = 0; i < 4; i++) {
          glowColor(this._brakeTemp[i], _c);
          this.disc.setColorAt(i, _c);
        }
        this.disc.instanceColor.needsUpdate = true;
        this._dirtyGlow = false;
      }
    }
  }
  setVisible(v) {
    this.group.visible = v;
  }
  dispose() {
    for (const m of this._ownedMaterials) m.dispose();
    this._ownedMaterials.length = 0;
    for (const child of this.group.children) {
      if (child.isInstancedMesh) child.dispose();
    }
    this.group.clear();
  }
}
export { glowColor };
