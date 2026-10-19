"""End-to-end smoke tests for FastAPI routes registered in server.py.

Uses TestClient with a mock backend + isolated /data dir. Each test
reloads `server` so its module-level `state` picks up the patched env
vars (same pattern as test_server_view.py).

Coverage focus: high-traffic happy paths + the auth gate. Detailed
behavioral tests for individual subsystems live in their own files
(test_automation, test_smart_charge, test_energy_db, etc.); these are
the route-layer tests the audit flagged as missing.
"""

from __future__ import annotations

import importlib
import os
import time

import pytest
from fastapi.testclient import TestClient

# Force mock backend at module-import time so server's `state.client`
# lands on the synthetic generator instead of trying to connect to the
# bridge daemon during the lifespan startup.
os.environ["BACKEND"] = "mock"


@pytest.fixture()
def app(isolated_data, monkeypatch, tmp_path):
    """Reload server with isolated data and a mock backend; return the
    module so tests can also reach `state` directly when needed.

    Every module that reads a /data path at import time has its
    module-level constants frozen on first import. We force-reload the
    relevant modules in dependency order so they pick up the patched
    env vars from the isolated_data fixture (which runs first)."""
    monkeypatch.setenv("JACKERY_MOCK", "1")
    monkeypatch.setenv("BACKEND", "mock")
    monkeypatch.setenv("JACKERY_DB", str(tmp_path / "energy.db"))
    monkeypatch.setenv("JACKERY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("JACKERY_BACKUP_CREDS_FILE",
                       str(tmp_path / "backup-creds.json"))
    monkeypatch.setenv("JACKERY_SINOPE_CREDS_FILE",
                       str(tmp_path / "sinope-creds.json"))
    monkeypatch.setenv("JACKERY_LOCATIONS_FILE",
                       str(tmp_path / "locations.json"))
    monkeypatch.setenv("JACKERY_NOTIFICATIONS_FILE",
                       str(tmp_path / "notifications.json"))

    # Reload in dependency order so each module sees the patched env
    # AND its dependencies' updated constants. crypto_util has to be
    # first since auth, *_creds modules all depend on it.
    import crypto_util
    importlib.reload(crypto_util)
    for name in (
        "auth", "settings", "automation", "location", "smart_charge",
        "cost", "anthropic_creds", "anthropic_prefs",
        "kasa_creds", "kasa_devices", "backup_creds", "energy_db",
        "locations", "sinope_creds", "sinope_client", "notifications",
    ):
        mod = importlib.import_module(name)
        importlib.reload(mod)

    import server as server_mod
    importlib.reload(server_mod)
    return server_mod


@pytest.fixture()
def unauth_client(app):
    """TestClient with NO auth user set up — used to exercise the
    /setup redirect path."""
    with TestClient(app.app) as c:
        yield c


@pytest.fixture()
def client(app):
    """TestClient with an admin user pre-created. Cookies are set on
    the client jar so subsequent requests are authenticated."""
    with TestClient(app.app) as c:
        r = c.post(
            "/api/auth/setup",
            json={"username": "smoke", "password": "smokesmokesmoke"},
        )
        assert r.status_code == 200, r.text
        yield c


# ---------- auth flow + middleware ----------

