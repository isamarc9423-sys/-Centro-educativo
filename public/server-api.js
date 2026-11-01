(()=>{
const J=async(u,b,m)=>{const r=await fetch(u,{method:m||(b===undefined?'GET':'POST'),headers:{'Content-Type':'application/json'},credentials:'same-origin',body:b===undefined?undefined:JSON.stringify(b)});let d={};try{d=await r.json()}catch(e){}return{ok:r.ok,...d}};
const M=(r,t)=>r.ok?{ok:true,msg:r.msg}:{ok:false,msg:r.msg||t};
window.DEMO=false;
authLogin=async d=>{const r=await J('/api/login',d);return r.ok?{ok:true,user:r.user}:M(r,'No se pudo iniciar sesión.')};
authSignup=async d=>M(await J('/api/signup',d),'No se pudo enviar la solicitud.');
authForgot=async d=>M(await J('/api/forgot',d),'No se pudo procesar la solicitud.');
authReset=async d=>M(await J('/api/reset',d),'No se pudo cambiar la contraseña.');
authChange=async d=>{const r=await J('/api/password',d);return r.ok?{ok:true}:{ok:false,msg:r.msg}};
authLogout=()=>J('/api/logout',{});
authMe=async()=>{const r=await J('/api/me');return r.ok?r.user:null};
captchaNew=()=>J('/api/captcha');
usersList=async()=>{const r=await J('/api/users');return r.ok?r.users:[]};
usersSet=(id,estado)=>J('/api/users/'+id+'/estado',{estado});
usersReset=id=>J('/api/users/'+id+'/reset',{});
profLoad=async()=>{const r=await J('/api/profile');return r.ok?r.profile:{}};
profSave=p=>J('/api/profile',p);
dbGet=async k=>{const r=await J('/api/kv?k='+encodeURIComponent(k));return r.ok?r.v:null};
dbSet=async(k,v)=>{const r=await J('/api/kv',{k,v},'PUT');if(!r.ok){toast(r.msg||'No tienes permiso para guardar esto');throw new Error('sin permiso')}return r};
usersPerm=(id,p)=>J('/api/users/'+id+'/perms',p);
reportSend=t=>J('/api/reports',{text:t});
reportsList=async()=>{const r=await J('/api/reports');return r.ok?r.reports:[]};
reportDone=id=>J('/api/reports/'+id,undefined,'DELETE');
centerLoad=async()=>{const r=await J('/api/center');if(r.ok){const{ok,logo,...c}=r;Object.assign(CEN,c);CFG.logo=logo||''}
 const s=await J('/api/status');window.SETUP=!!s.setup;const d=document.getElementById('demo');if(d)d.textContent=s.setup?'Primer uso: solicita acceso con tus datos. La primera cuenta que se registre será la del administrador.':'';};
centerSave=c=>J('/api/center',c);
})();
