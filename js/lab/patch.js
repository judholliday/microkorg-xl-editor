// Lab instruments ("patches"): modules, the audio connections between them, and modulation routes.
// A patch is plain data, so the Lab's controls, the AI and the sound engine all work on the same
// thing, and another engine could play the same patches later. No DOM or audio here.
//
// A patch file (data/instruments/<name>.json):
//   { format: 'mkxl-inst', version: 1, name, voices, volume,
//     modules: [{ id, type, params: {...} }],          // in the order they're shown
//     audio: [{ from, to }],                            // module id -> module id, or to 'out'
//     mod: [{ from, to: '<id>.<target>', amount }],     // from an env/lfo id, or 'vel' / 'wheel'
//     cc: { <controller number>: '<id>.<param>' } }     // knobs learned from a MIDI controller
//
// Modules play once per note ('voice') or once for the whole instrument ('global', the effects).
// Voice modules can feed global ones; not the other way round.

export const FORMAT = 'mkxl-inst';
export const VERSION = 1;
export const MAX_MODULES = 24;
export const MAX_VOICES = 16;

const num = (key, label, min, max, def, extra = {}) => ({ key, label, kind: 'num', min, max, def, ...extra });
const choice = (key, label, choices, def, extra = {}) => ({ key, label, kind: 'choice', choices, def: def ?? choices[0], ...extra });
const time = (key, label, def) => num(key, label, 0.001, 10, def, { unit: 's', curve: 'log' });

