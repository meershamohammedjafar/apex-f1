import * as THREE from 'three';
import {
  Noise, WorleyGrid, createField, normalFromHeight, aoFromHeight, fbmField, ridgedField,
  createCanvas, canvasToField, clamp01, mix, smoothstep,
} from './NoiseTextures.js';

/**
 * Car-surface textures: composite weave, paint micro-structure, tyres, machined and
 * anodised metals, driver kit and cockpit displays.
 *
 * Dimensions follow current F1 regulations: 18-inch wheels, 305/670-R13-equivalent rear
 * slicks on a 720 mm outer diameter, 2 mm carbon tows in a 2x2 twill, 278 mm carbon-carbon
 * front brake discs with ~1000 radial drillings.
 */

/**
 * 2x2 twill carbon fibre, generated analytically rather than sampled.
 *
 * The interlace is derived from a continuous phase `(tx + ty) mod 4` so the over/under
 * transition can be softened instead of stepping a texel wide — a hard step reads as
 * pixel noise at grazing angles, which is exactly where a cockpit shot puts the camera.
 * Filaments inside each tow run along the tow axis, so the fibre noise is stretched
 * perpendicular to the visible thread and swaps direction with the interlace.
 */
export function buildCarbonTwill(size = 512, tows = 12, opts = {}) {
  const gloss = opts.gloss ?? 0.5;                  // 0 = matte lacquer, 1 = show-car gloss
  // How hard the tow crowns separate from the resin valleys. Under a clearcoat the
  // lacquer's own reflection sits on top of the weave and washes it out, so the panel
  // the driver is looking at needs a wider spread than one seen from ten metres.
  const contrast = opts.contrast ?? 1.0;
  const baseR = opts.baseR ?? 0x10, baseG = opts.baseG ?? 0x11, baseB = opts.baseB ?? 0x15;
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
    const ty = ((y + 0.5) / size) * tows;
    for (let x = 0; x < size; x++) {
      const tx = ((x + 0.5) / size) * tows;
      const i = y * size + x;

      const phase = (((tx + ty) % 4) + 4) % 4;
      const over = smoothstep(-0.42, 0.42, Math.cos((phase - 1) * Math.PI * 0.5));
      overF[i] = over;

      const fx = tx - Math.floor(tx);
      const fy = ty - Math.floor(ty);
      // Tow cross-section: a flattened cosine, because a woven tow is a ribbon, not a rod.
      const pw = Math.sqrt(Math.max(0, Math.cos((fx - 0.5) * Math.PI)));
      const pf = Math.sqrt(Math.max(0, Math.cos((fy - 0.5) * Math.PI)));

      const warpH = pw * (0.26 + 0.74 * over);
      const weftH = pf * (0.26 + 0.74 * (1 - over));
      // Each float spans two tows side by side. Without an explicit groove along the
      // boundary of whichever tow is on top, the pair renders as one flat facet.
      const edgeWarp = clamp01((0.34 - pw) / 0.34);
      const edgeWeft = clamp01((0.34 - pf) / 0.34);
      const groove = mix(edgeWeft, edgeWarp, over) * 0.20;
      const crown = Math.max(warpH, weftH) - groove;

      // Filament striation along each tow axis.
      const fib = mix(weftFibF[i], warpFibF[i], over);
      fibF[i] = fib;

      hf[i] = 0.20 + crown * 0.72 + fib * 0.05;
    }
  }

  const ao = aoFromHeight(hf, size, size, Math.max(2, Math.round(size / tows / 3)), 1.2);

  for (let i = 0; i < n; i++) {
    const crown = clamp01((hf[i] - 0.20) / 0.72);
    const fib = fibF[i];
    // Resin-rich valleys are darker and glossier; tow crowns show the grey of the fibre.
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
  const tile = tows * 0.002;   // 2 mm tows
  return { width: size, height: size, color, normal, orm, tileU: tile, tileV: tile };
}

/**
 * Clearcoat micro-normal for painted bodywork: metallic flake on top of the low
 * amplitude "orange peel" that every sprayed panel has. Without the peel a car body
 * reflects the sky as a perfect mirror and instantly reads as untextured CG.
 */
export function buildPaintFlakeNormal(size = 256, seed = 7311) {
  const noise = new Noise(seed);
  const hf = createField(size, size);
  const flake = new WorleyGrid(Math.max(32, size >> 1), Math.max(32, size >> 1), seed + 5, 1.0);
  const peelF = fbmField(noise, size, size, 22, 22, 3, 2.1, 0.5);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;
      const peel = peelF[i];
      const f = flake.query(u, v);
      // Each flake is a tiny tilted platelet: a sharp, low-amplitude dome.
      const platelet = clamp01(1 - f.f1 / (0.22 + f.size * 0.18));
      hf[i] = 0.5 + peel * 0.6 + platelet * platelet * (f.id - 0.5) * 0.55;
    }
  }

  const normal = normalFromHeight(hf, size, size, 0.55);
  return { width: size, height: size, normal, tileU: 0.25, tileV: 0.25 };
}

