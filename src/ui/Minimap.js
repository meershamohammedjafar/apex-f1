/**
 * Circuit map.
 *
 * The outline, the DRS zones, the sector ticks and the start/finish chequer never
 * change, so they are rendered once into an offscreen canvas and blitted each frame.
 * Only the twenty car dots are drawn live, which keeps the map at a handful of
 * microseconds per frame regardless of how detailed the outline is.
 *
 * North-up. World +X runs right across the map and world +Z runs down it, which is
 * the plan view you get looking straight down the world -Y axis.
 */

const SAMPLES = 720;
const PAD_METRES = 55;

// The map is read in a glance off a moving frame, so the outline carries the same
// contrast budget as the tower's text: a hard black casing under a near-opaque road.
const CASING = 'rgba(0, 0, 0, 0.85)';
const TARMAC = 'rgba(220, 226, 236, 0.72)';
const DRS_COLOUR = 'rgba(33, 209, 107, 0.95)';
const TICK_COLOUR = 'rgba(255, 255, 255, 0.6)';
const PLAYER_RING = '#ffffff';

function hexToCss(value, fallback) {
  if (typeof value === 'number') return `#${(value >>> 0).toString(16).padStart(6, '0')}`;
  if (typeof value === 'string') return value;
  return fallback;
}

function wrap01(t) {
  const u = t % 1;
  return u < 0 ? u + 1 : u;
}

export class Minimap {
  constructor(ctx, mount) {
    this.ctx = ctx;
    this.root = document.createElement('div');
    this.root.className = 'hud-minimap apex-panel apex-hud';

    this.canvas = document.createElement('canvas');
    this.canvas.width = 320;
    this.canvas.height = 320;
    this.g = this.canvas.getContext('2d');

    const caption = document.createElement('div');
    caption.className = 'mm-caption';
    this._name = document.createElement('span');
    this._name.className = 'name';
    caption.appendChild(this._name);

    this.root.append(this.canvas, caption);
    mount.appendChild(this.root);

    this._base = document.createElement('canvas');
    this._baseG = this._base.getContext('2d');

    this._mx = new Float32Array(SAMPLES);
    this._my = new Float32Array(SAMPLES);
    this._wx = new Float32Array(SAMPLES);
    this._wz = new Float32Array(SAMPLES);
    this._teamColours = null;
    this._dirX = 0;
    this._dirY = -1;

    this._bounds = { minX: 0, minZ: 0, spanX: 1, spanZ: 1 };
    this._built = false;
    this._dpr = 1;
    this._playerIndex = 0;
  }

  /** Sample the centreline once and cache the plan-view projection of every sample. */
  build(ctx) {
    const track = ctx.track;
    if (!track?.curve) return false;

    const scratch = track.surface?.createLocateResult?.() ?? track.sample(0);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;

    for (let i = 0; i < SAMPLES; i++) {
      const s = track.sample(i / SAMPLES, scratch);
      const x = s.position.x;
      const z = s.position.z;
      this._wx[i] = x;
      this._wz[i] = z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }

    const b = this._bounds;
    b.minX = minX - PAD_METRES;
    b.minZ = minZ - PAD_METRES;
    b.spanX = maxX - minX + PAD_METRES * 2;
    b.spanZ = maxZ - minZ + PAD_METRES * 2;

    this._name.textContent = track.circuit?.shortName ?? track.name ?? '';
    this._built = true;

    this._teamColours = new Array(ctx.cars?.cars?.length ?? 0);
    const cars = ctx.cars?.cars ?? null;
    if (cars) {
      for (let i = 0; i < cars.length; i++) {
        const colors = cars[i].driver?.team?.colors ?? cars[i].livery?.colors;
        this._teamColours[i] = hexToCss(colors?.primary, '#8a92a0');
      }
      this._playerIndex = ctx.cars.player?.index ?? 0;
    }

    this.resize();
    return true;
  }

