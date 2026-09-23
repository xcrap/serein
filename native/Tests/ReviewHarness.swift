import XCTest
import AVFoundation
import Metal
import AppKit
@testable import Serein

/// Renders effects as real music drives them, without a speaker or a window:
/// the file is decoded, fed through the real analyser and feature stream at
/// 60 frames a second, and chosen moments are drawn offscreen.
///
///     SEREIN_REVIEW=/tmp/review SEREIN_AUDIO=song.mp3 swift test --filter ReviewHarness
///
/// Optional: SEREIN_EFFECTS=Corona,Wick  SEREIN_AT=20,45.5,80  SEREIN_PALETTE=3
/// SEREIN_SEED=2.618  SEREIN_SIZE=640x360
///
/// Writes one contact sheet per effect, `<Effect>-beat.png` (a lull beside the
/// hardest kick), `<Effect>-section.png` (the quietest passage beside the
/// fullest), and `metrics.txt`: brightness, how much
/// changes frame to frame, how often motion turns back on itself (continuous
/// flow scores 0), and whether the picture depends on the beat counter, which
/// only things reborn each beat may read.
final class ReviewHarness: XCTestCase {
    struct Moment { let time: Float; let flow: Float; let features: AudioFeatures }

    func testReviewWithRealMusic() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let directory = env["SEREIN_REVIEW"], let audioPath = env["SEREIN_AUDIO"] else {
            throw XCTSkip("Set SEREIN_REVIEW and SEREIN_AUDIO to review effects against real music")
        }
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let moments = try listen(to: URL(fileURLWithPath: audioPath))
        let duration = Float(moments.count) / 60
        let times = env["SEREIN_AT"]?.split(separator: ",").compactMap { Float($0) }
            ?? (1...9).map { duration * Float($0) / 10 }
        let names = env["SEREIN_EFFECTS"]?.split(separator: ",").map { $0.lowercased() }
        let effects = Effect.all.filter { names?.contains($0.name.lowercased()) ?? true }
        let palette = Float(env["SEREIN_PALETTE"].flatMap(Int.init) ?? 0)
        let seed = env["SEREIN_SEED"].flatMap(Float.init) ?? 2.618
        let tile = env["SEREIN_SIZE"]?.split(separator: "x").compactMap { Int($0) } ?? [640, 360]
        let renderer = try await Offscreen(palette: palette, seed: seed)

