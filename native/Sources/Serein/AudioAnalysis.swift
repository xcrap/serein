import Accelerate
import Foundation
import QuartzCore

func clamp(_ x: Float, _ low: Float = 0, _ high: Float = 1) -> Float { min(high, max(low, x)) }
func follow(_ current: Float, _ target: Float, _ dt: Float, _ attack: Float, _ release: Float) -> Float {
    current + (target - current) * (1 - exp(-dt / max(0.0001, target > current ? attack : release)))
}

struct AudioFeatures {
    var level: Float = 0
    var bands = [Float](repeating: 0, count: 6)
    var centroid: Float = 0.3
    var noise: Float = 0
    var flux: Float = 0
    var kick: Float = 0
    var snare: Float = 0
    var hat: Float = 0
    var pulse: Float = 0
    var beat: Float = 0
    var beatTime: Float = 0
    /// Beats per second the counter is advancing at, so the renderer can run
    /// its own counter at frame rate rather than stepping at the hop rate.
    var beatRate: Float = 0
    /// How sure the tempo estimate is, 0 .. 1. Pulse is weighted by it.
    var confidence: Float = 0
    /// When this snapshot was published, on the CACurrentMediaTime clock.
    var stamp: Double = 0
    var bpm: Float = 0
    var dynamics: Float = 0.5
    /// Where this part of the song sits in its own range over the last minute:
    /// 0 for its quietest passages, 1 for its fullest. A chorus against a verse,
    /// a drop against a breakdown.
    var section: Float = 0
    var swell: Float = 0
    var silence: Float = 1
    var motion: Float = 0.12
    var spectrum = [Float](repeating: 0, count: 256)
    var slow = [Float](repeating: 0, count: 256)

    static func resting(at time: Float) -> Self {
        var f = Self()
        let breath = 0.5 + 0.5 * sin(time * 0.055)
        f.level = 0.06 + breath * 0.04
        f.bands = [0.08, 0.09, 0.07, 0.06, 0.04, 0.03]
        f.swell = f.level
        f.section = 0.15
        f.beatRate = 1 / 7.5
        f.beatTime = time * f.beatRate
        f.beat = f.beatTime.truncatingRemainder(dividingBy: 1)
        for i in 0..<256 {
            let x = Float(i) / 256
            f.spectrum[i] = exp(-x * 2.4) * (0.5 + 0.5 * sin(x * 26 + time * 0.09)) * (0.16 + breath * 0.18)
        }
        f.slow = f.spectrum
        return f
    }
}

struct Gain {
    var ceiling: Float = 0.001
    var floor: Float = 0
    mutating func push(_ value: Float, dt: Float) -> Float {
        ceiling = follow(ceiling, value, dt, 0.12, 9)
        floor = follow(floor, value, dt, 16, 0.35)
        // Keep silence at zero even before the first real peak arrives.
        let span = max(0.03, ceiling - floor)
        return clamp((value - floor) / span)
    }
}

struct Tempo {
    var history = [Float](repeating: 0, count: 512)
    var write = 0
    var carry: Float = 0
    var elapsed: Float = 0
    var period: Float = 0.5
    var confidence: Float = 0
    var count: Float = 0
    var phase: Float = 0
    /// Beats per second. With no lock, run slowly rather than inventing a brisk tempo.
    var rate: Float { 1 / (confidence > 0.25 ? period : period * 2.4) }

    mutating func push(_ strength: Float, dt: Float) {
        carry += dt
        while carry >= 1 / 60 {
            carry -= 1 / 60
            history[write] = strength
            write = (write + 1) % 512
        }
        elapsed += dt
        if elapsed >= 0.5 { elapsed = 0; estimate() }
        let advance = dt * rate
        count += advance
        phase = (phase + advance).truncatingRemainder(dividingBy: 1)
    }

