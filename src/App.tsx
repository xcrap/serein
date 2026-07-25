import { useCallback, useEffect, useRef, useState } from "react";
import { Listener, type SourceKind } from "./audio/listener";
import { PRESETS } from "./gl/presets";
import { PALETTES } from "./gl/palettes";
import { Renderer } from "./gl/renderer";
import { Mark, Presets, Sources } from "./ui/Chrome";
import { Keys } from "./ui/Keys";
import { NowPlaying, type Track } from "./ui/NowPlaying";
import { Opening } from "./ui/Opening";
import { Connect } from "./ui/Connect";
import {
  completeAuth,
  controlPlayback,
  disconnect,
  hasPlaybackControl,
  isConnected,
  nowPlaying,
  type PlaybackCommand,
  type SpotifyTrack,
} from "./spotify";

/** "Artist - Title.flac" is a convention worth honouring. */
function readFileName(name: string): Track {
  const bare = name.replace(/\.[a-z0-9]+$/i, "").replace(/_/g, " ").trim();
  const split = bare.split(/\s+[-–—]\s+/);
  if (split.length >= 2) {
    return { artist: split[0].trim(), title: split.slice(1).join(" — ").trim() };
  }
  return { artist: "", title: bare };
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listenerRef = useRef<Listener | null>(null);
  const rendererRef = useRef<Renderer | null>(null);

  const [preset, setPreset] = useState(0);
  const [palette, setPalette] = useState(0);
  const [seed, setSeed] = useState(() => 1 + Math.random() * 40);
  const [started, setStarted] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  // The interface never hides itself — U hides the controls, T hides what is
  // playing, and they stay where you put them.
  const [chromeOff, setChromeOff] = useState(false);
  const [titleOff, setTitleOff] = useState(false);
  const [spotify, setSpotify] = useState(() => isConnected());
  const [showConnect, setShowConnect] = useState(false);
  const [remote, setRemote] = useState<Track>(null);
  // The last good reading from Spotify, plus when it arrived, so the position
  // can run on locally between polls instead of stepping three seconds at a
  // time. Kept in a ref: it is read by the meter tick, not rendered.
  const remoteRef = useRef<
    { position: number; duration: number; playing: boolean; at: number } | null
  >(null);
  const pollFailures = useRef(0);
  const [source, setSource] = useState<SourceKind>("resting");
  const [track, setTrack] = useState<Track>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [meter, setMeter] = useState({ position: 0, duration: 0, level: 0 });
  const [failure, setFailure] = useState<string | null>(null);

  const say = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 3000);
  }, []);



  /* ------------------------------------------------------------ engine */

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const listener = new Listener();
    let renderer: Renderer;
    try {
      renderer = new Renderer(canvas);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      return;
    }

    listenerRef.current = listener;
    rendererRef.current = renderer;
    listener.onended = () => {
      setSource("resting");
      setTrack(null);
      say("the shared tab closed");
    };

    renderer.setPreset(PRESETS[0], true);

    let frame = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000));
      last = now;

      const features = listener.update(dt);
      renderer.render(features, dt);

      // Live read-out of what the analyser hears, for checking against real music.
      (window as unknown as { serein: unknown }).serein = { features, source: listener.kind };

      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    const meterTimer = window.setInterval(() => {
      // Spotify wins when it is connected and playing, otherwise the local
      // file does. Two writers racing here is what made the timeline jump.
      const spotifyClock = remoteRef.current;
      const elapsed = spotifyClock && spotifyClock.playing
        ? (performance.now() - spotifyClock.at) / 1000
        : 0;

      setMeter({
        position: spotifyClock
          ? Math.min(spotifyClock.duration, spotifyClock.position + elapsed)
          : listener.position,
        duration: spotifyClock ? spotifyClock.duration : listener.duration,
        level: listener.kind === "resting" ? 0 : listener.features.level,
      });
    }, 120);

    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(meterTimer);
      listener.release();
      renderer.dispose();
      listenerRef.current = null;
      rendererRef.current = null;
    };
  }, [say]);

  useEffect(() => {
    rendererRef.current?.setPreset(PRESETS[preset]);
  }, [preset]);

  useEffect(() => {
    rendererRef.current?.setPalette(palette);
  }, [palette]);

  useEffect(() => {
    if (rendererRef.current) rendererRef.current.seed = seed;
  }, [seed]);

  useEffect(() => {
    document.body.classList.toggle("is-idle", started && !showKeys && chromeOff && titleOff);
    return () => document.body.classList.remove("is-idle");
  }, [chromeOff, showKeys, started, titleOff]);

  /* ------------------------------------------------------------ spotify */

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("code");
    if (!code) return;

    // Consume the one-use code before starting the request. React Strict Mode
    // runs effects twice in development; leaving it in the URL until the
    // request finished made the second run exchange the same code again and
    // report a false failure after the first exchange had already succeeded.
    window.history.replaceState({}, "", window.location.origin + "/");
    void completeAuth(code).then((ok) => {
      if (window.opener && window.opener !== window) {
        window.opener.postMessage({ type: "serein:spotify-auth", ok }, window.location.origin);
        window.close();
        return;
      }
      setSpotify(ok);
      say(ok ? "spotify connected" : "spotify could not connect");
    });
  }, [say]);

  useEffect(() => {
    const receiveAuth = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== "serein:spotify-auth") return;

      const ok = Boolean(event.data.ok);
      setSpotify(ok);
      setShowConnect(false);
      say(ok ? "spotify connected — audio kept playing" : "spotify could not connect");
    };
    window.addEventListener("message", receiveAuth);
    return () => window.removeEventListener("message", receiveAuth);
  }, [say]);

  useEffect(() => {
    if (!spotify) {
      setRemote(null);
      return;
    }
    let alive = true;
    const poll = async () => {
      const result = await nowPlaying();
      if (!alive) return;

      if (!result.ok) {
        // A dropped or throttled request is not "nothing is playing". Hold the
        // last title rather than blinking it out; give up after three in a row.
        if (++pollFailures.current >= 3) {
          remoteRef.current = null;
          setRemote(null);
        }
        return;
      }

      pollFailures.current = 0;
      const track = result.track;
      if (!track) {
        remoteRef.current = null;
        setRemote(null);
        return;
      }

      remoteRef.current = {
        position: track.position,
        duration: track.duration,
        playing: track.playing,
        at: performance.now(),
      };
      setRemote((current) =>
        current && current.title === track.title && current.artist === track.artist
          ? current
          : { title: track.title, artist: track.artist },
      );
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      alive = false;
      remoteRef.current = null;
      pollFailures.current = 0;
      window.clearInterval(timer);
    };
  }, [spotify]);

  const toggleSpotify = useCallback(() => {
    if (isConnected()) {
      disconnect();
      setSpotify(false);
      setRemote(null);
      say("spotify disconnected");
      return;
    }
    setShowConnect(true);
  }, [say]);

  const applySpotifyTrack = useCallback((next: SpotifyTrack | null) => {
    if (!next) {
      remoteRef.current = null;
      setRemote(null);
      return;
    }

    remoteRef.current = {
      position: next.position,
      duration: next.duration,
      playing: next.playing,
      at: performance.now(),
    };
    setRemote((current) =>
      current && current.title === next.title && current.artist === next.artist
        ? current
        : { title: next.title, artist: next.artist },
    );
  }, []);

  const canControlSpotify = useCallback(() => {
    if (!isConnected()) {
      say("connect spotify to use playback keys");
      return false;
    }
    // A successful token is the source of truth. This also repairs the UI
    // state if an older double-run callback incorrectly marked it disconnected.
    setSpotify(true);
    if (!hasPlaybackControl()) {
      say("reconnect spotify once to enable playback keys");
      return false;
    }
    return true;
  }, [say]);

  const explainPlaybackFailure = useCallback(
    (status: number) => {
      if (status === 401) say("reconnect spotify to use playback keys");
      else if (status === 403) say("spotify playback control needs premium");
      else if (status === 404) say("open spotify on a device first");
      else say("spotify could not change playback");
    },
    [say],
  );

  const toggleSpotifyPlayback = useCallback(async () => {
    if (!canControlSpotify()) return;

    let clock = remoteRef.current;
    if (!clock) {
      const result = await nowPlaying();
      if (!result.ok) {
        say("spotify could not read the player");
        return;
      }
      if (!result.track) {
        say("open spotify on a device first");
        return;
      }
      applySpotifyTrack(result.track);
      clock = remoteRef.current;
    }
    if (!clock) return;

    const command: PlaybackCommand = clock.playing ? "pause" : "play";
    const result = await controlPlayback(command);
    if (!result.ok) {
      explainPlaybackFailure(result.status);
      return;
    }

    const elapsed = clock.playing ? (performance.now() - clock.at) / 1000 : 0;
    remoteRef.current = {
      ...clock,
      position: Math.min(clock.duration, clock.position + elapsed),
      playing: !clock.playing,
      at: performance.now(),
    };
    say(command === "pause" ? "spotify paused" : "spotify playing");
  }, [applySpotifyTrack, canControlSpotify, explainPlaybackFailure, say]);

  const skipSpotifyTrack = useCallback(
    async (command: "previous" | "next") => {
      if (!canControlSpotify()) return;

      const result = await controlPlayback(command);
      if (!result.ok) {
        explainPlaybackFailure(result.status);
        return;
      }

      say(command === "previous" ? "previous spotify track" : "next spotify track");
      const previous = remote;
      const delays = [250, 500, 1000];
      const refreshTitle = (attempt: number) => {
        window.setTimeout(() => {
          void nowPlaying().then((fresh) => {
            const unchanged =
              previous &&
              fresh.ok &&
              fresh.track &&
              fresh.track.title === previous.title &&
              fresh.track.artist === previous.artist;

            // Spotify can briefly return the old item (or no item) while its
            // active device changes track. Retry before updating the widget.
            if (attempt < delays.length - 1 && (!fresh.ok || !fresh.track || unchanged)) {
              refreshTitle(attempt + 1);
              return;
            }
            if (fresh.ok) applySpotifyTrack(fresh.track);
          });
        }, delays[attempt]);
      };
      refreshTitle(0);
    },
    [applySpotifyTrack, canControlSpotify, explainPlaybackFailure, remote, say],
  );

  /* ------------------------------------------------------------ sources */

  const begin = useCallback(() => {
    setLeaving(true);
    window.setTimeout(() => setStarted(true), 1300);
  }, []);

  const listenToTab = useCallback(async () => {
    const listener = listenerRef.current;
    if (!listener) return;
    if (listener.kind === "tab") {
      listener.release();
      setSource("resting");
      setTrack(null);
      say("stopped listening");
      return;
    }
    try {
      await listener.listenToTab();
      setSource("tab");
      setTrack(null);
      begin();
    } catch (error) {
      const reason = error instanceof Error ? error.message : "";
      say(reason === "no-audio-shared" ? "that tab was shared without its audio" : "nothing was shared");
    }
  }, [begin, say]);

  const listenToMic = useCallback(async () => {
    const listener = listenerRef.current;
    if (!listener) return;
    if (listener.kind === "mic") {
      listener.release();
      setSource("resting");
      say("stopped listening");
      return;
    }
    try {
      await listener.listenToMic();
      setSource("mic");
      setTrack(null);
      begin();
    } catch {
      say("the microphone was not available");
    }
  }, [begin, say]);

  const openFile = useCallback(
    async (file: File) => {
      const listener = listenerRef.current;
      if (!listener) return;
      try {
        await listener.listenToFile(file);
        setSource("file");
        setTrack(readFileName(file.name));
        begin();
      } catch {
        say("that file could not be played");
      }
    },
    [begin, say],
  );

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  }, []);

  /* ------------------------------------------------------------ input */

  const stepPreset = useCallback((by: number) => {
    setPreset((current) => (current + by + PRESETS.length) % PRESETS.length);
  }, []);

  const stepPalette = useCallback((by: number) => {
    setPalette((current) => (current + by + PALETTES.length) % PALETTES.length);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (event.repeat && [" ", "arrowleft", "arrowright"].includes(key)) return;

      if (key === " ") {
        event.preventDefault();
        void toggleSpotifyPlayback();
      } else if (key === "n") {
        stepPreset(1);
      } else if (key === "arrowleft") {
        event.preventDefault();
        void skipSpotifyTrack("previous");
      } else if (key === "arrowright") {
        event.preventDefault();
        void skipSpotifyTrack("next");
      } else if (key >= "0" && key <= "9") {
        // 1–9 then 0 for the tenth. Comparing the key against
        // String(PRESETS.length) only worked while there were fewer than ten:
        // "5" <= "10" is false, so every digit but 1 stopped working.
        const index = key === "0" ? 9 : Number(key) - 1;
        if (index < PRESETS.length) setPreset(index);
      } else if (key === "c") {
        stepPalette(event.shiftKey ? -1 : 1);
      } else if (key === "h" || key === "?") {
        setShowKeys((current) => !current);
      } else if (key === "u") {
        setChromeOff((current) => !current);
        setShowKeys(false);
      } else if (key === "t") {
        setTitleOff((current) => !current);
      } else if (key === "l") {
        void listenToTab();
      } else if (key === "m") {
        void listenToMic();
      } else if (key === "o") {
        fileInputRef.current?.click();
      } else if (key === "s") {
        toggleSpotify();
      } else if (key === "r") {
        setSeed(1 + Math.random() * 40);
      } else if (key === "f") {
        toggleFullscreen();
      } else if (key === "escape") {
        setShowKeys(false);
        setShowConnect(false);
        if (!started) begin();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    begin,
    listenToMic,
    listenToTab,
    skipSpotifyTrack,
    started,
    stepPalette,
    stepPreset,
    toggleFullscreen,
    toggleSpotify,
    toggleSpotifyPlayback,
  ]);

  useEffect(() => {
    // The pointer never touches the image, and no longer reveals anything —
    // the interface only moves when you ask it to.
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (file && file.type.startsWith("audio")) void openFile(file);
    };
    const onDragOver = (event: DragEvent) => event.preventDefault();

    window.addEventListener("drop", onDrop);
    window.addEventListener("dragover", onDragOver);
    return () => {
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragover", onDragOver);
    };
  }, [openFile]);

  /* ------------------------------------------------------------ view */

  // The controls stay out of the way until the opening screen has gone.
  const hidden = !started || chromeOff;
  const titleHidden = !started || titleOff;

  if (failure) {
    return (
      <div className="opening">
        <div className="opening__inner">
          <h1 className="opening__title wordmark">Serein</h1>
          <p className="label label--bright">{failure}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      <canvas ref={canvasRef} />

      <div className="overlay">
        <header className={`header chrome${hidden ? " is-hidden" : ""}`}>
          <Mark preset={preset} />
        </header>

        <section />

        <footer className="footer">
          <div className={`chrome${titleHidden ? " is-hidden" : ""}`}>
            <NowPlaying track={remote ?? track} position={meter.position} duration={meter.duration} />
          </div>

          {/* Everything you operate sits in the centre of the frame. */}
          <div className={`controls chrome${hidden ? " is-hidden" : ""}`}>
            <Presets preset={preset} onPreset={setPreset} />
            <Sources
              source={source}
              spotify={spotify}
              onTab={() => void listenToTab()}
              onMic={() => void listenToMic()}
              onFile={() => fileInputRef.current?.click()}
              onSpotify={toggleSpotify}
            />
          </div>

          <div />
        </footer>
      </div>

      {notice && <div className="notice">{notice}</div>}
      {showKeys && <Keys onClose={() => setShowKeys(false)} />}
      {showConnect && <Connect onClose={() => setShowConnect(false)} />}

      {!started && (
        <Opening
          leaving={leaving}
          onTab={() => void listenToTab()}
          onMic={() => void listenToMic()}
          onFile={() => fileInputRef.current?.click()}
          onDismiss={begin}
        />
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        style={{ display: "none" }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void openFile(file);
          event.target.value = "";
        }}
      />
    </>
  );
}
