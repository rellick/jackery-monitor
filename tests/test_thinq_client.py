import pytest
from unittest.mock import AsyncMock, patch, MagicMock

from thinq_client import (
    ThinQClient,
    get_region_code,
    get_base_url,
)
import thinq_creds


def test_region_mapping():
    assert get_region_code("CA") == "aic"
    assert get_region_code("US") == "aic"
    assert get_region_code("FR") == "eic"
    assert get_region_code("KR") == "kic"
    assert get_base_url("CA") == "https://api-aic.lgthinq.com"


@pytest.mark.asyncio
async def test_test_credentials_success():
    client = ThinQClient()

    mock_res = MagicMock()
    mock_res.status_code = 200
    mock_res.json.return_value = {
        "response": [
            {
                "deviceId": "dev-washer-1",
                "deviceInfo": {
                    "deviceType": "DEVICE_WASHER",
                    "modelName": "WM9000",
                    "alias": "Laveuse",
                },
            }
        ]
    }

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_res
        res = await client.test_credentials("test_pat_token", "CA")
        assert res["ok"] is True
        assert res["device_count"] == 1


@pytest.mark.asyncio
async def test_test_credentials_invalid():
    client = ThinQClient()

    mock_res = MagicMock()
    mock_res.status_code = 401
    mock_res.json.return_value = {
        "error": {"code": "1103", "message": "Invalid token"}
    }

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_res
        res = await client.test_credentials("invalid_token", "CA")
        assert res["ok"] is False
        assert "Invalid token" in res["error"]


@pytest.mark.asyncio
async def test_poll_location(tmp_path, monkeypatch):
    import crypto_util
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    monkeypatch.setattr(thinq_creds, "PATH", str(tmp_path / "thinq-creds.json"))
    thinq_creds.save("maison", "valid_pat", country="CA", email="test@example.com")

    client = ThinQClient()

    mock_devices_res = MagicMock()
    mock_devices_res.status_code = 200
    mock_devices_res.json.return_value = {
        "response": [
            {
                "deviceId": "dev-washer-1",
                "deviceInfo": {
                    "deviceType": "DEVICE_WASHER",
                    "modelName": "WM9000HVA",
                    "alias": "Laveuse",
                },
            },
            {
                "deviceId": "dev-fridge-1",
                "deviceInfo": {
                    "deviceType": "DEVICE_REFRIGERATOR",
                    "modelName": "LRMXS30796S",
                    "alias": "Réfrigérateur",
                },
            },
            {
                "deviceId": "dev-oven-1",
                "deviceInfo": {
                    "deviceType": "DEVICE_OVEN",
                    "modelName": "LUTD4919SN",
                    "alias": "Four",
                },
            },
        ]
    }

    mock_washer_state = MagicMock()
    mock_washer_state.status_code = 200
    mock_washer_state.json.return_value = {
        "response": {
            "online": True,
            "operation": {"state": "RUNNING"},
            "remainingTime": {"remainHour": 0, "remainMinute": 34},
            "course": {"name": "Normal"},
            "currentStep": {"name": "Rinçage"},
            "doorLock": {"status": True},
        }
    }

    mock_fridge_state = MagicMock()
    mock_fridge_state.status_code = 200
    mock_fridge_state.json.return_value = {
        "response": {
            "online": True,
            "temperature": {
                "fridge": {"targetTemperature": 3.0},
                "freezer": {"targetTemperature": -18.0},
            },
            "doorStatus": {"door": "CLOSE"},
            "expressFreeze": {"status": True},
        }
    }

    mock_oven_state = MagicMock()
    mock_oven_state.status_code = 200
    mock_oven_state.json.return_value = {
        "response": {
            "online": True,
            "operation": {"state": "PREHEATING"},
            "temperature": {
                "targetTemperature": 200.0,
                "currentTemperature": 120.0,
            },
            "timer": {"remainHour": 0, "remainMinute": 15},
        }
    }

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.side_effect = [
            mock_devices_res,
            mock_washer_state,
            mock_fridge_state,
            mock_oven_state,
        ]

        devs = await client.poll_location("maison", force=True)
        assert len(devs) == 3

        # Washer assertion
        washer = next(d for d in devs if d["device_id"] == "dev-washer-1")
        assert washer["category"] == "laundry"
        assert washer["name"] == "Laveuse"
        assert washer["is_running"] is True
        assert washer["remaining_min"] == 34
        assert washer["current_step"] == "Rinçage"
        assert washer["door_locked"] is True

        # Fridge assertion
        fridge = next(d for d in devs if d["device_id"] == "dev-fridge-1")
        assert fridge["category"] == "refrigeration"
        assert fridge["name"] == "Réfrigérateur"
        assert fridge["fridge_temp_c"] == 3.0
        assert fridge["freezer_temp_c"] == -18.0
        assert fridge["door_opened"] is False
        assert fridge["express_freeze"] is True

        # Oven assertion
        oven = next(d for d in devs if d["device_id"] == "dev-oven-1")
        assert oven["category"] == "cooking"
        assert oven["name"] == "Four"
        assert oven["is_cooking"] is True
        assert oven["target_temp_c"] == 200.0
        assert oven["current_temp_c"] == 120.0
        assert oven["remaining_min"] == 15


