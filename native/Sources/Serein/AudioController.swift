import AppKit
import AVFoundation
import ScreenCaptureKit
import UniformTypeIdentifiers

enum AudioSource: String { case resting = "Resting", system = "System", file = "File" }

enum SereinError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

final class CaptureSink: NSObject, SCStreamOutput, SCStreamDelegate {
    let analyzer: AudioAnalyzer
    let onError: (Error) -> Void
    init(analyzer: AudioAnalyzer, onError: @escaping (Error) -> Void) {
        self.analyzer = analyzer; self.onError = onError
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) { onError(error) }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid,
              let description = sampleBuffer.formatDescription else { return }
        let format = AVAudioFormat(cmAudioFormatDescription: description)
        var needed = 0
        CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sampleBuffer, bufferListSizeNeededOut: &needed,
            bufferListOut: nil, bufferListSize: 0, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: 0, blockBufferOut: nil)
        guard needed > 0 else { return }
        let storage = UnsafeMutableRawPointer.allocate(byteCount: needed, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { storage.deallocate() }
        let list = storage.bindMemory(to: AudioBufferList.self, capacity: 1)
        var block: CMBlockBuffer?
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sampleBuffer, bufferListSizeNeededOut: nil,
            bufferListOut: list, bufferListSize: needed, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment), blockBufferOut: &block) == noErr,
              let pcm = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: list) else { return }
        analyzer.consume(Self.mono(pcm), sampleRate: format.sampleRate)
        withExtendedLifetime(block) {}
    }

    static func mono(_ buffer: AVAudioPCMBuffer) -> [Float] {
        let frames = Int(buffer.frameLength), channels = Int(buffer.format.channelCount)
        guard frames > 0, channels > 0, let data = buffer.floatChannelData else { return [] }
        var samples = [Float](repeating: 0, count: frames)
        for frame in 0..<frames {
            for channel in 0..<channels {
                samples[frame] += buffer.format.isInterleaved ? data[0][frame * channels + channel] : data[channel][frame]
            }
            samples[frame] /= Float(channels)
        }
        return samples
    }
}

@MainActor
final class AudioController: ObservableObject {
    @Published private(set) var source: AudioSource = .resting
    @Published private(set) var busy = false
    @Published private(set) var isPlaying = false
    @Published private(set) var title = "A listening instrument"
    @Published private(set) var subtitle = "Play Spotify, then choose System audio."
    @Published var error: String?
    private(set) var analyzer = AudioAnalyzer()
    private(set) var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var file: AVAudioFile?
    private var stream: SCStream?
    private var sink: CaptureSink?
    private let queue = DispatchQueue(label: "pt.serein.audio", qos: .userInitiated)
    private var scopedURL: URL?
    private var generation = UUID()
    private var fileEnded = false
    private var pausedPosition: Double = 0
    /// Where in the file the current schedule starts, in frames.
    private var segmentStart: AVAudioFramePosition = 0
    /// Identifies the current schedule: stopping a player completes the one
    /// before it, and that completion must not read as the file ending.
    private var scheduled = 0
    private var outputObserver: NSObjectProtocol?
    /// The playhead on the wall clock since playback last started. The engine
    /// reports no render time once it has stopped, which it has by the time an
    /// output change is announced; without this the file restarted from zero.
    private var anchor: (at: CFTimeInterval, position: Double)?

    var duration: Double { file.map { Double($0.length) / $0.processingFormat.sampleRate } ?? 0 }
    var position: Double {
        if fileEnded { return duration }
        if source == .file && !isPlaying { return pausedPosition }
        guard let player, let file, let time = player.lastRenderTime, let value = player.playerTime(forNodeTime: time) else {
            return anchor.map { min(duration, $0.position + CACurrentMediaTime() - $0.at) } ?? 0
        }
        return min(duration, Double(segmentStart) / file.processingFormat.sampleRate + Double(value.sampleTime) / value.sampleRate)
    }

