// Always-on capture: everything played on the keyboard is kept, split into takes at silences, and
// can be turned into a pattern or a .mid file afterwards. No DOM here.
//
// Raw events: { t: wall-clock ms, type: 'on' | 'off' | 'ped', n (note, or 1/0 for the pedal), v,
//   tick?, run?, bpm? }. tick/run/bpm are set when the sequencer was playing: the engine's tick at
// that moment, which playback run it was, and its tempo. A take played entirely along with one run
// is "synced": its notes land exactly on the sequencer's bars.
import { TICKS_PER_BEAT, TICKS_PER_BAR, MAX_STEPS, cleanPattern } from './model.js';

export const GAP_MS = 4000; // this much silence ends a take

// Pairs note-ons with note-offs. The sustain pedal holds released notes until it comes up.
// Notes still held at the end last until `now`.
export function notesOf(events, now = Infinity) {
  const open = new Map(), sustained = [], notes = [];
  let pedal = false;
  const close = (n, e) => {
    n.dur = Math.max(1, e.t - n.t);
    if (n.tick !== undefined && e.tick !== undefined && e.run === n.run) n.dticks = Math.max(1, e.tick - n.tick);
    notes.push(n);
  };
  for (const e of events) {
    if (e.type === 'on') {
      if (open.has(e.n)) close(open.get(e.n), e); // same key again without a release
      const i = sustained.findIndex(n => n.note === e.n);
      if (i >= 0) close(sustained.splice(i, 1)[0], e);
      open.set(e.n, { t: e.t, note: e.n, vel: e.v, tick: e.tick, run: e.run, bpm: e.bpm });
    } else if (e.type === 'off') {
      const n = open.get(e.n);
      if (!n) continue;
      open.delete(e.n);
      if (pedal) sustained.push(n); else close(n, e);
    } else if (e.type === 'ped') {
      pedal = !!e.n;
      if (!pedal) for (const n of sustained.splice(0)) close(n, e);
    }
  }
  const end = { t: Math.min(now, events.at(-1)?.t ?? 0) };
  for (const n of [...open.values(), ...sustained]) { n.open = true; close(n, end); }
  return notes.sort((a, b) => a.t - b.t || a.note - b.note);
}

// Groups notes into takes separated by at least `gap` ms of silence (nothing sounding). Notes
// starting inside one of `ranges` ([{ start, end, kind }], e.g. a performance recorded with the
// sequencer) form one take however long their rests.
export function splitTakes(notes, gap = GAP_MS, ranges = []) {
  const takes = [];
  let cur = null, end = -Infinity, curRange = null;
  for (const n of notes) {
    const range = ranges.find(r => n.t >= r.start && n.t <= r.end) || null;
    if (!cur || range !== curRange || (!range && n.t > end + gap)) {
      cur = { notes: [], range }; takes.push(cur); end = -Infinity; curRange = range;
    }
    cur.notes.push(n);
    end = Math.max(end, n.t + n.dur);
  }
  for (const take of takes) {
    const ns = take.notes, first = ns[0];
    take.id = first.t;
    take.start = first.t;
    take.end = Math.max(...ns.map(n => n.t + n.dur));
    take.open = ns.some(n => n.open);
    take.synced = ns.every(n => n.tick !== undefined && n.run === first.run);
    if (take.range) { take.kind = take.range.kind; take.id = take.range.start; take.open ||= !take.range.end || take.range.end === Infinity; }
    delete take.range;
    if (take.synced) take.bpm = first.bpm;
  }
  return takes;
}

// Note starts closer together than this are one chord.
const CHORD_MS = 50;

