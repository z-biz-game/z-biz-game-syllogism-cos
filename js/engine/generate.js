// 出题：一组对话 → 修剪到最小 → 打分 → 五档表。
//
// TIERS 里的 band 是 tools/balance.mjs **实测**出来的选取目标，不是拍脑袋的标签：
// 每一档一直抽题，直到分数落进自己的区间才算出货（见 DESIGN.md 第 4 节）。

import { makeRng } from './rng.js';
import {
  P, KNIGHT, KNAVE, Rules, createPuzzle, constraintHolds, validStatement,
  solvePuzzle, isAtomic, textOf, varsOf, CHAIN_STMTS,
} from './logic.js';

const SHAPE_DIRECT = 'direct';
const SHAPE_RELATION = 'relation';
const SHAPE_COUNT = 'count';
const SHAPE_TAUT = 'taut';
const SHAPE_NEST = 'nest';
const ALL_SHAPES = [SHAPE_DIRECT, SHAPE_RELATION, SHAPE_COUNT, SHAPE_TAUT, SHAPE_NEST];

// `chainWidth` 是第二道门槛（和 nishio 一样只管出题验收，不管玩家能用哪条规则）：
// 一局最多"联立几句证词"。见习档只许两句一组，于是必须三句才能钉住的盘在它这里
// 就不合格 —— 这才是本游戏读得出差异的难度阶梯。
// 两个被实测证伪的假设，留在代码里免得有人再试一遍：
//   1) 把联立做成开/关：关掉以后见习 0/40 出货。空盘上单句规则推不出任何东西（不
//      知道说话人是谁，就判不了他这句话的真假），"不用联立"不等于"简单"，等于"不存在"。
//   2) 只靠人数递增排五档：把见习的联立也开到最宽（3 句）时，三句话一把推完，简单规则
//      根本没有出手的机会，120 局全部读出同一个数（今天 3.7，链权重还是 0 的那版是 1.3）
//      —— 读数塌成常数，档位在分数轴上不存在。
// 边界读的是"不分区间时"各档首选题的实测分位（tries:1 抽样 240 局；联立权重 0.8）：
//   见习 8.5 / 8.8 两值（恒进带）· 熟练 8.6 / 12.4 / 14.8，进带 9–15 约四成
//   老手 13.5 / 16.7 / 18.2，进带 15–19 约五成 · 专家 18.8 / 22.7 / 27.9（max 29.6），进带 19–29 约七成
//   大师 20.9 / 27.7 / 30.8（max 32.2），进带 29–34 约四成
// 三个数依次是 p25 / 中位 / p75。选取后出货的分数分位（balance 40 局）是
// 8.5 / 14.8 / 17.5 / 27.6 / 30.8 —— 五段相邻、不重叠、递增；大师的下界 29 压在专家的
// 实测中位（选取前 22.7、选取后 27.6）之上 —— 这是"专家/大师重叠"那一病的唯一解药：
// 不靠人数递增贴标签，靠选取把两档在分数轴上切开。
// 命中率四成到全部 = 平均每档抽 1–2.5 次即进带（加上验收失败后 balance 读到 1.9–4.8 次），
// 和明路同量级（它的大师档约 22 次），耗时仍是毫秒级。
// 见习的两个值不是量的误差，是结构：3 人 3 句的盘固定 passes=2、联立 2 笔、首圈只剩 1 人
// 未知，能动的只有那一笔非联立落子是"直接身份"还是"关系锁定"（差 0.3）。要把它的分数
// 拉散，得改 n / want / prune，不是改 band 或权重。
export const TIERS = [
  { id: 'trainee', label: '见习', n: 3, shapes: [SHAPE_DIRECT, SHAPE_RELATION], want: 4, prune: 0.3, chainWidth: 2, nishio: false, band: [8, 9] },
  { id: 'apprentice', label: '熟练', n: 4, shapes: [SHAPE_DIRECT, SHAPE_RELATION, SHAPE_COUNT], want: 5, prune: 0.5, chainWidth: 3, nishio: false, band: [9, 15] },
  { id: 'regular', label: '老手', n: 5, shapes: [SHAPE_DIRECT, SHAPE_RELATION, SHAPE_COUNT, SHAPE_TAUT], want: 7, prune: 0.7, chainWidth: 3, nishio: false, band: [15, 19] },
  { id: 'expert', label: '专家', n: 6, shapes: [SHAPE_DIRECT, SHAPE_RELATION, SHAPE_COUNT, SHAPE_TAUT, SHAPE_NEST], want: 8, prune: 0.85, chainWidth: 3, nishio: true, band: [19, 29] },
  { id: 'master', label: '大师', n: 7, shapes: ALL_SHAPES, want: 10, prune: 1, chainWidth: 3, nishio: true, band: [29, 34] },
];

