import * as THREE from 'three';
import { EventBus } from './EventBus.js';
import { Settings, QUALITY_TIERS, detectQualityTier } from './Settings.js';
import { clamp } from './MathUtils.js';

/**
 * Engine owns the WebGL context, the shared `ctx` object, and the frame loop.
 *
 * Timing model: systems tick on a fixed 120 Hz step (`update`), physics substeps to
 * 240 Hz internally. Presentation runs at display rate; `lateUpdate(alpha)` receives the
 * interpolation factor between the last two fixed states so visuals never judder when
 * the display rate and the tick rate disagree.
 */

const FIXED_HZ = 120;
const FIXED_DT = 1 / FIXED_HZ;
const MAX_STEPS_PER_FRAME = 6; // spiral-of-death guard

export class Engine {
  constructor(canvas, options = {}) {
    this.canvas = canvas;
    this.systems = [];
    this.running = false;
    this._accumulator = 0;
    this._lastTime = 0;
    this._rafId = 0;
    this._frame = 0;

    const settings = new Settings(options.settings);
    if (!options.settings?.quality) settings.values.quality = detectQualityTier();

    this.renderer = this._createRenderer(canvas, settings);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      settings.get('fov'),
      canvas.clientWidth / Math.max(1, canvas.clientHeight),
      0.05,
      12000,
    );
    this.camera.rotation.order = 'YXZ';

    this.ctx = {
      engine: this,
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      canvas,
      ui: options.ui ?? document.getElementById('ui-root'),
      settings,
      events: new EventBus(),
      quality: settings.tier,
      time: { elapsed: 0, dt: FIXED_DT, frame: 0, alpha: 0, fps: 0 },
      paused: false,
      // Populated by systems during init, keyed by their static systemName.
    };

    settings.onChange((key) => {
      if (key === 'quality') {
        this.ctx.quality = QUALITY_TIERS[settings.get('quality')] ?? QUALITY_TIERS.high;
        this.renderer.setPixelRatio(this._resolvePixelRatio());
        this._resize(true);
        this.ctx.events.emit('quality:change', this.ctx.quality);
      }
      if (key === 'fov') {
        this.camera.fov = settings.get('fov');
        this.camera.updateProjectionMatrix();
      }
    });

    this._onResize = () => this._resize(false);
    globalThis.addEventListener('resize', this._onResize);

