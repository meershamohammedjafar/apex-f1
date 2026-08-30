import * as THREE from 'three';
import { clamp, clamp01, smoothstep } from '../core/MathUtils.js';
import { Rng } from '../core/Rng.js';
import { makeDataTexture } from '../render/textures/NoiseTextures.js';
import {
  CROWD_CELL_W, CROWD_CELL_H, DISTANCE_MARKS, buildDistanceBoards,
  buildCatchFence, buildAstroturfVerge, buildCanopyAtlas,
  CANOPY_ALPHA_TEST, CANOPY_ATLAS, buildLedPanels, buildSponsorBoards,
} from '../render/textures/TracksideTextures.js';

/**
 * Everything beyond the barriers: the Ardennes the circuit is cut into, the forest, the
 * grandstands and the crowd in them, the pit complex, catch fencing, signage and towers.
 *
 * The rule here is instancing or merging, never a mesh per object. A hundred thousand
 * spectators are one draw call; a forest of several thousand trees is six. The terrain
 * is a heightfield sampled from the same `heightAt` the tyres use, with a hole cut where
 * the circuit's own apron already covers the ground, so the two never fight and the
 * ground runs unbroken from the kerb to the horizon.
 */

const _v = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _axis = new THREE.Vector3(0, 1, 0);
// Build-time only, and deliberately not `_v`/`_m`: `_bakeInstances` runs inside builders
// that are themselves holding those scratches across the call.
const _bakeV = new THREE.Vector3();
const _bakeNormal = new THREE.Matrix3();

const NEAR_TERRAIN_CELL = 15;
const NEAR_TERRAIN_PAD = 900;
// 2x2, walked down from 4x4 and then 3x3 by measurement. Finer subdivision culls a
// little more tightly and buys nothing for it: the corridor hole has already removed
// the quads nearest the camera, so what the extra chunks cull is empty hillside. What
// they cost is draws — sixteen chunks put eight of themselves in a wide shot, nine put
// five or six, four put two or three — and this scene is over CONTRACT §8.4's 400-call
// budget, not over its triangle budget. The whole near field is 125k triangles; drawing
// 20k more of them to save three calls is the right side of that trade.
const TERRAIN_CHUNKS = 2;
const CORRIDOR_HOLE = 40;          // metres of paved-edge clearance the apron already covers
const FAR_RADIUS = 13000;
const FENCE_HEIGHT = 3.3;
const FENCE_POST_SPACING = 3.0;    // real debris fencing is posted every three metres
const FENCE_FOOT = 0.70;           // top of the barrier the mesh starts from
const FENCE_RAIL_MID = 2.32;       // the mid tensioning rail, measured from the ground
/**
 * Floor on cos(incidence) in the fence's Beer-Lambert opacity, i.e. the most wire a ray
 * is ever allowed to cross. 0.16 caps the path at 6.25 weaves, which takes the sheet's
 * 0.233 normal-incidence density to 0.79 and no further: a fence looked at exactly
 * edge-on is dense, but it is never a wall, and the cars behind it must stay readable.
 */
const FENCE_GRAZE_FLOOR = 0.16;

// Grandstand section, in metres. A rake of 0.45 m risers on 0.85 m treads is the
// standard temporary-grandstand geometry, and the 2.35 m front wall is what puts the
// first row of heads above the top of the catch fencing.
const STAND_SETBACK = 3.0;         // clear of the barrier line the offsets are authored to
const STAND_RISER = 0.45;
const STAND_TREAD = 0.85;
const STAND_FRONT = 2.35;
const STAND_WALK = 1.15;           // front walkway before the first row
const STAND_ROOF_CLEAR = 4.4;      // headroom over the back row
const STAND_STATION = 9.0;         // sweep station spacing; also one hoarding
const STAND_FRAME_STATION = 4.5;   // column and roof-beam spacing
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
 * Smooth 2D value noise in [0,1], seeded from position alone.
 *
 * Placement needs a field that is the same everywhere the same point is asked about,
 * which a sequential Rng cannot give: two passes over the same hillside at different
 * spacings have to agree about where the beech stand is. Build-time only.
 */
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
  return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uz;
}

// Floodlighting. A night grand prix is not a dark day: it is a chain of overlapping
// pools of light with genuinely black road between them. Masts go up every couple of
// hundred metres, each throwing one pool across the road it stands beside.
const NIGHT_MAST_SPACING = 140;
const NIGHT_MAST_HEIGHT = 30;
const NIGHT_MAST_CLEAR = 70;       // no added mast this close to one the circuit data places
const POOL_HALF = 46;              // metres of road either side of a mast its pool covers
const POOL_PAD = 9;                // metres past the edge of the racing surface
const POOL_ARC_STEP = 6.0;
const POOL_LAT_STEP = 2.2;
const POOL_LIFT = 0.06;            // decal clearance over the tarmac, metres
// Scene-linear radiance a pool adds to the road, at the peak of its texture. The grade
// lands 0.36 at sRGB 146 and the auto-exposure meters the whole frame, so this is set
// against the rest of the rig rather than in absolute terms: the streaked cores sit at
// the top of the range and bloom, the body of the pool lands in the mid-tones, and the
// road between masts keeps whatever the fill and the spots give it, which is little.
const POOL_GAIN = 1.60;
// Real lights are rationed: only the masts nearest the camera get one, which is what
// makes the car brighten into a pool and fall dark between them. Everything else is the
// baked decal. Intensity is quoted as the irradiance wanted on the road at REF metres,
// because that is the number that is actually being art-directed.
const NIGHT_SPOT_MAX = 4;
// Shallower than inverse-square on purpose. A mast is thirty metres up and lights a
// fifty-metre radius, so a physical decay over that range means the near end of the pool
// is four times the far end: the cockpit halo passing under the mast clips to white and
// draws a hard ring across the frame, while the road ahead is still dark.
const NIGHT_SPOT_DECAY = 1.05;
const NIGHT_SPOT_REF = 55;
const NIGHT_SPOT_IRRADIANCE = 3.0;
const NIGHT_SPOT_AIM_SPAN = 28;    // metres a spot may follow the car along its own stretch
const NIGHT_SPOT_FADE_NEAR = 150;
const NIGHT_SPOT_FADE_FAR = 320;
const NIGHT_LENS_EMISSIVE = 8.5;
const NIGHT_FILL_INTENSITY = 0.52;

// Butt radius of the shared unit stem, in the geometry's own units. Every trunk is this
// cylinder stretched by `aStem`, so the number itself is arbitrary — it only has to be
// far enough from zero that the 8-bit normals off `CylinderGeometry` stay sane.
const TRUNK_UNIT_RADIUS = 0.25;

const TREE_SPACING = 21;
const TREE_BAND = 330;      // metres of dense forest either side
const TREE_FAR_BAND = 760;  // thinned planting beyond it, so the hillside is not bare
const TREE_FAR_SPACING = 46;

/**
 * Four plantings, not one shape scaled three ways.
 *
 * The Ardennes above Spa is Norway spruce plantation broken by stands of beech and
 * self-seeded birch, and the treeline is the most recognisable thing about the circuit
 * after the tarmac. `form` drives the crown generator: a spruce is a spire, a Scots pine
 * carries its crown as an umbrella on a bare stem, a beech is a broad dome and a birch is
 * a narrow airy column. `atlas` selects the leaf card, `tint` the two ends of the
 * per-tree colour range — deep blue-green through to yellow-green — which is what stops
 * the mass reading as one colour.
 *
 * The blue term of every tint is held at 0.52 or above. It used to run as low as 0.42,
 * and multiplying an already blue-poor hue-94 leaf card by that produced sunlit crowns
 * measured at rgb(83,146,1) with their highlights clipped to rgb(239,243,239) — a colour
 * with no blue in it is outside anything a leaf does, and under a filmic tonemap its
 * highlights go straight to white.
 */
const TREE_SPECIES = [
  {
    name: 'spruce', form: 'spire', atlas: 0, share: 0.40,
    height: [17, 38], radius: [2.1, 4.0], cards: 13, bare: 0.10,
    tint: [[0.52, 0.60, 0.52], [0.86, 0.92, 0.80]],
  },
  {
    name: 'pine', form: 'umbrella', atlas: 1, share: 0.20,
    height: [14, 28], radius: [2.8, 5.0], cards: 10, bare: 0.58,
    tint: [[0.58, 0.66, 0.54], [0.94, 0.96, 0.82]],
  },
  {
    name: 'beech', form: 'dome', atlas: 2, share: 0.28,
    height: [11, 27], radius: [3.6, 7.0], cards: 13, bare: 0.32,
    tint: [[0.58, 0.70, 0.52], [1.00, 1.02, 0.84]],
  },
  {
    name: 'birch', form: 'column', atlas: 3, share: 0.12,
    height: [8, 20], radius: [1.8, 3.2], cards: 9, bare: 0.44,
    tint: [[0.72, 0.82, 0.58], [1.06, 1.08, 0.86]],
  },
];

/**
 * Cross-section of a barrier hoarding, as (outward, height) pairs running bottom to top.
 * The first and last segments are the extruded frame the vinyl is tensioned into, and
 * their arc length is 11% of the total — which is the band `buildSponsorBoards` reserves
 * for the frame at each end of a row. Change one and the other has to follow.
 */
const SPONSOR_PROFILE = [
  [-0.09, 0.0685], [-0.22, 0.130], [-0.22, 1.150], [-0.09, 1.2115],
];

/**
 * Cross-section of a trackside LED module, sitting on top of the hoardings. Same idea as
 * `SPONSOR_PROFILE`: the first and last segments fold back onto the black bezel bands
 * `buildLedPanels` reserves, which are 10% of a row each.
 */
const LED_PROFILE = [
  [-0.12, 1.2353], [-0.24, 1.260], [-0.24, 2.240], [-0.12, 2.2647],
];

// Spectator areas. The circuit data already carves clearings out of the forest for
// them; leaving those clearings empty is what made the world stop at the barrier.
const BANK_ROWS = 7;
const BANK_RISE = 0.62;            // metres of earth per terrace
const BANK_TREAD = 2.6;

