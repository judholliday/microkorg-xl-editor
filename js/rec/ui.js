// The Recorder panel (recorder.html): keeps everything played on the chosen MIDI input for an hour,
// split into takes, and records performances with the sequencer. It makes no sound itself: the
// sequencer plays takes back on its selected track, and receives takes into patterns, through the
// shared BroadcastChannel('mkxl'):
//   from the sequencer:  transport { playing, anchor: { wall, tick, bpm }, run } · seq-state { track, mode, songBars, bpm }
//                        performance { state: 'start' | 'end', wall } · take-result { text, ok }
//   to the sequencer:    get-seq-state · audition-take { notes } · stop-audition · take-to-track { items, fromBar, bpm, synced }
//                        set-tempo { bpm } · record-performance { bars, countIn } · stop-sequencer
//                        print-stem { ti, tail }  (answered by stem { state: 'start' | 'end', wall, ms })
import * as C from '../seq/capture.js';
import { TICKS_PER_BEAT } from '../seq/model.js';
import { writeMidi } from '../seq/midifile.js';
import { portLabel, looksLikeSynthOut } from '../core/midiports.js';
import { AudioIn, cut, encodeWav, findOnset } from './audio.js';
import { storage, placeOf } from '../core/storage.js';
import { STATIC } from '../core/mode.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(`mkxl.rec.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`mkxl.rec.${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};
function toast(text, kind = '') {
  const el = Object.assign(document.createElement('div'), { className: `toast ${kind}`, textContent: text });
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
}
const prefs = { midiIn: null, perfLen: 'song', countIn: true, perfAudio: false, audioIn: null, ...store.get('prefs', {}) };
// Per audio device: which input to record ('0', '1' or 'both') and its measured delay (ms).
prefs.devices ||= {};
const dev = () => (prefs.devices[prefs.audioIn] ||= {});
let monoDevice = false;
const savePrefs = () => store.set('prefs', prefs);
const channel = new BroadcastChannel('mkxl');

// ---------------------------------------------------------------------------------------------
// What the sequencer is doing

let transport = { playing: false, anchor: null, run: 0 };
let seq = null; // { track: { name, pattern, rate, mode, ch }, mode, songBars, bpm }
let perf = null; // the performance being recorded: { start, end }

// The sequencer's song position at a wall-clock time (ms since 1970), while it plays.
function tickAt(wall) {
  const a = transport.anchor;
  return a.tick + (wall - a.wall) / (60000 / (a.bpm * TICKS_PER_BEAT));
}

channel.onmessage = e => {
  const m = e.data || {};
  if (m.type === 'transport') {
    transport = m;
    // Bar 1 of a performance being recorded with audio: where its audio file starts.
    if (perfAudio && !perfAudio.t0 && m.playing && m.anchor) perfAudio.t0 = m.anchor.wall - m.anchor.tick * 60000 / (m.anchor.bpm * TICKS_PER_BEAT);
    renderPerf();
  } else if (m.type === 'stem') onStem(m);
  else if (m.type === 'seq-state') { seq = m; renderPerf(); renderTakes(); }
  else if (m.type === 'performance') {
    if (m.state === 'start') { perf = { start: m.wall, end: Infinity }; cap.ranges.push({ ...perf, kind: 'performance' }); }
    else if (perf) { cap.ranges.at(-1).end = m.wall; perf = null; finishPerfAudio(m.wall); }
    saveSoon();
    renderPerf();
    renderTakes();
  } else if (m.type === 'take-result') toast(m.text, m.ok ? 'ok' : '');
};

// ---------------------------------------------------------------------------------------------
// Capture: every note, pedal and the times they happened (see seq/capture.js)

const KEEP_MS = 60 * 60 * 1000, MAX_EVENTS = 20000;
const cap = { events: [], ranges: [], bpm: new Map(), fromBar: new Map(), est: new Map(), auditioning: null };
{
  // Takes used to be kept by the sequencer page; bring them over once.
  const old = localStorage.getItem('mkxl.seq.capture');
  if (old && !localStorage.getItem('mkxl.rec.capture')) { localStorage.setItem('mkxl.rec.capture', old); localStorage.removeItem('mkxl.seq.capture'); }
  cap.events = store.get('capture', []);
  cap.ranges = store.get('ranges', []).map(r => ({ ...r, end: r.end ?? Infinity }));
  // A performance left open by a reload ends at its last note.
  for (const r of cap.ranges) if (r.end === Infinity) r.end = cap.events.at(-1)?.t ?? r.start;
}
let saveTimer = null, renderTimer = null, endTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { store.set('capture', cap.events); store.set('ranges', cap.ranges.map(r => ({ ...r, end: r.end === Infinity ? null : r.end }))); }, 1000);
}

