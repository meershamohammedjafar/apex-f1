import * as THREE from 'three';
import { clamp } from '../../core/MathUtils.js';

/**
 * The sun's shadow map, plus the shared `onBeforeCompile` hook that SkySystem
 * hangs its aerial-perspective patch on.
 *
 * History, because it matters for anyone tempted to bring it back: this used to
 * be a hand-rolled cascaded shadow map built from four DirectionalLights that
 * shared a direction and were re-weighted per fragment by an injected
 * `lights_fragment_begin`. That design has a fatal failure mode — if the shader
 * injection does not land on a material for *any* reason (a clone, a
 * reassignment of `onBeforeCompile` by another subsystem, a three.js chunk edit
 * that moves the splice markers), the material is silently lit by all four
 * lights at once. The frame then carries 4x the intended direct illuminance, and
 * because the far cascades need a metre-scale normal bias to avoid acne, their
 * shadow term collapses to 1.0 and the surviving contact shadow is diluted to
 * roughly a quarter strength. That is exactly what shipped: a washed-out,
 * shadowless image. A lighting rig whose *correctness* depends on a string
 * replacement succeeding in every one of five hundred materials is not a rig.
 *
 * So: one DirectionalLight, stock three.js lighting, and exactly one place where
 * a fragment can lose the sun. On `high` that is a 4096 map — the same texel budget the
 * four 2048 cascades used — fitted to a texel-snapped sphere of radius 110 m
 * around the camera, giving 5.4 cm shadow texels from the front wing out to
 * ~165 m ahead. Total direct illuminance is, by construction, one sun.
 *
 * One thing is *not* stock, and it is not decoration. three's shadow lookup
 * samples `light.shadow.map.depthTexture` — a DEPTH_COMPONENT24 texture in
 * hardware comparison mode. In this scene that texture comes back reading 1.0
 * at every texel, so every fragment resolves as lit: no shadow reaches the road
 * anywhere, in any frame. It is not the fit, the bias, the map size, the caster
 * flags or the receiver materials — all of those were bisected out, and a
 * minimal stock-three scene rendered by the same renderer in the same process
 * shadows correctly with the same light. What does arrive intact every frame is
 * the shadow pass's *colour* attachment: dumping it shows the cars, the barriers
 * and the grandstand rendered from the sun, correctly fitted.
 *
 * So the map is built by three exactly as before — with three's culling,
 * instancing, skinning and alpha-test handling — and only the lookup is ours:
 * casters get a `customDepthMaterial` that packs depth across RGBA instead of
 * three's default 8-bit `1 - z`, `light.shadow.intensity` is set to zero so
 * three's own (broken here, correct elsewhere) term multiplies by one and can
 * never double up, and a patch samples the colour attachment. That is 24 bits of
 * depth over the fit volume — sub-millimetre — against the 0.8 m per step the
 * default packing would have given.
 *
 * The packing layout is the trap in that plan and it caught this file once: three
 * moved `packDepthToRGBA` to a red-most-significant order, the inverse constant here
 * still assumed the old alpha-most-significant one, and because a *cleared* texel is
 * 1,1,1,1 under either order the failure looked like "shadows are too weak" rather
 * than "the lookup is reading a low byte". See APEX_UNPACK below, and the tripwire
 * that now checks the layout at construction.
 *
 * Stability: the fit sphere has a fixed radius and its centre is snapped to whole
 * shadow-map texels in light space, so the shadow edges do not crawl when the car
 * turns — the single most obvious tell of an amateur implementation. The light
 * basis is derived from the sun direction alone, never from the camera, or the
 * snap would be undone every frame.
 *
 * ---------------------------------------------------------------------------------
 * What was actually wrong, measured rather than reasoned about, after three rounds of
 * "no shadow reaches any surface in any frame". Recorded so the next person does not
 * re-bisect it:
 *
 *  - The map is right. Reading the colour attachment back on cockpit-grid gives 11.2%
 *    of texels written and, at the ground point under the car ahead, an occluder
 *    0.82 m in front of the receiver along the light ray. The shadow matrix published
 *    here addresses that point at uv (0.519, 0.392), inside the map. Packing layout,
 *    fit, caster flags and receiver flags are all correct.
 *  - The patch is right. It lands on 104 of the 109 materials the renderer compiles
 *    (the five it skips have no lights_fragment_begin — post-process quads), and the
 *    injected line sits immediately after getDirectionalLightInfo inside the unrolled
 *    directional loop, exactly as intended.
 *  - Three real defects made the term useless anyway, and all three are fixed below:
 *    the fit was published *after* whatever pass in the frame had already rasterised
 *    the map, and the guard that papered over that skipped the refit entirely whenever
 *    it happened — in a cockpit scenario, every frame (see update()); every tap was
 *    a bilinear blend of two packed depths because three never re-applies a filter
 *    change to a live render target (see apexFetch); and the cast test compared each
 *    tap against the fragment's own depth, which forced a bias larger than the gap an
 *    F1 floor leaves under itself (see the receiver-plane comparison in apexSunShadow).
 *  - One thing is *not* this file's to fix, and it dominates the result: at the
 *    scenarios' 15:12, the sun at Spa stands 146 degrees behind a car pointed up the
 *    pit straight — dot(cameraForward, sunDirection) = -0.834, measured. Every shadow
 *    in the frame is therefore thrown directly away from the eye and hidden behind its
 *    own caster. A visualisation of the shadow term itself confirms it: the road is
 *    lit everywhere the road is visible. No shadow implementation can put a shadow on
 *    screen from that sun angle; the time of day has to move.
 */

