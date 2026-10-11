// The Lab page: build and play instruments made of modules (see patch.js), save them to
// data/instruments/, and share them with the sequencer. No framework.
import { MODULES, SOURCES, STARTERS, normalizePatch, copyPatch, defaultParams, newId, paramOf, formatValue, toSlider, fromSlider } from './patch.js';
import { LabSynth } from './engine.js';
import { patchSVG } from './patchview.js';
import { portLabel } from '../core/midiports.js';
import { storage, placeOf, stemOf } from '../core/storage.js';
import { STATIC } from '../core/mode.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const noteName = n => NOTE_NAMES[n % 12] + (Math.floor(n / 12) - 1);

const store = {
  get(key, fallback) { try { const v = localStorage.getItem(`mkxl.lab.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`mkxl.lab.${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ } },
};
function toast(text, kind = '') {
  const el = Object.assign(document.createElement('div'), { className: `toast ${kind}`, textContent: text });
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
}
const prefs = { keysIn: null, base: 48, viewOpen: true, ...store.get('prefs', {}) };
const savePrefs = () => store.set('prefs', prefs);

// ---------------------------------------------------------------------------------------------
// Sound

const ac = new AudioContext({ latencyHint: 'interactive' });
const limiter = ac.createDynamicsCompressor();
limiter.threshold.value = -3; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.1;
limiter.connect(ac.destination);
const synth = new LabSynth(ac, limiter);

function wake() {
  if (ac.state !== 'running') ac.resume().then(showAudio);
}
const showAudio = () => {
  const el = $('#audio-status');
  el.hidden = ac.state === 'running';
};
addEventListener('pointerdown', wake, true);
addEventListener('keydown', wake, true);
ac.onstatechange = showAudio;

// ---------------------------------------------------------------------------------------------
// State: the patch being edited, undo, the working copy kept in this browser

let patch;
let fileName = null;
let dirty = false;
let saved = []; // [{ file, name, patch }]
const undoStack = [], redoStack = [];
let snapshot = null, lastPush = 0, workTimer = null, shareTimer = null;
let learn = false, learnTarget = null;

const channel = 'BroadcastChannel' in window ? new BroadcastChannel('mkxl') : null;
// Instruments saved or imported elsewhere (Transfer) show up in Open.
if (channel) channel.onmessage = e => { if (e.data?.type === 'instruments-changed') refreshSaved(); };

function changed({ coalesce = false, rebuild = false } = {}) {
  const now = performance.now();
  if (!coalesce || now - lastPush > 800) {
    undoStack.push(snapshot);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
    lastPush = now;
  }
  snapshot = JSON.stringify(patch);
  dirty = true;
  if (rebuild) synth.setPatch(patch);
  clearTimeout(workTimer);
  workTimer = setTimeout(() => store.set('working', { patch, fileName, dirty }), 300);
  // The sequencer plays this instrument on tracks that use it: send it every change.
  clearTimeout(shareTimer);
  shareTimer = setTimeout(() => channel?.postMessage({ type: 'instrument', name: patch.name, patch }), 120);
  renderFileBar();
}

function load(raw, file, isDirty = false) {
  const { patch: p, notes } = normalizePatch(raw);
  patch = p;
  fileName = file;
  dirty = isDirty;
  snapshot = JSON.stringify(patch);
  undoStack.length = redoStack.length = 0;
  synth.setPatch(patch);
  store.set('working', { patch, fileName, dirty });
  showNotes(notes);
  renderAll();
}
function restore(json) {
  patch = normalizePatch(JSON.parse(json)).patch;
  snapshot = json;
  dirty = true;
  synth.setPatch(patch);
  store.set('working', { patch, fileName, dirty });
  renderAll();
  channel?.postMessage({ type: 'instrument', name: patch.name, patch });
}
const undo = () => { if (undoStack.length) { redoStack.push(snapshot); restore(undoStack.pop()); } };
const redo = () => { if (redoStack.length) { undoStack.push(snapshot); restore(redoStack.pop()); } };

function showNotes(notes) {
  const el = $('#notes');
  el.hidden = !notes.length;
  el.innerHTML = notes.map(esc).join('<br>');
}

// ---------------------------------------------------------------------------------------------
// Rendering

const modOf = id => patch.modules.find(m => m.id === id);
const sourceLabel = id => SOURCES[id]?.label || id;
const targetLabel = to => {
  const [id, key] = to.split('.'), m = modOf(id);
  return `${id} ${m ? (paramOf(m.type, key)?.label || key) : key}`.trim();
};
function amountText(to, v) {
  const [id, key] = to.split('.'), t = MODULES[modOf(id)?.type]?.targets[key];
  if (t?.unit === 'cents') return Math.abs(v) >= 1200 ? `${v > 0 ? '+' : ''}${(v / 1200).toFixed(1)} oct` : `${v > 0 ? '+' : ''}${Math.round(v)} c`;
  if (t?.unit === 'Hz') return `${v > 0 ? '+' : ''}${v.toFixed(1)} Hz`;
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}

function renderAll() {
  renderFileBar();
  renderModules();
  renderOpen();
}

function renderFileBar() {
  const name = $('#inst-name');
  if (document.activeElement !== name) name.value = patch.name;
  $('#dirty').hidden = !dirty;
  $('#dirty').textContent = fileName ? 'unsaved changes' : 'not saved yet';
  $('#delete').disabled = !fileName;
  $('#undo').disabled = !undoStack.length;
  $('#redo').disabled = !redoStack.length;
  if (document.activeElement !== $('#voices')) $('#voices').value = patch.voices;
  $('#volume').value = patch.volume;
  document.title = `${patch.name}${dirty ? ' •' : ''} · Lab · Ostinato`;
}

function renderOpen() {
  $('#open').innerHTML = `<option value="">Open…</option>`
    + (saved.length ? `<optgroup label="Your instruments">${saved.map(s => `<option value="file:${esc(s.file)}">${esc(s.name)}</option>`).join('')}</optgroup>` : '')
    + `<optgroup label="Start from">${STARTERS.map((s, i) => `<option value="starter:${i}">${esc(s.name)}</option>`).join('')}</optgroup>`;
}

function paramHTML(m, spec) {
  const v = m.params[spec.key], target = `${m.id}.${spec.key}`;
  const cc = Object.entries(patch.cc).find(([, t]) => t === target)?.[0];
  const help = spec.help ? ` title="${esc(spec.help)}"` : '';
  if (spec.kind === 'choice') {
    return `<div class="prm"${help}><label>${spec.label}</label><span class="seg-btn">${spec.choices.map(c =>
      `<button data-act="choice" data-id="${m.id}" data-key="${spec.key}" data-v="${esc(c)}" class="${c === v ? 'on' : ''}">${esc(c)}</button>`).join('')}</span></div>`;
  }
  return `<div class="prm${learn ? ' learnable' : ''}${learnTarget === target ? ' learning' : ''}" data-target="${target}"${help}>
    <label>${spec.label}</label>
    <input type="range" min="0" max="1000" step="1" value="${Math.round(toSlider(spec, v) * 1000)}" data-act="num" data-id="${m.id}" data-key="${spec.key}">
    <span class="val">${esc(formatValue(spec, v))}</span>${cc !== undefined ? `<span class="cc" title="Turned by knob CC ${cc}${learn ? ' (click to forget)' : ''}" data-act="unlearn" data-cc="${cc}">CC ${cc}</span>` : ''}
  </div>`;
}

// Where a module's audio can go: the output, or any module with an input that doesn't loop back.
function audioDestinations(from) {
  return ['out', ...patch.modules.map(m => m.id)].filter(to => to !== from && !patch.audio.some(c => c.from === from && c.to === to)
    && normalizePatch({ ...patch, audio: [...patch.audio, { from, to }] }).patch.audio.length > patch.audio.length);
}
function modTargets(from) {
  const list = [];
  for (const m of patch.modules) {
    for (const key of Object.keys(MODULES[m.type].targets)) {
      const to = `${m.id}.${key}`;
      if (m.id !== from && !patch.mod.some(c => c.from === from && c.to === to)) list.push(to);
    }
  }
  return list;
}

function routesHTML(from) {
  const spec = MODULES[modOf(from)?.type] || SOURCES[from];
  let html = '';
  if (spec.audioOut) {
    const outs = patch.audio.filter(c => c.from === from);
    const dests = audioDestinations(from);
    html += `<div class="route"><span class="route-h">Audio to</span>${outs.map(c =>
      `<span class="chip">${c.to === 'out' ? 'Output' : esc(c.to)}<button class="x" data-act="a-del" data-from="${from}" data-to="${c.to}" title="Disconnect">✕</button></span>`).join('')}
      ${dests.length ? `<select data-act="a-add" data-from="${from}"><option value="">+</option>${dests.map(d => `<option value="${d}">${d === 'out' ? 'Output' : d}</option>`).join('')}</select>` : ''}
      ${!outs.length ? '<span class="warn-text">not connected</span>' : ''}</div>`;
  }
  if (spec.modOut || SOURCES[from]) {
    const rows = patch.mod.map((c, i) => [c, i]).filter(([c]) => c.from === from).map(([c, i]) => {
      const [id, key] = c.to.split('.'), t = MODULES[modOf(id).type].targets[key];
      const x = Math.round((c.amount - t.min) / (t.max - t.min) * 1000);
      return `<div class="mrow"><span class="mto">→ ${esc(targetLabel(c.to))}</span>
        <input type="range" min="0" max="1000" value="${x}" data-act="m-amt" data-i="${i}" title="How much (centre = none)">
        <span class="val">${amountText(c.to, c.amount)}</span>
        <button class="x" data-act="m-del" data-i="${i}" title="Remove">✕</button></div>`;
    }).join('');
    const targets = modTargets(from);
    html += `<div class="route mods"><span class="route-h">Modulates</span>${rows}
      ${targets.length ? `<select data-act="m-add" data-from="${from}"><option value="">+ add a target</option>${targets.map(t => `<option value="${t}">${esc(targetLabel(t))}</option>`).join('')}</select>` : ''}</div>`;
  }
  return html;
}

function renderModules() {
  const cards = patch.modules.map(m => {
    const spec = MODULES[m.type];
    return `<section class="card mod-${m.type}${spec.scope === 'global' ? ' global' : ''}" data-mod="${m.id}">
      <header title="${esc(spec.help)}"><b>${spec.label}</b> <span class="mid">${m.id}</span>${spec.scope === 'global' ? '<span class="tag">effect</span>' : ''}
        <span class="spacer"></span><button class="ghost small x" data-act="del" data-id="${m.id}" title="Remove this module">✕</button></header>
      <div class="prms">${spec.params.filter(p => !(m.type === 'osc' && p.key === 'pw' && m.params.wave !== 'pulse')).map(p => paramHTML(m, p)).join('')}</div>
      ${routesHTML(m.id)}
    </section>`;
  });
  cards.push(`<section class="card sources"><header title="Modulation from how you play"><b>Velocity &amp; mod wheel</b></header>
    <div class="src-h">Velocity</div>${routesHTML('vel')}<div class="src-h">Mod wheel <span class="hint">(CC 1; the MPK mini's joystick pushed up)</span></div>${routesHTML('wheel')}</section>`);
  $('#modules').innerHTML = cards.join('');
  renderView();
  $('#add-module').innerHTML = `<option value="">+ Add module…</option>${Object.entries(MODULES).map(([type, s]) => `<option value="${type}">${s.label}${s.scope === 'global' ? ' (effect)' : ''} — ${esc(s.help)}</option>`).join('')}`;
  $('#learn').classList.toggle('on', learn);
}

// ---- the patch diagram ----

let viewSel = null; // the selected cable: { kind: 'audio' | 'mod', from, to }
let justDragged = false; // a drag ends with a click; ignore that one

function renderView() {
  const el = $('#patch-view');
  el.hidden = !prefs.viewOpen;
  $('#view-col').textContent = prefs.viewOpen ? '▾' : '▸';
  if (!prefs.viewOpen) return;
  if (viewSel && !(viewSel.kind === 'audio' ? patch.audio : patch.mod).some(c => c.from === viewSel.from && c.to === viewSel.to)) viewSel = null;
  el.innerHTML = patchSVG(patch, { selected: viewSel }).svg + selOverlay();
  if (viewSel) placeOverlay();
}

// The box for a selected cable: what it connects, its amount (modulation), and remove.
function selOverlay() {
  if (!viewSel) return '';
  const name = id => (id === 'out' ? 'Output' : SOURCES[id]?.label || id);
  if (viewSel.kind === 'audio') {
    const fm = modOf(viewSel.to)?.type === 'fmop';
    return `<div class="view-pop"><span>${esc(name(viewSel.from))} → ${esc(name(viewSel.to))}${fm ? ' (FM)' : ''}</span>
      <button class="small" data-act="v-del">✕ Remove</button></div>`;
  }
  const i = patch.mod.findIndex(c => c.from === viewSel.from && c.to === viewSel.to), c = patch.mod[i];
  const [id, key] = c.to.split('.'), t = MODULES[modOf(id).type].targets[key];
  return `<div class="view-pop"><span>${esc(name(c.from))} → ${esc(targetLabel(c.to))}</span>
    <input type="range" min="0" max="1000" value="${Math.round((c.amount - t.min) / (t.max - t.min) * 1000)}" data-act="v-amt" data-i="${i}">
    <span class="val">${amountText(c.to, c.amount)}</span><button class="small" data-act="v-del">✕</button></div>`;
}
// Puts the overlay next to the middle of the selected cable.
function placeOverlay() {
  const path = document.querySelector('#patch-view .cable.sel .line'), pop = document.querySelector('#patch-view .view-pop');
  if (!path || !pop) return;
  const svg = path.ownerSVGElement, mid = path.getPointAtLength(path.getTotalLength() / 2);
  const p = new DOMPoint(mid.x, mid.y).matrixTransform(svg.getScreenCTM()), box = $('#patch-view').getBoundingClientRect();
  pop.style.left = `${Math.max(4, p.x - box.left + $('#patch-view').scrollLeft - 80)}px`;
  pop.style.top = `${p.y - box.top + $('#patch-view').scrollTop + 10}px`;
}
function deleteSelected() {
  if (!viewSel) return;
  const list = viewSel.kind === 'audio' ? 'audio' : 'mod';
  patch[list] = patch[list].filter(c => !(c.from === viewSel.from && c.to === viewSel.to));
  viewSel = null;
  changed({ rebuild: true });
  renderModules();
}
// Connects `from` (a module or a modulation source) to the module `to`. A modulation source
// with several possible targets on that module asks which one.
function connect(from, to, at) {
  if (!to || to === from) return;
  const fromMod = modOf(from), modSource = SOURCES[from] || (fromMod && MODULES[fromMod.type].modOut);
  if (!modSource) {
    if (!audioDestinations(from).includes(to)) { toast(to === 'out' || modOf(to) ? `${from} can't send audio to ${to === 'out' ? 'the output' : to} (it would loop, or it's already connected).` : 'Drop it on a module.'); return; }
    patch.audio.push({ from, to });
    changed({ rebuild: true });
    renderModules();
    return;
  }
  const keys = modOf(to) ? Object.keys(MODULES[modOf(to).type].targets).filter(k => !patch.mod.some(c => c.from === from && c.to === `${to}.${k}`)) : [];
  if (!keys.length) { toast(modOf(to) ? `Nothing on ${to} for ${from} to modulate.` : 'Drop it on a module.'); return; }
  const add = key => addMod(from, `${to}.${key}`);
  if (keys.length === 1) { add(keys[0]); return; }
  const menu = document.createElement('div');
  menu.className = 'view-menu';
  menu.innerHTML = `<span>${esc(from)} → ${esc(to)}:</span>${keys.map(k => `<button class="small" data-k="${k}">${esc(paramOf(modOf(to).type, k)?.label || k)}</button>`).join('')}<button class="ghost small" data-k="">Cancel</button>`;
  const box = $('#patch-view').getBoundingClientRect();
  menu.style.left = `${at.x - box.left + $('#patch-view').scrollLeft}px`;
  menu.style.top = `${at.y - box.top + $('#patch-view').scrollTop}px`;
  $('#patch-view').append(menu);
  menu.onclick = e => { const b = e.target.closest('[data-k]'); if (!b) return; menu.remove(); if (b.dataset.k) add(b.dataset.k); };
}
function addMod(from, to) {
  const [id, key] = to.split('.'), t = MODULES[modOf(id).type].targets[key];
  const amount = t.unit === 'cents' ? (key === 'pitch' ? 50 : 1200) : Math.round(t.max * 25) / 100;
  patch.mod.push({ from, to, amount });
  viewSel = { kind: 'mod', from, to };
  changed({ rebuild: true });
  renderModules();
}

$('#view-col').onclick = () => { prefs.viewOpen = !prefs.viewOpen; savePrefs(); renderView(); };
$('#patch-view').addEventListener('pointerdown', e => {
  const port = e.target.closest('.port');
  if (!port) return;
  e.preventDefault();
  const svg = port.ownerSVGElement, line = svg.querySelector('.drag-line'), from = port.dataset.port;
  const toSvg = (x, y) => new DOMPoint(x, y).matrixTransform(svg.getScreenCTM().inverse());
  const c = port.getBoundingClientRect(), start = toSvg(c.left + c.width / 2, c.top + c.height / 2);
  const move = ev => { const p = toSvg(ev.clientX, ev.clientY); line.setAttribute('d', `M${start.x},${start.y} L${p.x},${p.y}`); };
  const up = ev => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    line.setAttribute('d', '');
    justDragged = true;
    setTimeout(() => { justDragged = false; }, 0);
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-box]');
    connect(from, target?.dataset.box, { x: ev.clientX, y: ev.clientY });
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
});
$('#patch-view').addEventListener('click', e => {
  if (justDragged) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'v-del') { deleteSelected(); return; }
  if (e.target.closest('.view-pop, .view-menu, .port')) return;
  const cable = e.target.closest('.cable');
  if (cable) { viewSel = { kind: cable.dataset.kind, from: cable.dataset.from, to: cable.dataset.to }; renderView(); return; }
  const box = e.target.closest('[data-box]');
  viewSel = null;
  renderView();
  const card = box && (document.querySelector(`[data-mod="${box.dataset.box}"]`) || (SOURCES[box.dataset.box] && document.querySelector('.card.sources')));
  if (card) { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash'); }
});
$('#patch-view').addEventListener('input', e => {
  if (e.target.dataset.act !== 'v-amt') return;
  const i = +e.target.dataset.i, c = patch.mod[i], [id, key] = c.to.split('.'), t = MODULES[modOf(id).type].targets[key];
  let v = t.min + +e.target.value / 1000 * (t.max - t.min);
  if (Math.abs(v) < (t.max - t.min) * 0.01) v = 0;
  c.amount = t.unit === 'cents' ? Math.round(v) : Math.round(v * 100) / 100;
  synth.setMod(i, c.amount);
  e.target.parentElement.querySelector('.val').textContent = amountText(c.to, c.amount);
  // Keep the card's slider in step.
  const cardRange = document.querySelector(`#modules [data-act="m-amt"][data-i="${i}"]`);
  if (cardRange) { cardRange.value = e.target.value; cardRange.parentElement.querySelector('.val').textContent = amountText(c.to, c.amount); }
  changed({ coalesce: true });
});

// ---------------------------------------------------------------------------------------------
// Editing

$('#modules').addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.act === 'num') {
    const m = modOf(el.dataset.id), spec = paramOf(m.type, el.dataset.key), v = fromSlider(spec, +el.value / 1000);
    m.params[spec.key] = v;
    synth.setParam(m.id, spec.key, v);
    el.parentElement.querySelector('.val').textContent = formatValue(spec, v);
    changed({ coalesce: true });
  } else if (el.dataset.act === 'm-amt') {
    const i = +el.dataset.i, c = patch.mod[i], [id, key] = c.to.split('.'), t = MODULES[modOf(id).type].targets[key];
    let v = t.min + +el.value / 1000 * (t.max - t.min);
    if (Math.abs(v) < (t.max - t.min) * 0.01) v = 0; // snap to none in the middle
    c.amount = t.unit === 'cents' ? Math.round(v) : Math.round(v * 100) / 100;
    synth.setMod(i, c.amount);
    el.parentElement.querySelector('.val').textContent = amountText(c.to, c.amount);
    changed({ coalesce: true });
  }
});

