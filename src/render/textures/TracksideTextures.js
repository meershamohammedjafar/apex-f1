import {
  Noise, WorleyGrid, createField, normalFromHeight, aoFromHeight, fbmField, ridgedField,
  createCanvas, readCanvas, mipChain, clamp01, mix, smoothstep,
} from './NoiseTextures.js';
import { Rng } from '../../core/Rng.js';

/**
 * Everything outside the white lines: barriers, fencing, structures, signage, planting
 * and the crowd.
 *
 * Scale references are real: 3 m Armco W-beam sections on 2 m posts, 50 mm chain-link
 * aperture in debris fencing, 8:1 advertising hoardings, 0.75 m grandstand seat pitch.
 * Sponsor wordmarks are invented outright — no real trademark appears anywhere in APEX.
 */

/**
 * Muted spectator palette. A real crowd is mostly denim, grey, khaki and off-white with
 * a scatter of team colour through it. Saturated primaries everywhere are exactly what
 * turns a grandstand into coloured static the moment it is more than fifty metres away,
 * so the accents are rationed and everything else sits well inside the gamut.
 */
const CROWD_SHIRTS = [
  '#8a4a40', '#a9714c', '#c0a068', '#d3cabc', '#8e99a6', '#4f6377',
  '#37424e', '#5f6f5b', '#7b7e85', '#96876e', '#6a5a70', '#b4ada0',
  '#414852', '#77424a', '#57696c', '#c2b8a4', '#2f3a44', '#9aa2a8',
];
/** Team colours: one shirt in seven, plus most of the caps. */
const CROWD_ACCENTS = ['#b03a2e', '#cf7a2a', '#2f5f9e', '#c9a227', '#3f7d54'];
const CROWD_SKIN = ['#e6bd97', '#d3a276', '#b07d52', '#8b5c37', '#6a4325', '#f0d3b4'];
const CROWD_HAIR = ['#221a13', '#3a2a1c', '#6a4c2c', '#12100f', '#8b7a5e', '#585552'];

/**
 * One atlas cell is a strip of three grandstand seats on a 0.70 m pitch, and 1.55 m of
 * card height measured from just under the tread to a hand's width over the tallest
 * head. `Trackside` builds its billboards at exactly these dimensions, so a spectator
 * comes out life-sized and the crowd's spatial frequency stays low enough to survive
 * mipping instead of boiling.
 */
export const CROWD_CELL_W = 2.10;
export const CROWD_CELL_H = 1.55;
const CROWD_SEAT_PITCH = 0.70;
const CROWD_SEAT_BACK = 0.60;      // top of the seat backs belonging to the row in front

/**
 * Spectator atlas for instanced billboards. Each cell is one seat strip, drawn with a
 * hard dark base — the seat backs of the row in front — and a dark silhouette behind
 * every figure, because the thing that makes a distant crowd read as people rather than
 * noise is the gap between them, not the detail on them.
 */
export function buildCrowdAtlas(size = 1024, cols = 4, rows = 4, seed = 90210) {
  const canvas = createCanvas(size, size);
  const c = canvas.getContext('2d', { willReadFrequently: true });
  c.clearRect(0, 0, size, size);

  const rng = new Rng(seed);
  const cw = size / cols;
  const ch = size / rows;
  const cells = cols * rows;

  for (let k = 0; k < cells; k++) {
    const x0 = (k % cols) * cw;
    const y0 = Math.floor(k / cols) * ch;
    c.save();
    c.beginPath();
    c.rect(x0, y0, cw, ch);
    c.clip();
    // Occupancy lives in the atlas rather than per instance: one bare cell and three
    // thin ones give the stand its empty seats for the cost of an index lookup.
    const occupancy = k === cells - 1 ? 0
      : (k === 5 || k === cells - 2) ? 1
        : (k % 7 === 3) ? 2 : 3;
    drawCrowdCell(c, x0, y0, cw, ch, occupancy, rng);
    c.restore();
  }

  const { data, width, height } = readCanvas(canvas);
  return {
    width, height, color: data, cols, rows,
    tileU: CROWD_CELL_W, tileV: CROWD_CELL_H,
  };
}

/** Scale a hex colour toward or away from black and return a CSS rgb() string. */
function shadeHex(hex, k) {
  const v = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((v >> 16) & 255) * k)));
  const g = Math.max(0, Math.min(255, Math.round(((v >> 8) & 255) * k)));
  const b = Math.max(0, Math.min(255, Math.round((v & 255) * k)));
  return `rgb(${r},${g},${b})`;
}

function drawCrowdCell(c, x0, y0, cw, ch, occupancy, rng) {
  const px = cw / CROWD_CELL_W;
  const py = ch / CROWD_CELL_H;
  const X = (m) => x0 + m * px;
  const Y = (m) => y0 + ch - m * py;

  // The seat backs of the row in front: opaque, dark and the full width of the cell.
  // This band is what gives every tier a hard base line, so the rake stays legible as
  // rows instead of collapsing into one speckled mass.
  const deckTop = Y(CROWD_SEAT_BACK);
  const deckH = Y(0) - deckTop;
  const bench = c.createLinearGradient(0, deckTop, 0, Y(0));
  bench.addColorStop(0, '#242a32');
  bench.addColorStop(0.35, '#171b21');
  bench.addColorStop(1, '#0c0f13');
  c.fillStyle = bench;
  c.fillRect(x0, deckTop, cw, deckH);

  c.fillStyle = 'rgba(74,82,94,0.55)';
  for (let s = 0; s <= 3; s++) {
    c.fillRect(X(s * CROWD_SEAT_PITCH) - px * 0.012, deckTop, Math.max(1, px * 0.024), deckH * 0.72);
  }
  c.fillStyle = 'rgba(104,112,124,0.45)';
  c.fillRect(x0, deckTop, cw, Math.max(1, py * 0.022));

  // The middle seat fills first, so a thin cell still reads as a seated group.
  const order = [1, 0, 2];
  const taken = [false, false, false];
  for (let i = 0; i < occupancy; i++) taken[order[i]] = true;

  for (let s = 0; s < 3; s++) {
    const m = CROWD_SEAT_PITCH * (s + 0.5);
    if (taken[s]) drawSpectator(c, X, Y, px, py, m, rng);
    else drawEmptySeat(c, X, Y, px, py, m);
  }

  // The tier below is always in the shadow of the people above it.
  const ao = c.createLinearGradient(0, Y(1.25), 0, Y(0.2));
  ao.addColorStop(0, 'rgba(0,0,0,0)');
  ao.addColorStop(1, 'rgba(0,0,0,0.34)');
  c.globalCompositeOperation = 'source-atop';
  c.fillStyle = ao;
  c.fillRect(x0, y0, cw, ch);
  c.globalCompositeOperation = 'source-over';
}

function drawEmptySeat(c, X, Y, px, py, m) {
  const half = CROWD_SEAT_PITCH * 0.38;
  c.fillStyle = '#2a303a';
  c.fillRect(X(m - half), Y(0.70), half * 2 * px, Y(0.46) - Y(0.70));
  c.fillStyle = '#39414c';
  c.fillRect(X(m - half), Y(0.70), half * 2 * px, Math.max(1, py * 0.03));
}

/** A tapered seated torso, narrow at the waist and square across the shoulders. */
function torsoPath(c, X, Y, m, width, yLow, yHigh) {
  const hw = width * 0.5;
  c.beginPath();
  c.moveTo(X(m - hw * 0.90), Y(yLow));
  c.lineTo(X(m - hw), Y(yHigh - 0.10));
  c.quadraticCurveTo(X(m - hw), Y(yHigh), X(m - hw * 0.50), Y(yHigh));
  c.lineTo(X(m + hw * 0.50), Y(yHigh));
  c.quadraticCurveTo(X(m + hw), Y(yHigh), X(m + hw), Y(yHigh - 0.10));
  c.lineTo(X(m + hw * 0.90), Y(yLow));
  c.closePath();
}

