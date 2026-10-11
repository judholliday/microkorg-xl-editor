import { msg, parse, splitSysex, hex, FUNC } from './sysex.js';
import {
  PROGRAM_SIZE, PROGRAM_PARAMS, timbreParams, vocoderParams, fxParams, arpParams, oscCtrlLabelsFor,
  getValue, setValue, format, range, programName, setProgramName, slotName, initProgram,
  fxParamActive, fxLabel, fxDefault, voicing,
} from './params.js';
import { isKorgEditorFile, parseKorgEditorFile } from './korgfile.js';
import { programToAi, applyAiChanges, aiParams, toAi } from './aiparams.js';
import { soundType, TYPES } from './soundtype.js';
import { portLabel } from '../core/midiports.js';
import { isKorg, looksLikeSynthIn, looksLikeSynthOut } from './ports.js';

// ---------------------------------------------------------------------------------------------
// State

const state = {
  data: initProgram(),
  dataLen: PROGRAM_SIZE, // length of the dump as the synth sent it; we send back the same length
  slot: null,
  dirty: false,
  tab: 'help',
  library: new Array(128).fill(null),
  midi: null,
  input: null,
  output: null,
  channel: 0,
  sendMode: 'dump',
  // Whether Parameter Change values for "64 +/- n" params are sent relative to 64 (signed) or raw.
  // The spec says "signed value"; calibrate() confirms it against the synth.
  signedParams: true,
  calibrated: false,
  log: [],
  synthFound: false,
};

const $ = sel => document.querySelector(sel);
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
};
const svgEl = (tag, attrs = {}) => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('mkxl.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('mkxl.' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

function toast(text, kind = '') {
  const el = h('div', { class: `toast ${kind}` }, text);
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
}

// ---------------------------------------------------------------------------------------------
// Program data

function loadProgram(data, { slot = state.slot, dirty = false, send = false } = {}) {
  state.dataLen = data.length;
  const padded = new Uint8Array(Math.max(PROGRAM_SIZE, data.length));
  padded.set(data);
  state.data = padded;
  state.slot = slot;
  setDirty(dirty);
  persistProgram();
  if (send) sendProgram();
  render();
}

const programBytes = () => state.data.slice(0, state.dataLen);

function setDirty(d) {
  state.dirty = d;
  $('#dirty-flag').hidden = !d;
}

let persistTimer = null;
function persistProgram() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    store.set('program', { data: Array.from(programBytes()), slot: state.slot });
    announceProgram();
  }, 300);
}

// The sequencer (running alongside in index.html) remembers the sound each XL track uses. The
// editor tells it whenever its sound changes, and opens sounds the sequencer sends for editing.
const soundChannel = 'BroadcastChannel' in window ? new BroadcastChannel('mkxl') : null;
function announceProgram() {
  soundChannel?.postMessage({ type: 'program', name: programName(state.data).trim(), data: Array.from(programBytes()) });
}
if (soundChannel) soundChannel.onmessage = e => {
  const m = e.data || {};
  if (m.type === 'get-program') announceProgram();
  // The sequencer has already sent this sound to the synth, so only show it here.
  if (m.type === 'show-program' && Array.isArray(m.data) && m.data.length >= PROGRAM_SIZE - 8) {
    loadProgram(Uint8Array.from(m.data), { slot: null, dirty: false });
  }
};

// Every param list that can be addressed, given the current data (fx params depend on fx type).
function allParams() {
  return [
    ...PROGRAM_PARAMS, ...timbreParams(0), ...timbreParams(1), ...vocoderParams(),
    ...fxParams(state.data, 0), ...fxParams(state.data, 1), ...arpParams(),
  ];
}

const controls = new Map(); // param key -> update function

function setParam(p, v, { fromSynth = false } = {}) {
  const [min, max] = range(p.fmt);
  v = Math.max(min, Math.min(max, Math.round(v)));
  if (getValue(state.data, p) === v) return;
  setValue(state.data, p, v);
  if (p.key.endsWith('.type') && p.key.startsWith('fx') && !fromSynth) seedFx(p);
  setDirty(true);
  persistProgram();
  if (!fromSynth) { lastEditAt = performance.now(); transmitParam(p, v); }
  // Selects/toggles can change which controls are shown (fx type, LFO sync, osc wave...), so rebuild.
  if (p.fmt.k === 'enum' || p.rebuild) render();
  else controls.get(p.key)?.(v);
  afterParamChange(p);
}

// A new effect type reuses the same 22 bytes, so give its parameters usable starting values.
function seedFx(typeParam) {
  const slot = typeParam.key.startsWith('fx1') ? 0 : 1;
  const [, ...rest] = fxParams(state.data, slot);
  rest.forEach((q, i) => setValue(state.data, q, i < 2 ? 0 : fxDefault(q)));
  // In parameter mode the type message alone won't carry these values, so push the whole program once.
  if (state.output && state.sendMode === 'param') queueMicrotask(() => sendProgram(true));
}

function afterParamChange(p) {
  for (const fn of dependents) fn(p);
}
const dependents = new Set();

// ---------------------------------------------------------------------------------------------
// MIDI I/O

const waiters = new Set();
function waitFor(pred, ms = 1500) {
  return new Promise(resolve => {
    const w = { pred, resolve };
    waiters.add(w);
    setTimeout(() => { if (waiters.delete(w)) resolve(null); }, ms);
  });
}

// A program dump that was requested before the latest local edit is stale: the synth has
// since received that edit, so ask again rather than overwrite the editor with old data.
let lastEditAt = 0;
let lastRequestAt = 0;

function send(bytes, desc) {
  if (!state.output) return false;
  if (bytes[0] === 0xf0 && bytes[4] === FUNC.CURRENT_PROGRAM_DUMP_REQUEST) lastRequestAt = performance.now();
  try {
    state.output.send(bytes);
  } catch (e) {
    toast(`MIDI send failed: ${e.message}`, 'err');
    return false;
  }
  if (bytes[0] === 0xf0) addLog('out', desc || describe(parse(bytes)), bytes);
  return true;
}

let dumpTimer = null;
let dumpPending = false;
function scheduleDump() {
  if (dumpTimer) { dumpPending = true; return; }
  sendProgram(true);
  dumpTimer = setTimeout(() => {
    dumpTimer = null;
    if (dumpPending) { dumpPending = false; scheduleDump(); }
  }, 90);
}

function sendProgram(quiet = false) {
  if (!state.output) { if (!quiet) toast('Choose a MIDI output first.', 'err'); return; }
  send(msg.currentProgramDump(state.channel, programBytes()), 'Program → edit buffer');
}

function paramWireValue(p, v) {
  return state.signedParams && p.fmt.bias ? v - p.fmt.bias : v;
}

function transmitParam(p, v) {
  if (!state.output) return;
  if (state.sendMode === 'param' && p.id !== null) {
    send(msg.parameterChange(state.channel, p.id, p.sub, paramWireValue(p, v)), `Param ${p.label} = ${format(p.fmt, v)}`);
  } else {
    scheduleDump();
  }
}

function onMidiMessage(e) {
  const b = e.data;
  const status = b[0];
  if (status === 0xf8 || status === 0xfe) return; // clock / active sensing
  if (status === 0xf0) {
    const m = parse(b);
    addLog('in', describe(m), b);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.delete(w); w.resolve(m); }
    if (m) handleSysex(m);
    return;
  }
  // Program change from the synth's panel: follow it.
  if ((status & 0xf0) === 0xc0) {
    addLog('in', `Program change ${slotName(b[1])}`, b);
    state.slot = b[1];
    followSynthSoon();
  }
}

let followTimer = null;
function followSynthSoon(ms = 150) {
  clearTimeout(followTimer);
  followTimer = setTimeout(() => send(msg.currentProgramRequest(state.channel)), ms);
}

let pendingCalibration = null;

function handleSysex(m) {
  switch (m.type) {
    case 'identity':
      if (m.isXL) {
        state.channel = m.channel;
        $('#midi-ch').value = m.channel;
      }
      break;
    case 'currentProgram':
      if (lastEditAt > lastRequestAt) { followSynthSoon(200); break; }
      if (pendingCalibration) calibrate(m.data);
      loadProgram(m.data, { slot: state.slot });
      break;
    case 'program':
      state.library[m.program] = m.data;
      if (state.tab === 'lib') renderLibrarySlot(m.program);
      break;
    case 'param': {
      const p = allParams().find(q => q.id === m.id && q.sub === m.sub);
      if (p) {
        // Show it right away, then confirm against the real program data.
        const guess = p.fmt.bias && state.signedParams ? m.value + p.fmt.bias : m.value;
        setParam(p, guess, { fromSynth: true });
        if (p.fmt.bias && !state.calibrated) pendingCalibration = { p, value: m.value };
      }
      followSynthSoon(350);
      break;
    }
    case 'status':
      if (m.func === FUNC.DATA_FORMAT_ERROR) toast('The synth rejected the data (format error).', 'err');
      if (m.func === FUNC.DATA_LOAD_ERROR) toast('The synth could not load the data. Is Memory Protect on?', 'err');
      if (m.func === FUNC.WRITE_ERROR) toast('Write failed. Turn off Memory Protect in the synth\'s GLOBAL settings.', 'err');
      break;
  }
}

// Work out how the synth encodes "64 +/- n" values in Parameter Change messages by comparing
// a knob message it sent us with the program dump that follows.
function calibrate(data) {
  const { p, value } = pendingCalibration;
  pendingCalibration = null;
  const stored = getValue(data, p);
  if (stored === value + p.fmt.bias) state.signedParams = true;
  else if (stored === value) state.signedParams = false;
  else return;
  state.calibrated = true;
  store.set('signedParams', state.signedParams);
  store.set('calibrated', true);
  addLog('info', `Calibrated: parameter values are ${state.signedParams ? 'signed (relative to 64)' : 'raw'}`, []);
}

function describe(m) {
  if (!m) return 'SysEx (other device)';
  switch (m.type) {
    case 'identity': return m.isXL ? `Identity: microKORG XL v${m.version}, ch ${m.channel + 1}` : 'Identity: other device';
    case 'search': return m.isXL ? `Search reply: microKORG XL, ch ${m.channel + 1}${m.sysexFiltered ? ' (SysEx disabled!)' : ''}` : 'Search reply: other Korg device';
    case 'currentProgram': return `Current program "${programName(m.data)}" (${m.data.length} bytes)`;
    case 'program': return `Program ${slotName(m.program)} "${programName(m.data)}"`;
    case 'global': return `Global data (${m.data.length} bytes)`;
    case 'param': {
      const p = allParams().find(q => q.id === m.id && q.sub === m.sub);
      const id = `${m.id.toString(16).padStart(2, '0')}:${m.sub.toString(16).padStart(2, '0')}`;
      return `Param ${id} ${p ? p.key : '?'} = ${m.value}`;
    }
    case 'status': return m.name.replace(/_/g, ' ').toLowerCase();
  }
  return '?';
}

function setStatus(text, kind = '') {
  const el = $('#conn-status');
  el.textContent = text;
  el.className = `status-pill ${kind}`;
}

async function initMidi() {
  if (new URLSearchParams(location.search).has('sim')) await import('../../tools/fakesynth.js');
  if (!navigator.requestMIDIAccess) {
    setStatus('No Web MIDI — use Chrome or Edge', 'err');
    return;
  }
  try {
    state.midi = await navigator.requestMIDIAccess({ sysex: true });
  } catch (e) {
    setStatus('MIDI access denied', 'err');
    toast('MIDI access was blocked. Allow MIDI/SysEx for this page in the browser\'s site settings and reload.', 'err');
    return;
  }
  state.midi.onstatechange = () => populatePorts();
  populatePorts();
}


// Every input gets one permanent listener and is opened explicitly. Messages are counted per
// port (shown on the MIDI Log tab), offered to a running synth search, and passed to the
// editor if they come from the selected input.
const portStats = new Map(); // port id -> { count, sysex, last }
const wiredInputs = new WeakSet();
let discoveryListener = null;

