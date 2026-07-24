/**
 * Colour worlds. Four stops each, dark-footed so black stays black.
 *
 * Each is a dark foot and then three genuinely different hues — the standard
 * set by Veil's own ember, lilac and ice. A ramp made of one hue walked from
 * dark to bright is the boring case: every preset then reads as the same
 * picture in a different tint. Because each preset maps its own values through
 * the ramp, three separated hues give each of them a different look, and give
 * a single frame more than one colour in it at a time.
 *
 * Nothing runs to white: the top stop is always a mid chroma, so the image
 * stays dark and coloured instead of washing out.
 *
 * This table is the single source of truth: the shader's `world()` is
 * generated from it, and the interface reads its names.
 */

export type Palette = {
  name: string;
  /** shadow, low mid, high mid, light — hex, no alpha. */
  stops: [string, string, string, string] | null;
};

export const PALETTES: Palette[] = [
  // Native means "whatever this preset was painted in" — Veil's own ember,
  // chartreuse, lilac and ice. That is the standard the rest of this table is
  // built to: hues far enough apart that a single frame holds several.
  { name: "Native", stops: null },

  // A dark foot and three hues, each well away from the others on the wheel.
  // Two neighbouring stops in the same family (a red and an amber, say) read
  // as one colour, and the ramp collapses to a tint.
  { name: "Ember", stops: ["#0a0304", "#e0341a", "#e8c22a", "#3fa8d8"] },
  { name: "Glacier", stops: ["#01070f", "#1f6fd0", "#c8e04a", "#e06090"] },
  { name: "Nocturne", stops: ["#03040e", "#4a4bc0", "#d05fa0", "#e8d070"] },
  { name: "Iris", stops: ["#0a041a", "#7a2fd0", "#e0508a", "#7fd8c0"] },
  { name: "Cinder", stops: ["#050610", "#2f5fb0", "#e07040", "#d8d060"] },
  { name: "Peony", stops: ["#12030c", "#d02860", "#f0a040", "#60c0b0"] },
  { name: "Verdigris", stops: ["#021009", "#1a8a60", "#d0c840", "#b060d0"] },
  { name: "Absinthe", stops: ["#050c06", "#4a9a3a", "#d8d040", "#e06850"] },
  { name: "Tide", stops: ["#01080c", "#1a7a90", "#e06a30", "#b0a8e0"] },
  { name: "Copper", stops: ["#0a0604", "#a04018", "#e0a040", "#5fb0e0"] },
  { name: "Bruise", stops: ["#04061a", "#5a20a0", "#d03070", "#f0b040"] },
  { name: "Aurora", stops: ["#05030f", "#5020a0", "#22a86a", "#e8d060"] },
];

function toVec3(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  return `vec3(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)})`;
}

const CHROMATIC = PALETTES.filter((p) => p.stops);

export const PALETTE_GLSL = `
const vec3 PALETTE_STOPS[${CHROMATIC.length * 4}] = vec3[${CHROMATIC.length * 4}](
${CHROMATIC.map((p) => "  " + p.stops!.map(toVec3).join(", ")).join(",\n")}
);

vec3 rampAt(float world, float t) {
  if (world < 0.5) return nativeRamp(t);
  int base = (int(world) - 1) * 4;
  vec3 a = PALETTE_STOPS[base];
  vec3 b = PALETTE_STOPS[base + 1];
  vec3 c = PALETTE_STOPS[base + 2];
  vec3 d = PALETTE_STOPS[base + 3];
  if (t < 0.3333) return mix(a, b, t * 3.0);
  if (t < 0.6666) return mix(b, c, (t - 0.3333) * 3.0);
  return mix(c, d, (t - 0.6666) * 3.0);
}

/** Colour worlds cross-dissolve rather than cutting. */
vec3 world(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 from = rampAt(u_palette, t);
  if (u_paletteMix < 0.001) return from;
  return mix(from, rampAt(u_paletteTo, t), u_paletteMix);
}
`;

/** A representative colour for each world, for the dots in the interface. */
export function swatch(index: number) {
  const stops = PALETTES[index]?.stops;
  if (!stops) return "linear-gradient(135deg, #ff4c29 0%, #a861ff 100%)";
  return `linear-gradient(135deg, ${stops[1]} 0%, ${stops[2]} 62%, ${stops[3]} 100%)`;
}
