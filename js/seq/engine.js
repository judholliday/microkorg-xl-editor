// The sequencer's clock. It walks a song in ticks (96 per beat) and hands every note to a "sink"
// slightly ahead of time with an exact timestamp, so JavaScript timer jitter doesn't reach the
// music: Web MIDI and Web Audio both play events at the timestamp they're given.
//
// The engine has no DOM or MIDI code. The page supplies:
//   song()      the current song (read live, so edits take effect while playing)
//   now()       the current time in ms (performance.now() in the browser)
//   pool(ti)    the notes a note-pool track should walk through right now
//   sink        { note(ti, note, vel, atMs, durMs), cc(ti, controller, value, atMs), clock(atMs), start(atMs), stop(atMs),
//                 step(ti, pos, pattern, atMs, silent, notes), bar(section, barInSection, atMs) }
// and calls pump() every ~25 ms while playing.
import { TICKS_PER_BAR, CLOCK_TICKS, RATES, SWUNG_RATES, stepAt, noteSteps, poolOrder, audible, laneValue } from './model.js';

export const LOOKAHEAD_MS = 120;
const START_DELAY_MS = 40; // so the first notes aren't already late when they're sent

export class Engine {
  constructor({ song, now, pool = () => [], sink = {}, rng = Math.random, lookahead = LOOKAHEAD_MS }) {
    Object.assign(this, { song, now, pool, sink, rng, lookahead });
    this.playing = false;
    this.mode = 'loop'; // 'loop': each track loops its own pattern; 'song': follow the song sections
    this.queued = new Map(); // track index -> pattern to switch to at the next bar (loop mode)
  }

  get tickMs() { return 60000 / (this.anchor.bpm * 96); }
  tickTime(tick) { return this.anchor.ms + (tick - this.anchor.tick) * this.tickMs; }

  // `delay` (ms) holds off the first beat, e.g. for a count-in. Returns when the first beat sounds.
  play({ delay = 0 } = {}) {
    const song = this.song();
    const t0 = this.now() + START_DELAY_MS + delay;
    this.anchor = { tick: 0, ms: t0, bpm: song.bpm };
    this.section = 0;
    this.secBar = -1;
    this.enterSong = this.mode === 'song';
    this.nextBar = 0;
    this.nextClock = 0;
    this.tracks = song.tracks.map(t => this.trackState(t, 0));
    this.queued.clear();
    this.playing = true;
    this.sink.start?.(t0);
    this.pump();
    return t0;
  }

  stop() {
    if (!this.playing && !this.halted) return;
    this.playing = false;
    this.halted = false;
    this.queued.clear();
    this.sink.stop?.(this.now());
  }

