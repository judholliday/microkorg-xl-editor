// Plays Lab patches (see patch.js) with Web Audio. Each note builds its own small graph of nodes
// from the patch's voice modules; the effects (global modules) are built once per instrument.
// Times are AudioContext seconds; atTime() converts from performance.now() milliseconds.
//
//   const synth = new LabSynth(audioContext, destinationNode);
//   synth.setPatch(patch);
//   synth.play(60, 100, synth.atTime(performance.now()), 0.5);   // or noteOn / noteOff
import { MODULES } from './patch.js';

const OSC_TYPES = { saw: 'sawtooth', square: 'square', triangle: 'triangle', sine: 'sine' };
const LFO_TYPES = { sine: 'sine', triangle: 'triangle', square: 'square', saw: 'sawtooth' };
const STEP = 128; // samples per step of the random LFO's buffer

// Shared buffers and curves, made once per AudioContext.
const shared = new WeakMap();
function assets(ac) {
  let a = shared.get(ac);
  if (a) return a;
  const noise = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  // Pulse: a sawtooth plus an offset through a hard comparator; the offset sets the width.
  const comparator = new Float32Array(2048);
  for (let i = 0; i < comparator.length; i++) comparator[i] = i < comparator.length / 2 ? -1 : 1;
  // Random (sample & hold) LFO: a looped buffer of random steps, played at the LFO's rate.
  const steps = ac.createBuffer(1, 64 * STEP, ac.sampleRate), sd = steps.getChannelData(0);
  for (let k = 0; k < 64; k++) { const v = Math.random() * 2 - 1; sd.fill(v, k * STEP, (k + 1) * STEP); }
  const cosine = ac.createPeriodicWave(new Float32Array([0, 1]), new Float32Array([0, 0])); // for orbits
  a = { noise, comparator, steps, cosine, drives: new Map() };
  shared.set(ac, a);
  return a;
}
function driveCurve(ac, amount) {
  const cache = assets(ac).drives, key = Math.round(amount * 100);
  if (!cache.has(key)) {
    const k = 0.5 + key / 100 * 30, c = new Float32Array(1024);
    for (let i = 0; i < c.length; i++) { const x = i / (c.length - 1) * 2 - 1; c[i] = Math.tanh(k * x) / Math.tanh(k); }
    cache.set(key, c);
  }
  return cache.get(key);
}
function impulse(ac, seconds) {
  const len = Math.max(1, Math.round(ac.sampleRate * seconds)), buf = ac.createBuffer(2, len, ac.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.5;
  }
  return buf;
}

const hz = (note, octave = 0, semi = 0) => 440 * 2 ** ((note - 69) / 12 + octave + semi / 12);
const rad = d => d * Math.PI / 180;
// Modulation amounts are in the target's units; pulse width is scaled to the comparator offset.
const modScale = key => (key === 'pw' ? 2 : 1);

// Attack-decay-sustain on an AudioParam from t0, up to `peak`.
function envOn(param, t0, p, peak = 1) {
  param.cancelScheduledValues(t0);
  param.setValueAtTime(0, t0);
  param.linearRampToValueAtTime(peak, t0 + p.attack);
  param.setTargetAtTime(p.sustain * peak, t0 + p.attack, p.decay / 4);
}
function envOff(param, t, release) {
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(t); else param.cancelScheduledValues(t);
  param.setTargetAtTime(0, t, release / 4);
}

