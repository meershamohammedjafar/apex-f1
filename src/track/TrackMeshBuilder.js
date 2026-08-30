import * as THREE from 'three';
import { clamp, clamp01, smoothstep } from '../core/MathUtils.js';
import { createCanvas } from '../render/textures/NoiseTextures.js';
import { KERB_HEIGHT, KERB_CHAMFER, ASTRO_DROP, RUNOFF_FALL, CROWN } from './TrackSurface.js';

/**
 * Sweeps every drivable and non-drivable surface along the centreline.
 *
 * The ribbon is not one mesh. Asphalt, kerb, astroturf verge, run-off and the grass
 * apron are separate sweeps with their own materials, their own cross-sections and their
 * own tessellation, because they are separate physical things — a kerb is 52 mm of cast
 * concrete with a serrated top, not a stripe painted on the tarmac.
 *
 * Tessellation along the track is curvature driven. The sagitta of a chord across a
 * circle of radius R is s^2/8R, so solving for a 20 mm tolerance gives the station
 * spacing: about 1.7 m through La Source, the full 12 m cap down Kemmel. Normals are
 * computed analytically from the same cross-section functions the physics queries use,
 * never by averaging faces, so the shading is continuous across every chunk boundary
 * and matches what the tyres are standing on.
 */

const CHUNKS = 12;
const SAG_TOLERANCE = 0.02;
const APRON_WIDTH = 52;             // grass from the paved edge out to the terrain mesh
const LINE_WIDTH = 0.10;            // FIA track-limit line
const GRID_BOX_WIDTH = 2.7;
const GRID_BOX_LENGTH = 6.0;
/** Cast kerb sections butt together every two metres; the joint is a shallow scallop. */
const KERB_SECTION_PITCH = 2.0;
const KERB_SECTION_DEPTH = 0.010;
const KERB_STATION_STEP = 0.5;

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

/**
 * Stroke outlines for the painted numerals on the grid boxes and braking boards.
 * Rendered to a canvas atlas and used as an alpha mask over the paint_line material, so
 * the numbers weather exactly like every other painted marking on the circuit.
 */
