// Single source of truth for colour, spacing, type and motion in 证词.
//
// The stylesheet reads these as custom properties (applyThemeVars) and the canvas reads the
// same objects, so a token cannot land on one side only — that drift is how "one seal colour"
// becomes forty and how the board and the panel stop looking like one room.
//
// Night-interrogation palette: candle warm for what is true, cold ash for what is not, and a
// near-black violet room in between. Deliberately *not* the sibling game's blue-with-gold:
// same house rules, different building. Every identity state is separated by shape AND by
// hue, because a colour-blind player must still read the board from the glyph alone.
//
// No DOM font size in here is below 14 px. Chinese at 12 px is decoration, not text.

export const Palette = {
  bgTop: '#0A0611',
  bgBottom: '#1A1027',
  surface: '#130D1E',
  surfaceLift: '#1D1530',
  card: '#191227',
  cardLit: '#241A36',
  line: '#2C2042',
  lineHeavy: '#4A3766',

  ink: '#F5EFE8',
  inkDim: 'rgba(245,239,232,0.68)',
  inkFaint: 'rgba(245,239,232,0.38)',
  inkGhost: 'rgba(245,239,232,0.16)',

  // 骑士: the candle. Filled, warm, the only thing in the room that casts light.
  seal: '#F0B13C',
  sealEdge: '#FFD98F',
  sealDeep: '#8B5A11',
  sealGlow: 'rgba(240,177,60,0.20)',
  sealCore: 'rgba(240,177,60,0.42)',

  // 无赖: cold ash. Outlined, never filled — the shape itself carries the meaning.
  ash: '#87A8CB',
  ashEdge: '#B9D2EC',
  ashDeep: '#2F4763',
  ashGlow: 'rgba(135,168,203,0.16)',

  // The third state has to read as "nobody has said yet", so it stays quiet.
  unknown: '#6A588C',
  unknownEdge: '#8E7BB0',

  accent: '#F0B13C',
  accentSoft: 'rgba(240,177,60,0.13)',
  success: '#3EBD8F',
  error: '#E14A52',
  errorSoft: 'rgba(225,74,82,0.14)',
  warn: '#E08B4B',
  hint: '#63BEEA',
  hintSoft: 'rgba(99,190,234,0.13)',
  focus: '#63BEEA',
  pencil: 'rgba(245,239,232,0.30)',
  veil: 'rgba(10,6,17,0.84)',
  vignette: 'rgba(10,6,17,0.55)',
};

export const Space = { page: 18, card: 16, inner: 12, gutter: 10 };
export const Radius = { card: 18, button: 12, chip: 9, tick: 4, seal: 8 };

// DOM type ramp. `tiny` is the floor for the whole app and it is 14 px, not 11.
export const Type = {
  tiny: 14,
  small: 15,
  body: 16,
  h3: 17,
  h2: 21,
  title: 30,
  mono: "'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Hiragino Sans GB', system-ui, sans-serif",
};

// Durations obey the 150–350 ms discipline; longer blocks the next move.
export const Motion = {
  tap: 150,
  base: 220,
  pop: 260,
  line: 300,
  win: 900,
  spring: 'cubic-bezier(0.34, 1.45, 0.64, 1)',
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
};

// Canvas board geometry. Ranges, not constants: the layout compresses inside these bounds
// and nowhere else, and `minFont` is the same 14 px floor the stylesheet obeys.
export const Board = {
  pad: 16,            // margin around the card column — not part of the board, not tappable
  maxW: 660,          // the column stops growing here so a desktop screen is not one long line
  gap: 10,            // between cards
  gapMin: 6,
  cardPad: 12,
  cardPadMin: 6,
  minFont: 14,        // hard floor: no canvas glyph or label is ever drawn smaller
  nameFont: 24,       // the speaker, larger than anything he said
  nameFontMin: 17,
  lineFont: 16,       // the sentence
  quoteFont: 15,      // the 「」 marks, set a touch under the sentence
  silentFont: 15,     // "没有开口"
  footFont: 14,       // the rule tag on a card
  lineHeight: 1.42,
  chipH: 30,          // 骑士 / 无赖 chip box
  chipHMin: 26,
  unknownH: 22,       // the third state is clearly smaller
  hitPad: 5,          // grows the tap target beyond the drawn glyph
  glyphMin: 15,
  headFont: 15,       // the "第 N 夜" header line on the canvas
};

export function applyThemeVars() {
  const root = document.documentElement.style;
  const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  for (const [k, v] of Object.entries(Palette)) root.setProperty('--' + kebab(k), v);
  for (const [k, v] of Object.entries(Space)) root.setProperty('--space-' + k, v + 'px');
  for (const [k, v] of Object.entries(Radius)) root.setProperty('--radius-' + k, v + 'px');
  for (const [k, v] of Object.entries(Type)) {
    if (k === 'mono' || k === 'sans') continue;
    root.setProperty('--text-' + k, v + 'px');
  }
  for (const [k, v] of Object.entries(Motion)) {
    if (typeof v === 'number') root.setProperty('--dur-' + kebab(k), v + 'ms');
    else root.setProperty('--ease-' + kebab(k), v);
  }
  root.setProperty('--font-mono', Type.mono);
  root.setProperty('--font-sans', Type.sans);
}

// The system preference is the floor and the in-game toggle may only add to it: a player who
// asked for less motion must not be overruled by an OS set to "no preference".
let motionReduced = false;

export function setReduceMotion(v) {
  motionReduced = !!v;
}

export const systemPrefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const prefersReducedMotion = () => motionReduced || systemPrefersReducedMotion();
