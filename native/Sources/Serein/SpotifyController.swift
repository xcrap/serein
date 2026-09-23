import AppKit

/// Optional local desktop integration. No OAuth credentials or network service.
@MainActor
final class SpotifyController: ObservableObject {
    @Published private(set) var connected = false
    @Published private(set) var title = ""
    @Published private(set) var artist = ""
    @Published private(set) var playing = false
    @Published var error: String?
    private var timer: Timer?
    private var polling = false
    private var generation = 0
    private let queue = DispatchQueue(label: "pt.serein.spotify", qos: .utility)

    func toggle() {
        if connected { disconnect(); return }
        guard !NSRunningApplication.runningApplications(withBundleIdentifier: "com.spotify.client").isEmpty else {
            error = "Open the Spotify desktop app first, then connect here. Choose System to make its audio drive the visuals."
            return
        }
        connected = true
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
    }

    private func disconnect() {
        generation += 1
        timer?.invalidate(); timer = nil
        connected = false; title = ""; artist = ""; playing = false
    }

    private func poll() {
        guard connected, !polling else { return }
        guard !NSRunningApplication.runningApplications(withBundleIdentifier: "com.spotify.client").isEmpty else { disconnect(); return }
        polling = true
        let token = generation
        run("return {name of current track, artist of current track, player state as string}") { [weak self] result in
            guard let self else { return }
            self.polling = false
            guard self.connected, self.generation == token else { return }
            switch result {
            case .success(let items):
                self.title = items.first ?? ""
                self.artist = items.count > 1 ? items[1] : ""
                self.playing = items.last == "playing"
            case .failure(let error):
                self.disconnect()
                self.error = "Spotify could not be read. Allow Serein to control Spotify in System Settings → Privacy & Security → Automation.\n\n\(error.localizedDescription)"
            }
        }
    }

    func command(_ command: String) {
        guard connected, ["playpause", "next track", "previous track"].contains(command) else { return }
        run(command) { [weak self] result in
            if case .failure(let error) = result { self?.error = error.localizedDescription }
            self?.poll()
        }
    }

    private func run(_ body: String, completion: @escaping @MainActor @Sendable (Result<[String], Error>) -> Void) {
        queue.async {
            var details: NSDictionary?
            let script = NSAppleScript(source: "tell application id \"com.spotify.client\"\n\(body)\nend tell")
            let result = script?.executeAndReturnError(&details)
            let output: Result<[String], Error>
            if let details {
                output = .failure(SereinError.message(details[NSAppleScript.errorMessage] as? String ?? "Spotify did not respond."))
            } else if let result, result.numberOfItems > 0 {
                output = .success((1...result.numberOfItems).map { result.atIndex($0)?.stringValue ?? "" })
            } else { output = .success([]) }
            Task { @MainActor in completion(output) }
        }
    }
}