    /// Pull the phase toward zero when a strong kick lands, so the pulse sits on
    /// the beat rather than free-running at the right rate and a random phase.
    /// Scaled by dt: the browser applied 18% per 60 Hz frame, this runs per hop.
    mutating func align(_ kick: Float, dt: Float) {
        guard kick >= 0.6 else { return }
        let drift = phase > 0.5 ? phase - 1 : phase
        let nudge = drift * (1 - pow(0.82, dt * 60)) * confidence
        phase -= nudge
        // The unwrapped counter only ever moves forward.
        if nudge < 0 { count -= nudge }
        if phase < 0 { phase += 1 }
    }

    private mutating func estimate() {
        let mean = history.reduce(0, +) / 512
        let values = (0..<512).map { history[(write + $0) % 512] - mean }
        let energy = values.reduce(0) { $0 + $1 * $1 } / 512
        var best: Float = 0
        var bestLag = 0
        for lag in 20...78 {
            var sum: Float = 0
            for i in lag..<512 { sum += values[i] * values[i - lag] }
            let score = sum / Float(512 - lag) * (1 - 0.25 * abs(Float(lag) - 40) / 40)
            if score > best { best = score; bestLag = lag }
        }
        let strength: Float = energy > 0.000001 ? clamp(best / energy) : 0
        confidence = follow(confidence, strength, 0.5, 1.5, 3)
        if bestLag > 0 && strength > 0.12 {
            let candidate = Float(bestLag) / 60
            let ratio = candidate / period
            period = ratio > 1.4 || ratio < 0.7 ? candidate : period * 0.82 + candidate * 0.18
        }
    }
}

/// Percussive onsets in one band: log spectral flux against a threshold that
/// follows the band's own recent average, scaled by its recent strongest hit.
///
/// The threshold must not chase the hits it is looking for. The first version
/// followed a mean that rose within 0.3 s of every hit, over an 85 ms window,
/// so on real music the next hit never cleared it: kicks registered 0.04
/// times a second and hats never.
struct Onset {
    let low: Float
    let high: Float
    let decay: Float
    var mean: Float = 0
    var ceiling: Float = 0
    var envelope: Float = 0

    mutating func push(_ flux: Float, dt: Float) -> Float {
        let novelty = max(0, flux - mean * 1.5 - 0.004)
        mean = follow(mean, flux, dt, 0.45, 0.45)
        // The strongest recent hit sets the scale, so a soft kit and a hard
        // one both reach the top; a floor keeps quiet noise from being scaled
        // up into hits.
        ceiling = max(novelty, ceiling * exp(-dt / 2.5), 0.02)
        let hit = clamp(novelty / (ceiling * 0.6))
        envelope = max(hit, envelope - dt / decay)
        return envelope
    }
}

/// All mutation runs on the capture queue. Only complete value snapshots cross
/// to the renderer; no audio buffer is retained past its callback. That
/// discipline, and the lock around `published`, is what makes it Sendable.
final class AudioAnalyzer: @unchecked Sendable {
    private let fft = vDSP.FFT<DSPSplitComplex>(log2n: 12, radix: .radix2, ofType: DSPSplitComplex.self)!
    private let window = vDSP.window(ofType: Float.self, usingSequence: .hanningDenormalized, count: 4096, isHalfWindow: false)
    // Onsets have their own short transform: 43 ms at 48 kHz, every 11 ms.
    // The long one resolves the low end but smears a drum hit across 85 ms.
    private let onsetFFT = vDSP.FFT<DSPSplitComplex>(log2n: 11, radix: .radix2, ofType: DSPSplitComplex.self)!
    private let onsetWindow = vDSP.window(ofType: Float.self, usingSequence: .hanningDenormalized, count: 2048, isHalfWindow: false)
    private var onsetPrevious = [Float](repeating: 0, count: 1024)
    private var onsets = [Onset(low: 30, high: 150, decay: 0.32),
                          Onset(low: 1200, high: 6000, decay: 0.22),
                          Onset(low: 7000, high: 16000, decay: 0.12)]
    private var pending = [Float]()
    private var hops = 0
    private var gains = [Gain](repeating: Gain(), count: 7)
    private var tempo = Tempo()
    private var short: Float = 0
    private var long: Float = 0
    private var loudness: Float = 0
    private var sectionTop: Float?
    private var sectionBottom: Float = 0
    private var features = AudioFeatures()
    private let lock = NSLock()
    private var published = AudioFeatures()