function drawSpectator(c, X, Y, px, py, m, rng) {
  const accent = rng.next() < 0.14;
  const pool = accent ? CROWD_ACCENTS : CROWD_SHIRTS;
  const shirtHex = pool[Math.floor(rng.next() * pool.length)];
  const shirt = shadeHex(shirtHex, 0.78 + rng.next() * 0.30);
  const skin = shadeHex(CROWD_SKIN[Math.floor(rng.next() * CROWD_SKIN.length)], 0.84 + rng.next() * 0.22);
  const hair = CROWD_HAIR[Math.floor(rng.next() * CROWD_HAIR.length)];

  const shoulder = 0.42 + rng.next() * 0.06;
  const seatY = 0.58;
  const shoulderY = 1.00 + rng.signed(0.035);
  const headR = 0.098 + rng.next() * 0.012;
  const headY = shoulderY + headR * 1.35;
  const arms = rng.next();
  const stroke = (px + py) * 0.5;

  // Silhouette first, a shade wider than the body. This dark outline is the whole
  // trick: without it neighbouring spectators bleed together and the stand fizzes.
  c.fillStyle = 'rgba(10,12,15,0.86)';
  torsoPath(c, X, Y, m, shoulder * 1.10, seatY - 0.05, shoulderY + 0.025);
  c.fill();
  c.beginPath();
  c.ellipse(X(m), Y(headY), headR * 1.16 * px, headR * 1.16 * py, 0, 0, Math.PI * 2);
  c.fill();

  // Thighs folded onto the seat.
  c.fillStyle = shadeHex('#20242b', 0.9 + rng.next() * 0.35);
  c.fillRect(X(m - shoulder * 0.44), Y(0.63), shoulder * 0.88 * px, Y(0.52) - Y(0.63));

  c.fillStyle = shirt;
  torsoPath(c, X, Y, m, shoulder, seatY, shoulderY);
  c.fill();

  // A light across the shoulders, which is where a seated figure catches the sky.
  const lit = c.createLinearGradient(0, Y(shoulderY), 0, Y(shoulderY - 0.22));
  lit.addColorStop(0, 'rgba(255,255,255,0.16)');
  lit.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = lit;
  torsoPath(c, X, Y, m, shoulder, seatY, shoulderY);
  c.fill();

  c.strokeStyle = shirt;
  c.lineCap = 'round';
  c.lineWidth = stroke * 0.082;
  c.beginPath();
  if (arms > 0.90) {
    // Arms up. Rare on purpose: a stand where a fifth of the crowd is cheering at all
    // times looks wrong on the formation lap.
    c.moveTo(X(m - shoulder * 0.40), Y(shoulderY - 0.05));
    c.lineTo(X(m - shoulder * 0.62), Y(shoulderY + 0.17));
    c.moveTo(X(m + shoulder * 0.40), Y(shoulderY - 0.05));
    c.lineTo(X(m + shoulder * 0.62), Y(shoulderY + 0.17));
  } else if (arms > 0.55) {
    c.moveTo(X(m - shoulder * 0.44), Y(shoulderY - 0.06));
    c.lineTo(X(m - shoulder * 0.20), Y(shoulderY - 0.26));
    c.moveTo(X(m + shoulder * 0.44), Y(shoulderY - 0.06));
    c.lineTo(X(m + shoulder * 0.20), Y(shoulderY - 0.26));
  } else {
    c.moveTo(X(m - shoulder * 0.46), Y(shoulderY - 0.06));
    c.lineTo(X(m - shoulder * 0.52), Y(shoulderY - 0.30));
    c.moveTo(X(m + shoulder * 0.46), Y(shoulderY - 0.06));
    c.lineTo(X(m + shoulder * 0.52), Y(shoulderY - 0.30));
  }
  c.stroke();

  if (arms > 0.90) {
    c.strokeStyle = skin;
    c.lineWidth = stroke * 0.052;
    c.beginPath();
    c.moveTo(X(m - shoulder * 0.62), Y(shoulderY + 0.17));
    c.lineTo(X(m - shoulder * 0.66), Y(shoulderY + 0.25));
    c.moveTo(X(m + shoulder * 0.62), Y(shoulderY + 0.17));
    c.lineTo(X(m + shoulder * 0.66), Y(shoulderY + 0.25));
    c.stroke();
  }

  // Neck and head.
  c.fillStyle = skin;
  c.fillRect(X(m - headR * 0.36), Y(shoulderY + headR * 0.5), headR * 0.72 * px,
    Y(shoulderY - 0.02) - Y(shoulderY + headR * 0.5));
  c.beginPath();
  c.ellipse(X(m), Y(headY), headR * px, headR * py, 0, 0, Math.PI * 2);
  c.fill();

  const headwear = rng.next();
  if (headwear > 0.58) {
    c.fillStyle = shadeHex(CROWD_ACCENTS[Math.floor(rng.next() * CROWD_ACCENTS.length)],
      0.72 + rng.next() * 0.26);
    c.beginPath();
    c.ellipse(X(m), Y(headY + headR * 0.10), headR * 1.03 * px, headR * 1.03 * py,
      0, Math.PI, Math.PI * 2);
    c.fill();
    c.beginPath();
    c.ellipse(X(m + headR * 0.6), Y(headY + headR * 0.16), headR * 0.82 * px, headR * 0.24 * py,
      0, 0, Math.PI * 2);
    c.fill();
  } else {
    c.fillStyle = hair;
    c.beginPath();
    c.ellipse(X(m), Y(headY + headR * 0.12), headR * 0.99 * px, headR * 0.99 * py,
      0, Math.PI * 1.04, Math.PI * 1.96);
    c.fill();
  }
}

/**
 * Trapezoidal profiled steel cladding for grandstand flanks and roofs: a 300 mm rib
 * pitch with a fixing line on every third rib, weathered with rain streaking.
 */
export function buildGrandstand(size = 512, seed = 1818) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const ribs = 10;   // 3 m tile / 0.3 m pitch

  const dirtF = fbmField(noise, size, size, 12, 3, 4, 2.2, 0.55);
  const streakF = fbmField(new Noise(seed + 17), size, size, 26, 2, 3, 2.4, 0.5);
  const grainF = fbmField(noise, size, size, 200, 200, 2, 2.3, 0.5);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;

      const rp = u * ribs;
      const fr = rp - Math.floor(rp);
      // Trapezoid: flat crown, sloped webs, flat valley.
      const rib = smoothstep(0.10, 0.26, fr) * smoothstep(0.62, 0.46, fr);

      // Fixings on every third rib crown.
      const ribIdx = Math.floor(rp);
      const boltRow = Math.abs(v * 6 - Math.round(v * 6)) / 6 * size;
      const bolt = (ribIdx % 3 === 0)
        ? clamp01(1 - Math.hypot((fr - 0.36) * size / ribs, boltRow) / 2.6)
        : 0;

      const dirt = dirtF[i];
      const streak = clamp01(streakF[i] * 1.4 - 0.35) * smoothstep(1.0, 0.2, v);
      const grain = grainF[i];

      hf[i] = 0.42 + rib * 0.44 + bolt * 0.22 + grain * 0.03;

      const lift = 0.90 + rib * 0.18 + grain * 0.06 + dirt * 0.05;
      let r = 0xa6 * lift, g = 0xac * lift, b = 0xb4 * lift;
      r = mix(r, 0x5c, streak * 0.45); g = mix(g, 0x5e, streak * 0.45); b = mix(b, 0x5d, streak * 0.42);

      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;

      orm[j + 1] = clamp01(0.52 + streak * 0.30 + grain * 0.05 - rib * 0.05) * 255;
      orm[j + 2] = clamp01(0.55 - streak * 0.45) * 255;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, size, size, 5, 1.1);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, size, size, 2.0);
  return { width: size, height: size, color, normal, orm, tileU: 3.0, tileV: 3.0 };
}

/**
 * Invented brands. Nothing here is a real trademark: the wordmarks, the colourways and
 * the straplines are all made up, and the layouts are drawn from what actually appears
 * on a circuit — a hoarding is a wordmark, a mark, a strapline and a lot of empty vinyl,
 * not a logo floating in the middle of a coloured rectangle.
 */
/**
 * The boards themselves. Invented brands throughout — no real trademark appears in APEX.
 *
 * The palette is deliberately weighted to *light* grounds. Measured on the reviewed
 * frame, hoarding pixels came back at rgb(15,20,27) and rgb(2,3,10): six of the eight
 * grounds were dark navies, maroons and near-blacks, so a run of boards along a barrier
 * rendered as a strip of black rectangles with something illegible on it. That is a
 * palette problem, not a lighting one — a #0d2440 board lit by a summer sun is still a
 * very dark board. Trackside advertising is bought to be read from a moving car and from
 * a long lens, which is why the real thing is overwhelmingly white or one saturated
 * primary with a large, high-contrast wordmark on it. Five of these are light or bright,
 * two are mid, and one is deliberately black so the run is not uniform.
 */
const SPONSORS = [
  { name: 'VELOCE', tag: 'PERFORMANCE FLUIDS', bg: '#d81f36', fg: '#fffaf6', accent: '#ffc843', mark: 'chevron', layout: 'markLeft' },
  { name: 'AERONIX', tag: 'FLIGHT SYSTEMS', bg: '#f3f5f8', fg: '#123561', accent: '#0f8ad2', mark: 'ring', layout: 'split' },
  { name: 'KRATOS', tag: 'INDUSTRIAL TOOLING', bg: '#1a1c20', fg: '#f6f5f0', accent: '#f0a81e', mark: 'bar', layout: 'stripe' },
  { name: 'NOVABANK', tag: 'PRIVATE WEALTH', bg: '#edebe4', fg: '#14345c', accent: '#c8952a', mark: 'ring', layout: 'markLeft' },
  { name: 'HELIX', tag: 'BIOSCIENCE', bg: '#15a289', fg: '#ffffff', accent: '#0a4b41', mark: 'helix', layout: 'repeat' },
  { name: 'ZENTARA', tag: 'CLOUD PLATFORM', bg: '#6a3fc0', fg: '#ffffff', accent: '#c7b0ff', mark: 'bar', layout: 'split' },
  { name: 'ORBITAL', tag: 'SATELLITE DATA', bg: '#e0ddd6', fg: '#1c1d20', accent: '#d8452c', mark: 'ring', layout: 'stripe' },
  { name: 'PULSAR', tag: 'ENERGY DRINK', bg: '#f2801c', fg: '#16130e', accent: '#16130e', mark: 'chevron', layout: 'repeat' },
];

/**
 * Advertising hoardings, drawn as an atlas of eight 8:1 boards. Consumers pick a row by
 * offsetting V; `rows` is published on the material's userData.
 *
 * The top and bottom `FRAME_BAND` of every row is the aluminium frame the vinyl is
 * tensioned into rather than artwork, because `Trackside` folds the board's profile
 * back at those bands: the frame is real geometry with a real return edge on it, which
 * is what stops a hoarding reading as a decal painted on the barrier.
 */
const SPONSOR_FRAME_BAND = 0.11;

