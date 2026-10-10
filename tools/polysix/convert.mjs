// Converts the Korg Polysix setting charts into microKORG XL programs and writes them as a bank.
//   node tools/polysix/convert.mjs  -> presets/Polysix_Charts.syx, tools/polysix/report.md
//
// The Polysix is one VCO per voice (saw, fixed pulse width, or pulse-width modulation with its own
// speed knob) plus a square sub-oscillator 1 or 2 octaves down -> 24 dB resonant VCF -> VCA, one
// ADSR for both, one modulation generator (MG, with delay) sent to VCO, VCF or VCA, and a
// chorus/phase/ensemble effect. On the XL: the VCO on OSC1 (Pulse with Ctrl1 = width, Ctrl2 =
// LFO1 PWM), the sub on OSC2, the ADSR copied to EG1 and EG2, MG on LFO2.
//
// XL side: hardware measurements (tools/xlunits.mjs). Polysix ranges: partly ASSUMED (marked).
import { readFileSync, writeFileSync } from 'node:fs';
import { root, clamp, attackValue, fadeValue, cutoffValue, cutoffMod, centsToTune, writeBank, BASE } from '../xlunits.mjs';
import { levelProgram } from '../loudness.mjs';

// ---- Polysix ranges (knobs 0..10) ----
// EG: ASSUMED like the Juno (about 1.5 ms to 3 s attack, 1.5 ms to 12 s decay/release).
const P_ATTACK = k => 0.0015 * 2000 ** (k / 10);
const P_FADE = k => Math.max(0.02, 0.0015 * 8000 ** (k / 10));
// VCF cutoff: ASSUMED 50 Hz to 20 kHz, exponential, at C4 with KBD TRACK 10 = full tracking.
const P_CUTOFF = k => 50 * 400 ** (k / 10);
// EG INTENSITY -10..+10: ASSUMED 1 octave per unit.
const P_EG_OCT = k => k;
// MG: ASSUMED 0.1 Hz to 20 Hz; delay up to ~3 s. Level -> VCO: quadratic, as for the Juno
// (1 = 12 c, 2 = 48 c, 4 = 2 semitones); -> VCF: 0.4 octave per unit; -> VCA: tremolo depth.
const P_MG_HZ = k => 0.1 * 200 ** (k / 10);
const P_MG_DELAY = k => 0.3 * k;
const P_MG_CENTS = k => 12 * k * k;
// PWM SPEED: its own LFO, ASSUMED 0.1 Hz to 10 Hz.
const P_PWM_HZ = k => 0.1 * 100 ** (k / 10);
// Effects: one SPEED/INTENSITY knob. ASSUMED: speed for chorus and phase, intensity for ensemble.
const effect = (mode, k) => ({
  off: {},
  chorus: { 'fx1.type': 'Chorus', 'fx1.Dry/Wet': 50, 'fx1.Mod Depth': 45, 'fx1.LFO Frequency': +(0.2 + 0.4 * k).toFixed(2),
    'fx1.LFO Spread': 180, 'fx1.PreDelay L': 4, 'fx1.PreDelay R': 6, 'fx1.Trim': 110, 'fx1.High EQ Gain': 0 },
  ensemble: { 'fx1.type': 'Chorus', 'fx1.Dry/Wet': 50, 'fx1.Mod Depth': Math.round(30 + 7 * k), 'fx1.LFO Frequency': 1.1,
    'fx1.LFO Spread': 120, 'fx1.PreDelay L': 7, 'fx1.PreDelay R': 9, 'fx1.Trim': 110, 'fx1.High EQ Gain': 0 },
  phase: { 'fx1.type': 'Phaser', 'fx1.Dry/Wet': 50, 'fx1.Type': 'Blue', 'fx1.Manual': 64, 'fx1.Mod Depth': 90,
    'fx1.Resonance': 40, 'fx1.LFO Frequency': +(0.1 + 0.6 * k).toFixed(2), 'fx1.LFO Waveform': 'Tri', 'fx1.LFO Spread': 90 },
}[mode]);

