// Synthesised feedback, no sample files. In this game a sound is a *state* readout — "he is
// standing for the truth", "he is one of the liars", "what you just wrote is refused by a
// sentence in this room", "every equation closes" — and each of those is one short envelope,
// so a synth keeps the artifact small (there is nothing to download) and the vocabulary honest.
//
// Knight and knave must be told apart with the eyes shut, so they are not the same shape at a
// different pitch: one rises, one falls, and the lie is the only sound in the set with two
// competing voices. If `AudioContext` is missing or blocked the whole module goes quiet and the
// game plays exactly the same.

let ctx = null;
let master = null;
let enabled = true;

function audio() {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  const Ctor = typeof g.AudioContext !== 'undefined' ? g.AudioContext : g.webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx) {
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    } catch {
      ctx = null;
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// One oscillator with a two-point pitch glide and an exponential decay. Everything below is a
// call to this; adding a second voice shape is how a game ends up with sounds that do not
// belong to the same instrument.
function tone({ f0, f1 = f0, dur = 0.12, type = 'sine', gain = 0.22, delay = 0 }) {
  const ac = audio();
  if (!ac || !enabled) return;
  const t = ac.currentTime + delay;
  try {
    const osc = ac.createOscillator();
    const vol = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
    vol.gain.setValueAtTime(0.0001, t);
    vol.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    vol.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(vol).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  } catch {
    /* a blocked or closing context must never take a move down with it */
  }
}

// A short filtered noise burst — the candle of the set, used only for the pencil, which is a
// mark on paper rather than a verdict on a person.
function scratch({ dur = 0.07, gain = 0.06 } = {}) {
  const ac = audio();
  if (!ac || !enabled) return;
  try {
    const n = Math.floor(ac.sampleRate * dur);
    const buf = ac.createBuffer(1, n, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ac.createBufferSource();
    const bp = ac.createBiquadFilter();
    const vol = ac.createGain();
    src.buffer = buf;
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    bp.Q.value = 0.9;
    vol.gain.value = gain;
    src.connect(bp).connect(vol).connect(master);
    src.start();
  } catch {
    /* same deal as tone(): the picture carries the state, the sound is a courtesy */
  }
}

export const Sound = {
  setEnabled(v) {
    enabled = !!v;
    if (enabled) audio();
  },
  enabled: () => enabled,
  available: () => !!audio(),

  // 骑士: the seal coming down — up, warm, one voice.
  knight() {
    tone({ f0: 392, f1: 660, dur: 0.15, type: 'triangle', gain: 0.2 });
    tone({ f0: 990, dur: 0.06, type: 'sine', gain: 0.05, delay: 0.03 });
  },
  // 无赖: down, and the only pair of voices that beat against each other. You can hear that
  // this is the lie without being told.
  knave() {
    tone({ f0: 330, f1: 176, dur: 0.16, type: 'sine', gain: 0.16 });
    tone({ f0: 349, f1: 185, dur: 0.16, type: 'sine', gain: 0.08, delay: 0.012 });
  },
  // back to 未定: the mark lifts, nothing is asserted.
  clear() {
    tone({ f0: 300, f1: 210, dur: 0.09, type: 'sine', gain: 0.1 });
  },
  // notes are not moves, and they must not sound like one
  note() {
    scratch({ dur: 0.07, gain: 0.07 });
  },
  pencil() {
    scratch({ dur: 0.05, gain: 0.05 });
  },
  undo() {
    tone({ f0: 520, f1: 320, dur: 0.12, type: 'triangle', gain: 0.13 });
  },
  // a card press that did nothing (focus moved, no write) — audible, but it must not be
  // confusable with a committed step
  tap() {
    tone({ f0: 620, dur: 0.04, type: 'sine', gain: 0.06 });
  },
  // Two detuned voices a semitone apart: an interval deliberately unpleasant, for the one thing
  // the player must notice without looking.
  conflict() {
    tone({ f0: 200, f1: 150, dur: 0.18, type: 'sawtooth', gain: 0.11 });
    tone({ f0: 212, f1: 158, dur: 0.18, type: 'sawtooth', gain: 0.09, delay: 0.012 });
  },
  hint() {
    tone({ f0: 760, f1: 1020, dur: 0.16, type: 'sine', gain: 0.16 });
    tone({ f0: 1140, dur: 0.1, type: 'sine', gain: 0.07, delay: 0.06 });
  },
  // the stall is not a purchase and must not sound like one
  stall() {
    tone({ f0: 260, f1: 250, dur: 0.1, type: 'square', gain: 0.05 });
  },
  pause() {
    tone({ f0: 420, f1: 300, dur: 0.14, type: 'sine', gain: 0.1 });
  },
  win() {
    [523, 659, 784, 1046].forEach((f, i) => tone({ f0: f, dur: 0.26, type: 'triangle', gain: 0.17, delay: i * 0.09 }));
  },
};
