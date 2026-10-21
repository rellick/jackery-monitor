import pytest
from unittest.mock import AsyncMock, patch

from sinope_client import SinopeClient


@pytest.mark.asyncio
async def test_sinope_classify_thermostat():
    client = SinopeClient()
    raw_dev = {
        "id": 101,
        "name": "Salon Thermostat",
        "signature": {"model": "TH1123WF"},
    }
    raw_attrs = {
        "roomTemperature": 21.5,
        "roomSetpoint": 22.0,
        "outputPercentDisplay": 50,
        "loadWatt": 2000,
        "drStatus": "idle",
    }
    formatted = client._classify_and_format_device(raw_dev, raw_attrs, "Maison")
    assert formatted["device_type"] == "thermostat"
    assert formatted["room_temp_c"] == 21.5
    assert formatted["setpoint_c"] == 22.0
    assert formatted["heat_level_pct"] == 50
    assert formatted["power_w"] == 1000.0  # 50% of 2000W
    assert formatted["is_on"] is True
    assert formatted["location_id"] == "maison"


@pytest.mark.asyncio
async def test_sinope_classify_controller():
    client = SinopeClient()
    raw_dev = {
        "id": 202,
        "name": "Chauffe-eau",
        "signature": {"model": "RM3500WF"},
    }
    raw_attrs = {
        "activePower": 3850.0,
        "onOff": 1,
        "drStatus": "active",
    }
    formatted = client._classify_and_format_device(raw_dev, raw_attrs, "Chalet")
    assert formatted["device_type"] == "controller"
    assert formatted["power_w"] == 3850.0
    assert formatted["is_on"] is True
    assert formatted["dr_status"] == "active"
    assert formatted["location_id"] == "chalet"


@pytest.mark.asyncio
async def test_sinope_classify_water_heater_no_phantom_load():
    client = SinopeClient()
    raw_dev = {
        "id": 659372,
        "name": "Salle mécanique",
        "sku": "RM3500WF",
        "signature": {"model": "RM3500WF"},
    }
    raw_attrs = {
        "loadWatt": {"value": 4976},
        "onOff": "on",
        "waterTemperature": 57.17,
        "drStatus": {"drActive": "off"},
    }
    formatted = client._classify_and_format_device(raw_dev, raw_attrs, "Maison")
    assert formatted["device_type"] == "controller"
    assert formatted["is_water_heater"] is True
    assert formatted["water_temperature_c"] == 57.17
    assert formatted["load_watt"] == 4976.0
    assert formatted["is_on"] is True
    assert formatted["power_w"] == 0.0


@pytest.mark.asyncio
async def test_sinope_classify_water_heater_load_watt_now():
    client = SinopeClient()
    raw_dev = {
        "id": 659372,
        "name": "Salle mécanique",
        "sku": "RM3500WF",
        "signature": {"model": "RM3500WF"},
    }
    # When actively heating elements draw current
    raw_attrs_heating = {
        "loadWatt": {"value": 4976},
        "loadWattNow": {"value": 4976},
        "onOff": "on",
        "waterTemperature": 52.5,
        "drStatus": {"drActive": "off"},
    }
    heating = client._classify_and_format_device(raw_dev, raw_attrs_heating, "Maison")
    assert heating["power_w"] == 4976.0
    assert heating["is_on"] is True
    assert heating["load_watt"] == 4976.0

    # When satisfied / idle (relay closed but tank at set temperature)
    raw_attrs_idle = {
        "loadWatt": {"value": 4976},
        "loadWattNow": {"value": 0},
        "onOff": "on",
        "waterTemperature": 58.5,
        "drStatus": {"drActive": "off"},
    }
    idle = client._classify_and_format_device(raw_dev, raw_attrs_idle, "Maison")
    assert idle["power_w"] == 0.0
    assert idle["is_on"] is True




@pytest.mark.asyncio
async def test_sinope_classify_zero_heat():
    client = SinopeClient()
    raw_dev = {
        "id": 303,
        "name": "Chambre Thermostat",
        "signature": {"model": "TH1124WF"},
    }
    raw_attrs = {
        "roomTemperature": 22.0,
        "roomSetpoint": 20.0,
        "outputPercentDisplay": 0,
        "loadWatt": 1500,
    }
    formatted = client._classify_and_format_device(raw_dev, raw_attrs, "Maison")
    assert formatted["power_w"] == 0.0
    assert formatted["is_on"] is False


