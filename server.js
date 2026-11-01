const fs=require('fs'),express=require('express'),mysql=require('mysql2/promise'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),cookieParser=require('cookie-parser'),crypto=require('crypto'),path=require('path');
const E=process.env;let SECRET=E.JWT_SECRET;
const prod=E.NODE_ENV==='production',url=E.DATABASE_URL?new URL(E.DATABASE_URL):null;
const pool=mysql.createPool({host:url?url.hostname:E.DB_HOST||'localhost',port:+(url?url.port:E.DB_PORT)||3306,user:url?decodeURIComponent(url.username):E.DB_USER,password:url?decodeURIComponent(url.password):E.DB_PASSWORD,database:url?url.pathname.slice(1):E.DB_NAME,charset:'utf8mb4',waitForConnections:true,connectionLimit:10,ssl:E.DB_CA?{ca:E.DB_CA}:E.DB_SSL==='relaxed'?{rejectUnauthorized:false}:E.DB_SSL?{rejectUnauthorized:true}:undefined});
const q=async(sql,p)=>(await pool.query(sql,p))[0],one=async(sql,p)=>(await q(sql,p))[0];
const H=f=>(req,res,next)=>Promise.resolve(f(req,res,next)).catch(e=>{console.error(e);res.status(500).json({msg:'Error del servidor'})});
async function init(){
  await q("CREATE TABLE IF NOT EXISTS users(id INT AUTO_INCREMENT PRIMARY KEY,name VARCHAR(100) NOT NULL,usuario VARCHAR(40) NOT NULL UNIQUE,email VARCHAR(190) NOT NULL UNIQUE,hash VARCHAR(100) NOT NULL,cargo VARCHAR(40) NOT NULL,role VARCHAR(5) NOT NULL,estado VARCHAR(20) NOT NULL DEFAULT 'Pendiente',profile TEXT NULL,rcode VARCHAR(100) NULL,rexp BIGINT NULL) CHARACTER SET utf8mb4");
  try{await q('ALTER TABLE users ADD COLUMN perms TEXT NULL')}catch(e){if(e.code!=='ER_DUP_FIELDNAME')throw e}
  await q("CREATE TABLE IF NOT EXISTS settings(k VARCHAR(50) PRIMARY KEY,v LONGTEXT NOT NULL) CHARACTER SET utf8mb4");
  await q("CREATE TABLE IF NOT EXISTS kv(k VARCHAR(190) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PRIMARY KEY,v LONGTEXT NOT NULL) CHARACTER SET utf8mb4");
  await q("CREATE TABLE IF NOT EXISTS reports(id INT AUTO_INCREMENT PRIMARY KEY,name VARCHAR(100),cargo VARCHAR(40),`text` TEXT,`date` VARCHAR(20)) CHARACTER SET utf8mb4");
  if(!SECRET||SECRET.length<24){let k=(await getS('jwt'))||'';if(k.length<24){k=crypto.randomBytes(32).toString('hex');await setS('jwt',k)}SECRET=k}
}
const ROLES={'Docente':'doc','Administración':'adm','Personal de apoyo':'apo'};
const getS=async k=>(await one('SELECT v FROM settings WHERE k=?',[k]))?.v;
const setS=(k,v)=>q('INSERT INTO settings(k,v) VALUES(?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)',[k,v]);
/* ===== boletín (cálculo de notas) ===== */
const DEF=['Lengua Española','Inglés','Francés','Matemática','Ciencias Sociales','Ciencias de la Naturaleza','Educación Artística','Educación Física','Formación Integral Humana y Religiosa'];
const ok=x=>x!==''&&x!=null;
/* Calcula el boletín de un estudiante: PC1-PC4 por materia (promedio de las 4 competencias, o la nota por parcial) y calificación final */
function boletinData(s,N,C,A){
  const tec=s.ar?(((A&&A.tec)||{})[s.ar]||(A&&A.tec&&A.tec[s.ar]?A.tec[s.ar]:['Formación técnica ('+s.ar+')'])):[],ms=((A&&A.base)||DEF).concat(tec);
  const rows=ms.map(m=>{
    const c=((C||{})[s.id]||{})[m]||[],n=((N||{})[s.id]||{})[m]||[];
    const pc=[0,1,2,3].map(k=>{const v=[0,1,2,3].map(g=>c[g*4+k]).filter(ok);return v.length?Math.round(v.reduce((t,x)=>t+(+x),0)/v.length):(ok(n[k])?+n[k]:null)});
    return{n:m,pc,c:c.some(ok)?[...Array(16).keys()].map(i=>ok(c[i])?+c[i]:null):null,cf:pc.every(x=>x===null)?null:Math.round(pc.reduce((t,x)=>t+(x||0),0)/4)};
  });
  const done=rows.length>0&&rows.every(r=>r.cf!==null);
  return{rows,estado:done?(rows.every(r=>r.cf>=70)?'Promovido':'Repitente'):''};
}


