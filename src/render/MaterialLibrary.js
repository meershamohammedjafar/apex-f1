import * as THREE from "three";
import {
  makeDataTexture,
  yieldFrame,
  mipChain,
  normalMipChain,
  applyToksvig
} from "./textures/NoiseTextures.js";
import {
  buildAsphaltFields,
  asphaltSurface,
  asphaltNormal,
  buildAsphaltPatch,
  buildRacingLine,
  buildPaintLine,
  buildKerb,
  buildGrass,
  buildAstroturf,
  buildGravel,
  buildSand,
  buildConcrete
} from "./textures/SurfaceTextures.js";
import {
  buildCarbonTwill,
  buildPaintFlakeNormal,
  buildTyreTread,
  buildTyreSidewall,
  buildMachinedMetal,
  buildBrakeDisc,
  buildExhaustMetal,
  buildNomex,
  buildSuede,
  buildWheelGrip,
  buildDisplayScreen,
  buildLedStrip,
  buildVisor,
  COMPOUND_COLORS
} from "./textures/CarTextures.js";
import {
  buildCrowdAtlas,
  buildGrandstand,
  buildSponsorBoards,
  buildPitBuilding,
  buildTyreWall,
  buildArmco,
  buildDebrisFence,
  buildTreeBark,
  buildTreeCanopy,
  buildMarshalPost,
  buildTunnelWall
} from "./textures/TracksideTextures.js";
export const TEAM_LIVERIES = [
  { id: "corsa", name: "Scuderia Corsa", primary: 14159914, secondary: 1579036, accent: 15918652 },
  { id: "argent", name: "Argent Motorsport", primary: 49842, secondary: 12896978, accent: 1052692 },
  { id: "redline", name: "Redline Racing", primary: 1450319, secondary: 13898288, accent: 16106496 },
  { id: "albion", name: "Albion Grand Prix", primary: 16742912, secondary: 1777450, accent: 15790320 },
  { id: "aurora", name: "Aurora Racing", primary: 23118, secondary: 12177971, accent: 15921902 },
  { id: "bleunord", name: "Bleu Nord", primary: 683742, secondary: 16053490, accent: 13898288 },
  { id: "sentinel", name: "Sentinel F1", primary: 2771612, secondary: 16777215, accent: 13568556 },
  { id: "vulcan", name: "Vulcan Racing", primary: 7326207, secondary: 657936, accent: 16777215 },
  { id: "kestrel", name: "Kestrel Motors", primary: 1710622, secondary: 11855360, accent: 9145234 },
  { id: "meridian", name: "Meridian Racing", primary: 8065072, secondary: 15262940, accent: 13214247 }
];
export const MATERIAL_NAMES = [
  "asphalt",
  "asphalt_worn",
  "asphalt_patch",
  "racing_line",
  "kerb",
  "kerb_exit",
  "concrete",
  "paint_line",
  "grass",
  "gravel",
  "astroturf",
  "sand",
  "tyrewall",
  "armco",
  "debris_fence",
  "grandstand",
  "crowd",
  "pit_building",
  "sponsor_board",
  "tree_bark",
  "tree_canopy",
  "marshal_post",
  "tunnel_wall",
  "carbon_matte",
  "carbon_gloss",
  "carbon_weave",
  "livery_primary",
  "livery_secondary",
  "livery_accent",
  "tyre_rubber",
  "tyre_sidewall",
  "wheel_rim",
  "brake_disc",
  "brake_caliper",
  "metal_raw",
  "metal_anodised",
  "chrome",
  "visor_glass",
  "halo",
  "suspension_arm",
  "exhaust_metal",
  "mirror_glass",
  "driver_suit",
  "driver_glove",
  "cockpit_padding",
  "wheel_grip",
  "display_screen",
  "led_strip"
];
const REGISTRY = MATERIAL_NAMES;
const TREAD_ROUGHNESS = 0.72;
const SIDEWALL_ROUGHNESS = 0.88;
const SUIT_RESPONSE = {
  color: 16777215,
  sheen: 0.22,
  sheenRoughness: 0.95,
  sheenColor: new THREE.Color(12104362),
  envMapIntensity: 0.62
};
export class MaterialLibrary {
  static systemName = "materials";
  constructor() {
    this._materials = new Map();
    this._sets = new Map();
    this._textures = new Set();
    this._liveries = new Map();
    this._extra = [];
    this._warned = new Set();
    this.ready = false;
    this.anisotropy = 1;
    this.textureScale = 1;
    this._onQuality = null;
  }
  async init(ctx) {
    this.ctx = ctx;
    this._applyTier(ctx.quality, ctx.renderer);
    await this._generate();
    for (const name of REGISTRY) this._materials.set(name, this._createMaterial(name));
    this._onQuality = (tier) => this.setQuality(tier);
    ctx.events?.on("quality:change", this._onQuality);
    this.ready = true;
  }
  _applyTier(tier, renderer) {
    this.tier = tier;
    this.textureScale = tier?.textureScale ?? 1;
    const max = renderer?.capabilities?.getMaxAnisotropy?.() ?? 16;
    this.anisotropy = Math.max(1, Math.min(tier?.anisotropy ?? 8, max));
  }
  _px(base) {
    return Math.max(32, Math.round(base * this.textureScale));
  }
  async _generate() {
    const asphaltSize = this._px(1024);
    const fields = buildAsphaltFields(asphaltSize, 1201);
    const normalBytes = asphaltNormal(fields, 1.1);
    const normalChain = normalMipChain(normalBytes, asphaltSize, asphaltSize);
    const sharedNormal = makeDataTexture(
      normalBytes,
      asphaltSize,
      asphaltSize,
      THREE.NoColorSpace,
      normalChain.levels
    );
    this._own(sharedNormal);
    await yieldFrame();
    const fresh = asphaltSurface(fields, 0.3, 4400);
    this._register("asphalt", {
      width: asphaltSize,
      height: asphaltSize,
      color: fresh.color,
      orm: fresh.orm,
      tileU: fields.tile,
      tileV: fields.tile
    }, { normalTexture: sharedNormal, normalLengths: normalChain.lengths, filtered: true });
    await yieldFrame();
    const worn = asphaltSurface(fields, 0.92, 4471);
    this._register("asphalt_worn", {
      width: asphaltSize,
      height: asphaltSize,
      color: worn.color,
      orm: worn.orm,
      tileU: fields.tile,
      tileV: fields.tile
    }, { normalTexture: sharedNormal, normalLengths: normalChain.lengths, filtered: true });
    await yieldFrame();
    this._register("asphalt_patch", buildAsphaltPatch(fields, 6100), { filtered: true });
    await yieldFrame();
    this._register("racing_line", buildRacingLine(this._px(512), this._px(256), 8800), { filtered: true });
    this._register("paint_line", buildPaintLine(this._px(256), 3300));
    await yieldFrame();
    this._register("kerb", buildKerb(this._px(512), this._px(128), "entry", 5150), { filtered: true });
    this._register("kerb_exit", buildKerb(this._px(512), this._px(128), "exit", 5150), { filtered: true });
    await yieldFrame();
    this._register("grass", buildGrass(this._px(512), 2400));
    this._register("astroturf", buildAstroturf(this._px(256), 7700));
    await yieldFrame();
    this._register("gravel", buildGravel(this._px(512), 9100));
    this._register("sand", buildSand(this._px(512), 3900));
    await yieldFrame();
    this._register("concrete", buildConcrete(this._px(512), 6600, "light"));
    await yieldFrame();
    this._register("carbon", buildCarbonTwill(this._px(512), 12, { gloss: 0.55, seed: 5501 }), { filtered: true });
    this._register("carbon_weave", buildCarbonTwill(this._px(768), 8, {
      gloss: 0.72,
      seed: 5533,
      normalStrength: 3.1,
      contrast: 1.35
    }), { filtered: true });
    const flake = buildPaintFlakeNormal(this._px(256), 7311);
    const flakeChain = normalMipChain(flake.normal, flake.width, flake.height);
    this._flakeNormal = makeDataTexture(
      flake.normal,
      flake.width,
      flake.height,
      THREE.NoColorSpace,
      flakeChain.levels
    );
    this._flakeNormal.repeat.set(16, 16);
    this._own(this._flakeNormal);
    this._flakeCarbon = this._flakeNormal.clone();
    this._flakeCarbon.repeat.set(4 / 42, 4 / 42);
    this._flakeCarbon.needsUpdate = true;
    this._own(this._flakeCarbon);
    this._flakeCockpit = this._flakeNormal.clone();
    this._flakeCockpit.repeat.set(4 / 62.5, 4 / 62.5);
    this._flakeCockpit.needsUpdate = true;
    this._own(this._flakeCockpit);
    await yieldFrame();
    this._register("tyre_tread", buildTyreTread(this._px(512), 4120), { filtered: true });
    this._register("tyre_sidewall", buildTyreSidewall(this._px(1024), this._px(256), "soft", 6712), { filtered: true });
    await yieldFrame();
    this._register("rim_metal", buildMachinedMetal(this._px(384), {
      roughness: 0.26,
      damage: 0.45,
      tint: 10133670,
      seed: 8420,
      tile: 0.35
    }), { filtered: true });
    this._register("metal_raw", buildMachinedMetal(this._px(256), {
      roughness: 0.4,
      damage: 0.7,
      tint: 11843774,
      seed: 8441,
      tile: 0.4
    }));
    this._register("metal_anodised", buildMachinedMetal(this._px(256), {
      roughness: 0.22,
      damage: 0.22,
      tint: 11054516,
      seed: 8459,
      tile: 0.3
    }), { filtered: true });
    this._register("chrome", buildMachinedMetal(this._px(256), {
      roughness: 0.045,
      damage: 0.06,
      tint: 15527922,
      seed: 8473,
      tile: 0.5,
      anisotropic: false
    }));
    this._register("halo_metal", buildMachinedMetal(this._px(512), {
      roughness: 0.44,
      damage: 0.24,
      tint: 12762292,
      seed: 8487,
      tile: 0.22
    }), { filtered: true });
    await yieldFrame();
    this._register("brake_disc", buildBrakeDisc(this._px(512), 2810));
    this._register("exhaust_metal", buildExhaustMetal(this._px(512), this._px(256), 9930));
    await yieldFrame();
    this._register("driver_suit", buildNomex(this._px(512), {
      seed: 3311,
      weave: 150,
      stitch: 3,
      tint: 14868182,
      roughness: 0.88,
      tile: 0.32,
      normalStrength: 2.6,
      seamRelief: 1
    }), { filtered: true });
    this._register("driver_glove", buildNomex(this._px(256), {
      seed: 3347,
      weave: 190,
      stitch: 0,
      tint: 2763825,
      roughness: 0.78,
      tile: 0.16,
      normalStrength: 2.2
    }), { filtered: true });
    this._register("cockpit_padding", buildSuede(this._px(256), {
      seed: 1177,
      tint: 1842208,
      roughness: 0.94,
      quilt: 3,
      tile: 0.25
    }));
    this._register("wheel_grip", buildWheelGrip(this._px(256), 5566));
    await yieldFrame();
    this._display = buildDisplayScreen(this._px(512), this._px(256));
    this._own(this._display.texture);
    this._displayNormal = makeDataTexture(this._display.normal, this._display.normalSize, this._display.normalSize);
    this._displayNormal.repeat.set(2, 1);
    this._own(this._displayNormal);
    this._register("led_strip", buildLedStrip(this._px(512), this._px(32)));
    this._register("visor_glass", buildVisor(this._px(256), 4455));
    await yieldFrame();
    const crowd = buildCrowdAtlas(this._px(1024), 4, 4, 90210);
    this._register("crowd", {
      width: crowd.width,
      height: crowd.height,
      color: crowd.color,
      tileU: crowd.tileU,
      tileV: crowd.tileV
    });
    this._crowdAtlas = { cols: crowd.cols, rows: crowd.rows };
    await yieldFrame();
    const boards = buildSponsorBoards(this._px(1024), this._px(512), 4747);
    this._register("sponsor_board", boards);
    this._sponsorRows = boards.rows;
    await yieldFrame();
    this._register("grandstand", buildGrandstand(this._px(384), 1818));
    this._register("pit_building", buildPitBuilding(this._px(512), 2626));
    await yieldFrame();
    this._register("tyrewall", buildTyreWall(this._px(384), 7373));
    this._register("armco", buildArmco(this._px(512), this._px(256), 5959));
    this._register("debris_fence", buildDebrisFence(this._px(512), 3131));
    await yieldFrame();
    this._register("tree_bark", buildTreeBark(this._px(256), this._px(512), 8181));
    this._register("tree_canopy", buildTreeCanopy(this._px(512), 6464));
    this._register("marshal_post", buildMarshalPost(this._px(256), 2121));
    this._register("tunnel_wall", buildTunnelWall(this._px(384), 1414));
    await yieldFrame();
  }
  _register(name, td, opts = {}) {
    const set = { tileU: td.tileU ?? 1, tileV: td.tileV ?? 1 };
    const filtered = opts.filtered === true;
    if (td.color) {
      set.map = this._make(
        td.color,
        td.width,
        td.height,
        THREE.SRGBColorSpace,
        filtered ? mipChain(td.color, td.width, td.height, true) : null
      );
    }
    let lengths = opts.normalLengths ?? null;
    if (opts.normalTexture) {
      set.normalMap = opts.normalTexture;
    } else if (td.normal) {
      if (filtered) {
        const chain = normalMipChain(td.normal, td.width, td.height);
        lengths = chain.lengths;
        set.normalMap = this._make(td.normal, td.width, td.height, THREE.NoColorSpace, chain.levels);
      } else {
        set.normalMap = this._make(td.normal, td.width, td.height, THREE.NoColorSpace);
      }
    }
    set.normalLengths = lengths;
    if (td.orm) {
      let mips = null;
      if (filtered) {
        mips = mipChain(td.orm, td.width, td.height, false);
        if (lengths) applyToksvig(mips, lengths);
      }
      set.ormMap = this._make(td.orm, td.width, td.height, THREE.NoColorSpace, mips);
      set.ormMap.channel = 0;
      const hist = new Float64Array(256);
      const texels = td.width * td.height;
      for (let i = 0; i < texels; i++) hist[td.orm[i * 4 + 1]]++;
      let rSum = 0;
      for (let i = 0; i < 256; i++) rSum += hist[i] * i;
      set.roughnessHist = hist;
      set.roughnessTexels = texels;
      set.roughnessMean = rSum / (texels * 255);
    }
    if (td.emissive) set.emissiveMap = this._make(td.emissive, td.width, td.height, THREE.SRGBColorSpace);
    this._sets.set(name, set);
    return set;
  }
  _make(data, w, h, colorSpace, mipmaps = null) {
    return this._own(makeDataTexture(data, w, h, colorSpace, mipmaps));
  }
  _own(tex) {
    tex.anisotropy = this.anisotropy;
    this._textures.add(tex);
    return tex;
  }
  _surface(setName, params = {}, opts = {}) {
    const set = this._sets.get(setName);
    const m = new THREE.MeshStandardMaterial({
      map: set.map ?? null,
      normalMap: set.normalMap ?? null,
      roughnessMap: set.ormMap ?? null,
      aoMap: set.ormMap ?? null,
      roughness: 1,
      metalness: opts.metal ? 1 : 0,
      metalnessMap: opts.metal ? set.ormMap ?? null : null,
      ...params
    });
    if (set.normalMap) m.normalScale.set(opts.normalScale ?? 1, opts.normalScale ?? 1);
    m.userData.tileU = set.tileU;
    m.userData.tileV = set.tileV;
    return m;
  }
  _pinRoughness(material, setName, target) {
    const set = this._sets.get(setName);
    const mean = set?.roughnessMean;
    if (!mean || mean <= 0) return material;
    const hist = set.roughnessHist;
    const texels = set.roughnessTexels || 1;
    const achieved = (scale2) => {
      let sum = 0;
      for (let i = 0; i < 256; i++) {
        if (hist[i] === 0) continue;
        sum += hist[i] * Math.min(1, scale2 * i / 255);
      }
      return sum / texels;
    };
    let lo = 0;
    let hi = 8;
    if (achieved(hi) < target) {
      lo = hi;
    } else {
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) * 0.5;
        if (achieved(mid) < target) lo = mid;
        else hi = mid;
      }
    }
    const scale = (lo + hi) * 0.5;
    material.roughness = scale;
    material.userData.roughnessTarget = target;
    material.userData.roughnessMapMean = mean;
    material.userData.roughnessAchieved = achieved(scale);
    return material;
  }
  _physical(setName, params = {}, opts = {}) {
    const set = this._sets.get(setName);
    const m = new THREE.MeshPhysicalMaterial({
      map: set?.map ?? null,
      normalMap: set?.normalMap ?? null,
      roughnessMap: set?.ormMap ?? null,
      aoMap: set?.ormMap ?? null,
      roughness: 1,
      metalness: opts.metal ? 1 : 0,
      metalnessMap: opts.metal ? set?.ormMap ?? null : null,
      ...params
    });
    if (set?.normalMap) m.normalScale.set(opts.normalScale ?? 1, opts.normalScale ?? 1);
    if (m.clearcoatNormalMap && opts.clearcoatNormalScale !== void 0) {
      m.clearcoatNormalScale.set(opts.clearcoatNormalScale, opts.clearcoatNormalScale);
    }
    if (set) {
      m.userData.tileU = set.tileU;
      m.userData.tileV = set.tileV;
    }
    return m;
  }
  _createMaterial(name) {
    switch (name) {
      case "asphalt":
        return this._physical("asphalt", {
          specularIntensity: 0.6,
          envMapIntensity: 0.85
        }, { normalScale: 1 });
      case "asphalt_worn":
        return this._physical("asphalt_worn", {
          specularIntensity: 0.62,
          envMapIntensity: 0.95
        }, { normalScale: 0.8 });
      case "asphalt_patch":
        return this._physical("asphalt_patch", {
          specularIntensity: 0.65,
          envMapIntensity: 0.9
        }, { normalScale: 1 });
      case "racing_line": {
        const m = this._physical("racing_line", {
          transparent: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -8,
          specularIntensity: 1,
          envMapIntensity: 0.85
        }, { normalScale: 0.45 });
        return m;
      }
      case "paint_line":
        return this._surface("paint_line", {
          transparent: true,
          alphaTest: 0.04,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -3,
          polygonOffsetUnits: -6,
          envMapIntensity: 1.05
        }, { normalScale: 0.7 });
      case "kerb":
        return this._surface("kerb", { envMapIntensity: 1 }, { normalScale: 1 });
      case "kerb_exit":
        return this._surface("kerb_exit", { envMapIntensity: 1 }, { normalScale: 0.85 });
      case "concrete":
        return this._surface("concrete", { envMapIntensity: 0.9 }, { normalScale: 1 });
      case "grass":
        return this._surface("grass", { envMapIntensity: 0.8 }, { normalScale: 1.3 });
      case "astroturf":
        return this._surface("astroturf", { envMapIntensity: 0.85 }, { normalScale: 1.1 });
      case "gravel":
        return this._surface("gravel", { envMapIntensity: 0.85 }, { normalScale: 1.35 });
      case "sand":
        return this._surface("sand", { envMapIntensity: 0.9 }, { normalScale: 1 });
      case "tyrewall":
        return this._surface("tyrewall", { envMapIntensity: 0.7 }, { normalScale: 1.1 });
      case "armco":
        return this._surface("armco", { envMapIntensity: 1.2 }, { metal: true, normalScale: 1 });
      case "debris_fence": {
        const m = this._surface("debris_fence", {
          alphaTest: 0.24,
          transparent: false,
          side: THREE.DoubleSide,
          envMapIntensity: 1.15
        }, { metal: true, normalScale: 1 });
        return m;
      }
      case "grandstand":
        return this._surface("grandstand", { envMapIntensity: 1 }, { metal: true, normalScale: 1 });
      case "crowd": {
        const m = this._surface("crowd", {
          alphaTest: 0.42,
          transparent: false,
          side: THREE.DoubleSide,
          roughness: 0.92,
          metalness: 0,
          envMapIntensity: 0.9
        });
        m.userData.atlas = this._crowdAtlas;
        return m;
      }
      case "pit_building":
        return this._surface("pit_building", { envMapIntensity: 1.25 }, { metal: true, normalScale: 1 });
      case "sponsor_board": {
        const m = this._surface("sponsor_board", { envMapIntensity: 1 }, { normalScale: 0.7 });
        m.userData.rows = this._sponsorRows;
        return m;
      }
      case "tree_bark":
        return this._surface("tree_bark", { envMapIntensity: 0.7 }, { normalScale: 1.2 });
      case "tree_canopy":
        return this._surface("tree_canopy", {
          alphaTest: 0.38,
          transparent: false,
          side: THREE.DoubleSide,
          envMapIntensity: 0.9
        }, { normalScale: 0.8 });
      case "marshal_post":
        return this._surface("marshal_post", { envMapIntensity: 1 }, { metal: true, normalScale: 0.9 });
      case "tunnel_wall":
        return this._surface("tunnel_wall", { envMapIntensity: 0.7 }, { normalScale: 1 });
      case "carbon_matte":
        return this._physical("carbon", {
          color: 16777215,
          clearcoat: 0.35,
          clearcoatRoughness: 0.38,
          clearcoatNormalMap: this._flakeCarbon ?? null,
          envMapIntensity: 1
        }, { normalScale: 1, clearcoatNormalScale: 0.35 });
      case "carbon_gloss":
        return this._physical("carbon", {
          color: 16777215,
          clearcoat: 1,
          clearcoatRoughness: 0.055,
          clearcoatNormalMap: this._flakeCarbon ?? null,
          envMapIntensity: 1.35
        }, { normalScale: 1.15, clearcoatNormalScale: 0.22 });
      case "carbon_weave":
        return this._physical("carbon_weave", {
          color: 16777215,
          clearcoat: 0.9,
          clearcoatRoughness: 0.08,
          clearcoatNormalMap: this._flakeCockpit ?? null,
          envMapIntensity: 1.25
        }, { normalScale: 1.35, clearcoatNormalScale: 0.18 });
      case "suspension_arm":
        return this._physical("carbon", {
          color: 12106948,
          clearcoat: 1,
          clearcoatRoughness: 0.09,
          envMapIntensity: 1.3
        }, { normalScale: 0.8 });
      case "livery_primary":
        return this._paint(TEAM_LIVERIES[0].primary);
      case "livery_secondary":
        return this._paint(TEAM_LIVERIES[0].secondary);
      case "livery_accent":
        return this._paint(TEAM_LIVERIES[0].accent);
      case "tyre_rubber": {
        const m = this._physical("tyre_tread", {
          color: 16777215,
          sheen: 0.35,
          sheenRoughness: 0.8,
          sheenColor: new THREE.Color(3816002),
          specularIntensity: 0.55,
          envMapIntensity: 0.9
        }, { normalScale: 1 });
        this._pinRoughness(m, "tyre_tread", TREAD_ROUGHNESS);
        applyContactPatch(m, 0.9, 0.46);
        return m;
      }
      case "tyre_sidewall": {
        const m = this._physical("tyre_sidewall", {
          color: 16777215,
          sheen: 0.26,
          sheenRoughness: 0.88,
          sheenColor: new THREE.Color(3421243),
          specularIntensity: 0.55,
          envMapIntensity: 0.85
        }, { normalScale: 1.15 });
        this._pinRoughness(m, "tyre_sidewall", SIDEWALL_ROUGHNESS);
        applyContactPatch(m, 0.94, 0.58);
        return m;
      }
      case "wheel_rim": {
        const m = this._surface("rim_metal", { envMapIntensity: 1 }, { metal: true, normalScale: 0.8 });
        this._pinRoughness(m, "rim_metal", 0.44);
        return m;
      }
      case "brake_disc": {
        const set = this._sets.get("brake_disc");
        const m = this._surface("brake_disc", {
          emissive: new THREE.Color(16777215),
          emissiveMap: set.emissiveMap ?? null,
          emissiveIntensity: 0,
          envMapIntensity: 0.8
        }, { metal: true, normalScale: 1 });
        m.userData.emissiveIntensityHot = 3.2;
        return m;
      }
      case "brake_caliper":
        return this._surface("metal_anodised", {
          color: 3948614,
          envMapIntensity: 1.1
        }, { metal: true, normalScale: 0.8 });
      case "metal_raw":
        return this._surface("metal_raw", { envMapIntensity: 1.2 }, { metal: true, normalScale: 0.8 });
      case "metal_anodised":
        return this._surface("metal_anodised", { envMapIntensity: 1.25 }, { metal: true, normalScale: 0.7 });
      case "chrome":
        return this._surface("chrome", { envMapIntensity: 1.5 }, { metal: true, normalScale: 0.4 });
      case "halo":
        return this._physical("halo_metal", {
          color: 16777215,
          roughness: 0.72,
          anisotropy: 0.4,
          anisotropyRotation: 0,
          envMapIntensity: 1.5
        }, { metal: true, normalScale: 0.55 });
      case "exhaust_metal":
        return this._surface("exhaust_metal", { envMapIntensity: 1.4 }, { metal: true, normalScale: 0.9 });
      case "visor_glass":
        return this._visor();
      case "mirror_glass": {
        const m = new THREE.MeshStandardMaterial({
          color: 13225684,
          metalness: 1,
          roughness: 0.035,
          envMapIntensity: 1.4
        });
        m.userData.acceptsRenderTarget = true;
        return m;
      }
      case "driver_suit":
        return this._physical("driver_suit", SUIT_RESPONSE, { normalScale: 1.3 });
      case "driver_glove":
        return this._physical("driver_glove", {
          color: 16777215,
          sheen: 0.26,
          sheenRoughness: 0.86,
          sheenColor: new THREE.Color(10133672),
          envMapIntensity: 0.7
        }, { normalScale: 1.25 });
      case "cockpit_padding":
        return this._physical("cockpit_padding", {
          color: 16777215,
          sheen: 0.62,
          sheenRoughness: 0.88,
          sheenColor: new THREE.Color(7237240),
          envMapIntensity: 0.6
        }, { normalScale: 1 });
      case "wheel_grip":
        return this._surface("wheel_grip", { envMapIntensity: 0.65 }, { normalScale: 1.1 });
      case "display_screen": {
        const m = new THREE.MeshStandardMaterial({
          color: 329226,
          roughness: 0.16,
          metalness: 0,
          normalMap: this._displayNormal,
          emissive: new THREE.Color(16777215),
          emissiveMap: this._display.texture,
          emissiveIntensity: 2.6,
          envMapIntensity: 0.5
        });
        m.normalScale.set(0.25, 0.25);
        m.userData.canvas = this._display.canvas;
        m.userData.context = this._display.context;
        m.userData.texture = this._display.texture;
        return m;
      }
      case "led_strip": {
        const set = this._sets.get("led_strip");
        const m = this._surface("led_strip", {
          emissive: new THREE.Color(16777215),
          emissiveMap: set.emissiveMap ?? null,
          emissiveIntensity: 3.4,
          envMapIntensity: 0.4
        }, { normalScale: 0.6 });
        m.userData.cells = 15;
        return m;
      }
      default: {
        if (!this._warned.has(name)) {
          this._warned.add(name);
          console.warn(`[materials] unknown material "${name}" — returning neutral placeholder`);
        }
        return new THREE.MeshStandardMaterial({ color: 10132126, roughness: 0.85, metalness: 0 });
      }
    }
  }
  _paint(color, opts = {}) {
    const m = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(color),
      roughness: opts.roughness ?? 0.32,
      metalness: opts.metalness ?? 0.06,
      clearcoat: opts.clearcoat ?? 1,
      clearcoatRoughness: opts.clearcoatRoughness ?? 0.03,
      clearcoatNormalMap: this._flakeNormal ?? null,
      envMapIntensity: opts.envMapIntensity ?? 1.5
    });
    m.clearcoatNormalScale.set(0.28, 0.28);
    return m;
  }
  _visor() {
    const set = this._sets.get("visor_glass");
    const transmissive = this.tier?.name !== "low";
    const m = new THREE.MeshPhysicalMaterial({
      map: set.map,
      normalMap: set.normalMap,
      roughnessMap: set.ormMap,
      roughness: 1,
      metalness: 0,
      ior: 1.585,
      transmission: transmissive ? 0.92 : 0,
      thickness: 25e-4,
      attenuationDistance: 0.05,
      attenuationColor: new THREE.Color(9413816),
      clearcoat: 1,
      clearcoatRoughness: 0.02,
      transparent: true,
      opacity: transmissive ? 1 : 0.34,
      depthWrite: false,
      side: THREE.FrontSide,
      envMapIntensity: 1.4
    });
    m.normalScale.set(0.5, 0.5);
    m.userData.tileU = set.tileU;
    m.userData.tileV = set.tileV;
    return m;
  }
  get(name) {
    let m = this._materials.get(name);
    if (!m) {
      m = this._createMaterial(name);
      this._materials.set(name, m);
    }
    return m;
  }
  texture(name, channel = "map") {
    const key = TEXTURE_SET_ALIASES[name] ?? name;
    const set = this._sets.get(key);
    if (!set) {
      if (name === "livery_primary" || name === "livery_secondary" || name === "livery_accent") {
        return this._flakeNormal;
      }
      if (name === "display_screen") return this._display?.texture ?? null;
      if (!this._warned.has(`tex:${name}`)) {
        this._warned.add(`tex:${name}`);
        console.warn(`[materials] no texture set for "${name}"`);
      }
      return null;
    }
    if (channel === "normal") return set.normalMap ?? null;
    if (channel === "orm" || channel === "roughness" || channel === "ao") return set.ormMap ?? null;
    if (channel === "emissive") return set.emissiveMap ?? null;
    return set.map ?? null;
  }
  tileSize(name, out = { u: 1, v: 1 }) {
    const set = this._sets.get(TEXTURE_SET_ALIASES[name] ?? name);
    out.u = set?.tileU ?? 1;
    out.v = set?.tileV ?? 1;
    return out;
  }
  clone(name) {
    const m = this.get(name).clone();
    m.userData = { ...this.get(name).userData };
    this._extra.push(m);
    return m;
  }
  makeLivery(teamColors) {
    const c = normaliseLivery(teamColors);
    const key = `${c.primary}|${c.secondary}|${c.accent}`;
    const cached = this._liveries.get(key);
    if (cached) return cached;
    const livery = {
      colors: c,
      primary: this._paint(c.primary),
      secondary: this._paint(c.secondary),
      accent: this._paint(c.accent),
      matte: this._paint(c.primary, { roughness: 0.52, clearcoat: 0.35, clearcoatRoughness: 0.3, envMapIntensity: 1 }),
      wing: this._paint(c.secondary, { envMapIntensity: 1.7 }),
      carbon: this.get("carbon_gloss"),
      carbonMatte: this.get("carbon_matte"),
      halo: this.get("halo"),
      rim: this.get("wheel_rim")
    };
    livery.suit = this._physical("driver_suit", {
      ...SUIT_RESPONSE,
      color: new THREE.Color(c.primary),
      sheenColor: new THREE.Color(c.primary).lerp(SUIT_RESPONSE.sheenColor, 0.68)
    }, { normalScale: 1.3 });
    livery.helmet = this._paint(c.accent, { clearcoatRoughness: 0.02, envMapIntensity: 1.6 });
    for (const k of ["primary", "secondary", "accent", "matte", "wing", "suit", "helmet"]) {
      this._extra.push(livery[k]);
    }
    this._liveries.set(key, livery);
    return livery;
  }
  tyreSidewall(compound = "soft") {
    const key = `tyre_sidewall_${compound}`;
    const cached = this._materials.get(key);
    if (cached) return cached;
    if (!(compound in COMPOUND_COLORS)) return this.get("tyre_sidewall");
    const td = buildTyreSidewall(this._px(1024), this._px(256), compound, 6712);
    this._register(key, td, { filtered: true });
    const m = applyContactPatch(this._pinRoughness(this._physical(key, {
      color: 16777215,
      sheen: 0.26,
      sheenRoughness: 0.88,
      sheenColor: new THREE.Color(3421243),
      specularIntensity: 0.55,
      envMapIntensity: 0.85
    }, { normalScale: 1.15 }), key, SIDEWALL_ROUGHNESS), 0.94, 0.58);
    this._materials.set(key, m);
    return m;
  }
  contactShadow() {
    const cached = this._materials.get("tyre_contact_shadow");
    if (cached) return cached;
    const m = new THREE.ShaderMaterial({
      name: "ApexContactShadow",
      uniforms: {
        uPatch: { value: new THREE.Vector2(0.48, 0.39) },
        uCore: { value: 0.24 },
        uSkirt: { value: 0.55 }
      },
      vertexShader: (
        `
        varying vec2 vApexUv;
        void main() {
          vApexUv = uv;
          vec4 world = vec4( position, 1.0 );
          #ifdef USE_INSTANCING
            world = instanceMatrix * world;
          #endif
          gl_Position = projectionMatrix * modelViewMatrix * world;
        }
      `
      ),
      fragmentShader: (
        `
        precision highp float;
        uniform vec2 uPatch;
        uniform float uCore;
        uniform float uSkirt;
        varying vec2 vApexUv;

        void main() {
          vec2 p = vApexUv * 2.0 - 1.0;
          float skirtD = length( p );
          if ( skirtD >= 1.0 ) discard;
          float coreD = length( p / uPatch );
          float core = 1.0 - smoothstep( 0.75, 1.30, coreD );
          float skirt = 1.0 - smoothstep( 0.0, 1.0, skirtD );
          float occl = clamp( core + skirt * uSkirt, 0.0, 1.0 );
          gl_FragColor = vec4( vec3( mix( 1.0, uCore, occl ) ), 1.0 );
        }
      `
      ),
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.SrcColorFactor,
      blendEquationAlpha: THREE.AddEquation,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -12,
      fog: false,
      toneMapped: false
    });
    this._materials.set("tyre_contact_shadow", m);
    return m;
  }
  setQuality(tier) {
    if (!tier) return;
    this._applyTier(tier, this.ctx?.renderer);
    for (const tex of this._textures) {
      tex.anisotropy = this.anisotropy;
      tex.needsUpdate = true;
    }
    const visor = this._materials.get("visor_glass");
    if (visor) {
      const transmissive = tier.name !== "low";
      visor.transmission = transmissive ? 0.92 : 0;
      visor.opacity = transmissive ? 1 : 0.34;
      visor.needsUpdate = true;
    }
  }
  dispose() {
    this.ctx?.events?.off?.("quality:change", this._onQuality);
    for (const m of this._materials.values()) m.dispose();
    for (const m of this._extra) m.dispose();
    for (const tex of this._textures) tex.dispose();
    this._materials.clear();
    this._sets.clear();
    this._textures.clear();
    this._liveries.clear();
    this._extra.length = 0;
    this._flakeNormal = null;
    this._flakeCarbon = null;
    this._flakeCockpit = null;
    this._displayNormal = null;
    this._display = null;
    this.ready = false;
  }
}
const TEXTURE_SET_ALIASES = {
  carbon_matte: "carbon",
  carbon_gloss: "carbon",
  suspension_arm: "carbon",
  tyre_rubber: "tyre_tread",
  wheel_rim: "rim_metal",
  brake_caliper: "metal_anodised",
  halo: "halo_metal"
};
function applyContactPatch(material, cosStart, aoFloor, squash = 0.012) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uApexContactStart = { value: cosStart };
    shader.uniforms.uApexContactAo = { value: aoFloor };
    shader.uniforms.uApexSquash = { value: squash };
    shader.vertexShader = shader.vertexShader.replace("void main() {", "uniform float uApexContactStart;\nuniform float uApexSquash;\nvarying float vApexContact;\nvoid main() {").replace("#include <begin_vertex>", `#include <begin_vertex>
      #ifdef USE_INSTANCING
        mat4 apexWheel = modelMatrix * instanceMatrix;
        vec3 apexCentre = ( apexWheel * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
        vec3 apexRadial = ( apexWheel * vec4( transformed, 1.0 ) ).xyz - apexCentre;
        float apexDown = -apexRadial.y / max( length( apexRadial ), 1e-4 );
        vApexContact = smoothstep( uApexContactStart, 1.0, apexDown );
        float apexOuter = length( apexWheel[ 1 ].xyz );
        float apexGap = apexOuter + apexRadial.y;
        float apexQ = apexGap / max( uApexSquash, 1e-5 );
        float apexPush = apexGap * ( 1.0 - smoothstep( 1.0, 2.2, apexQ ) );
        if ( apexPush > 0.0 ) {
          transformed -= inverse( mat3( apexWheel ) ) * vec3( 0.0, apexPush, 0.0 );
        }
      #else
        vApexContact = 0.0;
      #endif`);
    shader.fragmentShader = shader.fragmentShader.replace("void main() {", "uniform float uApexContactAo;\nvarying float vApexContact;\nvoid main() {").replace("#include <aomap_fragment>", `#include <aomap_fragment>
      float apexPatchAo = mix( 1.0, uApexContactAo, vApexContact );
      reflectedLight.indirectDiffuse *= apexPatchAo;
      reflectedLight.indirectSpecular *= apexPatchAo;`);
  };
  material.customProgramCacheKey = () => "apex_tyre_contact_patch";
  return material;
}
function toHex(v, fallback) {
  if (typeof v === "number" && Number.isFinite(v)) return v >>> 0;
  if (typeof v === "string") {
    const c = new THREE.Color(v);
    return Math.round(c.r * 255) << 16 | Math.round(c.g * 255) << 8 | Math.round(c.b * 255);
  }
  if (v && typeof v.getHex === "function") return v.getHex();
  return fallback;
}
function normaliseLivery(input) {
  if (Array.isArray(input)) {
    return {
      primary: toHex(input[0], 14159914),
      secondary: toHex(input[1], 1579036),
      accent: toHex(input[2], 15918652)
    };
  }
  const o = input ?? {};
  return {
    primary: toHex(o.primary ?? o.base ?? o[0], 14159914),
    secondary: toHex(o.secondary ?? o.trim ?? o[1], 1579036),
    accent: toHex(o.accent ?? o.detail ?? o[2], 15918652)
  };
}
export { COMPOUND_COLORS };
