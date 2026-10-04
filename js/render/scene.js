// Canvas renderer for 证词. It reads the Game's state and paints the room; it never decides
// anything — no person is "settled" here, no statement is judged false here — so the picture
// cannot disagree with the engine that the solver, the hints and the win check all use.
//
// Layout lives here too (card sizes, wrap points, origin, DPR) because `hitTest()` has to
// answer with the *same* numbers `draw()` used. Those two drifting apart is how a board
// renders correctly but takes taps one card off. So the plan is built once per resize, every
// interactive rect is recorded while the plan is built, and draw() only reads that plan:
// there is no second geometry anywhere in this file to keep in sync.
//
// The board is a stack of statement cards, one per person, sized by what he actually said
// (one or two sentences, each of which may wrap). Three controls sit in the card head and they
// are deliberately *not* three identical circles: 骑士 is a filled notched seal, 无赖 is a
// hollow cold frame of a different width, and 未定 is a smaller dashed square holding a `?`.
// Shape carries the meaning and hue only reinforces it, so the row still reads with colour
// removed — and a column of seven look-alike chips is exactly the failure the review calls.


/* ---------- 帧率无关（dt）---------- */
/* 本仓**没有逐帧运动**，所以「帧率无关」这一项在本仓是空命题而不是缺陷：页面代码里 requestAnimationFrame 出现 0 次：唯一一处在 tools/scenarios.js:183（测试台的 await 一帧），而 index.html 只加载 js/main.js 与 js/sw-register.js，页面根本加载不到它；js/render/scene.js 的重绘由 pointerdown / click / keydown 触发
   没有自续期的 requestAnimationFrame 循环，屏上就没有「每帧推进」的量，帧率也就无从影响它。
   写这段备案是为了让账上分得开"查过、确实不需要"与"没人查过"——不是为了让判据变绿。

   规矩：**哪天在本仓加了逐帧动画循环，必须先删掉这段备案**，并让循环体消费 rAF 自带的
   时间戳（或自己取 performance.now()），把动画进度写成绝对截止；只按帧累加位置的一律不算。 */
import { Palette, Board, Radius, Type } from '../theme.js';
import { KNIGHT, KNAVE, UNKNOWN } from '../engine/logic.js';

// The compression ladder. Every rung stays inside the ranges js/theme.js declares and never
// drops a glyph below Board.minFont — under that the sheet stops being a board and becomes a
// texture. The first rung that fits the available box wins; if none does the last is used, so
// the column is at least as short as it can honestly get rather than silently clipped.
export const PRESETS = [
  { nameFont: 24, lineFont: 16, chipH: 30, gap: 10, cardPad: 12, quoteFont: 15, footFont: 14, lineHeight: 1.42, foot: true },
  { nameFont: 22, lineFont: 15, chipH: 29, gap: 9, cardPad: 10, quoteFont: 15, footFont: 14, lineHeight: 1.4, foot: true },
  { nameFont: 20, lineFont: 14, chipH: 27, gap: 8, cardPad: 8, quoteFont: 15, footFont: 14, lineHeight: 1.36, foot: true },
  { nameFont: 18, lineFont: 14, chipH: 26, gap: 7, cardPad: 7, quoteFont: 15, footFont: 14, lineHeight: 1.33, foot: false },
  { nameFont: Board.nameFontMin, lineFont: Board.minFont, chipH: Board.chipHMin, gap: Board.gapMin, cardPad: Board.cardPadMin, quoteFont: Board.minFont, footFont: Board.minFont, lineHeight: 1.3, foot: false },
];

const SANS = Type.sans;
const ASK = { [KNIGHT]: '骑士', [KNAVE]: '无赖' };
// Punctuation that must never open a line: a comma at the left edge reads as a broken column,
// and whatever the wrap decides here is what draw() will repeat exactly.
const NO_LINE_START = '，。、；：）」』！？·';
const MIN_WIDTH = 288;   // below this the head row cannot seat the name beside three chips
// Gaps are not decoration: they bound how far a hit pad may grow outwards. Every pair of rects
// here must stay disjoint after the growth below, or a tap would mean two things at once.
const CHIP_GAP = 8;      // between the three chips
const ROW_GAP = 5;       // between two sentences on one card
const HEAD_GAP = 4;      // head band to first sentence
const GUTTER = 22;       // the pencil square in front of every sentence
const GUTTER_SLACK = 12; // gutter to text (must exceed 2 × the horizontal pad)

