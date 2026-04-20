// Rendering, input, and online glue.
import {
  newGame, clickCell, endTurn, undoJump, snapshot, restoreState,
  cubeToPixel, parseKey,
  TRIANGLE_COLORS, TRIANGLE_NAMES, PLAYER_LAYOUTS,
} from './game.js';
import { chooseAIMove } from './ai.js';
import { Online } from './online.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CELL = 26;
const PIECE_R = 11;
const HOLE_R = 5;
const VIEW = 560;

let state = null;
let mode = 'local';        // 'local' | 'host' | 'guest'
let mySlot = null;         // player INDEX for the local human (online only)
let peerConnected = true;
let online = null;
let pendingApproval = null; // { requestId, name } when host has someone awaiting approval
let myRoomSetup = null;     // host/guest's saved setup (for AI determination etc.)

let svg, statusEl, endTurnBtn, undoBtn, playersPanel;

export function initUI() {
  // Header
  document.getElementById('newGameBtn').addEventListener('click', leaveGame);

  // Main mode picker
  document.getElementById('mode').addEventListener('change', refreshSetup);

  // Local mode
  document.getElementById('playerCount').addEventListener('change', syncLocalAIBoxes);
  document.getElementById('startBtn').addEventListener('click', startLocal);

  // Online entry
  document.getElementById('usernameInput').addEventListener('input', onUsernameChange);
  document.getElementById('enterLobbyBtn').addEventListener('click', enterLobby);

  // Lobby
  document.getElementById('lobbyBack').addEventListener('click', backToSetup);
  document.getElementById('refreshLobbyBtn').addEventListener('click', () => {
    if (online) online.subscribeLobby();
  });
  document.getElementById('createPlayerCount').addEventListener('change', syncCreateSlots);
  document.getElementById('createHostSlot').addEventListener('change', syncCreateSlots);
  document.getElementById('createBtn').addEventListener('click', createRoom);
  document.getElementById('joinByCodeBtn').addEventListener('click', joinByCode);

  // Host waiting screen (after creating)
  document.getElementById('cancelRoomBtn').addEventListener('click', cancelOwnRoom);
  document.getElementById('approveBtn').addEventListener('click', approvePending);
  document.getElementById('denyBtn').addEventListener('click', denyPending);

  // Guest pending screen
  document.getElementById('cancelJoinBtn').addEventListener('click', cancelOwnJoin);

  // Game controls
  svg = document.getElementById('board');
  statusEl = document.getElementById('status');
  endTurnBtn = document.getElementById('endTurnBtn');
  undoBtn = document.getElementById('undoBtn');
  playersPanel = document.getElementById('players');
  endTurnBtn.addEventListener('click', tryEndTurn);
  undoBtn.addEventListener('click', tryUndo);
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'r' || e.key === 'R') { tryUndo(); e.preventDefault(); }
    else if (e.code === 'Space') { tryEndTurn(); e.preventDefault(); }
  });

  // Pre-fill username
  const savedName = Online.loadName();
  if (savedName) document.getElementById('usernameInput').value = savedName;
  onUsernameChange();

  refreshSetup();
  showSetup();
  refreshResumeBox();
}

