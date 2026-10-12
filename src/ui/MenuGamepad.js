import { firstConnectedGamepad } from "../core/Input.js";
const DIRECTIONS = {
  up: { button: 12, axis: 1, sign: -1 },
  down: { button: 13, axis: 1, sign: 1 },
  left: { button: 14, axis: 0, sign: -1 },
  right: { button: 15, axis: 0, sign: 1 }
};
const BUTTONS = {
  select: [0],
  back: [1],
  start: [8, 9]
};
const STICK_PRESS = 0.5;
const STICK_RELEASE = 0.35;
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 120;
const MENU_KEY_CODES = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  select: "Enter",
  back: "Escape"
};
export function gamepadConnected() {
  return firstConnectedGamepad()?.mapping === "standard";
}
export function menuKeyEvent(action) {
  const code = MENU_KEY_CODES[action];
  if (!code) return null;
  return { code, preventDefault() {}, stopPropagation() {} };
}
function padKey(pad) {
  return pad ? `${pad.index}|${pad.id}` : null;
}
function buttonPressed(pad, index) {
  return !!pad.buttons[index]?.pressed;
}
function anyPressed(pad, indices) {
  return indices.some((i) => buttonPressed(pad, i));
}
function stickValue(pad, dir) {
  const raw = pad.axes?.[dir.axis];
  return Number.isFinite(raw) ? raw * dir.sign : 0;
}
function stickDirection(pad, current) {
  if (current && stickValue(pad, DIRECTIONS[current]) > STICK_RELEASE) return current;
  let best = null;
  let bestValue = -Infinity;
  for (const [name, dir] of Object.entries(DIRECTIONS)) {
    const v = stickValue(pad, dir);
    if (v > bestValue) {
      best = name;
      bestValue = v;
    }
  }
  return bestValue >= STICK_PRESS ? best : null;
}
export class MenuGamepad {
  constructor(onAction, onConnectionChange) {
    this.onAction = onAction;
    this.onConnectionChange = onConnectionChange ?? null;
    this.running = false;
    this._raf = 0;
    this._epoch = 0;
    this._padKey = null;
    this._stick = null;
    this._buttons = {};
    for (const name of Object.keys(BUTTONS)) this._buttons[name] = false;
    this._dirs = {};
    for (const name of Object.keys(DIRECTIONS)) {
      this._dirs[name] = { held: false, latched: false, next: 0 };
    }
    this._loop = () => {
      this._raf = requestAnimationFrame(this._loop);
      this._poll(performance.now());
    };
  }
  start() {
    if (this.running) return;
    this.running = true;
    this._epoch++;
    this._snapshot(firstConnectedGamepad());
    this._raf = requestAnimationFrame(this._loop);
  }
  stop() {
    if (!this.running) return;
    this.running = false;
    this._epoch++;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }
  _snapshot(pad) {
    this._padKey = padKey(pad);
    this._stick = pad ? stickDirection(pad, null) : null;
    for (const [name, indices] of Object.entries(BUTTONS)) {
      this._buttons[name] = !!pad && anyPressed(pad, indices);
    }
    for (const [name, dir] of Object.entries(DIRECTIONS)) {
      const state = this._dirs[name];
      state.held = this._stick === name || (!!pad && buttonPressed(pad, dir.button));
      state.latched = state.held;
      state.next = 0;
    }
  }
  _poll(now) {
    const epoch = this._epoch;
    const pad = firstConnectedGamepad();
    if (padKey(pad) !== this._padKey) {
      this._snapshot(pad);
      this.onConnectionChange?.(pad !== null);
      return;
    }
    if (!pad) return;
    this._stick = stickDirection(pad, this._stick);
    for (const [name, dir] of Object.entries(DIRECTIONS)) {
      const state = this._dirs[name];
      const held = this._stick === name || buttonPressed(pad, dir.button);
      if (!held) {
        state.held = false;
        state.latched = false;
        continue;
      }
      if (state.latched) continue;
      if (!state.held) {
        state.held = true;
        state.next = now + REPEAT_DELAY_MS;
      } else if (now >= state.next) {
        state.next += REPEAT_INTERVAL_MS;
        if (state.next <= now) state.next = now + REPEAT_INTERVAL_MS;
      } else {
        continue;
      }
      this.onAction(name);
      if (epoch !== this._epoch) return;
    }
    for (const [name, indices] of Object.entries(BUTTONS)) {
      const down = anyPressed(pad, indices);
      const was = this._buttons[name];
      this._buttons[name] = down;
      if (down && !was) {
        this.onAction(name);
        if (epoch !== this._epoch) return;
      }
    }
  }
}
