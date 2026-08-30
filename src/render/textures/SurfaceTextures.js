import {
  Noise, WorleyGrid, createField, normaliseField, normalFromHeight, fbmField, ridgedField,
  aoFromHeight, clamp01, mix, smoothstep,
} from './NoiseTextures.js';

/**
 * Track-surface texture generators: tarmac and its wear states, kerbs, run-off and
 * grass. Every builder returns a `TexData` — raw byte buffers plus the physical size
 * of one tile in metres, which the MaterialLibrary hands on to consumers so that
 * geometry can set UVs in world units rather than guessing a repeat factor.
 *
 *   { width, height, color: Uint8Array(RGBA), normal: Uint8Array(RGBA),
 *     orm: Uint8Array(RGBA), tileU: metres, tileV: metres }
 *
 * Physical dimensions are taken from real circuit construction: 0/11 stone-mastic
 * asphalt (11 mm nominal aggregate), 0.5 m kerb blocks with a 250 mm rib pitch,
 * 20-45 mm run-off gravel, 100 mm painted lines.
 */

const ASPHALT_TILE = 2.4;      // metres covered by one tarmac tile
// 0/11 stone-mastic asphalt, which is what an FIA-grade circuit is surfaced in: a
// coarse fraction of 10-14 mm chippings held in a mortar of 5-7 mm fines. The cell
// pitch is the stone pitch, and WorleyGrid draws each stone at 0.78-1.12 of its cell,
// so 184 cells across a 2.4 m tile is a 13 mm pitch and a 10-14.6 mm stone. The 96 and
// 216 these used to be put the coarse fraction at 19-28 mm — kerbstone, not asphalt —
// and with nothing at the fine end the surface had no scale reference at all and read
// as undifferentiated pepper noise.
const AGGREGATE_COARSE = 184;  // cells per tile -> 13 mm pitch, 10-14.6 mm stone
const AGGREGATE_FINE = 360;    // cells per tile -> 6.7 mm pitch, 5.2-7.5 mm chipping

/**
 * Build the shared tarmac substrate once. Every asphalt variant is a re-colouring of
 * these fields, so the expensive cellular pass is paid a single time and 'worn',
 * 'patch' and the racing line come essentially free.
 */
export function buildAsphaltFields(size, seed = 1201) {
  const n = size * size;
  const noise = new Noise(seed);
  const noiseB = new Noise(seed + 101);
  const coarse = new WorleyGrid(AGGREGATE_COARSE, AGGREGATE_COARSE, seed + 7, 1.0);
  const fine = new WorleyGrid(AGGREGATE_FINE, AGGREGATE_FINE, seed + 23, 1.0);

  // Warping the aggregate lookup breaks the underlying lattice: without it the stones
  // read as a grid of dots the moment the camera gets low. The warp field itself is
  // low-frequency, so it is rasterised cheaply and upsampled.
  const warpX = fbmField(noise, size, size, 12, 12, 1, 2, 0.5);
  const warpY = fbmField(noiseB, size, size, 12, 12, 1, 2, 0.5);
  const macroF = fbmField(noise, size, size, 4, 4, 4, 2.0, 0.55);
  const grainF = fbmField(noise, size, size, 192, 192, 2, 2.4, 0.5);

  const height = createField(size, size);
  const stone = createField(size, size);   // 0 = binder, 1 = exposed aggregate crown
  const tone = createField(size, size);    // per-stone albedo key, 0..1

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;

      const wu = u + warpX[i] * 0.006;
      const wv = v + warpY[i] * 0.006;
      const macro = macroF[i];
      const grain = grainF[i];

      const c = coarse.query(wu, wv);
      const rc = 0.30 + c.size * 0.26;
      const dc = c.f1 / rc;
      const domeC = dc < 1 ? Math.sqrt(1 - dc * dc) : 0;

      const f = fine.query(wu, wv);
      const rf = 0.28 + f.size * 0.26;
      const df = f.f1 / rf;
      const domeF = df < 1 ? Math.sqrt(1 - df * df) : 0;

      // Binder-rich areas bury the aggregate; weathered areas expose it. This is what
      // separates a real road surface from a uniform noise field.
      const exposure = clamp01(0.55 + macro * 0.85);
      const sc = domeC * exposure;
      const sf = domeF * (0.35 + exposure * 0.55);

      height[i] = 0.30 + sc * 0.44 + sf * 0.15 + grain * 0.045 + macro * 0.05;
      stone[i] = clamp01(Math.max(sc * 1.25, sf * 0.85));
      tone[i] = sc >= sf ? c.id : f.id;
    }
  }

  normaliseField(height, 0, 1);
  // Cavity radius sized to the void between two coarse stones, ~9 mm, not to a stone.
  const ao = aoFromHeight(height, size, size, Math.max(2, size >> 8), 1.15);

  return { size, height, stone, tone, grain: grainF, macro: macroF, ao, tile: ASPHALT_TILE };
}

