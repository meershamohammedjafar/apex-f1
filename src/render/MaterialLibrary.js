import * as THREE from 'three';
import {
  makeDataTexture, yieldFrame, mipChain, normalMipChain, applyToksvig,
} from './textures/NoiseTextures.js';
import {
  buildAsphaltFields, asphaltSurface, asphaltNormal, buildAsphaltPatch, buildRacingLine,
  buildPaintLine, buildKerb, buildGrass, buildAstroturf, buildGravel, buildSand, buildConcrete,
} from './textures/SurfaceTextures.js';
import {
  buildCarbonTwill, buildPaintFlakeNormal, buildTyreTread, buildTyreSidewall,
  buildMachinedMetal, buildBrakeDisc, buildExhaustMetal, buildNomex, buildSuede,
  buildWheelGrip, buildDisplayScreen, buildLedStrip, buildVisor, COMPOUND_COLORS,
} from './textures/CarTextures.js';
import {
  buildCrowdAtlas, buildGrandstand, buildSponsorBoards, buildPitBuilding, buildTyreWall,
  buildArmco, buildDebrisFence, buildTreeBark, buildTreeCanopy, buildMarshalPost,
  buildTunnelWall,
} from './textures/TracksideTextures.js';

/**
 * The procedural PBR material library (CONTRACT.md §5).
 *
 * Two structural decisions shape everything below.
 *
 * 1. **ORM packing.** three samples `aoMap` from red, `roughnessMap` from green and
 *    `metalnessMap` from blue, so one RGBA upload feeds all three slots. That cuts the
 *    texture count per material from four to three and, more importantly, the sampler
 *    count in the fragment shader. `channel = 0` is forced on the packed texture because
 *    `aoMap` otherwise defaults to the second UV set, which most of our geometry has no
 *    reason to carry.
 *
 * 2. **Field sharing.** The tarmac cellular pass is by far the most expensive thing here,
 *    so it runs once and every asphalt wear state is a re-colouring of the same height,
 *    stone and aggregate-id fields. `asphalt` and `asphalt_worn` even share one normal map.
 *
 * Generation is staged: each group awaits a frame so the loading screen keeps animating.
 */

/**
 * Ten fictional constructors. Invented outright — no real team name, colour scheme or
 * sponsor appears in APEX — but the palettes span the same range of hue and value a real
 * grid does, so a field of twenty cars reads correctly at a glance.
 */
export const TEAM_LIVERIES = [
  { id: 'corsa', name: 'Scuderia Corsa', primary: 0xd8102a, secondary: 0x18181c, accent: 0xf2e63c },
  { id: 'argent', name: 'Argent Motorsport', primary: 0x00c2b2, secondary: 0xc4cad2, accent: 0x101014 },
  { id: 'redline', name: 'Redline Racing', primary: 0x16214f, secondary: 0xd41230, accent: 0xf5c400 },
  { id: 'albion', name: 'Albion Grand Prix', primary: 0xff7a00, secondary: 0x1b1f2a, accent: 0xf0f0f0 },
  { id: 'aurora', name: 'Aurora Racing', primary: 0x005a4e, secondary: 0xb9d233, accent: 0xf2f2ee },
  { id: 'bleunord', name: 'Bleu Nord', primary: 0x0a6ede, secondary: 0xf4f4f2, accent: 0xd41230 },
  { id: 'sentinel', name: 'Sentinel F1', primary: 0x2a4a9c, secondary: 0xffffff, accent: 0xcf0a2c },
  { id: 'vulcan', name: 'Vulcan Racing', primary: 0x6fc9ff, secondary: 0x0a0a10, accent: 0xffffff },
  { id: 'kestrel', name: 'Kestrel Motors', primary: 0x1a1a1e, secondary: 0xb4e600, accent: 0x8b8b92 },
  { id: 'meridian', name: 'Meridian Racing', primary: 0x7b1030, secondary: 0xe8e4dc, accent: 0xc9a227 },
];

/** Every name the registry serves, in the order `init` builds them. */
export const MATERIAL_NAMES = [
  'asphalt', 'asphalt_worn', 'asphalt_patch', 'racing_line', 'kerb', 'kerb_exit', 'concrete',
  'paint_line', 'grass', 'gravel', 'astroturf', 'sand', 'tyrewall', 'armco', 'debris_fence',
  'grandstand', 'crowd', 'pit_building', 'sponsor_board', 'tree_bark', 'tree_canopy',
  'marshal_post', 'tunnel_wall', 'carbon_matte', 'carbon_gloss', 'carbon_weave',
  'livery_primary', 'livery_secondary', 'livery_accent', 'tyre_rubber', 'tyre_sidewall',
  'wheel_rim', 'brake_disc', 'brake_caliper', 'metal_raw', 'metal_anodised', 'chrome',
  'visor_glass', 'halo', 'suspension_arm', 'exhaust_metal', 'mirror_glass', 'driver_suit',
  'driver_glove', 'cockpit_padding', 'wheel_grip', 'display_screen', 'led_strip',
];

const REGISTRY = MATERIAL_NAMES;

/**
 * Pinned mean roughness for the two halves of a tyre. These are absolute numbers, not
 * multipliers on whatever the texture generator happens to emit: `_pinRoughness` measures
 * the map and scales the material so the average lands here. The 0.16 between them is the
 * whole reason a slick reads as a worked racing tyre rather than a moulded black donut —
 * the tread has been planed and glazed by the track, the flank has not.
 */
const TREAD_ROUGHNESS = 0.72;
const SIDEWALL_ROUGHNESS = 0.88;

/**
 * The fabric response for a Nomex race suit, shared by the registry material and every
 * team's coloured copy so the two can never drift apart.
 *
 * A dyed aramid twill is one of the flattest surfaces on the car. It was previously
 * carrying a strong white sheen at 0.72 sheen-roughness, which is the response of
 * polished latex, and combined with a saturated base colour that is precisely what made
 * the driver's arms read as red plasticine. What real Nomex has instead is a weak,
 * broad, *colour-tinted* fibre sheen — the fuzz standing off the weave is the same dyed
 * staple as the cloth, so it scatters the suit's own colour, not white — over a base
 * whose roughness never drops below 0.85. The visible response then comes from the
 * weave and the seams in the normal map, which is where it comes from in life.
 */
const SUIT_RESPONSE = {
  color: 0xffffff,
  sheen: 0.22,
  sheenRoughness: 0.95,
  sheenColor: new THREE.Color(0xb8b2aa),
  envMapIntensity: 0.62,
};

export class MaterialLibrary {
  static systemName = 'materials';

  constructor() {
    this._materials = new Map();
    this._sets = new Map();
    this._textures = new Set();
    this._liveries = new Map();
    this._extra = [];              // clones and per-team materials we also own
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
    ctx.events?.on('quality:change', this._onQuality);
    this.ready = true;
  }

  _applyTier(tier, renderer) {
    this.tier = tier;
    this.textureScale = tier?.textureScale ?? 1;
    const max = renderer?.capabilities?.getMaxAnisotropy?.() ?? 16;
    this.anisotropy = Math.max(1, Math.min(tier?.anisotropy ?? 8, max));
  }

