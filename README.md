# Serein for macOS

A listening instrument, now built in **SwiftUI and Metal**. Give it music and it
answers in light: ten effects, thirteen colour worlds, and a musical clock that
follows the sound. Audio analysis stays on your Mac.

The native app uses AVAudioEngine, ScreenCaptureKit, Accelerate FFTs, and Metal.
It has no WebView, Electron, JavaScript runtime, or third-party dependencies.

## Build and open

Requires **macOS 14 or later**, a Metal-capable Mac, and Xcode 15 or later
(or matching command-line tools).

```sh
./scripts/build-macos.sh --open
```

The script builds a release executable, assembles `dist/Serein.app`, includes
its Metal shaders, and signs the app with an existing Apple Development
certificate (falling back to Developer ID). You can override the certificate
with `SEREIN_SIGN_IDENTITY`. Ad-hoc signing is deliberately rejected: its
executable-hash identity invalidates macOS capture permissions after a rebuild.
The certificate gives successive builds the same designated requirement. You can
move the app to Applications; it does not depend on the source checkout at
runtime. Notarization for distribution is not included.

Open `Package.swift` in Xcode to edit the app, or use `swift build` and `swift test`.
Use the packaged `.app` for audio/Spotify permissions: its Info.plist supplies
the app identity and usage descriptions.

## Sync with Spotify

Play music in Spotify, then click **System audio** (or press `L`). The sound
coming from your Mac drives the effects directly. A Spotify connection is not
required for audio sync; it only adds track information and playback controls.
The native app does not use or request access to your microphone.

## Give it sound

- **System audio** listens to other apps through ScreenCaptureKit. Play music in
  Spotify, Music, or a browser. macOS requests Screen & System Audio Recording
  permission. Serein analyzes only audio buffers; it does not save screen frames
  or audio, and its own playback is excluded.
- **File** opens a native audio picker. You can also drop a file onto the window
  or open it with Serein in Finder. Formats supported by AVAudioFile play through
  speakers with a timeline, pause/resume, and replay. `Artist - Title` file names
  supply the now-playing label.
- **Stop Listening**, in the more menu, returns to a slow synthetic field. No permission
  is requested at launch.
- **Spotify**, in the bottom controls, optionally reads the running Spotify desktop
  app's title, artist, and playback state through local Apple Events. It also
  supports play/pause and previous/next track. Allow the Automation prompt, then
  choose **System audio** separately to visualize Spotify's audio. No client ID or
  OAuth setup is required by the native app.

If permission is denied, the app returns to Rest and explains where to enable
access. Permission names vary by macOS release. Protected audio may be unavailable
to system capture. Live system capture and Spotify require your OS
permissions and external sources; tests do not grant those permissions.

## The interface

The native interface follows the original Serein design: an expansive opening
wordmark, the original bundled Inter and JetBrains Mono fonts, an unobstructed
canvas, and quiet text-only controls. The current effect appears beneath the
small mark at the top. Track information appears only for a real track. Colour
worlds and tuning are available from the upper-right controls. At smaller window
widths, effect navigation wraps into two balanced rows. `U` hides the controls
and `T` independently hides the track information.

## The effects

Every effect is written once in GLSL, in `src/gl/presets/`, and ported to Metal
by `scripts/port-metal.py` with its geometry, audio mappings, tone mapping,
grain, and transitions intact. The first seven are the originals; Corona, Wick,
and Boreal were added in the same language and by the same rules.

| Effect | What it listens to |
| --- | --- |
| Veil | A membrane held between low and high |
| Bloom | Ink released into water, one ring every two beats |
| Coil | One long body, the spectrum along its length |
| Ink | Pigment lit from inside, pushed by the low end |
| Harp | Sixteen strings, struck and left to ring |
| Fathom | Sunlight bent through the surface onto the seabed |
| Quicksilver | Liquid metal standing up into the shape of the note |
| Corona | An eclipse, its light streaming out on the wind |
| Wick | One flame, the music rising through it as heat |
| Boreal | Curtains of light folding away over a still lake |

All thirteen colour worlds remain: Native, Ember, Glacier, Nocturne, Iris,
Cinder, Peony, Verdigris, Absinthe, Tide, Copper, Bruise, and Aurora. Effects and
palettes dissolve over 1.6 seconds. The selected effect and palette persist
between launches.