function wireInputs() {
  for (const input of state.midi.inputs.values()) {
    if (wiredInputs.has(input)) continue;
    wiredInputs.add(input);
    input.addEventListener('midimessage', e => {
      const st = portStats.get(input.id) || { count: 0, sysex: 0, last: '' };
      const b = e.data;
      if (b[0] !== 0xf8 && b[0] !== 0xfe) {
        st.count++;
        if (b[0] === 0xf0) st.sysex++;
        st.last = hex(b.slice(0, 8));
        portStats.set(input.id, st);
      }
      discoveryListener?.(input, e);
      if (input === state.input) onMidiMessage(e);
    });
    input.open().catch(err => addLog('info', `Couldn't open input ${portLabel(input)}: ${err.message}`, []));
  }
}

function populatePorts() {
  wireInputs();
  const ins = [...state.midi.inputs.values()];
  const outs = [...state.midi.outputs.values()];
  const prefs = store.get('ports', {});
  const fill = (sel, ports, preferId, guess) => {
    const prev = sel.value;
    sel.replaceChildren(h('option', { value: '' }, '— none —'), ...ports.map(p => h('option', { value: p.id }, portLabel(p))));
    const pick = ports.find(p => p.id === prev) || ports.find(p => p.id === preferId) || ports.find(guess);
    sel.value = pick ? pick.id : '';
  };
  fill($('#midi-in'), ins, prefs.inId, looksLikeSynthIn);
  fill($('#midi-out'), outs, prefs.outId, looksLikeSynthOut);
  applyPorts();
  // Connect automatically once if anything that looks like the synth is plugged in.
  if (!autoFindTried && !state.synthFound && (ins.some(isKorg) || outs.some(isKorg))) {
    autoFindTried = true;
    findSynth({ quiet: true });
  }
}
let autoFindTried = false;

function applyPorts() {
  state.input = state.midi?.inputs.get($('#midi-in').value) || null;
  state.output = state.midi?.outputs.get($('#midi-out').value) || null;
  store.set('ports', { inId: state.input?.id, outId: state.output?.id });
  state.synthFound = false;
  if (!state.input && !state.output) setStatus('Pick MIDI ports');
  else setStatus('Ports selected', 'warn');
  updateButtons();
}

// Ask every output "are you a microKORG XL?" and listen on every input, so the right pair of
// ports is found no matter what the user picked.
async function discoverSynth() {
  const outs = [...state.midi.outputs.values()];
  const order = [state.output, ...outs.filter(looksLikeSynthOut), ...outs.filter(isKorg), ...outs].filter(Boolean);
  const tried = new Set();
  let heard = null;
  discoveryListener = (input, e) => {
    if (e.data[0] !== 0xf0) return;
    const m = parse(e.data);
    if (input !== state.input) addLog('in', `${describe(m)} (on ${portLabel(input)})`, e.data);
    if ((m?.type === 'identity' || m?.type === 'search') && m.isXL) heard = { input, reply: m };
  };
  try {
    await Promise.all([...state.midi.inputs.values()].map(i => i.open().catch(() => {})));
    for (const out of order) {
      if (tried.has(out.id)) continue;
      tried.add(out.id);
      for (const [bytes, desc] of [[msg.deviceInquiry(), 'Device inquiry'], [msg.searchDevice(), 'Korg search device']]) {
        try {
          await out.open();
          out.send(bytes);
        } catch (err) {
          addLog('info', `Couldn't send to ${portLabel(out)}: ${err.message}`, []);
          break;
        }
        addLog('out', `${desc} → ${portLabel(out)}`, bytes);
        const until = performance.now() + 1200;
        while (!heard && performance.now() < until) await new Promise(r => setTimeout(r, 25));
        if (heard) return { output: out, ...heard };
      }
    }
    return null;
  } finally {
    discoveryListener = null;
  }
}

let finding = null;

function findSynth(opts) {
  finding ||= findSynthOnce(opts).finally(() => { finding = null; });
  return finding;
}

async function findSynthOnce({ quiet = false } = {}) {
  if (!state.midi) { toast('MIDI isn\'t available. Use Chrome or Edge and allow MIDI access.', 'err'); return; }
  setStatus('Searching…', 'warn');
  const found = await discoverSynth();
  if (!found) {
    applyPorts();
    setStatus('Synth not found', 'err');
    if (!quiet) toast('No answer from the synth on any MIDI port. Open the MIDI Log tab: the port list there shows whether anything is arriving from the synth.', 'err');
    return;
  }
  $('#midi-in').value = found.input.id;
  $('#midi-out').value = found.output.id;
  applyPorts();
  state.channel = found.reply.channel;
  $('#midi-ch').value = found.reply.channel;
  state.synthFound = true;
  setStatus(`microKORG XL found${found.reply.version ? ` (v${found.reply.version})` : ''} · ch ${found.reply.channel + 1}`, 'ok');
  state.slot = null; // the current-program dump doesn't say which slot it came from
  await getFromSynth();
}

async function getFromSynth() {
  if (!state.output) { toast('Choose a MIDI output first.', 'err'); return; }
  send(msg.currentProgramRequest(state.channel));
  const r = await waitFor(m => m?.type === 'currentProgram', 1500);
  if (!r) toast('No program data came back. Check the MIDI input port and the SystemEx filter on the synth.', 'err');
}

function updateButtons() {
  const connected = !!state.output;
  for (const id of ['#btn-get', '#btn-send', '#btn-write']) $(id).disabled = !connected;
}

// ---------------------------------------------------------------------------------------------
// Controls

const ARC_START = -135;
const ARC_END = 135;
const polar = (cx, cy, r, deg) => {
  const a = (deg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};
const arcPath = (cx, cy, r, a0, a1) => {
  if (Math.abs(a1 - a0) < 0.01) return '';
  const [lo, hi] = a0 < a1 ? [a0, a1] : [a1, a0];
  const [x0, y0] = polar(cx, cy, r, lo);
  const [x1, y1] = polar(cx, cy, r, hi);
  return `M${x0},${y0} A${r},${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1},${y1}`;
};

function knob(p, label = p.label) {
  const [min, max] = range(p.fmt);
  const center = p.fmt.bias ?? p.fmt.center ?? (p.fmt.k === 'pan' ? 64 : null);
  const svg = svgEl('svg', { viewBox: '0 0 46 46', tabindex: 0, role: 'slider', 'aria-label': label,
    'aria-valuemin': min, 'aria-valuemax': max });
  const track = svgEl('path', { class: 'track', d: arcPath(23, 23, 18, ARC_START, ARC_END), 'stroke-width': 4, fill: 'none', 'stroke-linecap': 'round' });
  const fill = svgEl('path', { class: 'fill', 'stroke-width': 4, fill: 'none', 'stroke-linecap': 'round' });
  const cap = svgEl('circle', { class: 'cap', cx: 23, cy: 23, r: 12 });
  const needle = svgEl('line', { class: 'needle', 'stroke-width': 2, 'stroke-linecap': 'round' });
  svg.append(track, fill, cap, needle);
  const valueEl = h('div', { class: 'value' });
  const el = h('div', { class: 'knob' }, svg, valueEl, h('div', { class: 'label' }, label));

  const angle = v => ARC_START + (ARC_END - ARC_START) * (max === min ? 0 : (v - min) / (max - min));
  const update = v => {
    const a = angle(Math.max(min, Math.min(max, v)));
    const from = center !== null ? angle(center) : ARC_START;
    fill.setAttribute('d', arcPath(23, 23, 18, from, a));
    const [x0, y0] = polar(23, 23, 4, a);
    const [x1, y1] = polar(23, 23, 11, a);
    needle.setAttribute('x1', x0); needle.setAttribute('y1', y0);
    needle.setAttribute('x2', x1); needle.setAttribute('y2', y1);
    valueEl.textContent = format(p.fmt, v);
    svg.setAttribute('aria-valuenow', v);
    svg.setAttribute('aria-valuetext', format(p.fmt, v));
  };
  const cur = () => getValue(state.data, p);

  let drag = null;
  svg.addEventListener('pointerdown', e => {
    svg.setPointerCapture(e.pointerId);
    svg.focus();
    drag = { y: e.clientY, v: cur(), acc: 0 };
  });
  svg.addEventListener('pointermove', e => {
    if (!drag) return;
    const span = max - min;
    const pixels = e.shiftKey ? 600 : 180;
    const v = drag.v + (drag.y - e.clientY) / pixels * Math.max(span, 12);
    setParam(p, v);
  });
  const end = () => { drag = null; };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('dblclick', () => setParam(p, center ?? min));
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    setParam(p, cur() + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 10 : 1));
  }, { passive: false });
  svg.addEventListener('keydown', e => {
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
    if (step) { e.preventDefault(); setParam(p, cur() + step); }
    if (e.key === 'Home') setParam(p, min);
    if (e.key === 'End') setParam(p, max);
  });

  controls.set(p.key, update);
  update(cur());
  return el;
}

function choice(p, label = p.label) {
  const sel = h('select', { 'aria-label': label, onchange: e => setParam(p, +e.target.value) },
    p.fmt.o.map((o, i) => h('option', { value: i }, o)));
  sel.value = getValue(state.data, p);
  controls.set(p.key, v => { sel.value = v; });
  return h('label', { class: 'choice' }, h('span', { class: 'label' }, label), sel);
}

function toggle(p, label = p.label) {
  const btn = h('button', { type: 'button', 'aria-label': label,
    onclick: () => setParam(p, getValue(state.data, p) ? 0 : 1) });
  const update = v => btn.setAttribute('aria-pressed', v ? 'true' : 'false');
  update(getValue(state.data, p));
  controls.set(p.key, update);
  return h('div', { class: 'toggle' }, btn, h('span', { class: 'label' }, label));
}

function control(p, label) {
  if (p.fmt.k === 'enum') {
    const o = p.fmt.o;
    if (o.length === 2 && o[0] === 'Off' && o[1] === 'On') return toggle(p, label);
    return choice(p, label);
  }
  return knob(p, label);
}

function module(title, children, { wide = false, full = false, tag = '', inactive = false } = {}) {
  return h('section', { class: `module${wide ? ' wide' : ''}${full ? ' full' : ''}${inactive ? ' inactive' : ''}` },
    h('h3', {}, title, tag ? h('span', { class: 'tag' }, tag) : null),
    ...children);
}

const row = (...els) => h('div', { class: 'controls' }, ...els);

function envelopeGraph(params) {
  const svg = svgEl('svg', { class: 'env', viewBox: '0 0 240 56', preserveAspectRatio: 'none' });
  const area = svgEl('path', { class: 'area' });
  const line = svgEl('path', { class: 'line' });
  svg.append(svgEl('line', { x1: 0, y1: 54, x2: 240, y2: 54 }), area, line);
  const keys = new Set(params.map(p => p.key));
  const draw = () => {
    const [a, d, s, r] = params.map(p => getValue(state.data, p) / 127);
    const top = 4, bot = 54, H = bot - top;
    const xa = 4 + a * 62, xd = xa + d * 62, xs = xd + 40, xr = xs + r * 62;
    const ys = bot - s * H;
    const pts = `M4,${bot} L${xa},${top} L${xd},${ys} L${xs},${ys} L${xr},${bot}`;
    line.setAttribute('d', pts);
    area.setAttribute('d', pts + ' Z');
  };
  draw();
  dependents.add(p => { if (keys.has(p.key)) draw(); });
  return svg;
}

// ---------------------------------------------------------------------------------------------
// Views

function byKey(list) {
  return Object.fromEntries(list.map(p => [p.key.split('.').pop(), p]));
}