const BINDER_FRESH = [0x2c, 0x2c, 0x2f];
const BINDER_WORN = [0x53, 0x51, 0x4e];
const STONE_DARK = [0x45, 0x45, 0x4a];
const STONE_MID = [0x69, 0x67, 0x62];
const STONE_PALE = [0x8d, 0x8a, 0x80];
const QUARTZ = [0xb2, 0xaf, 0xa4];

/**
 * Colour + ORM for one asphalt wear state.
 * `wear` 0 = freshly laid black tarmac, 1 = a decade of traffic: greyed binder, fully
 * exposed and polished aggregate, rubber and dust ground into the voids.
 */
export function asphaltSurface(fields, wear = 0.35) {
  const { size, height, stone, tone, grain, macro, ao } = fields;
  const n = size * size;
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);

  // How far the exposed stone crowns have been polished by traffic. Uniform across the
  // tile: this texture knows nothing about where the track is, only how old it is.
  const trackPolish = clamp01((wear - 0.4) / 0.6);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const s = stone[i];
      const t = tone[i];
      const g = grain[i];
      const m = macro[i];

      let sr, sg, sb;
      if (t > 0.94) { sr = QUARTZ[0]; sg = QUARTZ[1]; sb = QUARTZ[2]; }
      else if (t > 0.66) { sr = STONE_PALE[0]; sg = STONE_PALE[1]; sb = STONE_PALE[2]; }
      else if (t > 0.30) { sr = STONE_MID[0]; sg = STONE_MID[1]; sb = STONE_MID[2]; }
      else { sr = STONE_DARK[0]; sg = STONE_DARK[1]; sb = STONE_DARK[2]; }

      const br = mix(BINDER_FRESH[0], BINDER_WORN[0], wear);
      const bg = mix(BINDER_FRESH[1], BINDER_WORN[1], wear);
      const bb = mix(BINDER_FRESH[2], BINDER_WORN[2], wear);

      // Aggregate only shows through once the binder film has worn off it.
      const reveal = clamp01(s * (0.55 + wear * 1.05));
      let r = mix(br, sr, reveal);
      let gg = mix(bg, sg, reveal);
      let b = mix(bb, sb, reveal);

      // Fine grain and large-scale patchiness modulate value, not hue.
      const shade = 1 + g * 0.16 + m * 0.06;
      r *= shade; gg *= shade; b *= shade;

      // Pale limestone dust collects in the voids and lifts them slightly warm.
      const dust = clamp01((0.55 - height[i]) * 1.6) * (0.10 + wear * 0.22);
      r = mix(r, 0x8e, dust * 0.5);
      gg = mix(gg, 0x88, dust * 0.5);
      b = mix(b, 0x7a, dust * 0.4);

      const j = i * 4;
      color[j] = Math.min(255, r);
      color[j + 1] = Math.min(255, gg);
      color[j + 2] = Math.min(255, b);
      color[j + 3] = 255;

      // Binder is matte; exposed stone crowns polish under traffic. Nothing here may
      // depend on v: this tile repeats every 2.4 m *across* a 15 m track, so the
      // longitudinal polish band that used to live at v = 0.5 was not one wheel track,
      // it was six of them side by side — a false wet stripe every 2.4 m of width.
      // Where the cars actually run is the racing-line decal's job, and only its job.
      let rough = mix(0.94, 0.86 - wear * 0.10, s);
      rough -= s * trackPolish * 0.24;
      rough += g * 0.05;
      rough += m * 0.05;

      orm[j] = Math.max(0, Math.min(255, ao[i] * 255));
      orm[j + 1] = Math.max(0, Math.min(255, clamp01(rough) * 255));
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }

  return { color, orm };
}

export function asphaltNormal(fields, strength = 1.5) {
  return normalFromHeight(fields.height, fields.size, fields.size, strength);
}

/**
 * Resurfacing patches: a coarse rectangular grid of repaved cells, each with its own
 * age, separated by a raised, tar-sealed joint. The joint is the tell — a patch
 * without a proud seam looks like a decal, with one it looks like roadworks.
 */
