# /// script
# requires-python = ">=3.10"
# dependencies = ["sounddevice", "numpy", "mido", "python-rtmidi", "matplotlib"]
# ///
"""Measure what the microKORG XL's 0..127 values mean in real units, by sending test patches,
playing notes and recording them (see tools/listen.py). Replaces the synth's edit buffer.

    caffeinate -i uv run tools/calibrate.py [test ...]   # default: all tests, in the order below
                                                       # (caffeinate keeps the Mac awake)
    uv run tools/calibrate.py --report       # print the saved results

Tests: eg2a eg2d eg2r cutoff egint osc2tune patchtune pitchpatch analog
Results are saved after every measurement in recordings/calibration.json, so a run can be stopped
and resumed (finished measurements are skipped; delete a key to redo it).
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import listen  # noqa: E402

SR = listen.SR
OUT = listen.ROOT / 'recordings/calibration.json'
VALUES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96, 104, 112, 120, 127]
NOTE = 57  # A3, 220 Hz
LATENCY = 0.012  # seconds from sending note-on to sound, measured on the init patch

# The test patches: plain sine (or noise), filter wide open, no effects or modulation.
SINE = {'name': 'CALIB', 't1.osc1Wave': 'Sine', 't1.osc2Level': 0, 't1.ampLevel': 127, 't1.analogTune': 0,
        't1.f1KeyTrack': 0, 't1.f1EgInt': 0, 't1.eg2Vel': 0, 't1.eg1Vel': 0, 't1.f1VelSens': 0}
NOISE = {**SINE, 't1.osc1Level': 0, 't1.noiseLevel': 127, 't1.f1Reso': 0}


def load():
    try:
        return json.loads(OUT.read_text())
    except (OSError, ValueError):
        return {}


def save(res):
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(res, indent=1))


def play(patch, gate, tail, note=NOTE, send=True):
    if send:
        listen.send_program(patch)
    st, pre, _ = listen.record_note(note, 100, gate, tail, 2)
    x = st.mean(axis=1)
    peak = listen.db(np.abs(st).max())
    if peak > -1:
        print(f'    warning: clipping ({peak:.1f} dBFS)')
    if peak < -45:
        sys.exit(f'Stopped: the synth is silent ({peak:.0f} dBFS). Check it still responds, then run '
                 'again; finished measurements are kept.')
    return x, pre + LATENCY  # time of the note's start in the recording


def envelope(x, hop=0.002):
    h = int(hop * SR)
    n = len(x) // h
    return np.array([np.std(x[i * h:(i + 1) * h]) for i in range(n)]) + 1e-9, hop


def ms(s):
    return round(s * 1000, 1)


# ---- envelopes ----

def eg2a(v):
    """Attack: time from note start to 90% of the held level, plus the curve's shape."""
    gate = 1.5
    while True:
        x, t0 = play({**SINE, 't1.eg2A': v, 't1.eg2D': 64, 't1.eg2S': 127, 't1.eg2R': 0}, gate, 0.3)
        env, hop = envelope(x)
        end = int((t0 + gate - 0.02) / hop)
        plateau = env[end - 50:end].mean()
        rising = listen.db(env[end - 25:end].mean()) - listen.db(env[end - 150:end - 125].mean())
        if rising < 0.3 or gate >= 40:
            break
        gate *= 4
    i0 = int(t0 / hop)
    hit = np.nonzero(env[i0:end] >= plateau * 0.9)[0]
    t90 = hit[0] * hop if len(hit) else None
    shape = None
    if t90 and t90 > 0.02:  # amplitude at 25/50/75% of the attack time, as a fraction of the plateau
        shape = [round(float(env[i0 + int(t90 * f / hop)] / plateau), 2) for f in (0.25, 0.5, 0.75)]
    return {'attack_to_90pct_ms': ms(t90) if t90 is not None else f'>{gate}s', 'shape_25_50_75': shape}


def eg2d(v):
    """Decay with sustain 0: time from note start until the level has fallen 20/40/60 dB."""
    gate = 2.0
    while True:
        x, t0 = play({**SINE, 't1.eg2A': 0, 't1.eg2D': v, 't1.eg2S': 0, 't1.eg2R': 0}, gate, 0.3)
        env, hop = envelope(x)
        i0 = int(t0 / hop)
        peak = env[i0:i0 + 25].max()
        held = env[i0:int((t0 + gate - 0.02) / hop)]
        if (held < peak * 10 ** (-60 / 20)).any() or gate >= 40:
            break
        gate *= 4
    return falls(env, hop, i0, peak, gate)


