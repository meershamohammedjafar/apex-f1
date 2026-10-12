import { TEAMS, DRIVERS } from "../car/Teams.js";
import { KEY_ACTIONS } from "../core/Input.js";
import { clamp } from "../core/MathUtils.js";
import "./mainmenu.css";
const SESSION_TYPES = [
  { id: "practice", label: "Practice", blurb: "Free running. No classification, no pressure." },
  { id: "qualifying", label: "Qualifying", blurb: "One timed session. Set the grid." },
  { id: "race", label: "Race", blurb: "Standing start, full field, points on the line." }
];
const RACE_LENGTHS = [3, 5, 10, 25, 44];
const DIFFICULTIES = [
  { id: "rookie", label: "Rookie", skill: 0.62, blurb: "The field waits for you." },
  { id: "pro", label: "Pro", skill: 0.78, blurb: "Racing pace. Mistakes cost places." },
  { id: "expert", label: "Expert", skill: 0.9, blurb: "Championship pace." },
  { id: "legend", label: "Legend", skill: 0.99, blurb: "They do not make mistakes." }
];
const QUALITY_TIERS = ["low", "medium", "high", "ultra"];
const WEATHER_OPTIONS = ["clear", "scattered", "cloudy", "overcast", "rain", "storm"];
const ACTION_LABELS = {
  throttle: "Throttle",
  brake: "Brake",
  left: "Steer left",
  right: "Steer right",
  shiftUp: "Shift up",
  shiftDown: "Shift down",
  drs: "DRS",
  ers: "ERS overtake",
  pitLimiter: "Pit limiter",
  reset: "Reset to track",
  cameraCycle: "Change camera",
  toggleHud: "Toggle HUD",
  lookBack: "Look back",
  lookLeft: "Look left",
  lookRight: "Look right",
  pause: "Pause"
};
const KEY_GLYPHS = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  ShiftLeft: "L Shift",
  ShiftRight: "R Shift",
  ControlLeft: "L Ctrl",
  ControlRight: "R Ctrl",
  Space: "Space",
  Escape: "Esc",
  Backquote: "`"
};
function keyLabel(code) {
  if (KEY_GLYPHS[code]) return KEY_GLYPHS[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
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
  if (typeof value === "number") return `#${(value >>> 0).toString(16).padStart(6, "0")}`;
  return value ?? "#888";
}
export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== void 0) node.textContent = text;
  return node;
}
export class RowList {
  constructor(body, requestRender) {
    this.body = body;
    this.requestRender = requestRender;
    this.rows = [];
    this.focusIndex = 0;
  }
  clear() {
    this.body.replaceChildren();
    this.rows.length = 0;
  }
  addRow(label, valueText, opts = {}) {
    const index = this.rows.length;
    const row = el("div", "mm-row");
    if (opts.kind === "action") row.classList.add("mm-row-action");
    row.appendChild(el("div", "mm-row-label", label));
    if (opts.kind !== "action") {
      const value = el("div", "mm-row-value");
      if (opts.swatch) {
        const dot = el("span", "mm-swatch");
        dot.style.background = opts.swatch;
        value.appendChild(dot);
      }
      value.appendChild(el("span", "mm-row-text", valueText));
      row.appendChild(value);
      if (opts.arrows !== false && opts.onChange) {
        const arrows = el("div", "mm-row-arrows");
        const stepButton = (glyph, dir) => {
          const b = el("button", "mm-arrow", glyph);
          b.type = "button";
          b.addEventListener("click", (event) => {
            event.stopPropagation();
            this.focusIndex = index;
            opts.onChange(dir);
            this.requestRender();
          });
          return b;
        };
        arrows.appendChild(stepButton("‹", -1));
        arrows.appendChild(stepButton("›", 1));
        row.appendChild(arrows);
      }
    }
    if (opts.blurb) {
      row.appendChild(el("div", "mm-row-blurb", opts.blurb));
    }
    row.addEventListener("pointerenter", () => {
      this.focusIndex = index;
      this.paintFocus();
    });
    row.addEventListener("click", () => {
      this.focusIndex = index;
      if (opts.onActivate) {
        opts.onActivate();
        this.requestRender();
      } else {
        this.paintFocus();
      }
    });
    this.body.appendChild(row);
    this.rows.push({ node: row, ...opts });
    return row;
  }
  paintFocus() {
    if (!this.rows.length) return;
    this.focusIndex = clamp(this.focusIndex, 0, this.rows.length - 1);
    for (let i = 0; i < this.rows.length; i++) {
      this.rows[i].node.classList.toggle("is-focused", i === this.focusIndex);
    }
    this.rows[this.focusIndex].node.scrollIntoView({ block: "nearest" });
  }
  handleKey(event) {
    if (!this.rows.length) return false;
    const row = this.rows[this.focusIndex];
    switch (event.code) {
      case "ArrowDown":
        this.focusIndex = (this.focusIndex + 1) % this.rows.length;
        this.paintFocus();
        return true;
      case "ArrowUp":
        this.focusIndex = (this.focusIndex - 1 + this.rows.length) % this.rows.length;
        this.paintFocus();
        return true;
      case "ArrowLeft":
        if (row?.onChange) {
          row.onChange(-1);
          this.requestRender();
        }
        return true;
      case "ArrowRight":
        if (row?.onChange) {
          row.onChange(1);
          this.requestRender();
        }
        return true;
      case "Enter":
      case "NumpadEnter":
        if (row?.onActivate) row.onActivate();
        else if (row?.onChange) row.onChange(1);
        this.requestRender();
        return true;
      default:
        return false;
    }
  }
}
const PERCENT = (v) => `${Math.round(v * 100)}%`;
const PERCENT_OR_OFF = (v) => v > 0 ? PERCENT(v) : "Off";
const DEGREES = (v) => `${Math.round(v)}°`;
const UPPER = (v) => String(v).toUpperCase();
const STEP_EPSILON_FIX = (v) => Math.round(v * 1e4) / 1e4;
function clockLabel(hours) {
  const h = Math.floor(hours) % 24;
  const m = Math.round((hours - Math.floor(hours)) * 60) % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
export function addSettingsRows(list, ctx) {
  const read = (key, fallback) => {
    const v = ctx.settings?.get?.(key);
    return v === void 0 ? fallback : v;
  };
  const write = (key, value) => {
    ctx.settings?.set?.(key, value);
    if (key === "abs" || key === "tractionControl") {
      ctx.vehicle?.setAssists?.({
        abs: key === "abs" ? value : null,
        tractionControl: key === "tractionControl" ? value : null
      });
    }
  };
  const rangeRow = (label, key, min, max, step, fallback, format) => {
    list.addRow(label, format(read(key, fallback)), {
      onChange: (dir) => {
        write(key, STEP_EPSILON_FIX(clamp(read(key, fallback) + dir * step, min, max)));
      }
    });
  };
  const cycleRow = (label, key, options, fallback, format) => {
    const index = Math.max(0, options.indexOf(read(key, fallback)));
    list.addRow(label, format(options[index]), {
      onChange: (dir) => {
        write(key, options[(index + dir + options.length) % options.length]);
      }
    });
  };
  cycleRow("Graphics quality", "quality", QUALITY_TIERS, "high", UPPER);
  rangeRow("Field of view", "fov", 60, 110, 2, 82, DEGREES);
  rangeRow("Motion blur", "motionBlurStrength", 0, 1.5, 0.25, 1, PERCENT);
  rangeRow("Film grain", "filmGrain", 0, 2, 0.25, 1, PERCENT);
  rangeRow("Chromatic aberration", "chromaticAberration", 0, 2, 0.25, 1, PERCENT);
  rangeRow("Camera shake", "cameraShake", 0, 1.5, 0.1, 1, PERCENT);
  rangeRow("Head movement", "headMovement", 0, 1.5, 0.1, 1, PERCENT);
  rangeRow("Master volume", "masterVolume", 0, 1, 0.05, 0.8, PERCENT);
  rangeRow("Engine volume", "engineVolume", 0, 1.5, 0.05, 1, PERCENT);
  rangeRow("Traction control", "tractionControl", 0, 1, 0.25, 0, PERCENT_OR_OFF);
  rangeRow("ABS", "abs", 0, 1, 0.25, 0, PERCENT_OR_OFF);
  rangeRow("Steering assist", "steerAssist", 0, 1, 0.25, 0, PERCENT_OR_OFF);
  cycleRow("Units", "units", ["metric", "imperial"], "metric", UPPER);
  cycleRow("Head-up display", "showHud", [true, false], true, (v) => v ? "ON" : "OFF");
  rangeRow("Time of day", "timeOfDay", 5, 23, 0.5, 15.2, clockLabel);
  cycleRow("Weather", "weather", WEATHER_OPTIONS, "clear", UPPER);
}
export class MainMenu {
  constructor(ctx, root) {
    this.ctx = ctx;
    this.root = root;
    this.visible = false;
    this.screen = "main";
    this._startHandlers = [];
    this.config = {
      sessionType: 2,
      lengthIndex: 1,
      teamIndex: 0,
      driverSlot: 0,
      difficulty: 1
    };
    this._buildDom();
    this.list = new RowList(this.body, () => this._render());
    this._onKeyDown = (event) => this._handleKey(event);
  }
  onStart(fn) {
    this._startHandlers.push(fn);
  }
  _buildDom() {
    this.el = el("div", "mm");
    this.el.setAttribute("role", "dialog");
    const scrim = el("div", "mm-scrim");
    this.el.appendChild(scrim);
    const frame = el("div", "mm-frame");
    const header = el("div", "mm-header");
    const brand = el("div", "mm-brand");
    brand.appendChild(el("span", "mm-wordmark", "APEX"));
    brand.appendChild(el("span", "mm-brand-sub", "Formula One"));
    header.appendChild(brand);
    const venue = el("div", "mm-venue");
    venue.appendChild(el("div", "mm-venue-name", this.ctx.track?.name ?? "Spa-Francorchamps"));
    venue.appendChild(el("div", "mm-venue-meta", this.ctx.track?.country ?? "Belgium"));
    header.appendChild(venue);
    frame.appendChild(header);
    this.body = el("div", "mm-body");
    frame.appendChild(this.body);
    this.hint = el("div", "mm-hint");
    frame.appendChild(this.hint);
    this.el.appendChild(frame);
    this.root.appendChild(this.el);
  }
  show() {
    if (this.visible) return;
    this.visible = true;
    this.screen = "main";
    this.list.focusIndex = 0;
    this.el.classList.add("is-open");
    document.getElementById("apex-hud")?.classList.add("is-hidden");
    this._render();
    globalThis.addEventListener("keydown", this._onKeyDown, { capture: true });
  }
  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.el.classList.remove("is-open");
    document.getElementById("apex-hud")?.classList.remove("is-hidden");
    globalThis.removeEventListener("keydown", this._onKeyDown, { capture: true });
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
    this.list.clear();
    if (this.screen === "main") this._renderMain();
    else if (this.screen === "settings") this._renderSettings();
    else this._renderControls();
    this.list.paintFocus();
  }
  _renderMain() {
    const session = SESSION_TYPES[this.config.sessionType];
    const team = TEAMS[this.config.teamIndex];
    const driver = this._selectedDriver();
    const difficulty = DIFFICULTIES[this.config.difficulty];
    this.list.addRow("Session", session.label, {
      blurb: session.blurb,
      onChange: (dir) => {
        this.config.sessionType = (this.config.sessionType + dir + SESSION_TYPES.length) % SESSION_TYPES.length;
      }
    });
    if (session.id === "race") {
      this.list.addRow("Race distance", `${RACE_LENGTHS[this.config.lengthIndex]} laps`, {
        onChange: (dir) => {
          this.config.lengthIndex = clamp(this.config.lengthIndex + dir, 0, RACE_LENGTHS.length - 1);
        }
      });
    }
    this.list.addRow("Team", team.name, {
      swatch: cssColor(team.colors.primary),
      blurb: `${team.engine} · ${team.country}`,
      onChange: (dir) => {
        this.config.teamIndex = (this.config.teamIndex + dir + TEAMS.length) % TEAMS.length;
        this.config.driverSlot = 0;
      }
    });
    this.list.addRow("Driver", `${driver.number}  ${driver.name}`, {
      blurb: driver.country,
      onChange: (dir) => {
        const drivers = this._teamDrivers();
        this.config.driverSlot = (this.config.driverSlot + dir + drivers.length) % drivers.length;
      }
    });
    this.list.addRow("Difficulty", difficulty.label, {
      blurb: difficulty.blurb,
      onChange: (dir) => {
        this.config.difficulty = clamp(this.config.difficulty + dir, 0, DIFFICULTIES.length - 1);
      }
    });
    this.list.addRow("Start session", "", {
      kind: "action",
      onActivate: () => this._start()
    });
    this.list.addRow("Settings", "", {
      kind: "action",
      onActivate: () => {
        this.screen = "settings";
        this.list.focusIndex = 0;
      }
    });
    this.list.addRow("Controls", "", {
      kind: "action",
      onActivate: () => {
        this.screen = "controls";
        this.list.focusIndex = 0;
      }
    });
    this.hint.textContent = "Arrows navigate and change  ·  Enter selects  ·  Esc backs out";
  }
  _renderSettings() {
    addSettingsRows(this.list, this.ctx);
    this.list.addRow("Back", "", {
      kind: "action",
      onActivate: () => {
        this.screen = "main";
        this.list.focusIndex = 0;
      }
    });
    this.hint.textContent = "Changes apply immediately  ·  Esc returns";
  }
  _renderControls() {
    const map = bindingsByAction();
    const grid = el("div", "mm-controls");
    for (const [action, label] of Object.entries(ACTION_LABELS)) {
      const keys = map.get(action);
      if (!keys) continue;
      const item = el("div", "mm-control");
      item.appendChild(el("div", "mm-control-label", label));
      const keyWrap = el("div", "mm-control-keys");
      for (const k of keys) keyWrap.appendChild(el("kbd", "mm-key", k));
      item.appendChild(keyWrap);
      grid.appendChild(item);
    }
    this.body.appendChild(grid);
    const pad = el("div", "mm-pad-note");
    pad.textContent = "Gamepad and wheel are detected automatically. Triggers steer throttle and brake, shoulder buttons shift, and the left stick steers.";
    this.body.appendChild(pad);
    this.list.addRow("Back", "", {
      kind: "action",
      onActivate: () => {
        this.screen = "main";
        this.list.focusIndex = 0;
      }
    });
    this.hint.textContent = "Esc returns";
  }
  _handleKey(event) {
    if (!this.visible) return;
    let handled = this.list.handleKey(event);
    if (!handled && event.code === "Escape") {
      if (this.screen !== "main") {
        this.screen = "main";
        this.list.focusIndex = 0;
        this._render();
      }
      handled = true;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
  _start() {
    const driver = this._selectedDriver();
    const seat = DRIVERS.indexOf(driver);
    const currentSeat = this.ctx.settings?.get?.("playerDriver") ?? 0;
    const session = SESSION_TYPES[this.config.sessionType];
    const laps = RACE_LENGTHS[this.config.lengthIndex];
    const skill = DIFFICULTIES[this.config.difficulty].skill;
    if (seat >= 0 && seat !== currentSeat) {
      this.ctx.settings?.set?.("playerDriver", seat);
      const params = new URLSearchParams(globalThis.location.search);
      params.set("autostart", "1");
      params.set("session", session.id);
      params.set("laps", String(laps));
      params.set("skill", String(skill));
      globalThis.location.search = params.toString();
      return;
    }
    this.applyToSession({ session: session.id, laps, skill });
    this.hide();
    for (const fn of this._startHandlers) fn({ session: session.id, laps, skill });
  }
  applyToSession({ session, laps, skill }) {
    const ctx = this.ctx;
    ctx.race?.setSession?.(session, { totalLaps: session === "race" ? laps : void 0 });
    const cars = ctx.cars ?? [];
    for (let i = 1; i < cars.length; i++) {
      const ai = cars[i]?.ai;
      if (!ai) continue;
      const spread = i % 5 * 0.012;
      ai.skill = clamp(skill - spread, 0, 1);
    }
  }
}
