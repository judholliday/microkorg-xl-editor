// Converts Roland Juno-60 and Juno-106 patches into microKORG XL programs and writes them as
// preset banks.
//   node tools/juno/convert.mjs  -> presets/Juno60_Factory.syx, presets/Juno106_Factory.syx,
//                                   tools/juno/report-60.md, tools/juno/report-106.md
//
// Both Junos are one DCO per voice (saw and pulse at once, pulse-width modulation, a square
// sub-oscillator an octave down, noise) -> non-resonant HPF -> 24 dB resonant LPF -> VCA, with one
// ADSR for both filter and amp, one LFO and a stereo BBD chorus. On the XL: pulse on OSC1 (the
// only oscillator with pulse width), saw on OSC2 (or OSC1 when there's no pulse), the sub on
// OSC2 an octave down when it's free (otherwise the Wave Shape sub-oscillator), HPF as Filter 2
// in series, the ADSR copied to EG1 and EG2, chorus as Effect 1.
//
// The XL side uses the hardware measurements (tools/xlunits.mjs). The Juno side's ranges are
// partly ASSUMED (marked below).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { root, clamp, attackValue, fadeValue, cutoffValue, cutoffMod, centsToTune, writeBank, BASE, ringTranspose } from '../xlunits.mjs';
import { levelProgram } from '../loudness.mjs';

// ---- Juno ranges (sliders 0..10) ----
// Envelope: Roland's Juno-106 specs give attack 1.5 ms-3 s, decay and release 1.5 ms-12 s.
// ASSUMED: those are time to full level and to near silence, exponential in the slider.
const J_ATTACK = k => 0.0015 * 2000 ** (k / 10);
const J_FADE = k => Math.max(0.02, 0.0015 * 8000 ** (k / 10));
// VCF cutoff: ASSUMED about 20 Hz to 20 kHz, exponential, at C4 with key follow 10 = full tracking.
const J_CUTOFF = k => 20 * 1000 ** (k / 10);
// VCF envelope depth at 10: ASSUMED 8 octaves (as for the Prophet). LFO -> VCF at 10: 3 octaves.
const J_ENV_OCT = k => 0.8 * k;
const J_LFO_VCF_OCT = k => 0.3 * k;
// LFO rate: ASSUMED 0.3 Hz to 20 Hz, exponential. Delay: up to about 3 s.
const J_LFO_HZ = k => 0.3 * (20 / 0.3) ** (k / 10);
const J_LFO_DELAY = k => 0.3 * k;
// LFO -> DCO depth: ASSUMED quadratic, so small settings are gentle vibrato: 1.5 = 27 c, 3 = 1 semitone,
// 10 = an octave.
const J_DCO_LFO_CENTS = k => 12 * k * k;
// HPF positions: 0 = slight bass boost (Juno-60) or flat, 1 = flat, 2 and 3 = high-pass at about
// 225 Hz and 700 Hz (ASSUMED from service-manual descriptions).
const J_HPF_HZ = [0, 0, 225, 700];
// Chorus: Juno-60 chorus I is a 0.5 Hz triangle LFO, II about 0.83 Hz; dry plus a stereo-inverted
// wet signal from short (~2-5 ms) BBD delays.
const CHORUS = {
  1: { 'fx1.type': 'Chorus', 'fx1.Dry/Wet': 50, 'fx1.Mod Depth': 50, 'fx1.LFO Frequency': 0.5, 'fx1.LFO Spread': 180,
    'fx1.PreDelay L': 3.5, 'fx1.PreDelay R': 3.5, 'fx1.Trim': 110, 'fx1.High EQ Gain': -2 },
  2: { 'fx1.type': 'Chorus', 'fx1.Dry/Wet': 50, 'fx1.Mod Depth': 50, 'fx1.LFO Frequency': 0.83, 'fx1.LFO Spread': 180,
    'fx1.PreDelay L': 3.5, 'fx1.PreDelay R': 3.5, 'fx1.Trim': 110, 'fx1.High EQ Gain': -2 },
};

