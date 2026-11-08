/* Admissara service worker, build 0.14.0.
   The page is always fetched fresh from the network when online (so updates arrive on the next launch) and served from cache offline. */
const CACHE="cag-0.14.0";
const SHELL=["./","./index.html","./manifest.webmanifest","./icon-192.png","./icon-512.png","./favicon-32.png"];
self.addEventListener("install",e=>{ e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL.map(u=>new Request(u,{cache:"reload"}))))); self.skipWaiting(); });
self.addEventListener("activate",e=>{ e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==CACHE).map(x=>caches.delete(x)))).then(()=>self.clients.claim())); });
self.addEventListener("fetch",e=>{ const u=new URL(e.request.url); if(e.request.method!=="GET"||u.origin!==location.origin) return;
  if(u.pathname.endsWith("/version.json")) return;
  const nav=e.request.mode==="navigate";
  e.respondWith(fetch(e.request,{cache:"no-cache"}).then(r=>{ if(r.ok){ const c=r.clone(); caches.open(CACHE).then(x=>x.put(nav?"./index.html":e.request,c)); } return r; })
    .catch(()=>caches.match(nav?"./index.html":e.request).then(r=>r||caches.match("./index.html")))); });
