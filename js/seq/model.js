// Sequencer data model: songs, tracks, patterns and steps, and the pure helpers shared by the
// engine, the page and the tests. No DOM or MIDI here.
//
// A song file (data/sequences/<name>.json) looks like:
//   { format: 'mkxl-seq', version: 1, name, bpm, swing, scale: { root, type } | null,
//     tracks: [{ name, out, ch, voice, inst, mode, rate, pattern, mute, solo, vol, sound, program,
//                pool: { notes, order, latch },
//                patterns: { A: { length, steps: [{ i, notes, vel, gate, len, prob?, rat? }],
//                                 cc?: [{ cc, glide, steps: [{ i, v }] }] }, B, C, D } }],
//     song: [{ bars, play: ['A', null, ...] }] }   // play[] has one entry per track; null = silent
//
// Steps are stored sparsely: only steps that play a note, each with its start index `i`, the MIDI
// notes it plays (several = a chord; empty on note-pool tracks), velocity 1-127, gate (% of its
// last step that the note sounds for) and len (how many steps the note is held across). Optional:
// prob (1-99: the % chance the step plays; absent = always) and rat (2-4: the note repeats that
// many times across its length, a ratchet; absent = once).
//
// `cc` lanes send a MIDI Control Change from steps that set a value (0-127), e.g. a filter sweep.
// With `glide`, the value moves smoothly from each set step to the next (wrapping round).
//
// `inst` is a Lab instrument ({ name, patch }, see lab/patch.js) a Computer track plays instead of
// its test voice.
// `sound` is the XL sound a track uses ({ name, data: the program's bytes }), sent to the XL when
// playback starts. `program` (0-127) is a Program Change sent to other gear when playback starts.
// `vol` (0-127, 100 = normal) scales the computer sound, and is sent to MIDI gear as CC 7.

import { normalizePatch } from '../lab/patch.js';

export const FORMAT = 'mkxl-seq';
export const VERSION = 1;
export const MAX_STEPS = 64;
export const MAX_TRACKS = 8;
export const MAX_CC_LANES = 4;
export const PROBS = [100, 87, 75, 62, 50, 37, 25, 12];
export const PATTERNS = ['A', 'B', 'C', 'D'];
export const TICKS_PER_BEAT = 96;
export const TICKS_PER_BAR = TICKS_PER_BEAT * 4;
export const CLOCK_TICKS = TICKS_PER_BEAT / 24; // MIDI clock is 24 pulses per quarter note
export const RATES = { '1/32': 12, '1/16T': 16, '1/16': 24, '1/8T': 32, '1/8': 48, '1/4': 96 };
export const SWUNG_RATES = new Set(['1/16', '1/8']);
export const ORDERS = { played: 'As played', up: 'Up', down: 'Down', updown: 'Up-down', random: 'Random' };
export const VOICES = ['Bass', 'Pluck', 'Pad', 'Keys', 'Drums'];
export const COMPUTER = 'computer'; // track output that plays the built-in test synth
export const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  'harmonic minor': [0, 2, 3, 5, 7, 8, 11],
  'minor pentatonic': [0, 3, 5, 7, 10],
  'major pentatonic': [0, 2, 4, 7, 9],
  blues: [0, 3, 5, 6, 7, 10],
};
export const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
export const noteName = n => NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);
// Short names for General MIDI drum notes, shown on drum tracks.
const DRUM_NAMES = { 35: 'Kick', 36: 'Kick', 37: 'Rim', 38: 'Snare', 39: 'Clap', 40: 'Snare', 41: 'Tom', 42: 'Hat', 43: 'Tom',
  44: 'Pedal', 45: 'Tom', 46: 'Open', 47: 'Tom', 48: 'Tom', 49: 'Crash', 50: 'Tom', 51: 'Ride', 56: 'Bell', 57: 'Crash',
  59: 'Ride', 60: 'Bongo', 61: 'Bongo', 62: 'Conga', 63: 'Conga', 64: 'Conga', 69: 'Cabasa', 70: 'Shaker' };
export const drumName = n => DRUM_NAMES[n] || noteName(n);

