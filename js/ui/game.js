// The playable state machine: what a tap does, what an undo takes back, when a room counts as
// settled, and what a hint is allowed to say.
//
// Two deliberate bindings to js/engine/logic.js:
//   * `known` is the very Int8Array the engine's solve/verify/diagnose are handed. A renderer
//     with its own copy of the assignments is how "甲 is settled" and "甲 was just forced"
//     eventually disagree.
//   * the win check is `verify()` — written straight from the rule 说话人是骑士 ⇔ 那句为真 —
//     and not this file's bookkeeping, so "I filled every card" and "the room is consistent"
//     cannot both be true while disagreeing. A full board that is bright-looking but illegal
//     does not win, and the scenario suite proves it.
//
// A person holds exactly one trit, so 骑士 and 无赖 on the same card are mutually exclusive by
// construction rather than by validation: writing one *is* erasing the other, and the write
// records the value that was there before, which is what makes undo exact.

import {
  KNIGHT, KNAVE, UNKNOWN,
  personName, emptyKnown, isComplete, knownCount,
  nextDeduction, sigOf, statementText, verify, diagnose,
} from '../engine/logic.js';

export { KNIGHT, KNAVE, UNKNOWN };

export const AS_LABEL = { [KNIGHT]: '骑士', [KNAVE]: '无赖', [UNKNOWN]: '未定' };

// The seven names a hint may speak, in the order a player meets them.
export const RuleGloss = {
  直接身份: '这句话点名的那个人，身份跟着说话人的真假走',
  关系锁定: '「同类 / 不同类」把两个人绑在一起，动一个就动了另一个',
  计数钉死: '「几个骑士」把人头数钉死，剩下的位置没有第二种站法',
  复合拆开: '「而且 / 或者 / 如果 / 当且仅当」是一张真值表，逐列读',
  自指消去: '说话人出现在自己的证词里，方程会自己消掉自己',
  联立真值表: '两三句证词首尾相接，自洽的指派就只剩那几种',
  反证: '假设他是有赖，一路走到矛盾，假设就反了',
};

export class Game {
  constructor(bundle) {
    this.puzzle = bundle;             // makePuzzle() output: seed, tier, score, name, truth
    this.board = bundle.puzzle;       // createPuzzle() object: the statements the engine reads
    this.n = bundle.n;
    this.known = emptyKnown(this.n);
    this.notes = new Uint8Array(this.board.statements.length);   // 笔记：这一句被我划掉了
    this.steps = [];
    this.moves = 0;
    this.hints = 0;
    this.status = 'playing';          // playing | paused | won
    this.hintSigs = new Set();        // deductions already paid for — see nextDeduction's skip
    this.lastHint = null;
    this.focus = 0;                   // focused card (person index)
    this.focusLine = 0;               // focused sentence within that card
    // Which sentences each person spoke. Derived, never stored: the card stack is laid out
    // from it, so a silent person (pruning can leave one) still gets a card.
    this.bySpeaker = Array.from({ length: this.n }, () => []);
    for (const s of this.board.statements) this.bySpeaker[s.from].push(s.id);
    this.focusPath = [];
    for (let p = 0; p < this.n; p++) {
      const lines = this.bySpeaker[p];
      for (let i = 0; i < Math.max(1, lines.length); i++) this.focusPath.push({ person: p, line: i });
    }
    this.recompute();
  }

  // ---- derived readouts. One place recomputes everything, so no panel number can go stale.

  recompute() {
    this.diag = diagnose(this.board, this.known);
    this.verdict = verify(this.board, this.known);
    this.settled = knownCount(this.known);
    this.knights = 0;
    for (let i = 0; i < this.n; i++) if (this.known[i] === KNIGHT) this.knights++;
    this.noticed = this.notes.reduce((a, v) => a + (v ? 1 : 0), 0);
    return this.diag;
  }

  name(i) {
    return personName(this.n, i);
  }

  linesOf(person) {
    return this.bySpeaker[person];
  }

  lineText(stmtId) {
    const t = this.board.statements[stmtId].text || '';
    const a = t.indexOf('「');
    const b = t.lastIndexOf('」');
    // The engine's sentence, sliced — never re-derived from the AST, so the board and the
    // hint panel cannot read differently about the same statement.
    if (a >= 0 && b > a) return t.slice(a + 1, b);
    const c = t.indexOf('：');
    return c >= 0 ? t.slice(c + 1) : t;
  }

  // ---- committed actions: one gesture, one step, one undo -------------------------------

  commit(writes, kind) {
    if (!writes.length) return null;
    const step = { writes, kind };
    this.steps.push(step);
    // A note is a mark on one's own copy of the transcript, not a position on the board: the
    // legend promises 不算落子, and the record ranks runs by 步数, so charging a strike-through
    // as a move would make reading carefully cost the player. It is still a step — it goes on
    // the ledger and undo takes it back — it just never raises the counter.
    if (kind === 'hint') this.hints++;
    else if (kind !== 'note') this.moves++;
    this.recompute();
    this.checkWin();
    return step;
  }

