// The microKORG XL's parameter values in real units, from measurements of the hardware
// (docs/xl-measurements.json, made with tools/calibrate.py), plus helpers for writing a preset
// bank. Shared by the converters that turn other synths' patches into XL programs.
import { readFileSync, writeFileSync } from 'node:fs';
import { initProgram } from '../js/xl/params.js';
import { applyAiChanges } from '../js/xl/aiparams.js';
import { msg } from '../js/xl/sysex.js';

export const root = new URL('../', import.meta.url);
const M = JSON.parse(readFileSync(new URL('docs/xl-measurements.json', root), 'utf8'));

export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// Measured tables, as [value, quantity] pairs sorted by value.
const table = (rows, pick) => Object.entries(rows).map(([v, r]) => [+v, pick(r)])
  .filter(([, q]) => typeof q === 'number').sort((a, b) => a[0] - b[0]);
export const XL_ATTACK = table(M.eg2a, r => r.attack_to_90pct_ms / 1000); // seconds to full level
export const XL_FADE = table(M.eg2d, r => r['to_-40dB_ms'] / 1000) // decay and release behave alike;
  .map(([v, d]) => [v, (d + (M.eg2r[v]?.['to_-40dB_ms'] / 1000 || d)) / 2]); // seconds to -40 dB
export const XL_CUTOFF = table(M.cutoff, r => r.minus12db_hz); // the -12 dB point = a ladder's nominal cutoff
export const XL_CUTOFF_3DB = table(M.cutoff, r => r.minus3db_hz);
const XL_CENTS = table(M.osc2tune, r => r.cents).filter(([v]) => v >= 0); // also patch -> OSC2 Tune/Pitch

// Value for a quantity, interpolating in the log domain (times, Hz) or linearly (cents, octaves).
export function inverse(tab, q, { log = true, min = 0, max = 127 } = {}) {
  const f = x => (log ? Math.log(Math.max(x, 1e-6)) : x);
  if (q <= tab[0][1]) return Math.max(min, tab[0][0]);
  for (let i = 1; i < tab.length; i++) {
    const [v0, q0] = tab[i - 1], [v1, q1] = tab[i];
    if (q <= q1) return Math.round(v0 + (v1 - v0) * (f(q) - f(q0)) / (f(q1) - f(q0)));
  }
  return max;
}

export const attackValue = seconds => inverse(XL_ATTACK, seconds);
export const fadeValue = seconds => inverse(XL_FADE, seconds); // decay or release, to -40 dB
// Filter 1 cutoff value whose nominal (-12 dB) cutoff is hz, at C4 with Key Track 0.
export const cutoffValue = hz => inverse(XL_CUTOFF, hz);
// OSC2 Tune, or intensity of a patch into "OSC2 Tune"/"Pitch", for a shift in cents.
export const centsToTune = c => Math.sign(c) * inverse(XL_CENTS, Math.abs(c), { log: false, max: 63 });

// EG1 Int (and a patch into Filt1 Cutoff) adds about 2 cutoff steps per unit at full
// modulation, in the cutoff knob's own units (measured: from 30, +8 -> 46, +16 -> 62, +32 -> 94).
// The cutoff scale isn't exponential, so the same intensity opens more octaves from a higher base.
const CUTOFF_STEPS_PER_INT = 2;
// Modulation intensity that moves the cutoff from baseHz by `octaves` (negative = down).
export function cutoffMod(baseHz, octaves) {
  const top = XL_CUTOFF[XL_CUTOFF.length - 1][1];
  const v0 = inverse(XL_CUTOFF, baseHz);
  const v1 = octaves > 0 && baseHz * 2 ** octaves > top ? 127 + 4 * (octaves - Math.log2(top / baseHz))
    : inverse(XL_CUTOFF, baseHz * 2 ** octaves);
  return clamp(Math.round((v1 - v0) / CUTOFF_STEPS_PER_INT), -63, 63);
}

// Transpose for a sine standing in for a self-oscillating filter: the ringing pitch from the
// cutoff, raised by octaves when it would be below about 65 Hz at C4 (inaudible on most speakers;
// the original's envelope or modulation usually swept it up, which the XL can't follow that far).
export function ringTranspose(hz, lost) {
  let semis = Math.round(12 * Math.log2(hz / 261.63));
  let raised = 0;
  while (semis < -24) { semis += 12; raised++; }
  if (raised) lost.push(`ringing pitch raised ${raised} octave${raised > 1 ? 's' : ''} so it can be heard`);
  return clamp(semis, -48, 48);
}

// Other measured facts the converters rely on:
// - Key Track +1.00 = full tracking (an octave per octave), centred on C4.
// - Vibrato (t1.vibrato) = mod wheel x LFO2; 100 = +/-98 cents at full wheel.
// - Analog Tune = a fixed random offset per note: 16 = +/-3 c, 32 = +/-7 c, 64 = +/-19 c.
// - The filter doesn't self-oscillate without input.

// Builds a preset bank from programs [{ name, changes }] (changes in the AI value format, applied
// to the init program) and writes it to presets/<file>.
export function writeBank(file, programs) {
  const out = [];
  for (const { name, changes } of programs) {
    const data = initProgram();
    const { errors } = applyAiChanges(data, changes, name);
    if (errors.length) throw new Error(`${name}: ${errors.join('; ')}`);
    out.push(...msg.currentProgramDump(0, data));
  }
  writeFileSync(new URL(`presets/${file}`, root), Uint8Array.from(out));
}

// Settings every converted program starts from: Timbre 1 only, effects and arp off, no velocity,
// flat EQ. Converters override what their synth needs.
export const BASE = {
  voiceMode: 'Single', 'arp.on': 'Off', 'fx1.type': 'No Effect', 'fx2.type': 'No Effect',
  't1.f1VelSens': 0, 't1.eg1Vel': 0, 't1.eg2Vel': 0, 't1.ampKeyTrack': 0, 't1.punch': 0,
  't1.eqLowGain': 0, 't1.eqHiGain': 0, 't1.ampLevel': 110, 't1.f1Balance': 0, 't1.filterRouting': 'Single',
  't1.detune': 0, 't1.vibrato': 0, 't1.bendRange': 2, 't1.analogTune': 0,
};