// p: a Juno patch in Juno-60 terms, sliders 0..10 (see juno60-factory.json); Juno-106 patches are
// first decoded into the same shape.
export function convert(p) {
  const lost = [];
  const c = { ...BASE, 't1.analogTune': 6, 't1.voiceAssign': 'Poly', 't1.unison': 'Off', 't1.portamento': 0 };
  const patches = [];
  const patch = (src, dst, int) => {
    int = clamp(Math.round(int), -63, 63);
    if (int === 0) return;
    if (patches.length >= 6) return lost.push(`no virtual patch slot left for ${src} -> ${dst}`);
    patches.push([src, dst, int]);
  };
  const { dco, vcf, env, lfo } = p;
  const manualLfo = lfo.trig === 'M'; // Juno-60: LFO only while the bender's LFO button is pressed
  // No pulse, saw or sub and the resonance up full: the ringing filter is the sound (noise may feed it).
  const selfOsc = vcf.res >= 9.5 && !dco.pulse && !dco.saw && !dco.sub;

  // LFO: the Juno's single LFO is LFO2 (the XL's Vibrato also uses LFO2); PWM by LFO needs LFO1,
  // which OSC1 Ctrl2 is wired to, so it gets the same settings.
  const lfoSet = n => Object.assign(c, { [`t1.${n}Wave`]: n === 'lfo1' ? 'Triangle' : 'Sine',
    [`t1.${n}Freq`]: +J_LFO_HZ(lfo.rate).toFixed(2), [`t1.${n}KeySync`]: 'Off', [`t1.${n}Bpm`]: 'Off' });
  lfoSet('lfo2');

  // Oscillators
  const levelOn = 100;
  if (dco.pulse) {
    Object.assign(c, { 't1.osc1Wave': 'Pulse', 't1.osc1Mod': 'Waveform', 't1.osc1Level': levelOn });
    // PWM slider: in M (manual) mode it sets a fixed width (0 = square); in L/E it's the depth.
    if (dco.pwmMode === 'M') c['t1.osc1Ctrl1'] = Math.round(dco.pwm * 10);
    else c['t1.osc1Ctrl1'] = 0;
    if (dco.pwmMode === 'L' && dco.pwm > 0) {
      lfoSet('lfo1');
      c['t1.osc1Ctrl2'] = Math.round(dco.pwm * 11);
      if (manualLfo) lost.push('PWM by LFO runs all the time (on the Juno it waits for the LFO button)');
    }
    if (dco.pwmMode === 'E' && dco.pwm > 0) patch('EG1', 'OSC1 Ctrl1', dco.pwm * 5.5);
  }
  const sawOn = dco.saw ? (dco.pulse ? 'osc2' : 'osc1') : null;
  if (sawOn === 'osc1') Object.assign(c, { 't1.osc1Wave': 'Saw', 't1.osc1Mod': 'Waveform', 't1.osc1Level': levelOn });
  if (sawOn === 'osc2') Object.assign(c, { 't1.osc2Wave': 'Saw', 't1.osc2Semi': 0, 't1.osc2Level': levelOn });
  if (!dco.pulse && !dco.saw) Object.assign(c, { 't1.osc1Wave': 'Saw', 't1.osc1Level': 0 });
  const osc2Free = sawOn !== 'osc2';
  if (dco.sub > 0 && osc2Free) {
    Object.assign(c, { 't1.osc2Wave': 'Pulse', 't1.osc2Semi': -12, 't1.osc2Level': Math.round(dco.sub * 10) });
  } else if (dco.sub > 0) {
    // Saw and pulse use both oscillators: the Wave Shape sub-oscillator adds the square an octave down.
    Object.assign(c, { 't1.wsType': 'SubOSC Squ', 't1.wsPosition': 'Pre Filter 1', 't1.wsDepth': Math.round(dco.sub * 9) });
  } else if (osc2Free) c['t1.osc2Level'] = 0;
  if (!c['t1.wsType']) c['t1.wsType'] = 'Off';
  c['t1.noiseLevel'] = Math.round(dco.noise * 10);
  c['t1.osc2Mod'] = 'Off';
  c['t1.osc2Tune'] = 0;
  c['t1.transpose'] = p.transpose;

  // DCO LFO: vibrato depth. Auto trigger: always on (with the delay as a fade-in, via EG3 opening
  // the patch). Manual trigger: the XL's mod wheel stands in for the LFO button.
  if (dco.lfo > 0) {
    const cents = J_DCO_LFO_CENTS(dco.lfo);
    if (manualLfo) c['t1.vibrato'] = Math.round(clamp(cents, 0, 2400));
    else if (lfo.delay > 0.25 && patches.length <= 4) {
      patches.push(['LFO2', 'Pitch', 0]);
      patch('EG3', `Patch${patches.length} Int`, centsToTune(cents));
      Object.assign(c, { 't1.eg3A': attackValue(J_LFO_DELAY(lfo.delay)), 't1.eg3D': 64, 't1.eg3S': 127, 't1.eg3R': 127, 't1.eg3Vel': 0 });
    } else patch('LFO2', 'Pitch', centsToTune(cents));
  }

  // HPF: Filter 2 high-pass in series. Position 0 on the Juno-60 is a low bass boost.
  if (p.hpf >= 2) {
    Object.assign(c, { 't1.filterRouting': 'Serial', 't1.f2Type': 'HPF', 't1.f2Cutoff': cutoffValue(J_HPF_HZ[p.hpf]),
      't1.f2Reso': 0, 't1.f2EgInt': 0, 't1.f2KeyTrack': 0, 't1.f2VelSens': 0 });
  } else if (p.hpf === 0 && p.model === 60) Object.assign(c, { 't1.eqLowFreq': 100, 't1.eqLowGain': 4 });

  // VCF
  const baseHz = J_CUTOFF(vcf.freq);
  c['t1.f1Cutoff'] = cutoffValue(baseHz);
  c['t1.f1Reso'] = Math.round(clamp(vcf.res, 0, 10) * 11.5);
  c['t1.f1KeyTrack'] = +(vcf.kybd / 10).toFixed(2);
  c['t1.f1EgInt'] = cutoffMod(baseHz, (vcf.envPolarity === 'I' ? -1 : 1) * J_ENV_OCT(vcf.env));
  if (vcf.lfo > 0) {
    const int = cutoffMod(baseHz, J_LFO_VCF_OCT(vcf.lfo));
    if (manualLfo && patches.length <= 4) {
      patches.push(['LFO2', 'Filt1 Cutoff', 0]);
      patch('Mod Wheel', `Patch${patches.length} Int`, int);
    } else patch('LFO2', 'Filt1 Cutoff', int);
  }

  // Envelope: one ADSR for VCF and VCA; VCA in gate mode is an organ-style on/off.
  const e = n => Object.assign(c, {
    [`t1.eg${n}A`]: attackValue(J_ATTACK(env.attack)), [`t1.eg${n}D`]: fadeValue(J_FADE(env.decay)),
    [`t1.eg${n}S`]: Math.round(env.sustain * 12.7), [`t1.eg${n}R`]: fadeValue(J_FADE(env.release)) });
  e(1);
  if (p.vca.mode === 'G') Object.assign(c, { 't1.eg2A': 0, 't1.eg2D': 64, 't1.eg2S': 127, 't1.eg2R': 4 });
  else e(2);
  // VCA level -5..+5 (Juno-60) around the XL's usual 110.
  c['t1.ampLevel'] = Math.round(clamp(105 + p.vca.level * 4, 60, 127));

  // Self-oscillating filter as the sound (Juno-60 bank 7): the XL's filter doesn't ring on its
  // own, so a sine plays the cutoff pitch and EG1 sweeps it like the filter envelope would.
  if (selfOsc) {
    Object.assign(c, { 't1.osc1Wave': 'Sine', 't1.osc1Mod': 'Waveform', 't1.osc1Level': 100,
      't1.transpose': ringTranspose(baseHz * 2 ** (p.transpose / 12), lost) });
    if (dco.noise > 0) lost.push('noise through the ringing filter keeps the noise, with a sine for the ringing tone');
    else Object.assign(c, { 't1.f1Cutoff': 127, 't1.f1Reso': 0, 't1.f1EgInt': 0 });
    const cents = (vcf.envPolarity === 'I' ? -1 : 1) * J_ENV_OCT(vcf.env) * 1200;
    if (Math.abs(cents) > 1) patch('EG1', 'Pitch', centsToTune(clamp(cents, -2400, 2400)));
    if (Math.abs(cents) > 2400) lost.push(`filter sweep of ${(Math.abs(cents) / 1200).toFixed(1)} octaves cut to the XL's 2 octaves`);
    if (vcf.kybd < 9) lost.push('the ringing pitch follows the keys fully on the XL');
    lost.push('self-oscillating filter replaced by a sine at the pitch it would ring at');
  }

  // Chorus
  if (p.chorus) Object.assign(c, CHORUS[p.chorus]);
  patches.forEach(([src, dst, int], i) => Object.assign(c, {
    [`t1.patch${i + 1}Src`]: src, [`t1.patch${i + 1}Dst`]: dst, [`t1.patch${i + 1}Int`]: int }));
  for (let i = patches.length + 1; i <= 6; i++) c[`t1.patch${i}Int`] = 0;
  levelProgram(c, lost); // as loud as the XL's factory sounds
  return { changes: c, lost };
}

