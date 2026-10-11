// Offline checks for the sequencer model and timing engine: node tools/seqtest.mjs
// (also run by tools/selftest.mjs)
import assert from 'node:assert/strict';
import { normalizeSong, newSong, newTrack, putStep, removeStep, stepAt, coverMap, maxLen, noteSteps,
  poolOrder, inScale, snapToScale, addTrack, removeTrack, copyPattern, cleanPattern, guessRole, MAX_STEPS, laneValue } from '../js/seq/model.js';
import { Engine } from '../js/seq/engine.js';
import { randomIdea, euclid, seeded } from '../js/seq/generate.js';
import { STOCK } from '../js/seq/stock.js';
import { writeMidi, readMidi, renderSong } from '../js/seq/midifile.js';
import { notesOf, splitTakes, estimateTempo, takeTicks, takeToPattern, takeMidiNotes, barsPerPattern } from '../js/seq/capture.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.01, `${msg}: ${a} vs ${b}`);

// ---- model ----
{
  const p = { length: 16, steps: [] };
  putStep(p, 4, { notes: [48], len: 8 });
  putStep(p, 0, { notes: [36], len: 10 }); // clipped so it doesn't hold over step 4
  assert.equal(stepAt(p, 0).len, 4);
  putStep(p, 6, { notes: [50] }); // inside the held note at 4: shortens it
  assert.equal(stepAt(p, 4).len, 2);
  assert.deepEqual(coverMap(p).slice(0, 8), [0, 0, 0, 0, 4, 4, 6, -1]);
  assert.equal(maxLen(p, 6), 10);
  assert.equal(maxLen(p, 2), 2);
  removeStep(p, 4);
  assert.equal(stepAt(p, 4), null);
  near(noteSteps({ i: 14, len: 4, gate: 50 }, 16), 1.5, 'note clipped at pattern end');
  const c = copyPattern(p);
  c.steps[0].notes.push(99);
  assert.deepEqual(stepAt(p, 0).notes, [36], 'copy is deep');
}
assert.deepEqual(poolOrder([64, 60, 67], 'played'), [64, 60, 67]);
assert.deepEqual(poolOrder([64, 60, 67], 'up'), [60, 64, 67]);
assert.deepEqual(poolOrder([64, 60, 67], 'down'), [67, 64, 60]);
assert.deepEqual(poolOrder([64, 60, 67, 72], 'updown'), [60, 64, 67, 72, 67, 64]);
const cMinor = { root: 0, type: 'minor' };
assert.ok(inScale(63, cMinor) && !inScale(64, cMinor));
assert.equal(snapToScale(64, cMinor), 63);
assert.equal(snapToScale(66, cMinor), 65);
assert.equal(snapToScale(61, { root: 2, type: 'major' }), 61); // C# is in D major

// normalizeSong repairs junk and keeps good data.
{
  const n = normalizeSong({
    name: 'x'.repeat(100), bpm: 999, swing: 10, scale: { root: 14, type: 'minor' },
    tracks: [{ name: 'B', ch: 40, rate: 'weird', mode: 'pool', patterns: { A: { length: 200, steps: [
      { i: 0, notes: [36, 36, 300, 40], vel: 0, gate: 500, len: 99 }, { i: 0, notes: [1] }, { i: 3, notes: [38] }, { i: -2 }] } } }],
    song: [{ bars: 0, play: ['Z'] }, { play: [null] }],
  });
  assert.equal(n.name.length, 60);
  assert.equal(n.bpm, 300); assert.equal(n.swing, 50); assert.equal(n.scale.root, 11);
  const t = n.tracks[0];
  assert.equal(t.ch, 16); assert.equal(t.rate, '1/16'); assert.equal(t.mode, 'pool');
  assert.equal(t.patterns.A.length, MAX_STEPS);
  assert.equal(t.patterns.A.steps.length, 2);
  assert.deepEqual(t.patterns.A.steps[0], { i: 0, notes: [36, 40], vel: 1, gate: 100, len: 3 });
  assert.deepEqual(t.patterns.B, { length: 16, steps: [] });
  assert.deepEqual(n.song, [{ bars: 1, play: ['A'] }, { bars: 4, play: [null] }]);
  assert.throws(() => normalizeSong({}));
  const withSound = normalizeSong({ tracks: [{ sound: { name: 'WARMBASS', data: Array(346).fill(7) }, program: 12 }, { sound: { data: [1, 2] }, program: 200 }] });
  assert.equal(withSound.tracks[0].sound.data.length, 346);
  assert.equal(withSound.tracks[0].program, 12);
  assert.equal(withSound.tracks[1].sound, null);
  assert.equal(withSound.tracks[1].program, null);
  const fresh = newSong();
  assert.deepEqual(normalizeSong(JSON.parse(JSON.stringify(fresh))), fresh, 'a new song survives a round trip');
  addTrack(fresh);
  assert.equal(fresh.song[0].play.length, 2);
  removeTrack(fresh, 0);
  assert.equal(fresh.tracks.length, 1); assert.equal(fresh.song[0].play.length, 1);
}

