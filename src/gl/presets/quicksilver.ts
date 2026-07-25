/**
 * Quicksilver — a sheet of liquid metal, vibrating.
 *
 * Drive a shallow layer of liquid at a frequency and it does not slosh: it
 * stands up into a lattice, stripes or squares or hexagons depending on how
 * the drive is composed, with a wavelength set by the frequency itself.
 * Faraday found this in 1831 and it is the most direct picture of pitch there
 * is — the note you are playing is the size of the cells.
 *
 * So the mapping is not decorative, it is the physics:
 *   · a bass line brings the long swells forward and a bright passage brings
 *     the chop forward, so the surface visibly coarsens and refines with the
 *     music — and it is always travelling while it does it.
 *   · which register is loudest sets which scale of swell dominates, and the
 *     eye reads the loudest scale as the size of the cells. Carried by
 *     amplitude and never by wavelength: scaling the field would slide every
 *     point in proportion to its distance and slide it back again.
 *   · the drive is the drum envelopes and the loudness, so the lattice stands
 *     up on the hit and relaxes between — the whole surface at once, rather
 *     than a flash laid over it. It reads from what the analyser measures and
 *     never from u_beatTime, which is a tempo *estimate*: on real music that
 *     figure ranges over an octave and drops its lock, so anything continuous
 *     driven by it speeds up and stops at random.
 *   · a kick throws a crown, carried outward by its own decay.
 *   · loudness is amplitude, and amplitude here means how far the reflection
 *     is broken up — quiet leaves a near mirror, loud shatters it.
 *
 * Nothing in the frame emits: it is a dark mirror under a strip light, so
 * every bright thing in the picture is the reflection of that lamp, cut to
 * pieces by the lattice and put back together at the horizon where the surface
 * turns edge-on and Fresnel takes over.
 */
