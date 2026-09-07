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
}
