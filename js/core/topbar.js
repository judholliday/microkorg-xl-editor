// Shared top-bar buttons on every page: ● Recorder (or ⌥R), which opens the Recorder panel over
// the page (index.html shows it), and ⇅ Transfer, which exports or imports your songs, Lab
// instruments and patterns (core/transfer.js). In the travel version the XL editor tab is hidden.
import { STATIC } from './mode.js';
import { exportBundle, readBundle, importBundle } from './transfer.js';

const nav = document.querySelector('.app-nav');
if (nav && top !== self) {
  if (STATIC) nav.querySelector('[data-view="editor"]')?.remove();

  const rec = Object.assign(document.createElement('button'), { className: 'rec-btn', type: 'button', title: 'Recorder: your takes, audio, and recording with the sequencer (⌥R)' });
  rec.innerHTML = '<span class="dot">●</span> Recorder';
  const xfer = Object.assign(document.createElement('button'), { className: 'xfer-btn ghost', type: 'button', textContent: '⇅ Transfer',
    title: 'Move your songs, Lab instruments and patterns between home and the travel version' });
  nav.after(rec, xfer);

  const toggle = () => parent.postMessage({ type: 'toggle-recorder' }, location.origin);
  rec.onclick = toggle;
  addEventListener('keydown', e => { if (e.altKey && e.code === 'KeyR') { e.preventDefault(); toggle(); } });
  addEventListener('message', e => {
    if (e.origin === location.origin && e.data?.type === 'recorder-state') rec.classList.toggle('on', !!e.data.open);
  });
  parent.postMessage({ type: 'recorder-hello' }, location.origin);

  // The Transfer dialog.
  const dlg = document.createElement('dialog');
  dlg.className = 'xfer-dialog';
  dlg.innerHTML = `
    <h3>⇅ Transfer</h3>
    <p>${STATIC
      ? 'This is the travel version: your work is kept in this browser. <b>Export</b> it to a file to bring home, and <b>Import</b> a file exported at home.'
      : 'Take your work with you: <b>Export</b> your songs, Lab instruments and saved patterns to a file and open it in the travel version. Back home, <b>Import</b> the file exported there.'}</p>
    <p class="hint">Songs and instruments replace ones with the same name; patterns you already have aren't added twice. XL sounds and recordings aren't included.</p>
    <div class="xfer-row">
      <button class="accent" data-x="export">Export…</button>
      <label class="xfer-import"><input type="file" accept=".json,application/json" hidden> <span class="btn-like">Import…</span></label>
      <span class="spacer"></span>
      <button class="ghost" data-x="close">Close</button>
    </div>
    <p class="xfer-msg"></p>`;
  document.body.append(dlg);
  const msg = (text, kind = '') => { const el = dlg.querySelector('.xfer-msg'); el.textContent = text; el.className = `xfer-msg ${kind}`; };
  xfer.onclick = () => { msg(''); dlg.showModal(); };
  dlg.addEventListener('click', async e => {
    const x = e.target.closest('[data-x]')?.dataset.x;
    if (x === 'close' || e.target === dlg) dlg.close();
    if (x === 'export') {
      try {
        const { name, counts } = await exportBundle();
        const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
        msg(`Downloaded "${name}": ${n(counts.songs, 'song')}, ${n(counts.instruments, 'instrument')}, ${n(counts.patterns, 'pattern')}.`, 'ok');
      } catch (err) { msg(`Couldn't export: ${err.message}`, 'err'); }
    }
  });
  dlg.querySelector('input[type=file]').onchange = async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { bundle, summary: s } = await readBundle(file);
      const parts = [`${s.songs} song${s.songs === 1 ? '' : 's'}${s.songsReplacing ? ` (${s.songsReplacing} replacing ones with the same name)` : ''}`,
        `${s.instruments} instrument${s.instruments === 1 ? '' : 's'}${s.instrumentsReplacing ? ` (${s.instrumentsReplacing} replacing)` : ''}`,
        `${s.patterns} new pattern${s.patterns === 1 ? '' : 's'}${s.patternsSkipped ? ` (${s.patternsSkipped} already here)` : ''}`];
      if (!confirm(`Import ${parts.join(', ')}?`)) return;
      await importBundle(bundle);
      msg(`Imported ${parts.join(', ')}.`, 'ok');
    } catch (err) { msg(err.message, 'err'); }
  };
}
