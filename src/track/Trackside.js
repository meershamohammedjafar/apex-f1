import * as THREE from "three";
import { clamp, clamp01, smoothstep } from "../core/MathUtils.js";
import { Rng } from "../core/Rng.js";
import { makeDataTexture } from "../render/textures/NoiseTextures.js";
import {
  CROWD_CELL_W,
  CROWD_CELL_H,
  DISTANCE_MARKS,
  buildDistanceBoards,
  buildCatchFence,
  buildAstroturfVerge,
  buildCanopyAtlas,
  CANOPY_ALPHA_TEST,
  CANOPY_ATLAS,
  buildLedPanels,
  buildSponsorBoards
} from "../render/textures/TracksideTextures.js";
const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _axis = new THREE.Vector3(0, 1, 0);
const _bakeV = new THREE.Vector3();
const _bakeNormal = new THREE.Matrix3();
const NEAR_TERRAIN_CELL = 15;
const NEAR_TERRAIN_PAD = 900;
const TERRAIN_CHUNKS = 2;
const CORRIDOR_HOLE = 40;
const FAR_RADIUS = 13e3;
const FENCE_HEIGHT = 3.3;
const FENCE_POST_SPACING = 3;
const FENCE_FOOT = 0.7;
const FENCE_RAIL_MID = 2.32;
const FENCE_GRAZE_FLOOR = 0.16;
const STAND_SETBACK = 3;
const STAND_RISER = 0.45;
const STAND_TREAD = 0.85;
const STAND_FRONT = 2.35;
const STAND_WALK = 1.15;
const STAND_ROOF_CLEAR = 4.4;
const STAND_STATION = 9;
const STAND_FRAME_STATION = 4.5;
function pushQuad(indices, positions, normals, a, b, c, d) {
  const ia = a * 3;
  const e1x = positions[b * 3] - positions[ia];
  const e1y = positions[b * 3 + 1] - positions[ia + 1];
  const e1z = positions[b * 3 + 2] - positions[ia + 2];
  const e2x = positions[c * 3] - positions[ia];
  const e2y = positions[c * 3 + 1] - positions[ia + 1];
  const e2z = positions[c * 3 + 2] - positions[ia + 2];
  const fx = e1y * e2z - e1z * e2y;
  const fy = e1z * e2x - e1x * e2z;
  const fz = e1x * e2y - e1y * e2x;
  if (fx * fx + fy * fy + fz * fz < 1e-12) return;
  if (fx * normals[ia] + fy * normals[ia + 1] + fz * normals[ia + 2] < 0) {
    indices.push(a, c, b, b, c, d);
  } else {
    indices.push(a, b, c, b, d, c);
  }
}
function hash2(ix, iz) {
  const s = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function valueNoise2(x, z) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c + (d - c) * ux - (a + (b - a) * ux)) * uz;
}
const NIGHT_MAST_SPACING = 140;
const NIGHT_MAST_HEIGHT = 30;
const NIGHT_MAST_CLEAR = 70;
const POOL_HALF = 46;
const POOL_PAD = 9;
const POOL_ARC_STEP = 6;
const POOL_LAT_STEP = 2.2;
const POOL_LIFT = 0.06;
const POOL_GAIN = 1.6;
const NIGHT_SPOT_MAX = 4;
const NIGHT_SPOT_DECAY = 1.05;
const NIGHT_SPOT_REF = 55;
const NIGHT_SPOT_IRRADIANCE = 3;
const NIGHT_SPOT_AIM_SPAN = 28;
const NIGHT_SPOT_FADE_NEAR = 150;
const NIGHT_SPOT_FADE_FAR = 320;
const NIGHT_LENS_EMISSIVE = 8.5;
const NIGHT_FILL_INTENSITY = 0.52;
const TRUNK_UNIT_RADIUS = 0.25;
const TREE_SPACING = 21;
const TREE_BAND = 330;
const TREE_FAR_BAND = 760;
const TREE_FAR_SPACING = 46;
const TREE_SPECIES = [
  {
    name: "spruce",
    form: "spire",
    atlas: 0,
    share: 0.4,
    height: [17, 38],
    radius: [2.1, 4],
    cards: 13,
    bare: 0.1,
    tint: [[0.52, 0.6, 0.52], [0.86, 0.92, 0.8]]
  },
  {
    name: "pine",
    form: "umbrella",
    atlas: 1,
    share: 0.2,
    height: [14, 28],
    radius: [2.8, 5],
    cards: 10,
    bare: 0.58,
    tint: [[0.58, 0.66, 0.54], [0.94, 0.96, 0.82]]
  },
  {
    name: "beech",
    form: "dome",
    atlas: 2,
    share: 0.28,
    height: [11, 27],
    radius: [3.6, 7],
    cards: 13,
    bare: 0.32,
    tint: [[0.58, 0.7, 0.52], [1, 1.02, 0.84]]
  },
  {
    name: "birch",
    form: "column",
    atlas: 3,
    share: 0.12,
    height: [8, 20],
    radius: [1.8, 3.2],
    cards: 9,
    bare: 0.44,
    tint: [[0.72, 0.82, 0.58], [1.06, 1.08, 0.86]]
  }
];
const SPONSOR_PROFILE = [
  [-0.09, 0.0685],
  [-0.22, 0.13],
  [-0.22, 1.15],
  [-0.09, 1.2115]
];
const LED_PROFILE = [
  [-0.12, 1.2353],
  [-0.24, 1.26],
  [-0.24, 2.24],
  [-0.12, 2.2647]
];
const BANK_ROWS = 7;
const BANK_RISE = 0.62;
const BANK_TREAD = 2.6;
class MeshAccum {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.idx = [];
  }
  get vertexCount() {
    return this.pos.length / 3;
  }
  quad(p0, p1, p2, p3, n, u0, v0, u1, v1) {
    const base = this.vertexCount;
    const pts = [p0, p1, p2, p3];
    const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    for (let i = 0; i < 4; i++) {
      this.pos.push(pts[i][0], pts[i][1], pts[i][2]);
      this.nor.push(n[0], n[1], n[2]);
      this.uv.push(uvs[i][0], uvs[i][1]);
    }
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
    const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
    const fx = ay * bz - az * by;
    const fy = az * bx - ax * bz;
    const fz = ax * by - ay * bx;
    if (fx * n[0] + fy * n[1] + fz * n[2] < 0) {
      this.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    } else {
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  box(cx, cy, cz, sx, sy, sz, ry, uvScale = 1) {
    const c = Math.cos(ry);
    const s = Math.sin(ry);
    const hx = sx * 0.5, hy = sy * 0.5, hz = sz * 0.5;
    const corner = (ix, iy, iz) => {
      const lx = ix * hx;
      const lz = iz * hz;
      return [cx + lx * c + lz * s, cy + iy * hy, cz - lx * s + lz * c];
    };
    const rot = (nx, nz) => [nx * c + nz * s, 0, -nx * s + nz * c];
    const faces = [
      [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1], rot(1, 0), sz, sy],
      [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1], rot(-1, 0), sz, sy],
      [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1], rot(0, 1), sx, sy],
      [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1], rot(0, -1), sx, sy],
      [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1], [0, 1, 0], sx, sz],
      [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [0, -1, 0], sx, sz]
    ];
    for (const f of faces) {
      this.quad(
        corner(...f[0]),
        corner(...f[1]),
        corner(...f[2]),
        corner(...f[3]),
        f[4],
        0,
        0,
        f[5] * uvScale,
        f[6] * uvScale
      );
    }
  }
  toGeometry() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    return geo;
  }
}
export class Trackside {
  constructor(track, ctx) {
    this.track = track;
    this.ctx = ctx;
    this.surface = track.surface;
    this.group = new THREE.Group();
    this.group.name = "trackside";
    this.rng = new Rng(1503755781);
    this._geometries = [];
    this._materials = [];
    this._textures = [];
    this._tyreStacks = [];
    this._steel = new MeshAccum();
    this._signs = new MeshAccum();
    this._time = { value: 0 };
    this._wind = { value: new THREE.Vector2(1, 0.3) };
    this.tier = ctx.quality;
    this._pylonSites = [];
    this._marshalSites = [];
    this._nightEmissive = [];
    this._nightAdditive = [];
    this._nightMeshes = [];
    this._spots = [];
    this._spotSite = new Int32Array(NIGHT_SPOT_MAX);
    this._spotDist = new Float64Array(NIGHT_SPOT_MAX);
    this._siteData = new Float64Array(0);
    this._nightFill = null;
    this._nightFactor = -1;
  }
  build() {
    this._retextureVerge();
    this._buildTerrain();
    this._buildFarTerrain();
    this._buildGrandstands();
    this._buildPitComplex();
    this._buildFences();
    this._buildSponsorBoards();
    this._buildDistanceBoards();
    this._buildMarshalPosts();
    this._buildTowers();
    this._buildTyreStacks();
    this._buildTrees();
    this._buildSpectatorAreas();
    this._buildNightLighting();
    this._addMerged(this._steel, this._fenceRailMaterial(), "tracksideSteel", false, false);
    this._addMerged(this._signs, this._signMaterial(), "tracksideSigns", false);
    this._steel = null;
    this._signs = null;
  }
  get drawCalls() {
    let n = 0;
    this.group.traverse((o) => {
      if (o.isMesh) n++;
    });
    return n;
  }
  _retextureVerge() {
    const materials = this.ctx.materials;
    const mat = materials.get("astroturf");
    if (!mat) return;
    const td = buildAstroturfVerge(512, 7700);
    const aniso = this._maxAnisotropy();
    const map = makeDataTexture(td.color, td.width, td.height, THREE.SRGBColorSpace, td.colorMips);
    const normalMap = makeDataTexture(td.normal, td.width, td.height, THREE.NoColorSpace);
    const ormMap = makeDataTexture(td.orm, td.width, td.height, THREE.NoColorSpace);
    ormMap.channel = 0;
    for (const t of [map, normalMap, ormMap]) {
      t.anisotropy = aniso;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      this._textures.push(t);
    }
    mat.map = map;
    mat.normalMap = normalMap;
    mat.roughnessMap = ormMap;
    mat.aoMap = ormMap;
    mat.metalnessMap = null;
    mat.metalness = 0;
    mat.roughness = 1;
    mat.color.setRGB(1, 1, 1);
    mat.normalScale.set(1, 1);
    mat.envMapIntensity = 0.85;
    mat.needsUpdate = true;
  }
  _buildTerrain() {
    const surf = this.surface;
    const b = surf.bounds;
    const minX = b.minX - NEAR_TERRAIN_PAD;
    const minZ = b.minZ - NEAR_TERRAIN_PAD;
    const w = Math.ceil((b.maxX - b.minX + NEAR_TERRAIN_PAD * 2) / NEAR_TERRAIN_CELL) + 1;
    const h = Math.ceil((b.maxZ - b.minZ + NEAR_TERRAIN_PAD * 2) / NEAR_TERRAIN_CELL) + 1;
    const height = new Float32Array(w * h);
    const clearance = new Float32Array(w * h);
    const loc = surf.createLocateResult();
    for (let iz = 0; iz < h; iz++) {
      for (let ix = 0; ix < w; ix++) {
        const x = minX + ix * NEAR_TERRAIN_CELL;
        const z = minZ + iz * NEAR_TERRAIN_CELL;
        _v.set(x, 0, z);
        surf.locate(_v, loc);
        const idx = loc.index * 2 + (loc.lateral >= 0 ? 1 : 0);
        const paved = loc.width + surf.kerbWidth[idx] + surf.astroWidth[idx] + surf.runoffWidth[idx];
        clearance[iz * w + ix] = Math.abs(loc.lateral) - paved;
        height[iz * w + ix] = surf.heightAt(x, z);
      }
    }
    this._terrainInfo = { minX, minZ, w, h, cell: NEAR_TERRAIN_CELL, height, clearance };
    const material = this._terrainMaterial();
    const tile = this.ctx.materials.tileSize("grass", { u: 4, v: 4 });
    const uvScale = 1 / (tile.u * 2.5);
    const perX = Math.ceil((w - 1) / TERRAIN_CHUNKS);
    const perZ = Math.ceil((h - 1) / TERRAIN_CHUNKS);
    for (let cz = 0; cz < TERRAIN_CHUNKS; cz++) {
      for (let cx = 0; cx < TERRAIN_CHUNKS; cx++) {
        const acc = new MeshAccum();
        const x0 = cx * perX;
        const z0 = cz * perZ;
        const x1 = Math.min(w - 1, x0 + perX);
        const z1 = Math.min(h - 1, z0 + perZ);
        for (let iz = z0; iz < z1; iz++) {
          for (let ix = x0; ix < x1; ix++) {
            const c00 = clearance[iz * w + ix];
            const c10 = clearance[iz * w + ix + 1];
            const c01 = clearance[(iz + 1) * w + ix];
            const c11 = clearance[(iz + 1) * w + ix + 1];
            if (Math.max(c00, c10, c01, c11) < CORRIDOR_HOLE) continue;
            const px = minX + ix * NEAR_TERRAIN_CELL;
            const pz = minZ + iz * NEAR_TERRAIN_CELL;
            const s = NEAR_TERRAIN_CELL;
            const y00 = height[iz * w + ix];
            const y10 = height[iz * w + ix + 1];
            const y01 = height[(iz + 1) * w + ix];
            const y11 = height[(iz + 1) * w + ix + 1];
            const n = [-(y10 - y00) / s, 1, -(y01 - y00) / s];
            const nl = Math.hypot(n[0], n[1], n[2]);
            n[0] /= nl;
            n[1] /= nl;
            n[2] /= nl;
            acc.quad(
              [px, y00, pz],
              [px + s, y10, pz],
              [px + s, y11, pz + s],
              [px, y01, pz + s],
              n,
              px * uvScale,
              pz * uvScale,
              (px + s) * uvScale,
              (pz + s) * uvScale
            );
          }
        }
        if (!acc.idx.length) continue;
        const geo = acc.toGeometry();
        this._geometries.push(geo);
        const mesh = new THREE.Mesh(geo, material);
        mesh.name = `terrain_${cx}_${cz}`;
        mesh.receiveShadow = true;
        this.group.add(mesh);
      }
    }
  }
  _terrainMaterial() {
    if (this._terrainMat) return this._terrainMat;
    const mat = this.ctx.materials.clone("grass");
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = 2;
    mat.polygonOffsetUnits = 6;
    mat.name = "terrain";
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace("#include <map_fragment>", `#include <map_fragment>
#ifdef USE_MAP
  float grassLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.702, 1.160, 0.301 ) * grassLum, 0.55 );

  float mowAxis = ( vMapUv.x * 0.94 + vMapUv.y * 0.34 );
  float mowBand = smoothstep( -0.22, 0.22, sin( mowAxis * 9.0 ) );
  float mowBlock = 0.55 + 0.45 * smoothstep( -0.3, 0.3, sin( mowAxis * 0.62 + vMapUv.y * 0.9 ) );
  float mow = mix( 0.845, 1.175, mowBand ) * mowBlock + ( 1.0 - mowBlock );
  float mowPatch = 1.0 + 0.055 * sin( vMapUv.x * 0.63 + 1.3 ) * sin( vMapUv.y * 0.47 + 2.1 );
  float mowFade = 1.0 - smoothstep( 260.0, 900.0, length( vViewPosition ) );
  diffuseColor.rgb *= mix( 1.0, mow, mowFade ) * mowPatch;
#endif`);
    };
    mat.customProgramCacheKey = () => "terrainMownV2";
    mat.needsUpdate = true;
    this._terrainMat = mat;
    return mat;
  }
  _buildFarTerrain() {
    const surf = this.surface;
    const b = surf.bounds;
    const cx = (b.minX + b.maxX) * 0.5;
    const cz = (b.minZ + b.maxZ) * 0.5;
    const inner = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.5 + NEAR_TERRAIN_PAD - 60;
    const radial = 128;
    const rings = 26;
    const acc = new MeshAccum();
    const tile = this.ctx.materials.tileSize("grass", { u: 4, v: 4 });
    const uvScale = 1 / (tile.u * 6);
    const pointAt = (r, a) => {
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      const fade = smoothstep(inner, FAR_RADIUS * 0.55, r);
      const y = surf.terrainHeightAt(x, z) * (1 - fade * 0.35) - fade * 26;
      return [x, y, z];
    };
    for (let ring = 0; ring < rings; ring++) {
      const f0 = ring / rings;
      const f1 = (ring + 1) / rings;
      const r0 = inner + (FAR_RADIUS - inner) * f0 * f0;
      const r1 = inner + (FAR_RADIUS - inner) * f1 * f1;
      for (let a = 0; a < radial; a++) {
        const a0 = a / radial * Math.PI * 2;
        const a1 = (a + 1) / radial * Math.PI * 2;
        const p0 = pointAt(r0, a0);
        const p1 = pointAt(r0, a1);
        const p2 = pointAt(r1, a1);
        const p3 = pointAt(r1, a0);
        acc.quad(
          p0,
          p1,
          p2,
          p3,
          [0, 1, 0],
          p0[0] * uvScale,
          p0[2] * uvScale,
          p2[0] * uvScale,
          p2[2] * uvScale
        );
      }
    }
    const geo = acc.toGeometry();
    geo.computeVertexNormals();
    this._geometries.push(geo);
    const mesh = new THREE.Mesh(geo, this._terrainMaterial());
    mesh.name = "terrainFar";
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this._farInner = inner;
    this._centre = { x: cx, z: cz };
  }
  _sweepProfile(from, to, side, offset, profile, material, name, uScale, vScale, castShadow) {
    const surf = this.surface;
    let end = to;
    while (end < from) end += surf.length;
    const rows = Math.max(2, Math.ceil((end - from) / 8));
    const cols = profile.length;
    const positions = new Float32Array((rows + 1) * cols * 3);
    const normals = new Float32Array((rows + 1) * cols * 3);
    const uvs = new Float32Array((rows + 1) * cols * 2);
    const indices = [];
    const loc = surf.createLocateResult();
    for (let r = 0; r <= rows; r++) {
      const d = from + (end - from) * r / rows;
      surf.sample((d % surf.length + surf.length) % surf.length / surf.length, loc);
      const lateral = side * offset;
      const bx = loc.position.x + loc.right.x * lateral;
      const bz = loc.position.z + loc.right.z * lateral;
      const by = surf.heightAt(bx, bz);
      for (let c = 0; c < cols; c++) {
        const across = side * profile[c][0];
        const vi = (r * cols + c) * 3;
        positions[vi] = bx + loc.right.x * across;
        positions[vi + 1] = by + profile[c][1];
        positions[vi + 2] = bz + loc.right.z * across;
        const cp = Math.max(0, c - 1);
        const cn = Math.min(cols - 1, c + 1);
        const dd = profile[cn][0] - profile[cp][0];
        const dh = profile[cn][1] - profile[cp][1];
        const pl = Math.hypot(dd, dh) || 1;
        const nAcross = dh / pl * -side;
        const nUp = -dd / pl * -1;
        normals[vi] = loc.right.x * nAcross;
        normals[vi + 1] = nUp;
        normals[vi + 2] = loc.right.z * nAcross;
        const ui = (r * cols + c) * 2;
        uvs[ui] = (d - from) * uScale;
        uvs[ui + 1] = profile[c][1] * vScale;
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        pushQuad(indices, positions, normals, a, a + 1, a + cols, a + cols + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    this._geometries.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = name;
    mesh.castShadow = !!castShadow;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }
  _makePath(n) {
    return {
      n,
      x: new Float64Array(n),
      y: new Float64Array(n),
      z: new Float64Array(n),
      ox: new Float64Array(n),
      oz: new Float64Array(n),
      tx: new Float64Array(n),
      tz: new Float64Array(n),
      d: new Float64Array(n)
    };
  }
  _copyStation(src, i, dst, j) {
    dst.x[j] = src.x[i];
    dst.y[j] = src.y[i];
    dst.z[j] = src.z[i];
    dst.ox[j] = src.ox[i];
    dst.oz[j] = src.oz[i];
    dst.tx[j] = src.tx[i];
    dst.tz[j] = src.tz[i];
    dst.d[j] = src.d[i];
  }
  _trackPath(from, to, side, offset, step) {
    const surf = this.surface;
    let end = to;
    while (end < from) end += surf.length;
    const n = Math.max(2, Math.ceil((end - from) / step) + 1);
    const path = this._makePath(n);
    const loc = surf.createLocateResult();
    for (let i = 0; i < n; i++) {
      const dist = from + (end - from) * i / (n - 1);
      surf.sample((dist % surf.length + surf.length) % surf.length / surf.length, loc);
      const lateral = side * offset;
      const px = loc.position.x + loc.right.x * lateral;
      const pz = loc.position.z + loc.right.z * lateral;
      path.x[i] = px;
      path.z[i] = pz;
      path.y[i] = surf.heightAt(px, pz);
      path.ox[i] = loc.right.x * side;
      path.oz[i] = loc.right.z * side;
      path.tx[i] = loc.tangent.x;
      path.tz[i] = loc.tangent.z;
      path.d[i] = dist - from;
    }
    return path;
  }
  _runPath(run) {
    const m = run.points.length / 3;
    const path = this._makePath(m);
    let along = 0;
    for (let i = 0; i < m; i++) {
      const x = run.points[i * 3];
      const z = run.points[i * 3 + 2];
      if (i > 0) {
        along += Math.hypot(x - run.points[(i - 1) * 3], z - run.points[(i - 1) * 3 + 2]);
      }
      const ia = Math.max(0, i - 1);
      const ib = Math.min(m - 1, i + 1);
      let tx = run.points[ib * 3] - run.points[ia * 3];
      let tz = run.points[ib * 3 + 2] - run.points[ia * 3 + 2];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl;
      tz /= tl;
      path.x[i] = x;
      path.y[i] = run.points[i * 3 + 1];
      path.z[i] = z;
      path.tx[i] = tx;
      path.tz[i] = tz;
      path.ox[i] = -tz * run.side;
      path.oz[i] = tx * run.side;
      path.d[i] = along;
    }
    return path;
  }
  _sweepPath(acc, path, profile, uScale, vScale, flipU = false, vBias = 0) {
    const cols = profile.length;
    const pv = new Float64Array(cols);
    for (let c = 1; c < cols; c++) {
      pv[c] = pv[c - 1] + Math.hypot(profile[c][0] - profile[c - 1][0], profile[c][1] - profile[c - 1][1]);
    }
    const total = path.d[path.n - 1];
    const a = [0, 0, 0], b = [0, 0, 0], cc = [0, 0, 0], d = [0, 0, 0], nrm = [0, 0, 0];
    const put = (out, r, c) => {
      const lat = profile[c][0];
      out[0] = path.x[r] + path.ox[r] * lat;
      out[1] = path.y[r] + profile[c][1];
      out[2] = path.z[r] + path.oz[r] * lat;
      return out;
    };
    for (let r = 0; r < path.n - 1; r++) {
      const u0 = (flipU ? total - path.d[r] : path.d[r]) * uScale;
      const u1 = (flipU ? total - path.d[r + 1] : path.d[r + 1]) * uScale;
      for (let c = 0; c < cols - 1; c++) {
        const dd = profile[c + 1][0] - profile[c][0];
        const dh = profile[c + 1][1] - profile[c][1];
        const pl = Math.hypot(dd, dh);
        if (pl < 1e-6) continue;
        nrm[0] = path.ox[r] * (-dh / pl);
        nrm[1] = dd / pl;
        nrm[2] = path.oz[r] * (-dh / pl);
        acc.quad(
          put(a, r, c),
          put(b, r + 1, c),
          put(cc, r + 1, c + 1),
          put(d, r, c + 1),
          nrm,
          u0,
          vBias + pv[c] * vScale,
          u1,
          vBias + pv[c + 1] * vScale
        );
      }
    }
  }
  _capPath(acc, path, profile, r, sign, uvScale) {
    const nrm = [path.tx[r] * sign, 0, path.tz[r] * sign];
    const a = [0, 0, 0], b = [0, 0, 0], c2 = [0, 0, 0], d = [0, 0, 0];
    for (let c = 0; c < profile.length - 1; c++) {
      const l0 = profile[c][0], h0 = profile[c][1];
      const l1 = profile[c + 1][0], h1 = profile[c + 1][1];
      if (Math.abs(l1 - l0) < 1e-4 || h0 < 1e-4 && h1 < 1e-4) continue;
      a[0] = path.x[r] + path.ox[r] * l0;
      a[1] = path.y[r];
      a[2] = path.z[r] + path.oz[r] * l0;
      b[0] = path.x[r] + path.ox[r] * l1;
      b[1] = path.y[r];
      b[2] = path.z[r] + path.oz[r] * l1;
      c2[0] = b[0];
      c2[1] = path.y[r] + h1;
      c2[2] = b[2];
      d[0] = a[0];
      d[1] = path.y[r] + h0;
      d[2] = a[2];
      acc.quad(a, b, c2, d, nrm, l0 * uvScale, 0, l1 * uvScale, Math.max(h0, h1) * uvScale);
    }
  }
  _endQuad(acc, path, r, sign, pts) {
    const nrm = [path.tx[r] * sign, 0, path.tz[r] * sign];
    const w = [0, 1, 2, 3].map((i) => [
      path.x[r] + path.ox[r] * pts[i][0],
      path.y[r] + pts[i][1],
      path.z[r] + path.oz[r] * pts[i][0]
    ]);
    acc.quad(w[0], w[1], w[2], w[3], nrm, 0, 0, 1, 1);
  }
  _instancesAlong(path, spacing, height, lateral, sx, sy, sz, out) {
    let carry = spacing * 0.5;
    for (let i = 0; i < path.n - 1; i++) {
      const segLen = path.d[i + 1] - path.d[i];
      if (segLen <= 1e-4) continue;
      let s = carry;
      while (s < segLen) {
        const f = s / segLen;
        const x = path.x[i] + (path.x[i + 1] - path.x[i]) * f + path.ox[i] * lateral;
        const z = path.z[i] + (path.z[i + 1] - path.z[i]) * f + path.oz[i] * lateral;
        const y = path.y[i] + (path.y[i + 1] - path.y[i]) * f;
        _v.set(x, y + height, z);
        _q.setFromAxisAngle(_axis, -Math.atan2(path.tx[i], -path.tz[i]));
        _scale.set(sx, sy, sz);
        _m.compose(_v, _q, _scale);
        out.push(_m.clone());
        s += spacing;
      }
      carry = s - segLen;
    }
  }
  _buildGrandstands() {
    const materials = this.ctx.materials;
    const shell = new MeshAccum();
    const inner = new MeshAccum();
    const fascia = this._signs;
    const columns = [];
    const beams = [];
    const crowd = { matrices: [], data: [], shade: [] };
    const detail = clamp01(this.tier?.crowdDetail ?? 1);
    for (const stand of this.track.circuit.grandstands) {
      this._buildStand(stand, shell, inner, fascia, columns, beams, crowd, detail);
    }
    this._addMerged(shell, materials.get("grandstand"), "standShell", true);
    this._addMerged(inner, this._standInteriorMaterial(), "standInterior", false);
    if (columns.length) {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      this._geometries.push(geo);
      this._instance(geo, this._standInteriorMaterial(), columns, "standColumns", true);
    }
    if (beams.length) {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      this._geometries.push(geo);
      this._instance(geo, this._standBeamMaterial(), beams, "standRoofBeams", false);
    }
    this._collectBankCrowd(crowd, detail);
    if (crowd.matrices.length) this._buildCrowd(crowd);
  }
  _standInteriorMaterial() {
    if (this._standInner) return this._standInner;
    const mat = this.ctx.materials.clone("concrete");
    mat.color.setHex(4540236);
    mat.roughness = 1;
    mat.side = THREE.DoubleSide;
    mat.name = "stand_interior";
    this._standInner = mat;
    return mat;
  }
  _standBeamMaterial() {
    if (this._standBeam) return this._standBeam;
    const mat = this.ctx.materials.clone("metal_anodised");
    mat.color.setHex(3027254);
    mat.roughness = 0.72;
    mat.name = "stand_truss";
    this._standBeam = mat;
    return mat;
  }
  _buildStand(stand, shell, inner, fascia, columns, beams, crowd, detail) {
    const rows = stand.rows;
    const offset = stand.offset + STAND_SETBACK;
    const flipU = stand.side > 0;
    const path = this._trackPath(stand.from, stand.to, stand.side, offset, STAND_STATION);
    const frame = this._trackPath(stand.from, stand.to, stand.side, offset, STAND_FRAME_STATION);
    const depth = rows * STAND_TREAD;
    const backLat = STAND_WALK + depth + 1.4;
    const deckTop = STAND_FRONT + rows * STAND_RISER;
    const roofFrontLat = STAND_WALK + depth * 0.34;
    const roofBackLat = backLat + 0.9;
    const roofFrontY = deckTop + STAND_ROOF_CLEAR;
    const roofBackY = roofFrontY + 0.6;
    const rake = [[0, STAND_FRONT], [STAND_WALK, STAND_FRONT]];
    for (let r = 0; r < rows; r++) {
      rake.push([STAND_WALK + r * STAND_TREAD, STAND_FRONT + (r + 1) * STAND_RISER]);
      rake.push([STAND_WALK + (r + 1) * STAND_TREAD, STAND_FRONT + (r + 1) * STAND_RISER]);
    }
    rake.push([backLat, deckTop]);
    this._sweepPath(inner, path, rake, 1 / 6, 1 / 3);
    this._sweepPath(shell, path, [[0, 0], [0, STAND_FRONT]], 1 / 6, 1 / 3);
    this._sweepPath(shell, path, [[backLat, deckTop], [backLat, roofBackY - 0.75]], 1 / 6, 1 / 3);
    this._sweepPath(inner, path, [[roofFrontLat, roofFrontY], [roofBackLat, roofBackY]], 1 / 6, 1 / 6);
    this._sweepPath(shell, path, [[roofFrontLat, roofFrontY - 0.75], [roofFrontLat, roofFrontY]], 1 / 6, 1 / 3);
    this._sweepPath(shell, path, [[roofBackLat, roofBackY], [roofBackLat, roofBackY - 0.6]], 1 / 6, 1 / 3);
    this._sweepPath(inner, path, [[roofBackLat, roofBackY - 0.6], [roofFrontLat, roofFrontY - 0.75]], 1 / 6, 1 / 3);
    const outline = [[0, 0]].concat(rake, [[backLat, roofBackY - 0.75]]);
    this._capPath(inner, path, outline, 0, -1, 1 / 6);
    this._capPath(inner, path, outline, path.n - 1, 1, 1 / 6);
    const roofEnd = [
      [roofFrontLat, roofFrontY - 0.75],
      [roofBackLat, roofBackY - 0.6],
      [roofBackLat, roofBackY],
      [roofFrontLat, roofFrontY]
    ];
    this._endQuad(shell, path, 0, -1, roofEnd);
    this._endQuad(shell, path, path.n - 1, 1, roofEnd);
    const boardRows = this._signMaterial().userData.rows;
    const bandV = 1 / boardRows;
    const board = this._makePath(2);
    const fasciaProfile = [
      [-0.06, 0.411],
      [-0.2, 0.55],
      [-0.2, 1.95],
      [-0.06, 2.089]
    ];
    let fasciaLength = 0;
    for (let c = 1; c < fasciaProfile.length; c++) {
      fasciaLength += Math.hypot(
        fasciaProfile[c][0] - fasciaProfile[c - 1][0],
        fasciaProfile[c][1] - fasciaProfile[c - 1][1]
      );
    }
    for (let r = 0; r < path.n - 1; r++) {
      this._copyStation(path, r, board, 0);
      this._copyStation(path, r + 1, board, 1);
      board.d[0] = 0;
      board.d[1] = path.d[r + 1] - path.d[r];
      const row = this.rng.int(0, boardRows - 1);
      this._sweepPath(
        fascia,
        board,
        fasciaProfile,
        1 / (board.d[1] || 1),
        bandV / fasciaLength,
        flipU,
        row * bandV
      );
    }
    this._instancesAlong(
      frame,
      STAND_FRAME_STATION * 2,
      roofBackY * 0.5,
      backLat + 0.5,
      0.42,
      roofBackY,
      0.42,
      columns
    );
    const beamSpan = roofBackLat - roofFrontLat;
    this._instancesAlong(
      frame,
      STAND_FRAME_STATION * 2,
      roofFrontY - 1.1,
      (roofFrontLat + roofBackLat) * 0.5,
      beamSpan,
      0.55,
      0.28,
      beams
    );
    this._collectCrowd(stand, offset, detail, crowd);
  }
  _collectCrowd(stand, offset, detail, crowd) {
    const surf = this.surface;
    const loc = surf.createLocateResult();
    const rng = this.rng;
    const rows = stand.rows;
    let span = stand.to - stand.from;
    while (span < 0) span += surf.length;
    const colPitch = CROWD_CELL_W / clamp(detail, 0.34, 1);
    const cols = Math.max(2, Math.round(span / colPitch));
    const rowStep = detail >= 0.9 ? 1 : detail >= 0.45 ? 2 : 3;
    const atlas = this.ctx.materials.get("crowd").userData.atlas ?? { cols: 4, rows: 4 };
    const cells = atlas.cols * atlas.rows;
    for (let j = 0; j < cols; j++) {
      const d = stand.from + span * (j + 0.5) / cols;
      surf.sample((d % surf.length + surf.length) % surf.length / surf.length, loc);
      const baseX = loc.position.x + loc.right.x * stand.side * offset;
      const baseZ = loc.position.z + loc.right.z * stand.side * offset;
      const baseY = surf.heightAt(baseX, baseZ);
      for (let r = 0; r < rows; r += rowStep) {
        if (rng.next() < 0.055) continue;
        const lateral = stand.side * (offset + STAND_WALK + (r + 0.62) * STAND_TREAD);
        const jitter = rng.signed(0.09);
        const x = loc.position.x + loc.right.x * lateral + loc.tangent.x * jitter;
        const z = loc.position.z + loc.right.z * lateral + loc.tangent.z * jitter;
        const y = baseY + STAND_FRONT + (r + 1) * STAND_RISER + CROWD_CELL_H * 0.5 - 0.12;
        _v.set(x, y, z);
        _q.identity();
        _scale.set(1, 1, 1);
        _m.compose(_v, _q, _scale);
        crowd.matrices.push(_m.clone());
        const cell = rng.int(0, cells - 1);
        crowd.data.push(
          cell % atlas.cols / atlas.cols,
          Math.floor(cell / atlas.cols) / atlas.rows,
          rng.next(),
          0.95 + rng.next() * 0.11
        );
        const depthF = rows > 1 ? r / (rows - 1) : 0;
        const lit = (0.8 + rng.next() * 0.2) * (1 - 0.32 * smoothstep(0.3, 1, depthF));
        crowd.shade.push(lit * (1 + rng.signed(0.04)), lit, lit * (1 + rng.signed(0.04)));
      }
    }
  }
  _buildCrowd(crowd) {
    const geo = new THREE.PlaneGeometry(CROWD_CELL_W, CROWD_CELL_H);
    this._geometries.push(geo);
    const atlas = this.ctx.materials.get("crowd").userData.atlas ?? { cols: 4, rows: 4 };
    const material = this.ctx.materials.clone("crowd");
    material.name = "crowd_instanced";
    const time = this._time;
    const cols = atlas.cols;
    const rows = atlas.rows;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = time;
      shader.vertexShader = shader.vertexShader.replace("#include <common>", `#include <common>
uniform float uTime;
attribute vec4 aCrowd;
varying float vCrowdFade;`).replace("#include <uv_vertex>", `#include <uv_vertex>
#ifdef USE_MAP
  vMapUv = vMapUv * vec2(${(1 / cols).toFixed(6)}, ${(1 / rows).toFixed(6)}) + aCrowd.xy;
#endif`).replace("#include <project_vertex>", `
vec4 crowdCentre = instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
crowdCentre = modelViewMatrix * crowdCentre;
float crowdBob = sin( uTime * ( 1.7 + aCrowd.z ) + aCrowd.z * 31.4 ) * 0.032;
float crowdSway = sin( uTime * ( 0.8 + aCrowd.z * 0.6 ) + aCrowd.z * 17.3 ) * 0.05;
vec4 mvPosition = crowdCentre + vec4(
  ( transformed.x + crowdSway * transformed.y ) * aCrowd.w,
  ( transformed.y + crowdBob ) * aCrowd.w, 0.0, 0.0 );
vCrowdFade = smoothstep( 45.0, 240.0, -crowdCentre.z );
gl_Position = projectionMatrix * mvPosition;`).replace("#include <defaultnormal_vertex>", `
vec3 transformedNormal = normalize( vec3( 0.0, 0.45, 0.89 ) );`);
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying float vCrowdFade;").replace("#include <map_fragment>", `#include <map_fragment>
float crowdLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
vec3 crowdFar = mix( vec3( crowdLum ), vec3( 0.160, 0.150, 0.138 ), 0.62 ) * 0.88;
diffuseColor.rgb = mix( diffuseColor.rgb, crowdFar, vCrowdFade * 0.92 );`).replace("#include <alphatest_fragment>", `
if ( diffuseColor.a < mix( 0.42, 0.14, vCrowdFade ) ) discard;`);
    };
    material.customProgramCacheKey = () => "crowdBillboardV2";
    material.needsUpdate = true;
    const count = crowd.matrices.length;
    const mesh = new THREE.InstancedMesh(geo, material, count);
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, crowd.matrices[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.geometry.setAttribute(
      "aCrowd",
      new THREE.InstancedBufferAttribute(new Float32Array(crowd.data), 4)
    );
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(crowd.shade), 3);
    mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.name = "crowd";
    this.group.add(mesh);
    this._crowd = mesh;
  }
  _addMerged(acc, material, name, castShadow, receiveShadow = true) {
    if (!acc.idx.length) return null;
    const geo = acc.toGeometry();
    this._geometries.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = name;
    mesh.castShadow = !!castShadow;
    mesh.receiveShadow = !!receiveShadow;
    this.group.add(mesh);
    return mesh;
  }
  _spectatorBanks() {
    if (this._banks) return this._banks;
    const surf = this.surface;
    const loc = surf.createLocateResult();
    const scale = surf.length / this.track.layout.analyticLength;
    const banks = [];
    for (const c of this.track.circuit.clearings) {
      const centre = (c.at * scale % surf.length + surf.length) % surf.length;
      let taken = 0;
      for (const stand of this.track.circuit.grandstands) {
        const from = stand.from * scale;
        let to = stand.to * scale;
        while (to < from) to += surf.length;
        let at = centre;
        while (at < from) at += surf.length;
        if (at <= to + 60) {
          taken = stand.side;
          break;
        }
      }
      const side = taken !== 0 ? -taken : banks.length % 2 === 0 ? 1 : -1;
      surf.sample(centre / surf.length, loc);
      _v.copy(loc.position);
      surf.locate(_v, loc);
      const idx = loc.index * 2 + (side > 0 ? 1 : 0);
      const offset = loc.width + surf.kerbWidth[idx] + surf.astroWidth[idx] + Math.min(34, surf.runoffWidth[idx]) + 5;
      const span = Math.min(c.radius * 1.15, 175);
      banks.push({
        side,
        offset,
        from: centre - span * 0.5,
        to: centre + span * 0.5,
        span
      });
    }
    this._banks = banks;
    return banks;
  }
  _bankProfile() {
    if (this._bankSection) return this._bankSection;
    const profile = [[0, 0]];
    let lat = 1.8;
    let hgt = 0;
    for (let r = 0; r < BANK_ROWS; r++) {
      hgt += BANK_RISE;
      profile.push([lat, hgt]);
      lat += BANK_TREAD;
      profile.push([lat, hgt]);
    }
    profile.push([lat + 5, hgt + 0.5]);
    profile.push([lat + 13, hgt + 0.2]);
    this._bankSection = profile;
    return profile;
  }
  _buildSpectatorAreas() {
    const banks = this._spectatorBanks();
    if (!banks.length) return;
    const profile = this._bankProfile();
    const earth = new MeshAccum();
    const units = new MeshAccum();
    const rng = new Rng(1102567682);
    for (const bank of banks) {
      const path = this._trackPath(bank.from, bank.to, bank.side, bank.offset, 10);
      this._sweepPath(earth, path, profile, 1 / 6, 1 / 6);
      this._capPath(earth, path, profile, 0, -1, 1 / 6);
      this._capPath(earth, path, profile, path.n - 1, 1, 1 / 6);
      this._collectCompound(units, path, profile, rng);
    }
    this._addMerged(earth, this._bankMaterial(), "spectatorBanks", false, true);
    this._addMerged(units, this._compoundMaterial(), "spectatorCompound", false, true);
  }
  _collectCompound(acc, path, profile, rng) {
    const crest = profile[profile.length - 1];
    const back = crest[0] + 3;
    const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0], d = [0, 0, 0], nrm = [0, 0, 0];
    const put = (out, r, lat, h) => {
      out[0] = path.x[r] + path.ox[r] * lat;
      out[1] = path.y[r] + h;
      out[2] = path.z[r] + path.oz[r] * lat;
      return out;
    };
    const total = path.d[path.n - 1];
    let along = 12 + rng.next() * 22;
    while (along < total - 16) {
      const length = 8 + rng.next() * 8;
      let r0 = 0;
      while (r0 < path.n - 2 && path.d[r0 + 1] < along) r0++;
      let r1 = r0;
      while (r1 < path.n - 1 && path.d[r1] < along + length) r1++;
      if (r1 <= r0) {
        along += length + 6;
        continue;
      }
      const width = 6 + rng.next() * 3.5;
      const eaves = crest[1] + 2.15 + rng.next() * 0.5;
      const ridge = eaves + 1.15 + rng.next() * 0.6;
      const near = back;
      const far = back + width;
      const mid = (near + far) * 0.5;
      for (const [lat, sign] of [[near, -1], [far, 1]]) {
        nrm[0] = path.ox[r0] * sign;
        nrm[1] = 0;
        nrm[2] = path.oz[r0] * sign;
        acc.quad(
          put(a, r0, lat, 0),
          put(b, r1, lat, 0),
          put(c, r1, lat, eaves),
          put(d, r0, lat, eaves),
          nrm,
          0,
          0,
          length * 0.25,
          eaves * 0.25
        );
      }
      for (const [r, sign] of [[r0, -1], [r1, 1]]) {
        nrm[0] = path.tx[r] * sign;
        nrm[1] = 0;
        nrm[2] = path.tz[r] * sign;
        acc.quad(
          put(a, r, near, 0),
          put(b, r, far, 0),
          put(c, r, far, eaves),
          put(d, r, near, eaves),
          nrm,
          0,
          0,
          width * 0.25,
          eaves * 0.25
        );
        acc.quad(
          put(a, r, near, eaves),
          put(b, r, far, eaves),
          put(c, r, mid, ridge),
          put(d, r, mid, ridge),
          nrm,
          0,
          0,
          width * 0.25,
          0.4
        );
      }
      for (const [lat, sign] of [[near, -1], [far, 1]]) {
        const rise = ridge - eaves;
        const run = width * 0.5;
        const inv = 1 / Math.hypot(rise, run);
        nrm[0] = path.ox[r0] * sign * (rise * inv);
        nrm[1] = run * inv;
        nrm[2] = path.oz[r0] * sign * (rise * inv);
        acc.quad(
          put(a, r0, lat, eaves),
          put(b, r1, lat, eaves),
          put(c, r1, mid, ridge),
          put(d, r0, mid, ridge),
          nrm,
          0,
          0,
          length * 0.25,
          run * 0.25
        );
      }
      along += length + 16 + rng.next() * 30;
    }
  }
  _bankMaterial() {
    if (this._bankMat) return this._bankMat;
    const mat = this.ctx.materials.clone("grass");
    mat.color.setHex(9078132);
    mat.roughness = 1;
    mat.envMapIntensity = 0.75;
    mat.name = "spectator_bank";
    this._bankMat = mat;
    return mat;
  }
  _compoundMaterial() {
    if (this._compoundMat) return this._compoundMat;
    const mat = this.ctx.materials.clone("concrete");
    mat.color.setHex(11118236);
    mat.roughness = 0.92;
    mat.envMapIntensity = 0.85;
    mat.name = "spectator_compound";
    this._compoundMat = mat;
    return mat;
  }
  _collectBankCrowd(crowd, detail) {
    const banks = this._spectatorBanks();
    if (!banks.length) return;
    const surf = this.surface;
    const loc = surf.createLocateResult();
    const rng = this.rng;
    const atlas = this.ctx.materials.get("crowd").userData.atlas ?? { cols: 4, rows: 4 };
    const cells = atlas.cols * atlas.rows;
    const colPitch = CROWD_CELL_W / clamp(detail, 0.34, 1);
    const rowStep = detail >= 0.9 ? 1 : detail >= 0.45 ? 2 : 3;
    for (const bank of banks) {
      const cols = Math.max(2, Math.round(bank.span / colPitch));
      for (let j = 0; j < cols; j++) {
        const d = bank.from + bank.span * (j + 0.5) / cols;
        surf.sample((d % surf.length + surf.length) % surf.length / surf.length, loc);
        const baseX = loc.position.x + loc.right.x * bank.side * bank.offset;
        const baseZ = loc.position.z + loc.right.z * bank.side * bank.offset;
        const baseY = surf.heightAt(baseX, baseZ);
        for (let r = 0; r < BANK_ROWS; r += rowStep) {
          if (rng.next() < 0.34) continue;
          const lateral = bank.side * (bank.offset + 1.8 + (r + 0.55) * BANK_TREAD);
          const jitter = rng.signed(0.45);
          const x = loc.position.x + loc.right.x * lateral + loc.tangent.x * jitter;
          const z = loc.position.z + loc.right.z * lateral + loc.tangent.z * jitter;
          const y = baseY + (r + 1) * BANK_RISE + CROWD_CELL_H * 0.5 - 0.1;
          _v.set(x, y, z);
          _q.identity();
          _scale.set(1, 1, 1);
          _m.compose(_v, _q, _scale);
          crowd.matrices.push(_m.clone());
          const cell = rng.int(0, cells - 1);
          crowd.data.push(
            cell % atlas.cols / atlas.cols,
            Math.floor(cell / atlas.cols) / atlas.rows,
            rng.next(),
            0.95 + rng.next() * 0.11
          );
          const lit = 0.9 + rng.next() * 0.16;
          crowd.shade.push(lit * (1 + rng.signed(0.04)), lit, lit * (1 + rng.signed(0.04)));
        }
      }
    }
  }
  _buildPitComplex() {
    const materials = this.ctx.materials;
    const pitMat = materials.get("pit_building");
    const spec = this.track.circuit.pitLane;
    const from = spec.buildingFrom;
    const to = spec.buildingTo;
    const outer = spec.buildingOffset;
    this._sweepProfile(from, to, 1, outer, [
      [0, 0],
      [0, 4.4],
      [1.2, 5],
      [1.2, 9.6],
      [0.4, 10.2],
      [0.4, 10.6],
      [9, 10.6]
    ], pitMat, "pitBuilding", 1 / 8, 1 / 4, true);
    const doorMat = materials.clone("metal_anodised");
    doorMat.color.setHex(2369068);
    doorMat.roughness = 0.5;
    doorMat.name = "garage_door";
    this._sweepProfile(from, to, 1, outer - 0.35, [
      [0, 0.15],
      [0, 4.1],
      [0.3, 4.3]
    ], doorMat, "pitGarages", 1 / 4, 1 / 4, false);
    const wallMat = materials.get("concrete");
    this._sweepProfile(from, to, 1, spec.pitWallOffset, [
      [0, 0],
      [0, 1.05],
      [0.35, 1.12],
      [0.35, 0]
    ], wallMat, "pitWall", 1 / 4, 1 / 2, true);
  }
  _buildFences() {
    const runs = this.track._barriers?.runs ?? [];
    const panels = new MeshAccum();
    const rails = this._steel;
    const postMatrices = [];
    const railTop = FENCE_FOOT + FENCE_HEIGHT;
    const mesh = this._fenceMeshMaterial();
    const tileU = mesh.userData.tileU;
    const tileV = mesh.userData.tileV;
    for (const run of runs) {
      if (run.type === "tyre") continue;
      if (run.points.length / 3 < 4) continue;
      const path = this._runPath(run);
      this._sweepPath(panels, path, [[0, FENCE_FOOT], [0, FENCE_RAIL_MID]], 1 / tileU, 1 / tileV);
      this._sweepPath(panels, path, [[0, FENCE_RAIL_MID], [0, railTop]], 1 / tileU, 1 / tileV);
      this._fenceRail(rails, path, railTop, 0.075);
      this._fenceRail(rails, path, FENCE_RAIL_MID, 0.055);
      this._fenceRail(rails, path, FENCE_FOOT, 0.055);
      this._instancesAlong(path, FENCE_POST_SPACING, 0, 0, 1, 1, 1, postMatrices);
    }
    this._addMerged(panels, mesh, "catchFence", false, false);
    if (postMatrices.length) {
      this._instance(
        this._fencePostGeometry(),
        this._fenceRailMaterial(),
        postMatrices,
        "fencePosts",
        false
      );
    }
  }
  _fenceRail(acc, path, height, half) {
    this._sweepPath(acc, path, [
      [-0.06, height - half],
      [-0.06, height + half],
      [0.06, height + half],
      [0.06, height - half]
    ], 1 / 1.5, 1 / 0.25);
  }
  _fencePostGeometry() {
    if (this._fencePost) return this._fencePost;
    const acc = new MeshAccum();
    const h = FENCE_HEIGHT + FENCE_FOOT - 0.1;
    const cy = 0.35 + h * 0.5;
    acc.box(-0.055, cy, 0, 0.018, h, 0.13, 0, 1.5);
    acc.box(0.055, cy, 0, 0.018, h, 0.13, 0, 1.5);
    acc.box(0, cy, 0, 0.092, h, 0.02, 0, 1.5);
    acc.box(0, 0.3, 0, 0.24, 0.1, 0.24, 0, 1.5);
    const geo = acc.toGeometry();
    this._geometries.push(geo);
    this._fencePost = geo;
    return geo;
  }
  _fenceMeshMaterial() {
    if (this._fenceMesh) return this._fenceMesh;
    const aniso = this._maxAnisotropy();
    const td = buildCatchFence(512, 3131);
    const map = makeDataTexture(td.color, td.width, td.height, THREE.SRGBColorSpace, td.colorMips);
    const normalMap = makeDataTexture(td.normal, td.width, td.height, THREE.NoColorSpace);
    const ormMap = makeDataTexture(td.orm, td.width, td.height, THREE.NoColorSpace);
    ormMap.channel = 0;
    for (const t of [map, normalMap, ormMap]) {
      t.anisotropy = aniso;
      this._textures.push(t);
    }
    const mat = new THREE.MeshStandardMaterial({
      map,
      normalMap,
      roughnessMap: ormMap,
      metalnessMap: ormMap,
      aoMap: ormMap,
      roughness: 1,
      metalness: 0.42,
      alphaTest: 0.02,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      envMapIntensity: 1.25,
      name: "catch_fence_mesh"
    });
    mat.normalScale.set(1, 1);
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <map_fragment>",
        `#include <map_fragment>
        {
          float apexCosT = abs( dot( normalize( vNormal ), normalize( vViewPosition ) ) );
          float apexPath = 1.0 / max( apexCosT, ${FENCE_GRAZE_FLOOR.toFixed(3)} );
          diffuseColor.a = 1.0 - pow( max( 1.0 - diffuseColor.a, 0.0 ), apexPath );
        }`
      );
    };
    mat.customProgramCacheKey = () => "apex_fence_veil";
    mat.userData.tileU = td.tileU;
    mat.userData.tileV = td.tileV;
    this._materials.push(mat);
    this._fenceMesh = mat;
    return mat;
  }
  _fenceRailMaterial() {
    if (this._fenceRailMat) return this._fenceRailMat;
    const mat = this.ctx.materials.clone("metal_raw");
    mat.color.setHex(9278363);
    mat.roughness = 0.5;
    mat.metalness = 0.45;
    mat.envMapIntensity = 1.25;
    mat.name = "fence_rail";
    this._fenceRailMat = mat;
    return mat;
  }
  _maxAnisotropy() {
    if (this._aniso !== void 0) return this._aniso;
    const tierAniso = this.ctx.materials.anisotropy ?? 4;
    const cap = this.ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? tierAniso;
    this._aniso = Math.max(1, Math.min(cap, Math.max(4, tierAniso * 2)));
    return this._aniso;
  }
  _buildSponsorBoards() {
    const runs = this.track._barriers?.runs ?? [];
    const material = this._signMaterial();
    const rows = material.userData.rows;
    const acc = this._signs;
    const boardLength = 8;
    const board = this._makePath(2);
    const profile = SPONSOR_PROFILE;
    const mullions = [];
    let profileLength = 0;
    for (let c = 1; c < profile.length; c++) {
      profileLength += Math.hypot(profile[c][0] - profile[c - 1][0], profile[c][1] - profile[c - 1][1]);
    }
    for (const run of runs) {
      if (run.type === "tyre") continue;
      if (run.points.length / 3 < 3) continue;
      const path = this._runPath(run);
      const flipU = run.side > 0;
      let start = 0;
      let lastRow = -1;
      let lastStile = -1;
      for (let i = 1; i < path.n; i++) {
        if (path.d[i] - path.d[start] < boardLength) continue;
        const skip = this.rng.next() > 0.78;
        if (!skip) {
          this._copyStation(path, start, board, 0);
          this._copyStation(path, i, board, 1);
          board.d[0] = 0;
          board.d[1] = path.d[i] - path.d[start];
          let row = this.rng.int(0, rows - 1);
          if (row === lastRow) row = (row + 1 + this.rng.int(0, rows - 2)) % rows;
          lastRow = row;
          this._sweepPath(
            acc,
            board,
            profile,
            1 / board.d[1],
            1 / rows / profileLength,
            flipU,
            row / rows
          );
          if (start !== lastStile) this._boardMullion(path, start, mullions);
          this._boardMullion(path, i, mullions);
          lastStile = i;
        }
        start = i;
      }
    }
    this._bakeInstances(this._steel, this._mullionGeometry(), mullions);
  }
  _boardMullion(path, r, out) {
    const lateral = -0.245;
    _v.set(
      path.x[r] + path.ox[r] * lateral,
      path.y[r],
      path.z[r] + path.oz[r] * lateral
    );
    _q.setFromAxisAngle(_axis, -Math.atan2(path.tx[r], -path.tz[r]));
    _scale.set(1, 1, 1);
    _m.compose(_v, _q, _scale);
    out.push(_m.clone());
  }
  _mullionGeometry() {
    if (this._mullion) return this._mullion;
    const acc = new MeshAccum();
    acc.box(0, 0.68, 0, 0.045, 1.3, 0.1, 0, 1);
    acc.box(0, 1.345, 0, 0.06, 0.03, 0.13, 0, 1);
    const geo = acc.toGeometry();
    this._geometries.push(geo);
    this._mullion = geo;
    return geo;
  }
  _buildMarshalPosts() {
    const surf = this.surface;
    const materials = this.ctx.materials;
    const loc = surf.createLocateResult();
    const postGeo = this._marshalPostGeometry();
    const flagGeo = new THREE.PlaneGeometry(0.9, 0.6, 6, 1);
    this._geometries.push(flagGeo);
    const postMatrices = [];
    const flagMatrices = [];
    const analytic = this.track.layout.analyticLength;
    const scale = surf.length / analytic;
    for (const distance of this.track.circuit.marshalPosts) {
      const d = (distance * scale % surf.length + surf.length) % surf.length;
      surf.sample(d / surf.length, loc);
      _v.copy(loc.position);
      surf.locate(_v, loc);
      const side = -1;
      const idx = loc.index * 2 + 0;
      const offset = side * (loc.width + surf.kerbWidth[idx] + surf.astroWidth[idx] + Math.min(18, surf.runoffWidth[idx]) + 6);
      const x = loc.position.x + loc.right.x * offset;
      const z = loc.position.z + loc.right.z * offset;
      const y = surf.heightAt(x, z);
      const heading = Math.atan2(loc.tangent.x, -loc.tangent.z);
      _q.setFromAxisAngle(_axis, -heading);
      _scale.set(1, 1, 1);
      _v.set(x, y, z);
      _m.compose(_v, _q, _scale);
      postMatrices.push(_m.clone());
      _v.set(x + loc.right.x * -side * 1.6, y + 2.9, z + loc.right.z * -side * 1.6);
      _q.setFromAxisAngle(_axis, -heading + Math.PI * 0.5);
      _m.compose(_v, _q, _scale);
      flagMatrices.push(_m.clone());
      this._marshalSites.push({
        x,
        y,
        z,
        heading,
        distance: d,
        lateral: offset,
        side
      });
      for (let k = -1; k <= 1; k += 2) {
        const sx = x + loc.tangent.x * k * 3.4;
        const sz = z + loc.tangent.z * k * 3.4;
        this._tyreStacks.push(sx, surf.heightAt(sx, sz), sz);
      }
    }
    this._instance(postGeo, materials.get("marshal_post"), postMatrices, "marshalPosts", true);
    const flagMat = materials.clone("paint_line");
    flagMat.color.setHex(15781911);
    flagMat.side = THREE.DoubleSide;
    flagMat.transparent = false;
    flagMat.depthWrite = true;
    flagMat.name = "marshal_flag";
    this._flag = this._instance(flagGeo, this._makeFlagMaterial(flagMat), flagMatrices, "marshalFlags", false);
  }
  _marshalPostGeometry() {
    if (this._marshalGeo) return this._marshalGeo;
    const acc = new MeshAccum();
    acc.box(0, 1.2, 0, 2.6, 2.4, 1.8, 0, 0.5);
    acc.box(0, 2.52, 0, 2.86, 0.16, 2.06, 0, 0.5);
    acc.box(1.62, 0.14, 0.55, 0.9, 0.28, 0.7, 0, 0.5);
    acc.box(2.15, 1.55, -0.35, 0.11, 3.1, 0.11, 0, 0.5);
    acc.box(2.15, 3.05, -0.35, 1.6, 0.9, 0.1, 0, 0.5);
    const geo = acc.toGeometry();
    this._geometries.push(geo);
    this._marshalGeo = geo;
    return geo;
  }
  _makeFlagMaterial(material) {
    const time = this._time;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = time;
      shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nuniform float uTime;").replace("#include <begin_vertex>", `#include <begin_vertex>
float flagT = ( transformed.x + 0.45 ) / 0.9;
transformed.z += sin( uTime * 5.2 + flagT * 7.0 ) * 0.10 * flagT;
transformed.y += sin( uTime * 4.1 + flagT * 5.0 ) * 0.045 * flagT;`);
    };
    material.customProgramCacheKey = () => "flagWave";
    material.needsUpdate = true;
    return material;
  }
  _buildTowers() {
    const surf = this.surface;
    const materials = this.ctx.materials;
    const loc = surf.createLocateResult();
    const analytic = this.track.layout.analyticLength;
    const scale = surf.length / analytic;
    const mastGeo = new THREE.CylinderGeometry(0.16, 0.3, 1, 8);
    const rigGeo = this._cameraRigGeometry();
    this._geometries.push(mastGeo);
    const masts = [];
    const rigs = [];
    for (const tower of this.track.circuit.towers) {
      const d = (tower.at * scale % surf.length + surf.length) % surf.length;
      surf.sample(d / surf.length, loc);
      const offset = tower.side * tower.offset;
      const x = loc.position.x + loc.right.x * offset;
      const z = loc.position.z + loc.right.z * offset;
      const y = surf.heightAt(x, z);
      const heading = Math.atan2(loc.tangent.x, -loc.tangent.z);
      _q.setFromAxisAngle(_axis, -heading);
      _v.set(x, y + tower.height * 0.5, z);
      _scale.set(1, tower.height, 1);
      _m.compose(_v, _q, _scale);
      masts.push(_m.clone());
      if (tower.kind === "tv") {
        _scale.set(1, 1, 1);
        _v.set(x, y + tower.height, z);
        _m.compose(_v, _q, _scale);
        rigs.push(_m.clone());
        this._tyreStacks.push(x, y, z);
      } else {
        this._pylonSites.push(this._mastSite(d, tower.side, tower.height, tower.offset, false, loc));
      }
    }
    this._bakeInstances(this._steel, mastGeo, masts);
    this._bakeInstances(this._steel, rigGeo, rigs);
  }
  _cameraRigGeometry() {
    const acc = new MeshAccum();
    acc.box(0, 0.09, 0, 2.2, 0.18, 1.8, 0, 0.5);
    for (let i = 0; i < 4; i++) {
      const ax = i < 2 ? i === 0 ? -1.05 : 1.05 : 0;
      const az = i < 2 ? 0 : i === 2 ? -0.85 : 0.85;
      const sx = i < 2 ? 0.07 : 2.2;
      const sz = i < 2 ? 1.8 : 0.07;
      acc.box(ax, 0.62, az, sx, 0.07, sz, 0, 0.5);
    }
    for (let i = 0; i < 4; i++) {
      acc.box(i < 2 ? -1.05 : 1.05, 0.4, i % 2 === 0 ? -0.85 : 0.85, 0.07, 0.62, 0.07, 0, 0.5);
    }
    acc.box(0, 0.72, -0.35, 0.75, 0.42, 0.62, 0, 0.5);
    acc.box(0, 0.74, -0.78, 0.26, 0.26, 0.34, 0, 0.5);
    const geo = acc.toGeometry();
    this._geometries.push(geo);
    return geo;
  }
  _floodlightHousingGeometry() {
    const acc = new MeshAccum();
    for (let k = 0; k < 3; k++) acc.box(0, 0.55 + k * 1.05, 0, 0.6, 0.86, 3.6, 0, 0.5);
    acc.box(-0.42, 1.6, 0, 0.26, 3.4, 0.3, 0, 0.5);
    acc.box(-0.42, 0.1, 0, 0.3, 0.4, 1.2, 0, 0.5);
    const geo = acc.toGeometry();
    this._geometries.push(geo);
    return geo;
  }
  _floodlightLensGeometry() {
    const acc = new MeshAccum();
    const tilt = 0.58;
    const cs = Math.cos(tilt);
    const sn = Math.sin(tilt);
    const nrm = [cs, -sn, 0];
    const hw = 0.36;
    const hh = 0.3;
    const p = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (let k = 0; k < 3; k++) {
      for (let j = 0; j < 4; j++) {
        const cy = 0.55 + k * 1.05;
        const cz = (j - 1.5) * 0.88;
        const cx = 0.31;
        for (let c = 0; c < 4; c++) {
          const su = c === 0 || c === 3 ? -1 : 1;
          const sv = c < 2 ? -1 : 1;
          p[c][0] = cx + sn * hh * sv;
          p[c][1] = cy + cs * hh * sv;
          p[c][2] = cz + hw * su;
        }
        acc.quad(p[0], p[1], p[2], p[3], nrm, 0, 0, 1, 1);
      }
    }
    const geo = acc.toGeometry();
    this._geometries.push(geo);
    return geo;
  }
  _buildDistanceBoards() {
    const boards = this.track.circuit.brakingBoards;
    if (!boards?.length) return;
    const surf = this.surface;
    const loc = surf.createLocateResult();
    const analytic = this.track.layout.analyticLength;
    const scale = surf.length / analytic;
    const texture = buildDistanceBoards(256, 1024, 6161);
    const map = makeDataTexture(texture.color, texture.width, texture.height, THREE.SRGBColorSpace);
    map.anisotropy = this.ctx.materials.anisotropy ?? 4;
    this._textures.push(map);
    const material = new THREE.MeshStandardMaterial({
      map,
      roughness: 0.72,
      metalness: 0,
      name: "distance_board"
    });
    this._materials.push(material);
    const acc = new MeshAccum();
    const posts = [];
    const bandV = 1 / texture.rows;
    const backV = DISTANCE_MARKS.length * bandV;
    const halfW = 0.75;
    const hLo = 0.95;
    const hHi = 2.15;
    const p0 = [0, 0, 0], p1 = [0, 0, 0], p2 = [0, 0, 0], p3 = [0, 0, 0], nrm = [0, 0, 0];
    for (const spec of boards) {
      for (const mark of spec.marks) {
        const band = DISTANCE_MARKS.indexOf(mark);
        if (band < 0) continue;
        const d = ((spec.at - mark) * scale % surf.length + surf.length) % surf.length;
        surf.sample(d / surf.length, loc);
        _v.copy(loc.position);
        surf.locate(_v, loc);
        const idx = loc.index * 2 + (spec.side >= 0 ? 1 : 0);
        const lateral = spec.side * (loc.width + surf.kerbWidth[idx] + surf.astroWidth[idx] + Math.min(12, surf.runoffWidth[idx]) + 1.6);
        const cx = loc.position.x + loc.right.x * lateral;
        const cz = loc.position.z + loc.right.z * lateral;
        const cy = surf.heightAt(cx, cz);
        const rx = loc.right.x, rz = loc.right.z;
        nrm[0] = -loc.tangent.x;
        nrm[1] = 0;
        nrm[2] = -loc.tangent.z;
        p0[0] = cx - rx * halfW;
        p0[1] = cy + hLo;
        p0[2] = cz - rz * halfW;
        p1[0] = cx + rx * halfW;
        p1[1] = cy + hLo;
        p1[2] = cz + rz * halfW;
        p2[0] = p1[0];
        p2[1] = cy + hHi;
        p2[2] = p1[2];
        p3[0] = p0[0];
        p3[1] = cy + hHi;
        p3[2] = p0[2];
        acc.quad(p0, p1, p2, p3, nrm, 0, band * bandV, 1, (band + 1) * bandV);
        nrm[0] = loc.tangent.x;
        nrm[2] = loc.tangent.z;
        acc.quad(p1, p0, p3, p2, nrm, 0, backV, 1, backV + bandV);
        const heading = Math.atan2(loc.tangent.x, -loc.tangent.z);
        _q.setFromAxisAngle(_axis, -heading);
        _scale.set(1, 1, 1);
        for (let k = -1; k <= 1; k += 2) {
          _v.set(cx + rx * k * 0.6, cy + hLo * 0.5, cz + rz * k * 0.6);
          _m.compose(_v, _q, _scale);
          posts.push(_m.clone());
        }
      }
    }
    this._addMerged(acc, material, "distanceBoards", false);
    if (posts.length) {
      const postGeo = new THREE.BoxGeometry(0.09, hLo, 0.09);
      this._bakeInstances(this._steel, postGeo, posts);
      postGeo.dispose();
    }
  }
  _buildTyreStacks() {
    if (!this._tyreStacks.length) return;
    const geo = new THREE.CylinderGeometry(0.38, 0.4, 0.9, 12, 1);
    this._geometries.push(geo);
    const matrices = [];
    for (let i = 0; i < this._tyreStacks.length; i += 3) {
      const x = this._tyreStacks[i];
      const y = this._tyreStacks[i + 1];
      const z = this._tyreStacks[i + 2];
      for (let k = 0; k < 3; k++) {
        _v.set(x + this.rng.signed(0.9), y + 0.45, z + this.rng.signed(0.9));
        _q.setFromAxisAngle(_axis, this.rng.next() * Math.PI * 2);
        _scale.set(1, 1, 1);
        _m.compose(_v, _q, _scale);
        matrices.push(_m.clone());
      }
    }
    this._instance(geo, this.ctx.materials.get("tyrewall"), matrices, "tyreStacks", true);
  }
  _buildTrees() {
    const surf = this.surface;
    const detail = this.tier?.name === "low" ? 0.32 : this.tier?.name === "medium" ? 0.6 : this.tier?.name === "ultra" ? 1.35 : 1;
    const loc = surf.createLocateResult();
    const clearings = this.track.circuit.clearings.map((c) => {
      const d = (c.at / this.track.layout.analyticLength % 1 + 1) % 1;
      surf.sample(d, loc);
      return { x: loc.position.x, z: loc.position.z, r2: c.radius * c.radius };
    });
    const buckets = TREE_SPECIES.map(() => ({ matrices: [], data: [], tint: [] }));
    this._scatterTrees(
      buckets,
      clearings,
      loc,
      TREE_SPACING / Math.sqrt(detail),
      26,
      TREE_BAND,
      1
    );
    this._scatterTrees(
      buckets,
      clearings,
      loc,
      TREE_FAR_SPACING / Math.sqrt(detail),
      TREE_BAND,
      TREE_FAR_BAND,
      0.55
    );
    const canopyMat = this._canopyMaterial();
    let stemCount = 0;
    for (const bucket of buckets) stemCount += bucket.matrices.length;
    if (stemCount) {
      const stems = new Float32Array(stemCount * 2);
      const stemData = new Float32Array(stemCount * 2);
      const stemMatrices = [];
      let w = 0;
      for (let s = 0; s < TREE_SPECIES.length; s++) {
        const species = TREE_SPECIES[s];
        const bucket = buckets[s];
        const h = species.height[1];
        const butt = 0.18 + h * 0.0105;
        for (let i = 0; i < bucket.matrices.length; i++, w++) {
          stems[w * 2] = h;
          stems[w * 2 + 1] = butt / TRUNK_UNIT_RADIUS;
          stemData[w * 2] = bucket.data[i * 2];
          stemData[w * 2 + 1] = bucket.data[i * 2 + 1];
          stemMatrices.push(bucket.matrices[i]);
        }
      }
      const trunkMat = this._trunkMaterial();
      const trunks = this._instance(
        this._trunkGeometry(),
        trunkMat,
        stemMatrices,
        "treeTrunks",
        false
      );
      trunks.geometry.setAttribute("aTree", new THREE.InstancedBufferAttribute(stemData, 2));
      trunks.geometry.setAttribute("aStem", new THREE.InstancedBufferAttribute(stems, 2));
    }
    for (let s = 0; s < TREE_SPECIES.length; s++) {
      const bucket = buckets[s];
      if (!bucket.matrices.length) continue;
      const species = TREE_SPECIES[s];
      const data = new Float32Array(bucket.data);
      const tint = new Float32Array(bucket.tint);
      const canopies = this._instance(
        this._canopyGeometry(species),
        canopyMat,
        bucket.matrices,
        `canopy_${species.name}`,
        true
      );
      canopies.geometry.setAttribute("aTree", new THREE.InstancedBufferAttribute(data, 2));
      canopies.geometry.setAttribute("aTint", new THREE.InstancedBufferAttribute(tint, 3));
    }
  }
  _scatterTrees(buckets, clearings, loc, spacing, nearClear, farClear, gain) {
    const surf = this.surface;
    const b = surf.bounds;
    const rng = this.rng;
    const minX = b.minX - farClear;
    const maxX = b.maxX + farClear;
    const minZ = b.minZ - farClear;
    const maxZ = b.maxZ + farClear;
    for (let z = minZ; z < maxZ; z += spacing) {
      for (let x = minX; x < maxX; x += spacing) {
        const px = x + rng.signed(spacing * 0.5);
        const pz = z + rng.signed(spacing * 0.5);
        _v.set(px, 0, pz);
        surf.locate(_v, loc);
        const idx = loc.index * 2 + (loc.lateral >= 0 ? 1 : 0);
        const paved = loc.width + surf.kerbWidth[idx] + surf.astroWidth[idx] + surf.runoffWidth[idx];
        const clear = Math.abs(loc.lateral) - paved;
        if (clear < nearClear || clear > farClear) continue;
        let blocked = false;
        for (const c of clearings) {
          const dx = px - c.x;
          const dz = pz - c.z;
          if (dx * dx + dz * dz < c.r2) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        const stand = valueNoise2(px * 72e-4, pz * 72e-4);
        const density = smoothstep(nearClear, nearClear + 38, clear) * (1 - 0.7 * smoothstep(farClear * 0.62, farClear, clear)) * (0.28 + 1.05 * stand) * gain;
        if (rng.next() > density) continue;
        const dominant = Math.min(
          TREE_SPECIES.length - 1,
          Math.floor(valueNoise2(px * 91e-4 + 31.7, pz * 91e-4 - 12.3) * TREE_SPECIES.length)
        );
        let speciesIndex = dominant;
        if (rng.next() > 0.68) {
          let pick = rng.next();
          for (let i = 0; i < TREE_SPECIES.length; i++) {
            pick -= TREE_SPECIES[i].share;
            if (pick <= 0) {
              speciesIndex = i;
              break;
            }
          }
        }
        const species = TREE_SPECIES[speciesIndex];
        const vigour = 0.74 + 0.52 * valueNoise2(px * 38e-4 - 5.1, pz * 38e-4 + 8.4);
        const h0 = species.height[0];
        const h1 = species.height[1];
        const height = clamp(h0 + rng.next() * (h1 - h0) * vigour * 1.15, h0 * 0.7, h1);
        const radius = species.radius[0] + rng.next() * (species.radius[1] - species.radius[0]);
        const y = surf.heightAt(px, pz);
        _q.setFromAxisAngle(_axis, rng.next() * Math.PI * 2);
        _v.set(px, y, pz);
        _scale.set(radius / species.radius[1], height / species.height[1], radius / species.radius[1]);
        _m.compose(_v, _q, _scale);
        const bucket = buckets[speciesIndex];
        bucket.matrices.push(_m.clone());
        bucket.data.push(height, 0.22 + rng.next() * 0.3);
        const t = clamp01(rng.next() * 0.75 + stand * 0.45);
        const lo = species.tint[0];
        const hi = species.tint[1];
        bucket.tint.push(
          lo[0] + (hi[0] - lo[0]) * t,
          lo[1] + (hi[1] - lo[1]) * t,
          lo[2] + (hi[2] - lo[2]) * t
        );
      }
    }
  }
  _trunkGeometry() {
    if (this._trunk) return this._trunk;
    const geo = new THREE.CylinderGeometry(
      TRUNK_UNIT_RADIUS * 0.4,
      TRUNK_UNIT_RADIUS,
      1,
      6,
      1,
      true
    );
    geo.translate(0, 0.5, 0);
    this._geometries.push(geo);
    this._trunk = geo;
    return geo;
  }
  _trunkMaterial() {
    if (this._trunkMat) return this._trunkMat;
    const material = this.ctx.materials.clone("tree_bark");
    material.name = "tree_stem";
    const time = this._time;
    const wind = this._wind;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = time;
      shader.uniforms.uWind = wind;
      shader.vertexShader = shader.vertexShader.replace("#include <common>", `#include <common>
uniform float uTime;
uniform vec2 uWind;
attribute vec2 aTree;
attribute vec2 aStem;`).replace("#include <begin_vertex>", `#include <begin_vertex>
transformed.y *= aStem.x;
transformed.xz *= aStem.y;
vec3 treeOrigin = instanceMatrix[ 3 ].xyz;
float treePhase = treeOrigin.x * 0.11 + treeOrigin.z * 0.17;
float treeUp = clamp( transformed.y / max( 1.0, aTree.x ), 0.0, 1.0 );
float treeAmp = treeUp * treeUp * aTree.y * 0.350;
float gust = sin( uTime * 1.15 + treePhase ) + 0.4 * sin( uTime * 2.9 + treePhase * 1.7 );
transformed.x += uWind.x * gust * treeAmp;
transformed.z += uWind.y * gust * treeAmp;
transformed.x += sin( uTime * 3.4 + treePhase * 2.3 ) * treeAmp * 0.22;`);
    };
    material.customProgramCacheKey = () => "treeStemV1";
    material.needsUpdate = true;
    this._materials.push(material);
    this._trunkMat = material;
    return material;
  }
  _canopyGeometry(species) {
    const acc = new MeshAccum();
    const centres = [];
    const ids = [];
    const h = species.height[1];
    const r = species.radius[1];
    const cards = species.cards;
    const crownBase = h * species.bare;
    const crownSpan = h - crownBase;
    const cell = species.atlas;
    const u0 = cell % CANOPY_ATLAS.cols / CANOPY_ATLAS.cols;
    const v0 = Math.floor(cell / CANOPY_ATLAS.cols) / CANOPY_ATLAS.rows;
    const du = 1 / CANOPY_ATLAS.cols;
    const dv = 1 / CANOPY_ATLAS.rows;
    const dens = clamp(Math.sqrt(8 / cards), 0.88, 1.1);
    for (let i = 0; i < cards; i++) {
      const f = cards > 1 ? i / (cards - 1) : 0.5;
      const angle = i * 2.39996 + 0.4;
      const lump = 0.86 + 0.28 * (0.5 + 0.5 * Math.sin(i * 2.7 + species.atlas * 1.9));
      let cy;
      let width;
      let tall;
      if (species.form === "spire") {
        cy = crownBase + crownSpan * (0.05 + 0.94 * f);
        width = r * (1.04 - 0.9 * f) * lump;
        tall = crownSpan * 0.19 * dens;
      } else if (species.form === "umbrella") {
        cy = crownBase + crownSpan * (0.3 + 0.66 * f);
        width = r * (0.72 + 0.38 * Math.sin(f * Math.PI)) * lump;
        tall = crownSpan * 0.29 * dens;
      } else if (species.form === "column") {
        cy = crownBase + crownSpan * (0.08 + 0.86 * f);
        width = r * (0.52 + 0.46 * Math.sin(f * Math.PI)) * lump;
        tall = crownSpan * 0.23 * dens;
      } else {
        cy = crownBase + crownSpan * (0.14 + 0.78 * f);
        width = r * (0.62 + 0.44 * Math.sin(f * Math.PI * 0.92)) * lump;
        tall = crownSpan * 0.26 * dens;
      }
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      const dx = ca * width;
      const dz = sa * width;
      const ox = -sa * width * 0.22;
      const oz = ca * width * 0.22;
      const centre = [ox, cy, oz];
      const flip = (i & 1) === 1;
      const ua = u0 + (flip ? du : 0);
      const ub = u0 + (flip ? 0 : du);
      const a = [ox - dx, cy - tall, oz - dz];
      const bb = [ox + dx, cy - tall, oz + dz];
      const c = [ox + dx, cy + tall, oz + dz];
      const d = [ox - dx, cy + tall, oz - dz];
      acc.quad(a, bb, c, d, [sa, 0.35, -ca], ua, v0, ub, v0 + dv);
      acc.quad(bb, a, d, c, [-sa, 0.35, ca], ub, v0, ua, v0 + dv);
      for (let k = 0; k < 8; k++) {
        centres.push(centre[0], centre[1], centre[2]);
        ids.push(i + 1);
      }
    }
    const geo = acc.toGeometry();
    geo.setAttribute("aCardCentre", new THREE.Float32BufferAttribute(centres, 3));
    geo.setAttribute("aCard", new THREE.Float32BufferAttribute(ids, 1));
    this._geometries.push(geo);
    return geo;
  }
  _canopyMaterial() {
    if (this._canopyMat) return this._canopyMat;
    const aniso = this._maxAnisotropy();
    const td = buildCanopyAtlas(1024, 6464);
    const map = makeDataTexture(td.color, td.width, td.height, THREE.SRGBColorSpace, td.colorMips);
    const normalMap = makeDataTexture(td.normal, td.width, td.height, THREE.NoColorSpace);
    const ormMap = makeDataTexture(td.orm, td.width, td.height, THREE.NoColorSpace);
    ormMap.channel = 0;
    for (const t of [map, normalMap, ormMap]) {
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.anisotropy = aniso;
      this._textures.push(t);
    }
    const material = new THREE.MeshStandardMaterial({
      map,
      normalMap,
      roughnessMap: ormMap,
      aoMap: ormMap,
      roughness: 1,
      metalness: 0,
      alphaTest: CANOPY_ALPHA_TEST,
      transparent: false,
      side: THREE.DoubleSide,
      envMapIntensity: 1.35,
      name: "tree_canopy_atlas"
    });
    material.normalScale.set(0.8, 0.8);
    this._materials.push(material);
    const time = this._time;
    const wind = this._wind;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = time;
      shader.uniforms.uWind = wind;
      shader.vertexShader = shader.vertexShader.replace("#include <common>", `#include <common>
uniform float uTime;
uniform vec2 uWind;
attribute vec2 aTree;
attribute vec3 aTint;
attribute vec3 aCardCentre;
attribute float aCard;
varying vec3 vTreeTint;`).replace("#include <begin_vertex>", `#include <begin_vertex>
vTreeTint = aTint;
vec3 treeOrigin = instanceMatrix[ 3 ].xyz;
float treeHash = fract( sin( treeOrigin.x * 12.9898 + treeOrigin.z * 78.233 ) * 43758.5453 );
float cardA = fract( sin( aCard * 91.7 + treeHash * 137.13 ) * 43758.5453 );
float cardB = fract( sin( aCard * 47.3 + treeHash * 219.71 ) * 43758.5453 );
float cardC = fract( sin( aCard * 23.9 + treeHash * 311.37 ) * 43758.5453 );
float cardGrow = cardA < 0.11 ? 0.0 : 0.58 + cardA * 0.92;
transformed = aCardCentre + ( transformed - aCardCentre ) * cardGrow;
transformed.x += ( cardB - 0.5 ) * aTree.x * 0.15;
transformed.z += ( cardC - 0.5 ) * aTree.x * 0.15;
transformed.y += ( cardB - cardC ) * aTree.x * 0.08;
float treePhase = treeOrigin.x * 0.11 + treeOrigin.z * 0.17;
float treeUp = clamp( transformed.y / max( 1.0, aTree.x ), 0.0, 1.0 );
float treeAmp = treeUp * treeUp * aTree.y;
float gust = sin( uTime * 1.15 + treePhase ) + 0.4 * sin( uTime * 2.9 + treePhase * 1.7 );
transformed.x += uWind.x * gust * treeAmp;
transformed.z += uWind.y * gust * treeAmp;
transformed.x += sin( uTime * 3.4 + treePhase * 2.3 ) * treeAmp * 0.22;`);
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying vec3 vTreeTint;").replace("#include <map_fragment>", `#include <map_fragment>
diffuseColor.rgb *= vTreeTint;`);
    };
    material.customProgramCacheKey = () => "canopyAtlasV1";
    material.needsUpdate = true;
    this._canopyMat = material;
    return material;
  }
  _buildNightLighting() {
    const sites = this._collectMastSites();
    this._siteData = new Float64Array(sites.length * 8);
    for (let i = 0; i < sites.length; i++) {
      const s = sites[i];
      this._siteData[i * 8] = s.x;
      this._siteData[i * 8 + 1] = s.y + s.height;
      this._siteData[i * 8 + 2] = s.z;
      this._siteData[i * 8 + 3] = s.ax;
      this._siteData[i * 8 + 4] = s.ay;
      this._siteData[i * 8 + 5] = s.az;
      this._siteData[i * 8 + 6] = s.tx;
      this._siteData[i * 8 + 7] = s.tz;
    }
    this._buildMastHeads(sites);
    this._buildMastGlows(sites);
    this._buildLightPools(sites);
    this._buildLedBoards();
    this._buildStandLighting();
    this._buildPitLighting();
    this._buildMarshalLamps();
    this._buildNightLights();
    this._applyNight(0);
  }
  _mastSite(distance, side, height, offset, generated, loc) {
    const surf = this.surface;
    const d = (distance % surf.length + surf.length) % surf.length;
    surf.sample(d / surf.length, loc);
    const idx = loc.index * 2 + (side > 0 ? 1 : 0);
    const stand = Number.isFinite(offset) ? offset : loc.width + surf.kerbWidth[idx] + surf.astroWidth[idx] + Math.min(20, surf.runoffWidth[idx]) + 7;
    const x = loc.position.x + loc.right.x * side * stand;
    const z = loc.position.z + loc.right.z * side * stand;
    const ax = loc.position.x - loc.right.x * side * loc.width * 0.35;
    const az = loc.position.z - loc.right.z * side * loc.width * 0.35;
    return {
      x,
      y: surf.heightAt(x, z),
      z,
      ax,
      ay: surf.heightAt(ax, az),
      az,
      tx: loc.tangent.x,
      tz: loc.tangent.z,
      height,
      side,
      distance: d,
      generated,
      heading: Math.atan2(loc.tangent.x, -loc.tangent.z),
      width: loc.width
    };
  }
  _collectMastSites() {
    const surf = this.surface;
    const loc = surf.createLocateResult();
    const sites = this._pylonSites.slice();
    const count = Math.max(8, Math.round(surf.length / NIGHT_MAST_SPACING));
    const step = surf.length / count;
    for (let i = 0; i < count; i++) {
      const d = i * step;
      let clash = false;
      for (const p of this._pylonSites) {
        let gap = Math.abs(p.distance - d);
        if (gap > surf.length * 0.5) gap = surf.length - gap;
        if (gap < NIGHT_MAST_CLEAR) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      sites.push(this._mastSite(d, i % 2 === 0 ? -1 : 1, NIGHT_MAST_HEIGHT, null, true, loc));
    }
    return sites;
  }
  _buildMastHeads(sites) {
    const materials = this.ctx.materials;
    const mastGeo = new THREE.CylinderGeometry(0.17, 0.32, 1, 8);
    this._geometries.push(mastGeo);
    const housingGeo = this._floodlightHousingGeometry();
    const lensGeo = this._floodlightLensGeometry();
    const masts = [];
    const heads = [];
    for (const s of sites) {
      _q.setFromAxisAngle(_axis, -s.heading + (s.side > 0 ? Math.PI : 0));
      if (s.generated) {
        _scale.set(1, s.height, 1);
        _v.set(s.x, s.y + s.height * 0.5, s.z);
        _m.compose(_v, _q, _scale);
        masts.push(_m.clone());
      }
      _scale.set(1, 1, 1);
      _v.set(s.x, s.y + s.height, s.z);
      _m.compose(_v, _q, _scale);
      heads.push(_m.clone());
    }
    this._bakeInstances(this._steel, mastGeo, masts);
    const housingMat = materials.clone("metal_anodised");
    housingMat.color.setHex(3356219);
    housingMat.roughness = 0.62;
    housingMat.name = "floodlight_housing";
    this._instance(housingGeo, housingMat, heads, "floodlightHeads", false);
    const lensMat = new THREE.MeshStandardMaterial({
      color: 658189,
      emissive: new THREE.Color(16773852),
      emissiveIntensity: 0,
      roughness: 0.22,
      metalness: 0,
      name: "floodlight_lens"
    });
    this._materials.push(lensMat);
    this._nightEmissive.push({ material: lensMat, day: 0, night: NIGHT_LENS_EMISSIVE });
    const lens = this._instance(lensGeo, lensMat, heads, "floodlightLenses", false);
    lens.receiveShadow = false;
    this._nightMeshes.push(lens);
  }
  _buildMastGlows(sites) {
    const geo = new THREE.PlaneGeometry(11, 11);
    this._geometries.push(geo);
    const map = this._glowTexture();
    const material = new THREE.MeshBasicMaterial({
      map,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      name: "floodlight_glow"
    });
    this._materials.push(material);
    this._billboard(material, "floodGlow");
    this._nightAdditive.push({ material, gain: 1 });
    const matrices = [];
    for (const s of sites) {
      const dirX = Math.cos(-s.heading + (s.side > 0 ? Math.PI : 0));
      const dirZ = -Math.sin(-s.heading + (s.side > 0 ? Math.PI : 0));
      _v.set(s.x + dirX * 0.5, s.y + s.height + 1.5, s.z + dirZ * 0.5);
      _q.identity();
      _scale.set(1, 1, 1);
      _m.compose(_v, _q, _scale);
      matrices.push(_m.clone());
    }
    const mesh = this._instance(geo, material, matrices, "floodlightGlows", false);
    mesh.receiveShadow = false;
    mesh.renderOrder = 6;
    this._nightMeshes.push(mesh);
  }
  _buildLightPools(sites) {
    const pool = { pos: [], uv: [], col: [], idx: [] };
    const rng = new Rng(1721877261);
    for (const s of sites) {
      const pad = s.width + POOL_PAD;
      const gain = 0.82 + rng.next() * 0.36;
      this._pushPool(
        pool,
        s.distance - POOL_HALF,
        s.distance + POOL_HALF,
        -pad,
        pad,
        0.98,
        0.985,
        1,
        gain,
        1
      );
    }
    const spec = this.track.circuit.pitLane;
    let span = spec.buildingTo - spec.buildingFrom;
    while (span < 0) span += this.surface.length;
    this._pushPool(
      pool,
      spec.buildingFrom,
      spec.buildingFrom + span,
      12.5,
      25.5,
      1,
      0.86,
      0.62,
      0.55,
      Math.max(2, Math.round(span / 17))
    );
    for (const p of this._marshalSites) {
      this._pushPool(
        pool,
        p.distance - 9,
        p.distance + 9,
        p.lateral - 7.5,
        p.lateral + 7.5,
        1,
        0.8,
        0.52,
        0.5,
        1
      );
    }
    if (!pool.idx.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pool.pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(pool.uv, 2));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(pool.col, 3));
    geo.setIndex(pool.idx);
    geo.computeBoundingSphere();
    this._geometries.push(geo);
    const map = this._poolTexture();
    const material = new THREE.MeshBasicMaterial({
      map,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      name: "light_pool",
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8
    });
    this._materials.push(material);
    this._nightAdditive.push({ material, gain: POOL_GAIN });
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = "lightPools";
    mesh.renderOrder = 5;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this._nightMeshes.push(mesh);
  }
  _pushPool(pool, dFrom, dTo, latA, latB, tintR, tintG, tintB, gain, tiles) {
    const surf = this.surface;
    const loc = surf.createLocateResult();
    const runLength = dTo - dFrom;
    const rows = Math.max(2, Math.ceil(Math.abs(runLength) / POOL_ARC_STEP));
    const cols = Math.max(2, Math.ceil(Math.abs(latB - latA) / POOL_LAT_STEP));
    const base = pool.pos.length / 3;
    for (let r = 0; r <= rows; r++) {
      const f = r / rows;
      const d = dFrom + runLength * f;
      surf.sample((d % surf.length + surf.length) % surf.length / surf.length, loc);
      for (let c = 0; c <= cols; c++) {
        const g = c / cols;
        const lateral = latA + (latB - latA) * g;
        const x = loc.position.x + loc.right.x * lateral;
        const z = loc.position.z + loc.right.z * lateral;
        pool.pos.push(x, surf.heightAt(x, z) + POOL_LIFT, z);
        pool.uv.push(g, f * tiles);
        pool.col.push(tintR * gain, tintG * gain, tintB * gain);
      }
    }
    const stride = cols + 1;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const a = base + r * stride + c;
        pool.idx.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride);
      }
    }
  }
  _buildLedBoards() {
    const runs = this.track._barriers?.runs ?? [];
    if (!runs.length) return;
    const panels = this._ledTexture();
    const map = panels.map;
    const rows = panels.rows;
    const material = new THREE.MeshStandardMaterial({
      color: 1711136,
      map,
      emissive: new THREE.Color(16777215),
      emissiveMap: map,
      emissiveIntensity: 0,
      roughness: 0.46,
      metalness: 0,
      name: "led_board"
    });
    this._materials.push(material);
    this._nightEmissive.push({ material, day: 0.55, night: 1.35 });
    const rng = new Rng(747573675);
    const acc = new MeshAccum();
    const board = this._makePath(2);
    const boardLength = 5.2;
    const profile = LED_PROFILE;
    let profileLength = 0;
    for (let c = 1; c < profile.length; c++) {
      profileLength += Math.hypot(profile[c][0] - profile[c - 1][0], profile[c][1] - profile[c - 1][1]);
    }
    for (const run of runs) {
      if (run.type === "tyre") continue;
      if (run.points.length / 3 < 3) continue;
      const path = this._runPath(run);
      const flipU = run.side > 0;
      let start = 0;
      for (let i = 1; i < path.n; i++) {
        if (path.d[i] - path.d[start] < boardLength) continue;
        if (rng.next() < 0.26) {
          this._copyStation(path, start, board, 0);
          this._copyStation(path, i, board, 1);
          board.d[0] = 0;
          board.d[1] = path.d[i] - path.d[start];
          const row = rng.int(0, rows - 1);
          this._sweepPath(
            acc,
            board,
            profile,
            1 / board.d[1],
            1 / rows / profileLength,
            flipU,
            row / rows
          );
        }
        start = i;
      }
    }
    this._addMerged(acc, material, "ledBoards", false, false);
  }
  _buildStandLighting() {
    const acc = new MeshAccum();
    const fasciaMat = new THREE.MeshStandardMaterial({
      color: 1316378,
      emissive: new THREE.Color(14477823),
      emissiveIntensity: 0,
      roughness: 0.5,
      metalness: 0,
      name: "stand_fascia_strip"
    });
    this._materials.push(fasciaMat);
    this._nightEmissive.push({ material: fasciaMat, day: 0, night: 2.4 });
    const lampMat = new THREE.MeshStandardMaterial({
      color: 723982,
      emissive: new THREE.Color(16774370),
      emissiveIntensity: 0,
      roughness: 0.35,
      metalness: 0,
      name: "stand_roof_lamp"
    });
    this._materials.push(lampMat);
    this._nightEmissive.push({ material: lampMat, day: 0, night: 5 });
    const lampGeo = new THREE.BoxGeometry(0.72, 0.26, 0.42);
    this._geometries.push(lampGeo);
    const lamps = [];
    for (const stand of this.track.circuit.grandstands) {
      const offset = stand.offset + STAND_SETBACK;
      const path = this._trackPath(stand.from, stand.to, stand.side, offset, STAND_STATION);
      const depth = stand.rows * STAND_TREAD;
      const deckTop = STAND_FRONT + stand.rows * STAND_RISER;
      const roofFrontLat = STAND_WALK + depth * 0.34;
      const roofFrontY = deckTop + STAND_ROOF_CLEAR;
      this._sweepPath(acc, path, [[-0.1, STAND_FRONT - 0.3], [-0.1, STAND_FRONT - 0.02]], 0.25, 3.5);
      this._instancesAlong(
        path,
        STAND_FRAME_STATION * 2,
        roofFrontY - 0.95,
        roofFrontLat - 0.15,
        1,
        1,
        1,
        lamps
      );
    }
    const strips = this._addMerged(acc, fasciaMat, "standFasciaStrips", false, false);
    if (strips) this._nightMeshes.push(strips);
    if (lamps.length) {
      const mesh = this._instance(lampGeo, lampMat, lamps, "standRoofLamps", false);
      mesh.receiveShadow = false;
      this._nightMeshes.push(mesh);
    }
  }
  _buildPitLighting() {
    const spec = this.track.circuit.pitLane;
    const from = spec.buildingFrom;
    const to = spec.buildingTo;
    const windowMat = new THREE.MeshStandardMaterial({
      color: 724242,
      emissive: new THREE.Color(16777215),
      emissiveMap: this._windowTexture(),
      emissiveIntensity: 0,
      roughness: 0.16,
      metalness: 0,
      name: "pit_windows"
    });
    this._materials.push(windowMat);
    this._nightEmissive.push({ material: windowMat, day: 0.1, night: 1.9 });
    this._sweepProfile(
      from,
      to,
      1,
      spec.buildingOffset - 0.05,
      [[1.15, 5.7], [1.15, 9.25]],
      windowMat,
      "pitWindows",
      1 / 7,
      1 / 3.55,
      false
    );
    const bayMat = new THREE.MeshStandardMaterial({
      color: 526604,
      emissive: new THREE.Color(16777215),
      emissiveMap: this._garageTexture(),
      emissiveIntensity: 0,
      roughness: 0.5,
      metalness: 0,
      name: "pit_garage_glow"
    });
    this._materials.push(bayMat);
    this._nightEmissive.push({ material: bayMat, day: 0.06, night: 2.2 });
    this._sweepProfile(
      from,
      to,
      1,
      spec.buildingOffset - 0.46,
      [[0, 0.3], [0, 3.95]],
      bayMat,
      "pitGarageGlow",
      1 / spec.boxSpacing,
      1 / 3.65,
      false
    );
  }
  _buildMarshalLamps() {
    if (!this._marshalSites.length) return;
    const acc = new MeshAccum();
    acc.box(0, 0, 0, 0.62, 0.16, 0.46, 0, 0.5);
    const geo = acc.toGeometry();
    this._geometries.push(geo);
    const material = new THREE.MeshStandardMaterial({
      color: 657932,
      emissive: new THREE.Color(16765850),
      emissiveIntensity: 0,
      roughness: 0.4,
      metalness: 0,
      name: "marshal_lamp"
    });
    this._materials.push(material);
    this._nightEmissive.push({ material, day: 0, night: 5.5 });
    const matrices = [];
    for (const p of this._marshalSites) {
      _q.setFromAxisAngle(_axis, -p.heading);
      _scale.set(1, 1, 1);
      _v.set(p.x, p.y + 3.05, p.z);
      _m.compose(_v, _q, _scale);
      matrices.push(_m.clone());
    }
    const mesh = this._instance(geo, material, matrices, "marshalLamps", false);
    mesh.receiveShadow = false;
    this._nightMeshes.push(mesh);
  }
  _buildNightLights() {
    const fill = new THREE.HemisphereLight(2899032, 2366742, 0);
    fill.visible = false;
    this.group.add(fill);
    this._nightFill = fill;
    const intensity = NIGHT_SPOT_IRRADIANCE * NIGHT_SPOT_REF ** NIGHT_SPOT_DECAY;
    for (let i = 0; i < NIGHT_SPOT_MAX; i++) {
      const spot = new THREE.SpotLight(16773338, 0, 110, 0.45, 0.7, NIGHT_SPOT_DECAY);
      spot.castShadow = false;
      spot.visible = false;
      spot.userData.peak = intensity;
      this.group.add(spot);
      this.group.add(spot.target);
      this._spots.push(spot);
    }
  }
  _nightAmount() {
    const sun = this.ctx.sky?.sunDirection;
    if (!sun) return 0;
    return 1 - smoothstep(-0.03, 0.1, sun.y);
  }
  _applyNight(nf) {
    for (const e of this._nightEmissive) {
      e.material.emissiveIntensity = e.day + (e.night - e.day) * nf;
    }
    const lit = nf > 0.01;
    for (const a of this._nightAdditive) {
      const g = a.gain * nf;
      a.material.color.setRGB(g, g, g, THREE.LinearSRGBColorSpace);
    }
    for (const mesh of this._nightMeshes) mesh.visible = lit;
    if (this._nightFill) {
      this._nightFill.intensity = NIGHT_FILL_INTENSITY * nf;
      this._nightFill.visible = lit;
    }
    for (const spot of this._spots) spot.visible = lit;
  }
  _updateSpots(nf) {
    const camera = this.ctx.camera;
    const data = this._siteData;
    const count = data.length / 8;
    const slots = Math.min(this._spots.length, this._spotCount());
    if (!camera || !count) return;
    for (let s = 0; s < slots; s++) {
      this._spotSite[s] = -1;
      this._spotDist[s] = Infinity;
    }
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    for (let i = 0; i < count; i++) {
      const dx = data[i * 8] - cx;
      const dy = data[i * 8 + 1] - cy;
      const dz = data[i * 8 + 2] - cz;
      const d2 = dx * dx + dy * dy + dz * dz;
      for (let s = 0; s < slots; s++) {
        if (d2 >= this._spotDist[s]) continue;
        for (let k = slots - 1; k > s; k--) {
          this._spotSite[k] = this._spotSite[k - 1];
          this._spotDist[k] = this._spotDist[k - 1];
        }
        this._spotSite[s] = i;
        this._spotDist[s] = d2;
        break;
      }
    }
    for (let s = 0; s < this._spots.length; s++) {
      const spot = this._spots[s];
      const site = s < slots ? this._spotSite[s] : -1;
      if (site < 0) {
        spot.intensity = 0;
        continue;
      }
      const i = site * 8;
      spot.position.set(data[i], data[i + 1], data[i + 2]);
      const tx = data[i + 6];
      const tz = data[i + 7];
      const along = clamp(
        (cx - data[i + 3]) * tx + (cz - data[i + 5]) * tz,
        -NIGHT_SPOT_AIM_SPAN,
        NIGHT_SPOT_AIM_SPAN
      );
      spot.target.position.set(data[i + 3] + tx * along, data[i + 4], data[i + 5] + tz * along);
      const fade = 1 - smoothstep(
        NIGHT_SPOT_FADE_NEAR,
        NIGHT_SPOT_FADE_FAR,
        Math.sqrt(this._spotDist[s])
      );
      spot.intensity = spot.userData.peak * nf * fade;
    }
  }
  _spotCount() {
    const name = this.tier?.name;
    if (name === "low") return 2;
    if (name === "medium") return 3;
    return NIGHT_SPOT_MAX;
  }
  _signMaterial() {
    if (this._signMat) return this._signMat;
    const aniso = this._maxAnisotropy();
    const td = buildSponsorBoards(2048, 1024, 4747);
    const map = makeDataTexture(td.color, td.width, td.height, THREE.SRGBColorSpace);
    const normalMap = makeDataTexture(td.normal, td.width, td.height, THREE.NoColorSpace);
    const ormMap = makeDataTexture(td.orm, td.width, td.height, THREE.NoColorSpace);
    ormMap.channel = 0;
    for (const t of [map, normalMap, ormMap]) {
      t.anisotropy = aniso;
      this._textures.push(t);
    }
    const mat = new THREE.MeshStandardMaterial({
      map,
      normalMap,
      roughnessMap: ormMap,
      metalnessMap: ormMap,
      aoMap: ormMap,
      roughness: 1,
      metalness: 1,
      envMapIntensity: 1.45,
      emissive: new THREE.Color(16777215),
      emissiveMap: map,
      emissiveIntensity: 0,
      name: "sponsor_board_lit"
    });
    mat.normalScale.set(0.7, 0.7);
    mat.userData.rows = td.rows;
    mat.userData.frameBand = td.frameBand;
    this._materials.push(mat);
    this._nightEmissive.push({ material: mat, day: 0.07, night: 0.85 });
    this._signMat = mat;
    return mat;
  }
  _billboard(material, key) {
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace("#include <project_vertex>", `
vec4 cardCentre = modelViewMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
vec4 mvPosition = cardCentre + vec4( transformed.xy, 0.0, 0.0 );
gl_Position = projectionMatrix * mvPosition;`);
    };
    material.customProgramCacheKey = () => key;
    material.needsUpdate = true;
    return material;
  }
  _poolTexture() {
    const w = 96;
    const h = 192;
    const data = new Uint8Array(w * h * 4);
    const rng = new Rng(523739857);
    const lanes = new Float32Array(w);
    for (let i = 0; i < w; i++) lanes[i] = rng.next();
    for (let y = 0; y < h; y++) {
      const v = (y + 0.5) / h * 2 - 1;
      for (let x = 0; x < w; x++) {
        const u = (x + 0.5) / w * 2 - 1;
        const r = Math.sqrt(u * u * 1.06 + v * v);
        const fall = Math.max(0, 1 - r);
        const lane = lanes[x];
        const streak = 0.3 + 0.62 * lane * (0.55 + 0.45 * Math.sin(v * 3.4 + lane * 9.1));
        let l = fall * fall * (0.3 + 0.7 * fall) * streak;
        l += fall * fall * fall * fall * 0.55;
        l *= 0.94 + 0.12 * rng.next();
        const cool = 0.3 * r;
        const o = (y * w + x) * 4;
        data[o] = this._encode(l * (1 - cool * 0.25));
        data[o + 1] = this._encode(l * (0.975 - cool * 0.05));
        data[o + 2] = this._encode(l * (0.9 + cool * 0.3));
        data[o + 3] = 255;
      }
    }
    const tex = makeDataTexture(data, w, h, THREE.SRGBColorSpace);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = this.ctx.materials.anisotropy ?? 4;
    this._textures.push(tex);
    return tex;
  }
  _glowTexture() {
    const s = 64;
    const data = new Uint8Array(s * s * 4);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const dx = (x + 0.5) / s * 2 - 1;
        const dy = (y + 0.5) / s * 2 - 1;
        const r = Math.min(1, Math.sqrt(dx * dx + dy * dy));
        const halo = (1 - r) ** 2.8;
        const core = Math.max(0, 1 - r * 3.4) ** 3;
        const a = clamp01(halo * 0.55 + core * 0.9);
        const o = (y * s + x) * 4;
        data[o] = 255;
        data[o + 1] = 244;
        data[o + 2] = 226;
        data[o + 3] = Math.round(a * 255);
      }
    }
    const tex = makeDataTexture(data, s, s, THREE.SRGBColorSpace);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    this._textures.push(tex);
    return tex;
  }
  _ledTexture() {
    if (this._led) return this._led;
    const td = buildLedPanels(512, 96, 7743);
    const tex = makeDataTexture(td.color, td.width, td.height, THREE.SRGBColorSpace);
    tex.anisotropy = this.ctx.materials.anisotropy ?? 4;
    this._textures.push(tex);
    this._led = { map: tex, rows: td.rows };
    return this._led;
  }
  _windowTexture() {
    const w = 112;
    const h = 48;
    const data = new Uint8Array(w * h * 4);
    const rng = new Rng(1561969671);
    const cw = 8;
    const ch = 16;
    const cols = Math.floor(w / cw);
    const rows = Math.floor(h / ch);
    const cells = new Float32Array(cols * rows);
    for (let i = 0; i < cells.length; i++) {
      cells[i] = rng.next() < 0.26 ? 0.05 : 0.55 + rng.next() * 0.55;
    }
    for (let y = 0; y < h; y++) {
      const cy = Math.min(rows - 1, Math.floor(y / ch));
      const iy = y - cy * ch;
      for (let x = 0; x < w; x++) {
        const cx = Math.min(cols - 1, Math.floor(x / cw));
        const ix = x - cx * cw;
        const mullion = ix < 1 || ix > cw - 2 || iy < 2 || iy > ch - 3 ? 0.02 : 1;
        const gradient = 0.75 + 0.45 * (1 - iy / ch);
        const l = cells[cy * cols + cx] * mullion * gradient;
        const o = (y * w + x) * 4;
        data[o] = this._encode(l * 1);
        data[o + 1] = this._encode(l * 0.95);
        data[o + 2] = this._encode(l * 0.84);
        data[o + 3] = 255;
      }
    }
    const tex = makeDataTexture(data, w, h, THREE.SRGBColorSpace);
    tex.anisotropy = this.ctx.materials.anisotropy ?? 4;
    this._textures.push(tex);
    return tex;
  }
  _garageTexture() {
    const w = 96;
    const h = 64;
    const data = new Uint8Array(w * h * 4);
    const rng = new Rng(985206610);
    for (let y = 0; y < h; y++) {
      const fy = (y + 0.5) / h;
      const floor = 0.55 + 0.75 * (1 - fy) ** 1.6;
      for (let x = 0; x < w; x++) {
        const fx = (x + 0.5) / w;
        const mouth = fx > 0.16 && fx < 0.84 ? 1 : 0.03;
        const shoulder = clamp01(Math.min(fx - 0.16, 0.84 - fx) / 0.06);
        const l = mouth * shoulder * floor * (0.92 + 0.16 * rng.next());
        const o = (y * w + x) * 4;
        data[o] = this._encode(l * 1);
        data[o + 1] = this._encode(l * 0.9);
        data[o + 2] = this._encode(l * 0.72);
        data[o + 3] = 255;
      }
    }
    const tex = makeDataTexture(data, w, h, THREE.SRGBColorSpace);
    tex.anisotropy = this.ctx.materials.anisotropy ?? 4;
    this._textures.push(tex);
    return tex;
  }
  _encode(l) {
    return Math.round(255 * clamp01(Math.pow(clamp01(l), 1 / 2.2)));
  }
  _bakeInstances(acc, geometry, matrices) {
    if (!matrices.length) return;
    const pos = geometry.attributes.position;
    const nor = geometry.attributes.normal;
    const uv = geometry.attributes.uv;
    const index = geometry.index;
    const verts = pos.count;
    for (let k = 0; k < matrices.length; k++) {
      const m = matrices[k];
      const base = acc.vertexCount;
      _bakeNormal.getNormalMatrix(m);
      for (let i = 0; i < verts; i++) {
        _bakeV.fromBufferAttribute(pos, i).applyMatrix4(m);
        acc.pos.push(_bakeV.x, _bakeV.y, _bakeV.z);
        if (nor) {
          _bakeV.fromBufferAttribute(nor, i).applyMatrix3(_bakeNormal).normalize();
          acc.nor.push(_bakeV.x, _bakeV.y, _bakeV.z);
        } else {
          acc.nor.push(0, 1, 0);
        }
        if (uv) acc.uv.push(uv.getX(i), uv.getY(i));
        else acc.uv.push(0, 0);
      }
      if (index) {
        for (let i = 0; i < index.count; i++) acc.idx.push(base + index.getX(i));
      } else {
        for (let i = 0; i < verts; i++) acc.idx.push(base + i);
      }
    }
  }
  _instance(geometry, material, matrices, name, castShadow) {
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = !!castShadow;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = name;
    this.group.add(mesh);
    return mesh;
  }
  animate(elapsed) {
    this._time.value = elapsed;
    const weather = this.ctx.sky?.weather;
    if (weather) {
      const speed = clamp(weather.windSpeed ?? 4, 0, 26) / 12;
      this._wind.value.set(Math.sin(weather.windDir ?? 0) * speed, -Math.cos(weather.windDir ?? 0) * speed);
    }
    const nf = this._nightAmount();
    if (Math.abs(nf - this._nightFactor) > 1e-3) {
      this._nightFactor = nf;
      this._applyNight(nf);
    }
    if (nf > 0.01) this._updateSpots(nf);
  }
  setQuality(tier) {
    this.tier = tier;
    if (this._crowd) this._crowd.visible = (tier?.crowdDetail ?? 1) > 0;
    for (let i = this._spotCount(); i < this._spots.length; i++) this._spots[i].intensity = 0;
  }
  dispose() {
    for (const geo of this._geometries) geo.dispose();
    for (const mat of this._materials) mat.dispose();
    for (const tex of this._textures) tex.dispose();
    for (const spot of this._spots) spot.dispose();
    this._nightFill?.dispose();
    this._geometries.length = 0;
    this._materials.length = 0;
    this._textures.length = 0;
    this._tyreStacks.length = 0;
    this._spots.length = 0;
    this._nightEmissive.length = 0;
    this._nightAdditive.length = 0;
    this._nightMeshes.length = 0;
    this._pylonSites.length = 0;
    this._marshalSites.length = 0;
    this._nightFill = null;
    this._terrainMat = null;
    this._standInner = null;
    this._standBeam = null;
    this._fenceMesh = null;
    this._fenceRailMat = null;
    this._fencePost = null;
    this._signMat = null;
    this._canopyMat = null;
    this._marshalGeo = null;
    this._bankMat = null;
    this._compoundMat = null;
    this._bankSection = null;
    this._banks = null;
    this._led = null;
    this._crowd = null;
    this.group.clear();
  }
}
