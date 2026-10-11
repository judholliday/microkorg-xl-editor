// How the microKORG XL's MIDI ports look to the browser.
//
// On macOS, browsers show the XL's ports by their short names (or, in some Chrome versions, with
// "microKORG XL " in front). "KBD/KNOB" and "SOUND" are the synth itself; "MIDI IN" / "MIDI OUT"
// are pass-throughs to the 5-pin sockets on its back panel.
export const isKorg = p => /korg/i.test(p.manufacturer || '') || /microkorg/i.test(p.name);
const XL_PORT_LABELS = {
  'KBD/KNOB': 'microKORG XL',
  SOUND: 'microKORG XL',
  'MIDI IN': 'microKORG XL · MIDI IN socket',
  'MIDI OUT': 'microKORG XL · MIDI OUT socket',
};
// A friendly name for one of the XL's ports, or null if it isn't one.
export function xlPortLabel(p) {
  const short = p.name.replace(/^microKORG XL\s*/i, '').toUpperCase();
  return isKorg(p) && XL_PORT_LABELS[short] ? `${XL_PORT_LABELS[short]} (${short})` : null;
}
export const looksLikeSynthIn = p => isKorg(p) && /kbd|knob/i.test(p.name);
export const looksLikeSynthOut = p => isKorg(p) && /sound/i.test(p.name);
// For a port saved by name that isn't connected now.
export const isSynthOutName = name => /^(microKORG XL\s*)?SOUND$/i.test(name);
