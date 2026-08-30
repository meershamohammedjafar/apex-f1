/**
 * The broadcast timing tower.
 *
 * One row element per car, created once and never reordered in the DOM. Position is
 * expressed purely as a `translateY`, so when the classification changes the browser
 * animates the row from where it was to where it now belongs — the slide a real F1
 * tower does — instead of the snap you get from re-appending nodes.
 *
 * Everything else is written only when the underlying number actually changes, which
 * keeps the tower off the layout critical path at 20 cars x 60 fps.
 */

const ROWS = 20;

/*
 * How many of those rows are on screen at once.
 *
 * A twenty-row tower is a full-screen classification graphic, not an in-car overlay.
 * Printed at the size a broadcast tower has to be read at, twenty rows stood 589 px tall
 * on a 1080 frame — 55 % of the picture, down the side the driver is looking through —
 * and most of them were describing a race the player is nowhere near. Every simulator
 * that ships this overlay in the car shows a window instead, and so does the lower third
 * of a television feed.
 *
 * What a window must never do is drop the leader. That is the tower's first job: the
 * previous package anchored all nine rows on the player, so from P6 back the graphic
 * stopped naming the car leading the race. A broadcast tower solves this by cutting,
 * not by scrolling — the leader is pinned to the top, the rows around the player run
 * below it, and a break marks the positions the cut swallowed.
 */
const VIEW = 9;          // slots on the plate, cut or uncut

/* Uncut: the top VIEW rows, which is what the tower shows while the player is in them. */
const WINDOW_LEAD = 3;   // rows the player is allowed to sit behind before the cut opens

/*
 * Cut: slot 0 is the leader, slot 1 is the break, and the remaining rows are the window.
 * Two ahead of the player leaves the cars being chased on the plate and four behind it
 * the ones doing the chasing, which is the part of the order that can still change.
 */
const BREAK_SLOT = 1;
const SUB = VIEW - 2;
const SUB_LEAD = 2;

/**
 * Row transforms, one per slot, built once.
 *
 * The slide between slots is a CSS transition on `transform`, so the value has to be a
 * string; composing it per placement would allocate inside update(). There are only VIEW
 * of them and they never change, so they are strings the tower already owns.
 */
const SLOT_TRANSFORM = Array.from(
  { length: VIEW },
  (_, s) => `translate3d(0, calc((var(--tt-row) + var(--tt-gap)) * ${s}), 0)`,
);

const TEXT_HZ = 10;
const FLARE_SECONDS = 1.25;

/** Slot value for a row that is outside the window and therefore not rendered. */
const HIDDEN = -1;

/**
 * Pirelli band colours, matched to the compounds in CarConfig. The letter is drawn in
 * the pip: at tower scale a hollow ring is a coloured dot and nothing more, and soft
 * red against wet blue is the only pair of these five a viewer can separate by hue
 * alone at a glance. The glyph is what makes the marker readable.
 */
const COMPOUND_STYLE = {
  soft: { ring: '#e8112d', letter: 'S' },
  medium: { ring: '#f5c400', letter: 'M' },
  hard: { ring: '#eceff3', letter: 'H' },
  intermediate: { ring: '#21d16b', letter: 'I' },
  wet: { ring: '#1f6fe0', letter: 'W' },
};

/*
 * A sector pip has four set states and one unset state, and the unset state is not a
 * colour — it is the absence of a time. Index 0 is the bare `sector` class, which the
 * stylesheet draws as a hollow slot, so a car that has not yet crossed a timing line
 * cannot be mistaken for one that has.
 */
const SECTOR_CLASS = ['sector', 'sector s-purple', 'sector s-green', 'sector s-yellow', 'sector s-white'];
const SECTOR_CODE = { purple: 1, green: 2, yellow: 3, white: 4 };

/** Gap states that are not a measured interval. */
const GAP_LEADER = -1;
const GAP_OUT = -2;
const GAP_NONE = -3;

/**
 * An interval is only printed when RaceDirector actually measured one. It publishes NaN
 * whenever there is no honest answer — no progress history yet, or a field too slow for
 * a distance to convert into a time — and a dash is the right reading of that.
 *
 * Finiteness is the whole test, deliberately: on the grid and through the countdown the
 * director publishes the qualifying deltas the field formed up with, which is exactly
 * what a pre-race tower shows, so gating on session state as well would throw away real
 * intervals and leave twenty rows of dashes in the shot that matters most.
 */

