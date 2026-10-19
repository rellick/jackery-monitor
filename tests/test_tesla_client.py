import pytest
from unittest.mock import AsyncMock, patch
import httpx
from tesla_client import TeslaClient, haversine_distance_m
import tesla_creds


def test_haversine_distance():
    # Distance between two known points in McMasterville
    d = haversine_distance_m(45.5500, -73.2658, 45.5500, -73.2658)
    assert d == pytest.approx(0.0, abs=1.0)

    # 0.01 deg lat is ~1.11 km
    d2 = haversine_distance_m(45.5500, -73.2658, 45.5600, -73.2658)
    assert 1100 < d2 < 1130


@pytest.mark.asyncio
async def test_poll_wall_connector_success():
    client = TeslaClient()

    vitals_resp = {
        "contactor_closed": True,
        "vehicle_connected": True,
        "session_s": 3600,
        "grid_v": 240.5,
        "grid_hz": 60.01,
        "vehicle_current_a": 48.0,
        "session_energy_wh": 11500.0,
        "handle_temp_c": 22.5,
        "pcba_temp_c": 31.0,
        "evse_state": 4,
    }
    version_resp = {
        "serial_number": "B7S24137J01422",
        "firmware_version": "26.34.0",
    }
    lifetime_resp = {
        "energy_wh": 7500000.0,
    }

    async def mock_get(self, url, *args, **kwargs):
        if "/api/1/vitals" in str(url):
            return httpx.Response(200, json=vitals_resp)
        if "/api/1/version" in str(url):
            return httpx.Response(200, json=version_resp)
        if "/api/1/lifetime" in str(url):
            return httpx.Response(200, json=lifetime_resp)
        return httpx.Response(404)

    with patch.object(httpx.AsyncClient, "get", new=mock_get):
        dev = await client.poll_wall_connector("192.168.86.41", "maison")
        assert dev["online"] is True
        assert dev["device_sn"] == "tesla_twc_maison"
        assert dev["serial_number"] == "B7S24137J01422"
        assert dev["is_charging"] is True
        assert dev["grid_v"] == 240.5
        assert dev["current_a"] == 48.0
        assert dev["power_w"] == pytest.approx(11544.0, abs=1.0)
        assert dev["session_energy_wh"] == 11500.0
        assert dev["lifetime_energy_wh"] == 7500000.0
        assert dev["handle_temp_c"] == 22.5


@pytest.mark.asyncio
async def test_tesla_token_refresh_and_rotation(tmp_path, monkeypatch):
    import crypto_util
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    monkeypatch.setattr(tesla_creds, "PATH", str(tmp_path / "tesla-creds.json"))

    tesla_creds.save(
        refresh_token="initial_refresh_token_123",
        client_id="ownerapi",
    )

    client = TeslaClient()
    posted_data = {}

    async def mock_post(self, url, *args, **kwargs):
        nonlocal posted_data
        if "oauth2/v3/token" in str(url):
            posted_data = kwargs.get("data") or {}
            return httpx.Response(
                200,
                json={
                    "access_token": "fresh_access_token_456",
                    "refresh_token": "rotated_refresh_token_789",
                    "expires_in": 28800,
                    "token_type": "Bearer",
                },
            )
        return httpx.Response(404)

    with patch.object(httpx.AsyncClient, "post", new=mock_post):
        tok = await client.get_valid_access_token()
        assert tok == "fresh_access_token_456"
        assert posted_data.get("audience") == "https://fleet-api.prd.na.vn.cloud.tesla.com"

        # Verify rotated tokens persisted in credentials file
        loaded = tesla_creds.load()
        assert loaded["access_token"] == "fresh_access_token_456"
        assert loaded["refresh_token"] == "rotated_refresh_token_789"


