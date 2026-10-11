"""AI providers for the editor's two AI features: designing sounds and writing sequencer patterns.

serve.py builds each request (instructions, prompt, answer format) and calls run(); this module
sends it to the provider chosen in AI settings and returns the answer:

  claude-code  the `claude` command (Claude Code) with the user's own Claude login; no key needed
  anthropic    the Anthropic API, through the official `anthropic` package
  openai       any OpenAI-compatible API (OpenAI, Google Gemini, OpenRouter, Ollama, LM Studio...),
               through the official `openai` package

The two packages need Python 3.10+; `uv run serve.py` installs them (see the top of serve.py).
They're only imported when used, so the server still runs without them (Claude Code only).
Settings, including API keys, live in settings.local.json, which git ignores.

Sound design gives API providers two tools of our own (search_presets, get_preset) over the
reference files in ai/, plus web search where the provider has it. Answers are checked against
the answer format here, so a provider that can't enforce it (small local models) gets one retry.
"""
import glob
import json
import os
import re
import shutil
import subprocess
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent
AI = ROOT / 'ai'
# The user's own files (sounds, songs, patterns, AI designs, these settings) live in their own
# folder with its own git repo, kept out of the app's repo. MKXL_DATA can point somewhere else.
DATA = Path(os.environ.get('MKXL_DATA') or ROOT / 'data').expanduser().resolve()
SETTINGS_FILE = DATA / 'settings.local.json'

# Default Anthropic model, and the models offered when the model list can't be fetched.
ANTHROPIC_DEFAULT = 'claude-opus-5-5'
ANTHROPIC_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1']
CLAUDE_CODE_MODELS = ['', 'opus', 'sonnet', 'haiku']  # '' = Claude Code's own default

# OpenAI-compatible services: id -> (label, base URL, needs an API key, key environment variable)
OPENAI_SERVICES = {
    'openai': ('OpenAI', 'https://api.openai.com/v1', True, 'OPENAI_API_KEY'),
    'gemini': ('Google Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai/', True, 'GEMINI_API_KEY'),
    'openrouter': ('OpenRouter', 'https://openrouter.ai/api/v1', True, 'OPENROUTER_API_KEY'),
    'ollama': ('Ollama (on this computer)', 'http://localhost:11434/v1', False, ''),
    'lmstudio': ('LM Studio (on this computer)', 'http://localhost:1234/v1', False, ''),
    'custom': ('Other OpenAI-compatible server', '', False, 'OPENAI_API_KEY'),
}
PROVIDERS = {
    'claude-code': 'Claude Code (your Claude login)',
    'anthropic': 'Anthropic API',
    'openai': 'OpenAI-compatible (OpenAI, Gemini, OpenRouter, Ollama, LM Studio…)',
}
NEEDS_PACKAGES = ('The {} provider needs the official Python packages, which need Python 3.10 or newer. '
                  'Start the editor with Start Ostinato.command (it uses uv to install them), or run: uv run serve.py')


# ---- settings ----------------------------------------------------------------------------------

def _defaults():
    return {
        'provider': 'claude-code',
        'claude-code': {'model': ''},
        'anthropic': {'api_key': '', 'model': ANTHROPIC_DEFAULT},
        'openai': {'service': 'openai', 'base_url': '', 'api_key': '', 'model': ''},
    }


_settings_lock = threading.Lock()


def load_settings():
    s = _defaults()
    try:
        saved = json.loads(SETTINGS_FILE.read_text())
    except (OSError, ValueError):
        saved = {}
    if isinstance(saved, dict):
        if saved.get('provider') in PROVIDERS:
            s['provider'] = saved['provider']
        for name in ('claude-code', 'anthropic', 'openai'):
            if isinstance(saved.get(name), dict):
                s[name].update({k: str(v) for k, v in saved[name].items() if k in s[name] and isinstance(v, str)})
    if s['openai']['service'] not in OPENAI_SERVICES:
        s['openai']['service'] = 'openai'
    return s