  // Stops scheduling new notes but leaves sounding ones to finish (e.g. at the end of a
  // recording, so the last notes' release is kept). Call stop() afterwards.
  halt() { if (this.playing) { this.playing = false; this.halted = true; this.queued.clear(); } }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    if (mode === 'song') this.enterSong = true; // starts at section 1 on the next bar
  }

  // Loop mode: switch a track's pattern at the next bar while playing.
  queue(ti, pattern) { this.queued.set(ti, pattern); }

  // The song position (in ticks, fractional) at a time in ms, while playing.
  tickAt(ms) { return this.anchor.tick + (ms - this.anchor.ms) / this.tickMs; }

  // Where a track is at a time in ms (e.g. when a key was pressed): its pattern, the step there
  // (fractional, wrapped to the pattern's length) and a step's length in ms. Null if it's silent.
  positionAt(ti, ms) {
    const ts = this.tracks?.[ti], track = this.song().tracks[ti];
    if (!this.playing || !ts || ts.silent || !track) return null;
    const rate = RATES[track.rate], len = track.patterns[ts.pattern].length;
    const step = ts.pos - (ts.next - this.tickAt(ms)) / rate;
    return { pattern: ts.pattern, step: (step % len + len) % len, stepMs: rate * this.tickMs };
  }

  trackState(track, tick) {
    return { pattern: track.pattern, pos: 0, next: tick, silent: false, poolIdx: -1 };
  }

  pump() {
    if (!this.playing) return;
    const song = this.song();
    // Tracks added or removed while playing join at the next bar.
    while (this.tracks.length < song.tracks.length) {
      this.tracks.push({ ...this.trackState(song.tracks[this.tracks.length], this.nextBar) });
    }
    this.tracks.length = song.tracks.length;

    // A tempo change takes effect from the next unscheduled event.
    if (song.bpm !== this.anchor.bpm) {
      const tick = this.frontier();
      this.anchor = { tick, ms: this.tickTime(tick), bpm: song.bpm };
    }

    const horizon = this.now() + this.lookahead;
    for (let guard = 0; guard < 10000; guard++) {
      const tick = this.frontier();
      if (this.tickTime(tick) > horizon) break;
      if (tick === this.nextBar) { this.bar(song, tick); this.nextBar += TICKS_PER_BAR; continue; }
      this.tracks.forEach((ts, ti) => { if (ts.next === tick) this.step(song, ti, ts); });
      if (tick === this.nextClock) { this.sink.clock?.(this.tickTime(tick)); this.nextClock += CLOCK_TICKS; }
    }
  }

  frontier() { return Math.min(this.nextBar, this.nextClock, ...this.tracks.map(t => t.next)); }

  bar(song, tick) {
    this.secBar++;
    if (this.mode === 'song') {
      if (this.enterSong) { this.enterSong = false; this.enterSection(song, 0, tick); }
      else if (this.secBar >= song.song[this.section].bars) this.enterSection(song, (this.section + 1) % song.song.length, tick);
    } else {
      for (const [ti, pattern] of this.queued) {
        const ts = this.tracks[ti];
        if (ts) Object.assign(ts, { pattern, pos: 0, next: tick, silent: false, poolIdx: -1 });
      }
      this.queued.clear();
      // Coming back from song mode, un-silence tracks.
      this.tracks.forEach((ts, ti) => { if (ts.silent) Object.assign(ts, { silent: false, pattern: song.tracks[ti].pattern, pos: 0, next: tick }); });
    }
    this.sink.bar?.(this.section, this.secBar, this.tickTime(tick));
  }

  enterSection(song, index, tick) {
    this.section = index;
    this.secBar = 0;
    const sec = song.song[index];
    this.tracks.forEach((ts, ti) => {
      const p = sec.play[ti];
      Object.assign(ts, { silent: p === null, pos: 0, next: tick, poolIdx: -1 });
      if (p) ts.pattern = p;
    });
  }

  step(song, ti, ts) {
    const track = song.tracks[ti];
    const pat = track.patterns[ts.pattern];
    const rate = RATES[track.rate];
    const stepMs = rate * this.tickMs;
    if (ts.pos >= pat.length) ts.pos = 0;
    let at = this.tickTime(ts.next);
    // Swing delays every second step: 50% is straight, 66% a triplet feel, 75% dotted.
    if (SWUNG_RATES.has(track.rate) && Math.floor(ts.next / rate) % 2 === 1) at += (song.swing / 100 - 0.5) * 2 * stepMs;

    const step = ts.silent ? null : stepAt(pat, ts.pos);
    // A step with a chance below 100% plays only that often.
    const s = step && (!step.prob || this.rng() * 100 < step.prob) ? step : null;
    let notes = [];
    if (s) {
      notes = s.notes;
      if (track.mode === 'pool') {
        const list = poolOrder(this.pool(ti), track.pool.order);
        if (!list.length) notes = [];
        else if (track.pool.order === 'random') notes = [list[Math.floor(this.rng() * list.length)]];
        else { ts.poolIdx = (ts.poolIdx + 1) % list.length; notes = [list[ts.poolIdx]]; }
      }
      if (audible(song, ti)) {
        // End a hair early so a note at 100% gate is off before the next one on the same key.
        const rat = s.rat || 1;
        if (rat === 1) {
          const dur = Math.max(5, noteSteps(s, pat.length) * stepMs - 2);
          for (const n of notes) this.sink.note?.(ti, n, s.vel, at, dur);
        } else {
          // A ratchet repeats the note evenly across its length; gate applies to each repeat.
          const each = Math.max(1, Math.min(s.len, pat.length - s.i)) * stepMs / rat;
          const dur = Math.max(5, each * s.gate / 100 - 2);
          for (let r = 0; r < rat; r++) for (const n of notes) this.sink.note?.(ti, n, s.vel, at + r * each, dur);
        }
      }
    }
    if (pat.cc && !ts.silent && audible(song, ti)) this.lanes(ti, ts, pat, at, stepMs);
    this.sink.step?.(ti, ts.pos, ts.pattern, at, ts.silent, notes);
    ts.pos = (ts.pos + 1) % pat.length;
    ts.next += rate;
  }

  // Controller lanes: a value at each step that sets one; gliding lanes also send four in-between
  // values per step (only when the value changes).
  lanes(ti, ts, pat, at, stepMs) {
    ts.sent ||= {};
    for (const lane of pat.cc) {
      const subs = lane.glide ? 4 : 1;
      for (let k = 0; k < subs; k++) {
        const v = laneValue(lane, ts.pos + k / subs, pat.length);
        if (v === null || (lane.glide && ts.sent[lane.cc] === v)) continue;
        ts.sent[lane.cc] = v;
        this.sink.cc?.(ti, lane.cc, v, at + k * stepMs / subs);
      }
    }
  }
}