const clamp = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};

export const newPattern = (length = 16) => ({ length, steps: [] });

export function newTrack(index = 0, fields = {}) {
  return {
    name: `Track ${index + 1}`, out: COMPUTER, ch: 2, voice: VOICES[index % VOICES.length],
    mode: 'steps', rate: '1/16', pattern: 'A', mute: false, solo: false, vol: 100, sound: null, program: null, inst: null,
    pool: { notes: [48, 51, 55], order: 'up', latch: true },
    patterns: Object.fromEntries(PATTERNS.map(p => [p, newPattern()])),
    ...fields,
  };
}

export function newSong() {
  return {
    format: FORMAT, version: VERSION, name: 'Untitled', bpm: 120, swing: 50, scale: null,
    tracks: [newTrack(0, { name: 'Bass', voice: 'Bass' })],
    song: [{ bars: 4, play: ['A'] }],
  };
}

// Checks and repairs a song from a file, localStorage or the AI. Unknown fields are dropped,
// numbers are clamped, and missing parts get defaults. Throws only if it isn't a song at all.
export function normalizeSong(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tracks)) throw new Error('not a sequencer song');
  const scale = raw.scale && SCALES[raw.scale.type] ? { root: clamp(raw.scale.root, 0, 11, 0), type: raw.scale.type } : null;
  const tracks = raw.tracks.slice(0, MAX_TRACKS).map((t, ti) => normalizeTrack(t, ti));
  if (!tracks.length) tracks.push(newTrack(0));
  const song = (Array.isArray(raw.song) ? raw.song : []).slice(0, 64).map(sec => ({
    bars: clamp(sec?.bars, 1, 64, 4),
    play: tracks.map((_, ti) => {
      const p = Array.isArray(sec?.play) ? sec.play[ti] : 'A';
      return p === null ? null : PATTERNS.includes(p) ? p : 'A';
    }),
  }));
  if (!song.length) song.push({ bars: 4, play: tracks.map(() => 'A') });
  return {
    format: FORMAT, version: VERSION,
    name: String(raw.name ?? 'Untitled').slice(0, 60) || 'Untitled',
    bpm: clamp(raw.bpm, 20, 300, 120),
    swing: clamp(raw.swing, 50, 75, 50),
    scale, tracks, song,
  };
}

const midiNotes = list => (Array.isArray(list) ? list : []).map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 127);

// Checks and repairs one pattern. With `onlyBelow`, steps at or past that index are dropped
// (used for AI answers, which must fit the pattern's length).
export function cleanPattern(p, { length, onlyBelow = MAX_STEPS } = {}) {
  length = clamp(length ?? p?.length, 1, MAX_STEPS, 16);
  const steps = [];
  for (const s of Array.isArray(p?.steps) ? p.steps : []) {
    const i = clamp(s?.i, 0, MAX_STEPS - 1, -1);
    if (i < 0 || i >= onlyBelow || steps.some(x => x.i === i)) continue;
    const step = { i, notes: [...new Set(midiNotes(s.notes))].sort((a, b) => a - b).slice(0, 8),
      vel: clamp(s.vel, 1, 127, 100), gate: clamp(s.gate, 1, 100, 60), len: clamp(s.len, 1, MAX_STEPS, 1) };
    const prob = clamp(s.prob, 1, 100, 100), rat = clamp(s.rat, 1, 4, 1);
    if (prob < 100) step.prob = prob;
    if (rat > 1) step.rat = rat;
    steps.push(step);
  }
  steps.sort((a, b) => a.i - b.i);
  // A note can't hold over the next one.
  steps.forEach((s, k) => { if (steps[k + 1]) s.len = Math.min(s.len, steps[k + 1].i - s.i); });
  const cc = cleanLanes(p?.cc, onlyBelow);
  return cc.length ? { length, steps, cc } : { length, steps };
}

