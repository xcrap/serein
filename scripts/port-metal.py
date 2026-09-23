#!/usr/bin/env python3
"""Rebuild the Metal effects from the WebGL sources, which stay the originals.

Run only when intentionally refreshing the port. The app ships the generated
Metal source and has no JavaScript, Python, or WebGL runtime dependency.
"""
import pathlib
import re

root = pathlib.Path(__file__).resolve().parent.parent
shared = (root / 'src/gl/shared.ts').read_text()
prelude = shared.split('export const PRELUDE = `')[1].split('`;')[0]
uniforms = re.findall(r'uniform (float|vec2) (u_\w+);', prelude)
macros = []
index = 0
for kind, name in uniforms:
    if kind == 'vec2':
        macros.append(f'#define {name} float2(uniforms[{index}], uniforms[{index+1}])')
        index += 2
    else:
        macros.append(f'#define {name} uniforms[{index}]')
        index += 1

def metal(source):
    source = re.sub(r'/\*.*?\*/', '', source, flags=re.S)
    source = re.sub(r'//[^\n]*', '', source)
    for size in (2, 3, 4):
        source = source.replace(f'vec{size}', f'float{size}')
    source = re.sub(r'mat2\(([^,]+),([^,]+),([^,]+),([^\)]+)\)',
                    r'float2x2(float2(\1,\2), float2(\3,\4))', source)
    source = source.replace('mat2', 'float2x2')
    # GLSL spells two-argument arctangent atan(y, x); Metal spells it atan2.
    source = re.sub(r'\batan\(([^,()]+),', r'atan2(\1,', source)
    source = re.sub(r'\bmod\(', 'glmod(', source)
    source = source.replace('texture(u_spectrum,', 'spectrum.sample(spectrumSampler,')
    source = source.replace('texture(u_history,', 'historyTexture.sample(historySampler,')
    # GLSL defines reversed-edge smoothsteps used by the original effects.
    source = re.sub(r'\bsmoothstep\(', 'smoothStep(', source)
    return re.sub(r'\n\s*\n\s*\n', '\n\n', source)

palette_source = (root / 'src/gl/palettes.ts').read_text()
hexes = re.findall(r'"(#[0-9a-f]{6})"', palette_source.split('function toVec3')[0])
colors = []
for value in hexes:
    n = int(value[1:], 16)
    colors.append('float3(' + ', '.join(f'{((n >> b) & 255)/255:.6f}' for b in (16, 8, 0)) + ')')
# Every ramp is piecewise linear through the same four knots, so a dissolve
# between two worlds is the ramp through their blended stops. Blending the
# stops once per pixel replaces two full ramp evaluations per world() call,
# and Coil calls world() fifty times a pixel.
palette = f'''
float3 ramp[4];
float3 rampStop(float world, int stop) {{
    if (world < 0.5) return nativeRamp(float(stop) / 3.0);
    return paletteStops[clamp(int(world) - 1, 0, {len(hexes) // 4 - 1}) * 4 + stop];
}}
void preparePalette() {{
    for (int stop = 0; stop < 4; stop++)
        ramp[stop] = mix(rampStop(u_palette, stop), rampStop(u_paletteTo, stop), u_paletteMix);
}}
float3 world(float t) {{
    float x = clamp(t, 0.0, 1.0) * 3.0;
    return ramp[0] + (ramp[1] - ramp[0]) * clamp(x, 0.0, 1.0)
         + (ramp[2] - ramp[1]) * clamp(x - 1.0, 0.0, 1.0)
         + (ramp[3] - ramp[2]) * clamp(x - 2.0, 0.0, 1.0);
}}
'''
# The browser's preset list decides the order, and the order is the effect index.
names = re.findall(r'\{ id: "(\w+)"', (root / 'src/gl/presets/index.ts').read_text())
body = metal(prelude[prelude.index('#define PI'):].replace('${PALETTE_GLSL}', '')) + palette
# Valid GLSL names that Metal reserves. They fail at runtime, in a compile
# error that points at generated code, so catch them here by preset.
reserved = {'half', 'half2', 'half3', 'half4', 'sampler', 'texture', 'device', 'constant',
            'thread', 'threadgroup', 'kernel', 'vertex', 'fragment', 'patch', 'ray',
            'and', 'or', 'not', 'xor', 'bitand', 'bitor', 'compl', 'this', 'new', 'delete',
            'class', 'template', 'namespace', 'typename', 'operator', 'private', 'public',
            'register', 'static', 'extern', 'auto', 'mutable', 'friend', 'virtual', 'explicit',
            'union', 'enum', 'typedef', 'goto', 'default', 'case', 'switch', 'char', 'short',
            'long', 'signed', 'unsigned', 'double', 'volatile', 'inline', 'sizeof', 'typeid'}
