import XCTest
import AVFoundation
import ScreenCaptureKit
@testable import Serein

final class AudioAnalysisTests: XCTestCase {
    func testSilenceStaysSilentAndFinite() {
        let analyzer = AudioAnalyzer()
        analyzer.consume([Float](repeating: 0, count: 48000), sampleRate: 48000)
        let f = analyzer.snapshot()
        XCTAssertEqual(f.level, 0)
        XCTAssertEqual(f.spectrum.max(), 0)
        XCTAssertEqual(f.kick, 0)
        XCTAssertEqual(f.silence, 1)
        XCTAssertTrue(f.noise.isFinite && f.centroid.isFinite)
    }

    func testFFTLocatesToneAtDifferentSampleRatesAndCallbackSizes() {
        for rate in [44100.0, 48000.0, 96000.0] {
            let analyzer = AudioAnalyzer()
            let samples = (0..<Int(rate)).map { Float(sin(Double($0) * 2 * .pi * 1000 / rate)) * 0.3 }
            // Callbacks smaller than an FFT must accumulate without losing data.
            for start in stride(from: 0, to: samples.count, by: 511) {
                analyzer.consume(Array(samples[start..<min(samples.count, start + 511)]), sampleRate: rate)
            }
            let f = analyzer.snapshot()
            let peak = f.spectrum.indices.max { f.spectrum[$0] < f.spectrum[$1] }!
            let hz = 28 * pow(16000.0 / 28, Double(peak) / 256)
            XCTAssertEqual(hz, 1000, accuracy: 60, "FFT at \(rate) Hz")
            XCTAssertGreaterThan(f.level, 0.1)
            XCTAssertLessThan(f.noise, 0.2)
            XCTAssertTrue(f.spectrum.allSatisfy { $0.isFinite && $0 >= 0 && $0 <= 1 })
        }
    }

    func testTempoLocksTo120BPMAndNeverRunsBackwards() {
        var tempo = Tempo()
        var previous: Float = 0
        for frame in 0..<1200 {
            tempo.push(frame % 30 < 2 ? 1 : 0, dt: 1 / 60)
            XCTAssertGreaterThanOrEqual(tempo.count, previous)
            previous = tempo.count
        }
        XCTAssertEqual(60 / tempo.period, 120, accuracy: 3)
        XCTAssertGreaterThan(tempo.confidence, 0.5)
    }

    /// A drum pattern over a sustained chord and bass line: kicks on every
    /// beat at 120 BPM, snares on two and four, hats on the eighths. The first
    /// detector registered real kicks 0.04 times a second and hats never.
    func testDetectsKickSnareAndHatsOverSustainedMusic() {
        let rate: Float = 48000
        var samples = [Float](repeating: 0, count: Int(rate * 12))
        var noise: UInt32 = 7
        func random() -> Float { noise = noise &* 1664525 &+ 1013904223; return Float(noise >> 8) / Float(1 << 23) - 1 }
        for i in samples.indices {
            let t = Float(i) / rate
            // The music the drums sit in: a chord and a bass line.
            var v = 0.05 * (sin(2 * .pi * 220 * t) + sin(2 * .pi * 277 * t) + sin(2 * .pi * 330 * t))
            v += 0.08 * sin(2 * .pi * 55 * t)
            let beat = t.truncatingRemainder(dividingBy: 0.5)
            v += 0.6 * exp(-beat / 0.06) * sin(2 * .pi * (45 + 75 * exp(-beat / 0.03)) * beat)
            let bar = t.truncatingRemainder(dividingBy: 1.0)
            if bar >= 0.5 {
                let s = bar - 0.5
                v += 0.25 * exp(-s / 0.07) * (sin(2 * .pi * 1900 * s) + sin(2 * .pi * 2700 * s + 1) + sin(2 * .pi * 3600 * s + 2) + random())
            }
            let eighth = t.truncatingRemainder(dividingBy: 0.25)
            v += 0.08 * exp(-eighth / 0.025) * (sin(2 * .pi * 9100 * eighth) + sin(2 * .pi * 11300 * eighth + 1) + sin(2 * .pi * 13700 * eighth + 2))
            samples[i] = v
        }
        let analyzer = AudioAnalyzer()
        var previous: [Float] = [0, 0, 0]
        var hits: [Float] = [0, 0, 0]
        for start in stride(from: 0, to: samples.count, by: 512) {
            analyzer.consume(Array(samples[start..<min(samples.count, start + 512)]), sampleRate: Double(rate))
            let f = analyzer.snapshot()
            let now = [f.kick, f.snare, f.hat]
            if Float(start) / rate > 3 {
                for i in 0..<3 where now[i] > 0.6 && previous[i] <= 0.6 { hits[i] += 1 }
            }
            previous = now
        }
        let perSecond = hits.map { $0 / 9 }
        XCTAssertEqual(perSecond[0], 2, accuracy: 0.4, "kicks per second")
        XCTAssertEqual(perSecond[1], 1, accuracy: 0.3, "snares per second")
        XCTAssertEqual(perSecond[2], 4, accuracy: 0.8, "hats per second")
    }