/** Accumulates triangles for a merged static mesh. */
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

  /**
   * A quad with an explicit normal. The winding is derived from that normal rather than
   * assumed from the corner order, so a caller that walks its corners the other way round
   * still gets a face that points where it says it does.
   */
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

  /** Axis-aligned box rotated about Y, with world-scaled UVs. */
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
      [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1], [0, -1, 0], sx, sz],
    ];
    for (const f of faces) {
      this.quad(
        corner(...f[0]), corner(...f[1]), corner(...f[2]), corner(...f[3]),
        f[4], 0, 0, f[5] * uvScale, f[6] * uvScale,
      );
    }
  }

  toGeometry() {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
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
    this.group.name = 'trackside';
    this.rng = new Rng(0x59a17e05);
    this._geometries = [];
    this._materials = [];
    this._textures = [];
    // Flat [x, y, z] triples: marshal openings and camera positions want tyre stacks,
    // and collecting them here keeps every stack in one instanced mesh.
    this._tyreStacks = [];
    // Two cross-builder accumulators, closed out at the end of `build()`.
    //
    // Instancing is the right answer when one geometry repeats thousands of times, and
    // the wrong one when it repeats a dozen: an InstancedMesh of thirteen camera masts
    // costs exactly the draw call a merged mesh of thirteen camera masts costs. The
    // circuit was carrying seven such objects — fence rails, hoarding stiles, camera
    // masts, TV rigs, floodlight masts, braking-board posts and the stand fascia — none
    // of which was ever frustum-culled, because every one of them spans the whole seven
    // kilometres. They are all galvanised section or all printed vinyl, so they are two
    // meshes now instead of seven, for triangles that were being submitted anyway.
    this._steel = new MeshAccum();     // every piece of galvanised trackside section
    this._signs = new MeshAccum();     // everything printed on the vinyl sign atlas
    this._time = { value: 0 };
    this._wind = { value: new THREE.Vector2(1, 0.3) };
    this.tier = ctx.quality;

    // Night rig. Sites are collected by the builders that already walk the circuit, so
    // the floodlights land on the same posts and towers the daylight furniture uses.
    this._pylonSites = [];
    this._marshalSites = [];
    this._nightEmissive = [];      // [{ material, day, night }] — lerped by the sun
    this._nightAdditive = [];      // [{ material, gain }] — additive decals and glows
    this._nightMeshes = [];        // hidden outright when the sun is up
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
    // Both of the above contribute stack sites, so this has to follow them.
    this._buildTyreStacks();
    this._buildTrees();
    this._buildSpectatorAreas();
    // Last: the night rig lights what everything above has just built, and needs the
    // mast and marshal-post sites those builders collected on their way through.
    this._buildNightLighting();
    // Close out the two shared accumulators. Everything that fed them is static, so
    // this is the last thing the builder does and nothing after it can add to them.
    this._addMerged(this._steel, this._fenceRailMaterial(), 'tracksideSteel', false, false);
    this._addMerged(this._signs, this._signMaterial(), 'tracksideSigns', false);
    // Their arrays are a few megabytes of boxed JS numbers that the BufferAttributes
    // have already copied out; nothing may add to them after this point.
    this._steel = null;
    this._signs = null;
  }

  /** Draw calls this system contributes, for the frame budget in CONTRACT §8.4. */
  get drawCalls() {
    let n = 0;
    this.group.traverse((o) => { if (o.isMesh) n++; });
    return n;
  }

  /**
   * Re-skin the astroturf verge.
   *
   * The verge is built by `TrackMeshBuilder` from the shared `astroturf` material, and
   * the map it carried was a saturated primary green with no lighting cue in it — a
   * screaming band along the edge of every corner that read as a debug material rather
   * than as a mat someone laid. Real synthetic verge is a muted grey-olive with the pile
   * running along the road. Swapping the maps on the shared material rather than the
   * mesh keeps the geometry, the UV scale and the tile size the builder solved for, and
   * the mip chain and anisotropy are what take the fizz off its edges at distance.
   */
  _retextureVerge() {
    const materials = this.ctx.materials;
    const mat = materials.get('astroturf');
    if (!mat) return;
    const td = buildAstroturfVerge(512, 7700);
    const aniso = this._maxAnisotropy();
    const map = makeDataTexture(td.color, td.width, td.height, THREE.SRGBColorSpace, td.colorMips);
    const normalMap = makeDataTexture(td.normal, td.width, td.height, THREE.NoColorSpace);
    const ormMap = makeDataTexture(td.orm, td.width, td.height, THREE.NoColorSpace);
    ormMap.channel = 0;
    for (const t of [map, normalMap, ormMap]) {
      // The verge is a two-metre ribbon seen almost end-on for most of its length, which
      // is the worst case a trilinear sampler has: the footprint is tens of texels along
      // the road and one across it, so without a real anisotropic tap the strip either
      // shimmers at its edge or blurs into a flat swatch. This is the "aliased edges"
      // half of the note, and it is fixed by the sampler rather than by the artwork.
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
    mat.normalScale.set(1.0, 1.0);
    // A rough dielectric mat: it takes its ambient from the sky like everything else, so
    // it sits in the same light as the tarmac beside it instead of reading as a flat
    // unlit fill. Held below 1.0 because a synthetic pile scatters rather than reflects,
    // and any real specular lobe on it at grazing incidence is what used to make the
    // verge glow like a light source of its own.
    mat.envMapIntensity = 0.85;
    mat.needsUpdate = true;
  }

  // --- terrain --------------------------------------------------------------------

  /**
   * The heightfield. Vertices come from `surface.heightAt`, so near the circuit the mesh
   * is the circuit's own corridor and further out it is the Ardennes; the transition is
   * the same blend physics uses. Quads that fall entirely inside the apron are dropped
   * rather than drawn and z-fought.
   */
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
    const tile = this.ctx.materials.tileSize('grass', { u: 4, v: 4 });
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
            n[0] /= nl; n[1] /= nl; n[2] /= nl;
            acc.quad(
              [px, y00, pz], [px + s, y10, pz], [px + s, y11, pz + s], [px, y01, pz + s],
              n,
              px * uvScale, pz * uvScale, (px + s) * uvScale, (pz + s) * uvScale,
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

  /**
   * Grass, pushed a hair back in depth so the circuit's fine apron always wins, and
   * mown.
   *
   * The mowing stripes are not decoration. Infield grass with no cut pattern in it is a
   * single flat green field the eye reads as untextured no matter how good the close-up
   * material is, because the one thing every real circuit's infield has — and the thing
   * a camera at head height actually resolves — is the banding a gang mower leaves. The
   * pattern lives in the shader rather than the map because it has to be metres wide in
   * world space and the map tiles every four.
   */
  _terrainMaterial() {
    if (this._terrainMat) return this._terrainMat;
    const mat = this.ctx.materials.clone('grass');
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = 2;
    mat.polygonOffsetUnits = 6;
    mat.name = 'terrain';
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_MAP
  // The shared grass map carries a large-scale hue drift between green and a bare
  // grey-brown. Over a 10 m tile on 15 m terrain cells that drift lands as hard-edged
  // olive and khaki blotches twenty metres across — measured at rgb(144,171,109) two
  // metres from rgb(153,142,131) — which reads as a debug splat map rather than as a
  // field. Steering the chroma back onto one mown-grass green while keeping every bit
  // of the map's luminance detail is what turns those blotches into tonal variation.
  float grassLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
  diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.702, 1.160, 0.301 ) * grassLum, 0.55 );

  // Terrain UVs are world-scaled at 0.1 per metre, so one unit of UV is ten metres.
  // The cut pattern is the one thing a camera at head height actually resolves on
  // infield grass, and at plus or minus 11% it was inside the map's own noise. A gang
  // mower leaves a good deal more than that: the nap lies toward the machine on one
  // pass and away on the next, and the two directions differ by a quarter in tone.
  float mowAxis = ( vMapUv.x * 0.94 + vMapUv.y * 0.34 );
  float mowBand = smoothstep( -0.22, 0.22, sin( mowAxis * 9.0 ) );
  // Blocks: a gang mower turns at the end of a run, so the banding is not endless.
  float mowBlock = 0.55 + 0.45 * smoothstep( -0.3, 0.3, sin( mowAxis * 0.62 + vMapUv.y * 0.9 ) );
  float mow = mix( 0.845, 1.175, mowBand ) * mowBlock + ( 1.0 - mowBlock );
  // Large-scale tonal drift, so the field is not one value out to the treeline.
  float mowPatch = 1.0 + 0.055 * sin( vMapUv.x * 0.63 + 1.3 ) * sin( vMapUv.y * 0.47 + 2.1 );
  // Held out to 900 m. The infield opposite a broadcast camera is two to three hundred
  // metres away, which the old 420 m cut-off faded to nothing well before.
  float mowFade = 1.0 - smoothstep( 260.0, 900.0, length( vViewPosition ) );
  diffuseColor.rgb *= mix( 1.0, mow, mowFade ) * mowPatch;
#endif`);
    };
    mat.customProgramCacheKey = () => 'terrainMownV2';
    mat.needsUpdate = true;
    this._terrainMat = mat;
    return mat;
  }

  /**
   * The horizon: a radial skirt from the edge of the near grid out to 13 km, with the
   * relief flattening as it recedes so the far hills read as distance rather than as a
   * ring of noise.
   */
  _buildFarTerrain() {
    const surf = this.surface;
    const b = surf.bounds;
    const cx = (b.minX + b.maxX) * 0.5;
    const cz = (b.minZ + b.maxZ) * 0.5;
    const inner = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) * 0.5 + NEAR_TERRAIN_PAD - 60;

    const radial = 128;
    const rings = 26;
    const acc = new MeshAccum();
    const tile = this.ctx.materials.tileSize('grass', { u: 4, v: 4 });
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
        const a0 = (a / radial) * Math.PI * 2;
        const a1 = ((a + 1) / radial) * Math.PI * 2;
        const p0 = pointAt(r0, a0);
        const p1 = pointAt(r0, a1);
        const p2 = pointAt(r1, a1);
        const p3 = pointAt(r1, a0);
        acc.quad(p0, p1, p2, p3, [0, 1, 0],
          p0[0] * uvScale, p0[2] * uvScale, p2[0] * uvScale, p2[2] * uvScale);
      }
    }

    const geo = acc.toGeometry();
    geo.computeVertexNormals();
    this._geometries.push(geo);
    const mesh = new THREE.Mesh(geo, this._terrainMaterial());
    mesh.name = 'terrainFar';
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this._farInner = inner;
    this._centre = { x: cx, z: cz };
  }

  // --- sweeping helper ------------------------------------------------------------

  /**
   * Sweep a cross-section along a span of the centreline at a lateral offset. `profile`
   * is a list of [lateralOffset, height] pairs measured from the given base offset.
   */
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
      const d = from + ((end - from) * r) / rows;
      surf.sample(((d % surf.length) + surf.length) % surf.length / surf.length, loc);
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
        const nAcross = (dh / pl) * -side;
        const nUp = (-dd / pl) * -1;
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
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
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

  // --- swept paths ------------------------------------------------------------------

  /**
   * A swept path: a station list carrying the ground height, the outward horizontal
   * direction (away from the circuit) and the arc length travelled so far. Grandstand
   * decks, roofs, catch fencing and hoardings are all the same extrusion over one of
   * these, which is what lets them merge down into a handful of draw calls.
   */
  _makePath(n) {
    return {
      n,
      x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n),
      ox: new Float64Array(n), oz: new Float64Array(n),
      tx: new Float64Array(n), tz: new Float64Array(n),
      d: new Float64Array(n),
    };
  }

  _copyStation(src, i, dst, j) {
    dst.x[j] = src.x[i]; dst.y[j] = src.y[i]; dst.z[j] = src.z[i];
    dst.ox[j] = src.ox[i]; dst.oz[j] = src.oz[i];
    dst.tx[j] = src.tx[i]; dst.tz[j] = src.tz[i];
    dst.d[j] = src.d[i];
  }

  /** Stations along a span of the circuit, offset laterally to one side. */
  _trackPath(from, to, side, offset, step) {
    const surf = this.surface;
    let end = to;
    while (end < from) end += surf.length;
    const n = Math.max(2, Math.ceil((end - from) / step) + 1);
    const path = this._makePath(n);
    const loc = surf.createLocateResult();

    for (let i = 0; i < n; i++) {
      const dist = from + ((end - from) * i) / (n - 1);
      surf.sample((((dist % surf.length) + surf.length) % surf.length) / surf.length, loc);
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

  /** Stations from a barrier run the Barriers system already solved. */
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
      // Outward is away from the circuit, which is the barrier's track-facing normal negated.
      path.ox[i] = -tz * run.side;
      path.oz[i] = tx * run.side;
      path.d[i] = along;
    }
    return path;
  }

  /**
   * Extrude a `[outward, height]` cross-section along a path into a merged accumulator.
   *
   * `flipU` reverses the U axis. Signage must always read left-to-right for a driver
   * looking at it, and the driver on one side of the circuit sees the path running the
   * other way, so a UV setup that is symmetric in `side` mirrors every board on one
   * side of the track. That is the whole reason this argument exists.
   */
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
        acc.quad(put(a, r, c), put(b, r + 1, c), put(cc, r + 1, c + 1), put(d, r, c + 1),
          nrm, u0, vBias + pv[c] * vScale, u1, vBias + pv[c + 1] * vScale);
      }
    }
  }

  /** Close the end of a swept section down to the ground, so it reads as a solid. */
  _capPath(acc, path, profile, r, sign, uvScale) {
    const nrm = [path.tx[r] * sign, 0, path.tz[r] * sign];
    const a = [0, 0, 0], b = [0, 0, 0], c2 = [0, 0, 0], d = [0, 0, 0];
    for (let c = 0; c < profile.length - 1; c++) {
      const l0 = profile[c][0], h0 = profile[c][1];
      const l1 = profile[c + 1][0], h1 = profile[c + 1][1];
      if (Math.abs(l1 - l0) < 1e-4 || (h0 < 1e-4 && h1 < 1e-4)) continue;
      a[0] = path.x[r] + path.ox[r] * l0; a[1] = path.y[r]; a[2] = path.z[r] + path.oz[r] * l0;
      b[0] = path.x[r] + path.ox[r] * l1; b[1] = path.y[r]; b[2] = path.z[r] + path.oz[r] * l1;
      c2[0] = b[0]; c2[1] = path.y[r] + h1; c2[2] = b[2];
      d[0] = a[0]; d[1] = path.y[r] + h0; d[2] = a[2];
      acc.quad(a, b, c2, d, nrm, l0 * uvScale, 0, l1 * uvScale, Math.max(h0, h1) * uvScale);
    }
  }

  /** One flat plate closing the end of a slab, in the path's (outward, height) frame. */
  _endQuad(acc, path, r, sign, pts) {
    const nrm = [path.tx[r] * sign, 0, path.tz[r] * sign];
    const w = [0, 1, 2, 3].map((i) => [
      path.x[r] + path.ox[r] * pts[i][0],
      path.y[r] + pts[i][1],
      path.z[r] + path.oz[r] * pts[i][0],
    ]);
    acc.quad(w[0], w[1], w[2], w[3], nrm, 0, 0, 1, 1);
  }

  /** Walk a path at a fixed metre spacing, emitting an instance matrix at each stop. */
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

  // --- grandstands ----------------------------------------------------------------

  /**
   * The stands. Every one of them lands in the same four accumulators — profiled steel
   * shell, dark interior, sponsor fascia, and two instance lists for the frame — so the
   * eight grandstands around Spa cost six draw calls between them including the crowd.
   */
  _buildGrandstands() {
    const materials = this.ctx.materials;
    const shell = new MeshAccum();
    const inner = new MeshAccum();
    // The stand fascia is printed on the same vinyl atlas as the barrier hoardings and
    // shares their mesh; `build()` closes that accumulator out.
    const fascia = this._signs;
    const columns = [];
    const beams = [];
    const crowd = { matrices: [], data: [], shade: [] };
    const detail = clamp01(this.tier?.crowdDetail ?? 1);

    for (const stand of this.track.circuit.grandstands) {
      this._buildStand(stand, shell, inner, fascia, columns, beams, crowd, detail);
    }

    this._addMerged(shell, materials.get('grandstand'), 'standShell', true);
    this._addMerged(inner, this._standInteriorMaterial(), 'standInterior', false);

    if (columns.length) {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      this._geometries.push(geo);
      this._instance(geo, this._standInteriorMaterial(), columns, 'standColumns', true);
    }
    if (beams.length) {
      const geo = new THREE.BoxGeometry(1, 1, 1);
      this._geometries.push(geo);
      this._instance(geo, this._standBeamMaterial(), beams, 'standRoofBeams', false);
    }
    this._collectBankCrowd(crowd, detail);
    if (crowd.matrices.length) this._buildCrowd(crowd);
  }

  /**
   * Dark, matte concrete for everything inside the stand: the rake, the soffit and the
   * end walls. A stand lit like its own cladding reads as a flat card; the depth comes
   * from the interior staying several stops below the outside.
   */
  _standInteriorMaterial() {
    if (this._standInner) return this._standInner;
    const mat = this.ctx.materials.clone('concrete');
    mat.color.setHex(0x45474c);
    mat.roughness = 1.0;
    mat.side = THREE.DoubleSide;   // the rear wall and soffit are seen from both hands
    mat.name = 'stand_interior';
    this._standInner = mat;
    return mat;
  }

  /**
   * Roof trusses read as structure only if they sit darker than the soffit behind them.
   * Galvanised steel here turned the underside of the roof into a venetian blind.
   */
  _standBeamMaterial() {
    if (this._standBeam) return this._standBeam;
    const mat = this.ctx.materials.clone('metal_anodised');
    mat.color.setHex(0x2e3136);
    mat.roughness = 0.72;
    mat.name = 'stand_truss';
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

    // The raked deck: a riser and a tread per row, with a walkway at each end of it.
    const rake = [[0, STAND_FRONT], [STAND_WALK, STAND_FRONT]];
    for (let r = 0; r < rows; r++) {
      rake.push([STAND_WALK + r * STAND_TREAD, STAND_FRONT + (r + 1) * STAND_RISER]);
      rake.push([STAND_WALK + (r + 1) * STAND_TREAD, STAND_FRONT + (r + 1) * STAND_RISER]);
    }
    rake.push([backLat, deckTop]);
    this._sweepPath(inner, path, rake, 1 / 6, 1 / 3);

    // Profiled steel: the front wall under the first row, the back wall, and the roof.
    this._sweepPath(shell, path, [[0, 0], [0, STAND_FRONT]], 1 / 6, 1 / 3);
    this._sweepPath(shell, path, [[backLat, deckTop], [backLat, roofBackY - 0.75]], 1 / 6, 1 / 3);
    // The roof deck is dark, and not for a daylight reason: it is the only large upward
    // facing surface behind the barrier, so any floodlight beside the stand lights it
    // from above, and from the car it is seen exactly edge-on. Bright cladding up there
    // draws a clipped white line along the top of the stand for its whole length.
    this._sweepPath(inner, path, [[roofFrontLat, roofFrontY], [roofBackLat, roofBackY]], 1 / 6, 1 / 6);
    this._sweepPath(shell, path, [[roofFrontLat, roofFrontY - 0.75], [roofFrontLat, roofFrontY]], 1 / 6, 1 / 3);
    this._sweepPath(shell, path, [[roofBackLat, roofBackY], [roofBackLat, roofBackY - 0.6]], 1 / 6, 1 / 3);
    // Soffit, swept back to front so its faces point down at the crowd.
    this._sweepPath(inner, path, [[roofBackLat, roofBackY - 0.6], [roofFrontLat, roofFrontY - 0.75]], 1 / 6, 1 / 3);

    // End walls, so the stand is a building rather than an infinitely extruded card.
    const outline = [[0, 0]].concat(rake, [[backLat, roofBackY - 0.75]]);
    this._capPath(inner, path, outline, 0, -1, 1 / 6);
    this._capPath(inner, path, outline, path.n - 1, 1, 1 / 6);
    const roofEnd = [
      [roofFrontLat, roofFrontY - 0.75], [roofBackLat, roofBackY - 0.6],
      [roofBackLat, roofBackY], [roofFrontLat, roofFrontY],
    ];
    this._endQuad(shell, path, 0, -1, roofEnd);
    this._endQuad(shell, path, path.n - 1, 1, roofEnd);

    // Advertising along the front wall, one hoarding per station, each a different row
    // of the atlas so a two-hundred-metre stand is not one wordmark repeated.
    const boardRows = this._signMaterial().userData.rows;
    const bandV = 1 / boardRows;
    const board = this._makePath(2);
    // Same folded frame as the barrier hoardings, scaled to the taller stand fascia.
    const fasciaProfile = [
      [-0.06, 0.411], [-0.20, 0.550], [-0.20, 1.950], [-0.06, 2.089],
    ];
    let fasciaLength = 0;
    for (let c = 1; c < fasciaProfile.length; c++) {
      fasciaLength += Math.hypot(fasciaProfile[c][0] - fasciaProfile[c - 1][0],
        fasciaProfile[c][1] - fasciaProfile[c - 1][1]);
    }
    for (let r = 0; r < path.n - 1; r++) {
      this._copyStation(path, r, board, 0);
      this._copyStation(path, r + 1, board, 1);
      board.d[0] = 0;
      board.d[1] = path.d[r + 1] - path.d[r];
      const row = this.rng.int(0, boardRows - 1);
      this._sweepPath(fascia, board, fasciaProfile,
        1 / (board.d[1] || 1), bandV / fasciaLength, flipU, row * bandV);
    }

    // Columns to the roof at the back, and the beams they carry across the soffit.
    this._instancesAlong(frame, STAND_FRAME_STATION * 2, roofBackY * 0.5, backLat + 0.5,
      0.42, roofBackY, 0.42, columns);
    // One truss per column bay rather than a purlin every few metres: closely spaced
    // bars under a lit soffit alias into stripes long before they read as structure.
    const beamSpan = roofBackLat - roofFrontLat;
    this._instancesAlong(frame, STAND_FRAME_STATION * 2, roofFrontY - 1.10,
      (roofFrontLat + roofBackLat) * 0.5, beamSpan, 0.55, 0.28, beams);

    this._collectCrowd(stand, offset, detail, crowd);
  }

  /**
   * Spectators, placed on the grid the stand is actually built on: a column every seat
   * strip along the rake, a row per tier. Real grandstands are visibly gridded and the
   * eye picks that up long before it picks up a face, so scattering the crowd is what
   * made it read as noise.
   */
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
    const atlas = this.ctx.materials.get('crowd').userData.atlas ?? { cols: 4, rows: 4 };
    const cells = atlas.cols * atlas.rows;

    for (let j = 0; j < cols; j++) {
      const d = stand.from + (span * (j + 0.5)) / cols;
      surf.sample((((d % surf.length) + surf.length) % surf.length) / surf.length, loc);
      const baseX = loc.position.x + loc.right.x * stand.side * offset;
      const baseZ = loc.position.z + loc.right.z * stand.side * offset;
      const baseY = surf.heightAt(baseX, baseZ);

      for (let r = 0; r < rows; r += rowStep) {
        // A few gaps in the grid: a full house with no empty seats reads as wallpaper.
        if (rng.next() < 0.055) continue;

        const lateral = stand.side * (offset + STAND_WALK + (r + 0.62) * STAND_TREAD);
        // Only a slight shuffle along the row — enough to break the ruler-straight
        // columns, not enough to lose the grid that makes it read as seating.
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
          (cell % atlas.cols) / atlas.cols,
          Math.floor(cell / atlas.cols) / atlas.rows,
          rng.next(),
          0.95 + rng.next() * 0.11,
        );

        // The back of the rake lives under the roof, so it loses most of its skylight.
        const depthF = rows > 1 ? r / (rows - 1) : 0;
        const lit = (0.80 + rng.next() * 0.20) * (1 - 0.32 * smoothstep(0.30, 1.0, depthF));
        crowd.shade.push(lit * (1 + rng.signed(0.04)), lit, lit * (1 + rng.signed(0.04)));
      }
    }
  }

  /**
   * Crowd billboards: one instanced quad per seat strip, turned to face the camera in
   * the vertex shader with a slow per-instance bob and sway.
   *
   * The fragment half is the important part. Saturated per-pixel colour at distance is
   * exactly what makes a stand fizz, so the card blends toward a muted average and the
   * alpha cutout closes up as the stand recedes — a stand at two hundred metres should
   * be a warm grey mass with structure in it, not a field of coloured sparkles.
   */
  _buildCrowd(crowd) {
    const geo = new THREE.PlaneGeometry(CROWD_CELL_W, CROWD_CELL_H);
    this._geometries.push(geo);

    const atlas = this.ctx.materials.get('crowd').userData.atlas ?? { cols: 4, rows: 4 };
    const material = this.ctx.materials.clone('crowd');
    material.name = 'crowd_instanced';
    const time = this._time;
    const cols = atlas.cols;
    const rows = atlas.rows;

    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = time;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
uniform float uTime;
attribute vec4 aCrowd;
varying float vCrowdFade;`)
        .replace('#include <uv_vertex>', `#include <uv_vertex>
#ifdef USE_MAP
  vMapUv = vMapUv * vec2(${(1 / cols).toFixed(6)}, ${(1 / rows).toFixed(6)}) + aCrowd.xy;
#endif`)
        .replace('#include <project_vertex>', `
vec4 crowdCentre = instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
crowdCentre = modelViewMatrix * crowdCentre;
float crowdBob = sin( uTime * ( 1.7 + aCrowd.z ) + aCrowd.z * 31.4 ) * 0.032;
float crowdSway = sin( uTime * ( 0.8 + aCrowd.z * 0.6 ) + aCrowd.z * 17.3 ) * 0.05;
vec4 mvPosition = crowdCentre + vec4(
  ( transformed.x + crowdSway * transformed.y ) * aCrowd.w,
  ( transformed.y + crowdBob ) * aCrowd.w, 0.0, 0.0 );
vCrowdFade = smoothstep( 45.0, 240.0, -crowdCentre.z );
gl_Position = projectionMatrix * mvPosition;`)
        // A card that always faces the camera needs a normal that does too, or the sun
        // rakes across the stand and half the crowd goes black.
        .replace('#include <defaultnormal_vertex>', `
vec3 transformedNormal = normalize( vec3( 0.0, 0.45, 0.89 ) );`);

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vCrowdFade;')
        .replace('#include <map_fragment>', `#include <map_fragment>
float crowdLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
vec3 crowdFar = mix( vec3( crowdLum ), vec3( 0.160, 0.150, 0.138 ), 0.62 ) * 0.88;
diffuseColor.rgb = mix( diffuseColor.rgb, crowdFar, vCrowdFade * 0.92 );`)
        // A per-pixel cutout on a card four pixels tall is sub-pixel noise. Let the
        // silhouette close up with distance instead of sparkling along its edges.
        .replace('#include <alphatest_fragment>', `
if ( diffuseColor.a < mix( 0.42, 0.14, vCrowdFade ) ) discard;`);
    };
    material.customProgramCacheKey = () => 'crowdBillboardV2';
    material.needsUpdate = true;

    const count = crowd.matrices.length;
    const mesh = new THREE.InstancedMesh(geo, material, count);
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, crowd.matrices[i]);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.geometry.setAttribute('aCrowd',
      new THREE.InstancedBufferAttribute(new Float32Array(crowd.data), 4));
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(crowd.shade), 3);
    mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.name = 'crowd';
    this.group.add(mesh);
    this._crowd = mesh;
  }

  /** Turn a filled accumulator into one merged mesh, or nothing if it stayed empty. */
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

  // --- spectator areas ------------------------------------------------------------

  /**
   * Where the public stands.
   *
   * The circuit data already carves clearings out of the forest at every spectator
   * enclosure, and until now those clearings were simply holes: no trees, no ground
   * furniture, nothing. From the car that read as the world stopping at the barrier,
   * which is half of why the review called the whole scene thin. What goes in them is
   * what is actually there at Spa — stepped earth terracing on the hillside opposite the
   * grandstand, people standing on it, and the hospitality and TV compound behind.
   *
   * The terracing and the marquees are one merged mesh each and the standing crowd is
   * folded into the grandstand crowd's instanced mesh, so the whole thing is two draws.
   */
  _spectatorBanks() {
    if (this._banks) return this._banks;
    const surf = this.surface;
    const loc = surf.createLocateResult();
    const scale = surf.length / this.track.layout.analyticLength;
    const banks = [];

    for (const c of this.track.circuit.clearings) {
      const centre = ((c.at * scale) % surf.length + surf.length) % surf.length;

      // Terracing goes opposite whatever grandstand shares this enclosure: a bank
      // behind a stand is invisible, and the two together give the corner both hands.
      let taken = 0;
      for (const stand of this.track.circuit.grandstands) {
        const from = stand.from * scale;
        let to = stand.to * scale;
        while (to < from) to += surf.length;
        let at = centre;
        while (at < from) at += surf.length;
        if (at <= to + 60) { taken = stand.side; break; }
      }
      const side = taken !== 0 ? -taken : (banks.length % 2 === 0 ? 1 : -1);

      surf.sample(centre / surf.length, loc);
      _v.copy(loc.position);
      surf.locate(_v, loc);
      const idx = loc.index * 2 + (side > 0 ? 1 : 0);
      const offset = loc.width + surf.kerbWidth[idx] + surf.astroWidth[idx]
        + Math.min(34, surf.runoffWidth[idx]) + 5.0;
      const span = Math.min(c.radius * 1.15, 175);
      banks.push({
        side,
        offset,
        from: centre - span * 0.5,
        to: centre + span * 0.5,
        span,
      });
    }

    this._banks = banks;
    return banks;
  }

  /** The terrace cross-section, as (outward, height) pairs from the barrier line out. */
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
    // The crest and the ground falling away behind it, so the bank is a landform.
    profile.push([lat + 5.0, hgt + 0.5]);
    profile.push([lat + 13.0, hgt + 0.2]);
    this._bankSection = profile;
    return profile;
  }

  _buildSpectatorAreas() {
    const banks = this._spectatorBanks();
    if (!banks.length) return;
    const profile = this._bankProfile();
    const earth = new MeshAccum();
    const units = new MeshAccum();
    const rng = new Rng(0x41b7d902);

    for (const bank of banks) {
      const path = this._trackPath(bank.from, bank.to, bank.side, bank.offset, 10);
      this._sweepPath(earth, path, profile, 1 / 6, 1 / 6);
      this._capPath(earth, path, profile, 0, -1, 1 / 6);
      this._capPath(earth, path, profile, path.n - 1, 1, 1 / 6);
      this._collectCompound(units, path, profile, rng);
    }

    this._addMerged(earth, this._bankMaterial(), 'spectatorBanks', false, true);
    // No shadow: the compound stands behind the crest of its own bank, so the only thing
    // it could shade is ground nothing ever sees, and a merged mesh this long is never
    // culled out of a cascade.
    this._addMerged(units, this._compoundMaterial(), 'spectatorCompound', false, true);
  }

  /**
   * Hospitality marquees and the TV compound behind the crest of every bank. Gable
   * roofs rather than boxes: a flat-topped block at this distance reads as a container,
   * and a row of containers is what a paddock looks like from the air, not from a car.
   */
  _collectCompound(acc, path, profile, rng) {
    // Behind the crest and down the back slope, not on top of it. A unit sitting on the
    // skyline above a spectator bank is nine metres of white roof drawn across the
    // treeline, which is what the first pass of this did.
    const crest = profile[profile.length - 1];
    const back = crest[0] + 3.0;
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
      // Find the two stations bracketing this unit; a marquee is short enough that its
      // ends can just ride the path rather than being solved for independently.
      let r0 = 0;
      while (r0 < path.n - 2 && path.d[r0 + 1] < along) r0++;
      let r1 = r0;
      while (r1 < path.n - 1 && path.d[r1] < along + length) r1++;
      if (r1 <= r0) { along += length + 6; continue; }

      const width = 6.0 + rng.next() * 3.5;
      const eaves = crest[1] + 2.15 + rng.next() * 0.5;
      const ridge = eaves + 1.15 + rng.next() * 0.6;
      const near = back;
      const far = back + width;
      const mid = (near + far) * 0.5;

      // Two long walls, two gable ends, two roof planes.
      for (const [lat, sign] of [[near, -1], [far, 1]]) {
        nrm[0] = path.ox[r0] * sign; nrm[1] = 0; nrm[2] = path.oz[r0] * sign;
        acc.quad(put(a, r0, lat, 0), put(b, r1, lat, 0), put(c, r1, lat, eaves),
          put(d, r0, lat, eaves), nrm, 0, 0, length * 0.25, eaves * 0.25);
      }
      for (const [r, sign] of [[r0, -1], [r1, 1]]) {
        nrm[0] = path.tx[r] * sign; nrm[1] = 0; nrm[2] = path.tz[r] * sign;
        acc.quad(put(a, r, near, 0), put(b, r, far, 0), put(c, r, far, eaves),
          put(d, r, near, eaves), nrm, 0, 0, width * 0.25, eaves * 0.25);
        acc.quad(put(a, r, near, eaves), put(b, r, far, eaves), put(c, r, mid, ridge),
          put(d, r, mid, ridge), nrm, 0, 0, width * 0.25, 0.4);
      }
      for (const [lat, sign] of [[near, -1], [far, 1]]) {
        const rise = ridge - eaves;
        const run = width * 0.5;
        const inv = 1 / Math.hypot(rise, run);
        nrm[0] = path.ox[r0] * sign * (rise * inv); nrm[1] = run * inv; nrm[2] = path.oz[r0] * sign * (rise * inv);
        acc.quad(put(a, r0, lat, eaves), put(b, r1, lat, eaves), put(c, r1, mid, ridge),
          put(d, r0, mid, ridge), nrm, 0, 0, length * 0.25, run * 0.25);
      }

      along += length + 16 + rng.next() * 30;
    }
  }

  /** Trodden grass on made-up ground: browner and flatter than the infield. */
  _bankMaterial() {
    if (this._bankMat) return this._bankMat;
    const mat = this.ctx.materials.clone('grass');
    // Trodden down, but not bleached. At 0xb2b09c this tinted the grass map to a 0.70
    // luminance, and a terraced hillside that bright inside a dark forest reads as a
    // pale staircase hanging in the treeline rather than as ground — it was one of the
    // three things making the skyline look like a collection of flat cards.
    mat.color.setHex(0x8a8574);
    mat.roughness = 1.0;
    mat.envMapIntensity = 0.75;
    mat.name = 'spectator_bank';
    this._bankMat = mat;
    return mat;
  }

  /** Marquee fabric: bright, matte, and never quite white after a wet weekend. */
  _compoundMaterial() {
    if (this._compoundMat) return this._compoundMat;
    const mat = this.ctx.materials.clone('concrete');
    // Off-white, a stop and a half below the sky it is seen against. Marquee canvas
    // rendered near-white put a flat pale slab in the middle of the treeline that read
    // as an untextured quad long before it read as a hospitality unit.
    mat.color.setHex(0xa9a69c);
    mat.roughness = 0.92;
    mat.envMapIntensity = 0.85;
    mat.name = 'spectator_compound';
    this._compoundMat = mat;
    return mat;
  }

  /**
   * Standing spectators on the terracing, folded into the grandstand crowd's instanced
   * mesh so the whole public costs one draw between them.
   */
  _collectBankCrowd(crowd, detail) {
    const banks = this._spectatorBanks();
    if (!banks.length) return;
    const surf = this.surface;
    const loc = surf.createLocateResult();
    const rng = this.rng;
    const atlas = this.ctx.materials.get('crowd').userData.atlas ?? { cols: 4, rows: 4 };
    const cells = atlas.cols * atlas.rows;
    const colPitch = CROWD_CELL_W / clamp(detail, 0.34, 1);
    const rowStep = detail >= 0.9 ? 1 : detail >= 0.45 ? 2 : 3;

    for (const bank of banks) {
      const cols = Math.max(2, Math.round(bank.span / colPitch));
      for (let j = 0; j < cols; j++) {
        const d = bank.from + (bank.span * (j + 0.5)) / cols;
        surf.sample((((d % surf.length) + surf.length) % surf.length) / surf.length, loc);
        const baseX = loc.position.x + loc.right.x * bank.side * bank.offset;
        const baseZ = loc.position.z + loc.right.z * bank.side * bank.offset;
        const baseY = surf.heightAt(baseX, baseZ);

        for (let r = 0; r < BANK_ROWS; r += rowStep) {
          // A hillside is not a ticketed seat: it fills unevenly, and the gaps are most
          // of what makes it read as a bank of people rather than a printed texture.
          if (rng.next() < 0.34) continue;
          const lateral = bank.side * (bank.offset + 1.8 + (r + 0.55) * BANK_TREAD);
          const jitter = rng.signed(0.45);
          const x = loc.position.x + loc.right.x * lateral + loc.tangent.x * jitter;
          const z = loc.position.z + loc.right.z * lateral + loc.tangent.z * jitter;
          const y = baseY + (r + 1) * BANK_RISE + CROWD_CELL_H * 0.5 - 0.10;

          _v.set(x, y, z);
          _q.identity();
          _scale.set(1, 1, 1);
          _m.compose(_v, _q, _scale);
          crowd.matrices.push(_m.clone());

          const cell = rng.int(0, cells - 1);
          crowd.data.push(
            (cell % atlas.cols) / atlas.cols,
            Math.floor(cell / atlas.cols) / atlas.rows,
            rng.next(),
            0.95 + rng.next() * 0.11,
          );
          // Open sky over a bank, so these sit a shade brighter than the roofed rake.
          const lit = 0.90 + rng.next() * 0.16;
          crowd.shade.push(lit * (1 + rng.signed(0.04)), lit, lit * (1 + rng.signed(0.04)));
        }
      }
    }
  }

  // --- pit complex ----------------------------------------------------------------

  _buildPitComplex() {
    const materials = this.ctx.materials;
    const pitMat = materials.get('pit_building');
    const spec = this.track.circuit.pitLane;
    const from = spec.buildingFrom;
    const to = spec.buildingTo;
    const outer = spec.buildingOffset;

    // Garage frontage and the upper storey behind it.
    this._sweepProfile(from, to, 1, outer, [
      [0, 0], [0, 4.4], [1.2, 5.0], [1.2, 9.6], [0.4, 10.2], [0.4, 10.6], [9.0, 10.6],
    ], pitMat, 'pitBuilding', 1 / 8, 1 / 4, true);

    // Garage doors: a recessed dark band along the ground floor.
    const doorMat = materials.clone('metal_anodised');
    doorMat.color.setHex(0x24262c);
    doorMat.roughness = 0.5;
    doorMat.name = 'garage_door';
    this._sweepProfile(from, to, 1, outer - 0.35, [
      [0, 0.15], [0, 4.1], [0.3, 4.3],
    ], doorMat, 'pitGarages', 1 / 4, 1 / 4, false);

    // Pit wall: the low concrete wall the teams sit behind, between lane and track.
    const wallMat = materials.get('concrete');
    this._sweepProfile(from, to, 1, spec.pitWallOffset, [
      [0, 0], [0, 1.05], [0.35, 1.12], [0.35, 0],
    ], wallMat, 'pitWall', 1 / 4, 1 / 2, true);
  }

  // --- fencing, signage, furniture -------------------------------------------------

  /**
   * Catch fencing. The mesh panels, the rails that tension them and the posts are three
   * objects for the whole circuit: one merged alpha-tested sheet, one merged rail run,
   * and one instance list. Posts land every three metres of arc length rather than every
   * n-th barrier sample, because the barrier sampler spaces its points by curvature and
   * that put posts anywhere between ten and forty metres apart.
   */
  _buildFences() {
    const runs = this.track._barriers?.runs ?? [];
    const panels = new MeshAccum();
    // The tensioning rails go into the shared galvanised-section mesh with the hoarding
    // stiles, the camera and floodlight masts and the braking-board posts; `build()`
    // closes that accumulator out.
    const rails = this._steel;
    const postMatrices = [];
    const railTop = FENCE_FOOT + FENCE_HEIGHT;
    const mesh = this._fenceMeshMaterial();
    const tileU = mesh.userData.tileU;
    const tileV = mesh.userData.tileV;

    for (const run of runs) {
      if (run.type === 'tyre') continue;
      if (run.points.length / 3 < 4) continue;
      const path = this._runPath(run);

      // The mesh is drawn in two bands split at the mid rail. One tall band would be
      // fine visually, but two lets the V origin restart at the rail, which is where a
      // real panel's weave restarts because that is where it is clamped.
      this._sweepPath(panels, path, [[0, FENCE_FOOT], [0, FENCE_RAIL_MID]], 1 / tileU, 1 / tileV);
      this._sweepPath(panels, path, [[0, FENCE_RAIL_MID], [0, railTop]], 1 / tileU, 1 / tileV);

      // Three tensioning rails, each a box section rather than a ribbon: the upward
      // face is the whole point, because that is the surface a low sun lands on and the
      // line of light along the top of a catch fence is what makes it read as structure.
      this._fenceRail(rails, path, railTop, 0.075);
      this._fenceRail(rails, path, FENCE_RAIL_MID, 0.055);
      this._fenceRail(rails, path, FENCE_FOOT, 0.055);

      this._instancesAlong(path, FENCE_POST_SPACING, 0, 0, 1, 1, 1, postMatrices);
    }

    // Neither takes a shadow: the panels are a kilometres-long alpha-tested sheet and
    // the rails are 80 mm of steel, so the lookup buys nothing anyone can see.
    this._addMerged(panels, mesh, 'catchFence', false, false);

    if (postMatrices.length) {
      // No shadow: a 100 mm post throws nothing worth three cascades of fill rate, and
      // there are several thousand of them around the circuit.
      this._instance(this._fencePostGeometry(), this._fenceRailMaterial(), postMatrices,
        'fencePosts', false);
    }
  }

  /** One rail: front face, top face and back face, so it has a lit edge from any hand. */
  _fenceRail(acc, path, height, half) {
    this._sweepPath(acc, path, [
      [-0.06, height - half], [-0.06, height + half],
      [0.06, height + half], [0.06, height - half],
    ], 1 / 1.5, 1 / 0.25);
  }

  /**
   * A fence post as a rolled I-section, which is what debris fencing actually stands on.
   * A plain box at this size reads as a stick; the flanges give it two lit faces and a
   * shaded web, and that is enough to say "steel section" at fifty metres.
   */
  _fencePostGeometry() {
    if (this._fencePost) return this._fencePost;
    const acc = new MeshAccum();
    const h = FENCE_HEIGHT + FENCE_FOOT - 0.10;
    const cy = 0.35 + h * 0.5;
    // Local +X is across the circuit and +Z along it, so the flanges lie in the plane of
    // the fence — which is how an H-section post is actually oriented on a fence line.
    acc.box(-0.055, cy, 0, 0.018, h, 0.13, 0, 1.5);
    acc.box(0.055, cy, 0, 0.018, h, 0.13, 0, 1.5);
    acc.box(0, cy, 0, 0.092, h, 0.020, 0, 1.5);
    acc.box(0, 0.30, 0, 0.24, 0.10, 0.24, 0, 1.5);      // base plate onto the barrier
    const geo = acc.toGeometry();
    this._geometries.push(geo);
    this._fencePost = geo;
    return geo;
  }

  /**
   * The mesh itself — a *blended* veil, not an alpha-tested cutout.
   *
   * This is the fix for "a row of vertical posts with nothing between them". The sheet
   * was alpha-tested with a coverage-renormalised mip chain, and that chain collapsed:
   * measured on the shipped texture, coverage held at 0.31-0.39 down to the 16x16 level
   * and then read 0.000 at 8x8, because by then every texel in the tile sat within three
   * units of the cutoff and one more level of filtering pushed the whole sheet under it
   * at once. A trackside camera looks *along* a fence, so the anisotropic footprint runs
   * straight into those levels within thirty or forty metres and the entire mesh
   * discarded, leaving the posts and rails (solid geometry) standing in mid air.
   *
   * A blended veil has no cutoff to fall off. `veilMipChain` averages alpha linearly and
   * colour weighted by alpha, so the sheet holds a measured 0.233 optical density at
   * every level from 512 down to 1x1: a crisp lattice near the camera that becomes a
   * uniform grey haze at distance, which is exactly what a real debris fence does.
   *
   * `depthWrite` is off and `depthTest` is on, which is the pair that matters: the fence
   * is still correctly hidden behind anything opaque in front of it, and it no longer
   * writes a depth value that would make one panel of a single merged sheet occlude
   * another panel of itself in an arbitrary triangle order.
   *
   * ---------------------------------------------------------------------------------
   * Round 6. The veil was still invisible, and this is why, measured rather than
   * reasoned about. The geometry was never the problem: the built sheet carries 6,060
   * triangles — two bands per barrier station over every non-tyre run on the circuit —
   * and the mesh is `visible`, in frustum and blended. Two things cancelled it out.
   *
   *  1. `metalness: 1.0`. A fully metallic surface has no diffuse term at all, so the
   *     wire's entire appearance was a rough mirror of an environment bound at ~0.5
   *     intensity against a sun of 3.75. Measured on round 5's trackside-sweep, the
   *     tarmac read 99-112 through the panels and 99-112 either side of them: the veil
   *     was compositing a colour indistinguishable from the road behind it. A fence you
   *     cannot see is a fence with no contrast, not a fence with no alpha. Galvanised
   *     wire a season old is mostly a diffuse grey — the same call the rails already
   *     make one method below — so the metalness comes down and the sun lands on it.
   *
   *  2. A flat 0.233 optical density at every angle. 0.233 is the correct *normal-
   *     incidence* coverage of 4.6 mm wire on a 50 mm weave, and it is the wrong number
   *     for almost every frame this fence appears in: a trackside camera, and a driver
   *     looking up the road, both see the sheet at a raking angle and therefore look
   *     through several apertures' worth of wire, not one. The sheet is a participating
   *     medium and its coverage obeys Beer-Lambert — `a' = 1 - (1-a)^(1/cos t)` — so the
   *     patch below scales the path length through the weave by the incidence angle of
   *     the *geometric* panel normal. Head-on it is exactly the 0.233 the texture
   *     authors; at 70 degrees off-normal, which is what the reviewed frame was, it is
   *     0.52; and it saturates at 0.79 rather than going opaque. That is what makes the
   *     mesh read at 200 m, where a fence is only ever seen nearly edge-on.
   */
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
      map, normalMap, roughnessMap: ormMap, metalnessMap: ormMap, aoMap: ormMap,
      // The ORM map carries the gloss and the metal fraction; these are the multipliers
      // on it. Metalness well below unity is the point: it is what leaves a diffuse
      // term for the sun to land on, so the sheet reads as light grey against tarmac
      // and dark grey against sky instead of borrowing whatever is behind it.
      roughness: 1.0, metalness: 0.42,
      // A tiny cutoff only to skip the texels that are pure aperture; the shading of the
      // wire itself is carried entirely by the blend.
      alphaTest: 0.02, transparent: true, depthWrite: false, side: THREE.DoubleSide,
      // Same figure the rails use, and for the same reason: the shaded hand of a fence
      // receives almost nothing from a 0.52-intensity environment, and an unlit veil is
      // indistinguishable from no veil.
      envMapIntensity: 1.25, name: 'catch_fence_mesh',
    });
    mat.normalScale.set(1.0, 1.0);
    // Beer-Lambert through the weave. `vNormal` is the panel's own normal — flat, and
    // deliberately not the normal-mapped one, because what is being measured here is
    // how obliquely the ray crosses the *sheet*, not the crown of one strand.
    // `vViewPosition` is the fragment-to-eye vector three already interpolates for the
    // specular term, so this costs a dot, a divide and a pow and no new varying.
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          float apexCosT = abs( dot( normalize( vNormal ), normalize( vViewPosition ) ) );
          float apexPath = 1.0 / max( apexCosT, ${FENCE_GRAZE_FLOOR.toFixed(3)} );
          diffuseColor.a = 1.0 - pow( max( 1.0 - diffuseColor.a, 0.0 ), apexPath );
        }`,
      );
    };
    mat.customProgramCacheKey = () => 'apex_fence_veil';
    mat.userData.tileU = td.tileU;
    mat.userData.tileV = td.tileV;
    this._materials.push(mat);
    this._fenceMesh = mat;
    return mat;
  }

  /**
   * Rails and posts.
   *
   * Measured on the reviewed frame, the posts rendered at rgb(0,1,2) — solid black
   * silhouettes against 150-grey tarmac — while the rails beside them, on the same
   * material, came back at 135. That is what 0.72 metalness does to a near-vertical
   * face: a metal has no diffuse term at all, so its whole appearance is the environment
   * it reflects, and a fence post reflects the dark ground in front of it, not the sky.
   * Galvanising that has stood a season is a rough, largely diffuse grey, so the
   * metalness comes down to where the section still picks up a sheen along its lit edge
   * without turning into a mirror of the tarmac. Kept well short of raw metal for the
   * night rig's sake: bright steel at grazing incidence under a floodlight turns
   * kilometres of section into blown-white catenaries across the middle of the frame.
   */
  _fenceRailMaterial() {
    if (this._fenceRailMat) return this._fenceRailMat;
    const mat = this.ctx.materials.clone('metal_raw');
    mat.color.setHex(0x8d939b);
    mat.roughness = 0.50;
    mat.metalness = 0.45;
    // Well above unity, deliberately. Measured in scene, the environment is bound at
    // 0.52 intensity against a sun of 3.75, so a vertical face on the shaded hand of the
    // fence receives almost nothing: the posts came back at rgb(1,4,10) against 132-grey
    // tarmac, which is not a dark post, it is an unlit one. Galvanised section is one of
    // the few things trackside that is genuinely specular, and letting it take more of
    // the sky is what puts the sheen back on the lit edge and a readable value — rather
    // than pure black — on the shaded one.
    mat.envMapIntensity = 1.25;
    mat.name = 'fence_rail';
    this._fenceRailMat = mat;
    return mat;
  }

  /**
   * The largest anisotropy the device will give us.
   *
   * Everything trackside is seen at a raking angle — a verge running away down the
   * inside of a corner, a fence looked along rather than at — and that is precisely the
   * case a low anisotropy cap cannot filter, which is what puts the shimmering, aliased
   * edge on the astroturf and the fizz on the mesh. These few textures get double the
   * tier's general figure, floored at 4 and never above what the device reports, which
   * keeps a low tier cheap while still filtering the surfaces that need it most.
   */
  _maxAnisotropy() {
    if (this._aniso !== undefined) return this._aniso;
    const tierAniso = this.ctx.materials.anisotropy ?? 4;
    const cap = this.ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? tierAniso;
    this._aniso = Math.max(1, Math.min(cap, Math.max(4, tierAniso * 2)));
    return this._aniso;
  }

  /**
   * Sponsor hoardings on the barrier face.
   *
   * `flipU` is not decoration. The driver reads a board on the right of the circuit
   * while facing the opposite way round from a board on the left, so a UV assignment
   * that only depends on the path direction renders every wordmark on one side of the
   * track backwards. V is likewise pinned bottom-to-top: `readCanvas` flips rows on the
   * way out of the atlas, so the lower V edge of a band is the bottom of the board.
   */
  _buildSponsorBoards() {
    const runs = this.track._barriers?.runs ?? [];
    const material = this._signMaterial();
    const rows = material.userData.rows;
    const acc = this._signs;
    // 8 m, because the artwork is authored 8:1 and a board whose vinyl is stretched to
    // some other ratio is the first thing that reads as wrong about trackside signage.
    const boardLength = 8.0;
    const board = this._makePath(2);
    const profile = SPONSOR_PROFILE;
    const mullions = [];
    let profileLength = 0;
    for (let c = 1; c < profile.length; c++) {
      profileLength += Math.hypot(profile[c][0] - profile[c - 1][0], profile[c][1] - profile[c - 1][1]);
    }

    for (const run of runs) {
      if (run.type === 'tyre') continue;
      if (run.points.length / 3 < 3) continue;
      const path = this._runPath(run);
      const flipU = run.side > 0;
      let start = 0;
      let lastRow = -1;
      // Consecutive boards share a joint, so the stile at the end of one is the stile at
      // the start of the next. Emitting both puts two identical instances at the same
      // world transform, which is a coplanar pair that z-fights.
      let lastStile = -1;

      for (let i = 1; i < path.n; i++) {
        if (path.d[i] - path.d[start] < boardLength) continue;
        const skip = this.rng.next() > 0.78;
        if (!skip) {
          this._copyStation(path, start, board, 0);
          this._copyStation(path, i, board, 1);
          board.d[0] = 0;
          board.d[1] = path.d[i] - path.d[start];
          // Hung on the track-facing side of the barrier, hence the negative offsets.
          // The profile folds back at top and bottom onto the frame bands of the atlas,
          // so the extruded aluminium the vinyl is tensioned into is real geometry with
          // a real return edge rather than a painted-on line.
          // Never the same brand twice running: a repeat across a joint is the one
          // arrangement that makes two 8 m boards read as a single 16 m painted strip.
          let row = this.rng.int(0, rows - 1);
          if (row === lastRow) row = (row + 1 + this.rng.int(0, rows - 2)) % rows;
          lastRow = row;
          this._sweepPath(acc, board, profile,
            1 / board.d[1], (1 / rows) / profileLength, flipU, row / rows);
          // The stile the panels are clamped to at every joint. Proud of the vinyl by a
          // centimetre so it takes its own highlight, which is what separates one board
          // from the next down a long run and stops the whole barrier reading as one
          // continuous ribbon of colour.
          if (start !== lastStile) this._boardMullion(path, start, mullions);
          this._boardMullion(path, i, mullions);
          lastStile = i;
        }
        start = i;
      }
    }

    // A thousand 24-triangle stiles of the same galvanised section the fence rails are,
    // on the same material: baked into their mesh rather than given a draw of their own,
    // since an instance list that spans the lap is never culled anyway.
    this._bakeInstances(this._steel, this._mullionGeometry(), mullions);
  }

  /** One instance matrix for a hoarding stile at path station `r`. */
  _boardMullion(path, r, out) {
    const lateral = -0.245;
    _v.set(
      path.x[r] + path.ox[r] * lateral,
      path.y[r],
      path.z[r] + path.oz[r] * lateral,
    );
    _q.setFromAxisAngle(_axis, -Math.atan2(path.tx[r], -path.tz[r]));
    _scale.set(1, 1, 1);
    _m.compose(_v, _q, _scale);
    out.push(_m.clone());
  }

  /**
   * A hoarding stile: 100 mm of folded section standing the height of the board, with a
   * cap at the top. Local +X is across the circuit and +Z along it, matching the fence
   * post, so the 100 mm face is the one that looks back at the driver.
   */
  _mullionGeometry() {
    if (this._mullion) return this._mullion;
    const acc = new MeshAccum();
    acc.box(0, 0.68, 0, 0.045, 1.30, 0.10, 0, 1.0);
    acc.box(0, 1.345, 0, 0.060, 0.03, 0.13, 0, 1.0);
    const geo = acc.toGeometry();
    this._geometries.push(geo);
    this._mullion = geo;
    return geo;
  }

  /**
   * Marshal posts: the hut, a hazard-striped signal board, a waved flag and the tyre
   * stacks that always sit either side of the opening in the barrier.
   */
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
      const d = ((distance * scale) % surf.length + surf.length) % surf.length;
      surf.sample(d / surf.length, loc);
      // `sample` does not fill `index`; locate the centreline point to get the margin
      // widths that decide how far out the post has to stand.
      _v.copy(loc.position);
      surf.locate(_v, loc);
      const side = -1;
      const idx = loc.index * 2 + 0;
      const offset = side * (loc.width + surf.kerbWidth[idx] + surf.astroWidth[idx]
        + Math.min(18, surf.runoffWidth[idx]) + 6.0);
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

      // The night rig hangs a lamp over every post and drops a small pool under it.
      this._marshalSites.push({
        x, y, z, heading, distance: d, lateral: offset, side,
      });

      // Tyre stacks either side of the marshal opening.
      for (let k = -1; k <= 1; k += 2) {
        const sx = x + loc.tangent.x * k * 3.4;
        const sz = z + loc.tangent.z * k * 3.4;
        this._tyreStacks.push(sx, surf.heightAt(sx, sz), sz);
      }
    }

    this._instance(postGeo, materials.get('marshal_post'), postMatrices, 'marshalPosts', true);
    const flagMat = materials.clone('paint_line');
    flagMat.color.setHex(0xf0d017);
    flagMat.side = THREE.DoubleSide;
    flagMat.transparent = false;
    flagMat.depthWrite = true;
    flagMat.name = 'marshal_flag';
    this._flag = this._instance(flagGeo, this._makeFlagMaterial(flagMat), flagMatrices, 'marshalFlags', false);
  }

  /**
   * A marshal post as one object: the hut, the signal-board mast that stands beside it,
   * the board itself and the pair of steps up to the door. Merged rather than instanced
   * three ways, because a post is always seen as a whole and three instanced meshes for
   * twenty-one of them is two draw calls spent on nothing.
   *
   * Local +X is the track side of the post and -Z is the direction of travel, which is
   * the frame `_instancesAlong` and the marshal loop both compose their matrices in.
   */
  _marshalPostGeometry() {
    if (this._marshalGeo) return this._marshalGeo;
    const acc = new MeshAccum();
    acc.box(0, 1.20, 0, 2.60, 2.40, 1.80, 0, 0.5);          // hut
    acc.box(0, 2.52, 0, 2.86, 0.16, 2.06, 0, 0.5);          // roof overhang
    acc.box(1.62, 0.14, 0.55, 0.90, 0.28, 0.70, 0, 0.5);    // step
    acc.box(2.15, 1.55, -0.35, 0.11, 3.10, 0.11, 0, 0.5);   // signal-board mast
    // Faces up the road, which is the only direction the number on it can be read from.
    acc.box(2.15, 3.05, -0.35, 1.60, 0.90, 0.10, 0, 0.5);
    const geo = acc.toGeometry();
    this._geometries.push(geo);
    this._marshalGeo = geo;
    return geo;
  }

  /** A flag needs to move or it reads as a painted board nailed to a pole. */
  _makeFlagMaterial(material) {
    const time = this._time;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = time;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
float flagT = ( transformed.x + 0.45 ) / 0.9;
transformed.z += sin( uTime * 5.2 + flagT * 7.0 ) * 0.10 * flagT;
transformed.y += sin( uTime * 4.1 + flagT * 5.0 ) * 0.045 * flagT;`);
    };
    material.customProgramCacheKey = () => 'flagWave';
    material.needsUpdate = true;
    return material;
  }

  /**
   * Camera towers and floodlight pylons. The whole camera rig — platform, handrail,
   * body and lens — is one merged geometry instanced once, so eight towers still cost a
   * single draw call and actually read as a camera position rather than a grey box.
   */
  _buildTowers() {
    const surf = this.surface;
    const materials = this.ctx.materials;
    const loc = surf.createLocateResult();
    const analytic = this.track.layout.analyticLength;
    const scale = surf.length / analytic;

    const mastGeo = new THREE.CylinderGeometry(0.16, 0.30, 1, 8);
    const rigGeo = this._cameraRigGeometry();
    this._geometries.push(mastGeo);

    const masts = [];
    const rigs = [];

    for (const tower of this.track.circuit.towers) {
      const d = ((tower.at * scale) % surf.length + surf.length) % surf.length;
      surf.sample(d / surf.length, loc);
      const offset = tower.side * tower.offset;
      const x = loc.position.x + loc.right.x * offset;
      const z = loc.position.z + loc.right.z * offset;
      const y = surf.heightAt(x, z);
      // Face the rig back at the circuit, which is the only direction it is ever seen from.
      const heading = Math.atan2(loc.tangent.x, -loc.tangent.z);

      _q.setFromAxisAngle(_axis, -heading);
      _v.set(x, y + tower.height * 0.5, z);
      _scale.set(1, tower.height, 1);
      _m.compose(_v, _q, _scale);
      masts.push(_m.clone());

      if (tower.kind === 'tv') {
        _scale.set(1, 1, 1);
        _v.set(x, y + tower.height, z);
        _m.compose(_v, _q, _scale);
        rigs.push(_m.clone());
        this._tyreStacks.push(x, y, z);
      } else {
        // The head itself is built with the rest of the night rig, so every mast on the
        // circuit — data-authored or added for the floodlighting — carries one lamp bank.
        this._pylonSites.push(this._mastSite(d, tower.side, tower.height, tower.offset, false, loc));
      }
    }

    // Baked into the shared galvanised-section mesh rather than instanced: thirteen
    // masts and eight rigs is a draw call each for 1,500 triangles, and neither list was
    // ever culled. No shadow either — a camera tower is a 12 m open lattice standing
    // well behind the barrier and a rig is a box on top of it, and what the cascades
    // render of that is a thin scribble on grass nobody is looking at.
    this._bakeInstances(this._steel, mastGeo, masts);
    this._bakeInstances(this._steel, rigGeo, rigs);
  }

  /** Platform, handrail, camera body and lens, in the mast head's local frame. */
  _cameraRigGeometry() {
    const acc = new MeshAccum();
    acc.box(0, 0.09, 0, 2.2, 0.18, 1.8, 0, 0.5);
    for (let i = 0; i < 4; i++) {
      const ax = i < 2 ? (i === 0 ? -1.05 : 1.05) : 0;
      const az = i < 2 ? 0 : (i === 2 ? -0.85 : 0.85);
      const sx = i < 2 ? 0.07 : 2.2;
      const sz = i < 2 ? 1.8 : 0.07;
      acc.box(ax, 0.62, az, sx, 0.07, sz, 0, 0.5);
    }
    for (let i = 0; i < 4; i++) {
      acc.box(i < 2 ? -1.05 : 1.05, 0.40, i % 2 === 0 ? -0.85 : 0.85, 0.07, 0.62, 0.07, 0, 0.5);
    }
    acc.box(0, 0.72, -0.35, 0.75, 0.42, 0.62, 0, 0.5);
    acc.box(0, 0.74, -0.78, 0.26, 0.26, 0.34, 0, 0.5);
    const geo = acc.toGeometry();
    this._geometries.push(geo);
    return geo;
  }

  /**
   * The housing of a floodlight head, in a frame where +X faces the circuit: three
   * banks of lamps on a backing frame, wide along the road and thin across it. The
   * instance yaw turns +X toward the track, so one geometry serves both sides.
   */
  _floodlightHousingGeometry() {
    const acc = new MeshAccum();
    for (let k = 0; k < 3; k++) acc.box(0, 0.55 + k * 1.05, 0, 0.60, 0.86, 3.6, 0, 0.5);
    acc.box(-0.42, 1.6, 0, 0.26, 3.4, 0.30, 0, 0.5);      // backing spine
    acc.box(-0.42, 0.1, 0, 0.30, 0.40, 1.2, 0, 0.5);      // collar onto the mast
    const geo = acc.toGeometry();
    this._geometries.push(geo);
    return geo;
  }

  /**
   * The lenses: twelve tilted faces on the front of the housing. They are separate
   * geometry so the glass can carry an emissive the housing does not — a lamp bank that
   * glows as one solid block reads as a lit box, not as a floodlight.
   */
  _floodlightLensGeometry() {
    const acc = new MeshAccum();
    const tilt = 0.58;                    // aimed down at the road ~33 degrees
    const cs = Math.cos(tilt);
    const sn = Math.sin(tilt);
    const nrm = [cs, -sn, 0];
    const hw = 0.36;                      // half width along the road
    const hh = 0.30;                      // half height up the tilted face
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

  /**
   * Braking-distance boards, counted down into every corner the circuit data marks. The
   * face points back up the road at the approaching car, and U runs along the track's
   * `right` because that is the approaching driver's right: get this backwards and the
   * hundred board reads as an "001".
   */
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
      map, roughness: 0.72, metalness: 0.0, name: 'distance_board',
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
        const d = (((spec.at - mark) * scale) % surf.length + surf.length) % surf.length;
        surf.sample(d / surf.length, loc);
        _v.copy(loc.position);
        surf.locate(_v, loc);
        const idx = loc.index * 2 + (spec.side >= 0 ? 1 : 0);
        const lateral = spec.side * (loc.width + surf.kerbWidth[idx] + surf.astroWidth[idx]
          + Math.min(12, surf.runoffWidth[idx]) + 1.6);
        const cx = loc.position.x + loc.right.x * lateral;
        const cz = loc.position.z + loc.right.z * lateral;
        const cy = surf.heightAt(cx, cz);
        const rx = loc.right.x, rz = loc.right.z;

        nrm[0] = -loc.tangent.x; nrm[1] = 0; nrm[2] = -loc.tangent.z;
        p0[0] = cx - rx * halfW; p0[1] = cy + hLo; p0[2] = cz - rz * halfW;
        p1[0] = cx + rx * halfW; p1[1] = cy + hLo; p1[2] = cz + rz * halfW;
        p2[0] = p1[0]; p2[1] = cy + hHi; p2[2] = p1[2];
        p3[0] = p0[0]; p3[1] = cy + hHi; p3[2] = p0[2];
        acc.quad(p0, p1, p2, p3, nrm, 0, band * bandV, 1, (band + 1) * bandV);
        // The blank band on the back: the face is single-sided so the number cannot be
        // read in reverse from the far side.
        nrm[0] = loc.tangent.x; nrm[2] = loc.tangent.z;
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

    this._addMerged(acc, material, 'distanceBoards', false);
    if (posts.length) {
      const postGeo = new THREE.BoxGeometry(0.09, hLo, 0.09);
      this._bakeInstances(this._steel, postGeo, posts);
      postGeo.dispose();
    }
  }

  /**
   * The stacks of tyres that sit at every marshal opening and camera position. Modelled
   * as a squat cylinder rather than four toruses: the tyre-wall texture already carries
   * the 0.72 m scallop, so the rings come from the map for a tenth of the triangles.
   */
  _buildTyreStacks() {
    if (!this._tyreStacks.length) return;
    const geo = new THREE.CylinderGeometry(0.38, 0.40, 0.9, 12, 1);
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
    this._instance(geo, this.ctx.materials.get('tyrewall'), matrices, 'tyreStacks', true);
  }

  // --- forest ---------------------------------------------------------------------

  /**
   * The Ardennes forest.
   *
   * Four plantings rather than one shape scaled three ways, because the treeline is the
   * single most recognisable thing about this circuit and the review's verdict on the
   * old one — "identical dark lollipops on a repeating skyline" — was fair: every tree of
   * a species was the same crown geometry, uniformly scaled, tinted by one flat colour,
   * on a jittered grid regular enough to read as a pattern.
   *
   * Three things break that up here and none of them costs a draw call. Placement clumps
   * into stands with a hash-noise field so the species mix drifts along the skyline
   * instead of alternating; the height of the whole stand is modulated on a longer
   * wavelength so the canopy line undulates; and every card of every crown is grown,
   * shrunk, displaced or dropped outright in the vertex shader from a hash of its own
   * index and the tree's world position, so no two crowns share a silhouette even where
   * they share geometry. Colour is a per-instance tint spanning deep blue-green to
   * yellow-green rather than one hex per species.
   */
  _buildTrees() {
    const surf = this.surface;
    const detail = this.tier?.name === 'low' ? 0.32
      : this.tier?.name === 'medium' ? 0.6
        : this.tier?.name === 'ultra' ? 1.35 : 1.0;

    const loc = surf.createLocateResult();
    const clearings = this.track.circuit.clearings.map((c) => {
      const d = ((c.at / this.track.layout.analyticLength) % 1 + 1) % 1;
      surf.sample(d, loc);
      return { x: loc.position.x, z: loc.position.z, r2: c.radius * c.radius };
    });

    const buckets = TREE_SPECIES.map(() => ({ matrices: [], data: [], tint: [] }));
    this._scatterTrees(buckets, clearings, loc, TREE_SPACING / Math.sqrt(detail),
      26, TREE_BAND, 1.0);
    // A thinned second band. Stopping the planting dead at 330 m left the hillside above
    // the circuit bare in every wide shot, which is most of why the world looked like it
    // ended just behind the barrier.
    this._scatterTrees(buckets, clearings, loc, TREE_FAR_SPACING / Math.sqrt(detail),
      TREE_BAND, TREE_FAR_BAND, 0.55);

    const canopyMat = this._canopyMaterial();

    // Every trunk on the circuit in one instanced mesh.
    //
    // The four species used to be four geometries on four cloned bark materials, which
    // is four draw calls in the main pass and four more in the shadow pass for something
    // that is, from any camera outside the forest, a stick. They share one unit-height
    // stem here and carry their real height and butt radius in `aStem`, applied in the
    // vertex program next to the sway the material already does. That is 8 draws down to
    // 1. It does not cast a shadow either: a trunk stands inside its own crown's shadow,
    // so the cascade pays for a silhouette that is already black.
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
        // The instance matrix already scales Y by height/height[1] and XZ by
        // radius/radius[1]; `aStem` restores the species' own metre figures underneath
        // it, so the stem ends up exactly the height and butt diameter it had when each
        // species carried its own cylinder.
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
      const trunks = this._instance(this._trunkGeometry(), trunkMat, stemMatrices,
        'treeTrunks', false);
      trunks.geometry.setAttribute('aTree', new THREE.InstancedBufferAttribute(stemData, 2));
      trunks.geometry.setAttribute('aStem', new THREE.InstancedBufferAttribute(stems, 2));
    }

    for (let s = 0; s < TREE_SPECIES.length; s++) {
      const bucket = buckets[s];
      if (!bucket.matrices.length) continue;
      const species = TREE_SPECIES[s];
      const data = new Float32Array(bucket.data);
      const tint = new Float32Array(bucket.tint);

      const canopies = this._instance(this._canopyGeometry(species), canopyMat, bucket.matrices,
        `canopy_${species.name}`, true);
      canopies.geometry.setAttribute('aTree', new THREE.InstancedBufferAttribute(data, 2));
      canopies.geometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(tint, 3));
    }
  }

  /**
   * One planting pass over a lateral band of the corridor.
   *
   * `gain` scales the density so the far band thins out rather than ending in a wall.
   * Species are chosen from a stand field rather than independently per tree: a managed
   * forest is blocks of one thing, and independent draws produce an even salt-and-pepper
   * mix that reads as noise from a kilometre away.
   */
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
          if (dx * dx + dz * dz < c.r2) { blocked = true; break; }
        }
        if (blocked) continue;

        // Dense just behind the treeline, thinning again toward the outer edge of the
        // band, times a stand field so the forest has clearings and thickets in it.
        const stand = valueNoise2(px * 0.0072, pz * 0.0072);
        const density = smoothstep(nearClear, nearClear + 38, clear)
          * (1 - 0.7 * smoothstep(farClear * 0.62, farClear, clear))
          * (0.28 + 1.05 * stand) * gain;
        if (rng.next() > density) continue;

        // Stands: a dominant species per ~110 m cell, with a minority mixed through it.
        const dominant = Math.min(TREE_SPECIES.length - 1,
          Math.floor(valueNoise2(px * 0.0091 + 31.7, pz * 0.0091 - 12.3) * TREE_SPECIES.length));
        let speciesIndex = dominant;
        if (rng.next() > 0.68) {
          let pick = rng.next();
          for (let i = 0; i < TREE_SPECIES.length; i++) {
            pick -= TREE_SPECIES[i].share;
            if (pick <= 0) { speciesIndex = i; break; }
          }
        }
        const species = TREE_SPECIES[speciesIndex];

        // Stand height drifts on a longer wavelength than the species, so the canopy
        // line rises and falls instead of sitting at one altitude to the horizon.
        const vigour = 0.74 + 0.52 * valueNoise2(px * 0.0038 - 5.1, pz * 0.0038 + 8.4);
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
        // Deep green through yellow-green, biased so the sunlit outer edge of a stand
        // and its shaded interior are not the same colour.
        const t = clamp01(rng.next() * 0.75 + stand * 0.45);
        const lo = species.tint[0];
        const hi = species.tint[1];
        bucket.tint.push(
          lo[0] + (hi[0] - lo[0]) * t,
          lo[1] + (hi[1] - lo[1]) * t,
          lo[2] + (hi[2] - lo[2]) * t,
        );
      }
    }
  }

  /**
   * One unit stem for every tree on the circuit: a metre tall, `TRUNK_UNIT_RADIUS` at
   * the butt, tapering to 40% of that at the top — the taper a mature forest-grown stem
   * actually carries, and close enough across spruce, pine, beech and birch that one
   * shape serves all four once the vertex program has stretched it.
   */
  _trunkGeometry() {
    if (this._trunk) return this._trunk;
    const geo = new THREE.CylinderGeometry(
      TRUNK_UNIT_RADIUS * 0.40, TRUNK_UNIT_RADIUS, 1, 6, 1, true,
    );
    geo.translate(0, 0.5, 0);
    this._geometries.push(geo);
    this._trunk = geo;
    return geo;
  }

  /**
   * Bark, plus the vertex program that turns the shared unit stem into this instance's
   * stem. `aStem` is (height in metres, radius multiplier), both expressed against the
   * instance matrix the crown is already using, so trunk and crown cannot drift apart.
   */
  _trunkMaterial() {
    if (this._trunkMat) return this._trunkMat;
    const material = this.ctx.materials.clone('tree_bark');
    material.name = 'tree_stem';
    const time = this._time;
    const wind = this._wind;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = time;
      shader.uniforms.uWind = wind;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
uniform float uTime;
uniform vec2 uWind;
attribute vec2 aTree;
attribute vec2 aStem;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
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
    material.customProgramCacheKey = () => 'treeStemV1';
    material.needsUpdate = true;
    this._materials.push(material);
    this._trunkMat = material;
    return material;
  }

  /**
   * A crown: cards fanned around the trunk on a golden-angle spiral, laid out by the
   * species' growth form. Every card ships its own centre and index as vertex
   * attributes, which is what lets the shader give each tree its own silhouette from one
   * shared geometry.
   */
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
    const u0 = (cell % CANOPY_ATLAS.cols) / CANOPY_ATLAS.cols;
    const v0 = Math.floor(cell / CANOPY_ATLAS.cols) / CANOPY_ATLAS.rows;
    const du = 1 / CANOPY_ATLAS.cols;
    const dv = 1 / CANOPY_ATLAS.rows;

    // Card height scales down a little as the card count goes up, so a denser crown is
    // built from more, smaller clusters rather than the same few slabs stacked thicker.
    // Eight is the count the per-form figures below were authored against. This is what
    // takes the near trees from "cauliflower" — four or five huge quads whose outlines
    // are legible as quads — to a lumpy mass with a broken edge on it.
    //
    // Floored at 0.88, not at the raw sqrt. The unclamped figure took a thirteen-card
    // crown down to 0.78 of its authored height, and combined with the feathered rim on
    // the leaf cards that thinned the whole treeline: the skyline went from a mass with
    // gaps in it to a picket of spires with sky between them, which loses more than the
    // extra silhouette variety wins. Spa is in a forest and the treeline has to read as
    // one.
    const dens = clamp(Math.sqrt(8 / cards), 0.88, 1.10);

    for (let i = 0; i < cards; i++) {
      const f = cards > 1 ? i / (cards - 1) : 0.5;
      // 2.39996 rad is the golden angle: the spiral a real crown puts its branches on,
      // and the one arrangement that never lines two cards up behind each other.
      const angle = i * 2.39996 + 0.4;
      // A slow beat against the golden angle, so the crown's outline is not a smooth
      // surface of revolution. Deterministic, and different for every card index.
      const lump = 0.86 + 0.28 * (0.5 + 0.5 * Math.sin(i * 2.7 + species.atlas * 1.9));
      let cy;
      let width;
      let tall;
      if (species.form === 'spire') {
        cy = crownBase + crownSpan * (0.05 + 0.94 * f);
        width = r * (1.04 - 0.90 * f) * lump;
        tall = crownSpan * 0.19 * dens;
      } else if (species.form === 'umbrella') {
        cy = crownBase + crownSpan * (0.30 + 0.66 * f);
        width = r * (0.72 + 0.38 * Math.sin(f * Math.PI)) * lump;
        tall = crownSpan * 0.29 * dens;
      } else if (species.form === 'column') {
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
      // Cards sit off-axis, not through the trunk: a crown built from cards that all
      // pass through the centre is hollow from every direction but two.
      const ox = -sa * width * 0.22;
      const oz = ca * width * 0.22;
      const centre = [ox, cy, oz];
      // Mirror the card's U on alternate steps so the same leaf art never repeats in
      // the same orientation twice inside one crown.
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
    geo.setAttribute('aCardCentre', new THREE.Float32BufferAttribute(centres, 3));
    geo.setAttribute('aCard', new THREE.Float32BufferAttribute(ids, 1));
    this._geometries.push(geo);
    return geo;
  }

  /**
   * One material for every crown on the circuit: the four-cell foliage atlas, an
   * alpha cutout whose coverage is held constant through the mip chain, and a vertex
   * program that gives each instance its own crown and its own colour.
   */
  _canopyMaterial() {
    if (this._canopyMat) return this._canopyMat;
    const aniso = this._maxAnisotropy();
    const td = buildCanopyAtlas(1024, 6464);
    const map = makeDataTexture(td.color, td.width, td.height, THREE.SRGBColorSpace, td.colorMips);
    const normalMap = makeDataTexture(td.normal, td.width, td.height, THREE.NoColorSpace);
    const ormMap = makeDataTexture(td.orm, td.width, td.height, THREE.NoColorSpace);
    ormMap.channel = 0;
    for (const t of [map, normalMap, ormMap]) {
      // Cells must not wrap into each other, and a leaf card never tiles anyway.
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.anisotropy = aniso;
      this._textures.push(t);
    }
    const material = new THREE.MeshStandardMaterial({
      map, normalMap, roughnessMap: ormMap, aoMap: ormMap,
      roughness: 1.0, metalness: 0.0,
      alphaTest: CANOPY_ALPHA_TEST, transparent: false, side: THREE.DoubleSide,
      // Foliage is the one surface here that really does scatter light through itself.
      // A standard BRDF has no transmission term, so the shaded half of every crown
      // falls to whatever the environment gives it — and against a blown sky that is
      // what turns a hillside into a stencil. Overdriving the environment response is
      // the cheap stand-in for the light that comes through a leaf.
      envMapIntensity: 1.35, name: 'tree_canopy_atlas',
    });
    material.normalScale.set(0.8, 0.8);
    this._materials.push(material);

    const time = this._time;
    const wind = this._wind;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = time;
      shader.uniforms.uWind = wind;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
uniform float uTime;
uniform vec2 uWind;
attribute vec2 aTree;
attribute vec3 aTint;
attribute vec3 aCardCentre;
attribute float aCard;
varying vec3 vTreeTint;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vTreeTint = aTint;
vec3 treeOrigin = instanceMatrix[ 3 ].xyz;
float treeHash = fract( sin( treeOrigin.x * 12.9898 + treeOrigin.z * 78.233 ) * 43758.5453 );
float cardA = fract( sin( aCard * 91.7 + treeHash * 137.13 ) * 43758.5453 );
float cardB = fract( sin( aCard * 47.3 + treeHash * 219.71 ) * 43758.5453 );
float cardC = fract( sin( aCard * 23.9 + treeHash * 311.37 ) * 43758.5453 );
// One card in nine is simply not there, and the rest are grown or shrunk about their
// own centre — which is what makes a thousand instances of one crown all different.
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

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTreeTint;')
        .replace('#include <map_fragment>', `#include <map_fragment>
diffuseColor.rgb *= vTreeTint;`);
    };
    material.customProgramCacheKey = () => 'canopyAtlasV1';
    material.needsUpdate = true;
    this._canopyMat = material;
    return material;
  }

  // --- night lighting -------------------------------------------------------------

  /**
   * The floodlight rig.
   *
   * Forty shadow-casting lights is not a budget anyone has, so the pools are baked: one
   * additive decal sheet laid on the tarmac under every mast, with the falloff and the
   * wet-road streaking carried in a texture rather than in geometry. Only the handful of
   * masts nearest the camera get a real SpotLight, and that is what makes the car
   * brighten as it drives into a pool and fall dark again between them.
   *
   * Everything here is gated on the sun: at sunrise the lenses stop emitting, the decals
   * and glows are hidden and the lights are switched off, so the daylight frames are the
   * frames they always were.
   */
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

  /**
   * One mast site. `offset` is the authored stand-off where the circuit data supplies
   * one; otherwise the mast is planted just beyond the run-off, which is where it can be
   * tall enough to matter without being inside anything.
   */
  _mastSite(distance, side, height, offset, generated, loc) {
    const surf = this.surface;
    const d = ((distance % surf.length) + surf.length) % surf.length;
    surf.sample(d / surf.length, loc);
    const idx = loc.index * 2 + (side > 0 ? 1 : 0);
    const stand = Number.isFinite(offset) ? offset
      : loc.width + surf.kerbWidth[idx] + surf.astroWidth[idx]
        + Math.min(20, surf.runoffWidth[idx]) + 7;
    const x = loc.position.x + loc.right.x * side * stand;
    const z = loc.position.z + loc.right.z * side * stand;
    // Aimed a little past the centreline, so the far edge of the road is lit rather
    // than the near kerb being burnt out.
    const ax = loc.position.x - loc.right.x * side * loc.width * 0.35;
    const az = loc.position.z - loc.right.z * side * loc.width * 0.35;
    return {
      x, y: surf.heightAt(x, z), z,
      ax, ay: surf.heightAt(ax, az), az,
      tx: loc.tangent.x, tz: loc.tangent.z,
      height, side, distance: d, generated,
      heading: Math.atan2(loc.tangent.x, -loc.tangent.z),
      width: loc.width,
    };
  }

  /** Circuit-data pylons, plus enough added masts to light the whole lap. */
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
        if (gap < NIGHT_MAST_CLEAR) { clash = true; break; }
      }
      if (clash) continue;
      // Alternating sides: lighting one hand of the circuit the whole way round leaves
      // a permanent shadow down the other, and one long shadow reads as a bug.
      sites.push(this._mastSite(d, i % 2 === 0 ? -1 : 1, NIGHT_MAST_HEIGHT, null, true, loc));
    }
    return sites;
  }

  /** Masts for the added sites, and a lamp bank on the head of every site. */
  _buildMastHeads(sites) {
    const materials = this.ctx.materials;
    const mastGeo = new THREE.CylinderGeometry(0.17, 0.32, 1, 8);
    this._geometries.push(mastGeo);
    const housingGeo = this._floodlightHousingGeometry();
    const lensGeo = this._floodlightLensGeometry();

    const masts = [];
    const heads = [];
    for (const s of sites) {
      // Yaw puts the head's +X on the circuit; a mast on the right of the road is the
      // same head turned through half a turn.
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

    // A 30 m mast throws a shadow a hundred metres long and two hundred millimetres
    // wide, which is a cascade's worth of fill rate for something no frame resolves.
    this._bakeInstances(this._steel, mastGeo, masts);

    const housingMat = materials.clone('metal_anodised');
    housingMat.color.setHex(0x33363b);
    housingMat.roughness = 0.62;
    housingMat.name = 'floodlight_housing';
    this._instance(housingGeo, housingMat, heads, 'floodlightHeads', false);

    const lensMat = new THREE.MeshStandardMaterial({
      color: 0x0a0b0d, emissive: new THREE.Color(0xfff2dc), emissiveIntensity: 0,
      roughness: 0.22, metalness: 0.0, name: 'floodlight_lens',
    });
    this._materials.push(lensMat);
    this._nightEmissive.push({ material: lensMat, day: 0, night: NIGHT_LENS_EMISSIVE });
    const lens = this._instance(lensGeo, lensMat, heads, 'floodlightLenses', false);
    lens.receiveShadow = false;
    // Twelve unlit glass facets per head are invisible against the housing in daylight
    // and cost a draw call in every pass, so they only exist after dark.
    this._nightMeshes.push(lens);
  }

  /**
   * The flare around each head. A lamp bank a kilometre away is three pixels of
   * geometry; without a billboarded glow to carry it, the far end of the circuit has no
   * lights in it at all — which is exactly what the reviewed frame showed.
   */
  _buildMastGlows(sites) {
    const geo = new THREE.PlaneGeometry(11, 11);
    this._geometries.push(geo);
    const map = this._glowTexture();
    const material = new THREE.MeshBasicMaterial({
      map, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false, name: 'floodlight_glow',
    });
    this._materials.push(material);
    this._billboard(material, 'floodGlow');
    this._nightAdditive.push({ material, gain: 1.0 });

    const matrices = [];
    for (const s of sites) {
      // On the lamp face, not the mast head: the flare wants to sit where the light
      // leaves the fitting.
      const dirX = Math.cos(-s.heading + (s.side > 0 ? Math.PI : 0));
      const dirZ = -Math.sin(-s.heading + (s.side > 0 ? Math.PI : 0));
      _v.set(s.x + dirX * 0.5, s.y + s.height + 1.5, s.z + dirZ * 0.5);
      _q.identity();
      _scale.set(1, 1, 1);
      _m.compose(_v, _q, _scale);
      matrices.push(_m.clone());
    }
    const mesh = this._instance(geo, material, matrices, 'floodlightGlows', false);
    mesh.receiveShadow = false;
    mesh.renderOrder = 6;
    this._nightMeshes.push(mesh);
  }

  /**
   * The baked pools. One additive sheet for the whole circuit: a patch of road under
   * every mast, a run of spill down the pit lane in front of the garages, and a small
   * disc under every marshal post.
   */
  _buildLightPools(sites) {
    const pool = { pos: [], uv: [], col: [], idx: [] };
    const rng = new Rng(0x66a1c30d);
    for (const s of sites) {
      const pad = s.width + POOL_PAD;
      // A few stops of variation between masts. A chain of identically bright pools is
      // the one thing a real circuit never has — lamps age, aim and get dirty.
      const gain = 0.82 + rng.next() * 0.36;
      this._pushPool(pool, s.distance - POOL_HALF, s.distance + POOL_HALF, -pad, pad,
        0.98, 0.985, 1.0, gain, 1);
    }

    const spec = this.track.circuit.pitLane;
    let span = spec.buildingTo - spec.buildingFrom;
    while (span < 0) span += this.surface.length;
    // One blob per garage bay: the light that reaches the lane at night comes out of the
    // garages, so it arrives in discrete mouthfuls rather than as an even wash.
    this._pushPool(pool, spec.buildingFrom, spec.buildingFrom + span, 12.5, 25.5,
      1.0, 0.86, 0.62, 0.55, Math.max(2, Math.round(span / 17)));

    for (const p of this._marshalSites) {
      this._pushPool(pool, p.distance - 9, p.distance + 9, p.lateral - 7.5, p.lateral + 7.5,
        1.0, 0.80, 0.52, 0.5, 1);
    }

    if (!pool.idx.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pool.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(pool.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(pool.col, 3));
    geo.setIndex(pool.idx);
    geo.computeBoundingSphere();
    this._geometries.push(geo);

    const map = this._poolTexture();
    const material = new THREE.MeshBasicMaterial({
      map, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false, name: 'light_pool',
      // The decal sits six centimetres over the road and still needs the offset: at the
      // far end of a straight the depth buffer has nothing like that much resolution.
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
    });
    this._materials.push(material);
    this._nightAdditive.push({ material, gain: POOL_GAIN });

    const mesh = new THREE.Mesh(geo, material);
    mesh.name = 'lightPools';
    mesh.renderOrder = 5;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    this._nightMeshes.push(mesh);
  }

  /**
   * A patch of road, followed vertex by vertex through the crown, the banking and the
   * kerbs so the decal never sinks under the surface it is painted on. `tiles` repeats
   * the pool along the run, which is how a strip of light becomes a row of pools with
   * dark between them instead of one long smear.
   */
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
      surf.sample((((d % surf.length) + surf.length) % surf.length) / surf.length, loc);
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

  /**
   * Trackside LED boards, on top of the barrier hoardings. They are their own light
   * source — nothing else on the circuit puts a saturated colour on the road — so they
   * are emissive rather than lit, and they stay dim but present in daylight the way a
   * real panel does.
   */
  _buildLedBoards() {
    const runs = this.track._barriers?.runs ?? [];
    if (!runs.length) return;
    const panels = this._ledTexture();
    const map = panels.map;
    const rows = panels.rows;
    // The panel is a dark, matte face that happens to emit: `color` is what it looks
    // like with the power off, and the emissive map is the picture on it. Giving it a
    // near-black albedo and a bright emissive is what stops a daytime board reading as
    // a flat slab of saturated colour.
    const material = new THREE.MeshStandardMaterial({
      color: 0x1a1c20, map, emissive: new THREE.Color(0xffffff), emissiveMap: map,
      emissiveIntensity: 0, roughness: 0.46, metalness: 0.0, name: 'led_board',
    });
    this._materials.push(material);
    this._nightEmissive.push({ material, day: 0.55, night: 1.35 });

    const rng = new Rng(0x2c8f11ab);
    const acc = new MeshAccum();
    const board = this._makePath(2);
    // One LED module is 5.2 m of face at the 5.3:1 the atlas is drawn to.
    const boardLength = 5.2;
    const profile = LED_PROFILE;
    let profileLength = 0;
    for (let c = 1; c < profile.length; c++) {
      profileLength += Math.hypot(profile[c][0] - profile[c - 1][0], profile[c][1] - profile[c - 1][1]);
    }

    for (const run of runs) {
      if (run.type === 'tyre') continue;
      if (run.points.length / 3 < 3) continue;
      const path = this._runPath(run);
      const flipU = run.side > 0;
      let start = 0;
      for (let i = 1; i < path.n; i++) {
        if (path.d[i] - path.d[start] < boardLength) continue;
        // Not a continuous ribbon: real boards come in runs with gaps, and a solid
        // glowing kerb-to-horizon line reads as a bug rather than as advertising.
        if (rng.next() < 0.26) {
          this._copyStation(path, start, board, 0);
          this._copyStation(path, i, board, 1);
          board.d[0] = 0;
          board.d[1] = path.d[i] - path.d[start];
          const row = rng.int(0, rows - 1);
          this._sweepPath(acc, board, profile,
            1 / board.d[1], (1 / rows) / profileLength, flipU, row / rows);
        }
        start = i;
      }
    }
    this._addMerged(acc, material, 'ledBoards', false, false);
  }

  /**
   * Grandstands at night: a lit fascia band over the hoardings, and discrete floodlights
   * hung off the leading edge of the roof.
   *
   * The roof lamps are individual fittings on purpose. A continuous emissive strip along
   * the roof edge draws a single unbroken white line eighteen metres up and clean across
   * the frame, which reads as a rendering artefact — a cable, or a seam — long before it
   * reads as a lit building.
   */
  _buildStandLighting() {
    const acc = new MeshAccum();
    const fasciaMat = new THREE.MeshStandardMaterial({
      color: 0x14161a, emissive: new THREE.Color(0xdce9ff), emissiveIntensity: 0,
      roughness: 0.5, metalness: 0.0, name: 'stand_fascia_strip',
    });
    this._materials.push(fasciaMat);
    this._nightEmissive.push({ material: fasciaMat, day: 0, night: 2.4 });

    const lampMat = new THREE.MeshStandardMaterial({
      color: 0x0b0c0e, emissive: new THREE.Color(0xfff4e2), emissiveIntensity: 0,
      roughness: 0.35, metalness: 0.0, name: 'stand_roof_lamp',
    });
    this._materials.push(lampMat);
    this._nightEmissive.push({ material: lampMat, day: 0, night: 5.0 });
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

      this._sweepPath(acc, path, [[-0.10, STAND_FRONT - 0.30], [-0.10, STAND_FRONT - 0.02]], 0.25, 3.5);
      this._instancesAlong(path, STAND_FRAME_STATION * 2, roofFrontY - 0.95, roofFrontLat - 0.15,
        1, 1, 1, lamps);
    }

    const strips = this._addMerged(acc, fasciaMat, 'standFasciaStrips', false, false);
    // Unlit this is a black band painted along the front of every stand: it is a night
    // fitting, and in daylight it is a draw call spent on making a stand look worse.
    if (strips) this._nightMeshes.push(strips);
    if (lamps.length) {
      const mesh = this._instance(lampGeo, lampMat, lamps, 'standRoofLamps', false);
      mesh.receiveShadow = false;
      // Same call `floodlightLenses` makes: with the emissive at zero these are 166
      // near-black 0.7 m boxes tucked under a roof edge eighteen metres up, invisible in
      // any daylight frame, for one draw call in every pass of it.
      this._nightMeshes.push(mesh);
    }
  }

  /** Lit garage mouths and an upper storey with the lights on in it. */
  _buildPitLighting() {
    const spec = this.track.circuit.pitLane;
    const from = spec.buildingFrom;
    const to = spec.buildingTo;

    const windowMat = new THREE.MeshStandardMaterial({
      color: 0x0b0d12, emissive: new THREE.Color(0xffffff), emissiveMap: this._windowTexture(),
      emissiveIntensity: 0, roughness: 0.16, metalness: 0.0, name: 'pit_windows',
    });
    this._materials.push(windowMat);
    this._nightEmissive.push({ material: windowMat, day: 0.10, night: 1.9 });
    this._sweepProfile(from, to, 1, spec.buildingOffset - 0.05,
      [[1.15, 5.70], [1.15, 9.25]], windowMat, 'pitWindows', 1 / 7, 1 / 3.55, false);

    const bayMat = new THREE.MeshStandardMaterial({
      color: 0x08090c, emissive: new THREE.Color(0xffffff), emissiveMap: this._garageTexture(),
      emissiveIntensity: 0, roughness: 0.5, metalness: 0.0, name: 'pit_garage_glow',
    });
    this._materials.push(bayMat);
    this._nightEmissive.push({ material: bayMat, day: 0.06, night: 2.2 });
    this._sweepProfile(from, to, 1, spec.buildingOffset - 0.46,
      [[0, 0.30], [0, 3.95]], bayMat, 'pitGarageGlow', 1 / spec.boxSpacing, 1 / 3.65, false);
  }

  /** A lamp over every marshal post: the chain of them is what gives the lap depth. */
  _buildMarshalLamps() {
    if (!this._marshalSites.length) return;
    const acc = new MeshAccum();
    acc.box(0, 0, 0, 0.62, 0.16, 0.46, 0, 0.5);
    const geo = acc.toGeometry();
    this._geometries.push(geo);

    const material = new THREE.MeshStandardMaterial({
      color: 0x0a0a0c, emissive: new THREE.Color(0xffd39a), emissiveIntensity: 0,
      roughness: 0.4, metalness: 0.0, name: 'marshal_lamp',
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
    const mesh = this._instance(geo, material, matrices, 'marshalLamps', false);
    mesh.receiveShadow = false;
    // Unlit, this is a 0.6 m black box on the back of a marshal post; it only exists as
    // a fitting once there is something coming out of it.
    this._nightMeshes.push(mesh);
  }

  /**
   * The real lights: a fill that keeps the car legible without lifting the mood, and
   * `NIGHT_SPOT_MAX` spots that chase the masts nearest the camera.
   */
  _buildNightLights() {
    const fill = new THREE.HemisphereLight(0x2c3c58, 0x241d16, 0);
    fill.visible = false;
    this.group.add(fill);
    this._nightFill = fill;

    const intensity = NIGHT_SPOT_IRRADIANCE * (NIGHT_SPOT_REF ** NIGHT_SPOT_DECAY);
    for (let i = 0; i < NIGHT_SPOT_MAX; i++) {
      // The cone is deliberately tight. A mast is thirty metres up and forty out, so a
      // wide cone puts its upper edge through the grandstand opposite at sixty metres and
      // burns the roof fascia to white — a glowing wire drawn across the whole frame.
      // The throw is cut off just past the far side of the road. Geometry alone cannot
      // do it: the cone that covers the racing surface from thirty metres up also, at
      // its far edge, reaches the grandstand sixty metres away, and the first thing that
      // stand does with the light is clip its roofline to white right across the frame.
      const spot = new THREE.SpotLight(0xfff0da, 0, 110, 0.45, 0.7, NIGHT_SPOT_DECAY);
      spot.castShadow = false;      // four shadowed cones is most of a frame budget
      spot.visible = false;
      spot.userData.peak = intensity;
      this.group.add(spot);
      this.group.add(spot.target);
      this._spots.push(spot);
    }
  }

  /** How night it is: 1 once the sun is under the horizon, 0 once it is properly up. */
  _nightAmount() {
    const sun = this.ctx.sky?.sunDirection;
    if (!sun) return 0;
    return 1 - smoothstep(-0.03, 0.10, sun.y);
  }

  /** Push the night factor into every material and light the rig owns. */
  _applyNight(nf) {
    for (const e of this._nightEmissive) {
      e.material.emissiveIntensity = e.day + (e.night - e.day) * nf;
    }
    const lit = nf > 0.01;
    for (const a of this._nightAdditive) {
      const g = a.gain * nf;
      // Linear: these are additive decals, so the number is a radiance multiplier and
      // must not go through the sRGB transfer that setHex would apply.
      a.material.color.setRGB(g, g, g, THREE.LinearSRGBColorSpace);
    }
    for (const mesh of this._nightMeshes) mesh.visible = lit;
    if (this._nightFill) {
      this._nightFill.intensity = NIGHT_FILL_INTENSITY * nf;
      this._nightFill.visible = lit;
    }
    for (const spot of this._spots) spot.visible = lit;
  }

  /**
   * Hand the spots to the masts nearest the camera. Reassignment happens where the
   * outgoing mast has already faded to nothing, so a swap is not visible; the fade is
   * also what makes the car dim between pools instead of being lit from a mast half a
   * kilometre behind it.
   */
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
      // The aim slides along the road toward the camera, bounded to this mast's own
      // stretch. A lamp bank four metres wide does light more than one spot on the
      // tarmac, and pinning the aim to the mast leaves the car in the dark for two
      // thirds of the gap between masts; the bound is what stops the cone swinging out
      // far enough to catch the grandstand behind the road.
      const tx = data[i + 6];
      const tz = data[i + 7];
      const along = clamp((cx - data[i + 3]) * tx + (cz - data[i + 5]) * tz,
        -NIGHT_SPOT_AIM_SPAN, NIGHT_SPOT_AIM_SPAN);
      spot.target.position.set(data[i + 3] + tx * along, data[i + 4], data[i + 5] + tz * along);
      const fade = 1 - smoothstep(NIGHT_SPOT_FADE_NEAR, NIGHT_SPOT_FADE_FAR,
        Math.sqrt(this._spotDist[s]));
      spot.intensity = spot.userData.peak * nf * fade;
    }
  }

  _spotCount() {
    const name = this.tier?.name;
    if (name === 'low') return 2;
    if (name === 'medium') return 3;
    return NIGHT_SPOT_MAX;
  }

  /**
   * Hoardings and stand fascias, self-lit after dark. A board that stays as dark as the
   * barrier behind it is the single clearest tell that a night scene has no lights in
   * it, and every circuit lights its own advertising.
   */
  _signMaterial() {
    if (this._signMat) return this._signMat;
    const aniso = this._maxAnisotropy();
    // Built here at 2048x1024 rather than taken from the library, whose signage set is
    // authored at 1024x512 for eight 8:1 bands — sixty-four texels of board height. A
    // wordmark cannot survive that, and a hoarding with unreadable type on it is exactly
    // what reads as an untextured colour rectangle from the car. At 2048 a board row is
    // 128 texels tall, which puts a 0.62-of-band cap height on about sixty texels: the
    // point at which the type stays type through the mip chain instead of turning into a
    // grey bar the moment the board is more than twenty metres away.
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
      map, normalMap, roughnessMap: ormMap, metalnessMap: ormMap, aoMap: ormMap,
      // Vinyl under an open sky takes a lot of skylight, and half the hoardings on a
      // circuit face away from the sun at any given hour. At unity those boards came
      // back near black and the artwork on them was unreadable; this is what keeps a
      // shaded board a legible mid-tone instead of a silhouette.
      roughness: 1.0, metalness: 1.0, envMapIntensity: 1.45,
      emissive: new THREE.Color(0xffffff), emissiveMap: map, emissiveIntensity: 0,
      name: 'sponsor_board_lit',
    });
    mat.normalScale.set(0.7, 0.7);
    mat.userData.rows = td.rows;
    mat.userData.frameBand = td.frameBand;
    this._materials.push(mat);
    // A small daytime self-lit floor. Half the hoardings on a circuit face away from
    // the sun at any hour, and measured in scene those boards land at rgb(39,13,19) and
    // rgb(26,39,53) — dark enough that the artwork on them is gone and the board reads
    // as one of the flat placeholder blocks the review called out. Raising the material's
    // environment response did nothing measurable (see `_fenceRailMaterial`), so the
    // floor comes from the emissive path instead. 0.07 is deliberately small: it lifts a
    // fully shaded board to a legible mid-tone and moves a sunlit one by a few percent,
    // and a good share of real trackside advertising is internally lit anyway.
    this._nightEmissive.push({ material: mat, day: 0.07, night: 0.85 });
    this._signMat = mat;
    return mat;
  }

  /** Turn an instanced quad into a camera-facing card. */
  _billboard(material, key) {
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <project_vertex>', `
vec4 cardCentre = modelViewMatrix * instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
vec4 mvPosition = cardCentre + vec4( transformed.xy, 0.0, 0.0 );
gl_Position = projectionMatrix * mvPosition;`);
    };
    material.customProgramCacheKey = () => key;
    material.needsUpdate = true;
    return material;
  }

  // --- night textures ---------------------------------------------------------------

  /**
   * The pool decal. U runs across the road and clamps; V runs along it and repeats, so
   * one texture serves both a single pool and a run of them. The elliptical falloff
   * reaches zero at every edge, which is what lets the V tiling leave dark road between
   * consecutive pools instead of seaming.
   */
  _poolTexture() {
    const w = 96;
    const h = 192;
    const data = new Uint8Array(w * h * 4);
    const rng = new Rng(0x1f37a2d1);
    // Per-column gain: wet tarmac smears a light source along the road, never across it,
    // so the streaking has to be constant down V and noisy across U.
    const lanes = new Float32Array(w);
    for (let i = 0; i < w; i++) lanes[i] = rng.next();

    for (let y = 0; y < h; y++) {
      const v = ((y + 0.5) / h) * 2 - 1;
      for (let x = 0; x < w; x++) {
        const u = ((x + 0.5) / w) * 2 - 1;
        const r = Math.sqrt(u * u * 1.06 + v * v);
        const fall = Math.max(0, 1 - r);
        const lane = lanes[x];
        const streak = 0.30 + 0.62 * lane * (0.55 + 0.45 * Math.sin(v * 3.4 + lane * 9.1));
        let l = fall * fall * (0.30 + 0.70 * fall) * streak;
        l += fall * fall * fall * fall * 0.55;          // the hot core under the mast
        l *= 0.94 + 0.12 * rng.next();                  // grain, so it is not a clean ramp
        const cool = 0.30 * r;
        const o = (y * w + x) * 4;
        data[o] = this._encode(l * (1.0 - cool * 0.25));
        data[o + 1] = this._encode(l * (0.975 - cool * 0.05));
        data[o + 2] = this._encode(l * (0.90 + cool * 0.30));
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

  /** The flare card around a lamp bank: a tight core in a wide halo. */
  _glowTexture() {
    const s = 64;
    const data = new Uint8Array(s * s * 4);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const dx = ((x + 0.5) / s) * 2 - 1;
        const dy = ((y + 0.5) / s) * 2 - 1;
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

  /**
   * The LED board faces, one per V band.
   *
   * The old atlas was random blocks of saturated colour on a black grid. At any distance
   * a rectangle of pure channel colour with nothing drawn on it reads as a debug
   * material — the review called these "flat magenta and teal placeholder blocks", and
   * it was right. These carry the same invented wordmarks the hoardings do.
   */
  _ledTexture() {
    if (this._led) return this._led;
    const td = buildLedPanels(512, 96, 7743);
    const tex = makeDataTexture(td.color, td.width, td.height, THREE.SRGBColorSpace);
    tex.anisotropy = this.ctx.materials.anisotropy ?? 4;
    this._textures.push(tex);
    this._led = { map: tex, rows: td.rows };
    return this._led;
  }

  /** Lit and unlit window cells for the upper storey of the pit building. */
  _windowTexture() {
    const w = 112;
    const h = 48;
    const data = new Uint8Array(w * h * 4);
    const rng = new Rng(0x5d19c407);
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
        // Mullions: the dark grid between panes is most of what says "building".
        const mullion = ix < 1 || ix > cw - 2 || iy < 2 || iy > ch - 3 ? 0.02 : 1;
        // Rooms are brighter at the ceiling, which is where their lights are.
        const gradient = 0.75 + 0.45 * (1 - iy / ch);
        const l = cells[cy * cols + cx] * mullion * gradient;
        const o = (y * w + x) * 4;
        data[o] = this._encode(l * 1.0);
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

  /** One garage bay: a lit mouth between two dark piers, tiled per box. */
  _garageTexture() {
    const w = 96;
    const h = 64;
    const data = new Uint8Array(w * h * 4);
    const rng = new Rng(0x3ab90f52);
    for (let y = 0; y < h; y++) {
      const fy = (y + 0.5) / h;
      // Brightest at the floor: the work lights inside are aimed down at the car.
      const floor = 0.55 + 0.75 * (1 - fy) ** 1.6;
      for (let x = 0; x < w; x++) {
        const fx = (x + 0.5) / w;
        const mouth = fx > 0.16 && fx < 0.84 ? 1 : 0.03;
        const shoulder = clamp01((Math.min(fx - 0.16, 0.84 - fx)) / 0.06);
        const l = mouth * shoulder * floor * (0.92 + 0.16 * rng.next());
        const o = (y * w + x) * 4;
        data[o] = this._encode(l * 1.0);
        data[o + 1] = this._encode(l * 0.90);
        data[o + 2] = this._encode(l * 0.72);
        data[o + 3] = 255;
      }
    }
    const tex = makeDataTexture(data, w, h, THREE.SRGBColorSpace);
    tex.anisotropy = this.ctx.materials.anisotropy ?? 4;
    this._textures.push(tex);
    return tex;
  }

  /** Linear intensity to an 8-bit sRGB sample. */
  _encode(l) {
    return Math.round(255 * clamp01(Math.pow(clamp01(l), 1 / 2.2)));
  }

  // --- shared ---------------------------------------------------------------------

  /**
   * Bake a list of instance placements of one geometry into a merged accumulator.
   *
   * The counterpart to `_instance`, for the lists that are too short to be worth their
   * own draw call. Normals go through the inverse-transpose rather than the matrix, so
   * a placement with a non-uniform scale — every floodlight mast is a unit cylinder
   * stretched to its own height — still shades as the shape it ended up as rather than
   * as the shape it was authored as. Build-time only.
   */
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

  /** Drives the wind, the crowd and the floodlights. Called once per frame; allocates nothing. */
  animate(elapsed) {
    this._time.value = elapsed;
    const weather = this.ctx.sky?.weather;
    if (weather) {
      const speed = clamp(weather.windSpeed ?? 4, 0, 26) / 12;
      this._wind.value.set(Math.sin(weather.windDir ?? 0) * speed, -Math.cos(weather.windDir ?? 0) * speed);
    }

    const nf = this._nightAmount();
    // Materials and light counts only move when the sun does, and the sun moves once a
    // session: re-running the whole rig every frame would dirty uniforms for nothing.
    if (Math.abs(nf - this._nightFactor) > 1e-3) {
      this._nightFactor = nf;
      this._applyNight(nf);
    }
    if (nf > 0.01) this._updateSpots(nf);
  }

  setQuality(tier) {
    this.tier = tier;
    if (this._crowd) this._crowd.visible = (tier?.crowdDetail ?? 1) > 0;
    // A tier change alters how many spots are live, and a spot left at its old intensity
    // would keep lighting the circuit from a mast nothing is aiming at any more.
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
    // Every cached builder handle points at something that has just been disposed; a
    // rebuild that reused one would bind a dead texture.
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