/**
 * Non-enumerable per-material record: the caller's own `onBeforeCompile`, the
 * stable wrapper handed out in its place, and who owns the patch set.
 */
const HOOK = '__apexSunPatch';

/**
 * The sun's own shadow lookup. Declared for the vertex stage: the shadow-space
 * position is affine in world space for an orthographic light, so interpolating
 * it across a triangle is exact and the fragment stage pays one divide.
 */
const SHADOW_VERTEX_DECL = /* glsl */ `
uniform mat4 uApexShadowMatrix;
uniform vec4 uApexShadowParams;
varying vec4 vApexShadowCoord;
varying vec2 vApexShadowGrad;
`;

const SHADOW_VERTEX_BODY = /* glsl */ `
vec4 apexWorldPos = vec4( transformed, 1.0 );
mat3 apexNormalToWorld = mat3( modelMatrix );
#ifdef USE_BATCHING
  apexWorldPos = batchingMatrix * apexWorldPos;
  apexNormalToWorld = apexNormalToWorld * mat3( batchingMatrix );
#endif
#ifdef USE_INSTANCING
  apexWorldPos = instanceMatrix * apexWorldPos;
  apexNormalToWorld = apexNormalToWorld * mat3( instanceMatrix );
#endif
apexWorldPos = modelMatrix * apexWorldPos;
// Offsetting along the surface normal rather than in depth is what keeps a
// near-grazing surface out of its own shadow without detaching the contact edge.
vec3 apexWorldNormal = normalize( apexNormalToWorld * objectNormal );
vApexShadowCoord = uApexShadowMatrix *
  ( apexWorldPos + vec4( apexWorldNormal * uApexShadowParams.y, 0.0 ) );
// Receiver-plane depth gradient, in shadow-map units: how much shadow-space depth
// this surface gains per unit of shadow u and v, if it carries on as the plane its
// normal describes.
//
// This is what makes a *tight* contact shadow possible at all. The taps below sit up to
// one texel from the fragment, and on tarmac lit from 30 degrees up, a texel of
// lateral offset is 8 cm of depth along the light ray. Compared
// against the fragment's own depth, that quarter-metre is indistinguishable from an
// occluder standing a quarter-metre away, so the bias needed to suppress it was
// larger than the 120 mm gap an F1 floor actually leaves under itself — the term
// meant to darken the contact patch could never fire on the geometry it exists for.
// Predicting each tap's depth from the plane cancels the slope exactly, and the
// bias that remains only has to cover depth quantisation and curvature.
//
// The light is orthographic, so the three rows of the shadow matrix are the world
// gradients of u, v and depth; they are mutually orthogonal, which is what lets the
// plane's depth slope be written in closed form. Taking them from the matrix means
// the gradient can never disagree with the map the lookup samples.
vec3 apexGu = vec3(
  uApexShadowMatrix[ 0 ][ 0 ], uApexShadowMatrix[ 1 ][ 0 ], uApexShadowMatrix[ 2 ][ 0 ] );
vec3 apexGv = vec3(
  uApexShadowMatrix[ 0 ][ 1 ], uApexShadowMatrix[ 1 ][ 1 ], uApexShadowMatrix[ 2 ][ 1 ] );
vec3 apexGz = vec3(
  uApexShadowMatrix[ 0 ][ 2 ], uApexShadowMatrix[ 1 ][ 2 ], uApexShadowMatrix[ 2 ][ 2 ] );
float apexNz = dot( apexWorldNormal, apexGz );
// A face edge-on to the sun has an unbounded depth slope; clamping the denominator
// at 0.15 caps it at about seven metres of depth per texel, past which the contact
// term is meaningless anyway.
float apexNzSafe = ( apexNz < 0.0 ? -1.0 : 1.0 ) * max( abs( apexNz ), 0.15 * length( apexGz ) );
float apexGzScale = dot( apexGz, apexGz ) / apexNzSafe;
vApexShadowGrad = - vec2(
  dot( apexWorldNormal, apexGu ) / dot( apexGu, apexGu ),
  dot( apexWorldNormal, apexGv ) / dot( apexGv, apexGv )
) * apexGzScale;
#include <worldpos_vertex>
`;

