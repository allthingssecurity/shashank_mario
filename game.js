(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const menu = document.getElementById('menu');
  const startBtn = document.getElementById('start-btn');
  const stageWrap = document.querySelector('.stage-wrap');

  const TILE = 64;
  const GRAVITY = 2100;
  const PLAYER_SPEED = 360;
  const PLAYER_JUMP = 1040;
  const FIXED_DT = 1 / 60;

  const assets = {
    heroIdle: 'output/imagegen/hero_idle.png',
    heroRun: 'output/imagegen/hero_run.png',
    heroJump: 'output/imagegen/hero_jump.png',
    enemyBlob: 'output/imagegen/enemy_blob.png',
    enemyBeetle: 'output/imagegen/enemy_beetle.png',
    enemyFlyer: 'output/imagegen/enemy_flyer.png',
    coin: 'output/imagegen/coin.png',
    tile: 'output/imagegen/ground_tile.png',
    sky: 'output/imagegen/sky_bg_platformer.png',
  };

  const levelDefs = [
    {
      name: 'Neon Meadows',
      rows: [
        '................................................................',
        '................................................................',
        '................................................................',
        '.........................................................G......',
        '...........................................###..................',
        '...............................C................................',
        '.....................####......................F................',
        '.........C...........................................###....B...',
        '....S...........#####..........E................................',
        '..######....................................C...................',
        '.....................#######..............................C......',
        '################################################################'
      ]
    },
    {
      name: 'Cloud Foundry',
      rows: [
        '................................................................',
        '................................................................',
        '................................................................',
        '..........................................................G.....',
        '..............................................###...............',
        '............................C............................F......',
        '..............#####.....................E...........B...........',
        '.................................####...............C............',
        '..S............E..........................####...................',
        '..######...................C.....................................',
        '..................#######.....................E..........B...C...',
        '################################################################'
      ]
    },
    {
      name: 'Skyline Citadel',
      rows: [
        '................................................................',
        '................................................................',
        '................................................................',
        '............................................................G.F.',
        '.........................................###..............B.....',
        '......................C.........................................',
        '.............####...................E.............F....####.....',
        '...............................................C...........B....',
        '..S.........E.........####.....E..............................F..',
        '..######.........................#####......................C....',
        '......................#######.....................E.......B......',
        '################################################################'
      ]
    }
  ];

  const state = {
    mode: 'loading',
    levelIndex: 0,
    level: null,
    player: null,
    enemies: [],
    coins: [],
    score: 0,
    lives: 3,
    cameraX: 0,
    elapsed: 0,
    particleFlash: 0,
    levelClearTimer: 0,
    message: '',
  };

  const imageCache = {};
  const input = {
    pressed: new Set(),
    jumpQueued: false,
  };
  let audioCtx = null;

  let levelSpawn = { x: 3 * TILE, y: 6 * TILE };
  let rafId = null;
  let accumulator = 0;
  let lastTs = 0;

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function aabb(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function createPlayer(x, y) {
    return {
      x,
      y,
      w: 58,
      h: 88,
      vx: 0,
      vy: 0,
      facing: 1,
      onGround: false,
      invuln: 0,
      runClock: 0,
    };
  }

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

  function playTone(type, frequency, duration, gain, ramp = 'exp') {
    const ac = ensureAudio();
    if (!ac) return;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, ac.currentTime);
    g.gain.setValueAtTime(Math.max(0.0001, gain), ac.currentTime);
    if (ramp === 'exp') {
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + duration);
    } else {
      g.gain.linearRampToValueAtTime(0.0001, ac.currentTime + duration);
    }
    osc.connect(g).connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + duration);
  }

  function sfxJump() {
    playTone('square', 420, 0.08, 0.05);
    playTone('square', 620, 0.06, 0.04);
  }

  function sfxCoin() {
    playTone('triangle', 880, 0.06, 0.06);
    playTone('triangle', 1180, 0.09, 0.05);
  }

  function sfxStomp() {
    playTone('sawtooth', 190, 0.08, 0.05, 'linear');
  }

  function sfxHurt() {
    playTone('square', 180, 0.11, 0.05, 'linear');
  }

  function sfxWin() {
    playTone('triangle', 520, 0.08, 0.05);
    playTone('triangle', 780, 0.09, 0.05);
    playTone('triangle', 1040, 0.1, 0.05);
  }

  function sfxLevelClear() {
    playTone('triangle', 620, 0.08, 0.05);
    playTone('triangle', 820, 0.08, 0.05);
    playTone('triangle', 980, 0.1, 0.05);
  }

  function parseLevel(def) {
    const rows = def.rows;
    const h = rows.length;
    const w = rows[0].length;
    const solids = new Array(h).fill(null).map(() => new Array(w).fill(false));
    const coins = [];
    const enemies = [];
    let spawn = { x: 2 * TILE, y: 5 * TILE };
    let goal = { x: (w - 4) * TILE, y: 6 * TILE, w: 42, h: 134 };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = rows[y][x];
        if (c === '#') solids[y][x] = true;
        if (c === 'S') spawn = { x: x * TILE + 6, y: y * TILE - 14 };
        if (c === 'G') goal = { x: x * TILE + 16, y: y * TILE - 42, w: 42, h: 134 };
        if (c === 'C') coins.push({ x: x * TILE + 18, y: y * TILE + 18, w: 28, h: 28, taken: false });
        if (c === 'E' || c === 'B' || c === 'F') {
          const type = c === 'B' ? 'beetle' : c === 'F' ? 'flyer' : 'blob';
          const base = {
            x: x * TILE + 8,
            y: y * TILE + 6,
            vx: -120,
            vy: 0,
            alive: true,
            onGround: false,
            hp: 1,
            phase: Math.random() * Math.PI * 2,
            anchorY: y * TILE + 4,
          };
          if (type === 'blob') enemies.push({ ...base, type, w: 56, h: 52, speed: 120 });
          if (type === 'beetle') enemies.push({ ...base, type, w: 60, h: 44, speed: 150, hp: 2, armored: true });
          if (type === 'flyer') enemies.push({ ...base, type, w: 56, h: 42, speed: 140, gravityless: true, anchorY: y * TILE + 10 });
        }
      }
    }

    return {
      name: def.name,
      rows,
      h,
      w,
      solids,
      goal,
      coins,
      enemies,
      worldW: w * TILE,
      worldH: h * TILE,
      spawn,
      goalUnlocked: false,
    };
  }

  function isSolidAt(tx, ty) {
    if (!state.level) return false;
    if (tx < 0 || ty < 0 || ty >= state.level.h || tx >= state.level.w) return true;
    return state.level.solids[ty][tx];
  }

  function rectTileRange(r) {
    return {
      minX: Math.floor(r.x / TILE),
      maxX: Math.floor((r.x + r.w - 0.001) / TILE),
      minY: Math.floor(r.y / TILE),
      maxY: Math.floor((r.y + r.h - 0.001) / TILE),
    };
  }

  function resolveHorizontal(body) {
    if (body.vx === 0) return;
    const range = rectTileRange(body);
    for (let y = range.minY; y <= range.maxY; y++) {
      for (let x = range.minX; x <= range.maxX; x++) {
        if (!isSolidAt(x, y)) continue;
        const tile = { x: x * TILE, y: y * TILE, w: TILE, h: TILE };
        if (!aabb(body, tile)) continue;
        if (body.vx > 0) {
          body.x = tile.x - body.w;
        } else {
          body.x = tile.x + tile.w;
        }
        body.vx = 0;
      }
    }
  }

  function resolveVertical(body) {
    body.onGround = false;
    if (body.vy === 0) return;
    const range = rectTileRange(body);
    for (let y = range.minY; y <= range.maxY; y++) {
      for (let x = range.minX; x <= range.maxX; x++) {
        if (!isSolidAt(x, y)) continue;
        const tile = { x: x * TILE, y: y * TILE, w: TILE, h: TILE };
        if (!aabb(body, tile)) continue;
        if (body.vy > 0) {
          body.y = tile.y - body.h;
          body.onGround = true;
        } else {
          body.y = tile.y + tile.h;
        }
        body.vy = 0;
      }
    }
  }

  function loseLife() {
    if (state.mode !== 'playing') return;
    state.lives -= 1;
    if (state.lives <= 0) {
      state.mode = 'gameover';
      state.message = 'Game Over';
      sfxHurt();
      updateMenu();
      return;
    }
    sfxHurt();
    loadLevel(state.levelIndex, true);
  }

  function loadLevel(levelIndex, preserveLives) {
    state.levelIndex = levelIndex;
    state.level = parseLevel(levelDefs[levelIndex]);
    levelSpawn = state.level.spawn;
    state.player = createPlayer(levelSpawn.x, levelSpawn.y);
    state.enemies = state.level.enemies.map((e) => ({ ...e }));
    state.coins = state.level.coins.map((c) => ({ ...c }));
    state.cameraX = 0;
    state.particleFlash = 0;
    state.levelClearTimer = 0;
    if (!preserveLives) state.lives = 3;
    state.mode = 'playing';
    updateMenu();
  }

  function winLevel() {
    if (state.levelIndex + 1 >= levelDefs.length) {
      state.mode = 'victory';
      state.score += 1000;
      state.message = 'You Win';
      sfxWin();
      updateMenu();
      return;
    }
    loadLevel(state.levelIndex + 1, true);
  }

  function beginLevelClear() {
    if (state.mode !== 'playing') return;
    state.mode = 'level_clear';
    state.levelClearTimer = 1.25;
    state.score += 500;
    sfxLevelClear();
  }

  function updatePlayer(dt) {
    const p = state.player;
    const left = input.pressed.has('ArrowLeft') || input.pressed.has('KeyA');
    const right = input.pressed.has('ArrowRight') || input.pressed.has('KeyD');

    const axis = (right ? 1 : 0) - (left ? 1 : 0);
    p.vx = axis * PLAYER_SPEED;
    if (axis !== 0) p.facing = axis > 0 ? 1 : -1;

    if (input.jumpQueued && p.onGround) {
      p.vy = -PLAYER_JUMP;
      p.onGround = false;
      sfxJump();
    }
    input.jumpQueued = false;

    p.vy += GRAVITY * dt;
    p.x += p.vx * dt;
    resolveHorizontal(p);

    p.y += p.vy * dt;
    resolveVertical(p);

    if (p.y > state.level.worldH + 220) {
      loseLife();
      return;
    }

    p.invuln = Math.max(0, p.invuln - dt);
    p.runClock += dt;
  }

  function updateEnemies(dt) {
    for (const e of state.enemies) {
      if (!e.alive) continue;
      if (e.type === 'flyer') {
        const dir = Math.sign(e.vx) || -1;
        e.vx = dir * e.speed;
        e.x += e.vx * dt;
        const nextX = e.vx > 0 ? e.x + e.w + 2 : e.x - 2;
        const tx = Math.floor(nextX / TILE);
        const topTy = Math.floor(e.y / TILE);
        const bottomTy = Math.floor((e.y + e.h - 1) / TILE);
        if (isSolidAt(tx, topTy) || isSolidAt(tx, bottomTy)) e.vx *= -1;
        e.phase += dt * 4;
        e.y = e.anchorY + Math.sin(e.phase) * 28;
        continue;
      }

      e.vx = Math.sign(e.vx || -1) * e.speed;
      e.vy += GRAVITY * dt;
      e.x += e.vx * dt;
      const preX = e.vx;
      resolveHorizontal(e);
      if (preX !== 0 && e.vx === 0) e.vx = -preX;

      e.y += e.vy * dt;
      resolveVertical(e);

      const footY = e.y + e.h + 1;
      const lookX = e.vx > 0 ? e.x + e.w + 4 : e.x - 4;
      const tx = Math.floor(lookX / TILE);
      const ty = Math.floor(footY / TILE);
      if (!isSolidAt(tx, ty) && e.onGround) e.vx = -e.vx;
      if (e.y > state.level.worldH + 240) e.alive = false;
    }
  }

  function handleInteractions() {
    const p = state.player;

    for (const coin of state.coins) {
      if (coin.taken) continue;
      if (aabb(p, coin)) {
        coin.taken = true;
        state.score += 100;
        state.particleFlash = 0.08;
        sfxCoin();
      }
    }

    for (const e of state.enemies) {
      if (!e.alive) continue;
      if (!aabb(p, e)) continue;

      const playerBottom = p.y + p.h;
      const enemyTop = e.y;
      const stomp = p.vy > 180 && playerBottom - enemyTop < 24 && p.y < e.y;
      if (stomp) {
        e.hp -= 1;
        if (e.hp <= 0) e.alive = false;
        p.vy = -620;
        state.score += e.type === 'beetle' ? 350 : e.type === 'flyer' ? 300 : 250;
        sfxStomp();
        continue;
      }

      if (p.invuln <= 0) {
        p.invuln = 1;
        loseLife();
        return;
      }
    }

    const enemiesRemaining = state.enemies.some((e) => e.alive);
    const coinsRemaining = state.coins.some((c) => !c.taken);
    state.level.goalUnlocked = !enemiesRemaining && !coinsRemaining;

    if (state.level.goalUnlocked && aabb(p, state.level.goal)) {
      beginLevelClear();
    }
  }

  function updateCamera() {
    const focus = state.player.x + state.player.w * 0.5;
    const target = focus - canvas.width * 0.35;
    state.cameraX = clamp(target, 0, Math.max(0, state.level.worldW - canvas.width));
  }

  function update(dt) {
    if (state.mode === 'level_clear') {
      state.levelClearTimer -= dt;
      if (state.levelClearTimer <= 0) winLevel();
      return;
    }
    if (state.mode !== 'playing') return;
    state.elapsed += dt;
    updatePlayer(dt);
    if (state.mode !== 'playing') return;
    updateEnemies(dt);
    handleInteractions();
    if (state.mode !== 'playing') return;
    updateCamera();
  }

  function drawSky() {
    const sky = imageCache.sky;
    if (sky) {
      ctx.fillStyle = '#66b8ff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const parallax = state.cameraX * 0.22;
      const patternX = -((parallax % canvas.width + canvas.width) % canvas.width);
      ctx.drawImage(sky, patternX, 0, canvas.width, canvas.height);
      ctx.drawImage(sky, patternX + canvas.width, 0, canvas.width, canvas.height);
      ctx.drawImage(sky, patternX - canvas.width, 0, canvas.width, canvas.height);
    } else {
      const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
      grad.addColorStop(0, '#5bb8ff');
      grad.addColorStop(1, '#8ff0ff');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    for (let i = 0; i < 5; i++) {
      const x = ((i * 260) - state.cameraX * 0.12) % (canvas.width + 320) - 160;
      const y = 100 + (i % 2) * 36;
      ctx.beginPath();
      ctx.ellipse(x, y, 74, 22, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawWorld() {
    const tilePattern = imageCache.tile ? ctx.createPattern(imageCache.tile, 'repeat') : null;

    for (let y = 0; y < state.level.h; y++) {
      for (let x = 0; x < state.level.w; x++) {
        if (!state.level.solids[y][x]) continue;
        const px = x * TILE - state.cameraX;
        const py = y * TILE;
        if (px + TILE < -2 || px > canvas.width + 2) continue;
        if (tilePattern) {
          ctx.save();
          ctx.translate(px, py);
          ctx.fillStyle = tilePattern;
          ctx.fillRect(0, 0, TILE, TILE);
          ctx.restore();
        } else {
          ctx.fillStyle = '#6a553c';
          ctx.fillRect(px, py, TILE, TILE);
        }
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
        ctx.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);
      }
    }

    const goal = state.level.goal;
    const gx = goal.x - state.cameraX;
    ctx.fillStyle = '#f2f6ff';
    ctx.fillRect(gx, goal.y, 7, goal.h);
    ctx.fillStyle = '#c6d6f2';
    ctx.fillRect(gx - 3, goal.y + goal.h - 10, 13, 10);
    const flutter = Math.sin(state.elapsed * 7) * 4;
    ctx.fillStyle = state.level.goalUnlocked ? '#56f0a9' : '#e7c56d';
    ctx.beginPath();
    ctx.moveTo(gx + 7, goal.y + 12);
    ctx.lineTo(gx + 54 + flutter, goal.y + 26);
    ctx.lineTo(gx + 7, goal.y + 40);
    ctx.closePath();
    ctx.fill();
    if (!state.level.goalUnlocked) {
      ctx.fillStyle = 'rgba(11, 20, 44, 0.55)';
      ctx.fillRect(gx + 12, goal.y + goal.h - 48, 36, 48);
      ctx.strokeStyle = '#ffd870';
      ctx.strokeRect(gx + 12.5, goal.y + goal.h - 47.5, 35, 47);
      ctx.fillStyle = '#ffd870';
      ctx.fillRect(gx + 28, goal.y + goal.h - 36, 4, 12);
    }

    for (const coin of state.coins) {
      if (coin.taken) continue;
      const x = coin.x - state.cameraX;
      const y = coin.y;
      const bob = Math.sin(state.elapsed * 7 + x * 0.04) * 4;
      const s = 0.9 + Math.sin(state.elapsed * 10 + x * 0.03) * 0.1;
      if (imageCache.coin) {
        ctx.save();
        ctx.translate(x + coin.w / 2, y + coin.h / 2 + bob);
        ctx.scale(s, 1);
        ctx.drawImage(imageCache.coin, -18, -18, 36, 36);
        ctx.restore();
      } else {
        ctx.fillStyle = '#ffd763';
        ctx.beginPath();
        ctx.arc(x + coin.w / 2, y + coin.h / 2 + bob, 12, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    for (const e of state.enemies) {
      if (!e.alive) continue;
      const x = e.x - state.cameraX;
      const y = e.y;
      const sprite =
        e.type === 'beetle'
          ? imageCache.enemyBeetle
          : e.type === 'flyer'
            ? imageCache.enemyFlyer
            : imageCache.enemyBlob;
      ctx.save();
      if (sprite) {
        const pad = e.type === 'flyer' ? 18 : 16;
        ctx.drawImage(sprite, x - pad, y - pad, e.w + pad * 2, e.h + pad * 2);
      } else {
        ctx.fillStyle = e.type === 'beetle' ? '#a37f4b' : e.type === 'flyer' ? '#7ac6ff' : '#dd5660';
        ctx.fillRect(x, y, e.w, e.h);
      }
      if (e.hp > 1) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(x + 6, y - 8, e.w - 12, 5);
        ctx.fillStyle = '#ff8c66';
        ctx.fillRect(x + 6, y - 8, ((e.w - 12) * e.hp) / 2, 5);
      }
      ctx.restore();
    }

    drawPlayer();
  }

  function drawPlayer() {
    const p = state.player;
    const x = p.x - state.cameraX;
    const y = p.y;

    let sprite = imageCache.heroIdle;
    if (!p.onGround) sprite = imageCache.heroJump || sprite;
    else if (Math.abs(p.vx) > 15) {
      sprite = (Math.floor(p.runClock * 8) % 2 === 0 ? imageCache.heroRun : imageCache.heroIdle) || sprite;
    }

    if (!sprite) {
      ctx.fillStyle = '#4578ec';
      ctx.fillRect(x, y, p.w, p.h);
      return;
    }

    ctx.save();
    if (p.invuln > 0 && Math.floor(p.invuln * 18) % 2 === 0) ctx.globalAlpha = 0.45;
    ctx.translate(x + p.w / 2, y + p.h / 2);
    // Jump sprite source is left-facing while idle/run sources are right-facing.
    const face = sprite === imageCache.heroJump ? -p.facing : p.facing;
    ctx.scale(face, 1);
    ctx.drawImage(sprite, -p.w * 0.92, -p.h * 0.9, p.w * 1.84, p.h * 1.84);
    ctx.restore();
  }

  function drawHud() {
    const coinsTaken = state.coins.filter((c) => c.taken).length;
    const coinsTotal = state.coins.length;
    const enemiesLeft = state.enemies.filter((e) => e.alive).length;

    ctx.fillStyle = 'rgba(8, 18, 36, 0.62)';
    ctx.fillRect(16, 16, 470, 126);

    ctx.fillStyle = '#eef5ff';
    ctx.font = '700 30px "Avenir Next", sans-serif';
    ctx.fillText('Skyline Run', 28, 48);

    ctx.font = '600 21px "Avenir Next", sans-serif';
    ctx.fillStyle = '#d5e7ff';
    ctx.fillText(`Level ${state.levelIndex + 1}: ${state.level.name}`, 28, 75);

    ctx.font = '600 20px "Avenir Next", sans-serif';
    ctx.fillStyle = '#b7d7ff';
    ctx.fillText(
      `Lives ${state.lives}   Coins ${coinsTaken}/${coinsTotal}   Enemies ${enemiesLeft}   Score ${state.score}`,
      28,
      102
    );
    ctx.fillStyle = state.level.goalUnlocked ? '#7bffcb' : '#ffd77e';
    ctx.fillText(state.level.goalUnlocked ? 'Flag unlocked: reach it to clear level' : 'Clear all coins + enemies to unlock flag', 28, 126);

    if (state.particleFlash > 0) {
      ctx.fillStyle = `rgba(255, 230, 120, ${state.particleFlash * 2.5})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  function render() {
    if (state.mode === 'loading') {
      ctx.fillStyle = '#06142f';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#e6f1ff';
      ctx.font = '700 46px "Avenir Next", sans-serif';
      ctx.fillText('Loading Skyline Run...', canvas.width / 2 - 220, canvas.height / 2);
      return;
    }

    drawSky();

    if (state.level) {
      drawWorld();
      drawHud();
    }

    if (state.mode === 'gameover' || state.mode === 'victory') {
      ctx.fillStyle = 'rgba(1, 8, 18, 0.42)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (state.mode === 'level_clear') {
      ctx.fillStyle = 'rgba(2, 18, 22, 0.45)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#d7ffe9';
      ctx.font = '700 52px "Avenir Next", sans-serif';
      ctx.fillText('Level Cleared!', canvas.width * 0.5 - 170, canvas.height * 0.46);
      ctx.font = '600 28px "Avenir Next", sans-serif';
      ctx.fillText('Advancing to next stage...', canvas.width * 0.5 - 170, canvas.height * 0.53);
    }
  }

  function fixedStep(dt) {
    update(dt);
    state.particleFlash = Math.max(0, state.particleFlash - dt);
    render();
  }

  function tick(ts) {
    if (!lastTs) lastTs = ts;
    const frame = Math.min(0.05, (ts - lastTs) / 1000);
    lastTs = ts;
    accumulator += frame;
    while (accumulator >= FIXED_DT) {
      fixedStep(FIXED_DT);
      accumulator -= FIXED_DT;
    }
    rafId = requestAnimationFrame(tick);
  }

  function resizeCanvas() {
    if (document.fullscreenElement === stageWrap) {
      canvas.width = Math.max(960, Math.floor(window.innerWidth));
      canvas.height = Math.max(540, Math.floor(window.innerHeight));
      canvas.style.width = `${canvas.width}px`;
      canvas.style.height = `${canvas.height}px`;
    } else {
      canvas.width = 1280;
      canvas.height = 720;
      canvas.style.width = '100%';
      canvas.style.height = 'auto';
    }
    render();
  }

  function updateMenu() {
    if (state.mode === 'playing') {
      menu.classList.add('hidden');
      return;
    }

    menu.classList.remove('hidden');
    const title = menu.querySelector('h2');
    const text = menu.querySelector('p');

    if (state.mode === 'menu') {
      title.textContent = 'Skyline Run';
      text.textContent = 'Run, jump, collect coins, avoid enemies, and reach the flag in all 3 levels.';
      startBtn.textContent = 'Start Game';
    } else if (state.mode === 'gameover') {
      title.textContent = state.message;
      text.textContent = `Score ${state.score}. Try again from level 1.`;
      startBtn.textContent = 'Retry';
    } else if (state.mode === 'victory') {
      title.textContent = state.message;
      text.textContent = `Amazing run. Final score ${state.score}.`;
      startBtn.textContent = 'Play Again';
    }
  }

  function startGame() {
    ensureAudio();
    state.score = 0;
    state.lives = 3;
    loadLevel(0, true);
    state.mode = 'playing';
    updateMenu();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement === stageWrap) {
      document.exitFullscreen().catch(() => {});
    } else {
      stageWrap.requestFullscreen().catch(() => {});
    }
  }

  function loadAssets() {
    const entries = Object.entries(assets);
    return Promise.all(
      entries.map(([key, src]) => new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
          imageCache[key] = img;
          resolve();
        };
        img.onerror = () => {
          imageCache[key] = null;
          resolve();
        };
        img.src = src;
      }))
    );
  }

  window.render_game_to_text = () => {
    const enemies = state.enemies
      .filter((e) => e.alive)
      .map((e) => ({
        type: e.type,
        hp: e.hp,
        x: Number(e.x.toFixed(1)),
        y: Number(e.y.toFixed(1)),
        vx: Number(e.vx.toFixed(1)),
      }));
    const coins = state.coins
      .filter((c) => !c.taken)
      .map((c) => ({ x: Number(c.x.toFixed(1)), y: Number(c.y.toFixed(1)) }));

    return JSON.stringify({
      coordinate_system: 'origin top-left, +x right, +y down, units in pixels',
      mode: state.mode,
      level: state.levelIndex + 1,
      level_name: state.level ? state.level.name : null,
      lives: state.lives,
      score: state.score,
      camera_x: Number(state.cameraX.toFixed(1)),
      player: state.player
        ? {
            x: Number(state.player.x.toFixed(1)),
            y: Number(state.player.y.toFixed(1)),
            vx: Number(state.player.vx.toFixed(1)),
            vy: Number(state.player.vy.toFixed(1)),
            on_ground: state.player.onGround,
          }
        : null,
      goal: state.level
        ? { x: Number(state.level.goal.x.toFixed(1)), y: Number(state.level.goal.y.toFixed(1)) }
        : null,
      goal_unlocked: state.level ? state.level.goalUnlocked : false,
      level_clear_timer: Number(state.levelClearTimer.toFixed(2)),
      enemies,
      enemies_remaining: enemies.length,
      coins,
      coins_remaining: coins.length,
    });
  };

  window.advanceTime = (ms) => {
    const steps = Math.max(1, Math.round(ms / (1000 / 60)));
    for (let i = 0; i < steps; i++) fixedStep(FIXED_DT);
  };

  window.__game_debug = {
    warpToGoal: () => {
      if (!state.player || !state.level) return;
      state.player.x = state.level.goal.x;
      state.player.y = state.level.goal.y;
    },
    clearCoins: () => {
      for (const c of state.coins) c.taken = true;
    },
    clearEnemies: () => {
      for (const e of state.enemies) {
        e.alive = false;
        e.hp = 0;
      }
      if (state.level) state.level.goalUnlocked = true;
    },
    forceLoseLife: () => {
      loseLife();
    },
    getMode: () => state.mode,
  };

  window.addEventListener('keydown', (e) => {
    input.pressed.add(e.code);
    if ((e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') && !e.repeat) {
      input.jumpQueued = true;
    }
    if (e.code === 'KeyF') {
      e.preventDefault();
      toggleFullscreen();
    }
    if (e.code === 'Escape' && document.fullscreenElement === stageWrap) {
      document.exitFullscreen().catch(() => {});
    }
  });

  window.addEventListener('keyup', (e) => {
    input.pressed.delete(e.code);
  });

  window.addEventListener('blur', () => {
    input.pressed.clear();
    input.jumpQueued = false;
  });

  window.addEventListener('resize', resizeCanvas);
  document.addEventListener('fullscreenchange', resizeCanvas);

  startBtn.addEventListener('click', () => {
    if (state.mode === 'playing') return;
    startGame();
  });

  resizeCanvas();
  updateMenu();
  render();

  loadAssets().then(() => {
    loadLevel(0, false);
    state.mode = 'menu';
    updateMenu();
    render();
    if (!rafId) rafId = requestAnimationFrame(tick);
  });
})();
