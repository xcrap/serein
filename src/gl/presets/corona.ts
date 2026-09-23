/**
 * Corona — an eclipse. A black disc, and the light of what it hides streaming
 * out past its edge on the wind.
 *
 * The one form is the disc, and it is dark: every bright thing in the frame is
 * around it, never on it. That inversion is what separates this from Ink and
 * Bloom, which both burn at the centre.
 *
 * How it listens:
 *   · distance from the limb is register. The inner corona answers to the low
 *     end and the far streamers to the top, through specBands, so a bass line
 *     fills the light close to the disc and a bright passage reaches out.
 *   · the streamers are carried outward along log-radius by u_flow, so they
 *     leave the limb and thin into the dark at the speed of the music, and
 *     they never come back. Nothing oscillates.
 *   · a kick is the chromosphere: the thin ring at the limb and the inner
 *     corona flare in place. A snare lights the prominences standing on the
 *     limb. The hats are the fine plumes.
 *   · how far the corona reaches follows u_swell, so it opens over a phrase.
 *
 * Nothing is a function of angle alone. The streamers are noise that wraps
 * around the disc, sampled against log-radius, so there is no seam where the
 * angle turns over and no spectral peak is ever painted as a spoke.
 */
export const corona = `
/** Value noise that wraps every period cells along x: seamless around the disc. */
float coronaNoise(vec2 p, float period) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float x0 = mod(i.x, period);
  float x1 = mod(i.x + 1.0, period);
  return mix(mix(hash21(vec2(x0, i.y)), hash21(vec2(x1, i.y)), f.x),
             mix(hash21(vec2(x0, i.y + 1.0)), hash21(vec2(x1, i.y + 1.0)), f.x), f.y);
}

/**
 * The streamers, in turns around the disc and log-distance from the limb.
 * Many cells around and few along the radius, so each feature is long and
 * narrow; the radial coordinate runs against the clock, so they travel out.
 * A little of the radius is added to the angle, which bends them the way a
 * helmet streamer bends.
 */
float coronaStreams(float turn, float rho, float t) {
  float u = turn * 13.0 + rho * 0.22;
  float v = rho * 1.25 - t * 0.50;
  return coronaNoise(vec2(u, v), 13.0) * 0.50
       + coronaNoise(vec2(u * 3.0 + 3.1, v * 1.3 - t * 0.19), 39.0) * 0.30
       + coronaNoise(vec2(u * 7.0 + 7.7, v * 1.6 - t * 0.33), 91.0) * 0.20;
}

vec3 scene(vec2 uv, vec2 st) {
  float t = u_flow;
  float px = 1.0 / u_resolution.y;
  const float R = 0.165;

  float r = length(uv);
  float turn = atan(uv.y, uv.x) / TAU + 0.5 + t * 0.0025;
  float h = max(r - R, 0.0);
  float rho = log(max(r, R) / R);

  // Register by distance: low at the limb, high toward the edge of the frame.
  float reg = clamp(rho / 1.25, 0.0, 1.0);
  float sustain = specBands(reg);
  float lit = specBandsFast(reg);

  // A few broad helmets carry most of the light, like petals; they change
  // only slowly, in place. The streamers inside them are what moves.
  float helmets = coronaNoise(vec2(turn * 5.0, t * 0.018 + u_seed * 3.7), 5.0);
  float petals = 0.10 + 2.3 * helmets * helmets * helmets;
  float streams = coronaStreams(turn, rho, t);
  float structure = spow(smoothstep(0.30, 0.78, streams), 1.4) * petals;

  float reach = 0.17 + u_swell * 0.10 + u_section * 0.10;
  float body = exp(-h / reach);
  float tail = spow(R / max(r, R), 1.5);
  float tone = clamp(0.30 + 0.62 * exp(-rho * 1.4) + streams * 0.08 + u_centroid * 0.10 + u_section * 0.08, 0.0, 1.0);

  vec3 col = vec3(0.0);
  // A quiet passage leaves a thin corona; a full one throws it wide.
  col += world(tone) * structure * body * (0.30 + sustain * 0.70 + lit * 0.35 + u_level * 0.20) * (0.40 + u_section * 0.70);
  col += world(tone * 0.85) * structure * tail * (0.05 + sustain * 0.25 + u_swell * 0.06);

  // The inner corona, close and bright: the low end, and the kick. It
  // follows the streamers leaving it, so the limb is never an even ring.
  float inner = exp(-h / 0.026);
  col += world(0.90) * inner * (0.25 + 0.75 * structure)
       * (0.24 + specBands(0.0) * 0.45 + u_kick * 1.20 + u_pulse * 0.15);

  // The chromosphere: a thread of colour at the limb that flares on the hit.
  col += world(0.64) * gauss(h / (0.0034 + px)) * (0.18 + u_kick * 1.60 + power() * 0.35);

  // Fine plumes, for the hats. Faded where they would fall finer than a
  // pixel, so they never tear.
  float fine = coronaNoise(vec2(turn * 110.0, rho * 2.2 - t * 0.8), 110.0);
  float resolvable = smoothstep(0.8, 3.0, TAU * r / 110.0 / px);
  col += world(0.80) * spow(fine, 6.0) * resolvable * body * petals
       * (0.04 + u_hat * 0.55 + u_air * 0.20);

  // Prominences: tongues of plasma standing on the limb, lit by the snare.
  float arc = TAU * R;
  for (int i = 0; i < 3; i++) {
    float k = float(i);
    float at = fract(u_seed * (0.237 + k * 0.119) + k * 0.331);
    float along = (fract(turn - at + 0.5) - 0.5) * arc;
    float width = 0.010 + hash11(k + u_seed) * 0.012;
    float tall = 0.016 + hash11(k * 3.1 + u_seed) * 0.020;
    float lick = coronaNoise(vec2(along * 70.0, h * 55.0 - t * 1.1), 1000.0);
    float tongue = gauss(along / width) * exp(-h / tall) * (0.45 + 0.9 * lick);
    col += world(0.70) * tongue * (0.10 + u_snare * 1.30 + u_mid * 0.20);
  }

  // The disc. Not quite a hole: a little earthshine on a body.
  float disc = smoothstep(R + px, R - px, r);
  vec3 moon = world(0.16) * (0.006 + 0.012 * fbm3(uv * 9.0 + u_seed));
  col = mix(col, moon, disc);

  // The sky it sits in.
  col += world(0.12 + u_centroid * 0.10) * exp(-r * 2.4) * (0.014 + u_swell * 0.022);
  return col;
}`;
