import * as THREE from "three";
import { clamp } from "../../core/MathUtils.js";
const HOOK = "__apexSunPatch";
const SHADOW_VERTEX_DECL = (
  `
uniform mat4 uApexShadowMatrix;
uniform vec4 uApexShadowParams;
varying vec4 vApexShadowCoord;
varying vec2 vApexShadowGrad;
`
);
const SHADOW_VERTEX_BODY = (
  `
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
vec3 apexWorldNormal = normalize( apexNormalToWorld * objectNormal );
vApexShadowCoord = uApexShadowMatrix *
  ( apexWorldPos + vec4( apexWorldNormal * uApexShadowParams.y, 0.0 ) );
vec3 apexGu = vec3(
  uApexShadowMatrix[ 0 ][ 0 ], uApexShadowMatrix[ 1 ][ 0 ], uApexShadowMatrix[ 2 ][ 0 ] );
vec3 apexGv = vec3(
  uApexShadowMatrix[ 0 ][ 1 ], uApexShadowMatrix[ 1 ][ 1 ], uApexShadowMatrix[ 2 ][ 1 ] );
vec3 apexGz = vec3(
  uApexShadowMatrix[ 0 ][ 2 ], uApexShadowMatrix[ 1 ][ 2 ], uApexShadowMatrix[ 2 ][ 2 ] );
float apexNz = dot( apexWorldNormal, apexGz );
float apexNzSafe = ( apexNz < 0.0 ? -1.0 : 1.0 ) * max( abs( apexNz ), 0.15 * length( apexGz ) );
float apexGzScale = dot( apexGz, apexGz ) / apexNzSafe;
vApexShadowGrad = - vec2(
  dot( apexWorldNormal, apexGu ) / dot( apexGu, apexGu ),
  dot( apexWorldNormal, apexGv ) / dot( apexGv, apexGv )
) * apexGzScale;
#include <worldpos_vertex>
`
);
const SHADOW_FRAGMENT_DECL = (
  `
uniform sampler2D uApexShadowMap;
uniform vec4 uApexShadowParams;
uniform vec4 uApexShadowContact;
varying vec4 vApexShadowCoord;
varying vec2 vApexShadowGrad;

const vec4 APEX_UNPACK = vec4(
  255.0 / 256.0,
  ( 255.0 / 256.0 ) / 256.0,
  ( 255.0 / 256.0 ) / 65536.0,
  1.0 / 16777216.0
);

float apexContactAO = 1.0;

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

  vec2 grid = coord.xy * mapSize - 0.5;
  vec2 gridBase = floor( grid );
  vec2 gridFrac = grid - gridBase;
  vec2 base = ( gridBase + 0.5 ) * texel;

  vec4 depths;
  depths.x = apexFetch( base,                          mapSize, texel );
  depths.y = apexFetch( base + vec2( texel, 0.0 ),     mapSize, texel );
  depths.z = apexFetch( base + vec2( 0.0, texel ),     mapSize, texel );
  depths.w = apexFetch( base + vec2( texel, texel ),   mapSize, texel );

  vec2 o0 = base - coord.xy;
  vec2 o1 = o0 + vec2( texel, 0.0 );
  vec2 o2 = o0 + vec2( 0.0, texel );
  vec2 o3 = o0 + vec2( texel, texel );

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

  vec4 litTaps = step( planeZ - vec4( uApexShadowParams.x ), depths );
  float lit = dot( litTaps, apexW );

  vec4 gaps = ( planeZ - depths ) * uApexShadowContact.x;
  float contactBias = uApexShadowContact.w * 0.35;
  float contactRise = 0.5 * contactBias + 0.01;
  vec4 lifted = gaps - vec4( contactBias );
  vec4 occluded = smoothstep( vec4( 0.0 ), vec4( contactRise ), lifted )
    * exp( - max( lifted, vec4( 0.0 ) ) * uApexShadowContact.y );
  float contact = dot( occluded, apexW );
  apexContactAO = 1.0 - uApexShadowContact.z * contact;

  vec2 fromCentre = abs( coord.xy - 0.5 );
  float edge = smoothstep( 0.46, 0.5, max( fromCentre.x, fromCentre.y ) );
  apexContactAO = mix( apexContactAO, 1.0, edge );
  return mix( mix( 1.0, lit, uApexShadowParams.w ), 1.0, edge );
}
`
);
const AMBIENT_MARK = "#include <lights_fragment_end>";
const AMBIENT_BODY = (
  `
#if defined( RE_IndirectDiffuse )
  irradiance *= apexContactAO;
  iblIrradiance *= apexContactAO;
#endif
#if defined( RE_IndirectSpecular ) && defined( STANDARD )
  radiance *= mix( 1.0, apexContactAO, material.roughness );
  #ifdef USE_CLEARCOAT
    clearcoatRadiance *= mix( 1.0, apexContactAO, material.clearcoatRoughness );
  #endif
#endif
#include <lights_fragment_end>
`
);
const LIGHT_MARK = "getDirectionalLightInfo( directionalLight, directLight );";
let _packingChecked = false;
function assertPackingLayout() {
  if (_packingChecked) return;
  _packingChecked = true;
  const chunk = (THREE.ShaderChunk?.packing ?? "").replace(/\s+/g, "");
  if (chunk.indexOf("PackFactors=vec4(1.0,256.0,") < 0) {
    console.warn(
      "[SunShadow] three.js depth-packing layout has changed; APEX_UNPACK in CascadedShadows.js must be re-derived from ShaderChunk.packing or every cast shadow in the scene will silently read as noise."
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
function castDoubleSided(material) {
  if (material !== void 0 && material !== null && material.shadowSide === null) {
    material.shadowSide = THREE.DoubleSide;
  }
}
function syncVisitor(object) {
  if (object.castShadow === true) {
    if (object.customDepthMaterial === void 0) {
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
  if (material === void 0) return;
  if (Array.isArray(material)) {
    for (let i = 0; i < material.length; i++) _syncOwner.patchMaterial(material[i], _syncForce);
  } else {
    _syncOwner.patchMaterial(material, _syncForce);
  }
}
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
    this.radius = clamp((options.shadowDistance ?? 600) * 0.16, 55, 110);
    this.enabled = true;
    this.direction = new THREE.Vector3(0, -1, 0);
    this.group = new THREE.Group();
    this.group.name = "sun";
    this.light = null;
    this.lights = [];
    this._patches = [];
    this._patchIds = [];
    this._cacheKey = "";
    this._disposed = false;
    this._mapTexture = null;
    this.depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    this.depthMaterial.name = "apex_shadow_depth";
    this._shadowUniforms = {
      uApexShadowMap: { value: null },
      uApexShadowMatrix: { value: new THREE.Matrix4() },
      uApexShadowParams: { value: new THREE.Vector4(0, 0, 1 / 2048, 1) },
      uApexShadowContact: { value: new THREE.Vector4(200, 3.2, 0, 0.05) }
    };
    this.contactStrength = 0.85;
    assertPackingLayout();
    this.registerPatch("sun", (shader) => this._applyShadowPatch(shader));
    this._buildLight();
  }
  _buildLight() {
    this._mapTexture = null;
    if (this.light !== null) {
      this.light.shadow.dispose();
      this.group.remove(this.light.target);
      this.group.remove(this.light);
    }
    const light = new THREE.DirectionalLight(16777215, 1);
    light.castShadow = this.enabled;
    light.shadow.mapSize.set(this.mapSize, this.mapSize);
    light.shadow.camera.near = 0.05;
    light.shadow.camera.far = 1e3;
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
    this._cacheKey = `apexsun_${this._patchIds.join(".")}`;
  }
  setQuality({ cascades, shadowMapSize, shadowDistance } = {}) {
    const size = resolveMapSize(shadowMapSize ?? this.mapSize, cascades ?? 1);
    const radius = shadowDistance === void 0 ? this.radius : clamp(shadowDistance * 0.16, 55, 110);
    this.radius = radius;
    if (size === this.mapSize) return;
    this.mapSize = size;
    this._buildLight();
  }
  setSunDirection(dir) {
    this.direction.copy(dir).normalize();
  }
  setLight(color, intensity) {
    this.light.color.copy(color);
    this.light.intensity = intensity;
  }
  setShadowsEnabled(enabled) {
    this.enabled = enabled;
    this.light.castShadow = enabled;
    if (!enabled) this._shadowUniforms.uApexShadowParams.value.w = 0;
  }
  update(camera, renderer = null) {
    if (this.light === null) return;
    camera.getWorldPosition(_camPos);
    camera.getWorldDirection(_forward);
    _forward.y = 0;
    if (_forward.lengthSq() < 1e-8) _forward.set(0, 0, -1);
    else _forward.normalize();
    const radius = this.radius;
    _up.set(0, 1, 0);
    if (Math.abs(this.direction.y) > 0.995) _up.set(0, 0, 1);
    _eye.copy(this.direction);
    _rot.lookAt(_eye, _origin, _up);
    _rotInv.copy(_rot).invert();
    _center.copy(_camPos).addScaledVector(_forward, radius * 0.5);
    const texel = 2 * radius / this.mapSize;
    _lightSpace.copy(_center).applyMatrix4(_rotInv);
    _lightSpace.x = Math.round(_lightSpace.x / texel) * texel;
    _lightSpace.y = Math.round(_lightSpace.y / texel) * texel;
    _lightSpace.z = Math.round(_lightSpace.z / texel) * texel;
    _center.copy(_lightSpace).applyMatrix4(_rot);
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
    const normalBias = texel * 0.5;
    const depthBias = texel * 0.15 / (shadowCam.far - shadowCam.near);
    light.shadow.normalBias = normalBias;
    light.shadow.bias = -depthBias;
    this.group.updateMatrixWorld(true);
    light.shadow.updateMatrices(light);
    const map = light.shadow.map;
    if (map !== null && map.texture !== this._mapTexture) {
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
      this.enabled && map !== null ? 1 : 0
    );
    u.uApexShadowContact.value.x = shadowCam.far - shadowCam.near;
    u.uApexShadowContact.value.w = texel;
    u.uApexShadowContact.value.z = this.contactStrength * clamp((this.direction.y - 0) / 0.08, 0, 1);
  }
  _applyShadowPatch(shader) {
    if (shader.fragmentShader.indexOf("#include <lights_fragment_begin>") < 0) return;
    if (shader.fragmentShader.indexOf("#include <lights_pars_begin>") < 0) return;
    if (shader.vertexShader.indexOf("#include <worldpos_vertex>") < 0) return;
    if (shader.vertexShader.indexOf("#include <beginnormal_vertex>") < 0) return;
    const chunk = THREE.ShaderChunk.lights_fragment_begin;
    if (chunk.indexOf(LIGHT_MARK) < 0) return;
    const shadowed = chunk.replace(LIGHT_MARK, `${LIGHT_MARK}
			directLight.color *= apexSunShadow();`);
    shader.vertexShader = SHADOW_VERTEX_DECL + shader.vertexShader.replace(
      "#include <worldpos_vertex>",
      SHADOW_VERTEX_BODY
    );
    shader.fragmentShader = shader.fragmentShader.replace("#include <lights_pars_begin>", `#include <lights_pars_begin>
${SHADOW_FRAGMENT_DECL}`).replace("#include <lights_fragment_begin>", shadowed);
    if (shader.fragmentShader.indexOf(AMBIENT_MARK) >= 0) {
      shader.fragmentShader = shader.fragmentShader.replace(AMBIENT_MARK, AMBIENT_BODY);
    }
    shader.uniforms.uApexShadowMap = this._shadowUniforms.uApexShadowMap;
    shader.uniforms.uApexShadowMatrix = this._shadowUniforms.uApexShadowMatrix;
    shader.uniforms.uApexShadowParams = this._shadowUniforms.uApexShadowParams;
    shader.uniforms.uApexShadowContact = this._shadowUniforms.uApexShadowContact;
  }
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
  patchMaterial(material, forceRecompile = false) {
    if (!material || this._disposed) return;
    if (material.userData?.skipCSM) return;
    const existing = material[HOOK];
    if (existing !== void 0) {
      if (existing.owner !== this) {
        existing.owner = this;
        material.needsUpdate = true;
      } else if (forceRecompile) {
        material.needsUpdate = true;
      }
      return;
    }
    const own = Object.prototype.hasOwnProperty.call(material, "onBeforeCompile");
    const user = own && typeof material.onBeforeCompile === "function" ? material.onBeforeCompile : null;
    const state = {
      owner: this,
      user,
      source: user === null ? "" : user.toString(),
      wrapper: null
    };
    state.wrapper = function apexOnBeforeCompile(shader, renderer) {
      if (typeof state.user === "function") state.user.call(this, shader, renderer);
      state.owner?._applyPatches(shader);
    };
    Object.defineProperty(material, HOOK, {
      value: state,
      writable: true,
      enumerable: false,
      configurable: true
    });
    Object.defineProperty(material, "onBeforeCompile", {
      enumerable: false,
      configurable: true,
      get() {
        return state.wrapper;
      },
      set(fn) {
        state.user = typeof fn === "function" ? fn : null;
        state.source = state.user === null ? "" : state.user.toString();
        this.needsUpdate = true;
      }
    });
    const previousKey = material.customProgramCacheKey;
    const isDefaultKey = previousKey === THREE.Material.prototype.customProgramCacheKey;
    material.customProgramCacheKey = function apexProgramCacheKey() {
      const s = this[HOOK];
      const inner = s ? s.source : "";
      const base = isDefaultKey ? inner : `${previousKey.call(this)}|${inner}`;
      return `${base}|${s && s.owner ? s.owner._cacheKey : ""}`;
    };
    material.needsUpdate = true;
  }
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
export { SunShadow as CascadedShadows };