function renderTimbre(t) {
  const P = byKey(timbreParams(t));
  const v = k => getValue(state.data, P[k]);
  const vm = getValue(state.data, PROGRAM_PARAMS[0]);
  const [c1, c2] = oscCtrlLabelsFor(state.data, t);
  const wave = v('osc1Wave');
  const single = v('filterRouting') === 0;
  const kids = [];

  const notes = [];
  if (vm === 2) {
    const sp = PROGRAM_PARAMS.find(p => p.key === 'splitPoint');
    notes.push(h('p', { class: 'view-note' }, `Split mode: Timbre ${t + 1} plays ${t ? 'from' : 'below'} `,
      h('strong', {}, format(sp.fmt, getValue(state.data, sp))), t ? ' up.' : '.', ' Change the split point on the Program & Arp tab.'));
  }
  if (t === 1 && vm === 0) {
    notes.push(h('p', { class: 'view-note' }, 'Timbre 2 is only heard when ',
      h('strong', {}, 'Voice Mode'), ' is Layer, Split or Multi (set it on the Program & Arp tab).'));
  }
  const other = 1 - t;
  kids.push(h('div', { class: 'toolbar' },
    h('button', { class: 'small ghost', onclick: () => copyTimbre(other, t) }, `Copy Timbre ${other + 1} → ${t + 1}`),
    h('button', { class: 'small ghost', onclick: () => copyTimbre(t, other) }, `Copy Timbre ${t + 1} → ${other + 1}`),
  ));

  const lfo = n => {
    const bpm = v(`lfo${n}Bpm`);
    return module(`LFO ${n}`, [row(
      control(P[`lfo${n}Wave`]),
      bpm ? control(P[`lfo${n}Note`]) : control(P[`lfo${n}Freq`]),
      control(P[`lfo${n}Bpm`]),
      control(P[`lfo${n}KeySync`]),
    )]);
  };
  const eg = (n, title) => module(title, [
    envelopeGraph(['A', 'D', 'S', 'R'].map(s => P[`eg${n}${s}`])),
    row(...['A', 'D', 'S', 'R', 'Vel'].map(s => control(P[`eg${n}${s}`]))),
  ]);

  const grid = h('div', { class: 'grid' },
    module('Oscillator 1', [row(
      control(P.osc1Wave),
      wave <= 3 ? control(P.osc1Mod) : null,
      wave === 6 ? control(P.osc1Pcm, 'Wave No.') : null,
      c1 !== '(unused)' ? control(P.osc1Ctrl1, c1) : null,
      c2 !== '(unused)' ? control(P.osc1Ctrl2, c2) : null,
    )]),
    module('Oscillator 2', [row(control(P.osc2Wave), control(P.osc2Mod), control(P.osc2Semi), control(P.osc2Tune))]),
    module('Mixer', [row(control(P.osc1Level), control(P.osc2Level), control(P.noiseLevel))]),
    module('Filter 1', [row(control(P.filterRouting), control(P.f1Balance), control(P.f1Cutoff), control(P.f1Reso),
      control(P.f1EgInt), control(P.f1KeyTrack), control(P.f1VelSens))]),
    module('Filter 2', [row(control(P.f2Type), control(P.f2Cutoff), control(P.f2Reso), control(P.f2EgInt),
      control(P.f2KeyTrack), control(P.f2VelSens))], { inactive: single, tag: single ? 'off in Single routing' : '' }),
    module('Amp', [row(control(P.ampLevel), control(P.pan), control(P.ampKeyTrack), control(P.punch))]),
    module('Drive / Wave Shape', [row(control(P.wsType), control(P.wsPosition), control(P.wsDepth))]),
    eg(1, 'EG 1 · Filter'),
    eg(2, 'EG 2 · Amp'),
    eg(3, 'EG 3 · Assignable'),
    lfo(1),
    lfo(2),
    module('Voice', [row(control(P.voiceAssign), control(P.unison), control(P.unisonDetune), control(P.unisonSpread))]),
    module('Pitch', [row(control(P.transpose), control(P.detune), control(P.bendRange), control(P.vibrato),
      control(P.portamento), control(P.analogTune))]),
    module('Virtual Patch', Array.from({ length: 6 }, (_, i) => h('div', { class: 'patch-row' },
      h('span', { class: 'num' }, i + 1),
      choice(P[`patch${i + 1}Src`], 'Source'),
      choice(P[`patch${i + 1}Dst`], 'Destination'),
      knob(P[`patch${i + 1}Int`]),
    )), { wide: true }),
    module('EQ', [row(control(P.eqLowFreq), control(P.eqLowGain), control(P.eqHiFreq), control(P.eqHiGain))]),
    module('Panel Knobs 1–3', [row(control(P.knob1), control(P.knob2), control(P.knob3))]),
  );
  return [...notes, ...kids, grid];
}

function copyTimbre(from, to) {
  lastEditAt = performance.now();
  const src = 16 + from * 96;
  const dst = 16 + to * 96;
  state.data.copyWithin(dst, src, src + 96);
  setDirty(true);
  persistProgram();
  if (state.output) sendProgram(true);
  render();
  toast(`Copied Timbre ${from + 1} to Timbre ${to + 1}`, 'ok');
}

function renderFx() {
  const slot = s => {
    const ps = fxParams(state.data, s);
    const [type, ...rest] = ps;
    const assigns = rest.filter(p => p.key.endsWith('ctrl1') || p.key.endsWith('ctrl2'));
    const params = rest.filter(p => !assigns.includes(p) && fxParamActive(state.data, rest, p));
    return module(`Effect ${s + 1}`, [
      row(control(type), ...assigns.map(p => control({ ...p, fmt: { ...p.fmt, o: p.fmt.o.map(fxLabel) } }))),
      params.length ? h('div', { class: 'controls', style: 'margin-top:12px' }, params.map(p => control(p, fxLabel(p.label)))) : null,
    ], { wide: true, tag: s === 0 ? 'feeds into Effect 2' : '' });
  };
  return [h('div', { class: 'grid' }, slot(0), slot(1))];
}

function renderArp() {
  const P = byKey(PROGRAM_PARAMS);
  const A = byKey(arpParams());
  const last = getValue(state.data, A.lastStep);
  const steps = h('div', { class: 'steps' }, Array.from({ length: 8 }, (_, i) => {
    const p = A[`step${i + 1}`];
    const on = getValue(state.data, p);
    return h('button', { type: 'button', 'aria-pressed': on ? 'true' : 'false', class: i > last ? 'beyond' : '',
      title: `Step ${i + 1}`, onclick: () => setParam(p, on ? 0 : 1) }, i + 1);
  }));
  dependents.add(p => {
    if (p.key !== A.lastStep.key) return;
    const n = getValue(state.data, A.lastStep);
    [...steps.children].forEach((b, i) => b.classList.toggle('beyond', i > n));
  });
  return [h('div', { class: 'grid' },
    module('Program', [
      row(control(P.voiceMode), control(P.arpTimbre), control(P.timbre2Ch), control(P.octave),
        getValue(state.data, P.voiceMode) === 2 ? control(P.splitPoint) : null),
      getValue(state.data, P.voiceMode) === 2
        ? h('p', { class: 'view-note', style: 'margin:10px 0 0' }, `Split: Timbre 1 plays below ${format(P.splitPoint.fmt, getValue(state.data, P.splitPoint))}, Timbre 2 from there up.`)
        : null,
    ]),
    module('Scale', [row(control(P.scaleType), control(P.scaleKey))]),
    module('Arpeggiator', [
      row(control(A.on), control(A.tempo, 'Tempo (BPM)'), control(A.type), control(A.resolution), control(A.octave),
        control(A.gate), control(A.swing), control(A.latch), control(A.keySync), control(A.lastStep)),
      h('div', { style: 'margin-top:12px' }, h('div', { class: 'label', style: 'font-size:11px;color:var(--muted);margin-bottom:6px' }, 'Step on/off'), steps),
    ], { wide: true }),
  )];
}

function renderVocoder() {
  const V = byKey(vocoderParams());
  const bands = h('div', { class: 'bands' }, Array.from({ length: 16 }, (_, i) => {
    const lp = V[`band${i + 1}Level`];
    const slider = h('input', { type: 'range', min: 0, max: 127, 'aria-label': `Band ${i + 1} level`,
      oninput: e => setParam(lp, +e.target.value) });
    slider.value = getValue(state.data, lp);
    controls.set(lp.key, val => { slider.value = val; });
    return h('div', { class: 'band' }, slider, knob(V[`band${i + 1}Pan`], `Band ${i + 1} pan`), h('span', { class: 'bnum' }, i + 1));
  }));
  return [
    h('p', { class: 'view-note' }, 'The vocoder uses Timbre 1 as its carrier sound; the modulator is the mic/audio input (or Timbre 2).'),
    h('div', { class: 'grid' },
      module('Vocoder', [row(control(V.on), control(V.carrier, 'Modulator'), control(V.gateSens), control(V.threshold),
        control(V.hpfGate), control(V.hpfLevel))]),
      module('Mix', [row(control(V.direct), control(V.t1Level), control(V.t2Level), control(V.level))]),
      module('Formant Filter', [row(control(V.shift), control(V.cutoff), control(V.reso), control(V.fcModSrc),
        control(V.fcModInt), control(V.efSens))]),
      module('Bands · level & pan', [bands], { full: true }),
    ),
  ];
}

// ---- library ----

let fetching = false;

function renderLibrary() {
  const progress = h('div', { class: 'progress', hidden: !fetching }, h('div', { id: 'lib-progress' }));
  const banks = [0, 64].map(start => [
    h('div', { class: 'lib-bank' }, `Bank ${start ? 'B' : 'A'}`),
    h('div', { class: 'lib-grid' }, Array.from({ length: 64 }, (_, i) => librarySlot(start + i))),
  ]);
  return [
    h('p', { class: 'view-note' }, 'Read every program from the synth to browse them here and back them up as a single .syx file. ',
      'Click a program to open it in the editor (it\'s also sent to the synth so you can hear it).'),
    h('div', { class: 'toolbar' },
      h('button', { onclick: fetchAll, disabled: !state.output || fetching }, fetching ? 'Reading…' : 'Read all from synth'),
      progress,
      h('button', { class: 'ghost', onclick: saveBank, disabled: !state.library.some(Boolean) }, 'Save bank .syx'),
      h('button', { class: 'ghost', onclick: () => $('#file-input').click() }, 'Open .syx'),
      h('button', { class: 'ghost', onclick: sendBank, disabled: !state.output || !state.library.some(Boolean) }, 'Write bank to synth…'),
    ),
    ...banks.flat(),
  ];
}

function librarySlot(n) {
  const d = state.library[n];
  return h('button', {
    class: `lib-slot${d ? '' : ' empty'}${state.slot === n ? ' current' : ''}`,
    id: `lib-${n}`,
    disabled: !d,
    onclick: () => {
      loadProgram(state.library[n], { slot: n, send: !!state.output });
    },
  }, h('span', { class: 'n' }, slotName(n)), h('span', { class: 'nm' }, d ? programName(d) || '(blank)' : '—'));
}

function renderLibrarySlot(n) {
  const el = document.getElementById(`lib-${n}`);
  if (el) el.replaceWith(librarySlot(n));
}

async function fetchAll() {
  if (!state.output || fetching) return;
  fetching = true;
  render();
  let ok = 0;
  for (let n = 0; n < 128; n++) {
    send(msg.programRequest(state.channel, n), `Request program ${slotName(n)}`);
    const r = await waitFor(m => m?.type === 'program' && m.program === n, 2000);
    if (r) ok++;
    else if (n === 0) { toast('The synth didn\'t send program data. Check SystemEx is enabled on the synth.', 'err'); break; }
    const bar = document.getElementById('lib-progress');
    if (bar) bar.style.width = `${((n + 1) / 128) * 100}%`;
  }
  fetching = false;
  render();
  if (ok) toast(`Read ${ok} programs. Save bank .syx to keep a backup.`, 'ok');
}

async function sendBank() {
  const count = state.library.filter(Boolean).length;
  if (!confirm(`Write ${count} programs into the synth's memory? This replaces the programs stored in those slots.`)) return;
  let ok = 0;
  for (let n = 0; n < 128; n++) {
    const d = state.library[n];
    if (!d) continue;
    send(msg.programDump(state.channel, n, d), `Program ${slotName(n)} → memory`);
    const r = await waitFor(m => m?.type === 'status' && (m.func === FUNC.DATA_LOAD_COMPLETED || m.func === FUNC.DATA_LOAD_ERROR), 3000);
    if (!r || r.func !== FUNC.DATA_LOAD_COMPLETED) { toast(`Stopped at ${slotName(n)}: the synth didn't accept it. Is Memory Protect off?`, 'err'); break; }
    ok++;
  }
  if (ok) toast(`Wrote ${ok} programs to the synth.`, 'ok');
}