    /// A quiet passage then a loud one: the section reads where each sits in
    /// the song, which loudness auto-gained over ten seconds cannot.
    func testSectionTellsAQuietPassageFromAFullOne() {
        let rate: Float = 48000
        let analyzer = AudioAnalyzer()
        func passage(_ amplitude: Float, seconds: Float) -> Float {
            let count = Int(rate * seconds)
            let tone = (0..<count).map { amplitude * sin(2 * .pi * 220 * Float($0) / rate) }
            for start in stride(from: 0, to: count, by: 1024) {
                analyzer.consume(Array(tone[start..<min(count, start + 1024)]), sampleRate: Double(rate))
            }
            return analyzer.snapshot().section
        }
        let quiet = passage(0.01, seconds: 20)
        let full = passage(0.25, seconds: 20)
        XCTAssertLessThan(quiet, 0.45, "a quiet opening reads as quiet")
        XCTAssertGreaterThan(full, 0.8, "the loud passage reads as full")
    }

    func testMonoDownmixForPlanarAndInterleavedStereo() {
        for interleaved in [false, true] {
            let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: interleaved)!
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8)!
            buffer.frameLength = 8
            for frame in 0..<8 {
                if interleaved { buffer.floatChannelData![0][frame * 2] = 0.4; buffer.floatChannelData![0][frame * 2 + 1] = 0.2 }
                else { buffer.floatChannelData![0][frame] = 0.4; buffer.floatChannelData![1][frame] = 0.2 }
            }
            XCTAssertEqual(CaptureSink.mono(buffer), [Float](repeating: 0.3, count: 8))
        }
    }

    func testFileDecodeFeedsAnalyzer() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".wav")
        defer { try? FileManager.default.removeItem(at: url) }
        let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8192)!
        buffer.frameLength = 8192
        for i in 0..<8192 { buffer.floatChannelData![0][i] = sin(Float(i) * 2 * .pi * 440 / 48000) * 0.3 }
        do { let file = try AVAudioFile(forWriting: url, settings: format.settings); try file.write(from: buffer) }
        let file = try AVAudioFile(forReading: url)
        let read = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 8192)!
        try file.read(into: read)
        let analyzer = AudioAnalyzer()
        analyzer.consume(CaptureSink.mono(read), sampleRate: file.processingFormat.sampleRate)
        XCTAssertGreaterThan(analyzer.snapshot().level, 0.1)
    }

    func testScreenCaptureAudioBufferReachesAnalyzer() throws {
        let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8192)!
        buffer.frameLength = 8192
        for i in 0..<8192 {
            let sample = sin(Float(i) * 2 * .pi * 440 / 48000) * 0.3
            buffer.floatChannelData![0][i] = sample
            buffer.floatChannelData![1][i] = sample
        }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48000), presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
        var sampleBuffer: CMSampleBuffer?
        XCTAssertEqual(CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: nil,
            formatDescription: format.formatDescription, sampleCount: 8192,
            sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 0,
            sampleSizeArray: nil, sampleBufferOut: &sampleBuffer), noErr)
        let sample = try XCTUnwrap(sampleBuffer)
        XCTAssertEqual(CMSampleBufferSetDataBufferFromAudioBufferList(sample,
            blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: 0, bufferList: buffer.audioBufferList), noErr)
        let analyzer = AudioAnalyzer()
        let sink = CaptureSink(analyzer: analyzer) { XCTFail($0.localizedDescription) }
        // The stream is not started: this validates ScreenCaptureKit's PCM
        // callback format without requesting capture permission or recording.
        let stream = SCStream(filter: SCContentFilter(), configuration: SCStreamConfiguration(), delegate: nil)
        sink.stream(stream, didOutputSampleBuffer: sample, of: .audio)
        XCTAssertGreaterThan(analyzer.snapshot().level, 0.1)
    }

    @MainActor func testNativePlaybackPauseResumeEndAndReplay() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".wav")
        defer { try? FileManager.default.removeItem(at: url) }
        let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
        let silence = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 12000)!
        silence.frameLength = 12000
        silence.floatChannelData![0].initialize(repeating: 0, count: 12000)
        do { let file = try AVAudioFile(forWriting: url, settings: format.settings); try file.write(from: silence) }
        let controller = AudioController()
        await controller.start(.file, url: url)
        XCTAssertNil(controller.error)
        XCTAssertEqual(controller.source, .file)
        try await Task.sleep(nanoseconds: 100_000_000)
        controller.togglePlayback()
        let paused = controller.position
        XCTAssertFalse(controller.isPlaying)
        XCTAssertGreaterThan(paused, 0)
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(controller.position, paused, accuracy: 0.001)
        controller.togglePlayback()
        XCTAssertTrue(controller.isPlaying)
        try await Task.sleep(nanoseconds: 500_000_000)
        XCTAssertFalse(controller.isPlaying)
        XCTAssertEqual(controller.position, controller.duration, accuracy: 0.001)
        controller.togglePlayback()
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(controller.isPlaying)
        XCTAssertGreaterThan(controller.position, 0)
        XCTAssertLessThan(controller.position, controller.duration)
        await controller.start(.resting)
        XCTAssertEqual(controller.source, .resting)
        XCTAssertFalse(controller.isPlaying)
    }

    /// Plugging in headphones stops the engine. Playback has to carry on from
    /// the same place, playing or paused, and a later play must not raise.
    @MainActor func testPlaybackSurvivesAnOutputChange() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".wav")
        defer { try? FileManager.default.removeItem(at: url) }
        let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 1)!
        let silence = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 96000)!
        silence.frameLength = 96000
        silence.floatChannelData![0].initialize(repeating: 0, count: 96000)
        do { let file = try AVAudioFile(forWriting: url, settings: format.settings); try file.write(from: silence) }
        let controller = AudioController()
        await controller.start(.file, url: url)
        try await Task.sleep(nanoseconds: 300_000_000)
        let before = controller.position
        // As the system does it: the engine stops, then the change is announced.
        controller.engine?.stop()
        NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: controller.engine)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertTrue(controller.isPlaying)
        XCTAssertTrue(controller.engine?.isRunning ?? false, "the engine restarts on the new output")
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(controller.position, before + 0.35, accuracy: 0.12, "playback resumes where it was")
        controller.togglePlayback()
        let paused = controller.position
        controller.engine?.stop()
        NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: controller.engine)
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertFalse(controller.isPlaying, "a paused file stays paused")
        XCTAssertEqual(controller.position, paused, accuracy: 0.001)
        controller.togglePlayback()
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertTrue(controller.isPlaying)
        XCTAssertEqual(controller.position, paused + 0.3, accuracy: 0.12)
        await controller.start(.resting)
    }
}
