import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { clamp, clamp01 } from '../core/MathUtils.js';

/**
 * Wheels, tyres and brakes for one car.
 *
 * All four corners of a given part live in a single InstancedMesh, so a complete wheel
 * — slick, sidewall, rim, disc and caliper — costs five draw calls per car instead of
 * twenty, and the distant level still costs three rather than one. The tyre is authored
 * in a unit space (radius 1, width 1 along the axle) and the instance matrix carries the
 * real dimensions, which is what lets one geometry serve both the 360 mm/305 mm fronts
 * and the 362.5 mm/405 mm rears.
 *
 * Proportions are 2026 regulation: an 18-inch rim inside a 720 mm tyre, so the bead sits
 * at 0.63 of the tyre radius and the sidewall is the short, stiff flank of a modern
 * slick rather than the tall balloon a 13-inch rim leaves under it.
 *
 * Left-hand wheels are pre-rotated 180 degrees about the vertical rather than mirrored:
 * a negative scale would invert the winding of every instanced triangle, and a rotation
 * puts the aero wheel cover and the sidewall lettering outboard on both sides for free.
 */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _axisX = new THREE.Vector3(1, 0, 0);
const _axisY = new THREE.Vector3(0, 1, 0);
const _axisZ = new THREE.Vector3(0, 0, 1);
const _flip = new THREE.Quaternion().setFromAxisAngle(_axisY, Math.PI);

const IS_LEFT = [true, false, true, false];

/**
 * Slick tread band: crowned centre, generous shoulder radius, no pattern at all.
 *
 * The crown is continuous rather than a flat middle with rounded corners. A slick really
 * does fall about 2.5 mm from the centreline to the edge of the contact patch, and that
 * curvature is the only thing lighting the tread has to work with — a cylindrical middle
 * holds one normal across 60 % of the band and shades as a flat grey wall, which is what
 * had a critic calling the tyres smooth faceted cylinders.
 */
const TREAD_PROFILE = [
  [-0.476, 0.9505], [-0.464, 0.9700], [-0.446, 0.9835], [-0.420, 0.9915],
  [-0.372, 0.9955], [-0.290, 0.9980], [-0.160, 0.9995], [0.0, 1.0],
  [0.160, 0.9995], [0.290, 0.9980], [0.372, 0.9955], [0.420, 0.9915],
  [0.446, 0.9835], [0.464, 0.9700], [0.476, 0.9505],
];

/**
 * Bead radius, in tyre-radius units. An 18-inch rim is 457 mm across the flanges and a
 * rear slick is 725 mm across, so the bead sits at 0.63 of the tyre radius — not the
 * 0.46 this carried, which is a 13-inch rim under a 2021 tyre. Getting this wrong is
 * what left the wheel as a featureless black donut: it buries the one bright, hard-edged
 * feature the eye uses to read a wheel at distance under 200 mm of extra sidewall.
 */
const BEAD_R = 0.632;
const SHOULDER_R = 0.951;

/**
 * Sidewall from the bead up to the shoulder. Maximum section width sits a little over
 * halfway up the flank, which is where a loaded racing tyre actually bulges — the detail
 * that stops a tyre reading as an extruded cylinder. x is in tyre-width units, so 0.5 is
 * the nominal section width and the tread band at 0.476 is deliberately narrower.
 */
const SIDEWALL_PROFILE = [
  [0.404, 0.632], [0.462, 0.700], [0.494, 0.766], [0.5017, 0.806],
  // Moulded compound channel. CarTextures paints the band at v = 0.69 +/- 0.085 of the
  // bead-to-shoulder span, which is r = 0.825..0.879 here, and it authors mould lips
  // either side of it. Those lips and the recess have to exist in the *geometry* as
  // well: a band that is only a colour ramp and a normal map still reads as a decal
  // stuck on the flank, because its silhouette runs dead straight past the shoulder.
  // 2.0 mm of recess and 0.8 mm of proud lip on a 305 mm section, which is what a
  // moulded identification channel actually measures.
  [0.5067, 0.818],      // outboard mould lip, +0.8 mm proud of the flank
  [0.5052, 0.8235],     // lip falls back to the flank line
  [0.4992, 0.830],      // channel wall down, -2.0 mm
  [0.4939, 0.874],      // channel floor, following the flank's own taper
  [0.4995, 0.880],      // channel wall back up
  [0.5004, 0.886],      // inboard mould lip
  [0.4940, 0.900],
  [0.489, 0.918], [0.476, 0.951],
];

