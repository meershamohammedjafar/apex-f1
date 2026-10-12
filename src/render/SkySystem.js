import * as THREE from "three";
import { clamp, clamp01, damp, smoothstep, smootherstep, DEG } from "../core/MathUtils.js";
import {
  ATMOSPHERE,
  SUN_TOA_IRRADIANCE,
  SUN_SOLID_ANGLE,
  SUN_ANGULAR_RADIUS,
  SKY_VERTEX_SHADER,
  buildSkyFragmentShader,
  createAtmosphereUniforms,
  sunTransmittance,
  skyRadiance,
  kelvinToLinearRGB
} from "./sky/AtmosphereShader.js";
import { CloudLayer, CLOUD_GLSL } from "./sky/CloudLayer.js";
import { SunShadow } from "./sky/CascadedShadows.js";
const SUN_DISC_SCALE = 15e-4;
const WEATHER_RATE = 2;
const QUALITY_SKY = {
  low: { steps: 8, captureSteps: 6, cloudTaps: 1, cubeSize: 64, domeSegments: 32 },
  medium: { steps: 11, captureSteps: 8, cloudTaps: 2, cubeSize: 128, domeSegments: 40 },
  high: { steps: 14, captureSteps: 10, cloudTaps: 3, cubeSize: 128, domeSegments: 48 },
  ultra: { steps: 20, captureSteps: 12, cloudTaps: 3, cubeSize: 256, domeSegments: 64 }
};
const WEATHER_PRESETS = {
  clear: { cloudCover: 0.12, rain: 0, windSpeed: 3.5, windDir: 1.05, turbidity: 1.1 },
  scattered: { cloudCover: 0.42, rain: 0, windSpeed: 6, windDir: 2.3, turbidity: 1.6 },
  cloudy: { cloudCover: 0.72, rain: 0, windSpeed: 8.5, windDir: 2.9, turbidity: 2.1 },
  overcast: { cloudCover: 0.95, rain: 0.05, windSpeed: 9, windDir: 3.4, turbidity: 2.6 },
  rain: { cloudCover: 0.92, rain: 0.65, windSpeed: 11, windDir: 3.9, turbidity: 3.2 },
  storm: { cloudCover: 1, rain: 1, windSpeed: 17, windDir: 4.4, turbidity: 3.8 }
};
const AERIAL_VERTEX_DECL = (
  `
#ifdef USE_FOG
varying vec3 vApDir;
#endif
`
);
const AERIAL_FRAGMENT_DECL = (
  `
#ifdef USE_FOG
varying vec3 vApDir;
uniform samplerCube uApSky;
uniform float uApSkyIntensity;
uniform float uApStrength;
#endif
`
);
const AERIAL_VERTEX_BODY = (
  `
#include <fog_vertex>
#ifdef USE_FOG
  vApDir = mvPosition.xyz * mat3( viewMatrix );
#endif
`
);
const AERIAL_FRAGMENT_BODY = (
  `
#ifdef USE_FOG
  float apDist = length( vApDir );
  vec3 apDir = vApDir / max( apDist, 1e-4 );
  #ifdef FOG_EXP2
    float apFactor = 1.0 - exp( - fogDensity * fogDensity * apDist * apDist );
  #else
    float apFactor = smoothstep( fogNear, fogFar, apDist );
  #endif
  vec3 apSky = textureCube( uApSky, apDir ).rgb * uApSkyIntensity;
  gl_FragColor.rgb = mix( gl_FragColor.rgb, apSky, clamp( apFactor * uApStrength, 0.0, 1.0 ) );
#endif
`
);
const SUN_GLARE_RADII = 56;
const SUN_GLARE_FRACTION = 0.24;
const SUN_GLARE_MAX_AIRMASS = 12;
const SUN_DISC_VERTEX = (
  `
uniform vec3 uSunDir;
uniform float uTanHalfSpan;
varying vec2 vSunOffset;

void main() {
  vec3 view = normalize( mat3( viewMatrix ) * uSunDir );
  vec3 up = abs( view.y ) > 0.99 ? vec3( 1.0, 0.0, 0.0 ) : vec3( 0.0, 1.0, 0.0 );
  vec3 right = normalize( cross( view, up ) );
  up = cross( right, view );

  vSunOffset = position.xy;
  vec3 dir = view + ( position.x * right + position.y * up ) * uTanHalfSpan;

  vec4 clip = projectionMatrix * vec4( dir, 0.0 );
  gl_Position = vec4( clip.xy, clip.w * 0.999999, clip.w );
}
`
);
const SUN_DISC_FRAGMENT = (
  `
precision highp float;

uniform vec3 uDiscRadiance;
uniform vec3 uGlareRadiance;
uniform float uTanHalfSpan;
uniform float uInvSolarRadius;
uniform float uInvGlareSpread;
varying vec2 vSunOffset;

vec3 limbDarkening( float mu ) {
  const vec3 a = vec3( 0.397, 0.503, 0.652 );
  return pow( vec3( max( mu, 1e-4 ) ), a );
}

float aureole( float r ) {
  float core = 1.0 / ( 1.0 + r * r * 0.30 );
  return core * core * 0.75 + exp( - r * 0.22 * uInvGlareSpread ) * 0.25;
}

void main() {
  float t = length( vSunOffset );
  if ( t > 1.0 ) discard;

  float radii = atan( t * uTanHalfSpan ) * uInvSolarRadius;

  float px = max( fwidth( radii ), 1e-4 );
  float inDisc = 1.0 - smoothstep( 1.0 - px, 1.0 + px, radii );
  float mu = sqrt( max( 1.0 - min( radii, 1.0 ) * min( radii, 1.0 ), 0.0 ) );

  float window = 1.0 - smoothstep( 0.72, 1.0, t );

  vec3 col = uDiscRadiance * limbDarkening( mu ) * inDisc
    + uGlareRadiance * aureole( radii ) * window;

  gl_FragColor = vec4( max( col, vec3( 0.0 ) ), 1.0 );
}
`
);
const _tint = new THREE.Vector3();
const _trans = new THREE.Vector3();
const _zenith = new THREE.Vector3();
const _horizon = new THREE.Vector3();
const _cloudSun = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _color = new THREE.Color();
const _worldPos = new THREE.Vector3();
const _project = new THREE.Vector3();
const _camForward = new THREE.Vector3();
const _syncProbe = new THREE.Vector3();
export class SkySystem {
  static systemName = "sky";
  constructor() {
    this.sunDirection = new THREE.Vector3(0.3, 0.6, 0.74).normalize();
    this.sunLight = null;
    this.environment = null;
    this.shadows = null;
    this.skyMesh = null;
    this.hemisphere = null;
    this.timeOfDay = 15.2;
    this.dayOfYear = 244;
    this.latitude = 45.6156;
    this.longitude = 9.2811;
    this.sunAltitude = 0;
    this.sunAzimuth = 0;
    this.sunColorTemperature = 5800;
    this.sunIlluminance = 0;
    this.skyIlluminance = 0;
    this.diffuseFraction = 1;
    this.sunVisibility = 0;
    this.sunScreenPosition = new THREE.Vector3();
    this.sunOnScreen = false;
    this.weather = { cloudCover: 0.12, rain: 0, windSpeed: 3.5, windDir: 1.05, turbidity: 1.1 };
    this._weatherTarget = { ...this.weather };
    this.fogParams = {
      density: 32e-5,
      color: new THREE.Color(),
      skyCube: null,
      strength: 1,
      zenithRadiance: new THREE.Vector3(),
      horizonRadiance: new THREE.Vector3()
    };
    this._externalOcclusion = 1;
    this._visibilityRaw = 0;
    this._lastElapsed = 0;
    this._skyZenith = new THREE.Vector3();
    this._skyMid = new THREE.Vector3();
    this._skyMidOpp = new THREE.Vector3();
    this._skyLow = new THREE.Vector3();
    this._skySampleTimer = 0;
    this._skySampled = false;
    this._materialSyncTimer = 0;
    this._envDirty = true;
    this._envTimer = 0;
    this._envAge = 0;
    this._lastEnvAltitude = -99;
    this._lastEnvCover = -99;
    this._lastEnvRain = -99;
    this._uniforms = null;
    this._cloud = null;
    this._domeMaterial = null;
    this._captureMaterial = null;
    this._domeGeometry = null;
    this._captureMesh = null;
    this._skyScene = null;
    this._cubeRT = null;
    this._cubeCamera = null;
    this._pmrem = null;
    this._pmremTarget = null;
    this._apUniforms = null;
    this._sunUniforms = null;
    this._sunMesh = null;
    this._sunMaterial = null;
    this._sunGeometry = null;
    this._sunDiscBase = new THREE.Vector3();
    this._glareGain = 1;
    this._glareSpread = 1;
    this._tierName = "high";
    this._trackAdopted = false;
    this._unsubscribeQuality = null;
    this._unsubscribeSettings = null;
    this._ctx = null;
    this._sceneHook = null;
    this._hookActive = false;
    this._syncedFrame = -1;
    this._fittedFrame = -1;
  }
  async init(ctx) {
    this._ctx = ctx;
    const tier = ctx.quality;
    this._tierName = tier.name ?? "high";
    const cfg = QUALITY_SKY[this._tierName] ?? QUALITY_SKY.high;
    this.timeOfDay = ctx.settings?.get("timeOfDay") ?? this.timeOfDay;
    const preset = WEATHER_PRESETS[ctx.settings?.get("weather")] ?? WEATHER_PRESETS.clear;
    Object.assign(this.weather, preset);
    Object.assign(this._weatherTarget, preset);
    this._cloud = new CloudLayer({ seed: (ctx.settings?.get("seed") ?? 20260827) ^ 5357781 }).build();
    this._uniforms = { ...createAtmosphereUniforms(), ...this._cloud.uniforms };
    this._apUniforms = {
      uApSky: { value: null },
      uApSkyIntensity: { value: 1 },
      uApStrength: { value: 1 }
    };
    this._domeGeometry = new THREE.SphereGeometry(1, cfg.domeSegments, Math.round(cfg.domeSegments * 0.66));
    this._buildSkyMaterials(cfg);
    this.skyMesh = new THREE.Mesh(this._domeGeometry, this._domeMaterial);
    this.skyMesh.name = "skyDome";
    this.skyMesh.frustumCulled = false;
    this.skyMesh.renderOrder = -1e3;
    this.skyMesh.matrixAutoUpdate = false;
    this.skyMesh.userData.skipCSM = true;
    ctx.scene.add(this.skyMesh);
    this._buildSunMesh(ctx);
    this._skyScene = new THREE.Scene();
    this._captureMesh = new THREE.Mesh(this._domeGeometry, this._captureMaterial);
    this._captureMesh.frustumCulled = false;
    this._skyScene.add(this._captureMesh);
    this._buildEnvironmentTargets(ctx, cfg.cubeSize);
    this.shadows = new SunShadow({
      cascades: tier.cascades,
      shadowMapSize: tier.shadowMapSize,
      shadowDistance: tier.shadowDistance
    });
    this.shadows.registerPatch("ap", (shader) => this._applyAerialPatch(shader));
    ctx.scene.add(this.shadows.group);
    this.sunLight = this.shadows.lights[0];
    this.hemisphere = new THREE.HemisphereLight(9419007, 4866616, 0.4);
    ctx.scene.add(this.hemisphere);
    ctx.scene.fog = new THREE.FogExp2(10466504, this.fogParams.density);
    this._unsubscribeQuality = ctx.events.on("quality:change", (q) => this._onQualityChange(q, ctx));
    this._unsubscribeSettings = ctx.settings?.onChange((key, value) => {
      if (key === "timeOfDay") this.setTimeOfDay(value);
      if (key === "weather") this.setWeather(WEATHER_PRESETS[value] ?? WEATHER_PRESETS.clear);
    });
    const previousHook = ctx.scene.onBeforeRender;
    this._sceneHook = (renderer, scene, camera, target) => {
      if (typeof previousHook === "function") previousHook.call(scene, renderer, scene, camera, target);
      if (camera !== ctx.camera) return;
      this._hookActive = true;
      const moved = _worldPos.copy(this.skyMesh.position).distanceToSquared(
        camera.getWorldPosition(_syncProbe)
      ) > 1e-6;
      if (!moved && this._syncedFrame === ctx.time.frame) return;
      this._syncedFrame = ctx.time.frame;
      this._cameraSync(ctx, camera);
    };
    ctx.scene.onBeforeRender = this._sceneHook;
    this._solveSun();
    this._updateLighting(ctx);
    this._cameraSync(ctx, ctx.camera);
    this._regenerateEnvironment(ctx);
  }
  _buildSkyMaterials(cfg) {
    this._domeMaterial?.dispose();
    this._captureMaterial?.dispose();
    this._domeMaterial = new THREE.ShaderMaterial({
      uniforms: this._uniforms,
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: buildSkyFragmentShader({
        steps: cfg.steps,
        sunDisc: false,
        cloudGLSL: CLOUD_GLSL,
        cloudLightTaps: cfg.cloudTaps
      }),
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      dithering: false
    });
    this._captureMaterial = new THREE.ShaderMaterial({
      uniforms: this._uniforms,
      vertexShader: SKY_VERTEX_SHADER,
      fragmentShader: buildSkyFragmentShader({
        steps: cfg.captureSteps,
        sunDisc: false,
        cloudGLSL: CLOUD_GLSL,
        cloudLightTaps: Math.min(2, cfg.cloudTaps)
      }),
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
      dithering: false
    });
    if (this.skyMesh) this.skyMesh.material = this._domeMaterial;
    if (this._captureMesh) this._captureMesh.material = this._captureMaterial;
  }
  _buildSunMesh(ctx) {
    const span = SUN_ANGULAR_RADIUS * SUN_GLARE_RADII;
    this._sunUniforms = {
      uSunDir: { value: this.sunDirection },
      uTanHalfSpan: { value: Math.tan(span) },
      uInvSolarRadius: { value: 1 / SUN_ANGULAR_RADIUS },
      uInvGlareSpread: { value: 1 },
      uDiscRadiance: { value: new THREE.Vector3() },
      uGlareRadiance: { value: new THREE.Vector3() }
    };
    this._sunGeometry = new THREE.PlaneGeometry(2, 2);
    this._sunMaterial = new THREE.ShaderMaterial({
      uniforms: this._sunUniforms,
      vertexShader: SUN_DISC_VERTEX,
      fragmentShader: SUN_DISC_FRAGMENT,
      blending: THREE.AdditiveBlending,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
      toneMapped: false,
      dithering: false
    });
    this._sunMaterial.name = "apex_sun_disc";
    this._sunMesh = new THREE.Mesh(this._sunGeometry, this._sunMaterial);
    this._sunMesh.name = "sunDisc";
    this._sunMesh.frustumCulled = false;
    this._sunMesh.matrixAutoUpdate = false;
    this._sunMesh.renderOrder = -999;
    this._sunMesh.castShadow = false;
    this._sunMesh.receiveShadow = false;
    this._sunMesh.userData.skipCSM = true;
    this._sunMesh.visible = false;
    ctx.scene.add(this._sunMesh);
  }
  _buildEnvironmentTargets(ctx, size) {
    this._cubeRT?.dispose();
    this._pmremTarget?.dispose();
    this._pmremTarget = null;
    this._cubeRT = new THREE.WebGLCubeRenderTarget(size, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.LinearSRGBColorSpace,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false
    });
    this._cubeCamera = new THREE.CubeCamera(0.1, 10, this._cubeRT);
    this._apUniforms.uApSky.value = this._cubeRT.texture;
    this.fogParams.skyCube = this._cubeRT.texture;
    if (this._pmrem === null) this._pmrem = new THREE.PMREMGenerator(ctx.renderer);
    this._pmrem.compileCubemapShader();
  }
  _applyAerialPatch(shader) {
    if (shader.vertexShader.indexOf("#include <fog_vertex>") < 0) return;
    if (shader.fragmentShader.indexOf("#include <fog_fragment>") < 0) return;
    shader.vertexShader = AERIAL_VERTEX_DECL + shader.vertexShader.replace(
      "#include <fog_vertex>",
      AERIAL_VERTEX_BODY
    );
    shader.fragmentShader = AERIAL_FRAGMENT_DECL + shader.fragmentShader.replace(
      "#include <fog_fragment>",
      AERIAL_FRAGMENT_BODY
    );
    shader.uniforms.uApSky = this._apUniforms.uApSky;
    shader.uniforms.uApSkyIntensity = this._apUniforms.uApSkyIntensity;
    shader.uniforms.uApStrength = this._apUniforms.uApStrength;
  }
  _onQualityChange(quality, ctx) {
    const name = quality?.name ?? "high";
    const cfg = QUALITY_SKY[name] ?? QUALITY_SKY.high;
    const previous = QUALITY_SKY[this._tierName] ?? QUALITY_SKY.high;
    this._tierName = name;
    if (cfg.steps !== previous.steps || cfg.cloudTaps !== previous.cloudTaps) {
      this._buildSkyMaterials(cfg);
    }
    if (cfg.cubeSize !== previous.cubeSize) {
      this._buildEnvironmentTargets(ctx, cfg.cubeSize);
    }
    this.shadows.setQuality(quality);
    this.sunLight = this.shadows.lights[0];
    this._envDirty = true;
  }
  setTimeOfDay(hours) {
    this.timeOfDay = (hours % 24 + 24) % 24;
    this._solveSun();
    this._envDirty = true;
  }
  setLocation({ latitude, longitude, dayOfYear }) {
    if (Number.isFinite(latitude)) this.latitude = latitude;
    if (Number.isFinite(longitude)) this.longitude = longitude;
    if (Number.isFinite(dayOfYear)) this.dayOfYear = dayOfYear;
    this._solveSun();
    this._envDirty = true;
  }
  setWeather(w = {}) {
    const t = this._weatherTarget;
    if (Number.isFinite(w.cloudCover)) t.cloudCover = clamp01(w.cloudCover);
    if (Number.isFinite(w.rain)) t.rain = clamp01(w.rain);
    if (Number.isFinite(w.windSpeed)) t.windSpeed = Math.max(0, w.windSpeed);
    if (Number.isFinite(w.windDir)) t.windDir = w.windDir;
    if (Number.isFinite(w.turbidity)) t.turbidity = clamp(w.turbidity, 1, 8);
    else if (Number.isFinite(w.cloudCover) || Number.isFinite(w.rain)) {
      t.turbidity = clamp(1.05 + t.cloudCover * 1.5 + t.rain * 1.3, 1, 8);
    }
  }
  _solveSun() {
    const gamma = 2 * Math.PI / 365 * (this.dayOfYear - 1 + (this.timeOfDay - 12) / 24);
    const c1 = Math.cos(gamma);
    const s1 = Math.sin(gamma);
    const c2 = Math.cos(2 * gamma);
    const s2 = Math.sin(2 * gamma);
    const c3 = Math.cos(3 * gamma);
    const s3 = Math.sin(3 * gamma);
    const eqTime = 229.18 * (75e-6 + 1868e-6 * c1 - 0.032077 * s1 - 0.014615 * c2 - 0.040849 * s2);
    const decl = 6918e-6 - 0.399912 * c1 + 0.070257 * s1 - 6758e-6 * c2 + 907e-6 * s2 - 2697e-6 * c3 + 148e-5 * s3;
    const timezone = Math.round(this.longitude / 15);
    const trueSolarMinutes = this.timeOfDay * 60 + eqTime + 4 * this.longitude - 60 * timezone;
    const hourAngle = (trueSolarMinutes / 4 - 180) * DEG;
    const lat = this.latitude * DEG;
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinDec = Math.sin(decl);
    const cosDec = Math.cos(decl);
    const cosZenith = clamp(sinLat * sinDec + cosLat * cosDec * Math.cos(hourAngle), -1, 1);
    const altitude = Math.PI / 2 - Math.acos(cosZenith);
    const cosAlt = Math.max(Math.cos(altitude), 1e-6);
    const sinAz = -Math.sin(hourAngle) * cosDec / cosAlt;
    const cosAz = (sinDec - sinLat * Math.sin(altitude)) / (Math.max(Math.abs(cosLat), 1e-6) * cosAlt);
    const azimuth = Math.atan2(sinAz, cosAz);
    this.sunAltitude = altitude;
    this.sunAzimuth = azimuth;
    this.sunDirection.set(
      Math.sin(azimuth) * cosAlt,
      Math.sin(altitude),
      -Math.cos(azimuth) * cosAlt
    );
    this.sunDirection.normalize();
  }
  update(dt, ctx) {
    if (!this._trackAdopted && ctx.track) {
      this._trackAdopted = true;
      if (Number.isFinite(ctx.track.latitude) || Number.isFinite(ctx.track.longitude)) {
        this.setLocation({
          latitude: ctx.track.latitude,
          longitude: ctx.track.longitude,
          dayOfYear: ctx.track.dayOfYear
        });
      }
    }
    const w = this.weather;
    const t = this._weatherTarget;
    const before = w.cloudCover;
    w.cloudCover = damp(w.cloudCover, t.cloudCover, WEATHER_RATE, dt);
    w.rain = damp(w.rain, t.rain, WEATHER_RATE, dt);
    w.windSpeed = damp(w.windSpeed, t.windSpeed, WEATHER_RATE, dt);
    w.turbidity = damp(w.turbidity, t.turbidity, WEATHER_RATE, dt);
    let dDir = t.windDir - w.windDir;
    while (dDir > Math.PI) dDir -= Math.PI * 2;
    while (dDir < -Math.PI) dDir += Math.PI * 2;
    w.windDir += dDir * (1 - Math.exp(-WEATHER_RATE * dt));
    const windX = Math.sin(w.windDir) * w.windSpeed;
    const windZ = -Math.cos(w.windDir) * w.windSpeed;
    this._cloud.update(dt, windX, windZ, w.cloudCover);
    this._uniforms.uTime.value = ctx.time.elapsed;
    if (Math.abs(w.cloudCover - before) > 1e-4) this._envDirty = true;
    this._updateLighting(ctx);
    this._materialSyncTimer += dt;
    if (this._materialSyncTimer >= 0.5) {
      this._materialSyncTimer = 0;
      this.shadows.syncMaterials(ctx.scene);
    }
    this._envTimer += dt;
    this._envAge += dt;
    this._maybeRegenerateEnvironment(ctx);
  }
  _updateLighting(ctx) {
    const w = this.weather;
    const alt = this.sunDirection.y;
    const u = this._uniforms;
    u.uSunDir.value.copy(this.sunDirection);
    u.uTurbidity.value = w.turbidity;
    u.uOzone.value = 1;
    ctx.camera.getWorldPosition(_worldPos);
    u.uCameraAltitude.value = clamp(_worldPos.y, 0, 4e3);
    u.uStarIntensity.value = smoothstep(0.03, -0.1, alt) * 0.55 * (1 - w.cloudCover * 0.85);
    u.uSunIrradiance.value.setScalar(SUN_TOA_IRRADIANCE);
    u.uSunDiscRadiance.value = Math.min(SUN_TOA_IRRADIANCE * SUN_DISC_SCALE / SUN_SOLID_ANGLE, 180);
    sunTransmittance(alt, 0, w.turbidity, 1, _trans);
    const luminousT = 0.2126 * _trans.x + 0.7152 * _trans.y + 0.0722 * _trans.z;
    this.sunColorTemperature = 2e3 + 3800 * smootherstep(-9e-3, 0.342, alt);
    kelvinToLinearRGB(this.sunColorTemperature, _tint);
    const beamThroughCloud = 1 - smoothstep(0.35, 0.98, w.cloudCover) * 0.97;
    const horizonFade = clamp01(smoothstep(-0.045, 0.012, alt));
    this.sunIlluminance = SUN_TOA_IRRADIANCE * luminousT * horizonFade * beamThroughCloud;
    const discPeak = Math.min(SUN_TOA_IRRADIANCE * SUN_DISC_SCALE / SUN_SOLID_ANGLE, 180);
    this._sunDiscBase.set(
      discPeak * _trans.x * horizonFade,
      discPeak * _trans.y * horizonFade,
      discPeak * _trans.z * horizonFade
    );
    const altDeg = Math.asin(clamp(alt, -1, 1)) / DEG;
    const airMass = clamp(
      1 / (Math.max(alt, 0) + 0.50572 * Math.pow(Math.max(altDeg + 6.07995, 0.05), -1.6364)),
      1,
      SUN_GLARE_MAX_AIRMASS
    );
    this._glareGain = Math.sqrt(airMass);
    this._glareSpread = 1 + (airMass - 1) * 0.16;
    _color.setRGB(_tint.x, _tint.y, _tint.z, THREE.LinearSRGBColorSpace);
    this.shadows.setSunDirection(this.sunDirection);
    this.shadows.setLight(_color, this.sunIlluminance);
    this._sampleSky(ctx);
    const lift = (1 + w.cloudCover * 1.35) * (1 - w.rain * 0.35);
    _zenith.copy(this._skyZenith).multiplyScalar(lift);
    _horizon.copy(this._skyLow).multiplyScalar(lift);
    _mid.copy(this._skyMid).add(this._skyMidOpp).multiplyScalar(0.5 * lift);
    this.fogParams.zenithRadiance.copy(_zenith);
    this.fogParams.horizonRadiance.copy(_horizon);
    const bandZenith = (_zenith.x + _zenith.y + _zenith.z) / 3;
    const bandMid = (_mid.x + _mid.y + _mid.z) / 3;
    const bandLow = (_horizon.x + _horizon.y + _horizon.z) / 3 * 0.75;
    this.diffuseFraction = 0.52 + 0.48 * smoothstep(0.12, 0.8, w.cloudCover);
    this.skyIlluminance = 2 * Math.PI * (0.219 * bandZenith + 0.25 * bandMid + 0.031 * bandLow) * this.diffuseFraction;
    ctx.scene.environmentIntensity = this.diffuseFraction;
    const fillPeak = Math.max(_zenith.x, _zenith.y, _zenith.z, 1e-6);
    this.hemisphere.color.setRGB(_zenith.x / fillPeak, _zenith.y / fillPeak, _zenith.z / fillPeak, THREE.LinearSRGBColorSpace);
    const groundBounce = 0.16;
    this.hemisphere.groundColor.setRGB(
      clamp01(_horizon.x / fillPeak) * 0.55 + groundBounce,
      clamp01(_horizon.y / fillPeak) * 0.5 + groundBounce * 0.92,
      clamp01(_horizon.z / fillPeak) * 0.42 + groundBounce * 0.78,
      THREE.LinearSRGBColorSpace
    );
    this.hemisphere.intensity = this.skyIlluminance * 0.05;
    sunTransmittance(alt, this._cloud.baseHeight, w.turbidity, 1, _cloudSun);
    const deckFade = clamp01(smoothstep(-0.062, -4e-3, alt));
    u.uCloudSunColor.value.set(
      _cloudSun.x * SUN_TOA_IRRADIANCE * deckFade,
      _cloudSun.y * SUN_TOA_IRRADIANCE * deckFade,
      _cloudSun.z * SUN_TOA_IRRADIANCE * deckFade
    );
    const ambR = _zenith.x * 1.9;
    const ambG = _zenith.y * 1.9;
    const ambB = _zenith.z * 1.9;
    const ambGrey = 0.2126 * ambR + 0.7152 * ambG + 0.0722 * ambB;
    const desat = w.cloudCover * 0.68;
    u.uCloudAmbient.value.set(
      ambR + (ambGrey - ambR) * desat,
      ambG + (ambGrey - ambG) * desat,
      ambB + (ambGrey - ambB) * desat
    );
    u.uCloudOpacity.value = clamp01(w.cloudCover * 14);
    u.uCloudCirrusOpacity.value = clamp01(0.12 + w.cloudCover * 0.55) * (1 - smoothstep(0.7, 1, w.cloudCover));
    u.uCloudAbsorption.value = 3 + w.rain * 2.5;
    this.fogParams.density = 3e-4 + (w.turbidity - 1) * 13e-5 + w.cloudCover * 12e-5 + w.rain * 85e-5;
    this.fogParams.color.setRGB(_horizon.x, _horizon.y, _horizon.z, THREE.LinearSRGBColorSpace);
    this._apUniforms.uApStrength.value = clamp01(this.fogParams.strength);
    if (ctx.scene.fog) {
      ctx.scene.fog.density = this.fogParams.density;
      ctx.scene.fog.color.copy(this.fogParams.color);
    }
  }
  _sampleSky(ctx) {
    this._skySampleTimer += ctx.time.dt;
    if (this._skySampleTimer < 0.1 && this._skySampled) return;
    this._skySampleTimer = 0;
    this._skySampled = true;
    const w = this.weather;
    const ms = this._uniforms.uMultiScatter.value;
    const sx = this.sunDirection.x;
    const sy = this.sunDirection.y;
    const sz = this.sunDirection.z;
    const az = Math.max(Math.hypot(sx, sz), 1e-4);
    const ax = sx / az;
    const azh = sz / az;
    skyRadiance(0, 1, 0, sx, sy, sz, 0, w.turbidity, 1, ms, 8, this._skyZenith);
    skyRadiance(ax * 0.866, 0.5, azh * 0.866, sx, sy, sz, 0, w.turbidity, 1, ms, 8, this._skyMid);
    skyRadiance(-ax * 0.866, 0.5, -azh * 0.866, sx, sy, sz, 0, w.turbidity, 1, ms, 8, this._skyMidOpp);
    skyRadiance(ax * 0.998, 0.063, azh * 0.998, sx, sy, sz, 0, w.turbidity, 1, ms, 8, this._skyLow);
    this._skyZenith.multiplyScalar(SUN_TOA_IRRADIANCE);
    this._skyMid.multiplyScalar(SUN_TOA_IRRADIANCE);
    this._skyMidOpp.multiplyScalar(SUN_TOA_IRRADIANCE);
    this._skyLow.multiplyScalar(SUN_TOA_IRRADIANCE);
  }
  _maybeRegenerateEnvironment(ctx) {
    const alt = this.sunDirection.y;
    const dirty = this._envDirty || Math.abs(alt - this._lastEnvAltitude) > 6e-3 || Math.abs(this.weather.cloudCover - this._lastEnvCover) > 0.02 || Math.abs(this.weather.rain - this._lastEnvRain) > 0.05 || this._envAge > 6;
    if (!dirty || this._envTimer < 0.35) return;
    this._regenerateEnvironment(ctx);
  }
  _regenerateEnvironment(ctx) {
    const renderer = ctx.renderer;
    this._cubeCamera.update(renderer, this._skyScene);
    const previousTarget = this._pmremTarget;
    this._pmremTarget = this._pmrem.fromCubemap(this._cubeRT.texture, previousTarget);
    this.environment = this._pmremTarget.texture;
    ctx.scene.environment = this.environment;
    this._envDirty = false;
    this._envTimer = 0;
    this._envAge = 0;
    this._lastEnvAltitude = this.sunDirection.y;
    this._lastEnvCover = this.weather.cloudCover;
    this._lastEnvRain = this.weather.rain;
  }
  lateUpdate(alpha, ctx) {
    this._fitShadows(ctx);
    if (!this._hookActive) this._cameraSync(ctx, ctx.camera);
  }
  _fitShadows(ctx) {
    if (this._fittedFrame === ctx.time.frame) return;
    this._fittedFrame = ctx.time.frame;
    this.shadows.update(ctx.camera, ctx.renderer);
    this.shadows.group.updateMatrixWorld(true);
  }
  _cameraSync(ctx, camera) {
    camera.getWorldPosition(_worldPos);
    this.skyMesh.position.copy(_worldPos);
    this.skyMesh.updateMatrix();
    this.skyMesh.updateMatrixWorld(true);
    this._fitShadows(ctx);
    const frameDt = clamp(ctx.time.elapsed - this._lastElapsed, 1e-4, 0.25);
    this._lastElapsed = ctx.time.elapsed;
    _project.copy(_worldPos).addScaledVector(this.sunDirection, 8e3).project(camera);
    camera.getWorldDirection(_camForward);
    const facing = _camForward.dot(this.sunDirection);
    if (facing <= 0) {
      const mirrored = Math.max(Math.abs(_project.x), Math.abs(_project.y), 1e-3);
      _project.x *= -2.5 / mirrored;
      _project.y *= -2.5 / mirrored;
    }
    this.sunScreenPosition.copy(_project);
    const edge = Math.max(Math.abs(_project.x), Math.abs(_project.y));
    this.sunOnScreen = facing > 0 && edge <= 1;
    const cloudT = this._cloud.sunTransmittance(
      this.sunDirection.x,
      this.sunDirection.y,
      this.sunDirection.z
    );
    let visibility = clamp01(smoothstep(-0.015, 0.03, this.sunDirection.y));
    visibility *= facing > 0 ? 1 - smoothstep(1, 1.7, edge) : 0;
    visibility *= cloudT;
    visibility *= this._externalOcclusion;
    const disc = this._sunUniforms.uDiscRadiance.value;
    disc.copy(this._sunDiscBase).multiplyScalar(cloudT);
    this._sunUniforms.uGlareRadiance.value.copy(disc).multiplyScalar(
      SUN_GLARE_FRACTION * (1 + (this.weather.turbidity - 1) * 0.35) * this._glareGain
    );
    this._sunUniforms.uInvGlareSpread.value = 1 / this._glareSpread;
    this._sunMesh.visible = disc.x + disc.y + disc.z > 1e-4;
    this._visibilityRaw = damp(this._visibilityRaw, visibility, 12, frameDt);
    this.sunVisibility = this._visibilityRaw;
  }
  setExternalOcclusion(value) {
    this._externalOcclusion = clamp01(value);
  }
  resize(width, height, ctx) {
    this.shadows.syncMaterials(ctx.scene);
  }
  dispose() {
    this._unsubscribeQuality?.();
    this._unsubscribeSettings?.();
    if (this._ctx && this._ctx.scene.onBeforeRender === this._sceneHook) {
      this._ctx.scene.onBeforeRender = () => {
      };
    }
    this.skyMesh?.parent?.remove(this.skyMesh);
    this._sunMesh?.parent?.remove(this._sunMesh);
    this._captureMesh?.parent?.remove(this._captureMesh);
    this.hemisphere?.parent?.remove(this.hemisphere);
    this._domeGeometry?.dispose();
    this._domeMaterial?.dispose();
    this._captureMaterial?.dispose();
    this._sunGeometry?.dispose();
    this._sunMaterial?.dispose();
    this._cloud?.dispose();
    this._cubeRT?.dispose();
    this._pmremTarget?.dispose();
    this._pmrem?.dispose();
    this.shadows?.dispose();
    this._domeGeometry = null;
    this._domeMaterial = null;
    this._captureMaterial = null;
    this._sunGeometry = null;
    this._sunMaterial = null;
    this._sunMesh = null;
    this._cubeRT = null;
    this._cubeCamera = null;
    this._pmremTarget = null;
    this._pmrem = null;
    this.environment = null;
    this.fogParams.skyCube = null;
  }
}
export { ATMOSPHERE, SUN_TOA_IRRADIANCE };
