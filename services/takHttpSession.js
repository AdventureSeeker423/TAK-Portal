/**
 * Process-wide TAK mTLS HTTP session cookies (JSESSIONID).
 * Axios does not persist Set-Cookie; without this, Tomcat mints a session per request.
 */
"use strict";

const COOKIE_ATTR = /^(Max-Age|Expires|Path|Domain|Secure|HttpOnly|SameSite)$/i;

function createCookieStore() {
  /** @type {Map<string, string>} */
  const cookies = new Map();

  function applyFromSetCookie(setCookie) {
    const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    for (const item of list) {
      const pair = String(item || "").split(";")[0];
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name || COOKIE_ATTR.test(name)) continue;
      cookies.set(name, value);
    }
  }

  function applyFromResponseHeaders(headers) {
    if (!headers) return;
    let raw = null;
    if (typeof headers.getSetCookie === "function") {
      try {
        raw = headers.getSetCookie();
      } catch (_) {
        raw = null;
      }
    }
    if (raw == null || (Array.isArray(raw) && !raw.length)) {
      raw = headers["set-cookie"] || headers["Set-Cookie"] || null;
    }
    applyFromSetCookie(raw);
  }

  function header() {
    if (!cookies.size) return "";
    return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  function snapshot() {
    return Object.fromEntries(cookies);
  }

  function clear() {
    cookies.clear();
  }

  return {
    applyFromSetCookie,
    applyFromResponseHeaders,
    header,
    snapshot,
    clear,
  };
}

function attachCookieStore(client, store) {
  if (!client || !store || !client.interceptors) return client;

  client.interceptors.request.use((config) => {
    const h = store.header();
    if (!h) return config;
    config.headers = config.headers || {};
    const headers = config.headers;
    if (typeof headers.get === "function") {
      if (!headers.get("Cookie") && !headers.get("cookie")) {
        if (typeof headers.set === "function") headers.set("Cookie", h);
        else headers.Cookie = h;
      }
    } else if (!headers.Cookie && !headers.cookie) {
      headers.Cookie = h;
    }
    return config;
  });

  function capture(res) {
    if (res && res.headers) store.applyFromResponseHeaders(res.headers);
    return res;
  }

  client.interceptors.response.use(capture, (err) => {
    if (err && err.response && err.response.headers) {
      store.applyFromResponseHeaders(err.response.headers);
    }
    return Promise.reject(err);
  });

  return client;
}

let _sharedStore = null;

function getSharedTakCookieStore() {
  if (!_sharedStore) _sharedStore = createCookieStore();
  return _sharedStore;
}

/** Test-only: drop the process-wide store. */
function resetSharedTakCookieStore() {
  if (_sharedStore) _sharedStore.clear();
  _sharedStore = null;
}

module.exports = {
  createCookieStore,
  attachCookieStore,
  getSharedTakCookieStore,
  resetSharedTakCookieStore,
};
