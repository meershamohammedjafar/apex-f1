import { Engine } from "./core/Engine.js";
import { Input } from "./core/Input.js";
import { MaterialLibrary } from "./render/MaterialLibrary.js";
import { SkySystem } from "./render/SkySystem.js";
import { Track } from "./track/Track.js";
import { CarManager } from "./car/CarManager.js";
import { CameraRig } from "./game/CameraRig.js";
import { EffectsSystem } from "./fx/EffectsSystem.js";
import { AudioEngine } from "./audio/AudioEngine.js";
import { RaceDirector } from "./game/RaceDirector.js";
import { HUD } from "./ui/HUD.js";
import { RenderPipeline } from "./render/RenderPipeline.js";
import { LoadingScreen } from "./ui/LoadingScreen.js";
import { MainMenu } from "./ui/MainMenu.js";
async function boot() {
  const canvas = document.getElementById("viewport");
  const uiRoot = document.getElementById("ui-root");
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  const overrides = {};
  if (params.has("quality")) overrides.quality = params.get("quality");
  if (params.has("tod")) overrides.timeOfDay = Number(params.get("tod"));
  if (params.has("weather")) overrides.weather = params.get("weather");
  if (params.has("fov")) overrides.fov = Number(params.get("fov"));
  const loading = new LoadingScreen(uiRoot);
  loading.show();
  const engine = new Engine(canvas, { ui: uiRoot, settings: overrides });
  engine.ctx.captureMode = params.get("shot") === "1";
  engine.ctx.scenario = params.get("scenario") ?? "default";
  engine.add(new Input());
  engine.add(new MaterialLibrary());
  engine.add(new SkySystem());
  engine.add(new Track());
  engine.add(new CarManager());
  engine.add(new RaceDirector());
  engine.add(new CameraRig());
  engine.add(new EffectsSystem());
  engine.add(new AudioEngine());
  engine.add(new HUD());
  engine.add(new RenderPipeline());
  const stages = [
    "Generating circuit geometry",
    "Compiling materials",
    "Building atmosphere",
    "Assembling cars",
    "Warming shaders"
  ];
  let stage = 0;
  const stageTimer = setInterval(() => {
    if (stage < stages.length) loading.setStatus(stages[stage++], stage / stages.length);
  }, 220);
  try {
    await engine.init();
  } catch (err) {
    clearInterval(stageTimer);
    loading.setError(err);
    console.error("[apex] initialisation failed", err);
    throw err;
  }
  clearInterval(stageTimer);
  loading.setStatus("Warming shaders", 0.96);
  engine.renderer.compile(engine.scene, engine.camera);
  await new Promise((r) => requestAnimationFrame(r));
  engine.present(0);
  loading.hide();
  engine.start();
  const autostart = params.get("autostart") === "1";
  if (!engine.ctx.captureMode) {
    const menu = new MainMenu(engine.ctx, uiRoot);
    engine.ctx.mainMenu = menu;
    menu.onStart(() => {
      engine.ctx.paused = false;
      if (engine.ctx.input) engine.ctx.input.enabled = true;
      engine.ctx.input?.resyncGamepad?.();
      engine.ctx.input?.endFrame?.();
    });
    if (autostart) {
      menu.applyToSession({
        session: params.get("session") ?? "race",
        laps: Number(params.get("laps")) || void 0,
        skill: Number(params.get("skill")) || 0.78
      });
      engine.ctx.input?.resyncGamepad?.();
    } else {
      engine.ctx.paused = true;
      menu.show();
    }
  }
  const resumeAudio = () => {
    engine.ctx.audio?.resume?.();
    globalThis.removeEventListener("pointerdown", resumeAudio);
    globalThis.removeEventListener("keydown", resumeAudio);
  };
  globalThis.addEventListener("pointerdown", resumeAudio);
  globalThis.addEventListener("keydown", resumeAudio);
  globalThis.APEX = engine;
  globalThis.__APEX_READY__ = true;
}
boot().catch((err) => {
  console.error(err);
  globalThis.__APEX_ERROR__ = String(err?.stack ?? err);
});