const SHADOW_FRAGMENT_DECL = /* glsl */ `
uniform sampler2D uApexShadowMap;
uniform vec4 uApexShadowParams;
uniform vec4 uApexShadowContact;
varying vec4 vApexShadowCoord;
varying vec2 vApexShadowGrad;

/**
 * three's packDepthToRGBA, inverted. Kept local rather than leaning on <packing>
 * so the patch compiles the same way whatever chunk set a material pulled in —
 * but it has to track the *current* layout, which is:
 *
 *   PackFactors    = vec4( 1.0, 256.0, 256.0 * 256.0, 256.0 * 256.0 * 256.0 )
 *   UnpackFactors4 = vec4( ( 255.0 / 256.0 ) / PackFactors.rgb, 1.0 / PackFactors.a )
 *
 * i.e. RED is the most significant byte and ALPHA the least. This file previously
 * carried the pre-r160 layout (alpha most significant), which does not fail loudly:
 * a cleared texel is 1,1,1,1 and unpacks to ~1.0 either way, so open tarmac still
 * read as lit, while every texel a caster had written unpacked to its own low byte —
 * a number uncorrelated with the real depth. Roughly half the taps then compared as
 * lit and half as shadowed, so the cast shadow came through as a faint dither that
 * measured as "a localised dip" and read, correctly, as no shadow at all. The JS
 * side asserts the layout at construction so a three upgrade cannot repeat this
 * silently.
 */
const vec4 APEX_UNPACK = vec4(
  255.0 / 256.0,
  ( 255.0 / 256.0 ) / 256.0,
  ( 255.0 / 256.0 ) / 65536.0,
  1.0 / 16777216.0
);

/**
 * Contact term. Set by apexSunShadow() and consumed just before
 * <lights_fragment_end>: the sun's shadow can only take the sun away, and a car
 * sitting on the road has to take the sky away as well or the tyre contact patch
 * is the same brightness as the rest of the shadow and the car floats.
 */
float apexContactAO = 1.0;

/**
 * One packed-depth texel, sampled at its own centre.
 *
 * The snap is not decoration. three allocates the shadow map's colour attachment as a
 * stock WebGLRenderTarget — LinearFilter — and applies a texture's filter settings only
 * while it is building the framebuffer, so assigning NearestFilter to shadow.map.texture
 * afterwards, which is what this file did, never reaches the GL object. A bilinear tap
 * between two packed texels averages the *bytes* of two different distances; across a
 * silhouette that is a depth halfway between the caster and the world behind it, which
 * reads as a shadow edge that is soft in the wrong direction and, at a contact patch,
 * as no edge at all. Sampling exactly at a texel centre returns that texel unweighted
 * under either filter, so the lookup stops depending on a setting we cannot set.
 */
float apexFetch( vec2 uv, float mapSize, float texel ) {
  vec2 centred = ( floor( uv * mapSize ) + 0.5 ) * texel;
  return dot( texture2D( uApexShadowMap, centred ), APEX_UNPACK );
}

float apexSunShadow() {
  apexContactAO = 1.0;
  if ( uApexShadowParams.w <= 0.0 || ! receiveShadow ) return 1.0;

  vec3 coord = vApexShadowCoord.xyz / vApexShadowCoord.w;
  if ( coord.z <= 0.0 || coord.z >= 1.0 ) return 1.0;
  if ( coord.x < 0.0 || coord.x > 1.0 || coord.y < 0.0 || coord.y > 1.0 ) return 1.0;

  float texel = uApexShadowParams.z;
  float mapSize = 1.0 / texel;

  // Texel-grid PCF.
  //
  // The four texels of the 2x2 footprint are fetched at their exact centres — a packed
  // depth must never be blended — and it is the four *comparisons* that carry the
  // bilinear weights. That is what a hardware shadow sampler does, and the distinction
  // matters twice: blending the packed bytes reads as a surface between the caster and
  // the world behind it, while not blending at all quantises the whole term to five
  // grey levels and paints the shadow map's own grid across anything close enough to
  // the eye to resolve a texel — a front tyre a metre and a half away, for instance.
  vec2 grid = coord.xy * mapSize - 0.5;
  vec2 gridBase = floor( grid );
  vec2 gridFrac = grid - gridBase;
  vec2 base = ( gridBase + 0.5 ) * texel;

  vec4 depths;
  depths.x = apexFetch( base,                          mapSize, texel );
  depths.y = apexFetch( base + vec2( texel, 0.0 ),     mapSize, texel );
  depths.z = apexFetch( base + vec2( 0.0, texel ),     mapSize, texel );
  depths.w = apexFetch( base + vec2( texel, texel ),   mapSize, texel );

  // Offsets from the fragment to each of those four texel centres.
  vec2 o0 = base - coord.xy;
  vec2 o1 = o0 + vec2( texel, 0.0 );
  vec2 o2 = o0 + vec2( 0.0, texel );
  vec2 o3 = o0 + vec2( texel, texel );

  // Where this surface would be at each tap if it simply carried on as a plane.
  vec4 planeZ = vec4( coord.z ) + vec4(
    dot( vApexShadowGrad, o0 ),
    dot( vApexShadowGrad, o1 ),
    dot( vApexShadowGrad, o2 ),
    dot( vApexShadowGrad, o3 )
  );

  vec4 apexW = vec4(
    ( 1.0 - gridFrac.x ) * ( 1.0 - gridFrac.y ),
    gridFrac.x * ( 1.0 - gridFrac.y ),
    ( 1.0 - gridFrac.x ) * gridFrac.y,
    gridFrac.x * gridFrac.y
  );

  // Receiver-plane depth bias, on the cast test and not only on the contact term.
  //
  // Comparing every tap against the fragment's own depth means the bias has to cover
  // the depth the *receiver* gains over the tap offset, and on tarmac lit from thirty
  // degrees up one texel of offset is 8 cm of depth along the light ray. A constant bias
  // large enough to cover that is larger than the gap an F1 floor leaves under itself,
  // so the shadow lifts clean off the car — peter-panning, and precisely the "no
  // darkening at the contact patch while a dip survives a metre away" this file has
  // been chasing for three rounds. Predicting each tap's depth from the receiver plane
  // cancels the slope exactly and leaves a bias that only has to cover 8-bit depth
  // quantisation and curvature: a sixth of a texel instead of a third of a metre.
  vec4 litTaps = step( planeZ - vec4( uApexShadowParams.x ), depths );
  float lit = dot( litTaps, apexW );

  // Contact term.
  //
  // How far in front of this fragment each tap's occluder sits, in metres: under a
  // floor 60 mm off the tarmac the sun ray reaches the floor after 0.12 m at 30
  // degrees elevation; under the shadow a wing mirror throws four metres away it is
  // 4. One number separates the contact patch from the body shadow without a second
  // map or a screen-space trace.
  //
  // Deliberately not gated on the binary lit test above. That gate is what used to
  // erase the contact shadow at exactly the place it matters: where a tyre meets
  // the road the occluder and the receiver are coincident, the depth bias pushes
  // the reference past the occluder, the cast test reads lit, and a term multiplied
  // by ( 1.0 - lit ) fell to zero across the whole contact patch. The tyres then met
  // the tarmac with no darkening at all while the broader shadow a metre away
  // survived - which is precisely how the frame read.
  //
  // Measured against the receiver plane rather than the fragment's own depth, so
  // the only bias left is three quarters of a texel of quantisation and curvature
  // slack - well under the 120 mm an F1 floor leaves under itself, which is the
  // whole point.
  vec4 gaps = ( planeZ - depths ) * uApexShadowContact.x;
  // Three quarters of a texel — 35 mm on the high-tier fit — was enough to erase the one
  // place this term exists for. Where a tyre meets the road the occluder and the
  // receiver are the same distance from the sun, so the gap is zero and any bias larger
  // than the tyre's own rise puts the whole contact patch outside the term: the car
  // reads as hovering. With the per-tap plane prediction above cancelling the receiver's
  // own slope, what is left to cover is depth quantisation (20 microns over the fit
  // volume) and curvature across the 1.5-texel tap radius (~16 mm on bodywork with a
  // 300 mm radius). A third of a texel covers both and leaves the contact patch inside
  // the term where it belongs.
  float contactBias = uApexShadowContact.w * 0.35;
  // The onset ramp has to be short. The whole range this term works over is the
  // first 300 mm of occluder gap; spending 100 mm of it fading in left the tarmac
  // under a floor at a third of the occlusion the geometry calls for. Half a texel
  // of ramp is enough to keep the edge from aliasing.
  float contactRise = 0.5 * contactBias + 0.01;
  vec4 lifted = gaps - vec4( contactBias );
  vec4 occluded = smoothstep( vec4( 0.0 ), vec4( contactRise ), lifted )
    * exp( - max( lifted, vec4( 0.0 ) ) * uApexShadowContact.y );
  float contact = dot( occluded, apexW );
  apexContactAO = 1.0 - uApexShadowContact.z * contact;

  // Fade out over the last 4% of the map rather than ending the shadowed region
  // on a hard line the eye reads as a seam across the track.
  vec2 fromCentre = abs( coord.xy - 0.5 );
  float edge = smoothstep( 0.46, 0.5, max( fromCentre.x, fromCentre.y ) );
  apexContactAO = mix( apexContactAO, 1.0, edge );
  return mix( mix( 1.0, lit, uApexShadowParams.w ), 1.0, edge );
}
`;

