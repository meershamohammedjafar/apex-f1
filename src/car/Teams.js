import * as THREE from 'three';
import { createCanvas, textureFromCanvas } from '../render/textures/NoiseTextures.js';
import { TEAM_LIVERIES } from '../render/MaterialLibrary.js';
import { Rng } from '../core/Rng.js';

/**
 * The grid: ten invented constructors, twenty invented drivers, and the procedural
 * paintwork that tells them apart at 300 km/h.
 *
 * Colours come from MaterialLibrary.TEAM_LIVERIES so that anything else keying off a
 * team id (trackside garage doors, pit boards, the HUD) lands on the same palette.
 *
 * UV convention for the body wrap, shared with CarModel's lofts:
 *   u = around the section, 0 = underside centreline, 0.25 = right flank,
 *       0.5 = spine, 0.75 = left flank
 *   v = 0 at the front-wing leading edge, 1 at the rear-wing trailing edge
 * so one 2:1 canvas is a genuine unwrapped livery and panels line up across every
 * separately lofted piece of bodywork.
 */

export const BODY_V_FRONT = -2.62;
export const BODY_V_REAR = 3.01;

/** Fictional sponsor marks. Deliberately generic industrial/energy/tech names. */
const SPONSOR_POOL = [
  'AXIOM', 'NORTHWIND', 'HELIOS', 'CIRRUS', 'VANTIS', 'KRYON', 'OBSIDIAN', 'PULSAR',
  'TITANWORKS', 'AEROLUX', 'NOVATEK', 'QUANTA', 'ZENITH', 'HALCYON', 'STRATOS',
  'FERRO', 'LUMEN', 'ORYX', 'CALDERA', 'VECTOR ONE', 'SABLE', 'IONIQ WORKS',
];

const TEAM_META = {
  corsa: { short: 'CRS', setup: 'scuderia', style: 'spear', country: 'Italy', engine: 'Corsa 066/8' },
  argent: { short: 'ARG', setup: 'argent', style: 'fade', country: 'Germany', engine: 'Kryon RA26' },
  redline: { short: 'RDL', setup: 'vermilion', style: 'chevron', country: 'Austria', engine: 'Kryon RA26' },
  albion: { short: 'ALB', setup: 'apex', style: 'blade', country: 'United Kingdom', engine: 'Albion V6-H' },
  aurora: { short: 'AUR', setup: 'meridian', style: 'wave', country: 'United Kingdom', engine: 'Albion V6-H' },
  bleunord: { short: 'BLN', setup: 'apex', style: 'stripe', country: 'France', engine: 'Bleu Nord E26' },
  sentinel: { short: 'SEN', setup: 'argent', style: 'chevron', country: 'United States', engine: 'Corsa 066/8' },
  vulcan: { short: 'VUL', setup: 'kestrel', style: 'fade', country: 'Japan', engine: 'Vulcan RH26' },
  kestrel: { short: 'KES', setup: 'kestrel', style: 'blade', country: 'Switzerland', engine: 'Vulcan RH26' },
  meridian: { short: 'MER', setup: 'meridian', style: 'wave', country: 'Spain', engine: 'Bleu Nord E26' },
};

/**
 * Twenty drivers, two per constructor. `skill` scales corner speed and consistency,
 * `aggression` scales overtaking appetite and how late they brake into a gap; the AI
 * driver consumes both. Helmet fields drive the procedural helmet paint in DriverModel.
 */