def save_settings(update):
    """Merges an update from the settings panel. An api_key of None leaves the saved key alone;
    an empty string removes it."""
    if not isinstance(update, dict):
        raise ValueError('bad settings')
    with _settings_lock:
        s = load_settings()
        if update.get('provider') in PROVIDERS:
            s['provider'] = update['provider']
        for name in ('claude-code', 'anthropic', 'openai'):
            part = update.get(name)
            if not isinstance(part, dict):
                continue
            for k, v in part.items():
                if k not in s[name] or v is None:
                    continue
                if not isinstance(v, str) or len(v) > 400:
                    raise ValueError(f'bad value for {name}.{k}')
                s[name][k] = v.strip()
        if s['openai']['service'] not in OPENAI_SERVICES:
            raise ValueError('unknown service')
        DATA.mkdir(parents=True, exist_ok=True)
        SETTINGS_FILE.write_text(json.dumps(s, indent=1) + '\n')
        try:
            SETTINGS_FILE.chmod(0o600)  # it holds API keys
        except OSError:
            pass
    return public_settings()


def _anthropic_key(s):
    return s['anthropic']['api_key'] or os.environ.get('ANTHROPIC_API_KEY', '')


def _openai_service(s):
    return OPENAI_SERVICES[s['openai']['service']]


def _openai_key(s):
    env = _openai_service(s)[3]
    return s['openai']['api_key'] or (os.environ.get(env, '') if env else '')


def _key_source(saved, env_name):
    return 'saved' if saved else ('environment' if env_name and os.environ.get(env_name) else '')


def public_settings():
    """Settings for the page: never includes keys, only where one comes from."""
    s = load_settings()
    ok, problem = available(s)
    return {
        'provider': s['provider'],
        'providers': [{'id': k, 'label': v} for k, v in PROVIDERS.items()],
        'claude-code': {**s['claude-code'], 'installed': bool(CLAUDE), 'models': CLAUDE_CODE_MODELS},
        'anthropic': {'model': s['anthropic']['model'], 'models': ANTHROPIC_MODELS,
                      'key': _key_source(s['anthropic']['api_key'], 'ANTHROPIC_API_KEY')},
        'openai': {'service': s['openai']['service'], 'base_url': s['openai']['base_url'], 'model': s['openai']['model'],
                   'key': _key_source(s['openai']['api_key'], _openai_service(s)[3]),
                   'services': [{'id': k, 'label': v[0], 'base_url': v[1], 'needs_key': v[2], 'key_env': v[3]}
                                for k, v in OPENAI_SERVICES.items()]},
        'packages': packages_installed(),
        'ready': ok, 'problem': problem, 'label': provider_label(s),
    }


def provider_label(s=None):
    s = s or load_settings()
    if s['provider'] == 'anthropic':
        return f"Anthropic API · {s['anthropic']['model'] or ANTHROPIC_DEFAULT}"
    if s['provider'] == 'openai':
        return f"{_openai_service(s)[0]} · {s['openai']['model'] or 'no model chosen'}"
    return 'Claude Code' + (f" · {s['claude-code']['model']}" if s['claude-code']['model'] else '')


def packages_installed():
    try:
        import anthropic  # noqa: F401
        import openai  # noqa: F401
        return True
    except ImportError:
        return False


def available(s=None):
    """(ready, problem): whether the chosen provider can be used, and if not, why."""
    s = s or load_settings()
    p = s['provider']
    if p == 'claude-code':
        return (True, '') if CLAUDE else (False, 'Claude Code (the `claude` command) was not found on this computer.')
    if not packages_installed():
        return False, NEEDS_PACKAGES.format(PROVIDERS[p].split(' (')[0])
    if p == 'anthropic':
        return (True, '') if _anthropic_key(s) else (False, 'Add an Anthropic API key in AI settings.')
    label, url, needs_key, _ = _openai_service(s)
    if not (s['openai']['base_url'] or url):
        return False, 'Enter the server address in AI settings.'
    if needs_key and not _openai_key(s):
        return False, f'Add a {label} API key in AI settings.'
    if not s['openai']['model']:
        return False, 'Choose a model in AI settings.'
    return True, ''


def list_models(provider, s=None):
    """Model names the provider offers (for the settings panel)."""
    s = s or load_settings()
    if provider == 'claude-code':
        return CLAUDE_CODE_MODELS
    if not packages_installed():
        raise RuntimeError(NEEDS_PACKAGES.format(PROVIDERS[provider].split(' (')[0]))
    if provider == 'anthropic':
        import anthropic
        client = anthropic.Anthropic(api_key=_anthropic_key(s) or None, max_retries=1, timeout=20)
        try:
            return [m.id for m in client.models.list()]
        except anthropic.APIError as e:
            raise RuntimeError(_anthropic_error(e))
    import openai
    client = _openai_client(s, timeout=20)
    try:
        return sorted(m.id for m in client.models.list())
    except openai.APIError as e:
        raise RuntimeError(_openai_error(e, s))


