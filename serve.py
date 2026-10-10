#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = ["anthropic>=1.11,<2", "openai>=3,<4"]
# ///
"""Local server for the microKORG XL Editor.

Start it with `uv run serve.py` (Start Editor.command does this): uv installs the Python and the
packages listed above, which the API AI providers need. `python3 serve.py` works too, with Claude
Code as the only AI provider.

Serves the editor on http://localhost:8765 (Web MIDI needs a localhost origin) and adds:
  GET  /api/presets  list of preset files in presets/
  GET  /api/status   whether the chosen AI provider is ready
  GET  /api/ai-settings, POST /api/ai-settings, GET /api/ai-models?provider=<id>
                     AI provider settings (settings.local.json; keys are never sent back)
  POST /api/design   run the AI sound designer; streams progress as newline-delimited JSON
  GET  /api/designs  recent AI designs, read from ai-designs/ (one JSON file per request)
  POST /api/designs/hide  hide (or restore) one of them; the flag is stored in its file
  GET  /api/my-sounds, POST /api/my-sounds, POST /api/my-sounds/delete
                     the user's own sound collection, stored as .syx files in my-sounds/
  GET  /api/types, POST /api/types
                     sound types the user assigned in the Presets tab (presets/sound-types.json)
  GET  /api/sequences, POST /api/sequences, POST /api/sequences/delete
                     sequencer songs, stored as JSON in sequences/ (files are read as /sequences/<file>)
  POST /api/pattern  have the AI write sequencer patterns for one track; streams like /api/design
  GET  /api/patterns, POST /api/patterns, POST /api/patterns/delete
                     the user's saved patterns (the sequencer's library), one JSON per pattern in my-patterns/

The AI features use the provider chosen in AI settings (see ai_providers.py): Claude Code with
your own login, the Anthropic API, or an OpenAI-compatible API. They may only read the reference
files in ai/ and search the web; they cannot edit files or run commands.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

import ai_providers as providers
from ai_providers import DATA, tool_env

ROOT = Path(__file__).resolve().parent
PRESETS = ROOT / 'presets'
AI = ROOT / 'ai'
# The user's files, in DATA (data/ by default; see ai_providers.py and init_data()).
MY_SOUNDS = DATA / 'my-sounds'
USER_TYPES = DATA / 'sound-types.json'
HIDDEN_DESIGNS = DATA / 'hidden-designs.json'  # old hide list; folded into ai-designs/ files
AI_DESIGNS = DATA / 'ai-designs'
SEQUENCES = DATA / 'sequences'
MY_PATTERNS = DATA / 'my-patterns'
DATA_FOLDERS = ('my-sounds', 'sequences')  # served to the page at /my-sounds/<file>, /sequences/<file>
# Claude Code keeps each session's transcript under ~/.claude/projects/<working dir with
# non-alphanumerics replaced by "-">/<session id>.jsonl; the AI designer runs in ai/.
SESSIONS = Path.home() / '.claude' / 'projects' / re.sub(r'[^A-Za-z0-9]', '-', str(AI))
PORT = int(os.environ.get('MKXL_PORT', '8765'))
PRESET_EXTS = ('.mkxl_all', '.mkxlp_all', '.syx')
DESIGN_TIMEOUT = 360  # seconds
PATTERN_TIMEOUT = 240
PATTERN_PROMPT = ROOT / 'tools' / 'pattern_prompt.md'

DESIGN_ITEM = {
    'type': 'object',
    'properties': {
        'base': {'type': 'string', 'description': '"current", "init", or "<bank>/<preset name>"'},
        'name': {'type': 'string', 'maxLength': 8},
        'changes': {'type': 'object', 'additionalProperties': {'type': ['string', 'number']}},
        'summary': {'type': 'string'},
    },
    'required': ['base', 'name', 'changes', 'summary'],
}
MAX_VARIATIONS = 4
# API providers can't return an open-ended map, so they give changes as a list of pairs.
API_DESIGN_ITEM = {
    'type': 'object',
    'properties': {
        'base': DESIGN_ITEM['properties']['base'],
        'name': DESIGN_ITEM['properties']['name'],
        'changes': {'type': 'array', 'description': 'Every parameter to change: key and value (as text, e.g. "64" or "Saw")',
                    'items': {'type': 'object', 'properties': {'param': {'type': 'string'}, 'value': {'type': 'string'}},
                              'required': ['param', 'value']}},
        'summary': {'type': 'string'},
    },
    'required': ['base', 'name', 'changes', 'summary'],
}


def design_schemas(n):
    """(Claude Code schema, API schema, convert) for an answer with n variations."""
    def wrap(item):
        if n == 1:
            return item
        return {'type': 'object', 'required': ['variations'],
                'properties': {'variations': {'type': 'array', 'items': item, 'minItems': n, 'maxItems': n}}}

    def to_map(item):
        changes = {}
        for c in item.get('changes') or []:
            v = str(c.get('value', '')).strip()
            changes[str(c.get('param', ''))] = (float(v) if '.' in v else int(v)) if re.fullmatch(r'-?\d+(\.\d+)?', v) else v
        return {**item, 'changes': changes}

    def convert(answer):
        return {'variations': [to_map(i) for i in answer['variations']]} if n > 1 else to_map(answer)
    return wrap(DESIGN_ITEM), wrap(API_DESIGN_ITEM), convert


def pattern_schema(n, names, pool):
    """n options, each filling the named patterns (and a note pool for note-pool tracks)."""
    step = {
        'type': 'object',
        'properties': {
            'i': {'type': 'integer', 'minimum': 0, 'maximum': 63},
            'notes': {'type': 'array', 'items': {'type': 'integer', 'minimum': 0, 'maximum': 127}, 'maxItems': 8},
            'vel': {'type': 'integer', 'minimum': 1, 'maximum': 127},
            'gate': {'type': 'integer', 'minimum': 1, 'maximum': 100},
            'len': {'type': 'integer', 'minimum': 1, 'maximum': 64},
        },
        'required': ['i', 'notes', 'vel', 'gate', 'len'],
    }
    option = {
        'type': 'object',
        'properties': {
            'summary': {'type': 'string'},
            'patterns': {
                'type': 'array', 'minItems': len(names), 'maxItems': len(names),
                'items': {'type': 'object', 'required': ['name', 'steps'], 'properties': {
                    'name': {'type': 'string', 'enum': names},
                    'steps': {'type': 'array', 'items': step, 'maxItems': 64}}},
            },
        },
        'required': ['summary', 'patterns'],
    }
    if pool:
        option['properties']['pool'] = {'type': 'array', 'items': {'type': 'integer', 'minimum': 0, 'maximum': 127},
                                        'minItems': 1, 'maxItems': 8}
        option['required'].append('pool')
    return {'type': 'object', 'required': ['options'], 'properties': {
        'options': {'type': 'array', 'items': option, 'minItems': n, 'maxItems': n}}}


def ensure_ai_reference():
    """Rebuild ai/ when presets or the parameter code are newer than the generated files."""
    target = AI / 'system.md'
    sources = [*PRESETS.glob('*'), *MY_SOUNDS.glob('*.syx'), *(ROOT / 'js').glob('*.js'),
               ROOT / 'tools/build_ai_reference.mjs', USER_TYPES]
    if MY_SOUNDS.exists():
        sources.append(MY_SOUNDS)  # directory mtime changes when a sound is deleted
    newest = max((p.stat().st_mtime for p in sources if p.exists()), default=0)
    if target.exists() and target.stat().st_mtime >= newest:
        return None
    node = shutil.which('node', path=tool_env()['PATH'])
    if not node:
        return 'Node.js is needed to prepare the AI reference files but was not found.'
    r = subprocess.run([node, str(ROOT / 'tools/build_ai_reference.mjs')], cwd=ROOT, capture_output=True, text=True,
                       env={**tool_env(), 'MKXL_DATA': str(DATA)})
    return None if r.returncode == 0 else f'Preparing the AI reference failed: {r.stderr.strip()[:300]}'


# ---- the data folder: the user's files, in their own git repo ----

DATA_GITIGNORE = '''# Kept out of git: removed items (the deleted/ folders are a safety net), and the AI
# settings, which hold API keys.
deleted/
settings.local.json
'''


def data_git(*args):
    return subprocess.run(['git', '-C', str(DATA), *args], capture_output=True, text=True)


def init_data():
    """Creates the data folder, with its own git repo, the first time the server starts."""
    DATA.mkdir(parents=True, exist_ok=True)
    if not (DATA / '.gitignore').exists():
        (DATA / '.gitignore').write_text(DATA_GITIGNORE)
    if shutil.which('git') and not (DATA / '.git').exists():
        data_git('init', '-q')
        commit_data_now('Start the data repo')


_commit_lock = threading.Lock()
_commit_timer = None
_pending_commits = []


def commit_data(message):
    """Commits the data folder shortly after a save; saves close together become one commit.
    Local only: nothing is ever pushed."""
    global _commit_timer
    with _commit_lock:
        _pending_commits.append(message)
        if _commit_timer:
            _commit_timer.cancel()
        _commit_timer = threading.Timer(2.0, _commit_pending)
        _commit_timer.daemon = True
        _commit_timer.start()


def _commit_pending():
    with _commit_lock:
        messages = list(dict.fromkeys(_pending_commits))
        _pending_commits.clear()
    if messages:
        commit_data_now('; '.join(messages) if len(messages) <= 3 else f'{messages[0]} (and {len(messages) - 1} more changes)')


def commit_data_now(message):
    if not shutil.which('git') or not (DATA / '.git').exists():
        return
    data_git('add', '-A')
    if data_git('diff', '--cached', '--quiet').returncode == 0:
        return  # nothing changed
    ident = [] if data_git('config', 'user.email').stdout.strip() else [
        '-c', 'user.name=microKORG XL Editor', '-c', 'user.email=editor@localhost']
    r = subprocess.run(['git', '-C', str(DATA), *ident, 'commit', '-q', '-m', message], capture_output=True, text=True)
    if r.returncode:
        sys.stderr.write(f'Committing the data folder failed: {r.stderr.strip()}\n')


def session_designs(limit=200):
    """AI designs read back from Claude Code's session files. Only used once, to copy designs made
    before ai-designs/ existed into it (see import_session_designs).

    Each request the page sends contains <request>...</request> and the editor's settings at the
    time; the answer is the StructuredOutput tool call that follows it. Resumed sessions (Refine)
    append to the same file, so one file can hold several designs."""
    designs = []
    files = sorted(SESSIONS.glob('*.jsonl'), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
    for f in files:
        pending = None
        try:
            lines = f.read_text(errors='replace').splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            content = (ev.get('message') or {}).get('content')
            if ev.get('type') == 'user' and isinstance(content, str) and '<request>' in content:
                if pending:
                    designs.append(pending)
                req = content.split('<request>', 1)[1].split('</request>', 1)[0].strip()
                current = None
                marker = 'refers to this):\n'
                if marker in content:
                    try:
                        current = json.loads(content.split(marker, 1)[1].strip().splitlines()[0])
                    except (ValueError, IndexError):
                        pass
                pending = {'session_id': f.stem, 'time': ev.get('timestamp'), 'request': req,
                           'mode': 'refine' if 'refine the current sound' in content else 'new',
                           'current': current, 'output': None}
            elif ev.get('type') == 'assistant' and isinstance(content, list) and pending:
                for c in content:
                    if c.get('type') == 'tool_use' and c.get('name') == 'StructuredOutput':
                        out = c.get('input') or {}
                        variants = out.get('variations') if isinstance(out.get('variations'), list) else None
                        if variants:
                            for i, v in enumerate(variants):
                                designs.append({**pending, 'output': v, 'variant': i + 1, 'of': len(variants)})
                        else:
                            designs.append({**pending, 'output': out})
                        pending = None
                        break
        if pending:
            designs.append(pending)
    designs.sort(key=lambda d: (d.get('time') or '', -(d.get('variant') or 0)), reverse=True)
    return designs[:limit]


# ---- AI designs: one JSON file per request in ai-designs/ ----
# { time, request, mode: 'new'|'refine', variations, current (the settings sent with the request),
#   session_id (lets Modify continue the conversation), status: 'running'|'done'|'error', error,
#   results: [{ base, name, changes, summary, hidden }] }

def new_design_file(req, message, mode, n):
    AI_DESIGNS.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime('%Y-%m-%d %H%M%S')
    slug = safe_stem(re.sub(r'\s+', ' ', message)[:40]) or 'design'
    path, k = AI_DESIGNS / f'{stamp} {slug}.json', 2
    while path.exists():
        path, k = AI_DESIGNS / f'{stamp} {slug} {k}.json', k + 1
    write_design(path, {'time': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'request': message, 'mode': mode,
                        'variations': n, 'current': req.get('current'), 'session_id': None,
                        'status': 'running', 'results': []})
    return path


def write_design(path, design):
    tmp = path.with_name(f'.{path.stem}.{threading.get_ident()}.tmp')  # unique per thread
    tmp.write_text(json.dumps(design, indent=1) + '\n')
    tmp.replace(path)


def read_design(path):
    try:
        d = json.loads(path.read_text())
        return d if isinstance(d, dict) else None
    except (OSError, ValueError):
        return None


def recent_designs(limit=60):
    """Designs from ai-designs/, newest first, one entry per variation (as the page lists them)."""
    import_session_designs()
    out = []
    for f in sorted(AI_DESIGNS.glob('*.json'), reverse=True)[:limit]:
        d = read_design(f)
        if not d:
            continue
        base = {'key': f'{f.name}|0', 'file': f.name, 'session_id': d.get('session_id'), 'time': d.get('time'),
                'request': d.get('request') or '', 'mode': d.get('mode') or 'new', 'current': d.get('current'),
                'status': d.get('status'), 'error': d.get('error')}
        results = [r for r in d.get('results') or [] if isinstance(r, dict)]
        if not results:
            # Still running, or it stopped without an answer; a stale "running" means the server stopped.
            out.append({**base, 'output': None})
            continue
        for i, r in enumerate(results):
            entry = {**base, 'key': f'{f.name}|{i}', 'output': {k: v for k, v in r.items() if k != 'hidden'},
                     'hidden': bool(r.get('hidden'))}
            if len(results) > 1:
                entry.update(variant=i + 1, of=len(results))
            out.append(entry)
    return out


def conversation_so_far(session):
    """Earlier requests in a design conversation, for providers that don't keep sessions."""
    if not session:
        return ''
    turns = []
    for f in sorted(AI_DESIGNS.glob('*.json')):
        d = read_design(f)
        if d and d.get('session_id') == session and d.get('results'):
            names = ', '.join(r.get('name', '?') for r in d['results'])
            turns.append(f"- {'Refine' if d.get('mode') == 'refine' else 'New sound'}: {d.get('request', '')} → {names}")
    if not turns:
        return ''
    return 'Earlier in this conversation (the current program reflects the last answer):\n' + '\n'.join(turns[-8:]) + '\n\n'


