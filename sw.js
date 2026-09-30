const CACHE='ritmo-shell-v11';
const ASSETS=['./','./index.html','./styles.css?v=11','./calendar.css?v=11','./app.js?v=11','./calendar.js?v=11','./insights.js?v=11','./planning.js?v=11','./domain.js?v=11','./access.js','./config.js','./supabase-client.js','./icon.svg','./icon-192.png','./icon-512.png','./manifest.webmanifest'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  event.respondWith(fetch(event.request,{cache:'no-cache'}).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(c=>c.put(event.request,copy));}return response;}).catch(()=>caches.match(event.request).then(r=>r|| (event.request.mode==='navigate'?caches.match('./index.html'):Response.error()))));
});
self.addEventListener('push',event=>{
  let data;try{data=event.data.json();}catch{data={title:'Ritmo',body:'Es momento de revisar tu siguiente tarea.'};}
  event.waitUntil(self.registration.showNotification(data.title||'Ritmo',{body:data.body,icon:'./icon-192.png',badge:'./icon-192.png',tag:data.tag||'ritmo-task',renotify:true,data:{url:self.registration.scope},requireInteraction:true}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();event.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients=>{const client=clients.find(c=>c.url.startsWith(self.registration.scope));if(client)return client.focus();return self.clients.openWindow(self.registration.scope);}));
});
