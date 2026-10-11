// MIDI port naming shared by every page. Devices (core/devices.js) can give their own ports
// friendlier names, and say which ports are a synth's keyboard (in) and sound engine (out).
import { DEVICES } from './devices.js';

export function portLabel(p) {
  for (const d of DEVICES) { const label = d.portLabel(p); if (label) return label; }
  return p.manufacturer && !p.name.toLowerCase().includes(p.manufacturer.toLowerCase().split(' ')[0])
    ? `${p.name} (${p.manufacturer})` : p.name;
}
// A known synth's keyboard input, or its sound output.
export const looksLikeSynthIn = p => DEVICES.some(d => d.isIn(p));
export const looksLikeSynthOut = p => DEVICES.some(d => d.isOut(p));
