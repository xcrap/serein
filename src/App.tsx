import { useCallback, useEffect, useRef, useState } from "react";
import { Listener, type SourceKind } from "./audio/listener";
import { PRESETS } from "./gl/presets";
import { PALETTES } from "./gl/palettes";
import { Renderer } from "./gl/renderer";
import { Mark, Presets, Sources } from "./ui/Chrome";
import { Keys } from "./ui/Keys";
import { NowPlaying, type Track } from "./ui/NowPlaying";
import { Opening } from "./ui/Opening";

const IDLE_AFTER = 3000;

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
  const activityRef = useRef(performance.now());

  const [preset, setPreset] = useState(0);
  const [palette, setPalette] = useState(0);
  const [seed, setSeed] = useState(() => 1 + Math.random() * 40);
  const [idle, setIdle] = useState(false);
  const [started, setStarted] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [source, setSource] = useState<SourceKind>("resting");
  const [track, setTrack] = useState<Track>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [meter, setMeter] = useState({ position: 0, duration: 0, level: 0 });
  const [failure, setFailure] = useState<string | null>(null);

  const say = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => (current === message ? null : current)), 3000);
  }, []);

  const wake = useCallback(() => {
    activityRef.current = performance.now();
    setIdle(false);
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

      if (now - activityRef.current > IDLE_AFTER) setIdle(true);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    const meterTimer = window.setInterval(() => {
      setMeter({
        position: listener.position,
        duration: listener.duration,
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
    document.body.classList.toggle("is-idle", idle && started && !showKeys);
    return () => document.body.classList.remove("is-idle");
  }, [idle, started, showKeys]);

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
      wake();
      const key = event.key.toLowerCase();

      if (key === " ") {
        event.preventDefault();
        stepPreset(1);
      } else if (key >= "1" && key <= String(PRESETS.length)) {
        setPreset(Number(key) - 1);
      } else if (key === "c") {
        stepPalette(event.shiftKey ? -1 : 1);
      } else if (key === "h" || key === "?") {
        setShowKeys((current) => !current);
      } else if (key === "l") {
        void listenToTab();
      } else if (key === "m") {
        void listenToMic();
      } else if (key === "o") {
        fileInputRef.current?.click();
      } else if (key === "r") {
        setSeed(1 + Math.random() * 40);
      } else if (key === "f") {
        toggleFullscreen();
      } else if (key === "escape") {
        setShowKeys(false);
        if (!started) begin();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [begin, listenToMic, listenToTab, started, stepPalette, stepPreset, toggleFullscreen, wake]);

  useEffect(() => {
    // The pointer only wakes the interface. It never touches the image.
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (file && file.type.startsWith("audio")) void openFile(file);
    };
    const onDragOver = (event: DragEvent) => event.preventDefault();

    window.addEventListener("pointermove", wake);
    window.addEventListener("pointerdown", wake);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragover", onDragOver);
    return () => {
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragover", onDragOver);
    };
  }, [openFile, wake]);

  /* ------------------------------------------------------------ view */

  // The controls stay out of the way until the opening screen has gone.
  const hidden = !started || (idle && !showKeys);

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

        <footer className={`footer chrome${hidden ? " is-hidden" : ""}`}>
          <NowPlaying track={track} position={meter.position} duration={meter.duration} />

          {/* Everything you operate sits in the centre of the frame. */}
          <div className="controls">
            <Presets preset={preset} onPreset={setPreset} />
            <Sources
              source={source}
              onTab={() => void listenToTab()}
              onMic={() => void listenToMic()}
              onFile={() => fileInputRef.current?.click()}
            />
          </div>

          <div />
        </footer>
      </div>

      {notice && <div className="notice">{notice}</div>}
      {showKeys && <Keys onClose={() => setShowKeys(false)} />}

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
