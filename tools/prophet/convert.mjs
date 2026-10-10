// Converts Prophet-5 patches (knob positions 0..10 and switches, as on the 1978 factory patch
// sheets) into microKORG XL programs, and writes them as a preset bank.
//   node tools/prophet/convert.mjs            -> presets/Prophet5_1978.syx + tools/prophet/report.md
//
// The XL side uses values measured on the hardware (docs/xl-measurements.json). The Prophet side
// uses published ranges where they exist; the rest are assumptions, marked ASSUMED below, to be
// checked by ear and by recording.
import { readFileSync, writeFileSync } from 'node:fs';
import { root, clamp, inverse, XL_ATTACK, XL_FADE, XL_CUTOFF, cutoffMod, centsToTune, writeBank, BASE, ringTranspose } from '../xlunits.mjs';
import { levelProgram } from '../loudness.mjs';

// ---- Prophet-5 ranges ----
// Envelope times grow exponentially with the knob. Attack: about 1 ms to 25 s (Gordon Reid
// measured ~25 s at 10). Decay/release to near silence: ASSUMED 3 ms to 45 s (Reid: D ~50 s,
// R ~40 s at 10).
const P5_ATTACK = k => 0.001 * 25000 ** (k / 10);
// Floored at 20 ms: shorter would be a click, and the sheets use 0 for short plucks (1-3 Muted Clav).
const P5_FADE = k => Math.max(0.02, 0.003 * 15000 ** (k / 10));
// Cutoff knob alone: about 10 Hz to 8.5 kHz (SOS measurement of Prophet V, said to match).
// ASSUMED: that's at the lowest key (C2, 0 V of the keyboard CV). With keyboard tracking on, the
// cutoff at middle C is 2 octaves higher, and the XL's Key Track +1.00 (full tracking, measured
// to be centred on C4) carries it from there.
const P5_CUTOFF = k => 10 * 850 ** (k / 10);
const P5_KEY_OCT_AT_C4 = 2;
// Filter envelope amount at 10: ASSUMED 8 octaves of sweep.
const P5_ENV_OCT = k => 0.8 * k;
// Oscillator frequency knobs: the dial's printed scale isn't even. From the 1978 sheets' notes:
// 2.5 = up 1 octave, 4.5 = up 2, 6 = up 3, 8 = up 4 (10 = up 5 with Osc B's keyboard off).
// ASSUMED: "up 2 octaves" is the keys' written pitch (low C of the 61-key Prophet = C2), so
// results are relative to that.
const DIAL = [[0, 0], [2.5, 12], [4.5, 24], [6, 36], [8, 48], [10, 60]];
const P5_SEMIS = k => {
  for (let i = 1; i < DIAL.length; i++) {
    const [k0, s0] = DIAL[i - 1], [k1, s1] = DIAL[i];
    if (k <= k1) return Math.round(s0 + (s1 - s0) * (k - k0) / (k1 - k0)) - 24;
  }
  return 36;
};
const P5_FINE_CENTS = k => 9.5 * k; // Osc B fine: 0 to nearly +1 semitone
// LFO and lo-freq Osc B rate, exponential: the 1-1 Brass sheet says its 6.5 is about 5 Hz, and
// Repro-5 (a Rev 3 model) tops out near 27 Hz. So 0 = about 0.2 Hz.
const P5_LFO_HZ = k => 5 * (27 / 5) ** ((k - 6.5) / 3.5);
// Poly-Mod depths: ASSUMED. Filter env -> Freq A at 10 = 30 semitones (the "Let's Go" sync
// sweep uses 7 = 21 semitones; Syntorial's recipe sweeps 19). Osc B -> Freq A uses XL cross-mod.
const P5_PM_ENV_SEMIS = k => 3 * k;
const P5_PM_B_SEMIS = k => 1.2 * k; // lo-freq Osc B -> pitch, per side
// Wheel-mod at full wheel: ASSUMED +/-100 cents of vibrato (XL Vibrato 100 = +/-98 c, measured), 1.5 octaves of filter, full PWM.
const WHEEL_VIBRATO_CENTS = 100;
const WHEEL_FILTER_OCT = 1.5;

const lvl = k => Math.round(clamp(k, 0, 10) * 12.7);

