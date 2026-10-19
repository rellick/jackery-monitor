import pytest
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

import auth
import crypto_util
import midea_creds
import server


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    monkeypatch.setenv("JACKERY_MIDEA_CREDS_FILE", str(tmp_path / "midea-creds.json"))
    monkeypatch.setattr(midea_creds, "PATH", str(tmp_path / "midea-creds.json"))
    monkeypatch.setattr(auth, "verify_session", lambda tok: {"u": "testuser"})

    server.state.midea._cached_devices.clear()

    with TestClient(server.app) as c:
        c.cookies.set(auth.COOKIE_NAME, "valid_mock_token.sig")
        yield c


def test_midea_credentials_routes(client):
    # 1. Initially no credentials saved
    res = client.get("/api/midea/credentials")
    assert res.status_code == 200
    data = res.json()
    assert data["has_credentials"] is False
    assert data["configured_locations"] == []

    # 2. Save credentials for Maison with fallback to NetHome Plus
    with patch.object(
        server.state.midea,
        "test_credentials",
        new=AsyncMock(return_value={"ok": True, "device_count": 2, "app_name": "NetHome Plus"}),
    ):
        with patch.object(
            server.state.midea,
            "poll_all_locations",
            new=AsyncMock(return_value=[]),
        ):
            save_res = client.post(
                "/api/midea/credentials",
                json={
                    "location_id": "maison",
                    "email": "user@example.com",
                    "password": "secretpassword",
                    "app_name": "MSmartHome",
                },
            )
            assert save_res.status_code == 200
            assert save_res.json()["ok"] is True
            assert save_res.json()["location_id"] == "maison"
            assert save_res.json()["app_name"] == "NetHome Plus"

    # 3. Check credentials status
    status_res = client.get("/api/midea/credentials")
    assert status_res.status_code == 200
    data2 = status_res.json()
    assert data2["has_credentials"] is True
    assert "maison" in data2["configured_locations"]
    assert data2["locations"]["maison"]["configured"] is True
    assert data2["locations"]["maison"]["email"] == "user@example.com"
    assert data2["locations"]["maison"]["app_name"] == "NetHome Plus"

    # 4. Delete credentials for Maison
    del_res = client.delete("/api/midea/credentials?location_id=maison")
    assert del_res.status_code == 200
    assert del_res.json()["ok"] is True

    status_res3 = client.get("/api/midea/credentials")
    assert status_res3.json()["has_credentials"] is False


def test_midea_devices_and_poll_routes(client):
    server.state.midea._cached_devices = [
        {
            "device_id": "12345",
            "device_sn": "midea_12345",
            "name": "Danby Dehumidifier Sous-sol",
            "model": "DDR050",
            "power": True,
            "current_humidity": 55,
            "target_humidity": 45,
            "tank_full": False,
            "fan_speed": 60,
            "mode": 1,
            "location_id": "maison",
            "online": True,
        }
    ]

    # GET /api/midea/devices
    devs_res = client.get("/api/midea/devices")
    assert devs_res.status_code == 200
    data = devs_res.json()
    assert len(data["devices"]) == 1
    assert data["devices"][0]["name"] == "Danby Dehumidifier Sous-sol"
    assert data["devices"][0]["current_humidity"] == 55

    # POST /api/midea/poll
    mock_poll = [
        {
            "device_id": "12345",
            "device_sn": "midea_12345",
            "name": "Danby Dehumidifier Sous-sol",
            "model": "DDR050",
            "power": True,
            "current_humidity": 52,
            "target_humidity": 45,
            "tank_full": False,
            "fan_speed": 60,
            "mode": 1,
            "location_id": "maison",
            "online": True,
        }
    ]
    with patch.object(server.state.midea, "poll_all_locations", new=AsyncMock(return_value=mock_poll)):
        poll_res = client.post("/api/midea/poll")
        assert poll_res.status_code == 200
        assert len(poll_res.json()["devices"]) == 1
        assert poll_res.json()["devices"][0]["current_humidity"] == 52


def test_midea_control_and_location_routes(client):
    with patch.object(
        server.state.midea,
        "control_device",
        new=AsyncMock(return_value={"device_id": "12345", "power": True, "target_humidity": 50}),
    ):
        ctl_res = client.post(
            "/api/midea/device/12345/control",
            json={"power": True, "target_humidity": 50},
        )
        assert ctl_res.status_code == 200
        assert ctl_res.json()["power"] is True
        assert ctl_res.json()["target_humidity"] == 50

    # Test set location route
    loc_res = client.post(
        "/api/midea/device/12345/location",
        json={"location_id": "chalet"},
    )
    assert loc_res.status_code == 200
    assert loc_res.json()["ok"] is True
    assert loc_res.json()["location_id"] == "chalet"


def test_midea_history_and_schedule_routes(client, tmp_path, monkeypatch):
    import midea_schedule
    monkeypatch.setattr(midea_schedule, "SCHEDULES_FILE", str(tmp_path / "midea-sched.json"))

    # 1. Device history route
    hist_res = client.get("/api/midea/history/device?device_sn=midea_12345&hours=24")
    assert hist_res.status_code == 200
    h_data = hist_res.json()
    assert h_data["device_sn"] == "midea_12345"
    assert "summary" in h_data
    assert "history" in h_data

    # 2. Get schedule route (initial default)
    get_res = client.get("/api/midea/device/12345/schedule")
    assert get_res.status_code == 200
    s_data = get_res.json()
    assert s_data["device_id"] == "12345"
    assert s_data["timezone"] == "America/Toronto"
    assert s_data["schedule_enabled"] is False

    # 3. Put schedule route
    put_res = client.put(
        "/api/midea/device/12345/schedule",
        json={
            "timezone": "America/Montreal",
            "schedule_enabled": True,
            "events": [
                {
                    "name": "Day",
                    "days": [1, 2, 3, 4, 5],
                    "time": "09:00",
                    "power": True,
                    "target_humidity": 45,
                }
            ],
        },
    )
    assert put_res.status_code == 200
    saved = put_res.json()
    assert saved["timezone"] == "America/Montreal"
    assert saved["schedule_enabled"] is True
    assert len(saved["events"]) == 1

    # 4. Verify get returns the updated schedule
    get_res2 = client.get("/api/midea/device/12345/schedule")
    assert get_res2.status_code == 200
    assert get_res2.json()["timezone"] == "America/Montreal"
    assert get_res2.json()["schedule_enabled"] is True