        var report = ["audio: \(URL(fileURLWithPath: audioPath).lastPathComponent), \(Int(duration)) s, palette \(Int(palette)), seed \(seed)"]
        for effect in effects {
            // Stills, into one contact sheet.
            let columns = min(3, times.count), rows = (times.count + columns - 1) / columns
            var sheet = [UInt8](repeating: 0, count: tile[0] * columns * tile[1] * rows * 4)
            var luma = [Float]()
            for (index, time) in times.enumerated() {
                let moment = moments[min(moments.count - 1, max(0, Int(time * 60)))]
                let image = try renderer.draw(effect.id, moment.features, time: moment.time, flow: moment.flow, width: tile[0], height: tile[1])
                XCTAssertTrue(image.finite, "\(effect.name) at \(time) s: NaN or infinity")
                luma.append(image.luma)
                let x0 = (index % columns) * tile[0], y0 = (index / columns) * tile[1]
                for y in 0..<tile[1] {
                    let from = y * tile[0] * 4, to = ((y0 + y) * tile[0] * columns + x0) * 4
                    sheet.replaceSubrange(to..<(to + tile[0] * 4), with: image.pixels[from..<(from + tile[0] * 4)])
                }
            }
            try Offscreen.png(sheet, width: tile[0] * columns, height: tile[1] * rows)
                .write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(effect.name).png"))

            // Motion, over three seconds from the middle of the piece.
            let start = moments.count / 2
            var frames = [[UInt8]]()
            for k in stride(from: 0, to: 180, by: 2) {
                let m = moments[min(moments.count - 1, start + k)]
                frames.append(try renderer.draw(effect.id, m.features, time: m.time, flow: m.flow, width: 240, height: 136).pixels)
            }
            func difference(_ a: [UInt8], _ b: [UInt8]) -> Float {
                var sum = 0
                for i in stride(from: 0, to: a.count, by: 4) {
                    sum += abs(Int(a[i]) - Int(b[i])) + abs(Int(a[i + 1]) - Int(b[i + 1])) + abs(Int(a[i + 2]) - Int(b[i + 2]))
                }
                return Float(sum) / Float(a.count / 4 * 3)
            }
            let change = zip(frames, frames.dropFirst()).map(difference).reduce(0, +) / Float(frames.count - 1)
            let away = frames.map { difference(frames[0], $0) }
            var reversals = 0, peak: Float = 0, falling = false
            for d in away {
                if d > peak { peak = d; falling = false }
                else if !falling && d < peak * 0.85 && peak > 0.5 { reversals += 1; falling = true; peak = d }
            }

            // The beat you can see: the hardest kick in the middle of the piece,
            // beside the quietest moment in the half second before it.
            let window = start..<min(moments.count, start + 900)
            let hit = window.max { moments[$0].features.kick < moments[$1].features.kick } ?? start
            let lull = (max(0, hit - 30)..<max(1, hit - 3)).min { moments[$0].features.kick < moments[$1].features.kick } ?? hit
            var pair = [UInt8](repeating: 0, count: tile[0] * 2 * tile[1] * 4)
            for (column, index) in [lull, hit].enumerated() {
                let m = moments[index]
                let image = try renderer.draw(effect.id, m.features, time: m.time, flow: m.flow, width: tile[0], height: tile[1])
                for y in 0..<tile[1] {
                    let from = y * tile[0] * 4, to = (y * tile[0] * 2 + column * tile[0]) * 4
                    pair.replaceSubrange(to..<(to + tile[0] * 4), with: image.pixels[from..<(from + tile[0] * 4)])
                }
            }
            try Offscreen.png(pair, width: tile[0] * 2, height: tile[1])
                .write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(effect.name)-beat.png"))

            // A section you can see: the quietest passage beside the fullest.
            let middle = (moments.count / 10)..<max(moments.count / 10 + 1, moments.count * 9 / 10)
            let calm = middle.min { moments[$0].features.section < moments[$1].features.section } ?? start
            let full = middle.max { moments[$0].features.section < moments[$1].features.section } ?? start
            var sections = [UInt8](repeating: 0, count: tile[0] * 2 * tile[1] * 4)
            for (column, index) in [calm, full].enumerated() {
                let m = moments[index]
                let image = try renderer.draw(effect.id, m.features, time: m.time, flow: m.flow, width: tile[0], height: tile[1])
                for y in 0..<tile[1] {
                    let from = y * tile[0] * 4, to = (y * tile[0] * 2 + column * tile[0]) * 4
                    sections.replaceSubrange(to..<(to + tile[0] * 4), with: image.pixels[from..<(from + tile[0] * 4)])
                }
            }
            try Offscreen.png(sections, width: tile[0] * 2, height: tile[1])
                .write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(effect.name)-section.png"))

            // The beat counter is a tempo estimate: shift it and see what moves.
            let m = moments[start]
            var shifted = m.features
            shifted.beatTime += 1.5
            let a = try renderer.draw(effect.id, m.features, time: m.time, flow: m.flow, width: 240, height: 136).pixels
            let b = try renderer.draw(effect.id, shifted, time: m.time, flow: m.flow, width: 240, height: 136).pixels
            report.append(String(format: "%@ luma mean %.3f min %.3f max %.3f · change/frame %.2f · reversals %d · beat-counter dependence %.2f",
                effect.name.padding(toLength: 12, withPad: " ", startingAt: 0), luma.reduce(0, +) / Float(luma.count),
                luma.min() ?? 0, luma.max() ?? 0, change / 2, reversals, difference(a, b)))
        }
        let text = report.joined(separator: "\n") + "\n"
        try text.write(toFile: directory + "/metrics.txt", atomically: true, encoding: .utf8)
        print(text)
    }

    /// How visibly each effect answers the music, as numbers: how much the
    /// frame brightens on a kick, a snare and a hat against the moment before,
    /// and how much brighter the song's full passages are than its quiet ones.
    ///
    ///     SEREIN_RESPONSE=1 SEREIN_AUDIO=song.mp3 swift test --filter testResponse
    func testResponse() async throws {
        let env = ProcessInfo.processInfo.environment
        guard env["SEREIN_RESPONSE"] != nil, let audioPath = env["SEREIN_AUDIO"] else { throw XCTSkip("Set SEREIN_RESPONSE and SEREIN_AUDIO") }
        let moments = try listen(to: URL(fileURLWithPath: audioPath))
        let names = env["SEREIN_EFFECTS"]?.split(separator: ",").map { $0.lowercased() }
        let renderer = try await Offscreen(palette: 0, seed: 2.618)
        var lines = ["effect        kick lift  snare lift  hat lift   full/quiet"]
        for effect in Effect.all where names?.contains(effect.name.lowercased()) ?? true {
            var luma = [Float](), kick = [Float](), snare = [Float](), hat = [Float](), section = [Float]()
            for index in stride(from: 0, to: moments.count, by: 2) {
                let m = moments[index]
                luma.append(try renderer.draw(effect.id, m.features, time: m.time, flow: m.flow, width: 192, height: 108).luma)
                kick.append(m.features.kick); snare.append(m.features.snare); hat.append(m.features.hat); section.append(m.features.section)
            }
            func lift(_ envelope: [Float]) -> String {
                var sum: Float = 0, count: Float = 0
                for i in 4..<(envelope.count - 2) where envelope[i] > 0.6 && envelope[i - 1] <= 0.6 {
                    sum += (luma[i + 1] - luma[i - 3]) / max(luma[i - 3], 0.002); count += 1
                }
                return count > 0 ? String(format: "%+7.0f%%", sum / count * 100) : "     n/a"
            }
            let order = section.indices.sorted { section[$0] < section[$1] }
            let quarter = order.count / 4
            let quiet = order.prefix(quarter).map { luma[$0] }.reduce(0, +) / Float(max(quarter, 1))
            let full = order.suffix(quarter).map { luma[$0] }.reduce(0, +) / Float(max(quarter, 1))
            lines.append(effect.name.padding(toLength: 12, withPad: " ", startingAt: 0)
                + "  " + lift(kick) + "    " + lift(snare) + "   " + lift(hat) + String(format: "     %5.2fx", full / max(quiet, 0.0005)))
        }
        print("\n" + lines.joined(separator: "\n") + "\n")
    }

    /// A stretch of one effect as raw frames, for ffmpeg to join with the song.
    ///
    ///     SEREIN_VIDEO=/tmp/wick.rgba SEREIN_EFFECTS=Wick SEREIN_FROM=90 SEREIN_SECONDS=30 \
    ///       SEREIN_AUDIO=song.mp3 swift test --filter testVideo
    func testVideo() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let output = env["SEREIN_VIDEO"], let audioPath = env["SEREIN_AUDIO"],
              let name = env["SEREIN_EFFECTS"]?.lowercased(),
              let effect = Effect.all.first(where: { $0.name.lowercased() == name }) else { throw XCTSkip("Set SEREIN_VIDEO, SEREIN_AUDIO, SEREIN_EFFECTS") }
        let moments = try listen(to: URL(fileURLWithPath: audioPath))
        let from = Int((env["SEREIN_FROM"].flatMap(Float.init) ?? 0) * 60)
        let count = Int((env["SEREIN_SECONDS"].flatMap(Float.init) ?? 20) * 60)
        let tile = env["SEREIN_SIZE"]?.split(separator: "x").compactMap { Int($0) } ?? [960, 540]
        let renderer = try await Offscreen(palette: Float(env["SEREIN_PALETTE"].flatMap(Int.init) ?? 0), seed: 2.618)
        FileManager.default.createFile(atPath: output, contents: nil)
        let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: output))
        defer { try? handle.close() }
        // 30 frames a second, from the 60 Hz stream.
        for index in stride(from: from, to: min(moments.count, from + count), by: 2) {
            let m = moments[index]
            try handle.write(contentsOf: Data(try renderer.draw(effect.id, m.features, time: m.time, flow: m.flow, width: tile[0], height: tile[1]).pixels))
        }
    }

    /// The file, as the analyser and feature stream would have heard it at 60 Hz.
    func listen(to url: URL) throws -> [Moment] {
        let file = try AVAudioFile(forReading: url)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)))
        try file.read(into: buffer)
        let samples = CaptureSink.mono(buffer)
        let rate = file.processingFormat.sampleRate
        let analyzer = AudioAnalyzer()
        var stream = FeatureStream()
        var moments = [Moment]()
        var fed = 0
        var flow: Float = 0
        for frame in 0..<Int(Double(samples.count) / rate * 60) {
            let now = Double(frame) / 60
            let due = min(samples.count, Int(now * rate))
            while fed < due {
                let count = min(1024, due - fed)
                analyzer.consume(Array(samples[fed..<(fed + count)]), sampleRate: rate)
                fed += count
            }
            var raw = analyzer.snapshot()
            raw.stamp = now
            let f = stream.next(raw, from: .live(ObjectIdentifier(analyzer)), now: now, dt: 1 / 60)
            flow += f.motion / 60
            moments.append(Moment(time: Float(now), flow: flow, features: f))
        }
        return moments
    }
}

