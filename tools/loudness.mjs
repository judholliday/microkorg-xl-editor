// Rough loudness estimate for XL programs, from their settings (no audio): used to keep converted
// banks about as loud as Korg's factory sounds. Not a measurement; tools/listen.py measures.
//   node tools/loudness.mjs [bank ...]   -> median per bank, and the quietest programs
//
// Model, for a note at C4: each oscillator's harmonics (saw 1/n, pulse/square odd 1/n, triangle
// 1/n^2, sine 1), its level, a 24 dB/oct low-pass at the cutoff (measured Hz, plus EG1 Int at the
// envelope's sustain, or its peak for sounds that don't sustain), then amp level and EG2 sustain.
// Result in dB, 0 = one full-level saw through an open filter at full amp level.
import { readFileSync, readdirSync } from 'node:fs';
import { parseKorgEditorFile } from '../js/xl/korgfile.js';
import { splitSysex, parse } from '../js/xl/sysex.js';
import { initProgram } from '../js/xl/params.js';
import { programToAi, applyAiChanges } from '../js/xl/aiparams.js';
import { XL_CUTOFF, root } from './xlunits.mjs';

const hzAt = v => {
  if (v <= XL_CUTOFF[0][0]) return XL_CUTOFF[0][1];
  for (let i = 1; i < XL_CUTOFF.length; i++) {
    const [v0, h0] = XL_CUTOFF[i - 1], [v1, h1] = XL_CUTOFF[i];
    if (v <= v1) return Math.exp(Math.log(h0) + (Math.log(h1) - Math.log(h0)) * (v - v0) / (v1 - v0));
  }
  return XL_CUTOFF[XL_CUTOFF.length - 1][1] * 2 ** ((v - XL_CUTOFF[XL_CUTOFF.length - 1][0]) / 8);
};
const SPECTRUM = { Saw: n => 1 / n, Pulse: n => (n % 2 ? 1 / n : 0), Square: n => (n % 2 ? 1 / n : 0), Triangle: n => (n % 2 ? 1 / (n * n) : 0), Sine: n => (n === 1 ? 1 : 0) };
const num = (x, d = 0) => (typeof x === 'number' ? x : d);

// atPeak: at the brightest, loudest moment of the envelopes (EG1 and EG2 at full) instead of
// where a held note settles.
function timbreDb(s, t, atPeak = false) {
  const P = k => s[`t${t}.${k}`];
  const f0 = 261.63 * 2 ** (num(P('transpose')) / 12);
  const sustains = !atPeak && num(P('eg2S')) > 20;
  // EG1 Int moves the cutoff about 2 steps per unit, at the envelope's level: where a held note
  // settles (sustain), or for the peak the brightest point, which for an inverted (negative)
  // envelope is its lowest level, the sustain.
  const int = num(P('f1EgInt')) * 2, sus = num(P('eg1S')) / 127;
  const egShift = atPeak ? Math.max(int, int * sus) : sustains ? int * sus : Math.max(int, int * sus);
  const cut = num(P('f1Cutoff'), 64) + egShift;
  const fc = hzAt(cut);
  let power = 0;
  const add = (wave, level, semis) => {
    if (!level) return;
    const spec = SPECTRUM[wave] || SPECTRUM.Saw, f = f0 * 2 ** (semis / 12);
    for (let n = 1; n <= 60 && n * f < 16000; n++) {
      const a = spec(n) * (level / 127) / Math.sqrt(1 + (n * f / fc) ** 8);
      power += a * a;
    }
  };
  add(P('osc1Wave'), num(P('osc1Level')), 0);
  add(P('osc2Wave'), num(P('osc2Level')), num(P('osc2Semi')));
  power += (num(P('noiseLevel')) / 127) ** 2 * 0.3 * Math.min(1, fc / 8000);
  const amp = (num(P('ampLevel'), 100) / 127) * (atPeak ? 1 : sustains ? num(P('eg2S')) / 127 : 0.5);
  return 10 * Math.log10(power * amp * amp + 1e-12) - 10 * Math.log10(1.64); // saw at full = 0 dB
}

export function loudness(settings, atPeak = false) {
  const db = timbreDb(settings, 1, atPeak);
  return settings.voiceMode === 'Layer' ? 10 * Math.log10(10 ** (db / 10) + 10 ** (timbreDb(settings, 2, atPeak) / 10)) : db;
}

