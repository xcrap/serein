/**
 * Fathom — under the surface, looking out. The only preset here with a real
 * camera in it: a ray per pixel, a floor to hit, and a body of water between
 * them that light has to cross.
 *
 * The picture is one field used twice. Crossing swells overhead focus the sun
 * into a net of bright curves; that net is painted on the seabed where the
 * rays land, and it is also sampled along every ray on the way there, so the
 * shafts hanging in the water carry the same pattern as the floor beneath
 * them. That is what makes the space feel occupied rather than empty.
 *
 * The hard part is not the light, it is keeping the music from arriving all at
 * once. Three separations do that:
 *
 *   · three swells, three bands, three speeds. The net is the sum of three
 *     wave trains, and each takes its wavelength from a different part of the
 *     spectrum and moves at its own rate. The bass runs a long slow swell
 *     across the frame while the top end ruffles a fine one over it, so the
 *     pattern never reorganises as a single thing.
 *   · distance is frequency. How far away a patch of seabed is decides which
 *     band lights it — the floor at your feet answers to the low end and the
 *     haze at the limit of sight to the top. A bass note walks toward you; a
 *     cymbal lights the distance. The same goes for the shafts, so the near
 *     water and the far water flicker to different music.
 *   · the three drum voices do three different jobs. A kick is a swell passing
 *     overhead — a bar of brightening travelling away from you along the
 *     floor. A snare is a gust: the surface chops up for a moment. The hats
 *     are only ever the suspended matter catching light.
 *
 * Over the top of all of it, one slow thing: how much sun is reaching down
 * here at all follows u_swell, so light floods and withdraws across a phrase.
 * Almost nothing moves on its own — the swells crawl and the warp is small,
 * because a caustic net that reorganises every few frames reads as
 * interference on a screen rather than as the sea.
 */
