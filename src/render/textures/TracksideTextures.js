import {
  Noise,
  WorleyGrid,
  createField,
  normalFromHeight,
  aoFromHeight,
  fbmField,
  ridgedField,
  createCanvas,
  readCanvas,
  mipChain,
  clamp01,
  mix,
  smoothstep
} from "./NoiseTextures.js";
import { Rng } from "../../core/Rng.js";
const CROWD_SHIRTS = [
  "#8a4a40",
  "#a9714c",
  "#c0a068",
  "#d3cabc",
  "#8e99a6",
  "#4f6377",
  "#37424e",
  "#5f6f5b",
  "#7b7e85",
  "#96876e",
  "#6a5a70",
  "#b4ada0",
  "#414852",
  "#77424a",
  "#57696c",
  "#c2b8a4",
  "#2f3a44",
  "#9aa2a8"
];
const CROWD_ACCENTS = ["#b03a2e", "#cf7a2a", "#2f5f9e", "#c9a227", "#3f7d54"];
const CROWD_SKIN = ["#e6bd97", "#d3a276", "#b07d52", "#8b5c37", "#6a4325", "#f0d3b4"];
const CROWD_HAIR = ["#221a13", "#3a2a1c", "#6a4c2c", "#12100f", "#8b7a5e", "#585552"];
export const CROWD_CELL_W = 2.1;
export const CROWD_CELL_H = 1.55;
const CROWD_SEAT_PITCH = 0.7;
const CROWD_SEAT_BACK = 0.6;
export function buildCrowdAtlas(size = 1024, cols = 4, rows = 4, seed = 90210) {
  const canvas = createCanvas(size, size);
  const c = canvas.getContext("2d", { willReadFrequently: true });
  c.clearRect(0, 0, size, size);
  const rng = new Rng(seed);
  const cw = size / cols;
  const ch = size / rows;
  const cells = cols * rows;
  for (let k = 0; k < cells; k++) {
    const x0 = k % cols * cw;
    const y0 = Math.floor(k / cols) * ch;
    c.save();
    c.beginPath();
    c.rect(x0, y0, cw, ch);
    c.clip();
    const occupancy = k === cells - 1 ? 0 : k === 5 || k === cells - 2 ? 1 : k % 7 === 3 ? 2 : 3;
    drawCrowdCell(c, x0, y0, cw, ch, occupancy, rng);
    c.restore();
  }
  const { data, width, height } = readCanvas(canvas);
  return {
    width,
    height,
    color: data,
    cols,
    rows,
    tileU: CROWD_CELL_W,
    tileV: CROWD_CELL_H
  };
}
function shadeHex(hex, k) {
  const v = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round((v >> 16 & 255) * k)));
  const g = Math.max(0, Math.min(255, Math.round((v >> 8 & 255) * k)));
  const b = Math.max(0, Math.min(255, Math.round((v & 255) * k)));
  return `rgb(${r},${g},${b})`;
}
function drawCrowdCell(c, x0, y0, cw, ch, occupancy, rng) {
  const px = cw / CROWD_CELL_W;
  const py = ch / CROWD_CELL_H;
  const X = (m) => x0 + m * px;
  const Y = (m) => y0 + ch - m * py;
  const deckTop = Y(CROWD_SEAT_BACK);
  const deckH = Y(0) - deckTop;
  const bench = c.createLinearGradient(0, deckTop, 0, Y(0));
  bench.addColorStop(0, "#242a32");
  bench.addColorStop(0.35, "#171b21");
  bench.addColorStop(1, "#0c0f13");
  c.fillStyle = bench;
  c.fillRect(x0, deckTop, cw, deckH);
  c.fillStyle = "rgba(74,82,94,0.55)";
  for (let s = 0; s <= 3; s++) {
    c.fillRect(X(s * CROWD_SEAT_PITCH) - px * 0.012, deckTop, Math.max(1, px * 0.024), deckH * 0.72);
  }
  c.fillStyle = "rgba(104,112,124,0.45)";
  c.fillRect(x0, deckTop, cw, Math.max(1, py * 0.022));
  const order = [1, 0, 2];
  const taken = [false, false, false];
  for (let i = 0; i < occupancy; i++) taken[order[i]] = true;
  for (let s = 0; s < 3; s++) {
    const m = CROWD_SEAT_PITCH * (s + 0.5);
    if (taken[s]) drawSpectator(c, X, Y, px, py, m, rng);
    else drawEmptySeat(c, X, Y, px, py, m);
  }
  const ao = c.createLinearGradient(0, Y(1.25), 0, Y(0.2));
  ao.addColorStop(0, "rgba(0,0,0,0)");
  ao.addColorStop(1, "rgba(0,0,0,0.34)");
  c.globalCompositeOperation = "source-atop";
  c.fillStyle = ao;
  c.fillRect(x0, y0, cw, ch);
  c.globalCompositeOperation = "source-over";
}
function drawEmptySeat(c, X, Y, px, py, m) {
  const half = CROWD_SEAT_PITCH * 0.38;
  c.fillStyle = "#2a303a";
  c.fillRect(X(m - half), Y(0.7), half * 2 * px, Y(0.46) - Y(0.7));
  c.fillStyle = "#39414c";
  c.fillRect(X(m - half), Y(0.7), half * 2 * px, Math.max(1, py * 0.03));
}
function torsoPath(c, X, Y, m, width, yLow, yHigh) {
  const hw = width * 0.5;
  c.beginPath();
  c.moveTo(X(m - hw * 0.9), Y(yLow));
  c.lineTo(X(m - hw), Y(yHigh - 0.1));
  c.quadraticCurveTo(X(m - hw), Y(yHigh), X(m - hw * 0.5), Y(yHigh));
  c.lineTo(X(m + hw * 0.5), Y(yHigh));
  c.quadraticCurveTo(X(m + hw), Y(yHigh), X(m + hw), Y(yHigh - 0.1));
  c.lineTo(X(m + hw * 0.9), Y(yLow));
  c.closePath();
}
function drawSpectator(c, X, Y, px, py, m, rng) {
  const accent = rng.next() < 0.14;
  const pool = accent ? CROWD_ACCENTS : CROWD_SHIRTS;
  const shirtHex = pool[Math.floor(rng.next() * pool.length)];
  const shirt = shadeHex(shirtHex, 0.78 + rng.next() * 0.3);
  const skin = shadeHex(CROWD_SKIN[Math.floor(rng.next() * CROWD_SKIN.length)], 0.84 + rng.next() * 0.22);
  const hair = CROWD_HAIR[Math.floor(rng.next() * CROWD_HAIR.length)];
  const shoulder = 0.42 + rng.next() * 0.06;
  const seatY = 0.58;
  const shoulderY = 1 + rng.signed(0.035);
  const headR = 0.098 + rng.next() * 0.012;
  const headY = shoulderY + headR * 1.35;
  const arms = rng.next();
  const stroke = (px + py) * 0.5;
  c.fillStyle = "rgba(10,12,15,0.86)";
  torsoPath(c, X, Y, m, shoulder * 1.1, seatY - 0.05, shoulderY + 0.025);
  c.fill();
  c.beginPath();
  c.ellipse(X(m), Y(headY), headR * 1.16 * px, headR * 1.16 * py, 0, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = shadeHex("#20242b", 0.9 + rng.next() * 0.35);
  c.fillRect(X(m - shoulder * 0.44), Y(0.63), shoulder * 0.88 * px, Y(0.52) - Y(0.63));
  c.fillStyle = shirt;
  torsoPath(c, X, Y, m, shoulder, seatY, shoulderY);
  c.fill();
  const lit = c.createLinearGradient(0, Y(shoulderY), 0, Y(shoulderY - 0.22));
  lit.addColorStop(0, "rgba(255,255,255,0.16)");
  lit.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = lit;
  torsoPath(c, X, Y, m, shoulder, seatY, shoulderY);
  c.fill();
  c.strokeStyle = shirt;
  c.lineCap = "round";
  c.lineWidth = stroke * 0.082;
  c.beginPath();
  if (arms > 0.9) {
    c.moveTo(X(m - shoulder * 0.4), Y(shoulderY - 0.05));
    c.lineTo(X(m - shoulder * 0.62), Y(shoulderY + 0.17));
    c.moveTo(X(m + shoulder * 0.4), Y(shoulderY - 0.05));
    c.lineTo(X(m + shoulder * 0.62), Y(shoulderY + 0.17));
  } else if (arms > 0.55) {
    c.moveTo(X(m - shoulder * 0.44), Y(shoulderY - 0.06));
    c.lineTo(X(m - shoulder * 0.2), Y(shoulderY - 0.26));
    c.moveTo(X(m + shoulder * 0.44), Y(shoulderY - 0.06));
    c.lineTo(X(m + shoulder * 0.2), Y(shoulderY - 0.26));
  } else {
    c.moveTo(X(m - shoulder * 0.46), Y(shoulderY - 0.06));
    c.lineTo(X(m - shoulder * 0.52), Y(shoulderY - 0.3));
    c.moveTo(X(m + shoulder * 0.46), Y(shoulderY - 0.06));
    c.lineTo(X(m + shoulder * 0.52), Y(shoulderY - 0.3));
  }
  c.stroke();
  if (arms > 0.9) {
    c.strokeStyle = skin;
    c.lineWidth = stroke * 0.052;
    c.beginPath();
    c.moveTo(X(m - shoulder * 0.62), Y(shoulderY + 0.17));
    c.lineTo(X(m - shoulder * 0.66), Y(shoulderY + 0.25));
    c.moveTo(X(m + shoulder * 0.62), Y(shoulderY + 0.17));
    c.lineTo(X(m + shoulder * 0.66), Y(shoulderY + 0.25));
    c.stroke();
  }
  c.fillStyle = skin;
  c.fillRect(
    X(m - headR * 0.36),
    Y(shoulderY + headR * 0.5),
    headR * 0.72 * px,
    Y(shoulderY - 0.02) - Y(shoulderY + headR * 0.5)
  );
  c.beginPath();
  c.ellipse(X(m), Y(headY), headR * px, headR * py, 0, 0, Math.PI * 2);
  c.fill();
  const headwear = rng.next();
  if (headwear > 0.58) {
    c.fillStyle = shadeHex(
      CROWD_ACCENTS[Math.floor(rng.next() * CROWD_ACCENTS.length)],
      0.72 + rng.next() * 0.26
    );
    c.beginPath();
    c.ellipse(
      X(m),
      Y(headY + headR * 0.1),
      headR * 1.03 * px,
      headR * 1.03 * py,
      0,
      Math.PI,
      Math.PI * 2
    );
    c.fill();
    c.beginPath();
    c.ellipse(
      X(m + headR * 0.6),
      Y(headY + headR * 0.16),
      headR * 0.82 * px,
      headR * 0.24 * py,
      0,
      0,
      Math.PI * 2
    );
    c.fill();
  } else {
    c.fillStyle = hair;
    c.beginPath();
    c.ellipse(
      X(m),
      Y(headY + headR * 0.12),
      headR * 0.99 * px,
      headR * 0.99 * py,
      0,
      Math.PI * 1.04,
      Math.PI * 1.96
    );
    c.fill();
  }
}
export function buildGrandstand(size = 512, seed = 1818) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const ribs = 10;
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
      const rib = smoothstep(0.1, 0.26, fr) * smoothstep(0.62, 0.46, fr);
      const ribIdx = Math.floor(rp);
      const boltRow = Math.abs(v * 6 - Math.round(v * 6)) / 6 * size;
      const bolt = ribIdx % 3 === 0 ? clamp01(1 - Math.hypot((fr - 0.36) * size / ribs, boltRow) / 2.6) : 0;
      const dirt = dirtF[i];
      const streak = clamp01(streakF[i] * 1.4 - 0.35) * smoothstep(1, 0.2, v);
      const grain = grainF[i];
      hf[i] = 0.42 + rib * 0.44 + bolt * 0.22 + grain * 0.03;
      const lift = 0.9 + rib * 0.18 + grain * 0.06 + dirt * 0.05;
      let r = 166 * lift, g = 172 * lift, b = 180 * lift;
      r = mix(r, 92, streak * 0.45);
      g = mix(g, 94, streak * 0.45);
      b = mix(b, 93, streak * 0.42);
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;
      orm[j + 1] = clamp01(0.52 + streak * 0.3 + grain * 0.05 - rib * 0.05) * 255;
      orm[j + 2] = clamp01(0.55 - streak * 0.45) * 255;
      orm[j + 3] = 255;
    }
  }
  const ao = aoFromHeight(hf, size, size, 5, 1.1);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, size, size, 2);
  return { width: size, height: size, color, normal, orm, tileU: 3, tileV: 3 };
}
const SPONSORS = [
  { name: "VELOCE", tag: "PERFORMANCE FLUIDS", bg: "#d81f36", fg: "#fffaf6", accent: "#ffc843", mark: "chevron", layout: "markLeft" },
  { name: "AERONIX", tag: "FLIGHT SYSTEMS", bg: "#f3f5f8", fg: "#123561", accent: "#0f8ad2", mark: "ring", layout: "split" },
  { name: "KRATOS", tag: "INDUSTRIAL TOOLING", bg: "#1a1c20", fg: "#f6f5f0", accent: "#f0a81e", mark: "bar", layout: "stripe" },
  { name: "NOVABANK", tag: "PRIVATE WEALTH", bg: "#edebe4", fg: "#14345c", accent: "#c8952a", mark: "ring", layout: "markLeft" },
  { name: "HELIX", tag: "BIOSCIENCE", bg: "#15a289", fg: "#ffffff", accent: "#0a4b41", mark: "helix", layout: "repeat" },
  { name: "ZENTARA", tag: "CLOUD PLATFORM", bg: "#6a3fc0", fg: "#ffffff", accent: "#c7b0ff", mark: "bar", layout: "split" },
  { name: "ORBITAL", tag: "SATELLITE DATA", bg: "#e0ddd6", fg: "#1c1d20", accent: "#d8452c", mark: "ring", layout: "stripe" },
  { name: "PULSAR", tag: "ENERGY DRINK", bg: "#f2801c", fg: "#16130e", accent: "#16130e", mark: "chevron", layout: "repeat" }
];
const SPONSOR_FRAME_BAND = 0.11;
export function buildSponsorBoards(width = 2048, heightPx = 2048, seed = 4747) {
  const rows = SPONSORS.length;
  const rowH = heightPx / rows;
  const canvas = createCanvas(width, heightPx);
  const c = canvas.getContext("2d", { willReadFrequently: true });
  const rng = new Rng(seed);
  for (let r = 0; r < rows; r++) {
    const s = SPONSORS[r];
    const y0 = r * rowH;
    const fh = rowH * SPONSOR_FRAME_BAND;
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
    const rv = v * rows % 1;
    const frame = rv < SPONSOR_FRAME_BAND || rv > 1 - SPONSOR_FRAME_BAND;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const i = y * width + x;
      const j = i * 4;
      const grime = grimeF[i];
      const dust = clamp01(smoothstep(0.28, SPONSOR_FRAME_BAND, rv) * 0.8 + grime * 0.2);
      const slack = frame ? 0 : Math.sin(rv * Math.PI) * Math.sin(u * Math.PI * 6) * 0.12;
      const edge = clamp01(1 - Math.min(rv, 1 - rv) * 26);
      hf[i] = 0.5 + slack + grime * 0.03 - edge * 0.35;
      data[j] = Math.max(0, Math.min(255, data[j] * (1 - dust * 0.24) + dust * 22));
      data[j + 1] = Math.max(0, Math.min(255, data[j + 1] * (1 - dust * 0.24) + dust * 20));
      data[j + 2] = Math.max(0, Math.min(255, data[j + 2] * (1 - dust * 0.24) + dust * 17));
      orm[j] = 255;
      orm[j + 1] = frame ? clamp01(0.34 + grime * 0.08) * 255 : clamp01(0.4 + dust * 0.36 + grime * 0.06) * 255;
      orm[j + 2] = frame ? 210 : 0;
      orm[j + 3] = 255;
    }
  }
  const ao = aoFromHeight(hf, width, heightPx, 4, 0.9);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, width, heightPx, 0.9);
  return {
    width,
    height: heightPx,
    color: data,
    normal,
    orm,
    rows,
    frameBand: SPONSOR_FRAME_BAND,
    tileU: 8,
    tileV: 1
  };
}
function drawBoardFrame(c, y0, rowH, fh, width) {
  const g = c.createLinearGradient(0, y0, 0, y0 + fh);
  g.addColorStop(0, "#5c6169");
  g.addColorStop(0.5, "#878d96");
  g.addColorStop(1, "#3d4148");
  c.fillStyle = g;
  c.fillRect(0, y0, width, fh);
  const g2 = c.createLinearGradient(0, y0 + rowH - fh, 0, y0 + rowH);
  g2.addColorStop(0, "#3d4148");
  g2.addColorStop(0.5, "#6f747c");
  g2.addColorStop(1, "#2a2d32");
  c.fillStyle = g2;
  c.fillRect(0, y0 + rowH - fh, width, fh);
  c.fillStyle = "rgba(20,22,26,0.55)";
  for (let k = 0; k < 14; k++) {
    const x = (k + 0.5) / 14 * width;
    c.fillRect(x - fh * 0.09, y0 + fh * 0.3, fh * 0.18, fh * 0.4);
    c.fillRect(x - fh * 0.09, y0 + rowH - fh * 0.7, fh * 0.18, fh * 0.4);
  }
  c.fillStyle = "rgba(0,0,0,0.75)";
  c.fillRect(0, y0, width, Math.max(1, rowH * 6e-3));
  c.fillRect(0, y0 + rowH - Math.max(1, rowH * 6e-3), width, Math.max(1, rowH * 6e-3));
}
const SANS = 'system-ui, "Helvetica Neue", Helvetica, Arial, sans-serif';
function fitText(c, text, px, maxW, weight = "bold", tracking = 0) {
  let size = px;
  for (let i = 0; i < 12; i++) {
    c.font = `${weight} ${Math.round(size)}px ${SANS}`;
    if ("letterSpacing" in c) c.letterSpacing = `${Math.round(size * tracking)}px`;
    if (c.measureText(text).width <= maxW) break;
    size *= 0.9;
  }
  return size;
}
function drawSponsorArt(c, s, width, ay, ah, rng) {
  c.fillStyle = s.bg;
  c.fillRect(0, ay, width, ah);
  if (s.layout === "split") {
    const panel = width * 0.17;
    c.fillStyle = s.accent;
    c.beginPath();
    c.moveTo(0, ay);
    c.lineTo(panel, ay);
    c.lineTo(panel - ah * 0.34, ay + ah);
    c.lineTo(0, ay + ah);
    c.closePath();
    c.fill();
    drawSponsorMark(c, s.fg, panel * 0.44, ay + ah * 0.5, ah * 0.3, s.mark);
    drawWordmark(c, s, panel + (width - panel) * 0.5, ay + ah * 0.5, (width - panel) * 0.72, ah);
  } else if (s.layout === "stripe") {
    c.save();
    c.globalAlpha = 0.16;
    c.fillStyle = s.accent;
    const rake = ah * 0.55;
    for (let k = 0; k < 26; k++) {
      const x = k / 26 * (width + rake * 2) - rake;
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
    drawSponsorMark(c, s.accent, width * 0.1, ay + ah * 0.5, ah * 0.32, s.mark);
    drawSponsorMark(c, s.accent, width * 0.9, ay + ah * 0.5, ah * 0.32, s.mark);
  } else if (s.layout === "repeat") {
    const cell = width / 4;
    for (let k = 0; k < 4; k++) {
      if (k & 1) {
        c.fillStyle = "rgba(0,0,0,0.13)";
        c.fillRect(k * cell, ay, cell, ah);
      }
      drawSponsorMark(c, s.accent, k * cell + cell * 0.16, ay + ah * 0.5, ah * 0.26, s.mark);
      const size = fitText(c, s.name, ah * 0.4, cell * 0.62, "bold", 0.05);
      c.fillStyle = s.fg;
      c.textAlign = "left";
      c.textBaseline = "middle";
      c.font = `bold ${Math.round(size)}px ${SANS}`;
      c.fillText(s.name, k * cell + cell * 0.3, ay + ah * 0.5);
      if ("letterSpacing" in c) c.letterSpacing = "0px";
    }
  } else {
    c.fillStyle = s.accent;
    c.fillRect(0, ay, width * 0.028, ah);
    drawSponsorMark(c, s.accent, width * 0.1, ay + ah * 0.5, ah * 0.34, s.mark);
    c.fillStyle = s.fg;
    c.globalAlpha = 0.35;
    c.fillRect(width * 0.165, ay + ah * 0.18, Math.max(2, width * 25e-4), ah * 0.64);
    c.globalAlpha = 1;
    drawWordmark(c, s, width * 0.55, ay + ah * 0.46, width * 0.62, ah, "centre");
  }
  const g = c.createLinearGradient(0, ay, width, ay + ah);
  g.addColorStop(0, "rgba(255,255,255,0.09)");
  g.addColorStop(0.55, "rgba(255,255,255,0.0)");
  g.addColorStop(1, "rgba(0,0,0,0.15)");
  c.fillStyle = g;
  c.fillRect(0, ay, width, ah);
  c.fillStyle = "rgba(255,255,255,0.05)";
  for (let k = 0; k < 6; k++) {
    const x = rng.next() * width;
    const y = ay + rng.next() * ah;
    c.fillRect(x, y, width * (0.01 + rng.next() * 0.05), ah * 0.02);
  }
}
function drawWordmark(c, s, cx, cy, maxW, ah) {
  const size = fitText(c, s.name, ah * 0.62, maxW, "800", 0.06);
  c.fillStyle = s.fg;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.font = `800 ${Math.round(size)}px ${SANS}`;
  if ("letterSpacing" in c) c.letterSpacing = `${Math.round(size * 0.06)}px`;
  c.fillText(s.name, cx, cy - ah * 0.1);
  const tagSize = fitText(c, s.tag, ah * 0.155, maxW * 0.78, "500", 0.28);
  c.globalAlpha = 0.78;
  c.font = `500 ${Math.round(tagSize)}px ${SANS}`;
  if ("letterSpacing" in c) c.letterSpacing = `${Math.round(tagSize * 0.28)}px`;
  c.fillText(s.tag, cx, cy + ah * 0.3);
  c.globalAlpha = 1;
  if ("letterSpacing" in c) c.letterSpacing = "0px";
}
function drawSponsorMark(c, colour, cx, cy, r, kind) {
  c.save();
  c.fillStyle = colour;
  c.strokeStyle = colour;
  c.lineWidth = r * 0.26;
  c.lineCap = "butt";
  if (kind === "ring") {
    c.beginPath();
    c.arc(cx, cy, r * 0.8, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.arc(cx, cy, r * 0.26, 0, Math.PI * 2);
    c.fill();
  } else if (kind === "chevron") {
    c.beginPath();
    c.moveTo(cx - r * 0.7, cy + r * 0.6);
    c.lineTo(cx, cy - r * 0.6);
    c.lineTo(cx + r * 0.7, cy + r * 0.6);
    c.lineTo(cx + r * 0.28, cy + r * 0.6);
    c.lineTo(cx, cy - r * 0.02);
    c.lineTo(cx - r * 0.28, cy + r * 0.6);
    c.closePath();
    c.fill();
  } else if (kind === "helix") {
    for (let side = -1; side <= 1; side += 2) {
      c.beginPath();
      for (let k = 0; k <= 20; k++) {
        const t = k / 20;
        const x = cx + Math.sin(t * Math.PI * 2) * r * 0.55 * side;
        const y = cy - r * 0.85 + t * r * 1.7;
        if (k === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
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
        const bay = u * 4;
        const fb = bay - Math.floor(bay);
        const pier = clamp01(1 - Math.min(fb, 1 - fb) * 5.5);
        const slat = Math.abs(v * 34 % 1 - 0.5) * 2;
        const slatH = smoothstep(0.9, 0.25, slat);
        height = 0.42 + slatH * 0.14 + pier * 0.3;
        const door = 1 - pier;
        r = mix(184, 142, door) * (0.92 + slatH * 0.14);
        g = mix(182, 146, door) * (0.92 + slatH * 0.14);
        b = mix(178, 152, door) * (0.92 + slatH * 0.14);
        rough = mix(0.72, 0.42, door);
        metal = door * 0.85;
      } else if (v < 0.5) {
        const numBand = smoothstep(0.44, 0.455, v) * smoothstep(0.49, 0.475, v);
        height = 0.62 + numBand * 0.06;
        r = mix(42, 216, numBand * 0.15) + grain * 8;
        g = mix(44, 216, numBand * 0.15) + grain * 8;
        b = mix(49, 216, numBand * 0.15) + grain * 8;
        rough = 0.48;
        metal = 0.3;
      } else if (v < 0.86) {
        const mull = clamp01(1 - Math.abs(u * 22 % 1 - 0.5) * 2 * 9);
        const transom = clamp01(1 - Math.abs(v * 9 % 1 - 0.5) * 2 * 11);
        const frame = Math.max(mull, transom);
        const pane = smoothstep(0.5, 0.86, v);
        const refl = 0.28 + pane * 0.55 + grime * 0.1;
        height = 0.55 + frame * 0.22;
        r = mix(39 + refl * 90, 180, frame);
        g = mix(51 + refl * 105, 184, frame);
        b = mix(66 + refl * 120, 188, frame);
        rough = mix(0.06, 0.38, frame);
        metal = mix(0.15, 0.9, frame);
      } else {
        const cap = smoothstep(0.86, 0.9, v);
        height = 0.58 + cap * 0.24;
        r = 154 + grain * 10;
        g = 158 + grain * 10;
        b = 164 + grain * 10;
        rough = 0.44;
        metal = 0.75;
      }
      const streak = clamp01(streakF[i] * 1.3 - 0.5) * 0.3;
      r = mix(r, 96, streak);
      g = mix(g, 98, streak);
      b = mix(b, 99, streak);
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
  return { width: size, height: size, color, normal, orm, tileU: 24, tileV: 12 };
}
export function buildTyreWall(size = 512, seed = 7373) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const perishF = ridgedField(noise, size, size, 22, 22, 3, 2.2, 0.5, 1);
  const grainF = fbmField(noise, size, size, 170, 170, 2, 2.3, 0.5);
  const bloomF = fbmField(noise, size, size, 7, 7, 4, 2, 0.55);
  const scuffF = fbmField(new Noise(seed + 53), size, size, 4, 40, 3, 2.4, 0.5);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const crack = clamp01((perishF[i] - 0.72) * 4.5);
      const grain = grainF[i];
      const bloom = clamp01(bloomF[i] * 1.2 + 0.25);
      const scuff = clamp01(scuffF[i] * 1.5 - 0.7);
      hf[i] = 0.55 - crack * 0.42 + grain * 0.07;
      const base = 27 + grain * 9;
      let r = mix(base, 85, bloom * 0.42);
      let g = mix(base, 82, bloom * 0.42);
      let b = mix(base + 2, 77, bloom * 0.38);
      r = mix(r, 13, crack * 0.7);
      g = mix(g, 13, crack * 0.7);
      b = mix(b, 14, crack * 0.7);
      r = mix(r, 156, scuff * 0.35);
      g = mix(g, 153, scuff * 0.35);
      b = mix(b, 146, scuff * 0.35);
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;
      orm[j + 1] = clamp01(0.9 + bloom * 0.06 + crack * 0.05 - scuff * 0.1) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }
  const ao = aoFromHeight(hf, size, size, 4, 1.3);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, size, size, 2);
  return { width: size, height: size, color, normal, orm, tileU: 0.7, tileV: 0.7 };
}
export function buildArmco(width = 512, heightPx = 256, seed = 5959) {
  const n = width * heightPx;
  const noise = new Noise(seed);
  const spangle = new WorleyGrid(52, 26, seed + 3, 1);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(width, heightPx);
  const scratchF = ridgedField(noise, width, heightPx, 4, 60, 3, 2.2, 0.5, 1);
  const grainF = fbmField(noise, width, heightPx, 190, 95, 2, 2.3, 0.5);
  const rustF = fbmField(new Noise(seed + 67), width, heightPx, 9, 9, 4, 2.1, 0.5);
  for (let y = 0; y < heightPx; y++) {
    const v = (y + 0.5) / heightPx;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const i = y * width + x;
      const s = spangle.query(u, v);
      const facet = clamp01(1 - s.f2 + s.f1);
      const tiltX = s.dx * 0.6;
      const tiltY = s.dy * 0.6;
      const scratch = clamp01(scratchF[i] - 0.8) * 5;
      const grain = grainF[i];
      const boltU = Math.abs(u * 2 - Math.round(u * 2)) / 2 * width;
      const boltV = Math.abs(v - 0.5) * heightPx;
      const bolt = clamp01(1 - Math.hypot(boltU, boltV) / (width * 0.026));
      hf[i] = 0.5 + (tiltX + tiltY) * 0.1 + facet * 0.05 + scratch * 0.2 + bolt * 0.45 + grain * 0.03;
      const lift = 0.9 + facet * 0.16 + s.id * 0.1 + scratch * 0.18 + grain * 0.05;
      const rust = clamp01(rustF[i] * 1.2 - 0.62);
      let r = 176 * lift, g = 182 * lift, b = 187 * lift;
      r = mix(r, 138, rust * 0.8);
      g = mix(g, 92, rust * 0.8);
      b = mix(b, 58, rust * 0.8);
      const grime = clamp01(smoothstep(0.34, 0, v) * 0.55 + bolt * 0.4 + grain * 0.15);
      r = mix(r, 94, grime * 0.45);
      g = mix(g, 92, grime * 0.45);
      b = mix(b, 87, grime * 0.42);
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;
      orm[j + 1] = clamp01(0.4 + facet * 0.14 + rust * 0.42 - scratch * 0.08 + grain * 0.05 + grime * 0.25) * 255;
      orm[j + 2] = clamp01(0.95 - rust * 0.7 - grime * 0.35) * 255;
      orm[j + 3] = 255;
    }
  }
  const ao = aoFromHeight(hf, width, heightPx, 4, 0.9);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, width, heightPx, 1.6);
  return { width, height: heightPx, color, normal, orm, tileU: 6, tileV: 0.48 };
}
export function buildDebrisFence(size = 512, seed = 3131) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const apertures = 10;
  const halfWire = 315e-5 * 0.5 / 0.5;
  const grainF = fbmField(noise, size, size, 240, 240, 2, 2.3, 0.5);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;
      const a = (u + v) * apertures;
      const b = (u - v) * apertures;
      const da = Math.abs(a - Math.round(a)) / (apertures * 1.41421356);
      const db = Math.abs(b - Math.round(b)) / (apertures * 1.41421356);
      const inA = clamp01(1 - da / halfWire);
      const inB = clamp01(1 - db / halfWire);
      const cell = Math.floor(a) + Math.floor(b) & 1;
      const topWire = cell === 0 ? inA : inB;
      const botWire = cell === 0 ? inB : inA;
      const coverA = clamp01(1 - da / (halfWire * 1.55));
      const coverB = clamp01(1 - db / (halfWire * 1.55));
      const cover = clamp01(Math.max(coverA, coverB) * 1.15);
      const profile = Math.sqrt(Math.max(0, topWire)) * 1 + Math.sqrt(Math.max(0, botWire)) * 0.55;
      hf[i] = 0.35 + Math.min(1, profile) * 0.55;
      const grain = grainF[i];
      const shade = 0.72 + Math.min(1, profile) * 0.42 + grain * 0.08;
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, 154 * shade));
      color[j + 1] = Math.max(0, Math.min(255, 160 * shade));
      color[j + 2] = Math.max(0, Math.min(255, 166 * shade));
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
export function buildTreeBark(width = 256, heightPx = 512, seed = 8181) {
  const n = width * heightPx;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(width, heightPx);
  const fissureF = ridgedField(noise, width, heightPx, 26, 5, 4, 2.15, 0.5, 1);
  const plateF = fbmField(noise, width, heightPx, 9, 3, 4, 2.1, 0.55);
  const grainF = fbmField(noise, width, heightPx, 160, 60, 2, 2.3, 0.5);
  const mossF = fbmField(new Noise(seed + 29), width, heightPx, 5, 5, 3, 2, 0.5);
  for (let y = 0; y < heightPx; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const fissure = fissureF[i];
      const plate = plateF[i];
      const grain = grainF[i];
      const moss = clamp01(mossF[i] * 1.3 - 0.55);
      const depth = clamp01(1 - fissure);
      hf[i] = 0.62 - depth * 0.55 + plate * 0.1 + grain * 0.04;
      const lift = 0.72 + (1 - depth) * 0.55 + grain * 0.1 + plate * 0.1;
      let r = 106 * lift, g = 89 * lift, b = 69 * lift;
      r = mix(r, 30, depth * 0.55);
      g = mix(g, 24, depth * 0.55);
      b = mix(b, 18, depth * 0.55);
      r = mix(r, 76, moss * 0.35);
      g = mix(g, 99, moss * 0.35);
      b = mix(b, 51, moss * 0.35);
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
  const normal = normalFromHeight(hf, width, heightPx, 3);
  return { width, height: heightPx, color, normal, orm, tileU: 1.2, tileV: 2.4 };
}
export function buildTreeCanopy(size = 512, seed = 6464) {
  const canvas = createCanvas(size, size);
  const c = canvas.getContext("2d", { willReadFrequently: true });
  c.clearRect(0, 0, size, size);
  const rng = new Rng(seed);
  const cx = size * 0.5, cy = size * 0.52;
  const leaves = Math.round(size * 1.3);
  for (let k = 0; k < leaves; k++) {
    const rr = Math.pow(rng.next(), 0.62);
    const ang = rng.next() * Math.PI * 2;
    const lx = cx + Math.cos(ang) * rr * size * 0.46;
    const ly = cy + Math.sin(ang) * rr * size * 0.44;
    const lit = clamp01(0.35 + (1 - ly / size) * 0.75 - rr * 0.25);
    const hue = 88 + rng.signed(16);
    const sat = 34 + rng.next() * 26;
    const light = 14 + lit * 34;
    c.fillStyle = `hsl(${hue}, ${sat}%, ${light}%)`;
    const len = size * (0.028 + rng.next() * 0.03);
    c.save();
    c.translate(lx, ly);
    c.rotate(rng.next() * Math.PI * 2);
    c.beginPath();
    c.ellipse(0, 0, len, len * (0.36 + rng.next() * 0.2), 0, 0, Math.PI * 2);
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
    orm[j + 1] = 214;
    orm[j + 2] = 0;
    orm[j + 3] = 255;
  }
  const normal = normalFromHeight(hf, size, size, 1.8);
  return { width: size, height: size, color: data, normal, orm, tileU: 3, tileV: 3 };
}
export function buildMarshalPost(size = 256, seed = 2121) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const stripes = 6;
  const grainF = fbmField(noise, size, size, 180, 180, 2, 2.3, 0.5);
  const dirtF = fbmField(noise, size, size, 8, 8, 4, 2.1, 0.55);
  const dentF = fbmField(new Noise(seed + 11), size, size, 14, 14, 3, 2, 0.5);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;
      const s = (u + v) * stripes % 1;
      const band = smoothstep(0.48, 0.52, s);
      const grain = grainF[i];
      const dirt = clamp01(dirtF[i] * 1.2 - 0.35);
      const dent = dentF[i];
      hf[i] = 0.5 + dent * 0.1 + grain * 0.04;
      const lift = 0.94 + grain * 0.08 + dent * 0.05;
      let r = mix(230, 232, band) * lift;
      let g = mix(106, 230, band) * lift;
      let b = mix(20, 226, band) * lift;
      r = mix(r, 107, dirt * 0.42);
      g = mix(g, 102, dirt * 0.42);
      b = mix(b, 92, dirt * 0.42);
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;
      orm[j] = 255;
      orm[j + 1] = clamp01(0.55 + dirt * 0.3 + grain * 0.05) * 255;
      orm[j + 2] = clamp01(0.35 - dirt * 0.3) * 255;
      orm[j + 3] = 255;
    }
  }
  const normal = normalFromHeight(hf, size, size, 1);
  return { width: size, height: size, color, normal, orm, tileU: 1.2, tileV: 1.2 };
}
export function buildTunnelWall(size = 512, seed = 1414) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const panels = 3;
  const gritF = fbmField(noise, size, size, 150, 150, 2, 2.3, 0.5);
  const sootF = fbmField(noise, size, size, 12, 2, 4, 2.2, 0.55);
  const dampF = fbmField(new Noise(seed + 47), size, size, 5, 5, 4, 2, 0.55);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;
      const boardV = Math.abs(v * (panels * 4) - Math.round(v * (panels * 4))) / (panels * 4) * size;
      const board = clamp01(1 - boardV / 2);
      const jointU = Math.abs(u * panels - Math.round(u * panels)) / panels * size;
      const joint = clamp01(1 - jointU / 2.6);
      const tie = clamp01(1 - Math.hypot(
        Math.abs(u * (panels * 2) - Math.round(u * (panels * 2))) / (panels * 2) * size,
        Math.abs(v * 4 - Math.round(v * 4)) / 4 * size
      ) / 3);
      const grit = gritF[i];
      const soot = clamp01(sootF[i] * 1.2 + 0.35) * smoothstep(1, 0.15, v);
      const damp = clamp01(dampF[i] * 1.1 - 0.25);
      hf[i] = 0.58 - board * 0.25 - joint * 0.38 - tie * 0.55 + grit * 0.05;
      let r = 142 + grit * 16, g = 140 + grit * 16, b = 136 + grit * 15;
      r = mix(r, 36, soot * 0.62);
      g = mix(g, 35, soot * 0.62);
      b = mix(b, 36, soot * 0.6);
      r = mix(r, 74, damp * 0.35);
      g = mix(g, 77, damp * 0.35);
      b = mix(b, 74, damp * 0.35);
      const shadow = Math.max(board * 0.35, Math.max(joint, tie) * 0.6);
      r *= 1 - shadow * 0.4;
      g *= 1 - shadow * 0.4;
      b *= 1 - shadow * 0.4;
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, r));
      color[j + 1] = Math.max(0, Math.min(255, g));
      color[j + 2] = Math.max(0, Math.min(255, b));
      color[j + 3] = 255;
      orm[j + 1] = clamp01(0.86 - damp * 0.3 + grit * 0.05 + soot * 0.04) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }
  const ao = aoFromHeight(hf, size, size, 4, 1.2);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, size, size, 1.8);
  return { width: size, height: size, color, normal, orm, tileU: 6, tileV: 6 };
}
export const DISTANCE_MARKS = [200, 150, 100, 50];
export function buildDistanceBoards(width = 256, heightPx = 1024, seed = 6161) {
  const rows = DISTANCE_MARKS.length + 1;
  const rowH = heightPx / rows;
  const canvas = createCanvas(width, heightPx);
  const c = canvas.getContext("2d", { willReadFrequently: true });
  for (let i = 0; i < rows; i++) {
    const y0 = (rows - 1 - i) * rowH;
    c.fillStyle = "#0f1114";
    c.fillRect(0, y0, width, rowH);
    if (i >= DISTANCE_MARKS.length) {
      c.fillStyle = "#9aa0a6";
      c.fillRect(width * 0.06, y0 + rowH * 0.06, width * 0.88, rowH * 0.88);
      continue;
    }
    c.fillStyle = "#e9e6dd";
    c.fillRect(width * 0.06, y0 + rowH * 0.06, width * 0.88, rowH * 0.88);
    c.fillStyle = i === 0 ? "#c5312a" : "#16181c";
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.font = `bold ${Math.round(rowH * 0.52)}px system-ui, "Helvetica Neue", Arial, sans-serif`;
    c.fillText(String(DISTANCE_MARKS[i]), width * 0.5, y0 + rowH * 0.52);
    c.strokeStyle = "rgba(20,22,26,0.85)";
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
  return { width, height: heightPx, color: data, rows, tileU: 1, tileV: 1.2 };
}
export { SPONSORS };
const CUTOUT_SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  CUTOUT_SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function cutoutLinearToSrgbByte(c) {
  const v = c <= 31308e-7 ? c * 12.92 : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055;
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
    src = dst;
    sw = dw;
    sh = dh;
  }
  return levels;
}
function preserveCoverage(levels, alphaTest) {
  const coverageOf = (data, scale) => {
    let hit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] / 255 * scale >= alphaTest) hit++;
    return hit / (data.length / 4);
  };
  const target = coverageOf(levels[0].data, 1);
  if (target <= 0) return levels;
  for (let l = 1; l < levels.length; l++) {
    const data = levels[l].data;
    let lo = 1, hi = 8;
    if (coverageOf(data, hi) < target) {
      lo = hi;
    } else {
      for (let k = 0; k < 12; k++) {
        const mid = (lo + hi) * 0.5;
        if (coverageOf(data, mid) < target) lo = mid;
        else hi = mid;
      }
    }
    const scale = Math.min(8, hi);
    for (let i = 3; i < data.length; i += 4) {
      data[i] = Math.min(255, Math.round(data[i] * scale));
    }
  }
  return levels;
}
export const FENCE_ALPHA_TEST = 0.34;
export function buildCatchFence(size = 512, seed = 3131) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const apertures = 10;
  const texel = 1 / size;
  const halfWire = 46e-4 * 0.5 / 0.5;
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
      const inA = Math.sqrt(clamp01(1 - da / halfWire));
      const inB = Math.sqrt(clamp01(1 - db / halfWire));
      const cell = Math.floor(a) + Math.floor(b) & 1;
      const topWire = cell === 0 ? inA : inB;
      const botWire = cell === 0 ? inB : inA;
      const profile = Math.min(1, topWire + botWire * 0.55);
      const cover = Math.max(
        1 - smoothstep(coreEdge, softEdge, da),
        1 - smoothstep(coreEdge, softEdge, db)
      );
      hf[i] = 0.3 + profile * 0.62;
      const grain = grainF[i];
      const dirt = clamp01(0.5 + dirtF[i]);
      const shade = (0.62 + profile * 0.46 + grain * 0.07) * (1 - dirt * 0.26);
      const j = i * 4;
      color[j] = Math.max(0, Math.min(255, 182 * shade));
      color[j + 1] = Math.max(0, Math.min(255, 187 * shade));
      color[j + 2] = Math.max(0, Math.min(255, 194 * shade));
      color[j + 3] = Math.max(0, Math.min(255, cover * 255));
      orm[j] = Math.max(0, Math.min(255, (0.55 + profile * 0.45) * 255));
      orm[j + 1] = clamp01(0.34 + dirt * 0.22 + grain * 0.06) * 255;
      orm[j + 2] = 228;
      orm[j + 3] = 255;
    }
  }
  const normal = normalFromHeight(hf, size, size, 2.6);
  return {
    width: size,
    height: size,
    color,
    normal,
    orm,
    colorMips: veilMipChain(color, size, size),
    tileU: 0.5,
    tileV: 0.5
  };
}
export function buildAstroturfVerge(size = 512, seed = 7700) {
  const n = size * size;
  const noise = new Noise(seed);
  const color = new Uint8Array(n * 4);
  const orm = new Uint8Array(n * 4);
  const hf = createField(size, size);
  const pileF = fbmField(noise, size, size, 14, 300, 2, 2.4, 0.5);
  const fineF = fbmField(new Noise(seed + 13), size, size, 40, 460, 1, 2.2, 0.5);
  const wearF = fbmField(new Noise(seed + 29), size, size, 5, 3, 3, 2, 0.5);
  const dirtF = fbmField(new Noise(seed + 47), size, size, 11, 7, 3, 2.2, 0.5);
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    const seam = Math.max(
      clamp01(1 - Math.abs(v - 0.5) * 90),
      clamp01(1 - Math.min(v, 1 - v) * 90)
    );
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const i = y * size + x;
      const pile = pileF[i];
      const fine = fineF[i];
      const wear = clamp01(0.5 + wearF[i] * 1.2);
      const dirt = clamp01(0.5 + dirtF[i]);
      const rows = Math.sin(v * Math.PI * 2 * 75 + pile * 2.2);
      const comb = rows * rows;
      const drift = Math.sin(u * Math.PI * 2 * 3 + fine * 4) * 0.5 + 0.5;
      hf[i] = 0.5 + pile * 0.22 + fine * 0.14 + comb * 0.2 - seam * 0.45;
      const shade = 1 + pile * 0.24 + fine * 0.09 + (comb - 0.5) * 0.18 + (drift - 0.5) * 0.05;
      const r = mix(86, 116, wear);
      const g = mix(104, 129, wear);
      const b = mix(76, 105, wear);
      const rubber = clamp01((1 - dirt) * 0.55);
      const j = i * 4;
      const k = (1 - seam * 0.55) * shade;
      color[j] = Math.max(0, Math.min(255, mix(r, 60, rubber) * k));
      color[j + 1] = Math.max(0, Math.min(255, mix(g, 65, rubber) * k));
      color[j + 2] = Math.max(0, Math.min(255, mix(b, 58, rubber) * k));
      color[j + 3] = 255;
      orm[j] = 255;
      orm[j + 1] = clamp01(0.88 + pile * 0.06 - wear * 0.05) * 255;
      orm[j + 2] = 0;
      orm[j + 3] = 255;
    }
  }
  const ao = aoFromHeight(hf, size, size, 4, 1);
  for (let i = 0; i < n; i++) orm[i * 4] = Math.max(0, Math.min(255, ao[i] * 255));
  const normal = normalFromHeight(hf, size, size, 2.2);
  return {
    width: size,
    height: size,
    color,
    normal,
    orm,
    colorMips: mipChain(color, size, size, true),
    tileU: 1.5,
    tileV: 1.5
  };
}
export const CANOPY_ALPHA_TEST = 0.36;
export const CANOPY_ATLAS = { cols: 2, rows: 2 };
const CANOPY_STYLES = [
  { leaf: "needle", count: 3.4, hue: [112, 12], sat: [20, 12], light: [15, 15], len: [0.034, 0.02], aspect: 0.2, spread: "spire" },
  { leaf: "needle", count: 2.4, hue: [102, 14], sat: [22, 14], light: [16, 17], len: [0.04, 0.024], aspect: 0.24, spread: "open" },
  { leaf: "blob", count: 2.2, hue: [94, 16], sat: [24, 16], light: [17, 19], len: [0.032, 0.026], aspect: 0.62, spread: "round" },
  { leaf: "blob", count: 1.3, hue: [82, 20], sat: [26, 16], light: [20, 19], len: [0.028, 0.022], aspect: 0.7, spread: "airy" }
];
export function buildCanopyAtlas(size = 1024, seed = 6464) {
  const cell = size >> 1;
  const canvas = createCanvas(size, size);
  const c = canvas.getContext("2d", { willReadFrequently: true });
  c.clearRect(0, 0, size, size);
  for (let idx = 0; idx < 4; idx++) {
    const col = idx % 2;
    const row = idx >> 1;
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
    orm[j + 1] = 214;
    orm[j + 2] = 0;
    orm[j + 3] = 255;
  }
  const normal = normalFromHeight(hf, size, size, 1.8);
  return {
    width: size,
    height: size,
    color: data,
    normal,
    orm,
    colorMips: preserveCoverage(veilMipChain(data, size, size, true), CANOPY_ALPHA_TEST),
    cols: CANOPY_ATLAS.cols,
    rows: CANOPY_ATLAS.rows,
    tileU: 3,
    tileV: 3
  };
}
function drawCanopyCell(c, style, x0, y0, s, rng) {
  const cx = x0 + s * 0.5;
  const cy = y0 + s * 0.52;
  const leaves = Math.round(s * style.count);
  c.save();
  c.beginPath();
  c.rect(x0 + 2, y0 + 2, s - 4, s - 4);
  c.clip();
  for (let k = 0; k < leaves; k++) {
    let rr = Math.pow(rng.next(), 0.62);
    if (rr > 0.78) {
      if (rng.next() < (rr - 0.78) * 2.6) continue;
      rr *= 1 + rng.next() * 0.26;
    }
    const ang = rng.next() * Math.PI * 2;
    let ex = 0.46;
    let ey = 0.44;
    let bias = 0;
    if (style.spread === "spire") {
      ex = 0.2 + 0.3 * rr;
      ey = 0.48;
      bias = 0.06;
    } else if (style.spread === "open") {
      ex = 0.44;
      ey = 0.32;
      bias = -0.1;
    } else if (style.spread === "airy") {
      ex = 0.42;
      ey = 0.42;
    }
    const lx = cx + Math.cos(ang) * rr * s * ex;
    const ly = cy + Math.sin(ang) * rr * s * ey + bias * s;
    if (style.spread === "spire" && Math.abs(lx - cx) > (0.06 + 0.4 * ((ly - y0) / s)) * s) continue;
    if (style.spread === "airy" && rng.next() < 0.28) continue;
    const lit = clamp01(0.35 + (1 - (ly - y0) / s) * 0.75 - rr * 0.25);
    const hue = style.hue[0] + rng.signed(style.hue[1]);
    const sat = style.sat[0] + rng.next() * style.sat[1];
    const light = style.light[0] + lit * style.light[1];
    c.fillStyle = `hsl(${hue}, ${sat}%, ${light}%)`;
    const len = s * (style.len[0] + rng.next() * style.len[1]);
    c.save();
    c.translate(lx, ly);
    if (style.leaf === "needle") {
      c.rotate(Math.atan2(ly - cy, lx - cx) + rng.signed(0.5));
      c.beginPath();
      c.ellipse(0, 0, len * 1.5, len * style.aspect, 0, 0, Math.PI * 2);
      c.fill();
    } else {
      c.rotate(rng.next() * Math.PI * 2);
      c.beginPath();
      c.ellipse(0, 0, len, len * (style.aspect + rng.next() * 0.2), 0, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }
  c.restore();
}
export function buildLedPanels(width = 512, rowH = 96, seed = 7743) {
  const rows = SPONSORS.length;
  const heightPx = rowH * rows;
  const canvas = createCanvas(width, heightPx);
  const c = canvas.getContext("2d", { willReadFrequently: true });
  const rng = new Rng(seed);
  const bezel = Math.max(2, Math.round(rowH * 0.1));
  for (let r = 0; r < rows; r++) {
    const s = SPONSORS[r];
    const y0 = r * rowH;
    c.fillStyle = "#000000";
    c.fillRect(0, y0, width, rowH);
    const ay = y0 + bezel;
    const ah = rowH - bezel * 2;
    const g = c.createLinearGradient(0, ay, width, ay + ah);
    g.addColorStop(0, shadeHex(s.bg, 0.34));
    g.addColorStop(1, shadeHex(s.bg, 0.16));
    c.fillStyle = g;
    c.fillRect(0, ay, width, ah);
    c.fillStyle = s.accent;
    c.fillRect(0, ay, width, Math.max(1, ah * 0.055));
    c.fillRect(0, ay + ah - Math.max(1, ah * 0.055), width, Math.max(1, ah * 0.055));
    const size = fitText(c, s.name, ah * 0.52, width * 0.72, "bold", 0.1);
    c.fillStyle = s.fg;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.font = `bold ${Math.round(size)}px ${SANS}`;
    if ("letterSpacing" in c) c.letterSpacing = `${Math.round(size * 0.1)}px`;
    c.fillText(s.name, width * 0.5, ay + ah * 0.5);
    if ("letterSpacing" in c) c.letterSpacing = "0px";
    drawSponsorMark(c, s.accent, width * 0.085, ay + ah * 0.5, ah * 0.26, s.mark);
    drawSponsorMark(c, s.accent, width * 0.915, ay + ah * 0.5, ah * 0.26, s.mark);
  }
  const { data } = readCanvas(canvas);
  for (let y = 0; y < heightPx; y++) {
    const rv = (y + 0.5) / rowH % 1;
    const dark = rv < 0.1 || rv > 0.9 ? 0.06 : 1;
    for (let x = 0; x < width; x++) {
      const j = (y * width + x) * 4;
      const grid = x % 3 === 0 || y % 3 === 0 ? 0.42 : 1;
      const k = dark * grid * (0.9 + 0.2 * rng.next());
      data[j] = Math.min(255, data[j] * k);
      data[j + 1] = Math.min(255, data[j + 1] * k);
      data[j + 2] = Math.min(255, data[j + 2] * k);
      data[j + 3] = 255;
    }
  }
  return { width, height: heightPx, color: data, rows };
}