/**
 * Rim barrel, outboard aero cover dish and centre-lock boss, in tyre-radius units.
 * The inboard end turns in to a 0.36 opening rather than stopping at the barrel: the
 * brake disc is 0.36 of the tyre radius, so it fills that hole exactly. A wider opening
 * leaks daylight through the hub and reads as a wheel with nothing behind it; a narrower
 * one hides the disc, which is the cue that tells the eye a wheel has brakes in it.
 */
const RIM_PROFILE = [
  [-0.412, 0.360], [-0.426, 0.470], [-0.430, 0.560], [-0.430, 0.618],
  [-0.402, 0.632], [-0.380, 0.622],
  [0.380, 0.622], [0.402, 0.632], [0.418, 0.618],
  [0.404, 0.545], [0.386, 0.420], [0.378, 0.270], [0.392, 0.150],
  [0.430, 0.100], [0.446, 0.058], [0.436, 0.0],
];

/**
 * Impostor rim: the same flange and cover, closed across the inboard face. The distant
 * level draws no disc or caliper, so an open barrel would show daylight through the hub.
 */
const RIM_PROFILE_FAR = [
  [-0.412, 0.0], [-0.416, 0.360], [-0.424, 0.560], [-0.402, 0.632],
  [0.402, 0.632], [0.418, 0.618], [0.392, 0.430], [0.386, 0.180], [0.436, 0.0],
];