/**
 * Slick tyre tread.
 *
 * U runs around the circumference; V runs *across* the tread face, shoulder to shoulder,
 * and does not tile — `Wheels.treadUv` maps the whole band to [0,1] so this texture can
 * author the one thing that makes a slick read as a slick rather than as a black felt
 * donut: the cross-tread wear profile. A raced F1 slick has three distinct zones across
 * its width, and they differ in gloss far more than they differ in colour.
 *
 *   - The scrubbed band, roughly the middle 60 %. This is the contact patch. It has been
 *     planed flat by the track and glazed by its own melt, so it is the smoothest rubber
 *     on the car: roughness ~0.60 against 0.86 at the shoulders. That gloss step is the
 *     single strongest cue that the tyre is a worked surface and not a moulded prop.
 *   - The shoulders, which take the load in a corner and tear rather than glaze. This is
 *     where graining lives: torn ridges pulled circumferentially out of the surface.
 *   - The outer edges, which run cool and pick up marbles — cold pellets of shed rubber
 *     off the racing line that weld themselves to anything off-line.
 */
export function buildTyreTread(size = 512, seed = 4120) {
  const n = size * size;
  const noise = new Noise(seed);
  const marbles = new WorleyGrid(56, 22, seed + 11, 1.0);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);

  // Graining: torn ridges stretched along the rolling direction (U).
  const grainF = ridgedField(noise, size, size, 12, 74, 3, 2.2, 0.5, 1.0);
  const blisterF = fbmField(noise, size, size, 7, 4, 3, 2.0, 0.55);
  const mouldF = fbmField(new Noise(seed + 57), size, size, 190, 190, 2, 2.4, 0.5);
  const glazeF = fbmField(new Noise(seed + 113), size, size, 5, 3, 3, 2.1, 0.5);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    // Zone weights across the tread. The band is deliberately soft-edged and pushed
    // around by low-frequency noise, because a wear pattern with a ruler-straight
    // boundary reads as a painted stripe.
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;

      const grain = grainF[i];
      const blister = blisterF[i];
      const mould = mouldF[i];
      const glaze = glazeF[i];

      const vw = v + glaze * 0.035;
      const scrub = smoothstep(0.10, 0.26, vw) * smoothstep(0.90, 0.74, vw);
      const edge = clamp01(1 - scrub);
      const rim = smoothstep(0.16, 0.02, vw) + smoothstep(0.84, 0.98, vw);

      const m = marbles.query(u, v);
      const marble = clamp01(1 - m.f1 / (0.20 + m.size * 0.16))
        * clamp01(0.15 + blister * 0.6) * clamp01(0.25 + rim * 1.2);

      // Graining only tears where the rubber is being worked and not glazed over.
      const tear = clamp01((grain - 0.52) * 2.0) * clamp01(0.20 + blister * 0.9) * (0.25 + edge * 1.1);

      hf[i] = 0.52 + tear * 0.26 + marble * 0.24 + mould * 0.05 - scrub * 0.06;

      // Hot, worked rubber is greasier and lighter; grained rubber is dull and grey.
      // The absolute values matter: rubber that photographs at sRGB 0x30-0x40 in sun
      // was being authored at 0x13, which is below the point where any shading survives
      // the tonemap. That is what flattened the tyres into felt cut-outs.
      const hot = clamp01(0.40 + blister * 0.8 + scrub * 0.35);
      let r = mix(0x24, 0x33, hot) + mould * 6;
      let g = mix(0x23, 0x32, hot) + mould * 6;
      let b = mix(0x26, 0x35, hot) + mould * 7;
      // Glazed contact band darkens: it is filled and reflects rather than scatters.
      r = mix(r, 0x1d, scrub * 0.45); g = mix(g, 0x1c, scrub * 0.45); b = mix(b, 0x1f, scrub * 0.45);
      r = mix(r, 0x46, tear * 0.55); g = mix(g, 0x43, tear * 0.55); b = mix(b, 0x41, tear * 0.55);
      r = mix(r, 0x3a, marble * 0.7); g = mix(g, 0x36, marble * 0.7); b = mix(b, 0x33, marble * 0.7);

      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;

      // The gloss step across the tread: ~0.66 glazed against 0.90 torn, dipping to 0.58
      // on the blistered patches. A quarter of a point of roughness across 200 mm of
      // tyre width is what a scrubbed slick actually looks like, and it is the cue that
      // separates a worked racing tyre from a moulded black donut.
      const rough = clamp01(mix(0.90, 0.58, scrub * (0.72 + blister * 0.5))
        + tear * 0.08 + marble * 0.10 + mould * 0.04);
      orm[j + 1] = rough * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, size, size, 5, 1.1);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, size, size, 1.7);
  // U tiles seven times round a 2.26 m circumference; V spans the whole tread once.
  return { width: size, height: size, color, normal, orm, tileU: 0.32, tileV: 0.38 };
}