export function convert(s) {
  const lost = [];
  const c = { ...BASE, 't1.analogTune': 24 }; // ~+/-5 cents per note, like a Rev 1/2 Prophet's voices
  const { polyMod: pm, oscA: A, oscB: B, wheelMod: wm, mixer: mx } = s;
  const pmOn = pm.freqA || pm.pwA || pm.filter;
  const pmEnv = pmOn ? pm.filtEnv : 0, pmB = pmOn ? pm.oscB : 0;
  const bAudio = !B.loFreq;
  // Audio-rate Osc B -> Freq A (XL cross-mod, which needs A on OSC1). With sync on, sync wins:
  // it needs A on OSC2, and on a synced oscillator FM mostly changes timbre the sync already sets.
  const fmB = pmB > 0.25 && pm.freqA && bAudio && !A.sync;
  if (pmB > 0.25 && pm.freqA && bAudio && A.sync) lost.push('Osc B -> Osc A FM (sync takes priority on the XL)');

  // Which XL oscillator plays Prophet Osc A? OSC2 is the XL's sync slave and the target of
  // "OSC2 Tune" patches; OSC1 is the one cross-mod modulates and the only one with pulse width.
  const aOnOsc2 = !fmB && (A.sync || (pm.freqA && pmEnv > 0.25) || (pm.freqA && !bAudio && pmB > 0.25));
  // Otherwise A goes on OSC1, unless only B needs OSC1's pulse-width control.
  const needsPW = (o, wheel) => o.pulse && (wheel || Math.abs(o.pw - 5) > 1);
  const swap = !aOnOsc2 && !fmB && !B.loFreq && needsPW(B, wm.pwB) && !needsPW(A, wm.pwA || (pm.pwA && pmEnv > 0.25));
  const X = aOnOsc2 || swap ? { A: 'osc2', B: 'osc1' } : { A: 'osc1', B: 'osc2' };
  const patches = [];
  const patch = (src, dst, int) => {
    int = clamp(Math.round(int), -63, 63);
    if (int === 0) return;
    if (patches.length >= 6) return lost.push(`no virtual patch slot left for ${src} -> ${dst}`);
    patches.push([src, dst, int]);
  };

  // Waveforms: the XL has one wave per oscillator.
  const wave = (o, name) => {
    const w = [o.saw && 'Saw', o.tri && 'Triangle', o.pulse && 'Pulse'].filter(Boolean);
    if (w.length > 1) lost.push(`${name} mixes ${w.join(' + ')}; the XL plays one wave per oscillator, so it uses ${w[0]}`);
    return w[0] || null;
  };
  const wA = wave(A, 'Osc A'), wB = bAudio ? wave(B, 'Osc B') : null;
  const levelA = wA ? mx.oscA : 0, levelB = wB ? mx.oscB : 0, levelN = mx.noise;
  // Mixer: scale so the loudest source is 120, keeping the balance; a hot Prophet mixer
  // (the knobs adding up past ~10) becomes some drive before the filter.
  const loud = Math.max(levelA, levelB, levelN, 0.1);
  const scale = 120 / (loud * 12.7);
  const sum = levelA + levelB + levelN;
  const setOsc = (xl, w, level, o) => {
    const xlWave = w || 'Sine';
    c[`t1.${xl}Wave`] = xl === 'osc2' && !['Saw', 'Pulse', 'Triangle', 'Sine'].includes(xlWave) ? 'Saw' : xlWave;
    c[`t1.${xl}Level`] = Math.round(lvl(level) * scale);
    if (xl === 'osc1') c['t1.osc1Mod'] = fmB ? 'Cross' : 'Waveform';
    if (w === 'Pulse') {
      const width = Math.abs(o.pw - 5) / 5; // 0 = square, 1 = vanishingly thin
      if (xl === 'osc1') c['t1.osc1Ctrl1'] = Math.round(width * 115);
      else if (width > 0.2) lost.push(`Osc A pulse width ${o.pw} (XL OSC2's pulse is always square)`);
    }
  };
  setOsc(X.A, wA, levelA, A);
  setOsc(X.B, wB, levelB, B);
  c['t1.noiseLevel'] = Math.round(lvl(levelN) * scale);
  if (sum > 11) {
    c['t1.wsType'] = 'Drive'; c['t1.wsPosition'] = 'Pre Filter 1'; c['t1.wsDepth'] = Math.round(clamp((sum - 11) * 5, 4, 40));
  } else c['t1.wsType'] = 'Off';
  if (!wB && B && bAudio && (A.sync || fmB)) { /* silent master or modulator: level 0 is right */ }
  if (A.sync) c['t1.osc2Mod'] = 'Sync'; else c['t1.osc2Mod'] = 'Off';

  // Pitch. aSemi/bSemi from the sheet's notes override the knob reading.
  const semA = s.xl?.aSemi != null ? s.xl.aSemi - 24 : P5_SEMIS(A.freq);
  const semB = bAudio ? (s.xl?.bSemi != null ? s.xl.bSemi - 24 : P5_SEMIS(B.freq)) : semA;
  const fineB = bAudio && B.keyboard !== false ? P5_FINE_CENTS(B.fine) : 0;
  if (bAudio && B.keyboard === false) lost.push('Osc B ignores the keyboard on the Prophet; the XL\'s oscillators always follow it');
  let s1 = X.A === 'osc1' ? semA : semB, s2 = X.A === 'osc1' ? semB : semA;
  if (Math.abs(s2 - s1) > 24 && (levelA > 0 || levelB > 0)) {
    const was = Math.abs(s2 - s1);
    while (s2 - s1 > 24) s2 -= 12;
    while (s1 - s2 > 24) s1 -= 12;
    lost.push(`the oscillators are ${was} semitones apart, beyond the XL's 24; the upper one is moved down an octave`);
  }
  c['t1.transpose'] = clamp(s1, -48, 48);
  c['t1.osc2Semi'] = clamp(s2 - s1, -24, 24);
  // Osc B fine (sharp only) on whichever XL oscillator plays B.
  if (X.B === 'osc2') c['t1.osc2Tune'] = centsToTune(fineB);
  else { c['t1.detune'] = Math.round(clamp(fineB, 0, 50)); c['t1.osc2Tune'] = centsToTune(-clamp(fineB, 0, 50)); }

  // Filter
  const baseHz = P5_CUTOFF(s.filter.cutoff) * (s.filter.keyboard ? 2 ** P5_KEY_OCT_AT_C4 : 1);
  c['t1.f1Cutoff'] = inverse(XL_CUTOFF, baseHz);
  c['t1.f1Reso'] = Math.round(clamp(s.filter.resonance, 0, 10) * 11.5);
  c['t1.f1KeyTrack'] = s.filter.keyboard ? 1 : 0;
  const envOct = P5_ENV_OCT(s.filter.envAmount) + (pm.filter ? P5_ENV_OCT(pmEnv) : 0);
  c['t1.f1EgInt'] = cutoffMod(baseHz, envOct);

  // Envelopes: EG1 = filter envelope (also the poly-mod source), EG2 = amp.
  const env = (e, n) => {
    c[`t1.eg${n}A`] = inverse(XL_ATTACK, P5_ATTACK(e.attack));
    c[`t1.eg${n}D`] = inverse(XL_FADE, P5_FADE(e.decay));
    c[`t1.eg${n}S`] = lvl(e.sustain);
    c[`t1.eg${n}R`] = s.releaseSwitch ? inverse(XL_FADE, P5_FADE(e.release)) : 4;
  };
  env(s.filterEnv, 1);
  env(s.ampEnv, 2);

  // Poly-Mod
  if (pm.freqA && pmEnv > 0.25) {
    const cents = P5_PM_ENV_SEMIS(pmEnv) * 100;
    if (aOnOsc2) patch('EG1', 'OSC2 Tune', centsToTune(cents));
    else { patch('EG1', 'Pitch', centsToTune(cents)); lost.push('filter env -> Osc A pitch moves both oscillators on the XL (Osc A is the cross-mod carrier here)'); }
    if (cents > 2400) lost.push(`poly-mod pitch sweep of ${cents / 100} semitones is beyond the XL's 24`);
  }
  if (pm.pwA && pmEnv > 0.25) {
    if (X.A === 'osc1' && wA === 'Pulse') patch('EG1', 'OSC1 Ctrl1', pmEnv * 5);
    else lost.push('filter env -> Osc A pulse width (no pulse-width control on this XL oscillator)');
  }
  if (fmB) {
    c['t1.osc1Ctrl1'] = Math.round(clamp(pmB * 11, 0, 127));
    if (c['t1.osc1Wave'] === 'Pulse') c['t1.osc1Wave'] = 'Pulse';
    lost.push('Osc B -> Osc A FM uses the XL\'s cross-mod; its depth scale is a guess');
  }
  if (bAudio && pmB > 0.25 && pm.pwA) lost.push('Osc B -> Osc A pulse width at audio rate');
  if (bAudio && pmB > 0.25 && pm.filter) lost.push('Osc B -> filter at audio rate (the XL can\'t modulate its filter that fast)');

  // LFOs. The XL's Vibrato is the mod wheel times LFO2 (measured), so the Prophet's LFO is LFO2.
  // OSC1 Ctrl2 (pulse-width modulation) is wired to LFO1, so wheel PWM also copies the Prophet LFO
  // to LFO1. Lo-freq Osc B (per-voice poly-mod) gets LFO1 when it's free.
  const wheelPW = (wm.pwA && X.A === 'osc1' && wA === 'Pulse') || (wm.pwB && X.B === 'osc1' && wB === 'Pulse');
  const lfoB = !bAudio && pmB > 0.25 && pmOn;
  const lfoWave = { lfo1: { saw: 'Saw', tri: 'Triangle', square: 'Square' }, lfo2: { saw: 'Saw', tri: 'Sine', square: 'Square+' } };
  const shape = o => (o.tri ? 'tri' : o.saw ? 'saw' : o.square || o.pulse ? 'square' : 'tri');
  const noiseMix = wm.sourceMix >= 7;
  const setLfo = (n, sh, hz, sync) => Object.assign(c, {
    [`t1.${n}Wave`]: sh === 'random' ? 'Random' : lfoWave[n][sh], [`t1.${n}Freq`]: +hz.toFixed(2),
    [`t1.${n}KeySync`]: sync, [`t1.${n}Bpm`]: 'Off' });
  const prophetLfo = [noiseMix ? 'random' : shape(s.lfo), noiseMix ? 30 : P5_LFO_HZ(s.lfo.freq), 'Off']; // one global LFO
  setLfo('lfo2', ...prophetLfo);
  if (wheelPW && !lfoB) setLfo('lfo1', ...prophetLfo);
  if (wm.sourceMix > 2 && wm.sourceMix < 7) lost.push(`wheel-mod mixes LFO and noise (${wm.sourceMix}/10); uses ${noiseMix ? 'random' : 'the LFO'} only`);
  if (lfoB) {
    setLfo('lfo1', shape(B), P5_LFO_HZ(B.freq), 'Voice'); // per voice, like five separate Osc Bs
    if (wheelPW) lost.push('wheel pulse-width modulation runs at lo-freq Osc B\'s rate (both need LFO1 on the XL)');
    if (pm.freqA) patch('LFO1', aOnOsc2 ? 'OSC2 Tune' : 'Pitch', centsToTune(P5_PM_B_SEMIS(pmB) * 100));
    if (pm.pwA && X.A === 'osc1' && wA === 'Pulse') patch('LFO1', 'OSC1 Ctrl1', pmB * 5);
    if (pm.filter) patch('LFO1', 'Filt1 Cutoff', cutoffMod(baseHz, 0.6 * pmB));
  }
  // Wheel-mod: the mod wheel sets the depth. Pitch uses the XL's Vibrato (mod wheel -> pitch);
  // others use a patch from the LFO whose intensity the mod wheel opens.
  const lsrc = 'LFO2';
  if (wm.freqA || wm.freqB) {
    // Vibrato on one oscillator only matters if the other one is heard (a silent sync master
    // or modulator still needs to move: the XL's Vibrato moves both, which is right for sync).
    const only = wm.freqA !== wm.freqB ? (wm.freqA ? 'A' : 'B') : null;
    const otherHeard = only && (only === 'A' ? levelB : levelA) > 0 && !(only === 'B' && A.sync);
    const onlyXl = only && X[only];
    if (otherHeard && onlyXl === 'osc2' && patches.length <= 4) {
      patches.push(['LFO2', 'OSC2 Tune', 0]); // opened by the mod wheel, like the Prophet
      patch('Mod Wheel', `Patch${patches.length} Int`, centsToTune(WHEEL_VIBRATO_CENTS));
    } else {
      if (otherHeard) lost.push(`wheel vibrato on Osc ${only} only; the XL's vibrato moves both oscillators`);
      c['t1.vibrato'] = WHEEL_VIBRATO_CENTS;
    }
  }
  if (wheelPW) {
    c['t1.osc1Ctrl2'] = 0;
    patch('Mod Wheel', 'OSC1 Ctrl2', 50);
  }
  if ((wm.pwA && !(X.A === 'osc1' && wA === 'Pulse')) || (wm.pwB && !(X.B === 'osc1' && wB === 'Pulse'))) {
    lost.push('wheel -> pulse width on an oscillator without a pulse-width control');
  }
  if (wm.filter) {
    // LFO -> cutoff at intensity 0, opened by the mod wheel through a second patch.
    if (patches.length > 4) lost.push('no virtual patch slots left for wheel -> filter');
    else {
      patches.push([lsrc, 'Filt1 Cutoff', 0]);
      patch('Mod Wheel', `Patch${patches.length} Int`, cutoffMod(baseHz, WHEEL_FILTER_OCT));
    }
  }

  // No oscillators in the mixer and high resonance: the Prophet's filter rings on its own and
  // is the sound. The XL's filter doesn't self-oscillate (measured: silent with no input, only
  // faint with a little noise), so a sine plays the pitch the filter would ring at, and EG1
  // sweeps that pitch the way the filter envelope sweeps the cutoff.
  if (mx.oscA + mx.oscB + mx.noise < 0.5 && s.filter.resonance >= 8) {
    const ring = P5_CUTOFF(s.filter.cutoff);
    Object.assign(c, { 't1.osc1Wave': 'Sine', 't1.osc1Mod': 'Waveform', 't1.osc1Level': 110, 't1.osc2Level': 0,
      't1.noiseLevel': 0, 't1.osc2Mod': 'Off', 't1.f1Cutoff': 127, 't1.f1Reso': 0, 't1.f1EgInt': 0, 't1.wsType': 'Off',
      't1.transpose': ringTranspose(ring, lost), 't1.detune': 0 });
    if (!s.filter.keyboard) lost.push('the ringing filter ignores the keyboard on the Prophet; the sine follows it');
    const cents = P5_ENV_OCT(s.filter.envAmount) * 1200;
    patches.length = 0;
    if (cents > 0) patch('EG1', 'Pitch', centsToTune(Math.min(cents, 2400)));
    if (cents > 2400) lost.push(`filter sweep of ${(cents / 1200).toFixed(1)} octaves cut to the XL's 2 octaves of pitch modulation`);
    lost.push('self-oscillating filter replaced by a sine at the pitch it would ring at');
  }

  // Voices: unison stacks voices on one note (no detune knob on the original, so only Analog
  // Tune and a small detune spread them). Glide only works in unison on the original.
  if (s.unison) {
    Object.assign(c, { 't1.voiceAssign': 'Mono 1', 't1.unison': '4 Voice', 't1.unisonDetune': 6, 't1.unisonSpread': 40 });
    c['t1.portamento'] = Math.round(clamp(s.glide, 0, 10) * 9);
  } else Object.assign(c, { 't1.voiceAssign': 'Poly', 't1.unison': 'Off', 't1.portamento': 0 });

  patches.forEach(([src, dst, int], i) => Object.assign(c, {
    [`t1.patch${i + 1}Src`]: src, [`t1.patch${i + 1}Dst`]: dst, [`t1.patch${i + 1}Int`]: int,
  }));
  for (let i = patches.length + 1; i <= 6; i++) c[`t1.patch${i}Int`] = 0;
  for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
  levelProgram(c, lost); // as loud as the XL's factory sounds
  return { changes: c, lost, xlOsc: X };
}

