/**
 * Seeded, allocation-free PRNG (mulberry32). Physics and procedural generation use
 * this rather than Math.random so that runs are reproducible and screenshots of a
 * given seed are comparable across builds.
 */
export class Rng {
  constructor(seed = 0x9e3779b9) {
    this.seed(seed);
  }

  seed(s) {
    this._s = s >>> 0;
    if (this._s === 0) this._s = 0x9e3779b9;
    return this;
  }

  /** Uniform in [0, 1). */
  next() {
    this._s = (this._s + 0x6d2b79f5) >>> 0;
    let t = this._s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min, max) {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max]. */
  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  /** Approximately standard-normal via the Irwin–Hall sum of 4. */
  gaussian() {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.4142135;
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Signed uniform in [-a, a]. */
  signed(a = 1) {
    return (this.next() * 2 - 1) * a;
  }
}

/** Shared instance for non-physics procedural work (geometry, liveries, crowds). */
export const rng = new Rng(20260827);