/**
 * The moulded compound channel on the upper flank, in sidewall-V units (v = 0 at the
 * bead, v = 1 at the shoulder, spanning the 116 mm an 18-inch rim leaves between them).
 * Centred at 0.69 and 20 mm wide: the band is the one saturated colour on a wheel and the
 * only thing that survives minification at fifty metres, so it is drawn at the wide end
 * of what a marked slick carries rather than the narrow one.
 */
const BAND_CENTRE = 0.69;
const BAND_HALF = 0.085;

/** Pirelli-style compound identification colours, keyed by dry/wet compound name. */
export const COMPOUND_COLORS = {
  soft: 0xe1002a,
  medium: 0xf6c700,
  hard: 0xe8e8e6,
  intermediate: 0x3fa22b,
  wet: 0x1560bd,
};

/**
 * Tyre sidewall. Laid out as a strip: U runs once around the circumference, V from the
 * bead at v=0 to the tread shoulder at v=1. Lettering is drawn to a canvas and moulded
 * into the height field, so the raised type catches light like real vulcanised rubber
 * rather than being a flat decal.
 */
export function buildTyreSidewall(width = 1024, heightPx = 256, compound = 'soft', seed = 6712) {
  const n = width * heightPx;
  const noise = new Noise(seed);
  const canvas = createCanvas(width, heightPx);
  const c = canvas.getContext('2d', { willReadFrequently: true });
  c.fillStyle = '#000';
  c.fillRect(0, 0, width, heightPx);
  c.fillStyle = '#fff';
  c.textAlign = 'center';
  c.textBaseline = 'middle';

  // Three repeats around the circumference, as moulded tyres carry.
  const repeats = 3;
  for (let k = 0; k < repeats; k++) {
    const cx = (k + 0.5) * (width / repeats);
    c.save();
    c.translate(cx, heightPx * 0.34);
    c.font = `bold ${Math.round(heightPx * 0.20)}px system-ui, "Helvetica Neue", Arial, sans-serif`;
    if ('letterSpacing' in c) c.letterSpacing = `${Math.round(heightPx * 0.03)}px`;
    c.fillText('VELOCE', 0, 0);
    c.font = `600 ${Math.round(heightPx * 0.085)}px system-ui, "Helvetica Neue", Arial, sans-serif`;
    if ('letterSpacing' in c) c.letterSpacing = `${Math.round(heightPx * 0.012)}px`;
    c.fillText('305/670 R18', 0, heightPx * 0.155);
    c.restore();

    c.save();
    c.translate(cx - width / repeats * 0.30, heightPx * 0.30);
    c.font = `600 ${Math.round(heightPx * 0.07)}px system-ui, Arial, sans-serif`;
    c.fillText('F1 SLICK', 0, 0);
    c.restore();
  }
  if ('letterSpacing' in c) c.letterSpacing = '0px';

  const letters = canvasToField(canvas, new Float32Array(n));

  const bandColor = COMPOUND_COLORS[compound] ?? COMPOUND_COLORS.soft;
  const bandR = (bandColor >> 16) & 255, bandG = (bandColor >> 8) & 255, bandB = bandColor & 255;

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

      // Fine radial mould ribs on the lower sidewall; the upper flank is smooth.
      const ribZone = smoothstep(0.02, 0.10, v) * smoothstep(0.30, 0.20, v);
      const rib = Math.abs(Math.sin(u * Math.PI * 180)) ** 0.6;

      // Shoulder rolls over toward the tread.
      const shoulder = smoothstep(0.86, 1.0, v);
      const bead = smoothstep(0.06, 0.0, v);

      // The compound band is not a decal stuck to the flank: it is paint laid into a
      // moulded channel, with the mould's parting lips standing proud on either side of
      // it. Authoring it as a flat colour ramp is what made the yellow ring look painted
      // on top of the tyre. `bandD` is distance from the channel centreline in channel
      // half-widths, so the paint, the recess and the lips can be shaped independently.
      const bandD = Math.abs(v - BAND_CENTRE) / BAND_HALF;
      const band = 1 - smoothstep(0.80, 1.0, bandD);
      const groove = 1 - smoothstep(0.30, 1.16, bandD);
      const lip = clamp01(1 - Math.abs(bandD - 1.24) / 0.20);

      const letter = letters[i];
      hf[i] = 0.44 + ribZone * rib * 0.22 + letter * 0.40 - shoulder * 0.10 - bead * 0.14
        - groove * 0.070 + lip * 0.030 + rubber * 0.05 + scuff * 0.03;

      // Vulcanised rubber photographs around sRGB 0x28-0x34 in daylight. 0x16 is below
      // the floor of the tonemap's shoulder: every shading cue on the flank was being
      // crushed to the same black, which is what left a felt donut with a stripe on it.
      const base = 0x28 + rubber * 12 + scuff * 7;
      let r = base, g = base, b = base + 3;
      // Moulded type is the same rubber but glossier, so it reads brighter, not white.
      r += letter * 30; g += letter * 30; b += letter * 31;
      r = mix(r, bandR, band * 0.92);
      g = mix(g, bandG, band * 0.92);
      b = mix(b, bandB, band * 0.92);
      // Paint sitting in a recess collects the dust the flank throws off, and the mould
      // lips shade it — both of which stop the band reading as a decal.
      const grime = groove * clamp01(0.25 + scuff * 0.9) * 0.22;
      r = mix(r, 0x3a, grime); g = mix(g, 0x36, grime); b = mix(b, 0x30, grime);

      // Dust and marbles thrown up onto the flank.
      const dust = clamp01(scuff * 1.3 - 0.35) * (1 - band) * 0.35;
      r = mix(r, 0x7a, dust); g = mix(g, 0x74, dust); b = mix(b, 0x68, dust);

      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;

      // 0.78 base rather than 0.90: a slick sidewall is not felt, it has a low broad
      // sheen. The moulded type and the paint are both smoother than the raw flank.
      const rough = clamp01(0.78 - letter * 0.20 - band * 0.22 + rubber * 0.05
        + dust * 0.14 + grime * 0.20);
      orm[j + 1] = rough * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, width, heightPx, 4, 1.2);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, width, heightPx, 2.9);
  // tileV is the physical flank height the strip covers. An 18-inch rim inside a 720 mm
  // tyre leaves 116 mm of sidewall, ~125 mm of arc once the section bulge is walked, so
  // the moulded type and the compound band come out at their real size on the flank.
  return { width, height: heightPx, color, normal, orm, tileU: 2.26, tileV: 0.125 };
}

