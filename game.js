// Chinese Checkers — game core
// Cube coords (x,y,z) with x+y+z=0. 6 directions.

export const DIRS = [
  { x:  1, y: -1, z:  0 }, // E
  { x:  1, y:  0, z: -1 }, // NE
  { x:  0, y:  1, z: -1 }, // NW
  { x: -1, y:  1, z:  0 }, // W
  { x: -1, y:  0, z:  1 }, // SW
  { x:  0, y: -1, z:  1 }, // SE
];

// Triangle definitions in clockwise order from top, matched to pixel layout
// (px = sqrt(3)*(x + z/2), py = 1.5*z).
// Index 0..5: TOP, TOP-RIGHT, BOTTOM-RIGHT, BOTTOM, BOTTOM-LEFT, TOP-LEFT
const TRIANGLE_DEFS = [
  { axis: 'z', sign: -1 }, // TOP: deep corner (4,4,-8)
  { axis: 'x', sign:  1 }, // TOP-RIGHT: deep corner (8,-4,-4)
  { axis: 'y', sign: -1 }, // BOTTOM-RIGHT: deep corner (4,-8,4)
  { axis: 'z', sign:  1 }, // BOTTOM: deep corner (-4,-4,8)
  { axis: 'x', sign: -1 }, // BOTTOM-LEFT: deep corner (-8,4,4)
  { axis: 'y', sign:  1 }, // TOP-LEFT: deep corner (-4,8,-4)
];

export const TRIANGLE_COLORS = [
  '#c0392b', // crimson
  '#d4923a', // amber
  '#3a8b5c', // emerald
  '#2c7a8b', // teal
  '#4a5ab5', // indigo
  '#8b3a8b', // violet
];

export const TRIANGLE_NAMES = [
  'Top', 'Top-Right', 'Bottom-Right', 'Bottom', 'Bottom-Left', 'Top-Left'
];

// Player count -> triangle indices used (home positions).
export const PLAYER_LAYOUTS = {
  2: [0, 3],
  3: [0, 2, 4],
  4: [1, 2, 4, 5],
  6: [0, 1, 2, 3, 4, 5],
};

export const key = (c) => `${c.x},${c.y},${c.z}`;
export const parseKey = (k) => {
  const [x, y, z] = k.split(',').map(Number);
  return { x, y, z };
};
const eq = (a, b) => a.x === b.x && a.y === b.y && a.z === b.z;
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (d, k) => ({ x: d.x * k, y: d.y * k, z: d.z * k });
export const hexDist = (a, b) =>
  (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z)) / 2;

function inTriangle(c, def) {
  const { axis, sign } = def;
  const main = c[axis] * sign;
  const others = ['x', 'y', 'z'].filter(a => a !== axis);
  if (main < 5 || main > 8) return false;
  for (const a of others) {
    const v = c[a] * (-sign);
    if (v < 0 || v > 4) return false;
  }
  return true;
}

function inCenterHex(c) {
  return Math.max(Math.abs(c.x), Math.abs(c.y), Math.abs(c.z)) <= 4;
}

// Build the 121-cell board.
export function buildBoard() {
  const cells = new Map(); // key -> { coord, triangleIdx (or null) }
  for (let x = -8; x <= 8; x++) {
    for (let y = -8; y <= 8; y++) {
      const z = -x - y;
      if (z < -8 || z > 8) continue;
      const c = { x, y, z };
      let triIdx = null;
      for (let i = 0; i < 6; i++) {
        if (inTriangle(c, TRIANGLE_DEFS[i])) { triIdx = i; break; }
      }
      const onBoard = triIdx !== null || inCenterHex(c);
      if (onBoard) cells.set(key(c), { coord: c, triangleIdx: triIdx });
    }
  }
  return cells;
}

export function trianglesCells(board) {
  const out = [[], [], [], [], [], []];
  for (const { coord, triangleIdx } of board.values()) {
    if (triangleIdx !== null) out[triangleIdx].push(coord);
  }
  return out;
}

