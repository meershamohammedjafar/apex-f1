import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  createCanvas, textureFromCanvas, makeDataTexture, mipChain, normalMipChain, applyToksvig,
} from '../render/textures/NoiseTextures.js';
import { buildCarbonTwill, buildWheelGrip } from '../render/textures/CarTextures.js';
import { clamp, clamp01, damp, formatLapTime, formatGap, DEG } from '../core/MathUtils.js';
import { COCKPIT_ANCHORS, cockpitInteriorGeometry, slab, placed } from './CarModel.js';
import { ArmChain, DriverBust, cockpitSuitMaterial, legsGeometry } from './DriverModel.js';

/**
 * The first-person cockpit — the one asset the player looks at for an entire race.
 *
 * Everything is placed against the anchors CarModel publishes, so the halo, the
 * tub rim and the mirror stalks the player sees from inside are the same objects the
 * external cameras see from outside; there is no separate "interior model" that drifts
 * out of register with the car.
 *
 * The steering wheel turns 240 degrees lock to lock about the raked column axis, and
 * the driver's hands are pinned to the rim: the arms are solved by two-bone IK to
 * wherever the grips end up, so the whole upper body moves with the steering instead of
 * the wheel spinning inside static hands.
 *
 * The class owns two scene graphs, not one. `group` is the interior — tub shell, pads,
 * belts, legs, mirror panes, camera anchor — and is switched off the moment the camera
 * leaves the seat. `driverGroup` carries the wheel, the forearms, the gloves and the
 * driver's helmet and shoulders, and is never switched off, because those are exactly
 * the parts an external camera is looking for: without them a chase shot of the player's
 * car is an empty black tub with a wire hoop over it.
 */

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
const WHEEL_LOCK_RAD = 120 * DEG;      // 240 degrees lock to lock at the rim

/**
 * Driver's eye point, car-local: the origin is the CG, which sits 0.280 m above the
 * floor datum every anchor in CarModel is measured from. So y = 0.523 puts the eyes
 * 0.803 m above the road, which is where a 2026 driver's eyes actually are — a few
 * centimetres clear of the top of a 720 mm front tyre.
 *
 * z is the number that decides the whole shot, and it belongs directly above the
 * shoulder anchor at -0.150, not ahead of it. A driver is strapped into a moulded seat
 * with his head over his shoulders and his arms out; the previous -0.285 was a
 * head-forward crouch nobody could hold for a lap, and it cost the frame twice. It put
 * the eye 0.13 m closer to the halo, which is what made the hoop project as a girder,
 * and it dropped the wheel rim, the driver's hands and both mirrors below the bottom
 * edge, so the lower third of the shot had nothing in it but two front tyres.
 *
 * With the wheel at its corrected height (see WHEEL_OFFSET) the reach from the shoulder
 * to the rim is 0.50 m — a real arm's-length position, and 0.08 m inside the arm chain's
 * 0.582 m limit — the tyres are 1.79 m away instead of 1.66, and the rim, the hands and
 * both mirrors sit inside the frame.
 */
const EYE_LOCAL = [0, 0.523, -0.152];

/**
 * The halo, in the same car-local frame, y already offset to the CG.
 *
 * One hoop, one spline. The right-hand rail is authored from its clevis on the survival
 * cell forward to the centreline; the left is its mirror; the two are concatenated into
 * a single open curve on which the crown is an ordinary interior control point. There
 * is no join at the front to mitre, and no pair of straight ribbons to meet in a V —
 * the curvature runs continuously from one mount round to the other.
 *
 * The first station of each rail is buried inside its clevis, so the sweep's flat end
 * cap never shows: the tube goes into the bracket instead of stopping in mid-air.
 *
 * Height is pinned by clearance, not by taste. The driver's helmet is anchored at
 * COCKPIT_ANCHORS.helmet (car-local y = 0.492) and its shell crown, after the 1.06
 * vertical scale on a 0.132 m radius, is at y = 0.6319. The hoop's apex is set 275 mm
 * clear of that, i.e. y = 0.9069, and every rail station between the clevis and the
 * apex is scaled about the clevis (factor 1.4095) so the arch keeps its plan footprint
 * and its curvature while gaining the clearance.
 */
const HALO_RAIL = [
  [0.262, 0.2980, 0.104],   // buried in the clevis
  [0.268, 0.3685, 0.098],   // clevis mouth, level with the shoulders
  [0.298, 0.5094, 0.062],
  [0.332, 0.6560, -0.014],
  [0.358, 0.7716, -0.130],
  [0.372, 0.8477, -0.268],
  [0.376, 0.8902, -0.418],
  [0.360, 0.9069, -0.566],  // apex: 275 mm above the helmet crown
  [0.318, 0.9013, -0.716],
  [0.246, 0.8872, -0.858],
  [0.146, 0.8759, -0.968],
  [0.058, 0.8734, -1.020],
];
const HALO_CROWN = [0, 0.8731, -1.030];

/** The front vane, root to crown: near vertical, raked a few millimetres forward. */
const HALO_PILLAR = [
  [0, 0.2620, -1.0455],     // buried in the mount pad
  [0, 0.3000, -1.0465], [0, 0.4200, -1.0460], [0, 0.5400, -1.0445],
  [0, 0.6600, -1.0420], [0, 0.7800, -1.0380], [0, 0.8731, -1.0300],
];

/**
 * Section sizes. These are structural dimensions, not styling: the halo is a bent
 * titanium blade, deeper fore-and-aft than it is wide, and it is the width — the thin
 * axis, the one presented to the driver's eye — that decides how much of the frame the
 * part eats.
 *
 * 20 mm across by 32 mm deep at mid-span, opening to 26 x 40 mm at each rear clevis
 * where the bending moment is. Never a circular pipe (which reads as scaffolding) and
 * never a flat ribbon (which reads as chrome trim). The front vane is 18 mm across by
 * 45 mm of chord: 18 mm is all the driver ever sees of it, the chord is hidden edge-on.
 */
const HALO_HOOP_HALF_THIN = 0.0100;    // 20 mm across the car, the dimension the eye reads
const HALO_HOOP_HALF_DEEP = 0.0160;    // 32 mm in the plane of the hoop
const HALO_HOOP_TAPER_THIN = 0.30;     // 20 mm -> 26 mm at the clevis
const HALO_HOOP_TAPER_DEEP = 0.25;     // 32 mm -> 40 mm at the clevis
const HALO_PILLAR_HALF_W = 0.0090;     // 18 mm across, all the driver's eye ever sees
const HALO_PILLAR_HALF_D = 0.0225;     // 45 mm of chord fore-and-aft, hidden edge-on

/**
 * The hoop's plane, from the two clevis mouths and the crown, given by its normal.
 * Holding the section against it is what orients the blade: the deep axis comes out in
 * the plane the beam bends in, and the thin 20 mm axis comes out normal to it — which
 * at the crown is vertical, exactly the dimension the driver reads.
 *
 * Recomputed for the raised arch: clevis (0.268, 0.3685, 0.098) and crown
 * (0, 0.8731, -1.030) give (0, -0.9128, -0.4083).
 */
const HALO_PLANE_NORMAL = [0, -0.9128, -0.4083];

const _profile = { w: 1, h: 1 };

