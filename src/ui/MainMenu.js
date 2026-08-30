import { TEAMS, DRIVERS } from '../car/Teams.js';
import { KEY_ACTIONS } from '../core/Input.js';
import { clamp } from '../core/MathUtils.js';
import './mainmenu.css';

const SESSION_TYPES = [
  { id: 'practice', label: 'Practice', blurb: 'Free running. No classification, no pressure.' },
  { id: 'qualifying', label: 'Qualifying', blurb: 'One timed session. Set the grid.' },
  { id: 'race', label: 'Race', blurb: 'Standing start, full field, points on the line.' },
];

const RACE_LENGTHS = [3, 5, 10, 25, 44];

const DIFFICULTIES = [
  { id: 'rookie', label: 'Rookie', skill: 0.62, blurb: 'The field waits for you.' },
  { id: 'pro', label: 'Pro', skill: 0.78, blurb: 'Racing pace. Mistakes cost places.' },
  { id: 'expert', label: 'Expert', skill: 0.90, blurb: 'Championship pace.' },
  { id: 'legend', label: 'Legend', skill: 0.99, blurb: 'They do not make mistakes.' },
];

const QUALITY_TIERS = ['low', 'medium', 'high', 'ultra'];
const WEATHER_OPTIONS = ['clear', 'cloudy', 'wet'];

const ACTION_LABELS = {
  throttle: 'Throttle',
  brake: 'Brake',
  left: 'Steer left',
  right: 'Steer right',
  shiftUp: 'Shift up',
  shiftDown: 'Shift down',
  drs: 'DRS',
  ers: 'ERS overtake',
  pitLimiter: 'Pit limiter',
  reset: 'Reset to track',
  cameraCycle: 'Change camera',
  toggleHud: 'Toggle HUD',
  lookBack: 'Look back',
  lookLeft: 'Look left',
  lookRight: 'Look right',
  pause: 'Pause',
};

const KEY_GLYPHS = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  ShiftLeft: 'L Shift', ShiftRight: 'R Shift',
  ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl',
  Space: 'Space', Escape: 'Esc', Backquote: '`',
};

function keyLabel(code) {
  if (KEY_GLYPHS[code]) return KEY_GLYPHS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  return code;
}

function bindingsByAction() {
  const map = new Map();
  for (const [code, action] of Object.entries(KEY_ACTIONS)) {
    if (!ACTION_LABELS[action]) continue;
    if (!map.has(action)) map.set(action, []);
    map.get(action).push(keyLabel(code));
  }
  return map;
}

