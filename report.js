/* RASTRO · HUELLA — informe de resultados y exportaciones
   El informe se centra en las cuentas localizadas y su vínculo con el objetivo.
   El detalle técnico (trazabilidad, campos completos, respuestas) va en anexos con su propio hash. */
import * as U from './util.js';
import { state, allResults, countResults, correlationData, isDirectOnly, serializeSession, computeConfidence } from './engine.js';

export const STATUS_LABEL = { found: 'ENCONTRADO', notfound: 'NO ENCONTRADO', unknown: 'INDETERMINADO', na: 'NO APLICA', info: 'INFO', pending: 'CONSULTANDO…' };
export const CONTROL_LABEL = { ok: 'verificado con identificador de control', inconclusive: 'control no concluyente', skip: null };
const CONF_ORDER = { alta: 0, media: 1, baja: 2 };
const qLabel = q => `${q.type === 'email' ? 'correo' : 'usuario'} ${q.value}`;

/* Campos completos de un perfil (anexo técnico y CSV) */
export function profileFields(p, r = {}) {
  const posts = p.postsLabel ? p.postsLabel[0].toUpperCase() + p.postsLabel.slice(1) : 'Publicaciones';
  return [
    ['Tipo de evidencia', r.evidenceType], ['Fundamento', r.basis], ['Cobertura', r.coverage ? JSON.stringify(r.coverage) : null], ['Respuestas de soporte', r.proofs ? JSON.stringify(r.proofs) : null],
    ['URL', p.url], ['Nombre mostrado', p.displayName], ['Usuario', p.username], ['Biografía', p.bio],
    ['Seguidores', p.followers], ['Seguidos', p.following], [posts, p.posts],
    ['Ubicación', p.location], ['Web', p.website], ['Alta', U.date(p.created)], ['Última actividad', U.date(p.lastActive)],
    ['Verificación', p.verified], ['Privada', p.private === true ? 'Sí' : null], ['Correos', (p.emails || []).join(', ')],
    ['Avatar', p.avatar], ['SHA-256 avatar', r.avatarSha256], ['Portada', p.banner], ['Control', CONTROL_LABEL[r.control]], ['SHA-256 respuesta', r.responseSha256],
    ...Object.entries(p.extra || {}).map(([k, v]) => [k, v === true ? 'Sí' : v])
  ].filter(([, v]) => !U.isEmpty(v) && v !== false);
}

/* Datos clave en una línea */
function keyFacts(p) {
  return [
    U.date(p.created) && `alta ${U.date(p.created)}`,
    p.location && `ubicación: ${p.location}`,
    !U.isEmpty(p.followers) && `${U.num(p.followers)} seguidores`,
    U.date(p.lastActive) && `última actividad ${U.date(p.lastActive)}`,
    p.website && `web: ${p.website}`
  ].filter(Boolean).join(' · ');
}
const accountTitle = (r) => {
  const p = r.profile || {};
  const parts = [p.displayName, p.username && '@' + String(p.username).replace(/^@/, '')].filter(Boolean);
  return parts.length ? parts.join(' ') : (p.existenceOnly ? 'cuenta registrada (sin perfil público)' : '');
};

const shortReason = r => (r || 'Sin respuesta').replace(/^Respuesta no concluyente /, '').replace(/ de la plataforma/, '');
function groupByReason(list) {
  const m = new Map();
  list.forEach(r => { const k = shortReason(r.reason); if (!m.has(k)) m.set(k, []); m.get(k).push(r.name); });
  return [...m.entries()].map(([reason, names]) => ({ reason, names }));
}