/**
 * Machined metal: circumferential tool marks plus micro-pitting. Serves forged wheel
 * rims, raw aluminium, anodised fasteners and chrome, with the roughness base and the
 * amount of surface damage driving which is which.
 */
export function buildMachinedMetal(size = 512, opts = {}) {
  const roughBase = opts.roughness ?? 0.30;
  const damage = opts.damage ?? 0.5;
  const tint = opts.tint ?? 0xb9bcc2;
  const seed = opts.seed ?? 8420;
  const anisotropic = opts.anisotropic !== false;

  const n = size * size;
  const noise = new Noise(seed);
  const pits = new WorleyGrid(90, 90, seed + 13, 1.0);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const tr = (tint >> 16) & 255, tg = (tint >> 8) & 255, tb = tint & 255;

  const brushF = anisotropic
    ? fbmField(noise, size, size, 6, 420, 2, 2.3, 0.5)
    : fbmField(noise, size, size, 180, 180, 2, 2.3, 0.5);
  const scratchF = ridgedField(new Noise(seed + 29), size, size, 5, 130, 2, 2.2, 0.5, 1.0);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;

      const brush = brushF[i];
      const scratch = clamp01(scratchF[i] - 0.80) * 5;
      const p = pits.query(u, v);
      const pit = clamp01(1 - p.f1 / 0.10) * clamp01(p.id * 1.6 - 0.75) * damage;

      hf[i] = 0.5 + brush * 0.20 + scratch * 0.18 - pit * 0.45;

      const lift = 1 + brush * 0.10 + scratch * 0.14 - pit * 0.30;
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, tr * lift));
      color[j + 1] = Math.max(0, Math.min(255, tg * lift));
      color[j + 2] = Math.max(0, Math.min(255, tb * lift));
      color[j + 3] = 255;

      const rough = clamp01(roughBase + brush * 0.09 + pit * 0.35 * damage - scratch * 0.05);
      orm[j] = 255;
      orm[j + 1] = rough * 255;
      // Oxide and grime in the pits stop being conductive: metalness drops there.
      orm[j + 2] = clamp01(1 - pit * 0.8) * 255;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, size, size, 4, 0.8);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, size, size, opts.normalStrength ?? 0.9);
  return { width: size, height: size, color, normal, orm, tileU: opts.tile ?? 0.5, tileV: opts.tile ?? 0.5 };
}

/**
 * Carbon-carbon brake disc, laid out with U around the disc and V from hub to rim.
 * A 278 mm front disc carries roughly a thousand radial cooling drillings in several
 * rows; those holes, the scored friction band and the exposed weave are what make a
 * glowing disc read as carbon rather than cast iron.
 */
