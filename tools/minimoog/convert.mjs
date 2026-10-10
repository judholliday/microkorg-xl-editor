// Converts Moog's 1974 Minimoog "Sound Charts" into microKORG XL programs and writes them as a bank.
//   node tools/minimoog/convert.mjs  -> presets/Minimoog_Charts.syx, tools/minimoog/report.md
//
// The Minimoog is monophonic: three VCOs (oscillator 3 can also be a low-frequency modulator),
// noise, a mixer that can overdrive -> 24 dB ladder filter with its own contour (ADS, plus a
// decay switch that makes release = decay) -> VCA with a loudness contour. A modulation mix of
// oscillator 3 and noise goes, scaled by the mod wheel, to the oscillators' pitch and/or the
// filter. On the XL: two oscillators in Timbre 1; a third heard oscillator goes in Timbre 2,
// layered with the same filter and contours (the Minimoog is mono, so the layer costs no
// polyphony). The filter contour is EG1, the loudness contour EG2.
//
// XL side: hardware measurements (tools/xlunits.mjs). Minimoog side: the charts give envelope
// times in ms; the other ranges are ASSUMED (marked).
import { readFileSync, writeFileSync } from 'node:fs';
import { root, clamp, attackValue, fadeValue, cutoffValue, cutoffMod, centsToTune, writeBank, BASE, ringTranspose } from '../xlunits.mjs';
import { levelProgram } from '../loudness.mjs';

// Cutoff knob -5..+5: ASSUMED one octave per unit around 500 Hz, at the lowest key (F, 0 V of the
// keyboard CV; the 44-key keyboard's low F is about 1.6 octaves below middle C). Keyboard control
// adds 1/3 and/or 2/3 of the keys' octaves, so at middle C the cutoff is that much higher, and the
// XL's Key Track (measured to be centred on C4) carries it from there.
const M_CUTOFF = k => 500 * 2 ** k;
const M_KEY_OCT_AT_C4 = 19 / 12;
// Amount of contour 0..10: ASSUMED 0.5 octave per unit.
const M_CONTOUR_OCT = k => 0.5 * k;
// Contour times are printed in ms. ASSUMED: attack = time to full; decay = the time constant-ish
// figure on the knob, so it's about 1.5x that to fade 40 dB.
const M_ATTACK = ms => Math.max(0.001, ms / 1000);
const M_FADE = ms => Math.max(0.02, 1.5 * ms / 1000);
// Oscillator 3 in LO range: ASSUMED about 3 Hz with its frequency knob at 0, the knob's semitones
// scaling that (so +12 = 6 Hz).
const LO_HZ = freq => 3 * 2 ** ((freq || 0) / 12);
// Mod wheel at full: ASSUMED +/-100 cents to pitch, 2 octaves to the filter.
const WHEEL_CENTS = 100, WHEEL_FILTER_OCT = 2;
const RANGE = { "32'": -24, "16'": -12, "8'": 0, "4'": 12, "2'": 24, LO: null };

// XL oscillator wave (and OSC1 pulse width in Ctrl1) for a Minimoog waveform.
const WAVE = {
  triangle: ['Triangle', 0], trisaw: ['Saw', 0], saw: ['Saw', 0], revsaw: ['Saw', 0],
  square: ['Pulse', 0], widepulse: ['Pulse', 45], narrowpulse: ['Pulse', 95],
};