def hide_design(req):
    """Removes one variation from Recent designs (or restores it): a flag in its file."""
    key = req.get('key')
    if not isinstance(key, str) or '|' not in key:
        raise ValueError('bad key')
    name, _, idx = key.rpartition('|')
    path = AI_DESIGNS / name
    d = read_design(path) if path.parent == AI_DESIGNS and path.suffix == '.json' else None
    if not d or not idx.isdigit() or int(idx) >= len(d.get('results') or []):
        raise ValueError('no such design')
    d['results'][int(idx)]['hidden'] = bool(req.get('hidden', True))
    write_design(path, d)
    name = d['results'][int(idx)].get('name', '?')
    commit_data(f"{'Hide' if req.get('hidden', True) else 'Restore'} AI design {name}")


import_lock = threading.Lock()


def import_session_designs():
    """Copies designs made before ai-designs/ existed out of Claude Code's session files, once."""
    marker = AI_DESIGNS / '.imported'
    if marker.exists():
        return
    with import_lock:
        if not marker.exists():
            _import_session_designs(marker)


def _import_session_designs(marker):
    AI_DESIGNS.mkdir(exist_ok=True)
    try:
        hidden = set(json.loads(HIDDEN_DESIGNS.read_text()))
    except (OSError, ValueError, TypeError):
        hidden = set()
    groups = {}
    for d in session_designs():
        if not d.get('output'):
            continue
        g = groups.setdefault((d['session_id'], d['time']), {**d, 'results': []})
        old_key = f"{d.get('session_id')}|{d.get('time')}|{d.get('variant') or 0}"
        g['results'].append({**d['output'], 'hidden': old_key in hidden})
    for (session, when), g in groups.items():
        stamp = re.sub(r'[^0-9T]', '', (when or '')[:19]).replace('T', ' ')
        stamp = f'{stamp[:4]}-{stamp[4:6]}-{stamp[6:8]} {stamp[9:15]}' if len(stamp) >= 15 else 'imported'
        path = AI_DESIGNS / f"{stamp} {safe_stem(g['request'][:40]) or 'design'}.json"
        if path.exists():
            continue
        write_design(path, {'time': when, 'request': g['request'], 'mode': g['mode'], 'variations': len(g['results']),
                            'current': g.get('current'), 'session_id': session, 'status': 'done',
                            'results': g['results'], 'imported_from': 'Claude Code session'})
    marker.write_text('Designs from Claude Code sessions were copied here.\n')
    if HIDDEN_DESIGNS.exists():
        HIDDEN_DESIGNS.unlink()