// AI answers: steps must fit the pattern's length; junk is dropped.
{
  const p = cleanPattern({ steps: [{ i: 2, notes: [40], vel: 90, gate: 50, len: 9 }, { i: 6, notes: [43] }, { i: 12, notes: [45] }, { i: 'x' }] },
    { length: 12, onlyBelow: 12 });
  assert.equal(p.length, 12);
  assert.deepEqual(p.steps.map(s => [s.i, s.len]), [[2, 4], [6, 1]]);
  assert.equal(guessRole(newTrack(0, { name: 'Kick + hats' })), 'drums');
  assert.equal(guessRole(newTrack(0, { name: 'Track 3', voice: 'Pad' })), 'pad');
  assert.equal(guessRole(newTrack(0, { name: 'Thing', mode: 'pool' })), 'arp');
}

// 🎲 ideas: every role, many lengths and seeds; valid steps, in the scale, inside the pattern.
assert.equal(euclid(3, 8).map(x => (x ? 'x' : '.')).join(''), 'x..x..x.');
for (const role of ['bass', 'lead', 'chords', 'pad', 'arp', 'drums']) {
  for (const [length, seed] of [[16, 1], [7, 2], [12, 3], [32, 4], [64, 5], [1, 6], [16, 7], [24, 8]]) {
    for (const density of ['sparse', 'medium', 'busy']) {
      for (const scale of [{ root: 9, type: 'dorian' }, { root: 2, type: 'minor pentatonic' }, null]) {
        const { pattern, summary } = randomIdea({ role, length, density, scale, rng: seeded(seed * 31 + length) });
        assert.ok(summary.startsWith('🎲'));
        assert.deepEqual(cleanPattern(pattern, { length, onlyBelow: length }), pattern, `${role} ${length} is already clean`);
        if (length >= 4 && role !== 'drums') assert.ok(pattern.steps.length > 0, `${role} ${length} ${density} has notes`);
        const notesOk = role === 'drums' || role === 'chords' || role === 'pad' || role === 'arp'
          ? true // chords and arps use the parent 7-note scale of a pentatonic
          : pattern.steps.every(s => s.notes.every(n => inScale(n, scale || { root: 0, type: 'minor' })));
        assert.ok(notesOk, `${role} notes in scale`);
      }
    }
  }
}
assert.ok(randomIdea({ role: 'bass', pool: true, length: 16, rng: seeded(1) }).pattern.steps.every(s => s.notes.length === 0));

