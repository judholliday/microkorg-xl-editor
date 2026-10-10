// The sequencer page: draws the song, handles editing, and connects the engine to MIDI outputs
// and the test synth. No framework. `song` is what gets saved; `views` and `sel` are view state.
import * as M from './model.js';
import { Engine } from './engine.js';
import * as synth from './testsynth.js';
import { demoSong } from './demo.js';
import { randomIdea } from './generate.js';
import { writeMidi, renderSong as songToMidi } from './midifile.js';
import * as C from './capture.js';
import { STOCK } from './stock.js';
import { portLabel, looksLikeSynthIn, looksLikeSynthOut } from '../midiports.js';
import { msg } from '../sysex.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const COLORS = ['#ff6a2b', '#4fc28a', '#6aa9ff', '#c38bff', '#f3b33d', '#ff5fa2', '#3fd0d4', '#b5c94a'];

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('mkxl.seq.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('mkxl.seq.' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
}

// ---------------------------------------------------------------------------------------------
// State

let song;
let fileName = null; // the file in data/sequences/ this song was loaded from or saved to
let dirty = false;
const prefs = { songOpen: true, mode: 'loop', follow: true, soundFollows: true, keysIn: null, thru: true, clockOut: [], collapsed: [], capOpen: true, ...store.get('prefs', {}) };
const savePrefs = () => store.set('prefs', prefs);
let views = []; // per track: { pat (pattern shown), page, collapsed, kbdLow, lastNote }
let sel = { t: 0, i: 0, open: true };
let clipboard = null;
const live = { pos: [], pattern: [], silent: [], poolNote: [], section: 0, bar: 0, bars: 0, barAt: 0 };
let midi = null;
let sysexOk = false; // SysEx is needed to send XL sounds

function syncViews() {
  while (views.length < song.tracks.length) {
    const ti = views.length;
    views.push({ pat: song.tracks[ti].pattern, page: 0, collapsed: !!prefs.collapsed[ti], kbdLow: 36, lastNote: 48, ai: newAi(), ideas: newIdeas(), lib: newLib() });
  }
  views.length = song.tracks.length;
  views.forEach((v, ti) => { v.page = Math.min(v.page, pages(ti) - 1); });
  if (sel.t >= song.tracks.length) sel = { t: 0, i: 0, open: sel.open };
}

const viewPattern = ti => song.tracks[ti].patterns[views[ti].pat];
const pageSize = ti => viewPattern(ti).length <= 16 ? 16 : 32;
const pages = ti => Math.ceil(viewPattern(ti).length / pageSize(ti));

// ---- undo, autosave ----
const undoStack = [], redoStack = [];
let snapshot = null, lastPush = 0, saveTimer = null;

// Call after every edit. Quick repeated edits (dragging a slider) share one undo step, and so do
// all the notes recorded in one run (coalesce: 'rec').
function changed({ coalesce = false } = {}) {
  const now = performance.now();
  if (coalesce === 'rec' ? !rec.pushed : !coalesce || now - lastPush > 800) {
    if (coalesce === 'rec') rec.pushed = true;
    undoStack.push(snapshot);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    lastPush = now;
  }
  snapshot = JSON.stringify(song);
  dirty = true;
  saveWorking();
  renderFileBar();
}

function restore(json) {
  song = M.normalizeSong(JSON.parse(json));
  snapshot = json;
  dirty = true;
  syncViews();
  saveWorking();
  renderAll();
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot); restore(redoStack.pop()); }

// The song being edited is kept in this browser, so a reload never loses work.
function saveWorking() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set('working', { song, fileName, dirty }), 300);
}

function load(raw, file, isDirty = false) {
  if (engine.playing) stop();
  song = M.normalizeSong(raw);
  fileName = file;
  dirty = isDirty;
  views = [];
  sel = { t: 0, i: 0, open: true };
  syncViews();
  snapshot = JSON.stringify(song);
  undoStack.length = redoStack.length = 0;
  liveSound = null;
  saveWorking();
  renderAll();
}

// ---------------------------------------------------------------------------------------------
// MIDI and sound output

const outputs = () => midi ? [...midi.outputs.values()].filter(p => p.state !== 'disconnected') : [];
const inputs = () => midi ? [...midi.inputs.values()].filter(p => p.state !== 'disconnected') : [];
const outPort = name => outputs().find(p => p.name === name) || null;
let clockTargets = [];
const updateClockTargets = () => { clockTargets = outputs().filter(p => prefs.clockOut.includes(p.name)); };

function send(port, data, at) {
  try { port.send(data, at); } catch (e) { console.warn('MIDI send failed', port.name, e); }
}

const sounding = []; // MIDI notes the engine has started, so Stop can silence them
// Track volume → computer-sound gain: 0-100 fades in (100 = normal), 100-127 boosts up to 4×.
const gainOf = t => t.vol <= 100 ? (t.vol / 100) ** 2 : 1 + (t.vol - 100) / 27 * 3;
const sendVolume = (t, port = outPort(t.out)) => { if (port) send(port, [0xb0 | (t.ch - 1), 7, t.vol]); };

const sink = {
  start(at) { for (const p of clockTargets) send(p, [0xfa], at); },
  clock(at) { for (const p of clockTargets) send(p, [0xf8], at); },
  stop() {
    const now = performance.now();
    for (const p of clockTargets) send(p, [0xfc]);
    const channels = new Map();
    for (const s of sounding) {
      if (s.off > now) send(s.port, [0x80 | s.ch, s.note, 0]);
      channels.set(`${s.port.id}:${s.ch}`, s);
    }
    for (const s of channels.values()) send(s.port, [0xb0 | s.ch, 123, 0]); // All Notes Off
    sounding.length = 0;
    synth.stopAll();
  },
  note(ti, note, vel, at, dur) {
    if (skipRecorded(ti, note, at)) return;
    playNote(ti, note, vel, at, dur);
  },
  // Visual updates happen when the sound does, not when it's scheduled.
  step(ti, pos, pattern, at, silent, notes) { later(at, () => showStep(ti, pos, pattern, silent, notes)); },
  bar(section, bar, at) {
    later(at, () => { Object.assign(live, { section, bar, barAt: performance.now() }); live.bars++; paintSong(); });
  },
};
const later = (at, fn) => setTimeout(() => { if (engine.playing) fn(); }, Math.max(0, at - performance.now()));

// Plays one note on a track's output at a time in ms (performance.now() clock).
function playNote(ti, note, vel, at, dur) {
  const t = song.tracks[ti];
  if (t.out === M.COMPUTER) { synth.play(t.voice, note, vel, at, dur, gainOf(t)); return; }
  const port = outPort(t.out);
  if (!port) return;
  const ch = t.ch - 1;
  send(port, [0x90 | ch, note, vel], at);
  send(port, [0x80 | ch, note, 0], at + dur);
  const now = performance.now();
  while (sounding.length && sounding[0].off < now) sounding.shift();
  sounding.push({ port, ch, note, off: at + dur });
}

// Plays a key through the selected track's output; returns a function that stops it.
function noteNow(ti, note, vel) {
  const t = song.tracks[ti];
  if (t.out === M.COMPUTER) return synth.hold(t.voice, note, vel, gainOf(t));
  const port = outPort(t.out);
  if (!port) return () => {};
  const ch = t.ch - 1;
  send(port, [0x90 | ch, note, vel]);
  return () => send(port, [0x80 | ch, note, 0]);
}
function preview(ti, note) {
  const off = noteNow(ti, note, 100);
  setTimeout(off, 250);
}

// ---- Sounds: each XL track remembers its sound; other gear gets a Program Change ----

// Tracks playing the XL itself (its SOUND port), which can carry a whole XL sound.
const isXLOut = name => {
  if (name === M.COMPUTER) return false;
  const p = outPort(name);
  return p ? looksLikeSynthOut(p) : /^(microKORG XL\s*)?SOUND$/i.test(name);
};

// The editor runs alongside (index.html) and tells us what sound it holds; we send it sounds to edit.
const soundChannel = 'BroadcastChannel' in window ? new BroadcastChannel('mkxl') : null;
let editorSound = null; // { name, data } in the Sound Editor now
let liveSound = null; // the track whose sound is on the XL now: edits in the editor are saved to it
const sameSound = (a, b) => !!a && !!b && a.data.length === b.data.length && a.data.every((x, i) => x === b.data[i]);

if (soundChannel) soundChannel.onmessage = e => {
  if (e.data?.type !== 'program') return;
  const sound = M.cleanSound(e.data);
  if (!sound) return;
  const first = !editorSound;
  editorSound = sound;
  const t = song.tracks[liveSound];
  if (t && isXLOut(t.out)) {
    if (!sameSound(t.sound, sound)) { t.sound = sound; changed({ coalesce: true }); renderTrack(liveSound); }
  } else if (first || song.tracks.some(x => isXLOut(x.out) && !x.sound)) renderTracks(); // "Use editor sound (NAME)"
};

// Sends a track's sound to the XL and shows it in the editor; it becomes the live sound.
function sendSound(ti, { show = true } = {}) {
  const t = song.tracks[ti], port = outPort(t.out);
  if (!t.sound) return;
  if (port && sysexOk) send(port, msg.currentProgramDump(t.ch - 1, Uint8Array.from(t.sound.data)));
  if (show) soundChannel?.postMessage({ type: 'show-program', name: t.sound.name, data: t.sound.data });
  editorSound = t.sound;
  const prev = liveSound;
  liveSound = ti;
  if (prev !== null && prev !== ti && song.tracks[prev]) renderTrack(prev);
  renderTrack(ti);
}

// At play: each XL gets one track's sound (it plays one at a time: the live track's, else the
// first audible XL track's). A track with no sound yet remembers the one the editor has.
// Other gear gets each track's Program Change.
function prepareSounds() {
  const done = new Set();
  const order = [liveSound, ...song.tracks.keys()].filter(i => i !== null && song.tracks[i]);
  for (const ti of order) {
    const t = song.tracks[ti];
    if (!isXLOut(t.out) || done.has(t.out) || !M.audible(song, ti)) continue;
    if (!t.sound && editorSound) { t.sound = { ...editorSound }; changed(); }
    if (!t.sound) continue;
    done.add(t.out);
    sendSound(ti);
  }
  for (const t of song.tracks) {
    if (t.out === M.COMPUTER) continue;
    if (t.vol !== 100) sendVolume(t); // left at 100, the instrument's own level is kept
    const port = outPort(t.out);
    if (port && t.program !== null && !isXLOut(t.out)) send(port, [0xc0 | (t.ch - 1), t.program]);
  }
}

const engine = new Engine({ song: () => song, now: () => performance.now(), pool: ti => poolNotes(ti), sink });

// A worker keeps time even when the tab is in the background (page timers get slowed there).
const ticker = new Worker(URL.createObjectURL(new Blob(
  ['let id; onmessage = e => { clearInterval(id); if (e.data) id = setInterval(() => postMessage(0), e.data); };'],
  { type: 'text/javascript' })));
ticker.onmessage = () => engine.pump();

function play() {
  if (engine.playing) return;
  synth.wake();
  updateClockTargets();
  engine.mode = prefs.mode;
  prepareSounds();
  cap.run = Date.now();
  rec.pushed = false;
  Object.assign(live, { pos: [], pattern: [], silent: [], poolNote: [], section: 0, bar: 0, bars: 0, barAt: performance.now() });
  engine.play();
  ticker.postMessage(25);
  $('#play').classList.add('playing');
  requestAnimationFrame(showPosition);
}

function stop() {
  engine.stop();
  ticker.postMessage(0);
  $('#play').classList.remove('playing');
  $('#pos').textContent = '—';
  renderTracks();
  paintSong();
}

function showPosition() {
  if (!engine.playing) return;
  const beat = Math.min(4, Math.floor((performance.now() - live.barAt) / (60000 / song.bpm)) + 1);
  $('#pos').textContent = engine.mode === 'song'
    ? `§${live.section + 1} · bar ${live.bar + 1} · ${beat}`
    : `bar ${Math.max(1, live.bars)} · ${beat}`;
  requestAnimationFrame(showPosition);
}

function showStep(ti, pos, pattern, silent, notes) {
  const v = views[ti];
  if (!v) return;
  const switched = pattern !== live.pattern[ti] || silent !== live.silent[ti];
  live.pos[ti] = pos;
  live.pattern[ti] = pattern;
  live.silent[ti] = silent;
  if (notes.length && song.tracks[ti].mode === 'pool') live.poolNote[ti] = notes[0];
  let redraw = switched; // pattern buttons show which pattern is playing
  if (switched && !silent && (prefs.follow || engine.mode === 'loop') && v.pat !== pattern) { v.pat = pattern; v.page = 0; }
  if (prefs.follow && v.pat === pattern && !v.collapsed) {
    const page = Math.floor(pos / pageSize(ti));
    if (page !== v.page) { v.page = page; redraw = true; }
  }
  if (redraw) renderTrack(ti); else paintPlayhead(ti);
}

