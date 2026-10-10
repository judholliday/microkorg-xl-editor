// Reader for files saved by Korg's microKORG XL Sound Editor (e.g. *.mkxl_all).
//
// They are a flat sequence of chunks, each with a 32-byte header:
//   +0  8 bytes  tag: 4-digit model code + type, e.g. "6140AllD", "6140PrgS", "6140PrgD", "6140GlbD", "6140LibP"
//   +8  u16 LE   header size (0x20)
//   +10 u16 LE   payload size
// A "6140PrgD" payload (496 bytes) starts with the 346-byte program exactly as in a SysEx
// program dump (Table 1 of the MIDI Implementation), followed by editor metadata:
//   +0x180  bank/library label, e.g. "MKXL Preset"
//   +0x198  category, e.g. "Vintage" (empty in the converted microKORG/MS2000 banks)

import { PROGRAM_SIZE } from './params.js';

// Tags start with a 4-digit model code ("6140" for the XL); accept any digits so XL+ editor files work too.
const isDigit = c => c >= 0x30 && c <= 0x39;
const isTagAt = (b, i) => [0, 1, 2, 3].every(k => isDigit(b[i + k]));
const ascii = (b, start, len) => {
  const end = b.indexOf(0, start);
  const s = b.subarray(start, end >= 0 && end < start + len ? end : start + len);
  return String.fromCharCode(...s).replace(/[^\x20-\x7e]/g, '').trim();
};

export function isKorgEditorFile(bytes) {
  return bytes.length >= 32 && isTagAt(bytes, 0);
}

export function parseKorgEditorFile(bytes) {
  const programs = [];
  let i = 0;
  while (i + 32 <= bytes.length) {
    if (!isTagAt(bytes, i)) break;
    const tag = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
    const headerSize = bytes[i + 8] | (bytes[i + 9] << 8);
    const size = bytes[i + 10] | (bytes[i + 11] << 8);
    if (headerSize < 12) break;
    const body = i + headerSize;
    if (tag === 'PrgD' && size >= PROGRAM_SIZE && body + size <= bytes.length) {
      programs.push({
        data: bytes.slice(body, body + PROGRAM_SIZE),
        category: size > 0x198 ? ascii(bytes, body + 0x198, 32) : '',
        library: size > 0x180 ? ascii(bytes, body + 0x180, 24) : '',
      });
    }
    // Container chunks (AllD, PrgS) only have a header; their contents follow as sibling chunks.
    i = body + (tag === 'AllD' || tag === 'PrgS' ? 0 : size);
  }
  return programs;
}