function refreshResumeBox() {
  const sessions = Online.loadSessions();
  const box = document.getElementById('resumeBox');
  if (!box) return;
  if (!sessions.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '';
  for (const s of sessions) {
    const row = document.createElement('div');
    row.className = 'resume-row';
    row.innerHTML = `
      <span>Resume ${s.role} session in room <strong>${s.code}</strong></span>
      <button class="primary">Resume</button>
      <button class="dismiss">Forget</button>`;
    row.querySelector('.primary').addEventListener('click', async () => {
      await ensureOnline();
      online.reconnectRoom(s.code, s.token, s.username);
    });
    row.querySelector('.dismiss').addEventListener('click', () => {
      localStorage.removeItem('cc-online-session-' + s.role);
      refreshResumeBox();
    });
    box.appendChild(row);
  }
}

// ---------- Screen helpers ----------

function showScreen(id) {
  for (const s of ['setup', 'lobby', 'hostWait', 'guestWait', 'game']) {
    document.getElementById(s).classList.toggle('hidden', s !== id);
  }
}

function showSetup() { showScreen('setup'); refreshSetup(); }

function backToSetup() {
  if (online) online.unsubscribeLobby();
  showSetup();
}

function leaveGame() {
  // Leaving an active room — clear session.
  if (online && online.code && !state) online.cancelRoom?.();
  if (online) online.clearSession();
  state = null;
  mode = 'local';
  mySlot = null;
  myRoomSetup = null;
  pendingApproval = null;
  showSetup();
  refreshResumeBox();
}

// ---------- Setup ----------

function refreshSetup() {
  const m = document.getElementById('mode').value;
  document.getElementById('localOpts').classList.toggle('hidden', m !== 'local');
  document.getElementById('onlineOpts').classList.toggle('hidden', m !== 'online');
  document.getElementById('startBtn').classList.toggle('hidden', m !== 'local');
  document.getElementById('enterLobbyBtn').classList.toggle('hidden', m !== 'online');
  syncLocalAIBoxes();
}

function syncLocalAIBoxes() {
  const count = parseInt(document.getElementById('playerCount').value, 10);
  document.querySelectorAll('#aiList label').forEach(label => {
    const cb = label.querySelector('input[type=checkbox]');
    const idx = parseInt(cb.dataset.idx, 10);
    if (idx >= count) {
      cb.disabled = true; cb.checked = false;
      label.classList.add('disabled');
    } else {
      cb.disabled = false;
      label.classList.remove('disabled');
    }
  });
}

function onUsernameChange() {
  const v = document.getElementById('usernameInput').value.trim();
  document.getElementById('enterLobbyBtn').disabled = v.length === 0;
}

function startLocal() {
  const playerCount = parseInt(document.getElementById('playerCount').value, 10);
  const aiPlayers = [];
  document.querySelectorAll('#aiList input[type=checkbox]:checked').forEach(cb => {
    const i = parseInt(cb.dataset.idx, 10);
    if (i < playerCount) aiPlayers.push(i);
  });
  mode = 'local'; mySlot = null;
  state = newGame({ playerCount, aiPlayers });
  enterGame();
}

// ---------- Online: lobby ----------

async function ensureOnline() {
  if (online && online.ws && online.ws.readyState === 1) return;
  online = new Online();
  bindOnlineHandlers();
  await online.connect();
}

async function enterLobby() {
  const name = document.getElementById('usernameInput').value.trim();
  if (!name) return;
  await ensureOnline();
  online.setUsername(name);
  online.subscribeLobby();
  syncCreateSlots();
  showScreen('lobby');
}

function syncCreateSlots() {
  const count = parseInt(document.getElementById('createPlayerCount').value, 10);
  const slots = PLAYER_LAYOUTS[count];
  for (const id of ['createHostSlot', 'createGuestSlot']) {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = '';
    for (const idx of slots) {
      const opt = document.createElement('option');
      opt.value = idx;
      opt.textContent = TRIANGLE_NAMES[idx];
      sel.appendChild(opt);
    }
    if (slots.includes(parseInt(prev, 10))) sel.value = prev;
  }
  // Default guest = opposite of host if possible.
  const hsSel = document.getElementById('createHostSlot');
  const gsSel = document.getElementById('createGuestSlot');
  if (hsSel.value === gsSel.value) {
    const opp = (parseInt(hsSel.value, 10) + 3) % 6;
    if (slots.includes(opp)) gsSel.value = opp;
    else gsSel.value = slots.find(i => String(i) !== hsSel.value);
  }
}

function renderLobby(rooms) {
  const list = document.getElementById('lobbyList');
  list.innerHTML = '';
  if (!rooms || !rooms.length) {
    list.innerHTML = '<div class="empty">No public rooms. Create one or join with a code.</div>';
    return;
  }
  for (const r of rooms) {
    const row = document.createElement('div');
    row.className = 'lobby-row';
    const host = TRIANGLE_NAMES[r.setup.hostSlot];
    const guest = TRIANGLE_NAMES[r.setup.guestSlot];
    row.innerHTML = `
      <div class="lobby-info">
        <div class="lobby-name">${escapeHtml(r.hostName)}'s room</div>
        <div class="lobby-meta">${r.setup.playerCount}P · ${host} vs ${guest}</div>
      </div>
      <button class="primary lobby-join">Request Join</button>`;
    row.querySelector('button').addEventListener('click', () => {
      online.requestJoin(r.code);
    });
    list.appendChild(row);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- Online: host ----------

function createRoom() {
  const playerCount = parseInt(document.getElementById('createPlayerCount').value, 10);
  const hostSlot = parseInt(document.getElementById('createHostSlot').value, 10);
  const guestSlot = parseInt(document.getElementById('createGuestSlot').value, 10);
  const isPrivate = document.getElementById('createPrivate').checked;
  if (hostSlot === guestSlot) { alert('Pick different colors for you and your friend.'); return; }
  const layout = PLAYER_LAYOUTS[playerCount];
  const setup = {
    playerCount,
    hostSlot: layout.indexOf(hostSlot),
    guestSlot: layout.indexOf(guestSlot),
    triangleAssignments: layout,
  };
  online.createRoom(setup, isPrivate);
}

function cancelOwnRoom() {
  if (online) online.cancelRoom();
  myRoomSetup = null;
  pendingApproval = null;
  document.getElementById('approvalBox').classList.add('hidden');
}

function approvePending() {
  if (!pendingApproval) return;
  online.approveJoin(pendingApproval.requestId);
  document.getElementById('approvalBox').classList.add('hidden');
  pendingApproval = null;
}

function denyPending() {
  if (!pendingApproval) return;
  online.denyJoin(pendingApproval.requestId);
  document.getElementById('approvalBox').classList.add('hidden');
  pendingApproval = null;
}

function joinByCode() {
  const code = document.getElementById('joinByCode').value.trim().toUpperCase();
  if (!code) return;
  online.requestJoin(code);
}

function cancelOwnJoin() {
  if (online && online.code) online.cancelJoinRequest(online.code);
  // Treat as going back to lobby.
  showScreen('lobby');
  if (online) online.subscribeLobby();
}

// ---------- Online event bindings ----------

function bindOnlineHandlers() {
  online.on('error', (msg) => alert('Server: ' + msg.message));
  online.on('disconnected', () => {
    peerConnected = false;
    if (state) render();
  });
  online.on('peer_status', (msg) => {
    peerConnected = msg.connected;
    if (state) render();
  });
  online.on('lobby', (msg) => renderLobby(msg.rooms));

  // Host flows
  online.on('room_created', (msg) => {
    myRoomSetup = msg.setup;
    document.getElementById('hostCodeText').textContent = msg.code;
    document.getElementById('hostPrivateBadge').classList.toggle('hidden', !msg.private);
    document.getElementById('hostPublicBadge').classList.toggle('hidden', msg.private);
    document.getElementById('approvalBox').classList.add('hidden');
    document.getElementById('hostStatus').textContent =
      msg.private ? 'Share this code privately with your friend.' : 'Listed in lobby — waiting for someone to join.';
    showScreen('hostWait');
  });
  online.on('join_requested', (msg) => {
    pendingApproval = { requestId: msg.requestId, name: msg.name };
    document.getElementById('approvalName').textContent = msg.name;
    document.getElementById('approvalBox').classList.remove('hidden');
  });
  online.on('join_request_cancelled', () => {
    pendingApproval = null;
    document.getElementById('approvalBox').classList.add('hidden');
  });
  online.on('guest_joined', (msg) => {
    // Host side — guest accepted, start the game.
    if (!myRoomSetup) return;
    const layout = PLAYER_LAYOUTS[myRoomSetup.playerCount];
    const humanIdx = new Set([myRoomSetup.hostSlot, myRoomSetup.guestSlot]);
    const aiPlayers = [];
    for (let i = 0; i < myRoomSetup.playerCount; i++) {
      if (!humanIdx.has(i)) aiPlayers.push(i);
    }
    state = newGame({ playerCount: myRoomSetup.playerCount, aiPlayers });
    state.players[myRoomSetup.hostSlot].name = online.username + ' (' + state.players[myRoomSetup.hostSlot].name + ')';
    state.players[myRoomSetup.guestSlot].name = msg.name + ' (' + state.players[myRoomSetup.guestSlot].name + ')';
    mode = 'host';
    mySlot = myRoomSetup.hostSlot;
    online.startGame(snapshot(state));
    enterGame();
  });
  online.on('guest_left', () => {
    // Pre-game guest dropped out.
    document.getElementById('hostStatus').textContent = 'Waiting for someone to join.';
  });
  online.on('room_cancelled', () => {
    backToSetup();
  });

  // Guest flows
  online.on('join_pending', (msg) => {
    document.getElementById('joinPendingHost').textContent = msg.hostName;
    showScreen('guestWait');
  });
  online.on('join_denied', (msg) => {
    alert('Join denied' + (msg.reason ? ': ' + msg.reason : '.'));
    showScreen('lobby');
    if (online) online.subscribeLobby();
  });
  online.on('join_approved', (msg) => {
    myRoomSetup = msg.setup;
    // Wait for game_start to arrive (host's startGame triggers it).
    document.getElementById('joinPendingHost').textContent = msg.hostName;
    document.getElementById('joinPendingMsg').textContent = 'Approved — starting…';
  });
  online.on('game_start', (msg) => {
    // Defensive: host already entered via guest_joined; ignore if we're the host.
    if (mode === 'host') return;
    myRoomSetup = msg.setup;
    mode = 'guest';
    mySlot = msg.setup.guestSlot;
    state = restoreState(msg.snapshot);
    if (msg.hostName) state.players[msg.setup.hostSlot].name = msg.hostName + ' (' + state.players[msg.setup.hostSlot].name + ')';
    if (msg.guestName) state.players[msg.setup.guestSlot].name = msg.guestName + ' (' + state.players[msg.setup.guestSlot].name + ')';
    enterGame();
  });

  // Action relay
  online.on('action', (msg) => {
    if (!state) return;
    applyRemoteAction(msg.action);
    render();
    maybeAITurn();
  });

  // Reconnect (resume after refresh)
  online.on('reconnected', (msg) => {
    mode = msg.role;
    myRoomSetup = msg.setup;
    if (msg.started && msg.snapshot && msg.setup) {
      mySlot = mode === 'host' ? msg.setup.hostSlot : msg.setup.guestSlot;
      state = restoreState(msg.snapshot);
      enterGame();
    } else if (msg.role === 'host') {
      // Pre-start host returning.
      document.getElementById('hostCodeText').textContent = msg.code;
      showScreen('hostWait');
    } else {
      // Guest pre-start? Shouldn't happen in this flow — fall back to lobby.
      showScreen('lobby');
      if (online) online.subscribeLobby();
    }
  });
}


// ---------- Game screen ----------

function enterGame() {
  showScreen('game');
  buildBoardDOM();
  render();
  maybeAITurn();
}

function buildBoardDOM() {
  svg.innerHTML = '';
  svg.setAttribute('viewBox', `${-VIEW} ${-VIEW} ${VIEW * 2} ${VIEW * 2}`);
  for (let i = 0; i < 6; i++) {
    const cells = [];
    for (const { coord, triangleIdx } of state.board.values()) {
      if (triangleIdx === i) cells.push(coord);
    }
    if (!cells.length) continue;
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'tri-bg');
    for (const c of cells) {
      const { px, py } = cubeToPixel(c, CELL);
      const r = document.createElementNS(SVG_NS, 'circle');
      r.setAttribute('cx', px); r.setAttribute('cy', py);
      r.setAttribute('r', CELL * 0.85);
      r.setAttribute('fill', TRIANGLE_COLORS[i]);
      r.setAttribute('opacity', '0.07');
      g.appendChild(r);
    }
    svg.appendChild(g);
  }
  for (const [k, { coord }] of state.board) {
    const { px, py } = cubeToPixel(coord, CELL);
    const hole = document.createElementNS(SVG_NS, 'circle');
    hole.setAttribute('cx', px); hole.setAttribute('cy', py);
    hole.setAttribute('r', HOLE_R);
    hole.setAttribute('class', 'hole');
    hole.dataset.cellKey = k;
    hole.addEventListener('click', () => onCellClick(k));
    svg.appendChild(hole);
  }
  const piecesLayer = document.createElementNS(SVG_NS, 'g');
  piecesLayer.setAttribute('id', 'piecesLayer');
  svg.appendChild(piecesLayer);
}

function render() {
  const layer = document.getElementById('piecesLayer');
  layer.innerHTML = '';
  for (const [k, pid] of state.occupancy) {
    const coord = parseKey(k);
    const { px, py } = cubeToPixel(coord, CELL);
    const player = state.players[pid];
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'piece');
    g.dataset.cellKey = k;
    if (state.selected === k) g.classList.add('selected');
    g.setAttribute('transform', `translate(${px}, ${py})`);
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('r', PIECE_R);
    c.setAttribute('fill', player.color);
    c.setAttribute('class', 'piece-body');
    const hl = document.createElementNS(SVG_NS, 'circle');
    hl.setAttribute('r', PIECE_R * 0.4);
    hl.setAttribute('cx', -PIECE_R * 0.3);
    hl.setAttribute('cy', -PIECE_R * 0.3);
    hl.setAttribute('class', 'piece-shine');
    g.appendChild(c); g.appendChild(hl);
    g.addEventListener('click', (e) => { e.stopPropagation(); onCellClick(k); });
    layer.appendChild(g);
  }

  // "Playing as" header (online: you; local: nothing — turn already covers it).
  const youBox = document.getElementById('youBox');
  if (mode !== 'local' && mySlot !== null && state.players[mySlot]) {
    const me = state.players[mySlot];
    youBox.classList.remove('hidden');
    youBox.innerHTML = `<span class="you-label">You play</span>
      <span class="badge big" style="background:${me.color}"></span>
      <span class="you-name">${escapeHtml(me.name)}</span>`;
  } else {
    youBox.classList.add('hidden');
  }

  if (state.winner !== null) {
    const w = state.players[state.winner];
    statusEl.innerHTML = `<span class="badge" style="background:${w.color}"></span>${w.name} wins!`;
    endTurnBtn.disabled = true; undoBtn.disabled = true;
  } else {
    const cur = state.players[state.turn];
    let role;
    if (mode === 'local') role = cur.isAI ? 'AI' : 'You';
    else if (cur.isAI) role = 'AI';
    else if (cur.id === mySlot) role = 'You';
    else role = 'Friend';
    let pause = '';
    if (mode !== 'local' && !peerConnected) pause = ' <em>(paused — peer offline)</em>';
    statusEl.innerHTML =
      `<span class="badge" style="background:${cur.color}"></span>${cur.name} — ${role}` +
      (state.inChain ? ' <em>(chain)</em>' : '') + pause;
    const myTurn = mode === 'local' ? !cur.isAI : (cur.id === mySlot);
    endTurnBtn.disabled = !state.inChain || !myTurn;
    undoBtn.disabled = !state.inChain || !myTurn;
  }

  playersPanel.innerHTML = '';
  for (const p of state.players) {
    let inTarget = 0;
    for (const [k, pid] of state.occupancy) {
      if (pid !== p.id) continue;
      if (state.board.get(k).triangleIdx === p.targetTriangle) inTarget++;
    }
    const row = document.createElement('div');
    let cls = 'player-row';
    if (p.id === state.turn) cls += ' active';
    if (mode !== 'local' && p.id === mySlot) cls += ' you';
    row.className = cls;
    let tag = '';
    if (p.isAI) tag = ' <span class="role-tag">AI</span>';
    else if (mode !== 'local' && p.id === mySlot) tag = ' <span class="role-tag you-tag">YOU</span>';
    row.innerHTML = `
      <span class="badge" style="background:${p.color}"></span>
      <span class="player-name">${escapeHtml(p.name)}${tag}</span>
      <span class="counter">${inTarget}/10</span>`;
    playersPanel.appendChild(row);
  }

  const codeBox = document.getElementById('roomCodeBox');
  if (mode !== 'local' && online && online.code) {
    codeBox.classList.remove('hidden');
    codeBox.textContent = `Room: ${online.code}`;
  } else codeBox.classList.add('hidden');
}

// ---------- Action wrappers ----------

function isMyTurn() {
  if (!state) return false;
  const cur = state.players[state.turn];
  if (mode === 'local') return !cur.isAI;
  return cur.id === mySlot;
}

function broadcastAction(action) {
  if (mode === 'local' || !online) return;
  online.sendAction(action, snapshot(state));
}

function doClick(k) {
  if (mode !== 'local' && !peerConnected) return { ok: false };
  const r = clickCell(state, k);
  if (r.ok) broadcastAction({ type: 'click', key: k });
  return r;
}

function doUndo() {
  if (mode !== 'local' && !peerConnected) return false;
  const r = undoJump(state);
  if (r) broadcastAction({ type: 'undo' });
  return r;
}

function doEndTurn() {
  if (mode !== 'local' && !peerConnected) return;
  endTurn(state);
  broadcastAction({ type: 'end_turn' });
}

function applyRemoteAction(action) {
  if (action.type === 'click') clickCell(state, action.key);
  else if (action.type === 'undo') undoJump(state);
  else if (action.type === 'end_turn') endTurn(state);
}

// ---------- Input ----------

function onCellClick(k) {
  if (!state || state.winner !== null) return;
  if (!isMyTurn()) return;
  const r = doClick(k);
  if (!r.ok) return;
  render();
  if (r.action === 'step') maybeAITurn();
}

function tryEndTurn() {
  if (!state || !state.inChain) return;
  if (!isMyTurn()) return;
  doEndTurn();
  render();
  maybeAITurn();
}

function tryUndo() {
  if (!state || !state.inChain) return;
  if (!isMyTurn()) return;
  if (doUndo()) render();
}

// ---------- AI ----------

function maybeAITurn() {
  if (!state || state.winner !== null) return;
  if (mode === 'guest') return;
  const cur = state.players[state.turn];
  if (!cur.isAI) return;
  if (mode !== 'local' && !peerConnected) return;
  setTimeout(runAITurn, 450);
}

function runAITurn() {
  if (!state || state.winner !== null) return;
  if (mode === 'guest') return;
  const cur = state.players[state.turn];
  if (!cur.isAI) return;
  if (mode !== 'local' && !peerConnected) return;
  const choice = chooseAIMove(state);
  if (!choice) {
    doEndTurn(); render(); maybeAITurn(); return;
  }
  const path = choice.info.path;
  let i = 0;
  const stepDelay = path.length > 2 ? 280 : 0;
  const step = () => {
    if (i === 0) {
      doClick(path[0]); render(); i = 1;
      setTimeout(step, stepDelay); return;
    }
    if (i < path.length) {
      doClick(path[i]); render(); i++;
      if (i < path.length) setTimeout(step, stepDelay);
      else {
        if (state.inChain) doEndTurn();
        render();
        setTimeout(maybeAITurn, 250);
      }
    }
  };
  step();
}
