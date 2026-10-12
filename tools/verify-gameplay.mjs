#!/usr/bin/env node
import { chromium } from "playwright";
const SIM_SECONDS = Number(process.argv[2] ?? 420);
const browser = await chromium.launch({
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--no-sandbox",
    "--disable-dev-shm-usage"
  ]
});
const page = await browser.newPage({ viewport: { width: 320, height: 180 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
await page.goto("http://127.0.0.1:4173/?quality=low&autostart=1", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => globalThis.__APEX_READY__ === true || globalThis.__APEX_ERROR__, null, { timeout: 18e4 });
const result = await page.evaluate(async (simSeconds) => {
  const e = globalThis.APEX, ctx = e.ctx;
  e.stop();
  if (ctx.input) ctx.input.update = () => {
  };
  const dt = 1 / 120;
  const steps = Math.round(simSeconds / dt);
  const bad = [];
  let maxSpeed = 0, offTrackTicks = 0, airborneTicks = 0, maxGear = 0, maxRpm = 0;
  const trace = [];
  let fieldMaxKph = 0, fieldMaxGear = 0, fieldMaxRpm = 0;
  const speedSamples = [];
  const finite = (v) => Number.isFinite(v);
  for (let i = 0; i < steps; i++) {
    if (ctx.input) {
      const c = ctx.input.controls;
      c.throttle = 1;
      c.brake = 0;
      c.steer = 0;
      const st = ctx.cars?.[0]?.physics?.state;
      c.shiftUp = !!st && st.rpm > 13800 && st.gear > 0 && st.gear < 8 && i % 2 === 0;
      c.shiftDown = false;
    }
    e.step(dt);
    for (let ci = 1; ci < (ctx.cars?.length ?? 0); ci++) {
      const as = ctx.cars[ci]?.physics?.state;
      if (!as) continue;
      const kph = as.speedKph ?? (as.speed ?? 0) * 3.6;
      if (kph > 0 && kph < 450 && i % 60 === 0) speedSamples.push(kph);
      if (kph > fieldMaxKph) {
        fieldMaxKph = kph;
        fieldMaxGear = as.gear ?? 0;
        fieldMaxRpm = as.rpm ?? 0;
      }
    }
    const s = ctx.cars?.[0]?.physics?.state;
    if (s) {
      if (!finite(s.position?.x) || !finite(s.speed) || !finite(s.rpm)) {
        if (bad.length < 5) bad.push({ step: i, pos: s.position?.toArray?.(), speed: s.speed, rpm: s.rpm });
      }
      maxSpeed = Math.max(maxSpeed, s.speedKph ?? (s.speed ?? 0) * 3.6);
      maxGear = Math.max(maxGear, s.gear ?? 0);
      maxRpm = Math.max(maxRpm, s.rpm ?? 0);
      if (i % 600 === 0 && trace.length < 40) trace.push({
        t: +(i * dt).toFixed(0),
        kph: +(s.speedKph ?? 0).toFixed(1),
        gear: s.gear,
        rpm: Math.round(s.rpm ?? 0)
      });
      if (s.onTrack === false) offTrackTicks++;
      if (s.airborne) airborneTicks++;
    }
  }
  const standings = (ctx.race?.standings ?? []).slice(0, 20).map((r, i) => ({
    pos: r.position ?? i + 1,
    code: r.car?.driver?.code ?? r.code ?? "???",
    lap: r.lap ?? r.lapsCompleted ?? 0,
    last: r.lastLap ?? null,
    best: r.bestLap ?? null,
    gap: r.gap ?? null
  }));
  const laps = (ctx.cars ?? []).map((c, i) => ({
    i,
    code: c.driver?.code ?? "???",
    best: c.timing?.bestLap ?? c.bestLap ?? null,
    completed: c.timing?.lapsCompleted ?? c.lapsCompleted ?? 0,
    nan: !Number.isFinite(c.physics?.state?.position?.x ?? 0)
  }));
  return {
    simSeconds,
    elapsed: ctx.time.elapsed,
    maxSpeedKph: maxSpeed,
    maxGear,
    maxRpm: Math.round(maxRpm),
    trace,
    fieldMaxKph: +fieldMaxKph.toFixed(1),
    fieldMaxGear,
    fieldMaxRpm: Math.round(fieldMaxRpm),
    fieldSpeed: (() => {
      if (!speedSamples.length) return null;
      speedSamples.sort((a, b) => a - b);
      const q = (f) => +speedSamples[Math.min(speedSamples.length - 1, Math.floor(speedSamples.length * f))].toFixed(1);
      return { n: speedSamples.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), p999: q(0.999) };
    })(),
    offTrackPct: offTrackTicks / steps * 100,
    airbornePct: airborneTicks / steps * 100,
    nanEvents: bad,
    session: ctx.race?.session ?? null,
    standings,
    laps
  };
}, SIM_SECONDS);
console.log(JSON.stringify(result, null, 2));
if (errors.length) console.log("\nCONSOLE ERRORS:\n" + errors.slice(0, 10).join("\n"));
await browser.close();