export function buildSponsorBoards(width = 2048, heightPx = 2048, seed = 4747) {
  const rows = SPONSORS.length;
  const rowH = heightPx / rows;
  const canvas = createCanvas(width, heightPx);
  const c = canvas.getContext('2d', { willReadFrequently: true });
  const rng = new Rng(seed);

  for (let r = 0; r < rows; r++) {
    const s = SPONSORS[r];
    const y0 = r * rowH;
    const fh = rowH * SPONSOR_FRAME_BAND;
    // The artwork lives between the frame bands; everything below is authored in that
    // sub-rectangle so a layout never runs under the aluminium.
    const ay = y0 + fh;
    const ah = rowH - fh * 2;

    c.save();
    c.beginPath();
    c.rect(0, ay, width, ah);
    c.clip();
    drawSponsorArt(c, s, width, ay, ah, rng);
    c.restore();

    drawBoardFrame(c, y0, rowH, fh, width);
  }

  const { data } = readCanvas(canvas);
  const n = width * heightPx;
  const noise = new Noise(seed);
  const orm = new Uint8Array(n * 4);
  const hf = createField(width, heightPx);
  const grimeF = fbmField(noise, width, heightPx, 20, 20, 3, 2.1, 0.5);

  for (let y = 0; y < heightPx; y++) {
    const v = (y + 0.5) / heightPx;
    const rv = (v * rows) % 1;
    const frame = rv < SPONSOR_FRAME_BAND || rv > 1 - SPONSOR_FRAME_BAND;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const i = y * width + x;
      const j = i * 4;

      const grime = grimeF[i];
      const dust = clamp01(smoothstep(0.28, SPONSOR_FRAME_BAND, rv) * 0.8 + grime * 0.2);
      // Slack in a stretched vinyl banner between its fixings; the frame does not sag.
      const slack = frame ? 0 : Math.sin(rv * Math.PI) * Math.sin(u * Math.PI * 6) * 0.12;
      const edge = clamp01(1 - Math.min(rv, 1 - rv) * 26);

      hf[i] = 0.5 + slack + grime * 0.03 - edge * 0.35;

      data[j] = Math.max(0, Math.min(255, data[j] * (1 - dust * 0.24) + dust * 22));
      data[j + 1] = Math.max(0, Math.min(255, data[j + 1] * (1 - dust * 0.24) + dust * 20));
      data[j + 2] = Math.max(0, Math.min(255, data[j + 2] * (1 - dust * 0.24) + dust * 17));

      orm[j] = 255;
      // Vinyl is a semi-gloss film and the frame is mill-finish aluminium; giving them
      // the same roughness is what made the whole board read as one flat card.
      orm[j + 1] = frame ? clamp01(0.34 + grime * 0.08) * 255
        : clamp01(0.40 + dust * 0.36 + grime * 0.06) * 255;
      orm[j + 2] = frame ? 210 : 0;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, width, heightPx, 4, 0.9);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, width, heightPx, 0.9);
  return {
    width, height: heightPx, color: data, normal, orm, rows,
    frameBand: SPONSOR_FRAME_BAND, tileU: 8.0, tileV: 1.0,
  };
}

/** The extruded aluminium the vinyl is tensioned into, top and bottom of every board. */
function drawBoardFrame(c, y0, rowH, fh, width) {
  const g = c.createLinearGradient(0, y0, 0, y0 + fh);
  g.addColorStop(0, '#5c6169');
  g.addColorStop(0.5, '#878d96');
  g.addColorStop(1, '#3d4148');
  c.fillStyle = g;
  c.fillRect(0, y0, width, fh);
  const g2 = c.createLinearGradient(0, y0 + rowH - fh, 0, y0 + rowH);
  g2.addColorStop(0, '#3d4148');
  g2.addColorStop(0.5, '#6f747c');
  g2.addColorStop(1, '#2a2d32');
  c.fillStyle = g2;
  c.fillRect(0, y0 + rowH - fh, width, fh);
  // Fixings, on the 1.2 m centres a real tensioned banner uses.
  c.fillStyle = 'rgba(20,22,26,0.55)';
  for (let k = 0; k < 14; k++) {
    const x = ((k + 0.5) / 14) * width;
    c.fillRect(x - fh * 0.09, y0 + fh * 0.30, fh * 0.18, fh * 0.40);
    c.fillRect(x - fh * 0.09, y0 + rowH - fh * 0.70, fh * 0.18, fh * 0.40);
  }
  c.fillStyle = 'rgba(0,0,0,0.75)';
  c.fillRect(0, y0, width, Math.max(1, rowH * 0.006));
  c.fillRect(0, y0 + rowH - Math.max(1, rowH * 0.006), width, Math.max(1, rowH * 0.006));
}

const SANS = 'system-ui, "Helvetica Neue", Helvetica, Arial, sans-serif';

/** Fit a wordmark to a box by measuring it, so no layout ever overruns its panel. */
function fitText(c, text, px, maxW, weight = 'bold', tracking = 0) {
  let size = px;
  for (let i = 0; i < 12; i++) {
    c.font = `${weight} ${Math.round(size)}px ${SANS}`;
    if ('letterSpacing' in c) c.letterSpacing = `${Math.round(size * tracking)}px`;
    if (c.measureText(text).width <= maxW) break;
    size *= 0.9;
  }
  return size;
}

function drawSponsorArt(c, s, width, ay, ah, rng) {
  c.fillStyle = s.bg;
  c.fillRect(0, ay, width, ah);

  if (s.layout === 'split') {
    // A narrow colour field carrying the mark, and the wordmark on the plain rest of the
    // board. Narrow on purpose: a third of an eight-metre hoarding in one flat accent is
    // four square metres of unbroken colour, and at any distance that is indistinguishable
    // from an untextured rectangle — which is precisely how the last pass read.
    const panel = width * 0.17;
    c.fillStyle = s.accent;
    c.beginPath();
    c.moveTo(0, ay);
    c.lineTo(panel, ay);
    c.lineTo(panel - ah * 0.34, ay + ah);
    c.lineTo(0, ay + ah);
    c.closePath();
    c.fill();
    drawSponsorMark(c, s.fg, panel * 0.44, ay + ah * 0.5, ah * 0.30, s.mark);
    drawWordmark(c, s, panel + (width - panel) * 0.5, ay + ah * 0.5, (width - panel) * 0.72, ah);
  } else if (s.layout === 'stripe') {
    // Motion stripes raked back off the wordmark, the way an energy or tooling brand
    // dresses a board it wants read at 300 km/h.
    c.save();
    c.globalAlpha = 0.16;
    c.fillStyle = s.accent;
    const rake = ah * 0.55;
    for (let k = 0; k < 26; k++) {
      const x = (k / 26) * (width + rake * 2) - rake;
      c.beginPath();
      c.moveTo(x, ay + ah);
      c.lineTo(x + rake, ay);
      c.lineTo(x + rake + ah * 0.16, ay);
      c.lineTo(x + ah * 0.16, ay + ah);
      c.closePath();
      c.fill();
    }
    c.restore();
    drawWordmark(c, s, width * 0.5, ay + ah * 0.5, width * 0.56, ah);
    drawSponsorMark(c, s.accent, width * 0.10, ay + ah * 0.5, ah * 0.32, s.mark);
    drawSponsorMark(c, s.accent, width * 0.90, ay + ah * 0.5, ah * 0.32, s.mark);
  } else if (s.layout === 'repeat') {
    // The same unit repeated four times: how a title sponsor buys a whole barrier run.
    const cell = width / 4;
    for (let k = 0; k < 4; k++) {
      if (k & 1) {
        c.fillStyle = 'rgba(0,0,0,0.13)';
        c.fillRect(k * cell, ay, cell, ah);
      }
      drawSponsorMark(c, s.accent, k * cell + cell * 0.16, ay + ah * 0.5, ah * 0.26, s.mark);
      const size = fitText(c, s.name, ah * 0.40, cell * 0.62, 'bold', 0.05);
      c.fillStyle = s.fg;
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      c.font = `bold ${Math.round(size)}px ${SANS}`;
      c.fillText(s.name, k * cell + cell * 0.30, ay + ah * 0.5);
      if ('letterSpacing' in c) c.letterSpacing = '0px';
    }
  } else {
    // markLeft: mark, rule, wordmark over strapline. The commonest real layout.
    c.fillStyle = s.accent;
    c.fillRect(0, ay, width * 0.028, ah);
    drawSponsorMark(c, s.accent, width * 0.10, ay + ah * 0.5, ah * 0.34, s.mark);
    c.fillStyle = s.fg;
    c.globalAlpha = 0.35;
    c.fillRect(width * 0.165, ay + ah * 0.18, Math.max(2, width * 0.0025), ah * 0.64);
    c.globalAlpha = 1;
    drawWordmark(c, s, width * 0.55, ay + ah * 0.46, width * 0.62, ah, 'centre');
  }

  // A tonal wedge across the board keeps a long hoarding from reading as flat vinyl.
  const g = c.createLinearGradient(0, ay, width, ay + ah);
  g.addColorStop(0, 'rgba(255,255,255,0.09)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.0)');
  g.addColorStop(1, 'rgba(0,0,0,0.15)');
  c.fillStyle = g;
  c.fillRect(0, ay, width, ah);
  // Scuffs and a peeling corner: nobody replaces a hoarding between sessions.
  c.fillStyle = 'rgba(255,255,255,0.05)';
  for (let k = 0; k < 6; k++) {
    const x = rng.next() * width;
    const y = ay + rng.next() * ah;
    c.fillRect(x, y, width * (0.01 + rng.next() * 0.05), ah * 0.02);
  }
}

/**
 * Wordmark plus strapline, set as a real lockup rather than one line of centred text.
 *
 * Cap height is 0.62 of the artwork band, which on a 1.02 m board is a little over half
 * a metre — the size trackside advertising is actually set at, and roughly a third
 * larger than it was. A hoarding is read at sixty metres through a long lens; anything
 * smaller than this is a grey texture on a coloured rectangle by the time it is drawn.
 */
function drawWordmark(c, s, cx, cy, maxW, ah) {
  const size = fitText(c, s.name, ah * 0.62, maxW, '800', 0.06);
  c.fillStyle = s.fg;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.font = `800 ${Math.round(size)}px ${SANS}`;
  if ('letterSpacing' in c) c.letterSpacing = `${Math.round(size * 0.06)}px`;
  c.fillText(s.name, cx, cy - ah * 0.10);
  const tagSize = fitText(c, s.tag, ah * 0.155, maxW * 0.78, '500', 0.28);
  c.globalAlpha = 0.78;
  c.font = `500 ${Math.round(tagSize)}px ${SANS}`;
  if ('letterSpacing' in c) c.letterSpacing = `${Math.round(tagSize * 0.28)}px`;
  c.fillText(s.tag, cx, cy + ah * 0.30);
  c.globalAlpha = 1;
  if ('letterSpacing' in c) c.letterSpacing = '0px';
}

