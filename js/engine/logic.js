// 证词 · Syllogism 的命题语言与铅笔求解器。
//
// 玩法是一屏对话：每个人要么是骑士（说的每一句都为真），要么是无赖（说的每一句都为假）。
// 玩家要做的不是猜谁像好人，而是把每条证词读成一个关于"谁说真话"的方程，然后解出所有人。
//
// 这个文件里的 solvePuzzle() 是玩家唯一可走的路：出题验收、提示、难度评分全部读它，
// 所以它必须"只在某个身份真的被方程钉死时才落子"。一旦它写进一个自己的理由推不出的值，
// 它就会自己证明自己唯一 —— 于是出货一个悄悄有两个解的盘。
// js/engine/count.js 因此是一份不带任何推理逻辑的穷举，专门用来反驳这里。

export const KNIGHT = 1;
export const KNAVE = 0;
export const UNKNOWN = -1;

export const NAMES = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬'];

export function personName(n, i) {
  return NAMES[i] || `第${i + 1}人`;
}

export function listOf(n, xs) {
  return xs.map((i) => personName(n, i)).join('、');
}

// ---------------------------------------------------------------------------
// 命题 AST
// ---------------------------------------------------------------------------
//
// 只有三种原子（某人是骑士 / 某两人同类 / 某几人里有几个骑士），加上五个连接词。
// 每一个都必须在真值表上算得动 —— 这个游戏的"难度"最终要落到真值表上，
// 所以语言里不留任何需要求解器之外知识才能读的构造。

export const P = {
  knight: (i) => ({ t: 'knight', xs: [i] }),
  knave: (i) => ({ t: 'knave', xs: [i] }),
  same: (i, j) => ({ t: 'same', xs: [i, j] }),
  diff: (i, j) => ({ t: 'diff', xs: [i, j] }),
  allKnight: (xs) => ({ t: 'allk', xs: xs.slice() }),
  noneKnight: (xs) => ({ t: 'nonel', xs: xs.slice() }),
  someKnight: (xs) => ({ t: 'somal', xs: xs.slice() }),
  exactly: (k, xs) => ({ t: 'exactly', k, xs: xs.slice() }),
  atLeast: (k, xs) => ({ t: 'atleast', k, xs: xs.slice() }),
  atMost: (k, xs) => ({ t: 'atmost', k, xs: xs.slice() }),
  and: (a, b) => ({ t: 'and', a, b }),
  or: (a, b) => ({ t: 'or', a, b }),
  not: (a) => ({ t: 'not', a }),
  ifThen: (a, b) => ({ t: 'imp', a, b }),
  iff: (a, b) => ({ t: 'iff', a, b }),
};

const ATOMIC = { knight: 1, knave: 1, same: 1, diff: 1, allk: 1, nonel: 1, somal: 1, exactly: 1, atleast: 1, atmost: 1 };
export const COMPOUND_KINDS = ['and', 'or', 'not', 'ifThen', 'iff'];

export function isAtomic(prop) { return !!ATOMIC[prop.t]; }

// 这条命题提到了谁。自指（说话人出现在自己证词里）是这游戏最锋利的一类线索，
// 所以"提到谁"必须算得准。
export function varsOf(prop, into = []) {
  if (prop.xs) for (const x of prop.xs) if (!into.includes(x)) into.push(x);
  if (prop.a) varsOf(prop.a, into);
  if (prop.b) varsOf(prop.b, into);
  return into;
}

// env 是一个完整指派（0/1 数组）。真值表就是全部语义，没有别的规定。
export function evalProp(env, prop) {
  const v = prop.xs ? prop.xs.map((i) => env[i]) : null;
  switch (prop.t) {
    case 'knight': return env[prop.xs[0]] === KNIGHT;
    case 'knave': return env[prop.xs[0]] === KNAVE;
    case 'same': return env[prop.xs[0]] === env[prop.xs[1]];
    case 'diff': return env[prop.xs[0]] !== env[prop.xs[1]];
    case 'allk': return v.every((x) => x === KNIGHT);
    case 'nonel': return v.every((x) => x === KNAVE);
    case 'somal': return v.some((x) => x === KNIGHT);
    case 'exactly': return v.filter((x) => x === KNIGHT).length === prop.k;
    case 'atleast': return v.filter((x) => x === KNIGHT).length >= prop.k;
    case 'atmost': return v.filter((x) => x === KNIGHT).length <= prop.k;
    case 'and': return evalProp(env, prop.a) && evalProp(env, prop.b);
    case 'or': return evalProp(env, prop.a) || evalProp(env, prop.b);
    case 'not': return !evalProp(env, prop.a);
    case 'imp': return !evalProp(env, prop.a) || evalProp(env, prop.b);
    case 'iff': return evalProp(env, prop.a) === evalProp(env, prop.b);
    default: throw new Error(`未知命题类型 ${prop.t}`);
  }
}

