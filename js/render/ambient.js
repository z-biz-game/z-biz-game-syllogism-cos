// 环境层：桌上的烛光与浮尘。它不带任何信息——棋盘上的身份、冲突、焦点一处都不靠它表达——
// 所以它可以动；也正因为它是唯一在动的东西，帧率无关这件事只有在这一层才真的可测。
//
// 两条写法纪律：
//   1. 一切视觉量都是 `clock`（虚拟秒）的确定函数，不做"朝目标值趋近"的一阶滞后。滞后
//      本身就是帧率依赖的（探针会把它读成 2~3 的比值），而这里没有任何量真的需要趋近。
//   2. 位移一律 `x += v * dt`，v 是"每秒归一化单位"；坐标归一化到 [0,1]，于是 resize
//      不需要重播粒子，也不存在按 60Hz 写死的那一坨常数。
// 粒子越界用等量回绕而不是重投：同一段虚拟时长内跨过边界的次数与步长无关，所以 30/60/120Hz
// 三档跑完的末态是同一个数——这是可对拍的，不是"看起来差不多"。

import { makeRng } from '../engine/rng.js';
import { imageOf } from './textures.js';
import { Palette } from '../theme.js';

export const MOTE_COUNT = 26;
const WRAP = 1.10;            // 回绕周期：留 10% 边距，粒子在框外淡出，看不见接缝

function wrap(v) {
  if (v < -0.05) return v + WRAP;
  if (v > 1.05) return v - WRAP;
  return v;
}

export class Ambient {
  constructor(seed = 'syllogism') {
    this.reset(seed);
  }

  // 重开 / 换一局都要走到这里：时钟、粒子、步数计数一个都不留，否则"再来一局"继承的是
  // 上一局的浮尘分布，探针一眼就能看出两局之间没复位。
  reset(seed = this.seed) {
    this.seed = String(seed);
    this.clock = 0;
    this.steps = 0;
    const rng = makeRng(`${this.seed}|motes`);
    this.motes = [];
    for (let i = 0; i < MOTE_COUNT; i++) {
      this.motes.push({
        x: rng.next(),
        y: rng.next(),
        vx: (rng.next() - 0.5) * 0.020,
        vy: -(0.010 + rng.next() * 0.028),
        r: 0.9 + rng.next() * 2.4,
        ph: rng.next() * Math.PI * 2,
      });
    }
    return this;
  }

  step(dt) {
    if (!(dt > 0)) return this.clock;
    this.clock += dt;
    this.steps++;
    for (const m of this.motes) {
      m.x = wrap(m.x + m.vx * dt);
      m.y = wrap(m.y + m.vy * dt);
    }
    return this.clock;
  }

  // 烛焰的抖：三条不同频率的正弦叠加，纯 clock 的函数。
  flicker() {
    const t = this.clock;
    return 0.86
      + 0.070 * Math.sin(t * 2.3)
      + 0.045 * Math.sin(t * 5.7 + 1.3)
      + 0.025 * Math.sin(t * 11.1 + 0.4);
  }

  // 给判尺读的末态：全部保留 6 位小数，跨档对拍比的是数，不是截图。
  snapshot() {
    const m = this.motes;
    return {
      clock: +this.clock.toFixed(6),
      steps: this.steps,
      flicker: +this.flicker().toFixed(6),
      motes: m.length,
      sumX: +m.reduce((a, p) => a + p.x, 0).toFixed(6),
      sumY: +m.reduce((a, p) => a + p.y, 0).toFixed(6),
      head: `${m[0].x.toFixed(5)},${m[0].y.toFixed(5)}`,
      tail: `${m[m.length - 1].x.toFixed(5)},${m[m.length - 1].y.toFixed(5)}`,
    };
  }
}

// 画在**另一张** canvas 上，不画进 #board：棋盘那张的判据是"同一状态两帧逐字节相同"
// （tools/ 里的像素断言就靠它），把每帧都变的烛光混进去，等于把那条断言永久弄坏。
export function drawAmbient(ctx, w, h, amb, { enabled = true } = {}) {
  ctx.clearRect(0, 0, w, h);
  const flick = enabled ? amb.flicker() : 0.9;

  const glow = imageOf('glow');
  const gr = Math.max(w, h) * (0.62 + (flick - 0.86) * 0.16);
  if (glow) {
    ctx.globalAlpha = Math.max(0.18, Math.min(0.46, flick * 0.34));
    ctx.drawImage(glow, w * 0.5 - gr, -gr * 0.42, gr * 2, gr * 2);
  } else {
    const rg = ctx.createRadialGradient(w * 0.5, 0, 12, w * 0.5, 0, gr * 1.4);
    rg.addColorStop(0, Palette.sealGlow);
    rg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
  }

  if (!enabled) {
    ctx.globalAlpha = 1;
    return;
  }
  const mote = imageOf('mote');
  const t = amb.clock;
  for (const p of amb.motes) {
    const tw = 0.34 + 0.30 * Math.sin(t * 3.1 + p.ph);
    const s = p.r * 6 * (0.8 + tw * 0.5);
    ctx.globalAlpha = Math.max(0.04, Math.min(0.5, tw));
    const x = p.x * w;
    const y = p.y * h;
    if (mote) {
      ctx.drawImage(mote, x - s / 2, y - s / 2, s, s);
    } else {
      ctx.fillStyle = Palette.sealEdge;
      ctx.beginPath();
      ctx.arc(x, y, s / 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}
