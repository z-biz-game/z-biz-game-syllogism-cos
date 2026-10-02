// 位图纹理的装载层。三张图都由 assets/gen/make_art.py 现画，路径按**文档基准**解析
// （不是模块 URL）：Pages 项目页在 /<repo>/ 子目录下，写死 '/' 或以 import.meta.url 为基
// 都会指错地方，而 <img src> 的相对路径天然跟着 document base 走。
//
// 装载失败一律退化成"没有这张图"：棋盘与烛光的程序化画法本来就完整，纹理只是加一层纸的
// 手感。一个 404 不该让游戏黑屏。

const SOURCES = {
  grain: 'assets/img/paper-grain.png',
  glow: 'assets/img/candle-glow.png',
  mote: 'assets/img/mote.png',
};

const loaded = {};
const patterns = {};
const waiters = [];

function fire() {
  while (waiters.length) {
    const cb = waiters.pop();
    try {
      cb(loaded);
    } catch {
      /* 一个订阅者出错不该拖掉其它订阅者，更不该拖掉游戏 */
    }
  }
}

export function loadTextures() {
  if (typeof Image !== 'function') return loaded;   // node / vm 沙箱：一张都不装，走程序化画法
  for (const [name, src] of Object.entries(SOURCES)) {
    if (loaded[name]) continue;
    const img = new Image();
    img.onload = () => {
      loaded[name] = { img, ok: true };
      fire();
    };
    img.onerror = () => {
      loaded[name] = { img: null, ok: false };
      fire();                       // 订阅者等的是"装载结束"，不是"全部成功"
    };
    img.decoding = 'async';
    img.src = src;
  }
  return loaded;
}

export function whenTexturesReady(cb) {
  const missing = Object.keys(SOURCES).filter((n) => !loaded[n]);
  if (!missing.length || typeof Image !== 'function') {
    cb(loaded);
    return;
  }
  waiters.push(cb);
}

export function has(name) {
  return !!(loaded[name] && loaded[name].ok);
}

export function imageOf(name) {
  return has(name) ? loaded[name].img : null;
}

// createPattern 每次重画都新建一个，是这一层最容易漏的开销：pattern 与 ctx 绑定，
// 但同一个 ctx + 同一张图的结果可以一直复用。
export function patternOf(ctx, name, repetition = 'repeat') {
  const key = `${name}|${repetition}`;
  if (!patterns[key] || patterns[key].ctx !== ctx) {
    const img = imageOf(name);
    patterns[key] = { ctx, pattern: img ? ctx.createPattern(img, repetition) : null };
  }
  return patterns[key].pattern;
}

export const TextureSources = SOURCES;