// ---- log & help ----

function addLog(dir, desc, bytes) {
  state.log.push({ dir, desc, bytes: Array.from(bytes), t: new Date() });
  if (state.log.length > 400) state.log.shift();
  if (state.tab === 'log') {
    const box = document.getElementById('log-box');
    if (box) { box.append(logLine(state.log[state.log.length - 1])); box.scrollTop = box.scrollHeight; }
  }
}

function logLine(e) {
  const bytes = e.bytes.length > 24 ? hex(e.bytes.slice(0, 24)) + ` … (${e.bytes.length} bytes)` : hex(e.bytes);
  return h('div', {},
    h('span', { class: `dir-${e.dir}` }, e.dir === 'in' ? '← ' : e.dir === 'out' ? '→ ' : '• '),
    h('span', { class: 'desc' }, e.desc), '  ', h('span', { class: 'bytes' }, bytes));
}

function portTable() {
  if (!state.midi) return h('p', { class: 'view-note', id: 'port-table' }, 'MIDI access not granted.');
  const row = (p, dir) => {
    const st = portStats.get(p.id);
    return h('tr', {},
      h('td', {}, dir), h('td', {}, portLabel(p)), h('td', {}, `${p.state}/${p.connection}`),
      h('td', {}, dir === 'in' ? String(st?.count || 0) : '—'), h('td', {}, dir === 'in' ? String(st?.sysex || 0) : '—'),
      h('td', { class: 'bytes' }, dir === 'in' ? st?.last || '' : ''));
  };
  return h('table', { class: 'ports', id: 'port-table' },
    h('caption', { style: 'text-align:left;padding-bottom:6px' }, `Chrome SysEx access: ${state.midi.sysexEnabled ? 'granted' : 'NOT granted'}`),
    h('tr', {}, ...['', 'Port', 'State', 'Received', 'SysEx', 'Last message'].map(t => h('th', {}, t))),
    ...[...state.midi.inputs.values()].map(p => row(p, 'in')),
    ...[...state.midi.outputs.values()].map(p => row(p, 'out')));
}

setInterval(() => {
  if (state.tab === 'log') document.getElementById('port-table')?.replaceWith(portTable());
}, 1000);

function renderLog() {
  const box = h('div', { class: 'log', id: 'log-box' }, state.log.map(logLine));
  setTimeout(() => { box.scrollTop = box.scrollHeight; });
  return [
    h('p', { class: 'view-note' }, 'MIDI ports as Chrome sees them. Play a key on the synth: the Received count of its KBD/KNOB port should go up.'),
    portTable(),
    h('p', { class: 'view-note', style: 'margin-top:14px' }, 'Every SysEx message between the editor and the synth. Turn a knob on the synth to see what it sends.'),
    h('div', { class: 'toolbar' },
      h('button', { class: 'small ghost', onclick: () => { state.log = []; render(); } }, 'Clear'),
      h('button', { class: 'small ghost', onclick: () => {
        navigator.clipboard.writeText(state.log.map(e => `${e.dir}\t${e.desc}\t${hex(e.bytes)}`).join('\n'))
          .then(() => toast('Log copied', 'ok'), () => toast('Couldn\'t copy', 'err'));
      } }, 'Copy'),
      h('span', { class: 'view-note', style: 'margin:0' }, state.calibrated
        ? `Parameter mode encoding: ${state.signedParams ? 'signed' : 'raw'} (confirmed)`
        : 'Parameter mode encoding: not confirmed yet — turn a bipolar knob on the synth (e.g. Filter EG Int) to confirm.'),
    ),
    box,
  ];
}

function renderHelp() {
  return [h('div', { class: 'help' },
    h('h2', {}, 'Getting connected'),
    h('ol', {},
      h('li', {}, 'Use ', h('strong', {}, 'Chrome'), ' or ', h('strong', {}, 'Edge'), '. Safari doesn\'t support Web MIDI.'),
      h('li', {}, 'Connect the microKORG XL by USB. When the browser asks, allow MIDI and SysEx access.'),
      h('li', {}, 'On the synth, set ', h('strong', {}, 'GLOBAL › MIDI Filter › SystemEx'), ' to Enable. Without it the synth ignores the editor. Enabling ',
        h('strong', {}, 'ProgChg'), ' too lets the editor follow you when you change programs on the synth.'),
      h('li', {}, 'Click ', h('strong', {}, 'Find synth'), '. It tries every MIDI port and picks the pair the synth answers on. The XL shows four ports: ',
        h('strong', {}, 'KBD/KNOB'), ' and ', h('strong', {}, 'SOUND'), ' are the synth itself; ', h('strong', {}, 'MIDI IN/OUT'), ' only pass data to the 5-pin sockets on its back.'),
      h('li', {}, 'The current program loads into the editor. Turn the program knob on the synth and the editor follows.'),
      h('li', {}, h('strong', {}, 'Synth not found?'), ' Relaunch Chrome (Cmd-Q, then reopen) with the synth plugged in. Chrome can stop passing SysEx to pages, especially while an update is waiting, even though notes still get through.'),
    ),
    h('h2', {}, 'Editing safely'),
    h('ol', {},
      h('li', {}, 'Every edit goes to the synth\'s ', h('strong', {}, 'edit buffer'), ' right away, so you hear it. Nothing is stored until you press ',
        h('strong', {}, 'Write to slot'), '. Changing programs on the synth discards unsaved edits, as on the hardware.'),
      h('li', {}, 'Before you change anything, go to ', h('strong', {}, 'Library › Read all from synth'), ' and ', h('strong', {}, 'Save bank .syx'), ' to back up all 128 programs.'),
      h('li', {}, 'Writing needs ', h('strong', {}, 'GLOBAL › Memory Protect'), ' turned off.'),
      h('li', {}, h('strong', {}, 'Send: Whole program'), ' resends the full patch on every edit. It always works, but held notes may retrigger. ',
        h('strong', {}, 'Send: Parameter'), ' sends only the changed value, which is smoother. Use the MIDI Log tab if anything behaves oddly.'),
    ),
    h('h2', {}, 'Presets and the AI Designer'),
    h('ol', {},
      h('li', {}, h('strong', {}, 'Presets'), ' lists the sound files in the project\'s presets folder. Click one to hear it. Add more by dropping .mkxl_all or .syx files into that folder.'),
      h('li', {}, h('strong', {}, 'AI Designer'), ' builds a sound from a description using Claude Code on this Mac. Click any of your Recent designs to load it; your next request then modifies that sound until you choose ', h('strong', {}, 'Start a new sound'), '. Use ', h('strong', {}, 'Undo'), ' to go back.'),
      h('li', {}, 'Both replace the sound you\'re editing, but nothing is saved on the synth until you Write to slot.'),
    ),
    h('h2', {}, 'Working without the synth'),
    h('p', {}, 'You can open, edit and save .syx files with no synth connected. Saved single programs load back into the synth\'s edit buffer; bank files go back with Library › Write bank to synth.'),
  )];
}

// ---------------------------------------------------------------------------------------------
// Presets (files in the project's presets/ folder, listed by serve.py)

const MY_BANK = 'My Sounds';
const BANK_LABELS = {
  [MY_BANK]: MY_BANK,
  MKXL_FactoryPreset: 'XL Factory',
  MK_FactoryPreset: 'microKORG classics',
  MS2K_FactoryPreset: 'MS2000 classics',
  MS2KB_FactoryPreset: 'MS2000B classics',
};
const bankLabel = bank => BANK_LABELS[bank] || bank.replace(/_/g, ' ');

const presets = {
  banks: [], status: 'idle', bank: 'all', category: '', query: '', current: null, type: '', voices: '',
  groupBy: store.get('presetGroupBy', 'type'), // 'type' | 'bank' | 'category' | 'none'
  sort: store.get('presetSort', 'original'), // 'original' | 'name'
  userTypes: {}, // types set in the editor, saved by serve.py in data/sound-types.json
  editing: null, // key of the preset whose type editor is open
};

// Sound type for the Presets grouping. For My Sounds, the original AI request ("acid bass")
// is a useful extra hint alongside the name.
// Each preset is typed under a key: "<bank>/<name>", or "My Sounds/<file>" for your own sounds.
const typeKeyOf = p => (p.file ? `${MY_BANK}/${p.file}` : `${p.bank}/${p.name.trim()}`);

function assignType(p) {
  p.typeKey = typeKeyOf(p);
  p.autoType = soundType(`${p.name} ${p.meta?.request || ''}`.trim(), programToAi(p.data).settings, p.typeKey);
  p.type = presets.userTypes[p.typeKey] || p.autoType;
}

const allTypes = () => [...TYPES, ...[...new Set(Object.values(presets.userTypes))].filter(t => !TYPES.includes(t)).sort()];

async function setPresetType(p, type) {
  try {
    const r = await fetch('api/types', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: p.typeKey, type: type === p.autoType ? null : type }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `error ${r.status}`);
    presets.userTypes = await r.json();
  } catch (e) {
    toast(e instanceof TypeError ? SERVER_DOWN : `Couldn't save the type: ${e.message}`, 'err');
    return;
  }
  // The same name in a bank shares one type (some banks contain duplicates).
  presets.banks.forEach(b => b.programs.forEach(q => { if (q.typeKey === p.typeKey) assignType(q); }));
  presets.editing = null;
  render();
}

// Read programs out of any supported file: Korg editor files or SysEx (.syx).
function programsFromFile(bytes) {
  if (isKorgEditorFile(bytes)) return parseKorgEditorFile(bytes).map(p => ({ ...p, slot: null }));
  const msgs = splitSysex(bytes);
  const parsed = msgs.map(parse).filter(Boolean);
  const progs = parsed.filter(m => m.type === 'program' || m.type === 'currentProgram')
    .map(m => ({ data: m.data, category: '', slot: m.type === 'program' ? m.program : null }));
  if (!progs.length && msgs.some(m => m[1] === 0x42 && (m[3] === 0x58 || m[2] === 0x58))) {
    throw new Error('That file is for the original microKORG, which uses a different sound engine. The "microKORG classics" bank has Korg\'s own conversions of those sounds for the XL.');
  }
  return progs;
}

async function loadPresetBanks() {
  if (presets.status !== 'idle') return;
  presets.status = 'loading';
  try {
    presets.userTypes = await fetch('api/types').then(r => (r.ok ? r.json() : {})).catch(() => ({}));
    const list = await fetch('api/presets').then(r => (r.ok ? r.json() : Promise.reject(new Error(r.status))));
    for (const { file, bank } of list) {
      try {
        const bytes = new Uint8Array(await fetch(`presets/${encodeURIComponent(file)}`).then(r => r.arrayBuffer()));
        const programs = programsFromFile(bytes).map((p, i) => ({ ...p, bank, name: programName(p.data), index: i }));
        programs.forEach(assignType);
        if (programs.length) presets.banks.push({ bank, programs });
      } catch { /* skip unreadable files */ }
    }
    await loadMySounds();
    presets.status = 'ready';
  } catch (err) {
    // Tell apart "no server" (a failed request, or a 404 from a plain web server or an old copy
    // of the editor) from a problem reading the files.
    presets.status = 'unavailable';
    presets.problem = err instanceof TypeError ? 'server' : /^(404|501)$/.test(err.message) ? 'old' : err.message || String(err);
    console.error('Loading presets failed:', err);
  }
  if (state.tab === 'presets' || state.tab === 'ai') render();
}

// The user's own collection: one .syx file per sound in data/my-sounds/, shown as the first bank.
async function loadMySounds() {
  let list = [];
  try { list = await fetch('api/my-sounds').then(r => (r.ok ? r.json() : [])); } catch { return; }
  const programs = [];
  for (const meta of list) {
    try {
      const bytes = new Uint8Array(await fetch(`my-sounds/${encodeURIComponent(meta.file)}`).then(r => r.arrayBuffer()));
      const [p] = programsFromFile(bytes);
      if (p) programs.push({ ...p, bank: MY_BANK, name: programName(p.data), index: programs.length, file: meta.file, meta });
    } catch { /* skip unreadable files */ }
  }
  programs.forEach(assignType);
  presets.banks = presets.banks.filter(b => b.bank !== MY_BANK);
  if (programs.length) presets.banks.unshift({ bank: MY_BANK, mine: true, programs });
}

