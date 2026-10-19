# Jackery Monitor Development Guide

## Architecture Overview
- **Dashboard Server (`server.py`)**: FastAPI application running on host port 8000 (`PORT=8000`). Serves REST endpoints, WebSocket status broadcasts every 10s, and static assets from `/app/web`. Hosts background pollers for bridge telemetry and Sinopé Neviweb devices.
- **Cloud Bridge (`bridge.py`)**: Dedicated bridge container that connects to the Jackery cloud/MQTT, caches telemetry in memory, and serves JSON-RPC over loopback TCP port `127.0.0.1:8766`.
- **Database (`energy_db.py`)**: SQLite database located at `/data/energy.db` (persisted in the `jackery-data` Docker volume). Records 1-minute samples (`BUCKET_S = 60`) for Jackery battery stations and non-Jackery load devices (Sinopé thermostats & controllers), powering lifetime, rolling window (7d, 30d), and daily rollup analytics.
- **Sinopé Integration (`sinope_client.py` & `sinope_creds.py`)**: Connects to Neviweb Cloud REST API (`https://neviweb.com/api`) to discover and poll Wi-Fi thermostats and load controllers. Credentials stored encrypted at `/data/sinope-creds.json` (AES-256-GCM via `crypto_util`). Active power is computed from duty cycle wattage (`(outputPercentDisplay / 100) * loadWatt`) or reported wattage.
- **Daikin Integration (`daikin_client.py` & `daikin_creds.py`)**: Connects to Daikin One Open API (`https://integrator-api.daikinskyport.com`) to monitor and control communicating heat pumps and Daikin One smart thermostats. Credentials stored encrypted at `/data/daikin-creds.json` (AES-256-GCM via `crypto_util`). Supports HVAC operating mode switching (Heat, Cool, Auto, Off, Aux Heat), setpoint adjustments (enforcing deadband constraints), fan circulation mode & speed controls, schedule toggles, **Air Clean** mode (continuous medium fan for 3 hours with automatic restore and reboot persistence at `/data/daikin-airclean.json`), and 180s background polling.
- **Hilo Integration (`hilo_client.py` & `hilo_creds.py`)**: Connects to Hydro-Québec's Hilo platform (Azure B2C authentication + GraphQL digital twin) to read real-time whole-home power from Zigbee smart meters, monitor connected Zigbee devices, and track Défi Hilo peak demand challenges. Credentials stored encrypted at `/data/hilo-creds.json` (AES-256-GCM via `crypto_util`).
- **LG ThinQ Integration (`thinq_client.py` & `thinq_creds.py`)**: Connects to LG ThinQ Connect Open API (`https://api-aic.lgthinq.com`) using Personal Access Tokens (PAT). Credentials stored encrypted at `/data/thinq-creds.json` (AES-256-GCM via `crypto_util`). Monitors washers, dryers, refrigerators, freezers, ovens, cooktops, microwaves, and dishwashers with multi-location support, appliance running/cooking state tracking, refrigerator temperature monitoring, door open alerts, and Express Freeze controls.
- **Danby / Midea Dehumidifier Integration (`midea_client.py` & `midea_creds.py`)**: Connects to Danby smart dehumidifiers (manufactured on Midea hardware, appliance type `0xA1`) via local Wi-Fi LAN protocol (`midea-beautiful-air`) and Midea Cloud (MSmartHome / NetHome Plus). Credentials stored encrypted at `/data/midea-creds.json` (AES-256-GCM). Features real-time room humidity (%), target setpoint adjustment (30-80%), power On/Off toggles, fan speed controls (Low / High), and water tank full alerts.
- **Tesla & EV Charger Integration (`tesla_client.py` & `tesla_creds.py`)**: Connects locally to Tesla Gen 3 Wall Connectors over Wi-Fi (`http://<ip>/api/1/vitals`) and connects to the Model Y vehicle directly via official Tesla Fleet API / Owner OAuth (100% free, zero subscriptions required, using `developer.tesla.com` or direct OAuth refresh tokens). Credentials stored encrypted at `/data/tesla-creds.json` (AES-256-GCM via `crypto_util`). Features real-time EV charging power, battery SOC (%), estimated range (km), contactor status, session/lifetime kWh, vehicle sleep preservation, and intelligent **Mobile Connector inference** using vehicle GPS geofencing, voltage/current patterns, and local Wall Connector contactor state.
- **TP-Link Kasa Integration (`kasa_client.py`, `kasa_devices.py` & `kasa_creds.py`)**: Connects to TP-Link Kasa smart plugs (KP115, KP125M, EP25, HS103) and smart interruptors / wall switches (HS200, HS210 3-way, KS200, dimmers). Credentials stored encrypted at `/data/kasa-creds.json` (AES-256-GCM). Features real-time state monitoring, active wattage measurement, on/off toggles, automatic LAN discovery, and reconciler polling with SQLite sample recording for NILM.
- **Multi-Home Location Engine (`locations.py`)**: Manages locations at `/data/locations.json` (e.g. Maison and Chalet). Maps physical sites to Hydro-Québec rate plans (e.g., Maison on `hq-tarif-d-tdt` and Chalet on `hq-tarif-flex-d`), assigns Jackery units, and associates Sinopé devices by Neviweb location.
- **Email Notifications (`notifications.py`)**: Automated alert dispatch system powered by Gmail SMTP (or custom SMTP relays). Credentials stored encrypted at `/data/notifications.json` (AES-256-GCM). Supports triggers for low battery SOC, cloud bridge stalls, Sinopé water leak detection, thermostat freeze warnings (< 5°C), and dehumidifier full water tank alerts, with cooldown de-duplication to prevent email spam.
- **Frontend (`web/`)**: Vanilla modern HTML, CSS, and JS (`index.html`, `app.js`, `style.css`). Features dedicated **Sinopé**, **Daikin**, **Hilo**, **ThinQ**, **Danby**, **Tesla**, and **Kasa** tabs with location filter pills, aggregate KPIs, whole-home live power curves, interactive climate controls, temperature & EV charging history charts, device cards, and dedicated Settings configuration forms.