export function buildAsphaltPatch(fields, seed = 6100) {
  const { size, height, stone, tone, grain, macro } = fields;
  const n = size * size;
  const noise = new Noise(seed);
  const noiseB = new Noise(seed + 61);
  const cellsU = 3;
  const cellsV = 2;

  // Wobble the cut lines so the joints are saw-cut, not CAD-straight.
  const wobbleU = fbmField(noise, size, size, 9, 9, 1, 2, 0.5);
  const wobbleV = fbmField(noiseB, size, size, 9, 9, 1, 2, 0.5);
  const beadF = fbmField(noise, size, size, 80, 80, 1, 2, 0.5);

  const patchHeight = new Float32Array(height);
  const seamF = createField(size, size);
  const ageF = createField(size, size);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const u = (x + 0.5) / size;

      const ju = u + wobbleU[i] * 0.012;
      const jv = v + wobbleV[i] * 0.012;

      const fu = ju * cellsU;
      const fv = jv * cellsV;
      const du = Math.abs(fu - Math.round(fu));
      const dv = Math.abs(fv - Math.round(fv));
      const d = Math.min(du / cellsU, dv / cellsV) * size;   // texels from the nearest joint

      const seam = clamp01(1 - d / 3.5);
      seamF[i] = seam;

      const cell = noise.cellRandom(Math.floor(fu), Math.floor(fv));
      ageF[i] = cell;

      // Tar sealant sits proud of the surface as a rounded bead.
      patchHeight[i] = height[i] * (1 - seam * 0.7) + seam * (0.62 + beadF[i] * 0.06);
    }
  }

  const ao = aoFromHeight(patchHeight, size, size, Math.max(2, size >> 7), 1.0);
  const normal = normalFromHeight(patchHeight, size, size, 1.5);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);

  for (let i = 0; i < n; i++) {
    const s = stone[i];
    const t = tone[i];
    const wear = 0.12 + ageF[i] * 0.85;
    const seam = seamF[i];

    let sr, sg, sb;
    if (t > 0.94) { sr = QUARTZ[0]; sg = QUARTZ[1]; sb = QUARTZ[2]; }
    else if (t > 0.66) { sr = STONE_PALE[0]; sg = STONE_PALE[1]; sb = STONE_PALE[2]; }
    else if (t > 0.30) { sr = STONE_MID[0]; sg = STONE_MID[1]; sb = STONE_MID[2]; }
    else { sr = STONE_DARK[0]; sg = STONE_DARK[1]; sb = STONE_DARK[2]; }

    const br = mix(BINDER_FRESH[0], BINDER_WORN[0], wear);
    const bg = mix(BINDER_FRESH[1], BINDER_WORN[1], wear);
    const bb = mix(BINDER_FRESH[2], BINDER_WORN[2], wear);
    const reveal = clamp01(s * (0.35 + wear * 0.9));

    const shade = 1 + grain[i] * 0.13 + macro[i] * 0.09;
    let r = mix(br, sr, reveal) * shade;
    let g = mix(bg, sg, reveal) * shade;
    let b = mix(bb, sb, reveal) * shade;

    // Fresh bitumen sealant: near-black and noticeably glossier than the road.
    r = mix(r, 0x17, seam);
    g = mix(g, 0x16, seam);
    b = mix(b, 0x18, seam);

    const j = i * 4;
    color[j] = Math.min(255, r);
    color[j + 1] = Math.min(255, g);
    color[j + 2] = Math.min(255, b);
    color[j + 3] = 255;

    let rough = mix(0.94, 0.84, s) - s * clamp01(wear - 0.4) * 0.25;
    rough = mix(rough, 0.52, seam);
    orm[j] = Math.max(0, Math.min(255, ao[i] * 255));
    orm[j + 1] = Math.max(0, Math.min(255, clamp01(rough) * 255));
    orm[j + 2] = 0;
    orm[j + 3] = 255;
  }

  return { width: size, height: size, color, normal, orm, tileU: ASPHALT_TILE, tileV: ASPHALT_TILE };
}

/**
 * The rubbered-in racing line. Laid down as a decal strip over the tarmac, so the
 * colour map carries alpha: a ragged-edged core that fades out laterally.
 *
 * Real rubbered tarmac is not just "dark grey" — it is a filled, near-specular skin
 * with a slight brown-black cast that flares hard when the sun is low. That contrast
 * against matte tarmac is the single strongest realism cue on a circuit.
 */
