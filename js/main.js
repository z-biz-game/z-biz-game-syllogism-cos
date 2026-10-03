// Wiring: the DOM, pointer/touch/keyboard gestures, the clock, storage, and the
// `window.syllogism` surface the verification harness drives. No rule of the game lives here —
// every judgement about the room comes from js/engine/logic.js through js/ui/game.js, and every
// number about where a chip sits comes from js/render/scene.js.
//
// One gesture = one step = one undo. A press previews the write so the picture follows the
// finger, and the release commits *that same* write, whose record is the value the cell held
// before the press. Lifting the finger somewhere else cancels the preview and the ledger stays
// untouched, which is why a drag across three chips cannot cost three moves.

import { applyThemeVars, setReduceMotion, systemPrefersReducedMotion, Board, Space } from './theme.js';
import { Sound } from './audio/synth.js';
import { Store } from './store.js';
import { TIERS, tierById, makePuzzle } from './engine/generate.js';
import * as Engine from './engine/logic.js';
import { countModels, matchesTruth, UNIQUE } from './engine/count.js';
import { dateSeed } from './engine/rng.js';
import { SceneView } from './render/scene.js';
import { Game, RuleGloss, AS_LABEL, KNIGHT, KNAVE, UNKNOWN } from './ui/game.js';

const VERSION = '1.0.0';
const GAP = 10;            // .stage's own flex gap, mirrored so the reserve matches the CSS
const $ = (sel) => document.querySelector(sel);

const el = {
  viewMenu: $('#view-menu'),
  viewGame: $('#view-game'),
  stage: $('#view-game .stage'),
  stageHead: $('.stage-head'),
  controls: $('.controls'),
  tiers: $('#tier-list'),
  records: $('#record-list'),
  rules: $('#rule-list'),
  resumeCard: $('#resume-card'),
  resumeName: $('#resume-name'),
  resumeMeta: $('#resume-meta'),
  dailyMeta: $('#daily-meta'),
  name: $('#stat-name'),
  tier: $('#stat-tier'),
  count: $('#stat-count'),
  time: $('#stat-time'),
  moves: $('#stat-moves'),
  hints: $('#stat-hints'),
  known: $('#stat-known'),
  knights: $('#stat-knights'),
  conflicts: $('#stat-conflicts'),
  notes: $('#stat-notes'),
  score: $('#stat-score'),
  seed: $('#stat-seed'),
  hintRule: $('#hint-rule'),
  hintLine: $('#hint-line'),
  hintCount: $('#hint-count'),
  conflictLine: $('#conflict-line'),
  wrap: $('#board-wrap'),
  canvas: $('#board'),
  winVeil: $('#win-veil'),
  winMeta: $('#win-meta'),
  winCheck: $('#win-check'),
  winRecord: $('#win-record'),
  pauseVeil: $('#pause-veil'),
};

const view = new SceneView(el.canvas);
let game = null;
let pulse = null;
let startedAt = 0;
let baseElapsed = 0;
let ticker = 0;
let press = null;          // { slot, write } — the preview awaiting its release

const clock = () => baseElapsed + (startedAt ? Date.now() - startedAt : 0);
const running = () => !!startedAt;

function fmtMs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// How much room the board actually has, measured off the live layout rather than guessed: the
// stage's own padding and the row of buttons under the canvas both move between the phone and
// the desktop grid, and a hard-coded reserve is how a board starts scrolling.
function availBox() {
  const stage = el.stage;
  const cs = getComputedStyle(stage);
  const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const rect = stage.getBoundingClientRect();
  const innerW = stage.clientWidth - padX;
  const headH = el.stageHead ? el.stageHead.offsetHeight : 0;
  const below = (el.conflictLine ? el.conflictLine.offsetHeight : 0)
    + (el.controls ? el.controls.offsetHeight : 120);
  const top = rect.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) + headH + GAP;
  return {
    w: Math.max(280, Math.floor(innerW)),
    h: Math.max(300, Math.floor(window.innerHeight - top - below - padY - borderY - GAP * 3)),
  };
}