## Git Remotes & Branches
- **Personal Fork (`origin`)**: `https://github.com/rellick/jackery-monitor.git`
- **Active Working Branch**: `local`
- **Upstream Repository (`upstream`)**: `https://github.com/YanivErel-code/jackery-monitor.git` (tracked branch `main`)
- **Credentials**: Stored on disk via `git config credential.helper store`.
- **Change Uploads**: All changes should be uploaded to Gerrit (and pushed to the remote fork).

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
- **Bridge Container Commands**:
  - Always allowed to run commands that start with `docker exec jackery-bridge`.
- **API Testing Endpoints**:
  ```bash
  # Check locations
  curl -s http://127.0.0.1:8000/api/locations
  # Check Sinopé credentials status
  curl -s http://127.0.0.1:8000/api/sinope/credentials
  # Check discovered Sinopé devices
  curl -s http://127.0.0.1:8000/api/sinope/devices
  # Check location history
  curl -s "http://127.0.0.1:8000/api/sinope/history/location?location_id=maison&hours=24"
  # Check device history
  curl -s "http://127.0.0.1:8000/api/sinope/history/device?device_sn=sinope_574769&hours=24"
  # Check Daikin credentials status
  curl -s http://127.0.0.1:8000/api/daikin/credentials
  # Check discovered Daikin devices
  curl -s http://127.0.0.1:8000/api/daikin/devices
  # Check Daikin device history
  curl -s "http://127.0.0.1:8000/api/daikin/history/device?device_sn=daikin_test&hours=24"
  # Trigger Air Clean (medium fan for 3 hours)
  curl -X POST -s http://127.0.0.1:8000/api/daikin/device/<device_id>/air-clean
  # Cancel Air Clean and restore previous settings
  curl -X DELETE -s http://127.0.0.1:8000/api/daikin/device/<device_id>/air-clean
  # Check notification settings
  curl -s http://127.0.0.1:8000/api/notifications/config
  # Check Hilo credentials status
  curl -s http://127.0.0.1:8000/api/hilo/credentials
  # Check discovered Hilo devices & challenges
  curl -s http://127.0.0.1:8000/api/hilo/devices
  # Check Hilo meter power history
  curl -s "http://127.0.0.1:8000/api/hilo/history/meter?device_sn=hilo_meter_maison_...&hours=24"
  # Trigger manual Hilo poll
  curl -X POST -s http://127.0.0.1:8000/api/hilo/poll
  # Check ThinQ credentials status
  curl -s http://127.0.0.1:8000/api/thinq/credentials
  # Check discovered ThinQ appliances
  curl -s http://127.0.0.1:8000/api/thinq/devices
  # Trigger manual ThinQ poll
  curl -X POST -s http://127.0.0.1:8000/api/thinq/poll
  # Send control command to appliance (e.g. Express Freeze)
  curl -X POST -s http://127.0.0.1:8000/api/thinq/device/<device_id>/control -H "Content-Type: application/json" -d '{"location_id":"maison","payload":{"refrigeration":{"expressFreeze":"START"}}}'
  # Check Danby / Midea credentials status
  curl -s http://127.0.0.1:8000/api/midea/credentials
  # Check discovered Danby dehumidifiers
  curl -s http://127.0.0.1:8000/api/midea/devices
  # Trigger manual Danby / Midea poll
  curl -X POST -s http://127.0.0.1:8000/api/midea/poll
  # Send control command to dehumidifier (e.g. set power or target humidity)
  curl -X POST -s http://127.0.0.1:8000/api/midea/device/<device_id>/control -H "Content-Type: application/json" -d '{"power": true, "target_humidity": 45, "fan_speed": 40}'
  # Check ThinQ appliance history
  curl -s "http://127.0.0.1:8000/api/thinq/history/device?device_sn=thinq_maison_...&hours=24"
  # Check Tesla credentials status
  curl -s http://127.0.0.1:8000/api/tesla/credentials
  # Check discovered Tesla devices (Wall Connectors & Model Y)
  curl -s http://127.0.0.1:8000/api/tesla/devices
  # Trigger manual Tesla poll
  curl -X POST -s http://127.0.0.1:8000/api/tesla/poll
  # Check Tesla device history
  curl -s "http://127.0.0.1:8000/api/tesla/history/device?device_sn=tesla_twc_...&hours=24"
  ```