    this._fpsAccum = 0;
    this._fpsFrames = 0;
  }

  _createRenderer(canvas, settings) {
    const tier = settings.tier;
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // the pipeline supplies SMAA/TAA
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer:
        new URLSearchParams(globalThis.location?.search ?? '').get('shot') === '1',
    });

    renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, tier.pixelRatio));
    renderer.setSize(canvas.clientWidth || 1280, canvas.clientHeight || 720, false);

    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // The pipeline performs its own filmic grade, so the renderer stays linear and
    // hands an HDR buffer to post-processing.
    renderer.toneMapping = THREE.NoToneMapping;

    renderer.shadowMap.enabled = true;
    // three r185 removed PCFSoftShadowMap: WebGLShadowMap silently rewrites it to
    // PCFShadowMap on the first shadow render, but programs compiled before that (the
    // up-front renderer.compile in main.js) are built with the BASIC shadow define and
    // declare `sampler2D` where the depth texture is created in comparison mode. That
    // mismatch makes the driver reject every shadow-receiving draw. Ask for the type
    // the renderer is going to use anyway.
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // One shadow render per presented frame, not one per renderer.render call: the
    // cockpit mirror pass and the main scene pass both go through WebGLRenderer.render,
    // and with autoUpdate on that re-rasterises the sun's shadow map twice for an
    // identical result (SkySystem fits the shadow camera once, from scene.onBeforeRender
    // on the main camera). `present()` re-arms it each frame; it starts armed so any
    // render during init still gets a real shadow map.
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;

    renderer.info.autoReset = false;
    return renderer;
  }

  _resolvePixelRatio() {
    return Math.min(globalThis.devicePixelRatio ?? 1, this.ctx.quality.pixelRatio);
  }

  /** Register a system. Order matters: systems update in registration order. */
  add(system) {
    this.systems.push(system);
    if (system.constructor?.systemName) {
      this.ctx[system.constructor.systemName] = system;
    } else if (system.systemName) {
      this.ctx[system.systemName] = system;
    }
    return system;
  }

  get(name) {
    return this.ctx[name];
  }

  async init() {
    for (const system of this.systems) {
      if (typeof system.init === 'function') {
        await system.init(this.ctx);
      }
    }
    this._resize(true);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._lastTime = performance.now();
    this._accumulator = 0;
    const loop = (now) => {
      this._rafId = requestAnimationFrame(loop);
      this._tick(now);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = 0;
  }

  _tick(now) {
    const ctx = this.ctx;
    let frameTime = (now - this._lastTime) / 1000;
    this._lastTime = now;

    // Clamp: a long GC pause or a backgrounded tab must not teleport the car.
    frameTime = clamp(frameTime, 0, 0.25);

    this._fpsAccum += frameTime;
    this._fpsFrames++;
    if (this._fpsAccum >= 0.5) {
      ctx.time.fps = this._fpsFrames / this._fpsAccum;
      this._fpsAccum = 0;
      this._fpsFrames = 0;
    }

    if (!ctx.paused) {
      this._accumulator += frameTime;
      let steps = 0;
      while (this._accumulator >= FIXED_DT && steps < MAX_STEPS_PER_FRAME) {
        this.step(FIXED_DT);
        this._accumulator -= FIXED_DT;
        steps++;
      }
      if (steps === MAX_STEPS_PER_FRAME) {
        // We are behind: drop the backlog rather than accumulating debt.
        this._accumulator = 0;
      }
    }

    ctx.time.alpha = ctx.paused ? 1 : this._accumulator / FIXED_DT;

    this.present(ctx.time.alpha);
  }

  /** One fixed logic step. Exposed so headless/deterministic harnesses can drive it. */
  step(dt) {
    const ctx = this.ctx;
    ctx.time.dt = dt;
    ctx.time.elapsed += dt;
    for (let i = 0; i < this.systems.length; i++) {
      const s = this.systems[i];
      if (typeof s.update === 'function') s.update(dt, ctx);
    }
    ctx.input?.endFrame?.();
  }

  /** Interpolate visuals and draw one frame. */
  present(alpha) {
    const ctx = this.ctx;
    // `frame` counts frames *drawn*, so it is stamped here rather than in `_tick`.
    // Systems use it to do a piece of per-frame work exactly once even when the scene
    // is walked several times by the pipeline, and the capture harness drives `step`
    // and `present` directly with the rAF loop stopped — if this lived in `_tick` the
    // counter would be frozen for the whole of a headless capture and every one of
    // those once-per-frame jobs would run once and then never again.
    ctx.time.frame = ++this._frame;
    // Re-arm the shadow pass for this frame (see _createRenderer).
    this.renderer.shadowMap.needsUpdate = true;
    for (let i = 0; i < this.systems.length; i++) {
      const s = this.systems[i];
      if (typeof s.lateUpdate === 'function') s.lateUpdate(alpha, ctx);
    }

    this.renderer.info.reset();
    if (ctx.pipeline?.render) {
      ctx.pipeline.render(ctx);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  _resize(force) {
    const canvas = this.canvas;
    const width = canvas.clientWidth || globalThis.innerWidth || 1280;
    const height = canvas.clientHeight || globalThis.innerHeight || 720;
    if (!force && this._lastW === width && this._lastH === height) return;
    this._lastW = width;
    this._lastH = height;

    this.renderer.setPixelRatio(this._resolvePixelRatio());
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();

    for (const s of this.systems) {
      if (typeof s.resize === 'function') s.resize(width, height, this.ctx);
    }
    this.ctx.events.emit('engine:resize', { width, height });
  }

  dispose() {
    this.stop();
    globalThis.removeEventListener('resize', this._onResize);
    for (const s of this.systems) s.dispose?.();
    this.systems.length = 0;
    this.renderer.dispose();
  }
}

export { FIXED_DT, FIXED_HZ };
