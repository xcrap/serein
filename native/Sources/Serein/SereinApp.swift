import SwiftUI
import AppKit

@main
struct SereinApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var instrument = Instrument()

    init() { SereinType.register() }

    var body: some Scene {
        Window("Serein", id: "instrument") {
            InstrumentView(instrument: instrument, audio: instrument.audio, spotify: instrument.spotify)
                .frame(minWidth: 820, minHeight: 560)
                .preferredColorScheme(.dark)
                .onOpenURL { url in
                    guard url.isFileURL else { return }
                    Task { await instrument.audio.start(.file, url: url) }
                }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1280, height: 800)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Open Audio File…") { instrument.audio.openFile() }.keyboardShortcut("o")
            }
            CommandMenu("Sound") {
                Button("Listen to System Audio") { Task { await instrument.audio.start(.system) } }
                Button("Open Audio File…") { instrument.audio.openFile() }
                Button("Rest") { Task { await instrument.audio.start(.resting) } }
                Divider()
                Button("Play / Pause") { instrument.playPause() }
                Button(instrument.spotify.connected ? "Disconnect Spotify" : "Connect Spotify") { instrument.spotify.toggle() }
                Button("Previous Spotify Track") { instrument.spotify.command("previous track") }
                Button("Next Spotify Track") { instrument.spotify.command("next track") }
            }
            CommandMenu("Effects") {
                ForEach(Effect.all) { effect in
                    Button(effect.name) { instrument.effect = effect.id }
                }
                Divider()
                Button("Next Effect") { instrument.nextEffect() }
                Button("Next Colour World") { instrument.nextPalette() }
                Button("Previous Colour World") { instrument.nextPalette(-1) }
                Button("Recompose") { instrument.recompose() }
            }
            CommandGroup(after: .toolbar) {
                Button(instrument.controls ? "Hide Controls" : "Show Controls") { instrument.controls.toggle() }
                Button(instrument.nowPlaying ? "Hide Now Playing" : "Show Now Playing") { instrument.nowPlaying.toggle() }
                Button("Toggle Full Screen") { instrument.fullscreen() }
            }
            CommandGroup(replacing: .help) {
                Button("Serein Keyboard Shortcuts") { instrument.showHelp.toggle() }
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
}
