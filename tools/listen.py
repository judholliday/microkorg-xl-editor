# /// script
# requires-python = ">=3.10"
# dependencies = ["sounddevice", "numpy", "mido", "python-rtmidi", "matplotlib"]
# ///
"""Play a note on the microKORG XL and record it through the audio interface, so Claude can
"hear" the synth: prints level, pitch, envelope and brightness, and saves a .wav and a
spectrogram .png.

    uv run tools/listen.py devices
    uv run tools/listen.py note [--note 60] [--vel 100] [--gate 1.5] [--tail 1.5] [--out recordings/test]
                                [--patch '{"t1.osc1Wave": "Sine"}']

The XL's USB port carries MIDI only, so its audio must be cabled into the interface (e.g. the
Focusrite). Notes go to the XL's SOUND port on the global channel (2 on the user's synth).
"""
import argparse
import sys
import threading
import time
import wave
from pathlib import Path

import mido
import numpy as np
import sounddevice as sd

SR = 48000


def find_input(name=None):
    for i, d in enumerate(sd.query_devices()):
        if d['max_input_channels'] < 1:
            continue
        label = d['name'].lower()
        if (name and name.lower() in label) or (not name and ('scarlett' in label or 'focusrite' in label)):
            return i, d
    return None, None


def find_midi_out(name=None):
    for n in mido.get_output_names():
        if (name and name.lower() in n.lower()) or (not name and n.upper().endswith('SOUND')):
            return n
    return None


def devices():
    print('Audio inputs:')
    for i, d in enumerate(sd.query_devices()):
        if d['max_input_channels']:
            print(f"  {i}: {d['name']} ({d['max_input_channels']} in)")
    print('MIDI outputs:', ', '.join(mido.get_output_names()) or '(none)')
    i, d = find_input()
    print('Interface:', d['name'] if d else 'not found', '| XL:', find_midi_out() or 'not found')


ROOT = Path(__file__).resolve().parent.parent
SETUP = ROOT / 'recordings/setup.json'  # this interface's left/right gain correction, from `balance`


def setup():
    import json
    try:
        return json.loads(SETUP.read_text())
    except (OSError, ValueError):
        return {}


def program_dump(changes, channel=2):
    """SysEx for the init program plus changes (AI value format), built by tools/xlpatch.mjs."""
    import json
    import subprocess
    r = subprocess.run(['node', str(ROOT / 'tools/xlpatch.mjs'), json.dumps(changes), str(channel)],
                       capture_output=True, text=True)
    if r.returncode:
        sys.exit(f'Bad patch: {r.stderr.strip()}')
    return bytes.fromhex(r.stdout.strip())


def send_program(changes, channel=2, midi_name=None):
    """Replace the XL's edit buffer with the init program plus changes."""
    port_name = find_midi_out(midi_name)
    if not port_name:
        sys.exit('The XL\'s SOUND MIDI port was not found. Is it connected by USB?')
    data = program_dump(changes, channel)
    with mido.open_output(port_name) as port:
        port.send(mido.Message('sysex', data=data[1:-1]))  # mido adds F0/F7
    time.sleep(0.3)  # let the synth load it


def record_note(note, vel, gate, tail, channel, audio_name=None, midi_name=None):
    dev, info = find_input(audio_name)
    port_name = find_midi_out(midi_name)
    if dev is None:
        sys.exit('No audio interface found (looked for Scarlett/Focusrite). Run: uv run tools/listen.py devices')
    if not port_name:
        sys.exit('The XL\'s SOUND MIDI port was not found. Is it connected by USB?')
    chans = min(2, info['max_input_channels'])
    pre = 0.3
    total = pre + gate + tail
    buf = sd.rec(int(total * SR), samplerate=SR, channels=chans, device=dev, dtype='float32')
    with mido.open_output(port_name) as port:
        time.sleep(pre)
        port.send(mido.Message('note_on', note=note, velocity=vel, channel=channel - 1))
        time.sleep(gate)
        port.send(mido.Message('note_off', note=note, velocity=0, channel=channel - 1))
    sd.wait()
    # The XL's L and R outputs go to inputs 1 and 2. Returns (frames, 2); if only one input carries
    # signal (a mono cable), that input is used for both sides.
    buf = buf.astype(np.float64)
    if chans == 1:
        buf = np.repeat(buf, 2, axis=1)
    peaks = np.abs(buf).max(axis=0)
    if peaks.min() < peaks.max() * 0.03:
        buf[:, :] = buf[:, [int(np.argmax(peaks))]]
    else:
        buf[:, 0] *= 10 ** (setup().get('left_gain_db', 0) / 20)
    return buf, pre, info['name']


def db(x):
    return 20 * np.log10(max(x, 1e-9))