    func start(_ requested: AudioSource, url: URL? = nil) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        await release()
        error = nil
        let currentAnalyzer = AudioAnalyzer()
        analyzer = currentAnalyzer
        do {
            switch requested {
            case .resting: return
            case .system:
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first else { throw SereinError.message("No display is available for system audio capture.") }
                let ownApps = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
                let filter = SCContentFilter(display: display, excludingApplications: ownApps, exceptingWindows: [])
                let config = SCStreamConfiguration()
                config.capturesAudio = true
                config.excludesCurrentProcessAudio = true
                config.sampleRate = 48000; config.channelCount = 2
                config.width = 2; config.height = 2
                config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
                let token = generation
                let sink = CaptureSink(analyzer: currentAnalyzer) { [weak self] error in
                    Task { @MainActor in
                        guard let self, self.generation == token else { return }
                        await self.release()
                        self.error = "System audio stopped: \(error.localizedDescription)"
                    }
                }
                let stream = SCStream(filter: filter, configuration: config, delegate: sink)
                try stream.addStreamOutput(sink, type: .audio, sampleHandlerQueue: queue)
                // ScreenCaptureKit still produces its minimal video stream.
                // The sink immediately ignores these frames; registering it
                // avoids a framework error being logged every second.
                try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: queue)
                self.sink = sink; self.stream = stream
                try await stream.startCapture()
                title = "Listening to your Mac"; subtitle = "System audio · synced to what your Mac plays"
            case .file:
                guard let url else { return }
                if url.startAccessingSecurityScopedResource() { scopedURL = url }
                let file = try AVAudioFile(forReading: url)
                guard file.length > 0 else { throw SereinError.message("This audio file is empty.") }
                let engine = AVAudioEngine(), player = AVAudioPlayerNode()
                engine.attach(player)
                engine.connect(player, to: engine.mainMixerNode, format: file.processingFormat)
                let format = file.processingFormat
                player.installTap(onBus: 0, bufferSize: 2048, format: format) { [queue] buffer, _ in
                    let samples = CaptureSink.mono(buffer)
                    queue.async { currentAnalyzer.consume(samples, sampleRate: format.sampleRate) }
                }
                self.engine = engine; self.player = player; self.file = file
                fileEnded = false
                schedule()
                outputObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange,
                                                                        object: engine, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.outputChanged() }
                }
                try engine.start()
                player.play()
                anchor = (CACurrentMediaTime(), 0)
                let parts = url.deletingPathExtension().lastPathComponent.components(separatedBy: " - ")
                title = parts.count > 1 ? parts.dropFirst().joined(separator: " - ") : parts[0]
                subtitle = parts.count > 1 ? parts[0] : url.pathExtension.uppercased() + " · local audio"
            }
            source = requested; isPlaying = true
        } catch {
            await release()
            self.error = requested == .system
                ? "System audio could not start. Allow Serein in System Settings → Privacy & Security → Screen & System Audio Recording, then try again.\n\n\(error.localizedDescription)"
                : error.localizedDescription
        }
    }

    private func schedule(from frame: AVAudioFramePosition = 0) {
        guard let player, let file, frame < file.length else { return }
        segmentStart = frame
        scheduled += 1
        let token = generation, id = scheduled
        player.scheduleSegment(file, startingFrame: frame, frameCount: AVAudioFrameCount(file.length - frame),
                               at: nil, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.generation == token, self.scheduled == id else { return }
                self.anchor = nil
                self.isPlaying = false
                self.fileEnded = true
                self.player?.stop()
            }
        }
    }

    func togglePlayback() {
        guard source == .file, let engine, let player else { return }
        if isPlaying { pausedPosition = position; player.pause(); isPlaying = false; anchor = nil }
        else {
            // A player started on a stopped engine raises, and the app with it.
            if !engine.isRunning {
                do { try engine.start() } catch { self.error = error.localizedDescription; return }
            }
            let from = fileEnded ? 0 : pausedPosition
            if fileEnded { fileEnded = false; schedule() }
            player.play(); isPlaying = true
            anchor = (CACurrentMediaTime(), from)
        }
    }

    /// A change of output device — headphones, AirPods, a display's speakers —
    /// stops the engine. Unhandled, the file fell silent while the interface
    /// still showed it playing, and the next play crashed on the stopped engine.
    /// Pick up from the same place on whatever the output now is.
    func outputChanged() {
        guard source == .file, let engine, let player, let file else { return }
        let resume = isPlaying
        let frame = AVAudioFramePosition(position * file.processingFormat.sampleRate)
        player.stop()
        if !fileEnded { schedule(from: min(frame, file.length - 1)) }
        do { try engine.start() } catch {
            isPlaying = false
            self.error = "The audio output changed and playback could not resume.\n\n\(error.localizedDescription)"
            return
        }
        if resume {
            player.play()
            anchor = (CACurrentMediaTime(), Double(segmentStart) / file.processingFormat.sampleRate)
        }
    }

    func openFile() {
        guard !busy else { return }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.audio]
        panel.allowsMultipleSelection = false
        panel.canChooseDirectories = false
        panel.prompt = "Listen"
        panel.begin { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            Task { @MainActor in await self?.start(.file, url: url) }
        }
    }

    private func release() async {
        generation = UUID()
        if let outputObserver { NotificationCenter.default.removeObserver(outputObserver) }
        outputObserver = nil
        let oldStream = stream
        stream = nil; sink = nil
        player?.stop(); engine?.stop()
        engine = nil; player = nil; file = nil
        fileEnded = false
        pausedPosition = 0
        segmentStart = 0
        anchor = nil
        if let url = scopedURL { url.stopAccessingSecurityScopedResource(); scopedURL = nil }
        source = .resting; isPlaying = false
        title = "A listening instrument"; subtitle = "Play Spotify, then choose System audio."
        if let oldStream { try? await oldStream.stopCapture() }
    }
}
