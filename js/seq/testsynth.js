// A small Web Audio synth for hearing patterns when no instruments are connected. It's only for
// checking rhythms and notes; it doesn't try to sound like the XL.

const VOICES = {
  Bass:  { wave: 'sawtooth', cut: 380,  env: 1400, q: 7, a: .004, d: .22, s: .55, r: .07 },
  Pluck: { wave: 'square',   cut: 900,  env: 3200, q: 4, a: .002, d: .14, s: .12, r: .12 },
  Pad:   { wave: 'sawtooth', cut: 1200, env: 500,  q: 1, a: .30,  d: .60, s: .80, r: .70, detune: 10 },
  Keys:  { wave: 'triangle', cut: 4000, env: 0,    q: 1, a: .005, d: .40, s: .35, r: .30 },
};

let ac = null, master = null;
const live = new Set(); // { gain, oscs, release }

// Browsers only allow audio to start after a click or key press, so call this from one.
export function wake() {
  if (!ac) {
    ac = new AudioContext({ latencyHint: 'interactive' });
    master = ac.createGain();
    master.gain.value = 0.9;
    // A limiter, not a compressor: it only catches peaks, so turning a track up makes it louder.
    // (The compressor's default settings were squashing everything loud back down.)
    const limiter = ac.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    master.connect(limiter).connect(ac.destination);
  }
  if (ac.state === 'suspended') ac.resume();
  return ac;
}

// The master input (after wake), for other instruments to play through the same limiter.
export function output() { wake(); return master; }

// Starts a voice at audio time t0; returns a function that releases it at audio time t.
function start(voice, midi, vel, t0, gain = 1) {
  const a = wake(), v = VOICES[voice] || VOICES.Keys;
  const flt = a.createBiquadFilter(), g = a.createGain();
  flt.type = 'lowpass';
  flt.Q.value = v.q;
  flt.frequency.setValueAtTime(v.cut + v.env, t0);
  flt.frequency.exponentialRampToValueAtTime(v.cut, t0 + v.a + v.d);
  const peak = (vel / 127) * 0.22 * gain;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(peak, t0 + v.a);
  g.gain.setTargetAtTime(peak * v.s, t0 + v.a, v.d / 3);
  flt.connect(g).connect(master);
  const oscs = (v.detune ? [-v.detune, v.detune] : [0]).map(det => {
    const o = a.createOscillator();
    o.type = v.wave;
    o.frequency.value = 440 * 2 ** ((midi - 69) / 12);
    o.detune.value = det;
    o.connect(flt);
    o.start(t0);
    return o;
  });
  const ref = { g, oscs };
  live.add(ref);
  oscs[0].onended = () => { live.delete(ref); g.disconnect(); };
  return t => {
    const end = Math.max(t, t0 + v.a);
    g.gain.setTargetAtTime(0, end, v.r / 3);
    for (const o of oscs) o.stop(end + v.r * 4);
  };
}

// ---- Drums: a small synthesised kit on the General MIDI drum notes ----

