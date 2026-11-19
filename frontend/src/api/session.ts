// Per-visitor session id, sent as `X-Session-Id` so that each visitor of the public demo gets
// their own plan on the server. A new id is made on every page load, so a fresh visit (or a reload)
// always starts from the standard plan; route-sheet links carry the id explicitly (`?s=…`).

const URL_PARAM = 's';
let pageId: string | null = null;

function randomId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // crypto.randomUUID needs a secure context; fall back to a v4 UUID from getRandomValues
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function getSessionId(): string {
  return (pageId ??= randomId());
}

/** Query string that lets a shared route-sheet link show this session's plan on another device. */
export const sessionQuery = (id = getSessionId()) => `?${URL_PARAM}=${encodeURIComponent(id)}`;

/** Session id carried by a shared link (`?s=…`), if any. */
export function sessionFromUrl(search: string): string | null {
  return new URLSearchParams(search).get(URL_PARAM);
}