export function tierById(id) {
  return TIERS.find((t) => t.id === id) || TIERS[0];
}

const NAME_A = ['守夜', '岔路', '钟楼', '旧港', '雾中', '长亭', '逆旅', '深巷', '高塔', '雨夜', '空舱', '独木桥'];
const NAME_B = ['的证词', '之问', '夜话', '疑云', '局', '群像', '回响', '残章', '口供', '旁听'];

// ---------------------------------------------------------------------------
// 语料：从语法里抽一句证词
// ---------------------------------------------------------------------------

function others(rng, n, exclude) {
  const pool = [];
  for (let i = 0; i < n; i++) if (i !== exclude) pool.push(i);
  return rng.shuffle(pool);
}

function subsetOf(rng, n, { min = 2, max = 4, exclude = -1 } = {}) {
  const pool = others(rng, n, exclude);
  const hi = Math.min(max, pool.length);
  if (hi < min) return null;
  const k = rng.range(min, hi);
  return pool.slice(0, k).sort((a, b) => a - b);
}

// 抽一个原子命题。`withPerson` 用来强制把说话人放进证词里（自指那一类全靠它）。
function atomicProp(rng, n, allowed, withPerson) {
  const kinds = ['knight', 'knave', 'same', 'diff', 'allk', 'nonel', 'somal', 'exactly', 'atleast', 'atmost']
    .filter((k) => allowed.includes(k));
  const kind = rng.pick(kinds);
  if (kind === 'knight' || kind === 'knave') {
    const pool = withPerson !== null && withPerson !== undefined ? [withPerson] : others(rng, n, -1);
    if (!pool.length) return null;
    const i = rng.pick(pool);
    return kind === 'knight' ? P.knight(i) : P.knave(i);
  }
  if (kind === 'same' || kind === 'diff') {
    if (withPerson !== null && withPerson !== undefined) {
      const pool = others(rng, n, withPerson);
      if (!pool.length) return null;
      const j = rng.pick(pool);
      return kind === 'same' ? P.same(withPerson, j) : P.diff(withPerson, j);
    }
    const pool = others(rng, n, -1);
    if (pool.length < 2) return null;
    const [i, j] = [pool[0], pool[1]];
    return kind === 'same' ? P.same(i, j) : P.diff(i, j);
  }
  const xs = subsetOf(rng, n, { min: 2, max: Math.min(4, n - (withPerson === undefined ? 0 : 1)), exclude: withPerson === null ? -1 : undefined });
  if (!xs) return null;
  const set = withPerson !== null && withPerson !== undefined ? [...xs, withPerson].sort((a, b) => a - b) : xs;
  switch (kind) {
    case 'allk': return P.allKnight(set);
    case 'nonel': return P.noneKnight(set);
    case 'somal': return P.someKnight(set);
    case 'exactly': return P.exactly(rng.range(1, Math.max(1, set.length - 1)), set);
    case 'atleast': return P.atLeast(rng.range(1, set.length), set);
    case 'atmost': return P.atMost(rng.range(0, set.length - 1), set);
    default: return null;
  }
}

const COMBS = ['and', 'or', 'imp', 'iff'];

// 按形状抽一句命题。形状决定这局要用哪一种推理，也就直接决定难度读数。
export function randomProp(rng, n, from, shape) {
  if (shape === SHAPE_TAUT) {
    return atomicProp(rng, n, ['same', 'diff', 'knight', 'knave', 'somal', 'allk'], from);
  }
  if (shape === SHAPE_DIRECT) {
    const a = atomicProp(rng, n, ['knight', 'knave'], null);
    return a && !varsOf(a).includes(from) ? a : null;
  }
  if (shape === SHAPE_RELATION) {
    const a = atomicProp(rng, n, ['same', 'diff'], null);
    return a && !varsOf(a).includes(from) ? a : null;
  }
  if (shape === SHAPE_COUNT) {
    const a = atomicProp(rng, n, ['allk', 'nonel', 'somal', 'exactly', 'atleast', 'atmost'], null);
    return a && !varsOf(a).includes(from) ? a : null;
  }
  // 复合：两个原子命题用一个连接词缝起来。说话人出现在里面就归 taut，不归这里。
  const a = atomicProp(rng, n, ['knight', 'knave', 'same', 'diff', 'somal', 'allk', 'nonel', 'exactly'], null);
  const b = atomicProp(rng, n, ['knight', 'knave', 'same', 'diff', 'somal', 'allk', 'nonel', 'exactly'], null);
  if (!a || !b) return null;
  const comb = rng.pick(COMBS);
  const joined = comb === 'and' ? P.and(a, b) : comb === 'or' ? P.or(a, b)
    : comb === 'imp' ? P.ifThen(a, b) : P.iff(a, b);
  return rng.chance(0.18) ? P.not(joined) : joined;
}

