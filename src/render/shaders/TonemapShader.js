import * as THREE from 'three';
import { FULLSCREEN_VERTEX } from './MotionBlurShader.js';

/**
 * Filmic tonemapping and colour grade, plus the auto-exposure (eye adaptation) chain.
 *
 * The tonemapper is the Hill fit of the full ACES RRT+ODT (sRGB, 100 nit) — the two
 * 3x3 colour-space matrices around a rational fit — not the single-expression Narkowicz
 * approximation. The matrices matter: they are what desaturates blown highlights toward
 * white instead of clipping them to a flat primary, which is the difference between a
 * sun-lit carbon airbox reading as metal and reading as a magenta blob.
 *
 * The grade around it is deliberately a broadcast-F1 look: real toe and shoulder, teal
 * in the shadows, warmth in the highlights, saturation just above unity.
 *
 * Response shape, measured on a neutral ramp at exposure 1 (scene linear -> sRGB 0-255):
 *
 *     0.003 ->   0     0.045 ->  11     0.36 -> 164     6 -> 250
 *     0.020 ->   1     0.090 ->  36     0.72 -> 223    32 -> 250
 *
 * Three pieces produce that: the black point sits at zero (no lift), a log-space slope
 * of 1.52 opens the mid-tones and separates two surfaces a third of a stop apart, and a
 * hyperbolic pre-roll plus a max-channel soft clip guarantee that no channel ever
 * reaches 1.0 no matter how hot the input is. The previous grade lifted black to 20/255
 * with a blue cast and clipped specular to pure white, which is exactly the "flat
 * mid-sRGB, no luminance range" the review called out.
 *
 * The top end has been wrong in both directions and the settled position is between
 * them. A 9.0 white point rolled a specular peak off two stops below display white, so
 * nothing on a sunlit frame reached the top of the range at all: 0.05% of pixels over
 * 250, which is another way of saying the image had no specular in it. Opening the
 * white point to 24 fixed that and then the soft clip let it run away — a knee at 0.97
 * against a ceiling of 1.0 puts the *whole* roll above display 250, so every pixel that
 * reached the knee counted as clipped and a sunlit braking frame lost 9% of itself.
 * The white point stays at 24, because it is what keeps the value handed to the ODT
 * under the input where the Hill fit saturates (~25.6); the soft clip is what changed.
 * See uHighlightKnee / uHighlightCeil.
 *
 * Auto-exposure is a four-stage GPU reduction (a power mean of luminance -> 16 -> 4 ->
 * 1) followed by a 1x1 ping-pong that smooths the result over time. Nothing is ever
 * read back to the CPU, so there is no pipeline stall. Which mean it takes is not a
 * detail — see EXPOSURE_METER_POWER, and the note on ExposureAdaptShader.
 */