export function loadBank(file) {
  const bytes = new Uint8Array(readFileSync(new URL(`presets/${file}`, root)));
  const progs = file.endsWith('.syx') ? splitSysex(bytes).map(parse).filter(m => m?.data) : parseKorgEditorFile(bytes);
  return progs.map(p => programToAi(p.data));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = process.argv.length > 2 ? process.argv.slice(2) : readdirSync(new URL('presets/', root)).filter(f => /\.(syx|mkxl_all)$/.test(f));
  const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  for (const f of files) {
    const rows = loadBank(f).map(p => ({ name: p.name.trim(), db: loudness(p.settings) }));
    const quiet = [...rows].sort((a, b) => a.db - b.db).slice(0, 4).map(r => `${r.name} ${r.db.toFixed(0)}`).join(', ');
    console.log(`${f.replace(/\.(syx|mkxl_all)$/, '').padEnd(22)} median ${median(rows.map(r => r.db)).toFixed(1).padStart(6)} dB   quietest: ${quiet}`);
  }
}

// ---- levelling converted programs ----

// Korg's XL factory bank sits around -3 dB on this estimate; converted programs are brought to that
// when they're more than a dB or two off it.
export const TARGET_DB = -3;
const settingsOf = changes => {
  const data = initProgram();
  applyAiChanges(data, changes, 'level');
  return programToAi(data).settings;
};

// Brings a converted program (changes in the AI value format) to about the factory sounds'
// loudness, keeping its sound: the oscillator and noise levels together (keeping their mix), then
// the amp level. Only a program that would be inaudible even at its brightest moment (a filter
// that never opens at middle C) gets its cutoff raised, just until it can be heard; sounds that
// open bright and then close keep their filter. Notes a cutoff change in `report`. Changes
// `changes` in place.
const INAUDIBLE_DB = -24, AUDIBLE_DB = -14;
export function levelProgram(changes, report = []) {
  const timbres = changes.voiceMode === 'Layer' ? [1, 2] : [1];
  const db = () => loudness(settingsOf(changes));
  const start = db();
  if (start > TARGET_DB - 1.5 && start < TARGET_DB + 4) return start;
  if (start >= TARGET_DB + 4) { // too loud: trim the amp level
    for (const t of timbres) changes[`t${t}.ampLevel`] = Math.max(70, Math.round(num(changes[`t${t}.ampLevel`], 110) * 10 ** ((TARGET_DB + 2 - start) / 20)));
    return db();
  }
  // 1. Oscillators and noise up together, the loudest to full level.
  const keys = timbres.flatMap(t => ['osc1Level', 'osc2Level', 'noiseLevel'].map(k => `t${t}.${k}`));
  const top = Math.max(...keys.map(k => num(changes[k])));
  if (top > 0 && top < 127) {
    const g = Math.min(127 / top, 10 ** ((TARGET_DB - start) / 20));
    for (const k of keys) if (num(changes[k])) changes[k] = Math.min(127, Math.round(changes[k] * g));
  }
  // 2. Amp level.
  let now = db();
  if (now < TARGET_DB - 0.5) {
    for (const t of timbres) changes[`t${t}.ampLevel`] = Math.min(127, Math.round(num(changes[`t${t}.ampLevel`], 110) * 10 ** ((TARGET_DB - now) / 20)));
    now = db();
  }
  // 3. Inaudible even at its peak: open the filter just until it can be heard.
  const peak = () => loudness(settingsOf(changes), true);
  if (peak() < INAUDIBLE_DB) {
    const from = num(changes['t1.f1Cutoff'], 64);
    while (peak() < AUDIBLE_DB && timbres.some(t => num(changes[`t${t}.f1Cutoff`], 64) < 127)) {
      for (const t of timbres) changes[`t${t}.f1Cutoff`] = Math.min(127, num(changes[`t${t}.f1Cutoff`], 64) + 2);
    }
    if (changes['t1.f1Cutoff'] !== from) report.push(`filter opened a little (cutoff ${from} → ${changes['t1.f1Cutoff']}) so it can be heard: at middle C the original's filter barely opens`);
    now = db();
  }
  return now;
}
