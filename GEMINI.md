# Jackery Monitor Development Guide

## Architecture Overview
- **Dashboard Server (`server.py`)**: FastAPI application running on host port 8000 (`PORT=8000`). Serves REST endpoints, WebSocket status broadcasts every 10s, and static assets from `/app/web`.
- **Cloud Bridge (`bridge.py`)**: Dedicated bridge container that connects to the Jackery cloud/MQTT, caches telemetry in memory, and serves JSON-RPC over loopback TCP port `127.0.0.1:8766`.
- **Database (`energy_db.py`)**: SQLite database located at `/data/energy.db` (persisted in the `jackery-data` Docker volume). It continuously records 1-minute samples (`BUCKET_S = 60`) for lifetime, rolling window (7d, 30d), and daily rollup analytics.
- **Frontend (`web/`)**: Vanilla modern HTML, CSS, and JS (`index.html`, `app.js`, `style.css`).

## Git Remotes & Branches
- **Personal Fork (`origin`)**: `https://github.com/rellick/jackery-monitor.git`
- **Active Working Branch**: `my-custom-features`
- **Upstream Repository (`upstream`)**: `https://github.com/YanivErel-code/jackery-monitor.git` (tracked branch `main`)
- **Credentials**: Stored on disk via `git config credential.helper store`.

## Docker Compose Setup & Deployment
- **Deployment File**: ALWAYS use `docker-compose.build.yml` for local development and running uncommitted code. (Do NOT use `docker-compose.yml`, which pulls pre-built GHCR images from upstream).
- **Build & Deploy Command**:
  ```bash
  docker compose -f docker-compose.build.yml up -d --build
  ```
- **Live UI Editing**:
  - `./web` is volume-mounted directly to `/app/web` in `docker-compose.build.yml`.
  - Edits to HTML/JS/CSS in `web/` take effect immediately upon browser reload (hard reload `Ctrl+Shift+R` to clear service worker / browser cache).
  - Edits to Python modules (`server.py`, `energy_db.py`, etc.) require running the compose build/up command above.

## Local Access & Testing
- **Local Dashboard URL**: `http://192.168.86.135:8000` (or `http://localhost:8000`)
- **Container Health**:
  ```bash
  docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
  ```
- **Container Logs**:
  ```bash
  docker logs --tail 50 jackery-monitor
  docker logs --tail 50 jackery-bridge
  ```