/* ===== permisos ===== */
/* Permisos: el administrador puede todo; el docente solo lo que se le asigne */
const lab=s=>`${s.gr}.º ${s.ar?s.ar+' ':''}${s.sc}`;
const P=u=>{try{return JSON.parse(u.perms||'{}')}catch(e){return{}}};
const secOf=k=>k.split(':').slice(1).join(':').split('|')[0];
/* ¿puede este usuario leer (write=false) o escribir (write=true) esta clave de datos? */
function can(key,u,write){
  const r=u.role,p=P(u),mine=(p.secs||[]).includes(secOf(key));
  if(r==='adm')return /^(students|comunicados|periodos|asignaturas|(notas|comp|asist|meta):.+)$/.test(key);
  if(key==='comunicados'||key==='periodos')return !write;
  if(r!=='doc')return false;
  if(key==='asignaturas'||key==='students')return !write;
  if(/^(notas|comp|asist):/.test(key))return write?mine:(mine||!!p.docs);
  if(/^meta:/.test(key))return !write&&(mine||!!p.docs);
  return false}
/* Lista de estudiantes que le toca ver a cada usuario */
function studentsFor(u,list){
  if(u.role==='adm')return list;
  const p=P(u),full=!!(p.est||p.docs),secs=p.secs||[];
  return list.filter(s=>full||secs.includes(lab(s))).map(s=>{
    if(!full)return{id:s.id,n:s.n,a:s.a,sex:s.sex,gr:s.gr,ar:s.ar,sc:s.sc};
    const o={...s};if(!p.docs)delete o.tk;return o})}