export function buildBrakeDisc(size = 512, seed = 2810) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const emissive = new Uint8Array(n * 4);
  const hf = createField(size, size);

  // A 278 mm carbon front disc: 873 mm of circumference across U, the 139 mm from hub
  // face to rim across V, and roughly 400 3.6 mm cooling drillings in four rows.
  const CIRCUMFERENCE = 0.873;
  const RADIAL_SPAN = 0.139;
  const HOLE_RADIUS = 0.0028;
  const holeCols = 72;
  const holeRows = 6;
  const bandLo = 0.34, bandHi = 0.96;

  // Circumferential scoring from a thousand stops.
  const scoreF = fbmField(noise, size, size, 8, 180, 2, 2.3, 0.5);
  const dustF = fbmField(noise, size, size, 14, 14, 3, 2.0, 0.5);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    const sinV120 = Math.sin(v * Math.PI * 120);
    const band = smoothstep(bandLo - 0.03, bandLo + 0.02, v) * smoothstep(1.0, bandHi, v);
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;

      // Radial drillings, staggered row to row.
      let hole = 0;
      for (let r = 0; r < holeRows; r++) {
        const rv = bandLo + 0.06 + (r + 0.5) * ((bandHi - bandLo - 0.10) / holeRows);
        const stagger = (r & 1) ? 0.5 : 0;
        const cu = (u * holeCols + stagger);
        const du = ((cu - Math.round(cu)) / holeCols) * CIRCUMFERENCE;
        const dv = (v - rv) * RADIAL_SPAN;
        const d = Math.sqrt(du * du + dv * dv) / HOLE_RADIUS;
        if (d < 1) hole = Math.max(hole, Math.sqrt(1 - d));
      }

      const score = scoreF[i];
      const sw = Math.sin(u * Math.PI * 120) * sinV120;
      const weave = sw * sw;
      const dust = dustF[i];

      hf[i] = 0.55 - hole * 0.85 + score * 0.035 + weave * 0.03 * band - (1 - band) * 0.05;

      // Friction band is polished graphite; the hat is duller and dust-covered.
      const polish = band * clamp01(0.62 + score * 0.5);
      let r = mix(0x2f, 0x5e, polish) + dust * 10;
      let g = mix(0x2e, 0x5b, polish) + dust * 10;
      let b = mix(0x30, 0x5c, polish) + dust * 10;
      r = mix(r, 0x0a, hole); g = mix(g, 0x0a, hole); b = mix(b, 0x0b, hole);

      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;

      orm[j] = 255;
      orm[j + 1] = clamp01(mix(0.82, 0.46, polish) + hole * 0.3) * 255;
      orm[j + 2] = clamp01(0.10 + polish * 0.20) * 255;
      orm[j + 3] = 255;

      // Heat lives in the friction band and runs hottest at the outer radius; the
      // drillings stay cooler because that is where the cooling air actually flows.
      const heat = band * mix(0.55, 1.0, smoothstep(bandLo, 1.0, v)) * (1 - hole * 0.85);
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

/**
 * Inconel exhaust. V runs along the pipe from the tailpipe at v=0: the heat tint runs
 * straw, then violet, then blue, then back to raw metal as the temperature falls with
 * distance from the turbine.
 */
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
    [0.00, 0x2a, 0x25, 0x22],   // sooted tip
    [0.14, 0xb2, 0x8a, 0x46],   // straw
    [0.32, 0x8c, 0x5a, 0x74],   // rose
    [0.48, 0x54, 0x4c, 0x92],   // violet
    [0.64, 0x3d, 0x62, 0x8e],   // blue
    [0.82, 0x7d, 0x86, 0x8c],   // heat-greyed
    [1.00, 0x9d, 0xa2, 0xa6],   // raw inconel
  ];

  for (let y = 0; y < heightPx; y++) {
    const v = (y + 0.5) / heightPx;
    let k = 0;
    while (k < STOPS.length - 2 && v > STOPS[k + 1][0]) k++;
    const a = STOPS[k], b = STOPS[k + 1];
    const t = clamp01((v - a[0]) / (b[0] - a[0] || 1));
    // Weld beads are a function of position along the pipe only.
    const weld = Math.abs(Math.sin(v * Math.PI * 6)) ** 24;
    const sootBase = smoothstep(0.16, 0.0, v);
    const sootMix = 0.25 * smoothstep(0.4, 0.0, v);

    for (let x = 0; x < width; x++) {
      const i = y * width + x;

      // Bands wobble because the pipe never heats perfectly evenly.
      const tt = clamp01(t + wobbleF[i] * 0.30);
      const grind = grindF[i];
      const soot = clamp01(sootBase + sootF[i] * sootMix);

      hf[i] = 0.5 + grind * 0.10 + weld * 0.30;

      let r = mix(a[1], b[1], tt) * (1 + grind * 0.10);
      let g = mix(a[2], b[2], tt) * (1 + grind * 0.10);
      let bl = mix(a[3], b[3], tt) * (1 + grind * 0.10);
      r = mix(r, 0x1c, soot * 0.75);
      g = mix(g, 0x19, soot * 0.75);
      bl = mix(bl, 0x18, soot * 0.75);

      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, bl));
      color[j + 3] = 255;

      orm[j] = 255;
      orm[j + 1] = clamp01(0.32 + grind * 0.10 + soot * 0.45 + weld * 0.15) * 255;
      orm[j + 2] = clamp01(1 - soot * 0.85) * 255;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, width, heightPx, 3, 0.8);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, width, heightPx, 1.4);
  return { width, height: heightPx, color, normal, orm, tileU: 0.25, tileV: 0.6 };
}

/**
 * Nomex race kit: a fine 2/1 twill under quilted stitching. `stitch` sets the seam
 * pitch in tile fractions; 0 disables it for gloves and trim.
 */
