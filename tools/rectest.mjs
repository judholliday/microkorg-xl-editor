// Offline checks for the Recorder's audio helpers: node tools/rectest.mjs (also run by selftest.mjs)
import assert from 'node:assert/strict';
import { cut, encodeWav, findOnset } from '../js/rec/audio.js';

// findOnset: the first sample clearly above the noise before the expected time.
{
  const a = new Float32Array(10000);
  for (let i = 0; i < a.length; i++) a[i] = (Math.sin(i * 12.9898) * 43758.5453 % 1) * 0.002; // quiet noise
  for (let i = 6000; i < 7000; i++) a[i] = Math.sin(i / 5) * 0.5;
  const at = findOnset([a], 5000);
  assert.ok(at >= 6000 && at < 6010, `onset ${at}`);
  assert.equal(findOnset([new Float32Array(5000)], 3000), -1, 'silence: none');
}
// cut: absolute frames, padded with silence either side.
{
  const rec = { frame: 1000, chans: [Float32Array.from([1, 2, 3, 4])] };
  assert.deepEqual([...cut(rec, 998, 8)[0]], [0, 0, 1, 2, 3, 4, 0, 0]);
  assert.deepEqual([...cut(rec, 1002, 2)[0]], [3, 4]);
}
// encodeWav: 24-bit PCM header and samples.
{
  const w = encodeWav([Float32Array.from([0, 1, -1, 0.5]), Float32Array.from([0, 0, 0, 0])], 48000);
  const v = new DataView(w.buffer), str = (o, n) => String.fromCharCode(...w.slice(o, o + n));
  assert.equal(str(0, 4) + str(8, 4) + str(36, 4), 'RIFFWAVEdata');
  assert.deepEqual([v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint16(34, true)], [1, 2, 48000, 24]);
  assert.equal(v.getUint32(40, true), 4 * 2 * 3);
  const s24 = o => { const x = w[o] | w[o + 1] << 8 | w[o + 2] << 16; return x & 0x800000 ? x - 0x1000000 : x; };
  assert.deepEqual([s24(44 + 6), s24(44 + 12), s24(44 + 18)], [0x7fffff, -0x800000, Math.round(0.5 * 0x7fffff)]);
}
console.log('ok — Recorder audio');
