// 引擎单元测试，纯 Node 运行：`node tools/engine-test.mjs`。
//
// 这个仓库的风险不是算错，而是**不健全**：某条规则若写进一个方程其实钉不死的身份，
// 出货、提示、评分全都读它，于是它会自己证明自己唯一 —— "零猜测"和"唯一解"两句承诺
// 当场变成一枚硬币的文案。所以下面每一盘都是先在纸上推出的：期望值写成字面量，
// 不写求解器自己的输出，也不做任何快照收集。
//
// 纸上记号：骑士=1，无赖=0；一条证词写成一个方程 说话人=1 ⇔ 那句话为真。
//
//   盘 A  甲说「我是骑士」      ⇒ 0=1⇔0=0 与 1=1⇔1=1 两行都自洽 ⇒ 方程恒真，等于没说
//   盘 B  甲说「我是无赖」      ⇒ 甲=1 要它假、甲=0 要它真 ⇒ 0 行自洽，骗子悖论
//   盘 C  甲说「我和乙同类」    ⇒ 甲⇔(甲⇔乙) ⇒ 乙=1 恒成立，甲自己两个值都活着
//   盘 D  n=2 同上              ⇒ 只有 1 句，乙钉死、甲自由 ⇒ 2 个模型（这就是"不唯一"）
//   盘 E  甲说「我和乙同类」· 乙说「丙是无赖」· 丙说「甲是骑士」
//         ⇒ 乙=1（自指）⇒ 丙=0 ⇒ 甲=0 ⇒ 唯一解 (0,1,0)
//   盘 F  甲说「乙和丙同类」· 乙说「甲是骑士」· 丙说「甲是无赖」
//         ⇒ 每一句单独看都留两个以上取值；(甲,乙) 两句把 丙=1 钉住，(甲,丙) 两句把 乙=0 钉住，
//           最后 甲=0 由 甲 自己那句被关系锁定 ⇒ 唯一解 (0,0,1)，2 趟、2 笔联立
//   盘 G  甲说「我和乙同类」· 乙说「丙是无赖」· 丙说「甲是无赖」
//         · 乙说「甲、丙、丁里恰好有 1 个骑士」
//         ⇒ 乙=1、丙=0、甲=1 之后，那句「恰好 1 个」已经数到 1 ⇒ 丁=0（计数钉死）
//           ⇒ 唯一解 (1,1,0,0)，1 个 pass
//   盘 H  甲说「乙和丙里恰有 1 个骑士」· 甲说「乙和丙同类」（同一人两句，各自都算得动）
//         ⇒ 甲=1 要二者之一成立又要求二者同类；甲=0 要两个"非"同时成立，也开不出行
//           ⇒ 合起来 0 个模型：唯一性死在证词组互相矛盾，而不是死在推不出来

import {
  P, KNIGHT, KNAVE, UNKNOWN, Rules, RuleWeight, NAMES,
  createPuzzle, emptyKnown, isComplete, personName, statementText, textOf,
  analyze, analyzeCluster, chainClusters, validStatement, constraintHolds,
  solvePuzzle, verify, diagnose, nextDeduction, hintOf, CHAIN_STMTS,
} from '../js/engine/logic.js';
import { countModels, matchesTruth, UNIQUE, NONE, MANY, OVERBUDGET } from '../js/engine/count.js';
import { TIERS, tierById, makePuzzle, grade, solvableByPencil } from '../js/engine/generate.js';

