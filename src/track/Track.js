import * as THREE from 'three';
import { clamp, clamp01, smoothstep, wrap01, deltaT } from '../core/MathUtils.js';
import { SPA, buildLayout, cornerSpan } from './CircuitData.js';
import { TrackSurface } from './TrackSurface.js';
import { TrackMeshBuilder } from './TrackMeshBuilder.js';
import { Barriers } from './Barriers.js';
import { Trackside } from './Trackside.js';

/**
 * The circuit (CONTRACT.md §2).
 *
 * Track owns the geometry and every query into it. It is read-only to everyone else:
 * physics asks it where the road is, the AI asks it where the fast way round is, the
 * render pipeline asks it for nothing at all because the scene graph is already built.
 *
 * All query methods write into a caller-supplied `out` and allocate nothing. The `out`
 * defaults exist only so a one-off call from a tool or a test reads cleanly; anything on
 * the hot path must hoist its own via `createLocateResult` / `createSurfaceResult`.
 */

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3();
const _mat = new THREE.Matrix4();

const RACING_LINE_MARGIN = 1.15;   // metres of tarmac left outside the car at the apex
const GRID_ROW_PITCH = 8.0;        // FIA grid box spacing
const GRID_LATERAL = 3.55;

export class Track {
  static systemName = 'track';

  constructor(circuit = SPA) {
    this.circuit = circuit;
    this.name = circuit.name;
    this.country = circuit.country;
    this.latitude = circuit.latitude;
    this.longitude = circuit.longitude;
    this.dayOfYear = circuit.dayOfYear;
    this.group = new THREE.Group();
    this.group.name = 'track';

    this.sectors = [0, 0, 0];
    this.drsZones = [];
    this.corners = [];
    this.startGrid = [];
    this.pitLane = null;

    this._meshBuilder = null;
    this._barriers = null;
    this._trackside = null;
    this._locateScratch = null;
    this._surfaceScratch = null;
    this._sampleScratch = null;
    this._onQuality = null;
  }

  async init(ctx) {
    this.ctx = ctx;
    const circuit = this.circuit;

    const layout = buildLayout(circuit);
    this.layout = layout;

    const points = [];
    for (let i = 0; i < layout.count; i++) {
      points.push(new THREE.Vector3(
        layout.points[i * 3], layout.points[i * 3 + 1], layout.points[i * 3 + 2],
      ));
    }
    this.curve = new THREE.CatmullRomCurve3(points, true, 'centripetal', 0.5);

    this.surface = new TrackSurface(this.curve, circuit, layout);
    this.length = this.surface.length;

    this._locateScratch = this.surface.createLocateResult();
    this._surfaceScratch = this.surface.createSurfaceResult();
    this._sampleScratch = this.surface.createLocateResult();

    this._buildRaceStructure();
    this._buildRacingLine();
    this._buildPitLane();
    this._buildStartGrid();

    this._barriers = new Barriers(this, ctx);
    this._barriers.build();
    this.surface.barriers = this._barriers;
    this.group.add(this._barriers.group);

    this._meshBuilder = new TrackMeshBuilder(this, ctx);
    this._meshBuilder.build();
    this.group.add(this._meshBuilder.group);

    this._trackside = new Trackside(this, ctx);
    this._trackside.build();
    this.group.add(this._trackside.group);

    ctx.scene.add(this.group);

    this._onQuality = (tier) => {
      this._trackside?.setQuality(tier);
    };
    ctx.events?.on('quality:change', this._onQuality);
  }

  // --- race structure -------------------------------------------------------------

  _buildRaceStructure() {
    const L = this.length;
    const marks = this.layout.marks;
    const analytic = this.layout.analyticLength;
    const toT = (d) => wrap01((d / analytic));

    this.sectors = [
      0,
      toT(this.circuit.sectorDistance[0]),
      toT(this.circuit.sectorDistance[1]),
    ];

    this.corners = this.circuit.corners.map((corner) => {
      const span = cornerSpan(corner, marks, analytic);
      const radius = this._radiusOf(corner.seg);
      return {
        t: toT(span.apex),
        apexT: toT(span.apex),
        entryT: toT(span.entry),
        exitT: toT(span.exit),
        name: corner.name,
        number: corner.number,
        radius,
        direction: this._turnOf(corner.seg) > 0 ? 'right' : 'left',
        runoff: corner.runoff,
        gravel: corner.gravel,
        lengthMetres: span.length,
        entryDistance: span.entry,
        apexDistance: span.apex,
        exitDistance: span.exit,
      };
    });

    this.drsZones = this.circuit.drs.map((z) => ({
      name: z.name,
      detect: toT(z.detect),
      start: toT(z.start),
      end: toT(z.end),
    }));

    this.startFinishDistance = 0;
    this.lapDistance = L;
  }

