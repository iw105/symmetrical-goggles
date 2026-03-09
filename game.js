// ═══════════════════════════════════════════════════
//  RUNBD — Infinite Parkour
//  Matter.js physics · WebRTC P2P · QR signaling
// ═══════════════════════════════════════════════════

// ── MATTER ALIASES ──────────────────────────────────
const { Engine, Runner, Bodies, Body, World, Events, Query, Vector } = Matter;

// ── CONSTANTS ───────────────────────────────────────
const PLAYER_R     = 18;
const MOVE_SPD     = 5.5;
const JUMP_VEL     = -12;
const GRAVITY_Y    = 2.2;
const MAX_FALL     = 18;
const PUNCH_RANGE  = PLAYER_R * 4;
const PUNCH_FORCE  = 0.08;
const PUNCH_CD     = 30;
const ARROW_SPD    = 18;
const ARROW_CD     = 45;
const LASER_START_DELAY = 180; // frames before laser starts moving
const LASER_BASE_SPD    = 1.2; // px/frame world units
const LASER_ACCEL       = 0.00015;
const CHUNK_W      = 900;
const PLATFORM_H   = 14;

// ── COLOURS ─────────────────────────────────────────
const P_COLORS = ['#00ffcc', '#ff6b35', '#c77dff'];
const P_GLOW   = ['rgba(0,255,204,0.6)', 'rgba(255,107,53,0.6)', 'rgba(199,125,255,0.6)'];
const P_DARK   = ['#004433', '#331500', '#220033'];

// ── STATE ───────────────────────────────────────────
const G = {
  mode: null,        // 'solo'|'local2'|'local3'|'host'|'join'
  playerCount: 1,
  isHost: true,
  pc: null, dc: null, connected: false,
  engine: null, runner: null,
  players: [],       // {body, lives, cd:{punch,arrow}, alive, idx}
  arrows: [],        // {body, ownerId, age}
  platforms: [],
  chunkX: 0,         // rightmost generated world X
  cameraX: 0,        // world X of left edge of canvas
  laserX: 0,         // world X of laser front
  laserStarted: false,
  laserFrames: 0,
  laserSpeed: LASER_BASE_SPD,
  frame: 0,
  keys: {},
  remoteInputs: {},  // peerId -> keys
  animFrame: null,
  particles: [],
  gameOver: false,
  bestDist: 0,
};

// ── SCREEN HELPERS ──────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}
function setStatus(side, msg, err=false) {
  const el = document.getElementById(side+'-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'status-msg' + (err?' error':'');
}

// ── STARS (home decoration) ──────────────────────────
(function spawnStars() {
  const c = document.getElementById('stars');
  for (let i=0; i<120; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    s.style.cssText = `left:${Math.random()*100}%;top:${Math.random()*100}%;--d:${2+Math.random()*4}s;--del:${Math.random()*4}s`;
    c.appendChild(s);
  }
})();

// ── HOME BUTTONS ────────────────────────────────────
document.getElementById('btn-solo').onclick    = () => beginGame('solo', 1);
document.getElementById('btn-local2').onclick  = () => beginGame('local2', 2);
document.getElementById('btn-local3').onclick  = () => beginGame('local3', 3);
document.getElementById('btn-host').onclick    = () => { G.mode='host'; G.isHost=true; showScreen('screen-host'); initHost(); };
document.getElementById('btn-join-qr').onclick = () => { showScreen('screen-join'); setStatus('join','Waiting for QR scan / URL...'); checkURLJoin(); };
document.getElementById('btn-host-back').onclick = () => { cleanupRTC(); showScreen('screen-home'); };
document.getElementById('btn-join-back').onclick  = () => { cleanupRTC(); showScreen('screen-home'); };
document.getElementById('btn-dead-retry').onclick = () => beginGame(G.mode, G.playerCount);
document.getElementById('btn-dead-home').onclick  = () => { stopGame(); showScreen('screen-home'); };
document.getElementById('btn-host-start').onclick = () => {
  sendAll({ type:'start', playerCount: G.playerCount });
  beginGame('host', G.playerCount);
};

// ── RTC HELPERS ─────────────────────────────────────
const RTC_CFG = { iceServers:[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}] };

function cleanupRTC() {
  G.peers?.forEach(p=>{ try{p.dc?.close();p.pc?.close();}catch(e){} });
  G.peers = [];
  if(G.dc){try{G.dc.close();}catch(e){}} G.dc=null;
  if(G.pc){try{G.pc.close();}catch(e){}} G.pc=null;
  G.connected=false;
}