$('#modules').addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  // Learning: clicking a setting picks it as the target for the next knob turned.
  const row = e.target.closest('.prm[data-target]');
  if (learn && row && el?.dataset.act !== 'unlearn') { learnTarget = row.dataset.target; renderModules(); return; }
  if (!el) return;
  switch (el.dataset.act) {
    case 'choice': {
      const m = modOf(el.dataset.id);
      m.params[el.dataset.key] = el.dataset.v;
      // Some settings (an oscillator's wave, a filter's slope...) change which nodes a note uses.
      const structural = !!paramOf(m.type, el.dataset.key)?.rebuild;
      if (!structural) synth.setParam(m.id, el.dataset.key, el.dataset.v);
      changed({ rebuild: structural });
      renderModules();
      break;
    }
    case 'del': {
      const id = el.dataset.id;
      patch.modules = patch.modules.filter(m => m.id !== id);
      patch.audio = patch.audio.filter(c => c.from !== id && c.to !== id);
      patch.mod = patch.mod.filter(c => c.from !== id && !c.to.startsWith(`${id}.`));
      for (const [k, t] of Object.entries(patch.cc)) if (t.startsWith(`${id}.`)) delete patch.cc[k];
      changed({ rebuild: true });
      renderModules();
      break;
    }
    case 'a-del':
      patch.audio = patch.audio.filter(c => !(c.from === el.dataset.from && c.to === el.dataset.to));
      changed({ rebuild: true });
      renderModules();
      break;
    case 'm-del':
      patch.mod.splice(+el.dataset.i, 1);
      changed({ rebuild: true });
      renderModules();
      break;
    case 'unlearn':
      delete patch.cc[el.dataset.cc];
      changed();
      renderModules();
      break;
  }
});

