// Sound-type grouping for the Presets tab. Uses the program name first (patch names like
// "MG BASS" or "PWM STR" are usually explicit), then the settings: arpeggiator on, vocoder on,
// envelope shape and mono/poly voicing. sound-types.js holds reviewed corrections for the
// bundled presets where these rules guess wrong.

import { OVERRIDES } from './sound-types.js';

export const TYPES = ['Bass', 'Lead', 'Pad', 'Strings', 'Brass', 'Keys', 'Organ', 'Bells & Mallets',
  'Pluck & Stab', 'Arp & Sequence', 'Synth', 'Drums & Hits', 'FX & Noise', 'Vocoder'];

// Names that clearly say what the sound is win over everything else.
const STRONG_RULES = [
  ['Vocoder', /VOC|VOX|VOICE|TALK|ROBOT|MALE|FEMALE|KID-/],
  ['Drums & Hits', /DRUM|PERC|KICK|SNARE|\bTOM\b|\bBD\b|HIT\b|HITS|CHORDHIT|NOISYHIT/],
  ['Bass', /BASS|\bBS\b|BS$|\bBAS\b|\bBA\b|303|\bSUB\b|BANANABS/],
  ['Lead', /LEAD|\bLD\b|LD$|\bLEA\b|\bLE\b|SCREAM|WHEELER|SOLO/],
  ['Organ', /ORG|ORGAN|\bB3\b|HAMMOND/],
  ['Keys', /\bEP\b|PIANO|\bPNO\b|PIAN|\bPIA\b|\bPI\b|WURLY|RHODES|CLAV|CLV|REED P/],
  ['Strings', /\bSTR\b|STRI|STRING|ARCO|SOLIN/],
  ['Brass', /BRASS|\bBRS\b|\bBR\b|SYNTH TP|SOFT BRA/],
  ['Bells & Mallets', /\bBELL|\bBEL\b|GLASS|CHIME|MARIMB|TUBULAR|MALLET|\bVIB\b/],
];
// Weaker hints, used only if the arpeggiator isn't on.
const WEAK_RULES = [
  ['Arp & Sequence', /\bARP|SEQ|STAIRS/],
  ['Pad', /PAD|\bPD\b|\bP\b|WARM4TH|SILK|ICE FIEL|SNOW|SURROUND|ASTRAL|EVOLU|CENTURY|MOTION P|SWEEP P/],
  ['Pluck & Stab', /PLUCK|PLUK|PLK|STAB|SQ DECAY|SQ COMP/],
  ['FX & Noise', /\bFX\b|FX$|NOISE|NOIZ|ZAP|SIREN|THUNDER|INVADERS|REVERSE|TELEPHON|BOMB|SCIENCE|SPECT|RADIAT|LASER|DOOM|STUTTER|RANDOM/],
];

// `s` is the readable settings object from aiparams.programToAi(data).settings. `key` identifies
// the preset ("<bank>/<name>", or "My Sounds/<file>"); `userTypes` are the types the user set
// in the Presets tab (data/sound-types.json), which win over everything.
export function soundType(name, s, key, userTypes = {}) {
  if (key && userTypes[key]) return userTypes[key];
  if (key && OVERRIDES[key]) return OVERRIDES[key];
  const n = String(name || '').toUpperCase().trim();
  if (s['voc.on'] === 'On') return 'Vocoder';
  for (const [type, re] of STRONG_RULES) if (re.test(n)) return type;
  if (s['arp.on'] === 'On') return 'Arp & Sequence';
  for (const [type, re] of WEAK_RULES) if (re.test(n)) return type;
  const attack = s['t1.eg2A'] ?? 0;
  const decay = s['t1.eg2D'] ?? 64;
  const sustain = s['t1.eg2S'] ?? 127;
  const release = s['t1.eg2R'] ?? 0;
  const mono = /Mono/.test(s['t1.voiceAssign'] || '');
  const low = (s.octave ?? 0) <= -1 || (s['t1.transpose'] ?? 0) <= -12;
  if (s['t1.osc1Wave'] === 'Audio In') return 'FX & Noise';
  if (s['t1.osc1Wave'] === 'Noise' && (s['t1.osc1Level'] ?? 0) > 60) return 'FX & Noise';
  if (attack >= 45 || (release >= 70 && sustain >= 80)) return 'Pad';
  if (mono && low) return 'Bass';
  if (mono) return 'Lead';
  if (sustain <= 25 && decay <= 80) return 'Pluck & Stab';
  return 'Synth';
}