function revolve(profile, segments, uvFn) {
  const rows = profile.length;
  const cols = segments + 1;
  const position = new Float32Array(rows * cols * 3);
  const uv = new Float32Array(rows * cols * 2);
  let k = 0;
  let t = 0;
  for (let i = 0; i < rows; i++) {
    const x = profile[i][0];
    const r = profile[i][1];
    const fi = i / (rows - 1);
    for (let j = 0; j < cols; j++) {
      const a = (j / segments) * Math.PI * 2;
      position[k * 3] = x;
      position[k * 3 + 1] = r * Math.cos(a);
      position[k * 3 + 2] = r * Math.sin(a);
      const st = uvFn(fi, j / segments, x, r);
      uv[t++] = st[0];
      uv[t++] = st[1];
      k++;
    }
  }
  const idx = [];
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

const _uvOut = [0, 0];

/** Half the tread band's extent in unit space, from TREAD_PROFILE's outermost station. */
const TREAD_HALF = 0.476;

function treadUv(fi, fa, x) {
  // The tread grain runs with the rolling direction, so u goes around the tyre: seven
  // repeats of a 0.32 m tile over a 2.26 m circumference.
  _uvOut[0] = fa * 7;
  // v maps the tread band to exactly [0,1] and does not tile. The tyre texture authors
  // a cross-tread wear profile — glazed contact band in the middle, torn shoulders,
  // marbles at the edges — and that only lands on the right rubber if v is anchored to
  // the shoulders. The old (x + 0.5) * 1.35 wrapped mid-band and put no feature
  // anywhere in particular, which is why the slick had no width to it.
  _uvOut[1] = (x + TREAD_HALF) / (TREAD_HALF * 2);
  return _uvOut;
}

function sidewallUv(fi, fa, x, r) {
  // Keyed off radius, not the profile index, so the moulded lettering sits at the same
  // height on the inboard sidewall as on the outboard one despite the reversed profile.
  _uvOut[0] = fa;
  _uvOut[1] = (r - BEAD_R) / (SHOULDER_R - BEAD_R);
  return _uvOut;
}

function rimUv(fi, fa, x, r) {
  _uvOut[0] = fa * 5;
  _uvOut[1] = r * 3.2 + x * 0.8;
  return _uvOut;
}

function discUv(fi, fa, x, r) {
  _uvOut[0] = fa * 4;
  _uvOut[1] = (r - 0.40) * 1.6;
  return _uvOut;
}

/** Ventilated carbon disc: two faces and a vented outer band, unit radius. */
function discGeometry(segments) {
  const geo = revolve([
    [-0.5, 0.400], [-0.5, 0.980], [-0.46, 1.0], [0.46, 1.0], [0.5, 0.980], [0.5, 0.400],
  ], segments, discUv);
  // Instanced emissive needs a per-instance colour, and three only carries one through
  // vColor when the material also declares vertex colours — so the geometry gets a
  // white colour attribute and the fragment patch below routes vColor to emissive only.
  const white = new Float32Array(geo.getAttribute('position').count * 3).fill(1);
  geo.setAttribute('color', new THREE.BufferAttribute(white, 3));
  return geo;
}

/**
 * Caliper, pad carrier and the brake-duct fairing. Built in real metres for a 132 mm
 * disc and scaled per corner; deliberately symmetric across the axle so it can be
 * shared by left and right wheels without a mirrored instance matrix.
 */
function caliperGeometry(detail) {
  const parts = [];
  const body = new THREE.BoxGeometry(0.086, 0.104, 0.046, 1, 2, 1);
  body.translate(0, 0.152, 0.030);
  parts.push(body);
  const bridge = new THREE.BoxGeometry(0.096, 0.030, 0.086, 1, 1, 1);
  bridge.translate(0, 0.176, 0.010);
  parts.push(bridge);
  if (detail >= 2) {
    for (const sx of [-0.036, 0.036]) {
      for (const sz of [-0.006, 0.056]) {
        const boss = new THREE.CylinderGeometry(0.010, 0.010, 0.098, 8);
        boss.rotateZ(Math.PI * 0.5);
        boss.translate(sx * 0.4, 0.152, sz);
        parts.push(boss);
      }
    }
  }
  // Duct fairing wrapped round the inboard face of the upright.
  const duct = new THREE.CylinderGeometry(0.148, 0.148, 0.030, detail >= 2 ? 24 : 14, 1, true);
  duct.rotateZ(Math.PI * 0.5);
  parts.push(duct);
  const scoop = new THREE.BoxGeometry(0.038, 0.120, 0.060);
  scoop.translate(0, 0.040, -0.150);
  parts.push(scoop);
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  merged.computeVertexNormals();
  return merged;
}

const _wheelGeoCache = new Map();

/**
 * The quad the contact shadow is drawn on: a unit square lying in the wheel's own XZ
 * plane, x across the tread and z along the rolling direction, with uv spanning [0,1] so
 * the material can find the middle of the patch. One buffer for the whole grid.
 */
let _contactGeo = null;

function contactGeometry() {
  if (_contactGeo) return _contactGeo;
  const geo = new THREE.PlaneGeometry(1, 1, 1, 1);
  // PlaneGeometry is authored in XY facing +Z; -90 degrees about X lays it flat with its
  // width still on X, its height on Z and its normal pointing up at the sky.
  geo.rotateX(-Math.PI * 0.5);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 3.2);
  _contactGeo = geo;
  return geo;
}

/**
 * Segments round the wheel, per detail level. 48 was not enough: at the 3 m a chase
 * camera sits from a rear tyre the silhouette is 350 px across, so a 48-gon puts a
 * 23 px flat on the outline and a critic reads facets. 72 keeps the chord error under
 * a pixel there, and the geometry is shared by all twenty cars so it costs one buffer.
 *
 * 64 is the floor at *every* level, the impostor included. The impostor is only drawn
 * beyond a hundred metres where a tyre is under 20 px across and 40 segments would be
 * plenty — but a wheel geometry is shared by all twenty cars, so raising the far level
 * costs one 975-vertex buffer for the whole grid and removes the one case where a
 * chase camera catching a backmarker mid-overtake could show a faceted silhouette.
 */
const WHEEL_SEGMENTS = [64, 64, 72];