export function buildNomex(size = 512, opts = {}) {
  const seed = opts.seed ?? 3311;
  const weave = opts.weave ?? 150;
  const stitch = opts.stitch ?? 6;
  const tint = opts.tint ?? 0xdad6cf;
  const roughBase = opts.roughness ?? 0.82;
  const tile = opts.tile ?? 0.4;
  const seamRelief = opts.seamRelief ?? 0.0;
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const tr = (tint >> 16) & 255, tg = (tint >> 8) & 255, tb = tint & 255;
  const fuzzF = fbmField(noise, size, size, 300, 300, 2, 2.4, 0.5);
  const slackF = fbmField(new Noise(seed + 77), size, size, 7, 7, 3, 2.0, 0.55);

  // Seam layout in real units. A race suit is panelled: flat-felled seams run down the
  // outside of each sleeve and around the shoulder, and every one of them is a 6 mm
  // welt of doubled cloth carrying two rows of topstitch. Those seams, not the weave,
  // are what tells the eye that an arm is dressed in cloth — a limb with a perfect
  // uninterrupted surface is a moulded tube, which is exactly how these read.
  const SEAM_WELT = 0.0030;      // metres, half-width of the raised welt
  const STITCH_OFFSET = 0.0036;  // metres from the seam centreline to each topstitch row
  const STITCH_HALF = 0.00055;   // metres, half-width of the thread itself
  const STITCH_PITCH = 0.0035;   // metres between stitch punctures
  const seamsV = Math.max(0, Math.round(stitch));
  const seamsU = seamRelief > 0 ? Math.max(1, Math.round(stitch * 0.6)) : 0;

  /** Signed distance in metres to the nearest line of a family with `count` per tile. */
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
      const phase = (((tx + ty * 0.5) % 3) + 3) % 3;
      const over = smoothstep(-0.4, 0.4, Math.cos((phase - 0.75) * Math.PI * 0.6667));
      const pw = Math.sqrt(Math.abs(Math.cos((tx - Math.floor(tx) - 0.5) * Math.PI)));
      const pf = Math.sqrt(Math.abs(Math.cos((ty - Math.floor(ty) - 0.5) * Math.PI)));
      const cloth = Math.max(pw * (0.4 + 0.6 * over), pf * (0.4 + 0.6 * (1 - over)));

      const fuzz = fuzzF[i];
      const slack = slackF[i];

      // Two seam families, one across and one along, resolved independently so each
      // can carry its own topstitch dash running the right way along its own seam.
      const dv = seamDistance(v, seamsV);
      const du = seamDistance(u, seamsU);
      const dashV = Math.abs((u * tile) % STITCH_PITCH - STITCH_PITCH * 0.5) < STITCH_PITCH * 0.30 ? 0 : 1;
      const dashU = Math.abs((v * tile) % STITCH_PITCH - STITCH_PITCH * 0.5) < STITCH_PITCH * 0.30 ? 0 : 1;
      const weltV = clamp01(1 - dv / SEAM_WELT);
      const weltU = clamp01(1 - du / SEAM_WELT);
      const welt = Math.max(weltV, weltU);
      const threadV = clamp01(1 - Math.abs(dv - STITCH_OFFSET) / STITCH_HALF) * dashV;
      const threadU = clamp01(1 - Math.abs(du - STITCH_OFFSET) / STITCH_HALF) * dashU;
      const thread = Math.max(threadV, threadU);

      hf[i] = 0.45 + cloth * 0.38 + fuzz * 0.08 + slack * 0.05
        + welt * 0.26 * (0.35 + seamRelief) + thread * 0.34 * (0.35 + seamRelief);

      // Doubled cloth at a welt sits in its own shadow; the polyester topstitch is a
      // different fibre from the aramid around it, so it is lighter and much glossier.
      const lift = 0.86 + cloth * 0.30 + fuzz * 0.12 + slack * 0.07 - welt * 0.10;
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, tr * lift + thread * 34));
      color[j + 1] = Math.max(0, Math.min(255, tg * lift + thread * 34));
      color[j + 2] = Math.max(0, Math.min(255, tb * lift + thread * 32));
      color[j + 3] = 255;

      orm[j] = 255;
      orm[j + 1] = clamp01(roughBase + fuzz * 0.07 - cloth * 0.06 + welt * 0.03
        - thread * 0.34) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, size, size, 3, 1.0);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, size, size, opts.normalStrength ?? 1.8);
  return { width: size, height: size, color, normal, orm, tileU: tile, tileV: tile };
}

/**
 * Suede / alcantara for seat and cockpit padding, and the palm of a glove: no weave,
 * just a dense microfibre nap whose direction scatters light unevenly.
 */
