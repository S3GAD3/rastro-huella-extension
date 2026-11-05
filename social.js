/* RASTRO · HUELLA — Facebook y X por nombre de usuario
   Facebook: petición directa (metadatos Open Graph, ID numérico y foto) y, si exige sesión,
   verificación en pestaña. X: el perfil solo se pinta con JavaScript, así que se lee en pestaña. */
import * as U from './util.js';

const OK = (profile = {}) => ({ status: 'found', profile });
const NF = reason => ({ status: 'notfound', reason: reason || '' });
const UNK = reason => ({ status: 'unknown', reason: reason || '' });
const enc = encodeURIComponent;
const WALL = /(\/login|\/signin|\/sign_in|\/accounts\/login|\/auth\/|consent\.|\/challenge|captcha|\/checkpoint|\/authwall|\/i\/flow\/)/i;
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unesc = s => (s ? s.replace(/\\\//g, '/').replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))) : s);
const text = s => {
  if (!s) return null;
  const t = U.decode(String(s).replace(/<br\s*\/?>/gi, '\n').replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '$1').replace(/<[^>]+>/g, ''));
  return (t || '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim() || null;
};

/* ---------- Facebook ---------- */
const FB_NF = /This content isn['’]t available|Este contenido no está disponible|This page isn['’]t available|Esta página no está disponible|The link you followed may be broken|El enlace que has seguido puede estar roto/i;
const FB_GENERIC = /^(facebook|log in|inicia sesi[oó]n|entrar)\b|log in or sign up|inicia sesi[oó]n o reg[ií]strate|^error$/i;
const FB_BOILER = /is on Facebook|está en Facebook|Join Facebook|Únete a Facebook|Regístrate en Facebook|to connect with|para conectar con/i;

function fbHandle(raw) {
  try {
    const x = new URL(raw, 'https://www.facebook.com/');
    if (!/(^|\.)facebook\.com$/i.test(x.hostname)) return null;
    if (/^\/profile\.php$/i.test(x.pathname)) return x.searchParams.get('id');
    const seg = x.pathname.split('/').filter(Boolean);
    if (seg[0] === 'people' && seg[2]) return seg[2];
    return seg[0] || null;
  } catch { return null; }
}

export function facebookParse(html, url, u, title) {
  const h = html || '';
  if (WALL.test(url || '')) return UNK('Facebook exige iniciar sesión: usa «Verificar en pestaña» desde un perfil de navegador de trabajo');
  const og = U.meta(h, 'og:title');
  const name = og || String(title || U.title(h) || '').replace(/^\(\d+\)\s*/, '').replace(/\s*[|•·-]\s*Facebook\s*$/i, '').trim();
  if (!og && FB_NF.test(h)) return NF('Facebook indica que el contenido no está disponible: inexistente o restringido para esta sesión');
  if (!name || FB_GENERIC.test(name)) return UNK('Página de acceso de Facebook sin datos del perfil: verifica en pestaña');
  const canonical = U.meta(h, 'og:url') || ((h.match(/<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)/i) || [])[1]) || url;
  const handle = fbHandle(U.decode(canonical || ''));
  if (!handle || handle.toLowerCase() !== String(u).toLowerCase()) return UNK('La página de Facebook no corresponde exactamente al alias consultado');
  const id = (h.match(/fb:\/\/(?:profile|page)\/(?:\?id=)?(\d{5,20})/) || h.match(/"profile_owner":\{"id":"(\d{5,20})"/) || [])[1]
    || (/^\d{5,20}$/.test(handle) ? handle : null);
  const pic = U.meta(h, 'og:image') || unesc((h.match(/"profilePicLarge":\{"uri":"([^"]+)"/) || [])[1]);
  let bio = U.meta(h, 'og:description') || '';
  if (FB_BOILER.test(bio)) bio = '';
  return OK({
    displayName: name, username: u, bio: bio || null, avatar: U.safeUrl(pic),
    url: `https://www.facebook.com/${/^\d+$/.test(handle) ? 'profile.php?id=' + handle : enc(handle)}`,
    extra: {
      'ID numérico': id, 'Tipo (Open Graph)': U.meta(h, 'og:type'),
      'Foto de perfil': U.safeUrl(pic), 'URL canónica': U.safeUrl(U.decode(canonical || ''))
    }
  });
}

export const FACEBOOK_SOURCE = {
  id: 'facebook', name: 'Facebook', cat: 'Redes sociales', kind: 'page', reliability: 'baja', tabNoGuard: true, tabPreferred: true,
  tabWait: 5000, tabWaitTitle: '\\| Facebook|no disponible|not available|isn',
  method: 'Página pública del perfil: Open Graph (nombre, foto), URL canónica e ID numérico. Facebook suele exigir sesión: entonces se verifica en pestaña',
  endpoint: 'https://www.facebook.com/{usuario}',
  profileUrl: u => `https://www.facebook.com/${enc(u)}`,
  valid: /^[A-Za-z0-9.]{5,50}$/,
  async check(u, ctx) {
    const url = `https://www.facebook.com/${enc(u)}`;
    const r = await ctx.req(url, { headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' } });
    if (r.redirected && WALL.test(r.url)) return UNK('Facebook redirige al inicio de sesión: usa «Verificar en pestaña»');
    if (r.status === 404) return NF();
    if (r.status !== 200) return UNK(r.status === 429 ? 'Límite de peticiones de Facebook (HTTP 429)' : `Acceso denegado o protección anti-bot (HTTP ${r.status}): verifica en pestaña`);
    return facebookParse(r.text, r.url, u);
  },
  tabParse(page, u) { return facebookParse(page.html, page.url, u, page.title); }
};

/* ---------- X / Twitter (lectura del perfil renderizado en pestaña) ---------- */
export const xHiRes = url => (U.safeUrl(url) || '').replace(/_(normal|bigger|mini|x96|200x200)(\.\w+)$/i, '_400x400$2') || null;

export function xTabParse(page, u) {
  const t = String(page.title || '').replace(/^\(\d+\)\s*/, '');
  const m = t.match(/^(.*?)\s*\(@([A-Za-z0-9_]{1,15})\)\s*(?:\/\s*X|(?:on|en)\s+X)/i);
  if (!m) return UNK('X no mostró el perfil (sin «@alias» en el título): puede requerir sesión');
  if (m[2].toLowerCase() !== String(u).toLowerCase()) return UNK('X muestra un perfil con otro alias');
  const h = page.html || '';
  const ue = reEsc(m[2]);
  const avatar = (h.match(new RegExp(`href="/${ue}/photo"[\\s\\S]{0,4000}?(https://pbs\\.twimg\\.com/profile_images/[^"'\\s)&]+)`, 'i')) || [])[1];
  const banner = (h.match(new RegExp(`href="/${ue}/header_photo"[\\s\\S]{0,3000}?(https://pbs\\.twimg\\.com/profile_banners/(\\d+)/[^"'\\s)&]+)`, 'i')) || []);
  const block = id => (h.match(new RegExp(`data-testid="${id}"[^>]*>([\\s\\S]{0,1500}?)</(?:div|span)>\\s*</(?:div|span)>`, 'i')) || [])[1];
  const count = path => text((h.match(new RegExp(`href="/${ue}/${path}"[^>]*>[\\s\\S]{0,300}?>([\\d.,]+\\s*(?:[KkMm]|mil|M)?)<`, 'i')) || [])[1]);
  const link = (h.match(/data-testid="UserUrl"[^>]*href="([^"]+)"/i) || [])[1];
  const linkText = text(block('UserUrl'));
  return OK({
    displayName: m[1].trim() || null, username: m[2], bio: text(block('UserDescription')),
    avatar: avatar ? xHiRes(avatar) : null, banner: banner[1] || null,
    location: text(block('UserLocation')),
    website: linkText && /\./.test(linkText) ? (/^https?:/i.test(linkText) ? linkText : 'https://' + linkText) : U.safeUrl(link),
    url: `https://x.com/${m[2]}`,
    verified: /data-testid="icon-verified"/.test(h) ? 'Marca de verificación visible' : null,
    private: /data-testid="icon-lock"/.test(h) || null,
    extra: {
      'ID numérico (de la portada)': banner[2] || null, 'Fecha de alta (texto)': text(block('UserJoinDate')),
      'Seguidores (texto)': count('(?:verified_)?followers'), 'Siguiendo (texto)': count('following')
    }
  });
}

export const X_TAB_SOURCE = {
  id: 'x', name: 'X / Twitter (navegador)', cat: 'Redes sociales', kind: 'tab', reliability: 'media', tabOnly: true, tabPreferred: true,
  tabWait: 7000, tabWaitTitle: '\\(@|/ X$',
  tabNF: /This account doesn[’']t exist|Esta cuenta no existe|Account suspended|Cuenta suspendida/i,
  method: 'Perfil de x.com leído en pestaña (X solo pinta el perfil con JavaScript y suele exigir sesión): nombre, foto, portada, bio e ID',
  endpoint: 'https://x.com/{usuario}',
  profileUrl: u => `https://x.com/${enc(u)}`, valid: /^[A-Za-z0-9_]{1,15}$/,
  async check() { return UNK('X necesita navegador: usa «Verificar en pestaña» o activa la verificación automática'); },
  tabParse: xTabParse
};

/* vxTwitter como segunda opción de terceros cuando FxTwitter falla */
export async function vxTwitter(u, ctx) {
  const r = await ctx.req(`https://api.vxtwitter.com/${enc(u)}`, { noRetry: true });
  const j = r.json();
  if (r.status !== 200 || !j || String(j.screen_name || '').toLowerCase() !== String(u).toLowerCase()) return null;
  return OK({
    displayName: j.name, username: j.screen_name, bio: j.description, avatar: xHiRes(j.profile_image_url),
    followers: j.followers_count, following: j.following_count, posts: j.tweet_count, postsLabel: 'posts',
    location: j.location, created: j.created_at,
    extra: { 'ID numérico': j.id, 'Protegida': j.protected, 'Servicio': 'vxTwitter (tercero)' }
  });
}

/* ---------- Instagram: página pública del perfil (instagram.com/usuario/) ----------
   La API web_profile_info responde 404 o user:null a peticiones anónimas o limitadas aunque la
   cuenta exista. Por eso su negativa no se acepta sola: se contrasta con la página del perfil. */
const IG_TITLE = /^(.*?)\s*\(@([A-Za-z0-9._]{1,30})\)\s*[•·|-]/;
const IG_NF = /^(Page not found|P[aá]gina no encontrada|Content not found|Contenido no encontrado)\b/i;
const igCount = (desc, words) => {
  const m = String(desc || '').match(new RegExp(`([\\d.,]+\\s*(?:[KkMm]|mil|mill\\.?)?)\\s+(?:${words})`, 'i'));
  return m ? m[1].trim() : null;
};
export function instagramPageParse(html, url, u, title) {
  const h = html || '';
  if (WALL.test(url || '')) return UNK('Instagram redirige al inicio de sesión: verifica en pestaña');
  const t = String(title || U.title(h) || '').trim();
  if (IG_NF.test(t)) return NF('Instagram indica que la página no está disponible');
  const og = U.meta(h, 'og:title') || '';
  const m = og.match(IG_TITLE) || t.replace(/^\(\d+\)\s*/, '').match(IG_TITLE);
  if (!m) return UNK('Página de Instagram sin datos del perfil (muro de acceso o límite): verifica en pestaña');
  if (m[2].toLowerCase() !== String(u).toLowerCase()) return UNK('Instagram muestra un perfil con otro alias');
  const desc = U.meta(h, 'og:description') || U.meta(h, 'description') || '';
  const id = (h.match(/profilePage_(\d{3,25})/) || h.match(/"profile_id":"(\d{3,25})"/) || h.match(/"user_id":"(\d{3,25})"/) || [])[1] || null;
  const bio = (desc.match(/[-–]\s*(?:See Instagram photos and videos from|Ver fotos y v[ií]deos de Instagram de)[^)]*\)\s*:?\s*([\s\S]*)$/i) || [])[1];
  return OK({
    displayName: m[1].trim() || null, username: m[2], bio: bio ? bio.replace(/^["“]|["”]$/g, '').trim() || null : null,
    avatar: U.safeUrl(U.meta(h, 'og:image')),
    url: `https://www.instagram.com/${m[2]}/`,
    verified: /"is_verified":true/.test(h) ? 'Verificada' : null,
    extra: {
      'ID numérico': id,
      'Seguidores (texto)': igCount(desc, 'Followers|seguidores'), 'Seguidos (texto)': igCount(desc, 'Following|seguidos'),
      'Publicaciones (texto)': igCount(desc, 'Posts|publicaciones'), 'Descripción Open Graph': desc || null
    }
  });
}