export function convert(s) {
  const lost = [];
  const c = { ...BASE, 't1.analogTune': 10, 't1.voiceAssign': 'Poly', 't1.unison': 'Off', 't1.portamento': 0,
    't1.osc2Mod': 'Off', 't1.osc2Tune': 0, 't1.wsType': 'Off', 't1.noiseLevel': 0 };
  const patches = [];
  const patch = (src, dst, int) => {
    int = clamp(Math.round(int), -63, 63);
    if (int === 0) return;
    if (patches.length >= 6) return lost.push(`no virtual patch slot left for ${src} -> ${dst}`);
    patches.push([src, dst, int]);
  };
  const num = v => (typeof v === 'number' ? v : 0);

  // VCO
  c['t1.transpose'] = { "16'": -12, "8'": 0, "4'": 12 }[s.octave] ?? 0;
  if (s.waveform === 'saw') Object.assign(c, { 't1.osc1Wave': 'Saw', 't1.osc1Mod': 'Waveform', 't1.osc1Ctrl1': 0, 't1.osc1Ctrl2': 0 });
  else {
    Object.assign(c, { 't1.osc1Wave': 'Pulse', 't1.osc1Mod': 'Waveform' });
    if (s.waveform === 'pw') Object.assign(c, { 't1.osc1Ctrl1': Math.round(num(s.pw) * 11), 't1.osc1Ctrl2': 0 });
    else { // PWM: its own speed; LFO1 drives OSC1 Ctrl2
      Object.assign(c, { 't1.osc1Ctrl1': 20, 't1.osc1Ctrl2': Math.round(num(s.pw) * 11),
        't1.lfo1Wave': 'Triangle', 't1.lfo1Freq': +P_PWM_HZ(num(s.pwmSpeed)).toFixed(2), 't1.lfo1KeySync': 'Off', 't1.lfo1Bpm': 'Off' });
    }
  }
  c['t1.osc1Level'] = 110;
  if (s.subOsc !== 'off') Object.assign(c, { 't1.osc2Wave': 'Pulse', 't1.osc2Semi': s.subOsc === '2oct' ? -24 : -12, 't1.osc2Level': 90 });
  else c['t1.osc2Level'] = 0;

  // VCF
  const baseHz = P_CUTOFF(num(s.cutoff));
  c['t1.f1Cutoff'] = cutoffValue(baseHz);
  c['t1.f1Reso'] = Math.round(clamp(num(s.resonance), 0, 10) * 11.5);
  c['t1.f1KeyTrack'] = +(num(s.kbdTrack) / 10).toFixed(2);
  c['t1.f1EgInt'] = cutoffMod(baseHz, P_EG_OCT(num(s.egIntensity)));

  // EG -> VCF and VCA; gate mode = organ-style on/off amp.
  const e = n => Object.assign(c, { [`t1.eg${n}A`]: attackValue(P_ATTACK(num(s.attack))), [`t1.eg${n}D`]: fadeValue(P_FADE(num(s.decay))),
    [`t1.eg${n}S`]: Math.round(num(s.sustain) * 12.7), [`t1.eg${n}R`]: fadeValue(P_FADE(num(s.release))) });
  e(1);
  if (s.vcaMode === 'gate') Object.assign(c, { 't1.eg2A': 0, 't1.eg2D': 64, 't1.eg2S': 127, 't1.eg2R': 4 });
  else e(2);
  // ATTENUATOR is a signed level trim on the charts (-4 ... +10): higher = louder.
  c['t1.ampLevel'] = Math.round(clamp(100 + num(s.attenuator) * 2.5, 60, 127));

  // MG on LFO2, faded in by EG3 when it has a delay.
  const level = num(s.mgLevel);
  if (level > 0) {
    Object.assign(c, { 't1.lfo2Wave': 'Sine', 't1.lfo2Freq': +P_MG_HZ(num(s.mgFrequency)).toFixed(2), 't1.lfo2KeySync': 'Off', 't1.lfo2Bpm': 'Off' });
    const [dst, int] = s.mgMod === 'vco' ? ['Pitch', centsToTune(P_MG_CENTS(level))]
      : s.mgMod === 'vcf' ? ['Filt1 Cutoff', cutoffMod(baseHz, 0.4 * level)] : ['Amp Level', Math.round(level * 5)];
    if (num(s.mgDelay) > 0.25 && patches.length <= 4) {
      patches.push(['LFO2', dst, 0]);
      patch('EG3', `Patch${patches.length} Int`, int);
      Object.assign(c, { 't1.eg3A': attackValue(P_MG_DELAY(num(s.mgDelay))), 't1.eg3D': 64, 't1.eg3S': 127, 't1.eg3R': 127, 't1.eg3Vel': 0 });
    } else patch('LFO2', dst, int);
  }

  // Key assign modes aren't on the charts; the names say when a sound is meant for unison.
  if (/unison/i.test(s.name)) Object.assign(c, { 't1.voiceAssign': 'Mono 1', 't1.unison': '4 Voice', 't1.unisonDetune': 8, 't1.unisonSpread': 64 });
  if (/chord memory/i.test(s.name)) lost.push('chord memory (the XL has none): play the chord yourself');

  Object.assign(c, effect(s.effect, num(s.effectSpeed)));
  patches.forEach(([src, dst, int], i) => Object.assign(c, {
    [`t1.patch${i + 1}Src`]: src, [`t1.patch${i + 1}Dst`]: dst, [`t1.patch${i + 1}Int`]: int }));
  for (let i = patches.length + 1; i <= 6; i++) c[`t1.patch${i}Int`] = 0;
  levelProgram(c, lost); // as loud as the XL's factory sounds
  return { changes: c, lost };
}