/* Modelo de datos común para TXT y HTML */
export function reportModel() {
  computeConfidence();
  const S = state.session;
  const results = allResults();
  const found = results.filter(r => r.status === 'found')
    .sort((a, b) => CONF_ORDER[a.confidence] - CONF_ORDER[b.confidence] || a.name.localeCompare(b.name, 'es'));
  const qById = Object.fromEntries(S.queries.map(q => [q.id, q]));
  const strongPivots = [...S.pivots.values()].filter(x => !isDirectOnly(x) && ![...x.via].every(v => v === 'Derivado del correo') && !x.searched);
  const pending = results.filter(r => r.status === 'unknown');
  const pendingBySource = new Map();
  pending.forEach(r => { if (!pendingBySource.has(r.name)) pendingBySource.set(r.name, r); });
  return {
    S, qById,
    linked: found.filter(r => r.confidence !== 'baja'),
    aliasOnly: found.filter(r => r.confidence === 'baja'),
    info: results.filter(r => r.status === 'info'),
    pivots: {
      emails: strongPivots.filter(x => x.type === 'email').map(x => x.value),
      users: strongPivots.filter(x => x.type === 'username').map(x => x.value),
      urls: strongPivots.filter(x => x.type === 'url').map(x => x.value)
    },
    pending: [...pendingBySource.values()],
    pendingGroups: groupByReason([...pendingBySource.values()]),
    discarded: [...S.unreliable.keys()].map(id => (results.find(r => r.source === id) || {}).name || id),
    totals: countResults(results),
    avatars: correlationData().avatars
  };
}

/* ---------- TXT canónico (el hash se calcula sobre este texto) ---------- */
export function buildTxt(generated, f, annex) {
  const m = reportModel();
  const L = [];
  const line = (s = '') => L.push(s);
  const hr = c => line(c.repeat(72));
  hr('=');
  line('RASTRO · HUELLA — INFORME DE RESULTADOS');
  hr('=');
  line(`Expediente: ${f.exp || '—'}    Agente/TIP: ${f.agent || '—'}`);
  line(`Fecha: ${U.utc(generated)}    Herramienta: RASTRO · HUELLA v${U.VERSION} · sesión ${m.S.id}`);
  if (f.notes) line(`Observaciones: ${f.notes.replace(/\s*\n\s*/g, ' / ')}`);
  line();
  line('IDENTIFICADORES CONSULTADOS');
  m.S.queries.forEach(q => line(`  ${q.id}  ${qLabel(q)}  (${q.origin})`));
  line();
  line('RESUMEN');
  line(`  Cuentas con vínculo al objetivo: ${m.linked.length} (alta ${m.linked.filter(r => r.confidence === 'alta').length} · media ${m.linked.filter(r => r.confidence === 'media').length})`);
  line(`  Coincidencias solo de alias:     ${m.aliasOnly.length}`);
  line(`  Pendientes de comprobar a mano:  ${m.pending.length}`);
  line();

  hr('-'); line('A. CUENTAS CON VÍNCULO AL OBJETIVO'); hr('-');
  if (!m.linked.length) line('  Ninguna.');
  m.linked.forEach(r => {
    const p = r.profile || {};
    line(`  [${r.confidence.toUpperCase()}] ${r.name}${accountTitle(r) ? ' — ' + accountTitle(r) : ''}`);
    if (p.url && !p.existenceOnly) line(`         ${p.url}`);
    const kf = keyFacts(p);
    if (kf) line(`         ${kf}`);
    if (r.evidenceType) line(`         Evidencia: ${r.evidenceType}. ${r.basis || ''}`);
    line(`         Vínculo: ${r.why.join('; ')}`);
    line(`         Origen: ${m.qById[r.query] ? qLabel(m.qById[r.query]) : r.query}`);
  });
  line();

  hr('-'); line('B. COINCIDENCIAS SOLO DE ALIAS (pueden ser otras personas)'); hr('-');
  if (!m.aliasOnly.length) line('  Ninguna.');
  m.aliasOnly.forEach(r => line(`  ${r.name}${accountTitle(r) ? ' — ' + accountTitle(r) : ''} — ${(r.profile && r.profile.url) || r.profileUrl || ''}`));
  line();

  if (m.pivots.emails.length || m.pivots.users.length || m.pivots.urls.length || m.info.length) {
    hr('-'); line('C. DATOS DE INTERÉS PARA CONTINUAR'); hr('-');
    if (m.pivots.emails.length) line(`  Correos: ${m.pivots.emails.join(', ')}`);
    if (m.pivots.users.length) line(`  Usuarios: ${m.pivots.users.join(', ')}`);
    if (m.pivots.urls.length) line(`  Enlaces: ${m.pivots.urls.join(', ')}`);
    m.info.forEach(r => { line(`  ${r.name}: ${(r.profile && r.profile.bio) || ''}`); if(r.profile?.url) line(`    Fuente: ${r.profile.url}`); if(r.basis) line(`    Alcance: ${r.basis}`); });
    line();
  }

  if (m.pending.length) {
    hr('-'); line('D. PENDIENTE DE COMPROBACIÓN MANUAL'); hr('-');
    m.pendingGroups.forEach(g => line(`  ${g.reason}: ${g.names.join(', ')}`));
    line();
  }

  if (annex) {
    hr('='); line('ANEXO TÉCNICO'); hr('=');
    allResults().filter(r => r.status === 'found' || r.status === 'info').forEach(r => {
      line(`[${r.query}] ${r.name} · fiabilidad ${r.reliability || '—'} · consultado ${U.utc(r.ts)}`);
      profileFields(r.profile || {}, r).forEach(([k, v]) => line(`     ${k}: ${String(v).replace(/\s*\n\s*/g, ' / ')}`));
    });
    line();
    line(`Trazabilidad (${m.S.trace.length} peticiones): UTC | consulta | fuente | tipo | HTTP | ms | SHA-256 | URL`);
    m.S.trace.forEach(t => line([t.ts, t.query, t.source, t.tag || 'consulta', t.status ?? '---', t.ms ?? '', t.sha256 || '', t.url + (t.error ? ' ERROR: ' + t.error : '')].join(' | ')));
    line();
  }

  hr('-');
  line(`Fuentes consultadas: ${m.totals.found + m.totals.notfound + m.totals.unknown + m.totals.na + m.totals.info} comprobaciones en ${m.S.queries.length} consultas.`);
  if (m.discarded.length) line(`Fuentes descartadas por no distinguir perfiles inexistentes: ${m.discarded.join(', ')}.`);
  if (f.traceHash) line(`Anexo de trazabilidad (CSV, ${m.S.trace.length} peticiones) SHA-256: ${f.traceHash}`);
  line('Nota: una coincidencia de alias es un indicio y no acredita por sí sola la identidad del titular.');
  line('La línea siguiente contiene el SHA-256 (UTF-8) de todo el texto anterior.');
  return L.join('\n') + '\n';
}

