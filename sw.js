'use strict';
// 离线壳：network-first，回落到缓存。
//
// 为什么不是 cache-first：本仓是裸 ES module，没有打包、没有内容哈希文件名。cache-first 加上
// 手工 VERSION 号，等于把 js/css 永久钉死在第一次缓存的那一版——出新 HTML 配旧 main.js 的鬼状态
// 就是这么来的（玩家卡在标题屏，而源码看起来完全正常）。network-first 的代价只有断网时的第一次
// 打开，而断网时正好有缓存兜底。
//
// VERSION 只用于「换一整套缓存」：格式变了（下面 SHELL 的语义、或匹配规则改了）就 +1，activate
// 里旧缓存整批删掉。它不是内容版本号，也不该被当成版本号手工去对。
const VERSION = 'v2';
const SHELL = `syllogism-${VERSION}-shell`;
const RUNTIME = `syllogism-${VERSION}-runtime`;

const PRECACHE = [
  './',
  './index.html',
  './css/game.css',
  './js/main.js',
  './js/theme.js',
  './js/store.js',
  './js/pwa.js',
  './js/audio/synth.js',
  './js/engine/logic.js',
  './js/engine/generate.js',
  './js/engine/count.js',
  './js/engine/rng.js',
  './js/render/scene.js',
  './js/render/textures.js',
  './js/ui/game.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './assets/img/paper-grain.png',
  './assets/img/candle-glow.png',
  './assets/img/mote.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => Promise.all(PRECACHE.map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  const keep = new Set([SHELL, RUNTIME]);
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 只有同源 GET 才管。跨源（字体、CDN）直接放行——把它们塞进本地缓存是把别人的
// 缓存策略抄到自己账上，而且 opaque response 根本读不回来。
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  // 带查询串的（开发服务器热更、玩家自己加的 ?v=）不碰，缓存它等于伪造一份新资源
  if (url.search) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(RUNTIME).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: false }).then(
        (hit) => hit
          || (req.mode === 'navigate' ? caches.match('./index.html') : null)
          || Response.error(),
      )),
  );
});