async function addToMySounds(data, { request, summary } = {}) {
  const name = programName(data) || 'SOUND';
  try {
    const r = await fetch('api/my-sounds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, syx: msg.currentProgramDump(state.channel, data), request, summary }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `error ${r.status}`);
  } catch (e) {
    toast(e instanceof TypeError ? SERVER_DOWN : `Couldn't save: ${e.message}`, 'err');
    return;
  }
  await loadMySounds();
  toast(`Added "${name}" to My Sounds. Find it in the Presets tab.`, 'ok');
  if (state.tab === 'presets') render();
}

async function deleteMySound(p) {
  if (!confirm(`Remove "${p.name}" from My Sounds? (It's moved to data/my-sounds/deleted, not erased.)`)) return;
  try {
    const r = await fetch('api/my-sounds/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: p.file }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `error ${r.status}`);
  } catch (e) {
    toast(e instanceof TypeError ? SERVER_DOWN : `Couldn't remove it: ${e.message}`, 'err');
    return;
  }
  await loadMySounds();
  if (presets.bank === MY_BANK && !presets.banks.some(b => b.bank === MY_BANK)) presets.bank = 'all';
  render();
}

function findPreset(ref) {
  const [bank, ...rest] = String(ref).split('/');
  const name = rest.join('/').trim().toUpperCase();
  const all = presets.banks.flatMap(b => b.programs.map(p => ({ ...p, bank: b.bank })));
  const byName = p => p.name.trim().toUpperCase() === (name || bank.trim().toUpperCase());
  return all.find(p => p.bank === bank && byName(p)) || all.find(byName) || null;
}

function previewPreset(p, bank) {
  presets.current = `${bank}/${p.index}`;
  loadProgram(p.data, { slot: null, dirty: true, send: !!state.output });
  if (!state.output) toast('Loaded into the editor. Connect the synth to hear it.');
}

const GROUP_BY = { type: 'Type', bank: 'Bank', category: 'Category', none: 'Nothing' };
const SORT_BY = { original: 'Bank order', name: 'Name A–Z' };

const VOICES_FILTER = { '': 'All', poly: 'Poly (chords)', mono: 'Mono (one note)', mixed: 'Mono + Poly' };
// A small Poly / Mono label; its tooltip says which timbre does what.
const voiceBadge = v => h('span', { class: `vbadge ${v.kind}`, title: `${v.label}: ${v.detail}` }, v.label);

function renderPresets() {
  if (presets.status === 'idle' || presets.status === 'loading') {
    loadPresetBanks();
    return [h('p', { class: 'view-note' }, 'Loading presets…')];
  }
  if (presets.status === 'unavailable') {
    const retry = h('button', { class: 'ghost small', onclick: () => { presets.status = 'idle'; presets.banks = []; render(); } }, 'Try again');
    if (presets.problem === 'server') {
      return [h('p', { class: 'view-note' }, 'The editor\'s server isn\'t answering. Start it with ', h('strong', {}, 'Start Ostinato.command'), ', then ', retry)];
    }
    if (presets.problem === 'old') {
      return [h('p', { class: 'view-note' }, 'The server answering isn\'t this version of the editor (an older copy still running, or another web server). Double-click ',
        h('strong', {}, 'Start Ostinato.command'), ': it replaces an old editor. Then ', retry)];
    }
    return [h('p', { class: 'view-note' }, `Couldn't load the presets: ${presets.problem}. `, retry)];
  }
  if (!presets.banks.length) {
    return [h('p', { class: 'view-note' }, 'No presets found. Put .mkxl_all or .syx files in the project\'s ', h('strong', {}, 'presets'), ' folder and reload.')];
  }
  const banks = presets.bank === 'all' ? presets.banks : presets.banks.filter(b => b.bank === presets.bank);
  const all = banks.flatMap(b => b.programs.map(p => ({ p, bank: b.bank, mine: !!b.mine })));
  const categories = [...new Set(all.map(i => i.p.category).filter(Boolean))];
  const typesHere = allTypes().filter(t => all.some(i => i.p.type === t));
  all.forEach(({ p }) => { p.voicing ||= voicing(p.data); });
  const items = all.filter(({ p }) => (!presets.category || p.category === presets.category) && (!presets.type || p.type === presets.type)
    && (!presets.voices || p.voicing.kind === presets.voices));
  if (presets.sort === 'name') items.sort((x, y) => x.p.name.localeCompare(y.p.name));

  const select = (label, value, options, onchange) => h('label', { class: 'inline-select' }, label,
    h('select', { onchange: e => { onchange(e.target.value); render(); } },
      Object.entries(options).map(([v, text]) => h('option', { value: v, selected: value === v }, text))));
  const chip = (value, label) => h('button', {
    class: `chip${presets.bank === value ? ' on' : ''}`,
    onclick: () => { presets.bank = value; presets.category = ''; render(); },
  }, label);
  const search = h('input', { type: 'search', placeholder: 'Search names…', value: presets.query, class: 'search',
    oninput: e => { presets.query = e.target.value; renderPresetGrid(); } });

  const grid = h('div', { id: 'preset-grid' });
  const groupKey = i => ({ type: i.p.type, bank: bankLabel(i.bank), category: i.p.category || 'No category', none: '' })[presets.groupBy];
  const groupOrder = presets.groupBy === 'type' ? allTypes()
    : presets.groupBy === 'bank' ? presets.banks.map(b => bankLabel(b.bank))
      : presets.groupBy === 'category' ? [...categories, 'No category'] : [''];
  function renderPresetGrid() {
    const q = presets.query.trim().toUpperCase();
    const shown = items.filter(({ p }) => !q || p.name.toUpperCase().includes(q));
    const groups = groupOrder.map(g => [g, shown.filter(i => groupKey(i) === g)]).filter(([, list]) => list.length);
    grid.replaceChildren(...groups.flatMap(([g, list]) => [
      g ? h('h3', { class: 'preset-group' }, g, h('span', { class: 'count' }, String(list.length))) : null,
      h('div', { class: 'preset-grid' }, list.map(presetItem)),
    ]).filter(Boolean));
    if (!shown.length) grid.append(h('p', { class: 'view-note' }, 'No matches.'));
  }
  function presetItem({ p, bank, mine }) {
    const meta = [
      presets.groupBy !== 'type' ? p.type : '',
      mine && p.meta?.request ? `“${p.meta.request}”` : p.category,
      presets.bank === 'all' && presets.groupBy !== 'bank' ? bankLabel(bank) : '',
    ].filter(Boolean).join(' · ');
    const tile = h('button', {
      class: `preset${presets.current === `${bank}/${p.index}` ? ' current' : ''}`,
      title: [mine && p.meta?.request && `Asked for: ${p.meta.request}`, mine && p.meta?.summary, 'Option-click to change its type']
        .filter(Boolean).join('\n\n'),
      onclick: e => {
        if (e.altKey) { presets.editing = p.typeKey; renderPresetGrid(); return; }
        previewPreset(p, bank);
        grid.querySelectorAll('.preset.current').forEach(x => x.classList.remove('current'));
        e.currentTarget.classList.add('current');
      },
    }, h('span', { class: 'nm' }, p.name || '(blank)'),
      h('span', { class: 'meta' }, voiceBadge(p.voicing), meta ? ` ${meta}` : ''));
    return h('div', { class: 'preset-wrap' }, tile,
      h('span', { class: 'tile-actions' },
        h('button', { class: 'tile-btn', title: `Change ${p.name}'s type`, 'aria-label': `Change type of ${p.name}`,
          onclick: () => { presets.editing = presets.editing === p.typeKey ? null : p.typeKey; renderPresetGrid(); } }, '✎'),
        mine ? h('button', { class: 'tile-btn del', title: `Remove ${p.name} from My Sounds`, 'aria-label': `Remove ${p.name}`,
          onclick: () => deleteMySound(p) }, '×') : null),
      presets.editing === p.typeKey ? typeEditor(p) : null);
  }
  function typeEditor(p) {
    const custom = h('input', { type: 'text', placeholder: 'New type…', maxlength: 40,
      onkeydown: e => { if (e.key === 'Enter' && e.target.value.trim()) setPresetType(p, e.target.value.trim()); } });
    const box = h('div', { class: 'type-editor', role: 'dialog', 'aria-label': `Type for ${p.name}`,
      onkeydown: e => { if (e.key === 'Escape') { presets.editing = null; renderPresetGrid(); } } },
      h('div', { class: 'te-head' }, `Type for ${p.name.trim()}`,
        h('button', { class: 'tile-btn', 'aria-label': 'Close', onclick: () => { presets.editing = null; renderPresetGrid(); } }, '×')),
      h('div', { class: 'te-types' }, allTypes().map(t => h('button', {
        class: `chip${p.type === t ? ' on' : ''}`, onclick: () => setPresetType(p, t),
      }, t))),
      h('div', { class: 'te-foot' }, custom,
        presets.userTypes[p.typeKey]
          ? h('button', { class: 'small ghost', onclick: () => setPresetType(p, p.autoType), title: `Automatic guess: ${p.autoType}` }, 'Use automatic')
          : h('span', { class: 'view-note', style: 'margin:0' }, 'Automatic guess')));
    setTimeout(() => box.querySelector('.chip.on')?.focus());
    return box;
  }
  renderPresetGrid();

  const myBank = presets.bank === MY_BANK;
  return [
    h('p', { class: 'view-note' }, 'Click a preset to hear it. Nothing is saved on the synth until you ', h('strong', {}, 'Write to slot'),
      '. Use ✎ (or Option-click a tile) to change a sound\'s type.'),
    h('div', { class: 'toolbar' }, chip('all', 'All'), ...presets.banks.map(b => chip(b.bank, bankLabel(b.bank)))),
    h('div', { class: 'toolbar' },
      search,
      select('Type', presets.type, { '': 'All', ...Object.fromEntries(typesHere.map(t => [t, t])) }, v => { presets.type = v; }),
      select('Voices', presets.voices, VOICES_FILTER, v => { presets.voices = v; }),
      categories.length ? select('Category', presets.category, { '': 'All', ...Object.fromEntries(categories.map(c => [c, c])) }, v => { presets.category = v; }) : null,
      select('Group by', presets.groupBy, GROUP_BY, v => { presets.groupBy = v; store.set('presetGroupBy', v); }),
      select('Sort', presets.sort, SORT_BY, v => { presets.sort = v; store.set('presetSort', v); })),
    h('div', { class: 'toolbar' },
      myBank ? h('button', { class: 'small', onclick: exportMySounds }, 'Export My Sounds as .syx') : null,
      myBank || presets.bank === 'all' ? h('button', { class: 'small ghost', onclick: () => $('#import-mine').click() }, 'Import .syx into My Sounds') : null,
      presets.bank !== 'all' && !myBank ? h('button', { class: 'small ghost', onclick: () => copyBankToLibrary(presets.bank) }, 'Copy bank to Library') : null,
      h('input', { type: 'file', id: 'import-mine', accept: '.syx,.SYX,.mkxl_all', hidden: true,
        onchange: e => { const f = e.target.files[0]; if (f) importIntoMySounds(f); e.target.value = ''; } })),
    grid,
  ];
}

// My Sounds as one file: a sequence of single-program dumps, one per sound, in My Sounds order.
// Opening it in the editor (or re-importing it here) gets every sound back.
function exportMySounds() {
  const mine = presets.banks.find(b => b.bank === MY_BANK);
  if (!mine) return;
  const bytes = mine.programs.flatMap(p => msg.currentProgramDump(state.channel, p.data));
  download(bytes, `My Sounds ${new Date().toISOString().slice(0, 10)}.syx`);
  toast(`Exported ${mine.programs.length} sounds.`, 'ok');
}

async function importIntoMySounds(file) {
  let progs;
  try { progs = programsFromFile(new Uint8Array(await file.arrayBuffer())); } catch (e) { toast(e.message, 'err'); return; }
  if (!progs.length) { toast('No microKORG XL sounds found in that file.', 'err'); return; }
  if (progs.length > 20 && !confirm(`Add all ${progs.length} sounds from ${file.name} to My Sounds?`)) return;
  let n = 0;
  for (const p of progs) {
    try {
      const r = await fetch('api/my-sounds', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: programName(p.data) || 'SOUND', syx: msg.currentProgramDump(state.channel, p.data), request: `Imported from ${file.name}` }) });
      if (r.ok) n++;
    } catch { toast(SERVER_DOWN, 'err'); break; }
  }
  await loadMySounds();
  presets.bank = MY_BANK;
  render();
  toast(`Added ${n} sound${n === 1 ? '' : 's'} to My Sounds.`, 'ok');
}

