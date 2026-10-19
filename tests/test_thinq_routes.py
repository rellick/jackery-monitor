import pytest
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

import auth
import crypto_util
import thinq_creds
import server


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    monkeypatch.setenv("JACKERY_THINQ_CREDS_FILE", str(tmp_path / "thinq-creds.json"))
    monkeypatch.setattr(thinq_creds, "PATH", str(tmp_path / "thinq-creds.json"))
    monkeypatch.setattr(auth, "verify_session", lambda tok: {"u": "testuser"})

    server.state.thinq._cached_devices.clear()

    with TestClient(server.app) as c:
        c.cookies.set(auth.COOKIE_NAME, "valid_mock_token.sig")
        yield c


def test_thinq_credentials_routes(client):
    # 1. Initially no credentials saved
    res = client.get("/api/thinq/credentials")
    assert res.status_code == 200
    data = res.json()
    assert data["saved"] is False
    assert data["configured"] == []
    assert "maison" in data["locations"]
    assert data["locations"]["maison"]["saved"] is False

    # 2. Save credentials for Maison
    with patch.object(
        server.state.thinq,
        "test_credentials",
        new=AsyncMock(return_value={"ok": True, "device_count": 2, "devices": []}),
    ):
        with patch.object(
            server.state.thinq,
            "poll_location",
            new=AsyncMock(return_value=[]),
        ):
            save_res = client.post(
                "/api/thinq/credentials",
                json={
                    "location_id": "maison",
                    "token": "test_pat_token_123456",
                    "country": "CA",
                },
            )
            assert save_res.status_code == 200
            assert save_res.json()["ok"] is True
            assert save_res.json()["location_id"] == "maison"
            assert save_res.json()["country"] == "CA"
            assert save_res.json()["device_count"] == 2

    # 3. Check credentials status
    status_res = client.get("/api/thinq/credentials")
    assert status_res.status_code == 200
    data2 = status_res.json()
    assert data2["saved"] is True
    assert "maison" in data2["configured"]
    assert data2["locations"]["maison"]["saved"] is True
    assert data2["locations"]["maison"]["country"] == "CA"
    assert data2["locations"]["maison"]["masked_token"] == "...123456"

    # 4. Delete credentials for Maison
    del_res = client.delete("/api/thinq/credentials?location_id=maison")
    assert del_res.status_code == 200
    assert del_res.json()["ok"] is True

    status_res3 = client.get("/api/thinq/credentials")
    assert status_res3.json()["saved"] is False


def test_thinq_devices_and_poll_routes(client):
    # Seed cached appliance
    server.state.thinq._cached_devices["maison"] = [
        {
            "device_sn": "thinq_maison_dev_wash_01",
            "device_id": "dev_wash_01",
            "name": "Front Load Washer",
            "location_id": "maison",
            "location_name": "Maison",
            "brand": "thinq",
            "device_type": "WASHER",
            "category": "laundry",
            "is_running": True,
            "cycle_state": "RUNNING",
            "step": "SPIN",
            "remain_time_min": 24,
            "door_lock": True,
            "online": True,
        }
    ]

    # GET /api/thinq/devices
    devs_res = client.get("/api/thinq/devices")
    assert devs_res.status_code == 200
    data = devs_res.json()
    assert len(data["devices"]) == 1
    assert data["devices"][0]["name"] == "Front Load Washer"
    assert data["devices"][0]["category"] == "laundry"
    assert data["devices"][0]["remain_time_min"] == 24

    # POST /api/thinq/poll
    mock_poll = [
        {
            "device_sn": "thinq_maison_dev_fridge_01",
            "device_id": "dev_fridge_01",
            "name": "Smart InstaView Refrigerator",
            "location_id": "maison",
            "location_name": "Maison",
            "brand": "thinq",
            "device_type": "REFRIGERATOR",
            "category": "refrigeration",
            "is_running": True,
            "fridge_temp_c": 3.0,
            "freezer_temp_c": -18.0,
            "door_open": False,
            "express_freeze": False,
            "online": True,
        }
    ]
    with patch.object(server.state.thinq, "poll_location", new=AsyncMock(return_value=mock_poll)):
        poll_res = client.post("/api/thinq/poll?location_id=maison")
        assert poll_res.status_code == 200
        assert len(poll_res.json()["devices"]) == 1
        assert poll_res.json()["devices"][0]["device_id"] == "dev_fridge_01"


def test_thinq_control_route(client):
    with patch.object(
        server.state.thinq,
        "control_device",
        new=AsyncMock(return_value={"ok": True, "response": {"result": "success"}}),
    ):
        with patch.object(
            server.state.thinq,
            "poll_location",
            new=AsyncMock(return_value=[]),
        ):
            ctl_res = client.post(
                "/api/thinq/device/dev_fridge_01/control",
                json={
                    "location_id": "maison",
                    "payload": {"refrigeration": {"expressFreeze": "START"}},
                },
            )
            assert ctl_res.status_code == 200
            assert ctl_res.json()["ok"] is True


def test_thinq_device_history_route(client):
    sn = "thinq_maison_test_oven_hist"
    now = 1700000000
    norm_oven = {
        "category": "cooking",
        "online": True,
        "is_cooking": True,
        "run_state": "PREHEATING",
        "current_temp_c": 120.0,
        "target_temp_c": 180.0,
        "sub_zones": [
            {
                "id": "UPPER",
                "name": "Upper Cavity",
                "zone_type": "cavity",
                "power_level": 0,
                "state": "PREHEATING",
                "target_temp_c": 180.0,
                "current_temp_c": 120.0,
                "is_active": True,
            }
        ],
    }
    server.state.energy.record_thinq_appliance(sn, now, norm_oven)

    # Fetch history with hours=1000000 to cover epoch 1700000000
    with patch("time.time", return_value=now + 300):
        res = client.get(f"/api/thinq/history/device?device_sn={sn}&hours=24")
        assert res.status_code == 200
        data = res.json()
        assert data["device_sn"] == sn
        assert len(data["history"]) >= 1
        h = data["history"][-1]
        assert h["power_w"] > 0
        assert "Upper Cavity" in (h.get("state_json") or "")
