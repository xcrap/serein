import MetalKit
import SwiftUI

enum MetalSetup {
    static func library(device: MTLDevice) throws -> MTLLibrary {
        // The packaged app ships its effects precompiled, which takes compiling
        // the source out of every cold launch. Development builds compile it.
        if let url = Bundle.main.url(forResource: "Effects", withExtension: "metallib"),
           let library = try? device.makeLibrary(URL: url) { return library }
        guard let url = Bundle.main.url(forResource: "Effects", withExtension: "metal")
            ?? Bundle.module.url(forResource: "Effects", withExtension: "metal", subdirectory: "Resources") else {
            throw SereinError.message("The Metal effects resource is missing. Rebuild Serein with scripts/build-macos.sh.")
        }
        return try device.makeLibrary(source: String(contentsOf: url, encoding: .utf8), options: nil)
    }

    /// One pipeline per effect, each specialised on its function constant so it
    /// carries only its own effect's code and register pressure. They compile
    /// concurrently.
    static func pipelines(device: MTLDevice, format: MTLPixelFormat = .bgra8Unorm) async throws -> [MTLRenderPipelineState] {
        let library = try library(device: device)
        return try await withThrowingTaskGroup(of: (Int, MTLRenderPipelineState).self) { group in
            for index in Effect.all.indices {
                group.addTask {
                    let constants = MTLFunctionConstantValues()
                    var effect = Int32(index)
                    constants.setConstantValue(&effect, type: .int, index: 0)
                    let descriptor = MTLRenderPipelineDescriptor()
                    descriptor.vertexFunction = library.makeFunction(name: "fullScreen")
                    descriptor.fragmentFunction = try await library.makeFunction(name: "visualizer", constantValues: constants)
                    let color = descriptor.colorAttachments[0]!
                    color.pixelFormat = format
                    color.isBlendingEnabled = true
                    color.sourceRGBBlendFactor = .sourceAlpha
                    color.destinationRGBBlendFactor = .oneMinusSourceAlpha
                    color.sourceAlphaBlendFactor = .one
                    color.destinationAlphaBlendFactor = .oneMinusSourceAlpha
                    return (index, try await device.makeRenderPipelineState(descriptor: descriptor))
                }
            }
            var states = [MTLRenderPipelineState?](repeating: nil, count: Effect.all.count)
            for try await (index, state) in group { states[index] = state }
            return states.compactMap { $0 }
        }
    }

    static func encode(_ encoder: MTLRenderCommandEncoder, pipelines: [MTLRenderPipelineState], effect: Int, uniforms: inout [Float]) {
        encoder.setRenderPipelineState(pipelines[effect])
        encoder.setFragmentBytes(&uniforms, length: uniforms.count * 4, index: 0)
    }

    static func uniforms(size: CGSize, time: Float, flow: Float, seed: Float, palette: Float,
                         paletteTo: Float, paletteMix: Float, grain: Float, features f: AudioFeatures,
                         historyRow: Int, intensity: Float = 1, alpha: Float = 1) -> [Float] {
        [Float(size.width), Float(size.height), time, flow, f.motion, seed, alpha,
         palette, paletteTo, paletteMix, grain, clamp(f.level * intensity)]
        + f.bands.map { clamp($0 * intensity) }
        + [f.centroid, f.noise, f.flux, f.kick, f.snare, f.hat, f.pulse, f.beat,
           f.beatTime, f.dynamics, f.swell, f.silence, f.section, Float(historyRow)]
    }

    static func texture(device: MTLDevice, height: Int) -> MTLTexture {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .r32Float, width: 256, height: height, mipmapped: false)
        descriptor.storageMode = .shared
        descriptor.usage = .shaderRead
        return device.makeTexture(descriptor: descriptor)!
    }
}

/// GPU time per frame, written from Metal's completion thread.
private final class GPUClock: @unchecked Sendable {
    private let lock = NSLock()
    private var average: Double = 0.008
    func record(_ seconds: Double) { lock.lock(); average = average * 0.92 + seconds * 0.08; lock.unlock() }
    var seconds: Double { lock.lock(); defer { lock.unlock() }; return average }
}

@MainActor
final class MetalRenderer: NSObject, MTKViewDelegate {
    private let instrument: Instrument
    private let queue: MTLCommandQueue
    private var pipelines: [MTLRenderPipelineState] = []
    private let available = DispatchSemaphore(value: 3)
    private let gpu = GPUClock()
    private var spectra: [MTLTexture]
    private var histories: [MTLTexture]
    /// History rows already copied into each slot's texture.
    private var synced = [Int](repeating: 0, count: 3)
    private var slot = 0
    private var history = [Float](repeating: 0, count: 256 * 256)
    /// History rows recorded since launch; the newest is at `(written - 1) % 256`.
    private var written = 0
    private var historyCarry: Float = 0
    private var stream = FeatureStream()
    private var last = CACurrentMediaTime()
    private var time: Float = 0
    private var flow: Float = 0
    /// Effects on screen, oldest first. A change mid-dissolve starts a new
    /// dissolve over whatever is showing, instead of cutting a layer out.
    private var layers: [(effect: Int, fade: Float)] = []
    private var palette: Float = 0
    private var paletteTo: Float = 0
    private var paletteMix: Float = 1
    private var frameCount = 0
    private var resolution: Float = 1

