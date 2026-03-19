# Subtractive Synth

A browser-based polyphonic subtractive synthesizer inspired by classic Moog synths. All DSP is implemented from scratch in a Web Audio AudioWorklet — no built-in OscillatorNode or BiquadFilterNode.

Built as a learning project to understand how synthesizers work at the sample level, with help from [Claude](https://claude.ai).

## Features

- **4 waveforms**: Sine, Saw, Square, Triangle — with PolyBLEP anti-aliasing
- **Low-pass filter**: Biquad with adjustable cutoff and resonance
- **Two ADSR envelopes**: Amplitude and filter cutoff
- **8-voice polyphony**: Play chords; oldest voice is stolen when all voices are in use
- **Two-octave keyboard**: Play from your computer keyboard
- **Real-time oscilloscope**: See the waveform as you play
- **Visual piano keyboard**: Shows which notes are active

## Running

Requires Go 1.23+.

```
go run main.go
```

Open http://localhost:8080 and press a key to start playing.

## Keyboard Layout

```
Upper octave (C5):  Q 2 W 3 E R 5 T 6 Y 7 U
                    │ │ │ │ │ │ │ │ │ │ │ │
Lower octave (C4):  Z S X D C V G B H N J M
```

White keys are on the letter rows, black keys (sharps/flats) are on the row above — same layout as most DAW virtual keyboards.

## Signal Chain

```
Oscillator ──▶ Low-pass Filter ──▶ Amplifier ──▶ Output
                    ▲                   ▲
              Filter ADSR          Amp ADSR
```

## How It Works

The Go server embeds the frontend and serves it on port 8080. All audio runs client-side:

- **`synth-processor.js`** runs on the audio thread via `AudioWorkletProcessor`, processing 128 samples per callback. It contains the oscillator (phase accumulator + PolyBLEP), biquad filter (direct form II transposed), and two ADSR envelope generators.
- **`synth.js`** manages the `AudioContext`, `AudioWorkletNode`, and an `AnalyserNode` for the waveform display.
- **`main.js`** handles keyboard input, slider bindings with logarithmic mapping, the visual piano, and the oscilloscope canvas.

No external JavaScript dependencies. No build step.
