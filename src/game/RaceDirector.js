import { clamp, deltaT } from '../core/MathUtils.js';
import { Rng } from '../core/Rng.js';
import {
  CarTiming, SessionBests, ProgressHistory,
  ADVANCE_NONE, ADVANCE_LAP, SECTOR_COUNT,
  COLOUR_WHITE,
  sectorLengthShares, splitLap, lapTimeFraction,
} from './Timing.js';
import { applyScenario as buildScenario, resolveCars, physicsOf } from './Scenarios.js';

/**
 * Race control: session state, the start procedure, lap and sector timing, live gaps,
 * flags, DRS entitlement and track limits.
 *
 * Lap counting is done by watching the car step through sector 1, sector 2, sector 3
 * and back to sector 1 in that order. Nothing else counts a lap — not the position of
 * the car, not a trigger volume on the line — so cutting the circuit, rejoining past a
 * timing loop or spinning back across the line cannot manufacture a lap.
 */

const SESSION_TYPES = {
  practice: { duration: 3600, laps: 0, lights: false, formation: false, name: 'Practice' },
  qualifying: { duration: 1080, laps: 0, lights: false, formation: false, name: 'Qualifying' },
  race: { duration: 0, laps: 44, lights: true, formation: false, name: 'Race' },
};

const LIGHT_COUNT = 5;
const LIGHT_INTERVAL = 1.0;      // one red light per second, as the FIA gantry does
const LIGHT_LEAD_IN = 2.0;       // dark gantry before the first light
const HOLD_MIN = 0.2;            // the delay the starter chooses before they go out
const HOLD_MAX = 3.0;
const GRID_SETTLE = 3.0;         // seconds on the grid before the sequence begins

/**
 * The CG has to be this far past the white line before all four wheels are beyond it.
 * The car is 2.0 m wide, so half a track width plus 0.85 m puts the inside pair of
 * wheels on the far side of the paint — the actual regulation test.
 */
const TRACK_LIMIT_MARGIN = 0.85;
const TRACK_LIMIT_MIN_SPEED = 12;
const TRACK_LIMIT_REARM = 0.15;  // metres back inside the line before another warning

const JUMP_START_SPEED = 0.45;
const JUMP_START_DISTANCE = 0.35;
const JUMP_START_PENALTY = 5.0;

const BLUE_FLAG_SECONDS = 1.9;
const YELLOW_SECONDS = 8.0;
const INCIDENT_IMPULSE = 5200;
const STOPPED_SPEED = 7.0;
const STOPPED_SECONDS = 1.5;

const DRS_WINDOW = 1.0;
const DRS_ENABLE_LAP = 2;        // completed laps before DRS is armed: live from lap 3
const DRS_MAX_RAIN = 0.15;

const HISTORY_INTERVAL = 1 / 20;
const GAP_INTERVAL = 1 / 10;

/** Seconds of progress history a seeded car is given, so gaps read true on frame one. */
const HISTORY_SPAN = 6;

/**
 * A gap in seconds is a distance divided by the speed that distance is covered at. Below
 * walking pace there is no such speed and no honest answer, so the gap is NaN and the
 * tower shows a dash — twenty stationary cars all reading "+0.533" is the failure this
 * guards against.
 */
const GAP_MIN_SPEED = 1.0;
const GAP_SPEED_WINDOW = 1.5;    // seconds of history averaged into that speed

// --- session seeding ---------------------------------------------------------------
//
// A race does not begin from nothing: the field qualified, and the grid it forms up on
// is that result. These numbers generate it deterministically from driver skill so the
// starting order, the grid intervals and the pre-race sector colours all describe one
// coherent session instead of being invented separately.

/** Mean lap speed of a pole lap. 66 m/s is ~1:46 around Spa's 7 km. */
const REFERENCE_LAP_SPEED = 66;
/** Seconds of lap time per unit of driver skill: the 0.16 skill spread becomes ~2.6 s. */
const SKILL_SPREAD = 16;
/** Scatter on top of skill, so the order is not a strict ranking of the skill column. */
const QUALI_NOISE = 0.14;
/** A race-trim lap over a qualifying lap: fuel load, engine mode, tyre management. */
const RACE_FUEL_PENALTY = 2.6;
const RACE_LAP_NOISE = 0.45;
/**
 * How much of its own length a sector is stretched or shortened by the driver in it.
 * Drawn once per driver, not once per lap: a driver who is strong through the middle
 * sector is strong there on every lap of the afternoon, and that is what makes one car
 * genuinely own a purple sector instead of the colour hopping around the field.
 */
const SPLIT_JITTER = 0.02;
/** Lap-to-lap wobble on top of that shape — the same driver, a slightly different lap. */
const SPLIT_LAP_JITTER = 0.006;

/**
 * Grid slot the player starts from. Mirrors `PLAYER_GRID_SLOT` in CarManager.spawnOnGrid:
 * the player is put a couple of rows back so rivals are in shot, and the classification
 * has to agree with the cars that are actually standing on the tarmac.
 */
const PLAYER_GRID_SLOT = 3;