// 一条证词 = 一个说话人 + 一句命题。规则本身把它写成一个方程：
//     说话人是骑士  ⇔  这句命题为真
// 于是"谁说了什么"整盘就是一组布尔方程，解就是所有人的身份。
export function constraintHolds(env, stmt) {
  return (env[stmt.from] === KNIGHT) === evalProp(env, stmt.prop);
}

export function textOf(n, prop) {
  switch (prop.t) {
    case 'knight': return `${personName(n, prop.xs[0])}是骑士`;
    case 'knave': return `${personName(n, prop.xs[0])}是无赖`;
    case 'same': return `${personName(n, prop.xs[0])}和${personName(n, prop.xs[1])}同类`;
    case 'diff': return `${personName(n, prop.xs[0])}和${personName(n, prop.xs[1])}不同类`;
    case 'allk': return `${listOf(n, prop.xs)}全是骑士`;
    case 'nonel': return `${listOf(n, prop.xs)}全是无赖`;
    case 'somal': return `${listOf(n, prop.xs)}里有骑士`;
    case 'exactly': return `${listOf(n, prop.xs)}里恰好有 ${prop.k} 个骑士`;
    case 'atleast': return `${listOf(n, prop.xs)}里至少有 ${prop.k} 个骑士`;
    case 'atmost': return `${listOf(n, prop.xs)}里至多有 ${prop.k} 个骑士`;
    case 'and': return `${textOf(n, prop.a)}，而且${textOf(n, prop.b)}`;
    case 'or': return `${textOf(n, prop.a)}，或者${textOf(n, prop.b)}`;
    case 'not': return `并非${textOf(n, prop.a)}`;
    case 'imp': return `如果${textOf(n, prop.a)}，那么${textOf(n, prop.b)}`;
    case 'iff': return `${textOf(n, prop.a)}，当且仅当${textOf(n, prop.b)}`;
    default: throw new Error(`未知命题类型 ${prop.t}`);
  }
}

export function statementText(n, stmt) {
  return `${personName(n, stmt.from)}说：「${textOf(n, stmt.prop)}」`;
}

// 推理形状的命名。它同时是提示里"用了哪条规则"的名字、以及难度评分的读数来源，
// 所以必须按证词的形状判定，而不是按求解器内部的哪一段代码起了作用。
export const Rules = {
  direct: '直接身份',
  relation: '关系锁定',
  count: '计数钉死',
  nest: '复合拆开',
  taut: '自指消去',
  chain: '联立真值表',
  nishio: '反证',
};

// 难度读数的阶梯。它必须和 generate.js 的 grade() 里那一串权重复用同一个序，
// 否则"提示优先给哪一手"和"这一盘难在哪里"是两套互不相干的账 —— 而 nextDeduction
// 挑的就是这张表里权重最高的那一手，所以它同时是提示的优先级。
// 序：直接身份 < 关系锁定 < 联立真值表 < 计数钉死 < 复合拆开 < 自指消去 < 反证。
// 联立排在计数之下：三句话一起看是本游戏每一档都会动用的默认动作（见习档的每一笔都是它），
// 它比"数人头"更常见、却不比"数人头"更难，把它放到计数之上会让浅档的分数读数只会数句数。
export const RuleWeight = {
  [Rules.direct]: 0.4,
  [Rules.relation]: 0.8,
  [Rules.chain]: 1.0,
  [Rules.count]: 1.3,
  [Rules.nest]: 1.7,
  [Rules.taut]: 2.2,
  [Rules.nishio]: 3.6,
};

export function shapeOf(stmt) {
  const { from, prop } = stmt;
  const vars = varsOf(prop);
  if (vars.includes(from)) return Rules.taut;
  if (!isAtomic(prop)) return Rules.nest;
  if (prop.t === 'knight' || prop.t === 'knave') return Rules.direct;
  if (prop.t === 'same' || prop.t === 'diff') return Rules.relation;
  return Rules.count;
}

// ---------------------------------------------------------------------------
// 棋盘
// ---------------------------------------------------------------------------

