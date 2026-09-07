import Accelerate
import Foundation

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
    var bpm: Float = 0
    var dynamics: Float = 0.5
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
        f.beatTime = time / 7.5
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

    mutating func push(_ strength: Float, dt: Float) {
        carry += dt
        while carry >= 1 / 60 {
            carry -= 1 / 60
            history[write] = strength
            write = (write + 1) % 512
        }
        elapsed += dt
        if elapsed >= 0.5 { elapsed = 0; estimate() }
        let advance = dt / (confidence > 0.25 ? period : period * 2.4)
        count += advance
        phase = (phase + advance).truncatingRemainder(dividingBy: 1)
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

/// All mutation runs on the capture queue. Only complete value snapshots cross
/// to the renderer; no audio buffer is retained past its callback.
final class AudioAnalyzer {
    private let fft = vDSP.FFT<DSPSplitComplex>(log2n: 12, radix: .radix2, ofType: DSPSplitComplex.self)!
    private let window = vDSP.window(ofType: Float.self, usingSequence: .hanningDenormalized, count: 4096, isHalfWindow: false)
    private var pending = [Float]()
    private var gains = [Gain](repeating: Gain(), count: 7)
    private var previous = [Float](repeating: 0, count: 2048)
    private var onsetMeans = [Float](repeating: 0.002, count: 3)
    private var tempo = Tempo()
    private var short: Float = 0
    private var long: Float = 0
    private var features = AudioFeatures()
    private let lock = NSLock()
    private var published = AudioFeatures()

    func snapshot() -> AudioFeatures { lock.lock(); defer { lock.unlock() }; return published }

    func consume(_ samples: [Float], sampleRate: Double) {
        guard sampleRate > 0 else { return }
        pending.append(contentsOf: samples)
        while pending.count >= 4096 {
            measure(Array(pending.prefix(4096)), sampleRate: Float(sampleRate), dt: 2048 / Float(sampleRate))
            pending.removeFirst(2048)
        }
    }

    private func measure(_ samples: [Float], sampleRate: Float, dt: Float) {
        let weighted = vDSP.multiply(samples, window)
        var real = stride(from: 0, to: 4096, by: 2).map { weighted[$0] }
        var imag = stride(from: 1, to: 4096, by: 2).map { weighted[$0] }
        var outReal = [Float](repeating: 0, count: 2048)
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
        let magnitudes = zip(outReal, outImag).map { sqrt($0 * $0 + $1 * $1) / 4096 }
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
        var envelopes: [Float] = [features.kick, features.snare, features.hat]
        for (index, range) in [(28 as Float, 140 as Float), (180, 2400), (5200, 13000)].enumerated() {
            let a = bin(range.0), b = max(a + 1, bin(range.1))
            var rise: Float = 0
            for i in a..<b { rise += max(0, db[i] - previous[i]) }
            rise /= Float(b - a)
            onsetMeans[index] = follow(onsetMeans[index], rise, dt, 0.3, 2.5)
            let hit = clamp((rise / max(0.01, onsetMeans[index] * 2) - 0.6) / 1.4)
            envelopes[index] = max(hit, envelopes[index] - dt / [0.32, 0.22, 0.12][index])
        }
        previous = db
        features.kick = envelopes[0]; features.snare = envelopes[1]; features.hat = envelopes[2]
        features.flux = envelopes[0] * 0.6 + envelopes[1] * 0.3 + envelopes[2] * 0.1
        tempo.push(features.flux, dt: dt)
        features.beat = tempo.phase; features.beatTime = tempo.count
        features.bpm = tempo.confidence > 0.25 ? 60 / tempo.period : 0
        features.pulse = pow(0.5 + 0.5 * cos(tempo.phase * .pi * 2), 2.2) * tempo.confidence
        let total = magnitudes.reduce(0, +)
        let centroid = magnitudes.enumerated().reduce(Float(0)) { $0 + Float($1.offset) * $1.element }
        features.centroid = follow(features.centroid, clamp(log(1 + centroid / max(0.00001, total)) / log(2048)), dt, 0.35, 0.6)
        let logMean = magnitudes.dropFirst().reduce(Float(0)) { $0 + log(max($1, 0.000001)) } / 2047
        features.noise = clamp(exp(logMean) / max(0.000001, total / 2048))
        short = follow(short, rms, dt, 0.08, 0.25)
        long = follow(long, rms, dt, 3, 6)
        features.dynamics = follow(features.dynamics, clamp(0.5 + (short - long) / max(long * 4, 0.001)), dt, 0.25, 0.8)
        features.swell = follow(features.swell, features.level, dt, 1.4, 2.2)
        features.silence = follow(features.silence, rms < 0.0008 ? 1 : 0, dt, 0.8, 0.4)
        let rate = features.bpm > 0 ? clamp(features.bpm / 118, 0.45, 1.5) : 0.55
        let motion = (rate * 0.5 + (0.32 + features.level * 0.85) * 0.5) * (1 - features.silence * 0.9)
        features.motion = follow(features.motion, motion, dt, 2.5, 3.5)
        for i in 0..<256 {
            let a = bin(28 * pow(16000 / 28, Float(i) / 256))
            let b = max(a + 1, bin(28 * pow(16000 / 28, Float(i + 1) / 256)))
            let value = db[a..<b].reduce(0, +) / Float(b - a)
            features.spectrum[i] = follow(features.spectrum[i], value, dt, 0.02, 0.16)
            features.slow[i] = follow(features.slow[i], value, dt, 0.45, 1.1)
        }
        lock.lock(); published = features; lock.unlock()
    }
}