function copyBankToLibrary(bank) {
  const b = presets.banks.find(x => x.bank === bank);
  if (!b) return;
  b.programs.slice(0, 128).forEach((p, i) => { state.library[p.slot ?? i] = p.data; });
  toast(`Copied ${Math.min(128, b.programs.length)} programs to the Library. Use Library › Write bank to synth to install them.`, 'ok');
}

// ---------------------------------------------------------------------------------------------
// AI sound designer (runs Claude Code through serve.py)

const ai = {
  // The sound the next request will modify: { sessionId } of its Claude Code conversation,
  // or null to design a new sound. selectedKey marks the highlighted Recent designs row.
  context: null,
  selectedKey: null,
  variations: Math.min(4, Math.max(1, +store.get('aiVariations', 1) || 1)),
  available: null, // null = unknown, true/false after /api/status
  running: false,
  sessionId: null,
  history: [], // { request, result?, error?, steps: [] }
  undo: null,
  abort: null,
  draft: '',
};

const AI_EXAMPLES = [
  'Warm analog pad with a slow attack and gentle movement',
  'Squelchy 303-style acid bass',
  '80s synth brass stab',
  'Glassy bell pluck with a dotted-eighth echo',
  'Detuned supersaw lead for trance',
  'Deep sub bass with a little grit',
];

// ---------------------------------------------------------------------------------------------
// AI settings: which provider and model the AI features use (serve.py keeps them in
// settings.local.json; API keys are never sent back to the page)

const aiSet = { open: false, data: null, draft: null, models: {}, loadingModels: '', saving: false, message: '' };

async function loadAiSettings() {
  try {
    const r = await fetch('api/ai-settings');
    aiSet.data = await r.json();
  } catch { aiSet.data = null; }
  aiSet.draft = aiSet.data && {
    provider: aiSet.data.provider,
    'claude-code': { model: aiSet.data['claude-code'].model },
    anthropic: { model: aiSet.data.anthropic.model, api_key: '' },
    openai: { service: aiSet.data.openai.service, base_url: aiSet.data.openai.base_url, model: aiSet.data.openai.model, api_key: '' },
  };
  if (state.tab === 'ai') render();
}

async function loadModels(provider) {
  aiSet.loadingModels = provider;
  aiSet.message = '';
  render();
  try {
    const r = await fetch(`api/ai-models?provider=${provider}`);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    aiSet.models[provider] = j.models;
  } catch (e) {
    aiSet.message = `Couldn't list models: ${e.message}`;
  }
  aiSet.loadingModels = '';
  render();
}

async function saveAiSettings() {
  const d = aiSet.draft;
  const body = {
    provider: d.provider,
    'claude-code': { model: d['claude-code'].model },
    anthropic: { model: d.anthropic.model, api_key: d.anthropic.api_key || null }, // null keeps the saved key
    openai: { service: d.openai.service, base_url: d.openai.base_url, model: d.openai.model, api_key: d.openai.api_key || null },
  };
  aiSet.saving = true;
  render();
  try {
    const r = await fetch('api/ai-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    aiSet.message = j.ready ? `Saved. Using ${j.label}.` : `Saved, but not ready yet: ${j.problem}`;
    await loadAiSettings();
    ai.available = null; // check the provider again
  } catch (e) {
    aiSet.message = e instanceof TypeError ? SERVER_DOWN : `Couldn't save: ${e.message}`;
  }
  aiSet.saving = false;
  render();
}

function aiSettingsPanel() {
  if (!aiSet.data) { loadAiSettings(); return h('p', { class: 'view-note' }, 'Loading AI settings…'); }
  const d = aiSet.draft, s = aiSet.data;
  const field = (label, control, hint) => h('label', { class: 'set-field' }, h('span', { class: 'set-label' }, label), control, hint ? h('span', { class: 'set-hint' }, hint) : null);
  const select = (value, options, onchange) => h('select', { onchange: e => { onchange(e.target.value); render(); } },
    options.map(([v, t]) => h('option', { value: v, selected: v === value }, t)));
  const keyInput = (part, source, placeholder) => h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', value: d[part].api_key,
    placeholder: source === 'saved' ? 'Saved (type a new key to replace it)' : source === 'environment' ? 'Using the key from your environment' : placeholder,
    oninput: e => { d[part].api_key = e.target.value.trim(); } });
  const modelPicker = (provider, value, set, fallback) => {
    const list = aiSet.models[provider] || fallback || [];
    const options = [...new Set([value, ...list].filter(Boolean))];
    return h('span', { class: 'set-row' },
      options.length ? select(value, options.map(m => [m, m]), set) : h('input', { value, placeholder: 'model name', oninput: e => set(e.target.value.trim()) }),
      h('button', { class: 'small ghost', disabled: aiSet.loadingModels === provider, onclick: () => loadModels(provider) },
        aiSet.loadingModels === provider ? 'Loading…' : 'List models'));
  };
  const needsPackages = d.provider !== 'claude-code' && !s.packages;
  const svc = s.openai.services.find(x => x.id === d.openai.service);

  let details;
  if (d.provider === 'claude-code') {
    details = [
      h('p', { class: 'set-hint' }, s['claude-code'].installed
        ? 'Uses the claude command on this computer with your own Claude login. No API key needed.'
        : 'Claude Code (the claude command) isn’t installed on this computer.'),
      field('Model', select(d['claude-code'].model, s['claude-code'].models.map(m => [m, m || 'Claude Code’s default']), v => { d['claude-code'].model = v; })),
    ];
  } else if (d.provider === 'anthropic') {
    details = [
      field('API key', keyInput('anthropic', s.anthropic.key, 'sk-ant-…'),
        h('span', {}, 'Create one at ', h('a', { href: 'https://console.anthropic.com/settings/keys', target: '_blank', rel: 'noopener' }, 'console.anthropic.com'),
          '. It’s stored in data/settings.local.json on this computer (never in git).')),
      field('Model', modelPicker('anthropic', d.anthropic.model, v => { d.anthropic.model = v; }, s.anthropic.models)),
    ];
  } else {
    details = [
      field('Service', select(d.openai.service, s.openai.services.map(x => [x.id, x.label]), v => {
        d.openai.service = v; d.openai.base_url = v === 'custom' ? d.openai.base_url : ''; d.openai.model = ''; aiSet.models.openai = null;
      })),
      d.openai.service === 'custom' || d.openai.base_url
        ? field('Address', h('input', { value: d.openai.base_url, placeholder: svc.base_url || 'http://localhost:8000/v1', oninput: e => { d.openai.base_url = e.target.value.trim(); } }),
          'The server’s OpenAI-compatible address, usually ending in /v1.')
        : h('p', { class: 'set-hint' }, `Address: ${svc.base_url}`),
      svc.needs_key || d.openai.service === 'custom'
        ? field('API key', keyInput('openai', s.openai.key, svc.needs_key ? 'Paste your API key' : 'Only if the server needs one'),
          svc.key_env ? `Stored in data/settings.local.json (never in git), or set ${svc.key_env}.` : null)
        : null,
      field('Model', modelPicker('openai', d.openai.model, v => { d.openai.model = v; })),
      ['ollama', 'lmstudio'].includes(d.openai.service)
        ? h('p', { class: 'set-hint' }, 'Models on this computer are free but slow, and need enough memory: pick one that fits in your RAM. ',
          'Sound design needs a large context: in Ollama’s Settings, set Context length to 16k or more. Web search isn’t available here.')
        : h('p', { class: 'set-hint' }, 'Web search isn’t available through this kind of provider; the AI relies on what it knows.'),
    ];
  }
  return h('section', { class: 'ai-settings' },
    h('div', { class: 'set-head' }, h('h3', {}, 'AI settings'),
      h('button', { class: 'tile-btn', 'aria-label': 'Close', onclick: () => { aiSet.open = false; render(); } }, '×')),
    h('div', { class: 'set-providers' }, s.providers.map(p => h('label', { class: `set-provider${d.provider === p.id ? ' on' : ''}` },
      h('input', { type: 'radio', name: 'ai-provider', checked: d.provider === p.id, onchange: () => { d.provider = p.id; aiSet.message = ''; render(); } }), p.label))),
    needsPackages ? h('p', { class: 'set-warn' }, 'This provider needs the editor to be started with uv (Start Ostinato.command does this; install uv with: brew install uv).') : null,
    ...details,
    h('div', { class: 'set-row' },
      h('button', { class: 'accent', disabled: aiSet.saving, onclick: saveAiSettings }, aiSet.saving ? 'Saving…' : 'Save'),
      h('span', { class: `set-status${s.ready ? ' ok' : ''}` }, aiSet.message || (s.ready ? `Ready: ${s.label}` : `Not ready: ${s.problem}`))));
}

async function checkAi() {
  if (ai.available !== null) return;
  try {
    const r = await fetch('api/status');
    const j = r.ok ? await r.json() : {};
    ai.available = !!j.ai;
    ai.problem = j.problem || '';
    ai.provider = j.provider || '';
  } catch { ai.available = 'server-down'; }
  if (state.tab === 'ai') render();
}

async function runDesign() {
  const box = document.getElementById('ai-input');
  const message = (box?.value || '').trim();
  if (!message || ai.running) return;
  const mode = ai.context ? 'refine' : 'new';
  ai.sessionId = ai.context?.sessionId || null;
  if (presets.status === 'idle') loadPresetBanks();
  const entry = { request: message, mode, steps: [], started: Date.now(), variations: ai.variations };
  ai.history = [entry]; // only the sound being worked on is shown; past ones are in Recent designs
  ai.running = true;
  ai.draft = '';
  ai.abort = new AbortController();
  render();
  const tick = setInterval(() => {
    const el = document.getElementById('ai-elapsed');
    if (el) el.textContent = `${Math.round((Date.now() - entry.started) / 1000)}s`;
  }, 1000);
  try {
    const res = await fetch('api/design', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, mode, session_id: ai.sessionId, current: programToAi(state.data), variations: ai.variations }),
      signal: ai.abort.signal,
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Server error ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) handleAiEvent(entry, JSON.parse(line));
      }
    }
    if (!entry.result && !entry.variants && !entry.error) entry.error = 'No answer came back.';
  } catch (e) {
    entry.error = e.name === 'AbortError' ? 'Cancelled.'
      : e instanceof TypeError ? SERVER_DOWN : e.message;
  } finally {
    clearInterval(tick);
    ai.running = false;
    ai.recent = null;
    ai.abort = null;
    entry.seconds = Math.round((Date.now() - entry.started) / 1000);
    if (state.tab === 'ai') render();
  }
}

const SERVER_DOWN = 'The editor\'s server isn\'t running. Double-click Start Ostinato.command, leave its Terminal window open, then try again.';

function handleAiEvent(entry, ev) {
  if (ev.type === 'step' || ev.type === 'note') {
    entry.steps.push(ev);
    const list = document.getElementById('ai-steps');
    if (list) list.append(aiStep(ev));
  } else if (ev.type === 'error') {
    entry.error = ev.text;
  } else if (ev.type === 'result') {
    ai.sessionId = ev.session_id || ai.sessionId;
    ai.context = { sessionId: ai.sessionId };
    ai.selectedKey = null; // highlight the newest row of this conversation once the list reloads
    if (Array.isArray(ev.output.variations)) {
      ai.undo = programBytes();
      entry.variants = ev.output.variations.map(v => buildDesign(v));
      if (entry.variants.length) playVariant(entry.variants[0]);
    } else {
      entry.result = applyDesign(ev.output);
    }
  }
}

