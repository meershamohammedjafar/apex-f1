import { clamp, clamp01 } from '../core/MathUtils.js';

/**
 * Timing primitives for the race director: per-car lap/sector state machines, the
 * session-wide best-time table that drives purple/green colouring, a distance-indexed
 * reference-lap trace for the live delta, and a progress history that turns a distance
 * difference into an honest time gap.
 *
 * Everything here is numeric and pre-allocated. The director calls into it every tick
 * for twenty cars, so not one method may allocate.
 */

export const SECTOR_COUNT = 3;

export const ADVANCE_NONE = 0;
export const ADVANCE_SECTOR = 1;
export const ADVANCE_LAP = 2;

export const COLOUR_PURPLE = 'purple';
export const COLOUR_GREEN = 'green';
export const COLOUR_YELLOW = 'yellow';
export const COLOUR_WHITE = 'white';

/** Track-limits warnings tolerated before the lap is formally deleted. */
export const STRIKES_PER_DELETION = 3;

const DELTA_BINS = 512;

/**
 * How far past the line a lap may start recording and still be usable as a reference.
 * 8 bins of 512 is about 110 m — one physics tick's worth at racing speed, so a lap
 * begun at the line qualifies and one begun anywhere else does not.
 */
const DELTA_ORIGIN_TOLERANCE = 8;

/**
 * A lap stored as elapsed-time versus distance-around-the-lap, which is the only form
 * that lets you subtract two laps driven at different speeds. 512 bins over 7 km is a
 * sample every 13.7 m — finer than the eye can read on a delta bar.
 */
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

  /** `fraction` is the position around the lap in [0,1), `elapsed` seconds since the line. */
  record(fraction, elapsed) {
    let index = Math.floor(clamp01(fraction) * this.bins);
    if (index >= this.bins) index = this.bins - 1;
    if (this._cursor < 0) {
      // Where this lap started being watched. A car dropped into the middle of the
      // circuit has no data for the part of the lap behind it, and back-filling that
      // stretch with the time it happens to be showing would invent a lap it never drove.
      this._origin = index;
      this.candidate[index] = elapsed;
      this._cursor = index;
      return;
    }
    if (index <= this._cursor) return;
    // Fill every bin skipped since the last sample so a fast straight leaves no holes.
    for (let i = this._cursor + 1; i <= index; i++) this.candidate[i] = elapsed;
    this._cursor = index;
  }

  /** Promote the lap just finished to the reference if it beat the stored one. */
  commit(lapTime) {
    if (!(lapTime > 0) || lapTime >= this.referenceTime) return false;
    // Only a lap watched from the line describes the whole circuit.
    if (this._origin < 0 || this._origin > DELTA_ORIGIN_TOLERANCE) return false;
    for (let i = this._cursor + 1; i < this.bins; i++) this.candidate[i] = lapTime;
    this.reference.set(this.candidate);
    this.referenceTime = lapTime;
    this.hasReference = true;
    return true;
  }

  /**
   * Install a reference lap built from sector splits rather than from driving one.
   *
   * A session dressed into a mid-race state has no lap behind it, so the delta bar has
   * nothing to read against and sits blank. A straight line from the line to the flag
   * would be worse than blank — it reports several seconds of phantom delta at every
   * sector boundary. Piecewise-linear through the splits is exact at each timing line
   * and within a tenth between them, which is inside the width of the bar.
   *
   * @param {ArrayLike<number>} bounds  normalised lap positions of the timing lines,
   *                                    ascending, `bounds[0] === 0`
   * @param {ArrayLike<number>} splits  sector times, one per bound
   * @param {number} count              number of sectors
   */
  seed(bounds, splits, count) {
    let lap = 0;
    for (let i = 0; i < count; i++) {
      if (!(splits[i] > 0)) return false;
      lap += splits[i];
    }

    let segment = 0;
    let elapsed = 0;             // reference time at bounds[segment]
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

  /** Reference elapsed time at a lap fraction, or NaN before a reference exists. */
  lookup(fraction) {
    if (!this.hasReference) return NaN;
    const f = clamp01(fraction) * (this.bins - 1);
    const i = Math.floor(f);
    const j = i + 1 < this.bins ? i + 1 : this.bins - 1;
    const u = f - i;
    return this.reference[i] + (this.reference[j] - this.reference[i]) * u;
  }
}

