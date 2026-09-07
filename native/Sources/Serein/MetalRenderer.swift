import MetalKit
import SwiftUI

enum MetalSetup {
    static func pipeline(device: MTLDevice, format: MTLPixelFormat = .bgra8Unorm) throws -> MTLRenderPipelineState {
        guard let url = Bundle.main.url(forResource: "Effects", withExtension: "metal")
            ?? Bundle.module.url(forResource: "Effects", withExtension: "metal", subdirectory: "Resources") else {
            throw SereinError.message("The Metal effects resource is missing. Rebuild Serein with scripts/build-macos.sh.")
        }
        let source = try String(contentsOf: url, encoding: .utf8)
        let library = try device.makeLibrary(source: source, options: nil)
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = library.makeFunction(name: "fullScreen")
        descriptor.fragmentFunction = library.makeFunction(name: "visualizer")
        let color = descriptor.colorAttachments[0]!
        color.pixelFormat = format
        color.isBlendingEnabled = true
        color.sourceRGBBlendFactor = .sourceAlpha
        color.destinationRGBBlendFactor = .oneMinusSourceAlpha
        color.sourceAlphaBlendFactor = .one
        color.destinationAlphaBlendFactor = .oneMinusSourceAlpha
        return try device.makeRenderPipelineState(descriptor: descriptor)
    }

    static func uniforms(size: CGSize, time: Float, flow: Float, seed: Float, palette: Float,
                         paletteTo: Float, paletteMix: Float, grain: Float, features f: AudioFeatures,
                         historyRow: Int, intensity: Float = 1, alpha: Float = 1) -> [Float] {
        [Float(size.width), Float(size.height), time, flow, f.motion, seed, alpha,
         palette, paletteTo, paletteMix, grain, clamp(f.level * intensity)]
        + f.bands.map { clamp($0 * intensity) }
        + [f.centroid, f.noise, f.flux, f.kick, f.snare, f.hat, f.pulse, f.beat,
           f.beatTime, f.dynamics, f.swell, f.silence, Float(historyRow)]
    }

    static func texture(device: MTLDevice, height: Int) -> MTLTexture {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r32Float, width: 256, height: height, mipmapped: false)
        descriptor.storageMode = .shared
        descriptor.usage = .shaderRead
        return device.makeTexture(descriptor: descriptor)!
    }
}

@MainActor
final class MetalRenderer: NSObject, MTKViewDelegate {
    private let instrument: Instrument
    private let queue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    private let available = DispatchSemaphore(value: 3)
    private var spectra: [MTLTexture]
    private var histories: [MTLTexture]
    private var slot = 0
    private var history = [Float](repeating: 0, count: 256 * 256)
    private var historyRow = 0
    private var historyCarry: Float = 0
    private var last = CACurrentMediaTime()
    private var time: Float = 0
    private var flow: Float = 0
    private var current = -1
    private var previous = -1
    private var fade: Float = 1
    private var palette: Float = 0
    private var paletteTo: Float = 0
    private var paletteMix: Float = 1
    private var frameAverage: Double = 1 / 60
    private var frameCount = 0
    private var resolution: Float = 1