let READY=false,DBERR=null;
process.on('unhandledRejection',e=>console.error('Error no controlado:',e&&e.message));
const app=express();app.set('trust proxy',1);app.use(express.json({limit:'8mb'}),cookieParser());
app.use('/api',(req,res,next)=>READY?next():res.status(503).json({msg:'La base de datos no está lista. Abre /diag para ver el motivo.'}));
const tries=new Map();
const limited=k=>{const n=Date.now(),t=(tries.get(k)||[]).filter(x=>n-x<9e5);tries.set(k,t);return t.length>=10};
const fail=k=>tries.set(k,[...(tries.get(k)||[]),Date.now()]);
const pub=u=>({name:u.name,role:u.role,cargo:u.cargo,email:u.email,usuario:u.usuario,perms:P(u)});
const hm=a=>crypto.createHmac('sha256',SECRET).update(String(a)).digest('hex');
const capOK=c=>{try{return !!c&&jwt.verify(c.tok,SECRET).h===hm(+c.ans)}catch(e){return false}};
const BADCAP={msg:'La verificación no es correcta. Inténtalo de nuevo.'};
const auth=async(req,res,next)=>{try{const{id}=jwt.verify(req.cookies.tk,SECRET),u=await one('SELECT * FROM users WHERE id=?',[id]);if(!u||u.estado!=='Activo')throw 0;req.user=u;next()}catch(e){res.status(401).json({msg:'Sesión no válida'})}};
const admin=(req,res,next)=>req.user.role==='adm'?next():res.status(403).json({msg:'Solo administración'});
app.get('/api/status',H(async(req,res)=>res.json({setup:!(await one('SELECT 1 FROM users LIMIT 1'))})));
app.get('/api/captcha',(req,res)=>{const a=2+crypto.randomInt(8),b=2+crypto.randomInt(8);res.json({q:`¿Cuánto es ${a} + ${b}?`,tok:jwt.sign({h:hm(a+b)},SECRET,{expiresIn:'10m'})})});
app.get('/api/center',H(async(req,res)=>{let c={};try{c=JSON.parse(await getS('center')||'{}')}catch(e){}const o={logo:await getS('logo')||'',logoM:await getS('logoM')||''};['nombre','codigo','dir','email','tel','provincia','municipio','distrito','regional','tanda','sector','zona','anio','director','secretario','dirDistrito','certDistrito','mision','vision','valores','lema'].forEach(k=>o[k]=c[k]||'');if(!o.nombre)o.nombre='Mi centro educativo';res.json(o)}));
app.post('/api/center',auth,admin,H(async(req,res)=>{const b=req.body||{},c={},logo=b.logo||'',logoM=b.logoM||'',okI=x=>!x||/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(x);
  ['nombre','codigo','dir','email','tel','provincia','municipio','distrito','regional','tanda','sector','zona','anio','director','secretario','dirDistrito','certDistrito','mision','vision','valores','lema'].forEach(k=>c[k]=String(b[k]||'').slice(0,['mision','vision','valores'].includes(k)?600:150));
  if(!okI(logo)||!okI(logoM))return res.status(400).json({msg:'Logo no válido'});
  await setS('center',JSON.stringify(c));await setS('logo',logo);await setS('logoM',logoM);res.json({})}));
app.post('/api/signup',H(async(req,res)=>{const{name,usuario,email,password,cargo,cap}=req.body||{},r=ROLES[cargo];
  if(!capOK(cap))return res.status(400).json(BADCAP);
  if(!name||!/^[a-z0-9._-]{3,30}$/.test(usuario||'')||!/^\S+@\S+\.\S+$/.test(email||'')||(password||'').length<8||!r)return res.status(400).json({msg:'Datos incompletos. La contraseña necesita 8 caracteres o más.'});
  const first=!(await one('SELECT 1 FROM users LIMIT 1'));
  try{await q('INSERT INTO users(name,usuario,email,hash,cargo,role,estado) VALUES(?,?,?,?,?,?,?)',[String(name).slice(0,80),usuario,email.toLowerCase(),bcrypt.hashSync(password,12),first?'Administración':cargo,first?'adm':r,first?'Activo':'Pendiente']);
    res.json({msg:first?'Cuenta de administrador creada. Ya puedes entrar.':'Solicitud enviada. Un administrador debe aprobarla antes de que puedas entrar.'})}
  catch(e){if(e.code==='ER_DUP_ENTRY')return res.status(409).json({msg:'Ese usuario o correo ya tiene una cuenta o solicitud.'});throw e}}));
app.post('/api/login',H(async(req,res)=>{const{id,password,cap}=req.body||{},key=req.ip+(id||'');
  if(limited(key))return res.status(429).json({msg:'Demasiados intentos. Espera 15 minutos.'});
  if(!capOK(cap))return res.status(400).json(BADCAP);
  const i=String(id||'').toLowerCase(),u=await one('SELECT * FROM users WHERE email=? OR usuario=?',[i,i]);
  if(!u||!bcrypt.compareSync(String(password||''),u.hash)){fail(key);return res.status(401).json({msg:'Usuario o contraseña incorrectos'})}
  if(u.estado==='Pendiente')return res.status(403).json({msg:'Tu cuenta espera la aprobación de un administrador.'});
  if(u.estado!=='Activo')return res.status(403).json({msg:'Tu cuenta está bloqueada. Habla con administración.'});
  res.cookie('tk',jwt.sign({id:u.id},SECRET,{expiresIn:'8h'}),{httpOnly:true,sameSite:'lax',secure:prod,maxAge:288e5});res.json({user:pub(u)})}));
