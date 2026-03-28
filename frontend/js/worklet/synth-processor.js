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

// Dynamic range compressor (operates in dB)
class Compressor {
  constructor() {
    this.envDb = -96;
  }

  process(sample, thresholdDb, ratio, attackTime, releaseTime) {
    const sr = globalThis.sampleRate;
    const absSample = Math.abs(sample);
    const inputDb = absSample > 1e-6 ? 20 * Math.log10(absSample) : -96;

    // Envelope follower with separate attack/release
    if (inputDb > this.envDb) {
      const attackCoeff = Math.exp(-1 / (attackTime * sr));
      this.envDb = attackCoeff * this.envDb + (1 - attackCoeff) * inputDb;
    } else {
      const releaseCoeff = Math.exp(-1 / (releaseTime * sr));
      this.envDb = releaseCoeff * this.envDb + (1 - releaseCoeff) * inputDb;
    }

    // Gain reduction above threshold
    let gainDb = 0;
    if (this.envDb > thresholdDb) {
      gainDb = (this.envDb - thresholdDb) * (1 / ratio - 1);
    }

    return sample * Math.pow(10, gainDb / 20);
  }
}

const NUM_VOICES = 8;

const NUM_HARMONICS = 16;

class Voice {
  constructor() {
    this.note = -1;        // MIDI note, -1 = unassigned
    this.frequency = 440;
    this.phase = 0;
    this.triState = 0;
    this.harmonicPhases = new Float64Array(NUM_HARMONICS - 1); // harmonics 2x-16x
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
  // lfoValue is in range [-1, 1], lfoDepth in [0, 1], lfoDest: 0=pitch, 1=filter, 2=amplitude
  processSample(waveform, filterCutoff, filterResonance, filterEnvAmount,
                ampA, ampD, ampS, ampR, filtA, filtD, filtS, filtR,
                lfoValue, lfoDepth, lfoDest, harmonicWeights) {
    const sr = globalThis.sampleRate;
    const nyquist = sr / 2;

    // Apply LFO to pitch: modulate frequency by up to +/-2 semitones
    let f = this.frequency;
    if (lfoDest === 0 && lfoDepth > 0) {
      f *= Math.pow(2, lfoValue * lfoDepth * 2 / 12);
    }
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

    // Apply fundamental weight
    sample *= harmonicWeights[0];

    // Add harmonics 2x-16x as sine waves
    for (let h = 0; h < NUM_HARMONICS - 1; h++) {
      const weight = harmonicWeights[h + 1];
      if (weight === 0) continue;
      const hFreq = f * (h + 2);
      if (hFreq >= nyquist) break;
      this.harmonicPhases[h] += hFreq / sr;
      this.harmonicPhases[h] -= Math.floor(this.harmonicPhases[h]);
      sample += weight * Math.sin(2 * Math.PI * this.harmonicPhases[h]);
    }

    // Filter envelope
    const filtEnvLevel = this.filterEnv.process(filtA, filtD, filtS, filtR);
    let cutoff = filterCutoff + filterEnvAmount * filtEnvLevel;
    // Apply LFO to filter: modulate cutoff by up to +/-4000 Hz
    if (lfoDest === 1 && lfoDepth > 0) {
      cutoff += lfoValue * lfoDepth * 4000;
    }
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
    let ampLevel = this.ampEnv.process(ampA, ampD, ampS, ampR);
    // Apply LFO to amplitude: modulate between (1-depth) and 1
    if (lfoDest === 2 && lfoDepth > 0) {
      ampLevel *= 1 - lfoDepth * 0.5 * (1 - lfoValue);
    }

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
      { name: 'lfoRate',         min: 0.1,   max: 20,    defaultValue: 5,    automationRate: 'k-rate' },
      { name: 'lfoDepth',        min: 0,     max: 1,     defaultValue: 0,    automationRate: 'k-rate' },
      { name: 'lfoWaveform',     min: 0,     max: 2,     defaultValue: 0,    automationRate: 'k-rate' },
      { name: 'lfoDest',         min: 0,     max: 2,     defaultValue: 0,    automationRate: 'k-rate' },
      { name: 'compThreshold',   min: -60,   max: 0,     defaultValue: -12,  automationRate: 'k-rate' },
      { name: 'compRatio',       min: 1,     max: 20,    defaultValue: 4,    automationRate: 'k-rate' },
      { name: 'compAttack',      min: 0.001, max: 0.5,   defaultValue: 0.01, automationRate: 'k-rate' },
      { name: 'compRelease',     min: 0.001, max: 1,     defaultValue: 0.1,  automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.voices = [];
    for (let i = 0; i < NUM_VOICES; i++) {
      this.voices.push(new Voice());
    }
    this.lfoPhase = 0;
    this.compressor = new Compressor();
    this.harmonicWeights = new Float64Array(NUM_HARMONICS);
    this.harmonicWeights[0] = 1; // fundamental only by default

    this.port.onmessage = (e) => {
      const { type, note } = e.data;
      if (type === 'noteOn') {
        this.voiceNoteOn(note);
      } else if (type === 'noteOff') {
        this.voiceNoteOff(note);
      } else if (type === 'harmonics') {
        for (let i = 0; i < NUM_HARMONICS; i++) {
          this.harmonicWeights[i] = e.data.weights[i];
        }
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
    const lfoRate = getParam(parameters.lfoRate, 0);
    const lfoDepth = getParam(parameters.lfoDepth, 0);
    const lfoWaveform = Math.round(getParam(parameters.lfoWaveform, 0));
    const lfoDest = Math.round(getParam(parameters.lfoDest, 0));
    const compThreshold = getParam(parameters.compThreshold, 0);
    const compRatio = getParam(parameters.compRatio, 0);
    const compAttack = getParam(parameters.compAttack, 0);
    const compRelease = getParam(parameters.compRelease, 0);
    const sr = globalThis.sampleRate;
    const lfoDt = lfoRate / sr;

    for (let i = 0; i < numSamples; i++) {
      const filterCutoff = getParam(parameters.filterCutoff, i);
      const filterResonance = getParam(parameters.filterResonance, i);
      const filterEnvAmount = getParam(parameters.filterEnvAmount, i);

      // LFO: compute value [-1, 1]
      this.lfoPhase += lfoDt;
      this.lfoPhase -= Math.floor(this.lfoPhase);
      let lfoValue = 0;
      switch (lfoWaveform) {
        case 0: // Sine
          lfoValue = Math.sin(2 * Math.PI * this.lfoPhase);
          break;
        case 1: // Triangle
          lfoValue = 4 * Math.abs(this.lfoPhase - 0.5) - 1;
          break;
        case 2: // Square
          lfoValue = this.lfoPhase < 0.5 ? 1 : -1;
          break;
      }

      let mix = 0;
      for (const voice of this.voices) {
        if (voice.isIdle()) continue;
        mix += voice.processSample(
          waveform, filterCutoff, filterResonance, filterEnvAmount,
          ampA, ampD, ampS, ampR, filtA, filtD, filtS, filtR,
          lfoValue, lfoDepth, lfoDest, this.harmonicWeights
        );
      }

      mix = this.compressor.process(mix, compThreshold, compRatio, compAttack, compRelease);
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
