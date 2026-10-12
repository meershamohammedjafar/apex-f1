import { clamp, deltaT } from "../core/MathUtils.js";
import { Rng } from "../core/Rng.js";
import {
  CarTiming,
  SessionBests,
  ProgressHistory,
  ADVANCE_NONE,
  ADVANCE_LAP,
  SECTOR_COUNT,
  COLOUR_WHITE,
  sectorLengthShares,
  splitLap,
  lapTimeFraction
} from "./Timing.js";
import { applyScenario as buildScenario, resolveCars, physicsOf } from "./Scenarios.js";
const SESSION_TYPES = {
  practice: { duration: 3600, laps: 0, lights: false, formation: false, name: "Practice" },
  qualifying: { duration: 1080, laps: 0, lights: false, formation: false, name: "Qualifying" },
  race: { duration: 0, laps: 44, lights: true, formation: false, name: "Race" }
};
const LIGHT_COUNT = 5;
const LIGHT_INTERVAL = 1;
const LIGHT_LEAD_IN = 2;
const HOLD_MIN = 0.2;
const HOLD_MAX = 3;
const GRID_SETTLE = 3;
const TRACK_LIMIT_MARGIN = 0.85;
const TRACK_LIMIT_MIN_SPEED = 12;
const TRACK_LIMIT_REARM = 0.15;
const JUMP_START_SPEED = 0.45;
const JUMP_START_DISTANCE = 0.35;
const JUMP_START_PENALTY = 5;
const BLUE_FLAG_SECONDS = 1.9;
const YELLOW_SECONDS = 8;
const INCIDENT_IMPULSE = 5200;
const STOPPED_SPEED = 7;
const STOPPED_SECONDS = 1.5;
const DRS_WINDOW = 1;
const DRS_ENABLE_LAP = 2;
const DRS_MAX_RAIN = 0.15;
const HISTORY_INTERVAL = 1 / 20;
const GAP_INTERVAL = 1 / 10;
const HISTORY_SPAN = 6;
const GAP_MIN_SPEED = 1;
const GAP_SPEED_WINDOW = 1.5;
const REFERENCE_LAP_SPEED = 66;
const SKILL_SPREAD = 16;
const QUALI_NOISE = 0.14;
const RACE_FUEL_PENALTY = 2.6;
const RACE_LAP_NOISE = 0.45;
const SPLIT_JITTER = 0.02;
const SPLIT_LAP_JITTER = 6e-3;
const PLAYER_GRID_SLOT = 3;
const PACE_LATERAL_ACCEL = 42;
const PACE_TOP_SPEED = 88;
const PACE_MIN_SPEED = 14;
const PACE_SAMPLES = 720;
const SHOT_LAP = 11;
const FUEL_FLOW_DUTY = 0.5745;
const FUEL_RESERVE = 1;
const FIELD_ROW_LOSS = 0.22;
const FIELD_LAP_SCATTER = 0.32;
const FIELD_MISTAKE_RATE = 0.05;
const FIELD_MISTAKE_MIN = 0.9;
const FIELD_MISTAKE_MAX = 4.5;
const FIELD_LAP_FLOOR = 0.985;
const FIELD_MIN_INTERVAL = 0.14;
const FIELD_HOLD_INTERVAL = 0.62;
const FIELD_PASS_CHANCE = 0.22;
export class RaceDirector {
  static systemName = "race";
  constructor() {
    this.standings = [];
    this.session = {
      type: "race",
      name: "Race",
      state: "idle",
      flag: "green",
      lap: 1,
      totalLaps: 0,
      timeElapsed: 0,
      timeRemaining: 0,
      duration: 0,
      lights: 0,
      lightsOut: false,
      lightsFrozen: false,
      formationLap: false,
      drsEnabled: false,
      sectorFlags: ["green", "green", "green"],
      bestLap: Infinity,
      bestLapDriver: "",
      leader: 0,
      finished: false
    };
    this.bests = new SessionBests();
    this._cars = [];
    this._order = [];
    this._grid = [];
    this._rail = null;
    this._ready = false;
    this._seed = 20260827;
    this.rng = new Rng(this._seed);
    this._sessionRng = new Rng(this._seed ^ 528734635);
    this._qualiReady = false;
    this._paceReady = false;
    this._spread = null;
    this._shares = new Float64Array(SECTOR_COUNT);
    this._sharesReady = false;
    this._splits = new Float64Array(SECTOR_COUNT);
    this._bestSplits = new Float64Array(SECTOR_COUNT);
    this._shapedShares = new Float64Array(SECTOR_COUNT);
    this.paceLimit = 0;
    this._lightTimer = 0;
    this._holdTime = 0;
    this._stateTimer = 0;
    this._historyTimer = 0;
    this._gapTimer = 0;
    this._yellow = new Float64Array(SECTOR_COUNT);
    this._finishEmitted = false;
    this._loc = null;
  }
  async init(ctx) {
    this.ctx = ctx;
    this.track = ctx.track ?? null;
    this.events = ctx.events;
    this._seed = (ctx.settings?.get?.("seed") ?? 20260827) >>> 0;
    this.rng.seed(this._seed ^ 1511506142);
    this._sessionRng.seed(this._seed ^ 528734635);
    this._sharesReady = false;
    this._qualiReady = false;
    this._paceReady = false;
    this._spread = null;
    const params = new URLSearchParams(globalThis.location?.search ?? "");
    const requested = params.get("session");
    const type = SESSION_TYPES[requested] ? requested : "race";
    const laps = Number(params.get("laps"));
    const formation = params.get("formation") === "1";
    this._loc = this.track?.surface?.createLocateResult?.() ?? null;
    this._onCollision = (payload) => this._onIncident(payload);
    this.events?.on("car:collision", this._onCollision);
    this.setSession(type, {
      totalLaps: Number.isFinite(laps) && laps > 0 ? Math.round(laps) : void 0,
      formationLap: formation
    });
  }
  setSession(type, options = {}) {
    const spec = SESSION_TYPES[type] ?? SESSION_TYPES.race;
    const s = this.session;
    s.type = SESSION_TYPES[type] ? type : "race";
    s.name = spec.name;
    s.duration = options.duration ?? spec.duration;
    s.totalLaps = options.totalLaps ?? spec.laps;
    s.formationLap = options.formationLap ?? spec.formation;
    s.timeElapsed = 0;
    s.timeRemaining = s.duration;
    s.lap = 1;
    s.flag = "green";
    s.lights = 0;
    s.lightsOut = !spec.lights;
    s.lightsFrozen = false;
    s.drsEnabled = s.type !== "race";
    s.finished = false;
    s.leader = 0;
    s.bestLap = Infinity;
    s.bestLapDriver = "";
    this.bests.reset();
    this._finishEmitted = false;
    this._lightTimer = 0;
    this._stateTimer = 0;
    for (let i = 0; i < SECTOR_COUNT; i++) this._yellow[i] = 0;
    this._bind(this.ctx);
    if (!spec.lights) {
      s.state = "racing";
      this._resync(false);
      this._emitStart();
      return;
    }
    this._placeOnGrid();
    s.state = s.formationLap ? "formation" : "grid";
    this._resync(s.formationLap);
    if (!s.formationLap) this._seedGridClassification();
  }
  restart() {
    this.setSession(this.session.type, {
      totalLaps: this.session.totalLaps,
      duration: this.session.duration,
      formationLap: this.session.formationLap
    });
  }
  _emitStart() {
    this.events?.emit("race:start", {
      type: this.session.type,
      totalLaps: this.session.totalLaps,
      time: this.session.timeElapsed
    });
  }
  _bind(ctx) {
    if (!ctx) return false;
    if (!this.track) this.track = ctx.track ?? null;
    if (!this._loc) this._loc = this.track?.surface?.createLocateResult?.() ?? null;
    const cars = resolveCars(ctx);
    if (!this.track || cars.length === 0) return false;
    if (this._cars.length === cars.length && this._cars[0]?.car === cars[0]) {
      this._ready = true;
      return true;
    }
    this._cars.length = 0;
    this._order.length = 0;
    this._grid.length = 0;
    this.standings.length = 0;
    this._qualiReady = false;
    this._paceReady = false;
    this._spread = null;
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      const physics = physicsOf(car);
      if (!physics) continue;
      const driver = car.driver ?? null;
      const record = {
        car,
        physics,
        index: i,
        driver,
        timing: new CarTiming(i),
        history: new ProgressHistory(),
        t: 0,
        prevT: 0,
        distance: 0,
        totalDistance: 0,
        lateral: 0,
        sector: 0,
        position: i + 1,
        gap: NaN,
        gapLeader: NaN,
        lapsDown: 0,
        delta: NaN,
        qualiTime: NaN,
        gridSlot: i,
        pace: NaN,
        seedLap: 0,
        sectorBias: new Float64Array(SECTOR_COUNT).fill(1),
        showSplits: new Float64Array(SECTOR_COUNT),
        offTrack: false,
        stoppedTimer: 0,
        drsArmed: true,
        drsGap: Infinity,
        jumpStart: false,
        penalty: 0,
        flag: "green",
        retired: false,
        entry: {
          car,
          index: i,
          driver,
          name: driver?.name ?? `Car ${i + 1}`,
          code: driver?.code ?? "",
          number: driver?.number ?? i + 1,
          team: driver?.team?.name ?? car.team?.name ?? "",
          position: i + 1,
          gap: NaN,
          gapLeader: NaN,
          lap: 0,
          lastLap: 0,
          bestLap: Infinity,
          delta: NaN,
          sectors: [0, 0, 0],
          sectorColours: [COLOUR_WHITE, COLOUR_WHITE, COLOUR_WHITE],
          lapColour: COLOUR_WHITE,
          flag: "green",
          penalty: 0,
          strikes: 0,
          retired: false,
          lapsDown: 0
        }
      };
      this._cars.push(record);
      this._order.push(record);
      this.standings.push(record.entry);
    }
    if (!this._loc && this._cars.length > 0) {
      this._loc = this.track.locate(this._cars[0].physics.state.position);
    }
    this._ready = this._cars.length > 0;
    return this._ready;
  }
  _sectorShares() {
    if (this._sharesReady) return this._shares;
    const track = this.track;
    const out = this._shares;
    this._sharesReady = true;
    if (!track || !this._loc || typeof track.sample !== "function") {
      return sectorLengthShares(track?.sectors, out);
    }
    for (let i = 0; i < SECTOR_COUNT; i++) out[i] = 0;
    const ds = track.length / PACE_SAMPLES;
    let total = 0;
    for (let i = 0; i < PACE_SAMPLES; i++) {
      const t = (i + 0.5) / PACE_SAMPLES;
      track.sample(t, this._loc);
      const curvature = Math.abs(this._loc.curvature ?? 0);
      const cornering = curvature > 1e-6 ? Math.sqrt(PACE_LATERAL_ACCEL / curvature) : PACE_TOP_SPEED;
      const speed = clamp(cornering, PACE_MIN_SPEED, PACE_TOP_SPEED);
      const dt = ds / speed;
      out[track.sectorAt(t)] += dt;
      total += dt;
    }
    if (!(total > 0) || !Number.isFinite(total)) return sectorLengthShares(track.sectors, out);
    for (let i = 0; i < SECTOR_COUNT; i++) {
      out[i] /= total;
      if (!(out[i] > 0)) return sectorLengthShares(track.sectors, out);
    }
    return out;
  }
  _buildQualifying() {
    if (this._qualiReady) return this._grid.length > 0;
    const cars = this._cars;
    if (cars.length === 0 || !this.track) return false;
    const rng = this._sessionRng.seed(this._seed ^ 625341585);
    const reference = this.track.length / REFERENCE_LAP_SPEED;
    let bestSkill = 0;
    for (let i = 0; i < cars.length; i++) {
      bestSkill = Math.max(bestSkill, cars[i].driver?.skill ?? 0.85);
    }
    this._grid.length = 0;
    for (let i = 1; i < cars.length; i++) {
      const skill = clamp(cars[i].driver?.skill ?? 0.85, 0.5, 1);
      cars[i].qualiTime = reference + (bestSkill - skill) * SKILL_SPREAD + rng.gaussian() * QUALI_NOISE;
      this._grid.push(cars[i]);
    }
    this._grid.sort((a, b) => a.qualiTime - b.qualiTime);
    if (cars.length > 0) {
      const slot = Math.min(PLAYER_GRID_SLOT, this._grid.length);
      const ahead = slot > 0 ? this._grid[slot - 1].qualiTime : reference - 0.4;
      const behind = slot < this._grid.length ? this._grid[slot].qualiTime : ahead + 0.4;
      const span = Math.max(behind - ahead, 0.04);
      cars[0].qualiTime = ahead + span * rng.range(0.22, 0.78);
      this._grid.splice(slot, 0, cars[0]);
    }
    for (let k = 0; k < this._grid.length; k++) this._grid[k].gridSlot = k;
    this._qualiReady = true;
    return true;
  }
  _buildRacePace() {
    if (this._paceReady) return true;
    if (!this._buildQualifying()) return false;
    const cars = this._cars;
    const rng = this._sessionRng.seed(this._seed ^ 2246822507);
    for (let i = 0; i < cars.length; i++) {
      const rec = cars[i];
      rec.pace = rec.qualiTime + RACE_FUEL_PENALTY + Math.abs(rng.gaussian()) * RACE_LAP_NOISE;
      for (let s = 0; s < SECTOR_COUNT; s++) rec.sectorBias[s] = 1 + rng.signed(SPLIT_JITTER);
    }
    this._paceReady = true;
    return true;
  }
  _shapedSplits(rec, lapTime, out, rng = null, jitter = 0) {
    const shares = this._sectorShares();
    const shaped = this._shapedShares;
    for (let i = 0; i < SECTOR_COUNT; i++) shaped[i] = shares[i] * rec.sectorBias[i];
    return splitLap(lapTime, shaped, out, rng, jitter);
  }
  _buildFieldSpread() {
    if (this._spread) return this._spread;
    if (!this._buildRacePace()) return null;
    const n = this._cars.length;
    if (n < 2) return null;
    const time = new Float64Array(n);
    const pace = new Float64Array(n);
    const spread = new Float64Array(n);
    const rng = this._sessionRng.seed(this._seed ^ 3266489909);
    for (let k = 0; k < n; k++) {
      const rec = this._grid[k] ?? this._cars[k];
      time[k] = k * FIELD_ROW_LOSS;
      pace[k] = Number.isFinite(rec.pace) ? rec.pace : this.track.length / REFERENCE_LAP_SPEED;
    }
    for (let lap = 0; lap < SHOT_LAP; lap++) {
      for (let k = 0; k < n; k++) {
        let lapTime = pace[k] + rng.gaussian() * FIELD_LAP_SCATTER;
        if (rng.next() < FIELD_MISTAKE_RATE) lapTime += rng.range(FIELD_MISTAKE_MIN, FIELD_MISTAKE_MAX);
        time[k] += Math.max(lapTime, pace[k] * FIELD_LAP_FLOOR);
      }
      for (let i = 1; i < n; i++) {
        const t = time[i];
        const p = pace[i];
        let j = i - 1;
        while (j >= 0 && time[j] > t) {
          time[j + 1] = time[j];
          pace[j + 1] = pace[j];
          j--;
        }
        time[j + 1] = t;
        pace[j + 1] = p;
      }
      for (let k = 1; k < n; k++) {
        const hold = FIELD_MIN_INTERVAL + rng.next() * FIELD_HOLD_INTERVAL;
        if (time[k] - time[k - 1] >= hold) continue;
        if (pace[k] < pace[k - 1] && rng.next() < FIELD_PASS_CHANCE) {
          const p = pace[k];
          pace[k] = pace[k - 1];
          pace[k - 1] = p;
        }
        time[k] = time[k - 1] + hold;
      }
    }
    spread[0] = 0;
    for (let k = 1; k < n; k++) spread[k] = time[k] - time[k - 1];
    this._spread = spread;
    return spread;
  }
  fieldIntervals(first, count, out) {
    const spread = this._buildFieldSpread();
    if (!spread || count <= 0 || !out) return 0;
    const n = spread.length;
    const usable = Math.min(count, out.length);
    for (let j = 0; j < usable; j++) {
      const k = first + j;
      out[j] = spread[k < n ? Math.max(1, k) : 1 + (k - 1) % (n - 1)];
    }
    return usable;
  }
  gridSlotFor(carIndex) {
    if (!this._buildQualifying()) return carIndex;
    for (let i = 0; i < this._cars.length; i++) {
      if (this._cars[i].index === carIndex) return this._cars[i].gridSlot;
    }
    return carIndex;
  }
  _placeOnGrid() {
    const track = this.track;
    if (!track?.startGrid?.length) return;
    this._buildQualifying();
    for (let i = 0; i < this._cars.length; i++) {
      const rec = this._cars[i];
      const slot = track.startGrid[rec.gridSlot % track.startGrid.length];
      rec.physics.reset(slot.position, slot.quaternion, track);
      rec.jumpStart = false;
      rec.penalty = 0;
    }
  }
  _seedGridClassification() {
    if (!this._buildQualifying()) return;
    this._buildRacePace();
    const grid = this._grid;
    const bounds = this.track.sectors;
    const now = this.session.timeElapsed;
    const rng = this._sessionRng.seed(this._seed ^ 2654435769);
    this.bests.reset();
    for (let k = 0; k < grid.length; k++) {
      const rec = grid[k];
      this._shapedSplits(rec, rec.qualiTime, rec.showSplits, rng, SPLIT_LAP_JITTER);
      this.bests.submitLap(rec.index, rec.qualiTime, 0);
      for (let i = 0; i < SECTOR_COUNT; i++) {
        this.bests.submitSector(i, rec.index, rec.showSplits[i]);
      }
    }
    for (let k = 0; k < grid.length; k++) {
      const rec = grid[k];
      rec.timing.seed({
        now,
        lap: 0,
        sector: rec.sector,
        started: false,
        bestLap: rec.qualiTime,
        lastLap: rec.qualiTime,
        bestSectors: rec.showSplits,
        lastSectors: rec.showSplits,
        bounds
      });
      rec.entry.lapColour = this.bests.classifyLap(rec.qualiTime, rec.qualiTime);
      this._writeSectorEntry(rec, rec.showSplits);
      this._writeCarFields(rec);
      rec.history.clear();
    }
    this.session.bestLap = this.bests.bestLap;
    this.session.bestLapDriver = grid[0]?.entry.name ?? "";
    this._gapTimer = GAP_INTERVAL;
    this._updateOrder(0);
  }
  _startRaceTiming() {
    this.bests.reset();
    this.session.bestLap = Infinity;
    this.session.bestLapDriver = "";
    for (let i = 0; i < this._cars.length; i++) {
      const rec = this._cars[i];
      rec.entry.lapColour = COLOUR_WHITE;
      for (let s = 0; s < SECTOR_COUNT; s++) {
        rec.entry.sectors[s] = 0;
        rec.entry.sectorColours[s] = COLOUR_WHITE;
      }
    }
  }
  _seedRunningClassification(plan, railSpeed) {
    if (!this._buildQualifying()) return;
    this._buildRacePace();
    const track = this.track;
    const cars = this._cars;
    const L = track.length;
    const shares = this._sectorShares();
    const bounds = track.sectors;
    const now = this.session.timeElapsed;
    const rng = this._sessionRng.seed(this._seed ^ 668265263);
    const player = cars[0];
    const base = this._authoredDistance(plan, player.index, player.distance);
    const playerTotal = SHOT_LAP * L + player.distance;
    this.bests.reset();
    for (let i = 0; i < cars.length; i++) {
      const rec = cars[i];
      const authored = this._authoredDistance(plan, rec.index, rec.distance);
      rec.seedLap = Math.max(0, Math.round((playerTotal + (authored - base) - rec.distance) / L));
      const best = rec.pace - rng.range(0.05, 0.55);
      const last = Math.max(best, rec.pace + rng.gaussian() * RACE_LAP_NOISE);
      this._shapedSplits(rec, best, this._bestSplits);
      this._shapedSplits(rec, last, rec.showSplits, rng, SPLIT_LAP_JITTER);
      for (let s = 0; s < SECTOR_COUNT; s++) {
        if (rec.showSplits[s] < this._bestSplits[s]) this._bestSplits[s] = rec.showSplits[s];
      }
      const fraction = lapTimeFraction(rec.t, bounds, shares);
      let sectorFraction = fraction;
      for (let s = 0; s < rec.sector; s++) sectorFraction -= shares[s];
      rec.timing.seed({
        now,
        lap: rec.seedLap,
        sector: rec.sector,
        started: true,
        lapElapsed: fraction * rec.pace,
        sectorElapsed: Math.max(0, sectorFraction) * rec.pace,
        bestLap: best,
        lastLap: last,
        bestSectors: this._bestSplits,
        lastSectors: rec.showSplits,
        currentSectors: rec.showSplits,
        bounds
      });
      this.bests.submitLap(rec.index, best, rec.seedLap);
      for (let s = 0; s < SECTOR_COUNT; s++) this.bests.submitSector(s, rec.index, this._bestSplits[s]);
      rec.totalDistance = rec.seedLap * L + rec.distance;
      this._seedFuel(rec, rec.seedLap + fraction);
      const speed = Number.isFinite(railSpeed) && railSpeed > 0 ? railSpeed : Math.abs(rec.physics.state.speed);
      rec.history.seed(rec.totalDistance, now, speed, HISTORY_SPAN);
      rec.drsArmed = true;
    }
    for (let i = 0; i < cars.length; i++) {
      const rec = cars[i];
      this._writeSectorEntry(rec, rec.showSplits, rec.sector);
      rec.entry.lapColour = this.bests.classifyLap(rec.timing.lastLap, rec.timing.bestLap);
      this._writeCarFields(rec);
    }
    this.session.bestLap = this.bests.bestLap;
    const holder = this._carByIndex(this.bests.bestLapCar);
    this.session.bestLapDriver = holder?.entry.name ?? "";
    this._gapTimer = GAP_INTERVAL;
    this._updateOrder(0);
  }
  _seedFuel(rec, laps) {
    const pt = rec.physics?.powertrain;
    if (!pt) return;
    const eng = pt.eng ?? rec.physics.config?.engine;
    if (!eng) return;
    const pace = Number.isFinite(rec.pace) && rec.pace > 0 ? rec.pace : this.track.length / REFERENCE_LAP_SPEED;
    const perLap = pace * eng.fuelFlowMax * FUEL_FLOW_DUTY;
    pt.fuel = clamp(eng.startFuel - Math.max(0, laps) * perLap, FUEL_RESERVE, eng.startFuel);
    pt.fuelRate = 0;
    rec.physics.state.fuel = pt.fuel;
  }
  _authoredDistance(plan, carIndex, fallback) {
    if (!plan) return fallback;
    for (let i = 0; i < plan.length; i++) {
      if (plan[i].index === carIndex) return plan[i].distance;
    }
    return fallback;
  }
  _carByIndex(carIndex) {
    for (let i = 0; i < this._cars.length; i++) {
      if (this._cars[i].index === carIndex) return this._cars[i];
    }
    return null;
  }
  _writeSectorEntry(rec, splits, upTo = SECTOR_COUNT) {
    for (let i = 0; i < SECTOR_COUNT; i++) {
      const time = i < upTo ? splits[i] : rec.timing.lastSectorTimes[i];
      if (!(time > 0)) {
        rec.entry.sectors[i] = 0;
        rec.entry.sectorColours[i] = COLOUR_WHITE;
        continue;
      }
      rec.entry.sectors[i] = time;
      rec.entry.sectorColours[i] = this.bests.classifySector(i, time, rec.timing.bestSectorTimes[i]);
    }
  }
  _resync(timed) {
    const track = this.track;
    if (!track || !this._loc) return;
    const now = this.session.timeElapsed;
    for (let i = 0; i < this._cars.length; i++) {
      const rec = this._cars[i];
      track.locate(rec.physics.state.position, this._loc);
      rec.t = this._loc.t;
      rec.prevT = this._loc.t;
      rec.distance = this._loc.distance;
      rec.lateral = this._loc.lateral;
      rec.sector = track.sectorAt(rec.t);
      rec.totalDistance = rec.distance;
      rec.offTrack = false;
      rec.stoppedTimer = 0;
      rec.gap = NaN;
      rec.gapLeader = NaN;
      rec.lapsDown = 0;
      rec.delta = NaN;
      rec.drsArmed = this.session.type !== "race";
      rec.timing.reset(now, rec.sector, timed);
      rec.history.clear();
      this._writeCarFields(rec);
    }
  }
  update(dt, ctx) {
    if (!this._ready) {
      if (!this._bind(ctx)) return;
      this.restart();
    }
    this._rail?.update(dt);
    const s = this.session;
    if (s.state !== "idle") s.timeElapsed += dt;
    this._advanceState(dt);
    this._sampleCars(dt);
    this._updateOrder(dt);
    this._updateFlags(dt);
    this._updateDrs();
  }
  _advanceState(dt) {
    const s = this.session;
    this._stateTimer += dt;
    switch (s.state) {
      case "formation": {
        this.paceLimit = 24;
        const leader = this._cars[0];
        if (leader && (leader.timing.lap >= 1 || this._stateTimer > 300)) {
          this._placeOnGrid();
          this._resync(false);
          this._seedGridClassification();
          s.state = "grid";
          this._stateTimer = 0;
        }
        break;
      }
      case "grid":
        this.paceLimit = 0;
        if (this._stateTimer >= GRID_SETTLE) {
          s.state = "countdown";
          this._lightTimer = 0;
          this._holdTime = this.rng.range(HOLD_MIN, HOLD_MAX);
          this._stateTimer = 0;
        }
        break;
      case "countdown":
        this._advanceLights(dt);
        break;
      case "racing":
        this._checkFinish();
        break;
      default:
        break;
    }
    if (s.duration > 0 && s.state === "racing") {
      s.timeRemaining = Math.max(0, s.duration - s.timeElapsed);
      if (s.timeRemaining === 0 && !s.finished) this._finish();
    }
  }
  _advanceLights(dt) {
    const s = this.session;
    if (s.lightsFrozen) return;
    this._lightTimer += dt;
    const lit = Math.floor((this._lightTimer - LIGHT_LEAD_IN) / LIGHT_INTERVAL) + 1;
    s.lights = clamp(lit, 0, LIGHT_COUNT);
    const allOn = LIGHT_LEAD_IN + LIGHT_COUNT * LIGHT_INTERVAL;
    if (this._lightTimer >= allOn + this._holdTime) {
      s.lights = 0;
      s.lightsOut = true;
      s.state = "racing";
      s.timeElapsed = 0;
      s.lap = 1;
      this._resync(false);
      this._startRaceTiming();
      this._emitStart();
      return;
    }
    this._checkJumpStarts();
  }
  _checkJumpStarts() {
    const track = this.track;
    if (!track?.startGrid?.length) return;
    for (let i = 0; i < this._cars.length; i++) {
      const rec = this._cars[i];
      if (rec.jumpStart) continue;
      const state = rec.physics.state;
      const slot = track.startGrid[rec.gridSlot % track.startGrid.length];
      const moved = state.position.distanceTo(slot.position);
      if (Math.abs(state.speed) > JUMP_START_SPEED || moved > JUMP_START_DISTANCE) {
        rec.jumpStart = true;
        rec.penalty += JUMP_START_PENALTY;
        this.events?.emit("race:penalty", {
          car: rec.car,
          index: rec.index,
          reason: "jump-start",
          seconds: JUMP_START_PENALTY
        });
      }
    }
  }
  _checkFinish() {
    const s = this.session;
    if (s.totalLaps <= 0 || s.finished) return;
    const leader = this._order[0];
    if (leader && leader.timing.lap >= s.totalLaps) this._finish();
  }
  _finish() {
    const s = this.session;
    s.finished = true;
    s.state = "finished";
    s.flag = "chequered";
    if (this._finishEmitted) return;
    this._finishEmitted = true;
    this.events?.emit("race:finish", {
      type: s.type,
      standings: this.standings,
      winner: this.standings[0] ?? null,
      time: s.timeElapsed
    });
  }
  _sampleCars(dt) {
    const track = this.track;
    const s = this.session;
    const now = s.timeElapsed;
    const timing = s.state === "racing" || s.state === "formation" || s.state === "finished";
    this._historyTimer += dt;
    const pushHistory = this._historyTimer >= HISTORY_INTERVAL;
    if (pushHistory) this._historyTimer = 0;
    for (let i = 0; i < this._cars.length; i++) {
      const rec = this._cars[i];
      const state = rec.physics.state;
      track.locate(state.position, this._loc);
      rec.prevT = rec.t;
      rec.t = this._loc.t;
      rec.distance = this._loc.distance;
      rec.lateral = this._loc.lateral;
      const sector = track.sectorAt(rec.t);
      if (timing) {
        const code = rec.timing.advance(sector, now);
        if (code !== ADVANCE_NONE) this._onSector(rec);
        if (code === ADVANCE_LAP) this._onLap(rec);
        this._policeTrackLimits(rec, state, this._loc);
      }
      rec.sector = rec.timing.sector;
      rec.totalDistance = rec.timing.crossings * track.length + rec.distance;
      if (rec.timing.started) {
        const lapElapsed = rec.timing.currentLapTime(now);
        rec.timing.delta.record(rec.t, lapElapsed);
        const reference = rec.timing.delta.lookup(rec.t);
        rec.delta = Number.isFinite(reference) ? lapElapsed - reference : NaN;
      } else {
        rec.delta = NaN;
      }
      if (Math.abs(state.speed) < STOPPED_SPEED && !state.onTrack) {
        rec.stoppedTimer += dt;
        if (rec.stoppedTimer > STOPPED_SECONDS) this._raiseYellow(rec.sector);
      } else {
        rec.stoppedTimer = 0;
      }
      if (pushHistory) rec.history.push(rec.totalDistance, now);
      this._writeCarFields(rec);
    }
  }
  _policeTrackLimits(rec, state, loc) {
    const over = Math.abs(loc.lateral) - loc.width;
    if (over > TRACK_LIMIT_MARGIN) {
      if (!rec.offTrack && Math.abs(state.speed) > TRACK_LIMIT_MIN_SPEED) {
        rec.offTrack = true;
        const deleted = rec.timing.strike();
        this.events?.emit("race:limits", {
          car: rec.car,
          index: rec.index,
          strikes: rec.timing.strikes,
          deleted,
          lap: rec.timing.lap + 1
        });
      }
    } else if (over < -TRACK_LIMIT_REARM) {
      rec.offTrack = false;
    }
  }
  _onSector(rec) {
    const timing = rec.timing;
    const index = timing.lastSectorIndex;
    if (index < 0) return;
    const time = timing.lastSectorTime;
    const valid = timing.sectorValid[index] === 1;
    const sessionBest = valid && this.bests.submitSector(index, rec.index, time);
    rec.entry.sectors[index] = time;
    rec.entry.sectorColours[index] = valid ? this.bests.classifySector(index, time, timing.bestSectorTimes[index]) : COLOUR_WHITE;
    this.events?.emit("race:sector", {
      car: rec.car,
      index: rec.index,
      sector: index,
      time,
      personalBest: timing.sectorPersonalBest,
      sessionBest,
      valid
    });
  }
  _onLap(rec) {
    const timing = rec.timing;
    rec.physics.powertrain?.notifyLap?.();
    if (!timing.lastLapCounted) return;
    const time = timing.lastLap;
    const valid = timing.lastLapValid;
    const sessionBest = valid && this.bests.submitLap(rec.index, time, timing.lap);
    const colour = valid ? this.bests.classifyLap(time, timing.bestLap) : COLOUR_WHITE;
    rec.entry.lapColour = colour;
    if (sessionBest) {
      this.session.bestLap = time;
      this.session.bestLapDriver = rec.entry.name;
    }
    this.events?.emit("race:lap", {
      car: rec.car,
      index: rec.index,
      lap: timing.lap,
      time,
      best: timing.bestLap,
      personalBest: timing.lapPersonalBest,
      sessionBest,
      valid,
      colour
    });
    if (this.session.state === "racing" && this.session.totalLaps > 0) this._checkFinish();
  }
  _writeCarFields(rec) {
    const car = rec.car;
    const timing = rec.timing;
    car.lapsCompleted = timing.lap;
    car.currentLap = timing.lap + 1;
    car.currentSector = timing.sector;
    car.lastLapTime = timing.lastLap;
    car.bestLapTime = Number.isFinite(timing.bestLap) ? timing.bestLap : 0;
    car.delta = rec.delta;
    car.trackLimitStrikes = timing.strikes;
    car.lapValid = timing.valid;
    car.distanceAlongTrack = rec.distance;
  }
  _updateOrder(dt) {
    const order = this._order;
    let reordered = false;
    for (let i = 1; i < order.length; i++) {
      const rec = order[i];
      let j = i - 1;
      while (j >= 0 && this._ranks(order[j], rec) < 0) {
        order[j + 1] = order[j];
        j--;
        reordered = true;
      }
      order[j + 1] = rec;
    }
    this._gapTimer += dt;
    const recomputeGaps = this._gapTimer >= GAP_INTERVAL || reordered;
    if (recomputeGaps) this._gapTimer = 0;
    const now = this.session.timeElapsed;
    const leader = order[0];
    const s = this.session;
    const lapLength = this.track.length;
    s.leader = leader ? leader.index : 0;
    if (leader) {
      const lap = leader.timing.lap + 1;
      s.lap = s.totalLaps > 0 ? clamp(lap, 1, s.totalLaps) : lap;
    }
    const gridGaps = s.state === "grid" || s.state === "countdown";
    for (let k = 0; k < order.length; k++) {
      const rec = order[k];
      rec.position = k + 1;
      if (recomputeGaps) {
        if (k === 0) {
          rec.gap = 0;
          rec.gapLeader = 0;
        } else if (gridGaps) {
          rec.gap = this._qualiGap(order[k - 1], rec);
          rec.gapLeader = this._qualiGap(leader, rec);
        } else {
          rec.gap = this._timeGap(order[k - 1], rec, now);
          const aheadLeader = order[k - 1].gapLeader;
          rec.gapLeader = Number.isFinite(aheadLeader) && Number.isFinite(rec.gap) ? aheadLeader + rec.gap : this._timeGap(leader, rec, now);
        }
        rec.lapsDown = leader ? Math.max(0, Math.floor((leader.totalDistance - rec.totalDistance) / lapLength)) : 0;
      }
      const e = rec.entry;
      e.position = rec.position;
      e.gap = rec.gap;
      e.gapLeader = rec.gapLeader;
      e.lap = rec.timing.lap;
      e.lastLap = rec.timing.lastLap;
      e.bestLap = rec.timing.bestLap;
      e.delta = rec.delta;
      e.flag = rec.flag;
      e.penalty = rec.penalty;
      e.strikes = rec.timing.strikes;
      e.retired = rec.retired;
      e.lapsDown = rec.lapsDown;
      this.standings[k] = e;
      rec.car.racePosition = rec.position;
      rec.car.gapAhead = rec.gap;
      rec.car.gapLeader = rec.gapLeader;
    }
    this.standings.length = order.length;
  }
  _ranks(a, b) {
    if (a.retired !== b.retired) return a.retired ? -1 : 1;
    const d = a.totalDistance - b.totalDistance;
    return d > 0 ? 1 : d < 0 ? -1 : 0;
  }
  _timeGap(ahead, behind, now) {
    const distance = ahead.totalDistance - behind.totalDistance;
    if (!(distance > 0)) return 0;
    const passed = ahead.history.timeAt(behind.totalDistance);
    if (Number.isFinite(passed) && passed <= now) return Math.max(0, now - passed);
    const speed = this._gapSpeed(ahead, behind, now);
    if (!(speed > GAP_MIN_SPEED)) return NaN;
    return distance / speed;
  }
  _gapSpeed(ahead, behind, now) {
    let a = ahead.history.recentSpeed(now, GAP_SPEED_WINDOW);
    if (!(a > GAP_MIN_SPEED)) a = Math.abs(ahead.physics.state.speed);
    let b = behind.history.recentSpeed(now, GAP_SPEED_WINDOW);
    if (!(b > GAP_MIN_SPEED)) b = Math.abs(behind.physics.state.speed);
    if (a > GAP_MIN_SPEED && b > GAP_MIN_SPEED) return (a + b) * 0.5;
    return Math.max(a, b);
  }
  _qualiGap(ahead, behind) {
    const gap = behind.qualiTime - ahead.qualiTime;
    return Number.isFinite(gap) ? Math.max(0, gap) : NaN;
  }
  _onIncident(payload) {
    if ((payload?.impulse ?? 0) < INCIDENT_IMPULSE) return;
    const rec = payload.index !== void 0 ? this._cars[payload.index] : this._cars[0];
    if (rec) this._raiseYellow(rec.sector);
  }
  _raiseYellow(sector) {
    if (sector >= 0 && sector < SECTOR_COUNT) this._yellow[sector] = YELLOW_SECONDS;
  }
  _updateFlags(dt) {
    const s = this.session;
    let anyYellow = false;
    for (let i = 0; i < SECTOR_COUNT; i++) {
      if (this._yellow[i] > 0) {
        this._yellow[i] -= dt;
        if (this._yellow[i] > 0) anyYellow = true;
      }
      s.sectorFlags[i] = this._yellow[i] > 0 ? "yellow" : "green";
    }
    const order = this._order;
    const lapLength = this.track.length;
    for (let k = 0; k < order.length; k++) {
      const rec = order[k];
      let flag = "green";
      if (this._yellow[rec.sector] > 0) flag = "yellow";
      if (k > 0) {
        const lapper = order[k - 1];
        if (rec.lapsDown > lapper.lapsDown) {
          const behind = -deltaT(rec.t, lapper.t) * lapLength;
          const speed = Math.max(Math.abs(rec.physics.state.speed), 20);
          if (behind > 0 && behind < BLUE_FLAG_SECONDS * speed) flag = "blue";
        }
      }
      rec.flag = flag;
      rec.entry.flag = flag;
      rec.car.flag = flag;
    }
    if (s.state === "finished") s.flag = "chequered";
    else if (anyYellow) s.flag = "yellow";
    else if (s.state === "grid" || s.state === "countdown") s.flag = "none";
    else s.flag = "green";
  }
  _updateDrs() {
    const track = this.track;
    const s = this.session;
    const rain = this.ctx?.sky?.weather?.rain ?? 0;
    const leaderLap = this._order[0]?.timing.lap ?? 0;
    s.drsEnabled = rain <= DRS_MAX_RAIN && s.flag !== "yellow" && (s.type !== "race" || s.state === "racing" && leaderLap >= DRS_ENABLE_LAP) && s.state !== "grid" && s.state !== "countdown" && s.state !== "formation";
    for (let i = 0; i < this._cars.length; i++) {
      const rec = this._cars[i];
      const aero = rec.physics.aero;
      if (!aero?.setDrsZone) continue;
      if (s.type === "race" && !this.ctx?.captureMode) {
        for (let z = 0; z < track.drsZones.length; z++) {
          const zone = track.drsZones[z];
          if (this._crossed(rec.prevT, rec.t, zone.detect)) {
            rec.drsGap = rec.position > 1 ? rec.gap : Infinity;
            rec.drsArmed = rec.drsGap <= DRS_WINDOW;
          }
        }
      } else {
        rec.drsArmed = true;
      }
      const inZone = track.inDrsZone(rec.t);
      aero.setDrsZone(inZone && s.drsEnabled, inZone && s.drsEnabled && rec.drsArmed);
    }
  }
  _crossed(prev, cur, mark) {
    const before = deltaT(prev, mark);
    const after = deltaT(cur, mark);
    return before > 0 && after <= 0 && before < 0.02;
  }
  applyScenario(setup = {}) {
    if (!this._ready) this._bind(this.ctx);
    this._rail?.clear();
    this._rail = buildScenario(this.ctx, this, setup);
    return this._rail;
  }
  setupGridShot() {
    const s = this.session;
    s.state = "countdown";
    s.lights = LIGHT_COUNT;
    s.lightsOut = false;
    s.lightsFrozen = true;
    s.flag = "none";
    s.lap = 1;
    s.timeElapsed = 0;
    s.finished = false;
    this._lightTimer = 0;
    this._stateTimer = 0;
    this._resync(false);
    this._seedGridClassification();
  }
  setupRunningShot(name, speed, plan = null) {
    const s = this.session;
    s.state = "racing";
    s.lights = 0;
    s.lightsOut = true;
    s.lightsFrozen = false;
    s.flag = "green";
    s.timeElapsed = 0;
    s.finished = false;
    s.drsEnabled = true;
    this._finishEmitted = false;
    this._stateTimer = 0;
    for (let i = 0; i < SECTOR_COUNT; i++) this._yellow[i] = 0;
    this._resync(false);
    this._seedRunningClassification(plan, speed);
    const lap = (this._order[0]?.timing.lap ?? SHOT_LAP) + 1;
    s.lap = s.totalLaps > 0 ? clamp(lap, 1, s.totalLaps) : lap;
  }
  entryFor(car) {
    for (let i = 0; i < this._cars.length; i++) {
      if (this._cars[i].car === car) return this._cars[i].entry;
    }
    return null;
  }
  get playerDelta() {
    return this._cars[0]?.delta ?? NaN;
  }
  lateUpdate() {
  }
  resize() {
  }
  dispose() {
    this.events?.off?.("car:collision", this._onCollision);
    this._rail?.clear();
    this._rail = null;
    this._cars.length = 0;
    this._order.length = 0;
    this.standings.length = 0;
    this._ready = false;
  }
}
