/**
 * Ink — a body of pigment suspended in the dark, lit from inside.
 *
 * How it listens, which is the whole point:
 *   · the fluid keeps its identity. The warp strength is a constant, so the
 *     pattern never re-forms — it only ever drifts. Driving that coefficient
 *     from bass and kick is what made every beat scramble the picture.
 *   · it flows. The music's rate is already integrated into u_flow, so the
 *     whole field is advected by it: loud fast music pushes the ink along,
 *     quiet music lets it hang.
 *   · size follows u_swell, a loudness on a long fuse. The body opens over a
 *     phrase, not over a beat.
 *   · light follows the transients — the core burns on a kick, filaments catch
 *     on air. Brightness is the only thing allowed to move quickly.
 *   · colour comes from the fluid's own warp field, so different parts of the
 *     body carry different pigment, with the spectrum's register sliding the
 *     whole mix along the ramp.
 */
export const ink = `
vec3 nativeRamp(float t) {
  vec3 a = vec3(0.010, 0.012, 0.024);
  vec3 b = vec3(0.080, 0.120, 0.360);
  vec3 c = vec3(0.780, 0.330, 0.540);
  vec3 d = vec3(1.000, 0.900, 0.780);
  if (t < 0.3333) return mix(a, b, t * 3.0);
  if (t < 0.6666) return mix(b, c, (t - 0.3333) * 3.0);
  return mix(c, d, (t - 0.6666) * 3.0);
}

/** Fixed: the pigment must keep its identity from frame to frame. */
const float PUSH = 1.85;

vec3 scene(vec2 uv, vec2 st) {
  float t = u_flow * 0.05;

  // A quiet breath on the beat. Small enough to feel rather than to see.
  float breathe = 1.0 - u_pulse * 0.018 - u_kick * 0.012;
  vec2 p = uv * 1.75 * breathe;
  p *= rot2(sin(u_flow * 0.012) * 0.08);

  float d = length(p);

  // The field drifts; it does not re-form. u_flow already carries the tempo,
  // so this is the music moving the ink rather than deforming it.
  vec2 drift = vec2(t * 0.85, -t * 0.5);

  vec2 q = vec2(
    fbm3(p + drift),
    fbm3(p + drift.yx * 0.7 + 1.3)
  );

  vec2 r = vec2(
    fbm3(p + PUSH * q + vec2(1.7, 9.2) + drift * 1.35),
    fbm3(p + PUSH * q + vec2(8.3, 2.8) - drift * 1.05)
  );

  float density = fbm(p + 2.6 * r);

  // How far the body reaches: sustained loudness only, so it opens and closes
  // across a phrase instead of pumping on every hit.
  float envelope = exp(-d * d * (2.15 - u_swell * 0.95));

  density = clamp((density - 0.30) * 2.7, 0.0, 1.0) * envelope;
  density = spow(density, 1.20);

  // Where the fluid is stretched, it catches the light.
  float shear = clamp(length(r - 0.5) * 2.2, 0.0, 1.0);

  // Filaments torn off the body by the top end.
  float filament = spow(clamp(fbm3(p * 5.5 + r * 3.0 - t * 1.1), 0.0, 1.0), 5.0);

  // Colour has to vary across the body, not with density. Everywhere the ink
  // is actually visible the density is close to 1, so keying the ramp to it
  // parks the whole picture on one swatch. The warp field does vary from place
  // to place, so it is what decides which pigment is showing here — the body
  // ends up with regions of colour, the way two inks mix without blending.
  float swirl = clamp(r.x * 0.90 + r.y * 0.40 - 0.12, 0.0, 1.0);
  float tone = clamp(
      0.04
    + swirl * 0.56
    + shear * 0.18
    + u_centroid * 0.26
    + (1.0 - clamp(d, 0.0, 1.0)) * 0.12,
    0.0, 1.0);

  // Brightness is the one thing that follows transients.
  vec3 col = world(tone) * density * (0.34 + u_level * 1.55 + u_kick * 0.45);
  col += world(0.90) * filament * density * (0.04 + u_air * 0.70 + u_hat * 0.50);

  // The core: a light inside the pigment that burns on the beat.
  float core = exp(-d * (4.4 - u_kick * 1.8 - u_swell * 0.7));
  col += world(0.97) * core * (0.10 + density * 0.55) * (0.08 + u_kick * 1.15 + u_pulse * 0.22);
  col += world(0.55) * exp(-d * 2.0) * density * (0.03 + u_sub * 0.42);

  // A snare cracks a bright seam along one isoline of the fluid.
  float seam = gauss((density - 0.50) / 0.040);
  col += world(0.94) * seam * envelope * (u_snare * 0.55 + u_flux * 0.15);

  return col;
}`;
