import { useEffect, useState } from "react";
import { PRESETS } from "../gl/presets";
import { PALETTES, swatch } from "../gl/palettes";
import type { SourceKind } from "../audio/listener";

export function Mark({ preset }: { preset: number }) {
  const current = PRESETS[preset];

  // The name crossfades with the picture rather than cutting to the new one
  // while the old preset is still dissolving away.
  const [shown, setShown] = useState(current);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (shown.id === current.id) return;
    setVisible(false);
    const timer = window.setTimeout(() => {
      setShown(current);
      setVisible(true);
    }, 420);
    return () => window.clearTimeout(timer);
  }, [current, shown]);

  return (
    <div className="mark">
      <span className="mark__word">Serein</span>
      <span className="mark__rule" />
      <span className={`meta mark__note${visible ? " is-visible" : ""}`}>
        {shown.name} <span className="meta--dim">· {shown.note}</span>
      </span>
    </div>
  );
}

export function Presets({ preset, onPreset }: { preset: number; onPreset: (index: number) => void }) {
  return (
    <nav className="presets">
      {PRESETS.map((item, index) => (
        <button
          key={item.id}
          className={index === preset ? "is-active" : ""}
          onClick={() => onPreset(index)}
          title={item.note}
        >
          {item.name}
        </button>
      ))}
    </nav>
  );
}

export function Palette({ palette, onPalette }: { palette: number; onPalette: (index: number) => void }) {
  return (
    <div className="palette">
      {PALETTES.map((world, index) => (
        <button
          key={world.name}
          className={index === palette ? "is-active" : ""}
          style={{ background: swatch(index) }}
          onClick={() => onPalette(index)}
          title={world.name}
          aria-label={`${world.name} colour world`}
        />
      ))}
    </div>
  );
}

export function Sources({
  source,
  spotify,
  onTab,
  onMic,
  onFile,
  onSpotify,
}: {
  source: SourceKind;
  spotify: boolean;
  onTab: () => void;
  onMic: () => void;
  onFile: () => void;
  onSpotify: () => void;
}) {
  // The active source is simply the white one — saying "live" beside it reads
  // as one more thing to choose.
  return (
    <div className="source">
      <button className={source === "tab" ? "is-live" : ""} onClick={onTab}>Tab</button>
      <button className={source === "mic" ? "is-live" : ""} onClick={onMic}>Room</button>
      <button className={source === "file" ? "is-live" : ""} onClick={onFile}>File</button>
      {/* Not a source of sound — a source of the title. */}
      <button className={spotify ? "is-live" : ""} onClick={onSpotify}>Spotify</button>
    </div>
  );
}
