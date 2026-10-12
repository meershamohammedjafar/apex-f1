import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { clamp, clamp01, lerp, smoothstep, DEG } from "../core/MathUtils.js";
import { BODY_V_FRONT, BODY_V_REAR } from "./Teams.js";
const CG_HEIGHT = 0.28;
const GY = (h) => h - CG_HEIGHT;
const Z_FRONT_AXLE = -1.944;
const Z_REAR_AXLE = 1.656;
export const CAR_DIMENSIONS = {
  length: 5.63,
  width: 1.9,
  height: 0.95,
  noseTip: -2.4,
  wingLeadingEdge: -2.62,
  tail: 3.01,
  frontAxle: Z_FRONT_AXLE,
  rearAxle: Z_REAR_AXLE
};
export const COCKPIT_ANCHORS = {
  eye: [0, GY(0.79), -0.4],
  wheelCentre: [0, GY(0.558), -0.702],
  wheelRake: 62 * DEG,
  shoulder: [0.245, GY(0.545), -0.15],
  hip: [0, GY(0.348), -0.04],
  knee: [0.172, GY(0.436), -1.03],
  ankle: [0.128, GY(0.3), -1.5],
  helmet: [0, GY(0.772), -0.238],
  rimTopY: GY(0.6),
  mirrors: [
    { pos: [-0.428, GY(0.645), -0.655], housing: [-0.46, GY(0.645), -0.72], mount: [-0.32, GY(0.585), -0.56], yaw: 26 * DEG },
    { pos: [0.428, GY(0.645), -0.655], housing: [0.46, GY(0.645), -0.72], mount: [0.32, GY(0.585), -0.56], yaw: -26 * DEG }
  ]
};
export const DRS_PIVOT = [0, GY(0.788), 2.742];
export const DRS_OPEN_ANGLE = 47 * DEG;
const ROLES = ["body", "wing", "carbon", "carbonWeave", "carbonMatte", "accent", "dark", "metal", "halo"];
const DUCT_WALL = 0.02;
const LOUVRE_STANDOFF = 8e-3;
const LOUVRE_RAKE = 0.03;
const MIN_HALF_EXTENT = 6e-3;
const ROLE_TILING = {
  carbon: 42,
  carbonMatte: 42,
  metal: 3.3,
  halo: 4.5,
  dark: 8,
  duct: 8,
  carbonWeave: 62.5
};
function ringSection(n, s, z, out) {
  const pts = out?.pts ?? new Float32Array(n * 3);
  const us = out?.us ?? new Float32Array(n);
  const hwL = s.hwL ?? s.hw;
  const hwR = s.hwR ?? s.hw;
  const hhT = s.hhT ?? s.hh;
  const hhB = s.hhB ?? s.hh;
  const eT = s.eT ?? 3;
  const eB = s.eB ?? 3;
  const undercut = s.undercut ?? 0;
  const shoulder = s.shoulder ?? 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const th = -Math.PI * 0.5 + u * Math.PI * 2;
    const ct = Math.cos(th);
    const st = Math.sin(th);
    const eY = st >= 0 ? eT : eB;
    const eX = st >= 0 ? eT : eB;
    let x = (ct >= 0 ? hwR : hwL) * Math.sign(ct) * Math.pow(Math.abs(ct), 2 / eX);
    let y = (st >= 0 ? hhT : hhB) * Math.sign(st) * Math.pow(Math.abs(st), 2 / eY);
    if (undercut > 0 && st < 0) x *= 1 - undercut * Math.pow(-st, 1.25);
    if (shoulder > 0 && st > 0) y -= shoulder * hhT * Math.pow(Math.abs(ct), 1.6) * st;
    pts[i * 3] = (s.cx ?? 0) + x;
    pts[i * 3 + 1] = (s.cy ?? 0) + y;
    pts[i * 3 + 2] = z;
    us[i] = u;
  }
  return { pts, us, closed: true, n, z };
}
function arcSection(n, s, z, yRim) {
  const hhT = s.hhT ?? s.hh;
  const eT = s.eT ?? 3;
  const eB = s.eB ?? 3;
  const rel = clamp((yRim - (s.cy ?? 0)) / hhT, -0.999, 0.999);
  const phi = Math.asin(clamp01(Math.pow(Math.max(0, rel), eT / 2)));
  const th0 = phi;
  const th1 = -(Math.PI + phi);
  const half = Math.max(2, n >> 1);
  const count = half * 2;
  const thSeam = -Math.PI * 0.5;
  const pts = new Float32Array(count * 3);
  const us = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const before = i < half;
    const t = (before ? i : i - half) / (half - 1);
    const th = before ? t >= 1 ? thSeam : lerp(th0, thSeam, t) : lerp(thSeam, th1, t);
    const ct = Math.cos(th);
    const st = Math.sin(th);
    const e = st >= 0 ? eT : eB;
    const x = (ct >= 0 ? s.hwR ?? s.hw : s.hwL ?? s.hw) * Math.sign(ct) * Math.pow(Math.abs(ct), 2 / e);
    const y = (st >= 0 ? hhT : s.hhB ?? s.hh) * Math.sign(st) * Math.pow(Math.abs(st), 2 / e);
    pts[i * 3] = (s.cx ?? 0) + x;
    pts[i * 3 + 1] = (s.cy ?? 0) + y;
    pts[i * 3 + 2] = z;
    us[i] = (th + Math.PI * 0.5) / (Math.PI * 2) + (before ? 0 : 1);
  }
  return { pts, us, closed: false, n: count, z };
}
const TE_THICKNESS = 34e-4;
function airfoilSection(n, o) {
  const half = n >> 1;
  const pts = new Float32Array(n * 3);
  const us = new Float32Array(n);
  const chord = o.chord;
  const thick = o.thickness;
  const camber = o.camber;
  const p = o.camberPos ?? 0.42;
  const sa = Math.sin(o.aoa);
  const ca = Math.cos(o.aoa);
  const teHalf = (o.teThickness ?? TE_THICKNESS) * 0.5 / chord;
  const camberAt = (t) => t < p ? camber / (p * p) * (2 * p * t - t * t) : camber / ((1 - p) * (1 - p)) * (1 - 2 * p + 2 * p * t - t * t);
  const halfThickness = (t) => {
    const st = Math.sqrt(Math.max(0, t));
    return 5 * thick * (0.2969 * st - 0.126 * t - 0.3516 * t * t + 0.2843 * t * t * t - 0.1015 * t * t * t * t) + teHalf * t;
  };
  const cap = clamp(Math.round(n / 10), 1, 4);
  const tEnd = 1 - teHalf;
  const yEnd = halfThickness(tEnd);
  const cEnd = camberAt(tEnd);
  const upperN = half - cap;
  const lowerCap = cap - 1;
  const lowerN = n - half - cap + 1;
  let k = 0;
  const emit = (t, y) => {
    const zc = (t - 0.25) * chord;
    const yc2 = y * chord;
    pts[k * 3] = o.x;
    pts[k * 3 + 1] = o.y + zc * sa + yc2 * ca;
    pts[k * 3 + 2] = o.z + zc * ca - yc2 * sa;
    us[k] = k / n;
    k++;
  };
  for (let i = 0; i < upperN; i++) {
    const f = upperN > 1 ? i / (upperN - 1) : 0;
    const t = (0.5 - 0.5 * Math.cos(Math.PI * f)) * tEnd;
    emit(t, camberAt(t) + halfThickness(t));
  }
  for (let i = 1; i <= cap; i++) {
    const phi = Math.PI * 0.5 * (1 - i / cap);
    const t = tEnd + teHalf * Math.cos(phi);
    emit(t, cEnd + yEnd * Math.sin(phi));
  }
  for (let i = 1; i <= lowerCap; i++) {
    const phi = -Math.PI * 0.5 * (i / cap);
    const t = tEnd + teHalf * Math.cos(phi);
    emit(t, cEnd + yEnd * Math.sin(phi));
  }
  for (let i = 0; i < lowerN; i++) {
    const f = 1 - i / lowerN;
    const t = (0.5 - 0.5 * Math.cos(Math.PI * f)) * tEnd;
    emit(t, camberAt(t) - halfThickness(t));
  }
  return { pts, us, closed: true, n };
}
function polySection(halfPoly, z) {
  const m = halfPoly.length / 2;
  const n = (m - 1) * 2;
  const pts = new Float32Array(n * 3);
  const us = new Float32Array(n);
  let k = 0;
  for (let i = 0; i < m; i++) {
    pts[k * 3] = halfPoly[i * 2];
    pts[k * 3 + 1] = halfPoly[i * 2 + 1];
    pts[k * 3 + 2] = z;
    k++;
  }
  for (let i = m - 2; i >= 1; i--) {
    pts[k * 3] = -halfPoly[i * 2];
    pts[k * 3 + 1] = halfPoly[i * 2 + 1];
    pts[k * 3 + 2] = z;
    k++;
  }
  let total = 0;
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = pts[j * 3] - pts[i * 3];
    const dy = pts[j * 3 + 1] - pts[i * 3 + 1];
    d[i] = Math.hypot(dx, dy);
    total += d[i];
  }
  let acc = 0;
  for (let i = 0; i < n; i++) {
    us[i] = acc / total;
    acc += d[i];
  }
  return { pts, us, closed: true, n, z };
}
const _uv = [0, 0];
function loft(sections, opts = {}) {
  const secs = sections;
  const count = secs.length;
  const n = secs[0].n;
  const closed = secs[0].closed;
  const ringVerts = closed ? n + 1 : n;
  const uvFn = opts.uv ?? bodyUv;
  const sweep = opts.sweep ?? secs.map((s) => (s.z - BODY_V_FRONT) / (BODY_V_REAR - BODY_V_FRONT));
  const total = ringVerts * count;
  const position = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let p = 0;
  let q = 0;
  for (let j = 0; j < count; j++) {
    const s = secs[j];
    for (let i = 0; i < ringVerts; i++) {
      const src = i % n * 3;
      const x = s.pts[src];
      const y = s.pts[src + 1];
      const z = s.pts[src + 2];
      position[p++] = x;
      position[p++] = y;
      position[p++] = z;
      const ru = i === n ? 1 : s.us[i];
      uvFn(ru, sweep[j], x, y, z, _uv);
      uv[q++] = _uv[0];
      uv[q++] = _uv[1];
    }
  }
  const idx = [];
  for (let j = 0; j < count - 1; j++) {
    for (let i = 0; i < ringVerts - 1; i++) {
      const a = j * ringVerts + i;
      const b = a + 1;
      const c = a + ringVerts;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const rateStart = count > 1 ? sweepRate(secs[0], secs[1], sweep[0], sweep[1]) : 0;
  const rateEnd = count > 1 ? sweepRate(secs[count - 1], secs[count - 2], sweep[count - 1], sweep[count - 2]) : 0;
  const swLimit = Math.abs(sweep[count - 1] - sweep[0]) || 1;
  const caps = [];
  if (opts.capStart) caps.push(capGeometry(secs[0], sweep[0], uvFn, opts.capStart, rateStart, swLimit));
  if (opts.capEnd) {
    caps.push(capGeometry(secs[count - 1], sweep[count - 1], uvFn, opts.capEnd, rateEnd, swLimit));
  }
  if (caps.length === 0) {
    geo.computeVertexNormals();
    return geo;
  }
  const merged = mergeGeometries([geo, ...caps], false);
  geo.dispose();
  for (const c of caps) c.dispose();
  merged.computeVertexNormals();
  return merged;
}
function sectionCentre(sec, out) {
  const n = sec.n;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += sec.pts[i * 3];
    cy += sec.pts[i * 3 + 1];
    cz += sec.pts[i * 3 + 2];
  }
  out[0] = cx / n;
  out[1] = cy / n;
  out[2] = cz / n;
  return out;
}
const _cA = [0, 0, 0];
const _cB = [0, 0, 0];
function sweepRate(near, far, sNear, sFar) {
  sectionCentre(near, _cA);
  sectionCentre(far, _cB);
  const d = Math.hypot(_cA[0] - _cB[0], _cA[1] - _cB[1], _cA[2] - _cB[2]);
  if (d < 1e-6) return 0;
  return (sNear - sFar) / d;
}
function capGeometry(sec, s, uvFn, dir, rate = 0, swLimit = 1) {
  const n = sec.n;
  const rim = sec.closed ? n + 1 : n;
  const verts = rim + 1;
  const position = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  sectionCentre(sec, _cA);
  const cx = _cA[0];
  const cy = _cA[1];
  const cz = _cA[2];
  let radius = 0;
  for (let i = 0; i < n; i++) {
    radius += Math.hypot(sec.pts[i * 3] - cx, sec.pts[i * 3 + 1] - cy, sec.pts[i * 3 + 2] - cz);
  }
  radius /= n;
  const reach = clamp(rate * radius, -swLimit, swLimit);
  position[0] = cx;
  position[1] = cy;
  position[2] = cz;
  uvFn(0.5, s + reach, cx, cy, cz, _uv);
  uv[0] = _uv[0];
  uv[1] = _uv[1];
  for (let i = 0; i < rim; i++) {
    const src = i % n * 3;
    const x = sec.pts[src];
    const y = sec.pts[src + 1];
    const z = sec.pts[src + 2];
    position[(i + 1) * 3] = x;
    position[(i + 1) * 3 + 1] = y;
    position[(i + 1) * 3 + 2] = z;
    uvFn(i === n ? 1 : sec.us[i], s, x, y, z, _uv);
    uv[(i + 1) * 2] = _uv[0];
    uv[(i + 1) * 2 + 1] = _uv[1];
  }
  const idx = [];
  for (let i = 0; i < rim - 1; i++) {
    const a = 1 + i;
    const b = a + 1;
    if (dir > 0) idx.push(0, a, b);
    else idx.push(0, b, a);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}
function triplanarUv(geo, tilesPerMetre) {
  const pos = geo.getAttribute("position");
  const nrm = geo.getAttribute("normal");
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const nx = Math.abs(nrm.getX(i));
    const ny = Math.abs(nrm.getY(i));
    const nz = Math.abs(nrm.getZ(i));
    let u;
    let v;
    if (ny >= nx && ny >= nz) {
      u = x;
      v = z;
    } else if (nx >= nz) {
      u = z;
      v = y;
    } else {
      u = x;
      v = y;
    }
    uv[i * 2] = u * tilesPerMetre;
    uv[i * 2 + 1] = v * tilesPerMetre;
  }
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  return geo;
}
function bodyUv(ringU, sweepS, x, y, z, out) {
  out[0] = sweepS;
  out[1] = ringU;
  return out;
}
function ringOffset(u, anchor) {
  let d = u - anchor;
  while (d > 0.5) d -= 1;
  while (d < -0.5) d += 1;
  return d;
}
function centreUv(ringU, sweepS, x, y, z, out) {
  out[0] = sweepS;
  out[1] = 0.5 + ringOffset(ringU, 0.5) * 0.76;
  return out;
}
const POD_V_SPAN = 0.46;
function podUv(side) {
  const anchor = side > 0 ? 0.25 : 0.75;
  const spill = (1 - POD_V_SPAN) * 0.5;
  return (ringU, sweepS, x, y, z, out) => {
    let d = ringU - anchor;
    let turns = 0;
    while (d > 0.5) {
      d -= 1;
      turns += 1;
    }
    while (d < -0.5) {
      d += 1;
      turns -= 1;
    }
    const a = d < 0 ? -d : d;
    const ease = d < 0 ? -smoothstep(0.25, 0.5, a) : smoothstep(0.25, 0.5, a);
    out[0] = sweepS;
    out[1] = anchor + turns + d * POD_V_SPAN + ease * spill;
    return out;
  };
}
function makeWingUv(span0, span1) {
  const inv = 1 / Math.max(1e-6, span1 - span0);
  return (ringU, sweepS, x, y, z, out) => {
    out[0] = clamp01((x - span0) * inv);
    out[1] = ringU;
    return out;
  };
}
function bandUv(span0, span1, v0, v1) {
  const inv = 1 / Math.max(1e-6, span1 - span0);
  const dv = v1 - v0;
  return (ringU, sweepS, x, y, z, out) => {
    out[0] = clamp01((x - span0) * inv);
    out[1] = v0 + ringU * dv;
    return out;
  };
}
function constUv(u, vScale = 1, vOffset = 0) {
  return (ringU, sweepS, x, y, z, out) => {
    out[0] = u;
    out[1] = vOffset + ringU * vScale;
    return out;
  };
}
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _euler = new THREE.Euler();
function placed(geo, x, y, z, rx = 0, ry = 0, rz = 0) {
  _q.setFromEuler(_euler.set(rx, ry, rz));
  _m4.compose(_v3.set(x, y, z), _q, _v3b.set(1, 1, 1));
  geo.applyMatrix4(_m4);
  return geo;
}
function slab(w, h, d, bevel = 6e-3) {
  const b = Math.min(bevel, w * 0.4, h * 0.4, d * 0.4);
  const g = new THREE.BoxGeometry(w - b * 2, h, d, 1, 1, 1);
  const g2 = new THREE.BoxGeometry(w, h - b * 2, d - b * 2, 1, 1, 1);
  const merged = mergeGeometries([g, g2], false);
  g.dispose();
  g2.dispose();
  merged.computeVertexNormals();
  return merged;
}
function stripUv(geo, u, v) {
  const a = geo.getAttribute("uv");
  for (let i = 0; i < a.count; i++) a.setXY(i, u, v);
  a.needsUpdate = true;
  return geo;
}
function plate(outline, x, thickness, uvFn) {
  const n = outline.length / 2;
  const at = (i) => n - 1 - i;
  const mk = (xx) => {
    const pts = new Float32Array(n * 3);
    const us = new Float32Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const k = at(i);
      pts[i * 3] = xx;
      pts[i * 3 + 1] = outline[k * 2 + 1];
      pts[i * 3 + 2] = outline[k * 2];
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      total += Math.hypot(pts[j * 3 + 2] - pts[i * 3 + 2], pts[j * 3 + 1] - pts[i * 3 + 1]);
    }
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      us[i] = acc / total;
      acc += Math.hypot(pts[j * 3 + 2] - pts[i * 3 + 2], pts[j * 3 + 1] - pts[i * 3 + 1]);
    }
    return { pts, us, closed: true, n, z: 0 };
  };
  const inner = mk(x - thickness * 0.5);
  const outer = mk(x + thickness * 0.5);
  return loft([inner, outer], { uv: uvFn, sweep: [0, 1], capStart: -1, capEnd: 1 });
}
const _linkDir = new THREE.Vector3();
const _linkMid = new THREE.Vector3();
const _axisX = new THREE.Vector3(1, 0, 0);
const _unitScale = new THREE.Vector3(1, 1, 1);
function staticLink(a, b, chord) {
  _linkDir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = _linkDir.length();
  if (len < 1e-4) return null;
  _linkDir.multiplyScalar(1 / len);
  const geo = new THREE.BoxGeometry(len, 0.017 * chord, 0.05 * chord, 1, 1, 1);
  _linkMid.set((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5 + CG_HEIGHT, (a[2] + b[2]) * 0.5);
  _q.setFromUnitVectors(_axisX, _linkDir);
  _m4.compose(_linkMid, _q, _unitScale);
  geo.applyMatrix4(_m4);
  return stripUv(geo, 0.5, 0.5);
}
const NOSE_STATIONS = [
  { z: -2.42, hw: 0.02, hhT: 0.018, hhB: 0.016, cy: 0.288, eT: 2.2, eB: 2.2 },
  { z: -2.36, hw: 0.058, hhT: 0.05, hhB: 0.044, cy: 0.288, eT: 2.5, eB: 2.4 },
  { z: -2.2, hw: 0.082, hhT: 0.066, hhB: 0.058, cy: 0.296, eT: 2.7, eB: 2.6 },
  { z: -2, hw: 0.104, hhT: 0.082, hhB: 0.072, cy: 0.31, eT: 2.9, eB: 2.7 },
  { z: -1.78, hw: 0.128, hhT: 0.1, hhB: 0.088, cy: 0.33, eT: 3.1, eB: 2.8 },
  { z: -1.55, hw: 0.158, hhT: 0.124, hhB: 0.108, cy: 0.352, eT: 3.3, eB: 3 },
  { z: -1.32, hw: 0.196, hhT: 0.146, hhB: 0.132, cy: 0.372, eT: 3.5, eB: 3.2 },
  { z: -1.05, hw: 0.24, hhT: 0.175, hhB: 0.16, cy: 0.39, eT: 3.8, eB: 3.4 }
];
const TUB_STATIONS = [
  { z: -1.05, hw: 0.24, hhT: 0.175, hhB: 0.16, cy: 0.39, eT: 3.8, eB: 3.4, rim: null },
  { z: -0.9, hw: 0.268, hhT: 0.216, hhB: 0.172, cy: 0.4, eT: 3.8, eB: 3.4, rim: 0.583 },
  { z: -0.72, hw: 0.292, hhT: 0.245, hhB: 0.18, cy: 0.402, eT: 3.9, eB: 3.4, rim: 0.575 },
  { z: -0.52, hw: 0.305, hhT: 0.25, hhB: 0.185, cy: 0.4, eT: 4, eB: 3.4, rim: 0.556 },
  { z: -0.32, hw: 0.31, hhT: 0.252, hhB: 0.19, cy: 0.398, eT: 4, eB: 3.4, rim: 0.556 },
  { z: -0.12, hw: 0.308, hhT: 0.255, hhB: 0.195, cy: 0.398, eT: 4, eB: 3.4, rim: 0.578 },
  { z: 0.04, hw: 0.298, hhT: 0.258, hhB: 0.198, cy: 0.396, eT: 3.9, eB: 3.3, rim: 0.62 },
  { z: 0.16, hw: 0.286, hhT: 0.252, hhB: 0.198, cy: 0.394, eT: 3.8, eB: 3.3, rim: null }
];
const REAR_BODY_STATIONS = [
  { z: 0.16, hw: 0.286, hhT: 0.252, hhB: 0.198, cy: 0.394, eT: 3.8, eB: 3.3 },
  { z: 0.45, hw: 0.262, hhT: 0.238, hhB: 0.196, cy: 0.386, eT: 3.6, eB: 3.2 },
  { z: 0.8, hw: 0.222, hhT: 0.212, hhB: 0.186, cy: 0.372, eT: 3.4, eB: 3 },
  { z: 1.15, hw: 0.18, hhT: 0.18, hhB: 0.17, cy: 0.356, eT: 3.2, eB: 2.9 },
  { z: 1.5, hw: 0.142, hhT: 0.146, hhB: 0.15, cy: 0.34, eT: 3, eB: 2.8 },
  { z: 1.85, hw: 0.108, hhT: 0.114, hhB: 0.126, cy: 0.326, eT: 2.9, eB: 2.7 },
  { z: 2.15, hw: 0.082, hhT: 0.086, hhB: 0.098, cy: 0.316, eT: 2.8, eB: 2.6 },
  { z: 2.45, hw: 0.062, hhT: 0.062, hhB: 0.07, cy: 0.308, eT: 2.7, eB: 2.5 },
  { z: 2.62, hw: 0.046, hhT: 0.044, hhB: 0.05, cy: 0.302, eT: 2.6, eB: 2.4 }
];
const AIRBOX_STATIONS = [
  { z: -0.04, hw: 0.098, hhT: 0.075, hhB: 0.115, cy: 0.815, eT: 2.4, eB: 2.8 },
  { z: 0.06, hw: 0.118, hhT: 0.09, hhB: 0.15, cy: 0.8, eT: 2.6, eB: 3 },
  { z: 0.2, hw: 0.145, hhT: 0.105, hhB: 0.23, cy: 0.76, eT: 2.8, eB: 3.2 },
  { z: 0.4, hw: 0.175, hhT: 0.115, hhB: 0.31, cy: 0.7, eT: 3, eB: 3.4 },
  { z: 0.62, hw: 0.2, hhT: 0.11, hhB: 0.36, cy: 0.64, eT: 3.2, eB: 3.4 },
  { z: 0.9, hw: 0.19, hhT: 0.085, hhB: 0.36, cy: 0.59, eT: 3.2, eB: 3.2 }
];
const SIDEPOD_STATIONS = [
  { z: -0.82, cx: 0.545, hw: 0.185, hhT: 0.118, hhB: 0.112, cy: 0.398, eT: 3.6, eB: 3.4, undercut: 0.1, shoulder: 0.05 },
  { z: -0.55, cx: 0.558, hw: 0.202, hhT: 0.138, hhB: 0.126, cy: 0.402, eT: 3.8, eB: 3.4, undercut: 0.24, shoulder: 0.18 },
  { z: -0.1, cx: 0.548, hw: 0.206, hhT: 0.142, hhB: 0.142, cy: 0.396, eT: 3.8, eB: 3.2, undercut: 0.4, shoulder: 0.34 },
  { z: 0.45, cx: 0.5, hw: 0.19, hhT: 0.136, hhB: 0.156, cy: 0.376, eT: 3.6, eB: 3, undercut: 0.56, shoulder: 0.48 },
  { z: 1, cx: 0.4, hw: 0.156, hhT: 0.116, hhB: 0.152, cy: 0.346, eT: 3.4, eB: 2.9, undercut: 0.66, shoulder: 0.58 },
  { z: 1.45, cx: 0.3, hw: 0.116, hhT: 0.092, hhB: 0.126, cy: 0.316, eT: 3.2, eB: 2.8, undercut: 0.64, shoulder: 0.6 },
  { z: 1.8, cx: 0.222, hw: 0.078, hhT: 0.062, hhB: 0.088, cy: 0.292, eT: 3, eB: 2.7, undercut: 0.56, shoulder: 0.55 },
  { z: 2, cx: 0.172, hw: 0.048, hhT: 0.038, hhB: 0.054, cy: 0.278, eT: 2.8, eB: 2.6, undercut: 0.45, shoulder: 0.45 }
];
const FLOOR_STATIONS = [
  { z: -1.3, hw: 0.36, keel: 0.04, archX: 0.2, archY: 0.055, edgeY: 0.042, topY: 0.078 },
  { z: -0.9, hw: 0.52, keel: 0.04, archX: 0.26, archY: 0.075, edgeY: 0.04, topY: 0.092 },
  { z: -0.4, hw: 0.68, keel: 0.04, archX: 0.32, archY: 0.105, edgeY: 0.038, topY: 0.118 },
  { z: 0.2, hw: 0.745, keel: 0.04, archX: 0.36, archY: 0.135, edgeY: 0.036, topY: 0.152 },
  { z: 0.9, hw: 0.75, keel: 0.042, archX: 0.38, archY: 0.165, edgeY: 0.038, topY: 0.192 },
  { z: 1.55, hw: 0.72, keel: 0.045, archX: 0.4, archY: 0.2, edgeY: 0.045, topY: 0.236 },
  { z: 2.02, hw: 0.665, keel: 0.05, archX: 0.41, archY: 0.245, edgeY: 0.058, topY: 0.282 },
  { z: 2.35, hw: 0.61, keel: 0.062, archX: 0.42, archY: 0.302, edgeY: 0.082, topY: 0.334 },
  { z: 2.6, hw: 0.56, keel: 0.078, archX: 0.42, archY: 0.348, edgeY: 0.108, topY: 0.378 }
];
const FRONT_WING_ELEMENTS = [
  { zLE: -2.612, chord0: 0.255, chord1: 0.318, y0: 0.07, y1: 0.094, aoa0: 0.1, aoa1: 0.17, thickness: 0.085, camber: -0.055, neutralCentre: true, tipSweep: 0.066 },
  { zLE: -2.47, chord0: 0.15, chord1: 0.196, y0: 0.124, y1: 0.166, aoa0: 0.26, aoa1: 0.36, thickness: 0.075, camber: -0.075, tipSweep: 0.086 },
  { zLE: -2.358, chord0: 0.13, chord1: 0.172, y0: 0.186, y1: 0.244, aoa0: 0.4, aoa1: 0.52, thickness: 0.07, camber: -0.085, tipSweep: 0.174 },
  { zLE: -2.256, chord0: 0.112, chord1: 0.15, y0: 0.252, y1: 0.328, aoa0: 0.54, aoa1: 0.68, thickness: 0.065, camber: -0.09, tipSweep: 0.254 }
];
const FRONT_WING_HALF_SPAN = 0.95;
const REAR_WING_HALF_SPAN = 0.55;
const FRONT_TYRE_INNER_X = 0.848;
const TIP_SWEEP_END = FRONT_TYRE_INNER_X / FRONT_WING_HALF_SPAN - 0.03;
const FW_ENDPLATE = [
  -2.64,
  0.03,
  -2.52,
  0.018,
  -2.42,
  0.026,
  -2.358,
  0.072,
  -2.352,
  0.316,
  -2.404,
  0.366,
  -2.52,
  0.36,
  -2.634,
  0.308,
  -2.672,
  0.16
];
const RW_ENDPLATE = [
  2.44,
  0.402,
  2.985,
  0.432,
  3.005,
  0.826,
  2.902,
  0.9,
  2.58,
  0.906,
  2.442,
  0.86,
  2.398,
  0.56
];
function sectionsFrom(table, n, mirror = 1) {
  const out = [];
  for (const s of table) out.push(ringSection(n, s, s.z));
  if (mirror < 0) {
    for (const sec of out) {
      const n2 = sec.n;
      for (let i = 0; i < n2; i++) sec.pts[i * 3] = -sec.pts[i * 3];
      reverseRing(sec);
    }
  }
  return out;
}
function reverseRing(sec) {
  const n = sec.n;
  const p = sec.pts.slice();
  const u = sec.us.slice();
  for (let i = 0; i < n; i++) {
    const j = (n - i) % n;
    sec.pts[i * 3] = p[j * 3];
    sec.pts[i * 3 + 1] = p[j * 3 + 1];
    sec.pts[i * 3 + 2] = p[j * 3 + 2];
    const ru = 1 - u[j];
    sec.us[i] = ru >= 1 ? 0 : ru;
  }
}
function tubSections(n) {
  const out = [];
  for (const s of TUB_STATIONS) {
    const rim = s.rim === null ? s.cy + s.hhT : s.rim;
    out.push(arcSection(n, s, s.z, rim));
  }
  return out;
}
function floorSections() {
  const out = [];
  for (const s of FLOOR_STATIONS) {
    const half = [
      0,
      s.keel,
      s.archX * 0.42,
      s.keel + (s.archY - s.keel) * 0.52,
      s.archX,
      s.archY,
      s.archX + (s.hw - s.archX) * 0.52,
      s.keel + (s.archY - s.keel) * 0.3,
      s.hw * 0.965,
      s.edgeY,
      s.hw,
      s.edgeY + 0.02,
      s.hw * 0.955,
      s.topY,
      s.hw * 0.48,
      s.topY + 6e-3,
      0,
      s.topY
    ];
    out.push(polySection(half, s.z));
  }
  return out;
}
function wingElement(el, halfSpan, stations, profileN, uvFn) {
  const secs = [];
  const tipSweep = el.tipSweep ?? 0;
  for (let i = 0; i < stations; i++) {
    const x = lerp(-halfSpan, halfSpan, i / (stations - 1));
    const s = clamp01(Math.abs(x) / halfSpan);
    const chord = lerp(el.chord0, el.chord1, Math.pow(s, 1.3));
    const y = lerp(el.y0, el.y1, Math.pow(s, 1.6));
    const aoa = lerp(el.aoa0, el.aoa1, s);
    const camberScale = el.neutralCentre ? smoothstep(0.12, 0.34, Math.abs(x)) : 1;
    const sweep = tipSweep * smoothstep(0.42, TIP_SWEEP_END, s);
    const sec = airfoilSection(profileN, {
      x,
      y,
      z: el.zLE + chord * 0.25 - sweep,
      chord,
      thickness: el.thickness,
      camber: el.camber * camberScale,
      aoa: aoa * lerp(0.35, 1, camberScale)
    });
    secs.push(sec);
  }
  return loft(secs, { uv: uvFn, sweep: secs.map((_, i) => i / (stations - 1)), capStart: -1, capEnd: 1 });
}
function tube(points, radius, radial, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])), closed, "centripetal", 0.5);
  return new THREE.TubeGeometry(curve, Math.max(12, points.length * 6), radius, radial, closed);
}
function haloGeometry(radial) {
  const pylon = tube([
    [0, 0.548, -0.93],
    [0, 0.648, -0.912],
    [0, 0.766, -0.892],
    [0, 0.862, -0.876],
    [0, 0.902, -0.868]
  ], 0.0265, radial);
  const arms = [];
  for (const s of [1, -1]) {
    arms.push(tube([
      [0, 0.902, -0.868],
      [s * 0.12, 0.918, -0.8],
      [s * 0.258, 0.928, -0.61],
      [s * 0.34, 0.921, -0.36],
      [s * 0.366, 0.868, -0.09],
      [s * 0.352, 0.748, 0.03],
      [s * 0.322, 0.636, 0.062]
    ], 0.025, radial));
  }
  const fairing = placed(slab(0.052, 0.15, 0.075, 0.012), 0, 0.822, -0.884);
  const merged = mergeGeometries([pylon, ...arms, stripUv(fairing, 0.5, 0.5)], false);
  pylon.dispose();
  for (const a of arms) a.dispose();
  fairing.dispose();
  merged.computeVertexNormals();
  return merged;
}
export function cockpitRimPoints(side) {
  const pts = [];
  for (const s of TUB_STATIONS) {
    const rim = s.rim === null ? s.cy + s.hhT : s.rim;
    const rel = clamp((rim - s.cy) / s.hhT, -0.999, 0.999);
    const phi = Math.asin(clamp01(Math.pow(Math.max(0, rel), s.eT / 2)));
    const x = side * s.hw * Math.pow(Math.abs(Math.cos(phi)), 2 / s.eT);
    pts.push([x, rim, s.z]);
  }
  return pts;
}
function stationAt(table, z) {
  let i = 0;
  while (i < table.length - 2 && table[i + 1].z < z) i++;
  const a = table[i];
  const b = table[i + 1];
  const span = b.z - a.z;
  const t = clamp01(span > 1e-9 ? (z - a.z) / span : 0);
  const mix = (key, dflt = 0) => lerp(a[key] ?? dflt, b[key] ?? dflt, t);
  return {
    cx: mix("cx"),
    cy: mix("cy"),
    z,
    hw: mix("hw"),
    hhT: mix("hhT", a.hh ?? 0),
    hhB: mix("hhB", a.hh ?? 0),
    eT: mix("eT", 3),
    eB: mix("eB", 3),
    undercut: mix("undercut"),
    shoulder: mix("shoulder")
  };
}
function insetStation(s, wall, f) {
  const hhT = Math.max(MIN_HALF_EXTENT, s.hhT - wall) * f;
  return {
    cx: s.cx,
    cy: s.cy,
    z: s.z,
    hw: Math.max(MIN_HALF_EXTENT, s.hw - wall) * f,
    hhT,
    hhB: Math.max(MIN_HALF_EXTENT, s.hhB - wall) * f,
    eT: s.eT,
    eB: s.eB,
    undercut: s.undercut,
    shoulder: s.shoulder > 0 ? s.shoulder * (s.hhT / hhT) : 0
  };
}
function surfaceYAt(table, x, z) {
  const s = stationAt(table, z);
  const dx = Math.abs(x - s.cx);
  if (s.hw <= 1e-6 || dx >= s.hw) return null;
  const ct = Math.pow(dx / s.hw, s.eT * 0.5);
  const st = Math.sqrt(Math.max(0, 1 - ct * ct));
  return s.cy + s.hhT * Math.pow(st, 2 / s.eT) - s.shoulder * s.hhT * Math.pow(ct, 1.6) * st;
}
function seatOnBody(table, x, z, halfX, halfZ, standoff) {
  const at = (px, pz) => surfaceYAt(table, px, pz) ?? surfaceYAt(table, 0, pz) ?? 0;
  const front = 0.5 * (at(x - halfX, z - halfZ) + at(x + halfX, z - halfZ));
  const back = 0.5 * (at(x - halfX, z + halfZ) + at(x + halfX, z + halfZ));
  const inner = 0.5 * (at(x - halfX, z - halfZ) + at(x - halfX, z + halfZ));
  const outer = 0.5 * (at(x + halfX, z - halfZ) + at(x + halfX, z + halfZ));
  const rx = -Math.atan2(back - front, 2 * halfZ);
  const rz = Math.atan2(outer - inner, 2 * halfX);
  const plane = 0.5 * (front + back);
  const tx = Math.tan(rx);
  const tz = Math.tan(rz);
  let lift = 0;
  const GRID = 6;
  for (let i = 0; i <= GRID; i++) {
    const cxo = (i / GRID * 2 - 1) * halfX;
    for (let j = 0; j <= GRID; j++) {
      const czo = (j / GRID * 2 - 1) * halfZ;
      const modelled = plane - czo * tx + cxo * tz;
      lift = Math.max(lift, at(x + cxo, z + czo) - modelled);
    }
  }
  return { y: plane + lift + standoff, rx, rz };
}
const LOD_PARAMS = [
  { ring: 14, span: 9, prof: 12, radial: 6, mid: false, fine: false },
  { ring: 20, span: 11, prof: 14, radial: 6, mid: true, fine: false },
  { ring: 40, span: 21, prof: 30, radial: 12, mid: true, fine: true }
];
const _shared = new Map();
export function buildCarGeometry(detail) {
  const cached = _shared.get(detail);
  if (cached) return cached;
  const P = LOD_PARAMS[clamp(detail | 0, 0, 2)];
  const bucket = new Map();
  const add = (role, geo) => {
    if (!geo) return;
    let list = bucket.get(role);
    if (!list) bucket.set(role, list = []);
    list.push(geo);
  };
  const wingUvFull = bandUv(-FRONT_WING_HALF_SPAN, FRONT_WING_HALF_SPAN, 0.245, 0.355);
  const rearUv = makeWingUv(-REAR_WING_HALF_SPAN, REAR_WING_HALF_SPAN);
  add("body", loft(sectionsFrom(NOSE_STATIONS, P.ring), { capStart: -1, uv: centreUv }));
  add("body", loft(tubSections(P.ring), { capStart: 1, capEnd: -1, uv: centreUv }));
  add("body", loft(sectionsFrom(REAR_BODY_STATIONS, P.ring), { capEnd: 1, uv: centreUv }));
  add("body", loft(sectionsFrom(AIRBOX_STATIONS, P.ring), { capEnd: 1, uv: centreUv }));
  const mouth = AIRBOX_STATIONS[0];
  add("duct", loft([
    ringSection(P.ring, mouth, mouth.z),
    ringSection(P.ring, insetStation(stationAt(AIRBOX_STATIONS, 0.1), DUCT_WALL, 0.8), 0.1),
    ringSection(P.ring, insetStation(stationAt(AIRBOX_STATIONS, 0.28), DUCT_WALL, 0.5), 0.28)
  ], { sweep: [0.5, 0.52, 0.55], capEnd: 1 }));
  for (const side of [1, -1]) {
    add("body", loft(sectionsFrom(SIDEPOD_STATIONS, P.ring, side), { capEnd: 1, uv: podUv(side) }));
    const inlet = SIDEPOD_STATIONS[0];
    const throatSecs = [
      ringSection(P.ring, inlet, inlet.z),
      ringSection(P.ring, insetStation(stationAt(SIDEPOD_STATIONS, -0.7), DUCT_WALL, 0.78), -0.7),
      ringSection(P.ring, insetStation(stationAt(SIDEPOD_STATIONS, -0.56), DUCT_WALL, 0.46), -0.56)
    ];
    if (side < 0) {
      for (const sec of throatSecs) {
        for (let i = 0; i < sec.n; i++) sec.pts[i * 3] = -sec.pts[i * 3];
        reverseRing(sec);
      }
    }
    add("duct", loft(throatSecs, { sweep: [0.24, 0.26, 0.28], capEnd: 1 }));
  }
  add("carbonMatte", loft(floorSections(), { capStart: -1, capEnd: 1 }));
  FRONT_WING_ELEMENTS.forEach((el, i) => {
    add("wing", wingElement(el, FRONT_WING_HALF_SPAN - i * 15e-4, P.span, P.prof, wingUvFull));
  });
  for (const side of [1, -1]) {
    add("wing", plate(FW_ENDPLATE, side * FRONT_WING_HALF_SPAN, 0.016, constUv(side > 0 ? 0.02 : 0.98, 0.11, 0.245)));
    add("carbon", stripUv(placed(slab(0.1, 0.013, 0.25), side * 0.902, 0.04, -2.36, 0, 0, side * 0.2), 0.5, 0.5));
    add("carbon", plate([-2.442, 0.112, -2.3, 0.112, -2.268, 0.256, -2.418, 0.248], side * 0.1, 0.02, constUv(0.5)));
  }
  add("wing", wingElement({
    zLE: 2.52,
    chord0: 0.272,
    chord1: 0.248,
    y0: 0.64,
    y1: 0.652,
    aoa0: 0.3,
    aoa1: 0.26,
    thickness: 0.09,
    camber: -0.09
  }, REAR_WING_HALF_SPAN, P.span, P.prof, rearUv));
  for (const side of [1, -1]) {
    add("wing", plate(RW_ENDPLATE, side * REAR_WING_HALF_SPAN, 0.014, constUv(side > 0 ? 0.02 : 0.98)));
    add("carbon", plate([2.12, 0.352, 2.3, 0.352, 2.62, 0.664, 2.52, 0.672], side * 0.155, 0.024, constUv(0.5)));
  }
  const beamUv = bandUv(-0.42, 0.42, 0.245, 0.355);
  add("wing", wingElement({
    zLE: 2.56,
    chord0: 0.165,
    chord1: 0.15,
    y0: 0.3,
    y1: 0.312,
    aoa0: 0.34,
    aoa1: 0.3,
    thickness: 0.08,
    camber: -0.08
  }, 0.42, Math.max(5, P.span - 4), P.prof, beamUv));
  if (P.mid) {
    add("wing", wingElement({
      zLE: 2.7,
      chord0: 0.13,
      chord1: 0.12,
      y0: 0.256,
      y1: 0.264,
      aoa0: 0.44,
      aoa1: 0.4,
      thickness: 0.075,
      camber: -0.085
    }, 0.4, Math.max(5, P.span - 4), P.prof, beamUv));
  }
  add("halo", haloGeometry(P.radial));
  if (P.mid) {
    for (const side of [1, -1]) {
      add("carbonWeave", tube([
        [side * 0.318, 0.588, -0.556],
        [side * 0.4, 0.604, -0.642],
        [side * 0.452, 0.634, -0.704]
      ], 0.014, P.radial));
      add("dark", stripUv(placed(slab(0.048, 0.072, 0.128, 0.014), side * 0.46, 0.645, -0.72, 0, -side * 0.4538, 0), 0.5, 0.5));
      const glass = new THREE.PlaneGeometry(0.112, 0.052);
      add("dark", placed(glass, side * 0.428, 0.645, -0.655, 0, -side * 0.4538, 0));
    }
    for (const side of [1, -1]) {
      add("carbonWeave", tube(cockpitRimPoints(side).map((p) => [p[0], p[1], p[2]]), 0.016, Math.max(5, P.radial - 2)));
    }
    add("metal", placed(new THREE.CylinderGeometry(0.052, 0.058, 0.17, 14, 1, false), 0, 0.352, 2.585, Math.PI * 0.5, 0, 0));
    const louvre = seatOnBody(REAR_BODY_STATIONS, 0.1, 0.94, 0.045, 0.115, LOUVRE_STANDOFF);
    for (const side of [1, -1]) {
      add("dark", stripUv(placed(
        slab(0.09, 8e-3, 0.23),
        side * 0.1,
        louvre.y + 0.115 * Math.tan(LOUVRE_RAKE),
        0.94,
        louvre.rx - LOUVRE_RAKE,
        0,
        side * louvre.rz
      ), 0.62, 0.5));
    }
  }
  if (P.fine) {
    for (const side of [1, -1]) {
      for (const sx of [0.105, 0.23, 0.35]) {
        add("carbon", plate([2.06, 0.046, 2.6, 0.086, 2.6, 0.3, 2.06, 0.122], side * sx, 0.012, constUv(0.5)));
      }
      for (let k = 0; k < 3; k++) {
        const t = k / 2;
        add("carbon", stripUv(placed(
          slab(0.014, lerp(0.13, 0.235, t), lerp(0.4, 0.3, t)),
          side * lerp(0.43, 0.655, t),
          lerp(0.11, 0.15, t),
          lerp(-1.06, -0.9, t),
          0,
          side * lerp(0.1, 0.3, t),
          side * lerp(0.05, 0.16, t)
        ), 0.5, 0.5));
      }
      add("carbon", stripUv(placed(slab(0.2, 0.012, 0.095), side * 0.6, 0.512, -0.38, -0.14, 0, side * 0.1), 0.5, 0.5));
      add("carbon", stripUv(placed(slab(0.11, 0.01, 0.13), side * 1.014, 0.3, -2.386, -0.26, 0, 0), 0.5, 0.5));
    }
  }
  if (!P.mid) {
    for (const link of suspensionLinks()) {
      add("carbon", staticLink(link.inboard, link.outboard, link.chord));
    }
  }
  const parts = {};
  const roleMap = detail >= 2 ? null : { carbonWeave: "carbon", carbonMatte: "carbon", dark: "carbon", duct: "carbon", metal: "carbon", halo: "carbon" };
  const grouped = new Map();
  for (const [role, list] of bucket) {
    const target = roleMap?.[role] ?? role;
    let arr = grouped.get(target);
    if (!arr) grouped.set(target, arr = []);
    for (const g of list) arr.push(g);
  }
  for (const [role, list] of grouped) {
    const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (list.length > 1) for (const g of list) g.dispose();
    merged.translate(0, -CG_HEIGHT, 0);
    if (role !== "body" && role !== "wing") triplanarUv(merged, ROLE_TILING[role] ?? 8);
    merged.computeBoundingSphere();
    parts[role] = merged;
  }
  const flapUv = makeWingUv(-0.53, 0.53);
  const flap = detail === 0 ? null : wingElement({
    zLE: 2.686,
    chord0: 0.188,
    chord1: 0.174,
    y0: 0.782,
    y1: 0.79,
    aoa0: 0.62,
    aoa1: 0.58,
    thickness: 0.055,
    camber: -0.045
  }, 0.53, P.span, P.prof, flapUv);
  if (flap) {
    flap.translate(-DRS_PIVOT[0], -DRS_PIVOT[1] - CG_HEIGHT, -DRS_PIVOT[2]);
    flap.computeBoundingSphere();
  }
  const result = { parts, flap, detail };
  _shared.set(detail, result);
  return result;
}
export function cockpitInteriorGeometry(ring = 28) {
  const secs = [];
  for (const s of TUB_STATIONS) {
    const rim = s.rim === null ? s.cy + s.hhT : s.rim;
    const inner = {
      cx: s.cx,
      cy: s.cy + 6e-3,
      hw: s.hw - 0.026,
      hhT: s.hhT - 0.02,
      hhB: s.hhB - 0.02,
      eT: s.eT,
      eB: s.eB
    };
    secs.push(arcSection(ring, inner, s.z, rim - 0.012));
  }
  const walls = loft(secs, { capStart: 1, capEnd: -1 });
  flipWinding(walls);
  const pan = [];
  for (const z of [-0.1, 0.1, 0.3]) {
    pan.push(ringSection(ring, {
      cy: 0.3,
      hw: 0.23,
      hhT: 0.04,
      hhB: 0.03,
      eT: 4,
      eB: 3
    }, z));
  }
  const seat = loft(pan, { capStart: -1, capEnd: 1 });
  const merged = mergeGeometries([walls, seat], false);
  walls.dispose();
  seat.dispose();
  merged.translate(0, -CG_HEIGHT, 0);
  triplanarUv(merged, 62);
  merged.computeBoundingSphere();
  return merged;
}
function flipWinding(geo) {
  const idx = geo.getIndex();
  const arr = idx.array;
  for (let i = 0; i < arr.length; i += 3) {
    const t = arr[i + 1];
    arr[i + 1] = arr[i + 2];
    arr[i + 2] = t;
  }
  idx.needsUpdate = true;
  const n = geo.getAttribute("normal");
  for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
  n.needsUpdate = true;
  return geo;
}
export function disposeSharedGeometry() {
  for (const entry of _shared.values()) {
    for (const key of Object.keys(entry.parts)) entry.parts[key].dispose();
    entry.flap?.dispose();
  }
  _shared.clear();
}
const SUSPENSION_RIGHT = [
  { wheel: 1, inboard: [0.165, 0.455, -1.62], outboard: [0.855, 0.478, -1.944], chord: 1 },
  { wheel: 1, inboard: [0.155, 0.45, -1.86], outboard: [0.855, 0.478, -1.944], chord: 1 },
  { wheel: 1, inboard: [0.175, 0.205, -1.64], outboard: [0.88, 0.185, -1.944], chord: 1.15 },
  { wheel: 1, inboard: [0.17, 0.2, -1.88], outboard: [0.88, 0.185, -1.944], chord: 1.15 },
  { wheel: 1, inboard: [0.19, 0.51, -1.646], outboard: [0.868, 0.198, -1.93], chord: 0.85 },
  { wheel: 1, inboard: [0.15, 0.252, -1.762], outboard: [0.865, 0.246, -2.032], chord: 0.7, steers: true },
  { wheel: 3, inboard: [0.17, 0.47, 1.42], outboard: [0.835, 0.485, 1.656], chord: 1 },
  { wheel: 3, inboard: [0.165, 0.465, 1.78], outboard: [0.835, 0.485, 1.656], chord: 1 },
  { wheel: 3, inboard: [0.18, 0.19, 1.4], outboard: [0.855, 0.18, 1.656], chord: 1.15 },
  { wheel: 3, inboard: [0.175, 0.188, 1.8], outboard: [0.855, 0.18, 1.656], chord: 1.15 },
  { wheel: 3, inboard: [0.185, 0.232, 1.388], outboard: [0.84, 0.48, 1.66], chord: 0.85 },
  { wheel: 3, inboard: [0.15, 0.23, 1.842], outboard: [0.845, 0.226, 1.792], chord: 0.7 },
  { wheel: 3, inboard: [0.168, 0.33, 1.656], outboard: [0.872, 0.3625, 1.656], chord: 0.55, round: true }
];
export function suspensionLinks() {
  const out = [];
  for (const side of [1, -1]) {
    for (const l of SUSPENSION_RIGHT) {
      out.push({
        wheel: side > 0 ? l.wheel : l.wheel - 1,
        chord: l.chord,
        round: !!l.round,
        steers: !!l.steers,
        inboard: [side * l.inboard[0], GY(l.inboard[1]), l.inboard[2]],
        outboard: [side * l.outboard[0], GY(l.outboard[1]), l.outboard[2]],
        hub: [side * (l.wheel === 1 ? 1 : 0.98), GY(l.wheel === 1 ? 0.36 : 0.3625), l.outboard[2]]
      });
    }
  }
  return out;
}
const _strutCache = new Map();
export function strutGeometry(detail) {
  const cached = _strutCache.get(detail);
  if (cached) return cached;
  const n = detail >= 2 ? 14 : 8;
  const mk = (x) => {
    const pts = new Float32Array(n * 3);
    const us = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const th = t * Math.PI * 2;
      const c = Math.cos(th);
      const sN = Math.sin(th);
      pts[i * 3] = x;
      pts[i * 3 + 1] = 8e-3 * sN;
      pts[i * 3 + 2] = 0.026 * Math.sign(c) * Math.pow(Math.abs(c), 0.8) - 4e-3 * sN * sN;
      us[i] = t;
    }
    return { pts, us, closed: true, n, z: 0 };
  };
  const geo = loft([mk(0), mk(1)], { sweep: [0, 1], capStart: -1, capEnd: 1, uv: constUv(0.5) });
  triplanarUv(geo, 42);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 3.2);
  _strutCache.set(detail, geo);
  return geo;
}
export function disposeStrutGeometry() {
  for (const g of _strutCache.values()) g.dispose();
  _strutCache.clear();
}
const ROLE_TO_MATERIAL = {
  body: "body",
  wing: "wing",
  carbon: "carbon",
  carbonWeave: "carbonWeave",
  carbonMatte: "carbonMatte",
  dark: "dark",
  duct: "duct",
  metal: "metal",
  halo: "halo"
};
export class CarModel {
  constructor(livery, detail = 2, opts = {}) {
    const shared = buildCarGeometry(detail);
    this.detail = detail;
    this.group = new THREE.Group();
    this.group.name = `car-body-lod${detail}`;
    this.meshes = [];
    const castShadow = opts.castShadow ?? detail >= 1;
    for (const role of Object.keys(shared.parts)) {
      const mat = livery[ROLE_TO_MATERIAL[role]] ?? livery.body;
      const mesh = new THREE.Mesh(shared.parts[role], mat);
      mesh.name = `car-${role}`;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
      this.meshes.push(mesh);
    }
    this.drsPivot = new THREE.Object3D();
    this.drsPivot.position.set(DRS_PIVOT[0], DRS_PIVOT[1], DRS_PIVOT[2]);
    if (shared.flap) {
      const flapMesh = new THREE.Mesh(shared.flap, livery.wing);
      flapMesh.castShadow = castShadow;
      flapMesh.matrixAutoUpdate = false;
      flapMesh.updateMatrix();
      this.drsPivot.add(flapMesh);
      this.group.add(this.drsPivot);
      this.meshes.push(flapMesh);
    }
    this._drs = -1;
    this.setDrs(0);
  }
  setDrs(open) {
    if (open === this._drs) return;
    this._drs = open;
    this.drsPivot.rotation.x = DRS_OPEN_ANGLE * open;
    this.drsPivot.updateMatrix();
  }
  setVisible(v) {
    this.group.visible = v;
  }
  dispose() {
    this.group.clear();
    this.meshes.length = 0;
  }
}
export { ROLES, CG_HEIGHT, slab, placed, tube, stripUv };