function drawSponsorMark(c, colour, cx, cy, r, kind) {
  c.save();
  c.fillStyle = colour;
  c.strokeStyle = colour;
  c.lineWidth = r * 0.26;
  c.lineCap = 'butt';
  if (kind === 'ring') {
    c.beginPath();
    c.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.arc(cx, cy, r * 0.26, 0, Math.PI * 2);
    c.fill();
  } else if (kind === 'chevron') {
    c.beginPath();
    c.moveTo(cx - r * 0.7, cy + r * 0.6);
    c.lineTo(cx, cy - r * 0.6);
    c.lineTo(cx + r * 0.7, cy + r * 0.6);
    c.lineTo(cx + r * 0.28, cy + r * 0.6);
    c.lineTo(cx, cy - r * 0.02);
    c.lineTo(cx - r * 0.28, cy + r * 0.6);
    c.closePath();
    c.fill();
  } else if (kind === 'helix') {
    // Two counter-rotating strands: a biotech mark that is not a generic circle.
    for (let side = -1; side <= 1; side += 2) {
      c.beginPath();
      for (let k = 0; k <= 20; k++) {
        const t = k / 20;
        const x = cx + Math.sin(t * Math.PI * 2) * r * 0.55 * side;
        const y = cy - r * 0.85 + t * r * 1.7;
        if (k === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.lineWidth = r * 0.19;
      c.stroke();
    }
  } else {
    for (let k = 0; k < 3; k++) {
      c.fillRect(cx - r * 0.8 + k * r * 0.56, cy - r * 0.7 + k * r * 0.18, r * 0.34, r * 1.4 - k * r * 0.36);
    }
  }
  c.restore();
}

/**
 * Pit complex facade. The V axis walks up the building: roller-shutter garage doors,
 * a fascia band, the glazed team offices above, then the roof parapet. Applied to a
 * simple box this reads as a modern paddock building without any extra geometry.
 */
export function buildPitBuilding(size = 512, seed = 2626) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const grimeF = fbmField(noise, size, size, 16, 16, 3, 2.1, 0.5);
  const grainF = fbmField(noise, size, size, 210, 210, 2, 2.3, 0.5);
  const streakF = fbmField(new Noise(seed + 43), size, size, 30, 2, 3, 2.3, 0.5);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;

      const grime = grimeF[i];
      const grain = grainF[i];

      let r, g, b, rough, metal, height;

      if (v < 0.42) {
        // Roller shutters: horizontal slats, four garages across the tile.
        const bay = u * 4;
        const fb = bay - Math.floor(bay);
        const pier = clamp01(1 - Math.min(fb, 1 - fb) * 5.5);
        const slat = Math.abs(((v * 34) % 1) - 0.5) * 2;
        const slatH = smoothstep(0.9, 0.25, slat);
        height = 0.42 + slatH * 0.14 + pier * 0.30;
        const door = 1 - pier;
        r = mix(0xb8, 0x8e, door) * (0.92 + slatH * 0.14);
        g = mix(0xb6, 0x92, door) * (0.92 + slatH * 0.14);
        b = mix(0xb2, 0x98, door) * (0.92 + slatH * 0.14);
        rough = mix(0.72, 0.42, door);
        metal = door * 0.85;
      } else if (v < 0.50) {
        // Fascia band above the garages, carrying the pit-lane number strip.
        const numBand = smoothstep(0.44, 0.455, v) * smoothstep(0.49, 0.475, v);
        height = 0.62 + numBand * 0.06;
        r = mix(0x2a, 0xd8, numBand * 0.15) + grain * 8;
        g = mix(0x2c, 0xd8, numBand * 0.15) + grain * 8;
        b = mix(0x31, 0xd8, numBand * 0.15) + grain * 8;
        rough = 0.48;
        metal = 0.30;
      } else if (v < 0.86) {
        // Curtain-wall glazing with aluminium mullions.
        const mull = clamp01(1 - Math.abs(((u * 22) % 1) - 0.5) * 2 * 9);
        const transom = clamp01(1 - Math.abs(((v * 9) % 1) - 0.5) * 2 * 11);
        const frame = Math.max(mull, transom);
        // Fake a sky reflection gradient inside each pane so the glass is not flat black.
        const pane = smoothstep(0.5, 0.86, v);
        const refl = 0.28 + pane * 0.55 + grime * 0.10;
        height = 0.55 + frame * 0.22;
        r = mix(0x27 + refl * 90, 0xb4, frame);
        g = mix(0x33 + refl * 105, 0xb8, frame);
        b = mix(0x42 + refl * 120, 0xbc, frame);
        rough = mix(0.06, 0.38, frame);
        metal = mix(0.15, 0.90, frame);
      } else {
        const cap = smoothstep(0.86, 0.90, v);
        height = 0.58 + cap * 0.24;
        r = 0x9a + grain * 10; g = 0x9e + grain * 10; b = 0xa4 + grain * 10;
        rough = 0.44;
        metal = 0.75;
      }

      const streak = clamp01(streakF[i] * 1.3 - 0.5) * 0.30;
      r = mix(r, 0x60, streak); g = mix(g, 0x62, streak); b = mix(b, 0x63, streak);

      hf[i] = height + grain * 0.02;

      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r * (0.96 + grime * 0.08)));
      color[j + 1] = Math.max(0, Math.min(255, g * (0.96 + grime * 0.08)));
      color[j + 2] = Math.max(0, Math.min(255, b * (0.96 + grime * 0.08)));
      color[j + 3] = 255;

      orm[j + 1] = clamp01(rough + streak * 0.4 + grain * 0.04) * 255;
      orm[j + 2] = clamp01(metal * (1 - streak)) * 255;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, size, size, 5, 1.2);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, size, size, 2.2);
  return { width: size, height: size, color, normal, orm, tileU: 24.0, tileV: 12.0 };
}

/**
 * Stacked-tyre barrier rubber: perished sidewall, chalky UV bloom, paint splashes from
 * whoever last marked the stack, and the grey dust that coats everything near a gravel trap.
 */
export function buildTyreWall(size = 512, seed = 7373) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const perishF = ridgedField(noise, size, size, 22, 22, 3, 2.2, 0.5, 1.0);
  const grainF = fbmField(noise, size, size, 170, 170, 2, 2.3, 0.5);
  const bloomF = fbmField(noise, size, size, 7, 7, 4, 2.0, 0.55);
  const scuffF = fbmField(new Noise(seed + 53), size, size, 4, 40, 3, 2.4, 0.5);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;

      const crack = clamp01((perishF[i] - 0.72) * 4.5);
      const grain = grainF[i];
      const bloom = clamp01(bloomF[i] * 1.2 + 0.25);
      const scuff = clamp01(scuffF[i] * 1.5 - 0.7);

      hf[i] = 0.55 - crack * 0.42 + grain * 0.07;

      // Perished rubber turns chalky grey-brown, not blacker.
      const base = 0x1b + grain * 9;
      let r = mix(base, 0x55, bloom * 0.42);
      let g = mix(base, 0x52, bloom * 0.42);
      let b = mix(base + 2, 0x4d, bloom * 0.38);
      r = mix(r, 0x0d, crack * 0.7); g = mix(g, 0x0d, crack * 0.7); b = mix(b, 0x0e, crack * 0.7);
      r = mix(r, 0x9c, scuff * 0.35); g = mix(g, 0x99, scuff * 0.35); b = mix(b, 0x92, scuff * 0.35);

      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;

      orm[j + 1] = clamp01(0.90 + bloom * 0.06 + crack * 0.05 - scuff * 0.1) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, size, size, 4, 1.3);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, size, size, 2.0);
  return { width: size, height: size, color, normal, orm, tileU: 0.7, tileV: 0.7 };
}

/**
 * Hot-dip galvanised Armco. The giveaway for galvanising is spangle — visible zinc
 * crystals with flat facets, each catching light at its own angle — plus the bolt line
 * and the scrapes every barrier collects.
 */
export function buildArmco(width = 512, heightPx = 256, seed = 5959) {
  const n = width * heightPx;
  const noise = new Noise(seed);
  const spangle = new WorleyGrid(52, 26, seed + 3, 1.0);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(width, heightPx);
  const scratchF = ridgedField(noise, width, heightPx, 4, 60, 3, 2.2, 0.5, 1.0);
  const grainF = fbmField(noise, width, heightPx, 190, 95, 2, 2.3, 0.5);
  const rustF = fbmField(new Noise(seed + 67), width, heightPx, 9, 9, 4, 2.1, 0.5);

  for (let y = 0; y < heightPx; y++) {
    const v = (y + 0.5) / heightPx;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const i = y * width + x;

      const s = spangle.query(u, v);
      // Flat crystal facets: use the offset to the feature point as a facet slope.
      const facet = clamp01(1 - s.f2 + s.f1);
      const tiltX = s.dx * 0.6;
      const tiltY = s.dy * 0.6;

      const scratch = clamp01(scratchF[i] - 0.80) * 5;
      const grain = grainF[i];

      // Bolt line along the beam centre, at 3 m post spacing on a 6 m tile.
      const boltU = Math.abs(u * 2 - Math.round(u * 2)) / 2 * width;
      const boltV = Math.abs(v - 0.5) * heightPx;
      const bolt = clamp01(1 - Math.hypot(boltU, boltV) / (width * 0.026));

      hf[i] = 0.5 + (tiltX + tiltY) * 0.10 + facet * 0.05 + scratch * 0.20 + bolt * 0.45 + grain * 0.03;

      const lift = 0.90 + facet * 0.16 + s.id * 0.10 + scratch * 0.18 + grain * 0.05;
      const rust = clamp01(rustF[i] * 1.2 - 0.62);
      let r = 0xb0 * lift, g = 0xb6 * lift, b = 0xbb * lift;
      r = mix(r, 0x8a, rust * 0.8); g = mix(g, 0x5c, rust * 0.8); b = mix(b, 0x3a, rust * 0.8);
      // Barriers are filthy along the bottom flange and around every bolt head.
      const grime = clamp01(smoothstep(0.34, 0.0, v) * 0.55 + bolt * 0.4 + grain * 0.15);
      r = mix(r, 0x5e, grime * 0.45); g = mix(g, 0x5c, grime * 0.45); b = mix(b, 0x57, grime * 0.42);

      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;

      orm[j + 1] = clamp01(0.40 + facet * 0.14 + rust * 0.42 - scratch * 0.08 + grain * 0.05 + grime * 0.25) * 255;
      orm[j + 2] = clamp01(0.95 - rust * 0.7 - grime * 0.35) * 255;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, width, heightPx, 4, 0.9);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, width, heightPx, 1.6);
  return { width, height: heightPx, color, normal, orm, tileU: 6.0, tileV: 0.48 };
}

