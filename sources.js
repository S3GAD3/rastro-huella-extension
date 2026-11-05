/* RASTRO · HUELLA — definiciones de fuentes
   Cada fuente es un adaptador independiente: comprueba si existe una cuenta
   y devuelve un perfil normalizado. Ninguna fuente usa flujos de registro,
   inicio de sesión o recuperación de contraseña (no alertan al titular).

   Contrato de una fuente:
     id, name, cat, reliability ('alta'|'media'|'baja'), method, endpoint,
     profileUrl(u), valid (RegExp de formato), third (envía datos a un tercero),
     control (false para desactivar el contraste con un identificador inexistente; por defecto
     todo positivo se contrasta), check(u, ctx) → OK|NF|UNK */
import * as U from './util.js';
import { installEmailChecks } from './email.js';
import { GOOGLE_SOURCE } from './google.js';
import { FACEBOOK_SOURCE, X_TAB_SOURCE, vxTwitter, xHiRes, instagramPageParse } from './social.js';

export const OK = (profile = {}) => ({ status: 'found', profile });
export const NF = (reason) => ({ status: 'notfound', reason: reason || '' });
export const UNK = (reason) => ({ status: 'unknown', reason: reason || '' });
const enc = encodeURIComponent;
const WALL = /(\/login|\/signin|\/sign_in|\/accounts\/login|\/auth\/|consent\.|\/challenge|captcha|\/checkpoint|\/authwall)/i;

function httpReason(r) {
  if (r.status === 429) return 'Límite de peticiones de la plataforma (HTTP 429)';
  if (r.status === 401 || r.status === 403) return `Acceso denegado o protección anti-bot (HTTP ${r.status})`;
  if (r.status >= 500) return `Error del servidor de la plataforma (HTTP ${r.status})`;
  return `Respuesta no concluyente (HTTP ${r.status})`;
}