    init(device: MTLDevice, instrument: Instrument) throws {
        self.instrument = instrument
        guard let queue = device.makeCommandQueue() else { throw SereinError.message("Metal could not create a render queue.") }
        self.queue = queue
        pipeline = try MetalSetup.pipeline(device: device)
        spectra = (0..<3).map { _ in MetalSetup.texture(device: device, height: 2) }
        histories = (0..<3).map { _ in MetalSetup.texture(device: device, height: 256) }
        palette = Float(instrument.palette); paletteTo = palette
        super.init()
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        let now = CACurrentMediaTime()
        let elapsed = now - last
        last = now
        guard view.window?.isVisible == true, !NSApp.isHidden else { return }
        let dt = Float(min(0.05, elapsed))
        time += dt
        let f = instrument.audio.source == .resting ? AudioFeatures.resting(at: time)
            : (instrument.audio.source == .file && !instrument.audio.isPlaying ? AudioFeatures() : instrument.audio.analyzer.snapshot())
        flow += dt * f.motion * instrument.speed
        frameAverage = frameAverage * 0.95 + min(elapsed, 0.1) * 0.05
        frameCount += 1
        if frameCount % 120 == 0 {
            if frameAverage > 0.023 { resolution = max(0.55, resolution - 0.1) }
            else if frameAverage < 0.018 { resolution = min(1, resolution + 0.04) }
        }
        let bounds = view.bounds.size
        guard bounds.width > 0, bounds.height > 0 else { return }
        let scale = min(view.window?.backingScaleFactor ?? 2,
                        sqrt(1_800_000 / (bounds.width * bounds.height))) * Double(resolution * instrument.quality)
        let size = CGSize(width: max(1, (bounds.width * scale).rounded()), height: max(1, (bounds.height * scale).rounded()))
        if view.drawableSize != size { view.drawableSize = size }
        guard available.wait(timeout: .now()) == .success else { return }
        guard let drawable = view.currentDrawable, let pass = view.currentRenderPassDescriptor,
              let command = queue.makeCommandBuffer(), let encoder = command.makeRenderCommandEncoder(descriptor: pass) else {
            available.signal(); return
        }
        if current != instrument.effect {
            previous = fade > 0.5 ? current : previous
            current = instrument.effect
            fade = previous < 0 ? 1 : 0
        }
        fade = min(1, fade + dt / 1.6)
        if paletteTo != Float(instrument.palette) {
            palette = paletteMix > 0.5 ? paletteTo : palette
            paletteTo = Float(instrument.palette); paletteMix = 0
        }
        paletteMix = min(1, paletteMix + dt / 1.6)
        let spectrum = f.spectrum + f.slow
        spectrum.withUnsafeBytes {
            spectra[slot].replace(region: MTLRegionMake2D(0, 0, 256, 2), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: 256 * 4)
        }
        historyCarry += dt
        while historyCarry >= 1 / 60 {
            historyCarry -= 1 / 60
            historyRow = (historyRow + 1) % 256
            history.replaceSubrange((historyRow * 256)..<((historyRow + 1) * 256), with: f.spectrum)
        }
        history.withUnsafeBytes {
            histories[slot].replace(region: MTLRegionMake2D(0, 0, 256, 256), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: 256 * 4)
        }
        encoder.setRenderPipelineState(pipeline)
        encoder.setFragmentTexture(spectra[slot], index: 0)
        encoder.setFragmentTexture(histories[slot], index: 1)
        var uniforms = MetalSetup.uniforms(size: size, time: time, flow: flow, seed: instrument.seed,
            palette: palette, paletteTo: paletteTo, paletteMix: paletteMix, grain: instrument.grain,
            features: f, historyRow: historyRow, intensity: instrument.intensity)
        func drawEffect(_ value: Int, alpha: Float) {
            var effect = Int32(value)
            uniforms[6] = alpha
            encoder.setFragmentBytes(&uniforms, length: uniforms.count * 4, index: 0)
            encoder.setFragmentBytes(&effect, length: 4, index: 1)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        }
        if previous >= 0 && fade < 1 { drawEffect(previous, alpha: 1) }
        drawEffect(current, alpha: fade * fade * (3 - 2 * fade))
        encoder.endEncoding()
        command.present(drawable)
        command.addCompletedHandler { [available] _ in available.signal() }
        slot = (slot + 1) % 3
        command.commit()
    }
}

struct MetalCanvas: NSViewRepresentable {
    let instrument: Instrument
    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var renderer: MetalRenderer? }
    func makeNSView(context: Context) -> MTKView {
        let view = MTKView()
        view.clearColor = MTLClearColorMake(0.008, 0.008, 0.012, 1)
        view.colorPixelFormat = .bgra8Unorm
        view.autoResizeDrawable = false
        view.preferredFramesPerSecond = 60
        view.framebufferOnly = true
        do {
            guard let device = MTLCreateSystemDefaultDevice() else { throw SereinError.message("Serein needs a Mac with Metal graphics support.") }
            view.device = device
            let renderer = try MetalRenderer(device: device, instrument: instrument)
            context.coordinator.renderer = renderer
            view.delegate = renderer
        } catch {
            DispatchQueue.main.async { instrument.rendererError = error.localizedDescription }
        }
        return view
    }
    func updateNSView(_ view: MTKView, context: Context) {}
    static func dismantleNSView(_ view: MTKView, coordinator: Coordinator) { view.isPaused = true; view.delegate = nil }
}