## Time-Series Telemetry & Load Disaggregation (NILM) Architecture
- **Objective**: Across all integrations, continuous granular time-series state and power data must be recorded in SQLite (`energy_db.py` / `samples` table) to support Non-Intrusive Load Monitoring (NILM) and power disaggregation against whole-home Hilo smart meter demand curves ($P_{\text{total}}$).
- **Core Principles for All Integrations**:
  1. **Continuous 1-Minute Samples (`samples` table)**: Every integration poller loop MUST record per-device 1-minute samples (`BUCKET_S = 60`) into `samples` with active/estimated wattage (`output_w`), equipment status (`equipment_status`), temperatures (`battery_temp_c`, `outdoor_temp_c`), and detailed component payload (`state_json`).
  2. **Raw Operational State Preservation**: Never discard or prematurely collapse granular state into a single opaque number:
     - **Sinopé Thermostats**: Preserve the raw duty cycle percentage (`equipment_status = heat_level_pct`, 0-100%) and setpoint/configured element wattage in `state_json` so regression models can validate physical baseboard wattage against Hilo meter deltas.
     - **LG ThinQ Appliances**: Track sub-component states in `state_json` (individual cooktop burners with power levels 1-10, oven cavity preheating/bake temperatures, washer cycle steps [wash/rinse/spin], dryer heating cycles, refrigerator door and express freeze events).
     - **Danby / Midea Dehumidifiers**: Preserve operating mode in `equipment_status` (0=off, 1=compressor, 2=fan_only, 3=defrost, 4=tank_full).
     - **Daikin Heat Pumps**: Preserve equipment status (cool, heat, fan, circulating) and indoor/outdoor temperatures to model ambient COP curves.
     - **Tesla EV Charging**: Preserve contactor state, grid voltage, vehicle current, battery SOC%, charging state, time to full charge, and inferred charger type (`wall_connector`, `mobile_connector_l1`, `mobile_connector_l2`, `supercharger`) in `state_json`.
  3. **High-Frequency Polling on Active States**: Pollers should dynamically accelerate polling (e.g. from 60s to 15s-30s) when appliances, vehicles, or cooking zones are actively running to capture sharp transition edges against whole-home smart meter demand.