def analyse(x, pre, gate, note):
    out = {}
    out['peak_dbfs'] = round(db(np.abs(x).max()), 1)
    noise = x[: int(0.2 * SR)]
    out['noise_floor_dbfs'] = round(db(np.sqrt(np.mean(noise ** 2))), 1)
    hop = int(0.005 * SR)
    frames = len(x) // hop
    rms = np.array([np.std(x[i * hop:(i + 1) * hop]) for i in range(frames)])  # std: ignores DC drift
    t = np.arange(frames) * hop / SR
    peak = rms.max()
    thresh = max(peak * 0.1, 10 ** (out['noise_floor_dbfs'] / 20) * 4)
    on = np.argmax(rms > thresh)
    out['onset_s_after_note_on'] = round(t[on] - pre, 3)
    pk = on + int(np.argmax(rms[on:int((pre + gate) * SR / hop)]))
    a10 = on + np.argmax(rms[on:] >= peak * 0.1)
    a90 = on + np.argmax(rms[on:] >= peak * 0.9)
    out['attack_10_90_ms'] = round((t[a90] - t[a10]) * 1000, 1)
    a3 = on + np.argmax(rms[on:] >= peak * 10 ** (-3 / 20))
    out['attack_to_-3dB_ms'] = round((t[a3] - t[on]) * 1000, 1)
    out['time_to_peak_ms'] = round((t[pk] - t[on]) * 1000, 1)
    off = int((pre + gate) * SR / hop)
    sus = rms[max(off - 20, 0):off].mean()
    out['level_before_release_vs_peak_db'] = round(db(sus) - db(peak), 1)
    # Release: time from note-off until the level has fallen 20 and 40 dB below where it was,
    # as far as the noise floor allows.
    after = rms[off:]
    headroom = db(sus) - out['noise_floor_dbfs']
    for drop in (20, 40):
        key = f'release_to_-{drop}dB_ms'
        if headroom < drop + 6:
            out[key] = f'too quiet to measure ({headroom:.0f} dB above the noise)'
            continue
        hit = np.nonzero(after < sus * 10 ** (-drop / 20))[0]
        out[key] = round(hit[0] * hop / SR * 1000, 1) if len(hit) else 'longer than the recording'
    # Pitch over the held part of the note (from 150 ms after the peak to note-off).
    s, e = int((min(t[a90], t[on] + 0.3) + 0.1) * SR), int((pre + gate) * SR)
    f0 = pitch(x[s:e], 440 * 2 ** ((note - 69) / 12))
    if f0:
        out['pitch_hz'] = round(f0, 3)
        out['pitch_cents_vs_note'] = round(1200 * np.log2(f0 / (440 * 2 ** ((note - 69) / 12))), 2)
    # Brightness: spectral centroid every 50 ms, ignoring bins at the noise floor and frames that
    # are too quiet to judge (shown as None).
    win = int(0.05 * SR)
    hann = np.hanning(win)
    f = np.fft.rfftfreq(win, 1 / SR)
    nspec = np.abs(np.fft.rfft(x[:win] * hann))
    floor = np.convolve(nspec, np.ones(9) / 9, 'same') * 4 + 1e-12
    cents = []
    for i in range(int(t[on] * SR), len(x) - win, win):
        spec = np.abs(np.fft.rfft(x[i:i + win] * hann))
        spec = np.where(spec > floor, spec, 0)
        loud = np.sqrt(np.mean(x[i:i + win] ** 2)) > 10 ** (out['noise_floor_dbfs'] / 20) * 10
        cents.append(int((spec * f).sum() / spec.sum()) if loud and spec.sum() > 0 else None)
    while cents and cents[-1] is None:
        cents.pop()
    out['brightness_hz_every_50ms'] = cents[:40]
    return out


def pitch(seg, expected, span=2.2):
    """Fundamental in Hz, accurate to a fraction of a cent on steady tones. Coarse estimate by
    autocorrelation, refined with the harmonic peaks of a zero-padded Hann-windowed FFT."""
    seg = seg - seg.mean()
    if len(seg) < 4096 or np.abs(seg).max() < 1e-4:
        return None
    ac = np.fft.irfft(np.abs(np.fft.rfft(seg, 2 * len(seg))) ** 2)[:len(seg)]
    lo, hi = int(SR / (expected * span)), min(int(SR / (expected / span)), len(ac) - 1)
    lag = lo + int(np.argmax(ac[lo:hi]))
    coarse = SR / lag
    n = 1 << int(np.ceil(np.log2(len(seg) * 8)))
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg)), n))
    hz = SR / n
    ests, weights = [], []
    for h in range(1, 9):  # the first 8 harmonics, each divided back down to the fundamental
        target = coarse * h
        if target > SR / 2 - 200:
            break
        a, b = int((target * 0.97) / hz), int((target * 1.03) / hz)
        k = a + int(np.argmax(spec[a:b]))
        if spec[k] < spec.max() * 0.01:
            continue
        l, m, r = np.log(spec[k - 1:k + 2] + 1e-12)
        k = k + 0.5 * (l - r) / (l - 2 * m + r)
        ests.append(k * hz / h)
        weights.append(spec[int(k)])
    return float(np.average(ests, weights=weights)) if ests else coarse