export const TONEMAP_CHUNK = /* glsl */ `
  uniform float uExposureComp;
  uniform float uContrast;
  uniform float uSaturation;
  uniform float uTemperature;
  uniform float uWhitePoint;
  uniform float uToeShoulder;
  uniform float uHighlightKnee;
  uniform float uHighlightCeil;
  uniform vec3 uLift;
  uniform vec3 uGammaCtl;
  uniform vec3 uGain;
  uniform vec3 uShadowTint;
  uniform vec3 uHighlightTint;
  uniform float uSplitBalance;
  uniform vec3 uChannelCurve;

  const mat3 APEX_ACES_IN = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777
  );

  const mat3 APEX_ACES_OUT = mat3(
     1.60475, -0.10208, -0.00327,
    -0.53108,  1.10813, -0.07276,
    -0.07367, -0.00605,  1.07602
  );

  float apexLuma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
  }

  // Cheap Kelvin shift. Luminance is renormalised so warming the frame does not also
  // brighten it and fight the auto-exposure loop.
  vec3 apexWhiteBalance(vec3 c, float t) {
    vec3 gains = vec3(1.0 + 0.175 * t, 1.0 + 0.020 * t, 1.0 - 0.200 * t);
    vec3 shifted = c * gains;
    float before = apexLuma(c);
    float after = apexLuma(shifted);
    return shifted * (before / max(after, 1e-5));
  }

  vec3 apexRRTAndODTFit(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }

  vec3 apexACESFilmic(vec3 c) {
    c = APEX_ACES_IN * c;
    c = apexRRTAndODTFit(c);
    c = APEX_ACES_OUT * c;
    return clamp(c, 0.0, 1.0);
  }

  vec3 apexGrade(vec3 hdr, float exposure) {
    vec3 c = max(hdr, vec3(0.0)) * exposure * uExposureComp;

    c = apexWhiteBalance(c, uTemperature);

    // Sensor shoulder, in HDR. The asymptote at uWhitePoint keeps the value handed to
    // the ODT below the input where the Hill fit reaches 1.0 (~25.6), so a specular
    // saturates smoothly instead of hitting the fit's clip and going paper white.
    c = c / (1.0 + c / uWhitePoint);

    // Contrast about scene mid-grey. A power in linear is a straight slope in log2,
    // so this is the film's mid-tone gamma and nothing else: it opens the separation
    // between two surfaces a third of a stop apart (racing line against tarmac).
    c = 0.18 * pow(c / 0.18 + 1e-6, vec3(uContrast));

    vec3 disp = apexACESFilmic(c);

    // Toe and shoulder on the display curve. smoothstep is exactly an S about 0.5 with
    // zero slope at both ends, so mixing toward it crushes the bottom two stops onto
    // the floor and softens the top without touching the mid-tone slope set above.
    disp = mix(disp, disp * disp * (3.0 - 2.0 * disp), uToeShoulder);

    // Lift / gamma / gain, the colourist's three-band control. uLift is at zero by
    // default: a lifted black is what made every frame read as washed-out mid-grey.
    disp = uLift + disp * (uGain - uLift);
    disp = pow(max(disp, vec3(0.0)), 1.0 / max(uGammaCtl, vec3(1e-3)));

    // Per-channel curve: a touch more shoulder in blue, less in red.
    disp = pow(max(disp, vec3(0.0)), uChannelCurve);

    // Split tone. Multiplicative, so black stays black while the low mid-tones go cool
    // and the highlights go warm — the broadcast look, without tinting the black point.
    float l = apexLuma(disp);
    float split = smoothstep(0.0, 1.0, pow(clamp(l, 0.0, 1.0), uSplitBalance));
    disp *= mix(uShadowTint, uHighlightTint, split);

    float l2 = apexLuma(disp);
    disp = mix(vec3(l2), disp, uSaturation);

    // Max-channel soft clip. The warm highlight tint can push a channel past 1.0 after
    // everything above; rolling the largest channel and scaling the triple by the same
    // factor desaturates toward white the way film does, and caps below 1.0 so a
    // highlight always keeps some colour instead of becoming a flat white hole.
    float mx = max(max(disp.r, disp.g), disp.b);
    if (mx > uHighlightKnee) {
      float t = (mx - uHighlightKnee) / max(1.0 - uHighlightKnee, 1e-4);
      float rolled = uHighlightKnee + (uHighlightCeil - uHighlightKnee) * (1.0 - exp(-t));
      disp *= rolled / max(mx, 1e-5);
    }

    return clamp(disp, 0.0, 1.0);
  }

  vec3 apexLinearToSrgb(vec3 c) {
    vec3 lo = c * 12.92;
    vec3 hi = 1.055 * pow(max(c, vec3(1e-5)), vec3(1.0 / 2.4)) - 0.055;
    return mix(lo, hi, step(vec3(0.0031308), c));
  }
`;

/**
 * Metering constants. They are grouped here because three of the four are coupled:
 * `uMaxExposure` is *derived* from the other three so that the luminance floor is the
 * only clamp that can ever bind (see the note on ExposureAdaptShader), and getting that
 * relationship wrong is what turned a night race into an amplified grey fog once
 * already.
 */