export const fathom = `
/**
 * The net. Three crossing swells summed; the water focuses light where the sum
 * passes through zero, which is a set of smooth curves, not a grid. Each
 * carries its own wavelength and its own speed, so they beat against each
 * other instead of pumping together.
 *
 * Deliberately only sines: this is evaluated twenty times per pixel along
 * every ray, and an fbm in here would cost more than the whole rest of the
 * frame. The warp is two more sines for the same reason — and small, and slow.
 *
 * The bright core has to live inside the soft shoulder rather than be laid on
 * top of it, and its brightness has to run up and down along the filament, or
 * every filament comes out the same width and brightness end to end, which is
 * a neon tube and not focused sunlight.
 */
/**
 * One travelling swell. In deep water omega = sqrt(g k), so the long waves
 * outrun the short ones — and that dispersion is why a sea never holds
 * formation. The crests keep sliding through one another.
 */
float swell(vec2 q, vec2 dir, float k, float amp, float t) {
  return amp * sin(dot(q, dir) * k - t * sqrt(k) * 4.4);
}

/**
 * The net. The water focuses light where the surface sum passes through zero,
 * which is a set of curves — and what those curves look like is decided by how
 * the wave energy is spread in direction, not by how many waves there are.
 *
 *   · spread the headings wide and the zero set closes up into small cells.
 *     That is the cellular, loopy look: lots of little rings, nothing running
 *     anywhere.
 *   · keep them inside a narrow arc, the way a real swell arrives, and the zero
 *     set stretches into long open filaments that run right across the frame.
 *     That is the flowing look, and it is what this wants.
 *
 * But a narrow arc of pure sinusoids is close to periodic, so the same motifs
 * come round again and it reads as a loop in time instead. The fix for that is
 * not more waves — it is a field that has no period at all. Two noise layers
 * are advected across the swell at different speeds and headings and added to
 * the sum: they never repeat, so the filaments bend and part and rejoin
 * endlessly, and because the layers only ever translate, nothing swings back.
 *
 * The music sets amplitudes and never wavenumbers: changing a wavelength
 * translates the pattern in proportion to distance, which reads as the seabed
 * sliding. Bass drives the long swells, the top end the chop.
 */
float net(vec2 q, float t, vec3 band, float focus, float punch) {
  float lo = 0.45 + band.x * 1.10;
  float mid = 0.45 + band.y * 1.10;
  float hi = 0.45 + band.z * 1.10;

  float a0 = 1.00 * lo,  a1 = 0.82 * lo;
  float a2 = 0.62 * mid, a3 = 0.46 * mid;
  float a4 = 0.34 * hi;

  // A narrow arc — all of it arriving from much the same quarter.
  float f = swell(q, vec2( 1.0000,  0.0000), 1.07, a0, t)
          + swell(q, vec2( 0.9703,  0.2419), 1.63, a1, t)
          + swell(q, vec2( 0.9816, -0.1908), 2.29, a2, t)
          + swell(q, vec2( 0.9272,  0.3746), 3.11, a3, t)
          + swell(q, vec2( 0.9455, -0.3256), 4.03, a4, t);
  f *= 3.0 / (a0 + a1 + a2 + a3 + a4);

  // The part with no period in it. Advected, never oscillated.
  f += (noise(q * 0.40 + vec2(-0.34, 0.94) * t * 4.00) - 0.5) * 2.30;
  f += (noise(q * 0.87 + vec2( 0.71, 0.70) * t * 2.60) - 0.5) * 1.25;

  // When the music leans on it, the filaments thicken rather than just
  // brighten: a wider span of the surface counts as focusing, and the core
  // inside that span broadens with it. Nothing moves — the net is exactly
  // where it was, drawn heavier.
  float bright = clamp(1.0 - abs(f) * (0.50 - punch * 0.115), 0.0, 1.0);
  float along = 0.30 + 0.70 * spow(0.5 + 0.5 * sin(dot(q, vec2(0.83, -0.55)) * 1.4
                                                   + f * 0.85 + t * 0.30), 1.5);
  // Three widths of the same thing: the haze light leaves in the water, the
  // shoulder of the focus, and the line at the middle of it.
  //
  // The beat is in the third term only, and it comes from the drum envelope
  // rather than from a tempo estimate. Scaling the wave sum instead — making
  // the swell itself rise and fall — changes how much of the floor is inside a
  // filament at all, so the whole frame flashes, which is worse than no beat.
  // Focusing and unfocusing the cores leaves the pattern where it is.
  return spow(bright, 1.1) * (0.30 + punch * 0.22)
       + spow(bright, 3.0) * (0.20 + along * 0.58 + punch * 0.34)
       + spow(bright, 8.0 - punch * 3.2) * along * (0.62 + focus * 0.55 + punch * 0.80);
}

/** Which part of the spectrum a distance belongs to. Near is low, far is high. */
float depthBand(float d) {
  return clamp(0.04 + smoothstep(1.5, 28.0, d) * 0.92, 0.0, 1.0);
}

vec3 scene(vec2 uv, vec2 st) {
  float t = u_flow * 0.11;

  // Just under the surface, looking forward and a little down.
  vec3 ro = vec3(0.0, 0.0, 0.0);
  vec3 rd = normalize(vec3(uv.x * 1.25, uv.y * 1.25 - 0.17, 1.0));

  // Fixed. Driving the bed depth from u_swell scaled the sampled coordinates
  // in and out as loudness rose and fell — the pattern zooming back and forth
  // about one place. How open the water feels is carried by the light instead,
  // in the reach term below, which changes brightness and moves nothing.
  float floorY = -0.95;
  float surfY = 2.30;

  // How much energy each register is putting into the sea. Shallow and slow:
  // changing a wavelength translates the pattern in proportion to distance, so
  // a big or quick change reads as the seabed sliding.
  vec3 band = vec3(specSlow(0.10), specSlow(0.45), specSlow(0.80));

  // The clock is u_flow, and only u_flow. u_flow is dt integrated against a
  // motion figure smoothed over seconds, so it cannot jump. u_beatTime cannot
  // be used for anything continuous: it is a tempo *estimate*, and on real
  // music the estimator ranges over an octave and drops its lock entirely —
  // measured live, it reported 48 BPM and 180 BPM within eight seconds and its
  // rate swung ninefold. Continuous motion driven by that does not read as
  // syncopation, it reads as the water speeding up and stopping at random.

  // The beat comes from the onset envelopes instead. Those are measurements of
  // the audio, not inferences about it: they need no tempo lock, they cannot
  // drift, and they land on the actual hit.
  float focus = clamp(u_kick * 0.70 + u_snare * 0.30, 0.0, 1.0);

  // Power, and only in the moments that have it. u_dynamics is short-term
  // loudness measured against the piece's own recent average, so it sits at
  // nothing through ordinary playing and climbs only where the music leans in —
  // and it settles back once a loud passage becomes the new normal, which is
  // what keeps this from simply being "loud music looks different". A little
  // absolute level underneath, so a record that is hard the whole way through
  // still carries some of it.
  float punch = power();

  // Also fixed, and for the same reason: the net is sampled where the sun's
  // ray meets the surface, so any movement of this heading is a rigid
  // translation of the entire pattern. u_centroid wanders up and down with
  // every phrase, so it slid the net one way and back — which is precisely
  // what reads as bouncing rather than flowing. The register still colours the
  // water; it no longer moves it.
  vec3 sun = normalize(vec3(-0.34, 1.00, 0.32));
  float toSurface = (surfY - floorY) / sun.y;

  vec3 col = vec3(0.0);

  float tFloor = rd.y < -0.002 ? floorY / rd.y : 1e5;
  float tTop = rd.y > 0.002 ? surfY / rd.y : 1e5;

  // How much sun is getting down here at all: the phrase-scale response, and
  // the largest thing in the frame. Near nothing when nothing is playing.
  float reach = 0.06 + u_swell * 0.74 + u_dynamics * 0.18;

  if (tFloor < 44.0) {
    vec3 hit = ro + rd * tFloor;
    vec2 q = hit.xz;

    // This patch of floor has a frequency of its own, and answers to it.
    float bandHere = depthBand(tFloor);
    float sustainHere = specSpread(bandHere);
    float litHere = sustainHere * 0.75 + spec(bandHere) * 0.25;

    float ripple = fbm3(q * 1.55 + vec2(0.0, -t * 0.05));
    vec2 lit = q + sun.xz * toSurface;
    float c = net(lit, t, band, focus, punch);
    // Long swells shadow whole stretches of the bed. The pools of light left
    // over are what make this a picture instead of a lit floor — and how open
    // they are here depends on this distance's own band.
    float open = reach * (0.45 + sustainHere * 1.10);
    float pool = smoothstep(0.58 - open * 0.40, 0.86 - open * 0.30,
                            fbm3(lit * 0.26 + vec2(-t * 0.020, t * 0.013)));
    float haze = exp(-tFloor * 0.20);

    // Sand: barely there, but there — the floor has to be a floor.
    col += world(0.09 + ripple * 0.18 + u_centroid * 0.08)
         * (0.014 + ripple * 0.030) * haze * (0.35 + pool * 0.65);

    // And the light that reached it. Brighter light is bent further, so the
    // strongest parts of the net sit higher up the ramp than its edges.
    col += world(0.70 + clamp(c, 0.0, 1.0) * 0.28) * c * haze
         * (0.22 + pool * 1.15)
         * (0.03 + litHere * 0.60 + u_level * 0.22
            );
  }

  // Everything above the bed: open water, brighter toward the surface.
  col += world(0.40 + u_centroid * 0.20) * smoothstep(-0.02, 0.50, rd.y)
       * (0.008 + u_level * 0.035 + u_swell * 0.020);

  // The shafts. Same net, sampled where each step's ray meets the surface —
  // and each step lit by the band its own distance belongs to, so the near
  // water and the far water do not flicker together.
  float far = min(min(tFloor, tTop), 30.0);
  float jitter = hash21(st * 419.0);
  vec3 shafts = vec3(0.0);
  const int STEPS = 20;
  for (int i = 0; i < STEPS; i++) {
    float s = (float(i) + jitter) / float(STEPS);
    // Squared, so the samples crowd where the shafts are nearest and widest.
    float dist = 0.4 + s * s * far;
    vec3 at = ro + rd * dist;
    vec2 pr = at.xz + sun.xz * ((surfY - at.y) / sun.y);
    float v = net(pr, t, band, focus, punch) * exp(-dist * 0.15) * exp(-(surfY - at.y) * 0.13);
    float bd = depthBand(dist);
    shafts += world(0.42 + bd * 0.34) * v * (0.07 + specSpread(bd) * 0.55 + spec(bd) * 0.22);
  }
  shafts /= float(STEPS);
  col += shafts * (0.10 + reach * 1.05 + u_level * 0.45);

  return col;
}`;