function captureEvent(d, at) {
  const type = d[0] & 0xf0;
  let e;
  if (type === 0x90 && d[2] > 0) e = { type: 'on', n: d[1], v: d[2] };
  else if (type === 0x80 || type === 0x90) e = { type: 'off', n: d[1], v: 0 };
  else if (type === 0xb0 && d[1] === 64) e = { type: 'ped', n: d[2] >= 64 ? 1 : 0, v: 0 };
  else return;
  e.t = Math.round(performance.timeOrigin + (at ?? performance.now()));
  if (transport.playing && transport.anchor) Object.assign(e, { tick: Math.round(tickAt(e.t) * 10) / 10, run: transport.run, bpm: transport.anchor.bpm });
  cap.events.push(e);
  const old = e.t - KEEP_MS;
  if (cap.events[0].t < old || cap.events.length > MAX_EVENTS) {
    cap.events = cap.events.filter(x => x.t >= old).slice(-MAX_EVENTS);
    cap.ranges = cap.ranges.filter(r => r.end >= old);
  }
  saveSoon();
  if (!renderTimer) renderTimer = setTimeout(() => { renderTimer = null; renderTakes(); }, 400);
  clearTimeout(endTimer);
  endTimer = setTimeout(renderTakes, C.GAP_MS + 300); // the take is finished: show it as such
}

// Newest first. A take is still going (`live`) until the silence that ends it has passed.
const allTakes = () => C.splitTakes(C.notesOf(cap.events, Date.now()), C.GAP_MS, cap.ranges).reverse()
  .map(t => ({ ...t, live: t.open || (!t.kind && Date.now() - t.end < C.GAP_MS) })); // a performance ends when it stops
const findTake = id => allTakes().find(t => t.id === id);

// A take's tempo: the sequencer's when played along, else what you set, else a guess.
function takeBpm(take) {
  if (take.synced) return take.bpm;
  if (cap.bpm.has(take.id)) return cap.bpm.get(take.id);
  if (!take.live && cap.est.has(take.id)) return cap.est.get(take.id);
  const songBpm = seq?.bpm || 120, bpm = C.estimateTempo(take.notes, songBpm) ?? songBpm;
  if (!take.live) cap.est.set(take.id, bpm);
  return bpm;
}

// ---------------------------------------------------------------------------------------------
// Rendering

