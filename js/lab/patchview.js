// The Lab's patch diagram: modules as boxes, audio as solid cables flowing left to right into the
// output, modulation as dashed cables from envelopes, LFOs, velocity and the mod wheel below.
// Laid out automatically from the patch (nothing about positions is saved). Returns SVG text;
// the page (ui.js) handles clicks and drags using the data- attributes.
import { MODULES, SOURCES } from './patch.js';

export const BOX_W = 132, BOX_H = 46;
const COL_W = BOX_W + 64, ROW_H = BOX_H + 22, PAD = 18;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function layout(patch) {
  const byId = new Map(patch.modules.map(m => [m.id, m]));
  const isAudio = m => MODULES[m.type].audioOut || MODULES[m.type].audioIn;
  // Columns from the right: how many audio steps a module is from the output (the longest way).
  const dist = new Map([['out', 0]]);
  const far = (id, seen = new Set()) => {
    if (dist.has(id)) return dist.get(id);
    if (seen.has(id)) return -1;
    seen.add(id);
    let best = -1;
    for (const c of patch.audio) if (c.from === id) { const d = far(c.to, seen); if (d >= 0) best = Math.max(best, d + 1); }
    dist.set(id, best);
    return best;
  };
  const audio = patch.modules.filter(isAudio);
  audio.forEach(m => far(m.id));
  const maxD = Math.max(1, ...audio.map(m => dist.get(m.id)));
  const pos = new Map(), colRows = new Map();
  const place = (id, col) => {
    const row = colRows.get(col) || 0;
    colRows.set(col, row + 1);
    pos.set(id, { x: PAD + col * COL_W, y: PAD + row * ROW_H });
  };
  for (const m of audio) place(m.id, dist.get(m.id) < 0 ? 0 : maxD - dist.get(m.id)); // unconnected ones on the left
  place('out', maxD + 1);
  const rows = Math.max(...colRows.values());
  // Modulation sources in a band underneath, in the order they appear.
  const sources = [...patch.modules.filter(m => MODULES[m.type].modOut).map(m => m.id),
    ...Object.keys(SOURCES).filter(s => patch.mod.some(c => c.from === s))];
  const modY = PAD + rows * ROW_H + 26;
  sources.forEach((id, k) => pos.set(id, { x: PAD + k * (BOX_W + 16), y: modY }));
  const width = Math.max(PAD * 2 + (maxD + 2) * COL_W - 64, PAD * 2 + sources.length * (BOX_W + 16));
  const height = sources.length ? modY + BOX_H + PAD + 30 : PAD + rows * ROW_H + PAD - 22 + 8;
  return { pos, width, height, byId };
}

// Selected: { kind: 'audio' | 'mod', from, to } or null.
export function patchSVG(patch, { selected = null, focus = null } = {}) {
  const { pos, width, height, byId } = layout(patch);
  const label = id => (id === 'out' ? 'Output' : SOURCES[id]?.label || MODULES[byId.get(id)?.type]?.label || id);
  const cables = [];
  for (const c of patch.audio) {
    const a = pos.get(c.from), b = pos.get(c.to);
    if (!a || !b) continue;
    const x1 = a.x + BOX_W, y1 = a.y + BOX_H / 2, x2 = b.x, y2 = b.y + BOX_H / 2, dx = Math.max(30, (x2 - x1) / 2);
    const fm = byId.get(c.to)?.type === 'fmop';
    const sel = selected?.kind === 'audio' && selected.from === c.from && selected.to === c.to;
    const d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
    cables.push(`<g class="cable audio${fm ? ' fm' : ''}${sel ? ' sel' : ''}" data-kind="audio" data-from="${c.from}" data-to="${c.to}">
      <path class="hit" d="${d}"/><path class="line" d="${d}"/>${fm ? `<text x="${x2 - 18}" y="${y2 - 6}" class="clabel">FM</text>` : ''}</g>`);
  }
  patch.mod.forEach((c, i) => {
    const [tid, key] = c.to.split('.'), a = pos.get(c.from), b = pos.get(tid);
    if (!a || !b) return;
    const sel = selected?.kind === 'mod' && selected.from === c.from && selected.to === c.to;
    const x2 = b.x + BOX_W / 2 + ((i % 3) - 1) * 14;
    let d, lx, ly;
    if (b.y === a.y) {
      // Between two boxes in the bottom row (the mod wheel opening an LFO): an arc underneath.
      const x1 = a.x + BOX_W / 2 - 10, y = a.y + BOX_H;
      d = `M${x1},${y} C${x1},${y + 34} ${x2},${y + 34} ${x2},${y}`;
      lx = (x1 + x2) / 2; ly = y + 34;
    } else {
      const x1 = a.x + BOX_W / 2, y1 = a.y, y2 = b.y + BOX_H;
      d = `M${x1},${y1} C${x1},${y1 - 40} ${x2},${y2 + 40} ${x2},${y2}`;
      lx = x2 + 4; ly = y2 + 12;
    }
    cables.push(`<g class="cable mod${sel ? ' sel' : ''}${c.amount === 0 ? ' off' : ''}" data-kind="mod" data-from="${c.from}" data-to="${c.to}">
      <path class="hit" d="${d}"/><path class="line" d="${d}"/><text x="${lx}" y="${ly}" class="clabel">${esc(key)}</text></g>`);
  });
  const boxes = [...pos].map(([id, p]) => {
    const m = byId.get(id), spec = m && MODULES[m.type];
    const kind = id === 'out' ? 'out' : SOURCES[id] || spec?.modOut ? 'src' : spec.scope === 'global' ? 'fx' : 'voice';
    const hasOut = id !== 'out';
    return `<g class="box ${kind}${focus === id ? ' focus' : ''}" data-box="${id}" transform="translate(${p.x},${p.y})">
      <rect width="${BOX_W}" height="${BOX_H}" rx="8"/>
      <text x="10" y="19" class="bname">${esc(label(id))}</text>
      ${m ? `<text x="10" y="35" class="bid">${esc(id)}</text>` : ''}
      ${hasOut ? `<circle class="port" data-port="${id}" cx="${kind === 'src' ? BOX_W / 2 : BOX_W}" cy="${kind === 'src' ? 0 : BOX_H / 2}" r="6"><title>Drag to connect</title></circle>` : ''}
    </g>`;
  }).join('');
  return { svg: `<svg class="patch-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Patch diagram">
    <g class="cables">${cables.join('')}</g>${boxes}<path class="drag-line" d=""/></svg>`, pos };
}