// ---- keys in: fill steps, set the note pool, play through ----
const held = []; // notes held on the keyboard (snapped to the scale), in the order pressed
const thru = new Map(); // key -> function that stops it
let entered = false; // notes were entered into a step since all keys were last released

function onKeys(data, at = performance.now()) {
  const type = data[0] & 0xf0;
  if (type === 0x90 && data[2] > 0) keyDown(data[1], data[2], at);
  else if (type === 0x80 || type === 0x90) keyUp(data[1], at);
}

function keyDown(key, vel, at) {
  const n = M.snapToScale(key, song.scale);
  const fresh = held.length === 0;
  if (!held.includes(n)) held.push(n);
  const ti = sel.t, t = song.tracks[ti], v = views[ti];
  if (prefs.thru && !(t.mode === 'pool' && engine.playing)) { thru.get(key)?.(); thru.set(key, noteNow(ti, n, vel)); }
  if (t.mode === 'pool') {
    if (t.pool.latch) {
      t.pool.notes = fresh ? [n] : [...t.pool.notes.filter(x => x !== n), n];
      changed({ coalesce: !fresh });
    }
    renderTrack(ti);
  } else if (rec.on && engine.playing) {
    recordDown(key, n, vel, at);
  } else if (!engine.playing && sel.open) {
    const pat = viewPattern(ti), s = M.stepAt(pat, sel.i);
    const notes = fresh || !s ? [n] : [...new Set([...s.notes, n])].sort((a, b) => a - b);
    M.putStep(pat, sel.i, { notes, vel });
    v.lastNote = n;
    entered = true;
    changed({ coalesce: !fresh });
    renderTrack(ti);
  }
}

function keyUp(key, at) {
  const n = M.snapToScale(key, song.scale);
  const k = held.indexOf(n);
  if (k >= 0) held.splice(k, 1);
  thru.get(key)?.();
  thru.delete(key);
  if (rec.down.has(key)) recordUp(key, at);
  if (held.length) return;
  const t = song.tracks[sel.t];
  if (entered) {
    // Step entry: once all keys are up, move on to the step after this note.
    entered = false;
    const pat = viewPattern(sel.t), s = M.stepAt(pat, sel.i);
    sel.i = (sel.i + (s ? s.len : 1)) % pat.length;
    const v = views[sel.t];
    v.page = Math.floor(sel.i / pageSize(sel.t));
    renderTrack(sel.t);
  } else if (t.mode === 'pool' && !t.pool.latch) renderTrack(sel.t);
}


// ---- recording: while playing with Rec on, keys played go into the selected track ----
// Notes are added to what's there (overdub), at the nearest step, held for as long as the key was.
const rec = { on: false, pushed: false, down: new Map(), longest: new Map(), skip: [] };

function setRec(on) {
  rec.on = on;
  rec.pushed = false;
  rec.down.clear();
  rec.longest.clear();
  $('#rec').classList.toggle('rec-on', on);
  const t = song.tracks[sel.t];
  if (on && t.mode === 'pool') toast('Recording fills in Steps tracks. On a note-pool track, the keys you hold set the pool.');
  else if (on && !prefs.keysIn) toast('Choose your keyboard under Keys in to record.');
  else if (on && !engine.playing) toast(`Rec is on: press Play and play your keyboard to record into ${t.name}.`);
}

function recordDown(key, n, vel, at) {
  const ti = sel.t, t = song.tracks[ti];
  if (t.mode !== 'steps') return;
  const p = engine.positionAt(ti, at);
  if (!p) return;
  const pat = t.patterns[p.pattern], near = Math.round(p.step);
  const i = near % pat.length, s = M.stepAt(pat, i);
  M.putStep(pat, i, { notes: s ? [...new Set([...s.notes, n])].sort((a, b) => a - b) : [n],
    vel: s ? Math.max(s.vel, vel) : vel, gate: s ? s.gate : 90 });
  // Played just ahead of its step: if the engine hasn't scheduled that step yet it would play the
  // note again right after you did, so skip it this once.
  if (near > p.step) rec.skip.push({ ti, note: n, at: at + (near - p.step) * p.stepMs, within: p.stepMs * 0.6 });
  rec.down.set(key, { ti, pattern: p.pattern, i, n, at, stepMs: p.stepMs });
  views[ti].lastNote = n;
  changed({ coalesce: 'rec' });
  renderTrack(ti);
}

function recordUp(key, at) {
  const r = rec.down.get(key);
  rec.down.delete(key);
  const t = song.tracks[r.ti], pat = t?.patterns[r.pattern], s = pat && M.stepAt(pat, r.i);
  if (!s || !s.notes.includes(r.n)) return;
  // A chord's step is held as long as its longest key.
  const id = `${r.ti}:${r.pattern}:${r.i}:${s.notes.join()}`;
  const d = Math.max((at - r.at) / r.stepMs, rec.longest.get(id) || 0);
  rec.longest.set(id, d);
  const len = Math.max(1, Math.round(d));
  M.putStep(pat, r.i, { len, gate: Math.round(Math.min(1, Math.max(0.1, d - (len - 1))) * 100) });
  changed({ coalesce: 'rec' });
  renderTrack(r.ti);
}

function skipRecorded(ti, note, at) {
  const now = performance.now();
  rec.skip = rec.skip.filter(x => x.at > now - 1000);
  const k = rec.skip.findIndex(x => x.ti === ti && x.note === note && Math.abs(x.at - at) < x.within);
  if (k < 0) return false;
  rec.skip.splice(k, 1);
  return true;
}

// Without latch, the selected pool track plays only the keys being held.
function poolNotes(ti) {
  const t = song.tracks[ti];
  return !t.pool.latch && ti === sel.t ? held : t.pool.notes;
}

async function initMidi() {
  if (new URLSearchParams(location.search).has('sim')) await import('../../tools/fakesynth.js');
  if (!navigator.requestMIDIAccess) { status('No Web MIDI · computer sound only', 'warn'); return; }
  try {
    midi = await navigator.requestMIDIAccess({ sysex: true });
    sysexOk = true;
  } catch {
    try { midi = await navigator.requestMIDIAccess(); } catch { /* blocked entirely */ }
    if (!midi) {
      status('MIDI blocked · computer sound only', 'err');
      toast('MIDI access was blocked. Allow MIDI for this page in Chrome\'s site settings and reload. The computer test sound still works.', 'err');
      return;
    }
    toast('SysEx is blocked, so XL sounds can\'t be sent with tracks. Notes still play.', 'err');
  }
  midi.onstatechange = () => { wireInputs(); renderPorts(); renderTracks(); renderCapture(); };
  wireInputs();
  renderPorts();
  renderTracks();
}

const wired = new WeakSet();
function wireInputs() {
  for (const input of inputs()) {
    if (wired.has(input)) continue;
    wired.add(input);
    input.addEventListener('midimessage', e => {
      const d = e.data;
      if ((d[0] & 0xf0) === 0x90 && d[2] > 0) noteSeen(input, d[1]);
      if (input.name !== prefs.keysIn) return;
      // Capture keeps everything, including playing in the Sound Editor.
      captureEvent(d, e.timeStamp);
      // Only while the sequencer is on screen: keys played while auditioning in the Sound Editor
      // shouldn't fill in steps behind your back.
      if (onScreen()) onKeys(d, e.timeStamp);
    });
    input.open?.().catch(() => {});
  }
}

const onScreen = () => !window.frameElement || !window.frameElement.hidden;

// The light next to Keys in: green for notes on the chosen port; amber when notes arrive on a
// different port (so it's clear which one to choose).
let ledTimer = null, lastOther = null;
function noteSeen(input, note) {
  const chosen = input.name === prefs.keysIn, led = $('#keys-led');
  lastOther = chosen ? null : input.name;
  $('#keys-last').classList.toggle('fix', !chosen);
  led.className = `keys-led ${chosen ? 'ok' : 'other'}`;
  $('#keys-last').textContent = chosen ? M.noteName(note) : `${M.noteName(note)} from ${input.name}?`;
  led.title = chosen ? `Last note ${M.noteName(note)} from ${portLabel(input)}`
    : `A note arrived from ${portLabel(input)}, which isn't the Keys in port. Click to use it.`;
  clearTimeout(ledTimer);
  ledTimer = setTimeout(() => { led.className = 'keys-led'; }, 400);
}

function status(text, kind = '') {
  const el = $('#midi-status');
  el.textContent = text;
  el.className = `status-pill ${kind}`;
}

function renderPorts() {
  const ins = inputs(), outs = outputs();
  // If the saved port isn't connected (unplugged, or a name saved from the simulator), use the
  // XL's keyboard, or else the first input.
  if (!prefs.keysIn || !ins.some(p => p.name === prefs.keysIn)) {
    const guess = ins.find(looksLikeSynthIn) || ins[0];
    if (guess) { prefs.keysIn = guess.name; savePrefs(); }
  }
  const keys = $('#keys-in');
  keys.innerHTML = `<option value="">— none —</option>` + ins.map(p => `<option value="${esc(p.name)}">${esc(portLabel(p))}</option>`).join('')
    + (prefs.keysIn && !ins.some(p => p.name === prefs.keysIn) ? `<option value="${esc(prefs.keysIn)}">${esc(prefs.keysIn)} (not connected)</option>` : '');
  keys.value = prefs.keysIn || '';
  $('#clock-list').innerHTML = outs.length
    ? outs.map(p => `<label><input type="checkbox" value="${esc(p.name)}" ${prefs.clockOut.includes(p.name) ? 'checked' : ''}> ${esc(portLabel(p))}</label>`).join('')
      + `<span class="hint">Set the XL's Clock to Auto or Ext-USB to sync its arpeggiator.</span>`
    : '<span class="hint">No MIDI outputs.</span>';
  const on = outs.filter(p => prefs.clockOut.includes(p.name));
  $('#clock-sum').textContent = on.length ? on.map(p => portLabel(p).replace(/ \(.*\)$/, '')).join(', ') : 'off';
  updateClockTargets();
  if (midi) status(`MIDI · ${outs.length} out, ${ins.length} in`, outs.length ? 'ok' : 'warn');
}

// ---------------------------------------------------------------------------------------------
// Rendering

function renderAll() {
  renderTop();
  renderFileBar();
  renderSong();
  renderCapture();
  renderTracks();
}

function renderTop() {
  const setVal = (el, v) => { if (document.activeElement !== el) el.value = v; };
  setVal($('#bpm'), song.bpm);
  setVal($('#swing'), song.swing);
  $('#swing-val').textContent = `${song.swing}%`;
  $('#scale-type').value = song.scale ? song.scale.type : '';
  $('#scale-root').value = song.scale ? song.scale.root : 0;
  $('#scale-root').disabled = !song.scale;
  document.querySelectorAll('#mode button').forEach(b => b.classList.toggle('on', b.dataset.m === prefs.mode));
  $('#follow').checked = prefs.follow;
}

function renderFileBar() {
  const name = $('#song-name');
  if (document.activeElement !== name) name.value = song.name;
  $('#dirty').hidden = !dirty;
  $('#dirty').textContent = fileName ? 'unsaved changes' : 'not saved yet';
  $('#delete').disabled = !fileName;
  $('#undo').disabled = !undoStack.length;
  $('#redo').disabled = !redoStack.length;
  document.title = `${song.name}${dirty ? ' •' : ''} · XL Sequencer`;
}

function renderSong() {
  const el = $('#song');
  el.hidden = !prefs.songOpen;
  $('#song-col').textContent = prefs.songOpen ? '▾' : '▸';
  el.innerHTML = `
    <table>
      <tr><th></th>${song.song.map((s, i) => `<td class="sec-h" data-sec="${i}">${i + 1}</td>`).join('')}
        <td><button class="ghost small" data-act="add-sec" title="Add a section (copies the last one)">+ Section</button></td></tr>
      <tr><th>Bars</th>${song.song.map((s, i) => `<td><select data-act="bars" data-sec="${i}">${[1, 2, 3, 4, 6, 8, 12, 16, 24, 32]
        .concat(s.bars).filter((n, k, a) => a.indexOf(n) === k).sort((a, b) => a - b)
        .map(n => `<option ${n === s.bars ? 'selected' : ''}>${n}</option>`).join('')}</select></td>`).join('')}</tr>
      ${song.tracks.map((t, ti) => `<tr><th><span class="dot" style="background:${COLORS[ti]}"></span>${esc(t.name)}</th>
        ${song.song.map((s, i) => `<td data-sec="${i}"><button class="cell ${s.play[ti] ? '' : 'rest'}" data-act="cell" data-sec="${i}" data-t="${ti}"
          title="Click to change: A → B → C → D → silent">${s.play[ti] || '–'}</button></td>`).join('')}</tr>`).join('')}
      <tr><th></th>${song.song.map((s, i) => `<td>${song.song.length > 1 ? `<button class="ghost small" data-act="del-sec" data-sec="${i}" title="Remove section ${i + 1}">✕</button>` : ''}</td>`).join('')}</tr>
    </table>
    <div class="hint">Each track can play a different pattern in each section; – means silent. A bar is four beats.
      Patterns of other lengths loop within the section and restart when the next section begins. The song repeats from the top.</div>`;
  paintSong();
}

