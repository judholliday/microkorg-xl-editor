// MIDI port naming shared by the editor and the sequencer.
//
// On macOS, browsers show the XL's ports by their short names. "KBD/KNOB" and "SOUND" are the
// synth itself; "MIDI IN" / "MIDI OUT" are pass-throughs to the 5-pin sockets on its back panel.
export const isKorg = p => /korg/i.test(p.manufacturer || '') || /microkorg/i.test(p.name);
const XL_PORT_LABELS = {
  'KBD/KNOB': 'microKORG XL',
  SOUND: 'microKORG XL',
  'MIDI IN': 'microKORG XL · MIDI IN socket',
  'MIDI OUT': 'microKORG XL · MIDI OUT socket',
};
export function portLabel(p) {
  const short = p.name.replace(/^microKORG XL\s*/i, '').toUpperCase();
  if (isKorg(p) && XL_PORT_LABELS[short]) return `${XL_PORT_LABELS[short]} (${short})`;
  return p.manufacturer && !p.name.toLowerCase().includes(p.manufacturer.toLowerCase().split(' ')[0])
    ? `${p.name} (${p.manufacturer})` : p.name;
}
export const looksLikeSynthIn = p => isKorg(p) && /kbd|knob/i.test(p.name);
export const looksLikeSynthOut = p => isKorg(p) && /sound/i.test(p.name);
