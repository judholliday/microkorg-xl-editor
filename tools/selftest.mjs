// Offline checks for the SysEx codec and parameter map: node tools/selftest.mjs
import assert from 'node:assert/strict';
import { encode8to7, decode7to8, msg, parse, splitSysex } from '../js/xl/sysex.js';
import { PROGRAM_SIZE, PROGRAM_PARAMS, timbreParams, vocoderParams, fxParams, arpParams, TABLES,
  getValue, setValue, format, range, initProgram, programName, slotName, voicing } from '../js/xl/params.js';

// 7/8-bit packing round-trips for every length and every byte value.
for (let len = 0; len < 30; len++) {
  const d = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 200) & 0xff);
  assert.deepEqual(decode7to8(encode8to7(d)), d);
}
const full = Uint8Array.from({ length: PROGRAM_SIZE }, (_, i) => (i * 131) & 0xff);
const enc = encode8to7(full);
assert.ok(enc.every(b => b < 0x80));
assert.equal(enc.length, 396); // 49 full groups + 1 partial (346 = 7*49 + 3)

// Messages parse back to what was built.
const cur = parse(msg.currentProgramDump(3, full));
assert.equal(cur.type, 'currentProgram'); assert.equal(cur.channel, 3); assert.deepEqual(cur.data, full);
const pr = parse(msg.programDump(0, 77, full));
assert.equal(pr.program, 77); assert.deepEqual(pr.data, full);
for (const v of [-63, -1, 0, 1, 63, 300, -8192, 8191]) {
  const pc = parse(msg.parameterChange(0, 0x21, 0xa6, v));
  assert.equal(pc.id, 0x21); assert.equal(pc.sub, 0xa6); assert.equal(pc.value, v);
}
assert.deepEqual(msg.currentProgramRequest(0), [0xf0, 0x42, 0x30, 0x7e, 0x10, 0xf7]);
assert.deepEqual(msg.programRequest(1, 5), [0xf0, 0x42, 0x31, 0x7e, 0x1c, 5, 0, 0xf7]);
assert.deepEqual(msg.writeProgram(0, 127), [0xf0, 0x42, 0x30, 0x7e, 0x11, 127, 0, 0xf7]);
const id = parse([0xf0, 0x7e, 0x02, 0x06, 0x02, 0x42, 0x7e, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01, 0x00, 0xf7]);
assert.ok(id.isXL); assert.equal(id.channel, 2); assert.equal(id.version, '1.04');
assert.equal(splitSysex(Uint8Array.from([0xf0, 1, 0xf7, 0x90, 0xf0, 2, 3, 0xf7])).length, 2);

// Parameter map: every param in range of the buffer, bitfields don't collide, IDs unique.
const d = initProgram();
const all = [...PROGRAM_PARAMS, ...timbreParams(0), ...timbreParams(1), ...vocoderParams(), ...fxParams(d, 0), ...fxParams(d, 1), ...arpParams()];
const owned = new Map();
const ids = new Set();
for (const p of all) {
  assert.ok(p.off >= 0 && p.off + (p.word ? 1 : 0) < PROGRAM_SIZE, p.key);
  const [lo, hi] = p.bits || [0, 7];
  for (let b = lo; b <= hi; b++) {
    for (let o = p.off; o <= p.off + (p.word ? 1 : 0); o++) {
      const k = `${o}.${b}`;
      assert.ok(!owned.has(k), `${p.key} overlaps ${owned.get(k)} at byte ${o} bit ${b}`);
      owned.set(k, p.key);
    }
  }
  const key = `${p.id}:${p.sub}`;
  assert.ok(!ids.has(key), `duplicate id ${key} (${p.key})`);
  ids.add(key);
  const [min, max] = range(p.fmt);
  assert.equal(typeof format(p.fmt, min), 'string');
  assert.equal(typeof format(p.fmt, max), 'string');
  assert.ok(!format(p.fmt, max).includes('undefined'), p.key);
}
// setValue on a bitfield leaves neighbouring bits alone.
const t = new Uint8Array(PROGRAM_SIZE).fill(0xff);
const osc1Mod = timbreParams(0).find(p => p.key === 't1.osc1Mod');
setValue(t, osc1Mod, 2);
assert.equal(t[16 + 16], 0b11101111); assert.equal(getValue(t, osc1Mod), 2);
// Every effect type exposes a param set that fits its 20 slots.
for (let type = 0; type < 18; type++) {
  const x = initProgram(); x[286] = type; x[286 + 24] = type;
  for (const s of [0, 1]) assert.ok(fxParams(x, s).length <= 23);
}
assert.equal(TABLES.VIBRATO.length, 128); assert.equal(TABLES.KEY_TRACK.length, 128);
assert.equal(TABLES.EQ_LOW_FREQ.length, 34); assert.equal(TABLES.EQ_HI_FREQ.length, 26);
assert.equal(programName(initProgram()), 'Init');
assert.equal(slotName(0), 'A.11'); assert.equal(slotName(63), 'A.88'); assert.equal(slotName(64), 'B.11');
console.log(`ok — ${all.length} parameters checked`);