function cleanLanes(raw, onlyBelow = MAX_STEPS) {
  const lanes = [];
  for (const l of Array.isArray(raw) ? raw : []) {
    const cc = Number.isInteger(l?.cc) && l.cc >= 0 && l.cc <= 119 ? l.cc : -1;
    if (cc < 0 || lanes.some(x => x.cc === cc) || lanes.length >= MAX_CC_LANES) continue;
    const steps = [];
    for (const s of Array.isArray(l.steps) ? l.steps : []) {
      const i = clamp(s?.i, 0, MAX_STEPS - 1, -1);
      if (i < 0 || i >= onlyBelow || steps.some(x => x.i === i)) continue;
      steps.push({ i, v: clamp(s.v, 0, 127, 64) });
    }
    lanes.push({ cc, glide: !!l.glide, steps: steps.sort((a, b) => a.i - b.i) });
  }
  return lanes;
}

// A lane's value at a (fractional) step position, or null where it sends nothing: without glide,
// only at steps that set a value; with glide, everywhere once it has a value, moving in a straight
// line from each set step to the next (and from the last round to the first).
export function laneValue(lane, pos, length) {
  const pts = lane.steps.filter(s => s.i < length);
  if (!pts.length) return null;
  if (!lane.glide) return pts.find(s => s.i === pos)?.v ?? null;
  const prev = pts.filter(s => s.i <= pos).at(-1) || pts.at(-1); // the last set step at or before pos
  const next = pts.find(s => s.i > pos) || pts[0]; //                 the first one after it
  const from = prev.i <= pos ? prev.i : prev.i - length;
  const to = next.i > pos ? next.i : next.i + length;
  if (prev === next && pts.length === 1) return prev.v;
  return Math.round(prev.v + (next.v - prev.v) * (pos - from) / (to - from));
}

// An XL program as stored with a track: its name and raw bytes (346 for the XL).
export function cleanSound(s) {
  const data = s?.data;
  if (!Array.isArray(data) || data.length < 300 || data.length > 400 || !data.every(b => Number.isInteger(b) && b >= 0 && b <= 255)) return null;
  return { name: String(s.name ?? '').slice(0, 16), data: [...data] };
}

// A Lab instrument stored with a track: its name and patch.
export function cleanInst(x) {
  if (!x || typeof x !== 'object') return null;
  try {
    const { patch } = normalizePatch(x.patch);
    return { name: String(x.name ?? patch.name).slice(0, 40), patch };
  } catch { return null; }
}

function normalizeTrack(t, ti) {
  const d = newTrack(ti);
  const notes = midiNotes;
  const patterns = {};
  for (const name of PATTERNS) patterns[name] = cleanPattern(t?.patterns?.[name]);
  return {
    name: String(t?.name ?? d.name).slice(0, 24) || d.name,
    out: typeof t?.out === 'string' && t.out ? t.out.slice(0, 120) : COMPUTER,
    ch: clamp(t?.ch, 1, 16, 2),
    voice: VOICES.includes(t?.voice) ? t.voice : d.voice,
    mode: t?.mode === 'pool' ? 'pool' : 'steps',
    rate: RATES[t?.rate] ? t.rate : '1/16',
    pattern: PATTERNS.includes(t?.pattern) ? t.pattern : 'A',
    mute: !!t?.mute, solo: !!t?.solo,
    vol: clamp(t?.vol, 0, 127, 100),
    sound: cleanSound(t?.sound),
    inst: cleanInst(t?.inst),
    program: Number.isInteger(t?.program) && t.program >= 0 && t.program <= 127 ? t.program : null,
    pool: {
      notes: notes(t?.pool?.notes).slice(0, 16),
      order: ORDERS[t?.pool?.order] ? t.pool.order : 'up',
      latch: t?.pool?.latch !== false,
    },
    patterns,
  };
}

// ---- patterns ----

export const stepAt = (pattern, i) => pattern.steps.find(s => s.i === i) || null;

// For each step index, the index of the note sounding there (starting or held), or -1.
export function coverMap(pattern) {
  const cover = new Array(pattern.length).fill(-1);
  for (const s of pattern.steps) {
    for (let k = s.i; k < Math.min(s.i + s.len, pattern.length); k++) cover[k] = s.i;
  }
  return cover;
}