  /**
   * Fit the backing store to the element and re-render the static layer. The canvas
   * aspect follows the circuit's own bounding box so Spa's long diagonal is not
   * squashed into a square.
   */
  resize() {
    if (!this._built) return;
    const cssWidth = this.canvas.clientWidth || this.root.clientWidth || 240;
    const dpr = Math.min(globalThis.devicePixelRatio ?? 1, 2);
    const b = this._bounds;
    const aspect = Math.min(1.45, Math.max(0.62, b.spanZ / b.spanX));

    const w = Math.max(64, Math.round(cssWidth * dpr));
    const h = Math.max(64, Math.round(cssWidth * aspect * dpr));
    if (this.canvas.width === w && this.canvas.height === h && this._dpr === dpr) return;

    this._dpr = dpr;
    this.canvas.width = w;
    this.canvas.height = h;
    this._base.width = w;
    this._base.height = h;

    // Uniform scale about the centre so the outline keeps its true proportions.
    const inset = Math.round(Math.min(w, h) * 0.11);
    const scale = Math.min((w - inset * 2) / b.spanX, (h - inset * 2) / b.spanZ);
    const offX = (w - b.spanX * scale) * 0.5;
    const offZ = (h - b.spanZ * scale) * 0.5;
    this._scale = scale;
    this._offX = offX;
    this._offZ = offZ;

    for (let i = 0; i < SAMPLES; i++) {
      this._mx[i] = offX + (this._wx[i] - b.minX) * scale;
      this._my[i] = offZ + (this._wz[i] - b.minZ) * scale;
    }

    this._renderBase();
  }

  _tracePath(g, from, to) {
    g.beginPath();
    let i = from;
    g.moveTo(this._mx[i], this._my[i]);
    // Walk forward with wraparound so a zone that straddles the start line is one run.
    for (let n = 0; n < SAMPLES; n++) {
      i = (i + 1) % SAMPLES;
      g.lineTo(this._mx[i], this._my[i]);
      if (i === to) break;
    }
  }

  _renderBase() {
    const g = this._baseG;
    const w = this._base.width;
    const h = this._base.height;
    const track = this.ctx.track;
    const lane = Math.max(2.4, Math.min(w, h) * 0.021);

    g.clearRect(0, 0, w, h);
    g.lineJoin = 'round';
    g.lineCap = 'round';

    g.beginPath();
    g.moveTo(this._mx[0], this._my[0]);
    for (let i = 1; i < SAMPLES; i++) g.lineTo(this._mx[i], this._my[i]);
    g.closePath();

    g.strokeStyle = CASING;
    g.lineWidth = lane * 2.0;
    g.stroke();
    g.strokeStyle = TARMAC;
    g.lineWidth = lane;
    g.stroke();

    // DRS zones are overdrawn on the same path, activation point to detection end.
    const zones = track?.drsZones ?? [];
    g.strokeStyle = DRS_COLOUR;
    g.lineWidth = lane * 1.5;
    for (let z = 0; z < zones.length; z++) {
      const from = Math.floor(wrap01(zones[z].start) * SAMPLES) % SAMPLES;
      const to = Math.floor(wrap01(zones[z].end) * SAMPLES) % SAMPLES;
      this._tracePath(g, from, to);
      g.stroke();
    }

    const sectors = track?.sectors ?? [0, 0.33, 0.66];
    g.strokeStyle = TICK_COLOUR;
    g.lineWidth = Math.max(1, lane * 0.35);
    for (let s = 1; s < sectors.length; s++) this._drawTick(g, sectors[s], lane * 2.3);

    this._drawStartLine(g, sectors[0] ?? 0, lane * 2.6);
    this._drawNorth(g, w, h);
  }

  /** A tick drawn across the road, perpendicular to the local centreline direction. */
  _drawTick(g, t, half) {
    const i = Math.floor(wrap01(t) * SAMPLES) % SAMPLES;
    const j = (i + 1) % SAMPLES;
    let dx = this._mx[j] - this._mx[i];
    let dy = this._my[j] - this._my[i];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    g.beginPath();
    g.moveTo(this._mx[i] - dy * half, this._my[i] + dx * half);
    g.lineTo(this._mx[i] + dy * half, this._my[i] - dx * half);
    g.stroke();
  }

