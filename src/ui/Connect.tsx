import { useState } from "react";
import { beginAuth, clientId, redirectUri } from "../spotify";

/**
 * One-time setup. Spotify has no anonymous API, so this needs a client ID from
 * an app you create yourself — which also means nothing here is tied to any
 * account but yours.
 */
export function Connect({ onClose }: { onClose: () => void }) {
  const [id, setId] = useState(clientId());
  const [copied, setCopied] = useState(false);
  const uri = redirectUri();

  const copy = () => {
    void navigator.clipboard.writeText(uri).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  };

  return (
    <div className="sheet" onClick={onClose}>
      <div className="sheet__panel" onClick={(event) => event.stopPropagation()}>
        <div className="sheet__title">Spotify</div>

        <ol className="sheet__steps">
          <li>
            Create an app at <span className="sheet__mono">developer.spotify.com/dashboard</span>
          </li>
          <li>
            Add this redirect URI to it:
            <button className="sheet__uri" onClick={copy} title="Copy">
              {uri}
              <span className="sheet__copied">{copied ? "copied" : "copy"}</span>
            </button>
          </li>
          <li>Paste the app’s Client ID below</li>
        </ol>

        <form
          className="sheet__form"
          onSubmit={(event) => {
            event.preventDefault();
            if (id.trim()) void beginAuth(id);
          }}
        >
          <input
            className="sheet__input"
            value={id}
            onChange={(event) => setId(event.target.value)}
            placeholder="Client ID"
            spellCheck={false}
            autoFocus
            onKeyDown={(event) => event.stopPropagation()}
          />
          <button className="sheet__go" type="submit" disabled={!id.trim()}>
            Connect
          </button>
        </form>
      </div>
    </div>
  );
}