export function convert(s) {
  const lost = [];
  const n = v => (typeof v === 'number' ? v : 0);
  const oscs = [1, 2, 3].map(i => {
    const o = s[`osc${i}`] || {};
    return { i, ...o, level: n(s.mixer?.[`osc${i}`]), heard: !!s.mixer?.[`osc${i}On`] && n(s.mixer?.[`osc${i}`]) > 0,
      semis: RANGE[o.range] == null ? null : RANGE[o.range] + (i > 1 ? n(o.freq) : 0) };
  });
  const heard = oscs.filter(o => o.heard && o.semis != null);
  const noise = s.mixer?.noiseOn ? n(s.mixer.noise) : 0;
  if (s.mixer?.extOn && n(s.mixer.ext) > 0) lost.push('external input (the XL patch has no audio input routing here)');
  if (s.mixer?.noiseColor === 'pink' && noise) lost.push('pink noise (the XL\'s noise is white)');

  const timbre = (t, list) => {
    const c = {};
    const P = k => `t${t}.${k}`;
    // Pulses that need a width go on OSC1 (OSC2's pulse is always square).
    list.sort((a, b) => (WAVE[b.waveform]?.[1] || 0) - (WAVE[a.waveform]?.[1] || 0));
    const [x1, x2] = list;
    const base = x1 ? x1.semis : 0;
    c[P('transpose')] = clamp(base, -48, 48);
    const setOsc = (slot, o) => {
      if (!o) { c[P(`${slot}Level`)] = 0; return; }
      const [w, width] = WAVE[o.waveform] || ['Saw', 0];
      c[P(`${slot}Wave`)] = w;
      c[P(`${slot}Level`)] = Math.round(clamp(o.level, 0, 10) * 12);
      if (slot === 'osc1') Object.assign(c, { [P('osc1Mod')]: 'Waveform', [P('osc1Ctrl1')]: width, [P('osc1Ctrl2')]: 0 });
      else if (width) lost.push(`oscillator ${o.i}'s ${o.waveform} plays as a square (XL OSC2's pulse width is fixed)`);
      if (o.waveform === 'trisaw') lost.push(`oscillator ${o.i}'s triangle-saw ("shark tooth") wave plays as a saw`);
      if (o.waveform === 'revsaw') lost.push('oscillator 3\'s reverse saw plays as a saw');
    };
    setOsc('osc1', x1);
    setOsc('osc2', x2);
    if (x2) {
      const rel = x2.semis - base;
      const whole = Math.trunc(rel);
      c[P('osc2Semi')] = clamp(whole, -24, 24);
      // fractional settings, and "in unison" notes, become a few cents of detune
      c[P('osc2Tune')] = centsToTune((rel - whole) * 100 || (/unison/i.test(s.notes || '') ? 6 : 0));
    } else c[P('osc2Semi')] = 0;
    c[P('osc2Mod')] = 'Off';
    return c;
  };

  const c = { ...BASE, 't1.analogTune': 12, 't1.voiceAssign': 'Mono 1', 't1.unison': 'Off' };
  Object.assign(c, timbre(1, heard.slice(0, 2)));
  c['t1.noiseLevel'] = Math.round(noise * 12);
  if (!heard.length && !noise && n(s.filter?.emphasis) < 8) lost.push('no oscillator or noise is switched on in the mixer');

  // Mixer overdrive: the Minimoog's mixer into the ladder distorts when the levels add up.
  const sum = heard.reduce((a, o) => a + o.level, 0) + noise;
  if (sum > 10) Object.assign(c, { 't1.wsType': 'Drive', 't1.wsPosition': 'Pre Filter 1', 't1.wsDepth': Math.round(clamp((sum - 10) * 4, 4, 40)) });
  else c['t1.wsType'] = 'Off';

  // Filter
  const f = s.filter || {};
  const track = (f.kbd1 ? 1 / 3 : 0) + (f.kbd2 ? 2 / 3 : 0);
  const baseHz = M_CUTOFF(n(f.cutoff)) * 2 ** (M_KEY_OCT_AT_C4 * track);
  Object.assign(c, { 't1.f1Cutoff': cutoffValue(baseHz), 't1.f1Reso': Math.round(clamp(n(f.emphasis), 0, 10) * 11.5),
    't1.f1KeyTrack': +track.toFixed(2), 't1.f1EgInt': cutoffMod(baseHz, M_CONTOUR_OCT(n(f.contour))) });

  // Contours: the DECAY switch makes release = decay; otherwise notes stop quickly.
  const L = s.loudness || {};
  const rel = ms => (s.decaySwitch ? fadeValue(M_FADE(n(ms))) : 6);
  Object.assign(c, {
    't1.eg1A': attackValue(M_ATTACK(n(f.attack))), 't1.eg1D': fadeValue(M_FADE(n(f.decay))), 't1.eg1S': Math.round(n(f.sustain) * 12.7), 't1.eg1R': rel(f.decay),
    't1.eg2A': attackValue(M_ATTACK(n(L.attack))), 't1.eg2D': fadeValue(M_FADE(n(L.decay))), 't1.eg2S': Math.round(n(L.sustain) * 12.7), 't1.eg2R': rel(L.decay),
  });
  c['t1.portamento'] = s.glideSwitch && n(s.glide) > 0 ? Math.round(n(s.glide) * 9) : 0;
  c['t1.ampLevel'] = 110;

  // Modulation: oscillator 3 (when it isn't heard, or is in LO range) or noise, by the mod wheel.
  const patches = [];
  const o3 = oscs[2];
  const modByOsc3 = n(s.modMix) <= 5;
  if (s.oscMod || f.filterMod) {
    if (modByOsc3 && o3.range !== 'LO' && !o3.heard) lost.push('oscillator 3 modulating at audio rate (FM) is replaced by an LFO');
    const wave = { triangle: 'Sine', saw: 'Saw', revsaw: 'Saw', square: 'Square+', widepulse: 'Square+', narrowpulse: 'Square+' }[o3.waveform] || 'Sine';
    Object.assign(c, modByOsc3
      ? { 't1.lfo2Wave': wave, 't1.lfo2Freq': +(o3.range === 'LO' ? LO_HZ(o3.freq) : 6).toFixed(2) }
      : { 't1.lfo2Wave': 'Random', 't1.lfo2Freq': 30 });
    Object.assign(c, { 't1.lfo2KeySync': 'Off', 't1.lfo2Bpm': 'Off' });
    if (s.oscMod) c['t1.vibrato'] = WHEEL_CENTS; // Vibrato = mod wheel x LFO2
    if (f.filterMod) {
      patches.push(['LFO2', 'Filt1 Cutoff', 0]);
      patches.push(['Mod Wheel', 'Patch1 Int', cutoffMod(baseHz, WHEEL_FILTER_OCT)]);
    }
  }
  if (o3.kbdControl === false && o3.heard) lost.push('oscillator 3 with keyboard control off (a drone) follows the keys on the XL');

  // Nothing heard in the mixer but high emphasis: the ringing filter is the sound (the charts use
  // it for sirens and whistles). The XL's filter doesn't ring on its own, so a sine plays the cutoff
  // pitch, the filter contour sweeps its pitch, and modulation meant for the filter goes to pitch.
  if (!heard.length && n(f.emphasis) >= 8) {
    Object.assign(c, { 't1.osc1Wave': 'Sine', 't1.osc1Mod': 'Waveform', 't1.osc1Level': 100, 't1.osc2Level': 0,
      't1.transpose': ringTranspose(baseHz, lost), 't1.f1Cutoff': 127, 't1.f1Reso': 0, 't1.f1EgInt': 0 });
    if (noise) Object.assign(c, { 't1.f1Cutoff': cutoffValue(baseHz), 't1.f1Reso': 90 }); // keep the noise, filtered
    const cents = M_CONTOUR_OCT(n(f.contour)) * 1200;
    for (const p of patches) if (p[1] === 'Filt1 Cutoff') p[1] = 'Pitch';
    if (patches[1]) patches[1][2] = centsToTune(Math.min(WHEEL_FILTER_OCT * 1200, 2400));
    if (cents > 0) patches.push(['EG1', 'Pitch', centsToTune(Math.min(cents, 2400))]);
    if (cents > 2400) lost.push(`filter sweep of ${(cents / 1200).toFixed(1)} octaves cut to the XL's 2 octaves`);
    if (track < 0.9) lost.push('the ringing pitch follows the keys fully on the XL');
    lost.push('self-oscillating filter replaced by a sine at the pitch it would ring at');
  }
  patches.forEach(([src, dst, int], i) => Object.assign(c, {
    [`t1.patch${i + 1}Src`]: src, [`t1.patch${i + 1}Dst`]: dst, [`t1.patch${i + 1}Int`]: int }));
  for (let i = patches.length + 1; i <= 6; i++) c[`t1.patch${i}Int`] = 0;

  // A third heard oscillator: Timbre 2, layered, with Timbre 1's filter, contours and modulation.
  if (heard.length > 2) {
    c.voiceMode = 'Layer';
    for (const [k, v] of Object.entries(c)) if (k.startsWith('t1.')) c[`t2.${k.slice(3)}`] = v;
    Object.assign(c, timbre(2, [heard[2]]), { 't2.noiseLevel': 0, 't2.wsType': 'Off' });
  }
  levelProgram(c, lost); // as loud as the XL's factory sounds
  return { changes: c, lost };
}