function draw() {
  if (!game || el.viewGame.hidden) return;
  const { w, h } = availBox();
  view.resize(game, w, h);
  view.draw(game, { pulse });
}

// One place writes the readouts, so no panel number can go stale or disagree with the canvas.
function syncStats() {
  if (!game) return;
  const st = game.state();
  el.name.textContent = game.puzzle.name;
  el.tier.textContent = tierById(game.puzzle.tier).label;
  el.tier.dataset.tier = game.puzzle.tier;
  el.count.textContent = `${st.n} 人 · ${st.statements} 句`;
  el.time.textContent = fmtMs(clock());
  el.moves.textContent = st.moves;
  el.hints.textContent = st.hints;
  el.hintCount.textContent = st.hints;
  el.known.textContent = `${st.settled}/${st.n}`;
  el.knights.textContent = st.knights;
  el.conflicts.textContent = st.conflicts;
  el.notes.textContent = st.notes;
  el.score.textContent = game.puzzle.score.toFixed(1);
  el.seed.textContent = game.puzzle.originSeed;
  el.conflicts.closest('.stat').classList.toggle('bad', st.conflicts > 0);
  el.known.closest('.stat').classList.toggle('bad', st.status !== 'won' && st.unknown > 0);
  if (st.conflicts) {
    el.conflictLine.textContent = `已经有 ${st.conflicts} 句证词和你写下的身份对不上（牵动 ${st.peopleInConflict} 个人）—— 撤销一步，别把错的留在桌上。`;
  } else if (st.status === 'won') {
    el.conflictLine.textContent = '';
  } else {
    el.conflictLine.textContent = '';
  }
}

function syncAll() {
  syncStats();
  draw();
}

function flushResume() {
  if (!game || game.status === 'won') return;
  Store.saveResume(game.puzzle, game.known, clock(), { moves: game.moves, hints: game.hints });
}

function startClock() {
  startedAt = Date.now();
  clearInterval(ticker);
  ticker = setInterval(() => {
    el.time.textContent = fmtMs(clock());
    if (pulse) draw();
  }, 1000);
}

function stopClock() {
  baseElapsed = clock();
  startedAt = 0;
  clearInterval(ticker);
  ticker = 0;
}

// ---- the hint box: the rule's name and the person it settles, or an honest nothing ---------

function showHint(info) {
  if (!info) return;
  if (info.conflict) {
    el.hintRule.textContent = '盘面矛盾';
    el.hintLine.textContent = info.text;
    return;
  }
  if (info.stalled) {
    el.hintRule.textContent = '推不动了（这一次没有计费）';
    el.hintLine.textContent = info.text;
    return;
  }
  el.hintRule.textContent = `规则：${info.rule}`;
  const gloss = RuleGloss[info.rule] ? ` —— ${RuleGloss[info.rule]}` : '';
  el.hintLine.textContent = `${info.who} 是${AS_LABEL[info.value]}。${info.text}${gloss}`;
  pulse = { person: info.person };
  setTimeout(() => {
    if (pulse && pulse.person === info.person) pulse = null;
    draw();
  }, 1600);
  Sound.hint();
}

function onWin() {
  stopClock();
  const ms = clock();
  const better = Store.recordBest(game.puzzle.tier, {
    ms,
    hints: game.hints,
    moves: game.moves,
    n: game.n,
  });
  Store.recordSolve(ms, game.hints);
  Store.clearResume();
  el.winMeta.textContent = `${game.puzzle.name} · ${game.n} 人 · ${fmtMs(ms)} · ${game.moves} 步 · 提示 ${game.hints} 次`;
  // The line the player is entitled to: the win was granted by the independent check, not by
  // this file's own tally of how many cards got filled.
  el.winCheck.textContent = `独立检查：${game.state().statements} 句证词逐条回代，「说话人是骑士 ⇔ 那句为真」句句成立（未定 ${game.state().unknown} 人）。`;
  el.winRecord.textContent = better
    ? '新纪录：这一局比存档里的更不求人。'
    : '未破纪录：同档先比提示次数，再比步数，最后才比时间。';
  el.winVeil.hidden = false;
  el.conflictLine.textContent = '';
  Sound.win();
  syncAll();
  renderRecords();
}

