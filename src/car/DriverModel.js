import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  createCanvas, textureFromCanvas, makeDataTexture, mipChain, normalMipChain, applyToksvig,
} from '../render/textures/NoiseTextures.js';
import { buildNomex, buildGloveLeather } from '../render/textures/CarTextures.js';
import { clamp, clamp01, DEG } from '../core/MathUtils.js';

/**
 * The driver: a helmet and shoulders for the cars you look at, and arms, gloves and
 * knees for the car you sit in.
 *
 * The helmet is a shell with the visor aperture painted into the texture and a real
 * curved visor floated over it, which is how it reads correctly from every angle
 * without cutting a hole in the mesh. The arms are a two-bone analytic IK chain: the
 * hands are placed exactly on the wheel rim by the cockpit, and the elbows fall out of
 * the solve with a downward-and-outward pole so they never invert.
 */

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _bend = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _UP = new THREE.Vector3(0, 1, 0);

const HELMET_RADIUS = 0.132;

function css(hex) {
  return `#${(hex >>> 0).toString(16).padStart(6, '0')}`;
}

/**
 * Equirectangular helmet paint. The sphere's u = 0.75 meridian faces -Z (forward in the
 * car frame), so the aperture, chin bar and brow all key off that.
 */
function drawHelmet(c, w, h, helmet, driver) {
  const base = css(helmet.base);
  const trim = css(helmet.trim);
  const mark = css(helmet.mark);
  c.fillStyle = base;
  c.fillRect(0, 0, w, h);

  const front = w * 0.75;
  switch (helmet.pattern) {
    case 'chevron': {
      c.fillStyle = trim;
      for (let k = -1; k <= 1; k++) {
        c.beginPath();
        c.moveTo(front + k * w * 0.5 - w * 0.16, 0);
        c.lineTo(front + k * w * 0.5, h * 0.42);
        c.lineTo(front + k * w * 0.5 + w * 0.16, 0);
        c.lineTo(front + k * w * 0.5 + w * 0.07, 0);
        c.lineTo(front + k * w * 0.5, h * 0.26);
        c.lineTo(front + k * w * 0.5 - w * 0.07, 0);
        c.closePath();
        c.fill();
      }
      break;
    }
    case 'bands':
      c.fillStyle = trim;
      c.fillRect(0, h * 0.16, w, h * 0.10);
      c.fillStyle = mark;
      c.fillRect(0, h * 0.28, w, h * 0.045);
      break;
    case 'halves':
      c.fillStyle = trim;
      c.fillRect(0, 0, w, h * 0.5);
      break;
    case 'blade':
      c.fillStyle = trim;
      c.beginPath();
      c.moveTo(0, h * 0.10);
      c.lineTo(w, h * 0.02);
      c.lineTo(w, h * 0.34);
      c.lineTo(0, h * 0.44);
      c.closePath();
      c.fill();
      break;
    case 'star': {
      c.fillStyle = trim;
      c.fillRect(0, h * 0.02, w, h * 0.14);
      c.fillStyle = mark;
      for (let k = 0; k < 6; k++) {
        const cx = (k + 0.5) * (w / 6);
        c.beginPath();
        for (let s = 0; s < 10; s++) {
          const a = (s / 10) * Math.PI * 2 - Math.PI * 0.5;
          const r = (s % 2 === 0 ? h * 0.075 : h * 0.032);
          const px = cx + Math.cos(a) * r;
          const py = h * 0.30 + Math.sin(a) * r;
          if (s === 0) c.moveTo(px, py); else c.lineTo(px, py);
        }
        c.closePath();
        c.fill();
      }
      break;
    }
    case 'rising': {
      c.fillStyle = trim;
      c.beginPath();
      c.arc(front, h * 0.30, h * 0.20, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = mark;
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        c.save();
        c.translate(front, h * 0.30);
        c.rotate(a);
        c.fillRect(h * 0.20, -h * 0.014, h * 0.13, h * 0.028);
        c.restore();
      }
      break;
    }
    case 'wave': {
      c.fillStyle = trim;
      c.beginPath();
      c.moveTo(0, h * 0.34);
      for (let x = 0; x <= w; x += w / 40) c.lineTo(x, h * (0.34 - 0.09 * Math.sin((x / w) * Math.PI * 4)));
      c.lineTo(w, 0);
      c.lineTo(0, 0);
      c.closePath();
      c.fill();
      break;
    }
    default:
      c.fillStyle = trim;
      c.fillRect(0, h * 0.20, w, h * 0.16);
      break;
  }

  // Visor aperture: a dark wrap-around band with a brow above it.
  const apertureTop = h * 0.42;
  const apertureBottom = h * 0.66;
  c.fillStyle = '#08090c';
  c.beginPath();
  c.moveTo(0, apertureTop + h * 0.06);
  for (let x = 0; x <= w; x += w / 64) {
    const d = Math.abs(((x / w) - 0.75 + 1.5) % 1 - 0.5) * 2;
    c.lineTo(x, apertureTop + h * 0.075 * Math.pow(clamp01(d * 1.35), 2.2));
  }
  c.lineTo(w, apertureBottom);
  c.lineTo(0, apertureBottom);
  c.closePath();
  c.fill();

  // Chin bar and the FIA-mandated frontal-protection strip above the aperture.
  c.fillStyle = mark;
  c.fillRect(0, apertureTop - h * 0.035, w, h * 0.032);
  c.fillStyle = '#16171c';
  c.fillRect(0, apertureBottom, w, h * 0.055);

  c.fillStyle = css(driver.team.colors.accent);
  c.fillRect(0, h * 0.86, w, h * 0.06);

  c.save();
  c.translate(front, h * 0.79);
  c.fillStyle = '#f2f4f7';
  c.font = `800 ${Math.round(h * 0.055)}px system-ui, Arial, sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(driver.code, 0, 0);
  c.restore();

  const shade = c.createLinearGradient(0, 0, 0, h);
  shade.addColorStop(0, 'rgba(255,255,255,0.10)');
  shade.addColorStop(0.55, 'rgba(0,0,0,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.28)');
  c.fillStyle = shade;
  c.fillRect(0, 0, w, h);
}

/** Shell, aero fin, chin scoop and the collar the helmet sits on. */
function helmetGeometry(detail) {
  const seg = detail >= 2 ? 32 : 16;
  const rings = detail >= 2 ? 22 : 12;
  const shell = new THREE.SphereGeometry(HELMET_RADIUS, seg, rings);
  shell.scale(1.0, 1.06, 1.14);
  shell.translate(0, 0, 0.008);
  const parts = [shell];

  const chin = new THREE.SphereGeometry(HELMET_RADIUS * 0.72, seg, Math.max(8, rings >> 1), 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.40);
  chin.scale(1.0, 1.0, 1.30);
  chin.translate(0, -0.036, -0.020);
  parts.push(chin);

  if (detail >= 2) {
    const fin = new THREE.BoxGeometry(0.016, 0.028, 0.130);
    fin.translate(0, HELMET_RADIUS * 1.03, 0.052);
    parts.push(fin);
    const scoop = new THREE.CylinderGeometry(0.020, 0.026, 0.030, 10);
    scoop.rotateX(Math.PI * 0.5);
    scoop.translate(0, 0.030, -HELMET_RADIUS * 1.02);
    parts.push(scoop);
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  merged.computeVertexNormals();
  return merged;
}

function visorGeometry(detail) {
  const g = new THREE.SphereGeometry(
    HELMET_RADIUS * 1.012, detail >= 2 ? 28 : 14, detail >= 2 ? 12 : 7,
    Math.PI * 1.5 - 1.10, 2.20, Math.PI * 0.40, 0.52,
  );
  g.scale(1.0, 1.06, 1.14);
  g.translate(0, 0, 0.008);
  return g;
}

/**
 * Torso above the cockpit rim: shoulders, the HANS collar and the top of the harness.
 * Only the part that clears the tub is modelled — nothing below it is ever visible.
 */
function bustGeometry(detail) {
  const seg = detail >= 2 ? 20 : 10;
  const parts = [];
  const torso = new THREE.SphereGeometry(0.185, seg, seg, 0, Math.PI * 2, 0, Math.PI * 0.55);
  torso.scale(1.30, 0.86, 0.92);
  torso.translate(0, -0.030, 0.010);
  parts.push(torso);
  for (const s of [1, -1]) {
    const arm = new THREE.SphereGeometry(0.072, Math.max(8, seg >> 1), Math.max(8, seg >> 1));
    arm.scale(1.0, 0.9, 1.5);
    arm.translate(s * 0.205, -0.055, -0.050);
    parts.push(arm);
  }
  const hans = new THREE.TorusGeometry(0.115, 0.024, 8, Math.max(10, seg), Math.PI);
  hans.rotateX(Math.PI * 0.5);
  hans.rotateY(Math.PI);
  hans.translate(0, 0.018, 0.010);
  parts.push(hans);
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  merged.computeVertexNormals();
  merged.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 0.6);
  return merged;
}

const _sharedDriver = new Map();

function sharedGeometry(detail) {
  const cached = _sharedDriver.get(detail);
  if (cached) return cached;
  const set = {
    helmet: helmetGeometry(detail),
    visor: visorGeometry(detail),
    bust: bustGeometry(detail),
  };
  _sharedDriver.set(detail, set);
  return set;
}

export function disposeSharedDriverGeometry() {
  for (const set of _sharedDriver.values()) {
    set.helmet.dispose();
    set.visor.dispose();
    set.bust.dispose();
  }
  _sharedDriver.clear();
}

const _helmetMaterials = new Map();

/** Helmet paint for one driver, cached across every car that shows them. */
export function helmetMaterial(driver, quality) {
  const cached = _helmetMaterials.get(driver.code);
  if (cached) return cached;
  const w = Math.max(256, Math.round(768 * (quality?.textureScale ?? 1)));
  const h = w >> 1;
  const canvas = createCanvas(w, h);
  drawHelmet(canvas.getContext('2d'), w, h, driver.helmet, driver);
  const tex = textureFromCanvas(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  const mat = new THREE.MeshPhysicalMaterial({
    map: tex,
    roughness: 0.24,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.026,
    envMapIntensity: 1.6,
  });
  mat.userData.texture = tex;
  _helmetMaterials.set(driver.code, mat);
  return mat;
}

export function disposeHelmetMaterials() {
  for (const m of _helmetMaterials.values()) {
    m.userData.texture?.dispose();
    m.dispose();
  }
  _helmetMaterials.clear();
}

/**
 * Helmet + shoulders, parented into a car. `anchor` is the helmet centre in car-local
 * coordinates; the bust is dropped below it by a fixed neck length.
 */
export class DriverBust {
  constructor(ctx, driver, livery, detail = 2, anchor = [0, 0.48, -0.23]) {
    const geo = sharedGeometry(clamp(detail, 1, 2));
    this.group = new THREE.Group();
    this.group.name = 'driver';
    this.group.position.set(anchor[0], anchor[1], anchor[2]);

    this.head = new THREE.Object3D();
    this.group.add(this.head);

    this.helmet = new THREE.Mesh(geo.helmet, helmetMaterial(driver, ctx.quality));
    this.helmet.castShadow = detail >= 2;
    this.head.add(this.helmet);

    const visorMat = detail >= 2 && ctx.materials?.get
      ? ctx.materials.get('visor_glass')
      : new THREE.MeshStandardMaterial({ color: 0x101820, roughness: 0.12, metalness: 0.4 });
    this._ownVisorMaterial = !(detail >= 2 && ctx.materials?.get);
    this.visor = new THREE.Mesh(geo.visor, visorMat);
    this.visor.renderOrder = 2;
    this.head.add(this.visor);

    this.bust = new THREE.Mesh(geo.bust, livery.suit);
    this.bust.position.set(0, -0.185, 0.055);
    this.bust.castShadow = detail >= 2;
    this.group.add(this.bust);
  }

  /** Drivers brace against lateral load: the head leans into the corner, not with it. */
  setHeadLean(lateralG, longitudinalG) {
    this.head.rotation.z = clamp(-lateralG * 0.055, -0.14, 0.14);
    this.head.rotation.x = clamp(longitudinalG * 0.020, -0.06, 0.06);
  }

  setVisible(v) {
    this.group.visible = v;
  }

  dispose() {
    if (this._ownVisorMaterial) this.visor.material.dispose();
    this.group.clear();
  }
}

// --- articulated arms ----------------------------------------------------------------

/**
 * Tapered limb of unit length along +Y, so one geometry serves both bones. The chain
 * puts y = 0 at the proximal joint, so `rRoot` is the shoulder or elbow end and it is
 * the larger of the two — an arm that thickens toward the wrist reads as a balloon.
 */
function limbGeometry(rRoot, rTip, detail) {
  // 24 sides, not 16: at arm's length a forearm is ~120 px across, and 16 shows the
  // driver eight flat facets down the inside of his own sleeve.
  const seg = detail >= 2 ? 24 : 8;
  const g = new THREE.CylinderGeometry(rTip, rRoot, 1, seg, 3, false);
  g.translate(0, 0.5, 0);
  // Nomex tiles at roughly 200 mm; a bare cylinder UV would stretch one tile over the
  // whole limb and turn the weave into upholstery. Left at the tuned value: the suit's
  // seam family rides the same UVs, and 1.7 by 1.5 is what puts two flat-felled seams
  // round a sleeve rather than ten. What was making the sleeve read as knitted rope is
  // the depth of the weave, not its pitch, and that is dealt with on the material — see
  // cockpitSuitMaterial.
  scaleUv(g, 1.7, 1.5);
  return g;
}

/** Multiply a geometry's UVs so a shared tiling material lands at its real scale. */
function scaleUv(geo, su, sv) {
  const uv = geo.getAttribute('uv');
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geo;
}

/**
 * Flip a geometry through x = 0, including the triangle winding it inverts.
 */
function mirrorX(geo) {
  // applyMatrix4 already runs the normals through the inverse transpose, so only the
  // winding is left to fix; without it every mirrored face is backface-culled.
  geo.scale(-1, 1, 1);
  const index = geo.getIndex();
  if (index) {
    const a = index.array;
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i];
      a[i] = a[i + 2];
      a[i + 2] = t;
    }
    index.needsUpdate = true;
  }
  return geo;
}

// --- the driver's gloves --------------------------------------------------------------

/**
 * Racing glove, authored for the right hand in exactly the frame the cockpit hands it:
 * +X runs across the knuckles from the index finger to the little finger, +Y up the
 * forearm toward the elbow, and +Z out of the back of the hand. The left glove is this
 * one mirrored through x = 0, because a right hand rotated onto the left grip still has
 * its thumb on the wrong side of the rim.
 *
 * Nothing here is a primitive bolted to another primitive. The hand, the wrist and the
 * cuff are ONE swept solid: a rounded-rectangle section lofted from the cuff hem down to
 * the knuckle line, going from a 92 mm circle round the sleeve, through a 64 mm wrist, to
 * an 80 x 31 mm slab across the metacarpals. So there is no seam to open at the wrist, no
 * sphere-to-cylinder
 * facet anywhere on the silhouette, and one place — HAND_LOFT — where the whole shape of
 * the hand can be read. The fingers and the thumb are swept tubes with a live radius, and
 * the knuckle guard, the back padding, the leather palm and the wrist strap are offset
 * shells OF THE LOFT ITSELF, so every panel lies exactly on the hand at every level of
 * detail instead of floating a millimetre off it.
 *
 * The glove this replaces failed for one measurable reason. Its palm was a 100 mm
 * ellipsoid whose front face stood 29 mm proud, in +Z, of the outermost point of the arc
 * its fingers were swept on. The driver's eye sits at (0.09, 0.30, 0.95) in this frame,
 * so every finger was behind the palm from every cockpit camera and the hand rendered as
 * one smooth red blob — the "mitten with a knuckle decal" the reviews kept naming. Here
 * the loft falls away below the knuckle line (HAND_LOFT's last four stations) and the
 * fingers stand proud of it from y = -0.020 downward: about 30 mm of every finger, all
 * four knuckles and the three grooves between them are in front of the hand mass.
 *
 * Five material groups come out, in this order, and the order is the contract with
 * `gloveMaterials`:
 *
 *   0 FABRIC  the aramid knit — hand, wrist, cuff, fingers, thumb, back padding
 *   1 PALM    the leather patch across the palm and round the silhouette
 *   2 GUARD   the moulded knuckle protector, in black, because a real one is TPU
 *   3 ACCENT  the wrist strap, the one piece that carries the team colour
 *   4 STITCH  the topstitching along the cuff, the palm patch and the padding
 */

/**
 * Metres of glove per tile of the fabric maps.
 *
 * The UVs of every piece here are generated in real units and divided by this, so the
 * weave lands at one known pitch over the whole glove instead of at whatever each
 * primitive's own wrap happened to give — which is what put a moire crosshatch over the
 * first pass and a thread pitch that changed between the cuff and the palm over the
 * second. 30 mm against the map's authored 26 threads is a 1.15 mm thread, three pixels
 * at the range a cockpit camera sees the back of the hand from: fine enough not to read
 * as netting, coarse enough to survive the mip chain.
 */
const GLOVE_TILE = 0.030;

/**
 * The rim, in glove-local metres, and the arc the fingers close around it.
 *
 * The cockpit pins the glove's origin to the grip point and the rim tube's axis then
 * falls 15 mm below it and 26 mm in front of it — solved off the wheel pivot and the
 * grip anchor, not guessed. The grip section is a 49 x 40 mm ellipse, so the finger centreline arc is
 * elliptical too: 37.5 mm across the rim and 33.5 mm through it puts a 12 mm finger on
 * the rubber all the way round instead of biting into it at the sides.
 */
const RIM_CENTRE_Y = -0.0150;
const RIM_CENTRE_Z = -0.0258;
const FINGER_ARC_Y = 0.0375;
const FINGER_ARC_Z = 0.0335;

/**
 * The hand, station by station along the wrist axis:
 * [y, z of the section centre, half width across the knuckles, half depth through the
 *  hand, corner rounding as a fraction of the smaller half-extent].
 *
 * The first four stations are the rolled cuff hem. It opens to 92 mm at the crown and
 * then closes back to 57 mm, so the 52 mm suit sleeve comes out of a hem that is gripping
 * it rather than out of the middle of a flat 83 mm plate — which, at the lock
 * cockpit-apex holds, the driver is looking straight down the axis of. The middle of
 * the list is a real wrist — it necks to 64 mm — because a bend cannot be put through a
 * section wider than its own radius of curvature without folding it. The last four fall
 * away fast, in depth and in z, so the fingers below the knuckle line have nothing in
 * front of them.
 */
const HAND_LOFT = [
  [0.0840, 0.0000, 0.0286, 0.0286, 1.00],
  [0.0834, 0.0000, 0.0330, 0.0330, 1.00],
  [0.0822, 0.0000, 0.0374, 0.0374, 1.00],
  [0.0800, 0.0002, 0.0416, 0.0416, 1.00],
  [0.0760, 0.0004, 0.0446, 0.0446, 1.00],
  [0.0690, 0.0008, 0.0458, 0.0454, 1.00],
  [0.0620, 0.0014, 0.0452, 0.0442, 1.00],
  [0.0540, 0.0022, 0.0432, 0.0416, 1.00],
  [0.0455, 0.0032, 0.0392, 0.0374, 1.00],
  [0.0375, 0.0042, 0.0344, 0.0330, 1.00],
  [0.0290, 0.0052, 0.0322, 0.0302, 1.00],
  [0.0200, 0.0062, 0.0320, 0.0282, 1.00],
  [0.0110, 0.0070, 0.0342, 0.0250, 1.00],
  [0.0020, 0.0078, 0.0368, 0.0212, 0.98],
  [-0.0070, 0.0080, 0.0398, 0.0182, 0.96],
  [-0.0150, 0.0080, 0.0400, 0.0154, 0.94],
  [-0.0228, 0.0044, 0.0370, 0.0114, 0.92],
  [-0.0290, -0.0012, 0.0316, 0.0070, 0.90],
  [-0.0332, -0.0074, 0.0244, 0.0030, 0.90],
];

/**
 * The four fingers: x station on the rim, the arc angle its knuckle sits at, the angle
 * its tip reaches, and the radius at the knuckle and at the tip. Angle 0 is the face of
 * the rim nearest the driver; the angle grows downward and round the far side, so a
 * sweep of 2.8 rad is a 104 mm finger closed on a 49 mm tube. The index reaches furthest
 * round, the little finger least, which is what breaks the fingertips into a line rather
 * than a fringe.
 */
const FINGERS = [
  [-0.0315, 0.045, 2.62, 0.0126, 0.0092],
  [-0.0105, 0.020, 2.80, 0.0130, 0.0095],
  [0.0105, 0.060, 2.66, 0.0121, 0.0089],
  [0.0300, 0.190, 2.40, 0.0106, 0.0080],
];

/** Thumb centreline, hooked up over the near face of the rim past the index finger. */
const THUMB_PATH = [
  [-0.0060, 0.0250, -0.0020, 0.0166],
  [-0.0320, 0.0090, 0.0095, 0.0170],
  [-0.0505, -0.0065, 0.0135, 0.0138],
  [-0.0632, -0.0198, 0.0082, 0.0116],
  [-0.0700, -0.0312, -0.0022, 0.0096],
];

/**
 * The wrist.
 *
 * A hand closed on the rim at quarter to three is NOT square to the forearm. The cockpit
 * builds the glove's frame from the rim tangent and the elbow, and the angle between
 * those two, measured off the live rig, is 41 degrees on the straight and 32 to 44
 * degrees at the lock cockpit-apex holds. The old glove had no wrist at all: hand and
 * cuff were one straight tube, so the frame had to split the difference, which left the
 * cuff 20 degrees off the sleeve it is supposed to seal against. Over a 90 mm cuff that
 * is 33 mm of offset — the suit sleeve came out through the SIDE of the cuff, and the
 * cuff's own end face stood proud in the middle of the lower frame in every cockpit shot
 * since round 1.
 *
 * So the wrist bends, here, in the mesh: the loft's spine turns through WRIST_BEND
 * between BEND_Y0 and BEND_Y1, and the whole glove is then rolled back by half of it, so
 * the hand comes out on the rim and the cuff comes out on the forearm at the same time.
 * The half is the same half Cockpit's `_updateHands` rolls the grip frame by; the two
 * numbers are one contract and neither can move without the other.
 * The residual at the three steering angles the review captures is 3.3, 1.0 and 5.1
 * degrees, and the measured worst case of the sleeve against the cuff wall goes from
 * 24 mm of the sleeve standing outside the old cuff to 0.5 mm at the hem lip. Everything below BEND_Y0 — the fingers, the knuckles, the guard — is
 * untouched by the bend and stays exactly where it was authored on the rim.
 */
const WRIST_BEND = 34 * DEG;
const WRIST_ROLL = 17 * DEG;
const BEND_Y0 = 0.0020;
const BEND_Y1 = 0.0380;
const BEND_STEPS = 48;

/**
 * How much of the turn is done at u.
 *
 * Curvature is a trapezoid — a quarter of the run easing in, half at a constant rate, a
 * quarter easing out — which peaks at 4/3 of the mean where a smoothstep peaks at 3/2.
 * That matters: the tightest radius the bend reaches has to stay larger than the hand's
 * own half width, or the inside of the wrist folds back through itself. At 34 degrees
 * over 36 mm the peak radius is 45 mm against a 32 mm half width, so the inside gathers
 * to 30 per cent of its length — a crease, which is what a bent wrist does — instead of
 * inverting.
 */
function bendProfile(u) {
  const h = 4 / 3;
  if (u < 0.25) return h * u * u * 2;
  if (u > 0.75) {
    const v = u - 0.75;
    return h * (0.125 + 0.5 + v - v * v * 2);
  }
  return h * (0.125 + (u - 0.25));
}

/** Spine of the bend: arc length y, its turned angle, and where it has got to. */
const _bendAngle = new Float64Array(BEND_STEPS + 1);
const _bendX = new Float64Array(BEND_STEPS + 1);
const _bendY = new Float64Array(BEND_STEPS + 1);
let _bendReady = false;

function buildBendSpine() {
  if (_bendReady) return;
  const h = (BEND_Y1 - BEND_Y0) / BEND_STEPS;
  _bendX[0] = 0;
  _bendY[0] = BEND_Y0;
  _bendAngle[0] = 0;
  for (let i = 1; i <= BEND_STEPS; i++) {
    const a0 = _bendAngle[i - 1];
    const a1 = -WRIST_BEND * bendProfile(i / BEND_STEPS);
    _bendAngle[i] = a1;
    // Trapezoid on a unit-speed tangent, so the spine keeps the loft's arc length and
    // the cuff does not grow or shrink as the bend is tuned.
    _bendX[i] = _bendX[i - 1] + h * 0.5 * (-Math.sin(a0) - Math.sin(a1));
    _bendY[i] = _bendY[i - 1] + h * 0.5 * (Math.cos(a0) + Math.cos(a1));
  }
  _bendReady = true;
}

/**
 * Bend a finished glove about its wrist, then roll it back by half the bend.
 *
 * Below BEND_Y0 nothing moves at all. Through the bend each vertex is carried on the
 * spine and rotated with it; above BEND_Y1 the spine runs straight, which is what makes
 * the cuff a true cylinder round the sleeve rather than a cone flaring off it.
 */
function bendAtWrist(geo) {
  buildBendSpine();
  const pos = geo.getAttribute('position');
  const h = (BEND_Y1 - BEND_Y0) / BEND_STEPS;
  const cr = Math.cos(WRIST_ROLL);
  const sr = Math.sin(WRIST_ROLL);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    let bx = x;
    let by = y;
    if (y > BEND_Y0) {
      let sxv;
      let syv;
      let ang;
      if (y >= BEND_Y1) {
        ang = _bendAngle[BEND_STEPS];
        const over = y - BEND_Y1;
        sxv = _bendX[BEND_STEPS] - Math.sin(ang) * over;
        syv = _bendY[BEND_STEPS] + Math.cos(ang) * over;
      } else {
        const f = (y - BEND_Y0) / h;
        const k = Math.min(BEND_STEPS - 1, Math.floor(f));
        const u = f - k;
        ang = _bendAngle[k] + (_bendAngle[k + 1] - _bendAngle[k]) * u;
        sxv = _bendX[k] + (_bendX[k + 1] - _bendX[k]) * u;
        syv = _bendY[k] + (_bendY[k + 1] - _bendY[k]) * u;
      }
      bx = sxv + x * Math.cos(ang);
      by = syv + x * Math.sin(ang);
    }
    // Roll: the glove frame the cockpit hands over sits half way between the rim and the
    // forearm, so the finished hand is turned back by half the bend to land on the rim.
    pos.setXY(i, bx * cr - by * sr, bx * sr + by * cr);
  }
  pos.needsUpdate = true;
  return geo;
}

const _st = [0, 0, 0, 0, 0];
const _sec = [0, 0, 0, 0];
const _lp = new THREE.Vector3();
const _hsA = new THREE.Vector3();
const _hsB = new THREE.Vector3();
const _lt = new THREE.Vector3();
const _ls = new THREE.Vector3();
const _ln = new THREE.Vector3();

function smoothstep01(x) {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}

/** 0 outside [a0, b0], 1 inside [a1, b1], smooth across both shoulders. */
function windowed(v, a0, a1, b1, b0) {
  return Math.min(
    smoothstep01((v - a0) / Math.max(1e-6, a1 - a0)),
    smoothstep01((b0 - v) / Math.max(1e-6, b0 - b1)),
  );
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t2 * t);
}

/** The five section parameters of HAND_LOFT at t in 0..1, interpolated smoothly. */
function loftStation(t, out) {
  const n = HAND_LOFT.length - 1;
  const f = clamp01(t) * n;
  const i = Math.min(n - 1, Math.floor(f));
  const u = f - i;
  const a = HAND_LOFT[Math.max(0, i - 1)];
  const b = HAND_LOFT[i];
  const c = HAND_LOFT[i + 1];
  const d = HAND_LOFT[Math.min(n, i + 2)];
  for (let k = 0; k < 5; k++) out[k] = catmull(a[k], b[k], c[k], d[k], u);
  return out;
}

/**
 * A rounded-rectangle section, walked by perimeter so the vertices are evenly spread
 * and the UVs come out in metres.
 *
 * The walk starts on the palm, at -Z, so the single wrap seam in u — the one place a
 * tiling weave has to jump — is on the face of the hand the driver cannot see. Writes
 * [x, z relative to the section centre, normal x, normal z] and returns the perimeter.
 */
function sectionAt(w, d, cr, s, out) {
  const r = Math.min(w, d) * clamp01(cr);
  const ax = w - r;
  const az = d - r;
  const arc = Math.PI * 0.5 * r;
  const total = 4 * ax + 4 * az + 2 * Math.PI * r;
  let u = (s - Math.floor(s)) * total;
  // 1: half the palm face, out to the corner.
  if (u < ax) { out[0] = u; out[1] = -d; out[2] = 0; out[3] = -1; return total; }
  u -= ax;
  if (u < arc) {
    const a = -Math.PI * 0.5 + (u / Math.max(1e-9, arc)) * Math.PI * 0.5;
    out[2] = Math.cos(a); out[3] = Math.sin(a);
    out[0] = ax + r * out[2]; out[1] = -az + r * out[3];
    return total;
  }
  u -= arc;
  if (u < 2 * az) { out[0] = w; out[1] = -az + u; out[2] = 1; out[3] = 0; return total; }
  u -= 2 * az;
  if (u < arc) {
    const a = (u / Math.max(1e-9, arc)) * Math.PI * 0.5;
    out[2] = Math.cos(a); out[3] = Math.sin(a);
    out[0] = ax + r * out[2]; out[1] = az + r * out[3];
    return total;
  }
  u -= arc;
  // 5: the back of the hand, right to left.
  if (u < 2 * ax) { out[0] = ax - u; out[1] = d; out[2] = 0; out[3] = 1; return total; }
  u -= 2 * ax;
  if (u < arc) {
    const a = Math.PI * 0.5 + (u / Math.max(1e-9, arc)) * Math.PI * 0.5;
    out[2] = Math.cos(a); out[3] = Math.sin(a);
    out[0] = -ax + r * out[2]; out[1] = az + r * out[3];
    return total;
  }
  u -= arc;
  if (u < 2 * az) { out[0] = -w; out[1] = az - u; out[2] = -1; out[3] = 0; return total; }
  u -= 2 * az;
  if (u < arc) {
    const a = Math.PI + (u / Math.max(1e-9, arc)) * Math.PI * 0.5;
    out[2] = Math.cos(a); out[3] = Math.sin(a);
    out[0] = -ax + r * out[2]; out[1] = -az + r * out[3];
    return total;
  }
  u -= arc;
  out[0] = -ax + u; out[1] = -d; out[2] = 0; out[3] = -1;
  return total;
}

/** The bare loft surface at station t and perimeter fraction s. */
function handPoint(t, s, out) {
  loftStation(t, _st);
  sectionAt(_st[2], _st[3], _st[4], s, _sec);
  out.set(_sec[0], _st[0], _st[1] + _sec[1]);
  return out;
}

/**
 * The loft surface with its outward normal. The section normal is exact; the tilt the
 * loft's own taper adds is picked up from a central difference along t, which is what
 * keeps an offset shell parallel to the hand where the cuff and the fingertips flare.
 */
function handSurface(t, s, outP, outN) {
  loftStation(t, _st);
  const perimeter = sectionAt(_st[2], _st[3], _st[4], s, _sec);
  outP.set(_sec[0], _st[0], _st[1] + _sec[1]);
  _ls.set(-_sec[3], 0, _sec[2]);
  // Scratch of their own: `outP` is very often the same vector a caller is about to
  // read back, so the difference pair must not be allowed to land in it.
  const h = 0.012;
  handPoint(Math.min(1, t + h), s, _hsA);
  handPoint(Math.max(0, t - h), s, _hsB);
  _lt.subVectors(_hsA, _hsB);
  outN.crossVectors(_ls, _lt);
  if (outN.lengthSq() < 1e-12) outN.set(_sec[2], 0, _sec[3]);
  outN.normalize();
  if (outN.x * _sec[2] + outN.z * _sec[3] < 0) outN.negate();
  return perimeter;
}

/**
 * One closed shell of the hand loft between stations t0 and t1, displaced along its own
 * normal by `offset(s, point, normal)`.
 *
 * Every panel on the glove is one of these. A panel that is a shell of the hand rather
 * than a slab laid on top of it cannot float, cannot z-fight and cannot fall off the
 * silhouette: where its offset is negative it is simply buried inside the knit, and the
 * edge the eye sees is the contour where the offset crosses zero.
 */
function loftShell(t0, t1, rings, seg, offset) {
  const pos = new Float32Array((rings + 1) * seg * 3 + 6);
  const uv = new Float32Array((rings + 1) * seg * 2 + 4);
  const index = [];
  let v = 0;
  let arcLen = 0;
  const prev = new THREE.Vector3();
  for (let k = 0; k <= rings; k++) {
    const t = t0 + (t1 - t0) * (k / rings);
    if (k > 0) {
      handPoint(t, 0, _lp);
      arcLen += prev.distanceTo(_lp);
    }
    handPoint(t, 0, prev);
    let perimeter = 0;
    for (let j = 0; j < seg; j++) {
      const s = j / seg;
      perimeter = handSurface(t, s, _lp, _ln);
      const off = offset ? offset(s, _lp, _ln) : 0;
      const i3 = v * 3;
      pos[i3] = _lp.x + _ln.x * off;
      pos[i3 + 1] = _lp.y + _ln.y * off;
      pos[i3 + 2] = _lp.z + _ln.z * off;
      uv[v * 2] = (s * perimeter) / GLOVE_TILE;
      uv[v * 2 + 1] = arcLen / GLOVE_TILE;
      v++;
    }
    if (k > 0) {
      const a = (k - 1) * seg;
      const b = k * seg;
      for (let j = 0; j < seg; j++) {
        const j2 = (j + 1) % seg;
        // Wound so the face normal comes out of the hand: the section walk runs
        // anticlockwise in x-z and the stations run downward, so the naive order is
        // inside out and every panel would render as its own back face.
        index.push(a + j, b + j2, b + j, a + j, a + j2, b + j2);
      }
    }
  }
  // Flat caps on both ends. On the base loft the far one is buried behind the fingers,
  // and the near one is the cuff hem the suit sleeve comes out through; on every offset
  // shell both are inside the knit.
  for (let e = 0; e < 2; e++) {
    const t = e === 0 ? t0 : t1;
    loftStation(t, _st);
    const c = v;
    pos[v * 3] = 0; pos[v * 3 + 1] = _st[0]; pos[v * 3 + 2] = _st[1];
    uv[v * 2] = 0; uv[v * 2 + 1] = arcLen / GLOVE_TILE;
    v++;
    const ring = e === 0 ? 0 : rings * seg;
    for (let j = 0; j < seg; j++) {
      const j2 = (j + 1) % seg;
      if (e === 0) index.push(c, ring + j2, ring + j);
      else index.push(c, ring + j, ring + j2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  return geo;
}

const _swA = new THREE.Vector3();
const _swB = new THREE.Vector3();
const _swT = new THREE.Vector3();
const _swU = new THREE.Vector3();
const _swV = new THREE.Vector3();

/**
 * Sweep a flattened round section along a path, with a rotation-minimising frame so a
 * finger that turns through 160 degrees does not twist its weave round with it.
 *
 * `path(t, out)` writes the centreline and `radius(t)` its section, both live, which is
 * how the knuckle, the middle joint and the fingertip get real swellings instead of the
 * three butted cylinders and three loose spheres this replaces. `flat` squashes the
 * section across the sweep's own side axis: at 0.86 the fingers of a closed hand touch
 * along their whole length and the groove between them stays open.
 */
function sweepTube(path, radius, rings, seg, flat) {
  const count = (rings + 1) * seg + 2;
  const pos = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  const index = [];
  // A side axis that is never parallel to the sweep: every path here turns in the y-z
  // plane, so the rim's own axis is square to all of them.
  _swU.set(1, 0, 0);
  let v = 0;
  let arcLen = 0;
  const prev = new THREE.Vector3();
  for (let k = 0; k <= rings; k++) {
    const t = k / rings;
    path(t, _swA);
    path(Math.min(1, t + 0.01), _swB);
    _swT.subVectors(_swB, _swA);
    if (_swT.lengthSq() < 1e-12) {
      path(Math.max(0, t - 0.01), _swB);
      _swT.subVectors(_swA, _swB);
    }
    _swT.normalize();
    // Re-orthogonalise the carried side axis against the new tangent.
    _swU.addScaledVector(_swT, -_swU.dot(_swT));
    if (_swU.lengthSq() < 1e-8) _swU.set(1, 0, 0).addScaledVector(_swT, -_swT.x);
    _swU.normalize();
    _swV.crossVectors(_swT, _swU).normalize();
    if (k > 0) arcLen += prev.distanceTo(_swA);
    prev.copy(_swA);
    const r = radius(t);
    for (let j = 0; j < seg; j++) {
      // The seam sits at theta = 0, on the side axis, which on a finger is the face it
      // shares with the finger beside it — never the face the driver looks at.
      const th = (j / seg) * Math.PI * 2;
      const cx = Math.cos(th) * r * flat;
      const cy = Math.sin(th) * r;
      const i3 = v * 3;
      pos[i3] = _swA.x + _swU.x * cx + _swV.x * cy;
      pos[i3 + 1] = _swA.y + _swU.y * cx + _swV.y * cy;
      pos[i3 + 2] = _swA.z + _swU.z * cx + _swV.z * cy;
      uv[v * 2] = (th * r) / GLOVE_TILE;
      uv[v * 2 + 1] = arcLen / GLOVE_TILE;
      v++;
    }
    if (k > 0) {
      const a = (k - 1) * seg;
      const b = k * seg;
      for (let j = 0; j < seg; j++) {
        const j2 = (j + 1) % seg;
        // Wound outward, for the same reason the loft is: the ring turns from the side
        // axis toward the frame's own binormal, which crossed with the sweep direction
        // faces into the tube, so the naive order renders every finger inside out.
        index.push(a + j, b + j2, b + j, a + j, a + j2, b + j2);
      }
    }
  }
  for (let e = 0; e < 2; e++) {
    path(e === 0 ? 0 : 1, _swA);
    const c = v;
    pos[v * 3] = _swA.x; pos[v * 3 + 1] = _swA.y; pos[v * 3 + 2] = _swA.z;
    uv[v * 2] = 0; uv[v * 2 + 1] = arcLen / GLOVE_TILE;
    v++;
    const ring = e === 0 ? 0 : rings * seg;
    for (let j = 0; j < seg; j++) {
      const j2 = (j + 1) % seg;
      if (e === 0) index.push(c, ring + j2, ring + j);
      else index.push(c, ring + j, ring + j2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  return geo;
}

/** Gaussian bump, used for knuckles, guard scallops and the padding's quilt channels. */
function bump(x, width) {
  const u = x / width;
  return Math.exp(-u * u);
}

/**
 * One finger, swept from its knuckle round the rim to its tip.
 *
 * `creases` collects the joints in glove-local metres so the vertex-colour pass can put
 * a fold exactly where this function put a knuckle, at any level of detail.
 */
function fingerGeometry(spec, rings, seg, creases) {
  const [station, phi0, phi1, rRoot, rTip] = spec;
  // Start a little inside the hand so the tube's root cap is buried under the knuckle.
  const a0 = phi0 - 0.34;
  const span = phi1 - a0;
  const path = (t, out) => {
    const phi = a0 + span * t;
    // Fingers converge as they close; a hand whose fingertips stay on their knuckle
    // pitch reads as a rake.
    const drift = -station * 0.20 * t * t;
    out.set(
      station + drift,
      RIM_CENTRE_Y - FINGER_ARC_Y * Math.sin(phi),
      RIM_CENTRE_Z + FINGER_ARC_Z * Math.cos(phi),
    );
  };
  // Joints at the knuckle, the middle and the last, measured from the visible root.
  const k0 = (phi0 - a0) / span;
  const jointT = [k0, k0 + (1 - k0) * 0.38, k0 + (1 - k0) * 0.71];
  const radius = (t) => {
    const base = rRoot + (rTip - rRoot) * clamp01((t - k0) / Math.max(1e-6, 1 - k0));
    const swell = 1
      + 0.19 * bump(t - jointT[0], 0.11)
      + 0.13 * bump(t - jointT[1], 0.085)
      + 0.10 * bump(t - jointT[2], 0.070);
    // Round the tip off over the last 11 per cent rather than stopping on a flat cap.
    const tip = t > 0.89 ? Math.sqrt(Math.max(0, 1 - ((t - 0.89) / 0.115) ** 2)) : 1;
    return base * swell * Math.max(0.06, tip);
  };
  const g = sweepTube(path, radius, rings, seg, 0.86);
  const p = new THREE.Vector3();
  for (let j = 0; j < 3; j++) {
    path(jointT[j], p);
    creases.push(p.x, p.y, p.z, [0.0150, 0.0112, 0.0092][j], [0.42, 0.34, 0.26][j]);
  }
  // The groove this finger shares with the next one along, so the four read apart even
  // where they touch. Sampled along the arc because the fold follows the finger, not a
  // straight line across the hand.
  if (station < 0.02) {
    for (let j = 0; j <= 6; j++) {
      const t = k0 + (1 - k0) * (j / 6) * 0.62;
      path(t, p);
      creases.push(p.x + 0.0106, p.y, p.z, 0.0085, 0.34);
    }
  }
  return g;
}

/** The thumb: one tube up over the near face of the rim, past the index knuckle. */
function thumbGeometry(rings, seg, creases) {
  const curve = new THREE.CatmullRomCurve3(
    THUMB_PATH.map((p) => new THREE.Vector3(p[0], p[1], p[2])), false, 'centripetal', 0.5,
  );
  const radii = THUMB_PATH.map((p) => p[3]);
  const path = (t, out) => curve.getPoint(t, out);
  const radius = (t) => {
    const f = t * (radii.length - 1);
    const i = Math.min(radii.length - 2, Math.floor(f));
    const base = radii[i] + (radii[i + 1] - radii[i]) * (f - i);
    const swell = 1 + 0.14 * bump(t - 0.46, 0.10) + 0.10 * bump(t - 0.76, 0.085);
    const tip = t > 0.88 ? Math.sqrt(Math.max(0, 1 - ((t - 0.88) / 0.125) ** 2)) : 1;
    return base * swell * Math.max(0.06, tip);
  };
  const p = new THREE.Vector3();
  for (const t of [0.30, 0.46, 0.76]) {
    path(t, p);
    creases.push(p.x, p.y, p.z, 0.0135, 0.34);
  }
  return sweepTube(path, radius, rings, seg, 0.90);
}

/**
 * Bake the folds into a vertex colour.
 *
 * `creases` is a flat (x, y, z, radius, depth) list in glove-local metres, filled in by
 * the finger and thumb builders from the joints they actually placed. Every vertex takes
 * the deepest crease that reaches it, squared so the falloff has a soft shoulder and a
 * tight core, and the result multiplies the fabric albedo. It is done here and not in a
 * texture because a texture cannot know where a joint is: the glove's UVs are unrolled
 * per piece, so a knuckle and its crease have no common frame to share.
 */
function applyCreaseColours(geo, creases) {
  const pos = geo.getAttribute('position');
  const out = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let darkest = 0;
    for (let c = 0; c < creases.length; c += 5) {
      const r = creases[c + 3];
      const dx = x - creases[c], dy = y - creases[c + 1], dz = z - creases[c + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r * r) continue;
      const t = 1 - Math.sqrt(d2) / r;
      const k = creases[c + 4] * t * t;
      if (k > darkest) darkest = k;
    }
    const k = 1 - darkest;
    out[i * 3] = k;
    out[i * 3 + 1] = k;
    out[i * 3 + 2] = k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(out, 3));
  return geo;
}

const _stA = new THREE.Vector3();
const _stN = new THREE.Vector3();
const _stT = new THREE.Vector3();
const _stS = new THREE.Vector3();

/**
 * Topstitching: a row of thread beads laid along a seam on the hand's surface.
 *
 * `seam(u, out2)` returns the (station, perimeter) parameters of the seam at u, and the
 * beads are placed on the surface from those, so a stitch row follows the hand exactly
 * however the loft is retuned. Each bead is a 3.2 by 1.2 mm bar of thread standing
 * 0.6 mm proud, which at the 2.8 pixels per millimetre a cockpit camera resolves across
 * the back of the hand is a stitch you can count rather than a dotted line painted on.
 */
function stitchRow(seam, length, pitch, out) {
  const n = Math.max(2, Math.round(length / pitch));
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    seam(u, _sec);
    handSurface(_sec[0], _sec[1], _stA, _stN);
    seam(Math.min(1, u + 0.02), _sec);
    handSurface(_sec[0], _sec[1], _stT, _stS);
    _stT.sub(_stA);
    if (_stT.lengthSq() < 1e-12) _stT.set(1, 0, 0);
    _stT.normalize();
    _stS.crossVectors(_stN, _stT).normalize();
    const g = new THREE.SphereGeometry(1, 6, 3);
    const m = new THREE.Matrix4().makeBasis(_stT, _stN, _stS);
    m.scale(new THREE.Vector3(0.0016, 0.0009, 0.0006));
    m.setPosition(
      _stA.x - _stN.x * 0.0003,
      _stA.y - _stN.y * 0.0003,
      _stA.z - _stN.z * 0.0003,
    );
    g.applyMatrix4(m);
    // The thread is a solid of revolution about nothing in particular; a planar UV in
    // real metres keeps the weave off it without a second unwrap.
    const uv = g.getAttribute('uv');
    const p = g.getAttribute('position');
    for (let k = 0; k < uv.count; k++) {
      uv.setXY(k, p.getX(k) / GLOVE_TILE, p.getY(k) / GLOVE_TILE);
    }
    out.push(g);
  }
}

/** Station t of the hand loft at a given y, by bisection on the monotone y curve. */
function loftT(y) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) * 0.5;
    loftStation(mid, _st);
    if (_st[0] > y) lo = mid; else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/** The perimeter fraction where the section's outward normal crosses `nz`, on `side`. */
function loftSeamS(t, nz, side) {
  let best = side > 0 ? 0.15 : 0.65;
  let bestErr = Infinity;
  for (let i = 0; i <= 160; i++) {
    const s = i / 160;
    handSurface(t, s, _lp, _ln);
    if (Math.sign(_lp.x || side) !== Math.sign(side)) continue;
    const err = Math.abs(_ln.z - nz);
    if (err < bestErr) { bestErr = err; best = s; }
  }
  return best;
}

function gloveGeometry(detail, side) {
  const hero = detail >= 2;
  const seg = hero ? 40 : 18;
  const fseg = hero ? 16 : 8;
  const fabric = [];
  const leather = [];
  const guard = [];
  const accent = [];
  const stitch = [];
  const creases = [];

  // The hand, wrist and cuff, in one piece.
  fabric.push(loftShell(0, 1, hero ? 40 : 18, seg, null));

  for (const spec of FINGERS) fabric.push(fingerGeometry(spec, hero ? 22 : 10, fseg, creases));
  fabric.push(thumbGeometry(hero ? 20 : 9, fseg, creases));

  // Padding across the back of the hand: a shell of the loft itself, three channels
  // quilted into it, tapering into the knit at every edge instead of stopping on one.
  const padT0 = loftT(0.0250);
  const padT1 = loftT(0.0010);
  fabric.push(loftShell(padT0, padT1, hero ? 14 : 6, seg, (s, p, n) => {
    const quilt = 1 - 0.34 * (bump(p.x, 0.0040)
      + bump(p.x - 0.0175, 0.0040) + bump(p.x + 0.0175, 0.0040));
    const k = windowed(p.y, 0.0010, 0.0062, 0.0198, 0.0250)
      * smoothstep01((n.z - 0.16) / 0.40)
      * windowed(p.x, -0.0330, -0.0250, 0.0250, 0.0330);
    return -0.0016 + 0.0040 * k * quilt;
  }));

  // The moulded knuckle protector. Scalloped over the four knuckles from the finger
  // stations themselves, so the bumps land on the joints at any level of detail.
  const guardT0 = loftT(-0.0010);
  const guardT1 = loftT(-0.0280);
  guard.push(loftShell(guardT0, guardT1, hero ? 16 : 7, seg, (s, p, n) => {
    let ribs = 0;
    for (const f of FINGERS) ribs += bump(p.x - f[0], 0.0082);
    const amp = 0.0017 + 0.0028 * Math.min(1, ribs);
    const k = windowed(p.y, -0.0280, -0.0238, -0.0056, -0.0010)
      * smoothstep01((n.z - 0.28) / 0.26)
      * windowed(p.x, -0.0412, -0.0348, 0.0348, 0.0412);
    return -0.0018 + (amp + 0.0018) * k;
  }));

  // Leather palm, wrapped round the silhouette. The half that faces the rim is what the
  // hand actually grips with; the 3 mm of it that comes round the edges is all a camera
  // in the seat can see of it, and is enough to read the roughness break against knit.
  const palmT0 = loftT(0.0340);
  const palmT1 = loftT(-0.0302);
  leather.push(loftShell(palmT0, palmT1, hero ? 22 : 10, seg, (s, p, n) => {
    const k = windowed(p.y, -0.0302, -0.0252, 0.0284, 0.0340)
      * (1 - smoothstep01((n.z - 0.18) / 0.30));
    return -0.0014 + 0.0022 * k;
  }));

  // The wrist strap: the one piece that carries the team colour, at a 5 mm section, so
  // it reads as a line round the cuff rather than as a slab.
  const strapT0 = loftT(0.0600);
  const strapT1 = loftT(0.0480);
  accent.push(loftShell(strapT0, strapT1, hero ? 8 : 4, seg, (s, p) => (
    -0.0016 + 0.0038 * windowed(p.y, 0.0480, 0.0501, 0.0579, 0.0600)
  )));

  if (hero) {
    // Cuff topstitching, above and below the strap.
    for (const y of [0.0722, 0.0430]) {
      const t = loftT(y);
      loftStation(t, _st);
      const circumference = 2 * Math.PI * (_st[2] + _st[3]) * 0.5;
      stitchRow((u, o) => { o[0] = t; o[1] = u; }, circumference, 0.0070, stitch);
    }
    // The seam that closes the palm leather round the silhouette, both sides.
    for (const sgn of [1, -1]) {
      const sA = loftSeamS(palmT0, 0.10, sgn);
      const sB = loftSeamS(palmT1, 0.10, sgn);
      stitchRow((u, o) => {
        o[0] = palmT0 + (palmT1 - palmT0) * u;
        o[1] = sA + (sB - sA) * u;
      }, 0.068, 0.0058, stitch);
    }
    // And the padding's own border, down each side of the back of the hand.
    for (const x of [0.0278, -0.0278]) {
      const sA = loftSeamS(padT0, 0.55, Math.sign(x));
      const sB = loftSeamS(padT1, 0.55, Math.sign(x));
      stitchRow((u, o) => {
        o[0] = padT0 + (padT1 - padT0) * u;
        o[1] = sA + (sB - sA) * u;
      }, 0.030, 0.0058, stitch);
    }
  }

  // The fold where the back of the hand breaks onto the wrist, and the heel crease:
  // the two the eye looks for on a closed hand besides the knuckles themselves.
  for (let i = -2; i <= 2; i++) {
    creases.push(i * 0.0125, 0.0295, 0.0245 - Math.abs(i) * 0.0016, 0.0125, 0.26);
  }
  creases.push(-0.0330, 0.0140, 0.0090, 0.0155, 0.30);

  const groups = [
    mergeGeometries(fabric, false),
    mergeGeometries(leather, false),
    mergeGeometries(guard, false),
    mergeGeometries(accent, false),
    stitch.length ? mergeGeometries(stitch, false) : new THREE.BufferGeometry(),
  ];
  for (const list of [fabric, leather, guard, accent, stitch]) for (const g of list) g.dispose();
  // The stitching has to exist even at the low tier, or the group order the materials
  // are indexed by shifts by one and the palm renders in thread.
  if (!groups[4].getAttribute('position')) {
    const dot = new THREE.SphereGeometry(0.0004, 4, 2);
    dot.translate(0, 0.0300, -0.0100);
    const uv = dot.getAttribute('uv');
    for (let k = 0; k < uv.count; k++) uv.setXY(k, 0, 0);
    groups[4].dispose();
    groups[4] = dot;
  }

  // The lofts and sweeps carry position and uv only — normals are computed once, on the
  // merged whole, so a group boundary is not a shading break. The stitch beads come off
  // a primitive that ships its own, and mergeGeometries refuses a set that disagrees.
  for (const g of groups) {
    g.deleteAttribute('normal');
    applyCreaseColours(g, creases);
  }

  const merged = mergeGeometries(groups, true);
  for (const g of groups) g.dispose();
  bendAtWrist(merged);
  merged.computeVertexNormals();
  if (side < 0) mirrorX(merged);
  return merged;
}

const _gloveMats = new Map();
let _gloveMaps = null;

/**
 * The two texture sets a glove needs, built once for the whole grid.
 *
 * Neither carries a colour map. The albedo is a flat pinned value on the material, so a
 * glove's colour is a number somebody can read in this file rather than the product of a
 * tint, a lift curve and a clip; the maps supply relief and occlusion only. Both are
 * mip-chained with Toksvig applied, because the weave lands at about three pixels a
 * thread at cockpit range — close enough to Nyquist that an unfiltered chain beats
 * against it, which is what produced the crosshatch over the old glove.
 */
function gloveMaps(ctx) {
  if (_gloveMaps) return _gloveMaps;
  const px = ctx?.quality?.name === 'low' ? 128 : 256;
  const aniso = ctx?.materials?.anisotropy ?? 4;

  const knit = buildNomex(px, {
    seed: 3347, weave: 26, stitch: 0, tint: 0x808080, roughness: 0.78,
    tile: 0.040, normalStrength: 1.9,
  });
  const hide = buildGloveLeather(Math.max(64, px >> 1), { seed: 8821, cells: 22, tile: 0.045 });

  const knitNormal = normalMipChain(knit.normal, knit.width, knit.height);
  const knitOrm = mipChain(knit.orm, knit.width, knit.height, false);
  applyToksvig(knitOrm, knitNormal.lengths);
  const hideNormal = normalMipChain(hide.normal, hide.width, hide.height);
  const hideOrm = mipChain(hide.orm, hide.width, hide.height, false);
  applyToksvig(hideOrm, hideNormal.lengths);

  const make = (data, w, h, mips) => {
    const t = makeDataTexture(data, w, h, THREE.NoColorSpace, mips);
    t.anisotropy = aniso;
    return t;
  };

  _gloveMaps = {
    knitNormal: make(knit.normal, knit.width, knit.height, knitNormal.levels),
    knitOrm: make(knit.orm, knit.width, knit.height, knitOrm),
    hideNormal: make(hide.normal, hide.width, hide.height, hideNormal.levels),
    hideOrm: make(hide.orm, hide.width, hide.height, hideOrm),
  };
  // aoMap defaults to the second UV set; this geometry only ships one.
  _gloveMaps.knitOrm.channel = 0;
  _gloveMaps.hideOrm.channel = 0;
  return _gloveMaps;
}

/**
 * The pinned reference for a glove's fabric: a muted burnt orange, which is 16 degrees
 * of hue at 64% saturation and 33% lightness in HSL.
 *
 * The colour a glove takes is the team's own, pulled to exactly that saturation and that
 * lightness with its hue left alone. Taking the team colour raw is what produced the
 * plasticine hand the review saw: Scuderia Corsa's red is 86% saturated at 46% lightness
 * and, lit by an open sky, the sleeve and cuff rendered at #f2634a — a pure saturated
 * orange with no material in it at all. Normalised it becomes #8a1e2d: the reference's
 * own chroma and value at the team's hue, and the same red channel. A team whose colour
 * already sits near the reference hue — Albion's orange — lands within a few units of
 * 0x8a3b1e itself.
 *
 * A near-neutral team colour has no hue worth keeping, so below 12% saturation the glove
 * falls back to a warm charcoal rather than inventing one.
 */
const GLOVE_FABRIC_REF = 0x8a3b1e;
const GLOVE_FABRIC_NEUTRAL = 0x3a3630;
const _hsl = { h: 0, s: 0, l: 0 };

function fabricColour(teamHex) {
  const ref = new THREE.Color(GLOVE_FABRIC_REF);
  ref.getHSL(_hsl);
  const refS = _hsl.s;
  const refL = _hsl.l;
  new THREE.Color(teamHex).getHSL(_hsl);
  if (_hsl.s < 0.12) return new THREE.Color(GLOVE_FABRIC_NEUTRAL);
  return new THREE.Color().setHSL(_hsl.h, refS, refL);
}

/**
 * Glove materials for one livery, in the group order `gloveGeometry` lays down.
 *
 * The knit is pinned: roughness 0.78, no metalness, a weave normal at its real scale, an
 * occlusion map and the baked creases, and nothing else. What separates it from the palm
 * is response and not colour — the leather runs its own roughness map at a mean of about
 * 0.56, so the two break apart under a highlight the way cloth and hide do, and that is
 * the cue that stops a hand reading as one moulded object.
 */
export function gloveMaterials(ctx, livery) {
  const cached = _gloveMats.get(livery);
  if (cached) return cached;
  const maps = gloveMaps(ctx);
  const teamHex = livery?.colors?.primary ?? livery?.colors?.accent ?? GLOVE_FABRIC_REF;
  const accentHex = livery?.colors?.accent ?? 0xd8dce2;
  const cloth = fabricColour(teamHex);

  const knit = new THREE.MeshPhysicalMaterial({
    color: cloth,
    roughness: 0.78,
    metalness: 0.0,
    normalMap: maps.knitNormal,
    aoMap: maps.knitOrm,
    vertexColors: true,
    // Sheen and environment both kept low: under an open sky a nomex glove with either
    // one turned up goes the pale grey the first pass rendered, and a pale grey hand
    // reads as a prop rather than as the driver's.
    sheen: 0.10,
    sheenRoughness: 0.88,
    sheenColor: cloth.clone().lerp(new THREE.Color(0x767b84), 0.55),
    envMapIntensity: 0.32,
  });
  knit.normalScale.set(1.0, 1.0);

  const palm = new THREE.MeshPhysicalMaterial({
    color: 0x2f261f,
    roughness: 1.0,
    roughnessMap: maps.hideOrm,
    metalness: 0.0,
    normalMap: maps.hideNormal,
    aoMap: maps.hideOrm,
    vertexColors: true,
    envMapIntensity: 0.55,
  });
  palm.normalScale.set(0.85, 0.85);

  const guard = new THREE.MeshPhysicalMaterial({
    color: 0x17181d,
    roughness: 0.52,
    metalness: 0.0,
    normalMap: maps.hideNormal,
    vertexColors: true,
    clearcoat: 0.30,
    clearcoatRoughness: 0.42,
    envMapIntensity: 0.45,
  });
  guard.normalScale.set(0.26, 0.26);

  // The strap keeps a team read on the hand, but 62% of the way toward the fabric so it
  // is a trim colour and not a warning light, and with the environment held right down
  // so it cannot outshine the wheel's display behind it. Raw accent at envMapIntensity
  // 0.45 clipped to #fcf3c2 on the crown of the torus and 55% still reached #fcedb0 —
  // brighter than anything on the wheel bar the shift lights, on a 5 px wide strap. The
  // roughness below is part of the same fix: webbing is matte, and at 0.66 the sun's
  // specular on a torus was landing on top of an albedo that was already too light.
  const strapColour = new THREE.Color(accentHex).lerp(cloth, 0.62);
  const strap = new THREE.MeshPhysicalMaterial({
    color: strapColour,
    roughness: 0.80,
    metalness: 0.0,
    normalMap: maps.knitNormal,
    vertexColors: true,
    sheen: 0.14,
    sheenRoughness: 0.84,
    sheenColor: strapColour.clone().lerp(new THREE.Color(0xffffff), 0.25),
    envMapIntensity: 0.28,
  });
  strap.normalScale.set(0.7, 0.7);

  // Thread. A racing glove is topstitched in a bonded polyester that reads a shade
  // lighter and a good deal shinier than the knit it holds together, which is the only
  // reason a 1 mm bead of it is legible at all from the seat. Taken from the fabric
  // rather than invented, so a stitch never fights the team's colour.
  const threadColour = cloth.clone().lerp(new THREE.Color(0xd8cfc2), 0.62);
  const thread = new THREE.MeshPhysicalMaterial({
    color: threadColour,
    roughness: 0.54,
    metalness: 0.0,
    vertexColors: true,
    sheen: 0.30,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color(0xffffff),
    envMapIntensity: 0.30,
  });

  const set = [knit, palm, guard, strap, thread];
  _gloveMats.set(livery, set);
  return set;
}

const _suitMats = new Map();

/**
 * The team suit, tuned for a camera 300 mm away from the sleeve.
 *
 * The registry's nomex is authored for a driver seen from outside the car: 150 threads
 * to a 320 mm tile at normal strength 2.6, with a full-strength occlusion map behind it.
 * Ten metres away that is a matte cloth. At the range a cockpit camera sits from the
 * driver's own forearm it is a string vest — the review called the arms plasticine, and
 * that black diamond mesh is what it was looking at. The relief is the problem and not
 * the pitch: at 0.42 of the authored normal scale, with occlusion at 0.55, the same
 * weave reads as the grain of a cloth sleeve instead of as knitted rope.
 *
 * Colour, map and sheen are the livery's own and are deliberately untouched, so the
 * driver's arms are the same suit as his shoulders and his legs from every camera.
 */
export function cockpitSuitMaterial(livery) {
  const base = livery?.suit;
  if (!base) return null;
  const cached = _suitMats.get(base);
  if (cached) return cached;
  const m = base.clone();
  if (base.normalScale) m.normalScale.set(base.normalScale.x * 0.42, base.normalScale.y * 0.42);
  m.aoMapIntensity = 0.55;
  _suitMats.set(base, m);
  return m;
}

export function disposeCockpitSuitMaterials() {
  for (const m of _suitMats.values()) m.dispose();
  _suitMats.clear();
}

export function disposeGloveMaterials() {
  for (const set of _gloveMats.values()) for (const m of set) m.dispose();
  _gloveMats.clear();
  if (_gloveMaps) {
    for (const key of Object.keys(_gloveMaps)) _gloveMaps[key].dispose();
    _gloveMaps = null;
  }
}

const _armGeoCache = new Map();

function armGeometry(detail) {
  const cached = _armGeoCache.get(detail);
  if (cached) return cached;
  const set = {
    upper: limbGeometry(0.052, 0.042, detail),
    fore: limbGeometry(0.044, 0.024, detail),
    // A right hand rotated onto the left grip is still a right hand — thumb on the
    // wrong side of the rim — so the mirror is baked into a second geometry.
    gloveRight: gloveGeometry(detail, 1),
    gloveLeft: gloveGeometry(detail, -1),
  };
  _armGeoCache.set(detail, set);
  return set;
}

export function disposeSharedArmGeometry() {
  for (const set of _armGeoCache.values()) {
    set.upper.dispose();
    set.fore.dispose();
    set.gloveRight.dispose();
    set.gloveLeft.dispose();
  }
  _armGeoCache.clear();
  disposeGloveMaterials();
  disposeCockpitSuitMaterials();
}

const UPPER_LENGTH = 0.300;
const ELBOW_OVERLAP = 0.026;
const FORE_LENGTH = 0.282;

/**
 * How far short of the wrist the suit sleeve stops.
 *
 * The forearm is a cone 64 mm across at its narrow end and it used to run all the way to
 * the grip point, which is the middle of the driver's hand. The glove there is 80 mm
 * across but only 40 mm deep, so the sleeve stood 4 mm out of the back of the hand and
 * 20 mm out of the palm, and the wedge of it that surfaced sat in the middle of the
 * lower frame in every cockpit shot. Ending it 45 mm up the forearm puts its flat tip
 * inside the cuff, which is 74 mm across there — 5 mm of cover all round — while leaving
 * it 57 mm of overlap through the hem, so the sleeve still emerges from the glove
 * instead of stopping at it.
 */
const WRIST_INSET = 0.055;

/**
 * One arm, shoulder to glove.
 *
 * `solve` takes a wrist position in the chain root's space and places both bones; the
 * elbow falls out of the closed-form two-bone solution with a pole that points down and
 * outboard, which is where a seated driver's elbow physically has to go inside a
 * survival cell. It is published as `elbow` because the hand cannot be oriented until
 * it is known: the forearm axis is one of the three axes of the grip frame, and taking
 * it from the shoulder instead — as this used to — twists the glove off the rim by
 * thirty degrees the moment the elbow swings out.
 */
export class ArmChain {
  constructor(ctx, livery, side, shoulder, detail = 2) {
    const geo = armGeometry(detail);
    this.side = side;
    this.baseShoulder = new THREE.Vector3(shoulder[0], shoulder[1], shoulder[2]);
    this.shoulder = this.baseShoulder.clone();
    this.elbow = new THREE.Vector3();
    this.group = new THREE.Group();
    this.group.name = side > 0 ? 'arm-right' : 'arm-left';

    const suit = cockpitSuitMaterial(livery) ?? livery.suit;

    this.upper = new THREE.Mesh(geo.upper, suit);
    this.upper.position.copy(this.shoulder);
    this.upper.scale.set(1, UPPER_LENGTH, 1);
    this.upper.castShadow = false;
    this.group.add(this.upper);

    this.fore = new THREE.Mesh(geo.fore, suit);
    this.fore.scale.set(1, FORE_LENGTH, 1);
    this.fore.castShadow = detail >= 2;
    this.group.add(this.fore);

    this.hand = new THREE.Mesh(
      side > 0 ? geo.gloveRight : geo.gloveLeft,
      gloveMaterials(ctx, livery),
    );
    this.hand.castShadow = detail >= 2;
    this.group.add(this.hand);

    // Elbows go outboard and a little down — the only place they physically fit inside
    // a survival cell, and the only pole that keeps the chain from inverting at full
    // lock. The old pole dropped them 140 mm below the grips, which put the forearm at
    // 43 degrees to the rim: a wrist angle no driver holds, and one that rolled the
    // glove off the tube. Outboard and level puts it near 50, which is a real grip.
    this._pole = new THREE.Vector3(side * 0.82, -0.42, 0.30).normalize();
  }

  /** Place both bones and the wrist. Leaves the hand's orientation alone. */
  solve(targetPos) {
    const s = this.shoulder;
    this.upper.position.copy(s);
    _v.subVectors(targetPos, s);
    const d = clamp(_v.length(), Math.abs(UPPER_LENGTH - FORE_LENGTH) + 0.02, UPPER_LENGTH + FORE_LENGTH - 0.005);
    _v.normalize();

    const cosA = clamp(
      (UPPER_LENGTH * UPPER_LENGTH + d * d - FORE_LENGTH * FORE_LENGTH) / (2 * UPPER_LENGTH * d),
      -1, 1,
    );
    const a = Math.acos(cosA);

    // Project the pole perpendicular to the shoulder-to-wrist line to get the bend plane.
    _bend.copy(this._pole).addScaledVector(_v, -this._pole.dot(_v));
    if (_bend.lengthSq() < 1e-6) _bend.set(0, -1, 0).addScaledVector(_v, _v.y);
    _bend.normalize();

    this.elbow.copy(s)
      .addScaledVector(_v, Math.cos(a) * UPPER_LENGTH)
      .addScaledVector(_bend, Math.sin(a) * UPPER_LENGTH);

    _v2.subVectors(this.elbow, s).normalize();
    _q.setFromUnitVectors(_UP, _v2);
    this.upper.quaternion.copy(_q);

    _v3.subVectors(targetPos, this.elbow);
    const foreLength = Math.max(0.05, _v3.length());
    _v3.multiplyScalar(1 / foreLength);
    _q.setFromUnitVectors(_UP, _v3);
    this.fore.quaternion.copy(_q);
    // Start the forearm a little behind the elbow so the two tapers overlap and the
    // joint never opens up into a gap at full bend.
    this.fore.position.copy(this.elbow).addScaledVector(_v3, -ELBOW_OVERLAP);
    this.fore.scale.set(1, Math.max(0.06, foreLength + ELBOW_OVERLAP - WRIST_INSET), 1);

    this.hand.position.copy(targetPos);
    return this.elbow;
  }

  orientHand(q) {
    this.hand.quaternion.copy(q);
  }

  dispose() {
    this.group.clear();
  }
}

/**
 * Thighs, knees and the tops of the shins, seen at the bottom of the cockpit frame.
 * They are effectively static — an F1 driver's legs are strapped in place — so this is
 * one merged mesh rather than a rig.
 */
export function legsGeometry(detail, knee, ankle, hip) {
  const parts = [];
  const seg = detail >= 2 ? 14 : 8;
  for (const side of [1, -1]) {
    const hipP = new THREE.Vector3(side * 0.105, hip[1], hip[2]);
    const kneeP = new THREE.Vector3(side * knee[0], knee[1], knee[2]);
    const ankleP = new THREE.Vector3(side * ankle[0], ankle[1], ankle[2]);

    const thighLen = hipP.distanceTo(kneeP);
    const thigh = new THREE.CylinderGeometry(0.086, 0.072, thighLen, seg, 2);
    thigh.translate(0, thighLen * 0.5, 0);
    _v.subVectors(kneeP, hipP).normalize();
    _q.setFromUnitVectors(_UP, _v);
    thigh.applyQuaternion(_q);
    thigh.translate(hipP.x, hipP.y, hipP.z);
    parts.push(thigh);

    const shinLen = kneeP.distanceTo(ankleP);
    const shin = new THREE.CylinderGeometry(0.070, 0.052, shinLen, seg, 2);
    shin.translate(0, shinLen * 0.5, 0);
    _v.subVectors(ankleP, kneeP).normalize();
    _q.setFromUnitVectors(_UP, _v);
    shin.applyQuaternion(_q);
    shin.translate(kneeP.x, kneeP.y, kneeP.z);
    parts.push(shin);

    const kneeCap = new THREE.SphereGeometry(0.074, seg, Math.max(8, seg >> 1));
    kneeCap.scale(1.0, 1.0, 1.15);
    kneeCap.translate(kneeP.x, kneeP.y, kneeP.z);
    parts.push(kneeCap);
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  merged.computeVertexNormals();
  scaleUv(merged, 2.4, 2.4);
  return merged;
}

export { HELMET_RADIUS, UPPER_LENGTH, FORE_LENGTH, DEG };