export function buildSuede(size = 256, opts = {}) {
  const seed = opts.seed ?? 1177;
  const tint = opts.tint ?? 0x1a1a1c;
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const tr = (tint >> 16) & 255, tg = (tint >> 8) & 255, tb = tint & 255;
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
        seam = clamp01(1 - Math.min(du, dv) / 2.0);
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

/**
 * Pebbled goatskin for the palm of a driver's glove.
 *
 * A race glove is two materials, not one. The back of the hand is an aramid knit; the
 * palm and the inside of the fingers are a thin suede-backed leather, because that is
 * the only part of the glove that ever touches the rim. The pair have to answer light
 * differently or the whole hand reads as one moulded lump: leather is roughly a third
 * smoother than the knit, so the palm carries a soft broad highlight where the back
 * stays dead matte, and the silhouette of the hand gets an edge of that highlight all
 * the way round.
 *
 * The grain is a Worley cell field — one pebble per cell, crowned in the middle and
 * creased along the cell boundary — laid over a low-frequency fold field so the pebbles
 * stretch into the creases the way hide does rather than tiling as a regular dimple
 * pattern. A 45 mm tile at 22 cells puts each pebble at about 2 mm, which is the real
 * grain of a glove leather and still resolves at the range a cockpit camera sits at.
 */
export function buildGloveLeather(size = 128, opts = {}) {
  const seed = opts.seed ?? 8821;
  const tint = opts.tint ?? 0x2a2119;
  const cells = Math.max(4, Math.round(opts.cells ?? 22));
  const n = size * size;
  const noise = new Noise(seed);
  const grid = new WorleyGrid(cells, cells, seed + 13, 0.85);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const tr = (tint >> 16) & 255, tg = (tint >> 8) & 255, tb = tint & 255;
  const foldF = fbmField(noise, size, size, 6, 6, 3, 2.1, 0.55);
  const poreF = fbmField(new Noise(seed + 41), size, size, 180, 180, 2, 2.4, 0.5);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;

      const w = grid.query(u, v);
      // f2 - f1 is zero on the cell boundary and largest at the cell centre, so it is
      // the pebble's own height field without a second distance query.
      const edge = clamp01((w.f2 - w.f1) * 2.2);
      const crown = smoothstep(0.0, 0.75, edge) * (0.55 + w.size * 0.45);
      const fold = foldF[i];
      const pore = poreF[i];

      hf[i] = 0.34 + crown * 0.46 + fold * 0.16 + pore * 0.05;

      const lift = 0.72 + crown * 0.44 + fold * 0.22 + pore * 0.10;
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, tr * lift));
      color[j + 1] = Math.max(0, Math.min(255, tg * lift));
      color[j + 2] = Math.max(0, Math.min(255, tb * lift));
      color[j + 3] = 255;

      orm[j] = 255;
      // Crowns are burnished by the rim; the creases hold the dye and stay matte.
      orm[j + 1] = clamp01((opts.roughness ?? 0.48) + (1 - crown) * 0.16 - pore * 0.04) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, size, size, 3, 1.15);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, size, size, opts.normalStrength ?? 1.7);
  return {
    width: size, height: size, color, normal, orm,
    tileU: opts.tile ?? 0.045, tileV: opts.tile ?? 0.045,
  };
}

/**
 * Moulded rubber steering-wheel grip: a diamond knurl over a fine rubber grain, at the
 * scale a driver's hands actually see it (a 30 mm tile).
 */
export function buildWheelGrip(size = 256, seed = 5566) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const knurl = 9;
  const grainF = fbmField(noise, size, size, 210, 210, 2, 2.4, 0.5);
  const sheenF = fbmField(noise, size, size, 12, 12, 3, 2.0, 0.5);

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

      hf[i] = 0.42 + pyramid * 0.40 + ridge * 0.10 + grain * 0.06;

      const lift = 0.78 + pyramid * 0.42 + grain * 0.14 + sheen * 0.08;
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, 0x1c * lift));
      color[j + 1] = Math.max(0, Math.min(255, 0x1c * lift));
      color[j + 2] = Math.max(0, Math.min(255, 0x1e * lift));
      color[j + 3] = 255;

      orm[j] = 255;
      // Crowns are polished by the driver's palms; the valleys stay dead matte.
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

/**
 * Steering-wheel dash panel. Returned as a live canvas plus a CanvasTexture so the
 * cockpit can repaint telemetry every frame and just flag `needsUpdate`; the default
 * paint is a complete, readable dash so the material is correct even if nobody drives it.
 */
export function buildDisplayScreen(width = 512, heightPx = 256) {
  const canvas = createCanvas(width, heightPx);
  const c = canvas.getContext('2d', { willReadFrequently: true });
  drawDefaultDash(c, width, heightPx);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  // A sub-pixel grid so the panel reads as an emissive TFT rather than a lit decal.
  const gs = 256;
  const hf = createField(gs, gs);
  for (let y = 0; y < gs; y++) {
    for (let x = 0; x < gs; x++) {
      const gx = Math.abs(((x / 4) % 1) - 0.5);
      const gy = Math.abs(((y / 4) % 1) - 0.5);
      hf[y * gs + x] = 0.5 - Math.max(0, 0.5 - Math.min(gx, gy) * 4) * 0.3;
    }
  }
  const normal = normalFromHeight(hf, gs, gs, 0.5);

  return { canvas, context: c, texture, normal, normalSize: gs, width, height: heightPx };
}