/**
 * Carcass deflection at the contact patch, metres. Shared with the tyre materials'
 * contact-patch shader (MaterialLibrary `applyContactPatch`, whose `squash` default is
 * this same figure) so the ground shadow is exactly as long as the flat that casts it:
 * a patch of half-length sqrt(2 * R * SQUASH), which is 93 mm on a 360 mm front and
 * gives the 186 mm flat a loaded F1 slick actually measures.
 */
const CONTACT_SQUASH = 0.012;

/**
 * Contact-shadow quad extents.
 *
 * The material draws the contact patch itself across the middle `uPatch` fraction of the
 * quad and fades a penumbra out to the quad's edge, so the quad is the patch divided by
 * that fraction. These two must stay in step with `contactShadow()`'s `uPatch`, which is
 * (0.48, 0.39).
 *
 * Across the tread the flat is the tread band's own width — TREAD_HALF * 2, or 0.952 of
 * the section — so half of that over 0.48 is 0.99, and the quad is 1.98 sections wide.
 * Along the rolling direction the flat is 2 * sqrt(2 * R * CONTACT_SQUASH), which is
 * 186 mm on a 360 mm front; half of that over 0.39 gives the quad's half-length.
 */
const CONTACT_WIDTH_SCALE = (TREAD_HALF * 2) / 0.48;
const CONTACT_PATCH_V = 0.39;

/**
 * How far the shadow quad is held above the road, metres.
 *
 * Physics puts the wheel centre exactly one unloaded radius above its contact point, so
 * the road plane is known exactly — but it is known in *car-local* space, and the car
 * rolls and pitches a degree or two under load. 12 mm of lift keeps the far edge of a
 * 290 mm half-extent quad above the tarmac out to 2.4 degrees of body attitude, which is
 * more than a wing car ever runs, and 12 mm on a 360 mm tyre is invisible.
 */
const CONTACT_LIFT = 0.012;

function wheelGeometries(detail) {
  const cached = _wheelGeoCache.get(detail);
  if (cached) return cached;
  const seg = WHEEL_SEGMENTS[clamp(detail, 0, 2)];

  // Revolve winding decides which way the surface faces: a profile walked with radius
  // rising faces inboard, so the outboard sidewall is walked shoulder-to-bead and the
  // inboard one bead-to-shoulder. Get this backwards and both sidewalls vanish.
  const tread = revolve(TREAD_PROFILE, seg, treadUv);
  const left = revolve(SIDEWALL_PROFILE.map((p) => [-p[0], p[1]]), seg, sidewallUv);
  const right = revolve(SIDEWALL_PROFILE.slice().reverse(), seg, sidewallUv);
  const sidewall = mergeGeometries([left, right], false);
  left.dispose();
  right.dispose();

  // Every level keeps tread, sidewall and rim on their own materials. Collapsing the
  // impostor onto one black rubber material is what turned the back of the field into
  // floating black blocks: the compound band and the rim flange are the two high
  // contrast features that say "wheel" at a hundred metres, and it threw both away.
  let rim;
  if (detail === 0) {
    rim = revolve(RIM_PROFILE_FAR, seg, rimUv);
  } else {
    const barrel = revolve(RIM_PROFILE, seg, rimUv);
    // Radial ribs across the aero cover. Without a feature that repeats around the
    // wheel there is nothing for the motion-blur pass to smear, and a spinning wheel
    // reads as a static disc however fast the car is going.
    const ribs = [];
    const ribCount = detail >= 2 ? 10 : 6;
    for (let i = 0; i < ribCount; i++) {
      const rib = new THREE.BoxGeometry(0.016, 0.026, 0.400);
      rib.translate(0.398, 0, 0.250);
      rib.rotateX((i / ribCount) * Math.PI * 2);
      ribs.push(rib);
      // Inboard spoke webbing. The inboard face of RIM_PROFILE is a flat annulus from
      // the disc opening out to the bead, and a flat annulus of one metal reflects one
      // thing: whatever is inboard of it, which is the underside of the car. That is why
      // the hub read as a featureless dark disc from a chase camera even though the rim
      // is a 0.26-roughness conductor. Spokes give the annulus a second set of normals,
      // so part of the hub always faces up into the sky and the wheel reads as machined
      // metal with a brake inside it rather than as a hole in the tyre.
      const spoke = new THREE.BoxGeometry(0.018, 0.022, 0.220);
      spoke.translate(-0.436, 0, 0.490);
      spoke.rotateX(((i + 0.5) / ribCount) * Math.PI * 2);
      ribs.push(spoke);
    }
    rim = mergeGeometries([barrel, ...ribs], false);
    barrel.dispose();
    for (const r of ribs) r.dispose();
    rim.computeVertexNormals();
  }
  // Discs from the mid level up: an 18-inch rim leaves a 180 mm opening on the inboard
  // face, and at 40-150 m an empty one reads as a hole punched through the car. The
  // caliper stays a hero-only part — it is 90 mm of metal tucked behind the disc, and it
  // is not worth a draw call on a car the width of a thumbnail.
  const disc = detail >= 1 ? discGeometry(detail >= 2 ? Math.max(24, seg >> 1) : 18) : null;
  const caliper = detail >= 2 ? caliperGeometry(detail) : null;

  // One generous bound per shared geometry: the instances sit up to 1.2 m from the car
  // origin, so culling stays correct without recomputing instance bounds every frame.
  const bounds = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 3.2);
  for (const g of [tread, sidewall, rim, disc, caliper]) {
    if (g) g.boundingSphere = bounds.clone();
  }

  const set = { tread, sidewall, rim, disc, caliper, segments: seg };
  _wheelGeoCache.set(detail, set);
  return set;
}