/** Cornering model used to shape the sector split of a seeded lap. */
const PACE_LATERAL_ACCEL = 42;   // m/s^2 — about 4.3 g, an F1 car through a long corner
const PACE_TOP_SPEED = 88;       // m/s
const PACE_MIN_SPEED = 14;       // m/s — the slowest hairpin
const PACE_SAMPLES = 720;

/** Laps already run when a scenario drops the field onto the circuit. */
const SHOT_LAP = 11;

/**
 * Mean fuel flow over a racing lap, as a fraction of the 100 kg/h regulation ceiling.
 *
 * A scenario teleports the field onto a circuit and tells the tower it is lap twelve,
 * but every car's tank is untouched because no car has burned a gram: the cluster read
 * 104.0 kg on the grid and 103.9 kg on lap thirteen. The tank has to be wound forward
 * to match the lap the shot claims, and the only defensible number to wind it by is the
 * one this simulator's own power unit produces.
 *
 * Powertrain.step meters fuel off shaft power — flow = P / (thermalEfficiency * LHV),
 * clamped at fuelFlowMax — so the burn over a lap is the flow ceiling times the fraction
 * of the lap spent against it. That fraction is measured, not guessed: three consecutive
 * AI race laps of Spa burned 1.753, 1.851 and 1.831 kg over lap times of 113.52, 113.38
 * and 113.85 s, a mean 0.01596 kg/s against the 0.02778 kg/s ceiling. Seeding at that
 * rate puts a car eleven laps into a grand prix on 84 kg, and the readout then keeps
 * falling at the rate the power unit is actually metering.
 */
const FUEL_FLOW_DUTY = 0.5745;

/** Kilograms the FIA sample leaves in the cell — a seeded tank never reads empty. */
const FUEL_RESERVE = 1.0;

// --- field spread --------------------------------------------------------------------
//
// The intervals a scenario strings the field out with are not chosen — they are what is
// left over when the field has raced. Lap times differ by a second or so, cars catch each
// other, and a car that catches one it cannot pass stays there for the rest of the stint.
// So a grand prix at lap twelve is three or four trains of cars a couple of tenths apart
// with clear air between them, and never an even fan. Running the laps is the only way to
// produce that shape; it costs a couple of hundred lap times, once per session.

/** Cost of a standing start to each row behind the one in front of it. */
const FIELD_ROW_LOSS = 0.22;
/** One-sigma lap-to-lap variation on a driver's race pace: traffic, tyres, a moment. */
const FIELD_LAP_SCATTER = 0.32;
/** Chance per car-lap of a real mistake — a lock-up, a run through the gravel trap. */
const FIELD_MISTAKE_RATE = 0.05;
const FIELD_MISTAKE_MIN = 0.9;
const FIELD_MISTAKE_MAX = 4.5;
/** Nobody finds this much on their own pace in one lap, however the dice fall. */
const FIELD_LAP_FLOOR = 0.985;
/** Closest a car can run to the gearbox of the one ahead. */
const FIELD_MIN_INTERVAL = 0.14;
/** How far back dirty air pins a following car that cannot find a way past. */
const FIELD_HOLD_INTERVAL = 0.62;
/** Chance per lap that a car quicker than the one blocking it actually gets by. */
const FIELD_PASS_CHANCE = 0.22;

export class RaceDirector {
  static systemName = 'race';

  constructor() {
    this.standings = [];
    this.session = {
      type: 'race',
      name: 'Race',
      state: 'idle',
      flag: 'green',
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
      sectorFlags: ['green', 'green', 'green'],
      bestLap: Infinity,
      bestLapDriver: '',
      leader: 0,
      finished: false,
    };

    this.bests = new SessionBests();
    this._cars = [];
    this._order = [];
    this._grid = [];
    this._rail = null;
    this._ready = false;
    this._seed = 20260827;
    this.rng = new Rng(this._seed);
    // A stream of its own: the grid must not shift because the starter chose a different
    // hold time, and a scenario must not shift because the grid was built first.
    this._sessionRng = new Rng(this._seed ^ 0x1f83d9ab);
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
    this._seed = (ctx.settings?.get?.('seed') ?? 20260827) >>> 0;
    this.rng.seed(this._seed ^ 0x5a17c0de);
    this._sessionRng.seed(this._seed ^ 0x1f83d9ab);
    this._sharesReady = false;
    this._qualiReady = false;
    this._paceReady = false;
    this._spread = null;

    const params = new URLSearchParams(globalThis.location?.search ?? '');
    const requested = params.get('session');
    const type = SESSION_TYPES[requested] ? requested : 'race';
    const laps = Number(params.get('laps'));
    const formation = params.get('formation') === '1';

    this._loc = this.track?.surface?.createLocateResult?.() ?? null;

    this._onCollision = (payload) => this._onIncident(payload);
    this.events?.on('car:collision', this._onCollision);

    this.setSession(type, {
      totalLaps: Number.isFinite(laps) && laps > 0 ? Math.round(laps) : undefined,
      formationLap: formation,
    });
  }

  // --- session control ----------------------------------------------------------

