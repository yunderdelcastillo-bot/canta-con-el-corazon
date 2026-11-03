self.addEventListener('push',event=>{
 let data={title:'Canta con el corazón',body:'Tienes una nueva notificación.',url:'/admin.html',tag:'cch-admin'};
 try{if(event.data)data={...data,...event.data.json()};}catch(e){}
 event.waitUntil(self.registration.showNotification(data.title,{body:data.body,icon:'/favicon.ico',badge:'/favicon.ico',tag:data.tag||'cch-admin',renotify:true,vibrate:[250,120,250],data:{url:data.url||'/admin.html'}}));
});
self.addEventListener('notificationclick',event=>{
 event.notification.close();
 const target=new URL(event.notification.data?.url||'/admin.html',self.location.origin).href;
 event.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
  for(const client of list){if(new URL(client.url).origin===self.location.origin&&'focus'in client)return client.focus().then(c=>c.navigate(target));}
  return clients.openWindow?clients.openWindow(target):undefined;
 }));
});

/* Recuperación de navegación: cache independiente para tienda y administración. */
const CCH_SHELL_CACHE='cch-shell-v3';
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