function makeStatement(rng, n, truth, from, shape) {
  for (let tries = 0; tries < 26; tries++) {
    const prop = randomProp(rng, n, from, shape);
    if (!prop) continue;
    const stmt = { from, prop };
    // 两道门：这句话得对"谁是骑士"有所约束（永真永假都不行），
    // 并且必须和心里那个指派自洽 —— 否则它压根不是那一局会说出口的话。
    if (!validStatement(n, stmt)) continue;
    if (!constraintHolds(truth, stmt)) continue;
    return stmt;
  }
  return null;
}

// 一局的对话集：先把每个人至少问上一句，再按需要补第二句（不超过每人两句）。
// 洗 shapes 必须先复制：rng.shuffle 是就地打乱的，直接洗 tier.shapes（大师档洗的是模块级
// 的 ALL_SHAPES）会让每一次调用都把这张表重新排一遍序 —— 于是同一颗种子在第二次调用时
// 抽到的是另一副题，"每日盘和验证器对『第 N 局』的共识"（rng.js 的第一条承诺）当场失效。
export function buildStatements(rng, n, truth, shapes, want) {
  const picked = [];
  const seen = new Set();
  const spoken = new Map();
  const speakers = rng.shuffle(Array.from({ length: n }, (_, i) => i));
  const attempts = [];
  for (const sp of speakers) for (const shape of rng.shuffle(shapes.slice())) attempts.push({ sp, shape });
  for (let round = 0; picked.length < want && round < 3; round++) {
    for (const { sp, shape } of rng.shuffle(attempts.slice())) {
      if (picked.length >= want) break;
      if ((spoken.get(sp) || 0) >= (round === 0 ? 1 : 2)) continue;
      const stmt = makeStatement(rng, n, truth, sp, shape);
      if (!stmt) continue;
      const key = `${stmt.from}|${textOf(n, stmt.prop)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(stmt);
      spoken.set(sp, (spoken.get(sp) || 0) + 1);
    }
  }
  return picked;
}

// ---------------------------------------------------------------------------
// 验收与修剪
// ---------------------------------------------------------------------------

// 只用铅笔规则从空盘推到所有人的身份。推不到底的题直接丢弃 —— 这是准入门槛，
// 不是文案。低档连反证都不许用，联立也只许到本档的宽度。
// 门槛必须整体从 tier 上取：这里曾经写成 `chain: tier.chain`，而 TIERS 上的键叫
// `chainWidth`，于是 undefined 一路传到 propagate 的默认值 3 —— 见习档的"只许两句一组"
// 从来没有生效过，五档共用同一个准入宽度，band 再怎么测也只是在给同一族盘贴标签。
export function solvableByPencil(n, statements, { nishio = false, chainWidth = CHAIN_STMTS } = {}) {
  const puzzle = createPuzzle(n, statements);
  const r = solvePuzzle(puzzle, null, { useNishio: nishio, chainWidth });
  return r.solved ? { puzzle, result: r } : null;
}

// 一条一条试撤。每撤一条都要求"仍然只用铅笔推得完"，所以撤完之后既没变多解、
// 也没变需要猜。这就是本游戏唯一的难度旋钮（另一个是人数）。
function pruneStatements(n, statements, rng, cfg) {
  const kept = statements.slice();
  for (const idx of rng.shuffle(statements.map((s) => s.index))) {
    if (kept.length <= Math.max(3, n - 1)) break;
    const pos = kept.findIndex((s) => s.index === idx);
    if (pos < 0) continue;
    const candidate = kept.slice();
    candidate.splice(pos, 1);
    if (!solvableByPencil(n, candidate.map(stripIndex), cfg)) continue;
    kept.splice(pos, 1);
  }
  return kept;
}

function stripIndex(s) { return { from: s.from, prop: s.prop }; }

// ---------------------------------------------------------------------------
// 打分：读的是已验收那次求解的产物，不是对题面的猜测
// ---------------------------------------------------------------------------

export function grade(result, puzzle, { chainWidth = CHAIN_STMTS } = {}) {
  if (!result) return null;
  const use = result.ruleUse;
  const chain = use[Rules.chain] || 0;
  // 联立的权重压在 计数钉死（0.9）之下，但不是 0。
  // 记 0 时它把阶梯最浅的一格整个抹平：三人三句的盘钉死 1 人之后，剩下两人只能并起来
  // 看，于是见习档写进去的每一笔都是联立，score 恒等于 passes×1.3 + 首圈未知 —— 同一档
  // 的每一次出货都读出同一个数，"由浅入深"在最低档无从谈起。0.8 是量出来的
  // （tools/balance.mjs）：它让见习落在 8.5 / 8.8 两个可读的值上，同时把熟练的整段分布
  // 抬到 p25 8.6 / 中位 12.4 / p75 14.8，两档之间第一次留出可选型的缝隙。再往上给就越
  // 过计数——三句话一起看是本游戏人人都会动用的一手，它的次数是"句数"的读数而不是
  // "深度"的读数，权重必须留在 直接 < 关系 < 联立 < 计数 < 复合 < 自指 < 反证。
  const hard = (use[Rules.taut] || 0) * 2.0 + (use[Rules.nest] || 0) * 1.4
    + (use[Rules.count] || 0) * 0.9 + chain * 0.8
    + (use[Rules.relation] || 0) * 0.6 + (use[Rules.direct] || 0) * 0.3;
  // "第一眼看住多少" 必须按本档的联立宽度来问：探针绕过 chainWidth 时，见习档的
  // 这一项在别的档读到 0 的同时自己也读到 0，阶梯最浅的一格就此没有读数。
  const oneRound = solvePuzzle(puzzle, null, { useNishio: false, chainWidth, maxRounds: 1 });
  let unknownAfterOne = 0;
  for (let i = 0; i < puzzle.n; i++) if (oneRound.known[i] < 0) unknownAfterOne++;
  const firstRoundUnknown = unknownAfterOne / puzzle.n;
  return {
    score: Math.round((result.passes * 1.3 + hard + result.nishio * 2.6
      + Math.min(firstRoundUnknown, 1) * 12) * 10) / 10,
    passes: result.passes,
    hard: Math.round(hard * 10) / 10,
    nishio: result.nishio,
    chain,
    firstRoundUnknown: Math.round(firstRoundUnknown * 100) / 100,
    taut: use[Rules.taut] || 0,
    nest: use[Rules.nest] || 0,
  };
}

export function makePuzzle(seed, tierId, { tries = 260 } = {}) {
  const tier = tierById(tierId);
  const n = tier.n;
  const base = `${seed}|${tier.id}|${n}`;
  const rng = makeRng(base);
  const gate = { nishio: tier.nishio, chainWidth: tier.chainWidth };
  const offBand = (score) => (tier.band[1] <= tier.band[0] ? 0
    : score < tier.band[0] ? tier.band[0] - score : Math.max(0, score - tier.band[1]));
  let best = null;
  for (let attempt = 0; attempt < tries; attempt++) {
    const truth = new Int8Array(n);
    for (let i = 0; i < n; i++) truth[i] = rng.chance(0.5) ? KNIGHT : KNAVE;
    // 全员同一个身份的题目读起来像陷阱而不像推理，而且它让"恰好 k 个骑士"这一类
    // 证词退化成一句话。所以钉死：至少一个骑士、至少一个无赖。
    if (!truth.includes(KNIGHT) || !truth.includes(KNAVE)) continue;
    let statements = buildStatements(rng, n, truth, tier.shapes, tier.want);
    if (statements.length < Math.max(3, n - 1)) continue;
    statements = statements.map((s, index) => ({ ...s, index }));
    if (!solvableByPencil(n, statements.map(stripIndex), gate)) continue;
    const pruned = pruneStatements(n, statements, rng, gate);
    const accepted = solvableByPencil(n, pruned.map(stripIndex), gate);
    if (!accepted) continue;
    const g = grade(accepted.result, accepted.puzzle, gate);
    const dist = offBand(g.score);
    if (!best || dist < best.dist || (dist === best.dist && g.score > best.g.score)) {
      best = { puzzle: accepted.puzzle, result: accepted.result, g, truth, statements: pruned, attempt, dist };
    }
    if (!dist) break;
  }
  if (!best) return null;
  const truth = best.truth;
  let knights = 0;
  for (let i = 0; i < n; i++) if (truth[i] === KNIGHT) knights++;
  const nameRng = makeRng(`${base}|name`);
  return {
    n,
    truth: Int8Array.from(truth),
    knights,
    statements: best.puzzle.statements.map((s) => ({ id: s.id, from: s.from, prop: s.prop, text: s.text, rule: s.rule })),
    puzzle: best.puzzle,
    seed: base,
    originSeed: seed,
    tier: tier.id,
    name: `${nameRng.pick(NAME_A)}${nameRng.pick(NAME_B)}`,
    score: best.g.score,
    stats: { ...best.g, statements: best.puzzle.statements.length, attempts: best.attempt + 1, inBand: best.dist === 0 },
  };
}