  /** Quality-scaled pixel dimension, never below a size that still mips cleanly. */
  _px(base) {
    return Math.max(32, Math.round(base * this.textureScale));
  }

  // --- generation -----------------------------------------------------------------

  async _generate() {
    // Tarmac: one cellular pass, three wear states out of it.
    const asphaltSize = this._px(1024);
    const fields = buildAsphaltFields(asphaltSize, 1201);
    // 1.1 rather than the old 1.5: the aggregate is now at its real 5-15 mm scale, so
    // the same slope amplitude packs far more tilt per texel and reads as static noise.
    const normalBytes = asphaltNormal(fields, 1.1);
    const normalChain = normalMipChain(normalBytes, asphaltSize, asphaltSize);
    const sharedNormal = makeDataTexture(
      normalBytes, asphaltSize, asphaltSize, THREE.NoColorSpace, normalChain.levels,
    );
    this._own(sharedNormal);
    await yieldFrame();

    const fresh = asphaltSurface(fields, 0.30, 4400);
    this._register('asphalt', {
      width: asphaltSize, height: asphaltSize, color: fresh.color, orm: fresh.orm,
      tileU: fields.tile, tileV: fields.tile,
    }, { normalTexture: sharedNormal, normalLengths: normalChain.lengths, filtered: true });
    await yieldFrame();

    const worn = asphaltSurface(fields, 0.92, 4471);
    this._register('asphalt_worn', {
      width: asphaltSize, height: asphaltSize, color: worn.color, orm: worn.orm,
      tileU: fields.tile, tileV: fields.tile,
    }, { normalTexture: sharedNormal, normalLengths: normalChain.lengths, filtered: true });
    await yieldFrame();

    this._register('asphalt_patch', buildAsphaltPatch(fields, 6100), { filtered: true });
    await yieldFrame();

    this._register('racing_line', buildRacingLine(this._px(512), this._px(256), 8800), { filtered: true });
    this._register('paint_line', buildPaintLine(this._px(256), 3300));
    await yieldFrame();

    this._register('kerb', buildKerb(this._px(512), this._px(128), 'entry', 5150), { filtered: true });
    this._register('kerb_exit', buildKerb(this._px(512), this._px(128), 'exit', 5150), { filtered: true });
    await yieldFrame();

    this._register('grass', buildGrass(this._px(512), 2400));
    this._register('astroturf', buildAstroturf(this._px(256), 7700));
    await yieldFrame();

    this._register('gravel', buildGravel(this._px(512), 9100));
    this._register('sand', buildSand(this._px(512), 3900));
    await yieldFrame();

    this._register('concrete', buildConcrete(this._px(512), 6600, 'light'));
    await yieldFrame();

    // Composites. The body weave is shared by the matte and gloss lacquers; the cockpit
    // gets a higher-resolution copy because the driver's eye is 400 mm from it.
    this._register('carbon', buildCarbonTwill(this._px(512), 12, { gloss: 0.55, seed: 5501 }), { filtered: true });
    this._register('carbon_weave', buildCarbonTwill(this._px(768), 8, {
      gloss: 0.72, seed: 5533, normalStrength: 3.1, contrast: 1.35,
    }), { filtered: true });
    // Clearcoat micro-normal. This is the only relief the lacquer has, and at sixteen
    // tiles across a five-metre car it is minified hard from any camera that is not in
    // the cockpit — so it needs the same vector-averaged, renormalised chain every other
    // normal map in here gets. Left on the GPU's byte-space box filter it drifts off the
    // unit sphere as it shrinks, the clearcoat lobe loses its tilt, and a paint job with
    // clearcoat 1.0 declared on it reads as flat printed card at exactly the distance a
    // chase camera sits.
    const flake = buildPaintFlakeNormal(this._px(256), 7311);
    const flakeChain = normalMipChain(flake.normal, flake.width, flake.height);
    this._flakeNormal = makeDataTexture(
      flake.normal, flake.width, flake.height, THREE.NoColorSpace, flakeChain.levels,
    );
    this._flakeNormal.repeat.set(16, 16);
    this._own(this._flakeNormal);
    // Two more views of the same pixels for the composite materials.
    //
    // `repeat` is per-texture but the UVs underneath it are not the same on every
    // surface that wants orange peel. The livery wrap runs 0..1 over a five-metre car,
    // so 16 repeats puts the flake tile at its authored 250 mm. Carbon parts are
    // box-projected in *world* units at 42 uv per metre (CarModel.ROLE_TILING), so the
    // same texture at repeat 16 lands 672 tiles per metre — a 1.5 mm flake, finer than a
    // texel at any camera distance, which mips straight to flat and deletes the
    // clearcoat's orange peel entirely. That is why a lacquered carbon panel had a
    // geometrically perfect reflection and read as painted card. Cloning shares the
    // upload and costs nothing but a uv transform.
    this._flakeCarbon = this._flakeNormal.clone();
    this._flakeCarbon.repeat.set(4 / 42, 4 / 42);
    this._flakeCarbon.needsUpdate = true;
    this._own(this._flakeCarbon);
    this._flakeCockpit = this._flakeNormal.clone();
    this._flakeCockpit.repeat.set(4 / 62.5, 4 / 62.5);
    this._flakeCockpit.needsUpdate = true;
    this._own(this._flakeCockpit);
    await yieldFrame();

    this._register('tyre_tread', buildTyreTread(this._px(512), 4120), { filtered: true });
    this._register('tyre_sidewall', buildTyreSidewall(this._px(1024), this._px(256), 'soft', 6712), { filtered: true });
    await yieldFrame();

    // Forged magnesium wheel rim: a real conductor F0 (sRGB ~0x9aa0a6), not the
    // near-black 0x585c64 that made a machined rim read as painted plastic.
    this._register('rim_metal', buildMachinedMetal(this._px(384), {
      roughness: 0.26, damage: 0.45, tint: 0x9aa0a6, seed: 8420, tile: 0.35,
    }), { filtered: true });
    this._register('metal_raw', buildMachinedMetal(this._px(256), {
      roughness: 0.40, damage: 0.70, tint: 0xb4b8be, seed: 8441, tile: 0.4,
    }));
    this._register('metal_anodised', buildMachinedMetal(this._px(256), {
      roughness: 0.22, damage: 0.22, tint: 0xa8adb4, seed: 8459, tile: 0.3,
    }), { filtered: true });
    this._register('chrome', buildMachinedMetal(this._px(256), {
      roughness: 0.045, damage: 0.06, tint: 0xeceff2, seed: 8473, tile: 0.5, anisotropic: false,
    }));
    // Grade-5 titanium. A conductor's map colour is its F0, not an albedo, and
    // titanium reflects ~0.55 of what hits it — sRGB 0xc2bcb4. The 0x2b2d33 this
    // carried was a fifth of that: a metal that reflects nothing has no highlight to
    // travel along the tube and no sky to mirror, which is exactly why the halo read
    // as dark clay. `tile: 0.22` puts the draw marks at their real ~0.2 mm pitch.
    // The 0.44 roughness base is load-bearing: Cockpit.js multiplies this map by 0.68
    // to land its halo on ~0.32, so the base stays put and only the F0 and the scale
    // change here. `tile: 0.22` puts the draw marks at a legible pitch on a 45 mm tube.
    this._register('halo_metal', buildMachinedMetal(this._px(512), {
      roughness: 0.44, damage: 0.24, tint: 0xc2bcb4, seed: 8487, tile: 0.22,
    }), { filtered: true });
    await yieldFrame();

    this._register('brake_disc', buildBrakeDisc(this._px(512), 2810));
    this._register('exhaust_metal', buildExhaustMetal(this._px(512), this._px(256), 9930));
    await yieldFrame();

    // Nomex III: a matte aramid twill. 0.88 roughness because dyed aramid staple is
    // one of the flattest surfaces on the car — anything glossier reads as vinyl, which
    // is exactly what the driver's arms were doing. 0.32 m tile puts the thread pitch at
    // ~2.1 mm, big enough to survive minification at arm's length in the cockpit.
    this._register('driver_suit', buildNomex(this._px(512), {
      seed: 3311, weave: 150, stitch: 3, tint: 0xe2ded6, roughness: 0.88, tile: 0.32,
      normalStrength: 2.6, seamRelief: 1.0,
    }), { filtered: true });
    this._register('driver_glove', buildNomex(this._px(256), {
      seed: 3347, weave: 190, stitch: 0, tint: 0x2a2c31, roughness: 0.78, tile: 0.16,
      normalStrength: 2.2,
    }), { filtered: true });
    this._register('cockpit_padding', buildSuede(this._px(256), {
      seed: 1177, tint: 0x1c1c20, roughness: 0.94, quilt: 3, tile: 0.25,
    }));
    this._register('wheel_grip', buildWheelGrip(this._px(256), 5566));
    await yieldFrame();

    this._display = buildDisplayScreen(this._px(512), this._px(256));
    this._own(this._display.texture);
    this._displayNormal = makeDataTexture(this._display.normal, this._display.normalSize, this._display.normalSize);
    this._displayNormal.repeat.set(2, 1);
    this._own(this._displayNormal);
    this._register('led_strip', buildLedStrip(this._px(512), this._px(32)));
    this._register('visor_glass', buildVisor(this._px(256), 4455));
    await yieldFrame();

    // Crowd billboards are lit as flat cards, so the atlas ships colour only — a 1024²
    // normal map for something four pixels tall on screen is pure VRAM waste.
    const crowd = buildCrowdAtlas(this._px(1024), 4, 4, 90210);
    this._register('crowd', {
      width: crowd.width, height: crowd.height, color: crowd.color,
      tileU: crowd.tileU, tileV: crowd.tileV,
    });
    this._crowdAtlas = { cols: crowd.cols, rows: crowd.rows };
    await yieldFrame();

    const boards = buildSponsorBoards(this._px(1024), this._px(512), 4747);
    this._register('sponsor_board', boards);
    this._sponsorRows = boards.rows;
    await yieldFrame();

    this._register('grandstand', buildGrandstand(this._px(384), 1818));
    this._register('pit_building', buildPitBuilding(this._px(512), 2626));
    await yieldFrame();

    this._register('tyrewall', buildTyreWall(this._px(384), 7373));
    this._register('armco', buildArmco(this._px(512), this._px(256), 5959));
    this._register('debris_fence', buildDebrisFence(this._px(512), 3131));
    await yieldFrame();

    this._register('tree_bark', buildTreeBark(this._px(256), this._px(512), 8181));
    this._register('tree_canopy', buildTreeCanopy(this._px(512), 6464));
    this._register('marshal_post', buildMarshalPost(this._px(256), 2121));
    this._register('tunnel_wall', buildTunnelWall(this._px(384), 1414));
    await yieldFrame();
  }

