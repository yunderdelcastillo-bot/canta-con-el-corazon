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

/* Instalación PWA y recuperación del panel: nunca intercepta ni almacena respuestas de API. */
const CCH_SHELL_CACHE='cch-admin-shell-v2';
self.addEventListener('install',event=>{
 event.waitUntil((async()=>{
  const cache=await caches.open(CCH_SHELL_CACHE);
  try{await cache.add('/admin.html');}catch(error){console.warn('No se pudo precargar el panel:',error);}
  await self.skipWaiting();
 })());
});
self.addEventListener('activate',event=>{
 event.waitUntil((async()=>{
  const keys=await caches.keys();
  await Promise.all(keys.filter(key=>key.startsWith('cch-admin-shell-')&&key!==CCH_SHELL_CACHE).map(key=>caches.delete(key)));
  await self.clients.claim();
 })());
});
self.addEventListener('fetch',event=>{
 const request=event.request;
 if(request.method!=='GET'||request.mode!=='navigate')return;
 const url=new URL(request.url);
 if(url.origin!==self.location.origin)return;
 if(url.pathname!=='/admin.html'&&url.pathname!=='/')return;
 event.respondWith((async()=>{
  try{
   const response=await fetch(request);
   if(response&&response.ok){
    const cache=await caches.open(CCH_SHELL_CACHE);
    await cache.put('/admin.html',response.clone());
   }
   return response;
  }catch(error){
   const cache=await caches.open(CCH_SHELL_CACHE);
   return (await cache.match('/admin.html'))||new Response('El panel no está disponible sin conexión. Recupera internet y vuelve a intentarlo.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
  }
 })());
});
