// Program parameter map for the microKORG XL, from Tables 1-6 of Korg's MIDI Implementation.
// Each parameter knows where it lives in the decoded program dump (byte offset + optional bit
// field), how to display its value, and its Parameter Change ID/Sub ID.

import { FX_TABLES, FX_TYPES } from './fxdata.js';

export const PROGRAM_SIZE = 346; // sum of Table 1 regions (the spec's NOTE 1 says 342; the tables say 346)

const TIMBRE_BASE = [16, 112];
const TIMBRE_ID = [0x10, 0x20];
const VOCODER_BASE = 208;
const FX_BASE = 286;
const ARP_BASE = 338;

// ---- lookup tables ---------------------------------------------------------------------------

const LFO_FREQ = FX_TABLES['T08-02']; // T06-3 is identical
const SYNC_NOTE = FX_TABLES['T08-03']; // T06-4 is identical

// *4-12 (T06-8 in the spec text is garbled; this is the same 128-step curve)
const KEY_TRACK = [
  -2.00, -2.00, -1.93, -1.86, -1.80, -1.73, -1.66, -1.60, -1.53, -1.46, -1.40, -1.33, -1.26, -1.20, -1.13, -1.06,
  -1.00, -0.97, -0.95, -0.93, -0.91, -0.89, -0.87, -0.85, -0.83, -0.81, -0.79, -0.77, -0.75, -0.72, -0.70, -0.68,
  -0.66, -0.64, -0.62, -0.60, -0.58, -0.56, -0.54, -0.52, -0.50, -0.47, -0.45, -0.43, -0.41, -0.39, -0.37, -0.35,
  -0.33, -0.31, -0.29, -0.27, -0.25, -0.22, -0.20, -0.18, -0.16, -0.14, -0.12, -0.10, -0.08, -0.06, -0.04, -0.02,
  0.00, 0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.14, 0.16, 0.18, 0.20, 0.22, 0.25, 0.27, 0.29, 0.31,
  0.33, 0.35, 0.37, 0.39, 0.41, 0.43, 0.45, 0.47, 0.50, 0.52, 0.54, 0.56, 0.58, 0.60, 0.62, 0.64,
  0.66, 0.68, 0.70, 0.72, 0.75, 0.77, 0.79, 0.81, 0.83, 0.85, 0.87, 0.89, 0.91, 0.93, 0.95, 0.97,
  1.00, 1.06, 1.13, 1.20, 1.26, 1.33, 1.40, 1.46, 1.53, 1.60, 1.66, 1.73, 1.80, 1.86, 1.93, 2.00,
].map(v => (v > 0 ? '+' : '') + v.toFixed(2));

// T06-7 (cents)
const VIBRATO = [
  -2400, -2400, -2320, -2240, -2160, -2080, -2000, -1920, -1840, -1760, -1680, -1600, -1520, -1440, -1360, -1280,
  -1200, -1175, -1150, -1125, -1100, -1075, -1050, -1025, -1000, -975, -950, -925, -900, -875, -850, -825,
  -800, -775, -750, -725, -700, -675, -650, -625, -600, -550, -500, -440, -380, -320, -260, -200,
  -160, -120, -100, -80, -60, -40, -30, -25, -20, -15, -10, -5, -4, -3, -2, -1,
  0, 1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 40, 60, 80, 100, 120,
  160, 200, 260, 320, 380, 440, 500, 550, 600, 625, 650, 675, 700, 725, 750, 775,
  800, 825, 850, 875, 900, 925, 950, 975, 1000, 1025, 1050, 1075, 1100, 1125, 1150, 1175,
  1200, 1280, 1360, 1440, 1520, 1600, 1680, 1760, 1840, 1920, 2000, 2080, 2160, 2240, 2320, 2400,
].map(v => (v > 0 ? '+' : '') + v + 'c');

// T02-1 (Hz) — the spec text drops a digit for 100-180; T08-05 confirms the values.
const EQ_LOW_FREQ = ['20', '22', '25', '28', '32', '36', '40', '45', '50', '56', '63', '71', '80', '90', '100', '112',
  '125', '140', '160', '180', '200', '224', '250', '280', '315', '400', '450', '500', '560', '630', '710', '800',
  '900', '1k'];
