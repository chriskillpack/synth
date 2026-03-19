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

class SynthProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency',       min: 20,    max: 20000, defaultValue: 440,  automationRate: 'a-rate' },
      { name: 'gate',            min: 0,     max: 1,     defaultValue: 0,    automationRate: 'a-rate' },
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
    this.phase = 0;
    this.prevGate = 0;
    this.ampEnv = new ADSREnvelope();
    this.filterEnv = new ADSREnvelope();

    // Biquad filter state (direct form II transposed)
    this.z1 = 0;
    this.z2 = 0;

    // Triangle wave: leaky integrator of square
    this.triState = 0;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0][0];
    const numSamples = output.length;
    const sr = globalThis.sampleRate;
    const nyquist = sr / 2;

    // Helper to get param value (a-rate or k-rate)
    const getParam = (p, i) => p.length > 1 ? p[i] : p[0];

    const freq = parameters.frequency;
    const gate = parameters.gate;
    const waveform = Math.round(getParam(parameters.waveform, 0)); // k-rate
    const filterCutoff = parameters.filterCutoff;
    const filterResonance = parameters.filterResonance;
    const filterEnvAmount = parameters.filterEnvAmount;
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
      const f = getParam(freq, i);
      const g = getParam(gate, i);

      // Gate edge detection
      if (g > 0.5 && this.prevGate <= 0.5) {
        this.ampEnv.trigger();
        this.filterEnv.trigger();
      } else if (g <= 0.5 && this.prevGate > 0.5) {
        this.ampEnv.release();
        this.filterEnv.release();
      }
      this.prevGate = g;

      // Oscillator
      const dt = f / sr;
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
          // Leaky integrator
          this.triState = 0.999 * this.triState + sq * 4 * dt;
          sample = this.triState;
          break;
        }
      }

      // Filter envelope
      const filtEnvLevel = this.filterEnv.process(filtA, filtD, filtS, filtR);
      const cutoffBase = getParam(filterCutoff, i);
      const envAmt = getParam(filterEnvAmount, i);
      let cutoff = cutoffBase + envAmt * filtEnvLevel;
      cutoff = Math.max(20, Math.min(cutoff, nyquist * 0.9));

      const Q = getParam(filterResonance, i);

      // Biquad low-pass coefficients
      const w0 = 2 * Math.PI * cutoff / sr;
      const sinW0 = Math.sin(w0);
      const cosW0 = Math.cos(w0);
      const alpha = sinW0 / (2 * Q);

      const b0 = (1 - cosW0) / 2;
      const b1 = 1 - cosW0;
      const b2 = b0;
      const a0 = 1 + alpha;
      const a1 = -2 * cosW0;
      const a2 = 1 - alpha;

      // Normalize
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

      output[i] = filtered * ampLevel * masterVol;
    }

    return true;
  }
}

registerProcessor('synth-processor', SynthProcessor);
