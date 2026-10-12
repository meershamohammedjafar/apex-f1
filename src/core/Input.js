import { clamp, clamp01, moveTowards } from "./MathUtils.js";
export const KEY_ACTIONS = {
  KeyW: "throttle",
  ArrowUp: "throttle",
  KeyS: "brake",
  ArrowDown: "brake",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
  ShiftLeft: "shiftUp",
  ShiftRight: "shiftUp",
  ControlLeft: "shiftDown",
  ControlRight: "shiftDown",
  KeyE: "shiftUp",
  KeyQ: "shiftDown",
  Space: "drs",
  KeyF: "ers",
  KeyL: "pitLimiter",
  KeyR: "reset",
  KeyC: "cameraCycle",
  KeyH: "toggleHud",
  KeyM: "lookBack",
  KeyZ: "lookLeft",
  KeyX: "lookRight",
  Escape: "pause",
  Backquote: "debug"
};
const PAD_BUTTONS = {
  0: "drs",
  1: "reset",
  2: "ers",
  3: "cameraCycle",
  4: "shiftDown",
  5: "shiftUp",
  8: "pause",
  9: "pause",
  10: "lookBack"
};
export class Input {
  static systemName = "input";
  constructor() {
    this.controls = {
      throttle: 0,
      brake: 0,
      steer: 0,
      clutch: 0,
      shiftUp: false,
      shiftDown: false,
      drs: false,
      ers: false,
      pitLimiter: false,
      lookLeft: 0,
      lookRight: 0,
      lookBack: false,
      reset: false
    };
    this._down = new Set();
    this._pressed = new Set();
    this._released = new Set();
    this._padPrev = new Map();
    this._steerRaw = 0;
    this._throttleRaw = 0;
    this._brakeRaw = 0;
    this.usingGamepad = false;
    this.enabled = true;
    this._bound = false;
  }
  async init(ctx) {
    this.ctx = ctx;
    this._onKeyDown = (e) => {
      const action = KEY_ACTIONS[e.code];
      if (!action) return;
      if (e.metaKey || e.ctrlKey === false) e.preventDefault();
      if (!this._down.has(action)) this._pressed.add(action);
      this._down.add(action);
      this.usingGamepad = false;
    };
    this._onKeyUp = (e) => {
      const action = KEY_ACTIONS[e.code];
      if (!action) return;
      e.preventDefault();
      this._down.delete(action);
      this._released.add(action);
    };
    this._onBlur = () => {
      this._down.clear();
      this._steerRaw = this._throttleRaw = this._brakeRaw = 0;
    };
    globalThis.addEventListener("keydown", this._onKeyDown, { passive: false });
    globalThis.addEventListener("keyup", this._onKeyUp, { passive: false });
    globalThis.addEventListener("blur", this._onBlur);
    this._bound = true;
  }
  isDown(action) {
    return this._down.has(action);
  }
  wasPressed(action) {
    return this._pressed.has(action);
  }
  wasReleased(action) {
    return this._released.has(action);
  }
  update(dt, ctx) {
    const c = this.controls;
    if (!this.enabled) {
      c.shiftUp = c.shiftDown = false;
      this._steerRaw = this._throttleRaw = this._brakeRaw = 0;
      this._down.clear();
      this._pressed.clear();
      this._released.clear();
      return;
    }
    this._pollGamepad();
    const speed = ctx?.vehicle?.state?.speed ?? 0;
    if (!this.usingGamepad) {
      const tTarget = this.isDown("throttle") ? 1 : 0;
      const bTarget = this.isDown("brake") ? 1 : 0;
      this._throttleRaw = moveTowards(this._throttleRaw, tTarget, (tTarget > 0 ? 4 : 9) * dt);
      this._brakeRaw = moveTowards(this._brakeRaw, bTarget, (bTarget > 0 ? 6 : 12) * dt);
      const speedFactor = 1 / (1 + Math.abs(speed) * 0.022);
      const applyRate = 3.4 * speedFactor + 0.55;
      const returnRate = 6.5 * speedFactor + 1.6;
      let sTarget = 0;
      if (this.isDown("left")) sTarget -= 1;
      if (this.isDown("right")) sTarget += 1;
      if (sTarget !== 0) {
        const crossing = Math.sign(sTarget) !== Math.sign(this._steerRaw) && this._steerRaw !== 0;
        this._steerRaw = moveTowards(this._steerRaw, sTarget, (crossing ? returnRate : applyRate) * dt);
      } else {
        this._steerRaw = moveTowards(this._steerRaw, 0, returnRate * dt);
      }
      c.throttle = this._throttleRaw;
      c.brake = this._brakeRaw;
      c.steer = clamp(this._steerRaw, -1, 1);
    }
    c.shiftUp = this._pressed.has("shiftUp");
    c.shiftDown = this._pressed.has("shiftDown");
    c.drs = this._down.has("drs");
    c.ers = this._down.has("ers");
    c.pitLimiter = this._pressed.has("pitLimiter");
    c.reset = this._pressed.has("reset");
    c.lookBack = this._down.has("lookBack");
    c.lookLeft = this._down.has("lookLeft") ? 1 : 0;
    c.lookRight = this._down.has("lookRight") ? 1 : 0;
    if (this._pressed.has("cameraCycle")) ctx?.events?.emit("camera:mode", { cycle: true });
    if (this._pressed.has("toggleHud")) ctx?.events?.emit("hud:toggle", {});
    if (this._pressed.has("pause")) ctx?.events?.emit("game:pause", {});
    if (this._pressed.has("debug")) ctx?.events?.emit("debug:toggle", {});
  }
  endFrame() {
    this._pressed.clear();
    this._released.clear();
  }
  _pollGamepad() {
    const pads = globalThis.navigator?.getGamepads?.();
    if (!pads) return;
    let pad = null;
    for (const p of pads) {
      if (p && p.connected) {
        pad = p;
        break;
      }
    }
    if (!pad) return;
    const dead = 0.08;
    const ax = (i) => {
      const v = pad.axes[i] ?? 0;
      return Math.abs(v) < dead ? 0 : (v - Math.sign(v) * dead) / (1 - dead);
    };
    const rt = pad.buttons[7]?.value ?? 0;
    const lt = pad.buttons[6]?.value ?? 0;
    const steer = ax(0);
    const active = Math.abs(steer) > 0 || rt > 0.02 || lt > 0.02;
    if (active) this.usingGamepad = true;
    if (this.usingGamepad) {
      const c = this.controls;
      c.steer = clamp(steer, -1, 1);
      c.throttle = clamp01(rt);
      c.brake = clamp01(lt);
      this._steerRaw = c.steer;
      this._throttleRaw = c.throttle;
      this._brakeRaw = c.brake;
    }
    for (const [index, action] of Object.entries(PAD_BUTTONS)) {
      const i = Number(index);
      const pressed = !!pad.buttons[i]?.pressed;
      const was = this._padPrev.get(i) ?? false;
      if (pressed && !was) {
        this._pressed.add(action);
        this._down.add(action);
      } else if (!pressed && was) {
        this._down.delete(action);
        this._released.add(action);
      }
      this._padPrev.set(i, pressed);
    }
  }
  dispose() {
    if (!this._bound) return;
    globalThis.removeEventListener("keydown", this._onKeyDown);
    globalThis.removeEventListener("keyup", this._onKeyUp);
    globalThis.removeEventListener("blur", this._onBlur);
    this._bound = false;
  }
}
