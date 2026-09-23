/**
 * Boreal — an aurora over a still lake. A curtain of light comes in overhead
 * and folds away toward the horizon, a second one burns farther off, and the
 * water holds all of it upside down beneath a far shore of spruce.
 *
 * The curtains are real sheets. Each hangs along a folded curve that runs
 * away from the viewer, and every pixel's ray is marched through them, so
 * perspective does the drawing: overhead the rays fan out and stand tall,
 * in the distance they crowd together and sink toward the shore; where a
 * sheet turns edge-on the ray stays in it longer and the fold burns as a
 * seam. A band painted across the sky has none of that, and it is flat.
 *
 * How it listens:
 *   · altitude is bands, the way altitude is colour in a real aurora: the
 *     foot of a curtain answers to the low end, its crown to the top.
 *   · the folds travel along the curtains, the rays race along them, and
 *     surges of light run their length, all on u_flow and each one way.
 *     Nothing swings.
 *   · a kick is a breakup: the lower fringe flares, in place. A snare draws
 *     the rays out sharper. The hats are the stars. The moments with power in
 *     them burn brighter.
 *   · how high the curtains stand follows u_swell, across a phrase.
 */
export const boreal = `
/**
 * The far shore at a bearing: a low line of hills and stands of spruce on
 * it, clustered, every tree different. Coverage for a direction's elevation,
 * so the lake reflects it simply by looking at the mirrored direction.
 */
float borealShore(float bearing, float elevation, float px) {
  // Nothing on the shore stands this high: most of the sky skips all of it.
  if (elevation > 0.065) return 0.0;
  float hills = 0.006 + 0.016 * fbm3(vec2(bearing * 1.8 + u_seed, 0.5));
  float cover = smoothstep(hills + px, hills - px, elevation);
  const float SPACING = 0.016;
  float cell = floor(bearing / SPACING);
  float up = elevation - hills;
  for (int j = -2; j <= 2; j++) {
    float id = cell + float(j);
    float stand = noise(vec2(id * SPACING * 6.0, u_seed * 5.0));
    float kind = hash11(id * 1.37 + 5.0);
    if (kind > stand * 1.3) continue;
    float centre = (id + hash11(id * 2.11 + 1.0)) * SPACING;
    float height = (0.012 + 0.040 * hash11(id * 3.7 + 2.0)) * (0.5 + stand * 0.9);
    float tier = 0.45 + 0.55 * fract(up * (150.0 + kind * 60.0) + kind * 3.0);
    float reach = max(height - up, 0.0) * (0.15 + kind * 0.06) * tier + 0.0006;
    cover = max(cover, smoothstep(-px, px, reach - abs(bearing - centre)) * step(up, height));
  }
  return cover;
}

/** How far a curtain's centreline swings sideways, a distance u along it. */
float borealFold(float u, float t, float seed) {
  return 1.25 * sin(0.40 * u - t * 0.17 + seed * 3.0)
       + 0.50 * sin(1.10 * u + t * 0.12 + seed * 1.7);
}

/**
 * Everything above the horizon, along a direction: night, stars, the
 * curtains and the shore. The lake calls this with the mirrored direction.
 */
vec3 borealSky(vec3 d, float t, float px, vec3 bands) {
  float level = max(length(d.xz), 1e-4);
  float bearing = d.x / d.z;
  float elevation = d.y / level;

  vec3 col = world(0.14 + u_centroid * 0.06) * (0.012 + 0.070 * exp(-elevation * 5.0))
           * (0.8 + u_level * 0.4 + u_swell * 0.3);

  // The Milky Way, faint, crossing the other way. The sky under a curtain
  // has to be full of things, or the dark there reads as a mountainside.
  float milky = gauss((elevation * 0.95 + bearing * 0.50 - 0.42) / 0.20);
  if (milky > 0.02) {
    float clouds = fbm3(vec2(bearing, elevation) * 5.0 + u_seed * 1.3);
    col += mix(vec3(0.55, 0.60, 0.72), world(0.30), 0.35) * milky * spow(clouds, 2.2) * 0.060;
  }

  // Stars, fixed to the sky: a few bright, many faint, crowding into the
  // Milky Way. The hats set them glinting.
  for (int layer = 0; layer < 2; layer++) {
    float scale = layer == 0 ? 90.0 : 210.0;
    vec2 cell = vec2(bearing, elevation) * scale;
    vec2 id = floor(cell);
    vec2 k = hash22(id + 17.0 + float(layer) * 51.0);
    float chance = layer == 0 ? 0.935 : 0.90 - milky * 0.12;
    float star = smoothstep(0.17, 0.0, length(fract(cell) - 0.5 - (k - 0.5) * 0.6)) * step(chance, k.x);
    float glint = 0.5 + 0.5 * sin(u_time * (1.3 + k.y * 2.1) + k.y * 40.0);
    // Clearest in the quiet passages, when the aurora is low.
    float bright = (layer == 0 ? 0.20 + k.y * 0.45 : 0.07 + k.y * 0.10) * (1.25 - u_section * 0.55);
    col += vec3(0.85, 0.88, 1.0) * star * bright * (0.55 + glint * 0.45 + u_hat * 0.9);
  }

  // The curtains. March outward in steps that grow with distance, and light
  // each place a ray actually passes through a sheet, found between steps:
  // a sheet stays thin and its rays stay sharp, however obliquely it is
  // seen. A ray that crosses at a slant spends longer inside, so the folds,
  // where a sheet turns edge-on, burn as seams.
  const float FOOT = 1.35;
  float tall = 1.4 + u_swell * 0.6 + u_section * 0.9;
  vec3 light = vec3(0.0);
  float glow = 0.0;
  float before0 = 0.0;
  float before1 = 0.0;
  float zBefore = 1.0;
  const int STEPS = 40;
  for (int i = 0; i <= STEPS; i++) {
    float z = 1.0 * exp(float(i) * 0.096);
    vec3 p = d * (z / d.z);
    if (i > 0 && p.y - FOOT * 1.9 > tall * 3.2) break;

    for (int c = 0; c < 2; c++) {
      float seed = float(c) * 4.7;
      // Both come in overhead from the left and run away to the right; the
      // second behind the first and higher, the way a display layers.
      vec2 origin = c == 0 ? vec2(-3.2, 0.6) : vec2(-5.8, 2.9);
      vec2 along = normalize(vec2(0.85, 1.0));
      float foot = c == 0 ? FOOT : FOOT * 1.9;
      vec2 across = vec2(-along.y, along.x);
      float off = dot(p.xz - origin, across) - borealFold(dot(p.xz - origin, along), t, seed);
      float before = c == 0 ? before0 : before1;
      if (c == 0) before0 = off; else before1 = off;
      if (i == 0) continue;
      // The second curtain only kindles in the full passages.
      float haze = exp(-z * 0.045) * (c == 0 ? 1.0 : 0.80 * smoothstep(0.25, 0.75, u_section));
      float h = p.y - foot;

      // A faint halo wherever a sheet runs close, which keeps the seams lit
      // even where a fold turns within a single step.
      float near = gauss(off / ((z - zBefore) * 0.9));
      if (near > 0.004) glow += near * (h > 0.0 ? exp(-h / tall) : exp(h * 6.0)) * haze;

      if (before * off > 0.0) continue;
      // The crossing itself.
      float f = before / (before - off);
      float zc = mix(zBefore, z, f);
      vec3 pc = d * (zc / d.z);
      float hc = pc.y - foot;
      float u = dot(pc.xz - origin, along);
      float slant = (z - zBefore) / max(abs(off - before), 1e-3);
      // Brighter the more obliquely it is crossed, up to a point, then less:
      // at the very edge of a fold the light fades to nothing instead of
      // ending in a hard vertical line.
      float weight = slant / (1.0 + 0.12 * slant * slant);
      float enter = smoothstep(0.0, 5.0, u);

      // Rays race along the sheet; fine ones faster, and only where they
      // are wider than a pixel.
      float footprint = zc * px;
      float fine = smoothstep(0.9, 0.3, footprint * 16.0);
      float rays = noise(vec2(u * 5.5 - t * 0.9, hc * 0.35 + seed)) * (1.0 - 0.45 * fine)
                 + noise(vec2(u * 16.0 - t * 1.5, hc * 0.7 + seed * 2.0)) * 0.45 * fine;
      float stand = tall * (0.30 + 1.30 * rays * rays);
      // Sharp at the foot, with a little light scattered down beneath it.
      float profile = hc > 0.0 ? exp(-hc / stand) : exp(hc * 14.0) + 0.05 * exp(hc * 1.2);

      // Surges of light running the length of the curtain.
      float surge = 0.25 + 1.35 * spow(noise(vec2(u * 0.28 - t * 0.35, seed * 3.0)), 1.4);

      float up = clamp(hc / (tall * 1.4), 0.0, 1.0);
      float sustain = up < 0.5 ? mix(bands.x, bands.y, up * 2.0) : mix(bands.y, bands.z, up * 2.0 - 1.0);
      float streaks = 0.40 + spow(rays, 2.2 + u_snare * 2.0) * (2.0 + u_snare * 1.5);

      // The lower fringe: a thin band in its own colour, and the breakup.
      float fringe = exp(-abs(hc) / 0.08) * (0.34 + u_kick * 1.60 + power() * 0.25);
      float tone = mix(0.44, 0.84, up) + u_centroid * 0.06;

      light += (world(tone) * profile * streaks * (0.35 + sustain * 0.90 + u_level * 0.20)
              + world(0.97) * fringe * streaks)
             * weight * surge * enter * haze * (1.0 + power() * 0.4);
    }
    zBefore = z;
  }
  col += (light * 0.56 + world(0.58) * glow * 0.028) * (0.45 + u_section * 0.60);
  // The aurora's own light, scattered low in the sky, which the far shore
  // stands against.
  col += world(0.52) * exp(-max(elevation, 0.0) * 22.0) * (0.035 + u_level * 0.04 + u_swell * 0.03);

  // The far shore, black against it all.
  float land = borealShore(bearing, elevation, px);
  return mix(col, vec3(0.002), land);
}

vec3 scene(vec2 uv, vec2 st) {
  float t = u_flow;
  float px = 1.15 / u_resolution.y;
  // Standing at the water's edge, looking north and a little up.
  vec3 rd = normalize(vec3(uv.x * 1.15, uv.y * 1.15 + 0.21, 1.0));
  // The bands, read once: foot, body and crown.
  vec3 bands = vec3(specSpread(0.10), specSpread(0.45), specSpread(0.80));

  if (rd.y >= 0.0) return borealSky(rd, t, px, bands);

  // The lake: the sky again, mirrored, broken by slow ripples that grow as
  // the water comes nearer and settle to glass toward the far shore.
  float below = -rd.y;
  float reach = 0.08 / below;
  vec2 w = rd.xz * reach;
  float ripple = noise(vec2(w.x * 2.2 + t * 0.10, w.y * 0.8 - t * 0.28))
               + noise(vec2(w.x * 5.3 - t * 0.07, w.y * 1.9 - t * 0.41)) * 0.5 - 0.75;
  float calm = smoothstep(0.0, 0.25, below);
  vec3 mirrored = normalize(vec3(rd.x + ripple * 0.030 * calm, below + ripple * 0.022 * calm, rd.z));
  float fresnel = 0.45 + 0.40 * exp(-below * 6.0);
  vec3 col = borealSky(mirrored, t, px, bands) * fresnel;
  return col + world(0.10) * 0.006;
}`;
