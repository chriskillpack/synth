import { SynthEngine } from './synth.js';

let engine = null;
let engineReady = false;
let initPromise = null;

// Two-octave keyboard mapping: event.code → MIDI note
const keyMap = {
  // Lower octave (C4 = 60)
  KeyZ: 60, KeyS: 61, KeyX: 62, KeyD: 63, KeyC: 64,
  KeyV: 65, KeyG: 66, KeyB: 67, KeyH: 68, KeyN: 69,
  KeyJ: 70, KeyM: 71,
  // Upper octave (C5 = 72)
  KeyQ: 72, Digit2: 73, KeyW: 74, Digit3: 75, KeyE: 76,
  KeyR: 77, Digit5: 78, KeyT: 79, Digit6: 80, KeyY: 81,
  Digit7: 82, KeyU: 83,
};

// Reverse mapping: MIDI note → key label for display
const noteLabels = {};
for (const [code, note] of Object.entries(keyMap)) {
  // Extract a short label from the event.code
  const label = code.replace('Key', '').replace('Digit', '');
  noteLabels[note] = label;
}

// Track held notes for piano highlight
const heldNotes = new Set();

function updatePianoHighlight() {
  document.querySelectorAll('.piano-key').forEach(el => {
    el.classList.toggle('active', heldNotes.has(parseInt(el.dataset.note)));
  });
}

async function ensureEngine() {
  if (engineReady) return;
  if (initPromise) {
    await initPromise;
    return;
  }
  initPromise = (async () => {
    engine = new SynthEngine();
    await engine.init();
    bindSliders();
    setupScope();
    engineReady = true;
  })();
  await initPromise;
}

async function handleKeyDown(e) {
  if (e.repeat) return;
  const note = keyMap[e.code];
  if (note === undefined) return;
  e.preventDefault();

  await ensureEngine();

  heldNotes.add(note);
  engine.noteOn(note);
  updatePianoHighlight();
}

function handleKeyUp(e) {
  if (!engine) return;
  const note = keyMap[e.code];
  if (note === undefined) return;
  e.preventDefault();

  heldNotes.delete(note);
  engine.noteOff(note);
  updatePianoHighlight();
}

// Logarithmic slider mappings
function mapCutoff(pos) {
  return 20 * Math.pow(1000, pos);
}

function mapTime(pos) {
  return 0.001 * Math.pow(10000, pos);
}

function formatHz(hz) {
  return hz >= 1000 ? (hz / 1000).toFixed(1) + ' kHz' : Math.round(hz) + ' Hz';
}

function formatTime(t) {
  return t >= 1 ? t.toFixed(2) + ' s' : Math.round(t * 1000) + ' ms';
}

// Bind all sliders
function bindSliders() {
  const sliders = document.querySelectorAll('input[type="range"][data-param]');
  sliders.forEach(slider => {
    const param = slider.dataset.param;
    const mapping = slider.dataset.mapping;
    const display = slider.parentElement.querySelector('.value-display');

    const update = () => {
      const pos = parseFloat(slider.value);
      let value, label;

      switch (mapping) {
        case 'cutoff':
          value = mapCutoff(pos);
          label = formatHz(value);
          break;
        case 'time':
          value = mapTime(pos);
          label = formatTime(value);
          break;
        case 'linear':
        default:
          value = pos;
          label = parseFloat(pos.toFixed(3)).toString();
          break;
      }

      if (display) display.textContent = label;
      if (engine) engine.setParam(param, value);
    };

    slider.addEventListener('input', update);
    // Initialize display
    update();
  });

  // Waveform select
  const waveformSelect = document.getElementById('waveform');
  if (waveformSelect) {
    waveformSelect.addEventListener('change', () => {
      if (engine) engine.setParam('waveform', parseInt(waveformSelect.value));
    });
  }
}

// Build the visual piano keyboard (MIDI 60–83, two octaves)
function buildPiano() {
  const piano = document.getElementById('piano');
  const startNote = 60;
  const endNote = 83;

  // Which notes in an octave are black keys (semitone offsets with sharps)
  const isBlack = [false, true, false, true, false, false, true, false, true, false, true, false];

  // Count white keys to calculate sizing
  const whiteKeys = [];
  const blackKeys = [];
  for (let n = startNote; n <= endNote; n++) {
    if (isBlack[n % 12]) {
      blackKeys.push(n);
    } else {
      whiteKeys.push(n);
    }
  }

  const whiteCount = whiteKeys.length;
  const whiteWidthPct = 100 / whiteCount;

  // Place white keys
  whiteKeys.forEach((note, i) => {
    const key = document.createElement('div');
    key.className = 'piano-key white';
    key.dataset.note = note;
    key.style.left = (i * whiteWidthPct) + '%';
    key.style.width = whiteWidthPct + '%';
    if (noteLabels[note]) {
      const lbl = document.createElement('span');
      lbl.className = 'key-label';
      lbl.textContent = noteLabels[note];
      key.appendChild(lbl);
    }
    piano.appendChild(key);
  });

  // Place black keys between appropriate white keys
  // Black key positions relative to their preceding white key
  const blackOffset = 0.65; // how far right the black key sits (fraction of white key width)
  const blackWidthPct = whiteWidthPct * 0.58;

  // Map each black note to which white key index it follows
  let whiteIdx = 0;
  for (let n = startNote; n <= endNote; n++) {
    if (isBlack[n % 12]) {
      const key = document.createElement('div');
      key.className = 'piano-key black';
      key.dataset.note = n;
      key.style.left = ((whiteIdx - 1 + blackOffset) * whiteWidthPct) + '%';
      key.style.width = blackWidthPct + '%';
      if (noteLabels[n]) {
        const lbl = document.createElement('span');
        lbl.className = 'key-label';
        lbl.textContent = noteLabels[n];
        key.appendChild(lbl);
      }
      piano.appendChild(key);
    } else {
      whiteIdx++;
    }
  }
}

// Waveform visualization
let waveformCanvas, waveformCtx;

function drawWaveform() {
  if (!engine) return;
  requestAnimationFrame(drawWaveform);

  const data = engine.getWaveformData();
  const w = waveformCanvas.drawWidth;
  const h = waveformCanvas.drawHeight;

  waveformCtx.fillStyle = '#0f0f1e';
  waveformCtx.fillRect(0, 0, w, h);

  waveformCtx.strokeStyle = '#e94560';
  waveformCtx.lineWidth = 1.5;
  waveformCtx.beginPath();

  const sliceWidth = w / data.length;
  let x = 0;
  for (let i = 0; i < data.length; i++) {
    const y = (1 - data[i]) * h / 2;
    if (i === 0) {
      waveformCtx.moveTo(x, y);
    } else {
      waveformCtx.lineTo(x, y);
    }
    x += sliceWidth;
  }
  waveformCtx.stroke();
}

function setupScope() {
  waveformCanvas = document.getElementById('scope');
  waveformCtx = waveformCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = waveformCanvas.getBoundingClientRect();
  waveformCanvas.width = rect.width * dpr;
  waveformCanvas.height = rect.height * dpr;
  waveformCtx.scale(dpr, dpr);
  waveformCanvas.drawWidth = rect.width;
  waveformCanvas.drawHeight = rect.height;
  drawWaveform();
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  buildPiano();
  document.addEventListener('keydown', handleKeyDown);
  document.addEventListener('keyup', handleKeyUp);
});