// statements 里每条都必须"既非永真亦非永假"，否则它不约束任何人（见 validStatement）。
export function createPuzzle(n, statements, names = NAMES) {
  return {
    n,
    names,
    statements: statements.map((s, i) => ({ ...s, id: i, rule: shapeOf(s), text: statementText(n, s) })),
  };
}

export function cloneKnown(known) {
  const out = new Int8Array(known.length);
  for (let i = 0; i < known.length; i++) out[i] = known[i];
  return out;
}

export function emptyKnown(n) {
  const k = new Int8Array(n);
  k.fill(UNKNOWN);
  return k;
}

export function isComplete(known) {
  for (let i = 0; i < known.length; i++) if (known[i] === UNKNOWN) return false;
  return true;
}

export function knownCount(known) {
  let c = 0;
  for (let i = 0; i < known.length; i++) if (known[i] !== UNKNOWN) c++;
  return c;
}

// ---------------------------------------------------------------------------
// 一条证词的单独推到底
// ---------------------------------------------------------------------------
//
// 说话人出现在自己证词里时，这个方程会自己消掉自己：
//     甲说「我和乙同类」  ⇒  甲 ⇔ (甲 ⇔ 乙)  ⇒  乙必是骑士
// 这是全游戏最反直觉、也最漂亮的一步，而它和"已知甲是骑士所以乙也是"用的是
// 同一张真值表 —— 所以这里只写一个 analyze()：把这条方程的所有自由变量列出来，
// 枚举真值表，滤掉与已知冲突的行，再看哪些人在剩下的行里只有一个取值。

export function analyze(puzzle, ci, known) {
  const stmt = puzzle.statements[ci];
  const vars = varsOf(stmt.prop);
  if (!vars.includes(stmt.from)) vars.push(stmt.from);
  const rows = [];
  let conflicting = 0;
  const bits = vars.length;
  for (let mask = 0; mask < (1 << bits); mask++) {
    const env = new Int8Array(puzzle.n).fill(KNAVE);
    let ok = true;
    for (let i = 0; i < bits; i++) {
      const val = (mask >> i) & 1;
      env[vars[i]] = val;
      if (known[vars[i]] !== UNKNOWN && known[vars[i]] !== val) { ok = false; break; }
    }
    if (!ok) { conflicting++; continue; }
    if (constraintHolds(env, stmt)) rows.push(vars.map((v) => env[v]));
  }
  if (!rows.length) {
    return { dead: { kind: '证词无法自洽', stmt: ci, slot: ci }, forced: [] };
  }
  const forced = [];
  for (let i = 0; i < bits; i++) {
    const only = rows[0][i];
    let stable = true;
    for (const r of rows) if (r[i] !== only) { stable = false; break; }
    if (stable && known[vars[i]] === UNKNOWN) forced.push({ person: vars[i], value: only });
  }
  return { forced, rows: rows.length, dead: null };
}

// 证词本身有没有信息：既不是对所有指派都成立（那等于没说），
// 也不是对所有指派都不成立（那根本不该出现在盘上）。
export function validStatement(n, stmt) {
  const vars = varsOf(stmt.prop);
  if (!vars.includes(stmt.from)) vars.push(stmt.from);
  let trueCount = 0, total = 0;
  for (let mask = 0; mask < (1 << vars.length); mask++) {
    const env = new Int8Array(n).fill(KNAVE);
    for (let i = 0; i < vars.length; i++) env[vars[i]] = (mask >> i) & 1;
    total++;
    if (constraintHolds(env, stmt)) trueCount++;
  }
  return trueCount > 0 && trueCount < total;
}

// ---------------------------------------------------------------------------
// 联立真值表
// ---------------------------------------------------------------------------
//
// 一条证词单独看常常什么都说不出来（"乙说丙是骑士"只把两人绑在一起），但两三句
// 绑过的人一旦首尾相接，能自洽的指派就所剩无几。人手做这一步是把两三句证词抄到
// 草稿纸上来回代 —— 所以它是铅笔规则，而不是"猜"。
//
// 规模上限同时管着句数和未定人数：真值表一旦超过 3 个人 8 行，场上任何一局都能被
// 它一步推完，"这盘靠不靠联立"就再也读不出难度了（第一版收到 5 个人 32 行，
// 实测五档分数全部塌成 1.3，见 DESIGN.md 第 4 节）。整盘穷举是 count.js 的活，
// 它不参与出题验收，只负责反驳。

export const CHAIN_STMTS = 3;
export const CHAIN_VARS = 3;