The tuning popover controls motion, response, grain, and resolution. Set motion
to zero for a still composition whose light continues to follow the sound.
macOS Reduce Motion starts motion at zero. Rendering is capped at 1.8 million
pixels, and resolution follows the GPU's measured frame time, stepping down
when frames run long and back up when there is room. A window that is covered,
minimised, hidden, or on another Space skips rendering entirely.

## Keyboard

| Key | Action |
| --- | --- |
| `1`–`9`, `0` | Select an effect |
| `N` | Next effect |
| `C` / `Shift C` | Next / previous colour world |
| `L` / `O` | System audio / file |
| `⌘O` | Native audio file picker |
| `Space` | Play / pause a file or connected Spotify |
| `S` | Connect / disconnect Spotify desktop |
| `←` / `→` | Previous / next Spotify track |
| `R` | Recompose with a new seed |
| `F` | Full screen |
| `U` / `T` | Toggle controls / now playing |
| `H` / `?` | Keyboard help |

Bare shortcuts are scoped to the instrument window, leaving file pickers and
text fields their normal behavior. Actions also have native menus or accessible
controls.

## Source map

```text
Package.swift                         Xcode / Swift Package Manager entry point
native/Info.plist                     App identity and privacy descriptions
native/Sources/Serein/
  SereinApp.swift                     Window and macOS menus
  InstrumentView.swift                SwiftUI controls, palettes, file drop
  KeyboardInput.swift                 Canvas-scoped musical shortcuts
  Instrument.swift                    Effect catalogue and settings
  AudioController.swift               System capture and file playback
  AudioAnalysis.swift                 FFT, bands, onsets, tempo, fast/slow spectra
  SpotifyController.swift             Optional Spotify desktop integration
  FeatureStream.swift                 Frame-rate features, continuous across sources
  MetalRenderer.swift                 GPU rendering, transitions, pixel budget
  Resources/Effects.metal             Standalone Metal shader library
native/Tests/                         Audio and GPU regression tests
scripts/build-macos.sh                Build and package a standalone app
scripts/port-metal.py                 Refresh the Metal port from GLSL
```

Each effect compiles into its own pipeline, specialised on a Metal function
constant, so it carries only its own code and register pressure; the packaged
app ships them precompiled in `Effects.metallib` and builds the pipelines off
the main thread. Three independent GPU upload slots prevent the CPU from
mutating textures an in-flight frame is reading, and only the spectral-history
rows recorded since a slot was last used are uploaded to it.

The analyzer advances 512 samples at a time. Every hop it finds kick, snare,
and hat onsets in a short 2,048-sample transform, from the rise in log
magnitude in each band against a threshold that follows the band's own recent
average; every fourth hop it measures levels, bands, and fast and sustained
spectra in a 4,096-sample transform. It also measures the section: where the
current passage sits in the song's own range over the last minute, so a chorus
reads differently from a verse. Snapshots are published every 11 ms, and
`FeatureStream` carries them to the 60 Hz frame: onsets decay every frame, the
beat phase is extrapolated between snapshots, and a change of source or a pause
dissolves over 0.8 seconds, with the beat counter running on continuously.

`swift test` checks silence, known tones at 44.1/48/96 kHz, kick, snare, and hat
detection in a drum pattern over sustained music, the section of a quiet
passage against a loud one, stereo downmix, file decoding, native pause/resume/replay, playback across an output-device change,
ScreenCaptureKit audio-buffer conversion, a 120 BPM pulse train and the beat
phase locking onto it, continuity across a change of source, and all ten
effects on a real Metal GPU under silence, resting, and active audio. GPU checks
reject nonfinite and black output and require distinct frames from each effect.
Save review PNGs with:

```sh
SEREIN_RENDER_DIR=/tmp/serein-renders swift test
```

Two opt-in tools help with effect work. The benchmark reports each effect's GPU
time at the full pixel budget; the review harness decodes a real track, runs it
through the real analyzer at 60 frames a second, and writes contact sheets,
beat-response pairs, and brightness, flicker, and beat-counter measurements:

```sh
SEREIN_BENCH=1 swift test --filter RenderBenchmark
SEREIN_REVIEW=/tmp/review SEREIN_AUDIO=song.mp3 swift test --filter ReviewHarness
```

## Browser reference

The original React/WebGL version remains in `src/` and can still run with
`bun install && bun run dev`. Its documentation and detailed shader design rules
are in [docs/browser-reference.md](docs/browser-reference.md). Refresh the port explicitly with:

```sh
python3 scripts/port-metal.py
swift test
```

Native API references: [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)
and [AVAudioEngine](https://developer.apple.com/documentation/avfaudio/avaudioengine).
