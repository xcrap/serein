export type Track = { title: string; artist: string } | null;

/**
 * Shown only when there is something real to show — Spotify or a local file
 * carry a name, a shared tab carries nothing. The elapsed time is the line
 * itself; a running clock is one more thing counting at you.
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

  return (
    <div className="now">
      <span className="now__title">{track.title}</span>
      {track.artist && <span className="label">{track.artist}</span>}
      {duration > 0 && (
        <div className="now__line">
          <span style={{ width: `${progress * 100}%` }} />
        </div>
      )}
    </div>
  );
}