# ---- running a request -------------------------------------------------------------------------

def run(job, send):
    """Sends one request to the chosen provider.

    job: {
      system_file: Path of the instructions; prompt: the user message;
      schema: the answer format (JSON schema) for Claude Code;
      api_schema, convert: an answer format for API providers and a function turning their answer
        into the Claude Code shape (defaults: the same schema, unchanged);
      tools: give sound-design tools (presets, web); session: Claude Code session to resume;
      cwd, timeout, no_result: working folder, seconds, message when nothing comes back }
    send(event): progress for the page ({type: 'step'|'note', text}).
    Returns (answer, session_id, error).
    """
    s = load_settings()
    ok, problem = available(s)
    if not ok:
        return None, None, problem
    for key in ('schema', 'api_schema'):
        if key in job and not isinstance(job[key], dict):
            raise TypeError(f'job[{key!r}] must be a JSON schema dict')
    if s['provider'] == 'claude-code':
        return _run_claude_code(job, send, s)
    if s['provider'] == 'anthropic':
        return _run_anthropic(job, send, s)
    return _run_openai(job, send, s)


# ---- checking answers ---------------------------------------------------------------------------

def check(schema, value, path='answer'):
    """The first way `value` breaks `schema` (the subset of JSON schema we use), or ''."""
    t = schema.get('type')
    types = t if isinstance(t, list) else [t] if t else []
    kinds = {'object': dict, 'array': list, 'string': str, 'boolean': bool}
    if types:
        def fits(ty):
            if ty == 'integer':
                return isinstance(value, int) and not isinstance(value, bool)
            if ty == 'number':
                return isinstance(value, (int, float)) and not isinstance(value, bool)
            return isinstance(value, kinds.get(ty, object))
        if not any(fits(ty) for ty in types):
            return f'{path} should be {" or ".join(types)}'
    if 'enum' in schema and value not in schema['enum']:
        return f'{path} should be one of {schema["enum"]}'
    if isinstance(value, dict):
        for key in schema.get('required', []):
            if key not in value:
                return f'{path} is missing "{key}"'
        for key, sub in (schema.get('properties') or {}).items():
            if key in value:
                err = check(sub, value[key], f'{path}.{key}')
                if err:
                    return err
    if isinstance(value, list):
        if len(value) < schema.get('minItems', 0):
            return f'{path} needs at least {schema["minItems"]} items'
        if 'maxItems' in schema and len(value) > schema['maxItems']:
            return f'{path} allows at most {schema["maxItems"]} items'
        for i, item in enumerate(value):
            err = check(schema.get('items') or {}, item, f'{path}[{i}]')
            if err:
                return err
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if 'minimum' in schema and value < schema['minimum']:
            return f'{path} is below {schema["minimum"]}'
        if 'maximum' in schema and value > schema['maximum']:
            return f'{path} is above {schema["maximum"]}'
    return ''


def api_schema(schema):
    """A copy for strict structured output: every object closed and fully required, and the
    constraints APIs don't enforce removed (check() still applies them afterwards)."""
    if isinstance(schema, list):
        return [api_schema(x) for x in schema]
    if not isinstance(schema, dict):
        return schema
    out = {k: api_schema(v) for k, v in schema.items()
           if k not in ('minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength')}
    if out.get('type') == 'object' and 'properties' in out:
        out['additionalProperties'] = False
        out['required'] = list(out['properties'])
    return out


def parse_answer(text, schema):
    """(answer, problem): JSON from a reply (allowing code fences or text around it), checked."""
    text = re.sub(r'<think>.*?</think>', '', text or '', flags=re.S).strip()
    m = re.search(r'```(?:json)?\s*(.*?)```', text, re.S)
    if m:
        text = m.group(1).strip()
    start, end = text.find('{'), text.rfind('}')
    if start < 0 or end < start:
        return None, 'the reply had no JSON object'
    try:
        value = json.loads(text[start:end + 1])
    except ValueError as e:
        return None, f'the reply was not valid JSON ({e})'
    problem = check(schema, value)
    return (None, problem) if problem else (value, '')


# ---- sound-design tools for API providers --------------------------------------------------------

TOOLS_NOTE = '''

# Your tools
- search_presets(query): finds presets in the index by words (sound type, character, name,
  oscillator or effect), returning their one-line summaries.
- get_preset(name, bank): the full settings of one preset ("" for bank searches every bank).
{web}'''