const ago = ms => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 10 ? 'just now' : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : 'an hour ago';
};
const clock = ms => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const stamp = ms => { const d = new Date(ms), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`; };
const barsPerPattern = rate => C.barsPerPattern(RATES[rate] || 24);
const RATES = { '1/32': 12, '1/16T': 16, '1/16': 24, '1/8T': 32, '1/8': 48, '1/4': 96 };

function rollSVG(take) {
  const span = Math.max(1, take.end - take.start);
  const lo = Math.min(...take.notes.map(n => n.note)), hi = Math.max(...take.notes.map(n => n.note));
  const rows = Math.max(12, hi - lo + 1), top = hi + Math.floor((rows - (hi - lo + 1)) / 2);
  return `<svg class="roll" viewBox="0 0 1000 ${rows}" preserveAspectRatio="none" aria-hidden="true">${take.notes.map(n =>
    `<rect x="${((n.t - take.start) / span * 1000).toFixed(1)}" y="${top - n.note}" width="${Math.max(4, n.dur / span * 1000).toFixed(1)}" height="1"/>`).join('')}</svg>`;
}

function renderTakes() {
  const el = $('#takes');
  const takes = allTakes();
  const input = inputs().find(p => p.name === prefs.midiIn);
  $('#takes-sum').textContent = !prefs.midiIn ? '· choose a MIDI in to capture what you play'
    : `· everything played on ${input ? portLabel(input) : prefs.midiIn} is kept for an hour`;
  if (el.contains(document.activeElement) && document.activeElement.matches('input, select')) return;
  if (!takes.length) {
    el.innerHTML = '<div class="hint">Nothing yet. Play anything, in any view, with or without the sequencer, and it shows up here as a take.</div>';
    return;
  }
  const t = seq?.track, perPat = t ? barsPerPattern(t.rate) : 4;
  el.innerHTML = takes.map(take => {
    const bpm = takeBpm(take), items = C.takeTicks(take, bpm), bars = C.takeBars(items);
    const from = Math.min(cap.fromBar.get(take.id) || 0, bars - 1), fit = Math.min(perPat, bars - from);
    const auditioning = cap.auditioning?.id === take.id;
    return `<div class="take${take.live ? ' live' : ''}${take.kind ? ' perf' : ''}" data-id="${take.id}">
      <div class="take-top"><button class="ghost play-take" data-act="play" title="${auditioning ? 'Stop' : `Play it on ${t ? esc(t.name) : 'the selected track'}'s sound`}">${auditioning ? '■' : '▶'}</button>${rollSVG(take)}</div>
      <div class="take-info"><b>${take.live ? (take.kind ? 'Recording…' : 'Playing now…') : ago(take.end)}</b>
        · ${clock(take.end - take.start)} · ${take.notes.length} note${take.notes.length > 1 ? 's' : ''}
        · <span class="hint">${take.kind ? 'performance, ' : ''}${take.synced ? `played along at ${bpm} BPM` : 'free time'} · ${bars} bar${bars > 1 ? 's' : ''}</span></div>
      <div class="take-actions">
        ${take.synced ? '' : `<label class="field" title="The take's tempo, first note on beat 1. It's a guess; change it if the bars look wrong.">BPM <input type="number" data-act="bpm" min="40" max="240" value="${bpm}"></label>
          ${seq && bpm !== seq.bpm ? `<button class="ghost small" data-act="tempo" title="Change the song's tempo to the take's">Song to ${bpm}</button>` : ''}`}
        ${bars > perPat ? `<label class="field" title="A pattern holds ${perPat} bar${perPat > 1 ? 's' : ''} of ${t?.rate || '1/16'} steps">From bar
          <select data-act="from">${Array.from({ length: bars }, (_, b) => `<option value="${b}" ${b === from ? 'selected' : ''}>${b + 1}</option>`).join('')}</select></label>` : ''}
        <span class="spacer"></span>
        <button data-act="use" ${!t || t.mode === 'pool' ? 'disabled' : ''} title="${!t ? 'The sequencer isn\'t ready' : t.mode === 'pool'
          ? 'Select a Steps track in the sequencer to put this in'
          : `Replace ${esc(t.name)} pattern ${t.pattern} with ${fit === bars ? 'this take' : `bars ${from + 1}–${from + fit}`}, quantized to ${t.rate} steps (Undo in the sequencer brings the old one back)`}">→ ${t ? `${esc(t.name)} ${t.pattern}` : 'track'}</button>
        <button class="ghost" data-act="mid" title="Download this take as a MIDI file, as played (not quantized)">.mid</button>
        <button class="ghost small" data-act="del" title="Forget this take">✕</button>
      </div>
    </div>`;
  }).join('') + `<div class="hint">→ puts a take into the sequencer's selected track and the pattern shown there. <button class="ghost small" data-act="clear">Forget all</button></div>`;
}

function renderPerf() {
  const lens = [['song', seq?.mode === 'song' ? `The song (${seq.songBars} bars)` : 'The song sections'], ['4', '4 bars'], ['8', '8 bars'], ['16', '16 bars'], ['32', '32 bars'], ['open', 'Until I stop']];
  $('#perf-len').innerHTML = lens.map(([v, l]) => `<option value="${v}" ${v === prefs.perfLen ? 'selected' : ''}>${l}</option>`).join('');
  $('#perf-countin').checked = prefs.countIn;
  $('#perf-audio').checked = prefs.perfAudio;
  const go = $('#perf-go');
  go.textContent = perf ? '■ Stop' : '● Record';
  go.classList.toggle('on', !!perf);
  $('#perf-status').textContent = perf ? (transport.playing ? 'Recording with the sequencer. Everything you play now goes into one take.' : 'Counting in…')
    : !prefs.midiIn ? 'Choose your keyboard under MIDI in first.' : '';
}

// ---------------------------------------------------------------------------------------------
// Actions