// One drum hit for a General MIDI note into `out`; returns how long it lasts (s).
// p: { tune (semitones), decay (× the normal length), tone (0 dark - 1 bright) }.
function drumHit(ac, a, note, vel, t0, p, out, src, keep) {
  const v = (vel / 127) ** 1.2, tune = 2 ** (p.tune / 12), dk = p.decay, bright = 0.5 + p.tone;
  let longest = 0;
  const hit = ({ tone, from, type = 'sine', filter, freq, q = 1, level, decay, delay = 0 }) => {
    const t = t0 + delay, d = decay * dk, g = keep(ac.createGain());
    g.gain.setValueAtTime(0, t0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level * v, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0005, t + d);
    let s;
    if (tone) {
      s = src(ac.createOscillator());
      s.type = type;
      s.frequency.setValueAtTime((from || tone) * tune, t);
      if (from) s.frequency.exponentialRampToValueAtTime(tone * tune, t + d * 0.4);
    } else {
      s = src(ac.createBufferSource());
      s.buffer = a.noise;
      s.loop = true;
      s.loopStart = Math.random();
    }
    let n = s;
    if (filter) {
      const f = keep(ac.createBiquadFilter());
      f.type = filter; f.frequency.value = Math.min(18000, freq * (filter === 'lowpass' ? 1 : bright)); f.Q.value = q;
      n = n.connect(f);
    }
    n.connect(g).connect(out);
    longest = Math.max(longest, delay + d + 0.05);
  };
  if (note === 35 || note === 36) {
    hit({ tone: 48, from: 180, level: 1.4, decay: 0.45 });
    hit({ tone: 70, from: 240, type: 'triangle', level: 0.9, decay: 0.16 });
    hit({ filter: 'bandpass', freq: 2500, q: 0.8, level: 0.35 * bright, decay: 0.015 });
  } else if (note === 37) hit({ tone: 1700, type: 'square', filter: 'bandpass', freq: 1700, q: 4, level: 0.5, decay: 0.035 });
  else if (note === 38 || note === 40) {
    hit({ filter: 'highpass', freq: 1200, level: 0.7, decay: 0.2 });
    hit({ tone: 185, type: 'triangle', level: 0.6, decay: 0.11 });
  } else if (note === 39) {
    for (const delay of [0, 0.011, 0.022]) hit({ filter: 'bandpass', freq: 1400, q: 1.5, level: 0.8, decay: 0.03, delay });
    hit({ filter: 'bandpass', freq: 1400, q: 1.5, level: 0.6, decay: 0.18, delay: 0.03 });
  } else if (note === 42 || note === 44) hit({ filter: 'highpass', freq: 7500, level: 0.45, decay: note === 44 ? 0.04 : 0.06 });
  else if (note === 46) hit({ filter: 'highpass', freq: 7000, level: 0.4, decay: 0.4 });
  else if (note === 49 || note === 57) hit({ filter: 'highpass', freq: 4500, level: 0.4, decay: 1.5 });
  else if (note === 51 || note === 59) {
    hit({ filter: 'highpass', freq: 8000, level: 0.3, decay: 0.8 });
    hit({ tone: 3100, type: 'square', filter: 'bandpass', freq: 3100, q: 8, level: 0.07, decay: 0.6 });
  } else if (note === 56) for (const tone of [540, 800]) hit({ tone, type: 'square', filter: 'bandpass', freq: tone, q: 3, level: 0.3, decay: 0.3 });
  else if (note === 69 || note === 70) hit({ filter: 'highpass', freq: 6000, level: 0.3, decay: 0.07 });
  else if (note >= 41 && note <= 50) { const f = 70 * 2 ** ((note - 41) / 9); hit({ tone: f, from: f * 1.6, level: 1, decay: 0.35 }); }
  else if (note >= 60 && note <= 64) hit({ tone: [380, 300, 330, 220, 180][note - 60], from: 420, level: 0.8, decay: 0.2 });
  else hit({ tone: hz(note), type: 'triangle', level: 0.6, decay: 0.15 }); // anything else: a short blip at its pitch
  return longest;
}

export class LabSynth {
  constructor(ac, destination = ac.destination) {
    this.ac = ac;
    this.out = ac.createGain();
    this.out.connect(destination);
    this.bus = ac.createGain(); // where voices and effects meet before the volume
    this.bus.connect(this.out);
    this.wheel = ac.createConstantSource();
    this.wheel.offset.value = 0;
    this.wheel.start();
    // Pitch bend, -1 to 1, scaled to cents for every oscillator.
    this.bend = ac.createConstantSource();
    this.bend.offset.value = 0;
    this.bendCents = ac.createGain();
    this.bendCents.gain.value = 200; // ± 2 semitones
    this.bend.connect(this.bendCents);
    this.bend.start();
    this.voices = [];
    this.globals = new Map();
    this.gain = 1;
    this.patch = null;
  }