// Stock library patterns: whole bars, valid, in their stated key, unique names.
assert.ok(STOCK.length >= 40);
assert.equal(new Set(STOCK.map(p => p.id)).size, STOCK.length);
for (const p of STOCK) {
  assert.ok([16, 32, 64].includes(p.length), `${p.name}: length ${p.length}`);
  assert.deepEqual(cleanPattern(p, { length: p.length, onlyBelow: p.length }).steps, p.steps, `${p.name} is clean`);
  assert.ok(p.steps.length > 0, p.name);
  if (p.key) assert.ok(p.steps.every(s => s.notes.every(n => inScale(n, p.key))), `${p.name}: notes outside ${p.key.type}`);
  if (p.mode === 'pool') assert.ok(p.steps.every(s => !s.notes.length), p.name);
}

// ---- engine ----
// Runs the engine against a fake clock and records what it sends.
function run(song, { ms, mode = 'loop', pool = () => [] } = {}) {
  let t = 1000;
  const out = { notes: [], clocks: [], steps: [], bars: [] };
  const e = new Engine({
    song: () => song, now: () => t, pool, rng: () => 0,
    sink: {
      note: (ti, note, vel, at, dur) => out.notes.push({ ti, note, vel, at: at - 1040, dur }),
      clock: at => out.clocks.push(at - 1040),
      step: (ti, pos, pattern, at, silent) => out.steps.push({ ti, pos, pattern, silent }),
      bar: (section, bar) => out.bars.push([section, bar]),
    },
  });
  e.mode = mode;
  e.play();
  for (; t < 1000 + ms; t += 25) e.pump();
  e.stop();
  return out;
}

{
  // 120 BPM: a 16th is 125 ms; clock pulses every 125/6 ms.
  const song = newSong();
  const A = song.tracks[0].patterns.A;
  putStep(A, 0, { notes: [36], vel: 100, gate: 50, len: 1 });
  putStep(A, 4, { notes: [48, 51], vel: 90, gate: 100, len: 2 });
  const r = run(song, { ms: 2000 });
  const firstBar = r.notes.filter(n => n.at < 2000);
  assert.deepEqual(firstBar.map(n => [n.note, Math.round(n.at)]), [[36, 0], [48, 500], [51, 500]]);
  near(firstBar[0].dur, 62.5 - 2, '50% gate');
  near(firstBar[1].dur, 250 - 2, 'held two steps at 100%');
  assert.ok(r.notes.some(n => n.note === 36 && Math.round(n.at) === 2000), 'pattern loops after 16 steps');
  near(r.clocks[1] - r.clocks[0], 125 / 6, 'clock spacing');
  // Nothing is scheduled more than the look-ahead past the last pump.
  assert.ok(Math.max(...r.notes.map(n => n.at)) <= 2000 + 120 + 40);
}

{
  // Swing 75% pushes every second 16th by half a step.
  const song = newSong();
  song.swing = 75;
  const A = song.tracks[0].patterns.A;
  for (let i = 0; i < 4; i++) putStep(A, i, { notes: [60 + i] });
  const r = run(song, { ms: 600 });
  assert.deepEqual(r.notes.slice(0, 4).map(n => Math.round(n.at)), [0, 188, 250, 438]);
}

{
  // Odd lengths loop on their own; rates change step spacing.
  const song = newSong();
  addTrack(song);
  song.tracks[0].patterns.A = { length: 3, steps: [{ i: 0, notes: [40], vel: 100, gate: 50, len: 1 }] };
  song.tracks[1].rate = '1/8';
  putStep(song.tracks[1].patterns.A, 1, { notes: [70] });
  const r = run(song, { ms: 1100 });
  const times = ti => r.notes.filter(n => n.ti === ti && n.at < 1000).map(n => Math.round(n.at));
  assert.deepEqual(times(0), [0, 375, 750]);
  assert.deepEqual(times(1), [250]);
}

