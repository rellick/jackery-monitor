import pytest
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

import auth
import crypto_util
import hilo_creds
import server


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    monkeypatch.setenv("JACKERY_HILO_CREDS_FILE", str(tmp_path / "hilo-creds.json"))
    monkeypatch.setattr(hilo_creds, "PATH", str(tmp_path / "hilo-creds.json"))
    monkeypatch.setattr(auth, "verify_session", lambda tok: {"u": "testuser"})

    server.state.hilo._cached_meters.clear()
    server.state.hilo._cached_devices.clear()
    server.state.hilo._cached_challenges.clear()
    server.state.hilo._sessions.clear()

    with TestClient(server.app) as c:
        c.cookies.set(auth.COOKIE_NAME, "valid_mock_token.sig")
        yield c


def test_hilo_credentials_routes(client):
    # 1. Initially no credentials saved
    res = client.get("/api/hilo/credentials")
    assert res.status_code == 200
    data = res.json()
    assert data["saved"] is False
    assert data["configured"] == []
    assert "maison" in data["locations"]
    assert data["locations"]["maison"]["saved"] is False

    # 2. Save credentials for Maison
    with patch.object(
        server.state.hilo,
        "test_credentials",
        new=AsyncMock(return_value={"ok": True, "locations": [{"id": 1}], "meter_count": 1}),
    ):
        with patch.object(
            server.state.hilo,
            "poll_location",
            new=AsyncMock(return_value={"meters": [], "devices": [], "challenges": []}),
        ):
            save_res = client.post(
                "/api/hilo/credentials",
                json={
                    "location_id": "maison",
                    "email": "maison@example.com",
                    "password": "secret_password",
                },
            )
            assert save_res.status_code == 200
            assert save_res.json()["ok"] is True
            assert save_res.json()["location_id"] == "maison"
            assert save_res.json()["email"] == "maison@example.com"

    # 3. Check credentials status
    status_res = client.get("/api/hilo/credentials")
    assert status_res.status_code == 200
    data2 = status_res.json()
    assert data2["saved"] is True
    assert "maison" in data2["configured"]
    assert data2["locations"]["maison"]["saved"] is True
    assert data2["locations"]["maison"]["email"] == "maison@example.com"

    # 4. Delete credentials for Maison
    del_res = client.delete("/api/hilo/credentials?location_id=maison")
    assert del_res.status_code == 200
    assert del_res.json()["ok"] is True

    status_res3 = client.get("/api/hilo/credentials")
    assert status_res3.json()["saved"] is False


def test_hilo_devices_and_poll_routes(client):
    # Seed cached smart meter
    server.state.hilo._cached_meters["maison"] = [
        {
            "device_sn": "hilo_meter_maison_001122334455",
            "name": "Compteur HQ — Maison",
            "location_id": "maison",
            "location_name": "Maison",
            "brand": "hilo",
            "device_type": "smart_meter",
            "power_w": 3200.0,
            "online": True,
            "zigbee_channel": 15,
            "mac": "00:11:22:33:44:55",
            "last_seen": 1728888888,
        }
    ]

    server.state.hilo._cached_challenges["maison"] = [
        {
            "location_id": "maison",
            "location_name": "Maison",
            "event_id": 99,
            "period": "PM",
            "progress": "scheduled",
            "is_participating": True,
            "baseline_kwh": 14.5,
            "current_kwh": 3.2,
            "reward": 6.75,
        }
    ]

    # 1. GET /api/hilo/devices
    res = client.get("/api/hilo/devices")
    assert res.status_code == 200
    data = res.json()
    assert len(data["meters"]) == 1
    assert data["meters"][0]["power_w"] == 3200.0
    assert len(data["challenges"]) == 1
    assert data["challenges"][0]["event_id"] == 99

    # 2. POST /api/hilo/poll
    mock_poll_res = {
        "meters": [
            {
                "device_sn": "hilo_meter_maison_001122334455",
                "name": "Compteur HQ — Maison",
                "location_id": "maison",
                "location_name": "Maison",
                "brand": "hilo",
                "device_type": "smart_meter",
                "power_w": 2850.0,
                "online": True,
            }
        ],
        "devices": [],
        "challenges": [],
    }

    with patch.object(server.state.hilo, "poll_location", new=AsyncMock(return_value=mock_poll_res)):
        poll_res = client.post("/api/hilo/poll?location_id=maison")
        assert poll_res.status_code == 200
        poll_data = poll_res.json()
        assert len(poll_data["meters"]) == 1
        assert poll_data["meters"][0]["power_w"] == 2850.0


def test_hilo_meter_history_route(client):
    sn = "hilo_meter_maison_test"
    # Record a test sample in energy DB
    server.state.energy.record_load(device_sn=sn, ts=1728880000, power_w=2500.0)

    res = client.get(f"/api/hilo/history/meter?device_sn={sn}&hours=24")
    assert res.status_code == 200
    data = res.json()
    assert data["device_sn"] == sn
    assert "history" in data
