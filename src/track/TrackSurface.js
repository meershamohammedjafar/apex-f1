import * as THREE from "three";
import { clamp, clamp01, smootherstep } from "../core/MathUtils.js";
import { makePeriodicSpline, DEFAULT_MARGIN } from "./CircuitData.js";
export const SURFACE_TYPES = ["asphalt", "kerb", "astroturf", "grass", "gravel", "concrete", "wall"];
const SURFACE_PROPS = {
  asphalt: { grip: 1, roughness: 0.06, drag: 0 },
  kerb: { grip: 0.85, roughness: 0.88, drag: 0.012 },
  astroturf: { grip: 0.55, roughness: 0.34, drag: 0.045 },
  grass: { grip: 0.38, roughness: 0.52, drag: 0.095 },
  gravel: { grip: 0.3, roughness: 0.78, drag: 0.24 },
  concrete: { grip: 0.94, roughness: 0.14, drag: 4e-3 },
  wall: { grip: 0.2, roughness: 1, drag: 0.5 }
};
const RUNOFF_CODES = { asphalt: 0, gravel: 1, grass: 2, concrete: 3 };
const RUNOFF_NAMES = ["asphalt", "gravel", "grass", "concrete"];
const BARRIER_CODES = { armco: 0, tecpro: 1, tyre: 2, concrete: 3, none: 4 };
export const BARRIER_NAMES = ["armco", "tecpro", "tyre", "concrete", "none"];
export const KERB_HEIGHT = 0.052;
export const KERB_RIB_PITCH = 0.25;
export const KERB_RIB_AMPLITUDE = 0.01;
export const KERB_CHAMFER = 0.16;
export const ASTRO_DROP = 0.025;
export const RUNOFF_FALL = 0.018;
export const CROWN = 0.011;
const GRID_CELL = 24;
const SAMPLE_STRIDE = 8;
const TERRAIN_CELL = 64;
const TERRAIN_PAD = 2400;
const BLEND_WIDTH = 34;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
function hash2(ix, iz, seed) {
  let h = Math.imul(ix | 0, 668265261) ^ Math.imul(iz | 0, 374761393) ^ (seed | 0);
  h = Math.imul(h ^ h >>> 15, 739982445);
  h = Math.imul(h ^ h >>> 12, 695872825);
  return ((h ^ h >>> 15) >>> 0) / 4294967296;
}
function valueNoise(x, z, seed) {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const fx = x - xi;
  const fz = z - zi;
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  const a = hash2(xi, zi, seed);
  const b = hash2(xi + 1, zi, seed);
  const c = hash2(xi, zi + 1, seed);
  const d = hash2(xi + 1, zi + 1, seed);
  return a + (b - a) * ux + (c + (d - c) * ux - (a + (b - a) * ux)) * uz;
}
export class TrackSurface {
  constructor(curve, circuit, layout, options = {}) {
    this.curve = curve;
    this.circuit = circuit;
    this.marks = layout.marks;
    this.barriers = null;
    this._buildTables(curve, circuit, layout, options);
    this._buildMargins(circuit);
    this._buildGrid();
    this._buildTerrain();
    this._scratchField = this.createLocateResult();
    this._buildCorridorField();
    this._scratch = this.createLocateResult();
    this._scratch2 = this.createLocateResult();
  }
  _buildTables(curve, circuit, layout, options) {
    const control = layout.count;
    const fine = control * 6;
    const cum = new Float64Array(fine + 1);
    const fx = new Float64Array(fine + 1);
    const fy = new Float64Array(fine + 1);
    const fz = new Float64Array(fine + 1);
    for (let i = 0; i <= fine; i++) {
      curve.getPoint(i % fine / fine, _v);
      fx[i] = _v.x;
      fy[i] = _v.y;
      fz[i] = _v.z;
      if (i > 0) {
        cum[i] = cum[i - 1] + Math.hypot(fx[i] - fx[i - 1], fy[i] - fy[i - 1], fz[i] - fz[i - 1]);
      }
    }
    const length = cum[fine];
    this.length = length;
    const spacing = options.sampleSpacing ?? 1;
    const n = Math.max(256, Math.round(length / spacing));
    this.count = n;
    this.step = length / n;
    const px = new Float32Array(n);
    const py = new Float32Array(n);
    const pz = new Float32Array(n);
    let seek = 0;
    for (let i = 0; i < n; i++) {
      const s = i * length / n;
      while (seek < fine && cum[seek + 1] < s) seek++;
      const span = cum[seek + 1] - cum[seek];
      const f = span > 1e-9 ? (s - cum[seek]) / span : 0;
      px[i] = fx[seek] + (fx[seek + 1] - fx[seek]) * f;
      py[i] = fy[seek] + (fy[seek + 1] - fy[seek]) * f;
      pz[i] = fz[seek] + (fz[seek + 1] - fz[seek]) * f;
    }
    this.posX = px;
    this.posY = py;
    this.posZ = pz;
    const tanX = new Float32Array(n);
    const tanY = new Float32Array(n);
    const tanZ = new Float32Array(n);
    const rightX = new Float32Array(n);
    const rightZ = new Float32Array(n);
    const curvature = new Float32Array(n);
    const gradient = new Float32Array(n);
    const inv2h = 1 / (2 * this.step);
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      let tx = (px[b] - px[a]) * inv2h;
      let ty = (py[b] - py[a]) * inv2h;
      let tz = (pz[b] - pz[a]) * inv2h;
      const len = Math.hypot(tx, ty, tz) || 1;
      tx /= len;
      ty /= len;
      tz /= len;
      tanX[i] = tx;
      tanY[i] = ty;
      tanZ[i] = tz;
      const rx = -tz;
      const rz = tx;
      const rl = Math.hypot(rx, rz) || 1;
      rightX[i] = rx / rl;
      rightZ[i] = rz / rl;
      gradient[i] = Math.asin(clamp(ty, -1, 1));
    }
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n;
      const b = (i + 1) % n;
      const ha = Math.atan2(tanX[a], -tanZ[a]);
      const hb = Math.atan2(tanX[b], -tanZ[b]);
      let dh = hb - ha;
      while (dh > Math.PI) dh -= Math.PI * 2;
      while (dh < -Math.PI) dh += Math.PI * 2;
      curvature[i] = -dh * inv2h;
    }
    this.tanX = tanX;
    this.tanY = tanY;
    this.tanZ = tanZ;
    this.rightX = rightX;
    this.rightZ = rightZ;
    this.curvature = curvature;
    this.gradient = gradient;
    const widthAt = makePeriodicSpline(circuit.width, layout.analyticLength);
    const bankAt = makePeriodicSpline(circuit.banking, layout.analyticLength);
    const width = new Float32Array(n);
    const banking = new Float32Array(n);
    const normX = new Float32Array(n);
    const normY = new Float32Array(n);
    const normZ = new Float32Array(n);
    const scaleToAnalytic = layout.analyticLength / length;
    for (let i = 0; i < n; i++) {
      const d = i * this.step * scaleToAnalytic;
      width[i] = widthAt(d);
      const b = bankAt(d) * (Math.PI / 180);
      banking[i] = b;
      const rx = rightX[i], rz = rightZ[i];
      const tx = tanX[i], ty = tanY[i], tz = tanZ[i];
      const n0x = -rz * ty;
      const n0y = rz * tx - rx * tz;
      const n0z = rx * ty;
      const cb = Math.cos(b);
      const sb = Math.sin(b);
      let nx = cb * n0x + sb * rx;
      let ny = cb * n0y;
      let nz = cb * n0z + sb * rz;
      const nl = Math.hypot(nx, ny, nz) || 1;
      normX[i] = nx / nl;
      normY[i] = ny / nl;
      normZ[i] = nz / nl;
    }
    this.width = width;
    this.banking = banking;
    this.normX = normX;
    this.normY = normY;
    this.normZ = normZ;
    this.tanBank = new Float32Array(n);
    for (let i = 0; i < n; i++) this.tanBank[i] = Math.tan(banking[i]);
  }
  _buildMargins(circuit) {
    const n = this.count;
    const kerb = new Float32Array(n * 2);
    const astro = new Float32Array(n * 2);
    const runoff = new Float32Array(n * 2);
    const runoffType = new Uint8Array(n * 2);
    const barrierAt = new Float32Array(n * 2);
    const barrierType = new Uint8Array(n * 2);
    const def = circuit.defaultMargin ?? DEFAULT_MARGIN;
    for (let i = 0; i < n * 2; i++) {
      astro[i] = def.astro;
      runoff[i] = def.runoffWidth;
      runoffType[i] = RUNOFF_CODES[def.runoff];
      barrierAt[i] = def.barrierAt;
      barrierType[i] = BARRIER_CODES[def.barrier];
    }
    const total = this.length;
    const applyRange = (from, to, side, fn) => {
      const a = Math.round(from / total * n);
      let b = Math.round(to / total * n);
      if (b <= a) b += n;
      for (let k = a; k < b; k++) {
        const i = (k % n + n) % n;
        if (side <= 0) fn(i * 2);
        if (side >= 0) fn(i * 2 + 1);
      }
    };
    for (const m of circuit.margins) {
      applyRange(m.from, m.to, m.side, (idx) => {
        astro[idx] = m.astro;
        runoff[idx] = m.runoffWidth;
        runoffType[idx] = RUNOFF_CODES[m.runoff] ?? RUNOFF_CODES.grass;
        barrierAt[idx] = m.barrierAt;
        barrierType[idx] = BARRIER_CODES[m.barrier] ?? BARRIER_CODES.armco;
      });
    }
    this.kerbSpans = [];
    for (const corner of circuit.corners) {
      const mark = this.marks[corner.seg];
      if (!mark) continue;
      const right = this._segmentTurnsRight(corner.seg);
      const inside = right ? 1 : -1;
      const insideFrom = mark.start - Math.min(30, corner.entry ?? 0);
      const insideTo = mark.end + 12;
      applyRange(insideFrom, insideTo, inside, (idx) => {
        kerb[idx] = 1;
      });
      this.kerbSpans.push({ from: insideFrom, to: insideTo, side: inside, style: "kerb", corner: corner.number });
      if (this._segmentRadius(corner.seg) < 240) {
        const outFrom = mark.start + mark.length * 0.45;
        const outTo = mark.end + (corner.exit ?? 30) * 0.8;
        applyRange(outFrom, outTo, -inside, (idx) => {
          kerb[idx] = 1;
        });
        this.kerbSpans.push({ from: outFrom, to: outTo, side: -inside, style: "kerb_exit", corner: corner.number });
      }
    }
    const scoop = new Float32Array(n * 2);
    for (let i = 0; i < n * 2; i++) scoop[i] = runoffType[i] === RUNOFF_CODES.gravel ? 0.55 : 0;
    this.kerbWidth = kerb;
    this.astroWidth = astro;
    this.runoffWidth = runoff;
    this.runoffType = runoffType;
    this.barrierAt = barrierAt;
    this.barrierType = barrierType;
    this.scoop = scoop;
    this._blendAlong(this.astroWidth, 14);
    this._blendAlong(this.runoffWidth, 18);
    this._blendAlong(this.barrierAt, 18);
    this._blendAlong(this.scoop, 18);
    this._blendAlong(this.kerbWidth, 3);
  }
  _blendAlong(field, radius) {
    const n = this.count;
    const copy = Float32Array.from(field);
    const inv = 1 / (radius * 2 + 1);
    for (let side = 0; side < 2; side++) {
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let o = -radius; o <= radius; o++) sum += copy[((i + o) % n + n) % n * 2 + side];
        field[i * 2 + side] = sum * inv;
      }
    }
  }
  _segmentAngle(id) {
    for (const seg of this.circuit.program) {
      if (seg[0] === "a" && seg[3] === id) return seg[2];
    }
    return 0;
  }
  _segmentTurnsRight(id) {
    return this._segmentAngle(id) > 0;
  }
  _segmentRadius(id) {
    for (const seg of this.circuit.program) {
      if (seg[0] === "a" && seg[3] === id) return seg[1];
    }
    return Infinity;
  }
  _buildGrid() {
    const n = this.count;
    const m = Math.ceil(n / SAMPLE_STRIDE);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      if (this.posX[i] < minX) minX = this.posX[i];
      if (this.posX[i] > maxX) maxX = this.posX[i];
      if (this.posZ[i] < minZ) minZ = this.posZ[i];
      if (this.posZ[i] > maxZ) maxZ = this.posZ[i];
    }
    this.bounds = { minX, maxX, minZ, maxZ };
    const pad = GRID_CELL * 2;
    this._gridMinX = minX - pad;
    this._gridMinZ = minZ - pad;
    this._gridW = Math.ceil((maxX - minX + pad * 2) / GRID_CELL) + 1;
    this._gridH = Math.ceil((maxZ - minZ + pad * 2) / GRID_CELL) + 1;
    const head = new Int32Array(this._gridW * this._gridH).fill(-1);
    const next = new Int32Array(m).fill(-1);
    for (let k = 0; k < m; k++) {
      const i = k * SAMPLE_STRIDE;
      const cx = clamp(Math.floor((this.posX[i] - this._gridMinX) / GRID_CELL), 0, this._gridW - 1);
      const cz = clamp(Math.floor((this.posZ[i] - this._gridMinZ) / GRID_CELL), 0, this._gridH - 1);
      const cell = cz * this._gridW + cx;
      next[k] = head[cell];
      head[cell] = k;
    }
    this._gridHead = head;
    this._gridNext = next;
    this._gridCount = m;
  }
  _buildTerrain() {
    const b = this.bounds;
    const minX = b.minX - TERRAIN_PAD;
    const minZ = b.minZ - TERRAIN_PAD;
    const w = Math.ceil((b.maxX - b.minX + TERRAIN_PAD * 2) / TERRAIN_CELL) + 1;
    const h = Math.ceil((b.maxZ - b.minZ + TERRAIN_PAD * 2) / TERRAIN_CELL) + 1;
    const field = new Float32Array(w * h);
    const weight = new Float32Array(w * h);
    const fixed = new Uint8Array(w * h);
    for (let i = 0; i < this.count; i++) {
      const cx = clamp(Math.round((this.posX[i] - minX) / TERRAIN_CELL), 0, w - 1);
      const cz = clamp(Math.round((this.posZ[i] - minZ) / TERRAIN_CELL), 0, h - 1);
      const idx = cz * w + cx;
      field[idx] += this.posY[i];
      weight[idx] += 1;
    }
    for (let i = 0; i < field.length; i++) {
      if (weight[i] > 0) {
        field[i] /= weight[i];
        fixed[i] = 1;
      }
    }
    const tmp = new Float32Array(field.length);
    let seeded = 0;
    for (let i = 0; i < fixed.length; i++) if (fixed[i]) seeded += field[i];
    const mean = seeded / Math.max(1, fixed.reduce((a, v) => a + v, 0));
    for (let i = 0; i < field.length; i++) if (!fixed[i]) field[i] = mean;
    for (let pass = 0; pass < 240; pass++) {
      for (let z = 0; z < h; z++) {
        for (let x = 0; x < w; x++) {
          const i = z * w + x;
          if (fixed[i]) {
            tmp[i] = field[i];
            continue;
          }
          const l = field[z * w + Math.max(0, x - 1)];
          const r = field[z * w + Math.min(w - 1, x + 1)];
          const u = field[Math.max(0, z - 1) * w + x];
          const d = field[Math.min(h - 1, z + 1) * w + x];
          tmp[i] = (l + r + u + d) * 0.25;
        }
      }
      field.set(tmp);
    }
    this._terrain = { field, w, h, minX, minZ, cell: TERRAIN_CELL };
  }
  _buildCorridorField() {
    const b = this.bounds;
    const pad = 280;
    const cell = 5;
    const minX = b.minX - pad;
    const minZ = b.minZ - pad;
    const w = Math.ceil((b.maxX - b.minX + pad * 2) / cell) + 1;
    const h = Math.ceil((b.maxZ - b.minZ + pad * 2) / cell) + 1;
    const field = new Float32Array(w * h);
    const loc = this._scratchField;
    for (let iz = 0; iz < h; iz++) {
      for (let ix = 0; ix < w; ix++) {
        const x = minX + ix * cell;
        const z = minZ + iz * cell;
        _v2.set(x, 0, z);
        this.locate(_v2, loc);
        const a = Math.abs(loc.lateral);
        const i = loc.index * 2 + (loc.lateral >= 0 ? 1 : 0);
        const outer = loc.width + this.kerbWidth[i] + this.astroWidth[i] + this.runoffWidth[i];
        const analytic = loc.position.y + this.crossSectionHeight(loc.index, loc.lateral, loc.distance);
        const clearance = Math.max(0, a - outer);
        const blend = smootherstep(0, BLEND_WIDTH, clearance);
        const terrain = this.terrainHeightAt(x, z, clearance);
        field[iz * w + ix] = analytic + (terrain - analytic) * blend;
      }
    }
    const tmp = new Float32Array(field.length);
    for (let pass = 0; pass < 2; pass++) {
      for (let iz = 0; iz < h; iz++) {
        for (let ix = 0; ix < w; ix++) {
          const xm = Math.max(0, ix - 1);
          const xp = Math.min(w - 1, ix + 1);
          const zm = Math.max(0, iz - 1);
          const zp = Math.min(h - 1, iz + 1);
          tmp[iz * w + ix] = (field[zm * w + xm] + field[zm * w + ix] + field[zm * w + xp] + field[iz * w + xm] + field[iz * w + ix] * 2 + field[iz * w + xp] + field[zp * w + xm] + field[zp * w + ix] + field[zp * w + xp]) / 10;
        }
      }
      field.set(tmp);
    }
    this._corridor = {
      field,
      w,
      h,
      minX,
      minZ,
      cell,
      maxX: minX + (w - 1) * cell,
      maxZ: minZ + (h - 1) * cell
    };
  }
  corridorHeightAt(x, z) {
    const t = this._corridor;
    const fx = clamp((x - t.minX) / t.cell, 0, t.w - 1.001);
    const fz = clamp((z - t.minZ) / t.cell, 0, t.h - 1.001);
    const ix = fx | 0;
    const iz = fz | 0;
    const ux = fx - ix;
    const uz = fz - iz;
    const f = t.field;
    const w = t.w;
    const a = f[iz * w + ix];
    const bb = f[iz * w + ix + 1];
    const c = f[(iz + 1) * w + ix];
    const d = f[(iz + 1) * w + ix + 1];
    const top = a + (bb - a) * ux;
    return top + (c + (d - c) * ux - top) * uz;
  }
  regionalHeight(x, z) {
    const t = this._terrain;
    const fx = clamp((x - t.minX) / t.cell, 0, t.w - 1.001);
    const fz = clamp((z - t.minZ) / t.cell, 0, t.h - 1.001);
    const ix = fx | 0;
    const iz = fz | 0;
    const ux = fx - ix;
    const uz = fz - iz;
    const f = t.field;
    const w = t.w;
    const a = f[iz * w + ix];
    const bb = f[iz * w + ix + 1];
    const c = f[(iz + 1) * w + ix];
    const d = f[(iz + 1) * w + ix + 1];
    return a + (bb - a) * ux + (c + (d - c) * ux - (a + (bb - a) * ux)) * uz;
  }
  terrainHeightAt(x, z, clearance = 1e6) {
    const base = this.regionalHeight(x, z);
    const relief = smootherstep(0, 300, clearance);
    if (relief <= 0) return base;
    const n1 = valueNoise(x / 1300, z / 1300, 17) - 0.5;
    const n2 = valueNoise(x / 470, z / 470, 91) - 0.5;
    const n3 = valueNoise(x / 185, z / 185, 233) - 0.5;
    const n4 = valueNoise(x / 68, z / 68, 577) - 0.5;
    return base + (n1 * 24 + n2 * 9.5 + n3 * 3.6 + n4 * 1.25) * relief;
  }
  createLocateResult() {
    return {
      t: 0,
      distance: 0,
      lateral: 0,
      onTrack: false,
      index: 0,
      position: new THREE.Vector3(),
      tangent: new THREE.Vector3(),
      right: new THREE.Vector3(),
      normal: new THREE.Vector3(),
      width: 0,
      banking: 0,
      curvature: 0,
      gradient: 0
    };
  }
  createSurfaceResult() {
    return {
      height: 0,
      normal: new THREE.Vector3(0, 1, 0),
      grip: 1,
      type: "asphalt",
      roughness: 0,
      drag: 0,
      lateral: 0,
      t: 0,
      side: 1,
      depth: 0
    };
  }
  _broadPhase(x, z) {
    const gx = clamp(Math.floor((x - this._gridMinX) / GRID_CELL), 0, this._gridW - 1);
    const gz = clamp(Math.floor((z - this._gridMinZ) / GRID_CELL), 0, this._gridH - 1);
    let best = -1;
    let bestD = Infinity;
    for (let ring = 0; ring <= 3; ring++) {
      const x0 = Math.max(0, gx - ring);
      const x1 = Math.min(this._gridW - 1, gx + ring);
      const z0 = Math.max(0, gz - ring);
      const z1 = Math.min(this._gridH - 1, gz + ring);
      for (let cz = z0; cz <= z1; cz++) {
        const edgeZ = cz === z0 || cz === z1;
        for (let cx = x0; cx <= x1; cx++) {
          if (ring > 0 && !edgeZ && cx !== x0 && cx !== x1) continue;
          let k = this._gridHead[cz * this._gridW + cx];
          while (k >= 0) {
            const i = k * SAMPLE_STRIDE;
            const dx = this.posX[i] - x;
            const dz = this.posZ[i] - z;
            const d2 = dx * dx + dz * dz;
            if (d2 < bestD) {
              bestD = d2;
              best = i;
            }
            k = this._gridNext[k];
          }
        }
      }
      if (best >= 0 && ring >= 1) return best;
    }
    if (best < 0) {
      for (let i = 0; i < this.count; i += SAMPLE_STRIDE) {
        const dx = this.posX[i] - x;
        const dz = this.posZ[i] - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD) {
          bestD = d2;
          best = i;
        }
      }
    }
    return best;
  }
  locate(worldPos, out) {
    const x = worldPos.x;
    const z = worldPos.z;
    const n = this.count;
    let seed = this._broadPhase(x, z);
    if (seed < 0) seed = 0;
    let best = seed;
    let bestD = Infinity;
    for (let o = -SAMPLE_STRIDE; o <= SAMPLE_STRIDE; o++) {
      const i = (seed + o + n) % n;
      const dx = this.posX[i] - x;
      const dz = this.posZ[i] - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) {
        bestD = d2;
        best = i;
      }
    }
    let bestT = 0;
    let bestSeg = best;
    let bestDist = Infinity;
    for (let o = -1; o <= 0; o++) {
      const a2 = (best + o + n) % n;
      const b2 = (a2 + 1) % n;
      const ax2 = this.posX[a2], az2 = this.posZ[a2];
      const ex = this.posX[b2] - ax2, ez = this.posZ[b2] - az2;
      const len2 = ex * ex + ez * ez;
      let f2 = len2 > 1e-12 ? ((x - ax2) * ex + (z - az2) * ez) / len2 : 0;
      f2 = f2 < 0 ? 0 : f2 > 1 ? 1 : f2;
      const cx = ax2 + ex * f2;
      const cz = az2 + ez * f2;
      const d2 = (cx - x) * (cx - x) + (cz - z) * (cz - z);
      if (d2 < bestDist) {
        bestDist = d2;
        bestSeg = a2;
        bestT = f2;
      }
    }
    const a = bestSeg;
    const b = (a + 1) % n;
    const f = bestT;
    const distance = (a + f) * this.step;
    out.index = a;
    out.distance = distance;
    out.t = distance / this.length;
    const ax = this.posX[a], ay = this.posY[a], az = this.posZ[a];
    out.position.set(
      ax + (this.posX[b] - ax) * f,
      ay + (this.posY[b] - ay) * f,
      az + (this.posZ[b] - az) * f
    );
    let tx = this.tanX[a] + (this.tanX[b] - this.tanX[a]) * f;
    let ty = this.tanY[a] + (this.tanY[b] - this.tanY[a]) * f;
    let tz = this.tanZ[a] + (this.tanZ[b] - this.tanZ[a]) * f;
    const tl = Math.hypot(tx, ty, tz) || 1;
    out.tangent.set(tx / tl, ty / tl, tz / tl);
    let rx = this.rightX[a] + (this.rightX[b] - this.rightX[a]) * f;
    let rz = this.rightZ[a] + (this.rightZ[b] - this.rightZ[a]) * f;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl;
    rz /= rl;
    out.right.set(rx, 0, rz);
    let nx = this.normX[a] + (this.normX[b] - this.normX[a]) * f;
    let ny = this.normY[a] + (this.normY[b] - this.normY[a]) * f;
    let nz = this.normZ[a] + (this.normZ[b] - this.normZ[a]) * f;
    const nl = Math.hypot(nx, ny, nz) || 1;
    out.normal.set(nx / nl, ny / nl, nz / nl);
    out.width = this.width[a] + (this.width[b] - this.width[a]) * f;
    out.banking = this.banking[a] + (this.banking[b] - this.banking[a]) * f;
    out.curvature = this.curvature[a] + (this.curvature[b] - this.curvature[a]) * f;
    out.gradient = this.gradient[a] + (this.gradient[b] - this.gradient[a]) * f;
    out.lateral = (x - out.position.x) * rx + (z - out.position.z) * rz;
    out.onTrack = Math.abs(out.lateral) <= out.width;
    return out;
  }
  sample(t, out) {
    let u = t % 1;
    if (u < 0) u += 1;
    const n = this.count;
    const fi = u * n;
    const a = Math.floor(fi) % n;
    const b = (a + 1) % n;
    const f = fi - Math.floor(fi);
    out.distance = u * this.length;
    out.t = u;
    const ax = this.posX[a], ay = this.posY[a], az = this.posZ[a];
    out.position.set(
      ax + (this.posX[b] - ax) * f,
      ay + (this.posY[b] - ay) * f,
      az + (this.posZ[b] - az) * f
    );
    let tx = this.tanX[a] + (this.tanX[b] - this.tanX[a]) * f;
    let ty = this.tanY[a] + (this.tanY[b] - this.tanY[a]) * f;
    let tz = this.tanZ[a] + (this.tanZ[b] - this.tanZ[a]) * f;
    const tl = Math.hypot(tx, ty, tz) || 1;
    out.tangent.set(tx / tl, ty / tl, tz / tl);
    let rx = this.rightX[a] + (this.rightX[b] - this.rightX[a]) * f;
    let rz = this.rightZ[a] + (this.rightZ[b] - this.rightZ[a]) * f;
    const rl = Math.hypot(rx, rz) || 1;
    out.right.set(rx / rl, 0, rz / rl);
    let nx = this.normX[a] + (this.normX[b] - this.normX[a]) * f;
    let ny = this.normY[a] + (this.normY[b] - this.normY[a]) * f;
    let nz = this.normZ[a] + (this.normZ[b] - this.normZ[a]) * f;
    const nl = Math.hypot(nx, ny, nz) || 1;
    out.normal.set(nx / nl, ny / nl, nz / nl);
    out.width = this.width[a] + (this.width[b] - this.width[a]) * f;
    out.banking = this.banking[a] + (this.banking[b] - this.banking[a]) * f;
    out.curvature = this.curvature[a] + (this.curvature[b] - this.curvature[a]) * f;
    out.gradient = this.gradient[a] + (this.gradient[b] - this.gradient[a]) * f;
    out.lateral = 0;
    out.onTrack = true;
    out.index = a;
    return out;
  }
  marginAt(index, side, out) {
    const i = index * 2 + side;
    out.kerb = this.kerbWidth[i];
    out.astro = this.astroWidth[i];
    out.runoff = this.runoffWidth[i];
    out.runoffType = this.runoffType[i];
    out.barrierAt = this.barrierAt[i];
    out.barrierType = this.barrierType[i];
    return out;
  }
  crossSectionHeight(index, lateral, distance) {
    const side = lateral >= 0 ? 1 : 0;
    const i = index * 2 + side;
    const a = Math.abs(lateral);
    const w = this.width[index];
    const bank = this.tanBank[index];
    const ca = a < w ? a : w;
    let y = -lateral * bank - CROWN * ca * ca / w;
    if (a <= w) return y;
    const kerbW = this.kerbWidth[i];
    if (kerbW > 0 && a <= w + kerbW) {
      const u2 = (a - w) / kerbW;
      const chamferIn = clamp01((a - w) / KERB_CHAMFER);
      const chamferOut = clamp01((w + kerbW - a) / (KERB_CHAMFER * 0.7));
      const plateau = Math.min(chamferIn, chamferOut);
      const rib = 0.5 - 0.5 * Math.cos(distance / KERB_RIB_PITCH * Math.PI * 2);
      const crown = Math.sin(u2 * Math.PI) * 6e-3;
      return y + plateau * (KERB_HEIGHT + crown + rib * KERB_RIB_AMPLITUDE);
    }
    const kerbEdge = w + kerbW;
    const astroW = this.astroWidth[i];
    if (a <= kerbEdge + astroW) {
      const u2 = clamp01((a - kerbEdge) / Math.max(0.05, astroW));
      return y - ASTRO_DROP * smootherstep(0, 0.4, u2);
    }
    const astroEdge = kerbEdge + astroW;
    const runoffW = this.runoffWidth[i];
    const over = Math.min(a - astroEdge, runoffW);
    const u = runoffW > 0.5 ? over / runoffW : 0;
    return y - ASTRO_DROP - this.scoop[i] * Math.sin(u * Math.PI) - over * RUNOFF_FALL;
  }
  applyPitCorridor(nodes, analyticLength) {
    const n = this.count;
    const offset = new Float32Array(n);
    const half = new Float32Array(n);
    const scale = this.length / analyticLength;
    let previous = nodes[0][0];
    let unwrapped = 0;
    const keys = [[0, nodes[0][1], nodes[0][2]]];
    for (let i = 1; i < nodes.length; i++) {
      let d = nodes[i][0];
      while (d < previous) d += analyticLength;
      unwrapped += d - previous;
      previous = d;
      keys.push([unwrapped, nodes[i][1], nodes[i][2]]);
    }
    const span = keys[keys.length - 1][0];
    const startIndex = Math.round(nodes[0][0] * scale / this.length * n);
    const steps = Math.max(2, Math.round(span * scale / this.step));
    for (let s = 0; s <= steps; s++) {
      const along = span * s / steps;
      let j = 0;
      while (j < keys.length - 2 && keys[j + 1][0] < along) j++;
      const seg = keys[j + 1][0] - keys[j][0];
      const f = clamp01(seg > 1e-6 ? (along - keys[j][0]) / seg : 0);
      const smooth = f * f * (3 - 2 * f);
      const i = ((startIndex + s) % n + n) % n;
      offset[i] = keys[j][1] + (keys[j + 1][1] - keys[j][1]) * smooth;
      half[i] = keys[j][2] + (keys[j + 1][2] - keys[j][2]) * smooth;
    }
    this.pitOffset = offset;
    this.pitHalf = half;
    this.pitSpan = span;
    return this;
  }
  _pitHeight(index, lateral) {
    return -lateral * this.tanBank[index] - CROWN * this.width[index];
  }
  heightAt(x, z) {
    const c = this._corridor;
    if (x < c.minX || x > c.maxX || z < c.minZ || z > c.maxZ) {
      return this.terrainHeightAt(x, z);
    }
    _v2.set(x, 0, z);
    const loc = this.locate(_v2, this._scratch);
    const a = Math.abs(loc.lateral);
    if (this.pitHalf && a > loc.width) {
      const ph = this.pitHalf[loc.index];
      if (ph > 0 && Math.abs(loc.lateral - this.pitOffset[loc.index]) <= ph) {
        return loc.position.y + this._pitHeight(loc.index, loc.lateral);
      }
    }
    const side = loc.lateral >= 0 ? 1 : 0;
    const i = loc.index * 2 + side;
    const precise = loc.width + this.kerbWidth[i] + this.astroWidth[i];
    const analytic = loc.position.y + this.crossSectionHeight(loc.index, loc.lateral, loc.distance);
    if (a <= precise) return analytic;
    const handover = smootherstep(precise, precise + 7, a);
    return analytic + (this.corridorHeightAt(x, z) - analytic) * handover;
  }
  surfaceAt(worldPos, out) {
    const loc = this.locate(worldPos, this._scratch2);
    const a = Math.abs(loc.lateral);
    const side = loc.lateral >= 0 ? 1 : 0;
    const i = loc.index * 2 + side;
    if (this.pitHalf && Math.abs(loc.lateral) > loc.width) {
      const ph = this.pitHalf[loc.index];
      if (ph > 0 && Math.abs(loc.lateral - this.pitOffset[loc.index]) <= ph) {
        const props2 = SURFACE_PROPS.asphalt;
        out.type = "asphalt";
        out.grip = props2.grip;
        out.roughness = props2.roughness;
        out.drag = props2.drag;
        out.lateral = loc.lateral;
        out.t = loc.t;
        out.side = loc.lateral >= 0 ? 1 : -1;
        out.depth = 0;
        out.height = loc.position.y + this._pitHeight(loc.index, loc.lateral);
        out.normal.copy(loc.normal);
        return out;
      }
    }
    const w = loc.width;
    const kerbW = this.kerbWidth[i];
    const astroW = this.astroWidth[i];
    const runoffW = this.runoffWidth[i];
    const wallAt = w + this.barrierAt[i];
    let type;
    if (a <= w) type = "asphalt";
    else if (kerbW > 0 && a <= w + kerbW) type = "kerb";
    else if (a <= w + kerbW + astroW) type = "astroturf";
    else if (a <= w + kerbW + astroW + runoffW) type = RUNOFF_NAMES[this.runoffType[i]];
    else type = "grass";
    if (a >= wallAt) type = "wall";
    const props = SURFACE_PROPS[type];
    out.type = type;
    out.grip = props.grip;
    out.roughness = props.roughness;
    out.drag = props.drag;
    out.lateral = loc.lateral;
    out.t = loc.t;
    out.side = loc.lateral >= 0 ? 1 : -1;
    out.depth = Math.max(0, a - (w + kerbW + astroW));
    const outer = w + kerbW + astroW + runoffW;
    if (a <= outer) {
      out.height = loc.position.y + this.crossSectionHeight(loc.index, loc.lateral, loc.distance);
      out.normal.copy(loc.normal);
      const e = 0.25;
      const dy = this.crossSectionHeight(loc.index, loc.lateral + e, loc.distance) - this.crossSectionHeight(loc.index, loc.lateral - e, loc.distance);
      out.normal.addScaledVector(loc.right, -dy / (2 * e)).normalize();
      if (type === "kerb") {
        const slope = Math.PI * 2 / KERB_RIB_PITCH * 0.5 * Math.sin(loc.distance / KERB_RIB_PITCH * Math.PI * 2) * KERB_RIB_AMPLITUDE;
        out.normal.addScaledVector(loc.tangent, -slope).normalize();
      }
    } else {
      out.height = this.heightAt(worldPos.x, worldPos.z);
      const e = 1;
      const hx = this.heightAt(worldPos.x + e, worldPos.z) - this.heightAt(worldPos.x - e, worldPos.z);
      const hz = this.heightAt(worldPos.x, worldPos.z + e) - this.heightAt(worldPos.x, worldPos.z - e);
      out.normal.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
    }
    if (this.barriers) {
      const hit = this.barriers.probe(worldPos, out.height);
      if (hit) out.type = "wall";
      if (hit) {
        out.grip = SURFACE_PROPS.wall.grip;
        out.roughness = SURFACE_PROPS.wall.roughness;
        out.drag = SURFACE_PROPS.wall.drag;
      }
    }
    return out;
  }
  static gripFor(type) {
    return SURFACE_PROPS[type]?.grip ?? 1;
  }
  dispose() {
    this._gridHead = null;
    this._gridNext = null;
    this._terrain = null;
  }
}
