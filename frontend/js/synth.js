export class SynthEngine {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.params = {};
    this.analyser = null;
    this.waveformData = null;
  }

  async init() {
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule('/js/worklet/synth-processor.js');
    this.node = new AudioWorkletNode(this.ctx, 'synth-processor');

    // Insert AnalyserNode for waveform visualization
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.waveformData = new Float32Array(this.analyser.fftSize);

    this.node.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    // Store references to all parameters
    for (const [name, param] of this.node.parameters) {
      this.params[name] = param;
    }
  }

  getWaveformData() {
    this.analyser.getFloatTimeDomainData(this.waveformData);
    return this.waveformData;
  }

  noteOn(midiNote) {
    const freq = 440 * Math.pow(2, (midiNote - 69) / 12);
    this.params.frequency.setValueAtTime(freq, this.ctx.currentTime);
    this.params.gate.setValueAtTime(1, this.ctx.currentTime);
  }

  noteOff() {
    this.params.gate.setValueAtTime(0, this.ctx.currentTime);
  }

  setParam(name, value) {
    if (this.params[name]) {
      this.params[name].setValueAtTime(value, this.ctx.currentTime);
    }
  }
}
