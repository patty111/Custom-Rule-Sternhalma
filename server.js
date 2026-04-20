// Chinese Checkers — relay server.
// Serves static client files + WebSocket relay.
// Supports public lobby + private room codes + host approval.
// Rooms TTL: 48h since last activity.

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8080;
const ROOM_TTL_MS = 48 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = __dirname;

const rooms = new Map();          // code -> Room
const clients = new Map();        // ws -> { username, currentRoom, role }
const lobbyViewers = new Set();   // ws of clients on lobby screen

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

const makeToken = () => randomBytes(16).toString('hex');

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptWs) {
  for (const peer of [room.host, room.guest]) {
    if (peer && peer.ws !== exceptWs) send(peer.ws, msg);
  }
}

function lobbySnapshot() {
  const out = [];
  for (const [code, room] of rooms) {
    if (room.private || room.started) continue;
    const guestActive = room.guest && room.guest.ws && room.guest.ws.readyState === 1;
    if (guestActive) continue;
    out.push({
      code,
      hostName: room.hostName || 'Anonymous',
      setup: room.setup,
    });
  }
  return out;
}

function pushLobby() {
  const data = { type: 'lobby', rooms: lobbySnapshot() };
  for (const ws of lobbyViewers) send(ws, data);
}

// Serve static files.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(STATIC_DIR, urlPath);
  if (!filePath.startsWith(STATIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

function getRoom(ws) {
  const c = clients.get(ws);
  if (!c) return null;
  return rooms.get(c.currentRoom) || null;
}

function deleteRoomIfHost(ws) {
  const c = clients.get(ws);
  if (!c) return;
  const room = rooms.get(c.currentRoom);
  if (!room) return;
  if (room.host && room.host.ws === ws && !room.started) {
    // Pre-game host left → kill room.
    if (room.pendingJoinReq) {
      send(room.pendingJoinReq.ws, { type: 'join_denied', reason: 'Host left' });
    }
    rooms.delete(room.code);
    if (!room.private) pushLobby();
  }
}

wss.on('connection', (ws) => {
  clients.set(ws, { username: null, currentRoom: null, role: null });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    const me = clients.get(ws);

    switch (msg.type) {
      case 'set_username': {
        const name = String(msg.name || '').trim().slice(0, 20);
        if (!name) return send(ws, { type: 'error', message: 'Username required' });
        me.username = name;
        send(ws, { type: 'username_set', name });
        return;
      }

      case 'subscribe_lobby': {
        lobbyViewers.add(ws);
        send(ws, { type: 'lobby', rooms: lobbySnapshot() });
        return;
      }

      case 'unsubscribe_lobby': {
        lobbyViewers.delete(ws);
        return;
      }

      case 'create_room': {
        if (!me.username) return send(ws, { type: 'error', message: 'Set username first' });
        const setup = msg.setup;
        if (!setup || ![2, 3, 4, 6].includes(setup.playerCount)) {
          return send(ws, { type: 'error', message: 'Invalid setup' });
        }
        const code = makeCode();
        const room = {
          code,
          private: !!msg.private,
          hostName: me.username,
          setup,
          host: { ws, token: makeToken() },
          guest: null,
          pendingJoinReq: null,
          snapshot: null,
          started: false,
          createdAt: Date.now(),
          lastActive: Date.now(),
        };
        rooms.set(code, room);
        me.currentRoom = code;
        me.role = 'host';
        lobbyViewers.delete(ws);
        send(ws, {
          type: 'room_created',
          code, token: room.host.token,
          private: room.private, setup, hostName: me.username,
        });
        if (!room.private) pushLobby();
        return;
      }

      case 'cancel_room': {
        if (me.role !== 'host') return;
        const room = rooms.get(me.currentRoom);
        if (!room || room.started) return;
        if (room.pendingJoinReq) {
          send(room.pendingJoinReq.ws, { type: 'join_denied', reason: 'Host cancelled the room' });
        }
        rooms.delete(room.code);
        me.currentRoom = null; me.role = null;
        send(ws, { type: 'room_cancelled' });
        if (!room.private) pushLobby();
        return;
      }

      case 'request_join': {
        if (!me.username) return send(ws, { type: 'error', message: 'Set username first' });
        const room = rooms.get(String(msg.code || '').toUpperCase());
        if (!room) return send(ws, { type: 'error', message: 'Room not found' });
        if (room.started) return send(ws, { type: 'error', message: 'Game already started' });
        const guestActive = room.guest && room.guest.ws && room.guest.ws.readyState === 1;
        if (guestActive) return send(ws, { type: 'error', message: 'Room is full' });
        if (room.pendingJoinReq) {
          return send(ws, { type: 'error', message: 'Another player is being reviewed — try again shortly' });
        }
        const requestId = randomBytes(8).toString('hex');
        room.pendingJoinReq = { requestId, ws, name: me.username };
        room.lastActive = Date.now();
        send(room.host.ws, { type: 'join_requested', requestId, name: me.username });
        send(ws, { type: 'join_pending', code: room.code, hostName: room.hostName });
        return;
      }

      case 'cancel_join_request': {
        // Guest backs out before approval.
        const room = rooms.get(String(msg.code || '').toUpperCase());
        if (!room || !room.pendingJoinReq) return;
        if (room.pendingJoinReq.ws !== ws) return;
        room.pendingJoinReq = null;
        send(room.host.ws, { type: 'join_request_cancelled' });
        return;
      }

      case 'approve_join': {
        if (me.role !== 'host') return;
        const room = rooms.get(me.currentRoom);
        if (!room || !room.pendingJoinReq) return;
        if (room.pendingJoinReq.requestId !== msg.requestId) return;
        const req = room.pendingJoinReq;
        room.pendingJoinReq = null;
        const guestToken = makeToken();
        room.guest = { ws: req.ws, token: guestToken, name: req.name };
        const guestClient = clients.get(req.ws);
        if (guestClient) { guestClient.currentRoom = room.code; guestClient.role = 'guest'; }
        lobbyViewers.delete(req.ws);
        room.lastActive = Date.now();
        send(req.ws, {
          type: 'join_approved',
          code: room.code, token: guestToken,
          setup: room.setup, hostName: room.hostName,
        });
        send(ws, { type: 'guest_joined', name: req.name });
        if (!room.private) pushLobby();
        return;
      }

      case 'deny_join': {
        if (me.role !== 'host') return;
        const room = rooms.get(me.currentRoom);
        if (!room || !room.pendingJoinReq) return;
        if (room.pendingJoinReq.requestId !== msg.requestId) return;
        const req = room.pendingJoinReq;
        room.pendingJoinReq = null;
        send(req.ws, { type: 'join_denied', reason: msg.reason || null });
        return;
      }

      case 'start_game': {
        if (me.role !== 'host') return;
        const room = rooms.get(me.currentRoom);
        if (!room || !room.guest) return;
        room.snapshot = msg.snapshot;
        room.started = true;
        room.lastActive = Date.now();
        // Send only to guest — host already entered the game on guest_joined.
        send(room.guest.ws, {
          type: 'game_start',
          setup: room.setup, snapshot: msg.snapshot,
          hostName: room.hostName, guestName: room.guest.name,
        });
        if (!room.private) pushLobby();
        return;
      }

      case 'action': {
        const room = getRoom(ws);
        if (!room) return;
        if (msg.snapshot) room.snapshot = msg.snapshot;
        room.lastActive = Date.now();
        broadcast(room, { type: 'action', action: msg.action, snapshot: msg.snapshot }, ws);
        return;
      }

      case 'reconnect': {
        const room = rooms.get(String(msg.code || '').toUpperCase());
        if (!room) return send(ws, { type: 'error', message: 'Room not found' });
        let role = null;
        if (room.host && room.host.token === msg.token) {
          room.host.ws = ws; role = 'host';
        } else if (room.guest && room.guest.token === msg.token) {
          room.guest.ws = ws; role = 'guest';
        } else {
          return send(ws, { type: 'error', message: 'Invalid token' });
        }
        me.currentRoom = room.code;
        me.role = role;
        if (msg.username) me.username = String(msg.username).slice(0, 20);
        room.lastActive = Date.now();
        send(ws, {
          type: 'reconnected',
          role, code: room.code,
          started: room.started, setup: room.setup,
          snapshot: room.snapshot, hostName: room.hostName,
          guestName: room.guest?.name,
        });
        broadcast(room, { type: 'peer_status', connected: true }, ws);
        return;
      }
    }
  });

  ws.on('close', () => {
    lobbyViewers.delete(ws);
    deleteRoomIfHost(ws);
    const room = getRoom(ws);
    if (room && room.started) {
      broadcast(room, { type: 'peer_status', connected: false }, ws);
    } else if (room && !room.started) {
      // Guest pre-game leave -> just drop guest slot
      if (room.guest && room.guest.ws === ws) {
        room.guest = null;
        send(room.host.ws, { type: 'guest_left' });
        if (!room.private) pushLobby();
      }
    }
    // Cancel pending join request from this ws.
    for (const room of rooms.values()) {
      if (room.pendingJoinReq && room.pendingJoinReq.ws === ws) {
        room.pendingJoinReq = null;
        send(room.host.ws, { type: 'join_request_cancelled' });
      }
    }
    clients.delete(ws);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActive > ROOM_TTL_MS) rooms.delete(code);
  }
}, CLEANUP_INTERVAL_MS);

httpServer.listen(PORT, () => {
  console.log(`Chinese Checkers server on http://localhost:${PORT}`);
});