def stereo(st):
    """Left/right balance and width of a (frames, 2) recording."""
    l, r = st[:, 0], st[:, 1]
    rl, rr = np.std(l), np.std(r)
    corr = float(np.corrcoef(l, r)[0, 1]) if rl > 1e-6 and rr > 1e-6 else 1.0
    return {'left_minus_right_db': round(db(rl) - db(rr), 1),
            'stereo_correlation': round(corr, 3)}  # 1 = mono, 0 = unrelated, <0 = out of phase


def save(st, path, note, title):
    x = st.mean(axis=1)
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(st, -1, 1)  # true level, so clipping in the recording stays visible
    with wave.open(str(path.with_suffix('.wav')), 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((pcm * 32767).astype('<i2').tobytes())
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(10, 6), sharex=True, gridspec_kw={'height_ratios': [1, 2]})
    tt = np.arange(len(x)) / SR
    a1.plot(tt, x, lw=0.4)
    a1.set_ylabel('level')
    a1.set_title(title)
    a2.specgram(x, NFFT=2048, Fs=SR, noverlap=1536, cmap='magma', vmin=-120)
    a2.set_ylim(0, 8000)
    a2.set_ylabel('Hz')
    a2.set_xlabel('seconds')
    fig.tight_layout()
    fig.savefig(path.with_suffix('.png'), dpi=90)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['devices', 'note', 'balance'])
    ap.add_argument('--note', type=int, default=60)
    ap.add_argument('--vel', type=int, default=100)
    ap.add_argument('--gate', type=float, default=1.5)
    ap.add_argument('--tail', type=float, default=1.5)
    ap.add_argument('--channel', type=int, default=2)
    ap.add_argument('--audio', help='part of the audio input name')
    ap.add_argument('--midi', help='part of the MIDI output name')
    ap.add_argument('--out', default='recordings/test')
    ap.add_argument('--patch', help='send the init program plus these changes first, as JSON in the AI '
                    'value format, e.g. \'{"t1.osc1Wave": "Sine"}\'. Replaces the edit buffer.')
    a = ap.parse_args()
    if a.cmd == 'devices':
        return devices()
    if a.cmd == 'balance':
        # A centred sine: whatever L/R difference remains is the interface's input gains.
        import json
        send_program({'name': 'BALANCE', 't1.osc1Wave': 'Sine', 't1.osc2Level': 0, 't1.ampLevel': 127,
                      't1.pan': 0, 't1.analogTune': 0}, a.channel, a.midi)
        SETUP.parent.mkdir(parents=True, exist_ok=True)
        SETUP.write_text(json.dumps({**setup(), 'left_gain_db': 0}))
        st, pre, dev = record_note(57, 100, 1.5, 0.5, a.channel, a.audio, a.midi)
        diff = stereo(st[int((pre + 0.2) * SR):int((pre + 1.5) * SR)])['left_minus_right_db']
        SETUP.write_text(json.dumps({**setup(), 'left_gain_db': -diff}))
        return print(f'Left was {diff:+.1f} dB vs right; recordings now correct it ({SETUP}).')
    if a.patch is not None:
        import json
        send_program(json.loads(a.patch), a.channel, a.midi)
    st, pre, dev = record_note(a.note, a.vel, a.gate, a.tail, a.channel, a.audio, a.midi)
    res = analyse(st.mean(axis=1), pre, a.gate, a.note)
    res['peak_dbfs'] = round(db(np.abs(st).max()), 1)  # the louder side, for clipping
    res.update(stereo(st[int(pre * SR):int((pre + a.gate) * SR)]))
    out = Path(a.out)
    save(st, out, a.note, f'note {a.note} vel {a.vel}, {dev}')
    print(f'Recorded from {dev} (inputs 1+2).')
    for k, v in res.items():
        print(f'  {k}: {v}')
    print(f'Saved {out.with_suffix(".wav")} and {out.with_suffix(".png")}')
    if res['peak_dbfs'] > -1:
        print('  Warning: close to clipping. Turn the interface gain down.')
    if res['peak_dbfs'] < -40:
        print('  Warning: very quiet. Check the cable, the input, and the gain.')


if __name__ == '__main__':
    main()
