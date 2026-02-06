(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('overlay');
  const startBtn = document.getElementById('start-btn');
  const touch = document.getElementById('touch');
  const choiceButtons = [...document.querySelectorAll('button.choice')];

  const ASSETS = {
    idle: '../output/imagegen/music_idle.png',
    guitar: '../output/imagegen/music_guitar.png',
    guitar_1: '../output/imagegen/music_guitar_1.png',
    guitar_2: '../output/imagegen/music_guitar_2.png',
    drums: '../output/imagegen/music_drums.png',
    drums_1: '../output/imagegen/music_drums_1.png',
    drums_2: '../output/imagegen/music_drums_2.png',
    piano: '../output/imagegen/music_piano.png',
    piano_1: '../output/imagegen/music_piano_1.png',
    piano_2: '../output/imagegen/music_piano_2.png',
  };

  const state = {
    mode: 'menu',
    instrument: 'guitar',
    lastEvent: null,
    playingUntil: 0,
    now: 0,
    animBeatUntil: 0,
    keysDown: new Set(),
  };

  const images = {};

  let audioCtx = null;

  function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function envIsCoarsePointer() {
    return window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(320, Math.floor(rect.width));
    canvas.height = Math.max(240, Math.floor(rect.height));
    render();
  }

  function loadImages() {
    const entries = Object.entries(ASSETS);
    return Promise.all(entries.map(([k, src]) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { images[k] = img; resolve(); };
      img.onerror = () => { images[k] = null; resolve(); };
      img.src = src;
    })));
  }

  function playOsc({ type = 'sine', freq = 440, dur = 0.18, gain = 0.06, attack = 0.006, release = 0.08 }) {
    const ac = ensureAudio();
    if (!ac) return;
    const t0 = ac.currentTime;

    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);

    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur + release);

    osc.connect(g).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + dur + release + 0.02);
  }

  function playNoise({ dur = 0.08, gain = 0.05, hp = 1000 }) {
    const ac = ensureAudio();
    if (!ac) return;
    const t0 = ac.currentTime;

    const bufferSize = Math.max(1, Math.floor(ac.sampleRate * dur));
    const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.4));

    const src = ac.createBufferSource();
    src.buffer = buffer;

    const filter = ac.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(hp, t0);

    const g = ac.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(filter).connect(g).connect(ac.destination);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  const noteFreq = {
    C4: 261.63,
    D4: 293.66,
    E4: 329.63,
    F4: 349.23,
    G4: 392.0,
    A4: 440.0,
    B4: 493.88,
    C5: 523.25,
    D5: 587.33,
    E5: 659.26,
    F5: 698.46,
    G5: 783.99,
    A5: 880.0,
  };

  const mappings = {
    guitar: {
      // simple chord-ish mapping
      KeyA: { label: 'Am', notes: ['A4', 'C5', 'E5'] },
      KeyS: { label: 'C', notes: ['C5', 'E5', 'G5'] },
      KeyD: { label: 'G', notes: ['G4', 'B4', 'D5'] },
      KeyF: { label: 'F', notes: ['F4', 'A4', 'C5'] },
      KeyG: { label: 'Em', notes: ['E4', 'G4', 'B4'] },
    },
    drums: {
      KeyJ: { label: 'KICK', drum: 'kick' },
      KeyK: { label: 'SNARE', drum: 'snare' },
      KeyL: { label: 'HAT', drum: 'hat' },
      Semicolon: { label: 'CRASH', drum: 'crash' },
    },
    piano: {
      // C major-ish row
      KeyA: { label: 'C', note: 'C4' },
      KeyS: { label: 'D', note: 'D4' },
      KeyD: { label: 'E', note: 'E4' },
      KeyF: { label: 'F', note: 'F4' },
      KeyG: { label: 'G', note: 'G4' },
      KeyH: { label: 'A', note: 'A4' },
      KeyJ: { label: 'B', note: 'B4' },
      KeyK: { label: 'C5', note: 'C5' },
    },
  };

  function instrumentSpriteKey() {
    // In menu, preview the currently selected instrument pose.
    if (state.mode !== 'playing') return state.instrument;
    if (state.now >= state.playingUntil) return state.instrument;

    // While playing, cycle through instrument-specific frames for an animated feel.
    const t = state.lastEvent ? (state.now - state.lastEvent.t) : state.now;
    if (state.instrument === 'guitar') {
      const frames = ['guitar', 'guitar_1', 'guitar_2'];
      const idx = Math.floor(t * 12) % frames.length;
      return frames[idx];
    }
    if (state.instrument === 'piano') {
      const frames = ['piano', 'piano_1', 'piano_2'];
      const idx = Math.floor(t * 10) % frames.length;
      return frames[idx];
    }
    if (state.instrument === 'drums') {
      const frames = ['drums', 'drums_1', 'drums_2'];
      const idx = Math.floor(t * 14) % frames.length;
      return frames[idx];
    }
    return state.instrument;
  }

  function setInstrument(next) {
    state.instrument = next;
    for (const b of choiceButtons) b.classList.toggle('selected', b.dataset.instrument === next);
    buildTouchPads();
    render();
  }

  function drumHit(type) {
    if (type === 'kick') {
      playOsc({ type: 'sine', freq: 80, dur: 0.08, gain: 0.09, attack: 0.002, release: 0.08 });
      playOsc({ type: 'sine', freq: 55, dur: 0.1, gain: 0.05, attack: 0.002, release: 0.1 });
      return;
    }
    if (type === 'snare') {
      playNoise({ dur: 0.09, gain: 0.055, hp: 1200 });
      playOsc({ type: 'triangle', freq: 180, dur: 0.05, gain: 0.025, attack: 0.002, release: 0.06 });
      return;
    }
    if (type === 'hat') {
      playNoise({ dur: 0.05, gain: 0.04, hp: 5000 });
      return;
    }
    if (type === 'crash') {
      playNoise({ dur: 0.22, gain: 0.04, hp: 2500 });
      return;
    }
  }

  function trigger(code) {
    const map = mappings[state.instrument];
    const evt = map && map[code];
    if (!evt) return;

    ensureAudio();

    if (state.instrument === 'guitar') {
      // short strum
      let delay = 0;
      for (const n of evt.notes) {
        const f = noteFreq[n] || 440;
        setTimeout(() => playOsc({ type: 'triangle', freq: f, dur: 0.14, gain: 0.05 }), delay);
        delay += 18;
      }
    } else if (state.instrument === 'piano') {
      const f = noteFreq[evt.note] || 440;
      playOsc({ type: 'sine', freq: f, dur: 0.22, gain: 0.055 });
      playOsc({ type: 'triangle', freq: f * 2, dur: 0.1, gain: 0.02 });
    } else if (state.instrument === 'drums') {
      drumHit(evt.drum);
    }

    state.lastEvent = { code, label: evt.label, instrument: state.instrument, t: state.now };
    // Keep the “playing” window long enough to be visually readable and feel animated.
    state.playingUntil = state.now + 0.65;
    state.animBeatUntil = state.now + 0.22;
  }

  function buildTouchPads() {
    const coarse = envIsCoarsePointer();
    touch.innerHTML = '';
    if (!coarse) return;

    const switches = [
      { label: 'GTR', instrument: 'guitar' },
      { label: 'DRM', instrument: 'drums' },
      { label: 'PNO', instrument: 'piano' },
    ];
    for (const sw of switches) {
      const b = document.createElement('button');
      b.className = 'pad';
      b.type = 'button';
      b.textContent = sw.label;
      const down = (e) => {
        e.preventDefault();
        ensureAudio();
        setInstrument(sw.instrument);
      };
      b.addEventListener('pointerdown', down, { passive: false });
      touch.appendChild(b);
    }

    const map = mappings[state.instrument];
    const codes = Object.keys(map);
    for (const code of codes) {
      const b = document.createElement('button');
      b.className = 'pad';
      b.type = 'button';
      b.textContent = map[code].label;
      const down = (e) => {
        e.preventDefault();
        trigger(code);
      };
      b.addEventListener('pointerdown', down, { passive: false });
      touch.appendChild(b);
    }
  }

  function drawBackground() {
    const w = canvas.width;
    const h = canvas.height;

    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0c2a5a');
    g.addColorStop(1, '#030815');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    for (let i = 0; i < 10; i++) {
      const x = (i * 140 + (state.now * 12) % 140) % (w + 180) - 90;
      const y = 70 + (i % 3) * 38;
      ctx.beginPath();
      ctx.ellipse(x, y, 84, 22, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    const floorY = Math.floor(h * 0.78);
    ctx.fillStyle = 'rgba(4, 14, 28, 0.78)';
    ctx.fillRect(0, floorY, w, h - floorY);

    ctx.fillStyle = 'rgba(110, 255, 220, 0.12)';
    for (let i = 0; i < 7; i++) {
      const px = i * (w / 6.2) + (Math.sin(state.now * 0.6 + i) * 18);
      ctx.fillRect(px, floorY, 4, h - floorY);
    }
  }

  function drawUI() {
    const w = canvas.width;
    const compact = w < 900;

    ctx.fillStyle = 'rgba(8, 18, 42, 0.56)';
    ctx.fillRect(18, 18, compact ? 360 : 520, compact ? 106 : 122);

    ctx.fillStyle = '#eef6ff';
    ctx.font = compact ? '800 22px "Avenir Next", sans-serif' : '800 28px "Avenir Next", sans-serif';
    ctx.fillText('Skyline Studio', 30, 48);

    ctx.fillStyle = '#bfe0ff';
    ctx.font = compact ? '600 16px "Avenir Next", sans-serif' : '600 18px "Avenir Next", sans-serif';
    ctx.fillText(`Instrument: ${state.instrument.toUpperCase()}`, 30, 72);

    const line2 = state.instrument === 'guitar'
      ? 'A S D F G to strum chords'
      : state.instrument === 'drums'
        ? 'J K L ; to play kit'
        : 'A S D F G H J K to play notes';

    ctx.fillStyle = '#ffd77e';
    ctx.fillText(line2, 30, 96);
    ctx.fillStyle = '#bfe0ff';
    ctx.fillText('Switch: 1 Guitar, 2 Drums, 3 Piano', 30, 118);

    if (state.lastEvent) {
      ctx.fillStyle = '#7bffcb';
      const age = state.now - state.lastEvent.t;
      const alpha = Math.max(0, 1 - age * 1.2);
      ctx.globalAlpha = alpha;
      ctx.fillText(`${state.lastEvent.label}`, 30, compact ? 138 : 148);
      ctx.globalAlpha = 1;
    }
  }

  function drawCharacter() {
    const w = canvas.width;
    const h = canvas.height;
    const spriteKey = instrumentSpriteKey();
    const img = images[spriteKey];

    const floorY = Math.floor(h * 0.78);

    const bob = Math.sin(state.now * 7.5) * 2;
    const scale = w < 900 ? 0.66 : 0.78;
    const size = Math.floor(720 * scale);

    if (img) {
      const x = Math.floor(w * 0.52 - size * 0.45);
      const y = Math.floor(floorY - size * 0.86 + bob);
      // Add a subtle squash/stretch pulse on each note/hit for extra life.
      const pulsing = state.now < state.animBeatUntil;
      const sx = pulsing ? 1.02 : 1.0;
      const sy = pulsing ? 0.98 : 1.0;
      ctx.save();
      ctx.translate(x + size / 2, y + size / 2);
      ctx.scale(sx, sy);
      ctx.drawImage(img, -size / 2, -size / 2, size, size);
      ctx.restore();
    } else {
      ctx.fillStyle = '#66b8ff';
      ctx.fillRect(w * 0.5 - 80, floorY - 220, 160, 220);
    }

    // spotlight / action flare when playing
    if (state.now < state.playingUntil) {
      ctx.fillStyle = 'rgba(100,255,206,0.16)';
      ctx.beginPath();
      ctx.ellipse(w * 0.52, floorY - 200, 220, 88, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function render() {
    drawBackground();
    drawCharacter();
    drawUI();
  }

  function update(dt) {
    state.now += dt;
  }

  function tick(ts) {
    const now = ts / 1000;
    if (!tick._last) tick._last = now;
    const dt = Math.min(0.05, now - tick._last);
    tick._last = now;

    update(dt);
    render();
    requestAnimationFrame(tick);
  }

  function start() {
    state.mode = 'playing';
    overlay.classList.add('hidden');
    buildTouchPads();
    render();
  }

  // Develop-web-game hooks
  window.render_game_to_text = () => {
    return JSON.stringify({
      mode: state.mode,
      instrument: state.instrument,
      playing: state.now < state.playingUntil,
      sprite_key: instrumentSpriteKey(),
      last_event: state.lastEvent,
    });
  };

  window.advanceTime = (ms) => {
    const steps = Math.max(1, Math.round(ms / (1000 / 60)));
    for (let i = 0; i < steps; i++) {
      update(1 / 60);
    }
    render();
  };

  choiceButtons.forEach((b) => {
    b.addEventListener('click', () => {
      ensureAudio();
      setInstrument(b.dataset.instrument);
    });
  });

  startBtn.addEventListener('click', () => {
    ensureAudio();
    start();
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'Digit1') return setInstrument('guitar');
    if (e.code === 'Digit2') return setInstrument('drums');
    if (e.code === 'Digit3') return setInstrument('piano');
    if (state.mode !== 'playing') return;
    state.keysDown.add(e.code);
    trigger(e.code);
  });

  window.addEventListener('keyup', (e) => {
    state.keysDown.delete(e.code);
  });

  window.addEventListener('resize', resize);

  setInstrument('guitar');

  loadImages().then(() => {
    resize();
    render();
    requestAnimationFrame(tick);
  });
})();