app.post('/api/logout',(req,res)=>{res.clearCookie('tk');res.json({})});
app.post('/api/forgot',(req,res)=>{if(!capOK((req.body||{}).cap))return res.status(400).json(BADCAP);res.json({msg:'Pide a administración el código de verificación y escríbelo aquí.'})});
app.post('/api/reset',H(async(req,res)=>{const{id,code,password}=req.body||{},key='r'+req.ip+(id||'');
  if(limited(key))return res.status(429).json({msg:'Demasiados intentos. Espera 15 minutos.'});
  const i=String(id||'').toLowerCase(),u=await one('SELECT * FROM users WHERE email=? OR usuario=?',[i,i]);
  if(!u||!u.rcode||u.rexp<Date.now()||!bcrypt.compareSync(String(code||''),u.rcode)){fail(key);return res.status(400).json({msg:'Código incorrecto o vencido.'})}
  if((password||'').length<8)return res.status(400).json({msg:'La contraseña necesita 8 caracteres o más.'});
  await q('UPDATE users SET hash=?,rcode=NULL,rexp=NULL WHERE id=?',[bcrypt.hashSync(password,12),u.id]);res.json({msg:'Contraseña cambiada. Ya puedes entrar.'})}));
app.post('/api/password',auth,H(async(req,res)=>{const{old,password}=req.body||{},key='p'+req.user.id;
  if(limited(key))return res.status(429).json({msg:'Demasiados intentos. Espera 15 minutos.'});
  if(!bcrypt.compareSync(String(old||''),req.user.hash)){fail(key);return res.status(400).json({msg:'La contraseña actual no es correcta'})}
  if((password||'').length<8)return res.status(400).json({msg:'La contraseña necesita 8 caracteres o más.'});
  await q('UPDATE users SET hash=? WHERE id=?',[bcrypt.hashSync(password,12),req.user.id]);res.json({})}));
app.get('/api/me',auth,(req,res)=>res.json({user:pub(req.user)}));
app.get('/api/profile',auth,(req,res)=>res.json({profile:JSON.parse(req.user.profile||'{}')}));
app.post('/api/profile',auth,H(async(req,res)=>{const b=req.body||{},p={},s=k=>String(b[k]||'').slice(0,200);
  ['nombres','cedula','tel','correo','dir','estudios'].forEach(k=>p[k]=s(k));p.areas=(Array.isArray(b.areas)?b.areas:[]).slice(0,10).map(x=>String(x).slice(0,80));
  await q('UPDATE users SET profile=? WHERE id=?',[JSON.stringify(p),req.user.id]);res.json({})}));
app.get('/api/kv',auth,H(async(req,res)=>{const k=String(req.query.k||'');if(k.length>150||!can(k,req.user,false))return res.status(403).json({msg:'Sin permiso'});const r=await one('SELECT v FROM kv WHERE k=?',[k]);let v=r?JSON.parse(r.v):null;if(k==='students'&&Array.isArray(v))v=studentsFor(req.user,v);res.json({v})}));
app.put('/api/kv',auth,H(async(req,res)=>{const k=String((req.body||{}).k||'');if(k.length>150||!can(k,req.user,true))return res.status(403).json({msg:'Sin permiso'});
  await q('INSERT INTO kv(k,v) VALUES(?,?) ON DUPLICATE KEY UPDATE v=VALUES(v)',[k,JSON.stringify(req.body.v)]);res.json({})}));