$('#takes').addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'clear') {
    if (!confirm('Forget every captured take?')) return;
    cap.events = []; cap.ranges = []; saveSoon(); renderTakes();
    return;
  }
  const id = +el.closest('[data-id]')?.dataset.id, take = findTake(id);
  if (!take) return;
  const bpm = takeBpm(take);
  switch (el.dataset.act) {
    case 'play':
      if (cap.auditioning?.id === id) { channel.postMessage({ type: 'stop-audition' }); cap.auditioning = null; clearTimeout(cap.auditionTimer); }
      else {
        channel.postMessage({ type: 'audition-take', notes: take.notes.map(n => ({ dt: n.t - take.start, dur: n.dur, note: n.note, vel: n.vel })) });
        cap.auditioning = { id };
        clearTimeout(cap.auditionTimer);
        cap.auditionTimer = setTimeout(() => { cap.auditioning = null; renderTakes(); }, take.end - take.start + 300);
      }
      break;
    case 'use':
      channel.postMessage({ type: 'take-to-track', items: C.takeTicks(take, bpm), fromBar: cap.fromBar.get(id) || 0, bpm, synced: take.synced });
      break;
    case 'mid':
      download(writeMidi({ name: 'Captured take', bpm, tracks: [{ name: 'Take', ch: seq?.track?.ch || 1, notes: C.takeMidiNotes(take, bpm) }] }), `Take ${stamp(take.start)}.mid`);
      break;
    case 'tempo': channel.postMessage({ type: 'set-tempo', bpm }); break;
    case 'del':
      cap.events = cap.events.filter(x => x.t < take.start || x.t > take.end);
      cap.ranges = cap.ranges.filter(r => r.start !== take.id);
      saveSoon();
      break;
  }
  renderTakes();
});
$('#takes').addEventListener('change', e => {
  const id = +e.target.closest('[data-id]')?.dataset.id;
  if (e.target.dataset.act === 'bpm') { const v = Math.round(+e.target.value); if (v >= 40 && v <= 240) cap.bpm.set(id, v); }
  else if (e.target.dataset.act === 'from') cap.fromBar.set(id, +e.target.value);
  e.target.blur();
  renderTakes();
});

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

$('#perf-len').onchange = e => { prefs.perfLen = e.target.value; savePrefs(); };
$('#perf-countin').onchange = e => { prefs.countIn = e.target.checked; savePrefs(); };
$('#perf-audio').onchange = e => { prefs.perfAudio = e.target.checked; savePrefs(); };
$('#perf-go').onclick = () => {
  if (perf) { channel.postMessage({ type: 'stop-sequencer' }); return; }
  if (!prefs.midiIn) { toast('Choose your keyboard under MIDI in first.'); return; }
  const bars = prefs.perfLen === 'song' ? 'song' : prefs.perfLen === 'open' ? null : +prefs.perfLen;
  if (prefs.perfAudio) {
    if (!audio.open) { toast('Choose an audio input first (Audio in), or untick Record audio too.'); return; }
    audio.record();
    perfAudio = { t0: null };
  }
  channel.postMessage({ type: 'record-performance', bars, countIn: prefs.countIn });
};

// The panel's own buttons: ask the host page (index.html).
$('#close').onclick = () => parent.postMessage({ type: 'toggle-recorder' }, location.origin);
$('#wide').onclick = () => parent.postMessage({ type: 'recorder-wide' }, location.origin);
addEventListener('keydown', e => {
  if (e.altKey && e.code === 'KeyR') { e.preventDefault(); parent.postMessage({ type: 'toggle-recorder' }, location.origin); }
  else if (e.key === 'Escape') parent.postMessage({ type: 'toggle-recorder', open: false }, location.origin);
});

// ---------------------------------------------------------------------------------------------
// MIDI in

