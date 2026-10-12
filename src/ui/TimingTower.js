const ROWS = 20;
const VIEW = 9;
const WINDOW_LEAD = 3;
const BREAK_SLOT = 1;
const SUB = VIEW - 2;
const SUB_LEAD = 2;
const SLOT_TRANSFORM = Array.from(
  { length: VIEW },
  (_, s) => `translate3d(0, calc((var(--tt-row) + var(--tt-gap)) * ${s}), 0)`
);
const TEXT_HZ = 10;
const FLARE_SECONDS = 1.25;
const HIDDEN = -1;
const COMPOUND_STYLE = {
  soft: { ring: "#e8112d", letter: "S" },
  medium: { ring: "#f5c400", letter: "M" },
  hard: { ring: "#eceff3", letter: "H" },
  intermediate: { ring: "#21d16b", letter: "I" },
  wet: { ring: "#1f6fe0", letter: "W" }
};
const SECTOR_CLASS = ["sector", "sector s-purple", "sector s-green", "sector s-yellow", "sector s-white"];
const SECTOR_CODE = { purple: 1, green: 2, yellow: 3, white: 4 };
const GAP_LEADER = -1;
const GAP_OUT = -2;
const GAP_NONE = -3;
function parseRgb(value, out) {
  if (typeof value === "number") {
    out[0] = value >>> 16 & 255;
    out[1] = value >>> 8 & 255;
    out[2] = value & 255;
    return true;
  }
  if (typeof value === "string" && value.charCodeAt(0) === 35) {
    if (value.length === 7) {
      out[0] = parseInt(value.slice(1, 3), 16);
      out[1] = parseInt(value.slice(3, 5), 16);
      out[2] = parseInt(value.slice(5, 7), 16);
      return Number.isFinite(out[0]) && Number.isFinite(out[1]) && Number.isFinite(out[2]);
    }
    if (value.length === 4) {
      out[0] = parseInt(value[1] + value[1], 16);
      out[1] = parseInt(value[2] + value[2], 16);
      out[2] = parseInt(value[3] + value[3], 16);
      return Number.isFinite(out[0]) && Number.isFinite(out[1]) && Number.isFinite(out[2]);
    }
  }
  return false;
}
function srgbToLinear(c) {
  const u = c / 255;
  return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
}
function luminance(r, g, b) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}
const BAR_MIN_LUMINANCE = 0.11;
const _rgb = [0, 0, 0];
const _hsl = [0, 0, 0];
function rgbToHsl(r, g, b, out) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) * 0.5;
  const d = max - min;
  let h = 0;
  let sat = 0;
  if (d > 1e-6) {
    sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h /= 6;
  }
  out[0] = h;
  out[1] = sat;
  out[2] = l;
}
function hueToChannel(p, q, t) {
  let u = t;
  if (u < 0) u += 1;
  if (u > 1) u -= 1;
  if (u < 1 / 6) return p + (q - p) * 6 * u;
  if (u < 0.5) return q;
  if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
  return p;
}
function hslToRgb(h, sat, l, out) {
  if (sat <= 1e-6) {
    const v = Math.round(l * 255);
    out[0] = v;
    out[1] = v;
    out[2] = v;
    return;
  }
  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat;
  const p = 2 * l - q;
  out[0] = Math.round(hueToChannel(p, q, h + 1 / 3) * 255);
  out[1] = Math.round(hueToChannel(p, q, h) * 255);
  out[2] = Math.round(hueToChannel(p, q, h - 1 / 3) * 255);
}
function readableBar(value, fallback) {
  if (!parseRgb(value, _rgb)) return typeof value === "string" ? value : fallback;
  if (luminance(_rgb[0], _rgb[1], _rgb[2]) >= BAR_MIN_LUMINANCE) {
    return `rgb(${_rgb[0]},${_rgb[1]},${_rgb[2]})`;
  }
  rgbToHsl(_rgb[0], _rgb[1], _rgb[2], _hsl);
  let lo = _hsl[2];
  let hi = 1;
  for (let i = 0; i < 8; i++) {
    const mid = (lo + hi) * 0.5;
    hslToRgb(_hsl[0], _hsl[1], mid, _rgb);
    if (luminance(_rgb[0], _rgb[1], _rgb[2]) < BAR_MIN_LUMINANCE) lo = mid;
    else hi = mid;
  }
  hslToRgb(_hsl[0], _hsl[1], hi, _rgb);
  return `rgb(${_rgb[0]},${_rgb[1]},${_rgb[2]})`;
}
function teamColour(entry) {
  const car = entry?.car;
  const colors = entry?.driver?.team?.colors ?? car?.driver?.team?.colors ?? car?.livery?.colors;
  return readableBar(colors?.primary, "#8a929e");
}
const POS_TEXT = Array.from({ length: ROWS }, (_, i) => String(i + 1));
function formatTowerGap(quantised) {
  if (quantised === GAP_NONE) return "—";
  if (quantised === GAP_OUT) return "OUT";
  if (quantised === GAP_LEADER) return "LEADER";
  if (quantised <= -100) {
    const laps = -100 - quantised;
    return laps === 1 ? "+1 LAP" : `+${laps} LAPS`;
  }
  const seconds = quantised / 1e3;
  if (seconds >= 100) return `+${seconds.toFixed(1)}`;
  return `+${seconds.toFixed(3)}`;
}
function compoundOf(entry) {
  const cfg = entry?.car?.physics?.config?.tyres;
  return COMPOUND_STYLE[cfg?.compound] ?? COMPOUND_STYLE.medium;
}
export class TimingTower {
  constructor(ctx, mount) {
    this.ctx = ctx;
    this.root = document.createElement("div");
    this.root.className = "hud-tower apex-hud";
    const head = document.createElement("div");
    head.className = "tt-head apex-panel";
    this._title = document.createElement("span");
    this._title.className = "title";
    this._title.textContent = "Live Timing";
    this._sub = document.createElement("span");
    this._sub.className = "sub";
    this._sub.textContent = "";
    head.append(this._title, this._sub);
    this._body = document.createElement("div");
    this._body.className = "tt-body";
    this.root.append(head, this._body);
    mount.appendChild(this.root);
    this._break = document.createElement("div");
    this._break.className = "tt-break";
    this._break.style.transform = SLOT_TRANSFORM[BREAK_SLOT];
    this._break.style.visibility = "hidden";
    for (let d = 0; d < 3; d++) this._break.appendChild(document.createElement("i"));
    this._body.appendChild(this._break);
    this._rows = [];
    this._slot = new Int8Array(ROWS).fill(HIDDEN);
    this._place = new Int8Array(ROWS).fill(-1);
    this._seen = new Uint8Array(ROWS);
    this._gapKey = new Float64Array(ROWS).fill(NaN);
    this._flare = new Float32Array(ROWS);
    this._compound = new Array(ROWS).fill("");
    this._codeText = new Array(ROWS).fill("");
    this._sectorKey = new Int16Array(ROWS).fill(-1);
    this._pitState = new Uint8Array(ROWS);
    this._flagState = new Array(ROWS).fill("");
    this._retired = new Uint8Array(ROWS);
    for (let i = 0; i < ROWS; i++) this._rows.push(this._buildRow(i));
    this._textTimer = 0;
    this._subKey = "";
    this._bound = false;
    this._playerIndex = 0;
    this._windowStart = 0;
    this._cut = false;
    this._cutShown = false;
    this.root.style.setProperty("--tt-rows", String(VIEW));
  }
  _buildRow(i) {
    const el = document.createElement("div");
    el.className = "tt-row";
    el.style.transform = "translate3d(0, 0, 0)";
    el.style.visibility = "hidden";
    const pos = document.createElement("span");
    pos.className = "pos";
    const team = document.createElement("span");
    team.className = "team";
    const code = document.createElement("span");
    code.className = "code";
    const marks = document.createElement("span");
    marks.className = "marks";
    const sectors = [];
    for (let s = 0; s < 3; s++) {
      const pip = document.createElement("i");
      pip.className = SECTOR_CLASS[0];
      marks.appendChild(pip);
      sectors.push(pip);
    }
    const tyre = document.createElement("i");
    tyre.className = "tyre";
    const pit = document.createElement("i");
    pit.className = "pit";
    pit.textContent = "PIT";
    marks.append(tyre, pit);
    const gap = document.createElement("span");
    gap.className = "gap";
    el.append(pos, team, code, marks, gap);
    this._body.appendChild(el);
    return { el, pos, team, code, tyre, pit, gap, sectors };
  }
  _bind(ctx) {
    const player = ctx.cars?.player ?? ctx.cars?.cars?.[0] ?? null;
    const index = player?.index ?? 0;
    this._playerIndex = index >= 0 && index < ROWS ? index : 0;
    this._bound = true;
  }
  _layout(standings, count) {
    let place = this._place[this._playerIndex];
    if (place < 0 || place >= count) {
      place = 0;
      for (let k = 0; k < count; k++) {
        if (standings[k].index === this._playerIndex) {
          place = k;
          break;
        }
      }
    }
    if (count <= VIEW) {
      this._windowStart = 0;
      this._cut = false;
      return;
    }
    let start = place - WINDOW_LEAD;
    const last = count - VIEW;
    if (start > last) start = last;
    if (start <= 1) {
      this._windowStart = 0;
      this._cut = false;
      return;
    }
    start = place - SUB_LEAD;
    const subLast = count - SUB;
    if (start > subLast) start = subLast;
    if (start < 2) start = 2;
    this._windowStart = start;
    this._cut = true;
  }
  _slotFor(k, start, end) {
    if (!this._cut) return k < VIEW ? k : HIDDEN;
    if (k === 0) return 0;
    return k >= start && k < end ? k - start + BREAK_SLOT + 1 : HIDDEN;
  }
  update(dt, ctx) {
    const standings = ctx.race?.standings;
    if (!standings || standings.length === 0) return;
    if (!this._bound) this._bind(ctx);
    const count = Math.min(standings.length, ROWS);
    this._layout(standings, count);
    const start = this._windowStart;
    const end = start + SUB;
    if (this._cut !== this._cutShown) {
      this._cutShown = this._cut;
      this._break.style.visibility = this._cut ? "visible" : "hidden";
    }
    this._seen.fill(0);
    for (let k = 0; k < count; k++) {
      const entry = standings[k];
      const i = entry.index;
      if (i < 0 || i >= ROWS) continue;
      const row = this._rows[i];
      this._seen[i] = 1;
      const slot = this._slotFor(k, start, end);
      if (this._place[i] !== k) {
        const previous = this._place[i];
        this._place[i] = k;
        row.pos.textContent = POS_TEXT[k];
        row.el.classList.toggle("is-leader", k === 0);
        if (previous >= 0 && previous !== k && slot !== HIDDEN) {
          row.el.classList.remove("gained", "lost");
          row.el.classList.add(previous > k ? "gained" : "lost");
          this._flare[i] = FLARE_SECONDS;
        }
      }
      if (this._slot[i] !== slot) {
        const wasHidden = this._slot[i] === HIDDEN;
        this._slot[i] = slot;
        if (slot === HIDDEN) {
          row.el.style.visibility = "hidden";
          row.el.classList.remove("gained", "lost");
          this._flare[i] = 0;
        } else {
          row.el.style.transform = SLOT_TRANSFORM[slot];
          if (wasHidden) {
            row.el.style.visibility = "visible";
            row.el.classList.toggle("is-player", i === this._playerIndex);
            row.team.style.background = teamColour(entry);
          }
        }
      }
      if (this._flare[i] > 0) {
        this._flare[i] -= dt;
        if (this._flare[i] <= 0) {
          row.el.classList.remove("gained", "lost");
        }
      }
    }
    for (let i = 0; i < ROWS; i++) {
      if (this._seen[i] || this._slot[i] === HIDDEN) continue;
      this._slot[i] = HIDDEN;
      this._place[i] = -1;
      this._flare[i] = 0;
      this._rows[i].el.style.visibility = "hidden";
      this._rows[i].el.classList.remove("gained", "lost");
    }
    this._textTimer += dt;
    if (this._textTimer < 1 / TEXT_HZ) return;
    this._textTimer = 0;
    this._refreshText(ctx, standings);
  }
  _refreshText(ctx, standings) {
    const session = ctx.race?.session;
    if (session) {
      const total = session.totalLaps > 0 ? `/${session.totalLaps}` : "";
      const key = `${session.name}|${session.lap}${total}`;
      if (key !== this._subKey) {
        this._subKey = key;
        this._sub.textContent = `${session.name} · Lap ${session.lap}${total}`;
      }
    }
    if (this._cut) this._refreshRow(standings[0], 0);
    const start = this._cut ? this._windowStart : 0;
    const end = start + (this._cut ? SUB : VIEW);
    for (let k = start; k < end && k < standings.length && k < ROWS; k++) {
      this._refreshRow(standings[k], k);
    }
  }
  _refreshRow(entry, k) {
    const i = entry.index;
    if (i < 0 || i >= ROWS) return;
    const row = this._rows[i];
    const code = entry.code || entry.name || "";
    if (code !== this._codeText[i]) {
      this._codeText[i] = code;
      row.code.textContent = code;
    }
    const comp = compoundOf(entry);
    if (comp.letter !== this._compound[i]) {
      this._compound[i] = comp.letter;
      row.tyre.style.borderColor = comp.ring;
      row.tyre.style.color = comp.ring;
      row.tyre.textContent = comp.letter;
    }
    const retired = entry.retired ? 1 : 0;
    if (retired !== this._retired[i]) {
      this._retired[i] = retired;
      row.el.classList.toggle("is-retired", !!retired);
    }
    const pitting = entry.car?.physics?.state?.pitLimiter ? 1 : 0;
    if (pitting !== this._pitState[i]) {
      this._pitState[i] = pitting;
      row.el.classList.toggle("in-pit", !!pitting);
    }
    const flag = entry.flag ?? "green";
    if (flag !== this._flagState[i]) {
      this._flagState[i] = flag;
      row.el.classList.toggle("flag-blue", flag === "blue");
    }
    const sc = entry.sectorColours;
    const st = entry.sectors;
    if (sc && st) {
      const key = (st[0] > 0 ? SECTOR_CODE[sc[0]] ?? 4 : 0) | (st[1] > 0 ? SECTOR_CODE[sc[1]] ?? 4 : 0) << 3 | (st[2] > 0 ? SECTOR_CODE[sc[2]] ?? 4 : 0) << 6;
      if (key !== this._sectorKey[i]) {
        this._sectorKey[i] = key;
        row.sectors[0].className = SECTOR_CLASS[key & 7];
        row.sectors[1].className = SECTOR_CLASS[key >> 3 & 7];
        row.sectors[2].className = SECTOR_CLASS[key >> 6 & 7];
      }
    }
    let quantised;
    if (retired) quantised = GAP_OUT;
    else if (k === 0) quantised = GAP_LEADER;
    else if (!Number.isFinite(entry.gap)) quantised = GAP_NONE;
    else if (entry.lapsDown > 0) quantised = -100 - entry.lapsDown;
    else quantised = Math.round(entry.gap * 1e3);
    if (quantised !== this._gapKey[i]) {
      this._gapKey[i] = quantised;
      row.gap.textContent = formatTowerGap(quantised);
      row.gap.classList.toggle("no-data", quantised === GAP_NONE);
    }
  }
  setVisible(v) {
    this.root.classList.toggle("is-hidden", !v);
  }
  dispose() {
    this.root.remove();
    this._rows.length = 0;
  }
}