  _radiusOf(id) {
    for (const seg of this.circuit.program) if (seg[0] === 'a' && seg[3] === id) return seg[1];
    return Infinity;
  }

  _turnOf(id) {
    for (const seg of this.circuit.program) if (seg[0] === 'a' && seg[3] === id) return seg[2];
    return 0;
  }

  /**
   * The racing line, as a lateral offset field solved by constrained Laplacian smoothing.
   *
   * Minimising the discrete Laplacian of the world-space path is minimising its
   * curvature; clamping each offset to the corridor after every sweep is what turns that
   * into a racing line rather than a straight line. The result comes out with the
   * geometry a driver would use for free — the line runs to the outside on the way in,
   * touches the apex kerb, and unwinds to the far kerb on exit — because those are the
   * minimum-curvature positions, not because they were authored.
   */
  _buildRacingLine() {
    const surf = this.surface;
    const n = surf.count;
    const stride = 4;
    const m = Math.floor(n / stride);

    const offset = new Float32Array(m);
    const limit = new Float32Array(m);
    const cx = new Float32Array(m);
    const cz = new Float32Array(m);
    const rx = new Float32Array(m);
    const rz = new Float32Array(m);

    for (let k = 0; k < m; k++) {
      const i = k * stride;
      cx[k] = surf.posX[i];
      cz[k] = surf.posZ[i];
      rx[k] = surf.rightX[i];
      rz[k] = surf.rightZ[i];
      limit[k] = Math.max(0.4, surf.width[i] - RACING_LINE_MARGIN);
      // Seed on the inside of the turn, scaled by how much of the corridor the corner
      // actually justifies using. Starting from zero converges to the same place but
      // takes several thousand sweeps to get there.
      const kappa = surf.curvature[i];
      offset[k] = clamp(-Math.sign(kappa) * limit[k] * clamp01(Math.abs(kappa) * 90), -limit[k], limit[k]);
    }

    const px = new Float32Array(m);
    const pz = new Float32Array(m);
    const omega = 0.55;
    for (let iter = 0; iter < 900; iter++) {
      for (let k = 0; k < m; k++) {
        px[k] = cx[k] + rx[k] * offset[k];
        pz[k] = cz[k] + rz[k] * offset[k];
      }
      for (let k = 0; k < m; k++) {
        const a = (k - 1 + m) % m;
        const b = (k + 1) % m;
        const lx = (px[a] + px[b]) * 0.5 - px[k];
        const lz = (pz[a] + pz[b]) * 0.5 - pz[k];
        const dn = lx * rx[k] + lz * rz[k];
        offset[k] = clamp(offset[k] + omega * dn, -limit[k], limit[k]);
      }
    }

    this.racingLineOffset = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const f = (i / stride) % m;
      const a = Math.floor(f) % m;
      const b = (a + 1) % m;
      const u = f - Math.floor(f);
      this.racingLineOffset[i] = offset[a] + (offset[b] - offset[a]) * u;
    }

