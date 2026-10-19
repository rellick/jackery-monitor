import os
import pytest
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

import daikin_creds
import crypto_util
import auth
import server


@pytest.fixture
def client(tmp_path, monkeypatch):
    import daikin_client
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    monkeypatch.setenv("JACKERY_DAIKIN_CREDS_FILE", str(tmp_path / "daikin-creds.json"))
    monkeypatch.setattr(daikin_creds, "PATH", str(tmp_path / "daikin-creds.json"))
    monkeypatch.setattr(daikin_client, "AIRCLEAN_PATH", tmp_path / "daikin-airclean.json")
    monkeypatch.setattr(auth, "verify_session", lambda tok: {"u": "testuser"})
    server.state.daikin._cached_devices.clear()
    server.state.daikin._air_clean_jobs.clear()
    server.state.daikin._air_clean_tasks.clear()
    with TestClient(server.app) as c:
        c.cookies.set(auth.COOKIE_NAME, "valid_mock_token.sig")
        yield c


def test_daikin_credentials_routes(client):
    # 1. Initially no creds
    res = client.get("/api/daikin/credentials")
    assert res.status_code == 200
    data = res.json()
    assert data["saved"] is False
    assert data["email"] is None

    # 2. Save creds (mock test_credentials)
    with patch.object(
        server.state.daikin,
        "test_credentials",
        new=AsyncMock(return_value={"ok": True, "locations": ["Maison"], "device_count": 1}),
    ):
        with patch.object(
            server.state.daikin,
            "poll_all_devices",
            new=AsyncMock(return_value=[]),
        ):
            save_res = client.post(
                "/api/daikin/credentials",
                json={
                    "email": "owner@example.com",
                    "integrator_token": "token123",
                    "api_key": "key456",
                },
            )
            assert save_res.status_code == 200
            assert save_res.json()["ok"] is True
            assert save_res.json()["email"] == "owner@example.com"

    # 3. Check credentials status
    status_res = client.get("/api/daikin/credentials")
    assert status_res.status_code == 200
    assert status_res.json()["saved"] is True
    assert status_res.json()["email"] == "owner@example.com"
    assert status_res.json()["has_api_key"] is True

    # 4. Delete credentials
    del_res = client.delete("/api/daikin/credentials")
    assert del_res.status_code == 200
    assert del_res.json()["ok"] is True

    status_res2 = client.get("/api/daikin/credentials")
    assert status_res2.json()["saved"] is False


def test_daikin_devices_and_control_routes(client):
    # Seed a cached device
    server.state.daikin._cached_devices["dev-100"] = {
        "id": "dev-100",
        "device_sn": "daikin_dev-100",
        "name": "Living Room",
        "brand": "daikin",
        "device_type": "thermostat",
        "model": "ONEPLUS",
        "location_id": "maison",
        "location_name": "Maison",
        "is_online": True,
        "temp_indoor_c": 21.0,
        "temp_outdoor_c": 10.0,
        "hum_indoor": 45.0,
        "hum_outdoor": 60.0,
        "equipment_status": 5,
        "equipment_status_desc": "Idle",
        "mode": 1,
        "mode_desc": "heat",
        "heat_setpoint_c": 21.0,
        "cool_setpoint_c": 24.0,
        "setpoint_delta": 2.0,
        "setpoint_min": 10.0,
        "setpoint_max": 32.0,
        "schedule_enabled": False,
        "fan_circulate": 0,
        "fan_circulate_speed": 0,
        "power_w": 0.0,
    }

    # 1. GET /api/daikin/devices
    res = client.get("/api/daikin/devices")
    assert res.status_code == 200
    devs = res.json()["devices"]
    assert len(devs) == 1
    assert devs[0]["id"] == "dev-100"

    # 2. PUT /api/daikin/device/{id}/msp
    with patch.object(
        server.state.daikin,
        "set_msp",
        new=AsyncMock(return_value={"ok": True, "payload": {"mode": 1, "heatSetpoint": 22.0, "coolSetpoint": 25.0}}),
    ):
        msp_res = client.put(
            "/api/daikin/device/dev-100/msp",
            json={"mode": 1, "heat_setpoint": 22.0, "cool_setpoint": 25.0},
        )
        assert msp_res.status_code == 200
        assert msp_res.json()["ok"] is True

    # 3. PUT /api/daikin/device/{id}/schedule
    with patch.object(
        server.state.daikin,
        "set_schedule",
        new=AsyncMock(return_value={"ok": True, "schedule_enabled": True}),
    ):
        sched_res = client.put(
            "/api/daikin/device/dev-100/schedule",
            json={"schedule_enabled": True},
        )
        assert sched_res.status_code == 200
        assert sched_res.json()["schedule_enabled"] is True

    # 4. PUT /api/daikin/device/{id}/fan
    with patch.object(
        server.state.daikin,
        "set_fan",
        new=AsyncMock(return_value={"ok": True, "payload": {"fanCirculate": 1, "fanCirculateSpeed": 1}}),
    ):
        fan_res = client.put(
            "/api/daikin/device/dev-100/fan",
            json={"fan_circulate": 1, "fan_circulate_speed": 1},
        )
        assert fan_res.status_code == 200
        assert fan_res.json()["ok"] is True


def test_daikin_air_clean_routes(client):
    server.state.daikin._cached_devices["dev-100"] = {
        "id": "dev-100",
        "device_sn": "daikin_dev-100",
        "name": "Living Room",
        "brand": "daikin",
        "device_type": "thermostat",
        "fan_circulate": 0,
        "fan_circulate_speed": 0,
    }

    # 1. Start Air Clean
    with patch.object(
        server.state.daikin,
        "set_fan",
        new=AsyncMock(return_value={"ok": True}),
    ):
        post_res = client.post(
            "/api/daikin/device/dev-100/air-clean",
            json={"duration_s": 10800},
        )
        assert post_res.status_code == 200
        data = post_res.json()
        assert data["ok"] is True
        assert data["air_clean"]["active"] is True
        assert data["air_clean"]["previous_fan_circulate"] == 0

        # 2. Check that GET /api/daikin/devices includes air_clean state
        get_res = client.get("/api/daikin/devices")
        assert get_res.status_code == 200
        devs = get_res.json()["devices"]
        assert len(devs) == 1
        assert devs[0]["air_clean"]["active"] is True

        # 3. Stop Air Clean
        del_res = client.delete("/api/daikin/device/dev-100/air-clean")
        assert del_res.status_code == 200
        assert del_res.json()["ok"] is True
        assert del_res.json()["air_clean"]["active"] is False


def test_daikin_fan_override_cancels_air_clean(client):
    server.state.daikin._cached_devices["dev-100"] = {
        "id": "dev-100",
        "device_sn": "daikin_dev-100",
        "name": "Living Room",
        "brand": "daikin",
        "device_type": "thermostat",
        "fan_circulate": 0,
        "fan_circulate_speed": 0,
    }

    with patch.object(
        server.state.daikin,
        "set_fan",
        new=AsyncMock(return_value={"ok": True}),
    ):
        # Start Air Clean
        client.post("/api/daikin/device/dev-100/air-clean", json={"duration_s": 10800})
        assert server.state.daikin.get_air_clean_state("dev-100")["active"] is True

        # User manually adjusts fan -> Air Clean should be cancelled
        fan_res = client.put(
            "/api/daikin/device/dev-100/fan",
            json={"fan_circulate": 2, "fan_circulate_speed": 0},
        )
        assert fan_res.status_code == 200
        assert server.state.daikin.get_air_clean_state("dev-100")["active"] is False