/* ---------- HTML imprimible (compacto) ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const urlCell = u => u ? `<span class="u">${esc(u)}</span>` : '';

export function buildHtml(snap) {
  const m = reportModel();
  const f = snap.fields;
  const nHigh = m.linked.filter(r => r.confidence === 'alta').length;
  const linkedRows = m.linked.map(r => {
    const p = r.profile || {};
    return `<tr><td><b class="c-${r.confidence}">${r.confidence.toUpperCase()}</b></td><td><b>${esc(r.name)}</b><br>${esc(accountTitle(r))}<br>${p.existenceOnly ? '' : urlCell(p.url)}</td><td>${esc(keyFacts(p)) || '—'}</td><td>${esc(r.evidenceType || '')}<br>${esc(r.basis || '')}<br>${esc(r.why.join('; '))}</td></tr>`;
  }).join('');
  const aliasRows = m.aliasOnly.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(accountTitle(r))}</td><td>${urlCell((r.profile && r.profile.url) || r.profileUrl)}</td></tr>`).join('');
  const interest = [
    m.pivots.emails.length && `<li><b>Correos:</b> ${esc(m.pivots.emails.join(', '))}</li>`,
    m.pivots.users.length && `<li><b>Usuarios:</b> ${esc(m.pivots.users.join(', '))}</li>`,
    m.pivots.urls.length && `<li><b>Enlaces:</b> ${esc(m.pivots.urls.join(', '))}</li>`,
    ...m.info.map(r => `<li><b>${esc(r.name)}:</b> ${esc((r.profile && r.profile.bio) || '')}<br>${urlCell(r.profile?.url)}<br>${esc(r.basis || '')}</li>`)
  ].filter(Boolean).join('');
  const annex = snap.annex ? `<h2>Anexo técnico</h2>${allResults().filter(r => r.status === 'found' || r.status === 'info').map(r =>
    `<h3>[${esc(r.query)}] ${esc(r.name)}</h3><table class="kv">${profileFields(r.profile || {}, r).map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>`).join('')}` : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>RASTRO · HUELLA — ${esc(f.exp || m.S.id)}</title>
<style>body{font:11.5px/1.45 Arial,Helvetica,sans-serif;color:#111;margin:24px;max-width:1000px}
h1{font-size:17px;margin:0 0 4px;letter-spacing:.04em}h2{font-size:12.5px;text-transform:uppercase;letter-spacing:.06em;border-bottom:1.5px solid #111;margin:18px 0 6px;padding-bottom:2px}
h3{font-size:12px;margin:10px 0 2px}.meta{color:#333;margin:0 0 10px}.meta b{color:#111}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:4px 6px;text-align:left;vertical-align:top;word-break:break-word}th{background:#efefef;font-size:11px}
.u{font-family:Consolas,monospace;font-size:10.5px;color:#225}.kv th{width:160px}
.sum{display:flex;gap:10px;margin:8px 0}.sum div{border:1px solid #bbb;padding:6px 10px;flex:1}.sum b{display:block;font-size:18px}
.c-alta{color:#0a6b28}.c-media{color:#9a6700}.small{color:#555;font-size:10.5px}.foot{margin-top:16px;border-top:1px solid #999;padding-top:6px;font-size:10.5px;color:#333}
.hash{font-family:Consolas,monospace;word-break:break-all}ul{margin:4px 0;padding-left:18px}@media print{body{margin:10mm}}</style></head><body>
<h1>RASTRO · HUELLA — Informe de resultados</h1>
<p class="meta"><b>Expediente:</b> ${esc(f.exp || '—')} &nbsp; <b>Agente/TIP:</b> ${esc(f.agent || '—')} &nbsp; <b>Fecha:</b> ${esc(U.utc(snap.generated))}<br>
<b>Consultas:</b> ${m.S.queries.map(q => `${esc(q.id)} ${esc(qLabel(q))}`).join(' · ')}${f.notes ? `<br><b>Observaciones:</b> ${esc(f.notes)}` : ''}</p>
<div class="sum"><div><b>${m.linked.length}</b>cuentas con vínculo (${nHigh} alta)</div><div><b>${m.aliasOnly.length}</b>coincidencias solo de alias</div><div><b>${m.pending.length}</b>pendientes de comprobar</div></div>
<h2>A. Cuentas con vínculo al objetivo</h2>
${linkedRows ? `<table><tr><th style="width:60px">Confianza</th><th style="width:34%">Cuenta</th><th>Datos</th><th style="width:28%">Vínculo</th></tr>${linkedRows}</table>` : '<p>Ninguna.</p>'}
<h2>B. Coincidencias solo de alias</h2><p class="small">Existe una cuenta con ese alias, pero nada la vincula aún con el objetivo: puede pertenecer a otra persona.</p>
${aliasRows ? `<table><tr><th style="width:22%">Plataforma</th><th style="width:30%">Cuenta</th><th>URL</th></tr>${aliasRows}</table>` : '<p>Ninguna.</p>'}
${interest ? `<h2>C. Datos de interés para continuar</h2><ul>${interest}</ul>` : ''}
${m.pending.length ? `<h2>D. Pendiente de comprobación manual</h2><ul class="small">${m.pendingGroups.map(g => `<li><b>${esc(g.reason)}:</b> ${esc(g.names.join(', '))}</li>`).join('')}</ul>` : ''}
${annex}
<div class="foot">${m.discarded.length ? `Fuentes descartadas por no distinguir perfiles inexistentes: ${esc(m.discarded.join(', '))}.<br>` : ''}
${f.traceHash ? `Anexo de trazabilidad (CSV, ${m.S.trace.length} peticiones) SHA-256: <span class="hash">${esc(f.traceHash)}</span><br>` : ''}
Una coincidencia de alias es un indicio y no acredita por sí sola la identidad del titular.<br>
SHA-256 del informe TXT de esta generación: <span class="hash">${esc(snap.hash)}</span></div></body></html>`;
}

/* ---------- JSON estructurado ---------- */
export function buildJson(snap) {
  return JSON.stringify({
    herramienta: `RASTRO · HUELLA v${U.VERSION}`, generado: snap.generated, sha256_informe_txt: snap.hash,
    sha256_trazabilidad_csv: snap.fields.traceHash, informe: snap.fields, ajustes: state.settings, sesion: serializeSession()
  }, null, 2);
}

