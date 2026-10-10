// The song the sequencer opens with the first time: three tracks on the computer's test sound.
import { newSong, newTrack, putStep } from './model.js';

export function demoSong() {
  const song = newSong();
  song.name = 'Demo';
  song.bpm = 122;
  song.swing = 56;
  song.scale = { root: 0, type: 'minor' };

  const line = (pattern, notes, vel = 95, gate = 55) =>
    notes.forEach((n, i) => { if (n) putStep(pattern, i, { notes: Array.isArray(n) ? n : [n], vel, gate }); });

  const bass = newTrack(0, { name: 'Bass', voice: 'Bass' });
  line(bass.patterns.A, [36, 0, 36, 48, 0, 36, 39, 0, 36, 0, 43, 0, 0, 46, 43, 39]);
  putStep(bass.patterns.A, 10, { len: 2 });
  line(bass.patterns.B, [36, 36, 0, 36, 39, 0, 41, 0, 36, 36, 0, 48, 46, 0, 43, 0]);
  bass.patterns.C.length = 12;
  line(bass.patterns.C, [31, 0, 0, 43, 31, 0, 34, 0, 36]);
  putStep(bass.patterns.C, 8, { len: 4 });

  const riff = newTrack(1, { name: 'Riff', voice: 'Pluck', mode: 'pool', pool: { notes: [60, 63, 67, 70], order: 'up', latch: true } });
  [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1].forEach((on, i) => { if (on) putStep(riff.patterns.A, i, { vel: 70 + (i % 3) * 15, gate: 40 }); });
  riff.patterns.B.length = 12;
  [1, 1, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0].forEach((on, i) => { if (on) putStep(riff.patterns.B, i, { vel: 85, gate: 40 }); });

  const pads = newTrack(2, { name: 'Pads', voice: 'Pad' });
  const chords = (pattern, list, len) => list.forEach((notes, k) => putStep(pattern, k * len, { notes, vel: 80, gate: 100, len }));
  chords(pads.patterns.A, [[48, 51, 55], [44, 48, 51], [51, 55, 58], [46, 50, 53]], 4);
  pads.patterns.B.length = 32;
  chords(pads.patterns.B, [[53, 56, 60], [48, 51, 55], [44, 48, 51], [46, 50, 53]], 8);

  song.tracks = [bass, riff, pads];
  song.song = [
    { bars: 4, play: ['A', 'A', 'A'] },
    { bars: 4, play: ['B', 'A', 'A'] },
    { bars: 2, play: ['B', 'B', 'B'] },
    { bars: 2, play: ['C', null, 'B'] },
  ];
  return song;
}