/**
 * Debris fence mesh: 50 mm chain-link aperture on 3.15 mm galvanised wire, which over a
 * 0.5 m tile is ten apertures. Alpha carries the aperture; the wires get a round
 * cross-section in the normal so the fence glints as the sun crosses it.
 */
export function buildDebrisFence(size = 512, seed = 3131) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const apertures = 10;          // 50 mm aperture over a 0.5 m tile
  // Half of 3.15 mm galvanised wire, expressed as a fraction of the tile, which is the
  // unit the diagonal distance below comes out in.
  const halfWire = (0.00315 * 0.5) / 0.5;
  const grainF = fbmField(noise, size, size, 240, 240, 2, 2.3, 0.5);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;

      const a = (u + v) * apertures;
      const b = (u - v) * apertures;
      // |a - k| divided by |grad a| gives the perpendicular distance to the wire axis.
      const da = Math.abs(a - Math.round(a)) / (apertures * 1.41421356);
      const db = Math.abs(b - Math.round(b)) / (apertures * 1.41421356);

      const inA = clamp01(1 - da / halfWire);
      const inB = clamp01(1 - db / halfWire);

      // Where the two families cross, one passes over the other; alternate by cell so
      // the weave is a real interlace rather than a lattice of X junctions.
      const cell = (Math.floor(a) + Math.floor(b)) & 1;
      const topWire = cell === 0 ? inA : inB;
      const botWire = cell === 0 ? inB : inA;

      // The alpha silhouette is deliberately a shade wider than the shaded wire: a
      // 3 px wire mips away to nothing by the third level, and catch fencing that
      // disappears at 80 m looks like a bug even though the real thing is nearly
      // invisible there.
      const coverA = clamp01(1 - da / (halfWire * 1.55));
      const coverB = clamp01(1 - db / (halfWire * 1.55));
      const cover = clamp01(Math.max(coverA, coverB) * 1.15);
      const profile = Math.sqrt(Math.max(0, topWire)) * 1.0 + Math.sqrt(Math.max(0, botWire)) * 0.55;
      hf[i] = 0.35 + Math.min(1, profile) * 0.55;

      const grain = grainF[i];
      const shade = 0.72 + Math.min(1, profile) * 0.42 + grain * 0.08;
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, 0x9a * shade));
      color[j + 1] = Math.max(0, Math.min(255, 0xa0 * shade));
      color[j + 2] = Math.max(0, Math.min(255, 0xa6 * shade));
      color[j + 3] = Math.max(0, Math.min(255, cover * 255));

      orm[j] = Math.max(0, Math.min(255, (0.55 + Math.min(1, profile) * 0.45) * 255));
      orm[j + 1] = clamp01(0.44 + grain * 0.08) * 255;
      orm[j + 2] = 230;
      orm[j + 3] = 255;
    }
  }

  const normal = normalFromHeight(hf, size, size, 2.6);
  return { width: size, height: size, color, normal, orm, tileU: 0.5, tileV: 0.5 };
}

/** Ridged bark for the plane and pine planting that lines most European circuits. */
export function buildTreeBark(width = 256, heightPx = 512, seed = 8181) {
  const n = width * heightPx;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(width, heightPx);
  // Fissures run vertically and drift, so the ridged field is stretched hard in V.
  const fissureF = ridgedField(noise, width, heightPx, 26, 5, 4, 2.15, 0.5, 1.0);
  const plateF = fbmField(noise, width, heightPx, 9, 3, 4, 2.1, 0.55);
  const grainF = fbmField(noise, width, heightPx, 160, 60, 2, 2.3, 0.5);
  const mossF = fbmField(new Noise(seed + 29), width, heightPx, 5, 5, 3, 2.0, 0.5);

  for (let y = 0; y < heightPx; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;

      const fissure = fissureF[i];
      const plate = plateF[i];
      const grain = grainF[i];
      const moss = clamp01(mossF[i] * 1.3 - 0.55);

      const depth = clamp01(1 - fissure);
      hf[i] = 0.62 - depth * 0.55 + plate * 0.10 + grain * 0.04;

      const lift = 0.72 + (1 - depth) * 0.55 + grain * 0.10 + plate * 0.10;
      let r = 0x6a * lift, g = 0x59 * lift, b = 0x45 * lift;
      r = mix(r, 0x1e, depth * 0.55); g = mix(g, 0x18, depth * 0.55); b = mix(b, 0x12, depth * 0.55);
      r = mix(r, 0x4c, moss * 0.35); g = mix(g, 0x63, moss * 0.35); b = mix(b, 0x33, moss * 0.35);

      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;

      orm[j + 1] = clamp01(0.92 + grain * 0.05 - moss * 0.06) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, width, heightPx, 5, 1.4);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, width, heightPx, 3.0);
  return { width, height: heightPx, color, normal, orm, tileU: 1.2, tileV: 2.4 };
}

/**
 * Leaf-cluster card for canopy billboards: several hundred individually drawn leaves in
 * a soft blob, with alpha, lit top-down so the card already has internal depth before
 * the shader touches it.
 */
export function buildTreeCanopy(size = 512, seed = 6464) {
  const canvas = createCanvas(size, size);
  const c = canvas.getContext('2d', { willReadFrequently: true });
  c.clearRect(0, 0, size, size);

  const rng = new Rng(seed);
  const cx = size * 0.5, cy = size * 0.52;
  const leaves = Math.round(size * 1.3);

  for (let k = 0; k < leaves; k++) {
    // Bias toward the centre so the card silhouette is a cluster, not a disc.
    const rr = Math.pow(rng.next(), 0.62);
    const ang = rng.next() * Math.PI * 2;
    const lx = cx + Math.cos(ang) * rr * size * 0.46;
    const ly = cy + Math.sin(ang) * rr * size * 0.44;

    // Higher, outer leaves catch the sky; inner ones fall into shadow.
    const lit = clamp01(0.35 + (1 - (ly / size)) * 0.75 - rr * 0.25);
    const hue = 88 + rng.signed(16);
    const sat = 34 + rng.next() * 26;
    const light = 14 + lit * 34;
    c.fillStyle = `hsl(${hue}, ${sat}%, ${light}%)`;

    const len = size * (0.028 + rng.next() * 0.030);
    c.save();
    c.translate(lx, ly);
    c.rotate(rng.next() * Math.PI * 2);
    c.beginPath();
    c.ellipse(0, 0, len, len * (0.36 + rng.next() * 0.20), 0, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  const { data } = readCanvas(canvas);
  const n = size * size;
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const a = data[j + 3] / 255;
    const lum = (data[j] * 0.2126 + data[j + 1] * 0.7152 + data[j + 2] * 0.0722) / 255;
    hf[i] = a * (0.35 + lum * 0.65);
    orm[j] = Math.max(60, Math.min(255, (0.55 + lum * 0.45) * 255));
    orm[j + 1] = 214;   // leaf cuticle is semi-matte
    orm[j + 2] = 0;
    orm[j + 3] = 255;
  }

  const normal = normalFromHeight(hf, size, size, 1.8);
  return { width: size, height: size, color: data, normal, orm, tileU: 3.0, tileV: 3.0 };
}

/**
 * Marshal post cladding: FIA hazard striping on a steel panel, faded and grimy from a
 * few seasons outdoors.
 */
export function buildMarshalPost(size = 256, seed = 2121) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const stripes = 6;
  const grainF = fbmField(noise, size, size, 180, 180, 2, 2.3, 0.5);
  const dirtF = fbmField(noise, size, size, 8, 8, 4, 2.1, 0.55);
  const dentF = fbmField(new Noise(seed + 11), size, size, 14, 14, 3, 2.0, 0.5);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;

      const s = ((u + v) * stripes) % 1;
      const band = smoothstep(0.48, 0.52, s);
      const grain = grainF[i];
      const dirt = clamp01(dirtF[i] * 1.2 - 0.35);
      const dent = dentF[i];

      hf[i] = 0.5 + dent * 0.10 + grain * 0.04;

      const lift = 0.94 + grain * 0.08 + dent * 0.05;
      let r = mix(0xe6, 0xe8, band) * lift;
      let g = mix(0x6a, 0xe6, band) * lift;
      let b = mix(0x14, 0xe2, band) * lift;
      r = mix(r, 0x6b, dirt * 0.42); g = mix(g, 0x66, dirt * 0.42); b = mix(b, 0x5c, dirt * 0.42);

      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;

      orm[j] = 255;
      orm[j + 1] = clamp01(0.55 + dirt * 0.30 + grain * 0.05) * 255;
      orm[j + 2] = clamp01(0.35 - dirt * 0.3) * 255;
      orm[j + 3] = 255;
    }
  }

  const normal = normalFromHeight(hf, size, size, 1.0);
  return { width: size, height: size, color, normal, orm, tileU: 1.2, tileV: 1.2 };
}

/**
 * Tunnel and underpass lining: shuttered concrete panels streaked with exhaust soot,
 * lit strip cabling channels running the length of the bore.
 */