const DRIVER_TABLE = [
  ['corsa', 'Luca Ferraro', 'FER', 16, 'Italy', 0.96, 0.78, { base: 0xf2e63c, trim: 0xd8102a, mark: 0x101014, pattern: 'chevron' }],
  ['corsa', 'Rafael Costa', 'COS', 27, 'Brazil', 0.90, 0.86, { base: 0x1b7f3a, trim: 0xf5f5f0, mark: 0xf2c200, pattern: 'bands' }],
  ['argent', 'Elias Vance', 'VAN', 4, 'United Kingdom', 0.95, 0.71, { base: 0xc4cad2, trim: 0x00c2b2, mark: 0x101014, pattern: 'blade' }],
  ['argent', 'Nico Brandt', 'BRA', 11, 'Germany', 0.92, 0.80, { base: 0x101014, trim: 0xd41230, mark: 0xf0f0f0, pattern: 'halves' }],
  ['redline', 'Callum Reed', 'REE', 1, 'United Kingdom', 0.98, 0.88, { base: 0x16214f, trim: 0xf5c400, mark: 0xd41230, pattern: 'star' }],
  ['redline', 'Sora Takeda', 'TAK', 22, 'Japan', 0.88, 0.74, { base: 0xf5f5f0, trim: 0xd41230, mark: 0x16214f, pattern: 'rising' }],
  ['albion', 'Théo Marchal', 'MAR', 10, 'France', 0.91, 0.83, { base: 0xff7a00, trim: 0x1b1f2a, mark: 0xf0f0f0, pattern: 'chevron' }],
  ['albion', 'Owen Fletcher', 'FLE', 30, 'Australia', 0.86, 0.79, { base: 0x1b1f2a, trim: 0xff7a00, mark: 0xf0f0f0, pattern: 'blade' }],
  ['aurora', 'Amir Rahimi', 'RAH', 6, 'United Arab Emirates', 0.89, 0.72, { base: 0x005a4e, trim: 0xb9d233, mark: 0xf2f2ee, pattern: 'wave' }],
  ['aurora', 'Lars Nyberg', 'NYB', 18, 'Sweden', 0.87, 0.68, { base: 0x0a5fd0, trim: 0xf2d200, mark: 0xf2f2ee, pattern: 'halves' }],
  ['bleunord', 'Émile Duval', 'DUV', 31, 'France', 0.90, 0.81, { base: 0x0a6ede, trim: 0xf4f4f2, mark: 0xd41230, pattern: 'stripe' }],
  ['bleunord', 'Diego Salazar', 'SAL', 55, 'Spain', 0.93, 0.85, { base: 0xd8102a, trim: 0xf2c200, mark: 0x101014, pattern: 'bands' }],
  ['sentinel', 'Santiago Reyes', 'REY', 24, 'Mexico', 0.85, 0.90, { base: 0x0d7a3f, trim: 0xf5f5f0, mark: 0xd41230, pattern: 'bands' }],
  ['sentinel', 'Marco Silvestri', 'SIL', 63, 'Italy', 0.88, 0.76, { base: 0x2a4a9c, trim: 0xcf0a2c, mark: 0xffffff, pattern: 'star' }],
  ['vulcan', 'Kaito Mori', 'MOR', 7, 'Japan', 0.91, 0.77, { base: 0xf5f5f0, trim: 0x6fc9ff, mark: 0xd41230, pattern: 'rising' }],
  ['vulcan', 'Felix Braun', 'BRU', 44, 'Austria', 0.87, 0.82, { base: 0x0a0a10, trim: 0x6fc9ff, mark: 0xffffff, pattern: 'blade' }],
  ['kestrel', 'Viktor Halden', 'HAL', 77, 'Finland', 0.89, 0.70, { base: 0x1a1a1e, trim: 0xb4e600, mark: 0x8b8b92, pattern: 'chevron' }],
  ['kestrel', 'Adrian Kovacs', 'KOV', 23, 'Hungary', 0.83, 0.87, { base: 0xb4e600, trim: 0x1a1a1e, mark: 0xf0f0f0, pattern: 'halves' }],
  ['meridian', 'Anders Holm', 'HOL', 14, 'Denmark', 0.86, 0.73, { base: 0x7b1030, trim: 0xc9a227, mark: 0xe8e4dc, pattern: 'wave' }],
  ['meridian', 'Jonas Vinter', 'VIN', 81, 'Norway', 0.82, 0.75, { base: 0xe8e4dc, trim: 0x7b1030, mark: 0xc9a227, pattern: 'stripe' }],
];

function buildTeams() {
  const out = [];
  for (let i = 0; i < TEAM_LIVERIES.length; i++) {
    const l = TEAM_LIVERIES[i];
    const meta = TEAM_META[l.id] ?? { short: l.id.slice(0, 3).toUpperCase(), setup: 'apex', style: 'stripe' };
    const rng = new Rng(0x51ed0000 + i * 7919);
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
      drivers: [],
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
      lastName: name.slice(name.lastIndexOf(' ') + 1),
    };
    team.drivers.push(driver);
  }
  return out;
}