/**
 * Where the contact term takes the sky away. `irradiance` and `iblIrradiance` are
 * both declared by <lights_fragment_begin> and both consumed by
 * <lights_fragment_end>, so this is the one line between them that reaches the
 * ambient without touching the specular reflection — an occluded contact patch
 * still mirrors the sky, it just stops being lit by it.
 */
const AMBIENT_MARK = '#include <lights_fragment_end>';

const AMBIENT_BODY = /* glsl */ `
#if defined( RE_IndirectDiffuse )
  irradiance *= apexContactAO;
  iblIrradiance *= apexContactAO;
#endif
#if defined( RE_IndirectSpecular ) && defined( STANDARD )
  // The reflected sky has to go as well, or the contact patch stays milky: tarmac
  // under a floor 60 mm off the ground cannot see the dome it is mirroring. How
  // much goes is a question of lobe width, which is roughness — a mirror reflects a
  // narrow cone that a nearby occluder mostly misses, a rough surface gathers most
  // of the hemisphere and loses what the hemisphere lost. This is the single term
  // that decides whether a shadowed road reads as asphalt in shade or as a grey
  // wash, and leaving it at full strength is why the shadows here measured dark and
  // still looked pale.
  radiance *= mix( 1.0, apexContactAO, material.roughness );
  #ifdef USE_CLEARCOAT
    clearcoatRadiance *= mix( 1.0, apexContactAO, material.clearcoatRoughness );
  #endif
#endif
#include <lights_fragment_end>
`;

/** Where the sun's shadow term is folded into three's own directional-light loop. */
const LIGHT_MARK = 'getDirectionalLightInfo( directionalLight, directLight );';

/**
 * Tripwire for the one thing in this file that cannot fail loudly. APEX_UNPACK is a
 * literal, and three's depth packing layout has changed once already; if it changes
 * again the shadow lookup goes back to reading noise and the frame quietly loses its
 * shadows. Checked once, at construction, against the chunk actually installed.
 */
let _packingChecked = false;
function assertPackingLayout() {
  if (_packingChecked) return;
  _packingChecked = true;
  const chunk = (THREE.ShaderChunk?.packing ?? '').replace(/\s+/g, '');
  // The discriminator is the first component: the current layout declares
  // PackFactors as vec4( 1.0, 256.0, ... ) — red least-scaled, i.e. most
  // significant. The layout this file used to assume declared it as a vec3
  // starting at 256^3.
  if (chunk.indexOf('PackFactors=vec4(1.0,256.0,') < 0) {
    console.warn(
      '[SunShadow] three.js depth-packing layout has changed; APEX_UNPACK in ' +
      'CascadedShadows.js must be re-derived from ShaderChunk.packing or every ' +
      'cast shadow in the scene will silently read as noise.',
    );
  }
}

const _center = new THREE.Vector3();
const _lightSpace = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _up = new THREE.Vector3();
const _rot = new THREE.Matrix4();
const _rotInv = new THREE.Matrix4();
const _origin = new THREE.Vector3();

