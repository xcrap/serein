/**
 * Coil — one long luminous body moving through the dark.
 *
 * One strand, never two. Nothing travels along it: a light or a bulge running
 * down the body reads as a fault, not as life. What the music does is give the
 * body weight and colour — sustained energy at a frequency thickens the part
 * of the body carrying it, transients set that part burning — while the shape
 * itself belongs to the composition, and the seed chooses the composition.
 */
export const coil = `
vec3 nativeRamp(float t) {
  vec3 a = vec3(0.016, 0.012, 0.030);
  vec3 b = vec3(0.280, 0.080, 0.420);
  vec3 c = vec3(0.980, 0.340, 0.320);
  vec3 d = vec3(1.000, 0.900, 0.720);
  if (t < 0.3333) return mix(a, b, t * 3.0);
  if (t < 0.6666) return mix(b, c, (t - 0.3333) * 3.0);
  return mix(c, d, (t - 0.6666) * 3.0);
}

/** Distance to segment ab — drawing segments, not points, keeps the body whole. */
float segment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

/**
 * A point on the body, s from 0 at the head to 1 at the tail.
 *
 * The seed picks the curve — its frequencies, its phases, how far it reaches —
 * so recomposing genuinely draws a different creature rather than the same one
 * shifted along.
 */
vec2 bodyAt(float s, float t, float lean) {
  float k1 = 0.48 + fract(u_seed * 0.317) * 0.55;
  float k2 = 0.80 + fract(u_seed * 0.713) * 0.70;
  float k3 = 1.90 + fract(u_seed * 0.191) * 1.60;
  float o1 = u_seed * 1.7;
  float o2 = u_seed * 2.3;

  float span = 3.4 + fract(u_seed * 0.107) * 2.2;
  float phase = s * span - t * 0.15;

  vec2 c = vec2(
    sin(phase * k1 + o1) * (1.02 + fract(u_seed * 0.53) * 0.28),
    sin(phase * k2 + o2) * (0.52 + fract(u_seed * 0.29) * 0.22)
  );
  c += vec2(sin(phase * k3 + o1), cos(phase * (k3 + 0.8) + o2)) * (0.12 + lean * 0.10);

  // The whole creature drifts through the frame rather than treading water.
  c += vec2(sin(t * 0.031 + o1) * 0.30, cos(t * 0.024 + o2) * 0.16);
  return c;
}

vec3 scene(vec2 uv, vec2 st) {
  float t = u_flow;
  vec2 p = uv * 2.35;
  p *= rot2(sin(t * 0.022) * 0.14);

  vec3 col = vec3(0.0);
  float nearest = 10.0;

  // One number, slowly followed, for how much the body leans. Taking this
  // from the fast spectrum is what makes a creature twitch.
  float lean = specSlow(0.10) * 0.5 + u_swell * 0.5;

  const int SEGMENTS = 46;
  vec2 previous = bodyAt(0.0, t, lean);

  for (int i = 1; i <= SEGMENTS; i++) {
    float s = float(i) / float(SEGMENTS);

    // Sustained energy gives this stretch of body its weight; the transient
    // at the same frequency sets it burning.
    float band = spow(specSlow(0.04 + s * 0.84), 1.2);
    float lit = spow(spec(0.04 + s * 0.84), 1.2);

    vec2 here = bodyAt(s, t, lean);

    // Fat in the middle, tapering at both ends, with a fixed unevenness along
    // its length. No time in this: anything that moves along the body reads
    // as something crawling on it.
    float taper = spow(sin(s * PI), 0.5);
    float knots = 0.86 + 0.14 * sin(s * 7.0 + u_seed * 3.0);
    float thickness = (0.024 + band * 0.080 + u_kick * 0.026 + u_sub * 0.020) * taper * knots + 0.002;

    float d = segment(p, previous, here);
    nearest = min(nearest, d);
    previous = here;

    float glow = thickness / (d + thickness * 0.70);
    float core = spow(glow, 3.6);
    float halo = spow(glow, 1.8);

    // Head warm, tail cool, with the register of the music shifting the whole
    // gradient along the ramp.
    vec3 tone = world(0.20 + s * 0.44 + lit * 0.34 + u_centroid * 0.14);
    col += tone * core * taper * (0.048 + lit * 0.17);
    col += tone * halo * taper * (0.024 + lit * 0.075);
  }

  // The wake: water the body has just moved through still holds its light.
  col += world(0.30) * exp(-nearest * 3.2) * (0.035 + u_level * 0.26 + u_pulse * 0.12);
  col += world(0.55) * exp(-nearest * 8.0) * (0.010 + u_snare * 0.22);

  // Suspended particles, lit only where the body comes near them.
  vec2 grid = p * 22.0;
  vec2 id = floor(grid);
  vec2 f = fract(grid) - 0.5;
  vec2 h = hash22(id);
  float mote = smoothstep(0.09, 0.0, length(f - (h - 0.5) * 0.7)) * spow(h.x, 3.0);
  col += world(0.72) * mote * exp(-nearest * 2.0) * (0.30 + u_hat * 1.1);

  return col;
}`;
