// Prints the XL settings (AI value format) for Prophet programs, for tools/listen.py --patch.
//   node tools/prophet/audition.mjs 3-2
import { readFileSync } from 'node:fs';
import { convert } from './convert.mjs';
const sheets = JSON.parse(readFileSync(new URL('factory-1978.json', import.meta.url), 'utf8'));
const s = sheets.find(x => x.program === process.argv[2] || x.xlName === process.argv[2]);
if (!s) { console.error('no such program'); process.exit(1); }
console.log(JSON.stringify({ ...convert(s).changes, name: s.xlName }));
