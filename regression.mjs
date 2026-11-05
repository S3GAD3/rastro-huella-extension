import test from 'node:test';
import assert from 'node:assert/strict';
import {isEmail} from '../extension/js/util.js';
import {parseInput,parseQuery,state,newSession,computeConfidence,runQuery,allSources} from '../extension/js/engine.js';
import {SOURCES_USER,SOURCES_EMAIL,tabParse} from '../extension/js/sources.js';
const response=(data,status=200,url='https://example.org')=>({status,json:()=>data,text:JSON.stringify(data),url});
test('Entrada y deduplicación',()=>{
 assert.equal(isEmail('a..b@example.org'),false);assert.equal(isEmail('a@-example.org'),false);
 assert.equal(isEmail('a+b@example.org'),true);
 assert.equal(parseQuery('mailto:a@example.org?subject=hola').value,'a@example.org');
 assert.equal(parseInput('@demo demo DEMO').length,1);
 assert.equal(parseQuery('https://instagram.com/reel/foo').type,'invalid');
});
test('HTML genérico, reto y alias parcial quedan indeterminados',async()=>{
 const s=SOURCES_USER.find(s=>s.id==='ngl');
 for(const title of ['Welcome','Just a moment','demouser2']) {
 const r=tabParse(s,{url:s.profileUrl('demouser'),title,html:`<title>${title}</title>`},'demouser');assert.equal(r.status,'unknown');
 }
 assert.equal(tabParse(s,{url:s.profileUrl('demouser'),title:'demouser | NGL',html:'<title>demouser | NGL</title>'},'demouser').status,'found');
 assert.equal((await s.check('demouser',{req:async()=>({status:200,url:s.profileUrl('demouser'),text:'<title>Welcome</title>'})})).status,'unknown');
});
test('GitLab no acepta primer alias aproximado',async()=>{
 const s=SOURCES_USER.find(s=>s.id==='gitlab');
 assert.equal((await s.check('demo',{req:async()=>response([{id:1,username:'demox'}])})).status,'unknown');
});
test('Correo GitHub requiere coincidencia pública exacta',async()=>{
 const s=SOURCES_EMAIL.find(s=>s.id==='e-github-users');
 for(const [email,status] of [['other@example.org','unknown'],['a@example.org','found']]) {
 const r=await s.check('a@example.org',{req:async url=>response(url.includes('/search/')?{total_count:1,items:[{login:'demo'}]}:{login:'demo',email})});assert.equal(r.status,status);
 }
});
test('Commits ajenos y búsquedas incompletas no producen positivos',async()=>{
 const s=SOURCES_EMAIL.find(s=>s.id==='e-github-commits');
 assert.equal((await s.check('a@example.org',{req:async()=>response({total_count:1,items:[{commit:{author:{email:'b@example.org'}}}]})})).status,'unknown');
 assert.equal((await s.check('a@example.org',{req:async()=>response({total_count:0,incomplete_results:true})})).status,'unknown');
});
test('Avatar, nombre de pila y ubicación no dan vínculo alto',()=>{
 state.session=newSession();
 const results=['a','b'].map(source=>({source,name:source,status:'found',query:'Q1',profile:{displayName:'Juan',location:'Madrid'},avatarHash:'1234567890abcdef',avatarSha256:'same'}));
 state.session.queries=[{id:'Q1',type:'username',value:'demo',results}];computeConfidence();
 assert.ok(results.every(r=>r.confidence==='media'));
 results.forEach(r=>{delete r.avatarHash;delete r.avatarSha256;});computeConfidence();assert.ok(results.every(r=>r.confidence==='baja'));
});
test('Controles inconclusos y positivos falsos se rechazan',async()=>{
 globalThis.chrome={storage:{local:{set:async()=>{}}}};
 const s=SOURCES_USER.find(s=>s.id==='github'),orig=s.check;
 state.settings={...state.settings,avatars:false,tab:false,disabled:allSources().filter(x=>x.id!==s.id).map(x=>x.id)};
 try {for(const [control,expected] of [['unknown','unknown'],['found','na'],['notfound','found']]){
 state.session=newSession();state.controller=new AbortController();
 s.check=async u=>u==='demo'?{status:'found',profile:{username:'demo'}}:{status:control};
 const q=await runQuery({type:'username',value:'demo'},'test');assert.equal(q.results[0].status,expected);
 }}finally{s.check=orig;}
});
import {createRequester} from '../extension/js/http.js';
test('HTTP 429 frena nuevas peticiones del mismo dominio',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;return new Response('limit',{status:429});};
 try{const req=createRequester({trace:[],timeout:1000,signal:new AbortController().signal})('test','Q1');
 assert.equal((await req.req('https://example.org/a')).status,429);
 await assert.rejects(req.req('https://example.org/b'),/429/);assert.equal(calls,1);
 }finally{globalThis.fetch=original;}
});
test('Trazabilidad mide bytes UTF-8 y respeta cancelación previa',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response('á');const trace=[];
 try{const controller=new AbortController();const req=createRequester({trace,timeout:1000,signal:controller.signal})('test','Q1');
 await req.req('https://example.org');assert.equal(trace[0].bytes,2);
 controller.abort();await assert.rejects(req.req('https://example.org'));
 }finally{globalThis.fetch=original;}
});
test('El control negativo en pestaña distingue el 404 del bloqueo',()=>{
 const s=SOURCES_USER.find(s=>s.id==='ngl');
 assert.equal(tabParse(s,{url:s.profileUrl('demo'),title:'404 Not Found',html:''},'demo').status,'notfound');
 assert.equal(tabParse(s,{url:s.profileUrl('demo'),title:'404 Not Found',html:'',challenge:true},'demo').status,'unknown');
});
import {searchPublicEmail,validateMention,emailBudget} from '../extension/js/email.js';
test('Paginación encuentra coincidencia después de cinco candidatos',async()=>{
 const calls=[];const r=await searchPublicEmail('github','a@example.org',{settings:{emailLimit:10},req:async url=>{
 calls.push(url);const u=new URL(url);
 if(u.pathname==='/search/users')return response({total_count:6,items:u.searchParams.get('page')==='1'?Array.from({length:5},(_,i)=>({login:'u'+i})):[{login:'target'}]},200,url);
 return response({login:u.pathname.split('/').pop(),email:url.endsWith('/target')?'a@example.org':null,html_url:'https://github.com/target'},200,url);
 }});
 assert.equal(r.status,'found');assert.equal(r.coverage.checked,6);assert.equal(r.coverage.complete,true);assert.equal(r.proofs.length,1);assert.ok(calls.some(x=>x.includes('page=2')));
});
test('Límite e interrupciones conservan positivos y señalan cobertura parcial',async()=>{
 const r=await searchPublicEmail('github','a@example.org',{settings:{emailLimit:5},req:async url=>response(url.includes('/search/')?{total_count:100,items:Array.from({length:5},(_,i)=>({login:'u'+i}))}:{login:'u0',email:'a@example.org'},200,url)});
 assert.equal(r.status,'found');assert.equal(r.coverage.complete,false);assert.equal(r.coverage.checked,5);
 assert.equal(emailBudget({emailLimit:999}),30);
});
test('GitLab comprueba correo exacto y conserva evidencia',async()=>{
 const r=await searchPublicEmail('gitlab','a@example.org',{req:async url=>response(url.includes('?')?[{id:1}]:{username:'demo',public_email:'a@example.org',web_url:'https://gitlab.com/demo'},200,url)});
 assert.equal(r.status,'found');assert.equal(r.evidenceType,'Correo público exacto');assert.equal(r.proofs[0].url,'https://gitlab.com/api/v4/users/1');
});
test('Microsoft 365 nunca confirma buzón por autodescubrimiento',async()=>{
 const s=SOURCES_EMAIL.find(s=>s.id==='e-m365');
 assert.equal((await s.check('a@example.org',{req:async()=>response({Url:'https://outlook.office365.com/service'})})).status,'info');
 assert.equal((await s.check('a@example.org',{req:async()=>response({},404)})).status,'unknown');
});
test('Registro bloqueado no se acepta aunque el JSON contenga true',async()=>{
 const s=SOURCES_EMAIL.find(s=>s.id==='e-firefox');
 await assert.rejects(s.check('a@example.org',{req:async()=>response({exists:true},403)}),/403/);
 const r=await s.check('a@example.org',{req:async()=>response({exists:true})});assert.equal(r.evidenceType,'Indicio de registro');
});
test('DNS SERVFAIL y Null MX se distinguen',async()=>{
 const s=SOURCES_EMAIL.find(s=>s.id==='e-domain');
 assert.equal((await s.check('a@example.org',{req:async()=>response({Status:2})})).status,'unknown');
 const r=await s.check('a@example.org',{req:async()=>response({Status:0,Answer:[{type:15,data:'0 .'}]})});assert.match(r.profile.bio,/Null MX/);assert.equal(r.status,'info');
});
test('Menciones manuales exigen correo exacto y URL válida',()=>{
 assert.equal(validateMention('a@example.org','https://example.org','Contacto: a@example.org').email,'a@example.org');
 assert.throws(()=>validateMention('a@example.org','javascript:alert(1)','a@example.org'));
 assert.throws(()=>validateMention('a@example.org','https://example.org','za@example.org'));
 assert.throws(()=>validateMention('a@example.org','https://example.org','a@example.org.es'));
});
test('Los datos DNS se mantienen en la ficha del motor',async()=>{
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({Status:0,Answer:[{type:15,data:'10 mail.example.org.'}]}),{status:200});
 state.session=newSession();state.controller=new AbortController();state.settings={...state.settings,avatars:false,disabled:allSources().filter(x=>x.id!=='e-domain').map(x=>x.id)};
 try{const q=await runQuery({type:'email',value:'a@example.org'},'test');assert.equal(q.results[0].status,'info');assert.ok(q.results[0].profile);assert.equal(q.results[0].pivots.length,0);}finally{globalThis.fetch=original;}
});
import {buildCsvEntities,buildCsvRelations,profileFields} from '../extension/js/report.js';
test('Exportaciones diferencian correo publicado y mención manual',()=>{
 state.session=newSession();state.session.queries=[{id:'Q1',type:'email',value:'a@example.org',results:[
 {source:'e-github-users',name:'GitHub',query:'Q1',status:'found',evidenceType:'Correo público exacto',basis:'Campo público exacto',profile:{url:'https://github.com/demo',emails:['a@example.org']}},
 {source:'manual-1',name:'Mención manual',query:'Q1',status:'info',manual:true,evidenceType:'Fragmento aportado manualmente',profile:{url:'https://example.org',bio:'Contacto a@example.org'}}]}];
 assert.match(buildCsvEntities(),/tipo_evidencia/);assert.match(buildCsvEntities(),/Contacto a@example.org/);
 assert.match(buildCsvRelations(),/publica_correo/);assert.doesNotMatch(buildCsvRelations(),/registrado_en/);
 assert.ok(profileFields({}, {evidenceType:'Infraestructura'}).some(([k,v])=>k==='Tipo de evidencia'&&v==='Infraestructura'));
});
import {providerRows,requestProvider,ENDPOINT} from '../extension/js/enrichment.js';
test('Proveedor: normaliza campos y distingue negativos sin confirmar identidad',()=>{
 const rows=providerRows([{module:'demo',spec_format:[{key:'username',value:'demo'},{key:'profile_url',value:'https://example.org/demo'}],data:{registered:true,email:'a@example.org',password:'secret'}},{module:'absent',data:{registered:false}}]);
 assert.equal(rows[0].profile.username,'demo');assert.equal(rows[0].profile.extra.password,undefined);assert.equal(rows[1].negative,true);
 assert.throws(()=>providerRows({error:'bad'}));assert.throws(()=>providerRows([null]));
 assert.equal(providerRows([{module:'badurl',data:{url:'javascript:alert(1)'}}])[0].profile.url,null);
});
test('Proveedor: POST explícito, sin premium ni reintentos, clave solo en cabecera',async()=>{
 let captured;const result=await requestProvider('a@example.org','test-key',{req:async(url,opts)=>{captured={url,...opts};return response([{module:'demo',data:{registered:true}}]);}});
 assert.equal(captured.url,ENDPOINT);assert.equal(captured.method,'POST');assert.equal(captured.noRetry,true);
 assert.equal(captured.headers['api-key'],'test-key');assert.ok(!captured.body.includes('test-key'));
 assert.equal(JSON.parse(captured.body).premium,false);assert.equal(result.rows.length,1);
});
test('Proveedor: créditos o clave inválida no producen resultados',async()=>{
 for(const code of [401,402,403,429,500])await assert.rejects(requestProvider('a@example.org','key',{req:async()=>response({},code)}));
});
test('npm exige correo exacto en mantenedores, no en el nombre del paquete',async()=>{
 const s=SOURCES_EMAIL.find(s=>s.id==='e-npm');
 const ctx=email=>({req:async()=>response({objects:[{package:{name:'demo',maintainers:[{username:'demo',email}],links:{npm:'https://www.npmjs.com/package/demo'}}}]})});
 assert.equal((await s.check('a@example.org',ctx('b@example.org'))).status,'unknown');
 const r=await s.check('a@example.org',ctx('a@example.org'));assert.equal(r.status,'found');assert.equal(r.evidenceType,'Mención pública autodeclarada');
});
test('Alias derivado no eleva confianza respecto al correo',()=>{
 state.session=newSession();state.session.queries=[{id:'Q1',type:'username',value:'demo',origin:'Alias derivado del correo',results:[{source:'github',name:'GitHub',query:'Q1',status:'found',profile:{username:'demo'}}]}];
 computeConfidence();assert.equal(state.session.queries[0].results[0].confidence,'baja');assert.match(state.session.queries[0].results[0].why[0],/hipótesis/);
});