// `snapshot` is the editor's settings at the time of the request (for recovered designs whose
// base is "current", which then means the sound being edited back then, not now).
function buildDesign(out, snapshot) {
  let base = state.data.slice(0, state.dataLen);
  let baseLabel = 'your current sound';
  const ref = String(out.base || 'current');
  if (ref === 'current' && snapshot?.settings && Object.keys(snapshot.settings).length) {
    base = initProgram();
    applyAiChanges(base, snapshot.settings, snapshot.name);
    baseLabel = `the sound you had then${snapshot.name ? ` (${snapshot.name.trim()})` : ''}`;
  } else if (ref === 'init') {
    base = initProgram();
    baseLabel = 'a plain init patch';
  } else if (ref !== 'current') {
    const p = findPreset(ref);
    if (p) { base = p.data.slice(); baseLabel = `${p.name.trim()} (${bankLabel(p.bank)})`; } else baseLabel = `your current sound (preset "${ref}" not found)`;
  }
  const data = new Uint8Array(Math.max(PROGRAM_SIZE, base.length));
  data.set(base);
  const { applied, errors } = applyAiChanges(data, out.changes, out.name);
  return { name: out.name, summary: out.summary, baseLabel, applied, errors, data: data.slice(0, base.length) };
}

// Build a design and load it into the editor (and the synth), remembering the previous sound for Undo.
function applyDesign(out, snapshot) {
  const beforeAi = programToAi(state.data).settings;
  const result = buildDesign(out, snapshot);
  ai.undo = programBytes();
  loadProgram(result.data, { slot: state.slot, dirty: true, send: !!state.output });
  const after = programToAi(state.data).settings;
  const changed = Object.keys(after).filter(k => JSON.stringify(after[k]) !== JSON.stringify(beforeAi[k]));
  return { ...result, changed, before: beforeAi, after, data: programBytes() };
}

function playVariant(v) {
  loadProgram(v.data, { slot: null, dirty: true, send: !!state.output });
}

function aiStep(ev) {
  return h('li', { class: ev.type === 'note' ? 'note' : '' }, ev.text);
}

// Recent designs: serve.py saves every AI request and its results in ai-designs/, one file each.
ai.recent = null; // null = not loaded yet, array once loaded

async function loadRecent() {
  try {
    ai.recent = await fetch('api/designs').then(r => (r.ok ? r.json() : []));
  } catch { ai.recent = []; }
  if (state.tab === 'ai') render();
}

const recentKey = d => d.key; // "<file in ai-designs/>|<variation>", from serve.py

// Removing only flags it in its ai-designs/ file, so it can be restored.
async function hideRecent(d, hidden = true) {
  try {
    const r = await fetch('api/designs/hide', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: recentKey(d), hidden }) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `error ${r.status}`);
    d.hidden = hidden;
  } catch (e) {
    toast(e instanceof TypeError ? SERVER_DOWN : `Couldn't update the list: ${e.message}`, 'err');
  }
  render();
}

// Load a past design and make it the sound the next request modifies (continuing its conversation).
function loadRecentDesign(d) {
  if (ai.running || !d.output) return;
  if (presets.status === 'idle') loadPresetBanks();
  const entry = { request: d.request, mode: d.mode, steps: [], recovered: true };
  entry.result = applyDesign(d.output, d.current);
  ai.history = [entry];
  ai.context = { sessionId: d.session_id };
  ai.selectedKey = recentKey(d);
  render();
}

function startFresh() {
  ai.context = null;
  ai.selectedKey = null;
  ai.history = [];
  render();
  document.getElementById('ai-input')?.focus();
}

function timeAgo(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!(s >= 0)) return '';
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderRecent() {
  if (ai.recent === null) { loadRecent(); return h('p', { class: 'view-note' }, 'Loading recent designs…'); }
  const removed = ai.recent.filter(d => d.hidden);
  const shown = ai.recent.filter(d => !d.hidden);
  if (!ai.recent.length) return null;
  // Highlight the clicked row, or else the newest row of the conversation being modified.
  const name = programName(state.data).trim();
  const selected = ai.selectedKey
    || (ai.context && ai.recent.find(d => d.output && d.session_id === ai.context.sessionId && d.output.name.trim() === name)
      && recentKey(ai.recent.find(d => d.output && d.session_id === ai.context.sessionId && d.output.name.trim() === name)));
  return h('section', { class: 'recent' },
    h('h2', {}, 'Recent designs', h('button', { class: 'small ghost', onclick: () => { ai.recent = null; render(); } }, 'Refresh')),
    h('p', { class: 'view-note' }, 'Click one to load it; your next request will then modify it. Every request is saved in the ',
      h('strong', {}, 'ai-designs'), ' folder, even if the page closes while it runs. ✕ removes one from this list; ', h('strong', {}, 'Add to My Sounds'), ' puts a sound in Presets.'),
    h('div', { class: 'recent-list' }, shown.map(d => {
      const running = !d.output && Date.now() - new Date(d.time).getTime() < 6 * 60 * 1000;
      const on = d.output && recentKey(d) === selected;
      return h('button', {
        class: `recent-row${d.output ? '' : ' unfinished'}${on ? ' on' : ''}`,
        disabled: !d.output || ai.running,
        'aria-pressed': on ? 'true' : 'false',
        title: d.output?.summary || null,
        onclick: () => loadRecentDesign(d),
      },
        h('span', { class: 'ai-name' }, d.output ? d.output.name : running && d.status === 'running' ? 'working…' : 'didn\'t finish',
          d.variant ? h('span', { class: 'tag', style: 'margin-left:6px' }, `${d.variant}/${d.of}`) : null),
        h('span', { class: 'req' }, d.mode === 'refine' ? `Modify: ${d.request}` : d.request),
        h('span', { class: 'when' }, timeAgo(d.time)));
    }).map((row, k) => h('div', { class: 'recent-wrap' }, row,
      h('button', { class: 'tile-btn del', title: 'Remove from this list', 'aria-label': 'Remove from Recent designs',
        onclick: () => hideRecent(shown[k]) }, '×')))),
    removed.length ? h('details', { class: 'recent-removed' },
      h('summary', {}, `Removed (${removed.length})`),
      h('div', { class: 'recent-list' }, removed.map(d => h('div', { class: 'recent-row unfinished' },
        h('span', { class: 'ai-name' }, d.output?.name || '—'),
        h('span', { class: 'req' }, d.request),
        h('button', { class: 'small ghost', onclick: () => hideRecent(d, false) }, 'Restore'))))) : null);
}

function renderAi() {
  checkAi();
  if (presets.status === 'idle') loadPresetBanks();
  if (ai.available === 'server-down') {
    ai.available = null; // check again next time the tab is opened
    return [h('div', { class: 'help' }, h('h2', {}, 'AI Designer needs the editor\'s server'), h('p', {}, SERVER_DOWN))];
  }
  if (ai.available === false) {
    return [h('div', { class: 'help' },
      h('h2', {}, 'AI Designer isn\'t set up yet'),
      h('p', {}, ai.problem || 'The chosen AI provider isn\'t ready.', ' Choose a provider below: Claude Code (with your Claude login), the Anthropic API, or an OpenAI-compatible service such as OpenAI, Gemini, OpenRouter, or a model running on this computer with Ollama or LM Studio.')),
      aiSettingsPanel()];
  }
  const current = programName(state.data).trim() || 'this sound';
  const input = h('textarea', { id: 'ai-input', rows: 3,
    placeholder: ai.context ? `Describe a change to ${current}, e.g. "darker, with more echo"` : 'Describe a sound, e.g. "a dark, slowly evolving pad like Blade Runner"',
    disabled: ai.running, oninput: e => { ai.draft = e.target.value; },
    onkeydown: e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) runDesign(); } });
  input.value = ai.draft;
  const last = ai.history[ai.history.length - 1];
  return [
    h('div', { class: 'ai-provider-bar' },
      h('span', { class: 'view-note', style: 'margin:0' }, 'AI: ', h('strong', {}, ai.provider || '…')),
      h('button', { class: 'small ghost', onclick: () => { aiSet.open = !aiSet.open; if (aiSet.open) loadAiSettings(); render(); } }, '⚙ AI settings')),
    aiSet.open ? aiSettingsPanel() : null,
    h('p', { class: 'view-note' }, 'Describe a sound and the AI builds it, using the factory presets as references (and the web, where the provider can search). ',
      'The result is sent to the synth so you can play it right away. Then ask for changes ("brighter", "less echo") or tweak it yourself.'),
    h('div', { class: 'ai-compose' },
      h('div', { class: 'ai-context' }, ai.context
        ? [h('span', {}, 'Modifying ', h('strong', {}, current), ' — your next request changes this sound.'),
          h('button', { class: 'small ghost', disabled: ai.running, onclick: startFresh }, 'Start a new sound')]
        : h('span', {}, 'New sound — describe what you want.')),
      input,
      h('div', { class: 'toolbar' },
        h('button', { class: 'accent', disabled: ai.running, onclick: () => runDesign() }, ai.context ? `Modify ${current}` : 'Design new sound'),
        h('label', { class: 'variations', title: 'How many different takes to get back from one request' }, 'Variations',
          h('select', { disabled: ai.running, onchange: e => { ai.variations = +e.target.value; store.set('aiVariations', ai.variations); } },
            [1, 2, 3, 4].map(n => h('option', { value: n, selected: ai.variations === n }, n)))),
        ai.running ? h('button', { class: 'ghost', onclick: () => ai.abort?.abort() }, 'Cancel') : null,
        ai.undo && !ai.running ? h('button', { class: 'ghost', onclick: undoAi }, 'Undo last AI change') : null,
      ),
      !ai.context && !ai.history.length ? h('div', { class: 'toolbar examples' }, h('span', { class: 'view-note', style: 'margin:0' }, 'Try:'),
        AI_EXAMPLES.map(x => h('button', { class: 'chip', onclick: () => { ai.draft = x; render(); document.getElementById('ai-input')?.focus(); } }, x))) : null,
    ),
    last ? h('div', { class: 'ai-history' }, aiEntry(last, true)) : null,
    renderRecent(),
  ];
}