/* ---------- Evidencias: respuestas originales de los positivos ---------- */
export function buildEvidence(snap) {
  const items = allResults().filter(r => r.evidence && r.status !== 'na').map(r => ({
    consulta: r.query, fuente: r.name, estado: r.status, confianza: r.confidence, url: r.evidence.url, http: r.evidence.status,
    hora_utc: r.evidence.ts, sha256: r.evidence.sha256, caracteres: r.evidence.chars, truncado: r.evidence.truncated, cuerpo: r.evidence.body, aportacion_manual: !!r.evidence.manual
  }));
  return JSON.stringify({
    herramienta: `RASTRO · HUELLA v${U.VERSION}`, generado: snap.generated, expediente: snap.fields.exp, sesion: state.session.id,
    nota: 'El SHA-256 se calcula sobre el cuerpo completo recibido (texto UTF-8). Si «truncado» es true, el cuerpo guardado es parcial.',
    respuestas: items
  }, null, 2);
}

/* ---------- CSV (separador «;», Excel en español, i2/Maltego/Gephi) ---------- */
const csvCell = v => { const s = String(v ?? '').replace(/\r?\n/g, ' '); return /[;"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const csv = rows => '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n') + '\r\n';

export function buildCsvTrace() {
  return csv([['hora_utc', 'consulta', 'fuente', 'tipo', 'intento', 'metodo', 'http', 'ms', 'bytes', 'sha256_cuerpo', 'url', 'url_final', 'error'],
    ...state.session.trace.map(t => [t.ts, t.query, t.source, t.tag || 'consulta', t.attempt, t.method, t.status ?? '', t.ms ?? '', t.bytes ?? '', t.sha256 || '', t.url, t.finalUrl || '', t.error || ''])]);
}

export function buildCsvEntities() {
  computeConfidence();
  const head = ['consulta', 'identificador', 'plataforma', 'estado', 'confianza', 'vinculo', 'url', 'nombre', 'usuario', 'ubicacion', 'web', 'alta', 'ultima_actividad', 'seguidores', 'correos', 'sha256_respuesta', 'motivo', 'hora_utc', 'tipo_evidencia', 'fundamento', 'cobertura', 'fragmento'];
  const qv = Object.fromEntries(state.session.queries.map(q => [q.id, q.value]));
  return csv([head, ...allResults().filter(r => r.status === 'found' || r.status === 'info' || r.status === 'unknown').map(r => {
    const p = r.profile || {};
    return [r.query, qv[r.query], r.name, STATUS_LABEL[r.status], r.confidence || '', (r.why || []).join('; '), p.url || r.profileUrl, p.displayName, p.username, p.location, p.website, U.date(p.created), U.date(p.lastActive), p.followers, (p.emails || []).join(' '), r.responseSha256, r.reason, r.ts, r.evidenceType, r.basis, r.coverage ? JSON.stringify(r.coverage) : null, r.manual ? p.bio : null];
  })]);
}

export function buildCsvRelations() {
  computeConfidence();
  const rows = [['origen', 'tipo_origen', 'relacion', 'destino', 'tipo_destino', 'confianza', 'via', 'consulta']];
  const qv = Object.fromEntries(state.session.queries.map(q => [q.id, q]));
  allResults().filter(r => r.status === 'found').forEach(r => {
    const q = qv[r.query];
    const acc = (r.profile && !r.profile.existenceOnly && r.profile.url) || r.profileUrl || `${r.name}:${q.value}`;
    rows.push([q.value, q.type, q.type === 'email' ? (r.evidenceType === 'Correo público exacto' ? 'publica_correo' : 'indicio_asociacion') : 'alias_en', acc, 'cuenta', r.confidence, r.name, r.query]);
    (r.pivots || []).forEach(x => rows.push([acc, 'cuenta', x.type === 'url' ? 'enlaza_a' : 'menciona', x.value, x.type, '', r.name, r.query]));
  });
  correlationData().avatars.forEach((g, i) => {
    for (let a = 0; a < g.length - 1; a++) {
      const A = g[a], B = g[a + 1];
      rows.push([(A.profile && A.profile.url) || A.name, 'cuenta', 'mismo_avatar', (B.profile && B.profile.url) || B.name, 'cuenta', 'alta', `grupo ${i + 1}`, `${A.query}/${B.query}`]);
    }
  });
  return csv(rows);
}
