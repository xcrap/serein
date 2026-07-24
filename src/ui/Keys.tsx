const BINDINGS: [string, string][] = [
  ["space", "next preset"],
  ["1 – 6", "choose a preset"],
  ["c", "next colour world"],
  ["shift c", "previous colour world"],
  ["l", "listen to a tab"],
  ["m", "listen to the room"],
  ["o", "open an audio file"],
  ["r", "recompose"],
  ["f", "fullscreen"],
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
