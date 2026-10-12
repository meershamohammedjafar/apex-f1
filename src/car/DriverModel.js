import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  createCanvas,
  textureFromCanvas,
  makeDataTexture,
  mipChain,
  normalMipChain,
  applyToksvig
} from "../render/textures/NoiseTextures.js";
import { buildNomex, buildGloveLeather } from "../render/textures/CarTextures.js";
import { clamp, clamp01, DEG } from "../core/MathUtils.js";
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _bend = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _UP = new THREE.Vector3(0, 1, 0);
const HELMET_RADIUS = 0.132;
function css(hex) {
  return `#${(hex >>> 0).toString(16).padStart(6, "0")}`;
}
function drawHelmet(c, w, h, helmet, driver) {
  const base = css(helmet.base);
  const trim = css(helmet.trim);
  const mark = css(helmet.mark);
  c.fillStyle = base;
  c.fillRect(0, 0, w, h);
  const front = w * 0.75;
  switch (helmet.pattern) {
    case "chevron": {
      c.fillStyle = trim;
      for (let k = -1; k <= 1; k++) {
        c.beginPath();
        c.moveTo(front + k * w * 0.5 - w * 0.16, 0);
        c.lineTo(front + k * w * 0.5, h * 0.42);
        c.lineTo(front + k * w * 0.5 + w * 0.16, 0);
        c.lineTo(front + k * w * 0.5 + w * 0.07, 0);
        c.lineTo(front + k * w * 0.5, h * 0.26);
        c.lineTo(front + k * w * 0.5 - w * 0.07, 0);
        c.closePath();
        c.fill();
      }
      break;
    }
    case "bands":
      c.fillStyle = trim;
      c.fillRect(0, h * 0.16, w, h * 0.1);
      c.fillStyle = mark;
      c.fillRect(0, h * 0.28, w, h * 0.045);
      break;
    case "halves":
      c.fillStyle = trim;
      c.fillRect(0, 0, w, h * 0.5);
      break;
    case "blade":
      c.fillStyle = trim;
      c.beginPath();
      c.moveTo(0, h * 0.1);
      c.lineTo(w, h * 0.02);
      c.lineTo(w, h * 0.34);
      c.lineTo(0, h * 0.44);
      c.closePath();
      c.fill();
      break;
    case "star": {
      c.fillStyle = trim;
      c.fillRect(0, h * 0.02, w, h * 0.14);
      c.fillStyle = mark;
      for (let k = 0; k < 6; k++) {
        const cx = (k + 0.5) * (w / 6);
        c.beginPath();
        for (let s = 0; s < 10; s++) {
          const a = s / 10 * Math.PI * 2 - Math.PI * 0.5;
          const r = s % 2 === 0 ? h * 0.075 : h * 0.032;
          const px = cx + Math.cos(a) * r;
          const py = h * 0.3 + Math.sin(a) * r;
          if (s === 0) c.moveTo(px, py);
          else c.lineTo(px, py);
        }
        c.closePath();
        c.fill();
      }
      break;
    }
    case "rising": {
      c.fillStyle = trim;
      c.beginPath();
      c.arc(front, h * 0.3, h * 0.2, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = mark;
      for (let k = 0; k < 12; k++) {
        const a = k / 12 * Math.PI * 2;
        c.save();
        c.translate(front, h * 0.3);
        c.rotate(a);
        c.fillRect(h * 0.2, -h * 0.014, h * 0.13, h * 0.028);
        c.restore();
      }
      break;
    }
    case "wave": {
      c.fillStyle = trim;
      c.beginPath();
      c.moveTo(0, h * 0.34);
      for (let x = 0; x <= w; x += w / 40) c.lineTo(x, h * (0.34 - 0.09 * Math.sin(x / w * Math.PI * 4)));
      c.lineTo(w, 0);
      c.lineTo(0, 0);
      c.closePath();
      c.fill();
      break;
    }
    default:
      c.fillStyle = trim;
      c.fillRect(0, h * 0.2, w, h * 0.16);
      break;
  }
  const apertureTop = h * 0.42;
  const apertureBottom = h * 0.66;
  c.fillStyle = "#08090c";
  c.beginPath();
  c.moveTo(0, apertureTop + h * 0.06);
  for (let x = 0; x <= w; x += w / 64) {
    const d = Math.abs((x / w - 0.75 + 1.5) % 1 - 0.5) * 2;
    c.lineTo(x, apertureTop + h * 0.075 * Math.pow(clamp01(d * 1.35), 2.2));
  }
  c.lineTo(w, apertureBottom);
  c.lineTo(0, apertureBottom);
  c.closePath();
  c.fill();
  c.fillStyle = mark;
  c.fillRect(0, apertureTop - h * 0.035, w, h * 0.032);
  c.fillStyle = "#16171c";
  c.fillRect(0, apertureBottom, w, h * 0.055);
  c.fillStyle = css(driver.team.colors.accent);
  c.fillRect(0, h * 0.86, w, h * 0.06);
  c.save();
  c.translate(front, h * 0.79);
  c.fillStyle = "#f2f4f7";
  c.font = `800 ${Math.round(h * 0.055)}px system-ui, Arial, sans-serif`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(driver.code, 0, 0);
  c.restore();
  const shade = c.createLinearGradient(0, 0, 0, h);
  shade.addColorStop(0, "rgba(255,255,255,0.10)");
  shade.addColorStop(0.55, "rgba(0,0,0,0)");
  shade.addColorStop(1, "rgba(0,0,0,0.28)");
  c.fillStyle = shade;
  c.fillRect(0, 0, w, h);
}
function helmetGeometry(detail) {
  const seg = detail >= 2 ? 32 : 16;
  const rings = detail >= 2 ? 22 : 12;
  const shell = new THREE.SphereGeometry(HELMET_RADIUS, seg, rings);
  shell.scale(1, 1.06, 1.14);
  shell.translate(0, 0, 8e-3);
  const parts = [shell];
  const chin = new THREE.SphereGeometry(HELMET_RADIUS * 0.72, seg, Math.max(8, rings >> 1), 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.4);
  chin.scale(1, 1, 1.3);
  chin.translate(0, -0.036, -0.02);
  parts.push(chin);
  if (detail >= 2) {
    const fin = new THREE.BoxGeometry(0.016, 0.028, 0.13);
    fin.translate(0, HELMET_RADIUS * 1.03, 0.052);
    parts.push(fin);
    const scoop = new THREE.CylinderGeometry(0.02, 0.026, 0.03, 10);
    scoop.rotateX(Math.PI * 0.5);
    scoop.translate(0, 0.03, -HELMET_RADIUS * 1.02);
    parts.push(scoop);
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  merged.computeVertexNormals();
  return merged;
}
function visorGeometry(detail) {
  const g = new THREE.SphereGeometry(
    HELMET_RADIUS * 1.012,
    detail >= 2 ? 28 : 14,
    detail >= 2 ? 12 : 7,
    Math.PI * 1.5 - 1.1,
    2.2,
    Math.PI * 0.4,
    0.52
  );
  g.scale(1, 1.06, 1.14);
  g.translate(0, 0, 8e-3);
  return g;
}
function bustGeometry(detail) {
  const seg = detail >= 2 ? 20 : 10;
  const parts = [];
  const torso = new THREE.SphereGeometry(0.185, seg, seg, 0, Math.PI * 2, 0, Math.PI * 0.55);
  torso.scale(1.3, 0.86, 0.92);
  torso.translate(0, -0.03, 0.01);
  parts.push(torso);
  for (const s of [1, -1]) {
    const arm = new THREE.SphereGeometry(0.072, Math.max(8, seg >> 1), Math.max(8, seg >> 1));
    arm.scale(1, 0.9, 1.5);
    arm.translate(s * 0.205, -0.055, -0.05);
    parts.push(arm);
  }
  const hans = new THREE.TorusGeometry(0.115, 0.024, 8, Math.max(10, seg), Math.PI);
  hans.rotateX(Math.PI * 0.5);
  hans.rotateY(Math.PI);
  hans.translate(0, 0.018, 0.01);
  parts.push(hans);
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  merged.computeVertexNormals();
  merged.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 0.6);
  return merged;
}
const _sharedDriver = new Map();
function sharedGeometry(detail) {
  const cached = _sharedDriver.get(detail);
  if (cached) return cached;
  const set = {
    helmet: helmetGeometry(detail),
    visor: visorGeometry(detail),
    bust: bustGeometry(detail)
  };
  _sharedDriver.set(detail, set);
  return set;
}
export function disposeSharedDriverGeometry() {
  for (const set of _sharedDriver.values()) {
    set.helmet.dispose();
    set.visor.dispose();
    set.bust.dispose();
  }
  _sharedDriver.clear();
}
const _helmetMaterials = new Map();
export function helmetMaterial(driver, quality) {
  const cached = _helmetMaterials.get(driver.code);
  if (cached) return cached;
  const w = Math.max(256, Math.round(768 * (quality?.textureScale ?? 1)));
  const h = w >> 1;
  const canvas = createCanvas(w, h);
  drawHelmet(canvas.getContext("2d"), w, h, driver.helmet, driver);
  const tex = textureFromCanvas(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  const mat = new THREE.MeshPhysicalMaterial({
    map: tex,
    roughness: 0.24,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.026,
    envMapIntensity: 1.6
  });
  mat.userData.texture = tex;
  _helmetMaterials.set(driver.code, mat);
  return mat;
}
export function disposeHelmetMaterials() {
  for (const m of _helmetMaterials.values()) {
    m.userData.texture?.dispose();
    m.dispose();
  }
  _helmetMaterials.clear();
}
export class DriverBust {
  constructor(ctx, driver, livery, detail = 2, anchor = [0, 0.48, -0.23]) {
    const geo = sharedGeometry(clamp(detail, 1, 2));
    this.group = new THREE.Group();
    this.group.name = "driver";
    this.group.position.set(anchor[0], anchor[1], anchor[2]);
    this.head = new THREE.Object3D();
    this.group.add(this.head);
    this.helmet = new THREE.Mesh(geo.helmet, helmetMaterial(driver, ctx.quality));
    this.helmet.castShadow = detail >= 2;
    this.head.add(this.helmet);
    const visorMat = detail >= 2 && ctx.materials?.get ? ctx.materials.get("visor_glass") : new THREE.MeshStandardMaterial({ color: 1054752, roughness: 0.12, metalness: 0.4 });
    this._ownVisorMaterial = !(detail >= 2 && ctx.materials?.get);
    this.visor = new THREE.Mesh(geo.visor, visorMat);
    this.visor.renderOrder = 2;
    this.head.add(this.visor);
    this.bust = new THREE.Mesh(geo.bust, livery.suit);
    this.bust.position.set(0, -0.185, 0.055);
    this.bust.castShadow = detail >= 2;
    this.group.add(this.bust);
  }
  setHeadLean(lateralG, longitudinalG) {
    this.head.rotation.z = clamp(-lateralG * 0.055, -0.14, 0.14);
    this.head.rotation.x = clamp(longitudinalG * 0.02, -0.06, 0.06);
  }
  setVisible(v) {
    this.group.visible = v;
  }
  dispose() {
    if (this._ownVisorMaterial) this.visor.material.dispose();
    this.group.clear();
  }
}
function limbGeometry(rRoot, rTip, detail) {
  const seg = detail >= 2 ? 24 : 8;
  const g = new THREE.CylinderGeometry(rTip, rRoot, 1, seg, 3, false);
  g.translate(0, 0.5, 0);
  scaleUv(g, 1.7, 1.5);
  return g;
}
function scaleUv(geo, su, sv) {
  const uv = geo.getAttribute("uv");
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geo;
}
function mirrorX(geo) {
  geo.scale(-1, 1, 1);
  const index = geo.getIndex();
  if (index) {
    const a = index.array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i];
      a[i] = a[i + 2];
      a[i + 2] = t;
    }
    index.needsUpdate = true;
  }
  return geo;
}
const GLOVE_TILE = 0.03;
const RIM_CENTRE_Y = -0.015;
const RIM_CENTRE_Z = -0.0258;
const FINGER_ARC_Y = 0.0375;
const FINGER_ARC_Z = 0.0335;
const HAND_LOFT = [
  [0.084, 0, 0.0286, 0.0286, 1],
  [0.0834, 0, 0.033, 0.033, 1],
  [0.0822, 0, 0.0374, 0.0374, 1],
  [0.08, 2e-4, 0.0416, 0.0416, 1],
  [0.076, 4e-4, 0.0446, 0.0446, 1],
  [0.069, 8e-4, 0.0458, 0.0454, 1],
  [0.062, 14e-4, 0.0452, 0.0442, 1],
  [0.054, 22e-4, 0.0432, 0.0416, 1],
  [0.0455, 32e-4, 0.0392, 0.0374, 1],
  [0.0375, 42e-4, 0.0344, 0.033, 1],
  [0.029, 52e-4, 0.0322, 0.0302, 1],
  [0.02, 62e-4, 0.032, 0.0282, 1],
  [0.011, 7e-3, 0.0342, 0.025, 1],
  [2e-3, 78e-4, 0.0368, 0.0212, 0.98],
  [-7e-3, 8e-3, 0.0398, 0.0182, 0.96],
  [-0.015, 8e-3, 0.04, 0.0154, 0.94],
  [-0.0228, 44e-4, 0.037, 0.0114, 0.92],
  [-0.029, -12e-4, 0.0316, 7e-3, 0.9],
  [-0.0332, -74e-4, 0.0244, 3e-3, 0.9]
];
const FINGERS = [
  [-0.0315, 0.045, 2.62, 0.0126, 92e-4],
  [-0.0105, 0.02, 2.8, 0.013, 95e-4],
  [0.0105, 0.06, 2.66, 0.0121, 89e-4],
  [0.03, 0.19, 2.4, 0.0106, 8e-3]
];
const THUMB_PATH = [
  [-6e-3, 0.025, -2e-3, 0.0166],
  [-0.032, 9e-3, 95e-4, 0.017],
  [-0.0505, -65e-4, 0.0135, 0.0138],
  [-0.0632, -0.0198, 82e-4, 0.0116],
  [-0.07, -0.0312, -22e-4, 96e-4]
];
const WRIST_BEND = 34 * DEG;
const WRIST_ROLL = 17 * DEG;
const BEND_Y0 = 2e-3;
const BEND_Y1 = 0.038;
const BEND_STEPS = 48;
function bendProfile(u) {
  const h = 4 / 3;
  if (u < 0.25) return h * u * u * 2;
  if (u > 0.75) {
    const v = u - 0.75;
    return h * (0.125 + 0.5 + v - v * v * 2);
  }
  return h * (0.125 + (u - 0.25));
}
const _bendAngle = new Float64Array(BEND_STEPS + 1);
const _bendX = new Float64Array(BEND_STEPS + 1);
const _bendY = new Float64Array(BEND_STEPS + 1);
let _bendReady = false;
function buildBendSpine() {
  if (_bendReady) return;
  const h = (BEND_Y1 - BEND_Y0) / BEND_STEPS;
  _bendX[0] = 0;
  _bendY[0] = BEND_Y0;
  _bendAngle[0] = 0;
  for (let i = 1; i <= BEND_STEPS; i++) {
    const a0 = _bendAngle[i - 1];
    const a1 = -WRIST_BEND * bendProfile(i / BEND_STEPS);
    _bendAngle[i] = a1;
    _bendX[i] = _bendX[i - 1] + h * 0.5 * (-Math.sin(a0) - Math.sin(a1));
    _bendY[i] = _bendY[i - 1] + h * 0.5 * (Math.cos(a0) + Math.cos(a1));
  }
  _bendReady = true;
}
function bendAtWrist(geo) {
  buildBendSpine();
  const pos = geo.getAttribute("position");
  const h = (BEND_Y1 - BEND_Y0) / BEND_STEPS;
  const cr = Math.cos(WRIST_ROLL);
  const sr = Math.sin(WRIST_ROLL);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    let bx = x;
    let by = y;
    if (y > BEND_Y0) {
      let sxv;
      let syv;
      let ang;
      if (y >= BEND_Y1) {
        ang = _bendAngle[BEND_STEPS];
        const over = y - BEND_Y1;
        sxv = _bendX[BEND_STEPS] - Math.sin(ang) * over;
        syv = _bendY[BEND_STEPS] + Math.cos(ang) * over;
      } else {
        const f = (y - BEND_Y0) / h;
        const k = Math.min(BEND_STEPS - 1, Math.floor(f));
        const u = f - k;
        ang = _bendAngle[k] + (_bendAngle[k + 1] - _bendAngle[k]) * u;
        sxv = _bendX[k] + (_bendX[k + 1] - _bendX[k]) * u;
        syv = _bendY[k] + (_bendY[k + 1] - _bendY[k]) * u;
      }
      bx = sxv + x * Math.cos(ang);
      by = syv + x * Math.sin(ang);
    }
    pos.setXY(i, bx * cr - by * sr, bx * sr + by * cr);
  }
  pos.needsUpdate = true;
  return geo;
}
const _st = [0, 0, 0, 0, 0];
const _sec = [0, 0, 0, 0];
const _lp = new THREE.Vector3();
const _hsA = new THREE.Vector3();
const _hsB = new THREE.Vector3();
const _lt = new THREE.Vector3();
const _ls = new THREE.Vector3();
const _ln = new THREE.Vector3();
function smoothstep01(x) {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}
function windowed(v, a0, a1, b1, b0) {
  return Math.min(
    smoothstep01((v - a0) / Math.max(1e-6, a1 - a0)),
    smoothstep01((b0 - v) / Math.max(1e-6, b0 - b1))
  );
}
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t2 * t);
}
function loftStation(t, out) {
  const n = HAND_LOFT.length - 1;
  const f = clamp01(t) * n;
  const i = Math.min(n - 1, Math.floor(f));
  const u = f - i;
  const a = HAND_LOFT[Math.max(0, i - 1)];
  const b = HAND_LOFT[i];
  const c = HAND_LOFT[i + 1];
  const d = HAND_LOFT[Math.min(n, i + 2)];
  for (let k = 0; k < 5; k++) out[k] = catmull(a[k], b[k], c[k], d[k], u);
  return out;
}
function sectionAt(w, d, cr, s, out) {
  const r = Math.min(w, d) * clamp01(cr);
  const ax = w - r;
  const az = d - r;
  const arc = Math.PI * 0.5 * r;
  const total = 4 * ax + 4 * az + 2 * Math.PI * r;
  let u = (s - Math.floor(s)) * total;
  if (u < ax) {
    out[0] = u;
    out[1] = -d;
    out[2] = 0;
    out[3] = -1;
    return total;
  }
  u -= ax;
  if (u < arc) {
    const a = -Math.PI * 0.5 + u / Math.max(1e-9, arc) * Math.PI * 0.5;
    out[2] = Math.cos(a);
    out[3] = Math.sin(a);
    out[0] = ax + r * out[2];
    out[1] = -az + r * out[3];
    return total;
  }
  u -= arc;
  if (u < 2 * az) {
    out[0] = w;
    out[1] = -az + u;
    out[2] = 1;
    out[3] = 0;
    return total;
  }
  u -= 2 * az;
  if (u < arc) {
    const a = u / Math.max(1e-9, arc) * Math.PI * 0.5;
    out[2] = Math.cos(a);
    out[3] = Math.sin(a);
    out[0] = ax + r * out[2];
    out[1] = az + r * out[3];
    return total;
  }
  u -= arc;
  if (u < 2 * ax) {
    out[0] = ax - u;
    out[1] = d;
    out[2] = 0;
    out[3] = 1;
    return total;
  }
  u -= 2 * ax;
  if (u < arc) {
    const a = Math.PI * 0.5 + u / Math.max(1e-9, arc) * Math.PI * 0.5;
    out[2] = Math.cos(a);
    out[3] = Math.sin(a);
    out[0] = -ax + r * out[2];
    out[1] = az + r * out[3];
    return total;
  }
  u -= arc;
  if (u < 2 * az) {
    out[0] = -w;
    out[1] = az - u;
    out[2] = -1;
    out[3] = 0;
    return total;
  }
  u -= 2 * az;
  if (u < arc) {
    const a = Math.PI + u / Math.max(1e-9, arc) * Math.PI * 0.5;
    out[2] = Math.cos(a);
    out[3] = Math.sin(a);
    out[0] = -ax + r * out[2];
    out[1] = -az + r * out[3];
    return total;
  }
  u -= arc;
  out[0] = -ax + u;
  out[1] = -d;
  out[2] = 0;
  out[3] = -1;
  return total;
}
function handPoint(t, s, out) {
  loftStation(t, _st);
  sectionAt(_st[2], _st[3], _st[4], s, _sec);
  out.set(_sec[0], _st[0], _st[1] + _sec[1]);
  return out;
}
function handSurface(t, s, outP, outN) {
  loftStation(t, _st);
  const perimeter = sectionAt(_st[2], _st[3], _st[4], s, _sec);
  outP.set(_sec[0], _st[0], _st[1] + _sec[1]);
  _ls.set(-_sec[3], 0, _sec[2]);
  const h = 0.012;
  handPoint(Math.min(1, t + h), s, _hsA);
  handPoint(Math.max(0, t - h), s, _hsB);
  _lt.subVectors(_hsA, _hsB);
  outN.crossVectors(_ls, _lt);
  if (outN.lengthSq() < 1e-12) outN.set(_sec[2], 0, _sec[3]);
  outN.normalize();
  if (outN.x * _sec[2] + outN.z * _sec[3] < 0) outN.negate();
  return perimeter;
}
function loftShell(t0, t1, rings, seg, offset) {
  const pos = new Float32Array((rings + 1) * seg * 3 + 6);
  const uv = new Float32Array((rings + 1) * seg * 2 + 4);
  const index = [];
  let v = 0;
  let arcLen = 0;
  const prev = new THREE.Vector3();
  for (let k = 0; k <= rings; k++) {
    const t = t0 + (t1 - t0) * (k / rings);
    if (k > 0) {
      handPoint(t, 0, _lp);
      arcLen += prev.distanceTo(_lp);
    }
    handPoint(t, 0, prev);
    let perimeter = 0;
    for (let j = 0; j < seg; j++) {
      const s = j / seg;
      perimeter = handSurface(t, s, _lp, _ln);
      const off = offset ? offset(s, _lp, _ln) : 0;
      const i3 = v * 3;
      pos[i3] = _lp.x + _ln.x * off;
      pos[i3 + 1] = _lp.y + _ln.y * off;
      pos[i3 + 2] = _lp.z + _ln.z * off;
      uv[v * 2] = s * perimeter / GLOVE_TILE;
      uv[v * 2 + 1] = arcLen / GLOVE_TILE;
      v++;
    }
    if (k > 0) {
      const a = (k - 1) * seg;
      const b = k * seg;
      for (let j = 0; j < seg; j++) {
        const j2 = (j + 1) % seg;
        index.push(a + j, b + j2, b + j, a + j, a + j2, b + j2);
      }
    }
  }
  for (let e = 0; e < 2; e++) {
    const t = e === 0 ? t0 : t1;
    loftStation(t, _st);
    const c = v;
    pos[v * 3] = 0;
    pos[v * 3 + 1] = _st[0];
    pos[v * 3 + 2] = _st[1];
    uv[v * 2] = 0;
    uv[v * 2 + 1] = arcLen / GLOVE_TILE;
    v++;
    const ring = e === 0 ? 0 : rings * seg;
    for (let j = 0; j < seg; j++) {
      const j2 = (j + 1) % seg;
      if (e === 0) index.push(c, ring + j2, ring + j);
      else index.push(c, ring + j, ring + j2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  return geo;
}
const _swA = new THREE.Vector3();
const _swB = new THREE.Vector3();
const _swT = new THREE.Vector3();
const _swU = new THREE.Vector3();
const _swV = new THREE.Vector3();
function sweepTube(path, radius, rings, seg, flat) {
  const count = (rings + 1) * seg + 2;
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const index = [];
  _swU.set(1, 0, 0);
  let v = 0;
  let arcLen = 0;
  const prev = new THREE.Vector3();
  for (let k = 0; k <= rings; k++) {
    const t = k / rings;
    path(t, _swA);
    path(Math.min(1, t + 0.01), _swB);
    _swT.subVectors(_swB, _swA);
    if (_swT.lengthSq() < 1e-12) {
      path(Math.max(0, t - 0.01), _swB);
      _swT.subVectors(_swA, _swB);
    }
    _swT.normalize();
    _swU.addScaledVector(_swT, -_swU.dot(_swT));
    if (_swU.lengthSq() < 1e-8) _swU.set(1, 0, 0).addScaledVector(_swT, -_swT.x);
    _swU.normalize();
    _swV.crossVectors(_swT, _swU).normalize();
    if (k > 0) arcLen += prev.distanceTo(_swA);
    prev.copy(_swA);
    const r = radius(t);
    for (let j = 0; j < seg; j++) {
      const th = j / seg * Math.PI * 2;
      const cx = Math.cos(th) * r * flat;
      const cy = Math.sin(th) * r;
      const i3 = v * 3;
      pos[i3] = _swA.x + _swU.x * cx + _swV.x * cy;
      pos[i3 + 1] = _swA.y + _swU.y * cx + _swV.y * cy;
      pos[i3 + 2] = _swA.z + _swU.z * cx + _swV.z * cy;
      uv[v * 2] = th * r / GLOVE_TILE;
      uv[v * 2 + 1] = arcLen / GLOVE_TILE;
      v++;
    }
    if (k > 0) {
      const a = (k - 1) * seg;
      const b = k * seg;
      for (let j = 0; j < seg; j++) {
        const j2 = (j + 1) % seg;
        index.push(a + j, b + j2, b + j, a + j, a + j2, b + j2);
      }
    }
  }
  for (let e = 0; e < 2; e++) {
    path(e === 0 ? 0 : 1, _swA);
    const c = v;
    pos[v * 3] = _swA.x;
    pos[v * 3 + 1] = _swA.y;
    pos[v * 3 + 2] = _swA.z;
    uv[v * 2] = 0;
    uv[v * 2 + 1] = arcLen / GLOVE_TILE;
    v++;
    const ring = e === 0 ? 0 : rings * seg;
    for (let j = 0; j < seg; j++) {
      const j2 = (j + 1) % seg;
      if (e === 0) index.push(c, ring + j2, ring + j);
      else index.push(c, ring + j, ring + j2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  return geo;
}
function bump(x, width) {
  const u = x / width;
  return Math.exp(-u * u);
}
function fingerGeometry(spec, rings, seg, creases) {
  const [station, phi0, phi1, rRoot, rTip] = spec;
  const a0 = phi0 - 0.34;
  const span = phi1 - a0;
  const path = (t, out) => {
    const phi = a0 + span * t;
    const drift = -station * 0.2 * t * t;
    out.set(
      station + drift,
      RIM_CENTRE_Y - FINGER_ARC_Y * Math.sin(phi),
      RIM_CENTRE_Z + FINGER_ARC_Z * Math.cos(phi)
    );
  };
  const k0 = (phi0 - a0) / span;
  const jointT = [k0, k0 + (1 - k0) * 0.38, k0 + (1 - k0) * 0.71];
  const radius = (t) => {
    const base = rRoot + (rTip - rRoot) * clamp01((t - k0) / Math.max(1e-6, 1 - k0));
    const swell = 1 + 0.19 * bump(t - jointT[0], 0.11) + 0.13 * bump(t - jointT[1], 0.085) + 0.1 * bump(t - jointT[2], 0.07);
    const tip = t > 0.89 ? Math.sqrt(Math.max(0, 1 - ((t - 0.89) / 0.115) ** 2)) : 1;
    return base * swell * Math.max(0.06, tip);
  };
  const g = sweepTube(path, radius, rings, seg, 0.86);
  const p = new THREE.Vector3();
  for (let j = 0; j < 3; j++) {
    path(jointT[j], p);
    creases.push(p.x, p.y, p.z, [0.015, 0.0112, 92e-4][j], [0.42, 0.34, 0.26][j]);
  }
  if (station < 0.02) {
    for (let j = 0; j <= 6; j++) {
      const t = k0 + (1 - k0) * (j / 6) * 0.62;
      path(t, p);
      creases.push(p.x + 0.0106, p.y, p.z, 85e-4, 0.34);
    }
  }
  return g;
}
function thumbGeometry(rings, seg, creases) {
  const curve = new THREE.CatmullRomCurve3(
    THUMB_PATH.map((p2) => new THREE.Vector3(p2[0], p2[1], p2[2])),
    false,
    "centripetal",
    0.5
  );
  const radii = THUMB_PATH.map((p2) => p2[3]);
  const path = (t, out) => curve.getPoint(t, out);
  const radius = (t) => {
    const f = t * (radii.length - 1);
    const i = Math.min(radii.length - 2, Math.floor(f));
    const base = radii[i] + (radii[i + 1] - radii[i]) * (f - i);
    const swell = 1 + 0.14 * bump(t - 0.46, 0.1) + 0.1 * bump(t - 0.76, 0.085);
    const tip = t > 0.88 ? Math.sqrt(Math.max(0, 1 - ((t - 0.88) / 0.125) ** 2)) : 1;
    return base * swell * Math.max(0.06, tip);
  };
  const p = new THREE.Vector3();
  for (const t of [0.3, 0.46, 0.76]) {
    path(t, p);
    creases.push(p.x, p.y, p.z, 0.0135, 0.34);
  }
  return sweepTube(path, radius, rings, seg, 0.9);
}
function applyCreaseColours(geo, creases) {
  const pos = geo.getAttribute("position");
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let darkest = 0;
    for (let c = 0; c < creases.length; c += 5) {
      const r = creases[c + 3];
      const dx = x - creases[c], dy = y - creases[c + 1], dz = z - creases[c + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r * r) continue;
      const t = 1 - Math.sqrt(d2) / r;
      const k2 = creases[c + 4] * t * t;
      if (k2 > darkest) darkest = k2;
    }
    const k = 1 - darkest;
    out[i * 3] = k;
    out[i * 3 + 1] = k;
    out[i * 3 + 2] = k;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(out, 3));
  return geo;
}
const _stA = new THREE.Vector3();
const _stN = new THREE.Vector3();
const _stT = new THREE.Vector3();
const _stS = new THREE.Vector3();
function stitchRow(seam, length, pitch, out) {
  const n = Math.max(2, Math.round(length / pitch));
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    seam(u, _sec);
    handSurface(_sec[0], _sec[1], _stA, _stN);
    seam(Math.min(1, u + 0.02), _sec);
    handSurface(_sec[0], _sec[1], _stT, _stS);
    _stT.sub(_stA);
    if (_stT.lengthSq() < 1e-12) _stT.set(1, 0, 0);
    _stT.normalize();
    _stS.crossVectors(_stN, _stT).normalize();
    const g = new THREE.SphereGeometry(1, 6, 3);
    const m = new THREE.Matrix4().makeBasis(_stT, _stN, _stS);
    m.scale(new THREE.Vector3(16e-4, 9e-4, 6e-4));
    m.setPosition(
      _stA.x - _stN.x * 3e-4,
      _stA.y - _stN.y * 3e-4,
      _stA.z - _stN.z * 3e-4
    );
    g.applyMatrix4(m);
    const uv = g.getAttribute("uv");
    const p = g.getAttribute("position");
    for (let k = 0; k < uv.count; k++) {
      uv.setXY(k, p.getX(k) / GLOVE_TILE, p.getY(k) / GLOVE_TILE);
    }
    out.push(g);
  }
}
function loftT(y) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) * 0.5;
    loftStation(mid, _st);
    if (_st[0] > y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}
function loftSeamS(t, nz, side) {
  let best = side > 0 ? 0.15 : 0.65;
  let bestErr = Infinity;
  for (let i = 0; i <= 160; i++) {
    const s = i / 160;
    handSurface(t, s, _lp, _ln);
    if (Math.sign(_lp.x || side) !== Math.sign(side)) continue;
    const err = Math.abs(_ln.z - nz);
    if (err < bestErr) {
      bestErr = err;
      best = s;
    }
  }
  return best;
}
function gloveGeometry(detail, side) {
  const hero = detail >= 2;
  const seg = hero ? 40 : 18;
  const fseg = hero ? 16 : 8;
  const fabric = [];
  const leather = [];
  const guard = [];
  const accent = [];
  const stitch = [];
  const creases = [];
  fabric.push(loftShell(0, 1, hero ? 40 : 18, seg, null));
  for (const spec of FINGERS) fabric.push(fingerGeometry(spec, hero ? 22 : 10, fseg, creases));
  fabric.push(thumbGeometry(hero ? 20 : 9, fseg, creases));
  const padT0 = loftT(0.025);
  const padT1 = loftT(1e-3);
  fabric.push(loftShell(padT0, padT1, hero ? 14 : 6, seg, (s, p, n) => {
    const quilt = 1 - 0.34 * (bump(p.x, 4e-3) + bump(p.x - 0.0175, 4e-3) + bump(p.x + 0.0175, 4e-3));
    const k = windowed(p.y, 1e-3, 62e-4, 0.0198, 0.025) * smoothstep01((n.z - 0.16) / 0.4) * windowed(p.x, -0.033, -0.025, 0.025, 0.033);
    return -16e-4 + 4e-3 * k * quilt;
  }));
  const guardT0 = loftT(-1e-3);
  const guardT1 = loftT(-0.028);
  guard.push(loftShell(guardT0, guardT1, hero ? 16 : 7, seg, (s, p, n) => {
    let ribs = 0;
    for (const f of FINGERS) ribs += bump(p.x - f[0], 82e-4);
    const amp = 17e-4 + 28e-4 * Math.min(1, ribs);
    const k = windowed(p.y, -0.028, -0.0238, -56e-4, -1e-3) * smoothstep01((n.z - 0.28) / 0.26) * windowed(p.x, -0.0412, -0.0348, 0.0348, 0.0412);
    return -18e-4 + (amp + 18e-4) * k;
  }));
  const palmT0 = loftT(0.034);
  const palmT1 = loftT(-0.0302);
  leather.push(loftShell(palmT0, palmT1, hero ? 22 : 10, seg, (s, p, n) => {
    const k = windowed(p.y, -0.0302, -0.0252, 0.0284, 0.034) * (1 - smoothstep01((n.z - 0.18) / 0.3));
    return -14e-4 + 22e-4 * k;
  }));
  const strapT0 = loftT(0.06);
  const strapT1 = loftT(0.048);
  accent.push(loftShell(strapT0, strapT1, hero ? 8 : 4, seg, (s, p) => -16e-4 + 38e-4 * windowed(p.y, 0.048, 0.0501, 0.0579, 0.06)));
  if (hero) {
    for (const y of [0.0722, 0.043]) {
      const t = loftT(y);
      loftStation(t, _st);
      const circumference = 2 * Math.PI * (_st[2] + _st[3]) * 0.5;
      stitchRow((u, o) => {
        o[0] = t;
        o[1] = u;
      }, circumference, 7e-3, stitch);
    }
    for (const sgn of [1, -1]) {
      const sA = loftSeamS(palmT0, 0.1, sgn);
      const sB = loftSeamS(palmT1, 0.1, sgn);
      stitchRow((u, o) => {
        o[0] = palmT0 + (palmT1 - palmT0) * u;
        o[1] = sA + (sB - sA) * u;
      }, 0.068, 58e-4, stitch);
    }
    for (const x of [0.0278, -0.0278]) {
      const sA = loftSeamS(padT0, 0.55, Math.sign(x));
      const sB = loftSeamS(padT1, 0.55, Math.sign(x));
      stitchRow((u, o) => {
        o[0] = padT0 + (padT1 - padT0) * u;
        o[1] = sA + (sB - sA) * u;
      }, 0.03, 58e-4, stitch);
    }
  }
  for (let i = -2; i <= 2; i++) {
    creases.push(i * 0.0125, 0.0295, 0.0245 - Math.abs(i) * 16e-4, 0.0125, 0.26);
  }
  creases.push(-0.033, 0.014, 9e-3, 0.0155, 0.3);
  const groups = [
    mergeGeometries(fabric, false),
    mergeGeometries(leather, false),
    mergeGeometries(guard, false),
    mergeGeometries(accent, false),
    stitch.length ? mergeGeometries(stitch, false) : new THREE.BufferGeometry()
  ];
  for (const list of [fabric, leather, guard, accent, stitch]) for (const g of list) g.dispose();
  if (!groups[4].getAttribute("position")) {
    const dot = new THREE.SphereGeometry(4e-4, 4, 2);
    dot.translate(0, 0.03, -0.01);
    const uv = dot.getAttribute("uv");
    for (let k = 0; k < uv.count; k++) uv.setXY(k, 0, 0);
    groups[4].dispose();
    groups[4] = dot;
  }
  for (const g of groups) {
    g.deleteAttribute("normal");
    applyCreaseColours(g, creases);
  }
  const merged = mergeGeometries(groups, true);
  for (const g of groups) g.dispose();
  bendAtWrist(merged);
  merged.computeVertexNormals();
  if (side < 0) mirrorX(merged);
  return merged;
}
const _gloveMats = new Map();
let _gloveMaps = null;
function gloveMaps(ctx) {
  if (_gloveMaps) return _gloveMaps;
  const px = ctx?.quality?.name === "low" ? 128 : 256;
  const aniso = ctx?.materials?.anisotropy ?? 4;
  const knit = buildNomex(px, {
    seed: 3347,
    weave: 26,
    stitch: 0,
    tint: 8421504,
    roughness: 0.78,
    tile: 0.04,
    normalStrength: 1.9
  });
  const hide = buildGloveLeather(Math.max(64, px >> 1), { seed: 8821, cells: 22, tile: 0.045 });
  const knitNormal = normalMipChain(knit.normal, knit.width, knit.height);
  const knitOrm = mipChain(knit.orm, knit.width, knit.height, false);
  applyToksvig(knitOrm, knitNormal.lengths);
  const hideNormal = normalMipChain(hide.normal, hide.width, hide.height);
  const hideOrm = mipChain(hide.orm, hide.width, hide.height, false);
  applyToksvig(hideOrm, hideNormal.lengths);
  const make = (data, w, h, mips) => {
    const t = makeDataTexture(data, w, h, THREE.NoColorSpace, mips);
    t.anisotropy = aniso;
    return t;
  };
  _gloveMaps = {
    knitNormal: make(knit.normal, knit.width, knit.height, knitNormal.levels),
    knitOrm: make(knit.orm, knit.width, knit.height, knitOrm),
    hideNormal: make(hide.normal, hide.width, hide.height, hideNormal.levels),
    hideOrm: make(hide.orm, hide.width, hide.height, hideOrm)
  };
  _gloveMaps.knitOrm.channel = 0;
  _gloveMaps.hideOrm.channel = 0;
  return _gloveMaps;
}
const GLOVE_FABRIC_REF = 9059102;
const GLOVE_FABRIC_NEUTRAL = 3814960;
const _hsl = { h: 0, s: 0, l: 0 };
function fabricColour(teamHex) {
  const ref = new THREE.Color(GLOVE_FABRIC_REF);
  ref.getHSL(_hsl);
  const refS = _hsl.s;
  const refL = _hsl.l;
  new THREE.Color(teamHex).getHSL(_hsl);
  if (_hsl.s < 0.12) return new THREE.Color(GLOVE_FABRIC_NEUTRAL);
  return new THREE.Color().setHSL(_hsl.h, refS, refL);
}
export function gloveMaterials(ctx, livery) {
  const cached = _gloveMats.get(livery);
  if (cached) return cached;
  const maps = gloveMaps(ctx);
  const teamHex = livery?.colors?.primary ?? livery?.colors?.accent ?? GLOVE_FABRIC_REF;
  const accentHex = livery?.colors?.accent ?? 14212322;
  const cloth = fabricColour(teamHex);
  const knit = new THREE.MeshPhysicalMaterial({
    color: cloth,
    roughness: 0.78,
    metalness: 0,
    normalMap: maps.knitNormal,
    aoMap: maps.knitOrm,
    vertexColors: true,
    sheen: 0.1,
    sheenRoughness: 0.88,
    sheenColor: cloth.clone().lerp(new THREE.Color(7764868), 0.55),
    envMapIntensity: 0.32
  });
  knit.normalScale.set(1, 1);
  const palm = new THREE.MeshPhysicalMaterial({
    color: 3089951,
    roughness: 1,
    roughnessMap: maps.hideOrm,
    metalness: 0,
    normalMap: maps.hideNormal,
    aoMap: maps.hideOrm,
    vertexColors: true,
    envMapIntensity: 0.55
  });
  palm.normalScale.set(0.85, 0.85);
  const guard = new THREE.MeshPhysicalMaterial({
    color: 1513501,
    roughness: 0.52,
    metalness: 0,
    normalMap: maps.hideNormal,
    vertexColors: true,
    clearcoat: 0.3,
    clearcoatRoughness: 0.42,
    envMapIntensity: 0.45
  });
  guard.normalScale.set(0.26, 0.26);
  const strapColour = new THREE.Color(accentHex).lerp(cloth, 0.62);
  const strap = new THREE.MeshPhysicalMaterial({
    color: strapColour,
    roughness: 0.8,
    metalness: 0,
    normalMap: maps.knitNormal,
    vertexColors: true,
    sheen: 0.14,
    sheenRoughness: 0.84,
    sheenColor: strapColour.clone().lerp(new THREE.Color(16777215), 0.25),
    envMapIntensity: 0.28
  });
  strap.normalScale.set(0.7, 0.7);
  const threadColour = cloth.clone().lerp(new THREE.Color(14208962), 0.62);
  const thread = new THREE.MeshPhysicalMaterial({
    color: threadColour,
    roughness: 0.54,
    metalness: 0,
    vertexColors: true,
    sheen: 0.3,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(16777215),
    envMapIntensity: 0.3
  });
  const set = [knit, palm, guard, strap, thread];
  _gloveMats.set(livery, set);
  return set;
}
const _suitMats = new Map();
export function cockpitSuitMaterial(livery) {
  const base = livery?.suit;
  if (!base) return null;
  const cached = _suitMats.get(base);
  if (cached) return cached;
  const m = base.clone();
  if (base.normalScale) m.normalScale.set(base.normalScale.x * 0.42, base.normalScale.y * 0.42);
  m.aoMapIntensity = 0.55;
  _suitMats.set(base, m);
  return m;
}
export function disposeCockpitSuitMaterials() {
  for (const m of _suitMats.values()) m.dispose();
  _suitMats.clear();
}
export function disposeGloveMaterials() {
  for (const set of _gloveMats.values()) for (const m of set) m.dispose();
  _gloveMats.clear();
  if (_gloveMaps) {
    for (const key of Object.keys(_gloveMaps)) _gloveMaps[key].dispose();
    _gloveMaps = null;
  }
}
const _armGeoCache = new Map();
function armGeometry(detail) {
  const cached = _armGeoCache.get(detail);
  if (cached) return cached;
  const set = {
    upper: limbGeometry(0.052, 0.042, detail),
    fore: limbGeometry(0.044, 0.024, detail),
    gloveRight: gloveGeometry(detail, 1),
    gloveLeft: gloveGeometry(detail, -1)
  };
  _armGeoCache.set(detail, set);
  return set;
}
export function disposeSharedArmGeometry() {
  for (const set of _armGeoCache.values()) {
    set.upper.dispose();
    set.fore.dispose();
    set.gloveRight.dispose();
    set.gloveLeft.dispose();
  }
  _armGeoCache.clear();
  disposeGloveMaterials();
  disposeCockpitSuitMaterials();
}
const UPPER_LENGTH = 0.3;
const ELBOW_OVERLAP = 0.026;
const FORE_LENGTH = 0.282;
const WRIST_INSET = 0.055;
export class ArmChain {
  constructor(ctx, livery, side, shoulder, detail = 2) {
    const geo = armGeometry(detail);
    this.side = side;
    this.baseShoulder = new THREE.Vector3(shoulder[0], shoulder[1], shoulder[2]);
    this.shoulder = this.baseShoulder.clone();
    this.elbow = new THREE.Vector3();
    this.group = new THREE.Group();
    this.group.name = side > 0 ? "arm-right" : "arm-left";
    const suit = cockpitSuitMaterial(livery) ?? livery.suit;
    this.upper = new THREE.Mesh(geo.upper, suit);
    this.upper.position.copy(this.shoulder);
    this.upper.scale.set(1, UPPER_LENGTH, 1);
    this.upper.castShadow = false;
    this.group.add(this.upper);
    this.fore = new THREE.Mesh(geo.fore, suit);
    this.fore.scale.set(1, FORE_LENGTH, 1);
    this.fore.castShadow = detail >= 2;
    this.group.add(this.fore);
    this.hand = new THREE.Mesh(
      side > 0 ? geo.gloveRight : geo.gloveLeft,
      gloveMaterials(ctx, livery)
    );
    this.hand.castShadow = detail >= 2;
    this.group.add(this.hand);
    this._pole = new THREE.Vector3(side * 0.82, -0.42, 0.3).normalize();
  }
  solve(targetPos) {
    const s = this.shoulder;
    this.upper.position.copy(s);
    _v.subVectors(targetPos, s);
    const d = clamp(_v.length(), Math.abs(UPPER_LENGTH - FORE_LENGTH) + 0.02, UPPER_LENGTH + FORE_LENGTH - 5e-3);
    _v.normalize();
    const cosA = clamp(
      (UPPER_LENGTH * UPPER_LENGTH + d * d - FORE_LENGTH * FORE_LENGTH) / (2 * UPPER_LENGTH * d),
      -1,
      1
    );
    const a = Math.acos(cosA);
    _bend.copy(this._pole).addScaledVector(_v, -this._pole.dot(_v));
    if (_bend.lengthSq() < 1e-6) _bend.set(0, -1, 0).addScaledVector(_v, _v.y);
    _bend.normalize();
    this.elbow.copy(s).addScaledVector(_v, Math.cos(a) * UPPER_LENGTH).addScaledVector(_bend, Math.sin(a) * UPPER_LENGTH);
    _v2.subVectors(this.elbow, s).normalize();
    _q.setFromUnitVectors(_UP, _v2);
    this.upper.quaternion.copy(_q);
    _v3.subVectors(targetPos, this.elbow);
    const foreLength = Math.max(0.05, _v3.length());
    _v3.multiplyScalar(1 / foreLength);
    _q.setFromUnitVectors(_UP, _v3);
    this.fore.quaternion.copy(_q);
    this.fore.position.copy(this.elbow).addScaledVector(_v3, -ELBOW_OVERLAP);
    this.fore.scale.set(1, Math.max(0.06, foreLength + ELBOW_OVERLAP - WRIST_INSET), 1);
    this.hand.position.copy(targetPos);
    return this.elbow;
  }
  orientHand(q) {
    this.hand.quaternion.copy(q);
  }
  dispose() {
    this.group.clear();
  }
}
export function legsGeometry(detail, knee, ankle, hip) {
  const parts = [];
  const seg = detail >= 2 ? 14 : 8;
  for (const side of [1, -1]) {
    const hipP = new THREE.Vector3(side * 0.105, hip[1], hip[2]);
    const kneeP = new THREE.Vector3(side * knee[0], knee[1], knee[2]);
    const ankleP = new THREE.Vector3(side * ankle[0], ankle[1], ankle[2]);
    const thighLen = hipP.distanceTo(kneeP);
    const thigh = new THREE.CylinderGeometry(0.086, 0.072, thighLen, seg, 2);
    thigh.translate(0, thighLen * 0.5, 0);
    _v.subVectors(kneeP, hipP).normalize();
    _q.setFromUnitVectors(_UP, _v);
    thigh.applyQuaternion(_q);
    thigh.translate(hipP.x, hipP.y, hipP.z);
    parts.push(thigh);
    const shinLen = kneeP.distanceTo(ankleP);
    const shin = new THREE.CylinderGeometry(0.07, 0.052, shinLen, seg, 2);
    shin.translate(0, shinLen * 0.5, 0);
    _v.subVectors(ankleP, kneeP).normalize();
    _q.setFromUnitVectors(_UP, _v);
    shin.applyQuaternion(_q);
    shin.translate(kneeP.x, kneeP.y, kneeP.z);
    parts.push(shin);
    const kneeCap = new THREE.SphereGeometry(0.074, seg, Math.max(8, seg >> 1));
    kneeCap.scale(1, 1, 1.15);
    kneeCap.translate(kneeP.x, kneeP.y, kneeP.z);
    parts.push(kneeCap);
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  merged.computeVertexNormals();
  scaleUv(merged, 2.4, 2.4);
  return merged;
}
export { HELMET_RADIUS, UPPER_LENGTH, FORE_LENGTH, DEG };
