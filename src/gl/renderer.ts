import type { Features } from "../audio/listener";
import { SPECTRUM_SIZE } from "../audio/listener";
import { EPILOGUE, PRELUDE, UNIFORM_NAMES, VERTEX_SHADER } from "./shared";
import type { Preset } from "./presets";

const HISTORY_ROWS = 256;

type Program = {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
};

export class Renderer {
  private gl: WebGL2RenderingContext;
  private programs = new Map<string, Program>();
  private spectrumTexture: WebGLTexture;
  private historyTexture: WebGLTexture;
  private spectrumBytes = new Uint8Array(SPECTRUM_SIZE * 2);
  private historyRow = 0;
  private historyClock = 0;

  private current: Preset | null = null;
  private previous: Preset | null = null;
  private fade = 1;
  private fadeSpeed = 1 / 1.6;

  private time = 0;
  /** A clock that advances at the speed of the music, not the wall. */
  private flow = 0;

  private paletteFrom = 0;
  private paletteTo = 0;
  private paletteMix = 0;

  seed = 2.618;
  grain = 1;
  /** Resolution multiplier, tuned at runtime against the frame budget. */
  quality = 1;
  /** Ceiling on pixels drawn per frame, before the quality multiplier. */
  maxPixels = 2.6e6;
  private frameMs = 16;
  private tuneCounter = 0;
  /** Compile failures surface here rather than throwing into the frame loop. */
  lastError: string | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    this.gl = gl;

    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.spectrumTexture = this.makeTexture(SPECTRUM_SIZE, 2);
    this.historyTexture = this.makeTexture(SPECTRUM_SIZE, HISTORY_ROWS);