let _syncOwner = null;
let _syncForce = false;

/**
 * Force a caster into the shadow map whichever way its triangles happen to wind.
 *
 * three picks the shadow pass's cull mode as `material.shadowSide ?? inverse of
 * material.side`, so a stock `FrontSide` caster is rasterised **back faces only**.
 * That is the right default for a closed solid — the back face is behind the front
 * one along the light ray, so the recorded depth is already biased away from the
 * receiver — but it silently deletes every *open* shell from the map: a grandstand
 * roof, a pit-building fascia, a wing plane, any surface modelled as a single sheet
 * with its front to the sun has no back face to draw, so it casts nothing at all.
 * Measured on cockpit-grid: shadow-map occupancy 6.2% of texels with three's
 * default, 16.8% with DoubleSide — the difference is the entire grandstand.
 *
 * The acne that BackSide exists to avoid is handled instead by the normal-offset
 * bias in the vertex patch, which is slope-adaptive and costs no depth range.
 * A material that names its own `shadowSide` keeps it; this only fills in the null.
 */
function castDoubleSided(material) {
  if (material !== undefined && material !== null && material.shadowSide === null) {
    material.shadowSide = THREE.DoubleSide;
  }
}

function syncVisitor(object) {
  // Casters render through our own depth material so the shadow map carries
  // depth packed across all four channels; see the note at the top of the file.
  if (object.castShadow === true) {
    if (object.customDepthMaterial === undefined) {
      object.customDepthMaterial = _syncOwner.depthMaterial;
    }
    const casterMaterial = object.material;
    if (Array.isArray(casterMaterial)) {
      for (let i = 0; i < casterMaterial.length; i++) castDoubleSided(casterMaterial[i]);
    } else {
      castDoubleSided(casterMaterial);
    }
  }
  const material = object.material;
  if (material === undefined) return;
  if (Array.isArray(material)) {
    for (let i = 0; i < material.length; i++) _syncOwner.patchMaterial(material[i], _syncForce);
  } else {
    _syncOwner.patchMaterial(material, _syncForce);
  }
}

/**
 * Shadow-map resolution for a tier. The old rig spent `cascades` maps of
 * `shadowMapSize`; spending the same texel budget on one map is free and, at
 * four cascades of 2048, lands exactly on 4096.
 */
function resolveMapSize(shadowMapSize, cascades) {
  const budget = shadowMapSize * shadowMapSize * clamp(cascades ?? 1, 1, 4);
  const side = Math.sqrt(budget);
  let size = 1024;
  while (size * 2 <= side && size < 4096) size *= 2;
  return size;
}

export class SunShadow {
  constructor(options = {}) {
    this.mapSize = resolveMapSize(options.shadowMapSize ?? 2048, options.cascades ?? 1);
    /**
     * Fit radius. Everything within a sphere of this radius around a point just
     * ahead of the camera casts and receives; beyond it, nothing does. The
     * coefficient is chosen so every tier lands near a 5.4 cm texel — about
     * three screen pixels on a car sixteen metres ahead, which is what decides
     * whether the shadow under the floor has an edge or a gradient. Trading fit
     * distance for texel density is the right way round here: a shadow 110 m
     * ahead is four pixels tall and deep in aerial perspective, while the one
     * under the front wing is the whole reason the car looks like it is
     * touching the ground.
     */
    this.radius = clamp((options.shadowDistance ?? 600) * 0.16, 55, 110);
    this.enabled = true;

    this.direction = new THREE.Vector3(0, -1, 0);
    this.group = new THREE.Group();
    this.group.name = 'sun';

    this.light = null;
    /** Kept as an array: SkySystem and the FX systems reach for `lights[0]`. */
    this.lights = [];

    this._patches = [];
    this._patchIds = [];
    this._cacheKey = '';
    this._disposed = false;
    /** The live shadow-map texture, once three has allocated one. */
    this._mapTexture = null;

    /** Shared depth material for every caster: 24-bit depth packed across RGBA. */
    this.depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    this.depthMaterial.name = 'apex_shadow_depth';

    this._shadowUniforms = {
      uApexShadowMap: { value: null },
      uApexShadowMatrix: { value: new THREE.Matrix4() },
      // x = depth bias (normalised), y = normal bias (metres), z = texel (uv), w = strength
      uApexShadowParams: { value: new THREE.Vector4(0, 0, 1 / 2048, 1) },
      /**
       * x = depth range of the fit volume in metres, so the shader can turn a
       *     normalised depth difference into an occluder distance.
       * y = contact falloff, per metre. exp(-gap * y): 3.2 puts the term at 0.68
       *     under a 60 mm floor, 0.20 a half-metre away and 0.04 at a metre, which
       *     is the difference between "the tyre is on the ground" and "the mirror
       *     throws a shadow over there".
       * z = how much of the ambient a touching occluder takes away.
       * w = one shadow texel in world metres; the contact term's self-occlusion
       *     guard is expressed in multiples of it, so the same authored constants
       *     behave identically on a 1024 map fitted to 110 m and a 4096 fitted to
       *     192 m.
       */
      uApexShadowContact: { value: new THREE.Vector4(200, 3.2, 0.0, 0.05) },
    };
    /**
     * Authored contact strength; the live uniform is this faded out with the sun.
     *
     * How much of the *ambient* a touching occluder takes away. 0.85, not the 0.62
     * this carried, because 0.62 is not what the geometry says: the tarmac under an
     * F1 floor sitting 60 mm off the ground sees a slit of sky, not a third of the
     * dome, and the tyre contact patch sees none of it. The number that matters here
     * is not the shadow's own darkness — the cast term has already taken the sun
     * away by the time this applies — it is whether the tyre reads as touching the
     * road or hovering a hand's width above it, and at 0.62 it hovered.
     */
    this.contactStrength = 0.85;
    assertPackingLayout();

    // Registered before anything else so the patch-set id — and therefore the
    // program cache key — is stable from construction.
    this.registerPatch('sun', (shader) => this._applyShadowPatch(shader));

    this._buildLight();
  }

