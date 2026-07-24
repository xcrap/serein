export type Track = { title: string; artist: string } | null;

function clock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Shown only when there is something real to show — a file carries a name and
 * a duration, a shared tab carries neither. Nothing here asks you to type.
 */
export function NowPlaying({
  track,
  position,
  duration,
}: {
  track: Track;
  position: number;
  duration: number;
}) {
  if (!track) return <div className="now" />;

  const progress = duration > 0 ? Math.min(1, position / duration) : 0;
  const under = [track.artist, duration > 0 ? `${clock(position)} — ${clock(duration)}` : ""]
    .filter(Boolean)
    .join("   ·   ");

  return (
    <div className="now">
      <span className="now__title">{track.title}</span>
      {under && <span className="label">{under}</span>}
      {duration > 0 && (
        <div className="now__line">
          <span style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </div>
  );
}
