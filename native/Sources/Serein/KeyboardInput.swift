import SwiftUI
import AppKit

/// Bare musical shortcuts belong to the canvas, never to file pickers, text
/// fields, sheets, or other apps. Cmd-O stays a standard native menu command.
struct KeyboardInput: NSViewRepresentable {
    let instrument: Instrument
    func makeCoordinator() -> Coordinator { Coordinator(instrument: instrument) }
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        context.coordinator.view = view
        context.coordinator.install()
        return view
    }
    func updateNSView(_ view: NSView, context: Context) {}
    static func dismantleNSView(_ view: NSView, coordinator: Coordinator) { coordinator.remove() }

    @MainActor final class Coordinator {
        let instrument: Instrument
        weak var view: NSView?
        var monitor: Any?
        init(instrument: Instrument) { self.instrument = instrument }
        func remove() { if let monitor { NSEvent.removeMonitor(monitor) }; monitor = nil }
        func install() {
            monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, let window = self.view?.window,
                      NSApp.keyWindow === window, window.attachedSheet == nil, NSApp.modalWindow == nil,
                      !(window.firstResponder is NSTextView), !(window.firstResponder is NSTextField),
                      !self.instrument.showHelp, !self.instrument.showSettings,
                      event.modifierFlags.intersection([.command, .control, .option]).isEmpty,
                      !event.isARepeat else { return event }
                let key = event.charactersIgnoringModifiers?.lowercased() ?? ""
                let model = self.instrument
                model.opening = false
                if let digit = Int(key), (1...Effect.all.count).contains(digit) { model.effect = digit - 1; return nil }
                switch key {
                case "n": model.nextEffect()
                case "c": model.nextPalette(event.modifierFlags.contains(.shift) ? -1 : 1)
                case "l": Task { await model.audio.start(.system) }
                case "o": model.audio.openFile()
                case "s": model.spotify.toggle()
                case "r": model.recompose()
                case "f": model.fullscreen()
                case "u": model.controls.toggle()
                case "t": model.nowPlaying.toggle()
                case "h", "?": model.showHelp = true
                case " ": model.playPause()
                default:
                    if event.keyCode == 123 { model.spotify.command("previous track") }
                    else if event.keyCode == 124 { model.spotify.command("next track") }
                    else { return event }
                }
                return nil
            }
        }
    }
}
