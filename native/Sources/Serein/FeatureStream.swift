import Foundation

/// What the shaders are given: the analyser's snapshots, carried from frame to
/// frame and across changes of source.
///
/// The analyser publishes once per 2,048-sample hop, about 23 times a second,
/// and the screen draws 60. Taken raw, every figure held for two or three
/// frames and then stepped: Bloom's rings grew in visible jumps, a kick's flash
/// died in stairs, and Veil's line breathed at the hop rate. And each source
/// starts a fresh analyser from silence with its beat counter at zero, while a
/// paused file has no features at all, so switching source or pausing cut
/// shape and light in a single frame and restarted every ring at once.
struct FeatureStream {
    enum Origin: Hashable { case resting, paused, live(ObjectIdentifier) }

    /// The analyser's own onset decays, in seconds: kick, snare, hat.
    private static let decays: [Float] = [0.32, 0.22, 0.12]
    /// The longest gap between snapshots, at 44.1 kHz.
    private static let hop: Float = 2048 / 44100
    /// How long a change of source takes to dissolve.
    private static let crossing: Float = 0.8

    private var origin: Origin?
    private var departed = AudioFeatures()
    private var output = AudioFeatures()
    private var crossed: Float = 1
    private var held = AudioFeatures()
    private var previousOnsets: [Float] = [0, 0, 0]
    private var beats: Float = 0

    mutating func next(_ raw: AudioFeatures, from origin: Origin, now: Double, dt: Float) -> AudioFeatures {
        if origin != self.origin {
            if self.origin != nil { departed = output; crossed = 0 }
            self.origin = origin
        }
        var f = raw

        // Level and the fast spectrum rise the moment a snapshot does, so
        // nothing lands late, and fall through the gap to the next one instead
        // of holding and stepping.
        let settle = 1 - exp(-dt / 0.035)
        func carry(_ held: Float, _ target: Float) -> Float { target >= held ? target : held + (target - held) * settle }
        held.level = carry(held.level, raw.level)
        for i in held.bands.indices { held.bands[i] = carry(held.bands[i], raw.bands[i]) }
        for i in held.spectrum.indices { held.spectrum[i] = carry(held.spectrum[i], raw.spectrum[i]) }
        f.level = held.level; f.bands = held.bands; f.spectrum = held.spectrum

        // An onset lands on the frame its snapshot arrives, then decays at the
        // analyser's own rate every frame. It never trails the analyser by more
        // than one hop's worth of decay.
        var onsets = [held.kick, held.snare, held.hat]
        let rawOnsets = [raw.kick, raw.snare, raw.hat]
        for i in 0..<3 {
            let decay = Self.decays[i]
            onsets[i] = rawOnsets[i] > previousOnsets[i] + 0.0001
                ? max(onsets[i], rawOnsets[i])
                : max(onsets[i] - dt / decay, rawOnsets[i] - Self.hop / decay)
            onsets[i] = clamp(onsets[i])
        }
        previousOnsets = rawOnsets
        held.kick = onsets[0]; held.snare = onsets[1]; held.hat = onsets[2]
        f.kick = onsets[0]; f.snare = onsets[1]; f.hat = onsets[2]

        // The analyser's phase, which strong kicks pull onto the beat, carried
        // forward from the moment it was published.
        let since = Float(min(0.1, max(0, now - raw.stamp)))
        let phase = raw.beat + since * raw.beatRate
        f.beat = phase - floor(phase)
        f.pulse = pow(0.5 + 0.5 * cos(f.beat * 2 * .pi), 2.2) * raw.confidence

        if crossed < 1 {
            crossed = min(1, crossed + dt / Self.crossing)
            f = .mix(departed, f, crossed * crossed * (3 - 2 * crossed))
        }

        // Its own counter, at frame rate: continuous across sources and never
        // backwards. Only things reborn each beat may read it.
        beats += dt * max(0, f.beatRate)
        f.beatTime = beats
        output = f
        return f
    }
}

extension AudioFeatures {
    /// Everything that shades the picture, interpolated. The beat counter is
    /// left to the caller: interpolating two counters can run it backwards.
    static func mix(_ a: Self, _ b: Self, _ t: Float) -> Self {
        func m(_ x: Float, _ y: Float) -> Float { x + (y - x) * t }
        var f = b
        f.level = m(a.level, b.level)
        f.bands = zip(a.bands, b.bands).map(m)
        f.centroid = m(a.centroid, b.centroid)
        f.noise = m(a.noise, b.noise)
        f.flux = m(a.flux, b.flux)
        f.kick = m(a.kick, b.kick)
        f.snare = m(a.snare, b.snare)
        f.hat = m(a.hat, b.hat)
        f.pulse = m(a.pulse, b.pulse)
        f.beatRate = m(a.beatRate, b.beatRate)
        f.dynamics = m(a.dynamics, b.dynamics)
        f.swell = m(a.swell, b.swell)
        f.silence = m(a.silence, b.silence)
        f.section = m(a.section, b.section)
        f.motion = m(a.motion, b.motion)
        f.spectrum = zip(a.spectrum, b.spectrum).map(m)
        f.slow = zip(a.slow, b.slow).map(m)
        return f
    }
}
