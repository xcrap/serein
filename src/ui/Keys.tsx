import { PRESETS } from "../gl/presets";

// Read off the preset list rather than written out, so it cannot go stale
// again when presets are added or dropped.
const BINDINGS: [string, string][] = [
  ["space", "spotify — play or pause"],
  ["n", "next preset"],
  ["← / →", "spotify — previous or next track"],
  [`1 – ${PRESETS.length}`, "choose a preset"],
  ["c", "next colour world"],
  ["shift c", "previous colour world"],
  ["l", "listen to a tab"],
  ["m", "listen to the room"],
  ["o", "open an audio file"],
  ["s", "spotify — connect or disconnect"],
  ["r", "recompose"],
  ["f", "fullscreen"],
  ["u", "hide the controls"],
  ["t", "hide what is playing"],
  ["h", "close this"],
];

export function Keys({ onClose }: { onClose: () => void }) {
  return (
    <div className="keys" onClick={onClose}>
      <dl className="keys__panel">
        <div className="keys__title">Keys</div>
        {BINDINGS.map(([key, action]) => (
          <div key={key} style={{ display: "contents" }}>
            <dt>{key}</dt>
            <dd>{action}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
