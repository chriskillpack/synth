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
    this.node.port.postMessage({ type: 'noteOn', note: midiNote });
  }

  noteOff(midiNote) {
    this.node.port.postMessage({ type: 'noteOff', note: midiNote });
  }

  setParam(name, value) {
    if (this.params[name]) {
      this.params[name].setValueAtTime(value, this.ctx.currentTime);
    }
  }
}
