/* RASTRO · HUELLA — interfaz de la consola de investigación */
import * as U from './util.js';
import { validateMention } from './email.js';
import { requestProvider, providerRows, ENDPOINT } from './enrichment.js';
import { createRequester } from './http.js';
import { SOURCES_USER, SOURCES_EMAIL, MANUAL_PIVOTS } from './sources.js';
import {
  state, newSession, parseInput, runQuery, allResults, allSources, countResults, correlationData, pendingPivots,
  isDirectOnly, wasSearched, restoreSession, persistSession, MAX_AUTO_PIVOTS
} from './engine.js';
import { STATUS_LABEL, CONTROL_LABEL, buildTxt, buildHtml, buildJson, buildEvidence, buildCsvEntities, buildCsvRelations, buildCsvTrace } from './report.js';
import { computeConfidence, isDerivedOnly, isBlocked, verifyInTab, verifyBlockedInTab, photoItems } from './engine.js';
import { zipStore } from './zip.js';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const REL_LABEL = { alta: 'Alta · API con respuesta explícita', media: 'Media · página o endpoint web', baja: 'Baja · anti-bot frecuente' };
const STATUS_ORDER = { found: 0, info: 1, unknown: 2, notfound: 3, na: 4, pending: 5 };
const CONF_ORDER = { alta: 0, media: 1, baja: 2 };
const CONF_LABEL = { alta: 'VÍNCULO ALTO', media: 'VÍNCULO MEDIO', baja: 'SOLO ALIAS' };

