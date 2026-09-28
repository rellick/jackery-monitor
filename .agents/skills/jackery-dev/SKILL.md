---
name: jackery-dev
description: >-
  Provides end-to-end development, testing, deployment, and git workflow guidance
  for the Jackery Monitor application, including Docker Compose commands, local
  architecture details, branch management, and verification procedures. Use when
  building new features, debugging, modifying frontend/backend code, or deploying
  Jackery Monitor.
---

# Jackery Monitor Development Skill

This skill documents the development environment, local architecture, and deployment procedures for Jackery Monitor.

---

## 1. System Architecture

```
                 +-----------------------------------------------+
                 |              Docker Host Network              |
                 |                                               |
  Browser  ----> |  jackery-monitor (server.py)                  |
  :8000          |  - FastAPI HTTP & WebSocket                   |
                 |  - Mounts ./web live                          |
                 |  - Talks to SQLite (/data/energy.db)          |
                 +-------------------+---------------------------+
                                     | JSON-RPC over TCP
                                     v 127.0.0.1:8766
                 +-----------------------------------------------+
                 |  jackery-bridge (bridge.py)                   |
                 |  - Polls Jackery Cloud & MQTT                 |
                 |  - Port 8766 bound to 127.0.0.1               |
                 +-----------------------------------------------+
```

### Components
1. **`server.py`**:
   - Web application entry point (`uvicorn`).
   - Serves REST API and broadcasts live status via WebSockets.
   - Slices telemetry and manages in-memory status deque.
   - Requires Docker image rebuild when modified.

2. **`bridge.py`**:
   - Communicates with Jackery cloud API and MQTT telemetry brokers.
   - Exposes internal JSON-RPC on `127.0.0.1:8766`.
   - Credentials stored encrypted in `/data/jackery-creds.json`.

3. **`energy_db.py`**:
   - Aggregates and records Wh input/output in SQLite (`/data/energy.db`).
   - Stores continuous 1-minute bucketed samples in table `samples`.

4. **`web/`**:
   - Static web assets (`index.html`, `app.js`, `style.css`).
   - Live-mounted inside container during development (`./web:/app/web`).

---

## 2. Git Workflow & Remotes

- **Personal Fork (`origin`)**: `https://github.com/rellick/jackery-monitor.git`
- **Active Working Branch**: `my-custom-features`
- **Upstream Repository (`upstream`)**: `https://github.com/YanivErel-code/jackery-monitor.git`
- **Credentials**: Managed via `git config --global credential.helper store` (GitHub Personal Access Token).

### Typical Git Commands
```bash
# Check status and diff
git status
git diff

# Commit changes
git add <files>
git commit -m "Description of change"

# Push to your fork
git push origin my-custom-features

# Syncing with upstream main (when needed)
git fetch upstream
git merge upstream/main
```

---

## 3. Docker Deployment Procedures

Always use `docker-compose.build.yml` for local builds and development.

### Rebuilding and Redeploying
Whenever changes are made to Python code (`server.py`, `bridge.py`, `energy_db.py`, etc.):
```bash
docker compose -f docker-compose.build.yml up -d --build
```

### Editing Frontend Code
For changes to files in `web/` (`app.js`, `index.html`, `style.css`):
- Because `./web` is volume-mounted in `docker-compose.build.yml`, changes take effect immediately without rebuilding the container.
- Hard refresh the browser (`Ctrl+Shift+R`) to bypass browser and Service Worker caching.

### Checking Container Health and Logs
```bash
# Verify running containers
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

# Inspect server logs
docker logs --tail 50 jackery-monitor

# Inspect bridge logs
docker logs --tail 50 jackery-bridge
```

---

## 4. Verification & Testing

- **Dashboard UI**: `http://192.168.86.135:8000` (or `http://localhost:8000`).
- **REST Status**:
  ```bash
  curl -s http://127.0.0.1:8000/api/status | jq .
  ```
- **Python Syntax Check**:
  ```bash
  python3 -m py_compile server.py bridge.py energy_db.py
  ```