export const TEAMS = buildTeams();

/** Flat grid order: team-by-team, lead driver first. Index 0 is the player's seat. */
export const DRIVERS = TEAMS.flatMap((t) => t.drivers);

export function teamById(id) {
  return TEAMS.find((t) => t.id === id) ?? TEAMS[0];
}

function css(hex) {
  return `#${(hex >>> 0).toString(16).padStart(6, '0')}`;
}

/** Perceptual luminance, used to pick legible decal ink over any base colour. */
function luma(hex) {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function inkFor(hex) {
  return luma(hex) > 0.42 ? '#101014' : '#f2f4f7';
}

function shade(hex, f) {
  const r = Math.round(Math.min(255, ((hex >> 16) & 255) * f));
  const g = Math.round(Math.min(255, ((hex >> 8) & 255) * f));
  const b = Math.round(Math.min(255, (hex & 255) * f));
  return `rgb(${r},${g},${b})`;
}

/**
 * Draw one decal into wrap space.
 *
 * Deriving the flip is mechanical once two facts are pinned down, and both were guessed
 * wrong before, which is why every mark on the car read backwards.
 *
 * 1. The texture upload row-flips the canvas (`readCanvas`), so canvasX = u and
 *    canvasY = 1 - v. Canvas y points down, so on the surface: +canvasX = +u and
 *    -canvasY = +v.
 * 2. `c.scale(sx, sy)` before `fillText` sends the glyph's reading direction to
 *    (sx, 0) and its up direction to (0, -sy) in canvas space. Substituting (1):
 *
 *      'none' -> reads along +u, up along -v      'h'  -> reads along -u, up along -v
 *      'v'    -> reads along +u, up along +v      'hv' -> reads along -u, up along +v
 *
 * So each surface only has to answer two questions — which way does +u run for the
 * viewer who is meant to read this, and which way does +v run — and the flip follows.
 * Every choice below was checked by projecting the front-facing triangles of the band
 * the mark lands on and reading the sign of the resulting Jacobian, not by eye.
 */
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
  if ('letterSpacing' in c) c.letterSpacing = `${Math.round(size * spacing)}px`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillText(text, 0, 0);
  if ('letterSpacing' in c) c.letterSpacing = '0px';
  c.restore();
}

/**
 * Paint one team's body wrap.
 *
 * The canvas is the car unrolled: x runs nose-to-tail, y runs around the section with
 * the spine through the middle. Everything is drawn twice about that centre line so the
 * two flanks are mirror images, which is what a real wrap does.
 */