/* ---------- DOM ---------- */
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false || k === '') continue;
    n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return n;
}
function link(href, text) {
  const u = U.safeUrl(href);
  return u ? el('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, text || u) : (text || href || '');
}
function avatarImg(url, cls) {
  const u = U.safeUrl(url);
  if (!u) return null;
  const img = el('img', { class: cls, src: u, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.remove());
  return img;
}
function toast(msg) {
  const t = el('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2800);
}
async function copy(text, msg = 'Copiado') {
  try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast('No se pudo copiar'); }
}
function kvList(pairs) {
  const dl = el('dl', { class: 'kv' });
  pairs.forEach(([k, v]) => { if (!U.isEmpty(v)) dl.append(el('dt', {}, k), el('dd', {}, v)); });
  return dl.children.length ? dl : null;
}

/* ---------- Ajustes y almacenamiento ---------- */
const store = {
  async get(keys) { try { return await chrome.storage.local.get(keys); } catch { return {}; } },
  async set(obj) { try { await chrome.storage.local.set(obj); } catch { /* */ } },
  async remove(k) { try { await chrome.storage.local.remove(k); } catch { /* */ } }
};
const saveSettings = () => store.set({ rhSettings: state.settings });

async function loadSettings() {
  const st = await store.get(['rhSettings', 'rhLastExp', 'rhLastAgent']);
  if (st.rhSettings) Object.assign(state.settings, st.rhSettings);
  if (st.rhLastExp) $('#exp').value = st.rhLastExp;
  if (st.rhLastAgent) $('#rAgent').value = st.rhLastAgent;
  $('#optAvatars').checked = state.settings.avatars;
  $('#optThird').checked = state.settings.third;
  $('#optGoogle').checked = !!state.settings.google;
  $('#optDerived').checked = !!state.settings.derived;
  $('#optAuto').checked = state.settings.auto;
  $('#optTab').checked = !!state.settings.tab;
  $('#optEmailLimit').value = String(state.settings.emailLimit || 10);
  $('#optConc').value = String(state.settings.concurrency);
  $('#optTimeout').value = String(state.settings.timeout / 1000);
}

/* ---------- Detección de la entrada ---------- */
function showDetected() {
  const list = parseInput($('#q').value);
  const d = $('#detected');
  const bad = list.filter(p => p.type === 'invalid' || p.type === 'phone');
  const ok = list.filter(p => p.type === 'username' || p.type === 'email');
  d.classList.toggle('warn', bad.length > 0 && !ok.length);
  if (!list.length) { d.textContent = ''; return; }
  if (list.length === 1) {
    const p = list[0];
    d.textContent = p.type === 'username' ? `▸ usuario: ${p.value}${p.note ? ` (${p.note})` : ''}`
      : p.type === 'email' ? `▸ correo: ${p.value}` : `▸ ${p.reason}`;
    return;
  }
  d.textContent = `▸ lote: ${ok.length} identificadores${bad.length ? ` · ${bad.length} descartados` : ''}`;
}

/* ---------- Ciclo de búsqueda ---------- */
const hooks = {
  onStart(query, sources) {
    const sec = renderQuerySection(query);
    const cards = sec.querySelector('.cards');
    sources.forEach(s => cards.append(pendingCard(s, query.id)));
    setProgress(0, sources.length, query.id);
  },
  onResult(query, res) {
    const ph = document.getElementById(`card-${query.id}-${res.source}`);
    const card = resultCard(res);
    if (ph) ph.replaceWith(card); else document.querySelector(`#sec-${query.id} .cards`).append(card);
    const total = document.querySelectorAll(`#sec-${query.id} .card`).length;
    const done = document.querySelectorAll(`#sec-${query.id} .card:not(.st-pending)`).length;
    setProgress(done, total, query.id);
    applyTextFilter(card);
    updateCounts();
  },
  onEnd(query) {
    renderAllResults();
    saveHistory(query);
    if (state.report) { state.report.stale = true; $('#rState').textContent = 'Hay resultados nuevos: vuelve a generar el informe.'; }
    refreshActivePanel();
  }
};

function setBusy(on) {
  state.running = on;
  $('#go').disabled = on;
  $('#stop').disabled = !on;
  $('#reset').disabled = on;
  $('#pivAll').disabled = on;
  $('#tabAll').disabled = on;
  document.body.classList.toggle('busy', on);
}

/* Ejecuta una lista de consultas en serie (+ pivoteo automático opcional) */
async function runBatch(list, origin) {
  if (state.running || !list.length) return;
  state.controller = new AbortController();
  state.expediente = $('#exp').value.trim();
  store.set({ rhLastExp: state.expediente });
  setBusy(true);
  $$('#filter button').forEach(x => x.classList.toggle('active', x.dataset.f === 'rel'));
  $('#results').dataset.filter = 'rel';
  $('#empty').hidden = true;
  try {
    for (const p of list) {
      if (state.controller.signal.aborted) break;
      await runQuery(p, origin, hooks);
    }
    if (state.settings.derived && !state.controller.signal.aborted) {
      for (const x of pendingPivots().filter(isDerivedOnly).slice(0,3)) {
        if (state.controller.signal.aborted) break;
        await runQuery({type:'username',value:x.value,note:'Hipótesis derivada del correo; no confirma asociación'}, 'Alias derivado del correo', hooks);
      }
    }
    if (state.settings.auto && !state.controller.signal.aborted) {
      for (const x of pendingPivots(true).slice(0, MAX_AUTO_PIVOTS)) {
        if (state.controller.signal.aborted) break;
        await runQuery({ type: x.type, value: x.value }, `Pivote automático (vía ${[...x.via].join(', ')})`, hooks);
      }
    }
  } catch (e) {
    if (!state.controller.signal.aborted) toast('La búsqueda no pudo completarse: ' + (e.message || e));
  } finally {
    const stopped = state.controller.signal.aborted;
    setBusy(false);
    setProgress(0, 0, stopped ? 'Detenido' : 'Completado');
    updateCounts();
    refreshActivePanel();
  }
}

function startFromInput(origin) {
  const list = parseInput($('#q').value);
  const valid = list.filter(p => p.type === 'username' || p.type === 'email');
  const bad = list.filter(p => !valid.includes(p));
  if (bad.length) toast(bad.map(p => `${p.value}: ${p.reason}`).join(' · '));
  if (!valid.length) return;
  if (valid.length > 10 && !confirm(`Se van a buscar ${valid.length} identificadores. ¿Continuar?`)) return;
  runBatch(valid, origin || (valid.length > 1 ? 'Búsqueda en lote' : 'Búsqueda inicial'));
}

function searchOne(type, value, origin) {
  if (state.running) { toast('Hay una búsqueda en curso.'); return; }
  if (wasSearched(type, value) && !confirm(`«${value}» ya se buscó en esta sesión. ¿Repetir?`)) return;
  switchTab('res');
  runBatch([{ type, value }], origin);
}

function setProgress(done, total, label) {
  $('#bar').style.width = total ? Math.round(done / total * 100) + '%' : '0';
  $('#barTxt').textContent = total ? `${label}: ${done}/${total}` : (label || '');
}

/* ---------- Verificación en pestaña ---------- */
async function verifyOne(r, btn) {
  if (state.running) { toast('Espera a que termine la búsqueda en curso.'); return; }
  btn.disabled = true;
  btn.textContent = 'Verificando…';
  await verifyInTab(r);
  computeConfidence();
  persistSession();
  renderAllResults();
  updateCounts();
}
async function verifyAllBlocked() {
  if (state.running) return;
  const n = allResults().filter(isBlocked).length;
  if (!n) { toast('No hay indeterminados por bloqueo que verificar.'); return; }
  state.controller = new AbortController();
  setBusy(true);
  let done = 0;
  setProgress(0, n, 'Pestañas');
  await verifyBlockedInTab(nr => {
    done++;
    setProgress(done, n, 'Pestañas');
    const old = document.getElementById(`card-${nr.query}-${nr.source}`);
    if (old) old.replaceWith(resultCard(nr));
  }, state.controller.signal);
  setBusy(false);
  setProgress(0, 0, 'Verificación en pestaña completada');
  renderAllResults();
  updateCounts();
  refreshActivePanel();
}

/* ---------- Render: consultas y tarjetas ---------- */
function renderQuerySection(q) {
  const sec = el('section', { class: 'qsec', id: 'sec-' + q.id },
    el('div', { class: 'qhead' },
      el('span', { class: 'qid' }, q.id),
      el('span', { class: 'qtype' }, q.type === 'email' ? 'correo' : 'usuario'),
      el('span', { class: 'qval' }, q.value),
      el('button', { class: 'mini ghost', title: 'Copiar identificador', onclick: () => copy(q.value) }, '⧉'),
      el('span', { class: 'qorigin' }, q.origin + (q.note ? ` · ${q.note}` : '')),
      el('span', { class: 'qstats' }, q.finished ? '' : 'consultando…')),
    el('div', { class: 'cards' }));
  $('#results').prepend(sec);
  return sec;
}

function updateQueryHead(sec, q) {
  const c = countResults(q.results);
  const secs = q.finished ? ((new Date(q.finished) - new Date(q.started)) / 1000).toFixed(1) + ' s' : '';
  sec.querySelector('.qstats').textContent =
    `${c.found} encontrados · ${c.unknown} indeterminados · ${c.notfound} no encontrados · ${c.na} no aplica${c.info ? ` · ${c.info} info` : ''}${secs ? ' · ' + secs : ''}`;
}

function sortCards(container) {
  [...container.children]
    .sort((a, b) => (STATUS_ORDER[a.dataset.status] ?? 9) - (STATUS_ORDER[b.dataset.status] ?? 9)
      || (CONF_ORDER[a.dataset.conf] ?? 9) - (CONF_ORDER[b.dataset.conf] ?? 9) || a.dataset.name.localeCompare(b.dataset.name, 'es'))
    .forEach(n => container.append(n));
}

function cardHead(name, sub, status, third) {
  return el('div', { class: 'chead' },
    el('div', { class: 'ico', 'aria-hidden': 'true' }, (name || '?')[0]),
    el('div', { class: 'cname' }, el('b', {}, name, third ? el('span', { class: 'flag' }, 'tercero') : null), el('span', {}, sub)),
    el('span', { class: 'st ' + status }, STATUS_LABEL[status] || status));
}

function pendingCard(s, qid) {
  return el('article', { class: 'card st-pending', id: `card-${qid}-${s.id}`, 'data-status': 'pending', 'data-name': s.name },
    cardHead(s.name, s.cat, 'pending'));
}

function resultCard(r) {
  const p = r.profile || {};
  const card = el('article', { class: `card st-${r.status}`, id: `card-${r.query}-${r.source}`, 'data-status': r.status, 'data-name': r.name || '' });
  card.dataset.search = [r.name, r.cat, p.displayName, p.username, p.bio, p.location, r.reason].filter(Boolean).join(' ').toLowerCase();
  if (r.confidence) { card.dataset.conf = r.confidence; card.classList.add('conf-' + r.confidence); }
  card.append(cardHead(r.name, `${r.cat || ''} · fiabilidad ${r.reliability || '—'}`, r.status, r.third));
  if (r.evidenceType) card.append(el('div', {class:'method-note'}, el('b',{},r.evidenceType), el('div',{},r.basis || '')));
  if (r.coverage) card.append(el('p', {class:'muted'}, `Cobertura: ${r.coverage.checked} candidatos · ${r.coverage.reason}`));
  if (r.proofs?.length) card.append(el('details',{},el('summary',{},'Respuestas que sustentan el hallazgo'),r.proofs.map(x=>el('div',{},link(x.url),el('code',{},x.sha256 || ''),el('span',{},x.detail || '')))));
  if (r.status === 'found' && r.confidence) {
    card.append(el('div', { class: 'conf conf-' + r.confidence, title: (r.why || []).join('\n') }, el('b', {}, CONF_LABEL[r.confidence]), ' · ', (r.why || []).join(' · ')));
  }

  if (r.status === 'found' || r.status === 'info') {
    const main = el('div', { class: 'cmain' },
      p.displayName ? el('div', { class: 'dname' }, p.displayName) : null,
      p.username ? el('div', { class: 'uname' }, '@' + String(p.username).replace(/^@/, '')) : null,
      p.bio ? el('div', { class: 'bio', title: p.bio }, p.bio) : null);
    card.append(el('div', { class: 'cbody' }, state.settings.avatars && !r.provenance ? avatarImg(p.avatar, 'avatar') : null, main));

    const stats = [[p.followers, 'seguidores'], [p.following, 'seguidos'], [p.posts, p.postsLabel || 'publicaciones']]
      .filter(([v]) => !U.isEmpty(v)).map(([v, l]) => el('span', {}, el('b', {}, U.num(v)), ' ' + l));
    if (stats.length) card.append(el('div', { class: 'stats' }, stats));

    const kv = kvList([
      ['Ubicación', p.location], ['Web', p.website ? link(p.website) : null], ['Alta', U.date(p.created)],
      ['Última actividad', U.date(p.lastActive)], ['Verificación', p.verified], ['Privada', p.private === true ? 'Sí' : null],
      ['Correos', (p.emails || []).join(', ')], ['Portada', p.banner ? link(p.banner, 'ver imagen') : null]
    ]);
    if (kv) card.append(kv);

    const extra = Object.entries(p.extra || {}).filter(([, v]) => !U.isEmpty(v) && v !== false);
    if (r.responseSha256) extra.push(['SHA-256 respuesta', r.responseSha256]);
    if (extra.length) {
      card.append(el('details', { class: 'more' }, el('summary', {}, `+${extra.length} campos`),
        kvList(extra.map(([k, v]) => [k, v === true ? 'Sí' : (/^https?:\/\//.test(String(v)) ? link(v) : String(v))]))));
    }
    if (CONTROL_LABEL[r.control]) card.append(el('div', { class: 'ctrl ' + r.control }, (r.control === 'ok' ? '✓ ' : '◌ ') + CONTROL_LABEL[r.control]));
  } else if (r.reason) {
    card.append(el('div', { class: 'reason' }, r.reason));
  }

  const pu = p.url || r.profileUrl;
  card.append(el('div', { class: 'cfoot' },
    pu ? link(pu, r.status === 'found' ? 'Abrir perfil' : 'Comprobar a mano') : null,
    pu ? el('button', { class: 'mini ghost', title: 'Copiar URL', onclick: () => copy(pu) }, '⧉') : null,
    isBlocked(r) ? el('button', { class: 'mini tabbtn', title: 'Abre el perfil en una pestaña de fondo con tu navegador, lo lee y la cierra', onclick: e => verifyOne(r, e.currentTarget) }, '⟳ Verificar en pestaña') : null,
    r.viaTab ? el('span', { class: 'flag' }, 'pestaña') : null,
    r.pivots && r.pivots.length ? el('span', { class: 'muted' }, `${r.pivots.length} identificadores`) : null,
    el('span', { class: 'ms' }, r.ms != null ? r.ms + ' ms' : '')));
  return card;
}

/* Reconstruye la vista desde el estado (sesión recuperada) */
function renderAllResults() {
  $('#results').replaceChildren();
  state.session.queries.forEach(q => {
    const sec = renderQuerySection(q);
    const cards = sec.querySelector('.cards');
    q.results.forEach(r => cards.append(resultCard(r)));
    sortCards(cards);
    updateQueryHead(sec, q);
  });
  $('#empty').hidden = state.session.queries.length > 0;
  applyTextFilter();
}

/* ---------- Filtros ---------- */
function applyTextFilter(only) {
  const t = $('#ftext').value.trim().toLowerCase();
  (only ? [only] : $$('#results .card')).forEach(c => c.classList.toggle('hide-text', !!t && !(c.dataset.search || c.dataset.name.toLowerCase()).includes(t)));
}

/* ---------- Contadores y paneles (se renderiza solo el visible) ---------- */
function updateCounts() {
  const res = allResults();
  $('#cFound').textContent = res.filter(r => r.status === 'found').length;
  $('#cPiv').textContent = pendingPivots(true).length;
  const nb = res.filter(isBlocked).length;
  $('#tabAll').textContent = `⟳ Verificar bloqueados en pestaña${nb ? ` (${nb})` : ''}`;
  $('#tabAll').hidden = !nb;
  $('#cLinked').textContent = res.filter(r => r.status === 'found' && r.confidence && r.confidence !== 'baja').length;
  $('#cTrz').textContent = state.session.trace.length;
  $('#cFot').textContent = photoItems().length;
}
const PANELS = { piv: renderPivots, cor: renderCorrelation, fot: renderPhotos, man: renderManual, trz: renderTrace, his: renderHistory };
function refreshActivePanel() {
  const active = ($('#tabs button.active') || {}).dataset;
  if (active && PANELS[active.tab]) PANELS[active.tab]();
}
function switchTab(id) {
  $$('#tabs button').forEach(b => { const on = b.dataset.tab === id; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
  $$('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + id));
  if (PANELS[id]) PANELS[id]();
  if (id === 'inf' && !$('#rExp').value) $('#rExp').value = $('#exp').value;
}

function renderPivots() {
  const box = $('#pivots');
  box.replaceChildren();
  const all = [...state.session.pivots.values()].filter(x => !isDirectOnly(x));
  const derived = all.filter(x => isDerivedOnly(x) && !x.searched);
  const pivots = all.filter(x => !derived.includes(x));
  if (derived.length) box.append(el('div', { class: 'pgroup' },
    el('h3', {}, `Alias derivados del correo (${derived.length}) — no se buscan solos`),
    el('p', { class: 'muted' }, 'Son suposiciones a partir de la parte local del correo: las cuentas que aparezcan serán «solo alias» salvo que algo las vincule.'),
    el('div', { class: 'chips' }, derived.map(x => el('button', { class: 'chip', onclick: () => searchOne('username', x.value, 'Alias derivado del correo') }, x.value)),
      el('button', { class: 'ghost', onclick: () => { switchTab('res'); runBatch(derived.map(x => ({ type: 'username', value: x.value })), 'Alias derivado del correo'); } }, 'Buscar todos'))));
  const groups = [['username', 'Nombres de usuario'], ['email', 'Correos electrónicos'], ['url', 'Enlaces']];
  for (const [type, title] of groups) {
    const items = pivots.filter(x => x.type === type).sort((a, b) => b.via.size - a.via.size || a.value.localeCompare(b.value));
    if (!items.length) continue;
    box.append(el('div', { class: 'pgroup' }, el('h3', {}, `${title} (${items.length})`), items.map(x => el('div', { class: 'prow' },
      el('span', { class: 'pv' }, type === 'url' ? link(x.value) : x.value),
      el('span', { class: 'pvia' }, 'vía ' + [...x.via].join(', ') + (x.notes.size ? ` · ${[...x.notes].join(', ')}` : '')),
      type === 'url' ? null : (x.searched ? el('span', { class: 'done' }, '✓ buscado') : el('button', { onclick: () => searchOne(x.type, x.value, 'Pivote manual') }, 'Buscar')),
      el('button', { class: 'ghost', onclick: () => copy(x.value) }, 'Copiar')))));
  }
  const lastUser = [...state.session.queries].reverse().find(q => q.type === 'username');
  if (lastUser) {
    const vars = U.usernameVariants(lastUser.value).filter(v => !wasSearched('username', v));
    if (vars.length) box.append(el('div', { class: 'pgroup' },
      el('h3', {}, `Variantes sugeridas de «${lastUser.value}» (no se buscan solas)`),
      el('div', { class: 'chips' }, vars.map(v => el('button', { class: 'chip', title: 'Buscar esta variante', onclick: () => searchOne('username', v, `Variante de «${lastUser.value}»`) }, v)))));
  }
  if (!box.children.length) box.append(el('p', { class: 'muted' }, 'Todavía no se han descubierto identificadores.'));
}

function listPanel(title, items, hint) {
  return el('div', { class: 'panel' }, el('h2', {}, title),
    items.length ? el('ul', {}, items.slice(0, 15).map(i => el('li', {}, el('span', { class: 'cnt' }, '×' + i.src.size), i.v, el('span', { class: 'muted' }, ' — ' + [...i.src].join(', ')))))
      : el('p', { class: 'muted' }, hint || 'Sin datos.'));
}

function renderCorrelation() {
  const box = $('#correl');
  box.replaceChildren();
  const c = correlationData();
  if (!c.found.length) { box.append(el('p', { class: 'muted' }, 'Sin perfiles encontrados todavía.')); return; }
  if (c.avatars.length) {
    box.append(el('div', { class: 'panel hl' }, el('h2', {}, `Avatares coincidentes (${c.avatars.length} grupos)`),
      el('p', { class: 'muted' }, 'Imagen similar en perfiles distintos: indicio que puede deberse a avatares genéricos o copiados.'),
      c.avatars.map((g, i) => el('div', { class: 'agroup' }, el('b', {}, `Grupo ${i + 1}`),
        el('div', { class: 'gallery' }, g.map(r => el('figure', {}, state.settings.avatars ? avatarImg(r.profile.avatar) : null, el('figcaption', {}, `${r.name} · ${r.query}`))))))));
  }
  box.append(el('div', { class: 'cgrid' },
    listPanel('Nombres mostrados', c.names),
    listPanel('Nombres de usuario confirmados', c.usernames),
    listPanel('Ubicaciones declaradas', c.locations),
    listPanel('Dominios enlazados', c.sites, 'Ningún perfil enlaza webs externas.'),
    el('div', { class: 'panel' }, el('h2', {}, 'Cronología de altas'),
      c.created.length ? [el('ul', {}, c.created.slice(0, 15).map(x => el('li', {}, el('span', { class: 'cnt' }, x.d), `${x.r.name} (${x.r.query})`))),
        el('p', { class: 'muted' }, `La cuenta más antigua (${c.created[0].r.name}, ${c.created[0].d}) suele ser la de origen del alias.`)]
        : el('p', { class: 'muted' }, 'Sin fechas de alta.')),
    el('div', { class: 'panel' }, el('h2', {}, 'Actividad más reciente'),
      c.active.length ? el('ul', {}, c.active.slice(0, 10).map(x => el('li', {}, el('span', { class: 'cnt' }, x.d), `${x.r.name} (${x.r.query})`))) : el('p', { class: 'muted' }, 'Sin fechas de actividad.'))));
  if (state.settings.avatars) {
    const avs = c.found.filter(r => U.safeUrl(r.profile.avatar));
    if (avs.length) box.append(el('div', { class: 'panel' }, el('h2', {}, 'Todos los avatares'),
      el('div', { class: 'gallery' }, avs.map(r => el('figure', {}, avatarImg(r.profile.avatar), el('figcaption', {}, `${r.name} · ${r.query}`))))));
  }
}

function renderManual() {
  const box = $('#manual');
  box.replaceChildren();
  const seen = new Set();
  [...state.session.queries].reverse().forEach(q => {
    const k = q.type + ':' + q.value;
    if (seen.has(k)) return;
    seen.add(k);
    box.append(el('div', { class: 'panel' }, el('h2', {}, `${q.id} · ${q.value}`),
      el('div', { class: 'mgrid' }, (MANUAL_PIVOTS[q.type] || []).map(([name, fn]) => { const u = fn(q.value); return el('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, name, el('small', {}, u)); }))));
  });
  if (!box.children.length) box.append(el('p', { class: 'muted' }, 'Lanza una búsqueda para generar los enlaces.'));
}

function renderTrace() {
  const tb = $('#trace tbody');
  const rows = state.session.trace.slice(-1000).reverse();
  tb.replaceChildren(...rows.map(t => el('tr', { class: t.tag ? 'tag-' + t.tag : null },
    el('td', { class: 'mono' }, t.ts.replace('T', ' ').slice(0, 19)), el('td', { class: 'mono' }, t.query), el('td', {}, t.source),
    el('td', {}, t.tag || 'consulta', t.attempt > 1 ? ' (reintento)' : ''), el('td', { class: 'mono' }, t.method),
    el('td', { class: 'mono url' }, t.url, t.finalUrl ? el('div', { class: 'muted' }, '⇒ ' + t.finalUrl) : null),
    el('td', { class: 'mono' }, t.status ?? '—'), el('td', { class: 'mono' }, t.ms ?? ''), el('td', { class: 'mono' }, t.bytes ?? ''),
    el('td', { class: 'mono hash', title: t.sha256 || '' }, t.sha256 ? t.sha256.slice(0, 16) + '…' : ''), el('td', {}, t.error || ''))));
  $('#traceNote').textContent = state.session.trace.length > 1000 ? `Mostrando las últimas 1.000 de ${state.session.trace.length} peticiones (el informe las incluye todas).` : '';
}

/* ---------- Fotos ---------- */
const photoDone = new Map();      // url → {sha256, bytes, type, ts, status}
const REVERSE = [
  ['Lens', u => `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(u)}`],
  ['Yandex', u => `https://yandex.com/images/search?rpt=imageview&url=${encodeURIComponent(u)}`],
  ['Bing', u => `https://www.bing.com/images/search?view=detailv2&iss=sbi&q=imgurl:${encodeURIComponent(u)}`],
  ['TinEye', u => `https://tineye.com/search?url=${encodeURIComponent(u)}`]
];
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg' };
const slug = v => String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'x';

async function fetchPhoto(item, signal) {
  const req = createRequester({ trace: state.session.trace, timeout: Math.max(state.settings.timeout, 15000), signal: signal || new AbortController().signal });
  let resp = null, used = item.hi;
  try { resp = await req(item.result.source, item.result.query, 'foto').req(item.hi, { as: 'blob', noRetry: true }); } catch { resp = null; }
  if ((!resp || resp.status !== 200 || !/^image\//.test(resp.type)) && item.hi !== item.url) {
    used = item.url;
    resp = await req(item.result.source, item.result.query, 'foto').req(item.url, { as: 'blob', noRetry: true });
  }
  if (!resp || resp.status !== 200 || !/^image\//.test(resp.type)) throw new Error(`HTTP ${resp ? resp.status : '—'}${resp && resp.type ? ' · ' + resp.type : ''}`);
  const type = resp.type.split(';')[0].trim();
  const info = { sha256: resp.sha256, bytes: resp.bytes, type, ts: resp.ts, url: used };
  photoDone.set(item.url, info);
  if (item.kind === 'perfil' && !item.result.avatarSha256 && used === item.url) item.result.avatarSha256 = resp.sha256;
  return info;
}
function photoName(item, info) {
  const q = item.query ? `${item.query.id}_${slug(item.query.value)}` : slug(item.result.query);
  return `${q}_${slug(item.result.source)}_${item.kind}_${info.sha256.slice(0, 12)}.${EXT[info.type] || 'img'}`;
}
async function downloadPhoto(item, btn) {
  btn.disabled = true; btn.textContent = 'Descargando…';
  try {
    const info = await fetchPhoto(item);
    download(photoName(item, info), info.bytes, info.type);
    persistSession(); updateCounts();
    toast('Foto descargada · SHA-256 ' + info.sha256.slice(0, 16) + '…');
  } catch (e) { toast('No se pudo descargar la foto: ' + (e.message || e)); }
  finally { renderPhotos(); }
}
const csvCell = v => { const t = String(v ?? ''); return /[;"\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
async function downloadAllPhotos() {
  const items = photoItems().filter(i => !i.external);
  if (!items.length) { toast('No hay fotos de fuentes consultadas por RASTRO.'); return; }
  if (state.running) { toast('Espera a que termine la búsqueda en curso.'); return; }
  const btn = $('#fotZip'); btn.disabled = true;
  const files = [], rows = [['fichero', 'consulta', 'identificador', 'fuente', 'tipo', 'nombre_mostrado', 'url_perfil', 'url_imagen', 'bytes', 'mime', 'sha256', 'descarga_utc', 'tambien_en']];
  const failed = [];
  let n = 0;
  for (const item of items) {
    $('#fotStatus').textContent = `Descargando ${++n}/${items.length}…`;
    try {
      const info = await fetchPhoto(item);
      const name = photoName(item, info);
      files.push({ name: 'fotos/' + name, bytes: info.bytes, date: new Date(info.ts) });
      const p = item.result.profile || {};
      rows.push([name, item.result.query, item.query ? item.query.value : '', item.result.name, item.kind, p.displayName || '', p.url || item.result.profileUrl || '', info.url, info.bytes.length, info.type, info.sha256, info.ts, item.alsoIn.join(' | ')]);
    } catch (e) { failed.push(`${item.result.name} (${item.kind}): ${e.message || e}`); }
  }
  if (!files.length) { $('#fotStatus').textContent = 'No se pudo descargar ninguna foto. ' + failed.join(' · '); btn.disabled = false; return; }
  const generated = new Date().toISOString();
  const manifest = rows.map(r => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
  const manifestHash = await U.sha256(manifest);
  const readme = [`RASTRO · HUELLA ${U.VERSION} — fotos de perfil`, `Sesión: ${state.session.id}`, `Expediente: ${$('#exp').value.trim() || '—'}`,
    `Generado (UTC): ${generated}`, `Ficheros: ${files.length}`, `SHA-256 de manifiesto.csv: ${manifestHash}`,
    failed.length ? `No descargadas: ${failed.join(' | ')}` : 'Todas las fotos solicitadas se descargaron.',
    '', 'Cada fichero lleva en el nombre los 12 primeros caracteres de su SHA-256; el hash completo figura en manifiesto.csv.',
    'Una foto de perfil es un indicio: puede ser genérica, copiada o de otra persona.'].join('\r\n') + '\r\n';
  const zip = zipStore([{ name: 'manifiesto.csv', bytes: '﻿' + manifest }, { name: 'LEEME.txt', bytes: readme }, ...files]);
  const zipHash = await U.sha256(zip);
  const exp = slug($('#exp').value.trim() || 'sin-expediente');
  download(`RASTRO-HUELLA_${exp}_fotos_${generated.replace(/[-:]/g, '').slice(0, 15)}Z.zip`, zip, 'application/zip');
  $('#fotStatus').textContent = `ZIP generado: ${files.length} fotos${failed.length ? `, ${failed.length} fallidas` : ''}. SHA-256 del ZIP: ${zipHash}`;
  btn.disabled = false;
  persistSession(); updateCounts(); renderPhotos();
}
function renderPhotos() {
  const box = $('#photos');
  const items = photoItems();
  if (!items.length) { box.replaceChildren(el('p', { class: 'muted' }, 'Sin fotos todavía. Aparecen al encontrar perfiles con foto o portada.')); return; }
  box.replaceChildren(el('div', { class: 'pgrid' }, items.map(item => {
    const r = item.result, p = r.profile || {}, done = photoDone.get(item.url);
    const sha = (done && done.sha256) || item.sha256;
    let visual;
    if (!state.settings.avatars) visual = el('div', { class: 'ph' }, 'Carga de imágenes desactivada («Cargar avatares»)');
    else if (item.external) {
      visual = el('div', { class: 'ph' }, el('button', { class: 'mini', onclick: e => { const img = avatarImg(item.url, 'pimg'); if (img) e.currentTarget.parentElement.replaceWith(img); } }, 'Mostrar (foto de proveedor externo)'));
    } else visual = avatarImg(item.hi, 'pimg') || el('div', { class: 'ph' }, 'Sin vista previa');
    if (visual && visual.tagName === 'IMG' && item.hi !== item.url) visual.addEventListener('error', () => { const alt = avatarImg(item.url, 'pimg'); if (alt) box.querySelector(`[data-k="${CSS.escape(item.key)}"] .ph-slot`)?.append(alt); }, { once: true });
    return el('figure', { class: 'pcard ' + item.kind, 'data-k': item.key, style: 'margin:0' },
      el('div', { class: 'ph-slot' }, visual),
      el('b', {}, `${r.name}`, el('span', { class: 'flag' }, item.kind), r.viaTab ? el('span', { class: 'flag' }, 'pestaña') : null, item.external ? el('span', { class: 'flag' }, 'externa') : null),
      p.displayName ? el('div', {}, p.displayName) : null,
      el('div', { class: 'pmeta' }, `${r.query}${item.query ? ' · ' + item.query.value : ''}${item.alsoIn.length ? ' · también en ' + item.alsoIn.join(', ') : ''}`),
      sha ? el('code', { title: 'SHA-256 de la imagen descargada' }, sha) : null,
      el('div', { class: 'plinks' },
        link(item.hi, 'Abrir original'),
        item.external ? null : el('button', { class: 'mini', onclick: e => downloadPhoto(item, e.currentTarget) }, done ? 'Descargar de nuevo' : 'Descargar'),
        el('button', { class: 'mini ghost', title: 'Copiar URL de la imagen', onclick: () => copy(item.hi) }, '⧉')),
      el('div', { class: 'plinks' }, el('span', { class: 'muted' }, 'Búsqueda inversa:'), REVERSE.map(([n, f]) => link(f(item.hi), n))));
  })));
}

/* ---------- Fuentes ---------- */
function renderSources() {
  const tb = $('#sources tbody');
  const rows = [...SOURCES_USER.map(s => ['Usuario', s]), ...SOURCES_EMAIL.map(s => ['Correo', s])];
  tb.replaceChildren(...rows.map(([type, s]) => {
    const cb = el('input', { type: 'checkbox', 'aria-label': 'Activar ' + s.name });
    cb.checked = !state.settings.disabled.includes(s.id);
    cb.addEventListener('change', () => {
      state.settings.disabled = state.settings.disabled.filter(x => x !== s.id);
      if (!cb.checked) state.settings.disabled.push(s.id);
      saveSettings();
      updateSourceCount();
    });
    return el('tr', {}, el('td', {}, cb), el('td', {}, el('b', {}, s.name), s.third ? el('span', { class: 'flag' }, 'tercero') : null, s.control ? el('span', { class: 'flag' }, 'control') : null, s.google ? el('span', { class: 'flag' }, 'sesión Google') : null, s.tabOnly || s.tabPreferred ? el('span', { class: 'flag' }, 'pestaña') : null),
      el('td', {}, type), el('td', {}, s.cat), el('td', {}, REL_LABEL[s.reliability] || s.reliability), el('td', {}, s.method), el('td', { class: 'mono url' }, s.endpoint));
  }));
  updateSourceCount();
}
function updateSourceCount() {
  const on = allSources().filter(s => !state.settings.disabled.includes(s.id)).length;
  $('#srcCount').textContent = `${on} de ${allSources().length} fuentes activas`;
}

/* ---------- Historial ---------- */
async function saveHistory(q) {
  const h = (await store.get('rhHistory')).rhHistory || [];
  const c = countResults(q.results);
  h.unshift({ ts: q.started, type: q.type, value: q.value, exp: q.expediente, found: c.found, total: q.results.length });
  await store.set({ rhHistory: h.slice(0, 500) });
}
async function renderHistory() {
  const tb = $('#history tbody');
  const h = (await store.get('rhHistory')).rhHistory || [];
  if (!h.length) { tb.replaceChildren(el('tr', {}, el('td', { colspan: 6, class: 'muted' }, 'Sin consultas guardadas.'))); return; }
  tb.replaceChildren(...h.map(x => el('tr', {},
    el('td', { class: 'mono' }, x.ts.replace('T', ' ').slice(0, 19)), el('td', {}, x.type === 'email' ? 'correo' : 'usuario'),
    el('td', { class: 'mono' }, x.value), el('td', {}, x.exp || '—'), el('td', { class: 'mono' }, `${x.found}/${x.total}`),
    el('td', {}, el('button', { class: 'ghost', onclick: () => { if (x.exp) $('#exp').value = x.exp; searchOne(x.type, x.value, 'Repetida desde historial'); } }, 'Repetir')))));
}

/* ---------- Informe ---------- */
async function generateReport() {
  if (!state.session.queries.length) { toast('No hay consultas en la sesión.'); return; }
  const generated = new Date().toISOString();
  const fields = { exp: $('#rExp').value.trim() || $('#exp').value.trim(), agent: $('#rAgent').value.trim(), notes: $('#rNotes').value.trim() };
  store.set({ rhLastAgent: fields.agent });
  const annex = $('#rAnnex').checked;
  const traceCsv = buildCsvTrace();
  fields.traceHash = await U.sha256(traceCsv);
  const body = buildTxt(generated, fields, annex);
  const hash = await U.sha256(body);
  state.report = { generated, fields, hash, annex, traceCsv, txt: body + `SHA-256: ${hash}\n` };
  state.report.html = buildHtml(state.report);
  $('#rHash').textContent = hash;
  $('#rHashBox').hidden = false;
  $('#rPreview').textContent = state.report.txt;
  $('#rState').textContent = `Generado ${U.utc(generated)}`;
  $('#rEvid').disabled = !allResults().some(r => r.evidence);
}
function fileBase() {
  const exp = (state.report.fields.exp || 'sin-expediente').replace(/[^\w.-]+/g, '_').slice(0, 40);
  return `RASTRO-HUELLA_${exp}_${state.report.generated.replace(/[-:]/g, '').slice(0, 15)}Z`;
}
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = el('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function withReport(fn) {
  return () => {
    if (!state.report) { toast('Genera el informe primero.'); return; }
    if (state.report.stale) toast('Aviso: la sesión ha cambiado desde que se generó el informe.');
    fn();
  };
}
function summaryText() {
  const c = countResults(allResults());
  return [`RASTRO · HUELLA — ${state.report.fields.exp || state.session.id}`,
    `Consultas: ${state.session.queries.map(q => q.value).join(', ')}`,
    `Encontrados: ${c.found} · Indeterminados: ${c.unknown}`,
    ...allResults().filter(r => r.status === 'found').map(r => `- ${r.name}: ${(r.profile && r.profile.url) || r.profileUrl || ''}`),
    `SHA-256 informe: ${state.report.hash}`].join('\n');
}

/* ---------- Sesión ---------- */
function resetSession() {
  if (state.running) return;
  if (state.session.queries.length && !confirm('¿Vaciar los resultados de esta sesión? Genera antes el informe si lo necesitas.')) return;
  state.session = newSession();
  state.report = null;
  store.remove('rhSession');
  $('#results').replaceChildren();
  $('#empty').hidden = false;
  $('#rHashBox').hidden = true;
  $('#rPreview').textContent = 'Genera el informe para verlo aquí.';
  $('#rState').textContent = '';
  setProgress(0, 0, '');
  updateCounts();
  refreshActivePanel();
}

async function offerRestore() {
  const saved = (await store.get('rhSession')).rhSession;
  if (!saved || !saved.queries || !saved.queries.length) return;
  const n = saved.queries.length;
  const banner = el('div', { class: 'banner', role: 'alert' },
    el('span', {}, `Hay una sesión anterior sin cerrar (${saved.id}, ${n} consulta${n > 1 ? 's' : ''}, guardada ${U.utc(saved.saved)}).`),
    el('button', { class: 'primary', onclick: () => { restoreSession(saved); computeConfidence(); renderAllResults(); updateCounts(); refreshActivePanel(); banner.remove(); toast('Sesión recuperada (las respuestas originales para evidencias no se conservan).'); } }, 'Recuperar'),
    el('button', { class: 'ghost', onclick: () => { store.remove('rhSession'); banner.remove(); } }, 'Descartar'));
  $('.searchbar').prepend(banner);
}

let providerController = null;
async function recordProvider(email, rows, provenance, hash, response = null) {
  const ts=new Date().toISOString();
  let q=state.session.queries.find(q=>q.type==='email'&&q.value.toLowerCase()===email.toLowerCase());
  if(!q){q={id:'Q'+(state.session.queries.length+1),type:'email',value:email,origin:provenance,started:ts,finished:ts,results:[]};state.session.queries.push(q);}
  let added=0;
  rows.forEach((row,index)=>{
    const source='external-'+hash.slice(0,16)+'-'+index;
    if(q.results.some(r=>r.source===source))return;
    q.results.push({source,name:row.name+' · externo',cat:'Proveedor externo',status:'info',query:q.id,third:true,ts,
      evidenceType:row.negative?'Ausencia declarada por proveedor':'Hallazgo externo no verificado',basis:provenance+'. '+row.reason,
      responseSha256:hash,profile:row.negative?{bio:row.reason}:row.profile,
      proofs:[{url:response?.url||null,sha256:hash,ts,detail:provenance}],
      provenance:{provider:'OSINT Industries',mode:response?'api':'import',input:email,module:row.name},
      reason:row.reason});added++;
  });
  if(state.report)state.report.stale=true;
  persistSession();renderAllResults();updateCounts();$('#empty').hidden=true;
  return added;
}
function bindEnrichment() {
  $('#providerStop').addEventListener('click',()=>providerController?.abort());
  $('#providerForm').addEventListener('submit',async event=>{
    event.preventDefault();if(state.running)return toast('Hay una consulta en curso');
    const email=$('#providerEmail').value.trim(),key=$('#providerKey').value;
    if(!U.isEmail(email)||!key.trim())return toast('Introduce correo y clave válidos');
    const button=event.currentTarget.querySelector('button[type=submit]');
    providerController=new AbortController();state.controller=providerController;
    setBusy(true);button.disabled=true;$('#providerStop').disabled=false;$('#providerImport').disabled=true;
    $('#providerStatus').textContent='Consultando proveedor externo… puede tardar hasta 70 segundos.';
    const trace=[];
    try {
      const ctx=createRequester({trace,timeout:70000,signal:providerController.signal})('osint-industries','externa');
      const {rows,response}=await requestProvider(email,key,ctx);
      const added=await recordProvider(email,rows,'Respuesta API de OSINT Industries; no contrastada por RASTRO',response.sha256,response);
      const q=state.session.queries.find(q=>q.type==='email'&&q.value.toLowerCase()===email.toLowerCase());
      trace.forEach(t=>t.query=q.id);
      $('#providerStatus').textContent=`${rows.length} módulos recibidos; ${added} registros añadidos. Consulta Resultados → Relevantes o Todos. La ausencia de un módulo no demuestra ausencia de cuenta.`;
    } catch(e) {$('#providerStatus').textContent=providerController.signal.aborted?'Espera detenida. El proveedor puede haber procesado o cobrado la consulta.':String(e.message||e);}
    finally {state.session.trace.push(...trace);persistSession();$('#providerKey').value='';setBusy(false);button.disabled=false;$('#providerStop').disabled=true;$('#providerImport').disabled=false;providerController=null;}
  });
  $('#providerImport').addEventListener('change',async event=>{
    const file=event.target.files[0];if(!file)return;
    if(state.running){event.target.value='';return toast('Espera a que termine la consulta');}
    const email=$('#providerEmail').value.trim();
    if(!U.isEmail(email)){event.target.value='';return toast('Indica primero el correo al que corresponde el JSON');}
    if(file.size>5*1024*1024){event.target.value='';return toast('El archivo supera 5 MB');}
    setBusy(true);
    try {
      const raw=await file.text(),rows=providerRows(JSON.parse(raw)),hash=await U.sha256(raw);
      const added=await recordProvider(email,rows,'Importación declarada por el investigador; asociación al correo no verificada',hash);
      $('#providerStatus').textContent=`Importación local: ${rows.length} módulos, ${added} registros nuevos. SHA-256 del archivo: ${hash}`;
    }catch(e){toast('No se pudo importar: '+e.message);}
    finally{setBusy(false);event.target.value='';}
  });
}

/* ---------- Arranque ---------- */
async function init() {
  $('#ver').textContent = 'v' + U.VERSION;
  try { chrome.runtime.sendMessage({ type: 'ensureRules' }); } catch { /* */ }
  await loadSettings();
  renderSources();
  bindEnrichment();

  $('#mentionForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (state.running) return toast('Espera a que termine la búsqueda.');
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    try {
      const m = validateMention($('#mentionEmail').value.trim(), $('#mentionUrl').value, $('#mentionText').value);
      const ts = new Date().toISOString(), hash = await U.sha256(m.excerpt);
      let q = state.session.queries.find(q => q.type === 'email' && q.value.toLowerCase() === m.email.toLowerCase());
      if (!q) { q = {id:'Q'+(state.session.queries.length+1),type:'email',value:m.email,origin:'Aportación manual',started:ts,finished:ts,results:[]}; state.session.queries.push(q); }
      if (q.results.some(r => r.manual && r.profile?.url === m.url && r.responseSha256 === hash)) return toast('Esta mención ya está guardada.');
      q.results.push({source:'manual-'+Date.now(),name:'Mención aportada por el investigador',cat:'Mención pública',query:q.id,status:'info',manual:true,ts,
        evidenceType:'Fragmento aportado manualmente',basis:'Contiene el correo exacto. URL y texto aportados por el investigador; no se ha descargado ni validado la página.',responseSha256:hash,
        profile:{url:m.url,bio:m.excerpt,emails:[m.email],extra:{'Procedencia':'Aportación manual, no captura web','SHA-256 del fragmento':hash,'Registro UTC':ts}},
        evidence:{url:m.url,ts,sha256:hash,body:m.excerpt,chars:m.excerpt.length,truncated:false,manual:true}});
      if (state.report) state.report.stale = true;
      persistSession();renderAllResults();updateCounts();
      $('#mentionForm').reset();toast('Mención guardada; incluida en la sesión y en las exportaciones.');
    } catch(e) { toast(e.message || String(e)); }
    finally { button.disabled = false; }
  });
  $('#q').addEventListener('input', showDetected);
  $('#q').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startFromInput(); } });
  $('#exp').addEventListener('keydown', e => { if (e.key === 'Enter') startFromInput(); });
  $('#go').addEventListener('click', () => startFromInput());
  $('#stop').addEventListener('click', () => { if (state.controller) { state.controller.abort(); toast('Búsqueda detenida.'); } });
  $('#reset').addEventListener('click', resetSession);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.running && state.controller) state.controller.abort(); });

  const bindOpt = (id, key, map = v => v) => $(id).addEventListener('change', e => {
    state.settings[key] = map(e.target.type === 'checkbox' ? e.target.checked : e.target.value);
    saveSettings();
    if (key === 'avatars') refreshActivePanel();
  });
  bindOpt('#optAvatars', 'avatars');
  bindOpt('#optThird', 'third');
  bindOpt('#optGoogle', 'google');
  $('#fotZip').addEventListener('click', downloadAllPhotos);
  bindOpt('#optDerived', 'derived');
  bindOpt('#optAuto', 'auto');
  bindOpt('#optTab', 'tab');
  $('#tabAll').addEventListener('click', verifyAllBlocked);
  bindOpt('#optEmailLimit', 'emailLimit', Number);
  bindOpt('#optConc', 'concurrency', Number);
  bindOpt('#optTimeout', 'timeout', v => Number(v) * 1000);

  $$('#tabs button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $$('#filter button').forEach(b => b.addEventListener('click', () => {
    $$('#filter button').forEach(x => x.classList.toggle('active', x === b));
    $('#results').dataset.filter = b.dataset.f;
  }));
  $('#ftext').addEventListener('input', () => applyTextFilter());

  $('#pivAll').addEventListener('click', () => {
    const pending = pendingPivots();
    if (!pending.length) { toast('No hay identificadores pendientes.'); return; }
    if (pending.length > 5 && !confirm(`Se lanzarán ${pending.length} búsquedas. ¿Continuar?`)) return;
    switchTab('res');
    runBatch(pending.map(x => ({ type: x.type, value: x.value })), 'Pivote en bloque');
  });

  $('#srcAll').addEventListener('click', () => { state.settings.disabled = []; saveSettings(); renderSources(); });
  $('#srcNone').addEventListener('click', () => { state.settings.disabled = allSources().map(s => s.id); saveSettings(); renderSources(); });
  $('#srcReliable').addEventListener('click', () => { state.settings.disabled = allSources().filter(s => s.reliability === 'baja').map(s => s.id); saveSettings(); renderSources(); });
  $('#hisClear').addEventListener('click', async () => {
    if (!confirm('¿Borrar todo el historial de consultas de este navegador?')) return;
    await store.remove('rhHistory');
    renderHistory();
  });

  $('#rGen').addEventListener('click', generateReport);
  ['#rExp', '#rAgent', '#rNotes'].forEach(id => $(id).addEventListener('input', () => { if (state.report) { state.report.stale = true; $('#rState').textContent = 'Datos modificados: vuelve a generar el informe.'; } }));
  $('#rTxt').addEventListener('click', withReport(() => download(fileBase() + '.txt', state.report.txt, 'text/plain;charset=utf-8')));
  $('#rHtml').addEventListener('click', withReport(() => download(fileBase() + '.html', state.report.html, 'text/html;charset=utf-8')));
  $('#rJson').addEventListener('click', withReport(() => download(fileBase() + '.json', buildJson(state.report), 'application/json')));
  $('#rCsvE').addEventListener('click', withReport(() => download(fileBase() + '_entidades.csv', buildCsvEntities(), 'text/csv;charset=utf-8')));
  $('#rCsvR').addEventListener('click', withReport(() => download(fileBase() + '_relaciones.csv', buildCsvRelations(), 'text/csv;charset=utf-8')));
  $('#rTrace').addEventListener('click', withReport(() => download(fileBase() + '_trazabilidad.csv', state.report.traceCsv, 'text/csv;charset=utf-8')));
  $('#rAnnex').addEventListener('change', () => { if (state.report) { state.report.stale = true; $('#rState').textContent = 'Opciones cambiadas: vuelve a generar el informe.'; } });
  $('#rEvid').addEventListener('click', withReport(() => download(fileBase() + '_evidencias.json', buildEvidence(state.report), 'application/json')));
  $('#rCopy').addEventListener('click', withReport(() => copy(summaryText(), 'Resumen copiado')));
  $('#rPrint').addEventListener('click', withReport(() => {
    const fr = $('#printFrame');
    fr.onload = () => { fr.onload = null; try { fr.contentWindow.focus(); fr.contentWindow.print(); } catch { toast('No se pudo imprimir: descarga el HTML.'); } };
    fr.srcdoc = state.report.html;
  }));

  const q = new URLSearchParams(location.search).get('q');
  if (q) {
    $('#q').value = q;
    showDetected();
    history.replaceState(null, '', location.pathname);
    startFromInput('Menú contextual');
  } else {
    await offerRestore();
  }
  updateCounts();
}

document.addEventListener('DOMContentLoaded', init);
window.addEventListener('beforeunload', e => { if (state.running) { e.preventDefault(); e.returnValue = ''; } persistSession(); });