function buildDigitAtlas(cellPx = 96) {
  const canvas = createCanvas(cellPx * 10, cellPx);
  const c = canvas.getContext('2d', { willReadFrequently: true });
  c.clearRect(0, 0, cellPx * 10, cellPx);
  c.fillStyle = '#ffffff';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = `700 ${Math.round(cellPx * 0.82)}px "Arial Narrow", "Helvetica Neue", Arial, sans-serif`;
  for (let d = 0; d < 10; d++) {
    c.fillText(String(d), cellPx * (d + 0.5), cellPx * 0.53);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export class TrackMeshBuilder {
  constructor(track, ctx) {
    this.track = track;
    this.ctx = ctx;
    this.surface = track.surface;
    this.group = new THREE.Group();
    this.group.name = 'trackSurface';
    this._geometries = [];
    this._materials = [];
    this._textures = [];
  }

  build() {
    this._buildStations();
    this._buildAsphalt();
    this._buildTrackLimitLines();
    this._buildRacingLineDecal();
    this._buildKerbs();
    this._buildVerges();
    this._buildRunoff();
    this._buildApron();
    this._buildPitLane();
    this._buildMarkings();
    this._buildBrakingBoards();
  }

  // --- station list ---------------------------------------------------------------

  _buildStations() {
    const surf = this.surface;
    const L = surf.length;
    const stations = [];
    let d = 0;
    while (d < L) {
      stations.push(d);
      const i = Math.min(surf.count - 1, Math.floor(d / surf.step));
      const kappa = Math.abs(surf.curvature[i]);
      const radius = kappa > 1e-5 ? 1 / kappa : 1e5;
      d += clamp(Math.sqrt(8 * radius * SAG_TOLERANCE), 1.4, 12.0);
    }
    stations.push(L);
    this.stations = Float64Array.from(stations);

    this.chunkRanges = [];
    const per = Math.ceil((this.stations.length - 1) / CHUNKS);
    for (let c = 0; c < CHUNKS; c++) {
      const a = c * per;
      const b = Math.min(this.stations.length - 1, a + per);
      if (a >= b) break;
      this.chunkRanges.push([a, b]);
    }
  }

  /** Sample index and interpolation weight for a distance along the lap. */
  _at(distance) {
    const surf = this.surface;
    const n = surf.count;
    let d = distance % surf.length;
    if (d < 0) d += surf.length;
    const f = d / surf.step;
    const a = Math.floor(f) % n;
    return { a, b: (a + 1) % n, f: f - Math.floor(f), distance: d };
  }

  /** Interpolated centreline frame at a distance, written into the supplied record. */
  _frame(distance, out) {
    const surf = this.surface;
    const { a, b, f, distance: d } = this._at(distance);
    out.index = a;
    out.distance = d;
    out.x = surf.posX[a] + (surf.posX[b] - surf.posX[a]) * f;
    out.y = surf.posY[a] + (surf.posY[b] - surf.posY[a]) * f;
    out.z = surf.posZ[a] + (surf.posZ[b] - surf.posZ[a]) * f;
    let rx = surf.rightX[a] + (surf.rightX[b] - surf.rightX[a]) * f;
    let rz = surf.rightZ[a] + (surf.rightZ[b] - surf.rightZ[a]) * f;
    const rl = Math.hypot(rx, rz) || 1;
    out.rx = rx / rl;
    out.rz = rz / rl;
    out.nx = surf.normX[a] + (surf.normX[b] - surf.normX[a]) * f;
    out.ny = surf.normY[a] + (surf.normY[b] - surf.normY[a]) * f;
    out.nz = surf.normZ[a] + (surf.normZ[b] - surf.normZ[a]) * f;
    out.tx = surf.tanX[a] + (surf.tanX[b] - surf.tanX[a]) * f;
    out.ty = surf.tanY[a] + (surf.tanY[b] - surf.tanY[a]) * f;
    out.tz = surf.tanZ[a] + (surf.tanZ[b] - surf.tanZ[a]) * f;
    out.width = surf.width[a] + (surf.width[b] - surf.width[a]) * f;
    out.bank = surf.tanBank[a] + (surf.tanBank[b] - surf.tanBank[a]) * f;
    return out;
  }

  _newFrame() {
    return {
      index: 0, distance: 0, x: 0, y: 0, z: 0, rx: 0, rz: 0,
      nx: 0, ny: 1, nz: 0, tx: 0, ty: 0, tz: 1, width: 6, bank: 0,
    };
  }

  /**
   * Generic swept strip. `evaluate(frame, column, out)` fills `out` with the lateral
   * offset, the height above the banked plane, the cross-slope dy/dlateral (for the
   * analytic normal) and the V coordinate.
   */
  _sweep(distances, columns, evaluate, material, name, options = {}) {
    const rows = distances.length;
    const cols = columns;
    const positions = new Float32Array(rows * cols * 3);
    const normals = new Float32Array(rows * cols * 3);
    const uvs = new Float32Array(rows * cols * 2);
    const uv1 = options.uv1 ? new Float32Array(rows * cols * 2) : null;
    const indices = [];

    const frame = this._newFrame();
    const out = { lateral: 0, height: 0, slope: 0, u: 0, v: 0, skip: false };
    const uScale = options.uScale ?? 1;

    for (let r = 0; r < rows; r++) {
      this._frame(distances[r], frame);
      for (let cIdx = 0; cIdx < cols; cIdx++) {
        out.lateral = 0; out.height = 0; out.slope = 0; out.u = 0; out.v = 0;
        evaluate(frame, cIdx, out, distances[r]);

        const vi = (r * cols + cIdx) * 3;
        const px = frame.x + frame.rx * out.lateral;
        const pz = frame.z + frame.rz * out.lateral;
        positions[vi] = px;
        positions[vi + 1] = frame.y - out.lateral * frame.bank + out.height;
        positions[vi + 2] = pz;

        // n = normalize(n0 - right * dy/dlateral): the first-order tilt of the banked
        // surface normal by the local cross-slope. Exact for a locally linear surface,
        // which every band here is.
        let nx = frame.nx - frame.rx * out.slope;
        let ny = frame.ny;
        let nz = frame.nz - frame.rz * out.slope;
        const nl = Math.hypot(nx, ny, nz) || 1;
        normals[vi] = nx / nl;
        normals[vi + 1] = ny / nl;
        normals[vi + 2] = nz / nl;

        const ui = (r * cols + cIdx) * 2;
        uvs[ui] = options.explicitU ? out.u : distances[r] * uScale;
        uvs[ui + 1] = out.v;
        if (uv1) {
          uv1[ui] = out.u1 ?? 0;
          uv1[ui + 1] = out.v1 ?? 0;
        }
      }
    }

    for (let r = 0; r < rows - 1; r++) {
      for (let cIdx = 0; cIdx < cols - 1; cIdx++) {
        const a = r * cols + cIdx;
        pushQuad(indices, positions, normals, a, a + 1, a + cols, a + cols + 1);
      }
    }

    // Many of the painted markings are a few square metres each; merging them into one
    // buffer keeps the scene graph from filling up with hundreds of trivial meshes.
    const into = options.into;
    if (into) {
      const base = into.pos.length / 3;
      for (let i = 0; i < positions.length; i++) into.pos.push(positions[i]);
      for (let i = 0; i < normals.length; i++) into.nor.push(normals[i]);
      for (let i = 0; i < uvs.length; i++) into.uv.push(uvs[i]);
      if (uv1) for (let i = 0; i < uv1.length; i++) into.uv1.push(uv1[i]);
      for (const idx of indices) into.idx.push(idx + base);
      return null;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    if (uv1) geo.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    this._geometries.push(geo);

    const mesh = new THREE.Mesh(geo, material);
    mesh.name = name;
    mesh.castShadow = options.castShadow ?? false;
    mesh.receiveShadow = options.receiveShadow ?? true;
    if (options.renderOrder) mesh.renderOrder = options.renderOrder;
    this.group.add(mesh);
    return mesh;
  }

  _newAccum() {
    return { pos: [], nor: [], uv: [], uv1: [], idx: [] };
  }

  _emitAccum(acc, material, name, renderOrder) {
    if (!acc.idx.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(acc.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(acc.uv, 2));
    if (acc.uv1.length) geo.setAttribute('uv1', new THREE.Float32BufferAttribute(acc.uv1, 2));
    geo.setIndex(acc.idx);
    geo.computeBoundingSphere();
    this._geometries.push(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    if (renderOrder) mesh.renderOrder = renderOrder;
    this.group.add(mesh);
    return mesh;
  }

  _chunkDistances(range, extra = 0) {
    const [a, b] = range;
    const list = [];
    for (let i = a; i <= b; i++) list.push(this.stations[i] + extra);
    return list;
  }

  // --- racing surface -------------------------------------------------------------

  _buildAsphalt() {
    const materials = this.ctx.materials;
    const tile = materials.tileSize('asphalt', { u: 2.4, v: 2.4 });
    // Snap the along-track tiling so a whole number of tiles fits the lap: the texture
    // then meets itself at the start/finish line instead of showing a seam there.
    const repeats = Math.max(1, Math.round(this.surface.length / tile.u));
    const uScale = repeats / this.surface.length;
    const vScale = 1 / tile.v;
    const cols = 11;
    const material = materials.get('asphalt');

    for (let c = 0; c < this.chunkRanges.length; c++) {
      const distances = this._chunkDistances(this.chunkRanges[c]);
      this._sweep(distances, cols, (frame, col, out) => {
        const f = (col / (cols - 1)) * 2 - 1;
        const lateral = f * frame.width;
        out.lateral = lateral;
        const a = Math.abs(lateral);
        out.height = -CROWN * a * a / frame.width;
        out.slope = -2 * CROWN * lateral / frame.width;
        out.v = lateral * vScale;
      }, material, `asphalt_${c}`, { uScale });
    }
  }

  /** The 100 mm white line that defines track limits, inset to the edge of the tarmac. */
  _buildTrackLimitLines() {
    const materials = this.ctx.materials;
    const material = materials.get('paint_line');
    const tile = materials.tileSize('paint_line', { u: 0.6, v: 0.6 });
    const uScale = 1 / tile.u;

    for (const side of [-1, 1]) {
      for (let c = 0; c < this.chunkRanges.length; c++) {
        const distances = this._chunkDistances(this.chunkRanges[c]);
        this._sweep(distances, 2, (frame, col, out) => {
          const outer = frame.width - 0.03;
          const lateral = side * (col === 0 ? outer - LINE_WIDTH : outer);
          out.lateral = lateral;
          const a = Math.abs(lateral);
          out.height = -CROWN * a * a / frame.width + 0.004;
          out.slope = -2 * CROWN * lateral / frame.width;
          out.v = (col === 0 ? 0 : LINE_WIDTH / tile.v);
        }, material, `limit_${side > 0 ? 'r' : 'l'}_${c}`, { uScale, renderOrder: 2 });
      }
    }
  }

  /**
   * The rubbered-in line. It follows the solved racing line rather than the centreline,
   * and its width comes from the same solve: broad where cars fan out under braking and
   * on the way out of a corner, pinched to a single file through the apex.
   */
  _buildRacingLineDecal() {
    const track = this.track;
    const surf = this.surface;
    const materials = this.ctx.materials;
    const material = materials.get('racing_line');
    const tile = materials.tileSize('racing_line', { u: 6.0, v: 2.4 });
    const repeats = Math.max(1, Math.round(surf.length / tile.u));
    const uScale = repeats / surf.length;

    for (let c = 0; c < this.chunkRanges.length; c++) {
      const distances = this._chunkDistances(this.chunkRanges[c]);
      this._sweep(distances, 5, (frame, col, out) => {
        const t = frame.distance / surf.length;
        const centre = track.racingLineOffsetAt(t);
        const half = this._racingLineHalfWidth(frame.index);
        const f = (col / 4) * 2 - 1;
        const limit = frame.width - 0.25;
        const lateral = clamp(centre + f * half, -limit, limit);
        out.lateral = lateral;
        const a = Math.abs(lateral);
        out.height = -CROWN * a * a / frame.width + 0.008;
        out.slope = -2 * CROWN * lateral / frame.width;
        out.v = (f + 1) * 0.5;
      }, material, `racingline_${c}`, { uScale, renderOrder: 3 });
    }
  }

  _racingLineHalfWidth(index) {
    return this.track.racingLineWidth[index] * 0.5;
  }

  // --- kerbs ----------------------------------------------------------------------

  /**
   * Kerbs as real geometry: a 160 mm chamfer up off the tarmac, a 52 mm plateau serrated
   * on a 250 mm pitch — the same pitch the kerb texture and the physics rumble use — and
   * a shorter chamfer down onto the astroturf.
   */
  _buildKerbs() {
    const materials = this.ctx.materials;
    const surf = this.surface;
    const kerbMat = materials.get('kerb');
    const exitMat = materials.get('kerb_exit');
    const tile = materials.tileSize('kerb', { u: 4.0, v: 1.0 });
    const uScale = 1 / tile.u;
    const cols = 7;

    let index = 0;
    for (const span of surf.kerbSpans) {
      let from = span.from;
      let to = span.to;
      while (to < from) to += surf.length;
      // The 250 mm serration lives in the kerb's normal map, where it costs nothing;
      // geometry carries the chamfers, the plateau and the section joints, which are the
      // parts that show in silhouette and in a shadow.
      const rows = Math.max(4, Math.ceil((to - from) / KERB_STATION_STEP));
      const distances = [];
      for (let r = 0; r <= rows; r++) distances.push(from + ((to - from) * r) / rows);

      const side = span.side;
      const material = span.style === 'kerb_exit' ? exitMat : kerbMat;

      this._sweep(distances, cols, (frame, col, out, distance) => {
        const idx = frame.index * 2 + (side > 0 ? 1 : 0);
        const kerbW = surf.kerbWidth[idx] > 0 ? surf.kerbWidth[idx] : 1.0;
        const across = (col / (cols - 1)) * kerbW;
        const lateral = side * (frame.width + across);

        // Taper the kerb into the tarmac over its first and last 1.2 m so it never
        // starts as a step.
        const fadeIn = clamp01((distance - from) / 1.2);
        const fadeOut = clamp01((to - distance) / 1.2);
        const fade = Math.min(fadeIn, fadeOut);

        const chamferIn = clamp01(across / KERB_CHAMFER);
        const chamferOut = clamp01((kerbW - across) / (KERB_CHAMFER * 0.7));
        const plateau = Math.min(chamferIn, chamferOut);
        const joint = 0.5 - 0.5 * Math.cos((distance / KERB_SECTION_PITCH) * Math.PI * 2);
        const crown = Math.sin((across / kerbW) * Math.PI) * 0.006;

        const base = -CROWN * frame.width;
        out.lateral = lateral;
        out.height = base + fade * plateau * (KERB_HEIGHT + crown - joint * KERB_SECTION_DEPTH);

        // Cross-slope of the chamfers, which is what gives the kerb its bright edge.
        let slope = 0;
        if (across < KERB_CHAMFER) slope = side * (KERB_HEIGHT / KERB_CHAMFER) * fade;
        else if (across > kerbW - KERB_CHAMFER * 0.7) slope = -side * (KERB_HEIGHT / (KERB_CHAMFER * 0.7)) * fade;
        out.slope = slope;
        out.v = across / tile.v;
      }, material, `kerb_${index++}`, {
        uScale, castShadow: true, renderOrder: 1,
      });
    }
  }

  // --- verges, run-off, apron -----------------------------------------------------

  /** The astroturf strip between kerb and run-off. */
  _buildVerges() {
    const materials = this.ctx.materials;
    const material = materials.get('astroturf');
    const tile = materials.tileSize('astroturf', { u: 1.5, v: 1.5 });
    const uScale = 1 / tile.u;
    const surf = this.surface;

    for (const side of [-1, 1]) {
      for (let c = 0; c < this.chunkRanges.length; c++) {
        const distances = this._chunkDistances(this.chunkRanges[c]);
        this._sweep(distances, 3, (frame, col, out) => {
          const idx = frame.index * 2 + (side > 0 ? 1 : 0);
          const kerbW = surf.kerbWidth[idx];
          const astro = surf.astroWidth[idx];
          const inner = frame.width + kerbW;
          const across = (col / 2) * Math.max(0.05, astro);
          out.lateral = side * (inner + across);
          const drop = ASTRO_DROP * smoothstep(0, 0.4, astro > 0 ? across / astro : 1);
          out.height = -CROWN * frame.width - drop;
          out.slope = side * (astro > 0.05 ? -ASTRO_DROP / astro : 0);
          out.v = across / tile.v;
        }, material, `verge_${side > 0 ? 'r' : 'l'}_${c}`, { uScale });
      }
    }
  }

  /**
   * Run-off, split into runs of one material so a gravel trap is a gravel trap and not a
   * tinted stripe on a single ribbon. Gravel sits in a shallow scoop; paved run-off just
   * falls away for drainage. Both match `crossSectionHeight` exactly.
   */
  _buildRunoff() {
    const materials = this.ctx.materials;
    const surf = this.surface;
    const names = ['asphalt_worn', 'gravel', 'grass', 'concrete'];
    const tiles = names.map((n) => materials.tileSize(n === 'asphalt_worn' ? 'asphalt_worn' : n, { u: 3, v: 3 }));
    const mats = names.map((n) => materials.get(n));

    let runIndex = 0;
    for (const side of [-1, 1]) {
      const sideIndex = side > 0 ? 1 : 0;
      let start = 0;
      let current = surf.runoffType[sideIndex];
      const emit = (from, to, type) => {
        if (to - from < 4 || type === 2) return;   // grass run-off is left to the apron
        const rows = Math.max(3, Math.ceil((to - from) / 9));
        const distances = [];
        for (let r = 0; r <= rows; r++) distances.push(from + ((to - from) * r) / rows);
        const tile = tiles[type];
        const cols = 5;
        this._sweep(distances, cols, (frame, col, out) => {
          const idx = frame.index * 2 + sideIndex;
          const inner = frame.width + surf.kerbWidth[idx] + surf.astroWidth[idx];
          const wRun = surf.runoffWidth[idx];
          const across = (col / (cols - 1)) * wRun;
          out.lateral = side * (inner + across);
          const base = -CROWN * frame.width - ASTRO_DROP;
          if (type === 1) {
            const u = clamp01(wRun > 0 ? across / wRun : 0);
            out.height = base - 0.55 * Math.sin(u * Math.PI) - across * 0.010;
            out.slope = side * (-0.55 * Math.PI / Math.max(1, wRun) * Math.cos(u * Math.PI) - 0.010);
          } else {
            out.height = base - across * RUNOFF_FALL;
            out.slope = -side * RUNOFF_FALL;
          }
          out.v = (inner + across) / tile.v;
        }, mats[type], `runoff_${runIndex++}`, { uScale: 1 / tile.u });
      };

      for (let i = 1; i <= surf.count; i++) {
        const idx = (i % surf.count) * 2 + sideIndex;
        const type = surf.runoffType[idx];
        if (type !== current || i === surf.count) {
          emit(start * surf.step, i * surf.step, current);
          start = i;
          current = type;
        }
      }
    }
  }

  /**
   * The grass apron. Its vertices come from `surface.heightAt`, the same function the
   * terrain mesh and every suspension ray use, so the ground never disagrees with itself
   * and there is no seam where the circuit stops and the countryside begins.
   */
  _buildApron() {
    const materials = this.ctx.materials;
    const material = materials.get('grass');
    const tile = materials.tileSize('grass', { u: 4, v: 4 });
    const surf = this.surface;
    const cols = 9;

    for (const side of [-1, 1]) {
      const sideIndex = side > 0 ? 1 : 0;
      for (let c = 0; c < this.chunkRanges.length; c++) {
        const stations = this._chunkDistances(this.chunkRanges[c]);
        // The apron is smooth in plan; every second station is plenty and halves the
        // vertex count of the largest mesh on the circuit.
        const distances = stations.filter((d, i) => i % 2 === 0 || i === stations.length - 1);
        this._sweep(distances, cols, (frame, col, out) => {
          const idx = frame.index * 2 + sideIndex;
          // Where the run-off is already grass there is no separate run-off mesh, so the
          // apron has to start at the astroturf and cover that band itself.
          const grassRunoff = surf.runoffType[idx] === 2;
          const inner = frame.width + surf.kerbWidth[idx] + surf.astroWidth[idx]
            + (grassRunoff ? 0 : surf.runoffWidth[idx]);
          const f = col / (cols - 1);
          const across = APRON_WIDTH * f * f;      // denser near the circuit
          const lateral = side * (inner + across);
          const x = frame.x + frame.rx * lateral;
          const z = frame.z + frame.rz * lateral;
          const y = surf.heightAt(x, z);
          out.lateral = lateral;
          out.height = y - (frame.y - lateral * frame.bank);
          const e = 1.5;
          const dy = surf.heightAt(x + frame.rx * e, z + frame.rz * e)
            - surf.heightAt(x - frame.rx * e, z - frame.rz * e);
          out.slope = dy / (2 * e) + frame.bank;
          out.u = frame.distance / tile.u;
          out.v = (inner + across) / tile.v;
        }, material, `apron_${side > 0 ? 'r' : 'l'}_${c}`, { explicitU: true });
      }
    }
    this.apronWidth = APRON_WIDTH;
  }

  // --- pit lane -------------------------------------------------------------------

  /**
   * The pit lane surface. Its inner edge is clamped outside the racing surface so the
   * two ribbons never overlap and z-fight where the entry peels off and where the exit
   * merges back on.
   */
  _buildPitLane() {
    const materials = this.ctx.materials;
    const surf = this.surface;
    const pit = this.track.pitLane;
    if (!pit || !surf.pitHalf) return;

    const tile = materials.tileSize('asphalt_worn', { u: 2.4, v: 2.4 });
    const spec = this.track.circuit.pitLane;
    const analytic = this.track.layout.analyticLength;

    const first = spec.path[0][0];
    const last = spec.path[spec.path.length - 1][0];
    let span = last - first;
    while (span < 0) span += analytic;
    const rows = Math.max(24, Math.round(span / 5));
    const distances = [];
    for (let r = 0; r <= rows; r++) distances.push(first + (span * r) / rows);

    const edges = (frame) => {
      const half = surf.pitHalf[frame.index];
      const centre = surf.pitOffset[frame.index];
      const outer = centre + half;
      const inner = Math.max(centre - half, frame.width + 0.15);
      return { inner: Math.min(inner, outer - 0.05), outer };
    };

    const cols = 5;
    this._sweep(distances, cols, (frame, col, out) => {
      const { inner, outer } = edges(frame);
      out.lateral = inner + ((outer - inner) * col) / (cols - 1);
      out.height = -CROWN * frame.width;
      out.slope = 0;
      out.u = frame.distance / tile.u;
      out.v = out.lateral / tile.v;
    }, materials.get('asphalt_worn'), 'pitlane', { explicitU: true });

    const lineMat = materials.get('paint_line');
    const lineTile = materials.tileSize('paint_line', { u: 0.6, v: 0.6 });
    const lines = this._newAccum();
    for (const side of [-1, 1]) {
      this._sweep(distances, 2, (frame, col, out) => {
        const { inner, outer } = edges(frame);
        const base = side < 0 ? inner + 0.12 : outer - 0.12;
        out.lateral = base + col * LINE_WIDTH * -side;
        out.height = -CROWN * frame.width + 0.005;
        out.slope = 0;
        out.u = frame.distance / lineTile.u;
        out.v = col * (LINE_WIDTH / lineTile.v);
      }, lineMat, 'pitline', { explicitU: true, into: lines });
    }
    this._emitAccum(lines, lineMat, 'pitLines', 3);
  }

  // --- painted markings -----------------------------------------------------------

  _buildMarkings() {
    this._digitTexture = buildDigitAtlas();
    this._textures.push(this._digitTexture);
    this._numberMaterial = this.ctx.materials.clone('paint_line');
    this._numberMaterial.alphaMap = this._digitTexture;
    this._numberMaterial.alphaMap.channel = 1;
    this._numberMaterial.transparent = true;
    this._numberMaterial.alphaTest = 0.35;
    this._numberMaterial.depthWrite = false;
    this._numberMaterial.name = 'grid_numbers';
    this._numberMaterial.needsUpdate = true;

    this._buildStartLine();
    this._buildGridBoxes();
  }

  _buildStartLine() {
    const materials = this.ctx.materials;
    const tile = materials.tileSize('paint_line', { u: 0.6, v: 0.6 });
    const width = 0.5;
    const distances = [this.surface.length - width * 0.5, this.surface.length + width * 0.5];
    this._sweep(distances, 9, (frame, col, out, distance) => {
      const f = (col / 8) * 2 - 1;
      const lateral = f * (frame.width - 0.05);
      out.lateral = lateral;
      const a = Math.abs(lateral);
      out.height = -CROWN * a * a / frame.width + 0.006;
      out.slope = -2 * CROWN * lateral / frame.width;
      out.u = lateral / tile.u;
      out.v = (distance - distances[0]) / tile.v;
    }, materials.get('paint_line'), 'startLine', { explicitU: true, renderOrder: 4 });
  }

  /**
   * Twenty grid boxes: two side lines and a front line each, with the position number
   * painted ahead of the box the way it is on a real grid.
   */
  _buildGridBoxes() {
    const materials = this.ctx.materials;
    const paint = materials.get('paint_line');
    const tile = materials.tileSize('paint_line', { u: 0.6, v: 0.6 });
    const boxes = this.track.gridBoxes;
    const L = this.surface.length;
    const lines = this._newAccum();
    const numbers = this._newAccum();

    for (const box of boxes) {
      const centreDistance = box.t * L;
      const rows = 10;
      const distances = [];
      for (let r = 0; r <= rows; r++) {
        distances.push(centreDistance - GRID_BOX_LENGTH * 0.5 + (GRID_BOX_LENGTH * r) / rows);
      }

      for (const edge of [-1, 1]) {
        this._sweep(distances, 2, (frame, col, out, distance) => {
          const lateral = box.lateral + edge * (GRID_BOX_WIDTH * 0.5) + col * LINE_WIDTH * edge;
          out.lateral = lateral;
          const a = Math.min(Math.abs(lateral), frame.width);
          out.height = -CROWN * a * a / frame.width + 0.006;
          out.slope = 0;
          out.u = (distance - distances[0]) / tile.u;
          out.v = col * (LINE_WIDTH / tile.v);
        }, paint, 'gridside', { explicitU: true, into: lines });
      }

      const front = [centreDistance + GRID_BOX_LENGTH * 0.5 - LINE_WIDTH, centreDistance + GRID_BOX_LENGTH * 0.5];
      this._sweep(front, 5, (frame, col, out, distance) => {
        const lateral = box.lateral + ((col / 4) * 2 - 1) * GRID_BOX_WIDTH * 0.5;
        out.lateral = lateral;
        const a = Math.min(Math.abs(lateral), frame.width);
        out.height = -CROWN * a * a / frame.width + 0.006;
        out.slope = 0;
        out.u = lateral / tile.u;
        out.v = (distance - front[0]) / tile.v;
      }, paint, 'gridfront', { explicitU: true, into: lines });

      this._buildPaintedNumber(box.number, centreDistance + GRID_BOX_LENGTH * 0.5 + 1.9,
        box.lateral, 1.25, 0.72, numbers);
    }

    this._emitAccum(lines, paint, 'gridBoxes', 4);
    this._emitAccum(numbers, this._numberMaterial, 'gridNumbers', 5);
  }

  /**
   * A number painted flat on the tarmac, one quad per digit, masked by the digit atlas.
   * `uv` carries the paint tiling and `uv1` the atlas cell, which is why the material
   * pins its alpha map to the second channel.
   */
  _buildPaintedNumber(value, distance, lateral, height, digitWidth, into) {
    const text = String(value);
    const materials = this.ctx.materials;
    const tile = materials.tileSize('paint_line', { u: 0.6, v: 0.6 });
    const totalWidth = text.length * digitWidth;

    for (let k = 0; k < text.length; k++) {
      const digit = text.charCodeAt(k) - 48;
      if (digit < 0 || digit > 9) continue;
      const offset = -totalWidth * 0.5 + digitWidth * (k + 0.5);
      const rows = [distance - height * 0.5, distance + height * 0.5];
      this._sweep(rows, 2, (frame, col, out, d) => {
        const lat = lateral + offset + (col === 0 ? -digitWidth * 0.42 : digitWidth * 0.42);
        out.lateral = lat;
        const a = Math.min(Math.abs(lat), frame.width);
        out.height = -CROWN * a * a / frame.width + 0.007;
        out.slope = 0;
        out.u = lat / tile.u;
        out.v = (d - rows[0]) / tile.v;
        out.u1 = (digit + (col === 0 ? 0 : 1)) / 10;
        out.v1 = d === rows[0] ? 0 : 1;
      }, this._numberMaterial, 'gridnum', { explicitU: true, uv1: true, into });
    }
  }

  // --- braking boards -------------------------------------------------------------

  /** 50/100/150/200 m boards on posts, angled slightly toward the oncoming cars. */
  _buildBrakingBoards() {
    const materials = this.ctx.materials;
    const surf = this.surface;
    const panelMat = materials.clone('metal_anodised');
    panelMat.color.setHex(0x141418);
    panelMat.roughness = 0.62;
    panelMat.metalness = 0.1;
    panelMat.name = 'braking_board';

    const numberMat = materials.clone('paint_line');
    numberMat.alphaMap = this._digitTexture;
    numberMat.alphaMap.channel = 1;
    numberMat.transparent = true;
    numberMat.alphaTest = 0.35;
    numberMat.side = THREE.DoubleSide;
    numberMat.name = 'board_numbers';
    numberMat.needsUpdate = true;

    const postGeo = new THREE.CylinderGeometry(0.055, 0.065, 2.4, 8);
    const panelGeo = new THREE.BoxGeometry(1.35, 1.0, 0.06);
    this._geometries.push(postGeo, panelGeo);

    const postMatrices = [];
    const panelMatrices = [];
    const digits = this._newAccum();
    const frame = this._newFrame();
    const analytic = this.track.layout.analyticLength;
    const scale = surf.length / analytic;
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    const axis = new THREE.Vector3(0, 1, 0);
    const matrix = new THREE.Matrix4();

    for (const board of this.track.circuit.brakingBoards) {
      for (const mark of board.marks) {
        const distance = ((board.at - mark) * scale + surf.length) % surf.length;
        this._frame(distance, frame);
        const idx = frame.index * 2 + (board.side > 0 ? 1 : 0);
        const offset = board.side * (frame.width + surf.kerbWidth[idx] + surf.astroWidth[idx]
          + Math.min(12, surf.runoffWidth[idx]) + 1.6);
        const x = frame.x + frame.rx * offset;
        const z = frame.z + frame.rz * offset;
        const y = surf.heightAt(x, z);
        const facing = Math.atan2(-frame.tx, -frame.tz) + board.side * 0.28;

        quaternion.setFromAxisAngle(axis, facing);
        position.set(x, y + 1.2, z);
        matrix.compose(position, quaternion, one);
        postMatrices.push(matrix.clone());

        position.set(x, y + 2.05, z);
        matrix.compose(position, quaternion, one);
        panelMatrices.push(matrix.clone());

        this._collectBoardDigits(String(mark), x, y + 2.05, z, facing, 0.62, digits);
      }
    }

    this._instance(postGeo, materials.get('metal_raw'), postMatrices, 'brakingPosts');
    this._instance(panelGeo, panelMat, panelMatrices, 'brakingPanels');
    this._emitAccum(digits, numberMat, 'brakingNumbers', 6);
  }

  /** Digit quads for a board, emitted straight into world space so they can be merged. */
  _collectBoardDigits(text, cx, cy, cz, facing, height, into) {
    const digitWidth = height * 0.62;
    const total = text.length * digitWidth;
    const c = Math.cos(facing);
    const s = Math.sin(facing);
    // Rotation about +Y by `facing` maps local +X to (cos, 0, -sin) and +Z to (sin, 0, cos).
    const fx = s * 0.045;
    const fz = c * 0.045;

    for (let k = 0; k < text.length; k++) {
      const digit = text.charCodeAt(k) - 48;
      if (digit < 0 || digit > 9) continue;
      const ox = -total * 0.5 + digitWidth * (k + 0.5);
      const hw = digitWidth * 0.46;
      const hh = height * 0.5;
      const base = into.pos.length / 3;
      const corners = [
        [ox - hw, +hh, digit / 10, 1], [ox + hw, +hh, (digit + 1) / 10, 1],
        [ox + hw, -hh, (digit + 1) / 10, 0], [ox - hw, -hh, digit / 10, 0],
      ];
      for (const [lx, ly, u1, v1] of corners) {
        into.pos.push(cx + lx * c + fx, cy + ly, cz - lx * s + fz);
        into.nor.push(s, 0, c);
        into.uv.push((lx + hw) / 0.6, (ly + hh) / 0.6);
        into.uv1.push(u1, v1);
      }
      into.idx.push(base, base + 3, base + 2, base, base + 2, base + 1);
    }
  }

  _instance(geometry, material, matrices, name) {
    if (!matrices.length) return null;
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.name = name;
    this.group.add(mesh);
    return mesh;
  }

  dispose() {
    for (const geo of this._geometries) geo.dispose();
    for (const mat of this._materials) mat.dispose();
    for (const tex of this._textures) tex.dispose();
    this._geometries.length = 0;
    this._materials.length = 0;
    this._textures.length = 0;
    this.group.clear();
  }
}