/* ---------- 0.8.0: Google, Facebook, X, fotos y ZIP ---------- */
import {parseGooglePeople,googlePhotoHiRes,GOOGLE_SOURCE} from '../extension/js/google.js';
import {facebookParse,xTabParse} from '../extension/js/social.js';
import {zipStore,crc32} from '../extension/js/zip.js';
import {photoItems,activeSources} from '../extension/js/engine.js';
const GJ={people:{'111':{personId:'111',metadata:{bestDisplayName:{displayName:'Ana Pérez'},identityInfo:{sourceIds:[{container:'PROFILE',id:'111222333444555666777',lastUpdated:'2024-03-01T10:00:00.000Z'}]}},
 photo:[{url:'https://lh3.googleusercontent.com/a-/ABC=s100'}],coverPhoto:[{imageUrl:'https://lh3.googleusercontent.com/cover1'}],inAppReachability:[{appType:'BABEL',status:'REACHABLE'}]}},
 matches:[{lookupId:'ana@example.org',personId:['111']}]};
test('Google: nombre, foto grande, portada y GAIA ID',()=>{
 const p=parseGooglePeople(GJ,'ana@example.org');
 assert.equal(p.displayName,'Ana Pérez');assert.equal(p.avatar,'https://lh3.googleusercontent.com/a-/ABC=s512');
 assert.equal(p.banner,'https://lh3.googleusercontent.com/cover1');assert.equal(p.extra['GAIA ID'],'111222333444555666777');
 assert.match(p.url,/maps\/contrib\/111222333444555666777/);assert.deepEqual(p.emails,['ana@example.org']);
 assert.equal(parseGooglePeople({},'ana@example.org'),null);
 assert.equal(googlePhotoHiRes('https://lh3.googleusercontent.com/a-/X'),'https://lh3.googleusercontent.com/a-/X=s512');
});
test('Google: foto por defecto no se usa como avatar',()=>{
 const j=structuredClone(GJ);j.people['111'].photo[0].isDefault=true;
 const p=parseGooglePeople(j,'ana@example.org');assert.equal(p.avatar,null);assert.match(p.extra['Foto por defecto'],/^Sí/);
});
test('Google: sin sesión, rechazo y ausencia',async()=>{
 const run=res=>GOOGLE_SOURCE.check('ana@example.org',{bridge:async()=>res});
 assert.equal((await run({ok:false,error:'nosession'})).status,'unknown');
 assert.equal((await run({ok:true,status:403,json:()=>null})).status,'unknown');
 assert.equal((await run({ok:true,status:200,json:()=>({})})).status,'notfound');
 const r=await run({ok:true,status:200,json:()=>GJ});assert.equal(r.status,'found');assert.equal(r.profile.displayName,'Ana Pérez');
});
test('Google es opcional y está desactivado por defecto',()=>{
 const saved={...state.settings};
 try{state.settings={...state.settings,disabled:[],google:false};assert.ok(!activeSources('email').some(s=>s.id==='e-google'));
 state.settings.google=true;assert.ok(activeSources('email').some(s=>s.id==='e-google'));}finally{state.settings=saved;}
});
const FB=`<html><head><title>Ana Pérez | Facebook</title><meta property="og:title" content="Ana Pérez"><meta property="og:url" content="https://www.facebook.com/ana.perez.77"><meta property="og:image" content="https://scontent.xx.fbcdn.net/v/p.jpg"><meta property="og:description" content="Ana Pérez is on Facebook. Join Facebook to connect"><meta property="al:android:url" content="fb://profile/100012345678"></head></html>`;
test('Facebook: perfil, ID numérico y foto; alias distinto o muro quedan indeterminados',()=>{
 const r=facebookParse(FB,'https://www.facebook.com/ana.perez.77','ana.perez.77');
 assert.equal(r.status,'found');assert.equal(r.profile.displayName,'Ana Pérez');assert.equal(r.profile.extra['ID numérico'],'100012345678');
 assert.equal(r.profile.avatar,'https://scontent.xx.fbcdn.net/v/p.jpg');assert.equal(r.profile.bio,null);
 assert.equal(facebookParse(FB,'https://www.facebook.com/ana.perez.77','otra.persona').status,'unknown');
 assert.equal(facebookParse('<title>Facebook – log in or sign up</title>','https://www.facebook.com/login/?next=x','ana.perez.77').status,'unknown');
 assert.equal(facebookParse('<title>Facebook</title><div>This content isn\'t available right now</div>','https://www.facebook.com/zqabc','zqabcdef').status,'notfound');
});
test('Facebook en pestaña no exige el alias en el título',()=>{
 const s=SOURCES_USER.find(s=>s.id==='facebook');
 assert.equal(tabParse(s,{url:'https://www.facebook.com/ana.perez.77',title:'(3) Ana Pérez | Facebook',html:FB},'ana.perez.77').status,'found');
 assert.equal(tabParse(s,{url:'https://evil.example/ana.perez.77',title:'Ana Pérez | Facebook',html:FB},'ana.perez.77').status,'unknown');
});
const XH=`<a href="/demo_user/header_photo"><img src="https://pbs.twimg.com/profile_banners/123456789/1700000000/1500x500"></a><a href="/demo_user/photo"><img src="https://pbs.twimg.com/profile_images/1/av_normal.jpg"></a><div data-testid="UserDescription"><span>Hola mundo</span></div></div>`;
test('X en pestaña: nombre, foto 400x400, portada e ID; otro alias o inexistente',()=>{
 const s=SOURCES_USER.find(s=>s.id==='x');
 const r=tabParse(s,{url:'https://x.com/demo_user',title:'Demo User (@demo_user) / X',html:XH},'demo_user');
 assert.equal(r.status,'found');assert.equal(r.profile.displayName,'Demo User');
 assert.equal(r.profile.avatar,'https://pbs.twimg.com/profile_images/1/av_400x400.jpg');assert.equal(r.profile.extra['ID numérico (de la portada)'],'123456789');
 assert.equal(xTabParse({title:'Other (@other) / X',html:''},'demo_user').status,'unknown');
 assert.equal(tabParse(s,{url:'https://x.com/zqabc',title:'Profile / X',html:'<span>This account doesn’t exist</span>'},'zqabc').status,'notfound');
});
test('Fotos: avatares y portadas sin duplicados; ZIP válido',()=>{
 state.session=newSession();
 const a={source:'a',name:'A',status:'found',query:'Q1',profile:{avatar:'https://img.example/1.jpg',banner:'https://img.example/b.jpg'}};
 const b={source:'b',name:'B',status:'found',query:'Q1',profile:{avatar:'https://img.example/1.jpg'}};
 state.session.queries=[{id:'Q1',type:'username',value:'demo',results:[a,b,{source:'c',status:'notfound',query:'Q1'}]}];
 const items=photoItems();assert.equal(items.length,2);assert.deepEqual(items[0].alsoIn,['B (Q1)']);
 assert.equal(crc32(new TextEncoder().encode('123456789')),0xCBF43926);
 const z=zipStore([{name:'a.txt',bytes:'hola'}]);
 assert.equal(new DataView(z.buffer).getUint32(0,true),0x04034b50);assert.equal(new DataView(z.buffer).getUint32(z.length-22,true),0x06054b50);
});

