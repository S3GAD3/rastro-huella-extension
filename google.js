/* RASTRO · HUELLA — Google por correo (nombre, foto de perfil, portada, GAIA ID)
   La consulta NO sale de la consola de la extensión: el service worker abre photos.google.com
   en una pestaña de fondo y ejecuta allí la consulta a la People API interna con la sesión de
   Google de ese navegador (SAPISIDHASH). Por eso es opcional y requiere una cuenta de investigación.
   No notifica al titular. Google sí registra la consulta en la cuenta que tenga la sesión abierta. */
import * as U from './util.js';

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const UNK = reason => ({ status: 'unknown', reason });
export const GOOGLE_ENDPOINT = 'https://people-pa.clients6.google.com/v2/people/lookup';

/* Foto de googleusercontent a mayor tamaño (=s512). Otras URLs no se tocan. */
export function googlePhotoHiRes(url, size = 512) {
  const u = U.safeUrl(url);
  if (!u || !/googleusercontent\.com\//i.test(u)) return u;
  return /=[swh]\d+[^/]*$/i.test(u) ? u.replace(/=[swh]\d+[^/]*$/i, `=s${size}`) : `${u}=s${size}`;
}

const first = v => (Array.isArray(v) ? v[0] : v) || null;

/* Respuesta de people/lookup → perfil normalizado (null si no hay cuenta) */
export function parseGooglePeople(j, email) {
  const people = j && j.people && typeof j.people === 'object' ? Object.values(j.people) : [];
  if (!people.length) return null;
  const match = (j.matches || []).find(m => same(m.lookupId, email));
  const pid = match && first(match.personId);
  const p = people.find(x => x && x.personId === pid) || people[0];
  if (!p) return null;
  const meta = p.metadata || {};
  const name = (meta.bestDisplayName && meta.bestDisplayName.displayName) || (first(p.name) || {}).displayName || null;
  const photo = first(p.photo) || {};
  const cover = first(p.coverPhoto) || {};
  const photoUrl = U.safeUrl(photo.url);
  const defaultPhoto = !!(photo.isDefault || photo.isMonogram || photo.monogram);
  const coverUrl = U.safeUrl((cover.imageUrl || cover.url));
  const ids = (meta.identityInfo && meta.identityInfo.sourceIds) || [];
  const profileSrc = ids.find(s => s && s.container === 'PROFILE') || ids[0] || {};
  const gaia = /^\d{10,30}$/.test(String(profileSrc.id || '')) ? String(profileSrc.id) : (/^\d{10,30}$/.test(String(p.personId || '')) ? String(p.personId) : null);
  const apps = (p.inAppReachability || []).filter(a => a && (!a.status || a.status === 'REACHABLE')).map(a => a.appType).filter(Boolean);
  const ext = p.extendedData || {};
  const dyn = ext.dynamiteData || {};
  const gplus = ext.gplusData || {};
  const maps = gaia ? `https://www.google.com/maps/contrib/${gaia}/reviews` : null;
  const photoHi = photoUrl ? googlePhotoHiRes(photoUrl) : null;
  return {
    displayName: name,
    emails: [email],
    avatar: photoUrl && !defaultPhoto ? photoHi : null,
    banner: coverUrl && !cover.isDefault ? coverUrl : null,
    lastActive: null,
    url: maps,
    links: maps ? [maps] : [],
    bio: [name ? `Nombre de la cuenta Google: ${name}` : 'Cuenta Google sin nombre visible',
      defaultPhoto ? 'foto por defecto (inicial)' : (photoUrl ? 'con foto de perfil' : 'sin foto')].join(' · '),
    extra: {
      'GAIA ID': gaia,
      'Última edición del perfil': profileSrc.lastUpdated ? U.date(profileSrc.lastUpdated) || profileSrc.lastUpdated : null,
      'Foto de perfil (tamaño grande)': photoHi,
      'Foto por defecto': photoUrl ? (defaultPhoto ? 'Sí (monograma, no es una foto real)' : 'No') : null,
      'Portada': coverUrl,
      'Google Maps (reseñas públicas)': maps,
      'Aplicaciones donde es localizable': apps.join(', '),
      'Tipo de entidad': dyn.entityType || meta.objectType || null,
      'Cuenta de empresa / Workspace': gplus.isEntrepriseUser === true ? 'Sí' : (gplus.isEntrepriseUser === false ? 'No' : null),
      'Tipos de usuario': Array.isArray(meta.ownerUserType) ? meta.ownerUserType.join(', ') : (meta.ownerUserType || null)
    }
  };
}

export const GOOGLE_SOURCE = {
  id: 'e-google', name: 'Google · cuenta', cat: 'Perfil asociado', kind: 'session', reliability: 'alta', control: false, google: true,
  method: 'People API interna de Google ejecutada en una pestaña de photos.google.com con la sesión de Google del navegador (usa una cuenta de investigación). Nombre, foto, portada y GAIA ID. No notifica al titular.',
  endpoint: GOOGLE_ENDPOINT + '?id={correo}&type=EMAIL',
  async check(email, ctx) {
    if (!ctx.bridge) return UNK('Esta comprobación solo funciona dentro de la extensión');
    const label = `${GOOGLE_ENDPOINT}?id=${encodeURIComponent(email)}&type=EMAIL`;
    const r = await ctx.bridge({ type: 'googleLookup', email }, label);
    if (r.error === 'nosession') return UNK('Sin sesión de Google en este navegador: inicia sesión en Google con la cuenta de investigación y repite');
    if (!r.ok) return UNK('No se pudo ejecutar en pestaña: ' + (r.error || 'error desconocido'));
    if (r.status === 401 || r.status === 403) return UNK(`Google rechazó la consulta (HTTP ${r.status}): sesión caducada, clave interna cambiada o bloqueo temporal`);
    if (r.status === 429) return UNK('Límite de peticiones de Google (HTTP 429): espera antes de repetir');
    if (r.status !== 200) return UNK(`Respuesta no concluyente de Google (HTTP ${r.status})`);
    const j = r.json();
    if (!j) return UNK('Respuesta de Google no interpretable');
    const profile = parseGooglePeople(j, email);
    if (!profile) return { status: 'notfound', reason: 'Google no devuelve ninguna cuenta para este correo; no descarta cuentas con visibilidad restringida' };
    return {
      status: 'found', profile,
      evidenceType: 'Cuenta Google asociada al correo',
      basis: 'Google resuelve el correo a una cuenta y devuelve el nombre y la foto que su titular configuró. El nombre lo elige el usuario: no acredita identidad civil.'
    };
  }
};
