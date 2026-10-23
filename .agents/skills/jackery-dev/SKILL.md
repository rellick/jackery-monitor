---
name: jackery-dev
description: >-
  Provides end-to-end development, testing, deployment, and git workflow guidance
  for the Vigie (formerly Jackery Monitor / Vigil) application residing in /home/pleblanc/jackery-monitor.
  Use whenever working on Vigie, building new features, debugging, modifying frontend/backend code,
  or deploying the Docker containers.
---

# Vigie / Jackery Monitor Development Skill

This skill documents the development environment, local architecture, and deployment procedures for **Vigie** (residing at `/home/pleblanc/jackery-monitor`).

---

## 1. System Architecture

```
                 +-----------------------------------------------+
                 |              Docker Host Network              |
                 |                                               |
  Browser  ----> |  jackery-monitor (server.py)                  |
  :8000          |  - FastAPI HTTP & WebSocket                   |
                 |  - Mounts ./web live                          |
                 |  - Multi-home locations (/data/locations.json)|
                 |  - Sinopé client (Neviweb REST API)           |
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
   - Hosts background pollers for Jackery bridge and Sinopé Neviweb devices.
   - Slices telemetry and manages in-memory status deque.
   - Requires Docker image rebuild when modified.

2. **`bridge.py`**:
   - Communicates with Jackery cloud API and MQTT telemetry brokers.
   - Exposes internal JSON-RPC on `127.0.0.1:8766`.
   - Credentials stored encrypted in `/data/jackery-creds.json`.

3. **`sinope_client.py` & `sinope_creds.py`**:
   - Interfaces with Neviweb Cloud REST API (`https://neviweb.com/api`).
   - Discovers Wi-Fi thermostats and load controllers/switches across accounts/locations.
   - Computes active load power from duty cycle or reported wattage.
   - Credentials stored encrypted in `/data/sinope-creds.json` (AES-256-GCM).

4. **`locations.py`**:
   - Multi-home site management stored in `/data/locations.json`.
   - Maps physical sites (Maison, Chalet) to utility tariff plans (e.g. `hq-tarif-d-tdt`, `hq-tarif-flex-d`), assigns Jackerys, and links Sinopé devices.

5. **`hilo_client.py` & `hilo_creds.py`**:
   - Interfaces with Hydro-Québec's Hilo platform to poll smart meter power draw and Défi Hilo events.
   - Credentials stored encrypted in `/data/hilo-creds.json` (AES-256-GCM).

6. **`thinq_client.py` & `thinq_creds.py`**:
   - Interfaces with LG's official ThinQ Connect Open API (`https://api-aic.lgthinq.com`) using Personal Access Tokens (PAT).
   - Monitors and controls laundry, refrigeration, and cooking smart appliances.
   - Credentials stored encrypted in `/data/thinq-creds.json` (AES-256-GCM).

7. **`midea_client.py` & `midea_creds.py`**:
   - Interfaces with Danby / Midea smart dehumidifiers over local Wi-Fi LAN and MSmartHome cloud.
   - Credentials stored encrypted in `/data/midea-creds.json` (AES-256-GCM).

8. **`tesla_client.py` & `tesla_creds.py`**:
   - Connects locally to Tesla Gen 3 Wall Connectors over HTTP (`/api/1/vitals`) and vehicle telemetry directly via official Tesla Fleet / Owner API (100% free, no paid subscriptions).
   - Features intelligent Mobile Connector inference, GPS geofencing, vehicle sleep preservation, and 15s-30s high-frequency charging telemetry for NILM disaggregation.
   - Credentials stored encrypted in `/data/tesla-creds.json` (AES-256-GCM).

9. **`energy_db.py`**:
   - Aggregates and records Wh input/output and load power in SQLite (`/data/energy.db`).
   - Stores continuous 1-minute bucketed samples in table `samples` for battery units and load devices.

