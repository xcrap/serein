import SwiftUI
import UniformTypeIdentifiers

struct InstrumentView: View {
    @ObservedObject var instrument: Instrument
    @ObservedObject var audio: AudioController
    @ObservedObject var spotify: SpotifyController
    @State private var dropTarget = false
    @State private var paletteOpen = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var effect: Effect { Effect.all[instrument.effect] }
    private var chromeVisible: Bool { instrument.controls && !instrument.opening }
    private var hasTrack: Bool { audio.source == .file || (spotify.connected && !spotify.title.isEmpty) }

    var body: some View {
        GeometryReader { geometry in
            let pad = min(52.0, max(26.0, geometry.size.width * 0.034))
            ZStack {
                Color(red: 0.02, green: 0.02, blue: 0.024)
                MetalCanvas(instrument: instrument).accessibilityHidden(true)
                // The image owns the whole window. Text casts its own shadow;
                // no scrim, panel, or footer obscures the artwork.
                VStack {
                    header
                        .opacity(chromeVisible ? 1 : 0)
                        .allowsHitTesting(chromeVisible)
                        .accessibilityHidden(!chromeVisible)
                    Spacer(minLength: 24)
                    VStack(alignment: .leading, spacing: 34) {
                        if instrument.nowPlaying && !instrument.opening && hasTrack {
                            nowPlaying
                                .frame(maxWidth: min(420, geometry.size.width * 0.46), alignment: .leading)
                                .transition(.opacity)
                        }
                        // Hidden controls leave the layout rather than just going
                        // transparent, so what is playing settles into the corner
                        // instead of floating over the space they left.
                        if chromeVisible {
                            controls(width: geometry.size.width - pad * 2)
                                .frame(maxWidth: .infinity)
                                .transition(.opacity)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, pad)
                .padding(.top, max(44, pad))
                .padding(.bottom, pad)
                if instrument.opening { opening(width: geometry.size.width).transition(.opacity) }
                if dropTarget {
                    Color.black.opacity(0.6).allowsHitTesting(false)
                    Text("Drop an audio file").font(SereinType.ui(24, weight: 350))
                }
                if let error = instrument.rendererError {
                    VStack(alignment: .leading, spacing: 20) {
                        Text("The light could not start").font(SereinType.ui(24))
                        Text(error).font(SereinType.ui(13)).textSelection(.enabled)
                    }.padding(36).frame(maxWidth: 550).background(.black.opacity(0.9))
                }
            }
            .foregroundStyle(SereinType.ink)
        }
        .ignoresSafeArea()
        .background(KeyboardInput(instrument: instrument))
        .onAppear { if reduceMotion { instrument.speed = 0 } }
        .onChange(of: audio.source) { _, source in
            if source != .resting { instrument.opening = false }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.8), value: chromeVisible)
        .animation(reduceMotion ? nil : .easeInOut(duration: 1.2), value: instrument.opening)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.4), value: instrument.nowPlaying)
        .onDrop(of: [UTType.fileURL], isTargeted: $dropTarget) { providers in
            guard let provider = providers.first else { return false }
            _ = provider.loadObject(ofClass: NSURL.self) { object, _ in
                guard let url = object as? URL else { return }
                Task { @MainActor in
                    instrument.opening = false
                    await audio.start(.file, url: url)
                }
            }
            return true
        }
        .sheet(isPresented: $instrument.showHelp) { help }
        .alert("Sound needs your attention", isPresented: Binding(get: { audio.error != nil || spotify.error != nil }, set: { if !$0 { audio.error = nil; spotify.error = nil } })) {
            Button("OK", role: .cancel) { audio.error = nil; spotify.error = nil }
        } message: { Text(audio.error ?? spotify.error ?? "") }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 32) {
            VStack(alignment: .leading, spacing: 10) {
                Text("SEREIN").font(SereinType.ui(14, weight: 600)).tracking(3.64)
                    .foregroundStyle(SereinType.ink.opacity(0.9))
                Rectangle().fill(SereinType.ink.opacity(0.16)).frame(width: 26, height: 1)
                (Text(effect.name.uppercased()).foregroundColor(SereinType.ink.opacity(0.60))
                    + Text("  ·  " + effect.note.uppercased()).foregroundColor(SereinType.ink.opacity(0.36)))
                    .font(SereinType.mono(9)).tracking(1.8).lineLimit(1)
                    .id(effect.id).transition(.opacity)
                    .animation(.easeInOut(duration: 0.7), value: effect.id)
            }.shadow(color: .black.opacity(0.9), radius: 12)
            Spacer(minLength: 0)
            HStack(spacing: 22) {
                Button { paletteOpen.toggle() } label: {
                    HStack(spacing: 9) {
                        Circle().fill(LinearGradient(colors: ColourWorld.all[instrument.palette].colors,
                            startPoint: .topLeading, endPoint: .bottomTrailing)).frame(width: 6, height: 6)
                        Text(ColourWorld.all[instrument.palette].name.uppercased())
                    }.font(SereinType.mono(9)).tracking(1.8)
                }.buttonStyle(QuietButtonStyle()).help("Colour worlds · C")
                    .popover(isPresented: $paletteOpen, arrowEdge: .bottom) { palettes }
                Menu {
                    Button("Recompose") { instrument.recompose() }
                    Button("Tune…") { instrument.showSettings = true }
                    Button("Full Screen") { instrument.fullscreen() }
                    Button("Hide Controls") { instrument.controls = false }
                    Button("Keyboard Shortcuts") { instrument.showHelp = true }
                    Divider()
                    Button("Stop Listening") { Task { await audio.start(.resting) } }
                } label: { Text("···").font(SereinType.ui(17)).tracking(3).foregroundStyle(SereinType.ink.opacity(0.5)) }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .help("Recompose, tune, full screen, and keys")
                .popover(isPresented: $instrument.showSettings) { settings }
            }
        }
    }

    private func controls(width: CGFloat) -> some View {
        VStack(spacing: 23) {
            // The original presets retain their quiet, typographic navigation.
            // A compact window wraps into two balanced rows instead of cards.
            ViewThatFits(in: .horizontal) {
                presetRow(Effect.all, gap: 27)
                presetRow(Effect.all, gap: 15)
                VStack(spacing: 17) {
                    presetRow(Array(Effect.all.prefix((Effect.all.count + 1) / 2)), gap: 27)
                    presetRow(Array(Effect.all.dropFirst((Effect.all.count + 1) / 2)), gap: 27)
                }
            }
            HStack(spacing: 30) {
                Button {
                    Task { await audio.start(audio.source == .system ? .resting : .system) }
                } label: {
                    Text(audio.busy ? "CONNECTING" : "SYSTEM AUDIO")
                }.buttonStyle(QuietButtonStyle(selected: audio.source == .system))
                    .help("Listen to Spotify and other apps · L")
                Button("SPOTIFY") { spotify.toggle() }
                    .buttonStyle(QuietButtonStyle(selected: spotify.connected))
                    .help("Spotify track information and playback · S")
                Button("FILE") { audio.openFile() }
                    .buttonStyle(QuietButtonStyle(selected: audio.source == .file))
                    .help("Open an audio file · O")
            }.font(SereinType.mono()).tracking(2.5).disabled(audio.busy)
        }
    }

    private func presetRow(_ effects: [Effect], gap: CGFloat) -> some View {
        HStack(spacing: gap) {
            ForEach(effects) { item in
                Button(item.name.uppercased()) { instrument.effect = item.id }
                    .buttonStyle(QuietButtonStyle(selected: instrument.effect == item.id))
                    .font(SereinType.mono()).tracking(2.5).fixedSize()
                    .help("\(item.note) · \((item.id + 1) % 10)")
                    .accessibilityLabel(item.name)
                    .accessibilityAddTraits(instrument.effect == item.id ? .isSelected : [])
            }
        }.fixedSize()
    }

    private var nowPlaying: some View {
        let useSpotify = spotify.connected && audio.source != .file
        return VStack(alignment: .leading, spacing: 7) {
            Button { instrument.playPause() } label: {
                Text(useSpotify ? spotify.title : audio.title)
                    .font(SereinType.ui(22, weight: 600)).tracking(-0.3).lineLimit(1)
            }.buttonStyle(QuietButtonStyle(selected: true)).help("Play / pause · Space")
            Text(useSpotify ? spotify.artist : audio.subtitle)
                .font(SereinType.ui(13, weight: 500)).foregroundStyle(SereinType.ink.opacity(0.62)).lineLimit(1)
            if audio.source == .file {
                TimelineView(.periodic(from: .now, by: 0.4)) { _ in
                    ZStack(alignment: .leading) {
                        Rectangle().fill(SereinType.ink.opacity(0.1))
                        Rectangle().fill(SereinType.ink.opacity(0.55))
                            .frame(width: 220 * min(1, audio.position / max(1, audio.duration)))
                    }.frame(width: 220, height: 1).padding(.top, 4)
                }.accessibilityLabel("Playback progress")
            }
        }.shadow(color: .black.opacity(0.8), radius: 18)
    }

    private func opening(width: CGFloat) -> some View {
        ZStack {
            RadialGradient(colors: [.black.opacity(0.12), Color(red: 0.02, green: 0.02, blue: 0.024).opacity(0.82)],
                center: .center, startRadius: 0, endRadius: width * 0.65)
                .contentShape(Rectangle()).onTapGesture { instrument.opening = false }
            VStack(spacing: 40) {
                let size = min(136, max(54, width * 0.1))
                Text("SEREIN").font(SereinType.ui(size, weight: 150)).tracking(size * 0.42)
                    .padding(.leading, size * 0.42)
                    .shadow(color: .black.opacity(0.85), radius: 35)
                    .accessibilityAddTraits(.isHeader)
                HStack(spacing: 28) {
                    Button("SYSTEM AUDIO") {
                        instrument.opening = false
                        Task { await audio.start(.system) }
                    }.help("Let Spotify and your Mac's audio drive the light")
                    Button("ENTER") { instrument.opening = false }.help("Enter the quiet field")
                }.font(SereinType.ui(11, weight: 500)).tracking(2.2)
                    .buttonStyle(OpeningButtonStyle())
            }
        }
    }

    private var palettes: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("COLOUR WORLDS").font(SereinType.mono(9)).tracking(2).foregroundStyle(.secondary)
            ForEach(ColourWorld.all) { world in
                Button { instrument.palette = world.id; paletteOpen = false } label: {
                    HStack(spacing: 14) {
                        Circle().fill(LinearGradient(colors: world.colors, startPoint: .topLeading, endPoint: .bottomTrailing)).frame(width: 8, height: 8)
                        Text(world.name).font(SereinType.ui(12))
                        Spacer()
                        if world.id == instrument.palette { Text("·") }
                    }.frame(width: 170)
                }.buttonStyle(QuietButtonStyle(selected: world.id == instrument.palette))
            }
        }.padding(24)
    }

    private var settings: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Tune the instrument").font(SereinType.ui(14, weight: 600))
            tuning("Motion", value: $instrument.speed, range: 0...2)
            tuning("Response", value: $instrument.intensity, range: 0.3...2)
            tuning("Grain", value: $instrument.grain, range: 0...1)
            tuning("Resolution", value: $instrument.quality, range: 0.5...1)
            Text("Set Motion to zero for a still composition. Sound continues to change its light.")
                .font(SereinType.ui(12)).foregroundStyle(.secondary)
            Button("Reset") { instrument.speed = 1; instrument.intensity = 1; instrument.grain = 0.65; instrument.quality = 1 }
        }.padding(24).frame(width: 290)
    }

    private func tuning(_ title: String, value: Binding<Float>, range: ClosedRange<Float>) -> some View {
        VStack(spacing: 7) {
            HStack { Text(title); Spacer(); Text(String(format: "%.0f%%", value.wrappedValue * 100)).monospacedDigit().foregroundStyle(.secondary) }.font(SereinType.ui(12))
            Slider(value: value, in: range).accessibilityLabel(title)
        }
    }

    private var help: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Serein").font(SereinType.ui(28, weight: 300))
            Text("Give it sound. It answers in light.").foregroundStyle(.secondary)
            Grid(alignment: .leading, horizontalSpacing: 32, verticalSpacing: 10) {
                ForEach([(Effect.all.count > 9 ? "1–9, 0" : "1–\(Effect.all.count)", "Choose an effect"), ("N", "Next effect"), ("C / ⇧C", "Next / previous colour world"), ("L / O", "System audio / file"), ("Space", "Play / pause file or Spotify"), ("S", "Connect / disconnect Spotify desktop"), ("← / →", "Previous / next Spotify track"), ("R", "Recompose"), ("F", "Full screen"), ("U / T", "Toggle controls / now playing"), ("H", "Keyboard shortcuts")], id: \.0) { key, action in
                    GridRow { Text(key).font(SereinType.mono(11)); Text(action).font(SereinType.ui(12)).foregroundStyle(.secondary) }
                }
            }
            Text("Play Spotify and choose System audio to sync the visuals. The optional Spotify connection adds track titles and playback controls. All audio analysis stays on your Mac.")
                .font(SereinType.ui(12)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack { Spacer(); Button("Done") { instrument.showHelp = false }.keyboardShortcut(.defaultAction) }
        }.padding(32).frame(width: 470)
    }
}


