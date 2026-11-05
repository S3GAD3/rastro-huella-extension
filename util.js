/* RASTRO · HUELLA — utilidades puras (sin estado) */

export const VERSION = (globalThis.chrome && chrome.runtime && chrome.runtime.getManifest)
  ? chrome.runtime.getManifest().version : 'dev';

export const EMAIL_RE = /^[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
export const EMAIL_RE_G = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi;
export const isEmail = s => {
  const v = String(s || '').trim();
  if (v.length > 254 || !EMAIL_RE.test(v)) return false;
  const [local, domain] = v.split('@');
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..') &&
    domain.split('.').every(x => x.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(x));
};
export const isEmpty = v => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);
export const enc = encodeURIComponent;

/* ---------- Texto y HTML ---------- */
const _ta = typeof document !== 'undefined' ? document.createElement('textarea') : null;
export function decode(s) {
  if (s == null || !_ta) return s;
  _ta.innerHTML = s;               // <textarea>: decodifica entidades sin ejecutar ni cargar nada
  return _ta.value;
}
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function meta(html, prop) {
  const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${reEsc(prop)}["'][^>]*>`, 'i'));
  if (!m) return null;
  const c = m[0].match(/content=(["'])([\s\S]*?)\1/i);
  return c ? decode(c[2]).trim() : null;
}
export function title(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decode(m[1]).trim() : null;
}
export function scriptById(html, id) {
  const m = html.match(new RegExp(`<script[^>]*id=["']${reEsc(id)}["'][^>]*>([\\s\\S]*?)<\\/script>`, 'i'));
  return m ? m[1] : null;
}
export function strip(s) {
  if (!s) return s;
  const d = new DOMParser().parseFromString(String(s), 'text/html');
  return (d.body.textContent || '').replace(/[ \t]+\n/g, '\n').trim();
}
export function parseJson(s) { try { return JSON.parse(s); } catch { return null; } }

/* ---------- Fechas y números ---------- */
export function date(x) {
  if (x === null || x === undefined || x === '' || x === 0) return null;
  if (typeof x === 'number' || /^\d{9,13}$/.test(String(x))) {
    const n = Number(x);
    const d = new Date(n < 1e12 ? n * 1000 : n);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(x).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d)) return s;
  // Texto sin zona horaria («March 3, 2015»): se conserva el día literal
  if (!/T\d|Z$|[+-]\d{2}:?\d{2}$|GMT|UTC/i.test(s)) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  return d.toISOString().slice(0, 10);
}
export const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
export function num(n) {
  if (isEmpty(n)) return null;
  const v = Number(n);
  return isNaN(v) ? String(n) : v.toLocaleString('es-ES');
}
export const utc = d => (d ? new Date(d) : new Date()).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');

/* ---------- Hash ---------- */
export async function sha256(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 99;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/* ---------- URLs e identificadores ---------- */
export function safeUrl(u) {
  if (!u) return null;
  let s = String(u).trim();
  if (s.startsWith('//')) s = 'https:' + s;
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(s)) s = 'https://' + s; else return null;
  }
  try { const x = new URL(s); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; }
}
export function hostOf(u) {
  try { return new URL(safeUrl(u)).hostname.replace(/^www\./, ''); } catch { return null; }
}

const HOST_PLATFORM = {
  'twitter.com': 'X', 'x.com': 'X', 'instagram.com': 'Instagram', 'github.com': 'GitHub', 'gitlab.com': 'GitLab',
  'tiktok.com': 'TikTok', 't.me': 'Telegram', 'telegram.me': 'Telegram', 'facebook.com': 'Facebook', 'fb.com': 'Facebook',
  'twitch.tv': 'Twitch', 'youtube.com': 'YouTube', 'reddit.com': 'Reddit', 'old.reddit.com': 'Reddit',
  'linkedin.com': 'LinkedIn', 'threads.net': 'Threads', 'threads.com': 'Threads', 'pinterest.com': 'Pinterest',
  'pinterest.es': 'Pinterest', 'soundcloud.com': 'SoundCloud', 'medium.com': 'Medium', 'linktr.ee': 'Linktree',
  'bsky.app': 'Bluesky', 'snapchat.com': 'Snapchat', 'vk.com': 'VK', 'keybase.io': 'Keybase', 'chess.com': 'Chess.com',
  'lichess.org': 'Lichess', 'steamcommunity.com': 'Steam', 'patreon.com': 'Patreon', 'ko-fi.com': 'Ko-fi',
  'onlyfans.com': 'OnlyFans', 'kick.com': 'Kick', 'vimeo.com': 'Vimeo', 'dribbble.com': 'Dribbble', 'behance.net': 'Behance',
  'flickr.com': 'Flickr', 'tumblr.com': 'Tumblr', 'mastodon.social': 'Mastodon', 'open.spotify.com': 'Spotify',
  'codeberg.org': 'Codeberg', 'hub.docker.com': 'Docker Hub', 'huggingface.co': 'Hugging Face', 'dev.to': 'Dev.to',
  'deviantart.com': 'DeviantArt', 'artstation.com': 'ArtStation', 'rumble.com': 'Rumble', 'cash.app': 'Cash App',
  'paypal.me': 'PayPal', 'buymeacoffee.com': 'Buy Me a Coffee', 'substack.com': 'Substack', 'letterboxd.com': 'Letterboxd',
  'last.fm': 'Last.fm', 'wattpad.com': 'Wattpad', 'speedrun.com': 'Speedrun', 'roblox.com': 'Roblox',
  'duolingo.com': 'Duolingo', 'replit.com': 'Replit', 'leetcode.com': 'LeetCode', 'about.me': 'About.me',
  'disqus.com': 'Disqus', 'pastebin.com': 'Pastebin', 'news.ycombinator.com': 'Hacker News', 'beacons.ai': 'Beacons',
  'bio.link': 'Bio.link', 'taplink.cc': 'Taplink', 'allmylinks.com': 'AllMyLinks', 'solo.to': 'solo.to',
  'ngl.link': 'NGL', 'tellonym.me': 'Tellonym', 'meneame.net': 'Menéame', 'gitee.com': 'Gitee', 'etsy.com': 'Etsy'
};
const RESERVED = new Set(['home', 'explore', 'search', 'hashtag', 'i', 'intent', 'share', 'sharer', 'sharer.php', 'login',
  'signup', 'about', 'help', 'settings', 'watch', 'channel', 'c', 'user', 'u', 'in', 'p', 'reel', 'reels', 'stories',
  'status', 'profile.php', 'groups', 'pages', 'events', 'tos', 'privacy', 'legal', 'policies', 'video', 'add', 'people',
  'id', 'profile', 'joinchat', 's', 'pin', 'r', 'messages', 'notifications', 'discover', 'tag', 'tags', 'trending', 'feed',
  'company', 'school', 'jobs', 'shorts', 'playlist', 'results', 'embed', 'download', 'features', 'pricing', 'blog', 'en',
  'es', 'web', 'dl', 'contact', 'support', 'directory', 'topics', 'browse', 'sets', 'tracks', 'albums', 'shop', 'listing']);

/* Plataforma + alias a partir de una URL de perfil conocida */
export function urlToHandle(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|web|es)\./, '');
  const platform = HOST_PLATFORM[host] || HOST_PLATFORM[u.hostname.toLowerCase()];
  if (!platform) return null;
  const seg = u.pathname.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch { return s; } });
  const [first = '', second] = seg;
  const after = (...keys) => (keys.includes(first) ? second : null);
  let h;
  switch (platform) {
    case 'Reddit': h = after('user', 'u'); break;
    case 'LinkedIn': h = after('in'); break;
    case 'YouTube': h = first.startsWith('@') ? first.slice(1) : after('c', 'user'); break;
    case 'TikTok': case 'Threads': case 'Medium': case 'Mastodon': case 'Replit':
      h = first.startsWith('@') ? first.slice(1) : null; break;
    case 'Snapchat': h = after('add'); break;
    case 'Steam': h = after('id'); break;
    case 'Chess.com': h = after('member'); break;
    case 'Lichess': h = after('@'); break;
    case 'Bluesky': h = after('profile'); break;
    case 'Spotify': h = after('user'); break;
    case 'Cash App': h = first.startsWith('$') ? first.slice(1) : null; break;
    case 'Hacker News': h = u.searchParams.get('id'); break;
    case 'Speedrun': h = after('users', 'user'); break;
    case 'Roblox': return null;
    case 'Duolingo': h = after('profile'); break;
    case 'Wattpad': h = after('user'); break;
    case 'Disqus': h = after('by'); break;
    case 'Pastebin': h = after('u'); break;
    case 'Flickr': h = after('people', 'photos'); break;
    case 'Last.fm': h = after('user'); break;
    case 'Docker Hub': h = after('u'); break;
    case 'Menéame': h = after('user'); break;
    case 'Etsy': h = after('shop'); break;
    case 'Facebook': h = first === 'profile.php' ? null : first; break;
    default: h = first;
  }
  if (!h) return null;
  h = String(h).replace(/^@/, '');
  if (RESERVED.has(h.toLowerCase()) || !/^[A-Za-z0-9._-]{1,64}$/.test(h)) return null;
  return { platform, handle: h };
}