let pass = 0;
let fail = 0;
const eq = (name, got, want) => {
  if (String(got) === String(want)) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name}\n       got  ${got}\n       want ${want}`);
  }
};
const ok = (name, cond, detail = '') => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

// 手写的盘：createPuzzle 会补 id/rule/text，这里只给"谁说了什么"。
// 写法两种都收：[说话人, 命题]，或者已经是 { from, prop } 的证词。
const asStmt = (x) => (Array.isArray(x) ? { from: x[0], prop: x[1] } : x);
const puzzle = (n, specs) => createPuzzle(n, specs.map(asStmt));
const asInt = (a) => Array.from(a).join(',');

// ---------- 盘 A：甲说「我是骑士」是一句恒真的废话 ----------

{
  const stmt = { from: 0, prop: P.knight(0) };
  eq('盘 A validStatement 判它没有约束力（永真）', validStatement(1, stmt), false);
  eq('盘 A 换三人盘也一样（说话人的取值都在真值表里）', validStatement(3, stmt), false);
  const a = analyze(puzzle(3, [stmt]), 0, emptyKnown(3));
  eq('盘 A 单独推不出任何人的身份（甲是骑士、甲是无赖两行都活着）', asInt(a.forced.map((f) => `${personName(3, f.person)}=${f.value}`)), '');
}

// ---------- 盘 B：骗子悖论，整盘直接被拒 ----------

{
  const stmt = { from: 0, prop: P.knave(0) };
  const p = puzzle(1, [stmt]);
  eq('盘 B validStatement 判它永假', validStatement(1, stmt), false);
  const cnt = countModels(p);
  eq('盘 B 穷举：0 个模型', cnt.models, 0);
  eq('盘 B 穷举：判成无解（不是多解）', cnt.status, NONE);
  ok('盘 B 无解没有被折进 MANY', cnt.status !== MANY);
  eq('盘 B 无解时拿不出见证指派', cnt.witness, null);
  const r = solvePuzzle(p, null, { useNishio: false });
  eq('盘 B 铅笔求解器也推不出身份', r.solved, false);
  ok('盘 B 铅笔求解器报的是"证词无法自洽"', !!r.contradiction && r.contradiction.kind === '证词无法自洽', JSON.stringify(r.contradiction));
  eq('盘 B 冲突归到那条证词自己的形状', r.contradiction.rule, Rules.taut);
  eq('盘 B 过不了出题验收', solvableByPencil(1, [stmt], { nishio: false }), null);
}

// ---------- 盘 C：自指消去 —— 钉住别人，钉不住自己 ----------

{
  const stmt = { from: 0, prop: P.same(0, 1) };
  eq('盘 C 这句话有约束力', validStatement(2, stmt), true);
  eq('盘 C 形状归自指（说话人出现在自己证词里）', createPuzzle(2, [stmt]).statements[0].rule, Rules.taut);
  const a = analyze(puzzle(2, [stmt]), 0, emptyKnown(2));
  eq('盘 C 自指消去钉住的是乙', asInt(a.forced.map((f) => `${personName(2, f.person)}=${f.value}`)), `乙=${KNIGHT}`);
  eq('盘 C 自指消去钉不住甲自己（0,1 与 1,1 两行都活着）', a.rows, 2);
  eq('盘 C 穷举：乙被钉死，甲还自由 ⇒ 2 个模型', countModels(puzzle(2, [stmt])).status, MANY);
}

// ---------- 盘 E：自指那一手把全盘开局 ----------

{
  const p = puzzle(3, [
    [0, P.same(0, 1)],      // 甲说「我和乙同类」
    [1, P.knave(2)],        // 乙说「丙是无赖」
    [2, P.knight(0)],       // 丙说「甲是骑士」
  ]);
  const r = solvePuzzle(p, null, { useNishio: false });
  ok('盘 E 推到底', r.solved, JSON.stringify(r.contradiction));
  eq('盘 E 纸上解 (0,1,0)', asInt(r.known), [KNAVE, KNIGHT, KNAVE].join(','));
  eq('盘 E 一句一轮就全钉住了', r.passes, 1);
  eq('盘 E 自指只动用一次', r.ruleUse[Rules.taut], 1);
  eq('盘 E 另外两笔是直接身份', r.ruleUse[Rules.direct], 2);
  eq('盘 E 没有联立的份', r.ruleUse[Rules.chain] || 0, 0);
  const cnt = countModels(p);
  eq('盘 E 穷举判唯一', cnt.status, UNIQUE);
  eq('盘 E 穷举的指派与铅笔落的子一模一样', asInt(cnt.witness), asInt(r.known));
  ok('盘 E 出题人 truth 与之一致（matchesTruth）', matchesTruth(p, r.known));
  const hint = hintOf(p, r.events[0]);
  eq('盘 E 提示落点是乙', r.events[0].person, 1);
  ok('盘 E 提示带着那句自指证词', hint.includes(statementText(3, p.statements[0]).slice(0, 8)), hint);
  ok('盘 E 提示说清了结论', hint.includes('乙 是骑士'), hint);
}

// ---------- 盘 F：三句单句都推不动，只有联立能收口 ----------

{
  const p = puzzle(3, [
    [0, P.same(1, 2)],      // 甲说「乙和丙同类」
    [1, P.knight(0)],       // 乙说「甲是骑士」
    [2, P.knave(0)],        // 丙说「甲是无赖」
  ]);
  for (let ci = 0; ci < 3; ci++) {
    const a = analyze(p, ci, emptyKnown(3));
    ok(`盘 F 第 ${ci + 1} 句单独推不出任何人`, a.forced.length === 0, JSON.stringify(a.forced));
  }
  const clusters = chainClusters(p, emptyKnown(3), 2);
  eq('盘 F 两句一簇的候选数（C(3,2)）', clusters.length, 3);
  const pair = clusters.find((c) => asInt(c.stmts) === '0,1');
  const ac = analyzeCluster(p, pair, emptyKnown(3));
  eq('盘 F 甲乙两句联立只剩 2 种自洽指派', ac.rows, 2);
  eq('盘 F 那 2 行里 丙 都是骑士', asInt(ac.forced.map((f) => `${personName(3, f.person)}=${f.value}`)), `丙=${KNIGHT}`);
  // 纸上重算：s2 给出 C=¬A，两个分支（A=0,C=1）与（A=1,C=0）代回 s0 都要求 B=0 ⇒ 乙被这一簇钉死
  const pair2 = clusters.find((c) => asInt(c.stmts) === '0,2');
  const ac2 = analyzeCluster(p, pair2, emptyKnown(3));
  eq('盘 F 甲丙两句也各剩 2 行', ac2.rows, 2);
  eq('盘 F 钉的是乙（不是甲，也不是丙）', asInt(ac2.forced.map((f) => `${personName(3, f.person)}=${f.value}`)), `乙=${KNAVE}`);
  eq('盘 F 乙丙两句合起来什么也没说', analyzeCluster(p, clusters.find((c) => asInt(c.stmts) === '1,2'), emptyKnown(3)).forced.length, 0);
  const r = solvePuzzle(p, null, { useNishio: false, chainWidth: 2 });
  ok('盘 F 开着联立推到底', r.solved, JSON.stringify(r.contradiction));
  eq('盘 F 纸上解 (0,0,1)', asInt(r.known), [KNAVE, KNAVE, KNIGHT].join(','));
  eq('盘 F 第一笔是联立写的', r.events[0].rule, Rules.chain);
  eq('盘 F 联立那一笔记下了簇宽', r.events[0].cluster, 2);
  eq('盘 F 联立那一笔记下了行数', r.events[0].rows, 2);
  eq('盘 F 要两趟才推完', r.passes, 2);
  eq('盘 F 联立出场两次（丙、乙各一次）', r.ruleUse[Rules.chain], 2);
  eq('盘 F 最后一笔才是单句规则（甲由乙丙身份关系锁出）', r.events[r.events.length - 1].rule, Rules.relation);
  const off = solvePuzzle(p, null, { useNishio: false, chainWidth: 0 });
  ok('盘 F 关掉联立就卡死（联立是这盘的承重墙）', !off.solved && !off.contradiction);
  eq('盘 F 关掉联立后单句一个人都钉不住', asInt(off.known), [UNKNOWN, UNKNOWN, UNKNOWN].join(','));
  const cnt = countModels(p);
  eq('盘 F 穷举判唯一', cnt.status, UNIQUE);
  eq('盘 F 穷举指派 == 铅笔指派', asInt(cnt.witness), asInt(r.known));
  eq('盘 F 按纸上答案判胜', verify(p, Int8Array.from([KNAVE, KNAVE, KNIGHT])).ok, true);
  const wrong = verify(p, Int8Array.from([KNIGHT, KNIGHT, KNIGHT]));
  eq('盘 F 三人全是骑士被判违规', wrong.ok, false);
  eq('盘 F 违规落在丙那句上', wrong.stmt, 2);
  eq('盘 F 违规点名说话人丙', personName(p.n, wrong.person), '丙');
  // 分数按纸上推导：passes 2×1.3 + 联立 2×0.8 + 关系 0.6 + 首趟未定 1/3×12
  const g = grade(r, p, { chainWidth: 2 });
  eq('盘 F hard 分项', g.hard, 2.2);
  eq('盘 F 首趟未定比例（只剩甲没钉住）', g.firstRoundUnknown, 0.33);
  eq('盘 F 联立次数入分', g.chain, 2);
  eq('盘 F 总分', g.score, 8.8);
}

// ---------- 盘 G：「恰好 1 个骑士」数到人头把丁钉死 ----------

{
  const p = puzzle(4, [
    [0, P.same(0, 1)],               // 甲说「我和乙同类」
    [1, P.knave(2)],                 // 乙说「丙是无赖」
    [2, P.knave(0)],                 // 丙说「甲是无赖」
    [1, P.exactly(1, [0, 2, 3])],    // 乙说「甲、丙、丁里恰好有 1 个骑士」
  ]);
  eq('盘 G 计数那句的形状是计数钉死', p.statements[3].rule, Rules.count);
  eq('盘 G 计数那句的原文', textOf(4, p.statements[3].prop), '甲、丙、丁里恰好有 1 个骑士');
  const partial = Int8Array.from([KNIGHT, KNIGHT, KNAVE, UNKNOWN]);
  const a = analyze(p, 3, partial);
  eq('盘 G 人头已数满，只剩 1 行自洽', a.rows, 1);
  eq('盘 G 计数钉死死的是丁', asInt(a.forced.map((f) => `${personName(4, f.person)}=${f.value}`)), `丁=${KNAVE}`);
  const r = solvePuzzle(p, null, { useNishio: false });
  ok('盘 G 一轮推到底', r.solved && r.passes === 1, `${r.solved} / ${r.passes}`);
  eq('盘 G 纸上解 (1,1,0,0)', asInt(r.known), [KNIGHT, KNIGHT, KNAVE, KNAVE].join(','));
  eq('盘 G 计数那一笔确实落了子', r.ruleUse[Rules.count], 1);
  eq('盘 G 计数那一笔写的是丁', asInt(r.events.filter((e) => e.rule === Rules.count).map((e) => e.person)), '3');
  const hint = r.events.find((e) => e.rule === Rules.count);
  ok('盘 G 的提示点名丁', hintOf(p, hint).includes('丁 是无赖'), hintOf(p, hint));
  ok('盘 G 的提示引用那句计数证词', hintOf(p, hint).includes('恰好有 1 个骑士'), hintOf(p, hint));
  const cnt = countModels(p);
  eq('盘 G 穷举判唯一', cnt.status, UNIQUE);
  eq('盘 G 穷举指派 == 铅笔指派', asInt(cnt.witness), asInt(r.known));
  // 分数按纸上推导：passes 1×1.3 + 自指 2.0 + 直接 2×0.3 + 计数 0.9 + 首趟未定 0
  const g = grade(r, p, { chainWidth: 3 });
  eq('盘 G hard 分项', g.hard, 3.5);
  eq('盘 G 总分', g.score, 4.8);
}

// ---------- 盘 H：两句各自都算得动，合起来 0 个模型 ----------

{
  const s1 = { from: 0, prop: P.exactly(1, [1, 2]) };   // 甲说「乙和丙里恰好有 1 个骑士」
  const s2 = { from: 0, prop: P.same(1, 2) };            // 甲说「乙和丙同类」
  eq('盘 H 第一句自己不算废话', validStatement(3, s1), true);
  eq('盘 H 第二句自己不算废话', validStatement(3, s2), true);
  const p = puzzle(3, [s1, s2]);
  const cnt = countModels(p);
  eq('盘 H 穷举：0 个模型', cnt.models, 0);
  eq('盘 H 穷举判无解（不是多解）', cnt.status, NONE);
  ok('盘 H 的无解没有被折进 MANY', cnt.status !== MANY);
  const r = solvePuzzle(p, null, { useNishio: true });
  eq('盘 H 单句都推得动，所以矛盾只能由联立发现', r.contradiction.rule, Rules.chain);
  eq('盘 H 铅笔也判它推不完', r.solved, false);
  eq('盘 H 过不了出题验收', solvableByPencil(3, [s1, s2], { nishio: true, chainWidth: 3 }), null);
}

// ---------- count.js 与生成器的口径彼此独立 ----------

{
  const f = puzzle(3, [
    [0, P.same(1, 2)],
    [1, P.knight(0)],
    [2, P.knave(0)],
  ]);
  eq('预算截断算未验证，不算唯一', countModels(f, { budget: 1 }).status, OVERBUDGET);
  eq('21 人超出穷举规模直接拒数', countModels({ n: 21, statements: [] }).status, OVERBUDGET);
  const free = puzzle(3, [[0, P.knight(1)]]);   // 甲说「乙是骑士」：丙没人提
  const cf = countModels(free);
  eq('无约束的人让盘变成多解', cf.status, MANY);
  eq('数到 2 就停：报 MANY 而不是解数', cf.models, 2);
  eq('NONE 与 MANY 是两个不同的值', NONE !== MANY, true);
  eq('UNIQUE 是 1', UNIQUE, 1);
}

// ---------- 规则权重的阶梯必须还是那条阶梯 ----------

{
  // 空盘上的单人题：probe 推不出任何东西 ⇒ 首趟未定比例恒为 1 ⇒ hard 分项就是那一次落子的权重。
  const empty = createPuzzle(1, []);
  const weightOf = (rule) => grade({ ruleUse: { [rule]: 1 }, passes: 0, nishio: 0 }, empty, { chainWidth: 0 }).hard;
  const ladder = [Rules.direct, Rules.relation, Rules.chain, Rules.count, Rules.nest, Rules.taut];
  const got = ladder.map(weightOf);
  eq('阶梯权重逐个（直接/关系/联立/计数/复合/自指）', got.join(','), '0.3,0.6,0.8,0.9,1.4,2');
  ok('阶梯严格递增', got.every((v, i) => i === 0 || v > got[i - 1]), got.join(' → '));
  // 反证单独入分（2.6）+ 常数底 12 = 14.6，压过自指那一手的 14.2。
  eq('反证那一手的总分', grade({ ruleUse: {}, passes: 0, nishio: 1 }, empty, { chainWidth: 0 }).score, 14.6);
  ok('反证压过自指', grade({ ruleUse: {}, passes: 0, nishio: 1 }, empty, { chainWidth: 0 }).score
    > grade({ ruleUse: { [Rules.taut]: 1 }, passes: 0, nishio: 0 }, empty, { chainWidth: 0 }).score);
  // 提示优先给"最值钱的一手"用的是另一张表（RuleWeight），两张表必须是同一个序。
  const rw = ladder.map((k) => RuleWeight[k]);
  ok('RuleWeight 与评分阶梯同序', rw.every((v, i) => i === 0 || v > rw[i - 1]), rw.join(' → '));
  ok('反证在两张表里都在最上面', RuleWeight[Rules.nishio] > RuleWeight[Rules.taut]
    && grade({ ruleUse: {}, passes: 0, nishio: 2 }, empty, { chainWidth: 0 }).hard === 0);
}

// ---------- 五档出货：唯一解由穷举反驳，由 truth 复核 ----------

for (const tier of TIERS) {
  const gate = { nishio: tier.nishio, chainWidth: tier.chainWidth };
  let unique = 0;
  let shipped = 0;
  let vacuous = 0;
  let offBand = 0;
  let repro = 0;
  let hinted = 0;
  for (let s = 0; s < 6; s++) {
    const p = makePuzzle(`unit|${s}`, tier.id);
    if (!p) continue;
    shipped++;
    const cnt = countModels(p.puzzle, { budget: 100000 });
    if (cnt.status === UNIQUE) unique++;
    else console.log(`  ✗ ${tier.label} seed ${s} 穷举判 ${cnt.status}`);
    if (!matchesTruth(p.puzzle, p.truth)) console.log(`  ✗ ${tier.label} seed ${s} truth 与方程不符`);
    if (cnt.status === UNIQUE && asInt(cnt.witness) !== asInt(p.truth)) {
      console.log(`  ✗ ${tier.label} seed ${s} 穷举的那个解不是 truth`);
    }
    for (const st of p.statements) if (!validStatement(p.n, st)) vacuous++;
    if (p.score < tier.band[0] || p.score > tier.band[1]) offBand++;
    const again = makePuzzle(`unit|${s}`, tier.id);
    if (again && again.score === p.score && again.statements.length === p.statements.length
      && again.name === p.name && asInt(again.truth) === asInt(p.truth)) repro++;
    // 零猜测的正证：玩家唯一能走的那条路（nextDeduction）必须把这盘从空盘推到完。
    const known = emptyKnown(p.n);
    const sigs = new Set();
    let steps = 0;
    let broken = null;
    while (!isComplete(known) && steps <= p.n * 3) {
      const d = nextDeduction(p.puzzle, known, sigs);
      if (!d) { broken = '提示通道推不完这盘'; break; }
      if (known[d.person] !== UNKNOWN) { broken = `提示在重复落子 ${d.person}`; break; }
      if (!RuleWeight[d.rule]) { broken = `提示报了不认识的规则 ${d.rule}`; break; }
      const who = personName(p.n, d.person);
      const bare = `${who} 是${d.value === KNIGHT ? '骑士' : '无赖'}`;
      if (!d.text.includes(who) || d.text.length <= bare.length) { broken = `提示只是答案：${d.text}`; break; }
      sigs.add(d.sig);
      known[d.person] = d.value;
      steps++;
    }
    if (broken) console.log(`  ✗ ${tier.label} seed ${s}: ${broken}`);
    else if (asInt(known) !== asInt(p.truth)) console.log(`  ✗ ${tier.label} seed ${s}: 提示推完的身份不是 truth`);
    else hinted++;
  }
  eq(`${tier.label} 出货 6/6`, shipped, 6);
  eq(`${tier.label} 穷举全部判唯一解`, unique, 6);
  eq(`${tier.label} 盘上没有废话证词`, vacuous, 0);
  eq(`${tier.label} 出货都在本档区间内`, offBand, 0);
  eq(`${tier.label} 同种子复现同题`, repro, 6);
  eq(`${tier.label} 提示通道能从空盘推完`, hinted, 6);
}

// ---------- 见习档的每一盘都真的靠两句一簇收口 ----------

{
  let needingChain = 0;
  let stuckWithout = 0;
  for (let s = 0; s < 8; s++) {
    const p = makePuzzle(`trainee|${s}`, 'trainee');
    if (!p) continue;
    if (p.stats.chain > 0) needingChain++;
    const off = solvePuzzle(p.puzzle, null, { useNishio: false, chainWidth: 0 });
    if (!off.solved) stuckWithout++;
  }
  eq('见习 8/8 都动用了联立', needingChain, 8);
  eq('见习 8/8 关掉联立就推不完', stuckWithout, 8);
}

// ---------- 被证伪的假设 2 留作回归：全宽联立会把见习档抹成一个数 ----------

{
  // 把见习的联立宽度放回最宽（3 句）：三人三句的盘一把就推完，简单规则一次都出不了手，
  // 于是 8 盘读出同一个分数 —— "由浅入深"在最低档根本不存在。这条断言就是 chainWidth: 2
  // 这个参数的存在理由，它必须在（见习的）每一盘都成立，而不是只在平均上成立。
  const scores = new Set();
  let onlyChain = 0;
  let count = 0;
  for (let s = 0; s < 8; s++) {
    const p = makePuzzle(`trainee|${s}`, 'trainee');
    if (!p) continue;
    count++;
    const stmts = p.puzzle.statements.map((x) => ({ from: x.from, prop: x.prop }));
    const wide = solvableByPencil(p.n, stmts, { chainWidth: CHAIN_STMTS });
    if (!wide) continue;
    const writes = Object.keys(wide.result.ruleUse)
      .reduce((acc, k) => acc + wide.result.ruleUse[k], 0);
    if ((wide.result.ruleUse[Rules.chain] || 0) === writes && writes > 0) onlyChain++;
    scores.add(grade(wide.result, wide.puzzle, { chainWidth: CHAIN_STMTS }).score);
  }
  eq('全宽联立下每一盘都是 8 盘', count, 8);
  eq('全宽联立把见习的每一笔都变成联立', onlyChain, 8);
  eq('于是分数塌成单值（实测常数 3.7）', scores.size, 1);
  eq('塌成的那个常数就是它', [...scores].join(','), '3.7');
}

// ---------- 反证是大师档的承重墙，低档碰不到它 ----------

{
  let masterNeeds = 0;
  for (let s = 0; s < 8; s++) {
    const p = makePuzzle(`master|${s}`, 'master');
    if (!p) continue;
    const plain = solvePuzzle(p.puzzle, null, { useNishio: false, chainWidth: 3 });
    if (!plain.solved && p.stats.nishio > 0) masterNeeds++;
  }
  ok('大师档里存在"只能靠反证收口"的盘', masterNeeds > 0, `命中 ${masterNeeds}/8`);
  let lowNishio = 0;
  for (const tier of TIERS.filter((t) => !t.nishio)) {
    for (let s = 0; s < 6; s++) {
      const p = makePuzzle(`low|${s}`, tier.id);
      if (p && p.stats.nishio > 0) lowNishio++;
    }
  }
  eq('低三档一盘都不许用反证', lowNishio, 0);
}

// ---------- 出货规模：人数、最少证词数、混合身份 ----------

{
  let bad = 0;
  for (const tier of TIERS) {
    for (let s = 0; s < 4; s++) {
      const p = makePuzzle(`size|${s}`, tier.id);
      if (!p) continue;
      const minStmts = Math.max(3, tier.n - 1);
      if (p.n !== tier.n) bad++;
      if (p.statements.length < minStmts) bad++;
      if (p.knights === 0 || p.knights === p.n) bad++;
      if (p.statements.some((st) => st.from >= p.n)) bad++;
    }
  }
  eq('出货规模全部合规（人数/最少句数/至少一骑士一赖）', bad, 0);
}

// ---------- TIERS 的 band 是量出来的选取目标，不是装饰 ----------

{
  const bands = TIERS.map((t) => t.band);
  eq('五档区间按实测分位写死', JSON.stringify(bands), '[[8,9],[9,15],[15,19],[19,29],[29,34]]');
  let adjacent = true;
  for (let i = 1; i < TIERS.length; i++) {
    if (bands[i][0] !== bands[i - 1][1]) adjacent = false;
    if (!(bands[i][1] > bands[i][0])) adjacent = false;
  }
  ok('区间相邻、不重叠、递增', adjacent, JSON.stringify(bands));
  // 专家与大师的分离靠的是大师下界压在专家实测中位之上，不是靠人数贴标签。
  const expertMedian = 27.6;   // tools/balance.mjs 40 局实测（选取后；选取前 22.7）
  const expertPreSelectorMedian = 22.7;   // tries:1 抽样 240 局
  ok('大师下界压过专家的中位分数', TIERS[4].band[0] > expertMedian, `${TIERS[4].band[0]} vs ${expertMedian}`);
  ok('连不选取时的专家中位也被大师下界压住', TIERS[4].band[0] > expertPreSelectorMedian,
    `${TIERS[4].band[0]} vs ${expertPreSelectorMedian}`);
  eq('联立宽度只可能是实测出的地板 2 或 3', TIERS.every((t) => t.chainWidth === 2 || t.chainWidth === 3), true);
  eq('只有见习档把联立收到两句', TIERS.filter((t) => t.chainWidth < CHAIN_STMTS).map((t) => t.id).join(','), 'trainee');
  eq('人数逐档递增', TIERS.map((t) => t.n).join(','), '3,4,5,6,7');
  eq('tierById 认得每个 id', TIERS.every((t) => tierById(t.id) === t), true);
  eq('tierById 不认识的落回见习', tierById('nope').id, 'trainee');
}

// ---------- 出题必须是种子的纯函数：不许留下副作用 ----------

{
  // rng.shuffle 是就地打乱的。buildStatements 若直接洗 tier.shapes（大师档洗的是模块级
  // 那张 ALL_SHAPES），每一次调用都把这张表重排一遍，于是同一颗种子在第二次调用时抽出
  // 另一副题 —— rng.js 的第一条承诺（"每日盘和验证器对『第 N 局』的共识"）当场失效。
  const snapshot = JSON.stringify(TIERS.map((t) => t.shapes));
  const before = makePuzzle('purity|0', 'master');
  for (let s = 1; s < 10; s++) for (const t of TIERS) makePuzzle(`purity|${s}`, t.id);
  eq('出题不改动 TIERS.shapes（洗进去的是副本）', JSON.stringify(TIERS.map((t) => t.shapes)), snapshot);
  eq('大师档用的就是那张模块级表，顺序仍是声明序',
    TIERS[4].shapes.join(','), 'direct,relation,count,taut,nest');
  const after = makePuzzle('purity|0', 'master');
  eq('跑过别人以后，同一颗种子仍抽出同一副题',
    `${after.score}|${after.stats.statements}|${after.statements.map((x) => x.from).join(',')}`,
    `${before.score}|${before.stats.statements}|${before.statements.map((x) => x.from).join(',')}`);
}

// ---------- diagnose 只看已经发生的事实，不做推理 ----------

{
  const p = puzzle(3, [
    [0, P.same(1, 2)],
    [1, P.knight(0)],
    [2, P.knave(0)],
  ]);
  eq('盘 F 的正确标注不报冲突', diagnose(p, Int8Array.from([KNAVE, KNAVE, KNIGHT])).stmts.size, 0);
  const wrong = diagnose(p, Int8Array.from([KNIGHT, KNIGHT, KNIGHT]));
  ok('盘 F 全骑士被 diagnose 抓到', wrong.stmts.has(2), JSON.stringify([...wrong.stmts]));
  eq('盘 F 抓到的是说这句话的丙', NAMES[[...wrong.people][0]], '丙');
  const half = diagnose(p, Int8Array.from([UNKNOWN, KNIGHT, UNKNOWN]));
  eq('盘 F 只标了乙：还没有任何已发生的事实可反对', half.stmts.size, 0);
  eq('盘 F 没标满不判胜', verify(p, Int8Array.from([UNKNOWN, KNIGHT, KNIGHT])).ok, false);
  ok('盘 F 说话人已定而补全全不符时报冲突', diagnose(p, Int8Array.from([KNAVE, KNIGHT, KNAVE])).stmts.size > 0);
}

// ---------- 出题的 truth 必须就是它自己那局的解 ----------

{
  let broken = 0;
  for (const tier of TIERS) {
    for (let s = 0; s < 5; s++) {
      const p = makePuzzle(`truth|${s}`, tier.id);
      if (!p) continue;
      for (const st of p.statements) if (!constraintHolds(p.truth, st)) broken++;
      // 剪到最小之后仍要过同一道门槛：验收用的规则和这一档声明的规则必须一致。
      if (!solvableByPencil(p.n, p.statements, { nishio: tier.nishio, chainWidth: tier.chainWidth })) broken++;
    }
  }
  eq('心里那个指派满足盘上每一句话，且复得过验收', broken, 0);
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
