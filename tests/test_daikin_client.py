import os
import tempfile
import pytest
from unittest.mock import AsyncMock, patch

from daikin_client import (
    DaikinClient,
    DaikinConfigError,
    DaikinTransientError,
)
import daikin_client
import daikin_creds
import crypto_util
from pathlib import Path


@pytest.fixture(autouse=True)
def temp_creds(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        kp = os.path.join(td, ".key")
        cp = os.path.join(td, "daikin-creds.json")
        acp = os.path.join(td, "daikin-airclean.json")
        monkeypatch.setattr(crypto_util, "KEY_PATH", kp)
        monkeypatch.setattr(daikin_creds, "PATH", cp)
        monkeypatch.setattr(daikin_client, "AIRCLEAN_PATH", Path(acp))
        yield


def test_daikin_format_device():
    client = DaikinClient()
    raw_meta = {
        "id": "dev-daikin-01",
        "name": "Main Thermostat",
        "model": "ONEPLUS",
        "firmwareVersion": "2.3.5",
    }
    raw_attrs = {
        "equipmentStatus": 3,  # heating
        "mode": 1,             # heat
        "modeLimit": 1,
        "modeEmHeatAvailable": 0,
        "fan": 0,
        "fanCirculate": 1,
        "fanCirculateSpeed": 1,
        "heatSetpoint": 21.0,
        "coolSetpoint": 24.0,
        "setpointDelta": 2.0,
        "setpointMinimum": 10.0,
        "setpointMaximum": 32.0,
        "tempIndoor": 20.8,
        "humIndoor": 45.0,
        "tempOutdoor": -5.0,
        "humOutdoor": 75.0,
        "scheduleEnabled": False,
        "geofencingEnabled": False,
    }
    res = client._format_device(raw_meta, raw_attrs, "Maison")
    assert res["id"] == "dev-daikin-01"
    assert res["device_sn"] == "daikin_dev-daikin-01"
    assert res["name"] == "Main Thermostat"
    assert res["brand"] == "daikin"
    assert res["device_type"] == "thermostat"
    assert res["model"] == "ONEPLUS"
    assert res["location_id"] == "maison"
    assert res["temp_indoor_c"] == 20.8
    assert res["temp_outdoor_c"] == -5.0
    assert res["hum_indoor"] == 45.0
    assert res["hum_outdoor"] == 75.0
    assert res["equipment_status"] == 3
    assert res["equipment_status_desc"] == "Heating"
    assert res["mode"] == 1
    assert res["mode_desc"] == "heat"
    assert res["heat_setpoint_c"] == 21.0
    assert res["cool_setpoint_c"] == 24.0
    assert res["power_w"] == 1200.0
    assert res["is_online"] is True
    assert res["schedule_enabled"] is False


@pytest.mark.asyncio
async def test_daikin_token_acquisition(monkeypatch):
    daikin_creds.save("user@example.com", "token_123", "key_abc")
    client = DaikinClient()

    class MockResponse:
        def __init__(self, status_code, json_data):
            self.status_code = status_code
            self._json = json_data
            self.text = "OK"

        def json(self):
            return self._json

    async def mock_post(*args, **kwargs):
        return MockResponse(200, {
            "accessToken": "bearer-token-999",
            "accessTokenExpiresIn": 900,
            "tokenType": "Bearer",
        })

    with patch("httpx.AsyncClient.post", side_effect=mock_post):
        tok, key = await client.get_valid_token()
        assert tok == "bearer-token-999"
        assert key == "key_abc"

        # Subsequent call uses cache without network call
        with patch("httpx.AsyncClient.post", side_effect=Exception("Should not be called")):
            tok2, _ = await client.get_valid_token()
            assert tok2 == "bearer-token-999"


@pytest.mark.asyncio
async def test_daikin_poll_all_devices():
    daikin_creds.save("user@example.com", "tok", "key")
    client = DaikinClient()

    class MockResponse:
        def __init__(self, status_code, json_data):
            self.status_code = status_code
            self._json = json_data
            self.text = "OK"

        def json(self):
            return self._json

    async def mock_post(*args, **kwargs):
        return MockResponse(200, {"accessToken": "tok123", "accessTokenExpiresIn": 900})

    async def mock_request(method, url, **kwargs):
        if url.endswith("/devices"):
            return MockResponse(200, [
                {
                    "locationName": "Maison",
                    "devices": [
                        {
                            "id": "12345",
                            "name": "Salon",
                            "model": "ONEPLUS",
                            "firmwareVersion": "2.3.5",
                        }
                    ],
                }
            ])
        elif "/devices/12345" in url:
            return MockResponse(200, {
                "equipmentStatus": 1,  # cooling
                "mode": 2,             # cool
                "heatSetpoint": 20.0,
                "coolSetpoint": 22.0,
                "tempIndoor": 23.5,
                "tempOutdoor": 28.0,
                "humIndoor": 55.0,
                "humOutdoor": 60.0,
                "scheduleEnabled": True,
            })
        return MockResponse(404, {})

    with patch("httpx.AsyncClient.post", side_effect=mock_post):
        with patch.object(client, "_request", side_effect=mock_request):
            devs = await client.poll_all_devices(force=True)
            assert len(devs) == 1
            d = devs[0]
            assert d["id"] == "12345"
            assert d["device_sn"] == "daikin_12345"
            assert d["equipment_status"] == 1
            assert d["equipment_status_desc"] == "Cooling"
            assert d["temp_indoor_c"] == 23.5
            assert d["schedule_enabled"] is True


@pytest.mark.asyncio
async def test_daikin_set_msp_controls():
    daikin_creds.save("user@example.com", "tok", "key")
    client = DaikinClient()
    client._cached_devices["dev1"] = {
        "id": "dev1",
        "setpoint_delta": 2.0,
        "setpoint_min": 10.0,
        "setpoint_max": 32.0,
    }

    class MockResponse:
        status_code = 200
        text = "OK"
        def json(self): return {"message": "success"}

    captured_payload = {}
    async def mock_request(method, url, json_data=None, **kwargs):
        nonlocal captured_payload
        captured_payload = json_data
        return MockResponse()

    with patch.object(client, "_request", side_effect=mock_request):
        res = await client.set_msp("dev1", mode=1, heat_setpoint=21.5, cool_setpoint=22.0)
        assert res["ok"] is True
        # Since heat_setpoint 21.5 > cool_setpoint 22.0 - delta(2.0), cool_setpoint should be auto-adjusted to 23.5
        assert captured_payload["heatSetpoint"] == 21.5
        assert captured_payload["coolSetpoint"] == 23.5
        assert captured_payload["mode"] == 1


@pytest.mark.asyncio
async def test_daikin_set_schedule_and_fan():
    daikin_creds.save("user@example.com", "tok", "key")
    client = DaikinClient()
    client._cached_devices["dev1"] = {"id": "dev1"}

    class MockResponse:
        status_code = 200
        text = "OK"
        def json(self): return {"message": "success"}

    async def mock_request(method, url, json_data=None, **kwargs):
        return MockResponse()

    with patch.object(client, "_request", side_effect=mock_request):
        sched_res = await client.set_schedule("dev1", schedule_enabled=True)
        assert sched_res["ok"] is True
        assert client._cached_devices["dev1"]["schedule_enabled"] is True

        fan_res = await client.set_fan("dev1", fan_circulate=1, fan_circulate_speed=2)
        assert fan_res["ok"] is True
        assert client._cached_devices["dev1"]["fan_circulate"] == 1
        assert client._cached_devices["dev1"]["fan_circulate_speed"] == 2


@pytest.mark.asyncio
async def test_daikin_air_clean_start_and_stop():
    import time
    client = DaikinClient()
    client._cached_devices["dev1"] = {
        "id": "dev1",
        "fan_circulate": 0,
        "fan_circulate_speed": 0,
    }

    set_fan_mock = AsyncMock(return_value={"ok": True})
    with patch.object(client, "set_fan", new=set_fan_mock):
        # 1. Start Air Clean
        res = await client.start_air_clean("dev1", duration_s=10800)
        assert res["active"] is True
        assert res["previous_fan_circulate"] == 0
        assert res["previous_fan_circulate_speed"] == 0
        assert res["remaining_s"] > 10700

        # Verify fan set to continuous (1) medium (1)
        set_fan_mock.assert_called_with("dev1", fan_circulate=1, fan_circulate_speed=1)

        # 2. Query state
        st = client.get_air_clean_state("dev1")
        assert st["active"] is True
        assert st["duration_s"] == 10800

        # 3. Stop Air Clean and verify fan reverted to previous settings (0, 0)
        set_fan_mock.reset_mock()
        stop_res = await client.stop_air_clean("dev1", revert_fan=True)
        assert stop_res["active"] is False
        set_fan_mock.assert_called_with("dev1", 0, 0)

        # 4. State is now inactive
        st2 = client.get_air_clean_state("dev1")
        assert st2["active"] is False


@pytest.mark.asyncio
async def test_daikin_air_clean_persistence_and_init():
    import time
    client1 = DaikinClient()
    client1._cached_devices["dev1"] = {
        "id": "dev1",
        "fan_circulate": 2,
        "fan_circulate_speed": 1,
    }

    with patch.object(client1, "set_fan", new=AsyncMock(return_value={"ok": True})):
        await client1.start_air_clean("dev1", duration_s=10800)

    # Instantiate client2 and call init_air_clean
    client2 = DaikinClient()
    assert client2.get_air_clean_state("dev1")["active"] is False

    await client2.init_air_clean()
    st = client2.get_air_clean_state("dev1")
    assert st["active"] is True
    assert st["previous_fan_circulate"] == 2
    assert st["previous_fan_circulate_speed"] == 1

    # Now simulate expiration while offline
    client2._air_clean_jobs["dev1"]["expires_at"] = time.time() - 10
    client2._save_air_clean_jobs()

    client3 = DaikinClient()
    revert_mock = AsyncMock(return_value={"ok": True})
    with patch.object(client3, "set_fan", new=revert_mock):
        await client3.init_air_clean()
        # Verify it reverted the expired job
        revert_mock.assert_called_with("dev1", 2, 1)
        assert client3.get_air_clean_state("dev1")["active"] is False


@pytest.mark.asyncio
async def test_daikin_air_clean_cancel_without_revert():
    client = DaikinClient()
    client._cached_devices["dev1"] = {
        "id": "dev1",
        "fan_circulate": 0,
        "fan_circulate_speed": 0,
    }

    with patch.object(client, "set_fan", new=AsyncMock(return_value={"ok": True})):
        await client.start_air_clean("dev1", duration_s=10800)

    set_fan_mock = AsyncMock(return_value={"ok": True})
    with patch.object(client, "set_fan", new=set_fan_mock):
        client.cancel_air_clean("dev1")
        set_fan_mock.assert_not_called()
        assert client.get_air_clean_state("dev1")["active"] is False


@pytest.mark.asyncio
async def test_daikin_air_clean_timer_expiration():
    import asyncio
    client = DaikinClient()
    client._cached_devices["dev1"] = {
        "id": "dev1",
        "fan_circulate": 0,
        "fan_circulate_speed": 2,
    }

    set_fan_mock = AsyncMock(return_value={"ok": True})
    with patch.object(client, "set_fan", new=set_fan_mock):
        # Start with very short duration (50ms)
        await client.start_air_clean("dev1", duration_s=0.05)
        set_fan_mock.assert_called_with("dev1", fan_circulate=1, fan_circulate_speed=1)
        set_fan_mock.reset_mock()

        # Wait for timer worker to fire and revert
        await asyncio.sleep(0.12)
        assert client.get_air_clean_state("dev1")["active"] is False
        set_fan_mock.assert_called_with("dev1", 0, 2)
