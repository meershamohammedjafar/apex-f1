import * as THREE from 'three';
import { clamp } from '../core/MathUtils.js';
import { BARRIER_NAMES } from './TrackSurface.js';

/**
 * Everything that stops a car: Armco, TecPro, tyre walls and concrete.
 *
 * Two representations are built from one pass over the margin table. The visual one is
 * an extruded profile per barrier run — a real W-beam section for the Armco, a scalloped
 * slab for the tyre wall — plus instanced posts and blocks. The collision one is a flat
 * list of 2D segments in a uniform grid, so `collide` is O(1) per query no matter how
 * many kilometres of barrier the circuit carries.
 */

const _p = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _axis = new THREE.Vector3(0, 1, 0);

/** W-beam guardrail: 310 mm deep section, 83 mm of relief, as the real profile is. */
const ARMCO_PROFILE = [
  [0.000, 0.520], [0.083, 0.560], [0.055, 0.625], [0.020, 0.675],
  [0.055, 0.725], [0.083, 0.790], [0.000, 0.830],
];
const ARMCO_HEIGHT = 0.83;
const ARMCO_THICKNESS = 0.28;
const ARMCO_POST_SPACING = 2.0;

const TYRE_HEIGHT = 1.06;
const TYRE_DEPTH = 1.45;
const TYRE_PITCH = 0.72;             // one tyre diameter, which the scallop follows

const TECPRO_HEIGHT = 1.00;
const TECPRO_DEPTH = 0.85;
const TECPRO_PITCH = 1.02;

const CONCRETE_HEIGHT = 1.05;
const CONCRETE_DEPTH = 0.42;

const BARRIER_SPEC = {
  armco: { height: ARMCO_HEIGHT, thickness: ARMCO_THICKNESS, restitution: 0.34 },
  tecpro: { height: TECPRO_HEIGHT, thickness: TECPRO_DEPTH, restitution: 0.12 },
  tyre: { height: TYRE_HEIGHT, thickness: TYRE_DEPTH, restitution: 0.18 },
  concrete: { height: CONCRETE_HEIGHT, thickness: CONCRETE_DEPTH, restitution: 0.45 },
};

const GRID_CELL = 24;

/**
 * Wind one quad of a swept grid so its faces agree with the analytic vertex normals.
 * Deciding per quad rather than per strip matters where a band pinches to nothing — the
 * pit entry, a kerb fading into the tarmac — because the sweep can change hand there.
 */
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

/** Kept at module scope: `collide` runs on the physics hot path and must not allocate. */
const BARRIER_KIND = ['armco', 'tecpro', 'tyre', 'concrete'];

export class Barriers {
  constructor(track, ctx) {
    this.track = track;
    this.ctx = ctx;
    this.group = new THREE.Group();
    this.group.name = 'barriers';
    this._geometries = [];
    this._materials = [];
    this.runs = [];
  }

  build() {
    this._collectRuns();
    this._buildCollision();
    this._buildMeshes();
  }

  /**
   * Split the per-sample barrier table into contiguous runs of one type per side, with
   * a spacing that tightens through corners so a 26 m radius hairpin does not end up
   * fenced by a chord.
   */
  _collectRuns() {
    const surf = this.track.surface;
    const n = surf.count;

    for (let sideIndex = 0; sideIndex < 2; sideIndex++) {
      const sign = sideIndex === 1 ? 1 : -1;
      let run = null;
      let sinceSample = 1e9;

      for (let step = 0; step <= n; step++) {
        const i = step % n;
        const idx = i * 2 + sideIndex;
        const typeCode = surf.barrierType[idx];
        const type = BARRIER_NAMES[typeCode];
        const offset = surf.barrierAt[idx];

        if (type === 'none') {
          if (run && run.points.length > 3) this.runs.push(run);
          run = null;
          continue;
        }

        if (!run || run.type !== type || step === n) {
          if (run && run.points.length > 3) this.runs.push(run);
          if (step === n) { run = null; break; }
          run = { type, side: sign, points: [], base: [], distance: [] };
          sinceSample = 1e9;
        }

        const kappa = Math.abs(surf.curvature[i]);
        const spacing = clamp(1.6 / Math.max(0.0008, kappa) * 0.012, 2.5, 11.0);
        sinceSample += surf.step;
        if (sinceSample < spacing) continue;
        sinceSample = 0;

        // Offsets are authored from the edge of the racing surface outward.
        const lateral = sign * (surf.width[i] + offset);
        const x = surf.posX[i] + surf.rightX[i] * lateral;
        const z = surf.posZ[i] + surf.rightZ[i] * lateral;
        const y = surf.heightAt(x, z);
        run.points.push(x, y, z);
        run.base.push(y);
        run.distance.push(i * surf.step);
      }
      if (run && run.points.length > 3) this.runs.push(run);
    }
  }