const EQ_HI_FREQ = ['1.00', '1.12', '1.25', '1.40', '1.60', '1.80', '2.00', '2.24', '2.50', '2.80', '3.15', '4.00',
  '4.50', '5.00', '5.60', '6.30', '7.10', '8.00', '9.00', '10.0', '11.2', '12.5', '14.0', '16.0', '18.0', '20.0']
  .map(v => v + 'k');

export const TABLES = { ...FX_TABLES, LFO_FREQ, SYNC_NOTE, KEY_TRACK, VIBRATO, EQ_LOW_FREQ, EQ_HI_FREQ };

export const MOD_SOURCES = ['EG1', 'EG2', 'EG3', 'LFO1', 'LFO2', 'Velocity', 'Pitch Bend', 'Mod Wheel',
  'Key Track', 'MIDI1', 'MIDI2', 'MIDI3'];

export const PATCH_DESTS = ['Pitch', 'OSC2 Tune', 'OSC1 Ctrl1', 'OSC1 Level', 'OSC2 Level', 'Noise Level',
  'Filt1 Balance', 'Filt1 Cutoff', 'Filt1 Reso', 'Filt2 Cutoff', 'Drive/WS Depth', 'Amp Level', 'Panpot',
  'LFO1 Freq', 'LFO2 Freq', 'Portamento', 'OSC1 Ctrl2', 'Filt1 EG1 Int', 'Filt1 KeyTrack', 'Filt2 Reso',
  'Filt2 EG1 Int', 'Filt2 KeyTrack', 'EG1 Attack', 'EG1 Decay', 'EG1 Sustain', 'EG1 Release', 'EG2 Attack',
  'EG2 Decay', 'EG2 Sustain', 'EG2 Release', 'EG3 Attack', 'EG3 Decay', 'EG3 Sustain', 'EG3 Release',
  'Patch1 Int', 'Patch2 Int', 'Patch3 Int', 'Patch4 Int', 'Patch5 Int', 'Patch6 Int'];

const KNOB_ASSIGN = ['Off', 'Portamento', 'OSC1 Ctrl1', 'OSC1 Ctrl2', 'OSC2 Semitone', 'OSC2 Tune', 'OSC1 Level',
  'OSC2 Level', 'Noise Level', 'Cutoff 1', 'Reso 1', 'Filter Bal 1', 'EG1 Int 1', 'Cutoff 2', 'Reso 2',
  'EG1 Int 2', 'Amp Level', 'Pan', 'WS Depth', 'EG1 Attack', 'EG1 Decay', 'EG1 Sustain', 'EG1 Release',
  'EG2 Attack', 'EG2 Decay', 'EG2 Sustain', 'EG2 Release', 'LFO1 Freq', 'LFO2 Freq', 'Patch1 Int',
  'Patch2 Int', 'Patch3 Int', 'Patch4 Int', 'Patch5 Int', 'Patch6 Int', 'Hi EQ Gain', 'Lo EQ Gain',
  'FX1 Dry/Wet', 'FX1 Ctrl1', 'FX1 Ctrl2', 'FX2 Dry/Wet', 'FX2 Ctrl1', 'FX2 Ctrl2', 'Arp Gate', 'Arp Oct Range',
  'Arp Swing', 'Voc Timb1 Lvl', 'Voc Timb2 Lvl', 'Voc HPF Lvl', 'Voc Fc Offset', 'Voc Resonance',
  'Voc EF Sens', 'Voc Fc Mod Int', 'Voc Direct Lvl', 'Voc Level'];

export const OSC1_WAVES = ['Saw', 'Pulse', 'Triangle', 'Sine', 'Formant', 'Noise', 'PCM/DWGS', 'Audio In'];
export const OSC1_MODS = ['Waveform', 'Cross', 'Unison', 'VPM'];

// The PCM/DWGS wave list isn't in the MIDI spec (it's in the owner's manual), so it's shown by number.

// ---- value formats ---------------------------------------------------------------------------

const enumOf = (...o) => ({ k: 'enum', o });
const plain = (min = 0, max = 127, unit = '') => ({ k: 'range', min, max, unit });
const bipolar = (n, scale = 1, unit = '', dec = 0) => ({ k: 'range', min: 64 - n, max: 64 + n, bias: 64, scale, unit, dec });
const table = (t, unit = '', center) => ({ k: 'table', t, min: 0, max: TABLES[t].length - 1, unit, center });
const PAN = { k: 'pan', min: 0, max: 127 };
const OFF_ON = enumOf('Off', 'On');