{
  // Song mode: sections switch patterns per track at bar lines, and null tracks stay silent.
  const song = newSong();
  addTrack(song);
  const [t0, t1] = song.tracks;
  putStep(t0.patterns.A, 0, { notes: [36] });
  putStep(t0.patterns.B, 0, { notes: [38] });
  putStep(t1.patterns.A, 0, { notes: [60] });
  song.song = [{ bars: 1, play: ['A', null] }, { bars: 2, play: ['B', 'A'] }];
  const r = run(song, { ms: 8100, mode: 'song' });
  const at = (ti) => r.notes.filter(n => n.ti === ti).map(n => [n.note, Math.round(n.at / 2000)]);
  assert.deepEqual(at(0), [[36, 0], [38, 1], [38, 2], [36, 3], [38, 4]]);
  assert.deepEqual(at(1), [[60, 1], [60, 2], [60, 4]]);
  assert.deepEqual(r.bars.slice(0, 4), [[0, 0], [1, 0], [1, 1], [0, 0]]);
}

{
  // Loop mode: a queued pattern switches at the next bar, not immediately.
  const song = newSong();
  const t = song.tracks[0];
  putStep(t.patterns.A, 0, { notes: [36] });
  putStep(t.patterns.A, 8, { notes: [36] });
  putStep(t.patterns.B, 0, { notes: [50] });
  let queued = false;
  const out = [];
  let now = 1000;
  const e = new Engine({ song: () => song, now: () => now, sink: { note: (ti, n, v, at) => out.push([n, Math.round(at - 1040)]) } });
  e.play();
  for (; now < 5100; now += 25) {
    if (!queued && now > 1600) { e.queue(0, 'B'); queued = true; }
    e.pump();
  }
  assert.deepEqual(out, [[36, 0], [36, 1000], [50, 2000], [50, 4000]]);
}

{
  // Note pool: each step that fires takes the next note; muted tracks send nothing.
  const song = newSong();
  const t = song.tracks[0];
  t.mode = 'pool';
  t.pool.order = 'up';
  for (const i of [0, 2, 3, 6]) putStep(t.patterns.A, i, { notes: [] });
  const r = run(song, { ms: 1000, pool: () => [67, 60, 63] });
  assert.deepEqual(r.notes.map(n => n.note), [60, 63, 67, 60]);
  t.mute = true;
  assert.equal(run(song, { ms: 1000, pool: () => [60] }).notes.length, 0);
  t.mute = false;
  assert.equal(run(song, { ms: 1000, pool: () => [] }).notes.length, 0, 'empty pool plays nothing');
}

{
  // Tempo changes apply from the next unscheduled note, without a jump.
  const song = newSong();
  for (let i = 0; i < 16; i++) putStep(song.tracks[0].patterns.A, i, { notes: [60] });
  let t = 1000;
  const at = [];
  const e = new Engine({ song: () => song, now: () => t, sink: { note: (ti, n, v, a) => at.push(a) } });
  e.play();
  for (; t < 1500; t += 25) e.pump();
  song.bpm = 60;
  for (; t < 3000; t += 25) e.pump();
  const gaps = at.slice(1).map((a, k) => Math.round(a - at[k]));
  assert.ok(gaps.slice(0, 3).every(g => g === 125), gaps.join());
  assert.ok(gaps.slice(-3).every(g => g === 250), gaps.join());
  // The change lands on the next clock pulse, so at most one gap is part old tempo, part new.
  assert.ok(gaps.filter(g => g !== 125 && g !== 250).length <= 1 && gaps.every(g => g >= 125 && g <= 250), gaps.join());
}


{
  // positionAt: which step a key press at a given moment belongs to.
  const song = newSong();
  let t = 1000;
  const e = new Engine({ song: () => song, now: () => t });
  e.play(); // first step at 1040 ms; a 1/16 step at 120 BPM is 125 ms
  for (; t < 2000; t += 25) e.pump();
  const p = e.positionAt(0, 1040 + 125 * 5 + 30);
  assert.equal(p.pattern, 'A');
  near(p.step, 5.24, 'step at a time');
  near(e.positionAt(0, 1040 + 125 * 16 - 20).step, 15.84, 'wraps to the pattern');
  near(e.tickAt(1040 + 500), 96, 'tick at a time');
}


