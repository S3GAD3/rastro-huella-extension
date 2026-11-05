/* Correo: evidencia explícita, cobertura acotada y separación entre indicio y perfil. */
import * as U from './util.js';
const same = (a,b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const unknown = reason => ({status:'unknown',reason});
export function emailBudget(settings = {}) {
  return Math.min(30, Math.max(5, Number(settings.emailLimit) || 10));
}
function proof(r, detail) { return {url:r.url, status:r.status, ts:r.ts, sha256:r.sha256, detail}; }
export async function searchPublicEmail(provider, email, ctx) {
  const limit=emailBudget(ctx.settings), size=5, matches=[], evidence=[], seen=new Set();
  let checked=0, complete=false, issue='', pages=0;
  const github=provider==='github';
  for(let page=1; checked<limit && page<=Math.ceil(limit/size); page++) {
    const url=github
      ? `https://api.github.com/search/users?q=${encodeURIComponent('"'+email+'" in:email')}&per_page=${size}&page=${page}`
      : `https://gitlab.com/api/v4/users?search=${encodeURIComponent(email)}&per_page=${size}&page=${page}`;
    let r,j;
    try {r=await ctx.req(url);j=r.json();} catch(e) {issue='Petición interrumpida: '+(e.message || e);break;}
    if(r.status!==200 || (github?!Array.isArray(j?.items):!Array.isArray(j))) {issue=`Respuesta no válida (HTTP ${r.status})`;break;}
    pages++;
    const items=github?j.items:j;
    if(github && j.incomplete_results) issue='El buscador comunica resultados incompletos';
    for(const c of items) {
      if(checked>=limit) break;
      const key=github?c.login:c.id;
      if(!key || seen.has(key)) continue;
      seen.add(key);checked++;
      try {
        const detail=await ctx.req(github?`https://api.github.com/users/${encodeURIComponent(key)}`:`https://gitlab.com/api/v4/users/${encodeURIComponent(key)}`);
        const p=detail.json();
        if(detail.status!==200 || !p) {issue='Algunas fichas no se pudieron comprobar';continue;}
        if(same(github?p.email:p.public_email,email)) {
          matches.push(p);evidence.push(proof(detail,'Campo de correo público coincide exactamente'));
        }
      } catch(e) {issue='Comprobación parcial: '+(e.message || e);break;}
    }
    if(items.length<size || (github && page*size>=j.total_count)) {complete=!issue;break;}
  }
  const coverage={checked,pages,limit,complete,reason:issue || (complete?'Final de resultados accesibles':'Límite de candidatos alcanzado')};
  if(!matches.length) return {...unknown(checked?'Sin correo público exacto verificable; no descarta cuentas con correo privado':issue || 'Sin perfiles públicos devueltos; no acredita ausencia de cuenta'),coverage};
  const first=matches[0];
  return {status:'found',evidenceType:'Correo público exacto',basis:'El campo de correo público de la ficha coincide con el consultado. No acredita identidad civil.',coverage,proofs:evidence,
    profile:{emails:[email],displayName:first.name,username:matches.map(p=>github?p.login:p.username).join(', '),avatar:first.avatar_url,url:github?first.html_url:first.web_url,
      handles:matches.map(p=>({platform:github?'GitHub':'GitLab',handle:github?p.login:p.username})),
      extra:{'Perfiles contrastados':matches.map(p=>github?p.html_url:p.web_url).join(' | '),'Cobertura':`${checked} candidatos; ${coverage.reason}`}}};
}
export function installEmailChecks(sources) {
  for(const s of sources) {
    if(s.id==='e-github-users' || s.id==='e-gitlab') {
      s.check=(email,ctx)=>searchPublicEmail(s.id==='e-gitlab'?'gitlab':'github',email,ctx);continue;
    }
    if(s.id==='e-google') continue; // fundamento propio en google.js
    if(s.id==='e-vsco') { s.check=async()=>unknown('Adaptador pendiente de validación: el token fijo anterior no garantiza una respuesta fiable'); continue; }
    if(s.id==='e-m365') {
      s.control=false;s.kind='infrastructure';s.cat='Infraestructura';
      s.method='Autodescubrimiento: solo información de servicio, no confirma un buzón';
      s.check=async(email,ctx)=>{
        const r=await ctx.req(`https://outlook.office365.com/autodiscover/autodiscover.json/v1.0/${encodeURIComponent(email)}?Protocol=Autodiscoverv1`,{redirect:'manual'});
        const j=r.json();
        return r.status===200 && U.safeUrl(j?.Url)
          ? {status:'info',evidenceType:'Infraestructura',basis:'Autodescubrimiento no demuestra que exista el buzón.',profile:{displayName:email.split('@')[1],bio:'El servicio devuelve configuración de autodescubrimiento.',extra:{'Servicio':j.Url}}}
          : unknown('Autodescubrimiento no concluyente; no permite afirmar existencia o ausencia del buzón');
      };continue;
    }
    const original=s.check;
    s.check=async(email,ctx)=>{
      // Cada respuesta HTTP debe ser coherente antes de interpretar booleanos de existencia.
      const strict=Object.create(ctx);
      strict.req=async(...args)=>{
        const r=await ctx.req(...args);
        if([401,403,429].includes(r.status)||r.status>=500) throw new Error(`HTTP ${r.status}: respuesta no interpretable`);
        return r;
      };
      const r=await original(email,strict);
      if(r.status==='found') {
        if(s.kind==='existence') {
          r.evidenceType=s.id==='e-proton'?'Clave pública asociada':'Indicio de registro';
          r.basis='La respuesta del servicio sugiere una asociación. No identifica un perfil ni acredita titularidad.';
          r.profile.bio=r.basis;r.profile.existenceOnly=true;
        } else if(s.id==='e-github-commits'||s.id==='e-pgp'||s.id==='e-npm') {
          r.evidenceType='Mención pública autodeclarada';
          r.basis='El correo aparece en datos públicos autodeclarados. Puede ser ajeno, histórico o suplantado.';
        } else {
          r.evidenceType='Asociación devuelta por el servicio';r.basis='Respuesta asociada al correo consultado, pendiente de contraste de titularidad.';
        }
      }
      if(r.status==='info'){r.evidenceType='Infraestructura';r.basis='Describe el dominio, no confirma la existencia de este buzón.';}
      return r;
    };
  }
}
export function validateMention(email,url,excerpt) {
  if(!U.isEmail(email)) throw new Error('Introduce un correo válido');
  const safe=U.safeUrl(url);if(!safe) throw new Error('Introduce una URL HTTP o HTTPS válida');
  const text=String(excerpt || '').trim();
  if(text.length>12000) throw new Error('El fragmento supera 12.000 caracteres');
  const escaped=email.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if(!new RegExp('(^|[^a-z0-9._%+\u0027-])'+escaped+'($|[^a-z0-9._%+\u0027-])','i').test(text)) throw new Error('El fragmento debe contener el correo completo, sin coincidencias parciales');
  return {email,url:safe,excerpt:text};
}