  atTime(ms) { return Math.max(this.ac.currentTime, this.ac.currentTime + (ms - performance.now()) / 1000); }

  // A new patch: settings-only changes update sounding notes; new modules or connections rebuild
  // the effects and cut sounding notes short.
  setPatch(input) {
    const patch = JSON.parse(JSON.stringify(input)); // our own copy; change it with setParam / setMod
    // Settings marked `rebuild` (an oscillator's wave, a filter's slope...) change which nodes a note uses.
    const shape = p => JSON.stringify([p.modules.map(m => [m.id, m.type, ...MODULES[m.type].params.filter(x => x.rebuild).map(x => m.params[x.key])]), p.audio, p.mod.map(m => [m.from, m.to])]);
    const old = this.patch;
    this.patch = patch;
    if (old && shape(old) === shape(patch)) {
      for (const m of patch.modules) for (const [k, v] of Object.entries(m.params)) if (old.modules.find(x => x.id === m.id)?.params[k] !== v) this.applyParam(m.id, k, v);
      patch.mod.forEach((c, i) => { if (old.mod[i]?.amount !== c.amount) this.applyMod(c); });
      this.setVolume();
      return;
    }
    this.allOff(true);
    this.buildGlobals();
    this.setVolume();
  }

  setGain(g) { this.gain = g; this.setVolume(); }
  setVolume() { if (this.patch) this.out.gain.setTargetAtTime(this.patch.volume * this.gain, this.ac.currentTime, 0.02); }
  setWheel(v) { this.wheel.offset.setTargetAtTime(v, this.ac.currentTime, 0.01); }
  setBend(v) { this.bend.offset.setTargetAtTime(v, this.ac.currentTime, 0.005); }

  // One setting of one module, or one modulation amount, while notes sound.
  setParam(id, key, value) {
    const m = this.patch?.modules.find(x => x.id === id);
    if (!m) return;
    m.params[key] = value;
    this.applyParam(id, key, value);
  }
  setMod(index, amount) {
    const c = this.patch?.mod[index];
    if (!c) return;
    c.amount = amount;
    this.applyMod(c);
  }
  applyParam(id, key, value) {
    for (const v of this.voices) v.set[`${id}.${key}`]?.(value);
    this.globals.get(id)?.set[key]?.(value);
  }
  applyMod(c) { for (const v of this.voices) v.set[`mod:${c.from}>${c.to}`]?.(c.amount); }

  // ---- effects ----
  buildGlobals() {
    for (const g of this.globals.values()) g.nodes.forEach(n => { try { n.stop?.(); } catch { /* not started */ } n.disconnect(); });
    this.globals.clear();
    const ac = this.ac, t = ac.currentTime;
    for (const m of this.patch.modules) {
      if (MODULES[m.type].scope !== 'global') continue;
      const p = m.params, input = ac.createGain(), output = ac.createGain(), dry = ac.createGain(), wet = ac.createGain();
      input.connect(dry).connect(output);
      wet.connect(output);
      const g = { input, output, nodes: [input, output, dry, wet], set: {} };
      const mix = (wetAmount, dryAmount = 1 - wetAmount) => { wet.gain.setTargetAtTime(wetAmount, ac.currentTime, 0.02); dry.gain.setTargetAtTime(dryAmount, ac.currentTime, 0.02); };
      if (m.type === 'chorus') {
        const lfo = ac.createOscillator(), depth = ac.createGain();
        lfo.frequency.value = p.rate;
        depth.gain.value = p.depth * 0.004;
        lfo.connect(depth);
        for (const [base, pan] of [[0.012, -0.7], [0.019, 0.7]]) {
          const d = ac.createDelay(0.1), panner = ac.createStereoPanner(), inv = ac.createGain();
          d.delayTime.value = base;
          panner.pan.value = pan;
          inv.gain.value = pan < 0 ? 1 : -1; // the two sides move opposite ways
          depth.connect(inv).connect(d.delayTime);
          input.connect(d).connect(panner).connect(wet);
          g.nodes.push(d, panner, inv);
        }
        lfo.start(t);
        g.nodes.push(lfo, depth);
        g.set = { rate: v => lfo.frequency.setTargetAtTime(v, ac.currentTime, 0.05), depth: v => depth.gain.setTargetAtTime(v * 0.004, ac.currentTime, 0.05), mix: v => mix(v, 1 - v * 0.5) };
        mix(p.mix, 1 - p.mix * 0.5);
      } else if (m.type === 'delay') {
        const d = ac.createDelay(2.5), fb = ac.createGain(), tone = ac.createBiquadFilter();
        d.delayTime.value = p.time;
        fb.gain.value = p.feedback;
        tone.type = 'lowpass';
        tone.frequency.value = 4500;
        input.connect(d).connect(tone).connect(fb).connect(d);
        tone.connect(wet);
        g.nodes.push(d, fb, tone);
        g.set = { time: v => d.delayTime.setTargetAtTime(v, ac.currentTime, 0.05), feedback: v => fb.gain.setTargetAtTime(v, ac.currentTime, 0.02), mix: v => mix(v, 1) };
        mix(p.mix, 1);
      } else if (m.type === 'reverb') {
        const conv = ac.createConvolver();
        conv.buffer = impulse(ac, p.size);
        input.connect(conv).connect(wet);
        g.nodes.push(conv);
        let timer = null;
        g.set = { size: v => { clearTimeout(timer); timer = setTimeout(() => { conv.buffer = impulse(ac, v); }, 150); }, mix: v => mix(v, 1 - v * 0.4) };
        mix(p.mix, 1 - p.mix * 0.4);
      }
      this.globals.set(m.id, g);
    }
    for (const c of this.patch.audio) {
      const from = this.globals.get(c.from);
      if (!from) continue;
      from.output.connect(c.to === 'out' ? this.bus : this.globals.get(c.to).input);
    }
  }