    // Band width for the rubbered-in stripe: cars fan out under braking and on exit and
    // funnel to a single file through the apex, so the darkest strip is also the thinnest.
    this.racingLineWidth = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const kappa = Math.abs(surf.curvature[i]);
      this.racingLineWidth[i] = 3.9 - 1.75 * smoothstep(0.001, 0.020, kappa);
    }
    // A short box blur keeps the stripe from stepping in width sample to sample.
    const smoothed = new Float32Array(n);
    const R = 24;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let o = -R; o <= R; o++) sum += this.racingLineWidth[(i + o + n) % n];
      smoothed[i] = sum / (R * 2 + 1);
    }
    this.racingLineWidth = smoothed;

    const linePoints = [];
    const lineStride = 6;
    for (let i = 0; i < n; i += lineStride) {
      const o = this.racingLineOffset[i];
      linePoints.push(new THREE.Vector3(
        surf.posX[i] + surf.rightX[i] * o,
        surf.posY[i] - o * surf.tanBank[i] + 0.02,
        surf.posZ[i] + surf.rightZ[i] * o,
      ));
    }
    this.racingLine = new THREE.CatmullRomCurve3(linePoints, true, 'centripetal', 0.5);
  }

  /** Pit lane spline, swept from lateral offsets against the main centreline. */
  _buildPitLane() {
    const spec = this.circuit.pitLane;
    const analytic = this.layout.analyticLength;
    const pts = [];
    const scratch = this._sampleScratch;

    // Resample the sparse control offsets densely so the lane is smooth in both the
    // offset and the centreline it is measured against.
    const path = spec.path;
    let previous = path[0][0];
    let unwrapped = previous;
    const nodes = [[unwrapped, path[0][1]]];
    for (let i = 1; i < path.length; i++) {
      let d = path[i][0];
      while (d < previous) d += analytic;
      unwrapped += d - previous;
      previous = d;
      nodes.push([unwrapped, path[i][1]]);
    }

    const total = nodes[nodes.length - 1][0] - nodes[0][0];
    const steps = Math.max(24, Math.round(total / 6));
    for (let s = 0; s <= steps; s++) {
      const d = nodes[0][0] + (total * s) / steps;
      let j = 0;
      while (j < nodes.length - 2 && nodes[j + 1][0] < d) j++;
      const span = nodes[j + 1][0] - nodes[j][0];
      const f = clamp01(span > 1e-6 ? (d - nodes[j][0]) / span : 0);
      const smooth = f * f * (3 - 2 * f);
      const lateral = nodes[j][1] + (nodes[j + 1][1] - nodes[j][1]) * smooth;
      this.sample(wrap01(d / analytic), scratch);
      pts.push(new THREE.Vector3(
        scratch.position.x + scratch.right.x * lateral,
        scratch.position.y - lateral * Math.tan(scratch.banking) + 0.02,
        scratch.position.z + scratch.right.z * lateral,
      ));
    }

    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    this.pitLane = {
      entry: wrap01(spec.entryDistance / analytic),
      exit: wrap01(spec.exitDistance / analytic),
      curve,
      speedLimit: spec.speedLimit,
      speedLimitKph: spec.speedLimitKph,
      length: curve.getLength(),
      halfWidth: spec.laneHalfWidth,
      boxCount: spec.boxCount,
    };

    this.surface.applyPitCorridor(spec.path, analytic);
  }

  /** Twenty staggered grid slots behind the line, pole on the left as at Spa. */
  _buildStartGrid() {
    const scratch = this._sampleScratch;
    const L = this.length;
    this.startGrid = [];
    this.gridBoxes = [];

    for (let i = 0; i < 20; i++) {
      const distance = L - 11 - i * GRID_ROW_PITCH;
      const t = wrap01(distance / L);
      this.sample(t, scratch);
      const lateral = (i % 2 === 0 ? -1 : 1) * GRID_LATERAL;

      const height = this.surface.heightAt(
        scratch.position.x + scratch.right.x * lateral,
        scratch.position.z + scratch.right.z * lateral,
      );
      const position = new THREE.Vector3(
        scratch.position.x + scratch.right.x * lateral,
        height,
        scratch.position.z + scratch.right.z * lateral,
      );

      _fwd.copy(scratch.tangent).normalize();
      _up.copy(scratch.normal).normalize();
      _side.crossVectors(_fwd, _up).normalize();
      _up.crossVectors(_side, _fwd).normalize();
      // Car local frame is -Z forward, so the matrix's Z column is the reverse tangent.
      _mat.makeBasis(_side, _up, _v.copy(_fwd).negate());
      const quaternion = new THREE.Quaternion().setFromRotationMatrix(_mat);

      this.startGrid.push({ position, quaternion });
      this.gridBoxes.push({ position: position.clone(), quaternion: quaternion.clone(), number: i + 1, lateral, t });
    }
  }

  // --- contract queries -----------------------------------------------------------

  /** @see CONTRACT.md §2 — allocation-free when `out` is supplied. */
  sample(t, out = this.surface.createLocateResult()) {
    if (!out.position) Object.assign(out, this.surface.createLocateResult());
    return this.surface.sample(t, out);
  }

  /** @see CONTRACT.md §2 — allocation-free when `out` is supplied. */
  locate(worldPos, out = this.surface.createLocateResult()) {
    if (!out.position) Object.assign(out, this.surface.createLocateResult());
    return this.surface.locate(worldPos, out);
  }

  /** @see CONTRACT.md §2 — allocation-free when `out` is supplied. */
  surfaceAt(worldPos, out = this.surface.createSurfaceResult()) {
    if (!out.normal) Object.assign(out, this.surface.createSurfaceResult());
    return this.surface.surfaceAt(worldPos, out);
  }

  /** World-Y of the drivable surface. Cheap path for suspension rays. */
  heightAt(x, z) {
    return this.surface.heightAt(x, z);
  }

  /**
   * Barrier collision. Returns `out` with `{hit, normal, penetration}` when the sphere
   * at `worldPos` overlaps a barrier, and null when it does not.
   */
  barrierCollide(worldPos, radius, out = { hit: false, normal: new THREE.Vector3(), penetration: 0 }) {
    if (!this._barriers) return null;
    if (!out.normal) out.normal = new THREE.Vector3();
    return this._barriers.collide(worldPos, radius, out);
  }

  // --- convenience for other systems ----------------------------------------------

  /** Sector index (0..2) for a normalised lap position. */
  sectorAt(t) {
    const u = wrap01(t);
    if (u < this.sectors[1]) return 0;
    if (u < this.sectors[2]) return 1;
    return 2;
  }

  /** The DRS zone active at `t`, handling the zone that straddles the line, or null. */
  drsZoneAt(t) {
    const u = wrap01(t);
    for (const zone of this.drsZones) {
      if (zone.start <= zone.end) {
        if (u >= zone.start && u <= zone.end) return zone;
      } else if (u >= zone.start || u <= zone.end) return zone;
    }
    return null;
  }

  /** True when `t` is inside a DRS activation zone. */
  inDrsZone(t) {
    return this.drsZoneAt(t) !== null;
  }

  /** The corner whose braking-to-exit span contains `t`, or the next one ahead. */
  cornerAt(t) {
    const u = wrap01(t);
    let bestAhead = null;
    let bestGap = Infinity;
    for (const corner of this.corners) {
      const inside = corner.entryT <= corner.exitT
        ? u >= corner.entryT && u <= corner.exitT
        : u >= corner.entryT || u <= corner.exitT;
      if (inside) return corner;
      const gap = deltaT(u, corner.entryT);
      if (gap >= 0 && gap < bestGap) { bestGap = gap; bestAhead = corner; }
    }
    return bestAhead;
  }

  /** Signed lateral offset of the racing line at `t`, in metres right of centre. */
  racingLineOffsetAt(t) {
    const n = this.surface.count;
    const f = wrap01(t) * n;
    const a = Math.floor(f) % n;
    const b = (a + 1) % n;
    const u = f - Math.floor(f);
    return this.racingLineOffset[a] + (this.racingLineOffset[b] - this.racingLineOffset[a]) * u;
  }

  /** World point on the racing line at `t`, written into `out`. Allocation-free. */
  racingLinePoint(t, out) {
    const surf = this.surface;
    const n = surf.count;
    const f = wrap01(t) * n;
    const a = Math.floor(f) % n;
    const b = (a + 1) % n;
    const u = f - Math.floor(f);
    const o = this.racingLineOffset[a] + (this.racingLineOffset[b] - this.racingLineOffset[a]) * u;
    const x = surf.posX[a] + (surf.posX[b] - surf.posX[a]) * u;
    const y = surf.posY[a] + (surf.posY[b] - surf.posY[a]) * u;
    const z = surf.posZ[a] + (surf.posZ[b] - surf.posZ[a]) * u;
    const rxv = surf.rightX[a] + (surf.rightX[b] - surf.rightX[a]) * u;
    const rzv = surf.rightZ[a] + (surf.rightZ[b] - surf.rightZ[a]) * u;
    const bank = surf.tanBank[a] + (surf.tanBank[b] - surf.tanBank[a]) * u;
    return out.set(x + rxv * o, y - o * bank, z + rzv * o);
  }

  lateUpdate(alpha, ctx) {
    this._trackside?.animate(ctx.time.elapsed);
  }

  resize() {}

  dispose() {
    this.ctx?.events?.off?.('quality:change', this._onQuality);
    this._trackside?.dispose();
    this._meshBuilder?.dispose();
    this._barriers?.dispose();
    this.surface?.dispose();
    this.group.parent?.remove(this.group);
    this.group.clear();
  }
}
