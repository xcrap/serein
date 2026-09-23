import AppKit
import SwiftUI

struct Effect: Identifiable {
    let id: Int
    let name: String
    let note: String
    static let all: [Effect] = [
        .init(id: 0, name: "Veil", note: "A membrane held between low and high"),
        .init(id: 1, name: "Bloom", note: "Ink released into water, one ring every two beats"),
        .init(id: 2, name: "Coil", note: "One long body, the spectrum along its length"),
        .init(id: 3, name: "Ink", note: "Pigment lit from inside, pushed by the low end"),
        .init(id: 4, name: "Harp", note: "Sixteen strings, struck and left to ring"),
        .init(id: 5, name: "Fathom", note: "Sunlight bent through the surface onto the seabed"),
        .init(id: 6, name: "Quicksilver", note: "Liquid metal standing up into the shape of the note"),
        .init(id: 7, name: "Corona", note: "An eclipse, its light streaming out on the wind"),
        .init(id: 8, name: "Wick", note: "One flame, the music rising through it as heat"),
        .init(id: 9, name: "Boreal", note: "Curtains of light folding away over a still lake")
    ]
}

struct ColourWorld: Identifiable {
    let id: Int
    let name: String
    let colors: [Color]
    static let all: [ColourWorld] = {
        let names = ["Native", "Ember", "Glacier", "Nocturne", "Iris", "Cinder", "Peony", "Verdigris", "Absinthe", "Tide", "Copper", "Bruise", "Aurora"]
        let swatches: [[UInt32]] = [[0xff4c29,0xa861ff,0x6bd8ca], [0xe0341a,0xe8c22a,0x3fa8d8], [0x1f6fd0,0xc8e04a,0xe06090], [0x4a4bc0,0xd05fa0,0xe8d070], [0x7a2fd0,0xe0508a,0x7fd8c0], [0x2f5fb0,0xe07040,0xd8d060], [0xd02860,0xf0a040,0x60c0b0], [0x1a8a60,0xd0c840,0xb060d0], [0x4a9a3a,0xd8d040,0xe06850], [0x1a7a90,0xe06a30,0xb0a8e0], [0xa04018,0xe0a040,0x5fb0e0], [0x5a20a0,0xd03070,0xf0b040], [0x5020a0,0x22a86a,0xe8d060]]
        return names.enumerated().map { index, name in
            ColourWorld(id: index, name: name, colors: swatches[index].map {
                Color(red: Double(($0 >> 16) & 255) / 255, green: Double(($0 >> 8) & 255) / 255, blue: Double($0 & 255) / 255)
            })
        }
    }()
}

@MainActor
final class Instrument: ObservableObject {
    @Published var effect: Int { didSet { UserDefaults.standard.set(effect, forKey: "effect") } }
    @Published var palette: Int { didSet { UserDefaults.standard.set(palette, forKey: "palette") } }
    @Published var speed: Float = 1
    @Published var intensity: Float = 1
    @Published var grain: Float = 0.65
    @Published var quality: Float = 1
    @Published var seed: Float = 2.618
    @Published var controls = true
    @Published var opening = true
    @Published var nowPlaying = true
    @Published var showHelp = false
    @Published var showSettings = false
    @Published var rendererError: String?
    let audio = AudioController()
    let spotify = SpotifyController()

    init() {
        let savedEffect = UserDefaults.standard.integer(forKey: "effect")
        effect = Effect.all.indices.contains(savedEffect) ? savedEffect : 0
        palette = min(ColourWorld.all.count - 1, max(0, UserDefaults.standard.integer(forKey: "palette")))
    }
    func nextEffect(_ step: Int = 1) { effect = (effect + step + Effect.all.count) % Effect.all.count }
    func nextPalette(_ step: Int = 1) { palette = (palette + step + ColourWorld.all.count) % ColourWorld.all.count }
    func recompose() { seed = Float.random(in: 0.1...100) }
    func fullscreen() { NSApp.keyWindow?.toggleFullScreen(nil) }
    func playPause() { if audio.source == .file { audio.togglePlayback() } else { spotify.command("playpause") } }
}