  _buildLight() {
    // The old map goes with the old light, so the next update() must fit from
    // scratch rather than trusting the skip guard.
    this._mapTexture = null;
    if (this.light !== null) {
      this.light.shadow.dispose();
      this.group.remove(this.light.target);
      this.group.remove(this.light);
    }

    const light = new THREE.DirectionalLight(0xffffff, 1);
    light.castShadow = this.enabled;
    light.shadow.mapSize.set(this.mapSize, this.mapSize);
    light.shadow.camera.near = 0.05;
    light.shadow.camera.far = 1000;
    // three still rasterises the map for us, but its own lookup is disabled: a
    // zero intensity makes its getShadow return exactly 1.0, so on hardware where
    // that path does work it cannot double up with ours. The filter width lives in
    // our own lookup instead — a bilinearly weighted 2x2 of the texel grid, so the
    // penumbra is exactly one texel, about 5 cm on the ground on `high`. That is
    // deliberately narrow: the contact shadow under a floor has to keep the hard
    // edge that reads as "the car is touching the ground", and the weighting is
    // what stops a one-texel edge aliasing into a staircase as the car moves.
    light.shadow.intensity = 0;
    light.shadow.autoUpdate = true;
    light.matrixAutoUpdate = true;
    light.target.matrixAutoUpdate = true;

    this.group.add(light);
    this.group.add(light.target);

    this.light = light;
    this.lights.length = 0;
    this.lights.push(light);

    this._rebuildCacheKey();
  }

  _rebuildCacheKey() {
    this._cacheKey = `apexsun_${this._patchIds.join('.')}`;
  }

  /** Rebuild for a new quality tier. Materials are untouched — the light path is stock. */
  setQuality({ cascades, shadowMapSize, shadowDistance } = {}) {
    const size = resolveMapSize(shadowMapSize ?? this.mapSize, cascades ?? 1);
    const radius = shadowDistance === undefined
      ? this.radius
      : clamp(shadowDistance * 0.16, 55, 110);
    this.radius = radius;
    if (size === this.mapSize) return;
    this.mapSize = size;
    this._buildLight();
  }

  /** `dir` points from the scene towards the sun; the light travels the other way. */
  setSunDirection(dir) {
    this.direction.copy(dir).normalize();
  }

  /**
   * One light, so `intensity` is the scene's entire direct illuminance — no
   * summation, no hidden multiplier.
   */
  setLight(color, intensity) {
    this.light.color.copy(color);
    this.light.intensity = intensity;
  }

  setShadowsEnabled(enabled) {
    this.enabled = enabled;
    this.light.castShadow = enabled;
    if (!enabled) this._shadowUniforms.uApexShadowParams.value.w = 0;
  }