@pytest.mark.asyncio
async def test_poll_location_disconnected_and_multi_zone(tmp_path, monkeypatch):
    import crypto_util
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    monkeypatch.setattr(thinq_creds, "PATH", str(tmp_path / "thinq-creds.json"))
    thinq_creds.save("maison", "valid_pat", country="CA")

    client = ThinQClient()

    mock_devices_res = MagicMock()
    mock_devices_res.status_code = 200
    mock_devices_res.json.return_value = {
        "response": [
            {
                "deviceId": "dev-dryer-1",
                "deviceInfo": {"deviceType": "DEVICE_DRYER", "modelName": "RV1376", "alias": "Sécheuse"},
            },
            {
                "deviceId": "dev-fridge-real",
                "deviceInfo": {"deviceType": "DEVICE_REFRIGERATOR", "modelName": "2REF12", "alias": "Réfrigérateur"},
            },
            {
                "deviceId": "dev-cooktop-real",
                "deviceInfo": {"deviceType": "DEVICE_COOKTOP", "modelName": "WCBIS", "alias": "Plaque à induction"},
            },
        ]
    }

    # Dryer disconnected (HTTP 416)
    mock_dryer_state = MagicMock()
    mock_dryer_state.status_code = 416

    # Fridge with real list structure
    mock_fridge_state = MagicMock()
    mock_fridge_state.status_code = 200
    mock_fridge_state.json.return_value = {
        "response": {
            "temperatureInUnits": [
                {"targetTemperatureC": 3, "locationName": "FRIDGE"},
                {"targetTemperatureF": 0, "locationName": "FREEZER"},
            ],
            "doorStatus": [{"doorState": "CLOSE", "locationName": "MAIN"}],
            "refrigeration": {"expressMode": False},
        }
    }

    # Cooktop with real zone list structure
    mock_cooktop_state = MagicMock()
    mock_cooktop_state.status_code = 200
    mock_cooktop_state.json.return_value = {
        "response": [
            {"location": {"locationName": "LEFT_REAR"}, "cookingZone": {"currentState": "INITIAL"}, "power": {"powerLevel": 0}},
            {"location": {"locationName": "LEFT_FRONT"}, "cookingZone": {"currentState": "INITIAL"}, "power": {"powerLevel": 0}},
        ]
    }

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.side_effect = [
            mock_devices_res,
            mock_dryer_state,
            mock_fridge_state,
            mock_cooktop_state,
        ]

        devs = await client.poll_location("maison", force=True)
        assert len(devs) == 3

        dryer = next(d for d in devs if d["device_id"] == "dev-dryer-1")
        assert dryer["online"] is False
        assert dryer["is_running"] is False

        fridge = next(d for d in devs if d["device_id"] == "dev-fridge-real")
        assert fridge["online"] is True
        assert fridge["fridge_temp_c"] == 3.0
        assert fridge["freezer_temp_c"] == -17.8
        assert fridge["door_opened"] is False

        cooktop = next(d for d in devs if d["device_id"] == "dev-cooktop-real")
        assert cooktop["online"] is True
        assert cooktop["is_cooking"] is False
        assert cooktop["run_state"] == "STANDBY"