// The longest a note starting at i may be: up to the next note or the pattern's end.
export function maxLen(pattern, i) {
  const next = pattern.steps.find(s => s.i > i);
  return Math.max(1, (next ? next.i : pattern.length) - i);
}

// Adds or updates the step starting at i. A step placed inside a held note shortens that note.
export function putStep(pattern, i, fields) {
  const holder = pattern.steps.find(s => s.i < i && s.i + s.len > i);
  if (holder) holder.len = i - holder.i;
  let s = stepAt(pattern, i);
  if (!s) {
    s = { i, notes: [], vel: 100, gate: 60, len: 1 };
    pattern.steps.push(s);
    pattern.steps.sort((a, b) => a.i - b.i);
  }
  Object.assign(s, fields);
  s.len = Math.min(Math.max(1, s.len), maxLen(pattern, i));
  return s;
}

export function removeStep(pattern, i) {
  pattern.steps = pattern.steps.filter(s => s.i !== i);
}

// How long a step's note sounds, in steps: all but its last held step, plus the gate of the last.
export function noteSteps(step, patternLength) {
  const held = Math.max(1, Math.min(step.len, patternLength - step.i));
  return held - 1 + step.gate / 100;
}

export const copyPattern = p => ({ length: p.length, steps: p.steps.map(s => ({ ...s, notes: [...s.notes] })),
  ...(p.cc?.length ? { cc: p.cc.map(l => ({ ...l, steps: l.steps.map(s => ({ ...s })) })) } : {}) });

// ---- note pool ----

// The notes in the order the pool walks through them. `played` keeps the order they were pressed.
export function poolOrder(notes, order) {
  const up = [...notes].sort((a, b) => a - b);
  switch (order) {
    case 'up': return up;
    case 'down': return up.reverse();
    case 'updown': return up.length > 2 ? [...up, ...up.slice(1, -1).reverse()] : up;
    default: return [...notes]; // 'played'; 'random' picks from this list
  }
}

// ---- scales ----

export function inScale(note, scale) {
  if (!scale) return true;
  return SCALES[scale.type].includes(((note - scale.root) % 12 + 12) % 12);
}

// Nearest note in the scale (ties go down).
export function snapToScale(note, scale) {
  if (!scale) return note;
  for (let d = 0; d < 7; d++) {
    if (inScale(note - d, scale)) return note - d;
    if (inScale(note + d, scale)) return note + d;
  }
  return note;
}

export const scaleLabel = scale => scale ? `${NOTE_NAMES[scale.root]} ${scale.type}` : 'Off';

// ---- song ----

export const audible = (song, ti) => {
  const t = song.tracks[ti];
  return song.tracks.some(x => x.solo) ? t.solo : !t.mute;
};

export function addTrack(song) {
  if (song.tracks.length >= MAX_TRACKS) return null;
  const t = newTrack(song.tracks.length);
  song.tracks.push(t);
  song.song.forEach(sec => sec.play.push('A'));
  return t;
}

// A first guess at what a track is for, from its name and test sound (for the AI's Auto role).
export const ROLES = { bass: 'Bass', lead: 'Lead / riff', chords: 'Chords', pad: 'Pad', arp: 'Arpeggio', drums: 'Drums' };
export function guessRole(track) {
  const name = track.name.toLowerCase();
  const hit = [
    ['drums', /drum|kick|snare|hat|perc|beat/], ['bass', /bass|sub|808/], ['pad', /pad|string|atmo|drone/],
    ['chords', /chord|stab|keys|piano|organ/], ['arp', /arp/], ['lead', /lead|riff|melod|hook|pluck|seq/],
  ].find(([, re]) => re.test(name));
  if (hit) return hit[0];
  if (track.mode === 'pool') return 'arp';
  return { Bass: 'bass', Pad: 'pad', Keys: 'chords', Pluck: 'lead', Drums: 'drums' }[track.voice] || 'lead';
}

export function removeTrack(song, ti) {
  if (song.tracks.length <= 1) return;
  song.tracks.splice(ti, 1);
  song.song.forEach(sec => sec.play.splice(ti, 1));
}