  setSession(type, options = {}) {
    const spec = SESSION_TYPES[type] ?? SESSION_TYPES.race;
    const s = this.session;
    s.type = SESSION_TYPES[type] ? type : 'race';
    s.name = spec.name;
    s.duration = options.duration ?? spec.duration;
    s.totalLaps = options.totalLaps ?? spec.laps;
    s.formationLap = options.formationLap ?? spec.formation;
    s.timeElapsed = 0;
    s.timeRemaining = s.duration;
    s.lap = 1;
    s.flag = 'green';
    s.lights = 0;
    s.lightsOut = !spec.lights;
    s.lightsFrozen = false;
    s.drsEnabled = s.type !== 'race';
    s.finished = false;
    s.leader = 0;
    s.bestLap = Infinity;
    s.bestLapDriver = '';
    this.bests.reset();
    this._finishEmitted = false;
    this._lightTimer = 0;
    this._stateTimer = 0;
    for (let i = 0; i < SECTOR_COUNT; i++) this._yellow[i] = 0;

    this._bind(this.ctx);

    if (!spec.lights) {
      s.state = 'racing';
      this._resync(false);
      this._emitStart();
      return;
    }

    this._placeOnGrid();
    s.state = s.formationLap ? 'formation' : 'grid';
    // The formation lap counts as a lap so that one crossing ends it; the standing
    // start does not, because the grid is behind the line.
    this._resync(s.formationLap);
    if (!s.formationLap) this._seedGridClassification();
  }

  /** Restart the current session type from the top. */
  restart() {
    this.setSession(this.session.type, {
      totalLaps: this.session.totalLaps,
      duration: this.session.duration,
      formationLap: this.session.formationLap,
    });
  }

  _emitStart() {
    this.events?.emit('race:start', {
      type: this.session.type,
      totalLaps: this.session.totalLaps,
      time: this.session.timeElapsed,
    });
  }