// Create initial game state.
export function newGame({ playerCount, aiPlayers }) {
  const board = buildBoard();
  const triCells = trianglesCells(board);
  const homes = PLAYER_LAYOUTS[playerCount];
  // Each player's target = triangle opposite (idx + 3) % 6.
  const occupancy = new Map(); // cellKey -> playerIdx
  const players = homes.map((homeIdx, i) => {
    for (const c of triCells[homeIdx]) occupancy.set(key(c), i);
    return {
      id: i,
      homeTriangle: homeIdx,
      targetTriangle: (homeIdx + 3) % 6,
      color: TRIANGLE_COLORS[homeIdx],
      name: `${TRIANGLE_NAMES[homeIdx]} player`,
      isAI: aiPlayers.includes(i),
    };
  });
  return {
    board,
    players,
    occupancy,
    turn: 0,
    selected: null,            // cellKey of currently selected piece
    chainStart: null,          // cellKey where this turn's piece started
    chainPath: [],             // ordered list of cells visited this chain
    inChain: false,            // whether player has already jumped this turn
    winner: null,
  };
}

// Legal step destinations from cell (single adjacent move).
function stepDestinations(state, fromKey) {
  const out = [];
  const from = parseKey(fromKey);
  for (const d of DIRS) {
    const n = add(from, d);
    const k = key(n);
    if (!state.board.has(k)) continue;
    if (state.occupancy.has(k)) continue;
    out.push(k);
  }
  return out;
}

// Single-jump destinations from cell using symmetric N-gap rule.
function jumpDestinations(state, fromKey) {
  const out = [];
  const from = parseKey(fromKey);
  for (const d of DIRS) {
    let N = 0;
    let foundOccupiedAt = -1;
    for (let k = 1; k <= 16; k++) {
      const cell = add(from, scale(d, k));
      const ck = key(cell);
      if (!state.board.has(ck)) break;
      if (!state.occupancy.has(ck)) { N++; continue; }
      foundOccupiedAt = k;
      break;
    }
    if (foundOccupiedAt < 0) continue;
    // Need empties from foundOccupiedAt+1 .. foundOccupiedAt+N, then land at foundOccupiedAt+N+1
    let valid = true;
    for (let j = 1; j <= N; j++) {
      const cell = add(from, scale(d, foundOccupiedAt + j));
      const ck = key(cell);
      if (!state.board.has(ck) || state.occupancy.has(ck)) { valid = false; break; }
    }
    if (!valid) continue;
    const landing = add(from, scale(d, foundOccupiedAt + N + 1));
    const lk = key(landing);
    if (!state.board.has(lk) || state.occupancy.has(lk)) continue;
    out.push(lk);
  }
  return out;
}

// All reachable end positions for a piece in one full turn.
// Returns Map<endKey, { type: 'step'|'jump', path: [keys] }>
export function allTurnMoves(state, fromKey) {
  const out = new Map();
  // Steps (only if no chain in progress yet)
  for (const dest of stepDestinations(state, fromKey)) {
    out.set(dest, { type: 'step', path: [fromKey, dest] });
  }
  // Jump chains via DFS.
  const visited = new Set([fromKey]);
  const dfs = (cur, path) => {
    for (const dest of jumpDestinations(withTempMove(state, fromKey, cur), cur)) {
      if (visited.has(dest)) continue;
      visited.add(dest);
      const newPath = [...path, dest];
      if (!out.has(dest)) out.set(dest, { type: 'jump', path: newPath });
      dfs(dest, newPath);
      visited.delete(dest);
    }
  };
  dfs(fromKey, [fromKey]);
  return out;
}

// Return a state-like object with the piece moved (for jump chain DFS).
function withTempMove(state, fromKey, toKey) {
  if (fromKey === toKey) return state;
  const occ = new Map(state.occupancy);
  const p = occ.get(fromKey);
  occ.delete(fromKey);
  occ.set(toKey, p);
  return { ...state, occupancy: occ };
}

// Mid-chain: allow any valid jump from current position (including revisits)
// until the player ends their turn.
export function chainContinuations(state) {
  if (!state.inChain || !state.selected) return [];
  return jumpDestinations(state, state.selected);
}