function drawBodyWrap(c, w, h, team) {
  const { primary, secondary, accent } = team.colors;
  const mid = h * 0.5;

  // Bands, in canvas rows. The pod band is where the eye lands, so it gets the title.
  const POD = 0.750;      // sidepod outer face
  const FLANK = 0.658;    // tub and engine-cover flanks, behind and above the pod
  const UNDER = 0.862;    // floor edge and everything below it

  const base = c.createLinearGradient(0, 0, 0, h);
  base.addColorStop(0.0, shade(primary, 0.55));
  base.addColorStop(0.20, shade(primary, 0.95));
  base.addColorStop(0.42, shade(primary, 1.10));
  base.addColorStop(0.5, shade(primary, 1.16));
  base.addColorStop(0.58, shade(primary, 1.10));
  base.addColorStop(0.80, shade(primary, 0.95));
  base.addColorStop(1.0, shade(primary, 0.55));
  c.fillStyle = base;
  c.fillRect(0, 0, w, h);

  c.save();
  c.fillStyle = css(secondary);
  switch (team.style) {
    case 'spear': {
      // Points forward: a narrow blade off the nose that opens out over the engine cover.
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
    case 'chevron': {
      for (let k = 0; k < 4; k++) {
        const x0 = w * (0.30 + k * 0.16);
        c.beginPath();
        c.moveTo(x0, 0);
        c.lineTo(x0 + w * 0.070, 0);
        c.lineTo(x0 + w * 0.022, mid);
        c.lineTo(x0 + w * 0.070, h);
        c.lineTo(x0, h);
        c.lineTo(x0 + w * 0.048, mid);
        c.closePath();
        c.fill();
      }
      break;
    }
    case 'blade': {
      c.beginPath();
      c.moveTo(w * 0.34, 0);
      c.lineTo(w, 0);
      c.lineTo(w, h);
      c.lineTo(w * 0.34, h);
      c.lineTo(w * 0.50, mid);
      c.closePath();
      c.fill();
      break;
    }
    case 'wave': {
      for (const s of [1, -1]) {
        c.beginPath();
        c.moveTo(0, mid + s * h * 0.30);
        for (let x = 0; x <= w; x += w / 48) {
          c.lineTo(x, mid + s * h * (0.30 - 0.10 * Math.sin((x / w) * Math.PI * 2.2)));
        }
        c.lineTo(w, s > 0 ? h : 0);
        c.lineTo(0, s > 0 ? h : 0);
        c.closePath();
        c.fill();
      }
      break;
    }
    case 'fade': {
      const g = c.createLinearGradient(w * 0.26, 0, w, 0);
      g.addColorStop(0, `${css(secondary)}00`);
      g.addColorStop(0.55, css(secondary));
      g.addColorStop(1, css(secondary));
      c.fillStyle = g;
      c.fillRect(w * 0.26, 0, w * 0.74, h);
      break;
    }
    default: {
      c.fillRect(0, mid - h * 0.070, w, h * 0.14);
      c.fillRect(0, 0, w * 0.28, h);
      break;
    }
  }
  c.restore();

  // Floor edge and undertray: satin black on every car, whatever the livery.
  const under = c.createLinearGradient(0, h * (UNDER - 0.03), 0, h);
  under.addColorStop(0, 'rgba(18,19,23,0)');
  under.addColorStop(0.35, 'rgba(18,19,23,1)');
  under.addColorStop(1, 'rgba(12,13,16,1)');
  c.fillStyle = under;
  c.fillRect(0, h * (UNDER - 0.03), w, h * (1 - UNDER + 0.03));
  c.save();
  c.translate(0, h);
  c.scale(1, -1);
  c.fillStyle = under;
  c.fillRect(0, h * (UNDER - 0.03), w, h * (1 - UNDER + 0.03));
  c.restore();

  // Accent pinstripes running the length of the spine.
  c.strokeStyle = css(accent);
  c.lineWidth = Math.max(2, h * 0.010);
  for (const s of [1, -1]) {
    c.beginPath();
    c.moveTo(w * 0.05, mid + s * h * 0.150);
    c.bezierCurveTo(w * 0.34, mid + s * h * 0.120, w * 0.58, mid + s * h * 0.085, w, mid + s * h * 0.065);
    c.stroke();
  }

  // Nose flash.
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

  // Right flank (v = 0.25): a viewer off the right of the car reads along -u, because
  // the wrap's u runs nose-to-tail and their view puts the nose on the left only after
  // the section has wrapped past the spine; up on that flank is -v, toward the floor
  // seam. Left flank (v = 0.75): the section has wrapped the other way, so the reading
  // sense stays -u but up becomes +v. This is the asymmetry a mirrored wrap hides — the
  // two flanks are mirror images of each other, but the text on them must not be.
  for (const s of [1, -1]) {
    const flip = s > 0 ? 'h' : 'hv';
    const podY = s > 0 ? h * POD : h * (1 - POD);
    const flankY = s > 0 ? h * FLANK : h * (1 - FLANK);
    // Title sponsor across the sidepod: the single biggest mark on the car.
    flankText(c, team.title, w * 0.545, podY, h * 0.070, flankInk, flip, 800, 0.05);
    flankText(c, team.sponsors[1], w * 0.800, podY, h * 0.036, flankInk, flip, 700, 0.09);
    flankText(c, team.sponsors[2], w * 0.300, podY, h * 0.030, flankInk, flip, 700, 0.09);
    // Smaller marks on the tub and engine-cover flanks behind the pod.
    flankText(c, team.sponsors[3], w * 0.680, flankY, h * 0.030, spineInk, flip, 700, 0.10);
    flankText(c, team.sponsors[4], w * 0.235, flankY, h * 0.026, spineInk, flip, 700, 0.10);
    flankText(c, String(team.shortName), w * 0.905, flankY, h * 0.024, spineInk, flip, 800, 0.16);
  }

  // Engine-cover spine: constructor name forward, power-unit badge aft. The crest is
  // where +v changes which way it leans, so a decal straddling it can only be upright
  // from one side; it is set for the right of the car, which is the broadcast side and
  // where the chase camera sits.
  flankText(c, team.name.toUpperCase(), w * 0.615, mid, h * 0.048, spineInk, 'h', 800, 0.14);
  flankText(c, team.engine.toUpperCase(), w * 0.870, mid, h * 0.026, spineInk, 'h', 600, 0.12);

  // Panel seam where the engine cover meets the sidepod.
  c.strokeStyle = 'rgba(6,7,10,0.45)';
  c.lineWidth = Math.max(1.5, h * 0.005);
  for (const s of [1, -1]) {
    const y = s > 0 ? h * 0.702 : h * 0.298;
    c.beginPath();
    c.moveTo(w * 0.30, y);
    c.bezierCurveTo(w * 0.52, y - s * h * 0.02, w * 0.70, y - s * h * 0.015, w * 0.95, y - s * h * 0.045);
    c.stroke();
  }

  const grain = c.createLinearGradient(0, 0, w, 0);
  grain.addColorStop(0, 'rgba(255,255,255,0.04)');
  grain.addColorStop(0.5, 'rgba(0,0,0,0.0)');
  grain.addColorStop(1, 'rgba(0,0,0,0.05)');
  c.fillStyle = grain;
  c.fillRect(0, 0, w, h);
}

/**
 * Wing art.
 *
 * u is span: 0 at the left endplate, 1 at the right, taken straight off world X, so it
 * can never mirror. v runs around the aerofoil section — 0 at the leading edge, 0.5 at
 * the trailing edge over the upper surface, back to 1.0 at the leading edge along the
 * lower one. With canvasY = 1 - v, canvas rows 0..0.5 are the lower surface and rows
 * 0.5..1 the upper.
 *
 * Which rows a camera behind the car actually sees is not obvious and was measured, by
 * projecting the front-facing triangles of each element and integrating screen area per
 * v. A rear-wing element is raked trailing-edge up, so a following car sees the upper
 * surface just aft of the leading edge (v 0.00-0.20, canvas 0.80-1.00) and a strip of
 * the lower surface ahead of the trailing edge (v 0.55-0.72, canvas 0.28-0.45). The
 * title is set in both, which is also how a real wing carries it. The front and beam
 * wings squeeze their whole section into a band of their own at v 0.24-0.36, chosen
 * because no rear-wing element shows it — before that they shared rows with the rear
 * wing, so the mainplane wore the front wing's pinstripes.
 *
 * Every mark is drawn 'v'. On all of these surfaces +v projects downward on screen for a
 * viewer behind the car, so a mark drawn upright in canvas space lands upside down on
 * the car. That is the bug that had the rear wing wordmark reading backwards.
 */
const WING_BAND = {
  rear: [0.800, 1.000],       // v 0.00-0.20 — upper surface aft of the leading edge
  frontWing: [0.640, 0.760],  // v 0.24-0.36 — front and beam wings, via bandUv
  lower: [0.280, 0.450],      // v 0.55-0.72 — lower surface ahead of the trailing edge
};

/** Centre row of one of the bands above. */
const bandMid = (band) => (band[0] + band[1]) * 0.5;

function drawWingWrap(c, w, h, team) {
  const { primary, secondary, accent } = team.colors;
  // Upper surface base; the lower surface and the rear face take the team colour.
  c.fillStyle = css(secondary);
  c.fillRect(0, 0, w, h);
  c.fillStyle = css(primary);
  c.fillRect(0, 0, w, h * 0.485);
  c.fillRect(0, h * WING_BAND.rear[0], w, h * (WING_BAND.rear[1] - WING_BAND.rear[0]));
  // Trailing-edge seam at v = 0.5, and the edge of the rear face band.
  c.fillStyle = css(accent);
  c.fillRect(0, h * 0.485, w, h * 0.030);
  c.fillRect(0, h * 0.786, w, h * 0.014);
  // A stripe across the flap's leading edge, which is all that band ever shows.
  c.fillStyle = shade(secondary, 0.86);
  c.fillRect(0, h * 0.545, w, h * 0.055);

  // The title, twice, at the size a wordmark on a real rear wing is set. The DRS flap
  // shares the full chord wrap with the mainplane and lands on the lower band, so with
  // the flap open — when it presents the largest flat face on the car — the same
  // wordmark is what a following driver reads.
  flankText(c, team.title, w * 0.5, h * bandMid(WING_BAND.lower), h * 0.150, inkFor(primary), 'v', 800, 0.10);
  flankText(c, team.title, w * 0.5, h * bandMid(WING_BAND.rear), h * 0.120, inkFor(primary), 'v', 800, 0.10);
  flankText(c, team.sponsors[5], w * 0.5, h * 0.140, h * 0.060, inkFor(primary), 'v', 700, 0.14);

  // Front wing and beam wing squeeze their whole section into one band rather than
  // taking the full chord wrap, so they get their own scheme without a second texture.
  c.fillStyle = shade(secondary, 0.80);
  c.fillRect(0, h * WING_BAND.frontWing[0], w, h * (WING_BAND.frontWing[1] - WING_BAND.frontWing[0]));
  c.fillStyle = css(primary);
  c.fillRect(0, h * 0.664, w, h * 0.030);
  c.fillStyle = css(accent);
  c.fillRect(0, h * 0.700, w, h * 0.011);
  for (let k = 0; k < 3; k++) {
    flankText(c, team.sponsors[k + 1], w * (0.22 + k * 0.28), h * 0.736, h * 0.026,
      '#e8ecf2', 'v', 700, 0.10);
  }

  // Endplate margins stay dark: they sit in shadow and carry the FIA number panel.
  c.fillStyle = 'rgba(10,11,14,0.85)';
  c.fillRect(0, 0, w * 0.045, h);
  c.fillRect(w * 0.955, 0, w * 0.045, h);
}

/** Number panel + driver code, applied to the nose flanks and the mirror pods. */
function drawNumberPanel(c, w, h, driver) {
  const { primary, accent } = driver.team.colors;
  c.clearRect(0, 0, w, h);
  c.fillStyle = css(primary);
  c.fillRect(0, 0, w, h);
  c.fillStyle = css(accent);
  c.fillRect(0, h * 0.86, w, h * 0.14);
  flankText(c, String(driver.number), w * 0.5, h * 0.44, h * 0.68, inkFor(primary), 'none', 900, 0.0);
  flankText(c, driver.code, w * 0.5, h * 0.93, h * 0.13, inkFor(accent), 'none', 800, 0.16);
}

/**
 * Builds and owns every per-team texture and paint material. One instance lives on
 * CarManager; the twenty cars share ten livery sets between them.
 */
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
    this._anisotropy = Math.max(1, Math.min(ctx.quality?.anisotropy ?? 8,
      ctx.renderer?.capabilities?.getMaxAnisotropy?.() ?? 16));
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
      clearcoat: 1.0,
      clearcoatRoughness: 0.045,
      envMapIntensity: 1.15,
      ...params,
    });
    const flake = this.materials?.texture?.('livery_primary') ?? null;
    if (flake) {
      m.clearcoatNormalMap = flake;
      m.clearcoatNormalScale.set(0.26, 0.26);
    }
    this._materialsOwned.push(m);
    return m;
  }

  /** The full paint set for a team, cached by team id. */
  get(team) {
    const cached = this._sets.get(team.id);
    if (cached) return cached;

    const bodyCanvas = createCanvas(this._bodyW, this._bodyH);
    drawBodyWrap(bodyCanvas.getContext('2d'), this._bodyW, this._bodyH, team);
    const bodyTex = this._own(textureFromCanvas(bodyCanvas));
    // v runs around the section and crosses the seam under the floor, so it must repeat.
    bodyTex.wrapS = THREE.ClampToEdgeWrapping;
    bodyTex.wrapT = THREE.RepeatWrapping;

    const wingH = Math.max(64, Math.round(this._wingW * 0.25));
    const wingCanvas = createCanvas(this._wingW, wingH);
    drawWingWrap(wingCanvas.getContext('2d'), this._wingW, wingH, team);
    const wingTex = this._own(textureFromCanvas(wingCanvas));
    wingTex.wrapS = THREE.ClampToEdgeWrapping;
    wingTex.wrapT = THREE.ClampToEdgeWrapping;

    const mats = this.materials;
    const set = {
      team,
      colors: team.colors,
      bodyTexture: bodyTex,
      wingTexture: wingTex,
      body: this._paint({ map: bodyTex, color: 0xffffff }),
      // Wings are laid-up carbon with a satin lacquer, not show-car paint: much less
      // clearcoat than the bodywork, so they stay dark instead of mirroring the sky.
      wing: this._paint({
        map: wingTex, color: 0xffffff, roughness: 0.46,
        clearcoat: 0.45, clearcoatRoughness: 0.20, envMapIntensity: 0.95,
      }),
      // Floors, undertrays and the shark fin root are satin, not show-car gloss.
      matte: this._paint({
        color: new THREE.Color(team.colors.primary),
        roughness: 0.52, clearcoat: 0.35, clearcoatRoughness: 0.28, envMapIntensity: 1.0,
      }),
      accent: this._paint({ color: new THREE.Color(team.colors.accent), envMapIntensity: 1.35 }),
      dark: this._paint({
        color: new THREE.Color(team.colors.secondary),
        roughness: 0.38, clearcoatRoughness: 0.06,
      }),
      // Inlet throats and duct interiors: seen from the front they are backfaces, so
      // this one is double sided and almost black however bright the livery is.
      duct: this._paint({
        color: 0x090a0d, roughness: 0.82, metalness: 0.0,
        clearcoat: 0.12, clearcoatRoughness: 0.55,
        envMapIntensity: 0.35, side: THREE.DoubleSide,
      }),
      carbon: mats?.get('carbon_gloss') ?? this._paint({ color: 0x14151a }),
      carbonMatte: mats?.get('carbon_matte') ?? this._paint({ color: 0x14151a, clearcoat: 0.2 }),
      carbonWeave: mats?.get('carbon_weave') ?? this._paint({ color: 0x14151a }),
      metal: mats?.get('metal_anodised') ?? this._paint({ color: 0x8a8f96, metalness: 1 }),
      halo: mats?.get('halo') ?? this._paint({ color: 0x2a2c31, metalness: 1 }),
      suspension: mats?.get('suspension_arm') ?? this._paint({ color: 0xb8bcc4 }),
      exhaust: mats?.get('exhaust_metal') ?? this._paint({ color: 0x6a5a4a, metalness: 1 }),
      suit: this._suit(mats, team),
    };
    this._sets.set(team.id, set);
    return set;
  }

  /**
   * Race suit. The library's nomex carries a white sheen, which is right for a white
   * suit and wrong for a coloured one: at the grazing angles that dominate a cylinder
   * like an arm it washes the whole limb to grey. Tinting the sheen toward the team
   * colour keeps the arm reading as the driver's suit from every angle.
   */
  _suit(mats, team) {
    const base = mats?.makeLivery?.(team.colors)?.suit;
    if (!base) return this._paint({ color: new THREE.Color(team.colors.primary), clearcoat: 0.1, roughness: 0.7 });
    const suit = base.clone();
    suit.sheen = 0.30;
    suit.sheenRoughness = 0.86;
    suit.sheenColor = new THREE.Color(team.colors.primary).lerp(new THREE.Color(0xffffff), 0.30);
    this._materialsOwned.push(suit);
    return suit;
  }

  /** A small nose/mirror number decal for one driver, cached on the driver record. */
  numberDecal(driver) {
    if (driver._numberTexture) return driver._numberTexture;
    const w = 256;
    const h = 192;
    const canvas = createCanvas(w, h);
    drawNumberPanel(canvas.getContext('2d'), w, h, driver);
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
