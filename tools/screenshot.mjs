#!/usr/bin/env node
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { availableParallelism } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SCENARIOS = {
  "cockpit-grid": {
    desc: "Cockpit view on the start grid, engine idling, lights out sequence",
    warmup: 1,
    setup: { scenario: "grid", throttle: 0, speed: 0 }
  },
  "cockpit-straight": {
    desc: "Cockpit at 310 km/h down the main straight, DRS open",
    warmup: 4,
    setup: { scenario: "straight", throttle: 1, speed: 86, drs: true }
  },
  "cockpit-braking": {
    desc: "Heavy braking into a hairpin, front tyres on the edge of lock-up",
    warmup: 4,
    setup: { scenario: "braking", brake: 1, speed: 75 }
  },
  "cockpit-apex": {
    desc: "Mid-corner at a fast right-hander, kerb contact, opposite lock",
    warmup: 4,
    setup: { scenario: "apex", throttle: 0.6, speed: 52, steer: 0.55 }
  },
  "cockpit-pack": {
    desc: "Cockpit in traffic — three cars ahead, dirty air, mirrors populated",
    warmup: 6,
    setup: { scenario: "pack", throttle: 1, speed: 72 }
  },
  "chase-hero": {
    desc: "Chase camera hero shot, full car visible against trackside detail",
    warmup: 5,
    setup: { scenario: "straight", throttle: 1, speed: 80, camera: "chase" }
  },
  "trackside-sweep": {
    desc: "Broadcast trackside camera — reads the circuit, crowd and sky in one frame",
    warmup: 5,
    setup: { scenario: "straight", throttle: 1, speed: 80, camera: "trackside" }
  },
  "cockpit-sunset": {
    desc: "Low sun into the visor — bloom, flare, atmospheric scattering stress test",
    warmup: 4,
    setup: { scenario: "straight", throttle: 1, speed: 80, tod: 17.5 }
  },
  "cockpit-wet": {
    desc: "Wet running — spray, reflections, wipers of light off standing water",
    warmup: 5,
    setup: { scenario: "straight", throttle: 0.8, speed: 60, weather: "wet" }
  },
  "cockpit-night": {
    desc: "Night race under floodlights",
    warmup: 4,
    setup: { scenario: "straight", throttle: 1, speed: 80, tod: 21.5 }
  }
};
const FAST = {
  width: 1280,
  height: 720,
  quality: "medium",
  warmupScale: 0.4,
  minWarmup: 0.5,
  presentEvery: 0,
  presentWindow: 0,
  settleFrames: 4,
  settleMs: 100,
  timeoutSec: 200,
  skipPasses: ["godrays", "motionBlur", "ao"]
};
const FULL = {
  warmupScale: 1,
  minWarmup: 0,
  presentEvery: 4,
  presentWindow: 96,
  settleFrames: 12,
  settleMs: 250,
  timeoutSec: 2400,
  skipPasses: []
};
const BLANK_STD = 1.5;
const BLANK_COLOURS = 48;
const NAV_STAGGER_MS = 350;
function parseArgs(argv) {
  const args = {
    out: "shots",
    width: 1920,
    height: 1080,
    quality: "ultra",
    scenario: null,
    all: false,
    url: null,
    keepServer: false,
    list: false,
    fast: false,
    jobs: 4,
    timeout: null
  };
  const explicit = new Set();
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--out") args.out = next();
    else if (a === "--scenario") args.scenario = next();
    else if (a === "--width") {
      args.width = Number(next());
      explicit.add("width");
    } else if (a === "--height") {
      args.height = Number(next());
      explicit.add("height");
    } else if (a === "--quality") {
      args.quality = next();
      explicit.add("quality");
    } else if (a === "--url") args.url = next();
    else if (a === "--all") args.all = true;
    else if (a === "--list") args.list = true;
    else if (a === "--fast") args.fast = true;
    else if (a === "--jobs") args.jobs = Math.max(1, Number(next()) || 1);
    else if (a === "--timeout") args.timeout = Math.max(1, Number(next()) || 1);
  }
  if (args.fast) {
    if (!explicit.has("width")) args.width = FAST.width;
    if (!explicit.has("height")) args.height = FAST.height;
    if (!explicit.has("quality")) args.quality = FAST.quality;
  }
  args.profile = args.fast ? FAST : FULL;
  return args;
}
async function waitForServer(url, timeoutMs = 9e4) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.ok) return true;
    } catch {
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
let serverProc = null;
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";
const SPAWN_SHELL = process.platform === "win32";
async function servesOurBuild(url) {
  let html;
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) return false;
    html = await res.text();
  } catch {
    return false;
  }
  const refs = [...html.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map((m) => m[1]);
  if (refs.length === 0) return false;
  return refs.every((rel) => existsSync(path.join(ROOT, "dist", rel)));
}
async function ensureServer() {
  const url = "http://127.0.0.1:4173/";
  if (await waitForServer(url, 1500)) {
    if (await servesOurBuild(url)) return url;
    throw new Error(
      `something is already serving ${url} and it is NOT this checkout's dist/ — refusing to capture a foreign build. Stop that server (or pass --url) and retry.`
    );
  }
  if (!existsSync(path.join(ROOT, "dist", "index.html"))) {
    console.log("[shot] dist/ missing — building…");
    await new Promise((resolve, reject) => {
      const b = spawn(NPX, ["vite", "build"], { cwd: ROOT, stdio: "inherit", shell: SPAWN_SHELL });
      b.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`vite build exited ${code}`)));
      b.on("error", reject);
    });
  }
  console.log("[shot] starting preview server…");
  serverProc = spawn(NPX, ["vite", "preview", "--host", "127.0.0.1", "--port", "4173", "--strictPort"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    shell: SPAWN_SHELL
  });
  serverProc.stdout?.on("data", () => {
  });
  serverProc.stderr?.on("data", (d) => process.stderr.write(`[preview] ${d}`));
  if (!await waitForServer(url)) throw new Error("preview server did not come up");
  if (!await servesOurBuild(url)) {
    throw new Error(`preview on ${url} is not serving this checkout's dist/ — port already taken?`);
  }
  return url;
}
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 2303741511) throw new Error("not a PNG");
  let width = 0;
  let height = 0;
  let depth = 8;
  let colourType = 6;
  let interlace = 0;
  let palette = null;
  const idat = [];
  for (let off = 8; off + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const body = off + 8;
    if (type === "IHDR") {
      width = buf.readUInt32BE(body);
      height = buf.readUInt32BE(body + 4);
      depth = buf[body + 8];
      colourType = buf[body + 9];
      interlace = buf[body + 12];
    } else if (type === "PLTE") {
      palette = buf.subarray(body, body + len);
    } else if (type === "IDAT") {
      idat.push(buf.subarray(body, body + len));
    } else if (type === "IEND") {
      break;
    }
    off = body + len + 4;
  }
  if (interlace !== 0) throw new Error("interlaced PNG unsupported");
  if (!width || !height) throw new Error("PNG has no IHDR");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colourType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * depth;
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil(width * bitsPerPixel / 8);
  const out = Buffer.allocUnsafe(height * stride);
  for (let y = 0, src = 0; y < height; y++) {
    const filter = raw[src++];
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[src + x];
      const a = x >= bytesPerPixel ? out[row + x - bytesPerPixel] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = y > 0 && x >= bytesPerPixel ? out[prev + x - bytesPerPixel] : 0;
      let value;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + (a + b >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value = rawByte + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      out[row + x] = value & 255;
    }
    src += stride;
  }
  return { width, height, depth, colourType, channels, palette, stride, data: out };
}
function sampleAt(img, row, index, scale = true) {
  const { depth, data } = img;
  if (depth === 8) return data[row + index];
  if (depth === 16) return data[row + index * 2];
  const perByte = 8 / depth;
  const byte = data[row + Math.floor(index / perByte)];
  const shift = 8 - depth * (index % perByte + 1);
  const max = (1 << depth) - 1;
  const raw = byte >> shift & max;
  return scale ? Math.round(raw / max * 255) : raw;
}
function frameStats(buf) {
  const img = decodePng(buf);
  const { width, height, channels, colourType, palette, stride } = img;
  const seen = new Uint8Array(1 << 21);
  let distinct = 0;
  let sum = 0;
  let sumSq = 0;
  let min = 255;
  let max = 0;
  const total = width * height;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      let r;
      let g;
      let b;
      if (colourType === 3) {
        const idx = sampleAt(img, row, x, false) * 3;
        r = palette[idx] ?? 0;
        g = palette[idx + 1] ?? 0;
        b = palette[idx + 2] ?? 0;
      } else if (colourType === 0 || colourType === 4) {
        r = g = b = sampleAt(img, row, x * channels);
      } else {
        const base = x * channels;
        r = sampleAt(img, row, base);
        g = sampleAt(img, row, base + 1);
        b = sampleAt(img, row, base + 2);
      }
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += lum;
      sumSq += lum * lum;
      if (lum < min) min = lum;
      if (lum > max) max = lum;
      const key = r << 16 | g << 8 | b;
      const byte = key >> 3;
      const bit = 1 << (key & 7);
      if ((seen[byte] & bit) === 0) {
        seen[byte] |= bit;
        distinct++;
      }
    }
  }
  const mean = sum / total;
  const variance = Math.max(0, sumSq / total - mean * mean);
  const std = Math.sqrt(variance);
  const blank = std < BLANK_STD || distinct < BLANK_COLOURS;
  return {
    width,
    height,
    mean,
    std,
    distinctColours: distinct,
    minLuma: min,
    maxLuma: max,
    blank,
    blankReason: blank ? std < BLANK_STD ? `luminance sigma ${std.toFixed(3)} < ${BLANK_STD} — flat/blank frame` : `only ${distinct} distinct colours (< ${BLANK_COLOURS}) — flat/blank frame` : null
  };
}
function createGate() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => {
      },
      () => {
      }
    );
    return run;
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function captureOnPage(page, baseUrl, name, scenario, args, navGate, deadline) {
  const profile = args.profile;
  const phases = {};
  let mark = Date.now();
  const phase = (key) => {
    const now = Date.now();
    phases[key] = now - mark;
    mark = now;
  };
  const remaining = () => Math.max(1e3, deadline - Date.now());
  const logs = [];
  const errors = [];
  page.on("console", (m) => {
    const t = `${m.type()}: ${m.text()}`;
    logs.push(t);
    if (m.type() === "error") errors.push(t);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  const q = new URLSearchParams({ shot: "1", quality: args.quality, scenario: scenario.setup.scenario ?? "default" });
  if (scenario.setup.tod !== void 0) q.set("tod", String(scenario.setup.tod));
  if (scenario.setup.weather) q.set("weather", scenario.setup.weather);
  if (scenario.setup.camera) q.set("camera", scenario.setup.camera);
  const url = `${baseUrl}?${q.toString()}`;
  await navGate(async () => {
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: Math.min(6e4, remaining()) });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        await sleep(500);
      }
    }
    if (lastErr) throw lastErr;
    await sleep(NAV_STAGGER_MS);
  });
  phase("nav");
  await page.waitForFunction(
    () => globalThis.__APEX_READY__ === true || globalThis.__APEX_ERROR__,
    null,
    { timeout: remaining() }
  );
  const bootError = await page.evaluate(() => globalThis.__APEX_ERROR__ ?? null);
  if (bootError) throw new Error(`boot failed for ${name}:
${bootError}`);
  phase("boot");
  let skippedPasses = [];
  if (profile.skipPasses.length) {
    skippedPasses = await page.evaluate((wanted) => {
      const pipeline = globalThis.APEX?.ctx?.pipeline;
      const cfg = pipeline?._config;
      if (!cfg || typeof cfg !== "object") return [];
      const off = [];
      for (const key of wanted) {
        if (cfg[key] === true) {
          cfg[key] = false;
          off.push(key);
        }
      }
      if (off.length && typeof pipeline._applyConfig === "function") pipeline._applyConfig();
      return off;
    }, profile.skipPasses);
  }
  await page.evaluate(async (setup) => {
    const engine = globalThis.APEX;
    const ctx = engine.ctx;
    engine.stop();
    if (ctx.race?.applyScenario) ctx.race.applyScenario(setup);
    const dt = 1 / 120;
    const steps = Math.round((setup.warmup ?? 3) / dt);
    const presentFrom = setup.presentWindow > 0 ? Math.max(0, steps - setup.presentWindow) : 0;
    for (let i = 0; i < steps; i++) {
      if (ctx.input) {
        const c = ctx.input.controls;
        c.throttle = setup.throttle ?? 0;
        c.brake = setup.brake ?? 0;
        c.steer = setup.steer ?? 0;
        c.drs = !!setup.drs;
        ctx.input.enabled = false;
      }
      engine.step(dt);
      if (setup.presentEvery > 0 && i >= presentFrom && i % setup.presentEvery === 0) engine.present(0);
    }
    for (let i = 0; i < setup.settleFrames; i++) engine.present(0);
  }, {
    ...scenario.setup,
    warmup: Math.max(profile.minWarmup, scenario.warmup * profile.warmupScale),
    presentEvery: profile.presentEvery,
    presentWindow: profile.presentWindow,
    settleFrames: profile.settleFrames
  });
  await page.waitForTimeout(profile.settleMs);
  phase("sim");
  const file = path.join(args.out, `${name}.png`);
  const buf = await page.screenshot({ type: "png", timeout: remaining() });
  await writeFile(file, buf);
  phase("shot");
  const stats = await page.evaluate(() => {
    const e = globalThis.APEX;
    const info = e.renderer.info;
    return {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      textures: info.memory.textures,
      geometries: info.memory.geometries
    };
  });
  let pixels;
  try {
    pixels = frameStats(buf);
  } catch (err) {
    pixels = {
      width: args.width,
      height: args.height,
      mean: NaN,
      std: NaN,
      distinctColours: 0,
      minLuma: NaN,
      maxLuma: NaN,
      blank: true,
      blankReason: `capture could not be decoded for the blank check: ${err.message}`
    };
  }
  phase("stats");
  return { name, file, errors, stats, pixels, skippedPasses, bytes: buf.length, phases };
}
async function runScenario(browser, baseUrl, name, args, navGate) {
  const started = Date.now();
  const scenario = SCENARIOS[name];
  if (!scenario) {
    return { name, ok: false, ms: 0, errors: [], error: `unknown scenario "${name}"` };
  }
  let page = null;
  let timer = null;
  try {
    page = await browser.newPage({
      viewport: { width: args.width, height: args.height },
      deviceScaleFactor: 1
    });
    const deadline = started + args.timeout * 1e3;
    const work = captureOnPage(page, baseUrl, name, scenario, args, navGate, deadline);
    work.catch(() => {
    });
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${args.timeout}s`)), Math.max(1e3, deadline - Date.now()));
    });
    const r = await Promise.race([work, guard]);
    const ms = Date.now() - started;
    const failed = r.errors.length > 0 || r.pixels.blank;
    return {
      ...r,
      ms,
      ok: !failed,
      error: r.pixels.blank ? r.pixels.blankReason : r.errors.length ? `${r.errors.length} console error(s)` : null
    };
  } catch (err) {
    return { name, ok: false, ms: Date.now() - started, errors: [], error: err.message };
  } finally {
    if (timer) clearTimeout(timer);
    if (page) await page.close().catch(() => {
    });
  }
}
async function runPool(names, jobs, task) {
  const results = new Array(names.length);
  let next = 0;
  const width = Math.max(1, Math.min(jobs, names.length));
  const runners = [];
  for (let w = 0; w < width; w++) {
    runners.push(
      (async () => {
        for (; ; ) {
          const i = next++;
          if (i >= names.length) return;
          results[i] = await task(names[i]);
        }
      })()
    );
  }
  await Promise.all(runners);
  return results;
}
function fmtSecs(ms) {
  return `${(ms / 1e3).toFixed(1)}s`;
}
function fmtPhases(phases) {
  if (!phases) return "";
  return Object.entries(phases).map(([k, v]) => `${k} ${(v / 1e3).toFixed(1)}s`).join(" ");
}
async function main() {
  const args = parseArgs(process.argv);
  if (args.list) {
    for (const [k, v] of Object.entries(SCENARIOS)) console.log(`${k.padEnd(20)} ${v.desc}`);
    return;
  }
  const runStart = Date.now();
  const baseUrl = args.url ?? await ensureServer();
  const browser = await chromium.launch({
    args: [
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
      "--enable-gpu-rasterization",
      "--disable-dev-shm-usage",
      "--no-sandbox"
    ]
  });
  const names = args.all ? Object.keys(SCENARIOS) : [args.scenario ?? "cockpit-straight"];
  const jobs = Math.max(1, Math.min(args.jobs, names.length));
  if (args.timeout === null) args.timeout = args.profile.timeoutSec * jobs;
  await mkdir(args.out, { recursive: true });
  console.log(
    `[shot] ${names.length} scenario(s) @ ${args.width}x${args.height} quality=${args.quality} jobs=${jobs} timeout=${args.timeout}s${args.fast ? " [fast]" : ""}`
  );
  const cores = availableParallelism();
  if (jobs > 1 && cores < jobs * 2) {
    console.log(`[shot] note: ${cores} cores for ${jobs} jobs — software rendering already uses every core, so --jobs 1 may be faster here`);
  }
  const navGate = createGate();
  const results = await runPool(names, jobs, async (name) => {
    const r = await runScenario(browser, baseUrl, name, args, navGate);
    const px = r.pixels;
    if (r.file) {
      console.log(
        `[shot] ${name.padEnd(20)} -> ${r.file}  ${fmtSecs(r.ms).padStart(7)}  draws=${r.stats.drawCalls} tris=${(r.stats.triangles / 1e3).toFixed(0)}k  lum μ=${px.mean.toFixed(1)} σ=${px.std.toFixed(1)} colours=${px.distinctColours}  [${fmtPhases(r.phases)}]  ${r.ok ? "clean" : `FAIL: ${r.error}`}`
      );
    } else {
      console.log(`[shot] ${name.padEnd(20)} ${fmtSecs(r.ms).padStart(7)}  FAILED: ${r.error}`);
    }
    for (const e of (r.errors ?? []).slice(0, 6)) console.log(`         ! ${e}`);
    return r;
  });
  await browser.close();
  if (serverProc) serverProc.kill("SIGTERM");
  const totalMs = Date.now() - runStart;
  console.log("");
  console.log(
    `${"scenario".padEnd(20)} ${"wall".padStart(8)} ${"draws".padStart(6)} ${"tris".padStart(7)} ${"lum μ".padStart(7)} ${"σ".padStart(7)} ${"colours".padStart(8)}  status`
  );
  for (const r of results) {
    const px = r.pixels;
    console.log(
      `${r.name.padEnd(20)} ${fmtSecs(r.ms).padStart(8)} ${String(r.stats?.drawCalls ?? "-").padStart(6)} ${(r.stats ? `${(r.stats.triangles / 1e3).toFixed(0)}k` : "-").padStart(7)} ${(px ? px.mean.toFixed(1) : "-").padStart(7)} ${(px ? px.std.toFixed(2) : "-").padStart(7)} ${String(px?.distinctColours ?? "-").padStart(8)}  ${r.ok ? "ok" : `FAIL — ${r.error}`}`
    );
  }
  const failures = results.filter((r) => !r.ok);
  console.log("");
  console.log(
    `[shot] ${results.length - failures.length}/${results.length} ok in ${fmtSecs(totalMs)} (${jobs} job(s)${args.fast ? ", fast" : ""})`
  );
  await writeFile(
    path.join(args.out, "report.json"),
    JSON.stringify({ totalMs, jobs, fast: args.fast, width: args.width, height: args.height, quality: args.quality, results }, null, 2)
  );
  process.exit(failures.length ? 1 : 0);
}
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    if (serverProc) serverProc.kill("SIGTERM");
    process.exit(1);
  });
}
export { frameStats, decodePng };
