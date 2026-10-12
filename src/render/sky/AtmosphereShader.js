import * as THREE from "three";
export const ATMOSPHERE = {
  planetRadius: 636e4,
  atmosphereRadius: 642e4,
  rayleighScaleHeight: 8e3,
  mieScaleHeight: 1200,
  betaRayleigh: [5802e-9, 13558e-9, 331e-7],
  betaMieScatter: 3996e-9,
  betaMieExtinction: 444e-8,
  betaOzone: [65e-8, 1881e-9, 85e-9],
  ozoneCentre: 25e3,
  ozoneHalfWidth: 15e3,
  ozoneColumn: 15e3,
  mieG: 0.76
};
export const SUN_TOA_IRRADIANCE = 4.6;
export const SUN_ANGULAR_RADIUS = 4651e-6;
export const SUN_SOLID_ANGLE = 2 * Math.PI * (1 - Math.cos(SUN_ANGULAR_RADIUS));
const _betaR = new THREE.Vector3(...ATMOSPHERE.betaRayleigh);
const _betaO = new THREE.Vector3(...ATMOSPHERE.betaOzone);
function chapman(radiusOverH, hOverH, cosZenith) {
  const c = Math.sqrt(radiusOverH + hOverH);
  if (cosZenith >= 0) {
    return c / (c * cosZenith + 1) * Math.exp(-hOverH);
  }
  const sinZ = Math.sqrt(Math.max(0, 1 - cosZenith * cosZenith));
  const x0 = sinZ * (radiusOverH + hOverH);
  const c0 = Math.sqrt(x0);
  const e = Math.min(radiusOverH - x0, 60);
  return 2 * c0 * Math.exp(e) - c / (1 - c * cosZenith) * Math.exp(-hOverH);
}
function ozoneAirMass(cosZenith) {
  const cz = Math.max(cosZenith, 0);
  let m = 1 / Math.sqrt(cz * cz + 786e-5);
  if (cosZenith < 0) m *= 1 + -cosZenith * 40;
  return m;
}
export function sunTransmittance(cosZenith, altitude, turbidity, ozoneAmount, out) {
  const A = ATMOSPHERE;
  const tauR = chapman(A.planetRadius / A.rayleighScaleHeight, altitude / A.rayleighScaleHeight, cosZenith) * A.rayleighScaleHeight;
  const tauM = chapman(A.planetRadius / A.mieScaleHeight, altitude / A.mieScaleHeight, cosZenith) * A.mieScaleHeight * turbidity;
  const tauO = A.ozoneColumn * ozoneAmount * ozoneAirMass(cosZenith);
  const mie = A.betaMieExtinction * tauM;
  out.x = Math.exp(-(_betaR.x * tauR + mie + _betaO.x * tauO));
  out.y = Math.exp(-(_betaR.y * tauR + mie + _betaO.y * tauO));
  out.z = Math.exp(-(_betaR.z * tauR + mie + _betaO.z * tauO));
  return out;
}
export const SKY_VERTEX_SHADER = (
  `
varying vec3 vSkyDir;

void main() {
  vSkyDir = normalize( position );
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  gl_Position.z = gl_Position.w;
}
`
);
export const ATMOSPHERE_GLSL = (
  `
#define ATM_PI 3.141592653589793

const float ATM_RG = ${ATMOSPHERE.planetRadius.toFixed(1)};
const float ATM_RT = ${ATMOSPHERE.atmosphereRadius.toFixed(1)};
const float ATM_HR = ${ATMOSPHERE.rayleighScaleHeight.toFixed(1)};
const float ATM_HM = ${ATMOSPHERE.mieScaleHeight.toFixed(1)};
const vec3  ATM_BETA_R = vec3( ${ATMOSPHERE.betaRayleigh.map((v) => v.toExponential(6)).join(", ")} );
const float ATM_BETA_M = ${ATMOSPHERE.betaMieScatter.toExponential(6)};
const float ATM_BETA_M_EXT = ${ATMOSPHERE.betaMieExtinction.toExponential(6)};
const vec3  ATM_BETA_O = vec3( ${ATMOSPHERE.betaOzone.map((v) => v.toExponential(6)).join(", ")} );
const float ATM_OZONE_COLUMN = ${ATMOSPHERE.ozoneColumn.toFixed(1)};

uniform vec3  uSunDir;
uniform vec3  uSunIrradiance;
uniform float uTurbidity;
uniform float uOzone;
uniform float uMieG;
uniform float uMultiScatter;
uniform float uCameraAltitude;
uniform float uGroundAlbedo;
uniform vec3  uNightRadiance;
uniform float uStarIntensity;
uniform float uTime;

float atmChapman( float X, float h, float cosZ ) {
  float c = sqrt( X + h );
  if ( cosZ >= 0.0 ) return c / ( c * cosZ + 1.0 ) * exp( - h );
  float sinZ = sqrt( max( 0.0, 1.0 - cosZ * cosZ ) );
  float x0 = sinZ * ( X + h );
  float c0 = sqrt( x0 );
  float e = min( X - x0, 60.0 );
  return 2.0 * c0 * exp( e ) - c / ( 1.0 - c * cosZ ) * exp( - h );
}

float atmOzoneAirMass( float cosZ ) {
  float cz = max( cosZ, 0.0 );
  float m = inversesqrt( cz * cz + 0.00786 );
  return cosZ < 0.0 ? m * ( 1.0 + ( - cosZ ) * 40.0 ) : m;
}

vec3 atmSunTransmittance( float h, float cosZ ) {
  float tauR = atmChapman( ATM_RG / ATM_HR, h / ATM_HR, cosZ ) * ATM_HR;
  float tauM = atmChapman( ATM_RG / ATM_HM, h / ATM_HM, cosZ ) * ATM_HM * uTurbidity;
  float tauO = ATM_OZONE_COLUMN * uOzone * atmOzoneAirMass( cosZ );
  return exp( - ( ATM_BETA_R * tauR + vec3( ATM_BETA_M_EXT * tauM ) + ATM_BETA_O * tauO ) );
}

float atmPhaseRayleigh( float mu ) {
  return 3.0 / ( 16.0 * ATM_PI ) * ( 1.0 + mu * mu );
}

float atmPhaseMie( float mu, float g ) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * mu;
  return 3.0 / ( 8.0 * ATM_PI ) * ( ( 1.0 - g2 ) * ( 1.0 + mu * mu ) ) /
         ( ( 2.0 + g2 ) * pow( max( d, 1e-4 ), 1.5 ) );
}

float atmSphereFar( vec3 ro, vec3 rd, float radius ) {
  float b = dot( ro, rd );
  float c = dot( ro, ro ) - radius * radius;
  float d = b * b - c;
  if ( d < 0.0 ) return -1.0;
  return - b + sqrt( d );
}

float atmSphereNear( vec3 ro, vec3 rd, float radius ) {
  float b = dot( ro, rd );
  float c = dot( ro, ro ) - radius * radius;
  float d = b * b - c;
  if ( d < 0.0 ) return -1.0;
  d = sqrt( d );
  float t0 = - b - d;
  return t0 > 0.0 ? t0 : -1.0;
}

vec3 atmScatter( vec3 ro, vec3 rd, vec3 sunDir, out vec3 outTransmittance ) {
  float tTop = atmSphereFar( ro, rd, ATM_RT );
  float tGround = atmSphereNear( ro, rd, ATM_RG );
  float tMax = tGround > 0.0 ? tGround : max( tTop, 0.0 );

  float mu = dot( rd, sunDir );
  float phaseR = atmPhaseRayleigh( mu );
  float phaseM = atmPhaseMie( mu, uMieG );

  vec3 tau = vec3( 0.0 );
  vec3 lum = vec3( 0.0 );

  for ( int i = 0; i < ATM_STEPS; i ++ ) {
    float a = float( i ) / float( ATM_STEPS );
    float b = float( i + 1 ) / float( ATM_STEPS );
    float tA = a * a * tMax;
    float tB = b * b * tMax;
    float ds = tB - tA;
    if ( ds <= 0.0 ) continue;

    vec3 p = ro + rd * ( 0.5 * ( tA + tB ) );
    float r = length( p );
    float h = max( r - ATM_RG, 0.0 );

    float dR = exp( - h / ATM_HR );
    float dM = exp( - h / ATM_HM ) * uTurbidity;
    float dO = max( 0.0, 1.0 - abs( h - ${ATMOSPHERE.ozoneCentre.toFixed(1)} ) / ${ATMOSPHERE.ozoneHalfWidth.toFixed(1)} ) * uOzone;

    vec3 scatterR = ATM_BETA_R * dR;
    float scatterM = ATM_BETA_M * dM;
    vec3 extinction = scatterR + vec3( ATM_BETA_M_EXT * dM ) + ATM_BETA_O * dO;

    vec3 tSun = atmSunTransmittance( h, dot( p / r, sunDir ) );

    vec3 single = ( scatterR * phaseR + vec3( scatterM * phaseM ) ) * tSun;
    vec3 multi = ( scatterR + vec3( scatterM ) ) * ( uMultiScatter * 0.25 / ATM_PI ) * tSun;

    vec3 segT = exp( - extinction * ds );
    vec3 integrated = ( single + multi ) * ( 1.0 - segT ) / max( extinction, vec3( 1e-12 ) );

    lum += exp( - tau ) * integrated;
    tau += extinction * ds;
  }

  outTransmittance = exp( - tau );

  if ( tGround > 0.0 ) {
    float cosSunZ = max( dot( normalize( ro + rd * tGround ), sunDir ), 0.0 );
    vec3 groundLight = atmSunTransmittance( 0.0, dot( normalize( ro ), sunDir ) ) * cosSunZ;
    lum += outTransmittance * uGroundAlbedo * ( groundLight + uMultiScatter * 0.06 ) / ATM_PI;
    outTransmittance = vec3( 0.0 );
  }

  return lum;
}

vec3 atmLimbDarkening( float centreToEdge ) {
  const vec3 u = vec3( 1.0 );
  const vec3 a = vec3( 0.397, 0.503, 0.652 );
  float m = sqrt( max( 1.0 - centreToEdge * centreToEdge, 0.0 ) );
  return vec3( 1.0 ) - u * ( vec3( 1.0 ) - pow( vec3( m ), a ) );
}

float atmIGN( vec2 p ) {
  return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
}

float atmHash31( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.zyx + 31.32 );
  return fract( ( p.x + p.y ) * p.z );
}

vec3 atmStars( vec3 dir ) {
  if ( uStarIntensity <= 0.0 ) return vec3( 0.0 );
  vec3 g = dir * 260.0;
  float footprint = max( length( fwidth( g ) ), 1e-3 );
  float invSigma2 = 1.0 / ( footprint * footprint * 0.32 );
  vec3 cell = floor( g );
  vec3 f = g - cell;
  vec3 acc = vec3( 0.0 );
  for ( int x = -1; x <= 1; x ++ ) {
    for ( int y = -1; y <= 1; y ++ ) {
      for ( int z = -1; z <= 1; z ++ ) {
        vec3 o = vec3( float( x ), float( y ), float( z ) );
        vec3 c = cell + o;
        float h = atmHash31( c );
        if ( h < 0.9935 ) continue;
        vec3 jitter = vec3( atmHash31( c + 11.7 ), atmHash31( c + 23.1 ), atmHash31( c + 37.9 ) );
        float d = length( f - o - jitter );
        float mag = pow( atmHash31( c + 51.3 ), 4.0 );
        float twinkle = 0.75 + 0.25 * sin( uTime * 2.7 + h * 90.0 );
        float ci = atmHash31( c + 71.5 );
        vec3 tint = mix( vec3( 1.0, 0.79, 0.58 ), vec3( 0.84, 0.89, 1.0 ), smoothstep( 0.12, 0.5, ci ) );
        acc += tint * mag * twinkle * exp( - d * d * invSigma2 );
      }
    }
  }
  return acc * uStarIntensity;
}
`
);
export function buildSkyFragmentShader({ steps, sunDisc, cloudGLSL, cloudLightTaps }) {
  return (
    `
precision highp float;

#define ATM_STEPS ${Math.max(4, steps | 0)}
#define CLOUD_LIGHT_TAPS ${Math.max(1, cloudLightTaps | 0)}
${sunDisc ? "#define SUN_DISC" : ""}

varying vec3 vSkyDir;

uniform float uSunDiscRadiance;
uniform float uDither;

${ATMOSPHERE_GLSL}
${cloudGLSL}

void main() {
  vec3 dir = normalize( vSkyDir );
  vec3 ro = vec3( 0.0, ATM_RG + uCameraAltitude, 0.0 );

  vec3 transmittance;
  vec3 radiance = atmScatter( ro, dir, uSunDir, transmittance ) * uSunIrradiance;

  radiance += ( uNightRadiance + atmStars( dir ) ) * transmittance;

  #ifdef SUN_DISC
    float cosAngle = dot( dir, uSunDir );
    float cosLimb = cos( ${SUN_ANGULAR_RADIUS.toFixed(8)} );
    if ( cosAngle > cosLimb ) {
      float centreToEdge = clamp( acos( clamp( cosAngle, -1.0, 1.0 ) ) / ${SUN_ANGULAR_RADIUS.toFixed(8)}, 0.0, 1.0 );
      vec3 sunT = atmSunTransmittance( uCameraAltitude, uSunDir.y );
      float edge = 1.0 - smoothstep( 0.94, 1.0, centreToEdge );
      radiance += uSunDiscRadiance * sunT * atmLimbDarkening( centreToEdge ) * edge * transmittance;
    }
  #endif

  radiance = cloudComposite( dir, radiance, uSunDir );

  float n = atmIGN( gl_FragCoord.xy ) - 0.5;
  radiance *= 1.0 + n * uDither;

  gl_FragColor = vec4( max( radiance, vec3( 0.0 ) ), 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`
  );
}
export function createAtmosphereUniforms() {
  return {
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunIrradiance: { value: new THREE.Vector3(SUN_TOA_IRRADIANCE, SUN_TOA_IRRADIANCE, SUN_TOA_IRRADIANCE) },
    uTurbidity: { value: 1 },
    uOzone: { value: 1 },
    uMieG: { value: ATMOSPHERE.mieG },
    uMultiScatter: { value: 1.8 },
    uCameraAltitude: { value: 20 },
    uGroundAlbedo: { value: 0.11 },
    uNightRadiance: { value: new THREE.Vector3(0.016, 0.026, 0.058) },
    uStarIntensity: { value: 0 },
    uTime: { value: 0 },
    uSunDiscRadiance: { value: 100 },
    uDither: { value: 6e-3 }
  };
}
const _tauR = { x: 0, y: 0, z: 0 };
export function skyRadiance(dx, dy, dz, sx, sy, sz, altitude, turbidity, ozoneAmount, multiScatter, steps, out) {
  const A = ATMOSPHERE;
  const rg = A.planetRadius;
  const oy = rg + altitude;
  const b = oy * dy;
  const cTop = oy * oy - A.atmosphereRadius * A.atmosphereRadius;
  let disc = b * b - cTop;
  const tTop = disc < 0 ? 0 : -b + Math.sqrt(disc);
  const cGround = oy * oy - rg * rg;
  disc = b * b - cGround;
  let tGround = -1;
  if (disc >= 0) {
    const t0 = -b - Math.sqrt(disc);
    if (t0 > 0) tGround = t0;
  }
  const tMax = tGround > 0 ? tGround : tTop;
  const mu = dx * sx + dy * sy + dz * sz;
  const phaseR = 3 / (16 * Math.PI) * (1 + mu * mu);
  const g = A.mieG;
  const g2 = g * g;
  const denom = Math.pow(Math.max(1 + g2 - 2 * g * mu, 1e-4), 1.5);
  const phaseM = 3 / (8 * Math.PI) * ((1 - g2) * (1 + mu * mu)) / ((2 + g2) * denom);
  let tauX = 0;
  let tauY = 0;
  let tauZ = 0;
  let lx = 0;
  let ly = 0;
  let lz = 0;
  for (let i = 0; i < steps; i++) {
    const a0 = i / steps;
    const a1 = (i + 1) / steps;
    const tA = a0 * a0 * tMax;
    const tB = a1 * a1 * tMax;
    const ds = tB - tA;
    if (ds <= 0) continue;
    const tm = 0.5 * (tA + tB);
    const px = dx * tm;
    const py = oy + dy * tm;
    const pz = dz * tm;
    const r = Math.sqrt(px * px + py * py + pz * pz);
    const h = Math.max(r - rg, 0);
    const dR = Math.exp(-h / A.rayleighScaleHeight);
    const dM = Math.exp(-h / A.mieScaleHeight) * turbidity;
    const dO = Math.max(0, 1 - Math.abs(h - A.ozoneCentre) / A.ozoneHalfWidth) * ozoneAmount;
    const srx = A.betaRayleigh[0] * dR;
    const sry = A.betaRayleigh[1] * dR;
    const srz = A.betaRayleigh[2] * dR;
    const sm = A.betaMieScatter * dM;
    const me = A.betaMieExtinction * dM;
    const ex = srx + me + A.betaOzone[0] * dO;
    const ey = sry + me + A.betaOzone[1] * dO;
    const ez = srz + me + A.betaOzone[2] * dO;
    sunTransmittance((px * sx + py * sy + pz * sz) / r, h, turbidity, ozoneAmount, _tauR);
    const iso = multiScatter * 0.25 / Math.PI;
    const scx = (srx * phaseR + sm * phaseM + (srx + sm) * iso) * _tauR.x;
    const scy = (sry * phaseR + sm * phaseM + (sry + sm) * iso) * _tauR.y;
    const scz = (srz * phaseR + sm * phaseM + (srz + sm) * iso) * _tauR.z;
    const vx = Math.exp(-tauX);
    const vy = Math.exp(-tauY);
    const vz = Math.exp(-tauZ);
    lx += vx * scx * (1 - Math.exp(-ex * ds)) / Math.max(ex, 1e-12);
    ly += vy * scy * (1 - Math.exp(-ey * ds)) / Math.max(ey, 1e-12);
    lz += vz * scz * (1 - Math.exp(-ez * ds)) / Math.max(ez, 1e-12);
    tauX += ex * ds;
    tauY += ey * ds;
    tauZ += ez * ds;
  }
  out.x = lx;
  out.y = ly;
  out.z = lz;
  return out;
}
export function kelvinToLinearRGB(kelvin, out) {
  const t = Math.min(Math.max(kelvin, 1667), 25e3);
  const t2 = t * t;
  const t3 = t2 * t;
  let x;
  if (t <= 4e3) {
    x = -266123900 / t3 - 234358.9 / t2 + 877.6956 / t + 0.17991;
  } else {
    x = -3025846900 / t3 + 21070379e-1 / t2 + 222.6347 / t + 0.24039;
  }
  const x2 = x * x;
  const x3 = x2 * x;
  let y;
  if (t <= 2222) {
    y = -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683;
  } else if (t <= 4e3) {
    y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
  } else {
    y = 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  }
  const Y = 1;
  const X = x / y * Y;
  const Z = (1 - x - y) / y * Y;
  let r = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z;
  let gch = -0.969266 * X + 1.8760108 * Y + 0.041556 * Z;
  let bch = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  r = Math.max(r, 0);
  gch = Math.max(gch, 0);
  bch = Math.max(bch, 0);
  const peak = Math.max(r, gch, bch, 1e-6);
  out.x = r / peak;
  out.y = gch / peak;
  out.z = bch / peak;
  return out;
}