// ---- Juno-106: decode the 18-byte patch (16 sliders 0..127, then switch bytes SW1, SW2; Roland's
// MIDI implementation, owner's manual p. 35) into the Juno-60 shape above.
export function decode106(bytes) {
  const s = i => bytes[i] / 12.7;
  const sw1 = bytes[16], sw2 = bytes[17];
  const range = sw1 & 0x01 ? -12 : sw1 & 0x04 ? 12 : 0; // 16' / 8' / 4'
  return {
    model: 106,
    transpose: range,
    lfo: { rate: s(0), delay: s(1), trig: 'A' },
    dco: { lfo: s(2), pwm: s(3), pwmMode: sw2 & 0x01 ? 'M' : 'L', pulse: !!(sw1 & 0x08), saw: !!(sw1 & 0x10),
      sub: s(15), noise: s(4) },
    hpf: 3 - ((sw2 >> 3) & 0x03),
    vcf: { freq: s(5), res: s(6), env: s(7), envPolarity: sw2 & 0x02 ? 'I' : 'N', lfo: s(8), kybd: s(9) },
    vca: { mode: sw2 & 0x04 ? 'G' : 'E', level: (s(10) - 5) }, // 106 VCA level 0..127; centre = 0
    env: { attack: s(11), decay: s(12), sustain: s(13), release: s(14) },
    chorus: sw1 & 0x20 ? 0 : sw1 & 0x40 ? 1 : 2,
  };
}

