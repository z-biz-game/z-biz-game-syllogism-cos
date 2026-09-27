// 逐人指派的真值表穷举：这个文件里没有任何推理逻辑。
//
// 为什么必须再写一份：solvePuzzle() 既是出题的准入门槛，又是提示器，又是难度评分器。
// 如果它对某条证词的"能不能推出"判断过宽（写进一个方程其实钉不死的值），它会自己证明
// 自己唯一，于是出货一个悄悄有两个解的盘。这里做的事只有一件：把 2^n 种指派逐个代入
// 每条证词，数一数有几种自洽。两者不一致的盘不出货。

import { constraintHolds } from './logic.js';

export const UNIQUE = 1;
export const NONE = 0;      // 可证明无解 —— 和 MANY（≥2）分开，否则"这盘无解"只能表现为一次失败
export const MANY = 2;      // 数到 2 就停，我们要的是唯一性而不是解数
export const OVERBUDGET = -1;

export function countModels(puzzle, { budget = 200000 } = {}) {
  const n = puzzle.n;
  if (n > 20) return { status: OVERBUDGET, models: 0, steps: 0 };
  const env = new Int8Array(n);
  let models = 0;
  let steps = 0;
  let first = null;
  let truncated = false;
  const total = 1 << n;
  for (let mask = 0; mask < total; mask++) {
    if (++steps > budget) { truncated = true; break; }
    for (let i = 0; i < n; i++) env[i] = (mask >> i) & 1;
    let ok = true;
    for (const stmt of puzzle.statements) {
      if (!constraintHolds(env, stmt)) { ok = false; break; }
    }
    if (ok) {
      models++;
      if (!first) first = Int8Array.from(env);
      if (models >= MANY) break;
    }
  }
  if (truncated) return { status: OVERBUDGET, models, steps, witness: first };
  return { status: models === 1 ? UNIQUE : models === 0 ? NONE : MANY, models, steps, witness: first };
}

// 穷举给出的那个唯一解是不是就是出题人心里的那个 —— 独立复核的第二问。
export function matchesTruth(puzzle, truth) {
  const env = Int8Array.from(truth);
  for (const stmt of puzzle.statements) if (!constraintHolds(env, stmt)) return false;
  return true;
}
