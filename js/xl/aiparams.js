// Translation between program bytes and the readable values the AI sound designer works with.
// Keys are the editor's own parameter keys (e.g. "t1.f1Cutoff"), except effect parameters,
// which are named after the effect's own parameter names (e.g. "fx1.Feedback") because their
// meaning depends on the effect type.

import {
  PROGRAM_PARAMS, timbreParams, vocoderParams, fxParams, arpParams, getValue, setValue, format, range,
  TABLES, FX_TYPES, programName, setProgramName, fxLabel, fxDefault, noteName, parseNote,
} from './params.js';

const SECTIONS = [
  [/^knob\d$/, 'Panel knob assignments'],
  [/^(unison|unisonDetune|unisonSpread|voiceAssign)$/, 'Voice'],
  [/^(analogTune|transpose|detune|vibrato|bendRange|portamento)$/, 'Pitch'],
  [/^(osc1Level|osc2Level|noiseLevel)$/, 'Mixer'],
  [/^osc1/, 'Oscillator 1'],
  [/^osc2/, 'Oscillator 2'],
  [/^(filterRouting|f1)/, 'Filter 1'],
  [/^f2/, 'Filter 2'],
  [/^(ampLevel|pan|ampKeyTrack|punch)$/, 'Amp'],
  [/^ws/, 'Drive / Wave Shape'],
  [/^eg1/, 'EG1 (filter envelope)'],
  [/^eg2/, 'EG2 (amp envelope)'],
  [/^eg3/, 'EG3 (assignable envelope)'],
  [/^lfo1/, 'LFO1'],
  [/^lfo2/, 'LFO2'],
  [/^patch/, 'Virtual patch (mod matrix)'],
  [/^eq/, 'EQ'],
];

function timbreSection(key) {
  const short = key.split('.')[1];
  return SECTIONS.find(([re]) => re.test(short))?.[1] || 'Other';
}

// The effect param key the AI sees, unique within an effect type.
function fxAiKey(p, slot) {
  const label = fxLabel(p.label);
  const synced = p.fmt.k === 'table' && (p.fmt.t === 'T08-07' || p.fmt.t === 'T08-09');
  return `fx${slot + 1}.${label}${synced && !/Sync/.test(label) ? ' (synced)' : ''}`;
}

// All addressable params for the given program bytes, with AI-facing keys and sections.
export function aiParams(data) {
  const out = [];
  for (const p of PROGRAM_PARAMS) out.push({ key: p.key, section: 'Program', p });
  for (const t of [0, 1]) {
    for (const p of timbreParams(t)) out.push({ key: p.key, section: `Timbre ${t + 1} › ${timbreSection(p.key)}`, p });
  }
  for (const s of [0, 1]) {
    for (const p of fxParams(data, s)) {
      const k = p.key.split('.')[1];
      const key = k === 'type' || k === 'ctrl1' || k === 'ctrl2' ? p.key : fxAiKey(p, s);
      out.push({ key, section: `Effect ${s + 1}`, p });
    }
  }
  for (const p of arpParams()) out.push({ key: p.key, section: 'Arpeggiator', p });
  for (const p of vocoderParams()) out.push({ key: p.key, section: 'Vocoder', p });
  return out;
}

const parseNum = s => {
  if (typeof s === 'number') return s;
  const m = String(s).trim().match(/^([+-]?\d*\.?\d+)\s*(k)?/i);
  return m ? parseFloat(m[1]) * (m[2] ? 1000 : 1) : NaN;
};