app.post('/api/reports',auth,H(async(req,res)=>{const t=String((req.body||{}).text||'').trim().slice(0,1000);if(t.length<5)return res.status(400).json({msg:'Describe el problema'});
  await q('INSERT INTO reports(name,cargo,`text`,`date`) VALUES(?,?,?,?)',[req.user.name,req.user.cargo,t,new Date().toLocaleDateString('es-DO')]);res.json({})}));
app.get('/api/reports',auth,admin,H(async(req,res)=>res.json({reports:await q('SELECT id,name,cargo,`text`,`date` FROM reports ORDER BY id DESC')})));
app.delete('/api/reports/:id',auth,admin,H(async(req,res)=>{await q('DELETE FROM reports WHERE id=?',[req.params.id]);res.json({})}));
app.get('/api/users',auth,admin,H(async(req,res)=>res.json({users:(await q('SELECT id,name,cargo,estado,perms FROM users ORDER BY id')).map(u=>({...u,perms:P(u)}))})));
app.post('/api/users/:id/estado',auth,admin,H(async(req,res)=>{const s=(req.body||{}).estado;if(!['Activo','Bloqueado'].includes(s)||+req.params.id===req.user.id)return res.status(400).json({msg:'Operación no permitida'});await q('UPDATE users SET estado=? WHERE id=?',[s,req.params.id]);res.json({})}));
app.post('/api/users/:id/perms',auth,admin,H(async(req,res)=>{const b=req.body||{},secs=(Array.isArray(b.secs)?b.secs:[]).slice(0,80).map(x=>String(x).slice(0,60));await q('UPDATE users SET perms=? WHERE id=? AND role=?',[JSON.stringify({secs,est:!!b.est,docs:!!b.docs}),req.params.id,'doc']);res.json({})}));
app.post('/api/users/:id/reset',auth,admin,H(async(req,res)=>{const c=String(crypto.randomInt(100000,1000000));
  const r=await q('UPDATE users SET rcode=?,rexp=? WHERE id=?',[bcrypt.hashSync(c,10),Date.now()+18e5,req.params.id]);if(!r.affectedRows)return res.status(404).json({msg:'No existe'});res.json({code:c})}));
/* Consulta pública del boletín mediante el QR (enlace con clave aleatoria de 32 caracteres) */
const kvGet=async k=>{const r=await one('SELECT v FROM kv WHERE k=?',[k]);return r?JSON.parse(r.v):null},hits=new Map();
app.get('/api/boletin/:tk',H(async(req,res)=>{const k=req.ip,n=Date.now(),t=(hits.get(k)||[]).filter(x=>n-x<6e4);t.push(n);hits.set(k,t);
  if(t.length>40)return res.status(429).json({msg:'Demasiadas consultas. Espera un minuto.'});
  const tk=String(req.params.tk),NO=()=>res.status(404).json({msg:'Boletín no disponible'});
  if(!/^[a-f0-9]{32}$/.test(tk))return NO();
  const st=(await kvGet('students'))||[],s=st.find(x=>x.tk===tk);if(!s)return NO();
  const l=`${s.gr}.º ${s.ar?s.ar+' ':''}${s.sc}`,d=boletinData(s,await kvGet('notas:'+l),await kvGet('comp:'+l),await kvGet('asignaturas'));
  let c={};try{c=JSON.parse(await getS('center')||'{}')}catch(e){}
  res.set('X-Robots-Tag','noindex').json({centro:{nombre:c.nombre||'',anio:c.anio||''},logo:await getS('logo')||'',est:{nombre:s.n+' '+s.a,id:s.id,grado:s.gr+'.º',seccion:s.sc,area:s.ar||''},rows:d.rows,estado:d.estado})}));