  // ---- notes ----
  noteOn(note, vel, t0 = this.ac.currentTime) {
    if (!this.patch) return null;
    for (const v of this.voices) if (v.note === note && !v.released) this.release(v, t0);
    const live = this.voices.filter(v => v.end > t0);
    if (live.length >= this.patch.voices) this.kill(live.find(v => v.released) || live[0], t0);
    const v = this.buildVoice(note, vel, t0);
    this.voices.push(v);
    this.voices = this.voices.filter(x => x.end === Infinity || x.end > this.ac.currentTime - 0.1);
    return v;
  }
  noteOff(note, t = this.ac.currentTime) {
    for (const v of this.voices) if (v.note === note && !v.released) this.release(v, t);
  }
  play(note, vel, t0, dur) { const v = this.noteOn(note, vel, t0); if (v) this.release(v, t0 + dur); }

  // Fast fade on everything (Stop, or a rebuild).
  allOff(now = false) {
    const t = this.ac.currentTime;
    for (const v of this.voices) if (now || !v.released) this.kill(v, t);
  }

  release(v, t) {
    if (v.released) return;
    v.released = true;
    for (const f of v.offs) f(t);
    v.stopAt(t + v.tail);
  }
  kill(v, t) {
    v.released = true;
    for (const e of v.exits) { e.gain.cancelScheduledValues(t); e.gain.setTargetAtTime(0, t, 0.006); }
    v.stopAt(t + 0.05);
  }

