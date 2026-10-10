// Stock patterns for the library: common building blocks of popular styles, written out here
// (genre staples, not copied from any record or sample pack). All are in C; the page transposes
// them to the song's key when they're used. Drums use General MIDI notes.
//
// Notation, one token per step:
//   melodic:  C2  Eb3  C3+Eb3+G3 (a chord)   .  rest   -  hold the previous note one more step
//             C3+Eb3+G3~16  held for 16 steps   suffix ! accent, ? soft
//             x  a hit with no note (note-pool rhythms)
//   drums:    a string per drum, one character per step: X accent, x hit, o ghost, . rest
import { cleanPattern } from './model.js';

const DRUMS = { kick: 36, rim: 37, snare: 38, clap: 39, hat: 42, pedal: 44, open: 46, crash: 49, ride: 51, cowbell: 56, shaker: 70, conga: 63 };
const NOTE = /^([A-G])(#|b)?(-?\d)$/;
const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function midi(name) {
  const m = NOTE.exec(name);
  if (!m) throw new Error(`bad note ${name}`);
  return PC[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12 * (+m[3] + 1);
}

function melodic(seq, gate) {
  const steps = [];
  let i = 0, last = null;
  for (const tok of seq.trim().split(/\s+/)) {
    if (tok === '.') { i++; last = null; continue; }
    if (tok === '-') { if (last) { last.len++; last.gate = 100; } i++; continue; }
    const [, body, hold, mark] = /^(.+?)(?:~(\d+))?([!?])?$/.exec(tok);
    const len = hold ? +hold : 1;
    const vel = mark === '!' ? 118 : mark === '?' ? 65 : 95;
    last = { i, notes: body === 'x' ? [] : body.split('+').map(midi), vel, gate: len > 1 ? 100 : gate, len };
    steps.push(last);
    i += len;
  }
  return { steps, length: i };
}

function drums(parts) {
  const hits = new Map();
  let length = 0;
  for (const [drum, line] of Object.entries(parts)) {
    length = Math.max(length, line.length);
    [...line].forEach((c, i) => {
      if (c === '.') return;
      const h = hits.get(i) || { i, notes: [], vel: 0, gate: 30, len: 1 };
      h.notes.push(DRUMS[drum]);
      h.vel = Math.max(h.vel, c === 'X' ? 120 : c === 'x' ? 100 : 55);
      hits.set(i, h);
    });
  }
  return { steps: [...hits.values()].map(h => ({ ...h, notes: h.notes.sort((a, b) => a - b) })), length };
}

const minor = { root: 0, type: 'minor' }, major = { root: 0, type: 'major' };

const DEFS = [
  // ---- drums ----
  ['House: four on the floor', 'drums', 'house', 124, { kick: 'X...x...X...x...', clap: '....x.......x...', hat: 'o.o.o.o.o.o.o.o.', open: '..x...x...x...x.' }],
  ['Deep house: shuffled', 'drums', 'house', 120, { kick: 'X...x...X...x...', clap: '....x.......x...', hat: '..x...x...x..ox.', shaker: 'oxoooxoooxoooxoo' }],
  ['Techno: driving', 'drums', 'techno', 130, { kick: 'X...x...X...x...', clap: '....x.......x...', hat: 'oxoxoxoxoxoxoxox', rim: '...x..x....x..x.' }],
  ['Techno: rolling', 'drums', 'techno', 132, { kick: 'X...x...X...x...', open: '..x...x...x...x.', hat: 'o.oo.oo.o.oo.oo.', rim: '.......x.......x' }],
  ['Disco', 'drums', 'disco', 118, { kick: 'X...x...X...x...', snare: '....x.......x...', hat: 'xoxoxoxoxoxoxoxo', open: '..x...x...x...x.' }],
  ['Boom bap', 'drums', 'hip hop', 90, { kick: 'X......x.x......', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.' }],
  ['Hip hop: lazy', 'drums', 'hip hop', 85, { kick: 'X.....x...x.....', snare: '....X.......X..o', hat: 'x.x.x.x.x.xox.x.' }],
  ['Trap: half-time', 'drums', 'trap', 140, { kick: 'X......x..x.....', clap: '........X.......', hat: 'xoxoxoxoxxxoxoxx', open: '.............x..' }],
  ['Breakbeat', 'drums', 'breaks', 128, { kick: 'X.........X.....', snare: '....X..o.o..X..o', hat: 'x.x.x.x.x.x.x.x.' }],
  ['Drum & bass: two-step', 'drums', 'dnb', 172, { kick: 'X.........X.....', snare: '....X.......X...', hat: 'x.x.x.xox.x.x.xo', ride: '..x...x...x...x.' }],
  ['Reggaeton: dembow', 'drums', 'latin', 95, { kick: 'X...x...X...x...', snare: '...x..x....x..x.', hat: 'x.x.x.x.x.x.x.x.' }],
  ['Rock', 'drums', 'rock', 120, { kick: 'X.......x.x.....', snare: '....X.......X...', hat: 'x.x.x.x.x.x.x.x.' }],
  ['Funk', 'drums', 'funk', 100, { kick: 'X.x.......x..x..', snare: '....X..o.o..X..o', hat: 'xoxoxoxoxoxoxoxo' }],
  ['Bossa nova', 'drums', 'latin', 130, { kick: 'x..xx..xx..xx..x', rim: 'x..x..x...x..x..', hat: 'oxoxoxoxoxoxoxox' }],
  ['Afro house', 'drums', 'house', 122, { kick: 'X...x...X...x...', rim: 'x..x..x...x.x...', shaker: 'oxooxoxooxooxoxo', conga: '..x..x.x..x..x..' }],
  ['Electro', 'drums', 'electro', 125, { kick: 'X......x..x.....', snare: '....X.......X...', hat: 'xoxoxoxoxoxoxoxo', cowbell: '..........x.....' }],
  ['Dub: half-time', 'drums', 'dub', 70, { kick: 'X.........x.....', snare: '........X.......', rim: '...x.......x....', hat: '..x...x...x...x.' }],
  ['UK garage: 2-step', 'drums', 'garage', 132, { kick: 'X.........x..x..', snare: '....X.......X...', hat: '..x..xx...x..xx.', shaker: 'oooooooooooooooo' }],

  // ---- bass (C minor unless noted) ----
  ['House: off-beat bass', 'bass', 'house', 124, 'C2 . C2? . . . C2 . . . C2? . . . C2 .', 40, minor],
  ['Octave pump', 'bass', 'disco', 120, 'C2! . C3 . C2 . C3 . C2! . C3 . C2 . C3 .', 45, minor],
  ['Rolling techno', 'bass', 'techno', 130, '. C2 C2 . . C2 C2? . . C2 C2 . . C2 C2? .', 45, minor],
  ['Acid line', 'bass', 'acid', 128, 'C2! C2 C3 Eb2 . C2 Bb1 C2! . G2 F2 - Eb2 C2! C3? .', 50, minor],
  ['Funk bass', 'bass', 'funk', 100, 'C2! . . C3 . . Bb1 C2 . . Eb2 . F2 . G2 Bb2?', 45, minor],
  ['Disco octaves', 'bass', 'disco', 118, 'C2 . C3 . Eb2 . Eb3 . F2 . F3 . G2 . G3 .', 50, minor],
  ['Dub roots', 'bass', 'dub', 70, 'C2~6 . . G1~4 Bb1~2 . .', 90, minor],
  ['Synthwave drive', 'bass', 'synthwave', 110, 'C2 C2 C2 C2 C2 C2 C2 C2 Ab1 Ab1 Ab1 Ab1 Bb1 Bb1 Bb1 Bb1', 55, minor],
  ['Reggaeton bass', 'bass', 'latin', 95, 'C2~3 Eb2 . . C2 . G1~3 Bb1 . . C2 .', 80, minor],
  ['Walking bass', 'bass', 'jazz', 120, 'C2 . E2 . G2 . A2 . F2 . A2 . C3 . B2 .', 85, major],
  ['Boom-bap bass', 'bass', 'hip hop', 90, 'C2~3 . . . . G1 . Bb1~2 . . . . .', 85, minor],
  ['Sub pulse', 'bass', 'minimal', 124, 'C2~2 . . . . . . C2~2 . . . . . .', 90, minor],
  ['Electro bass', 'bass', 'electro', 125, 'C2! . . C2 . . C3? . Eb2 . . C2 . G1 Bb1 .', 40, minor],

  // ---- chords and pads ----
  ['Minor pad: i–VI–III–VII', 'pad', 'pad', 120, 'C3+Eb3+G3~16 Ab2+C3+Eb3~16 Bb2+Eb3+G3~16 Bb2+D3+F3~16', 100, minor],
  ['Pop pad: I–V–vi–IV', 'pad', 'pop', 120, 'C3+E3+G3~16 B2+D3+G3~16 C3+E3+A3~16 C3+F3+A3~16', 100, major],
  ['Sad minor: i–iv–i–v', 'pad', 'pad', 100, 'C3+Eb3+G3~16 C3+F3+Ab3~16 C3+Eb3+G3~16 Bb2+D3+G3~16', 100, minor],
  ['Jazz: ii–V–I', 'pad', 'jazz', 110, 'D3+F3+A3+C4~16 D3+F3+G3+B3~16 C3+E3+G3+B3~32', 100, major],
  ['Dark drone: i–VI', 'pad', 'ambient', 90, 'C3+G3+Eb4~32 Ab2+Eb3+C4~32', 100, minor],
  ['House piano stabs', 'chords', 'house', 124, '. . C3+Eb3+G3+Bb3 . . . C3+Eb3+G3+Bb3? . . . . F3+Ab3+C4+Eb4 . . F3+Ab3+C4+Eb4? .', 40, minor],
  ['Dub techno chord', 'chords', 'techno', 122, '. . C3+Eb3+G3+Bb3 . . . . . . . C3+Eb3+G3+Bb3? . . . . .', 30, minor],
  ['Trance gate', 'chords', 'trance', 138, 'C3+Eb3+G3! C3+Eb3+G3 . C3+Eb3+G3 C3+Eb3+G3! . C3+Eb3+G3 . Ab2+C3+Eb3! Ab2+C3+Eb3 . Ab2+C3+Eb3 Bb2+D3+F3! . Bb2+D3+F3 .', 50, minor],
  ['Reggae skank', 'chords', 'reggae', 80, '. . . . C3+Eb3+G3 . . . . . . . C3+Eb3+G3 . . .', 30, minor],
  ['Funk stabs', 'chords', 'funk', 100, '. . . C3+Eb3+Bb3! . . C3+Eb3+Bb3? . . . . . F3+A3+Eb4! . . .', 30, { root: 0, type: 'dorian' }],

  // ---- arpeggios and leads ----
  ['Up-down minor 7th', 'arp', 'arp', 124, 'C4 Eb4 G4 Bb4 C5 Bb4 G4 Eb4 C4 Eb4 G4 Bb4 C5 Bb4 G4 Eb4', 50, minor],
  ['Broken octaves', 'arp', 'arp', 120, 'C3 C4 G3 C4 C3 C4 G3 C4 Ab2 Ab3 Eb3 Ab3 Bb2 Bb3 F3 Bb3', 45, minor],
  ['Trance arp', 'arp', 'trance', 138, 'C4 G4 C5 G4 Eb4 G4 C5 G4 Ab3 Eb4 Ab4 Eb4 Bb3 F4 Bb4 F4', 45, minor],
  ['Pluck ostinato', 'arp', 'arp', 120, 'C4! . G4 C4 . G4 C4 . Eb4! . G4 Eb4 . G4 Bb4 .', 40, minor],
  ['Pentatonic hook', 'lead', 'lead', 120, 'C4! . Eb4 . F4 . G4 - . Bb4 G4 . F4 . Eb4 .', 60, minor],
  ['Octave stab riff', 'lead', 'lead', 124, 'C4+C5! . . C4+C5 . . Bb3+Bb4 . . G3+G4 . . Bb3+Bb4 . C4+C5? .', 40, minor],
  ['Call and answer', 'lead', 'lead', 120, 'G4! . Bb4 . C5 - Bb4 . G4 . . . . . . . G4! . Bb4 . C5 . Eb5 . D5 - C5 . Bb4 . . .', 60, minor],

  // ---- note-pool rhythms (steps set only the rhythm) ----
  ['Straight 16ths', 'arp', 'rhythm', 124, 'x! x x x x! x x x x! x x x x! x x x', 45, null, 'pool'],
  ['Off-beat 8ths', 'arp', 'rhythm', 124, '. . x . . . x . . . x . . . x .', 40, null, 'pool'],
  ['Gallop', 'arp', 'rhythm', 128, 'x! . x x x! . x x x! . x x x! . x x', 40, null, 'pool'],
  ['Tresillo 3-3-2', 'arp', 'rhythm', 110, 'x! . . x . . x . x! . . x . . x .', 50, null, 'pool'],
  ['Trance gate rhythm', 'arp', 'rhythm', 138, 'x! x . x x . x . x! x . x x . x .', 45, null, 'pool'],
  ['Dotted 8ths', 'arp', 'rhythm', 120, 'x! . . x . . x . . x . . x . . x', 50, null, 'pool'],
];

export const STOCK = DEFS.map(([name, role, tag, bpm, body, gate, key, mode]) => {
  const raw = typeof body === 'string' ? melodic(body, gate) : drums(body);
  return {
    id: `stock:${name}`, source: 'stock', name, role, tags: [tag], bpm, rate: '1/16',
    mode: mode || 'steps', key: role === 'drums' ? null : key ?? null,
    ...cleanPattern({ steps: raw.steps }, { length: raw.length, onlyBelow: raw.length }),
  };
});
