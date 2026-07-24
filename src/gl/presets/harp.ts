/**
 * Harp — sixteen strings of light, one per band of the spectrum. A string only
 * exists while its frequency is sounding, and it only *moves* when something
 * strikes it. Held notes glow and hang still; that is what slow music needs.
 */
export const harp = `
vec3 nativeRamp(float t) {
  vec3 a = vec3(0.010, 0.012, 0.020);
  vec3 b = vec3(0.140, 0.080, 0.280);
  vec3 c = vec3(0.520, 0.760, 1.000);
  vec3 d = vec3(1.000, 0.960, 0.900);
  if (t < 0.3333) return mix(a, b, t * 3.0);
  if (t < 0.6666) return mix(b, c, (t - 0.3333) * 3.0);
  return mix(c, d, (t - 0.6666) * 3.0);
}

vec3 scene(vec2 uv, vec2 st) {
  float t = u_flow;
  vec2 p = uv;

  vec3 col = vec3(0.0);
  float height = clamp(p.y + 0.5, 0.0, 1.0);

  // Strings are hung, not painted onto the edges of the frame.
  float hang = smoothstep(0.0, 0.10, height) * smoothstep(1.0, 0.90, height);
  float along = sin(clamp((height - 0.06) / 0.88, 0.0, 1.0) * PI);

  const int STRINGS = 16;
  for (int i = 0; i < STRINGS; i++) {
    float k = (float(i) + 0.5) / float(STRINGS);
    // Sustained energy decides whether the string exists at all; the fast
    // spectrum only decides how brightly it burns.
    float band = spow(specSlow(0.04 + k * 0.86), 1.35);
    float lit = spow(spec(0.04 + k * 0.86), 1.35);

    // A string that is not sounding is simply not lit.
    float presence = smoothstep(0.12, 0.58, band);
    if (presence < 0.004) continue;

    float x0 = (k - 0.5) * 1.58;

    // A string only moves when something strikes it, then it settles. Held
    // notes glow instead of buzzing, which is what slow music needs.
    float excite = clamp(
      u_kick * smoothstep(0.62, 0.0, k)
      + u_snare * smoothstep(0.10, 0.62, k)
      + u_hat * smoothstep(0.55, 1.0, k) * 0.7,
      0.0, 1.0);

    // Low strings are slack and swing slowly; the whole set follows the tempo.
    float shape = sin(height * PI) * 0.86 + sin(height * TAU) * 0.14;
    float rate = (1.1 + k * 4.6) * (0.45 + u_motion * 0.75);
    float swing = sin(t * rate + float(i) * 1.7) * band * (0.008 + excite * 0.045);
    float x = x0 + shape * swing;

    float d = abs(p.x - x);
    float width = 0.0010 + band * 0.0022;
    float core = exp(-spow(d / width, 1.4));
    float glow = exp(-d * (90.0 - band * 45.0));
    float burn = 0.55 + lit * 0.85 + excite * 0.6;

    vec3 tone = world(0.14 + k * 0.42 + lit * 0.36 + u_centroid * 0.08);
    col += tone * core * along * hang * presence * burn * (0.28 + band * 1.5);
    col += tone * glow * along * hang * presence * burn * (0.010 + band * 0.40);

    // The moment it is struck, light runs the length of the string.
    float strike = excite;
    float travel = fract(t * 0.55 + float(i) * 0.13);
    float bead = gauss((height - travel) / 0.055);
    col += world(0.98) * bead * exp(-d * 130.0) * strike * presence * 1.8;
  }

  // The frame the strings are strung in.
  float top = exp(-(1.0 - height) * 22.0);
  float bottom = exp(-height * 22.0);
  col += world(0.46 + u_centroid * 0.28) * (top + bottom)
    * (0.020 + u_level * 0.24 + u_pulse * 0.12);

  // Air in the room, so the strings are not floating in a vacuum.
  col += world(0.16) * fbm3(p * 1.8 + vec2(t * 0.008, -t * 0.005)) * (0.014 + u_air * 0.060);

  return col;
}`;