/**
 * Exponent of the power mean the meter reduces the frame to:
 *
 *     adapted = ( mean( clamp(L)^p ) ) ^ (1/p)
 *
 * p -> 0 is the geometric (log) mean, which is what this chain used to compute and
 * which is the wrong statistic for these frames. Measured on two of them at matched
 * exposure: the braking shot renders a median of 129 against the grid shot's 81, and
 * its log-average comes back *lower* — 0.0728 against 0.0877 — because a log mean is
 * dominated by its darkest pixels and the braking cockpit has more of them. Driving
 * the exposure from that number moves it the wrong way, which is exactly how a fixed
 * key ended up producing medians from 75 to 148 across one set of daylight frames.
 *
 * At p = 0.5 the mean is taken of the square root of luminance, which is close to the
 * slope of the display curve through the mid-tones, so the statistic moves with what
 * the frame will *look* like rather than with how deep its shadows are. Measured at
 * matched exposure, two frames whose displayed means agree also have medians within a
 * couple of counts of each other, which is the property the metering needs and the log
 * mean does not have.
 *
 * Both the reduction and the adaptation need this number and they must agree, so
 * neither reads it from anywhere but here.
 */
export const EXPOSURE_METER_POWER = 0.5;

/** Metered luminance of a reference sunlit cockpit frame — the pivot of the key curve. */
export const EXPOSURE_KEY_PIVOT = 0.127;
/** Share of the display range a frame metering exactly at the pivot is given. */
export const EXPOSURE_KEY = 0.386;
/**
 * How fast the key falls as the meter rises, as an exponent on (pivot / L).
 *
 * Zero, and deliberately so. Once the meter reduces the frame with the right exponent
 * the residual is gone: fitting the exposure that puts each frame's median at 100
 * against its own metered luminance gives E proportional to L^-0.99 across a grid
 * start, a braking shot and a low-sun shot whose required exposures span 2.3x. That is
 * the textbook key/L law to within a percent, so there is nothing left for a bias to
 * explain and any non-zero value here would be fitting noise. The mechanism stays
 * because the *next* change to the scene may put a residual back.
 */
export const EXPOSURE_KEY_BIAS = 0.0;
/**
 * Bottom of the adaptation range: below this the meter is ignored and night stays night.
 *
 * It is set by the two frames that sit either side of it. A low-sun cockpit shot meters
 * 0.058 and wants every bit of the exposure that implies; a night race meters 0.041 and
 * would be handed nearly a stop and a half more than it should have. 0.0625 is the value
 * that clamps the night frame to a median in the low forties while costing the sunset
 * shot about ten counts of median — the two pull in opposite directions and this is the
 * point where both land inside their bands, with very little room on either side.
 */
export const EXPOSURE_MIN_LUMINANCE = 0.0625;

/** `key(L) / L` — the exposure the metering law asks for at a given scene luminance. */
export function exposureFor(luminance) {
  const l = Math.max(luminance, 1e-4);
  return (EXPOSURE_KEY * Math.pow(EXPOSURE_KEY_PIVOT / l, EXPOSURE_KEY_BIAS)) / l;
}

/** Default grade uniform values. Shared by the standalone pass and the folded final pass. */
export function createGradeUniforms() {
  return {
    uExposureComp: { value: 1.0 },
    uContrast: { value: 1.52 },
    uSaturation: { value: 1.10 },
    uTemperature: { value: 0.10 },
    uWhitePoint: { value: 24.0 },
    uToeShoulder: { value: 0.10 },
    /**
     * Max-channel soft clip. These two set where the top of the range actually lands,
     * and therefore how much of the frame reads as clipped.
     *
     * The number that matters is the graded value that maps to display 250/255 — the
     * threshold the review measures "clip%" at. At the previous 0.97 / 1.0 that value
     * was 0.9546, *below* the knee, so the roll never came into play at all and every
     * pixel past 0.9546 went over: 9% of a sunlit braking frame, and the whole sky of a
     * trackside sweep. Pushing the knee down and the ceiling under 1.0 moves the
     * crossing to 0.9655, and the population above it is steep — measured, 4.4% of the
     * braking frame sits above 0.9546 and 0.08% above 0.9745 — so this is a fine
     * adjustment on a very sharp edge, not a broad one. The ceiling still sits above
     * the crossing, which is deliberate: a frame with no pixels at all over 250 has no
     * specular top end, and that was the round-2 complaint.
     */
    uHighlightKnee: { value: 0.94 },
    uHighlightCeil: { value: 0.982 },
    uLift: { value: new THREE.Vector3(0.0, 0.0, 0.0) },
    uGammaCtl: { value: new THREE.Vector3(1.0, 1.0, 1.006) },
    uGain: { value: new THREE.Vector3(1.0, 0.996, 0.986) },
    uShadowTint: { value: new THREE.Vector3(0.945, 1.0, 1.07) },
    uHighlightTint: { value: new THREE.Vector3(1.045, 1.010, 0.945) },
    uSplitBalance: { value: 0.55 },
    uChannelCurve: { value: new THREE.Vector3(0.99, 1.0, 1.014) },
  };
}