PRESET_TOOLS = [
    {'name': 'search_presets',
     'description': 'Search the preset index (every preset with a one-line summary) for presets whose name, '
                    'type, category or summary contain these words. Returns up to 25 matching lines.',
     'schema': {'type': 'object', 'properties': {'query': {'type': 'string', 'description': 'Words to look for, e.g. "acid bass" or "pad chorus"'}},
                'required': ['query'], 'additionalProperties': False}},
    {'name': 'get_preset',
     'description': 'Full settings of one preset, using the same keys as your answer.',
     'schema': {'type': 'object', 'properties': {
         'name': {'type': 'string', 'description': 'Preset name, e.g. "MG BASS"'},
         'bank': {'type': 'string', 'description': 'Bank name, e.g. "MKXL_FactoryPreset", or "" for any bank'}},
         'required': ['name', 'bank'], 'additionalProperties': False}},
]


def search_presets(query, limit=25):
    try:
        lines = (AI / 'preset-index.md').read_text().splitlines()[4:]
    except OSError:
        return 'The preset index is missing.'
    words = [w for w in re.findall(r'[\w\-./]+', str(query).lower()) if len(w) > 1]
    if not words:
        return 'Give some words to search for.'
    scored = sorted(((sum(w in line.lower() for w in words), k, line) for k, line in enumerate(lines)), key=lambda x: (-x[0], x[1]))
    hits = [line for score, _, line in scored if score > 0][:limit]
    return '\n'.join(['bank | name | type | category | summary', *hits]) if hits else f'No presets match "{query}".'


def get_preset(name, bank=''):
    want, want_bank = str(name).strip().upper(), str(bank or '').strip().lower()
    found = []
    try:
        with open(AI / 'presets.jsonl') as f:
            for line in f:
                p = json.loads(line)
                if p.get('name', '').strip().upper() == want and (not want_bank or p.get('bank', '').lower() == want_bank):
                    found.append(line.strip())
                    if len(found) == 2:
                        break
    except (OSError, ValueError):
        return 'The preset settings are missing.'
    return '\n'.join(found) if found else f'No preset named "{name}". ' + search_presets(name, 5)


def run_tool(name, args):
    if name == 'search_presets':
        return search_presets(args.get('query', ''))
    if name == 'get_preset':
        return get_preset(args.get('name', ''), args.get('bank', ''))
    return f'Unknown tool {name}.'


def describe_tool(name, inp):
    if name == 'Read':
        return f"Reading {Path(inp.get('file_path', '')).name}"
    if name == 'Grep':
        pat = inp.get('pattern', '')
        if '"name"' in pat:
            pat = pat.split(':', 1)[-1].strip('"\\ ')
        return f'Looking up {pat}'
    if name == 'Glob':
        return 'Listing reference files'
    if name in ('WebSearch', 'web_search'):
        return f"Searching the web: {inp.get('query', '')}"
    if name == 'WebFetch':
        return f"Reading {inp.get('url', '')}"
    if name == 'search_presets':
        return f"Searching presets: {inp.get('query', '')}"
    if name == 'get_preset':
        return f"Reading preset {inp.get('name', '')}"
    if name == 'StructuredOutput':
        return 'Writing the answer'
    return name


# ---- Claude Code ---------------------------------------------------------------------------------

CLAUDE_TOOLS = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch']


def find_claude():
    """Locate the claude CLI even when launched from Finder with a minimal PATH."""
    found = shutil.which('claude')
    if found:
        return found
    home = Path.home()
    candidates = sorted(glob.glob(str(home / '.nvm/versions/node/*/bin/claude')), reverse=True) + [
        str(home / '.claude/local/claude'), str(home / '.local/bin/claude'),
        '/opt/homebrew/bin/claude', '/usr/local/bin/claude', str(home / '.npm-global/bin/claude'),
    ]
    return next((c for c in candidates if os.access(c, os.X_OK)), None)


CLAUDE = find_claude()


def tool_env():
    """PATH that includes the directory holding claude (and, for nvm installs, node)."""
    env = dict(os.environ)
    if CLAUDE:
        env['PATH'] = os.path.dirname(CLAUDE) + os.pathsep + env.get('PATH', '/usr/bin:/bin')
    return env