// `maxStmts` 是本游戏真正的难度阶梯：几"句话"必须一起看才能钉住一个人。
// 见习档只给 2（两句一组），大师档给 3。把它做成开关试过，结果是错的 ——
// 关掉联立后三人的空盘**没有任何**单句可推（不知道说话人是谁，就推不出他说的
// 真假），实测 0/40 出货。所以门槛只能是"联立多宽"，不能是"用不用联立"。
export function chainClusters(puzzle, known, maxStmts = CHAIN_STMTS) {
  const S = puzzle.statements;
  const varSet = S.map((st) => {
    const v = varsOf(st.prop);
    if (!v.includes(st.from)) v.push(st.from);
    return v;
  });
  const out = [];
  const consider = (combo) => {
    const vars = new Set();
    for (const i of combo) for (const v of varSet[i]) vars.add(v);
    const open = [...vars].filter((v) => known[v] === UNKNOWN).sort((a, b) => a - b);
    if (!open.length || open.length > CHAIN_VARS) return;
    out.push({ stmts: combo.slice(), open });
  };
  // 先两句、再三句：能少联立就少联立，这也是人手草稿的写法。
  for (let i = 0; i < S.length; i++) {
    for (let j = i + 1; j < S.length; j++) {
      consider([i, j]);
      if (maxStmts >= 3) for (let k = j + 1; k < S.length; k++) consider([i, j, k]);
    }
  }
  out.sort((a, b) => a.stmts.length - b.stmts.length);
  return out;
}

export function analyzeCluster(puzzle, cluster, known) {
  const { stmts, open } = cluster;
  const rows = [];
  const env = new Int8Array(puzzle.n);
  for (let mask = 0; mask < (1 << open.length); mask++) {
    for (let i = 0; i < puzzle.n; i++) env[i] = known[i] === UNKNOWN ? KNAVE : known[i];
    for (let i = 0; i < open.length; i++) env[open[i]] = (mask >> i) & 1;
    let ok = true;
    for (const ci of stmts) if (!constraintHolds(env, puzzle.statements[ci])) { ok = false; break; }
    if (ok) rows.push(open.map((v) => env[v]));
    if (rows.length > 4096) break;
  }
  if (!rows.length) {
    return { dead: { kind: 'cluster', stmts: stmts.slice(0, 6) }, forced: [] };
  }
  const forced = [];
  for (let i = 0; i < open.length; i++) {
    const only = rows[0][i];
    if (rows.every((r) => r[i] === only)) forced.push({ person: open[i], value: only });
  }
  return { forced, rows: rows.length };
}

function ruleChain(puzzle, known, events, maxStmts) {
  let gained = 0;
  for (const cluster of chainClusters(puzzle, known, maxStmts)) {
    const a = analyzeCluster(puzzle, cluster, known);
    if (a.dead) return { contradiction: { ...a.dead, rule: Rules.chain }, gained };
    for (const f of a.forced) {
      const res = write(known, events, f.person, f.value, Rules.chain, cluster.stmts[0]);
      if (res === 'set') {
        const e = events[events.length - 1];
        e.cluster = cluster.stmts.length;
        e.rows = a.rows;
        gained++;
      } else if (res) return { contradiction: { ...res, rule: Rules.chain }, gained };
    }
  }
  return { contradiction: null, gained };
}

// ---------------------------------------------------------------------------
// 求解：把每条证词单独推到底，推到不动点；卡住了才允许反证
// ---------------------------------------------------------------------------
//
// 反证刻意排在单位传播之外：如果每轮都顺手做反证，"这一盘用了几次反证"就变成搜索
// 顺序的产物，而不是难度读数了。

// 返回 null（已经标过这个值，无事发生）、冲突对象（标了两个身份），或 'set'。
function write(known, events, person, value, rule, ci) {
  if (known[person] === value) return null;
  if (known[person] !== UNKNOWN) {
    return { person, was: known[person], want: value, stmt: ci, rule };
  }
  known[person] = value;
  events.push({ person, value, rule, stmt: ci });
  return 'set';
}