export function disposeSharedWheelGeometry() {
  for (const set of _wheelGeoCache.values()) {
    for (const key of ['tread', 'sidewall', 'rim', 'disc', 'caliper']) set[key]?.dispose();
  }
  _wheelGeoCache.clear();
  _contactGeo?.dispose();
  _contactGeo = null;
}

/**
 * Carbon-carbon glow, pinned to the brief's ramp: nothing below 400 C, a dull red just
 * above it, a hard orange by 1000 C.
 *
 * `t` is the normalised position in that 400..1000 C window and the exponent is 1.25,
 * not the 1.7 this used to carry. 1.7 put the disc at 0.3 % of full emission a hundred
 * degrees into the window — black on screen when the spec says dull red — because the
 * old ramp also started at 380 C and then buried its own onset. 1.25 has the disc
 * visibly red by 500 C and cherry by 700 C, which is where a carbon disc actually is.
 *
 * The green and blue terms rise with t^2 and t^3, so the hue walks red -> cherry ->
 * orange as it brightens instead of turning orange the instant it lights up. At 1000 C
 * the emissive colour is (1.00, 0.55, 0.12): a hard orange, not white.
 */
function glowColor(celsius, out) {
  const t = clamp01((celsius - 400) / 600);
  const i = Math.pow(t, 1.25);
  out.setRGB(i, i * (0.06 + 0.49 * t * t), i * (0.005 + 0.115 * t * t * t));
  return out;
}

