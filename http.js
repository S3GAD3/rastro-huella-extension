/* RASTRO · HUELLA — motor de peticiones
   - credentials: 'omit' (nunca viajan las sesiones del investigador)
   - cancelación real (Detener aborta las peticiones en vuelo)
   - tiempo máximo por petición, un reintento ante fallo de red / 5xx / 429 breve
   - registro de cada intento con hora UTC, código, tamaño y SHA-256 del cuerpo */
import { sha256, parseJson } from './util.js';

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
  signal?.addEventListener('abort', abort, { once: true });
});

export function createRequester({ trace, timeout, signal }) {
  const cooldowns = new Map();
  async function attempt(url, opts, entry) {
    const t0 = performance.now();
    try {
      const res = await fetch(url, {
        method: opts.method || 'GET',
        headers: opts.headers || {},
        body: opts.body,
        credentials: 'omit',
        cache: 'no-store',
        redirect: opts.redirect || 'follow',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)])
      });
      let text = null, bytes;
      if (opts.as === 'blob') {
        const buf = await res.arrayBuffer();
        bytes = new Uint8Array(buf);
        entry.bytes = bytes.byteLength;
        entry.sha256 = await sha256(bytes);
      } else {
        text = await res.text();
        entry.bytes = new TextEncoder().encode(text).byteLength;
        entry.sha256 = await sha256(text);
      }
      Object.assign(entry, { status: res.type === 'opaqueredirect' ? 0 : res.status, finalUrl: res.url !== url ? res.url : null, ms: Math.round(performance.now() - t0) });
      return {
        status: res.type === 'opaqueredirect' ? 0 : res.status, ok: res.ok, url: res.url || url, redirected: res.redirected, text, bytes,
        type: res.headers.get('content-type') || '', retryAfter: Number(res.headers.get('retry-after')) || 0,
        sha256: entry.sha256, ts: entry.ts,
        json() { return parseJson(text); }
      };
    } catch (e) {
      entry.ms = Math.round(performance.now() - t0);
      entry.error = signal.aborted ? 'detenida' : (e && e.name === 'TimeoutError' ? 'timeout' : (e && e.message) || String(e));
      throw e;
    }
  }

  /* ctx por fuente y consulta; `tag` distingue peticiones de control o de avatar */
  return function makeCtx(sourceId, queryId, tag = '') {
    const ctx = {
      last: null,
      /* Consulta ejecutada por el service worker dentro de una pestaña (p. ej. Google con sesión).
         Se registra en la trazabilidad igual que una petición directa. */
      async bridge(message, label) {
        if (signal.aborted) throw signal.reason;
        const entry = { ts: new Date().toISOString(), query: queryId, source: sourceId, tag: tag || 'pestaña', method: 'PESTAÑA', url: label, status: null, ms: null, bytes: null, sha256: null, finalUrl: null, error: null, attempt: 1 };
        trace.push(entry);
        const t0 = performance.now();
        const res = await new Promise(resolve => {
          try { chrome.runtime.sendMessage(message, r => resolve(r || { ok: false, error: (chrome.runtime.lastError || {}).message || 'sin respuesta' })); }
          catch (e) { resolve({ ok: false, error: String((e && e.message) || e) }); }
        });
        entry.ms = Math.round(performance.now() - t0);
        if (!res.ok) { entry.error = res.error === 'nosession' ? 'sin sesión' : res.error; return res; }
        const text = String(res.text || '');
        entry.status = res.status;
        entry.bytes = new TextEncoder().encode(text).byteLength;
        entry.sha256 = await sha256(text);
        if (signal.aborted) throw signal.reason;
        const r = { ...res, url: label, text, sha256: entry.sha256, ts: entry.ts, json() { return parseJson(text); } };
        ctx.last = r;
        return r;
      },
      async req(url, opts = {}) {
        const host = new URL(url).host;
        if (signal.aborted) throw signal.reason;
        if ((cooldowns.get(host) || 0) > Date.now()) throw new Error('HTTP 429: pausa temporal de la plataforma');
        for (let n = 0; ; n++) {
          const entry = { ts: new Date().toISOString(), query: queryId, source: sourceId, tag, method: opts.method || 'GET', url, status: null, ms: null, bytes: null, sha256: null, finalUrl: null, error: null, attempt: n + 1 };
          trace.push(entry);
          try {
            const r = await attempt(url, opts, entry);
            if (r.status === 429) cooldowns.set(host, Date.now() + Math.max(60, r.retryAfter) * 1000);
            const transient = r.status >= 500;
            if (n === 0 && transient && !opts.noRetry) { await sleep(r.retryAfter ? r.retryAfter * 1000 : 1200, signal); continue; }
            if (!opts.as) ctx.last = r;
            return r;
          } catch (e) {
            if (signal.aborted || n > 0 || opts.noRetry || (e && e.name === 'TimeoutError')) throw e;
            await sleep(800, signal);
          }
        }
      }
    };
    return ctx;
  };
}