export function range(fmt) {
  if (fmt.k === 'enum') return [0, fmt.o.length - 1];
  return [fmt.min, fmt.max];
}

const FBAL_POINTS = [[0, 'LPF24'], [32, 'LPF12'], [64, 'HPF'], [96, 'BPF'], [127, 'Thru']];

export function format(fmt, v) {
  switch (fmt.k) {
    case 'enum':
      return fmt.o[v] ?? String(v);
    case 'table': {
      const s = TABLES[fmt.t][v];
      return s === undefined ? String(v) : s + (fmt.unit ? ' ' + fmt.unit : '');
    }
    case 'drywet':
      return v === 0 ? 'Dry' : v >= 100 ? 'Wet' : `${100 - v}:${v}`;
    case 'pan':
      return v === 64 ? 'C' : v < 64 ? `L${Math.min(63, 64 - v)}` : `R${v - 64}`;
    case 'fbal': {
      for (const [at, name] of FBAL_POINTS) if (Math.abs(v - at) <= 1) return name;
      const i = FBAL_POINTS.findIndex(([at]) => at > v);
      return `${FBAL_POINTS[i - 1][1]}›${FBAL_POINTS[i][1]}`;
    }
    case 'tempo':
      return String(v);
    case 'note':
      return noteName(v);
    case 'range': {
      // Some factory presets hold values outside the documented range (e.g. Chorus LFO Spread = 146);
      // show them at the nearest valid value.
      v = Math.max(fmt.min, Math.min(fmt.max, v));
      const n = (v - (fmt.bias || 0)) * (fmt.scale || 1) + (fmt.add || 0);
      const s = n.toFixed(fmt.dec || 0);
      const signed = fmt.bias && n > 0 ? '+' + s : s;
      return fmt.unit ? `${signed}${fmt.unit === '%' || fmt.unit === '°' || fmt.unit === 'c' ? '' : ' '}${fmt.unit}` : signed;
    }
  }
  return String(v);
}

// ---- reading & writing values in the program buffer ---------------------------------------

export function getValue(data, p) {
  if (p.word) return data[p.off] | (data[p.off + 1] << 8);
  const byte = data[p.off];
  if (p.bits === undefined) return byte;
  const [lo, hi] = p.bits;
  return (byte >> lo) & ((1 << (hi - lo + 1)) - 1);
}

export function setValue(data, p, v) {
  if (p.word) { data[p.off] = v & 0xff; data[p.off + 1] = (v >> 8) & 0xff; return; }
  if (p.bits === undefined) { data[p.off] = v & 0xff; return; }
  const [lo, hi] = p.bits;
  const mask = ((1 << (hi - lo + 1)) - 1) << lo;
  data[p.off] = (data[p.off] & ~mask) | ((v << lo) & mask);
}

// ---- parameter definitions ------------------------------------------------------------------

const P = (key, label, off, fmt, id, sub, extra = {}) => ({ key, label, off, fmt, id, sub, ...extra });