export class WheelSet {
  /**
   * @param {object} ctx shared context (needs `materials`)
   * @param {object} spec { detail, compound, front:{radius,width}, rear:{radius,width},
   *                        discRadiusFront, discRadiusRear }
   */
  constructor(ctx, spec) {
    const detail = clamp(spec.detail ?? 2, 0, 2);
    this.detail = detail;
    this.ctx = ctx;
    this.materials = ctx.materials ?? null;
    this.group = new THREE.Group();
    this.group.name = 'wheels';

    this.radius = [spec.front.radius, spec.front.radius, spec.rear.radius, spec.rear.radius];
    this.width = [spec.front.width, spec.front.width, spec.rear.width, spec.rear.width];
    this.discRadius = [
      spec.discRadiusFront, spec.discRadiusFront, spec.discRadiusRear, spec.discRadiusRear,
    ];

    const geo = wheelGeometries(detail);
    this._ownedMaterials = [];

    const treadMat = this.materials?.get('tyre_rubber') ?? new THREE.MeshStandardMaterial({ color: 0x1a1a1e, roughness: 0.9 });
    this._sidewallMat = this.materials?.tyreSidewall?.(spec.compound ?? 'medium')
      ?? this.materials?.get('tyre_sidewall')
      ?? treadMat;
    const rimMat = this.materials?.get('wheel_rim') ?? new THREE.MeshStandardMaterial({ color: 0x8d949c, metalness: 1, roughness: 0.35 });

    // The tread casts at every level, the impostor included. Four tyre shadows is one
    // extra shadow-map draw for a distant car and it is what puts the car on the road
    // instead of hovering over it — the single cheapest cue at a hundred metres.
    this.tread = this._instanced(geo.tread, treadMat, true);
    this.sidewall = geo.sidewall ? this._instanced(geo.sidewall, this._sidewallMat, detail >= 1) : null;
    this.rim = geo.rim ? this._instanced(geo.rim, rimMat, detail >= 1) : null;

    if (geo.disc) {
      this.disc = this._instanced(geo.disc, this._brakeMaterial(), false);
      this.disc.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(12), 3);
      this.disc.instanceColor.setUsage(THREE.DynamicDrawUsage);
      const caliperMat = this.materials?.get('brake_caliper') ?? new THREE.MeshStandardMaterial({ color: 0x3c4046, metalness: 1, roughness: 0.4 });
      this.caliper = geo.caliper ? this._instanced(geo.caliper, caliperMat, true) : null;
    } else {
      this.disc = null;
      this.caliper = null;
    }

    // Ground contact shadow. Drawn at every detail level: it is one instanced draw call
    // with two triangles in it, and it is the cue that decides whether a car is standing
    // on the circuit or hovering over it — which matters as much for the twentieth car
    // on the horizon as it does for the player's own front tyre.
    const contactMat = this.materials?.contactShadow?.() ?? null;
    if (contactMat) {
      const mesh = new THREE.InstancedMesh(contactGeometry(), contactMat, 4);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      // After the racing line, which is an alpha-blended decal on the same tarmac: the
      // occlusion has to multiply the line as well as the surfacing either side of it,
      // and a transparent pass sorted by distance alone puts the two in arbitrary order.
      mesh.renderOrder = 1;
      this.group.add(mesh);
      this.contact = mesh;
    } else {
      this.contact = null;
    }
    // Quad extents per corner, precomputed: `setWheel` runs four times a frame per car
    // and must not do arithmetic it can do once.
    this._contactScale = new Float32Array(8);
    for (let i = 0; i < 4; i++) {
      this._contactScale[i * 2] = this.width[i] * CONTACT_WIDTH_SCALE;
      this._contactScale[i * 2 + 1] =
        (2 * Math.sqrt(2 * this.radius[i] * CONTACT_SQUASH)) / CONTACT_PATCH_V;
    }

