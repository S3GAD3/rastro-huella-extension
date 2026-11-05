'use strict';
/* RASTRO · HUELLA — service worker
   - Abre la consola de investigación al pulsar el icono.
   - Menú contextual sobre texto seleccionado.
   - Reglas de cabeceras SOLO para las peticiones que lanza la propia extensión:
     elimina la cabecera Origin (chrome-extension://…) que muchas plataformas rechazan
     y aplica el consentimiento de cookies mínimo de YouTube para evitar el muro de la UE. */

const APP = 'app.html';

async function ensureRules() {
  const id = chrome.runtime.id;
  const xhr = ['xmlhttprequest', 'other'];
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [1, 2],
      addRules: [
        {
          id: 1, priority: 1,
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
          condition: { initiatorDomains: [id], resourceTypes: xhr }
        },
        {
          id: 2, priority: 2,
          action: {
            type: 'modifyHeaders', requestHeaders: [
              { header: 'origin', operation: 'remove' },
              { header: 'cookie', operation: 'set', value: 'SOCS=CAI; CONSENT=YES+cb' }
            ]
          },
          condition: { initiatorDomains: [id], requestDomains: ['youtube.com'], resourceTypes: xhr }
        }
      ]
    });
  } catch (e) {
    console.warn('RASTRO HUELLA: no se pudieron instalar las reglas de cabeceras', e);
  }
}

function openApp(query) {
  const url = chrome.runtime.getURL(APP) + (query ? '?q=' + encodeURIComponent(query) : '');
  chrome.tabs.create({ url });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'rh-search', title: 'RASTRO HUELLA: buscar «%s»', contexts: ['selection'] });
  });
  ensureRules();
});

chrome.runtime.onStartup.addListener(ensureRules);
ensureRules();

chrome.action.onClicked.addListener(() => openApp());

chrome.contextMenus.onClicked.addListener(info => {
  if (info.menuItemId === 'rh-search' && info.selectionText) openApp(info.selectionText.trim().slice(0, 320));
});

/* ---------- Verificación en pestaña ----------
   Abre la URL en una pestaña de fondo, espera a que cargue (y a que termine un posible reto anti-bot),
   lee la página renderizada y cierra la pestaña. Usa la sesión normal del navegador. */
const CHALLENGE = /just a moment|un momento|attention required|checking your browser|comprobando|verifying you are human|verificando|access denied|captcha|ddos-guard|please wait/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function waitComplete(tabId, ms) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(t); chrome.tabs.onUpdated.removeListener(l); resolve(); };
    const l = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(l);
    chrome.tabs.get(tabId).then(tab => { if (tab.status === 'complete') done(); }).catch(done);
  });
}

async function readTab(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({ url: location.href, title: document.title, html: document.documentElement.outerHTML.slice(0, 900000) })
  });
  return result;
}

async function tabProbe(url, wait, waitTitle) {
  const t0 = Date.now();
  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
    await waitComplete(tab.id, 20000);
    await sleep(1200);                                  // margen para páginas que se pintan con JavaScript
    let page = await readTab(tab.id);
    if (waitTitle) {                                    // SPA (X, Facebook): esperar a que el título refleje el perfil
      let re; try { re = new RegExp(waitTitle, 'i'); } catch { re = null; }
      const until = Date.now() + Math.min(Number(wait) || 4000, 10000);
      while (re && !re.test(page.title || '') && Date.now() < until) { await sleep(500); page = await readTab(tab.id); }
      await sleep(700);
      page = await readTab(tab.id);
    }
    for (let i = 0; i < 8 && CHALLENGE.test(page.title || ''); i++) {   // reto anti-bot: esperar a que se resuelva
      await sleep(1500);
      await waitComplete(tab.id, 5000);
      page = await readTab(tab.id);
    }
    return { ok: true, ...page, challenge: CHALLENGE.test(page.title || ''), ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), ms: Date.now() - t0 };
  } finally {
    if (tab) try { await chrome.tabs.remove(tab.id); } catch { /* ya cerrada */ }
  }
}

/* ---------- Google por correo (opcional, con la sesión de Google del navegador) ----------
   Abre photos.google.com en una pestaña de fondo y, dentro de esa página, consulta la People API
   interna con la cabecera SAPISIDHASH que usan las propias webs de Google. Solo lectura: no
   modifica la cuenta ni notifica al titular del correo. Google registra la consulta en la cuenta
   con sesión iniciada: usar SIEMPRE una cuenta de investigación. */