// ---- chance, ratchets, controller lanes ----
{
  const p = cleanPattern({ length: 8, steps: [{ i: 0, notes: [60], prob: 50, rat: 3 }, { i: 2, notes: [62], prob: 100, rat: 1 }, { i: 4, notes: [64], prob: 0, rat: 9 }],
    cc: [{ cc: 74, glide: 1, steps: [{ i: 0, v: 0 }, { i: 4, v: 200 }, { i: 9, v: 5 }] }, { cc: 74 }, { cc: 300 }] });
  assert.deepEqual(p.steps[0], { i: 0, notes: [60], vel: 100, gate: 60, len: 1, prob: 50, rat: 3 });
  assert.deepEqual(p.steps[1], { i: 2, notes: [62], vel: 100, gate: 60, len: 1 }, 'defaults are left out');
  assert.deepEqual([p.steps[2].prob, p.steps[2].rat], [1, 4]);
  assert.deepEqual(p.cc, [{ cc: 74, glide: true, steps: [{ i: 0, v: 0 }, { i: 4, v: 127 }, { i: 9, v: 5 }] }]);
  assert.equal(cleanPattern({ steps: [] }).cc, undefined);
  const c = copyPattern(p);
  c.cc[0].steps[0].v = 99;
  assert.equal(p.cc[0].steps[0].v, 0, 'copy is deep');

  const lane = { cc: 74, glide: false, steps: [{ i: 0, v: 0 }, { i: 4, v: 100 }] };
  assert.equal(laneValue(lane, 4, 8), 100);
  assert.equal(laneValue(lane, 2, 8), null, 'without glide, only set steps send');
  lane.glide = true;
  assert.equal(laneValue(lane, 2, 8), 50, 'halfway up');
  assert.equal(laneValue(lane, 6, 8), 50, 'and back down, wrapping to step 0');
  assert.equal(laneValue(lane, 7.5, 8), 13);
  assert.equal(laneValue({ cc: 1, glide: true, steps: [{ i: 3, v: 40 }] }, 0, 8), 40, 'one point holds');
  assert.equal(laneValue({ cc: 1, glide: true, steps: [{ i: 12, v: 40 }] }, 0, 8), null, 'points past the end are ignored');
}
{
  // Engine: a 50% step plays about half the time; ratchets split the note; lanes send CCs.
  const song = newSong();
  const t = song.tracks[0];
  t.patterns.A.length = 4;
  putStep(t.patterns.A, 0, { notes: [60], prob: 50 });
  putStep(t.patterns.A, 2, { notes: [62], len: 2, gate: 50, rat: 4 });
  t.patterns.A.cc = [{ cc: 74, glide: true, steps: [{ i: 0, v: 0 }, { i: 2, v: 80 }] }];
  let now = 0, rng = 0;
  const notes = [], ccs = [];
  const e = new Engine({ song: () => song, now: () => now, rng: () => (rng = (rng + 0.37) % 1),
    sink: { note: (ti, n, v, at, dur) => notes.push({ n, at: at - 40, dur }), cc: (ti, c, v, at) => ccs.push([c, v, at - 40]) } });
  e.play();
  for (; now < 8000; now += 25) e.pump(); // 16 loops of the 4-step pattern (500 ms each at 120 BPM)
  const c4 = notes.filter(x => x.n === 60).length;
  assert.ok(c4 >= 5 && c4 <= 11, `50% step played ${c4} of 16 times`);
  const rolls = notes.filter(x => x.n === 62 && x.at < 500).map(x => Math.round(x.at));
  assert.deepEqual(rolls, [250, 313, 375, 438], 'four repeats across two steps');
  near(notes.find(x => x.n === 62).dur, 62.5 * 0.5 - 2, 'gate applies to each repeat');
  const first = ccs.filter(x => x[2] < 500);
  assert.deepEqual(first.map(x => x[1]), [0, 10, 20, 30, 40, 50, 60, 70, 80, 70, 60, 50, 40, 30, 20, 10], 'glides up and back');
  assert.ok(first.every(x => x[0] === 74));
}

