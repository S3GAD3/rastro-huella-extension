/* RASTRO · HUELLA — motor de búsqueda (estado, ejecución, pivotes, correlación, persistencia) */
import * as U from './util.js';
import { createRequester } from './http.js';
import { SOURCES_USER, SOURCES_EMAIL, UNK, tabParse } from './sources.js';

export const MAX_AUTO_PIVOTS = 5;
const AVATAR_MATCH_BITS = 6;              // distancia Hamming máxima entre dHash de 64 bits
const EVIDENCE_MAX_CHARS = 400_000;       // tope por respuesta guardada como evidencia

export const state = {
  settings: { avatars: true, third: false, google: false, auto: false, tab: false, concurrency: 3, emailLimit: 10, derived: false, timeout: 12000, disabled: [] },
  session: newSession(),
  running: false,
  controller: null,
  report: null,
  expediente: ''
};

export function newSession() {
  return {
    id: 'S-' + Date.now().toString(36).toUpperCase(),
    started: new Date().toISOString(),
    queries: [], trace: [],
    pivots: new Map(),          // tipo:valor → {type, value, via:Set, notes:Set, queries:Set, searched}
    controls: new Map(),        // fuente[:dominio] → Promise<{verdict, alias}> (control, uno por sesión)
    unreliable: new Map()       // fuente → alias de control que la delató (se descarta el resto de la sesión)
  };
}

export const allSources = () => [...SOURCES_USER, ...SOURCES_EMAIL];
export const allResults = () => state.session.queries.flatMap(q => q.results);
export function activeSources(type) {
  const list = type === 'email' ? SOURCES_EMAIL : SOURCES_USER;
  return list.filter(s => !state.settings.disabled.includes(s.id) && (!s.third || state.settings.third) && (!s.google || state.settings.google));
}
export function countResults(results) {
  const c = { found: 0, unknown: 0, notfound: 0, na: 0, info: 0 };
  results.forEach(r => { c[r.status] = (c[r.status] || 0) + 1; });
  return c;
}

/* ---------- Entrada ---------- */
export function parseQuery(raw) {
  let v = String(raw || '').trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) {
    const h = U.urlToHandle(v);
    return h && /^[\p{L}\p{N}._-]{1,64}$/u.test(h.handle) ? { type: 'username', value: h.handle, note: `extraído de URL de ${h.platform}` }
      : { type: 'invalid', value: v, reason: 'URL sin identificador de perfil reconocible' };
  }
  if (/^mailto:/i.test(v)) v = v.slice(7).split('?')[0];
  if (U.isEmail(v)) return { type: 'email', value: v };
  if (/^\+?[\d\s().-]{7,}$/.test(v) && v.replace(/\D/g, '').length >= 7) return { type: 'phone', value: v, reason: 'Para números de teléfono usa RASTRO · PHONE' };
  v = v.replace(/^@/, '');
  if (v.length < 1) return { type: 'invalid', value: v, reason: 'Identificador demasiado corto' };
  if (v.length > 64) return { type: 'invalid', value: v, reason: 'Identificador demasiado largo' };
  if (!/^[\p{L}\p{N}._-]+$/u.test(v)) return { type: 'invalid', value: v, reason: 'Caracteres no válidos para un nombre de usuario' };
  return { type: 'username', value: v };
}