export function buildRacingLine(width = 512, heightPx = 256, seed = 8800) {
  const n = width * heightPx;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(width, heightPx);

  // Streaks run along the direction of travel: stretched heavily in U.
  const streakF = fbmField(noise, width, heightPx, 6, 64, 4, 2.2, 0.55);
  const blotchF = fbmField(noise, width, heightPx, 5, 5, 3, 2.0, 0.5);
  const microF = fbmField(noise, width, heightPx, 140, 140, 2, 2.3, 0.5);

  for (let y = 0; y < heightPx; y++) {
    const v = (y + 0.5) / heightPx;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;

      const streak = streakF[i];
      const blotch = blotchF[i];
      const micro = microF[i];

      // Lateral coverage profile with a noisy edge; the line is never a clean band.
      const edgeNoise = streak * 0.10 + blotch * 0.08;
      const dist = Math.abs(v - 0.5) * 2;
      let cover = smoothstep(1.0, 0.28, dist + edgeNoise);
      cover *= clamp01(0.72 + blotch * 0.5 + streak * 0.22);

      // Deep black core, browner and thinner at the shoulders. Laid-down rubber is the
      // darkest thing on a circuit — well under half the value of the tarmac it covers,
      // which on a fresh surface sits around 0x40. It has to *read* darker or the line
      // is invisible whatever its gloss does.
      const core = clamp01(cover * 1.25);
      const r = mix(0x24, 0x0e, core) + micro * 5;
      const g = mix(0x20, 0x0c, core) + micro * 5;
      const b = mix(0x1d, 0x0e, core) + micro * 5;

      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = Math.max(0, Math.min(255, cover * 255));

      // Rubber fills the aggregate voids, so relief drops as coverage rises.
      hf[i] = 0.5 + streak * 0.10 * (1 - core) + micro * 0.03;

      // Glossier than the 0.86-0.94 tarmac around it, because the voids are filled and
      // the surface is continuous — but 0.52 at the core, not the 0.30 this ran at. At
      // 0.30 under a cloudless sky the specular lobe is tight enough to mirror it, and
      // the driving line came out *brighter* than the dry track either side: the broad
      // wet sheen the review picked up. 0.52 keeps the contrast and loses the mirror.
      const rough = clamp01(mix(0.80, 0.52, core) + micro * 0.05 + streak * 0.05);
      orm[j] = 255;
      orm[j + 1] = rough * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }

  const normal = normalFromHeight(hf, width, heightPx, 0.7);
  return { width, height: heightPx, color, normal, orm, tileU: 6.0, tileV: 2.4 };
}

/**
 * Painted line (grid markings, pit lane edge, track limits). 100 mm wide in reality;
 * the tile covers 0.6 m so a line quad can repeat it along its length. Alpha carries
 * the chipping so the tarmac shows through worn paint.
 */
export function buildPaintLine(size = 256, seed = 3300) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);

  const wearF = fbmField(noise, size, size, 14, 14, 4, 2.1, 0.55);
  const gritF = fbmField(noise, size, size, 130, 130, 2, 2.4, 0.5);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;

      const wear = wearF[i];
      const chips = noise.worley2p(u * 26, v * 26, 26, 26);
      const grit = gritF[i];

      // Paint is thickest where it is not scrubbed; chips bite in from cell edges.
      let coverage = clamp01(0.86 + wear * 0.7);
      coverage *= clamp01(smoothstep(0.10, 0.26, chips.f1) + 0.45);
      coverage = clamp01(coverage);

      const tint = 0xea + grit * 12 + wear * 8;
      const dirt = clamp01(0.5 - wear) * 0.35;
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, tint - dirt * 60));
      color[j + 1] = Math.max(0, Math.min(255, tint - dirt * 58));
      color[j + 2] = Math.max(0, Math.min(255, tint - dirt * 50));
      color[j + 3] = Math.max(0, Math.min(255, coverage * 255));

      hf[i] = 0.5 + coverage * 0.22 + grit * 0.05;

      // Road paint contains glass beads: glossier than tarmac, never mirror-like.
      orm[j] = 255;
      orm[j + 1] = clamp01(0.44 + grit * 0.10 + (1 - coverage) * 0.35) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }

  const normal = normalFromHeight(hf, size, size, 1.1);
  return { width: size, height: size, color, normal, orm, tileU: 0.6, tileV: 0.6 };
}

const KERB_RED = [0xb4, 0x1f, 0x2c];
const KERB_WHITE = [0xe4, 0xe2, 0xda];
const KERB_CONCRETE = [0x9c, 0x99, 0x91];

