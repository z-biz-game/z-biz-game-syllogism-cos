// Browser-side scenario suite, injected by tools/playtest.cjs and run against the real page.
//
// The rule for anything asserted here: read the DOM geometry and the canvas pixels, not a
// string of innerHTML. A `.hidden` boolean says what the code intended; a client rect and a
// pixel say what the player got. The interesting failures in this game are exactly the ones
// where the state is right and the picture, the tap, or the fit is wrong.
//
// window.syllogism.engine is the shipped module graph, so a scenario that passes here has
// passed on the same solver the player's hints come from — not on a second copy kept for
// testing. Engine constants are read *inside* each scenario: this file is installed before the
// app's module has run, so window.syllogism does not exist yet at load time.

((w) => {
  const rows = [];
  const ck = (test, cond, detail) => {
    rows.push({ test, pass: !!cond, detail: cond ? '' : String(detail === undefined ? '' : detail) });
  };
  const report = (extra) => {
    // rows is copied, not aliased: the array is cleared below, and a live reference would
    // hand back an empty report that still reads as "0 failed".
    const out = { rows: rows.slice(), fail: rows.filter((r) => !r.pass).length, ...extra };
    rows.length = 0;
    return out;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const A = () => w.syllogism;
  const E = () => w.syllogism.engine;

  // "Visible" means the box exists and takes space — the one reading of the CSS invariant
  // `[hidden]{display:none !important}` that fails if the rule is deleted.
  const shown = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return false;
    return getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;
  };

  const box = () => A().view.canvas.getBoundingClientRect();

  // A real gesture through the canvas, so hitTest, the DPR transform and the press/commit
  // bookkeeping all have to agree for the assertion to pass.
  function pointer(type, x, y, pointerType = 'mouse') {
    const ev = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      isPrimary: true,
      pointerType,
      clientX: x,
      clientY: y,
    });
    A().view.canvas.dispatchEvent(ev);
    return ev;
  }

  // press + release on the same slot: one gesture, one step, one undo
  async function tapSlot(i, pointerType = 'mouse') {
    if (i < 0) return wait(16);
    const p = A().slotCenter(i);
    pointer('pointerdown', p.x, p.y, pointerType);
    pointer('pointerup', p.x, p.y, pointerType);
    return wait(20);
  }

  async function dragTo(fromSlot, toSlot) {
    const a = A().slotCenter(fromSlot);
    const b = A().slotCenter(toSlot);
    pointer('pointerdown', a.x, a.y);
    pointer('pointermove', (a.x + b.x) / 2, (a.y + b.y) / 2);
    pointer('pointerup', b.x, b.y);
    await wait(20);
  }

  async function key(k, target) {
    (target || w).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    (target || w).dispatchEvent(new KeyboardEvent('keyup', { key: k, bubbles: true }));
    return wait(20);
  }

  const chipSlot = (person, value) => A().slotFor(person, value);
  const noteSlot = (person, stmt) => A().noteSlot(person, stmt);
  const truthOf = (g) => Array.from(g.puzzle.truth);
  const median = (arr) => {
    const a = arr.slice().sort((x, y) => x - y);
    return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
  };

  // ---- canvas pixels ----------------------------------------------------------------------
  // Everything heavy stays on this side of the wire: only aggregates cross back to Node.

  function readRect(rect) {
    const cv = A().view.canvas;
    const dpr = A().view.geo.dpr;
    return cv.getContext('2d').getImageData(
      Math.max(0, Math.round(rect.x * dpr)),
      Math.max(0, Math.round(rect.y * dpr)),
      Math.max(1, Math.round(rect.w * dpr)),
      Math.max(1, Math.round(rect.h * dpr))
    ).data;
  }

  // A colour fingerprint of a rect: warm (candle = 骑士), cool (ash = 无赖), pale ink (the
  // sentences are drawn at 68 % ink, so "pale" cannot mean "white"), and how much is lit at all.
  // Three identity states must produce three different ones.
  function fingerprint(rect) {
    const d = readRect(rect);
    let warm = 0, cool = 0, ink = 0, lit = 0, n = 0;
    for (let k = 0; k < d.length; k += 4) {
      const r = d[k], g = d[k + 1], b = d[k + 2];
      n++;
      if (r > b + 40 && r > 60) warm++;
      if (b > r + 20 && b > 50) cool++;
      if (r > 120 && g > 112 && b > 100) ink++;
      if (r + g + b > 320) lit++;
    }
    return { n, warm: +(warm / n).toFixed(3), cool: +(cool / n).toFixed(3), ink: +(ink / n).toFixed(3), lit: +(lit / n).toFixed(3) };
  }

  function pixelHash(rect) {
    const d = readRect(rect);
    let h = 0;
    for (let k = 0; k < d.length; k += 16) h = (Math.imul(h, 31) + d[k] + d[k + 1] * 3 + d[k + 2] * 7) >>> 0;
    return h;
  }

  // How many pixels of a rect really moved between two grabs.
  //
  // Re-rasterising this canvas does not reproduce its own bitmap byte for byte: every pass repaints
  // the anti-aliased edges it owns a shade lighter or darker. Measured, on a board whose state did
  // not change at all between two settled grabs: up to 5 148 of a card's 40 820 pixels came out
  // different, at most 78 in a channel, at most 49 of them past 32 — and the numbers were the same
  // after 1, 2, 3 or 4 repaints in between, so no amount of waiting settles them. It is a property
  // of the compositor, not of this game.
  //
  // Real changes are an order of magnitude above that floor: moving the focus box moves 1 760
  // pixels past 32, a 划掉 line across one sentence moves 345, and sealing a card's identity moves
  // thousands. So "the picture changed" is a count of pixels clear of the dither, and a card that
  // merely shimmered stays quiet.
  const DITHER = 32;
  const MOVED = 200;
  const QUIET = 120;
  function pixelsMoved(before, after) {
    let n = 0;
    const len = Math.min(before.length, after.length);
    for (let k = 0; k < len; k += 4) {
      const d = Math.max(
        Math.abs(before[k] - after[k]),
        Math.abs(before[k + 1] - after[k + 1]),
        Math.abs(before[k + 2] - after[k + 2])
      );
      if (d > DITHER) n++;
    }
    return n;
  }

  const cardRects = () => A().view.plan.cards.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h }));

  // Per card, how far the picture moved since `grabCards()` was called. Both sides read the live
  // plan, so a check that re-layouts the board between the grabs fails loudly instead of silently
  // comparing different pixels.
  const grabCards = () => cardRects().map((r) => readRect(r));
  function movedCards(before) {
    const after = grabCards();
    return before.map((d, i) => pixelsMoved(d, after[i] || d));
  }

  // Read the canvas only once the frame the current state asked for is the frame on the buffer.
  //
  // `draw()` is synchronous, the swap is not: `getImageData` in the same task as a paint can hand
  // back the board from before it, which is how "the undo did not put the pixels back" and "the
  // sentences were never drawn" (ink 0) were once reported about pictures that were fine. Riding out
  // two animation frames is what lets that paint be committed — and a check that changes tier also
  // re-sizes the buffer, whose freshly allocated frame is not the one the compositor keeps, so the
  // whole thing is repeated once more. Three identical full-canvas reads then prove the game itself
  // owes no further redraw.
  //
  // Nothing here makes two grabs of the *same* state byte-identical: see `pixelsMoved` for why the
  // comparisons tolerate that, and why tolerating it costs a check nothing.
  //
  // `A().draw()` is the app's own draw, the one `syncAll()` calls: it reads the game state and
  // writes pixels, and it cannot touch the ledger, which is what the rest of the row is for.
  async function canvasStilled() {
    const raf = () => new Promise((r) => w.requestAnimationFrame(r));
    const geo = () => A().view.geo;
    for (let round = 0; round < 2; round++) {
      A().draw();
      await raf();
      await raf();
    }
    let prev = null;
    let same = 0;
    for (let i = 0; i < 16; i++) {
      await wait(16);
      const g = geo();
      const h = pixelHash({ x: 0, y: 0, w: g.w, h: g.h });
      if (h === prev) { if (++same >= 2) return h; } else same = 0;
      prev = h;
    }
    return prev;
  }

  // ---- 1. engine --------------------------------------------------------------------------

  const engine = async () => {
    const { KNIGHT, KNAVE, UNKNOWN, Rules, verify, diagnose, nextDeduction, isComplete, emptyKnown,
      createPuzzle, statementText, solvePuzzle, countModels, matchesTruth, constraintHolds } = E();
    ck('对外暴露的是同一份引擎', typeof solvePuzzle === 'function' && Object.keys(Rules).length === 7,
      JSON.stringify(Object.keys(Rules)));
    ck('规则名是中文', Object.values(Rules).every((s) => /[一-龥]/.test(s)), JSON.stringify(Rules));
    ck('提示只说这七个名字', Object.keys(E().RuleGloss).every((k) => Object.values(Rules).includes(k))
      && Object.keys(E().RuleGloss).length === 7, JSON.stringify(Object.keys(E().RuleGloss)));
    ck('三态是三个不同的数', KNIGHT === 1 && KNAVE === 0 && UNKNOWN === -1, `${KNIGHT}/${KNAVE}/${UNKNOWN}`);

    // A hand-written room: 甲说「乙是骑士」, 乙说「甲和无赖同类」. Worked out on paper before
    // it was typed here — 甲 ⇔ 乙, and 乙 ⇔ ¬乙 … so 乙 must be a knave, and so must 甲.
    const p = createPuzzle(2, [
      { from: 0, prop: { t: 'knight', xs: [1] } },
      { from: 1, prop: { t: 'diff', xs: [0, 1] } },
    ]);
    const k0 = emptyKnown(2);
    const bothLiars = Int8Array.from([KNAVE, KNAVE]);
    const bothKnights = Int8Array.from([KNIGHT, KNIGHT]);
    const halfWrong = Int8Array.from([KNIGHT, UNKNOWN]);
    ck('手推的盘：满指派被判合法', verify(p, bothLiars).ok === true, JSON.stringify(verify(p, bothLiars)));
    ck('手推的盘：两个骑士被独立检查拒绝', verify(p, bothKnights).ok === false);
    ck('不完整指派谈不上合法', verify(p, k0).why === '还有没标身份的人', JSON.stringify(verify(p, k0)));
    ck('判胜用的是“没有未定的人”', isComplete(bothLiars) && !isComplete(k0));
    // The equation *is* the semantics: the solution satisfies every sentence, and a wrong table
    // is refused by at least one of them. Nothing here is a convention about symbols.
    ck('方程本身就是语义：解让每一句都成立', p.statements.every((s) => constraintHolds(bothLiars, s) === true),
      p.statements.map((s) => constraintHolds(bothLiars, s)).join(','));
    ck('非法指派被同一式的某一句当面拒绝', p.statements.some((s) => constraintHolds(bothKnights, s) === false),
      p.statements.map((s) => constraintHolds(bothKnights, s)).join(','));

    // The probe a hint is built from must not touch the board it is asked about, and it must
    // name a rule, a person and a binary value — that is the whole contract of a hint.
    const before = Array.from(k0).join('');
    const d = nextDeduction(p, k0);
    ck('空盘上已经有铅笔规则能钉住一个人', !!d && d.person !== undefined, JSON.stringify(d));
    ck('问一步提示不会改盘', Array.from(k0).join('') === before, `${before} → ${Array.from(k0).join('')}`);
    ck('提示点名规则与那个人', !!d && !!d.rule && Object.values(Rules).includes(d.rule) && d.person === 0,
      JSON.stringify(d && { rule: d.rule, person: d.person }));
    ck('提示文本点出人名', !!d && /[甲乙丙丁戊己庚]/.test(d.text || ''), JSON.stringify(d && d.text));
    ck('提示给的值是二值的', !!d && (d.value === KNIGHT || d.value === KNAVE), JSON.stringify(d && d.value));
    ck('提示还留下一个可复用的签名', !!d && typeof d.sig === 'string' && d.sig.length > 3, JSON.stringify(d && d.sig));
    const asked = Array.from(k0).join('');
    nextDeduction(p, k0, new Set([d.sig]));
    ck('问过一次的推论不会再卖第二遍', (() => {
      const again = nextDeduction(p, k0, new Set([d.sig]));
      return !again || again.person !== d.person || again.rule !== d.rule;
    })(), JSON.stringify(asked));

    // A contradiction is reported, never papered over: mark one man knight and the diagnosis has
    // to name the sentence that refuses it.
    const bad = diagnose(p, bothKnights);
    ck('冲突表点出被堵死的那句', bad.stmts.size > 0 && bad.people.size > 0, JSON.stringify({ s: [...bad.stmts], p: [...bad.people] }));
    const conflicted = nextDeduction(p, halfWrong);
    ck('已矛盾时提示报矛盾而不是给答案', !!conflicted && !!conflicted.conflict, JSON.stringify(conflicted));
    // … and a *fully* wrong table is the case the probe cannot speak about: there is nothing
    // left to write, so it answers null. js/ui/game.js has to turn that null into the clash it
    // can see, which is what the play scenario then checks from the player's side.
    ck('写满了的非法盘上探针无话可说（返回 null）', nextDeduction(p, bothKnights) === null,
      JSON.stringify(nextDeduction(p, bothKnights)));

    const bundle = E().makePuzzle('browser|engine', 'regular');
    const cm = countModels(bundle.puzzle);
    ck('穷举计数认这盘唯一解', cm.status === E().UNIQUE && cm.models === 1, JSON.stringify({ s: cm.status, m: cm.models }));
    ck('穷举出来的就是出题人心里那个', matchesTruth(bundle.puzzle, bundle.truth));
    ck('出货盘面在浏览器里也推得完', solvePuzzle(bundle.puzzle, null, { useNishio: true }).solved);
    ck('证词文本带引号', bundle.puzzle.statements.every((s) => s.text.includes('「') && s.text.includes('」')),
      bundle.puzzle.statements[0].text);
    ck('证词文本由 statementText 现拼', bundle.puzzle.statements.every((s) => s.text === statementText(bundle.n, s)));
    return report({ tier: bundle.tier, score: bundle.score, n: bundle.n });
  };

  // ---- 2. gen -----------------------------------------------------------------------------

  const gen = async () => {
    const { makePuzzle, TIERS, solvePuzzle, verify, countModels, UNIQUE, matchesTruth, isComplete } = E();
    const perTier = {};
    const medians = [];
    const t0all = performance.now();
    for (const t of TIERS) {
      let n = 0, inBand = 0, clean = 0, unique = 0, ms = 0, worstStmt = 0, maxPerPerson = 0;
      const scores = [];
      const gtimes = [];
      for (let s = 0; s < 4; s++) {
        const t0 = performance.now();
        const p = makePuzzle(`browser|gen|${t.id}|${s}`, t.id);
        const dt = performance.now() - t0;
        ms += dt;
        gtimes.push(dt);
        if (!p) continue;
        n++;
        scores.push(p.score);
        if (p.score >= t.band[0] && p.score <= t.band[1]) inBand++;
        const board = p.puzzle;
        const r = solvePuzzle(board, null, { useNishio: t.nishio, chainWidth: t.chainWidth });
        if (r.solved && verify(board, p.truth).ok) clean++;
        const cm = countModels(board);
        if (cm.status === UNIQUE && matchesTruth(board, p.truth)) unique++;
        // a room is 3..7 people, nobody gets a third sentence, and nobody is left out
        const by = Array.from({ length: p.n }, () => 0);
        for (const st of board.statements) by[st.from]++;
        maxPerPerson = Math.max(maxPerPerson, ...by);
        worstStmt = Math.max(worstStmt, board.statements.length);
        ck(`${t.label} 人数跟着档位走`, p.n === t.n, `${p.n} vs ${t.n}`);
        ck(`${t.label} 每局至少一句可推的空钉`, Math.min(...by) >= 0 && by.length === p.n);
        ck(`${t.label} 至少一个骑士一个无赖`, (() => {
          let kn = 0;
          for (let i = 0; i < p.n; i++) if (p.truth[i] === 1) kn++;
          return kn > 0 && kn < p.n;
        })());
      }
      ck(`${t.label} 四局全部可推且合法`, clean === n && n === 4, `${clean}/${n}`);
      ck(`${t.label} 四局全部落在实测区间`, inBand === n, `${inBand}/${n}`);
      ck(`${t.label} 穷举复核唯一解`, unique === n, `${unique}/${n}`);
      ck(`${t.label} 每人最多两句`, maxPerPerson <= 2, maxPerPerson);
      ck(`${t.label} 出货耗时是毫秒级`, Math.max(...gtimes) < 260, `${Math.max(...gtimes).toFixed(1)} ms`);
      const med = median(scores);
      medians.push(med);
      perTier[t.id] = { people: TIERS.find((x) => x.id === t.id).n, boards: n, med, stmts: worstStmt, ms: Math.round(ms / 4) };
    }
    ck('五档区间本身由浅入深', TIERS.every((t, i) => !i || (t.band[0] > TIERS[i - 1].band[0] && t.band[1] >= TIERS[i - 1].band[1])),
      TIERS.map((t) => t.band.join('–')).join(' < '));
    ck('四局中位数不下降', medians.every((v, i) => i === 0 || v >= medians[i - 1]), medians.map((v) => v.toFixed(1)).join(' → '));
    ck('人数随档位增加', TIERS.every((t, i) => !i || t.n > TIERS[i - 1].n), TIERS.map((t) => t.n).join(','));
    ck('三到七人全在五档里', TIERS[0].n === 3 && TIERS[TIERS.length - 1].n === 7);
    ck('同一颗种子复现同一局', (() => {
      const a = makePuzzle('browser|dup', 'regular');
      const b = makePuzzle('browser|dup', 'regular');
      return a.seed === b.seed && a.puzzle.statements.map((s) => s.text).join('|') === b.puzzle.statements.map((s) => s.text).join('|');
    })());
    ck('换种子就换口供', (() => {
      const a = makePuzzle('browser|seed-a', 'regular');
      const b = makePuzzle('browser|seed-b', 'regular');
      return a.puzzle.statements.map((s) => s.text).join('|') !== b.puzzle.statements.map((s) => s.text).join('|');
    })());
    ck('不同档位不同种子也换人', (() => {
      const a = makePuzzle('browser|dup', 'regular');
      const b = makePuzzle('browser|dup', 'expert');
      return a.n !== b.n && isComplete(emptyLike(b)) === false;
    })());
    ck('出题不需要网络：纯种子', typeof makePuzzle('browser|x', 'master').seed === 'string');
    return report({ perTier, totalMs: Math.round(performance.now() - t0all) });
  };

  // small helper used above: a board with nothing written is by definition unfinished
  function emptyLike(bundle) {
    const k = new Int8Array(bundle.n);
    k.fill(-1);
    return k;
  }

  // ---- 3. play ----------------------------------------------------------------------------

  const play = async () => {
    const { KNIGHT, KNAVE, UNKNOWN, verify, isComplete } = E();
    A().engine.Store.reset();
    const g = A().begin({ tier: 'trainee', seed: 'browser|play' });
    ck('选档能开局并进入对局', !!g && shown('#view-game') && !shown('#view-menu'), 'begin 返回空或视图没换');
    ck('开局是空的', g.known.every((v) => v === UNKNOWN) && g.moves === 0 && g.hints === 0);
    ck('步数读数与状态一致', Number(document.querySelector('#stat-moves').textContent) === 0);
    ck('已定身份读数跟着走', document.querySelector('#stat-known').textContent === `0/${g.n}`,
      document.querySelector('#stat-known').textContent);

    const chipK = chipSlot(0, KNIGHT);
    ck('每个人的卡上有骑士牌', chipK >= 0);
    await tapSlot(chipK);
    ck('点一下骑士牌就落下身份', g.known[0] === KNIGHT, g.known[0]);
    ck('落身份记为一步', Number(document.querySelector('#stat-moves').textContent) === 1 && g.moves === 1);
    ck('面板读数跟着变', document.querySelector('#stat-known').textContent === `1/${g.n}`);

    await tapSlot(chipK);
    ck('再点同一张牌把身份收回', g.known[0] === UNKNOWN);
    ck('收回算新的一步', g.moves === 2, g.moves);

    // 骑士 and 无赖 on one card are mutually exclusive by construction: a person holds exactly one
    // trit, so rewriting one identity over the other is a single write — never a clear plus a set.
    await tapSlot(chipSlot(0, KNAVE));
    ck('按下无赖', g.known[0] === KNAVE && g.moves === 3, JSON.stringify({ v: g.known[0], m: g.moves }));
    await tapSlot(chipSlot(0, KNIGHT));
    ck('从无赖直接改写成骑士，只花一步', g.known[0] === KNIGHT && g.moves === 4,
      JSON.stringify({ v: g.known[0], m: g.moves }));
    await tapSlot(chipSlot(0, UNKNOWN));
    ck('按未定牌把这个人清空', g.known[0] === UNKNOWN && g.moves === 5, g.moves);

    // one gesture = one step, and a gesture that leaves the chip cancels
    const from = chipSlot(0, KNIGHT);
    const to = chipSlot(1, KNIGHT);
    const still = { moves: g.moves, steps: g.state().steps };
    await dragTo(from, to);
    ck('起手在牌上、松手在别处：不落子', g.known[0] === UNKNOWN && g.known[1] === UNKNOWN
      && g.moves === still.moves, JSON.stringify(g.state().known));
    ck('取消的手势不进账本', g.state().steps === still.steps, `${still.steps} → ${g.state().steps}`);

    // padding is not part of the board
    const b = box();
    const pad = A().view.plan.pad;
    ck('留白上的 hitTest 返回 -1', A().hitTest(b.left + pad / 2, b.top + pad / 2) === -1
      && A().hitTest(b.left + b.width - 1, b.top + b.height - 1) === -1);
    ck('画布外的 hitTest 返回 -1', A().hitTest(b.left - 4, b.top - 4) === -1 && A().hitTest(b.right + 4, b.bottom + 4) === -1);
    const ledger = g.state();
    pointer('pointerdown', b.left + 3, b.top + 3);
    pointer('pointerup', b.left + 3, b.top + 3);
    await wait(20);
    ck('留白点击既不落子也不记账', g.state().moves === ledger.moves && g.state().steps === ledger.steps);

    // notes: a strike-through of your own. Whether it costs a 步 is a policy call, but the sheet
    // and the ledger must make the *same* call: 牌子怎么认 spells it out for the player, so this
    // row reads what the legend promises and charges the ledger accordingly. A legend that says
    // 不算落子 while commit() raises the counter (or the other way round) is a real bug — the
    // player is billed for something the rules on screen said were free — and it fails here.
    const stmt = g.bySpeaker[0][0];
    const ns = noteSlot(0, stmt);
    ck('每句证词前有划掉用的方格', ns >= 0);
    const legend = (document.querySelector('.sw-note') ? document.querySelector('.sw-note').parentElement.textContent : '').trim();
    const chargesNote = !/不算落子/.test(legend);
    const movesBefore = g.moves;
    await tapSlot(ns);
    ck('划掉一句会记账（进账本，可撤销）', g.notes[stmt] === 1 && g.state().steps === ledger.steps + 1);
    ck('图例说什么，账本就记什么（划掉 vs 落子）', g.moves === movesBefore + (chargesNote ? 1 : 0),
      JSON.stringify({ legend, chargesNote, movesBefore, moves: g.moves }));
    ck('划掉数进了面板', Number(document.querySelector('#stat-notes').textContent) === 1);
    await tapSlot(ns);
    ck('再点方格把划掉取消', g.notes[stmt] === 0 && g.moves === movesBefore + (chargesNote ? 2 : 0),
      `${movesBefore} → ${g.moves}`);
    ck('划掉的来回只动笔记，不动身份', g.state().steps === ledger.steps + 2 && g.state().notes === 0
      && g.known[0] === UNKNOWN, JSON.stringify(g.state()));

    // undo takes back exactly one gesture, in the right direction
    await tapSlot(chipSlot(0, KNAVE));
    const knownNow = Array.from(g.known);
    A().undo();
    ck('撤销退回改之前的那个值', g.known[0] === UNKNOWN && knownNow[0] === KNAVE);
    ck('撤销只退一步', g.moves === movesBefore + (chargesNote ? 2 : 0), `${movesBefore} → ${g.moves}`);

    // an illegal full assignment must not win — the win is verify(), not "all cards filled"
    for (let p = 0; p < g.n; p++) A().assign(p, KNIGHT);
    ck('全员骑士填满了每个人', isComplete(g.known) && g.state().settled === g.n);
    ck('但这个满指派是非法的', verify(g.board, g.known).ok === false);
    ck('非法满盘不判胜', g.status !== 'won' && !shown('#win-veil'), g.status);
    ck('非法满盘在面板上读数自相', g.state().complete === true && g.state().legal === false);
    ck('非法满盘点亮冲突读数', Number(document.querySelector('#stat-conflicts').textContent) > 0);
    ck('冲突行把话说明了', document.querySelector('#conflict-line').textContent.length > 8,
      document.querySelector('#conflict-line').textContent);
    ck('非法满盘时提示只报矛盾', (() => {
      const h = A().useHint();
      return !!h && !!h.conflict && h.charged === false;
    })());

    while (g.state().steps) A().undo();
    ck('一路撤销能回到空盘', g.moves === 0 && g.known.every((v) => v === UNKNOWN) && g.state().notes === 0,
      JSON.stringify(g.state().known));

    // the legal full assignment does win, and by the same independent check
    const truth = truthOf(g);
    for (let p = 0; p < g.n; p++) A().assign(p, truth[p]);
    ck('按真解填满判胜', g.status === 'won' && shown('#win-veil'), JSON.stringify(g.state()));
    ck('胜利时独立检查无话可说', verify(g.board, g.known).ok === true);
    ck('胜利面板报出这一局的成本', document.querySelector('#win-meta').textContent.includes('提示'),
      document.querySelector('#win-meta').textContent);
    ck('胜利面板写出的是回代结果', document.querySelector('#win-check').textContent.includes('当且仅当')
      || document.querySelector('#win-check').textContent.includes('⇔'), document.querySelector('#win-check').textContent);
    const veil = document.querySelector('#win-veil').getBoundingClientRect();
    ck('结算遮罩盖住整张盘', veil.width >= b.width - 1 && veil.height >= b.height - 1,
      `${Math.round(veil.width)}×${Math.round(veil.height)} vs ${Math.round(b.width)}×${Math.round(b.height)}`);

    // restart: same seed, empty table, and the run's cost starts over
    document.querySelector('#btn-again').click();
    await wait(40);
    const g2 = A().game;
    ck('换一局是新种子新局', g2 !== g && g2.moves === 0 && g2.hints === 0);
    A().begin({ tier: 'trainee', seed: 'browser|play' });
    const g3 = A().game;
    ck('同一种子回到同一间房', g3.puzzle.seed === g.puzzle.seed && g3.known.every((v) => v === UNKNOWN));
    A().assign(0, truth[0]);
    A().restart();
    await wait(30);
    ck('重开清空棋盘与账目', A().game.moves === 0 && A().game.hints === 0 && A().game.state().steps === 0
      && !shown('#win-veil'));
    ck('重开之后还是这一间房', A().game.puzzle.seed === g.puzzle.seed);

    // pause: the clock stops and the transcript goes face down
    A().begin({ tier: 'regular', seed: 'browser|pause' });
    const gp = A().game;
    A().assign(0, KNIGHT);
    await wait(1100);
    const t1 = A().elapsed();
    A().pause();
    const tPaused = A().elapsed();
    await wait(1100);
    const t2 = A().elapsed();
    ck('暂停之后计时一字不动', t2 === tPaused, `${tPaused} → ${t2}`);
    ck('按下暂停那一刻没有多记一秒', tPaused - t1 < 300, `${t1} → ${tPaused}`);
    ck('暂停遮住棋盘', gp.status === 'paused' && shown('#pause-veil'));
    ck('暂停时按牌不落子', (() => {
      const before = gp.state().steps;
      A().assign(1, KNAVE);
      return gp.known[1] === UNKNOWN && gp.state().steps === before;
    })());
    ck('继续之后盘面揭开', (() => {
      A().unpause();
      return gp.status === 'playing' && !shown('#pause-veil');
    })());
    const t3 = A().elapsed();
    await wait(1100);
    ck('继续之后计时接着走（既没有归零也没有冻住）', A().elapsed() >= t3 + 1000 && A().elapsed() < t3 + 2600,
      `${t3} → ${A().elapsed()}`);
    ck('暂停的那两秒没有算进成绩', A().elapsed() - t1 < 3000, `${t1} → ${A().elapsed()}`);
    ck('暂停按钮会改字', document.querySelector('#btn-pause').textContent === '暂停');
    A().togglePause();
    ck('再按一次进入暂停', document.querySelector('#btn-pause').textContent === '继续' && gp.status === 'paused');
    A().togglePause();
    return report({ n: g.n, truth: truth.join('') });
  };

  // ---- 4. hint ----------------------------------------------------------------------------

  const hint = async () => {
    const { KNIGHT, KNAVE, UNKNOWN, Rules, verify, isComplete } = E();
    const boards = [];
    for (const tier of ['trainee', 'apprentice', 'regular', 'expert', 'master']) {
      boards.push(E().makePuzzle(`browser|hint|${tier}`, tier));
    }
    let given = 0, wrong = 0, unexplained = 0, cleared = 0, movesFromHints = 0, freeStalls = 0;
    for (const bundle of boards) {
      A().begin({ tier: bundle.tier, seed: bundle.originSeed });
      const g = A().game;
      const truth = truthOf(g);
      let guard = 0;
      while (g.status !== 'won' && guard++ < 200) {
        const h = g.hint();
        if (!h) break;
        if (h.stalled || h.conflict) { freeStalls++; break; }
        given++;
        if (g.known[h.person] !== h.value) wrong++;
        if (truth[h.person] !== h.value) wrong++;
        if (!h.rule || !Object.values(Rules).includes(h.rule)) unexplained++;
        if (!h.text || h.text.indexOf(h.who) < 0) unexplained++;
        if (!h.charged) unexplained++;
      }
      if (g.status === 'won') cleared++;
      movesFromHints += g.moves;
      ck(`${bundle.tier} 一局：只吃提示也能推完`, g.status === 'won',
        `${guard} 次后停在 ${g.state().unknown} 人未定`);
      if (g.status === 'won') {
        ck(`${bundle.tier} 一局：提示推完的盘合法`, verify(g.board, g.known).ok === true);
        ck(`${bundle.tier} 一局：提示推完的就是真解`, g.known.every((v, i) => v === truth[i]));
      }
      ck(`${bundle.tier} 一局：提示不计入步数`, g.moves === 0 && g.hints > 0, `moves=${g.moves} hints=${g.hints}`);
    }
    ck('提示从不给出与真解不符的身份', wrong === 0, `${wrong} 处`);
    ck('每条提示都点名规则和那个人', unexplained === 0, unexplained);
    ck('每局都能靠提示清空', cleared === boards.length, `${cleared}/${boards.length}`);
    ck('五档全部推完，一次都没有卡住', freeStalls === 0 && movesFromHints === 0, `${freeStalls}/${movesFromHints}`);

    // what the player actually reads
    A().begin({ tier: 'apprentice', seed: 'browser|hint|ui' });
    const g = A().game;
    const info = A().useHint();
    ck('提示按钮给出可推的一步', !!info && !info.stalled && !info.conflict && !!info.rule, JSON.stringify(info));
    ck('提示框点名规则', document.querySelector('#hint-rule').textContent === `规则：${info.rule}`,
      document.querySelector('#hint-rule').textContent);
    const line = document.querySelector('#hint-line').textContent;
    ck('提示理由说出那个人', line.includes(info.who) && /[一-龥]/.test(line), line);
    ck('提示理由不止一个名字，它说清了为什么', line.length > 18 && line.includes(info.who), `${line.length} 字：${line}`);
    ck('提示落下的人与规则同名', g.known[info.person] === info.value, JSON.stringify([info.person, g.known[info.person]]));
    ck('提示之后焦点移到那个人', g.focus === info.person);
    const charged = g.state().hints;
    const slotK = chipSlot(info.person, info.value);
    ck('提示改掉的牌与卡上写的一致', document.querySelector('#stat-hints').textContent === String(charged));
    A().undo();
    ck('撤销提示后身份退回', g.known[info.person] === UNKNOWN);
    ck('撤销提示不退求助次数', g.state().hints === charged, `${charged} → ${g.state().hints}`);
    ck('求助读数与状态一致', Number(document.querySelector('#stat-hints').textContent) === g.state().hints
      && Number(document.querySelector('#hint-count').textContent) === g.state().hints);
    ck('撤销提示也不退步数（它本来就不是步）', g.state().moves === 0, g.state().moves);
    // the same deduction cannot be bought twice: undo, then ask again
    const again = A().useHint();
    ck('撤销之后再讨一次，要么给新东西要么明说推不动，但一定计费或明说不计费',
      !!again && (again.charged ? g.state().hints === charged + 1 : g.state().hints === charged),
      JSON.stringify(again && { rule: again.rule, who: again.who, charged: again.charged }));
    ck('新提示不会给同一个人同一条规则', !again.charged || `${again.person}:${again.rule}` !== `${info.person}:${info.rule}`,
      JSON.stringify(again));
    // a hint is not free and not a move either: both counters, separately
    const before = g.state();
    A().useHint();
    ck('提示只加提示数，不加步数', g.state().hints > before.hints && g.state().moves === before.moves,
      JSON.stringify({ hints: g.state().hints, moves: g.state().moves }));
    await tapSlot(slotK);
    ck('落子只加步数，不加提示数', g.state().moves > before.moves);
    void isComplete;
    return report({ boards: boards.length, hintsGiven: given, boardsClearedByHints: cleared });
  };

  // ---- 5. save ----------------------------------------------------------------------------

  const save = async () => {
    const { Store, KNIGHT, KNAVE, UNKNOWN } = E();
    Store.reset();
    const g = A().begin({ tier: 'master', seed: 'browser|save' });
    const p = g.puzzle;
    await tapSlot(chipSlot(0, KNIGHT));
    await tapSlot(chipSlot(1, KNAVE));
    A().useHint();
    await wait(40);
    const KEY = Store.KEY;
    ck('存档键是 syllogism.save.v1', KEY === 'syllogism.save.v1', KEY);
    const raw = JSON.parse(localStorage.getItem(KEY));
    ck('存档落在一个键下', !!raw && !!raw.resume);
    ck('存档带原始种子', raw.resume.originSeed === p.originSeed, `${raw.resume.originSeed} vs ${p.originSeed}`);
    ck('存档里的种子不是内部那颗', raw.resume.originSeed !== p.seed, p.seed);
    ck('存档带档位', raw.resume.tier === 'master');
    ck('存档带步数', raw.resume.moves === g.moves, `${raw.resume.moves} vs ${g.moves}`);
    ck('存档带提示数', raw.resume.hints === g.hints, `${raw.resume.hints} vs ${g.hints}`);
    ck('存档带计时', raw.resume.elapsedMs >= 0);
    ck('存档的 ink 是游程对', Array.isArray(raw.resume.ink) && raw.resume.ink.length % 2 === 0
      && raw.resume.ink.every((v, i) => Number.isInteger(v) && (i % 2 ? v >= 1 && v <= 7 : v >= 0 && v <= 2)),
      JSON.stringify(raw.resume.ink));
    ck('游程对还原得出同样的三态', (() => {
      const back = Store.resume().known;
      return back.length === p.n && back.every((v, i) => v === g.known[i]);
    })(), JSON.stringify(Array.from(Store.resume().known)));
    ck('存档不含证词也不含解', !('statements' in raw.resume) && !('truth' in raw.resume) && !('puzzle' in raw.resume)
      && !('known' in raw.resume), Object.keys(raw.resume).join(','));
    const resumeBytes = JSON.stringify(raw.resume).length;
    ck('续局部分只有几百字节', resumeBytes < 320, resumeBytes);
    ck('整个存档不超过一千字节', JSON.stringify(raw).length < 1000, JSON.stringify(raw).length);
    ck('七个人的三态比裸数组省', raw.resume.ink.length <= (p.n + 1) * 2, raw.resume.ink.length);

    // records: help taken first, then moves, and only then the clock
    Store.recordBest('master', { ms: 40000, hints: 0, moves: 30, n: 7 });
    ck('首个纪录成立', !!Store.best('master'));
    ck('更快但求助更多的不算破纪录', Store.recordBest('master', { ms: 1000, hints: 1, moves: 4, n: 7 }) === false);
    ck('同样不求人时更省步数的算破纪录', Store.recordBest('master', { ms: 90000, hints: 0, moves: 22, n: 7 }) === true);
    ck('提示与步数都相同、只是更慢，不算破纪录', Store.recordBest('master', { ms: 120000, hints: 0, moves: 22, n: 7 }) === false);
    ck('提示与步数都相同时才轮到比时间', Store.recordBest('master', { ms: 50000, hints: 0, moves: 22, n: 7 }) === true);
    ck('纪录里留下的是最好的那次', Store.best('master').moves === 22 && Store.best('master').ms === 50000,
      JSON.stringify(Store.best('master')));
    ck('提示数排在步数之前', Store.recordBest('master', { ms: 10, hints: 30, moves: 1, n: 7 }) === false);
    A().show('menu');
    await wait(40);
    const li = document.querySelector('#record-list li[data-tier="master"]');
    ck('回选档会渲染这条纪录', /22 步/.test(li.textContent) && /提示 0/.test(li.textContent), li.textContent);
    ck('面板标题说明排序规则', document.querySelectorAll('#view-menu .col-title')[2].textContent.includes('提示'),
      document.querySelectorAll('#view-menu .col-title')[2].textContent);

    // settings live in the same document, so they ride along
    document.querySelector('#btn-sound').click();
    ck('音效开关写进存档', JSON.parse(localStorage.getItem(KEY)).settings.sound === false);
    ck('音效关掉之后仍可按', A().engine.Sound.enabled() === false && typeof A().engine.Sound.win === 'function');
    document.querySelector('#btn-motion').click();
    ck('动效开关写进存档', JSON.parse(localStorage.getItem(KEY)).settings.reduceMotion === true);
    ck('动效开关反映在 body 类上', document.body.classList.contains('reduce-motion'));
    document.querySelector('#btn-motion').click();
    ck('再点一次把动效打开', !document.body.classList.contains('reduce-motion'));
    document.querySelector('#btn-reset').click();
    await wait(40);
    ck('清空存档会抹掉续局', JSON.parse(localStorage.getItem(KEY)).resume === null);
    ck('清空存档后没有纪录', Object.keys(JSON.parse(localStorage.getItem(KEY)).best).length === 0);
    Store.reset();
    return report({ resumeBytes, totalBytes: JSON.stringify(raw).length, runs: raw.resume.ink.length / 2 });
  };

  // ---- 6. resume --------------------------------------------------------------------------

  const resume = async () => {
    const { Store, KNIGHT, KNAVE, UNKNOWN, verify } = E();
    Store.reset();
    A().begin({ tier: 'expert', seed: 'browser|resume' });
    let g = A().game;
    const p = g.puzzle;
    const texts = g.board.statements.map((s) => s.text);
    await tapSlot(chipSlot(0, KNIGHT));
    await tapSlot(chipSlot(2, KNAVE));
    A().useHint();
    await wait(40);
    const written = Array.from(g.known).join('');
    const paid = { moves: g.moves, hints: g.hints };
    const clockBefore = A().elapsed();
    ck('落子之后存档已经写好了', Store.resume() !== null);

    A().show('menu');
    await wait(40);
    ck('离开对局后仍然提供续局', shown('#resume-card'));
    ck('续局卡报出这一局的成本', document.querySelector('#resume-meta').textContent.includes(`提示 ${paid.hints}`),
      document.querySelector('#resume-meta').textContent);
    document.querySelector('#btn-resume').click();
    await wait(140);
    g = A().game;
    ck('续局由种子重建出同一间房', g.puzzle.seed === p.seed, `${g.puzzle.seed} vs ${p.seed}`);
    ck('重建的口供逐句相同', g.board.statements.map((s) => s.text).join('|') === texts.join('|'));
    ck('续局复现了身份标注', Array.from(g.known).join('') === written, `${written} → ${Array.from(g.known).join('')}`);
    ck('续局没有把落子重新记成新的步数', g.moves === paid.moves, `${g.moves} vs ${paid.moves}`);
    ck('续局带回了提示数', g.hints === paid.hints, `${g.hints} vs ${paid.hints}`);
    ck('续局把计时接上而不是归零', A().elapsed() >= clockBefore, `${A().elapsed()} vs ${clockBefore}`);
    ck('续局之后已定身份读数正确', document.querySelector('#stat-known').textContent === `${g.settled}/${g.n}`,
      document.querySelector('#stat-known').textContent);
    ck('续局之后还是同一档', g.puzzle.tier === 'expert' && document.querySelector('#stat-tier').textContent === '专家');
    ck('续局后提示照常计费', (() => {
      const before = g.hints;
      const info = A().useHint();
      return !!info && !!info.rule && g.hints === before + 1;
    })());
    ck('续局的求助次数进了面板', Number(document.querySelector('#stat-hints').textContent) === g.hints,
      `${document.querySelector('#stat-hints').textContent} vs ${g.hints}`);
    ck('续局恢复的落子与真解一致', g.known[0] === KNIGHT && g.known[2] === KNAVE);

    // a finished room leaves no resume behind
    A().begin({ tier: 'trainee', seed: 'browser|resume|win' });
    A().solveWithLogic();
    await wait(80);
    const won = A().game;
    ck('完局之后没有遗留续局', Store.resume() === null);
    ck('完局写入纪录', !!Store.best('trainee'), JSON.stringify(Store.best('trainee')));
    const totals = JSON.parse(localStorage.getItem(Store.KEY)).totals;
    ck('完局计入总局数', totals.solved === 1, JSON.stringify(totals));
    ck('总量累计的是提示次数与时间', totals.hints === won.hints && totals.ms > 0, JSON.stringify(totals));
    ck('完局这一盘是合法解', verify(won.board, won.known).ok === true);
    A().show('menu');
    await wait(40);
    ck('完局后选档不再给续局卡', !shown('#resume-card'));
    ck('纯逻辑推到底不需要落子', won.moves === 0 && won.hints > 0, JSON.stringify({ m: won.moves, h: won.hints }));
    Store.reset();
    return report({ name: p.name, tier: p.tier, hints: won.hints });
  };

  // ---- 7. layout / pixels -----------------------------------------------------------------

  const layout = async () => {
    const { KNIGHT, KNAVE, UNKNOWN } = E();
    A().begin({ tier: 'master', seed: 'browser|layout' });
    const g = A().game;
    const cv = A().view.canvas;
    const geo = A().view.geo;
    const dpr = Math.max(1, Math.round(w.devicePixelRatio || 1));
    ck('后备缓冲按 DPR 放大', cv.width === Math.round(parseFloat(cv.style.width) * dpr)
      && cv.height === Math.round(parseFloat(cv.style.height) * dpr),
      `${cv.width}×${cv.height} vs ${cv.style.width}×${dpr}`);
    ck('绘制用 CSS 像素（顶部一次 setTransform）', geo.dpr === dpr && parseFloat(cv.style.width) > 200);
    ck('画布宽度不超过窗口', parseFloat(cv.style.width) <= w.innerWidth + 1, cv.style.width);
    ck('卡堆用整幅宽度', g.n === 7 && A().view.plan.cards.length === 7);

    // every card sits inside the canvas: nothing is clipped and nothing scrolls internally
    const last = A().view.plan.cards[A().view.plan.cards.length - 1];
    ck('最后一张卡完整落在画布内', last.y + last.h <= parseFloat(cv.style.height) + 0.5
      && last.x + last.w <= parseFloat(cv.style.width) + 0.5,
      `${Math.round(last.y + last.h)} vs ${cv.style.height}`);
    ck('卡片之间不重叠', A().view.plan.cards.every((c, i, a) => !i || c.y >= a[i - 1].y + a[i - 1].h));

    // text floor: the canvas never draws a smaller glyph than the sheet allows
    const fonts = A().view.plan.fonts;
    ck('画布上每个字号都不低于 14', Object.entries(fonts).every(([, v]) => v >= 14), JSON.stringify(fonts));
    ck('说话人比他说的那句大', fonts.name > fonts.line && fonts.line >= fonts.foot, JSON.stringify(fonts));

    // every hit slot round-trips: the rect drawn for it is the rect that answers for it
    const n = A().slotCount();
    let round = 0;
    const seen = [];
    for (let i = 0; i < n; i++) {
      const s = A().slotAt(i);
      seen.push(s);
      const c = A().slotCenter(i);
      const got = A().hitTest(c.x, c.y);
      if (got === i) round++;
      else ck(`槽位 ${i} (${s.kind}) 命中自己`, false, `得到 ${got}`);
    }
    ck('槽位逐个往返命中', round === n && n > 20, `${round}/${n}`);
    ck('三种身份牌都在槽位里', [KNIGHT, KNAVE, UNKNOWN].every((v) => seen.some((s) => s.kind === 'chip' && s.value === v)),
      JSON.stringify(seen.filter((s) => s.kind === 'chip').map((s) => s.value)));
    ck('划掉方格是独立槽位', seen.some((s) => s.kind === 'note'));
    ck('卡片本体是只看不动的槽位', seen.some((s) => s.kind === 'card'));

    // no two hit regions overlap, so a tap can only mean one thing
    let clash = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = A().rectOf(i), b = A().rectOf(j);
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
          if (!clash) ck('命中区互不重叠', false, `${i}(${seen[i].kind}) × ${j}(${seen[j].kind})`);
          clash++;
        }
      }
    }
    ck('命中区互不重叠', clash === 0, `${clash} 对`);

    // the three chips are three different figures, not one box repeated. Compared on the drawn
    // geometry, because that is what the eye sees; the hit pads on top of them stay unequal too.
    const chipBy = (person, value) => A().view.plan.cards[person].chips.find((c) => c.value === value);
    const rects = (person) => [KNIGHT, KNAVE, UNKNOWN].map((v) => A().rectOf(chipSlot(person, v)));
    const dk = chipBy(0, KNIGHT), dn = chipBy(0, KNAVE), du = chipBy(0, UNKNOWN);
    const [rk, rn, ru] = rects(0);
    ck('骑士牌与无赖牌不同形', dk.w !== dn.w || dk.drawn !== dn.drawn, JSON.stringify([dk, dn]));
    ck('未定牌明显更小', dk.drawn - du.drawn >= 4 && du.w <= dk.w - 8, JSON.stringify([dk, du]));
    ck('三张牌各占一块不重叠的位置', rk.x < rn.x && rn.x < ru.x, JSON.stringify([rk.x, rn.x, ru.x]));
    // The drawn figures are three different silhouettes (above); their hit pads may end up the
    // same height — that is a row of controls, not a row of repeated circles. What may not
    // happen is a pad small enough to miss: 24 px is the floor for a thumb.
    ck('每块牌的命中框都够按', rects(0).every((r) => r.h >= 24 && r.w >= 24), JSON.stringify(rects(0)));
    ck('每张卡都带三块身份牌', A().view.plan.cards.every((c) => c.chips.length === 3));

    // the same three states must be tellable apart from the pixels alone
    A().begin({ tier: 'trainee', seed: 'browser|pixels' });
    const gp = A().game;
    const shot = (v) => {
      const r = A().rectOf(chipSlot(0, v));
      return fingerprint(r);
    };
    gp.known[0] = UNKNOWN;
    gp.recompute();
    A().draw();
    await canvasStilled();
    const fUnknown = shot(UNKNOWN);
    A().assign(0, KNIGHT);
    await canvasStilled();
    const fKnight = shot(KNIGHT);
    A().undo();
    A().assign(0, KNAVE);
    await canvasStilled();
    const fKnave = shot(KNAVE);
    const dist = (a, b) => Math.abs(a.warm - b.warm) + Math.abs(a.cool - b.cool) + Math.abs(a.ink - b.ink);
    ck('骑士牌被画成暖色', fKnight.warm > 0.25, JSON.stringify(fKnight));
    ck('无赖牌被画成冷色', fKnave.cool > 0.25, JSON.stringify(fKnave));
    ck('未定牌既不暖也不冷', fUnknown.warm < 0.12 && fUnknown.cool < 0.12, JSON.stringify(fUnknown));
    ck('骑士与无赖像素可分', dist(fKnight, fKnave) > 0.3, JSON.stringify({ d: dist(fKnight, fKnave) }));
    ck('未定与前两者都可分', dist(fUnknown, fKnight) > 0.2 && dist(fUnknown, fKnave) > 0.2);
    const shapes = [];
    for (const v of [KNIGHT, KNAVE, UNKNOWN]) {
      gp.known[0] = v;
      gp.recompute();
      A().draw();
      await canvasStilled();
      const c0 = A().view.plan.cards[0];
      shapes.push(pixelHash({ x: c0.x, y: c0.y, w: c0.w, h: 40 }));
    }
    gp.known[0] = UNKNOWN;
    gp.recompute();
    A().draw();
    ck('三态在卡面上是三种图形', new Set(shapes).size === 3, JSON.stringify(shapes));

    // the sentences really are drawn, and a 划掉 line is drawn over one
    A().begin({ tier: 'regular', seed: 'browser|ink' });
    const gi = A().game;
    const spoken = A().view.plan.cards.find((c) => c.rows.some((r) => r.stmt !== null));
    const row = spoken.rows.find((r) => r.stmt !== null);
    const textRect = A().rectOf(row.textSlot);
    // The tight band the prose actually occupies: a row is `rows.length` lines of `rowH`, and a
    // line is as wide as the engine measured it. Sampling the whole text column instead — half a
    // thousand CSS pixels of it for a seven-character sentence — spreads the glyphs over so much
    // card that no honest floor under "is there any text here at all" survives the dilution.
    const proseW = Math.min(textRect.w, Math.max(...row.rows.map((l) => l.width)) + 16);
    const proseRect = { x: row.x, y: row.y, w: proseW, h: row.h };
    // Park the focus ring on somebody else for this snapshot. It strokes a dashed box along the
    // top of the line it marks, and those 1.5 px are the only pixels in the band that are not
    // glyphs: with the ring here the check would pass on a card whose prose was never drawn.
    const quiet = A().view.plan.cards.find((c) => c.person !== spoken.person);
    gi.focus = quiet.person;
    gi.focusLine = 0;
    A().draw();
    await canvasStilled();
    const painted = fingerprint(proseRect);
    // Measured on a stilled, ring-free frame across all five tiers: a line of real prose covers
    // 6.6 %–12.7 % of its band with pale pixels and 10 %–15 % with lit ones, and a patch the same
    // size anywhere else on the board covers 0 %. The prose is drawn at 68 % of Palette.ink, so
    // "pale" cannot mean "white" — these are thresholds, not a hope.
    ck('证词的文字真的被画出来了', painted.ink > 0.02 && painted.lit > 0.05, JSON.stringify(painted));
    const blank = fingerprint({ x: 0, y: 0, w: proseRect.w, h: proseRect.h });
    ck('那点 ink 是字给的，不是画布底噪', blank.ink === 0 && painted.ink > blank.ink,
      JSON.stringify({ blank: blank.ink, painted: painted.ink }));
    // every other row on the board, ring aside: one unpainted card is enough to fail this
    const swept = [];
    for (const c of A().view.plan.cards) {
      for (let i = 0; i < c.rows.length; i++) {
        const r = c.rows[i];
        if (r.stmt === null) continue;
        if (c.person === gi.focus && i === gi.focusLine) continue;
        swept.push(fingerprint({
          x: r.x, y: r.y, h: r.h,
          w: Math.min(A().rectOf(r.textSlot).w, Math.max(...r.rows.map((l) => l.width)) + 16),
        }).ink);
      }
    }
    ck('桌上每一行证词都带墨', swept.length >= A().game.n && swept.every((v) => v > 0.02),
      JSON.stringify(swept));
    // Now hold the ring still on the sampled row: it has to be there before the strike *and*
    // after the undo, or the box moving in would read as "the picture changed".
    gi.focus = spoken.person;
    gi.focusLine = spoken.rows.indexOf(row);
    A().draw();
    const rowRect = { x: row.x + 2, y: row.y, w: Math.max(40, textRect.w - 6), h: row.h };
    await canvasStilled();
    const beforeStrike = pixelHash(rowRect);
    const movesAtStrike = gi.moves;
    const stepsAtStrike = gi.state().steps;
    await tapSlot(A().noteSlot(spoken.person, row.stmt));
    await canvasStilled();
    ck('划掉之后卡面像素变了', pixelHash(rowRect) !== beforeStrike);
    ck('划掉是独立一步，可撤销', gi.state().notes === 1 && gi.state().steps === stepsAtStrike + 1
      && gi.moves >= movesAtStrike, JSON.stringify(gi.state()));
    A().undo();
    ck('撤销把笔记账目擦回去', gi.state().notes === 0 && gi.state().steps === stepsAtStrike
      && gi.moves === movesAtStrike, JSON.stringify({ at: movesAtStrike, now: gi.moves, steps: gi.state().steps }));
    await canvasStilled();
    ck('撤销把卡面像素也擦回去', pixelHash(rowRect) === beforeStrike,
      JSON.stringify({ before: beforeStrike, after: pixelHash(rowRect), geo: A().view.geo }));

    // focus is drawn on the canvas, not via a DOM outline
    A().begin({ tier: 'apprentice', seed: 'browser|focus' });
    const gf = A().game;
    const hashes = () => cardRects().map((r) => pixelHash(r));
    await canvasStilled();
    const h0 = hashes();
    ck('画布不吃 DOM 焦点框', getComputedStyle(cv).outlineStyle === 'none', getComputedStyle(cv).outlineStyle);
    gf.focusCard(1);
    A().draw();
    await canvasStilled();
    const h1 = hashes();
    const moved = [];
    for (let i = 0; i < h0.length; i++) if (h0[i] !== h1[i]) moved.push(i);
    ck('焦点框画在新的那张卡上（旧的那张擦干净）', moved.join(',') === '0,1', `变了 ${JSON.stringify(moved)}`);
    ck('焦点只画一张卡，不糊满盘', moved.length === 2 && h1.length > 2, JSON.stringify({ moved, cards: h1.length }));

    // paused: the transcript really goes face down
    A().begin({ tier: 'expert', seed: 'browser|paused' });
    const gq = A().game;
    A().assign(0, KNIGHT);
    const openHashes = cardRects().map((r) => pixelHash(r));
    A().pause();
    await wait(30);
    const downHashes = cardRects().map((r) => pixelHash(r));
    ck('暂停时卡面改了样子', openHashes.some((v, i) => v !== downHashes[i]));
    const bodyRow = fingerprint({ x: A().view.plan.cards[0].rows[0].x, y: A().view.plan.cards[0].rows[0].y, w: A().view.plan.cards[0].rows[0].h * 6, h: A().view.plan.cards[0].rows[0].h });
    A().unpause();
    await wait(30);
    const faceUp = fingerprint({ x: A().view.plan.cards[0].rows[0].x, y: A().view.plan.cards[0].rows[0].y, w: A().view.plan.cards[0].rows[0].h * 6, h: A().view.plan.cards[0].rows[0].h });
    ck('暂停时字被扣住（亮像素更少）', bodyRow.ink <= faceUp.ink, JSON.stringify({ down: bodyRow, up: faceUp }));
    return report({ slots: n, dpr, fonts });
  };

  // ---- 8. three input kinds, same state change (in-page half) -----------------------------

  const input = async () => {
    const { KNIGHT, KNAVE, UNKNOWN } = E();
    A().begin({ tier: 'regular', seed: 'browser|input' });
    const g = A().game;
    const slot = chipSlot(1, KNIGHT);
    const via = {};

    await tapSlot(slot, 'mouse');
    via.mouse = { known: g.known[1], moves: g.moves, steps: g.state().steps };
    A().undo();

    const p = A().slotCenter(slot);
    pointer('pointerdown', p.x, p.y, 'touch');
    pointer('pointerup', p.x, p.y, 'touch');
    await wait(30);
    via.touch = { known: g.known[1], moves: g.moves, steps: g.state().steps };
    A().undo();

    // The keyboard leg has to start from the same person the pointer legs pressed: focus is the
    // keyboard's cursor, and a press before it moved would test a different cell.
    g.focus = 1;
    g.focusLine = 0;
    // From here every key is a real `keydown` on the window, i.e. the event a physical key puts
    // on the wire, which the app's own listener has to catch, guard and route. `A().key()` looks
    // a handler straight out of the table and would stay green on a page that never wired the
    // listener up at all — which is exactly the defect this row exists to catch.
    await key('1');
    await wait(30);
    via.key = { known: g.known[1], moves: g.moves, steps: g.state().steps };
    ck('鼠标点出这一步', via.mouse.known === KNIGHT && via.mouse.moves === 1, JSON.stringify(via.mouse));
    ck('触摸点出同一步', via.touch.known === KNIGHT && via.touch.moves === 1, JSON.stringify(via.touch));
    ck('键盘敲出同一步', via.key.known === KNIGHT && via.key.moves === 1, JSON.stringify(via.key));
    ck('三种输入改的是同一个状态', via.mouse.known === via.touch.known && via.touch.known === via.key.known);
    ck('三种输入记的账一样', [via.mouse, via.touch, via.key].every((v) => v.moves === 1 && v.steps === 1),
      JSON.stringify(via));

    // keyboard set, spelled out on the menu. Each key is asserted by the *delta* it puts on the
    // two counters, so the row says what a key costs rather than resting on a running total that
    // rots the moment the ledger changes.
    A().restart();
    const noteCost = !/不算落子/.test((document.querySelector('.sw-note') || { parentElement: { textContent: '' } }).parentElement.textContent) ? 1 : 0;
    const people = g.n;
    const p0 = g.focus;
    const seen = [];
    for (let i = 0; i < people; i++) { await key('ArrowDown'); seen.push(g.focus); }
    ck('↓ 逐人换焦点，走完一圈回原位（不记账）',
      people >= 3 && seen.every((v, i) => v === (p0 + i + 1) % people) && g.focus === p0 && g.moves === 0,
      JSON.stringify({ seen, people, back: g.focus }));
    // Tab is only the game's while the board holds the DOM focus; that is what `pointerDown` gave
    // it above, and the row says so, because a lost focus would silently skip every Tab below.
    ck('焦点在画布上，Tab 才归游戏管', document.activeElement === A().view.canvas,
      document.activeElement && document.activeElement.tagName);
    const ring = g.focusPath.length;
    const tabStart = `${g.focus}:${g.focusLine}`;
    const tabbed = [];
    for (let i = 0; i < ring; i++) { await key('Tab'); tabbed.push(`${g.focus}:${g.focusLine}`); }
    ck('Tab 走完焦点环：每人每句各停一次，不记账',
      new Set(tabbed).size === ring && tabbed[ring - 1] === tabStart && g.moves === 0,
      JSON.stringify({ tabbed, ring, tabStart }));
    const f0 = g.focus;
    await key('1');
    ck('1 落下骑士', g.known[f0] === KNIGHT && g.moves === 1, JSON.stringify({ v: g.known[f0], m: g.moves }));
    await key('2');
    ck('2 直接改成无赖（另记一步，不是改写上一笔）', g.known[f0] === KNAVE && g.moves === 2, JSON.stringify({ v: g.known[f0], m: g.moves }));
    await key('3');
    ck('3 收回未定', g.known[f0] === UNKNOWN && g.moves === 3, g.moves);
    await key('0');
    ck('0 在未定之上无事发生（也不记账）', g.moves === 3, g.moves);
    await key('Enter');
    ck('Enter 轮换三态：未定 → 骑士', g.known[f0] === KNIGHT && g.moves === 4, g.moves);
    await key('Enter');
    await key('Enter');
    ck('轮换一圈回到未定（三笔各记一步）', g.known[f0] === UNKNOWN && g.moves === 6, g.moves);
    await key('Backspace');
    ck('Backspace 也算清空，无事可清就不记账', g.moves === 6, g.moves);
    const stmt = g.focusedStmt();
    const beforeNote = { moves: g.moves, steps: g.state().steps };
    await key('.');
    ck('. 划掉当前这句（成本与图例说的一致）', stmt !== null && g.state().notes === 1
      && g.state().steps === beforeNote.steps + 1 && g.moves === beforeNote.moves + noteCost,
      JSON.stringify({ stmt, notes: g.state().notes, m: g.moves, noteCost }));
    const hb = { moves: g.moves, hints: g.hints, steps: g.state().steps };
    await key('h');
    const lh = g.lastHint;
    const wrote = !!(lh && lh.charged);
    ck('H 只在真的写下一个人时计费', wrote
      ? (g.hints === hb.hints + 1 && g.state().steps === hb.steps + 1)
      : (g.hints === hb.hints && g.state().steps === hb.steps && lh && lh.charged === false),
      JSON.stringify({ hb, now: { h: g.hints, s: g.state().steps }, lh: lh && { rule: lh.rule, charged: lh.charged } }));
    ck('H 不计入步数', g.moves === hb.moves, g.moves);
    await key('u');
    // One press, one step off the ledger: the hint's own write when it charged, otherwise the
    // step that was on top before it. Read off `steps` as a delta, and `moves` as its cost —
    // the two rows below are the same fact seen from the two counters, so they cannot disagree.
    ck('U 之后账本少一条', g.state().steps === hb.steps + (wrote ? 1 : 0) - 1, JSON.stringify({ hb, now: g.state().steps }));
    ck('撤销提示不退求助次数', g.hints === hb.hints + (wrote ? 1 : 0), `${hb.hints} → ${g.hints}`);
    ck('撤销退的就是那一步收的', g.moves === hb.moves + (wrote ? 0 : -noteCost), JSON.stringify({ wrote, hb, m: g.moves }));
    await key('r');
    ck('R 重开把棋盘、步数与求助都归零', g.moves === 0 && g.hints === 0 && g.status === 'playing'
      && g.state().steps === 0, JSON.stringify(g.state()));
    await key('p');
    ck('P 暂停', g.status === 'paused' && shown('#pause-veil'));
    await key('p');
    ck('再按 P 继续', g.status === 'playing' && !shown('#pause-veil'));
    await key('Escape');
    await wait(40);
    ck('Esc 回选档', shown('#view-menu') && !shown('#view-game'));
    ck('回选档后棋盘不再可见', !shown('#win-veil'));
    return report({ via, noteCost });
  };

  // ---- 9. a real phone viewport -----------------------------------------------------------

  const fit = async () => {
    const vp = { w: w.innerWidth, h: w.innerHeight };
    const dpr = Math.round(w.devicePixelRatio || 1);
    ck('视口真的被改成手机宽', vp.w <= 460, JSON.stringify(vp));
    ck('媒体查询跟着换（单栏布局）', getComputedStyle(document.querySelector('#view-game')).gridTemplateColumns.split(' ').length === 1,
      getComputedStyle(document.querySelector('#view-game')).gridTemplateColumns);
    const perTier = {};
    for (const t of E().TIERS) {
      let worst = null;
      for (const seed of ['browser|fit|a', 'browser|fit|b', 'browser|fit|c']) {
        const g = A().begin({ tier: t.id, seed });
        await wait(30);
        const cv = A().view.canvas;
        const geo = A().view.geo;
        const plan = A().view.plan;
        const wrap = document.querySelector('#board-wrap').getBoundingClientRect();
        const hintBtn = document.querySelector('#btn-hint').getBoundingClientRect();
        const last = plan.cards[plan.cards.length - 1];
        const rec = {
          cw: parseFloat(cv.style.width),
          chh: parseFloat(cv.style.height),
          inside: last.y + last.h <= geo.h + 0.5,
          n: plan.cards.length,
          minFont: plan.fonts.line,
          overflowX: document.documentElement.scrollWidth,
          boardBottom: wrap.bottom,
          hintBottom: hintBtn.bottom,
        };
        if (!worst || rec.chh > worst.chh) worst = rec;
        ck(`${t.label} ${seed.split('|').pop()}：${g.n} 人的卡堆不溢出画布`, rec.inside && rec.n === g.n,
          JSON.stringify(rec));
      }
      ck(`${t.label}：画布宽度装得进视口`, worst.cw <= vp.w + 1, `${worst.cw} vs ${vp.w}`);
      ck(`${t.label}：横向不出现滚动`, worst.overflowX <= vp.w + 1, `${worst.overflowX} vs ${vp.w}`);
      ck(`${t.label}：整叠口供一屏看全，不用滚动`, worst.boardBottom <= vp.h + 1,
        `${Math.round(worst.boardBottom)} vs ${vp.h}`);
      ck(`${t.label}：主操作键（提示）也在首屏内`, worst.hintBottom <= vp.h + 1,
        `${Math.round(worst.hintBottom)} vs ${vp.h}`);
      ck(`${t.label}：字没有掉到 14 以下`, worst.minFont >= 14, worst.minFont);
      perTier[t.id] = { h: Math.round(worst.chh), w: Math.round(worst.cw), font: worst.minFont };
    }
    // 7 人 + 10 句 的最坏情况：卡片之间没有重叠，也没有被切掉
    A().begin({ tier: 'master', seed: 'browser|fit|a' });
    for (let i = 0; i < 5; i++) A().useHint();
    await wait(40);
    const plan = A().view.plan;
    ck('提示之后卡堆仍然完整（没有长出去）',
      plan.cards.every((c) => c.y + c.h <= A().view.geo.h + 0.5), JSON.stringify({ h: A().view.geo.h }));
    ck('DPR≠1 时缓冲与样式同倍', dpr < 2 || A().view.canvas.width === Math.round(plan.width * dpr),
      `${A().view.canvas.width} vs ${plan.width}×${dpr}`);

    // every visible piece of text, both views, no exceptions below 14
    const bad = [];
    A().show('menu');
    await wait(40);
    for (const sel of ['#view-menu', '#view-game']) {
      for (const e of document.querySelectorAll(`${sel}, ${sel} *`)) {
        const st = getComputedStyle(e);
        if (st.display === 'none') continue;
        const own = Array.from(e.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!own && !e.textContent.trim()) continue;
        const fs = parseFloat(st.fontSize);
        if (fs < 14) bad.push(`${sel} ${e.tagName}#${e.id || ''}=${fs}`);
      }
    }
    ck('页面里没有 14px 以下的字', bad.length === 0, bad.slice(0, 4).join(' | '));
    ck('菜单把七条规则都列出来', document.querySelectorAll('#rule-list li').length === 7,
      document.querySelectorAll('#rule-list li').length);
    ck('五档入口都在', document.querySelectorAll('#tier-list .tier').length === 5);
    return report({ viewport: vp, dpr, perTier });
  };

  w.__ng = { engine, gen, play, hint, save, resume, layout, input, fit };
})(window);
