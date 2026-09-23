import { PALETTE_GLSL } from "./palettes";

/**
 * Shared GLSL: every preset is a body that implements
 *   vec3 scene(vec2 uv, vec2 st)
 * and is wrapped with these uniforms, helpers and the common post chain.
 *
 *   uv — aspect-corrected, origin at centre, y in [-0.5, 0.5]
 *   st — raw screen coordinates in [0, 1]
 *
 * Three rules for preset authors:
 *   · animate on u_flow, never u_time. u_flow is a clock that runs at the
 *     speed of the music, so a slow record does not get a busy picture.
 *   · take geometry from specSlow(), light from spec(). Shape should follow
 *     sustained instruments; only brightness should follow transients.
 *   · use spow(), never pow(). pow(0.0, k) is NaN on real drivers, and one
 *     NaN turns the whole pixel black.
 *   · nothing that rises and falls may touch geometry. An audio figure — level,
 *     swell, centroid — applied to a position, a direction, a scale or a camera
 *     angle slides the picture one way and slides it back, and that reads as
 *     bouncing rather than flowing however small it is. The same goes for any
 *     sin(u_flow) transform. Move things with monotonic quantities only, and
 *     let the music change weight, colour and light instead.
 *   · u_beatTime is a tempo *estimate*, not a clock. On real music it ranges
 *     over an octave and drops its lock; its rate has been measured swinging
 *     ninefold inside a second. Use it only for things reborn each beat, never
 *     for continuous motion — for that use u_flow, and for hits use the onset
 *     envelopes u_kick, u_snare and u_hat, which are measurements rather than
 *     inferences.
 */

export const VERTEX_SHADER = `#version 300 es
precision highp float;
void main() {
  // Fullscreen triangle, no attributes needed.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const PRELUDE = `#version 300 es
precision highp float;

uniform vec2 u_resolution;
uniform float u_time;       // wall clock — for grain, which must not slow down
uniform float u_flow;       // musical clock — for everything that moves
uniform float u_motion;     // the rate u_flow is currently running at
uniform float u_seed;
uniform float u_alpha;
uniform float u_palette;    // colour world being left
uniform float u_paletteTo;  // colour world being entered
uniform float u_paletteMix; // 0 .. 1 between them
uniform float u_grain;

uniform float u_level;
uniform float u_sub;
uniform float u_bass;
uniform float u_lowMid;
uniform float u_mid;
uniform float u_high;
uniform float u_air;
uniform float u_centroid;
uniform float u_noise;
uniform float u_flux;
uniform float u_kick;
uniform float u_snare;
uniform float u_hat;
uniform float u_pulse;
uniform float u_beat;
uniform float u_beatTime;
uniform float u_dynamics;
uniform float u_swell;    // loudness on a long fuse — for size, not brightness
uniform float u_silence;
uniform float u_section;  // this passage within the song: 0 its quietest, 1 its fullest

uniform sampler2D u_spectrum;   // 256 x 2 — row 0 fast, row 1 slow
uniform sampler2D u_history;    // 256 x 256, one row per frame
uniform float u_historyRow;     // row index of the newest slice

out vec4 outColor;

#define PI 3.141592653589793
#define TAU 6.283185307179586

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  return fract(p * (p + p));
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32 + u_seed);
  return fract(p.x * p.y);
}

vec2 hash22(vec2 p) {
  vec3 a = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973) + u_seed * 0.017);
  a += dot(a, a.yzx + 33.33);
  return fract((a.xx + a.yz) * a.zy);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0)), f.x), f.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.82, -0.57, 0.57, 0.82);
  for (int i = 0; i < 5; i++) {
    value += amp * noise(p);
    p = rot * p * 2.03 + 1.7;
    amp *= 0.5;
  }
  return value;
}

float fbm3(vec2 p) {
  float value = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.82, -0.57, 0.57, 0.82);
  for (int i = 0; i < 3; i++) {
    value += amp * noise(p);
    p = rot * p * 2.11 + 1.3;
    amp *= 0.5;
  }
  return value;
}

mat2 rot2(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat2(c, -s, s, c);
}

/**
 * pow() is undefined at x == 0 in the GLSL spec, and real drivers return NaN
 * there. A single NaN poisons everything it is added to, so the pixel goes
 * black. Audio values reach exactly zero in silence — so they all come here.
 */
float spow(float x, float k) {
  return pow(max(x, 1e-6), k);
}

/** exp(-x*x) — a soft bump. Squaring by hand keeps pow() out of it. */
float gauss(float x) {
  return exp(-x * x);
}

/**
 * The Native colour world, shared by every preset so that switching preset
 * does not also switch the palette out from under you. Three hues a third of
 * the wheel apart, rotated by the seed — so recomposing moves all of them
 * together and each session opens somewhere new.
 */
vec3 spectralHue(float turn) {
  vec3 c = 0.5 + 0.5 * cos(TAU * (turn + vec3(0.0, 0.33, 0.67)));
  // Normalise to the brightest channel so the hues stay saturated rather than
  // washing out to pastel.
  return c / max(max(max(c.r, c.g), c.b), 1e-4);
}

vec3 nativeRamp(float t) {
  float turn = fract(u_seed * 0.137 + 0.08);
  vec3 shadow = vec3(0.022, 0.018, 0.026);
  vec3 first = spectralHue(turn);
  vec3 second = spectralHue(turn + 0.34);
  vec3 third = spectralHue(turn + 0.66);
  if (t < 0.3333) return mix(shadow, first, t * 3.0);
  if (t < 0.6666) return mix(first, second, (t - 0.3333) * 3.0);
  return mix(second, third, (t - 0.6666) * 3.0);
}

float line(float d, float width) {
  return 1.0 - smoothstep(width, width + 0.012, abs(d));
}