/* Admite varios identificadores separados por saltos de línea, comas, punto y coma o espacios */
export function parseInput(raw) {
  const tokens = String(raw || '').split(/[\s,;]+/).map(t => t.trim()).filter(Boolean);
  const seen = new Set();
  return tokens.map(parseQuery).filter(p => {
    if (!p) return false;
    const k = p.type + ':' + String(p.value).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ---------- Pivotes ---------- */
export const pivotKey = (type, value) => type + ':' + String(value).toLowerCase();

export function addPivot(p, qid) {
  const k = pivotKey(p.type, p.value);
  let e = state.session.pivots.get(k);
  if (!e) {
    e = { type: p.type, value: p.value, via: new Set(), notes: new Set(), queries: new Set(), searched: false };
    state.session.pivots.set(k, e);
  }
  if (p.via) e.via.add(p.via);
  if (p.note) e.notes.add(p.note);
  if (qid) e.queries.add(qid);
}
function markSearched(type, value) {
  const k = pivotKey(type, value);
  const e = state.session.pivots.get(k);
  if (e) e.searched = true;
  else state.session.pivots.set(k, { type, value, via: new Set(['consulta directa']), notes: new Set(), queries: new Set(), searched: true });
}
export const isDirectOnly = x => x.via.size === 1 && x.via.has('consulta directa');
export const isDerivedOnly = x => [...x.via].every(v => v === 'Derivado del correo');
export const pendingPivots = (strongOnly = false) => [...state.session.pivots.values()]
  .filter(x => !x.searched && (x.type === 'username' || x.type === 'email') && (!strongOnly || !isDerivedOnly(x)));
export const wasSearched = (type, value) => !!(state.session.pivots.get(pivotKey(type, value)) || {}).searched;

/* ---------- Ejecución ---------- */
async function pool(items, n, fn, signal) {
  let i = 0;
  const worker = async () => { while (i < items.length && !signal.aborted) await fn(items[i++]); };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

function errorReason(e, signal) {
  if (signal.aborted) return 'Búsqueda detenida';
  if (e && e.name === 'TimeoutError') return 'Tiempo de espera agotado';
  return 'Error de red, CORS o bloqueo anti-bot';
}

/* Contraste anti-falsos positivos: la misma fuente consultada con un identificador aleatorio inexistente */
function controlCheck(s, value, qid, makeCtx, signal) {
  const S = state.session;
  const isMail = U.isEmail(value);
  const key = isMail ? `${s.id}:${value.split('@')[1]}` : s.id;
  if (!S.controls.has(key)) {
    const job = (async () => {
      const alias = isMail ? U.controlEmail(value) : U.controlAlias(s.valid);
      if (!alias) return { verdict: 'skip' };
      try {
        const r = await s.check(alias, makeCtx(s.id, qid, 'control'));
        return { alias, verdict: r.status === 'found' ? 'soft404' : (r.status === 'notfound' ? 'ok' : 'inconclusive') };
      } catch {
        return { alias, verdict: 'inconclusive' };
      }
    })();
    S.controls.set(key, job);
    job.then(() => { if (signal.aborted) S.controls.delete(key); });
  }
  return S.controls.get(key);
}

async function checkSource(s, value, qid, makeCtx, signal) {
  const t0 = performance.now();
  let res, ctx = null;
  if (s.valid && !s.valid.test(value)) {
    res = { status: 'na', reason: 'Formato no admitido por la plataforma' };
  } else if (state.session.unreliable.has(s.id)) {
    res = { status: 'na', discarded: true, reason: 'Fuente descartada en esta sesión: no distingue perfiles inexistentes' };
  } else {
    ctx = makeCtx(s.id, qid);
    try { res = (await s.check(value, ctx)) || UNK('Sin respuesta'); }
    catch (e) { res = UNK(errorReason(e, signal)); }
    if (res.status === 'found' && !U.isEmail(value) && res.profile?.username && String(res.profile.username).toLowerCase().replace(/^@/, '') !== value.toLowerCase()) res = UNK('La respuesta contiene un alias diferente al consultado');
    if (res.status === 'found' && s.control !== false && !signal.aborted) {
      const c = await controlCheck(s, value, qid, makeCtx, signal);
      if (c.verdict === 'soft404') {
        state.session.unreliable.set(s.id, c.alias);
        res = { status: 'na', discarded: true, reason: `Descartada: la fuente también «encuentra» el identificador de control inexistente (${c.alias})` };
      }
      if (c.verdict !== 'ok' && c.verdict !== 'soft404') res = UNK('Control de contraste no concluyente; revisar manualmente');
      res.control = c.verdict;
      res.controlAlias = c.alias;
    }
  }
  if (res.coverage) {
    const c = res.coverage;
    res.reason = [res.reason, `Cobertura: ${c.checked}/${c.limit} candidatos; ${c.reason}`].filter(Boolean).join(' · ');
  }
  if (res.profile && res.evidenceType) res.profile.extra = {...res.profile.extra, 'Tipo de evidencia': res.evidenceType, 'Fundamento': res.basis};
  Object.assign(res, {
    source: s.id, name: s.name, cat: s.cat, reliability: s.reliability, third: !!s.third,
    ms: Math.round(performance.now() - t0), ts: new Date().toISOString(), query: qid,
    profileUrl: s.profileUrl ? s.profileUrl(value) : null
  });
  if (ctx && ctx.last && (res.status === 'found' || res.status === 'info')) {
    const l = ctx.last;
    res.responseSha256 = l.sha256;
    res.evidence = { url: l.url, status: l.status, ts: l.ts, sha256: l.sha256, chars: (l.text || '').length, truncated: (l.text || '').length > EVIDENCE_MAX_CHARS, body: (l.text || '').slice(0, EVIDENCE_MAX_CHARS) };
  }
  if (!['found','info'].includes(res.status)) { delete res.profile; delete res.pivots; }
  if (res.profile) {
    res.profile.url = res.profile.url || res.profileUrl;
    res.pivots = res.status === 'found' ? U.derivePivots(res.profile, s.name) : [];
  }
  return res;
}

/**
 * Ejecuta una consulta sobre todas las fuentes activas.
 * hooks: onStart(query, sources), onResult(query, res), onEnd(query)
 */
export async function runQuery(p, origin, hooks = {}) {
  const S = state.session;
  const signal = state.controller.signal;
  const requester = createRequester({ trace: S.trace, timeout: state.settings.timeout, signal });
  const makeCtx = (...args) => Object.assign(requester(...args), { settings: {...state.settings} });
  const sources = activeSources(p.type);
  const query = {
    id: 'Q' + (S.queries.length + 1), type: p.type, value: p.value, origin, note: p.note || '',
    expediente: state.expediente || '', started: new Date().toISOString(), finished: null, results: []
  };
  S.queries.push(query);
  markSearched(p.type, p.value);
  if (p.type === 'email') {
    U.usernameCandidates(p.value).forEach(c => addPivot({ type: 'username', value: c, via: 'Derivado del correo', note: 'parte local del correo' }, query.id));
  }
  hooks.onStart && hooks.onStart(query, sources);

  const done = new Set();
  await pool(sources, state.settings.concurrency, async s => {
    const res = await checkSource(s, p.value, query.id, makeCtx, signal);
    (res.pivots || []).filter(x => pivotKey(x.type, x.value) !== pivotKey(p.type, p.value)).forEach(x => addPivot(x, query.id));
    query.results.push(res);
    done.add(s.id);
    hooks.onResult && hooks.onResult(query, res);
  }, signal);

  sources.filter(s => !done.has(s.id)).forEach(s => {
    const res = Object.assign(UNK('No consultada (búsqueda detenida)'), { source: s.id, name: s.name, cat: s.cat, reliability: s.reliability, query: query.id, profileUrl: s.profileUrl ? s.profileUrl(p.value) : null });
    query.results.push(res);
    hooks.onResult && hooks.onResult(query, res);
  });

  if (state.settings.tab && !signal.aborted) {
    for (const r of query.results.filter(isBlocked).slice(0, MAX_AUTO_TAB)) {
      if (signal.aborted) break;
      const nr = await verifyInTab(r);
      hooks.onResult && hooks.onResult(query, nr);
    }
  }
  if (state.settings.avatars && !signal.aborted) await hashAvatars(query, makeCtx, signal);
  query.finished = new Date().toISOString();
  computeConfidence();
  hooks.onEnd && hooks.onEnd(query);
  persistSession();
  return query;
}

/* ---------- Avatares: hash perceptual (dHash 64 bits) para detectar imágenes reutilizadas ---------- */
async function dHash(bytes, type) {
  const bmp = await createImageBitmap(new Blob([bytes], { type: type || 'image/jpeg' }));
  const c = new OffscreenCanvas(9, 8);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0, 9, 8);
  bmp.close();
  const d = g.getImageData(0, 0, 9, 8).data;
  const lum = i => d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const i = (y * 9 + x) * 4; bits += lum(i) > lum(i + 4) ? '1' : '0'; }
  if (!bits.includes('1') || !bits.includes('0')) return null;          // imagen plana: no discrimina
  return bits.match(/.{4}/g).map(b => parseInt(b, 2).toString(16)).join('');
}

async function hashAvatars(query, makeCtx, signal) {
  const targets = query.results.filter(r => r.status === 'found' && r.profile && U.safeUrl(r.profile.avatar));
  await pool(targets, 4, async r => {
    try {
      const resp = await makeCtx(r.source, query.id, 'avatar').req(U.safeUrl(r.profile.avatar), { as: 'blob', noRetry: true });
      if (resp.status !== 200 || !/^image\//.test(resp.type)) return;
      r.avatarSha256 = resp.sha256;
      r.avatarHash = await dHash(resp.bytes, resp.type);
    } catch { /* avatar no disponible */ }
  }, signal);
}

/* ---------- Correlación ---------- */
function tally(values) {
  const m = new Map();
  values.forEach(([v, src]) => {
    if (U.isEmpty(v)) return;
    const k = String(v).trim().toLowerCase();
    if (!m.has(k)) m.set(k, { v: String(v).trim(), src: new Set() });
    m.get(k).src.add(src);
  });
  return [...m.values()].sort((a, b) => b.src.size - a.src.size);
}

function avatarGroups(found) {
  const items = found.filter(r => r.avatarHash);
  const parent = items.map((_, i) => i);
  const root = i => (parent[i] === i ? i : (parent[i] = root(parent[i])));
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const same = items[i].avatarSha256 === items[j].avatarSha256 || U.hamming(items[i].avatarHash, items[j].avatarHash) <= AVATAR_MATCH_BITS;
    if (same && (items[i].source !== items[j].source || items[i].query !== items[j].query)) parent[root(i)] = root(j);
  }
  const groups = new Map();
  items.forEach((r, i) => { const k = root(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  return [...groups.values()].filter(g => g.length > 1).sort((a, b) => b.length - a.length);
}

export function correlationData() {
  const found = allResults().filter(r => r.status === 'found' && r.profile);
  const src = r => `${r.name} (${r.query})`;
  const dated = key => found.map(r => ({ d: U.date(r.profile[key]), r })).filter(x => U.isDay(x.d));
  return {
    found,
    names: tally(found.map(r => [r.profile.displayName, src(r)])),
    usernames: tally(found.map(r => [r.profile.username, src(r)])),
    locations: tally(found.map(r => [r.profile.location, src(r)])),
    sites: tally(found.flatMap(r => [r.profile.website, ...(r.profile.links || [])].filter(Boolean).map(u => [U.hostOf(u), src(r)]))),
    created: dated('created').sort((a, b) => a.d.localeCompare(b.d)),
    active: dated('lastActive').sort((a, b) => b.d.localeCompare(a.d)),
    avatars: avatarGroups(found)
  };
}

/* ---------- Persistencia de la sesión (sin cuerpos de respuesta) ---------- */
export function serializeSession() {
  const S = state.session;
  return {
    v: 2, id: S.id, started: S.started, saved: new Date().toISOString(),
    queries: S.queries.map(q => ({ ...q, results: q.results.map(({ evidence, ...r }) => r) })),
    trace: S.trace,
    unreliable: [...S.unreliable.entries()],
    pivots: [...S.pivots.values()].map(x => ({ ...x, via: [...x.via], notes: [...x.notes], queries: [...x.queries] }))
  };
}
export function restoreSession(o) {
  const S = newSession();
  Object.assign(S, { id: o.id, started: o.started, queries: o.queries || [], trace: o.trace || [], restored: o.saved });
  (o.unreliable || []).forEach(([k, v]) => S.unreliable.set(k, v));
  (o.pivots || []).forEach(x => S.pivots.set(pivotKey(x.type, x.value), { ...x, via: new Set(x.via), notes: new Set(x.notes), queries: new Set(x.queries) }));
  state.session = S;
  state.report = null;
}
let persistTimer = null;
export function persistSession() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try { chrome.storage.local.set({ rhSession: state.session.queries.length ? serializeSession() : null }); } catch { /* */ }
  }, 400);
}

/* ---------- Confianza del vínculo de cada cuenta ----------
   alta : asociada directamente al correo, enlace cruzado con otra cuenta localizada o mismo avatar
   media: nombre coincidente con una cuenta de confianza alta o con el correo; misma ubicación
   baja : solo coincide el alias (puede ser otra persona) */
const PLATFORM_ALIAS = { twitter: 'x', 'x / twitter': 'x', 'mastodon (mastodon.social)': 'mastodon', 'github · commits': 'github', 'github · correo público': 'github', 'gitlab · correo público': 'gitlab' };
const platformKey = n => { const k = U.normText(n).trim(); return PLATFORM_ALIAS[k] || k.split(/[\s/·(]/)[0]; };
const normUrl = u => { const s = U.safeUrl(u); return s ? s.toLowerCase().replace(/^https?:\/\/(www\.|m\.)?/, '').replace(/\/+$/, '') : null; };

export function computeConfidence() {
  const S = state.session;
  const qById = Object.fromEntries(S.queries.map(q => [q.id, q]));
  const found = allResults().filter(r => r.status === 'found');
  const handleOf = r => String((r.profile && r.profile.username) || (qById[r.query] || {}).value || '').toLowerCase().replace(/^@/, '');
  const urlOf = r => normUrl((r.profile && !r.profile.existenceOnly && r.profile.url) || r.profileUrl);
  found.forEach(r => { r.confidence = 'baja'; r.why = []; });
  const raise = (r, level, why) => {
    if (!r.why.includes(why)) r.why.push(why);
    if (level === 'alta' || (level === 'media' && r.confidence === 'baja')) r.confidence = level;
  };

  const emailQueries = new Set(S.queries.filter(q => q.type === 'email').map(q => q.value.toLowerCase()));
  found.forEach(r => {
    const p = r.profile || {};
    if ((p.emails || []).some(e => emailQueries.has(String(e).toLowerCase())) && !['e-pgp', 'e-github-commits'].includes(r.source))
      raise(r, 'alta', 'Correo exacto publicado en el perfil; verificar titularidad');
    else if (qById[r.query]?.type === 'email')
      raise(r, 'media', 'Huella relacionada con el correo; no acredita su titularidad');
  });
  found.forEach(a => found.forEach(b => {
    if (a === b || a.source === b.source) return;
    const links = r => [r.profile?.website, ...(r.profile?.links || []), ...(r.pivots || []).filter(p => p.type === 'url').map(p => p.value)].map(normUrl).filter(Boolean);
    if (urlOf(b) && links(a).includes(urlOf(b))) {
      const reciprocal = urlOf(a) && links(b).includes(urlOf(a));
      raise(a, reciprocal ? 'alta' : 'media', reciprocal ? `Enlaces recíprocos con ${b.name}` : `Enlace público hacia ${b.name}`);
      raise(b, reciprocal ? 'alta' : 'media', `Enlace público desde ${a.name}`);
    }
    const an = U.normText(a.profile?.displayName || '').trim();
    const bn = U.normText(b.profile?.displayName || '').trim();
    if (an === bn && an.split(/\s+/).length >= 2 && an.length >= 7)
      raise(a, 'media', `Nombre completo coincidente con ${b.name}; puede ser homónimo`);
  }));
  avatarGroups(found).forEach(g => g.forEach(r => raise(r, 'media', 'Avatar similar en otra huella; puede ser genérico o copiado')));
  found.forEach(r => { if (!r.why.length) r.why.push('Solo coincide el alias: puede pertenecer a otra persona'); });
  found.forEach(r => { if(qById[r.query]?.origin === 'Alias derivado del correo') { r.confidence='baja'; r.why=['Alias derivado del correo: hipótesis, no acredita que el perfil use ese correo']; } });
}

/* ---------- Verificación en pestaña (fuentes que bloquean peticiones directas) ---------- */
export const MAX_AUTO_TAB = 8;
const BLOCKED_RE = /HTTP (401|403|429|5\d\d|6\d\d)|anti-bot|Cloudflare|pestaña|marcador|protegida|bloqueo|Tiempo de espera|Error de red/i;
export const sourceById = id => allSources().find(s => s.id === id);
export function isBlocked(r) {
  const s = sourceById(r.source);
  return r.status === 'unknown' && !!s && !!(r.profileUrl || s.profileUrl) && (BLOCKED_RE.test(r.reason || '') || !!s.tabPreferred) && !r.tabChecked;
}

function probe(url, s = {}) {
  return new Promise(resolve => {
    try { chrome.runtime.sendMessage({ type: 'tabProbe', url, wait: s.tabWait, waitTitle: s.tabWaitTitle }, res => resolve(res || { ok: false, error: (chrome.runtime.lastError || {}).message || 'sin respuesta' })); }
    catch (e) { resolve({ ok: false, error: String(e.message || e) }); }
  });
}

async function tabCheck(s, value, qid, tag) {
  const url = s.profileUrl(value);
  const entry = { ts: new Date().toISOString(), query: qid, source: s.id, tag, method: 'PESTAÑA', url, status: null, ms: null, bytes: null, sha256: null, finalUrl: null, error: null, attempt: 1 };
  state.session.trace.push(entry);
  const page = await probe(url, s);
  entry.ms = page.ms ?? null;
  if (!page.ok) { entry.error = page.error; return { res: UNK('No se pudo abrir en pestaña: ' + page.error), page }; }
  entry.bytes = (page.html || '').length;
  entry.sha256 = await U.sha256(page.html || '');
  entry.status = page.challenge ? 'reto' : 'cargada';
  if (page.url !== url) entry.finalUrl = page.url;
  return { res: tabParse(s, page, value), page, entry };
}

/* Verifica un resultado indeterminado abriendo el perfil en una pestaña de fondo.
   Los positivos se contrastan también en pestaña con un alias inexistente (una vez por fuente y sesión). */
export async function verifyInTab(r) {
  const S = state.session;
  const s = sourceById(r.source);
  const q = S.queries.find(x => x.id === r.query);
  if (!s || !q || !s.profileUrl) return r;
  const t0 = performance.now();
  const { res, entry } = await tabCheck(s, q.value, q.id, 'pestaña');
  if (res.status === 'found') {
    const key = 'tab:' + s.id;
    if (!S.controls.has(key)) {
      S.controls.set(key, (async () => {
        const alias = U.isEmail(q.value) ? U.controlEmail(q.value) : U.controlAlias(s.valid);
        if (!alias) return { verdict: 'skip' };
        const c = await tabCheck(s, alias, q.id, 'control-pestaña');
        return { alias, verdict: c.res.status === 'found' ? 'soft404' : (c.res.status === 'notfound' ? 'ok' : 'inconclusive') };
      })());
    }
    const c = await S.controls.get(key);
    if (c.verdict === 'soft404') { Object.assign(res, { status: 'na', discarded: true, reason: `Descartada: en pestaña también «encuentra» el alias de control (${c.alias})` }); delete res.profile; }
    else { if (c.verdict !== 'ok') { Object.assign(res, UNK('Control en pestaña no concluyente')); delete res.profile; } res.control = c.verdict; res.controlAlias = c.alias; }
  }
  const nr = Object.assign(res, {
    source: s.id, name: s.name, cat: s.cat, reliability: s.reliability, third: !!s.third, query: q.id,
    ms: Math.round(performance.now() - t0), ts: new Date().toISOString(), profileUrl: s.profileUrl(q.value), tabChecked: true,
    viaTab: true
  });
  if (nr.status === 'unknown' && nr.reason) nr.reason += ' (verificado en pestaña)';
  if (nr.profile) {
    nr.profile.url = nr.profile.url || nr.profileUrl;
    nr.pivots = U.derivePivots(nr.profile, s.name);
    nr.pivots.forEach(x => addPivot(x, q.id));
    if (entry) nr.responseSha256 = entry.sha256;
  }
  const i = q.results.indexOf(r);
  if (i >= 0) q.results[i] = nr; else q.results.push(nr);
  return nr;
}

export async function verifyBlockedInTab(onResult, signal) {
  const list = allResults().filter(isBlocked);
  for (const r of list) {
    if (signal && signal.aborted) break;
    const nr = await verifyInTab(r);
    onResult && onResult(nr);
  }
  computeConfidence();
  persistSession();
  return list.length;
}

/* ---------- Fotos: avatares y portadas de todos los hallazgos, sin duplicados ---------- */
export function photoItems() {
  const out = [], seen = new Map();
  const qById = Object.fromEntries(state.session.queries.map(q => [q.id, q]));
  for (const r of allResults()) {
    if (!['found', 'info'].includes(r.status) || !r.profile) continue;
    for (const [kind, raw] of [['perfil', r.profile.avatar], ['portada', r.profile.banner]]) {
      const url = U.safeUrl(raw);
      if (!url) continue;
      const k = url.toLowerCase();
      if (seen.has(k)) { seen.get(k).alsoIn.push(`${r.name} (${r.query})`); continue; }
      const item = {
        key: k, kind, url, hi: U.hiResImage(url), result: r, query: qById[r.query] || null,
        external: !!r.provenance, sha256: kind === 'perfil' ? r.avatarSha256 || null : null, alsoIn: []
      };
      seen.set(k, item);
      out.push(item);
    }
  }
  return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'perfil' ? -1 : 1) || String(a.result.query).localeCompare(String(b.result.query)));
}