  /** Flatten every run into 2D segments and bucket them into a uniform grid. */
  _buildCollision() {
    let count = 0;
    for (const run of this.runs) count += run.points.length / 3 - 1;

    const ax = new Float32Array(count);
    const az = new Float32Array(count);
    const bx = new Float32Array(count);
    const bz = new Float32Array(count);
    const base = new Float32Array(count);
    const top = new Float32Array(count);
    const half = new Float32Array(count);
    const restitution = new Float32Array(count);
    const typeCode = new Uint8Array(count);

    let k = 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const run of this.runs) {
      const spec = BARRIER_SPEC[run.type];
      const m = run.points.length / 3;
      for (let i = 0; i < m - 1; i++) {
        ax[k] = run.points[i * 3];
        az[k] = run.points[i * 3 + 2];
        bx[k] = run.points[(i + 1) * 3];
        bz[k] = run.points[(i + 1) * 3 + 2];
        base[k] = Math.min(run.base[i], run.base[i + 1]) - 0.4;
        top[k] = Math.max(run.base[i], run.base[i + 1]) + spec.height;
        half[k] = spec.thickness * 0.5;
        restitution[k] = spec.restitution;
        typeCode[k] = BARRIER_KIND.indexOf(run.type);
        if (ax[k] < minX) minX = ax[k];
        if (ax[k] > maxX) maxX = ax[k];
        if (az[k] < minZ) minZ = az[k];
        if (az[k] > maxZ) maxZ = az[k];
        k++;
      }
    }

    this._seg = { ax, az, bx, bz, base, top, half, restitution, typeCode, count: k };

    const pad = GRID_CELL * 2;
    this._minX = minX - pad;
    this._minZ = minZ - pad;
    this._w = Math.ceil((maxX - minX + pad * 2) / GRID_CELL) + 1;
    this._h = Math.ceil((maxZ - minZ + pad * 2) / GRID_CELL) + 1;

    // A segment can straddle several cells, so bucket by its 2D bounding box. Counting
    // first lets the index list live in one flat Int32Array instead of nested arrays.
    const cells = this._w * this._h;
    const counts = new Int32Array(cells + 1);
    const cellRange = (i) => {
      const x0 = clamp(Math.floor((Math.min(ax[i], bx[i]) - this._minX) / GRID_CELL), 0, this._w - 1);
      const x1 = clamp(Math.floor((Math.max(ax[i], bx[i]) - this._minX) / GRID_CELL), 0, this._w - 1);
      const z0 = clamp(Math.floor((Math.min(az[i], bz[i]) - this._minZ) / GRID_CELL), 0, this._h - 1);
      const z1 = clamp(Math.floor((Math.max(az[i], bz[i]) - this._minZ) / GRID_CELL), 0, this._h - 1);
      return [x0, x1, z0, z1];
    };

