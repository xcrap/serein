/**
 * The first screen: the name, and three ways in. Clicking anywhere else
 * dismisses it, so cancelling the tab picker never leaves you stranded.
 */
export function Opening({
  leaving,
  onTab,
  onMic,
  onFile,
  onDismiss,
}: {
  leaving: boolean;
  onTab: () => void;
  onMic: () => void;
  onFile: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className={`opening${leaving ? " is-leaving" : ""}`} onClick={onDismiss}>
      <div className="opening__inner" onClick={(event) => event.stopPropagation()}>
        <h1 className="opening__title wordmark">Serein</h1>
        <div className="opening__actions">
          <button className="label" onClick={onTab}>Tab</button>
          <button className="label" onClick={onMic}>Microphone</button>
          <button className="label" onClick={onFile}>File</button>
        </div>
      </div>
    </div>
  );
}