    func snapshot() -> AudioFeatures { lock.lock(); defer { lock.unlock() }; return published }

    func consume(_ samples: [Float], sampleRate: Double) {
        guard sampleRate > 0 else { return }
        pending.append(contentsOf: samples)
        // Advance 512 samples at a time: onsets every hop, the spectrum every
        // fourth, each over the most recent samples.
        while pending.count >= 4096 {
            let frame = Array(pending.prefix(4096))
            detect(Array(frame.suffix(2048)), sampleRate: Float(sampleRate), dt: 512 / Float(sampleRate))
            hops += 1
            if hops % 4 == 0 { measure(frame, sampleRate: Float(sampleRate), dt: 2048 / Float(sampleRate)) }
            features.stamp = CACurrentMediaTime()
            lock.lock(); published = features; lock.unlock()
            pending.removeFirst(512)
        }
    }

    private static func magnitudes(_ samples: [Float], window: [Float], fft: vDSP.FFT<DSPSplitComplex>) -> [Float] {
        let count = samples.count
        let weighted = vDSP.multiply(samples, window)
        var real = stride(from: 0, to: count, by: 2).map { weighted[$0] }
        var imag = stride(from: 1, to: count, by: 2).map { weighted[$0] }
        var outReal = [Float](repeating: 0, count: count / 2)
        var outImag = outReal
        real.withUnsafeMutableBufferPointer { r in
            imag.withUnsafeMutableBufferPointer { i in
                outReal.withUnsafeMutableBufferPointer { or in
                    outImag.withUnsafeMutableBufferPointer { oi in
                        let input = DSPSplitComplex(realp: r.baseAddress!, imagp: i.baseAddress!)
                        var output = DSPSplitComplex(realp: or.baseAddress!, imagp: oi.baseAddress!)
                        fft.forward(input: input, output: &output)
                    }
                }
            }
        }
        outImag[0] = 0 // Packed Nyquist component is not DC imaginary energy.
        return zip(outReal, outImag).map { sqrt($0 * $0 + $1 * $1) / Float(count) }
    }

    /// Kick, snare and hats, from the rise in log magnitude in each band.
    private func detect(_ samples: [Float], sampleRate: Float, dt: Float) {
        let db = Self.magnitudes(samples, window: onsetWindow, fft: onsetFFT)
            .map { clamp((20 * log10(max($0, 0.000001)) + 80) / 70) }
        func bin(_ hz: Float) -> Int { min(1023, max(1, Int(hz * 2048 / sampleRate))) }
        var envelopes = [Float](repeating: 0, count: 3)
        for index in onsets.indices {
            let a = bin(onsets[index].low), b = max(a + 1, bin(onsets[index].high))
            var rise: Float = 0
            for i in a..<b { rise += max(0, db[i] - onsetPrevious[i]) }
            envelopes[index] = onsets[index].push(rise / Float(b - a), dt: dt)
        }
        onsetPrevious = db
        features.kick = envelopes[0]; features.snare = envelopes[1]; features.hat = envelopes[2]
        features.flux = envelopes[0] * 0.6 + envelopes[1] * 0.3 + envelopes[2] * 0.1
        tempo.push(features.flux, dt: dt)
        tempo.align(envelopes[0], dt: dt)
        features.beat = tempo.phase; features.beatTime = tempo.count; features.beatRate = tempo.rate
        features.bpm = tempo.confidence > 0.25 ? 60 / tempo.period : 0
        features.confidence = tempo.confidence
        features.pulse = pow(0.5 + 0.5 * cos(tempo.phase * .pi * 2), 2.2) * tempo.confidence
    }

