import './hud.css';

/**
 * First frame the player ever sees, so it carries the whole visual promise of the
 * product: wordmark, circuit identity, and a live trace of the lap being built.
 *
 * It runs before the engine exists — `main.js` constructs it, shows it, and only then
 * builds the WebGL context — so it owns its own rAF loop and imports nothing from the
 * engine. The circuit outline is pulled in with a dynamic import so a failure to load
 * the track data degrades to the generated fallback loop instead of a blank screen.
 */

const FADE_MS = 560;
const SPIN_RATE = 0.115;      // radians per second
const TRACE_SPAN = 0.14;      // fraction of the lap the bright head covers
const TRACE_RATE = 0.19;      // laps per second

const HINTS = [
  'Short-shift out of the slow corners: wheelspin costs more than revs earn.',
  'The rear tyres come to temperature two corners after the fronts do.',
  'DRS only arms within one second of the car ahead at the detection point.',
  'Deploy the energy store on corner exit, not on a straight already at top speed.',
  'Three track-limits warnings and race control deletes the lap.',
  'Brake in a straight line, release the pedal as you turn: trail the last ten percent.',
];
const HINT_SECONDS = 7;

/** Head-of-trace colours, hottest first — prebuilt so the frame loop stays allocation-free. */
const TRACE_STEPS = 34;
const TRACE_COLOURS = Array.from({ length: TRACE_STEPS }, (_, k) => {
  const fade = 1 - k / TRACE_STEPS;
  const g = Math.round(40 + 130 * fade);
  const b = Math.round(28 + 46 * fade);
  return `rgba(255, ${g}, ${b}, ${(fade * fade).toFixed(3)})`;
});

/** A closed loop from summed harmonics — stands in until the real circuit arrives. */
function fallbackOutline(count) {
  const pts = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const r = 1
      + 0.24 * Math.sin(a * 2 + 0.7)
      + 0.13 * Math.sin(a * 3 - 1.9)
      + 0.07 * Math.sin(a * 5 + 2.4);
    pts[i * 2] = Math.cos(a) * r;
    pts[i * 2 + 1] = Math.sin(a) * r * 0.78;
  }
  return pts;
}

export class LoadingScreen {
  constructor(uiRoot) {
    this.uiRoot = uiRoot ?? document.body;
    this.visible = false;
    this.errored = false;

    this._raf = 0;
    this._t0 = 0;
    this._hintIndex = 0;
    this._hintAt = 0;
    this._points = fallbackOutline(256);
    this._progress = 0;

    this.root = document.createElement('div');
    this.root.className = 'apex-loading apex-root';

    this.root.appendChild(this._buildTop());
    this.root.appendChild(this._buildMiddle());
    this.root.appendChild(this._buildBottom());

    this._onResize = () => this._fitCanvas();
  }

  _buildTop() {
    const top = document.createElement('div');
    top.className = 'ld-top';

    const word = document.createElement('div');
    word.className = 'wordmark';
    const slash = document.createElement('i');
    slash.className = 'slash';
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = 'Apex';
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = 'Formula One';
    word.append(slash, mark, sub);

    const tag = document.createElement('div');
    tag.className = 'session-tag';
    this._tagCircuit = document.createElement('div');
    this._tagCircuit.textContent = 'Round 14';
    const tagEvent = document.createElement('div');
    tagEvent.textContent = 'Grand Prix';
    tag.append(this._tagCircuit, tagEvent);

    top.append(word, tag);
    return top;
  }

  _buildMiddle() {
    const mid = document.createElement('div');
    mid.className = 'ld-mid';

    this.canvas = document.createElement('canvas');
    this.canvas.width = 720;
    this.canvas.height = 720;
    this._g = this.canvas.getContext('2d');

    const name = document.createElement('div');
    name.className = 'circuit-name';

    this._country = document.createElement('div');
    this._country.className = 'cn-country';
    this._country.textContent = '';

    this._title = document.createElement('div');
    this._title.className = 'cn-title';
    this._title.textContent = 'Loading circuit';

    this._stats = document.createElement('div');
    this._stats.className = 'cn-stats';

    name.append(this._country, this._title, this._stats);
    mid.append(this.canvas, name);
    return mid;
  }

  _buildBottom() {
    const bottom = document.createElement('div');
    bottom.className = 'ld-bottom';

    const progress = document.createElement('div');
    progress.className = 'progress';
    this._bar = document.createElement('div');
    this._bar.className = 'bar';
    progress.appendChild(this._bar);

    const status = document.createElement('div');
    status.className = 'status';
    this._stage = document.createElement('span');
    this._stage.className = 'stage';
    this._stage.textContent = 'Initialising';
    this._pct = document.createElement('span');
    this._pct.className = 'pct';
    this._pct.textContent = '0%';
    status.append(this._stage, this._pct);

    this._hint = document.createElement('div');
    this._hint.className = 'hint';
    this._hint.textContent = HINTS[0];

    this._error = document.createElement('pre');
    this._error.className = 'error';

    bottom.append(progress, status, this._hint, this._error);
    return bottom;
  }

  _stat(label, value) {
    const cell = document.createElement('div');
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('span');
    v.textContent = value;
    cell.append(l, v);
    return cell;
  }