@pytest.mark.asyncio
async def test_test_credentials_with_direct_access_token(tmp_path, monkeypatch):
    import crypto_util
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    monkeypatch.setattr(tesla_creds, "PATH", str(tmp_path / "tesla-creds.json"))

    client = TeslaClient()

    async def mock_get(self, url, *args, **kwargs):
        if "/api/1/vitals" in str(url):
            return httpx.Response(200, json={"grid_v": 240.0, "vehicle_connected": True, "contactor_closed": False})
        if "/api/1/vehicles" in str(url):
            headers = kwargs.get("headers") or {}
            if "Bearer valid_direct_jwt" in headers.get("Authorization", ""):
                return httpx.Response(200, json={"response": [{"vin": "5YJ3123456", "display_name": "My Model Y"}]})
            return httpx.Response(401)
        return httpx.Response(404)

    with patch.object(httpx.AsyncClient, "get", new=mock_get):
        res = await client.test_credentials(
            access_token="valid_direct_jwt",
            refresh_token="my_refresh_tok",
            maison_twc_ip="192.168.86.41",
        )
        assert res["wall_connector"]["ok"] is True
        assert res["tesla_api"]["ok"] is True
        assert res["tesla_api"]["vehicle_count"] == 1
        assert "My Model Y" in res["tesla_api"]["vehicles"]


@pytest.mark.asyncio
async def test_poll_tesla_api_and_infer_mobile_connector_at_maison():
    client = TeslaClient()

    # Pre-cache Maison Wall Connector with contactor OPEN (not charging)
    client._cached_wall_connectors["maison"] = {
        "contactor_closed": False,
        "power_w": 0.0,
        "vehicle_connected": False,
    }

    # Model Y parked at Maison coordinates (45.55008, -73.26585)
    # Charging at 120V / 12A (1.4 kW)
    vehicle_data_resp = {
        "response": {
            "vin": "5YJ3E1EB1NF123456",
            "state": "online",
            "charge_state": {
                "battery_level": 65,
                "battery_range": 200.0,
                "charging_state": "Charging",
                "charger_power": 1.4,
                "charger_voltage": 120.0,
                "charger_actual_current": 12.0,
                "charge_energy_added": 5.2,
                "time_to_full_charge": 8.5,
                "fast_charger_present": False,
            },
            "drive_state": {
                "latitude": 45.55010,
                "longitude": -73.26580,
            },
            "vehicle_state": {
                "odometer": 30000.0,
                "locked": True,
            },
        }
    }

    async def mock_get(self, url, *args, **kwargs):
        if "/api/1/vehicles/5YJ3E1EB1NF123456/vehicle_data" in str(url):
            return httpx.Response(200, json=vehicle_data_resp)
        if "/api/1/vehicles" in str(url):
            return httpx.Response(200, json={"response": [{"vin": "5YJ3E1EB1NF123456", "display_name": "Model Y", "state": "online"}]})
        return httpx.Response(404)

    with patch("location.get", return_value={"latitude": 45.55008, "longitude": -73.26585}):
        with patch.object(client, "get_valid_access_token", new=AsyncMock(return_value="valid_mock_token")):
            with patch.object(httpx.AsyncClient, "get", new=mock_get):
                vehs = await client.poll_tesla_api()
                assert len(vehs) == 1
                v = vehs[0]
                assert v["name"] == "Model Y"
                assert v["is_charging"] is True
                assert v["battery_level"] == 65
                assert v["location_id"] == "maison"
                # Inferred as Mobile Connector 120V because car is at Maison but Wall Connector is not active
                assert v["charger_type"] == "mobile_connector"
                assert "120V" in v["charger_name"]


@pytest.mark.asyncio
async def test_poll_tesla_api_vehicle_asleep_preserves_state_without_waking():
    client = TeslaClient()

    # Seed cache with known state
    client._cached_vehicles = [
        {
            "vin": "5YJ3E1EB1NF123456",
            "name": "Model Y",
            "battery_level": 75,
            "battery_range_km": 300.0,
            "charging_state": "Disconnected",
            "is_charging": False,
            "location_id": "maison",
        }
    ]

    called_vehicle_data = False

    async def mock_get(self, url, *args, **kwargs):
        nonlocal called_vehicle_data
        if "/api/1/vehicles/5YJ3E1EB1NF123456/vehicle_data" in str(url):
            called_vehicle_data = True
            return httpx.Response(200, json={})
        if "/api/1/vehicles" in str(url):
            return httpx.Response(200, json={"response": [{"vin": "5YJ3E1EB1NF123456", "display_name": "Model Y", "state": "asleep"}]})
        return httpx.Response(404)

    with patch.object(client, "get_valid_access_token", new=AsyncMock(return_value="valid_mock_token")):
        with patch.object(httpx.AsyncClient, "get", new=mock_get):
            vehs = await client.poll_tesla_api()
            assert len(vehs) == 1
            v = vehs[0]
            assert v["is_asleep"] is True
            assert v["online"] is False
            assert v["battery_level"] == 75
            # Crucial: vehicle_data endpoint was NOT called, vehicle was not woken up!
            assert called_vehicle_data is False


