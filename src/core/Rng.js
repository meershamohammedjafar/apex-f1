export class Rng {
  constructor(seed = 2654435769) {
    this.seed(seed);
  }
  seed(s) {
    this._s = s >>> 0;
    if (this._s === 0) this._s = 2654435769;
    return this;
  }
  next() {
    this._s = this._s + 1831565813 >>> 0;
    let t = this._s;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  range(min, max) {
    return min + this.next() * (max - min);
  }
  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }
  gaussian() {
    return (this.next() + this.next() + this.next() + this.next() - 2) * 1.4142135;
  }
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }
  signed(a = 1) {
    return (this.next() * 2 - 1) * a;
  }
}
export const rng = new Rng(20260827);