export const quicksilver = `
/**
 * The surface, and its slope, in closed form — the gradient of a sum of sines
 * is a sum of cosines, and a finite difference at this frequency would need
 * steps small enough to lose precision. Returns (height, d/dx, d/dy).
 *
 * Six travelling swells, each at the speed its own wavelength demands: in deep
 * water omega = sqrt(g k), so the long ones outrun the short ones. That
 * dispersion is why a sea never holds formation — the crests keep sliding
 * through one another, and it flows instead of standing still and pulsing.
 *
 * The wavenumbers are fixed and the music moves only the amplitudes. Driving a
 * wavelength from the register scales the whole field, which slides every point
 * in proportion to its distance from the origin and slides it back when the
 * register falls — the bouncing that has to be kept out of everything here. Re-
 * weighting fixed wavelengths gives the same reading of pitch, because the eye
 * reads whichever scale is loudest, and it moves nothing.
 */
vec3 sea(vec2 p, float t, vec3 band, float pump) {
  float lo = (0.45 + band.x * 1.15) * pump;
  float mid = (0.45 + band.y * 1.15) * pump;
  float hi = (0.45 + band.z * 1.15) * pump;

  float h = 0.0;
  vec2 g = vec2(0.0);

  vec2 d0 = vec2( 0.9997,  0.0262); float k0 =  1.90; float a0 = 1.00 * lo;
  vec2 d1 = vec2( 0.9613,  0.2756); float k1 =  2.90; float a1 = 0.78 * lo;
  vec2 d2 = vec2( 0.9781, -0.2079); float k2 =  4.30; float a2 = 0.58 * mid;
  vec2 d3 = vec2( 0.8988,  0.4384); float k3 =  6.10; float a3 = 0.42 * mid;
  vec2 d4 = vec2( 0.9336, -0.3584); float k4 =  8.40; float a4 = 0.30 * hi;
  vec2 d5 = vec2( 0.8480,  0.5299); float k5 = 11.60; float a5 = 0.21 * hi;

  float s0 = dot(p, d0) * k0 - t * sqrt(k0) * 0.50;
  float s1 = dot(p, d1) * k1 - t * sqrt(k1) * 0.50;
  float s2 = dot(p, d2) * k2 - t * sqrt(k2) * 0.50;
  float s3 = dot(p, d3) * k3 - t * sqrt(k3) * 0.50;
  float s4 = dot(p, d4) * k4 - t * sqrt(k4) * 0.50;
  float s5 = dot(p, d5) * k5 - t * sqrt(k5) * 0.50;

  h = a0*sin(s0) + a1*sin(s1) + a2*sin(s2) + a3*sin(s3) + a4*sin(s4) + a5*sin(s5);
  g = a0*k0*cos(s0)*d0 + a1*k1*cos(s1)*d1 + a2*k2*cos(s2)*d2
    + a3*k3*cos(s3)*d3 + a4*k4*cos(s4)*d4 + a5*k5*cos(s5)*d5;

  float norm = 1.0 / (a0 + a1 + a2 + a3 + a4 + a5 + 1e-4);
  return vec3(h * norm, g * norm);
}

/**
 * The crown a kick throws, and its ring. Carried outward by the kick's own
 * decay rather than by a beat counter — u_beatTime is a tempo estimate and it
 * jumps on real music, which would teleport the ring mid-flight. Slope in
 * closed form, same as the lattice.
 */
vec3 crown(vec2 p, float amount) {
  float env = u_kick;
  if (env < 0.003) return vec3(0.0);
  vec2 origin = vec2(sin(u_flow * 0.05) * 1.15, cos(u_flow * 0.043 + 1.7) * 0.85);
  vec2 d = p - origin;
  float r = max(length(d), 1e-4);
  float front = (1.0 - env) * 2.4;
  float x = (r - front) * 7.0;
  float e = gauss(x * 0.34) * env;
  float h = sin(x) * e;
  float dh = cos(x) * 7.0 * e + sin(x) * e * (-2.0 * x * 0.34 * 0.34 * 7.0);
  return vec3(h, dh * d / r) * amount;
}

/**
 * The room the sheet is in: one lamp, low and ahead, and otherwise dark.
 *
 * It has to be one compact source. A broad panel reflects as a broad wash and
 * the lattice can only ripple it slightly; a small bright source reflects as a
 * glitter path — thousands of separate glints, one wherever a facet happens to
 * be tilted right — and because the facets here are a lattice, the glints come
 * out on a lattice too. That is the picture: the spacing of the glitter is the
 * wavelength, and the wavelength is the note.
 */
vec3 room(vec3 d) {
  vec3 lamp = normalize(vec3(0.46, 0.26, 1.0));
  float c = max(dot(normalize(d), lamp), 0.0);
  vec3 col = world(0.99) * spow(c, 2600.0) * (4.0 + u_level * 7.0 + u_pulse * 2.0 + power() * 4.0);
  col += world(0.78 + u_centroid * 0.18) * spow(c, 110.0) * (0.40 + u_level * 1.10);
  col += world(0.44 + u_centroid * 0.20) * spow(c, 16.0) * (0.020 + u_air * 0.09);
  // A soft ambient the whole sheet can reflect, so the lattice is legible
  // right across the frame and not only inside the glitter.
  col += world(0.30 + u_centroid * 0.18) * smoothstep(-0.12, 0.8, d.y)
       * (0.045 + u_swell * 0.070 + u_level * 0.050);
  return col * smoothstep(-0.30, 0.0, d.y);
}

vec3 scene(vec2 uv, vec2 st) {
  float t = u_flow;

  // A shallow view across the sheet, so it recedes rather than lying flat on
  // the glass. The surface is the plane y = 0 and the camera sits just above.
  vec3 ro = vec3(0.0, 0.40, 0.0);
  vec3 rd = normalize(vec3(uv.x * 1.15, uv.y * 1.15 - 0.26, 1.0));
  // No camera sway. A sin(t) yaw is a rigid swing left and right.

  // Above the horizon we are looking straight into the room, so the lamp
  // itself is in the frame and the glitter below is its reflection.
  if (rd.y > -0.004) return room(rd);

  float dist = -ro.y / rd.y;
  vec3 hit = ro + rd * dist;
  vec2 p = hit.xz;

  // Which register is putting energy into the sea. The eye reads whichever
  // scale is loudest, so this is still the note — it is just carried by
  // amplitude rather than by geometry.
  vec3 band = vec3(specSpread(0.10), specSpread(0.45), specSpread(0.80));
  // How hard the sheet is being driven. From the drum envelopes and the
  // loudness, never from a beat counter: a Faraday lattice answers to the
  // amplitude of its drive, and that is something the analyser measures rather
  // than infers.
  float pump = 0.28 + clamp(u_kick * 0.62 + u_snare * 0.30 + u_level * 0.45, 0.0, 0.95);
  // Detail has to die with distance or the far half of the sheet turns into a
  // moire of half-resolved cells — the one thing a mirror must never do.
  float near = exp(-dist * 0.14);
  // On the moments with power in them the sheet is driven harder: the facets
  // tilt further, so the glitter path opens out across the frame.
  float pw = power();
  float amp = (0.036 + u_level * 0.145 + u_swell * 0.075 + pw * 0.075) * pump * near;

  vec3 lat = sea(p, t, band, pump);
  vec3 ring = crown(p, 0.010 + u_kick * 0.030) * near;

  vec2 slope = lat.yz * amp + ring.yz;
  vec3 n = normalize(vec3(-slope.x, 1.0, -slope.y));

  vec3 view = -rd;
  vec3 refl = reflect(rd, n);
  // Grazing, the sheet becomes a perfect mirror; head-on it shows its own
  // darkness. This is what fills the far half of the frame with light.
  float fres = 0.05 + 0.95 * spow(1.0 - max(dot(view, n), 0.0), 4.5);

  vec3 col = room(refl) * fres;
  // The metal's own colour, where it is not mirroring anything. The lattice
  // shows faintly in it, so the cells are legible even out of the glitter.
  col += world(0.14 + u_centroid * 0.12) * (1.0 - fres)
       * (0.030 + u_level * 0.110 + spow(clamp(lat.x * 0.5 + 0.5, 0.0, 1.0), 2.0) * 0.160 * near);

  // Distance into the dark of the room, and a little haze at the horizon so
  // the sheet does not end on a drawn line.
  col *= exp(-dist * 0.055);
  col += world(0.30 + u_centroid * 0.16) * spow(1.0 - near, 8.0) * (0.010 + u_swell * 0.030);

  return col;
}`;