def safe_stem(name):
    stem = re.sub(r'[^A-Za-z0-9 _\-]', '', name or '').strip() or 'SOUND'
    return stem[:32]


def list_my_sounds():
    out = []
    for f in sorted(MY_SOUNDS.glob('*.syx')):
        meta = {}
        side = f.with_suffix('.json')
        if side.exists():
            try:
                meta = json.loads(side.read_text())
            except ValueError:
                pass
        out.append({'file': f.name, 'name': meta.get('name') or f.stem, 'created': meta.get('created'),
                    'request': meta.get('request'), 'summary': meta.get('summary')})
    out.sort(key=lambda m: m.get('created') or '', reverse=True)
    return out


def save_my_sound(req):
    data = req.get('syx')
    if not (isinstance(data, list) and 8 < len(data) < 1000 and all(isinstance(b, int) and 0 <= b <= 255 for b in data)
            and data[0] == 0xF0 and data[1] == 0x42 and data[3] == 0x7E and data[4] == 0x40 and data[-1] == 0xF7):
        raise ValueError('not a microKORG XL program dump')
    MY_SOUNDS.mkdir(parents=True, exist_ok=True)
    stem = safe_stem(req.get('name'))
    path, n = MY_SOUNDS / f'{stem}.syx', 2
    while path.exists():
        path, n = MY_SOUNDS / f'{stem} {n}.syx', n + 1
    path.write_bytes(bytes(data))
    meta = {'name': str(req.get('name') or stem)[:8], 'created': time.strftime('%Y-%m-%dT%H:%M:%S'),
            'request': (req.get('request') or None), 'summary': (req.get('summary') or None)}
    path.with_suffix('.json').write_text(json.dumps(meta, indent=1))
    commit_data(f"Add sound {meta['name']}")
    return path.name