private struct QuietButtonStyle: ButtonStyle {
    var selected = false
    func makeBody(configuration: Configuration) -> some View {
        QuietLabel(configuration: configuration, selected: selected)
    }
    private struct QuietLabel: View {
        let configuration: ButtonStyle.Configuration
        let selected: Bool
        @State private var hovered = false
        var body: some View {
            configuration.label
                .foregroundStyle(SereinType.ink.opacity(configuration.isPressed ? 0.7 : selected ? 0.96 : hovered ? 0.82 : 0.40))
                .padding(.vertical, 4)
                .contentShape(Rectangle())
                .shadow(color: .black.opacity(0.95), radius: 12)
                .onHover { hovered = $0 }
                .animation(.easeOut(duration: 0.26), value: hovered)
                .animation(.easeInOut(duration: 0.4), value: selected)
        }
    }
}

private struct OpeningButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(SereinType.ink.opacity(configuration.isPressed ? 1 : 0.85))
            .padding(.horizontal, 24).padding(.vertical, 13)
            .background(Color(red: 0.025, green: 0.025, blue: 0.035).opacity(0.62), in: Capsule())
            .overlay(Capsule().stroke(SereinType.ink.opacity(configuration.isPressed ? 0.45 : 0.18), lineWidth: 1))
    }
}