// Highlights the playing section without redrawing (so an open menu isn't closed).
function paintSong() {
  const now = engine.playing && engine.mode === 'song' ? live.section : -1;
  document.querySelectorAll('#song [data-sec]').forEach(e => {
    if (e.tagName === 'TD') e.classList.toggle('now', +e.dataset.sec === now);
  });
  const bars = song.song.reduce((n, s) => n + s.bars, 0);
  $('#song-sum').textContent = prefs.songOpen ? '' : `${song.song.length} sections · ${bars} bars`
    + (now >= 0 ? ` · playing section ${now + 1}, bar ${live.bar + 1}/${song.song[now].bars}` : '');
}

function renderTracks() {
  syncViews();
  $('#tracks').innerHTML = song.tracks.map((_, ti) => trackHTML(ti)).join('');
  song.tracks.forEach((_, ti) => paintPlayhead(ti));
  $('#add-track').disabled = song.tracks.length >= M.MAX_TRACKS;
}

function renderTrack(ti) {
  const el = document.getElementById(`trk-${ti}`);
  if (!el) return renderTracks();
  // Keep the cursor in a text box that's being typed in (redraws happen while playing).
  const focused = el.contains(document.activeElement) && document.activeElement.matches('input[type=text], input:not([type])')
    ? { act: document.activeElement.dataset.act, start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
  el.outerHTML = trackHTML(ti);
  paintPlayhead(ti);
  if (focused) {
    const input = document.querySelector(`#trk-${ti} [data-act="${focused.act}"]`);
    if (input && !input.disabled) { input.focus(); input.setSelectionRange(focused.start, focused.end); }
  }
}

function refreshGrid(ti) {
  const el = document.querySelector(`#trk-${ti} .grid-wrap`);
  if (el) { el.innerHTML = gridHTML(ti); paintPlayhead(ti); }
}

function trackHTML(ti) {
  const t = song.tracks[ti], v = views[ti];
  const editing = sel.t === ti && sel.open && !v.collapsed;
  const muted = !M.audible(song, ti);
  return `<section class="track${v.collapsed ? ' collapsed' : ''}${sel.t === ti ? ' selected' : ''}${muted ? ' muted' : ''}" id="trk-${ti}" data-t="${ti}">
    <div class="track-head" data-act="head">${headHTML(ti)}</div>
    ${v.ai.open && !v.collapsed ? aiHTML(ti) : ''}
    ${v.lib.open && !v.collapsed ? libHTML(ti) : ''}
    ${v.ideas.list.length && !v.collapsed ? ideasHTML(ti) : ''}
    ${editing ? editorHTML(ti) : ''}
    <div class="grid-wrap">${gridHTML(ti)}</div>
    ${t.mode === 'pool' ? poolHTML(ti) : ''}
  </section>`;
}

const options = (list, current) => list.map(([value, label]) =>
  `<option value="${esc(value)}" ${String(value) === String(current) ? 'selected' : ''}>${esc(label)}</option>`).join('');

function headHTML(ti) {
  const t = song.tracks[ti], v = views[ti], pat = viewPattern(ti);
  const outs = outputs();
  const outList = [[M.COMPUTER, 'Computer (test sound)'], ...outs.map(p => [p.name, portLabel(p)])];
  if (t.out !== M.COMPUTER && !outs.some(p => p.name === t.out)) outList.push([t.out, `${t.out} (not connected)`]);
  const queued = engine.queued.get(ti);
  const playingPat = engine.playing && !live.silent[ti] ? live.pattern[ti] : null;
  return `
    <button class="ghost collapse" data-act="col" title="${v.collapsed ? 'Expand' : 'Collapse'}">${v.collapsed ? '▸' : '▾'}</button>
    <span class="track-name"><span class="dot" style="background:${COLORS[ti]}"></span><input data-act="name" value="${esc(t.name)}" maxlength="24" spellcheck="false" aria-label="Track name"></span>
    <span class="field">Pattern <span class="pats">${M.PATTERNS.map(p => `<button data-act="pat" data-p="${p}"
      class="${v.pat === p ? 'on' : ''}${queued === p ? ' queued' : ''}${playingPat === p ? ' live' : ''}"
      title="${p === playingPat ? 'Playing' : queued === p ? 'Starts at the next bar' : `Show pattern ${p}`}">${p}</button>`).join('')}</span></span>
    <label class="field" title="Any length from 1 to ${M.MAX_STEPS} steps">Length <input type="number" data-act="len" min="1" max="${M.MAX_STEPS}" value="${pat.length}"></label>
    <span class="head-extra">
      <span class="tools">
        <button class="ghost" data-act="copy" title="Copy pattern ${v.pat}">Copy</button>
        <button class="ghost" data-act="paste" title="Replace pattern ${v.pat} with the copied pattern" ${clipboard ? '' : 'disabled'}>Paste</button>
        <button class="ghost" data-act="clear" title="Remove every note in pattern ${v.pat}">Clear</button>
        <button class="${v.ai.open ? 'on' : 'ghost'} ai-btn" data-act="ai" title="Have the AI write patterns for this track">✨ AI</button>
        <button class="ghost" data-act="dice" title="Instant random idea for pattern ${v.pat} (no AI). Click again for another.">🎲</button>
        <button class="${v.lib.open ? 'on' : 'ghost'} ai-btn" data-act="lib" title="Browse stock and saved patterns">📚</button>
        <button class="ghost" data-act="star" title="Save pattern ${v.pat} to your library">★</button>
      </span>
      <label class="field">Out <select data-act="out" class="${outList.at(-1)[1].endsWith('(not connected)') && t.out === outList.at(-1)[0] ? 'missing' : ''}">${options(outList, t.out)}</select></label>
      ${t.out === M.COMPUTER
        ? `<label class="field" title="Built-in test sound">Sound <select data-act="voice">${options(M.VOICES.map(x => [x, x]), t.voice)}</select></label>`
        : `<label class="field">Ch <select data-act="ch">${options(Array.from({ length: 16 }, (_, c) => [c + 1, c + 1]), t.ch)}</select></label>`}
      ${isXLOut(t.out) ? `<button class="ghost sound-btn${liveSound === ti ? ' live' : ''}" data-act="sound" title="${t.sound
          ? 'This track\'s XL sound, sent to the XL when playback starts. Click to send it now and edit it in the Sound Editor; your edits there are remembered.'
          : `Remember the sound the Sound Editor has now${editorSound ? ` (${esc(editorSound.name)})` : ''}`}">🎛 ${t.sound ? esc(t.sound.name || 'Sound') : `Use ${editorSound ? `“${esc(editorSound.name)}”` : 'editor sound'}`}</button>`
        : t.out !== M.COMPUTER ? `<label class="field" title="Program Change sent to this instrument when playback starts (and when you change it)">Prog
          <select data-act="prog"><option value="">—</option>${Array.from({ length: 128 }, (_, n) => `<option value="${n}" ${t.program === n ? 'selected' : ''}>${n + 1}</option>`).join('')}</select></label>` : ''}
      <span class="seg-btn">
        <button data-act="mode" data-m="steps" class="${t.mode === 'steps' ? 'on' : ''}" title="Each step plays its own notes">Steps</button>
        <button data-act="mode" data-m="pool" class="${t.mode === 'pool' ? 'on' : ''}" title="Steps set the rhythm; notes come from the pool">Note pool</button>
      </span>
      <label class="field" title="${t.out === M.COMPUTER ? 'Volume of this track\'s computer sound' : 'Volume, sent to the instrument as MIDI CC 7 (when you move it, and at play if not 100)'}">Vol
        <input type="range" class="vol" data-act="vol" min="0" max="127" value="${t.vol}"></label>
      <label class="field" title="How long each step is">Rate <select data-act="rate">${options(Object.keys(M.RATES).map(r => [r, r]), t.rate)}</select></label>
      <button class="ghost small" data-act="del-track" title="Remove this track">✕</button>
    </span>
    <span class="spacer"></span>
    <span class="ms">
      <button data-act="mute" class="${t.mute ? 'm-on' : ''}" title="Mute: silence this track">M</button>
      <button data-act="solo" class="${t.solo ? 's-on' : ''}" title="Solo: hear only soloed tracks">S</button>
    </span>`;
}

// ---- Drum tracks: a drum-machine grid (one row per drum) and a kit of pads in the step editor ----

const KIT = [[36, 'Kick'], [37, 'Rim'], [38, 'Snare'], [39, 'Clap'], [41, 'Low tom'], [45, 'Mid tom'], [48, 'High tom'],
  [42, 'Closed hat'], [44, 'Pedal hat'], [46, 'Open hat'], [49, 'Crash'], [51, 'Ride'], [56, 'Cowbell'], [70, 'Shaker'],
  [63, 'Conga'], [60, 'Bongo']];
const KIT_NAME = new Map(KIT);
const KIT_ORDER = KIT.map(([n]) => n);
const kitName = n => KIT_NAME.get(n) || M.drumName(n);
const isDrums = t => t.mode === 'steps' && M.guessRole(t) === 'drums';

// Rows: the basic kit, every drum the pattern uses, and any the user added.
function lanesOf(ti) {
  const pat = viewPattern(ti), rows = new Set([36, 38, 39, 42, 46, ...(views[ti].lanes || [])]);
  for (const s of pat.steps) if (s.i < pat.length) s.notes.forEach(n => rows.add(n));
  const rank = n => (KIT_ORDER.includes(n) ? KIT_ORDER.indexOf(n) : 1000 + n);
  return [...rows].sort((a, b) => rank(a) - rank(b));
}

function lanesHTML(ti) {
  const v = views[ti], pat = viewPattern(ti);
  const PS = pageSize(ti), n = pages(ti), start = v.page * PS, end = start + PS;
  const at = new Map(pat.steps.map(s => [s.i, s]));
  const cols = Array.from({ length: PS }, (_, k) => start + k);
  const numbers = `<div></div>${cols.map(i => `<div class="lane-num${sel.t === ti && sel.i === i ? ' sel' : ''}${i >= pat.length ? ' beyond' : ''}"
    data-act="cell" data-s="${i}" title="Edit step ${i + 1}">${i + 1}</div>`).join('')}`;
  const rows = lanesOf(ti).map(note => `<div class="lane-name" data-act="lane-name" data-n="${note}" title="Click to hear it">${esc(kitName(note))}</div>`
    + cols.map(i => {
      const s = at.get(i), on = !!s && s.notes.includes(note);
      const cls = `lane-cell${i % 4 === 0 ? ' beat' : ''}${i >= pat.length ? ' beyond' : ''}${on ? ' on' : ''}${on && s.vel >= 110 ? ' accent' : ''}${on && s.vel < 70 ? ' soft' : ''}`;
      return `<div class="${cls}" data-act="lane" data-n="${note}" data-s="${i}"></div>`;
    }).join('')).join('');
  const shown = lanesOf(ti);
  const pager = n > 1 ? `<div class="pages">Steps ${Array.from({ length: n }, (_, k) =>
    `<button data-act="page" data-pg="${k}" class="${v.page === k ? 'on' : ''}">${k * PS + 1}–${Math.min(k * PS + PS, pat.length)}</button>`).join('')}</div>` : '';
  return `${pager}<div class="lanes" style="grid-template-columns:76px repeat(${PS}, minmax(${PS > 16 ? 12 : 20}px, 1fr))">${numbers}${rows}</div>
    <div class="lane-tools">
      <select data-act="lane-add">${options([['', '+ Add a drum…'], ...KIT.filter(([k]) => !shown.includes(k))], '')}</select>
      <span class="hint">Click or drag across cells to add or remove hits. ⇧-click a hit for an accent. Click a step number to edit that step (velocity, gate).</span>
    </div>`;
}

// Adds or removes one drum at one step. Steps hold all the drums that hit together.
function setHit(ti, i, note, on) {
  const pat = viewPattern(ti);
  if (i >= pat.length) return;
  const s = M.stepAt(pat, i);
  if (on) {
    if (!s) M.putStep(pat, i, { notes: [note], vel: 100, gate: 30 });
    else if (!s.notes.includes(note)) s.notes = [...s.notes, note].sort((a, b) => a - b);
  } else if (s) {
    s.notes = s.notes.filter(x => x !== note);
    if (!s.notes.length) M.removeStep(pat, i);
  }
}

function kitHTML(ti, isOn) {
  return `<div class="kit">${KIT.map(([note, name]) =>
    `<button class="pad${isOn(note) ? ' on' : ''}" data-act="key" data-n="${note}">${name}</button>`).join('')}</div>`;
}

function gridHTML(ti) {
  if (isDrums(song.tracks[ti]) && !views[ti].collapsed) return lanesHTML(ti);
  const t = song.tracks[ti], v = views[ti], pat = viewPattern(ti);
  const PS = pageSize(ti), n = pages(ti), start = v.page * PS, end = start + PS;
  const cover = M.coverMap(pat);
  let cells = '', blocks = '';
  for (let i = start; i < end; i++) {
    const cls = `cell-bg${i % 4 === 0 ? ' beat' : ''}${i >= pat.length ? ' beyond' : ''}${sel.t === ti && sel.i === i && cover[i] < 0 ? ' sel' : ''}`;
    cells += `<div class="${cls}" style="grid-column:${i - start + 1}" data-act="cell" data-s="${i}"><span class="num">${i + 1}</span></div>`;
  }
  for (let i = start; i < Math.min(end, pat.length); i++) {
    const c = cover[i];
    if (c < 0 || (c !== i && i !== start)) continue; // empty, or drawn by the block it belongs to
    const s = M.stepAt(pat, c);
    const fullEnd = Math.min(c + s.len, pat.length), stop = Math.min(fullEnd, end), span = stop - i;
    const drums = M.guessRole(t) === 'drums';
    const label = t.mode === 'pool' ? '♪' : s.notes.length ? [...new Set(s.notes.map(drums ? M.drumName : M.noteName))].join(span > 1 ? ' ' : '<br>') : '—';
    blocks += `<div class="blk${c !== i ? ' cont' : ''}${span === 1 ? ' single' : ''}${sel.t === ti && sel.i === c ? ' sel' : ''}"
      style="grid-column:${i - start + 1} / span ${span}" data-act="blk" data-s="${c}">
      <span class="num">${c + 1}${s.len > 1 ? ` · ${s.len} steps` : ''}</span>
      <span class="note"${s.notes.length > 1 && span === 1 && t.mode !== 'pool' ? ' style="font-size:10px;top:15px"' : ''}>${label}</span>
      <div class="vel" style="height:${Math.round(s.vel / 127 * 24)}px"></div>
      ${stop === fullEnd ? `<div class="gate" style="left:${(span - 1) / span * 100}%;width:${s.gate / span}%"></div>
        <div class="handle" title="Drag to hold the note longer or shorter"></div>` : ''}
    </div>`;
  }
  const pager = n > 1 ? `<div class="pages">Steps ${Array.from({ length: n }, (_, k) =>
    `<button data-act="page" data-pg="${k}" class="${v.page === k ? 'on' : ''}">${k * PS + 1}–${Math.min(k * PS + PS, pat.length)}</button>`).join('')}</div>` : '';
  return `${pager}<div class="steps${PS > 16 ? ' dense' : ''}" style="grid-template-columns:repeat(${PS}, minmax(${PS > 16 ? 18 : 30}px, 1fr))">${cells}${blocks}</div>`;
}

function keyboardHTML(ti, isOn, act) {
  const v = views[ti], keys = [];
  let white = 0;
  for (let n = v.kbdLow; n <= v.kbdLow + 36; n++) {
    const black = [1, 3, 6, 8, 10].includes(n % 12);
    const cls = `${black ? 'b' : 'w'}${isOn(n) ? ' on' : ''}${M.inScale(n, song.scale) ? '' : ' out'}`;
    if (black) keys.push(`<div class="${cls}" data-act="${act}" data-n="${n}" style="left:${white * 18 - 6}px" title="${M.noteName(n)}"></div>`);
    else { keys.push(`<div class="${cls}" data-act="${act}" data-n="${n}" title="${M.noteName(n)}">${n % 12 === 0 ? `<span class="lbl">${M.noteName(n)}</span>` : ''}</div>`); white++; }
  }
  return `<div class="kbd-row">
    <div class="oct"><button class="small" data-act="oct" data-d="12">Oct +</button><button class="small" data-act="oct" data-d="-12">Oct −</button></div>
    <div class="kbd">${keys.join('')}</div>
    <span class="hint">${act === 'pool-key' ? 'Click keys to choose the pool notes,<br>or play them on your keyboard.' : 'Click a key to set the note; click more for a chord.<br>Or play it on your keyboard.'}</span>
  </div>`;
}

function editorHTML(ti) {
  const t = song.tracks[ti], pat = viewPattern(ti), s = M.stepAt(pat, sel.i), pool = t.mode === 'pool';
  return `<div class="editor">
    <span class="title">Step ${sel.i + 1}</span>
    <label class="field"><input type="checkbox" data-act="e-on" ${s ? 'checked' : ''}> On</label>
    ${s ? `
      <label class="field" title="How many steps the note is held across">Hold <input type="number" data-act="e-len" min="1" max="${M.maxLen(pat, sel.i)}" value="${s.len}"> steps</label>
      <label class="field">Velocity <input type="range" data-act="e-vel" min="1" max="127" value="${s.vel}"> <span class="e-vel">${s.vel}</span></label>
      <label class="field" title="How much of its last step the note sounds for">Gate <input type="range" data-act="e-gate" min="1" max="100" value="${s.gate}"> <span class="e-gate">${s.gate}%</span></label>`
    : `<span class="hint">Empty step. ${pool ? 'Tick On to make it fire.' : isDrums(t) ? 'Click a drum below, or hit a pad.' : 'Click a key below or play one to add a note.'}</span>`}
    <button class="ghost small x" data-act="e-close" title="Hide the editor (Esc)">✕</button>
    ${pool ? keyboardHTML(ti, n => t.pool.notes.includes(n), 'pool-key')
      : isDrums(t) ? kitHTML(ti, n => !!s && s.notes.includes(n))
      : keyboardHTML(ti, n => !!s && s.notes.includes(n), 'key')}
  </div>`;
}

function poolHTML(ti) {
  const t = song.tracks[ti];
  const notes = poolNotes(ti);
  const shown = notes.length ? M.poolOrder(notes, t.pool.order === 'random' ? 'up' : t.pool.order) : [];
  return `<div class="pool">
    <b>Note pool</b>
    <span class="chips">${shown.length ? [...new Set(shown)].map(n => `<span class="chip" data-n="${n}">${M.noteName(n)}</span>`).join('') : '<span class="hint">empty</span>'}</span>
    <label class="field">Order <select data-act="p-order">${options(Object.entries(M.ORDERS), t.pool.order)}</select></label>
    <label class="field" title="Keep playing the last notes after you let go"><input type="checkbox" data-act="p-latch" ${t.pool.latch ? 'checked' : ''}> Latch</label>
    <button class="ghost small" data-act="p-clear">Clear</button>
    <span class="hint">${sel.t === ti ? 'Play notes on your keyboard to set the pool. Each step that fires plays the next one.' : 'Select this track to set the pool from your keyboard.'}</span>
  </div>`;
}

// Moves the playhead highlight without redrawing.
function paintPlayhead(ti) {
  const el = document.getElementById(`trk-${ti}`);
  if (!el) return;
  el.querySelectorAll('.play, .playing, .cur').forEach(e => e.classList.remove('play', 'playing', 'cur'));
  if (!engine.playing || live.pos[ti] === undefined || live.silent[ti]) return;
  if (live.poolNote[ti] !== undefined) el.querySelector(`.chip[data-n="${live.poolNote[ti]}"]`)?.classList.add('cur');
  if (views[ti].pat !== live.pattern[ti]) return;
  const pos = live.pos[ti], cover = M.coverMap(viewPattern(ti));
  el.querySelectorAll(`.lane-cell[data-s="${pos}"], .lane-num[data-s="${pos}"]`).forEach(c => c.classList.add('play'));
  if (cover[pos] >= 0) el.querySelector(`.blk[data-s="${cover[pos]}"]`)?.classList.add('playing');
  else el.querySelector(`.cell-bg[data-s="${pos}"]`)?.classList.add('play');
}

// ---------------------------------------------------------------------------------------------
// Ideas: patterns offered by 🎲, the AI or the library, to audition before keeping.
//
// Each track has one list. Adding to it plays the new idea at once; clicking a number swaps ideas
// (each swap is an undo step); Original puts back what was there before the first idea; Keep
// clears the list and leaves the pattern as it is; Put in copies the idea to another pattern.

const MAX_IDEAS = 12;
const newIdeas = () => ({ list: [], applied: -1, before: null, target: '' });

// `names`: the patterns these ideas fill. Ideas for the same patterns are added to the list;
// ideas for different ones start a new list.
function addIdeas(ti, names, fresh) {
  const t = song.tracks[ti], id = views[ti].ideas;
  const target = `${names.join()}|${t.mode}`;
  if (id.target === target && id.list.length) {
    const all = [...id.list, ...fresh], drop = Math.max(0, all.length - MAX_IDEAS);
    id.list = all.slice(drop);
    id.applied = id.applied >= drop ? id.applied - drop : -1;
  } else {
    id.list = fresh;
    id.before = { patterns: Object.fromEntries(names.map(n => [n, M.copyPattern(t.patterns[n])])), pool: [...t.pool.notes], rate: t.rate };
    id.applied = -1;
  }
  id.target = target;
  applyIdea(ti, id.list.length - fresh.length);
}

function applyIdea(ti, k) {
  const t = song.tracks[ti], v = views[ti], o = v.ideas.list[k];
  if (!o) return;
  for (const [name, p] of Object.entries(o.patterns)) t.patterns[name] = M.copyPattern(p);
  if (o.pool?.length && t.mode === 'pool') t.pool.notes = [...o.pool];
  t.rate = o.rate || v.ideas.before.rate;
  const names = Object.keys(o.patterns);
  if (names.length === 1 && v.pat !== names[0]) { v.pat = names[0]; v.page = 0; }
  v.ideas.applied = k;
  changed();
  renderTrack(ti);
}

function originalIdea(ti) {
  const t = song.tracks[ti], id = views[ti].ideas;
  if (!id.before || id.applied < 0) return;
  for (const [name, p] of Object.entries(id.before.patterns)) t.patterns[name] = M.copyPattern(p);
  t.pool.notes = [...id.before.pool];
  t.rate = id.before.rate;
  id.applied = -1;
  changed();
  renderTrack(ti);
}

function keepIdea(ti) {
  views[ti].ideas = newIdeas();
  renderTrack(ti);
}

// Copies the chosen idea into another pattern of this track (so several ideas can be kept).
function putIdea(ti, dest) {
  const t = song.tracks[ti], id = views[ti].ideas, o = id.list[id.applied];
  const src = o && Object.values(o.patterns);
  if (!src || src.length !== 1) return;
  t.patterns[dest] = M.copyPattern(src[0]);
  changed();
  renderTrack(ti);
  toast(`Idea ${id.applied + 1} copied to pattern ${dest}. Pick another idea for this pattern, or Keep.`, 'ok');
}

// 🎲: an instant random idea for the pattern on screen (no AI), using the AI panel's role,
// density and register.
function rollDice(ti) {
  const t = song.tracks[ti], v = views[ti], ai = v.ai;
  const role = ai.role === 'auto' ? M.guessRole(t) : ai.role;
  const idea = randomIdea({ role, length: viewPattern(ti).length, scale: song.scale, density: ai.density,
    register: ai.register, pool: t.mode === 'pool' });
  synth.wake();
  addIdeas(ti, [v.pat], [{ summary: idea.summary, patterns: { [v.pat]: idea.pattern }, pool: null }]);
}

function ideasHTML(ti) {
  const v = views[ti], id = v.ideas;
  const names = id.target.split('|')[0].split(',');
  const single = names.length === 1;
  const cur = id.list[id.applied];
  return `<div class="ideas">
    <div class="ai-row">
      <span class="field">Ideas for ${single ? `pattern ${names[0]}` : `patterns ${names.join('–')}`}</span>
      <span class="picks">
        <button class="ai-pick${id.applied < 0 ? ' on' : ''}" data-act="idea-original" title="The pattern from before the first idea">Original</button>
        ${id.list.map((o, k) => `<button class="ai-pick${id.applied === k ? ' on' : ''}${o.summary.startsWith('🎲') ? ' dice' : ''}" data-act="idea-pick" data-k="${k}"
          title="${esc(o.summary)}">${k + 1}</button>`).join('')}
      </span>
      <span class="spacer"></span>
      ${single ? `<label class="field" title="Copy the idea you're hearing into another pattern of this track">Put in
        <select data-act="idea-put" ${cur ? '' : 'disabled'}><option value="">…</option>${M.PATTERNS.filter(p => p !== names[0]).map(p => `<option>${p}</option>`).join('')}</select></label>` : ''}
      <button class="accent small" data-act="idea-keep" title="Keep what's in the pattern now and clear this list">✓ Keep</button>
    </div>
    <div class="ai-summary">${cur ? `<b>Idea ${id.applied + 1}:</b> ${esc(cur.summary)}` : 'Hearing the original pattern. Click a number to hear an idea.'}</div>
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Library: stock patterns (js/seq/stock.js) and the user's saved ones (data/my-patterns/ via serve.py)

