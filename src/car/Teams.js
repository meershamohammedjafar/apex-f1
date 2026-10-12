import * as THREE from "three";
import { createCanvas, textureFromCanvas } from "../render/textures/NoiseTextures.js";
import { TEAM_LIVERIES } from "../render/MaterialLibrary.js";
import { Rng } from "../core/Rng.js";
export const BODY_V_FRONT = -2.62;
export const BODY_V_REAR = 3.01;
const SPONSOR_POOL = [
  "AXIOM",
  "NORTHWIND",
  "HELIOS",
  "CIRRUS",
  "VANTIS",
  "KRYON",
  "OBSIDIAN",
  "PULSAR",
  "TITANWORKS",
  "AEROLUX",
  "NOVATEK",
  "QUANTA",
  "ZENITH",
  "HALCYON",
  "STRATOS",
  "FERRO",
  "LUMEN",
  "ORYX",
  "CALDERA",
  "VECTOR ONE",
  "SABLE",
  "IONIQ WORKS"
];
const TEAM_META = {
  corsa: { short: "CRS", setup: "scuderia", style: "spear", country: "Italy", engine: "Corsa 066/8" },
  argent: { short: "ARG", setup: "argent", style: "fade", country: "Germany", engine: "Kryon RA26" },
  redline: { short: "RDL", setup: "vermilion", style: "chevron", country: "Austria", engine: "Kryon RA26" },
  albion: { short: "ALB", setup: "apex", style: "blade", country: "United Kingdom", engine: "Albion V6-H" },
  aurora: { short: "AUR", setup: "meridian", style: "wave", country: "United Kingdom", engine: "Albion V6-H" },
  bleunord: { short: "BLN", setup: "apex", style: "stripe", country: "France", engine: "Bleu Nord E26" },
  sentinel: { short: "SEN", setup: "argent", style: "chevron", country: "United States", engine: "Corsa 066/8" },
  vulcan: { short: "VUL", setup: "kestrel", style: "fade", country: "Japan", engine: "Vulcan RH26" },
  kestrel: { short: "KES", setup: "kestrel", style: "blade", country: "Switzerland", engine: "Vulcan RH26" },
  meridian: { short: "MER", setup: "meridian", style: "wave", country: "Spain", engine: "Bleu Nord E26" }
};
const DRIVER_TABLE = [
  ["corsa", "Luca Ferraro", "FER", 16, "Italy", 0.96, 0.78, { base: 15918652, trim: 14159914, mark: 1052692, pattern: "chevron" }],
  ["corsa", "Rafael Costa", "COS", 27, "Brazil", 0.9, 0.86, { base: 1802042, trim: 16119280, mark: 15909376, pattern: "bands" }],
  ["argent", "Elias Vance", "VAN", 4, "United Kingdom", 0.95, 0.71, { base: 12896978, trim: 49842, mark: 1052692, pattern: "blade" }],
  ["argent", "Nico Brandt", "BRA", 11, "Germany", 0.92, 0.8, { base: 1052692, trim: 13898288, mark: 15790320, pattern: "halves" }],
  ["redline", "Callum Reed", "REE", 1, "United Kingdom", 0.98, 0.88, { base: 1450319, trim: 16106496, mark: 13898288, pattern: "star" }],
  ["redline", "Sora Takeda", "TAK", 22, "Japan", 0.88, 0.74, { base: 16119280, trim: 13898288, mark: 1450319, pattern: "rising" }],
  ["albion", "Théo Marchal", "MAR", 10, "France", 0.91, 0.83, { base: 16742912, trim: 1777450, mark: 15790320, pattern: "chevron" }],
  ["albion", "Owen Fletcher", "FLE", 30, "Australia", 0.86, 0.79, { base: 1777450, trim: 16742912, mark: 15790320, pattern: "blade" }],
  ["aurora", "Amir Rahimi", "RAH", 6, "United Arab Emirates", 0.89, 0.72, { base: 23118, trim: 12177971, mark: 15921902, pattern: "wave" }],
  ["aurora", "Lars Nyberg", "NYB", 18, "Sweden", 0.87, 0.68, { base: 679888, trim: 15913472, mark: 15921902, pattern: "halves" }],
  ["bleunord", "Émile Duval", "DUV", 31, "France", 0.9, 0.81, { base: 683742, trim: 16053490, mark: 13898288, pattern: "stripe" }],
  ["bleunord", "Diego Salazar", "SAL", 55, "Spain", 0.93, 0.85, { base: 14159914, trim: 15909376, mark: 1052692, pattern: "bands" }],
  ["sentinel", "Santiago Reyes", "REY", 24, "Mexico", 0.85, 0.9, { base: 883263, trim: 16119280, mark: 13898288, pattern: "bands" }],
  ["sentinel", "Marco Silvestri", "SIL", 63, "Italy", 0.88, 0.76, { base: 2771612, trim: 13568556, mark: 16777215, pattern: "star" }],
  ["vulcan", "Kaito Mori", "MOR", 7, "Japan", 0.91, 0.77, { base: 16119280, trim: 7326207, mark: 13898288, pattern: "rising" }],
  ["vulcan", "Felix Braun", "BRU", 44, "Austria", 0.87, 0.82, { base: 657936, trim: 7326207, mark: 16777215, pattern: "blade" }],
  ["kestrel", "Viktor Halden", "HAL", 77, "Finland", 0.89, 0.7, { base: 1710622, trim: 11855360, mark: 9145234, pattern: "chevron" }],
  ["kestrel", "Adrian Kovacs", "KOV", 23, "Hungary", 0.83, 0.87, { base: 11855360, trim: 1710622, mark: 15790320, pattern: "halves" }],
  ["meridian", "Anders Holm", "HOL", 14, "Denmark", 0.86, 0.73, { base: 8065072, trim: 13214247, mark: 15262940, pattern: "wave" }],
  ["meridian", "Jonas Vinter", "VIN", 81, "Norway", 0.82, 0.75, { base: 15262940, trim: 8065072, mark: 13214247, pattern: "stripe" }]
];
function buildTeams() {
  const out = [];
  for (let i = 0; i < TEAM_LIVERIES.length; i++) {
    const l = TEAM_LIVERIES[i];
    const meta = TEAM_META[l.id] ?? { short: l.id.slice(0, 3).toUpperCase(), setup: "apex", style: "stripe" };
    const rng = new Rng(1374486528 + i * 7919);
    const sponsors = [];
    const pool = SPONSOR_POOL.slice();
    for (let k = 0; k < 6; k++) sponsors.push(pool.splice(Math.floor(rng.next() * pool.length), 1)[0]);
    out.push({
      id: l.id,
      index: i,
      name: l.name,
      shortName: meta.short,
      country: meta.country,
      engine: meta.engine,
      setup: meta.setup,
      style: meta.style,
      colors: { primary: l.primary, secondary: l.secondary, accent: l.accent },
      sponsors,
      title: sponsors[0],
      drivers: []
    });
  }
  for (let i = 0; i < DRIVER_TABLE.length; i++) {
    const [teamId, name, code, number, country, skill, aggression, helmet] = DRIVER_TABLE[i];
    const team = out.find((t) => t.id === teamId);
    const driver = {
      index: i,
      name,
      code,
      number,
      country,
      skill,
      aggression,
      helmet,
      team,
      teamId,
      lastName: name.slice(name.lastIndexOf(" ") + 1)
    };
    team.drivers.push(driver);
  }
  return out;
}
export const TEAMS = buildTeams();
export const DRIVERS = TEAMS.flatMap((t) => t.drivers);
export function teamById(id) {
  return TEAMS.find((t) => t.id === id) ?? TEAMS[0];
}
function css(hex) {
  return `#${(hex >>> 0).toString(16).padStart(6, "0")}`;
}
function luma(hex) {
  const r = (hex >> 16 & 255) / 255;
  const g = (hex >> 8 & 255) / 255;
  const b = (hex & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function inkFor(hex) {
  return luma(hex) > 0.42 ? "#101014" : "#f2f4f7";
}
function shade(hex, f) {
  const r = Math.round(Math.min(255, (hex >> 16 & 255) * f));
  const g = Math.round(Math.min(255, (hex >> 8 & 255) * f));
  const b = Math.round(Math.min(255, (hex & 255) * f));
  return `rgb(${r},${g},${b})`;
}
const FLIP_X = { none: 1, h: -1, v: 1, hv: -1 };
const FLIP_Y = { none: 1, h: 1, v: -1, hv: -1 };
function flankText(c, text, x, y, size, colour, flip, weight = 800, spacing = 0.06) {
  c.save();
  c.translate(x, y);
  const sx = FLIP_X[flip] ?? 1;
  const sy = FLIP_Y[flip] ?? 1;
  if (sx !== 1 || sy !== 1) c.scale(sx, sy);
  c.fillStyle = colour;
  c.font = `${weight} ${Math.round(size)}px system-ui, "Helvetica Neue", Arial, sans-serif`;
  if ("letterSpacing" in c) c.letterSpacing = `${Math.round(size * spacing)}px`;
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(text, 0, 0);
  if ("letterSpacing" in c) c.letterSpacing = "0px";
  c.restore();
}
function drawBodyWrap(c, w, h, team) {
  const { primary, secondary, accent } = team.colors;
  const mid = h * 0.5;
  const POD = 0.75;
  const FLANK = 0.658;
  const UNDER = 0.862;
  const base = c.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0, shade(primary, 0.55));
  base.addColorStop(0.2, shade(primary, 0.95));
  base.addColorStop(0.42, shade(primary, 1.1));
  base.addColorStop(0.5, shade(primary, 1.16));
  base.addColorStop(0.58, shade(primary, 1.1));
  base.addColorStop(0.8, shade(primary, 0.95));
  base.addColorStop(1, shade(primary, 0.55));
  c.fillStyle = base;
  c.fillRect(0, 0, w, h);
  c.save();
  c.fillStyle = css(secondary);
  switch (team.style) {
    case "spear": {
      c.beginPath();
      c.moveTo(0, mid - h * 0.045);
      c.lineTo(w * 0.46, mid - h * 0.135);
      c.lineTo(w, mid - h * 0.245);
      c.lineTo(w, mid + h * 0.245);
      c.lineTo(w * 0.46, mid + h * 0.135);
      c.lineTo(0, mid + h * 0.045);
      c.closePath();
      c.fill();
      break;
    }
    case "chevron": {
      for (let k = 0; k < 4; k++) {
        const x0 = w * (0.3 + k * 0.16);
        c.beginPath();
        c.moveTo(x0, 0);
        c.lineTo(x0 + w * 0.07, 0);
        c.lineTo(x0 + w * 0.022, mid);
        c.lineTo(x0 + w * 0.07, h);
        c.lineTo(x0, h);
        c.lineTo(x0 + w * 0.048, mid);
        c.closePath();
        c.fill();
      }
      break;
    }
    case "blade": {
      c.beginPath();
      c.moveTo(w * 0.34, 0);
      c.lineTo(w, 0);
      c.lineTo(w, h);
      c.lineTo(w * 0.34, h);
      c.lineTo(w * 0.5, mid);
      c.closePath();
      c.fill();
      break;
    }
    case "wave": {
      for (const s of [1, -1]) {
        c.beginPath();
        c.moveTo(0, mid + s * h * 0.3);
        for (let x = 0; x <= w; x += w / 48) {
          c.lineTo(x, mid + s * h * (0.3 - 0.1 * Math.sin(x / w * Math.PI * 2.2)));
        }
        c.lineTo(w, s > 0 ? h : 0);
        c.lineTo(0, s > 0 ? h : 0);
        c.closePath();
        c.fill();
      }
      break;
    }
    case "fade": {
      const g = c.createLinearGradient(w * 0.26, 0, w, 0);
      g.addColorStop(0, `${css(secondary)}00`);
      g.addColorStop(0.55, css(secondary));
      g.addColorStop(1, css(secondary));
      c.fillStyle = g;
      c.fillRect(w * 0.26, 0, w * 0.74, h);
      break;
    }
    default: {
      c.fillRect(0, mid - h * 0.07, w, h * 0.14);
      c.fillRect(0, 0, w * 0.28, h);
      break;
    }
  }
  c.restore();
  const under = c.createLinearGradient(0, h * (UNDER - 0.03), 0, h);
  under.addColorStop(0, "rgba(18,19,23,0)");
  under.addColorStop(0.35, "rgba(18,19,23,1)");
  under.addColorStop(1, "rgba(12,13,16,1)");
  c.fillStyle = under;
  c.fillRect(0, h * (UNDER - 0.03), w, h * (1 - UNDER + 0.03));
  c.save();
  c.translate(0, h);
  c.scale(1, -1);
  c.fillStyle = under;
  c.fillRect(0, h * (UNDER - 0.03), w, h * (1 - UNDER + 0.03));
  c.restore();
  c.strokeStyle = css(accent);
  c.lineWidth = Math.max(2, h * 0.01);
  for (const s of [1, -1]) {
    c.beginPath();
    c.moveTo(w * 0.05, mid + s * h * 0.15);
    c.bezierCurveTo(w * 0.34, mid + s * h * 0.12, w * 0.58, mid + s * h * 0.085, w, mid + s * h * 0.065);
    c.stroke();
  }
  c.fillStyle = css(accent);
  c.beginPath();
  c.moveTo(0, mid - h * 0.135);
  c.lineTo(w * 0.125, mid - h * 0.042);
  c.lineTo(w * 0.125, mid + h * 0.042);
  c.lineTo(0, mid + h * 0.135);
  c.closePath();
  c.fill();
  const flankInk = inkFor(secondary);
  const spineInk = inkFor(primary);
  for (const s of [1, -1]) {
    const flip = s > 0 ? "h" : "hv";
    const podY = s > 0 ? h * POD : h * (1 - POD);
    const flankY = s > 0 ? h * FLANK : h * (1 - FLANK);
    flankText(c, team.title, w * 0.545, podY, h * 0.07, flankInk, flip, 800, 0.05);
    flankText(c, team.sponsors[1], w * 0.8, podY, h * 0.036, flankInk, flip, 700, 0.09);
    flankText(c, team.sponsors[2], w * 0.3, podY, h * 0.03, flankInk, flip, 700, 0.09);
    flankText(c, team.sponsors[3], w * 0.68, flankY, h * 0.03, spineInk, flip, 700, 0.1);
    flankText(c, team.sponsors[4], w * 0.235, flankY, h * 0.026, spineInk, flip, 700, 0.1);
    flankText(c, String(team.shortName), w * 0.905, flankY, h * 0.024, spineInk, flip, 800, 0.16);
  }
  flankText(c, team.name.toUpperCase(), w * 0.615, mid, h * 0.048, spineInk, "h", 800, 0.14);
  flankText(c, team.engine.toUpperCase(), w * 0.87, mid, h * 0.026, spineInk, "h", 600, 0.12);
  c.strokeStyle = "rgba(6,7,10,0.45)";
  c.lineWidth = Math.max(1.5, h * 5e-3);
  for (const s of [1, -1]) {
    const y = s > 0 ? h * 0.702 : h * 0.298;
    c.beginPath();
    c.moveTo(w * 0.3, y);
    c.bezierCurveTo(w * 0.52, y - s * h * 0.02, w * 0.7, y - s * h * 0.015, w * 0.95, y - s * h * 0.045);
    c.stroke();
  }
  const grain = c.createLinearGradient(0, 0, w, 0);
  grain.addColorStop(0, "rgba(255,255,255,0.04)");
  grain.addColorStop(0.5, "rgba(0,0,0,0.0)");
  grain.addColorStop(1, "rgba(0,0,0,0.05)");
  c.fillStyle = grain;
  c.fillRect(0, 0, w, h);
}
const WING_BAND = {
  rear: [0.8, 1],
  frontWing: [0.64, 0.76],
  lower: [0.28, 0.45]
};
const bandMid = (band) => (band[0] + band[1]) * 0.5;
function drawWingWrap(c, w, h, team) {
  const { primary, secondary, accent } = team.colors;
  c.fillStyle = css(secondary);
  c.fillRect(0, 0, w, h);
  c.fillStyle = css(primary);
  c.fillRect(0, 0, w, h * 0.485);
  c.fillRect(0, h * WING_BAND.rear[0], w, h * (WING_BAND.rear[1] - WING_BAND.rear[0]));
  c.fillStyle = css(accent);
  c.fillRect(0, h * 0.485, w, h * 0.03);
  c.fillRect(0, h * 0.786, w, h * 0.014);
  c.fillStyle = shade(secondary, 0.86);
  c.fillRect(0, h * 0.545, w, h * 0.055);
  flankText(c, team.title, w * 0.5, h * bandMid(WING_BAND.lower), h * 0.15, inkFor(primary), "v", 800, 0.1);
  flankText(c, team.title, w * 0.5, h * bandMid(WING_BAND.rear), h * 0.12, inkFor(primary), "v", 800, 0.1);
  flankText(c, team.sponsors[5], w * 0.5, h * 0.14, h * 0.06, inkFor(primary), "v", 700, 0.14);
  c.fillStyle = shade(secondary, 0.8);
  c.fillRect(0, h * WING_BAND.frontWing[0], w, h * (WING_BAND.frontWing[1] - WING_BAND.frontWing[0]));
  c.fillStyle = css(primary);
  c.fillRect(0, h * 0.664, w, h * 0.03);
  c.fillStyle = css(accent);
  c.fillRect(0, h * 0.7, w, h * 0.011);
  for (let k = 0; k < 3; k++) {
    flankText(
      c,
      team.sponsors[k + 1],
      w * (0.22 + k * 0.28),
      h * 0.736,
      h * 0.026,
      "#e8ecf2",
      "v",
      700,
      0.1
    );
  }
  c.fillStyle = "rgba(10,11,14,0.85)";
  c.fillRect(0, 0, w * 0.045, h);
  c.fillRect(w * 0.955, 0, w * 0.045, h);
}
function drawNumberPanel(c, w, h, driver) {
  const { primary, accent } = driver.team.colors;
  c.clearRect(0, 0, w, h);
  c.fillStyle = css(primary);
  c.fillRect(0, 0, w, h);
  c.fillStyle = css(accent);
  c.fillRect(0, h * 0.86, w, h * 0.14);
  flankText(c, String(driver.number), w * 0.5, h * 0.44, h * 0.68, inkFor(primary), "none", 900, 0);
  flankText(c, driver.code, w * 0.5, h * 0.93, h * 0.13, inkFor(accent), "none", 800, 0.16);
}
export class LiveryFactory {
  constructor(ctx) {
    this.ctx = ctx;
    this.materials = ctx.materials ?? null;
    this._sets = new Map();
    this._textures = [];
    this._materialsOwned = [];
    const scale = ctx.quality?.textureScale ?? 1;
    this._bodyW = Math.max(512, Math.round(2048 * scale));
    this._bodyH = this._bodyW * 0.5;
    this._wingW = Math.max(256, Math.round(1024 * scale));
    this._anisotropy = Math.max(1, Math.min(
      ctx.quality?.anisotropy ?? 8,
      ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 16
    ));
  }
  _own(tex) {
    tex.anisotropy = this._anisotropy;
    this._textures.push(tex);
    return tex;
  }
  _paint(params) {
    const m = new THREE.MeshPhysicalMaterial({
      roughness: 0.34,
      metalness: 0.05,
      clearcoat: 1,
      clearcoatRoughness: 0.045,
      envMapIntensity: 1.15,
      ...params
    });
    const flake = this.materials?.texture?.("livery_primary") ?? null;
    if (flake) {
      m.clearcoatNormalMap = flake;
      m.clearcoatNormalScale.set(0.26, 0.26);
    }
    this._materialsOwned.push(m);
    return m;
  }
  get(team) {
    const cached = this._sets.get(team.id);
    if (cached) return cached;
    const bodyCanvas = createCanvas(this._bodyW, this._bodyH);
    drawBodyWrap(bodyCanvas.getContext("2d"), this._bodyW, this._bodyH, team);
    const bodyTex = this._own(textureFromCanvas(bodyCanvas));
    bodyTex.wrapS = THREE.ClampToEdgeWrapping;
    bodyTex.wrapT = THREE.RepeatWrapping;
    const wingH = Math.max(64, Math.round(this._wingW * 0.25));
    const wingCanvas = createCanvas(this._wingW, wingH);
    drawWingWrap(wingCanvas.getContext("2d"), this._wingW, wingH, team);
    const wingTex = this._own(textureFromCanvas(wingCanvas));
    wingTex.wrapS = THREE.ClampToEdgeWrapping;
    wingTex.wrapT = THREE.ClampToEdgeWrapping;
    const mats = this.materials;
    const set = {
      team,
      colors: team.colors,
      bodyTexture: bodyTex,
      wingTexture: wingTex,
      body: this._paint({ map: bodyTex, color: 16777215 }),
      wing: this._paint({
        map: wingTex,
        color: 16777215,
        roughness: 0.46,
        clearcoat: 0.45,
        clearcoatRoughness: 0.2,
        envMapIntensity: 0.95
      }),
      matte: this._paint({
        color: new THREE.Color(team.colors.primary),
        roughness: 0.52,
        clearcoat: 0.35,
        clearcoatRoughness: 0.28,
        envMapIntensity: 1
      }),
      accent: this._paint({ color: new THREE.Color(team.colors.accent), envMapIntensity: 1.35 }),
      dark: this._paint({
        color: new THREE.Color(team.colors.secondary),
        roughness: 0.38,
        clearcoatRoughness: 0.06
      }),
      duct: this._paint({
        color: 592397,
        roughness: 0.82,
        metalness: 0,
        clearcoat: 0.12,
        clearcoatRoughness: 0.55,
        envMapIntensity: 0.35,
        side: THREE.DoubleSide
      }),
      carbon: mats?.get("carbon_gloss") ?? this._paint({ color: 1316122 }),
      carbonMatte: mats?.get("carbon_matte") ?? this._paint({ color: 1316122, clearcoat: 0.2 }),
      carbonWeave: mats?.get("carbon_weave") ?? this._paint({ color: 1316122 }),
      metal: mats?.get("metal_anodised") ?? this._paint({ color: 9080726, metalness: 1 }),
      halo: mats?.get("halo") ?? this._paint({ color: 2763825, metalness: 1 }),
      suspension: mats?.get("suspension_arm") ?? this._paint({ color: 12106948 }),
      exhaust: mats?.get("exhaust_metal") ?? this._paint({ color: 6969930, metalness: 1 }),
      suit: this._suit(mats, team)
    };
    this._sets.set(team.id, set);
    return set;
  }
  _suit(mats, team) {
    const base = mats?.makeLivery?.(team.colors)?.suit;
    if (!base) return this._paint({ color: new THREE.Color(team.colors.primary), clearcoat: 0.1, roughness: 0.7 });
    const suit = base.clone();
    suit.sheen = 0.3;
    suit.sheenRoughness = 0.86;
    suit.sheenColor = new THREE.Color(team.colors.primary).lerp(new THREE.Color(16777215), 0.3);
    this._materialsOwned.push(suit);
    return suit;
  }
  numberDecal(driver) {
    if (driver._numberTexture) return driver._numberTexture;
    const w = 256;
    const h = 192;
    const canvas = createCanvas(w, h);
    drawNumberPanel(canvas.getContext("2d"), w, h, driver);
    const tex = this._own(textureFromCanvas(canvas));
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    driver._numberTexture = tex;
    return tex;
  }
  dispose() {
    for (const m of this._materialsOwned) m.dispose();
    for (const t of this._textures) t.dispose();
    for (const d of DRIVERS) d._numberTexture = null;
    this._materialsOwned.length = 0;
    this._textures.length = 0;
    this._sets.clear();
  }
}