$('#modules').addEventListener('change', e => {
  const el = e.target;
  if (el.dataset.act === 'a-add' && el.value) {
    patch.audio.push({ from: el.dataset.from, to: el.value });
    changed({ rebuild: true });
    renderModules();
  } else if (el.dataset.act === 'm-add' && el.value) {
    const [id, key] = el.value.split('.'), t = MODULES[modOf(id).type].targets[key];
    // A gentle starting amount: a quarter of the way up.
    const amount = t.unit === 'cents' ? (key === 'pitch' ? 50 : 1200) : Math.round(t.max * 25) / 100;
    patch.mod.push({ from: el.dataset.from, to: el.value, amount });
    changed({ rebuild: true });
    renderModules();
  }
});

// A new module goes before the Amp (or at the end), wired into the obvious place.
$('#add-module').addEventListener('change', e => {
  const type = e.target.value;
  e.target.value = '';
  if (!type) return;
  const id = newId(patch, type), spec = MODULES[type];
  patch.modules.push({ id, type, params: defaultParams(type) });
  const amp = patch.modules.find(m => m.type === 'amp'), filter = patch.modules.find(m => m.type === 'filter');
  const carrier = patch.modules.find(m => m.type === 'fmop' && m.id !== id && patch.audio.some(c => c.from === m.id && !modOf(c.to)?.type.startsWith('fm')));
  // Reroutes connections into `dest` (or, without one, to the effects/output) through the new module.
  const insertBefore = dest => {
    const into = patch.audio.filter(c => (dest ? c.to === dest : c.to === 'out' || MODULES[modOf(c.to)?.type]?.scope === 'global')
      && c.from !== id && MODULES[modOf(c.from)?.type]?.scope === 'voice');
    if (!into.length) { patch.audio.push({ from: id, to: 'out' }); return; }
    const targets = [...new Set(into.map(c => c.to))];
    into.forEach(c => { c.to = id; });
    targets.forEach(to => patch.audio.push({ from: id, to }));
  };
  if (type === 'osc' || type === 'noise') {
    const to = filter?.id || amp?.id || 'out';
    patch.audio.push({ from: id, to });
  } else if (type === 'fmop') {
    // A second operator modulates the first; the first one goes where an oscillator would.
    if (carrier) patch.audio.push({ from: id, to: carrier.id });
    else patch.audio.push({ from: id, to: filter?.id || amp?.id || 'out' });
  } else if (type === 'drums') {
    patch.audio.push({ from: id, to: 'out' });
  } else if (type === 'ring') {
    insertBefore(filter?.id || amp?.id);
  } else if (type === 'space') {
    insertBefore(null);
  } else if (spec.scope === 'global') {
    // Insert the effect at the end of the chain: whatever went to the output now goes through it.
    const last = patch.audio.filter(c => c.to === 'out');
    last.forEach(c => { c.to = id; });
    patch.audio.push({ from: id, to: 'out' });
  } else if (type === 'env') {
    if (filter) patch.mod.push({ from: id, to: `${filter.id}.cutoff`, amount: 2400 });
  } else if (type === 'lfo') {
    const osc = patch.modules.find(m => m.type === 'osc');
    if (osc) patch.mod.push({ from: id, to: `${osc.id}.pitch`, amount: 20 });
  }
  patch = normalizePatch(patch).patch;
  changed({ rebuild: true });
  renderModules();
  document.querySelector(`[data-mod="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

$('#inst-name').addEventListener('change', e => { patch.name = e.target.value.trim().slice(0, 40) || 'Untitled'; changed(); });
$('#voices').addEventListener('change', e => {
  patch.voices = Math.max(1, Math.min(16, Math.round(+e.target.value) || 8));
  synth.setPatch(patch);
  changed();
});
$('#volume').addEventListener('input', e => { patch.volume = +e.target.value; synth.setPatch(patch); changed({ coalesce: true }); });
$('#undo').onclick = undo;
$('#redo').onclick = redo;
$('#panic').onclick = () => synth.allOff(true);
$('#learn').onclick = () => {
  learn = !learn;
  learnTarget = null;
  if (learn) toast('Click a setting\'s slider, then turn a knob on your controller.');
  renderModules();
};

// ---------------------------------------------------------------------------------------------
// Files: data/instruments/ at home, or this browser in the travel version (core/storage.js)

async function refreshSaved() {
  try { saved = await storage.list('instruments'); } catch { saved = []; }
  renderOpen();
}
const fileFor = name => `${stemOf(name)}.json`;

async function save() {
  await refreshSaved();
  const target = fileFor(patch.name);
  if (target !== fileName && saved.some(s => s.file === target) && !confirm(`An instrument already uses the file ${target}. Replace it?`)) return;
  try {
    const file = await storage.save('instruments', patch);
    fileName = file;
    dirty = false;
    store.set('working', { patch, fileName, dirty });
    renderFileBar();
    await refreshSaved();
    channel?.postMessage({ type: 'instruments-changed' });
    toast(`Saved to ${placeOf('instruments', file)}. It's now in the Sequencer's Sound list.`, 'ok');
  } catch (err) {
    toast(`Couldn't save: ${err.message}.${STATIC ? '' : ' Is serve.py running?'}`, 'err');
  }
}
const discardOk = () => !dirty || confirm(`Discard unsaved changes to "${patch.name}"?`);
$('#save').onclick = save;
$('#open').onchange = e => {
  const v = e.target.value;
  e.target.value = '';
  if (!v || !discardOk()) return;
  if (v.startsWith('starter:')) {
    const s = copyPatch(STARTERS[+v.slice(8)]);
    load(s, null, true);
  } else {
    const s = saved.find(x => x.file === v.slice(5));
    if (s) load(s.patch, s.file);
  }
};
$('#delete').onclick = async () => {
  if (!fileName || !confirm(`${STATIC ? 'Delete' : 'Move'} "${patch.name}"${STATIC ? '' : ' to data/instruments/deleted/'}? It stays open here, unsaved.`)) return;
  try {
    await storage.remove('instruments', fileName);
    fileName = null;
    dirty = true;
    renderFileBar();
    await refreshSaved();
    channel?.postMessage({ type: 'instruments-changed' });
  } catch (err) { toast(`Couldn't delete: ${err.message}`, 'err'); }
};

// ---------------------------------------------------------------------------------------------
// Playing: MIDI in, the on-screen keyboard and the computer keyboard

const down = new Map(); // note -> source ('midi', 'kbd', 'key')
let sustain = false;
const sustained = new Set();

function noteOn(note, vel) {
  wake();
  sustained.delete(note);
  synth.noteOn(note, vel, ac.currentTime);
  down.set(note, true);
  document.querySelector(`#kbd [data-n="${note}"]`)?.classList.add('on');
}
function noteOff(note) {
  if (!down.has(note)) return;
  down.delete(note);
  document.querySelector(`#kbd [data-n="${note}"]`)?.classList.remove('on');
  if (sustain) sustained.add(note); else synth.noteOff(note, ac.currentTime);
}

const onScreen = () => !window.frameElement || !window.frameElement.hidden;
let midi = null;
function onMidi(e) {
  const d = e.data, type = d[0] & 0xf0;
  if (type === 0x90 && d[2] > 0) flashLed();
  if (!onScreen()) return; // keys played in the other views aren't for the Lab
  if (type === 0x90 && d[2] > 0) noteOn(d[1], d[2]);
  else if (type === 0x80 || type === 0x90) noteOff(d[1]);
  else if (type === 0xe0) synth.setBend((((d[2] << 7) | d[1]) - 8192) / 8192);
  else if (type === 0xb0) onCC(d[1], d[2]);
}
function onCC(cc, v) {
  if (cc === 64) {
    sustain = v >= 64;
    if (!sustain) { for (const n of sustained) synth.noteOff(n, ac.currentTime); sustained.clear(); }
    return;
  }
  if (learn && learnTarget) {
    for (const [k, t] of Object.entries(patch.cc)) if (t === learnTarget) delete patch.cc[k];
    patch.cc[cc] = learnTarget;
    toast(`Knob CC ${cc} now turns ${targetLabel(learnTarget)}.`, 'ok');
    learnTarget = null;
    learn = false;
    changed();
    renderModules();
    return;
  }
  if (cc === 1) synth.setWheel(v / 127);
  const target = patch.cc[cc];
  if (!target) return;
  const [id, key] = target.split('.'), m = modOf(id), spec = m && paramOf(m.type, key);
  if (!spec) return;
  const val = fromSlider(spec, v / 127);
  m.params[key] = val;
  synth.setParam(id, key, val);
  const row = document.querySelector(`.prm[data-target="${target}"]`);
  if (row) { row.querySelector('input').value = Math.round(toSlider(spec, val) * 1000); row.querySelector('.val').textContent = formatValue(spec, val); }
  changed({ coalesce: true });
}
let ledTimer = null;
function flashLed() {
  const led = $('#keys-led');
  led.className = 'keys-led ok';
  clearTimeout(ledTimer);
  ledTimer = setTimeout(() => { led.className = 'keys-led'; }, 300);
}

const inputs = () => (midi ? [...midi.inputs.values()].filter(p => p.state !== 'disconnected') : []);
function wireMidi() {
  const ins = inputs();
  if (!prefs.keysIn || !ins.some(p => p.name === prefs.keysIn)) {
    // Prefer a controller keyboard (the MPK mini) over the XL's own ports.
    const guess = ins.find(p => /mpk|akai/i.test(p.name)) || ins.find(p => !/microKORG|SOUND|KBD|MIDI (IN|OUT)$/i.test(p.name)) || ins[0];
    if (guess) { prefs.keysIn = guess.name; savePrefs(); }
  }
  for (const p of ins) { p.onmidimessage = p.name === prefs.keysIn ? onMidi : null; if (p.name === prefs.keysIn) p.open?.().catch(() => {}); }
  $('#keys-in').innerHTML = `<option value="">— none —</option>${ins.map(p => `<option value="${esc(p.name)}">${esc(portLabel(p))}</option>`).join('')}`;
  $('#keys-in').value = prefs.keysIn || '';
}
async function initMidi() {
  if (new URLSearchParams(location.search).has('sim')) await import('../../tools/fakesynth.js');
  const blocked = why => {
    $('#keys-in').innerHTML = `<option value="">${why}</option>`;
    $('#keys-in').title = 'Allow MIDI for this site in Chrome (the icon at the left of the address bar), then reload';
  };
  if (!navigator.requestMIDIAccess) { blocked('No Web MIDI (use Chrome)'); return; }
  // Ask the way the editor and sequencer do (with SysEx), so the permission you already gave
  // them covers this page too; Chrome treats plain MIDI as a separate permission.
  try { midi = await navigator.requestMIDIAccess({ sysex: true }); } catch {
    try { midi = await navigator.requestMIDIAccess(); } catch {
      blocked('MIDI blocked');
      toast('Chrome blocked MIDI for the Lab. Allow MIDI for this site (the icon at the left of the address bar) and reload. The on-screen and computer keyboards still work.', 'err');
      return;
    }
  }
  midi.onstatechange = wireMidi;
  wireMidi();
}
$('#keys-in').onchange = e => { prefs.keysIn = e.target.value || null; savePrefs(); wireMidi(); };

// On-screen keyboard: two octaves from the base note.
function renderKbd() {
  const keys = [];
  let white = 0;
  for (let n = prefs.base; n <= prefs.base + 24; n++) {
    const black = [1, 3, 6, 8, 10].includes(n % 12);
    if (black) keys.push(`<div class="b" data-n="${n}" style="left:${white * 22 - 7}px"></div>`);
    else { keys.push(`<div class="w" data-n="${n}">${n % 12 === 0 ? `<span class="lbl">${noteName(n)}</span>` : ''}</div>`); white++; }
  }
  $('#kbd').innerHTML = keys.join('');
}
$('#kbd').addEventListener('pointerdown', e => {
  const k = e.target.closest('[data-n]');
  if (!k) return;
  const n = +k.dataset.n;
  noteOn(n, 100);
  const up = () => { noteOff(n); removeEventListener('pointerup', up); };
  addEventListener('pointerup', up);
});
$('#oct-up').onclick = () => { prefs.base = Math.min(96, prefs.base + 12); savePrefs(); renderKbd(); };
$('#oct-down').onclick = () => { prefs.base = Math.max(12, prefs.base - 12); savePrefs(); renderKbd(); };

// Computer keyboard: the home row as white keys, the row above as black keys.
const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16 };
const typed = new Map();
document.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); return; }
  if (e.target.closest?.('input:not([type=range]), select, textarea')) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod || e.altKey || e.repeat) return;
  if ((e.key === 'Delete' || e.key === 'Backspace') && viewSel) { e.preventDefault(); deleteSelected(); return; }
  if (e.key === 'Escape' && viewSel) { viewSel = null; renderView(); return; }
  const k = e.key.toLowerCase();
  if (k === 'z' || k === 'x') { (k === 'z' ? $('#oct-down') : $('#oct-up')).click(); return; }
  if (k in KEYMAP && !typed.has(k)) { const n = prefs.base + KEYMAP[k]; typed.set(k, n); noteOn(n, 100); }
});
document.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  if (typed.has(k)) { noteOff(typed.get(k)); typed.delete(k); }
});
addEventListener('blur', () => { for (const n of typed.values()) noteOff(n); typed.clear(); });

// The host page switches views; nothing reloads.
document.querySelectorAll('.app-nav a[data-view]').forEach(a => a.addEventListener('click', e => {
  if (top === self) return;
  e.preventDefault();
  parent.postMessage({ type: 'switch-view', view: a.dataset.view }, location.origin);
}));

// ---------------------------------------------------------------------------------------------
// Start

{
  const w = store.get('working', null);
  let ok = false;
  if (w?.patch) { try { load(w.patch, w.fileName || null, !!w.dirty); ok = true; } catch { /* start fresh */ } }
  if (!ok) load(copyPatch(STARTERS[1]), null, true);
  renderKbd();
  showAudio();
  refreshSaved();
  initMidi();
}