// 8-character XL names, in the synth's style.
const short = name => name.toUpperCase().replace(/STRINGS/, 'STRNG').replace(/SYNTHESIZER/, 'SYN')
  .replace(/HARPSICHORD/, 'HRPSCD').replace(/SOUND/, 'SND').replace(/EFFECT/, 'FX').replace(/PERCUSSIVE/, 'PERC')
  .replace(/PIZZICATO/, 'PIZZ').replace(/COMBINATION/, 'COMB').replace(/MYSTERIOUS INVENTION/, 'MYSTERY')
  .replace(/ENGLISH HORN/, 'ENG HORN').replace(/GLOCKENSPIEL/, 'GLOCKEN').replace(/CLAVICHORD/, 'CLAVI')
  .replace(/MELLOW PIANO/, 'MELLOWPN').replace(/XYLOPHONE/, 'XYLOFON').replace(/[^A-Z0-9 .&/+-]/g, '');
export function xlName(name, used) {
  let n = short(name);
  if (n.length > 8) n = n.replace(/ /g, '');
  n = n.slice(0, 8);
  // keep names unique within a bank (e.g. two "STRNG" sounds): end with a digit
  let k = 2, base = n;
  while (used.has(n)) n = (base.slice(0, 7) + k++).slice(0, 8);
  used.add(n);
  return n;
}

function build(model, patches, file, reportFile) {
  const used = new Set(), programs = [], report = [`# Roland Juno-${model} factory patches on the microKORG XL`, '',
    'Generated by tools/juno/convert.mjs. Do not edit by hand.', ''];
  for (const p of patches) {
    const name = xlName(p.name, used);
    const { changes, lost } = convert(p);
    programs.push({ name, changes });
    report.push(`## ${p.program} ${p.name} → ${name}`, '',
      lost.length ? 'Not carried over:\n' + lost.map(l => `- ${l}`).join('\n') : 'Everything carried over.', '',
      '```json', JSON.stringify(changes), '```', '');
  }
  writeBank(file, programs);
  writeFileSync(new URL(`tools/juno/${reportFile}`, root), report.join('\n'));
  console.log(`${programs.length} programs -> presets/${file}, tools/juno/${reportFile}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const j60 = JSON.parse(readFileSync(new URL('tools/juno/juno60-factory.json', root), 'utf8'));
  build(60, j60.patches.map(p => ({ ...p, model: 60 })), 'Juno60_Factory.syx', 'report-60.md');
  // The Juno-106 data isn't in the public repo (it comes from a GPL project).
  const f106 = new URL('tools/juno/juno106-factory.json', root);
  if (!existsSync(f106)) { console.log('No tools/juno/juno106-factory.json: skipping the Juno-106.'); process.exit(0); }
  const j106 = JSON.parse(readFileSync(f106, 'utf8'));
  build(106, j106.patches.map(p => ({ ...decode106(p.bytes), program: p.program, name: p.name })), 'Juno106_Factory.syx', 'report-106.md');
}
