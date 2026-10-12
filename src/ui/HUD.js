import "./hud.css";
import { clamp, clamp01, formatLapTime } from "../core/MathUtils.js";
import { TimingTower } from "./TimingTower.js";
import { Minimap } from "./Minimap.js";
import { Menu } from "./Menu.js";
const CLUSTER_W = 760;
const CLUSTER_H = 176;
const PANEL_X0 = 16;
const PANEL_X1 = 744;
const BAR_Y = 12;
const BAR_H = 16;
const BAR_SEGMENTS = 48;
const BAR_GAP = 2;
const BAR_CELL = (PANEL_X1 - PANEL_X0 - (BAR_SEGMENTS - 1) * BAR_GAP) / BAR_SEGMENTS;
const RULE_Y = 36;
const CELL_TOP = 44;
const CELL_BOTTOM = 164;
const DIV_A = 252;
const DIV_B = 508;
const SPEED_CX = (PANEL_X0 + DIV_A) * 0.5;
const SPEED_BASELINE = 120;
const UNIT_BASELINE = 149;
const GEAR_CX = (DIV_A + DIV_B) * 0.5;
const GEAR_BASELINE = 146;
const AUX_LABEL_X = 520;
const AUX_RPM_BASELINE = 70;
const AUX_BAR_X = 582;
const AUX_BAR_W = PANEL_X1 - AUX_BAR_X;
const AUX_BAR_H = 14;
const THR_BAR_Y = 96;
const BRK_BAR_Y = 136;
const AUX_LABEL_DROP = 15;
const SHIFT_FLASH = 0.972;
const TYRE_W = 260;
const TYRE_H = 200;
const TYRE_CELL_W = 130;
const TYRE_CELL_H = 100;
const RPM_LIMIT = 15e3;
const FUEL_START = 104;
const DELTA_SPAN = 2;
const DOM_HZ = 15;
const BANNER_SECONDS = 2.8;
const PERF_REFRESH_FRAMES = 15;
const FONT_DISPLAY = "Barlow, system-ui, sans-serif";
const FONT_LABEL = '"Barlow Condensed", Barlow, system-ui, sans-serif';
const FONT_NUMERIC = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
const FONT_SPEED = `700 76px ${FONT_NUMERIC}`;
const FONT_GEAR = `800 118px ${FONT_DISPLAY}`;
const FONT_RPM = `700 28px ${FONT_NUMERIC}`;
const FONT_CAPTION = `600 23px ${FONT_LABEL}`;
const GEAR_TEXT = ["R", "N", "1", "2", "3", "4", "5", "6", "7", "8"];
const ERS_MODE_TEXT = ["Off", "Balanced", "Attack", "Overtake"];
const RPM_TEXT = Array.from({ length: 181 }, (_, i) => String(i * 100));
const COMPOUND_STYLE = {
  soft: { ring: "#e8112d", letter: "S", name: "Soft" },
  medium: { ring: "#f5c400", letter: "M", name: "Medium" },
  hard: { ring: "#eceff3", letter: "H", name: "Hard" },
  intermediate: { ring: "#21d16b", letter: "I", name: "Intermediate" },
  wet: { ring: "#1f6fe0", letter: "W", name: "Wet" }
};
const LAP_COLOUR_CLASS = {
  purple: "apex-value t-purple",
  green: "apex-value t-green",
  yellow: "apex-value t-yellow",
  white: "apex-value t-white"
};
const INT_TEXT = Array.from({ length: 1024 }, (_, i) => String(i));
function istr(n) {
  const i = n | 0;
  return i >= 0 && i < 1024 ? INT_TEXT[i] : String(i);
}
function buildRamp(stops, count) {
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    let k = 0;
    while (k < stops.length - 2 && t > stops[k + 1][0]) k++;
    const [t0, c0] = stops[k];
    const [t1, c1] = stops[k + 1];
    const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
    const r = Math.round((c0 >> 16 & 255) + ((c1 >> 16 & 255) - (c0 >> 16 & 255)) * f);
    const g = Math.round((c0 >> 8 & 255) + ((c1 >> 8 & 255) - (c0 >> 8 & 255)) * f);
    const b = Math.round((c0 & 255) + ((c1 & 255) - (c0 & 255)) * f);
    out[i] = `rgb(${r},${g},${b})`;
  }
  return out;
}
const RPM_RAMP = buildRamp([
  [0, 14673647],
  [0.52, 16777215],
  [0.7, 16761402],
  [0.86, 16738848],
  [1, 16720664]
], 128);
const TEMP_RAMP = buildRamp([
  [0, 1920728],
  [0.22, 3120608],
  [0.38, 2081898],
  [0.5, 2416766],
  [0.64, 9427002],
  [0.8, 16756768],
  [1, 16720664]
], 96);
const ACCENT = "#e10600";
const THROTTLE_COLOUR = "#21d16b";
const BRAKE_COLOUR = "#ff3b30";
const INK = "#f3f5f8";
const INK_DIM = "rgba(243, 245, 248, 0.58)";
const HAIRLINE = "rgba(255, 255, 255, 0.2)";
const TROUGH = "rgba(255, 255, 255, 0.13)";
function compoundOf(name) {
  return COMPOUND_STYLE[name] ?? COMPOUND_STYLE.medium;
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== void 0) node.textContent = text;
  return node;
}
function statRow(label, unit) {
  const row = el("div", "row");
  row.appendChild(el("span", "apex-label", label));
  const stat = el("span", "stat");
  const value = el("span", "apex-value", "—");
  stat.append(value, el("span", "unit", unit));
  row.appendChild(stat);
  return { row, stat, value };
}
export class HUD {
  static systemName = "hud";
  constructor() {
    this.root = null;
    this._domTimer = 0;
    this._bannerTimer = 0;
    this._bannerOn = false;
    this._playerIndex = 0;
    this._visible = true;
    this._units = "metric";
    this._chromeDirty = true;
    this._perfPanel = null;
    this._perfVisible = false;
    this._perfFpsEl = null;
    this._perfMsEl = null;
    this._perfCallsEl = null;
    this._perfC = { fps: -1, msTenths: -1, calls: -1 };
    this._c = {
      pos: -1,
      lap: -1,
      total: -1,
      clock: -1,
      flag: "",
      last: -1,
      best: -1,
      session: -1,
      lastColour: "",
      ersPct: -1,
      ersMode: -1,
      harvest: -1,
      deployPct: -1,
      fuel: -1,
      bias: -1,
      drs: -1,
      delta: 9e9,
      strikes: -1,
      compound: "",
      wear: -1,
      brakeTemp: -1
    };
    this._unsub = [];
  }
  async init(ctx) {
    this.ctx = ctx;
    this._playerIndex = ctx.cars?.player?.index ?? 0;
    this.root = el("div", "apex-root apex-hud");
    this.root.id = "apex-hud";
    ctx.ui.appendChild(this.root);
    this.tower = new TimingTower(ctx, this.root);
    this._buildCorner();
    this._buildBottom();
    this._buildBanner();
    this.minimap = new Minimap(ctx, this._corner);
    this.minimap.build(ctx);
    this.menu = new Menu(ctx, ctx.ui);
    this._buildPerf(ctx);
    this._unsub.push(ctx.events.on("debug:toggle", () => {
      this._setPerfVisible(!this._perfVisible);
    }));
    this._units = ctx.settings?.get("units") ?? "metric";
    this.setVisible(ctx.settings?.get("showHud") !== false);
    this._unsub.push(ctx.events.on("hud:toggle", () => {
      const next = !this._visible;
      ctx.settings?.set("showHud", next);
      this.setVisible(next);
    }));
    this._unsub.push(ctx.events.on("race:lap", (p) => this._onLap(p)));
    this._unsub.push(ctx.events.on("race:sector", (p) => this._onSector(p)));
    this._unsub.push(ctx.events.on("race:limits", (p) => this._onLimits(p)));
    this._unsub.push(ctx.events.on("race:penalty", (p) => this._onPenalty(p)));
    this._unsub.push(ctx.events.on("race:start", () => this._banner("Lights out", "", "tone-good")));
    this._unsub.push(ctx.events.on("race:finish", () => this._banner("Chequered flag", "", "")));
    this._settingsOff = ctx.settings?.onChange?.((key, value) => {
      if (key === "units") {
        this._units = value;
        this._chromeDirty = true;
      }
      if (key === "showHud") this.setVisible(value !== false);
    });
    document.fonts?.ready?.then(() => {
      this._chromeDirty = true;
    }).catch(() => {
    });
    this.resize();
  }
  _buildCorner() {
    const corner = el("div", "hud-corner-tr");
    this._corner = corner;
    const session = el("div", "hud-session apex-panel");
    this._sessionPanel = session;
    session.appendChild(el("i", "flagbar"));
    const posCell = el("div", "hud-cell accent");
    posCell.appendChild(el("span", "apex-label", "Pos"));
    this._pos = el("span", "apex-value big", "P—");
    posCell.appendChild(this._pos);
    const lapCell = el("div", "hud-cell");
    lapCell.appendChild(el("span", "apex-label", "Lap"));
    this._lap = el("span", "apex-value big", "—");
    lapCell.appendChild(this._lap);
    const timeCell = el("div", "hud-cell");
    timeCell.appendChild(el("span", "apex-label", "Session"));
    this._clock = el("span", "apex-value", "0:00");
    timeCell.appendChild(this._clock);
    session.append(posCell, lapCell, timeCell);
    const times = el("div", "hud-times apex-panel");
    this._lastLap = el("span", "apex-value t-white", "--:--.---");
    this._bestLap = el("span", "apex-value t-white", "--:--.---");
    this._sessionBest = el("span", "apex-value t-purple", "--:--.---");
    times.append(
      el("span", "apex-label", "Last"),
      this._lastLap,
      el("span", "apex-label", "Best"),
      this._bestLap,
      el("span", "apex-label", "Fastest"),
      this._sessionBest
    );
    corner.append(session, times);
    this.root.appendChild(corner);
  }
  _buildBottom() {
    const bottom = el("div", "hud-bottom");
    const left = el("div", "hud-side");
    const ersBlock = el("div", "hud-block apex-panel");
    const ersHead = el("div", "ers-head");
    ersHead.appendChild(el("span", "apex-label", "ERS"));
    this._ersMode = el("span", "ers-mode m-1", "Balanced");
    ersHead.appendChild(this._ersMode);
    const ersMeter = el("div", "meter");
    this._ersFill = el("div", "fill");
    this._ersDeploy = el("div", "deploy");
    ersMeter.append(this._ersFill, this._ersDeploy, el("div", "ticks"));
    const store = statRow("Store", "%");
    this._ersPct = store.value;
    this._harvest = el("i", "harvest-dot");
    store.stat.appendChild(this._harvest);
    ersBlock.append(ersHead, ersMeter, store.row);
    const carBlock = el("div", "hud-block apex-panel");
    const fuel = statRow("Fuel", "kg");
    this._fuel = fuel.value;
    const fuelMeter = el("div", "meter");
    this._fuelFill = el("div", "fill fuel");
    fuelMeter.appendChild(this._fuelFill);
    const bias = statRow("Bias front", "%");
    this._bias = bias.value;
    carBlock.append(fuel.row, fuelMeter, bias.row);
    left.append(ersBlock, carBlock);
    const centre = el("div", "hud-centre");
    const strip = el("div", "delta-strip apex-panel");
    strip.appendChild(el("span", "apex-label", "Delta"));
    const deltaBar = el("div", "delta-bar");
    this._deltaFill = el("div", "fill");
    deltaBar.append(this._deltaFill, el("div", "centre"));
    this._deltaValue = el("span", "delta-value", "--.---");
    const strikes = el("div", "strikes");
    this._pips = [];
    for (let i = 0; i < 3; i++) {
      const pip = el("i", "pip");
      strikes.appendChild(pip);
      this._pips.push(pip);
    }
    strip.append(deltaBar, this._deltaValue, strikes);
    const cluster = el("div", "cluster apex-panel");
    this.clusterCanvas = document.createElement("canvas");
    this.clusterCanvas.width = CLUSTER_W;
    this.clusterCanvas.height = CLUSTER_H;
    this._cg = this.clusterCanvas.getContext("2d");
    this._chrome = document.createElement("canvas");
    this._chromeG = this._chrome.getContext("2d");
    cluster.appendChild(this.clusterCanvas);
    centre.append(strip, cluster);
    const right = el("div", "hud-side right");
    this._drs = el("div", "drs-box apex-panel", "DRS");
    const tyreBlock = el("div", "tyre-block apex-panel");
    this.tyreCanvas = document.createElement("canvas");
    this.tyreCanvas.width = TYRE_W;
    this.tyreCanvas.height = TYRE_H;
    this._tg = this.tyreCanvas.getContext("2d");
    const meta = el("div", "tyre-meta");
    const comp = el("div", "compound");
    this._compoundDisc = el("span", "disc", "M");
    this._compoundName = el("span", "cname", "Medium");
    comp.append(this._compoundDisc, this._compoundName);
    const wear = statRow("Wear", "%");
    this._wear = wear.value;
    const brakes = statRow("Brakes", "°C");
    this._brakeTemp = brakes.value;
    meta.append(comp, wear.row, brakes.row);
    tyreBlock.append(this.tyreCanvas, meta);
    right.append(this._drs, tyreBlock);
    bottom.append(left, centre, right);
    this.root.appendChild(bottom);
  }
  _buildPerf(ctx) {
    const panel = el("div");
    panel.id = "apex-perf";
    const s = panel.style;
    s.position = "fixed";
    s.top = "10px";
    s.left = "10px";
    s.zIndex = "60";
    s.padding = "5px 9px";
    s.background = "rgba(8, 10, 14, 0.72)";
    s.border = "1px solid rgba(255, 255, 255, 0.14)";
    s.borderRadius = "5px";
    s.font = `600 12px ${FONT_NUMERIC}`;
    s.color = "#e8f0ff";
    s.letterSpacing = "0.4px";
    s.whiteSpace = "pre";
    s.pointerEvents = "none";
    s.display = "none";
    this._perfFpsEl = el("span", "", "--");
    this._perfMsEl = el("span", "", "--.-");
    this._perfCallsEl = el("span", "", "--");
    panel.append(
      this._perfFpsEl,
      document.createTextNode(" fps  "),
      this._perfMsEl,
      document.createTextNode(" ms  "),
      this._perfCallsEl,
      document.createTextNode(" draws")
    );
    (ctx.ui ?? document.body).appendChild(panel);
    this._perfPanel = panel;
  }
  _setPerfVisible(on) {
    this._perfVisible = on;
    if (this._perfPanel) this._perfPanel.style.display = on ? "block" : "none";
  }
  _refreshPerf(ctx) {
    if (!this._perfVisible || !this._perfPanel) return;
    if (ctx.time.frame % PERF_REFRESH_FRAMES !== 0) return;
    const fps = ctx.time.fps;
    const fpsInt = Math.round(fps);
    const msTenths = fps > 0.5 ? Math.round(1e4 / fps) : 0;
    const calls = ctx.renderer?.info?.render?.calls ?? 0;
    const c = this._perfC;
    if (fpsInt !== c.fps) {
      c.fps = fpsInt;
      this._perfFpsEl.textContent = istr(fpsInt);
    }
    if (msTenths !== c.msTenths) {
      c.msTenths = msTenths;
      this._perfMsEl.textContent = (msTenths / 10).toFixed(1);
    }
    if (calls !== c.calls) {
      c.calls = calls;
      this._perfCallsEl.textContent = istr(calls);
    }
  }
  _buildBanner() {
    this._bannerEl = el("div", "hud-banner apex-panel");
    this._bannerEdge = el("i", "edge");
    const body = el("div", "body");
    this._bannerHead = el("div", "headline", "");
    this._bannerDetail = el("div", "detail", "");
    body.append(this._bannerHead, this._bannerDetail);
    this._bannerEl.append(this._bannerEdge, body);
    this.root.appendChild(this._bannerEl);
  }
  resize() {
    this._fitCanvas(this.clusterCanvas, this._cg, CLUSTER_W, CLUSTER_H);
    this._fitCanvas(this.tyreCanvas, this._tg, TYRE_W, TYRE_H);
    this._chrome.width = this.clusterCanvas.width;
    this._chrome.height = this.clusterCanvas.height;
    this._chromeDirty = true;
    this.minimap?.resize();
  }
  _fitCanvas(canvas, g, logicalW, logicalH) {
    const dpr = Math.min(globalThis.devicePixelRatio ?? 1, 2);
    const rect = canvas.getBoundingClientRect();
    const cssW = rect.width || canvas.parentElement?.clientWidth || logicalW * 0.5;
    const cssH = rect.height || cssW * logicalH / logicalW;
    const w = Math.max(64, Math.round(cssW * dpr));
    const h = Math.max(24, Math.round(cssH * dpr));
    canvas.width = w;
    canvas.height = h;
    g.setTransform(w / logicalW, 0, 0, h / logicalH, 0, 0);
  }
  setVisible(visible) {
    this._visible = visible;
    this.root?.classList.toggle("is-hidden", !visible);
    this.tower?.setVisible(visible);
    this.minimap?.setVisible(visible);
  }
  update(dt, ctx) {
    this.tower?.update(dt, ctx);
    if (this._bannerTimer > 0) {
      this._bannerTimer -= dt;
      if (this._bannerTimer <= 0 && this._bannerOn) {
        this._bannerOn = false;
        this._bannerEl.classList.remove("on");
      }
    }
    this._domTimer += dt;
    if (this._domTimer < 1 / DOM_HZ) return;
    this._domTimer = 0;
    this._refreshDom(ctx);
  }
  _playerEntry(ctx) {
    const standings = ctx.race?.standings;
    if (!standings) return null;
    for (let i = 0; i < standings.length; i++) {
      if (standings[i].index === this._playerIndex) return standings[i];
    }
    return null;
  }
  _refreshDom(ctx) {
    const state = ctx.vehicle?.state;
    if (!state) return;
    const c = this._c;
    const entry = this._playerEntry(ctx);
    const session = ctx.race?.session;
    if (entry && entry.position !== c.pos) {
      c.pos = entry.position;
      this._pos.textContent = `P${istr(entry.position)}`;
    }
    if (session) {
      const lap = session.lap | 0;
      const total = session.totalLaps | 0;
      if (lap !== c.lap || total !== c.total) {
        c.lap = lap;
        c.total = total;
        this._lap.textContent = total > 0 ? `${istr(lap)}/${istr(total)}` : istr(lap);
      }
      const seconds = Math.floor(session.timeElapsed);
      if (seconds !== c.clock) {
        c.clock = seconds;
        const m = Math.floor(seconds / 60);
        const s = seconds - m * 60;
        this._clock.textContent = `${istr(m)}:${s < 10 ? "0" : ""}${istr(s)}`;
      }
      const flag = session.flag ?? "green";
      if (flag !== c.flag) {
        c.flag = flag;
        this._sessionPanel.className = `hud-session apex-panel flag-${flag}`;
      }
    }
    if (entry) {
      const last = Math.round(entry.lastLap * 1e3);
      if (last !== c.last) {
        c.last = last;
        this._lastLap.textContent = formatLapTime(entry.lastLap);
      }
      const lastColour = entry.lapColour ?? "white";
      if (lastColour !== c.lastColour) {
        c.lastColour = lastColour;
        this._lastLap.className = LAP_COLOUR_CLASS[lastColour] ?? LAP_COLOUR_CLASS.white;
      }
      const best = Number.isFinite(entry.bestLap) ? Math.round(entry.bestLap * 1e3) : -1;
      if (best !== c.best) {
        c.best = best;
        this._bestLap.textContent = formatLapTime(entry.bestLap);
      }
      const strikes = clamp(entry.strikes | 0, 0, 3);
      if (strikes !== c.strikes) {
        c.strikes = strikes;
        for (let i = 0; i < 3; i++) {
          const on = i < strikes;
          this._pips[i].className = on ? strikes >= 3 ? "pip hot" : "pip on" : "pip";
        }
      }
    }
    if (session) {
      const sb = Number.isFinite(session.bestLap) ? Math.round(session.bestLap * 1e3) : -1;
      if (sb !== c.session) {
        c.session = sb;
        this._sessionBest.textContent = formatLapTime(session.bestLap);
      }
    }
    const ers = state.ers;
    const ersPct = Math.round(clamp01(ers.charge) * 100);
    if (ersPct !== c.ersPct) {
      c.ersPct = ersPct;
      this._ersFill.style.width = `${ersPct}%`;
      this._ersPct.textContent = istr(ersPct);
    }
    const deployPct = Math.round(clamp01(ers.deploy) * 100);
    if (deployPct !== c.deployPct) {
      c.deployPct = deployPct;
      this._ersDeploy.style.width = `${deployPct}%`;
    }
    const mode = clamp(ers.mode | 0, 0, 3);
    if (mode !== c.ersMode) {
      c.ersMode = mode;
      this._ersMode.textContent = ERS_MODE_TEXT[mode];
      this._ersMode.className = `ers-mode m-${istr(mode)}`;
    }
    const harvesting = ers.harvestMGUK + ers.harvestMGUH > 2e3 ? 1 : 0;
    if (harvesting !== c.harvest) {
      c.harvest = harvesting;
      this._harvest.classList.toggle("on", !!harvesting);
    }
    const fuelKg = Math.round(state.fuel * 10) / 10;
    if (fuelKg !== c.fuel) {
      c.fuel = fuelKg;
      this._fuel.textContent = fuelKg.toFixed(1);
      const frac = clamp01(state.fuel / FUEL_START);
      this._fuelFill.style.width = `${Math.round(frac * 100)}%`;
      this._fuelFill.classList.toggle("low", frac < 0.12);
    }
    const bias = ctx.vehicle?.powertrain?.brakeBias ?? ctx.vehicle?.config?.brakes?.bias ?? 0.6;
    const biasTenths = Math.round(bias * 1e3);
    if (biasTenths !== c.bias) {
      c.bias = biasTenths;
      this._bias.textContent = (bias * 100).toFixed(1);
    }
    const drs = state.drs;
    const drsState = drs.open ? 2 : drs.available ? 1 : 0;
    if (drsState !== c.drs) {
      c.drs = drsState;
      this._drs.className = drsState === 2 ? "drs-box apex-panel open" : drsState === 1 ? "drs-box apex-panel available" : "drs-box apex-panel";
    }
    const delta = ctx.race?.playerDelta ?? NaN;
    const deltaKey = Number.isFinite(delta) ? Math.round(delta * 100) : 9e9;
    if (deltaKey !== c.delta) {
      c.delta = deltaKey;
      if (!Number.isFinite(delta)) {
        this._deltaValue.textContent = "--.---";
        this._deltaValue.className = "delta-value";
        this._deltaFill.style.width = "0%";
        this._deltaFill.style.left = "50%";
      } else {
        const ahead = delta < 0;
        this._deltaValue.textContent = `${ahead ? "-" : "+"}${Math.abs(delta).toFixed(3)}`;
        this._deltaValue.className = `delta-value ${ahead ? "ahead" : "behind"}`;
        const frac = clamp01(Math.abs(delta) / DELTA_SPAN) * 50;
        this._deltaFill.style.width = `${frac.toFixed(1)}%`;
        this._deltaFill.style.left = ahead ? `${(50 - frac).toFixed(1)}%` : "50%";
        this._deltaFill.style.background = ahead ? "var(--apex-good)" : "var(--apex-bad)";
      }
    }
    const compound = ctx.vehicle?.config?.tyres?.compound ?? "medium";
    if (compound !== c.compound) {
      c.compound = compound;
      const style = compoundOf(compound);
      this._compoundDisc.textContent = style.letter;
      this._compoundDisc.style.borderColor = style.ring;
      this._compoundName.textContent = style.name;
    }
    const wheels = state.wheels;
    let wearSum = 0;
    let brakeMax = 0;
    for (let i = 0; i < 4; i++) {
      wearSum += wheels[i].wear;
      if (state.brakeTemp[i] > brakeMax) brakeMax = state.brakeTemp[i];
    }
    const wearPct = Math.round(wearSum / 4 * 100);
    if (wearPct !== c.wear) {
      c.wear = wearPct;
      this._wear.textContent = istr(wearPct);
    }
    const brakeC = Math.round(brakeMax / 5) * 5;
    if (brakeC !== c.brakeTemp) {
      c.brakeTemp = brakeC;
      this._brakeTemp.textContent = istr(brakeC);
    }
  }
  lateUpdate(alpha, ctx) {
    this._refreshPerf(ctx);
    if (!this._visible) return;
    const state = ctx.vehicle?.state;
    if (!state) return;
    if (this._chromeDirty) this._buildChrome();
    this._drawCluster(state, ctx.time.elapsed);
    this._drawTyres(state, ctx);
    this.minimap?.draw(ctx);
  }
  _buildChrome() {
    const g = this._chromeG;
    if (!g || this._chrome.width === 0) return;
    g.setTransform(this._chrome.width / CLUSTER_W, 0, 0, this._chrome.height / CLUSTER_H, 0, 0);
    g.clearRect(0, 0, CLUSTER_W, CLUSTER_H);
    g.fillStyle = TROUGH;
    for (let i = 0; i < BAR_SEGMENTS; i++) {
      g.fillRect(PANEL_X0 + i * (BAR_CELL + BAR_GAP), BAR_Y, BAR_CELL, BAR_H);
    }
    for (let k = 0; k <= 15; k++) {
      const x = Math.round(PANEL_X0 + (PANEL_X1 - PANEL_X0) * (k / 15));
      const major = k % 5 === 0;
      g.fillStyle = major ? "rgba(255,255,255,0.32)" : "rgba(255,255,255,0.13)";
      g.fillRect(x - (k === 15 ? 1 : 0), BAR_Y + BAR_H + 3, 1, major ? 6 : 3);
    }
    g.fillStyle = HAIRLINE;
    g.fillRect(PANEL_X0, RULE_Y, PANEL_X1 - PANEL_X0, 1);
    g.fillRect(DIV_A, CELL_TOP + 4, 2, CELL_BOTTOM - CELL_TOP - 8);
    g.fillRect(DIV_B, CELL_TOP + 4, 2, CELL_BOTTOM - CELL_TOP - 8);
    g.fillStyle = TROUGH;
    g.fillRect(AUX_BAR_X, THR_BAR_Y, AUX_BAR_W, AUX_BAR_H);
    g.fillRect(AUX_BAR_X, BRK_BAR_Y, AUX_BAR_W, AUX_BAR_H);
    g.textBaseline = "alphabetic";
    g.font = FONT_CAPTION;
    g.fillStyle = INK_DIM;
    if ("letterSpacing" in g) g.letterSpacing = "2px";
    g.textAlign = "center";
    g.fillText(this._units === "imperial" ? "MPH" : "KM/H", SPEED_CX, UNIT_BASELINE);
    g.textAlign = "left";
    g.fillText("RPM", AUX_LABEL_X, AUX_RPM_BASELINE);
    g.fillText("THR", AUX_LABEL_X, THR_BAR_Y + AUX_LABEL_DROP);
    g.fillText("BRK", AUX_LABEL_X, BRK_BAR_Y + AUX_LABEL_DROP);
    if ("letterSpacing" in g) g.letterSpacing = "0px";
    this._chromeDirty = false;
  }
  _drawCluster(state, elapsed) {
    const g = this._cg;
    if (!g || this.clusterCanvas.width === 0) return;
    g.clearRect(0, 0, CLUSTER_W, CLUSTER_H);
    g.drawImage(this._chrome, 0, 0, CLUSTER_W, CLUSTER_H);
    const frac = clamp01(state.rpm / RPM_LIMIT);
    const strobe = (state.limiterActive || frac >= SHIFT_FLASH) && elapsed * 14 % 2 < 1;
    const lit = Math.round(frac * BAR_SEGMENTS);
    for (let i = 0; i < lit; i++) {
      g.fillStyle = strobe ? "#ffffff" : RPM_RAMP[(i + 0.5) / BAR_SEGMENTS * 127 | 0];
      g.fillRect(PANEL_X0 + i * (BAR_CELL + BAR_GAP), BAR_Y, BAR_CELL, BAR_H);
    }
    g.textBaseline = "alphabetic";
    const kph = state.speedKph;
    const shown = this._units === "imperial" ? kph * 0.621371 : kph;
    g.textAlign = "center";
    g.fillStyle = INK;
    g.font = FONT_SPEED;
    g.fillText(istr(Math.max(0, Math.round(shown))), SPEED_CX, SPEED_BASELINE);
    const gearIndex = clamp((state.gear | 0) + 1, 0, GEAR_TEXT.length - 1);
    g.font = FONT_GEAR;
    g.fillStyle = strobe || state.shiftTimer > 0 ? ACCENT : state.gear === 0 ? INK_DIM : INK;
    g.fillText(GEAR_TEXT[gearIndex], GEAR_CX, GEAR_BASELINE);
    g.textAlign = "right";
    g.font = FONT_RPM;
    g.fillStyle = INK;
    const rpmIndex = clamp(Math.round(state.rpm / 100), 0, RPM_TEXT.length - 1);
    g.fillText(RPM_TEXT[rpmIndex], PANEL_X1, AUX_RPM_BASELINE);
    g.fillStyle = THROTTLE_COLOUR;
    g.fillRect(AUX_BAR_X, THR_BAR_Y, AUX_BAR_W * clamp01(state.throttle), AUX_BAR_H);
    g.fillStyle = BRAKE_COLOUR;
    g.fillRect(AUX_BAR_X, BRK_BAR_Y, AUX_BAR_W * clamp01(state.brake), AUX_BAR_H);
  }
  _drawTyres(state, ctx) {
    const g = this._tg;
    if (!g) return;
    g.clearRect(0, 0, TYRE_W, TYRE_H);
    const comp = ctx.vehicle?.config?.tyres?.compoundData;
    const optimum = comp?.optimumTemp ?? 108;
    const cold = comp?.windowCold ?? 32;
    const hot = comp?.windowHot ?? 28;
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    for (let i = 0; i < 4; i++) {
      const wheel = state.wheels[i];
      const col = i & 1;
      const row = i >> 1;
      const x = col * TYRE_CELL_W;
      const y = row * TYRE_CELL_H;
      const temp = wheel.temperature.surface * 0.62 + wheel.temperature.core * 0.38;
      const rel = temp < optimum ? (temp - optimum) / cold : (temp - optimum) / hot;
      const t = clamp01((rel + 2) * 0.25);
      const fill = TEMP_RAMP[t * (TEMP_RAMP.length - 1) | 0];
      const bx = x + 34;
      const by = y + 8;
      const bw = 44;
      const bh = 66;
      g.fillStyle = "rgba(0,0,0,0.55)";
      roundRect(g, bx - 2, by - 2, bw + 4, bh + 4, 9);
      g.fill();
      g.fillStyle = fill;
      roundRect(g, bx, by, bw, bh, 8);
      g.fill();
      const surfRel = wheel.temperature.surface < optimum ? (wheel.temperature.surface - optimum) / cold : (wheel.temperature.surface - optimum) / hot;
      const st = clamp01((surfRel + 2) * 0.25);
      g.fillStyle = TEMP_RAMP[st * (TEMP_RAMP.length - 1) | 0];
      g.fillRect(bx + 3, by + 4, bw - 6, 7);
      g.fillRect(bx + 3, by + bh - 11, bw - 6, 7);
      if (wheel.lockup > 0.15 || wheel.spin > 0.15) {
        g.strokeStyle = wheel.lockup > wheel.spin ? "#ffffff" : "#ffb020";
        g.lineWidth = 2.5;
        roundRect(g, bx - 3, by - 3, bw + 6, bh + 6, 10);
        g.stroke();
      }
      g.fillStyle = "#0a0a0c";
      g.font = '700 19px "JetBrains Mono", monospace';
      g.fillText(istr(Math.round(temp)), bx + bw * 0.5, by + bh * 0.5 + 7);
      const wx = x + 88;
      g.fillStyle = "rgba(255,255,255,0.09)";
      g.fillRect(wx, by, 8, bh);
      const life = clamp01(1 - wheel.wear);
      g.fillStyle = life > 0.45 ? "#e6eaf0" : life > 0.2 ? "#ffb020" : "#ff3b30";
      g.fillRect(wx, by + bh * (1 - life), 8, bh * life);
    }
  }
  _banner(headline, detail, tone) {
    this._bannerHead.textContent = headline;
    this._bannerDetail.textContent = detail;
    this._bannerEl.className = `hud-banner apex-panel on ${tone}`;
    this._bannerOn = true;
    this._bannerTimer = BANNER_SECONDS;
  }
  _onLap(p) {
    if (p.index !== this._playerIndex) return;
    if (!p.valid) {
      this._banner("Lap deleted", "Track limits", "tone-warn");
      return;
    }
    const tone = p.sessionBest ? "tone-purple" : p.personalBest ? "tone-good" : "";
    const label = p.sessionBest ? "Fastest lap" : p.personalBest ? "Personal best" : `Lap ${p.lap}`;
    this._banner(label, formatLapTime(p.time), tone);
  }
  _onSector(p) {
    if (p.index !== this._playerIndex || !p.sessionBest) return;
    this._banner(`Sector ${p.sector + 1}`, formatLapTime(p.time), "tone-purple");
  }
  _onLimits(p) {
    if (p.index !== this._playerIndex) return;
    if (p.deleted) this._banner("Lap time deleted", "Third track-limits warning", "tone-warn");
    else this._banner("Track limits", `Warning ${p.strikes} of 3`, "tone-warn");
  }
  _onPenalty(p) {
    if (p.index !== this._playerIndex) return;
    this._banner("Penalty", `+${p.seconds.toFixed(0)}s · ${p.reason}`, "tone-warn");
  }
  dispose() {
    for (const off of this._unsub) off?.();
    this._unsub.length = 0;
    this._settingsOff?.();
    this.tower?.dispose();
    this.minimap?.dispose();
    this.menu?.dispose();
    if (this.clusterCanvas) {
      this.clusterCanvas.width = 0;
      this.clusterCanvas.height = 0;
    }
    if (this.tyreCanvas) {
      this.tyreCanvas.width = 0;
      this.tyreCanvas.height = 0;
    }
    if (this._chrome) {
      this._chrome.width = 0;
      this._chrome.height = 0;
    }
    this._perfPanel?.remove();
    this._perfPanel = null;
    this.root?.remove();
    this.root = null;
  }
}
function roundRect(g, x, y, w, h, r) {
  const radius = Math.min(r, w * 0.5, h * 0.5);
  g.beginPath();
  g.moveTo(x + radius, y);
  g.lineTo(x + w - radius, y);
  g.quadraticCurveTo(x + w, y, x + w, y + radius);
  g.lineTo(x + w, y + h - radius);
  g.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  g.lineTo(x + radius, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - radius);
  g.lineTo(x, y + radius);
  g.quadraticCurveTo(x, y, x + radius, y);
  g.closePath();
}
