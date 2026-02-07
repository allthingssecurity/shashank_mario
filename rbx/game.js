(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const menu = document.getElementById('menu');
  const startBtn = document.getElementById('start-btn');
  const stageWrap = document.querySelector('.stage-wrap');

  const tLeft = document.getElementById('touch-left');
  const tRight = document.getElementById('touch-right');
  const tUp = document.getElementById('touch-up');
  const tDown = document.getElementById('touch-down');
  const tTalk = document.getElementById('touch-interact');

  const ASSETS = {
    heroFront: '../output/imagegen/rbx_hero_front_idle.png',
    heroBack: '../output/imagegen/rbx_hero_back_idle.png',
    heroWalk1: '../output/imagegen/rbx_hero_right_walk1.png',
    heroWalk2: '../output/imagegen/rbx_hero_right_walk2.png',
    tile: '../output/imagegen/ground_tile.png',
    sky: '../output/imagegen/sky_bg_platformer.png',
    crystal: '../output/imagegen/coin.png',
  };

  const TILE = 64;
  const FIXED_DT = 1 / 60;

  const state = {
    mode: 'loading', // loading | menu | play | dialogue | victory
    now: 0,
    player: {
      // Spawn in a clear corridor (avoid initial wall overlap).
      x: 4 * TILE,
      y: 10 * TILE,
      vx: 0,
      vy: 0,
      facing: 'down', // down|up|left|right
      step: 0,
    },
    camera: { x: 0, y: 0 },
    quest: {
      crystals: 0,
      gateUnlocked: false,
      talkedToElder: false,
    },
    dialogue: null,
    flash: 0,
    keys: new Set(),
    interactEdge: false,
  };

  const images = {};

  const world = {
    w: 28,
    h: 16,
    walls: new Set(),
    crystals: [],
    npcs: [],
    gate: { x: 24 * TILE, y: 7 * TILE, w: TILE, h: TILE * 2, open: false },
  };

  function clamp(v, a, b) {
    return Math.max(a, Math.min(b, v));
  }

  function aabb(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
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

  function isSolidTile(tx, ty) {
    if (tx < 0 || ty < 0 || tx >= world.w || ty >= world.h) return true;
    return world.walls.has(`${tx},${ty}`);
  }

  function buildWorld() {
    world.walls.clear();
    world.crystals = [
      { x: 10 * TILE + 18, y: 4 * TILE + 18, r: 18, taken: false },
      { x: 15 * TILE + 18, y: 11 * TILE + 18, r: 18, taken: false },
      { x: 21 * TILE + 18, y: 5 * TILE + 18, r: 18, taken: false },
    ];

    world.npcs = [
      {
        id: 'elder',
        name: 'Elder Nimbus',
        x: 5 * TILE,
        y: 3 * TILE,
        w: TILE,
        h: TILE,
      },
      {
        id: 'guard',
        name: 'Gate Guard',
        x: 23 * TILE,
        y: 8 * TILE,
        w: TILE,
        h: TILE,
      }
    ];

    // Outer border walls
    for (let x = 0; x < world.w; x++) {
      world.walls.add(`${x},0`);
      world.walls.add(`${x},${world.h - 1}`);
    }
    for (let y = 0; y < world.h; y++) {
      world.walls.add(`0,${y}`);
      world.walls.add(`${world.w - 1},${y}`);
    }

    // Simple interior walls / paths (kept away from initial spawn corridor)
    for (let x = 3; x < 12; x++) world.walls.add(`${x},9`);
    for (let y = 2; y < 7; y++) world.walls.add(`12,${y}`);
    for (let x = 12; x < 20; x++) world.walls.add(`${x},2`);
    for (let y = 8; y < 14; y++) world.walls.add(`18,${y}`);

    // Gate blockers (open/closed handled at collision time)
    // Keep gate area clear except the gate rectangle itself.
  }

  function playerRect() {
    // Blocky hero collision box.
    return { x: state.player.x + 18, y: state.player.y + 34, w: 44, h: 54 };
  }

  function gateSolidRect() {
    return { x: world.gate.x + 10, y: world.gate.y, w: world.gate.w - 20, h: world.gate.h };
  }

  function collidesAt(nx, ny) {
    const pr = { ...playerRect(), x: nx + 18, y: ny + 34 };

    const minTx = Math.floor(pr.x / TILE);
    const maxTx = Math.floor((pr.x + pr.w - 1) / TILE);
    const minTy = Math.floor(pr.y / TILE);
    const maxTy = Math.floor((pr.y + pr.h - 1) / TILE);

    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        if (isSolidTile(tx, ty)) return true;
      }
    }

    if (!state.quest.gateUnlocked) {
      const g = gateSolidRect();
      if (aabb(pr.x, pr.y, pr.w, pr.h, g.x, g.y, g.w, g.h)) return true;
    }

    return false;
  }

  function move(dt) {
    const p = state.player;
    const left = state.keys.has('ArrowLeft') || state.keys.has('KeyA');
    const right = state.keys.has('ArrowRight') || state.keys.has('KeyD');
    const up = state.keys.has('ArrowUp') || state.keys.has('KeyW');
    const down = state.keys.has('ArrowDown') || state.keys.has('KeyS');

    const ax = (right ? 1 : 0) - (left ? 1 : 0);
    const ay = (down ? 1 : 0) - (up ? 1 : 0);

    const len = Math.hypot(ax, ay) || 1;
    const dx = (ax / len) * 240 * dt;
    const dy = (ay / len) * 240 * dt;

    if (ax !== 0 || ay !== 0) {
      if (Math.abs(ax) > Math.abs(ay)) p.facing = ax > 0 ? 'right' : 'left';
      else p.facing = ay > 0 ? 'down' : 'up';
      p.step += dt * 8;
    }

    const nx = p.x + dx;
    if (!collidesAt(nx, p.y)) p.x = nx;

    const ny = p.y + dy;
    if (!collidesAt(p.x, ny)) p.y = ny;
  }

  function nearestNpc() {
    const pr = playerRect();
    let best = null;
    let bestD = Infinity;
    for (const n of world.npcs) {
      const cx = n.x + n.w / 2;
      const cy = n.y + n.h / 2;
      const px = pr.x + pr.w / 2;
      const py = pr.y + pr.h / 2;
      const d = Math.hypot(cx - px, cy - py);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    if (bestD < 110) return best;
    return null;
  }

  function startDialogue(npc) {
    if (!npc) return;
    state.mode = 'dialogue';

    if (npc.id === 'elder') {
      if (!state.quest.talkedToElder) {
        state.dialogue = {
          npc: npc.name,
          text: 'Welcome, hero. The gate only responds to crystal energy. Bring me 3 crystals.',
          choices: [
            { label: 'On it.', fn: () => { state.quest.talkedToElder = true; endDialogue(); } },
          ],
        };
      } else if (state.quest.crystals < 3) {
        state.dialogue = {
          npc: npc.name,
          text: `You have ${state.quest.crystals}/3 crystals. Search the valley and return.` ,
          choices: [
            { label: 'Okay.', fn: () => endDialogue() },
          ],
        };
      } else if (!state.quest.gateUnlocked) {
        state.dialogue = {
          npc: npc.name,
          text: 'Excellent. I will unlock the gate. Your story continues beyond the clouds.',
          choices: [
            { label: 'Unlock it.', fn: () => { state.quest.gateUnlocked = true; state.flash = 0.25; endDialogue(); } },
          ],
        };
      } else {
        state.dialogue = {
          npc: npc.name,
          text: 'The gate is open. Go, hero.',
          choices: [
            { label: 'Thanks.', fn: () => endDialogue() },
          ],
        };
      }
      return;
    }

    if (npc.id === 'guard') {
      if (!state.quest.gateUnlocked) {
        state.dialogue = {
          npc: npc.name,
          text: 'Halt. The gate is sealed. Talk to the Elder Nimbus.',
          choices: [
            { label: 'Alright.', fn: () => endDialogue() },
          ],
        };
      } else {
        state.dialogue = {
          npc: npc.name,
          text: 'Gate is open. Step through when ready.',
          choices: [
            { label: 'Enter gate.', fn: () => { endDialogue(); state.mode = 'victory'; } },
            { label: 'Not yet.', fn: () => endDialogue() },
          ],
        };
      }
      return;
    }
  }

  function endDialogue() {
    state.dialogue = null;
    state.mode = 'play';
  }

  function collectCrystals() {
    const pr = playerRect();
    for (const c of world.crystals) {
      if (c.taken) continue;
      if (aabb(pr.x, pr.y, pr.w, pr.h, c.x - c.r, c.y - c.r, c.r * 2, c.r * 2)) {
        c.taken = true;
        state.quest.crystals += 1;
        state.flash = 0.12;
      }
    }
  }

  function update(dt) {
    state.now += dt;
    state.flash = Math.max(0, state.flash - dt);

    if (state.mode === 'play') {
      move(dt);
      collectCrystals();

      if (state.interactEdge) {
        state.interactEdge = false;
        const npc = nearestNpc();
        if (npc) startDialogue(npc);
      }

      // Victory trigger if player walks through gate area
      if (state.quest.gateUnlocked) {
        const pr = playerRect();
        if (aabb(pr.x, pr.y, pr.w, pr.h, world.gate.x, world.gate.y, world.gate.w, world.gate.h)) {
          state.mode = 'victory';
        }
      }
    }

    // Camera: keep player near center
    const w = canvas.width;
    const h = canvas.height;
    const cx = state.player.x + 48;
    const cy = state.player.y + 64;
    state.camera.x = clamp(cx - w * 0.5, 0, world.w * TILE - w);
    state.camera.y = clamp(cy - h * 0.5, 0, world.h * TILE - h);
  }

  function drawBg() {
    const w = canvas.width;
    const h = canvas.height;
    if (images.sky) {
      ctx.drawImage(images.sky, 0, 0, w, h);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.fillRect(0, 0, w, h);
    } else {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#2d6cff');
      g.addColorStop(1, '#07142e');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
  }

  function drawTiles() {
    const pat = images.tile ? ctx.createPattern(images.tile, 'repeat') : null;
    const camX = state.camera.x;
    const camY = state.camera.y;

    const minTx = Math.floor(camX / TILE);
    const maxTx = Math.ceil((camX + canvas.width) / TILE);
    const minTy = Math.floor(camY / TILE);
    const maxTy = Math.ceil((camY + canvas.height) / TILE);

    // floor
    ctx.save();
    ctx.translate(-camX, -camY);
    ctx.fillStyle = pat || '#2a7b44';
    ctx.globalAlpha = pat ? 0.7 : 1;
    ctx.fillRect(0, 0, world.w * TILE, world.h * TILE);
    ctx.globalAlpha = 1;

    // walls
    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        if (!world.walls.has(`${tx},${ty}`)) continue;
        const x = tx * TILE;
        const y = ty * TILE;
        ctx.fillStyle = 'rgba(7, 14, 28, 0.55)';
        ctx.fillRect(x, y, TILE, TILE);
        ctx.strokeStyle = 'rgba(180, 220, 255, 0.12)';
        ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
      }
    }

    // Gate
    const g = world.gate;
    ctx.fillStyle = state.quest.gateUnlocked ? 'rgba(120,255,200,0.25)' : 'rgba(255,210,120,0.28)';
    ctx.fillRect(g.x, g.y, g.w, g.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.strokeRect(g.x + 0.5, g.y + 0.5, g.w - 1, g.h - 1);

    ctx.restore();
  }

  function drawEntities() {
    const camX = state.camera.x;
    const camY = state.camera.y;

    // Crystals
    for (const c of world.crystals) {
      if (c.taken) continue;
      const x = c.x - camX;
      const y = c.y - camY;
      if (images.crystal) {
        const bob = Math.sin(state.now * 6 + c.x * 0.01) * 4;
        ctx.drawImage(images.crystal, x - 18, y - 18 + bob, 36, 36);
      } else {
        ctx.fillStyle = '#ffd763';
        ctx.beginPath();
        ctx.arc(x, y, c.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // NPCs
    for (const n of world.npcs) {
      const x = n.x - camX;
      const y = n.y - camY;
      ctx.fillStyle = n.id === 'elder' ? 'rgba(120, 200, 255, 0.95)' : 'rgba(255, 170, 120, 0.95)';
      ctx.fillRect(x + 10, y + 12, TILE - 20, TILE - 18);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(x + 14, y + 16, TILE - 28, 10);
      ctx.fillStyle = '#eaf6ff';
      ctx.font = '700 12px Avenir Next, sans-serif';
      ctx.fillText(n.id === 'elder' ? 'ELDER' : 'GUARD', x + 14, y + 26);
    }

    // Player
    const p = state.player;
    const px = p.x - camX;
    const py = p.y - camY;

    let img = images.heroFront;
    let flip = 1;

    const walking = (state.keys.has('ArrowLeft') || state.keys.has('KeyA') || state.keys.has('ArrowRight') || state.keys.has('KeyD') || state.keys.has('ArrowUp') || state.keys.has('KeyW') || state.keys.has('ArrowDown') || state.keys.has('KeyS'));

    if (p.facing === 'up') img = images.heroBack || img;
    if (p.facing === 'down') img = images.heroFront || img;
    if (p.facing === 'right') {
      img = (walking ? (Math.floor(p.step) % 2 === 0 ? images.heroWalk1 : images.heroWalk2) : images.heroWalk1) || img;
    }
    if (p.facing === 'left') {
      img = (walking ? (Math.floor(p.step) % 2 === 0 ? images.heroWalk1 : images.heroWalk2) : images.heroWalk1) || img;
      flip = -1;
    }

    if (img) {
      const size = 96;
      ctx.save();
      ctx.translate(px + size / 2, py + size / 2);
      ctx.scale(flip, 1);
      ctx.drawImage(img, -size / 2, -size / 2, size, size);
      ctx.restore();
    }

    // Interaction prompt
    if (state.mode === 'play') {
      const n = nearestNpc();
      if (n) {
        ctx.fillStyle = 'rgba(8, 18, 42, 0.65)';
        ctx.fillRect(18, canvas.height - 74, 520, 56);
        ctx.fillStyle = '#eef6ff';
        ctx.font = '800 18px Avenir Next, sans-serif';
        ctx.fillText(`${n.name}`, 32, canvas.height - 46);
        ctx.fillStyle = '#ffd77e';
        ctx.font = '700 16px Avenir Next, sans-serif';
        ctx.fillText('Press E (or TALK) to speak', 32, canvas.height - 26);
      }
    }
  }

  function drawHud() {
    ctx.fillStyle = 'rgba(8, 18, 42, 0.58)';
    ctx.fillRect(18, 18, 460, 106);
    ctx.fillStyle = '#eef6ff';
    ctx.font = '900 26px Avenir Next, sans-serif';
    ctx.fillText('BlockQuest', 32, 48);
    ctx.fillStyle = '#bfe0ff';
    ctx.font = '700 18px Avenir Next, sans-serif';
    ctx.fillText(`Crystals: ${state.quest.crystals}/3`, 32, 76);
    ctx.fillText(`Gate: ${state.quest.gateUnlocked ? 'OPEN' : 'SEALED'}`, 32, 98);

    if (!state.quest.talkedToElder) {
      ctx.fillStyle = '#ffd77e';
      ctx.fillText('Objective: Talk to the Elder', 210, 76);
    } else if (!state.quest.gateUnlocked) {
      ctx.fillStyle = '#ffd77e';
      ctx.fillText('Objective: Bring 3 crystals to Elder', 210, 76);
    } else {
      ctx.fillStyle = '#7bffcb';
      ctx.fillText('Objective: Enter the gate', 210, 76);
    }

    if (state.flash > 0) {
      ctx.fillStyle = `rgba(255, 230, 120, ${state.flash * 2.0})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  function drawDialogue() {
    const d = state.dialogue;
    if (!d) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, w, h);

    const bx = 40;
    const by = h - 220;
    const bw = w - 80;
    const bh = 180;

    ctx.fillStyle = 'rgba(8, 18, 42, 0.92)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.strokeStyle = 'rgba(131, 186, 255, 0.42)';
    ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);

    ctx.fillStyle = '#eef6ff';
    ctx.font = '900 22px Avenir Next, sans-serif';
    ctx.fillText(d.npc, bx + 18, by + 34);

    ctx.fillStyle = '#bfe0ff';
    ctx.font = '700 18px Avenir Next, sans-serif';
    wrapText(d.text, bx + 18, by + 64, bw - 36, 22);

    // Choices
    const choices = d.choices || [];
    ctx.fillStyle = '#ffd77e';
    ctx.font = '800 16px Avenir Next, sans-serif';
    ctx.fillText('Press 1..9 to choose', bx + 18, by + 150);

    ctx.fillStyle = '#7bffcb';
    ctx.font = '800 18px Avenir Next, sans-serif';
    for (let i = 0; i < choices.length; i++) {
      ctx.fillText(`${i + 1}. ${choices[i].label}`, bx + 220 + i * 220, by + 150);
    }
  }

  function wrapText(text, x, y, maxWidth, lineHeight) {
    const words = String(text).split(' ');
    let line = '';
    for (let i = 0; i < words.length; i++) {
      const test = line + words[i] + ' ';
      const w = ctx.measureText(test).width;
      if (w > maxWidth && i > 0) {
        ctx.fillText(line, x, y);
        line = words[i] + ' ';
        y += lineHeight;
      } else {
        line = test;
      }
    }
    ctx.fillText(line, x, y);
  }

  function drawVictory() {
    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#d7ffe9';
    ctx.font = '900 56px Avenir Next, sans-serif';
    ctx.fillText('Quest Complete!', w * 0.5 - 230, h * 0.45);
    ctx.font = '800 22px Avenir Next, sans-serif';
    ctx.fillText('The next chapter is coming soon.', w * 0.5 - 210, h * 0.52);
  }

  function render() {
    drawBg();
    drawTiles();
    drawEntities();
    drawHud();

    if (state.mode === 'dialogue') drawDialogue();
    if (state.mode === 'victory') drawVictory();
  }

  function fixedStep(dt) {
    update(dt);
    render();
  }

  function tick(ts) {
    const t = ts / 1000;
    if (!tick._last) tick._last = t;
    let frame = Math.min(0.05, t - tick._last);
    tick._last = t;
    tick._acc = (tick._acc || 0) + frame;
    while (tick._acc >= FIXED_DT) {
      fixedStep(FIXED_DT);
      tick._acc -= FIXED_DT;
    }
    requestAnimationFrame(tick);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(320, Math.floor(rect.width));
    canvas.height = Math.max(240, Math.floor(rect.height));
    render();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement === stageWrap) {
      document.exitFullscreen().catch(() => {});
    } else {
      stageWrap.requestFullscreen().catch(() => {});
    }
  }

  function startGame() {
    state.mode = 'play';
    menu.classList.add('hidden');
  }

  function bindTouch(btn, code, edgeInteract) {
    if (!btn) return;
    const down = (e) => {
      e.preventDefault();
      state.keys.add(code);
      if (edgeInteract) state.interactEdge = true;
    };
    const up = (e) => {
      e.preventDefault();
      state.keys.delete(code);
    };
    btn.addEventListener('pointerdown', down, { passive: false });
    btn.addEventListener('pointerup', up, { passive: false });
    btn.addEventListener('pointercancel', up, { passive: false });
    btn.addEventListener('pointerleave', up, { passive: false });
  }

  // develop-web-game hooks
  window.render_game_to_text = () => {
    const npc = nearestNpc();
    return JSON.stringify({
      coordinate_system: 'origin top-left, +x right, +y down; world in pixels',
      mode: state.mode,
      player: {
        x: Number(state.player.x.toFixed(1)),
        y: Number(state.player.y.toFixed(1)),
        facing: state.player.facing,
      },
      quest: {
        crystals: state.quest.crystals,
        gate_unlocked: state.quest.gateUnlocked,
        talked_to_elder: state.quest.talkedToElder,
      },
      nearest_npc: npc ? { id: npc.id, name: npc.name } : null,
      dialogue: state.dialogue ? { npc: state.dialogue.npc, text: state.dialogue.text, choices: state.dialogue.choices.map((c) => c.label) } : null,
    });
  };

  window.advanceTime = (ms) => {
    const steps = Math.max(1, Math.round(ms / (1000 / 60)));
    for (let i = 0; i < steps; i++) fixedStep(FIXED_DT);
  };

  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyF') {
      e.preventDefault();
      toggleFullscreen();
      return;
    }

    if (state.mode === 'dialogue') {
      const idx = Number(e.key) - 1;
      if (Number.isFinite(idx) && state.dialogue && state.dialogue.choices && state.dialogue.choices[idx]) {
        state.dialogue.choices[idx].fn();
      }
      return;
    }

    if (e.code === 'KeyE' && state.mode === 'play') {
      state.interactEdge = true;
      return;
    }

    state.keys.add(e.code);
  });

  window.addEventListener('keyup', (e) => {
    state.keys.delete(e.code);
  });

  window.addEventListener('blur', () => {
    state.keys.clear();
  });

  startBtn.addEventListener('click', startGame);

  bindTouch(tLeft, 'ArrowLeft', false);
  bindTouch(tRight, 'ArrowRight', false);
  bindTouch(tUp, 'ArrowUp', false);
  bindTouch(tDown, 'ArrowDown', false);
  bindTouch(tTalk, 'KeyE', true);

  window.addEventListener('resize', resize);
  document.addEventListener('fullscreenchange', resize);

  buildWorld();
  resize();

  loadImages().then(() => {
    state.mode = 'menu';
    menu.classList.remove('hidden');
    render();
    requestAnimationFrame(tick);
  });
})();
