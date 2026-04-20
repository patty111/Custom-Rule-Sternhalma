# Deployment

The game ships as a single Node process that serves both the static client and a
WebSocket relay for online rooms.

## Local play (LAN or single machine)

```bash
npm install
npm start
# open http://localhost:8080
```

**Keep the server alive between sessions.** `npm start` runs in the foreground;
closing the terminal stops the server, which means rooms vanish and you can no
longer reach `localhost:8080`. To run detached:

```bash
nohup npm start > server.log 2>&1 &     # detached, logs to server.log
# or use screen/tmux
```

Two browser tabs on the same machine can play each other (one creates a room,
the other joins with the code shown in the header).

For friends on the same Wi-Fi, share `http://<your-LAN-IP>:8080`.

## Public internet — easiest options

### Cloudflare Tunnel (no signup, ephemeral URL)

```bash
brew install cloudflared            # one-time
npm start                           # in one terminal
cloudflared tunnel --url http://localhost:8080
```

Cloudflare prints an `https://<random>.trycloudflare.com` URL. Share it with
your friend — the WebSocket goes through the same hostname, so it just works.

### Fly.io / Render / Railway (always-on, free tier)

- The repo is already deploy-ready. `package.json` has `start: node server.js`.
- Make sure the platform's port is set via the `PORT` env var (the server reads
  it). `8080` is the local default.
- Fly.io example:

  ```bash
  fly launch                         # accept defaults; uses Node detection
  fly deploy
  ```

## Notes & limits

- **Max 2 humans per room.** All other slots are AI (host configures).
- **Room TTL: 48h** of inactivity. Any move resets the timer.
- **Disconnect = pause.** The other side sees a paused indicator. Reconnect
  (refresh the tab — token in localStorage resumes the room) and play continues.
- **AI runs on the host's tab only.** If the host disconnects, AI moves halt
  until they're back.
- Rooms are kept in memory; restarting the server clears them.