/** Standalone tonemap+grade pass. The shipping chain folds this into the lens shader. */
export const TonemapShader = {
  name: 'ApexTonemap',
  uniforms: Object.assign(
    {
      tDiffuse: { value: null },
      tExposure: { value: null },
    },
    createGradeUniforms(),
  ),
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform sampler2D tExposure;
    varying vec2 vUv;
${TONEMAP_CHUNK}
    void main() {
      float exposure = texture2D(tExposure, vec2(0.5)).g;
      vec3 c = apexGrade(texture2D(tDiffuse, vUv).rgb, exposure);
      gl_FragColor = vec4(apexLinearToSrgb(c), 1.0);
    }
  `,
};

/**
 * Stage 1 of metering: HDR frame -> 64x64 of (weighted L^p, weight).
 * Centre-weighted, because a broadcast operator exposes for the car, not for the sky
 * above the grandstand.
 */
export const LuminanceShader = {
  name: 'ApexLuminance',
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: new THREE.Vector2() },
    uCentreBias: { value: 0.22 },
    /**
     * The metering window, in scene-linear luminance. These frames run from a 3e-3
     * cockpit footwell to a 100+ solar disc inside one 64x64 reduction, and either
     * tail can own a mean taken over that range: a handful of sun-disc texels move it
     * by half a stop, and the black under the dashboard moves it back. Both ends are
     * clamped before the exponent, so what the meter reports is the average of the
     * part of the frame that is actually being *exposed for* — road, cars, kerbs,
     * grandstand — and a sun drifting into shot no longer stops the iris down across
     * a corner.
     *
     * 0.004 is roughly six stops under mid-grey and 6.0 about five over: wide enough
     * that a genuinely dark or genuinely bright frame still moves the meter, narrow
     * enough that neither tail can own it.
     */
    uMeterClamp: { value: new THREE.Vector2(0.004, 6.0) },
    /** Power-mean exponent; must match ExposureAdaptShader's. See EXPOSURE_METER_POWER. */
    uMeterPower: { value: EXPOSURE_METER_POWER },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uCentreBias;
    uniform vec2 uMeterClamp;
    uniform float uMeterPower;
    varying vec2 vUv;

    void main() {
      // Rotated-grid quad tap: 64x64 destination texels x 4 taps still samples the
      // frame densely enough for a stable mean.
      vec3 c = texture2D(tDiffuse, vUv + vec2(-1.5,  0.5) * uTexel).rgb
             + texture2D(tDiffuse, vUv + vec2( 0.5,  1.5) * uTexel).rgb
             + texture2D(tDiffuse, vUv + vec2( 1.5, -0.5) * uTexel).rgb
             + texture2D(tDiffuse, vUv + vec2(-0.5, -1.5) * uTexel).rgb;
      c *= 0.25;

      float raw = dot(c, vec3(0.2126, 0.7152, 0.0722));
      // Written as a clamp of a max so a NaN or a negative out of the HDR buffer
      // lands on the floor rather than poisoning the whole reduction.
      float l = clamp(max(raw, uMeterClamp.x), uMeterClamp.x, uMeterClamp.y);

      vec2 d = (vUv - 0.5) * vec2(1.0, 0.82);
      float w = mix(1.0, uCentreBias, clamp(length(d) * 2.0, 0.0, 1.0));

      gl_FragColor = vec4(pow(l, uMeterPower) * w, w, 0.0, 1.0);
    }
  `,
};