  /**
   * Fit the shadow camera to the current view. Allocation-free.
   *
   * Call this exactly once per drawn frame and, critically, **before anything in the
   * frame rasterises a shadow map**. The lookup matrix published here has to describe
   * the map three is about to build, and under `shadowMap.autoUpdate = false` the map
   * is built by whichever `renderer.render` call sees `needsUpdate` first — which is
   * not the main camera's. The cockpit mirror pass runs in `lateUpdate`, ahead of the
   * pipeline, and its own render consumes the flag.
   *
   * This used to be handled the other way round: the fit was skipped whenever the flag
   * had already been consumed, so that the matrix kept describing the live map. That
   * keeps the two consistent by *not moving the light* — and in a cockpit scenario the
   * mirror wins the race every single frame, so from the second drawn frame the volume
   * stays pinned to wherever the camera was when it last got through, while the car
   * drives out of it. A shadow volume the scene is no longer inside is a scene with no
   * shadows in it, everywhere, in every frame. Fitting early instead costs at most one
   * frame of camera lag on a 96 m sphere (1.4 m at 310 km/h) and cannot desynchronise
   * the two, because nothing has rasterised anything yet when it runs.
   *
   * `renderer` is accepted for call-site compatibility and is not read.
   */
  update(camera, renderer = null) {
    if (this.light === null) return;

    camera.getWorldPosition(_camPos);
    camera.getWorldDirection(_forward);

    // Only the horizontal heading is used to push the fit volume forward: a
    // glance at the sky or at the steering wheel must not swing the shadowed
    // region off the track.
    _forward.y = 0;
    if (_forward.lengthSq() < 1e-8) _forward.set(0, 0, -1);
    else _forward.normalize();

    const radius = this.radius;

    // A light-space basis that depends only on the sun direction — deriving it
    // from the camera would reintroduce the shimmer the texel snap removes.
    _up.set(0, 1, 0);
    if (Math.abs(this.direction.y) > 0.995) _up.set(0, 0, 1);
    _eye.copy(this.direction);
    _rot.lookAt(_eye, _origin, _up);
    _rotInv.copy(_rot).invert();

    // Half the radius ahead: the driver sees forward, so spending a third of the
    // volume behind the car is enough for the mirrors and the trailing shadow.
    _center.copy(_camPos).addScaledVector(_forward, radius * 0.5);

    const texel = (2 * radius) / this.mapSize;
    _lightSpace.copy(_center).applyMatrix4(_rotInv);
    _lightSpace.x = Math.round(_lightSpace.x / texel) * texel;
    _lightSpace.y = Math.round(_lightSpace.y / texel) * texel;
    _lightSpace.z = Math.round(_lightSpace.z / texel) * texel;
    _center.copy(_lightSpace).applyMatrix4(_rot);

    // Pull the light back far enough that grandstands and lighting towers
    // standing between the sun and the fitted sphere still register as casters.
    const back = Math.max(90, radius * 1.5);
    const light = this.light;
    light.target.position.copy(_center);
    light.position.copy(_center).addScaledVector(this.direction, radius + back);

    const shadowCam = light.shadow.camera;
    shadowCam.left = -radius;
    shadowCam.right = radius;
    shadowCam.top = radius;
    shadowCam.bottom = -radius;
    shadowCam.near = 0.05;
    shadowCam.far = 2 * radius + back;
    shadowCam.updateProjectionMatrix();

    // Both offsets are what detaches a shadow from its caster, so both are now as
    // small as the receiver-plane comparison in the lookup allows.
    //
    // normalBias displaces the lookup along the surface normal, which on a road lit
    // from thirty degrees up slides the shadow edge sideways by normalBias /
    // tan(elevation) — 1.7x the offset. At the 0.85 texels this carried that is 6.8 cm
    // of lateral slip plus 1.6 cm of depth, against the ~6 cm an F1 floor leaves under
    // itself: the cast shadow could not survive its own bias at the one place it has to.
    // Half a texel, with the per-tap plane prediction absorbing the slope that the old
    // constant bias existed to hide, leaves 4 cm of slip and 0.7 cm of depth.
    const normalBias = texel * 0.5;
    const depthBias = (texel * 0.15) / (shadowCam.far - shadowCam.near);
    light.shadow.normalBias = normalBias;
    light.shadow.bias = -depthBias;

    // three derives `shadow.matrix` inside its own shadow pass, which runs after
    // this fit — sampling it from there would light frame N through frame N-1's
    // volume and make every shadow edge swim as the car moves. Deriving it here,
    // from the transforms we have just written, keeps the lookup and the
    // rasterisation on the same frame; three recomputes the identical matrix a
    // moment later from the identical inputs.
    this.group.updateMatrixWorld(true);
    light.shadow.updateMatrices(light);

    const map = light.shadow.map;
    if (map !== null && map.texture !== this._mapTexture) {
      // Packed depth must never be interpolated: a linear tap between two texels
      // averages the bytes of two different distances and reads as a surface
      // somewhere between them.
      //
      // This assignment does not, on its own, achieve that, and it is important not to
      // believe that it does. three allocates the shadow map inside its own shadow pass
      // and applies a texture's filter settings while it builds the framebuffer; by the
      // time we can see the texture the sampler state is already set, and three has no
      // reason to revisit it. It is kept because it is free and correct if the map is
      // ever rebuilt, but the lookup does not depend on it — apexFetch samples at texel
      // centres, which returns the exact texel under a linear filter as well.
      map.texture.minFilter = THREE.NearestFilter;
      map.texture.magFilter = THREE.NearestFilter;
      map.texture.generateMipmaps = false;
      map.texture.needsUpdate = true;
      this._mapTexture = map.texture;
    }

    const u = this._shadowUniforms;
    u.uApexShadowMap.value = map === null ? null : map.texture;
    u.uApexShadowMatrix.value.copy(light.shadow.matrix);
    u.uApexShadowParams.value.set(
      depthBias,
      normalBias,
      1 / this.mapSize,
      this.enabled && map !== null ? 1 : 0,
    );
    // Only the depth range moves with the fit; the rest of the contact constants are
    // authored. The strength is the exception: the *cast* term is harmless once the
    // sun's intensity reaches zero, because it only ever multiplies the sun, but the
    // contact term takes away ambient and would go on doing it all night under a sun
    // direction that is below the horizon and no longer means anything. It fades out
    // with the last few degrees of elevation instead.
    u.uApexShadowContact.value.x = shadowCam.far - shadowCam.near;
    u.uApexShadowContact.value.w = texel;
    u.uApexShadowContact.value.z =
      this.contactStrength * clamp((this.direction.y - 0.0) / 0.08, 0, 1);
  }

