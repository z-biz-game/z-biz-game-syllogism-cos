// 难度实测台。它读的是各档出货盘面的难度，不设定难度。
//
// 这里打印的分数分位就是 TIERS[].band 该装的那些数。改了 grade() 而不重跑这里，
// band 就退化成装饰，README 里那张实测表就成了假话。
//
// 两道硬门禁（不通过就 exit 1）：
//   1) 五档中位分数不减，且每一档的命中自己区间的比例 ≥ 0.8 —— 否则 band 只是标签。
//   2) 出货盘在 count.js 的穷举里必须是唯一解，且穷举出来的那一个就是出题人的 truth。
//      求解器既是准入门槛又是评分器，它判断过宽时会自己证明自己唯一，只有这份穷举能反驳它。

import { performance } from 'node:perf_hooks';
import { TIERS, makePuzzle, grade, solvableByPencil } from '../js/engine/generate.js';
import { countModels, matchesTruth, UNIQUE } from '../js/engine/count.js';
import { solvePuzzle, validStatement, Rules } from '../js/engine/logic.js';

const N = Number(process.env.SAMPLES || 40);

function q(sorted, p) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

let worst = 0;
const ladder = [];
const boards = [];
for (const tier of TIERS) {
  const scores = [];
  const passes = [];
  const nishio = [];
  const chain = [];
  const stmts = [];
  let accepted = 0;
  let attempts = 0;
  let ms = 0;
  let inBand = 0;
  for (let s = 0; s < N; s++) {
    const t0 = performance.now();
    const p = makePuzzle(`balance|${s}`, tier.id);
    ms += performance.now() - t0;
    if (!p) continue;
    accepted++;
    if (p.stats.inBand) inBand++;
    attempts += p.stats.attempts;
    scores.push(p.score);
    passes.push(p.stats.passes);
    nishio.push(p.stats.nishio);
    chain.push(p.stats.chain);
    stmts.push(p.stats.statements);
    boards.push({ tier, p });
  }
  const sort = (a) => a.slice().sort((x, y) => x - y);
  const line = (label, arr, fmt = (v) => v) => {
    const a = sort(arr);
    console.log(`    ${label.padEnd(10)} p25 ${fmt(q(a, 0.25))}  中位 ${fmt(q(a, 0.5))}  p75 ${fmt(q(a, 0.75))}  max ${fmt(a[a.length - 1])}`);
  };
  console.log(`\n${tier.label} ${tier.n} 人 (每档 ${tier.want} 句，留 ${Math.round((1 - tier.prune) * 100)}%，联立 ${tier.chainWidth} 句，目标分 ${tier.band[0]}–${tier.band[1]})`);
  console.log(`    出题成功率 ${accepted}/${N}，命中目标区间 ${inBand}/${accepted}，平均每档尝试 ${(attempts / Math.max(1, accepted)).toFixed(1)} 次，耗时 ${(ms / N).toFixed(1)} ms/局`);
  line('分数', scores, (v) => (v || 0).toFixed(1));
  line('pass 数', passes);
  line('联立落子', chain);
  line('反证', nishio);
  line('证词数', stmts);
  ladder.push({ label: tier.label, median: q(sort(scores), 0.5) || 0, inBand, accepted, hit: accepted ? inBand / accepted : 0 });
  worst = Math.max(worst, ms / N);
}

let gates = 0;

// 阶梯就是产品承诺：见习必须读起来比大师浅，而一档若从不落进自己的区间，band 就只是装饰。
console.log('\n== 档位阶梯（中位分数不减，命中率 ≥ 0.8）==');
{
  let prev = -Infinity;
  for (const l of ladder) {
    const okScore = l.median >= prev;
    const okHit = l.accepted === 0 || l.hit >= 0.8;
    if (!okScore || !okHit) gates++;
    console.log(`  ${okScore && okHit ? '✓' : '✗'} ${l.label} 中位 ${l.median.toFixed(1)}  命中区间 ${(l.hit * 100).toFixed(0)}% (${l.inBand}/${l.accepted})`);
    prev = l.median;
  }
  if (!gates) console.log('  阶梯成立');
  else console.log('  阶梯不成立：band 需要重测');
}

// 独立复核：铅笔求解器说"唯一解、且推得到"，穷举有权反驳它，而它没有反驳的余地。
// 这里覆盖全部五档全部出货盘 —— n ≤ 7，2^n 张真值表是本游戏买得到的奢侈。
console.log('\n== 独立计数复核（穷举解数，五档全量）==');
{
  let checked = 0;
  let bad = 0;
  let notUnique = 0;
  let drift = 0;
  for (const { tier, p } of boards) {
    const gate = { nishio: tier.nishio, chainWidth: tier.chainWidth };
    checked++;
    const c = countModels(p.puzzle, { budget: 100000 });
    if (c.status !== UNIQUE) {
      notUnique++;
      bad++;
      console.log(`  ✗ ${tier.label} ${p.seed}: 穷举判 ${c.status === 0 ? '无解' : `${c.models} 个解`}（铅笔判定唯一）`);
    } else if (!matchesTruth(p.puzzle, p.truth)) {
      bad++;
      console.log(`  ✗ ${tier.label} ${p.seed}: 穷举唯一解不是出题人的 truth`);
    }
    // 复解必须复现同一个分数，否则分数是生成器状态的属性而不是盘面的属性。
    const again = solvableByPencil(p.n, p.statements, gate);
    if (!again || grade(again.result, again.puzzle, gate).score !== p.score) {
      drift++;
      bad++;
      console.log(`  ✗ ${tier.label} ${p.seed}: 复解分数 ${again ? grade(again.result, again.puzzle, gate).score : 'null'} ≠ ${p.score}`);
    }
    // 出货盘上不许有永真永假的证词：它不约束任何人，白送难度分。
    for (const st of p.statements) {
      if (!validStatement(p.n, st)) {
        bad++;
        console.log(`  ✗ ${tier.label} ${p.seed}: 第 ${st.id} 句对自己没有约束力`);
      }
    }
  }
  console.log(`  ${checked - bad}/${checked} 局穷举复核、复解分数与证词合法性全部一致`);
  if (notUnique) gates += notUnique;
  if (drift) gates += drift;
}

// 求解器自己的账：出货盘必须从空盘被本档的门槛推到底，而低档的盘里不许出现反证 ——
// "这一档不给玩家用这一手"既是准入门槛也是承诺。
console.log('\n== 求解器一致性（铅笔通道从空盘推完，低档不动用反证）==');
{
  let bad = 0;
  for (const { tier, p } of boards) {
    const r = solvePuzzle(p.puzzle, null, { useNishio: tier.nishio, chainWidth: tier.chainWidth });
    if (!r.solved) {
      bad++;
      console.log(`  ✗ ${tier.label} ${p.seed}: 出货盘从空盘推不到底`);
      continue;
    }
    if (!tier.nishio && (r.ruleUse[Rules.nishio] || 0) > 0) {
      bad++;
      console.log(`  ✗ ${tier.label} ${p.seed}: 本档禁反证，却记了 ${r.ruleUse[Rules.nishio]} 次`);
    }
  }
  console.log(`  从空盘复推一致：${boards.length - bad}/${boards.length} 局`);
  gates += bad;
}

console.log(`\n最慢档位 ${worst.toFixed(1)} ms/局`);
if (gates) {
  console.log(`\n门禁未通过：${gates} 项`);
  process.exit(1);
}
console.log('\n门禁全部通过');