/* Identificadores nuevos a partir de un perfil normalizado */
export function derivePivots(p, via) {
  const out = [];
  const seen = new Set();
  const add = (type, value, note) => {
    const v = String(value || '').trim();
    const k = type + ':' + v.toLowerCase();
    if (!v || seen.has(k)) return;
    seen.add(k);
    out.push({ type, value: v, via, note: note || '' });
  };
  const own = safeUrl(p.url);
  const urls = new Set();
  const pushUrl = x => { const s = safeUrl(x); if (s && s !== own) urls.add(s); };
  pushUrl(p.website);
  (p.links || []).forEach(pushUrl);
  const text = [p.bio || '', ...Object.values(p.extra || {}).filter(v => typeof v === 'string')].join(' ');
  (text.match(/https?:\/\/[^\s<>"')\]|]+/gi) || []).forEach(x => pushUrl(x.replace(/[.,;:!?]+$/, '')));
  (text.match(EMAIL_RE_G) || []).forEach(e => add('email', e.toLowerCase(), 'mencionado en el perfil'));
  (p.emails || []).forEach(e => add('email', String(e || '').toLowerCase(), 'campo de correo'));
  (p.handles || []).filter(h => h && h.handle).forEach(h => add('username', String(h.handle).replace(/^@/, ''), h.platform));
  urls.forEach(x => {
    add('url', x);
    const h = urlToHandle(x);
    if (h) add('username', h.handle, h.platform);
  });
  return out;
}

/* Candidatos de alias a partir de la parte local de un correo */
export function usernameCandidates(email) {
  const local = String(email).split('@')[0].split('+')[0].toLowerCase();
  const set = new Set([local, local.replace(/[._-]/g, ''), local.replace(/[._-]/g, '_'), local.replace(/[._-]/g, '.')]);
  const noDigits = local.replace(/\d+$/, '');
  if (noDigits.length >= 3) set.add(noDigits);
  return [...set].filter(x => x.length >= 3 && x.length <= 64 && /^[a-z0-9._-]+$/i.test(x)).slice(0,8);
}

/* Variantes habituales de un alias (no se buscan automáticamente) */
export function usernameVariants(u) {
  const base = String(u).toLowerCase();
  const parts = base.split(/[._-]+/).filter(Boolean);
  const core = base.replace(/[._-]+/g, '');
  const noDigits = base.replace(/[._-]*\d+$/, '');
  const out = new Set();
  if (parts.length > 1) ['', '_', '.', '-'].forEach(s => out.add(parts.join(s)));
  if (parts.length > 1) out.add(parts.slice().reverse().join('_'));
  if (noDigits !== base && noDigits.length >= 3) out.add(noDigits);
  ['real', 'the', 'its', 'im'].forEach(p => out.add(p + core));
  ['_', 'official', '_es', '1'].forEach(s => out.add(core + s));
  out.add('_' + core + '_');
  out.delete(base);
  return [...out].filter(x => x.length >= 3 && x.length <= 30).slice(0, 14);
}

/* Alias aleatorio de control que cumpla el formato de la fuente */
export function controlAlias(valid) {
  const rnd = (n, set) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => set[b % set.length]).join('');
  const letters = 'abcdefghijkmnpqrstuvwxyz';
  const cands = ['zq' + rnd(10, letters), 'zq' + rnd(6, letters) + rnd(4, '23456789'), 'zq' + rnd(4, letters)];
  return cands.find(c => !valid || valid.test(c)) || null;
}

/* Correo aleatorio de control en el mismo dominio */
export function controlEmail(email) {
  const dom = String(email).split('@')[1] || 'gmail.com';
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  return `zq${rnd}@${dom}`;
}

/* Normalización de nombres para comparar (sin tildes, minúsculas, solo letras/dígitos) */
export const normText = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const NAME_STOP = new Set(['snapchat', 'instagram', 'tiktok', 'youtube', 'twitter', 'facebook', 'official', 'oficial', 'the', 'and',
  'del', 'los', 'las', 'profile', 'perfil', 'user', 'esta', 'channel', 'canal', 'music', 'gaming', 'games', 'shop', 'store', 'tienda']);
export function nameTokens(s, exclude = []) {
  const ex = new Set(exclude.map(x => normText(x).replace(/[^a-z0-9]/g, '')));
  return [...new Set(normText(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(t => t.length >= 3 && !NAME_STOP.has(t) && !ex.has(t)))];
}

/* ---------- Dominios de correo ---------- */
export const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', 'guerrillamail.info', 'sharklasers.com',
  '10minutemail.com', '10minutemail.net', 'temp-mail.org', 'tempmail.com', 'tempmailo.com', 'yopmail.com', 'yopmail.fr',
  'yopmail.net', 'trashmail.com', 'trashmail.de', 'getnada.com', 'nada.email', 'dispostable.com', 'maildrop.cc',
  'mintemail.com', 'mohmal.com', 'emailondeck.com', 'fakeinbox.com', 'throwawaymail.com', 'mailnesia.com', 'tempail.com',
  'tempr.email', 'discard.email', 'spamgourmet.com', 'mailcatch.com', 'moakt.com', 'tmail.ws', 'tmpmail.org', 'tmpmail.net',
  'burnermail.io', 'inboxkitten.com', 'mail.tm', 'mail.gw', 'emltmp.com', 'minutemail.com', 'harakirimail.com',
  '1secmail.com', '1secmail.org', '1secmail.net', 'grr.la', 'mailpoof.com', 'byom.de', 'wegwerfmail.de', 'einrot.com',
  'spambox.us', 'crazymailing.com', 'tempmail.plus', 'mailto.plus', 'fexpost.com', 'fexbox.org', 'rover.info',
  'chitthi.in', 'mailbox.in.ua', 'inbox.lv', 'cloud-mail.top', 'tmailor.com', 'mail7.io', 'dropmail.me', 'emailfake.com']);

export const MX_PROVIDERS = [
  [/google\.com$|googlemail\.com$/, 'Google (Gmail / Workspace)'],
  [/outlook\.com$|protection\.outlook\.com$|hotmail\.com$/, 'Microsoft (Outlook / 365)'],
  [/protonmail\.ch$|proton\.me$/, 'Proton Mail'],
  [/yahoodns\.net$|yahoo\.com$/, 'Yahoo'],
  [/icloud\.com$|me\.com$/, 'Apple iCloud'],
  [/gmx\.net$|gmx\.com$|web\.de$|1and1|ionos/, 'GMX / Web.de / IONOS'],
  [/yandex\.(ru|net)$/, 'Yandex'],
  [/mail\.ru$/, 'Mail.ru'],
  [/zoho\.(com|eu)$/, 'Zoho'],
  [/tutanota\.de$|tuta\.io$/, 'Tuta (Tutanota)'],
  [/secureserver\.net$/, 'GoDaddy'],
  [/ovh\.net$/, 'OVH'],
  [/amazonaws\.com$|awsapps\.com$/, 'Amazon (SES / WorkMail)'],
  [/qq\.com$/, 'Tencent QQ'],
  [/mimecast\.com$/, 'Mimecast'],
  [/pphosted\.com$/, 'Proofpoint'],
  [/telefonica\.net$|movistar/, 'Telefónica / Movistar'],
  [/arsys\.es$/, 'Arsys'],
  [/dinahosting\.com$/, 'Dinahosting']
];

/* Versión de mayor resolución de una foto de perfil conocida (no altera la URL original guardada) */
export function hiResImage(url) {
  const u = safeUrl(url);
  if (!u) return null;
  if (/pbs\.twimg\.com\/profile_images\//.test(u)) return u.replace(/_(normal|bigger|mini|x96|200x200)(\.\w+)$/i, '_400x400$2');
  if (/googleusercontent\.com\//.test(u)) return /=[swh]\d+[^/]*$/i.test(u) ? u.replace(/=[swh]\d+[^/]*$/i, '=s0') : u + '=s0';
  if (/gravatar\.com\/avatar\//.test(u)) return u.replace(/([?&])s=\d+/, '$1s=1024');
  if (/avatars\.githubusercontent\.com\//.test(u)) return u.replace(/([?&])s=\d+/, '$1s=460') + (/[?&]s=/.test(u) ? '' : (u.includes('?') ? '&' : '?') + 's=460');
  return u;
}