/**
 * One car's lap and sector state.
 *
 * Progress is only ever accepted one sector at a time and only in the forward direction.
 * That single rule is what makes the lap counter uncheatable: rejoining the circuit
 * past a sector line, spinning back over a line, or cutting from sector 0 into sector 2
 * all fail the `expected` test and leave the counter where it was.
 */
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

  /**
   * @param {number} time    session clock at the reset
   * @param {number} sector  sector the car is standing in
   * @param {boolean} timed  true when the next line crossing should produce a lap time
   *                         (a race start from the grid); false for an out-lap.
   */
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

  /**
   * Install a history the car has not driven: the mechanism a capture scenario uses to
   * drop the field into the middle of a race, and the one the grid uses to carry the
   * qualifying result into the pre-race tower.
   *
   * Everything a lived lap would have written is written here — clocks included, so
   * `currentLapTime` reports a plausible elapsed time immediately — and `started` is
   * left under the caller's control because the grid sits *behind* the line: its next
   * crossing opens lap 1 rather than closing lap 0.
   *
   * @param {object} spec
   * @param {number} spec.now             session clock at the seed
   * @param {number} spec.lap             laps already completed
   * @param {number} [spec.crossings]     start-line crossings, if not equal to `lap`
   * @param {number} spec.sector          sector the car is standing in
   * @param {boolean} [spec.started]      does the next line crossing produce a lap time
   * @param {number} [spec.lapElapsed]    seconds since this car crossed the line
   * @param {number} [spec.sectorElapsed] seconds since it crossed the last sector line
   * @param {number} [spec.bestLap]
   * @param {number} [spec.lastLap]
   * @param {ArrayLike<number>} [spec.bestSectors]
   * @param {ArrayLike<number>} [spec.lastSectors]
   * @param {ArrayLike<number>} [spec.currentSectors] splits set so far on the lap in
   *                                     progress; only those before `sector` are kept.
   * @param {ArrayLike<number>} [spec.bounds] sector-line positions, for the delta reference
   */
  seed(spec) {
    const now = spec.now ?? 0;
    const sector = clamp(spec.sector | 0, 0, SECTOR_COUNT - 1);
    this.lap = Math.max(0, spec.lap | 0);
    this.crossings = Math.max(0, spec.crossings ?? (spec.lap | 0));
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
      // Only sectors the car has already driven through on this lap have a split.
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

  /** Elapsed time on the lap in progress. */
  currentLapTime(time) {
    return time - this.lapStart;
  }

  /**
   * Feed the sector the car is currently in. Returns ADVANCE_NONE, ADVANCE_SECTOR or
   * ADVANCE_LAP; on a non-zero return `lastSectorIndex` and `lastSectorTime` describe
   * the split that was just closed.
   */
  advance(sector, time) {
    if (sector === this.sector) return ADVANCE_NONE;
    const expected = (this.sector + 1) % SECTOR_COUNT;
    if (sector !== expected) return ADVANCE_NONE;

    const completed = this.sector;
    // Before the first line crossing the car is on an out-lap: its splits are partial
    // and would poison the session bests, so they are stepped through, not recorded.
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

    // Every crossing counts as progress, even the untimed one that releases a car from
    // the grid. `lap` is the lap *counter* and must not move for that one; `crossings`
    // is how far round the circuit the car has got, and if it did not move the car's
    // race distance would fall by a full lap the instant it took the start.
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

  /** Kill the lap in progress without counting a warning (pit lane, off-course reset). */
  invalidate() {
    this.valid = false;
  }

  /**
   * One track-limits warning. Returns true when this was the strike that deletes the
   * lap, which is the moment the HUD announces and the stewards' counter resets.
   */
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

  /** Sum of the car's own best sectors — the lap it has shown it can do. */
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

/**
 * Session-wide bests. Submit first, then classify: a time that has just taken the
 * session best compares equal to it and therefore reads purple.
 */
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

  /** The ideal lap of the session: every car's best sector added together. */
  theoretical() {
    let sum = 0;
    for (let i = 0; i < SECTOR_COUNT; i++) {
      if (!Number.isFinite(this.bestSectors[i])) return Infinity;
      sum += this.bestSectors[i];
    }
    return sum;
  }
}

/**
 * A ring of (total distance travelled, session time) samples.
 *
 * A gap in seconds is not a distance divided by a speed — it is "how long ago was the
 * car ahead standing where I am now". With a few seconds of history that question can
 * be answered exactly, which is why the tower reads steady through a corner instead of
 * ballooning every time the leader brakes.
 */
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

  /**
   * Fill the ring with a constant-speed run ending at (`distance`, `time`).
   *
   * A car that has just been placed into a scenario has no past, so every gap measured
   * against it would fall back to an estimate for the first few seconds. Handing the
   * interpolator the run it would have made gets honest gaps on the very first frame,
   * which is the only frame a screenshot ever sees.
   */
  seed(distance, time, speed, span) {
    this.clear();
    const covered = Math.max(0, speed) * Math.max(0, span);
    if (!(covered > 1)) {
      this.push(distance, time);
      return;
    }
    // One sample per metre, capped: closer than that and push() would coalesce them.
    const steps = Math.min(this.capacity - 1, Math.max(2, Math.round(covered)));
    const step = span / steps;
    for (let i = steps; i >= 0; i--) {
      this.push(distance - speed * step * i, time - step * i);
    }
  }

  /** Samples must arrive with non-decreasing distance; stationary cars are skipped. */
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

  /** Session time at which this car passed `distance`, or NaN if outside the history. */
  timeAt(distance) {
    if (this.count < 2) return NaN;
    const first = this.distance[this._at(0)];
    const last = this.distance[this._at(this.count - 1)];
    if (distance < first || distance > last) return NaN;

    let lo = 0;
    let hi = this.count - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
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

  /** Distance covered over the last `seconds`, used as a speed reference for fallbacks. */
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

/**
 * Fractional sector *lengths* from the normalised sector-line positions. The fallback
 * shape for a pace model when nothing better is available: sector times are not
 * proportional to sector length, but they are the right order of magnitude and they sum
 * to one, which is all a seeded session needs.
 */
export function sectorLengthShares(bounds, out) {
  let total = 0;
  for (let i = 0; i < SECTOR_COUNT; i++) {
    const start = bounds?.[i] ?? i / SECTOR_COUNT;
    const end = i + 1 < SECTOR_COUNT ? (bounds?.[i + 1] ?? (i + 1) / SECTOR_COUNT) : 1;
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

/**
 * Split a lap time into sector times using `shares`, optionally scattering them by
 * `jitter` of their own length. The scatter is what stops a seeded field from handing
 * every purple sector to one car: two drivers on the same lap time are rarely quick in
 * the same places. The splits are renormalised afterwards, so they still add up to the
 * lap time they came from.
 */
export function splitLap(lapTime, shares, out, rng = null, jitter = 0) {
  let total = 0;
  for (let i = 0; i < SECTOR_COUNT; i++) {
    const weight = shares[i] * (rng && jitter > 0 ? 1 + rng.signed(jitter) : 1);
    out[i] = weight > 0 ? weight : shares[i];
    total += out[i];
  }
  for (let i = 0; i < SECTOR_COUNT; i++) out[i] = (out[i] / total) * lapTime;
  return out;
}

/**
 * Fraction of a lap *time* elapsed at normalised lap position `t`, given the sector-line
 * positions and the time share of each sector. Linear inside a sector, exact at every
 * line — the inverse of the mapping `DeltaTrace.seed` builds.
 */
export function lapTimeFraction(t, bounds, shares) {
  const u = clamp01(t);
  let elapsed = 0;
  for (let i = 0; i < SECTOR_COUNT; i++) {
    const start = bounds?.[i] ?? i / SECTOR_COUNT;
    const end = i + 1 < SECTOR_COUNT ? (bounds?.[i + 1] ?? (i + 1) / SECTOR_COUNT) : 1;
    if (u >= end && i + 1 < SECTOR_COUNT) {
      elapsed += shares[i];
      continue;
    }
    const span = end - start;
    return elapsed + shares[i] * (span > 1e-6 ? clamp01((u - start) / span) : 0);
  }
  return elapsed;
}