let myPatterns = [];
async function loadMine() {
  try {
    myPatterns = (await api('/api/patterns')).map(p => ({
      ...p, ...M.cleanPattern(p), role: M.ROLES[p.role] ? p.role : 'lead', tags: Array.isArray(p.tags) ? p.tags : [],
      key: p.key && M.SCALES[p.key.type] ? p.key : null, rate: M.RATES[p.rate] ? p.rate : '1/16', mode: p.mode === 'pool' ? 'pool' : 'steps',
    }));
  } catch { myPatterns = []; }
  document.querySelectorAll('.lib-list').forEach(el => { el.innerHTML = libRows(+el.closest('[data-t]').dataset.t); });
}

const newLib = () => ({ open: false, q: '', role: 'auto', source: 'all' });

function libItems(ti) {
  const t = song.tracks[ti], lib = views[ti].lib;
  const q = lib.q.trim().toLowerCase();
  return [...(lib.source !== 'stock' ? myPatterns : []), ...(lib.source !== 'mine' ? STOCK : [])].filter(p => {
    if (lib.role === 'auto') {
      if (t.mode === 'pool' ? p.mode !== 'pool' : p.mode === 'pool' || p.role !== M.guessRole(t)) return false;
    } else if (lib.role !== 'all' && p.role !== lib.role) return false;
    return !q || [p.name, p.role, M.ROLES[p.role], ...p.tags].join(' ').toLowerCase().includes(q);
  });
}