/// Draws one effect into memory with the app's own pipelines.
final class Offscreen {
    struct Image { let pixels: [UInt8]; let luma: Float; let finite: Bool }
    let device: MTLDevice
    let queue: MTLCommandQueue
    let pipelines: [MTLRenderPipelineState]
    let spectrum: MTLTexture
    let history: MTLTexture
    let palette: Float
    let seed: Float

    init(palette: Float, seed: Float) async throws {
        device = try XCTUnwrap(MTLCreateSystemDefaultDevice())
        queue = try XCTUnwrap(device.makeCommandQueue())
        pipelines = try await MetalSetup.pipelines(device: device, format: .rgba16Float)
        spectrum = MetalSetup.texture(device: device, height: 2)
        history = MetalSetup.texture(device: device, height: 256)
        self.palette = palette; self.seed = seed
    }

    func draw(_ effect: Int, _ f: AudioFeatures, time: Float, flow: Float, width: Int, height: Int) throws -> Image {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba16Float, width: width, height: height, mipmapped: false)
        descriptor.usage = [.renderTarget]; descriptor.storageMode = .shared
        let output = try XCTUnwrap(device.makeTexture(descriptor: descriptor))
        (f.spectrum + f.slow).withUnsafeBytes { spectrum.replace(region: MTLRegionMake2D(0, 0, 256, 2), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: 1024) }
        Array(repeating: f.spectrum, count: 256).flatMap { $0 }.withUnsafeBytes {
            history.replace(region: MTLRegionMake2D(0, 0, 256, 256), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: 1024)
        }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = output
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].storeAction = .store
        let command = try XCTUnwrap(queue.makeCommandBuffer())
        let encoder = try XCTUnwrap(command.makeRenderCommandEncoder(descriptor: pass))
        var uniforms = MetalSetup.uniforms(size: CGSize(width: width, height: height), time: time, flow: flow, seed: seed,
            palette: palette, paletteTo: palette, paletteMix: 1, grain: 0.65, features: f, historyRow: 255)
        MetalSetup.encode(encoder, pipelines: pipelines, effect: effect, uniforms: &uniforms)
        encoder.setFragmentTexture(spectrum, index: 0); encoder.setFragmentTexture(history, index: 1)
        encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        encoder.endEncoding(); command.commit(); command.waitUntilCompleted()
        var half = [Float16](repeating: 0, count: width * height * 4)
        half.withUnsafeMutableBytes { output.getBytes($0.baseAddress!, bytesPerRow: width * 8, from: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0) }
        var pixels = [UInt8](repeating: 255, count: width * height * 4)
        var luma: Float = 0
        var finite = true
        for y in 0..<height {
            for x in 0..<width {
                let from = (y * width + x) * 4, to = from
                for c in 0..<3 {
                    let v = Float(half[from + c])
                    if !v.isFinite { finite = false }
                    pixels[to + c] = UInt8(clamp(v) * 255)
                }
                luma += 0.2126 * Float(pixels[to]) + 0.7152 * Float(pixels[to + 1]) + 0.0722 * Float(pixels[to + 2])
            }
        }
        return Image(pixels: pixels, luma: luma / Float(width * height) / 255, finite: finite)
    }

    static func png(_ pixels: [UInt8], width: Int, height: Int) throws -> Data {
        let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: width * 4, bitsPerPixel: 32))
        pixels.withUnsafeBytes { bitmap.bitmapData!.update(from: $0.baseAddress!.assumingMemoryBound(to: UInt8.self), count: pixels.count) }
        return try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
    }
}
