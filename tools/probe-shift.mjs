import { chromium } from "playwright";
const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"] });
const p = await b.newPage({ viewport: { width: 320, height: 180 } });
p.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await p.goto("http://127.0.0.1:4173/?quality=low&autostart=1", { waitUntil: "domcontentloaded" });
await p.waitForFunction(() => globalThis.__APEX_READY__ === true || globalThis.__APEX_ERROR__, null, { timeout: 18e4 });
const r = await p.evaluate(async () => {
  const e = globalThis.APEX, ctx = e.ctx;
  e.stop();
  const CAR = 1;
  const car = ctx.cars[CAR], st = car.physics.state;
  const dt = 1 / 120;
  const hist = [];
  const events = [];
  let lastGear = st.gear;
  for (let i = 0; i < 120 * 240; i++) {
    e.step(dt);
    const steer = Math.abs(st.steer ?? 0);
    hist.push({
      i,
      gear: st.gear,
      kph: st.speedKph,
      steer,
      yaw: Math.abs(st.angularVelocity ? st.angularVelocity.y : 0),
      latG: Math.abs(st.gForce ? st.gForce.x : 0)
    });
    if (st.gear > lastGear && st.gear >= 4 && steer < 0.08 && st.speedKph > 150) {
      events.push(i);
    }
    lastGear = st.gear;
    if (hist.length > 4e4) hist.shift();
  }
  const base0 = hist[0].i;
  const at = (i) => hist[i - base0];
  const out = [];
  for (const idx of events.slice(0, 12)) {
    const win = [], pre = [];
    for (let k = idx - 30; k <= idx + 30; k++) {
      const s = at(k);
      if (s) win.push(s);
    }
    for (let k = idx - 150; k <= idx - 60; k++) {
      const s = at(k);
      if (s) pre.push(s);
    }
    if (win.length < 20 || pre.length < 20) continue;
    const pk = (a, key) => Math.max(...a.map((s) => s[key]));
    out.push({
      gear: `${at(idx - 1)?.gear}->${at(idx)?.gear}`,
      kph: +at(idx).kph.toFixed(0),
      steer: +at(idx).steer.toFixed(3),
      yawShift: +pk(win, "yaw").toFixed(4),
      yawBase: +pk(pre, "yaw").toFixed(4),
      latGShift: +pk(win, "latG").toFixed(4),
      latGBase: +pk(pre, "latG").toFixed(4)
    });
  }
  return { shiftsFound: events.length, analysed: out.length, events: out };
});
console.log(JSON.stringify(r, null, 2));
await b.close();
