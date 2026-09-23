import XCTest
import Metal
import AppKit
@testable import Serein

final class MetalEffectsTests: XCTestCase {
    func testEveryEffectOnRealGPU() async throws {
        let device = try XCTUnwrap(MTLCreateSystemDefaultDevice(), "Metal GPU is required for rendering verification")
        try renderEveryEffect(device: device, pipelines: try await MetalSetup.pipelines(device: device, format: .rgba32Float))
    }

    private func renderEveryEffect(device: MTLDevice, pipelines: [MTLRenderPipelineState]) throws {
        let queue = try XCTUnwrap(device.makeCommandQueue())
        let width = 384, height = 240
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba32Float, width: width, height: height, mipmapped: false)
        descriptor.usage = [.renderTarget]; descriptor.storageMode = .shared
        let output = try XCTUnwrap(device.makeTexture(descriptor: descriptor))
        let spectrum = MetalSetup.texture(device: device, height: 2)
        let history = MetalSetup.texture(device: device, height: 256)
        let outputDirectory = ProcessInfo.processInfo.environment["SEREIN_RENDER_DIR"]
        if let outputDirectory { try FileManager.default.createDirectory(atPath: outputDirectory, withIntermediateDirectories: true) }
        var signatures = Set<Int>()
        for mode in 0..<3 {
            var f = mode == 0 ? AudioFeatures() : AudioFeatures.resting(at: 30)
            if mode == 2 {
                f.level = 0.8; f.bands = [0.7, 0.8, 0.6, 0.65, 0.7, 0.5]
                f.spectrum = (0..<256).map { 0.35 + 0.3 * sin(Float($0) * 0.03) }
                f.slow = f.spectrum; f.swell = 0.6; f.kick = 0.8; f.hat = 0.5
                f.dynamics = 0.6; f.silence = 0; f.beatTime = 16.3
            }
            (f.spectrum + f.slow).withUnsafeBytes { spectrum.replace(region: MTLRegionMake2D(0, 0, 256, 2), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: 1024) }
            Array(repeating: f.spectrum, count: 256).flatMap { $0 }.withUnsafeBytes {
                history.replace(region: MTLRegionMake2D(0, 0, 256, 256), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: 1024)
            }
            for effect in Effect.all {
                let pass = MTLRenderPassDescriptor()
                pass.colorAttachments[0].texture = output
                pass.colorAttachments[0].loadAction = .clear
                pass.colorAttachments[0].storeAction = .store
                let command = try XCTUnwrap(queue.makeCommandBuffer())
                let encoder = try XCTUnwrap(command.makeRenderCommandEncoder(descriptor: pass))
                var uniforms = MetalSetup.uniforms(size: CGSize(width: width, height: height), time: 30, flow: 12,
                    seed: 2.618, palette: 0, paletteTo: 0, paletteMix: 1, grain: 0, features: f, historyRow: 128)
                XCTAssertEqual(uniforms.count, 32)
                MetalSetup.encode(encoder, pipelines: pipelines, effect: effect.id, uniforms: &uniforms)
                encoder.setFragmentTexture(spectrum, index: 0); encoder.setFragmentTexture(history, index: 1)
                encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
                encoder.endEncoding(); command.commit(); command.waitUntilCompleted()
                XCTAssertNil(command.error, "\(effect.name): GPU error")
                var pixels = [Float](repeating: 0, count: width * height * 4)
                pixels.withUnsafeMutableBytes { output.getBytes($0.baseAddress!, bytesPerRow: width * 16, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0) }
                XCTAssertTrue(pixels.allSatisfy(\.isFinite), "\(effect.name), mode \(mode): NaN or infinity")
                let rgb = pixels.enumerated().filter { $0.offset % 4 != 3 }.map(\.element)
                XCTAssertGreaterThan(rgb.max() ?? 0, 0.00001, "\(effect.name), mode \(mode): black frame")
                if mode == 2 { signatures.insert(Int(rgb.reduce(0, +) * 100)) }
                if let outputDirectory, mode == 2 {
                    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                        colorSpaceName: .deviceRGB, bytesPerRow: width * 4, bitsPerPixel: 32)!
                    for i in pixels.indices { bitmap.bitmapData![i] = UInt8(clamp(pixels[i]) * 255) }
                    try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: outputDirectory).appendingPathComponent(effect.name + ".png"))
                }
            }
        }
        XCTAssertEqual(signatures.count, Effect.all.count, "Each effect must produce a distinct frame")
    }
}