// ---- canvas helpers -----------------------------------------------------------------------

function font(px, weight = 400) {
  return `${weight} ${px}px ${SANS}`;
}

function path(ctx, x, y, w, h, r) {
  const k = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

// 骑士: a seal with a notch bitten out of its right edge — the same silhouette the CSS legend
// swatch copies, so the sheet and the board cannot disagree about what a knight looks like.
function sealPath(ctx, x, y, w, h, r) {
  const k = Math.max(0, Math.min(r, h / 2));
  const bite = w * 0.26;
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.lineTo(x + w - bite, y);
  ctx.lineTo(x + w, y + h / 2);
  ctx.lineTo(x + w - bite, y + h);
  ctx.lineTo(x + k, y + h);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

// 无赖: a hollow frame whose left edge is cut the other way. Different width, different
// silhouette, never filled while unselected — the shape itself says "lie", not the blue.
function hollowPath(ctx, x, y, w, h, r) {
  const k = Math.max(0, Math.min(r, h / 2));
  const bite = w * 0.22;
  ctx.beginPath();
  ctx.moveTo(x + bite, y);
  ctx.lineTo(x + w - k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x + k, y + h, k);
  ctx.lineTo(x + bite, y + h);
  ctx.lineTo(x, y + h / 2);
  ctx.closePath();
}

function dashRect(ctx, x, y, w, h, on) {
  ctx.save();
  ctx.setLineDash(on ? [3, 2] : [2, 3]);
  path(ctx, x, y, w, h, Radius.tick);
  ctx.stroke();
  ctx.restore();
}

function line(ctx, x1, y1, x2, y2) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function text(ctx, s, x, y, { px, weight = 400, color = Palette.ink, align = 'left' } = {}) {
  ctx.font = font(px);
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
  return ctx.measureText(s).width;
}

// ---- layout ------------------------------------------------------------------------------

// Character-level greedy wrap: this is Chinese, there are no word boundaries to break on, and
// the rows returned here are the only rows draw() will ever paint.
function wrapRows(ctx, raw, px, avail, weight = 500) {
  ctx.font = font(px, weight);
  const rows = [];
  let cur = '';
  let w = 0;
  for (const ch of raw) {
    const cw = ctx.measureText(ch).width;
    if (w + cw > avail && cur) {
      if (NO_LINE_START.includes(ch)) {
        // hang the mark on the line it belongs to instead of orphaning it
        cur += ch;
        rows.push({ text: cur, width: w + cw });
        cur = '';
        w = 0;
        continue;
      }
      rows.push({ text: cur, width: w });
      cur = ch;
      w = cw;
      continue;
    }
    cur += ch;
    w += cw;
  }
  if (cur || !rows.length) rows.push({ text: cur, width: w });
  return rows;
}

function chipWidths(ctx, p) {
  ctx.font = font(p.chipFont, 700);
  const kW = Math.ceil(Math.max(50, ctx.measureText(ASK[KNIGHT]).width + p.chipH * 1.05));
  // 无赖 is set narrower and shorter than 骑士 on purpose: three controls of the same box is
  // the "row of identical hotspots" failure, and the two states must not be tellable apart by
  // hue alone.
  const nW = Math.ceil(Math.max(46, ctx.measureText(ASK[KNAVE]).width + p.chipH * 0.8));
  return { kW, nW, uW: p.chipH };
}

// One card, laid out at `y`, recording its own hit slots. Returns its height so the column can
// decide whether this compression rung was enough.
function layoutCard(ctx, game, person, y, p, colX, colW, out) {
  const lines = game.linesOf(person);
  const inner = colW - p.cardPad * 2;
  const chips = chipWidths(ctx, p);
  const chipRowW = chips.kW + chips.nW + chips.uW + CHIP_GAP * 2;
  const headH = Math.max(p.chipH, Math.round(p.nameFont * 1.28)) + 2;

  const card = {
    person,
    x: colX,
    y,
    w: colW,
    h: 0,
    name: { x: colX + p.cardPad, y: y + p.cardPad, w: Math.max(28, inner - chipRowW - CHIP_GAP), h: headH },
    chips: [],
    rows: [],
    foot: null,
    silent: !lines.length,
  };

  // head row, right-aligned: 骑士 (filled seal) · 无赖 (hollow) · 未定 (small dashed `?`)
  let cx = colX + colW - p.cardPad;
  const chipY = y + p.cardPad + Math.round((headH - p.chipH) / 2);
  const place = (value, w, drawn) => {
    cx -= w;
    card.chips.push({ value, x: cx, y: chipY, w, h: p.chipH, drawn });
    cx -= CHIP_GAP;
  };
  place(UNKNOWN, chips.uW, Board.unknownH);
  place(KNAVE, chips.nW, Math.max(Board.minFont + 8, p.chipH - 4));
  place(KNIGHT, chips.kW, p.chipH);

  let cy = y + p.cardPad + headH + HEAD_GAP;

  const pushRow = (stmt, raw, px) => {
    const avail = Math.max(40, inner - GUTTER - GUTTER_SLACK - p.quoteW * 2);
    const rows = wrapRows(ctx, raw, px, avail);
    const h = rows.length * p.rowH;
    const gs = Math.min(GUTTER, p.rowH);
    card.rows.push({
      stmt,
      x: colX + p.cardPad + GUTTER + GUTTER_SLACK,
      y: cy,
      rows,
      h,
      gutter: stmt === null ? null : { x: colX + p.cardPad, y: cy + Math.round((p.rowH - gs) / 2), w: GUTTER, h: gs },
    });
    cy += h + ROW_GAP;
  };

  if (!lines.length) pushRow(null, '这一夜他没有开口', p.silentFont);
  for (const stmt of lines) pushRow(stmt, game.lineText(stmt), p.lineFont);
  cy -= ROW_GAP;

  if (p.foot) {
    const tags = [];
    for (const stmt of lines) {
      const st = game.board.statements[stmt];
      if (st && st.rule && !tags.includes(st.rule)) tags.push(st.rule);
    }
    card.foot = { x: colX + p.cardPad, y: cy, w: inner, h: p.footFont + 6, tags: tags.join(' · ') };
    cy += card.foot.h;
  }

  card.h = cy - y + p.cardPad;
  out.cards.push(card);
  return card.h;
}

// The plan: everything draw() paints and every rect hitTest() answers with, all in CSS pixels.
export function buildPlan(ctx, game, width, rung) {
  const p = {
    ...rung,
    chipFont: Math.max(Board.minFont, Math.min(Board.glyphMin + 1, Math.round(rung.chipH * 0.52))),
    unknownFont: Math.max(Board.minFont, Math.round(Board.unknownH * 0.72)),
    silentFont: Math.max(Board.minFont, rung.lineFont - 1),
  };
  ctx.font = font(p.quoteFont);
  p.quoteW = Math.ceil(ctx.measureText('「').width);
  p.rowH = Math.round(p.lineFont * p.lineHeight);

  const pad = Board.pad;
  const colW = Math.max(120, width - pad * 2);
  const out = {
    width,
    pad,
    colX: pad,
    colW,
    cards: [],
    slots: [],
    fonts: {
      name: p.nameFont,
      line: p.lineFont,
      chip: p.chipFont,
      quote: p.quoteFont,
      foot: p.footFont,
      silent: p.silentFont,
      unknown: p.unknownFont,
    },
    metrics: { cardPad: p.cardPad, gap: p.gap, chipH: p.chipH, unknownH: Board.unknownH, rowH: p.rowH, foot: p.foot },
    height: 0,
  };
  out.minFont = Math.min(...Object.values(out.fonts));

  // Hit pads may grow outwards, but never far enough for two of them to touch: the harness
  // asserts the rects are pairwise disjoint, so a tap cannot be ambiguous. Half the smallest gap
  // minus one is the largest pad that keeps every pair strictly apart.
  const gx = Math.max(0, Math.min(Board.hitPad, (Math.min(CHIP_GAP, GUTTER_SLACK) >> 1) - 1));
  const gy = Math.max(0, Math.min(Board.hitPad, (Math.min(ROW_GAP, HEAD_GAP) >> 1) - 1));
  const slot = (s, grow = true) => {
    const r = s.rect;
    out.slots.push({
      ...s,
      drawn: { x: r.x, y: r.y, w: r.w, h: r.h },
      rect: grow ? { x: r.x - gx, y: r.y - gy, w: r.w + gx * 2, h: r.h + gy * 2 } : { ...r },
    });
    return out.slots.length - 1;
  };

  let y = pad;
  for (let person = 0; person < game.n; person++) {
    const h = layoutCard(ctx, game, person, y, p, pad, colW, out);
    const card = out.cards[out.cards.length - 1];
    card.slots = [slot({ kind: 'card', person, rect: card.name })];
    for (const c of card.chips) {
      c.slot = slot({ kind: 'chip', person, value: c.value, rect: { x: c.x, y: c.y, w: c.w, h: c.drawn } });
      card.slots.push(c.slot);
    }
    for (const r of card.rows) {
      if (r.gutter) r.gutterSlot = slot({ kind: 'note', person, stmt: r.stmt, rect: r.gutter });
      r.textSlot = slot({ kind: 'card', person, stmt: r.stmt, rect: { x: r.x, y: r.y, w: card.x + card.w - p.cardPad - r.x, h: r.h } });
      card.slots.push(r.gutterSlot === undefined ? -1 : r.gutterSlot, r.textSlot);
    }
    y += h + p.gap;
  }
  out.height = Math.round(y - p.gap + pad);
  return out;
}

// ---- the view ----------------------------------------------------------------------------

export class SceneView {
  constructor(canvas) {
    this.canvas = canvas;
    // willReadFrequently is not a perf hint here, it is the one thing that makes the picture
    // reproducible. Chrome rasterises a canvas on the GPU, but after enough getImageData reads
    // it flips that canvas to software raster and every *later* repaint comes out a shade
    // different along each anti-aliased edge — glyphs, card borders, all of it. A pixel check
    // that straddles that flip (and the harness reads the board on almost every check, so it
    // always does) reports "pixels moved" on cards whose drawing never changed at all: the
    // focus-box check named all four cards as changed for exactly this reason, on a board where
    // the ring had only ever moved from card 0 to card 1. Declaring the read pattern up front
    // keeps the canvas on one raster backend for its whole life, so two frames of one state are
    // byte-identical and a frame of another differs only where it was actually drawn.
    // A ≤660×~700 board repaints on input, not per frame; software raster costs nothing here.
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.geo = { w: 0, h: 0, dpr: 1, pad: Board.pad };
    this.plan = null;
    this.game = null;
  }

  // The backing buffer is sized in device pixels while every draw call stays in CSS pixels:
  // one ctx.setTransform at the top is what keeps Chinese glyphs crisp on a Retina display
  // without doubling every constant in this file.
  resize(game, availW, availH) {
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const width = Math.max(MIN_WIDTH, Math.min(Board.maxW, Math.floor(availW)));
    let plan = null;
    for (const rung of PRESETS) {
      plan = buildPlan(this.ctx, game, width, rung);
      if (plan.height <= availH) break;
    }
    this.plan = plan;
    this.game = game;
    this.canvas.style.width = `${plan.width}px`;
    this.canvas.style.height = `${plan.height}px`;
    this.canvas.width = Math.round(plan.width * dpr);
    this.canvas.height = Math.round(plan.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.geo = { w: plan.width, h: plan.height, dpr, pad: plan.pad };
    return this.geo;
  }

  get slots() {
    return this.plan ? this.plan.slots : [];
  }

  slotAt(i) {
    return this.plan && i >= 0 && i < this.plan.slots.length ? this.plan.slots[i] : null;
  }

  // The CSS-pixel rect draw() used for slot i. The harness centres its gestures on this, which
  // is the whole point of keeping layout and hit testing in one module.
  rectOf(i) {
    const s = this.slotAt(i);
    return s ? s.rect : null;
  }

  // Pointer position → slot index, or -1 for the padding and for anything off the canvas.
  // A hit in the margin must not touch the ledger, so it answers "nothing" rather than
  // "nearest card".
  hitTest(clientX, clientY) {
    if (!this.plan) return -1;
    const box = this.canvas.getBoundingClientRect();
    const px = clientX - box.left;
    const py = clientY - box.top;
    if (px < 0 || py < 0 || px > box.width || py > box.height) return -1;
    const slots = this.plan.slots;
    for (let i = 0; i < slots.length; i++) {
      const r = slots[i].rect;
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return i;
    }
    return -1;
  }

  // Who owns the card under a point — for focus-follows-pointer. Reads the same plan, so it
  // cannot disagree with hitTest.
  personAt(clientX, clientY) {
    const i = this.hitTest(clientX, clientY);
    return i < 0 ? -1 : this.plan.slots[i].person;
  }

  draw(game, { pulse = null } = {}) {
    const plan = this.plan;
    if (!plan) return;
    this.game = game;
    const { ctx } = this;
    const { width, height, cards } = plan;
    ctx.clearRect(0, 0, width, height);
    this.room(ctx, plan);
    const paused = game.status === 'paused';
    for (const card of cards) this.card(ctx, plan, game, card, paused);
    if (game.status === 'won') this.sealRoom(ctx, plan);
    if (game.status === 'playing') this.focusRing(ctx, plan, game);
    if (pulse && pulse.person !== undefined && pulse.person >= 0) {
      const card = plan.cards[pulse.person];
      if (card) this.around(ctx, card, Palette.hint, 3);
    }
  }

  // The room: a near-black violet interior with one candle over the table. Nothing here
  // carries information, so nothing here may be the only place a state is expressed.
  room(ctx, plan) {
    const { width, height } = plan;
    const bg = ctx.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, Palette.bgTop);
    bg.addColorStop(0.55, Palette.bgBottom);
    bg.addColorStop(1, Palette.surface);
    ctx.fillStyle = bg;
    path(ctx, 0, 0, width, height, Radius.card);
    ctx.fill();
    const glow = ctx.createRadialGradient(width / 2, -height * 0.1, 24, width / 2, -height * 0.1, height * 0.92);
    glow.addColorStop(0, Palette.sealGlow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    const vig = ctx.createLinearGradient(0, height * 0.62, 0, height);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, Palette.vignette);
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, width, height);
  }

  around(ctx, card, color, lw) {
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    path(ctx, card.x - 1, card.y - 1, card.w + 2, card.h + 2, Radius.card + 1);
    ctx.stroke();
  }

  // Focus is drawn here, on the canvas, because `#board { outline: none }` and a DOM outline
  // around a canvas would say nothing about which *card* has the move.
  focusRing(ctx, plan, game) {
    const card = plan.cards[game.focus];
    if (!card) return;
    this.around(ctx, card, Palette.focus, 2);
    const row = card.rows[Math.min(game.focusLine, card.rows.length - 1)];
    if (!row) return;
    ctx.strokeStyle = Palette.focus;
    ctx.lineWidth = 1.5;
    ctx.save();
    ctx.setLineDash([4, 3]);
    path(ctx, row.x - 3, row.y + 1, card.x + card.w - plan.metrics.cardPad - row.x + 4, row.h - 2, Radius.tick);
    ctx.stroke();
    ctx.restore();
  }

  // Settled: the room has an answer. The cards keep the shapes that said so all along.
  sealRoom(ctx, plan) {
    ctx.strokeStyle = Palette.success;
    ctx.lineWidth = 2;
    path(ctx, 1, 1, plan.width - 2, plan.height - 2, Radius.card);
    ctx.stroke();
  }

  card(ctx, plan, game, card, paused) {
    const f = plan.fonts;
    const state = game.known[card.person];
    const bad = game.diag.people.has(card.person);
    const x = card.x, y = card.y, w = card.w, h = card.h;

    path(ctx, x, y, w, h, Radius.card);
    ctx.fillStyle = state === KNIGHT ? Palette.cardLit : Palette.card;
    ctx.fill();
    if (state !== UNKNOWN) {
      path(ctx, x, y, w, h, Radius.card);
      ctx.fillStyle = state === KNIGHT ? Palette.sealGlow : Palette.ashGlow;
      ctx.fill();
    }
    ctx.strokeStyle = bad ? Palette.error : state === UNKNOWN ? Palette.line : Palette.lineHeavy;
    ctx.lineWidth = bad ? 2 : 1;
    path(ctx, x + 0.5, y + 0.5, w - 1, h - 1, Radius.card);
    ctx.stroke();

    // the left edge states the identity from across the room, without colour being the carrier
    ctx.save();
    path(ctx, x, y, w, h, Radius.card);
    ctx.clip();
    ctx.fillStyle = state === KNIGHT ? Palette.seal : state === KNAVE ? Palette.ashDeep : Palette.unknown;
    ctx.fillRect(x, y, bad ? 5 : 3, h);
    ctx.restore();

    text(ctx, game.name(card.person), card.name.x + (bad ? 5 : 3), card.name.y + card.name.h / 2 - 1, {
      px: f.name,
      weight: 700,
      color: bad ? Palette.error : state === KNIGHT ? Palette.sealEdge : Palette.ink,
    });
    for (const c of card.chips) this.chip(ctx, f, c, state);
    for (const r of card.rows) this.row(ctx, plan, game, r, paused);

    if (card.foot) {
      let struck = 0;
      for (const rr of card.rows) if (rr.stmt !== null && game.notes[rr.stmt]) struck++;
      text(ctx, card.foot.tags || '（此人口供未牵出规则名）', card.foot.x, card.foot.y + card.foot.h / 2, {
        px: f.foot,
        color: Palette.inkFaint,
      });
      if (struck) {
        text(ctx, `划掉 ${struck} 句`, card.foot.x + card.foot.w, card.foot.y + card.foot.h / 2, {
          px: f.foot,
          color: Palette.pencil,
          align: 'right',
        });
      }
    }
  }

  chip(ctx, f, c, state) {
    const on = state === c.value;
    // the hit box is the full chip band; the figure inside it is what actually differs
    const dh = c.drawn;
    const dy = c.y + Math.round((c.h - dh) / 2);
    if (c.value === UNKNOWN) {
      const box = { x: c.x + (c.w - c.drawn) / 2, y: dy, w: c.drawn, h: c.drawn };
      ctx.lineWidth = on ? 2 : 1;
      ctx.strokeStyle = on ? Palette.unknownEdge : Palette.lineHeavy;
      dashRect(ctx, box.x, box.y, box.w, box.h, !on);
      if (on) {
        ctx.fillStyle = Palette.accentSoft;
        path(ctx, box.x, box.y, box.w, box.h, Radius.tick);
        ctx.fill();
      }
      text(ctx, '?', box.x + box.w / 2, box.y + box.h / 2 + 1, {
        px: f.unknown,
        weight: 700,
        color: on ? Palette.ink : Palette.unknown,
        align: 'center',
      });
      return;
    }
    if (c.value === KNIGHT) {
      if (on) {
        // the one object in the room that casts light
        ctx.save();
        ctx.shadowColor = Palette.seal;
        ctx.shadowBlur = 12;
        sealPath(ctx, c.x, dy, c.w, dh, Radius.seal);
        ctx.fillStyle = Palette.seal;
        ctx.fill();
        ctx.restore();
      } else {
        sealPath(ctx, c.x, dy, c.w, dh, Radius.seal);
        ctx.fillStyle = Palette.sealGlow;
        ctx.fill();
      }
      sealPath(ctx, c.x, dy, c.w, dh, Radius.seal);
      ctx.lineWidth = on ? 2 : 1.25;
      ctx.strokeStyle = on ? Palette.sealEdge : Palette.sealDeep;
      ctx.stroke();
      text(ctx, ASK[KNIGHT], c.x + c.w / 2 - c.w * 0.07, dy + dh / 2 + 1, {
        px: f.chip,
        weight: 700,
        color: on ? Palette.sealDeep : Palette.inkFaint,
        align: 'center',
      });
      return;
    }
    if (on) {
      hollowPath(ctx, c.x, dy, c.w, dh, Radius.chip);
      ctx.fillStyle = Palette.ashDeep;
      ctx.fill();
    }
    hollowPath(ctx, c.x, dy, c.w, dh, Radius.chip);
    ctx.lineWidth = on ? 2.5 : 1.5;
    ctx.strokeStyle = on ? Palette.ashEdge : Palette.ash;
    ctx.globalAlpha = on ? 1 : 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;
    text(ctx, ASK[KNAVE], c.x + c.w / 2 + c.w * 0.06, dy + dh / 2 + 1, {
      px: f.chip,
      weight: on ? 700 : 400,
      color: on ? Palette.ashEdge : Palette.inkFaint,
      align: 'center',
    });
  }

  row(ctx, plan, game, r, paused) {
    const f = plan.fonts;
    const m = plan.metrics;
    const noted = r.stmt !== null && !!game.notes[r.stmt];
    const conflict = r.stmt !== null && game.diag.stmts.has(r.stmt);

    if (r.gutter) {
      const g = r.gutter;
      if (noted) {
        ctx.fillStyle = Palette.accentSoft;
        path(ctx, g.x, g.y, g.w, g.h, Radius.tick);
        ctx.fill();
      }
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = conflict ? Palette.error : noted ? Palette.inkDim : Palette.lineHeavy;
      path(ctx, g.x, g.y, g.w, g.h, Radius.tick);
      ctx.stroke();
      // the pencil square: a single strike means "I have read this one off"
      ctx.strokeStyle = conflict ? Palette.error : noted ? Palette.pencil : Palette.inkGhost;
      ctx.lineWidth = 2;
      line(ctx, g.x + 5, g.y + g.h / 2, g.x + g.w - 5, g.y + g.h / 2);
      if (noted) line(ctx, g.x + 5, g.y + 3, g.x + g.w - 5, g.y + g.h - 3);
    }

    if (paused) {
      // 暂停中：口供扣在桌上 — while the clock is off no sentence is legible on the canvas.
      for (let i = 0; i < r.rows.length; i++) {
        ctx.fillStyle = Palette.line;
        const bw = Math.max(40, r.rows[i].width * 0.8);
        path(ctx, r.x, r.y + i * m.rowH + m.rowH * 0.32, bw, Math.max(4, Math.round(m.rowH * 0.34)), Radius.tick);
        ctx.fill();
      }
      return;
    }

    for (let i = 0; i < r.rows.length; i++) {
      const yy = r.y + i * m.rowH + m.rowH / 2;
      const color = conflict ? Palette.error : noted ? Palette.inkGhost : Palette.inkDim;
      let x = r.x;
      if (i === 0) {
        x += text(ctx, '「', r.x, yy, { px: f.quote, color: Palette.inkFaint }) + 1;
      }
      const body = r.rows[i];
      const drawn = text(ctx, body.text, x, yy, { px: f.line, weight: 500, color });
      if (i === r.rows.length - 1) {
        text(ctx, '」', x + drawn + 1, yy, { px: f.quote, color: conflict ? Palette.error : Palette.inkFaint });
      }
      if (noted) {
        ctx.strokeStyle = conflict ? Palette.error : Palette.pencil;
        ctx.lineWidth = 1.5;
        line(ctx, r.x, yy, x + drawn + (i === r.rows.length - 1 ? f.quote * 0.7 : 0), yy);
      }
    }
  }
}

export { MIN_WIDTH };
