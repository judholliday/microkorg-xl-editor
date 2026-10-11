// Builds a microKORG XL Current Program Dump from the init program plus changes in the AI value
// format (e.g. {"t1.osc1Wave":"Sine","t1.eg2R":40}) and prints it as hex, for tools/listen.py.
//   node tools/xlpatch.mjs '<changes json>' [channel]
import { initProgram } from '../js/xl/params.js';
import { applyAiChanges } from '../js/xl/aiparams.js';
import { msg } from '../js/xl/sysex.js';

const { name = 'TEST', ...changes } = JSON.parse(process.argv[2] || '{}');
const channel = +(process.argv[3] || 2);
const data = initProgram();
const { errors } = applyAiChanges(data, changes, name);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(msg.currentProgramDump(channel - 1, data).map(b => b.toString(16).padStart(2, '0')).join(''));
