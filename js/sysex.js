// microKORG XL SysEx protocol, per Korg "microKORG XL MIDI Implementation" rev 1.01.
// Header for every model-specific message: F0 42 3g 7E <func> ... F7  (g = global MIDI channel)

export const KORG = 0x42;
export const MODEL_ID = 0x7e; // microKORG XL (original microKORG is 0x58, which is why MS2000-era tools don't apply)

export const FUNC = {
  CURRENT_PROGRAM_DUMP_REQUEST: 0x10,
  PROGRAM_DUMP_REQUEST: 0x1c,
  GLOBAL_DUMP_REQUEST: 0x0e,
  PROGRAM_WRITE_REQUEST: 0x11,
  CURRENT_PROGRAM_DUMP: 0x40,
  PROGRAM_DUMP: 0x4c,
  GLOBAL_DUMP: 0x51,
  PARAMETER_CHANGE: 0x41,
  DATA_FORMAT_ERROR: 0x26,
  DATA_LOAD_COMPLETED: 0x23,
  DATA_LOAD_ERROR: 0x24,
  WRITE_COMPLETED: 0x21,
  WRITE_ERROR: 0x22,
};

export const FUNC_NAMES = Object.fromEntries(Object.entries(FUNC).map(([k, v]) => [v, k]));

// Korg 7-bit packing: each group of up to 7 data bytes is preceded by a byte
// holding their top bits (bit i = bit 7 of data byte i).
export function decode7to8(midi) {
  const out = [];
  for (let i = 0; i < midi.length; i += 8) {
    const msbs = midi[i];
    for (let j = 0; j < 7 && i + 1 + j < midi.length; j++) {
      out.push(midi[i + 1 + j] | (((msbs >> j) & 1) << 7));
    }
  }
  return Uint8Array.from(out);
}

export function encode8to7(data) {
  const out = [];
  for (let i = 0; i < data.length; i += 7) {
    const chunk = data.slice(i, i + 7);
    let msbs = 0;
    chunk.forEach((b, j) => { msbs |= ((b >> 7) & 1) << j; });
    out.push(msbs, ...Array.from(chunk, b => b & 0x7f));
  }
  return out;
}

const header = ch => [0xf0, KORG, 0x30 | (ch & 0x0f), MODEL_ID];

export const msg = {
  deviceInquiry: () => [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7],
  searchDevice: (echo = 0x11) => [0xf0, KORG, 0x50, 0x00, echo & 0x7f, 0xf7],
  currentProgramRequest: ch => [...header(ch), FUNC.CURRENT_PROGRAM_DUMP_REQUEST, 0xf7],
  programRequest: (ch, prog) => [...header(ch), FUNC.PROGRAM_DUMP_REQUEST, prog & 0x7f, 0x00, 0xf7],
  globalRequest: ch => [...header(ch), FUNC.GLOBAL_DUMP_REQUEST, 0xf7],
  writeProgram: (ch, prog) => [...header(ch), FUNC.PROGRAM_WRITE_REQUEST, prog & 0x7f, 0x00, 0xf7],
  currentProgramDump: (ch, data) => [...header(ch), FUNC.CURRENT_PROGRAM_DUMP, ...encode8to7(data), 0xf7],
  programDump: (ch, prog, data) => [...header(ch), FUNC.PROGRAM_DUMP, prog & 0x7f, 0x00, ...encode8to7(data), 0xf7],
  // Byte order follows the byte table in the spec (LSB then MSB for each field).
  // Values are 14-bit signed.
  parameterChange: (ch, id, sub, value) => {
    const v = value & 0x3fff;
    return [...header(ch), FUNC.PARAMETER_CHANGE,
      id & 0x7f, (id >> 7) & 0x7f, sub & 0x7f, (sub >> 7) & 0x7f, v & 0x7f, (v >> 7) & 0x7f, 0xf7];
  },
};

const signed14 = v => (v & 0x2000 ? v - 0x4000 : v);

// Parse one complete SysEx message into a structured object, or null if it's not ours.
export function parse(bytes) {
  const b = Array.from(bytes);
  if (b[0] !== 0xf0 || b[b.length - 1] !== 0xf7) return null;
  if (b[1] === 0x7e && b[3] === 0x06 && b[4] === 0x02) {
    return {
      type: 'identity', channel: b[2] & 0x0f, manufacturer: b[5],
      family: b[6] | (b[7] << 7), member: b[8] | (b[9] << 7),
      version: `${b[12]}.${String(b[10]).padStart(2, '0')}`,
      isXL: b[5] === KORG && b[6] === MODEL_ID,
    };
  }
  // Korg "search device" reply: F0 42 50 01 0fgggg echo family(2) member(2) minor(2) major(2) F7
  if (b[1] === KORG && b[2] === 0x50 && b[3] === 0x01) {
    return {
      type: 'search', channel: b[4] & 0x0f, sysexFiltered: !!(b[4] & 0x10), isXL: b[6] === MODEL_ID,
      version: b.length >= 15 ? `${b[12]}.${String(b[10]).padStart(2, '0')}` : '',
    };
  }
  if (b[1] !== KORG || (b[2] & 0xf0) !== 0x30 || b[3] !== MODEL_ID) return null;
  const channel = b[2] & 0x0f;
  const func = b[4];
  const body = b.slice(5, -1);
  switch (func) {
    case FUNC.CURRENT_PROGRAM_DUMP:
      return { type: 'currentProgram', channel, data: decode7to8(body) };
    case FUNC.PROGRAM_DUMP:
      return { type: 'program', channel, program: body[0] | (body[1] << 7), data: decode7to8(body.slice(2)) };
    case FUNC.GLOBAL_DUMP:
      return { type: 'global', channel, data: decode7to8(body) };
    case FUNC.PARAMETER_CHANGE:
      return {
        type: 'param', channel, raw: body,
        id: body[0] | (body[1] << 7), sub: body[2] | (body[3] << 7),
        value: signed14(body[4] | (body[5] << 7)),
      };
    default:
      return { type: 'status', channel, func, name: FUNC_NAMES[func] || `0x${func.toString(16)}` };
  }
}

// Split a .syx file (or any byte stream) into individual F0..F7 messages.
export function splitSysex(bytes) {
  const out = [];
  let start = -1;
  bytes.forEach((byte, i) => {
    if (byte === 0xf0) start = i;
    else if (byte === 0xf7 && start >= 0) { out.push(bytes.slice(start, i + 1)); start = -1; }
  });
  return out;
}

export const hex = bytes => Array.from(bytes, x => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