// A thin strip showing where the notes are: dark where one starts, light where it's held.
function miniHTML(p) {
  const cover = M.coverMap(p);
  return `<span class="mini" style="grid-template-columns:repeat(${p.length}, 1fr)">${cover.map((c, i) =>
    `<i class="${c === i ? 'on' : c >= 0 ? 'held' : ''}"></i>`).join('')}</span>`;
}

function libRows(ti) {
  const items = libItems(ti);
  if (!items.length) return `<div class="hint">Nothing matches. Try Role: All${views[ti].lib.source === 'mine' ? ', or save patterns with ★' : ''}.</div>`;
  return items.map(p => `<div class="lib-item" data-act="lib-use" data-id="${esc(p.id)}" title="Try it in pattern ${views[ti].pat}">
    <span class="lib-name">${p.source === 'mine' ? '★ ' : ''}${esc(p.name)}</span>
    <span class="lib-meta">${esc(M.ROLES[p.role] || p.role)}${p.mode === 'pool' ? ' rhythm' : ''} · ${esc(p.tags.join(', ') || '—')} · ${p.length} steps${p.key ? ` · ${M.scaleLabel(p.key)}` : ''}${p.bpm ? ` · ~${p.bpm} BPM` : ''}</span>
    ${miniHTML(p)}
    ${p.source === 'mine' ? `<button class="ghost small" data-act="lib-del" data-file="${esc(p.file)}" title="Remove from your library">🗑</button>` : '<span></span>'}
  </div>`).join('');
}

function libHTML(ti) {
  const t = song.tracks[ti], lib = views[ti].lib;
  const auto = t.mode === 'pool' ? 'note-pool rhythms' : M.ROLES[M.guessRole(t)];
  return `<div class="lib-panel">
    <div class="ai-row">
      <span class="ai-mark">📚 Library</span>
      <input class="ai-msg" data-act="lib-q" value="${esc(lib.q)}" placeholder="Search names and styles (house, funk, acid…)" spellcheck="false">
      <label class="field">Role <select data-act="lib-role">${options([['auto', `Auto (${auto})`], ['all', 'All'], ...Object.entries(M.ROLES)], lib.role)}</select></label>
      <span class="seg-btn">${[['all', 'All'], ['stock', 'Stock'], ['mine', '★ Mine']].map(([val, label]) =>
        `<button data-act="lib-source" data-val="${val}" class="${lib.source === val ? 'on' : ''}">${label}</button>`).join('')}</span>
      <button class="ghost small x" data-act="lib" title="Close">✕</button>
    </div>
    <div class="lib-list">${libRows(ti)}</div>
    <div class="hint">Click a pattern to hear it in pattern ${views[ti].pat}; it joins the ideas, so Original goes back. Notes are moved to the song's key${song.scale ? ` (${M.scaleLabel(song.scale)})` : ''}. ★ in the track header saves a pattern here.</div>
  </div>`;
}

// Puts a library pattern into the ideas list, moved to the song's key.
function useLibrary(ti, id) {
  const p = [...myPatterns, ...STOCK].find(x => x.id === id);
  if (!p) return;
  const t = song.tracks[ti], v = views[ti];
  const pattern = M.copyPattern(p);
  let note = '';
  if (p.key && song.scale && p.role !== 'drums') {
    const shift = ((song.scale.root - p.key.root) % 12 + 18) % 12 - 6; // nearest way up or down
    const snap = song.scale.type !== p.key.type;
    for (const s of pattern.steps) {
      s.notes = [...new Set(s.notes.map(n => Math.max(0, Math.min(127, n + shift))).map(n => snap ? M.snapToScale(n, song.scale) : n))].sort((a, b) => a - b);
    }
    if (shift || snap) note = ` (moved from ${M.scaleLabel(p.key)} to ${M.scaleLabel(song.scale)})`;
  }
  // A rhythm on a steps track gets the track's last-used note so it isn't silent.
  if (t.mode === 'steps' && p.mode === 'pool') pattern.steps.forEach(s => { s.notes = [v.lastNote]; });
  synth.wake();
  addIdeas(ti, [v.pat], [{ summary: `📚 ${p.name}${note}`, patterns: { [v.pat]: pattern }, pool: p.pool || null, rate: p.rate }]);
}

async function starPattern(ti) {
  const t = song.tracks[ti], v = views[ti], pat = viewPattern(ti);
  const steps = pat.steps.filter(s => s.i < pat.length);
  if (!steps.length) { toast('This pattern is empty.'); return; }
  const name = (prompt('Save this pattern to your library as:', `${t.name} ${v.pat}`) || '').trim();
  if (!name) return;
  const role = v.ai.role === 'auto' ? M.guessRole(t) : v.ai.role;
  const pattern = { name, role, tags: [song.name].filter(n => n && n !== 'Untitled'), bpm: song.bpm, rate: t.rate, mode: t.mode,
    key: role === 'drums' ? null : song.scale, length: pat.length, steps, ...(t.mode === 'pool' ? { pool: t.pool.notes } : {}) };
  try {
    const { file } = await api('/api/patterns', { pattern });
    toast(`★ Saved to your library (data/my-patterns/${file})`, 'ok');
    await loadMine();
  } catch (err) {
    toast(`Couldn't save: ${err.message}`, 'err');
  }
}

async function deleteMine(file) {
  const p = myPatterns.find(x => x.file === file);
  if (!p || !confirm(`Remove "${p.name}" from your library? (It's moved to data/my-patterns/deleted/.)`)) return;
  try { await api('/api/patterns/delete', { file }); } catch (err) { toast(`Couldn't remove: ${err.message}`, 'err'); }
  await loadMine();
}

// ---------------------------------------------------------------------------------------------
// AI patterns: Claude writes patterns for one track (serve.py /api/pattern)

let aiAvailable = false, aiProblem = 'Checking the AI provider…';
function checkAiStatus() {
  fetch('/api/status').then(r => r.json()).then(j => {
    aiAvailable = !!j.ai;
    aiProblem = j.ai ? '' : `${j.problem} (AI settings are in the Sound Editor's AI Designer tab.)`;
    renderTracks();
  }).catch(() => { aiProblem = 'The editor’s server isn’t running.'; });
}
checkAiStatus();

function newAi() {
  return { open: false, message: '', role: 'auto', density: 'medium', register: 'auto', from: 'new', scope: 'one',
    fit: true, n: 2, busy: false, started: 0, error: '', ctrl: null };
}

const AI_EXAMPLES = {
  bass: 'rolling acid bassline', lead: 'catchy 80s synth riff', chords: 'house piano stabs',
  pad: 'slow, dark pad progression', arp: 'driving trance arpeggio', drums: 'four-on-the-floor with offbeat hats',
};

// What the AI sees of a track: its settings and (when asked) its steps.
function trackForAi(t, names, withSteps) {
  return {
    name: t.name, role: M.ROLES[M.guessRole(t)], mode: t.mode === 'pool' ? 'note pool' : 'steps', rate: t.rate,
    sound: t.out === M.COMPUTER ? `computer test sound (${t.voice})` : t.out,
    ...(t.mode === 'pool' ? { pool: t.pool.notes, poolOrder: t.pool.order } : {}),
    patterns: Object.fromEntries(names.map(n => [n, withSteps
      ? { length: t.patterns[n].length, steps: t.patterns[n].steps.filter(s => s.i < t.patterns[n].length) }
      : { length: t.patterns[n].length }])),
  };
}

// `surprise`: the AI panel's 🎲. Three varied ideas for the pattern on screen, ignoring the
// description, for when there's no particular idea in mind.
async function generate(ti, { surprise = false } = {}) {
  const t = song.tracks[ti], v = views[ti], ai = v.ai;
  if (ai.busy) return;
  ai.open = true;
  const names = surprise || ai.scope !== 'all' ? [v.pat] : [...M.PATTERNS];
  const from = surprise ? 'new' : ai.from, n = surprise ? 3 : ai.n;
  const listed = v.ideas.target === `${names.join()}|${t.mode}` ? v.ideas.list : [];
  const role = ai.role === 'auto' ? M.guessRole(t) : ai.role;
  const many = names.length > 1;
  const task = [
    from === 'vary' ? `Vary the current pattern${many ? 's' : ''} (shown in the context), keeping ${many ? 'their' : 'its'} identity.`
      : `Write new pattern${many ? 's' : ''} for the track "${t.name}".`,
    `Role: ${M.ROLES[role]}.`, `Density: ${ai.density}.`, `Register: ${ai.register}.`,
    t.mode === 'pool' ? 'This is a note-pool track: steps set only the rhythm (notes: []); also return the pool notes.' : '',
    many ? 'Fill all four: A main groove, B a variation of A, C a fill or build back to A, D a breakdown.' : '',
    ai.fit && song.tracks.length > 1 ? 'Fit with the other tracks shown.' : '',
    surprise ? 'These are quick ideas to audition: make the options clearly different from each other (rhythmic feel, contour, register or style) while still suiting the role.' : '',
    listed.length ? `Already suggested (do something different from these): ${listed.map(o => o.summary).join(' | ')}` : '',
  ].filter(Boolean).join(' ');
  const context = {
    bpm: song.bpm, swing: `${song.swing}%`,
    scale: song.scale ? M.scaleLabel(song.scale) : 'none set: choose a key that suits',
    track: trackForAi(t, names, from === 'vary'),
    ...(ai.fit ? { otherTracks: song.tracks.flatMap((o, oi) => oi === ti ? [] : [trackForAi(o, [views[oi].pat], true)]) } : {}),
  };
  Object.assign(ai, { busy: true, error: '', started: performance.now(), ctrl: new AbortController() });
  renderTrack(ti);
  const tick = setInterval(() => {
    const el = document.querySelector(`#trk-${ti} .ai-status`);
    if (el) el.textContent = `Writing… ${Math.round((performance.now() - ai.started) / 1000)}s`;
  }, 500);
  try {
    const r = await fetch('/api/pattern', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ai.ctrl.signal,
      body: JSON.stringify({ message: surprise ? '' : ai.message, task, context, patterns: names, options: n, pool: t.mode === 'pool' }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    let out = null, buf = '';
    const reader = r.body.getReader(), dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'error') throw new Error(ev.text);
        if (ev.type === 'result') out = ev.output;
      }
    }
    if (!out?.options?.length) throw new Error('No pattern came back.');
    // Each option is checked with the same rules as a loaded song, and must fit the pattern lengths.
    addIdeas(ti, names, out.options.map(o => ({
      summary: `✨ ${String(o.summary || '').slice(0, 300)}`,
      patterns: Object.fromEntries((o.patterns || []).filter(p => names.includes(p.name)).map(p => {
        const length = t.patterns[p.name].length;
        return [p.name, M.cleanPattern({ steps: p.steps }, { length, onlyBelow: length })];
      })),
      pool: Array.isArray(o.pool) ? o.pool.filter(n => Number.isInteger(n) && n >= 0 && n <= 127).slice(0, 8) : null,
    })));
  } catch (err) {
    if (err.name !== 'AbortError') ai.error = err.message;
  } finally {
    clearInterval(tick);
    Object.assign(ai, { busy: false, ctrl: null });
    renderTrack(ti);
  }
}

