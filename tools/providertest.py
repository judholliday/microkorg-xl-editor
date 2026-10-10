"""Offline checks for ai_providers.py and the AI answer formats in serve.py: python3 tools/providertest.py
(No AI is called. Works with or without the API packages installed.)"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import ai_providers as p  # noqa: E402
import serve  # noqa: E402

# check(): the subset of JSON schema the answer formats use.
schema = serve.pattern_schema(2, ['A'], True)
assert isinstance(schema, dict)  # providers get structures, not JSON text
good = {'options': [{'summary': 's', 'patterns': [{'name': 'A', 'steps': [{'i': 0, 'notes': [36], 'vel': 100, 'gate': 50, 'len': 1}]}], 'pool': [60]}] * 2}
assert p.check(schema, good) == ''
bad = json.loads(json.dumps(good))
bad['options'][0]['patterns'][0]['steps'][0]['vel'] = 300
assert 'above 127' in p.check(schema, bad), p.check(schema, bad)
assert 'at least 2' in p.check(schema, {'options': good['options'][:1]})
assert 'missing "pool"' in p.check(schema, {'options': [{'summary': 's', 'patterns': good['options'][0]['patterns']}] * 2})
assert p.check({'type': 'integer'}, True) != ''  # booleans aren't numbers

# api_schema(): closed objects, every property required, unenforced constraints removed.
strict = p.api_schema(schema)
s = json.dumps(strict)
assert 'minItems' not in s and 'maximum' not in s and 'additionalProperties": false' in s
step = strict['properties']['options']['items']['properties']['patterns']['items']['properties']['steps']['items']
assert step['required'] == ['i', 'notes', 'vel', 'gate', 'len'] and step['additionalProperties'] is False

# parse_answer(): finds the JSON in fenced or chatty replies, and reports what's wrong.
item = {'type': 'object', 'required': ['a'], 'properties': {'a': {'type': 'integer'}}}
assert p.parse_answer('Sure!\n```json\n{"a": 3}\n```', item) == ({'a': 3}, '')
assert p.parse_answer('<think>hmm {"a": "x"}</think> {"a": 4} done', item) == ({'a': 4}, '')
assert p.parse_answer('no json here', item)[0] is None
assert 'integer' in p.parse_answer('{"a": "three"}', item)[1]

# Design answers: API providers give changes as pairs; they become the editor's { key: value }.
_, api, convert = serve.design_schemas(2)
answer = {'variations': [{'base': 'init', 'name': 'X', 'summary': 's', 'changes': [
    {'param': 't1.f1Cutoff', 'value': '64'}, {'param': 't1.osc1Wave', 'value': 'Saw'}, {'param': 'fx1.Feedback', 'value': '-3.5'}]}] * 2}
assert p.check(api, answer) == ''
assert convert(answer)['variations'][0]['changes'] == {'t1.f1Cutoff': 64, 't1.osc1Wave': 'Saw', 'fx1.Feedback': -3.5}
claude_schema, _, convert1 = serve.design_schemas(1)
assert claude_schema['properties']['changes']['type'] == 'object'
assert convert1({'base': 'current', 'name': 'Y', 'summary': '', 'changes': []})['changes'] == {}

# Preset tools over ai/ (built by tools/build_ai_reference.mjs).
if (p.AI / 'preset-index.md').exists():
    hits = p.search_presets('MG BASS')
    assert 'MG BASS' in hits.splitlines()[1], hits[:200]
    full = json.loads(p.get_preset('mg bass', 'MKXL_FactoryPreset').splitlines()[0])
    assert full['name'].strip() == 'MG BASS' and 't1.f1Cutoff' in full['settings']
    assert p.get_preset('NO SUCH THING').startswith('No preset named')
    assert p.run_tool('search_presets', {'query': 'pad'}).count('\n') > 3

# Settings never expose keys.
pub = p.public_settings()
assert 'api_key' not in json.dumps(pub)
assert {x['id'] for x in pub['providers']} == {'claude-code', 'anthropic', 'openai'}

print(f'ok — AI providers (Python {sys.version.split()[0]}, API packages {"installed" if p.packages_installed() else "not installed"})')
