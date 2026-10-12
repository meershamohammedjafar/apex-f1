#!/usr/bin/env node
import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = ".mm:not(.mm-pause)";
const PAUSE = ".mm.mm-pause";
const BTN = { A: 0, B: 1, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const STICK_Y = 1;
const BOOT_MS = 600000;
const WAIT_MS = 45000;
const SHORT_MS = 15000;
const FRAME_MS = 6000;
const TAP_FRAMES = 30;
const HOLD_FRAMES = 10;
const NAV_LIMIT = 24;
const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 120;
const TIMING_SLACK_MS = 20;
const SAFE_SETTINGS = ["Field of view", "Film grain", "Camera shake", "Head movement"];
const SEP = "  ·  ";
const HINTS = {
  keysMain: ["Arrows navigate and change", "Enter selects", "Esc backs out"].join(SEP),
  keysPause: ["Arrows navigate", "Enter selects", "Esc resumes"].join(SEP),
  keysSettings: ["Changes apply immediately", "Esc returns"].join(SEP),
  keysControls: "Esc returns",
  padPause: ["D-pad navigates", "A selects", "B back", "Start resumes"].join(SEP),
  padSettings: ["Changes apply immediately", "B returns"].join(SEP)
};
const isStart = (label) => /^start\b/i.test(label ?? "");
const sameRows = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const medianFrame = (ticks, until) => {
  const seen = ticks.filter((f) => f <= until);
  const deltas = seen.slice(1).map((f, i) => f - seen[i]).sort((a, b) => a - b);
  return deltas.length ? deltas[Math.floor(deltas.length / 2)] : Infinity;
};
const separatorStyle = (raw) => {
  const parts = String(raw ?? "").split(SEP);
  return parts.length > 1 && parts.every((p) => p.length > 0 && p === p.trim() && !p.includes("·"));
};
function installFakePad() {
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  const axes = [0, 0, 0, 0];
  let connected = true;
  let timestamp = performance.now();
  const snapshot = () => ({
    id: "Test pad",
    index: 0,
    connected: true,
    mapping: "standard",
    timestamp,
    axes: axes.slice(),
    buttons: buttons.map((b) => ({ pressed: b.pressed, touched: b.touched, value: b.value })),
    vibrationActuator: null
  });
  Object.defineProperty(Navigator.prototype, "getGamepads", {
    configurable: true,
    writable: true,
    value: function getGamepads() {
      return connected ? [snapshot(), null, null, null] : [null, null, null, null];
    }
  });
  const setButton = (index, pressed) => {
    const b = buttons[index];
    if (!b) return false;
    b.pressed = !!pressed;
    b.touched = !!pressed;
    b.value = pressed ? 1 : 0;
    timestamp = performance.now();
    return true;
  };
  const setAxis = (index, value) => {
    if (!(index >= 0 && index < axes.length)) return false;
    axes[index] = Number(value) || 0;
    timestamp = performance.now();
    return true;
  };
  const setConnected = (value) => {
    connected = !!value;
    timestamp = performance.now();
    return true;
  };
  const releaseAll = () => {
    let held = false;
    buttons.forEach((b, i) => {
      if (b.pressed) {
        held = true;
        setButton(i, false);
      }
    });
    axes.forEach((v, i) => {
      if (v !== 0) {
        held = true;
        setAxis(i, 0);
      }
    });
    if (!connected) {
      held = true;
      setConnected(true);
    }
    return held;
  };
  const afterFrames = (n, cb) => {
    let count = 0;
    const tick = () => {
      count += 1;
      if (count >= n) cb();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  const frames = (n, timeoutMs) => new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      resolve(false);
    }, timeoutMs);
    afterFrames(n, () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
  const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
  const menu = (selector) => {
    const root = document.querySelector(selector);
    if (!root) return { exists: false, open: false, focus: -1, count: 0, rows: [], focusedLabel: null, hint: "", hintRaw: "", padNote: "" };
    const nodes = Array.from(root.querySelectorAll(".mm-row"));
    const rows = nodes.map((node) => {
      const value = node.querySelector(".mm-row-value .mm-row-text");
      return { label: text(node.querySelector(".mm-row-label")), value: value ? text(value) : null };
    });
    const focus = nodes.findIndex((node) => node.classList.contains("is-focused"));
    return {
      exists: true,
      open: root.classList.contains("is-open"),
      focus,
      count: rows.length,
      rows,
      focusedLabel: focus >= 0 ? rows[focus].label : null,
      hint: text(root.querySelector(".mm-hint")),
      hintRaw: root.querySelector(".mm-hint")?.textContent ?? "",
      padNote: text(root.querySelector(".mm-pad-note"))
    };
  };
  const rowValue = (selector, label) => menu(selector).rows.find((r) => r.label === label)?.value ?? null;
  const meaningful = (root, record) => {
    const target = record.target;
    if (record.type === "attributes") return target === root || !!target.classList?.contains("mm-row");
    if (record.type === "childList") return target === root || !!target.classList?.contains("mm-body");
    return false;
  };
  const tap = (index, selector, maxFrames, timeoutMs) => new Promise((resolve) => {
    const root = document.querySelector(selector);
    let done = false;
    let count = 0;
    let timer = 0;
    let observer = null;
    const finish = (changed) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (observer) observer.disconnect();
      setButton(index, false);
      frames(2, timeoutMs).then(() => resolve({ changed, frames: count }));
    };
    if (root) {
      observer = new MutationObserver((records) => {
        if (records.some((r) => meaningful(root, r))) finish(true);
      });
      observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    }
    timer = setTimeout(() => finish(false), timeoutMs);
    const tick = () => {
      if (done) return;
      count += 1;
      if (count >= maxFrames) finish(false);
      else requestAnimationFrame(tick);
    };
    setButton(index, true);
    requestAnimationFrame(tick);
  });
  const focusGains = (records, into, now) => {
    for (const r of records) {
      if (r.type !== "attributes" || !r.target.classList?.contains("mm-row")) continue;
      if (!` ${r.oldValue ?? ""} `.includes(" is-focused ")) into.push(now);
    }
  };
  const stickRun = (selector, segments, timeoutMs) => new Promise((resolve) => {
    const root = document.querySelector(selector);
    if (!root) {
      resolve({ ok: false, moves: [], marks: [], ticks: [] });
      return;
    }
    const moves = [];
    const marks = [];
    const ticks = [];
    const observer = new MutationObserver((records) => focusGains(records, moves, performance.now()));
    observer.observe(root, { subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    let index = -1;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      focusGains(observer.takeRecords(), moves, performance.now());
      observer.disconnect();
      setAxis(0, 0);
      setAxis(1, 0);
      const origin = marks[0] ?? 0;
      const rel = (list) => list.map((m) => m - origin);
      resolve({ ok, moves: rel(moves), marks: rel(marks), ticks: rel(ticks) });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    const record = () => {
      if (done) return;
      ticks.push(performance.now());
      requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
    const next = () => {
      if (done) return;
      index += 1;
      if (index >= segments.length) {
        finish(true);
        return;
      }
      const seg = segments[index];
      setAxis(0, seg.x ?? 0);
      setAxis(1, seg.y ?? 0);
      marks.push(performance.now());
      if (seg.ms !== void 0) setTimeout(next, seg.ms);
      else afterFrames(seg.frames ?? 1, next);
    };
    next();
  });
  let spy = null;
  const unspy = () => {
    if (spy) spy.restore();
    spy = null;
    return true;
  };
  const spyInput = () => {
    const input = globalThis.APEX?.ctx?.input;
    if (!input || typeof input.update !== "function") return false;
    unspy();
    const own = Object.prototype.hasOwnProperty.call(input, "update");
    const original = input.update;
    const state = { calls: 0, enabledCalls: 0, resets: 0, drs: 0, pauseOpen: 0 };
    input.update = function update(...args) {
      const result = original.apply(this, args);
      state.calls += 1;
      if (this.enabled) state.enabledCalls += 1;
      if (this.controls?.reset) state.resets += 1;
      if (this.controls?.drs) state.drs += 1;
      if (document.querySelector(".mm.mm-pause")?.classList.contains("is-open")) state.pauseOpen += 1;
      return result;
    };
    spy = {
      state,
      restore: () => {
        if (own) input.update = original;
        else delete input.update;
      }
    };
    return true;
  };
  const spyState = () => spy ? { ...spy.state } : null;
  const engine = (command) => {
    const e = globalThis.APEX;
    if (!e || typeof e.stop !== "function" || typeof e.start !== "function") return false;
    if (command === "stop") e.stop();
    else e.start();
    return true;
  };
  globalThis.__padTest = {
    setButton,
    setAxis,
    setConnected,
    releaseAll,
    frames,
    menu,
    rowValue,
    tap,
    stickRun,
    spyInput,
    spyState,
    unspy,
    engine
  };
}
function checker() {
  const failures = [];
  const notes = [];
  return {
    expect(condition, message) {
      if (!condition) failures.push(`expected ${message}`);
      return Boolean(condition);
    },
    fail(message) {
      failures.push(message);
    },
    note(message) {
      notes.push(message);
    },
    result() {
      const parts = failures.length ? [...failures, ...notes] : notes;
      return { ok: failures.length === 0, detail: parts.join("; ") || "ok" };
    }
  };
}
function helpers(page) {
  const call = (name, ...args) => page.evaluate(([fn, list]) => globalThis.__padTest[fn](...list), [name, args]);
  const waitFor = async (fn, arg, timeout = WAIT_MS) => {
    try {
      await page.waitForFunction(fn, arg, { timeout, polling: "raf" });
      return true;
    } catch {
      return false;
    }
  };
  const h = {
    call,
    waitFor,
    sleep: (ms) => page.waitForTimeout(ms),
    press: (button) => call("setButton", button, true),
    release: (button) => call("setButton", button, false),
    axis: (index, value) => call("setAxis", index, value),
    connect: (value) => call("setConnected", value),
    releaseAll: () => call("releaseAll"),
    menu: (selector) => call("menu", selector),
    rowValue: (selector, label) => call("rowValue", selector, label),
    tap: (button, selector) => call("tap", button, selector, TAP_FRAMES, WAIT_MS),
    stick: (selector, segments) => call("stickRun", selector, segments, WAIT_MS),
    engine: (command) => call("engine", command),
    async frames(n) {
      const ok = await call("frames", n, WAIT_MS + n * FRAME_MS);
      if (!ok) throw new Error(`${n} animation frames did not arrive in time`);
    },
    game: () => page.evaluate(() => {
      const ctx = globalThis.APEX?.ctx;
      return { paused: ctx?.paused, inputEnabled: ctx?.input?.enabled, elapsed: ctx?.time?.elapsed ?? 0 };
    }),
    key: (code) => page.keyboard.press(code),
    waitOpen: (selector, timeout = WAIT_MS) => waitFor(
      (s) => document.querySelector(s)?.classList.contains("is-open") === true,
      selector,
      timeout
    ),
    waitRunning: (selector, timeout = SHORT_MS) => waitFor(
      (s) => document.querySelector(s)?.classList.contains("is-open") !== true && globalThis.APEX?.ctx?.paused === false,
      selector,
      timeout
    ),
    waitRow: (selector, label, timeout = SHORT_MS) => waitFor(
      ([s, l]) => globalThis.__padTest.menu(s).rows.some((r) => r.label === l),
      [selector, label],
      timeout
    ),
    waitHint: (selector, raw, timeout = SHORT_MS) => waitFor(
      ([s, r]) => globalThis.__padTest.menu(s).hintRaw === r,
      [selector, raw],
      timeout
    )
  };
  h.navigateTo = async (selector, match, mode = "down") => {
    for (let presses = 0; presses <= NAV_LIMIT; presses++) {
      const s = await h.menu(selector);
      if (!s.open) return { ok: false, why: "menu not open" };
      if (s.focus >= 0 && match(s.focusedLabel)) return { ok: true, why: `${presses} presses` };
      let button = BTN.DOWN;
      if (mode === "shortest") {
        const target = s.rows.findIndex((r) => match(r.label));
        if (target < 0) return { ok: false, why: "target row not found" };
        const from = Math.max(0, s.focus);
        const down = (target - from + s.count) % s.count;
        if (down > s.count - down) button = BTN.UP;
      }
      const r = await h.tap(button, selector);
      if (!r.changed) {
        return { ok: false, why: `d-pad ${button === BTN.UP ? "up" : "down"} did not move focus from "${s.focusedLabel}"` };
      }
    }
    return { ok: false, why: `not reached in ${NAV_LIMIT} presses` };
  };
  h.keyTo = async (selector, match) => {
    for (let presses = 0; presses <= NAV_LIMIT; presses++) {
      const s = await h.menu(selector);
      if (!s.open) return { ok: false, why: "menu not open" };
      if (s.focus >= 0 && match(s.focusedLabel)) return { ok: true, why: `${presses} presses` };
      await h.key("ArrowDown");
      const after = await h.menu(selector);
      if (after.focus === s.focus) return { ok: false, why: `ArrowDown did not move focus from "${s.focusedLabel}"` };
    }
    return { ok: false, why: `not reached in ${NAV_LIMIT} presses` };
  };
  h.stickWithinDelay = async (selector, segments, holds, prepare) => {
    let best = Infinity;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await h.sleep(1000);
      if (prepare) {
        const ready = await prepare();
        if (!ready.ok) return { run: null, failed: true, why: ready.why };
      }
      const before = await h.menu(selector);
      const run = await h.stick(selector, segments);
      const after = await h.menu(selector);
      const longest = Math.max(...holds.map(([from, to]) => (run.marks[to] ?? Infinity) - (run.marks[from] ?? 0)));
      if (run.ok && longest < REPEAT_DELAY_MS - TIMING_SLACK_MS) return { run, before, after };
      best = Math.min(best, longest);
    }
    return { run: null, failed: false, why: `the shortest hold took ${best.toFixed(0)} ms, past the ${REPEAT_DELAY_MS} ms repeat delay` };
  };
  return h;
}
async function stepMainMenuDpad(t, h, shared) {
  const opened = await h.waitOpen(MAIN);
  const g = await h.game();
  const s0 = await h.menu(MAIN);
  shared.mainRows = s0.rows;
  shared.mainHint = s0.hintRaw;
  if (!t.expect(opened && s0.open, "main menu open after boot")) return;
  t.expect(g.paused === true, `ctx.paused true at the main menu (got ${g.paused})`);
  t.expect(s0.count >= 2, `at least two rows (got ${s0.count})`);
  t.expect(s0.focus === 0, `focus on row 0 at boot (got ${s0.focus})`);
  const down = await h.tap(BTN.DOWN, MAIN);
  const s1 = await h.menu(MAIN);
  t.expect(s1.focus === 1, `d-pad down to focus row 1 (got ${s1.focus}${down.changed ? "" : ", menu did not react"})`);
  const up = await h.tap(BTN.UP, MAIN);
  const s2 = await h.menu(MAIN);
  t.expect(s2.focus === 0, `d-pad up to focus row 0 again (got ${s2.focus}${up.changed ? "" : ", menu did not react"})`);
  t.note(`${s0.count} rows, focus ${s0.focus} -> ${s1.focus} -> ${s2.focus}`);
}
async function stepStick(t, h) {
  const s0 = await h.menu(MAIN);
  if (!t.expect(s0.open, "main menu open")) return;
  if (!t.expect(await h.engine("stop"), "engine stopped so frames arrive at display rate")) return;
  const verdict = (name, result, check) => {
    if (result.run) check(result);
    else if (result.failed) t.fail(`${name}: ${result.why}`);
    else t.note(`${name} not checked, frames too slow: ${result.why}`);
  };
  try {
    const dead = await h.stick(MAIN, [{ y: 0.45, frames: 8 }, { frames: 3 }]);
    t.expect(dead.ok && dead.moves.length === 0, `stick at 0.45 to stay under the press threshold (moved ${dead.moves.length})`);
    const sticky = await h.stickWithinDelay(MAIN, [{ y: 0.6, frames: 2 }, { y: 0.4, frames: 2 }, { y: 0.6, frames: 2 }, { frames: 3 }], [[0, 3]]);
    verdict("hysteresis hold", sticky, ({ run }) => {
      t.expect(run.moves.length === 1, `stick 0.6 -> 0.4 -> 0.6 to move once (moved ${run.moves.length})`);
    });
    const repress = await h.stickWithinDelay(MAIN, [{ y: 0.6, frames: 2 }, { y: 0.3, frames: 2 }, { y: 0.6, frames: 2 }, { frames: 3 }], [[0, 1], [2, 3]]);
    verdict("hysteresis release", repress, ({ run }) => {
      t.expect(run.moves.length === 2, `stick 0.6 -> 0.3 -> 0.6 to move twice (moved ${run.moves.length})`);
    });
    let hold = null;
    let frameMs = Infinity;
    for (let attempt = 0; attempt < 3 && frameMs > 50; attempt++) {
      if (attempt) await h.sleep(2000);
      hold = await h.stick(MAIN, [{ y: 0.9, ms: 1800 }, { frames: 4 }]);
      frameMs = medianFrame(hold.ticks, hold.marks[1] ?? 0);
    }
    const release = hold.marks[1] ?? 0;
    const ticks = hold.ticks.filter((f) => f <= release);
    const during = hold.moves.filter((m) => m <= release);
    const after = hold.moves.length - during.length;
    t.expect(hold.ok, "stick hold to finish");
    t.expect(during.length >= 3, `held stick to auto-repeat (got ${during.length} moves in ${release.toFixed(0)} ms)`);
    t.expect(after === 0, `no movement after the stick is released (moved ${after} more)`);
    if (during.length > 0) {
      const framesBefore = ticks.filter((f) => f < during[0]).length;
      t.expect(framesBefore <= 2, `first move on the press, not after the repeat delay (${framesBefore} frames, +${during[0].toFixed(0)} ms)`);
      const early = [];
      for (let k = 1; k < during.length; k++) {
        const min = REPEAT_DELAY_MS + REPEAT_INTERVAL_MS * (k - 1);
        const got = during[k] - during[0];
        if (got < min - TIMING_SLACK_MS) early.push(`move ${k + 1} at +${got.toFixed(0)} ms, min ${min}`);
      }
      t.expect(early.length === 0, `repeats no sooner than ${REPEAT_DELAY_MS} ms, then every ${REPEAT_INTERVAL_MS} ms (${early.slice(0, 3).join(", ")})`);
      if (frameMs <= 50 && during.length >= 3) {
        const rate = (during[during.length - 1] - during[1]) / (during.length - 2);
        t.expect(during.length >= 8, `at least 8 moves in ${release.toFixed(0)} ms at ${frameMs.toFixed(0)} ms frames (got ${during.length})`);
        t.expect(rate <= REPEAT_INTERVAL_MS + 60, `repeats about every ${REPEAT_INTERVAL_MS} ms (averaged ${rate.toFixed(0)} ms)`);
      } else {
        t.note(`repeat rate upper bound not checked, frames every ${frameMs.toFixed(0)} ms`);
      }
      const gaps = during.slice(1).map((m, i) => (m - during[i]).toFixed(0));
      t.note(`${during.length} moves in ${release.toFixed(0)} ms, frames ${frameMs.toFixed(0)} ms, gaps ${gaps.join("/")}`);
    }
    const toSession = async () => {
      const nav = await h.navigateTo(MAIN, (l) => l === "Session", "shortest");
      return { ok: nav.ok, why: `d-pad to the Session row: ${nav.why}` };
    };
    const diag = await h.stickWithinDelay(MAIN, [{ x: 0.6, y: 0.8, frames: 2 }, { frames: 3 }], [[0, 1]], toSession);
    verdict("diagonal", diag, ({ run, before, after: s1 }) => {
      t.expect(run.moves.length === 1, `a diagonal stick to fire one direction (saw ${run.moves.length} focus changes)`);
      t.expect(s1.focus === (before.focus + 1) % before.count, `the stronger down axis to win (focus ${before.focus} -> ${s1.focus})`);
      t.expect(sameRows(s1.rows, before.rows), "no row value to change on a diagonal");
    });
    const back = await h.navigateTo(MAIN, isStart, "shortest");
    const s2 = await h.menu(MAIN);
    t.expect(back.ok && isStart(s2.focusedLabel), `d-pad back to the start row (${back.why}, focus "${s2.focusedLabel}")`);
  } finally {
    await h.engine("start");
  }
}
async function stepStartRace(t, h) {
  const s0 = await h.menu(MAIN);
  if (!t.expect(s0.open && isStart(s0.focusedLabel), `main menu open with the start row focused (focus "${s0.focusedLabel}")`)) return;
  if (!t.expect(await h.call("spyInput"), "spy installed on ctx.input.update")) return;
  try {
    await h.press(BTN.A);
    const running = await h.waitRunning(MAIN);
    const g0 = await h.game();
    if (!t.expect(running, `A to close the main menu and unpause (paused ${g0.paused})`)) return;
    await h.frames(HOLD_FRAMES);
    const held = await h.call("spyState");
    const m = await h.menu(MAIN);
    const p = await h.menu(PAUSE);
    t.expect(!m.open, "main menu to stay closed");
    t.expect(!p.open && held.pauseOpen === 0, "pause menu to stay closed while A is held");
    t.expect(held.enabledCalls > 0, `input updates to run after the start (got ${held.enabledCalls})`);
    t.expect(held.drs === 0, `no DRS while the A that started the session is held (saw ${held.drs})`);
    await h.release(BTN.A);
    await h.sleep(1000);
    await h.frames(3);
    const g1 = await h.game();
    const after = await h.call("spyState");
    t.expect(g1.paused === false, `game still unpaused after 1 s (got ${g1.paused})`);
    t.expect(g1.inputEnabled === true, `ctx.input.enabled true (got ${g1.inputEnabled})`);
    t.expect(g1.elapsed > g0.elapsed, "simulation time to advance");
    t.expect(after.drs === 0, `no DRS after A is released (saw ${after.drs})`);
    t.note(`simulated ${(g1.elapsed - g0.elapsed).toFixed(2)} s, ${after.enabledCalls} input updates`);
  } finally {
    await h.call("unspy");
  }
}
async function stepStartOpensPause(t, h, shared) {
  const g0 = await h.game();
  if (!t.expect(g0.paused === false, `game running before Start (paused ${g0.paused})`)) return;
  await h.press(BTN.START);
  const opened = await h.waitOpen(PAUSE);
  await h.frames(HOLD_FRAMES);
  const s = await h.menu(PAUSE);
  const g = await h.game();
  if (s.open) shared.pauseHint = s.hintRaw;
  t.expect(opened, "Start to open the pause menu");
  t.expect(s.open, `pause menu still open after ${HOLD_FRAMES} frames with Start held`);
  t.expect(g.paused === true, `ctx.paused true (got ${g.paused})`);
  await h.release(BTN.START);
  await h.frames(5);
  const s2 = await h.menu(PAUSE);
  t.expect(s2.open, "pause menu still open after Start is released");
  t.note(`rows: ${s.rows.map((r) => r.label).join(", ")}`);
}
async function stepPauseSettings(t, h, shared) {
  const s0 = await h.menu(PAUSE);
  if (!t.expect(s0.open, "pause menu open")) return;
  t.expect(s0.focus === 0, `pause menu to open on row 0 (got ${s0.focus})`);
  const nav = await h.navigateTo(PAUSE, (l) => l === "Settings", "down");
  if (!t.expect(nav.ok, `d-pad down to reach Settings (${nav.why})`)) return;
  await h.tap(BTN.A, PAUSE);
  const shown = await h.waitRow(PAUSE, "Back");
  const s1 = await h.menu(PAUSE);
  if (!t.expect(shown && s1.open, "A on Settings to show the settings screen with a Back row")) return;
  shared.settingsHint = s1.hintRaw;
  const valued = s1.rows.filter((r) => r.value !== null);
  const target = valued.find((r) => SAFE_SETTINGS.includes(r.label)) ?? valued[0];
  if (!t.expect(target, "a settings row with a value")) return;
  const nav2 = await h.navigateTo(PAUSE, (l) => l === target.label, "down");
  if (!t.expect(nav2.ok, `d-pad down to reach ${target.label} (${nav2.why})`)) return;
  const original = await h.rowValue(PAUSE, target.label);
  await h.tap(BTN.RIGHT, PAUSE);
  const changed = await h.waitFor(([s, l, v]) => {
    const now = globalThis.__padTest.rowValue(s, l);
    return now !== null && now !== v;
  }, [PAUSE, target.label, original], SHORT_MS);
  const after = await h.rowValue(PAUSE, target.label);
  t.expect(changed, `d-pad right to change ${target.label} (still ${after})`);
  await h.tap(BTN.LEFT, PAUSE);
  const restored = await h.waitFor(
    ([s, l, v]) => globalThis.__padTest.rowValue(s, l) === v,
    [PAUSE, target.label, original],
    SHORT_MS
  );
  const final = await h.rowValue(PAUSE, target.label);
  t.expect(restored, `d-pad left to restore ${target.label} to ${original} (got ${final})`);
  t.note(`${target.label}: ${original} -> ${after} -> ${final}`);
}
async function stepBackAndHeldB(t, h) {
  const s0 = await h.menu(PAUSE);
  if (!t.expect(s0.open, "pause menu open on the settings screen")) return;
  if (!t.expect(await h.call("spyInput"), "spy installed on ctx.input.update")) return;
  try {
    await h.tap(BTN.B, PAUSE);
    const back = await h.waitRow(PAUSE, "Resume");
    const s1 = await h.menu(PAUSE);
    if (!t.expect(back && s1.open, "B in settings to return to the pause screen (a Resume row) with the menu open")) return;
    await h.press(BTN.B);
    const closed = await h.waitRunning(PAUSE);
    await h.frames(HOLD_FRAMES);
    const held = await h.call("spyState");
    const g1 = await h.game();
    const s2 = await h.menu(PAUSE);
    t.expect(closed, "B on the pause screen to close the menu and unpause");
    t.expect(!s2.open, `pause menu still closed ${HOLD_FRAMES} frames later with B held`);
    t.expect(g1.paused === false, `ctx.paused false (got ${g1.paused})`);
    t.expect(held.enabledCalls > 0, `input updates to run after resume (got ${held.enabledCalls})`);
    t.expect(held.resets === 0, `no car reset while B is held (saw ${held.resets})`);
    await h.release(BTN.B);
    await h.frames(HOLD_FRAMES);
    const after = await h.call("spyState");
    const g2 = await h.game();
    const s3 = await h.menu(PAUSE);
    t.expect(after.resets === 0, `no car reset after B is released (saw ${after.resets})`);
    t.expect(after.enabledCalls > held.enabledCalls, "input updates to run after B is released");
    t.expect(!s3.open && g2.paused === false, "game still running after B is released");
    t.note(`${after.enabledCalls} input updates, ${after.resets} resets`);
  } finally {
    await h.call("unspy");
  }
}
async function stepKeyboardPauseAndStart(t, h) {
  const g0 = await h.game();
  if (!t.expect(g0.paused === false, `game running before Esc (paused ${g0.paused})`)) return;
  await h.key("Escape");
  const opened = await h.waitOpen(PAUSE);
  const s0 = await h.menu(PAUSE);
  if (!t.expect(opened && s0.open, "Esc to open the pause menu")) return;
  t.expect(s0.focus === 0, `pause menu to open on row 0 (got ${s0.focus})`);
  await h.key("ArrowDown");
  const s1 = await h.menu(PAUSE);
  t.expect(s1.focus === 1, `ArrowDown to move focus to row 1 (got ${s1.focus})`);
  await h.key("ArrowUp");
  const s2 = await h.menu(PAUSE);
  t.expect(s2.focus === 0, `ArrowUp to move focus back to row 0 (got ${s2.focus})`);
  await h.key("Escape");
  const resumed = await h.waitRunning(PAUSE);
  if (!t.expect(resumed, "Esc to close the pause menu")) return;
  await h.frames(3);
  const s3 = await h.menu(PAUSE);
  t.expect(!s3.open, "pause menu to stay closed after Esc resumes");
  await h.key("Escape");
  const reopened = await h.waitOpen(PAUSE);
  if (!t.expect(reopened, "Esc to open the pause menu again")) return;
  if (!t.expect(await h.call("spyInput"), "spy installed on ctx.input.update")) return;
  try {
    await h.press(BTN.START);
    const closed = await h.waitRunning(PAUSE);
    await h.frames(HOLD_FRAMES);
    const held = await h.call("spyState");
    const s4 = await h.menu(PAUSE);
    t.expect(closed, "Start to close a pause menu that the keyboard opened");
    t.expect(held.enabledCalls > 0, `input updates to run with Start held (got ${held.enabledCalls})`);
    t.expect(!s4.open && held.pauseOpen === 0, "pause menu to stay closed while Start is still held");
    await h.release(BTN.START);
    await h.frames(5);
    const after = await h.call("spyState");
    const s5 = await h.menu(PAUSE);
    const g5 = await h.game();
    t.expect(after.enabledCalls > held.enabledCalls, "input to see Start released");
    t.expect(!s5.open && after.pauseOpen === 0 && g5.paused === false, "pause menu to stay closed after Start is released");
  } finally {
    await h.call("unspy");
  }
}
async function stepQuitWithHeldA(t, h, shared) {
  const g0 = await h.game();
  if (!t.expect(g0.paused === false, `game running before Esc (paused ${g0.paused})`)) return;
  await h.key("Escape");
  const opened = await h.waitOpen(PAUSE);
  if (!t.expect(opened, "Esc to open the pause menu")) return;
  const nav = await h.navigateTo(PAUSE, (l) => l === "Quit to menu", "down");
  const s0 = await h.menu(PAUSE);
  if (!t.expect(nav.ok, `d-pad down to reach Quit to menu (${nav.why})`)) return;
  t.expect(s0.focus === s0.count - 1, `Quit to menu to be the last row (index ${s0.focus} of ${s0.count})`);
  await h.press(BTN.A);
  const shown = await h.waitOpen(MAIN, SHORT_MS);
  const first = await h.menu(MAIN);
  await h.frames(HOLD_FRAMES);
  const m1 = await h.menu(MAIN);
  const p1 = await h.menu(PAUSE);
  const g1 = await h.game();
  const baseline = shared.mainRows ?? first.rows;
  t.expect(shown, "A on Quit to menu to open the main menu");
  t.expect(m1.open, `main menu still open after ${HOLD_FRAMES} frames with A held`);
  t.expect(!p1.open, "pause menu closed");
  t.expect(g1.paused === true, `ctx.paused true (got ${g1.paused})`);
  t.expect(m1.focus === 0, `main menu focus still on row 0 (got ${m1.focus})`);
  t.expect(sameRows(m1.rows, baseline), `held A to leave the main menu rows untouched (row 0 is "${m1.rows[0]?.label}: ${m1.rows[0]?.value}")`);
  await h.release(BTN.A);
  await h.frames(5);
  const m2 = await h.menu(MAIN);
  t.expect(m2.open && m2.focus === 0 && sameRows(m2.rows, baseline), "main menu unchanged after A is released");
}
async function stepKeyboardMain(t, h, shared) {
  const s0 = await h.menu(MAIN);
  if (!t.expect(s0.open && s0.count > 1, "main menu open")) return;
  const next = (s0.focus + 1) % s0.count;
  await h.key("ArrowDown");
  const s1 = await h.menu(MAIN);
  t.expect(s1.focus === next, `ArrowDown to move focus ${s0.focus} -> ${next} (got ${s1.focus})`);
  await h.key("ArrowUp");
  const s2 = await h.menu(MAIN);
  t.expect(s2.focus === s0.focus, `ArrowUp to move focus back to ${s0.focus} (got ${s2.focus})`);
  const nav = await h.keyTo(MAIN, (l) => l === "Settings");
  if (!t.expect(nav.ok, `ArrowDown to reach Settings (${nav.why})`)) return;
  await h.key("Enter");
  const settings = await h.menu(MAIN);
  shared.mainSettingsHint = settings.hintRaw;
  t.expect(settings.rows.some((r) => r.label === "Back") && settings.rows.some((r) => r.value !== null), "Enter on Settings to show the settings screen");
  await h.key("Escape");
  const s3 = await h.menu(MAIN);
  t.expect(s3.rows.some((r) => isStart(r.label)) && s3.focus === 0, `Esc to return to the main screen on row 0 (focus ${s3.focus})`);
  const nav2 = await h.keyTo(MAIN, (l) => l === "Controls");
  if (!t.expect(nav2.ok, `ArrowDown to reach Controls (${nav2.why})`)) return;
  await h.key("Enter");
  const controls = await h.menu(MAIN);
  shared.controlsHint = controls.hintRaw;
  shared.padNote = controls.padNote;
  t.expect(controls.count === 1 && controls.rows[0]?.label === "Back", "Enter on Controls to show the controls page");
  await h.key("Escape");
  const s4 = await h.menu(MAIN);
  t.expect(s4.open && s4.rows.some((r) => isStart(r.label)) && s4.focus === 0, "Esc to return from the controls page");
  t.expect(sameRows(s4.rows, shared.mainRows ?? s4.rows), "main menu values unchanged by the keyboard tour");
}
async function stepHints(t, h, shared) {
  const main = shared.mainHint ?? "";
  t.expect(main !== "" && main !== HINTS.keysMain, `main menu hint to be pad-aware (got "${main}")`);
  t.expect(separatorStyle(main), `main menu pad hint to use the two-space middle-dot separator (got "${main}")`);
  t.expect(shared.pauseHint === HINTS.padPause, `pause hint "${HINTS.padPause}" (got "${shared.pauseHint}")`);
  t.expect(shared.settingsHint === HINTS.padSettings, `pause settings hint "${HINTS.padSettings}" (got "${shared.settingsHint}")`);
  t.expect(shared.mainSettingsHint === HINTS.padSettings, `main settings hint "${HINTS.padSettings}" (got "${shared.mainSettingsHint}")`);
  const controls = shared.controlsHint ?? "";
  t.expect(controls !== "" && controls !== HINTS.keysControls && /\bB\b/.test(controls), `controls hint to name B (got "${controls}")`);
  const note = shared.padNote ?? "";
  t.expect(/d-pad/i.test(note) && /\bA selects\b/.test(note) && /\bB goes back\b/.test(note) && /\bStart\b/.test(note), `controls page note to cover menu navigation (got "${note}")`);
  const s0 = await h.menu(MAIN);
  if (!t.expect(s0.open, "main menu open")) return;
  await h.connect(false);
  const keys = await h.waitHint(MAIN, HINTS.keysMain);
  const s1 = await h.menu(MAIN);
  t.expect(keys, `main hint to switch to "${HINTS.keysMain}" when the pad goes away (got "${s1.hintRaw}")`);
  await h.press(BTN.A);
  await h.connect(true);
  const pad = await h.waitHint(MAIN, main);
  await h.frames(5);
  const s2 = await h.menu(MAIN);
  t.expect(pad, `main hint to switch back when the pad returns (got "${s2.hintRaw}")`);
  t.expect(s2.focus === s0.focus && sameRows(s2.rows, s0.rows), "the A press that brings the pad back to do nothing");
  await h.release(BTN.A);
  await h.frames(3);
  const s3 = await h.menu(MAIN);
  t.expect(s3.open && s3.focus === s0.focus && sameRows(s3.rows, s0.rows), "main menu unchanged after A is released");
  t.note(`main "${main}", pause "${shared.pauseHint}", settings "${shared.settingsHint}", controls "${controls}"`);
}
async function stepHeldStartOnMainMenu(t, h) {
  const s0 = await h.menu(MAIN);
  if (!t.expect(s0.open, "main menu open")) return;
  const nav = await h.navigateTo(MAIN, isStart, "shortest");
  if (!t.expect(nav.ok, `d-pad to the start row (${nav.why})`)) return;
  if (!t.expect(await h.call("spyInput"), "spy installed on ctx.input.update")) return;
  try {
    await h.press(BTN.START);
    const running = await h.waitRunning(MAIN);
    if (!t.expect(running, "Start on the start row to begin the session")) return;
    await h.frames(HOLD_FRAMES);
    const held = await h.call("spyState");
    const p = await h.menu(PAUSE);
    const g = await h.game();
    t.expect(held.enabledCalls > 0, `input updates to run with Start held (got ${held.enabledCalls})`);
    t.expect(!p.open && held.pauseOpen === 0 && g.paused === false, "the Start that began the session not to open the pause menu");
    await h.release(BTN.START);
    await h.frames(5);
    const after = await h.call("spyState");
    const p2 = await h.menu(PAUSE);
    t.expect(!p2.open && after.pauseOpen === 0, "pause menu still closed after Start is released");
  } finally {
    await h.call("unspy");
  }
}
async function stepKeyboardHints(t, h) {
  const g0 = await h.game();
  if (!t.expect(g0.paused === false, `game running (paused ${g0.paused})`)) return;
  await h.connect(false);
  await h.key("Escape");
  const opened = await h.waitOpen(PAUSE);
  const s0 = await h.menu(PAUSE);
  if (!t.expect(opened && s0.open, "Esc to open the pause menu with no pad")) return;
  t.expect(s0.hintRaw === HINTS.keysPause, `pause hint "${HINTS.keysPause}" with no pad (got "${s0.hintRaw}")`);
  await h.connect(true);
  const pad = await h.waitHint(PAUSE, HINTS.padPause);
  t.expect(pad, "pause hint to switch to the pad text when a pad connects");
  await h.connect(false);
  const keys = await h.waitHint(PAUSE, HINTS.keysPause);
  t.expect(keys, "pause hint to switch back when the pad goes away");
  const nav = await h.keyTo(PAUSE, (l) => l === "Settings");
  if (!t.expect(nav.ok, `ArrowDown to reach Settings (${nav.why})`)) return;
  await h.key("Enter");
  const s1 = await h.menu(PAUSE);
  t.expect(s1.rows.some((r) => r.label === "Back"), "Enter on Settings to show the settings screen");
  t.expect(s1.hintRaw === HINTS.keysSettings, `settings hint "${HINTS.keysSettings}" with no pad (got "${s1.hintRaw}")`);
  await h.key("Escape");
  const s2 = await h.menu(PAUSE);
  t.expect(s2.open && s2.rows.some((r) => r.label === "Resume") && s2.focus === 0, "Esc in settings to return to the pause screen");
  await h.key("Escape");
  const resumed = await h.waitRunning(PAUSE);
  t.expect(resumed, "Esc on the pause screen to resume");
  await h.connect(true);
  await h.frames(3);
  const s3 = await h.menu(PAUSE);
  const g3 = await h.game();
  t.expect(!s3.open && g3.paused === false, "game still running after the pad returns");
}
const STEPS = [
  ["main menu d-pad navigation", stepMainMenuDpad],
  ["left stick threshold, hysteresis, repeat timing and diagonal", stepStick],
  ["A starts the session and held A is not DRS", stepStartRace],
  ["held Start opens and keeps the pause menu", stepStartOpensPause],
  ["pause settings via d-pad", stepPauseSettings],
  ["B backs out and held B does not reset the car", stepBackAndHeldB],
  ["keyboard drives the pause menu and held Start resumes once", stepKeyboardPauseAndStart],
  ["held A on Quit to menu does not leak into the main menu", stepQuitWithHeldA],
  ["keyboard still drives the main menu", stepKeyboardMain],
  ["pad-aware hints and pad reconnect", stepHints],
  ["held Start on the start row does not open the pause menu", stepHeldStartOnMainMenu],
  ["keyboard hints with no pad", stepKeyboardHints]
];
async function runStep(number, name, fn, h, shared) {
  const t = checker();
  const started = Date.now();
  try {
    await fn(t, h, shared);
  } catch (err) {
    t.fail(`threw: ${String(err?.message ?? err).split("\n")[0]}`);
  }
  try {
    if (await h.releaseAll()) await h.frames(3);
  } catch {
  }
  const { ok, detail } = t.result();
  const secs = ((Date.now() - started) / 1e3).toFixed(1);
  console.log(`${ok ? "PASS" : "FAIL"}  ${number}. ${name} [${secs}s]: ${detail}`);
  return ok;
}
function choosePort() {
  const wanted = Number(process.env.MENU_PAD_PORT) || 0;
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (err) => {
      reject(err?.code === "EADDRINUSE" ? new Error(`port ${wanted} is already in use`) : err);
    });
    probe.listen(wanted, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}
function waitForPreview(server, port, timeoutMs = 60000) {
  const marker = `http://127.0.0.1:${port}/`;
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    server.stdout?.on("data", (d) => {
      if (settled) return;
      out = (out + String(d)).slice(-4096);
      if (out.includes(marker)) finish(true);
    });
    server.once("exit", () => finish(false));
    if (server.exitCode !== null || server.signalCode !== null) finish(false);
  });
}
async function main() {
  if (!existsSync(path.join(ROOT, "dist", "index.html"))) {
    console.error("menu-gamepad: dist/index.html is missing, run the build first");
    console.log(`menu-gamepad: 0/${STEPS.length} passed`);
    process.exit(1);
  }
  const port = await choosePort();
  const win = process.platform === "win32";
  const server = spawn(
    win ? "npx.cmd" : "npx",
    ["vite", "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], shell: win, detached: !win }
  );
  let serverStopped = false;
  const stopServer = () => {
    if (serverStopped) return;
    serverStopped = true;
    try {
      if (win) spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-server.pid, "SIGTERM");
    } catch {
    }
  };
  process.on("exit", stopServer);
  process.once("SIGINT", () => {
    stopServer();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    stopServer();
    process.exit(143);
  });
  server.on("error", (err) => process.stderr.write(`[preview] ${err.message}\n`));
  server.stderr?.on("data", (d) => process.stderr.write(`[preview] ${d}`));
  const base = `http://127.0.0.1:${port}/`;
  const results = [];
  const pageErrors = [];
  let browser = null;
  try {
    if (!await waitForPreview(server, port)) throw new Error(`preview server did not come up on port ${port}`);
    const res = await fetch(base);
    if (!res.ok) throw new Error(`preview server answered ${res.status} on port ${port}`);
    browser = await chromium.launch({
      executablePath: process.env.APEX_CHROMIUM || void 0,
      args: [
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--ignore-gpu-blocklist",
        "--enable-gpu-rasterization",
        "--disable-dev-shm-usage",
        "--no-sandbox"
      ]
    });
    const page = await browser.newPage({ viewport: { width: 960, height: 540 }, deviceScaleFactor: 1 });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.addInitScript(installFakePad);
    const booted = Date.now();
    await page.goto(`${base}?quality=low`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(
      () => globalThis.__APEX_READY__ === true || globalThis.__APEX_ERROR__,
      null,
      { timeout: BOOT_MS }
    );
    const bootError = await page.evaluate(() => globalThis.__APEX_ERROR__ ?? null);
    if (bootError) throw new Error(`boot failed: ${bootError}`);
    console.log(`booted in ${((Date.now() - booted) / 1e3).toFixed(1)}s on port ${port}`);
    const h = helpers(page);
    const shared = {};
    for (const [i, [name, fn]] of STEPS.entries()) {
      results.push(await runStep(i + 1, name, fn, h, shared));
    }
  } catch (err) {
    console.log(`FAIL  setup: ${String(err?.message ?? err).split("\n")[0]}`);
  } finally {
    if (browser) await browser.close().catch(() => {
    });
    stopServer();
  }
  for (let i = results.length; i < STEPS.length; i++) {
    console.log(`FAIL  ${i + 1}. ${STEPS[i][0]}: not run`);
  }
  if (pageErrors.length) {
    console.log(`page errors: ${pageErrors.length}`);
    for (const e of pageErrors.slice(0, 5)) console.log(`   ! ${e.split("\n")[0]}`);
  }
  const passed = results.filter(Boolean).length;
  console.log(`menu-gamepad: ${passed}/${STEPS.length} passed`);
  process.exit(passed === STEPS.length ? 0 : 1);
}
main().catch((err) => {
  console.error(err);
  console.log(`menu-gamepad: 0/${STEPS.length} passed`);
  process.exit(1);
});