  buildVoice(note, vel, t0) {
    const ac = this.ac, patch = this.patch, a = assets(ac);
    const nodes = {}, sources = [], all = [], offs = [], set = {}, exits = [];
    const keep = n => { all.push(n); return n; };
    const src = n => { sources.push(n); return keep(n); };
    let tail = 0.02, gated = false, minEnd = 0; // gated: something shapes the note's end (an Amp, an FM operator...)
    for (const m of patch.modules) {
      const p = m.params;
      if (MODULES[m.type].scope !== 'voice') continue;
      if (m.type === 'osc') {
        const out = keep(ac.createGain());
        out.gain.value = p.level;
        const osc = src(ac.createOscillator());
        osc.frequency.value = hz(note, p.octave, p.semi);
        osc.detune.value = p.fine;
        this.bendCents.connect(osc.detune);
        const targets = { pitch: [osc.detune], level: [out.gain] };
        if (p.wave === 'pulse') {
          osc.type = 'sawtooth';
          const shaper = keep(ac.createWaveShaper()), offset = src(ac.createConstantSource());
          shaper.curve = a.comparator;
          shaper.oversample = '4x';
          offset.offset.value = 2 * p.pw - 1;
          osc.connect(shaper);
          offset.connect(shaper);
          shaper.connect(out);
          targets.pw = [offset.offset];
          set[`${m.id}.pw`] = v => offset.offset.setTargetAtTime(2 * v - 1, ac.currentTime, 0.01);
        } else {
          osc.type = OSC_TYPES[p.wave];
          osc.connect(out);
          targets.pw = [];
        }
        const retune = () => osc.frequency.setTargetAtTime(hz(note, m.params.octave, m.params.semi), ac.currentTime, 0.005);
        Object.assign(set, { [`${m.id}.octave`]: retune, [`${m.id}.semi`]: retune,
          [`${m.id}.fine`]: v => osc.detune.setTargetAtTime(v, ac.currentTime, 0.01),
          [`${m.id}.level`]: v => out.gain.setTargetAtTime(v, ac.currentTime, 0.01) });
        nodes[m.id] = { out, targets };
      } else if (m.type === 'noise') {
        const n = src(ac.createBufferSource()), out = keep(ac.createGain());
        n.buffer = a.noise;
        n.loop = true;
        n.loopStart = Math.random();
        out.gain.value = p.level;
        n.connect(out);
        set[`${m.id}.level`] = v => out.gain.setTargetAtTime(v, ac.currentTime, 0.01);
        nodes[m.id] = { out, targets: { level: [out.gain] } };
      } else if (m.type === 'filter') {
        const f1 = keep(ac.createBiquadFilter()), f2 = p.slope === '24' ? keep(ac.createBiquadFilter()) : null;
        const fs = f2 ? [f1, f2] : [f1];
        const cutoff = () => Math.min(ac.sampleRate * 0.45, Math.max(20, m.params.cutoff * 2 ** ((note - 60) / 12 * m.params.keytrack)));
        for (const f of fs) { f.type = p.type; f.frequency.value = cutoff(); f.Q.value = 0.707; }
        f1.Q.value = p.resonance;
        if (f2) f1.connect(f2);
        Object.assign(set, {
          [`${m.id}.cutoff`]: () => fs.forEach(f => f.frequency.setTargetAtTime(cutoff(), ac.currentTime, 0.01)),
          [`${m.id}.keytrack`]: () => fs.forEach(f => f.frequency.setTargetAtTime(cutoff(), ac.currentTime, 0.01)),
          [`${m.id}.resonance`]: v => f1.Q.setTargetAtTime(v, ac.currentTime, 0.01),
          [`${m.id}.type`]: v => fs.forEach(f => { f.type = v; }),
        });
        nodes[m.id] = { in: f1, out: f2 || f1, targets: { cutoff: fs.map(f => f.detune), resonance: [f1.Q] } };
      } else if (m.type === 'drive') {
        const sh = keep(ac.createWaveShaper());
        sh.curve = driveCurve(ac, p.amount);
        sh.oversample = '2x';
        set[`${m.id}.amount`] = v => { sh.curve = driveCurve(ac, v); };
        nodes[m.id] = { in: sh, out: sh, targets: {} };
      } else if (m.type === 'amp') {
        gated = true;
        const env = keep(ac.createGain()), level = keep(ac.createGain());
        level.gain.value = p.level;
        env.connect(level);
        envOn(env.gain, t0, p, 1 - p.velocity + p.velocity * (vel / 127) ** 1.5);
        offs.push(t => envOff(env.gain, t, m.params.release));
        tail = Math.max(tail, p.release * 1.6);
        set[`${m.id}.level`] = v => level.gain.setTargetAtTime(v, ac.currentTime, 0.01);
        nodes[m.id] = { in: env, out: level, targets: { level: [level.gain] } };
      } else if (m.type === 'env') {
        const c = src(ac.createConstantSource());
        envOn(c.offset, t0, p);
        offs.push(t => envOff(c.offset, t, m.params.release));
        nodes[m.id] = { out: c, targets: {} };
      } else if (m.type === 'lfo') {
        const depth = keep(ac.createGain()), fade = keep(ac.createGain());
        let osc, rate, perHz = 1;
        if (p.wave === 'random') {
          // Stepped random: the step buffer played so that `rate` steps go by each second.
          osc = src(ac.createBufferSource());
          osc.buffer = a.steps;
          osc.loop = true;
          perHz = STEP / ac.sampleRate;
          osc.playbackRate.value = p.rate * perHz;
          rate = osc.playbackRate;
        } else {
          osc = src(ac.createOscillator());
          osc.type = LFO_TYPES[p.wave];
          osc.frequency.value = p.rate;
          rate = osc.frequency;
        }
        depth.gain.value = p.depth;
        fade.gain.setValueAtTime(p.delay > 0 ? 0 : 1, t0);
        if (p.delay > 0) fade.gain.linearRampToValueAtTime(1, t0 + p.delay);
        osc.connect(depth).connect(fade);
        Object.assign(set, { [`${m.id}.rate`]: v => rate.setTargetAtTime(v * perHz, ac.currentTime, 0.02),
          [`${m.id}.depth`]: v => depth.gain.setTargetAtTime(v, ac.currentTime, 0.02) });
        nodes[m.id] = { out: fade, targets: { rate: [rate], depth: [depth.gain] }, scales: { rate: perHz } };
      } else if (m.type === 'fmop') {
        // A sine at ratio × the note's pitch with its own envelope. Audio arriving at its input
        // moves its frequency: deviation = input × fm depth × its frequency (so depth ≈ FM index).
        gated = true;
        const f = () => hz(note) * m.params.ratio;
        const osc = src(ac.createOscillator()), fmIn = keep(ac.createGain()), env = keep(ac.createGain()), level = keep(ac.createGain());
        osc.type = 'sine';
        osc.frequency.value = f();
        osc.detune.value = p.fine;
        this.bendCents.connect(osc.detune);
        fmIn.gain.value = p.fm * f();
        fmIn.connect(osc.frequency);
        level.gain.value = p.level;
        osc.connect(env).connect(level);
        envOn(env.gain, t0, p, 1 - p.velocity + p.velocity * (vel / 127) ** 1.5);
        offs.push(t => envOff(env.gain, t, m.params.release));
        tail = Math.max(tail, p.release * 1.6);
        const retune = () => { osc.frequency.setTargetAtTime(f(), ac.currentTime, 0.005); fmIn.gain.setTargetAtTime(m.params.fm * f(), ac.currentTime, 0.01); };
        Object.assign(set, { [`${m.id}.ratio`]: retune, [`${m.id}.fm`]: retune,
          [`${m.id}.fine`]: v => osc.detune.setTargetAtTime(v, ac.currentTime, 0.01),
          [`${m.id}.level`]: v => level.gain.setTargetAtTime(v, ac.currentTime, 0.01) });
        nodes[m.id] = { in: fmIn, out: level, targets: { pitch: [osc.detune], level: [level.gain], fm: [fmIn.gain] }, scales: { fm: f() } };
      } else if (m.type === 'ring') {
        // The input multiplied by a sine at ratio × the note's pitch, mixed with the dry input.
        const input = keep(ac.createGain()), vca = keep(ac.createGain()), dry = keep(ac.createGain()), wet = keep(ac.createGain()), out = keep(ac.createGain());
        const car = src(ac.createOscillator());
        car.frequency.value = hz(note) * p.ratio;
        car.detune.value = p.fine;
        vca.gain.value = 0;
        car.connect(vca.gain);
        input.connect(vca).connect(wet).connect(out);
        input.connect(dry).connect(out);
        wet.gain.value = p.mix;
        dry.gain.value = 1 - p.mix;
        Object.assign(set, { [`${m.id}.ratio`]: v => car.frequency.setTargetAtTime(hz(note) * v, ac.currentTime, 0.01),
          [`${m.id}.fine`]: v => car.detune.setTargetAtTime(v, ac.currentTime, 0.01),
          [`${m.id}.mix`]: v => { wet.gain.setTargetAtTime(v, ac.currentTime, 0.01); dry.gain.setTargetAtTime(1 - v, ac.currentTime, 0.01); } });
        nodes[m.id] = { in: input, out, targets: { mix: [wet.gain] } };
      } else if (m.type === 'drums') {
        // One-shot drums on the General MIDI notes; a note-off doesn't cut them.
        gated = true;
        const out = keep(ac.createGain());
        out.gain.value = p.level;
        const len = drumHit(ac, a, note, vel, t0, p, out, src, keep);
        minEnd = Math.max(minEnd, t0 + len);
        nodes[m.id] = { out, targets: {} };
      } else if (m.type === 'space') {
        // Binaural (HRTF) placement on headphones. Spread scatters notes at random around the
        // listener; orbit circles them around the head.
        const pan = keep(ac.createPanner());
        pan.panningModel = 'HRTF';
        pan.distanceModel = 'inverse';
        pan.refDistance = 1;
        const az = rad(p.azimuth + (Math.random() * 2 - 1) * p.spread), el = rad(p.elevation), d = p.distance;
        pan.positionX.value = Math.sin(az) * Math.cos(el) * d;
        pan.positionY.value = Math.sin(el) * d;
        pan.positionZ.value = -Math.cos(az) * Math.cos(el) * d;
        if (p.orbit > 0) {
          const r = Math.cos(el) * d, orbiters = [];
          set[`${m.id}.orbit`] = v => orbiters.forEach(o => o.frequency.setTargetAtTime(Math.max(0.001, v), ac.currentTime, 0.05));
          for (const [param, wave, sign] of [[pan.positionX, 'sine', 1], [pan.positionZ, 'cosine', -1]]) {
            const o = src(ac.createOscillator()), g = keep(ac.createGain());
            if (wave === 'sine') o.type = 'sine'; else o.setPeriodicWave(a.cosine);
            o.frequency.value = p.orbit;
            g.gain.value = r * sign;
            param.value = 0;
            o.connect(g).connect(param);
            orbiters.push(o);
          }
        }
        nodes[m.id] = { in: pan, out: pan, targets: { x: [pan.positionX] } };
      }
    }
    // Velocity as a modulation source (0-1), only if used.
    if (patch.mod.some(c => c.from === 'vel')) {
      const c = src(ac.createConstantSource());
      c.offset.value = vel / 127;
      nodes.vel = { out: c };
    }
    nodes.wheel = { out: this.wheel };

    for (const c of patch.audio) {
      const from = nodes[c.from];
      if (!from) continue; // a global module: wired in buildGlobals
      if (c.to !== 'out' && nodes[c.to]) { from.out.connect(nodes[c.to].in); continue; }
      const dest = c.to === 'out' ? this.bus : this.globals.get(c.to)?.input;
      if (!dest) continue;
      const exit = keep(ac.createGain()); // lets a note be cut short without a click
      from.out.connect(exit).connect(dest);
      exits.push(exit);
    }
    for (const c of patch.mod) {
      const [tid, key] = c.to.split('.'), from = nodes[c.from], params = nodes[tid]?.targets[key];
      if (!from || !params?.length) continue;
      const g = keep(ac.createGain()), k = modScale(key) * (nodes[tid].scales?.[key] ?? 1);
      g.gain.value = c.amount * k;
      from.out.connect(g);
      params.forEach(pm => g.connect(pm));
      set[`mod:${c.from}>${c.to}`] = v => g.gain.setTargetAtTime(v * k, ac.currentTime, 0.01);
    }
    // Without an Amp module, a note simply stops when released (with a tiny fade).
    if (!gated) offs.push(t => exits.forEach(e => { e.gain.cancelScheduledValues(t); e.gain.setTargetAtTime(0, t, 0.008); }));
    for (const s of sources) s.start(t0);
    const v = { note, released: false, offs, exits, set, tail, end: Infinity };
    v.stopAt = t => {
      t = Math.max(t, minEnd); // one-shots (drums) play to their end
      v.end = t;
      for (const s of sources) { try { s.stop(t); } catch { /* already stopped */ } }
      if (sources[0]) sources[0].onended = () => {
        all.forEach(n => n.disconnect());
        for (const o of sources) if (o.detune) { try { this.bendCents.disconnect(o.detune); } catch { /* not connected */ } }
      };
    };
    return v;
  }
}