/**
 * Kerb top surface. One tile covers 4 m along the track by 1 m across, holding eight
 * 0.5 m painted blocks (FIA standard) and sixteen 250 mm transverse ribs.
 *
 * `style` 'entry' is the crisp 50 mm ribbed kerb; 'exit' is the flatter, wider-blocked
 * exit kerb, faded and far more heavily rubbered because cars use all of it.
 */
export function buildKerb(width = 512, heightPx = 128, style = 'entry', seed = 5150) {
  const n = width * heightPx;
  const noise = new Noise(seed + (style === 'exit' ? 77 : 0));
  const exit = style === 'exit';

  const blocks = exit ? 6 : 8;          // 0.67 m vs 0.5 m painted blocks
  const ribs = exit ? 12 : 16;          // rib pitch along the track
  const ribAmp = exit ? 0.10 : 0.26;
  const fade = exit ? 0.34 : 0.12;      // paint fade toward bare concrete

  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(width, heightPx);
  const rubberF = createField(width, heightPx);

  const chipMaskF = fbmField(noise, width, heightPx, 12, 12, 3, 2, 0.5);
  const gritF = fbmField(noise, width, heightPx, 180, 45, 3, 2.3, 0.5);
  // Rubber lands in streaks along the direction of travel, not in soft clouds.
  const patchF = fbmField(new Noise(seed + 137), width, heightPx, 22, 5, 4, 2.1, 0.55);
  const paintF = fbmField(noise, width, heightPx, 5, 5, 3, 2, 0.5);
  const scuffF = fbmField(new Noise(seed + 211), width, heightPx, 3, 90, 3, 2.4, 0.5);

  for (let y = 0; y < heightPx; y++) {
    const v = (y + 0.5) / heightPx;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const i = y * width + x;

      // Cast chamfers on both long edges; the top itself is near flat, with only the
      // slight crown a kerb is cast with so water runs off it.
      const edge = Math.min(smoothstep(0.0, 0.075, v), smoothstep(1.0, 0.925, v));
      const crown = Math.sin(v * Math.PI) * 0.028;

      // Ribs are a raised cosine: continuous in slope, so the normal map has no cusp
      // line at each rib boundary the way |sin| would leave.
      const rp = u * ribs;
      const rf = rp - Math.floor(rp);
      const rib = 0.5 - 0.5 * Math.cos(rf * Math.PI * 2);

      // Cast sections butt together with a visible joint every painted block.
      const bp = u * blocks;
      const jointPx = (Math.abs(bp - Math.round(bp)) / blocks) * width;
      const joint = clamp01(1 - jointPx / 1.6);

      const chip = noise.worley2p(u * 60, v * 15, 60, 15);
      const chipMask = clamp01(smoothstep(0.06, 0.015, chip.f1)) * clamp01(0.35 + chipMaskF[i]);
      const grit = gritF[i];

      hf[i] = 0.34 + edge * 0.32 + crown + rib * ribAmp * edge - chipMask * 0.16
        - joint * 0.22 + grit * 0.035;

      // Rubber pickup: concentrated on the track-side edge and on the rib crests
      // that the floor and tyres actually strike.
      const side = smoothstep(0.10, 0.85, v);
      const patch = clamp01(patchF[i] * 1.6 - 0.05);
      rubberF[i] = clamp01(side * patch * (0.30 + rib * 0.95) * (exit ? 1.20 : 0.80));

      const blockIdx = Math.floor(bp);
      const red = (blockIdx & 1) === 0;
      const base = red ? KERB_RED : KERB_WHITE;

      const paintWear = clamp01(fade + paintF[i] * 0.45 + chipMask * 0.9);
      let r = mix(base[0], KERB_CONCRETE[0], paintWear);
      let g = mix(base[1], KERB_CONCRETE[1], paintWear);
      let b = mix(base[2], KERB_CONCRETE[2], paintWear);

      // Bake the chamfer's own shading in: the sloped face never faces the sun squarely.
      const shade = 1 + grit * 0.10 - chipMask * 0.12 - (1 - edge) * 0.22 - joint * 0.45;
      r *= shade; g *= shade; b *= shade;

      // Scuff streaks from carbon floors: bright grey scratches along the track axis.
      const scuff = clamp01(scuffF[i] * 1.4 - 0.72) * side;
      r = mix(r, 0xc8, scuff * 0.5);
      g = mix(g, 0xc6, scuff * 0.5);
      b = mix(b, 0xc2, scuff * 0.5);

      const rub = rubberF[i];
      r = mix(r, 0x1a, rub * 0.86);
      g = mix(g, 0x18, rub * 0.86);
      b = mix(b, 0x19, rub * 0.86);

      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;

      let rough = mix(0.58, 0.90, paintWear);
      rough = mix(rough, 0.36, rub);
      rough += grit * 0.05;
      orm[j] = 255;
      orm[j + 1] = clamp01(rough) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, width, heightPx, 3, 1.0);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, width, heightPx, exit ? 1.8 : 2.5);
  return { width, height: heightPx, color, normal, orm, tileU: 4.0, tileV: 1.0 };
}