export function buildTunnelWall(size = 512, seed = 1414) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const panels = 3;   // 2 m shutter boards over a 6 m tile
  const gritF = fbmField(noise, size, size, 150, 150, 2, 2.3, 0.5);
  const sootF = fbmField(noise, size, size, 12, 2, 4, 2.2, 0.55);
  const dampF = fbmField(new Noise(seed + 47), size, size, 5, 5, 4, 2.0, 0.55);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;

      const boardV = Math.abs(v * (panels * 4) - Math.round(v * (panels * 4))) / (panels * 4) * size;
      const board = clamp01(1 - boardV / 2.0);
      const jointU = Math.abs(u * panels - Math.round(u * panels)) / panels * size;
      const joint = clamp01(1 - jointU / 2.6);

      const tie = clamp01(1 - Math.hypot(
        Math.abs(u * (panels * 2) - Math.round(u * (panels * 2))) / (panels * 2) * size,
        Math.abs(v * 4 - Math.round(v * 4)) / 4 * size,
      ) / 3.0);

      const grit = gritF[i];
      const soot = clamp01(sootF[i] * 1.2 + 0.35) * smoothstep(1.0, 0.15, v);
      const damp = clamp01(dampF[i] * 1.1 - 0.25);

      hf[i] = 0.58 - board * 0.25 - joint * 0.38 - tie * 0.55 + grit * 0.05;

      let r = 0x8e + grit * 16, g = 0x8c + grit * 16, b = 0x88 + grit * 15;
      r = mix(r, 0x24, soot * 0.62); g = mix(g, 0x23, soot * 0.62); b = mix(b, 0x24, soot * 0.60);
      r = mix(r, 0x4a, damp * 0.35); g = mix(g, 0x4d, damp * 0.35); b = mix(b, 0x4a, damp * 0.35);
      const shadow = Math.max(board * 0.35, Math.max(joint, tie) * 0.6);
      r *= 1 - shadow * 0.4; g *= 1 - shadow * 0.4; b *= 1 - shadow * 0.4;

      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;

      orm[j + 1] = clamp01(0.86 - damp * 0.30 + grit * 0.05 + soot * 0.04) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, size, size, 4, 1.2);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, size, size, 1.8);
  return { width: size, height: size, color, normal, orm, tileU: 6.0, tileV: 6.0 };
}

/**
 * Distance markers, in the order a driver meets them on the way into a braking zone.
 * Row `i` of the atlas occupies v in [i/rows, (i+1)/rows] and is the right way up there
 * — the canvas is drawn bottom-up because `readCanvas` flips rows on the way out, and a
 * board that has to be sampled upside down is a bug waiting to be re-introduced.
 */
export const DISTANCE_MARKS = [200, 150, 100, 50];

export function buildDistanceBoards(width = 256, heightPx = 1024, seed = 6161) {
  // One band per marking plus a plain aluminium band for the backs of the boards, so a
  // driver looking back up the road never sees a mirrored number.
  const rows = DISTANCE_MARKS.length + 1;
  const rowH = heightPx / rows;
  const canvas = createCanvas(width, heightPx);
  const c = canvas.getContext('2d', { willReadFrequently: true });

  for (let i = 0; i < rows; i++) {
    const y0 = (rows - 1 - i) * rowH;
    c.fillStyle = '#0f1114';
    c.fillRect(0, y0, width, rowH);
    if (i >= DISTANCE_MARKS.length) {
      c.fillStyle = '#9aa0a6';
      c.fillRect(width * 0.06, y0 + rowH * 0.06, width * 0.88, rowH * 0.88);
      continue;
    }
    c.fillStyle = '#e9e6dd';
    c.fillRect(width * 0.06, y0 + rowH * 0.06, width * 0.88, rowH * 0.88);

    // A slab of colour behind the figure, which is how a marker board stays readable
    // against a treeline at two hundred metres.
    c.fillStyle = i === 0 ? '#c5312a' : '#16181c';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `bold ${Math.round(rowH * 0.52)}px system-ui, "Helvetica Neue", Arial, sans-serif`;
    c.fillText(String(DISTANCE_MARKS[i]), width * 0.5, y0 + rowH * 0.52);

    c.strokeStyle = 'rgba(20,22,26,0.85)';
    c.lineWidth = Math.max(1, width * 0.012);
    c.strokeRect(width * 0.06, y0 + rowH * 0.06, width * 0.88, rowH * 0.88);
  }

  const { data } = readCanvas(canvas);
  const n = width * heightPx;
  const noise = new Noise(seed);
  const grimeF = fbmField(noise, width, heightPx, 14, 40, 3, 2.1, 0.5);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const dirt = clamp01(grimeF[i] * 1.3 - 0.45) * 0.35;
    data[j] = Math.max(0, Math.min(255, data[j] * (1 - dirt) + dirt * 96));
    data[j + 1] = Math.max(0, Math.min(255, data[j + 1] * (1 - dirt) + dirt * 94));
    data[j + 2] = Math.max(0, Math.min(255, data[j + 2] * (1 - dirt) + dirt * 86));
  }

  return { width, height: heightPx, color: data, rows, tileU: 1.0, tileV: 1.2 };
}

export { SPONSORS };

// --- catch fencing, verge, planting and LED panels ------------------------------------

/**
 * Mip chain for a cut-out sheet that is rendered *blended* rather than alpha-tested.
 *
 * Two things have to happen at every level and a plain box filter does neither. Alpha
 * must average linearly — that is what turns a lattice into a veil of exactly the same
 * optical density as the lattice it came from, instead of a fence that thins out and
 * disappears. Colour must average *weighted by alpha*, or the transparent gaps (which
 * carry no meaningful colour) drag the wire's colour toward black as the levels shrink
 * and the fence goes from galvanised grey to a smear of soot.
 *
 * This replaces the coverage-renormalising chain the alpha-tested version needed. That
 * one was the reason the review saw "posts with nothing between them": renormalisation
 * kept the *fraction of texels above the cutoff* constant, but by level five the whole
 * tile sat within a few units of the cutoff, so one more level of filtering flipped the
 * entire sheet below it at once and the mesh discarded outright from about eighty metres
 * out. A blended veil has no cliff to fall off.
 */
const CUTOUT_SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  CUTOUT_SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function cutoutLinearToSrgbByte(c) {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

function veilMipChain(data, w, h, srgb = true) {
  const levels = [{ data, width: w, height: h }];
  let src = data, sw = w, sh = h;
  const count = Math.floor(Math.log2(Math.max(w, h))) + 1;
  for (let l = 1; l < count; l++) {
    const dw = Math.max(1, sw >> 1);
    const dh = Math.max(1, sh >> 1);
    const dst = new Uint8Array(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
      const y0 = Math.min(y * 2, sh - 1);
      const y1 = Math.min(y * 2 + 1, sh - 1);
      for (let x = 0; x < dw; x++) {
        const x0 = Math.min(x * 2, sw - 1);
        const x1 = Math.min(x * 2 + 1, sw - 1);
        const q0 = (y0 * sw + x0) * 4, q1 = (y0 * sw + x1) * 4;
        const q2 = (y1 * sw + x0) * 4, q3 = (y1 * sw + x1) * 4;
        // Unrolled: this runs once per texel of every level of every cut-out atlas at
        // boot, and a four-element array per texel is a million short-lived allocations
        // on the fence tile alone.
        let wsum = 0, r = 0, g = 0, b = 0, a = 0;
        for (let t = 0; t < 4; t++) {
          const q = t === 0 ? q0 : t === 1 ? q1 : t === 2 ? q2 : q3;
          const wa = src[q + 3];
          a += wa;
          wsum += wa;
          if (srgb) {
            r += CUTOUT_SRGB_TO_LINEAR[src[q]] * wa;
            g += CUTOUT_SRGB_TO_LINEAR[src[q + 1]] * wa;
            b += CUTOUT_SRGB_TO_LINEAR[src[q + 2]] * wa;
          } else {
            r += src[q] * wa;
            g += src[q + 1] * wa;
            b += src[q + 2] * wa;
          }
        }
        const o = (y * dw + x) * 4;
        if (wsum > 0) {
          if (srgb) {
            dst[o] = cutoutLinearToSrgbByte(r / wsum);
            dst[o + 1] = cutoutLinearToSrgbByte(g / wsum);
            dst[o + 2] = cutoutLinearToSrgbByte(b / wsum);
          } else {
            dst[o] = Math.round(r / wsum);
            dst[o + 1] = Math.round(g / wsum);
            dst[o + 2] = Math.round(b / wsum);
          }
        } else {
          dst[o] = src[q0];
          dst[o + 1] = src[q0 + 1];
          dst[o + 2] = src[q0 + 2];
        }
        dst[o + 3] = Math.round(a * 0.25);
      }
    }
    levels.push({ data: dst, width: dw, height: dh });
    src = dst; sw = dw; sh = dh;
  }
  return levels;
}

/**
 * Rescale the alpha of a mip chain so every level keeps level 0's *coverage* — the
 * fraction of texels that survive the alpha test.
 *
 * Only for sheets that are genuinely alpha-tested, which now means the foliage atlas:
 * a canopy has to write depth and cast a shadow, so it cannot be a blend. Without this,
 * a box filter averages a leaf cluster below the cutoff within four levels and the whole
 * treeline dissolves into a grey smear at exactly the distance a skyline matters most.
 *
 * The bisection has a floor the previous version did not. Once a level's alpha range
 * collapses to a few units either side of the cutoff — which is what happens at 8x8 and
 * below, where the tile is smaller than one leaf — coverage as a function of the scale
 * factor is a step, not a ramp, and bisecting a step lands on whichever side the last
 * probe fell. Measured on the shipped fence texture that returned 0.000 coverage at the
 * 8x8 level: the entire sheet vanished in one step. Choosing the side that keeps
 * coverage at or above the target makes the failure mode "slightly too dense", which is
 * invisible, instead of "gone", which is what the review saw.
 */
function preserveCoverage(levels, alphaTest) {
  const coverageOf = (data, scale) => {
    let hit = 0;
    for (let i = 3; i < data.length; i += 4) if ((data[i] / 255) * scale >= alphaTest) hit++;
    return hit / (data.length / 4);
  };
  const target = coverageOf(levels[0].data, 1);
  if (target <= 0) return levels;

  for (let l = 1; l < levels.length; l++) {
    const data = levels[l].data;
    // Bisect on the alpha multiplier: monotone in scale, so twelve steps is exact to
    // better than a texel's worth of coverage at any level worth filtering.
    // Capped at 8, and the cap is the point. An uncapped search will happily multiply a
    // coarse level by fifty to hit its coverage target, and the result is a level whose
    // alpha is 255 everywhere: every foliage card at that range stops being a ragged
    // cluster and becomes a solid, flat, fully-lit quad. In a treeline that shows up as
    // pale rectangles and ladders of bars hanging in the canopy, which is worse than the
    // slight thinning the cap costs at ranges where a whole tree is a few pixels wide.
    let lo = 1, hi = 8;
    if (coverageOf(data, hi) < target) { lo = hi; } else {
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) * 0.5;
        if (coverageOf(data, mid) < target) lo = mid; else hi = mid;
      }
    }
    // `hi` is the end of the bracket that is known to reach the target; `lo` is known
    // not to. Take `hi` rather than the midpoint so a step function never rounds down
    // into the level that discards everything.
    const scale = Math.min(8, hi);
    for (let i = 3; i < data.length; i += 4) {
      data[i] = Math.min(255, Math.round(data[i] * scale));
    }
  }
  return levels;
}

