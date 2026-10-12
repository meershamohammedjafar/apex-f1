import * as THREE from "three";
import {
  Noise,
  WorleyGrid,
  createField,
  normalFromHeight,
  aoFromHeight,
  fbmField,
  ridgedField,
  createCanvas,
  canvasToField,
  clamp01,
  mix,
  smoothstep
} from "./NoiseTextures.js";
export function buildCarbonTwill(size = 512, tows = 12, opts = {}) {
  const gloss = opts.gloss ?? 0.5;
  const contrast = opts.contrast ?? 1;
  const baseR = opts.baseR ?? 16, baseG = opts.baseG ?? 17, baseB = opts.baseB ?? 21;
  const seed = opts.seed ?? 5501;
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const fibF = createField(size, size);
  const overF = createField(size, size);
  const warpFibF = fbmField(noise, size, size, tows * 26, Math.max(2, Math.round(tows * 1.4)), 2, 2.3, 0.5);
  const weftFibF = fbmField(new Noise(seed + 91), size, size, Math.max(2, Math.round(tows * 1.4)), tows * 26, 2, 2.3, 0.5);
  for (let y = 0; y < size; y++) {
    const ty = (y + 0.5) / size * tows;
    for (let x = 0; x < size; x++) {
      const tx = (x + 0.5) / size * tows;
      const i = y * size + x;
      const phase = ((tx + ty) % 4 + 4) % 4;
      const over = smoothstep(-0.42, 0.42, Math.cos((phase - 1) * Math.PI * 0.5));
      overF[i] = over;
      const fx = tx - Math.floor(tx);
      const fy = ty - Math.floor(ty);
      const pw = Math.sqrt(Math.max(0, Math.cos((fx - 0.5) * Math.PI)));
      const pf = Math.sqrt(Math.max(0, Math.cos((fy - 0.5) * Math.PI)));
      const warpH = pw * (0.26 + 0.74 * over);
      const weftH = pf * (0.26 + 0.74 * (1 - over));
      const edgeWarp = clamp01((0.34 - pw) / 0.34);
      const edgeWeft = clamp01((0.34 - pf) / 0.34);
      const groove = mix(edgeWeft, edgeWarp, over) * 0.2;
      const crown = Math.max(warpH, weftH) - groove;
      const fib = mix(weftFibF[i], warpFibF[i], over);
      fibF[i] = fib;
      hf[i] = 0.2 + crown * 0.72 + fib * 0.05;
    }
  }
  const ao = aoFromHeight(hf, size, size, Math.max(2, Math.round(size / tows / 3)), 1.2);
  for (let i = 0; i < n; i++) {
    const crown = clamp01((hf[i] - 0.2) / 0.72);
    const fib = fibF[i];
    const lift = 0.58 + crown * 0.72 * contrast + fib * 0.34;
    const j = i * 4;
    color[j] = Math.min(255, baseR * lift + crown * 20 * contrast);
    color[j + 1] = Math.min(255, baseG * lift + crown * 21 * contrast);
    color[j + 2] = Math.min(255, baseB * lift + crown * 25 * contrast);
    color[j + 3] = 255;
    const rough = clamp01(mix(0.55, 0.16, gloss) + (1 - crown) * 0.08 * contrast + fib * 0.05);
    orm[j] = Math.max(0, Math.min(255, ao[i] * 255));
    orm[j + 1] = rough * 255;
    orm[j + 2] = 0;
    orm[j + 3] = 255;
  }
  const normal = normalFromHeight(hf, size, size, opts.normalStrength ?? 2.4);
  const tile = tows * 2e-3;
  return { width: size, height: size, color, normal, orm, tileU: tile, tileV: tile };
}
export function buildPaintFlakeNormal(size = 256, seed = 7311) {
  const noise = new Noise(seed);
  const hf = createField(size, size);
  const flake = new WorleyGrid(Math.max(32, size >> 1), Math.max(32, size >> 1), seed + 5, 1);
  const peelF = fbmField(noise, size, size, 22, 22, 3, 2.1, 0.5);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;
      const peel = peelF[i];
      const f = flake.query(u, v);
      const platelet = clamp01(1 - f.f1 / (0.22 + f.size * 0.18));
      hf[i] = 0.5 + peel * 0.6 + platelet * platelet * (f.id - 0.5) * 0.55;
    }
  }
  const normal = normalFromHeight(hf, size, size, 0.55);
  return { width: size, height: size, normal, tileU: 0.25, tileV: 0.25 };
}
export function buildTyreTread(size = 512, seed = 4120) {
  const n = size * size;
  const noise = new Noise(seed);
  const marbles = new WorleyGrid(56, 22, seed + 11, 1);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const grainF = ridgedField(noise, size, size, 12, 74, 3, 2.2, 0.5, 1);
  const blisterF = fbmField(noise, size, size, 7, 4, 3, 2, 0.55);
  const mouldF = fbmField(new Noise(seed + 57), size, size, 190, 190, 2, 2.4, 0.5);
  const glazeF = fbmField(new Noise(seed + 113), size, size, 5, 3, 3, 2.1, 0.5);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;
      const grain = grainF[i];
      const blister = blisterF[i];
      const mould = mouldF[i];
      const glaze = glazeF[i];
      const vw = v + glaze * 0.035;
      const scrub = smoothstep(0.1, 0.26, vw) * smoothstep(0.9, 0.74, vw);
      const edge = clamp01(1 - scrub);
      const rim = smoothstep(0.16, 0.02, vw) + smoothstep(0.84, 0.98, vw);
      const m = marbles.query(u, v);
      const marble = clamp01(1 - m.f1 / (0.2 + m.size * 0.16)) * clamp01(0.15 + blister * 0.6) * clamp01(0.25 + rim * 1.2);
      const tear = clamp01((grain - 0.52) * 2) * clamp01(0.2 + blister * 0.9) * (0.25 + edge * 1.1);
      hf[i] = 0.52 + tear * 0.26 + marble * 0.24 + mould * 0.05 - scrub * 0.06;
      const hot = clamp01(0.4 + blister * 0.8 + scrub * 0.35);
      let r = mix(36, 51, hot) + mould * 6;
      let g = mix(35, 50, hot) + mould * 6;
      let b = mix(38, 53, hot) + mould * 7;
      r = mix(r, 29, scrub * 0.45);
      g = mix(g, 28, scrub * 0.45);
      b = mix(b, 31, scrub * 0.45);
      r = mix(r, 70, tear * 0.55);
      g = mix(g, 67, tear * 0.55);
      b = mix(b, 65, tear * 0.55);
      r = mix(r, 58, marble * 0.7);
      g = mix(g, 54, marble * 0.7);
      b = mix(b, 51, marble * 0.7);
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;
      const rough = clamp01(mix(0.9, 0.58, scrub * (0.72 + blister * 0.5)) + tear * 0.08 + marble * 0.1 + mould * 0.04);
      orm[j + 1] = rough * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }
  const ao = aoFromHeight(hf, size, size, 5, 1.1);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, size, size, 1.7);
  return { width: size, height: size, color, normal, orm, tileU: 0.32, tileV: 0.38 };
}
const BAND_CENTRE = 0.69;
const BAND_HALF = 0.085;
export const COMPOUND_COLORS = {
  soft: 14745642,
  medium: 16172800,
  hard: 15263974,
  intermediate: 4170283,
  wet: 1401021
};
export function buildTyreSidewall(width = 1024, heightPx = 256, compound = "soft", seed = 6712) {
  const n = width * heightPx;
  const noise = new Noise(seed);
  const canvas = createCanvas(width, heightPx);
  const c = canvas.getContext("2d", { willReadFrequently: true });
  c.fillStyle = "#000";
  c.fillRect(0, 0, width, heightPx);
  c.fillStyle = "#fff";
  c.textAlign = "center";
  c.textBaseline = "middle";
  const repeats = 3;
  for (let k = 0; k < repeats; k++) {
    const cx = (k + 0.5) * (width / repeats);
    c.save();
    c.translate(cx, heightPx * 0.34);
    c.font = `bold ${Math.round(heightPx * 0.2)}px system-ui, "Helvetica Neue", Arial, sans-serif`;
    if ("letterSpacing" in c) c.letterSpacing = `${Math.round(heightPx * 0.03)}px`;
    c.fillText("VELOCE", 0, 0);
    c.font = `600 ${Math.round(heightPx * 0.085)}px system-ui, "Helvetica Neue", Arial, sans-serif`;
    if ("letterSpacing" in c) c.letterSpacing = `${Math.round(heightPx * 0.012)}px`;
    c.fillText("305/670 R18", 0, heightPx * 0.155);
    c.restore();
    c.save();
    c.translate(cx - width / repeats * 0.3, heightPx * 0.3);
    c.font = `600 ${Math.round(heightPx * 0.07)}px system-ui, Arial, sans-serif`;
    c.fillText("F1 SLICK", 0, 0);
    c.restore();
  }
  if ("letterSpacing" in c) c.letterSpacing = "0px";
  const letters = canvasToField(canvas, new Float32Array(n));
  const bandColor = COMPOUND_COLORS[compound] ?? COMPOUND_COLORS.soft;
  const bandR = bandColor >> 16 & 255, bandG = bandColor >> 8 & 255, bandB = bandColor & 255;
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(width, heightPx);
  const rubberF = fbmField(noise, width, heightPx, 260, 90, 2, 2.3, 0.5);
  const scuffF = fbmField(noise, width, heightPx, 40, 8, 3, 2.1, 0.5);
  for (let y = 0; y < heightPx; y++) {
    const v = (y + 0.5) / heightPx;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const i = y * width + x;
      const rubber = rubberF[i];
      const scuff = scuffF[i];
      const ribZone = smoothstep(0.02, 0.1, v) * smoothstep(0.3, 0.2, v);
      const rib = Math.abs(Math.sin(u * Math.PI * 180)) ** 0.6;
      const shoulder = smoothstep(0.86, 1, v);
      const bead = smoothstep(0.06, 0, v);
      const bandD = Math.abs(v - BAND_CENTRE) / BAND_HALF;
      const band = 1 - smoothstep(0.8, 1, bandD);
      const groove = 1 - smoothstep(0.3, 1.16, bandD);
      const lip = clamp01(1 - Math.abs(bandD - 1.24) / 0.2);
      const letter = letters[i];
      hf[i] = 0.44 + ribZone * rib * 0.22 + letter * 0.4 - shoulder * 0.1 - bead * 0.14 - groove * 0.07 + lip * 0.03 + rubber * 0.05 + scuff * 0.03;
      const base = 40 + rubber * 12 + scuff * 7;
      let r = base, g = base, b = base + 3;
      r += letter * 30;
      g += letter * 30;
      b += letter * 31;
      r = mix(r, bandR, band * 0.92);
      g = mix(g, bandG, band * 0.92);
      b = mix(b, bandB, band * 0.92);
      const grime = groove * clamp01(0.25 + scuff * 0.9) * 0.22;
      r = mix(r, 58, grime);
      g = mix(g, 54, grime);
      b = mix(b, 48, grime);
      const dust = clamp01(scuff * 1.3 - 0.35) * (1 - band) * 0.35;
      r = mix(r, 122, dust);
      g = mix(g, 116, dust);
      b = mix(b, 104, dust);
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;
      const rough = clamp01(0.78 - letter * 0.2 - band * 0.22 + rubber * 0.05 + dust * 0.14 + grime * 0.2);
      orm[j + 1] = rough * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }
  const ao = aoFromHeight(hf, width, heightPx, 4, 1.2);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, width, heightPx, 2.9);
  return { width, height: heightPx, color, normal, orm, tileU: 2.26, tileV: 0.125 };
}
export function buildMachinedMetal(size = 512, opts = {}) {
  const roughBase = opts.roughness ?? 0.3;
  const damage = opts.damage ?? 0.5;
  const tint = opts.tint ?? 12172482;
  const seed = opts.seed ?? 8420;
  const anisotropic = opts.anisotropic !== false;
  const n = size * size;
  const noise = new Noise(seed);
  const pits = new WorleyGrid(90, 90, seed + 13, 1);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const tr = tint >> 16 & 255, tg = tint >> 8 & 255, tb = tint & 255;
  const brushF = anisotropic ? fbmField(noise, size, size, 6, 420, 2, 2.3, 0.5) : fbmField(noise, size, size, 180, 180, 2, 2.3, 0.5);
  const scratchF = ridgedField(new Noise(seed + 29), size, size, 5, 130, 2, 2.2, 0.5, 1);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;
      const brush = brushF[i];
      const scratch = clamp01(scratchF[i] - 0.8) * 5;
      const p = pits.query(u, v);
      const pit = clamp01(1 - p.f1 / 0.1) * clamp01(p.id * 1.6 - 0.75) * damage;
      hf[i] = 0.5 + brush * 0.2 + scratch * 0.18 - pit * 0.45;
      const lift = 1 + brush * 0.1 + scratch * 0.14 - pit * 0.3;
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, tr * lift));
      color[j + 1] = Math.max(0, Math.min(255, tg * lift));
      color[j + 2] = Math.max(0, Math.min(255, tb * lift));
      color[j + 3] = 255;
      const rough = clamp01(roughBase + brush * 0.09 + pit * 0.35 * damage - scratch * 0.05);
      orm[j] = 255;
      orm[j + 1] = rough * 255;
      orm[j + 2] = clamp01(1 - pit * 0.8) * 255;
      orm[j + 3] = 255;
    }
  }
  const ao = aoFromHeight(hf, size, size, 4, 0.8);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, size, size, opts.normalStrength ?? 0.9);
  return { width: size, height: size, color, normal, orm, tileU: opts.tile ?? 0.5, tileV: opts.tile ?? 0.5 };
}
export function buildBrakeDisc(size = 512, seed = 2810) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const emissive = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const CIRCUMFERENCE = 0.873;
  const RADIAL_SPAN = 0.139;
  const HOLE_RADIUS = 28e-4;
  const holeCols = 72;
  const holeRows = 6;
  const bandLo = 0.34, bandHi = 0.96;
  const scoreF = fbmField(noise, size, size, 8, 180, 2, 2.3, 0.5);
  const dustF = fbmField(noise, size, size, 14, 14, 3, 2, 0.5);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    const sinV120 = Math.sin(v * Math.PI * 120);
    const band = smoothstep(bandLo - 0.03, bandLo + 0.02, v) * smoothstep(1, bandHi, v);
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;
      let hole = 0;
      for (let r2 = 0; r2 < holeRows; r2++) {
        const rv = bandLo + 0.06 + (r2 + 0.5) * ((bandHi - bandLo - 0.1) / holeRows);
        const stagger = r2 & 1 ? 0.5 : 0;
        const cu = u * holeCols + stagger;
        const du = (cu - Math.round(cu)) / holeCols * CIRCUMFERENCE;
        const dv = (v - rv) * RADIAL_SPAN;
        const d = Math.sqrt(du * du + dv * dv) / HOLE_RADIUS;
        if (d < 1) hole = Math.max(hole, Math.sqrt(1 - d));
      }
      const score = scoreF[i];
      const sw = Math.sin(u * Math.PI * 120) * sinV120;
      const weave = sw * sw;
      const dust = dustF[i];
      hf[i] = 0.55 - hole * 0.85 + score * 0.035 + weave * 0.03 * band - (1 - band) * 0.05;
      const polish = band * clamp01(0.62 + score * 0.5);
      let r = mix(47, 94, polish) + dust * 10;
      let g = mix(46, 91, polish) + dust * 10;
      let b = mix(48, 92, polish) + dust * 10;
      r = mix(r, 10, hole);
      g = mix(g, 10, hole);
      b = mix(b, 11, hole);
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;
      orm[j] = 255;
      orm[j + 1] = clamp01(mix(0.82, 0.46, polish) + hole * 0.3) * 255;
      orm[j + 2] = clamp01(0.1 + polish * 0.2) * 255;
      orm[j + 3] = 255;
      const heat = band * mix(0.55, 1, smoothstep(bandLo, 1, v)) * (1 - hole * 0.85);
      emissive[j] = Math.min(255, heat * 255);
      emissive[j + 1] = Math.min(255, heat * heat * 190);
      emissive[j + 2] = Math.min(255, heat * heat * heat * 90);
      emissive[j + 3] = 255;
    }
  }
  const ao = aoFromHeight(hf, size, size, 4, 1.4);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, size, size, 2.2);
  return { width: size, height: size, color, normal, orm, emissive, tileU: CIRCUMFERENCE, tileV: RADIAL_SPAN };
}
export function buildExhaustMetal(width = 512, heightPx = 256, seed = 9930) {
  const n = width * heightPx;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(width, heightPx);
  const wobbleF = fbmField(noise, width, heightPx, 5, 3, 3, 2.1, 0.5);
  const grindF = fbmField(noise, width, heightPx, 360, 10, 2, 2.3, 0.5);
  const sootF = fbmField(new Noise(seed + 37), width, heightPx, 9, 9, 3, 2, 0.5);
  const STOPS = [
    [0, 42, 37, 34],
    [0.14, 178, 138, 70],
    [0.32, 140, 90, 116],
    [0.48, 84, 76, 146],
    [0.64, 61, 98, 142],
    [0.82, 125, 134, 140],
    [1, 157, 162, 166]
  ];
  for (let y = 0; y < heightPx; y++) {
    const v = (y + 0.5) / heightPx;
    let k = 0;
    while (k < STOPS.length - 2 && v > STOPS[k + 1][0]) k++;
    const a = STOPS[k], b = STOPS[k + 1];
    const t = clamp01((v - a[0]) / (b[0] - a[0] || 1));
    const weld = Math.abs(Math.sin(v * Math.PI * 6)) ** 24;
    const sootBase = smoothstep(0.16, 0, v);
    const sootMix = 0.25 * smoothstep(0.4, 0, v);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const tt = clamp01(t + wobbleF[i] * 0.3);
      const grind = grindF[i];
      const soot = clamp01(sootBase + sootF[i] * sootMix);
      hf[i] = 0.5 + grind * 0.1 + weld * 0.3;
      let r = mix(a[1], b[1], tt) * (1 + grind * 0.1);
      let g = mix(a[2], b[2], tt) * (1 + grind * 0.1);
      let bl = mix(a[3], b[3], tt) * (1 + grind * 0.1);
      r = mix(r, 28, soot * 0.75);
      g = mix(g, 25, soot * 0.75);
      bl = mix(bl, 24, soot * 0.75);
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, bl));
      color[j + 3] = 255;
      orm[j] = 255;
      orm[j + 1] = clamp01(0.32 + grind * 0.1 + soot * 0.45 + weld * 0.15) * 255;
      orm[j + 2] = clamp01(1 - soot * 0.85) * 255;
      orm[j + 3] = 255;
    }
  }
  const ao = aoFromHeight(hf, width, heightPx, 3, 0.8);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, width, heightPx, 1.4);
  return { width, height: heightPx, color, normal, orm, tileU: 0.25, tileV: 0.6 };
}
export function buildNomex(size = 512, opts = {}) {
  const seed = opts.seed ?? 3311;
  const weave = opts.weave ?? 150;
  const stitch = opts.stitch ?? 6;
  const tint = opts.tint ?? 14341839;
  const roughBase = opts.roughness ?? 0.82;
  const tile = opts.tile ?? 0.4;
  const seamRelief = opts.seamRelief ?? 0;
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const tr = tint >> 16 & 255, tg = tint >> 8 & 255, tb = tint & 255;
  const fuzzF = fbmField(noise, size, size, 300, 300, 2, 2.4, 0.5);
  const slackF = fbmField(new Noise(seed + 77), size, size, 7, 7, 3, 2, 0.55);
  const SEAM_WELT = 3e-3;
  const STITCH_OFFSET = 36e-4;
  const STITCH_HALF = 55e-5;
  const STITCH_PITCH = 35e-4;
  const seamsV = Math.max(0, Math.round(stitch));
  const seamsU = seamRelief > 0 ? Math.max(1, Math.round(stitch * 0.6)) : 0;
  const seamDistance = (t, count) => {
    if (count <= 0) return 1e3;
    const st = t * count;
    return Math.abs(st - Math.round(st)) * (tile / count);
  };
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;
      const tx = u * weave, ty = v * weave;
      const phase = ((tx + ty * 0.5) % 3 + 3) % 3;
      const over = smoothstep(-0.4, 0.4, Math.cos((phase - 0.75) * Math.PI * 0.6667));
      const pw = Math.sqrt(Math.abs(Math.cos((tx - Math.floor(tx) - 0.5) * Math.PI)));
      const pf = Math.sqrt(Math.abs(Math.cos((ty - Math.floor(ty) - 0.5) * Math.PI)));
      const cloth = Math.max(pw * (0.4 + 0.6 * over), pf * (0.4 + 0.6 * (1 - over)));
      const fuzz = fuzzF[i];
      const slack = slackF[i];
      const dv = seamDistance(v, seamsV);
      const du = seamDistance(u, seamsU);
      const dashV = Math.abs(u * tile % STITCH_PITCH - STITCH_PITCH * 0.5) < STITCH_PITCH * 0.3 ? 0 : 1;
      const dashU = Math.abs(v * tile % STITCH_PITCH - STITCH_PITCH * 0.5) < STITCH_PITCH * 0.3 ? 0 : 1;
      const weltV = clamp01(1 - dv / SEAM_WELT);
      const weltU = clamp01(1 - du / SEAM_WELT);
      const welt = Math.max(weltV, weltU);
      const threadV = clamp01(1 - Math.abs(dv - STITCH_OFFSET) / STITCH_HALF) * dashV;
      const threadU = clamp01(1 - Math.abs(du - STITCH_OFFSET) / STITCH_HALF) * dashU;
      const thread = Math.max(threadV, threadU);
      hf[i] = 0.45 + cloth * 0.38 + fuzz * 0.08 + slack * 0.05 + welt * 0.26 * (0.35 + seamRelief) + thread * 0.34 * (0.35 + seamRelief);
      const lift = 0.86 + cloth * 0.3 + fuzz * 0.12 + slack * 0.07 - welt * 0.1;
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, tr * lift + thread * 34));
      color[j + 1] = Math.max(0, Math.min(255, tg * lift + thread * 34));
      color[j + 2] = Math.max(0, Math.min(255, tb * lift + thread * 32));
      color[j + 3] = 255;
      orm[j] = 255;
      orm[j + 1] = clamp01(roughBase + fuzz * 0.07 - cloth * 0.06 + welt * 0.03 - thread * 0.34) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }
  const ao = aoFromHeight(hf, size, size, 3, 1);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, size, size, opts.normalStrength ?? 1.8);
  return { width: size, height: size, color, normal, orm, tileU: tile, tileV: tile };
}
export function buildSuede(size = 256, opts = {}) {
  const seed = opts.seed ?? 1177;
  const tint = opts.tint ?? 1710620;
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const tr = tint >> 16 & 255, tg = tint >> 8 & 255, tb = tint & 255;
  const quilt = opts.quilt ?? 0;
  const napF = fbmField(noise, size, size, 260, 260, 2, 2.35, 0.5);
  const clumpF = fbmField(noise, size, size, 40, 40, 3, 2.1, 0.55);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;
      const nap = napF[i];
      const clump = clumpF[i];
      let seam = 0;
      if (quilt > 0) {
        const du = Math.abs(u * quilt - Math.round(u * quilt)) / quilt * size;
        const dv = Math.abs(v * quilt - Math.round(v * quilt)) / quilt * size;
        seam = clamp01(1 - Math.min(du, dv) / 2);
      }
      hf[i] = 0.5 + nap * 0.22 + clump * 0.16 - seam * 0.5;
      const lift = 0.82 + nap * 0.32 + clump * 0.18;
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, tr * lift * (1 - seam * 0.35)));
      color[j + 1] = Math.max(0, Math.min(255, tg * lift * (1 - seam * 0.35)));
      color[j + 2] = Math.max(0, Math.min(255, tb * lift * (1 - seam * 0.35)));
      color[j + 3] = 255;
      orm[j] = 255;
      orm[j + 1] = clamp01((opts.roughness ?? 0.93) + nap * 0.05 - clump * 0.04) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }
  const ao = aoFromHeight(hf, size, size, 3, 1.1);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, size, size, 1.5);
  return { width: size, height: size, color, normal, orm, tileU: opts.tile ?? 0.2, tileV: opts.tile ?? 0.2 };
}
export function buildGloveLeather(size = 128, opts = {}) {
  const seed = opts.seed ?? 8821;
  const tint = opts.tint ?? 2760985;
  const cells = Math.max(4, Math.round(opts.cells ?? 22));
  const n = size * size;
  const noise = new Noise(seed);
  const grid = new WorleyGrid(cells, cells, seed + 13, 0.85);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const tr = tint >> 16 & 255, tg = tint >> 8 & 255, tb = tint & 255;
  const foldF = fbmField(noise, size, size, 6, 6, 3, 2.1, 0.55);
  const poreF = fbmField(new Noise(seed + 41), size, size, 180, 180, 2, 2.4, 0.5);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;
      const w = grid.query(u, v);
      const edge = clamp01((w.f2 - w.f1) * 2.2);
      const crown = smoothstep(0, 0.75, edge) * (0.55 + w.size * 0.45);
      const fold = foldF[i];
      const pore = poreF[i];
      hf[i] = 0.34 + crown * 0.46 + fold * 0.16 + pore * 0.05;
      const lift = 0.72 + crown * 0.44 + fold * 0.22 + pore * 0.1;
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, tr * lift));
      color[j + 1] = Math.max(0, Math.min(255, tg * lift));
      color[j + 2] = Math.max(0, Math.min(255, tb * lift));
      color[j + 3] = 255;
      orm[j] = 255;
      orm[j + 1] = clamp01((opts.roughness ?? 0.48) + (1 - crown) * 0.16 - pore * 0.04) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }
  const ao = aoFromHeight(hf, size, size, 3, 1.15);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, size, size, opts.normalStrength ?? 1.7);
  return {
    width: size,
    height: size,
    color,
    normal,
    orm,
    tileU: opts.tile ?? 0.045,
    tileV: opts.tile ?? 0.045
  };
}
export function buildWheelGrip(size = 256, seed = 5566) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const knurl = 9;
  const grainF = fbmField(noise, size, size, 210, 210, 2, 2.4, 0.5);
  const sheenF = fbmField(noise, size, size, 12, 12, 3, 2, 0.5);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;
      const a = (u + v) * knurl, b = (u - v) * knurl;
      const fa = Math.abs(a - Math.round(a));
      const fb = Math.abs(b - Math.round(b));
      const ridge = clamp01(1 - Math.min(fa, fb) * 3.2);
      const pyramid = clamp01(1 - (fa + fb) * 1.9);
      const grain = grainF[i];
      const sheen = sheenF[i];
      hf[i] = 0.42 + pyramid * 0.4 + ridge * 0.1 + grain * 0.06;
      const lift = 0.78 + pyramid * 0.42 + grain * 0.14 + sheen * 0.08;
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, 28 * lift));
      color[j + 1] = Math.max(0, Math.min(255, 28 * lift));
      color[j + 2] = Math.max(0, Math.min(255, 30 * lift));
      color[j + 3] = 255;
      orm[j] = 255;
      orm[j + 1] = clamp01(0.92 - pyramid * 0.28 + grain * 0.05) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }
  const ao = aoFromHeight(hf, size, size, 3, 1.3);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, size, size, 2.4);
  return { width: size, height: size, color, normal, orm, tileU: 0.03, tileV: 0.03 };
}
export function buildDisplayScreen(width = 512, heightPx = 256) {
  const canvas = createCanvas(width, heightPx);
  const c = canvas.getContext("2d", { willReadFrequently: true });
  drawDefaultDash(c, width, heightPx);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  const gs = 256;
  const hf = createField(gs, gs);
  for (let y = 0; y < gs; y++) {
    for (let x = 0; x < gs; x++) {
      const gx = Math.abs(x / 4 % 1 - 0.5);
      const gy = Math.abs(y / 4 % 1 - 0.5);
      hf[y * gs + x] = 0.5 - Math.max(0, 0.5 - Math.min(gx, gy) * 4) * 0.3;
    }
  }
  const normal = normalFromHeight(hf, gs, gs, 0.5);
  return { canvas, context: c, texture, normal, normalSize: gs, width, height: heightPx };
}
function drawDefaultDash(c, w, h) {
  c.fillStyle = "#05070a";
  c.fillRect(0, 0, w, h);
  const cells = 15;
  const pad = w * 0.04;
  const bw = (w - pad * 2) / cells;
  for (let i = 0; i < cells; i++) {
    const lit = i < 11;
    const col = i < 5 ? "#12d64a" : i < 10 ? "#ff2b1f" : "#3f7bff";
    c.fillStyle = lit ? col : "#101821";
    c.fillRect(pad + i * bw + 2, h * 0.07, bw - 4, h * 0.1);
  }
  c.fillStyle = "#e8f0ff";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.font = `bold ${Math.round(h * 0.42)}px system-ui, Arial, sans-serif`;
  c.fillText("6", w * 0.5, h * 0.46);
  c.font = `600 ${Math.round(h * 0.13)}px system-ui, Arial, sans-serif`;
  c.textAlign = "left";
  c.fillStyle = "#9fb4cc";
  c.fillText("SPD", pad, h * 0.36);
  c.fillStyle = "#ffffff";
  c.font = `bold ${Math.round(h * 0.17)}px system-ui, Arial, sans-serif`;
  c.fillText("287", pad, h * 0.5);
  c.textAlign = "right";
  c.fillStyle = "#9fb4cc";
  c.font = `600 ${Math.round(h * 0.13)}px system-ui, Arial, sans-serif`;
  c.fillText("LAP", w - pad, h * 0.36);
  c.fillStyle = "#ffffff";
  c.font = `bold ${Math.round(h * 0.17)}px system-ui, Arial, sans-serif`;
  c.fillText("12/58", w - pad, h * 0.5);
  c.textAlign = "center";
  c.fillStyle = "#22e07a";
  c.font = `bold ${Math.round(h * 0.15)}px system-ui, Arial, sans-serif`;
  c.fillText("-0.284", w * 0.5, h * 0.8);
  c.fillStyle = "#101821";
  c.fillRect(pad, h * 0.9, w - pad * 2, h * 0.05);
  c.fillStyle = "#22e07a";
  c.fillRect(w * 0.5, h * 0.9, (w * 0.5 - pad) * 0.42, h * 0.05);
}
export function buildLedStrip(width = 512, heightPx = 32) {
  const n = width * heightPx;
  const color = new Uint8Array(n * 4);
  const emissive = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(width, heightPx);
  const cells = 15;
  for (let y = 0; y < heightPx; y++) {
    const v = (y + 0.5) / heightPx;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const i = y * width + x;
      const cu = u * cells;
      const idx = Math.min(cells - 1, Math.floor(cu));
      const fu = cu - idx;
      const dx = Math.abs(fu - 0.5) * 2;
      const dy = Math.abs(v - 0.5) * 2;
      const disc = clamp01(1 - Math.sqrt(dx * dx * 1.3 + dy * dy * 0.7) / 0.82);
      const glow = Math.pow(disc, 0.55);
      let r, g, b;
      if (idx < 5) {
        r = 16;
        g = 221;
        b = 72;
      } else if (idx < 10) {
        r = 255;
        g = 42;
        b = 28;
      } else {
        r = 68;
        g = 122;
        b = 255;
      }
      hf[i] = 0.5 + disc * 0.3;
      const j = i * 4;
      color[j] = Math.min(255, 10 + r * glow * 0.3);
      color[j + 1] = Math.min(255, 11 + g * glow * 0.3);
      color[j + 2] = Math.min(255, 14 + b * glow * 0.3);
      color[j + 3] = 255;
      emissive[j] = Math.min(255, r * glow);
      emissive[j + 1] = Math.min(255, g * glow);
      emissive[j + 2] = Math.min(255, b * glow);
      emissive[j + 3] = 255;
      orm[j] = 255;
      orm[j + 1] = clamp01(0.34 - glow * 0.12) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }
  const normal = normalFromHeight(hf, width, heightPx, 1.2);
  return { width, height: heightPx, color, normal, orm, emissive, cells, tileU: 0.24, tileV: 0.016 };
}
export function buildVisor(size = 256, seed = 4455) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const scratchF = ridgedField(noise, size, size, 3, 90, 3, 2.2, 0.5, 1);
  const smearF = fbmField(noise, size, size, 8, 8, 3, 2.1, 0.5);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;
      const sunStrip = smoothstep(0.78, 0.94, v);
      const insetX = smoothstep(0.05, 0.1, u) * smoothstep(0.95, 0.9, u);
      const insetY = smoothstep(0.1, 0.16, v) * smoothstep(0.86, 0.8, v);
      const inset = insetX * insetY;
      const insetEdge = clamp01((1 - Math.abs(inset * 2 - 1)) * 1.2) * 0.35;
      const scratch = clamp01(scratchF[i] - 0.86) * 6;
      const smear = smearF[i];
      hf[i] = 0.5 + scratch * 0.2 + insetEdge * 0.25 + smear * 0.02;
      const tint = mix(0.86, 0.16, sunStrip);
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, 214 * tint));
      color[j + 1] = Math.max(0, Math.min(255, 220 * tint));
      color[j + 2] = Math.max(0, Math.min(255, 230 * tint));
      color[j + 3] = 255;
      orm[j] = 255;
      orm[j + 1] = clamp01(0.035 + scratch * 0.35 + insetEdge * 0.2 + (1 - inset) * 0.05) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }
  const normal = normalFromHeight(hf, size, size, 0.8);
  return { width: size, height: size, color, normal, orm, tileU: 0.22, tileV: 0.14 };
}