/**
 * Grass with mowing stripes. The stripes are not painted on: alternating bands of
 * blades are combed in opposite directions, which flips the normal lean and therefore
 * the amount of light they bounce. Baking that into the normal map means the stripes
 * appear and disappear correctly as the sun moves.
 */
export function buildGrass(size = 512, seed = 2400) {
  const n = size * size;
  const noise = new Noise(seed);
  const tufts = new WorleyGrid(34, 34, seed + 9, 1.0);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const stripes = 4;   // 1 m mowing bands across a 4 m tile

  const patchF = fbmField(noise, size, size, 3, 3, 4, 2.0, 0.55);
  const bladeF = fbmField(noise, size, size, 190, 46, 2, 2.35, 0.5);
  const blade2F = fbmField(new Noise(seed + 31), size, size, 380, 92, 1, 2.2, 0.5);

  const DRY = [0x8a, 0x88, 0x4c];
  const MID = [0x4f, 0x72, 0x2b];
  const LUSH = [0x28, 0x51, 0x19];
  const EARTH = [0x5d, 0x4c, 0x33];

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    const stripeIdx = Math.floor(v * stripes);
    const lean = (stripeIdx & 1) === 0 ? 1 : -1;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;

      const patch = patchF[i];
      const dryness = clamp01(0.42 + patch * 0.8);
      const clump = tufts.query(u, v);
      const tuft = clamp01(1 - clump.f1 / (0.30 + clump.size * 0.35));

      // Blades: high-frequency noise stretched along the mowing direction.
      const blade = bladeF[i];
      const blade2 = blade2F[i];

      hf[i] = 0.45 + tuft * 0.22 + blade * 0.18 + blade2 * 0.09 + patch * 0.10
        + lean * 0.035 * (0.5 + blade * 0.5);

      let r, g, b;
      if (dryness > 0.62) {
        const t = (dryness - 0.62) / 0.38;
        r = mix(MID[0], DRY[0], t); g = mix(MID[1], DRY[1], t); b = mix(MID[2], DRY[2], t);
      } else {
        const t = dryness / 0.62;
        r = mix(LUSH[0], MID[0], t); g = mix(LUSH[1], MID[1], t); b = mix(LUSH[2], MID[2], t);
      }

      // Bare earth where the turf thins out — sparse, or it reads as camouflage.
      const bare = clamp01((0.12 - tuft) * 4.0) * clamp01(dryness * 1.6 - 0.85);
      r = mix(r, EARTH[0], bare * 0.6);
      g = mix(g, EARTH[1], bare * 0.6);
      b = mix(b, EARTH[2], bare * 0.6);

      const shade = 1 + blade * 0.24 + blade2 * 0.10 + tuft * 0.10 + lean * 0.035;
      r *= shade; g *= shade; b *= shade;

      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;

      orm[j + 1] = clamp01(0.88 - dryness * 0.06 + blade * 0.05) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, size, size, Math.max(2, size >> 6), 1.2);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, size, size, 2.6);
  return { width: size, height: size, color, normal, orm, tileU: 4.0, tileV: 4.0 };
}

/**
 * Synthetic astroturf strip. Uniform saturated green, dense vertical fibre, almost no
 * large-scale variation — it is a manufactured mat, and reading as one is the point.
 */
export function buildAstroturf(size = 256, seed = 7700) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);

  const fibreF = fbmField(noise, size, size, 220, 18, 2, 2.3, 0.5);
  const fineF = fbmField(new Noise(seed + 13), size, size, 440, 36, 1, 2.2, 0.5);
  const wearF = fbmField(noise, size, size, 4, 4, 3, 2, 0.5);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;

      const fibre = fibreF[i];
      const fine = fineF[i];
      const wear = wearF[i];

      hf[i] = 0.5 + fibre * 0.30 + fine * 0.15;

      const shade = 1 + fibre * 0.30 + fine * 0.12 + wear * 0.08;
      // Fresh fibre is a slightly acidic green; traffic flattens and greys it.
      const grey = clamp01(0.18 + wear * 0.45);
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, mix(0x3a, 0x6a, grey) * shade));
      color[j + 1] = Math.max(0, Math.min(255, mix(0x86, 0x8a, grey) * shade));
      color[j + 2] = Math.max(0, Math.min(255, mix(0x2e, 0x52, grey) * shade));
      color[j + 3] = 255;

      orm[j] = 255;
      orm[j + 1] = clamp01(0.76 + fibre * 0.08 + wear * 0.06) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, size, size, 4, 1.0);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, size, size, 2.2);
  return { width: size, height: size, color, normal, orm, tileU: 1.5, tileV: 1.5 };
}

