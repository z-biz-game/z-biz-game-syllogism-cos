// Persistence. Everything lives under one key so a reset is one line, and a run in progress
// is stored as (origin seed, tier, the player's own marks, what the run has cost) — never the
// statements, never the solution. makePuzzle() is deterministic, so the board does not have to
// travel through storage at all: 7 people is 7 trits, and a save stays a few hundred bytes.

import { KNIGHT, KNAVE, UNKNOWN } from './engine/logic.js';
import { TIERS, tierById } from './engine/generate.js';

export const KEY = 'syllogism.save.v1';

const defaults = () => ({
  settings: { sound: true, reduceMotion: false },
  best: {},
  resume: null,
  totals: { solved: 0, hints: 0, ms: 0 },
});

// The engine's trits are 1 / 0 / -1; a run-length pair wants 0..2, so the unknown state moves
// out of the negative range before it is coded. An early board is mostly unknowns, which is
// exactly what RLE is for.
const TRIT = { [UNKNOWN]: 0, [KNIGHT]: 1, [KNAVE]: 2 };
const FROM_TRIT = [UNKNOWN, KNIGHT, KNAVE];

function rleEncode(known) {
  const out = [];
  let run = TRIT[known[0]] ?? 0;
  let n = 1;
  for (let i = 1; i < known.length; i++) {
    const v = TRIT[known[i]] ?? 0;
    if (v === run && n < 255) n++;
    else {
      out.push(run, n);
      run = v;
      n = 1;
    }
  }
  out.push(run, n);
  return out;
}

function rleDecode(pairs, len) {
  const b = new Int8Array(len);
  b.fill(UNKNOWN);
  let i = 0;
  for (let p = 0; p + 1 < pairs.length; p += 2) {
    const v = FROM_TRIT[pairs[p]] ?? UNKNOWN;
    const n = pairs[p + 1] | 0;
    for (let k = 0; k < n && i < len; k++) b[i++] = v;
  }
  return b;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaults();
    return sanitise(JSON.parse(raw));
  } catch {
    return defaults();
  }
}

// 两段式解码。第一段只看"形状"：一段存档是一组互相独立的记录，某一条认不出来就丢它自己，
// 不能让它把整局带走——旧代码在这里是 `{...base, ...parsed}`，parsed 是个字符串也会展开成功，
// 而 resume 里缺 ink 时 rleDecode 直接 null.length 抛出去，菜单渲染当场死掉。
// 第二段（Store.resume()）才把已通过形状的记录解成棋盘，并且自己再幂等地校验一遍。
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const count = (v) => (finite(v) && v >= 0 ? Math.floor(v) : null);

function saneSettings(v) {
  const base = defaults().settings;
  if (!v || typeof v !== 'object') return base;
  const bool = (k) => (typeof v[k] === 'boolean' ? v[k] : base[k]);
  return { sound: bool('sound'), reduceMotion: bool('reduceMotion') };
}

function saneTotals(v) {
  const t = defaults().totals;
  if (!v || typeof v !== 'object') return t;
  for (const k of Object.keys(t)) {
    const c = count(v[k]);
    if (c !== null) t[k] = c;
  }
  return t;
}

// 成绩条的四个数缺一不可：宁可显示"还没有记录"，也不拿一条半截记录去排最佳。
function saneBest(v) {
  const out = {};
  if (!v || typeof v !== 'object') return out;
  for (const tier of TIERS) {
    const r = v[tier.id];
    if (!r || typeof r !== 'object') continue;
    const ms = count(r.ms);
    const hints = count(r.hints);
    const moves = count(r.moves);
    const n = count(r.n);
    if (ms === null || hints === null || moves === null || n === null) continue;
    out[tier.id] = { ms, hints, moves, n, at: count(r.at) ?? 0 };
  }
  return out;
}

function saneResume(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const tier = TIERS.find((t) => t.id === v.tier);
  if (!tier) return null;
  const seed = v.originSeed !== undefined ? v.originSeed : v.seed;
  if (typeof seed !== 'string' && !finite(seed)) return null;
  if (!Array.isArray(v.ink)) return null;
  const ink = [];
  for (const p of v.ink) {
    if (!Number.isInteger(p) || p < 0 || p > 255) return null;
    ink.push(p);
  }
  return {
    originSeed: seed,
    tier: tier.id,
    elapsedMs: count(v.elapsedMs) ?? 0,
    moves: count(v.moves) ?? 0,
    hints: count(v.hints) ?? 0,
    at: count(v.at) ?? 0,
    ink,
  };
}

function sanitise(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults();
  return {
    settings: saneSettings(parsed.settings),
    totals: saneTotals(parsed.totals),
    best: saneBest(parsed.best),
    resume: saneResume(parsed.resume),
  };
}

export const Store = {
  data: load(),
  KEY,

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* private mode / quota — the game is still playable, just forgetful */
    }
  },

  bytes() {
    try {
      return (localStorage.getItem(KEY) || '').length;
    } catch {
      return 0;
    }
  },

  setting(name) {
    return this.data.settings[name];
  },
  setSetting(name, value) {
    this.data.settings[name] = value;
    this.save();
  },

  best(tier) {
    return this.data.best[tier] || null;
  },

  // A record has to mean "I settled this room myself", so the least-helped run wins and the
  // clock only breaks a tie at the very end: hints → moves → ms, in that order, always.
  recordBest(tier, { ms, hints, moves, n }) {
    const cur = this.data.best[tier];
    const better =
      !cur ||
      hints < cur.hints ||
      (hints === cur.hints && (moves < cur.moves || (moves === cur.moves && ms < cur.ms)));
    if (better) this.data.best[tier] = { ms, hints, moves, n, at: Date.now() };
    this.save();
    return better;
  },

  recordSolve(ms, hints) {
    const t = this.data.totals;
    t.solved++;
    t.hints += hints;
    t.ms += ms;
    this.save();
  },

  saveResume(puzzle, known, elapsedMs, run) {
    this.data.resume = {
      // The generator derives an internal seed from what it is handed (`seed|tier|n`), so a
      // resume must carry the *origin* seed or the rebuilt room is not the same room.
      originSeed: puzzle.originSeed || puzzle.seed,
      tier: puzzle.tier,
      elapsedMs,
      ink: rleEncode(known),
      // The cost of the run travels with the board. Without it a player could take six hints,
      // close the tab, come back, and finish on a clean 提示 0 record — the very ordering above
      // is counted from those numbers, and actions are not otherwise stored.
      moves: run.moves,
      hints: run.hints,
      at: Date.now(),
    };
    this.save();
  },

  resume() {
    // 第二段：即便有人绕过 load() 直接改了 data.resume，这里也先按形状再过一遍再解棋盘。
    const r = saneResume(this.data.resume);
    if (!r) return null;
    // n is not stored: it belongs to the tier, and the tier is what the board is regenerated
    // from, so decoding against it cannot disagree with the rebuilt room.
    const n = tierById(r.tier).n;
    return { ...r, n, known: rleDecode(r.ink, n) };
  },

  // 换一段存档重新解码（测试与"另一个标签页写过存档"用得上），不走整页刷新。
  reload() {
    this.data = load();
    return this.data;
  },

  clearResume() {
    this.data.resume = null;
    this.save();
  },

  reset() {
    this.data = defaults();
    this.save();
  },
};
