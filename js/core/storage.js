// Saving and loading the user's files: songs, Lab instruments, saved patterns and audio
// recordings. At home they go through serve.py into data/; in the travel version (core/mode.js)
// they're kept in this browser (IndexedDB). Same calls either way:
//
//   list(kind)                → [{ file, name, modified, ... }]   newest first (instruments: by name)
//   get(kind, file)           → the saved value (a song, a patch, a pattern; audio: a Blob)
//   save(kind, value, name?)  → the file name it was saved as     (audio: value = WAV bytes, name)
//   remove(kind, file)        → moved to deleted/ at home; gone in the browser
//   audioUrl(file)            → a URL an <audio> element can play
//
// kinds: 'sequences', 'instruments', 'patterns', 'audio'.
import { STATIC } from './mode.js';

// Same rule as serve.py's safe_stem.
export const stemOf = name => (String(name || '').replace(/[^A-Za-z0-9 _-]/g, '').trim() || 'SOUND').slice(0, 32);
const now = () => new Date().toISOString().slice(0, 19);

// ---- at home: serve.py ----

async function call(path, body) {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
const server = {
  list: kind => call(`api/${kind}`),
  async get(kind, file) {
    if (kind === 'sequences') { const r = await fetch(`sequences/${encodeURIComponent(file)}`); if (!r.ok) throw new Error(r.statusText); return r.json(); }
    if (kind === 'audio') return fetch(`audio/${encodeURIComponent(file)}`).then(r => r.blob());
    const item = (await server.list(kind)).find(x => x.file === file);
    if (!item) throw new Error('not found');
    return kind === 'instruments' ? item.patch : item;
  },
  async save(kind, value, name) {
    if (kind === 'audio') {
      const r = await fetch(`api/audio?name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: value });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || r.statusText);
      return j.file;
    }
    const key = { sequences: 'song', instruments: 'patch', patterns: 'pattern' }[kind];
    return (await call(`api/${kind}`, { [key]: value })).file;
  },
  remove: (kind, file) => call(`api/${kind}/delete`, { file }),
  audioUrl: async file => `audio/${encodeURIComponent(file)}`,
};

// ---- travel: IndexedDB in this browser ----

const KINDS = ['sequences', 'instruments', 'patterns', 'audio'];
let dbp = null;
function db() {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('mkxl', 1);
    req.onupgradeneeded = () => { for (const k of KINDS) if (!req.result.objectStoreNames.contains(k)) req.result.createObjectStore(k, { keyPath: 'file' }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}
async function tx(kind, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(kind, mode), st = t.objectStore(kind), req = fn(st);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}
const allOf = kind => tx(kind, 'readonly', st => st.getAll());
// A file name not used yet: "Name.json", "Name 2.json"... (audio: "Name (2).wav", like serve.py).
async function freeName(kind, stem, ext, style) {
  const used = new Set((await allOf(kind)).map(r => r.file));
  for (let n = 1; ; n++) {
    const f = n === 1 ? `${stem}${ext}` : style === 'paren' ? `${stem} (${n})${ext}` : `${stem} ${n}${ext}`;
    if (!used.has(f)) return f;
  }
}
const browser = {
  async list(kind) {
    const rows = await allOf(kind);
    const out = rows.map(r => {
      if (kind === 'audio') return { file: r.file, name: r.name, size: r.size, seconds: r.seconds, modified: r.modified };
      if (kind === 'instruments') return { file: r.file, name: r.name, patch: r.value, modified: r.modified };
      if (kind === 'patterns') return { ...r.value, id: `mine:${r.file}`, file: r.file, source: 'mine' };
      return { file: r.file, name: r.name, modified: r.modified };
    });
    return kind === 'instruments' ? out.sort((a, b) => a.name.localeCompare(b.name))
      : out.sort((a, b) => String(b.modified || b.created).localeCompare(String(a.modified || a.created)));
  },
  async get(kind, file) {
    const r = await tx(kind, 'readonly', st => st.get(file));
    if (!r) throw new Error('not found');
    return kind === 'audio' ? r.blob : r.value;
  },
  async save(kind, value, name) {
    if (kind === 'audio') {
      const stem = String(name || '').replace(/[^A-Za-z0-9 _\-()]/g, '').trim().slice(0, 60) || 'Recording';
      const file = await freeName('audio', stem, '.wav', 'paren'), bytes = value instanceof Blob ? value : new Blob([value], { type: 'audio/wav' });
      const head = new DataView(await bytes.slice(0, 44).arrayBuffer());
      const seconds = head.byteLength >= 44 ? head.getUint32(40, true) / head.getUint32(28, true) : 0;
      await tx('audio', 'readwrite', st => st.put({ file, name: file.replace(/\.wav$/, ''), size: bytes.size, seconds: Math.round(seconds * 100) / 100, modified: now(), blob: bytes }));
      return file;
    }
    if (kind === 'patterns') {
      const p = { ...value, name: String(value.name || 'Pattern').slice(0, 60), created: now() };
      const file = await freeName('patterns', stemOf(p.name), '.json');
      await tx('patterns', 'readwrite', st => st.put({ file, name: p.name, modified: p.created, value: p }));
      return file;
    }
    // Songs and instruments replace a file of the same name, as at home.
    const file = `${stemOf(value.name || 'Untitled')}.json`;
    await tx(kind, 'readwrite', st => st.put({ file, name: value.name, modified: now(), value }));
    return file;
  },
  remove: (kind, file) => tx(kind, 'readwrite', st => st.delete(file)),
  async audioUrl(file) { return URL.createObjectURL(await browser.get('audio', file)); },
};

export const storage = STATIC ? browser : server;
export const where = STATIC ? 'this browser' : 'data/';
// Where a kind of file is kept, for messages ("Saved to data/sequences/x.json").
export const placeOf = (kind, file) => (STATIC ? `this browser (${file})` : `data/${kind === 'patterns' ? 'my-patterns' : kind}/${file}`);