function parseRgb(value, out) {
  if (typeof value === 'number') {
    out[0] = (value >>> 16) & 255;
    out[1] = (value >>> 8) & 255;
    out[2] = value & 255;
    return true;
  }
  if (typeof value === 'string' && value.charCodeAt(0) === 35 /* # */) {
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

/* Hoisted rather than nested inside luminance(): teamColour is reached from update(). */
function srgbToLinear(c) {
  const u = c / 255;
  return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4;
}

/** sRGB relative luminance, 0..1, for the readability floor below. */
function luminance(r, g, b) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/*
 * The team bar is six pixels of colour on a near-black plate, and a midnight-blue or a
 * bottle-green livery at its literal hex value simply disappears there — the tower ends
 * up with rows that look like they have no team at all.
 *
 * The lift is done in HSL, raising lightness only. Blending toward white would clear the
 * same floor but would wash the saturation out with it, and two desaturated bars are far
 * harder to tell apart than two bright ones: hue and saturation are the identity, and
 * they survive this untouched.
 *
 * 0.11 relative luminance puts a solid bar near 3:1 against the plate, which is the
 * threshold a non-text graphic has to clear to be seen at a glance at 1080p.
 */
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
  if (!parseRgb(value, _rgb)) return typeof value === 'string' ? value : fallback;
  if (luminance(_rgb[0], _rgb[1], _rgb[2]) >= BAR_MIN_LUMINANCE) {
    return `rgb(${_rgb[0]},${_rgb[1]},${_rgb[2]})`;
  }
  rgbToHsl(_rgb[0], _rgb[1], _rgb[2], _hsl);
  // Luminance rises monotonically with lightness at fixed hue and saturation, so eight
  // bisections resolve the crossing to well inside one 8-bit step. Runs once per car.
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
  return readableBar(colors?.primary, '#8a929e');
}

/** Position labels are fixed strings; building them once removes 20 allocations a lap. */
const POS_TEXT = Array.from({ length: ROWS }, (_, i) => String(i + 1));

function formatTowerGap(quantised) {
  if (quantised === GAP_NONE) return '\u2014';
  if (quantised === GAP_OUT) return 'OUT';
  if (quantised === GAP_LEADER) return 'LEADER';
  if (quantised <= -100) {
    const laps = -100 - quantised;
    return laps === 1 ? '+1 LAP' : `+${laps} LAPS`;
  }
  const seconds = quantised / 1000;
  if (seconds >= 100) return `+${seconds.toFixed(1)}`;
  return `+${seconds.toFixed(3)}`;
}

function compoundOf(entry) {
  const cfg = entry?.car?.physics?.config?.tyres;
  return COMPOUND_STYLE[cfg?.compound] ?? COMPOUND_STYLE.medium;
}

export class TimingTower {
  /**
   * @param {object} ctx  shared engine context
   * @param {HTMLElement} mount  container the tower attaches itself to
   */
  constructor(ctx, mount) {
    this.ctx = ctx;
    this.root = document.createElement('div');
    this.root.className = 'hud-tower apex-hud';

    const head = document.createElement('div');
    head.className = 'tt-head apex-panel';
    this._title = document.createElement('span');
    this._title.className = 'title';
    this._title.textContent = 'Live Timing';
    this._sub = document.createElement('span');
    this._sub.className = 'sub';
    this._sub.textContent = '';
    head.append(this._title, this._sub);

    this._body = document.createElement('div');
    this._body.className = 'tt-body';

    this.root.append(head, this._body);
    mount.appendChild(this.root);

    /*
     * The cut marker. Three dots on an unlit row: the plate shows through where a car
     * row would have laid its own gradient, so the break reads as missing rows rather
     * than as a car with no data. It lives at a fixed slot and is only ever shown or
     * hidden, so it costs nothing per frame.
     */
    this._break = document.createElement('div');
    this._break.className = 'tt-break';
    this._break.style.transform = SLOT_TRANSFORM[BREAK_SLOT];
    this._break.style.visibility = 'hidden';
    for (let d = 0; d < 3; d++) this._break.appendChild(document.createElement('i'));
    this._body.appendChild(this._break);

    // Per-row cached state. Parallel typed/plain arrays rather than objects in a Map so
    // the per-frame comparison loop touches contiguous memory and allocates nothing.
    this._rows = [];
    /** Window slot each row currently occupies, or HIDDEN. */
    this._slot = new Int8Array(ROWS).fill(HIDDEN);
    /** Classification position each row currently shows, independent of the window. */
    this._place = new Int8Array(ROWS).fill(-1);
    /** Rows the classification named this tick; the rest are taken off the plate. */
    this._seen = new Uint8Array(ROWS);
    this._gapKey = new Float64Array(ROWS).fill(NaN);
    this._flare = new Float32Array(ROWS);
    this._compound = new Array(ROWS).fill('');
    this._codeText = new Array(ROWS).fill('');
    this._sectorKey = new Int16Array(ROWS).fill(-1);
    this._pitState = new Uint8Array(ROWS);
    this._flagState = new Array(ROWS).fill('');
    this._retired = new Uint8Array(ROWS);

    for (let i = 0; i < ROWS; i++) this._rows.push(this._buildRow(i));

    this._textTimer = 0;
    this._subKey = '';
    this._bound = false;
    this._playerIndex = 0;
    this._windowStart = 0;
    /** True when the leader is pinned above a break rather than being part of the run. */
    this._cut = false;
    this._cutShown = false;

    // The stylesheet sizes the body off this, so the window length is declared in one
    // place and the plate can never be taller or shorter than the rows it carries.
    this.root.style.setProperty('--tt-rows', String(VIEW));
  }

  _buildRow(i) {
    const el = document.createElement('div');
    el.className = 'tt-row';
    el.style.transform = 'translate3d(0, 0, 0)';
    el.style.visibility = 'hidden';

    const pos = document.createElement('span');
    pos.className = 'pos';

    const team = document.createElement('span');
    team.className = 'team';

    const code = document.createElement('span');
    code.className = 'code';

    const marks = document.createElement('span');
    marks.className = 'marks';
    const sectors = [];
    for (let s = 0; s < 3; s++) {
      const pip = document.createElement('i');
      pip.className = SECTOR_CLASS[0];
      marks.appendChild(pip);
      sectors.push(pip);
    }
    const tyre = document.createElement('i');
    tyre.className = 'tyre';
    const pit = document.createElement('i');
    pit.className = 'pit';
    pit.textContent = 'PIT';
    marks.append(tyre, pit);

    const gap = document.createElement('span');
    gap.className = 'gap';

    el.append(pos, team, code, marks, gap);
    this._body.appendChild(el);
    return { el, pos, team, code, tyre, pit, gap, sectors };
  }

  /** Cars are not on ctx until CarManager has run, so binding is deferred to first use. */
  _bind(ctx) {
    const player = ctx.cars?.player ?? ctx.cars?.cars?.[0] ?? null;
    const index = player?.index ?? 0;
    this._playerIndex = index >= 0 && index < ROWS ? index : 0;
    this._bound = true;
  }

  /**
   * Decide what the plate shows this tick: the top of the classification, or the leader
   * over a break over a window around the player.
   *
   * Writes `_windowStart` (first classification position of the run below the break, or
   * 0 when there is no break) and `_cut`.
   */
  _layout(standings, count) {
    let place = this._place[this._playerIndex];
    if (place < 0 || place >= count) {
      place = 0;
      for (let k = 0; k < count; k++) {
        if (standings[k].index === this._playerIndex) { place = k; break; }
      }
    }

    // A field that fits on the plate is never cut.
    if (count <= VIEW) {
      this._windowStart = 0;
      this._cut = false;
      return;
    }

    // Where an uncut window would have to start to keep the player `WINDOW_LEAD` rows
    // down it. If that is the top of the field — or one row off it, which would cut a
    // single position and spend a whole row saying so — the tower runs uncut from P1.
    let start = place - WINDOW_LEAD;
    const last = count - VIEW;
    if (start > last) start = last;
    if (start <= 1) {
      this._windowStart = 0;
      this._cut = false;
      return;
    }

    // Cut. The leader takes slot 0 and the break slot 1, so the run below it is SUB rows
    // long and starts no higher than P2 — the leader is never printed twice.
    start = place - SUB_LEAD;
    const subLast = count - SUB;
    if (start > subLast) start = subLast;
    if (start < 2) start = 2;
    this._windowStart = start;
    this._cut = true;
  }

  /** Slot for classification position `k` under the current layout, or HIDDEN. */
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
      this._break.style.visibility = this._cut ? 'visible' : 'hidden';
    }
    this._seen.fill(0);

    // Placement runs every tick: a change must start its transition the instant it
    // happens, or the slide lags the overtake it is describing.
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
        row.el.classList.toggle('is-leader', k === 0);
        if (previous >= 0 && previous !== k && slot !== HIDDEN) {
          row.el.classList.remove('gained', 'lost');
          row.el.classList.add(previous > k ? 'gained' : 'lost');
          this._flare[i] = FLARE_SECONDS;
        }
      }

      if (this._slot[i] !== slot) {
        const wasHidden = this._slot[i] === HIDDEN;
        this._slot[i] = slot;
        if (slot === HIDDEN) {
          // Hide without moving it: a row leaving the window must not slide the length
          // of the tower on its way out.
          row.el.style.visibility = 'hidden';
          row.el.classList.remove('gained', 'lost');
          this._flare[i] = 0;
        } else {
          row.el.style.transform = SLOT_TRANSFORM[slot];
          if (wasHidden) {
            row.el.style.visibility = 'visible';
            row.el.classList.toggle('is-player', i === this._playerIndex);
            row.team.style.background = teamColour(entry);
          }
        }
      }

      if (this._flare[i] > 0) {
        this._flare[i] -= dt;
        if (this._flare[i] <= 0) {
          row.el.classList.remove('gained', 'lost');
        }
      }
    }

    // A car the classification stopped naming — withdrawn, or a field that shrank — must
    // give its slot back, or its row sits on top of a live one for the rest of the race.
    for (let i = 0; i < ROWS; i++) {
      if (this._seen[i] || this._slot[i] === HIDDEN) continue;
      this._slot[i] = HIDDEN;
      this._place[i] = -1;
      this._flare[i] = 0;
      this._rows[i].el.style.visibility = 'hidden';
      this._rows[i].el.classList.remove('gained', 'lost');
    }

    this._textTimer += dt;
    if (this._textTimer < 1 / TEXT_HZ) return;
    this._textTimer = 0;
    this._refreshText(ctx, standings);
  }

  _refreshText(ctx, standings) {
    const session = ctx.race?.session;
    if (session) {
      const total = session.totalLaps > 0 ? `/${session.totalLaps}` : '';
      const key = `${session.name}|${session.lap}${total}`;
      if (key !== this._subKey) {
        this._subKey = key;
        this._sub.textContent = `${session.name} · Lap ${session.lap}${total}`;
      }
    }

    // The pinned leader is refreshed alongside the run below the break; it is on the
    // plate, so its interval, compound and sector pips have to stay live.
    if (this._cut) this._refreshRow(standings[0], 0);

    const start = this._cut ? this._windowStart : 0;
    const end = start + (this._cut ? SUB : VIEW);
    for (let k = start; k < end && k < standings.length && k < ROWS; k++) {
      this._refreshRow(standings[k], k);
    }
  }

  /** Write the slow-moving text of one classification row. Allocation-free. */
  _refreshRow(entry, k) {
    const i = entry.index;
    if (i < 0 || i >= ROWS) return;
    const row = this._rows[i];

    const code = entry.code || entry.name || '';
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
      row.el.classList.toggle('is-retired', !!retired);
    }

    const pitting = entry.car?.physics?.state?.pitLimiter ? 1 : 0;
    if (pitting !== this._pitState[i]) {
      this._pitState[i] = pitting;
      row.el.classList.toggle('in-pit', !!pitting);
    }

    const flag = entry.flag ?? 'green';
    if (flag !== this._flagState[i]) {
      this._flagState[i] = flag;
      row.el.classList.toggle('flag-blue', flag === 'blue');
    }

    // A sector is only coloured once RaceDirector has actually written a time into
    // it; three codes packed into one int compare with no allocation at all.
    const sc = entry.sectorColours;
    const st = entry.sectors;
    if (sc && st) {
      const key = (st[0] > 0 ? SECTOR_CODE[sc[0]] ?? 4 : 0)
        | ((st[1] > 0 ? SECTOR_CODE[sc[1]] ?? 4 : 0) << 3)
        | ((st[2] > 0 ? SECTOR_CODE[sc[2]] ?? 4 : 0) << 6);
      if (key !== this._sectorKey[i]) {
        this._sectorKey[i] = key;
        row.sectors[0].className = SECTOR_CLASS[key & 7];
        row.sectors[1].className = SECTOR_CLASS[(key >> 3) & 7];
        row.sectors[2].className = SECTOR_CLASS[(key >> 6) & 7];
      }
    }

    // Quantise before comparing: the gap wobbles in the last float bit every tick.
    let quantised;
    if (retired) quantised = GAP_OUT;
    else if (k === 0) quantised = GAP_LEADER;
    else if (!Number.isFinite(entry.gap)) quantised = GAP_NONE;
    else if (entry.lapsDown > 0) quantised = -100 - entry.lapsDown;
    else quantised = Math.round(entry.gap * 1000);

    if (quantised !== this._gapKey[i]) {
      this._gapKey[i] = quantised;
      row.gap.textContent = formatTowerGap(quantised);
      row.gap.classList.toggle('no-data', quantised === GAP_NONE);
    }
  }

  setVisible(v) {
    this.root.classList.toggle('is-hidden', !v);
  }

  dispose() {
    this.root.remove();
    this._rows.length = 0;
  }
}