  // Raw array write for gesture previews; returns the value that was there before so the
  // caller can record it as the undo target.
  previewWrite(write) {
    if (write.field === 'note') {
      const from = this.notes[write.key];
      this.notes[write.key] = write.to;
      return from;
    }
    const from = this.known[write.key];
    this.known[write.key] = write.to;
    return from;
  }

  revert(writes) {
    for (const w of writes) {
      if (w.field === 'note') this.notes[w.key] = w.from;
      else this.known[w.key] = w.from;
    }
    this.recompute();
  }

  // What a chip press *means* as a value: pressing the state already on the card clears it.
  targetFor(person, value) {
    if (value === UNKNOWN) return UNKNOWN;
    return this.known[person] === value ? UNKNOWN : value;
  }

  targetNote(stmt) {
    return this.notes[stmt] ? 0 : 1;
  }

  // Build the write a slot would perform, or null when the gesture is a no-op. Both the
  // pointer path and the keyboard path go through here, so all three input kinds drive the
  // state in exactly the same way.
  writeForSlot(slot) {
    if (slot == null || this.status !== 'playing') return null;
    if (slot.kind === 'note') {
      const stmt = slot.stmt;
      if (stmt == null || stmt < 0 || stmt >= this.notes.length) return null;
      const from = this.notes[stmt];
      return { field: 'note', key: stmt, from, to: this.targetNote(stmt), person: this.board.statements[stmt].from };
    }
    const person = slot.person;
    if (person == null || person < 0 || person >= this.n) return null;
    const from = this.known[person];
    const to = this.targetFor(person, slot.value);
    if (from === to) return null;
    return { field: 'known', key: person, from, to, person };
  }

  applyWrites(writes, kind) {
    const done = [];
    for (const w of writes) {
      if (!w || w.from === w.to) continue;
      this.previewWrite(w);
      done.push(w);
    }
    return this.commit(done, kind);
  }

  // Public single-write path (keyboard, harness, programmatic).
  assign(person, value) {
    return this.applyWrites([this.writeForSlot({ person, value })], 'tap');
  }

  toggleNote(stmt) {
    return this.applyWrites([this.writeForSlot({ kind: 'note', stmt })], 'note');
  }

  undo() {
    const step = this.steps.pop();
    if (!step) return null;
    this.revert(step.writes);
    // A hint that is taken back is still a hint that was taken: records rank a run by how much
    // help it needed, so refunding the counter would let a player undo their way to a clean
    // 提示 0. The signature stays in `hintSigs` too — otherwise undo + hint buys the same
    // deduction twice and the counter is decorative. `note` never raised the count, so the
    // guard has to skip it on the way back down too — otherwise undo would take a move away
    // from a tally that never included it.
    if (step.kind !== 'hint' && step.kind !== 'note') this.moves = Math.max(0, this.moves - 1);
    return step;
  }

  checkWin() {
    if (!isComplete(this.known)) return false;
    if (!this.verdict.ok) return false;
    this.status = 'won';
    return true;
  }

  // ---- hints: the engine's own next step, so it can only ever name a forced person -------

  hint() {
    if (this.status !== 'playing') return null;
    const d = nextDeduction(this.board, this.known, this.hintSigs);
    if (!d) {
      // A board that is already *full* but illegal is the one case the probe cannot speak about:
      // every cell is written, so the pencil rules have nothing new to add and answer null. Telling
      // that player "推不出新的" would be false — what the table refuses is a retraction. diagnose()
      // has the fact, so name the clash instead of shrugging. Charged either way: nothing written.
      const clash = this.firstClash();
      if (clash) return { conflict: clash, charged: false, text: this.conflictSpeech(clash) };
      return {
        stalled: true,
        charged: false,
        text: '把已经落下的身份联立起来，此刻推不出任何新的那个人。这不是提示能解决的缺口 —— 试着换一个人假设看看。',
      };
    }
    if (d.conflict) {
      return { conflict: d.conflict, charged: false, text: this.conflictSpeech(d.conflict) };
    }
    const write = this.writeForSlot({ person: d.person, value: d.value });
    if (!write) {
      return { stalled: true, charged: false, text: '这一手棋盘上已经写好了，换一处想。' };
    }
    const step = this.applyWrites([write], 'hint');
    if (!step) return { stalled: true, charged: false, text: '这一手棋盘上已经写好了，换一处想。' };
    try {
      this.hintSigs.add(d.sig || sigOf(d));
    } catch {
      /* a signature is a convenience; a hint already paid for is paid for */
    }
    const info = {
      person: d.person,
      value: d.value,
      rule: d.rule,
      stmt: d.stmt,
      who: this.name(d.person),
      text: d.text,
      charged: true,
      kind: step.kind,
    };
    this.lastHint = info;
    this.focus = d.person;
    this.focusLine = Math.min(this.focusLine, Math.max(0, this.bySpeaker[d.person].length - 1));
    return info;
  }