  // --- binding ------------------------------------------------------------------

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
        // Seeded-session state: the qualifying result this car brought to the grid, the
        // slot that puts it on, and the scratch splits its classification is written from.
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
        flag: 'green',
        retired: false,
        entry: {
          car,
          index: i,
          driver,
          name: driver?.name ?? `Car ${i + 1}`,
          code: driver?.code ?? '',
          number: driver?.number ?? i + 1,
          team: driver?.team?.name ?? car.team?.name ?? '',
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
          flag: 'green',
          penalty: 0,
          strikes: 0,
          retired: false,
          lapsDown: 0,
        },
      };
      this._cars.push(record);
      this._order.push(record);
      this.standings.push(record.entry);
    }

    // Some Track implementations do not publish the result factories; borrow a result
    // object from the query itself rather than allocating one every tick.
    if (!this._loc && this._cars.length > 0) {
      this._loc = this.track.locate(this._cars[0].physics.state.position);
    }

    this._ready = this._cars.length > 0;
    return this._ready;
  }

  // --- the session the race starts from -------------------------------------------

  /**
   * Time share of each sector, measured off the circuit rather than assumed.
   *
   * Walking the centreline and capping speed at what the local curvature allows gives
   * the shape of a lap: where the time goes. It ignores braking and traction limits, so
   * it is optimistic in absolute terms — which is why only the *ratios* are used, with
   * the absolute lap time coming from REFERENCE_LAP_SPEED.
   */
  _sectorShares() {
    if (this._sharesReady) return this._shares;
    const track = this.track;
    const out = this._shares;
    this._sharesReady = true;

    if (!track || !this._loc || typeof track.sample !== 'function') {
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

  /**
   * Build the qualifying result the grid is formed from: one lap time per driver, from
   * their skill plus a little scatter, sorted into a starting order.
   *
   * The player is slotted into PLAYER_GRID_SLOT by giving them a time that falls between
   * the two rivals either side of it, so the order, the times and the grid intervals all
   * stay consistent with each other — and with where CarManager parked their car.
   */
  _buildQualifying() {
    if (this._qualiReady) return this._grid.length > 0;
    const cars = this._cars;
    if (cars.length === 0 || !this.track) return false;

    const rng = this._sessionRng.seed(this._seed ^ 0x2545f491);
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
      // Anywhere inside that interval except the middle of it: splitting it exactly in
      // half prints the same delta twice in the tower — once against the car ahead of
      // the player and once against the player — which is the one arrangement of
      // qualifying times a real session never produces.
      const span = Math.max(behind - ahead, 0.04);
      cars[0].qualiTime = ahead + span * rng.range(0.22, 0.78);
      this._grid.splice(slot, 0, cars[0]);
    }

    for (let k = 0; k < this._grid.length; k++) this._grid[k].gridSlot = k;
    this._qualiReady = true;
    return true;
  }

  /**
   * Race pace: one lap time per driver for the stint they are in, and the shape of the
   * lap they drive it with. Built once per session, so the classification a scenario
   * seeds, the sector colours it prints and the intervals it places the field at all
   * describe the same twenty drivers.
   */
  _buildRacePace() {
    if (this._paceReady) return true;
    if (!this._buildQualifying()) return false;
    const cars = this._cars;
    const rng = this._sessionRng.seed(this._seed ^ 0x85ebca6b);
    for (let i = 0; i < cars.length; i++) {
      const rec = cars[i];
      rec.pace = rec.qualiTime + RACE_FUEL_PENALTY + Math.abs(rng.gaussian()) * RACE_LAP_NOISE;
      for (let s = 0; s < SECTOR_COUNT; s++) rec.sectorBias[s] = 1 + rng.signed(SPLIT_JITTER);
    }
    this._paceReady = true;
    return true;
  }

  /**
   * Sector splits of a lap of `lapTime` driven by this particular driver: the circuit's
   * own time shares, bent by the shape that driver's laps have.
   */
  _shapedSplits(rec, lapTime, out, rng = null, jitter = 0) {
    const shares = this._sectorShares();
    const shaped = this._shapedShares;
    for (let i = 0; i < SECTOR_COUNT; i++) shaped[i] = shares[i] * rec.sectorBias[i];
    return splitLap(lapTime, shaped, out, rng, jitter);
  }

  /**
   * Race SHOT_LAP laps on the field's own pace and keep the intervals it ends up with:
   * `spread[k]` is the seconds between classified position k and the car ahead of it,
   * with `spread[0]` zero for the leader.
   *
   * Two rules do all the work. Lap times scatter, so the order changes and nobody stays
   * a fixed distance from anybody. And a car that arrives within a couple of tenths of
   * the one ahead is stuck there unless it gets by — which is why the result is lumpy:
   * trains of cars a tenth or two apart, separated by whatever clear air opened up
   * before the train formed.
   */
  _buildFieldSpread() {
    if (this._spread) return this._spread;
    if (!this._buildRacePace()) return null;
    const n = this._cars.length;
    if (n < 2) return null;

    const time = new Float64Array(n);
    const pace = new Float64Array(n);
    const spread = new Float64Array(n);
    const rng = this._sessionRng.seed(this._seed ^ 0xc2b2ae35);

    // The race starts from the grid, and a standing start alone costs the back of it
    // several seconds before anyone has driven a corner.
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

      // Re-classify: insertion sort over a nearly sorted list, carrying each car's pace
      // with its time so position k keeps describing one driver.
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
        // A quicker car that has caught this one sometimes finds a way past; the two
        // are within a couple of tenths of each other, so the pass is a swap of who is
        // in front and the loser drops into the dirty air behind.
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

  /**
   * Intervals for the tail of a scenario's field — the cars the composition does not
   * place by hand. `out[j]` is the seconds from classified position `first + j - 1` to
   * position `first + j`, so `out[0]` is the gap from the last composed car back to the
   * first of the tail. Returns how many were written.
   *
   * @see Scenarios.placeRunning, which converts them to metres of road.
   */
  fieldIntervals(first, count, out) {
    const spread = this._buildFieldSpread();
    if (!spread || count <= 0 || !out) return 0;
    const n = spread.length;
    const usable = Math.min(count, out.length);
    for (let j = 0; j < usable; j++) {
      const k = first + j;
      // A composition wider than the field the sim ran wraps back into the tail of it
      // rather than running off the end of the array.
      out[j] = spread[k < n ? Math.max(1, k) : 1 + ((k - 1) % (n - 1))];
    }
    return usable;
  }

  /** Grid slot (0 = pole) for a car index. @see Scenarios.placeGrid */
  gridSlotFor(carIndex) {
    if (!this._buildQualifying()) return carIndex;
    for (let i = 0; i < this._cars.length; i++) {
      if (this._cars[i].index === carIndex) return this._cars[i].gridSlot;
    }
    return carIndex;
  }

  /** Snap every car onto its grid slot, stationary and facing down the road. */
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

  /**
   * Carry the qualifying result into the pre-race classification: the grid order, the
   * intervals the field lined up with, and each driver's own sector splits from the lap
   * that put them there. This is what a broadcast tower shows while the lights come on.
   */
  _seedGridClassification() {
    if (!this._buildQualifying()) return;
    this._buildRacePace();
    const grid = this._grid;
    const bounds = this.track.sectors;
    const now = this.session.timeElapsed;
    const rng = this._sessionRng.seed(this._seed ^ 0x9e3779b9);

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
        // The grid is behind the line: the crossing to come opens lap 1, it closes nothing.
        started: false,
        bestLap: rec.qualiTime,
        lastLap: rec.qualiTime,
        bestSectors: rec.showSplits,
        lastSectors: rec.showSplits,
        bounds,
      });
      rec.entry.lapColour = this.bests.classifyLap(rec.qualiTime, rec.qualiTime);
      this._writeSectorEntry(rec, rec.showSplits);
      this._writeCarFields(rec);
      rec.history.clear();
    }

    this.session.bestLap = this.bests.bestLap;
    this.session.bestLapDriver = grid[0]?.entry.name ?? '';
    this._gapTimer = GAP_INTERVAL;
    this._updateOrder(0);
  }

  /**
   * Lights out: the qualifying times stop being the session's reference. Keeping them
   * would paint every race lap yellow for the rest of the afternoon, because no car on
   * a full tank beats its own qualifying lap.
   */
  _startRaceTiming() {
    this.bests.reset();
    this.session.bestLap = Infinity;
    this.session.bestLapDriver = '';
    for (let i = 0; i < this._cars.length; i++) {
      const rec = this._cars[i];
      rec.entry.lapColour = COLOUR_WHITE;
      for (let s = 0; s < SECTOR_COUNT; s++) {
        rec.entry.sectors[s] = 0;
        rec.entry.sectorColours[s] = COLOUR_WHITE;
      }
    }
  }

  /**
   * Dress the field as a race in progress for a capture.
   *
   * `plan` carries, per car, the centreline distance Scenarios placed it at. That is the
   * only way to know which lap each car is on: a rival authored 200 m up the road from a
   * player sitting 100 m short of the line has crossed it, and without that the tower
   * would classify the car leading the shot dead last.
   */
  _seedRunningClassification(plan, railSpeed) {
    if (!this._buildQualifying()) return;
    this._buildRacePace();
    const track = this.track;
    const cars = this._cars;
    const L = track.length;
    const shares = this._sectorShares();
    const bounds = track.sectors;
    const now = this.session.timeElapsed;
    const rng = this._sessionRng.seed(this._seed ^ 0x27d4eb2f);

    const player = cars[0];
    const base = this._authoredDistance(plan, player.index, player.distance);
    const playerTotal = SHOT_LAP * L + player.distance;

    this.bests.reset();
    for (let i = 0; i < cars.length; i++) {
      const rec = cars[i];
      const authored = this._authoredDistance(plan, rec.index, rec.distance);
      // Whole laps only: the difference between where this car was authored and where
      // the player was is a distance on the road, and the rest is the lap counter.
      rec.seedLap = Math.max(0, Math.round((playerTotal + (authored - base) - rec.distance) / L));

      const best = rec.pace - rng.range(0.05, 0.55);
      // The splits on show are the splits of the lap on show, so the lap the tower
      // prints and the three sectors under it add up. Nobody's last lap beats their own
      // best either — that pair disagreeing is what paints a slower lap green.
      const last = Math.max(best, rec.pace + rng.gaussian() * RACE_LAP_NOISE);
      this._shapedSplits(rec, best, this._bestSplits);
      this._shapedSplits(rec, last, rec.showSplits, rng, SPLIT_LAP_JITTER);
      // A split that beat the driver's own best is their best: the two have to agree or
      // the tower colours a sector green that is slower than the one it is compared to.
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
        bounds,
      });

      this.bests.submitLap(rec.index, best, rec.seedLap);
      for (let s = 0; s < SECTOR_COUNT; s++) this.bests.submitSector(s, rec.index, this._bestSplits[s]);

      rec.totalDistance = rec.seedLap * L + rec.distance;
      this._seedFuel(rec, rec.seedLap + fraction);
      const speed = Number.isFinite(railSpeed) && railSpeed > 0
        ? railSpeed
        : Math.abs(rec.physics.state.speed);
      rec.history.seed(rec.totalDistance, now, speed, HISTORY_SPAN);
      rec.drsArmed = true;
    }

    // Colours only once every time is in: a session best is not known until then.
    for (let i = 0; i < cars.length; i++) {
      const rec = cars[i];
      this._writeSectorEntry(rec, rec.showSplits, rec.sector);
      rec.entry.lapColour = this.bests.classifyLap(rec.timing.lastLap, rec.timing.bestLap);
      this._writeCarFields(rec);
    }

    this.session.bestLap = this.bests.bestLap;
    const holder = this._carByIndex(this.bests.bestLapCar);
    this.session.bestLapDriver = holder?.entry.name ?? '';
    this._gapTimer = GAP_INTERVAL;
    this._updateOrder(0);
  }

  /**
   * Wind a car's tank forward to the lap the shot is pretending to be on.
   *
   * `laps` is fractional — a car eight tenths of the way round lap twelve has burned
   * eight tenths of a lap more than one on the line — so the readout moves through a
   * capture instead of stepping once a lap. The rate is this power unit's own: the
   * regulation flow ceiling at the duty cycle a racing lap actually runs, times the
   * pace the director has already worked out for this driver. Nothing here changes the
   * car's mass (VehiclePhysics carries a fixed race weight), so the seed is a readout,
   * not a handicap.
   */
  _seedFuel(rec, laps) {
    const pt = rec.physics?.powertrain;
    if (!pt) return;
    const eng = pt.eng ?? rec.physics.config?.engine;
    if (!eng) return;
    const pace = Number.isFinite(rec.pace) && rec.pace > 0
      ? rec.pace
      : this.track.length / REFERENCE_LAP_SPEED;
    const perLap = pace * eng.fuelFlowMax * FUEL_FLOW_DUTY;
    // A car never crosses the line dry: a real stint keeps a sample's worth in the cell.
    pt.fuel = clamp(eng.startFuel - Math.max(0, laps) * perLap, FUEL_RESERVE, eng.startFuel);
    pt.fuelRate = 0;
    rec.physics.state.fuel = pt.fuel;
  }

  /** Centreline distance Scenarios placed `carIndex` at, or `fallback` when unplanned. */
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

  /**
   * Publish sector splits and their colours. `upTo` limits `splits` to the sectors a car
   * has actually driven through on the lap in progress; the sectors beyond it fall back
   * to the last lap the car completed, which is exactly what the tower shows during a
   * live race — a split stands until the next lap overwrites it — and stops a shot taken
   * early in a lap from printing a column of blanks for the whole field.
   */
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

  /**
   * Re-read every car's position and restart its timing there. Called whenever cars are
   * teleported — a session change, a grid placement, a scenario — so that the first
   * tick after the move cannot be mistaken for a lap.
   */
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
      // A gap measured before the move describes a race that no longer exists.
      rec.gap = NaN;
      rec.gapLeader = NaN;
      rec.lapsDown = 0;
      rec.delta = NaN;
      rec.drsArmed = this.session.type !== 'race';
      rec.timing.reset(now, rec.sector, timed);
      rec.history.clear();
      this._writeCarFields(rec);
    }
  }

  // --- frame --------------------------------------------------------------------

  update(dt, ctx) {
    if (!this._ready) {
      if (!this._bind(ctx)) return;
      // The field arrived after init, so the session was set up against an empty grid.
      // Run it again now that there are cars to put on it.
      this.restart();
    }

    // The capture rail authors the pose, so it runs before anything reads a position.
    this._rail?.update(dt);

    const s = this.session;
    if (s.state !== 'idle') s.timeElapsed += dt;

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
      case 'formation': {
        // The pace is advisory: AIDriver reads `paceLimit` while this state is live.
        this.paceLimit = 24;
        const leader = this._cars[0];
        if (leader && (leader.timing.lap >= 1 || this._stateTimer > 300)) {
          // Back onto the grid. Teleporting is the honest shortcut here: nothing in the
          // sim can reliably park twenty cars on their boxes, and the alternative is a
          // formation lap that ends in a pile-up.
          this._placeOnGrid();
          this._resync(false);
          this._seedGridClassification();
          s.state = 'grid';
          this._stateTimer = 0;
        }
        break;
      }
      case 'grid':
        this.paceLimit = 0;
        if (this._stateTimer >= GRID_SETTLE) {
          s.state = 'countdown';
          this._lightTimer = 0;
          this._holdTime = this.rng.range(HOLD_MIN, HOLD_MAX);
          this._stateTimer = 0;
        }
        break;
      case 'countdown':
        this._advanceLights(dt);
        break;
      case 'racing':
        this._checkFinish();
        break;
      default:
        break;
    }

    if (s.duration > 0 && s.state === 'racing') {
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
      s.state = 'racing';
      s.timeElapsed = 0;
      s.lap = 1;
      // The grid is behind the line: the crossing that follows starts lap 1, it does
      // not complete one, so the cars go out untimed.
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
        this.events?.emit('race:penalty', {
          car: rec.car,
          index: rec.index,
          reason: 'jump-start',
          seconds: JUMP_START_PENALTY,
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
    s.state = 'finished';
    s.flag = 'chequered';
    if (this._finishEmitted) return;
    this._finishEmitted = true;
    this.events?.emit('race:finish', {
      type: s.type,
      standings: this.standings,
      winner: this.standings[0] ?? null,
      time: s.timeElapsed,
    });
  }

  // --- per-car sampling ----------------------------------------------------------

  _sampleCars(dt) {
    const track = this.track;
    const s = this.session;
    const now = s.timeElapsed;
    const timing = s.state === 'racing' || s.state === 'formation' || s.state === 'finished';

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
        // A lap crossing closes the final sector as well, so both fire, in order.
        if (code !== ADVANCE_NONE) this._onSector(rec);
        if (code === ADVANCE_LAP) this._onLap(rec);
        this._policeTrackLimits(rec, state, this._loc);
      }
      rec.sector = rec.timing.sector;
      // Progress, not laps: `crossings` also counts the untimed crossing that releases
      // a car from the grid, so this never steps backwards over the start line.
      rec.totalDistance = rec.timing.crossings * track.length + rec.distance;

      // A delta is a comparison between two laps. A car still sitting on the grid has
      // not begun one, and subtracting a full reference lap from a clock reading zero
      // would report a hundred seconds in hand.
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

  /**
   * Track limits. `Track.locate().lateral` is the signed distance from the centreline,
   * so a car is beyond the white line when |lateral| exceeds the half-width by enough
   * that the inside wheels have crossed too. Three warnings delete the lap.
   */
  _policeTrackLimits(rec, state, loc) {
    const over = Math.abs(loc.lateral) - loc.width;
    if (over > TRACK_LIMIT_MARGIN) {
      if (!rec.offTrack && Math.abs(state.speed) > TRACK_LIMIT_MIN_SPEED) {
        rec.offTrack = true;
        const deleted = rec.timing.strike();
        this.events?.emit('race:limits', {
          car: rec.car,
          index: rec.index,
          strikes: rec.timing.strikes,
          deleted,
          lap: rec.timing.lap + 1,
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
    // `valid` has already been rearmed if this crossing also closed a lap, so the
    // validity of the sector itself is read from where advance() recorded it.
    const valid = timing.sectorValid[index] === 1;
    const sessionBest = valid && this.bests.submitSector(index, rec.index, time);
    rec.entry.sectors[index] = time;
    rec.entry.sectorColours[index] = valid
      ? this.bests.classifySector(index, time, timing.bestSectorTimes[index])
      : COLOUR_WHITE;

    this.events?.emit('race:sector', {
      car: rec.car,
      index: rec.index,
      sector: index,
      time,
      personalBest: timing.sectorPersonalBest,
      sessionBest,
      valid,
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

    this.events?.emit('race:lap', {
      car: rec.car,
      index: rec.index,
      lap: timing.lap,
      time,
      best: timing.bestLap,
      personalBest: timing.lapPersonalBest,
      sessionBest,
      valid,
      colour,
    });

    if (this.session.state === 'racing' && this.session.totalLaps > 0) this._checkFinish();
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

  // --- standings ------------------------------------------------------------------

  _updateOrder(dt) {
    const order = this._order;
    // Insertion sort: the order is nearly sorted every tick and the field is twenty
    // cars, so this beats a comparator sort and cannot allocate.
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
    // Gaps are published at 10 Hz because that is as fast as anyone can read them — but
    // an overtake has to take its gap with it. Two cars swapping while their intervals
    // are a tenth of a second stale is a tower that shows P14 closer to the leader than
    // P13, so a change of order forces the recompute.
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
    // Nobody is running to a clock on the grid, so the interval to publish there is the
    // one the field actually formed up with: the gaps from qualifying.
    const gridGaps = s.state === 'grid' || s.state === 'countdown';

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
          // The gap to the leader is the intervals in front of this car added up.
          // Measuring it directly means falling back to distance-over-speed for anyone
          // further back than the history ring reaches, and two cars converted through
          // two different speeds can come out in the wrong order — a tower where P14
          // reads closer to the leader than P13 while the interval column says the
          // opposite. Accumulating keeps the two columns describing one race, and each
          // interval is a short measurement between neighbours rather than one long
          // estimate across the whole field.
          const aheadLeader = order[k - 1].gapLeader;
          rec.gapLeader = Number.isFinite(aheadLeader) && Number.isFinite(rec.gap)
            ? aheadLeader + rec.gap
            : this._timeGap(leader, rec, now);
        }
        // Laps down is a classification fact, not a difference of lap counters: those
        // disagree by one for every car that has crossed the line and the leader has not.
        rec.lapsDown = leader
          ? Math.max(0, Math.floor((leader.totalDistance - rec.totalDistance) / lapLength))
          : 0;
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

      // Classification fields the car's own dash and the AI read.
      rec.car.racePosition = rec.position;
      rec.car.gapAhead = rec.gap;
      rec.car.gapLeader = rec.gapLeader;
    }
    this.standings.length = order.length;
  }

  /** Positive when `a` is ahead of `b` on the road, by laps then by distance. */
  _ranks(a, b) {
    if (a.retired !== b.retired) return a.retired ? -1 : 1;
    const d = a.totalDistance - b.totalDistance;
    return d > 0 ? 1 : d < 0 ? -1 : 0;
  }

  /**
   * Seconds between two cars: how long ago the car ahead stood where this one is now.
   * That is the definition a timing screen uses, and unlike distance-over-speed it does
   * not balloon every time the leader brakes.
   *
   * When the history does not reach back far enough — the first seconds of a session, or
   * a gap wider than the ring holds — the distance is converted through the speed the
   * road between the two cars is being covered at. If there is no such speed, there is
   * no gap: NaN, and the tower prints a dash.
   */
  _timeGap(ahead, behind, now) {
    const distance = ahead.totalDistance - behind.totalDistance;
    if (!(distance > 0)) return 0;

    const passed = ahead.history.timeAt(behind.totalDistance);
    if (Number.isFinite(passed) && passed <= now) return Math.max(0, now - passed);

    const speed = this._gapSpeed(ahead, behind, now);
    if (!(speed > GAP_MIN_SPEED)) return NaN;
    return distance / speed;
  }

  /**
   * Speed to convert a distance gap through. The stretch of road between the two cars is
   * covered partly at the pace of each, so the mean of the two is the closest single
   * number to the truth; a stationary car contributes nothing and the other one answers
   * alone. History is preferred over the instantaneous reading because it is what the car
   * has averaged rather than what it happens to be doing in one corner.
   */
  _gapSpeed(ahead, behind, now) {
    let a = ahead.history.recentSpeed(now, GAP_SPEED_WINDOW);
    if (!(a > GAP_MIN_SPEED)) a = Math.abs(ahead.physics.state.speed);
    let b = behind.history.recentSpeed(now, GAP_SPEED_WINDOW);
    if (!(b > GAP_MIN_SPEED)) b = Math.abs(behind.physics.state.speed);
    if (a > GAP_MIN_SPEED && b > GAP_MIN_SPEED) return (a + b) * 0.5;
    return Math.max(a, b);
  }

  /** Grid interval: the difference between two qualifying laps. */
  _qualiGap(ahead, behind) {
    const gap = behind.qualiTime - ahead.qualiTime;
    return Number.isFinite(gap) ? Math.max(0, gap) : NaN;
  }

  // --- flags ----------------------------------------------------------------------

  _onIncident(payload) {
    if ((payload?.impulse ?? 0) < INCIDENT_IMPULSE) return;
    const rec = payload.index !== undefined ? this._cars[payload.index] : this._cars[0];
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
      s.sectorFlags[i] = this._yellow[i] > 0 ? 'yellow' : 'green';
    }

    const order = this._order;
    const lapLength = this.track.length;
    for (let k = 0; k < order.length; k++) {
      const rec = order[k];
      let flag = 'green';
      if (this._yellow[rec.sector] > 0) flag = 'yellow';

      // Blue: the car classified ahead is a lap up and is closing on the road behind.
      if (k > 0) {
        const lapper = order[k - 1];
        if (rec.lapsDown > lapper.lapsDown) {
          const behind = -deltaT(rec.t, lapper.t) * lapLength;
          const speed = Math.max(Math.abs(rec.physics.state.speed), 20);
          if (behind > 0 && behind < BLUE_FLAG_SECONDS * speed) flag = 'blue';
        }
      }
      rec.flag = flag;
      rec.entry.flag = flag;
      rec.car.flag = flag;
    }

    if (s.state === 'finished') s.flag = 'chequered';
    else if (anyYellow) s.flag = 'yellow';
    else if (s.state === 'grid' || s.state === 'countdown') s.flag = 'none';
    else s.flag = 'green';
  }

  // --- DRS -------------------------------------------------------------------------

  _updateDrs() {
    const track = this.track;
    const s = this.session;
    const rain = this.ctx?.sky?.weather?.rain ?? 0;
    const leaderLap = this._order[0]?.timing.lap ?? 0;

    s.drsEnabled = rain <= DRS_MAX_RAIN
      && s.flag !== 'yellow'
      && (s.type !== 'race' || (s.state === 'racing' && leaderLap >= DRS_ENABLE_LAP))
      && s.state !== 'grid' && s.state !== 'countdown' && s.state !== 'formation';

    for (let i = 0; i < this._cars.length; i++) {
      const rec = this._cars[i];
      const aero = rec.physics.aero;
      if (!aero?.setDrsZone) continue;

      if (s.type === 'race' && !this.ctx?.captureMode) {
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

  /** True when the car passed `mark` between the previous tick and this one. */
  _crossed(prev, cur, mark) {
    const before = deltaT(prev, mark);
    const after = deltaT(cur, mark);
    return before > 0 && after <= 0 && before < 0.02;
  }

  // --- capture -----------------------------------------------------------------------

  /** @see Scenarios.js — used by tools/screenshot.mjs to compose every review shot. */
  applyScenario(setup = {}) {
    if (!this._ready) this._bind(this.ctx);
    this._rail?.clear();
    this._rail = buildScenario(this.ctx, this, setup);
    return this._rail;
  }

  /**
   * Grid shot: the gantry frozen with all five reds lit, field stationary, and the
   * tower showing the qualifying result the grid was formed from.
   */
  setupGridShot() {
    const s = this.session;
    s.state = 'countdown';
    s.lights = LIGHT_COUNT;
    s.lightsOut = false;
    s.lightsFrozen = true;
    s.flag = 'none';
    s.lap = 1;
    s.timeElapsed = 0;
    s.finished = false;
    this._lightTimer = 0;
    this._stateTimer = 0;
    this._resync(false);
    this._seedGridClassification();
  }

  /**
   * Any running shot: green flag, lights out, DRS live, and the field classified on the
   * lap Scenarios actually placed it on.
   *
   * @param {string} name     scenario name, for the record
   * @param {number} speed    the speed the rail is dragging the field at, m/s
   * @param {Array<{index:number,distance:number}>} [plan]  where each car was placed
   */
  setupRunningShot(name, speed, plan = null) {
    const s = this.session;
    s.state = 'racing';
    s.lights = 0;
    s.lightsOut = true;
    s.lightsFrozen = false;
    s.flag = 'green';
    s.timeElapsed = 0;
    s.finished = false;
    s.drsEnabled = true;
    this._finishEmitted = false;
    this._stateTimer = 0;
    for (let i = 0; i < SECTOR_COUNT; i++) this._yellow[i] = 0;
    this._resync(false);
    // Dress the shot as a race in progress rather than a first lap: the tower, the lap
    // counter, the delta bar and the DRS rules all read from what this writes.
    this._seedRunningClassification(plan, speed);
    const lap = (this._order[0]?.timing.lap ?? SHOT_LAP) + 1;
    s.lap = s.totalLaps > 0 ? clamp(lap, 1, s.totalLaps) : lap;
  }

  // --- queries used by the HUD and the AI ---------------------------------------------

  /** Classification entry for a car object, or null. */
  entryFor(car) {
    for (let i = 0; i < this._cars.length; i++) {
      if (this._cars[i].car === car) return this._cars[i].entry;
    }
    return null;
  }

  /** The player's live delta to their own best lap, in seconds (NaN before one exists). */
  get playerDelta() {
    return this._cars[0]?.delta ?? NaN;
  }

  lateUpdate() {}

  resize() {}

  dispose() {
    this.events?.off?.('car:collision', this._onCollision);
    this._rail?.clear();
    this._rail = null;
    this._cars.length = 0;
    this._order.length = 0;
    this.standings.length = 0;
    this._ready = false;
  }
}
