import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, clamp01, lerp, smoothstep, DEG } from '../core/MathUtils.js';
import { BODY_V_FRONT, BODY_V_REAR } from './Teams.js';

/**
 * A 2026-regulation Formula 1 car, built entirely from code.
 *
 * Everything is a loft: a stack of closed cross-sections swept along the car and
 * skinned with quads. That is how real bodywork is defined (station sections down the
 * length of the tub) and it gives two things a box-and-cylinder model never does —
 * continuous surface curvature, so highlights travel along the flank instead of
 * snapping at an edge, and a single consistent UV wrap that the livery is painted in.
 *
 * Sections are superellipses rather than rounded rectangles. Raising the exponent
 * squares a section off without ever producing a zero-radius corner, so every edge on
 * the car carries a chamfer that catches light. Nothing here is a razor edge.
 *
 * Frames: car local, -Z forward, +X right, +Y up, origin at the CG. Authoring is done
 * in the more natural ground frame (y = 0 at the road) and shifted down by the CG
 * height on output, which is what GY() does.
 *
 * Geometry is built once per detail level and shared by all twenty cars; only the
 * materials differ. Call `disposeSharedGeometry()` when tearing the session down.
 */

const CG_HEIGHT = 0.280;                 // matches CarConfig.chassis.cgHeight
const GY = (h) => h - CG_HEIGHT;

const Z_FRONT_AXLE = -1.944;             // -wheelbase * (1 - frontWeightFraction)
const Z_REAR_AXLE = 1.656;

export const CAR_DIMENSIONS = {
  length: 5.63, width: 1.90, height: 0.95,
  noseTip: -2.40, wingLeadingEdge: -2.62, tail: 3.01,
  frontAxle: Z_FRONT_AXLE, rearAxle: Z_REAR_AXLE,
};

/** Everything the cockpit and the driver model have to line up with. Ground frame. */
export const COCKPIT_ANCHORS = {
  eye: [0, GY(0.790), -0.400],
  wheelCentre: [0, GY(0.558), -0.702],
  wheelRake: 62 * DEG,                   // column tilt from vertical
  shoulder: [0.245, GY(0.545), -0.150],
  hip: [0, GY(0.348), -0.040],
  knee: [0.172, GY(0.436), -1.030],
  ankle: [0.128, GY(0.300), -1.500],
  helmet: [0, GY(0.772), -0.238],
  rimTopY: GY(0.600),
  // Housing centre, glass centre and the yaw the glass is set at. Cockpit floats its
  // live render-target quad a few millimetres proud of the same glass plane the
  // external model carries, so both views agree on where the mirror is.
  mirrors: [
    { pos: [-0.428, GY(0.645), -0.655], housing: [-0.460, GY(0.645), -0.720], mount: [-0.320, GY(0.585), -0.560], yaw: 26 * DEG },
    { pos: [0.428, GY(0.645), -0.655], housing: [0.460, GY(0.645), -0.720], mount: [0.320, GY(0.585), -0.560], yaw: -26 * DEG },
  ],
};

/** DRS flap hinge, and how far it swings. 47 degrees is the regulation slot gap opened. */
export const DRS_PIVOT = [0, GY(0.788), 2.742];
export const DRS_OPEN_ANGLE = 47 * DEG;

const ROLES = ['body', 'wing', 'carbon', 'carbonWeave', 'carbonMatte', 'accent', 'dark', 'metal', 'halo'];

/*
 * Clearances, in metres. Every one of these exists because two surfaces on this car were
 * measured lying within a few millimetres of each other and nearly parallel — a second
 * shell over the first, with nothing to separate them. Numbers, not adjectives: the
 * measurements each one answers are in the comment at the part that uses it.
 */
/** Wall thickness an intake throat keeps inside the bodywork it is cut into. */
const DUCT_WALL = 0.020;
/** How far a cover panel's mid-plane stands proud of the surface it is seated on. */
const LOUVRE_STANDOFF = 0.008;
/** Extra nose-up rake on a cover panel, so it reads as a gill rather than a decal. */
const LOUVRE_RAKE = 0.030;
/** Smallest half-extent a duct wall is allowed to collapse to. */
const MIN_HALF_EXTENT = 0.006;

/**
 * Texture repeats per metre for the roles that wear a tiling material. These follow the
 * real weave and machining scales the library generates: a 12-tow twill tile is 24 mm
 * across, so carbon repeats about forty-two times per metre. Guessing here is what
 * turns a wishbone into a length of rope.
 */
const ROLE_TILING = {
  // Reciprocals of the library's own tile sizes, so a role never repeats at a scale the
  // texture was not drawn for: carbon is a 24 mm twill tile, anodised alloy a 300 mm
  // machining tile, and the halo's titanium draw marks a 220 mm one.
  carbon: 42, carbonMatte: 42, metal: 3.3, halo: 4.5, dark: 8, duct: 8,
  // The cockpit-range weave is a separate, higher-resolution 8-tow tile at 16 mm rather
  // than the body's 12-tow 24 mm one, so it repeats 62.5 times per metre. Reusing the
  // body's 42 here would stretch a 16 mm tile over 24 mm and put the tows at 3 mm — the
  // difference between reading as 2x2 twill and reading as corduroy at 400 mm.
  carbonWeave: 62.5,
};

// --- section primitives ------------------------------------------------------------

/**
 * Superellipse ring. `e` below 2 is a diamond, 2 is an ellipse, 4+ approaches a
 * rounded rectangle. Independent exponents and half-extents above and below the
 * section centre let one function describe a nose, a tub and a sidepod.
 */
function ringSection(n, s, z, out) {
  const pts = out?.pts ?? new Float32Array(n * 3);
  const us = out?.us ?? new Float32Array(n);
  const hwL = s.hwL ?? s.hw;
  const hwR = s.hwR ?? s.hw;
  const hhT = s.hhT ?? s.hh;
  const hhB = s.hhB ?? s.hh;
  const eT = s.eT ?? 3.0;
  const eB = s.eB ?? 3.0;
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
    // Undercut: draw the lower flank in toward the centreline, which is what turns a
    // slab-sided pod into the scalloped 2022+ shape.
    if (undercut > 0 && st < 0) x *= 1 - undercut * Math.pow(-st, 1.25);
    // Shoulder: flatten the upper surface outboard so the pod top becomes a ramp.
    if (shoulder > 0 && st > 0) y -= shoulder * hhT * Math.pow(Math.abs(ct), 1.6) * st;
    pts[i * 3] = (s.cx ?? 0) + x;
    pts[i * 3 + 1] = (s.cy ?? 0) + y;
    pts[i * 3 + 2] = z;
    us[i] = u;
  }
  return { pts, us, closed: true, n, z };
}

/**
 * Open arc version: the same section cut off at a rim height, sweeping from the right
 * rim down around the floor to the left rim. This is what makes the cockpit a hole
 * rather than a sealed tube.
 */
