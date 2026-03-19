# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Browser-based monophonic subtractive synthesizer inspired by classic Moog synths. The goal is to learn how synthesizers work by implementing core DSP from scratch — no built-in Web Audio oscillator/filter nodes.

## Architecture

- **Go server** (`main.go`): Embeds `frontend/` via `//go:embed` and serves it on `:8080`
- **All audio processing is client-side** in an AudioWorklet (`synth-processor.js`)
- **No external dependencies** — plain HTML/CSS/JS, no build step

## Signal Chain

Oscillator (PolyBLEP) → Low-pass biquad filter → Amplifier

- Two ADSR envelopes: one modulates amplitude, one modulates filter cutoff
- Monophonic with last-note priority

## Project Structure

```
synth/
├── main.go                          # Go server, embeds frontend/
├── go.mod
├── frontend/
│   ├── index.html                   # Single page with synth UI
│   ├── css/
│   │   └── style.css
│   └── js/
│       ├── main.js                  # Keyboard handling, UI binding, piano/scope viz
│       ├── synth.js                 # SynthEngine class (AudioContext, WorkletNode, AnalyserNode)
│       └── worklet/
│           └── synth-processor.js   # AudioWorkletProcessor with all DSP
```

## Build & Run

```
go run main.go
# Open http://localhost:8080
# Press any piano key (Z-M for C4 octave, Q-U for C5 octave) to start audio
```

## Key Implementation Details

- **Oscillator**: Phase accumulator with PolyBLEP anti-aliasing for saw/square; triangle via leaky integrator of square
- **Filter**: Direct form II transposed biquad with denormal flushing and Nyquist clamping
- **ADSR**: Linear ramp state machine (IDLE→ATTACK→DECAY→SUSTAIN→RELEASE→IDLE)
- **UI sliders**: Logarithmic mapping for cutoff (20–20kHz) and time params (1ms–10s)
- **AudioContext**: Lazily initialized on first keypress to satisfy browser autoplay policy