const GOOGLE_KEY = 'AIzaSyAa2odBewW-sPJu3jMORr0aNedh3YlkiQc';   // clave pública del cliente web de Google Fotos

/* Se serializa y se ejecuta en la pestaña (mundo aislado): debe ser autocontenida */
async function googleInPage(email, key) {
  const cookie = document.cookie.match(/(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/);
  if (!cookie) return { ok: false, error: 'nosession' };
  const origin = location.origin;
  const sha1 = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const params = new URLSearchParams([
    ['id', email], ['type', 'EMAIL'], ['match_type', 'EXACT'],
    ['extension_set.extension_names', 'DYNAMITE_ADDITIONAL_DATA'], ['extension_set.extension_names', 'DYNAMITE_ORGANIZATION_INFO'],
    ...['person.metadata.best_display_name', 'person.photo', 'person.cover_photo', 'person.metadata', 'person.in_app_reachability',
      'person.name', 'person.read_only_profile_info', 'person.email'].map(p => ['request_mask.include_field.paths', p]),
    // Solo contenedores del propio titular: así el nombre no procede de los contactos de la cuenta de investigación
    ['request_mask.include_container', 'PROFILE'], ['request_mask.include_container', 'DOMAIN_PROFILE'],
    ['core_id_params.enable_private_names', 'true']
  ]);
  const call = async k => {
    const ts = Math.floor(Date.now() / 1000);
    const hash = await sha1(`${ts} ${cookie[1]} ${origin}`);
    const r = await fetch(`https://people-pa.clients6.google.com/v2/people/lookup?${params}&key=${encodeURIComponent(k)}`, {
      credentials: 'include', headers: { Authorization: `SAPISIDHASH ${ts}_${hash}`, 'X-Goog-AuthUser': '0' }
    });
    return { status: r.status, text: await r.text() };
  };
  let res = await call(key), keyUsed = 'cliente Google Fotos';
  if (res.status === 400 || res.status === 403) {                // clave rotada: probar las claves públicas que publica la propia página
    const keys = [...new Set(document.documentElement.innerHTML.match(/AIza[0-9A-Za-z_-]{35}/g) || [])].filter(k => k !== key).slice(0, 3);
    for (const k of keys) {
      const alt = await call(k);
      if (alt.status === 200) { res = alt; keyUsed = 'clave publicada en la página'; break; }
    }
  }
  return { ok: true, status: res.status, text: res.text.slice(0, 400000), keyUsed };
}

let googleBusy = Promise.resolve();
function googleLookup(email) {
  const job = googleBusy.then(async () => {           // en serie: una sola pestaña de Google cada vez
    const t0 = Date.now();
    let tab;
    try {
      tab = await chrome.tabs.create({ url: 'https://photos.google.com/', active: false });
      await waitComplete(tab.id, 20000);
      await sleep(600);
      const info = await chrome.tabs.get(tab.id);
      let host = '';
      try { host = new URL(info.url || info.pendingUrl || '').hostname; } catch { /* */ }
      if (host !== 'photos.google.com') return { ok: false, error: 'nosession', ms: Date.now() - t0 };
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: googleInPage, args: [email, GOOGLE_KEY] });
      return { ...(result || { ok: false, error: 'sin resultado' }), ms: Date.now() - t0 };
    } catch (e) {
      const m = String((e && e.message) || e);
      return { ok: false, error: /error page/i.test(m) ? 'No se pudo cargar photos.google.com (sin conexión, proxy o bloqueo)' : m, ms: Date.now() - t0 };
    } finally {
      if (tab) try { await chrome.tabs.remove(tab.id); } catch { /* ya cerrada */ }
    }
  });
  googleBusy = job.catch(() => {});
  return job;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (_sender.id !== chrome.runtime.id) return false;
  if (msg && msg.type === 'ensureRules') { ensureRules().then(() => sendResponse({ ok: true })); return true; }
  if (msg && msg.type === 'tabProbe' && /^https:\/\//.test(msg.url || '')) { tabProbe(msg.url, msg.wait, msg.waitTitle).then(sendResponse); return true; }
  if (msg && msg.type === 'googleLookup' && typeof msg.email === 'string' && msg.email.length < 320) { googleLookup(msg.email).then(sendResponse); return true; }
  return false;
});
