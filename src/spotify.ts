/**
 * Spotify, for the one thing the audio itself cannot tell us: what is playing.
 *
 * Authorisation Code with PKCE, so there is no client secret and nothing ever
 * leaves this machine except the calls to Spotify's own API. The token lives
 * in localStorage and is refreshed when it expires.
 */

const AUTHORIZE = "https://accounts.spotify.com/authorize";
const TOKEN = "https://accounts.spotify.com/api/token";
const PLAYER = "https://api.spotify.com/v1/me/player";
const SCOPE = "user-read-playback-state user-read-currently-playing";

const KEY = {
  clientId: "serein.spotify.clientId",
  verifier: "serein.spotify.verifier",
  access: "serein.spotify.access",
  refresh: "serein.spotify.refresh",
  expires: "serein.spotify.expires",
};

export type SpotifyTrack = {
  title: string;
  artist: string;
  /** Seconds. */
  position: number;
  duration: number;
  playing: boolean;
};

/**
 * Spotify requires an exact match, and for local development it only accepts
 * the loopback address — `localhost` is rejected.
 */
export function redirectUri() {
  return `${window.location.origin}/callback`;
}

export function clientId() {
  return localStorage.getItem(KEY.clientId) ?? "";
}

export function isConnected() {
  return Boolean(localStorage.getItem(KEY.refresh) && clientId());
}

export function disconnect() {
  for (const key of [KEY.access, KEY.refresh, KEY.expires, KEY.verifier]) {
    localStorage.removeItem(key);
  }
}

function randomString(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}

function base64url(buffer: ArrayBuffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Send the browser to Spotify to ask permission. */
export async function beginAuth(id: string) {
  const verifier = randomString(64);
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));

  localStorage.setItem(KEY.clientId, id.trim());
  localStorage.setItem(KEY.verifier, verifier);

  const params = new URLSearchParams({
    client_id: id.trim(),
    response_type: "code",
    redirect_uri: redirectUri(),
    scope: SCOPE,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  window.location.href = `${AUTHORIZE}?${params}`;
}

/** Called on load when Spotify has sent us back with a code. */
export async function completeAuth(code: string): Promise<boolean> {
  const id = clientId();
  const verifier = localStorage.getItem(KEY.verifier);
  if (!id || !verifier) return false;

  const response = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: id,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  });
  if (!response.ok) return false;

  const body = await response.json();
  store(body);
  localStorage.removeItem(KEY.verifier);
  return true;
}

function store(body: { access_token: string; expires_in: number; refresh_token?: string }) {
  localStorage.setItem(KEY.access, body.access_token);
  localStorage.setItem(KEY.expires, String(Date.now() + body.expires_in * 1000 - 30_000));
  if (body.refresh_token) localStorage.setItem(KEY.refresh, body.refresh_token);
}

async function refresh(): Promise<string | null> {
  const id = clientId();
  const token = localStorage.getItem(KEY.refresh);
  if (!id || !token) return null;

  const response = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: id, grant_type: "refresh_token", refresh_token: token }),
  });
  if (!response.ok) {
    disconnect();
    return null;
  }
  const body = await response.json();
  store(body);
  return body.access_token;
}

async function token(): Promise<string | null> {
  const access = localStorage.getItem(KEY.access);
  const expires = Number(localStorage.getItem(KEY.expires) ?? 0);
  if (access && Date.now() < expires) return access;
  return refresh();
}

/**
 * A failed poll and an idle player are not the same thing, and treating them
 * alike is what makes the title blink out whenever a request is rate-limited
 * or a packet goes missing.
 */
export type Poll =
  | { ok: true; track: SpotifyTrack | null }
  | { ok: false };

/** What Spotify is playing right now. Never throws. */
export async function nowPlaying(): Promise<Poll> {
  try {
    const access = await token();
    if (!access) return { ok: false };

    const response = await fetch(`${PLAYER}?additional_types=track,episode`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    // 204 is a valid session with nothing playing; anything else is a failure.
    if (response.status === 204) return { ok: true, track: null };
    if (!response.ok) return { ok: false };

    const body = await response.json();
    const item = body?.item;
    if (!item) return { ok: true, track: null };

    const artist =
      (item.artists ?? []).map((a: { name: string }) => a.name).join(", ") || item.show?.name || "";

    return {
      ok: true,
      track: {
        title: item.name ?? "",
        artist,
        position: (body.progress_ms ?? 0) / 1000,
        duration: (item.duration_ms ?? 0) / 1000,
        playing: Boolean(body.is_playing),
      },
    };
  } catch {
    return { ok: false };
  }
}