{
  // halt(): no new notes, but stop() afterwards still tells the sink.
  const song = newSong();
  for (let i = 0; i < 16; i++) putStep(song.tracks[0].patterns.A, i, { notes: [60] });
  let t = 0, notes = 0, stops = 0;
  const e = new Engine({ song: () => song, now: () => t, sink: { note: () => notes++, stop: () => stops++ } });
  e.play();
  for (; t < 500; t += 25) e.pump();
  e.halt();
  const n = notes;
  for (; t < 1500; t += 25) e.pump();
  assert.equal(notes, n, 'no notes after halt');
  e.stop();
  assert.equal(stops, 1, 'stop after halt still stops');
}

// ---- MIDI files ----
{
  const bytes = writeMidi({ name: 'Test', bpm: 125, tracks: [
    { name: 'Bass', ch: 2, program: 5, notes: [{ tick: 0, dur: 48, note: 36, vel: 100 }, { tick: 48, dur: 48, note: 36, vel: 90 }] },
    { name: 'Lead', ch: 3, notes: [{ tick: 96, dur: 200, note: 72, vel: 127 }] }] });
  const m = readMidi(bytes);
  assert.equal(m.division, 96);
  assert.equal(m.tempo, 480000);
  assert.deepEqual(m.tracks.map(x => x.name), ['Test', 'Bass', 'Lead']);
  assert.deepEqual(m.tracks[1].notes, [{ tick: 0, note: 36, vel: 100, ch: 2, dur: 48 }, { tick: 48, note: 36, vel: 90, ch: 2, dur: 48 }],
    'a repeated note is not cut short');
  assert.equal(m.tracks[2].notes[0].dur, 200);
}
{
  // renderSong follows the sections, swing and note pools, and ignores mute.
  const song = newSong();
  song.swing = 75;
  const t = song.tracks[0];
  t.patterns.A.length = t.patterns.B.length = 4;
  putStep(t.patterns.A, 0, { notes: [36], len: 2, gate: 50 });
  putStep(t.patterns.A, 1, { notes: [38] });
  putStep(t.patterns.B, 0, { notes: [40] });
  t.mute = true;
  addTrack(song);
  const p = song.tracks[1];
  p.mode = 'pool'; p.pool.notes = [60, 64]; p.pool.order = 'up';
  putStep(p.patterns.A, 0, { notes: [] }); putStep(p.patterns.A, 8, { notes: [] });
  song.song = [{ bars: 1, play: ['A', 'A'] }, { bars: 1, play: ['B', null] }];
  const r = renderSong(song);
  assert.equal(r.bars, 2);
  const bass = r.tracks[0].notes;
  assert.equal(bass.filter(n => n.note === 36).length, 4, 'pattern A loops through bar 1');
  assert.deepEqual(bass.slice(0, 2).map(n => [n.tick, n.note]), [[0, 36], [36, 38]], 'swung 16th at 75%');
  assert.equal(bass[0].dur, 12, 'gate 50% of a step (step 1 cut the hold short)');
  assert.deepEqual(bass.filter(n => n.note === 40).map(n => n.tick), [384, 480, 576, 672], 'section 2 plays B');
  assert.deepEqual(r.tracks[1].notes.map(n => [n.tick, n.note]), [[0, 60], [192, 64]], 'pool walks up, silent in section 2');
  const back = readMidi(writeMidi(r));
  assert.equal(back.tracks.length, 3);
  // Controller lanes go into the file too.
  t.patterns.A.cc = [{ cc: 74, glide: false, steps: [{ i: 0, v: 10 }] }];
  const withCC = readMidi(writeMidi(renderSong(song)));
  assert.deepEqual(withCC.tracks[1].ccs.map(c => [c.tick, c.cc, c.v]), [[0, 74, 10], [96, 74, 10], [192, 74, 10], [288, 74, 10]]);
  assert.equal(back.tracks[1].notes.length, bass.length);
}