/**
 * Run-off gravel. Real FIA gravel traps use 20-45 mm rounded river pebbles so a car
 * digs in rather than skating; two cellular layers give that size distribution and the
 * deep shadow between stones that sells the depth.
 */
export function buildGravel(size = 512, seed = 9100) {
  const n = size * size;
  const noise = new Noise(seed);
  const big = new WorleyGrid(46, 46, seed + 3, 1.0);     // ~39 mm over a 1.8 m tile
  const small = new WorleyGrid(98, 98, seed + 41, 1.0);  // ~18 mm
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const idF = createField(size, size);

  const warpX = fbmField(noise, size, size, 8, 8, 1, 2, 0.5);
  const warpY = fbmField(new Noise(seed + 71), size, size, 8, 8, 1, 2, 0.5);
  const gritF = fbmField(noise, size, size, 260, 260, 2, 2.3, 0.5);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;

      const wx = u + warpX[i] * 0.010;
      const wy = v + warpY[i] * 0.010;
      const a = big.query(wx, wy);
      const ra = 0.34 + a.size * 0.30;
      const da = a.f1 / ra;
      const domeA = da < 1 ? Math.pow(1 - da * da, 0.62) : 0;

      const b = small.query(wx * 1.03 + 0.17, wy * 1.03 + 0.29);
      const rb = 0.30 + b.size * 0.30;
      const db = b.f1 / rb;
      const domeB = db < 1 ? Math.pow(1 - db * db, 0.62) : 0;

      const grit = gritF[i];

      const top = Math.max(domeA * 0.95, domeB * 0.62);
      hf[i] = 0.18 + domeA * 0.62 + domeB * 0.30 + grit * 0.05;
      idF[i] = domeA * 0.95 >= domeB * 0.62 ? a.id : b.id;

      // Limestone through to weathered basalt, plus grey dust in the voids.
      const id = idF[i];
      let r = mix(0x5c, 0xd2, id), g = mix(0x55, 0xc6, id), bl = mix(0x4a, 0xae, id);
      if (id > 0.88) { r = 0x7a; g = 0x6d; bl = 0x5a; }        // the odd ironstone pebble
      else if (id < 0.08) { r = 0x3f; g = 0x3d; bl = 0x3c; }   // and the odd basalt one
      const shade = 0.70 + top * 0.46 + grit * 0.11;
      r *= shade; g *= shade; bl *= shade;

      const dust = clamp01((0.36 - hf[i]) * 2.4);
      r = mix(r, 0x7d, dust * 0.55);
      g = mix(g, 0x77, dust * 0.55);
      bl = mix(bl, 0x6b, dust * 0.55);

      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, bl));
      color[j + 3] = 255;

      orm[j + 1] = clamp01(0.92 - top * 0.08 + grit * 0.05) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }

  normaliseField(hf, 0, 1);
  const ao = aoFromHeight(hf, size, size, Math.max(3, size >> 6), 1.6);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, size, size, 3.6);
  return { width: size, height: size, color, normal, orm, tileU: 1.8, tileV: 1.8 };
}

/**
 * Sand run-off / beach trap. Wind ripples at a ~120 mm pitch, domain-warped so they
 * meander, over a fine uniform grain.
 */