def read_user_types():
    try:
        data = json.loads(USER_TYPES.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def set_user_type(req):
    key, kind = req.get('key'), req.get('type')
    if not isinstance(key, str) or not 0 < len(key) < 200:
        raise ValueError('bad key')
    types = read_user_types()
    if kind:
        if not isinstance(kind, str) or len(kind.strip()) > 40:
            raise ValueError('bad type')
        types[key] = kind.strip()
    else:
        types.pop(key, None)
    DATA.mkdir(parents=True, exist_ok=True)
    USER_TYPES.write_text(json.dumps(dict(sorted(types.items())), indent=1) + '\n')
    commit_data(f'Set the type of {key} to {kind.strip()}' if kind else f'Reset the type of {key}')
    return types


def delete_my_sound(name):
    """Moves the sound into my-sounds/deleted/ rather than erasing it."""
    path = MY_SOUNDS / str(name)
    if path.parent != MY_SOUNDS or path.suffix != '.syx' or not path.is_file():
        raise ValueError('no such sound')
    trash = MY_SOUNDS / 'deleted'
    trash.mkdir(exist_ok=True)
    for f in (path, path.with_suffix('.json')):
        if f.exists():
            f.replace(trash / f.name)
    commit_data(f'Remove sound {path.stem}')


def list_sequences():
    out = []
    for f in SEQUENCES.glob('*.json'):
        try:
            song = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        out.append({'file': f.name, 'name': song.get('name') or f.stem,
                    'modified': time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(f.stat().st_mtime))})
    out.sort(key=lambda m: m['modified'], reverse=True)
    return out


