// The microKORG XL as a device the rest of the app can use: the sequencer's tracks on the XL send
// it their sound when playback starts, and its Browse panel lists XL sounds. See core/devices.js.
import { msg } from './sysex.js';
import { xlPortLabel, looksLikeSynthIn, looksLikeSynthOut, isSynthOutName } from './ports.js';
import { loadSounds, ROLE_TYPES, bankLabel, MY_BANK } from './soundlib.js';

export const device = {
  id: 'xl',
  name: 'microKORG XL',
  view: 'editor', // its editor page in index.html
  portLabel: xlPortLabel,
  isIn: looksLikeSynthIn,
  isOut: looksLikeSynthOut,
  isOutName: isSynthOutName,
  needsSysex: true,
  // The message that loads a sound ({ name, data }) into the synth's edit buffer.
  soundMessage: (ch, data) => msg.currentProgramDump(ch, Uint8Array.from(data)),
  // Sounds for the sequencer's Browse panel: [{ key, bank, name, type, data }].
  sounds: { load: loadSounds, ROLE_TYPES, bankLabel, MY_BANK },
};
