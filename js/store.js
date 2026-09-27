// Persistence. Everything lives under one key so a reset is one line, and a run in progress
// is stored as (origin seed, tier, the player's own marks, what the run has cost) — never the
// statements, never the solution. makePuzzle() is deterministic, so the board does not have to
// travel through storage at all: 7 people is 7 trits, and a save stays a few hundred bytes.

import { KNIGHT, KNAVE, UNKNOWN } from './engine/logic.js';
import { tierById } from './engine/generate.js';

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
    const parsed = JSON.parse(raw);
    const base = defaults();
    return {
      ...base,
      ...parsed,
      settings: { ...base.settings, ...(parsed.settings || {}) },
      totals: { ...base.totals, ...(parsed.totals || {}) },
      best: parsed.best || {},
    };
  } catch {
    return defaults();
  }
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
    const r = this.data.resume;
    if (!r) return null;
    // n is not stored: it belongs to the tier, and the tier is what the board is regenerated
    // from, so decoding against it cannot disagree with the rebuilt room.
    const n = tierById(r.tier).n;
    return { ...r, n, known: rleDecode(r.ink, n) };
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