for name in names:
    source = (root / f'src/gl/presets/{name}.ts').read_text().split(f'export const {name} = `')[1].rsplit('`;', 1)[0]
    code = re.sub(r'//[^\n]*', '', re.sub(r'/\*.*?\*/', '', source, flags=re.S))
    clashes = sorted(reserved & set(re.findall(r'\b[A-Za-z_]\w*\b', code)))
    if clashes:
        raise SystemExit(f'{name}.ts uses {", ".join(clashes)}, reserved in Metal. Rename it.')
    body += '\n' + metal(source).replace('float3 scene(', f'float3 {name}(')
body += '\nfloat3 scene(int effect, float2 uv, float2 st) {\n switch(effect) {\n'
body += '\n'.join(f'case {i}: return {name}(uv, st);' for i, name in enumerate(names))
body += '\ndefault: return veil(uv, st);\n}\n}\n'
post = shared.split('export const EPILOGUE = `')[1].split('`;')[0]
post = post.replace('void main() {', 'float4 render(float2 position, int effect) {\n  preparePalette();')
post = post.replace('gl_FragCoord.xy', 'position').replace('scene(uv, st)', 'scene(effect, uv, st)')
post = post.replace('outColor =', 'return')
body += metal(post)
source = '''// Generated by scripts/port-metal.py. Native Metal; no WebGL runtime.
#include <metal_stdlib>
using namespace metal;
constant float3 paletteStops[] = {
''' + ',\n'.join(colors) + '''
};
constexpr sampler spectrumSampler(coord::normalized, address::clamp_to_edge, filter::linear);
constexpr sampler historySampler(coord::normalized, s_address::clamp_to_edge, t_address::repeat, filter::linear);
float glmod(float x, float y) { return x - y * floor(x / y); }
float smoothStep(float a, float b, float x) {
    float t = clamp((x - a) / (b - a), 0.0f, 1.0f);
    return t * t * (3.0f - 2.0f * t);
}
''' + '\n'.join(macros) + '''
struct Instrument {
    constant float* uniforms;
    texture2d<float> spectrum;
    texture2d<float> historyTexture;
''' + body + '''
};
struct VertexOut { float4 position [[position]]; };
vertex VertexOut fullScreen(uint id [[vertex_id]]) {
    float2 p = float2((id << 1) & 2, id & 2);
    return {float4(p * 2.0 - 1.0, 0.0, 1.0)};
}
// Each effect is its own specialised pipeline. With the effect as a runtime
// argument, every effect was compiled for the register pressure of the
// heaviest one; as a function constant, the other branches are removed.
constant int effectIndex [[function_constant(0)]];
fragment float4 visualizer(VertexOut in [[stage_in]],
                           constant float* uniforms [[buffer(0)]],
                           texture2d<float> spectrum [[texture(0)]],
                           texture2d<float> historyTexture [[texture(1)]]) {
    Instrument instrument {uniforms, spectrum, historyTexture};
    return instrument.render(float2(in.position.x, uniforms[1] - in.position.y), effectIndex);
}
'''
destination = root / 'native/Sources/Serein/Resources/Effects.metal'
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text('\n'.join(line.rstrip() for line in source.splitlines()) + '\n')
print(f'Wrote {destination}: {index} uniform floats, {len(names)} effects')
