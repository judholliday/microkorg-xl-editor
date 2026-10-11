// A stand-in microKORG XL for testing the editor without hardware: open http://localhost:8765/?sim
// It answers the SysEx requests described in Korg's MIDI Implementation.
import { msg, parse, encode8to7 } from '../js/xl/sysex.js';
import { initProgram, setProgramName, slotName, setValue, PROGRAM_PARAMS, timbreParams, vocoderParams,
  fxParams, arpParams } from '../js/xl/params.js';

// The real synth reports "64 +/- n" values relative to 64 (signed); this stand-in assumes the same.
const findParam = (data, id, sub) => [...PROGRAM_PARAMS, ...timbreParams(0), ...timbreParams(1), ...vocoderParams(),
  ...fxParams(data, 0), ...fxParams(data, 1), ...arpParams()].find(p => p.id === id && p.sub === sub);
const applyParam = (data, id, sub, value) => {
  if (id === 0 && sub < 8) { data[sub] = value; return true; } // program name characters
  const p = findParam(data, id, sub);
  if (!p) return false;
  setValue(data, p, p.fmt.bias ? value + p.fmt.bias : value);
  return true;
};

const memory = Array.from({ length: 128 }, (_, n) => {
  const d = initProgram();
  setProgramName(d, `Sim ${slotName(n)}`);
  d[16 + 30] = n; // vary filter cutoff so programs differ
  return d;
});
let editBuffer = memory[0].slice();
let memoryProtect = false;
const ch = 1; // like the user's synth: global MIDI channel 2

// Port names as Chrome shows them on macOS: short names, with the manufacturer separate.
function fakeInput(id, name) {
  const listeners = new Set();
  return {
    id, name, manufacturer: 'KORG INC. (simulated)', state: 'connected', connection: 'closed',
    addEventListener: (type, fn) => { if (type === 'midimessage') listeners.add(fn); },
    async open() { this.connection = 'open'; return this; },
    onmidimessage: null,
    deliver(data) {
      if (this.connection !== 'open') return;
      const e = { data, timeStamp: performance.now() };
      listeners.forEach(fn => fn(e));
      this.onmidimessage?.(e); // real ports support both ways of listening
    },
  };
}
const input = fakeInput('sim-in', 'KBD/KNOB');
const dinIn = fakeInput('sim-din-in', 'MIDI IN');
const dinOut = { id: 'sim-din-out', name: 'MIDI OUT', manufacturer: 'KORG INC. (simulated)', state: 'connected', connection: 'open', async open() {}, send() {} };
const reply = bytes => setTimeout(() => input.deliver(Uint8Array.from(bytes)), 5);
const status = func => reply([0xf0, 0x42, 0x30 | ch, 0x7e, func, 0xf7]);

const output = {
  id: 'sim-out',
  name: 'SOUND',
  manufacturer: 'KORG INC. (simulated)',
  state: 'connected',
  connection: 'open',
  async open() {},
  send(bytes) {
    if (bytes[0] !== 0xf0) return;
    if (bytes[1] === 0x7e && bytes[3] === 0x06 && bytes[4] === 0x01) {
      reply([0xf0, 0x7e, ch, 0x06, 0x02, 0x42, 0x7e, 0x00, 0x00, 0x00, 0x04, 0x01, 0x01, 0x00, 0xf7]); // bytes as the real synth sends them
      return;
    }
    if (bytes[1] === 0x42 && bytes[2] === 0x50 && bytes[3] === 0x00) {
      reply([0xf0, 0x42, 0x50, 0x01, ch, bytes[4], 0x7e, 0x00, 0x00, 0x00, 0x04, 0x01, 0x01, 0x00, 0xf7]);
      return;
    }
    const m = parse(bytes);
    const func = bytes[4];
    if (func === 0x10) reply([0xf0, 0x42, 0x30 | ch, 0x7e, 0x40, ...encode8to7(editBuffer), 0xf7]);
    else if (func === 0x1c) reply(msg.programDump(ch, bytes[5], memory[bytes[5]]));
    else if (func === 0x11) {
      if (memoryProtect) status(0x22);
      else { memory[bytes[5]] = editBuffer.slice(); status(0x21); }
    } else if (m?.type === 'currentProgram') {
      if (m.data.length !== 346) status(0x26); else { editBuffer = m.data; status(0x23); }
    } else if (m?.type === 'program') {
      if (memoryProtect) status(0x24); else { memory[m.program] = m.data; status(0x23); }
    } else if (m?.type === 'param') status(applyParam(editBuffer, m.id, m.sub, m.value) ? 0x23 : 0x24);
  },
};

const access = {
  inputs: new Map([[dinIn.id, dinIn], [input.id, input]]),
  outputs: new Map([[dinOut.id, dinOut], [output.id, output]]),
  onstatechange: null,
};
navigator.requestMIDIAccess = async () => access;
window.fakeSynth = {
  memory, get editBuffer() { return editBuffer; },
  set memoryProtect(v) { memoryProtect = v; },
  // Simulate turning a knob on the hardware: the synth sends a Parameter Change.
  turnKnob(id, sub, value) { applyParam(editBuffer, id, sub, value); reply(msg.parameterChange(ch, id, sub, value)); },
  programChange(n) { editBuffer = memory[n].slice(); reply([0xc0 | ch, n]); },
  // Simulate playing the keyboard: velocity 0 releases the key. pedal(true/false) is the damper.
  key(note, vel = 100) { input.deliver(Uint8Array.from(vel ? [0x90 | ch, note, vel] : [0x80 | ch, note, 0])); },
  pedal(down) { input.deliver(Uint8Array.from([0xb0 | ch, 64, down ? 127 : 0])); },
};
