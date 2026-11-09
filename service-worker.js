self.addEventListener('push',event=>{
 let data={title:'Canta con el corazón',body:'Tienes una nueva notificación.',url:'/admin.html',tag:'cch-admin'};
 try{if(event.data)data={...data,...event.data.json()};}catch(e){}
 event.waitUntil(self.registration.showNotification(data.title,{body:data.body,icon:'/favicon.ico',badge:'/favicon.ico',tag:data.tag||'cch-admin',renotify:true,requireInteraction:true,silent:false,vibrate:[350,180,350,180,700],timestamp:Date.now(),data:{url:data.url||'/admin.html'}}));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 event.waitUntil((async()=>{
  const requested=new URL(event.notification.data?.url||'/admin.html',self.location.origin);
  const target=requested.origin===self.location.origin&&requested.pathname==='/admin.html'?requested.href:new URL('/admin.html',self.location.origin).href;
  const windows=await clients.matchAll({type:'window',includeUncontrolled:true});
  const adminWindow=windows.find(client=>{
   try{const u=new URL(client.url);return u.origin===self.location.origin&&u.pathname==='/admin.html';}
   catch{return false;}
  });
  if(adminWindow){await adminWindow.focus();return;}
  if(clients.openWindow)await clients.openWindow(target);
 })());
});

/* Recuperación de navegación: cache independiente para tienda y administración. */
const CCH_SHELL_CACHE='cch-shell-v9';
const CCH_NAV_PATHS=['/','/admin.html'];
self.addEventListener('install',event=>{
 event.waitUntil((async()=>{
  const cache=await caches.open(CCH_SHELL_CACHE);
  await Promise.all(CCH_NAV_PATHS.map(async path=>{
   try{const response=await fetch(path,{cache:'reload'});if(response.ok)await cache.put(path,response);}
   catch(error){console.warn('Precarga pendiente para '+path,error);}
  }));
  await self.skipWaiting();
 })());
});
self.addEventListener('activate',event=>{
 event.waitUntil((async()=>{
  const keys=await caches.keys();
  await Promise.all(keys.filter(key=>key.startsWith('cch-')&&key!==CCH_SHELL_CACHE).map(key=>caches.delete(key)));
  await self.clients.claim();
 })());
});
self.addEventListener('fetch',event=>{
 const request=event.request;
 if(request.method!=='GET'||request.mode!=='navigate')return;
 const url=new URL(request.url);
 if(url.origin!==self.location.origin)return;
 const path=url.pathname==='/'?'/':url.pathname==='/admin.html'?'/admin.html':null;
 if(!path)return;
 event.respondWith((async()=>{
  const cache=await caches.open(CCH_SHELL_CACHE);
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),8000);
  try{
   const response=await fetch(request,{signal:controller.signal,cache:'no-store'});
   if(response&&response.ok)await cache.put(path,response.clone());
   return response;
  }catch(error){
   const saved=await cache.match(path);
   if(saved)return saved;
   return new Response('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conexión pendiente</title><body style="font-family:system-ui;text-align:center;padding:12vh 24px;background:#fbf7ff;color:#29113c"><h2>💗 Canta con el corazón</h2><p>No pudimos conectar en este momento.</p><p>Comprueba tu internet y vuelve a cargar la página.</p><button onclick="location.reload()" style="padding:12px 20px;border:0;border-radius:24px;background:#681b43;color:white;font-weight:700">Volver a intentar</button></body></html>',{status:503,headers:{'Content-Type':'text/html; charset=utf-8'}});
  }finally{clearTimeout(timeout);}
 })());
});