  /**
   * Turn a TexData into a cached set of GPU textures.
   *
   * `opts.filtered` swaps GPU mip generation for our own chain: colour averaged in
   * linear light, normals averaged as vectors, and — the reason it exists — the
   * roughness channel raised by the normal variance each level threw away (Toksvig).
   * Without that last step every surface whose relief lives in its normal map keeps a
   * mirror-flat roughness at distance and sparkles. It is worth the milliseconds on
   * anything that covers a lot of screen at a shallow angle: tarmac above all.
   */
  _register(name, td, opts = {}) {
    const set = { tileU: td.tileU ?? 1, tileV: td.tileV ?? 1 };
    const filtered = opts.filtered === true;
    if (td.color) {
      set.map = this._make(td.color, td.width, td.height, THREE.SRGBColorSpace,
        filtered ? mipChain(td.color, td.width, td.height, true) : null);
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
      // aoMap defaults to uv1; our geometry only ships uv0.
      set.ormMap.channel = 0;
      // Histogram and mean of the roughness channel, measured once here. `_pinRoughness`
      // needs them to put a surface's *average* gloss on a specified number while keeping
      // every bit of the variation the texture authored, which is the only way to hit a
      // reviewed figure without flattening the map that carries the detail.
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

  /** Take ownership of a texture: tier filtering now, disposal later. */
  _own(tex) {
    tex.anisotropy = this.anisotropy;
    this._textures.add(tex);
    return tex;
  }

  // --- material construction ------------------------------------------------------

  /** MeshStandardMaterial wired to a packed set, with absolute roughness from the map. */
  _surface(setName, params = {}, opts = {}) {
    const set = this._sets.get(setName);
    const m = new THREE.MeshStandardMaterial({
      map: set.map ?? null,
      normalMap: set.normalMap ?? null,
      roughnessMap: set.ormMap ?? null,
      aoMap: set.ormMap ?? null,
      roughness: 1.0,
      metalness: opts.metal ? 1.0 : 0.0,
      metalnessMap: opts.metal ? (set.ormMap ?? null) : null,
      ...params,
    });
    if (set.normalMap) m.normalScale.set(opts.normalScale ?? 1, opts.normalScale ?? 1);
    m.userData.tileU = set.tileU;
    m.userData.tileV = set.tileV;
    return m;
  }

  /**
   * Put a mapped surface's mean roughness on an exact figure.
   *
   * three multiplies the roughness map by the material's scalar, so a material that wants
   * its map's absolute values runs at 1.0 — which leaves the average gloss wherever the
   * texture generator happened to land it. Scaling by target/mean instead moves the mean
   * on to the target exactly and scales the spread with it, so the cross-tread gloss step
   * that separates a scrubbed slick from a moulded prop survives intact. Returns the
   * measured mean so the caller (and the build log) can see what it actually got.
   */
  _pinRoughness(material, setName, target) {
    const set = this._sets.get(setName);
    const mean = set?.roughnessMean;
    if (!mean || mean <= 0) return material;
    // three evaluates roughness as min(1, scalar * texel), so a scalar above 1 clips the
    // top of the distribution and the achieved mean lands *under* the target. Solving for
    // the scalar against the map's own histogram — the function is monotonic, so ten
    // bisection steps are exact to four decimals — puts the post-clamp mean on the number
    // asked for whether the map needs scaling up or down, and gives up as much variation
    // as clipping costs and no more.
    const hist = set.roughnessHist;
    const texels = set.roughnessTexels || 1;
    const achieved = (scale) => {
      let sum = 0;
      for (let i = 0; i < 256; i++) {
        if (hist[i] === 0) continue;
        sum += hist[i] * Math.min(1, (scale * i) / 255);
      }
      return sum / texels;
    };
    let lo = 0;
    let hi = 8;
    if (achieved(hi) < target) {
      lo = hi;                       // unreachable: every texel is already saturated
    } else {
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) * 0.5;
        if (achieved(mid) < target) lo = mid; else hi = mid;
      }
    }
    const scale = (lo + hi) * 0.5;
    material.roughness = scale;
    material.userData.roughnessTarget = target;
    material.userData.roughnessMapMean = mean;
    material.userData.roughnessAchieved = achieved(scale);
    return material;
  }

