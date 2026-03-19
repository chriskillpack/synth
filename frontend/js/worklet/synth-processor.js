// ADSR envelope generator
class ADSREnvelope {
  constructor() {
    this.stage = 'idle'; // idle, attack, decay, sustain, release
    this.level = 0;
    this.releaseLevel = 0;
  }

  trigger() {
    this.stage = 'attack';
  }

  release() {
    this.releaseLevel = this.level;
    this.stage = 'release';
  }

  isIdle() {
    return this.stage === 'idle';
  }

  process(attack, decay, sustain, release) {
    const sampleRate = globalThis.sampleRate;

    switch (this.stage) {
      case 'idle':
        this.level = 0;
        break;

      case 'attack': {
        const attackRate = 1 / (attack * sampleRate);
        this.level += attackRate;
        if (this.level >= 1) {
          this.level = 1;
          this.stage = 'decay';
        }
        break;
      }

      case 'decay': {
        const decayRate = 1 / (decay * sampleRate);
        this.level -= decayRate;
        if (this.level <= sustain) {
          this.level = sustain;
          this.stage = 'sustain';
        }
        break;
      }

      case 'sustain':
        this.level = sustain;
        break;

      case 'release': {
        const releaseRate = 1 / (release * sampleRate);
        this.level -= this.releaseLevel * releaseRate;
        if (this.level <= 0) {
          this.level = 0;
          this.stage = 'idle';
        }
        break;
      }
    }

    return this.level;
  }
}