// Every module type: what it's called, whether it runs per note, its connections, its settings,
// and which settings can be modulated (with the units and range of a modulation amount).
export const MODULES = {
  osc: {
    label: 'Oscillator', scope: 'voice', audioOut: true,
    help: 'A tone at the note\'s pitch.',
    params: [
      choice('wave', 'Wave', ['saw', 'square', 'pulse', 'triangle', 'sine'], 'saw', { rebuild: true }),
      num('octave', 'Octave', -3, 3, 0, { step: 1 }),
      num('semi', 'Semitones', -12, 12, 0, { step: 1 }),
      num('fine', 'Fine', -100, 100, 0, { unit: 'cents', step: 1 }),
      num('pw', 'Pulse width', 0.05, 0.95, 0.5, { help: 'Only for the pulse wave' }),
      num('level', 'Level', 0, 1, 0.7),
    ],
    targets: { pitch: { unit: 'cents', min: -4800, max: 4800 }, pw: { min: -0.45, max: 0.45 }, level: { min: -1, max: 1 } },
  },
  noise: {
    label: 'Noise', scope: 'voice', audioOut: true,
    help: 'White noise, for breath, wind and percussion.',
    params: [num('level', 'Level', 0, 1, 0.3)],
    targets: { level: { min: -1, max: 1 } },
  },
  filter: {
    label: 'Filter', scope: 'voice', audioIn: true, audioOut: true,
    help: 'Shapes the tone. Lowpass makes it darker as the cutoff comes down.',
    params: [
      choice('type', 'Type', ['lowpass', 'highpass', 'bandpass', 'notch']),
      choice('slope', 'Slope', ['24', '12'], '24', { rebuild: true }),
      num('cutoff', 'Cutoff', 20, 20000, 2000, { unit: 'Hz', curve: 'log' }),
      num('resonance', 'Resonance', 0, 20, 1),
      num('keytrack', 'Key track', 0, 1, 0.5, { help: '1 = the cutoff follows the keyboard fully (centred on C4)' }),
    ],
    targets: { cutoff: { unit: 'cents', min: -9600, max: 9600 }, resonance: { min: -20, max: 20 } },
  },
  drive: {
    label: 'Drive', scope: 'voice', audioIn: true, audioOut: true,
    help: 'Soft saturation: warmth at low settings, distortion at high ones.',
    params: [num('amount', 'Amount', 0, 1, 0.3)],
    targets: {},
  },
  amp: {
    label: 'Amp', scope: 'voice', audioIn: true, audioOut: true,
    help: 'The note\'s loudness over time (attack, decay, sustain, release).',
    params: [time('attack', 'Attack', 0.005), time('decay', 'Decay', 0.3), num('sustain', 'Sustain', 0, 1, 0.7),
      time('release', 'Release', 0.3), num('velocity', 'Velocity', 0, 1, 0.6, { help: 'How much harder playing is louder' }),
      num('level', 'Level', 0, 1, 0.8)],
    targets: { level: { min: -1, max: 1 } },
  },
  env: {
    label: 'Envelope', scope: 'voice', modOut: true,
    help: 'A shape over time (0 to 1) to modulate anything, e.g. the filter cutoff.',
    params: [time('attack', 'Attack', 0.005), time('decay', 'Decay', 0.4), num('sustain', 'Sustain', 0, 1, 0.3), time('release', 'Release', 0.4)],
    targets: {},
  },
  lfo: {
    label: 'LFO', scope: 'voice', modOut: true,
    help: 'A slow wave (-1 to 1) for vibrato, wobble and movement; random = a new random value each cycle (sample & hold). Starts with each note.',
    params: [choice('wave', 'Wave', ['sine', 'triangle', 'square', 'saw', 'random'], 'sine', { rebuild: true }), num('rate', 'Rate', 0.05, 30, 5, { unit: 'Hz', curve: 'log' }),
      num('delay', 'Fade in', 0, 5, 0, { unit: 's' }), num('depth', 'Depth', 0, 1, 1)],
    targets: { rate: { unit: 'Hz', min: -20, max: 20 }, depth: { min: -1, max: 1 } },
  },
  fmop: {
    label: 'FM operator', scope: 'voice', audioIn: true, audioOut: true,
    help: 'A sine at a ratio of the note\'s pitch, with its own envelope. Audio sent INTO it bends its frequency (FM): connect one operator into another for bells, electric pianos and basses.',
    params: [
      num('ratio', 'Ratio', 0.25, 16, 1, { curve: 'log', help: 'Its frequency as a multiple of the note\'s (whole numbers sound harmonic, others bell-like)' }),
      num('fine', 'Fine', -100, 100, 0, { unit: 'cents', step: 1 }),
      num('fm', 'FM depth', 0, 10, 1, { help: 'How strongly audio connected to its input bends it (roughly the FM index)' }),
      time('attack', 'Attack', 0.002), time('decay', 'Decay', 1), num('sustain', 'Sustain', 0, 1, 0.5), time('release', 'Release', 0.4),
      num('velocity', 'Velocity', 0, 1, 0.6), num('level', 'Level', 0, 1, 0.7),
    ],
    targets: { pitch: { unit: 'cents', min: -4800, max: 4800 }, level: { min: -1, max: 1 }, fm: { min: -10, max: 10 } },
  },
  ring: {
    label: 'Ring mod', scope: 'voice', audioIn: true, audioOut: true,
    help: 'Multiplies the sound by a sine at a ratio of the note\'s pitch: metallic, bell-like, robotic.',
    params: [num('ratio', 'Ratio', 0.25, 16, 2.5, { curve: 'log' }), num('fine', 'Fine', -100, 100, 0, { unit: 'cents', step: 1 }), num('mix', 'Mix', 0, 1, 0.7)],
    targets: { mix: { min: -1, max: 1 } },
  },
  drums: {
    label: 'Drum kit', scope: 'voice', audioOut: true,
    help: 'Synthesized drums on the standard drum notes (C1 kick, D1 snare, Eb1 clap, F#1 closed hat, Bb1 open hat, toms, cymbals). For drum tracks; other notes play a short blip.',
    params: [num('tune', 'Tune', -12, 12, 0, { unit: 'st', step: 1 }), num('decay', 'Decay', 0.3, 3, 1, { unit: '×', curve: 'log' }),
      num('tone', 'Tone', 0, 1, 0.5, { help: 'Darker to brighter' }), num('level', 'Level', 0, 1, 0.8)],
    targets: {},
  },
  space: {
    label: '3D space', scope: 'voice', audioIn: true, audioOut: true,
    help: 'Places each note around your head (binaural, for headphones). Spread scatters notes at random; Orbit circles them around you.',
    params: [num('azimuth', 'Direction', -180, 180, 0, { unit: '°', step: 1, help: '0 = in front, 90 = right, -90 = left, 180 = behind' }),
      num('elevation', 'Height', -60, 60, 0, { unit: '°', step: 1 }), num('distance', 'Distance', 0.5, 10, 1.5, { unit: 'm', curve: 'log' }),
      num('spread', 'Spread', 0, 180, 0, { unit: '°', step: 1, help: 'Each note goes somewhere at random within this many degrees of the direction' }),
      num('orbit', 'Orbit', 0, 2, 0, { unit: 'Hz', help: 'Circling speed (0 = still); set before playing' })],
    targets: { x: { unit: 'm', min: -10, max: 10 } },
  },
  chorus: {
    label: 'Chorus', scope: 'global', audioIn: true, audioOut: true,
    help: 'Widens and thickens the sound.',
    params: [num('rate', 'Rate', 0.05, 5, 0.6, { unit: 'Hz', curve: 'log' }), num('depth', 'Depth', 0, 1, 0.5), num('mix', 'Mix', 0, 1, 0.4)],
    targets: {},
  },
  delay: {
    label: 'Delay', scope: 'global', audioIn: true, audioOut: true,
    help: 'Echoes.',
    params: [num('time', 'Time', 0.01, 2, 0.35, { unit: 's', curve: 'log' }), num('feedback', 'Feedback', 0, 0.95, 0.35), num('mix', 'Mix', 0, 1, 0.25)],
    targets: {},
  },
  reverb: {
    label: 'Reverb', scope: 'global', audioIn: true, audioOut: true,
    help: 'A sense of space.',
    params: [num('size', 'Size', 0.2, 10, 2.5, { unit: 's', curve: 'log' }), num('mix', 'Mix', 0, 1, 0.25)],
    targets: {},
  },
};