// Try to apply a click on cell. Returns one of:
//   { ok: true, action: 'select' | 'step' | 'jump' | 'end' | 'deselect' }
//   { ok: false }
export function clickCell(state, cellKey) {
  const cur = state.players[state.turn];
  const occupant = state.occupancy.get(cellKey);
  // Click own piece
  if (occupant === cur.id) {
    if (state.inChain) return { ok: false }; // locked to chained piece
    if (state.selected === cellKey) {
      // Toggle off — cancel selection while still at starting position.
      state.selected = null;
      state.chainStart = null;
      state.chainPath = [];
      return { ok: true, action: 'deselect' };
    }
    state.selected = cellKey;
    state.chainStart = cellKey;
    state.chainPath = [cellKey];
    return { ok: true, action: 'select' };
  }
  // Click opponent piece — ignore
  if (occupant !== undefined) return { ok: false };
  // Empty cell
  if (!state.selected) return { ok: false };
  // If mid-chain, must be a valid further jump.
  if (state.inChain) {
    const conts = chainContinuations(state);
    if (!conts.includes(cellKey)) return { ok: false };
    applyMove(state, state.selected, cellKey);
    state.selected = cellKey;
    state.chainPath.push(cellKey);
    return { ok: true, action: 'jump' };
  }
  // Not in chain yet — allow step or jump.
  const steps = stepDestinations(state, state.selected);
  if (steps.includes(cellKey)) {
    applyMove(state, state.selected, cellKey);
    endTurn(state);
    return { ok: true, action: 'step' };
  }
  const jumps = jumpDestinations(state, state.selected);
  if (jumps.includes(cellKey)) {
    applyMove(state, state.selected, cellKey);
    state.selected = cellKey;
    state.chainPath.push(cellKey);
    state.inChain = true;
    return { ok: true, action: 'jump' };
  }
  return { ok: false };
}

function applyMove(state, fromKey, toKey) {
  const p = state.occupancy.get(fromKey);
  state.occupancy.delete(fromKey);
  state.occupancy.set(toKey, p);
}

// Undo one jump in the current chain. Repeated calls walk back step by step.
// When chain is fully unwound, deselects the piece.
export function undoJump(state) {
  if (!state.inChain || state.chainPath.length < 2) return false;
  const cur = state.chainPath.pop();
  const prev = state.chainPath[state.chainPath.length - 1];
  applyMove(state, cur, prev);
  state.selected = prev;
  if (state.chainPath.length <= 1) {
    state.inChain = false;
    state.selected = null;
    state.chainStart = null;
    state.chainPath = [];
  }
  return true;
}

export function endTurn(state) {
  // Check win for the player who just acted.
  const cur = state.players[state.turn];
  if (playerHasWon(state, cur.id)) {
    state.winner = cur.id;
  }
  state.selected = null;
  state.chainStart = null;
  state.chainVisited = new Set();
  state.inChain = false;
  state.turn = (state.turn + 1) % state.players.length;
}

export function playerHasWon(state, playerId) {
  const target = state.players[playerId].targetTriangle;
  let count = 0;
  for (const [k, pid] of state.occupancy) {
    if (pid !== playerId) continue;
    const cell = state.board.get(k);
    if (cell.triangleIdx === target) count++;
  }
  return count === 10;
}

// Snapshot: minimal serializable state (board + dirs are reconstructed).
export function snapshot(state) {
  return {
    occupancy: Object.fromEntries(state.occupancy),
    players: state.players.map(p => ({ ...p })),
    turn: state.turn,
    selected: state.selected,
    chainStart: state.chainStart,
    chainPath: [...state.chainPath],
    inChain: state.inChain,
    winner: state.winner,
  };
}

export function restoreState(snap) {
  return {
    board: buildBoard(),
    occupancy: new Map(Object.entries(snap.occupancy).map(([k, v]) => [k, Number(v)])),
    players: snap.players,
    turn: snap.turn,
    selected: snap.selected,
    chainStart: snap.chainStart,
    chainPath: [...snap.chainPath],
    inChain: snap.inChain,
    winner: snap.winner,
  };
}

// Cube -> pixel (pointy-top hex layout).
export function cubeToPixel(coord, size) {
  const px = size * Math.sqrt(3) * (coord.x + coord.z / 2);
  const py = size * 1.5 * coord.z;
  return { px, py };
}

// Deep corner (anchor) cell of a triangle — used as AI target point.
export function triangleAnchor(triIdx) {
  const def = TRIANGLE_DEFS[triIdx];
  const c = { x: 0, y: 0, z: 0 };
  c[def.axis] = 8 * def.sign;
  const others = ['x', 'y', 'z'].filter(a => a !== def.axis);
  c[others[0]] = -4 * def.sign;
  c[others[1]] = -4 * def.sign;
  return c;
}
