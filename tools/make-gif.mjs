#!/usr/bin/env node
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const SHOTS = {
  straight: { scenario: 'straight', throttle: 1, speed: 86, drs: true, camera: null },
  chase: { scenario: 'straight', throttle: 1, speed: 80, camera: 'chase' },
  apex: { scenario: 'apex', throttle: 0.6, speed: 52, steer: 0.55, camera: null },
  pack: { scenario: 'pack', throttle: 1, speed: 72, camera: null },
  grid: { scenario: 'grid', throttle: 0, speed: 0, camera: null },
};

function parseArgs(argv) {
  const a = {
    shot: 'straight', frames: 60, fps: 20, width: 640, height: 360,
    quality: 'low', warmup: 3.0, out: 'media/apex.gif', gifWidth: 720, keep: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === '--shot') a.shot = v();
    else if (k === '--frames') a.frames = Number(v());
    else if (k === '--fps') a.fps = Number(v());
    else if (k === '--width') a.width = Number(v());
    else if (k === '--height') a.height = Number(v());
    else if (k === '--quality') a.quality = v();
    else if (k === '--warmup') a.warmup = Number(v());
    else if (k === '--out') a.out = v();
    else if (k === '--gif-width') a.gifWidth = Number(v());
    else if (k === '--keep') a.keep = true;
  }
  return a;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: ROOT, stdio: opts.quiet ? 'ignore' : 'inherit' });
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} exited ${c}`))));
    p.on('error', reject);
  });
}

async function waitForServer(url, ms = 60000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try { if ((await fetch(url)).ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv);
  const setup = SHOTS[args.shot];
  if (!setup) {
    console.error(`unknown shot "${args.shot}" — have: ${Object.keys(SHOTS).join(', ')}`);
    process.exit(1);
  }

  const frameDir = path.join(ROOT, '.gifframes');
  await rm(frameDir, { recursive: true, force: true });
  await mkdir(frameDir, { recursive: true });

  if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.log('[gif] building…');
    await run('npx', ['vite', 'build'], { quiet: true });
  }

  const url = 'http://127.0.0.1:4173/';
  let server = null;
  if (!(await waitForServer(url, 1200))) {
    server = spawn('npx', ['vite', 'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort'],
      { cwd: ROOT, stdio: 'ignore' });
    if (!(await waitForServer(url))) throw new Error('preview server did not start');
  }

  const CHROME_CANDIDATES = [
    process.env.APEX_CHROME,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ].filter(Boolean);
  const executablePath = CHROME_CANDIDATES.find((c) => existsSync(c));

  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
           '--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: args.width, height: args.height } });
  page.setDefaultTimeout(600000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const q = new URLSearchParams({ shot: '1', quality: args.quality, scenario: setup.scenario });
  if (setup.camera) q.set('camera', setup.camera);
  await page.goto(`${url}?${q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => globalThis.__APEX_READY__ === true || globalThis.__APEX_ERROR__,
    null, { timeout: 300000 });
  const boot = await page.evaluate(() => globalThis.__APEX_ERROR__ ?? null);
  if (boot) throw new Error(`boot failed:\n${boot}`);

  await page.evaluate((s) => {
    const e = globalThis.APEX, ctx = e.ctx;
    e.stop();
    ctx.race?.applyScenario?.(s);
    if (ctx.input) {
      const c = ctx.input.controls;
      c.throttle = s.throttle ?? 0; c.brake = s.brake ?? 0;
      c.steer = s.steer ?? 0; c.drs = !!s.drs;
      ctx.input.enabled = false;
    }
    const dt = 1 / 120;
    for (let i = 0; i < Math.round((s.warmup ?? 3) / dt); i++) e.step(dt);
    for (let i = 0; i < 8; i++) e.present(0);
  }, { ...setup, warmup: args.warmup });

  const stepsPerFrame = Math.max(1, Math.round(120 / args.fps));
  const t0 = Date.now();
  for (let f = 0; f < args.frames; f++) {
    await page.evaluate(({ steps, s }) => {
      const e = globalThis.APEX, ctx = e.ctx;
      const dt = 1 / 120;
      for (let i = 0; i < steps; i++) {
        if (ctx.input) {
          const c = ctx.input.controls;
          c.throttle = s.throttle ?? 0; c.brake = s.brake ?? 0;
          c.steer = s.steer ?? 0; c.drs = !!s.drs;
        }
        e.step(dt);
      }
      e.present(0);
    }, { steps: stepsPerFrame, s: setup });

    const buf = await page.screenshot({ type: 'png' });
    await writeFile(path.join(frameDir, `f${String(f).padStart(4, '0')}.png`), buf);

    const each = (Date.now() - t0) / (f + 1) / 1000;
    process.stdout.write(
      `\r[gif] frame ${f + 1}/${args.frames}  ${each.toFixed(1)}s/frame  ` +
      `eta ${Math.round(each * (args.frames - f - 1))}s   `);
  }
  process.stdout.write('\n');

  await browser.close();
  if (server) server.kill('SIGTERM');
  if (errors.length) console.log(`[gif] ${errors.length} console error(s): ${errors.slice(0, 3).join(' | ')}`);

  const outPath = path.isAbsolute(args.out) ? args.out : path.join(ROOT, args.out);
  await mkdir(path.dirname(outPath), { recursive: true });
  const palette = path.join(frameDir, 'palette.png');
  const scale = `scale=${args.gifWidth}:-1:flags=lanczos`;

  console.log('[gif] building palette…');
  await run('ffmpeg', ['-v', 'error', '-framerate', String(args.fps),
    '-i', path.join(frameDir, 'f%04d.png'),
    '-vf', `fps=${args.fps},${scale},palettegen=stats_mode=diff`, '-y', palette]);

  console.log('[gif] encoding…');
  await run('ffmpeg', ['-v', 'error', '-framerate', String(args.fps),
    '-i', path.join(frameDir, 'f%04d.png'), '-i', palette,
    '-lavfi', `fps=${args.fps},${scale}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3`,
    '-loop', '0', '-y', outPath]);

  if (!args.keep) await rm(frameDir, { recursive: true, force: true });

  const { size } = await import('node:fs').then((m) => m.promises.stat(outPath));
  console.log(`[gif] wrote ${args.out}  ${(size / 1048576).toFixed(2)} MB  ` +
    `${args.frames} frames @ ${args.fps}fps  ${args.gifWidth}px wide`);
}

main().catch((e) => { console.error(e); process.exit(1); });