// ---- capture ----
{
  const ev = (t, type, n, v = 100, extra = {}) => ({ t, type, n, v, ...extra });
  // Pedal holds released notes; a take ends after 4 s of silence.
  const events = [
    ev(0, 'on', 60), ev(100, 'ped', 1), ev(200, 'off', 60), ev(300, 'on', 64), ev(400, 'off', 64), ev(1000, 'ped', 0),
    ev(1200, 'on', 67), ev(1500, 'off', 67),
    ev(6000, 'on', 72), // second take, still held
  ];
  const notes = notesOf(events, 6500);
  assert.deepEqual(notes.map(n => [n.note, n.t, n.dur]), [[60, 0, 1000], [64, 300, 700], [67, 1200, 300], [72, 6000, 1]]);
  assert.ok(notes[3].open);
  const takes = splitTakes(notes);
  assert.equal(takes.length, 2);
  assert.equal(takes[0].end, 1500);
  assert.ok(!takes[0].synced && takes[1].open);

  // Free playing: tempo from the note starts, first note on beat 1.
  const bpm = 96, beat = 60000 / bpm;
  const riff = [0, 0.5, 1, 1.75, 2, 3, 3.5, 4, 4.5, 5, 5.75, 6, 7].map((b, k) => ev(b * beat + (k % 3) * 6, 'on', 48 + k % 5));
  const offs = riff.map(e => ev(e.t + beat * 0.4, 'off', e.n));
  const free = splitTakes(notesOf([...riff, ...offs].sort((a, b) => a.t - b.t)))[0];
  assert.equal(estimateTempo(free.notes, 120), 96);
  const items = takeTicks(free, 96);
  const pat = takeToPattern(items, 24);
  assert.equal(pat.length, 32, 'two bars of 16ths');
  assert.deepEqual(pat.steps.map(s => s.i), [0, 2, 4, 7, 8, 12, 14, 16, 18, 20, 23, 24, 28]);
  assert.deepEqual(pat.steps[0], { i: 0, notes: [48], vel: 100, gate: 60, len: 2 }, '0.4 beat = 1.6 steps');
  assert.equal(takeToPattern(items, 48, { fromBar: 1 }).steps[0].i, 0, 'from bar 2');
  assert.equal(barsPerPattern(24), 4);
  assert.equal(barsPerPattern(12), 2);

  // Played along with the sequencer: placed by its ticks, in the bar it was played in.
  const sync = (t, type, n, tick) => ev(t, type, n, 100, { tick, run: 1, bpm: 120 });
  const along = splitTakes(notesOf([sync(0, 'on', 60, 384 + 95), sync(100, 'off', 60, 384 + 120), sync(500, 'on', 62, 384 + 192), sync(600, 'off', 62, 384 + 216)]))[0];
  assert.ok(along.synced);
  assert.deepEqual(takeToPattern(takeTicks(along), 24).steps.map(s => [s.i, s.notes[0], s.len]), [[4, 60, 1], [8, 62, 1]]);
  assert.deepEqual(takeMidiNotes(along).map(n => n.tick), [95, 192]);
  // A performance range keeps a long rest inside one take.
  const perf = splitTakes(notesOf([ev(0, 'on', 60), ev(100, 'off', 60), ev(9000, 'on', 62), ev(9100, 'off', 62), ev(20000, 'on', 64), ev(20100, 'off', 64)]),
    4000, [{ start: -10, end: 9500, kind: 'performance' }]);
  assert.deepEqual(perf.map(t => [t.notes.length, t.kind]), [[2, 'performance'], [1, undefined]]);
  assert.equal(perf[0].id, -10);
  // Played across two runs: not synced.
  assert.ok(!splitTakes(notesOf([sync(0, 'on', 60, 10), { ...sync(50, 'on', 62, 10), run: 2 }]))[0].synced);
}

console.log('ok — sequencer model and engine');