function aiHTML(ti) {
  const t = song.tracks[ti], v = views[ti], ai = v.ai;
  const auto = M.guessRole(t), role = ai.role === 'auto' ? auto : ai.role;
  const seg = (key, list) => `<span class="seg-btn">${list.map(([val, label]) =>
    `<button data-act="ai-set" data-key="${key}" data-val="${val}" class="${ai[key] === val ? 'on' : ''}">${label}</button>`).join('')}</span>`;
  const off = aiAvailable ? '' : `disabled title="${esc(aiProblem)}"`;
  return `<div class="ai-panel">
    <div class="ai-row">
      <span class="ai-mark">✨ AI</span>
      <input class="ai-msg" data-act="ai-msg" value="${esc(ai.message)}" maxlength="400" spellcheck="true"
        placeholder="Describe it, e.g. “${AI_EXAMPLES[role]}”" ${ai.busy ? 'disabled' : ''}>
      ${ai.busy
        ? `<span class="hint ai-status">Writing…</span><button class="ghost" data-act="ai-cancel">Cancel</button>`
        : `<button class="accent" data-act="ai-go" ${off}>Generate</button>
           <button data-act="ai-surprise" ${off || 'title="No idea in mind? Three varied AI ideas for this pattern, ignoring the description"'}>🎲 Surprise me</button>`}
      <button class="ghost small x" data-act="ai" title="Close">✕</button>
    </div>
    <div class="ai-row">
      <label class="field">Role <select data-act="ai-role">${options([['auto', `Auto (${M.ROLES[auto]})`], ...Object.entries(M.ROLES)], ai.role)}</select></label>
      <span class="field">Density ${seg('density', [['sparse', 'Sparse'], ['medium', 'Medium'], ['busy', 'Busy']])}</span>
      <label class="field">Register <select data-act="ai-register">${options([['auto', 'Auto'], ['low', 'Low'], ['mid', 'Mid'], ['high', 'High']], ai.register)}</select></label>
      <span class="field">Start from ${seg('from', [['new', 'Scratch'], ['vary', 'Current pattern']])}</span>
      <span class="field">Fill ${seg('scope', [['one', `Pattern ${v.pat}`], ['all', 'A–D']])}</span>
      <label class="field" title="Show the AI the other tracks so this one fits with them"><input type="checkbox" data-act="ai-fit" ${ai.fit ? 'checked' : ''}> Fit other tracks</label>
      <label class="field">Options <select data-act="ai-n">${options([[1, 1], [2, 2], [3, 3]], ai.n)}</select></label>
    </div>
    <div class="hint">Role, density and register also shape the instant 🎲 button in the track header.</div>
    ${role === 'drums' ? `<div class="hint">Drums use General MIDI note numbers (36 kick, 38 snare, 42 hat…): point this track at a drum machine, usually on channel 10.</div>` : ''}
    ${!aiAvailable ? `<div class="ai-error">${esc(aiProblem)}</div>` : ''}
    ${ai.error ? `<div class="ai-error">${esc(ai.error)}</div>` : ''}
  </div>`;
}

// ---------------------------------------------------------------------------------------------
// Capture: everything played on the Keys in keyboard is kept for an hour, split into takes at
// silences, so an idea played before you thought to record isn't lost. Kept in this browser.

const CAP_KEEP_MS = 60 * 60 * 1000, CAP_MAX_EVENTS = 20000;
const cap = { events: store.get('capture', []), run: 0, bpm: new Map(), fromBar: new Map(), est: new Map(), playing: null };
let capSaveTimer = null, capRenderTimer = null;

function captureEvent(d, at = performance.now()) {
  const type = d[0] & 0xf0;
  let e;
  if (type === 0x90 && d[2] > 0) e = { type: 'on', n: d[1], v: d[2] };
  else if (type === 0x80 || type === 0x90) e = { type: 'off', n: d[1], v: 0 };
  else if (type === 0xb0 && d[1] === 64) e = { type: 'ped', n: d[2] >= 64 ? 1 : 0, v: 0 };
  else return;
  e.t = Math.round(performance.timeOrigin + at);
  if (engine.playing) Object.assign(e, { tick: Math.round(engine.tickAt(at) * 10) / 10, run: cap.run, bpm: song.bpm });
  cap.events.push(e);
  const old = e.t - CAP_KEEP_MS;
  if (cap.events[0].t < old || cap.events.length > CAP_MAX_EVENTS) {
    cap.events = cap.events.filter(x => x.t >= old).slice(-CAP_MAX_EVENTS);
  }
  clearTimeout(capSaveTimer);
  capSaveTimer = setTimeout(() => store.set('capture', cap.events), 1500);
  if (!capRenderTimer) capRenderTimer = setTimeout(() => { capRenderTimer = null; renderCapture(); }, 400);
  clearTimeout(cap.endTimer);
  cap.endTimer = setTimeout(renderCapture, C.GAP_MS + 300); // the take is finished: show it as such
}

// Newest first. A take is still going (`live`) until the silence that ends it has passed.
const allTakes = () => C.splitTakes(C.notesOf(cap.events, Date.now())).reverse()
  .map(t => ({ ...t, live: t.open || Date.now() - t.end < C.GAP_MS }));
const findTake = id => allTakes().find(t => t.id === id);

// A take's tempo: the sequencer's when played along, else what you set, else a guess.
function takeBpm(take) {
  if (take.synced) return take.bpm;
  if (cap.bpm.has(take.id)) return cap.bpm.get(take.id);
  if (!take.live && cap.est.has(take.id)) return cap.est.get(take.id);
  const bpm = C.estimateTempo(take.notes, song.bpm) ?? song.bpm;
  if (!take.live) cap.est.set(take.id, bpm);
  return bpm;
}

const ago = ms => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 10 ? 'just now' : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : 'an hour ago';
};
const clock = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// A tiny piano roll of the take.
function rollSVG(take) {
  const span = Math.max(1, take.end - take.start);
  const lo = Math.min(...take.notes.map(n => n.note)), hi = Math.max(...take.notes.map(n => n.note));
  const rows = Math.max(12, hi - lo + 1), top = hi + Math.floor((rows - (hi - lo + 1)) / 2);
  return `<svg class="roll" viewBox="0 0 1000 ${rows}" preserveAspectRatio="none" aria-hidden="true">${take.notes.map(n =>
    `<rect x="${((n.t - take.start) / span * 1000).toFixed(1)}" y="${top - n.note}" width="${Math.max(4, n.dur / span * 1000).toFixed(1)}" height="1"/>`).join('')}</svg>`;
}

function renderCapture() {
  const el = $('#capture');
  el.hidden = !prefs.capOpen;
  $('#cap-col').textContent = prefs.capOpen ? '▾' : '▸';
  const takes = allTakes();
  const keys = inputs().find(p => p.name === prefs.keysIn);
  $('#cap-sum').textContent = !prefs.keysIn ? 'Choose a keyboard under Keys in to capture what you play'
    : `${takes.length ? `${takes.length} take${takes.length > 1 ? 's' : ''} · ` : ''}everything played on ${keys ? portLabel(keys) : prefs.keysIn} is kept for an hour`;
  if (!prefs.capOpen) return;
  // Don't redraw under a box being typed in.
  if (el.contains(document.activeElement) && document.activeElement.matches('input, select')) return;
  if (!takes.length) {
    el.innerHTML = `<div class="hint">Nothing yet. Play anything on your keyboard, here or in the Sound Editor, with or without the sequencer
      playing, and it shows up here as a take. Then put it into a track or save it as a .mid file.</div>`;
    return;
  }
  const t = song.tracks[sel.t], v = views[sel.t], rate = M.RATES[t.rate], perPat = C.barsPerPattern(rate);
  el.innerHTML = takes.map(take => {
    const bpm = takeBpm(take), items = C.takeTicks(take, bpm), bars = C.takeBars(items);
    const from = Math.min(cap.fromBar.get(take.id) || 0, bars - 1);
    const playing = cap.playing?.id === take.id;
    const fit = Math.min(perPat, bars - from);
    return `<div class="take${take.live ? ' open' : ''}" data-id="${take.id}">
      <button class="ghost play-take" data-act="cap-play" title="${playing ? 'Stop' : `Play it on ${esc(t.name)}'s sound`}">${playing ? '■' : '▶'}</button>
      ${rollSVG(take)}
      <span class="take-info"><span><b>${take.live ? 'Playing now…' : ago(take.end)}</b> · ${clock(take.end - take.start)} · ${take.notes.length} note${take.notes.length > 1 ? 's' : ''}</span>
        <span class="hint">${take.synced ? `played along at ${bpm} BPM` : 'free time'} · ${bars} bar${bars > 1 ? 's' : ''}</span></span>
      ${take.synced ? '' : `<label class="field" title="The take's tempo, first note on beat 1. It's a guess; change it if the bars look wrong.">BPM
        <input type="number" data-act="cap-bpm" min="40" max="240" value="${bpm}"></label>
        ${bpm !== song.bpm ? `<button class="ghost small" data-act="cap-tempo" title="Change the song's tempo to the take's">Song to ${bpm}</button>` : ''}`}
      ${bars > perPat ? `<label class="field" title="A pattern holds ${perPat} bar${perPat > 1 ? 's' : ''} of ${t.rate} steps">From bar
        <select data-act="cap-from">${Array.from({ length: bars }, (_, b) => `<option value="${b}" ${b === from ? 'selected' : ''}>${b + 1}</option>`).join('')}</select></label>` : ''}
      <span class="spacer"></span>
      <button data-act="cap-use" ${t.mode === 'pool' ? 'disabled' : ''} title="${t.mode === 'pool'
        ? 'Select a Steps track to put this in'
        : `Replace ${esc(t.name)} pattern ${v.pat} with ${fit === bars ? 'this take' : `bars ${from + 1}–${from + fit}`}, quantized to ${t.rate} steps (Undo brings the old one back)`}">→ ${esc(t.name)} ${v.pat}</button>
      <button class="ghost" data-act="cap-mid" title="Download this take as a MIDI file, as played (not quantized)">.mid</button>
      <button class="ghost small" data-act="cap-del" title="Forget this take">✕</button>
    </div>`;
  }).join('') + `<div class="hint">→ puts a take into the selected track's shown pattern. Select another track to change where it goes.
    <button class="ghost small" data-act="cap-clear">Forget all</button></div>`;
}

function playTake(take) {
  stopTake();
  synth.wake();
  const ti = sel.t, notes = take.notes, offset = performance.now() + 60 - take.start;
  let k = 0;
  const pump = () => {
    const horizon = performance.now() + 200;
    for (; k < notes.length && notes[k].t + offset < horizon; k++) playNote(ti, notes[k].note, notes[k].vel, notes[k].t + offset, notes[k].dur);
    if (k >= notes.length && performance.now() > take.end + offset) { stopTake(); renderCapture(); }
  };
  cap.playing = { id: take.id, timer: setInterval(pump, 50) };
  pump();
}
function stopTake() {
  if (cap.playing) clearInterval(cap.playing.timer);
  cap.playing = null;
}

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const midName = name => `${name.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'song'}.mid`;
const stamp = ms => { const d = new Date(ms), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`; };

$('#capture').addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'cap-clear') {
    if (!confirm('Forget every captured take?')) return;
    cap.events = []; store.set('capture', []); stopTake(); renderCapture();
    return;
  }
  const id = +el.closest('[data-id]')?.dataset.id, take = findTake(id);
  if (!take) return;
  const bpm = takeBpm(take);
  switch (el.dataset.act) {
    case 'cap-play':
      if (cap.playing?.id === id) stopTake(); else playTake(take);
      break;
    case 'cap-use': {
      const ti = sel.t, t = song.tracks[ti], v = views[ti];
      const pat = C.takeToPattern(C.takeTicks(take, bpm), M.RATES[t.rate], { fromBar: cap.fromBar.get(id) || 0 });
      if (!pat.steps.length) { toast('No notes in those bars.'); break; }
      t.patterns[v.pat] = pat;
      v.page = 0;
      changed();
      renderTrack(ti);
      const bars = pat.length / (M.TICKS_PER_BAR / M.RATES[t.rate]);
      toast(`Put ${bars} bar${bars > 1 ? 's' : ''} into ${t.name} pattern ${v.pat}.`
        + (!take.synced && bpm !== song.bpm ? ` You played it at ${bpm} BPM; the song is at ${song.bpm}.` : ''), 'ok');
      break;
    }
    case 'cap-mid': {
      const t = song.tracks[sel.t];
      download(writeMidi({ name: 'Captured take', bpm, tracks: [{ name: 'Take', ch: t.ch, notes: C.takeMidiNotes(take, bpm) }] }),
        `Take ${stamp(take.start)}.mid`);
      break;
    }
    case 'cap-tempo': song.bpm = bpm; changed(); renderTop(); break;
    case 'cap-del':
      cap.events = cap.events.filter(x => x.t < take.start || x.t > take.end);
      store.set('capture', cap.events);
      if (cap.playing?.id === id) stopTake();
      break;
  }
  renderCapture();
});
$('#capture').addEventListener('change', e => {
  const id = +e.target.closest('[data-id]')?.dataset.id;
  if (e.target.dataset.act === 'cap-bpm') {
    const v = Math.round(+e.target.value);
    if (v >= 40 && v <= 240) cap.bpm.set(id, v);
  } else if (e.target.dataset.act === 'cap-from') cap.fromBar.set(id, +e.target.value);
  e.target.blur();
  renderCapture();
});
$('#cap-col').onclick = () => { prefs.capOpen = !prefs.capOpen; savePrefs(); renderCapture(); };
// Keeps "2 min ago" current and the take being played growing.
setInterval(() => { if (onScreen() && prefs.capOpen) renderCapture(); }, 15000);