/**
 * The taper along the hoop: linear in span from the mid-span section to the clevis
 * section, which is the plainest reading of "20 x 32 at mid-span, 26 x 40 at the
 * mounts" and keeps the silhouette from swelling anywhere the driver can see it.
 */
function haloHoopProfile(t, out) {
  const k = 1 - 2 * Math.min(t, 1 - t);   // 0 at the crown, 1 at either mount
  out.w = 1 + HALO_HOOP_TAPER_DEEP * k;
  out.h = 1 + HALO_HOOP_TAPER_THIN * k;
}

/**
 * The steering wheel, relative to the anchor CarModel publishes.
 *
 * The anchor puts the wheel centre 0.558 m above the road. That is 80 mm lower than a
 * real one, and 80 mm at 0.5 m is 9 degrees: it dropped the rim, the display and both
 * of the driver's hands to the very bottom of the frame, where the HUD's delta bar then
 * covered what was left. From here the eye is 0.16 m above the wheel centre and 0.50 m
 * behind it, which is the real seating position, the rim crosses the frame at about
 * two thirds height, and the hands land clear of every HUD panel.
 */
const WHEEL_OFFSET = [0, 0.085, 0.055];

const GRIP_LOCAL = [
  new THREE.Vector3(-WHEEL_HALF_WIDTH, 0.004, 0.030),
  new THREE.Vector3(WHEEL_HALF_WIDTH, 0.004, 0.030),
];

/** Rim outline: squared off, flattened across the bottom, in the wheel's own plane. */
function rimOutline(n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const th = -Math.PI * 0.5 + (i / n) * Math.PI * 2;
    const ct = Math.cos(th);
    const st = Math.sin(th);
    let x = WHEEL_HALF_WIDTH * Math.sign(ct) * Math.pow(Math.abs(ct), 0.4);
    let y = WHEEL_HALF_HEIGHT * Math.sign(st) * Math.pow(Math.abs(st), 0.4);
    if (st < 0) y *= 0.62 + 0.38 * Math.pow(Math.abs(ct), 1.5);
    if (st > 0) y *= 0.94 + 0.06 * Math.pow(Math.abs(ct), 2.0);
    x *= 1.0;
    pts.push(new THREE.Vector3(x, y, 0));
  }
  return pts;
}

function tubeFrom(points, radius, radial, closed, tubular) {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'centripetal', 0.5);
  return new THREE.TubeGeometry(curve, tubular, radius, radial, closed);
}

/**
 * Sweep an elliptical section along a 3D curve, with flat end caps.
 *
 * TubeGeometry cannot do this job. It only sweeps a constant circle, and its u runs
 * 0..1 over the whole curve regardless of length, so a machining map either smears
 * along a long piece or repeats twice on a short one. The halo needs a section that is
 * circular on the hoop and a narrow deep blade on the front pillar, held to a known
 * axis on the pillar so its thin edge stays lateral for the whole climb, and a taper
 * into the chassis mounts.
 *
 * `ref` is the axis the section is held against: crossing it with the tangent gives the
 * `halfWidth` direction, and the remaining axis takes `halfHeight`. Passing `null`
 * instead switches to a parallel-transported frame, which is what a circular section
 * wants: a held axis goes degenerate wherever the curve runs along it, and the halo
 * hoop runs vertically at both of its mounts. u runs along the arc length so the
 * machining grain streaks down the tube rather than around it; `uPerMetre` keeps the
 * scale identical on pieces of different lengths. `profile(t, out)` writes independent
 * scales for the two semi-axes, which is what turns a constant pipe into a beam that
 * deepens into its mounts without also fattening across the driver's view.
 */