let noise = null;
function noiseBuffer(a) {
  if (!noise) {
    noise = a.createBuffer(1, a.sampleRate, a.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noise;
}

// One decaying sound: a source (noise or a tone), an optional filter, and an envelope.
function hit(a, t0, { tone, type = 'sine', from, filter, freq, q = 1, level, decay, delay = 0 }) {
  const g = a.createGain();
  const t = t0 + delay;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(level, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0005, t + decay);
  let src;
  if (tone) {
    src = a.createOscillator();
    src.type = type;
    src.frequency.setValueAtTime(from || tone, t);
    if (from) src.frequency.exponentialRampToValueAtTime(tone, t + decay * 0.4);
  } else {
    src = a.createBufferSource();
    src.buffer = noiseBuffer(a);
  }
  let node = src;
  if (filter) {
    const f = a.createBiquadFilter();
    f.type = filter; f.frequency.value = freq; f.Q.value = q;
    node = node.connect(f);
  }
  node.connect(g).connect(master);
  src.start(t);
  src.stop(t + decay + 0.05);
  src.onended = () => g.disconnect();
}

const TOMS = { 41: 82, 43: 98, 45: 115, 47: 135, 48: 160, 50: 190 };
function drum(a, midi, vel, t0, gain = 1) {
  const v = (vel / 127) * 0.7 * gain;
  if (midi === 35 || midi === 36) {
    // A deep body, plus a punchier layer around 100 Hz and a beater click, so the kick is still
    // heard on laptop speakers that can't play the low end.
    hit(a, t0, { tone: 48, from: 180, level: v * 1.5, decay: 0.4 });
    hit(a, t0, { tone: 70, from: 240, type: 'triangle', level: v * 1.1, decay: 0.16 });
    hit(a, t0, { filter: 'bandpass', freq: 2500, q: 0.8, level: v * 0.5, decay: 0.015 }); // click
  } else if (midi === 37) hit(a, t0, { tone: 1700, type: 'square', filter: 'bandpass', freq: 1700, q: 4, level: v * 0.6, decay: 0.035 });
  else if (midi === 38 || midi === 40) {
    hit(a, t0, { filter: 'highpass', freq: 1200, level: v * 0.8, decay: 0.18 });
    hit(a, t0, { tone: 185, type: 'triangle', level: v * 0.7, decay: 0.1 });
  } else if (midi === 39) {
    for (const delay of [0, 0.011, 0.022]) hit(a, t0, { filter: 'bandpass', freq: 1400, q: 1.5, level: v, decay: 0.03, delay });
    hit(a, t0, { filter: 'bandpass', freq: 1400, q: 1.5, level: v * 0.8, decay: 0.17, delay: 0.03 });
  } else if (midi === 42 || midi === 44) hit(a, t0, { filter: 'highpass', freq: 7500, level: v * 0.55, decay: midi === 44 ? 0.04 : 0.055 });
  else if (midi === 46) hit(a, t0, { filter: 'highpass', freq: 7000, level: v * 0.5, decay: 0.38 });
  else if (midi === 49 || midi === 57) hit(a, t0, { filter: 'highpass', freq: 4500, level: v * 0.5, decay: 1.4 });
  else if (midi === 51 || midi === 59) {
    hit(a, t0, { filter: 'highpass', freq: 8000, level: v * 0.35, decay: 0.7 });
    hit(a, t0, { tone: 3100, type: 'square', filter: 'bandpass', freq: 3100, q: 8, level: v * 0.08, decay: 0.5 });
  } else if (midi === 56) {
    for (const tone of [540, 800]) hit(a, t0, { tone, type: 'square', filter: 'bandpass', freq: tone, q: 3, level: v * 0.35, decay: 0.28 });
  } else if (midi === 69 || midi === 70) hit(a, t0, { filter: 'highpass', freq: 6000, level: v * 0.35, decay: 0.07 });
  else if (midi >= 60 && midi <= 64) hit(a, t0, { tone: [0, 0, 330, 220, 180][midi - 60] || 260, from: 400, level: v, decay: 0.2 }); // bongos, congas
  else if (TOMS[midi]) hit(a, t0, { tone: TOMS[midi], from: TOMS[midi] * 1.6, level: v * 1.2, decay: 0.35 });
  else hit(a, t0, { filter: 'bandpass', freq: 2000 + (midi % 12) * 300, q: 2, level: v * 0.5, decay: 0.08 });
}

// A metronome click at a performance.now() time: higher on the first beat of a bar. level 0-1.
export function click(atMs, accent, level = 0.6) {
  const a = wake();
  const t0 = Math.max(a.currentTime, a.currentTime + (atMs - performance.now()) / 1000);
  const tone = accent ? 2000 : 1400;
  hit(a, t0, { tone, type: 'square', filter: 'bandpass', freq: tone, q: 6, level: level * (accent ? 0.9 : 0.6), decay: 0.04 });
}

// Plays a note at a performance.now() time (as the engine uses), for durMs. `gain` is the
// track's volume (1 = normal).
export function play(voice, midi, vel, atMs, durMs, gain = 1) {
  const a = wake();
  const t0 = Math.max(a.currentTime, a.currentTime + (atMs - performance.now()) / 1000);
  if (voice === 'Drums') { drum(a, midi, vel, t0, gain); return; }
  start(voice, midi, vel, t0, gain)(t0 + durMs / 1000);
}

// Starts a note now and returns a function that releases it (for keys played through).
export function hold(voice, midi, vel, gain = 1) {
  const a = wake();
  if (voice === 'Drums') { drum(a, midi, vel, a.currentTime, gain); return () => {}; }
  const release = start(voice, midi, vel, a.currentTime, gain);
  return () => release(a.currentTime);
}

// Quick fade on everything sounding (Stop).
export function stopAll() {
  if (!ac) return;
  const t = ac.currentTime;
  for (const { g, oscs } of live) {
    g.gain.cancelScheduledValues(t);
    g.gain.setTargetAtTime(0, t, 0.02);
    for (const o of oscs) { try { o.stop(t + 0.15); } catch { /* already stopped */ } }
  }
}