@pytest.mark.asyncio
async def test_sinope_login_and_credentials(monkeypatch):
    from unittest.mock import MagicMock
    import httpx

    client = SinopeClient()

    class MockResponse:
        def __init__(self, status_code, json_data, cookies=None, headers=None):
            self.status_code = status_code
            self._json = json_data
            self.cookies = cookies or {"session_cookie": "abc"}
            self.headers = headers or {}

        def json(self):
            return self._json

    async def mock_post(*args, **kwargs):
        payload = kwargs.get("json", {})
        assert payload.get("username") == "test@example.com"
        assert payload.get("interface") == "neviweb"
        assert payload.get("stayConnected") == 1
        return MockResponse(
            200,
            {
                "session": "sess-xyz-123",
                "account": {"id": 999},
                "user": {"email": "test@example.com"},
            },
        )

    async def mock_get(*args, **kwargs):
        return MockResponse(200, [{"id": 1, "name": "Maison"}])

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
    monkeypatch.setattr(httpx.AsyncClient, "get", mock_get)

    res = await client.test_credentials("test@example.com", "pass123")
    assert res["ok"] is True
    assert len(res["locations"]) == 1
    assert res["locations"][0]["name"] == "Maison"

    # Test bad login error code
    async def mock_post_bad_login(*args, **kwargs):
        return MockResponse(200, {"error": {"code": "USRBADLOGIN"}})

    monkeypatch.setattr(httpx.AsyncClient, "post", mock_post_bad_login)
    res_bad = await client.test_credentials("test@example.com", "wrongpass")
    assert res_bad["ok"] is False
    assert "Invalid Neviweb" in res_bad["error"]


@pytest.mark.asyncio
async def test_sinope_classify_nested_thermostat():
    client = SinopeClient()
    raw_dev = {
        "id": 253411,
        "name": "Chambre Principale",
        "sku": "TH1123WF",
        "family": "1123",
        "signature": {"model": "TH1123WF"},
    }
    raw_attrs = {
        "roomSetpoint": 14,
        "outputPercentDisplay": {"percent": 50, "sourceType": "heating"},
        "drStatus": {
            "drActive": "off",
            "optOut": "off",
            "setpoint": "off",
            "powerAbsolute": "off",
            "powerRelative": "off",
            "onOff": "off",
        },
        "roomTemperature": {"error": None, "value": 16.66},
        "loadWatt": {"value": 1460},
    }
    formatted = client._classify_and_format_device(raw_dev, raw_attrs, "Chalet")
    assert formatted["device_type"] == "thermostat"
    assert formatted["model"] == "TH1123WF"
    assert formatted["room_temp_c"] == 16.66
    assert formatted["setpoint_c"] == 14.0
    assert formatted["heat_level_pct"] == 50
    assert formatted["load_watt"] == 1460.0
    assert formatted["power_w"] == 730.0  # 50% of 1460W
    assert formatted["is_on"] is True
    assert formatted["is_online"] is True
    assert formatted["dr_status"] == "idle"
    assert formatted["location_id"] == "chalet"


@pytest.mark.asyncio
async def test_sinope_classify_nested_controller():
    client = SinopeClient()
    raw_dev = {
        "id": 746476,
        "name": "Chauffe-eau",
        "sku": "RM3500WF",
        "family": "2150",
        "signature": {"model": "RM3500WF"},
    }
    raw_attrs = {
        "loadWatt": {"value": 4885},
        "onOff": "off",
        "drStatus": {
            "drActive": "off",
            "optOut": "off",
            "setpoint": "off",
            "powerAbsolute": "off",
            "powerRelative": "off",
            "onOff": "off",
        },
    }
    formatted = client._classify_and_format_device(raw_dev, raw_attrs, "Chalet")
    assert formatted["device_type"] == "controller"
    assert formatted["load_watt"] == 4885.0
    assert formatted["power_w"] == 0.0
    assert formatted["is_on"] is False
    assert formatted["is_online"] is True
    assert formatted["dr_status"] == "idle"

    # When controller turns ON (relay armed, internal thermostat manages elements)
    raw_attrs_on = dict(raw_attrs, onOff="on")
    formatted_on = client._classify_and_format_device(raw_dev, raw_attrs_on, "Chalet")
    assert formatted_on["is_on"] is True
    assert formatted_on["is_water_heater"] is True
    assert formatted_on["power_w"] == 0.0  # Standby / armed; real consumption is metered via Neviweb hourly API


@pytest.mark.asyncio
async def test_sinope_classify_valve():
    client = SinopeClient()
    raw_dev = {
        "id": 567223,
        "name": "Entrée d'eau",
        "sku": "VA4220WF",
        "family": "3150",
    }
    raw_attrs = {}
    formatted = client._classify_and_format_device(raw_dev, raw_attrs, "Chalet")
    assert formatted["device_type"] == "valve"
    assert formatted["power_w"] == 0.0
    assert formatted["is_online"] is True


@pytest.mark.asyncio
async def test_sinope_classify_leak_sensor():
    client = SinopeClient()
    raw_dev = {
        "id": 574769,
        "name": "Eau chaude",
        "sku": "WL4200S",
        "family": "5052",
    }
    raw_attrs = {
        "roomTemperature": 21.63,
        "batteryVoltage": 3.0,
    }
    formatted = client._classify_and_format_device(raw_dev, raw_attrs, "Chalet")
    assert formatted["device_type"] == "leak_sensor"
    assert formatted["room_temp_c"] == 21.63
    assert formatted["battery_v"] == 3.0
    assert formatted["power_w"] == 0.0
    assert formatted["is_online"] is True