function ogProfile(html, site) {
  let title = U.meta(html, 'og:title') || U.meta(html, 'twitter:title') || U.title(html);
  if (title && site) {
    const n = site.split(/[\s(]/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    title = title.replace(new RegExp(`\\s*(?:[|•·–—-]|\\b(?:en|on|is on|está en)\\b)\\s*${n}\\b.*$`, 'i'), '').trim() || title;
  }
  return {
    displayName: title,
    bio: U.meta(html, 'og:description') || U.meta(html, 'description'),
    avatar: U.meta(html, 'og:image') || U.meta(html, 'twitter:image')
  };
}

/* Interpretación de una página abierta en pestaña (navegador real, supera retos anti-bot).
   page = { url, title, html, challenge } */
const NF_TITLE = /\b404\b|not found|no encontrad|page not found|página no encontrada|doesn['’]t exist|does not exist|no existe|isn['’]t available|no está disponible|user not found|account suspended/i;
function pageGuard(page, expected, value) {
  if (page.challenge || /just a moment|access denied|captcha|verify you are human|iniciar sesi[oó]n|sign in|log in/i.test(page.title || '')) return 'Bloqueo o página de acceso';
  try {
    const final = new URL(page.url), target = new URL(expected);
    if (final.hostname.replace(/^www\./, '') !== target.hostname.replace(/^www\./, '')) return 'Redirección a otro dominio';
    if (final.pathname === '/' && target.pathname !== '/') return 'Redirección a portada';
  } catch { return 'URL de respuesta no válida'; }
  const title = [page.title, U.meta(page.html || '', 'og:title'), U.meta(page.html || '', 'twitter:title')].filter(Boolean).join(' ');
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp('(^|[^\\p{L}\\p{N}_.-])@?' + escaped + '($|[^\\p{L}\\p{N}_.-])', 'iu').test(title)) return 'Sin identificador exacto en los metadatos del perfil';
  return null;
}
export function tabParse(s, page, value) {
  if (page.challenge || (page.url && WALL.test(page.url))) return UNK('Bloqueo o acceso restringido');
  if (NF_TITLE.test(page.title || '')) return NF('Página de perfil inexistente (verificado en pestaña)');
  if (s.tabNF && s.tabNF.test((page.title || '') + ' ' + (page.html || ''))) return NF('La plataforma indica que el perfil no existe o no está disponible (verificado en pestaña)');
  if (s.tabNoGuard && s.tabParse) {          // el título muestra el nombre, no el alias: la fuente valida URL y alias
    try {
      const final = new URL(page.url), target = new URL(s.profileUrl(value));
      if (final.hostname.replace(/^(www|m|web)\./, '') !== target.hostname.replace(/^(www|m|web)\./, '')) return UNK('Redirección a otro dominio');
    } catch { return UNK('URL de respuesta no válida'); }
    return s.tabParse(page, value);
  }
  const guard = pageGuard(page, s.profileUrl(value), value);
  if (guard) return UNK(guard);
  if (s.tabParse) return s.tabParse(page, value);
  const h = page.html || '';
  if (page.challenge) return UNK('La protección anti-bot no se superó en la pestaña');
  if (page.url && WALL.test(page.url)) return UNK('La plataforma exige iniciar sesión');
  if ((s.nfText && s.nfText.test(h)) || NF_TITLE.test(page.title || '')) return NF('Página de perfil inexistente (verificado en pestaña)');
  if (s.okText && !s.okText.test(h)) return UNK('Página sin marcador de perfil reconocible');
  return OK(ogProfile(h, s.name));
}

/* Fuente basada en página pública: código HTTP + metadatos Open Graph */
function pageSource(def) {
  const base = {
    kind: 'page',
    control: true,       // los positivos se contrastan con un alias aleatorio inexistente
    reliability: 'media',
    method: 'Página pública del perfil: código HTTP y metadatos Open Graph',
    endpoint: def.url('USUARIO').replace('USUARIO', '{usuario}'),
    profileUrl: def.url,
    async check(u, ctx) {
      const url = def.url(u);
      const r = await ctx.req(url, def.req || {});
      if (r.redirected && r.url !== url && WALL.test(r.url)) return UNK('Redirección a login, consentimiento o verificación');
      if ((def.nf || [404, 410]).includes(r.status)) return NF();
      if (r.status === 200) {
        if (def.homeRedirectNF !== false && r.redirected) {
          try { const p = new URL(r.url).pathname; if (p === '/' || p === '') return UNK('Redirige a la portada; no acredita ausencia'); } catch { /* */ }
        }
        if (def.nfText && def.nfText.test(r.text)) return NF('La página indica que el perfil no existe');
        if (def.okText && !def.okText.test(r.text)) return UNK('Página sin marcador de perfil reconocible');
        const p = def.parse ? def.parse(r.text, u, r) : ogProfile(r.text, def.name);
        if (p && p.__status) return p.__status;
        const guard = pageGuard({ url: r.url, html: r.text, title: U.title(r.text || '') }, url, u);
        if (guard) return UNK(guard);
        return OK(p);
      }
      return UNK(httpReason(r));
    }
  };
  return Object.assign(base, def, { check: def.check || base.check, profileUrl: def.profileUrl || def.url });
}

/* Fuente de existencia de cuenta por correo: probe() devuelve true | false | {exists, extra, created} | motivo */
function existsSource(def) {
  return Object.assign({ kind: 'existence', cat: 'Cuenta registrada', reliability: 'media' }, def, {
    async check(e, ctx) {
      const v = await def.probe(e, ctx);
      if (v === false) return NF();
      if (v === true || (v && v.exists)) {
        return OK({
          bio: `Existe una cuenta de ${def.name} registrada con este correo.`, url: def.site,
          created: v && v.created, extra: Object.assign({ 'Tipo de comprobación': 'Existencia de cuenta (sin perfil público)' }, (v && v.extra) || {}),
          existenceOnly: true
        });
      }
      return UNK(typeof v === 'string' ? v : 'Respuesta no concluyente');
    }
  });
}

/* ---------- Mapeador de Gravatar (compartido por usuario y correo) ---------- */
function gravatarProfile(j) {
  const va = j.verified_accounts || [];
  const links = (j.links || []).map(l => l.url);
  return {
    displayName: j.display_name,
    username: (j.profile_url || '').split('/').pop(),
    bio: j.description,
    avatar: j.avatar_url ? j.avatar_url + '?s=240' : null,
    location: j.location,
    url: j.profile_url,
    links: va.map(a => a.url).concat(links),
    verified: va.length ? `${va.length} cuentas verificadas` : null,
    extra: {
      'Puesto': j.job_title, 'Empresa': j.company, 'Pronombres': j.pronouns,
      'Cuentas verificadas': va.map(a => `${a.service_label}: ${a.url}`).join(' | '),
      'Enlaces': links.join(' | '), 'Hash Gravatar': j.hash
    }
  };
}

function duolingoProfile(us) {
  let pic = us.picture || '';
  pic = pic && !/defaults/.test(pic) ? (pic.startsWith('//') ? 'https:' + pic : pic) + '/xlarge' : null;
  return {
    displayName: us.name, username: us.username, bio: us.bio, avatar: pic,
    created: us.creationDate, url: `https://www.duolingo.com/profile/${enc(us.username)}`,
    extra: {
      'ID numérico': us.id, 'Racha (días)': us.streak, 'XP total': us.totalXp,
      'Cursos': (us.courses || []).map(c => `${c.title} (${c.learningLanguage}→${c.fromLanguage})`).join(', '),
      'Super / Plus': us.hasPlus, 'Correo verificado': us.emailVerified
    }
  };
}

/* =====================================================================
   FUENTES POR NOMBRE DE USUARIO
   ===================================================================== */
export const SOURCES_USER = [

  /* ---------------- Desarrollo y código ---------------- */
  {
    id: 'github', name: 'GitHub', cat: 'Desarrollo', kind: 'api', reliability: 'alta',
    method: 'API REST pública sin autenticación (60 consultas/hora por IP)',
    endpoint: 'https://api.github.com/users/{usuario}',
    profileUrl: u => `https://github.com/${enc(u)}`,
    valid: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://api.github.com/users/${enc(u)}`, { headers: { Accept: 'application/vnd.github+json' } });
      if (r.status === 404) return NF();
      const j = r.json();
      if (r.status !== 200 || !j) return UNK(r.status === 403 ? 'Límite de la API de GitHub alcanzado' : httpReason(r));
      return OK({
        displayName: j.name, username: j.login, bio: j.bio, avatar: j.avatar_url,
        followers: j.followers, following: j.following, posts: j.public_repos, postsLabel: 'repositorios',
        location: j.location, website: j.blog, created: j.created_at, lastActive: j.updated_at, url: j.html_url,
        emails: j.email ? [j.email] : [],
        handles: j.twitter_username ? [{ platform: 'X', handle: j.twitter_username }] : [],
        extra: { 'ID numérico': j.id, 'Tipo': j.type, 'Empresa': j.company, 'Contratable': j.hireable, 'Gists públicos': j.public_gists }
      });
    }
  },
  {
    id: 'gitlab', name: 'GitLab', cat: 'Desarrollo', kind: 'api', reliability: 'alta',
    method: 'API REST pública v4 (búsqueda exacta por usuario + ficha)',
    endpoint: 'https://gitlab.com/api/v4/users?username={usuario}',
    profileUrl: u => `https://gitlab.com/${enc(u)}`,
    valid: /^[A-Za-z0-9_.-]{2,255}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://gitlab.com/api/v4/users?username=${enc(u)}`);
      const arr = r.json();
      if (r.status !== 200 || !Array.isArray(arr)) return UNK(httpReason(r));
      if (!arr.length) return NF();
      const b = arr.find(x => String(x.username).toLowerCase() === u.toLowerCase());
      if (!b) return UNK('Sin coincidencia exacta de usuario');
      let d = {};
      try { const r2 = await ctx.req(`https://gitlab.com/api/v4/users/${b.id}`); d = r2.json() || {}; } catch { /* ficha opcional */ }
      return OK({
        displayName: b.name, username: b.username, avatar: b.avatar_url, url: b.web_url,
        bio: d.bio, location: d.location, website: d.website_url, created: d.created_at,
        followers: d.followers, following: d.following,
        emails: d.public_email ? [d.public_email] : [],
        handles: [d.twitter && { platform: 'X', handle: d.twitter }, d.linkedin && { platform: 'LinkedIn', handle: d.linkedin },
          d.discord && { platform: 'Discord', handle: d.discord }].filter(Boolean),
        extra: { 'ID numérico': b.id, 'Estado': b.state, 'Puesto': d.job_title, 'Organización': d.organization, 'Skype': d.skype }
      });
    }
  },
  {
    id: 'codeberg', name: 'Codeberg', cat: 'Desarrollo', kind: 'api', reliability: 'alta',
    method: 'API Gitea/Forgejo pública', endpoint: 'https://codeberg.org/api/v1/users/{usuario}',
    profileUrl: u => `https://codeberg.org/${enc(u)}`, valid: /^[A-Za-z0-9_.-]{1,40}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://codeberg.org/api/v1/users/${enc(u)}`);
      if (r.status === 404) return NF();
      const j = r.json();
      if (r.status !== 200 || !j) return UNK(httpReason(r));
      return OK({
        displayName: j.full_name, username: j.login, bio: j.description, avatar: j.avatar_url,
        location: j.location, website: j.website, created: j.created, lastActive: j.last_login,
        followers: j.followers_count, following: j.following_count,
        emails: j.email && !/noreply/.test(j.email) ? [j.email] : [],
        extra: { 'ID numérico': j.id }
      });
    }
  },
  {
    id: 'dockerhub', name: 'Docker Hub', cat: 'Desarrollo', kind: 'api', reliability: 'alta',
    method: 'API pública de Docker Hub', endpoint: 'https://hub.docker.com/v2/users/{usuario}/',
    profileUrl: u => `https://hub.docker.com/u/${enc(u)}`, valid: /^[a-z0-9]{2,30}$/i,
    async check(u, ctx) {
      const r = await ctx.req(`https://hub.docker.com/v2/users/${enc(u.toLowerCase())}/`);
      if (r.status === 404) return NF();
      const j = r.json();
      if (r.status !== 200 || !j || !j.username) return UNK(httpReason(r));
      return OK({
        displayName: j.full_name, username: j.username, avatar: j.gravatar_url, location: j.location,
        website: j.profile_url, created: j.date_joined, extra: { 'Empresa': j.company, 'ID': j.id, 'Tipo': j.type }
      });
    }
  },
  {
    id: 'huggingface', name: 'Hugging Face', cat: 'Desarrollo', kind: 'api', reliability: 'alta',
    method: 'API pública de Hugging Face', endpoint: 'https://huggingface.co/api/users/{usuario}/overview',
    profileUrl: u => `https://huggingface.co/${enc(u)}`, valid: /^[A-Za-z0-9_.-]{1,42}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://huggingface.co/api/users/${enc(u)}/overview`);
      if (r.status === 404) return NF();
      const j = r.json();
      if (r.status !== 200 || !j) return UNK(httpReason(r));
      return OK({
        displayName: j.fullname, username: j.user, avatar: U.safeUrl(j.avatarUrl), created: j.createdAt,
        followers: j.numFollowers, following: j.numFollowing,
        extra: { 'PRO': j.isPro, 'Modelos': j.numModels, 'Datasets': j.numDatasets, 'Spaces': j.numSpaces, 'Organizaciones': (j.orgs || []).map(o => o.name).join(', ') }
      });
    }
  },
  {
    id: 'devto', name: 'Dev.to', cat: 'Desarrollo', kind: 'api', reliability: 'alta',
    method: 'API pública de Forem', endpoint: 'https://dev.to/api/users/by_username?url={usuario}',
    profileUrl: u => `https://dev.to/${enc(u)}`, valid: /^[A-Za-z0-9_]{1,30}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://dev.to/api/users/by_username?url=${enc(u)}`);
      if (r.status === 404) return NF();
      const j = r.json();
      if (r.status !== 200 || !j) return UNK(httpReason(r));
      return OK({
        displayName: j.name, username: j.username, bio: j.summary, avatar: j.profile_image, location: j.location,
        website: j.website_url, created: j.joined_at,
        handles: [j.twitter_username && { platform: 'X', handle: j.twitter_username }, j.github_username && { platform: 'GitHub', handle: j.github_username }].filter(Boolean),
        extra: { 'ID numérico': j.id }
      });
    }
  },
  {
    id: 'npm', name: 'npm', cat: 'Desarrollo', kind: 'api', reliability: 'alta',
    method: 'Búsqueda del registro npm por mantenedor', endpoint: 'https://registry.npmjs.org/-/v1/search?text=maintainer:{usuario}',
    profileUrl: u => `https://www.npmjs.com/~${enc(u)}`, valid: /^[a-z0-9._-]{1,214}$/i,
    async check(u, ctx) {
      const r = await ctx.req(`https://registry.npmjs.org/-/v1/search?text=maintainer:${enc(u)}&size=20`);
      const j = r.json();
      if (r.status !== 200 || !j) return UNK(httpReason(r));
      const objs = (j.objects || []).filter(o => (o.package.maintainers || []).some(m => (m.username || '').toLowerCase() === u.toLowerCase()) ||
        ((o.package.publisher || {}).username || '').toLowerCase() === u.toLowerCase());
      if (!objs.length) return NF('Sin paquetes publicados con ese mantenedor');
      const emails = new Set();
      objs.forEach(o => {
        (o.package.maintainers || []).forEach(m => { if ((m.username || '').toLowerCase() === u.toLowerCase() && m.email) emails.add(m.email); });
        const p = o.package.publisher || {};
        if ((p.username || '').toLowerCase() === u.toLowerCase() && p.email) emails.add(p.email);
      });
      return OK({
        username: u, posts: j.total, postsLabel: 'paquetes', emails: [...emails],
        lastActive: objs.map(o => o.package.date).sort().pop(),
        extra: { 'Paquetes (muestra)': objs.slice(0, 10).map(o => o.package.name).join(', ') }
      });
    }
  },
  {
    id: 'pypi', name: 'PyPI', cat: 'Desarrollo', kind: 'api', reliability: 'alta',
    method: 'Página pública del usuario y, si está protegida, XML-RPC user_packages', endpoint: 'https://pypi.org/user/{usuario}/',
    profileUrl: u => `https://pypi.org/user/${enc(u)}/`, valid: /^[A-Za-z0-9._-]{1,50}$/,
    okText: /author-profile|Joined|Se unió/i,
    async check(u, ctx) {
      const r = await ctx.req(`https://pypi.org/user/${enc(u)}/`);
      if (r.status === 404) return NF();
      if (r.status === 200 && /author-profile/.test(r.text)) {
        const name = (r.text.match(/class="author-profile__name"[^>]*>([\s\S]*?)<\/h1>/) || [])[1];
        const joined = (r.text.match(/<time[^>]*datetime="([^"]+)"/) || [])[1];
        const pk = (r.text.match(/(\d+)\s+projects?/i) || [])[1];
        return OK({ displayName: U.strip(name), created: joined, posts: pk, postsLabel: 'proyectos' });
      }
      const body = `<?xml version="1.0"?><methodCall><methodName>user_packages</methodName><params><param><value><string>${u.replace(/[<&>]/g, '')}</string></value></param></params></methodCall>`;
      const x = await ctx.req('https://pypi.org/pypi', { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body });
      const pkgs = [...(x.text || '').matchAll(/<string>(Owner|Maintainer)<\/string><\/value>\s*<value><string>([^<]+)<\/string>/g)].map(m => m[2]);
      if (pkgs.length) return OK({ username: u, posts: pkgs.length, postsLabel: 'paquetes', extra: { 'Paquetes': pkgs.slice(0, 15).join(', ') } });
      return UNK(r.status === 200 ? 'Página protegida y sin paquetes públicos que confirmen la cuenta' : httpReason(r));
    }
  },
  {
    id: 'keybase', name: 'Keybase', cat: 'Desarrollo', kind: 'api', reliability: 'alta',
    method: 'API pública de Keybase (incluye pruebas de identidad enlazadas)',
    endpoint: 'https://keybase.io/_/api/1.0/user/lookup.json?usernames={usuario}',
    profileUrl: u => `https://keybase.io/${enc(u)}`, valid: /^[A-Za-z0-9_]{2,16}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://keybase.io/_/api/1.0/user/lookup.json?usernames=${enc(u)}&fields=basics,profile,proofs_summary,pictures`);
      const j = r.json();
      if (!j) return UNK(httpReason(r));
      const t = (j.them || [])[0];
      if (!t) return NF();
      const pr = ((t.proofs_summary || {}).all || []);
      const social = new Set(['twitter', 'github', 'reddit', 'hackernews', 'facebook', 'mastodon']);
      return OK({
        displayName: (t.profile || {}).full_name, username: (t.basics || {}).username, bio: (t.profile || {}).bio,
        location: (t.profile || {}).location, created: (t.basics || {}).ctime,
        avatar: (((t.pictures || {}).primary) || {}).url,
        links: pr.map(p => p.service_url).filter(Boolean),
        handles: pr.filter(p => social.has(p.proof_type)).map(p => ({ platform: p.proof_type, handle: p.nametag })),
        verified: pr.length ? `${pr.length} pruebas de identidad` : null,
        extra: { 'Pruebas de identidad': pr.map(p => `${p.proof_type}: ${p.nametag}`).join(' | '), 'UID': t.id }
      });
    }
  },
  {
    id: 'hackernews', name: 'Hacker News', cat: 'Foros', kind: 'api', reliability: 'alta',
    method: 'API Firebase oficial de Hacker News', endpoint: 'https://hacker-news.firebaseio.com/v0/user/{usuario}.json',
    profileUrl: u => `https://news.ycombinator.com/user?id=${enc(u)}`, valid: /^[A-Za-z0-9_-]{2,15}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://hacker-news.firebaseio.com/v0/user/${enc(u)}.json`);
      if (r.status !== 200) return UNK(httpReason(r));
      const j = r.json();
      if (!j) return NF();
      return OK({ username: j.id, bio: U.strip(j.about), created: j.created, posts: (j.submitted || []).length, postsLabel: 'envíos', extra: { 'Karma': j.karma } });
    }
  },
  {
    id: 'sourceforge', name: 'SourceForge', cat: 'Desarrollo', kind: 'api', reliability: 'alta',
    method: 'API REST pública de perfiles de SourceForge', endpoint: 'https://sourceforge.net/rest/u/{usuario}/profile',
    profileUrl: u => `https://sourceforge.net/u/${enc(u)}/profile`, valid: /^[a-z0-9-]{3,30}$/i,
    async check(u, ctx) {
      const r = await ctx.req(`https://sourceforge.net/rest/u/${enc(u.toLowerCase())}/profile`, { headers: { Accept: 'application/json' } });
      if (r.status === 404) return NF();
      const j = r.json();
      if (r.status !== 200 || !j || !j.username) return UNK(httpReason(r));
      const loc = j.localization || {};
      return OK({
        displayName: j.name, username: j.username, created: j.joined, location: [loc.city, loc.country].filter(Boolean).join(', '),
        links: (j.webpages || []).concat((j.socialnetworks || []).map(n => n.accounturl)).filter(x => /^https?:/.test(x || '')),
        posts: (j.projects || []).length, postsLabel: 'proyectos',
        extra: { 'Proyectos': (j.projects || []).map(p => p.name).slice(0, 10).join(', '), 'Habilidades': (j.skills || []).map(x => x.skill && x.skill.fullname).filter(Boolean).join(', '), 'Zona horaria': j.preferences && j.preferences.timezone }
      });
    }
  },
  pageSource({ id: 'replit', name: 'Replit', cat: 'Desarrollo', reliability: 'baja', url: u => `https://replit.com/@${enc(u)}`, valid: /^[A-Za-z0-9_-]{2,40}$/ }),
  {
    id: 'leetcode', name: 'LeetCode', cat: 'Desarrollo', kind: 'api', reliability: 'media',
    method: 'GraphQL público de LeetCode', endpoint: 'POST https://leetcode.com/graphql (matchedUser)',
    profileUrl: u => `https://leetcode.com/u/${enc(u)}/`, valid: /^[A-Za-z0-9_-]{1,30}$/,
    async check(u, ctx) {
      const body = JSON.stringify({ query: 'query($u:String!){matchedUser(username:$u){username profile{realName aboutMe userAvatar countryName company school websites ranking}}}', variables: { u } });
      const r = await ctx.req('https://leetcode.com/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Referer': 'https://leetcode.com/' }, body });
      const j = r.json();
      if (r.status !== 200 || !j || !j.data) return UNK(httpReason(r));
      const m = j.data.matchedUser;
      if (!m) return NF();
      const p = m.profile || {};
      return OK({ displayName: p.realName, username: m.username, bio: p.aboutMe, avatar: p.userAvatar, location: p.countryName, links: p.websites || [], extra: { 'Empresa': p.company, 'Centro de estudios': p.school, 'Ranking': p.ranking } });
    }
  },

  /* ---------------- Redes sociales ---------------- */
  {
    id: 'instagram', name: 'Instagram', cat: 'Redes sociales', kind: 'api', reliability: 'media',
    method: 'Endpoint web web_profile_info y, si no confirma, página pública instagram.com/{usuario}/ (Open Graph); si sigue sin datos, verificación en pestaña',
    endpoint: 'https://www.instagram.com/api/v1/users/web_profile_info/?username={usuario}',
    profileUrl: u => `https://www.instagram.com/${enc(u)}/`, valid: /^[A-Za-z0-9._]{1,30}$/,
    tabPreferred: true, tabNoGuard: true, tabWait: 6000, tabWaitTitle: '\\(@|not found|no encontrada|no disponible',
    tabParse(page, u) { return instagramPageParse(page.html, page.url, u, page.title); },
    async check(u, ctx) {
      let r = null, j = null, us = null, apiNote = '';
      try {
        r = await ctx.req(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${enc(u)}`, { headers: { 'X-IG-App-ID': '936619743392459', 'Accept': 'application/json' }, noRetry: true });
        j = r.json();
        us = j && j.data && j.data.user;
        apiNote = r.status === 200 ? (us ? '' : 'API: usuario vacío') : `API: HTTP ${r.status}`;
      } catch (e) { apiNote = 'API: sin respuesta'; }
      if (!us) {
        // La negativa de la API no es concluyente: se comprueba la página del perfil, como al teclearla en el navegador
        let p;
        try { p = await ctx.req(`https://www.instagram.com/${enc(u)}/`, { headers: { Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' }, noRetry: true }); }
        catch { return UNK(`${apiNote}; página del perfil sin respuesta: verifica en pestaña`); }
        const apiNegative = r && (r.status === 404 || (r.status === 200 && j && j.data && 'user' in j.data && !us));
        if (p.status === 404) return apiNegative ? NF(`${apiNote}; la página del perfil responde 404`) : UNK(`${apiNote}; página del perfil HTTP 404 sin confirmación de la API: verifica en pestaña`);
        if (p.status !== 200) return UNK(`${apiNote}; página del perfil HTTP ${p.status}: verifica en pestaña`);
        const res = instagramPageParse(p.text, p.url, u);
        if (res.status === 'found') res.profile.extra['Método'] = `Página pública del perfil (${apiNote || 'API sin datos'})`;
        else if (res.status === 'notfound' && !apiNegative) return UNK(`${apiNote}; ${res.reason}; sin confirmación de la API: verifica en pestaña`);
        else if (res.status === 'notfound') res.reason = `${apiNote}; ${res.reason}`;
        else res.reason = `${apiNote}; ${res.reason}`;
        return res;
      }
      return OK({
        displayName: us.full_name, username: us.username, bio: us.biography, avatar: us.profile_pic_url_hd || us.profile_pic_url,
        followers: (us.edge_followed_by || {}).count, following: (us.edge_follow || {}).count,
        posts: (us.edge_owner_to_timeline_media || {}).count, postsLabel: 'publicaciones',
        website: us.external_url, verified: us.is_verified ? 'Verificada' : null, private: us.is_private,
        links: (us.bio_links || []).map(b => b.url),
        emails: us.business_email ? [us.business_email] : [],
        extra: {
          'ID numérico': us.id, 'FBID': us.fbid, 'Categoría': us.category_name, 'Cuenta profesional': us.is_business_account,
          'Teléfono profesional': us.business_phone_number, 'Contacto profesional': us.business_contact_method
        }
      });
    }
  },
  {
    id: 'tiktok', name: 'TikTok', cat: 'Redes sociales', kind: 'page', control: true, reliability: 'media',
    method: 'Página pública: datos de hidratación __UNIVERSAL_DATA_FOR_REHYDRATION__',
    endpoint: 'https://www.tiktok.com/@{usuario}',
    profileUrl: u => `https://www.tiktok.com/@${enc(u)}`, valid: /^[A-Za-z0-9._]{2,24}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://www.tiktok.com/@${enc(u)}?lang=es`);
      if (r.status === 404) return NF();
      if (r.status !== 200) return UNK(httpReason(r));
      const raw = U.scriptById(r.text, '__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (!raw) return UNK('Página sin datos (posible bloqueo anti-bot)');
      let j; try { j = JSON.parse(raw); } catch { return UNK('Datos no interpretables'); }
      const d = ((j || {}).__DEFAULT_SCOPE__ || {})['webapp.user-detail'];
      if (!d) return UNK('Estructura de datos no reconocida');
      const us = d.userInfo && d.userInfo.user, st = (d.userInfo && (d.userInfo.stats || d.userInfo.statsV2)) || {};
      if (!us || !us.id) return d.statusCode && d.statusCode !== 0 ? NF(`Inexistente o restringida (código TikTok ${d.statusCode})`) : UNK('Sin datos de usuario');
      return OK({
        displayName: us.nickname, username: us.uniqueId, bio: us.signature, avatar: us.avatarLarger || us.avatarMedium,
        followers: st.followerCount, following: st.followingCount, posts: st.videoCount, postsLabel: 'vídeos',
        verified: us.verified ? 'Verificada' : null, private: us.privateAccount, created: us.createTime,
        website: us.bioLink && us.bioLink.link,
        extra: { 'ID numérico': us.id, 'secUid': us.secUid, 'Me gusta recibidos': st.heartCount, 'Idioma': us.language, 'Región': us.region, 'Último cambio de alias': U.date(us.uniqueIdModifyTime), 'Último cambio de nombre': U.date(us.nickNameModifyTime) }
      });
    }
  },
  {
    id: 'x-fx', name: 'X / Twitter', cat: 'Redes sociales', kind: 'api', reliability: 'media', third: true,
    method: 'Servicios de terceros FxTwitter (api.fxtwitter.com) y, si falla, vxTwitter (api.vxtwitter.com): el identificador se envía a esos servicios',
    endpoint: 'https://api.fxtwitter.com/{usuario}',
    profileUrl: u => `https://x.com/${enc(u)}`, valid: /^[A-Za-z0-9_]{1,15}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://api.fxtwitter.com/${enc(u)}`);
      const j = r.json();
      if (r.status === 404 || (j && j.code === 404)) return NF();
      if (r.status !== 200 || !j || !j.user) {
        try { const vx = await vxTwitter(u, ctx); if (vx) return vx; } catch { /* segunda opción no disponible */ }
        return UNK(httpReason(r));
      }
      const us = j.user;
      return OK({
        displayName: us.name, username: us.screen_name, bio: us.description, avatar: xHiRes(us.avatar_url), banner: us.banner_url,
        followers: us.followers, following: us.following, posts: us.tweets, postsLabel: 'posts',
        location: us.location, website: us.website && us.website.url, created: us.joined,
        verified: us.verification && us.verification.verified ? `Verificada (${us.verification.type || ''})` : null,
        extra: { 'ID numérico': us.id, 'Me gusta': us.likes, 'Medios': us.media_count, 'Protegida': us.protected }
      });
    }
  },
  X_TAB_SOURCE,
  FACEBOOK_SOURCE,
  {
    id: 'bluesky', name: 'Bluesky', cat: 'Redes sociales', kind: 'api', reliability: 'alta',
    method: 'AppView pública AT Protocol (getProfile)',
    endpoint: 'https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor={usuario}.bsky.social',
    profileUrl: u => `https://bsky.app/profile/${enc(u.includes('.') ? u : u + '.bsky.social')}`,
    valid: /^[A-Za-z0-9.-]{3,253}$/,
    async check(u, ctx) {
      const actor = u.includes('.') ? u : `${u}.bsky.social`;
      const r = await ctx.req(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${enc(actor.toLowerCase())}`);
      const j = r.json();
      if (r.status === 400) return NF();
      if (r.status !== 200 || !j) return UNK(httpReason(r));
      return OK({
        displayName: j.displayName, username: j.handle, bio: j.description, avatar: j.avatar, banner: j.banner,
        followers: j.followersCount, following: j.followsCount, posts: j.postsCount, postsLabel: 'posts',
        created: j.createdAt, extra: { 'DID': j.did, 'Indexado': U.date(j.indexedAt) }
      });
    }
  },
  {
    id: 'mastodon', name: 'Mastodon (mastodon.social)', cat: 'Redes sociales', kind: 'api', reliability: 'alta',
    method: 'API pública de Mastodon (lookup en la instancia mastodon.social)',
    endpoint: 'https://mastodon.social/api/v1/accounts/lookup?acct={usuario}',
    profileUrl: u => `https://mastodon.social/@${enc(u)}`, valid: /^[A-Za-z0-9_]{1,30}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://mastodon.social/api/v1/accounts/lookup?acct=${enc(u)}`);
      if (r.status === 404) return NF();
      const j = r.json();
      if (r.status !== 200 || !j) return UNK(httpReason(r));
      const fields = (j.fields || []).map(f => ({ name: f.name, value: U.strip(f.value) }));
      return OK({
        displayName: j.display_name, username: j.acct, bio: U.strip(j.note), avatar: j.avatar, banner: j.header,
        followers: j.followers_count, following: j.following_count, posts: j.statuses_count, postsLabel: 'publicaciones',
        created: j.created_at, lastActive: j.last_status_at, url: j.url,
        links: fields.map(f => f.value).filter(v => /^https?:\/\//.test(v)),
        extra: Object.assign({ 'ID': j.id, 'Bot': j.bot }, ...fields.map(f => ({ ['Campo · ' + f.name]: f.value })))
      });
    }
  },
  {
    id: 'reddit', name: 'Reddit', cat: 'Foros', kind: 'api', reliability: 'media',
    method: 'JSON público about.json (www, api y old.reddit como alternativas); si bloquea, verificación en pestaña',
    endpoint: 'https://www.reddit.com/user/{usuario}/about.json',
    profileUrl: u => `https://www.reddit.com/user/${enc(u)}`, valid: /^[A-Za-z0-9_-]{3,20}$/,
    nfText: /nobody on Reddit goes by that name|nadie en Reddit|page not found/i,
    async check(u, ctx) {
      let r;
      for (const url of [`https://www.reddit.com/user/${enc(u)}/about.json?raw_json=1`, `https://api.reddit.com/user/${enc(u)}/about?raw_json=1`, `https://old.reddit.com/user/${enc(u)}/about.json?raw_json=1`]) {
        r = await ctx.req(url, { noRetry: true });
        if (![403, 429].includes(r.status) && r.status < 500) break;
      }
      if (r.status === 404) return NF();
      const j = r.json();
      if (r.status !== 200 || !j || !j.data) return UNK(httpReason(r));
      const d = j.data, sr = d.subreddit || {};
      if (d.is_suspended) return OK({ username: d.name, verified: null, extra: { 'Estado': 'Cuenta suspendida' } });
      return OK({
        displayName: sr.title, username: d.name, bio: sr.public_description, avatar: (d.icon_img || '').split('?')[0] || d.snoovatar_img,
        created: d.created_utc, verified: d.verified ? 'Verificada' : null,
        extra: { 'ID': d.id, 'Karma total': d.total_karma, 'Karma de enlaces': d.link_karma, 'Karma de comentarios': d.comment_karma, 'Correo verificado': d.has_verified_email, 'Moderador': d.is_mod, 'Empleado Reddit': d.is_employee, 'NSFW': sr.over_18 }
      });
    }
  },
  pageSource({
    id: 'telegram', name: 'Telegram', cat: 'Mensajería', reliability: 'media',
    url: u => `https://t.me/${enc(u)}`, valid: /^[A-Za-z0-9_]{4,32}$/,
    parse(html) {
      if (!/class="tgme_page_title"/.test(html)) return { __status: NF('Sin ficha pública en t.me') };
      const img = U.meta(html, 'og:image');
      let desc = U.meta(html, 'og:description') || '';
      if (/^You can contact @|^If you have Telegram/i.test(desc)) desc = '';
      const extra = (html.match(/class="tgme_page_extra"[^>]*>([\s\S]*?)<\/div>/) || [])[1];
      const isChannel = /tgme_action_button_new[^>]*>\s*(View in Telegram|Preview channel|Ver en Telegram)/i.test(html) || /subscribers|members|suscriptores|miembros/i.test(extra || '');
      return {
        displayName: U.strip((html.match(/class="tgme_page_title"[^>]*>([\s\S]*?)<\/div>/) || [])[1]) || U.meta(html, 'og:title'),
        bio: desc, avatar: /telegram\.org\/img\/t_logo/.test(img || '') ? null : img,
        extra: { 'Información adicional': U.strip(extra || ''), 'Tipo probable': isChannel ? 'Canal o grupo' : 'Usuario o bot' }
      };
    }
  }),
  pageSource({
    id: 'youtube', name: 'YouTube', cat: 'Vídeo', reliability: 'media',
    url: u => `https://www.youtube.com/@${enc(u)}`, valid: /^[A-Za-z0-9._-]{3,30}$/,
    parse(html) {
      const p = ogProfile(html);
      const cid = (html.match(/"(?:channelId|externalId)":"(UC[\w-]{22})"/) || [])[1];
      const subs = (html.match(/"subscriberCountText":\{[^}]*?"simpleText":"([^"]+)"/) || [])[1];
      return Object.assign(p, { extra: { 'ID de canal': cid, 'Suscriptores (texto)': subs, 'Enlace por ID': cid ? `https://www.youtube.com/channel/${cid}` : null } });
    }
  }),
  {
    id: 'twitch', name: 'Twitch', cat: 'Vídeo', kind: 'api', reliability: 'media',
    method: 'GraphQL público de Twitch con el Client-ID de su web',
    endpoint: 'POST https://gql.twitch.tv/gql (user)',
    profileUrl: u => `https://www.twitch.tv/${enc(u)}`, valid: /^[A-Za-z0-9_]{3,25}$/,
    async check(u, ctx) {
      const body = JSON.stringify({ query: 'query($l:String!){user(login:$l){id login displayName description createdAt profileImageURL(width:300) followers{totalCount} lastBroadcast{startedAt title} roles{isPartner isAffiliate}}}', variables: { l: u.toLowerCase() } });
      const r = await ctx.req('https://gql.twitch.tv/gql', { method: 'POST', headers: { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' }, body });
      const j = r.json();
      if (r.status !== 200 || !j || !j.data) return UNK(httpReason(r));
      const us = j.data.user;
      if (!us) return NF();
      return OK({
        displayName: us.displayName, username: us.login, bio: us.description, avatar: us.profileImageURL,
        followers: (us.followers || {}).totalCount, created: us.createdAt, lastActive: (us.lastBroadcast || {}).startedAt,
        verified: (us.roles || {}).isPartner ? 'Partner' : ((us.roles || {}).isAffiliate ? 'Afiliado' : null),
        extra: { 'ID numérico': us.id, 'Última emisión': (us.lastBroadcast || {}).title }
      });
    }
  },
  {
    id: 'kick', name: 'Kick', cat: 'Vídeo', kind: 'api', reliability: 'baja',
    method: 'API web de Kick (protegida por Cloudflare; puede no responder)', endpoint: 'https://kick.com/api/v2/channels/{usuario}',
    profileUrl: u => `https://kick.com/${enc(u)}`, valid: /^[A-Za-z0-9_]{3,25}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://kick.com/api/v2/channels/${enc(u.toLowerCase())}`, { headers: { Accept: 'application/json' } });
      if (r.status === 404) return NF();
      const j = r.json();
      if (r.status !== 200 || !j || !j.user) return UNK(httpReason(r));
      const us = j.user;
      return OK({
        displayName: us.username, username: j.slug, bio: us.bio, avatar: us.profile_pic, followers: j.followers_count ?? j.followersCount,
        verified: j.verified ? 'Verificado' : null,
        handles: [['Instagram', us.instagram], ['X', us.twitter], ['YouTube', us.youtube], ['Discord', us.discord], ['TikTok', us.tiktok], ['Facebook', us.facebook]]
          .filter(x => x[1]).map(([platform, handle]) => ({ platform, handle: String(handle).split('/').filter(Boolean).pop() })),
        extra: { 'ID canal': j.id, 'ID usuario': us.id, 'Baneado': j.is_banned, 'Instagram': us.instagram, 'X': us.twitter, 'YouTube': us.youtube, 'Discord': us.discord, 'TikTok': us.tiktok }
      });
    }
  },
  pageSource({ id: 'vimeo', name: 'Vimeo', cat: 'Vídeo', url: u => `https://vimeo.com/${enc(u)}`, valid: /^[A-Za-z0-9_]{3,32}$/ }),
  pageSource({ id: 'rumble', name: 'Rumble', cat: 'Vídeo', reliability: 'baja', url: u => `https://rumble.com/user/${enc(u)}`, valid: /^[A-Za-z0-9_-]{3,40}$/ }),
  pageSource({ id: 'snapchat', name: 'Snapchat', cat: 'Redes sociales', reliability: 'baja', url: u => `https://www.snapchat.com/add/${enc(u)}`, valid: /^[A-Za-z][A-Za-z0-9._-]{2,14}$/ }),
  pageSource({ id: 'vk', name: 'VK', cat: 'Redes sociales', reliability: 'baja', url: u => `https://vk.com/${enc(u)}`, valid: /^[A-Za-z0-9_.]{5,32}$/ }),
  pageSource({ id: 'tumblr', name: 'Tumblr', cat: 'Blogs', url: u => `https://www.tumblr.com/${enc(u)}`, valid: /^[A-Za-z0-9-]{1,32}$/ }),
  {
    id: 'substack', name: 'Substack', cat: 'Blogs', kind: 'api', reliability: 'alta',
    method: 'API pública de perfiles de Substack', endpoint: 'https://substack.com/api/v1/user/{usuario}/public_profile',
    profileUrl: u => `https://substack.com/@${enc(u)}`, valid: /^[A-Za-z0-9_-]{1,40}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://substack.com/api/v1/user/${enc(u)}/public_profile`);
      if (r.status === 404) return NF();
      const j = r.json();
      if (r.status !== 200 || !j || !j.id) return UNK(httpReason(r));
      const pubs = (j.publicationUsers || []).map(p => p.publication || {}).filter(Boolean);
      return OK({
        displayName: j.name, username: j.handle, bio: j.bio, avatar: j.photo_url, created: j.profile_set_up_at,
        links: pubs.map(p => p.custom_domain ? `https://${p.custom_domain}` : (p.subdomain ? `https://${p.subdomain}.substack.com` : null)).filter(Boolean),
        extra: { 'ID': j.id, 'Publicaciones': pubs.map(p => p.name).join(', ') }
      });
    }
  },
  {
    id: 'wordpress', name: 'WordPress.com', cat: 'Blogs', kind: 'api', reliability: 'alta',
    method: 'API pública REST de WordPress.com (sitio {usuario}.wordpress.com)',
    endpoint: 'https://public-api.wordpress.com/rest/v1.1/sites/{usuario}.wordpress.com',
    profileUrl: u => `https://${u}.wordpress.com/`, valid: /^[a-z0-9]{4,63}$/i,
    async check(u, ctx) {
      const r = await ctx.req(`https://public-api.wordpress.com/rest/v1.1/sites/${enc(u.toLowerCase())}.wordpress.com`);
      const j = r.json();
      if (r.status === 404) return NF();
      if (r.status === 403) return OK({ displayName: `${u}.wordpress.com`, extra: { 'Estado': 'Sitio existente pero privado' } });
      if (r.status !== 200 || !j) return UNK(httpReason(r));
      return OK({ displayName: j.name, bio: j.description, url: j.URL, avatar: (j.icon || {}).img, extra: { 'ID sitio': j.ID, 'Idioma': j.lang } });
    }
  },
  pageSource({ id: 'blogger', name: 'Blogger', cat: 'Blogs', url: u => `https://${u}.blogspot.com/`, valid: /^[a-z0-9-]{1,63}$/i, homeRedirectNF: false }),
  {
    id: 'wattpad', name: 'Wattpad', cat: 'Blogs', kind: 'api', reliability: 'alta',
    method: 'API pública v3 de Wattpad', endpoint: 'https://www.wattpad.com/api/v3/users/{usuario}',
    profileUrl: u => `https://www.wattpad.com/user/${enc(u)}`, valid: /^[A-Za-z0-9_-]{1,40}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://www.wattpad.com/api/v3/users/${enc(u)}?fields=username,name,avatar,description,location,createDate,numFollowers,numFollowing,numStoriesPublished,website,facebook,twitter,verified,lastLogin,gender`);
      const j = r.json();
      if (r.status === 404 || r.status === 400) return NF();
      if (r.status !== 200 || !j || !j.username) return UNK(httpReason(r));
      return OK({
        displayName: j.name, username: j.username, bio: j.description, avatar: j.avatar, location: j.location,
        followers: j.numFollowers, following: j.numFollowing, posts: j.numStoriesPublished, postsLabel: 'historias',
        website: j.website, created: j.createDate, lastActive: j.lastLogin, verified: j.verified ? 'Verificada' : null,
        handles: [j.twitter && { platform: 'X', handle: j.twitter }, j.facebook && { platform: 'Facebook', handle: j.facebook }].filter(Boolean),
        extra: { 'Género': j.gender }
      });
    }
  },

  /* ---------------- Enlaces en bio / perfiles agregadores ---------------- */
  pageSource({
    id: 'linktree', name: 'Linktree', cat: 'Enlaces en bio', reliability: 'alta',
    method: 'Página pública: datos __NEXT_DATA__ (incluye todos los enlaces)',
    url: u => `https://linktr.ee/${enc(u)}`, valid: /^[A-Za-z0-9._]{2,30}$/,
    parse(html) {
      const raw = U.scriptById(html, '__NEXT_DATA__');
      let pp = {};
      try { pp = JSON.parse(raw).props.pageProps || {}; } catch { /* */ }
      const a = pp.account || {};
      if (!a.username && !pp.links) return ogProfile(html);
      const links = (pp.links || a.links || []).map(l => l.url).filter(Boolean);
      const socials = (pp.socialLinks || a.socialLinks || []).map(l => l.url).filter(Boolean);
      return {
        displayName: a.pageTitle, username: a.username, bio: a.description, avatar: a.profilePictureUrl,
        links: links.concat(socials), created: a.createdAt, verified: a.isVerified ? 'Verificada' : null,
        extra: { 'ID': a.id, 'Enlaces publicados': links.length, 'Enlaces': links.concat(socials).join(' | ') }
      };
    }
  }),
  {
    id: 'gravatar', name: 'Gravatar', cat: 'Enlaces en bio', kind: 'api', reliability: 'alta',
    method: 'API v3 pública de Gravatar (perfil por nombre)', endpoint: 'https://api.gravatar.com/v3/profiles/{usuario}',
    profileUrl: u => `https://gravatar.com/${enc(u)}`, valid: /^[A-Za-z0-9_.-]{2,64}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://api.gravatar.com/v3/profiles/${enc(u)}`);
      if (r.status === 404) return NF();
      const j = r.json();
      if (r.status !== 200 || !j) return UNK(httpReason(r));
      return OK(gravatarProfile(j));
    }
  },
  pageSource({ id: 'aboutme', name: 'About.me', cat: 'Enlaces en bio', url: u => `https://about.me/${enc(u)}`, valid: /^[A-Za-z0-9_.-]{2,40}$/ }),

  /* ---------------- Juegos ---------------- */
  {
    id: 'steam', name: 'Steam', cat: 'Juegos', kind: 'api', reliability: 'alta',
    method: 'Perfil público en XML (URL personalizada /id/)', endpoint: 'https://steamcommunity.com/id/{usuario}/?xml=1',
    profileUrl: u => `https://steamcommunity.com/id/${enc(u)}`, valid: /^[A-Za-z0-9_-]{2,32}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://steamcommunity.com/id/${enc(u)}/?xml=1`);
      if (r.status !== 200) return UNK(httpReason(r));
      const x = new DOMParser().parseFromString(r.text, 'text/xml');
      const g = t => { const n = x.querySelector(t); return n ? n.textContent.trim() : null; };
      if (x.querySelector('response > error') || !g('steamID64')) return NF();
      const sid = g('steamID64');
      return OK({
        displayName: g('steamID'), username: g('customURL'), bio: U.strip(g('summary')), avatar: g('avatarFull'),
        location: g('location'), created: g('memberSince'), url: `https://steamcommunity.com/profiles/${sid}`,
        extra: { 'SteamID64': sid, 'Nombre real': g('realname'), 'Estado': g('onlineState'), 'Privacidad': g('privacyState'), 'VAC': g('vacBanned') === '1' ? 'Sí' : 'No', 'Restricción comercio': g('tradeBanState'), 'Limitada': g('isLimitedAccount') }
      });
    }
  },
  {
    id: 'chesscom', name: 'Chess.com', cat: 'Juegos', kind: 'api', reliability: 'alta',
    method: 'API pública (PubAPI) de Chess.com', endpoint: 'https://api.chess.com/pub/player/{usuario}',
    profileUrl: u => `https://www.chess.com/member/${enc(u)}`, valid: /^[A-Za-z0-9_-]{3,25}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://api.chess.com/pub/player/${enc(u.toLowerCase())}`);
      if (r.status === 404 || r.status === 410) return NF();
      const j = r.json();
      if (r.status !== 200 || !j) return UNK(httpReason(r));
      return OK({
        displayName: j.name, username: j.username, avatar: j.avatar, location: j.location, followers: j.followers,
        created: j.joined, lastActive: j.last_online, url: j.url, verified: j.verified ? 'Verificada' : null,
        extra: { 'ID': j.player_id, 'País': (j.country || '').split('/').pop(), 'Estado': j.status, 'Título': j.title, 'Streamer': j.is_streamer, 'Twitch': j.twitch_url }
      });
    }
  },
  {
    id: 'lichess', name: 'Lichess', cat: 'Juegos', kind: 'api', reliability: 'alta',
    method: 'API pública de Lichess', endpoint: 'https://lichess.org/api/user/{usuario}',
    profileUrl: u => `https://lichess.org/@/${enc(u)}`, valid: /^[A-Za-z0-9_-]{2,30}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://lichess.org/api/user/${enc(u)}`, { headers: { Accept: 'application/json' } });
      if (r.status === 404) return NF();
      const j = r.json();
      if (r.status !== 200 || !j) return UNK(httpReason(r));
      const p = j.profile || {};
      return OK({
        displayName: p.realName || [p.firstName, p.lastName].filter(Boolean).join(' '), username: j.username,
        bio: p.bio, location: p.location, created: j.createdAt, lastActive: j.seenAt, url: j.url,
        links: (p.links || '').split(/\s+/).filter(Boolean),
        posts: (j.count || {}).all, postsLabel: 'partidas',
        extra: { 'País/bandera': p.flag || p.country, 'Título': j.title, 'Cerrada': j.disabled, 'Infracción TOS': j.tosViolation, 'Patrocinador': j.patron }
      });
    }
  },
  {
    id: 'roblox', name: 'Roblox', cat: 'Juegos', kind: 'api', reliability: 'alta',
    method: 'API pública de usuarios de Roblox (resolución exacta + ficha)', endpoint: 'POST https://users.roblox.com/v1/usernames/users',
    profileUrl: u => `https://www.roblox.com/search/users?keyword=${enc(u)}`, valid: /^[A-Za-z0-9_]{3,20}$/,
    async check(u, ctx) {
      const r = await ctx.req('https://users.roblox.com/v1/usernames/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ usernames: [u], excludeBannedUsers: false }) });
      const j = r.json();
      if (r.status !== 200 || !j) return UNK(httpReason(r));
      const b = (j.data || [])[0];
      if (!b) return NF();
      let d = {}, av = null;
      try { d = (await ctx.req(`https://users.roblox.com/v1/users/${b.id}`)).json() || {}; } catch { /* */ }
      try { av = (((await ctx.req(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${b.id}&size=150x150&format=Png`)).json() || {}).data || [])[0]; } catch { /* */ }
      return OK({
        displayName: b.displayName, username: b.name, bio: d.description, created: d.created, avatar: av && av.imageUrl,
        url: `https://www.roblox.com/users/${b.id}/profile`, verified: b.hasVerifiedBadge ? 'Verificada' : null,
        extra: { 'ID numérico': b.id, 'Baneada': d.isBanned }
      });
    }
  },
  {
    id: 'minecraft', name: 'Minecraft', cat: 'Juegos', kind: 'api', reliability: 'alta',
    method: 'API de Mojang (nombre → UUID)', endpoint: 'https://api.mojang.com/users/profiles/minecraft/{usuario}',
    profileUrl: u => `https://namemc.com/profile/${enc(u)}`, valid: /^[A-Za-z0-9_]{3,16}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://api.mojang.com/users/profiles/minecraft/${enc(u)}`);
      if (r.status === 404 || r.status === 204) return NF();
      const j = r.json();
      if (r.status !== 200 || !j || !j.id) return UNK(httpReason(r));
      return OK({ username: j.name, extra: { 'UUID': j.id, 'Legacy': j.legacy, 'Demo': j.demo } });
    }
  },
  {
    id: 'speedrun', name: 'Speedrun.com', cat: 'Juegos', kind: 'api', reliability: 'alta',
    method: 'API pública v1 de speedrun.com (incluye redes enlazadas)', endpoint: 'https://www.speedrun.com/api/v1/users/{usuario}',
    profileUrl: u => `https://www.speedrun.com/users/${enc(u)}`, valid: /^[A-Za-z0-9_.-]{2,30}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://www.speedrun.com/api/v1/users/${enc(u)}`);
      if (r.status === 404) return NF();
      const j = r.json();
      if (r.status !== 200 || !j || !j.data) return UNK(httpReason(r));
      const d = j.data;
      const links = [d.twitch, d.youtube, d.twitter, d.hitbox, d.speedrunslive, d.weblink].map(x => x && x.uri).filter(Boolean);
      return OK({
        displayName: (d.names || {}).international, username: (d.names || {}).international, created: d.signup, url: d.weblink,
        location: (((d.location || {}).country || {}).names || {}).international,
        avatar: (((d.assets || {}).image) || {}).uri, links,
        extra: { 'ID': d.id, 'Rol': d.role, 'Nombre (japonés)': (d.names || {}).japanese, 'Pronombres': d.pronouns }
      });
    }
  },
  {
    id: 'duolingo', name: 'Duolingo', cat: 'Ocio', kind: 'api', reliability: 'alta',
    method: 'API pública de perfiles de Duolingo', endpoint: 'https://www.duolingo.com/2017-06-30/users?username={usuario}',
    profileUrl: u => `https://www.duolingo.com/profile/${enc(u)}`, valid: /^[A-Za-z0-9._-]{1,40}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://www.duolingo.com/2017-06-30/users?username=${enc(u)}`);
      const j = r.json();
      if (r.status !== 200 || !j) return UNK(httpReason(r));
      const us = (j.users || []).find(x => (x.username || '').toLowerCase() === u.toLowerCase()) || (j.users || [])[0];
      if (!us) return NF();
      return OK(duolingoProfile(us));
    }
  },

  /* ---------------- Creatividad, música y ocio ---------------- */
  pageSource({ id: 'soundcloud', name: 'SoundCloud', cat: 'Música', url: u => `https://soundcloud.com/${enc(u)}`, valid: /^[a-z0-9_-]{3,25}$/i }),
  pageSource({ id: 'lastfm', name: 'Last.fm', cat: 'Música', url: u => `https://www.last.fm/user/${enc(u)}`, valid: /^[A-Za-z][A-Za-z0-9_-]{1,14}$/, nfText: /User not found|Usuario no encontrado|Page Not Found/i }),
  pageSource({ id: 'letterboxd', name: 'Letterboxd', cat: 'Ocio', url: u => `https://letterboxd.com/${enc(u)}/`, valid: /^[A-Za-z0-9_]{2,15}$/ }),
  pageSource({ id: 'flickr', name: 'Flickr', cat: 'Fotografía', url: u => `https://www.flickr.com/people/${enc(u)}/`, valid: /^[A-Za-z0-9_@.-]{2,40}$/ }),
  pageSource({ id: 'dribbble', name: 'Dribbble', cat: 'Diseño', url: u => `https://dribbble.com/${enc(u)}`, valid: /^[A-Za-z0-9_-]{2,30}$/ }),
  pageSource({ id: 'behance', name: 'Behance', cat: 'Diseño', reliability: 'baja', url: u => `https://www.behance.net/${enc(u)}`, valid: /^[A-Za-z0-9_-]{3,30}$/ }),
  pageSource({ id: 'deviantart', name: 'DeviantArt', cat: 'Diseño', reliability: 'baja', url: u => `https://www.deviantart.com/${enc(u)}`, valid: /^[A-Za-z0-9-]{3,20}$/ }),
  {
    id: 'artstation', name: 'ArtStation', cat: 'Diseño', kind: 'api', reliability: 'media',
    method: 'Endpoint JSON público quick.json', endpoint: 'https://www.artstation.com/users/{usuario}/quick.json',
    profileUrl: u => `https://www.artstation.com/${enc(u)}`, valid: /^[A-Za-z0-9_-]{2,40}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://www.artstation.com/users/${enc(u)}/quick.json`);
      if (r.status === 404) return NF();
      const j = r.json();
      if (r.status !== 200 || !j || !j.username) return UNK(httpReason(r));
      return OK({
        displayName: j.full_name, username: j.username, bio: j.headline, avatar: j.large_avatar_url || j.medium_avatar_url,
        location: [j.city, j.country].filter(Boolean).join(', '), followers: j.followers_count, following: j.followees_count,
        extra: { 'ID': j.id, 'Pro': j.pro_member }
      });
    }
  },
  {
    id: 'imgur', name: 'Imgur', cat: 'Fotografía', kind: 'api', reliability: 'alta',
    method: 'API de cuentas de Imgur con el client_id público de su web', endpoint: 'https://api.imgur.com/account/v1/accounts/{usuario}',
    profileUrl: u => `https://imgur.com/user/${enc(u)}`, valid: /^[A-Za-z0-9_]{3,63}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://api.imgur.com/account/v1/accounts/${enc(u)}?client_id=546c25a59c58ad7`);
      if (r.status === 404) return NF();
      const j = r.json();
      if (r.status !== 200 || !j || !j.username) return UNK(httpReason(r));
      return OK({ username: j.username, bio: j.bio, avatar: j.avatar_url, created: j.created_at, extra: { 'ID': j.id, 'Reputación': j.reputation_count, 'Rango': j.reputation_name } });
    }
  },
  {
    id: 'trello', name: 'Trello', cat: 'Productividad', kind: 'api', reliability: 'media',
    method: 'API REST de Trello para miembros públicos', endpoint: 'https://trello.com/1/members/{usuario}',
    profileUrl: u => `https://trello.com/u/${enc(u)}`, valid: /^[a-z0-9_]{3,100}$/i,
    async check(u, ctx) {
      const r = await ctx.req(`https://trello.com/1/members/${enc(u)}?fields=fullName,username,bio,avatarUrl,url,initials,memberType`);
      if (r.status === 404) return NF();
      const j = r.json();
      if (r.status !== 200 || !j || !j.username) return UNK(httpReason(r));
      return OK({ displayName: j.fullName, username: j.username, bio: j.bio, avatar: j.avatarUrl ? j.avatarUrl + '/170.png' : null, url: j.url, extra: { 'ID': j.id, 'Iniciales': j.initials, 'Tipo': j.memberType } });
    }
  },
  pageSource({ id: 'pastebin', name: 'Pastebin', cat: 'Foros', reliability: 'baja', url: u => `https://pastebin.com/u/${enc(u)}`, valid: /^[A-Za-z0-9_-]{3,20}$/ }),
  pageSource({ id: 'disqus', name: 'Disqus', cat: 'Foros', reliability: 'baja', url: u => `https://disqus.com/by/${enc(u)}/`, valid: /^[A-Za-z0-9_-]{2,30}$/ }),

  /* ---------------- Pagos y creadores (relevante en fraude) ---------------- */
  pageSource({ id: 'cashapp', name: 'Cash App', cat: 'Pagos y creadores', reliability: 'media', url: u => `https://cash.app/$${enc(u)}`, valid: /^[A-Za-z][A-Za-z0-9_-]{0,19}$/ }),
  pageSource({ id: 'kofi', name: 'Ko-fi', cat: 'Pagos y creadores', reliability: 'media', url: u => `https://ko-fi.com/${enc(u)}`, valid: /^[A-Za-z0-9_]{2,40}$/ }),
  pageSource({ id: 'bmc', name: 'Buy Me a Coffee', cat: 'Pagos y creadores', reliability: 'media', url: u => `https://www.buymeacoffee.com/${enc(u)}`, valid: /^[A-Za-z0-9_-]{3,40}$/ }),
  pageSource({ id: 'patreon', name: 'Patreon', cat: 'Pagos y creadores', reliability: 'baja', url: u => `https://www.patreon.com/${enc(u)}`, valid: /^[A-Za-z0-9_]{2,64}$/ }),
  pageSource({ id: 'etsy', name: 'Etsy (tienda)', cat: 'Pagos y creadores', reliability: 'baja', url: u => `https://www.etsy.com/shop/${enc(u)}`, valid: /^[A-Za-z0-9]{4,20}$/, nfText: /no longer available|ya no está disponible|couldn['’]t find|no hemos podido encontrar|Page not found/i }),

  /* ---------------- Enlaces en bio adicionales (verificados con alias de control) ---------------- */
  pageSource({ id: 'beacons', name: 'Beacons', cat: 'Enlaces en bio', url: u => `https://beacons.ai/${enc(u)}`, valid: /^[A-Za-z0-9._]{2,30}$/ }),
  pageSource({ id: 'biolink', name: 'Bio.link', cat: 'Enlaces en bio', url: u => `https://bio.link/${enc(u)}`, valid: /^[A-Za-z0-9_]{2,30}$/ }),
  pageSource({ id: 'allmylinks', name: 'AllMyLinks', cat: 'Enlaces en bio', url: u => `https://allmylinks.com/${enc(u)}`, valid: /^[A-Za-z0-9_-]{2,30}$/ }),
  pageSource({ id: 'soloto', name: 'solo.to', cat: 'Enlaces en bio', url: u => `https://solo.to/${enc(u)}`, valid: /^[A-Za-z0-9._-]{2,30}$/ }),
  pageSource({ id: 'carrd', name: 'Carrd', cat: 'Enlaces en bio', url: u => `https://${u.toLowerCase()}.carrd.co/`, valid: /^[A-Za-z0-9-]{3,30}$/, homeRedirectNF: false }),

  /* ---------------- Otras redes y comunidades ---------------- */
  {
    id: 'pinterest', name: 'Pinterest', cat: 'Redes sociales', kind: 'api', reliability: 'media',
    method: 'API pública de widgets (pidgets) y, como alternativa, recurso UserResource; si bloquea, verificación en pestaña',
    endpoint: 'https://widgets.pinterest.com/v3/pidgets/users/{usuario}/pins/',
    profileUrl: u => `https://www.pinterest.com/${enc(u)}/`, valid: /^[A-Za-z0-9_]{3,30}$/,
    nfText: /isn['’]t available|no está disponible|User not found|Usuario no encontrado/i,
    async check(u, ctx) {
      const w = await ctx.req(`https://widgets.pinterest.com/v3/pidgets/users/${enc(u)}/pins/`, { noRetry: true });
      const wj = w.json();
      if (wj && wj.status === 'success' && wj.data && wj.data.user) {
        const us = wj.data.user, pins = wj.data.pins || [];
        return OK({
          displayName: us.full_name, username: (us.profile_url || '').split('/').filter(Boolean).pop() || u, bio: us.about,
          avatar: (us.image_small_url || '').replace('_30.', '_280.').replace('/30x30_RS/', '/280x280_RS/'),
          followers: us.follower_count, posts: us.pin_count, postsLabel: 'pines', url: us.profile_url,
          lastActive: pins[0] && pins[0].created_at,
          extra: { 'ID numérico': us.id, 'Pines recientes': pins.slice(0, 5).map(p => p.description).filter(Boolean).join(' | ') }
        });
      }
      if (w.status === 404 || (wj && wj.status === 'failure' && /not.?found|404/i.test(JSON.stringify(wj)))) return NF();
      const data = enc(JSON.stringify({ options: { username: u, field_set_key: 'profile' }, context: {} }));
      const r = await ctx.req(`https://www.pinterest.com/resource/UserResource/get/?source_url=${enc('/' + u + '/')}&data=${data}`, { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
      const j = r.json();
      if (r.status === 404) return NF();
      const d = j && j.resource_response && j.resource_response.data;
      if (r.status !== 200 || !d || !d.username) return UNK(httpReason(r));
      if (d.username.toLowerCase() !== u.toLowerCase()) return NF('La plataforma devuelve otro usuario');
      return OK({
        displayName: d.full_name, username: d.username, bio: d.about, avatar: d.image_xlarge_url || d.image_large_url,
        followers: d.follower_count, following: d.following_count, posts: d.pin_count, postsLabel: 'pines',
        website: d.website_url, location: d.location, verified: d.verified_identity && Object.keys(d.verified_identity).length ? 'Verificada' : null,
        extra: { 'ID numérico': d.id, 'Tableros': d.board_count, 'Cuenta de empresa': d.is_partner }
      });
    }
  },
  pageSource({ id: 'ngl', name: 'NGL', cat: 'Redes sociales', url: u => `https://ngl.link/${enc(u)}`, valid: /^[A-Za-z0-9._]{2,30}$/ }),
  pageSource({ id: 'tellonym', name: 'Tellonym', cat: 'Redes sociales', reliability: 'baja', url: u => `https://tellonym.me/${enc(u)}`, valid: /^[A-Za-z0-9._]{2,30}$/ }),
  pageSource({ id: 'meneame', name: 'Menéame', cat: 'España', url: u => `https://www.meneame.net/user/${enc(u)}`, valid: /^[A-Za-z0-9_-]{3,32}$/ }),

  /* ---------------- Plataformas españolas y de interés en España ---------------- */
  {
    id: 'forocoches', name: 'Forocoches', cat: 'España', kind: 'tab', reliability: 'media', tabOnly: true,
    method: 'Perfil de miembro (vBulletin). Protegido por Cloudflare: se verifica en pestaña; los perfiles pueden requerir sesión iniciada',
    endpoint: 'https://forocoches.com/foro/member.php?username={usuario}',
    profileUrl: u => `https://forocoches.com/foro/member.php?username=${enc(u)}`, valid: /^[\p{L}\p{N} ._-]{2,30}$/u,
    async check() { return UNK('Protegida por Cloudflare: usa «Verificar en pestaña»'); },
    tabParse(page) {
      const h = page.html || '';
      if (/no tienes permiso|no has iniciado sesi[oó]n|debes estar registrado|not logged in|do not have permission/i.test(h)) return UNK('Forocoches exige sesión iniciada para ver perfiles');
      if (/usuario no (?:es )?v[aá]lido|usuario no especificado|invalid user|no existe ning[uú]n usuario/i.test(h)) return NF();
      if (!/member_username|Ver perfil|Viendo perfil|Mensajes totales|Fecha de registro|Join Date|Total Posts/i.test(h)) return UNK('Página sin perfil reconocible');
      const pick = re => { const m = h.match(re); return m ? U.strip(m[1]) : null; };
      return OK({
        displayName: pick(/class="member_username"[^>]*>([\s\S]*?)<\//) || (page.title || '').replace(/^.*?(?:Perfil|Profile)[:\s-]*/i, '').trim(),
        created: pick(/(?:Fecha de registro|Join Date)[^<]*<\/[^>]+>\s*(?:<[^>]+>\s*)*([^<]{6,30})/i),
        posts: pick(/(?:Mensajes totales|Total Posts)[^<]*<\/[^>]+>\s*(?:<[^>]+>\s*)*([\d.,]+)/i), postsLabel: 'mensajes',
        lastActive: pick(/(?:Última actividad|Last Activity)[^<]*<\/[^>]+>\s*(?:<[^>]+>\s*)*([^<]{4,30})/i)
      });
    }
  },
  pageSource({
    id: 'mediavida', name: 'Mediavida', cat: 'España', url: u => `https://www.mediavida.com/id/${enc(u)}`, valid: /^[A-Za-z0-9_-]{3,30}$/,
    nfText: /no existe|no encontrado|not found/i
  }),
  pageSource({
    id: 'elotrolado', name: 'ElOtroLado (EOL)', cat: 'España', reliability: 'baja',
    url: u => `https://www.elotrolado.net/memberlist.php?mode=viewprofile&un=${enc(u)}`, valid: /^[\p{L}\p{N} ._-]{2,30}$/u,
    nfText: /usuario solicitado no existe|requested user does not exist/i, okText: /viewprofile|Registrado|Joined|memberlist/i
  }),
  pageSource({ id: 'chollometro', name: 'Chollometro', cat: 'España', url: u => `https://www.chollometro.com/profile/${enc(u)}`, valid: /^[A-Za-z0-9_.-]{3,30}$/ }),
  pageSource({ id: 'domestika', name: 'Domestika', cat: 'España', url: u => `https://www.domestika.org/es/${enc(u)}`, valid: /^[A-Za-z0-9_-]{3,40}$/ }),
  {
    id: 'habbo', name: 'Habbo (ES)', cat: 'España', kind: 'api', reliability: 'alta',
    method: 'API pública de Habbo España (perfil por nombre)', endpoint: 'https://www.habbo.es/api/public/users?name={usuario}',
    profileUrl: u => `https://www.habbo.es/profile/${enc(u)}`, valid: /^[A-Za-z0-9_.,=?!@:;-]{3,15}$/,
    async check(u, ctx) {
      const r = await ctx.req(`https://www.habbo.es/api/public/users?name=${enc(u)}`, { headers: { Accept: 'application/json' } });
      if (r.status === 404) return NF();
      const j = r.json();
      if (r.status !== 200 || !j || !j.uniqueId) return UNK(httpReason(r));
      return OK({
        displayName: j.name, username: j.name, bio: j.motto, created: j.memberSince, lastActive: j.lastAccessTime,
        avatar: j.figureString ? `https://www.habbo.es/habbo-imaging/avatarimage?figure=${enc(j.figureString)}&size=l&headonly=1` : null,
        extra: { 'ID único': j.uniqueId, 'Perfil visible': j.profileVisible, 'Nivel': j.currentLevel, 'Estrellas': j.starGemCount, 'Insignias': (j.selectedBadges || []).map(b => b.name).join(', ') }
      });
    }
  },
  pageSource({
    id: 'vivino', name: 'Vivino', cat: 'Ocio', url: u => `https://www.vivino.com/users/${enc(u)}`, valid: /^[A-Za-z0-9_.-]{2,40}$/,
    nfText: /page not found|página no encontrada|doesn['’]t exist/i
  }),
  pageSource({ id: 'gitee', name: 'Gitee', cat: 'Desarrollo', url: u => `https://gitee.com/${enc(u)}`, valid: /^[A-Za-z0-9_-]{2,40}$/ })
];

/* =====================================================================
   FUENTES POR CORREO ELECTRÓNICO (solo métodos que no notifican al titular)
   ===================================================================== */
export const SOURCES_EMAIL = [
  {
    id: 'e-gravatar', name: 'Gravatar', cat: 'Perfil asociado', kind: 'api', reliability: 'alta', control: false,
    method: 'API v3 por hash SHA-256 del correo (el correo no viaja en claro) + comprobación de avatar',
    endpoint: 'https://api.gravatar.com/v3/profiles/{sha256(correo)}',
    async check(e, ctx) {
      const h = await U.sha256(e.trim().toLowerCase());
      const r = await ctx.req(`https://api.gravatar.com/v3/profiles/${h}`);
      if (r.status === 200) { const j = r.json(); if (j) return OK(Object.assign(gravatarProfile(j), { hashUsed: h })); }
      if (r.status !== 404) return UNK(httpReason(r));
      const a = await ctx.req(`https://gravatar.com/avatar/${h}?d=404&s=240`);
      if (a.status === 200) return OK({ avatar: `https://gravatar.com/avatar/${h}?s=240`, bio: 'Sin perfil público; el correo tiene avatar registrado en Gravatar.', extra: { 'Hash SHA-256': h } });
      return a.status === 404 ? NF() : UNK(httpReason(a));
    }
  },
  {
    id: 'e-duolingo', name: 'Duolingo', cat: 'Cuenta registrada', kind: 'api', reliability: 'alta',
    method: 'API pública de búsqueda de perfiles por correo (no envía avisos al titular)',
    endpoint: 'https://www.duolingo.com/2017-06-30/users?email={correo}',
    async check(e, ctx) {
      const r = await ctx.req(`https://www.duolingo.com/2017-06-30/users?email=${enc(e)}`);
      const j = r.json();
      if (r.status !== 200 || !j) return UNK(httpReason(r));
      const us = (j.users || []).find(x => x && x.id && x.username);
      if (!us) return NF();
      return OK(duolingoProfile(us));
    }
  },
  {
    id: 'e-github-commits', name: 'GitHub · commits', cat: 'Actividad pública', kind: 'api', reliability: 'alta', control: false,
    method: 'Búsqueda pública de commits por correo de autor (10 consultas/minuto sin autenticar)',
    endpoint: 'https://api.github.com/search/commits?q=author-email:{correo}',
    async check(e, ctx) {
      const r = await ctx.req(`https://api.github.com/search/commits?q=author-email:${enc(e)}&per_page=30&sort=author-date&order=desc`, { headers: { Accept: 'application/vnd.github+json' } });
      const j = r.json();
      if (r.status !== 200 || !j) return UNK(r.status === 403 || r.status === 429 ? 'Límite de búsqueda de GitHub alcanzado' : httpReason(r));
      if (j.incomplete_results && !j.total_count) return UNK('Búsqueda incompleta de la plataforma');
      if (!j.total_count) return NF('Sin commits públicos con ese correo');
      const items = (j.items || []).filter(i => String(i.commit?.author?.email || '').toLowerCase() === e.toLowerCase());
      if (!items.length) return UNK('Sin correo exacto en la muestra de commits');
      const logins = [...new Set(items.map(i => i.author && i.author.login).filter(Boolean))];
      const names = [...new Set(items.map(i => i.commit && i.commit.author && i.commit.author.name).filter(Boolean))];
      const repos = [...new Set(items.map(i => i.repository && i.repository.full_name).filter(Boolean))];
      const dates = items.map(i => i.commit && i.commit.author && i.commit.author.date).filter(Boolean).sort();
      return OK({
        displayName: names.join(' / '), username: logins.join(', '), avatar: items.find(i => i.author) ? items.find(i => i.author).author.avatar_url : null,
        url: logins[0] ? `https://github.com/${logins[0]}` : null,
        posts: j.total_count, postsLabel: 'commits', created: dates[0], lastActive: dates[dates.length - 1],
        handles: logins.map(l => ({ platform: 'GitHub', handle: l })),
        extra: { 'Nombres de autor': names.join(' | '), 'Repositorios (muestra)': repos.slice(0, 12).join(', ') }
      });
    }
  },
  {
    id: 'e-github-users', name: 'GitHub · correo público', cat: 'Perfil asociado', kind: 'api', reliability: 'alta', control: false,
    method: 'Búsqueda pública de usuarios con ese correo publicado en su perfil',
    endpoint: 'https://api.github.com/search/users?q={correo}+in:email',
    async check(e, ctx) {
      const r = await ctx.req(`https://api.github.com/search/users?q=${enc(e)}+in:email`, { headers: { Accept: 'application/vnd.github+json' } });
      const j = r.json();
      if (r.status !== 200 || !j) return UNK(r.status === 403 || r.status === 429 ? 'Límite de búsqueda de GitHub alcanzado' : httpReason(r));
      if (j.incomplete_results && !j.total_count) return UNK('Búsqueda incompleta de la plataforma');
      if (!j.total_count) return NF();
      const it = [];
      for (const candidate of (j.items || []).slice(0, 5)) {
        const detail = await ctx.req(`https://api.github.com/users/${enc(candidate.login)}`);
        const profile = detail.json();
        if (detail.status === 200 && String(profile?.email || '').toLowerCase() === e.toLowerCase()) it.push(profile);
      }
      if (!it.length) return UNK('Candidatos sin correo público exacto verificable');
      return OK({ emails: [e], username: it.map(i => i.login).join(', '), avatar: it[0] && it[0].avatar_url, url: it[0] && it[0].html_url, handles: it.map(i => ({ platform: 'GitHub', handle: i.login })), extra: { 'Cuentas': it.map(i => `${i.login} (ID ${i.id})`).join(', ') } });
    }
  },
  {
    id: 'e-gitlab', name: 'GitLab · correo público', cat: 'Perfil asociado', kind: 'api', reliability: 'alta', control: false,
    method: 'API pública de GitLab: usuarios con ese correo publicado en su perfil',
    endpoint: 'https://gitlab.com/api/v4/users?search={correo}',
    async check(e, ctx) {
      const r = await ctx.req(`https://gitlab.com/api/v4/users?search=${enc(e)}`);
      const arr = r.json();
      if (r.status !== 200 || !Array.isArray(arr)) return UNK(httpReason(r));
      if (!arr.length) return NF();
      const matches = [];
      for (const candidate of arr.slice(0, 5)) {
        const detail = await ctx.req(`https://gitlab.com/api/v4/users/${candidate.id}`);
        const profile = detail.json();
        if (detail.status === 200 && String(profile?.public_email || '').toLowerCase() === e.toLowerCase()) matches.push(profile);
      }
      if (!matches.length) return UNK('Búsqueda sin correo público exacto verificable');
      const b = matches[0];
      return OK({ emails: [e], displayName: b.name, username: b.username, avatar: b.avatar_url, url: b.web_url, handles: matches.map(x => ({ platform: 'GitLab', handle: x.username })), extra: { 'ID numérico': b.id, 'Estado': b.state } });
    }
  },
  {
    id: 'e-pgp', name: 'Claves PGP públicas', cat: 'Perfil asociado', kind: 'api', reliability: 'alta', control: false,
    method: 'Servidor público de claves OpenPGP (keyserver.ubuntu.com): identidades y fechas de las claves',
    endpoint: 'https://keyserver.ubuntu.com/pks/lookup?op=index&options=mr&exact=on&search={correo}',
    async check(e, ctx) {
      const r = await ctx.req(`https://keyserver.ubuntu.com/pks/lookup?op=index&options=mr&exact=on&search=${enc(e)}`);
      if (r.status === 404) return NF();
      if (r.status !== 200 || !/^pub:/m.test(r.text || '')) return r.status === 200 ? NF() : UNK(httpReason(r));
      const pubs = [...r.text.matchAll(/^pub:([^:]*):[^:]*:[^:]*:(\d*):(\d*):([^:]*)/gm)].map(m => ({ id: m[1], created: +m[2] || null, flags: m[4] }));
      const uids = [...new Set([...r.text.matchAll(/^uid:([^:]*):/gm)].map(m => { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }))].filter(u => String((u.match(/<([^>]+)>/) || [])[1] || '').toLowerCase() === e.toLowerCase());
      if (!uids.length) return UNK('Sin UID con correo exacto');
      const names = [...new Set(uids.map(u => u.replace(/<[^>]*>/, '').replace(/\(.*?\)/, '').trim()).filter(Boolean))];
      const created = pubs.map(p => p.created).filter(Boolean).sort((a, b) => a - b);
      return OK({
        displayName: names.join(' / '), created: created[0], url: `https://keyserver.ubuntu.com/pks/lookup?op=index&search=${enc(e)}`,
        emails: uids.map(u => (u.match(/<([^>]+)>/) || [])[1]).filter(Boolean),
        extra: { 'Claves': pubs.map(p => p.id.slice(-16) + (p.flags.includes('r') ? ' (revocada)' : '')).join(', '), 'Identidades (UID)': uids.join(' | ') }
      });
    }
  },
  existsSource({
    id: 'e-proton', name: 'Proton Mail', reliability: 'alta', site: 'https://proton.me',
    method: 'Directorio público de claves de Proton: existencia del buzón y fecha de creación de su clave',
    endpoint: 'https://api.protonmail.ch/pks/lookup?op=index&search={correo}',
    async probe(e, ctx) {
      const r = await ctx.req(`https://api.protonmail.ch/pks/lookup?op=index&search=${enc(e)}`);
      const t = r.text || '';
      if (/info:1:0/.test(t) || r.status === 404) return false;
      if (/info:1:[1-9]/.test(t)) {
        const ts = (t.match(/^pub:[^:]*:\d*:\d*:(\d+)/m) || [])[1];
        return { exists: true, created: ts ? +ts : null, extra: { 'Creación de la clave': ts ? U.utc(+ts * 1000) : null } };
      }
      return httpReason(r);
    }
  }),
  existsSource({
    id: 'e-spotify', name: 'Spotify', site: 'https://open.spotify.com',
    method: 'Validación pública de correo del formulario de alta (no envía avisos)',
    endpoint: 'https://spclient.wg.spotify.com/signup/public/v1/account?validate=1&email={correo}',
    async probe(e, ctx) {
      const r = await ctx.req(`https://spclient.wg.spotify.com/signup/public/v1/account?validate=1&email=${enc(e)}`);
      const j = r.json();
      if (j && j.status === 20) return true;
      if (j && j.status === 1) return false;
      return httpReason(r);
    }
  }),
  existsSource({
    id: 'e-firefox', name: 'Cuenta Mozilla / Firefox', reliability: 'alta', site: 'https://accounts.firefox.com',
    method: 'API pública de estado de cuenta de Mozilla (no envía avisos)',
    endpoint: 'POST https://api.accounts.firefox.com/v1/account/status',
    async probe(e, ctx) {
      const r = await ctx.req('https://api.accounts.firefox.com/v1/account/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e }) });
      const j = r.json();
      if (j && j.exists === true) return true;
      if (j && j.exists === false) return false;
      return httpReason(r);
    }
  }),
  existsSource({
    id: 'e-wordpress', name: 'WordPress.com', site: 'https://wordpress.com',
    method: 'Opciones de autenticación públicas de WordPress.com (solo consulta, no envía avisos)',
    endpoint: 'https://public-api.wordpress.com/rest/v1.1/users/{correo}/auth-options',
    async probe(e, ctx) {
      const r = await ctx.req(`https://public-api.wordpress.com/rest/v1.1/users/${enc(e)}/auth-options`);
      const j = r.json();
      if (r.status === 404 || (j && j.error === 'unknown_user')) return false;
      if (r.status === 200 && j && ('passwordless' in j || 'email_verified' in j)) return { exists: true, extra: { 'Correo verificado': j.email_verified, 'Sin contraseña': j.passwordless } };
      return httpReason(r);
    }
  }),
  existsSource({
    id: 'e-pinterest', name: 'Pinterest', site: 'https://www.pinterest.com',
    method: 'Recurso público EmailExistsResource del alta de Pinterest (no envía avisos)',
    endpoint: 'https://www.pinterest.com/_ngjs/resource/EmailExistsResource/get/',
    async probe(e, ctx) {
      const data = enc(JSON.stringify({ options: { email: e }, context: {} }));
      const r = await ctx.req(`https://www.pinterest.com/_ngjs/resource/EmailExistsResource/get/?source_url=%2F&data=${data}`, { headers: { Accept: 'application/json' } });
      const d = ((r.json() || {}).resource_response || {}).data;
      if (d === true) return true;
      if (d === false) return false;
      return httpReason(r);
    }
  }),
  existsSource({
    id: 'e-x', name: 'X / Twitter', site: 'https://x.com',
    method: 'Comprobación pública de disponibilidad de correo del alta de X (no envía avisos)',
    endpoint: 'https://api.x.com/i/users/email_available.json?email={correo}',
    async probe(e, ctx) {
      const r = await ctx.req(`https://api.x.com/i/users/email_available.json?email=${enc(e)}`);
      const j = r.json();
      if (j && j.taken === true) return true;
      if (j && j.taken === false) return false;
      return httpReason(r);
    }
  }),
  existsSource({
    id: 'e-vsco', name: 'VSCO', site: 'https://vsco.co',
    method: 'API pública de estado de correo de VSCO con el token de su web (no envía avisos)',
    endpoint: 'https://api.vsco.co/2.0/users/email?email={correo}',
    async probe() { return 'Adaptador pendiente de validación'; }
  }),
  existsSource({
    id: 'e-m365', name: 'Microsoft 365 (buzón corporativo)', site: 'https://outlook.office365.com',
    method: 'Autodescubrimiento público de Exchange Online: existencia del buzón (no envía avisos)',
    endpoint: 'https://outlook.office365.com/autodiscover/autodiscover.json/v1.0/{correo}?Protocol=Autodiscoverv1',
    async probe(e, ctx) {
      const r = await ctx.req(`https://outlook.office365.com/autodiscover/autodiscover.json/v1.0/${enc(e)}?Protocol=Autodiscoverv1`, { redirect: 'manual', headers: { Accept: 'application/json' } });
      if (r.status === 200 && /"Url"\s*:/i.test(r.text || '')) return true;
      if (r.status === 0 || (r.status >= 300 && r.status < 400) || r.status === 404) return false;
      return httpReason(r);
    }
  }),
  {
    id: 'e-domain', name: 'Dominio del correo', cat: 'Infraestructura', kind: 'dns', reliability: 'alta', info: true, control: false,
    method: 'DNS-over-HTTPS (Google Public DNS): solo se envía el dominio, no el correo',
    endpoint: 'https://dns.google/resolve?name={dominio}&type=MX',
    async check(e, ctx) {
      const dom = e.split('@')[1].toLowerCase();
      const r = await ctx.req(`https://dns.google/resolve?name=${enc(dom)}&type=MX`);
      const j = r.json();
      if (r.status !== 200 || !j) return UNK(httpReason(r));
      if (j.Status === 3) return { status: 'info', profile: { displayName: dom, bio: 'El dominio NO existe (NXDOMAIN): el correo no puede recibir mensajes.', extra: { 'Desechable': U.DISPOSABLE.has(dom) ? 'Sí' : 'No consta' } } };
      if (j.Status !== 0) return UNK(`Consulta DNS no concluyente (RCODE ${j.Status})`);
      if ((j.Answer || []).some(a => a.type === 15 && /^0\s+\.$/.test(a.data))) return {status:'info',profile:{displayName:dom,bio:'El dominio declara que no acepta correo (Null MX). No identifica al titular.'}};
      const mx = (j.Answer || []).filter(a => a.type === 15).map(a => a.data.split(' ').pop().replace(/\.$/, '').toLowerCase());
      let provider = 'Servidor propio o no identificado';
      for (const [re, name] of U.MX_PROVIDERS) if (mx.some(m => re.test(m))) { provider = name; break; }
      const disposable = U.DISPOSABLE.has(dom);
      return {
        status: 'info',
        profile: {
          displayName: dom,
          bio: disposable ? '⚠ Dominio de correo DESECHABLE/temporal conocido.' : (mx.length ? `Recibe correo a través de: ${provider}` : 'No se han obtenido registros MX; esto no verifica un buzón ni descarta rutas de entrega alternativas.'),
          extra: { 'Registros MX': mx.join(', '), 'Proveedor': provider, 'Desechable': disposable ? 'Sí' : 'No consta en la lista interna' }
        }
      };
    }
  }
];

/* =====================================================================
   PIVOTES MANUALES (enlaces que solo se abren si el investigador los pulsa)
   ===================================================================== */
export const MANUAL_PIVOTS = {
  username: [
    ['Google (literal)', u => `https://www.google.com/search?q=%22${enc(u)}%22`],
    ['Bing (literal)', u => `https://www.bing.com/search?q=%22${enc(u)}%22`],
    ['DuckDuckGo (literal)', u => `https://duckduckgo.com/?q=%22${enc(u)}%22`],
    ['X / Twitter', u => `https://x.com/${enc(u)}`],
    ['Facebook', u => `https://www.facebook.com/${enc(u)}`],
    ['Facebook: buscar personas (requiere sesión)', u => `https://www.facebook.com/search/people/?q=${enc(u)}`],
    ['X: menciones del alias', u => `https://x.com/search?q=${enc('"@'+u+'" OR from:'+u)}&f=live`],
    ['Threads', u => `https://www.threads.net/@${enc(u)}`],
    ['LinkedIn (/in/)', u => `https://www.linkedin.com/in/${enc(u)}`],
    ['Pinterest', u => `https://www.pinterest.com/${enc(u)}/`],
    ['OnlyFans', u => `https://onlyfans.com/${enc(u)}`],
    ['Telegram (TGStat)', u => `https://tgstat.com/search?q=${enc(u)}`],
    ['WhatsMyName', u => `https://whatsmyname.app/?q=${enc(u)}`],
    ['Wayback Machine (X)', u => `https://web.archive.org/web/*/twitter.com/${enc(u)}*`],
    ['Wayback Machine (Instagram)', u => `https://web.archive.org/web/*/instagram.com/${enc(u)}*`],
    ['Google: sitio Forocoches', u => `https://www.google.com/search?q=site%3Aforocoches.com+%22${enc(u)}%22`],
    ['Forocoches (perfil)', u => `https://forocoches.com/foro/member.php?username=${enc(u)}`],
    ['Burbuja.info vía Google', u => `https://www.google.com/search?q=site%3Aburbuja.info+%22${enc(u)}%22`],
    ['Google: Wallapop / Milanuncios / Vinted', u => `https://www.google.com/search?q=%22${enc(u)}%22+(site%3Awallapop.com+OR+site%3Amilanuncios.com+OR+site%3Avinted.es)`]
  ],
  email: [
    ['DuckDuckGo (correo exacto)', e => `https://duckduckgo.com/?q=${enc('"'+e+'"')}`],
    ['Google: documentos PDF', e => `https://www.google.com/search?q=${enc('"'+e+'" filetype:pdf')}`],
    ['Google: documentos Word', e => `https://www.google.com/search?q=${enc('"'+e+'" (filetype:doc OR filetype:docx)')}`],
    ['Google: repositorios públicos', e => `https://www.google.com/search?q=${enc('"'+e+'" (site:github.com OR site:gitlab.com OR site:codeberg.org)')}`],
    ['Google: redes sociales', e => `https://www.google.com/search?q=${enc('"'+e+'" (site:linkedin.com OR site:facebook.com OR site:instagram.com)')}`],
    ['Have I Been Pwned', e => `https://haveibeenpwned.com/account/${enc(e)}`],
    ['Epieos', e => `https://epieos.com/?q=${enc(e)}&t=email`],
    ['Google Calendar público del correo', e => `https://calendar.google.com/calendar/u/0/embed?src=${enc(e)}`],
    ['Facebook: buscar el correo (requiere sesión)', e => `https://www.facebook.com/search/top/?q=${enc(e)}`],
    ['X: posts que mencionan el correo', e => `https://x.com/search?q=${enc('"'+e+'"')}&f=live`],
    ['Google: el correo en X y Facebook', e => `https://www.google.com/search?q=${enc('"'+e+'" (site:x.com OR site:twitter.com OR site:facebook.com)')}`],
    ['Intelligence X', e => `https://intelx.io/?s=${enc(e)}`],
    ['DeHashed', e => `https://dehashed.com/search?query=${enc(e)}`],
    ['Hunter (verificador)', e => `https://hunter.io/email-verifier/${enc(e)}`],
    ['Google (literal)', e => `https://www.google.com/search?q=%22${enc(e)}%22`],
    ['Bing (literal)', e => `https://www.bing.com/search?q=%22${enc(e)}%22`],
    ['GitHub (búsqueda de código)', e => `https://github.com/search?q=%22${enc(e)}%22&type=code`],
    ['Pastebin vía Google', e => `https://www.google.com/search?q=site%3Apastebin.com+%22${enc(e)}%22`]
  ]
};

SOURCES_EMAIL.push({
  id:'e-npm',name:'npm · correo de mantenedor',cat:'Actividad pública',kind:'api',control:false,reliability:'media',
  method:'Búsqueda pública en npm y coincidencia exacta del correo en mantenedores de paquetes',endpoint:'https://registry.npmjs.org/-/v1/search?text={correo}',
  async check(email,ctx) {
    const r=await ctx.req(`https://registry.npmjs.org/-/v1/search?text=${enc('"'+email+'"')}&size=50`);
    const j=r.json();if(r.status!==200||!Array.isArray(j?.objects))return UNK(httpReason(r));
    const hits=j.objects.filter(x=>(x.package?.maintainers||[]).some(m=>String(m.email||'').toLowerCase()===email.toLowerCase()));
    if(!hits.length)return UNK('Sin correo exacto en la muestra indexada de npm; no descarta otros paquetes');
    const names=[...new Set(hits.flatMap(x=>x.package.maintainers.filter(m=>String(m.email||'').toLowerCase()===email.toLowerCase()).map(m=>m.username)).filter(Boolean))];
    return {status:'found',profile:{username:names.join(', '),bio:'Correo autodeclarado en mantenedores de paquetes públicos; requiere contraste.',
      links:hits.map(x=>U.safeUrl(x.package.links?.npm)).filter(Boolean),extra:{'Paquetes':hits.map(x=>x.package.name).join(', '),'Cobertura':'Muestra de hasta 50 resultados indexados','Alias de mantenedor':names.join(', ')}}};
  }
});
SOURCES_EMAIL.unshift(GOOGLE_SOURCE);
installEmailChecks(SOURCES_EMAIL);