def save_sequence(req):
    """Saves a song as sequences/<name>.json, replacing a file of the same name."""
    song = req.get('song')
    if not isinstance(song, dict) or song.get('format') != 'mkxl-seq' or not isinstance(song.get('tracks'), list):
        raise ValueError('not a sequencer song')
    SEQUENCES.mkdir(parents=True, exist_ok=True)
    path = SEQUENCES / f"{safe_stem(song.get('name') or 'Untitled')}.json"
    path.write_text(json.dumps(song, indent=1) + '\n')
    commit_data(f"Save song {song.get('name') or path.stem}")
    return path.name


def delete_sequence(name):
    """Moves the song into sequences/deleted/ rather than erasing it."""
    path = SEQUENCES / str(name)
    if path.parent != SEQUENCES or path.suffix != '.json' or not path.is_file():
        raise ValueError('no such song')
    trash = SEQUENCES / 'deleted'
    trash.mkdir(exist_ok=True)
    path.replace(trash / path.name)
    commit_data(f'Remove song {path.stem}')


def list_my_patterns():
    out = []
    for f in MY_PATTERNS.glob('*.json'):
        try:
            p = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        if isinstance(p, dict) and isinstance(p.get('steps'), list):
            out.append({**p, 'id': f'mine:{f.name}', 'file': f.name, 'source': 'mine'})
    out.sort(key=lambda p: p.get('created') or '', reverse=True)
    return out


