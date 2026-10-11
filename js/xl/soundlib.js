// Every sound the editor knows (the files in presets/ and My Sounds), each with its sound type, for
// pages other than the microKORG XL editor (the sequencer's sound browser). The editor's Presets tab has
// its own fuller version of this (type editing, grouping).
import { parse, splitSysex } from './sysex.js';
import { programName } from './params.js';
import { isKorgEditorFile, parseKorgEditorFile } from './korgfile.js';
import { programToAi } from './aiparams.js';
import { soundType } from './soundtype.js';

export const MY_BANK = 'My Sounds';
const BANK_LABELS = {
  MKXL_FactoryPreset: 'XL Factory', MK_FactoryPreset: 'microKORG classics',
  MS2K_FactoryPreset: 'MS2000 classics', MS2KB_FactoryPreset: 'MS2000B classics',
};
export const bankLabel = bank => BANK_LABELS[bank] || bank.replace(/_/g, ' ');

// Which sound types suit each sequencer track role (see guessRole in seq/model.js), best first.
export const ROLE_TYPES = {
  bass: ['Bass'],
  lead: ['Lead', 'Synth', 'Brass', 'Pluck & Stab'],
  chords: ['Keys', 'Organ', 'Pluck & Stab', 'Brass', 'Strings', 'Synth'],
  pad: ['Pad', 'Strings', 'Synth'],
  arp: ['Pluck & Stab', 'Arp & Sequence', 'Bells & Mallets', 'Synth', 'Lead'],
  drums: ['Drums & Hits', 'FX & Noise'],
};

function programsOf(bytes) {
  if (isKorgEditorFile(bytes)) return parseKorgEditorFile(bytes).map(p => p.data);
  return splitSysex(bytes).map(parse).filter(m => m && (m.type === 'program' || m.type === 'currentProgram')).map(m => m.data);
}

let cache = null;
// [{ key, bank, name, type, data }], loaded once per page.
export function loadSounds() {
  cache ||= (async () => {
    const get = (url, as = 'json') => fetch(url).then(r => (r.ok ? r[as]() : Promise.reject(new Error(`${url}: ${r.status}`))));
    const userTypes = await get('api/types').catch(() => ({}));
    const sounds = [];
    const add = (bank, data, key, hint = '') => {
      const name = programName(data);
      sounds.push({ key, bank, name, data: [...data],
        type: userTypes[key] || soundType(`${name} ${hint}`.trim(), programToAi(data).settings, key) });
    };
    for (const meta of await get('api/my-sounds').catch(() => [])) {
      try {
        const [data] = programsOf(new Uint8Array(await get(`my-sounds/${encodeURIComponent(meta.file)}`, 'arrayBuffer')));
        if (data) add(MY_BANK, data, `${MY_BANK}/${meta.file}`, meta.request || '');
      } catch { /* skip unreadable files */ }
    }
    for (const { file, bank } of await get('api/presets').catch(() => [])) {
      try {
        for (const data of programsOf(new Uint8Array(await get(`presets/${encodeURIComponent(file)}`, 'arrayBuffer')))) {
          add(bank, data, `${bank}/${programName(data).trim()}`);
        }
      } catch { /* skip unreadable files */ }
    }
    return sounds;
  })();
  return cache;
}
