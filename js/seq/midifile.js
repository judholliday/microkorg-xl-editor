// Standard MIDI Files (.mid), for taking songs and captured playing into a DAW such as Ableton Live.
// No DOM here. Times are in ticks at 96 per beat, the sequencer's own resolution, so the file's
// division is 96 and nothing needs scaling.
import { TICKS_PER_BEAT, TICKS_PER_BAR } from './model.js';
import { Engine } from './engine.js';

// Writes a type-1 file: a tempo track, then one track per entry in `tracks`.
//   { name, bpm, tracks: [{ name, ch (1-16), program?, notes: [{ tick, dur, note, vel }], ccs?: [{ tick, cc, v }] }] }
export function writeMidi({ name = '', bpm, tracks }) {
  const chunks = [chunk('MThd', [0, 1, ...u16(tracks.length + 1), ...u16(TICKS_PER_BEAT)])];
  const usPerBeat = Math.round(60e6 / bpm);
  chunks.push(chunk('MTrk', trackData([
    { tick: 0, data: meta(0x03, text(name)) },
    { tick: 0, data: meta(0x58, [4, 2, 24, 8]) }, // 4/4
    { tick: 0, data: meta(0x51, [usPerBeat >> 16 & 255, usPerBeat >> 8 & 255, usPerBeat & 255]) },
  ])));
  for (const t of tracks) {
    const ch = Math.min(15, Math.max(0, (t.ch || 1) - 1));
    const events = [{ tick: 0, data: meta(0x03, text(t.name)) }];
    if (Number.isInteger(t.program)) events.push({ tick: 0, data: [0xc0 | ch, t.program] });
    for (const c of t.ccs || []) events.push({ tick: Math.max(0, Math.round(c.tick)), data: [0xb0 | ch, c.cc, c.v] });
    for (const n of t.notes) {
      const tick = Math.max(0, Math.round(n.tick));
      events.push({ tick, data: [0x90 | ch, n.note, Math.min(127, Math.max(1, n.vel))] });
      events.push({ tick: tick + Math.max(1, Math.round(n.dur)), off: true, data: [0x80 | ch, n.note, 0] });
    }
    chunks.push(chunk('MTrk', trackData(events)));
  }
  return Uint8Array.from(chunks.flat());
}

// Note-offs go before note-ons at the same tick, so a repeated note isn't cut short.
function trackData(events) {
  events.sort((a, b) => a.tick - b.tick || (b.off ? 1 : 0) - (a.off ? 1 : 0));
  const out = [];
  let last = 0;
  for (const e of events) { out.push(...vlq(e.tick - last), ...e.data); last = e.tick; }
  out.push(0, 0xff, 0x2f, 0); // end of track
  return out;
}

const u16 = n => [n >> 8 & 255, n & 255];
const u32 = n => [n >>> 24 & 255, n >> 16 & 255, n >> 8 & 255, n & 255];
const chunk = (id, data) => [...[...id].map(c => c.charCodeAt(0)), ...u32(data.length), ...data];
const meta = (type, data) => [0xff, type, ...vlq(data.length), ...data];
// Names as Latin-1 (what DAWs expect); anything else becomes '?'.
const text = s => [...String(s)].map(c => c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 63);
function vlq(n) {
  const bytes = [n & 127];
  while ((n >>= 7)) bytes.unshift((n & 127) | 128);
  return bytes;
}

// Plays the song's sections once through the real engine against a fake clock and collects the
// notes, so swing, note pools and pattern lengths come out exactly as they sound. Every track is
// included, muted or not (mute them in the DAW instead).
export function renderSong(song, { seed = 1 } = {}) {
  const copy = { ...song, tracks: song.tracks.map(t => ({ ...t, mute: false, solo: false })) };
  const out = copy.tracks.map(() => []), ccs = copy.tracks.map(() => []);
  let now = 0, t0 = 0;
  const tickMs = 60000 / (song.bpm * TICKS_PER_BEAT);
  const engine = new Engine({
    song: () => copy, now: () => now, pool: ti => copy.tracks[ti].pool.notes, rng: seeded(seed),
    sink: {
      start(at) { t0 = at; },
      note(ti, note, vel, at, dur) { out[ti].push({ tick: (at - t0) / tickMs, dur: dur / tickMs, note, vel }); },
      cc(ti, cc, v, at) { ccs[ti].push({ tick: Math.round((at - t0) / tickMs), cc, v }); },
    },
  });
  engine.mode = 'song';
  engine.play();
  const bars = copy.song.reduce((n, s) => n + s.bars, 0);
  const end = bars * TICKS_PER_BAR;
  const endMs = t0 + end * tickMs;
  while (now < endMs) { now += 500; engine.pump(); }
  engine.stop();
  return {
    name: song.name, bpm: song.bpm, bars,
    tracks: copy.tracks.map((t, ti) => ({
      name: t.name, ch: t.ch, program: t.program,
      notes: out[ti].filter(n => Math.round(n.tick) < end)
        .map(n => ({ ...n, tick: Math.round(n.tick), dur: Math.min(Math.round(n.dur), end - Math.round(n.tick)) })),
      ccs: ccs[ti].filter(c => c.tick < end),
    })),
  };
}

function seeded(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 2 ** 32; };
}

// Reads back a file written by writeMidi (for the tests): { division, tempo, tracks: [{ name, notes }] }.
export function readMidi(bytes) {
  let p = 0;
  const str = n => String.fromCharCode(...bytes.slice(p, p += n));
  const num = n => { let v = 0; for (let k = 0; k < n; k++) v = v * 256 + bytes[p++]; return v; };
  const readVlq = () => { let v = 0, b; do { b = bytes[p++]; v = v * 128 + (b & 127); } while (b & 128); return v; };
  if (str(4) !== 'MThd') throw new Error('not a MIDI file');
  const hlen = num(4), start = p;
  num(2); const ntrks = num(2), division = num(2);
  p = start + hlen;
  const res = { division, tempo: null, tracks: [] };
  for (let k = 0; k < ntrks; k++) {
    if (str(4) !== 'MTrk') throw new Error('bad track');
    const end = num(4) + p;
    const track = { name: '', notes: [], ccs: [] }, open = new Map();
    let tick = 0, status = 0;
    while (p < end) {
      tick += readVlq();
      if (bytes[p] & 128) status = bytes[p++];
      if (status === 0xff) {
        const type = bytes[p++], len = readVlq(), data = bytes.slice(p, p += len);
        if (type === 0x03) track.name = String.fromCharCode(...data);
        if (type === 0x51) res.tempo = data[0] << 16 | data[1] << 8 | data[2];
      } else {
        const type = status & 0xf0, a = bytes[p++], b = type === 0xc0 || type === 0xd0 ? 0 : bytes[p++];
        if (type === 0xb0) track.ccs.push({ tick, cc: a, v: b });
        else if (type === 0x90 && b > 0) open.set(a, { tick, note: a, vel: b, ch: (status & 15) + 1 });
        else if (type === 0x80 || type === 0x90) {
          const n = open.get(a);
          if (n) { track.notes.push({ ...n, dur: tick - n.tick }); open.delete(a); }
        }
      }
    }
    track.notes.sort((x, y) => x.tick - y.tick || x.note - y.note);
    res.tracks.push(track);
  }
  return res;
}