function soundFor(write) {
  if (!write) return 'tap';
  if (write.field === 'note') return 'note';
  if (write.to === KNIGHT) return 'knight';
  if (write.to === KNAVE) return 'knave';
  return 'clear';
}

function afterStep(soundKey) {
  syncAll();
  if (game.status === 'won') {
    onWin();
    return;
  }
  flushResume();
  if (soundKey) Sound[soundKey]();
  if (game.diag.stmts.size) Sound.conflict();
}

// ---- one committed action from one slot ---------------------------------------------------

// Every input kind lands here: a chip press, a pencil press, a key. Same slot object, same
// `writeForSlot`, so mouse, touch and keyboard cannot drift into three different games.
function commitSlot(slot, kind) {
  if (!game) return null;
  if (!slot || slot.kind === 'card') {
    if (slot && slot.person !== undefined) {
      game.focus = slot.person;
      if (slot.stmt !== null && slot.stmt !== undefined) {
        const lines = game.bySpeaker[slot.person];
        game.focusLine = Math.max(0, lines.indexOf(slot.stmt));
      }
      syncAll();
      Sound.tap();
    }
    return null;
  }
  const step = game.applyWrites([game.writeForSlot(slot)], kind);
  if (!step) {
    syncAll();
    return null;
  }
  afterStep(soundFor(step.writes[0]));
  return step;
}

// Press: preview the write so the card changes under the finger, and remember what was there.
function pointerDown(ev) {
  if (!game || game.status !== 'playing') return;
  const i = view.hitTest(ev.clientX, ev.clientY);
  const slot = view.slotAt(i);
  if (!slot) return;                      // padding: not part of the board, writes nothing
  ev.preventDefault();
  el.canvas.focus?.({ preventScroll: true });
  game.focus = slot.person;
  if (slot.kind === 'note') {
    const lines = game.bySpeaker[slot.person];
    game.focusLine = Math.max(0, lines.indexOf(slot.stmt));
  }
  if (slot.kind === 'card') {
    press = null;
    syncAll();
    Sound.tap();
    return;
  }
  const write = game.writeForSlot(slot);
  press = write ? { slot, write: { ...write } } : null;
  if (write) game.previewWrite(write);
  syncAll();
}

function pointerUp(ev) {
  if (!press || !game) {
    press = null;
    return;
  }
  const p = press;
  press = null;
  const i = view.hitTest(ev.clientX, ev.clientY);
  const up = view.slotAt(i);
  game.revert([p.write]);
  // Released on a different chip than it went down on: that was a drag, not a decision.
  if (!up || up.kind !== p.slot.kind || up.person !== p.slot.person || up.value !== p.slot.value
    || up.stmt !== p.slot.stmt) {
    syncAll();
    return null;
  }
  return commitSlot(p.slot, p.slot.kind === 'note' ? 'note' : 'tap');
}

function pointerCancel() {
  if (!press || !game) {
    press = null;
    return;
  }
  game.revert([press.write]);
  press = null;
  syncAll();
}

el.canvas.addEventListener('pointerdown', pointerDown);
el.canvas.addEventListener('pointerup', pointerUp);
el.canvas.addEventListener('pointercancel', pointerCancel);
el.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
// focus follows the pointer without a press, so the keyboard player sees where they will land
el.canvas.addEventListener('pointermove', (ev) => {
  if (!game || press || game.status !== 'playing') return;
  const i = view.hitTest(ev.clientX, ev.clientY);
  const slot = view.slotAt(i);
  if (!slot || slot.person === game.focus) return;
  game.focus = slot.person;
  draw();
});

// ---- actions ------------------------------------------------------------------------------