def save_my_pattern(req):
    p = req.get('pattern')
    if not isinstance(p, dict) or not isinstance(p.get('steps'), list) or len(json.dumps(p)) > 200_000:
        raise ValueError('not a pattern')
    keep = ('name', 'role', 'tags', 'bpm', 'rate', 'mode', 'key', 'length', 'steps', 'pool')
    p = {k: p[k] for k in keep if k in p}
    p['name'] = str(p.get('name') or 'Pattern')[:60]
    p['created'] = time.strftime('%Y-%m-%dT%H:%M:%S')
    MY_PATTERNS.mkdir(parents=True, exist_ok=True)
    stem = safe_stem(p['name'])
    path, n = MY_PATTERNS / f'{stem}.json', 2
    while path.exists():
        path, n = MY_PATTERNS / f'{stem} {n}.json', n + 1
    path.write_text(json.dumps(p, indent=1) + '\n')
    commit_data(f"Save pattern {p['name']}")
    return path.name


def delete_my_pattern(name):
    """Moves the pattern into my-patterns/deleted/ rather than erasing it."""
    path = MY_PATTERNS / str(name)
    if path.parent != MY_PATTERNS or path.suffix != '.json' or not path.is_file():
        raise ValueError('no such pattern')
    trash = MY_PATTERNS / 'deleted'
    trash.mkdir(exist_ok=True)
    path.replace(trash / path.name)
    commit_data(f'Remove pattern {path.stem}')