app.get('/b/:tk',(req,res)=>{res.set('X-Robots-Tag','noindex');res.type('html').send(BOLETIN_HTML)});
/* ===== Archivos del navegador incluidos en el servidor (así no dependen de lo que haya subido a GitHub) ===== */
const SERVER_API="(()=>{\nconst J=async(u,b,m)=>{const r=await fetch(u,{method:m||(b===undefined?'GET':'POST'),headers:{'Content-Type':'application/json'},credentials:'same-origin',body:b===undefined?undefined:JSON.stringify(b)});let d={};try{d=await r.json()}catch(e){}return{ok:r.ok,...d}};\nconst M=(r,t)=>r.ok?{ok:true,msg:r.msg}:{ok:false,msg:r.msg||t};\nwindow.DEMO=false;\nauthLogin=async d=>{const r=await J('/api/login',d);return r.ok?{ok:true,user:r.user}:M(r,'No se pudo iniciar sesi\u00f3n.')};\nauthSignup=async d=>M(await J('/api/signup',d),'No se pudo enviar la solicitud.');\nauthForgot=async d=>M(await J('/api/forgot',d),'No se pudo procesar la solicitud.');\nauthReset=async d=>M(await J('/api/reset',d),'No se pudo cambiar la contrase\u00f1a.');\nauthChange=async d=>{const r=await J('/api/password',d);return r.ok?{ok:true}:{ok:false,msg:r.msg}};\nauthLogout=()=>J('/api/logout',{});\nauthMe=async()=>{const r=await J('/api/me');return r.ok?r.user:null};\ncaptchaNew=()=>J('/api/captcha');\nusersList=async()=>{const r=await J('/api/users');return r.ok?r.users:[]};\nusersSet=(id,estado)=>J('/api/users/'+id+'/estado',{estado});\nusersReset=id=>J('/api/users/'+id+'/reset',{});\nprofLoad=async()=>{const r=await J('/api/profile');return r.ok?r.profile:{}};\nprofSave=p=>J('/api/profile',p);\ndbGet=async k=>{const r=await J('/api/kv?k='+encodeURIComponent(k));return r.ok?r.v:null};\ndbSet=async(k,v)=>{const r=await J('/api/kv',{k,v},'PUT');if(!r.ok){toast(r.msg||'No tienes permiso para guardar esto');throw new Error('sin permiso')}return r};\nusersPerm=(id,p)=>J('/api/users/'+id+'/perms',p);\nreportSend=t=>J('/api/reports',{text:t});\nreportsList=async()=>{const r=await J('/api/reports');return r.ok?r.reports:[]};\nreportDone=id=>J('/api/reports/'+id,undefined,'DELETE');\ncenterLoad=async()=>{const r=await J('/api/center');if(r.ok){const{ok,logo,...c}=r;Object.assign(CEN,c);CFG.logo=logo||''}\n const s=await J('/api/status');window.SETUP=!!s.setup;const d=document.getElementById('demo');if(d)d.textContent=s.setup?'Primer uso: solicita acceso con tus datos. La primera cuenta que se registre ser\u00e1 la del administrador.':'';};\ncenterSave=c=>J('/api/center',c);\n})();\n";
const BOLETIN_HTML="<!DOCTYPE html>\n<html lang=\"es\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex,nofollow\"><title>Bolet\u00edn de calificaciones</title>\n<style>*{box-sizing:border-box}body{margin:0;font:16px/1.5 Georgia,serif;background:#f4f4f4;color:#111}main{max-width:680px;margin:0 auto;padding:16px}.c{background:#fff;border:1px solid #ddd;border-radius:10px;padding:16px;margin-bottom:12px}h1{font-size:20px;margin:0 0 4px}.m{color:#555;font-size:14px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{border-bottom:1px solid #ddd;padding:6px 4px;text-align:center}th:first-child,td:first-child{text-align:left}.ok{color:#1a7f45;font-weight:bold}.no{color:#c00;font-weight:bold}.lg{max-height:56px;max-width:140px;margin-bottom:8px}.tw{overflow-x:auto}.tabs{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap}.tabs button{font:inherit;padding:8px 14px;border:1px solid #bbb;border-radius:8px;background:#fff;cursor:pointer}.tabs button.on{background:#c8102e;color:#fff;border-color:#c8102e}</style></head>\n<body><main id=\"m\"><div class=\"c\">Cargando\u2026</div></main>\n<script>\nconst E=s=>String(s==null?'':s).replace(/[&<>\"]/g,c=>'&#'+c.charCodeAt(0)+';'),V=x=>x===null||x===undefined?'':x,CG=['Comunicativa','Pensamiento l\u00f3gico','Cient\u00edfica y tecnol\u00f3gica','\u00c9tica y ciudadana'];\nlet D,T=0;\nfunction draw(){const m=document.getElementById('m'),r=D.rows,p=T<4;\n const head='<div class=\"c\">'+(D.logo?'<img class=\"lg\" alt=\"Logo\" src=\"'+E(D.logo)+'\"><br>':'')+'<h1>'+E(D.centro.nombre||'Centro educativo')+'</h1><div class=\"m\">Bolet\u00edn de calificaciones'+(D.centro.anio?' \u00b7 A\u00f1o escolar '+E(D.centro.anio.replace('-',' / ')):'')+'</div><div style=\"margin-top:10px\"><b>'+E(D.est.nombre)+'</b><br>ID '+E(D.est.id)+' \u00b7 '+E(D.est.grado)+' grado \u00b7 Secci\u00f3n '+E(D.est.seccion)+(D.est.area?' \u00b7 '+E(D.est.area):'')+'</div></div>';\n const tabs='<div class=\"tabs\">'+['P1','P2','P3','P4','Final'].map((t,i)=>'<button data-t=\"'+i+'\" class=\"'+(i==T?'on':'')+'\">'+t+'</button>').join('')+'</div>';\n let body;\n if(p){const hasC=r.some(x=>x.c);body='<div class=\"c tw\"><table><tr><th>Asignatura</th><th>Nota P'+(T+1)+'</th>'+(hasC?CG.map(g=>'<th>'+g+'</th>').join(''):'')+'</tr>'+r.map(x=>'<tr><td>'+E(x.n)+'</td><td><b>'+V(x.pc[T])+'</b></td>'+(hasC?[0,1,2,3].map(g=>'<td>'+V(x.c?x.c[g*4+T]:null)+'</td>').join(''):'')+'</tr>').join('')+'</table></div>'}\n else body='<div class=\"c tw\"><table><tr><th>Asignatura</th><th>P1</th><th>P2</th><th>P3</th><th>P4</th><th>C.F.</th></tr>'+r.map(x=>'<tr><td>'+E(x.n)+'</td>'+x.pc.map(v=>'<td>'+V(v)+'</td>').join('')+'<td class=\"'+(x.cf===null?'':x.cf>=70?'ok':'no')+'\">'+V(x.cf)+'</td></tr>').join('')+'</table></div><div class=\"c\"><b>Situaci\u00f3n final: '+(D.estado?E(D.estado):'pendiente')+'</b></div>';\n m.innerHTML=head+tabs+body+'<div class=\"m\" style=\"text-align:center\">Consulta informativa. El documento oficial es el bolet\u00edn impreso, firmado y sellado por el centro.</div>';\n m.querySelectorAll('[data-t]').forEach(b=>b.onclick=()=>{T=+b.dataset.t;draw()})}\n(async()=>{const m=document.getElementById('m'),tk=location.pathname.split('/').filter(Boolean).pop();\ntry{const r=await fetch('/api/boletin/'+encodeURIComponent(tk));const d=await r.json();if(!r.ok){m.innerHTML='<div class=\"c\">'+E(d.msg||'Bolet\u00edn no disponible')+'</div>';return}\nD=d;T=3;while(T>0&&!d.rows.some(x=>x.pc[T]!==null))T--;draw()}catch(e){m.innerHTML='<div class=\"c\">No se pudo cargar. Intenta de nuevo en un momento.</div>'}})();\n</script></body></html>\n";
/* index.html se repara al servirlo: deja un solo enlace a server-api.js, justo antes del último </body> */
function loadIndex(){
  const c=[path.join(__dirname,'public','index.html'),path.join(__dirname,'index.html')].filter(f=>fs.existsSync(f)).map(f=>fs.readFileSync(f,'utf8')).sort((a,b)=>b.length-a.length);
  if(!c.length)return null;
  let h=c[0].split('<script src="server-api.js"></script>\n').join('').split('<script src="server-api.js"></script>').join('');
  const i=h.lastIndexOf('</body>');h=h.slice(0,i)+'<script src="server-api.js"></script>\n'+h.slice(i);
  if(!h.includes('Versión '))h=h.replace('solo existen en tu navegador.</p>','solo existen en tu navegador.</p><p style="color:var(--mt);font-size:12px;margin:8px 0 0">Versión 31-10-2026 (servidor)</p>');
  return h}
