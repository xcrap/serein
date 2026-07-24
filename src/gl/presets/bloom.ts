/**
 * Bloom — ink dropped into water. One ring per bar, four alive at a time, so
 * the frame holds sixteen beats and each ring is slow enough to watch all the
 * way out.
 *
 * The dimension comes from lighting, not from perspective and not from added
 * detail. A fixed low light gives every ring a bright side and a shadowed
 * side, the pigment inside it is lit by the same light, and the whole thing
 * sits in a slow body of colour. Tilting the plane to fake depth only drags
 * the composition off centre and flattens it.
 *
 * Nothing here is a function of angle alone. Mapping the spectrum around the
 * circumference seems clever and is not: a spectrum is spiky, so every peak
 * paints itself as a ray out of the centre and the frame fills with spokes.
 * The spectrum drives size, weight and colour instead.
 */
export const bloom = `
vec3 scene(vec2 uv, vec2 st) {
  float t = u_flow;

  // Centred, and circular. The rings are the composition.
  vec2 p = uv;
  p *= rot2(t * 0.008);

  float r = length(p);
  float ang = atan(p.y, p.x);
  vec2 outward = p / max(r, 1e-4);

  // A fixed light, low and to the left. This is what gives each ring a lit
  // edge and a dark one, and therefore volume.
  vec2 lightDir = normalize(vec2(-0.55, 0.84));

  vec3 col = vec3(0.0);
  float outermost = 0.0;

  // One ring per bar, four alive at once — sixteen beats of history.
  const int RINGS = 4;
  float cycle = u_beatTime * 0.25;

  for (int i = 0; i < RINGS; i++) {
    float fi = float(i);
    float age = (fract(cycle) + fi) / float(RINGS);

    // Which ring this actually is. The loop index is not an identity: when
    // the cycle wraps, slot i takes over the age that slot i-1 held, so
    // anything keyed to i jumps at the wrap and the whole picture reshapes
    // once a bar. The birth number is constant for a ring's whole life.
    float birth = floor(cycle) - fi;
    float ident = fract(birth * 0.381) * 6.283;
    float grain = hash11(birth * 0.117);

    // Ink spreads and slows.
    float radius = spow(age, 0.78) * (0.46 + u_swell * 0.30);

    // A smooth, seamless deformation. Harmonics of the angle wrap at PI by
    // construction; value noise sampled round a circle facets into a polygon.
    float wobble =
        sin(ang * 2.0 + t * 0.09 + ident + u_seed) * 0.52
      + sin(ang * 3.0 - t * 0.06 + ident * 1.7) * 0.31
      + sin(ang * 5.0 + t * 0.04 + ident * 0.6) * 0.17;
    float edge = radius * (1.0 + wobble * (0.05 + age * 0.30));
    outermost = max(outermost, edge);

    float thickness = 0.018 + age * 0.085 + u_bass * 0.016;
    float d = abs(r - edge);

    // Two layers, neither with a hard shoulder: a body of pigment and the
    // bloom around it.
    float shell = exp(-spow(d / thickness, 1.45));
    float diffuse = exp(-d / (thickness * 2.8));
    float fade = spow(1.0 - age, 1.7);

    // Volume: the side facing the light is brighter, the far side falls into
    // shadow. One smooth cycle around the ring, never a pattern.
    float lambert = 0.34 + 0.66 * (0.5 + 0.5 * dot(outward, lightDir));

    // Each ring sits at its own place in the ramp; four of them make a
    // gradient rather than four copies of one colour.
    vec3 tone = world(0.94 - age * 0.60 + u_centroid * 0.10 - grain * 0.16);

    col += tone * shell * fade * lambert * (0.32 + u_level * 0.52);
    col += tone * diffuse * fade * (0.06 + u_level * 0.14);

    // Pigment left behind the front — the inside is stained, not empty.
    float inside = smoothstep(edge, edge * 0.35, r);
    float stain = fbm(p * (1.9 + age * 1.6) + vec2(ident * 2.4 + u_seed, -t * 0.03));
    col += tone * inside * fade * fade * spow(stain, 1.7) * lambert * (0.18 + u_mid * 0.38);

    // Where the ink is thickest it catches the light along its crest.
    float crest = gauss((r - edge) / (thickness * 0.55));
    col += world(0.98) * crest * fade * spow(lambert, 2.5) * (0.09 + u_snare * 0.32);
  }

  // The drop itself: small and contained.
  col += world(0.99) * exp(-spow(r / (0.028 + u_kick * 0.012), 1.6)) * (0.16 + u_kick * 0.40);
  col += world(0.60) * exp(-r * 6.0) * (0.03 + u_level * 0.22 + u_pulse * 0.10);

  // Beyond the last ring the ink disperses into the water.
  float wisp = fbm(p * (2.4 + u_centroid * 1.6) + vec2(-t * 0.022, t * 0.014));
  float beyond = smoothstep(outermost * 0.85, outermost * 1.7, r) * exp(-r * 1.8);
  col += world(0.34 + u_centroid * 0.22) * spow(clamp(wisp, 0.0, 1.0), 2.6)
    * beyond * (0.16 + u_mid * 0.50);

  // The volume it all sits in, so the frame is water rather than black paper.
  float depth = fbm(p * 1.3 + vec2(t * 0.014, -t * 0.009));
  col += world(0.20 + u_centroid * 0.24) * spow(depth, 2.0)
    * (0.045 + u_swell * 0.16 + u_sub * 0.06);

  return col;
}`;