  /**
   * Pull the circuit geometry straight out of the track data tables. This is the same
   * traverse the Track builds from, so the outline on the loading screen is the circuit
   * the player is about to drive, not an illustration of it.
   */
  async _loadCircuit() {
    try {
      const mod = await import('../track/CircuitData.js');
      const circuit = mod.SPA;
      const layout = mod.buildLayout(circuit, { maxSpacing: 14 });
      const n = layout.count;
      const pts = new Float32Array(n * 2);
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (let i = 0; i < n; i++) {
        const x = layout.points[i * 3];
        const z = layout.points[i * 3 + 2];
        pts[i * 2] = x;
        pts[i * 2 + 1] = z;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }

      // Normalise into a unit box centred on the origin so the draw code only scales.
      const cx = (minX + maxX) * 0.5;
      const cz = (minZ + maxZ) * 0.5;
      const half = Math.max(maxX - minX, maxZ - minZ) * 0.5 || 1;
      for (let i = 0; i < n; i++) {
        pts[i * 2] = (pts[i * 2] - cx) / half;
        pts[i * 2 + 1] = (pts[i * 2 + 1] - cz) / half;
      }
      this._points = pts;

      this._country.textContent = circuit.country ?? '';
      this._title.textContent = circuit.name ?? '';
      this._tagCircuit.textContent = circuit.shortName ?? '';
      this._stats.replaceChildren(
        this._stat('Length', `${(circuit.targetLength / 1000).toFixed(3)} km`),
        this._stat('Turns', String(circuit.corners?.length ?? 0)),
        this._stat('Laps', String(circuit.laps ?? 0)),
      );
    } catch {
      // The generated loop already on screen is a perfectly good stand-in.
      this._title.textContent = 'Circuit';
    }
  }

  show() {
    if (this.visible) return;
    this.visible = true;
    this.errored = false;
    this.root.classList.remove('fading', 'has-error');
    this.uiRoot.appendChild(this.root);
    globalThis.addEventListener('resize', this._onResize);
    this._fitCanvas();
    this._loadCircuit();

    this._t0 = performance.now();
    this._hintAt = this._t0;
    const loop = (now) => {
      this._raf = requestAnimationFrame(loop);
      this._frame((now - this._t0) / 1000);
      if (now - this._hintAt > HINT_SECONDS * 1000 && !this.errored) {
        this._hintAt = now;
        this._hintIndex = (this._hintIndex + 1) % HINTS.length;
        this._hint.textContent = HINTS[this._hintIndex];
      }
    };
    this._raf = requestAnimationFrame(loop);
  }

  setStatus(text, progress01) {
    if (typeof text === 'string' && text.length > 0) this._stage.textContent = text;
    if (Number.isFinite(progress01)) {
      // Never walk backwards: a stage that reports less than the last one still reads
      // as progress to the player if the bar only ever grows.
      this._progress = Math.max(this._progress, Math.min(1, Math.max(0, progress01)));
      this._bar.style.width = `${(this._progress * 100).toFixed(1)}%`;
      this._pct.textContent = `${Math.round(this._progress * 100)}%`;
    }
  }

  setError(err) {
    this.errored = true;
    this.root.classList.add('has-error');
    this._stage.textContent = 'Initialisation failed';
    this._bar.style.width = '100%';
    this._hint.textContent = 'The session could not start. The detail below is the failure as reported by the engine.';
    const message = err?.stack ?? err?.message ?? String(err ?? 'Unknown error');
    this._error.textContent = message;
  }

  hide() {
    if (!this.visible || this.errored) return;
    this.visible = false;
    this.root.classList.add('fading');
    globalThis.setTimeout(() => this._teardown(), FADE_MS);
  }

  _teardown() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
    globalThis.removeEventListener('resize', this._onResize);
    this.root.remove();
  }

  _fitCanvas() {
    const dpr = Math.min(globalThis.devicePixelRatio ?? 1, 2);
    const css = this.canvas.clientWidth || 480;
    const size = Math.max(160, Math.round(css * dpr));
    if (this.canvas.width === size) return;
    this.canvas.width = size;
    this.canvas.height = size;
  }

  _frame(seconds) {
    const g = this._g;
    if (!g) return;
    const size = this.canvas.width;
    if (size === 0) return;
    const half = size * 0.5;
    const radius = half * 0.82;
    const pts = this._points;
    const n = pts.length >> 1;

    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, size, size);
    g.translate(half, half);
    g.rotate(seconds * SPIN_RATE);
    g.scale(radius, radius);
    g.lineJoin = 'round';
    g.lineCap = 'round';

    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (let i = 1; i < n; i++) g.lineTo(pts[i * 2], pts[i * 2 + 1]);
    g.closePath();

    // Line widths are in the scaled space, so divide by the scale to keep them in pixels.
    const px = 1 / radius;
    g.strokeStyle = 'rgba(255,255,255,0.09)';
    g.lineWidth = px * Math.max(9, size * 0.021);
    g.stroke();
    g.strokeStyle = 'rgba(214, 222, 234, 0.34)';
    g.lineWidth = px * Math.max(2, size * 0.005);
    g.stroke();

    // A bright head sweeping the lap: the same read as a car circulating the circuit.
    const head = (seconds * TRACE_RATE) % 1;
    const first = Math.floor(head * n);
    const stride = Math.max(1, Math.round((TRACE_SPAN * n) / TRACE_STEPS));
    for (let k = TRACE_STEPS - 1; k >= 0; k--) {
      const a = (first - k * stride + n * TRACE_STEPS) % n;
      const b = (a + stride) % n;
      const fade = 1 - k / TRACE_STEPS;
      g.strokeStyle = TRACE_COLOURS[k];
      g.lineWidth = px * Math.max(2.5, size * 0.0075) * (0.5 + fade * 0.5);
      g.beginPath();
      g.moveTo(pts[a * 2], pts[a * 2 + 1]);
      g.lineTo(pts[b * 2], pts[b * 2 + 1]);
      g.stroke();
    }

    const hx = pts[first * 2];
    const hy = pts[first * 2 + 1];
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(hx, hy, px * Math.max(3, size * 0.008), 0, Math.PI * 2);
    g.fill();

    g.setTransform(1, 0, 0, 1, 0, 0);
  }
}
