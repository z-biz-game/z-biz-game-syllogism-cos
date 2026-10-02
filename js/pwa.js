'use strict';
// 装到桌面 / 手机主屏的那根线。单独一个 classic script，不动 js/main.js：注册失败与否都和
// 玩法无关，把 PWA 的边界情况（file://、Electron、隐私模式、非安全上下文）掺进主模块，是
// 主模块里最先长出一堆 if 的地方。
//
// 三条实测边界：
//   1. file:// 下 navigator.serviceWorker 存在但 register() 必抛 NotAllowedError，
//      而且是以未捕获 rejection 的形式——直接打开 index.html 的玩家会在控制台看到一条红。
//      所以这里在调用之前就按协议跳过，而不是靠 catch 兜。
//   2. Electron 主进程用 loadFile() 装载时同样是 file://，桌面端因此天然不注册。
//   3. scope 按**当前文档所在目录**算，不是写死 '/'：Pages 项目页在 /<repo>/ 子目录下，
//      写死 '/' 会让 manifest 与 sw 双双 404，安装提示永远不出现。
(function () {
  var g = typeof globalThis !== 'undefined' ? globalThis : {};
  var nav = g.navigator || {};
  var loc = g.location || {};

  function docBase() {
    var path = typeof loc.pathname === 'string' ? loc.pathname : '';
    return path.slice(0, path.lastIndexOf('/') + 1);
  }

  function reason() {
    if (loc.protocol === 'file:') return 'file:';
    if (loc.protocol !== 'http:' && loc.protocol !== 'https:') return loc.protocol || 'no-location';
    // 非安全上下文（http 且非 localhost）里 sw 注册同样会抛，Chrome 也只是不显示安装提示
    if (g.isSecureContext === false && !/localhost$|127\.0\.0\.1$/.test(loc.hostname || '')) {
      return 'insecure';
    }
    if (!nav.serviceWorker || typeof nav.serviceWorker.register !== 'function') return 'unsupported';
    return null;
  }

  function register() {
    var skip = reason();
    if (skip) return null;
    var base = docBase();
    try {
      return Promise.resolve(nav.serviceWorker.register(base + 'sw.js', { scope: base }))
        .then(function (rec) {
          g.__syllogismSW = rec ? rec.scope : base;
          return rec;
        })
        .catch(function () {
          // 注册失败不是玩家的问题：断网首开、隐私模式、企业策略都会走到这里，游戏照玩
          return null;
        });
    } catch (e) {
      return null;
    }
  }

  function whenReady(fn) {
    if (g.document && g.document.readyState === 'complete') fn();
    else if (typeof g.addEventListener === 'function') g.addEventListener('load', fn, { once: true });
  }

  whenReady(register);

  // 挂出来给浏览器套件复验：判据要能问「为什么没注册」，而不是只看控制台有没有红字
  g.syllogismPWA = { register: register, skipReason: reason, base: docBase };
}());
