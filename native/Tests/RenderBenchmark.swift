import XCTest
import Metal
@testable import Serein

/// GPU cost of each effect at the renderer's full pixel budget. Opt-in, since
/// timings depend on the machine: `SEREIN_BENCH=1 swift test --filter RenderBenchmark`.
final class RenderBenchmark: XCTestCase {
    func testEffectFrameTimes() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["SEREIN_BENCH"] != nil, "Set SEREIN_BENCH=1 to benchmark")
        let device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
        let started = CACurrentMediaTime()
        let pipelines = try await MetalSetup.pipelines(device: device, format: .bgra8Unorm)
        try measure(device: device, pipelines: pipelines, setup: CACurrentMediaTime() - started)
    }

    private func measure(device: MTLDevice, pipelines: [MTLRenderPipelineState], setup compile: Double) throws {
        let queue = try XCTUnwrap(device.makeCommandQueue())
        let width = 1856, height = 970 // 1.8 million pixels, the renderer's ceiling
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: width, height: height, mipmapped: false)
        descriptor.usage = [.renderTarget]; descriptor.storageMode = .private
        let output = try XCTUnwrap(device.makeTexture(descriptor: descriptor))
        let spectrum = MetalSetup.texture(device: device, height: 2)
        let history = MetalSetup.texture(device: device, height: 256)
        var f = AudioFeatures()
        f.level = 0.7; f.bands = [0.7, 0.8, 0.6, 0.65, 0.7, 0.5]
        f.spectrum = (0..<256).map { 0.35 + 0.3 * sin(Float($0) * 0.03) }
        f.slow = f.spectrum; f.swell = 0.6; f.kick = 0.6; f.snare = 0.4; f.hat = 0.5
        f.dynamics = 0.56; f.silence = 0; f.motion = 1; f.beatTime = 16.3
        (f.spectrum + f.slow).withUnsafeBytes { spectrum.replace(region: MTLRegionMake2D(0, 0, 256, 2), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: 1024) }
        var report = [String]()
        var total: Double = 0
        // Interleaved rounds, best median per effect: GPU clocks drift over a
        // run, and a single pass attributes that drift to whichever effect ran.
        var best = [Double](repeating: .infinity, count: Effect.all.count)
        var p90 = best
        for _ in 0..<3 { for effect in Effect.all {
            var samples = [Double]()
            for frame in 0..<60 {
                let pass = MTLRenderPassDescriptor()
                pass.colorAttachments[0].texture = output
                pass.colorAttachments[0].loadAction = .clear
                pass.colorAttachments[0].storeAction = .store
                let command = try XCTUnwrap(queue.makeCommandBuffer())
                let encoder = try XCTUnwrap(command.makeRenderCommandEncoder(descriptor: pass))
                var uniforms = MetalSetup.uniforms(size: CGSize(width: width, height: height), time: 30 + Float(frame) / 60,
                    flow: 12 + Float(frame) / 60, seed: 2.618, palette: 0, paletteTo: 0, paletteMix: 1, grain: 0.65,
                    features: f, historyRow: 128)
                MetalSetup.encode(encoder, pipelines: pipelines, effect: effect.id, uniforms: &uniforms)
                encoder.setFragmentTexture(spectrum, index: 0); encoder.setFragmentTexture(history, index: 1)
                encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
                encoder.endEncoding(); command.commit(); command.waitUntilCompleted()
                XCTAssertNil(command.error)
                if frame >= 20 { samples.append((command.gpuEndTime - command.gpuStartTime) * 1000) }
            }
            samples.sort()
            if samples[samples.count / 2] < best[effect.id] {
                best[effect.id] = samples[samples.count / 2]; p90[effect.id] = samples[samples.count * 9 / 10]
            }
        } }
        for effect in Effect.all {
            total += best[effect.id]
            report.append(effect.name.padding(toLength: 12, withPad: " ", startingAt: 0) + String(format: "%6.2f ms  (p90 %6.2f)", best[effect.id], p90[effect.id]))
        }
        print("\n=== GPU frame time at \(width)×\(height), \(device.name) ===")
        print(String(format: "pipeline setup %.0f ms", compile * 1000))
        report.forEach { print($0) }
        print(String(format: "mean %.2f ms\n", total / Double(Effect.all.count)))
    }
}