function drawDefaultDash(c, w, h) {
  c.fillStyle = '#05070a';
  c.fillRect(0, 0, w, h);

  // Rev bar across the top: 5 green, 5 red, 5 blue, matching the FIA wheel convention.
  const cells = 15;
  const pad = w * 0.04;
  const bw = (w - pad * 2) / cells;
  for (let i = 0; i < cells; i++) {
    const lit = i < 11;
    const col = i < 5 ? '#12d64a' : i < 10 ? '#ff2b1f' : '#3f7bff';
    c.fillStyle = lit ? col : '#101821';
    c.fillRect(pad + i * bw + 2, h * 0.07, bw - 4, h * 0.10);
  }

  c.fillStyle = '#e8f0ff';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = `bold ${Math.round(h * 0.42)}px system-ui, Arial, sans-serif`;
  c.fillText('6', w * 0.5, h * 0.46);

  c.font = `600 ${Math.round(h * 0.13)}px system-ui, Arial, sans-serif`;
  c.textAlign = 'left';
  c.fillStyle = '#9fb4cc';
  c.fillText('SPD', pad, h * 0.36);
  c.fillStyle = '#ffffff';
  c.font = `bold ${Math.round(h * 0.17)}px system-ui, Arial, sans-serif`;
  c.fillText('287', pad, h * 0.50);

  c.textAlign = 'right';
  c.fillStyle = '#9fb4cc';
  c.font = `600 ${Math.round(h * 0.13)}px system-ui, Arial, sans-serif`;
  c.fillText('LAP', w - pad, h * 0.36);
  c.fillStyle = '#ffffff';
  c.font = `bold ${Math.round(h * 0.17)}px system-ui, Arial, sans-serif`;
  c.fillText('12/58', w - pad, h * 0.50);

  c.textAlign = 'center';
  c.fillStyle = '#22e07a';
  c.font = `bold ${Math.round(h * 0.15)}px system-ui, Arial, sans-serif`;
  c.fillText('-0.284', w * 0.5, h * 0.80);

  c.fillStyle = '#101821';
  c.fillRect(pad, h * 0.90, w - pad * 2, h * 0.05);
  c.fillStyle = '#22e07a';
  c.fillRect(w * 0.5, h * 0.90, (w * 0.5 - pad) * 0.42, h * 0.05);
}

/**
 * Rev-light strip: 15 discrete LEDs behind a diffuser, emitting green / red / blue.
 * Returned as colour plus a matching emissive map so the strip blooms correctly.
 */
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
      if (idx < 5) { r = 0x10; g = 0xdd; b = 0x48; }
      else if (idx < 10) { r = 0xff; g = 0x2a; b = 0x1c; }
      else { r = 0x44; g = 0x7a; b = 0xff; }

      hf[i] = 0.5 + disc * 0.30;

      const j = i * 4;
      color[j] = Math.min(255, 0x0a + r * glow * 0.30);
      color[j + 1] = Math.min(255, 0x0b + g * glow * 0.30);
      color[j + 2] = Math.min(255, 0x0e + b * glow * 0.30);
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

/**
 * Helmet visor. Smoke-tinted polycarbonate with a darker sun strip along the top edge,
 * an anti-fog insert whose edge is faintly visible, and the light surface scratching
 * that any visor picks up. V = 1 is the top of the aperture.
 */
export function buildVisor(size = 256, seed = 4455) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const scratchF = ridgedField(noise, size, size, 3, 90, 3, 2.2, 0.5, 1.0);
  const smearF = fbmField(noise, size, size, 8, 8, 3, 2.1, 0.5);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;

      const sunStrip = smoothstep(0.78, 0.94, v);
      // The anti-fog insert is a slightly inset panel with a visible perimeter.
      const insetX = smoothstep(0.05, 0.10, u) * smoothstep(0.95, 0.90, u);
      const insetY = smoothstep(0.10, 0.16, v) * smoothstep(0.86, 0.80, v);
      const inset = insetX * insetY;
      const insetEdge = clamp01((1 - Math.abs(inset * 2 - 1)) * 1.2) * 0.35;

      const scratch = clamp01(scratchF[i] - 0.86) * 6;
      const smear = smearF[i];

      hf[i] = 0.5 + scratch * 0.20 + insetEdge * 0.25 + smear * 0.02;

      // Light smoke tint, deepening into an almost opaque sun strip.
      const tint = mix(0.86, 0.16, sunStrip);
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, 0xd6 * tint));
      color[j + 1] = Math.max(0, Math.min(255, 0xdc * tint));
      color[j + 2] = Math.max(0, Math.min(255, 0xe6 * tint));
      color[j + 3] = 255;

      orm[j] = 255;
      // Optically flat except where it is scratched or the insert steps.
      orm[j + 1] = clamp01(0.035 + scratch * 0.35 + insetEdge * 0.20 + (1 - inset) * 0.05) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }

  const normal = normalFromHeight(hf, size, size, 0.8);
  return { width: size, height: size, color, normal, orm, tileU: 0.22, tileV: 0.14 };
}