app.get(['/','/index.html'],(req,res)=>{const h=loadIndex();if(!h)return res.status(404).send('Falta public/index.html');res.set('Cache-Control','no-cache').type('html').send(h)});
app.get('/server-api.js',(req,res)=>res.set('Cache-Control','no-cache').type('js').send(SERVER_API));
/* Estado del servidor, sin datos secretos: abre /diag en el navegador */
app.get('/diag',(req,res)=>{
  const c=DBERR&&DBERR.code,hint=!DBERR?'':/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/.test(c||DBERR.message)?'No se encuentra el servidor MySQL. Revisa DATABASE_URL (o DB_HOST y DB_PORT) y que Aiven permita conexiones.':/ACCESS_DENIED/.test(c||'')?'Usuario o contraseña de MySQL incorrectos. Revisa DATABASE_URL.':/SSL|CERT|HANDSHAKE|self.signed|unable to verify/i.test((c||'')+DBERR.message)?'Problema con la conexión cifrada. Agrega la variable DB_SSL con el valor relaxed.':/ER_BAD_DB|UNKNOWN_DB/.test(c||'')?'La base de datos indicada no existe. Revisa el nombre al final de DATABASE_URL.':'Revisa las variables de conexión a MySQL.';
  const f=[path.join(__dirname,'public','index.html'),path.join(__dirname,'index.html')].map(x=>x.replace(__dirname,'.')+': '+(fs.existsSync(x)?'existe ('+fs.statSync(x).size+' bytes)':'no existe'));
  res.type('text/plain').send(['SERVIDOR DEL PORTAL · versión 31-10-2026 (diag)','',
   'Base de datos: '+(READY?'LISTA':'NO LISTA'),DBERR?'Motivo: '+(c||'')+' '+String(DBERR.message).slice(0,160):'',DBERR?'Qué hacer: '+hint:'','',
   'Variables definidas (solo se indica si existen):',
   '  DATABASE_URL: '+(E.DATABASE_URL?'sí':'no'),'  DB_HOST: '+(E.DB_HOST?'sí':'no'),'  DB_SSL: '+(E.DB_SSL||'no'),'  DB_CA: '+(E.DB_CA?'sí':'no'),'  JWT_SECRET: '+(E.JWT_SECRET?'sí':'no (se usa una clave propia guardada en la base)'),'  NODE_ENV: '+(E.NODE_ENV||'no'),'',
   'Archivos de la página:'].concat(f).filter(x=>x!==undefined).join('\n'))});
app.use(express.static(path.join(__dirname,'public')));
app.listen(E.PORT||3000,()=>console.log('Portal escuchando'));
const tryInit=()=>init().then(()=>{READY=true;DBERR=null;console.log('Portal listo')}).catch(e=>{DBERR=e;console.error('No se pudo conectar a MySQL:',e.code||'',e.message);setTimeout(tryInit,20000)});
tryInit();