    // A dropped context should cost a second of black, not the session.
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.programs.clear();
      // Come back at a smaller size; whatever we asked for was too much.
      this.quality = Math.max(0.5, this.quality - 0.2);
    });
    canvas.addEventListener("webglcontextrestored", () => {
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.disable(gl.DEPTH_TEST);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      this.spectrumTexture = this.makeTexture(SPECTRUM_SIZE, 2);
      this.historyTexture = this.makeTexture(SPECTRUM_SIZE, HISTORY_ROWS);
    });
  }

  private makeTexture(width: number, height: number) {
    const gl = this.gl;
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(width * height));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return texture;
  }

  private compile(preset: Preset): Program | null {
    const cached = this.programs.get(preset.id);
    if (cached) return cached;

    const gl = this.gl;
    const source = `${PRELUDE}\n${preset.glsl}\n${EPILOGUE}`;
    const vertex = this.shader(gl.VERTEX_SHADER, VERTEX_SHADER, preset.id);
    const fragment = this.shader(gl.FRAGMENT_SHADER, source, preset.id);
    if (!vertex || !fragment) return null;

    const program = gl.createProgram()!;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      this.lastError = `${preset.name}: ${gl.getProgramInfoLog(program) ?? "link failed"}`;
      console.error(this.lastError);
      gl.deleteProgram(program);
      return null;
    }

    const uniforms = new Map<string, WebGLUniformLocation | null>();
    for (const name of UNIFORM_NAMES) uniforms.set(name, gl.getUniformLocation(program, name));
    const entry = { program, uniforms };
    this.programs.set(preset.id, entry);
    return entry;
  }

  private shader(type: number, source: string, label: string) {
    const gl = this.gl;
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? "compile failed";
      this.lastError = `${label}: ${log}`;
      console.error(`Shader error in ${label}\n${log}`);
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  setPreset(preset: Preset, immediate = false) {
    if (this.current?.id === preset.id) return;
    this.compile(preset);
    this.previous = immediate ? null : this.current;
    this.current = preset;
    this.fade = immediate || !this.previous ? 1 : 0;
  }

  /** Colour worlds cross-dissolve; calling this mid-dissolve is safe. */
  setPalette(index: number, immediate = false) {
    if (immediate) {
      this.paletteFrom = index;
      this.paletteTo = index;
      this.paletteMix = 0;
      return;
    }
    if (this.paletteTo === index) return;
    // Whatever is on screen right now becomes the starting point.
    this.paletteFrom = this.paletteMix > 0.5 ? this.paletteTo : this.paletteFrom;
    this.paletteTo = index;
    this.paletteMix = 0;
  }

  /**
   * These shaders are fill-rate bound, so the frame is sized by a pixel
   * budget rather than by the display. On a 5K panel that is the difference
   * between 15 million pixels a frame and a comfortable 2.6 million.
   */
  resize() {
    const cssWidth = this.canvas.clientWidth;
    const cssHeight = this.canvas.clientHeight;
    if (cssWidth === 0 || cssHeight === 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const ideal = cssWidth * cssHeight * dpr * dpr;
    const budget = Math.min(1, Math.sqrt(this.maxPixels / ideal));
    const scale = dpr * budget * this.quality;

    const width = Math.max(1, Math.round(cssWidth * scale));
    const height = Math.max(1, Math.round(cssHeight * scale));
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
    this.gl.viewport(0, 0, width, height);
  }

  /** Trade resolution for frame rate, slowly, and only when it is warranted. */
  private tune(dt: number) {
    this.frameMs = this.frameMs * 0.92 + dt * 1000 * 0.08;
    if (++this.tuneCounter < 90) return;
    this.tuneCounter = 0;
    if (this.frameMs > 23 && this.quality > 0.55) this.quality = Math.max(0.55, this.quality - 0.12);
    else if (this.frameMs < 14 && this.quality < 1) this.quality = Math.min(1, this.quality + 0.08);
  }

  private uploadAudio(features: Features, dt: number) {
    const gl = this.gl;
    // Row 0 is the fast spectrum, row 1 the slow one.
    for (let i = 0; i < SPECTRUM_SIZE; i++) {
      this.spectrumBytes[i] = Math.round(Math.min(1, Math.max(0, features.spectrum[i])) * 255);
      this.spectrumBytes[SPECTRUM_SIZE + i] =
        Math.round(Math.min(1, Math.max(0, features.spectrumSlow[i])) * 255);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.spectrumTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SPECTRUM_SIZE, 2, gl.RED, gl.UNSIGNED_BYTE, this.spectrumBytes);

    // History advances on a fixed 60 Hz grid so the sediment scrolls evenly
    // regardless of the display's refresh rate.
    this.historyClock += dt;
    let guard = 0;
    while (this.historyClock >= 1 / 60 && guard++ < 4) {
      this.historyClock -= 1 / 60;
      this.historyRow = (this.historyRow + 1) % HISTORY_ROWS;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.historyTexture);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0, 0, this.historyRow, SPECTRUM_SIZE, 1,
        gl.RED, gl.UNSIGNED_BYTE, this.spectrumBytes.subarray(0, SPECTRUM_SIZE),
      );
    }
  }

  private draw(entry: Program, features: Features, alpha: number) {
    const gl = this.gl;
    const u = entry.uniforms;
    gl.useProgram(entry.program);

    gl.uniform2f(u.get("u_resolution")!, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.get("u_time")!, this.time);
    gl.uniform1f(u.get("u_flow")!, this.flow);
    gl.uniform1f(u.get("u_motion")!, features.motion);
    gl.uniform1f(u.get("u_seed")!, this.seed);
    gl.uniform1f(u.get("u_alpha")!, alpha);
    gl.uniform1f(u.get("u_palette")!, this.paletteFrom);
    gl.uniform1f(u.get("u_paletteTo")!, this.paletteTo);
    gl.uniform1f(u.get("u_paletteMix")!, this.paletteMix);
    gl.uniform1f(u.get("u_grain")!, this.grain);

    gl.uniform1f(u.get("u_level")!, features.level);
    gl.uniform1f(u.get("u_sub")!, features.sub);
    gl.uniform1f(u.get("u_bass")!, features.bass);
    gl.uniform1f(u.get("u_lowMid")!, features.lowMid);
    gl.uniform1f(u.get("u_mid")!, features.mid);
    gl.uniform1f(u.get("u_high")!, features.high);
    gl.uniform1f(u.get("u_air")!, features.air);
    gl.uniform1f(u.get("u_centroid")!, features.centroid);
    gl.uniform1f(u.get("u_noise")!, features.noise);
    gl.uniform1f(u.get("u_flux")!, features.flux);
    gl.uniform1f(u.get("u_kick")!, features.kick);
    gl.uniform1f(u.get("u_snare")!, features.snare);
    gl.uniform1f(u.get("u_hat")!, features.hat);
    gl.uniform1f(u.get("u_pulse")!, features.pulse);
    gl.uniform1f(u.get("u_beat")!, features.beatPhase);
    gl.uniform1f(u.get("u_beatTime")!, features.beatTime);
    gl.uniform1f(u.get("u_dynamics")!, features.dynamics);
    gl.uniform1f(u.get("u_swell")!, features.swell);
    gl.uniform1f(u.get("u_silence")!, features.silence);
    gl.uniform1f(u.get("u_section")!, features.section);

    gl.uniform1i(u.get("u_spectrum")!, 0);
    gl.uniform1i(u.get("u_history")!, 1);
    gl.uniform1f(u.get("u_historyRow")!, this.historyRow);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.spectrumTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.historyTexture);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  render(features: Features, dt: number) {
    const gl = this.gl;
    if (gl.isContextLost()) return;

    this.time += dt;
    this.flow += dt * features.motion;
    this.tune(dt);

    if (this.paletteTo !== this.paletteFrom && this.paletteMix < 1) {
      this.paletteMix = Math.min(1, this.paletteMix + dt / 0.45);
      if (this.paletteMix >= 1) {
        this.paletteFrom = this.paletteTo;
        this.paletteMix = 0;
      }
    }

    this.resize();
    this.uploadAudio(features, dt);

    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (!this.current) return;
    const currentProgram = this.compile(this.current);
    if (!currentProgram) return;

    if (this.fade < 1) this.fade = Math.min(1, this.fade + dt * this.fadeSpeed);

    gl.disable(gl.BLEND);
    if (this.previous && this.fade < 1) {
      const previousProgram = this.compile(this.previous);
      if (previousProgram) {
        this.draw(previousProgram, features, 1);
        gl.enable(gl.BLEND);
      }
    }

    // Ease the crossfade so neither end of it reads as a cut.
    const t = this.fade * this.fade * (3 - 2 * this.fade);
    this.draw(currentProgram, features, this.previous ? t : 1);
    gl.disable(gl.BLEND);

    if (this.fade >= 1) this.previous = null;
  }

  dispose() {
    const gl = this.gl;
    for (const entry of this.programs.values()) gl.deleteProgram(entry.program);
    this.programs.clear();
    gl.deleteTexture(this.spectrumTexture);
    gl.deleteTexture(this.historyTexture);
  }
}