function useHint() {
  if (!game || game.status !== 'playing') return null;
  const before = { moves: game.moves, hints: game.hints, steps: game.steps.length };
  const info = game.hint();
  if (!info) return null;
  if (info.stalled || info.conflict) {
    // nothing was written, so nothing is charged — and the counters prove it
    showHint(info);
    syncAll();
    Sound.stall();
    return info;
  }
  if (game.steps.length === before.steps) return null;
  showHint(info);
  syncAll();
  if (game.status === 'won') onWin();
  else {
    flushResume();
    if (game.diag.stmts.size) Sound.conflict();
  }
  return info;
}

function undo() {
  if (!game) return null;
  const step = game.undo();
  if (!step) return null;
  pulse = null;
  Sound.undo();
  syncAll();
  flushResume();
  return step;
}

function restart() {
  if (!game) return null;
  game.restart();
  pulse = null;
  baseElapsed = 0;
  startClock();          // a restarted run is a different run: the clock starts over with it
  el.winVeil.hidden = true;
  el.pauseVeil.hidden = true;
  $('#btn-pause').textContent = '暂停';
  $('#btn-pause').setAttribute('aria-pressed', 'false');
  el.hintRule.textContent = '提示理由';
  el.hintLine.innerHTML = '按 <b>提示</b> 会说出这一手是哪条规则、钉住哪一个人。推不出东西时它不收钱，也只说推不出。';
  syncAll();
  flushResume();
  Sound.clear();
  return game.state();
}

function setPaused(on) {
  if (!game) return null;
  const status = game.setPaused(on);
  $('#btn-pause').textContent = status === 'paused' ? '继续' : '暂停';
  $('#btn-pause').setAttribute('aria-pressed', String(status === 'paused'));
  if (status === 'paused') {
    stopClock();
    flushResume();
    el.pauseVeil.hidden = false;
    Sound.pause();
  } else {
    el.pauseVeil.hidden = true;
    if (status === 'playing' && !running()) startClock();
  }
  syncAll();
  return status;
}

const togglePause = () => setPaused(!(game && game.status === 'paused'));

function begin({ tier = 'trainee', seed = null, resume = null } = {}) {
  const origin = seed || `s${Math.floor(Math.random() * 1e9)}`;
  const bundle = makePuzzle(origin, tier);
  if (!bundle) return null;
  game = new Game(bundle);
  pulse = null;
  press = null;
  el.winVeil.hidden = true;
  el.pauseVeil.hidden = true;
  baseElapsed = 0;
  startedAt = 0;
  if (resume) {
    game.moves = resume.moves || 0;
    game.hints = resume.hints || 0;
    baseElapsed = resume.elapsedMs || 0;
    game.load(resume.known);
  }
  show('game');
  startClock();
  el.hintRule.textContent = '提示理由';
  el.hintLine.innerHTML = '按 <b>提示</b> 会说出这一手是哪条规则、钉住哪一个人。推不出东西时它不收钱，也只说推不出。';
  syncAll();
  flushResume();
  renderResumeCard();
  return game;
}

function show(which) {
  el.viewMenu.hidden = which !== 'menu';
  el.viewGame.hidden = which !== 'game';
  if (which === 'menu') {
    flushResume();
    stopClock();
    renderMenu();
  }
  draw();
  return which;
}

const TIER_NOTE = {
  trainee: '三人口供，两句一组就能钉死',
  apprentice: '四人口供，开始要数人头',
  regular: '五人口供，自指那句会自己消掉',
  expert: '六人口供，复合证词要拆真值表',
  master: '七人口供，剩的那几种指派要联立着看',
};

function renderTiers() {
  el.tiers.innerHTML = '';
  for (const t of TIERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tier';
    b.dataset.tier = t.id;
    b.innerHTML =
      `<span class="tier-name">${t.label}</span>` +
      `<span class="tier-note">${TIER_NOTE[t.id] || ''}</span>` +
      `<span class="tier-size mono">${t.n} 人 · 实测 ${t.band[0]}–${t.band[1]}</span>`;
    b.addEventListener('click', () => begin({ tier: t.id }));
    el.tiers.appendChild(b);
  }
}

