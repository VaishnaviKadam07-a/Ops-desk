const TOKEN_KEY = 'ops_token';
export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
export const setToken = (t) => {
  try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked */ }
};

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code;
    this.extra = body?.error || {};
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

/** One key per user intent. Reuse it when retrying the same action so the server can recognise a replay. */
export const newKey = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Network retries happen only when they are safe: reads, or writes that carry an Idempotency-Key.
 * That is what makes "I clicked, the connection dropped, did it work?" a non-problem.
 */
export async function api(method, path, { body, key, signal } = {}) {
  const headers = { 'content-type': 'application/json' };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (key) headers['Idempotency-Key'] = key;
  const retryable = method === 'GET' || !!key;

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(`/api${path}`, { method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (retryable && attempt < 3) { await sleep(400 * 2 ** attempt); continue; }
      throw new ApiError(0, { error: { code: 'network', message: 'Network problem. Check your connection and try again.' } });
    }
    if ([502, 503, 504].includes(res.status) && retryable && attempt < 3) { await sleep(400 * 2 ** attempt); continue; }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (res.status === 401 && path !== '/auth/login') { setToken(null); onUnauthorized(); }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }
}