  // The one contradiction the player can act on, shaped like the engine's own conflict objects
  // ({person, stmt}): the first statement their marks already refuse, and who said it. diagnose()
  // hands back sets; a hint has to name one thing, so take the front of the statement set.
  firstClash() {
    if (!this.diag.stmts.size) return null;
    const stmt = this.diag.stmts.values().next().value;
    const st = this.board.statements[stmt];
    return { person: st ? st.from : null, stmt };
  }

  // A conflict is the one thing the player must be told *where* it is: which of their own
  // assignments the equations refuse.
  conflictSpeech(c) {
    const who = c.person === undefined || c.person === null ? null : this.name(c.person);
    const stmt = c.stmt === undefined || c.stmt === null ? null : this.board.statements[c.stmt];
    const said = stmt ? statementText(this.n, stmt) : '';
    if (who && said) return `${said} 这句已经和你给 ${who} 的身份对不上了：先撤销一步，再想想他到底是谁。`;
    if (who) return `${who} 这一处的两个身份都被证词堵死了：先撤销一步。`;
    if (said) return `${said} —— 这几句证词在这间房里无法同时为真：先撤销一步。`;
    return '盘面已经自相矛盾：先撤销一步，提示不会替你把错的留下。';
  }

  // ---- resume ---------------------------------------------------------------------------

  // Restoring a saved board. The room is regenerated from the origin seed, so a resume only
  // has to replay the player's own marks — and nothing here counts as a move, because the cost
  // of the run comes out of the save instead.
  load(known, notes = null) {
    for (let i = 0; i < this.n; i++) {
      const v = known[i];
      this.known[i] = v === KNIGHT || v === KNAVE ? v : UNKNOWN;
    }
    if (notes) {
      for (let i = 0; i < this.notes.length; i++) this.notes[i] = notes[i] ? 1 : 0;
    }
    this.recompute();
    this.checkWin();
    return this;
  }

  // Same seed, same room, empty table: the counters go back too, because a restarted run is a
  // different run and its record must not inherit the old one's help.
  restart() {
    this.known.fill(UNKNOWN);
    this.notes.fill(0);
    this.steps.length = 0;
    this.moves = 0;
    this.hints = 0;
    this.hintSigs.clear();
    this.lastHint = null;
    this.focus = 0;
    this.focusLine = 0;
    this.status = 'playing';
    this.recompute();
    return this;
  }

  setPaused(on) {
    if (this.status === 'won') return this.status;
    this.status = on ? 'paused' : 'playing';
    return this.status;
  }

  // ---- focus: keyboard drives the same writes the chips do -------------------------------

  focusCard(stepBy) {
    if (!this.n) return this.focus;
    this.focus = (this.focus + stepBy + this.n) % this.n;
    this.focusLine = 0;
    return this.focus;
  }

  focusSlot(stepBy) {
    const len = this.focusPath.length;
    if (!len) return this.focus;
    let i = this.focusPath.findIndex((p) => p.person === this.focus && p.line === this.focusLine);
    if (i < 0) i = 0;
    i = (i + stepBy + len) % len;
    this.focus = this.focusPath[i].person;
    this.focusLine = this.focusPath[i].line;
    return this.focus;
  }

  focusedStmt() {
    const lines = this.bySpeaker[this.focus];
    if (!lines || !lines.length) return null;
    return lines[Math.min(this.focusLine, lines.length - 1)];
  }

  // unknown → 骑士 → 无赖 → unknown
  cycleFocused() {
    const cur = this.known[this.focus];
    const next = cur === UNKNOWN ? KNIGHT : cur === KNIGHT ? KNAVE : UNKNOWN;
    return this.assign(this.focus, next);
  }

  // Only used by the harness and the win screenshot: drive the game's own hints to the end.
  // Every write goes through hint(), so it can never settle a person the pencil rules would
  // not justify.
  solveWithLogic({ cap = 200 } = {}) {
    let k = 0;
    while (this.status === 'playing' && k++ < cap) {
      const before = this.steps.length;
      const h = this.hint();
      if (!h || h.stalled || h.conflict) break;
      if (this.steps.length === before) break;
    }
    return { status: this.status, hints: this.hints, steps: k };
  }

  state() {
    return {
      tier: this.puzzle.tier,
      name: this.puzzle.name,
      seed: this.puzzle.seed,
      originSeed: this.puzzle.originSeed,
      n: this.n,
      statements: this.board.statements.length,
      score: this.puzzle.score,
      moves: this.moves,
      hints: this.hints,
      status: this.status,
      settled: this.settled,
      unknown: this.n - this.settled,
      knights: this.knights,
      conflicts: this.diag.stmts.size,
      peopleInConflict: this.diag.people.size,
      notes: this.noticed,
      complete: isComplete(this.known),
      legal: this.verdict.ok,
      steps: this.steps.length,
      focus: this.focus,
      focusLine: this.focusLine,
      known: Array.from(this.known),
    };
  }
}