// PolyBLEP anti-aliasing correction
function polyblep(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

const NUM_VOICES = 8;

class Voice {
  constructor() {
    this.note = -1;        // MIDI note, -1 = unassigned
    this.frequency = 440;
    this.phase = 0;
    this.triState = 0;
    this.z1 = 0;
    this.z2 = 0;
    this.ampEnv = new ADSREnvelope();
    this.filterEnv = new ADSREnvelope();
    this.age = 0;          // increments each process() call while active
  }

  isIdle() {
    return this.ampEnv.isIdle() && this.note === -1;
  }

  noteOn(note) {
    this.note = note;
    this.frequency = 440 * Math.pow(2, (note - 69) / 12);
    this.ampEnv.trigger();
    this.filterEnv.trigger();
    this.age = 0;
  }

  noteOff() {
    this.note = -1;
    this.ampEnv.release();
    this.filterEnv.release();
  }

  // Generate one sample. Returns the output value.
  processSample(waveform, filterCutoff, filterResonance, filterEnvAmount,
                ampA, ampD, ampS, ampR, filtA, filtD, filtS, filtR) {
    const sr = globalThis.sampleRate;
    const nyquist = sr / 2;
    const f = this.frequency;
    const dt = f / sr;

    // Oscillator
    this.phase += dt;
    this.phase -= Math.floor(this.phase);

    let sample = 0;
    switch (waveform) {
      case 0: // Sine
        sample = Math.sin(2 * Math.PI * this.phase);
        break;
      case 1: { // Saw
        sample = 2 * this.phase - 1;
        sample -= polyblep(this.phase, dt);
        break;
      }
      case 2: { // Square
        sample = this.phase < 0.5 ? 1 : -1;
        sample += polyblep(this.phase, dt);
        let shifted = this.phase + 0.5;
        if (shifted >= 1) shifted -= 1;
        sample -= polyblep(shifted, dt);
        break;
      }
      case 3: { // Triangle (integrated square)
        let sq = this.phase < 0.5 ? 1 : -1;
        sq += polyblep(this.phase, dt);
        let shifted = this.phase + 0.5;
        if (shifted >= 1) shifted -= 1;
        sq -= polyblep(shifted, dt);
        this.triState = 0.999 * this.triState + sq * 4 * dt;
        sample = this.triState;
        break;
      }
    }

    // Filter envelope
    const filtEnvLevel = this.filterEnv.process(filtA, filtD, filtS, filtR);
    let cutoff = filterCutoff + filterEnvAmount * filtEnvLevel;
    cutoff = Math.max(20, Math.min(cutoff, nyquist * 0.9));

    // Biquad low-pass coefficients
    const w0 = 2 * Math.PI * cutoff / sr;
    const sinW0 = Math.sin(w0);
    const cosW0 = Math.cos(w0);
    const alpha = sinW0 / (2 * filterResonance);

    const b0 = (1 - cosW0) / 2;
    const b1 = 1 - cosW0;
    const b2 = b0;
    const a0 = 1 + alpha;
    const a1 = -2 * cosW0;
    const a2 = 1 - alpha;

    const nb0 = b0 / a0;
    const nb1 = b1 / a0;
    const nb2 = b2 / a0;
    const na1 = a1 / a0;
    const na2 = a2 / a0;

    // Direct form II transposed
    const filtered = nb0 * sample + this.z1;
    this.z1 = nb1 * sample - na1 * filtered + this.z2;
    this.z2 = nb2 * sample - na2 * filtered;

    // Flush denormals
    if (Math.abs(this.z1) < 1e-18) this.z1 = 0;
    if (Math.abs(this.z2) < 1e-18) this.z2 = 0;

    // Amp envelope
    const ampLevel = this.ampEnv.process(ampA, ampD, ampS, ampR);

    return filtered * ampLevel;
  }
}

class SynthProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'waveform',        min: 0,     max: 3,     defaultValue: 1,    automationRate: 'k-rate' },
      { name: 'filterCutoff',    min: 20,    max: 20000, defaultValue: 8000, automationRate: 'a-rate' },
      { name: 'filterResonance', min: 0.1,   max: 30,    defaultValue: 1,    automationRate: 'a-rate' },
      { name: 'filterEnvAmount', min: 0,     max: 20000, defaultValue: 4000, automationRate: 'a-rate' },
      { name: 'ampAttack',       min: 0.001, max: 5,     defaultValue: 0.01, automationRate: 'k-rate' },
      { name: 'ampDecay',        min: 0.001, max: 5,     defaultValue: 0.1,  automationRate: 'k-rate' },
      { name: 'ampSustain',      min: 0,     max: 1,     defaultValue: 0.8,  automationRate: 'k-rate' },
      { name: 'ampRelease',      min: 0.001, max: 10,    defaultValue: 0.3,  automationRate: 'k-rate' },
      { name: 'filterAttack',    min: 0.001, max: 5,     defaultValue: 0.01, automationRate: 'k-rate' },
      { name: 'filterDecay',     min: 0.001, max: 5,     defaultValue: 0.3,  automationRate: 'k-rate' },
      { name: 'filterSustain',   min: 0,     max: 1,     defaultValue: 0.3,  automationRate: 'k-rate' },
      { name: 'filterRelease',   min: 0.001, max: 10,    defaultValue: 0.5,  automationRate: 'k-rate' },
      { name: 'masterVolume',    min: 0,     max: 1,     defaultValue: 0.5,  automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.voices = [];
    for (let i = 0; i < NUM_VOICES; i++) {
      this.voices.push(new Voice());
    }

    this.port.onmessage = (e) => {
      const { type, note } = e.data;
      if (type === 'noteOn') {
        this.voiceNoteOn(note);
      } else if (type === 'noteOff') {
        this.voiceNoteOff(note);
      }
    };
  }

  voiceNoteOn(note) {
    // If this note is already playing, retrigger it
    for (const v of this.voices) {
      if (v.note === note) {
        v.noteOn(note);
        return;
      }
    }

    // Find an idle voice
    for (const v of this.voices) {
      if (v.isIdle()) {
        v.noteOn(note);
        return;
      }
    }

    // Steal the oldest voice
    let oldest = this.voices[0];
    for (let i = 1; i < this.voices.length; i++) {
      if (this.voices[i].age > oldest.age) {
        oldest = this.voices[i];
      }
    }
    oldest.noteOn(note);
  }

  voiceNoteOff(note) {
    for (const v of this.voices) {
      if (v.note === note) {
        v.noteOff();
        return;
      }
    }
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0][0];
    const numSamples = output.length;

    const getParam = (p, i) => p.length > 1 ? p[i] : p[0];

    const waveform = Math.round(getParam(parameters.waveform, 0));
    const ampA = getParam(parameters.ampAttack, 0);
    const ampD = getParam(parameters.ampDecay, 0);
    const ampS = getParam(parameters.ampSustain, 0);
    const ampR = getParam(parameters.ampRelease, 0);
    const filtA = getParam(parameters.filterAttack, 0);
    const filtD = getParam(parameters.filterDecay, 0);
    const filtS = getParam(parameters.filterSustain, 0);
    const filtR = getParam(parameters.filterRelease, 0);
    const masterVol = getParam(parameters.masterVolume, 0);

    for (let i = 0; i < numSamples; i++) {
      const filterCutoff = getParam(parameters.filterCutoff, i);
      const filterResonance = getParam(parameters.filterResonance, i);
      const filterEnvAmount = getParam(parameters.filterEnvAmount, i);

      let mix = 0;
      for (const voice of this.voices) {
        if (voice.isIdle()) continue;
        mix += voice.processSample(
          waveform, filterCutoff, filterResonance, filterEnvAmount,
          ampA, ampD, ampS, ampR, filtA, filtD, filtS, filtR
        );
      }

      output[i] = mix * masterVol;
    }

    // Age active voices (once per block)
    for (const v of this.voices) {
      if (!v.isIdle()) v.age++;
    }

    return true;
  }
}

registerProcessor('synth-processor', SynthProcessor);
