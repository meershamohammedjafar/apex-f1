#!/usr/bin/env node
/**
 * Frame analysis for the visual-review loop.
 *
 * `shadow` scans a horizontal band of the image and prints mean luminance per x-bin.
 * A cast shadow shows up as a sustained dip against the surrounding surface; a frame
 * with no shadows reads as a flat profile. This exists because two critics disagreed
 * about whether shadows were present, and the eye is not a reliable instrument for it.
 *
 *   node tools/analyse.mjs shadow shots/round2/cockpit-grid.png --y0 0.52 --y1 0.60
 *   node tools/analyse.mjs stats shots/round2/*.png
 */
import { readFileSync } from 'node:fs';
import { decodePng } from './screenshot.mjs';

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function load(file) {
  const { width, height, data, channels } = decodePng(readFileSync(file));
  return { width, height, data, channels };
}

function bandProfile(img, y0f, y1f, bins) {
  const { width, height, data, channels } = img;
  const y0 = Math.floor(height * y0f);
  const y1 = Math.floor(height * y1f);
  const out = [];
  const binW = width / bins;
  for (let b = 0; b < bins; b++) {
    const xs = Math.floor(b * binW);
    const xe = Math.floor((b + 1) * binW);
    let sum = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = xs; x < xe; x++) {
        const i = (y * width + x) * channels;
        sum += lum(data[i], data[i + 1], data[i + 2]);
        n++;
      }
    }
    out.push(sum / Math.max(1, n));
  }
  return out;
}

function stats(img) {
  const { width, height, data, channels } = img;
  const vals = [];
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * channels;
      vals.push(lum(data[i], data[i + 1], data[i + 2]));
    }
  }
  vals.sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(vals.length * p))];
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  return { mean, std, p1: q(0.01), p50: q(0.5), p99: q(0.99),
           clipped: (vals.filter(v => v > 250).length / vals.length * 100) };
}

const [, , mode, ...rest] = process.argv;
// A flag consumes the token after it, so that token is a value and not a file. Without
// this the gate command `shadow shot.png --y0 0.50 --y1 0.58 --bins 24` printed the real
// profile and then died with ENOENT trying to open a file called "0.50".
const flagValueIndices = new Set();
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith('--')) flagValueIndices.add(i + 1);
const files = rest.filter((a, i) => !a.startsWith('--') && !flagValueIndices.has(i));
const flag = (n, d) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? Number(rest[i + 1]) : d; };

if (mode === 'shadow') {
  const y0 = flag('y0', 0.52), y1 = flag('y1', 0.60), bins = flag('bins', 24);
  for (const f of files) {
    const p = bandProfile(load(f), y0, y1, bins);
    const mn = Math.min(...p), mx = Math.max(...p), mean = p.reduce((a, b) => a + b, 0) / p.length;
    console.log(`\n${f}  band y=${y0}..${y1}`);
    console.log('  ' + p.map(v => v.toFixed(0).padStart(4)).join(''));
    console.log(`  min=${mn.toFixed(1)} max=${mx.toFixed(1)} mean=${mean.toFixed(1)} ` +
                `contrast=${((mx - mn) / Math.max(1, mx) * 100).toFixed(1)}%`);
  }
} else if (mode === 'stats') {
  console.log('file'.padEnd(42) + 'mean   std    p1    p50   p99   clip%');
  for (const f of files) {
    const s = stats(load(f));
    console.log(f.padEnd(42) +
      `${s.mean.toFixed(1).padStart(5)} ${s.std.toFixed(1).padStart(6)} ${String(s.p1).padStart(5)} ` +
      `${String(s.p50).padStart(5)} ${String(s.p99).padStart(5)} ${s.clipped.toFixed(2).padStart(6)}`);
  }
} else {
  console.log('usage: analyse.mjs <shadow|stats> <files...>');
}