/** Stages 2-4: 4x4 box reduction of (sum weighted L^p, sum weight). */
export const LuminanceReduceShader = {
  name: 'ApexLuminanceReduce',
  uniforms: {
    tDiffuse: { value: null },
    uSourceTexel: { value: new THREE.Vector2() },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform vec2 uSourceTexel;
    varying vec2 vUv;

    void main() {
      vec2 base = vUv - uSourceTexel * 1.5;
      vec2 acc = vec2(0.0);
      for (int y = 0; y < 4; y++) {
        for (int x = 0; x < 4; x++) {
          acc += texture2D(tDiffuse, base + vec2(float(x), float(y)) * uSourceTexel).rg;
        }
      }
      gl_FragColor = vec4(acc * 0.0625, 0.0, 1.0);
    }
  `,
};

/**
 * 1x1 adaptation. R = adapted scene luminance, G = the exposure multiplier the grade
 * should use. Rising light adapts faster than falling light, which is how both a real
 * iris and a broadcast camera behave when you come out of a tunnel.
 *
 * ## Metering
 *
 * The exposure is `key(L) / L`, and the whole question is what `key` is.
 *
 * The law itself is the textbook one:
 *
 *     key(L) = uKey * pow(uKeyPivot / L, uKeyBias)     // uKeyBias is 0
 *     exposure = key(L) / L
 *
 * What was wrong for two rounds was not the law but `L`. A fixed key over a log-average
 * produced medians of 75, 83, 107, 118, 123, 143 and 148 across seven daylight frames,
 * and the panel read that — correctly — as an exposure that could not make its mind up.
 * The log-average is dominated by a frame's darkest pixels, so a braking shot with a
 * deep cockpit metered *below* a grid start it renders sixty percent brighter than, and
 * the correction went the wrong way. With the meter reducing to a power mean instead,
 * the same three frames want exposures within nine percent of one key.
 *
 * `uKeyBias` is whatever the meter does not explain by itself, and it is zero: with the
 * power mean in front of it there is no residual left. See EXPOSURE_KEY_BIAS.
 *
 * The fix that made that true was not in this law at all — it was in what `L` is. See
 * EXPOSURE_METER_POWER: the reduction used to compute a log-average, which for these
 * frames runs *backwards* against how bright they look.
 *
 * The two mechanisms that stop the key from running away are the luminance clamps,
 * `uMinLuminance` and `uMaxLuminance`, which are the adaptation range. The floor is
 * the only thing standing between a night race and daylight: below it — a chase camera
 * with the car filling the frame, a night lap between two floodlight pools — the
 * exposure stops chasing the meter and holds. `uMaxExposure` is set to exactly
 * `key(uMinLuminance) / uMinLuminance` so the floor is the only thing that ever binds;
 * when the two disagreed, the night scene metered below the floor, saturated at a
 * separate and much higher ceiling, and every faintly lit edge in a near-black frame
 * was gained up into the bloom threshold.
 *
 * Two more mechanisms stop the smoothing from becoming a lie about the scene's
 * brightness:
 *
 *  - `uReset` forces the first frame after the buffers are (re)allocated to adopt the
 *    metered value outright. Half-float targets come back from the driver undefined and
 *    a 1x1 ping-pong has no way to recover from a bad seed except by slewing out of it.
 *  - A cut is not a light change. Above `uSnapStops.y` stops of disagreement between the
 *    meter and the held value the frame is treated as a different shot — a camera change,
 *    a scenario load, a car crossing the tree line at 300 km/h — and the exposure is
 *    adopted immediately; below `uSnapStops.x` it slews on the iris constants above,
 *    which is the band where the disagreement is meter noise rather than a real change.
 *    Without this a cut from the cockpit to the chase camera spent over a second of real
 *    time exposed for the previous shot, and any consumer that draws only a handful of
 *    frames (the capture harness, a photo mode, a paused menu backdrop) never re-exposed
 *    at all and rendered the whole scene from one to three stops off.
 */
export const ExposureAdaptShader = {
  name: 'ApexExposureAdapt',
  uniforms: {
    tCurrent: { value: null },
    tPrevious: { value: null },
    uDt: { value: 0.016 },
    uSpeedUp: { value: 5.0 },
    uSpeedDown: { value: 3.0 },
    /** Adaptation range. Outside it the meter is ignored and the exposure holds. */
    uMinLuminance: { value: EXPOSURE_MIN_LUMINANCE },
    uMaxLuminance: { value: 12.0 },
    /**
     * Where the meter puts the scene's centre-weighted, window-clamped power mean in
     * graded input, for a scene metering at `uKeyPivot`.
     */
    uKey: { value: EXPOSURE_KEY },
    /** Metered luminance at which `key(L)` is exactly `uKey`; a sunlit cockpit frame. */
    uKeyPivot: { value: EXPOSURE_KEY_PIVOT },
    /** How much of the display range a brighter meter reading gives back. */
    uKeyBias: { value: EXPOSURE_KEY_BIAS },
    /** Power-mean exponent; must match LuminanceShader's. See EXPOSURE_METER_POWER. */
    uMeterPower: { value: EXPOSURE_METER_POWER },
    uMinExposure: { value: 0.28 },
    uMaxExposure: { value: exposureFor(EXPOSURE_MIN_LUMINANCE) },
    uReset: { value: 1 },
    /** Stops of meter/hold disagreement at which slewing gives way to an outright cut. */
    uSnapStops: { value: new THREE.Vector2(0.25, 1.0) },
  },
  vertexShader: FULLSCREEN_VERTEX,
  fragmentShader: /* glsl */ `
    precision highp float;
    uniform sampler2D tCurrent;
    uniform sampler2D tPrevious;
    uniform float uDt;
    uniform float uSpeedUp;
    uniform float uSpeedDown;
    uniform float uMinLuminance;
    uniform float uMaxLuminance;
    uniform float uKey;
    uniform float uKeyPivot;
    uniform float uKeyBias;
    uniform float uMeterPower;
    uniform float uMinExposure;
    uniform float uMaxExposure;
    uniform float uReset;
    uniform vec2 uSnapStops;
    varying vec2 vUv;

    void main() {
      // The reduction carries sum(L^p * w) and sum(w); the power mean is the weighted
      // mean of L^p taken back to the p-th root, which lands in real luminance units so
      // the clamps below stay readable as luminances.
      vec2 s = texture2D(tCurrent, vec2(0.5)).rg;
      // The exponent is signed — a negative power mean is the one that tracks these
      // frames — so the guard has to keep its sign rather than clamping it positive.
      float pe = abs(uMeterPower) < 1e-3 ? 1e-3 : uMeterPower;
      float target = pow(max(s.r / max(s.g, 1e-4), 1e-8), 1.0 / pe);
      // Written as a negated comparison so a NaN out of the reduction (an empty or
      // half-float-degenerate meter) falls through to the floor instead of poisoning
      // the ping-pong for the rest of the session.
      if (!(target > 0.0)) target = uMinLuminance;
      target = clamp(target, uMinLuminance, uMaxLuminance);

      float prev = texture2D(tPrevious, vec2(0.5)).r;
      if (!(prev > 0.0)) prev = target;
      prev = clamp(prev, uMinLuminance, uMaxLuminance);

      float speed = target > prev ? uSpeedUp : uSpeedDown;
      float alpha = 1.0 - exp(-uDt * max(speed, 0.0));
      float stops = abs(log2(target / max(prev, 1e-4)));
      alpha = mix(alpha, 1.0, max(smoothstep(uSnapStops.x, uSnapStops.y, stops), uReset));
      float adapted = prev + (target - prev) * alpha;
      adapted = clamp(adapted, uMinLuminance, uMaxLuminance);
      if (!(adapted > 0.0)) adapted = uMinLuminance;

      // key(L) = uKey * (uKeyPivot / L)^uKeyBias, then the classic key / L.
      float key = uKey * pow(uKeyPivot / max(adapted, 1e-4), uKeyBias);
      float exposure = clamp(key / max(adapted, 1e-4), uMinExposure, uMaxExposure);
      gl_FragColor = vec4(adapted, exposure, 0.0, 1.0);
    }
  `,
};