def _run_claude_code(job, send, s):
    cmd = [CLAUDE, '-p', '--output-format', 'stream-json', '--verbose',
           '--system-prompt-file', str(job['system_file']), '--setting-sources', '']
    if job.get('tools'):
        cmd += ['--tools', ','.join(CLAUDE_TOOLS), '--allowedTools', *CLAUDE_TOOLS]
    else:
        cmd += ['--tools', '', '--no-session-persistence']
    cmd += ['--json-schema', json.dumps(job['schema'])]
    model = s['claude-code']['model'] or os.environ.get('MKXL_AI_MODEL')
    if model:
        cmd += ['--model', model]
    session = job.get('session')
    if isinstance(session, str) and re.fullmatch(r'[0-9a-fA-F-]{20,}', session):
        cmd += ['--resume', session]
    result = (None, None, None)
    proc = subprocess.Popen(cmd, cwd=job['cwd'], env=tool_env(), stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    timer = threading.Timer(job['timeout'], proc.kill)
    timer.start()
    try:
        proc.stdin.write(job['prompt'])
        proc.stdin.close()
        got_result = False
        for line in proc.stdout:
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get('type') == 'assistant':
                for c in ev.get('message', {}).get('content', []):
                    if c.get('type') == 'tool_use':
                        send({'type': 'step', 'text': describe_tool(c.get('name'), c.get('input') or {})})
                    elif c.get('type') == 'text' and c.get('text', '').strip():
                        send({'type': 'note', 'text': c['text'].strip()[:600]})
            elif ev.get('type') == 'result':
                got_result = True
                out = ev.get('structured_output')
                if ev.get('is_error') or not isinstance(out, dict):
                    result = (None, ev.get('session_id'), (ev.get('result') or job['no_result'])[:600])
                else:
                    result = (out, ev.get('session_id'), None)
        proc.wait()
        if not got_result:
            stderr = proc.stderr.read().strip()
            hint = ' Try running `claude` in Terminal once to make sure you are logged in.' if 'login' in stderr.lower() or 'auth' in stderr.lower() else ''
            result = (None, None, (stderr[:500] or 'Claude Code stopped without an answer.') + hint)
    finally:
        timer.cancel()
        if proc.poll() is None:
            proc.kill()
    return result


# ---- Anthropic API -------------------------------------------------------------------------------

# Models with adaptive thinking and effort; the newest web search tool; server-side fallbacks.
_ADAPTIVE = ('claude-fable', 'claude-mythos', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7',
             'claude-opus-4-6', 'claude-sonnet-4-6')
_WEB_20260209 = ('claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6')
_FALLBACKS = ('claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5')


def _anthropic_error(e):
    import anthropic
    if isinstance(e, anthropic.APITimeoutError):
        return 'The Anthropic API took too long to answer. Try again.'
    if isinstance(e, anthropic.AuthenticationError):
        return "The Anthropic API key wasn't accepted. Check it in AI settings."
    if isinstance(e, anthropic.PermissionDeniedError):
        return "This Anthropic API key isn't allowed to use that model."
    if isinstance(e, anthropic.NotFoundError):
        return 'Anthropic doesn’t know that model. Choose another in AI settings.'
    if isinstance(e, anthropic.RateLimitError):
        return 'The Anthropic API is rate limiting this key. Try again in a minute.'
    if isinstance(e, anthropic.APIStatusError):
        if e.status_code >= 500:
            return f'Anthropic’s service had a problem ({e.status_code}). Try again shortly.'
        return f'The Anthropic API refused the request: {e.message}'
    if isinstance(e, anthropic.APIConnectionError):
        return 'Couldn’t reach the Anthropic API. Check the internet connection.'
    return str(e)


def _run_anthropic(job, send, s):
    import anthropic
    model = s['anthropic']['model'] or ANTHROPIC_DEFAULT
    client = anthropic.Anthropic(api_key=_anthropic_key(s), timeout=job['timeout'], max_retries=2)
    schema = job.get('api_schema') or job['schema']
    system = job['system_file'].read_text()
    tools = []
    if job.get('tools'):
        tools = [{'name': t['name'], 'description': t['description'], 'input_schema': t['schema'], 'strict': True}
                 for t in PRESET_TOOLS]
        tools.append({'type': 'web_search_20260209' if model.startswith(_WEB_20260209) else 'web_search_20250305',
                      'name': 'web_search', 'max_uses': 2})
        system += TOOLS_NOTE.format(web='- web_search: for artists, songs or classic patches you are unsure of.')
    params = {
        'model': model, 'max_tokens': 16000,
        # The long instructions are the same every time, so cache them.
        'system': [{'type': 'text', 'text': system, 'cache_control': {'type': 'ephemeral'}}],
        'output_config': {'format': {'type': 'json_schema', 'schema': api_schema(schema)}},
    }
    if tools:
        params['tools'] = tools
    if model.startswith(_ADAPTIVE):
        params['thinking'] = {'type': 'adaptive'}
        params['output_config']['effort'] = 'medium' if job.get('tools') else 'low'
    create = client.messages.create
    if model in _FALLBACKS:
        # If the model declines, the API retries on a suitable fallback model in the same call.
        params.update(betas=['server-side-fallback-2026-07-01'], fallbacks='default')
        create = client.beta.messages.create
    messages = [{'role': 'user', 'content': job['prompt']}]
    try:
        for _ in range(12):
            resp = create(messages=messages, **params)
            for b in resp.content:
                if b.type == 'server_tool_use':
                    send({'type': 'step', 'text': describe_tool(b.name, b.input or {})})
            if resp.stop_reason == 'refusal':
                return None, None, 'The model declined this request.'
            if resp.stop_reason == 'max_tokens':
                return None, None, 'The answer was cut off (too long).'
            if resp.stop_reason == 'pause_turn':  # a long web search; send it back to continue
                messages.append({'role': 'assistant', 'content': resp.content})
                continue
            uses = [b for b in resp.content if b.type == 'tool_use']
            if resp.stop_reason == 'tool_use' and uses:
                messages.append({'role': 'assistant', 'content': resp.content})
                results = []
                for b in uses:
                    send({'type': 'step', 'text': describe_tool(b.name, b.input or {})})
                    results.append({'type': 'tool_result', 'tool_use_id': b.id, 'content': run_tool(b.name, b.input or {})})
                messages.append({'role': 'user', 'content': results})
                continue
            text = ''.join(b.text for b in resp.content if b.type == 'text')
            answer, problem = parse_answer(text, schema)
            if answer is None:
                return None, None, f'The answer didn’t fit the expected format: {problem}.'
            return (job.get('convert') or (lambda a: a))(answer), None, None
        return None, None, 'The AI kept using tools without answering.'
    except anthropic.APIError as e:
        return None, None, _anthropic_error(e)


# ---- OpenAI-compatible APIs ----------------------------------------------------------------------

def _openai_client(s, timeout=120):
    import openai
    label, url, needs_key, _ = _openai_service(s)
    # Local servers ignore the key, but the package needs one. A slow local model shouldn't be
    # asked twice, so no retries there.
    return openai.OpenAI(base_url=s['openai']['base_url'] or url, api_key=_openai_key(s) or 'not-needed',
                         timeout=timeout, max_retries=1 if needs_key else 0)


def _ollama_context(s, model):
    """The context size Ollama loaded the model with (it ignores requests for more over the
    OpenAI-compatible API), or None if it can't tell."""
    import urllib.request
    base = (s['openai']['base_url'] or _openai_service(s)[1]).rstrip('/')
    base = base[:-3] if base.endswith('/v1') else base
    try:
        with urllib.request.urlopen(f'{base}/api/ps', timeout=3) as r:
            loaded = json.load(r).get('models', [])
        return next((m.get('context_length') for m in loaded if m.get('name') == model or m.get('model') == model), None)
    except (OSError, ValueError):
        return None


def _openai_error(e, s):
    import openai
    label = _openai_service(s)[0]
    if isinstance(e, openai.APITimeoutError):
        local = not _openai_service(s)[2]
        return (f'{label} took too long to answer.' + (' Models running on this computer can be slow, especially '
                'big ones: try a smaller model, or one that fits in memory.' if local else ' Try again.'))
    if isinstance(e, openai.AuthenticationError):
        return f"The {label} API key wasn't accepted. Check it in AI settings."
    if isinstance(e, openai.NotFoundError):
        return f'{label} doesn’t know that model (or address). Check AI settings.'
    if isinstance(e, openai.RateLimitError):
        return f'{label} is rate limiting this key. Try again in a minute.'
    if isinstance(e, openai.APIStatusError):
        return f'{label} refused the request ({e.status_code}): {str(e.message)[:300]}'
    if isinstance(e, openai.APIConnectionError):
        return f'Couldn’t reach {label} at {s["openai"]["base_url"] or _openai_service(s)[1]}. Is it running?'
    return str(e)


LOCAL_TIMEOUT = 900  # models on this computer think slowly (minutes); the page can cancel


def _run_openai(job, send, s):
    import openai
    local = not _openai_service(s)[2]
    client = _openai_client(s, timeout=max(job['timeout'], LOCAL_TIMEOUT) if local else job['timeout'])
    model = s['openai']['model']
    schema = job.get('api_schema') or job['schema']
    strict = api_schema(schema)
    system = job['system_file'].read_text()
    tools = None
    if job.get('tools'):
        tools = [{'type': 'function', 'function': {'name': t['name'], 'description': t['description'], 'parameters': t['schema']}}
                 for t in PRESET_TOOLS]
        system += TOOLS_NOTE.format(web='Web search isn’t available here; rely on your own knowledge.')
    fmt = ('\n\nAnswer with one JSON object in exactly this format, and nothing else:\n'
           + json.dumps(strict, separators=(',', ':')))
    messages = [{'role': 'system', 'content': system}, {'role': 'user', 'content': job['prompt'] + fmt}]

    # Roughly how many tokens the request needs: the instructions and request (about 3 characters
    # a token for this JSON-heavy text), plus room for the model to think and answer.
    needed = int((len(system) + len(messages[1]['content'])) / 3) + 4000
    checked = False

    def too_small():
        """After the first reply from Ollama: an error if it cut off the instructions."""
        nonlocal checked
        if checked or s['openai']['service'] != 'ollama':
            return ''
        checked = True
        ctx = _ollama_context(s, model)
        if ctx and ctx < needed:
            return (f'Ollama gave {model} only {ctx:,} tokens of context, but this request needs about {needed:,}, so the '
                    f'model would only see part of its instructions. In the Ollama app’s Settings, raise “Context length” '
                    f'to {16384 if needed <= 16384 else 32768:,} or more (or start Ollama with OLLAMA_CONTEXT_LENGTH set), then try again.')
        return ''

    def ask(with_tools):
        """One request; JSON answers are enforced where the server supports it."""
        if with_tools:
            return client.chat.completions.create(model=model, messages=messages, tools=tools)
        for response_format in ({'type': 'json_schema', 'json_schema': {'name': 'answer', 'schema': strict, 'strict': True}},
                                {'type': 'json_object'}, None):
            try:
                extra = {'response_format': response_format} if response_format else {}
                return client.chat.completions.create(model=model, messages=messages, **extra)
            except openai.BadRequestError:
                if response_format is None:
                    raise
        return None

    try:
        text = ''
        for _ in range(8):  # tool calls first (sound design), then the answer
            choice = ask(bool(tools)).choices[0]
            msg = choice.message
            problem = too_small()
            if problem:
                return None, None, problem
            if choice.finish_reason == 'length':
                return None, None, ('The model ran out of room before finishing its answer. With a local model, raise its '
                                    'context length (e.g. in the Ollama app’s Settings) and try again.')
            if not msg.tool_calls:
                text = msg.content or ''
                break
            messages.append({'role': 'assistant', 'content': msg.content or '', 'tool_calls': [
                {'id': c.id, 'type': 'function', 'function': {'name': c.function.name, 'arguments': c.function.arguments}}
                for c in msg.tool_calls]})
            for c in msg.tool_calls:
                try:
                    args = json.loads(c.function.arguments or '{}')
                except ValueError:
                    args = {}
                send({'type': 'step', 'text': describe_tool(c.function.name, args)})
                messages.append({'role': 'tool', 'tool_call_id': c.id, 'content': run_tool(c.function.name, args)})
        answer, problem = parse_answer(text, schema)
        for _ in range(2):  # ask again (without tools, JSON enforced where possible) if needed
            if answer is not None:
                break
            send({'type': 'step', 'text': 'Asking for the answer again in the right format'})
            if text:
                messages.append({'role': 'assistant', 'content': text})
            messages.append({'role': 'user', 'content': f'That answer could not be used ({problem}).{fmt}'})
            text = ask(False).choices[0].message.content or ''
            answer, problem = parse_answer(text, schema)
        if answer is None:
            return None, None, f'The model’s answer didn’t fit the expected format: {problem}.'
        return (job.get('convert') or (lambda a: a))(answer), None, None
    except openai.APIError as e:
        return None, None, _openai_error(e, s)