    init(device: MTLDevice, instrument: Instrument) throws {
        self.instrument = instrument
        guard let queue = device.makeCommandQueue() else { throw SereinError.message("Metal could not create a render queue.") }
        self.queue = queue
        spectra = (0..<3).map { _ in MetalSetup.texture(device: device, height: 2) }
        let histories = (0..<3).map { _ in MetalSetup.texture(device: device, height: 256) }
        // Rows are copied in as they are recorded; a new texture's contents are undefined.
        let zeros = [Float](repeating: 0, count: 256 * 256)
        for texture in histories {
            texture.replace(region: MTLRegionMake2D(0, 0, 256, 256), mipmapLevel: 0, withBytes: zeros, bytesPerRow: 1024)
        }
        self.histories = histories
        palette = Float(instrument.palette); paletteTo = palette
        super.init()
        // Compiling every effect takes a moment on a first launch, and the
        // window should not wait for it. Nothing is drawn until they are ready.
        Task { [weak self] in
            do {
                self?.pipelines = try await MetalSetup.pipelines(device: device)
            } catch {
                instrument.rendererError = error.localizedDescription
            }
        }
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        let now = CACurrentMediaTime()
        let elapsed = now - last
        last = now
        // Covered, on another Space, minimised or hidden: nobody can see it.
        guard !pipelines.isEmpty, let window = view.window, window.occlusionState.contains(.visible) else { return }
        let dt = Float(min(0.05, elapsed))
        time += dt
        let audio = instrument.audio
        var raw: AudioFeatures
        let origin: FeatureStream.Origin
        switch audio.source {
        case .resting:
            raw = .resting(at: time); raw.stamp = now; origin = .resting
        case .file where !audio.isPlaying:
            raw = AudioFeatures(); origin = .paused
        default:
            raw = audio.analyzer.snapshot(); origin = .live(ObjectIdentifier(audio.analyzer))
        }
        let f = stream.next(raw, from: origin, now: now, dt: dt)
        flow += dt * f.motion * instrument.speed

        if layers.last?.effect != instrument.effect { layers.append((instrument.effect, layers.isEmpty ? 1 : 0)) }
        for i in layers.indices { layers[i].fade = min(1, layers[i].fade + dt / 1.6) }
        if let opaque = layers.lastIndex(where: { $0.fade >= 1 }) { layers.removeFirst(opaque) }
        if layers.count > 3 { layers.removeFirst(layers.count - 3) }
        if paletteTo != Float(instrument.palette) {
            palette = paletteMix > 0.5 ? paletteTo : palette
            paletteTo = Float(instrument.palette); paletteMix = 0
        }
        paletteMix = min(1, paletteMix + dt / 1.6)
        historyCarry += dt
        while historyCarry >= 1 / 60 {
            historyCarry -= 1 / 60
            let row = written % 256
            history.replaceSubrange((row * 256)..<((row + 1) * 256), with: f.spectrum)
            written += 1
        }

        // Resolution follows the GPU's own frame time. The interval between
        // callbacks cannot show overload: the display link holds it at 16.7 ms
        // and a frame the GPU cannot take is simply skipped.
        frameCount += 1
        if frameCount % 90 == 0 {
            if gpu.seconds > 0.0125 { resolution = max(0.55, resolution - 0.08) }
            else if gpu.seconds < 0.007 { resolution = min(1, resolution + 0.04) }
        }
        let bounds = view.bounds.size
        guard bounds.width > 0, bounds.height > 0 else { return }
        let scale = min(window.backingScaleFactor, sqrt(1_800_000 / (bounds.width * bounds.height))) * Double(resolution * instrument.quality)
        let size = CGSize(width: max(1, (bounds.width * scale).rounded()), height: max(1, (bounds.height * scale).rounded()))
        if view.drawableSize != size { view.drawableSize = size }

        guard available.wait(timeout: .now()) == .success else { return }
        guard let drawable = view.currentDrawable, let pass = view.currentRenderPassDescriptor,
              let command = queue.makeCommandBuffer(), let encoder = command.makeRenderCommandEncoder(descriptor: pass) else {
            available.signal(); return
        }
        (f.spectrum + f.slow).withUnsafeBytes {
            spectra[slot].replace(region: MTLRegionMake2D(0, 0, 256, 2), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: 1024)
        }
        // Only the rows recorded since this slot was last used, normally three.
        history.withUnsafeBytes { rows in
            for n in max(synced[slot], written - 256)..<written {
                let row = n % 256
                histories[slot].replace(region: MTLRegionMake2D(0, row, 256, 1), mipmapLevel: 0,
                                        withBytes: rows.baseAddress! + row * 1024, bytesPerRow: 1024)
            }
        }
        synced[slot] = written
        encoder.setFragmentTexture(spectra[slot], index: 0)
        encoder.setFragmentTexture(histories[slot], index: 1)
        var uniforms = MetalSetup.uniforms(size: size, time: time, flow: flow, seed: instrument.seed,
            palette: palette, paletteTo: paletteTo, paletteMix: paletteMix, grain: instrument.grain,
            features: f, historyRow: (written + 255) % 256, intensity: instrument.intensity)
        for (index, layer) in layers.enumerated() {
            uniforms[6] = index == 0 ? 1 : layer.fade * layer.fade * (3 - 2 * layer.fade)
            MetalSetup.encode(encoder, pipelines: pipelines, effect: layer.effect, uniforms: &uniforms)
            encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        }
        encoder.endEncoding()
        command.present(drawable)
        command.addCompletedHandler { [available, gpu] buffer in
            if buffer.gpuEndTime > buffer.gpuStartTime { gpu.record(buffer.gpuEndTime - buffer.gpuStartTime) }
            available.signal()
        }
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