function sweepSection(points, halfWidth, halfHeight, ref, segments, radial, uPerMetre, profile = null) {
  const curve = new THREE.CatmullRomCurve3(
    points.map((p) => new THREE.Vector3(p[0], p[1], p[2])), false, 'centripetal', 0.5,
  );
  // The arc-length table has to resolve better than the sampling that reads it, or
  // getPointAt quantises the stations and the sweep develops a periodic ripple.
  curve.arcLengthDivisions = Math.max(200, segments * 4);
  const rings = segments + 3;          // one collapsed ring at each end closes the tube
  const cols = radial + 1;             // duplicated seam column so u/v stay continuous
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
      // Degenerate only where the curve runs along the reference axis itself; any second
      // axis will do there, because the section is circular in that limit anyway.
      if (side.lengthSq() < 1e-8) side.crossVectors(fallback, tangent);
      side.normalize();
    } else if (r === 0) {
      // Seed the transported frame with any unit vector off the first tangent.
      side.set(0, 1, 0);
      if (Math.abs(tangent.y) > 0.9) side.set(1, 0, 0);
      side.addScaledVector(tangent, -side.dot(tangent)).normalize();
      prevTangent.copy(tangent);
    } else {
      // Carry the section round by the minimal rotation between successive tangents:
      // no twist accumulates, so the seam and the machining grain run straight down a
      // tube that turns through 180 degrees between its two mounts.
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
      const th = (j / radial) * Math.PI * 2;
      const c = Math.cos(th);
      const s = Math.sin(th);
      const i = (r * cols + j);
      position[i * 3] = p.x + side.x * hw * c + up.x * hh * s;
      position[i * 3 + 1] = p.y + side.y * hw * c + up.y * hh * s;
      position[i * 3 + 2] = p.z + side.z * hw * c + up.z * hh * s;

      if (capped) {
        const sign = r === 0 ? -1 : 1;
        normal[i * 3] = tangent.x * sign;
        normal[i * 3 + 1] = tangent.y * sign;
        normal[i * 3 + 2] = tangent.z * sign;
      } else {
        // Ellipse normal swaps the semi-axes: (h*cos, w*sin), then renormalised.
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
      // (side, up, tangent) is right-handed, so this order is the one that leaves the
      // faces pointing out of the tube — and the two collapsed end rings pointing out
      // of the caps — under Three's counter-clockwise front-face rule.
      index[k++] = a; index[k++] = a + 1; index[k++] = b;
      index[k++] = a + 1; index[k++] = b + 1; index[k++] = b;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.userData.length = total;
  return geo;
}

/**
 * The wheel's control layout, in millimetres off the console's own centre.
 *
 * Everything here is measured against the two objects it has to live around: the display
 * is 116 x 68 at the centre of a 172 x 124 console, and the shift-light strip sits on the
 * top edge. The previous layout ignored both — four toggles at (+/-30, +36) and
 * (+/-30, -48) stood directly on top of the screen, and four 17 mm buttons at x = +/-62
 * overhung its left and right borders — so the one thing on the wheel that is supposed to
 * hold the eye had switch bodies planted across it. The controls now occupy the three
 * bands of bare panel the display leaves: a 28 mm column down each side, and a 28 mm
 * strip along the bottom.
 *
 * Cap sizes are pinned. A rotary cap is 18 mm across and a push button 13.6 mm, against
 * 23.6 mm and 17 mm before; 18 mm is the limit, and at cockpit range that is the
 * difference between a control and a coloured slab — the old 23.6 mm caps projected 49 px
 * wide, in raw team accent, six of them, and they were the brightest thing in the lower
 * third of the frame.
 */
const WHEEL_ROTARIES = [
  [-0.096, 0.030], [0.096, 0.030], [-0.096, -0.024], [0.096, -0.024],
];

const WHEEL_TOGGLES = [[-0.034, -0.046], [0.034, -0.046]];

/**
 * Push buttons: position and cap colour.
 *
 * Exactly four are saturated — pit limiter red, DRS amber, radio blue and overtake green,
 * the four a driver's thumbs actually find without looking — and every one of them tops
 * out at 78% value, so the display's white numerals stay the brightest thing on the wheel
 * by a clear margin. The other four are the same dark anodised grey as the rotary caps.
 * The palette is fixed rather than taken from the livery on purpose: a team accent can be
 * near-white (Albion) or near-black (Argent), and a button that renders as either is not
 * a button.
 */
const CAP_NEUTRAL = 0x2b2d34;
const CAP_ROTARY = 0x23252b;
const CAP_INDEX = 0xa9adb4;
const WHEEL_BUTTONS = [
  [-0.072, 0.026, 0xa5121e],
  [0.072, 0.026, 0xc7a017],
  [-0.072, 0.000, CAP_NEUTRAL],
  [0.072, 0.000, CAP_NEUTRAL],
  [-0.072, -0.026, 0x1b56b4],
  [0.072, -0.026, 0x14833f],
  [-0.011, -0.046, CAP_NEUTRAL],
  [0.011, -0.046, CAP_NEUTRAL],
];

/** Write a flat sRGB colour into a geometry's vertex-colour attribute. */
const _tint = new THREE.Color();
function tintGeometry(geo, hex) {
  const pos = geo.getAttribute('position');
  const out = new Float32Array(pos.count * 3);
  _tint.set(hex);
  for (let i = 0; i < pos.count; i++) {
    out[i * 3] = _tint.r;
    out[i * 3 + 1] = _tint.g;
    out[i * 3 + 2] = _tint.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(out, 3));
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
    this.group.name = 'cockpit';

    this.cameraAnchor = new THREE.Object3D();
    this.cameraAnchor.name = 'cockpit-camera-anchor';
    this.cameraAnchor.position.set(EYE_LOCAL[0], EYE_LOCAL[1], EYE_LOCAL[2]);
    this.group.add(this.cameraAnchor);

    this._owned = [];
    this._ownedMaterials = [];
    this._ownedTargets = [];
    this._ownedTextures = [];
    this._bodyHaloLevel = null;

    // Everything the external cameras have to keep seeing after `group` is switched
    // off: the wheel, the driver's arms and his helmet and shoulders. Round two's chase
    // shot was an empty black tub because all three lived on the gated group.
    this.driverGroup = new THREE.Group();
    this.driverGroup.name = 'driver-rig';
    this.car.group.add(this.driverGroup);

    this._maxRoadWheelAngle = this.config?.steering?.maxRoadWheelAngle ?? 21 * DEG;
    this._steerSmoothed = 0;
    this._displayTimer = 0;
    this._mirrorPhase = 0;
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

  // --- halo ----------------------------------------------------------------------------

  /**
   * The halo, swept along its real centreline and hung off the car rather than off the
   * cockpit group: it is structure, so it has to stay in frame for the chase and replay
   * cameras too, and it is the same part inside and out.
   *
   * The hoop is one continuous sweep of a blade section held against the hoop's own
   * plane normal, so the deep axis lies in the plane the beam bends in and the thin
   * 20 mm axis is the one presented to the eye all the way round. Both ends run into
   * real hardware — a clevis on a pedestal at each shoulder, a bolted pad and a fairing
   * at the front vane's root — because a hoop that stops dead in mid-air at both ends
   * reads as a wire, not as a part of the car.
   *
   * 16 segments round and 160 along put a facet every 4 mm of circumference and every
   * 17 mm of length, so the silhouette is genuinely round at cockpit range. Both counts
   * are held across every quality tier: the whole part is 8.2k triangles, which is not
   * worth a tier switch, and a faceted halo is visible from the one camera that matters.
   */
  _buildHalo() {
    const radial = 16;

    this.haloGroup = new THREE.Group();
    this.haloGroup.name = 'halo';

    // Left rail, mount to crown-adjacent; the crown; then the right rail back to its
    // mount. One curve, so Catmull-Rom carries curvature straight through the centre.
    const hoop = [];
    for (const p of HALO_RAIL) hoop.push([-p[0], p[1], p[2]]);
    hoop.push(HALO_CROWN);
    for (let i = HALO_RAIL.length - 1; i >= 0; i--) hoop.push(HALO_RAIL[i]);

    const parts = [];
    parts.push(sweepSection(
      hoop, HALO_HOOP_HALF_DEEP, HALO_HOOP_HALF_THIN, HALO_PLANE_NORMAL,
      160, radial, 6, haloHoopProfile,
    ));
    parts.push(sweepSection(
      HALO_PILLAR, HALO_PILLAR_HALF_W, HALO_PILLAR_HALF_D,
      // Held against the car's forward axis, so the blade keeps its 18 mm edge to the
      // driver and its 45 mm chord to the airflow for the whole climb.
      [0, 0, -1], 96, radial, 6, null,
    ));
    this._haloMounts(parts);

    const geo = this._own(mergeGeometries(parts, false));
    for (const g of parts) g.dispose();
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, this._haloMaterial());
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    this.haloGroup.add(mesh);
    // Parented to the car, not to `group`: `group` is switched off whenever the camera
    // leaves the driver's seat, and the halo must survive that.
    this.car.group.add(this.haloGroup);
  }

  /**
   * The hardware at the three points where the halo is actually bolted to the car.
   *
   * Rear, at the survival-cell shoulder line: a foot plate on the cell deck, a pedestal
   * that carries the load into it, a two-eared clevis straddling the rail and the pin
   * through both ears. Front: the pad on the nose deck, the fairing that blends the
   * vane's chord into it and the two bolts that hold it down. None of this is
   * decoration — without it the hoop's swept ends are visible flat caps floating beside
   * the driver's helmet, which is exactly how the previous build read.
   *
   * Every dimension here is sized off the 26 x 40 mm clevis section the rail tapers to,
   * so the ears clear the rail by 4 mm a side rather than straddling a gap twice the
   * width of the part they hold.
   */
  _haloMounts(parts) {
    const seg = 18;
    for (const s of [1, -1]) {
      const x = s * 0.268;
      // Foot plate on the survival cell deck, y 0.280..0.292.
      parts.push(placed(slab(0.074, 0.012, 0.128, 0.004), x, 0.286, 0.098));

      // Pedestal, y 0.292..0.332, stretched fore-and-aft to follow the rail's section.
      const pedestal = new THREE.CylinderGeometry(0.022, 0.030, 0.040, seg);
      pedestal.scale(1, 1, 1.9);
      pedestal.translate(x, 0.312, 0.098);
      parts.push(pedestal);

      // Two ears straddling a 26 mm rail with 4 mm of clearance a side, y 0.325..0.400.
      for (const e of [1, -1]) {
        parts.push(placed(slab(0.008, 0.075, 0.076, 0.003), x + e * 0.021, 0.3625, 0.098));
      }
      const pin = new THREE.CylinderGeometry(0.008, 0.008, 0.062, 12);
      pin.rotateZ(Math.PI * 0.5);
      pin.translate(x, 0.3685, 0.098);
      parts.push(pin);
    }

    // Front pad on the nose deck, y 0.256..0.280, and the fairing that blends the
    // vane's 45 mm chord into it.
    parts.push(placed(slab(0.066, 0.024, 0.150, 0.006), 0, 0.268, -1.046));
    const fairing = new THREE.CylinderGeometry(0.014, 0.038, 0.056, seg);
    fairing.scale(1, 1, 2.6);
    fairing.translate(0, 0.296, -1.045);
    parts.push(fairing);
    for (const z of [-0.986, -1.106]) {
      const bolt = new THREE.CylinderGeometry(0.0075, 0.0075, 0.012, 10);
      bolt.translate(0, 0.284, z);
      parts.push(bolt);
    }
  }

  /**
   * Coated matte-satin titanium. Pinned, and deliberately dull.
   *
   * The previous build ran a bead-blast ORM map over a near-cream F0 with the
   * environment at 0.78, and produced a mirror: a hard specular line that swept the
   * full width of the frame and measured brighter than the sky behind it. A halo is a
   * coated part, not a polished one, so the whole map stack goes and the four numbers
   * that matter are set directly.
   *
   * roughness 0.42 is the value that does the work: it spreads the sun and the sky dome
   * into a broad highlight that varies along the curve as the tangent turns, instead of
   * the single clipped line a sub-0.3 surface gives. 0x4a4a4e as a conductor F0 costs
   * the reflection about two thirds of its energy, and envMapIntensity 0.6 takes another
   * 40% off the sky term, which is what keeps the part off the top of the histogram.
   * No emissive and no clearcoat — a clearcoat lobe is a second, sharper mirror.
   */
  _haloMaterial() {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x4a4a4e,
      metalness: 1.0,
      roughness: 0.42,
      envMapIntensity: 0.6,
    });
    this._ownedMaterials.push(mat);
    return mat;
  }

  /**
   * The shared body mesh carries its own halo, authored for the exterior cameras. The
   * player car uses this one instead — two of them would z-fight, and the body's copy
   * is the one that was filling the driver's view — so its mesh is switched off here.
   * Only the player has a Cockpit, so the AI cars are untouched.
   */
  _suppressBodyHalo() {
    const level = this.car.active;
    if (!level || level === this._bodyHaloLevel) return;
    this._bodyHaloLevel = level;
    const meshes = level.model?.meshes;
    const haloMat = this.livery.halo;
    // Below the top detail tier the halo is merged into the carbon or body mesh, and
    // hiding that would take half the car with it.
    if (!meshes || !haloMat || haloMat === this.livery.body || haloMat === this.livery.carbon) return;
    for (let i = 0; i < meshes.length; i++) {
      if (meshes[i].material === haloMat) meshes[i].visible = false;
    }
  }

  // --- interior ----------------------------------------------------------------------

  _buildInterior() {
    const detail = this.quality?.name === 'low' ? 20 : 30;
    const shell = this._own(cockpitInteriorGeometry(detail));
    const weave = this._mat('carbon_weave', this.livery.carbon);
    const inner = new THREE.Mesh(shell, weave);
    inner.receiveShadow = false;
    this.group.add(inner);

    // Padding: the roll-hoop bolster behind the head, the side bolsters at the elbows
    // and the dash pad the driver's knuckles clear by about twenty millimetres.
    const padMat = this._mat('cockpit_padding', weave);
    const pads = [];
    pads.push(placed(slab(0.300, 0.070, 0.090, 0.020), 0, gy(0.560), 0.070));
    for (const s of [1, -1]) {
      pads.push(placed(slab(0.052, 0.075, 0.520, 0.018), s * 0.248, gy(0.520), -0.400));
      pads.push(placed(slab(0.090, 0.060, 0.180, 0.018), s * 0.190, gy(0.430), 0.090));
    }
    pads.push(placed(slab(0.360, 0.055, 0.075, 0.018), 0, gy(0.560), -0.960));
    const padGeo = this._own(mergeGeometries(pads, false));
    for (const p of pads) p.dispose();
    padGeo.computeVertexNormals();
    this.group.add(new THREE.Mesh(padGeo, padMat));

    // Six-point harness. The shoulder straps are what sell the sense of being strapped in.
    const beltMat = this.livery.accent;
    const belts = [];
    for (const s of [1, -1]) {
      belts.push(strap(
        new THREE.Vector3(s * 0.150, gy(0.600), 0.030),
        new THREE.Vector3(s * 0.058, gy(0.398), -0.300),
        0.076, 0.010,
      ));
      belts.push(strap(
        new THREE.Vector3(s * 0.230, gy(0.410), -0.140),
        new THREE.Vector3(s * 0.060, gy(0.372), -0.300),
        0.062, 0.010,
      ));
    }
    belts.push(placed(slab(0.090, 0.070, 0.028, 0.008), 0, gy(0.386), -0.310));
    const beltGeo = this._own(mergeGeometries(belts, false));
    for (const b of belts) b.dispose();
    beltGeo.computeVertexNormals();
    this.group.add(new THREE.Mesh(beltGeo, beltMat));
  }

  // --- steering wheel ------------------------------------------------------------------

  /**
   * The two surfaces the steering wheel is actually made of, built here rather than
   * taken from the registry.
   *
   * The registry publishes a tile size in `userData` and leaves every texture's repeat
   * at 1, on the understanding that whoever places the geometry sets it — CarModel has a
   * whole table for exactly that. Nothing was setting it here, so the console's 16 mm
   * carbon tile was being stretched across 172 mm of panel: one weave cell over the
   * whole face, which is indistinguishable from a flat dark plastic moulding, and it is
   * why the review read the wheel as untextured. These two build their own textures so
   * the repeats can be pinned to the parts they are actually on.
   *
   * GRIP — matte black moulded rubber, pinned: albedo 0x14141a, roughness 0.85,
   * metalness 0. No clearcoat and the environment held to 0.35, because the one thing a
   * grip must never do is shine; the diamond knurl carries it instead. The knurl tile is
   * 30 mm, the grip arc is about 200 mm long and 140 mm round, so the repeat is 6.7 by
   * 4.7 and a knurl pyramid lands at roughly 6 px at cockpit range.
   *
   * WEAVE — the console panel, in 2 mm-tow twill under a lacquer. 8 tows to the tile is
   * a 16 mm cell, which at 172 mm across the panel is 10.75 repeats: a tow every 2 mm,
   * about 4 px on screen from the driver's seat, so the weave is genuinely legible where
   * he is looking at it. The clearcoat is what makes it read as a laid-up and lacquered
   * part rather than as a printed decal — 0.55 at 0.14 roughness is a satin lacquer, not
   * show-car gloss, which on a panel this close would mirror the sky and hide the weave.
   */
  _wheelSurfaces() {
    const px = this.quality?.name === 'low' ? 128 : 256;
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
      color: 0x14141a,
      roughness: 0.85,
      metalness: 0.0,
      normalMap: tex(knurl.normal, knurl.width, knurl.height, knurlN.levels, 6.7, 4.7),
      aoMap: gripAo,
      clearcoat: 0.0,
      envMapIntensity: 0.35,
    });
    grip.normalScale.set(1.15, 1.15);

    const twill = buildCarbonTwill(px * 2, 8, {
      gloss: 0.42, contrast: 1.35, seed: 6203,
      baseR: 0x0f, baseG: 0x10, baseB: 0x15, normalStrength: 2.5,
    });
    const twillN = normalMipChain(twill.normal, twill.width, twill.height);
    const twillO = mipChain(twill.orm, twill.width, twill.height, false);
    applyToksvig(twillO, twillN.lengths);
    const twillC = mipChain(twill.color, twill.width, twill.height, true);
    const orm = tex(twill.orm, twill.width, twill.height, twillO, 10.75, 7.75);
    orm.channel = 0;
    const weave = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      map: tex(twill.color, twill.width, twill.height, twillC, 10.75, 7.75, THREE.SRGBColorSpace),
      normalMap: tex(twill.normal, twill.width, twill.height, twillN.levels, 10.75, 7.75),
      roughnessMap: orm,
      aoMap: orm,
      roughness: 1.0,
      metalness: 0.0,
      clearcoat: 0.55,
      clearcoatRoughness: 0.14,
      envMapIntensity: 0.85,
    });
    weave.normalScale.set(1.0, 1.0);

    this._ownedMaterials.push(grip, weave);
    return { grip, weave };
  }

  _buildSteeringWheel() {
    const hero = this.quality?.name !== 'low';
    const radial = hero ? 12 : 7;
    const tubular = hero ? 96 : 48;

    this.wheelPivot = new THREE.Object3D();
    this.wheelPivot.name = 'steering-wheel';
    const wc = COCKPIT_ANCHORS.wheelCentre;
    this.wheelPivot.position.set(wc[0] + WHEEL_OFFSET[0], wc[1] + WHEEL_OFFSET[1], wc[2] + WHEEL_OFFSET[2]);
    // The column is raked back; +Z of the wheel plane ends up pointing at the driver.
    this.wheelPivot.rotation.x = -(Math.PI * 0.5 - COCKPIT_ANCHORS.wheelRake);
    // On the driver rig, not on `group`: the chase and replay cameras look straight at
    // the wheel and the hands on it, and both have to survive the cockpit gate.
    this.driverGroup.add(this.wheelPivot);

    const outline = rimOutline(hero ? 64 : 32);
    const carbonMatte = this._mat('carbon_matte', this.livery.carbonMatte);
    const metal = this._mat('metal_anodised', this.livery.metal);
    const { grip: gripMat, weave } = this._wheelSurfaces();

    const structural = [];
    structural.push(tubeFrom(outline, 0.0155, radial, true, tubular));
    // Quick-release hub and the spokes that reach out to the rim.
    const hub = new THREE.CylinderGeometry(0.044, 0.038, 0.052, hero ? 20 : 10);
    hub.rotateX(Math.PI * 0.5);
    hub.translate(0, 0, -0.034);
    structural.push(hub);
    for (const s of [1, -1]) {
      structural.push(placed(slab(0.062, 0.030, 0.020, 0.006), s * 0.088, -0.010, -0.004, 0, 0, s * 0.28));
    }
    // Shift paddles behind the rim, and the smaller clutch paddles below them.
    for (const s of [1, -1]) {
      structural.push(placed(slab(0.044, 0.128, 0.007, 0.003), s * 0.082, 0.006, -0.046, 0.10, s * 0.20, 0));
      structural.push(placed(slab(0.036, 0.072, 0.006, 0.003), s * 0.106, -0.062, -0.038, 0.10, s * 0.30, 0));
    }
    const structGeo = this._own(mergeGeometries(structural, false));
    for (const g of structural) g.dispose();
    structGeo.computeVertexNormals();
    this.wheelPivot.add(new THREE.Mesh(structGeo, carbonMatte));

    // Moulded hand grips: thicker, softer sections where the driver actually holds on.
    const grips = [];
    const n = outline.length;
    for (const s of [1, -1]) {
      const pts = [];
      for (let k = -7; k <= 7; k++) {
        const i = ((s > 0 ? Math.round(n * 0.25) : Math.round(n * 0.75)) + k + n) % n;
        pts.push(outline[i].clone().multiplyScalar(1.0));
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

    // Centre console body carrying the display, in exposed weave.
    const body = this._own(placed(slab(0.172, 0.124, 0.028, 0.010), 0, 0.004, 0.002));
    this.wheelPivot.add(new THREE.Mesh(body, weave));

    this._buildDisplay();
    this._buildControls(metal, hero);
  }

  _buildDisplay() {
    const displayMat = this._mat('display_screen', null);
    this._displayCtx = displayMat?.userData?.context ?? null;
    this._displayTex = displayMat?.userData?.texture ?? null;
    this._displayW = displayMat?.userData?.canvas?.width ?? 512;
    this._displayH = displayMat?.userData?.canvas?.height ?? 256;

    const screen = this._own(new THREE.PlaneGeometry(0.116, 0.068));
    const screenMesh = new THREE.Mesh(screen, displayMat ?? new THREE.MeshBasicMaterial({ color: 0x0a0f18 }));
    screenMesh.position.set(0, 0.004, 0.0165);
    this.wheelPivot.add(screenMesh);

    // Fifteen shift lights: five green, five red, five blue, exactly as the FIA wheel.
    const stripGeo = this._own(new THREE.PlaneGeometry(0.186, 0.0135));
    const ledMat = this.ctx.materials?.clone?.('led_strip')
      ?? new THREE.MeshStandardMaterial({ emissive: new THREE.Color(0xffffff), emissiveIntensity: 3 });
    this._ledUniforms = { uLit: { value: 0 }, uFlash: { value: 0 } };
    const uniforms = this._ledUniforms;
    // The mask samples the emissive map's UV set, which only exists when the library
    // actually supplied that map; without it the strip stays fully lit rather than
    // failing to compile.
    if (ledMat.emissiveMap) ledMat.onBeforeCompile = (shader) => {
      shader.uniforms.uLit = uniforms.uLit;
      shader.uniforms.uFlash = uniforms.uFlash;
      shader.fragmentShader = `uniform float uLit;\nuniform float uFlash;\n${shader.fragmentShader}`
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
	float cell = floor( vEmissiveMapUv.x * 15.0 );
	float lit = max( step( cell + 0.5, uLit ), uFlash );
	totalEmissiveRadiance *= lit;`,
        );
    };
    if (ledMat.emissiveMap) ledMat.customProgramCacheKey = () => 'apex_rev_leds';
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

    /** Queue a cap with its colour, so the whole cluster is one draw call. */
    const cap = (geo, hex) => {
      caps.push(geo);
      capColours.push(hex);
    };

    for (const [x, y] of WHEEL_ROTARIES) {
      const knob = new THREE.CylinderGeometry(0.0132, 0.0142, 0.013, seg);
      knob.rotateX(Math.PI * 0.5);
      knob.translate(x, y, 0.020);
      bodies.push(knob);
      // 18 mm across: the pinned ceiling for anything with a colour on it.
      const face = new THREE.CylinderGeometry(0.0090, 0.0090, 0.0035, seg);
      face.rotateX(Math.PI * 0.5);
      face.translate(x, y, 0.0283);
      cap(face, CAP_ROTARY);
      const notch = new THREE.BoxGeometry(0.0026, 0.0080, 0.0040);
      notch.translate(x, y + 0.0055, 0.0292);
      cap(notch, CAP_INDEX);
    }

    for (const [x, y] of WHEEL_TOGGLES) {
      const toggle = new THREE.BoxGeometry(0.010, 0.020, 0.010);
      toggle.translate(x, y, 0.021);
      bodies.push(toggle);
    }

    for (const [x, y, hex] of WHEEL_BUTTONS) {
      const bezel = new THREE.CylinderGeometry(0.0082, 0.0086, 0.006, seg);
      bezel.rotateX(Math.PI * 0.5);
      bezel.translate(x, y, 0.0195);
      bodies.push(bezel);
      const face = new THREE.CylinderGeometry(0.0068, 0.0068, 0.0035, seg);
      face.rotateX(Math.PI * 0.5);
      face.translate(x, y, 0.0243);
      cap(face, hex);
    }

    const bodyGeo = this._own(mergeGeometries(bodies, false));
    for (const g of bodies) g.dispose();
    bodyGeo.computeVertexNormals();
    this.wheelPivot.add(new THREE.Mesh(bodyGeo, metal));

    // Ten caps in five colours, in one mesh: the colour rides a vertex attribute rather
    // than a material, so the whole cluster is a single draw call instead of five.
    for (let i = 0; i < caps.length; i++) tintGeometry(caps[i], capColours[i]);
    const capGeo = this._own(mergeGeometries(caps, false));
    for (const g of caps) g.dispose();
    capGeo.computeVertexNormals();
    const capMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.38,
      metalness: 0.0,
      clearcoat: 0.45,
      clearcoatRoughness: 0.12,
      // Held well down. The caps used the livery accent at envMapIntensity 1.35, which
      // under an open sky is what made six of them glow brighter than the screen.
      envMapIntensity: 0.55,
    });
    this._ownedMaterials.push(capMat);
    this.wheelPivot.add(new THREE.Mesh(capGeo, capMat));
  }

  // --- driver -------------------------------------------------------------------------

  /**
   * Arms and hands go on the driver rig, legs stay on the interior group.
   *
   * The split is what each camera can see. Nobody outside the car can see a driver's
   * shins — they are under the bodywork — but the arms, the gloves on the rim and the
   * helmet above the tub are the difference between a car with a driver in it and an
   * empty tub, so those three are on the rig and survive the cockpit gate.
   */
  _buildDriver() {
    const detail = this.quality?.name === 'low' ? 1 : 2;
    const sh = COCKPIT_ANCHORS.shoulder;
    this.arms = [
      new ArmChain(this.ctx, this.livery, -1, [-sh[0], sh[1], sh[2]], detail),
      new ArmChain(this.ctx, this.livery, 1, [sh[0], sh[1], sh[2]], detail),
    ];
    for (const arm of this.arms) {
      this.driverGroup.add(arm.group);
      // The upper arm is the one link that is genuinely buried: its elbow end swings
      // outboard of the tub wall, where nothing in the seat can see it and the chase
      // camera would catch it clipping through the flank. It stays on the gated group;
      // the forearm and the glove, which are the parts an external camera is looking
      // for, ride the rig.
      this.group.add(arm.upper);
    }

    const legs = this._own(legsGeometry(
      detail, COCKPIT_ANCHORS.knee, COCKPIT_ANCHORS.ankle, COCKPIT_ANCHORS.hip,
    ));
    // Same calmed suit the sleeves use, so the knees at the bottom of the frame and the
    // forearms above them are unmistakably the same garment.
    this.legs = new THREE.Mesh(legs, cockpitSuitMaterial(this.livery) ?? this.livery.suit);
    this.group.add(this.legs);

    // Helmet, shoulders and the top of the harness. Car.js deliberately skips the bust
    // on the player's LOD levels because it would fill the cockpit camera; it is built
    // here instead and hidden only while the camera is actually in the seat, so the
    // external cameras get a driver and the first-person one does not get a helmet
    // interior across the lens.
    this.bust = this.car.driver
      ? new DriverBust(this.ctx, this.car.driver, this.livery, detail, COCKPIT_ANCHORS.helmet)
      : null;
    if (this.bust) {
      if (detail < 2) this.bust.visor.visible = false;
      this.driverGroup.add(this.bust.group);
    }
  }

  // --- mirrors ------------------------------------------------------------------------

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
        // Half float and linear: the mirror image stays in the same HDR space the
        // pipeline grades, so highlights in the mirror do not clip to white on their own.
        type: THREE.HalfFloatType,
        depthBuffer: true,
        stencilBuffer: false,
      });
      target.texture.colorSpace = THREE.NoColorSpace;
      this._ownedTargets.push(target);

      const geo = this._own(new THREE.PlaneGeometry(0.114, 0.053));
      // A mirror reverses handedness; flipping u is cheaper than an oblique projection.
      const uv = geo.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
      uv.needsUpdate = true;

      const mat = new THREE.MeshBasicMaterial({ map: target.texture, toneMapped: true });
      this._ownedMaterials.push(mat);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(m.pos[0], m.pos[1], m.pos[2]);
      mesh.rotation.y = m.yaw;
      // Sits a couple of millimetres proud of the housing glass the body mesh carries.
      mesh.translateZ(0.003);
      mesh.frustumCulled = false;
      this.group.add(mesh);

      const camera = new THREE.PerspectiveCamera(52, 0.114 / 0.053, 0.35, 500);
      this.mirrors.push({ mesh, camera, target, spec: m });
    }
  }

  // --- visor --------------------------------------------------------------------------

  _buildVisor() {
    const size = 512;
    const canvas = createCanvas(size, size);
    drawVisor(canvas.getContext('2d'), size);
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
      opacity: 1.0,
    });
    this._ownedMaterials.push(mat);
    this.visor = new THREE.Mesh(geo, mat);
    this.visor.renderOrder = 4000;
    this.visor.frustumCulled = false;
    this.visor.position.set(0, 0, -0.09);
    this._sizeVisor();

    const camera = this.ctx.camera;
    if (camera) camera.add(this.visor);
    else this.cameraAnchor.add(this.visor);
  }

  /**
   * Fit the visor quad to the camera frustum at its parked distance.
   *
   * `camera.fov` is the vertical angle CameraRig writes each frame, and the rig moves it
   * — it opens the lens with speed and closes it again under braking — so this cannot be
   * a one-shot at build time the way a fixed lens would allow. Sizing it once left the
   * quad cut for the boot-time 82 degrees while the rig was projecting through roughly
   * 52, so the tint and its edge darkening sat well outside the frame and never showed.
   * Called from `update` behind an equality check: two float compares a frame, and a
   * rebuild only on the frames the lens actually moved.
   */
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

  // --- runtime -------------------------------------------------------------------------

  /**
   * @param {number} dt seconds
   * @param {object} ctx shared context
   */
  update(dt, ctx) {
    // Before the visibility gate: the body's halo has to stay suppressed in every
    // camera mode, and the LOD root it lives on is not built until after construction.
    this._suppressBodyHalo();

    const state = this.car.physics?.state;
    if (!state) return;

    this._visible = this._cameraIsInCockpit(ctx);
    if (this.group.visible !== this._visible) this.group.visible = this._visible;
    if (this.visor) this.visor.visible = this._visible;
    // The driver's own helmet would be inside the lens from the seat, and is the whole
    // point of the shot from anywhere else.
    if (this.bust && this.bust.group.visible === this._visible) this.bust.setVisible(!this._visible);

    // The wheel and the arms are on the driver rig now, so they are driven whatever the
    // camera is doing: a chase shot of a car whose wheel is centred while it is mid
    // corner reads as a ghost car.
    const front = 0.5 * (state.wheels[0].steerAngle + state.wheels[1].steerAngle);
    const normalised = clamp(front / this._maxRoadWheelAngle, -1, 1);
    this._steerSmoothed = damp(this._steerSmoothed, normalised, 28, dt);
    this.wheelPivot.rotation.z = -this._steerSmoothed * WHEEL_LOCK_RAD;
    this.wheelPivot.updateMatrix();

    this._updateHands();
    this._updateLeds(state);
    if (this.bust) this.bust.setHeadLean(state.gForce.x, state.gForce.z);

    if (!this._visible) return;

    // Track the lens: the rig varies FOV with speed, and a visor cut for a different
    // angle either floats inside the frame or misses its edges entirely.
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

  /** True when the active camera is actually sitting at the driver's eye point. */
  _cameraIsInCockpit(ctx) {
    const cam = ctx.camera;
    if (!cam) return true;
    this.cameraAnchor.getWorldPosition(_eyeWorld);
    cam.getWorldPosition(_camPos);
    return _camPos.distanceToSquared(_eyeWorld) < 0.36;
  }

  /**
   * Hands on the rim at quarter to three, and the grip frame that keeps them there.
   *
   * The glove is authored with its fingers spread along +X, its wrist up +Y and its
   * palm facing -Z, so the frame has to be built out of the two things that are
   * physically fixed: the rim tangent, which is the axis the fingers lie along, and the
   * forearm, which is the axis they hang off. The forearm direction is taken from the
   * solved elbow, not from the shoulder — the elbow swings a long way outboard under
   * lock, and a wrist aimed at the shoulder rolls the glove thirty degrees off the rim
   * exactly when the player is looking at it. So the chain is solved first, the frame is
   * built from the elbow it produces, and the hand is oriented afterwards.
   */
  _updateHands() {
    const steer = this._steerSmoothed;
    _driverDir.set(0, 0, 1).applyQuaternion(this.wheelPivot.quaternion);
    // The rim is vertical at both grips, so one tangent serves both hands.
    _rim.set(0, 1, 0).applyQuaternion(this.wheelPivot.quaternion);
    for (let i = 0; i < 2; i++) {
      const arm = this.arms[i];
      const side = i === 0 ? -1 : 1;
      // A driver does not steer from static shoulders: the torso rotates with the wheel,
      // which is what keeps the outside arm from reaching past full extension at lock.
      arm.shoulder.set(
        arm.baseShoulder.x,
        arm.baseShoulder.y - side * steer * 0.052,
        arm.baseShoulder.z - Math.abs(steer) * 0.030,
      );
      _target.copy(GRIP_LOCAL[i]).applyMatrix4(this.wheelPivot.matrix);
      arm.solve(_target);

      // Y: hand to elbow. X: the rim tangent at the grip, squared up against it.
      _v.subVectors(arm.elbow, _target).normalize();
      _v2.copy(_rim).addScaledVector(_v, -_rim.dot(_v));
      if (_v2.lengthSq() < 1e-8) _v2.set(1, 0, 0).addScaledVector(_v, -_v.x);
      _v2.normalize();
      _v3.crossVectors(_v2, _v);
      // The rim tangent has no inherent sign, and the wrong one mirrors the whole hand
      // through the rim. Choosing it so the back of the glove faces the driver fixes
      // both grips from one rule and keeps the basis right-handed either way.
      if (_v3.dot(_driverDir) < 0) {
        _v2.negate();
        _v3.negate();
      }
      _mat3.makeBasis(_v2, _v, _v3);
      _qh.setFromRotationMatrix(_mat3);

      // The forearm is not square to the rim — at 9 and 3 it meets it at about 50
      // degrees — so X, which is the rim squared up against the forearm, sits some way
      // off the rim itself. Rolling the glove half that difference splits the error
      // between the fingers, which want to lie across the tube, and the cuff, which
      // wants to stay on the end of the sleeve; giving all of it to either one visibly
      // breaks the other.
      //
      // The half is a contract, not a taste: the glove mesh carries a wrist bent by
      // DriverModel's WRIST_BEND and rolled back by half of it, which is what lets the
      // fingers land on the rim and the cuff land on the sleeve at the same time from
      // one rigid mesh. Change this factor and WRIST_ROLL has to change with it.
      const rx = _rim.dot(_v2);
      const ry = _rim.dot(_v);
      const sgn = rx < 0 ? -1 : 1;
      _qRoll.setFromAxisAngle(_UNIT_Z, clamp(0.5 * Math.atan2(sgn * ry, sgn * rx), -0.5, 0.5));
      _qh.multiply(_qRoll);
      arm.orientHand(_qh);
    }
  }

  /**
   * Head model. The driver is strapped in, so this is not a free camera: the eye point
   * translates a few millimetres under load and the horizon rolls slightly against the
   * corner, which is what makes the car feel like it weighs 798 kg.
   */
  _updateHead(dt, state, ctx) {
    const scale = ctx.settings?.get?.('headMovement') ?? 1;
    if (scale <= 0) {
      this.cameraAnchor.position.set(EYE_LOCAL[0], EYE_LOCAL[1], EYE_LOCAL[2]);
      this.cameraAnchor.rotation.set(0, 0, 0);
      return;
    }
    const g = state.gForce;
    this._leanTarget.set(
      clamp(-g.x * 0.011, -0.026, 0.026),
      clamp(-(g.y - 1) * 0.006, -0.020, 0.020),
      clamp(g.z * 0.013, -0.030, 0.030),
    );
    this._lean.x = damp(this._lean.x, this._leanTarget.x, 9, dt);
    this._lean.y = damp(this._lean.y, this._leanTarget.y, 9, dt);
    this._lean.z = damp(this._lean.z, this._leanTarget.z, 9, dt);

    const eye = EYE_LOCAL;
    this.cameraAnchor.position.set(
      eye[0] + this._lean.x * scale,
      eye[1] + this._lean.y * scale,
      eye[2] + this._lean.z * scale,
    );
    // Roll into the corner, pitch with braking, both an order of magnitude below the
    // chassis motion so it reads as a neck, not as a camera effect.
    this.cameraAnchor.rotation.z = clamp(g.x * 0.016, -0.05, 0.05) * scale;
    this.cameraAnchor.rotation.x = clamp(-g.z * 0.010, -0.035, 0.035) * scale;
    this.cameraAnchor.updateMatrix();
  }

  _updateLeds(state) {
    if (!this._ledUniforms) return;
    const limiter = this.config?.engine?.limiterRpm ?? 15000;
    const start = limiter * 0.72;
    const t = clamp01((state.rpm - start) / Math.max(1, limiter * 0.985 - start));
    this._ledUniforms.uLit.value = Math.round(t * 15);
    // The blue block flashes together once the limiter is actually cutting.
    this._ledUniforms.uFlash.value = state.limiterActive
      ? (Math.floor(performance.now() / 60) % 2 === 0 ? 1 : 0)
      : 0;
  }

  // --- steering-wheel display ------------------------------------------------------------

  _drawDisplay(ctx, state) {
    const c = this._displayCtx;
    if (!c) return;
    const w = this._displayW;
    const h = this._displayH;

    c.fillStyle = '#04060a';
    c.fillRect(0, 0, w, h);

    // rpm bar
    const limiter = this.config?.engine?.limiterRpm ?? 15000;
    const rpmT = clamp01(state.rpm / limiter);
    const barY = h * 0.055;
    const barH = h * 0.115;
    const pad = w * 0.045;
    const barW = w - pad * 2;
    c.fillStyle = '#0c1420';
    c.fillRect(pad, barY, barW, barH);
    const cells = 24;
    for (let i = 0; i < cells; i++) {
      const f = i / cells;
      if (f > rpmT) break;
      c.fillStyle = f < 0.62 ? '#19e05a' : f < 0.84 ? '#ffd11a' : '#ff2f1e';
      c.fillRect(pad + f * barW + 1, barY + 2, barW / cells - 2, barH - 4);
    }

    // gear
    const gear = state.gear;
    const gearText = gear < 0 ? 'R' : gear === 0 ? 'N' : String(gear);
    c.fillStyle = state.limiterActive ? '#5aa0ff' : '#f2f6ff';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `800 ${Math.round(h * 0.52)}px system-ui, "Helvetica Neue", Arial, sans-serif`;
    c.fillText(gearText, w * 0.5, h * 0.47);

    // speed
    c.textAlign = 'right';
    c.font = `700 ${Math.round(h * 0.20)}px system-ui, Arial, sans-serif`;
    c.fillStyle = '#e8f0ff';
    c.fillText(String(Math.round(Math.abs(state.speedKph))), w * 0.97, h * 0.42);
    c.font = `600 ${Math.round(h * 0.075)}px system-ui, Arial, sans-serif`;
    c.fillStyle = '#7f93ad';
    c.fillText('KM/H', w * 0.97, h * 0.56);

    // lap counter
    const session = ctx.race?.session;
    c.textAlign = 'left';
    c.font = `600 ${Math.round(h * 0.085)}px system-ui, Arial, sans-serif`;
    c.fillStyle = '#7f93ad';
    c.fillText('LAP', pad, h * 0.30);
    c.font = `700 ${Math.round(h * 0.15)}px system-ui, Arial, sans-serif`;
    c.fillStyle = '#e8f0ff';
    const lap = session?.lap ?? 1;
    const total = session?.totalLaps ?? 0;
    c.fillText(total > 0 ? `${lap}/${total}` : String(lap), pad, h * 0.44);

    // delta to the reference lap, colour coded the way a real dash does it
    const delta = this.car.delta;
    c.font = `700 ${Math.round(h * 0.135)}px system-ui, Arial, sans-serif`;
    if (Number.isFinite(delta)) {
      c.fillStyle = delta <= 0 ? '#25e06a' : '#ff5a3c';
      c.fillText(formatGap(delta), pad, h * 0.70);
    } else {
      c.fillStyle = '#43536a';
      c.fillText('--.---', pad, h * 0.70);
    }
    c.font = `600 ${Math.round(h * 0.075)}px system-ui, Arial, sans-serif`;
    c.fillStyle = '#7f93ad';
    c.fillText(formatLapTime(this.car.lastLapTime), pad, h * 0.84);

    // ERS store and deployment
    const ersW = w * 0.34;
    const ersX = w - pad - ersW;
    const ersY = h * 0.68;
    c.fillStyle = '#0c1420';
    c.fillRect(ersX, ersY, ersW, h * 0.085);
    c.fillStyle = '#28c8ff';
    c.fillRect(ersX + 1, ersY + 1, (ersW - 2) * clamp01(state.ers.charge), h * 0.085 - 2);
    c.fillStyle = state.ers.deploy > 0.01 ? '#ffd11a' : '#3a4a5e';
    c.fillRect(ersX, ersY + h * 0.10, ersW * clamp01(state.ers.deploy), h * 0.030);
    c.textAlign = 'right';
    c.font = `600 ${Math.round(h * 0.070)}px system-ui, Arial, sans-serif`;
    c.fillStyle = '#7f93ad';
    c.fillText(`ERS ${Math.round(state.ers.charge * 100)}%`, w - pad, h * 0.63);

    if (state.drs.open) {
      c.textAlign = 'center';
      c.fillStyle = '#00e5a0';
      c.font = `800 ${Math.round(h * 0.10)}px system-ui, Arial, sans-serif`;
      c.fillText('DRS', w * 0.5, h * 0.82);
    } else if (state.drs.available) {
      c.textAlign = 'center';
      c.fillStyle = '#0f6b52';
      c.font = `800 ${Math.round(h * 0.10)}px system-ui, Arial, sans-serif`;
      c.fillText('DRS', w * 0.5, h * 0.82);
    }

    if (this._displayTex) this._displayTex.needsUpdate = true;
  }

  // --- mirror pass -----------------------------------------------------------------------

  /**
   * Render the mirrors. This is the one place outside RenderPipeline that touches the
   * renderer, and it only ever draws into its own offscreen target — the previous
   * render target and the shadow-map update flag are both restored before returning, so
   * the pipeline's own pass is unaffected. One mirror is refreshed per frame.
   */
  renderMirrors(ctx) {
    if (!this._visible || !this.mirrors || this.mirrors.length === 0) return;
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
    // Reflect the eye-to-mirror ray about the glass normal: that is the direction the
    // driver is actually looking down when they glance at this mirror.
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

    // Shadow maps were built for this frame already; rebuilding them for the mirror
    // would double the shadow cost for a 512-pixel image nobody studies.
    renderer.shadowMap.autoUpdate = false;
    this.group.visible = false;
    // The mirror sits level with the driver's shoulder and looks back past it; leaving
    // the rig in fills half of a 114 mm pane with the back of his own helmet.
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

const CG_H = 0.280;
function gy(h) {
  return h - CG_H;
}

/** Flat webbing between two points: a chamfered slab aligned to the strap direction. */
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

/**
 * Visor: peripheral edge darkening and nothing else.
 *
 * The previous pass sized this quad to the live frustum for the first time and the
 * effect it had been hiding turned out to be far too strong — an aperture band across
 * the top and bottom of the frame, scratches and dust over the whole image, and a
 * corner falloff reaching 80% opacity. Over a green car in a green-tinted lower frame
 * it read as a wash across everything below the wheel rim.
 *
 * So it is cut back to one thing, and pinned: a neutral (pure grey, no channel bias)
 * darkening that is exactly zero inside 85% of the frame radius and reaches 6% opacity
 * at the frame edge, held there out to the corners. `inner` is 0.85 of the inscribed
 * radius, so the outer 15% of the radius is the only part of the image the overlay
 * touches; radii beyond the last stop keep the final colour, which is what darkens the
 * corners without a second gradient.
 *
 * The texture is square and the quad it is mapped onto is the frame's aspect, so the
 * circle becomes an ellipse inscribed in the frame — an aspect-normalised vignette,
 * which is what a helmet aperture actually is.
 */
function drawVisor(c, size) {
  c.clearRect(0, 0, size, size);

  const mid = size * 0.5;
  const outer = size * 0.5;
  const inner = outer * 0.85;

  const g = c.createRadialGradient(mid, mid, inner, mid, mid, outer);
  g.addColorStop(0.0, 'rgba(6,6,6,0)');
  g.addColorStop(0.5, 'rgba(6,6,6,0.014)');
  g.addColorStop(1.0, 'rgba(6,6,6,0.060)');
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
}

export { WHEEL_LOCK_RAD, drawVisor };