$('#export').onclick = () => {
  const r = songToMidi(song);
  if (!r.tracks.some(t => t.notes.length)) { toast('The song has no notes to export.'); return; }
  download(writeMidi(r), midName(song.name));
  toast(`Exported ${r.bars} bars at ${r.bpm} BPM, one MIDI track per sequencer track. Drag the file into Ableton's Arrangement view.`, 'ok');
};

// ---------------------------------------------------------------------------------------------
// Editing

function select(ti, i, open = true) {
  const prev = sel.t;
  sel = { t: ti, i, open };
  if (prev !== ti) renderCapture();
  if (prev !== ti && song.tracks[prev]) renderTrack(prev);
  renderTrack(ti);
  // Live switching: the XL plays the selected track's sound.
  const t = song.tracks[ti];
  if (prev !== ti && prefs.soundFollows && t.sound && isXLOut(t.out) && liveSound !== ti) sendSound(ti);
}

function edit(ti, fn, opts) {
  fn();
  changed(opts);
  renderTrack(ti);
}

function addNoteAt(ti, i) {
  const t = song.tracks[ti], v = views[ti];
  M.putStep(viewPattern(ti), i, { notes: t.mode === 'pool' ? [] : [v.lastNote] });
}

const trackEl = e => e.target.closest('[data-t]');

$('#tracks').addEventListener('click', e => {
  const el = e.target.closest('[data-act]'), tEl = trackEl(e);
  if (!el || !tEl) return;
  const ti = +tEl.dataset.t, t = song.tracks[ti], v = views[ti], pat = viewPattern(ti);
  const s = M.stepAt(pat, sel.i);
  switch (el.dataset.act) {
    case 'head':
      if (e.target === el || e.target.classList.contains('dot')) select(ti, sel.t === ti ? sel.i : 0, sel.open);
      break;
    case 'col':
      v.collapsed = !v.collapsed;
      prefs.collapsed = views.map(x => x.collapsed); savePrefs();
      renderTrack(ti);
      break;
    case 'pat': {
      const p = el.dataset.p;
      if (prefs.mode === 'loop') {
        if (t.pattern !== p) { t.pattern = p; changed(); }
        if (engine.playing) {
          if (p === live.pattern[ti]) engine.queued.delete(ti); else engine.queue(ti, p);
          if (!prefs.follow) { v.pat = p; v.page = 0; }
        } else { v.pat = p; v.page = 0; }
      } else { v.pat = p; v.page = 0; }
      if (sel.t === ti) sel.i = Math.min(sel.i, viewPattern(ti).length - 1);
      renderTrack(ti);
      break;
    }
    case 'copy':
      clipboard = M.copyPattern(pat);
      toast(`Copied ${t.name} pattern ${v.pat}. Use Paste on any pattern.`);
      renderTracks();
      break;
    case 'paste': if (clipboard) edit(ti, () => { t.patterns[v.pat] = M.copyPattern(clipboard); }); break;
    case 'clear': edit(ti, () => { pat.steps = []; }); break;
    case 'mode': if (t.mode !== el.dataset.m) edit(ti, () => { t.mode = el.dataset.m; }); break;
    case 'mute': edit(ti, () => { t.mute = !t.mute; }); break;
    case 'solo': t.solo = !t.solo; changed(); renderTracks(); break;
    case 'del-track':
      if (song.tracks.length <= 1) { toast('A song needs at least one track.'); break; }
      if (!confirm(`Remove the track "${t.name}"? (Undo can bring it back.)`)) break;
      M.removeTrack(song, ti);
      views.splice(ti, 1);
      liveSound = null;
      if (sel.t >= ti && sel.t > 0) sel.t--;
      changed();
      renderSong(); renderTracks();
      break;
    case 'page': v.page = +el.dataset.pg; renderTrack(ti); break;
    case 'cell': case 'blk':
      if (e.target.classList.contains('handle')) break;
      select(ti, +el.dataset.s);
      break;
    case 'e-on':
      edit(ti, () => { if (el.checked) addNoteAt(ti, sel.i); else M.removeStep(pat, sel.i); });
      break;
    case 'e-close': sel.open = false; renderTrack(ti); break;
    case 'oct': v.kbdLow = Math.max(0, Math.min(84, v.kbdLow + +el.dataset.d)); renderTrack(ti); break;
    case 'key': {
      const n = +el.dataset.n;
      v.lastNote = n;
      edit(ti, () => {
        if (!s) M.putStep(pat, sel.i, { notes: [n] });
        else if (s.notes.includes(n)) { s.notes = s.notes.filter(x => x !== n); if (!s.notes.length) M.removeStep(pat, sel.i); }
        else s.notes = [...s.notes, n].sort((a, b) => a - b);
      });
      if (M.stepAt(pat, sel.i)?.notes.includes(n)) preview(ti, n);
      break;
    }
    case 'pool-key': {
      const n = +el.dataset.n, has = t.pool.notes.includes(n);
      edit(ti, () => { t.pool.notes = has ? t.pool.notes.filter(x => x !== n) : [...t.pool.notes, n]; });
      if (!has) preview(ti, n);
      break;
    }
    case 'p-clear': edit(ti, () => { t.pool.notes = []; }); break;
    case 'ai':
      v.ai.open = !v.ai.open;
      if (v.ai.open) checkAiStatus(); // the provider may have changed in the Sound Editor
      renderTrack(ti);
      if (v.ai.open) document.querySelector(`#trk-${ti} .ai-msg`)?.focus();
      break;
    case 'ai-set': v.ai[el.dataset.key] = el.dataset.val; renderTrack(ti); break;
    case 'ai-go': synth.wake(); generate(ti); break;
    case 'ai-surprise': synth.wake(); generate(ti, { surprise: true }); break;
    case 'dice': rollDice(ti); break;
    case 'lane-name': preview(ti, +el.dataset.n); break;
    case 'sound':
      if (t.sound) {
        sendSound(ti);
        if (top !== self) parent.postMessage({ type: 'switch-view', view: 'editor' }, location.origin);
      } else if (editorSound) {
        t.sound = { ...editorSound };
        liveSound = ti;
        changed();
        renderTracks();
        toast(`${t.name} now uses ${t.sound.name || 'this sound'}. Changes you make in the Sound Editor are remembered for this track.`, 'ok');
      } else toast('Open a sound in the Sound Editor first.');
      break;
    case 'lib':
      v.lib.open = !v.lib.open;
      renderTrack(ti);
      if (v.lib.open) document.querySelector(`#trk-${ti} [data-act="lib-q"]`)?.focus();
      break;
    case 'lib-source': v.lib.source = el.dataset.val; renderTrack(ti); break;
    case 'lib-use': if (!e.target.closest('[data-act="lib-del"]')) useLibrary(ti, el.dataset.id); break;
    case 'lib-del': deleteMine(el.dataset.file); break;
    case 'star': starPattern(ti); break;
    case 'idea-pick': applyIdea(ti, +el.dataset.k); break;
    case 'idea-original': originalIdea(ti); break;
    case 'idea-keep': keepIdea(ti); break;
    case 'ai-cancel': v.ai.ctrl?.abort(); break;
  }
});

$('#tracks').addEventListener('keydown', e => {
  if (e.target.dataset.act === 'ai-msg' && e.key === 'Enter') {
    e.preventDefault();
    const ti = +trackEl(e).dataset.t;
    synth.wake();
    generate(ti);
  }
});

$('#tracks').addEventListener('dblclick', e => {
  const el = e.target.closest('[data-act="cell"], [data-act="blk"]'), tEl = trackEl(e);
  if (!el || !tEl || e.target.classList.contains('handle') || el.classList.contains('lane-num')) return;
  const ti = +tEl.dataset.t, i = +el.dataset.s;
  sel = { t: ti, i, open: sel.open || sel.t !== ti };
  edit(ti, () => { if (el.dataset.act === 'cell') addNoteAt(ti, i); else M.removeStep(viewPattern(ti), i); });
  if (el.dataset.act === 'cell' && song.tracks[ti].mode === 'steps') preview(ti, views[ti].lastNote);
});

// Inputs: 'input' for live sliders, 'change' for everything else.
$('#tracks').addEventListener('input', e => {
  const el = e.target, tEl = trackEl(e);
  if (tEl && el.dataset.act === 'ai-msg') { views[+tEl.dataset.t].ai.message = el.value; return; }
  if (tEl && el.dataset.act === 'vol') {
    const t = song.tracks[+tEl.dataset.t];
    t.vol = +el.value;
    if (t.out !== M.COMPUTER) sendVolume(t);
    changed({ coalesce: true });
    return;
  }
  if (tEl && el.dataset.act === 'lib-q') {
    const ti = +tEl.dataset.t;
    views[ti].lib.q = el.value;
    tEl.querySelector('.lib-list').innerHTML = libRows(ti);
    return;
  }
  if (!tEl || !['e-vel', 'e-gate'].includes(el.dataset.act)) return;
  const ti = +tEl.dataset.t, s = M.stepAt(viewPattern(ti), sel.i);
  if (!s) return;
  if (el.dataset.act === 'e-vel') { s.vel = +el.value; tEl.querySelector('.e-vel').textContent = s.vel; }
  else { s.gate = +el.value; tEl.querySelector('.e-gate').textContent = `${s.gate}%`; }
  changed({ coalesce: true });
  refreshGrid(ti);
});

$('#tracks').addEventListener('change', e => {
  const el = e.target, tEl = trackEl(e);
  if (!tEl) return;
  const ti = +tEl.dataset.t, t = song.tracks[ti], v = views[ti], pat = viewPattern(ti);
  switch (el.dataset.act) {
    case 'name': t.name = el.value.trim().slice(0, 24) || `Track ${ti + 1}`; changed(); renderSong(); break;
    case 'len': edit(ti, () => {
      pat.length = Math.max(1, Math.min(M.MAX_STEPS, Math.round(+el.value) || 1));
      // Notes past the end are kept (hidden), so making a pattern longer again brings them back.
      v.page = Math.min(v.page, pages(ti) - 1);
      if (sel.t === ti) sel.i = Math.min(sel.i, pat.length - 1);
    }); break;
    case 'out': edit(ti, () => { t.out = el.value; }); if (liveSound === ti && !isXLOut(t.out)) liveSound = null; break;
    case 'ch': edit(ti, () => { t.ch = +el.value; }); break;
    case 'prog': {
      edit(ti, () => { t.program = el.value === '' ? null : +el.value; });
      const port = outPort(t.out);
      if (port && t.program !== null) send(port, [0xc0 | (t.ch - 1), t.program]); // hear it right away
      break;
    }
    case 'voice': edit(ti, () => { t.voice = el.value; }); preview(ti, t.voice === 'Drums' ? 36 : 48); break;
    case 'rate': edit(ti, () => { t.rate = el.value; }); break;
    case 'e-len': {
      const s = M.stepAt(pat, sel.i);
      if (s) edit(ti, () => { s.len = Math.max(1, Math.min(M.maxLen(pat, sel.i), Math.round(+el.value) || 1)); });
      break;
    }
    case 'p-order': edit(ti, () => { t.pool.order = el.value; }); break;
    case 'ai-role': v.ai.role = el.value; renderTrack(ti); break;
    case 'ai-register': v.ai.register = el.value; break;
    case 'ai-fit': v.ai.fit = el.checked; break;
    case 'ai-n': v.ai.n = +el.value; break;
    case 'idea-put': if (el.value) putIdea(ti, el.value); break;
    case 'lib-role': v.lib.role = el.value; renderTrack(ti); break;
    case 'lane-add': if (el.value) { v.lanes = [...(v.lanes || []), +el.value]; preview(ti, +el.value); renderTrack(ti); } break;
    case 'p-latch': edit(ti, () => { t.pool.latch = el.checked; }); break;
  }
});