@pytest.mark.asyncio
async def test_sinope_classify_offline_device():
    client = SinopeClient()
    raw_dev = {
        "id": 442454,
        "name": "Laveuse",
        "sku": "WL4200S",
        "family": "5052",
    }
    raw_attrs = {
        "error": {"code": "DVCCOMMTO", "data": {"identifier": "abc-123"}},
    }
    formatted = client._classify_and_format_device(raw_dev, raw_attrs, "Maison")
    assert formatted["device_type"] == "leak_sensor"
    assert formatted["is_online"] is False


@pytest.mark.asyncio
async def test_sinope_room_name_fallback():
    client = SinopeClient()
    # Case 1: Name equals model/sku -> use room name
    raw_dev1 = {
        "id": 101,
        "name": "TH1123WF",
        "sku": "TH1123WF",
        "signature": {"model": "TH1123WF"},
    }
    fmt1 = client._classify_and_format_device(raw_dev1, {}, "Chalet", room_name="Salon")
    assert fmt1["name"] == "Salon"
    assert fmt1["room_name"] == "Salon"

    # Case 2: Name is empty -> use room name
    raw_dev2 = {
        "id": 102,
        "name": "",
        "sku": "TH1124WF",
        "signature": {"model": "TH1124WF"},
    }
    fmt2 = client._classify_and_format_device(raw_dev2, {}, "Chalet", room_name="Audacieuse")
    assert fmt2["name"] == "Audacieuse"
    assert fmt2["room_name"] == "Audacieuse"

    # Case 3: Name is custom -> preserve custom name and retain room_name
    raw_dev3 = {
        "id": 103,
        "name": "Chambre d'amis",
        "sku": "TH1123WF",
        "signature": {"model": "TH1123WF"},
    }
    fmt3 = client._classify_and_format_device(raw_dev3, {}, "Chalet", room_name="Avalanche")
    assert fmt3["name"] == "Chambre d'amis"
    assert fmt3["room_name"] == "Avalanche"


@pytest.mark.asyncio
async def test_sinope_fetch_groups(monkeypatch):
    import httpx

    client = SinopeClient()
    client._session_id = "test-session"

    class MockResponse:
        def __init__(self, status_code, json_data):
            self.status_code = status_code
            self._json = json_data
            self.cookies = {}

        def json(self):
            return self._json

    async def mock_get(*args, **kwargs):
        return MockResponse(200, [
            {"id": 10, "name": "Salon"},
            {"id": 20, "name": "Cuisine"},
        ])

    monkeypatch.setattr(httpx.AsyncClient, "request", mock_get)

    groups = await client.fetch_groups_for_location(12345)
    assert groups[10] == "Salon"
    assert groups["10"] == "Salon"
    assert groups[20] == "Cuisine"


@pytest.mark.asyncio
async def test_sinope_set_thermostat_setpoint_and_preserve_duty_pct(monkeypatch):
    import httpx

    client = SinopeClient()
    client._session_id = "test-session"
    client._cached_telemetry["101"] = {
        "id": "101",
        "device_sn": "sinope_101",
        "name": "Salon",
        "device_type": "thermostat",
        "room_temp_c": 20.0,
        "setpoint_c": 21.0,
        "heat_level_pct": 65,
        "power_w": 975.0,
        "load_watt": 1500.0,
    }

    captured = {}

    class MockResponse:
        def __init__(self, status_code, json_data):
            self.status_code = status_code
            self._json = json_data
            self.content = b"{}"
            self.cookies = {}

        def json(self):
            return self._json

    async def mock_request(self, method, url, **kwargs):
        captured["method"] = method
        captured["url"] = url
        captured["json"] = kwargs.get("json")
        return MockResponse(200, {"roomSetpoint": kwargs.get("json", {}).get("roomSetpoint")})

    monkeypatch.setattr(httpx.AsyncClient, "request", mock_request)

    # 21.3 should round to nearest 0.5°C -> 21.5°C
    res = await client.set_thermostat_setpoint("sinope_101", 21.3)
    assert res["ok"] is True
    assert res["setpoint_c"] == 21.5
    assert captured["method"] == "PUT"
    assert "/api/device/101/attribute" in captured["url"]
    assert captured["json"] == {"roomSetpoint": 21.5}
    # Duty cycle % and power_w must remain preserved in telemetry cache
    assert client._cached_telemetry["101"]["setpoint_c"] == 21.5
    assert client._cached_telemetry["101"]["heat_level_pct"] == 65
    assert client._cached_telemetry["101"]["power_w"] == 975.0




