/**
 * Veil — geometry and motion are exactly the original. Only the colour is
 * different: it used to be three literal vec3s and a fixed chartreuse, which
 * meant Veil looked identical in every session and no palette could reach it.
 * The three hues now rotate with the seed, so recomposing gives a different
 * trio and each session opens somewhere new — while the drawing is untouched.
 */
export const veil = `
/** A vivid hue at a position on the wheel. turn is in whole turns. */
vec3 spectralHue(float turn) {
  vec3 c = 0.5 + 0.5 * cos(TAU * (turn + vec3(0.0, 0.33, 0.67)));
  // Normalise to the brightest channel so the ribbons stay saturated rather
  // than washing out to pastel.
  return c / max(max(max(c.r, c.g), c.b), 1e-4);
}

float veilTurn() {
  return fract(u_seed * 0.137 + 0.08);
}

vec3 nativeRamp(float t) {
  float h = veilTurn();
  vec3 ash = vec3(0.030, 0.020, 0.026);
  vec3 first = spectralHue(h);
  vec3 second = spectralHue(h + 0.34);
  vec3 third = spectralHue(h + 0.66);
  if (t < 0.34) return mix(ash, first, t * 2.94);
  if (t < 0.67) return mix(first, second, (t - 0.34) * 3.03);
  return mix(second, third, (t - 0.67) * 3.03);
}

vec3 scene(vec2 uvIn, vec2 st) {
  vec2 uv = uvIn * 2.0;
  float t = u_time;
  vec2 p = rot2(-0.12) * uv;

  float warp = fbm(p * (1.38 + u_mid * 0.55) + vec2(t * 0.045, u_seed));
  float warp2 = fbm(p * 2.45 - vec2(t * 0.03, u_seed * 0.7));

  float y = p.y
    + (warp - 0.5) * (0.48 + u_bass * 0.52)
    + sin(p.x * 2.2 + t * 0.35) * (0.06 + u_sub * 0.09);
  y += sin(p.x * 8.0 - t * 2.4) * u_flux * 0.025;

  float membrane = line(y, 0.018 + u_level * 0.034 + u_pulse * 0.018);
  float filament = line(y + 0.19 + (warp2 - 0.5) * 0.20, 0.005 + u_air * 0.018);
  float echo = line(y - 0.20 + sin(p.x * 3.4 - t) * 0.07, 0.004 + u_mid * 0.01);
  float haze = exp(-4.6 * abs(y));
  float sideFade = smoothstep(1.55, 0.05, abs(p.x));

  // Every colour comes through world(), the same as every other preset. It
  // used to hold three literal vec3s and recolour by luminance when a palette
  // was picked, which is why no palette ever really reached Veil and why it
  // looked identical in every session. On Native these resolve to the
  // seed-rotated hues above; on any other world, to that world's three hues.
  vec3 ember = world(0.40);
  vec3 lilac = world(0.66);
  vec3 ice = world(0.92);
  vec3 echoTone = world(0.54);
  vec3 spectral = mix(ember, lilac, smoothstep(-0.8, 0.9, p.x + warp));

  vec3 col = vec3(0.022, 0.021, 0.019);
  col = mix(col, spectral, membrane * sideFade);
  col += filament * ice * (0.45 + u_air * 0.55) * sideFade;
  col += echo * echoTone * (0.18 + u_flux * 0.5) * sideFade;
  col += haze * spectral * (0.06 + u_level * 0.20 + u_pulse * 0.14) * sideFade;

  return col;
}`;