@pytest.mark.asyncio
async def test_poll_location_multi_cavity_oven_cooking(tmp_path, monkeypatch):
    import crypto_util
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    monkeypatch.setattr(thinq_creds, "PATH", str(tmp_path / "thinq-creds.json"))
    thinq_creds.save("maison", "valid_pat", country="CA")

    client = ThinQClient()

    mock_devices_res = MagicMock()
    mock_devices_res.status_code = 200
    mock_devices_res.json.return_value = {
        "response": [
            {
                "deviceId": "dev-oven-multi",
                "deviceInfo": {"deviceType": "DEVICE_OVEN", "modelName": "WCES6428F", "alias": "Four"},
            },
        ]
    }

    # Multi-cavity oven with lower cavity actively baking at 375F
    mock_oven_state = MagicMock()
    mock_oven_state.status_code = 200
    mock_oven_state.json.return_value = {
        "response": [
            {
                "location": {"locationName": "UPPER"},
                "operation": {"currentState": "INITIAL"},
                "temperature": {"targetTemperature": 0, "unit": "F"},
            },
            {
                "location": {"locationName": "LOWER"},
                "operation": {"currentState": "COOKING_IN_PROGRESS", "cookMode": "BAKE"},
                "temperature": {"targetTemperature": 375, "unit": "F"},
                "timer": {"remainMinute": 14},
            },
        ]
    }

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.side_effect = [
            mock_devices_res,
            mock_oven_state,
        ]

        devs = await client.poll_location("maison", force=True)
        assert len(devs) == 1
        oven = devs[0]
        assert oven["category"] == "cooking"
        assert oven["name"] == "Four"
        assert oven["is_cooking"] is True
        # 375 F -> (375 - 32) * 5/9 = 190.555 -> 190.6 C
        assert oven["target_temp_c"] == 190.6
        assert oven["current_temp_c"] == 190.6
        assert oven["remaining_min"] == 14
        assert len(oven["sub_zones"]) == 2

        upper = oven["sub_zones"][0]
        assert upper["name"] == "Upper Cavity"
        assert upper["is_active"] is False
        assert upper["target_temp_c"] is None
        assert upper["current_temp_c"] is None

        lower = oven["sub_zones"][1]
        assert lower["name"] == "Lower Cavity"
        assert lower["is_active"] is True
        assert lower["cook_mode"] == "BAKE"
        assert lower["state"] == "COOKING_IN_PROGRESS"
        assert lower["target_temp_c"] == 190.6
        assert lower["current_temp_c"] == 190.6
        assert lower["remaining_min"] == 14


@pytest.mark.asyncio
async def test_rate_limit_detection_and_backoff(tmp_path, monkeypatch):
    import time
    from thinq_client import ThinQTransientError
    import crypto_util
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    monkeypatch.setattr(thinq_creds, "PATH", str(tmp_path / "thinq-creds.json"))
    thinq_creds.save("maison", "valid_pat", country="CA")

    client = ThinQClient()

    mock_rate_limit_res = MagicMock()
    mock_rate_limit_res.status_code = 401
    mock_rate_limit_res.json.return_value = {
        "error": {"code": "1314", "message": "Exceeded User API calls"}
    }

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_rate_limit_res
        with pytest.raises(ThinQTransientError) as exc_info:
            await client.get_raw_devices("maison", force=True)
        assert "1314" in str(exc_info.value)
        assert "Exceeded User API calls" in str(exc_info.value)
        assert client._rate_limited_until["maison"] > time.time()


@pytest.mark.asyncio
async def test_transient_failure_preserves_last_known_state(tmp_path, monkeypatch):
    import crypto_util
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    monkeypatch.setattr(thinq_creds, "PATH", str(tmp_path / "thinq-creds.json"))
    thinq_creds.save("maison", "valid_pat", country="CA")

    client = ThinQClient()

    # Pre-seed cache with an active oven
    client._cached_devices["maison"] = [
        {
            "device_id": "dev-oven-1",
            "device_sn": "thinq_maison_dev_oven_1",
            "name": "Four",
            "category": "cooking",
            "online": True,
            "is_cooking": True,
            "target_temp_c": 190.0,
            "current_temp_c": 190.0,
            "remaining_min": 45,
            "sub_zones": [
                {"id": "LOWER", "name": "Lower Cavity", "is_active": True, "target_temp_c": 190.0}
            ],
        }
    ]

    mock_devices_res = MagicMock()
    mock_devices_res.status_code = 200
    mock_devices_res.json.return_value = {
        "response": [
            {
                "deviceId": "dev-oven-1",
                "deviceInfo": {"deviceType": "DEVICE_OVEN", "modelName": "WCES6428F", "alias": "Four"},
            }
        ]
    }

    # Simulate get_device_state returning 401 / rate-limited (HTTP 401 code 1314)
    mock_state_fail = MagicMock()
    mock_state_fail.status_code = 401
    mock_state_fail.json.return_value = {
        "error": {"code": "1314", "message": "Exceeded User API calls"}
    }

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.side_effect = [
            mock_devices_res,
            mock_state_fail,
        ]

        devs = await client.poll_location("maison", force=True)
        assert len(devs) == 1
        oven = devs[0]
        # State must NOT be wiped or marked offline!
        assert oven["online"] is True
        assert oven["is_cooking"] is True
        assert oven["target_temp_c"] == 190.0
        assert oven["remaining_min"] == 45