let midi = null;
const inputs = () => (midi ? [...midi.inputs.values()].filter(p => p.state !== 'disconnected') : []);
let ledTimer = null;
function onMidi(e) {
  const d = e.data;
  if ((d[0] & 0xf0) === 0x90 && d[2] > 0) {
    $('#led').className = 'keys-led ok';
    clearTimeout(ledTimer);
    ledTimer = setTimeout(() => { $('#led').className = 'keys-led'; }, 300);
  }
  captureEvent(d, e.timeStamp);
}
function wireMidi() {
  const ins = inputs();
  if (!prefs.midiIn || !ins.some(p => p.name === prefs.midiIn)) {
    // Use what the sequencer listens to, else a controller keyboard (the MPK mini), else the first.
    const seqIn = (() => { try { return JSON.parse(localStorage.getItem('mkxl.seq.prefs'))?.keysIn; } catch { return null; } })();
    const guess = ins.find(p => p.name === seqIn) || ins.find(p => /mpk|akai/i.test(p.name)) || ins[0];
    if (guess) { prefs.midiIn = guess.name; savePrefs(); }
  }
  for (const p of ins) { p.onmidimessage = p.name === prefs.midiIn ? onMidi : null; if (p.name === prefs.midiIn) p.open?.().catch(() => {}); }
  $('#midi-in').innerHTML = `<option value="">— none —</option>${ins.map(p => `<option value="${esc(p.name)}">${esc(portLabel(p))}</option>`).join('')}`;
  $('#midi-in').value = prefs.midiIn || '';
  renderTakes();
  renderPerf();
}
async function initMidi() {
  if (new URLSearchParams(location.search).has('sim')) await import('../../tools/fakesynth.js');
  if (!navigator.requestMIDIAccess) { $('#midi-in').innerHTML = '<option>No Web MIDI (use Chrome)</option>'; return; }
  try { midi = await navigator.requestMIDIAccess({ sysex: true }); } catch {
    try { midi = await navigator.requestMIDIAccess(); } catch { $('#midi-in').innerHTML = '<option>MIDI blocked</option>'; return; }
  }
  midi.onstatechange = wireMidi;
  wireMidi();
}
$('#midi-in').onchange = e => { prefs.midiIn = e.target.value || null; savePrefs(); wireMidi(); };


// ---------------------------------------------------------------------------------------------
// Audio: the interface input (e.g. the Scarlett's input 2, where the XL is), recordings saved to
// data/audio/ through serve.py.

const audio = new AudioIn({ onLevel: showLevel });
let freeRec = null, perfAudio = null, stems = null, stemWait = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const wallToPerf = wall => wall - performance.timeOrigin;
const latency = () => (prefs.audioIn ? dev().latency ?? 0 : 0);
const latencyUnknown = () => !prefs.audioIn || dev().latency === undefined;

let levelShown = 0, peakHold = 0, clipUntil = 0;
function showLevel(peak) {
  const now = performance.now();
  if (peak >= 0.98) clipUntil = now + 1500;
  peakHold = Math.max(peak, peakHold * 0.9);
  if (now - levelShown < 50) return;
  levelShown = now;
  const db = 20 * Math.log10(Math.max(peakHold, 1e-5)), x = Math.max(0, Math.min(1, (db + 60) / 60));
  const bar = $('#meter-bar');
  bar.style.width = `${x * 100}%`;
  bar.style.background = db > -1 ? 'var(--err)' : db > -6 ? 'var(--warn)' : 'var(--ok)';
  $('#meter-bar').parentElement.classList.toggle('clip', now < clipUntil);
  $('#meter-db').textContent = peakHold < 1e-4 ? 'silent' : `${db.toFixed(0)} dB${now < clipUntil ? ' · too loud!' : ''}`;
}

async function fillDevices() {
  let list = [];
  try { list = await AudioIn.devices(); } catch { /* no media devices */ }
  const named = list.some(d => d.label);
  const sel = $('#audio-in');
  sel.innerHTML = `<option value="">— off —</option>` + (named
    ? list.map(d => `<option value="${esc(d.deviceId)}">${esc(d.label || 'Audio input')}</option>`).join('')
    : `<option value="ask">Allow audio input…</option>`);
  sel.value = prefs.audioIn && list.some(d => d.deviceId === prefs.audioIn) ? prefs.audioIn : '';
  showChannel();
  return list;
}