function arcSection(n, s, z, yRim) {
  const hhT = s.hhT ?? s.hh;
  const eT = s.eT ?? 3.0;
  const eB = s.eB ?? 3.0;
  const rel = clamp((yRim - (s.cy ?? 0)) / hhT, -0.999, 0.999);
  const phi = Math.asin(clamp01(Math.pow(Math.max(0, rel), eT / 2)));
  const th0 = phi;
  const th1 = -(Math.PI + phi);
  // The arc walks right rim -> right flank -> underside -> left flank -> left rim, so it
  // crosses the wrap's own seam, which sits on the underside centreline. The livery is
  // authored for that: both sides of the seam land in the black undertray band. But the
  // wrap coordinate has to *jump* there, and a jump between two neighbouring vertices
  // drags three quarters of the livery — every sponsor on the car — across the single
  // quad that straddles it. So the seam gets its own duplicated, zero-width column:
  // half the samples run down to the underside, half run on from it, and the two copies
  // of the underside vertex carry the two sides of the jump.
  const half = Math.max(2, n >> 1);
  const count = half * 2;
  const thSeam = -Math.PI * 0.5;
  const pts = new Float32Array(count * 3);
  const us = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    const before = i < half;
    const t = (before ? i : i - half) / (half - 1);
    // The last sample of the first half is the seam itself, pinned rather than lerped so
    // the two copies land on bit-identical coordinates and the column between them has
    // exactly no area to rasterise.
    const th = before
      ? (t >= 1 ? thSeam : lerp(th0, thSeam, t))
      : lerp(thSeam, th1, t);
    const ct = Math.cos(th);
    const st = Math.sin(th);
    const e = st >= 0 ? eT : eB;
    const x = (ct >= 0 ? (s.hwR ?? s.hw) : (s.hwL ?? s.hw)) * Math.sign(ct) * Math.pow(Math.abs(ct), 2 / e);
    const y = (st >= 0 ? hhT : (s.hhB ?? s.hh)) * Math.sign(st) * Math.pow(Math.abs(st), 2 / e);
    pts[i * 3] = (s.cx ?? 0) + x;
    pts[i * 3 + 1] = (s.cy ?? 0) + y;
    pts[i * 3 + 2] = z;
    // Keep the wrap coordinate continuous with the closed sections either side; past the
    // seam it continues into the next turn of the ring rather than wrapping back.
    us[i] = (th + Math.PI * 0.5) / (Math.PI * 2) + (before ? 0 : 1);
  }
  return { pts, us, closed: false, n: count, z };
}

/**
 * Inverted aerofoil section in the (z, y) plane. Thickness follows the NACA
 * four-digit half-thickness polynomial; camber is negative so the suction surface is
 * underneath, and `aoa` lifts the trailing edge, exactly like a real wing element.
 *
 * Points run leading edge -> upper surface -> trailing edge -> lower surface, which is
 * the winding the loft needs for a span-wise (+X) sweep to face outward, and puts the
 * upper surface in the first half of the wrap coordinate.
 *
 * The NACA polynomial closes the trailing edge to a mathematical point, which renders as
 * a razor: one pixel wide, aliasing, and with no edge for a highlight to run along, so
 * the element reads as a zero-thickness plane. Real elements are laid up to a finite
 * trailing edge — the regulations mandate a minimum — so `teThickness` metres of it are
 * ramped in linearly along the chord, sharp at the nose and blunt at the tail.
 *
 * That ramp on its own leaves a *blunt* tail: two 90-degree corners and a flat 3.4 mm
 * face between them, which at chase distance is one hard dark line and reads as a cut
 * sheet. A laid-up element is radiused. So the last `teHalf` of chord is not surface at
 * all: the two surfaces stop at `tEnd` and an elliptical cap — chordwise semi-axis
 * `teHalf`, normal semi-axis the local half-thickness, so it meets both surfaces
 * tangentially — carries the outline round from one to the other. The normal rotates
 * through 180 degrees across 3.4 mm, which is what puts a continuous specular highlight
 * along every trailing edge on the car instead of an aliased black line.
 *
 * Points still run leading edge -> upper surface -> trailing edge -> lower surface, and
 * the wrap coordinate is still i/n, so the livery is unaffected. The cap costs `2*cap-1`
 * of the section's points and only the hero level can afford three a side; the impostor
 * spends one, which degrades to exactly the blunt tail it had before.
 */
const TE_THICKNESS = 0.0034;

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

  const camberAt = (t) => (t < p
    ? (camber / (p * p)) * (2 * p * t - t * t)
    : (camber / ((1 - p) * (1 - p))) * ((1 - 2 * p) + 2 * p * t - t * t));

  const halfThickness = (t) => {
    const st = Math.sqrt(Math.max(0, t));
    return 5 * thick * (0.2969 * st - 0.1260 * t - 0.3516 * t * t + 0.2843 * t * t * t - 0.1015 * t * t * t * t)
      + teHalf * t;
  };

  // Cap resolution. Three points a side is five facets across the radius, which is where
  // the highlight stops being a stair; below a 20-point section there is no budget for it.
  const cap = clamp(Math.round(n / 10), 1, 4);
  const tEnd = 1 - teHalf;
  const yEnd = halfThickness(tEnd);
  const cEnd = camberAt(tEnd);
  const upperN = half - cap;            // points on the upper surface, LE .. tEnd
  const lowerCap = cap - 1;             // cap points strictly between the tail and tEnd
  const lowerN = n - half - cap + 1;    // points on the lower surface, tEnd .. LE

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

  // Upper surface. Cosine spacing packs points into the leading edge where the curvature
  // lives; f = 1 lands exactly on the cap's tangent point rather than short of it.
  for (let i = 0; i < upperN; i++) {
    const f = upperN > 1 ? i / (upperN - 1) : 0;
    const t = (0.5 - 0.5 * Math.cos(Math.PI * f)) * tEnd;
    emit(t, camberAt(t) + halfThickness(t));
  }
  // Trailing-edge cap, upper tangent round to the tail tip.
  for (let i = 1; i <= cap; i++) {
    const phi = Math.PI * 0.5 * (1 - i / cap);
    const t = tEnd + teHalf * Math.cos(phi);
    emit(t, cEnd + yEnd * Math.sin(phi));
  }
  // ...and on round to the lower tangent, which the lower surface then starts from.
  for (let i = 1; i <= lowerCap; i++) {
    const phi = -Math.PI * 0.5 * (i / cap);
    const t = tEnd + teHalf * Math.cos(phi);
    emit(t, cEnd + yEnd * Math.sin(phi));
  }
  // Lower surface, tEnd back toward the leading edge. It stops one step short of t = 0:
  // the ring closes on to the section's first point, which is the leading edge itself.
  for (let i = 0; i < lowerN; i++) {
    const f = 1 - i / lowerN;
    const t = (0.5 - 0.5 * Math.cos(Math.PI * f)) * tEnd;
    emit(t, camberAt(t) - halfThickness(t));
  }

  return { pts, us, closed: true, n };
}

/**
 * Explicit polyline section, used where a shape is genuinely not an ellipse: the floor
 * with its two venturi tunnels arched into the underside, and the diffuser ramp.
 * `poly` is [x, y, ...] for the right half; it is mirrored to close the ring.
 */
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
  // Arc-length parameterisation keeps the livery from stretching over the tunnels.
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

// --- lofting -----------------------------------------------------------------------

const _uv = [0, 0];

/**
 * Skin a stack of sections. `uvFn(ringU, sweepS, x, y, z, out)` decides the wrap; the
 * default is the body convention (x = along the car, y = around the section).
 */
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
      const src = (i % n) * 3;
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
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);

  // How fast the wrap coordinate advances per metre travelled along the loft, measured
  // at each end. `capGeometry` needs it: a cap fan whose vertices all carry one sweep
  // value has *zero* UV area — every triangle in it collapses to a line in texture
  // space — so the face samples a one-texel-wide column through the whole livery and
  // shatters into sponsor fragments the moment it is minified. Continuing the sweep
  // across the cap by its own radius gives the fan real area and keeps its rim exactly
  // on the ring's UVs, so there is no seam where the cap meets the tube.
  const rateStart = count > 1 ? sweepRate(secs[0], secs[1], sweep[0], sweep[1]) : 0;
  const rateEnd = count > 1
    ? sweepRate(secs[count - 1], secs[count - 2], sweep[count - 1], sweep[count - 2]) : 0;
  // Never let a cap reach further into the texture than the loft itself spans, which is
  // all that keeps a two-section loft (a plate, a strut) from projecting its end faces
  // clean off the far side of the wrap.
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
  // Normals are computed after the merge, but the cap vertices are never welded to the
  // ring, so the shading break at the end of a loft stays crisp instead of rolling over.
  const merged = mergeGeometries([geo, ...caps], false);
  geo.dispose();
  for (const c of caps) c.dispose();
  merged.computeVertexNormals();
  return merged;
}

/** Centroid of a section's ring, into `out`. */
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

/**
 * Sweep units per metre between two neighbouring sections, signed so that it points
 * away from `far` — i.e. out of the end of the loft that `near` closes.
 */