def eg2r(v):
    """Release: time from note-off until the level has fallen 20/40/60 dB."""
    tail = 2.0
    while True:
        x, t0 = play({**SINE, 't1.eg2A': 0, 't1.eg2D': 64, 't1.eg2S': 127, 't1.eg2R': v}, 0.6, tail)
        env, hop = envelope(x)
        off = int((t0 + 0.6) / hop)
        level = env[off - 25:off].mean()
        if (env[off:] < level * 10 ** (-60 / 20)).any() or tail >= 40:
            break
        tail *= 4
    return falls(env, hop, off, level, tail)


def falls(env, hop, i0, ref, span):
    i0 += int(np.argmax(env[i0:i0 + 25] >= ref * 0.7))  # where the sound is actually at level
    out = {}
    for d in (20, 40, 60):
        hit = np.nonzero(env[i0:] < ref * 10 ** (-d / 20))[0]
        out[f'to_-{d}dB_ms'] = ms(hit[0] * hop) if len(hit) else f'>{span}s'
    return out


# ---- filter ----

_REF = {}


def spectrum(x, t0, dur=2.6):
    seg = x[int((t0 + 0.2) * SR):int((t0 + 0.2 + dur) * SR)]
    n = 8192
    win = np.hanning(n)
    frames = [seg[i:i + n] * win for i in range(0, len(seg) - n, n // 2)]
    p = np.mean([np.abs(np.fft.rfft(f)) ** 2 for f in frames], axis=0)
    return np.fft.rfftfreq(n, 1 / SR), p


BANDS = 25 * 2 ** (np.arange(0, 60) / 6)  # 1/6-octave centres from 25 Hz to ~20 kHz
BANDS = BANDS[BANDS < 18000]


def bands(f, p):
    """Power per band, each band at least 1/3 octave and 40 Hz wide, so noise averages out."""
    out = []
    for fc in BANDS:
        half = max(fc * (2 ** (1 / 6) - 1), 20)
        m = (f >= fc - half) & (f <= fc + half)
        out.append(p[m].mean())
    return np.array(out)


def cutoff_of(patch):
    """The filter's response on noise, against the same noise through Filter 1 set to Thru:
    the -3 dB and -12 dB points (an analog-style 24 dB lowpass is about -12 dB at its nominal
    cutoff) and the slope over the next octave."""
    if 'ref' not in _REF:
        x, t0 = play({**NOISE, 't1.f1Balance': 127}, 3.0, 0.2)  # Thru
        _REF['ref'] = bands(*spectrum(x, t0))
    x, t0 = play(patch, 3.0, 0.2)
    r = 10 * np.log10(bands(*spectrum(x, t0)) / _REF['ref'])
    # passband: median of the bands before the response first falls 12 dB below its running max
    run = np.maximum.accumulate(r)
    fall = np.nonzero(r < run - 12)[0]
    pb = float(np.median(r[:max(fall[0], 1)])) if len(fall) else float(np.median(r))
    out = {'passband_db': round(pb, 1)}
    for d in (3, 12):
        k = np.nonzero(r < pb - d)[0]
        if not len(k):
            out[f'minus{d}db_hz'] = 'above 18 kHz'
        elif k[0] == 0:
            out[f'minus{d}db_hz'] = 'below 25 Hz'
        else:  # interpolate between the bands either side, in log frequency
            j = k[0]
            a, b = r[j - 1] - (pb - d), r[j] - (pb - d)
            out[f'minus{d}db_hz'] = round(float(BANDS[j - 1] * (BANDS[j] / BANDS[j - 1]) ** (a / (a - b))))
    f12 = out['minus12db_hz']
    if isinstance(f12, float) or isinstance(f12, int):
        j1, j2 = np.argmin(abs(BANDS - f12)), np.argmin(abs(BANDS - f12 * 2))
        if BANDS[j2] < 16000:
            out['slope_db_per_oct'] = round(float(r[j1] - r[j2]), 1)
    return out


def cutoff(v):
    return cutoff_of({**NOISE, 't1.f1Balance': 0, 't1.f1Cutoff': v})


def egint(v):
    """How far EG1 (held at full: sustain 127) moves the cutoff from a base of 30."""
    return cutoff_of({**NOISE, 't1.f1Balance': 0, 't1.f1Cutoff': 30, 't1.f1EgInt': v,
                      't1.eg1A': 0, 't1.eg1D': 64, 't1.eg1S': 127})


# ---- pitch ----

def cents(patch, note=NOTE, send=True):
    x, t0 = play(patch, 1.2, 0.1, note, send)
    # The test tones are sines, so the strongest spectral peak is the fundamental; refine around it.
    # (Autocorrelation alone picked the wrong period at +2 octaves.)
    seg = x[int((t0 + 0.15) * SR):int((t0 + 1.2) * SR)]
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    f0 = listen.pitch(seg, np.fft.rfftfreq(len(seg), 1 / SR)[int(np.argmax(spec))], 1.2)
    return round(1200 * np.log2(f0 / (440 * 2 ** ((note - 69) / 12))), 2) if f0 else None


OSC2 = {**SINE, 't1.osc1Level': 0, 't1.osc2Wave': 'Sine', 't1.osc2Level': 127, 't1.osc2Semi': 0}
TUNE_VALUES = [-63, -56, -48, -40, -32, -24, -16, -12, -8, -4, -2, -1, 0, 1, 2, 4, 8, 12, 16, 24, 32, 40, 48, 56, 63]
INT_VALUES = [0, 1, 2, 4, 8, 12, 16, 24, 32, 40, 48, 56, 63]
HELD_EG1 = {'t1.eg1A': 0, 't1.eg1D': 64, 't1.eg1S': 127}


def osc2tune(v):
    return {'cents': cents({**OSC2, 't1.osc2Tune': v})}


def patchtune(v):
    """Virtual patch EG1 -> OSC2 Tune, with EG1 held at full."""
    return {'cents': cents({**OSC2, **HELD_EG1, 't1.patch1Src': 'EG1', 't1.patch1Dst': 'OSC2 Tune',
                            't1.patch1Int': v})}


def pitchpatch(v):
    """Virtual patch EG1 -> Pitch, with EG1 held at full."""
    return {'cents': cents({**SINE, **HELD_EG1, 't1.patch1Src': 'EG1', 't1.patch1Dst': 'Pitch',
                            't1.patch1Int': v})}


def analog(v):
    """Analog Tune: the same note 8 times; spread between notes and wander within each note."""
    listen.send_program({**SINE, 't1.analogTune': v})
    per_note, wander = [], []
    for _ in range(8):
        x, t0 = play(None, 1.2, 0.1, send=False)
        seg = x[int((t0 + 0.15) * SR):int((t0 + 1.2) * SR)]
        exp = 440 * 2 ** ((NOTE - 69) / 12)
        f = listen.pitch(seg, exp)
        per_note.append(1200 * np.log2(f / exp))
        parts = [listen.pitch(p, exp) for p in np.array_split(seg, 4)]
        parts = [p for p in parts if p]
        wander.append(1200 * np.log2(max(parts) / min(parts)) if parts else 0)
    return {'note_cents': [round(c, 1) for c in per_note], 'spread_sd_cents': round(float(np.std(per_note)), 2),
            'spread_range_cents': round(float(np.ptp(per_note)), 2),
            'max_wander_within_note_cents': round(float(max(wander)), 2)}


TESTS = {
    'eg2a': (eg2a, VALUES), 'eg2d': (eg2d, VALUES), 'eg2r': (eg2r, VALUES),
    'cutoff': (cutoff, VALUES), 'egint': (egint, [0, 8, 16, 24, 32, 40, 48, 56, 63, -16, -32, -63]),
    'osc2tune': (osc2tune, TUNE_VALUES), 'patchtune': (patchtune, INT_VALUES),
    'pitchpatch': (pitchpatch, INT_VALUES), 'analog': (analog, [0, 16, 32, 64, 96, 127]),
}


def report(res):
    for name, rows in res.items():
        print(f'\n{name}')
        for v, r in sorted(rows.items(), key=lambda kv: int(kv[0])):
            print(f'  {v:>4}: ' + ', '.join(f'{k}={val}' for k, val in r.items()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('tests', nargs='*', default=list(TESTS))
    ap.add_argument('--report', action='store_true')
    a = ap.parse_args()
    res = load()
    if a.report:
        return report(res)
    for name in a.tests:
        fn, values = TESTS[name]
        done = res.setdefault(name, {})
        print(f'{name}: {fn.__doc__.strip().splitlines()[0] if fn.__doc__ else ""}', flush=True)
        for v in values:
            if str(v) in done:
                continue
            r = fn(v)
            done[str(v)] = r
            save(res)
            print(f'  {v:>4}: ' + ', '.join(f'{k}={val}' for k, val in r.items()), flush=True)
    print('Done.')


if __name__ == '__main__':
    main()