function build() {
  const sheets = JSON.parse(readFileSync(new URL('tools/prophet/factory-1978.json', root), 'utf8'));
  const programs = [], report = ['# Prophet-5 1978 factory programs on the microKORG XL', '',
    'Generated by tools/prophet/convert.mjs from tools/prophet/factory-1978.json. Do not edit by hand.', ''];
  for (const s of sheets) {
    const { changes, lost, xlOsc } = convert(s);
    programs.push({ name: s.xlName, changes });
    report.push(`## ${s.program} ${s.name} → ${s.xlName}`, '',
      `Prophet Osc A → XL ${xlOsc.A.toUpperCase()}, Osc B → XL ${xlOsc.B.toUpperCase()}.`,
      s.notes?.summary ? `Notes: ${s.notes.summary}` : '', '',
      lost.length ? 'Not carried over:\n' + lost.map(l => `- ${l}`).join('\n') : 'Everything carried over.', '',
      '```json', JSON.stringify(changes), '```', '');
  }
  writeBank('Prophet5_1978.syx', programs);
  writeFileSync(new URL('tools/prophet/report.md', root), report.join('\n'));
  console.log(`${sheets.length} programs -> presets/Prophet5_1978.syx, tools/prophet/report.md`);
}

if (import.meta.url === `file://${process.argv[1]}`) build();