/* ---------- 0.8.1: Instagram con comprobación de la página del perfil ---------- */
import {instagramPageParse} from '../extension/js/social.js';
const IGP=`<html><head><title>Instagram</title><meta property="og:title" content="Ana Pérez (@ana.perez) • Instagram photos and videos"><meta property="og:description" content="1,234 Followers, 56 Following, 78 Posts - See Instagram photos and videos from Ana Pérez (@ana.perez)"><meta property="og:image" content="https://scontent.cdninstagram.com/p.jpg"></head><body>"page_id":"profilePage_987654321"</body></html>`;
test('Instagram: si la API dice 404 pero la página muestra el perfil, se encuentra',async()=>{
 const s=SOURCES_USER.find(s=>s.id==='instagram');
 const ctx={req:async url=>url.includes('/api/')?{status:404,json:()=>null,text:'',url}:{status:200,text:IGP,url,json:()=>null}};
 const r=await s.check('ana.perez',ctx);
 assert.equal(r.status,'found');assert.equal(r.profile.displayName,'Ana Pérez');assert.equal(r.profile.extra['ID numérico'],'987654321');
 assert.equal(r.profile.extra['Seguidores (texto)'],'1,234');assert.equal(r.profile.avatar,'https://scontent.cdninstagram.com/p.jpg');
});
test('Instagram: user:null de la API no basta para «no encontrado»',async()=>{
 const s=SOURCES_USER.find(s=>s.id==='instagram');
 const shell={status:200,text:'<title>Instagram</title>',url:'https://www.instagram.com/ana.perez/',json:()=>null};
 assert.equal((await s.check('ana.perez',{req:async url=>url.includes('/api/')?{status:401,json:()=>({}),url}:shell})).status,'unknown');
 assert.equal((await s.check('zqabc',{req:async url=>url.includes('/api/')?{status:404,json:()=>null,url}:{status:404,text:'',url,json:()=>null}})).status,'notfound');
 assert.equal((await s.check('zqabc',{req:async url=>url.includes('/api/')?{status:429,json:()=>null,url}:{status:404,text:'',url,json:()=>null}})).status,'unknown');
 assert.equal(instagramPageParse(IGP,'https://www.instagram.com/ana.perez/','otra').status,'unknown');
});
test('Instagram en pestaña: título renderizado y página inexistente',()=>{
 const s=SOURCES_USER.find(s=>s.id==='instagram');
 assert.equal(tabParse(s,{url:'https://www.instagram.com/ana.perez/',title:'Ana Pérez (@ana.perez) • Instagram photos and videos',html:'<title>x</title>'},'ana.perez').status,'found');
 assert.equal(tabParse(s,{url:'https://www.instagram.com/zqabc/',title:'Page not found • Instagram',html:''},'zqabc').status,'notfound');
 assert.equal(tabParse(s,{url:'https://www.instagram.com/accounts/login/?next=x',title:'Login • Instagram',html:''},'ana.perez').status,'unknown');
});