// `chainWidth` 是出题端的准入门槛（默认 CHAIN_STMTS）。玩家那边永远按最宽的来，
// 提示不会因为你玩的是见习档就少给一条规则 —— 这个开关只决定"哪一盘有资格出货"。
// 为什么是"宽度"而不是"开/关"：做成布尔开关时实测见习档 0/40 出货。空盘上单句规则
// 根本推不出任何东西（不知道说话人是谁，就判不了他这句话的真假），所以"不用联立"
// 不等于"简单"，它等于"不存在"。被证伪的假设留在 DESIGN.md 第 4 节。
export function propagate(puzzle, known, events, { useNishio = false, chainWidth = CHAIN_STMTS, maxRounds = 60 } = {}) {
  let rounds = 0;
  let contradiction = null;
  for (;;) {
    if (rounds >= maxRounds || isComplete(known)) break;
    rounds++;
    const before = knownCount(known);
    for (let ci = 0; ci < puzzle.statements.length && !contradiction; ci++) {
      const stmt = puzzle.statements[ci];
      const a = analyze(puzzle, ci, known);
      if (a.dead) { contradiction = { ...a.dead, rule: stmt.rule }; break; }
      for (const f of a.forced) {
        const res = write(known, events, f.person, f.value, stmt.rule, ci);
        if (res && res !== 'set') { contradiction = { ...res, rule: stmt.rule }; break; }
      }
    }
    if (contradiction) break;
    if (knownCount(known) !== before) continue;
    // 单句推不动了，才把互相牵连的几句并成一簇再看。顺序一旦反过来，
    // "这盘靠不靠联立"就变成搜索策略的读数而不是题目的读数。
    const ch = chainWidth >= 2
      ? ruleChain(puzzle, known, events, chainWidth)
      : { contradiction: null, gained: 0 };
    if (ch.contradiction) { contradiction = ch.contradiction; break; }
    if (ch.gained) continue;
    if (!useNishio) break;
    const nz = nishioPass(puzzle, known, events, chainWidth);
    if (nz.contradiction) { contradiction = nz.contradiction; break; }
    if (!nz.gained) break;
  }
  return { rounds, contradiction, complete: isComplete(known) };
}

// 反证：假设某人是无赖（或骑士），把简单规则跑一遍，撞墙就说明假设不成立。
// 人是二值的，所以"假设 A 是骑士会矛盾"确实能推出"A 是无赖" —— 这一步依赖排中律，
// 也依赖盘上每个人都有确定身份这件事（见 DESIGN.md 第 1 节）。
function nishioPass(puzzle, known, events, chainWidth = CHAIN_STMTS) {
  let gained = 0;
  for (let p = 0; p < puzzle.n; p++) {
    if (known[p] !== UNKNOWN) continue;
    const fits = [];
    for (const guess of [KNIGHT, KNAVE]) {
      const trial = cloneKnown(known);
      trial[p] = guess;
      const sub = [];
      const r = propagate(puzzle, trial, sub, { useNishio: false, chainWidth, maxRounds: 30 });
      if (!r.contradiction) fits.push(guess);
    }
    // 两个取值都推得动 ⇒ 这一手反证什么也没说出来的，直接跳过。
    if (fits.length === 2) continue;
    if (fits.length === 1) {
      const res = write(known, events, p, fits[0], Rules.nishio, null);
      if (res === 'set') gained++;
      else if (res) return { gained, contradiction: { ...res, rule: Rules.nishio } };
      continue;
    }
    return { gained, contradiction: { person: p, rule: Rules.nishio, kind: '两头都推不下去' } };
  }
  return { gained, contradiction: null };
}

export function solvePuzzle(puzzle, startKnown, options = {}) {
  const known = startKnown ? cloneKnown(startKnown) : emptyKnown(puzzle.n);
  const events = [];
  const { rounds, contradiction, complete } = propagate(puzzle, known, events, options);
  const ruleUse = {};
  for (const e of events) if (e.person !== undefined) ruleUse[e.rule] = (ruleUse[e.rule] || 0) + 1;
  return {
    known,
    events,
    ruleUse,
    passes: rounds,
    contradiction,
    solved: complete && !contradiction,
    nishio: ruleUse[Rules.nishio] || 0,
  };
}

export function solve(options = {}) {
  return (puzzle, known) => solvePuzzle(puzzle, known, options);
}

// ---------------------------------------------------------------------------
// 判胜与冲突：直接从规则写出来的检查，不看求解器的任何账
// ---------------------------------------------------------------------------

// 玩家把每个人都标成骑士/无赖之后，判胜用的是这条 —— 它只做一件事：
// 把每个人的身份代回每条证词，看"说话人是骑士"和"他说的那句为真"是不是每次都同值。
export function verify(puzzle, known) {
  if (!isComplete(known)) return { ok: false, why: '还有没标身份的人' };
  const env = Int8Array.from(known);
  for (const stmt of puzzle.statements) {
    if (!constraintHolds(env, stmt)) return { ok: false, why: 'contradiction', stmt: stmt.id, person: stmt.from };
  }
  return { ok: true };
}