export const PROGRAM_PARAMS = [
  P('voiceMode', 'Voice Mode', 8, enumOf('Single', 'Layer', 'Split', 'Multi'), 0x00, 0x19, { bits: [6, 7] }),
  P('arpTimbre', 'Arp Target', 8, enumOf('Timbre 1', 'Timbre 2', 'Timbre 1+2'), 0x00, 0x18, { bits: [4, 5] }),
  P('scaleType', 'Scale', 12, enumOf('Equal Temp', 'Pure Major', 'Pure Minor', 'Arabic', 'Pythagorean',
    'Werckmeister', 'Kirnberger', 'Slendro', 'Pelog', 'User Scale'), 0x00, 0x17, { bits: [0, 3] }),
  P('scaleKey', 'Scale Key', 12, enumOf('C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'), 0x00, 0x1e, { bits: [4, 7] }),
  P('timbre2Ch', 'Timbre 2 MIDI Ch', 13, enumOf(...Array.from({ length: 16 }, (_, i) => String(i + 1)), 'Global'), 0x00, 0x1a),
  P('octave', 'Octave', 15, { k: 'range', min: 5, max: 11, bias: 8 }, 0x00, 0x1d, { bits: [4, 7] }),
  // Not in Korg's MIDI spec (byte 14 is listed as a dummy byte), but every factory Split program
  // stores its split key here: Timbre 1 plays below it, Timbre 2 at and above it. With no
  // Parameter Change ID, edits are always sent as a whole program.
  P('splitPoint', 'Split Point', 14, { k: 'note', min: 0, max: 127 }, null, null),
];

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = n => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`; // 60 = C4 (middle C)
export function parseNote(v) {
  if (typeof v === 'number') return v;
  const m = String(v).trim().toUpperCase().match(/^([A-G])(#|B)?(-?\d+)$/);
  if (!m) return NaN;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]];
  return (+m[3] + 1) * 12 + base + (m[2] === '#' ? 1 : m[2] === 'B' ? -1 : 0);
}

function oscCtrlLabels(wave, mod) {
  if (wave <= 3) {
    return [
      ['Waveform', 'Mod Depth', 'Detune', 'Mod Depth'][mod],
      [wave === 1 ? 'PWM LFO1 Int' : 'WFM LFO1 Int', 'Depth LFO1 Int', 'Unison Phase', 'Carrier Harm.'][mod],
    ];
  }
  return {
    4: ['Formant Width', 'Formant Shift'],
    5: ['Resonance', 'LPF/HPF Bal'],
    6: ['(unused)', '(unused)'],
    7: ['Gain', '(unused)'],
  }[wave];
}

export function timbreParams(t) {
  const b = TIMBRE_BASE[t];
  const id = TIMBRE_ID[t];
  const T = (key, label, rel, fmt, idOff, sub, extra) => P(`t${t + 1}.${key}`, label, b + rel, fmt, id + idOff, sub, extra);
  const params = [
    T('knob1', 'Knob 1', 0, enumOf(...KNOB_ASSIGN), 0, 0x00),
    T('knob2', 'Knob 2', 1, enumOf(...KNOB_ASSIGN), 0, 0x01),
    T('knob3', 'Knob 3', 2, enumOf(...KNOB_ASSIGN), 0, 0x02),

    T('unison', 'Unison', 4, enumOf('Off', '2 Voice', '3 Voice', '4 Voice'), 0, 0x08, { bits: [0, 3] }),
    T('unisonDetune', 'Uni Detune', 5, plain(0, 99, 'c'), 0, 0x09),
    T('unisonSpread', 'Uni Spread', 6, plain(), 0, 0x0a),
    T('voiceAssign', 'Assign', 7, enumOf('Mono 1', 'Mono 2', 'Poly'), 0, 0x0b, { bits: [6, 7] }),

    T('analogTune', 'Analog Tune', 9, plain(), 0, 0x13),
    T('transpose', 'Transpose', 10, bipolar(48), 0, 0x14),
    T('detune', 'Detune', 11, bipolar(50, 1, 'c'), 0, 0x15),
    T('vibrato', 'Vibrato Int', 12, table('VIBRATO', '', 64), 0, 0x16),
    T('bendRange', 'Bend Range', 13, bipolar(12), 0, 0x10),
    T('portamento', 'Portamento', 14, plain(), 0, 0x11),

    T('osc1Wave', 'Wave', 16, enumOf(...OSC1_WAVES), 0, 0x17, { bits: [0, 3] }),
    T('osc1Mod', 'Mod Type', 16, enumOf(...OSC1_MODS), 0, 0x18, { bits: [4, 5] }),
    T('osc1Ctrl1', 'Ctrl 1', 17, plain(), 0, 0x19),
    T('osc1Ctrl2', 'Ctrl 2', 18, plain(), 0, 0x1a),
    T('osc1Pcm', 'PCM/DWGS', 19, { k: 'range', min: 0, max: 64, add: 1 }, 0, 0x1b),

    T('osc2Wave', 'Wave', 21, enumOf('Saw', 'Pulse', 'Triangle', 'Sine'), 0, 0x20, { bits: [0, 1] }),
    T('osc2Mod', 'Mod', 21, enumOf('Off', 'Ring', 'Sync', 'Ring+Sync'), 0, 0x21, { bits: [4, 5] }),
    T('osc2Semi', 'Semitone', 22, bipolar(24), 0, 0x22),
    T('osc2Tune', 'Tune', 23, bipolar(63), 0, 0x23),

    T('osc1Level', 'OSC1', 24, plain(), 0, 0x28),
    T('osc2Level', 'OSC2', 25, plain(), 0, 0x29),
    T('noiseLevel', 'Noise', 26, plain(), 0, 0x2a),

    T('filterRouting', 'Routing', 28, enumOf('Single', 'Serial', 'Parallel', 'Individual'), 0, 0x30, { bits: [0, 1] }),
    T('f1Balance', 'Type Bal', 29, { k: 'fbal', min: 0, max: 127 }, 0, 0x31),
    T('f1Cutoff', 'Cutoff', 30, plain(), 0, 0x32),
    T('f1Reso', 'Resonance', 31, plain(), 0, 0x33),
    T('f1EgInt', 'EG1 Int', 32, bipolar(63), 0, 0x34),
    T('f1KeyTrack', 'Key Track', 33, table('KEY_TRACK', '', 64), 0, 0x35),
    T('f1VelSens', 'Vel Sens', 34, bipolar(63), 0, 0x36),
    T('f2Type', 'Type', 28, enumOf('LPF', 'HPF', 'BPF'), 0, 0x40, { bits: [4, 5] }),
    T('f2Cutoff', 'Cutoff', 35, plain(), 0, 0x42),
    T('f2Reso', 'Resonance', 36, plain(), 0, 0x43),
    T('f2EgInt', 'EG1 Int', 37, bipolar(63), 0, 0x44),
    T('f2KeyTrack', 'Key Track', 38, table('KEY_TRACK', '', 64), 0, 0x45),
    T('f2VelSens', 'Vel Sens', 39, bipolar(63), 0, 0x46),

    T('ampLevel', 'Level', 40, plain(), 0, 0x50),
    T('wsPosition', 'WS Position', 41, enumOf('Pre Filter 1', 'Pre Amp'), 0, 0x52, { bits: [4, 5] }),
    T('wsType', 'Wave Shape', 42, enumOf('Off', 'Drive', 'Decimator', 'Hard Clip', 'Oct Saw', 'Multi Tri',
      'Multi Sin', 'SubOSC Saw', 'SubOSC Squ', 'SubOSC Tri', 'SubOSC Sin', 'Level Boost'), 0, 0x51, { bits: [0, 3] }),
    T('wsDepth', 'WS Depth', 43, plain(), 0, 0x54),
    T('pan', 'Pan', 44, PAN, 0, 0x55),
    T('ampKeyTrack', 'Key Track', 45, bipolar(63), 0, 0x56),
    T('punch', 'Punch', 46, plain(), 0, 0x57),
  ];
  ['eg1', 'eg2', 'eg3'].forEach((eg, i) => {
    const r = 48 + i * 6;
    const s = 0x60 + i * 0x10;
    params.push(
      T(`${eg}A`, 'Attack', r, plain(), 0, s),
      T(`${eg}D`, 'Decay', r + 1, plain(), 0, s + 1),
      T(`${eg}S`, 'Sustain', r + 2, plain(), 0, s + 2),
      T(`${eg}R`, 'Release', r + 3, plain(), 0, s + 3),
      T(`${eg}Vel`, 'Vel Sens', r + 4, bipolar(63), 0, s + 4),
    );
  });
  [['lfo1', ['Saw', 'Square', 'Triangle', 'S&H', 'Random']], ['lfo2', ['Saw', 'Square+', 'Sine', 'S&H', 'Random']]]
    .forEach(([lfo, waves], i) => {
      const r = 66 + i * 4;
      const s = 0x90 + i * 0x10;
      params.push(
        T(`${lfo}Wave`, 'Wave', r, enumOf(...waves), 0, s, { bits: [0, 3] }),
        T(`${lfo}Freq`, 'Frequency', r + 1, table('LFO_FREQ', 'Hz'), 0, s + 2),
        T(`${lfo}Bpm`, 'BPM Sync', r + 2, OFF_ON, 0, s + 3, { bits: [7, 7] }),
        T(`${lfo}KeySync`, 'Key Sync', r + 2, enumOf('Off', 'Timbre', 'Voice'), 0, s + 4, { bits: [5, 6] }),
        T(`${lfo}Note`, 'Sync Note', r + 3, table('SYNC_NOTE'), 0, s + 6, { bits: [0, 4] }),
      );
    });
  for (let i = 0; i < 6; i++) {
    const r = 74 + i * 3;
    params.push(
      T(`patch${i + 1}Src`, 'Source', r, enumOf(...MOD_SOURCES), 1, i * 4),
      T(`patch${i + 1}Dst`, 'Dest', r + 1, enumOf(...PATCH_DESTS), 1, i * 4 + 1),
      T(`patch${i + 1}Int`, 'Intensity', r + 2, bipolar(63), 1, i * 4 + 2),
    );
  }
  params.push(
    T('eqLowFreq', 'Low Freq', 92, table('EQ_LOW_FREQ', 'Hz'), 9, 0x00),
    T('eqLowGain', 'Low Gain', 93, bipolar(30, 0.5, 'dB', 1), 9, 0x01),
    T('eqHiFreq', 'High Freq', 94, table('EQ_HI_FREQ', 'Hz'), 9, 0x02),
    T('eqHiGain', 'High Gain', 95, bipolar(30, 0.5, 'dB', 1), 9, 0x03),
  );
  return params;
}

export function oscCtrlLabelsFor(data, t) {
  const b = TIMBRE_BASE[t];
  const wave = data[b + 16] & 0x0f;
  const mod = (data[b + 16] >> 4) & 0x03;
  return oscCtrlLabels(wave, mod) || ['Ctrl 1', 'Ctrl 2'];
}

export function vocoderParams() {
  const b = VOCODER_BASE;
  const V = (key, label, rel, fmt, id, sub, extra) => P(`voc.${key}`, label, b + rel, fmt, id, sub, extra);
  const params = [
    V('on', 'Vocoder', 0, OFF_ON, 0x40, 0x00, { bits: [7, 7] }),
    V('hpfGate', 'HPF Gate', 0, OFF_ON, 0x40, 0x04, { bits: [5, 5] }),
    V('carrier', 'Carrier', 0, enumOf('Audio In', 'Timbre 2'), 0x40, 0x01, { bits: [0, 1] }),
    V('gateSens', 'Gate Sens', 1, plain(), 0x40, 0x06),
    V('threshold', 'Threshold', 2, plain(), 0x40, 0x07),
    V('hpfLevel', 'HPF Level', 3, plain(), 0x40, 0x08),
    V('direct', 'Direct Lvl', 4, plain(), 0x40, 0x09),
    V('t1Level', 'Timbre1 Lvl', 5, plain(), 0x40, 0x0a),
    V('t2Level', 'Timbre2 Lvl', 6, plain(), 0x40, 0x0b),
    V('level', 'Voc Level', 7, plain(), 0x40, 0x0c),
    V('shift', 'Formant Shift', 40, { k: 'range', min: 2, max: 6, bias: 4 }, 0x42, 0x01, { bits: [4, 6] }),
    V('fcModSrc', 'Fc Mod Src', 40, enumOf(...MOD_SOURCES), 0x42, 0x00, { bits: [0, 3] }),
    V('cutoff', 'Fc Offset', 42, bipolar(63), 0x42, 0x10),
    V('reso', 'Resonance', 43, plain(), 0x42, 0x11),
    V('fcModInt', 'Fc Mod Int', 44, bipolar(63), 0x42, 0x12),
    V('efSens', 'E.F. Sens', 45, { k: 'range', min: 0, max: 127 }, 0x42, 0x13),
  ];
  for (let i = 0; i < 16; i++) {
    params.push(
      V(`band${i + 1}Pan`, `${i + 1}`, 8 + i * 2, PAN, 0x41, i * 2),
      V(`band${i + 1}Level`, `${i + 1}`, 9 + i * 2, plain(), 0x41, i * 2 + 1),
    );
  }
  return params;
}

// Effect slot params. The param list depends on the selected effect type, so this is a function of the data.
export function fxParams(data, slot) {
  const b = FX_BASE + slot * 24;
  const subBase = slot * 0x30;
  const type = data[b] & 0x7f;
  const def = FX_TYPES[type] || FX_TYPES[0];
  const F = (key, label, rel, fmt, sub, extra) => P(`fx${slot + 1}.${key}`, label, b + rel, fmt, 0x50, subBase + sub, extra);
  const names = def.params.map(p => p.name);
  const params = [
    F('type', 'Type', 0, enumOf(...FX_TYPES.map(t => t.name)), 0x01, { bits: [0, 6] }),
  ];
  if (names.length) {
    params.push(
      F('ctrl1', 'Ctrl 1 →', 2, enumOf(...names), 0x02, { bits: [0, 4] }),
      F('ctrl2', 'Ctrl 2 →', 3, enumOf(...names), 0x03, { bits: [0, 4] }),
    );
  }
  def.params.forEach((p, i) => {
    const { name, ...fmt } = p;
    params.push(F(`p${i + 1}`, name, 4 + i, fmt, 0x10 + i));
  });
  return params;
}

// Effects with tempo sync carry two versions of their time/rate controls (free and synced).
// Returns true if the param is the one currently in use.
const FREE_TIME = ['T08-06', 'T08-08', 'T08-13'];
const SYNC_TIME = ['T08-07', 'T08-09'];
export function fxParamActive(data, params, p) {
  const sw = re => params.find(q => re.test(q.label));
  const timeSync = sw(/^(Delay Tempo Sync|Duration Temp ?o ?Sync)$/);
  const lfoSync = sw(/^LFO Tempo Sync$/);
  const t = p.fmt.t;
  if (timeSync && (FREE_TIME.includes(t) || SYNC_TIME.includes(t))) {
    return getValue(data, timeSync) ? SYNC_TIME.includes(t) : FREE_TIME.includes(t);
  }
  if (lfoSync && /^LFO (Frequency|Sync Note)$/.test(p.label)) {
    return getValue(data, lfoSync) ? t === 'T08-03' : t === 'T08-02';
  }
  return true;
}

export const fxLabel = label => label.replace(/\s*\(Sync=(On|Off)\)/, '').replace('Temp oSync', 'Tempo Sync');

// Starting values used when an effect type is chosen, so a new effect is audible rather than all zeros.
const TABLE_DEFAULTS = { 'T08-01': 40, 'T08-02': 34, 'T08-03': 8, 'T08-04': 0, 'T08-05': 29, 'T08-06': 64,
  'T08-07': 7, 'T08-08': 64, 'T08-09': 8, 'T08-10': 40, 'T08-11': 40, 'T08-12': 64, 'T08-13': 64 };
export function fxDefault(p) {
  const f = p.fmt;
  if (f.k === 'drywet') return 30;
  if (f.k === 'enum') return 0;
  if (f.k === 'table') return TABLE_DEFAULTS[f.t] ?? 0;
  if (f.bias !== undefined) return f.bias;
  if (/Q$/.test(p.label)) return 5;
  if (/Level|Trim/.test(p.label)) return 100;
  if (f.unit === 'bit') return 12;
  if (f.max === 94) return 94;
  return Math.round((f.min + f.max) / 2);
}

export function arpParams() {
  const b = ARP_BASE;
  return [
    P('arp.tempo', 'Tempo', 334, { k: 'tempo', min: 20, max: 300 }, 0x60, 0x00, { word: true }),
    P('arp.on', 'Arpeggiator', 336, OFF_ON, 0x60, 0x01, { bits: [7, 7] }),
    P('arp.keySync', 'Key Sync', 336, OFF_ON, 0x60, 0x02, { bits: [6, 6] }),
    P('arp.type', 'Type', b, enumOf('Up', 'Down', 'Alt 1', 'Alt 2', 'Random', 'Trigger'), 0x61, 0x00, { bits: [0, 2] }),
    P('arp.resolution', 'Resolution', b, enumOf('1/32', '1/24', '1/16', '1/12', '1/8', '1/6', '1/4', '1/2', '1/1'), 0x61, 0x01, { bits: [4, 7] }),
    P('arp.latch', 'Latch', b + 1, OFF_ON, 0x61, 0x06, { bits: [7, 7] }),
    P('arp.octave', 'Octave Range', b + 1, enumOf('1', '2', '3', '4'), 0x61, 0x02, { bits: [5, 6] }),
    P('arp.lastStep', 'Last Step', b + 1, { k: 'range', min: 0, max: 7, add: 1 }, 0x61, 0x03, { bits: [0, 4] }),
    P('arp.gate', 'Gate Time', b + 2, plain(0, 100, '%'), 0x61, 0x04),
    P('arp.swing', 'Swing', b + 3, bipolar(50, 2, '%'), 0x61, 0x05),
    ...Array.from({ length: 8 }, (_, i) =>
      P(`arp.step${i + 1}`, `${i + 1}`, b + 4, OFF_ON, 0x61, 0x10 + i, { bits: [i, i] })),
  ];
}

export function programName(data) {
  return String.fromCharCode(...data.slice(0, 8)).replace(/[^\x20-\x7e]/g, ' ').trimEnd();
}

export function setProgramName(data, name) {
  const s = name.padEnd(8, ' ').slice(0, 8);
  for (let i = 0; i < 8; i++) data[i] = s.charCodeAt(i) & 0x7f;
}

// Program slots are A/B banks of 8 genres x 8 categories; the spec numbers them 0-127.
export function slotName(n) {
  const bank = n < 64 ? 'A' : 'B';
  const i = n % 64;
  return `${bank}.${Math.floor(i / 8) + 1}${(i % 8) + 1}`;
}

// A neutral starting patch for working offline without a synth: saw -> LPF -> amp, effects off.
export function initProgram() {
  const d = new Uint8Array(PROGRAM_SIZE);
  setProgramName(d, 'Init');
  d[13] = 16; // timbre 2 on global channel
  d[14] = 60; // split point C4
  d[15] = 8 << 4; // octave 0
  for (const t of [0, 1]) {
    const b = TIMBRE_BASE[t];
    d[b + 7] = 2 << 6; // poly
    d[b + 9] = 0; d[b + 10] = 64; d[b + 11] = 64; d[b + 12] = 64; d[b + 13] = 66;
    d[b + 22] = 64; d[b + 23] = 64;
    d[b + 24] = 127;
    d[b + 30] = 127; d[b + 32] = 64; d[b + 33] = 64; d[b + 34] = 64; d[b + 35] = 127; d[b + 37] = 64; d[b + 38] = 64; d[b + 39] = 64;
    d[b + 40] = 100; d[b + 44] = 64; d[b + 45] = 64;
    d.set([0, 64, 127, 0, 64], b + 48);
    d.set([0, 64, 127, 10, 64], b + 54);
    d.set([0, 64, 127, 0, 64], b + 60);
    d[b + 67] = 60; d[b + 71] = 60;
    for (let i = 0; i < 6; i++) d[b + 76 + i * 3] = 64;
    d[b + 92] = 14; d[b + 93] = 64; d[b + 94] = 19; d[b + 95] = 64;
  }
  const v = VOCODER_BASE;
  d[v + 4] = 0; d[v + 5] = 127; d[v + 7] = 127; d[v + 42] = 64; d[v + 44] = 64; d[v + 40] = 4 << 4;
  for (let i = 0; i < 16; i++) { d[v + 8 + i * 2] = 64; d[v + 9 + i * 2] = 127; }
  d[334] = 120; d[335] = 0;
  d[ARP_BASE] = (2 << 4); d[ARP_BASE + 2] = 75; d[ARP_BASE + 3] = 64; d[ARP_BASE + 4] = 0xff; d[ARP_BASE + 1] = 7;
  return d;
}

export { FX_TYPES };

// Whether a program plays chords (poly) or one note at a time (mono), from its voice mode and each
// timbre's voice assign. Layer, Split and Multi use both timbres, so they can mix (e.g. a mono bass
// below the split point and a poly pad above it).
export function voicing(data) {
  const mode = getValue(data, PROGRAM_PARAMS.find(p => p.key === 'voiceMode'));
  const assign = t => (getValue(data, timbreParams(t).find(p => p.key === `t${t + 1}.voiceAssign`)) === 2 ? 'poly' : 'mono');
  const t1 = assign(0), t2 = mode === 0 ? null : assign(1);
  const kind = !t2 || t1 === t2 ? t1 : 'mixed';
  const modeName = ['Single', 'Layer', 'Split', 'Multi'][mode] || 'Single';
  return {
    kind,
    label: { poly: 'Poly', mono: 'Mono', mixed: 'Mono+Poly' }[kind],
    detail: t2 ? `${modeName}: Timbre 1 ${t1}, Timbre 2 ${t2}` : `Timbre 1 ${t1}`,
  };
}
