// Offline checks for Lab patches: node tools/labtest.mjs (also run by tools/selftest.mjs)
import assert from 'node:assert/strict';
import { normalizePatch, cleanPatch, STARTERS, MODULES, toSlider, fromSlider, paramOf, formatValue, newId } from '../js/lab/patch.js';

for (const s of STARTERS) assert.deepEqual(normalizePatch(s).notes, [], `${s.name} is clean`);
assert.deepEqual(cleanPatch(STARTERS[1]), STARTERS[1], 'normalizing twice changes nothing');

{
  const { patch, notes } = normalizePatch({
    name: '  Test  ', voices: 99, volume: 3,
    modules: [
      { id: 'osc1', type: 'osc', params: { wave: 'zigzag', octave: 9, fine: 12.4 } },
      { id: 'osc1', type: 'osc' }, // duplicate id: renamed
      { id: 'x', type: 'theremin' },
      { id: 'f', type: 'filter', params: { cutoff: 5 } },
      { id: 'amp1', type: 'amp' },
      { id: 'rev', type: 'reverb' },
      { id: 'e', type: 'env' },
    ],
    audio: [{ from: 'osc1', to: 'f' }, { from: 'f', to: 'amp1' }, { from: 'amp1', to: 'f' }, // loop
      { from: 'amp1', to: 'rev' }, { from: 'rev', to: 'f' }, // global -> voice
      { from: 'e', to: 'out' }, { from: 'rev', to: 'out' }],
    mod: [{ from: 'e', to: 'f.cutoff', amount: 99999 }, { from: 'vel', to: 'amp1.level', amount: 0.5 },
      { from: 'osc1', to: 'f.cutoff' }, { from: 'e', to: 'f.type' }],
    cc: { 74: 'f.cutoff', 75: 'f.type', 300: 'f.cutoff' },
  });
  assert.equal(patch.name, 'Test');
  assert.equal(patch.voices, 16);
  assert.equal(patch.volume, 1);
  assert.deepEqual(patch.modules.map(m => m.id), ['osc1', 'osc2', 'f', 'amp1', 'rev', 'e']);
  assert.deepEqual([patch.modules[0].params.wave, patch.modules[0].params.octave, patch.modules[0].params.fine], ['saw', 3, 12]);
  assert.equal(patch.modules[2].params.cutoff, 20);
  assert.deepEqual(patch.audio, [{ from: 'osc1', to: 'f' }, { from: 'f', to: 'amp1' }, { from: 'amp1', to: 'rev' }, { from: 'rev', to: 'out' }]);
  assert.deepEqual(patch.mod, [{ from: 'e', to: 'f.cutoff', amount: 9600 }, { from: 'vel', to: 'amp1.level', amount: 0.5 }]);
  assert.deepEqual(patch.cc, { 74: 'f.cutoff' });
  assert.ok(notes.some(n => n.includes('theremin')) && notes.some(n => n.includes('amp1 → f')));
  assert.throws(() => normalizePatch({ name: 'x' }));
  assert.ok(normalizePatch({ modules: [{ type: 'osc' }] }).notes.some(n => n.includes('output')));
}

// Sliders: log settings map evenly in octaves, and round-trip.
{
  const cutoff = paramOf('filter', 'cutoff');
  assert.ok(Math.abs(toSlider(cutoff, 632.5) - 0.5) < 0.01, 'log midpoint');
  for (const x of [0, 0.25, 0.8, 1]) assert.ok(Math.abs(toSlider(cutoff, fromSlider(cutoff, x)) - x) < 1e-9);
  assert.equal(fromSlider(paramOf('osc', 'octave'), 0.6), 1, 'stepped');
  assert.equal(formatValue(cutoff, 2400), '2.40 kHz');
  assert.equal(formatValue(paramOf('amp', 'attack'), 0.005), '5 ms');
  assert.equal(newId({ modules: [{ id: 'osc1' }, { id: 'osc3' }] }, 'osc'), 'osc2');
}
for (const [type, spec] of Object.entries(MODULES)) {
  for (const p of spec.params) assert.ok(p.kind === 'choice' ? p.choices.includes(p.def) : p.def >= p.min && p.def <= p.max, `${type}.${p.key} default in range`);
}
console.log('ok — Lab patches');
