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

### Fly.io (recommended for always-on)

The repo includes a `Dockerfile` and `.dockerignore` ready for Fly. Cost is
typically ~$2/mo for one always-on shared-cpu-1x:256MB machine, which sits
inside Fly's $5/mo free credit.

**One-time setup:**

```bash
brew install flyctl                       # macOS; or curl -L https://fly.io/install.sh | sh
fly auth signup                           # browser; needs a credit card for verification
```

**Deploy from the project root:**

```bash
fly launch --no-deploy                    # accept name+region; say NO to Postgres/Redis/Tigris
```

That generates `fly.toml`. Open it and make sure these are set so a machine
stays running 24/7 (rooms expire after 48h, so always-on matters):

```toml
[http_service]
  internal_port = 8080
  force_https   = true
  auto_stop_machines  = false
  auto_start_machines = true
  min_machines_running = 1

[[vm]]
  cpu_kind = "shared"
  cpus     = 1
  memory_mb = 256
```

Then deploy and open:

```bash
fly deploy
fly open                                  # opens the live URL in your browser
```

Updates: edit any file → `fly deploy` again. That's the whole loop.

### Other always-on options

- **Render** — connect GitHub repo via the web UI; free tier sleeps after 15min idle (cold start when someone visits).
- **Railway** — similar; uses your $5/mo free credit.

## Notes & limits

- **Max 2 humans per room.** All other slots are AI (host configures).
- **Room TTL: 48h** of inactivity. Any move resets the timer.
- **Disconnect = pause.** The other side sees a paused indicator. Reconnect
  (refresh the tab — token in localStorage resumes the room) and play continues.
- **AI runs on the host's tab only.** If the host disconnects, AI moves halt
  until they're back.
- Rooms are kept in memory; restarting the server clears them.