// 界面用的冲突表：玩家当前的标注已经和哪几条证词明摆着矛盾了。
// 它只核对"已经发生的事实"，不做推理，所以求解器出 bug 时它不会跟着说谎。
export function diagnose(puzzle, known) {
  const stmts = new Set();
  const people = new Set();
  for (const stmt of puzzle.statements) {
    const vars = varsOf(stmt.prop);
    let unknown = vars.some((v) => known[v] === UNKNOWN) || known[stmt.from] === UNKNOWN;
    const env = Int8Array.from(known.map((v) => (v === UNKNOWN ? KNAVE : v)));
    const holds = constraintHolds(env, stmt);
    const speaker = known[stmt.from];
    if (!unknown) {
      if (!holds) { stmts.add(stmt.id); people.add(stmt.from); for (const v of vars) people.add(v); }
      continue;
    }
    // 未定的人也可能已经矛盾：说话人已定、而命题的每一条补全都不符他的身份。
    if (speaker !== UNKNOWN) {
      let anyFit = false;
      const free = vars.filter((v) => known[v] === UNKNOWN);
      for (let mask = 0; mask < (1 << free.length); mask++) {
        const e = Int8Array.from(known.map((v) => (v === UNKNOWN ? KNAVE : v)));
        for (let i = 0; i < free.length; i++) e[free[i]] = (mask >> i) & 1;
        if (constraintHolds(e, stmt)) { anyFit = true; break; }
      }
      if (!anyFit) { stmts.add(stmt.id); people.add(stmt.from); for (const v of vars) people.add(v); }
    }
  }
  return { stmts, people };
}

// ---------------------------------------------------------------------------
// 提示：与验收同一条通道，所以它给不出一个规则推不出的身份
// ---------------------------------------------------------------------------

export function deductionChain(puzzle, known, options = {}) {
  const trial = cloneKnown(known);
  const events = [];
  const r = propagate(puzzle, trial, events, { useNishio: true, maxRounds: options.maxRounds || 60, ...options });
  const usable = events.filter((e) => e.person !== undefined);
  return { events: usable, known: trial, contradiction: r.contradiction, rounds: r.rounds };
}

// skip 里是这一手之前已经提示过的签名：连续两次提示必须给出新东西，
// 否则玩家每按一次 H 都在为同一句话付钱。
export function nextDeduction(puzzle, known, skip = null) {
  const chain = deductionChain(puzzle, known);
  if (chain.contradiction) return { conflict: chain.contradiction };
  const usable = chain.events.filter((e) => !(skip && skip.has(sigOf(e))));
  if (!usable.length) return null;
  let best = usable[0];
  for (const e of usable) if ((RuleWeight[e.rule] || 0) > (RuleWeight[best.rule] || 0)) best = e;
  return { ...best, text: hintOf(puzzle, best), sig: sigOf(best) };
}

export function sigOf(e) {
  return `${e.person}:${e.value}:${e.rule}:${e.stmt === undefined ? -1 : e.stmt}`;
}

export function hintOf(puzzle, e) {
  const who = personName(puzzle.n, e.person);
  const as = e.value === KNIGHT ? '骑士' : '无赖';
  const stmt = e.stmt === null || e.stmt === undefined ? null : puzzle.statements[e.stmt];
  const said = stmt ? statementText(puzzle.n, stmt) : '';
  switch (e.rule) {
    case Rules.taut: return `${said} ⇒ 说话人出现在自己的证词里，两条路都只能得出：${who} 是${as}`;
    case Rules.direct: return `${said} ⇒ 由这句话的真假：${who} 是${as}`;
    case Rules.relation: return `${said} ⇒ 两个人的关系被钉住，于是 ${who} 是${as}`;
    case Rules.count: return `${said} ⇒ 数一遍剩下的人头：${who} 是${as}`;
    case Rules.nest: return `${said} ⇒ 拆开这张真值表：${who} 是${as}`;
    case Rules.chain: return `与 ${who} 相关的 ${e.cluster} 句证词联立起来只剩 ${e.rows} 种自洽的指派，每一种 ${who} 都是${as}`;
    case Rules.nishio: return `${who} 若不是${as}，整盘就会自相矛盾 ⇒ ${who} 是${as}`;
    default: return `${who} 是${as}`;
  }
}