function cssColor(value) {
  if (typeof value === 'number') return `#${(value >>> 0).toString(16).padStart(6, '0')}`;
  return value ?? '#888';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export class MainMenu {
  constructor(ctx, root) {
    this.ctx = ctx;
    this.root = root;
    this.visible = false;
    this.screen = 'main';
    this.focusIndex = 0;
    this.rows = [];
    this._startHandlers = [];

    const settings = ctx.settings;
    this.config = {
      sessionType: 2,
      lengthIndex: 1,
      teamIndex: 0,
      driverSlot: 0,
      difficulty: 1,
      quality: Math.max(0, QUALITY_TIERS.indexOf(settings?.get?.('quality') ?? 'high')),
      fov: settings?.get?.('fov') ?? 82,
      masterVolume: settings?.get?.('masterVolume') ?? 0.8,
      engineVolume: settings?.get?.('engineVolume') ?? 1.0,
      cameraShake: settings?.get?.('cameraShake') ?? 1.0,
      headMovement: settings?.get?.('headMovement') ?? 1.0,
      tractionControl: settings?.get?.('tractionControl') ?? 0,
      abs: settings?.get?.('abs') ?? 0,
      timeOfDay: settings?.get?.('timeOfDay') ?? 15.2,
      weather: Math.max(0, WEATHER_OPTIONS.indexOf(settings?.get?.('weather') ?? 'clear')),
    };

    this._buildDom();
    this._onKeyDown = (event) => this._handleKey(event);
  }

  onStart(fn) {
    this._startHandlers.push(fn);
  }

  _buildDom() {
    this.el = el('div', 'mm');
    this.el.setAttribute('role', 'dialog');

    const scrim = el('div', 'mm-scrim');
    this.el.appendChild(scrim);

    const frame = el('div', 'mm-frame');

    const header = el('div', 'mm-header');
    const brand = el('div', 'mm-brand');
    brand.appendChild(el('span', 'mm-wordmark', 'APEX'));
    brand.appendChild(el('span', 'mm-brand-sub', 'Formula One'));
    header.appendChild(brand);

    const venue = el('div', 'mm-venue');
    venue.appendChild(el('div', 'mm-venue-name', this.ctx.track?.name ?? 'Spa-Francorchamps'));
    venue.appendChild(el('div', 'mm-venue-meta', this.ctx.track?.country ?? 'Belgium'));
    header.appendChild(venue);
    frame.appendChild(header);

    this.body = el('div', 'mm-body');
    frame.appendChild(this.body);

    this.hint = el('div', 'mm-hint');
    frame.appendChild(this.hint);

    this.el.appendChild(frame);
    this.root.appendChild(this.el);
  }

  show() {
    if (this.visible) return;
    this.visible = true;
    this.screen = 'main';
    this.focusIndex = 0;
    this.el.classList.add('is-open');
    document.getElementById('apex-hud')?.classList.add('is-hidden');
    this._render();
    globalThis.addEventListener('keydown', this._onKeyDown, { capture: true });
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.el.classList.remove('is-open');
    document.getElementById('apex-hud')?.classList.remove('is-hidden');
    globalThis.removeEventListener('keydown', this._onKeyDown, { capture: true });
  }

  dispose() {
    this.hide();
    this.el.remove();
    this._startHandlers.length = 0;
  }

  _teamDrivers() {
    return TEAMS[this.config.teamIndex]?.drivers ?? [];
  }

  _selectedDriver() {
    const drivers = this._teamDrivers();
    return drivers[clamp(this.config.driverSlot, 0, drivers.length - 1)] ?? DRIVERS[0];
  }

  _render() {
    this.body.replaceChildren();
    this.rows = [];
    if (this.screen === 'main') this._renderMain();
    else if (this.screen === 'settings') this._renderSettings();
    else this._renderControls();
    this._paintFocus();
  }

  _addRow(label, valueText, opts = {}) {
    const index = this.rows.length;
    const row = el('div', 'mm-row');
    if (opts.kind === 'action') row.classList.add('mm-row-action');
    row.appendChild(el('div', 'mm-row-label', label));

    if (opts.kind !== 'action') {
      const value = el('div', 'mm-row-value');
      if (opts.swatch) {
        const dot = el('span', 'mm-swatch');
        dot.style.background = opts.swatch;
        value.appendChild(dot);
      }
      value.appendChild(el('span', 'mm-row-text', valueText));
      row.appendChild(value);
      if (opts.arrows !== false && opts.onChange) {
        const arrows = el('div', 'mm-row-arrows');
        const stepButton = (glyph, dir) => {
          const b = el('button', 'mm-arrow', glyph);
          b.type = 'button';
          b.addEventListener('click', (event) => {
            event.stopPropagation();
            this.focusIndex = index;
            opts.onChange(dir);
            this._render();
          });
          return b;
        };
        arrows.appendChild(stepButton('\u2039', -1));
        arrows.appendChild(stepButton('\u203a', 1));
        row.appendChild(arrows);
      }
    }

    if (opts.blurb) {
      const blurb = el('div', 'mm-row-blurb', opts.blurb);
      row.appendChild(blurb);
    }

    row.addEventListener('pointerenter', () => {
      this.focusIndex = index;
      this._paintFocus();
    });
    row.addEventListener('click', () => {
      this.focusIndex = index;
      if (opts.onActivate) {
        opts.onActivate();
        this._render();
      } else {
        this._paintFocus();
      }
    });

    this.body.appendChild(row);
    this.rows.push({ node: row, ...opts });
    return row;
  }

  _renderMain() {
    const session = SESSION_TYPES[this.config.sessionType];
    const team = TEAMS[this.config.teamIndex];
    const driver = this._selectedDriver();
    const difficulty = DIFFICULTIES[this.config.difficulty];

    this._addRow('Session', session.label, {
      blurb: session.blurb,
      onChange: (dir) => {
        this.config.sessionType = (this.config.sessionType + dir + SESSION_TYPES.length) % SESSION_TYPES.length;
      },
    });

    if (session.id === 'race') {
      this._addRow('Race distance', `${RACE_LENGTHS[this.config.lengthIndex]} laps`, {
        onChange: (dir) => {
          this.config.lengthIndex = clamp(this.config.lengthIndex + dir, 0, RACE_LENGTHS.length - 1);
        },
      });
    }

    this._addRow('Team', team.name, {
      swatch: cssColor(team.colors.primary),
      blurb: `${team.engine} · ${team.country}`,
      onChange: (dir) => {
        this.config.teamIndex = (this.config.teamIndex + dir + TEAMS.length) % TEAMS.length;
        this.config.driverSlot = 0;
      },
    });

    this._addRow('Driver', `${driver.number}  ${driver.name}`, {
      blurb: driver.country,
      onChange: (dir) => {
        const drivers = this._teamDrivers();
        this.config.driverSlot = (this.config.driverSlot + dir + drivers.length) % drivers.length;
      },
    });

    this._addRow('Difficulty', difficulty.label, {
      blurb: difficulty.blurb,
      onChange: (dir) => {
        this.config.difficulty = clamp(this.config.difficulty + dir, 0, DIFFICULTIES.length - 1);
      },
    });

    this._addRow('Start session', '', {
      kind: 'action',
      onActivate: () => this._start(),
    });
    this._addRow('Settings', '', {
      kind: 'action',
      onActivate: () => { this.screen = 'settings'; this.focusIndex = 0; },
    });
    this._addRow('Controls', '', {
      kind: 'action',
      onActivate: () => { this.screen = 'controls'; this.focusIndex = 0; },
    });

    this.hint.textContent = 'Arrows navigate and change  ·  Enter selects  ·  Esc backs out';
  }

  _renderSettings() {
    const pct = (v) => `${Math.round(v * 100)}%`;

    this._addRow('Graphics quality', QUALITY_TIERS[this.config.quality].toUpperCase(), {
      onChange: (dir) => {
        this.config.quality = clamp(this.config.quality + dir, 0, QUALITY_TIERS.length - 1);
      },
    });
    this._addRow('Field of view', `${Math.round(this.config.fov)}°`, {
      onChange: (dir) => { this.config.fov = clamp(this.config.fov + dir * 2, 60, 110); },
    });
    this._addRow('Master volume', pct(this.config.masterVolume), {
      onChange: (dir) => { this.config.masterVolume = clamp(this.config.masterVolume + dir * 0.05, 0, 1); },
    });
    this._addRow('Engine volume', pct(this.config.engineVolume), {
      onChange: (dir) => { this.config.engineVolume = clamp(this.config.engineVolume + dir * 0.05, 0, 1); },
    });
    this._addRow('Camera shake', pct(this.config.cameraShake), {
      onChange: (dir) => { this.config.cameraShake = clamp(this.config.cameraShake + dir * 0.1, 0, 1.5); },
    });
    this._addRow('Head movement', pct(this.config.headMovement), {
      onChange: (dir) => { this.config.headMovement = clamp(this.config.headMovement + dir * 0.1, 0, 1.5); },
    });
    this._addRow('Traction control', this.config.tractionControl > 0 ? pct(this.config.tractionControl) : 'Off', {
      onChange: (dir) => { this.config.tractionControl = clamp(this.config.tractionControl + dir * 0.25, 0, 1); },
    });
    this._addRow('ABS', this.config.abs > 0 ? pct(this.config.abs) : 'Off', {
      onChange: (dir) => { this.config.abs = clamp(this.config.abs + dir * 0.25, 0, 1); },
    });
    this._addRow('Time of day', `${String(Math.floor(this.config.timeOfDay)).padStart(2, '0')}:${String(Math.round((this.config.timeOfDay % 1) * 60)).padStart(2, '0')}`, {
      onChange: (dir) => { this.config.timeOfDay = clamp(this.config.timeOfDay + dir * 0.5, 5, 23); },
    });
    this._addRow('Weather', WEATHER_OPTIONS[this.config.weather].toUpperCase(), {
      onChange: (dir) => {
        this.config.weather = (this.config.weather + dir + WEATHER_OPTIONS.length) % WEATHER_OPTIONS.length;
      },
    });
    this._addRow('Back', '', {
      kind: 'action',
      onActivate: () => { this.screen = 'main'; this.focusIndex = 0; },
    });

    this.hint.textContent = 'Changes apply immediately  ·  Esc returns';
  }

  _renderControls() {
    const map = bindingsByAction();
    const grid = el('div', 'mm-controls');
    for (const [action, label] of Object.entries(ACTION_LABELS)) {
      const keys = map.get(action);
      if (!keys) continue;
      const item = el('div', 'mm-control');
      item.appendChild(el('div', 'mm-control-label', label));
      const keyWrap = el('div', 'mm-control-keys');
      for (const k of keys) keyWrap.appendChild(el('kbd', 'mm-key', k));
      item.appendChild(keyWrap);
      grid.appendChild(item);
    }
    this.body.appendChild(grid);

    const pad = el('div', 'mm-pad-note');
    pad.textContent = 'Gamepad and wheel are detected automatically. Triggers steer throttle and brake, '
      + 'shoulder buttons shift, and the left stick steers.';
    this.body.appendChild(pad);

    this._addRow('Back', '', {
      kind: 'action',
      onActivate: () => { this.screen = 'main'; this.focusIndex = 0; },
    });

    this.hint.textContent = 'Esc returns';
  }

  _paintFocus() {
    if (!this.rows.length) return;
    this.focusIndex = clamp(this.focusIndex, 0, this.rows.length - 1);
    for (let i = 0; i < this.rows.length; i++) {
      this.rows[i].node.classList.toggle('is-focused', i === this.focusIndex);
    }
    this.rows[this.focusIndex].node.scrollIntoView({ block: 'nearest' });
  }

  _handleKey(event) {
    if (!this.visible) return;
    const row = this.rows[this.focusIndex];
    let handled = true;

    switch (event.code) {
      case 'ArrowDown':
        this.focusIndex = (this.focusIndex + 1) % this.rows.length;
        this._paintFocus();
        break;
      case 'ArrowUp':
        this.focusIndex = (this.focusIndex - 1 + this.rows.length) % this.rows.length;
        this._paintFocus();
        break;
      case 'ArrowLeft':
        if (row?.onChange) { row.onChange(-1); this._render(); }
        break;
      case 'ArrowRight':
        if (row?.onChange) { row.onChange(1); this._render(); }
        break;
      case 'Enter':
      case 'NumpadEnter':
        if (row?.onActivate) row.onActivate();
        else if (row?.onChange) row.onChange(1);
        this._render();
        break;
      case 'Escape':
        if (this.screen !== 'main') { this.screen = 'main'; this.focusIndex = 0; this._render(); }
        break;
      default:
        handled = false;
    }

    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  _applySettings() {
    const s = this.ctx.settings;
    if (!s) return;
    s.set('quality', QUALITY_TIERS[this.config.quality]);
    s.set('fov', this.config.fov);
    s.set('masterVolume', this.config.masterVolume);
    s.set('engineVolume', this.config.engineVolume);
    s.set('cameraShake', this.config.cameraShake);
    s.set('headMovement', this.config.headMovement);
    s.set('tractionControl', this.config.tractionControl);
    s.set('abs', this.config.abs);
    s.set('timeOfDay', this.config.timeOfDay);
    s.set('weather', WEATHER_OPTIONS[this.config.weather]);
  }

  _start() {
    this._applySettings();

    const driver = this._selectedDriver();
    const seat = DRIVERS.indexOf(driver);
    const currentSeat = this.ctx.settings?.get?.('playerDriver') ?? 0;

    const session = SESSION_TYPES[this.config.sessionType];
    const laps = RACE_LENGTHS[this.config.lengthIndex];
    const skill = DIFFICULTIES[this.config.difficulty].skill;

    if (seat >= 0 && seat !== currentSeat) {
      this.ctx.settings?.set?.('playerDriver', seat);
      const params = new URLSearchParams(globalThis.location.search);
      params.set('autostart', '1');
      params.set('session', session.id);
      params.set('laps', String(laps));
      params.set('skill', String(skill));
      globalThis.location.search = params.toString();
      return;
    }

    this.applyToSession({ session: session.id, laps, skill });
    this.hide();
    for (const fn of this._startHandlers) fn({ session: session.id, laps, skill });
  }

  applyToSession({ session, laps, skill }) {
    const ctx = this.ctx;
    ctx.race?.setSession?.(session, { totalLaps: session === 'race' ? laps : undefined });

    const cars = ctx.cars ?? [];
    for (let i = 1; i < cars.length; i++) {
      const ai = cars[i]?.ai;
      if (!ai) continue;
      const spread = (i % 5) * 0.012;
      ai.skill = clamp(skill - spread, 0, 1);
    }
  }
}