10. **`web/`**:
   - Static web assets (`index.html`, `app.js`, `style.css`).
   - Live-mounted inside container during development (`./web:/app/web`).
   - Features dedicated Sinopé, Daikin, Hilo, ThinQ, Danby, and Tesla tabs with location filters, charts, device cards, and Settings credential management.

---

## 2. Git Workflow & Remotes

- **Personal Fork (`origin`)**: `https://github.com/rellick/jackery-monitor.git`
- **Active Working Branch**: `local`
- **Upstream Repository (`upstream`)**: `https://github.com/YanivErel-code/jackery-monitor.git`
- **Credentials**: Managed via `git config --global credential.helper store` (GitHub Personal Access Token).
- **Change Uploads**: All changes should be uploaded to Gerrit (and pushed to the remote repository).

### Typical Git Commands
```bash
# Check status and diff
git status
git diff

# Commit changes
git add <files>
git commit -m "Description of change"

# Push / upload to Gerrit and remote fork
git push origin local

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
- **Locations, Sinopé, Daikin & Hilo REST API**:
  ```bash
  curl -s http://127.0.0.1:8000/api/locations
  curl -s http://127.0.0.1:8000/api/sinope/credentials
  curl -s http://127.0.0.1:8000/api/sinope/devices
  curl -s "http://127.0.0.1:8000/api/sinope/history/location?location_id=maison&hours=24"
  curl -s "http://127.0.0.1:8000/api/sinope/history/device?device_sn=sinope_574769&hours=24"
  curl -s http://127.0.0.1:8000/api/hilo/credentials
  curl -s http://127.0.0.1:8000/api/hilo/devices
  ```
- **Python Syntax Check & Unit Tests**:
  ```bash
  python3 -m py_compile server.py bridge.py energy_db.py sinope_client.py sinope_creds.py daikin_client.py daikin_creds.py hilo_client.py hilo_creds.py locations.py thinq_client.py thinq_creds.py midea_client.py midea_creds.py
  pytest
  ```

---

## 5. Time-Series Telemetry & Load Disaggregation (NILM) Architecture

- **Objective**: Across all integrations, continuous granular time-series state and power data must be recorded in SQLite (`energy_db.py` / `samples` table) to support Non-Intrusive Load Monitoring (NILM) and power disaggregation against whole-home Hilo smart meter demand curves ($P_{\text{total}}$).
- **Core Principles for All Integrations**:
  1. **Continuous 1-Minute Samples (`samples` table)**: Every integration poller loop MUST record per-device 1-minute samples (`BUCKET_S = 60`) into `samples` with active/estimated wattage (`output_w`), equipment status (`equipment_status`), temperatures (`battery_temp_c`, `outdoor_temp_c`), and detailed component payload (`state_json`).
  2. **Raw Operational State Preservation**: Never discard or prematurely collapse granular state into a single opaque number:
     - **Sinopé Thermostats**: Preserve the raw duty cycle percentage (`equipment_status = heat_level_pct`, 0-100%) and setpoint/configured element wattage in `state_json` so regression models can validate physical baseboard wattage against Hilo meter deltas.
     - **LG ThinQ Appliances**: Track sub-component states in `state_json` (individual cooktop burners with power levels 1-10, oven cavity preheating/bake temperatures, washer cycle steps [wash/rinse/spin], dryer heating cycles, refrigerator door and express freeze events).
     - **Danby / Midea Dehumidifiers**: Preserve operating mode in `equipment_status` (0=off, 1=compressor, 2=fan_only, 3=defrost, 4=tank_full).
     - **Daikin Heat Pumps**: Preserve equipment status (cool, heat, fan, circulating) and indoor/outdoor temperatures to model ambient COP curves.
  3. **High-Frequency Polling on Active States**: Pollers should dynamically accelerate polling (e.g. from 60s to 30s) when appliances or cooking zones are actively running to capture sharp transition edges.