export function buildSand(size = 512, seed = 3900) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const ripples = 25;   // 3 m tile / 0.12 m pitch

  const meanderF = fbmField(noise, size, size, 3, 3, 1, 2, 0.5);
  const phaseF = fbmField(new Noise(seed + 19), size, size, 4, 4, 3, 2, 0.5);
  const driftF = fbmField(noise, size, size, 6, 6, 4, 2.1, 0.55);
  const grainF = fbmField(noise, size, size, 300, 300, 2, 2.4, 0.5);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;

      const phase = ((v + meanderF[i] * 0.05) * ripples + phaseF[i] * 1.6) * Math.PI * 2;
      const ripple = (Math.sin(phase) * 0.5 + 0.5) ** 1.6;
      const drift = driftF[i];
      const grain = grainF[i];

      hf[i] = 0.42 + ripple * 0.30 * clamp01(0.5 + drift) + drift * 0.16 + grain * 0.04;

      const shade = 0.90 + ripple * 0.16 + grain * 0.09 + drift * 0.08;
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, 0xd2 * shade));
      color[j + 1] = Math.max(0, Math.min(255, 0xc2 * shade));
      color[j + 2] = Math.max(0, Math.min(255, 0x9e * shade));
      color[j + 3] = 255;

      orm[j + 1] = clamp01(0.90 + grain * 0.06) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, size, size, Math.max(3, size >> 6), 1.0);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, size, size, 2.0);
  return { width: size, height: size, color, normal, orm, tileU: 3.0, tileV: 3.0 };
}

/**
 * Poured concrete: pit lane aprons, run-off slabs, barrier bases. Fine aggregate
 * showing through a worn cement skin, 2 m saw-cut control joints, hairline shrinkage
 * cracks from ridged noise, and the rain-streak staining that concrete always has.
 */
export function buildConcrete(size = 512, seed = 6600, palette = 'light') {
  const n = size * size;
  const noise = new Noise(seed);
  const agg = new WorleyGrid(120, 120, seed + 17, 1.0);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const joints = 2;     // 2 m control joints across a 4 m tile

  const skinF = fbmField(noise, size, size, 5, 5, 4, 2.0, 0.55);
  const blotchF = fbmField(new Noise(seed + 91), size, size, 3, 3, 3, 2.0, 0.6);
  const gritF = fbmField(noise, size, size, 160, 160, 2, 2.3, 0.5);
  const crackF = ridgedField(noise, size, size, 9, 9, 3, 2.1, 0.5, 1.0);
  const streakF = fbmField(new Noise(seed + 23), size, size, 10, 2, 4, 2.2, 0.5);

  const dark = palette === 'dark';
  const baseR = dark ? 0x6e : 0xa7, baseG = dark ? 0x6c : 0xa4, baseB = dark ? 0x68 : 0x9c;

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;

      const skin = skinF[i];
      const grit = gritF[i];
      const a = agg.query(u, v);
      const exposure = clamp01(0.35 + skin * 1.3);
      const stone = clamp01(1 - a.f1 / (0.26 + a.size * 0.22)) * exposure;

      const ju = Math.abs(u * joints - Math.round(u * joints)) / joints * size;
      const jv = Math.abs(v * joints - Math.round(v * joints)) / joints * size;
      const joint = clamp01(1 - Math.min(ju, jv) / 2.2);

      const crack = clamp01((crackF[i] - 0.86) * 9) * clamp01(0.3 + skin);

      hf[i] = 0.55 + stone * 0.20 + grit * 0.05 - joint * 0.42 - crack * 0.30;

      // Vertical rain staining: only meaningful on walls, harmless on slabs.
      const streak = clamp01(streakF[i] * 1.3 - 0.45);

      // Each pour cures to its own tone, and every slab collects its own oil and grime.
      const slab = noise.cellRandom(Math.floor(u * joints), Math.floor(v * joints)) - 0.5;
      const blotch = blotchF[i];
      let r = baseR + stone * 26 + grit * 14 + skin * 12 + slab * 18;
      let g = baseG + stone * 25 + grit * 14 + skin * 12 + slab * 18;
      let b = baseB + stone * 22 + grit * 13 + skin * 11 + slab * 17;
      const stain = streak * 0.30 + joint * 0.45 + crack * 0.55
        + clamp01(blotch * 1.4 - 0.35) * 0.30;
      r = mix(r, 0x4e, stain);
      g = mix(g, 0x4c, stain);
      b = mix(b, 0x48, stain);

      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;

      orm[j + 1] = clamp01(0.84 + grit * 0.06 - stone * 0.06 + streak * 0.05) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, size, size, Math.max(2, size >> 7), 1.0);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, size, size, 1.6);
  return { width: size, height: size, color, normal, orm, tileU: 4.0, tileV: 4.0 };
}

/** Convenience wrapper: build a complete asphalt variant as a TexData. */
export function buildAsphaltVariant(fields, wear, seed) {
  const { color, orm } = asphaltSurface(fields, wear, seed);
  return {
    width: fields.size,
    height: fields.size,
    color,
    orm,
    normal: null,               // shared with the base variant by the MaterialLibrary
    tileU: fields.tile,
    tileV: fields.tile,
  };
}