design_lock = threading.Lock()
pattern_lock = threading.Lock()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, fmt, *args):
        if '/api/' in (self.path or ''):
            sys.stderr.write('%s %s\n' % (self.log_date_time_string(), fmt % args))

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    # Only pages served from this server may call the API (blocks other websites and DNS rebinding).
    def _trusted(self):
        host = (self.headers.get('Host') or '').split(':')[0]
        if host not in ('localhost', '127.0.0.1'):
            return False
        origin = self.headers.get('Origin')
        if self.command == 'POST':
            return origin in (f'http://localhost:{PORT}', f'http://127.0.0.1:{PORT}')
        return origin is None or origin in (f'http://localhost:{PORT}', f'http://127.0.0.1:{PORT}')

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/api/'):
            if not self._trusted():
                return self._json(403, {'error': 'forbidden'})
            if self.path == '/api/presets':
                files = sorted(p for p in PRESETS.glob('*') if p.suffix.lower() in PRESET_EXTS)
                return self._json(200, [{'file': p.name, 'bank': p.stem} for p in files])
            if self.path == '/api/status':
                ready, problem = providers.available()
                return self._json(200, {'ai': ready, 'problem': problem, 'provider': providers.provider_label()})
            if self.path == '/api/ai-settings':
                return self._json(200, providers.public_settings())
            if self.path.startswith('/api/ai-models'):
                provider = (parse_qs(urlsplit(self.path).query).get('provider') or [''])[0]
                if provider not in providers.PROVIDERS:
                    return self._json(400, {'error': 'unknown provider'})
                try:
                    return self._json(200, {'models': providers.list_models(provider)})
                except Exception as e:  # shown to the user in the settings panel
                    return self._json(502, {'error': str(e)[:400]})
            if self.path == '/api/designs':
                return self._json(200, recent_designs())
            if self.path == '/api/my-sounds':
                return self._json(200, list_my_sounds())
            if self.path == '/api/types':
                return self._json(200, read_user_types())
            if self.path == '/api/sequences':
                return self._json(200, list_sequences())
            if self.path == '/api/patterns':
                return self._json(200, list_my_patterns())
            return self._json(404, {'error': 'not found'})
        parts = unquote(urlsplit(self.path).path).strip('/').split('/')
        # The user's sounds and songs are fetched by the page from the data folder.
        if len(parts) == 2 and parts[0] in DATA_FOLDERS:
            return self._data_file(DATA / parts[0], parts[1])
        # Never serve the data folder itself (it holds API keys), generated AI files, git or
        # other hidden files, or the Python environment.
        if parts[0] in ('ai', 'data', '.venv', 'settings.local.json') or any(p.startswith('.') for p in parts):
            return self._json(404, {'error': 'not found'})
        return super().do_GET()

    def _data_file(self, folder, name):
        path = (folder / name).resolve()
        if path.parent != folder.resolve() or not path.is_file():
            return self._json(404, {'error': 'not found'})
        body = path.read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json' if path.suffix == '.json' else 'application/octet-stream')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not self._trusted() or 'application/json' not in (self.headers.get('Content-Type') or ''):
            return self._json(403, {'error': 'forbidden'})
        try:
            length = int(self.headers.get('Content-Length') or 0)
            req = json.loads(self.rfile.read(min(length, 2_000_000)))
        except ValueError:
            return self._json(400, {'error': 'bad request'})
        if self.path == '/api/ai-settings':
            try:
                return self._json(200, providers.save_settings(req))
            except ValueError as e:
                return self._json(400, {'error': str(e)})
        if self.path == '/api/designs/hide':
            try:
                hide_design(req)
                return self._json(200, {'ok': True})
            except (ValueError, AttributeError) as e:
                return self._json(400, {'error': str(e)})
        if self.path == '/api/types':
            try:
                return self._json(200, set_user_type(req))
            except ValueError as e:
                return self._json(400, {'error': str(e)})
        if self.path in ('/api/my-sounds', '/api/my-sounds/delete'):
            try:
                if self.path == '/api/my-sounds':
                    return self._json(200, {'file': save_my_sound(req)})
                delete_my_sound(req.get('file'))
                return self._json(200, {'ok': True})
            except (ValueError, AttributeError) as e:
                return self._json(400, {'error': str(e)})
        if self.path in ('/api/sequences', '/api/sequences/delete'):
            try:
                if self.path == '/api/sequences':
                    return self._json(200, {'file': save_sequence(req)})
                delete_sequence(req.get('file'))
                return self._json(200, {'ok': True})
            except (ValueError, AttributeError) as e:
                return self._json(400, {'error': str(e)})
        if self.path in ('/api/patterns', '/api/patterns/delete'):
            try:
                if self.path == '/api/patterns':
                    return self._json(200, {'file': save_my_pattern(req)})
                delete_my_pattern(req.get('file'))
                return self._json(200, {'ok': True})
            except (ValueError, AttributeError) as e:
                return self._json(400, {'error': str(e)})
        if self.path == '/api/pattern':
            ready, problem = providers.available()
            if not ready:
                return self._json(503, {'error': problem})
            if not pattern_lock.acquire(blocking=False):
                return self._json(409, {'error': 'Already writing a pattern. Wait for it to finish.'})
            try:
                self._pattern(req)
            finally:
                pattern_lock.release()
            return
        if self.path != '/api/design':
            return self._json(404, {'error': 'not found'})
        try:
            message = str(req['message']).strip()[:4000]
        except (ValueError, KeyError, TypeError):
            return self._json(400, {'error': 'bad request'})
        ready, problem = providers.available()
        if not ready:
            return self._json(503, {'error': problem})
        if not design_lock.acquire(blocking=False):
            return self._json(409, {'error': 'Already designing a sound. Wait for it to finish.'})
        try:
            self._design(message, req)
        finally:
            design_lock.release()

    def _send_event(self, obj):
        self.wfile.write((json.dumps(obj) + '\n').encode())
        self.wfile.flush()

    def _sender(self):
        """send(event) for progress events. If the page goes away, the AI keeps going (so its
        answer is still saved) and further events are dropped."""
        gone = False

        def send(ev):
            nonlocal gone
            if gone:
                return
            try:
                self._send_event(ev)
            except (BrokenPipeError, ConnectionResetError):
                gone = True
        return send

    def _pattern(self, req):
        """Writes patterns for one sequencer track. The page sends the request, the task and the
        song context; the answer is checked again on the page (normalizeSong rules)."""
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        self.end_headers()
        send = self._sender()
        names = [p for p in req.get('patterns') or [] if p in ('A', 'B', 'C', 'D')]
        n = req.get('options')
        n = n if isinstance(n, int) and 1 <= n <= 3 else 1
        if not names:
            return send({'type': 'error', 'text': 'No patterns to write.'})
        prompt = (
            f"<request>\n{str(req.get('message') or '').strip()[:2000] or '(no description: use the settings below)'}\n</request>\n\n"
            f"Task: {str(req.get('task') or '')[:2000]}\n"
            f"Give {n} option{'s' if n > 1 else ''}, each filling pattern{'s' if len(names) > 1 else ''} {', '.join(names)}.\n\n"
            'Context:\n'
            f"{json.dumps(req.get('context') or {}, separators=(',', ':'))[:60000]}\n"
        )
        work = AI / 'patterns'  # an empty folder, so Claude Code picks up no project files or settings
        work.mkdir(parents=True, exist_ok=True)
        send({'type': 'step', 'text': 'Writing the pattern'})
        out, _, error = providers.run({
            'system_file': PATTERN_PROMPT, 'prompt': prompt, 'schema': pattern_schema(n, names, bool(req.get('pool'))),
            'cwd': work, 'timeout': PATTERN_TIMEOUT, 'no_result': 'The AI did not return a pattern.'}, send)
        send({'type': 'error', 'text': error} if error else {'type': 'result', 'output': out})

    def _design(self, message, req):
        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson')
        self.end_headers()
        send = self._sender()
        err = ensure_ai_reference()
        if err:
            return send({'type': 'error', 'text': err})
        mode = 'refine' if req.get('mode') == 'refine' else 'new'
        n = req.get('variations')
        n = n if isinstance(n, int) and 2 <= n <= MAX_VARIATIONS else 1
        task = f"Task: {'refine the current sound' if mode == 'refine' else 'design a new sound'}."
        if n > 1:
            task += (f' Give {n} variations: {n} genuinely different takes on the request (for example a'
                     ' different oscillator approach, filter character, envelope or effects), each a complete'
                     ' answer with its own base, distinct name and a 1-2 sentence summary of how it differs.'
                     ' If the request names a synth or a style, every variation stays true to it.')
        session = req.get('session_id') if isinstance(req.get('session_id'), str) else None
        resuming = session and providers.load_settings()['provider'] == 'claude-code' and not session.startswith('conv-')
        # Providers without sessions get the earlier requests of this conversation as text.
        earlier = '' if resuming else conversation_so_far(session)
        prompt = (
            f'{earlier}<request>\n{message}\n</request>\n\n'
            f'{task}\n\n'
            'Current program in the editor (base "current" refers to this):\n'
            f"{json.dumps(req.get('current') or {}, separators=(',', ':'))}\n"
        )
        schema, api_schema, convert = design_schemas(n)
        send({'type': 'step', 'text': 'Thinking about the sound'})
        path = new_design_file(req, message, mode, n)
        out, session_id, error = providers.run({
            'system_file': AI / 'system.md', 'prompt': prompt, 'schema': schema, 'api_schema': api_schema,
            'convert': convert, 'tools': True, 'session': session if resuming else None,
            'cwd': AI, 'timeout': DESIGN_TIMEOUT, 'no_result': 'The AI did not return settings.'}, send)
        # Without a provider session, the conversation is identified by its first design file.
        session_id = session_id or session or f'conv-{path.stem}'
        design = read_design(path) or {}
        results = (out.get('variations') if isinstance(out.get('variations'), list) else [out]) if out else []
        design.update(status='done' if results else 'error', error=error, results=results,
                      session_id=session_id, provider=providers.provider_label())
        write_design(path, design)
        commit_data(f"AI design: {message[:60]}" + (f" → {', '.join(r.get('name', '?') for r in results)}" if results else ' (no answer)'))
        send({'type': 'error', 'text': error} if error else {'type': 'result', 'output': out, 'session_id': session_id})


def main():
    init_data()
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'microKORG XL Editor: http://localhost:{PORT}/')
    ready, problem = providers.available()
    print(f'AI: {providers.provider_label()}' + ('' if ready else f' (not ready: {problem})'))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