// A best guess at the tempo of a take played without the sequencer, taking the first note as a
// downbeat: the tempo whose 16th-note grid the note starts fit best. Tempos that fit about equally
// well (twice or half as fast fit just as well) are settled by closeness to `prefer` (e.g. the
// song's tempo). Returns null with too few notes to tell.
export function estimateTempo(notes, prefer = 110) {
  const onsets = [];
  for (const n of notes) if (!onsets.length || n.t - onsets.at(-1) > CHORD_MS) onsets.push(n.t);
  if (onsets.length < 4) return null;
  const t0 = onsets[0], rel = onsets.slice(1).map(t => t - t0);
  const fit = bpm => {
    const sixteenth = 60000 / bpm / 4;
    let s = 0;
    for (const t of rel) { const e = t / sixteenth % 1, d = Math.min(e, 1 - e); s += Math.exp(-(d * d) / (2 * 0.1 * 0.1)); }
    return s / rel.length;
  };
  const scores = [];
  for (let bpm = 60; bpm <= 180; bpm += 0.5) scores.push([bpm, fit(bpm)]);
  const best = Math.max(...scores.map(s => s[1]));
  // Local peaks that fit nearly as well as the best one.
  const peaks = scores.filter(([, s], k) => s >= best * 0.93 && s >= (scores[k - 1]?.[1] ?? 0) && s >= (scores[k + 1]?.[1] ?? 0));
  const dist = bpm => Math.abs(Math.log2(bpm / prefer));
  peaks.sort((a, b) => dist(a[0]) - dist(b[0]));
  return Math.round(peaks[0][0]);
}

// Each note's start and length in ticks from the take's first bar. Synced takes use the engine's
// ticks (bar 1 = the bar the first note was played in); others put the first note on beat 1 at `bpm`.
export function takeTicks(take, bpm) {
  if (take.synced) {
    const bar0 = Math.floor(take.notes[0].tick / TICKS_PER_BAR) * TICKS_PER_BAR;
    const perMs = take.bpm * TICKS_PER_BEAT / 60000;
    return take.notes.map(n => ({ note: n.note, vel: n.vel, pos: n.tick - bar0, len: n.dticks ?? n.dur * perMs }));
  }
  const perMs = bpm * TICKS_PER_BEAT / 60000;
  const t0 = take.notes[0].t;
  return take.notes.map(n => ({ note: n.note, vel: n.vel, pos: (n.t - t0) * perMs, len: n.dur * perMs }));
}

// How many bars a take spans, and how many fit in one pattern at a step rate (ticks per step).
export function takeBars(items) {
  return Math.max(1, Math.ceil((Math.max(...items.map(x => x.pos)) + 1) / TICKS_PER_BAR));
}
export const barsPerPattern = rate => Math.max(1, Math.floor(MAX_STEPS * rate / TICKS_PER_BAR));

// Quantizes a take into a pattern at a step rate, starting at bar `fromBar` (0-based). Notes
// starting on the same step become a chord held as long as its longest note.
export function takeToPattern(items, rate, { fromBar = 0 } = {}) {
  const stepsPerBar = TICKS_PER_BAR / rate;
  const bars = Math.min(barsPerPattern(rate), takeBars(items) - fromBar);
  const length = Math.max(1, bars) * stepsPerBar;
  const offset = fromBar * TICKS_PER_BAR;
  const byStep = new Map();
  for (const x of items) {
    const i = Math.round((x.pos - offset) / rate);
    if (i < 0 || i >= length) continue;
    const s = byStep.get(i) || { i, notes: [], vel: 0, d: 0 };
    s.notes.push(x.note);
    s.vel = Math.max(s.vel, x.vel);
    s.d = Math.max(s.d, x.len / rate);
    byStep.set(i, s);
  }
  const steps = [...byStep.values()].map(({ i, notes, vel, d }) => {
    const len = Math.max(1, Math.round(d));
    return { i, notes, vel, len, gate: Math.round(Math.min(1, Math.max(0.1, d - (len - 1))) * 100) };
  });
  return cleanPattern({ length, steps });
}

// A take as notes for writeMidi, unquantized. Synced takes keep their place in the bar.
export function takeMidiNotes(take, bpm) {
  return takeTicks(take, bpm).map(x => ({ tick: x.pos, dur: x.len, note: x.note, vel: x.vel }));
}