/** Magnitude now, at a normalised log-frequency position. Use this for light. */
float spec(float x) {
  return texture(u_spectrum, vec2(clamp(x, 0.0, 1.0), 0.25)).r;
}

/** The same, slowly followed — sustained instruments. Use this for shape. */
float specSlow(float x) {
  return texture(u_spectrum, vec2(clamp(x, 0.0, 1.0), 0.75)).r;
}

/** Magnitude at a musical frequency in Hz (the texture spans 28 Hz to 16 kHz). */
float specHz(float hz) {
  return spec(log(clamp(hz, 28.0, 16000.0) / 28.0) / log(16000.0 / 28.0));
}

/**
 * specSlow, spread across neighbouring bins.
 *
 * Use this instead of spec()/specSlow() whenever frequency is mapped to a
 * *place* in the picture — height, distance, angle. Neighbouring pixels then
 * read neighbouring bins, and a raw bin jumps frame to frame, so every peak in
 * the spectrum lands as a hard ridge four or five pixels wide. It looks exactly
 * like a rendering glitch and it is very hard to attribute once it is there.
 */
float specSpread(float x) {
  return (specSlow(x - 0.070) + specSlow(x - 0.035) + specSlow(x)
        + specSlow(x + 0.035) + specSlow(x + 0.070)) * 0.2;
}

/** The fast spectrum over a wide window: one register's light, not one bin's. */
float specWide(float x) {
  return (spec(x - 0.06) + spec(x - 0.03) + spec(x)
        + spec(x + 0.03) + spec(x + 0.06)) * 0.2;
}

/**
 * The spectrum as a smooth function of place — for when a whole register is
 * laid across only a few hundred pixels, a height or a distance from an edge.
 *
 * specSpread still follows the bins. Spread the register that tightly and
 * every bin is a pixel or two, so the spectrum's bin-to-bin roughness prints
 * as fine parallel lines, rings round a disc, scanlines up a flame. Averaging
 * five rough samples does not remove that. This reads six fixed bands, which
 * every pixel shares, and blends between them, so the picture carries the
 * shape of the spectrum and none of its grain.
 */
float specBands(float x) {
  float f = clamp(x, 0.0, 1.0) * 5.0;
  float i = min(floor(f), 4.0);
  float w = smoothstep(0.0, 1.0, f - i);
  return mix(specSpread(0.06 + i * 0.176), specSpread(0.06 + (i + 1.0) * 0.176), w);
}

/** The same six bands from the fast spectrum, for light that follows hits. */
float specBandsFast(float x) {
  float f = clamp(x, 0.0, 1.0) * 5.0;
  float i = min(floor(f), 4.0);
  float w = smoothstep(0.0, 1.0, f - i);
  return mix(specWide(0.06 + i * 0.176), specWide(0.06 + (i + 1.0) * 0.176), w);
}

/**
 * How hard the music is leaning in, 0 .. 1, and near zero most of the time.
 *
 * u_dynamics is short-term loudness against the piece's own slow average, so it
 * settles back once a loud passage becomes the new normal — that is what makes
 * this "the moments with power in them" rather than "loud music looks
 * different". Note the edges: measured on real material u_dynamics only spans
 * about 0.44 to 0.60. It is a ratio, not a 0..1 meter, and reading it as one
 * leaves anything built on it switched off permanently.
 *
 * Use it for weight — thickness, density, burn — not for position.
 */
float power() {
  return clamp(smoothstep(0.505, 0.605, u_dynamics) * 0.50
             + smoothstep(0.480, 0.920, u_level) * 0.50, 0.0, 1.0);
}

/** Past spectra. age 0 is the current frame, 1 is 256 frames ago. */
float history(float x, float age) {
  float row = mod(u_historyRow - age * 255.0, 256.0);
  return texture(u_history, vec2(clamp(x, 0.0, 1.0), (row + 0.5) / 256.0)).r;
}
${PALETTE_GLSL}`;

export const EPILOGUE = `
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 st = gl_FragCoord.xy / u_resolution;
  vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution) / u_resolution.y;

  vec3 col = scene(uv, st);

  // Vignette — a soft closing of the frame, never a hard edge.
  vec2 v = st - 0.5;
  float vignette = 1.0 - dot(v, v) * (0.62 - u_level * 0.12);
  col *= clamp(vignette, 0.0, 1.0);

  col = mix(col, aces(col), 0.88);

  // Film grain, denser in the shadows where banding would otherwise show.
  float g = hash21(gl_FragCoord.xy + fract(u_time) * 419.0) - 0.5;
  float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col += g * u_grain * mix(0.055, 0.012, smoothstep(0.0, 0.35, luma));

  // Ordered dither so deep gradients never band on 8-bit displays.
  float dither = (hash21(gl_FragCoord.xy * 1.37 + 11.0) - 0.5) / 255.0;
  col += dither;

  outColor = vec4(max(col, vec3(0.0)), u_alpha);
}`;

export const UNIFORM_NAMES = [
  "u_resolution",
  "u_time",
  "u_flow",
  "u_motion",
  "u_seed",
  "u_alpha",
  "u_palette",
  "u_paletteTo",
  "u_paletteMix",
  "u_grain",
  "u_level",
  "u_sub",
  "u_bass",
  "u_lowMid",
  "u_mid",
  "u_high",
  "u_air",
  "u_centroid",
  "u_noise",
  "u_flux",
  "u_kick",
  "u_snare",
  "u_hat",
  "u_pulse",
  "u_beat",
  "u_beatTime",
  "u_dynamics",
  "u_swell",
  "u_silence",
  "u_section",
  "u_spectrum",
  "u_history",
  "u_historyRow",
] as const;