function renderRecords() {
  el.records.innerHTML = '';
  for (const t of TIERS) {
    const li = document.createElement('li');
    const best = Store.best(t.id);
    li.dataset.tier = t.id;
    li.innerHTML =
      `<b>${t.label}</b>` +
      (best
        ? `<span class="mono">${fmtMs(best.ms)}</span> · 提示 ${best.hints} · ${best.moves} 步<br><span>${best.n} 人</span>`
        : '<span>还没有纪录</span>');
    el.records.appendChild(li);
  }
}

// The seven names a hint is allowed to say. The menu prints them so a player can tell an
// honest hint from a gift before they ever press the button.
function renderRules() {
  el.rules.innerHTML = '';
  for (const [name, gloss] of Object.entries(RuleGloss)) {
    const li = document.createElement('li');
    li.dataset.rule = name;
    li.innerHTML = `<b>${name}</b> —— ${gloss}`;
    el.rules.appendChild(li);
  }
}

function renderDaily() {
  const { key } = dateSeed();
  const t = TIERS[Math.abs(hashShort(key)) % TIERS.length];
  el.dailyMeta.textContent = `${key} · ${t.label} · ${t.n} 人`;
  el.dailyMeta.dataset.seed = `daily|${key}`;
  el.dailyMeta.dataset.tier = t.id;
}

function hashShort(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function renderResumeCard() {
  const r = Store.resume();
  // Do not offer "继续" for the room already on the table.
  const live = game && game.status !== 'won' && running();
  if (!r || (live && r.originSeed === game.puzzle.originSeed && r.tier === game.puzzle.tier)) {
    el.resumeCard.hidden = true;
    return;
  }
  el.resumeCard.hidden = false;
  el.resumeName.textContent = `继续 ${tierById(r.tier).label} 的一局（${r.n} 人）`;
  el.resumeMeta.textContent = `${fmtMs(r.elapsedMs || 0)} · ${r.moves || 0} 步 · 提示 ${r.hints || 0} 次`;
}

function renderMenu() {
  renderTiers();
  renderRecords();
  renderRules();
  renderDaily();
  renderResumeCard();
}

function applySettings() {
  Sound.setEnabled(Store.setting('sound'));
  const reduce = !!Store.setting('reduceMotion') || systemPrefersReducedMotion();
  setReduceMotion(!!Store.setting('reduceMotion'));
  document.body.classList.toggle('reduce-motion', reduce);
  $('#btn-sound').setAttribute('aria-pressed', String(!!Store.setting('sound')));
  $('#btn-sound').textContent = Store.setting('sound') ? '音效 开' : '音效 关';
  $('#btn-motion').setAttribute('aria-pressed', String(!!Store.setting('reduceMotion')));
  $('#btn-motion').textContent = reduce ? '动效 省' : '动效 全';
}

// ---- keyboard: the same writes the chips do, through the same function --------------------

const KEYS = {
  Tab: (ev) => { game.focusSlot(ev.shiftKey ? -1 : 1); syncAll(); return true; },
  ArrowUp: () => (game.focusCard(-1), syncAll(), true),
  ArrowDown: () => (game.focusCard(1), syncAll(), true),
  ArrowLeft: () => (game.focusSlot(-1), syncAll(), true),
  ArrowRight: () => (game.focusSlot(1), syncAll(), true),
  Enter: () => (commitSlot({ person: game.focus, value: nextOf(game.known[game.focus]) }, 'tap'), true),
  ' ': () => (commitSlot({ person: game.focus, value: nextOf(game.known[game.focus]) }, 'tap'), true),
  1: () => commitSlot({ person: game.focus, value: KNIGHT }, 'tap'),
  2: () => commitSlot({ person: game.focus, value: KNAVE }, 'tap'),
  3: () => commitSlot({ person: game.focus, value: UNKNOWN }, 'tap'),
  0: () => commitSlot({ person: game.focus, value: UNKNOWN }, 'tap'),
  Backspace: () => commitSlot({ person: game.focus, value: UNKNOWN }, 'tap'),
  '.': () => commitSlot({ kind: 'note', person: game.focus, stmt: game.focusedStmt() }, 'note'),
  h: () => (useHint(), true),
  u: () => (undo(), true),
  r: () => (restart(), true),
  p: () => (togglePause(), true),
  Escape: () => (setPaused(false), show('menu'), true),
};

function nextOf(cur) {
  return cur === UNKNOWN ? KNIGHT : cur === KNIGHT ? KNAVE : UNKNOWN;
}

window.addEventListener('keydown', (ev) => {
  if (!game) return;
  const t = ev.target;
  const tag = t && t.tagName ? t.tagName.toUpperCase() : '';
  if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
  // a focused button already owns Space/Enter; the canvas owns every other key
  if (tag === 'BUTTON' && (ev.key === ' ' || ev.key === 'Enter')) return;
  // Tab is only stolen while the canvas itself holds focus, so the buttons stay reachable
  if (ev.key === 'Tab' && document.activeElement !== el.canvas) return;
  // A settled room takes no more marks — only 重开 and 回选档 answer.
  if (game.status === 'won' && ev.key !== 'r' && ev.key !== 'R' && ev.key !== 'Escape') return;
  const h = KEYS[ev.key];
  if (!h) return;
  if (h(ev) !== false) {
    ev.preventDefault();
    if (ev.key === 'Tab') ev.stopPropagation();
  }
});

// ---- buttons ------------------------------------------------------------------------------

$('#btn-hint').addEventListener('click', useHint);
$('#btn-undo').addEventListener('click', undo);
$('#btn-restart').addEventListener('click', restart);
$('#btn-pause').addEventListener('click', togglePause);
$('#btn-new').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : 'trainee' }));
$('#btn-menu').addEventListener('click', () => show('menu'));
$('#btn-menu-2').addEventListener('click', () => show('menu'));
$('#btn-menu-3').addEventListener('click', () => {
  setPaused(false);
  show('menu');
});
$('#btn-unpause').addEventListener('click', () => setPaused(false));
$('#btn-again').addEventListener('click', () => begin({ tier: game ? game.puzzle.tier : 'trainee' }));
$('#btn-resume').addEventListener('click', () => {
  const r = Store.resume();
  if (!r) return;
  begin({ tier: r.tier, seed: r.originSeed, resume: r });
});
$('#btn-daily').addEventListener('click', () => {
  const { key } = dateSeed();
  const t = TIERS[Math.abs(hashShort(key)) % TIERS.length];
  begin({ tier: t.id, seed: `daily|${key}` });
});
$('#btn-sound').addEventListener('click', () => {
  Store.setSetting('sound', !Store.setting('sound'));
  applySettings();
  Sound.knight();
});
$('#btn-motion').addEventListener('click', () => {
  Store.setSetting('reduceMotion', !Store.setting('reduceMotion'));
  applySettings();
});
$('#btn-reset').addEventListener('click', () => {
  Store.reset();
  applySettings();
  game = null;
  press = null;
  show('menu');
});

