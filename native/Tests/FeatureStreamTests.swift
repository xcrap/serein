import XCTest
@testable import Serein

final class FeatureStreamTests: XCTestCase {
    private func loud(beatTime: Float) -> AudioFeatures {
        var f = AudioFeatures()
        f.level = 0.8; f.bands = [0.7, 0.8, 0.6, 0.65, 0.7, 0.5]
        f.spectrum = [Float](repeating: 0.6, count: 256); f.slow = f.spectrum
        f.swell = 0.6; f.silence = 0; f.motion = 1.1
        f.beatTime = beatTime; f.beatRate = 2
        return f
    }

    /// Switching source or pausing used to cut shape and light in one frame and
    /// restart the beat counter. Now every figure dissolves and the counter
    /// carries on.
    func testChangingSourceDissolvesAndKeepsCounting() {
        var stream = FeatureStream()
        let analyzer = AudioAnalyzer()
        var previous: AudioFeatures?
        let dt: Float = 1 / 60
        for frame in 0..<240 {
            let now = Double(frame) / 60
            let live = frame < 120
            let raw = live ? loud(beatTime: 40 + Float(frame) / 30) : AudioFeatures()
            let f = stream.next(raw, from: live ? .live(ObjectIdentifier(analyzer)) : .paused, now: now, dt: dt)
            if let previous {
                XCTAssertLessThan(abs(f.level - previous.level), 0.04, "frame \(frame): level cut")
                XCTAssertLessThan(abs(f.slow[40] - previous.slow[40]), 0.04, "frame \(frame): shape cut")
                XCTAssertLessThan(abs(f.silence - previous.silence), 0.04, "frame \(frame): silence cut")
                XCTAssertGreaterThanOrEqual(f.beatTime, previous.beatTime, "frame \(frame): counter ran backwards")
                XCTAssertLessThan(f.beatTime - previous.beatTime, 0.05, "frame \(frame): counter jumped")
            }
            previous = f
        }
        XCTAssertEqual(previous?.level ?? 1, 0, accuracy: 0.001, "the paused picture settles to silence")
    }

    /// Snapshots arrive about 23 times a second. A kick's flash should die a
    /// little every frame, not hold for three and then step.
    func testOnsetsDecayEveryFrameBetweenSnapshots() {
        var stream = FeatureStream()
        let analyzer = AudioAnalyzer()
        var raw = loud(beatTime: 0)
        var kick: Float = 1
        var outputs = [Float]()
        for frame in 0..<18 {
            // The analyser's staircase: a new value only once per 2,048-sample hop.
            if frame % 3 == 0 { raw.kick = kick; kick = max(0, kick - (2048 / 48000) / 0.32) }
            outputs.append(stream.next(raw, from: .live(ObjectIdentifier(analyzer)), now: Double(frame) / 60, dt: 1 / 60).kick)
        }
        XCTAssertEqual(outputs[0], 1)
        for (a, b) in zip(outputs, outputs.dropFirst()) {
            XCTAssertLessThan(b, a, "the flash held instead of decaying")
            XCTAssertLessThan(a - b, 0.07, "the flash stepped")
        }
    }

    /// The pulse used to free-run at the tempo with an arbitrary phase: the
    /// native analyser never pulled its phase onto the kick.
    func testStrongKicksPullThePulseOntoTheBeat() {
        var tempo = Tempo()
        func hit(_ frame: Int) -> Float { frame % 30 < 2 ? 1 : 0 }  // 120 BPM
        for frame in 0..<1800 { tempo.push(hit(frame), dt: 1 / 60); tempo.align(hit(frame), dt: 1 / 60) }
        // Knock the phase a third of a beat off the hits; the kicks must pull it back.
        tempo.phase = (tempo.phase + 0.33).truncatingRemainder(dividingBy: 1)
        var drifts = [Float]()
        for frame in 1800..<2400 {
            if frame >= 2280 && frame % 30 == 0 { drifts.append(min(tempo.phase, 1 - tempo.phase)) }
            tempo.push(hit(frame), dt: 1 / 60)
            tempo.align(hit(frame), dt: 1 / 60)
        }
        XCTAssertLessThan(drifts.max() ?? 1, 0.08, "the phase should sit on the hits: \(drifts)")
    }
}
