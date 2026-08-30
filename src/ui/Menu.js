import { clamp } from '../core/MathUtils.js';

/**
 * Pause and settings overlay.
 *
 * Every control writes straight through `ctx.settings`, which is the single source of
 * truth the engine and the render pipeline already listen to — nothing here caches a
 * value or mirrors one. The two exceptions are the camera mode, which is an event
 * rather than a setting, and the driving assists, which also need pushing into the
 * player's physics because the car reads them once at construction.
 *
 * While the sheet is open `ctx.paused` is true, so `Engine.step` — and therefore
 * `Input.update` — does not run. Escape is caught here directly for that reason.
 */

const QUALITY_TIERS = ['low', 'medium', 'high', 'ultra'];
const CAMERA_MODES = ['cockpit', 'helmet', 'chase', 'trackside', 'replay'];
const WEATHER = ['clear', 'scattered', 'cloudy', 'overcast', 'rain', 'storm'];

const PCT = (v) => `${Math.round(v * 100)}%`;
const DEG = (v) => `${Math.round(v)}°`;

function clockText(hours) {
  const h = Math.floor(hours) % 24;
  const m = Math.floor((hours - Math.floor(hours)) * 60);
  return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}`;
}

/**
 * The whole panel is data. Each field names the settings key it owns, so adding a
 * control never means touching the build or the refresh code.
 */
const GROUPS = [
  {
    title: 'Graphics',
    fields: [
      { key: 'quality', label: 'Quality preset', type: 'segment', options: QUALITY_TIERS },
      { key: 'motionBlurStrength', label: 'Motion blur', type: 'range', min: 0, max: 1.5, step: 0.05, format: PCT },
      { key: 'filmGrain', label: 'Film grain', type: 'range', min: 0, max: 2, step: 0.05, format: PCT },
      { key: 'chromaticAberration', label: 'Chromatic aberration', type: 'range', min: 0, max: 2, step: 0.05, format: PCT },
    ],
  },
  {
    title: 'Camera',
    fields: [
      { key: '@camera', label: 'Camera', type: 'segment', options: CAMERA_MODES },
      { key: 'fov', label: 'Field of view', type: 'range', min: 60, max: 110, step: 1, format: DEG },
      { key: 'cameraShake', label: 'Camera shake', type: 'range', min: 0, max: 1.5, step: 0.05, format: PCT },
      { key: 'headMovement', label: 'Head movement', type: 'range', min: 0, max: 1.5, step: 0.05, format: PCT },
    ],
  },
  {
    title: 'Audio',
    fields: [
      { key: 'masterVolume', label: 'Master volume', type: 'range', min: 0, max: 1, step: 0.02, format: PCT },
      { key: 'engineVolume', label: 'Power unit', type: 'range', min: 0, max: 1.5, step: 0.02, format: PCT },
    ],
  },
  {
    title: 'Driving',
    fields: [
      { key: 'abs', label: 'Anti-lock brakes', type: 'range', min: 0, max: 1, step: 0.1, format: PCT },
      { key: 'tractionControl', label: 'Traction control', type: 'range', min: 0, max: 1, step: 0.1, format: PCT },
      { key: 'steerAssist', label: 'Steering assist', type: 'range', min: 0, max: 1, step: 0.1, format: PCT },
      { key: 'units', label: 'Units', type: 'segment', options: ['metric', 'imperial'] },
    ],
  },
  {
    title: 'Interface',
    fields: [
      { key: 'showHud', label: 'Head-up display', type: 'segment', options: [true, false], labels: ['On', 'Off'] },
    ],
  },
  {
    title: 'Session',
    fields: [
      { key: 'timeOfDay', label: 'Time of day', type: 'range', min: 0, max: 23.9, step: 0.1, format: clockText },
      { key: 'weather', label: 'Weather', type: 'segment', options: WEATHER },
    ],
  },
];

const KEY_HINTS = [
  ['W / S', 'Throttle, brake'],
  ['A / D', 'Steer'],
  ['E / Q', 'Shift up, down'],
  ['Space', 'DRS'],
  ['F', 'ERS mode'],
  ['C', 'Camera'],
  ['H', 'Hide HUD'],
  ['R', 'Reset car'],
  ['Esc', 'Pause'],
];

export class Menu {
  constructor(ctx, mount) {
    this.ctx = ctx;
    this.isOpen = false;
    this._controls = [];

    this.root = document.createElement('div');
    this.root.className = 'apex-menu apex-root';

    const sheet = document.createElement('div');
    sheet.className = 'sheet';

    sheet.appendChild(this._buildHead());
    sheet.appendChild(this._buildBody());
    sheet.appendChild(this._buildFoot());
    this.root.appendChild(sheet);
    mount.appendChild(this.root);

    // A click on the scrim closes; a click inside the sheet must not.
    this._onScrim = (e) => {
      if (e.target === this.root) this.close();
    };
    this.root.addEventListener('pointerdown', this._onScrim);

    this._onKey = (e) => {
      if (!this.isOpen) return;
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    };
    globalThis.addEventListener('keydown', this._onKey);

    this._onPause = () => this.toggle();
    ctx.events?.on('game:pause', this._onPause);
  }

  _buildHead() {
    const head = document.createElement('div');
    head.className = 'sheet-head';

    const title = document.createElement('h1');
    title.innerHTML = 'Ap<em>e</em>x';

    this._where = document.createElement('div');
    this._where.className = 'where';
    head.append(title, this._where);
    return head;
  }

  _buildBody() {
    const body = document.createElement('div');
    body.className = 'sheet-body';

    for (const group of GROUPS) {
      const g = document.createElement('section');
      g.className = 'group';
      const heading = document.createElement('div');
      heading.className = 'apex-label';
      heading.textContent = group.title;
      g.appendChild(heading);
      for (const field of group.fields) g.appendChild(this._buildField(field));
      body.appendChild(g);
    }
    return body;
  }

  _buildField(field) {
    const row = document.createElement('div');
    row.className = 'field';

    const label = document.createElement('label');
    label.textContent = field.label;

    const ctl = document.createElement('div');
    ctl.className = 'ctl';

    if (field.type === 'range') {
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(field.min);
      input.max = String(field.max);
      input.step = String(field.step);
      const readout = document.createElement('span');
      readout.className = 'readout';
      input.addEventListener('input', () => {
        const v = Number(input.value);
        readout.textContent = field.format(v);
        this._write(field.key, v);
      });
      label.htmlFor = input.id = `apex-${field.key}`;
      ctl.append(readout, input);
      this._controls.push({ field, input, readout });
    } else {
      const seg = document.createElement('div');
      seg.className = 'seg';
      const buttons = [];
      for (let i = 0; i < field.options.length; i++) {
        const option = field.options[i];
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = field.labels ? field.labels[i] : String(option);
        b.addEventListener('click', () => {
          this._write(field.key, option);
          this._syncSegment(field, buttons);
        });
        seg.appendChild(b);
        buttons.push(b);
      }
      ctl.appendChild(seg);
      this._controls.push({ field, buttons });
    }

    row.append(label, ctl);
    return row;
  }

  _buildFoot() {
    const foot = document.createElement('div');
    foot.className = 'sheet-foot';

    const keys = document.createElement('div');
    keys.className = 'keys';
    for (const [key, what] of KEY_HINTS) {
      const span = document.createElement('span');
      const b = document.createElement('b');
      b.textContent = key;
      span.appendChild(b);
      span.appendChild(document.createTextNode(what));
      keys.appendChild(span);
    }

    const actions = document.createElement('div');
    actions.className = 'actions';

    const restart = document.createElement('button');
    restart.type = 'button';
    restart.className = 'btn';
    restart.textContent = 'Restart session';
    restart.addEventListener('click', () => {
      this.ctx.race?.restart?.();
      this.close();
    });

    const resume = document.createElement('button');
    resume.type = 'button';
    resume.className = 'btn primary';
    resume.textContent = 'Resume';
    resume.addEventListener('click', () => this.close());

    actions.append(restart, resume);
    foot.append(keys, actions);
    return foot;
  }

  /** Route one control's value to whoever owns it. */
  _write(key, value) {
    const ctx = this.ctx;
    if (key === '@camera') {
      ctx.events?.emit('camera:mode', { mode: value });
      return;
    }

    ctx.settings?.set(key, value);

    // The car reads its assists once, at construction, so push them through by hand.
    if (key === 'abs' || key === 'tractionControl') {
      ctx.vehicle?.setAssists?.({
        abs: key === 'abs' ? value : null,
        tractionControl: key === 'tractionControl' ? value : null,
      });
    }
  }

  _read(key) {
    if (key === '@camera') return this.ctx.cameraRig?.mode ?? CAMERA_MODES[0];
    return this.ctx.settings?.get(key);
  }

  _syncSegment(field, buttons) {
    const current = this._read(field.key);
    for (let i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('on', field.options[i] === current);
    }
  }

  /** Pull every control back into line with the live settings before showing the sheet. */
  refresh() {
    for (const c of this._controls) {
      const value = this._read(c.field.key);
      if (c.input) {
        const v = clamp(Number(value ?? c.field.min), c.field.min, c.field.max);
        c.input.value = String(v);
        c.readout.textContent = c.field.format(v);
      } else {
        this._syncSegment(c.field, c.buttons);
      }
    }

    const track = this.ctx.track;
    const session = this.ctx.race?.session;
    const lap = session ? `Lap ${session.lap}${session.totalLaps > 0 ? ` of ${session.totalLaps}` : ''}` : '';
    this._where.textContent = track ? `${track.name} · ${track.country}` : '';
    if (lap) {
      const line = document.createElement('div');
      line.textContent = `${session.name} ${lap}`;
      this._where.appendChild(line);
    }
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.refresh();
    this.root.classList.add('open');
    this.ctx.paused = true;
    if (this.ctx.input) this.ctx.input.enabled = false;
    document.exitPointerLock?.();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.root.classList.remove('open');
    this.ctx.paused = false;
    if (this.ctx.input) this.ctx.input.enabled = true;
    // Drop the edge-triggered flags collected while the loop was stopped, or the first
    // tick after resuming replays the keypress that closed the menu.
    this.ctx.input?.endFrame?.();
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  dispose() {
    this.ctx.events?.off('game:pause', this._onPause);
    globalThis.removeEventListener('keydown', this._onKey);
    this.root.removeEventListener('pointerdown', this._onScrim);
    this.root.remove();
    this._controls.length = 0;
  }
}