// Bytes -> readable value (number where the value is numeric, otherwise a label).
export function toAi(p, raw) {
  const f = p.fmt;
  const [min, max] = range(f);
  raw = Math.max(min, Math.min(max, raw));
  switch (f.k) {
    case 'enum': return f.o[raw] ?? raw;
    case 'pan': return raw - 64; // -63 (left) .. +63 (right)
    case 'drywet': return raw; // 0 = dry, 100 = wet
    case 'fbal': return raw;
    case 'tempo': return raw;
    case 'note': return noteName(raw);
    case 'table': {
      const s = TABLES[f.t][raw];
      const n = parseNum(s);
      return /\//.test(s) || Number.isNaN(n) ? s : n;
    }
    case 'range': return Number(((raw - (f.bias || 0)) * (f.scale || 1) + (f.add || 0)).toFixed(f.dec || 0));
  }
  return raw;
}

// Readable value -> bytes. Throws with a helpful message if the value can't be understood.
export function fromAi(p, value) {
  const f = p.fmt;
  const [min, max] = range(f);
  const clamp = v => Math.max(min, Math.min(max, Math.round(v)));
  switch (f.k) {
    case 'enum': {
      if (typeof value === 'number') return clamp(value);
      const v = String(value).toLowerCase().replace(/\s+/g, '');
      const i = f.o.findIndex(o => o.toLowerCase().replace(/\s+/g, '') === v);
      if (i < 0) throw new Error(`"${value}" isn't one of: ${f.o.join(', ')}`);
      return i;
    }
    case 'pan': {
      const s = String(value).trim().toUpperCase();
      if (s === 'C' || s === 'CENTER') return 64;
      const m = s.match(/^([LR])(\d+)$/);
      return clamp(m ? 64 + (m[1] === 'L' ? -1 : 1) * +m[2] : parseNum(value) + 64);
    }
    case 'note': {
      const n = parseNote(value);
      if (Number.isNaN(n)) throw new Error(`"${value}" isn't a note name like C4 or F#3`);
      return clamp(n);
    }
    case 'drywet': {
      if (/^dry$/i.test(value)) return 0;
      if (/^wet$/i.test(value)) return 100;
      return clamp(parseNum(value));
    }
    case 'table': {
      const table = TABLES[f.t];
      const exact = table.indexOf(String(value));
      if (exact >= 0) return exact;
      const n = parseNum(value);
      if (Number.isNaN(n) || /\//.test(String(value))) throw new Error(`"${value}" isn't a valid value`);
      let best = 0;
      let bestDiff = Infinity;
      table.forEach((s, i) => { const d = Math.abs(parseNum(s) - n); if (d < bestDiff) { best = i; bestDiff = d; } });
      return best;
    }
    case 'range': {
      const n = parseNum(value);
      if (Number.isNaN(n)) throw new Error(`"${value}" isn't a number`);
      return clamp((n - (f.add || 0)) / (f.scale || 1) + (f.bias || 0));
    }
    default: {
      const n = parseNum(value);
      if (Number.isNaN(n)) throw new Error(`"${value}" isn't a number`);
      return clamp(n);
    }
  }
}

// Human-readable description of what values a parameter accepts.
export function valueSpec(p) {
  const f = p.fmt;
  const [min, max] = range(f);
  const unit = f.unit ? ` ${f.unit}` : '';
  switch (f.k) {
    case 'enum': return `one of: ${f.o.map(o => JSON.stringify(o)).join(', ')}`;
    case 'pan': return 'number -63 (hard left) .. 0 (center) .. +63 (hard right)';
    case 'drywet': return 'number 0 (dry) .. 100 (wet)';
    case 'fbal': return 'number 0..127: 0=LPF24, 32=LPF12, 64=HPF, 96=BPF, 127=Thru (values between morph)';
    case 'tempo': return 'number 20..300 BPM';
    case 'note': return 'note name, C-1..G9 (C4 = middle C)';
    case 'table': {
      const t = TABLES[f.t];
      if (t.length <= 20) return `one of: ${t.map(s => JSON.stringify(s)).join(', ')}${unit}`;
      return `number ${t[0]}..${t[t.length - 1]}${unit} (snaps to the nearest of ${t.length} steps)`;
    }
    case 'range': return `number ${toAi(p, min)}..${toAi(p, max)}${unit}`;
  }
  return `number ${min}..${max}`;
}

// Program bytes -> { name, settings: { key: value } }.
export function programToAi(data) {
  const settings = {};
  for (const { key, p } of aiParams(data)) settings[key] = toAi(p, getValue(data, p));
  return { name: programName(data), settings };
}

// Apply { key: value } changes onto program bytes (mutates `data`). Effect and oscillator types
// are applied first because other parameters' meaning depends on them.
export function applyAiChanges(data, changes, name) {
  const applied = [];
  const errors = [];
  const entries = Object.entries(changes || {});
  const first = entries.filter(([k]) => /^fx\d\.type$/.test(k));
  const rest = entries.filter(([k]) => !/^fx\d\.type$/.test(k));
  for (const [key, value] of first) {
    const slot = +key[2] - 1;
    const p = fxParams(data, slot)[0];
    try {
      const v = fromAi(p, value);
      if (v !== getValue(data, p)) {
        setValue(data, p, v);
        // Seed the new effect's parameters so anything the AI doesn't set is still sensible.
        fxParams(data, slot).slice(1).forEach((q, i) => setValue(data, q, i < 2 ? 0 : fxDefault(q)));
      }
      applied.push(key);
    } catch (e) { errors.push(`${key}: ${e.message}`); }
  }
  const index = new Map(aiParams(data).map(a => [a.key, a.p]));
  for (const [key, value] of rest) {
    const p = index.get(key);
    if (!p) { errors.push(`${key}: unknown parameter`); continue; }
    try { setValue(data, p, fromAi(p, value)); applied.push(key); } catch (e) { errors.push(`${key}: ${e.message}`); }
  }
  if (name) setProgramName(data, String(name).replace(/[^\x20-\x7e]/g, '').slice(0, 8));
  return { applied, errors };
}

// Plain-text parameter reference for the AI's system prompt.
export function parameterReference(sampleData) {
  const lines = [];
  let section = '';
  for (const { key, section: sec, p } of aiParams(sampleData)) {
    if (key.startsWith('fx') && !/\.(type|ctrl1|ctrl2)$/.test(key)) continue; // listed per effect type below
    if (key.startsWith('t2.')) continue; // same as Timbre 1, noted below
    if (/^voc\.band\d+(Pan|Level)$/.test(key) && !/band1(Pan|Level)$/.test(key)) continue;
    if (sec !== section) {
      section = sec;
      lines.push('', `### ${sec}`);
      if (sec === 'Timbre 1 › Panel knob assignments') lines.push('(Timbre 2 has exactly the same parameters with keys starting "t2." instead of "t1.")');
    }
    let label = p.label;
    if (/^voc\.band1/.test(key)) label = `Band 1-16 ${/Pan$/.test(key) ? 'pan' : 'level'} (keys voc.band1${key.endsWith('Pan') ? 'Pan' : 'Level'} .. voc.band16${key.endsWith('Pan') ? 'Pan' : 'Level'})`;
    if (/\.ctrl[12]$/.test(key)) { lines.push(`- ${key}: ${label} — name of one of the selected effect's parameters (which one the synth's FX control knob adjusts)`); continue; }
    lines.push(`- ${key}: ${label} — ${valueSpec(p)}`);
  }
  lines.push('', '### Effect parameters by type', 'Set fx1.type / fx2.type first; then use keys fx1.<Param> / fx2.<Param> from the chosen type:');
  FX_TYPES.forEach((t, i) => {
    if (!i) return;
    const d = new Uint8Array(400);
    d[286] = i;
    const ps = fxParams(d, 0).slice(3);
    lines.push('', `#### ${t.name}`);
    for (const p of ps) lines.push(`- fx1.${fxAiKey(p, 0).slice(4)}: ${valueSpec(p)}`);
  });
  return lines.join('\n');
}

export { format };
