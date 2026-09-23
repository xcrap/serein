/**
 * Wick — one flame in a dark room.
 *
 * A candle in still air barely moves, and that is the point of it: the flame
 * holds its shape, and what the music does is move heat up through it. Every
 * disturbance travels upward, carried by u_flow, and leaves through the tip,
 * so the flame never sways back and forth; it only ever rises.
 *
 * How it listens:
 *   · height up the flame is register, through specBands: the root answers
 *     to the low end and the tip to the top, so a bright passage lights the
 *     tongue and a bass line the body.
 *   · the sustained low end gives the flame its weight, and u_swell its
 *     height, both over phrases rather than beats.
 *   · a kick flares the core and the light it throws into the room, in place.
 *     A snare catches the envelope's edge. The hats are embers lifting off
 *     the tip.
 */
export const wick = `
/** The flame's own coordinates: x across in widths, y up in heights. */
vec2 wickFrame(vec2 uv, float t, float width, float tall) {
  const float base = -0.34;
  float y = (uv.y - base) / tall;
  // Heat rising through the flame: travelling waves, so the flame is bent
  // by what passes up through it and never swings. Bent more near the tip,
  // where the air holds it least.
  float rise = t * 0.75;
  float bend = (noise(vec2(y * 2.1 - rise, u_seed)) - 0.5) * 1.25
             + (noise(vec2(y * 4.7 - rise * 1.8, u_seed + 7.3)) - 0.5) * 0.45;
  float lean = clamp(y, 0.0, 1.4);
  return vec2(uv.x / width - bend * lean * lean * 0.9, y);
}

vec3 scene(vec2 uv, vec2 st) {
  float t = u_flow;
  const float base = -0.34;

  // Slow figures only: a band level here swelled the flame on every bass note.
  float weight = specSlow(0.10) * 0.6 + specSlow(0.05) * 0.4;
  float width = 0.096 + weight * 0.020;
  float tall = 0.50 + u_swell * 0.08 + u_section * 0.08;
  vec2 q = wickFrame(uv, t, width, tall);

  // The flame's profile: a rounded bowl at the root, widest a quarter of the
  // way up, drawn out to a point at the tip. Two pieces that meet smoothly.
  float y = q.y;
  float bowl = sqrt(max(1.0 - spow(abs(y - 0.24) / 0.30, 2.0), 0.0));
  float taper = spow(max(1.0 - (y - 0.24) / 0.76, 0.0), 0.85);
  float profile = mix(bowl, taper, smoothstep(0.20, 0.28, y)) * 0.60;
  float across = abs(q.x) / max(profile, 0.015);
  float envelope = gauss(across * 1.1) * smoothstep(-0.06, 0.02, y) * smoothstep(1.02, 0.62, y);

  // Luminous striations carried up through the body.
  float streak = fbm3(vec2(q.x * 1.4, y * 2.6 - t * 1.1) + u_seed);

  // Register by height: root low, tip high.
  float reg = clamp(y, 0.0, 1.0);
  float sustain = specBands(reg);
  float lit = specBandsFast(reg);

  vec3 col = vec3(0.0);
  // The envelope: coloured at the foot, then the body of the flame.
  float tone = clamp(0.34 + y * 0.40 + envelope * 0.20 + u_centroid * 0.08 + u_section * 0.06, 0.0, 1.0);
  col += world(tone) * envelope * (0.60 + streak * 0.50) * (0.50 + u_section * 0.55)
       * (0.42 + sustain * 1.00 + lit * 0.40 + u_level * 0.30);

  // The core: the hottest light, low in the flame, and the kick.
  float core = gauss(across * 1.9) * gauss((y - 0.32) / 0.22) * smoothstep(-0.02, 0.10, y);
  col += world(0.98) * core * (0.36 + u_kick * 1.25 + u_pulse * 0.15 + power() * 0.30);

  // The dark cone round the wick, where the wax has not yet caught.
  float cone = gauss(across * 2.6) * gauss((y - 0.06) / 0.08);
  col *= 1.0 - cone * 0.70;

  // The edge of the envelope, which the snare catches.
  float rim = gauss((across - 1.0) / 0.25) * smoothstep(-0.02, 0.08, y) * smoothstep(1.0, 0.45, y);
  col += world(0.84) * rim * (0.025 + u_snare * 0.50);

  // The wick itself, and the ember at its tip.
  vec2 w = uv - vec2(0.0, base - 0.012);
  float stick = gauss(w.x / 0.0030) * smoothstep(0.040, 0.0, abs(w.y + 0.014));
  col = mix(col, vec3(0.004), stick * 0.85);
  col += world(0.62) * gauss(length(w - vec2(0.0, 0.012)) / 0.006) * (0.30 + u_kick * 0.45);

  // The light the flame throws into the room, which is what makes it warm.
  vec2 centre = uv - vec2(0.0, base + tall * 0.34);
  float d = length(centre * vec2(1.0, 0.75));
  col += world(0.60 + u_centroid * 0.10) * exp(-d * 4.4) * (0.05 + u_level * 0.08 + u_kick * 0.16 + u_section * 0.08);
  col += world(0.32) * exp(-d * 1.7) * (0.018 + u_swell * 0.030 + u_section * 0.030);

  // Embers, carried up out of the tip. Their place is fixed to the flow, so
  // they only rise; the hats decide which of them are glowing.
  float above = uv.y - (base + tall * 0.85);
  vec2 cell = vec2(uv.x * 30.0, uv.y * 30.0 - t * 2.4);
  vec2 id = floor(cell);
  vec2 f = fract(cell) - 0.5;
  vec2 k = hash22(id);
  float drift = (noise(vec2(id.y * 0.37, u_seed)) - 0.5) * 0.9;
  float ember = smoothstep(0.10, 0.0, length(f - (k - 0.5) * 0.5 - vec2(drift, 0.0)))
              * step(0.90, k.y);
  float plume = gauss(uv.x / (0.03 + max(above, 0.0) * 0.45)) * smoothstep(-0.02, 0.06, above)
              * exp(-max(above, 0.0) * 3.2);
  // Few in a quiet passage, many in a full one; the hats set them glowing.
  col += world(0.80) * ember * plume * (0.04 + u_section * 0.22 + u_hat * 1.4 + u_air * 0.3);
  return col;
}`;
