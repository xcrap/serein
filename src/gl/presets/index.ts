import { bloom } from "./bloom";
import { boreal } from "./boreal";
import { coil } from "./coil";
import { corona } from "./corona";
import { fathom } from "./fathom";
import { harp } from "./harp";
import { ink } from "./ink";
import { quicksilver } from "./quicksilver";
import { veil } from "./veil";
import { wick } from "./wick";

export type Preset = {
  id: string;
  name: string;
  /** Shown under the title — what this one is actually listening to. */
  note: string;
  glsl: string;
};

export const PRESETS: Preset[] = [
  { id: "veil", name: "Veil", note: "a membrane held between low and high", glsl: veil },
  { id: "bloom", name: "Bloom", note: "ink released into water, one ring every two beats", glsl: bloom },
  { id: "coil", name: "Coil", note: "one long body, the spectrum along its length", glsl: coil },
  { id: "ink", name: "Ink", note: "pigment lit from inside, pushed by the low end", glsl: ink },
  { id: "harp", name: "Harp", note: "sixteen strings, struck and left to ring", glsl: harp },
  { id: "fathom", name: "Fathom", note: "sunlight bent through the surface onto the seabed", glsl: fathom },
  { id: "quicksilver", name: "Quicksilver", note: "liquid metal standing up into the shape of the note", glsl: quicksilver },
  { id: "corona", name: "Corona", note: "an eclipse, its light streaming out on the wind", glsl: corona },
  { id: "wick", name: "Wick", note: "one flame, the music rising through it as heat", glsl: wick },
  { id: "boreal", name: "Boreal", note: "curtains of light folding away over a still lake", glsl: boreal },
];
