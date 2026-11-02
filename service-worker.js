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