    for (let i = 0; i < k; i++) {
      const [x0, x1, z0, z1] = cellRange(i);
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) counts[cz * this._w + cx + 1]++;
    }
    for (let c = 0; c < cells; c++) counts[c + 1] += counts[c];
    const items = new Int32Array(counts[cells]);
    const cursor = counts.slice(0, cells);
    for (let i = 0; i < k; i++) {
      const [x0, x1, z0, z1] = cellRange(i);
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const c = cz * this._w + cx;
          items[cursor[c]++] = i;
        }
      }
    }
    this._cellStart = counts;
    this._cellItems = items;
  }

  // --- collision ------------------------------------------------------------------

  /**
   * Sphere-vs-barrier. Writes `{hit, normal, penetration}` into `out` and returns it,
   * or returns null when clear. Allocation-free.
   */
  collide(worldPos, radius, out) {
    const seg = this._seg;
    if (!seg || seg.count === 0) return null;

    const x = worldPos.x;
    const y = worldPos.y;
    const z = worldPos.z;

    const cx = clamp(Math.floor((x - this._minX) / GRID_CELL), 0, this._w - 1);
    const cz = clamp(Math.floor((z - this._minZ) / GRID_CELL), 0, this._h - 1);

    let bestPen = 0;
    let bestNx = 0;
    let bestNz = 0;
    let bestRest = 0;
    let bestType = -1;

    for (let gz = Math.max(0, cz - 1); gz <= Math.min(this._h - 1, cz + 1); gz++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(this._w - 1, cx + 1); gx++) {
        const c = gz * this._w + gx;
        const start = this._cellStart[c];
        const end = this._cellStart[c + 1];
        for (let it = start; it < end; it++) {
          const i = this._cellItems[it];
          if (y + radius < seg.base[i] || y - radius > seg.top[i]) continue;

          const eX = seg.bx[i] - seg.ax[i];
          const eZ = seg.bz[i] - seg.az[i];
          const len2 = eX * eX + eZ * eZ;
          let f = len2 > 1e-9 ? ((x - seg.ax[i]) * eX + (z - seg.az[i]) * eZ) / len2 : 0;
          f = f < 0 ? 0 : f > 1 ? 1 : f;
          const px = seg.ax[i] + eX * f;
          const pz = seg.az[i] + eZ * f;
          let dx = x - px;
          let dz = z - pz;
          const dist = Math.hypot(dx, dz);
          const reach = radius + seg.half[i];
          if (dist >= reach) continue;

          const pen = reach - dist;
          if (pen > bestPen) {
            bestPen = pen;
            if (dist > 1e-6) { bestNx = dx / dist; bestNz = dz / dist; }
            else {
              // Dead centre on the segment: push out along its 2D normal instead.
              const l = Math.sqrt(len2) || 1;
              bestNx = -eZ / l; bestNz = eX / l;
            }
            bestRest = seg.restitution[i];
            bestType = seg.typeCode[i];
          }
        }
      }
    }

    if (bestPen <= 0) {
      out.hit = false;
      out.penetration = 0;
      return null;
    }
    out.hit = true;
    out.penetration = bestPen;
    out.normal.set(bestNx, 0, bestNz);
    out.restitution = bestRest;
    out.type = bestType >= 0 ? BARRIER_KIND[bestType] : 'armco';
    return out;
  }

  /** Cheap containment test used by surfaceAt to classify a point as `wall`. */
  probe(worldPos, groundY) {
    const seg = this._seg;
    if (!seg || seg.count === 0) return false;
    const x = worldPos.x;
    const z = worldPos.z;
    const cx = clamp(Math.floor((x - this._minX) / GRID_CELL), 0, this._w - 1);
    const cz = clamp(Math.floor((z - this._minZ) / GRID_CELL), 0, this._h - 1);
    const c = cz * this._w + cx;
    const start = this._cellStart[c];
    const end = this._cellStart[c + 1];
    for (let it = start; it < end; it++) {
      const i = this._cellItems[it];
      if (groundY > seg.top[i] + 0.5) continue;
      const eX = seg.bx[i] - seg.ax[i];
      const eZ = seg.bz[i] - seg.az[i];
      const len2 = eX * eX + eZ * eZ;
      let f = len2 > 1e-9 ? ((x - seg.ax[i]) * eX + (z - seg.az[i]) * eZ) / len2 : 0;
      f = f < 0 ? 0 : f > 1 ? 1 : f;
      const dx = x - (seg.ax[i] + eX * f);
      const dz = z - (seg.az[i] + eZ * f);
      if (dx * dx + dz * dz < seg.half[i] * seg.half[i]) return true;
    }
    return false;
  }

  // --- geometry -------------------------------------------------------------------

  _buildMeshes() {
    const materials = this.ctx.materials;
    const postMatrices = [];
    const tecproMatrices = [];

    for (const run of this.runs) {
      switch (run.type) {
        case 'armco':
          this._addExtrusion(run, ARMCO_PROFILE, materials.get('armco'), 1 / 4.0, 1 / 0.62, true);
          this._collectPosts(run, postMatrices, ARMCO_POST_SPACING);
          break;
        case 'tyre':
          this._addTyreWall(run, materials);
          break;
        case 'tecpro':
          this._collectTecpro(run, tecproMatrices);
          break;
        case 'concrete':
          this._addExtrusion(run, [
            [0.0, 0.0], [0.0, CONCRETE_HEIGHT - 0.22], [0.10, CONCRETE_HEIGHT - 0.05],
            [0.10, CONCRETE_HEIGHT], [CONCRETE_DEPTH, CONCRETE_HEIGHT],
          ], materials.get('concrete'), 1 / 4.0, 1 / 2.0, false);
          break;
        default:
          break;
      }
    }

    if (postMatrices.length) this._addInstanced(this._postGeometry(), this.ctx.materials.get('metal_raw'), postMatrices, 'armcoPosts');
    if (tecproMatrices.length) {
      this._addInstanced(this._tecproGeometry(), this._tecproMaterial(), tecproMatrices, 'tecproBlocks');
      this._addInstanced(this._tecproCapGeometry(), this.ctx.materials.get('paint_line'), tecproMatrices, 'tecproCaps');
    }
  }

  /**
   * Sweep a 2D profile — [outwardDepth, height] pairs — along a run. The strip is open,
   * not closed: the back of a barrier is against earth, fence or a grandstand and is
   * never seen, so it costs nothing to leave it out.
   */
  _addExtrusion(run, profile, material, uScale, vScale, doubleWall) {
    const m = run.points.length / 3;
    const p = profile.length;
    const positions = new Float32Array(m * p * 3);
    const normals = new Float32Array(m * p * 3);
    const uvs = new Float32Array(m * p * 2);
    const indices = [];

    let along = 0;
    for (let i = 0; i < m; i++) {
      const x = run.points[i * 3];
      const y = run.points[i * 3 + 1];
      const z = run.points[i * 3 + 2];

      const ip = Math.max(0, i - 1);
      const inx = Math.min(m - 1, i + 1);
      let tx = run.points[inx * 3] - run.points[ip * 3];
      let tz = run.points[inx * 3 + 2] - run.points[ip * 3 + 2];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      // The visible face points back at the track: right = (-tz, tx), so a run on the
      // right of the centreline faces -right and one on the left faces +right.
      const ox = tz * run.side;
      const oz = -tx * run.side;

      if (i > 0) {
        along += Math.hypot(x - run.points[ip * 3], z - run.points[ip * 3 + 2]);
      }

      for (let j = 0; j < p; j++) {
        const d = profile[j][0];
        const hh = profile[j][1];
        const vi = (i * p + j) * 3;
        positions[vi] = x + ox * d;
        positions[vi + 1] = y + hh;
        positions[vi + 2] = z + oz * d;

        // Profile-space normal: perpendicular to the profile polyline, rotated into
        // world by the run frame.
        const jp = Math.max(0, j - 1);
        const jn = Math.min(p - 1, j + 1);
        const pd = profile[jn][0] - profile[jp][0];
        const ph = profile[jn][1] - profile[jp][1];
        const pl = Math.hypot(pd, ph) || 1;
        const nd = ph / pl;
        const nh = -pd / pl;
        normals[vi] = ox * nd;
        normals[vi + 1] = nh;
        normals[vi + 2] = oz * nd;

        const ui = (i * p + j) * 2;
        uvs[ui] = along * uScale;
        uvs[ui + 1] = hh * vScale;
      }
    }

    for (let i = 0; i < m - 1; i++) {
      for (let j = 0; j < p - 1; j++) {
        const a = i * p + j;
        pushQuad(indices, positions, normals, a, a + 1, a + p, a + p + 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    this._geometries.push(geo);

    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `barrier_${run.type}`;
    if (doubleWall) mesh.material = material;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * The tyre wall. Rather than instancing several thousand torus rings, the slab's top
   * edge and outer face are scalloped on the same 0.72 m pitch as a tyre diameter and
   * the tyre-wall texture supplies the rest — one draw call for what would otherwise be
   * half a million triangles of silhouette.
   */
  _addTyreWall(run, materials) {
    const m = run.points.length / 3;
    const profile = [];
    const rows = 5;
    for (let r = 0; r <= rows; r++) {
      const h = (r / rows) * TYRE_HEIGHT;
      const bulge = Math.sin((r / rows) * Math.PI * 3) * 0.045;
      profile.push([r === 0 ? 0 : 0.04 + bulge, h]);
    }
    profile.push([TYRE_DEPTH * 0.35, TYRE_HEIGHT + 0.02]);
    profile.push([TYRE_DEPTH, TYRE_HEIGHT - 0.03]);

    const wall = this._addExtrusion(run, profile, materials.get('tyrewall'), 1 / TYRE_PITCH, 1 / TYRE_PITCH, false);
    wall.name = 'tyre_wall';

    // Conveyor-belt strapping: two dark bands bolted across the stack.
    for (const height of [0.34, 0.78]) {
      const strap = [[0.055, height - 0.055], [0.075, height], [0.055, height + 0.055]];
      const belt = this._addExtrusion(run, strap, materials.get('tyre_rubber'), 1 / 2.0, 1 / 0.3, false);
      belt.name = 'tyre_strap';
      belt.castShadow = false;
    }
  }

  _collectPosts(run, out, spacing) {
    const m = run.points.length / 3;
    let since = spacing;
    for (let i = 0; i < m - 1; i++) {
      const x = run.points[i * 3];
      const y = run.points[i * 3 + 1];
      const z = run.points[i * 3 + 2];
      const nx = run.points[(i + 1) * 3];
      const nz = run.points[(i + 1) * 3 + 2];
      const segLen = Math.hypot(nx - x, nz - z);
      since += segLen;
      if (since < spacing) continue;
      since = 0;
      const heading = Math.atan2(nx - x, -(nz - z));
      _q.setFromAxisAngle(_axis, -heading);
      _p.set(x, y + ARMCO_HEIGHT * 0.5 - 0.14, z);
      _m.compose(_p, _q, _s);
      out.push(_m.clone());
    }
  }

  _collectTecpro(run, out) {
    const m = run.points.length / 3;
    let since = TECPRO_PITCH;
    for (let i = 0; i < m - 1; i++) {
      const x = run.points[i * 3];
      const y = run.points[i * 3 + 1];
      const z = run.points[i * 3 + 2];
      const nx = run.points[(i + 1) * 3];
      const nz = run.points[(i + 1) * 3 + 2];
      const segLen = Math.hypot(nx - x, nz - z);
      since += segLen;
      if (since < TECPRO_PITCH) continue;
      since = 0;
      let tx = nx - x;
      let tz = nz - z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const ox = tz * run.side;
      const oz = -tx * run.side;
      const heading = Math.atan2(tx, -tz);
      _q.setFromAxisAngle(_axis, -heading);
      _p.set(x + ox * TECPRO_DEPTH * 0.5, y + TECPRO_HEIGHT * 0.5, z + oz * TECPRO_DEPTH * 0.5);
      _m.compose(_p, _q, _s);
      out.push(_m.clone());
    }
  }

  _postGeometry() {
    const geo = new THREE.BoxGeometry(0.11, ARMCO_HEIGHT * 0.9, 0.15);
    this._geometries.push(geo);
    return geo;
  }

  _tecproGeometry() {
    const geo = new THREE.BoxGeometry(TECPRO_PITCH * 0.94, TECPRO_HEIGHT, TECPRO_DEPTH);
    this._geometries.push(geo);
    return geo;
  }

  _tecproCapGeometry() {
    const geo = new THREE.BoxGeometry(TECPRO_PITCH * 0.96, 0.09, TECPRO_DEPTH * 1.02);
    geo.translate(0, TECPRO_HEIGHT * 0.5 + 0.045, 0);
    this._geometries.push(geo);
    return geo;
  }

  /** TecPro is a distinctive blue; the library has no such name, so tint anodised metal. */
  _tecproMaterial() {
    const mat = this.ctx.materials.clone('metal_anodised');
    mat.color.setHex(0x1f4fa8);
    mat.roughness = 0.55;
    mat.metalness = 0.12;
    mat.name = 'tecpro';
    return mat;
  }

  _addInstanced(geometry, material, matrices, name) {
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = name;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    return mesh;
  }

  dispose() {
    for (const geo of this._geometries) geo.dispose();
    for (const mat of this._materials) mat.dispose();
    this._geometries.length = 0;
    this._materials.length = 0;
    this.group.clear();
    this._seg = null;
    this._cellItems = null;
    this._cellStart = null;
  }
}