@pytest.mark.asyncio
async def test_infer_wall_connector_at_chalet():
    client = TeslaClient()

    vehicle_data_resp = {
        "response": {
            "vin": "5YJ3E1EB1NF123456",
            "state": "online",
            "charge_state": {
                "battery_level": 82,
                "battery_range": 260.0,
                "charging_state": "Charging",
                "charger_power": 11.5,
                "charger_voltage": 240.0,
                "charger_actual_current": 48.0,
                "charge_energy_added": 14.0,
                "time_to_full_charge": 1.0,
                "fast_charger_present": False,
            },
            "drive_state": {
                "latitude": 46.1201,
                "longitude": -74.1502,
            },
        }
    }

    async def mock_get(self, url, *args, **kwargs):
        if "/api/1/vehicles/5YJ3E1EB1NF123456/vehicle_data" in str(url):
            return httpx.Response(200, json=vehicle_data_resp)
        if "/api/1/vehicles" in str(url):
            return httpx.Response(200, json={"response": [{"vin": "5YJ3E1EB1NF123456", "display_name": "Model Y", "state": "online"}]})
        return httpx.Response(404)

    with patch("tesla_creds.load", return_value={
        "chalet_lat": 46.1200,
        "chalet_lon": -74.1500,
        "geofences": {"chalet": {"lat": 46.1200, "lon": -74.1500, "radius_m": 350.0}},
    }):
        with patch.object(client, "get_valid_access_token", new=AsyncMock(return_value="valid_mock_token")):
            with patch.object(httpx.AsyncClient, "get", new=mock_get):
                vehs = await client.poll_tesla_api()
                assert len(vehs) == 1
                v = vehs[0]
                assert v["location_id"] == "chalet"
                assert v["charger_type"] == "wall_connector"
                assert "Chalet" in v["charger_name"]


@pytest.mark.asyncio
async def test_variable_charge_rate_adaptation(tmp_path):
    """Validate that power and energy reporting dynamically adapt to any requested charge rate."""
    from energy_db import EnergyDB

    client = TeslaClient()
    db = EnergyDB(str(tmp_path / "test_energy.db"))

    # Test 1: Wall Connector line voltage & dynamic current variations
    # 48A -> 32A -> 16A (e.g. BMS taper or app limit adjustment)
    rates = [
        (240.0, 48.0, 11520.0),
        (238.0, 32.0, 7616.0),
        (240.0, 16.0, 3840.0),
        (120.0, 12.0, 1440.0),  # Level 1 Mobile Connector
    ]

    import time
    base_ts = time.time() - 240.0

    for i, (v, a, expected_w) in enumerate(rates):
        state_data = {
            "charge_state": {
                "charging_state": "Charging",
                "charger_voltage": v,
                "charger_actual_current": a,
                "charger_power": expected_w / 1000.0,
                "battery_level": 50 + i * 10,
            },
            "drive_state": {"latitude": 45.5, "longitude": -73.5},
            "vehicle_state": {},
        }
        veh = client._normalize_vehicle("TESTVIN123456789", "Model Y", state_data, int(base_ts + i * 60))
        assert veh["power_w"] == pytest.approx(expected_w, abs=0.5)

        # Record into energy DB and verify Wh integration
        db.record_tesla_device("tesla_vehicle_56789", base_ts + i * 60, veh)

    # Verify history query returns dynamic variable power records
    history = db.history("tesla_vehicle_56789", hours=1, bucket_s=60)
    assert len(history) > 0
    powers = [h["output_w"] for h in history if h.get("output_w", 0) > 0]
    assert len(powers) >= 3