const short = name => name.toUpperCase().replace(/EMERSON, LAKE,? AND PALMER'S/, 'ELP').replace(/EMERSON'S/, 'ELP')
  .replace(/RICK WAKEMAN'S/, 'WAKEMAN').replace(/ELECTRIC/, 'E.').replace(/\(.*?\)/g, '').replace(/[^A-Z0-9 .&/+'-]/g, '').trim();
const RENAME = { 'Bass Viol, Bowed': 'BASS BOW', 'Bass Viol, Plucked': 'BASSPLUK', 'The T.L.R. Sound': 'TLR SND',
  'The Moog Sound': 'MOOG SND', 'Good Sound': 'GOOD SND', "Emerson, Lake, and Palmer's Aquatarkus, from Tarkus": 'AQUATARK',
  "Emerson's Fat Bass from Brain Salad Surgery": 'FAT BASS', "Emerson, Lake and Palmer's Trilogy": 'TRILOGY',
  "Rick Wakeman's Catherine of Aragon": 'CATHERIN', "Emerson's Steel Drum from Brain Salad Surgery": 'ELPSTEEL',
  'Tinkling Bells': 'TINKLBEL', 'Moon Chord': 'MOONCHRD', 'Ring Modulator Effects': 'RING MOD', 'Hommage a Badings': 'BADINGS',
  'Running Rhythm': 'RUN RHYT', 'Vree Oo Bleep-Bleep': 'VREE OO', 'Night Creatures': 'NIGHTCRT', 'Exploding Bomb': 'BOMB',
  'Temple Blocks': 'TMPLBLCK', 'Hindemoog': 'HINDEMOG', 'Electric Guitar, Bass/Treble': 'E.GUITAR', 'Balalaika (Mandolin)': 'BALALAIK',
  'Shamisen (Chinese plucked instrument)': 'SHAMISEN', 'Recorder Family': 'RECORDER', 'Clarinet (Bass Clarinet)': 'CLARINET',
  'Bassoon (English Horn)': 'BASSOON', 'Trombone (Jazz)': 'TROMBONE' };
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
  const data = JSON.parse(readFileSync(new URL('tools/minimoog/charts.json', root), 'utf8'));
  const used = new Set(), programs = [], report = ['# Moog Minimoog Sound Charts (1974) on the microKORG XL', '',
    'Generated by tools/minimoog/convert.mjs from tools/minimoog/charts.json. Do not edit by hand.', ''];
  for (const s of data.charts) {
    const name = xlName(s.name, used);
    const { changes, lost } = convert(s);
    programs.push({ name, changes });
    report.push(`## ${s.name} → ${name}`, '', s.notes ? `Notes: ${s.notes}` : '', '',
      lost.length ? 'Not carried over:\n' + lost.map(l => `- ${l}`).join('\n') : 'Everything carried over.', '',
      '```json', JSON.stringify(changes), '```', '');
  }
  writeBank('Minimoog_Charts.syx', programs);
  writeFileSync(new URL('tools/minimoog/report.md', root), report.join('\n'));
  console.log(`${programs.length} programs -> presets/Minimoog_Charts.syx, tools/minimoog/report.md`);
}