/**
 * Kept for the shadow pass and for any consumer that still wants a binary cutoff. The
 * catch-fence material itself no longer alpha-tests: see `veilMipChain`.
 */
export const FENCE_ALPHA_TEST = 0.34;

/**
 * Catch fencing: 4.6 mm galvanised wire woven on a 50 mm diamond aperture, tiled at
 * 0.5 m, drawn as a blended veil.
 *
 * The numbers are the real ones. A debris fence is 4-5 mm wire on a 50 mm clear
 * aperture, which occludes about a quarter of what is behind it seen square on and a
 * good deal more seen at the raking angles a trackside camera actually sees it from.
 * That is the look: see-through, but unmistakably there, and getting denser as the
 * fence runs away from you.
 *
 * The wire is a round section in the height field, so the normal map gives every strand
 * a lit crown — that specular line along the top of the weave is the single thing that
 * makes a fence read as steel rather than as a grey stencil, and it is what "catches
 * the light" means here. Alpha is a hard core with a half-texel ramp on it: crisp
 * enough to be a lattice up close, soft enough that the blend antialiases it.
 */
export function buildCatchFence(size = 512, seed = 3131) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const apertures = 10;               // 50 mm diamond over a 0.5 m tile
  const texel = 1 / size;
  // Half of 4.6 mm wire as a fraction of the 0.5 m tile.
  const halfWire = (0.0046 * 0.5) / 0.5;
  // Opaque core, then a ramp one texel wide. Antialiasing the cutout in the texture is
  // free here because the sheet is blended; an alpha-tested fence cannot do it at all.
  const coreEdge = Math.max(halfWire * 0.35, halfWire - texel * 0.6);
  const softEdge = halfWire + texel * 0.4;
  const grainF = fbmField(noise, size, size, 240, 240, 2, 2.3, 0.5);
  const dirtF = fbmField(new Noise(seed + 17), size, size, 5, 5, 3, 2.1, 0.5);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;

      const a = (u + v) * apertures;
      const b = (u - v) * apertures;
      const da = Math.abs(a - Math.round(a)) / (apertures * 1.41421356);
      const db = Math.abs(b - Math.round(b)) / (apertures * 1.41421356);

      // Round section: sqrt of the linear ramp is a circle's profile, which is what puts
      // a specular line down the crown of every strand instead of a flat grey band.
      const inA = Math.sqrt(clamp01(1 - da / halfWire));
      const inB = Math.sqrt(clamp01(1 - db / halfWire));

      // Where the two families cross, one passes over the other; alternate by cell so
      // the weave is a real interlace rather than a lattice of X junctions.
      const cell = (Math.floor(a) + Math.floor(b)) & 1;
      const topWire = cell === 0 ? inA : inB;
      const botWire = cell === 0 ? inB : inA;
      const profile = Math.min(1, topWire + botWire * 0.55);

      const cover = Math.max(
        1 - smoothstep(coreEdge, softEdge, da),
        1 - smoothstep(coreEdge, softEdge, db),
      );

      hf[i] = 0.30 + profile * 0.62;

      const grain = grainF[i];
      const dirt = clamp01(0.5 + dirtF[i]);
      // Hot-dip galvanising a season old: light enough to catch the sky, dark enough to
      // sit against pale tarmac. The crown of the strand is the brightest part of it.
      const shade = (0.62 + profile * 0.46 + grain * 0.07) * (1 - dirt * 0.26);
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, 0xb6 * shade));
      color[j + 1] = Math.max(0, Math.min(255, 0xbb * shade));
      color[j + 2] = Math.max(0, Math.min(255, 0xc2 * shade));
      color[j + 3] = Math.max(0, Math.min(255, cover * 255));

      orm[j] = Math.max(0, Math.min(255, (0.55 + profile * 0.45) * 255));
      // Drawn wire is smooth; weathering and grime take the crown off it.
      orm[j + 1] = clamp01(0.34 + dirt * 0.22 + grain * 0.06) * 255;
      orm[j + 2] = 228;
      orm[j + 3] = 255;
    }
  }

  const normal = normalFromHeight(hf, size, size, 2.6);
  return {
    width: size, height: size, color, normal, orm,
    colorMips: veilMipChain(color, size, size), tileU: 0.5, tileV: 0.5,
  };
}

/**
 * The astroturf verge between kerb and run-off.
 *
 * Real synthetic verge is a manufactured mat that has been rained on, driven over and
 * left in the sun for a season: a muted, slightly grey olive, never the saturated
 * primary green a flat colour swatch suggests. U runs along the circuit and V across the
 * strip, so the pile streaks are authored along U — at 300 km/h a grain running across
 * the direction of travel strobes, and the same grain running with it smears cleanly.
 * The mat is 1.5 m of tile, matching the `astroturf` set the verge geometry is UV'd for.
 */
export function buildAstroturfVerge(size = 512, seed = 7700) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);

  // Periods are (x, y) = (along track, across strip). Few periods along U and many
  // across V is what makes a streak run with the road rather than across it.
  const pileF = fbmField(noise, size, size, 14, 300, 2, 2.4, 0.5);
  const fineF = fbmField(new Noise(seed + 13), size, size, 40, 460, 1, 2.2, 0.5);
  const wearF = fbmField(new Noise(seed + 29), size, size, 5, 3, 3, 2.0, 0.5);
  const dirtF = fbmField(new Noise(seed + 47), size, size, 11, 7, 3, 2.2, 0.5);

  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    // Roll seams: the mat is laid in 0.75 m strips parallel to the circuit, so the joins
    // are lines running along the road — the single cue that says "laid mat", not "paint".
    const seam = Math.max(
      clamp01(1 - Math.abs(v - 0.5) * 90),
      clamp01(1 - Math.min(v, 1 - v) * 90),
    );
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;
      const pile = pileF[i];
      const fine = fineF[i];
      const wear = clamp01(0.5 + wearF[i] * 1.2);
      const dirt = clamp01(0.5 + dirtF[i]);

      // The tufting rows themselves: a synthetic mat is stitched in lines about 20 mm
      // apart running the length of the roll, and at 1.5 m of tile over 512 texels that
      // is a period the map can actually hold. Combing the fibre into those rows is what
      // gives the strip a direction — without it the surface is only noise, and noise
      // with no grain in it is indistinguishable from a flat fill once it is more than a
      // few metres away, which is how the verge came to read as a painted band.
      const rows = Math.sin(v * Math.PI * 2 * 75 + pile * 2.2);
      const comb = rows * rows;                       // 0..1, sharpened toward the crown
      const drift = Math.sin(u * Math.PI * 2 * 3 + fine * 4.0) * 0.5 + 0.5;

      hf[i] = 0.5 + pile * 0.22 + fine * 0.14 + comb * 0.20 - seam * 0.45;

      const shade = 1 + pile * 0.24 + fine * 0.09 + (comb - 0.5) * 0.18 + (drift - 0.5) * 0.05;
      // Fresh pile is a grey-green, not a green: a mat that has been rained on and
      // bleached for a season sits around 12% saturation, which is roughly a third of
      // what real grass carries. Traffic greys it further and rubber pickup darkens it.
      const r = mix(0x56, 0x74, wear);
      const g = mix(0x68, 0x81, wear);
      const b = mix(0x4c, 0x69, wear);
      const rubber = clamp01((1 - dirt) * 0.55);
      const j = i * 4;
      const k = (1 - seam * 0.55) * shade;
      color[j] = Math.max(0, Math.min(255, mix(r, 0x3c, rubber) * k));
      color[j + 1] = Math.max(0, Math.min(255, mix(g, 0x41, rubber) * k));
      color[j + 2] = Math.max(0, Math.min(255, mix(b, 0x3a, rubber) * k));
      color[j + 3] = 255;

      orm[j] = 255;
      // Flat: a synthetic pile scatters almost everything it is given, and any gloss on
      // it at grazing incidence is what made the verge glow like an unlit colour swatch.
      orm[j + 1] = clamp01(0.88 + pile * 0.06 - wear * 0.05) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }

  const ao = aoFromHeight(hf, size, size, 4, 1.0);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));

  const normal = normalFromHeight(hf, size, size, 2.2);
  return {
    width: size, height: size, color, normal, orm,
    colorMips: mipChain(color, size, size, true), tileU: 1.5, tileV: 1.5,
  };
}

/**
 * Foliage atlas: four leaf-cluster cards in a 2x2 grid, one per planting type on the
 * hillside. Cell 0 is spruce needle spray, 1 pine tuft, 2 beech mass, 3 birch.
 *
 * The point of four cells rather than one is the skyline. A forest built from a single
 * cluster card reads as one shape repeated a thousand times no matter how it is scaled,
 * and that repetition is visible along a treeline long before any individual tree is.
 * The cards also carry a coverage-preserving mip chain: a canopy that thins as it
 * recedes turns a treeline into a grey smear at exactly the distance it matters most.
 */
export const CANOPY_ALPHA_TEST = 0.36;
export const CANOPY_ATLAS = { cols: 2, rows: 2 };

