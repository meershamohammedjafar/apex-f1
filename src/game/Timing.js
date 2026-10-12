import { clamp, clamp01 } from "../core/MathUtils.js";
export const SECTOR_COUNT = 3;
export const ADVANCE_NONE = 0;
export const ADVANCE_SECTOR = 1;
export const ADVANCE_LAP = 2;
export const COLOUR_PURPLE = "purple";
export const COLOUR_GREEN = "green";
export const COLOUR_YELLOW = "yellow";
export const COLOUR_WHITE = "white";
export const STRIKES_PER_DELETION = 3;
const DELTA_BINS = 512;
const DELTA_ORIGIN_TOLERANCE = 8;
export class DeltaTrace {
  constructor(bins = DELTA_BINS) {
    this.bins = bins;
    this.reference = new Float32Array(bins);
    this.candidate = new Float32Array(bins);
    this.hasReference = false;
    this.referenceTime = Infinity;
    this._cursor = -1;
    this._origin = -1;
  }
  begin() {
    this._cursor = -1;
    this._origin = -1;
  }
  clear() {
    this.hasReference = false;
    this.referenceTime = Infinity;
    this._cursor = -1;
    this._origin = -1;
  }
  record(fraction, elapsed) {
    let index = Math.floor(clamp01(fraction) * this.bins);
    if (index >= this.bins) index = this.bins - 1;
    if (this._cursor < 0) {
      this._origin = index;
      this.candidate[index] = elapsed;
      this._cursor = index;
      return;
    }
    if (index <= this._cursor) return;
    for (let i = this._cursor + 1; i <= index; i++) this.candidate[i] = elapsed;
    this._cursor = index;
  }
  commit(lapTime) {
    if (!(lapTime > 0) || lapTime >= this.referenceTime) return false;
    if (this._origin < 0 || this._origin > DELTA_ORIGIN_TOLERANCE) return false;
    for (let i = this._cursor + 1; i < this.bins; i++) this.candidate[i] = lapTime;
    this.reference.set(this.candidate);
    this.referenceTime = lapTime;
    this.hasReference = true;
    return true;
  }
  seed(bounds, splits, count) {
    let lap = 0;
    for (let i = 0; i < count; i++) {
      if (!(splits[i] > 0)) return false;
      lap += splits[i];
    }
    let segment = 0;
    let elapsed = 0;
    for (let b = 0; b < this.bins; b++) {
      const f = b / (this.bins - 1);
      while (segment < count - 1 && f >= bounds[segment + 1]) {
        elapsed += splits[segment];
        segment++;
      }
      const start = bounds[segment];
      const end = segment + 1 < count ? bounds[segment + 1] : 1;
      const span = end - start;
      const u = span > 1e-6 ? clamp01((f - start) / span) : 0;
      this.reference[b] = elapsed + splits[segment] * u;
    }
    this.referenceTime = lap;
    this.hasReference = true;
    return true;
  }
  lookup(fraction) {
    if (!this.hasReference) return NaN;
    const f = clamp01(fraction) * (this.bins - 1);
    const i = Math.floor(f);
    const j = i + 1 < this.bins ? i + 1 : this.bins - 1;
    const u = f - i;
    return this.reference[i] + (this.reference[j] - this.reference[i]) * u;
  }
}
export class CarTiming {
  constructor(index = 0) {
    this.index = index;
    this.sectorTimes = new Float64Array(SECTOR_COUNT);
    this.lastSectorTimes = new Float64Array(SECTOR_COUNT);
    this.bestSectorTimes = new Float64Array(SECTOR_COUNT);
    this.sectorValid = new Uint8Array(SECTOR_COUNT);
    this.delta = new DeltaTrace();
    this.reset(0, 0, false);
  }
  reset(time, sector, timed) {
    this.lap = 0;
    this.crossings = 0;
    this.sector = sector | 0;
    this.started = !!timed;
    this.lapStart = time;
    this.sectorStart = time;
    this.lastLap = 0;
    this.previousLap = 0;
    this.bestLap = Infinity;
    this.lastLapValid = true;
    this.valid = true;
    this.strikes = 0;
    this.deletions = 0;
    this.lastSectorIndex = -1;
    this.lastSectorTime = 0;
    this.sectorPersonalBest = false;
    this.lapPersonalBest = false;
    this.lastLapCounted = false;
    for (let i = 0; i < SECTOR_COUNT; i++) {
      this.sectorTimes[i] = 0;
      this.lastSectorTimes[i] = 0;
      this.bestSectorTimes[i] = Infinity;
      this.sectorValid[i] = 1;
    }
    this.delta.clear();
    this.delta.begin();
  }
  seed(spec) {
    const now = spec.now ?? 0;
    const sector = clamp(spec.sector | 0, 0, SECTOR_COUNT - 1);
    this.lap = Math.max(0, spec.lap | 0);
    this.crossings = Math.max(0, spec.crossings ?? spec.lap | 0);
    this.sector = sector;
    this.started = spec.started !== false;
    this.lapStart = now - Math.max(0, spec.lapElapsed ?? 0);
    this.sectorStart = now - Math.max(0, spec.sectorElapsed ?? 0);
    this.lastLap = spec.lastLap > 0 ? spec.lastLap : 0;
    this.previousLap = this.lastLap;
    this.bestLap = spec.bestLap > 0 ? spec.bestLap : Infinity;
    this.lastLapValid = true;
    this.valid = true;
    this.strikes = 0;
    this.deletions = 0;
    this.lastSectorIndex = -1;
    this.lastSectorTime = 0;
    this.sectorPersonalBest = false;
    this.lapPersonalBest = false;
    this.lastLapCounted = false;
    for (let i = 0; i < SECTOR_COUNT; i++) {
      const best = spec.bestSectors?.[i] ?? 0;
      const last = spec.lastSectors?.[i] ?? 0;
      const current = spec.currentSectors?.[i] ?? 0;
      this.bestSectorTimes[i] = best > 0 ? best : Infinity;
      this.lastSectorTimes[i] = last > 0 ? last : 0;
      this.sectorTimes[i] = i < sector && current > 0 ? current : 0;
      this.sectorValid[i] = 1;
    }
    this.delta.begin();
    if (spec.bounds && spec.bestSectors) {
      this.delta.seed(spec.bounds, spec.bestSectors, SECTOR_COUNT);
    } else {
      this.delta.clear();
      this.delta.begin();
    }
  }
  currentLapTime(time) {
    return time - this.lapStart;
  }
  advance(sector, time) {
    if (sector === this.sector) return ADVANCE_NONE;
    const expected = (this.sector + 1) % SECTOR_COUNT;
    if (sector !== expected) return ADVANCE_NONE;
    const completed = this.sector;
    const recording = this.started;
    const split = time - this.sectorStart;
    this.sector = sector;
    this.sectorStart = time;
    this.lastLapCounted = false;
    if (recording) {
      this.lastSectorIndex = completed;
      this.lastSectorTime = split;
      this.sectorTimes[completed] = split;
      this.sectorValid[completed] = this.valid ? 1 : 0;
      this.sectorPersonalBest = this.valid && split > 0 && split < this.bestSectorTimes[completed];
      if (this.sectorPersonalBest) this.bestSectorTimes[completed] = split;
    } else {
      this.lastSectorIndex = -1;
      this.lastSectorTime = 0;
      this.sectorPersonalBest = false;
    }
    if (sector !== 0) return ADVANCE_SECTOR;
    this.crossings++;
    if (recording) {
      const lapTime = time - this.lapStart;
      this.lap++;
      this.lapPersonalBest = false;
      if (lapTime > 1) {
        this.lastLapCounted = true;
        this.previousLap = this.lastLap;
        this.lastLap = lapTime;
        this.lastLapValid = this.valid;
        for (let i = 0; i < SECTOR_COUNT; i++) this.lastSectorTimes[i] = this.sectorTimes[i];
        if (this.valid) {
          if (lapTime < this.bestLap) {
            this.bestLap = lapTime;
            this.lapPersonalBest = true;
          }
          this.delta.commit(lapTime);
        }
      }
    }
    this.lapStart = time;
    this.started = true;
    this.valid = true;
    this.delta.begin();
    return ADVANCE_LAP;
  }
  invalidate() {
    this.valid = false;
  }
  strike() {
    this.valid = false;
    this.strikes++;
    if (this.strikes >= STRIKES_PER_DELETION) {
      this.strikes = 0;
      this.deletions++;
      return true;
    }
    return false;
  }
  theoreticalBest() {
    let sum = 0;
    for (let i = 0; i < SECTOR_COUNT; i++) {
      const s = this.bestSectorTimes[i];
      if (!Number.isFinite(s)) return Infinity;
      sum += s;
    }
    return sum;
  }
}
export class SessionBests {
  constructor() {
    this.bestSectors = new Float64Array(SECTOR_COUNT);
    this.bestSectorCar = new Int16Array(SECTOR_COUNT);
    this.reset();
  }
  reset() {
    this.bestLap = Infinity;
    this.bestLapCar = -1;
    this.bestLapNumber = 0;
    for (let i = 0; i < SECTOR_COUNT; i++) {
      this.bestSectors[i] = Infinity;
      this.bestSectorCar[i] = -1;
    }
  }
  submitLap(carIndex, time, lapNumber) {
    if (!(time > 0) || time >= this.bestLap) return false;
    this.bestLap = time;
    this.bestLapCar = carIndex;
    this.bestLapNumber = lapNumber;
    return true;
  }
  submitSector(sector, carIndex, time) {
    if (!(time > 0) || time >= this.bestSectors[sector]) return false;
    this.bestSectors[sector] = time;
    this.bestSectorCar[sector] = carIndex;
    return true;
  }
  classifyLap(time, personalBest) {
    if (!(time > 0)) return COLOUR_WHITE;
    if (time <= this.bestLap) return COLOUR_PURPLE;
    if (time <= personalBest) return COLOUR_GREEN;
    return COLOUR_YELLOW;
  }
  classifySector(sector, time, personalBest) {
    if (!(time > 0)) return COLOUR_WHITE;
    if (time <= this.bestSectors[sector]) return COLOUR_PURPLE;
    if (time <= personalBest) return COLOUR_GREEN;
    return COLOUR_YELLOW;
  }
  theoretical() {
    let sum = 0;
    for (let i = 0; i < SECTOR_COUNT; i++) {
      if (!Number.isFinite(this.bestSectors[i])) return Infinity;
      sum += this.bestSectors[i];
    }
    return sum;
  }
}
export class ProgressHistory {
  constructor(capacity = 256) {
    this.capacity = capacity;
    this.distance = new Float64Array(capacity);
    this.time = new Float64Array(capacity);
    this.count = 0;
    this.head = 0;
  }
  clear() {
    this.count = 0;
    this.head = 0;
  }
  seed(distance, time, speed, span) {
    this.clear();
    const covered = Math.max(0, speed) * Math.max(0, span);
    if (!(covered > 1)) {
      this.push(distance, time);
      return;
    }
    const steps = Math.min(this.capacity - 1, Math.max(2, Math.round(covered)));
    const step = span / steps;
    for (let i = steps; i >= 0; i--) {
      this.push(distance - speed * step * i, time - step * i);
    }
  }
  push(distance, time) {
    if (this.count > 0) {
      const last = (this.head - 1 + this.capacity) % this.capacity;
      if (distance <= this.distance[last] + 0.25) {
        this.time[last] = time;
        return;
      }
    }
    this.distance[this.head] = distance;
    this.time[this.head] = time;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }
  _at(i) {
    return (this.head - this.count + i + this.capacity * 2) % this.capacity;
  }
  timeAt(distance) {
    if (this.count < 2) return NaN;
    const first = this.distance[this._at(0)];
    const last = this.distance[this._at(this.count - 1)];
    if (distance < first || distance > last) return NaN;
    let lo = 0;
    let hi = this.count - 1;
    while (hi - lo > 1) {
      const mid = lo + hi >> 1;
      if (this.distance[this._at(mid)] <= distance) lo = mid;
      else hi = mid;
    }
    const ia = this._at(lo);
    const ib = this._at(hi);
    const span = this.distance[ib] - this.distance[ia];
    if (span <= 1e-6) return this.time[ib];
    const u = (distance - this.distance[ia]) / span;
    return this.time[ia] + (this.time[ib] - this.time[ia]) * u;
  }
  recentSpeed(now, seconds) {
    if (this.count < 2) return 0;
    const newest = this._at(this.count - 1);
    const target = this.time[newest] - seconds;
    let index = 0;
    for (let i = this.count - 1; i >= 0; i--) {
      index = this._at(i);
      if (this.time[index] <= target) break;
    }
    const dt = this.time[newest] - this.time[index];
    if (dt <= 1e-3) return 0;
    return (this.distance[newest] - this.distance[index]) / dt;
  }
}
export function sectorLengthShares(bounds, out) {
  let total = 0;
  for (let i = 0; i < SECTOR_COUNT; i++) {
    const start = bounds?.[i] ?? i / SECTOR_COUNT;
    const end = i + 1 < SECTOR_COUNT ? bounds?.[i + 1] ?? (i + 1) / SECTOR_COUNT : 1;
    const span = end - start;
    out[i] = span > 0 ? span : 0;
    total += out[i];
  }
  if (!(total > 0)) {
    for (let i = 0; i < SECTOR_COUNT; i++) out[i] = 1 / SECTOR_COUNT;
    return out;
  }
  for (let i = 0; i < SECTOR_COUNT; i++) out[i] /= total;
  return out;
}
export function splitLap(lapTime, shares, out, rng = null, jitter = 0) {
  let total = 0;
  for (let i = 0; i < SECTOR_COUNT; i++) {
    const weight = shares[i] * (rng && jitter > 0 ? 1 + rng.signed(jitter) : 1);
    out[i] = weight > 0 ? weight : shares[i];
    total += out[i];
  }
  for (let i = 0; i < SECTOR_COUNT; i++) out[i] = out[i] / total * lapTime;
  return out;
}
export function lapTimeFraction(t, bounds, shares) {
  const u = clamp01(t);
  let elapsed = 0;
  for (let i = 0; i < SECTOR_COUNT; i++) {
    const start = bounds?.[i] ?? i / SECTOR_COUNT;
    const end = i + 1 < SECTOR_COUNT ? bounds?.[i + 1] ?? (i + 1) / SECTOR_COUNT : 1;
    if (u >= end && i + 1 < SECTOR_COUNT) {
      elapsed += shares[i];
      continue;
    }
    const span = end - start;
    return elapsed + shares[i] * (span > 1e-6 ? clamp01((u - start) / span) : 0);
  }
  return elapsed;
}