    this._brakeTemp = new Float32Array(4);
    this._dirtyGlow = true;
  }

  _instanced(geometry, material, castShadow) {
    const mesh = new THREE.InstancedMesh(geometry, material, 4);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = castShadow;
    // Every part of the wheel receives. A wheel that casts but does not receive is lit
    // as though nothing on the car were above it, so the tyre stays at full daylight
    // value under the floor, under the front wing and under its own shoulder — and a
    // tyre that never darkens where the car overhangs it is the specific thing that
    // makes a car read as pasted on to the photograph rather than standing in it.
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    this.group.add(mesh);
    return mesh;
  }

  /**
   * The library's brake_disc material already carries the drilled-face maps; this clone
   * reroutes the instance colour away from albedo and into emission, so four discs on
   * one draw call can each glow at their own temperature.
   */
  _brakeMaterial() {
    const base = this.materials?.clone?.('brake_disc');
    const mat = base ?? new THREE.MeshStandardMaterial({
      color: 0x1b1c20, metalness: 0.6, roughness: 0.55,
      emissive: new THREE.Color(0xffffff), emissiveIntensity: 3.2,
    });
    mat.vertexColors = true;
    mat.emissive.setRGB(1, 1, 1);
    mat.emissiveIntensity = mat.userData?.emissiveIntensityHot ?? 3.2;
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <color_fragment>', '')
        .replace(
          '#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;',
        );
    };
    mat.customProgramCacheKey = () => 'apex_brake_glow';
    mat.needsUpdate = true;
    if (!base) this._ownedMaterials.push(mat);
    return mat;
  }

  setCompound(name) {
    if (!this.sidewall) return;
    const mat = this.materials?.tyreSidewall?.(name);
    if (mat && mat !== this._sidewallMat) {
      this._sidewallMat = mat;
      this.sidewall.material = mat;
    }
  }

  /**
   * Place one corner. `position` is car-local, `steer`/`camber`/`spin` are the published
   * wheel angles; the wheel's own quaternion is rebuilt here so the caliper can share
   * the steer and camber without inheriting the spin.
   */
  setWheel(i, position, steer, camber, spin) {
    const flip = IS_LEFT[i];
    const r = this.radius[i];
    const w = this.width[i];

    _q.setFromAxisAngle(_axisY, -steer);

    // Contact shadow, before camber joins the chain: the patch is pressed into the road
    // by the whole tyre and lies in the road plane, so it turns with the steering and
    // with nothing else. Physics places the wheel centre exactly one unloaded radius
    // above its contact point (VehiclePhysics `_castWheels` rays with `tyre.spec.radius`),
    // which is what makes `position.y - r` the road plane rather than a guess at it.
    if (this.contact) {
      _p.set(position.x, position.y - r + CONTACT_LIFT, position.z);
      _s.set(this._contactScale[i * 2], 1, this._contactScale[i * 2 + 1]);
      _m.compose(_p, _q, _s);
      this.contact.setMatrixAt(i, _m);
    }

    _qb.setFromAxisAngle(_axisZ, -camber);
    _q.multiply(_qb);
    if (this.caliper) {
      _s.set(this.discRadius[i] / 0.132, this.discRadius[i] / 0.132, this.discRadius[i] / 0.132);
      _m.compose(position, _q, _s);
      this.caliper.setMatrixAt(i, _m);
    }
    if (this.disc) {
      _s.set(0.030, this.discRadius[i], this.discRadius[i]);
      _qb.setFromAxisAngle(_axisX, -spin);
      _q.multiply(_qb);
      if (flip) _q.multiply(_flip);
      _m.compose(position, _q, _s);
      this.disc.setMatrixAt(i, _m);
    } else {
      _qb.setFromAxisAngle(_axisX, -spin);
      _q.multiply(_qb);
      if (flip) _q.multiply(_flip);
    }

    _s.set(w, r, r);
    _m.compose(position, _q, _s);
    this.tread.setMatrixAt(i, _m);
    if (this.sidewall) this.sidewall.setMatrixAt(i, _m);
    if (this.rim) this.rim.setMatrixAt(i, _m);
  }

  setBrakeTemp(i, celsius) {
    if (this._brakeTemp[i] !== celsius) {
      this._brakeTemp[i] = celsius;
      this._dirtyGlow = true;
    }
  }

  /** Flush the instance buffers. Called once per frame after all four corners are set. */
  commit() {
    this.tread.instanceMatrix.needsUpdate = true;
    if (this.sidewall) this.sidewall.instanceMatrix.needsUpdate = true;
    if (this.rim) this.rim.instanceMatrix.needsUpdate = true;
    if (this.contact) this.contact.instanceMatrix.needsUpdate = true;
    if (this.disc) {
      this.disc.instanceMatrix.needsUpdate = true;
      if (this.caliper) this.caliper.instanceMatrix.needsUpdate = true;
      if (this._dirtyGlow) {
        for (let i = 0; i < 4; i++) {
          glowColor(this._brakeTemp[i], _c);
          this.disc.setColorAt(i, _c);
        }
        this.disc.instanceColor.needsUpdate = true;
        this._dirtyGlow = false;
      }
    }
  }

  setVisible(v) {
    this.group.visible = v;
  }

  dispose() {
    for (const m of this._ownedMaterials) m.dispose();
    this._ownedMaterials.length = 0;
    for (const child of this.group.children) {
      if (child.isInstancedMesh) child.dispose();
    }
    this.group.clear();
  }
}

export { glowColor };
