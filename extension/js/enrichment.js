/* Enriquecimiento opcional. La clave solo vive en el formulario; nunca en el estado. */
import * as U from './util.js';
export const ENDPOINT='https://api.osint.industries/v2/request';
const plain=v=>typeof v==='string'||typeof v==='number'||typeof v==='boolean'?String(v).slice(0,12000):'';
export function providerRows(payload) {
  if(!Array.isArray(payload)||payload.length>500||!payload.every(r=>r&&typeof r==='object'&&!Array.isArray(r))) throw new Error('Formato no reconocido: se espera una lista de módulos OSINT Industries (máximo 500).');
  return payload.map((row,index)=>{
    const fields=Object.create(null), put=(k,v)=>{ if(typeof k==='string'&&!['__proto__','constructor','prototype'].includes(k)) fields[k.trim().toLowerCase().replace(/[ -]/g,'_')]=v; };
    const spec=row.spec_format;
    if(Array.isArray(spec))spec.forEach(f=>{if(f&&typeof f==='object')put(f.key||f.id||f.name||f.proper_key,f.value);});
    else if(spec&&typeof spec==='object')Object.entries(spec).forEach(([k,v])=>put(k,v?.value));
    if(row.data&&typeof row.data==='object'&&!Array.isArray(row.data))Object.entries(row.data).forEach(([k,v])=>put(k,v&&typeof v==='object'&&'value' in v?v.value:v));
    const registered=fields.registered;
    const url=U.safeUrl(plain(fields.profile_url||fields.url));
    const label=plain(row.module||row.name)||`Módulo ${index+1}`;
    const negative=registered===false||registered==='false';
    return {name:label,negative,profile:{displayName:plain(fields.name||fields.full_name||fields.display_name),username:plain(fields.username),avatar:U.safeUrl(plain(fields.picture||fields.avatar||fields.avatar_url)),url,
      bio:plain(fields.bio||fields.description)||[plain(fields.name||fields.full_name||fields.display_name),plain(fields.username)&&('@'+plain(fields.username)),plain(fields.phone||fields.phone_number)].filter(Boolean).join(' · '),emails:U.isEmail(plain(fields.email))?[plain(fields.email)]:[],
      extra:Object.fromEntries(Object.entries(fields).filter(([k])=>!/(token|password|secret|cookie|api.?key)/i.test(k)).map(([k,v])=>[k,plain(v)||JSON.stringify(v)?.slice(0,12000)]))},
      reason:negative?'El proveedor declara ausencia; no verificado por RASTRO':'Resultado externo pendiente de contraste',raw:row};
  });
}
export async function requestProvider(email,key,ctx) {
  if(!U.isEmail(email))throw new Error('Introduce un correo válido');
  if(!key.trim())throw new Error('Introduce tu clave de OSINT Industries');
  const r=await ctx.req(ENDPOINT,{method:'POST',headers:{'Content-Type':'application/json','Accept':'application/json','api-key':key.trim()},body:JSON.stringify({type:'email',query:email,timeout:60,exact_match:true,premium:false,premium_modules_only:false}),noRetry:true});
  const errors={400:'Consulta rechazada',401:'Clave no válida',402:'Créditos insuficientes',403:'Acceso denegado',429:'Límite del proveedor alcanzado'};
  if(r.status!==200)throw new Error(errors[r.status]||`Error del proveedor HTTP ${r.status}`);
  return {rows:providerRows(r.json()),response:r};
}