  /** MeshPhysicalMaterial variant for anything with a clearcoat or a fabric sheen. */
  _physical(setName, params = {}, opts = {}) {
    const set = this._sets.get(setName);
    const m = new THREE.MeshPhysicalMaterial({
      map: set?.map ?? null,
      normalMap: set?.normalMap ?? null,
      roughnessMap: set?.ormMap ?? null,
      aoMap: set?.ormMap ?? null,
      roughness: 1.0,
      metalness: opts.metal ? 1.0 : 0.0,
      metalnessMap: opts.metal ? (set?.ormMap ?? null) : null,
      ...params,
    });
    if (set?.normalMap) m.normalScale.set(opts.normalScale ?? 1, opts.normalScale ?? 1);
    if (m.clearcoatNormalMap && opts.clearcoatNormalScale !== undefined) {
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
      // Dry tarmac is a dielectric, but it is a *porous* one: an open-graded surfacing
      // loses a large part of its coherent specular into voids far below texel size, so
      // it never returns what a smooth dielectric's F0 of 0.04 predicts. Left at full
      // strength — as this was — a bright cloudless sky lights the whole surface up at
      // shallow angles and a dry circuit reads as freshly rained on. `specularIntensity`
      // is the right knob: it scales the specular lobe alone and leaves the diffuse
      // albedo, and therefore the tarmac's value in shade, exactly where it was.
      //
      // 0.6 and not lower on purpose. Weather.js drives the wet look by dropping these
      // materials' roughness to 0.10 and multiplying envMapIntensity, and it does not
      // touch specularIntensity — so whatever is set here scales the wet mirror too.
      // 0.6 kills the false dry sheen and still leaves a wet track a mirror.
      case 'asphalt':
        return this._physical('asphalt', {
          specularIntensity: 0.6, envMapIntensity: 0.85,
        }, { normalScale: 1.0 });
      case 'asphalt_worn':
        return this._physical('asphalt_worn', {
          specularIntensity: 0.62, envMapIntensity: 0.95,
        }, { normalScale: 0.8 });
      case 'asphalt_patch':
        return this._physical('asphalt_patch', {
          specularIntensity: 0.65, envMapIntensity: 0.9,
        }, { normalScale: 1.0 });

      case 'racing_line': {
        // Laid over the tarmac as a decal: alpha-blended, depth-tested but not written,
        // and pushed toward the camera so it never z-fights the surface underneath.
        //
        // The line is a film of rubber that has filled the voids, so unlike the tarmac
        // it *is* a continuous dielectric surface: full specular intensity, but a
        // roughness that never goes below 0.5. The mirror-flat 0.30 it used to run at,
        // lifted by a 1.35 env multiplier, is what turned the driving line into a broad
        // wet sheen down the middle of a dry circuit — brighter than the tarmac either
        // side of it, when rubber is the darkest thing on a race track.
        const m = this._physical('racing_line', {
          transparent: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          polygonOffsetUnits: -8,
          specularIntensity: 1.0,
          envMapIntensity: 0.85,
        }, { normalScale: 0.45 });
        return m;
      }
      case 'paint_line':
        return this._surface('paint_line', {
          transparent: true,
          alphaTest: 0.04,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -3,
          polygonOffsetUnits: -6,
          envMapIntensity: 1.05,
        }, { normalScale: 0.7 });

      case 'kerb':
        return this._surface('kerb', { envMapIntensity: 1.0 }, { normalScale: 1.0 });
      case 'kerb_exit':
        return this._surface('kerb_exit', { envMapIntensity: 1.0 }, { normalScale: 0.85 });

      case 'concrete':
        return this._surface('concrete', { envMapIntensity: 0.9 }, { normalScale: 1.0 });
      case 'grass':
        return this._surface('grass', { envMapIntensity: 0.8 }, { normalScale: 1.3 });
      case 'astroturf':
        return this._surface('astroturf', { envMapIntensity: 0.85 }, { normalScale: 1.1 });
      case 'gravel':
        return this._surface('gravel', { envMapIntensity: 0.85 }, { normalScale: 1.35 });
      case 'sand':
        return this._surface('sand', { envMapIntensity: 0.9 }, { normalScale: 1.0 });

      case 'tyrewall':
        return this._surface('tyrewall', { envMapIntensity: 0.7 }, { normalScale: 1.1 });
      case 'armco':
        return this._surface('armco', { envMapIntensity: 1.2 }, { metal: true, normalScale: 1.0 });
      case 'debris_fence': {
        // Alpha-tested rather than blended: catch fencing is drawn hundreds of metres
        // deep and blending it would demand a sort we cannot afford.
        const m = this._surface('debris_fence', {
          alphaTest: 0.24,
          transparent: false,
          side: THREE.DoubleSide,
          envMapIntensity: 1.15,
        }, { metal: true, normalScale: 1.0 });
        return m;
      }
      case 'grandstand':
        return this._surface('grandstand', { envMapIntensity: 1.0 }, { metal: true, normalScale: 1.0 });
      case 'crowd': {
        const m = this._surface('crowd', {
          alphaTest: 0.42,
          transparent: false,
          side: THREE.DoubleSide,
          roughness: 0.92,
          metalness: 0,
          envMapIntensity: 0.9,
        });
        m.userData.atlas = this._crowdAtlas;
        return m;
      }
      case 'pit_building':
        return this._surface('pit_building', { envMapIntensity: 1.25 }, { metal: true, normalScale: 1.0 });
      case 'sponsor_board': {
        const m = this._surface('sponsor_board', { envMapIntensity: 1.0 }, { normalScale: 0.7 });
        m.userData.rows = this._sponsorRows;
        return m;
      }
      case 'tree_bark':
        return this._surface('tree_bark', { envMapIntensity: 0.7 }, { normalScale: 1.2 });
      case 'tree_canopy':
        return this._surface('tree_canopy', {
          alphaTest: 0.38,
          transparent: false,
          side: THREE.DoubleSide,
          envMapIntensity: 0.9,
        }, { normalScale: 0.8 });
      case 'marshal_post':
        return this._surface('marshal_post', { envMapIntensity: 1.0 }, { metal: true, normalScale: 0.9 });
      case 'tunnel_wall':
        return this._surface('tunnel_wall', { envMapIntensity: 0.7 }, { normalScale: 1.0 });

      // Carbon is two surfaces, not one: a woven substrate and a lacquer film over it.
      // Both need their own normal or the weave and the reflection agree with each
      // other and the panel collapses into a single flat facet. The substrate keeps the
      // twill's tow relief; the clearcoat gets the sprayed-lacquer orange peel, so the
      // sky it mirrors ripples across the tows instead of sliding over them.
      case 'carbon_matte':
        return this._physical('carbon', {
          color: 0xffffff,
          clearcoat: 0.35,
          clearcoatRoughness: 0.38,
          clearcoatNormalMap: this._flakeCarbon ?? null,
          envMapIntensity: 1.0,
        }, { normalScale: 1.0, clearcoatNormalScale: 0.35 });
      case 'carbon_gloss':
        return this._physical('carbon', {
          color: 0xffffff,
          clearcoat: 1.0,
          clearcoatRoughness: 0.055,
          clearcoatNormalMap: this._flakeCarbon ?? null,
          envMapIntensity: 1.35,
        }, { normalScale: 1.15, clearcoatNormalScale: 0.22 });
      case 'carbon_weave':
        // The cockpit copy: the driver's eye is 400 mm from this, so the tow relief runs
        // at full strength and the lacquer sits tight over it.
        return this._physical('carbon_weave', {
          color: 0xffffff,
          clearcoat: 0.9,
          clearcoatRoughness: 0.08,
          clearcoatNormalMap: this._flakeCockpit ?? null,
          envMapIntensity: 1.25,
        }, { normalScale: 1.35, clearcoatNormalScale: 0.18 });
      case 'suspension_arm':
        return this._physical('carbon', {
          color: 0xb8bcc4,
          clearcoat: 1.0,
          clearcoatRoughness: 0.09,
          envMapIntensity: 1.3,
        }, { normalScale: 0.8 });

      case 'livery_primary':
        return this._paint(TEAM_LIVERIES[0].primary);
      case 'livery_secondary':
        return this._paint(TEAM_LIVERIES[0].secondary);
      case 'livery_accent':
        return this._paint(TEAM_LIVERIES[0].accent);

      case 'tyre_rubber': {
        // The tread face is pinned to a mean roughness of 0.72 — a slick is neither felt
        // nor a mirror, and 0.72 is the reviewed figure. The map is kept, not replaced:
        // it authors a 0.66 glazed contact band against 0.83 torn shoulders, and
        // `_pinRoughness` slides that whole distribution so its average lands on 0.72
        // rather than the 0.75 the generator produced. The sheen lobe on top is the
        // grazing-angle scatter of hot worked rubber, which a plain rough dielectric has
        // no term for. metalness stays 0: rubber is a dielectric, and the only reason the
        // tread is not a flat grey wall is the roughness step and the crowned profile.
        //
        // What is gone is the clearcoat. A clearcoat is a *lacquer*: a second, smooth,
        // specular layer laid over the surface, with its own Fresnel and its own
        // roughness, and — this is the part that hurt — one that the base roughness does
        // nothing to widen. At clearcoatRoughness 0.50 its GGX peak is 5.1 against the
        // base lobe's 1.2, so wherever the sun sits behind the camera it returns four
        // times the base specular from a surface whose albedo is 0.028. Measured on
        // chase-hero, that put a sunlit rear slick at sRGB 152 against sunlit tarmac at
        // 79 — a black tyre reading twice as bright as the road it stands on, which is
        // exactly the "the tyre looks like a film you can see through" note. A racing
        // slick carries no lacquer; what the track lays on it is a glaze, and a glaze is
        // a change of roughness, which the pinned 0.72 already carries.
        //
        // `specularIntensity` finishes the job, for the reason the tarmac above it uses
        // the same knob: F0 = 0.04 is the reflectance of a *smooth* dielectric, and a
        // slick's surface is torn, marbled and coated in its own dust and pick-up, so a
        // large part of the coherent specular is scattered into structure far below texel
        // size and never comes back to the eye. 0.55 scales that lobe alone and leaves
        // the albedo, the normal map and the reviewed roughness untouched.
        const m = this._physical('tyre_tread', {
          color: 0xffffff,
          sheen: 0.35,
          sheenRoughness: 0.80,
          sheenColor: new THREE.Color(0x3a3a42),
          specularIntensity: 0.55,
          envMapIntensity: 0.9,
        }, { normalScale: 1.0 });
        this._pinRoughness(m, 'tyre_tread', TREAD_ROUGHNESS);
        applyContactPatch(m, 0.90, 0.46);
        return m;
      }
      case 'tyre_sidewall': {
        // 0.88 mean, against the tread's 0.72. That 0.16 step is the point: the flank of
        // a slick is unworked mould-finish rubber and the tread has been planed by the
        // track, so the two have to part company under the same sky or the tyre reads as
        // one extruded black cylinder however good its silhouette is.
        const m = this._physical('tyre_sidewall', {
          color: 0xffffff,
          sheen: 0.26,
          sheenRoughness: 0.88,
          sheenColor: new THREE.Color(0x34343b),
          // Same specular budget as the tread, and for the same reason: mould-finish
          // rubber under a film of its own dust is not a smooth dielectric.
          specularIntensity: 0.55,
          envMapIntensity: 0.85,
        }, { normalScale: 1.15 });
        this._pinRoughness(m, 'tyre_sidewall', SIDEWALL_ROUGHNESS);
        applyContactPatch(m, 0.94, 0.58);
        return m;
      }

      case 'wheel_rim': {
        // Forged magnesium, satin — not chrome.
        //
        // The map is authored at a mean roughness of about 0.30 and this ran it at 1.0
        // scalar with a 1.35 environment multiplier, which on a metalness-1 conductor is
        // a mirror. A mirror has no shading of its own: every normal on the hub returns
        // the same low-frequency environment, so the inboard face of a front wheel came
        // back as one flat green disc of reflected infield with the spoke webbing and the
        // barrel ribs invisible inside it. That disc, sitting in the middle of the tyre
        // with a wishbone crossing it, is a large part of why a critic reads the wheel as
        // a window rather than as a wheel — and it is the "wheel face reads flat" note in
        // as many words.
        //
        // 0.44 is a machined-and-used rim: hot, brake-dusted, rubber-flecked magnesium.
        // It is still unambiguously metal — the bead flange still throws a hard glint at
        // the sun, which is the feature that says "wheel" at distance — but the lobe is
        // now wide enough that the ten aero-cover ribs and the inboard spoke webbing each
        // shade differently, which is what gives the face its form back. `_pinRoughness`
        // is used rather than a flat scalar so the brushing, the pitting and the scratches
        // the generator authored all survive, scaled around the new mean.
        const m = this._surface('rim_metal', { envMapIntensity: 1.0 }, { metal: true, normalScale: 0.8 });
        this._pinRoughness(m, 'rim_metal', 0.44);
        return m;
      }
      case 'brake_disc': {
        const set = this._sets.get('brake_disc');
        const m = this._surface('brake_disc', {
          emissive: new THREE.Color(0xffffff),
          emissiveMap: set.emissiveMap ?? null,
          emissiveIntensity: 0.0,
          envMapIntensity: 0.8,
        }, { metal: true, normalScale: 1.0 });
        // Discs run 400-1000 C: the consumer ramps emissiveIntensity from brakeTemp.
        m.userData.emissiveIntensityHot = 3.2;
        return m;
      }
      case 'brake_caliper':
        return this._surface('metal_anodised', {
          color: 0x3c4046,
          envMapIntensity: 1.1,
        }, { metal: true, normalScale: 0.8 });

      case 'metal_raw':
        return this._surface('metal_raw', { envMapIntensity: 1.2 }, { metal: true, normalScale: 0.8 });
      case 'metal_anodised':
        return this._surface('metal_anodised', { envMapIntensity: 1.25 }, { metal: true, normalScale: 0.7 });
      case 'chrome':
        return this._surface('chrome', { envMapIntensity: 1.5 }, { metal: true, normalScale: 0.4 });
      case 'halo':
        // Machined grade-5 titanium, and the three things that make it read as metal
        // rather than as dark clay are all here: metalness pinned at 1.0 (the map's blue
        // channel only backs off where oxide has filled a pit), the F0 the map carries,
        // and enough environment to actually mirror the sky. The anisotropy is the tell
        // — the tube is drawn, so its grain runs lengthways and the specular lobe
        // stretches along u, which is along the hoop. That is what makes the sun smear
        // down the arc as the car turns instead of sliding along it as a dot.
        return this._physical('halo_metal', {
          color: 0xffffff,
          roughness: 0.72,
          anisotropy: 0.4,
          anisotropyRotation: 0,
          envMapIntensity: 1.5,
        }, { metal: true, normalScale: 0.55 });
      case 'exhaust_metal':
        return this._surface('exhaust_metal', { envMapIntensity: 1.4 }, { metal: true, normalScale: 0.9 });

      case 'visor_glass':
        return this._visor();

      case 'mirror_glass': {
        // A near-perfect mirror off the environment probe, which is a good mirror on its
        // own. A consumer with a live render target assigns it to `map` and drops
        // metalness to 0 — flagged here so nobody has to guess.
        const m = new THREE.MeshStandardMaterial({
          color: 0xc9ced4,
          metalness: 1.0,
          roughness: 0.035,
          envMapIntensity: 1.4,
        });
        m.userData.acceptsRenderTarget = true;
        return m;
      }

      case 'driver_suit':
        return this._physical('driver_suit', SUIT_RESPONSE, { normalScale: 1.3 });
      case 'driver_glove':
        return this._physical('driver_glove', {
          color: 0xffffff,
          sheen: 0.26,
          sheenRoughness: 0.86,
          sheenColor: new THREE.Color(0x9aa0a8),
          envMapIntensity: 0.7,
        }, { normalScale: 1.25 });
      case 'cockpit_padding':
        return this._physical('cockpit_padding', {
          color: 0xffffff,
          sheen: 0.62,
          sheenRoughness: 0.88,
          sheenColor: new THREE.Color(0x6e6e78),
          envMapIntensity: 0.6,
        }, { normalScale: 1.0 });
      case 'wheel_grip':
        return this._surface('wheel_grip', { envMapIntensity: 0.65 }, { normalScale: 1.1 });

      case 'display_screen': {
        const m = new THREE.MeshStandardMaterial({
          color: 0x05060a,
          roughness: 0.16,
          metalness: 0.0,
          normalMap: this._displayNormal,
          emissive: new THREE.Color(0xffffff),
          emissiveMap: this._display.texture,
          emissiveIntensity: 2.6,
          envMapIntensity: 0.5,
        });
        m.normalScale.set(0.25, 0.25);
        m.userData.canvas = this._display.canvas;
        m.userData.context = this._display.context;
        m.userData.texture = this._display.texture;
        return m;
      }
      case 'led_strip': {
        const set = this._sets.get('led_strip');
        const m = this._surface('led_strip', {
          emissive: new THREE.Color(0xffffff),
          emissiveMap: set.emissiveMap ?? null,
          emissiveIntensity: 3.4,
          envMapIntensity: 0.4,
        }, { normalScale: 0.6 });
        m.userData.cells = 15;
        return m;
      }

      default: {
        if (!this._warned.has(name)) {
          this._warned.add(name);
          console.warn(`[materials] unknown material "${name}" — returning neutral placeholder`);
        }
        return new THREE.MeshStandardMaterial({ color: 0x9a9a9e, roughness: 0.85, metalness: 0 });
      }
    }
  }

