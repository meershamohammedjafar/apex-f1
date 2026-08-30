#!/usr/bin/env node
/**
 * Engine-cover speckle oracle — the acceptance metric for the heat-haze rework.
 *
 * Replicates the round-8 bisection protocol that pinned the "rainbow corruption" on
 * HeatHaze: chase-hero framing at 1280x720/medium (fast profile: godrays, motion blur
 * and AO skipped), 2 simulated seconds, 4 presents, then the speckle fraction over the
 * engine-cover box x 0.33-0.52, y 0.35-0.60 with 3x3-neighbour deviation > 39/255.
 *
 * Round-8 reference numbers (pre-fix build): baseline 15.16%, heat disabled 3.25%.
 * Acceptance for the fix: `on` within ~0.5 points of `off`.
 *
 *   node tools/speckle-oracle.mjs            # heat on vs heat off
 *   node tools/speckle-oracle.mjs on gain0   # any subset of: on off gain0
 *
 * Assumes dist/ is built. Starts its own vite preview on a private port.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { decodePng } from './screenshot.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'shots-oracle');
const PORT = 4189;

const VARIANTS = {
  on: null,
  off: `globalThis.APEX.ctx.fx.heat.enabled = false;`,
  gain0: `globalThis.APEX.ctx.fx.heat.material.uniforms.uGain.value = 0;`,
};

function measure(buf) {
  const img = decodePng(buf);
  const { width, height, channels, stride, data } = img;
  const px = (x, y, c) => data[y * stride + x * channels + c];
  const x0 = Math.max(1, Math.round(width * 0.33));
  const x1 = Math.min(width - 1, Math.round(width * 0.52));
  const y0 = Math.max(1, Math.round(height * 0.35));
  const y1 = Math.min(height - 1, Math.round(height * 0.60));
  let total = 0;
  let cMean = 0;
  let cLuma = 0;
  let cMaxN = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      total++;
      const r = px(x, y, 0), g = px(x, y, 1), b = px(x, y, 2);
      let mr = 0, mg = 0, mb = 0, maxd = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nr = px(x + dx, y + dy, 0), ng = px(x + dx, y + dy, 1), nb = px(x + dx, y + dy, 2);
          mr += nr; mg += ng; mb += nb;
          if (dx || dy) {
            const d = Math.max(Math.abs(r - nr), Math.abs(g - ng), Math.abs(b - nb));
            if (d > maxd) maxd = d;
          }
        }
      }
      mr /= 9; mg /= 9; mb /= 9;
      const dMean = Math.max(Math.abs(r - mr), Math.abs(g - mg), Math.abs(b - mb));
      const lC = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const lM = 0.2126 * mr + 0.7152 * mg + 0.0722 * mb;
      if (dMean > 39) cMean++;
      if (Math.abs(lC - lM) > 39) cLuma++;
      if (maxd > 39) cMaxN++;
    }
  }
  return {
    box: { x0, x1, y0, y1, total },
    devMean: (cMean / total) * 100,
    devLuma: (cLuma / total) * 100,
    devMaxNeighbour: (cMaxN / total) * 100,
  };
}

async function waitForServer(url, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function runVariant(browser, base, name, hook) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  try {
    await page.goto(`${base}?shot=1&quality=medium&scenario=straight&camera=chase`, {
      waitUntil: 'domcontentloaded', timeout: 60000,
    });
    await page.waitForFunction(
      () => globalThis.__APEX_READY__ === true || globalThis.__APEX_ERROR__,
      null, { timeout: 600000 },
    );
    const bootError = await page.evaluate(() => globalThis.__APEX_ERROR__ ?? null);
    if (bootError) throw new Error(`boot failed: ${bootError}`);

    await page.evaluate((wanted) => {
      const pipeline = globalThis.APEX?.ctx?.pipeline;
      const cfg = pipeline?._config;
      if (!cfg) return;
      for (const key of wanted) if (cfg[key] === true) cfg[key] = false;
      if (typeof pipeline._applyConfig === 'function') pipeline._applyConfig();
    }, ['godrays', 'motionBlur', 'ao']);

    if (hook) await page.evaluate(hook);

    await page.evaluate(async (setup) => {
      const engine = globalThis.APEX;
      const ctx = engine.ctx;
      engine.stop();
      if (ctx.race?.applyScenario) ctx.race.applyScenario(setup);
      const dt = 1 / 120;
      const steps = Math.round(2.0 / dt);
      for (let i = 0; i < steps; i++) {
        if (ctx.input) {
          const c = ctx.input.controls;
          c.throttle = 1; c.brake = 0; c.steer = 0; c.drs = false;
          ctx.input.enabled = false;
        }
        engine.step(dt);
      }
      for (let i = 0; i < 4; i++) engine.present(0);
    }, { scenario: 'straight', throttle: 1, speed: 80, camera: 'chase' });

    await page.waitForTimeout(150);
    const buf = await page.screenshot({ type: 'png', timeout: 300000 });
    await writeFile(path.join(OUT, `chase-${name}.png`), buf);
    const hazeSources = await page.evaluate(() => globalThis.APEX?.ctx?.fx?.heat?.sourceCount ?? -1);
    return { name, ...measure(buf), hazeSources, errors };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const wanted = process.argv.slice(2).filter((a) => VARIANTS[a] !== undefined);
  const names = wanted.length ? wanted : ['on', 'off'];

  const server = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite', 'preview', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], shell: process.platform === 'win32' },
  );
  server.stderr?.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  const base = `http://127.0.0.1:${PORT}/`;

  let browser = null;
  try {
    if (!(await waitForServer(base))) throw new Error('preview server did not come up');
    browser = await chromium.launch({
      args: [
        '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-dev-shm-usage', '--no-sandbox',
      ],
    });

    for (const name of names) {
      const started = Date.now();
      const r = await runVariant(browser, base, name, VARIANTS[name]);
      console.log(
        `${name.padEnd(6)} devMean=${r.devMean.toFixed(2)}%  devLuma=${r.devLuma.toFixed(2)}%  ` +
        `devMaxN=${r.devMaxNeighbour.toFixed(2)}%  sources=${r.hazeSources}  ` +
        `box=[${r.box.x0}-${r.box.x1}]x[${r.box.y0}-${r.box.y1}]  ${(Date.now() - started) / 1000 | 0}s`,
      );
      for (const e of r.errors.slice(0, 5)) console.log(`   ! ${e}`);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
