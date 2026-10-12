const DEG = Math.PI / 180;
export const SPA_PROGRAM = [
  ["s", 292.059, "main"],
  ["a", 22, 152.518, "t1"],
  ["s", 401.676, "descent"],
  ["a", 160, -37.604, "t2"],
  ["a", 185, 63.813, "t3"],
  ["a", 400, -21.936, "t4"],
  ["s", 1138.53, "kemmel"],
  ["a", 58, 73.814, "t5"],
  ["s", 55.231, "combes_link"],
  ["a", 52, -66.429, "t6"],
  ["s", 60.096, "malmedy_link"],
  ["a", 78, 61.501, "t7"],
  ["s", 532.448, "to_bruxelles"],
  ["a", 48, 113.842, "t8"],
  ["s", 113.785, "to_speakers"],
  ["a", 130, 20.135, "t9"],
  ["s", 184.349, "to_pouhon"],
  ["a", 130, -63.058, "t10"],
  ["a", 180, -40.987, "t11"],
  ["s", 335.474, "to_fagnes"],
  ["a", 68, 55.397, "t12"],
  ["s", 44.822, "fagnes_link"],
  ["a", 74, -50.088, "t13"],
  ["s", 367.772, "to_campus"],
  ["a", 62, 77.942, "t14"],
  ["s", 73.583, "campus_link"],
  ["a", 105, 48.094, "t15"],
  ["a", 160, 37.589, "t16"],
  ["s", 354.137, "to_paulfrere"],
  ["a", 260, -30.011, "t17"],
  ["s", 227.715, "to_blanchimont"],
  ["a", 520, -17.53, "t18"],
  ["a", 600, -11.822, "t18b"],
  ["s", 495.121, "to_busstop"],
  ["a", 26, 73.655, "t19"],
  ["s", 31.81, "bus_link"],
  ["a", 30, -91.074, "t20"],
  ["s", 27.821, "bus_exit_link"],
  ["a", 90, 12.239, "bus_exit"],
  ["s", 185.883, "pit_straight"]
];
export const SPA_ELEVATION = [
  [0, 30],
  [180, 33],
  [292, 36],
  [351, 35],
  [470, 27],
  [600, 15],
  [700, 4],
  [752, 0],
  [810, 2.5],
  [880, 10],
  [980, 26],
  [1063, 41],
  [1140, 45],
  [1216, 46.5],
  [1500, 54],
  [1900, 65],
  [2200, 74],
  [2355, 78],
  [2485, 79.5],
  [2545, 80],
  [2689, 76],
  [2950, 66],
  [3221, 56],
  [3317, 52],
  [3431, 50],
  [3550, 47],
  [3661, 44],
  [3804, 36],
  [3933, 30],
  [4100, 26.5],
  [4268, 24],
  [4443, 21],
  [4630, 17.5],
  [4811, 14],
  [4969, 10],
  [5057, 9],
  [5162, 10],
  [5340, 15],
  [5516, 20],
  [5652, 24],
  [5880, 28],
  [6039, 29.5],
  [6163, 31],
  [6420, 32.5],
  [6658, 33],
  [6772, 33],
  [6900, 32],
  [7004, 30]
];
export const SPA_WIDTH = [
  [0, 7.3],
  [292, 6.6],
  [351, 5.6],
  [500, 6.4],
  [752, 6.9],
  [1063, 7.1],
  [1216, 6.7],
  [2200, 6.5],
  [2355, 6],
  [2545, 6],
  [2689, 6.3],
  [3150, 6.4],
  [3221, 6],
  [3431, 6.3],
  [3661, 6.5],
  [3933, 6.4],
  [4268, 6],
  [4443, 6.1],
  [4811, 5.9],
  [5057, 6.2],
  [5162, 6.4],
  [5880, 6.6],
  [6163, 6.6],
  [6658, 6],
  [6772, 6],
  [6870, 7],
  [7004, 7.3]
];
export const SPA_BANKING = [
  [0, 0],
  [292, 0.6],
  [322, 1.2],
  [351, 0.6],
  [600, -0.3],
  [752, -2.4],
  [830, -1],
  [900, 2.6],
  [960, 4.2],
  [1063, 3.4],
  [1216, 0.4],
  [2300, 0.3],
  [2392, 2.2],
  [2515, -2],
  [2647, 1.9],
  [2900, 0.3],
  [3270, 2.8],
  [3400, 1],
  [3441, 1.4],
  [3600, 0.2],
  [3730, -2.6],
  [3870, -2.2],
  [3960, -0.6],
  [4300, 2],
  [4410, -1.8],
  [4600, 0.2],
  [4853, 2.4],
  [5013, 3],
  [5110, 2.6],
  [5300, 0.3],
  [5584, -1.2],
  [5959, -1.6],
  [6100, -1],
  [6400, 0.2],
  [6675, 1.6],
  [6747, -1.8],
  [6820, 0.5],
  [7004, 0]
];
export const SPA_CORNERS = [
  { number: 1, name: "La Source", seg: "t1", entry: 120, exit: 60, runoff: "asphalt", gravel: false },
  { number: 2, name: "Eau Rouge", seg: "t2", entry: 40, exit: 10, runoff: "asphalt", gravel: false },
  { number: 3, name: "Raidillon", seg: "t3", entry: 0, exit: 20, runoff: "gravel", gravel: true },
  { number: 4, name: "Kemmel Kink", seg: "t4", entry: 0, exit: 40, runoff: "asphalt", gravel: false },
  { number: 5, name: "Les Combes", seg: "t5", entry: 160, exit: 20, runoff: "gravel", gravel: true },
  { number: 6, name: "Les Combes 2", seg: "t6", entry: 10, exit: 20, runoff: "gravel", gravel: true },
  { number: 7, name: "Malmedy", seg: "t7", entry: 20, exit: 60, runoff: "gravel", gravel: true },
  { number: 8, name: "Bruxelles", seg: "t8", entry: 140, exit: 60, runoff: "asphalt", gravel: false },
  { number: 9, name: "Speaker's Corner", seg: "t9", entry: 40, exit: 40, runoff: "asphalt", gravel: false },
  { number: 10, name: "Pouhon", seg: "t10", entry: 90, exit: 10, runoff: "asphalt", gravel: false },
  { number: 11, name: "Pouhon 2", seg: "t11", entry: 0, exit: 60, runoff: "gravel", gravel: true },
  { number: 12, name: "Fagnes", seg: "t12", entry: 110, exit: 10, runoff: "gravel", gravel: true },
  { number: 13, name: "Fagnes 2", seg: "t13", entry: 0, exit: 50, runoff: "gravel", gravel: true },
  { number: 14, name: "Campus", seg: "t14", entry: 130, exit: 20, runoff: "gravel", gravel: true },
  { number: 15, name: "Stavelot", seg: "t15", entry: 40, exit: 10, runoff: "gravel", gravel: true },
  { number: 16, name: "Stavelot 2", seg: "t16", entry: 0, exit: 70, runoff: "gravel", gravel: true },
  { number: 17, name: "Courbe Paul Frere", seg: "t17", entry: 30, exit: 50, runoff: "asphalt", gravel: false },
  { number: 18, name: "Blanchimont", seg: "t18", entry: 30, exit: 30, runoff: "asphalt", gravel: false },
  { number: 19, name: "Bus Stop", seg: "t19", entry: 150, exit: 10, runoff: "asphalt", gravel: false },
  { number: 20, name: "Bus Stop 2", seg: "t20", entry: 0, exit: 40, runoff: "asphalt", gravel: false }
];
export const SPA_SECTOR_DISTANCE = [2340, 5162];
export const SPA_DRS = [
  { name: "Kemmel", detect: 660, start: 1290, end: 2320 },
  { name: "Pit straight", detect: 5900, start: 6835, end: 272 }
];
export const SPA_PITLANE = {
  entryDistance: 6700,
  exitDistance: 640,
  speedLimit: 80 / 3.6,
  speedLimitKph: 80,
  boxCount: 20,
  boxSpacing: 17,
  laneHalfWidth: 6,
  path: [
    [6700, 6.5, 3],
    [6790, 11, 4],
    [6880, 14, 5.5],
    [7004, 15, 6],
    [120, 15, 6],
    [230, 14, 5.5],
    [292, 12.5, 4.2],
    [322, 12, 4],
    [351, 12.5, 4],
    [420, 14, 5],
    [520, 13, 5],
    [600, 10, 4],
    [640, 8, 3]
  ],
  buildingFrom: 6820,
  buildingTo: 250,
  buildingOffset: 26,
  pitWallOffset: 10.6
};
export const SPA_MARGINS = [
  { from: 6820, to: 292, side: 1, astro: 0, runoff: "concrete", runoffWidth: 3, barrier: "concrete", barrierAt: 3.4 },
  { from: 6820, to: 292, side: -1, astro: 1, runoff: "asphalt", runoffWidth: 8, barrier: "armco", barrierAt: 10.5 },
  { from: 292, to: 420, side: -1, astro: 1.2, runoff: "asphalt", runoffWidth: 26, barrier: "tecpro", barrierAt: 28 },
  { from: 292, to: 420, side: 1, astro: 0.6, runoff: "concrete", runoffWidth: 4, barrier: "concrete", barrierAt: 4.6 },
  { from: 420, to: 700, side: 1, astro: 1, runoff: "asphalt", runoffWidth: 10, barrier: "concrete", barrierAt: 11 },
  { from: 420, to: 752, side: -1, astro: 1.2, runoff: "grass", runoffWidth: 14, barrier: "armco", barrierAt: 15 },
  { from: 700, to: 900, side: 1, astro: 1.5, runoff: "asphalt", runoffWidth: 30, barrier: "tecpro", barrierAt: 32 },
  { from: 752, to: 1080, side: -1, astro: 1.5, runoff: "asphalt", runoffWidth: 34, barrier: "tyre", barrierAt: 36 },
  { from: 900, to: 1100, side: 1, astro: 1.2, runoff: "gravel", runoffWidth: 26, barrier: "tecpro", barrierAt: 28 },
  { from: 1100, to: 2200, side: 0, astro: 1.2, runoff: "grass", runoffWidth: 16, barrier: "armco", barrierAt: 17.5 },
  { from: 2200, to: 2430, side: -1, astro: 1.5, runoff: "gravel", runoffWidth: 30, barrier: "tyre", barrierAt: 32 },
  { from: 2200, to: 2430, side: 1, astro: 1.2, runoff: "asphalt", runoffWidth: 9, barrier: "armco", barrierAt: 10.5 },
  { from: 2430, to: 2560, side: 1, astro: 1.5, runoff: "gravel", runoffWidth: 24, barrier: "tyre", barrierAt: 26 },
  { from: 2430, to: 2560, side: -1, astro: 1.2, runoff: "asphalt", runoffWidth: 8, barrier: "armco", barrierAt: 9.5 },
  { from: 2560, to: 2760, side: -1, astro: 1.5, runoff: "gravel", runoffWidth: 32, barrier: "tyre", barrierAt: 34 },
  { from: 2560, to: 2760, side: 1, astro: 1.2, runoff: "grass", runoffWidth: 12, barrier: "armco", barrierAt: 13.5 },
  { from: 2760, to: 3150, side: 0, astro: 1.2, runoff: "grass", runoffWidth: 14, barrier: "armco", barrierAt: 15.5 },
  { from: 3150, to: 3400, side: -1, astro: 1.5, runoff: "asphalt", runoffWidth: 22, barrier: "tecpro", barrierAt: 24 },
  { from: 3150, to: 3400, side: 1, astro: 1.2, runoff: "asphalt", runoffWidth: 10, barrier: "armco", barrierAt: 11.5 },
  { from: 3400, to: 3620, side: 0, astro: 1.2, runoff: "grass", runoffWidth: 16, barrier: "armco", barrierAt: 17.5 },
  { from: 3620, to: 3960, side: 1, astro: 1.5, runoff: "asphalt", runoffWidth: 40, barrier: "tecpro", barrierAt: 42 },
  { from: 3620, to: 3960, side: -1, astro: 1.2, runoff: "asphalt", runoffWidth: 10, barrier: "armco", barrierAt: 11.5 },
  { from: 3960, to: 4200, side: 0, astro: 1.2, runoff: "grass", runoffWidth: 15, barrier: "armco", barrierAt: 16.5 },
  { from: 4200, to: 4360, side: -1, astro: 1.5, runoff: "gravel", runoffWidth: 26, barrier: "tyre", barrierAt: 28 },
  { from: 4200, to: 4360, side: 1, astro: 1.2, runoff: "asphalt", runoffWidth: 8, barrier: "armco", barrierAt: 9.5 },
  { from: 4360, to: 4520, side: 1, astro: 1.5, runoff: "gravel", runoffWidth: 24, barrier: "tyre", barrierAt: 26 },
  { from: 4360, to: 4520, side: -1, astro: 1.2, runoff: "asphalt", runoffWidth: 8, barrier: "armco", barrierAt: 9.5 },
  { from: 4520, to: 4700, side: 0, astro: 1.2, runoff: "grass", runoffWidth: 15, barrier: "armco", barrierAt: 16.5 },
  { from: 4700, to: 4920, side: -1, astro: 1.5, runoff: "gravel", runoffWidth: 28, barrier: "tyre", barrierAt: 30 },
  { from: 4700, to: 4920, side: 1, astro: 1.2, runoff: "grass", runoffWidth: 10, barrier: "armco", barrierAt: 11.5 },
  { from: 4920, to: 5230, side: -1, astro: 1.5, runoff: "gravel", runoffWidth: 34, barrier: "tyre", barrierAt: 36 },
  { from: 4920, to: 5230, side: 1, astro: 1.2, runoff: "asphalt", runoffWidth: 9, barrier: "armco", barrierAt: 10.5 },
  { from: 5230, to: 5900, side: 0, astro: 1.2, runoff: "grass", runoffWidth: 12, barrier: "armco", barrierAt: 13 },
  { from: 5900, to: 6120, side: 1, astro: 1.5, runoff: "asphalt", runoffWidth: 20, barrier: "tecpro", barrierAt: 22 },
  { from: 5900, to: 6120, side: -1, astro: 1.2, runoff: "grass", runoffWidth: 10, barrier: "armco", barrierAt: 11 },
  { from: 6120, to: 6600, side: 0, astro: 1.2, runoff: "grass", runoffWidth: 12, barrier: "armco", barrierAt: 13 },
  { from: 6600, to: 6700, side: -1, astro: 1, runoff: "asphalt", runoffWidth: 18, barrier: "tecpro", barrierAt: 20 },
  { from: 6600, to: 6820, side: 1, astro: 0.8, runoff: "asphalt", runoffWidth: 6, barrier: "concrete", barrierAt: 6.8 },
  { from: 6700, to: 6820, side: -1, astro: 0.8, runoff: "concrete", runoffWidth: 6, barrier: "concrete", barrierAt: 6.8 }
];
export const DEFAULT_MARGIN = {
  astro: 1,
  runoff: "grass",
  runoffWidth: 14,
  barrier: "armco",
  barrierAt: 15.5
};
export const SPA_GRANDSTANDS = [
  { from: 6860, to: 7004, side: -1, rows: 26, offset: 22, name: "Gold 1" },
  { from: 0, to: 250, side: -1, rows: 26, offset: 22, name: "Gold 2" },
  { from: 300, to: 430, side: -1, rows: 22, offset: 34, name: "La Source" },
  { from: 760, to: 1010, side: 1, rows: 24, offset: 40, name: "Eau Rouge" },
  { from: 2180, to: 2400, side: -1, rows: 20, offset: 38, name: "Les Combes" },
  { from: 3180, to: 3340, side: -1, rows: 18, offset: 30, name: "Bruxelles" },
  { from: 3700, to: 3900, side: 1, rows: 16, offset: 48, name: "Pouhon" },
  { from: 6560, to: 6700, side: -1, rows: 20, offset: 26, name: "Bus Stop" }
];
export const SPA_MARSHAL_POSTS = [
  120,
  400,
  700,
  980,
  1400,
  1800,
  2260,
  2520,
  2900,
  3260,
  3520,
  3860,
  4180,
  4480,
  4780,
  5100,
  5420,
  5760,
  6080,
  6400,
  6740
];
export const SPA_BRAKING_BOARDS = [
  { at: 292, side: -1, marks: [200, 150, 100, 50] },
  { at: 2355, side: -1, marks: [200, 150, 100, 50] },
  { at: 3221, side: -1, marks: [200, 150, 100, 50] },
  { at: 4268, side: -1, marks: [150, 100, 50] },
  { at: 4811, side: -1, marks: [150, 100, 50] },
  { at: 6658, side: -1, marks: [200, 150, 100, 50] }
];
export const SPA_TOWERS = [
  { at: 60, side: -1, offset: 26, height: 18, kind: "tv" },
  { at: 340, side: -1, offset: 40, height: 22, kind: "tv" },
  { at: 900, side: 1, offset: 46, height: 26, kind: "tv" },
  { at: 2400, side: -1, offset: 42, height: 20, kind: "tv" },
  { at: 3260, side: -1, offset: 34, height: 18, kind: "tv" },
  { at: 3860, side: 1, offset: 52, height: 20, kind: "tv" },
  { at: 5060, side: -1, offset: 40, height: 18, kind: "tv" },
  { at: 6690, side: -1, offset: 30, height: 20, kind: "tv" },
  { at: 150, side: -1, offset: 52, height: 34, kind: "pylon" },
  { at: 480, side: -1, offset: 58, height: 34, kind: "pylon" },
  { at: 860, side: 1, offset: 64, height: 34, kind: "pylon" },
  { at: 2300, side: -1, offset: 60, height: 32, kind: "pylon" },
  { at: 6600, side: -1, offset: 54, height: 32, kind: "pylon" }
];
export const SPA_CLEARINGS = [
  { at: 100, radius: 190 },
  { at: 380, radius: 150 },
  { at: 900, radius: 170 },
  { at: 2340, radius: 150 },
  { at: 3250, radius: 120 },
  { at: 3800, radius: 130 },
  { at: 6700, radius: 170 }
];
export const SPA = {
  name: "Circuit de Spa-Francorchamps",
  shortName: "Spa",
  country: "Belgium",
  latitude: 50.4372,
  longitude: 5.9714,
  dayOfYear: 240,
  headingOffsetDeg: 38,
  origin: { x: 0, z: 0 },
  targetLength: 7004,
  laps: 44,
  program: SPA_PROGRAM,
  elevation: SPA_ELEVATION,
  width: SPA_WIDTH,
  banking: SPA_BANKING,
  corners: SPA_CORNERS,
  sectorDistance: SPA_SECTOR_DISTANCE,
  drs: SPA_DRS,
  pitLane: SPA_PITLANE,
  margins: SPA_MARGINS,
  defaultMargin: DEFAULT_MARGIN,
  grandstands: SPA_GRANDSTANDS,
  marshalPosts: SPA_MARSHAL_POSTS,
  brakingBoards: SPA_BRAKING_BOARDS,
  towers: SPA_TOWERS,
  clearings: SPA_CLEARINGS
};
export function makePeriodicSpline(knots, period) {
  const n = knots.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = knots[i][0];
    ys[i] = knots[i][1];
  }
  const delta = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) delta[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  delta[n - 1] = delta[0];
  const m = new Float64Array(n);
  m[0] = (delta[n - 2] + delta[0]) * 0.5;
  for (let i = 1; i < n - 1; i++) m[i] = (delta[i - 1] + delta[i]) * 0.5;
  m[n - 1] = m[0];
  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / delta[i];
    const b = m[i + 1] / delta[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * delta[i];
      m[i + 1] = tau * b * delta[i];
    }
  }
  let cached = 0;
  return function sample(x) {
    let d = x % period;
    if (d < 0) d += period;
    let i = cached;
    if (i > n - 2 || d < xs[i] || d > xs[i + 1]) {
      i = 0;
      let lo = 0;
      let hi = n - 1;
      while (lo <= hi) {
        const mid = lo + hi >> 1;
        if (xs[mid] <= d) {
          i = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (i > n - 2) i = n - 2;
      cached = i;
    }
    const h = xs[i + 1] - xs[i];
    const t = (d - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1];
  };
}
export function buildLayout(circuit = SPA, options = {}) {
  const tol = options.tolerance ?? 0.01;
  const maxSpacing = options.maxSpacing ?? 8;
  const minSpacing = options.minSpacing ?? 1.1;
  let total = 0;
  const marks = Object.create(null);
  for (const seg of circuit.program) {
    const start = total;
    const len = seg[0] === "s" ? seg[1] : seg[1] * Math.abs(seg[2]) * DEG;
    total += len;
    marks[seg[0] === "s" ? seg[2] : seg[3]] = { start, end: total, length: len };
  }
  const elevationAt = makePeriodicSpline(circuit.elevation, total);
  const rot = (circuit.headingOffsetDeg ?? 0) * DEG;
  const px = [];
  const pz = [];
  const pd = [];
  let x = circuit.origin?.x ?? 0;
  let z = circuit.origin?.z ?? 0;
  let phi = rot;
  let d = 0;
  px.push(x);
  pz.push(z);
  pd.push(0);
  for (const seg of circuit.program) {
    if (seg[0] === "s") {
      const len = seg[1];
      const steps = Math.max(1, Math.ceil(len / maxSpacing));
      const step = len / steps;
      const sx = Math.sin(phi) * step;
      const sz = -Math.cos(phi) * step;
      for (let i = 0; i < steps; i++) {
        x += sx;
        z += sz;
        d += step;
        px.push(x);
        pz.push(z);
        pd.push(d);
      }
    } else {
      const radius = seg[1];
      const angle = seg[2] * DEG;
      const len = radius * Math.abs(angle);
      const spacing = Math.min(maxSpacing, Math.max(minSpacing, Math.sqrt(8 * radius * tol)));
      const steps = Math.max(2, Math.ceil(len / spacing));
      const dPhi = angle / steps;
      const step = len / steps;
      for (let i = 0; i < steps; i++) {
        x += Math.sin(phi + dPhi * 0.5) * step;
        z += -Math.cos(phi + dPhi * 0.5) * step;
        phi += dPhi;
        d += step;
        px.push(x);
        pz.push(z);
        pd.push(d);
      }
    }
  }
  const count = px.length - 1;
  const closeX = px[count] - px[0];
  const closeZ = pz[count] - pz[0];
  const points = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const f = pd[i] / total;
    points[i * 3] = px[i] - closeX * f;
    points[i * 3 + 1] = elevationAt(pd[i]);
    points[i * 3 + 2] = pz[i] - closeZ * f;
  }
  return {
    points,
    count,
    analyticLength: total,
    marks,
    elevationAt,
    closureError: Math.hypot(closeX, closeZ)
  };
}
export function cornerSpan(corner, marks, total) {
  const mark = marks[corner.seg];
  const entry = (mark.start - (corner.entry ?? 0) + total) % total;
  const exit = (mark.end + (corner.exit ?? 0)) % total;
  const apex = (mark.start + mark.length * 0.55) % total;
  return { entry, apex, exit, start: mark.start, end: mark.end, length: mark.length };
}
