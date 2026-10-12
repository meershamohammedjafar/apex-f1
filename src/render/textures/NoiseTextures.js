import * as THREE from "three";
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const F3 = 1 / 3;
const G3 = 1 / 6;
const GRAD2 = new Float32Array(16);
for (let i = 0; i < 8; i++) {
  const a = i / 8 * Math.PI * 2;
  GRAD2[i * 2] = Math.cos(a);
  GRAD2[i * 2 + 1] = Math.sin(a);
}
const GRAD3 = new Float32Array([
  1,
  1,
  0,
  -1,
  1,
  0,
  1,
  -1,
  0,
  -1,
  -1,
  0,
  1,
  0,
  1,
  -1,
  0,
  1,
  1,
  0,
  -1,
  -1,
  0,
  -1,
  0,
  1,
  1,
  0,
  -1,
  1,
  0,
  1,
  -1,
  0,
  -1,
  -1
]);
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function pmod(n, m) {
  const r = n % m;
  return r < 0 ? r + m : r;
}
export class Noise {
  constructor(seed = 1) {
    this.reseed(seed);
    this._w = { f1: 0, f2: 0, id: 0, dx: 0, dy: 0 };
    this._warp = { x: 0, y: 0 };
  }
  reseed(seed) {
    this._seed = seed | 0 || 2654435769;
    return this;
  }
  hash2(ix, iy) {
    let h = Math.imul(ix, 668265261) ^ Math.imul(iy, 374761393) ^ Math.imul(this._seed, 2654435769);
    h = Math.imul(h ^ h >>> 15, 739982445);
    h = Math.imul(h ^ h >>> 12, 695872825);
    return (h ^ h >>> 15) >>> 0;
  }
  hash3(ix, iy, iz) {
    let h = Math.imul(ix, 668265261) ^ Math.imul(iy, 374761393) ^ Math.imul(iz, 461845907) ^ Math.imul(this._seed, 2654435769);
    h = Math.imul(h ^ h >>> 15, 739982445);
    h = Math.imul(h ^ h >>> 12, 695872825);
    return (h ^ h >>> 15) >>> 0;
  }
  cellRandom(ix, iy) {
    return this.hash2(ix, iy) / 4294967296;
  }
  _dot2(ix, iy, dx, dy) {
    const g = (this.hash2(ix, iy) & 7) * 2;
    return GRAD2[g] * dx + GRAD2[g + 1] * dy;
  }
  _dot2p(ix, iy, px, py, dx, dy) {
    const g = (this.hash2(pmod(ix, px), pmod(iy, py)) & 7) * 2;
    return GRAD2[g] * dx + GRAD2[g + 1] * dy;
  }
  perlin2(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const u = fade(fx);
    const v = fade(fy);
    const n00 = this._dot2(ix, iy, fx, fy);
    const n10 = this._dot2(ix + 1, iy, fx - 1, fy);
    const n01 = this._dot2(ix, iy + 1, fx, fy - 1);
    const n11 = this._dot2(ix + 1, iy + 1, fx - 1, fy - 1);
    const a = n00 + u * (n10 - n00);
    const b = n01 + u * (n11 - n01);
    return (a + v * (b - a)) * 1.4142135;
  }
  perlin2p(x, y, px, py) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const u = fade(fx);
    const v = fade(fy);
    const n00 = this._dot2p(ix, iy, px, py, fx, fy);
    const n10 = this._dot2p(ix + 1, iy, px, py, fx - 1, fy);
    const n01 = this._dot2p(ix, iy + 1, px, py, fx, fy - 1);
    const n11 = this._dot2p(ix + 1, iy + 1, px, py, fx - 1, fy - 1);
    const a = n00 + u * (n10 - n00);
    const b = n01 + u * (n11 - n01);
    return (a + v * (b - a)) * 1.4142135;
  }
  simplex2(xin, yin) {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;
    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) {
      t0 *= t0;
      n += t0 * t0 * this._dot2(i, j, x0, y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) {
      t1 *= t1;
      n += t1 * t1 * this._dot2(i + i1, j + j1, x1, y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) {
      t2 *= t2;
      n += t2 * t2 * this._dot2(i + 1, j + 1, x2, y2);
    }
    return 70 * n;
  }
  simplex3(xin, yin, zin) {
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);
    const z0 = zin - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) {
        i1 = 1;
        j1 = 0;
        k1 = 0;
        i2 = 1;
        j2 = 1;
        k2 = 0;
      } else if (x0 >= z0) {
        i1 = 1;
        j1 = 0;
        k1 = 0;
        i2 = 1;
        j2 = 0;
        k2 = 1;
      } else {
        i1 = 0;
        j1 = 0;
        k1 = 1;
        i2 = 1;
        j2 = 0;
        k2 = 1;
      }
    } else {
      if (y0 < z0) {
        i1 = 0;
        j1 = 0;
        k1 = 1;
        i2 = 0;
        j2 = 1;
        k2 = 1;
      } else if (x0 < z0) {
        i1 = 0;
        j1 = 1;
        k1 = 0;
        i2 = 0;
        j2 = 1;
        k2 = 1;
      } else {
        i1 = 0;
        j1 = 1;
        k1 = 0;
        i2 = 1;
        j2 = 1;
        k2 = 0;
      }
    }
    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    let n = 0;
    n += this._corner3(i, j, k, x0, y0, z0);
    n += this._corner3(i + i1, j + j1, k + k1, x1, y1, z1);
    n += this._corner3(i + i2, j + j2, k + k2, x2, y2, z2);
    n += this._corner3(i + 1, j + 1, k + 1, x3, y3, z3);
    return 32 * n;
  }
  _corner3(i, j, k, x, y, z) {
    let t = 0.6 - x * x - y * y - z * z;
    if (t <= 0) return 0;
    const g = this.hash3(i, j, k) % 12 * 3;
    t *= t;
    return t * t * (GRAD3[g] * x + GRAD3[g + 1] * y + GRAD3[g + 2] * z);
  }
  fbm2(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    let sum = 0, amp = 1, norm = 0, fx = x, fy = y;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.simplex2(fx, fy);
      norm += amp;
      amp *= gain;
      fx *= lacunarity;
      fy *= lacunarity;
    }
    return sum / norm;
  }
  fbm2p(x, y, px, py, octaves = 4, lacunarity = 2, gain = 0.5) {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.perlin2p(x * f, y * f, Math.round(px * f), Math.round(py * f));
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }
  fbm3(x, y, z, octaves = 4, lacunarity = 2, gain = 0.5) {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.simplex3(x * f, y * f, z * f);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }
  ridged2(x, y, octaves = 5, lacunarity = 2.1, gain = 0.5, offset = 1) {
    let sum = 0, amp = 0.5, norm = 0, f = 1, weight = 1;
    for (let o = 0; o < octaves; o++) {
      let n = offset - Math.abs(this.simplex2(x * f, y * f));
      n *= n;
      n *= weight;
      weight = Math.min(1, Math.max(0, n * 2));
      sum += n * amp;
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return Math.min(1, sum / norm);
  }
  ridged2p(x, y, px, py, octaves = 5, lacunarity = 2, gain = 0.5, offset = 1) {
    let sum = 0, amp = 0.5, norm = 0, f = 1, weight = 1;
    for (let o = 0; o < octaves; o++) {
      let n = offset - Math.abs(this.perlin2p(x * f, y * f, Math.round(px * f), Math.round(py * f)));
      n *= n;
      n *= weight;
      weight = Math.min(1, Math.max(0, n * 2));
      sum += n * amp;
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return Math.min(1, sum / norm);
  }
  worley2(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y);
    let f1 = 1e18, f2 = 1e18, id = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cx = ix + ox, cy = iy + oy;
        const h = this.hash2(cx, cy);
        const px = cx + (h & 1023) / 1024;
        const py = cy + (h >>> 10 & 1023) / 1024;
        const dx = px - x, dy = py - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < f1) {
          f2 = f1;
          f1 = d2;
          id = (h >>> 20 & 4095) / 4096;
        } else if (d2 < f2) {
          f2 = d2;
        }
      }
    }
    const w = this._w;
    w.f1 = Math.sqrt(f1);
    w.f2 = Math.sqrt(f2);
    w.id = id;
    return w;
  }
  worley2p(x, y, px, py) {
    const ix = Math.floor(x), iy = Math.floor(y);
    let f1 = 1e18, f2 = 1e18, id = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cx = ix + ox, cy = iy + oy;
        const h = this.hash2(pmod(cx, px), pmod(cy, py));
        const fx = cx + (h & 1023) / 1024;
        const fy = cy + (h >>> 10 & 1023) / 1024;
        const dx = fx - x, dy = fy - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < f1) {
          f2 = f1;
          f1 = d2;
          id = (h >>> 20 & 4095) / 4096;
        } else if (d2 < f2) {
          f2 = d2;
        }
      }
    }
    const w = this._w;
    w.f1 = Math.sqrt(f1);
    w.f2 = Math.sqrt(f2);
    w.id = id;
    return w;
  }
  warp2(x, y, amount, freq) {
    const w = this._warp;
    w.x = x + amount * this.simplex2(x * freq + 41.7, y * freq - 13.3);
    w.y = y + amount * this.simplex2(x * freq - 27.1, y * freq + 63.9);
    return w;
  }
  warp2p(x, y, px, py, amount, freq) {
    const w = this._warp;
    const fpx = Math.max(1, Math.round(px * freq));
    const fpy = Math.max(1, Math.round(py * freq));
    w.x = x + amount * this.perlin2p(x * freq + 3, y * freq + 11, fpx, fpy);
    w.y = y + amount * this.perlin2p(x * freq + 17, y * freq + 5, fpx, fpy);
    return w;
  }
}
export class WorleyGrid {
  constructor(cellsX, cellsY, seed = 1, jitter = 1) {
    this.cx = Math.max(1, cellsX | 0);
    this.cy = Math.max(1, cellsY | 0);
    const n = this.cx * this.cy;
    this.points = new Float32Array(n * 2);
    this.ids = new Float32Array(n);
    this.sizes = new Float32Array(n);
    const noise = new Noise(seed);
    for (let j = 0; j < this.cy; j++) {
      for (let i = 0; i < this.cx; i++) {
        const k = j * this.cx + i;
        const h = noise.hash2(i, j);
        const rx = (h & 1023) / 1024;
        const ry = (h >>> 10 & 1023) / 1024;
        this.points[k * 2] = i + 0.5 + (rx - 0.5) * jitter;
        this.points[k * 2 + 1] = j + 0.5 + (ry - 0.5) * jitter;
        this.ids[k] = (h >>> 20 & 4095) / 4096;
        this.sizes[k] = 0.35 + (h >>> 6 & 255) / 255 * 0.65;
      }
    }
    this.out = { f1: 0, f2: 0, id: 0, size: 0, dx: 0, dy: 0 };
  }
  query(u, v) {
    const x = u * this.cx;
    const y = v * this.cy;
    const ix = Math.floor(x), iy = Math.floor(y);
    let f1 = 1e18, f2 = 1e18, id = 0, size = 0, bdx = 0, bdy = 0;
    for (let oy = -1; oy <= 1; oy++) {
      const cy = iy + oy;
      const wy = cy < 0 ? cy + this.cy : cy >= this.cy ? cy - this.cy : cy;
      const rowBase = wy * this.cx;
      const shiftY = cy - wy;
      for (let ox = -1; ox <= 1; ox++) {
        const cx = ix + ox;
        const wx = cx < 0 ? cx + this.cx : cx >= this.cx ? cx - this.cx : cx;
        const k = rowBase + wx;
        const dx = this.points[k * 2] + (cx - wx) - x;
        const dy = this.points[k * 2 + 1] + shiftY - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < f1) {
          f2 = f1;
          f1 = d2;
          id = this.ids[k];
          size = this.sizes[k];
          bdx = dx;
          bdy = dy;
        } else if (d2 < f2) {
          f2 = d2;
        }
      }
    }
    const o = this.out;
    o.f1 = Math.sqrt(f1);
    o.f2 = Math.sqrt(f2);
    o.id = id;
    o.size = size;
    o.dx = bdx;
    o.dy = bdy;
    return o;
  }
}
export function createField(w, h) {
  return new Float32Array(w * h);
}
export function sampleField(field, w, h, u, v) {
  let x = u * w - 0.5;
  let y = v * h - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const xa = (x0 % w + w) % w, xb = (xa + 1) % w;
  const ya = (y0 % h + h) % h, yb = (ya + 1) % h;
  const a = field[ya * w + xa], b = field[ya * w + xb];
  const c = field[yb * w + xa], d = field[yb * w + xb];
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return top + (bottom - top) * fy;
}
export function blurField(field, w, h, radius, passes = 2) {
  if (radius < 1) return field;
  const tmp = new Float32Array(w * h);
  const r = Math.min(Math.round(radius), Math.max(1, Math.min(w, h) - 1));
  const inv = 1 / (r * 2 + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += field[row + (k < 0 ? k + w : k)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum * inv;
        const lo = x - r, hi = x + r + 1;
        sum -= field[row + (lo < 0 ? lo + w : lo)];
        sum += field[row + (hi >= w ? hi - w : hi)];
      }
    }
    const sums = new Float32Array(w);
    for (let k = -r; k <= r; k++) {
      const row = (k < 0 ? k + h : k) * w;
      for (let x = 0; x < w; x++) sums[x] += tmp[row + x];
    }
    for (let y = 0; y < h; y++) {
      const out = y * w;
      for (let x = 0; x < w; x++) field[out + x] = sums[x] * inv;
      const lo = y - r, hi = y + r + 1;
      const rowLo = (lo < 0 ? lo + h : lo) * w;
      const rowHi = (hi >= h ? hi - h : hi) * w;
      for (let x = 0; x < w; x++) sums[x] += tmp[rowHi + x] - tmp[rowLo + x];
    }
  }
  return field;
}
export function upsampleField(src, sw, sh, dst, dw, dh) {
  const sx = sw / dw;
  const sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    let y0 = Math.floor(fy);
    const ty = fy - y0;
    y0 = (y0 % sh + sh) % sh;
    const y1 = (y0 + 1) % sh;
    const rowA = y0 * sw, rowB = y1 * sw;
    for (let x = 0; x < dw; x++) {
      const fx = (x + 0.5) * sx - 0.5;
      let x0 = Math.floor(fx);
      const tx = fx - x0;
      x0 = (x0 % sw + sw) % sw;
      const x1 = (x0 + 1) % sw;
      const a = src[rowA + x0], b = src[rowA + x1];
      const c = src[rowB + x0], d = src[rowB + x1];
      const top = a + (b - a) * tx;
      const bot = c + (d - c) * tx;
      dst[y * dw + x] = top + (bot - top) * ty;
    }
  }
  return dst;
}
function autoRes(period, octaves, lacunarity, limit) {
  const top = period * Math.pow(lacunarity, octaves - 1);
  const need = 1 << Math.ceil(Math.log2(Math.max(8, top * 4)));
  return Math.max(8, Math.min(limit, need));
}
export function fbmField(noise, w, h, px, py, octaves = 4, lacunarity = 2, gain = 0.5, out) {
  const rx = autoRes(px, octaves, lacunarity, w);
  const ry = autoRes(py, octaves, lacunarity, h);
  const dst = out ?? new Float32Array(w * h);
  const direct = rx >= w && ry >= h;
  const buf = direct ? dst : new Float32Array(rx * ry);
  const bw = direct ? w : rx;
  const bh = direct ? h : ry;
  for (let y = 0; y < bh; y++) {
    const v = (y + 0.5) / bh * py;
    for (let x = 0; x < bw; x++) {
      buf[y * bw + x] = noise.fbm2p((x + 0.5) / bw * px, v, px, py, octaves, lacunarity, gain);
    }
  }
  if (!direct) upsampleField(buf, rx, ry, dst, w, h);
  return dst;
}
export function ridgedField(noise, w, h, px, py, octaves = 5, lacunarity = 2, gain = 0.5, offset = 1, out) {
  const rx = autoRes(px, octaves, lacunarity, w);
  const ry = autoRes(py, octaves, lacunarity, h);
  const dst = out ?? new Float32Array(w * h);
  const direct = rx >= w && ry >= h;
  const buf = direct ? dst : new Float32Array(rx * ry);
  const bw = direct ? w : rx;
  const bh = direct ? h : ry;
  for (let y = 0; y < bh; y++) {
    const v = (y + 0.5) / bh * py;
    for (let x = 0; x < bw; x++) {
      buf[y * bw + x] = noise.ridged2p((x + 0.5) / bw * px, v, px, py, octaves, lacunarity, gain, offset);
    }
  }
  if (!direct) upsampleField(buf, rx, ry, dst, w, h);
  return dst;
}
export function normaliseField(field, lo = 0, hi = 1) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < field.length; i++) {
    const v = field[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  if (span < 1e-8) {
    field.fill((lo + hi) * 0.5);
    return field;
  }
  const k = (hi - lo) / span;
  for (let i = 0; i < field.length; i++) field[i] = lo + (field[i] - min) * k;
  return field;
}
export function normalFromHeight(height, w, h, strength = 2, out) {
  const data = out ?? new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const ym = y === 0 ? h - 1 : y - 1;
    const yp = y === h - 1 ? 0 : y + 1;
    const rowM = ym * w, row0 = y * w, rowP = yp * w;
    for (let x = 0; x < w; x++) {
      const xm = x === 0 ? w - 1 : x - 1;
      const xp = x === w - 1 ? 0 : x + 1;
      const h00 = height[rowM + xm], h10 = height[rowM + x], h20 = height[rowM + xp];
      const h01 = height[row0 + xm], h21 = height[row0 + xp];
      const h02 = height[rowP + xm], h12 = height[rowP + x], h22 = height[rowP + xp];
      const gx = h20 + 2 * h21 + h22 - (h00 + 2 * h01 + h02);
      const gy = h02 + 2 * h12 + h22 - (h00 + 2 * h10 + h20);
      let nx = -gx * strength;
      let ny = -gy * strength;
      const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      nx *= inv;
      ny *= inv;
      const nz = inv;
      const i = (row0 + x) * 4;
      data[i] = (nx * 0.5 + 0.5) * 255;
      data[i + 1] = (ny * 0.5 + 0.5) * 255;
      data[i + 2] = (nz * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  return data;
}
export function packORM(ao, rough, metal, w, h, out) {
  const n = w * h;
  const data = out ?? new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const j = i * 4;
    data[j] = ao ? Math.max(0, Math.min(255, ao[i] * 255)) : 255;
    data[j + 1] = rough ? Math.max(0, Math.min(255, rough[i] * 255)) : 255;
    data[j + 2] = metal ? Math.max(0, Math.min(255, metal[i] * 255)) : 0;
    data[j + 3] = 255;
  }
  return data;
}
export function aoFromHeight(height, w, h, radius = 6, strength = 1, out) {
  const blurred = new Float32Array(height);
  blurField(blurred, w, h, radius, 2);
  const ao = out ?? new Float32Array(w * h);
  for (let i = 0; i < ao.length; i++) {
    const d = (height[i] - blurred[i]) * strength;
    ao[i] = Math.max(0.15, Math.min(1, 0.82 + d * 2.4));
  }
  return ao;
}
export function makeDataTexture(data, w, h, colorSpace = THREE.NoColorSpace, mipmaps = null) {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.colorSpace = colorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  if (mipmaps && mipmaps.length > 1) {
    tex.mipmaps = mipmaps;
    tex.generateMipmaps = false;
  } else {
    tex.generateMipmaps = true;
  }
  tex.needsUpdate = true;
  return tex;
}
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LINEAR_TO_SRGB = new Uint8Array(4097);
for (let i = 0; i <= 4096; i++) {
  const c = i / 4096;
  const v = c <= 31308e-7 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  LINEAR_TO_SRGB[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
}
function linearToSrgbByte(c) {
  const i = c <= 0 ? 0 : c >= 1 ? 4096 : c * 4096 + 0.5 | 0;
  return LINEAR_TO_SRGB[i];
}
function mipLevels(w, h) {
  return Math.floor(Math.log2(Math.max(w, h))) + 1;
}
export function mipChain(data, w, h, srgb = false) {
  const levels = [{ data, width: w, height: h }];
  let src = data, sw = w, sh = h;
  const count = mipLevels(w, h);
  for (let l = 1; l < count; l++) {
    const dw = Math.max(1, sw >> 1);
    const dh = Math.max(1, sh >> 1);
    const dst = new Uint8Array(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
      const y0 = Math.min(y * 2, sh - 1);
      const y1 = Math.min(y * 2 + 1, sh - 1);
      for (let x = 0; x < dw; x++) {
        const x0 = Math.min(x * 2, sw - 1);
        const x1 = Math.min(x * 2 + 1, sw - 1);
        const a = (y0 * sw + x0) * 4, b = (y0 * sw + x1) * 4;
        const c = (y1 * sw + x0) * 4, d = (y1 * sw + x1) * 4;
        const o = (y * dw + x) * 4;
        if (srgb) {
          for (let k = 0; k < 3; k++) {
            dst[o + k] = linearToSrgbByte(
              (SRGB_TO_LINEAR[src[a + k]] + SRGB_TO_LINEAR[src[b + k]] + SRGB_TO_LINEAR[src[c + k]] + SRGB_TO_LINEAR[src[d + k]]) * 0.25
            );
          }
        } else {
          for (let k = 0; k < 3; k++) {
            dst[o + k] = src[a + k] + src[b + k] + src[c + k] + src[d + k] + 2 >> 2;
          }
        }
        dst[o + 3] = src[a + 3] + src[b + 3] + src[c + 3] + src[d + 3] + 2 >> 2;
      }
    }
    levels.push({ data: dst, width: dw, height: dh });
    src = dst;
    sw = dw;
    sh = dh;
  }
  return levels;
}
export function normalMipChain(data, w, h) {
  const levels = [{ data, width: w, height: h }];
  const lengths = [null];
  let src = data, sw = w, sh = h;
  const count = mipLevels(w, h);
  for (let l = 1; l < count; l++) {
    const dw = Math.max(1, sw >> 1);
    const dh = Math.max(1, sh >> 1);
    const dst = new Uint8Array(dw * dh * 4);
    const len = new Float32Array(dw * dh);
    for (let y = 0; y < dh; y++) {
      const y0 = Math.min(y * 2, sh - 1);
      const y1 = Math.min(y * 2 + 1, sh - 1);
      for (let x = 0; x < dw; x++) {
        const x0 = Math.min(x * 2, sw - 1);
        const x1 = Math.min(x * 2 + 1, sw - 1);
        const taps = [(y0 * sw + x0) * 4, (y0 * sw + x1) * 4, (y1 * sw + x0) * 4, (y1 * sw + x1) * 4];
        let nx = 0, ny = 0, nz = 0;
        for (let t = 0; t < 4; t++) {
          const p = taps[t];
          nx += src[p] / 127.5 - 1;
          ny += src[p + 1] / 127.5 - 1;
          nz += src[p + 2] / 127.5 - 1;
        }
        nx *= 0.25;
        ny *= 0.25;
        nz *= 0.25;
        const m = Math.sqrt(nx * nx + ny * ny + nz * nz);
        const k = y * dw + x;
        len[k] = Math.min(1, m);
        const inv = m > 1e-6 ? 1 / m : 0;
        const o = k * 4;
        dst[o] = Math.max(0, Math.min(255, Math.round((nx * inv + 1) * 127.5)));
        dst[o + 1] = Math.max(0, Math.min(255, Math.round((ny * inv + 1) * 127.5)));
        dst[o + 2] = Math.max(0, Math.min(255, Math.round((nz * inv + 1) * 127.5)));
        dst[o + 3] = 255;
      }
    }
    levels.push({ data: dst, width: dw, height: dh });
    lengths.push(len);
    src = dst;
    sw = dw;
    sh = dh;
  }
  return { levels, lengths };
}
export function applyToksvig(ormLevels, normalLengths) {
  const count = Math.min(ormLevels.length, normalLengths.length);
  for (let l = 1; l < count; l++) {
    const len = normalLengths[l];
    if (!len) continue;
    const lvl = ormLevels[l];
    const texels = Math.min(len.length, lvl.width * lvl.height);
    for (let i = 0; i < texels; i++) {
      const m = len[i];
      if (m >= 0.9995) continue;
      const r = lvl.data[i * 4 + 1] / 255;
      const alpha = Math.max(1e-4, r * r);
      const power = 2 / (alpha * alpha) - 2;
      const ft = m / (m + power * (1 - m));
      const alphaPrime = Math.sqrt(2 / (Math.max(1e-4, ft * power) + 2));
      const rPrime = Math.sqrt(Math.min(1, alphaPrime));
      lvl.data[i * 4 + 1] = Math.max(lvl.data[i * 4 + 1], Math.round(Math.min(1, rPrime) * 255));
    }
  }
  return ormLevels;
}
export function createCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") {
    const c2 = new OffscreenCanvas(w, h);
    if (c2.getContext("2d")) return c2;
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}
export function textureFromCanvas(canvas, colorSpace = THREE.SRGBColorSpace) {
  const { data, width, height } = readCanvas(canvas);
  return makeDataTexture(data, width, height, colorSpace);
}
export function readCanvas(canvas) {
  const w = canvas.width, h = canvas.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const src = ctx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 4);
  const stride = w * 4;
  for (let y = 0; y < h; y++) {
    const from = (h - 1 - y) * stride;
    out.set(src.subarray(from, from + stride), y * stride);
  }
  return { data: out, width: w, height: h };
}
export function canvasToField(canvas, out) {
  const { data, width, height } = readCanvas(canvas);
  const field = out ?? new Float32Array(width * height);
  for (let i = 0; i < field.length; i++) {
    const j = i * 4;
    const a = data[j + 3] / 255;
    field[i] = (data[j] * 0.2126 + data[j + 1] * 0.7152 + data[j + 2] * 0.0722) / 255 * a;
  }
  return field;
}
export function yieldFrame() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}
export function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
export function mix(a, b, t) {
  return a + (b - a) * t;
}
export function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
}
export function rgbOf(hex, out = [0, 0, 0]) {
  out[0] = hex >> 16 & 255;
  out[1] = hex >> 8 & 255;
  out[2] = hex & 255;
  return out;
}
export function writeRGB(data, i, r, g, b, mul = 1) {
  const j = i * 4;
  data[j] = Math.max(0, Math.min(255, r * mul));
  data[j + 1] = Math.max(0, Math.min(255, g * mul));
  data[j + 2] = Math.max(0, Math.min(255, b * mul));
  data[j + 3] = 255;
}