function aiEntry(e, isLast) {
  const steps = h('ul', { class: 'ai-steps', id: isLast && ai.running ? 'ai-steps' : null }, e.steps.map(aiStep));
  const head = h('div', { class: 'ai-request' }, h('span', { class: 'tag' }, e.mode === 'refine' ? 'Modify' : 'New'), ' ', e.request);
  if (isLast && ai.running) {
    return h('section', { class: 'module ai-entry' }, head,
      h('div', { class: 'ai-working' }, h('span', { class: 'spinner' }), 'Working… ', h('span', { id: 'ai-elapsed' }, '0s'),
        h('span', { class: 'view-note', style: 'margin:0 0 0 8px' }, e.variations > 1 ? 'Usually 1–3 minutes for several variations' : 'Usually 30–90 seconds')), steps);
  }
  if (e.error) return h('section', { class: 'module ai-entry' }, head, h('p', { class: 'ai-error' }, e.error));
  if (e.variants) {
    const current = programBytes();
    return h('section', { class: 'module ai-entry' }, head,
      h('p', { class: 'view-note', style: 'margin:8px 0' }, `${e.variants.length} variations in ${e.seconds}s. Click one to hear it on the synth.`),
      h('div', { class: 'variants' }, e.variants.map((v, i) => {
        const on = equalBytes(current, v.data);
        return h('div', { class: `variant${on ? ' on' : ''}` },
          h('button', { class: 'variant-play', 'aria-pressed': on ? 'true' : 'false', onclick: () => { playVariant(v); render(); } },
            h('span', { class: 'ai-name' }, v.name), h('span', { class: 'tag' }, on ? 'playing' : `${i + 1}`)),
          h('p', { class: 'ai-summary' }, v.summary),
          v.errors.length ? h('p', { class: 'ai-error' }, `Skipped ${v.errors.length} unknown setting(s)`) : null,
          h('div', { class: 'toolbar' },
            h('button', { class: 'small', onclick: () => addToMySounds(v.data, { request: e.request, summary: v.summary }) }, 'Add to My Sounds'),
            h('button', { class: 'small', disabled: !state.output, onclick: () => { if (!equalBytes(programBytes(), v.data)) playVariant(v); writeToSlot(); } }, 'Write to slot…')));
      })),
      h('details', { class: 'ai-trace' }, h('summary', {}, 'What it looked at'), steps));
  }
  const r = e.result;
  const changes = h('details', {}, h('summary', {}, `${r.changed.length} settings changed, starting from ${r.baseLabel}`),
    h('ul', { class: 'ai-changes' }, r.changed.slice(0, 200).map(k => h('li', {}, h('code', {}, k), ` ${fmtAi(r.before[k])} → ${fmtAi(r.after[k])}`))));
  const loaded = () => equalBytes(programBytes(), r.data);
  const loadIt = () => { if (!loaded()) loadProgram(r.data, { slot: null, dirty: true, send: !!state.output }); };
  return h('section', { class: 'module ai-entry' }, head,
    h('h3', { style: 'margin-top:10px' }, h('span', { class: 'ai-name' }, r.name),
      h('span', { class: 'tag' }, e.recovered ? 'recovered' : `${e.seconds}s`)),
    h('p', { class: 'ai-summary' }, r.summary),
    h('div', { class: 'toolbar' },
      loaded() ? null : h('button', { class: 'small', onclick: () => { loadIt(); render(); } }, 'Load into editor'),
      h('button', { class: 'small', onclick: () => addToMySounds(r.data, { request: e.request, summary: r.summary }) }, 'Add to My Sounds'),
      h('button', { class: 'small', disabled: !state.output, onclick: () => { loadIt(); writeToSlot(); } }, 'Write to synth slot…'),
    ),
    r.errors.length ? h('p', { class: 'ai-error' }, `Skipped ${r.errors.length} setting(s) the synth doesn't have: ${r.errors.slice(0, 4).join('; ')}`) : null,
    changes,
    h('details', { class: 'ai-trace' }, h('summary', {}, 'What it looked at'), steps));
}

const equalBytes = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);

const fmtAi = v => (v === undefined ? '—' : typeof v === 'number' ? String(v) : v);

function undoAi() {
  if (!ai.undo) return;
  loadProgram(ai.undo, { dirty: true, send: !!state.output });
  ai.undo = null;
  toast('Restored the sound from before the last AI change.', 'ok');
}

// ---------------------------------------------------------------------------------------------
// Rendering

function render() {
  controls.clear();
  dependents.clear();
  $('#prog-name').value = programName(state.data);
  const v = voicing(state.data);
  Object.assign($('#voicing'), { textContent: v.label, className: `vbadge ${v.kind}`,
    title: `${v.kind === 'poly' ? 'Plays chords' : v.kind === 'mono' ? 'Plays one note at a time' : 'One timbre plays chords, the other one note at a time'} (${v.detail}). Set on each timbre's Assign, and the Voice Mode on Program & Arp.` });
  $('#slot-label').textContent = state.slot === null ? '--' : slotName(state.slot);
  const view = {
    presets: renderPresets, ai: renderAi,
    t1: () => renderTimbre(0), t2: () => renderTimbre(1), fx: renderFx, arp: renderArp,
    voc: renderVocoder, lib: renderLibrary, log: renderLog, help: renderHelp,
  }[state.tab]();
  $('#view').replaceChildren(...view.filter(x => x != null)); // a view may leave out a part with null
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', b.dataset.tab === state.tab);
  updateButtons();
}

// ---------------------------------------------------------------------------------------------
// Files

function download(bytes, filename) {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes)], { type: 'application/octet-stream' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const safeName = s => (s.trim() || 'program').replace(/[^\w\- ]+/g, '_');

function saveProgramFile() {
  download(msg.currentProgramDump(state.channel, programBytes()), `${safeName(programName(state.data))}.syx`);
}

function saveBank() {
  const bytes = [];
  state.library.forEach((d, n) => { if (d) bytes.push(...msg.programDump(state.channel, n, d)); });
  download(bytes, `microKORG-XL-bank-${new Date().toISOString().slice(0, 10)}.syx`);
}

async function openFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let progs;
  try {
    progs = programsFromFile(bytes);
  } catch (e) {
    toast(e.message, 'err');
    return;
  }
  if (!progs.length) {
    toast('No microKORG XL program data found in that file.', 'err');
    return;
  }
  if (progs.length === 1) {
    loadProgram(progs[0].data, { slot: progs[0].slot, dirty: true, send: !!state.output });
    toast(`Opened "${programName(progs[0].data)}"`, 'ok');
    return;
  }
  progs.slice(0, 128).forEach((p, i) => { state.library[p.slot ?? i] = p.data; });
  state.tab = 'lib';
  render();
  toast(`Loaded ${Math.min(128, progs.length)} programs into the Library. To keep them handy, put the file in the presets folder.`, 'ok');
}

// ---------------------------------------------------------------------------------------------
// Write to slot

async function writeToSlot() {
  const dlg = $('#write-dialog');
  const sel = $('#write-slot');
  if (dlg.open || writing) return;
  sel.replaceChildren(...Array.from({ length: 128 }, (_, n) =>
    h('option', { value: n }, `${slotName(n)}${state.library[n] ? '  ' + programName(state.library[n]) : ''}`)));
  sel.value = state.slot ?? 0;
  dlg.returnValue = '';
  dlg.showModal();
  await new Promise(r => dlg.addEventListener('close', r, { once: true }));
  if (dlg.returnValue !== 'ok') return;
  const n = +sel.value;
  writing = true;
  try { await writeProgramTo(n); } finally { writing = false; }
}

let writing = false;

async function writeProgramTo(n) {
  send(msg.currentProgramDump(state.channel, programBytes()), 'Program → edit buffer');
  await waitFor(m => m?.type === 'status' && (m.func === FUNC.DATA_LOAD_COMPLETED || m.func === FUNC.DATA_LOAD_ERROR), 1500);
  send(msg.writeProgram(state.channel, n), `Write to ${slotName(n)}`);
  const r = await waitFor(m => m?.type === 'status' && (m.func === FUNC.WRITE_COMPLETED || m.func === FUNC.WRITE_ERROR), 4000);
  if (r?.func === FUNC.WRITE_COMPLETED) {
    state.slot = n;
    state.library[n] = programBytes();
    setDirty(false);
    render();
    toast(`Saved "${programName(state.data)}" to ${slotName(n)}`, 'ok');
  } else if (!r) {
    toast('No confirmation from the synth. Check the MIDI input port, then use Get from synth to see what\'s stored.', 'err');
  }
}

// ---------------------------------------------------------------------------------------------
// Audition keyboard

const KEY_MAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14 };
let baseNote = 60;
const held = new Map();

function noteOn(n) {
  if (held.has(n) || !state.output) return;
  held.set(n, true);
  state.output.send([0x90 | state.channel, n, 100]);
  document.querySelector(`.keyboard [data-note="${n}"]`)?.classList.add('down');
}
function noteOff(n) {
  if (!held.delete(n) || !state.output) return;
  state.output.send([0x80 | state.channel, n, 64]);
  document.querySelector(`.keyboard [data-note="${n}"]`)?.classList.remove('down');
}
function allOff() { for (const n of [...held.keys()]) noteOff(n); }

function buildKeyboard() {
  const kb = $('#keyboard');
  kb.replaceChildren();
  const whites = [0, 2, 4, 5, 7, 9, 11];
  let x = 0;
  for (let oct = 0; oct < 2; oct++) {
    for (let s = 0; s < 12; s++) {
      const n = baseNote + oct * 12 + s;
      const isWhite = whites.includes(s);
      const key = h('button', { class: isWhite ? 'white' : 'black', 'data-note': n, 'aria-label': `Note ${n}`, tabindex: -1 });
      if (!isWhite) key.style.left = `${x * 28 - 9}px`;
      if (isWhite) x++;
      key.addEventListener('pointerdown', e => { key.setPointerCapture(e.pointerId); noteOn(n); });
      key.addEventListener('pointerup', () => noteOff(n));
      key.addEventListener('pointercancel', () => noteOff(n));
      kb.append(key);
    }
  }
}

function typingInField(e) {
  const t = e.target;
  return t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement;
}

document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || typingInField(e) || e.repeat) return;
  const k = e.key.toLowerCase();
  if (k === 'z' || k === 'x') {
    allOff();
    baseNote = Math.max(24, Math.min(96, baseNote + (k === 'z' ? -12 : 12)));
    buildKeyboard();
    return;
  }
  if (k in KEY_MAP) noteOn(baseNote + KEY_MAP[k]);
});
document.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  if (k in KEY_MAP) noteOff(baseNote + KEY_MAP[k]);
});
window.addEventListener('blur', allOff);

// ---------------------------------------------------------------------------------------------
// Wiring

function init() {
  const saved = store.get('program', null);
  if (saved?.data?.length) {
    state.data = new Uint8Array(Math.max(PROGRAM_SIZE, saved.data.length));
    state.data.set(saved.data);
    state.dataLen = saved.data.length;
    state.slot = saved.slot ?? null;
  }
  state.sendMode = store.get('sendMode', 'dump');
  state.signedParams = store.get('signedParams', true);
  state.calibrated = store.get('calibrated', false);
  state.tab = store.get('tab', 'help');

  const chSel = $('#midi-ch');
  chSel.replaceChildren(...Array.from({ length: 16 }, (_, i) => h('option', { value: i }, i + 1)));
  chSel.value = state.channel;
  chSel.addEventListener('change', () => { state.channel = +chSel.value; });

  const modeSel = $('#send-mode');
  modeSel.value = state.sendMode;
  modeSel.addEventListener('change', () => { state.sendMode = modeSel.value; store.set('sendMode', state.sendMode); });

  $('#midi-in').addEventListener('change', applyPorts);
  $('#midi-out').addEventListener('change', applyPorts);
  $('#btn-connect').addEventListener('click', () => findSynth());
  $('#btn-get').addEventListener('click', getFromSynth);
  $('#btn-send').addEventListener('click', () => { sendProgram(); });
  $('#btn-write').addEventListener('click', writeToSlot);
  $('#btn-mine').addEventListener('click', () => addToMySounds(programBytes()));
  $('#btn-save').addEventListener('click', saveProgramFile);
  $('#btn-load').addEventListener('click', () => $('#file-input').click());
  $('#btn-init').addEventListener('click', () => {
    if (state.dirty && !confirm('Replace the current edits with an init program?')) return;
    loadProgram(initProgram(), { slot: null, dirty: true, send: !!state.output });
  });
  $('#file-input').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) openFile(f);
    e.target.value = '';
  });

  const nameInput = $('#prog-name');
  nameInput.addEventListener('input', () => {
    const clean = nameInput.value.replace(/[^\x20-\x7e]/g, '');
    setProgramName(state.data, clean);
    lastEditAt = performance.now();
    setDirty(true);
    persistProgram();
    if (!state.output) return;
    if (state.sendMode === 'param') {
      for (let i = 0; i < 8; i++) send(msg.parameterChange(state.channel, 0x00, i, state.data[i]), `Name[${i}]`);
    } else scheduleDump();
  });

  for (const b of document.querySelectorAll('.tabs button')) {
    b.addEventListener('click', () => { state.tab = b.dataset.tab; store.set('tab', state.tab); render(); });
  }

  // Ask the host page (index.html) to show the other view; nothing reloads, so playback continues.
  document.querySelectorAll('.app-nav a[data-view]').forEach(a => a.addEventListener('click', e => {
    if (top === self) return;
    e.preventDefault();
    parent.postMessage({ type: 'switch-view', view: a.dataset.view }, location.origin);
  }));

  buildKeyboard();
  render();
  initMidi();
}

init();