window.addEventListener('resize', draw);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushResume();
});
window.addEventListener('pagehide', flushResume);

applyThemeVars();
applySettings();
renderMenu();

window.syllogism = {
  version: VERSION,
  view,
  get game() {
    return game;
  },
  get puzzle() {
    return game ? game.puzzle : null;
  },
  get known() {
    return game ? Array.from(game.known) : null;
  },
  // the two numbers the harness needs to agree with draw(), at the top level
  hitTest: (x, y) => view.hitTest(x, y),
  slotAt: (i) => view.slotAt(i),
  slotCount: () => view.slots.length,
  rectOf: (i) => view.rectOf(i),
  slotCenter(i) {
    const r = view.rectOf(i);
    if (!r) return null;
    const box = el.canvas.getBoundingClientRect();
    return { x: box.left + r.x + r.w / 2, y: box.top + r.y + r.h / 2 };
  },
  // find the chip the harness wants to press without knowing the layout
  slotFor(person, value) {
    return view.slots.findIndex((s) => s.kind === 'chip' && s.person === person && s.value === value);
  },
  noteSlot(person, stmt) {
    return view.slots.findIndex((s) => s.kind === 'note' && s.stmt === stmt);
  },
  draw,
  show,
  begin,
  selectTier: (tier) => begin({ tier }),
  useHint,
  undo,
  restart,
  pause: () => setPaused(true),
  unpause: () => setPaused(false),
  togglePause,
  pressSlot(i) {
    const slot = view.slotAt(i);
    return slot ? commitSlot(slot, slot.kind === 'note' ? 'note' : 'tap') : null;
  },
  assign(person, value) {
    return commitSlot({ person, value }, 'tap');
  },
  toggleNote(stmt) {
    return commitSlot({ kind: 'note', person: game.board.statements[stmt].from, stmt }, 'note');
  },
  key(k) {
    const h = KEYS[k];
    if (!h) return false;
    h({ shiftKey: false });
    syncAll();
    return true;
  },
  solveWithLogic() {
    if (!game) return null;
    const r = game.solveWithLogic();
    syncAll();
    if (game.status === 'won') onWin();
    return r;
  },
  elapsed: clock,
  state: () => (game ? { ...game.state(), elapsedMs: clock(), n: game.n } : null),
  // Exposed so the browser suite checks the *same* module graph the game runs, rather than a
  // second copy that could pass while the shipped app is broken.
  engine: {
    ...Engine,
    countModels,
    matchesTruth,
    UNIQUE,
    makePuzzle,
    TIERS,
    tierById,
    dateSeed,
    Game,
    Store,
    Sound,
    RuleGloss,
    AS_LABEL,
    KNIGHT,
    KNAVE,
    UNKNOWN,
    Board,
    Space,
  },
};

