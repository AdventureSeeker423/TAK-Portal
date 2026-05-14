/**
 * Settings → TAK maintenance: wait for Marti/API health, then stream takserver-api.log over SSH.
 */

const takSvc = require("./tak.service");
const takSshSvc = require("./takSsh.service");
const { getBool } = require("./env");

const HEALTH_POLL_MS = 3000;
const HEALTH_MAX_WAIT_MS = 15 * 60 * 1000;
const TAKSERVER_API_LOG = "/opt/tak/logs/takserver-api.log";

async function checkTakApiHealthyOnce() {
  if (!takSvc.isTakConfigured()) return { ok: false, detail: "tak_url_missing" };
  if (getBool("TAK_BYPASS_ENABLED", false)) return { ok: false, detail: "tak_bypass_enabled" };
  try {
    const client = takSvc.buildTakAxios({ timeout: 12000 });
    const res = await client.get("/api/certadmin/cert", {
      params: { page: 0, size: 1 },
      validateStatus: () => true,
    });
    if (res.status >= 200 && res.status < 500) return { ok: true, detail: String(res.status) };
    return { ok: false, detail: `http_${res.status}` };
  } catch (e) {
    const code = e?.code || "";
    return { ok: false, detail: code || e?.message || String(e) };
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(t);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      },
      { once: true }
    );
  });
}

/**
 * @param {(obj: Record<string, unknown>) => void} send
 * @param {AbortSignal} signal
 */
async function streamHealthWaitAndTail({ send, signal }) {
  const deadline = Date.now() + HEALTH_MAX_WAIT_MS;
  let attempt = 0;
  let sawHealthy = false;

  while (Date.now() < deadline && !signal.aborted) {
    attempt += 1;
    const h = await checkTakApiHealthyOnce();
    send({ type: "health_poll", attempt, ok: h.ok, detail: h.detail });
    if (h.ok) {
      sawHealthy = true;
      send({ type: "healthy", at: new Date().toISOString(), attempts: attempt });
      break;
    }
    try {
      await sleep(HEALTH_POLL_MS, signal);
    } catch {
      return;
    }
  }

  if (signal.aborted) return;

  if (!sawHealthy) {
    send({
      type: "health_timeout",
      at: new Date().toISOString(),
      message:
        "TAK Marti API did not respond as healthy within the wait window. Tailing the log anyway so you can inspect takserver-api activity.",
    });
  }

  const outState = { buf: "" };
  const errState = { buf: "" };

  const feed = (tag, state) => (chunk) => {
    state.buf += chunk;
    const parts = state.buf.split(/\r?\n/);
    state.buf = parts.pop() || "";
    for (const line of parts) {
      send({ type: "log_line", stream: tag, line });
    }
  };

  const flushRemain = (tag, state) => {
    const tail = String(state.buf || "").replace(/\r$/, "");
    state.buf = "";
    if (tail) send({ type: "log_line", stream: tag, line: tail });
  };

  const cmd = `sudo tail -n 150 -f ${TAKSERVER_API_LOG}`;

  await new Promise((resolve) => {
    let settled = false;
    const once = () => {
      if (settled) return;
      settled = true;
      flushRemain("stdout", outState);
      flushRemain("stderr", errState);
      send({ type: "tail_end", at: new Date().toISOString() });
      resolve();
    };

    takSshSvc.streamRemoteSshExec(cmd, {
      signal,
      onStdoutChunk: feed("stdout", outState),
      onStderrChunk: feed("stderr", errState),
      onClose: once,
      onError: (err) => {
        send({
          type: "tail_error",
          at: new Date().toISOString(),
          message: err?.message || String(err),
        });
      },
    });
  });
}

module.exports = {
  checkTakApiHealthyOnce,
  streamHealthWaitAndTail,
  TAKSERVER_API_LOG,
};