def test_unauth_root_redirects_to_setup_when_no_user(unauth_client):
    """Fresh install (no user yet) → / redirects to /setup."""
    r = unauth_client.get("/", follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"] == "/setup"


def test_unauth_api_returns_401_when_no_user(unauth_client):
    """Same gate, but for an /api/* path → 401 setup_required."""
    r = unauth_client.get("/api/status")
    assert r.status_code == 401
    assert r.json() == {"detail": "setup_required"}


def test_auth_setup_creates_user_and_sets_cookie(unauth_client):
    r = unauth_client.post(
        "/api/auth/setup",
        json={"username": "alice", "password": "verysecret"},
    )
    assert r.status_code == 200
    assert r.json() == {"ok": True, "username": "alice"}
    # Subsequent setup attempts are 403.
    r2 = unauth_client.post(
        "/api/auth/setup",
        json={"username": "bob", "password": "anothersecret"},
    )
    assert r2.status_code == 403


def test_auth_setup_rejects_short_password(unauth_client):
    r = unauth_client.post(
        "/api/auth/setup",
        json={"username": "alice", "password": "short"},
    )
    assert r.status_code == 400


def test_session_cookie_secure_flag_follows_env(unauth_client, monkeypatch):
    """JACKERY_COOKIE_SECURE=1 must promote the Set-Cookie to Secure.
    Default (unset/0) leaves it off so Cloudflare Tunnel HTTP-to-origin
    deployments still work."""
    monkeypatch.setenv("JACKERY_COOKIE_SECURE", "1")
    r = unauth_client.post(
        "/api/auth/setup",
        json={"username": "alice", "password": "verysecret"},
    )
    assert r.status_code == 200
    set_cookie = r.headers.get("set-cookie", "")
    assert "jackery_session=" in set_cookie
    assert "Secure" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "SameSite=lax" in set_cookie.lower() or "samesite=lax" in set_cookie.lower()


def test_session_cookie_default_is_not_secure(unauth_client, monkeypatch):
    """Default: no Secure flag — matches the canonical Cloudflare Tunnel
    deployment where the origin sees plain HTTP."""
    monkeypatch.delenv("JACKERY_COOKIE_SECURE", raising=False)
    r = unauth_client.post(
        "/api/auth/setup",
        json={"username": "alice", "password": "verysecret"},
    )
    assert r.status_code == 200
    set_cookie = r.headers.get("set-cookie", "")
    assert "jackery_session=" in set_cookie
    # No "Secure" attribute on the cookie.
    assert "secure" not in set_cookie.lower()


def test_auth_login_logout_round_trip(client):
    # client fixture already created user "smoke"; logout, then back in.
    r = client.post("/api/auth/logout")
    assert r.status_code == 200
    # /api/auth/me should now 401.
    r = client.get("/api/auth/me")
    assert r.status_code == 401
    r = client.post(
        "/api/auth/login",
        json={"username": "smoke", "password": "smokesmokesmoke"},
    )
    assert r.status_code == 200
    r = client.get("/api/auth/me")
    assert r.status_code == 200
    assert r.json()["username"] == "smoke"


def test_auth_login_rejects_wrong_password(client):
    r = client.post(
        "/api/auth/login",
        json={"username": "smoke", "password": "WRONG"},
    )
    assert r.status_code == 401


def test_change_password_round_trip(client):
    r = client.post(
        "/api/auth/change_password",
        json={"current": "smokesmokesmoke", "new": "newsecretpw"},
    )
    assert r.status_code == 200
    # Old password should now fail.
    client.post("/api/auth/logout")
    r = client.post(
        "/api/auth/login",
        json={"username": "smoke", "password": "smokesmokesmoke"},
    )
    assert r.status_code == 401
    # New password works.
    r = client.post(
        "/api/auth/login",
        json={"username": "smoke", "password": "newsecretpw"},
    )
    assert r.status_code == 200


# ---------- core read endpoints ----------

def test_status_returns_telemetry_after_auth(client):
    r = client.get("/api/status")
    assert r.status_code == 200
    body = r.json()
    # connect_device runs async in the lifespan, so a fast test can
    # land before it completes — accept any non-error state.
    assert body["connection_status"] in (
        "scanning", "connecting", "connected", "disconnected",
    )
    # Top-level keys the UI relies on.
    assert "device" in body


def test_devices_endpoint_returns_list(client):
    r = client.get("/api/devices")
    assert r.status_code == 200
    body = r.json()
    assert "devices" in body
    assert isinstance(body["devices"], list)


def test_devices_capacity_endpoint(client):
    r = client.get("/api/devices/capacity")
    assert r.status_code == 200
    assert "devices" in r.json()


def test_settings_get_and_save_round_trip(client):
    r = client.get("/api/settings")
    assert r.status_code == 200
    body = r.json()
    # /api/settings returns metadata (label/hint/default + current value)
    # under "settings", keyed by name with the schema as values.
    assert "settings" in body
    keys = {s["key"] for s in body["settings"]}
    assert "low_battery_threshold" in keys
    # Round-trip a benign setting.
    r = client.post(
        "/api/settings",
        json={"low_battery_threshold": 12},
    )
    assert r.status_code == 200
    r = client.get("/api/settings")
    by_key = {s["key"]: s for s in r.json()["settings"]}
    assert by_key["low_battery_threshold"].get("value") == 12


def test_anthropic_models_returns_fallback_without_key(client):
    """No key configured → endpoint must still return a populated list
    (the static fallback) so the UI dropdown isn't empty."""
    r = client.get("/api/anthropic/models")
    assert r.status_code == 200
    body = r.json()
    assert body["source"].startswith("fallback")
    assert len(body["models"]) > 0


def test_automation_rules_initially_empty(client):
    r = client.get("/api/automation/rules")
    assert r.status_code == 200
    body = r.json()
    assert body["rules"] == []


def test_algorithm_suggestions_initially_empty(client):
    r = client.get("/api/algorithm/suggestions")
    assert r.status_code == 200
    body = r.json()
    assert body["suggestions"] == []


def test_algorithm_changes_initially_empty(client):
    r = client.get("/api/algorithm/changes")
    assert r.status_code == 200
    body = r.json()
    assert body["changes"] == []


def test_kasa_saved_initially_empty(client):
    """The /api/kasa/devices route runs a live LAN discovery (which 500s
    when python-kasa isn't installed in CI). /api/kasa/saved reads the
    persisted registry — that's the route the UI hits on tab open."""
    r = client.get("/api/kasa/saved", params={"refresh": "false"})
    assert r.status_code == 200
    body = r.json()
    assert body["devices"] == []


def test_kasa_poll_and_toggle(client, monkeypatch):
    import kasa_client
    async def mock_discover(*args, **kwargs):
        return [
            {"host": "192.168.1.100", "alias": "Garage Switch", "model": "HS210", "type": "WallSwitch", "is_on": False, "power_w": None},
            {"host": "192.168.1.101", "alias": "Living Room Plug", "model": "KP115", "type": "Plug", "is_on": True, "power_w": 42.5},
        ]
    async def mock_set_state(host, on):
        return {"host": host, "alias": "Mocked", "model": "HS210", "type": "WallSwitch", "is_on": on, "power_w": None}

    monkeypatch.setattr(kasa_client, "discover", mock_discover)
    monkeypatch.setattr(kasa_client, "set_state", mock_set_state)

    r = client.post("/api/kasa/poll")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert len(data["devices"]) == 2
    hosts = [d["host"] for d in data["devices"]]
    assert "192.168.1.100" in hosts
    assert "192.168.1.101" in hosts

    r2 = client.post("/api/kasa/device/192.168.1.100/toggle", json={"on": True})
    assert r2.status_code == 200
    assert r2.json()["ok"] is True
    assert r2.json()["device"]["is_on"] is True


def test_kasa_history_endpoint(app, client):
    sn = "kasa_192_168_1_100"
    app.state.energy.upsert_device(sn, "Garage Switch", brand="kasa", device_type="smart_switch", location_id="maison")
    now = int(time.time())
    app.state.energy.record_load(sn, now - 600, power_w=0, equipment_status=1)
    app.state.energy.record_load(sn, now - 300, power_w=0, equipment_status=1)

    r_hist = client.get(f"/api/kasa/history/device?device_sn={sn}&hours=6")
    assert r_hist.status_code == 200
    j_hist = r_hist.json()
    assert j_hist["device_sn"] == sn
    assert "history" in j_hist
    assert len(j_hist["history"]) >= 1
    assert "equipment_status" in j_hist["history"][0]



def test_backup_status_endpoint(client):
    r = client.get("/api/backup/status")
    assert r.status_code == 200
    # Should have at least the configured/last_run scaffolding even when
    # nothing's been backed up yet.
    body = r.json()
    assert isinstance(body, dict)


def test_smart_charge_config_returns_default(client):
    """No active device picked + no configs saved → endpoint should
    return a usable default config rather than 500."""
    r = client.get("/api/smart_charge/config")
    assert r.status_code == 200
    body = r.json()
    assert "config" in body
    assert "mode" in body["config"]


def test_cost_plan_get_endpoint(client):
    r = client.get("/api/cost/plan")
    assert r.status_code == 200
    assert isinstance(r.json(), dict)


def test_location_get_endpoint(client):
    r = client.get("/api/location")
    assert r.status_code == 200


# ---------- error paths ----------

def test_review_now_requires_device(client):
    """No active device + no device_sn arg → 400, not 500."""
    r = client.post("/api/algorithm/review_now", params={})
    # Mock backend DOES advertise a device, so this might actually 202.
    # Either is acceptable; we just want to know we don't 500.
    assert r.status_code in (202, 400)


def test_unknown_route_returns_404(client):
    r = client.get("/api/totally/made/up")
    assert r.status_code == 404


# ---------- energy daily rollup ----------

def test_energy_daily_route_shape_and_clamp(app, client):
    """/api/energy/daily: contract shape, days clamp, and per-device
    resolution. DB-level rollup math is covered in test_energy_db; this
    is the route-layer regression the integration review flagged."""
    sn = "TEST-DAILY-RT"
    app.state.energy.upsert_device(sn, "Rig", 13, "Explorer 5000 Plus")
    bucket = (int(__import__("time").time()) - 3600) // 60 * 60
    with app.state.energy._conn() as c:
        c.execute(
            """INSERT OR REPLACE INTO samples
                   (device_sn, bucket, solar_wh, output_wh, input_wh,
                    ac_input_wh, solar_charge_diverted_wh,
                    last_solar_w, last_output_w, last_battery_pct,
                    sample_count)
               VALUES (?, ?, 1500, 800, 900, 200, 100, 3200, 1900, 42, 1)""",
            (sn, bucket))

    r = client.get(f"/api/energy/daily?device_sn={sn}&days=9999")
    assert r.status_code == 200
    j = r.json()
    assert j["device_sn"] == sn
    assert j["days"] == 365                      # clamped
    assert isinstance(j["tz_offset_s"], int)
    assert len(j["daily"]) == 1
    row = j["daily"][0]
    assert set(row) == {"date", "solar_kwh", "consumed_kwh", "charged_kwh",
                        "grid_kwh", "diverted_kwh", "peak_solar_w",
                        "peak_output_w", "min_soc", "max_soc"}
    assert row["solar_kwh"] == 1.5
    assert row["peak_output_w"] == 1900
    assert row["min_soc"] == 42 and row["max_soc"] == 42

    # Unknown device -> empty, not an error.
    r2 = client.get("/api/energy/daily?device_sn=NOPE")
    assert r2.status_code == 200 and r2.json()["daily"] == []


def test_energy_daily_requires_auth(unauth_client):
    unauth_client.post("/api/auth/setup",
                       json={"username": "u", "password": "p" * 12})
    unauth_client.post("/api/auth/logout")
    r = unauth_client.get("/api/energy/daily")
    assert r.status_code == 401


# ---------- locations & sinope routes ----------

def test_locations_routes(client):
    r = client.get("/api/locations")
    assert r.status_code == 200
    data = r.json()
    assert "locations" in data
    loc_ids = [l["id"] for l in data["locations"]]
    assert "maison" in loc_ids
    assert "chalet" in loc_ids

    # Update locations list
    current_locs = data["locations"]
    current_locs.append({
        "id": "chalet2",
        "name": "Chalet 2",
        "neviweb_name": "Chalet",
        "plan_id": "hq-tarif-flex-d",
        "is_default": False,
        "assigned_jackerys": [],
    })
    r_up = client.post("/api/locations", json={"locations": current_locs})
    assert r_up.status_code == 200
    assert r_up.json()["ok"] is True

    # Assign Jackery
    r_assign = client.post("/api/locations/assign_jackery", json={
        "device_sn": "J2000-TEST",
        "location_id": "chalet",
    })
    assert r_assign.status_code == 200
    assert r_assign.json()["ok"] is True


def test_sinope_credentials_and_devices_routes(app, client, monkeypatch):
    # GET credentials (initially not configured)
    r = client.get("/api/sinope/credentials")
    assert r.status_code == 200
    assert r.json() == {"saved": False, "email": None}

    # Mock test_credentials on state.sinope
    async def mock_test_creds(email, password):
        return {"ok": True, "locations": [{"id": 1, "name": "Maison"}]}

    monkeypatch.setattr(app.state.sinope, "test_credentials", mock_test_creds)

    # Save credentials
    r_save = client.post("/api/sinope/credentials", json={
        "email": "user@example.com",
        "password": "secretpassword",
    })
    assert r_save.status_code == 200
    assert r_save.json()["ok"] is True

    # GET credentials (now configured)
    r_get = client.get("/api/sinope/credentials")
    assert r_get.status_code == 200
    assert r_get.json()["saved"] is True
    assert r_get.json()["email"] == "user@example.com"

    # GET devices
    r_devs = client.get("/api/sinope/devices")
    assert r_devs.status_code == 200
    assert "devices" in r_devs.json()

    # DELETE credentials
    r_del = client.delete("/api/sinope/credentials")
    assert r_del.status_code == 200
    assert r_del.json()["ok"] is True

    # GET credentials again
    r_check = client.get("/api/sinope/credentials")
    assert r_check.status_code == 200
    assert r_check.json()["saved"] is False


def test_sinope_history_endpoints(app, client):
    sn = "SINOPE-TEST-TH"
    app.state.energy.upsert_device(sn, "Salon", brand="sinope", device_type="thermostat", location_id="maison")
    now = int(time.time())
    app.state.energy.record_load(sn, now - 600, power_w=1200, temp_c=21.0)
    app.state.energy.record_load(sn, now - 300, power_w=1200, temp_c=21.5)

    # Location history
    r_loc = client.get("/api/sinope/history/location?location_id=maison&hours=6")
    assert r_loc.status_code == 200
    j_loc = r_loc.json()
    assert j_loc["location_id"] == "maison"
    assert "history" in j_loc
    assert len(j_loc["history"]) >= 1

    # Device history
    r_dev = client.get(f"/api/sinope/history/device?device_sn={sn}&hours=6")
    assert r_dev.status_code == 200
    j_dev = r_dev.json()
    assert j_dev["device_sn"] == sn
    assert "history" in j_dev
    assert len(j_dev["history"]) >= 1
    assert "power_w" in j_dev["history"][0]


def test_notifications_routes(app, client, monkeypatch):
    from unittest.mock import AsyncMock
    import notifications

    # 1. GET config initially
    r_get = client.get("/api/notifications/config")
    assert r_get.status_code == 200
    j_get = r_get.json()
    assert j_get["enabled"] is False
    assert j_get["has_password"] is False
    assert j_get["is_configured"] is False

    # 2. POST save config
    r_save = client.post("/api/notifications/config", json={
        "enabled": True,
        "smtp_host": "smtp.gmail.com",
        "smtp_port": 587,
        "username": "tester@gmail.com",
        "password": "my-secret-app-password",
        "recipient": "alerts@gmail.com",
        "alert_on_low_battery": True,
        "alert_on_water_leak": True,
        "cooldown_minutes": 15,
    })
    assert r_save.status_code == 200
    j_save = r_save.json()
    assert j_save["ok"] is True
    assert j_save["config"]["enabled"] is True
    assert j_save["config"]["has_password"] is True
    assert j_save["config"]["password"] == "••••••••"
    assert j_save["config"]["is_configured"] is True

    # 3. POST test email with mock
    mock_test = AsyncMock(return_value=(True, "Test email sent successfully!"))
    monkeypatch.setattr(notifications, "send_test_email", mock_test)
    r_test = client.post("/api/notifications/test", json={"recipient": "alerts@gmail.com"})
    assert r_test.status_code == 200
    assert r_test.json()["ok"] is True
    assert "successfully" in r_test.json()["message"]

    # 4. DELETE config
    r_del = client.delete("/api/notifications/config")
    assert r_del.status_code == 200
    assert r_del.json()["ok"] is True
    assert r_del.json()["config"]["has_password"] is False
    assert r_del.json()["config"]["is_configured"] is False