function waitForICE(pc, ms=6000) {
  return new Promise(res=>{
    if(pc.iceGatheringState==='complete'){res();return;}
    const t=setTimeout(res,ms);
    pc.onicecandidate=e=>{ if(!e.candidate){clearTimeout(t);res();} };
  });
}

// ── HOST FLOW ───────────────────────────────────────
G.peers = []; // array of {pc, dc, peerId}

async function initHost() {
  cleanupRTC();
  document.getElementById('host-qr').innerHTML='';
  document.getElementById('host-qr-status').textContent='Generating...';
  setStatus('host','');

  try {
    // Create first peer connection slot (for player 2)
    await addHostPeerSlot();
  } catch(e) {
    setStatus('host','Error: '+e.message, true);
  }
}

async function addHostPeerSlot() {
  const pc = new RTCPeerConnection(RTC_CFG);
  const peerId = G.peers.length + 1; // slot index (0=host)
  const slot = { pc, dc: null, peerId, connected: false };
  G.peers.push(slot);

  const dc = pc.createDataChannel('game', {ordered:false, maxRetransmits:0});
  slot.dc = dc;

  dc.onopen = () => {
    slot.connected = true;
    G.playerCount = G.peers.filter(p=>p.connected).length + 1;
    document.getElementById('host-player-count').textContent = G.playerCount + ' / 3';
    setStatus('host', '✅ Player '+G.playerCount+' connected!');
    document.getElementById('btn-host-start').disabled = false;
    dc.send(JSON.stringify({ type:'welcome', yourIdx: peerId }));
    // If room for more, create another slot and new QR
    if (G.playerCount < 3) addHostPeerSlot();
  };
  dc.onmessage = e => handleHostMsg(JSON.parse(e.data), peerId);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitForICE(pc, 6000);

  const bundle = btoa(JSON.stringify({ sdp: pc.localDescription }));
  const joinURL = window.location.href.split('?')[0] + '?join=' + encodeURIComponent(bundle);

  // Show QR
  document.getElementById('host-qr').innerHTML='';
  new QRCode(document.getElementById('host-qr'), {
    text: joinURL, width:200, height:200,
    colorDark:'#050810', colorLight:'#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });
  document.getElementById('host-qr-status').textContent = 'Scan to join as P' + (G.playerCount + 1);
}

function handleHostMsg(msg, fromPeer) {
  if (msg.type==='answer') {
    const slot = G.peers[fromPeer-1];
    slot.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
  }
  if (msg.type==='keys') {
    G.remoteInputs[fromPeer] = msg.keys;
  }
}

function sendAll(obj) {
  const s = JSON.stringify(obj);
  G.peers?.forEach(p=>{ if(p.dc?.readyState==='open') try{p.dc.send(s);}catch(e){} });
}

// ── JOIN FLOW (via QR URL) ───────────────────────────
function checkURLJoin() {
  const params = new URLSearchParams(window.location.search);
  const joinParam = params.get('join');
  if (joinParam) {
    showScreen('screen-join');
    doJoin(joinParam);
  }
}

async function doJoin(encoded) {
  setStatus('join','⏳ Connecting to host...');
  try {
    cleanupRTC();
    const bundle = JSON.parse(atob(decodeURIComponent(encoded)));
    const pc = new RTCPeerConnection(RTC_CFG);
    G.pc = pc;

    pc.ondatachannel = e => {
      G.dc = e.channel;
      G.dc.onopen = () => {
        G.connected = true;
        setStatus('join','✅ Connected! Waiting for host to start...');
      };
      G.dc.onmessage = e => handleJoinMsg(JSON.parse(e.data));
    };

    await pc.setRemoteDescription(new RTCSessionDescription(bundle.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForICE(pc, 6000);

    // Send answer back to host via a tiny relay trick:
    // We encode answer into a second URL and show it as QR for host to scan
    // BUT simpler: host is waiting for answer via the data channel open event
    // Actually for true manual: we just need host to get our answer SDP
    // We'll show a QR the HOST scans — but that requires host to be scanning
    // Better: use a public STUN trick — embed answer in a fetch to a paste service
    // SIMPLEST no-server approach: show the answer as text/QR for host to paste

    // Show answer QR on join screen for host to scan
    const ansBundle = btoa(JSON.stringify({ sdp: pc.localDescription }));
    showAnswerQR(ansBundle);

  } catch(e) {
    setStatus('join','Error: '+e.message, true);
  }
}

function showAnswerQR(ansBundle) {
  // Replace join panel content with answer QR
  const panel = document.querySelector('#screen-join .panel');
  panel.innerHTML = `
    <h2 class="panel-title">SHOW HOST</h2>
    <p class="panel-desc">Have the HOST scan this QR code, or paste the code below.</p>
    <div id="answer-qr-wrap" style="background:#fff;border-radius:10px;padding:16px;display:flex;flex-direction:column;align-items:center;gap:8px;">
      <div id="answer-qr"></div>
      <p style="color:#333;font-size:11px;font-weight:600;">Host scans this</p>
    </div>
    <label style="margin-top:8px">Or copy this answer code:</label>
    <textarea id="answer-code" readonly style="height:60px;font-size:9px;">${ansBundle}</textarea>
    <button class="btn btn-small" id="btn-copy-ans" style="margin-top:4px">📋 Copy Code</button>
    <div id="join-status" class="status-msg">Waiting for host to accept...</div>
    <button class="btn btn-ghost back-btn" id="btn-join-back2">← Back</button>
  `;
  document.getElementById('btn-join-back2').onclick = () => { cleanupRTC(); showScreen('screen-home'); };
  document.getElementById('btn-copy-ans').onclick = () => {
    navigator.clipboard.writeText(ansBundle).then(()=>{ document.getElementById('join-status').textContent='✅ Copied!'; });
  };

  // Also add a host-side "paste answer" input to the host screen
  addHostAnswerInput(ansBundle);

  new QRCode(document.getElementById('answer-qr'), {
    text: window.location.href.split('?')[0] + '?answer=' + encodeURIComponent(ansBundle),
    width:180, height:180, colorDark:'#050810', colorLight:'#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });
}

function addHostAnswerInput(prefill='') {
  // If host screen is showing, add an input for the answer
  const existing = document.getElementById('host-answer-section');
  if (existing) { document.getElementById('host-answer-ta').value = prefill; return; }
  const panel = document.querySelector('#screen-host .panel');
  const section = document.createElement('div');
  section.id = 'host-answer-section';
  section.innerHTML = `
    <label style="margin-top:8px">Paste Player Answer Code:</label>
    <textarea id="host-answer-ta" placeholder="Paste answer code here...">${prefill}</textarea>
    <button class="btn btn-small" id="btn-host-paste-answer">✅ Accept Answer</button>
  `;
  panel.insertBefore(section, document.getElementById('btn-host-start'));
  document.getElementById('btn-host-paste-answer').onclick = async () => {
    const raw = document.getElementById('host-answer-ta').value.trim();
    if (!raw) return;
    try {
      const bundle = JSON.parse(atob(decodeURIComponent(raw)));
      // Find the pending slot
      const slot = G.peers.find(p=>!p.connected);
      if (slot) await slot.pc.setRemoteDescription(new RTCSessionDescription(bundle.sdp));
      setStatus('host','⏳ Connecting...');
    } catch(e) {
      setStatus('host','Invalid answer: '+e.message, true);
    }
  };
}

// Also check for ?answer= param (if host scans the answer QR)
(function checkAnswerParam() {
  const params = new URLSearchParams(window.location.search);
  const ans = params.get('answer');
  if (ans) {
    // Host scanned the answer QR — try to accept it
    window.addEventListener('DOMContentLoaded', ()=>{ addHostAnswerInput(ans); });
  }
})();

function handleJoinMsg(msg) {
  if (msg.type==='welcome') {
    G.myIdx = msg.yourIdx;
    setStatus('join','✅ Connected as P'+(G.myIdx+1)+'! Waiting...');
  }
  if (msg.type==='start') {
    G.playerCount = msg.playerCount;
    G.mode = 'join';
    beginGame('join', msg.playerCount);
  }
  if (msg.type==='state') {
    applyNetState(msg);
  }
}

// ── BEGIN GAME ──────────────────────────────────────
function beginGame(mode, playerCount) {
  G.mode = mode;
  G.playerCount = playerCount;
  G.isHost = (mode !== 'join');
  stopGame();
  showScreen('screen-game');
  initGame();
}

function stopGame() {
  if (G.animFrame) { cancelAnimationFrame(G.animFrame); G.animFrame=null; }
  if (G.engine) { World.clear(G.engine.world); Engine.clear(G.engine); G.engine=null; }
  G.players=[];G.arrows=[];G.platforms=[];G.particles=[];
  G.keys={};G.remoteInputs={};G.frame=0;G.gameOver=false;
  G.cameraX=0;G.laserX=-300;G.laserFrames=0;G.laserSpeed=LASER_BASE_SPD;G.laserStarted=false;
  G.chunkX=0;
}

function initGame() {
  const W=cW(), H=cH();
  const canvas=document.getElementById('game-canvas');
  canvas.width=W; canvas.height=H;

  G.engine = Engine.create({ gravity:{y:GRAVITY_Y} });

  // Seed platforms
  G.chunkX = 0;
  while (G.chunkX < W*3) generateChunk(W, H);

  // Spawn players
  G.players=[];
  for (let i=0; i<G.playerCount; i++) {
    const body = Bodies.circle(120 + i*60, H*0.4, PLAYER_R, {
      label:'player'+i, restitution:0.1, friction:0.01, frictionAir:0.08,
      collisionFilter:{ category:0x0001, mask:0x0002 }
    });
    World.add(G.engine.world, body);
    G.players.push({ body, lives:3, cd:{punch:0,arrow:0}, alive:true, idx:i, grounded:false, jumpHeld:false, holdTime:0, facingRight:true, respawnFlash:0, dist:0 });
  }

  // Collision: track grounded
  Events.on(G.engine,'collisionStart', e=>{
    e.pairs.forEach(({bodyA,bodyB})=>{
      [bodyA,bodyB].forEach(b=>{
        const m=b.label?.match(/^player(\d+)$/);
        if(m){ const p=G.players[+m[1]]; if(p) p.grounded=true; }
      });
    });
  });
  Events.on(G.engine,'beforeUpdate',()=>{ G.players.forEach(p=>p.grounded=false); });

  updateHUD();
  G.animFrame = requestAnimationFrame(loop);
}

// ── PROCEDURAL GENERATION ───────────────────────────
function generateChunk(W, H) {
  const startX = G.chunkX;
  const rng = seededRand(startX);
  const groundY = H - 40;

  // Ground segment with gaps
  let x = startX;
  while (x < startX + CHUNK_W) {
    const segW = 80 + rng()*220;
    if (rng() > 0.25 || x === startX) { // 25% chance of gap
      const plat = Bodies.rectangle(x+segW/2, groundY, segW, PLATFORM_H, {
        isStatic:true, label:'platform',
        collisionFilter:{ category:0x0002, mask:0x0001 },
        render:{fillStyle:'#2d3a5a'}
      });
      World.add(G.engine.world, plat);
      G.platforms.push(plat);
    }
    x += segW + (rng()>0.7 ? 40+rng()*80 : 0);
  }

  // Floating platforms
  const numFloat = 3 + Math.floor(rng()*5);
  for (let i=0; i<numFloat; i++) {
    const px = startX + 60 + rng()*(CHUNK_W-120);
    const py = groundY - 80 - rng()*(H*0.45);
    const pw = 60 + rng()*180;
    const plat = Bodies.rectangle(px, py, pw, PLATFORM_H, {
      isStatic:true, label:'platform',
      collisionFilter:{ category:0x0002, mask:0x0001 },
      render:{fillStyle:'#1e2d4a'}
    });
    World.add(G.engine.world, plat);
    G.platforms.push(plat);
  }

  G.chunkX = startX + CHUNK_W;
}

let _rngState = 0;
function seededRand(seed) {
  let s = seed * 9301 + 49297;
  return () => { s=(s*9301+49297)%233280; return s/233280; };
}

// ── GAME LOOP ───────────────────────────────────────
function loop() {
  G.frame++;
  const W=cW(), H=cH();

  if (G.isHost) {
    // Physics
    Engine.update(G.engine, 1000/60);

    // Input
    handleInput(W, H);

    // Laser
    updateLaser(W, H);

    // Arrows
    updateArrows(W, H);

    // Particles
    updateParticles();

    // Camera: follow furthest-right alive player
    const rightmost = G.players.reduce((best,p)=> p.alive && p.body.position.x > (best?.body.position.x??-Infinity) ? p : best, null);
    if (rightmost) {
      const target = rightmost.body.position.x - W*0.35;
      G.cameraX += (target - G.cameraX) * 0.08;
    }

    // Generate more world
    if (G.chunkX < G.cameraX + W*3) generateChunk(W, H);

    // Kill platforms far behind
    G.platforms = G.platforms.filter(p=>{
      if(p.position.x < G.cameraX - 400){
        World.remove(G.engine.world, p);
        return false;
      }
      return true;
    });

    // Check deaths
    checkDeaths(W, H);

    // Update HUD dist
    const dist = Math.floor((G.cameraX + W*0.35) / 10);
    G.bestDist = Math.max(G.bestDist, dist);
    document.getElementById('hud-dist').textContent = dist+'m';

    // Sync to peers
    if (G.mode==='host') syncNetState();
  }

  draw(W, H);

  if (!G.gameOver) G.animFrame = requestAnimationFrame(loop);
}

// ── INPUT ───────────────────────────────────────────
window.addEventListener('keydown', e=>{ G.keys[e.code]=true; e.preventDefault(); });
window.addEventListener('keyup',   e=>{ G.keys[e.code]=false; });

// Key maps: [left, right, jump, punch, arrow]
const KEY_MAPS = [
  ['ArrowLeft','ArrowRight','ArrowUp','KeyX','KeyZ'],
  ['KeyA','KeyD','KeyW','KeyQ','KeyE'],
  ['KeyJ','KeyL','KeyI','KeyU','KeyO'],
];

function getKeys(idx) {
  if (G.mode==='join') {
    // Joiner always controls player G.myIdx
    if (idx === G.myIdx) return getLocalKeys(0);
    return {};
  }
  if (G.mode==='host' && idx >= 1) {
    return G.remoteInputs[idx] || {};
  }
  return getLocalKeys(idx);
}

function getLocalKeys(idx) {
  const m = KEY_MAPS[idx] || KEY_MAPS[0];
  return { left:!!G.keys[m[0]], right:!!G.keys[m[1]], up:!!G.keys[m[2]], punch:!!G.keys[m[3]], arrow:!!G.keys[m[4]] };
}

function handleInput(W, H) {
  G.players.forEach((p,i) => {
    if (!p.alive) return;
    const k = getKeys(i);
    const b = p.body;
    const vx = b.velocity.x;
    const vy = b.velocity.y;

    // Accelerating movement — holdTime ramps speed over ~60 frames
    if (k.left || k.right) {
      if (k.left)  { if (p.holdTime > 0) p.holdTime = 0; p.holdTime--; p.facingRight = false; }
      if (k.right) { if (p.holdTime < 0) p.holdTime = 0; p.holdTime++; p.facingRight = true; }
      const held   = Math.abs(p.holdTime);
      const ramp   = Math.min(held / 60, 1);
      const topSpd = MOVE_SPD + ramp * 9;
      const accel  = 1.0 + ramp * 1.8;
      const dir    = k.right ? 1 : -1;
      const newVx  = Math.max(-topSpd, Math.min(topSpd, vx + dir * accel));
      Body.setVelocity(b, { x: newVx, y: vy });
    } else {
      p.holdTime = 0;
      Body.setVelocity(b, { x: vx * 0.78, y: vy });
    }
    if (k.up && !p.jumpHeld) {
      const jumpDist = cH() * (75/400);
      Body.setPosition(b, { x: b.position.x, y: b.position.y - jumpDist });
      Body.setVelocity(b, { x: vx, y: -2 });
      p.grounded = false;
      p.jumpHeld = true;
    }
    if (!k.up) p.jumpHeld = false;
    if (vy > MAX_FALL) Body.setVelocity(b, {x:vx, y:MAX_FALL});

    // Punch
    if (k.punch && p.cd.punch<=0) {
      p.cd.punch=PUNCH_CD;
      G.players.forEach((other,j)=>{
        if(j===i||!other.alive) return;
        const dx=other.body.position.x-b.position.x, dy=other.body.position.y-b.position.y;
        const dist=Math.sqrt(dx*dx+dy*dy);
        if(dist<PUNCH_RANGE){
          const n=dist>0?{x:dx/dist,y:dy/dist}:{x:p.facingRight?1:-1,y:-0.3};
          Body.applyForce(other.body, other.body.position, {x:n.x*PUNCH_FORCE,y:n.y*PUNCH_FORCE-0.015});
          spawnParticles(other.body.position.x, other.body.position.y, P_COLORS[j], 8);
        }
      });
    }
    if(p.cd.punch>0) p.cd.punch--;

    // Shoot arrow
    if (k.arrow && p.cd.arrow<=0) {
      p.cd.arrow=ARROW_CD;
      const dir = p.facingRight?1:-1;
      const arrow = Bodies.rectangle(b.position.x+dir*PLAYER_R*1.5, b.position.y, 16, 4, {
        label:'arrow'+i, isSensor:true, frictionAir:0,
        collisionFilter:{ category:0x0004, mask:0x0001|0x0002 }
      });
      const arrowVx = dir*ARROW_SPD + b.velocity.x*0.4;
      const arrowVy = -2;
      Body.setVelocity(arrow, {x:arrowVx, y:arrowVy});
      World.add(G.engine.world, arrow);
      G.arrows.push({ body:arrow, ownerId:i, age:0, vx:arrowVx, vy:arrowVy });
    }
    if(p.cd.arrow>0) p.cd.arrow--;

    // Update distance
    p.dist = Math.floor((b.position.x) / 10);
  });

  // Send local keys to host if joiner
  if (G.mode==='join' && G.dc?.readyState==='open') {
    G.dc.send(JSON.stringify({ type:'keys', keys:getLocalKeys(0) }));
  }
}

// ── ARROWS ──────────────────────────────────────────
function updateArrows(W, H) {
  G.arrows = G.arrows.filter(a=>{
    a.age++;
    // Manually advance position each frame so sensors don't stall
    Body.setPosition(a.body, {
      x: a.body.position.x + a.vx,
      y: a.body.position.y + a.vy
    });
    a.vy += 0.18; // gentle gravity on arrow

    // Check collision with players
    let hit = false;
    G.players.forEach((p,j)=>{
      if(!p.alive||j===a.ownerId) return;
      const dx=p.body.position.x-a.body.position.x, dy=p.body.position.y-a.body.position.y;
      if(Math.sqrt(dx*dx+dy*dy)<PLAYER_R+8){
        // Knock player in arrow's direction
        const spd = Math.sqrt(a.vx*a.vx+a.vy*a.vy);
        const nx = spd>0 ? a.vx/spd : 1;
        const ny = spd>0 ? a.vy/spd : 0;
        Body.applyForce(p.body, p.body.position, {x: nx*0.06, y: ny*0.04-0.04});
        spawnParticles(a.body.position.x, a.body.position.y, '#ffe066', 8);
        hit=true;
      }
    });
    // Remove if old, off-screen, or hit
    const offScreen = a.body.position.x < G.cameraX-100 || a.body.position.x > G.cameraX+W+200 || a.body.position.y > H+100;
    if(hit||a.age>220||offScreen){
      World.remove(G.engine.world, a.body);
      return false;
    }
    return true;
  });
}

// ── LASER ───────────────────────────────────────────
function updateLaser(W, H) {
  G.laserFrames++;
  if (G.laserFrames < LASER_START_DELAY) return;

  if (!G.laserStarted) {
    G.laserX = G.cameraX - 200;
    G.laserStarted = true;
  }

  G.laserSpeed += LASER_ACCEL;
  G.laserX += G.laserSpeed;

  // Kill players touched by laser
  G.players.forEach(p=>{
    if(!p.alive) return;
    if(p.body.position.x < G.laserX + 10) killPlayer(p, 'laser');
  });

  // Laser bar UI (how close laser is to camera left edge)
  const gap = G.cameraX - G.laserX;
  const pct = Math.max(0, Math.min(100, 100 - (gap/W)*100));
  document.getElementById('laser-bar').style.width = pct+'%';
}

// ── DEATHS ──────────────────────────────────────────
function checkDeaths(W, H) {
  G.players.forEach(p=>{
    if(!p.alive) return;
    const {x,y} = p.body.position;
    // Fell off bottom or behind laser
    if(y > H+120 || x < G.laserX-20) killPlayer(p,'fall');
  });
}

function killPlayer(p, reason) {
  if(!p.alive) return;
  spawnParticles(p.body.position.x, p.body.position.y, P_COLORS[p.idx], 20);
  p.alive = false;
  updateHUD();

  // Check if all dead
  const alive = G.players.filter(p=>p.alive);
  if(alive.length===0){
    G.gameOver=true;
    setTimeout(()=>{
      const dt=document.getElementById('dead-text');
      dt.textContent = 'SURVIVED\n'+G.bestDist+'m';
      dt.style.color = '#ffe066';
      showScreen('screen-dead');
    },1200);
  }
}

// ── PARTICLES ───────────────────────────────────────
function spawnParticles(x, y, color, n) {
  for(let i=0;i<n;i++){
    const angle=Math.random()*Math.PI*2, spd=2+Math.random()*5;
    G.particles.push({ x,y, vx:Math.cos(angle)*spd, vy:Math.sin(angle)*spd, life:30+Math.random()*20, maxLife:50, color, size:2+Math.random()*4 });
  }
}
function updateParticles() {
  G.particles=G.particles.filter(p=>{ p.x+=p.vx;p.y+=p.vy;p.vy+=0.2;p.life--;return p.life>0; });
}

// ── NETWORK SYNC ────────────────────────────────────
function syncNetState() {
  if(!G.peers?.length) return;
  const msg = {
    type:'state',
    players: G.players.map(p=>({
      x:p.body.position.x, y:p.body.position.y,
      vx:p.body.velocity.x, vy:p.body.velocity.y,
      alive:p.alive, facingRight:p.facingRight
    })),
    arrows: G.arrows.map(a=>({ x:a.body.position.x, y:a.body.position.y, vx:a.body.velocity.x, vy:a.body.velocity.y, ownerId:a.ownerId })),
    laserX: G.laserX,
    cameraX: G.cameraX,
    frame: G.frame,
  };
  sendAll(msg);
}

function applyNetState(msg) {
  msg.players.forEach((ps,i)=>{
    const p=G.players[i];
    if(!p) return;
    Body.setPosition(p.body,{x:ps.x,y:ps.y});
    Body.setVelocity(p.body,{x:ps.vx,y:ps.vy});
    p.alive=ps.alive; p.facingRight=ps.facingRight;
  });
  G.laserX=msg.laserX;
  G.cameraX=msg.cameraX;
  // Sync arrows (basic)
}

// ── HUD ─────────────────────────────────────────────
function updateHUD() {
  const el=document.getElementById('hud-players');
  el.innerHTML='';
  G.players.forEach((p,i)=>{
    const pip=document.createElement('div'); pip.className='hud-pip';
    pip.innerHTML=`<div class="hud-dot" style="background:${P_COLORS[i]};box-shadow:0 0 6px ${P_COLORS[i]}"></div>
      <span class="hud-pip-name" style="color:${P_COLORS[i]}">P${i+1}</span>
      <span class="hud-pip-status">${p.alive?'ALIVE':'💀'}</span>`;
    el.appendChild(pip);
  });
}

// ── DRAW ────────────────────────────────────────────
function draw(W, H) {
  const canvas=document.getElementById('game-canvas');
  if(!canvas) return;
  const ctx=canvas.getContext('2d');
  const cx=G.cameraX;

  // Sky gradient
  const sky=ctx.createLinearGradient(0,0,0,H);
  sky.addColorStop(0,'#050810'); sky.addColorStop(1,'#0a1525');
  ctx.fillStyle=sky; ctx.fillRect(0,0,W,H);

  // Stars parallax bg
  ctx.fillStyle='rgba(255,255,255,0.5)';
  for(let s=0;s<60;s++){
    const sx=((s*173+cx*0.05)%W+W)%W;
    const sy=((s*97)%H*0.7);
    ctx.fillRect(sx,sy,1,1);
  }

  // Laser effect
  if (G.laserStarted) {
    const lx = G.laserX - cx;
    // Glow
    const lg=ctx.createLinearGradient(lx-80,0,lx,0);
    lg.addColorStop(0,'rgba(255,20,50,0)');
    lg.addColorStop(0.6,'rgba(255,20,50,0.15)');
    lg.addColorStop(1,'rgba(255,20,50,0.7)');
    ctx.fillStyle=lg; ctx.fillRect(0,0,lx,H);

    // Laser beam
    for(let i=0;i<3;i++){
      ctx.save();
      ctx.shadowColor='#ff2244'; ctx.shadowBlur=30-i*8;
      ctx.fillStyle=i===0?'rgba(255,200,200,0.9)':'rgba(255,30,60,'+(0.4-i*0.1)+')';
      ctx.fillRect(lx-(i*6),0,4+i*4,H);
      ctx.restore();
    }
    // Warning stripes at bottom
    const stripeW=20;
    for(let y=0;y<H;y+=stripeW*2){
      ctx.fillStyle='rgba(255,50,50,0.2)';
      ctx.fillRect(lx-60,y,60,stripeW);
    }
  }

  // Platforms
  G.platforms.forEach(p=>{
    const v=p.vertices;
    const sx=v[0].x-cx, ex=v[1].x-cx;
    const sy=v[0].y, ey=v[3].y;
    const pw=ex-sx, ph=ey-sy;
    if(ex<0||sx>W) return;

    // Platform glow
    const grad=ctx.createLinearGradient(sx,sy,sx,ey);
    grad.addColorStop(0,'#3a5080'); grad.addColorStop(1,'#1e2d4a');
    ctx.fillStyle=grad;
    ctx.beginPath();
    ctx.moveTo(v[0].x-cx,v[0].y);
    v.forEach(vt=>ctx.lineTo(vt.x-cx,vt.y));
    ctx.closePath(); ctx.fill();

    // Top highlight
    ctx.fillStyle='rgba(100,180,255,0.35)';
    ctx.fillRect(sx,sy,pw,3);

    // Grid lines
    ctx.strokeStyle='rgba(80,120,180,0.15)';
    ctx.lineWidth=1;
    for(let gx=Math.floor(sx/20)*20;gx<ex;gx+=20){
      ctx.beginPath(); ctx.moveTo(gx,sy); ctx.lineTo(gx,ey); ctx.stroke();
    }
  });

  // Arrows
  G.arrows.forEach(a=>{
    const ax=a.body.position.x-cx, ay=a.body.position.y;
    const angle=Math.atan2(a.body.velocity.y,a.body.velocity.x);
    ctx.save();
    ctx.translate(ax,ay); ctx.rotate(angle);
    ctx.fillStyle=P_COLORS[a.ownerId]||'#ffe066';
    ctx.shadowColor=ctx.fillStyle; ctx.shadowBlur=8;
    ctx.fillRect(-10,-2,20,4);
    // Arrowhead
    ctx.beginPath(); ctx.moveTo(10,0); ctx.lineTo(4,-4); ctx.lineTo(4,4); ctx.closePath(); ctx.fill();
    ctx.restore();
  });

  // Particles
  G.particles.forEach(p=>{
    const alpha=p.life/p.maxLife;
    ctx.globalAlpha=alpha;
    ctx.fillStyle=p.color;
    ctx.shadowColor=p.color; ctx.shadowBlur=6;
    ctx.fillRect(p.x-cx-p.size/2, p.y-p.size/2, p.size, p.size);
  });
  ctx.globalAlpha=1; ctx.shadowBlur=0;

  // Players
  G.players.forEach(p=>{
    if(!p.alive) return;
    const b=p.body;
    const px=b.position.x-cx, py=b.position.y;

    // Respawn flash
    if(p.respawnFlash>0){ if(Math.floor(p.respawnFlash/5)%2===0){p.respawnFlash--;return;} p.respawnFlash--; }

    // Glow
    const grd=ctx.createRadialGradient(px,py,0,px,py,PLAYER_R*2.8);
    grd.addColorStop(0,P_GLOW[p.idx]); grd.addColorStop(1,'transparent');
    ctx.beginPath(); ctx.arc(px,py,PLAYER_R*2.8,0,Math.PI*2);
    ctx.fillStyle=grd; ctx.fill();

    // Body
    ctx.beginPath(); ctx.arc(px,py,PLAYER_R,0,Math.PI*2);
    ctx.fillStyle=P_DARK[p.idx]; ctx.fill();
    ctx.strokeStyle=P_COLORS[p.idx]; ctx.lineWidth=2.5;
    ctx.shadowColor=P_COLORS[p.idx]; ctx.shadowBlur=12;
    ctx.stroke(); ctx.shadowBlur=0;

    // Face
    const dir=p.facingRight?1:-1;
    const eyeX=px+dir*5;
    ctx.fillStyle='#fff';
    ctx.beginPath(); ctx.arc(eyeX-dir*4,py-5,3.5,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(eyeX+dir*3,py-5,3.5,0,Math.PI*2); ctx.fill();
    ctx.fillStyle='#111';
    ctx.beginPath(); ctx.arc(eyeX-dir*4+dir,py-5,1.8,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(eyeX+dir*3+dir,py-5,1.8,0,Math.PI*2); ctx.fill();

    // Visor
    ctx.fillStyle=P_COLORS[p.idx];
    ctx.globalAlpha=0.18;
    ctx.beginPath(); ctx.ellipse(px,py-4,PLAYER_R*0.7,5,0,0,Math.PI*2); ctx.fill();
    ctx.globalAlpha=1;

    // Label
    ctx.fillStyle=P_COLORS[p.idx];
    ctx.font='bold 10px "Press Start 2P", monospace';
    ctx.textAlign='center';
    ctx.fillText('P'+(p.idx+1),px,py-PLAYER_R-7);
    ctx.textAlign='left';

    // Punch flash
    if(p.cd.punch>PUNCH_CD-8){
      ctx.fillStyle='rgba(255,255,100,0.9)';
      ctx.font='bold 13px "Press Start 2P", monospace';
      ctx.textAlign='center';
      ctx.fillText('POW',px+(p.facingRight?28:-28),py-28);
      ctx.textAlign='left';
    }

    // Arrow cooldown arc
    if(p.cd.arrow>0){
      const pct=1-(p.cd.arrow/ARROW_CD);
      ctx.beginPath();
      ctx.arc(px,py,-Math.PI/2,(-Math.PI/2)+pct*Math.PI*2,false);
      ctx.strokeStyle=P_COLORS[p.idx]; ctx.lineWidth=2; ctx.globalAlpha=0.5; ctx.stroke();
      ctx.globalAlpha=1;
    }
  });
}

// ── CANVAS SIZE ─────────────────────────────────────
function cW() { return window.innerWidth; }
function cH() { return window.innerHeight - 48; }

window.addEventListener('resize',()=>{
  const canvas=document.getElementById('game-canvas');
  if(canvas&&G.engine){ canvas.width=cW(); canvas.height=cH(); }
});

// ── AUTO-JOIN FROM URL ───────────────────────────────
window.addEventListener('load',()=>{
  const params=new URLSearchParams(window.location.search);
  const join=params.get('join');
  if(join){
    showScreen('screen-join');
    setStatus('join','⏳ Connecting to host...');
    setTimeout(()=>doJoin(join),300);
  }
  const ans=params.get('answer');
  if(ans) addHostAnswerInput(decodeURIComponent(ans));
});