  /**
   * Automotive paint: a two-lobe finish. The base coat carries the colour and a trace of
   * metallic flake; the clearcoat above it is near-mirror and gets its own micro-normal
   * so reflections shimmer with orange peel instead of being geometrically perfect.
   */
  _paint(color, opts = {}) {
    const m = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(color),
      roughness: opts.roughness ?? 0.32,
      metalness: opts.metalness ?? 0.06,
      clearcoat: opts.clearcoat ?? 1.0,
      clearcoatRoughness: opts.clearcoatRoughness ?? 0.03,
      clearcoatNormalMap: this._flakeNormal ?? null,
      envMapIntensity: opts.envMapIntensity ?? 1.5,
    });
    m.clearcoatNormalScale.set(0.28, 0.28);
    return m;
  }

  _visor() {
    const set = this._sets.get('visor_glass');
    const transmissive = this.tier?.name !== 'low';
    const m = new THREE.MeshPhysicalMaterial({
      map: set.map,
      normalMap: set.normalMap,
      roughnessMap: set.ormMap,
      roughness: 1.0,
      metalness: 0.0,
      // Polycarbonate: n = 1.585, 2.5 mm shell.
      ior: 1.585,
      transmission: transmissive ? 0.92 : 0.0,
      thickness: 0.0025,
      attenuationDistance: 0.05,
      attenuationColor: new THREE.Color(0x8fa4b8),
      clearcoat: 1.0,
      clearcoatRoughness: 0.02,
      transparent: true,
      opacity: transmissive ? 1.0 : 0.34,
      depthWrite: false,
      side: THREE.FrontSide,
      envMapIntensity: 1.4,
    });
    m.normalScale.set(0.5, 0.5);
    m.userData.tileU = set.tileU;
    m.userData.tileV = set.tileV;
    return m;
  }

  // --- public API -----------------------------------------------------------------

  /** Cached, shared material for a registry name (CONTRACT.md §5). */
  get(name) {
    let m = this._materials.get(name);
    if (!m) {
      m = this._createMaterial(name);
      this._materials.set(name, m);
    }
    return m;
  }

  /**
   * Procedurally generated, cached texture for a registry name.
   * `channel` selects which of the generated maps to return: 'map' (default, sRGB
   * colour), 'normal', 'orm' (ao in R, roughness in G, metalness in B) or 'emissive'.
   */
  texture(name, channel = 'map') {
    const key = TEXTURE_SET_ALIASES[name] ?? name;
    const set = this._sets.get(key);
    if (!set) {
      if (name === 'livery_primary' || name === 'livery_secondary' || name === 'livery_accent') {
        return this._flakeNormal;
      }
      if (name === 'display_screen') return this._display?.texture ?? null;
      if (!this._warned.has(`tex:${name}`)) {
        this._warned.add(`tex:${name}`);
        console.warn(`[materials] no texture set for "${name}"`);
      }
      return null;
    }
    if (channel === 'normal') return set.normalMap ?? null;
    if (channel === 'orm' || channel === 'roughness' || channel === 'ao') return set.ormMap ?? null;
    if (channel === 'emissive') return set.emissiveMap ?? null;
    return set.map ?? null;
  }

  /** Metres of world space covered by one tile of a material's textures. */
  tileSize(name, out = { u: 1, v: 1 }) {
    const set = this._sets.get(TEXTURE_SET_ALIASES[name] ?? name);
    out.u = set?.tileU ?? 1;
    out.v = set?.tileV ?? 1;
    return out;
  }

  /**
   * An independent copy of a registry material that shares its textures. Use this when a
   * consumer must vary a uniform per instance — a brake disc that glows with its own
   * temperature, a tyre carrying a different compound band — instead of mutating the
   * shared instance and changing every car on the grid.
   */
  clone(name) {
    const m = this.get(name).clone();
    m.userData = { ...this.get(name).userData };
    this._extra.push(m);
    return m;
  }

  /**
   * A complete paint set for one constructor. Cached by colour triple, so the twenty
   * cars on the grid share ten material sets rather than sixty.
   *
   * Accepts `{ primary, secondary, accent }` (hex numbers or CSS strings), an entry from
   * TEAM_LIVERIES, or a bare array of three colours.
   */
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
      // Floors and undertrays are satin-finished, not show-car gloss.
      matte: this._paint(c.primary, { roughness: 0.52, clearcoat: 0.35, clearcoatRoughness: 0.30, envMapIntensity: 1.0 }),
      // Wings pick up more environment because they sit clear of the bodywork.
      wing: this._paint(c.secondary, { envMapIntensity: 1.7 }),
      carbon: this.get('carbon_gloss'),
      carbonMatte: this.get('carbon_matte'),
      halo: this.get('halo'),
      rim: this.get('wheel_rim'),
    };
    // The nose flash and the driver's suit run the accent colour rather than the base.
    // Fibre sheen takes a desaturated cast of the suit's own colour, so it is derived
    // here rather than left white: white sheen over red cloth is what waxed the arms.
    livery.suit = this._physical('driver_suit', {
      ...SUIT_RESPONSE,
      color: new THREE.Color(c.primary),
      sheenColor: new THREE.Color(c.primary).lerp(SUIT_RESPONSE.sheenColor, 0.68),
    }, { normalScale: 1.3 });
    livery.helmet = this._paint(c.accent, { clearcoatRoughness: 0.02, envMapIntensity: 1.6 });

    for (const k of ['primary', 'secondary', 'accent', 'matte', 'wing', 'suit', 'helmet']) {
      this._extra.push(livery[k]);
    }
    this._liveries.set(key, livery);
    return livery;
  }

  /**
   * A tyre sidewall material for a specific compound. Regenerating only the sidewall
   * (1024x256) keeps a compound swap under a millisecond.
   */
  tyreSidewall(compound = 'soft') {
    const key = `tyre_sidewall_${compound}`;
    const cached = this._materials.get(key);
    if (cached) return cached;
    if (!(compound in COMPOUND_COLORS)) return this.get('tyre_sidewall');

    const td = buildTyreSidewall(this._px(1024), this._px(256), compound, 6712);
    this._register(key, td, { filtered: true });
    const m = applyContactPatch(this._pinRoughness(this._physical(key, {
      color: 0xffffff,
      sheen: 0.26,
      sheenRoughness: 0.88,
      sheenColor: new THREE.Color(0x34343b),
      specularIntensity: 0.55,
      envMapIntensity: 0.85,
    }, { normalScale: 1.15 }), key, SIDEWALL_ROUGHNESS), 0.94, 0.58);
    this._materials.set(key, m);
    return m;
  }

  /**
   * The ground-side half of a tyre's contact shadow: the dark patch the tarmac itself
   * carries where a loaded slick presses into it.
   *
   * A shadow map cannot produce this. The gap between the rubber and the road closes to
   * nothing over the last few millimetres of the contact patch, and no 2048-texel cascade
   * covering 600 m of circuit has the resolution to resolve a 190 mm slot — the tyre's
   * own cast shadow lands as one soft blob under the whole car, several texels wide,
   * indistinguishable from the shadow of the floor above it. What the eye needs, and what
   * every shipping racing title draws, is a separate, tighter occlusion term written
   * directly under the wheel.
   *
   * It is authored as an *occlusion multiplier*, not as a painted grey blob: the shader
   * emits `mix(1, uCore, occl)` and the material multiplies it into the HDR scene buffer,
   * so the patch scales with whatever light is actually reaching that piece of road. In
   * shade it barely reads, under a low sun it is nearly black, and under floodlights it
   * follows them — which is exactly how an ambient occlusion term behaves and is why the
   * decal never looks like a sticker at dusk.
   *
   * Two terms make the shape. The core is the contact patch itself, an ellipse the width
   * of the tread by the ~190 mm the carcass goes flat, and it is the darkest thing under
   * the car. The skirt is the wider penumbra where the tyre's own curvature still shades
   * the road, and it fades to nothing at the quad's edge so there is no visible boundary.
   *
   * `uCore` is the multiplier at the centre of the patch. 0.24 puts it well under a cast
   * shadow, which on a sunlit track leaves roughly 0.35 of the lit value once the sky
   * term is counted — the brief asks for the contact patch to be the darker of the two,
   * and this is the number that makes it so without crushing the tarmac to black.
   */
  contactShadow() {
    const cached = this._materials.get('tyre_contact_shadow');
    if (cached) return cached;

    const m = new THREE.ShaderMaterial({
      name: 'ApexContactShadow',
      uniforms: {
        // Half-extents of the contact patch as a fraction of the quad's half-extents.
        // Wheels.js sizes the quad from the tyre so these stay the same for every corner.
        uPatch: { value: new THREE.Vector2(0.48, 0.39) },
        uCore: { value: 0.24 },
        uSkirt: { value: 0.55 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vApexUv;
        void main() {
          vApexUv = uv;
          vec4 world = vec4( position, 1.0 );
          #ifdef USE_INSTANCING
            world = instanceMatrix * world;
          #endif
          gl_Position = projectionMatrix * modelViewMatrix * world;
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform vec2 uPatch;
        uniform float uCore;
        uniform float uSkirt;
        varying vec2 vApexUv;

        void main() {
          vec2 p = vApexUv * 2.0 - 1.0;
          float skirtD = length( p );
          if ( skirtD >= 1.0 ) discard;
          // Elliptical distance in units of the contact patch: 1.0 on the edge of the flat.
          float coreD = length( p / uPatch );
          float core = 1.0 - smoothstep( 0.75, 1.30, coreD );
          float skirt = 1.0 - smoothstep( 0.0, 1.0, skirtD );
          float occl = clamp( core + skirt * uSkirt, 0.0, 1.0 );
          gl_FragColor = vec4( vec3( mix( 1.0, uCore, occl ) ), 1.0 );
        }
      `,
      // Multiply, not alpha blend: the patch removes light from the road rather than
      // painting grey on to it, so it composites correctly over tarmac, kerb, grass and
      // standing water alike and cannot be seen to have an edge.
      //
      // Spelled out as CustomBlending rather than asked for as `MultiplyBlending`.
      // three only implements that preset on the premultiplied-alpha path; on the
      // straight-alpha path it logs an error and leaves the blend func at whatever the
      // previous draw set, which is a silently wrong composite. `dst = 0 * src +
      // SRC_COLOR * dst` is the multiply, written where it cannot be mistaken.
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
      // Held off the tarmac by the same decal trick the racing line uses. The wheel
      // centre sits exactly one tyre radius above the road, so the quad is placed on the
      // road plane itself and needs the offset rather than a lift that would show.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -12,
      fog: false,
      toneMapped: false,
    });
    this._materials.set('tyre_contact_shadow', m);
    return m;
  }

  /** React to a runtime tier change: filtering and the expensive optional features. */
  setQuality(tier) {
    if (!tier) return;
    this._applyTier(tier, this.ctx?.renderer);
    for (const tex of this._textures) {
      tex.anisotropy = this.anisotropy;
      tex.needsUpdate = true;
    }
    const visor = this._materials.get('visor_glass');
    if (visor) {
      const transmissive = tier.name !== 'low';
      visor.transmission = transmissive ? 0.92 : 0.0;
      visor.opacity = transmissive ? 1.0 : 0.34;
      visor.needsUpdate = true;
    }
  }

  dispose() {
    this.ctx?.events?.off?.('quality:change', this._onQuality);
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

/** Registry names whose pixels live under a differently-named internal set. */
const TEXTURE_SET_ALIASES = {
  carbon_matte: 'carbon',
  carbon_gloss: 'carbon',
  suspension_arm: 'carbon',
  tyre_rubber: 'tyre_tread',
  wheel_rim: 'rim_metal',
  brake_caliper: 'metal_anodised',
  halo: 'halo_metal',
};

/**
 * Contact-patch occlusion for tyre materials.
 *
 * The bottom of a loaded tyre sits in a slot between the rubber and the road: almost
 * nothing of the sky reaches it, and it is the single cue that plants a wheel on the
 * ground rather than floating it above the tarmac. No texture can carry it — the tyre
 * spins and the patch does not — so it is measured per fragment from how far below the
 * wheel's own axis the surface lies, and applied where it physically belongs, as an
 * occlusion of the indirect terms only. Direct sun is left to N-dot-L, which already
 * has nothing to give a downward-facing surface.
 *
 * It also carries the *shape* of the patch, because darkening alone still leaves a
 * perfectly circular tyre resting on a tangent point. A loaded slick does not: it goes
 * flat across roughly 180 mm and the carcass bulges out either side of the flat. That is
 * done here rather than in the geometry for the same reason the occlusion is — the tyre
 * spins under its own instance matrix and the patch does not turn with it.
 *
 * The deformation is formulated so the *lowest* point of the tyre never moves. Physics
 * puts the wheel centre exactly one unloaded radius above the road (VehiclePhysics
 * `_castWheels` rays with `tyre.spec.radius`), so lifting the tread into the carcass —
 * the obvious way to write this — would float every wheel off the tarmac by the
 * deflection. Instead each vertex is pushed *down* on to the plane the tyre already
 * touches: at radius L and angle theta off straight-down the surface sits R - L*cos(theta)
 * above that plane, so pushing it down by exactly that much lays it flat, and the push is
 * released over the following 8 degrees so the flat blends back into the circle as a
 * bulge instead of a crease. Bead and rim are far enough inside the window to be
 * untouched, so the tyre stays on its wheel.
 *
 * `cosStart` is the cosine of the half-angle where the darkening begins (0.90 = a 25
 * degree cone around straight down); `aoFloor` is the occlusion at the patch itself;
 * `squash` is the carcass deflection in metres, which sets the patch length —
 * 12 mm on a 360 mm tyre gives a 186 mm flat, which is what a loaded F1 slick measures.
 */
function applyContactPatch(material, cosStart, aoFloor, squash = 0.012) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uApexContactStart = { value: cosStart };
    shader.uniforms.uApexContactAo = { value: aoFloor };
    shader.uniforms.uApexSquash = { value: squash };

    shader.vertexShader = shader.vertexShader
      .replace('void main() {', 'uniform float uApexContactStart;\nuniform float uApexSquash;\nvarying float vApexContact;\nvoid main() {')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        // The instance matrix carries the wheel's spin, so object space is useless here:
        // work in world space against the instance origin, which is the wheel centre.
        mat4 apexWheel = modelMatrix * instanceMatrix;
        vec3 apexCentre = ( apexWheel * vec4( 0.0, 0.0, 0.0, 1.0 ) ).xyz;
        vec3 apexRadial = ( apexWheel * vec4( transformed, 1.0 ) ).xyz - apexCentre;
        float apexDown = -apexRadial.y / max( length( apexRadial ), 1e-4 );
        vApexContact = smoothstep( uApexContactStart, 1.0, apexDown );
        // The unit tyre is scaled by (width, radius, radius), so the length of the
        // instance matrix's second column is this wheel's outer radius in world metres.
        // That is what lets one shared program flatten a 360 mm front and a 362.5 mm
        // rear by the same deflection without being told which corner it is drawing.
        float apexOuter = length( apexWheel[ 1 ].xyz );
        float apexGap = apexOuter + apexRadial.y;          // height above the road plane
        float apexQ = apexGap / max( uApexSquash, 1e-5 );
        float apexPush = apexGap * ( 1.0 - smoothstep( 1.0, 2.2, apexQ ) );
        if ( apexPush > 0.0 ) {
          transformed -= inverse( mat3( apexWheel ) ) * vec3( 0.0, apexPush, 0.0 );
        }
      #else
        vApexContact = 0.0;
      #endif`);

    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float uApexContactAo;\nvarying float vApexContact;\nvoid main() {')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
      float apexPatchAo = mix( 1.0, uApexContactAo, vApexContact );
      reflectedLight.indirectDiffuse *= apexPatchAo;
      reflectedLight.indirectSpecular *= apexPatchAo;`);
  };
  // One program serves every tyre material: the two constants ride in as uniforms, so
  // the default cache key (the patch function's source) would otherwise be a false
  // positive waiting to happen if the strings ever diverged.
  material.customProgramCacheKey = () => 'apex_tyre_contact_patch';
  return material;
}

function toHex(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return v >>> 0;
  if (typeof v === 'string') {
    const c = new THREE.Color(v);
    return (Math.round(c.r * 255) << 16) | (Math.round(c.g * 255) << 8) | Math.round(c.b * 255);
  }
  if (v && typeof v.getHex === 'function') return v.getHex();
  return fallback;
}

function normaliseLivery(input) {
  if (Array.isArray(input)) {
    return {
      primary: toHex(input[0], 0xd8102a),
      secondary: toHex(input[1], 0x18181c),
      accent: toHex(input[2], 0xf2e63c),
    };
  }
  const o = input ?? {};
  return {
    primary: toHex(o.primary ?? o.base ?? o[0], 0xd8102a),
    secondary: toHex(o.secondary ?? o.trim ?? o[1], 0x18181c),
    accent: toHex(o.accent ?? o.detail ?? o[2], 0xf2e63c),
  };
}

export { COMPOUND_COLORS };