const short = name => name.toUpperCase().replace(/ELECTRIC/, 'E.').replace(/PIANO/, 'PNO').replace(/STRINGS?/, 'STR')
  .replace(/ORGAN/, 'ORG').replace(/SOUND EFFECT/, 'SFX').replace(/SOUND/, 'SND').replace(/SYNTHE?(SIZER)?/, 'SYN')
  .replace(/ENSEMBLE/, 'ENS').replace(/[^A-Z0-9 .&/+'-]/g, '');
// Hand-picked names where shortening the chart name reads badly.
const RENAME = { 'Unison Solo Low': 'UNI LOW', 'Unison Solo High': 'UNI HIGH', 'Acoustic Piano': 'AC PIANO',
  'Chime with Chord Memory': 'CHIME', "Kim Carne's Sound": 'KIMCARNE', 'Filtered Clavi': 'FILTCLAV',
  'New Wave Organ': 'NEWWAVOR', 'Jazz Guitar': 'JAZZ GTR', 'Slow Attack Wah-Wah': 'SLOW WAH', 'Strings Orchestra': 'STR ORCH',
  'Solo Violin': 'VIOLIN', 'Bowing Strings': 'BOW STR', 'Chorus (Female)': 'CHOIR F', 'Chorus (Male)': 'CHOIR M',
  'Steam Pipe Organ': 'STM PIPE', 'Fat Solo Sound': 'FAT SOLO', 'Honky Tonk Piano': 'HONKYTNK', 'Brass Ensemble': 'BRASSENS',
  'Mellow Brass': 'MELLOWBR', 'Reggae Sound': 'REGGAE', 'Oriental Sound': 'ORIENTAL', '"Touch" Sound': 'TOUCH',
  'Sound Fall': 'SND FALL', 'Thin Sound': 'THIN SND', 'Lead Sound': 'LEAD SND', 'Moon Sound': 'MOON SND' };
function xlName(name, used) {
  let n = RENAME[name] || short(name);
  if (n.length > 8) n = n.replace(/ /g, '');
  n = n.slice(0, 8);
  let k = 2;
  const base = n;
  while (used.has(n)) n = (base.slice(0, 7) + k++).slice(0, 8);
  used.add(n);
  return n;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const data = JSON.parse(readFileSync(new URL('tools/polysix/charts.json', root), 'utf8'));
  const used = new Set(), programs = [], report = ['# Korg Polysix setting charts on the microKORG XL', '',
    'Generated by tools/polysix/convert.mjs from tools/polysix/charts.json. Do not edit by hand.', ''];
  for (const s of data.charts) {
    const name = xlName(s.name, used);
    const { changes, lost } = convert(s);
    programs.push({ name, changes });
    report.push(`## Series ${s.series} ${s.code} ${s.name} → ${name}`, '',
      lost.length ? 'Not carried over:\n' + lost.map(l => `- ${l}`).join('\n') : 'Everything carried over.', '',
      '```json', JSON.stringify(changes), '```', '');
  }
  writeBank('Polysix_Charts.syx', programs);
  writeFileSync(new URL('tools/polysix/report.md', root), report.join('\n'));
  console.log(`${programs.length} programs -> presets/Polysix_Charts.syx, tools/polysix/report.md`);
}