// Drum grid: click or drag along a row to paint hits (or erase, if the first cell was on).
$('#tracks').addEventListener('pointerdown', e => {
  const cell = e.target.closest('.lane-cell');
  if (!cell) return;
  e.preventDefault();
  const ti = +trackEl(e).dataset.t, note = +cell.dataset.n, i = +cell.dataset.s;
  const s = M.stepAt(viewPattern(ti), i), on = !!s && s.notes.includes(note);
  if (e.shiftKey && on) { s.vel = s.vel >= 110 ? 100 : 120; changed(); refreshGrid(ti); return; }
  setHit(ti, i, note, !on);
  if (!on) preview(ti, note);
  refreshGrid(ti);
  const over = ev => {
    const c = ev.target.closest?.('.lane-cell');
    if (!c || +c.dataset.n !== note || +c.closest('[data-t]').dataset.t !== ti) return;
    const cs = M.stepAt(viewPattern(ti), +c.dataset.s);
    if ((!!cs && cs.notes.includes(note)) === !on) return;
    setHit(ti, +c.dataset.s, note, !on);
    refreshGrid(ti);
  };
  const up = () => {
    removeEventListener('pointerover', over);
    removeEventListener('pointerup', up);
    changed();
    renderTrack(ti);
  };
  addEventListener('pointerover', over);
  addEventListener('pointerup', up);
});

// Drag a note's right edge to change how long it's held.
$('#tracks').addEventListener('pointerdown', e => {
  if (!e.target.classList.contains('handle')) return;
  e.preventDefault();
  const blk = e.target.closest('.blk'), ti = +trackEl(e).dataset.t, si = +blk.dataset.s;
  const pat = viewPattern(ti), s = M.stepAt(pat, si), v = views[ti];
  const grid = blk.parentElement.getBoundingClientRect(), PS = pageSize(ti), limit = M.maxLen(pat, si);
  const before = s.len;
  sel = { t: ti, i: si, open: sel.open };
  const move = ev => {
    const col = Math.max(0, Math.min(PS - 1, Math.floor((ev.clientX - grid.left) / (grid.width / PS))));
    const len = Math.max(1, Math.min(v.page * PS + col - si + 1, limit));
    if (len !== s.len) { s.len = len; refreshGrid(ti); }
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    if (s.len !== before) changed();
    renderTrack(ti);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
});

// Song grid
$('#song').addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const i = +el.dataset.sec;
  switch (el.dataset.act) {
    case 'cell': {
      const order = [...M.PATTERNS, null], sec = song.song[i], ti = +el.dataset.t;
      sec.play[ti] = order[(order.indexOf(sec.play[ti]) + 1) % order.length];
      break;
    }
    case 'add-sec': {
      const last = song.song.at(-1);
      song.song.push({ bars: last.bars, play: [...last.play] });
      break;
    }
    case 'del-sec': song.song.splice(i, 1); break;
    default: return;
  }
  changed();
  renderSong();
});
$('#song').addEventListener('change', e => {
  if (e.target.dataset.act !== 'bars') return;
  song.song[+e.target.dataset.sec].bars = +e.target.value;
  changed();
  paintSong();
});

// Top bar
$('#play').onclick = play;
$('#stop').onclick = stop;
$('#rec').onclick = () => setRec(!rec.on);
$('#bpm').addEventListener('input', e => {
  const v = Math.round(+e.target.value);
  if (v >= 20 && v <= 300) { song.bpm = v; changed({ coalesce: true }); }
});
$('#bpm').addEventListener('change', () => renderTop());
$('#swing').addEventListener('input', e => { song.swing = +e.target.value; $('#swing-val').textContent = `${song.swing}%`; changed({ coalesce: true }); });
$('#scale-root').innerHTML = options(M.NOTE_NAMES.map((n, i) => [i, n]), 0);
$('#scale-type').innerHTML = options([['', 'Off'], ...Object.keys(M.SCALES).map(s => [s, s])], '');
const setScale = () => {
  const type = $('#scale-type').value;
  song.scale = type ? { root: +$('#scale-root').value, type } : null;
  changed();
  renderTop();
  renderTracks();
};
$('#scale-root').onchange = setScale;
$('#scale-type').onchange = setScale;
document.querySelectorAll('#mode button').forEach(b => b.onclick = () => {
  prefs.mode = b.dataset.m; savePrefs();
  engine.setMode(prefs.mode);
  renderTop(); paintSong();
});
$('#follow').onchange = e => { prefs.follow = e.target.checked; savePrefs(); };
$('#sound-follows').checked = prefs.soundFollows;
$('#sound-follows').onchange = e => { prefs.soundFollows = e.target.checked; savePrefs(); };
// Open the Clock out menu towards whichever side has room (the top bar wraps on narrow windows).
$('#clock-out').addEventListener('toggle', () => {
  const r = $('#clock-out').getBoundingClientRect(), body = $('#clock-list');
  const rightward = r.right - 260 < 8;
  body.style.left = rightward ? '0' : 'auto';
  body.style.right = rightward ? 'auto' : '0';
});
$('#song-col').onclick = () => { prefs.songOpen = !prefs.songOpen; savePrefs(); renderSong(); };
$('#collapse-all').onclick = () => {
  const all = views.every(v => v.collapsed);
  views.forEach(v => { v.collapsed = !all; });
  prefs.collapsed = views.map(v => v.collapsed); savePrefs();
  $('#collapse-all').textContent = all ? 'Collapse all' : 'Expand all';
  renderTracks();
};
$('#add-track').onclick = () => {
  if (!M.addTrack(song)) { toast(`Up to ${M.MAX_TRACKS} tracks.`); return; }
  syncViews();
  sel = { t: song.tracks.length - 1, i: 0, open: true };
  changed();
  renderSong(); renderTracks();
};
$('#keys-in').onchange = e => { prefs.keysIn = e.target.value || null; savePrefs(); held.length = 0; renderCapture(); };
// Clicking the amber light (or its text) switches Keys in to the port the notes came from.
for (const id of ['#keys-led', '#keys-last']) $(id).addEventListener('click', e => {
  if (!lastOther) return;
  e.preventDefault();
  prefs.keysIn = lastOther; savePrefs();
  held.length = 0;
  lastOther = null;
  $('#keys-last').textContent = '';
  $('#keys-last').classList.remove('fix');
  renderPorts();
  toast(`Keys in: ${$('#keys-in').selectedOptions[0]?.textContent}`, 'ok');
});
$('#thru').checked = prefs.thru;
$('#thru').onchange = e => { prefs.thru = e.target.checked; savePrefs(); };
$('#clock-list').addEventListener('change', e => {
  prefs.clockOut = [...document.querySelectorAll('#clock-list input[value]:checked')].map(x => x.value);
  savePrefs();
  renderPorts();
});
document.addEventListener('click', e => { if (!e.target.closest('#clock-out')) $('#clock-out').open = false; });

// ---------------------------------------------------------------------------------------------
// Files: data/sequences/<name>.json via serve.py

async function api(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

let saved = [];
async function refreshOpenList() {
  try { saved = await api('/api/sequences'); } catch { saved = []; }
  $('#open').innerHTML = `<option value="">Open…</option>`
    + saved.map(f => `<option value="${esc(f.file)}">${esc(f.name)}</option>`).join('')
    + `<option value="__demo">Demo song</option>`;
}

// Same rule as serve.py's safe_stem, so we can warn before replacing another song's file.
const fileFor = name => `${(name.replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'SOUND').slice(0, 32)}.json`;

async function save() {
  let name = song.name.trim();
  if (!name || name === 'Untitled') {
    name = (prompt('Name this song:', '') || '').trim();
    if (!name) return;
    song.name = name;
  }
  await refreshOpenList();
  const target = fileFor(name);
  if (target !== fileName && saved.some(f => f.file === target)
      && !confirm(`A saved song already uses the file ${target}. Replace it?`)) return;
  try {
    const { file } = await api('/api/sequences', { song });
    fileName = file;
    dirty = false;
    saveWorking();
    renderFileBar();
    refreshOpenList();
    toast(`Saved to data/sequences/${file}`, 'ok');
  } catch (err) {
    toast(`Couldn't save: ${err.message}. Is serve.py running?`, 'err');
  }
}

const discardOk = () => !dirty || confirm(`Discard unsaved changes to "${song.name}"?`);

$('#save').onclick = save;
$('#new').onclick = () => { if (discardOk()) load(M.newSong(), null); };
$('#open').onchange = async e => {
  const file = e.target.value;
  e.target.value = '';
  if (!file || !discardOk()) return;
  if (file === '__demo') { load(demoSong(), null); return; }
  try {
    const r = await fetch(`sequences/${encodeURIComponent(file)}`);
    if (!r.ok) throw new Error(r.statusText);
    load(await r.json(), file);
  } catch (err) {
    toast(`Couldn't open ${file}: ${err.message}`, 'err');
  }
};
$('#delete').onclick = async () => {
  if (!fileName || !confirm(`Move "${song.name}" to data/sequences/deleted/? It stays open here, unsaved.`)) return;
  try {
    await api('/api/sequences/delete', { file: fileName });
    fileName = null;
    dirty = true;
    saveWorking();
    renderFileBar();
    refreshOpenList();
  } catch (err) {
    toast(`Couldn't delete: ${err.message}`, 'err');
  }
};
$('#song-name').addEventListener('change', e => {
  song.name = e.target.value.trim().slice(0, 60) || 'Untitled';
  changed();
});
$('#undo').onclick = undo;
$('#redo').onclick = redo;

// ---------------------------------------------------------------------------------------------
// Keyboard shortcuts

document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (e.target.closest('input, select, textarea')) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod || e.altKey) return;
  const ti = sel.t, t = song.tracks[ti], pat = viewPattern(ti), s = M.stepAt(pat, sel.i);
  const cover = M.coverMap(pat);
  const go = i => {
    i = (i + pat.length) % pat.length;
    i = cover[i] >= 0 ? cover[i] : i;
    views[ti].page = Math.floor(i / pageSize(ti));
    select(ti, i, sel.open);
  };
  switch (e.key) {
    case ' ': e.preventDefault(); if (engine.playing) stop(); else play(); break;
    case 'r': case 'R': setRec(!rec.on); break;
    case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': {
      const n = +e.key - 1;
      if (song.tracks[n] && n !== ti) select(n, Math.min(sel.i, M.coverMap(viewPattern(n)).length - 1), sel.open);
      break;
    }
    case 'ArrowRight': e.preventDefault(); go(s ? s.i + s.len : sel.i + 1); break;
    case 'ArrowLeft': e.preventDefault(); go(sel.i - 1); break;
    case 'ArrowUp': case 'ArrowDown': {
      if (!s || t.mode === 'pool' || !s.notes.length) break;
      e.preventDefault();
      const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1);
      if (s.notes.every(n => n + d >= 0 && n + d <= 127)) {
        edit(ti, () => { s.notes = s.notes.map(n => n + d); }, { coalesce: true });
        views[ti].lastNote = s.notes[0];
        preview(ti, s.notes.at(-1));
      }
      break;
    }
    case 'Enter': if (!s) { e.preventDefault(); sel.open = true; edit(ti, () => addNoteAt(ti, sel.i)); } break;
    case 'Backspace': case 'Delete': if (s) { e.preventDefault(); edit(ti, () => M.removeStep(pat, sel.i)); } break;
    case 'Escape': if (sel.open) { sel.open = false; renderTrack(ti); } break;
  }
});

// ---------------------------------------------------------------------------------------------
// Start

// Ask the host page (index.html) to show the other view; nothing reloads, so playback continues.
document.querySelectorAll('.app-nav a[data-view]').forEach(a => a.addEventListener('click', e => {
  if (top === self) return;
  e.preventDefault();
  parent.postMessage({ type: 'switch-view', view: a.dataset.view }, location.origin);
}));

{
  const w = store.get('working', null);
  let ok = false;
  if (w?.song) {
    try { load(w.song, w.fileName || null, !!w.dirty); ok = true; } catch { /* fall back to the demo */ }
  }
  if (!ok) load(demoSong(), null);
  refreshOpenList();
  loadMine();
  initMidi();
  soundChannel?.postMessage({ type: 'get-program' });
}