function sweepRate(near, far, sNear, sFar) {
  sectionCentre(near, _cA);
  sectionCentre(far, _cB);
  const d = Math.hypot(_cA[0] - _cB[0], _cA[1] - _cB[1], _cA[2] - _cB[2]);
  if (d < 1e-6) return 0;
  return (sNear - sFar) / d;
}

/**
 * Triangle fan closing one end of a loft. `dir` is +1 or -1 and only sets the winding.
 *
 * The rim vertices take the ring's own wrap coordinates, so the cap is continuous with
 * the tube it closes. The apex takes the coordinate the loft would have reached one cap
 * radius further along, which is what stops the fan from being degenerate in texture
 * space: without it every triangle here has zero UV area and the whole face samples a
 * single column of the livery. `rate` is sweep units per metre out of this end and
 * `swLimit` caps how far the extrapolation may run.
 */
function capGeometry(sec, s, uvFn, dir, rate = 0, swLimit = 1) {
  const n = sec.n;
  // A closed ring gets one extra rim vertex: the same point as the first, carrying the
  // wrap coordinate of a full turn instead of the start of one. Without it the wedge
  // that closes the fan straddles the wrap's branch cut and interpolates through the
  // entire livery — the same defect the loft's own seam column already avoids this way.
  const rim = sec.closed ? n + 1 : n;
  const verts = rim + 1;
  const position = new Float32Array(verts * 3);
  const uv = new Float32Array(verts * 2);
  sectionCentre(sec, _cA);
  const cx = _cA[0];
  const cy = _cA[1];
  const cz = _cA[2];
  // Mean rim radius: how far the cap reaches out of its own plane's centre, and so how
  // much sweep the apex is entitled to.
  let radius = 0;
  for (let i = 0; i < n; i++) {
    radius += Math.hypot(sec.pts[i * 3] - cx, sec.pts[i * 3 + 1] - cy, sec.pts[i * 3 + 2] - cz);
  }
  radius /= n;
  const reach = clamp(rate * radius, -swLimit, swLimit);
  position[0] = cx; position[1] = cy; position[2] = cz;
  uvFn(0.5, s + reach, cx, cy, cz, _uv);
  uv[0] = _uv[0]; uv[1] = _uv[1];
  for (let i = 0; i < rim; i++) {
    const src = (i % n) * 3;
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
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  return geo;
}

/**
 * Box-projected UVs for the parts that wear a tiling material (carbon, anodised metal,
 * the halo). The livery wrap only makes sense on the painted bodywork; giving a floor
 * or a wishbone wrap coordinates would smear one texel across the whole part, so those
 * roles get a world-scale projection picked off the dominant normal axis instead.
 */
function triplanarUv(geo, tilesPerMetre) {
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
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
    if (ny >= nx && ny >= nz) { u = x; v = z; }
    else if (nx >= nz) { u = z; v = y; }
    else { u = x; v = y; }
    uv[i * 2] = u * tilesPerMetre;
    uv[i * 2 + 1] = v * tilesPerMetre;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

/**
 * The livery wrap reserves a band for the sidepod flank, which is the surface the eye
 * lands on, and a separate one for the tub and engine-cover flanks behind it. Without
 * that split both surfaces sample the same texels and the title sponsor gets printed
 * twice, once on the pod and once on the cover right above it.
 */
function bodyUv(ringU, sweepS, x, y, z, out) {
  out[0] = sweepS;
  out[1] = ringU;
  return out;
}

/** Shortest signed offset from an anchor on a wrapped [0,1) ring. */
function ringOffset(u, anchor) {
  let d = u - anchor;
  while (d > 0.5) d -= 1;
  while (d < -0.5) d += 1;
  return d;
}

/** Central structure: nose, tub, engine cover. Squeezed toward the spine band. */
function centreUv(ringU, sweepS, x, y, z, out) {
  out[0] = sweepS;
  out[1] = 0.5 + ringOffset(ringU, 0.5) * 0.76;
  return out;
}

/** How much of the wrap's v the sidepod's own band is worth. */
const POD_V_SPAN = 0.46;

/**
 * Sidepod: its outer face lands dead centre of the big-sponsor band.
 *
 * The band is only 0.46 of the wrap, so a ring that walks all the way round the pod has
 * to make up the other 0.54 somewhere. Taking the shortest way round the anchor spends
 * it all in one step, on the quad diametrically opposite the outer face — 470 texels of
 * livery, every sponsor on the car, across thirteen millimetres of the pod's inboard
 * flank, which is the slot the chase camera looks straight down. Instead the remainder
 * is eased in over the hidden inboard quarters, so v advances by exactly one per turn of
 * the ring and the map is continuous everywhere: no seam, no fold, and the outer face
 * and the crest keep the coordinates they had.
 */
function podUv(side) {
  const anchor = side > 0 ? 0.25 : 0.75;
  const spill = (1 - POD_V_SPAN) * 0.5;
  return (ringU, sweepS, x, y, z, out) => {
    // Unwrapped on purpose: v has to be monotone in the ring parameter or the
    // rasteriser interpolates straight through the whole livery on whichever quad the
    // branch cut lands. `turns` carries the wrap out of the interpolation and into a
    // whole repeat of the texture, which the livery tiles in and the eye cannot see.
    let d = ringU - anchor;
    let turns = 0;
    while (d > 0.5) { d -= 1; turns += 1; }
    while (d < -0.5) { d += 1; turns -= 1; }
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

/** Span across x, but with the ring parameter squeezed into one band of the texture. */
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

// --- small part helpers -------------------------------------------------------------

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

/** A chamfered slab: the workhorse for plates, strakes, fences and vanes. */
function slab(w, h, d, bevel = 0.006) {
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
  const a = geo.getAttribute('uv');
  for (let i = 0; i < a.count; i++) a.setXY(i, u, v);
  a.needsUpdate = true;
  return geo;
}

/** Curved plate swept along a 2D outline in (z, y), given a thickness in x. */
function plate(outline, x, thickness, uvFn) {
  const n = outline.length / 2;
  // Outlines are authored anticlockwise in (z, y) because that is how you read a
  // drawing; the loft sweeps along +X and needs the opposite sense to face outward, so
  // the ring is walked backwards here rather than every table being written in reverse.
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

/**
 * One fixed suspension member between two points. `a` and `b` arrive in the CG frame
 * (that is what suspensionLinks publishes) while this builder authors in the ground
 * frame, so the CG height goes back on. Used only by the distant level, which has no
 * articulated strut mesh to move.
 */
function staticLink(a, b, chord) {
  _linkDir.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = _linkDir.length();
  if (len < 1e-4) return null;
  _linkDir.multiplyScalar(1 / len);
  const geo = new THREE.BoxGeometry(len, 0.017 * chord, 0.050 * chord, 1, 1, 1);
  _linkMid.set((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5 + CG_HEIGHT, (a[2] + b[2]) * 0.5);
  _q.setFromUnitVectors(_axisX, _linkDir);
  _m4.compose(_linkMid, _q, _unitScale);
  geo.applyMatrix4(_m4);
  return stripUv(geo, 0.5, 0.5);
}

// --- station tables -----------------------------------------------------------------

/**
 * Bodywork stations, ground frame. `cy` is the section centre height, `hhT`/`hhB` the
 * half-heights above and below it, `eT`/`eB` the superellipse exponents. The tub
 * stations additionally carry `rim`, the height the section is cut off at to open the
 * cockpit; a rim of `null` means the section closes over the top.
 */
const NOSE_STATIONS = [
  { z: -2.420, hw: 0.020, hhT: 0.018, hhB: 0.016, cy: 0.288, eT: 2.2, eB: 2.2 },
  { z: -2.360, hw: 0.058, hhT: 0.050, hhB: 0.044, cy: 0.288, eT: 2.5, eB: 2.4 },
  { z: -2.200, hw: 0.082, hhT: 0.066, hhB: 0.058, cy: 0.296, eT: 2.7, eB: 2.6 },
  { z: -2.000, hw: 0.104, hhT: 0.082, hhB: 0.072, cy: 0.310, eT: 2.9, eB: 2.7 },
  { z: -1.780, hw: 0.128, hhT: 0.100, hhB: 0.088, cy: 0.330, eT: 3.1, eB: 2.8 },
  { z: -1.550, hw: 0.158, hhT: 0.124, hhB: 0.108, cy: 0.352, eT: 3.3, eB: 3.0 },
  { z: -1.320, hw: 0.196, hhT: 0.146, hhB: 0.132, cy: 0.372, eT: 3.5, eB: 3.2 },
  { z: -1.050, hw: 0.240, hhT: 0.175, hhB: 0.160, cy: 0.390, eT: 3.8, eB: 3.4 },
];

const TUB_STATIONS = [
  { z: -1.050, hw: 0.240, hhT: 0.175, hhB: 0.160, cy: 0.390, eT: 3.8, eB: 3.4, rim: null },
  { z: -0.900, hw: 0.268, hhT: 0.216, hhB: 0.172, cy: 0.400, eT: 3.8, eB: 3.4, rim: 0.583 },
  { z: -0.720, hw: 0.292, hhT: 0.245, hhB: 0.180, cy: 0.402, eT: 3.9, eB: 3.4, rim: 0.575 },
  { z: -0.520, hw: 0.305, hhT: 0.250, hhB: 0.185, cy: 0.400, eT: 4.0, eB: 3.4, rim: 0.556 },
  { z: -0.320, hw: 0.310, hhT: 0.252, hhB: 0.190, cy: 0.398, eT: 4.0, eB: 3.4, rim: 0.556 },
  { z: -0.120, hw: 0.308, hhT: 0.255, hhB: 0.195, cy: 0.398, eT: 4.0, eB: 3.4, rim: 0.578 },
  { z: 0.040, hw: 0.298, hhT: 0.258, hhB: 0.198, cy: 0.396, eT: 3.9, eB: 3.3, rim: 0.620 },
  { z: 0.160, hw: 0.286, hhT: 0.252, hhB: 0.198, cy: 0.394, eT: 3.8, eB: 3.3, rim: null },
];

const REAR_BODY_STATIONS = [
  { z: 0.160, hw: 0.286, hhT: 0.252, hhB: 0.198, cy: 0.394, eT: 3.8, eB: 3.3 },
  { z: 0.450, hw: 0.262, hhT: 0.238, hhB: 0.196, cy: 0.386, eT: 3.6, eB: 3.2 },
  { z: 0.800, hw: 0.222, hhT: 0.212, hhB: 0.186, cy: 0.372, eT: 3.4, eB: 3.0 },
  { z: 1.150, hw: 0.180, hhT: 0.180, hhB: 0.170, cy: 0.356, eT: 3.2, eB: 2.9 },
  { z: 1.500, hw: 0.142, hhT: 0.146, hhB: 0.150, cy: 0.340, eT: 3.0, eB: 2.8 },
  { z: 1.850, hw: 0.108, hhT: 0.114, hhB: 0.126, cy: 0.326, eT: 2.9, eB: 2.7 },
  { z: 2.150, hw: 0.082, hhT: 0.086, hhB: 0.098, cy: 0.316, eT: 2.8, eB: 2.6 },
  { z: 2.450, hw: 0.062, hhT: 0.062, hhB: 0.070, cy: 0.308, eT: 2.7, eB: 2.5 },
  { z: 2.620, hw: 0.046, hhT: 0.044, hhB: 0.050, cy: 0.302, eT: 2.6, eB: 2.4 },
];

/** Airbox: the mouth at the front, swallowed by the engine cover at the back. */
const AIRBOX_STATIONS = [
  { z: -0.040, hw: 0.098, hhT: 0.075, hhB: 0.115, cy: 0.815, eT: 2.4, eB: 2.8 },
  { z: 0.060, hw: 0.118, hhT: 0.090, hhB: 0.150, cy: 0.800, eT: 2.6, eB: 3.0 },
  { z: 0.200, hw: 0.145, hhT: 0.105, hhB: 0.230, cy: 0.760, eT: 2.8, eB: 3.2 },
  { z: 0.400, hw: 0.175, hhT: 0.115, hhB: 0.310, cy: 0.700, eT: 3.0, eB: 3.4 },
  { z: 0.620, hw: 0.200, hhT: 0.110, hhB: 0.360, cy: 0.640, eT: 3.2, eB: 3.4 },
  { z: 0.900, hw: 0.190, hhT: 0.085, hhB: 0.360, cy: 0.590, eT: 3.2, eB: 3.2 },
];

/**
 * Sidepod, right-hand side. `undercut` scallops the lower flank and `shoulder` flattens
 * the top into the downwash ramp — together they are the whole 2022+ sidepod language.
 */
const SIDEPOD_STATIONS = [
  { z: -0.820, cx: 0.545, hw: 0.185, hhT: 0.118, hhB: 0.112, cy: 0.398, eT: 3.6, eB: 3.4, undercut: 0.10, shoulder: 0.05 },
  { z: -0.550, cx: 0.558, hw: 0.202, hhT: 0.138, hhB: 0.126, cy: 0.402, eT: 3.8, eB: 3.4, undercut: 0.24, shoulder: 0.18 },
  { z: -0.100, cx: 0.548, hw: 0.206, hhT: 0.142, hhB: 0.142, cy: 0.396, eT: 3.8, eB: 3.2, undercut: 0.40, shoulder: 0.34 },
  { z: 0.450, cx: 0.500, hw: 0.190, hhT: 0.136, hhB: 0.156, cy: 0.376, eT: 3.6, eB: 3.0, undercut: 0.56, shoulder: 0.48 },
  { z: 1.000, cx: 0.400, hw: 0.156, hhT: 0.116, hhB: 0.152, cy: 0.346, eT: 3.4, eB: 2.9, undercut: 0.66, shoulder: 0.58 },
  { z: 1.450, cx: 0.300, hw: 0.116, hhT: 0.092, hhB: 0.126, cy: 0.316, eT: 3.2, eB: 2.8, undercut: 0.64, shoulder: 0.60 },
  { z: 1.800, cx: 0.222, hw: 0.078, hhT: 0.062, hhB: 0.088, cy: 0.292, eT: 3.0, eB: 2.7, undercut: 0.56, shoulder: 0.55 },
  { z: 2.000, cx: 0.172, hw: 0.048, hhT: 0.038, hhB: 0.054, cy: 0.278, eT: 2.8, eB: 2.6, undercut: 0.45, shoulder: 0.45 },
];

/** Floor and diffuser in one loft: the tunnel arch simply grows toward the exit. */
const FLOOR_STATIONS = [
  { z: -1.300, hw: 0.360, keel: 0.040, archX: 0.200, archY: 0.055, edgeY: 0.042, topY: 0.078 },
  { z: -0.900, hw: 0.520, keel: 0.040, archX: 0.260, archY: 0.075, edgeY: 0.040, topY: 0.092 },
  { z: -0.400, hw: 0.680, keel: 0.040, archX: 0.320, archY: 0.105, edgeY: 0.038, topY: 0.118 },
  { z: 0.200, hw: 0.745, keel: 0.040, archX: 0.360, archY: 0.135, edgeY: 0.036, topY: 0.152 },
  { z: 0.900, hw: 0.750, keel: 0.042, archX: 0.380, archY: 0.165, edgeY: 0.038, topY: 0.192 },
  { z: 1.550, hw: 0.720, keel: 0.045, archX: 0.400, archY: 0.200, edgeY: 0.045, topY: 0.236 },
  { z: 2.020, hw: 0.665, keel: 0.050, archX: 0.410, archY: 0.245, edgeY: 0.058, topY: 0.282 },
  { z: 2.350, hw: 0.610, keel: 0.062, archX: 0.420, archY: 0.302, edgeY: 0.082, topY: 0.334 },
  { z: 2.600, hw: 0.560, keel: 0.078, archX: 0.420, archY: 0.348, edgeY: 0.108, topY: 0.378 },
];

/**
 * Four front-wing elements. Chord and incidence both grow outboard.
 *
 * `tipSweep` translates the outboard end of an element forward. It has to: the front
 * axle is at z = -1.944 and a 720 mm tyre reaches 360 mm ahead of it, so anything past
 * z = -2.304 with |x| beyond 0.848 is inside the front tyre. Unswept, the upper elements
 * ran 200 mm into it and the endplate ran 320 mm in. The sweep puts every outboard
 * trailing edge at z = -2.36 — 56 mm clear of the tyre — which is also what a real front
 * wing looks like: the cascade converges and rakes forward toward the endplate.
 *
 * Element heights carry the slot gap. Authored flat — 46 mm of centre-to-centre rise per
 * element against sections that are already 60 to 94 mm deep once their incidence is
 * applied — elements three and four *interpenetrated across the whole span*: measured
 * minimum surface separation was 1.2 mm between two and three and 0.0 mm between three
 * and four, over 350 square centimetres. Two aerofoils sharing the same air is not a
 * slot; it is one lump with a ragged intersection curve printed across it, and it is
 * the second-largest patch of coincident surface on the car. Spreading the stack by
 * -12/-4/+10/+30 mm opens a real gap of 26.8 / 14.6 / 8.0 mm and costs 12 mm of ground
 * clearance at the mainplane and 30 mm of height at the flap, which the endplate
 * outline below now follows.
 */
const FRONT_WING_ELEMENTS = [
  { zLE: -2.612, chord0: 0.255, chord1: 0.318, y0: 0.070, y1: 0.094, aoa0: 0.10, aoa1: 0.17, thickness: 0.085, camber: -0.055, neutralCentre: true, tipSweep: 0.066 },
  { zLE: -2.470, chord0: 0.150, chord1: 0.196, y0: 0.124, y1: 0.166, aoa0: 0.26, aoa1: 0.36, thickness: 0.075, camber: -0.075, tipSweep: 0.086 },
  { zLE: -2.358, chord0: 0.130, chord1: 0.172, y0: 0.186, y1: 0.244, aoa0: 0.40, aoa1: 0.52, thickness: 0.070, camber: -0.085, tipSweep: 0.174 },
  { zLE: -2.256, chord0: 0.112, chord1: 0.150, y0: 0.252, y1: 0.328, aoa0: 0.54, aoa1: 0.68, thickness: 0.065, camber: -0.090, tipSweep: 0.254 },
];

const FRONT_WING_HALF_SPAN = 0.950;
const REAR_WING_HALF_SPAN = 0.550;

/**
 * Inboard face of the front tyre, and the span fraction by which an outboard element has
 * to have finished sweeping forward. Anything at |x| past this and aft of z = -2.304 is
 * inside the wheel.
 */
const FRONT_TYRE_INNER_X = 0.848;
const TIP_SWEEP_END = FRONT_TYRE_INNER_X / FRONT_WING_HALF_SPAN - 0.03;

/**
 * Front-wing endplate, in (z, y). It sits at |x| = 0.95, which is inside the tyre's own
 * 0.848..1.153 band, so the whole outline has to live ahead of z = -2.304.
 */
const FW_ENDPLATE = [
  -2.640, 0.030, -2.520, 0.018, -2.420, 0.026, -2.358, 0.072,
  -2.352, 0.316, -2.404, 0.366, -2.520, 0.360, -2.634, 0.308, -2.672, 0.160,
];

const RW_ENDPLATE = [
  2.440, 0.402, 2.985, 0.432, 3.005, 0.826, 2.902, 0.900,
  2.580, 0.906, 2.442, 0.860, 2.398, 0.560,
];

// --- part construction ---------------------------------------------------------------

function sectionsFrom(table, n, mirror = 1) {
  const out = [];
  for (const s of table) out.push(ringSection(n, s, s.z));
  if (mirror < 0) {
    for (const sec of out) {
      // Mirroring the section reverses its winding, so walk the ring backwards to keep
      // the surface facing outward.
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
    // The first vertex maps to itself, so reversing hands it u = 1 — the same place on
    // the ring as u = 0, but at the far end of the wrap. Written that way the array is
    // no longer sorted, and a wrap that is monotone in u (which is what keeps a whole
    // livery out of a single quad) reads a fold across the very first edge. A ring
    // starts at the start of the ring.
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
      0, s.keel,
      s.archX * 0.42, s.keel + (s.archY - s.keel) * 0.52,
      s.archX, s.archY,
      s.archX + (s.hw - s.archX) * 0.52, s.keel + (s.archY - s.keel) * 0.30,
      s.hw * 0.965, s.edgeY,
      s.hw, s.edgeY + 0.020,
      s.hw * 0.955, s.topY,
      s.hw * 0.480, s.topY + 0.006,
      0, s.topY,
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
    // Complete just inboard of the tyre's inner face: past there the element has to
    // already be clear of the wheel, not still on its way.
    const sweep = tipSweep * smoothstep(0.42, TIP_SWEEP_END, s);
    const sec = airfoilSection(profileN, {
      x, y, z: el.zLE + chord * 0.25 - sweep,
      chord, thickness: el.thickness,
      camber: el.camber * camberScale,
      aoa: aoa * lerp(0.35, 1, camberScale),
    });
    secs.push(sec);
  }
  return loft(secs, { uv: uvFn, sweep: secs.map((_, i) => i / (stations - 1)), capStart: -1, capEnd: 1 });
}

function tube(points, radius, radial, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(p[0], p[1], p[2])), closed, 'centripetal', 0.5);
  return new THREE.TubeGeometry(curve, Math.max(12, points.length * 6), radius, radial, closed);
}

/** Halo: 60 mm titanium section, front pylon on the centreline, ring around the driver. */
function haloGeometry(radial) {
  const pylon = tube([
    [0, 0.548, -0.930], [0, 0.648, -0.912], [0, 0.766, -0.892], [0, 0.862, -0.876], [0, 0.902, -0.868],
  ], 0.0265, radial);
  const arms = [];
  for (const s of [1, -1]) {
    arms.push(tube([
      [0, 0.902, -0.868],
      [s * 0.120, 0.918, -0.800],
      [s * 0.258, 0.928, -0.610],
      [s * 0.340, 0.921, -0.360],
      [s * 0.366, 0.868, -0.090],
      [s * 0.352, 0.748, 0.030],
      [s * 0.322, 0.636, 0.062],
    ], 0.0250, radial));
  }
  // A vane fairing where the pylon meets the ring, as the real part carries.
  const fairing = placed(slab(0.052, 0.150, 0.075, 0.012), 0, 0.822, -0.884);
  const merged = mergeGeometries([pylon, ...arms, stripUv(fairing, 0.5, 0.5)], false);
  pylon.dispose();
  for (const a of arms) a.dispose();
  fairing.dispose();
  merged.computeVertexNormals();
  return merged;
}

/** Where the cockpit opening's edge runs, shared with Cockpit so the trim lines up. */
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

/**
 * Sample a station table at an arbitrary z, blending every field linearly between the
 * two stations that bracket it. Clamps to the ends.
 *
 * A duct built from a *scaled copy of the inlet* rather than from the parent surface at
 * its own z is the defect this exists to remove. The airbox mouth sits at cy = 0.815 and
 * the cover it disappears into has dropped to cy = 0.736 two hundred millimetres later;
 * a throat pinned to the mouth's centre climbs relative to the surface it is supposed to
 * be inside, and by z = 0.28 its crown stood at y = 0.848 against the airbox's own 0.845
 * — three millimetres proud, over a hand-sized patch where the two surfaces are within
 * eight degrees of parallel. That is a duplicated shell, and it is what a depth buffer
 * resolves as a field of stipple, one fragment from the dark duct and the next from the
 * livery, which reads exactly as the black-and-white speckle with colour fringing that
 * the engine cover has carried since round three. Both sidepod inlets had the same
 * defect at their own scale. Sampling the parent here is what guarantees a throat is
 * inside the bodywork by a real wall thickness at every station, not just at the rim.
 */
function stationAt(table, z) {
  let i = 0;
  while (i < table.length - 2 && table[i + 1].z < z) i++;
  const a = table[i];
  const b = table[i + 1];
  const span = b.z - a.z;
  const t = clamp01(span > 1e-9 ? (z - a.z) / span : 0);
  const mix = (key, dflt = 0) => lerp(a[key] ?? dflt, b[key] ?? dflt, t);
  return {
    cx: mix('cx'), cy: mix('cy'), z,
    hw: mix('hw'),
    hhT: mix('hhT', a.hh ?? 0), hhB: mix('hhB', a.hh ?? 0),
    eT: mix('eT', 3.0), eB: mix('eB', 3.0),
    undercut: mix('undercut'), shoulder: mix('shoulder'),
  };
}

/**
 * A station moved `wall` metres inside its parent and then scaled by `f` about the
 * parent's own centre, so the surface it generates is strictly inside the parent's.
 *
 * The shoulder term needs the correction: it drops the upper surface by
 * `shoulder * hhT`, so an inset section with a smaller hhT would be dropped *less* and
 * could surface through the parent's shoulder ramp. Preserving the absolute drop keeps
 * the inner section below the outer one at every angle.
 */
function insetStation(s, wall, f) {
  const hhT = Math.max(MIN_HALF_EXTENT, s.hhT - wall) * f;
  return {
    cx: s.cx, cy: s.cy, z: s.z,
    hw: Math.max(MIN_HALF_EXTENT, s.hw - wall) * f,
    hhT,
    hhB: Math.max(MIN_HALF_EXTENT, s.hhB - wall) * f,
    eT: s.eT, eB: s.eB,
    undercut: s.undercut,
    shoulder: s.shoulder > 0 ? s.shoulder * (s.hhT / hhT) : 0,
  };
}

/**
 * Height of a lofted body's upper surface directly above (x, z), or null if x is off the
 * section. Used to seat the panels that lie on the engine cover: a slab authored at a
 * fixed height and a guessed rake crosses a surface that is curved in both directions,
 * and every square centimetre where it grazes is another patch of z-fighting.
 */
function surfaceYAt(table, x, z) {
  const s = stationAt(table, z);
  const dx = Math.abs(x - s.cx);
  if (s.hw <= 1e-6 || dx >= s.hw) return null;
  const ct = Math.pow(dx / s.hw, s.eT * 0.5);
  const st = Math.sqrt(Math.max(0, 1 - ct * ct));
  return s.cy + s.hhT * Math.pow(st, 2 / s.eT) - s.shoulder * s.hhT * Math.pow(ct, 1.6) * st;
}

/**
 * Seat a flat panel on a lofted surface: returns the centre height and the two rotations
 * that put the panel at least `standoff` metres proud of the surface across its whole
 * footprint. The rake and roll are read off the surface itself and the height is then
 * lifted clear of the worst point under the panel, so no part of it can sink back
 * through a cover that curves in both directions.
 */
function seatOnBody(table, x, z, halfX, halfZ, standoff) {
  const at = (px, pz) => surfaceYAt(table, px, pz) ?? surfaceYAt(table, 0, pz) ?? 0;
  const front = 0.5 * (at(x - halfX, z - halfZ) + at(x + halfX, z - halfZ));
  const back = 0.5 * (at(x - halfX, z + halfZ) + at(x + halfX, z + halfZ));
  const inner = 0.5 * (at(x - halfX, z - halfZ) + at(x - halfX, z + halfZ));
  const outer = 0.5 * (at(x + halfX, z - halfZ) + at(x + halfX, z + halfZ));
  // Rake about x follows the cover falling away aft; roll about z follows it falling
  // away outboard. Both are read straight off the surface rather than guessed.
  const rx = -Math.atan2(back - front, 2 * halfZ);
  const rz = Math.atan2(outer - inner, 2 * halfX);
  // The cover is convex in both directions, so a plane through the edge midpoints dips
  // below it in the interior. Sample the whole footprint and lift the plane clear of the
  // highest point found, or the panel sinks back into the bodywork somewhere between the
  // corners — which is precisely how a panel ends up within a millimetre of the surface
  // it is bolted to over a hand-sized patch.
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
  { ring: 40, span: 21, prof: 30, radial: 12, mid: true, fine: true },
];

const _shared = new Map();

/**
 * Build (or fetch) the shared geometry for one detail level.
 * `detail`: 2 = hero, 1 = mid-field, 0 = distant impostor.
 */
export function buildCarGeometry(detail) {
  const cached = _shared.get(detail);
  if (cached) return cached;

  const P = LOD_PARAMS[clamp(detail | 0, 0, 2)];
  const bucket = new Map();
  const add = (role, geo) => {
    if (!geo) return;
    let list = bucket.get(role);
    if (!list) bucket.set(role, (list = []));
    list.push(geo);
  };

  const wingUvFull = bandUv(-FRONT_WING_HALF_SPAN, FRONT_WING_HALF_SPAN, 0.245, 0.355);
  const rearUv = makeWingUv(-REAR_WING_HALF_SPAN, REAR_WING_HALF_SPAN);

  add('body', loft(sectionsFrom(NOSE_STATIONS, P.ring), { capStart: -1, uv: centreUv }));
  add('body', loft(tubSections(P.ring), { capStart: 1, capEnd: -1, uv: centreUv }));
  add('body', loft(sectionsFrom(REAR_BODY_STATIONS, P.ring), { capEnd: 1, uv: centreUv }));
  add('body', loft(sectionsFrom(AIRBOX_STATIONS, P.ring), { capEnd: 1, uv: centreUv }));

  // Airbox throat: the inlet has to be a hole you can see into, not a painted decal.
  // Every ring past the rim is the *parent airbox section at that z*, moved DUCT_WALL
  // inside it and then tapered, so the throat cannot surface through the cover however
  // steeply the cover's centreline drops away behind the mouth.
  const mouth = AIRBOX_STATIONS[0];
  add('duct', loft([
    ringSection(P.ring, mouth, mouth.z),
    ringSection(P.ring, insetStation(stationAt(AIRBOX_STATIONS, 0.10), DUCT_WALL, 0.80), 0.10),
    ringSection(P.ring, insetStation(stationAt(AIRBOX_STATIONS, 0.28), DUCT_WALL, 0.50), 0.28),
  ], { sweep: [0.5, 0.52, 0.55], capEnd: 1 }));

  for (const side of [1, -1]) {
    add('body', loft(sectionsFrom(SIDEPOD_STATIONS, P.ring, side), { capEnd: 1, uv: podUv(side) }));
    const inlet = SIDEPOD_STATIONS[0];
    const throatSecs = [
      ringSection(P.ring, inlet, inlet.z),
      ringSection(P.ring, insetStation(stationAt(SIDEPOD_STATIONS, -0.70), DUCT_WALL, 0.78), -0.70),
      ringSection(P.ring, insetStation(stationAt(SIDEPOD_STATIONS, -0.56), DUCT_WALL, 0.46), -0.56),
    ];
    // Mirroring by scaling x negates the handedness of every triangle, so the left duct
    // used to render its far wall and cull its near one. Build the left throat from
    // mirrored, re-ordered rings exactly the way sectionsFrom builds the left pod.
    if (side < 0) {
      for (const sec of throatSecs) {
        for (let i = 0; i < sec.n; i++) sec.pts[i * 3] = -sec.pts[i * 3];
        reverseRing(sec);
      }
    }
    add('duct', loft(throatSecs, { sweep: [0.24, 0.26, 0.28], capEnd: 1 }));
  }

  add('carbonMatte', loft(floorSections(), { capStart: -1, capEnd: 1 }));

  // Each element stops 1.5 mm short of the one below it. All four tips still finish
  // inside the endplate's own 16 mm thickness, so nothing is exposed, but no two end
  // caps share a plane any more: four fans in the single plane x = +/-0.950 is the one
  // arrangement on this car that a depth buffer genuinely cannot resolve.
  FRONT_WING_ELEMENTS.forEach((el, i) => {
    add('wing', wingElement(el, FRONT_WING_HALF_SPAN - i * 0.0015, P.span, P.prof, wingUvFull));
  });
  for (const side of [1, -1]) {
    add('wing', plate(FW_ENDPLATE, side * FRONT_WING_HALF_SPAN, 0.016, constUv(side > 0 ? 0.02 : 0.98, 0.110, 0.245)));
    // Endplate footplate. Shortened and pulled forward with the endplate above it: at
    // |x| = 0.902 it is under the tyre, whose lower surface drops to y = 0.055 by
    // z = -2.14, which the old 310 mm plate ran into.
    add('carbon', stripUv(placed(slab(0.100, 0.013, 0.250), side * 0.902, 0.040, -2.360, 0, 0, side * 0.20), 0.5, 0.5));
    add('carbon', plate([-2.442, 0.112, -2.300, 0.112, -2.268, 0.256, -2.418, 0.248], side * 0.100, 0.020, constUv(0.5)));
  }

  // Rear wing: mainplane, endplates, swan-neck pylons, beam wing.
  add('wing', wingElement({
    zLE: 2.520, chord0: 0.272, chord1: 0.248, y0: 0.640, y1: 0.652,
    aoa0: 0.30, aoa1: 0.26, thickness: 0.090, camber: -0.090,
  }, REAR_WING_HALF_SPAN, P.span, P.prof, rearUv));
  for (const side of [1, -1]) {
    add('wing', plate(RW_ENDPLATE, side * REAR_WING_HALF_SPAN, 0.014, constUv(side > 0 ? 0.02 : 0.98)));
    add('carbon', plate([2.120, 0.352, 2.300, 0.352, 2.620, 0.664, 2.520, 0.672], side * 0.155, 0.024, constUv(0.5)));
  }
  const beamUv = bandUv(-0.420, 0.420, 0.245, 0.355);
  add('wing', wingElement({
    zLE: 2.560, chord0: 0.165, chord1: 0.150, y0: 0.300, y1: 0.312,
    aoa0: 0.34, aoa1: 0.30, thickness: 0.080, camber: -0.080,
  }, 0.420, Math.max(5, P.span - 4), P.prof, beamUv));
  if (P.mid) {
    add('wing', wingElement({
      zLE: 2.700, chord0: 0.130, chord1: 0.120, y0: 0.256, y1: 0.264,
      aoa0: 0.44, aoa1: 0.40, thickness: 0.075, camber: -0.085,
    }, 0.400, Math.max(5, P.span - 4), P.prof, beamUv));
  }

  add('halo', haloGeometry(P.radial));

  if (P.mid) {
    for (const side of [1, -1]) {
      // Mirror stalk and, below, the cockpit rim: the two pieces of exposed weave the
      // driver's eye is within half a metre of. They take the high-resolution cockpit
      // twill rather than the body's, so the 2x2 float pattern is still resolving at
      // that range under its lacquer instead of blurring into a flat dark tube.
      add('carbonWeave', tube([
        [side * 0.318, 0.588, -0.556], [side * 0.400, 0.604, -0.642], [side * 0.452, 0.634, -0.704],
      ], 0.014, P.radial));
      add('dark', stripUv(placed(slab(0.048, 0.072, 0.128, 0.014), side * 0.460, 0.645, -0.720, 0, -side * 0.4538, 0), 0.5, 0.5));
      const glass = new THREE.PlaneGeometry(0.112, 0.052);
      add('dark', placed(glass, side * 0.428, 0.645, -0.655, 0, -side * 0.4538, 0));
    }
    for (const side of [1, -1]) {
      add('carbonWeave', tube(cockpitRimPoints(side).map((p) => [p[0], p[1], p[2]]), 0.016, Math.max(5, P.radial - 2)));
    }
    add('metal', placed(new THREE.CylinderGeometry(0.052, 0.058, 0.170, 14, 1, false), 0, 0.352, 2.585, Math.PI * 0.5, 0, 0));
    // Cooling louvres. Authored at a fixed height with a guessed 0.16 rad rake, the old
    // 150 mm panel sank through the engine cover halfway along its length and stood ten
    // millimetres proud at the tail: 110 square centimetres of it lay within four
    // millimetres of the cover and within eight degrees of parallel to it, which is a
    // decal shell with no depth offset in all but name. Narrowed to 90 mm — a 150 mm
    // plate cannot follow a cover that rolls 13 degrees across its own width, and
    // lifting a plate that wide clear of the crown floats its tail 60 mm off the
    // bodywork — and seated off the cover's own surface, it now clears it by 5.9 mm at
    // the leading edge and 20.6 mm at the trailing edge. The two surfaces diverge along
    // the whole panel instead of running parallel a hair apart.
    //
    // Solved once on the right and mirrored: seatOnBody reads inboard and outboard off
    // the sign of x, so asking it for a negative x hands back a roll of the wrong sense.
    const louvre = seatOnBody(REAR_BODY_STATIONS, 0.100, 0.940, 0.045, 0.115, LOUVRE_STANDOFF);
    for (const side of [1, -1]) {
      add('dark', stripUv(placed(
        slab(0.090, 0.008, 0.230), side * 0.100,
        louvre.y + 0.115 * Math.tan(LOUVRE_RAKE), 0.940,
        louvre.rx - LOUVRE_RAKE, 0, side * louvre.rz,
      ), 0.62, 0.5));
    }
  }

  if (P.fine) {
    // Diffuser strakes, floor-edge fences and sidepod winglets: the small vertical
    // furniture that makes the underbody read as a real aerodynamic surface.
    for (const side of [1, -1]) {
      // 0.475 laid the outer strake flat against the diffuser tunnel's near-vertical
      // flank, which runs from archX out to the floor edge: 98 square centimetres of
      // plate within four millimetres of the floor and nearly parallel to it. The three
      // strakes now stand inside the tunnel roof, clear of the flank, where a real one
      // does.
      for (const sx of [0.105, 0.230, 0.350]) {
        add('carbon', plate([2.060, 0.046, 2.600, 0.086, 2.600, 0.300, 2.060, 0.122], side * sx, 0.012, constUv(0.5)));
      }
      for (let k = 0; k < 3; k++) {
        const t = k / 2;
        add('carbon', stripUv(placed(
          slab(0.014, lerp(0.130, 0.235, t), lerp(0.400, 0.300, t)),
          side * lerp(0.430, 0.655, t), lerp(0.110, 0.150, t), lerp(-1.060, -0.900, t),
          0, side * lerp(0.10, 0.30, t), side * lerp(0.05, 0.16, t),
        ), 0.5, 0.5));
      }
      add('carbon', stripUv(placed(slab(0.200, 0.012, 0.095), side * 0.600, 0.512, -0.380, -0.14, 0, side * 0.10), 0.5, 0.5));
      // Endplate diveplane. Ahead of z = -2.304 like everything else at this span, or
      // its outboard corner sits inside the tyre. Mounted OUTBOARD of the endplate's own
      // 16 mm thickness: at |x| = 0.898 it reached 0.843 and ran a hundred millimetres
      // into the wing elements it is supposed to sit beside, which is 73 square
      // centimetres of plate inside an aerofoil.
      add('carbon', stripUv(placed(slab(0.110, 0.010, 0.130), side * 1.014, 0.300, -2.386, -0.26, 0, 0), 0.5, 0.5));
    }
  }

  // The distant level draws no articulated suspension — Car only builds the instanced
  // strut mesh from the mid level up — so the wishbones are baked in at ride height
  // instead. Without them a car at a hundred metres is a painted tub with four black
  // blocks floating a metre off each corner, which is exactly how the pack read.
  if (!P.mid) {
    for (const link of suspensionLinks()) {
      add('carbon', staticLink(link.inboard, link.outboard, link.chord));
    }
  }

  // Everything above is authored with the road at y = 0; the car's origin is the CG.
  const parts = {};
  // Collapsing roles is how the cheap levels save draw calls, but a role may only fold
  // into one whose *material* is a reasonable stand-in. Folding the wings, the floor and
  // the halo onto `body` — clearcoated livery paint — is what turned distant cars into
  // bright chrome slabs: a flat carbon plate wearing show-car lacquer mirrors the sky.
  // Three materials at every level: paint, wing lacquer, carbon.
  const roleMap = detail >= 2
    ? null
    : { carbonWeave: 'carbon', carbonMatte: 'carbon', dark: 'carbon', duct: 'carbon', metal: 'carbon', halo: 'carbon' };

  const grouped = new Map();
  for (const [role, list] of bucket) {
    const target = roleMap?.[role] ?? role;
    let arr = grouped.get(target);
    if (!arr) grouped.set(target, (arr = []));
    for (const g of list) arr.push(g);
  }
  for (const [role, list] of grouped) {
    const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (list.length > 1) for (const g of list) g.dispose();
    merged.translate(0, -CG_HEIGHT, 0);
    if (role !== 'body' && role !== 'wing') triplanarUv(merged, ROLE_TILING[role] ?? 8);
    merged.computeBoundingSphere();
    parts[role] = merged;
  }

  // The DRS flap lives on its own pivot, so it is never merged into the body. The
  // impostor does not get one: a fifth of a degree of flap angle is not resolvable at
  // the distance it is drawn.
  //
  // It takes the same full chord wrap as the fixed elements. Opening it rotates the
  // section 47 degrees, which is not enough to reverse the screen sense of v, so the
  // wordmark reads the same way open or closed — and with the flap laid back it is the
  // largest flat face the car presents to a following camera.
  const flapUv = makeWingUv(-0.530, 0.530);
  const flap = detail === 0 ? null : wingElement({
    zLE: 2.686, chord0: 0.188, chord1: 0.174, y0: 0.782, y1: 0.790,
    aoa0: 0.62, aoa1: 0.58, thickness: 0.055, camber: -0.045,
  }, 0.530, P.span, P.prof, flapUv);
  if (flap) {
    flap.translate(-DRS_PIVOT[0], -DRS_PIVOT[1] - CG_HEIGHT, -DRS_PIVOT[2]);
    flap.computeBoundingSphere();
  }

  const result = { parts, flap, detail };
  _shared.set(detail, result);
  return result;
}

/**
 * Inside of the survival cell, seen only from the driver's seat: the tub walls with the
 * winding reversed so a normal front-facing material shades them from within, plus the
 * seat pan and the front bulkhead the driver's feet disappear under.
 */
export function cockpitInteriorGeometry(ring = 28) {
  const secs = [];
  for (const s of TUB_STATIONS) {
    const rim = s.rim === null ? s.cy + s.hhT : s.rim;
    const inner = {
      cx: s.cx, cy: s.cy + 0.006,
      hw: s.hw - 0.026, hhT: s.hhT - 0.020, hhB: s.hhB - 0.020,
      eT: s.eT, eB: s.eB,
    };
    secs.push(arcSection(ring, inner, s.z, rim - 0.012));
  }
  const walls = loft(secs, { capStart: 1, capEnd: -1 });
  flipWinding(walls);

  // Seat pan: a shallow tray the driver sits in, floor of the cell.
  const pan = [];
  for (const z of [-0.10, 0.10, 0.30]) {
    pan.push(ringSection(ring, {
      cy: 0.300, hw: 0.230, hhT: 0.040, hhB: 0.030, eT: 4.0, eB: 3.0,
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
  const n = geo.getAttribute('normal');
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


/**
 * Suspension linkage, ground frame, right-hand side; the left side is mirrored in X at
 * build time. Fronts are pushrod-actuated and rears pullrod, as a 2026 car runs.
 * `wheel` says which corner's travel moves the outboard end, and `steers` marks the
 * links whose outboard end swings about the kingpin when the wheel is turned.
 */
const SUSPENSION_RIGHT = [
  { wheel: 1, inboard: [0.165, 0.455, -1.620], outboard: [0.855, 0.478, -1.944], chord: 1.00 },
  { wheel: 1, inboard: [0.155, 0.450, -1.860], outboard: [0.855, 0.478, -1.944], chord: 1.00 },
  { wheel: 1, inboard: [0.175, 0.205, -1.640], outboard: [0.880, 0.185, -1.944], chord: 1.15 },
  { wheel: 1, inboard: [0.170, 0.200, -1.880], outboard: [0.880, 0.185, -1.944], chord: 1.15 },
  { wheel: 1, inboard: [0.190, 0.510, -1.646], outboard: [0.868, 0.198, -1.930], chord: 0.85 },
  { wheel: 1, inboard: [0.150, 0.252, -1.762], outboard: [0.865, 0.246, -2.032], chord: 0.70, steers: true },
  { wheel: 3, inboard: [0.170, 0.470, 1.420], outboard: [0.835, 0.485, 1.656], chord: 1.00 },
  { wheel: 3, inboard: [0.165, 0.465, 1.780], outboard: [0.835, 0.485, 1.656], chord: 1.00 },
  { wheel: 3, inboard: [0.180, 0.190, 1.400], outboard: [0.855, 0.180, 1.656], chord: 1.15 },
  { wheel: 3, inboard: [0.175, 0.188, 1.800], outboard: [0.855, 0.180, 1.656], chord: 1.15 },
  { wheel: 3, inboard: [0.185, 0.232, 1.388], outboard: [0.840, 0.480, 1.660], chord: 0.85 },
  { wheel: 3, inboard: [0.150, 0.230, 1.842], outboard: [0.845, 0.226, 1.792], chord: 0.70 },
  { wheel: 3, inboard: [0.168, 0.330, 1.656], outboard: [0.872, 0.3625, 1.656], chord: 0.55, round: true },
];

/** Both sides, CG frame, ready for the instanced strut mesh. */
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
        hub: [side * (l.wheel === 1 ? 1.000 : 0.980), GY(l.wheel === 1 ? 0.360 : 0.3625), l.outboard[2]],
      });
    }
  }
  return out;
}

const _strutCache = new Map();

/**
 * Unit-length aerofoil-section strut along +X. Instance matrices stretch it between the
 * two link ends, so one 200-triangle geometry articulates the whole car's suspension in
 * a single draw call.
 */
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
      // Flattened teardrop: 52 mm chord, 16 mm thick, the real proportion of a wishbone.
      const c = Math.cos(th);
      const sN = Math.sin(th);
      pts[i * 3] = x;
      pts[i * 3 + 1] = 0.008 * sN;
      pts[i * 3 + 2] = 0.026 * Math.sign(c) * Math.pow(Math.abs(c), 0.8) - 0.004 * sN * sN;
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
  body: 'body', wing: 'wing', carbon: 'carbon', carbonWeave: 'carbonWeave',
  carbonMatte: 'carbonMatte', dark: 'dark', duct: 'duct', metal: 'metal', halo: 'halo',
};

/**
 * One car's visible bodywork at one detail level. Geometry is shared; only the
 * material set is per-team, so twenty cars cost twenty draw calls of paint, not twenty
 * copies of a hundred-thousand-triangle mesh.
 */
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
      // Named so a capture or a scene inspector can attribute a defect to one role's
      // merged mesh without having to match material identities by hand.
      mesh.name = `car-${role}`;
      mesh.castShadow = castShadow;
      // Every level receives. A distant car that takes no shadow sits at full sun while
      // the cars around it are shaded, which reads as a washed-out shape rather than a
      // car, and it costs nothing: the material and its shader variant are shared.
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

  /** `open` is 0..1; the flap lays flat as it approaches 1. */
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
    // Geometry and materials are shared: CarManager releases them centrally.
    this.group.clear();
    this.meshes.length = 0;
  }
}

export { ROLES, CG_HEIGHT, slab, placed, tube, stripUv };
