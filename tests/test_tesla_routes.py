import pytest
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

import auth
import crypto_util
import tesla_creds
import server


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    monkeypatch.setattr(tesla_creds, "PATH", str(tmp_path / "tesla-creds.json"))
    monkeypatch.setattr(auth, "verify_session", lambda tok: {"u": "testuser"})

    server.state.tesla._cached_wall_connectors.clear()
    server.state.tesla._cached_vehicles.clear()

    with TestClient(server.app) as c:
        c.cookies.set(auth.COOKIE_NAME, "valid_mock_token.sig")
        yield c


def test_tesla_credentials_and_devices_routes(client):
    # 1. Get credentials initially
    res = client.get("/api/tesla/credentials")
    assert res.status_code == 200
    data = res.json()
    assert data["saved"] is True  # default Maison TWC IP
    assert data["maison_twc_ip"] == tesla_creds.DEFAULT_MAISON_TWC_IP
    assert data["has_tesla_auth"] is False
    assert data["has_refresh_token"] is False
    assert data["has_access_token"] is False

    # 2. Save credentials
    with patch.object(
        server.state.tesla,
        "test_credentials",
        new=AsyncMock(return_value={"wall_connector": {"ok": True}, "tesla_api": {"ok": True, "vehicle_count": 1}}),
    ):
        with patch.object(
            server.state.tesla,
            "poll_all",
            new=AsyncMock(return_value=[
                {
                    "device_id": "twc_B7S24137J01422",
                    "device_sn": "tesla_twc_maison",
                    "name": "Wall Connector (Maison)",
                    "device_type": "ev_charger",
                    "location_id": "maison",
                    "power_w": 11500.0,
                    "is_charging": True,
                }
            ]),
        ):
            save_res = client.post(
                "/api/tesla/credentials",
                json={
                    "access_token": "test_access_jwt_123",
                    "refresh_token": "test_refresh_123456",
                    "client_id": "ownerapi",
                    "maison_twc_ip": "192.168.86.41",
                    "chalet_lat": 46.12,
                    "chalet_lon": -74.15,
                },
            )
            assert save_res.status_code == 200
            save_data = save_res.json()
            assert save_data["ok"] is True
            assert save_data["test"]["wall_connector"]["ok"] is True
            assert save_data["test"]["tesla_api"]["ok"] is True

    # Verify updated creds endpoint
    updated = client.get("/api/tesla/credentials").json()
    assert updated["has_access_token"] is True
    assert updated["has_refresh_token"] is True

    # 3. Get devices
    server.state.tesla._cached_wall_connectors["maison"] = {
        "device_sn": "tesla_twc_maison",
        "name": "Wall Connector (Maison)",
        "device_type": "ev_charger",
        "power_w": 11500.0,
        "is_charging": True,
    }
    dev_res = client.get("/api/tesla/devices")
    assert dev_res.status_code == 200
    assert dev_res.json()["count"] == 1

    # 4. History endpoint
    hist_res = client.get("/api/tesla/history/device?device_sn=tesla_twc_maison&hours=1")
    assert hist_res.status_code == 200
    assert hist_res.json()["device_sn"] == "tesla_twc_maison"
    assert "history" in hist_res.json()

    # 5. Clear credentials
    del_res = client.delete("/api/tesla/credentials")
    assert del_res.status_code == 200
    assert del_res.json()["ok"] is True


def test_tesla_wake_vehicle_route(client):
    mock_veh = {
        "device_sn": "tesla_vehicle_123456",
        "vin": "5YJ3E1EB1NF123456",
        "name": "Model Y",
        "device_type": "ev_vehicle",
        "location_id": "maison",
        "battery_level": 76,
        "is_asleep": False,
        "online": True,
    }

    with patch.object(server.state.tesla, "wake_vehicle", new=AsyncMock(return_value=mock_veh)):
        res = client.post("/api/tesla/vehicle/5YJ3E1EB1NF123456/wake")
        assert res.status_code == 200
        data = res.json()
        assert data["ok"] is True
        assert data["vehicle"]["battery_level"] == 76

    with patch.object(server.state.tesla, "wake_vehicle", new=AsyncMock(return_value=None)):
        res = client.post("/api/tesla/vehicle/5YJ3E1EB1NF123456/wake")
        assert res.status_code == 504

