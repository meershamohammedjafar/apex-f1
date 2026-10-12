import {
  Noise,
  WorleyGrid,
  createField,
  normaliseField,
  normalFromHeight,
  fbmField,
  ridgedField,
  aoFromHeight,
  clamp01,
  mix,
  smoothstep
} from "./NoiseTextures.js";
const ASPHALT_TILE = 2.4;
const AGGREGATE_COARSE = 184;
const AGGREGATE_FINE = 360;
export function buildAsphaltFields(size, seed = 1201) {
  const n = size * size;
  const noise = new Noise(seed);
  const noiseB = new Noise(seed + 101);
  const coarse = new WorleyGrid(AGGREGATE_COARSE, AGGREGATE_COARSE, seed + 7, 1);
  const fine = new WorleyGrid(AGGREGATE_FINE, AGGREGATE_FINE, seed + 23, 1);
  const warpX = fbmField(noise, size, size, 12, 12, 1, 2, 0.5);
  const warpY = fbmField(noiseB, size, size, 12, 12, 1, 2, 0.5);
  const macroF = fbmField(noise, size, size, 4, 4, 4, 2, 0.55);
  const grainF = fbmField(noise, size, size, 192, 192, 2, 2.4, 0.5);
  const height = createField(size, size);
  const stone = createField(size, size);
  const tone = createField(size, size);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;
      const wu = u + warpX[i] * 6e-3;
      const wv = v + warpY[i] * 6e-3;
      const macro = macroF[i];
      const grain = grainF[i];
      const c = coarse.query(wu, wv);
      const rc = 0.3 + c.size * 0.26;
      const dc = c.f1 / rc;
      const domeC = dc < 1 ? Math.sqrt(1 - dc * dc) : 0;
      const f = fine.query(wu, wv);
      const rf = 0.28 + f.size * 0.26;
      const df = f.f1 / rf;
      const domeF = df < 1 ? Math.sqrt(1 - df * df) : 0;
      const exposure = clamp01(0.55 + macro * 0.85);
      const sc = domeC * exposure;
      const sf = domeF * (0.35 + exposure * 0.55);
      height[i] = 0.3 + sc * 0.44 + sf * 0.15 + grain * 0.045 + macro * 0.05;
      stone[i] = clamp01(Math.max(sc * 1.25, sf * 0.85));
      tone[i] = sc >= sf ? c.id : f.id;
    }
  }
  normaliseField(height, 0, 1);
  const ao = aoFromHeight(height, size, size, Math.max(2, size >> 8), 1.15);
  return { size, height, stone, tone, grain: grainF, macro: macroF, ao, tile: ASPHALT_TILE };
}
const BINDER_FRESH = [44, 44, 47];
const BINDER_WORN = [83, 81, 78];
const STONE_DARK = [69, 69, 74];
const STONE_MID = [105, 103, 98];
const STONE_PALE = [141, 138, 128];
const QUARTZ = [178, 175, 164];
export function asphaltSurface(fields, wear = 0.35) {
  const { size, height, stone, tone, grain, macro, ao } = fields;
  const n = size * size;
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const trackPolish = clamp01((wear - 0.4) / 0.6);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const s = stone[i];
      const t = tone[i];
      const g = grain[i];
      const m = macro[i];
      let sr, sg, sb;
      if (t > 0.94) {
        sr = QUARTZ[0];
        sg = QUARTZ[1];
        sb = QUARTZ[2];
      } else if (t > 0.66) {
        sr = STONE_PALE[0];
        sg = STONE_PALE[1];
        sb = STONE_PALE[2];
      } else if (t > 0.3) {
        sr = STONE_MID[0];
        sg = STONE_MID[1];
        sb = STONE_MID[2];
      } else {
        sr = STONE_DARK[0];
        sg = STONE_DARK[1];
        sb = STONE_DARK[2];
      }
      const br = mix(BINDER_FRESH[0], BINDER_WORN[0], wear);
      const bg = mix(BINDER_FRESH[1], BINDER_WORN[1], wear);
      const bb = mix(BINDER_FRESH[2], BINDER_WORN[2], wear);
      const reveal = clamp01(s * (0.55 + wear * 1.05));
      let r = mix(br, sr, reveal);
      let gg = mix(bg, sg, reveal);
      let b = mix(bb, sb, reveal);
      const shade = 1 + g * 0.16 + m * 0.06;
      r *= shade;
      gg *= shade;
      b *= shade;
      const dust = clamp01((0.55 - height[i]) * 1.6) * (0.1 + wear * 0.22);
      r = mix(r, 142, dust * 0.5);
      gg = mix(gg, 136, dust * 0.5);
      b = mix(b, 122, dust * 0.4);
      const j = i * 4;
      color[j] = Math.min(255, r);
      color[j + 1] = Math.min(255, gg);
      color[j + 2] = Math.min(255, b);
      color[j + 3] = 255;
      let rough = mix(0.94, 0.86 - wear * 0.1, s);
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
export function buildAsphaltPatch(fields, seed = 6100) {
  const { size, height, stone, tone, grain, macro } = fields;
  const n = size * size;
  const noise = new Noise(seed);
  const noiseB = new Noise(seed + 61);
  const cellsU = 3;
  const cellsV = 2;
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
      const d = Math.min(du / cellsU, dv / cellsV) * size;
      const seam = clamp01(1 - d / 3.5);
      seamF[i] = seam;
      const cell = noise.cellRandom(Math.floor(fu), Math.floor(fv));
      ageF[i] = cell;
      patchHeight[i] = height[i] * (1 - seam * 0.7) + seam * (0.62 + beadF[i] * 0.06);
    }
  }
  const ao = aoFromHeight(patchHeight, size, size, Math.max(2, size >> 7), 1);
  const normal = normalFromHeight(patchHeight, size, size, 1.5);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const s = stone[i];
    const t = tone[i];
    const wear = 0.12 + ageF[i] * 0.85;
    const seam = seamF[i];
    let sr, sg, sb;
    if (t > 0.94) {
      sr = QUARTZ[0];
      sg = QUARTZ[1];
      sb = QUARTZ[2];
    } else if (t > 0.66) {
      sr = STONE_PALE[0];
      sg = STONE_PALE[1];
      sb = STONE_PALE[2];
    } else if (t > 0.3) {
      sr = STONE_MID[0];
      sg = STONE_MID[1];
      sb = STONE_MID[2];
    } else {
      sr = STONE_DARK[0];
      sg = STONE_DARK[1];
      sb = STONE_DARK[2];
    }
    const br = mix(BINDER_FRESH[0], BINDER_WORN[0], wear);
    const bg = mix(BINDER_FRESH[1], BINDER_WORN[1], wear);
    const bb = mix(BINDER_FRESH[2], BINDER_WORN[2], wear);
    const reveal = clamp01(s * (0.35 + wear * 0.9));
    const shade = 1 + grain[i] * 0.13 + macro[i] * 0.09;
    let r = mix(br, sr, reveal) * shade;
    let g = mix(bg, sg, reveal) * shade;
    let b = mix(bb, sb, reveal) * shade;
    r = mix(r, 23, seam);
    g = mix(g, 22, seam);
    b = mix(b, 24, seam);
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
export function buildRacingLine(width = 512, heightPx = 256, seed = 8800) {
  const n = width * heightPx;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(width, heightPx);
  const streakF = fbmField(noise, width, heightPx, 6, 64, 4, 2.2, 0.55);
  const blotchF = fbmField(noise, width, heightPx, 5, 5, 3, 2, 0.5);
  const microF = fbmField(noise, width, heightPx, 140, 140, 2, 2.3, 0.5);
  for (let y = 0; y < heightPx; y++) {
    const v = (y + 0.5) / heightPx;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const streak = streakF[i];
      const blotch = blotchF[i];
      const micro = microF[i];
      const edgeNoise = streak * 0.1 + blotch * 0.08;
      const dist = Math.abs(v - 0.5) * 2;
      let cover = smoothstep(1, 0.28, dist + edgeNoise);
      cover *= clamp01(0.72 + blotch * 0.5 + streak * 0.22);
      const core = clamp01(cover * 1.25);
      const r = mix(36, 14, core) + micro * 5;
      const g = mix(32, 12, core) + micro * 5;
      const b = mix(29, 14, core) + micro * 5;
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = Math.max(0, Math.min(255, cover * 255));
      hf[i] = 0.5 + streak * 0.1 * (1 - core) + micro * 0.03;
      const rough = clamp01(mix(0.8, 0.52, core) + micro * 0.05 + streak * 0.05);
      orm[j] = 255;
      orm[j + 1] = rough * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }
  const normal = normalFromHeight(hf, width, heightPx, 0.7);
  return { width, height: heightPx, color, normal, orm, tileU: 6, tileV: 2.4 };
}
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
      let coverage = clamp01(0.86 + wear * 0.7);
      coverage *= clamp01(smoothstep(0.1, 0.26, chips.f1) + 0.45);
      coverage = clamp01(coverage);
      const tint = 234 + grit * 12 + wear * 8;
      const dirt = clamp01(0.5 - wear) * 0.35;
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, tint - dirt * 60));
      color[j + 1] = Math.max(0, Math.min(255, tint - dirt * 58));
      color[j + 2] = Math.max(0, Math.min(255, tint - dirt * 50));
      color[j + 3] = Math.max(0, Math.min(255, coverage * 255));
      hf[i] = 0.5 + coverage * 0.22 + grit * 0.05;
      orm[j] = 255;
      orm[j + 1] = clamp01(0.44 + grit * 0.1 + (1 - coverage) * 0.35) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }
  const normal = normalFromHeight(hf, size, size, 1.1);
  return { width: size, height: size, color, normal, orm, tileU: 0.6, tileV: 0.6 };
}
const KERB_RED = [180, 31, 44];
const KERB_WHITE = [228, 226, 218];
const KERB_CONCRETE = [156, 153, 145];
export function buildKerb(width = 512, heightPx = 128, style = "entry", seed = 5150) {
  const n = width * heightPx;
  const noise = new Noise(seed + (style === "exit" ? 77 : 0));
  const exit = style === "exit";
  const blocks = exit ? 6 : 8;
  const ribs = exit ? 12 : 16;
  const ribAmp = exit ? 0.1 : 0.26;
  const fade = exit ? 0.34 : 0.12;
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(width, heightPx);
  const rubberF = createField(width, heightPx);
  const chipMaskF = fbmField(noise, width, heightPx, 12, 12, 3, 2, 0.5);
  const gritF = fbmField(noise, width, heightPx, 180, 45, 3, 2.3, 0.5);
  const patchF = fbmField(new Noise(seed + 137), width, heightPx, 22, 5, 4, 2.1, 0.55);
  const paintF = fbmField(noise, width, heightPx, 5, 5, 3, 2, 0.5);
  const scuffF = fbmField(new Noise(seed + 211), width, heightPx, 3, 90, 3, 2.4, 0.5);
  for (let y = 0; y < heightPx; y++) {
    const v = (y + 0.5) / heightPx;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const i = y * width + x;
      const edge = Math.min(smoothstep(0, 0.075, v), smoothstep(1, 0.925, v));
      const crown = Math.sin(v * Math.PI) * 0.028;
      const rp = u * ribs;
      const rf = rp - Math.floor(rp);
      const rib = 0.5 - 0.5 * Math.cos(rf * Math.PI * 2);
      const bp = u * blocks;
      const jointPx = Math.abs(bp - Math.round(bp)) / blocks * width;
      const joint = clamp01(1 - jointPx / 1.6);
      const chip = noise.worley2p(u * 60, v * 15, 60, 15);
      const chipMask = clamp01(smoothstep(0.06, 0.015, chip.f1)) * clamp01(0.35 + chipMaskF[i]);
      const grit = gritF[i];
      hf[i] = 0.34 + edge * 0.32 + crown + rib * ribAmp * edge - chipMask * 0.16 - joint * 0.22 + grit * 0.035;
      const side = smoothstep(0.1, 0.85, v);
      const patch = clamp01(patchF[i] * 1.6 - 0.05);
      rubberF[i] = clamp01(side * patch * (0.3 + rib * 0.95) * (exit ? 1.2 : 0.8));
      const blockIdx = Math.floor(bp);
      const red = (blockIdx & 1) === 0;
      const base = red ? KERB_RED : KERB_WHITE;
      const paintWear = clamp01(fade + paintF[i] * 0.45 + chipMask * 0.9);
      let r = mix(base[0], KERB_CONCRETE[0], paintWear);
      let g = mix(base[1], KERB_CONCRETE[1], paintWear);
      let b = mix(base[2], KERB_CONCRETE[2], paintWear);
      const shade = 1 + grit * 0.1 - chipMask * 0.12 - (1 - edge) * 0.22 - joint * 0.45;
      r *= shade;
      g *= shade;
      b *= shade;
      const scuff = clamp01(scuffF[i] * 1.4 - 0.72) * side;
      r = mix(r, 200, scuff * 0.5);
      g = mix(g, 198, scuff * 0.5);
      b = mix(b, 194, scuff * 0.5);
      const rub = rubberF[i];
      r = mix(r, 26, rub * 0.86);
      g = mix(g, 24, rub * 0.86);
      b = mix(b, 25, rub * 0.86);
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;
      let rough = mix(0.58, 0.9, paintWear);
      rough = mix(rough, 0.36, rub);
      rough += grit * 0.05;
      orm[j] = 255;
      orm[j + 1] = clamp01(rough) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }
  const ao = aoFromHeight(hf, width, heightPx, 3, 1);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, width, heightPx, exit ? 1.8 : 2.5);
  return { width, height: heightPx, color, normal, orm, tileU: 4, tileV: 1 };
}
export function buildGrass(size = 512, seed = 2400) {
  const n = size * size;
  const noise = new Noise(seed);
  const tufts = new WorleyGrid(34, 34, seed + 9, 1);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const stripes = 4;
  const patchF = fbmField(noise, size, size, 3, 3, 4, 2, 0.55);
  const bladeF = fbmField(noise, size, size, 190, 46, 2, 2.35, 0.5);
  const blade2F = fbmField(new Noise(seed + 31), size, size, 380, 92, 1, 2.2, 0.5);
  const DRY = [138, 136, 76];
  const MID = [79, 114, 43];
  const LUSH = [40, 81, 25];
  const EARTH = [93, 76, 51];
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
      const tuft = clamp01(1 - clump.f1 / (0.3 + clump.size * 0.35));
      const blade = bladeF[i];
      const blade2 = blade2F[i];
      hf[i] = 0.45 + tuft * 0.22 + blade * 0.18 + blade2 * 0.09 + patch * 0.1 + lean * 0.035 * (0.5 + blade * 0.5);
      let r, g, b;
      if (dryness > 0.62) {
        const t = (dryness - 0.62) / 0.38;
        r = mix(MID[0], DRY[0], t);
        g = mix(MID[1], DRY[1], t);
        b = mix(MID[2], DRY[2], t);
      } else {
        const t = dryness / 0.62;
        r = mix(LUSH[0], MID[0], t);
        g = mix(LUSH[1], MID[1], t);
        b = mix(LUSH[2], MID[2], t);
      }
      const bare = clamp01((0.12 - tuft) * 4) * clamp01(dryness * 1.6 - 0.85);
      r = mix(r, EARTH[0], bare * 0.6);
      g = mix(g, EARTH[1], bare * 0.6);
      b = mix(b, EARTH[2], bare * 0.6);
      const shade = 1 + blade * 0.24 + blade2 * 0.1 + tuft * 0.1 + lean * 0.035;
      r *= shade;
      g *= shade;
      b *= shade;
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
  return { width: size, height: size, color, normal, orm, tileU: 4, tileV: 4 };
}
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
      hf[i] = 0.5 + fibre * 0.3 + fine * 0.15;
      const shade = 1 + fibre * 0.3 + fine * 0.12 + wear * 0.08;
      const grey = clamp01(0.18 + wear * 0.45);
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, mix(58, 106, grey) * shade));
      color[j + 1] = Math.max(0, Math.min(255, mix(134, 138, grey) * shade));
      color[j + 2] = Math.max(0, Math.min(255, mix(46, 82, grey) * shade));
      color[j + 3] = 255;
      orm[j] = 255;
      orm[j + 1] = clamp01(0.76 + fibre * 0.08 + wear * 0.06) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }
  const ao = aoFromHeight(hf, size, size, 4, 1);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, size, size, 2.2);
  return { width: size, height: size, color, normal, orm, tileU: 1.5, tileV: 1.5 };
}
export function buildGravel(size = 512, seed = 9100) {
  const n = size * size;
  const noise = new Noise(seed);
  const big = new WorleyGrid(46, 46, seed + 3, 1);
  const small = new WorleyGrid(98, 98, seed + 41, 1);
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
      const wx = u + warpX[i] * 0.01;
      const wy = v + warpY[i] * 0.01;
      const a = big.query(wx, wy);
      const ra = 0.34 + a.size * 0.3;
      const da = a.f1 / ra;
      const domeA = da < 1 ? Math.pow(1 - da * da, 0.62) : 0;
      const b = small.query(wx * 1.03 + 0.17, wy * 1.03 + 0.29);
      const rb = 0.3 + b.size * 0.3;
      const db = b.f1 / rb;
      const domeB = db < 1 ? Math.pow(1 - db * db, 0.62) : 0;
      const grit = gritF[i];
      const top = Math.max(domeA * 0.95, domeB * 0.62);
      hf[i] = 0.18 + domeA * 0.62 + domeB * 0.3 + grit * 0.05;
      idF[i] = domeA * 0.95 >= domeB * 0.62 ? a.id : b.id;
      const id = idF[i];
      let r = mix(92, 210, id), g = mix(85, 198, id), bl = mix(74, 174, id);
      if (id > 0.88) {
        r = 122;
        g = 109;
        bl = 90;
      } else if (id < 0.08) {
        r = 63;
        g = 61;
        bl = 60;
      }
      const shade = 0.7 + top * 0.46 + grit * 0.11;
      r *= shade;
      g *= shade;
      bl *= shade;
      const dust = clamp01((0.36 - hf[i]) * 2.4);
      r = mix(r, 125, dust * 0.55);
      g = mix(g, 119, dust * 0.55);
      bl = mix(bl, 107, dust * 0.55);
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
export function buildSand(size = 512, seed = 3900) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const ripples = 25;
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
      hf[i] = 0.42 + ripple * 0.3 * clamp01(0.5 + drift) + drift * 0.16 + grain * 0.04;
      const shade = 0.9 + ripple * 0.16 + grain * 0.09 + drift * 0.08;
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, 210 * shade));
      color[j + 1] = Math.max(0, Math.min(255, 194 * shade));
      color[j + 2] = Math.max(0, Math.min(255, 158 * shade));
      color[j + 3] = 255;
      orm[j + 1] = clamp01(0.9 + grain * 0.06) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }
  const ao = aoFromHeight(hf, size, size, Math.max(3, size >> 6), 1);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, size, size, 2);
  return { width: size, height: size, color, normal, orm, tileU: 3, tileV: 3 };
}
export function buildConcrete(size = 512, seed = 6600, palette = "light") {
  const n = size * size;
  const noise = new Noise(seed);
  const agg = new WorleyGrid(120, 120, seed + 17, 1);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const joints = 2;
  const skinF = fbmField(noise, size, size, 5, 5, 4, 2, 0.55);
  const blotchF = fbmField(new Noise(seed + 91), size, size, 3, 3, 3, 2, 0.6);
  const gritF = fbmField(noise, size, size, 160, 160, 2, 2.3, 0.5);
  const crackF = ridgedField(noise, size, size, 9, 9, 3, 2.1, 0.5, 1);
  const streakF = fbmField(new Noise(seed + 23), size, size, 10, 2, 4, 2.2, 0.5);
  const dark = palette === "dark";
  const baseR = dark ? 110 : 167, baseG = dark ? 108 : 164, baseB = dark ? 104 : 156;
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
      hf[i] = 0.55 + stone * 0.2 + grit * 0.05 - joint * 0.42 - crack * 0.3;
      const streak = clamp01(streakF[i] * 1.3 - 0.45);
      const slab = noise.cellRandom(Math.floor(u * joints), Math.floor(v * joints)) - 0.5;
      const blotch = blotchF[i];
      let r = baseR + stone * 26 + grit * 14 + skin * 12 + slab * 18;
      let g = baseG + stone * 25 + grit * 14 + skin * 12 + slab * 18;
      let b = baseB + stone * 22 + grit * 13 + skin * 11 + slab * 17;
      const stain = streak * 0.3 + joint * 0.45 + crack * 0.55 + clamp01(blotch * 1.4 - 0.35) * 0.3;
      r = mix(r, 78, stain);
      g = mix(g, 76, stain);
      b = mix(b, 72, stain);
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
  const ao = aoFromHeight(hf, size, size, Math.max(2, size >> 7), 1);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, size, size, 1.6);
  return { width: size, height: size, color, normal, orm, tileU: 4, tileV: 4 };
}
export function buildAsphaltVariant(fields, wear, seed) {
  const { color, orm } = asphaltSurface(fields, wear, seed);
  return {
    width: fields.size,
    height: fields.size,
    color,
    orm,
    normal: null,
    tileU: fields.tile,
    tileV: fields.tile
  };
}