// Modulation sources that aren't modules: how hard the key was played, and the mod wheel (CC 1;
// the MPK mini's joystick pushed up).
export const SOURCES = { vel: { label: 'Velocity', scope: 'voice' }, wheel: { label: 'Mod wheel', scope: 'global' } };

export const paramOf = (type, key) => MODULES[type]?.params.find(p => p.key === key) || null;

function cleanValue(spec, v) {
  if (spec.kind === 'choice') return spec.choices.includes(String(v)) ? String(v) : spec.def;
  const n = Number(v);
  if (!Number.isFinite(n)) return spec.def;
  const c = Math.min(spec.max, Math.max(spec.min, n));
  return spec.step ? Math.round(c / spec.step) * spec.step : c;
}

export function defaultParams(type) {
  return Object.fromEntries(MODULES[type].params.map(p => [p.key, p.def]));
}

// A new module id like "osc2", unused in the patch.
export function newId(patch, type) {
  for (let n = 1; ; n++) if (!patch.modules.some(m => m.id === `${type}${n}`)) return `${type}${n}`;
}

// Checks and repairs a patch from a file, the page or the AI: unknown modules and broken
// connections are dropped, values clamped, missing settings filled in. Throws only if it isn't a
// patch at all. Problems found are listed in `notes` (returned beside the patch, never saved).
export function normalizePatch(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.modules)) throw new Error('not a Lab instrument');
  const notes = [];
  const modules = [];
  for (const m of raw.modules) {
    const spec = MODULES[m?.type];
    if (!spec) { notes.push(`Unknown module type "${m?.type}" left out.`); continue; }
    let id = typeof m.id === 'string' && /^[a-z][a-z0-9_]{0,19}$/i.test(m.id) ? m.id : '';
    if (!id || id === 'out' || SOURCES[id] || modules.some(x => x.id === id)) id = newId({ modules }, m.type);
    const params = {};
    for (const p of spec.params) params[p.key] = cleanValue(p, m.params?.[p.key] ?? p.def);
    modules.push({ id, type: m.type, params });
    if (modules.length >= MAX_MODULES) break;
  }
  const byId = new Map(modules.map(m => [m.id, m]));

  // Audio: from a module with an output to one with an input (or 'out'); voice -> global is fine,
  // global -> voice isn't; no loops (Web Audio can't run them without a delay inside).
  const audio = [];
  const reaches = (from, to) => from === to || audio.some(c => c.from === from && reaches(c.to, to));
  for (const c of Array.isArray(raw.audio) ? raw.audio : []) {
    const a = byId.get(c?.from), b = c?.to === 'out' ? 'out' : byId.get(c?.to);
    const ok = a && b && MODULES[a.type].audioOut && (b === 'out' || (MODULES[b.type].audioIn && b !== a
      && !(MODULES[a.type].scope === 'global' && MODULES[b.type].scope === 'voice')));
    if (!ok || audio.some(x => x.from === c.from && x.to === c.to) || (b !== 'out' && reaches(b.id, a.id))) {
      notes.push(`Audio connection ${c?.from} → ${c?.to} left out.`);
      continue;
    }
    audio.push({ from: a.id, to: b === 'out' ? 'out' : b.id });
  }

  // Modulation: from an env, an lfo or a built-in source to a voice module's modulatable setting.
  const mod = [];
  for (const c of Array.isArray(raw.mod) ? raw.mod : []) {
    const src = SOURCES[c?.from] ? c.from : byId.get(c?.from)?.type && MODULES[byId.get(c.from).type].modOut ? c.from : null;
    const [tid, tkey] = String(c?.to ?? '').split('.');
    const t = byId.get(tid), target = t && MODULES[t.type].targets[tkey];
    if (!src || !target || src === tid || mod.some(x => x.from === src && x.to === c.to)) {
      notes.push(`Modulation ${c?.from} → ${c?.to} left out.`);
      continue;
    }
    const amount = Number.isFinite(Number(c.amount)) ? Math.min(target.max, Math.max(target.min, Number(c.amount))) : 0;
    mod.push({ from: src, to: `${tid}.${tkey}`, amount });
  }

  const cc = {};
  for (const [k, v] of Object.entries(raw.cc && typeof raw.cc === 'object' ? raw.cc : {})) {
    const n = Number(k), [id, key] = String(v).split('.');
    if (Number.isInteger(n) && n >= 0 && n <= 119 && byId.has(id) && paramOf(byId.get(id).type, key)?.kind === 'num') cc[n] = `${id}.${key}`;
  }
  const clampN = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const patch = {
    format: FORMAT, version: VERSION,
    name: String(raw.name ?? 'Untitled').trim().slice(0, 40) || 'Untitled',
    voices: Math.round(clampN(raw.voices, 1, MAX_VOICES, 8)),
    volume: clampN(raw.volume, 0, 1, 0.8),
    modules, audio, mod, cc,
  };
  if (!audio.some(c => c.to === 'out')) notes.push('Nothing is connected to the output, so it makes no sound.');
  return { patch, notes };
}