async function useAudio(id) {
  if (!id) { audio.stop(); prefs.audioIn = null; savePrefs(); showLevel(0); renderAudio(); return; }
  try {
    if (id === 'ask') {
      // First time: ask for permission, then pick the Scarlett if there is one.
      await audio.start(null);
      const list = await fillDevices();
      const pick = list.find(d => /scarlett|focusrite|2i2/i.test(d.label)) || list[0];
      id = pick?.deviceId || null;
    }
    const info = await audio.start(id);
    prefs.audioIn = id;
    // A one-channel input (the Mac's microphone, a headset) records that channel; a new
    // interface starts on input 2 if it's a Scarlett (where the XL is), else input 1.
    monoDevice = info.channels < 2;
    if (monoDevice) dev().ch = '0';
    else {
      const label = (await AudioIn.devices()).find(d => d.deviceId === id)?.label || info.label;
      dev().ch ||= /scarlett|focusrite|2i2/i.test(label) ? '1' : '0';
    }
    savePrefs();
    audio.channel = dev().ch === 'both' ? 'both' : +dev().ch;
  } catch (err) {
    prefs.audioIn = null;
    savePrefs();
    toast(err.name === 'NotAllowedError'
      ? 'Chrome blocked the audio input. Allow the microphone for this site (the icon at the left of the address bar) and try again.'
      : `Couldn't open the audio input: ${err.message}`, 'err');
  }
  await fillDevices();
  renderAudio();
}
$('#audio-in').onchange = e => useAudio(e.target.value);
$('#audio-ch').onchange = e => {
  dev().ch = e.target.value;
  savePrefs();
  audio.channel = dev().ch === 'both' ? 'both' : +dev().ch;
};
function showChannel() {
  const sel = $('#audio-ch');
  sel.innerHTML = monoDevice ? '<option value="0">1 (mono)</option>'
    : '<option value="1">2 (right)</option><option value="0">1 (left)</option><option value="both">1 + 2 (stereo)</option>';
  sel.value = monoDevice ? '0' : (prefs.audioIn && dev().ch) || '1';
  sel.disabled = !prefs.audioIn || monoDevice;
}

function renderAudio() {
  const on = audio.open;
  $('#audio-rec').disabled = !on || !!stems;
  $('#audio-rec').textContent = freeRec ? '■ Stop' : '● Record audio';
  $('#audio-rec').classList.toggle('on', !!freeRec);
  $('#measure').disabled = !on || !!freeRec || !!stems;
  $('#stems').disabled = !on || !!freeRec;
  $('#stems').textContent = stems ? '■ Stop printing' : 'Print stems';
  const l = prefs.audioIn ? dev().latency : undefined;
  $('#latency').textContent = l === undefined ? 'delay not measured yet' : `delay ${l.toFixed(1)} ms`;
  showChannel();
  if (!on) $('#meter-db').textContent = 'off';
}

async function saveWav(chans, name) {
  if (!chans?.[0]?.length) { toast('Nothing was recorded.'); return; }
  const wav = encodeWav(chans, audio.sampleRate);
  try {
    const file = await storage.save('audio', wav, name);
    toast(`Saved to ${placeOf('audio', file)}`, 'ok');
  } catch (err) {
    toast(`Couldn't save the recording: ${err.message}.${STATIC ? '' : ' Is serve.py running?'}`, 'err');
  }
  refreshRecordings();
}

// Free recording: from ● to ■.
$('#audio-rec').onclick = () => {
  if (freeRec) {
    clearInterval(freeRec.timer);
    const r = audio.finish();
    freeRec = null;
    $('#audio-time').textContent = '';
    renderAudio();
    if (r) saveWav(r.chans, `Recording ${stamp(Date.now())}`);
    return;
  }
  audio.record();
  const start = performance.now();
  freeRec = { timer: setInterval(() => { $('#audio-time').textContent = `recording ${clock(performance.now() - start)}`; }, 250) };
  renderAudio();
};

// A performance with audio: the file starts at bar 1 (the delay applied) and runs to the end
// plus a moment for the last notes to fade.
function finishPerfAudio(endWall) {
  if (!perfAudio) return;
  const p = perfAudio;
  perfAudio = null;
  setTimeout(() => {
    const r = audio.finish();
    if (!r || !p.t0) return;
    const sr = audio.sampleRate, from = audio.frameAt(wallToPerf(p.t0) + latency());
    saveWav(cut(r, from, Math.round((endWall - p.t0 + 1500) / 1000 * sr)), `Performance ${stamp(p.t0)}`);
  }, 1600);
}

// Measure delay: one note to the XL, timed from leaving here to its sound arriving.
$('#measure').onclick = async () => {
  const out = midi && [...midi.outputs.values()].find(p => p.state !== 'disconnected' && looksLikeSynthOut(p));
  if (!out) { toast('The XL isn\'t connected (no SOUND port).'); return; }
  const ch = (seq?.xlTracks?.[0]?.ch || 2) - 1;
  $('#latency').textContent = 'measuring…';
  audio.record();
  const at = performance.now() + 400;
  out.send([0x90 | ch, 60, 120], at);
  out.send([0x80 | ch, 60, 0], at + 250);
  await sleep(1300);
  const r = audio.finish();
  const onset = r ? findOnset(r.chans, audio.frameAt(at) - r.frame - Math.round(audio.sampleRate * 0.002)) : -1;
  const ms = onset < 0 ? NaN : audio.perfAt(r.frame + onset) - at;
  if (!(ms > 0 && ms < 300)) {
    toast('No clear note came back. Check the XL is on the chosen input and its sound starts quickly, then try again.', 'err');
  } else {
    dev().latency = Math.round(ms * 10) / 10;
    savePrefs();
    toast(`Delay ${dev().latency} ms for this input: recordings will be lined up by this much.`, 'ok');
  }
  renderAudio();
};