    private func measure(_ samples: [Float], sampleRate: Float, dt: Float) {
        let magnitudes = Self.magnitudes(samples, window: window, fft: fft)
        let db = magnitudes.map { clamp((20 * log10(max($0, 0.000001)) + 80) / 70) }
        func bin(_ hz: Float) -> Int { min(2047, max(1, Int(hz * 4096 / sampleRate))) }
        func average(_ low: Float, _ high: Float) -> Float {
            let a = bin(low), b = max(a + 1, min(2048, bin(high)))
            return db[a..<b].reduce(0, +) / Float(b - a)
        }
        let rms = sqrt(samples.reduce(0) { $0 + $1 * $1 } / 4096)
        features.level = follow(features.level, gains[0].push(rms, dt: dt), dt, 0.05, 0.2)
        let edges: [Float] = [20, 62, 170, 460, 1500, 5200, 16000]
        for i in 0..<6 {
            features.bands[i] = follow(features.bands[i], gains[i + 1].push(average(edges[i], edges[i + 1]), dt: dt), dt, 0.05, 0.22)
        }
        // Brightness as a musical register: the spectral centroid in Hz, from
        // 200 Hz to 5 kHz on a log scale. As a bin index it spent every song
        // between 0.60 and 0.76 and never told a bass line from a vocal.
        let total = magnitudes.reduce(0, +)
        let weighted = magnitudes.enumerated().reduce(Float(0)) { $0 + Float($1.offset) * $1.element }
        let hz = weighted / max(0.00001, total) * sampleRate / 4096
        features.centroid = follow(features.centroid, clamp(log2(max(hz, 1) / 200) / log2(25)), dt, 0.35, 0.6)
        // Flatness, 0 tonal to 1 noisy, stretched over the range music uses.
        let logMean = magnitudes.dropFirst().reduce(Float(0)) { $0 + log(max($1, 0.000001)) } / 2047
        let flatness = exp(logMean) / max(0.000001, total / 2048)
        features.noise = follow(features.noise, clamp((flatness - 0.03) / 0.25), dt, 0.3, 0.6)
        short = follow(short, rms, dt, 0.08, 0.25)
        long = follow(long, rms, dt, 3, 6)
        features.dynamics = follow(features.dynamics, clamp(0.5 + (short - long) / max(long * 4, 0.001)), dt, 0.25, 0.8)
        features.swell = follow(features.swell, features.level, dt, 1.4, 2.2)
        features.silence = follow(features.silence, rms < 0.0008 ? 1 : 0, dt, 0.8, 0.4)
        // The section: loudness over a phrase, in dB, against the loudest and
        // quietest of the last minute or so. Held still through silence.
        loudness = follow(loudness, rms, dt, 0.6, 1.5)
        if rms >= 0.0008 {
            let level = 20 * log10(max(loudness, 0.00001))
            // With no history yet, assume the song will get as loud as a
            // typical master, about -20 dBFS, so a quiet intro reads as quiet
            // from its first bar; a quiet piece relaxes the top over 90 s.
            var top = sectionTop ?? max(level, -20)
            if sectionTop == nil { sectionBottom = level - 10 }
            top = follow(top, level, dt, 0.5, 90)
            sectionBottom = max(follow(sectionBottom, level, dt, 30, 0.5), top - 30)
            sectionTop = top
            let span = max(top - sectionBottom, 6)
            features.section = follow(features.section, clamp((level - (top - span)) / span), dt, 1.0, 1.5)
        } else {
            features.section = follow(features.section, 0, dt, 3, 3)
        }
        let rate = features.bpm > 0 ? clamp(features.bpm / 118, 0.45, 1.5) : 0.55
        // Tempo and energy, and the energy includes the section: level alone is
        // auto-gained, so ten seconds into a chorus it reads like the verse.
        let energy = 0.30 + features.level * 0.45 + features.section * 0.55
        let motion = (rate * 0.5 + energy * 0.5) * (1 - features.silence * 0.9)
        features.motion = follow(features.motion, motion, dt, 2.5, 3.5)
        for i in 0..<256 {
            let a = bin(28 * pow(16000 / 28, Float(i) / 256))
            let b = max(a + 1, bin(28 * pow(16000 / 28, Float(i + 1) / 256)))
            let value = db[a..<b].reduce(0, +) / Float(b - a)
            features.spectrum[i] = follow(features.spectrum[i], value, dt, 0.02, 0.16)
            features.slow[i] = follow(features.slow[i], value, dt, 0.45, 1.1)
        }
    }
}