@pytest.mark.asyncio
async def test_refrigeration_fahrenheit_and_celsius(tmp_path, monkeypatch):
    import crypto_util
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    monkeypatch.setattr(thinq_creds, "PATH", str(tmp_path / "thinq-creds.json"))
    thinq_creds.save("maison", "valid_pat", country="CA")

    client = ThinQClient()

    mock_devices_res = MagicMock()
    mock_devices_res.status_code = 200
    mock_devices_res.json.return_value = {
        "response": [
            {
                "deviceId": "dev-fridge-1",
                "deviceInfo": {"deviceType": "DEVICE_REFRIGERATOR", "modelName": "2REF12", "alias": "Réfrigérateur"},
            }
        ]
    }

    mock_fridge_state = MagicMock()
    mock_fridge_state.status_code = 200
    mock_fridge_state.json.return_value = {
        "response": {
            "temperature": [
                {"targetTemperature": 37, "unit": "F", "locationName": "FRIDGE"},
                {"targetTemperature": 0, "unit": "F", "locationName": "FREEZER"},
            ],
            "temperatureInUnits": [
                {"targetTemperatureC": 3, "targetTemperatureF": 37, "locationName": "FRIDGE", "unit": "F"},
                {"targetTemperatureF": 0, "locationName": "FREEZER", "unit": "F"},
            ],
        }
    }

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.side_effect = [
            mock_devices_res,
            mock_fridge_state,
        ]

        devs = await client.poll_location("maison", force=True)
        assert len(devs) == 1
        fridge = devs[0]
        assert fridge["fridge_temp_f"] == 37
        assert fridge["freezer_temp_f"] == 0
        assert fridge["fridge_temp_c"] == 3.0
        assert fridge["freezer_temp_c"] == -17.8


@pytest.mark.asyncio
async def test_centralized_per_device_polling_isolation(tmp_path, monkeypatch):
    import time
    import crypto_util
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    monkeypatch.setattr(thinq_creds, "PATH", str(tmp_path / "thinq-creds.json"))
    thinq_creds.save("maison", "valid_pat", country="CA")

    client = ThinQClient()
    now = time.time()

    # Pre-seed cache with 3 devices:
    # 1. Oven: Active cooking, polled 70s ago -> DUE (interval is 60s)
    # 2. Fridge: Refrigeration, polled 70s ago -> NOT DUE (interval is 900s)
    # 3. Cooktop: Standby, polled 70s ago -> NOT DUE (interval is 240s)
    client._cached_devices["maison"] = [
        {"device_id": "dev-oven", "name": "Four", "category": "cooking", "is_cooking": True, "online": True},
        {"device_id": "dev-fridge", "name": "Réfrigérateur", "category": "refrigeration", "fridge_temp_f": 37, "online": True},
        {"device_id": "dev-cooktop", "name": "Plaque", "category": "cooking", "is_cooking": False, "online": True},
    ]
    client._device_last_poll_ts = {
        "dev-oven": now - 70.0,
        "dev-fridge": now - 70.0,
        "dev-cooktop": now - 70.0,
    }
    client._raw_devices_cache["maison"] = (now, [
        {"deviceId": "dev-oven", "deviceInfo": {"deviceType": "DEVICE_OVEN", "modelName": "M1", "alias": "Four"}},
        {"deviceId": "dev-fridge", "deviceInfo": {"deviceType": "DEVICE_REFRIGERATOR", "modelName": "M2", "alias": "Réfrigérateur"}},
        {"deviceId": "dev-cooktop", "deviceInfo": {"deviceType": "DEVICE_COOKTOP", "modelName": "M3", "alias": "Plaque"}},
    ])
    client._last_poll_ts["maison"] = now - 20.0

    mock_oven_state = MagicMock()
    mock_oven_state.status_code = 200
    mock_oven_state.json.return_value = {
        "response": {
            "online": True,
            "operation": {"state": "COOKING_IN_PROGRESS"},
            "temperature": {"targetTemperature": 400.0, "unit": "F"},
        }
    }

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = mock_oven_state

        updated = await client.poll_location("maison", force=False)

        # Only the oven was polled! Fridge and Cooktop were NOT queried!
        assert len(updated) == 1
        assert updated[0]["device_id"] == "dev-oven"
        assert updated[0]["target_temp_c"] is not None

        # Verify exact call count: exactly 1 HTTP request made!
        assert mock_get.call_count == 1
        assert "dev-oven/state" in mock_get.call_args[0][0]

        # Verify all 3 devices remain in memory cache
        all_cached = client.get_cached_devices("maison")
        assert len(all_cached) == 3
        assert {d["device_id"] for d in all_cached} == {"dev-oven", "dev-fridge", "dev-cooktop"}