export const cleanPatch = raw => normalizePatch(raw).patch;
export const copyPatch = p => JSON.parse(JSON.stringify(p));

// A setting's value as text, for the controls.
export function formatValue(spec, v) {
  if (spec.kind === 'choice') return v;
  if (spec.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} Hz`;
  if (spec.unit === 's') return v >= 1 ? `${v.toFixed(2)} s` : `${Math.round(v * 1000)} ms`;
  if (spec.unit === 'cents') return `${v > 0 ? '+' : ''}${Math.round(v)} c`;
  const sign = v > 0 && spec.min < 0 ? '+' : '';
  if (spec.unit === '×') return `×${v.toFixed(2)}`;
  if (spec.unit === '°') return `${sign}${Math.round(v)}°`;
  const unit = spec.unit ? ` ${spec.unit}` : '';
  if (spec.step === 1) return `${sign}${v}${unit}`;
  return `${v.toFixed(2)}${unit}`;
}

// A slider position (0-1) and a value, both ways; log settings get a log slider.
export const toSlider = (spec, v) => (spec.curve === 'log'
  ? Math.log(v / spec.min) / Math.log(spec.max / spec.min) : (v - spec.min) / (spec.max - spec.min));
export const fromSlider = (spec, x) => cleanValue(spec, spec.curve === 'log'
  ? spec.min * (spec.max / spec.min) ** x : spec.min + x * (spec.max - spec.min));

// ---- starting points ----

const mod = (type, id, params = {}) => ({ id, type, params: { ...defaultParams(type), ...params } });

export const STARTERS = [
  cleanPatch({
    name: 'Init', voices: 8,
    modules: [mod('osc', 'osc1', { wave: 'saw' }), mod('filter', 'filter1', { cutoff: 4000 }), mod('amp', 'amp1')],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'filter1', to: 'amp1' }, { from: 'amp1', to: 'out' }],
  }),
  cleanPatch({
    name: 'Analog Brass', voices: 8,
    modules: [mod('osc', 'osc1', { wave: 'saw', level: 0.6 }), mod('osc', 'osc2', { wave: 'saw', fine: 8, level: 0.6 }),
      mod('filter', 'filter1', { cutoff: 700, resonance: 2 }), mod('env', 'env1', { attack: 0.06, decay: 0.5, sustain: 0.45, release: 0.3 }),
      mod('amp', 'amp1', { attack: 0.03, sustain: 0.85, release: 0.25 }), mod('chorus', 'chorus1', { mix: 0.3 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, { from: 'filter1', to: 'amp1' },
      { from: 'amp1', to: 'chorus1' }, { from: 'chorus1', to: 'out' }],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 3600 }, { from: 'vel', to: 'filter1.cutoff', amount: 1200 }],
  }),
  cleanPatch({
    name: 'Square Bass', voices: 4,
    modules: [mod('osc', 'osc1', { wave: 'square', octave: -1, level: 0.7 }), mod('osc', 'osc2', { wave: 'saw', octave: -2, level: 0.5 }),
      mod('filter', 'filter1', { cutoff: 220, resonance: 5, keytrack: 0.3 }), mod('env', 'env1', { attack: 0.002, decay: 0.25, sustain: 0.1, release: 0.15 }),
      mod('drive', 'drive1', { amount: 0.25 }), mod('amp', 'amp1', { attack: 0.002, decay: 0.4, sustain: 0.8, release: 0.08 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, { from: 'filter1', to: 'drive1' },
      { from: 'drive1', to: 'amp1' }, { from: 'amp1', to: 'out' }],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 4200 }, { from: 'vel', to: 'filter1.cutoff', amount: 1500 }],
  }),
  cleanPatch({
    name: 'Soft Pad', voices: 10, volume: 0.7,
    modules: [mod('osc', 'osc1', { wave: 'saw', fine: -9, level: 0.5 }), mod('osc', 'osc2', { wave: 'saw', fine: 9, level: 0.5 }),
      mod('filter', 'filter1', { slope: '12', cutoff: 1100, resonance: 1.5 }), mod('lfo', 'lfo1', { rate: 0.3 }),
      mod('lfo', 'lfo2', { rate: 5.5, depth: 0 }), mod('amp', 'amp1', { attack: 1.2, decay: 1, sustain: 0.85, release: 1.8 }),
      mod('chorus', 'chorus1', { mix: 0.45 }), mod('reverb', 'reverb1', { size: 4, mix: 0.35 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, { from: 'filter1', to: 'amp1' },
      { from: 'amp1', to: 'chorus1' }, { from: 'chorus1', to: 'reverb1' }, { from: 'reverb1', to: 'out' }],
    mod: [{ from: 'lfo1', to: 'filter1.cutoff', amount: 700 }, { from: 'lfo2', to: 'osc1.pitch', amount: 25 },
      { from: 'wheel', to: 'lfo2.depth', amount: 1 }, { from: 'lfo2', to: 'osc2.pitch', amount: 25 }],
  }),
  cleanPatch({
    name: 'PWM Strings', voices: 8, volume: 0.7,
    modules: [mod('osc', 'osc1', { wave: 'pulse', pw: 0.5, level: 0.6 }), mod('lfo', 'lfo1', { wave: 'triangle', rate: 0.8 }),
      mod('filter', 'filter1', { cutoff: 2600, resonance: 0.7 }), mod('amp', 'amp1', { attack: 0.35, decay: 0.5, sustain: 0.9, release: 0.9 }),
      mod('reverb', 'reverb1', { size: 3, mix: 0.3 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'filter1', to: 'amp1' }, { from: 'amp1', to: 'reverb1' }, { from: 'reverb1', to: 'out' }],
    mod: [{ from: 'lfo1', to: 'osc1.pw', amount: 0.35 }],
  }),
  cleanPatch({
    name: 'FM Electric Piano', voices: 10,
    modules: [mod('fmop', 'op1', { ratio: 1, fm: 1.2, attack: 0.002, decay: 2.2, sustain: 0.25, release: 0.5, level: 0.7 }),
      mod('fmop', 'op2', { ratio: 1, decay: 1.4, sustain: 0.2, release: 0.5, velocity: 0.9, level: 0.6 }),
      mod('fmop', 'op3', { ratio: 14, decay: 0.12, sustain: 0, release: 0.1, velocity: 1, level: 0.35 }),
      mod('chorus', 'chorus1', { rate: 0.5, mix: 0.35 })],
    audio: [{ from: 'op2', to: 'op1' }, { from: 'op3', to: 'op1' }, { from: 'op1', to: 'chorus1' }, { from: 'chorus1', to: 'out' }],
  }),
  cleanPatch({
    name: 'FM Bell', voices: 10, volume: 0.7,
    modules: [mod('fmop', 'op1', { ratio: 1, fm: 2.5, attack: 0.001, decay: 4, sustain: 0, release: 3, level: 0.7 }),
      mod('fmop', 'op2', { ratio: 3.5, attack: 0.001, decay: 3, sustain: 0, release: 2, level: 0.8 }),
      mod('reverb', 'reverb1', { size: 4, mix: 0.3 })],
    audio: [{ from: 'op2', to: 'op1' }, { from: 'op1', to: 'reverb1' }, { from: 'reverb1', to: 'out' }],
  }),
  cleanPatch({
    name: 'Drum Kit', voices: 16,
    modules: [mod('drums', 'drums1'), mod('reverb', 'reverb1', { size: 0.8, mix: 0.12 })],
    audio: [{ from: 'drums1', to: 'reverb1' }, { from: 'reverb1', to: 'out' }],
  }),
  cleanPatch({
    name: 'Space Pad', voices: 10, volume: 0.75,
    modules: [mod('osc', 'osc1', { wave: 'saw', fine: -7, level: 0.5 }), mod('osc', 'osc2', { wave: 'triangle', octave: 1, level: 0.35 }),
      mod('filter', 'filter1', { slope: '12', cutoff: 1500, resonance: 1 }), mod('lfo', 'lfo1', { wave: 'random', rate: 2, depth: 1 }),
      mod('amp', 'amp1', { attack: 0.8, decay: 1, sustain: 0.8, release: 2.5 }),
      mod('space', 'space1', { spread: 150, distance: 2 }), mod('reverb', 'reverb1', { size: 5, mix: 0.35 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, { from: 'filter1', to: 'amp1' },
      { from: 'amp1', to: 'space1' }, { from: 'space1', to: 'reverb1' }, { from: 'reverb1', to: 'out' }],
    mod: [{ from: 'lfo1', to: 'filter1.cutoff', amount: 600 }],
  }),
  cleanPatch({
    name: 'Ring Bells', voices: 8, volume: 0.7,
    modules: [mod('osc', 'osc1', { wave: 'triangle', level: 0.8 }), mod('ring', 'ring1', { ratio: 2.76, mix: 0.8 }),
      mod('amp', 'amp1', { attack: 0.001, decay: 1.5, sustain: 0, release: 1.2 }), mod('delay', 'delay1', { time: 0.42, feedback: 0.35, mix: 0.25 })],
    audio: [{ from: 'osc1', to: 'ring1' }, { from: 'ring1', to: 'amp1' }, { from: 'amp1', to: 'delay1' }, { from: 'delay1', to: 'out' }],
  }),
  cleanPatch({
    name: 'Pluck Echo', voices: 8,
    modules: [mod('osc', 'osc1', { wave: 'triangle', level: 0.6 }), mod('osc', 'osc2', { wave: 'square', octave: 1, level: 0.25 }),
      mod('filter', 'filter1', { cutoff: 600, resonance: 3 }), mod('env', 'env1', { attack: 0.001, decay: 0.18, sustain: 0, release: 0.15 }),
      mod('amp', 'amp1', { attack: 0.001, decay: 0.5, sustain: 0, release: 0.3 }), mod('delay', 'delay1', { time: 0.375, feedback: 0.4, mix: 0.3 })],
    audio: [{ from: 'osc1', to: 'filter1' }, { from: 'osc2', to: 'filter1' }, { from: 'filter1', to: 'amp1' },
      { from: 'amp1', to: 'delay1' }, { from: 'delay1', to: 'out' }],
    mod: [{ from: 'env1', to: 'filter1.cutoff', amount: 4800 }],
  }),
];