// Print stems: each XL track of the song, solo, from bar 1, one after another.
$('#stems').onclick = async () => {
  if (stems) { stems.cancel = true; channel.postMessage({ type: 'stop-sequencer' }); return; }
  const tracks = seq?.xlTracks || [];
  if (!tracks.length) { toast('The song has no tracks playing the XL.'); return; }
  if (latencyUnknown() && !confirm('The delay hasn\'t been measured, so the stems may be a few milliseconds late. Print anyway?')) return;
  stems = { cancel: false };
  renderAudio();
  const song = seq.songName || 'Song';
  for (let k = 0; k < tracks.length && !stems.cancel; k++) {
    const tr = tracks[k];
    $('#stems-status').textContent = `Recording ${tr.name} (${k + 1} of ${tracks.length})…`;
    audio.record();
    const res = await new Promise(resolve => { stemWait = { resolve }; channel.postMessage({ type: 'print-stem', ti: tr.ti, tail: 2 }); });
    const r = audio.finish();
    if (stems.cancel || !r || !res.start) break;
    const sr = audio.sampleRate, from = audio.frameAt(wallToPerf(res.start) + latency());
    await saveWav(cut(r, from, Math.round((res.ms + 2000) / 1000 * sr)), `${song} - ${tr.name}`);
    await sleep(300);
  }
  $('#stems-status').textContent = stems.cancel ? 'Stopped.' : `Done: ${tracks.length} stem${tracks.length > 1 ? 's' : ''}, each starting at bar 1 at ${seq.bpm} BPM.`;
  stems = null;
  renderAudio();
};
function onStem(m) {
  if (!stemWait) return;
  if (m.state === 'start') Object.assign(stemWait, { start: m.wall, ms: m.ms });
  else { const w = stemWait; stemWait = null; w.resolve({ start: w.start, ms: w.ms }); }
}

async function refreshRecordings() {
  let list = [];
  try { list = await storage.list('audio'); } catch { /* server down */ }
  $('#recordings').innerHTML = list.length ? list.map(x => `<div class="recording" data-file="${esc(x.file)}">
      <span class="rname" title="${esc(x.file)}">${esc(x.name)}</span><span class="hint">${clock(x.seconds * 1000)} · ${(x.size / 1e6).toFixed(1)} MB</span>
      <a download="${esc(x.file)}" title="Download (or drag into Ableton)">⬇</a>
      <button class="ghost small" data-act="rdel" title="${STATIC ? 'Delete' : 'Move to data/audio/deleted/'}">✕</button>
      <audio controls preload="none"></audio>
    </div>`).join('') : '<div class="hint">No recordings yet.</div>';
  // Their addresses: files at home, or blobs kept in this browser.
  for (const el of $('#recordings').querySelectorAll('[data-file]')) {
    const url = await storage.audioUrl(el.dataset.file);
    el.querySelector('a').href = url;
    el.querySelector('audio').src = url;
  }
}
$('#recordings').addEventListener('click', async e => {
  if (e.target.dataset.act !== 'rdel') return;
  const file = e.target.closest('[data-file]').dataset.file;
  if (!confirm(STATIC ? `Delete "${file}"?` : `Move "${file}" to data/audio/deleted/?`)) return;
  await storage.remove('audio', file);
  refreshRecordings();
});

// Keeps "2 min ago" current.
setInterval(() => { if (!document.hidden) renderTakes(); }, 15000);

if (STATIC) document.querySelector('#audio-sec .sub .hint').textContent = '· kept in this browser: download the ones you want to keep';
renderTakes();
renderPerf();
initMidi();
fillDevices().then(() => { if (prefs.audioIn) useAudio(prefs.audioIn); else renderAudio(); });
refreshRecordings();
channel.postMessage({ type: 'get-seq-state' });