// AI value translation: every factory preset survives bytes -> readable -> bytes for every mapped param.
import { readdirSync, readFileSync } from 'node:fs';
import { parseKorgEditorFile } from '../js/xl/korgfile.js';
import { aiParams, programToAi, applyAiChanges, parameterReference, fromAi, toAi } from '../js/xl/aiparams.js';
let presetCount = 0;
for (const f of readdirSync(new URL('../presets/', import.meta.url))) {
  if (!f.endsWith('.mkxl_all')) continue;
  for (const pr of parseKorgEditorFile(new Uint8Array(readFileSync(new URL(`../presets/${f}`, import.meta.url))))) {
    const { name, settings } = programToAi(pr.data);
    const rebuilt = initProgram();
    const { errors } = applyAiChanges(rebuilt, settings, name);
    assert.deepEqual(errors, [], `${f} ${name}`);
    for (const { key, p } of aiParams(pr.data)) {
      // Compare meaning, not bytes: some lookup tables repeat a value (Time Ratio has five 100% steps).
      assert.equal(toAi(p, getValue(rebuilt, p)), toAi(p, getValue(pr.data, p)), `${f} "${name}" ${key}`);
    }
    presetCount++;
  }
}
const ref = parameterReference(initProgram());
assert.ok(ref.includes('t1.f1Cutoff') && ref.includes('#### Tape Echo') && ref.includes('fx1.Feedback'));
const cutoff = timbreParams(0).find(p => p.key === 't1.f1Cutoff');
assert.throws(() => fromAi(cutoff, 'bright'));
assert.equal(fromAi(cutoff, 300), 127);
console.log(`ok — ${presetCount} presets round-trip through the AI value format`);

// Replies captured from the user's real microKORG XL (global channel 2, firmware 1.04).
const realId = parse([0xF0, 0x7E, 0x01, 0x06, 0x02, 0x42, 0x7E, 0x00, 0x00, 0x00, 0x04, 0x01, 0x01, 0x00, 0xF7]);
assert.ok(realId.isXL); assert.equal(realId.channel, 1); assert.equal(realId.version, '1.04');
const realSearch = parse([0xF0, 0x42, 0x50, 0x01, 0x01, 0x11, 0x7E, 0x00, 0x00, 0x00, 0x04, 0x01, 0x01, 0x00, 0xF7]);
assert.equal(realSearch.type, 'search'); assert.ok(realSearch.isXL); assert.equal(realSearch.channel, 1);
assert.equal(realSearch.sysexFiltered, false); assert.equal(realSearch.version, '1.04');
console.log('ok — real device replies parse correctly');

// Sound types: every bundled preset gets a known type, and every reviewed correction matches a real preset.
import { soundType, TYPES } from '../js/xl/soundtype.js';
import { OVERRIDES } from '../js/xl/sound-types.js';
const seen = new Set(), banks = new Set();
for (const f of readdirSync(new URL('../presets/', import.meta.url))) {
  if (!/\.(mkxl_all|syx)$/.test(f)) continue;
  const bank = f.replace(/\..*/, '');
  banks.add(bank);
  const bytes = new Uint8Array(readFileSync(new URL(`../presets/${f}`, import.meta.url)));
  const programs = f.endsWith('.syx')
    ? splitSysex(bytes).map(parse).filter(m => m && /^(program|currentProgram)$/.test(m.type))
    : parseKorgEditorFile(bytes);
  for (const pr of programs) {
    const { name, settings } = programToAi(pr.data);
    const key = `${bank}/${name.trim()}`;
    seen.add(key);
    assert.ok(TYPES.includes(soundType(name, settings, key)), key);
  }
}
// Corrections for banks that aren't installed (e.g. Korg's, which aren't in the public repo) are skipped.
for (const [key, type] of Object.entries(OVERRIDES)) {
  if (!banks.has(key.split('/')[0])) continue;
  assert.ok(seen.has(key), `override for unknown preset ${key}`);
  assert.ok(TYPES.includes(type), `unknown type ${type}`);
}
console.log(`ok — ${seen.size} preset names typed, ${Object.keys(OVERRIDES).length} corrections valid`);

// Poly / Mono labels: the init program is poly; a mono timbre 1 makes a single program mono.
{
  const d = initProgram();
  assert.equal(voicing(d).kind, 'poly');
  setValue(d, timbreParams(0).find(p => p.key === 't1.voiceAssign'), 0);
  assert.equal(voicing(d).kind, 'mono');
  setValue(d, PROGRAM_PARAMS.find(p => p.key === 'voiceMode'), 2); // split: mono T1 + poly T2
  assert.equal(voicing(d).kind, 'mixed');
}

await import('./seqtest.mjs');
await import('./labtest.mjs');
await import('./rectest.mjs');

// The travel version's offline list (sw.js) has every page, style and script it uses.
{
  const { readdirSync: ls, readFileSync: read, existsSync } = await import('node:fs');
  const root = new URL('../', import.meta.url);
  const listed = [...read(new URL('sw.js', root), 'utf8').match(/const ASSETS = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  const wanted = [...ls(root).filter(f => /\.(html|css)$/.test(f) && f !== 'editor.html'),
    ...ls(new URL('js/', root)).filter(d => !d.includes('.')).flatMap(d => ls(new URL(`js/${d}/`, root)).filter(f => f.endsWith('.js')).map(f => `js/${d}/${f}`))
  ].filter(f => f !== 'js/xl/app.js'); // the XL editor isn't in the travel version
  const missing = wanted.filter(f => !listed.includes(f)), gone = listed.filter(f => f !== './' && !existsSync(new URL(f, root)));
  if (missing.length || gone.length) throw new Error(`sw.js ASSETS: missing ${missing.join(', ') || '-'}; not found ${gone.join(', ') || '-'}`);
  console.log(`ok — travel version's offline list (${listed.length} files)`);
}