// ---- 全屏开关（#btn-fullscreen）----
// 绑的是本页 HUD 上真实存在的那个按钮。全屏最常见的假实现就是引用一个并不存在的
// id：点下去什么也不会发生，量具却算它"已实现"。所以这里找不到按钮就直接不装。
(function bindFullscreen() {
  const btn = document.getElementById('btn-fullscreen');
  if (!btn) return;
  const root = document.documentElement;
  // 只做特性检测，不嗅探 UA：iOS Safari 是 webkitRequestFullscreen，老 Edge 是 ms 前缀，
  // 而 UA 字符串随时会改。"有没有这个能力"是查出来的，不是猜出来的。
  const req = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  const current = () => document.fullscreenElement || document.webkitFullscreenElement
    || document.msFullscreenElement || null;

  // 不支持也要给个说法：只把按钮灰掉而不解释，玩家会以为这功能没做完。
  const unsupported = () => {
    btn.disabled = true;
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」独立打开）';
  };
  if (!req) unsupported();

  // fullscreen 返回 Promise，被拒时必须吃掉：iOS Safari 对多数非 video 元素直接拒绝，
  // 让这个 rejection 冒泡出去会变成一条未捕获错误，整局游戏跟着挂。
  const settle = (p) => { if (p && p.catch) p.catch(unsupported); };

  // 进出都能走：已经全屏时这次调用是退出，不是"再进一次"。
  function toggle() {
    try {
      if (current()) {
        if (exit) settle(exit.call(document));
      } else if (req) {
        settle(req.call(root));
      } else {
        unsupported();
      }
    } catch (e) {
      unsupported();
    }
  }

  // Esc 和系统手势退出都不经过我们的代码，按钮状态只能靠 fullscreenchange 回写，
  // 否则用户已经退出、HUD 还停在"退出全屏"，下一次点击反而会重新进全屏。
  function sync() {
    const on = !!current();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    btn.title = "全屏" + '（F）';
    const body = document.body;
    if (body && body.classList) body.classList.toggle('fullscreen', on);
  }

  btn.addEventListener('click', toggle);
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'f' && ev.key !== 'F') return;
    const t = ev.target;
    // 盘号 / 种子这类输入框里打字不能触发全屏，否则玩家输 seed 输到一半屏幕没了。
    if (t && /input|textarea|select/i.test(t.tagName || '')) return;
    if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    ev.preventDefault();
    toggle();
  });
  window.addEventListener('fullscreenchange', sync);
  window.addEventListener('webkitfullscreenchange', sync);
  window.addEventListener('MSFullscreenChange', sync);
  sync();
})();