const CANOPY_STYLES = [
  // needle: long thin blades; blob: rounded leaves. `spread` shapes the silhouette.
  // Hues climb from 82 (birch, yellow-green) to 112 (spruce, blue-green), which is the
  // real spread of a mixed Ardennes hillside; anything below 80 goes olive and reads as
  // autumn, anything above 130 goes blue and reads as a filter.
  // The conifers are drawn far denser than the broadleaves for a mechanical reason: the
  // spire clip rejects most of the placements it is offered near the apex, so the same
  // nominal count leaves a spruce cell sparse enough that individual blades read as
  // stripes on a near tree.
  //
  // Lightness runs 15-39%, up from 9-32%, and saturation comes *down* from 22-62% to
  // 20-42%. Both halves matter and they were calibrated against measurements, not taste.
  //
  // Raising the floor is what fixes the review's note: canopy pixels on the reviewed
  // frame came back at rgb(13,26,16) and rgb(38,49,33) against a 249 sky, which is not a
  // forest, it is a stencil — with nothing but silhouette to look at, every crown reads
  // as the same shape. But an intermediate pass that also raised the ceiling to 52% put
  // sunlit crowns at rgb(83,146,1) with their highlights clipped to rgb(239,243,239):
  // neon-green cabbages, because a hue-94 fill at high saturation has essentially no
  // blue in it and the tonemap takes what is left straight to white. Real sunlit
  // broadleaf sits near 0.14 linear reflectance with a blue channel about 45% of its
  // green. Holding the ceiling at 39% lightness and 42% saturation lands there.
  { leaf: 'needle', count: 3.4, hue: [112, 12], sat: [20, 12], light: [15, 15], len: [0.034, 0.020], aspect: 0.20, spread: 'spire' },
  { leaf: 'needle', count: 2.4, hue: [102, 14], sat: [22, 14], light: [16, 17], len: [0.040, 0.024], aspect: 0.24, spread: 'open' },
  { leaf: 'blob', count: 2.2, hue: [94, 16], sat: [24, 16], light: [17, 19], len: [0.032, 0.026], aspect: 0.62, spread: 'round' },
  { leaf: 'blob', count: 1.3, hue: [82, 20], sat: [26, 16], light: [20, 19], len: [0.028, 0.022], aspect: 0.70, spread: 'airy' },
];

export function buildCanopyAtlas(size = 1024, seed = 6464) {
  const cell = size >> 1;
  const canvas = createCanvas(size, size);
  const c = canvas.getContext('2d', { willReadFrequently: true });
  c.clearRect(0, 0, size, size);

  for (let idx = 0; idx < 4; idx++) {
    const col = idx % 2;
    const row = idx >> 1;
    // readCanvas flips rows, so logical atlas row `row` (counting up from v = 0) has to
    // be drawn into the canvas row counting down from the top.
    const x0 = col * cell;
    const y0 = (1 - row) * cell;
    drawCanopyCell(c, CANOPY_STYLES[idx], x0, y0, cell, new Rng(seed + idx * 977));
  }

  const { data } = readCanvas(canvas);
  const n = size * size;
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    const a = data[j + 3] / 255;
    const lum = (data[j] * 0.2126 + data[j + 1] * 0.7152 + data[j + 2] * 0.0722) / 255;
    hf[i] = a * (0.35 + lum * 0.65);
    orm[j] = Math.max(60, Math.min(255, (0.55 + lum * 0.45) * 255));
    orm[j + 1] = 214;   // leaf cuticle is semi-matte
    orm[j + 2] = 0;
    orm[j + 3] = 255;
  }

  const normal = normalFromHeight(hf, size, size, 1.8);
  return {
    width: size, height: size, color: data, normal, orm,
    // Alpha-weighted colour, then coverage-preserved alpha. The weighting is the half
    // that was missing: a canvas cut-out's empty texels are transparent *black*, so a
    // plain box filter drags the leaf colour toward zero one level at a time and the
    // treeline gets darker the further away it is — the exact opposite of aerial
    // perspective, and a second reason the hillside read as a flat dark cut-out.
    colorMips: preserveCoverage(veilMipChain(data, size, size, true), CANOPY_ALPHA_TEST),
    cols: CANOPY_ATLAS.cols, rows: CANOPY_ATLAS.rows, tileU: 3.0, tileV: 3.0,
  };
}

function drawCanopyCell(c, style, x0, y0, s, rng) {
  const cx = x0 + s * 0.5;
  const cy = y0 + s * 0.52;
  const leaves = Math.round(s * style.count);
  // A two-texel gutter keeps neighbouring cells out of each other's bilinear taps.
  c.save();
  c.beginPath();
  c.rect(x0 + 2, y0 + 2, s - 4, s - 4);
  c.clip();

  for (let k = 0; k < leaves; k++) {
    let rr = Math.pow(rng.next(), 0.62);
    // A feathered rim, and it is the difference between a tree and a lollipop. Filling a
    // clean ellipse of leaf clusters gives every card a hard elliptical boundary, and a
    // crown assembled from a dozen of those is a smooth blob with a drawn outline no
    // matter how the cards are arranged. Thinning the outer fifth and letting a few
    // clusters stand a quarter past the nominal envelope breaks the outline, which is
    // what the eye actually reads as foliage.
    if (rr > 0.78) {
      if (rng.next() < (rr - 0.78) * 2.6) continue;
      rr *= 1.0 + rng.next() * 0.26;
    }
    const ang = rng.next() * Math.PI * 2;
    let ex = 0.46;
    let ey = 0.44;
    let bias = 0;
    if (style.spread === 'spire') {
      // Narrow at the top, wide at the base: the silhouette a conifer card has to give.
      ex = 0.20 + 0.30 * rr;
      ey = 0.48;
      bias = 0.06;
    } else if (style.spread === 'open') {
      ex = 0.44;
      ey = 0.32;
      bias = -0.10;
    } else if (style.spread === 'airy') {
      ex = 0.42;
      ey = 0.42;
    }
    const lx = cx + Math.cos(ang) * rr * s * ex;
    const ly = cy + Math.sin(ang) * rr * s * ey + bias * s;
    if (style.spread === 'spire' && Math.abs(lx - cx) > (0.06 + 0.40 * ((ly - y0) / s)) * s) continue;
    if (style.spread === 'airy' && rng.next() < 0.28) continue;

    // Higher, outer leaves catch the sky; inner ones fall into shadow.
    const lit = clamp01(0.35 + (1 - (ly - y0) / s) * 0.75 - rr * 0.25);
    const hue = style.hue[0] + rng.signed(style.hue[1]);
    const sat = style.sat[0] + rng.next() * style.sat[1];
    const light = style.light[0] + lit * style.light[1];
    c.fillStyle = `hsl(${hue}, ${sat}%, ${light}%)`;

    const len = s * (style.len[0] + rng.next() * style.len[1]);
    c.save();
    c.translate(lx, ly);
    if (style.leaf === 'needle') {
      // Needle sprays hang off a shoot, so they share one direction per cluster.
      c.rotate(Math.atan2(ly - cy, lx - cx) + rng.signed(0.5));
      c.beginPath();
      c.ellipse(0, 0, len * 1.5, len * style.aspect, 0, 0, Math.PI * 2);
      c.fill();
    } else {
      c.rotate(rng.next() * Math.PI * 2);
      c.beginPath();
      c.ellipse(0, 0, len, len * (style.aspect + rng.next() * 0.20), 0, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }
  c.restore();
}

/**
 * Trackside LED panel faces, one per V band.
 *
 * The previous atlas was random blocks of saturated colour, and at any distance a panel
 * of pure channel colour with nothing drawn on it reads as an untextured debug material
 * — which is what the review called it. Real boards carry a wordmark on a dark field
 * with the pixel pitch visible, so that is what these carry.
 */
export function buildLedPanels(width = 512, rowH = 96, seed = 7743) {
  const rows = SPONSORS.length;
  const heightPx = rowH * rows;
  const canvas = createCanvas(width, heightPx);
  const c = canvas.getContext('2d', { willReadFrequently: true });
  const rng = new Rng(seed);
  const bezel = Math.max(2, Math.round(rowH * 0.10));

  for (let r = 0; r < rows; r++) {
    const s = SPONSORS[r];
    const y0 = r * rowH;
    c.fillStyle = '#000000';
    c.fillRect(0, y0, width, rowH);

    const ay = y0 + bezel;
    const ah = rowH - bezel * 2;
    // A panel is nearly black between the diodes; the field is a deep wash, never a
    // flat fill, or the bloom around it goes to one hue and it reads as a light box.
    const g = c.createLinearGradient(0, ay, width, ay + ah);
    g.addColorStop(0, shadeHex(s.bg, 0.34));
    g.addColorStop(1, shadeHex(s.bg, 0.16));
    c.fillStyle = g;
    c.fillRect(0, ay, width, ah);

    c.fillStyle = s.accent;
    c.fillRect(0, ay, width, Math.max(1, ah * 0.055));
    c.fillRect(0, ay + ah - Math.max(1, ah * 0.055), width, Math.max(1, ah * 0.055));

    const size = fitText(c, s.name, ah * 0.52, width * 0.72, 'bold', 0.10);
    c.fillStyle = s.fg;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = `bold ${Math.round(size)}px ${SANS}`;
    if ('letterSpacing' in c) c.letterSpacing = `${Math.round(size * 0.10)}px`;
    c.fillText(s.name, width * 0.5, ay + ah * 0.5);
    if ('letterSpacing' in c) c.letterSpacing = '0px';
    drawSponsorMark(c, s.accent, width * 0.085, ay + ah * 0.5, ah * 0.26, s.mark);
    drawSponsorMark(c, s.accent, width * 0.915, ay + ah * 0.5, ah * 0.26, s.mark);
  }

  const { data } = readCanvas(canvas);
  for (let y = 0; y < heightPx; y++) {
    const rv = ((y + 0.5) / rowH) % 1;
    const dark = rv < 0.10 || rv > 0.90 ? 0.06 : 1;
    for (let x = 0; x < width; x++) {
      const j = (y * width + x) * 4;
      // The pixel pitch itself: without the dark grid an LED board is a flat card.
      const grid = (x % 3 === 0 || y % 3 === 0) ? 0.42 : 1;
      const k = dark * grid * (0.90 + 0.20 * rng.next());
      data[j] = Math.min(255, data[j] * k);
      data[j + 1] = Math.min(255, data[j + 1] * k);
      data[j + 2] = Math.min(255, data[j + 2] * k);
      data[j + 3] = 255;
    }
  }
  return { width, height: heightPx, color: data, rows };
}