  _drawStartLine(g, t, half) {
    const i = Math.floor(wrap01(t) * SAMPLES) % SAMPLES;
    const j = (i + 1) % SAMPLES;
    let dx = this._mx[j] - this._mx[i];
    let dy = this._my[j] - this._my[i];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const cells = 6;
    const step = (half * 2) / cells;
    const cell = Math.max(1.4, step * 0.9);
    for (let c = 0; c < cells; c++) {
      const d = -half + step * (c + 0.5);
      const px = this._mx[i] - dy * d;
      const py = this._my[i] + dx * d;
      g.fillStyle = c % 2 === 0 ? '#ffffff' : '#0a0a0c';
      g.save();
      g.translate(px, py);
      g.rotate(Math.atan2(dy, dx));
      g.fillRect(-cell * 0.5, -cell * 0.5, cell, cell);
      g.restore();
    }
  }

  _drawNorth(g, w, h) {
    const r = Math.min(w, h) * 0.045;
    const cx = w - r * 2.1;
    const cy = r * 2.1;
    g.save();
    g.strokeStyle = 'rgba(255,255,255,0.3)';
    g.fillStyle = 'rgba(255,255,255,0.62)';
    g.lineWidth = Math.max(1, r * 0.12);
    g.beginPath();
    g.moveTo(cx, cy - r);
    g.lineTo(cx + r * 0.62, cy + r * 0.72);
    g.lineTo(cx, cy + r * 0.3);
    g.lineTo(cx - r * 0.62, cy + r * 0.72);
    g.closePath();
    g.fill();
    g.restore();
  }

  /** Per-frame layer: blit the static map, then the field on top of it. */
  draw(ctx) {
    if (!this._built) return;
    const g = this.g;
    const w = this.canvas.width;
    const h = this.canvas.height;
    g.clearRect(0, 0, w, h);
    g.drawImage(this._base, 0, 0);

    const cars = ctx.cars?.cars;
    if (!cars) return;

    const r = Math.max(2.2, Math.min(w, h) * 0.017);
    const player = this._playerIndex;

    for (let i = 0; i < cars.length; i++) {
      if (i === player) continue;
      const state = cars[i].physics?.state;
      if (!state) continue;
      const x = this._offX + (state.position.x - this._bounds.minX) * this._scale;
      const y = this._offZ + (state.position.z - this._bounds.minZ) * this._scale;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = this._teamColours?.[i] ?? '#8a92a0';
      g.fill();
      g.lineWidth = Math.max(1, r * 0.32);
      g.strokeStyle = 'rgba(0,0,0,0.72)';
      g.stroke();
    }

    const me = cars[player]?.physics?.state;
    if (!me) return;
    const px = this._offX + (me.position.x - this._bounds.minX) * this._scale;
    const py = this._offZ + (me.position.z - this._bounds.minZ) * this._scale;

    // The heading tick follows velocity, holding its last direction when nearly stopped
    // so it does not spin on the grid.
    const vx = me.velocity.x;
    const vz = me.velocity.z;
    const vlen = Math.hypot(vx, vz);
    if (vlen > 2) {
      this._dirX = vx / vlen;
      this._dirY = vz / vlen;
    }

    const pr = r * 1.75;
    g.beginPath();
    g.moveTo(px + this._dirX * pr * 2.4, py + this._dirY * pr * 2.4);
    g.lineTo(px, py);
    g.lineWidth = Math.max(1.2, r * 0.5);
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.stroke();

    g.beginPath();
    g.arc(px, py, pr, 0, Math.PI * 2);
    g.fillStyle = this._teamColours?.[player] ?? '#e10600';
    g.fill();
    g.lineWidth = Math.max(1.4, r * 0.45);
    g.strokeStyle = PLAYER_RING;
    g.stroke();
  }

  setVisible(v) {
    this.root.classList.toggle('is-hidden', !v);
  }

  dispose() {
    this.root.remove();
    this._base.width = 0;
    this._base.height = 0;
    this.canvas.width = 0;
    this.canvas.height = 0;
  }
}