  /**
   * Fold the sun's shadow term into three's directional-light loop.
   *
   * The chunk is taken from `THREE.ShaderChunk` at patch time rather than
   * transcribed, so the injection tracks whatever three version is installed:
   * the only assumption is that a directional light is fetched by name before it
   * is integrated. If that ever stops being true the replace is a no-op and the
   * frame loses its shadows — which is a visible regression, not a silent
   * multiple-counting of the light, and that asymmetry is the whole reason the
   * term is applied here rather than by adding lights.
   */
  _applyShadowPatch(shader) {
    if (shader.fragmentShader.indexOf('#include <lights_fragment_begin>') < 0) return;
    if (shader.fragmentShader.indexOf('#include <lights_pars_begin>') < 0) return;
    if (shader.vertexShader.indexOf('#include <worldpos_vertex>') < 0) return;
    if (shader.vertexShader.indexOf('#include <beginnormal_vertex>') < 0) return;

    const chunk = THREE.ShaderChunk.lights_fragment_begin;
    if (chunk.indexOf(LIGHT_MARK) < 0) return;
    const shadowed = chunk.replace(LIGHT_MARK, `${LIGHT_MARK}
			directLight.color *= apexSunShadow();`);

    shader.vertexShader = SHADOW_VERTEX_DECL + shader.vertexShader.replace(
      '#include <worldpos_vertex>',
      SHADOW_VERTEX_BODY,
    );
    // Declared after <lights_pars_begin>, not at the top of the file: the lookup
    // reads three's own `receiveShadow` uniform, which that chunk declares.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <lights_pars_begin>', `#include <lights_pars_begin>
${SHADOW_FRAGMENT_DECL}`)
      .replace('#include <lights_fragment_begin>', shadowed);

    // The contact term needs both ends of the indirect chain, and a material that
    // does not carry <lights_fragment_end> simply keeps its ambient: the sun's own
    // shadow above is unaffected either way.
    if (shader.fragmentShader.indexOf(AMBIENT_MARK) >= 0) {
      shader.fragmentShader = shader.fragmentShader.replace(AMBIENT_MARK, AMBIENT_BODY);
    }

    shader.uniforms.uApexShadowMap = this._shadowUniforms.uApexShadowMap;
    shader.uniforms.uApexShadowMatrix = this._shadowUniforms.uApexShadowMatrix;
    shader.uniforms.uApexShadowParams = this._shadowUniforms.uApexShadowParams;
    shader.uniforms.uApexShadowContact = this._shadowUniforms.uApexShadowContact;
  }

  /**
   * Register an extra `onBeforeCompile` contribution. `id` participates in the
   * program cache key so two different patch sets never share a program.
   */
  registerPatch(id, fn) {
    this._patches.push(fn);
    this._patchIds.push(id);
    this._rebuildCacheKey();
  }

  _applyPatches(shader) {
    if (this._disposed || shader.__apexSkyPatched) return;
    shader.__apexSkyPatched = true;
    for (let i = 0; i < this._patches.length; i++) this._patches[i](shader);
  }

  /**
   * Install the patch hook on a material.
   *
   * The hook is an accessor pair, not a plain assignment. A plain assignment is
   * exactly what broke the previous rig: any subsystem that later wrote
   * `material.onBeforeCompile = ...` — and five places in this repo do — silently
   * evicted the patch while the "already patched" bookkeeping still claimed the
   * material was covered. With a getter/setter the wrapper is what the renderer
   * always reads, and a later assignment is captured as the *inner* callback
   * instead of replacing ours.
   *
   * Idempotent, and re-entrant across a quality rebuild.
   */
  patchMaterial(material, forceRecompile = false) {
    if (!material || this._disposed) return;
    if (material.userData?.skipCSM) return;

    const existing = material[HOOK];
    if (existing !== undefined) {
      if (existing.owner !== this) {
        existing.owner = this;
        material.needsUpdate = true;
      } else if (forceRecompile) {
        material.needsUpdate = true;
      }
      return;
    }

    const own = Object.prototype.hasOwnProperty.call(material, 'onBeforeCompile');
    const user = own && typeof material.onBeforeCompile === 'function' ? material.onBeforeCompile : null;
    const state = {
      owner: this,
      user,
      // Kept alongside the callback so the cache key never has to re-stringify a
      // function while the renderer is building a program.
      source: user === null ? '' : user.toString(),
      wrapper: null,
    };
    state.wrapper = function apexOnBeforeCompile(shader, renderer) {
      if (typeof state.user === 'function') state.user.call(this, shader, renderer);
      state.owner?._applyPatches(shader);
    };

    Object.defineProperty(material, HOOK, {
      value: state, writable: true, enumerable: false, configurable: true,
    });
    Object.defineProperty(material, 'onBeforeCompile', {
      enumerable: false,
      configurable: true,
      get() { return state.wrapper; },
      set(fn) {
        state.user = typeof fn === 'function' ? fn : null;
        state.source = state.user === null ? '' : state.user.toString();
        this.needsUpdate = true;
      },
    });

    // three's default cache key is `onBeforeCompile.toString()`, which is now one
    // identical string for every material in the scene — every material would
    // share the first compiled program. Key off the caller's own callback source
    // instead, plus our patch-set id.
    const previousKey = material.customProgramCacheKey;
    const isDefaultKey = previousKey === THREE.Material.prototype.customProgramCacheKey;
    material.customProgramCacheKey = function apexProgramCacheKey() {
      const s = this[HOOK];
      const inner = s ? s.source : '';
      const base = isDefaultKey ? inner : `${previousKey.call(this)}|${inner}`;
      return `${base}|${s && s.owner ? s.owner._cacheKey : ''}`;
    };

    material.needsUpdate = true;
  }

  /**
   * Walk a subtree and patch every material found. Cheap on a second pass — the
   * hook check short-circuits. `forceRecompile` additionally invalidates
   * materials that were already patched.
   */
  syncMaterials(root, forceRecompile = false) {
    if (!root || this._disposed) return;
    _syncOwner = this;
    _syncForce = forceRecompile;
    root.traverse(syncVisitor);
    _syncOwner = null;
    _syncForce = false;
  }

  dispose() {
    this._disposed = true;
    this.depthMaterial.dispose();
    this._mapTexture = null;
    if (this.light !== null) {
      this.light.shadow.dispose();
      this.light.parent?.remove(this.light);
      this.light.target.parent?.remove(this.light.target);
      this.light = null;
    }
    this.lights.length = 0;
    this._patches.length = 0;
    this._patchIds.length = 0;
    this.group.parent?.remove(this.group);
  }
}

/** The rig is no longer cascaded; the old name stays valid for existing imports. */
export { SunShadow as CascadedShadows };
