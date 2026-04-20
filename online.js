// WebSocket client for the relay server.
// Per-tab session via sessionStorage so multiple tabs don't clash.

const NAME_KEY = 'cc-username';
// Per-role keys so two tabs (one host, one guest) on the same machine don't clash.
const sessionKey = (role) => `cc-online-session-${role}`;

export class Online {
  constructor() {
    this.ws = null;
    this.role = null;       // 'host' | 'guest'
    this.code = null;
    this.token = null;
    this.username = null;
    this.handlers = {};
    this._sendQueue = [];
    this._reconnecting = false;
  }

  on(type, fn) { this.handlers[type] = fn; }
  emit(type, msg) {
    const fn = this.handlers[type];
    if (fn) fn(msg);
  }

  url() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url());
      this.ws.addEventListener('open', () => {
        for (const m of this._sendQueue) this.ws.send(m);
        this._sendQueue = [];
        resolve();
      });
      this.ws.addEventListener('message', (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        // Cache identity from server replies.
        if (msg.type === 'room_created') {
          this.role = 'host'; this.code = msg.code; this.token = msg.token;
          this.persist();
        } else if (msg.type === 'join_approved') {
          this.role = 'guest'; this.code = msg.code; this.token = msg.token;
          this.persist();
        } else if (msg.type === 'reconnected') {
          this.role = msg.role; this.code = msg.code;
          this.persist();
        } else if (msg.type === 'room_cancelled') {
          this.clearSession();
          this.role = null; this.code = null; this.token = null;
        }
        this.emit(msg.type, msg);
      });
      this.ws.addEventListener('close', () => {
        this.emit('disconnected', {});
        if (this.token && this.code && !this._reconnecting) this.tryReconnect();
      });
      this.ws.addEventListener('error', (e) => reject(e));
    });
  }

  send(msg) {
    const data = JSON.stringify(msg);
    if (this.ws && this.ws.readyState === 1) this.ws.send(data);
    else this._sendQueue.push(data);
  }

  setUsername(name) {
    this.username = name;
    localStorage.setItem(NAME_KEY, name);
    this.send({ type: 'set_username', name });
  }

  subscribeLobby() { this.send({ type: 'subscribe_lobby' }); }
  unsubscribeLobby() { this.send({ type: 'unsubscribe_lobby' }); }
  createRoom(setup, isPrivate) { this.send({ type: 'create_room', setup, private: !!isPrivate }); }
  cancelRoom() { this.send({ type: 'cancel_room' }); }
  requestJoin(code) { this.send({ type: 'request_join', code }); }
  cancelJoinRequest(code) { this.send({ type: 'cancel_join_request', code }); }
  approveJoin(requestId) { this.send({ type: 'approve_join', requestId }); }
  denyJoin(requestId) { this.send({ type: 'deny_join', requestId }); }
  startGame(snapshot) { this.send({ type: 'start_game', snapshot }); }
  sendAction(action, snapshot) { this.send({ type: 'action', action, snapshot }); }

  persist() {
    if (this.code && this.token && this.role) {
      localStorage.setItem(sessionKey(this.role), JSON.stringify({
        code: this.code, token: this.token, role: this.role,
        username: this.username, ts: Date.now(),
      }));
    }
  }

  clearSession() {
    if (this.role) localStorage.removeItem(sessionKey(this.role));
  }

  static loadSessions() {
    const out = [];
    for (const role of ['host', 'guest']) {
      try {
        const raw = localStorage.getItem(sessionKey(role));
        if (!raw) continue;
        const s = JSON.parse(raw);
        if (Date.now() - s.ts > 48 * 3600 * 1000) {
          localStorage.removeItem(sessionKey(role));
          continue;
        }
        out.push(s);
      } catch {}
    }
    return out;
  }

  static clearAllSessions() {
    localStorage.removeItem(sessionKey('host'));
    localStorage.removeItem(sessionKey('guest'));
  }

  static loadName() {
    return localStorage.getItem(NAME_KEY) || '';
  }

  reconnectRoom(code, token, username) {
    this.code = code; this.token = token;
    if (username) this.username = username;
    this.send({ type: 'reconnect', code, token, username });
  }

  tryReconnect() {
    this._reconnecting = true;
    let delay = 1000;
    const attempt = () => {
      const next = new WebSocket(this.url());
      next.addEventListener('open', () => {
        this._reconnecting = false;
        this.ws = next;
        next.addEventListener('message', (e) => {
          let msg; try { msg = JSON.parse(e.data); } catch { return; }
          this.emit(msg.type, msg);
        });
        next.addEventListener('close', () => {
          this.emit('disconnected', {});
          if (this.token && this.code) this.tryReconnect();
        });
        next.send(JSON.stringify({ type: 'reconnect', code: this.code, token: this.token, username: this.username }));
      });
      next.addEventListener('error', () => {
        delay = Math.min(delay * 1.6, 10000);
        setTimeout(attempt, delay);
      });
    };
    setTimeout(attempt, delay);
  }
}
