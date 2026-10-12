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
import { buildCarbonTwill, buildWheelGrip } from "../render/textures/CarTextures.js";
import { clamp, clamp01, damp, formatLapTime, formatGap, DEG } from "../core/MathUtils.js";
import { COCKPIT_ANCHORS, cockpitInteriorGeometry, slab, placed } from "./CarModel.js";
import { ArmChain, DriverBust, cockpitSuitMaterial, legsGeometry } from "./DriverModel.js";
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _target = new THREE.Vector3();
const _qh = new THREE.Quaternion();
const _mat3 = new THREE.Matrix4();
const _camPos = new THREE.Vector3();
const _eyeWorld = new THREE.Vector3();
const _driverDir = new THREE.Vector3();
const _rim = new THREE.Vector3();
const _qRoll = new THREE.Quaternion();
const _UNIT_Z = new THREE.Vector3(0, 0, 1);
const WHEEL_HALF_WIDTH = 0.1375;
const WHEEL_HALF_HEIGHT = 0.0975;
const WHEEL_LOCK_RAD = 120 * DEG;
const EYE_LOCAL = [0, 0.523, -0.152];
const HALO_RAIL = [
  [0.262, 0.298, 0.104],
  [0.268, 0.3685, 0.098],
  [0.298, 0.5094, 0.062],
  [0.332, 0.656, -0.014],
  [0.358, 0.7716, -0.13],
  [0.372, 0.8477, -0.268],
  [0.376, 0.8902, -0.418],
  [0.36, 0.9069, -0.566],
  [0.318, 0.9013, -0.716],
  [0.246, 0.8872, -0.858],
  [0.146, 0.8759, -0.968],
  [0.058, 0.8734, -1.02]
];
const HALO_CROWN = [0, 0.8731, -1.03];
const HALO_PILLAR = [
  [0, 0.262, -1.0455],
  [0, 0.3, -1.0465],
  [0, 0.42, -1.046],
  [0, 0.54, -1.0445],
  [0, 0.66, -1.042],
  [0, 0.78, -1.038],
  [0, 0.8731, -1.03]
];
const HALO_HOOP_HALF_THIN = 0.01;
const HALO_HOOP_HALF_DEEP = 0.016;
const HALO_HOOP_TAPER_THIN = 0.3;
const HALO_HOOP_TAPER_DEEP = 0.25;
const HALO_PILLAR_HALF_W = 9e-3;
const HALO_PILLAR_HALF_D = 0.0225;
const HALO_PLANE_NORMAL = [0, -0.9128, -0.4083];
const _profile = { w: 1, h: 1 };
function haloHoopProfile(t, out) {
  const k = 1 - 2 * Math.min(t, 1 - t);
  out.w = 1 + HALO_HOOP_TAPER_DEEP * k;
  out.h = 1 + HALO_HOOP_TAPER_THIN * k;
}
const WHEEL_OFFSET = [0, 0.085, 0.055];
const GRIP_LOCAL = [
  new THREE.Vector3(-WHEEL_HALF_WIDTH, 4e-3, 0.03),
  new THREE.Vector3(WHEEL_HALF_WIDTH, 4e-3, 0.03)
];
function rimOutline(n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const th = -Math.PI * 0.5 + i / n * Math.PI * 2;
    const ct = Math.cos(th);
    const st = Math.sin(th);
    let x = WHEEL_HALF_WIDTH * Math.sign(ct) * Math.pow(Math.abs(ct), 0.4);
    let y = WHEEL_HALF_HEIGHT * Math.sign(st) * Math.pow(Math.abs(st), 0.4);
    if (st < 0) y *= 0.62 + 0.38 * Math.pow(Math.abs(ct), 1.5);
    if (st > 0) y *= 0.94 + 0.06 * Math.pow(Math.abs(ct), 2);
    x *= 1;
    pts.push(new THREE.Vector3(x, y, 0));
  }
  return pts;
}
function tubeFrom(points, radius, radial, closed, tubular) {
  const curve = new THREE.CatmullRomCurve3(points, closed, "centripetal", 0.5);
  return new THREE.TubeGeometry(curve, tubular, radius, radial, closed);
}
function sweepSection(points, halfWidth, halfHeight, ref, segments, radial, uPerMetre, profile = null) {
  const curve = new THREE.CatmullRomCurve3(
    points.map((p2) => new THREE.Vector3(p2[0], p2[1], p2[2])),
    false,
    "centripetal",
    0.5
  );
  curve.arcLengthDivisions = Math.max(200, segments * 4);
  const rings = segments + 3;
  const cols = radial + 1;
  const total = Math.max(1e-6, curve.getLength());
  const position = new Float32Array(rings * cols * 3);
  const normal = new Float32Array(rings * cols * 3);
  const uv = new Float32Array(rings * cols * 2);
  const p = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const prevTangent = new THREE.Vector3();
  const side = new THREE.Vector3();
  const up = new THREE.Vector3();
  const roll = new THREE.Quaternion();
  const axis = ref ? new THREE.Vector3(ref[0], ref[1], ref[2]).normalize() : null;
  const fallback = axis ? new THREE.Vector3(axis.y, axis.z, axis.x) : null;
  for (let r = 0; r < rings; r++) {
    const station = clamp(r - 1, 0, segments);
    const t = station / segments;
    const capped = r === 0 || r === rings - 1;
    curve.getPointAt(t, p);
    curve.getTangentAt(t, tangent).normalize();
    if (axis) {
      side.crossVectors(axis, tangent);
      if (side.lengthSq() < 1e-8) side.crossVectors(fallback, tangent);
      side.normalize();
    } else if (r === 0) {
      side.set(0, 1, 0);
      if (Math.abs(tangent.y) > 0.9) side.set(1, 0, 0);
      side.addScaledVector(tangent, -side.dot(tangent)).normalize();
      prevTangent.copy(tangent);
    } else {
      roll.setFromUnitVectors(prevTangent, tangent);
      side.applyQuaternion(roll);
      side.addScaledVector(tangent, -side.dot(tangent)).normalize();
      prevTangent.copy(tangent);
    }
    up.crossVectors(tangent, side).normalize();
    const u = t * total * uPerMetre;
    _profile.w = 1;
    _profile.h = 1;
    if (profile) profile(t, _profile);
    const hw = capped ? 0 : halfWidth * _profile.w;
    const hh = capped ? 0 : halfHeight * _profile.h;
    for (let j = 0; j < cols; j++) {
      const th = j / radial * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const i = r * cols + j;
      position[i * 3] = p.x + side.x * hw * c + up.x * hh * s;
      position[i * 3 + 1] = p.y + side.y * hw * c + up.y * hh * s;
      position[i * 3 + 2] = p.z + side.z * hw * c + up.z * hh * s;
      if (capped) {
        const sign = r === 0 ? -1 : 1;
        normal[i * 3] = tangent.x * sign;
        normal[i * 3 + 1] = tangent.y * sign;
        normal[i * 3 + 2] = tangent.z * sign;
      } else {
        const nx = side.x * hh * c + up.x * hw * s;
        const ny = side.y * hh * c + up.y * hw * s;
        const nz = side.z * hh * c + up.z * hw * s;
        const inv = 1 / Math.max(1e-8, Math.hypot(nx, ny, nz));
        normal[i * 3] = nx * inv;
        normal[i * 3 + 1] = ny * inv;
        normal[i * 3 + 2] = nz * inv;
      }
      uv[i * 2] = u;
      uv[i * 2 + 1] = j / radial;
    }
  }
  const index = new Uint16Array((rings - 1) * radial * 6);
  let k = 0;
  for (let r = 0; r < rings - 1; r++) {
    for (let j = 0; j < radial; j++) {
      const a = r * cols + j;
      const b = a + cols;
      index[k++] = a;
      index[k++] = a + 1;
      index[k++] = b;
      index[k++] = a + 1;
      index[k++] = b + 1;
      index[k++] = b;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.userData.length = total;
  return geo;
}
const WHEEL_ROTARIES = [
  [-0.096, 0.03],
  [0.096, 0.03],
  [-0.096, -0.024],
  [0.096, -0.024]
];
const WHEEL_TOGGLES = [[-0.034, -0.046], [0.034, -0.046]];
const CAP_NEUTRAL = 2829620;
const CAP_ROTARY = 2303275;
const CAP_INDEX = 11120052;
const WHEEL_BUTTONS = [
  [-0.072, 0.026, 10818078],
  [0.072, 0.026, 13082647],
  [-0.072, 0, CAP_NEUTRAL],
  [0.072, 0, CAP_NEUTRAL],
  [-0.072, -0.026, 1791668],
  [0.072, -0.026, 1344319],
  [-0.011, -0.046, CAP_NEUTRAL],
  [0.011, -0.046, CAP_NEUTRAL]
];
const _tint = new THREE.Color();
function tintGeometry(geo, hex) {
  const pos = geo.getAttribute("position");
  const out = new Float32Array(pos.count * 3);
  _tint.set(hex);
  for (let i = 0; i < pos.count; i++) {
    out[i * 3] = _tint.r;
    out[i * 3 + 1] = _tint.g;
    out[i * 3 + 2] = _tint.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(out, 3));
  return geo;
}
export class Cockpit {
  constructor(ctx, car) {
    this.ctx = ctx;
    this.car = car;
    this.livery = car.livery;
    this.config = car.config ?? null;
    this.quality = ctx.quality;
    this.group = new THREE.Group();
    this.group.name = "cockpit";
    this.cameraAnchor = new THREE.Object3D();
    this.cameraAnchor.name = "cockpit-camera-anchor";
    this.cameraAnchor.position.set(EYE_LOCAL[0], EYE_LOCAL[1], EYE_LOCAL[2]);
    this.group.add(this.cameraAnchor);
    this._owned = [];
    this._ownedMaterials = [];
    this._ownedTargets = [];
    this._ownedTextures = [];
    this._bodyHaloLevel = null;
    this.driverGroup = new THREE.Group();
    this.driverGroup.name = "driver-rig";
    this.car.group.add(this.driverGroup);
    this._maxRoadWheelAngle = this.config?.steering?.maxRoadWheelAngle ?? 21 * DEG;
    this._steerSmoothed = 0;
    this._displayTimer = 0;
    this._mirrorPhase = 0;
    this._mirrorFrameGate = 0;
    this._lean = new THREE.Vector3();
    this._leanTarget = new THREE.Vector3();
    this._bob = 0;
    this._visible = true;
    this._visorFov = -1;
    this._visorAspect = -1;
    this._buildHalo();
    this._buildInterior();
    this._buildSteeringWheel();
    this._buildDriver();
    this._buildMirrors();
    this._buildVisor();
  }
  _own(geo) {
    this._owned.push(geo);
    return geo;
  }
  _mat(name, fallback) {
    return this.ctx.materials?.get?.(name) ?? fallback;
  }
  _buildHalo() {
    const radial = 16;
    this.haloGroup = new THREE.Group();
    this.haloGroup.name = "halo";
    const hoop = [];
    for (const p of HALO_RAIL) hoop.push([-p[0], p[1], p[2]]);
    hoop.push(HALO_CROWN);
    for (let i = HALO_RAIL.length - 1; i >= 0; i--) hoop.push(HALO_RAIL[i]);
    const parts = [];
    parts.push(sweepSection(
      hoop,
      HALO_HOOP_HALF_DEEP,
      HALO_HOOP_HALF_THIN,
      HALO_PLANE_NORMAL,
      160,
      radial,
      6,
      haloHoopProfile
    ));
    parts.push(sweepSection(
      HALO_PILLAR,
      HALO_PILLAR_HALF_W,
      HALO_PILLAR_HALF_D,
      [0, 0, -1],
      96,
      radial,
      6,
      null
    ));
    this._haloMounts(parts);
    const geo = this._own(mergeGeometries(parts, false));
    for (const g of parts) g.dispose();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this._haloMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    this.haloGroup.add(mesh);
    this.car.group.add(this.haloGroup);
  }
  _haloMounts(parts) {
    const seg = 18;
    for (const s of [1, -1]) {
      const x = s * 0.268;
      parts.push(placed(slab(0.074, 0.012, 0.128, 4e-3), x, 0.286, 0.098));
      const pedestal = new THREE.CylinderGeometry(0.022, 0.03, 0.04, seg);
      pedestal.scale(1, 1, 1.9);
      pedestal.translate(x, 0.312, 0.098);
      parts.push(pedestal);
      for (const e of [1, -1]) {
        parts.push(placed(slab(8e-3, 0.075, 0.076, 3e-3), x + e * 0.021, 0.3625, 0.098));
      }
      const pin = new THREE.CylinderGeometry(8e-3, 8e-3, 0.062, 12);
      pin.rotateZ(Math.PI * 0.5);
      pin.translate(x, 0.3685, 0.098);
      parts.push(pin);
    }
    parts.push(placed(slab(0.066, 0.024, 0.15, 6e-3), 0, 0.268, -1.046));
    const fairing = new THREE.CylinderGeometry(0.014, 0.038, 0.056, seg);
    fairing.scale(1, 1, 2.6);
    fairing.translate(0, 0.296, -1.045);
    parts.push(fairing);
    for (const z of [-0.986, -1.106]) {
      const bolt = new THREE.CylinderGeometry(75e-4, 75e-4, 0.012, 10);
      bolt.translate(0, 0.284, z);
      parts.push(bolt);
    }
  }
  _haloMaterial() {
    const mat = new THREE.MeshStandardMaterial({
      color: 4868686,
      metalness: 1,
      roughness: 0.42,
      envMapIntensity: 0.6
    });
    this._ownedMaterials.push(mat);
    return mat;
  }
  _suppressBodyHalo() {
    const level = this.car.active;
    if (!level || level === this._bodyHaloLevel) return;
    this._bodyHaloLevel = level;
    const meshes = level.model?.meshes;
    const haloMat = this.livery.halo;
    if (!meshes || !haloMat || haloMat === this.livery.body || haloMat === this.livery.carbon) return;
    for (let i = 0; i < meshes.length; i++) {
      if (meshes[i].material === haloMat) meshes[i].visible = false;
    }
  }
  _buildInterior() {
    const detail = this.quality?.name === "low" ? 20 : 30;
    const shell = this._own(cockpitInteriorGeometry(detail));
    const weave = this._mat("carbon_weave", this.livery.carbon);
    const inner = new THREE.Mesh(shell, weave);
    inner.receiveShadow = false;
    this.group.add(inner);
    const padMat = this._mat("cockpit_padding", weave);
    const pads = [];
    pads.push(placed(slab(0.3, 0.07, 0.09, 0.02), 0, gy(0.56), 0.07));
    for (const s of [1, -1]) {
      pads.push(placed(slab(0.052, 0.075, 0.52, 0.018), s * 0.248, gy(0.52), -0.4));
      pads.push(placed(slab(0.09, 0.06, 0.18, 0.018), s * 0.19, gy(0.43), 0.09));
    }
    pads.push(placed(slab(0.36, 0.055, 0.075, 0.018), 0, gy(0.56), -0.96));
    const padGeo = this._own(mergeGeometries(pads, false));
    for (const p of pads) p.dispose();
    padGeo.computeVertexNormals();
    this.group.add(new THREE.Mesh(padGeo, padMat));
    const beltMat = this.livery.accent;
    const belts = [];
    for (const s of [1, -1]) {
      belts.push(strap(
        new THREE.Vector3(s * 0.15, gy(0.6), 0.03),
        new THREE.Vector3(s * 0.058, gy(0.398), -0.3),
        0.076,
        0.01
      ));
      belts.push(strap(
        new THREE.Vector3(s * 0.23, gy(0.41), -0.14),
        new THREE.Vector3(s * 0.06, gy(0.372), -0.3),
        0.062,
        0.01
      ));
    }
    belts.push(placed(slab(0.09, 0.07, 0.028, 8e-3), 0, gy(0.386), -0.31));
    const beltGeo = this._own(mergeGeometries(belts, false));
    for (const b of belts) b.dispose();
    beltGeo.computeVertexNormals();
    this.group.add(new THREE.Mesh(beltGeo, beltMat));
  }
  _wheelSurfaces() {
    const px = this.quality?.name === "low" ? 128 : 256;
    const aniso = this.ctx.materials?.anisotropy ?? 4;
    const tex = (data, w, h, mips, repeatU, repeatV, colorSpace = THREE.NoColorSpace) => {
      const t = makeDataTexture(data, w, h, colorSpace, mips);
      t.repeat.set(repeatU, repeatV);
      t.anisotropy = aniso;
      this._ownedTextures.push(t);
      return t;
    };
    const knurl = buildWheelGrip(px, 5566);
    const knurlN = normalMipChain(knurl.normal, knurl.width, knurl.height);
    const knurlO = mipChain(knurl.orm, knurl.width, knurl.height, false);
    applyToksvig(knurlO, knurlN.lengths);
    const gripAo = tex(knurl.orm, knurl.width, knurl.height, knurlO, 6.7, 4.7);
    gripAo.channel = 0;
    const grip = new THREE.MeshPhysicalMaterial({
      color: 1315866,
      roughness: 0.85,
      metalness: 0,
      normalMap: tex(knurl.normal, knurl.width, knurl.height, knurlN.levels, 6.7, 4.7),
      aoMap: gripAo,
      clearcoat: 0,
      envMapIntensity: 0.35
    });
    grip.normalScale.set(1.15, 1.15);
    const twill = buildCarbonTwill(px * 2, 8, {
      gloss: 0.42,
      contrast: 1.35,
      seed: 6203,
      baseR: 15,
      baseG: 16,
      baseB: 21,
      normalStrength: 2.5
    });
    const twillN = normalMipChain(twill.normal, twill.width, twill.height);
    const twillO = mipChain(twill.orm, twill.width, twill.height, false);
    applyToksvig(twillO, twillN.lengths);
    const twillC = mipChain(twill.color, twill.width, twill.height, true);
    const orm = tex(twill.orm, twill.width, twill.height, twillO, 10.75, 7.75);
    orm.channel = 0;
    const weave = new THREE.MeshPhysicalMaterial({
      color: 16777215,
      map: tex(twill.color, twill.width, twill.height, twillC, 10.75, 7.75, THREE.SRGBColorSpace),
      normalMap: tex(twill.normal, twill.width, twill.height, twillN.levels, 10.75, 7.75),
      roughnessMap: orm,
      aoMap: orm,
      roughness: 1,
      metalness: 0,
      clearcoat: 0.55,
      clearcoatRoughness: 0.14,
      envMapIntensity: 0.85
    });
    weave.normalScale.set(1, 1);
    this._ownedMaterials.push(grip, weave);
    return { grip, weave };
  }
  _buildSteeringWheel() {
    const hero = this.quality?.name !== "low";
    const radial = hero ? 12 : 7;
    const tubular = hero ? 96 : 48;
    this.wheelPivot = new THREE.Object3D();
    this.wheelPivot.name = "steering-wheel";
    const wc = COCKPIT_ANCHORS.wheelCentre;
    this.wheelPivot.position.set(wc[0] + WHEEL_OFFSET[0], wc[1] + WHEEL_OFFSET[1], wc[2] + WHEEL_OFFSET[2]);
    this.wheelPivot.rotation.x = -(Math.PI * 0.5 - COCKPIT_ANCHORS.wheelRake);
    this.driverGroup.add(this.wheelPivot);
    const outline = rimOutline(hero ? 64 : 32);
    const carbonMatte = this._mat("carbon_matte", this.livery.carbonMatte);
    const metal = this._mat("metal_anodised", this.livery.metal);
    const { grip: gripMat, weave } = this._wheelSurfaces();
    const structural = [];
    structural.push(tubeFrom(outline, 0.0155, radial, true, tubular));
    const hub = new THREE.CylinderGeometry(0.044, 0.038, 0.052, hero ? 20 : 10);
    hub.rotateX(Math.PI * 0.5);
    hub.translate(0, 0, -0.034);
    structural.push(hub);
    for (const s of [1, -1]) {
      structural.push(placed(slab(0.062, 0.03, 0.02, 6e-3), s * 0.088, -0.01, -4e-3, 0, 0, s * 0.28));
    }
    for (const s of [1, -1]) {
      structural.push(placed(slab(0.044, 0.128, 7e-3, 3e-3), s * 0.082, 6e-3, -0.046, 0.1, s * 0.2, 0));
      structural.push(placed(slab(0.036, 0.072, 6e-3, 3e-3), s * 0.106, -0.062, -0.038, 0.1, s * 0.3, 0));
    }
    const structGeo = this._own(mergeGeometries(structural, false));
    for (const g of structural) g.dispose();
    structGeo.computeVertexNormals();
    this.wheelPivot.add(new THREE.Mesh(structGeo, carbonMatte));
    const grips = [];
    const n = outline.length;
    for (const s of [1, -1]) {
      const pts = [];
      for (let k = -7; k <= 7; k++) {
        const i = ((s > 0 ? Math.round(n * 0.25) : Math.round(n * 0.75)) + k + n) % n;
        pts.push(outline[i].clone().multiplyScalar(1));
      }
      if (s < 0) pts.reverse();
      const g = tubeFrom(pts, 0.0245, radial, false, hero ? 28 : 14);
      g.scale(1, 1, 0.82);
      grips.push(g);
    }
    const gripGeo = this._own(mergeGeometries(grips, false));
    for (const g of grips) g.dispose();
    gripGeo.computeVertexNormals();
    this.wheelPivot.add(new THREE.Mesh(gripGeo, gripMat));
    const body = this._own(placed(slab(0.172, 0.124, 0.028, 0.01), 0, 4e-3, 2e-3));
    this.wheelPivot.add(new THREE.Mesh(body, weave));
    this._buildDisplay();
    this._buildControls(metal, hero);
  }
  _buildDisplay() {
    const displayMat = this._mat("display_screen", null);
    this._displayCtx = displayMat?.userData?.context ?? null;
    this._displayTex = displayMat?.userData?.texture ?? null;
    this._displayW = displayMat?.userData?.canvas?.width ?? 512;
    this._displayH = displayMat?.userData?.canvas?.height ?? 256;
    const screen = this._own(new THREE.PlaneGeometry(0.116, 0.068));
    const screenMesh = new THREE.Mesh(screen, displayMat ?? new THREE.MeshBasicMaterial({ color: 659224 }));
    screenMesh.position.set(0, 4e-3, 0.0165);
    this.wheelPivot.add(screenMesh);
    const stripGeo = this._own(new THREE.PlaneGeometry(0.186, 0.0135));
    const ledMat = this.ctx.materials?.clone?.("led_strip") ?? new THREE.MeshStandardMaterial({ emissive: new THREE.Color(16777215), emissiveIntensity: 3 });
    this._ledUniforms = { uLit: { value: 0 }, uFlash: { value: 0 } };
    const uniforms = this._ledUniforms;
    if (ledMat.emissiveMap) ledMat.onBeforeCompile = (shader) => {
      shader.uniforms.uLit = uniforms.uLit;
      shader.uniforms.uFlash = uniforms.uFlash;
      shader.fragmentShader = `uniform float uLit;
uniform float uFlash;
${shader.fragmentShader}`.replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
	float cell = floor( vEmissiveMapUv.x * 15.0 );
	float lit = max( step( cell + 0.5, uLit ), uFlash );
	totalEmissiveRadiance *= lit;`
      );
    };
    if (ledMat.emissiveMap) ledMat.customProgramCacheKey = () => "apex_rev_leds";
    ledMat.needsUpdate = true;
    if (!this.ctx.materials?.clone) this._ownedMaterials.push(ledMat);
    const leds = new THREE.Mesh(stripGeo, ledMat);
    leds.position.set(0, 0.0605, 0.0166);
    this.wheelPivot.add(leds);
  }
  _buildControls(metal, hero) {
    const seg = hero ? 14 : 8;
    const bodies = [];
    const caps = [];
    const capColours = [];
    const cap = (geo, hex) => {
      caps.push(geo);
      capColours.push(hex);
    };
    for (const [x, y] of WHEEL_ROTARIES) {
      const knob = new THREE.CylinderGeometry(0.0132, 0.0142, 0.013, seg);
      knob.rotateX(Math.PI * 0.5);
      knob.translate(x, y, 0.02);
      bodies.push(knob);
      const face = new THREE.CylinderGeometry(9e-3, 9e-3, 35e-4, seg);
      face.rotateX(Math.PI * 0.5);
      face.translate(x, y, 0.0283);
      cap(face, CAP_ROTARY);
      const notch = new THREE.BoxGeometry(26e-4, 8e-3, 4e-3);
      notch.translate(x, y + 55e-4, 0.0292);
      cap(notch, CAP_INDEX);
    }
    for (const [x, y] of WHEEL_TOGGLES) {
      const toggle = new THREE.BoxGeometry(0.01, 0.02, 0.01);
      toggle.translate(x, y, 0.021);
      bodies.push(toggle);
    }
    for (const [x, y, hex] of WHEEL_BUTTONS) {
      const bezel = new THREE.CylinderGeometry(82e-4, 86e-4, 6e-3, seg);
      bezel.rotateX(Math.PI * 0.5);
      bezel.translate(x, y, 0.0195);
      bodies.push(bezel);
      const face = new THREE.CylinderGeometry(68e-4, 68e-4, 35e-4, seg);
      face.rotateX(Math.PI * 0.5);
      face.translate(x, y, 0.0243);
      cap(face, hex);
    }
    const bodyGeo = this._own(mergeGeometries(bodies, false));
    for (const g of bodies) g.dispose();
    bodyGeo.computeVertexNormals();
    this.wheelPivot.add(new THREE.Mesh(bodyGeo, metal));
    for (let i = 0; i < caps.length; i++) tintGeometry(caps[i], capColours[i]);
    const capGeo = this._own(mergeGeometries(caps, false));
    for (const g of caps) g.dispose();
    capGeo.computeVertexNormals();
    const capMat = new THREE.MeshPhysicalMaterial({
      color: 16777215,
      vertexColors: true,
      roughness: 0.38,
      metalness: 0,
      clearcoat: 0.45,
      clearcoatRoughness: 0.12,
      envMapIntensity: 0.55
    });
    this._ownedMaterials.push(capMat);
    this.wheelPivot.add(new THREE.Mesh(capGeo, capMat));
  }
  _buildDriver() {
    const detail = this.quality?.name === "low" ? 1 : 2;
    const sh = COCKPIT_ANCHORS.shoulder;
    this.arms = [
      new ArmChain(this.ctx, this.livery, -1, [-sh[0], sh[1], sh[2]], detail),
      new ArmChain(this.ctx, this.livery, 1, [sh[0], sh[1], sh[2]], detail)
    ];
    for (const arm of this.arms) {
      this.driverGroup.add(arm.group);
      this.group.add(arm.upper);
    }
    const legs = this._own(legsGeometry(
      detail,
      COCKPIT_ANCHORS.knee,
      COCKPIT_ANCHORS.ankle,
      COCKPIT_ANCHORS.hip
    ));
    this.legs = new THREE.Mesh(legs, cockpitSuitMaterial(this.livery) ?? this.livery.suit);
    this.group.add(this.legs);
    this.bust = this.car.driver ? new DriverBust(this.ctx, this.car.driver, this.livery, detail, COCKPIT_ANCHORS.helmet) : null;
    if (this.bust) {
      if (detail < 2) this.bust.visor.visible = false;
      this.driverGroup.add(this.bust.group);
    }
  }
  _buildMirrors() {
    const res = this.quality?.mirrorResolution ?? 0;
    this.mirrors = [];
    if (res <= 0) return;
    const height = Math.max(64, Math.round(res * 0.46));
    for (const m of COCKPIT_ANCHORS.mirrors) {
      const target = new THREE.WebGLRenderTarget(res, height, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: THREE.HalfFloatType,
        depthBuffer: true,
        stencilBuffer: false
      });
      target.texture.colorSpace = THREE.NoColorSpace;
      this._ownedTargets.push(target);
      const geo = this._own(new THREE.PlaneGeometry(0.114, 0.053));
      const uv = geo.getAttribute("uv");
      for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
      uv.needsUpdate = true;
      const mat = new THREE.MeshBasicMaterial({ map: target.texture, toneMapped: true });
      this._ownedMaterials.push(mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(m.pos[0], m.pos[1], m.pos[2]);
      mesh.rotation.y = m.yaw;
      mesh.translateZ(3e-3);
      mesh.frustumCulled = false;
      this.group.add(mesh);
      const camera = new THREE.PerspectiveCamera(52, 0.114 / 0.053, 0.35, 500);
      this.mirrors.push({ mesh, camera, target, spec: m });
    }
  }
  _buildVisor() {
    const size = 512;
    const canvas = createCanvas(size, size);
    drawVisor(canvas.getContext("2d"), size);
    this._visorTexture = textureFromCanvas(canvas);
    this._visorTexture.wrapS = THREE.ClampToEdgeWrapping;
    this._visorTexture.wrapT = THREE.ClampToEdgeWrapping;
    const geo = this._own(new THREE.PlaneGeometry(1, 1));
    const mat = new THREE.MeshBasicMaterial({
      map: this._visorTexture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      opacity: 1
    });
    this._ownedMaterials.push(mat);
    this.visor = new THREE.Mesh(geo, mat);
    this.visor.renderOrder = 4e3;
    this.visor.frustumCulled = false;
    this.visor.position.set(0, 0, -0.09);
    this._sizeVisor();
    const camera = this.ctx.camera;
    if (camera) camera.add(this.visor);
    else this.cameraAnchor.add(this.visor);
  }
  _sizeVisor() {
    const cam = this.ctx.camera;
    const fovDeg = cam?.fov ?? 82;
    const aspect = cam?.aspect ?? 1.777;
    this._visorFov = fovDeg;
    this._visorAspect = aspect;
    const dist = 0.09;
    const h = 2 * dist * Math.tan(fovDeg * DEG * 0.5) * 1.04;
    this.visor.scale.set(h * aspect, h, 1);
  }
  resize() {
    if (this.visor) this._sizeVisor();
  }
  update(dt, ctx) {
    this._suppressBodyHalo();
    const state = this.car.physics?.state;
    if (!state) return;
    this._visible = this._cameraIsInCockpit(ctx);
    if (this.group.visible !== this._visible) this.group.visible = this._visible;
    if (this.visor) this.visor.visible = this._visible;
    if (this.bust && this.bust.group.visible === this._visible) this.bust.setVisible(!this._visible);
    const front = 0.5 * (state.wheels[0].steerAngle + state.wheels[1].steerAngle);
    const normalised = clamp(front / this._maxRoadWheelAngle, -1, 1);
    this._steerSmoothed = damp(this._steerSmoothed, normalised, 28, dt);
    this.wheelPivot.rotation.z = -this._steerSmoothed * WHEEL_LOCK_RAD;
    this.wheelPivot.updateMatrix();
    this._updateHands();
    this._updateLeds(state);
    if (this.bust) this.bust.setHeadLean(state.gForce.x, state.gForce.z);
    if (!this._visible) return;
    const cam = ctx.camera;
    if (this.visor && cam && (cam.fov !== this._visorFov || cam.aspect !== this._visorAspect)) {
      this._sizeVisor();
    }
    this._updateHead(dt, state, ctx);
    this._displayTimer -= dt;
    if (this._displayTimer <= 0) {
      this._displayTimer = 1 / 30;
      this._drawDisplay(ctx, state);
    }
  }
  _cameraIsInCockpit(ctx) {
    const cam = ctx.camera;
    if (!cam) return true;
    this.cameraAnchor.getWorldPosition(_eyeWorld);
    cam.getWorldPosition(_camPos);
    return _camPos.distanceToSquared(_eyeWorld) < 0.36;
  }
  _updateHands() {
    const steer = this._steerSmoothed;
    _driverDir.set(0, 0, 1).applyQuaternion(this.wheelPivot.quaternion);
    _rim.set(0, 1, 0).applyQuaternion(this.wheelPivot.quaternion);
    for (let i = 0; i < 2; i++) {
      const arm = this.arms[i];
      const side = i === 0 ? -1 : 1;
      arm.shoulder.set(
        arm.baseShoulder.x,
        arm.baseShoulder.y - side * steer * 0.052,
        arm.baseShoulder.z - Math.abs(steer) * 0.03
      );
      _target.copy(GRIP_LOCAL[i]).applyMatrix4(this.wheelPivot.matrix);
      arm.solve(_target);
      _v.subVectors(arm.elbow, _target).normalize();
      _v2.copy(_rim).addScaledVector(_v, -_rim.dot(_v));
      if (_v2.lengthSq() < 1e-8) _v2.set(1, 0, 0).addScaledVector(_v, -_v.x);
      _v2.normalize();
      _v3.crossVectors(_v2, _v);
      if (_v3.dot(_driverDir) < 0) {
        _v2.negate();
        _v3.negate();
      }
      _mat3.makeBasis(_v2, _v, _v3);
      _qh.setFromRotationMatrix(_mat3);
      const rx = _rim.dot(_v2);
      const ry = _rim.dot(_v);
      const sgn = rx < 0 ? -1 : 1;
      _qRoll.setFromAxisAngle(_UNIT_Z, clamp(0.5 * Math.atan2(sgn * ry, sgn * rx), -0.5, 0.5));
      _qh.multiply(_qRoll);
      arm.orientHand(_qh);
    }
  }
  _updateHead(dt, state, ctx) {
    const scale = ctx.settings?.get?.("headMovement") ?? 1;
    if (scale <= 0) {
      this.cameraAnchor.position.set(EYE_LOCAL[0], EYE_LOCAL[1], EYE_LOCAL[2]);
      this.cameraAnchor.rotation.set(0, 0, 0);
      return;
    }
    const g = state.gForce;
    this._leanTarget.set(
      clamp(-g.x * 0.011, -0.026, 0.026),
      clamp(-(g.y - 1) * 6e-3, -0.02, 0.02),
      clamp(g.z * 0.013, -0.03, 0.03)
    );
    this._lean.x = damp(this._lean.x, this._leanTarget.x, 9, dt);
    this._lean.y = damp(this._lean.y, this._leanTarget.y, 9, dt);
    this._lean.z = damp(this._lean.z, this._leanTarget.z, 9, dt);
    const eye = EYE_LOCAL;
    this.cameraAnchor.position.set(
      eye[0] + this._lean.x * scale,
      eye[1] + this._lean.y * scale,
      eye[2] + this._lean.z * scale
    );
    this.cameraAnchor.rotation.z = clamp(g.x * 0.016, -0.05, 0.05) * scale;
    this.cameraAnchor.rotation.x = clamp(-g.z * 0.01, -0.035, 0.035) * scale;
    this.cameraAnchor.updateMatrix();
  }
  _updateLeds(state) {
    if (!this._ledUniforms) return;
    const limiter = this.config?.engine?.limiterRpm ?? 15e3;
    const start = limiter * 0.72;
    const t = clamp01((state.rpm - start) / Math.max(1, limiter * 0.985 - start));
    this._ledUniforms.uLit.value = Math.round(t * 15);
    this._ledUniforms.uFlash.value = state.limiterActive ? Math.floor(performance.now() / 60) % 2 === 0 ? 1 : 0 : 0;
  }
  _drawDisplay(ctx, state) {
    const c = this._displayCtx;
    if (!c) return;
    const w = this._displayW;
    const h = this._displayH;
    c.fillStyle = "#04060a";
    c.fillRect(0, 0, w, h);
    const limiter = this.config?.engine?.limiterRpm ?? 15e3;
    const rpmT = clamp01(state.rpm / limiter);
    const barY = h * 0.055;
    const barH = h * 0.115;
    const pad = w * 0.045;
    const barW = w - pad * 2;
    c.fillStyle = "#0c1420";
    c.fillRect(pad, barY, barW, barH);
    const cells = 24;
    for (let i = 0; i < cells; i++) {
      const f = i / cells;
      if (f > rpmT) break;
      c.fillStyle = f < 0.62 ? "#19e05a" : f < 0.84 ? "#ffd11a" : "#ff2f1e";
      c.fillRect(pad + f * barW + 1, barY + 2, barW / cells - 2, barH - 4);
    }
    const gear = state.gear;
    const gearText = gear < 0 ? "R" : gear === 0 ? "N" : String(gear);
    c.fillStyle = state.limiterActive ? "#5aa0ff" : "#f2f6ff";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.font = `800 ${Math.round(h * 0.52)}px system-ui, "Helvetica Neue", Arial, sans-serif`;
    c.fillText(gearText, w * 0.5, h * 0.47);
    c.textAlign = "right";
    c.font = `700 ${Math.round(h * 0.2)}px system-ui, Arial, sans-serif`;
    c.fillStyle = "#e8f0ff";
    c.fillText(String(Math.round(Math.abs(state.speedKph))), w * 0.97, h * 0.42);
    c.font = `600 ${Math.round(h * 0.075)}px system-ui, Arial, sans-serif`;
    c.fillStyle = "#7f93ad";
    c.fillText("KM/H", w * 0.97, h * 0.56);
    const session = ctx.race?.session;
    c.textAlign = "left";
    c.font = `600 ${Math.round(h * 0.085)}px system-ui, Arial, sans-serif`;
    c.fillStyle = "#7f93ad";
    c.fillText("LAP", pad, h * 0.3);
    c.font = `700 ${Math.round(h * 0.15)}px system-ui, Arial, sans-serif`;
    c.fillStyle = "#e8f0ff";
    const lap = session?.lap ?? 1;
    const total = session?.totalLaps ?? 0;
    c.fillText(total > 0 ? `${lap}/${total}` : String(lap), pad, h * 0.44);
    const delta = this.car.delta;
    c.font = `700 ${Math.round(h * 0.135)}px system-ui, Arial, sans-serif`;
    if (Number.isFinite(delta)) {
      c.fillStyle = delta <= 0 ? "#25e06a" : "#ff5a3c";
      c.fillText(formatGap(delta), pad, h * 0.7);
    } else {
      c.fillStyle = "#43536a";
      c.fillText("--.---", pad, h * 0.7);
    }
    c.font = `600 ${Math.round(h * 0.075)}px system-ui, Arial, sans-serif`;
    c.fillStyle = "#7f93ad";
    c.fillText(formatLapTime(this.car.lastLapTime), pad, h * 0.84);
    const ersW = w * 0.34;
    const ersX = w - pad - ersW;
    const ersY = h * 0.68;
    c.fillStyle = "#0c1420";
    c.fillRect(ersX, ersY, ersW, h * 0.085);
    c.fillStyle = "#28c8ff";
    c.fillRect(ersX + 1, ersY + 1, (ersW - 2) * clamp01(state.ers.charge), h * 0.085 - 2);
    c.fillStyle = state.ers.deploy > 0.01 ? "#ffd11a" : "#3a4a5e";
    c.fillRect(ersX, ersY + h * 0.1, ersW * clamp01(state.ers.deploy), h * 0.03);
    c.textAlign = "right";
    c.font = `600 ${Math.round(h * 0.07)}px system-ui, Arial, sans-serif`;
    c.fillStyle = "#7f93ad";
    c.fillText(`ERS ${Math.round(state.ers.charge * 100)}%`, w - pad, h * 0.63);
    if (state.drs.open) {
      c.textAlign = "center";
      c.fillStyle = "#00e5a0";
      c.font = `800 ${Math.round(h * 0.1)}px system-ui, Arial, sans-serif`;
      c.fillText("DRS", w * 0.5, h * 0.82);
    } else if (state.drs.available) {
      c.textAlign = "center";
      c.fillStyle = "#0f6b52";
      c.font = `800 ${Math.round(h * 0.1)}px system-ui, Arial, sans-serif`;
      c.fillText("DRS", w * 0.5, h * 0.82);
    }
    if (this._displayTex) this._displayTex.needsUpdate = true;
  }
  renderMirrors(ctx) {
    if (!this._visible || !this.mirrors || this.mirrors.length === 0) return;
    this._mirrorFrameGate ^= 1;
    if (this._mirrorFrameGate === 0 && ctx.captureMode !== true) return;
    const renderer = ctx.renderer;
    const scene = ctx.scene;
    const camera = ctx.camera;
    if (!renderer || !scene || !camera) return;
    const index = this._mirrorPhase % this.mirrors.length;
    this._mirrorPhase++;
    const m = this.mirrors[index];
    m.mesh.getWorldPosition(_v);
    m.mesh.getWorldDirection(_n);
    camera.getWorldPosition(_camPos);
    _v2.subVectors(_v, _camPos).normalize();
    _v3.copy(_v2).addScaledVector(_n, -2 * _v2.dot(_n));
    m.camera.position.copy(_v);
    _target.copy(_v).add(_v3);
    m.camera.up.set(0, 1, 0);
    m.camera.lookAt(_target);
    m.camera.updateMatrixWorld();
    const prevTarget = renderer.getRenderTarget();
    const prevShadowAuto = renderer.shadowMap.autoUpdate;
    const cockpitWasVisible = this.group.visible;
    const rigWasVisible = this.driverGroup.visible;
    const visorWasVisible = this.visor ? this.visor.visible : false;
    renderer.shadowMap.autoUpdate = false;
    this.group.visible = false;
    this.driverGroup.visible = false;
    if (this.visor) this.visor.visible = false;
    renderer.setRenderTarget(m.target);
    renderer.clear(true, true, false);
    renderer.render(scene, m.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.shadowMap.autoUpdate = prevShadowAuto;
    this.group.visible = cockpitWasVisible;
    this.driverGroup.visible = rigWasVisible;
    if (this.visor) this.visor.visible = visorWasVisible;
  }
  setQuality(tier) {
    this.quality = tier;
    if (this.visor) this._sizeVisor();
  }
  dispose() {
    if (this.visor?.parent) this.visor.parent.remove(this.visor);
    this.haloGroup?.removeFromParent();
    this.haloGroup?.clear();
    this.bust?.dispose();
    for (const arm of this.arms ?? []) arm.dispose();
    this.driverGroup?.removeFromParent();
    this.driverGroup?.clear();
    for (const g of this._owned) g.dispose();
    for (const m of this._ownedMaterials) m.dispose();
    for (const t of this._ownedTargets) t.dispose();
    for (const t of this._ownedTextures) t.dispose();
    this._visorTexture?.dispose();
    this._owned.length = 0;
    this._ownedMaterials.length = 0;
    this._ownedTargets.length = 0;
    this._ownedTextures.length = 0;
    this.group.clear();
  }
}
const CG_H = 0.28;
function gy(h) {
  return h - CG_H;
}
function strap(a, b, width, thickness) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  dir.normalize();
  const geo = slab(width, len, thickness, thickness * 0.4);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  geo.applyQuaternion(q);
  geo.translate((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
  return geo;
}
function drawVisor(c, size) {
  c.clearRect(0, 0, size, size);
  const mid = size * 0.5;
  const outer = size * 0.5;
  const inner = outer * 0.85;
  const g = c.createRadialGradient(mid, mid, inner, mid, mid, outer);
  g.addColorStop(0, "rgba(6,6,6,0)");
  g.addColorStop(0.5, "rgba(6,6,6,0.014)");
  g.addColorStop(1, "rgba(6,6,6,0.060)");
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
}
export { WHEEL_LOCK_RAD, drawVisor };
