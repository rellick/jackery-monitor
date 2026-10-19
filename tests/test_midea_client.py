import pytest
from unittest.mock import MagicMock, patch

import crypto_util
from midea_client import MideaClient
import midea_creds


@pytest.mark.asyncio
async def test_midea_client_poll_and_control(tmp_path, monkeypatch):
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    monkeypatch.setattr(midea_creds, "PATH", str(tmp_path / "midea-creds.json"))
    monkeypatch.setattr("midea_client.MIDEA_LOCATIONS_FILE", str(tmp_path / "midea-locations.json"))

    midea_creds.save("maison", "test@example.com", "mypassword", app_name="MSmartHome")

    client = MideaClient()

    # Mock LanDevice and state
    mock_dev1 = MagicMock()
    mock_dev1.appliance_id = "12345678"
    mock_dev1.name = "Danby Sous-sol"
    mock_dev1.model = "DDR050BLPBDB"
    mock_dev1.address = "192.168.86.50"
    mock_dev1.online = True

    mock_state1 = MagicMock()
    mock_state1.running = True
    mock_state1.current_humidity = 58
    mock_state1.target_humidity = 45
    mock_state1.current_temperature = 21.5
    mock_state1.tank_full = False
    mock_state1.fan_speed = 60
    mock_state1.mode = 1
    mock_dev1.state = mock_state1

    mock_dev2 = MagicMock()
    mock_dev2.appliance_id = "87654321"
    mock_dev2.name = "Danby Atelier"
    mock_dev2.model = "DDR050BCWDB"
    mock_dev2.address = "192.168.86.51"
    mock_dev2.online = True

    mock_state2 = MagicMock()
    mock_state2.running = False
    mock_state2.current_humidity = 64
    mock_state2.target_humidity = 50
    mock_state2.current_temperature = 19.0
    mock_state2.tank_full = True  # Tank full!
    mock_state2.fan_speed = 40
    mock_state2.mode = 1
    mock_dev2.state = mock_state2

    with patch("midea_beautiful.connect_to_cloud") as mock_connect:
        mock_cloud = MagicMock()
        mock_connect.return_value = mock_cloud

        with patch("midea_beautiful.find_appliances") as mock_find:
            mock_find.return_value = [mock_dev1, mock_dev2]

            devs = await client.poll_all_locations()
            assert len(devs) == 2

            d1 = next(d for d in devs if d["device_id"] == "12345678")
            assert d1["name"] == "Danby Sous-sol"
            assert d1["power"] is True
            assert d1["current_humidity"] == 58
            assert d1["target_humidity"] == 45
            assert d1["tank_full"] is False
            assert d1["fan_speed"] == 60
            assert d1["location_id"] == "maison"

            d2 = next(d for d in devs if d["device_id"] == "87654321")
            assert d2["name"] == "Danby Atelier"
            assert d2["power"] is False
            assert d2["current_humidity"] == 64
            assert d2["tank_full"] is True

            # Test set_target_humidity
            await client.set_target_humidity("12345678", 50)
            mock_dev1.set_state.assert_called_with(cloud=mock_cloud, target_humidity=50)

            # Test set_power
            await client.set_power("12345678", False)
            mock_dev1.set_state.assert_called_with(cloud=mock_cloud, running=False)

            # Test set_device_location
            client.set_device_location("87654321", "chalet")
            cached = client.get_cached_devices()
            d2_updated = next(d for d in cached if d["device_id"] == "87654321")
            assert d2_updated["location_id"] == "chalet"


@pytest.mark.asyncio
async def test_midea_client_error_65027_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    monkeypatch.setattr(midea_creds, "PATH", str(tmp_path / "midea-creds.json"))
    monkeypatch.setattr("midea_client.MIDEA_LOCATIONS_FILE", str(tmp_path / "midea-locations.json"))

    client = MideaClient()

    # When MSmartHome fails with 65027, it should fall back to NetHome Plus
    call_count = 0
    def mock_connect(**kwargs):
        nonlocal call_count
        call_count += 1
        appname = kwargs.get("appname")
        if appname == "MSmartHome":
            raise Exception("Midea cloud API error: 该用户在线登录设备已超过上限,请更换账号登录 (65027)")
        mock_c = MagicMock()
        mock_c.list_appliances.return_value = [{"id": "111", "name": "Danby 1", "type": "0xA1"}]
        return mock_c

    with patch("midea_beautiful.connect_to_cloud", side_effect=mock_connect):
        res = await client.test_credentials("test@example.com", "pass", "MSmartHome")
        assert res["ok"] is True
        assert res["app_name"] == "NetHome Plus"
        assert res["device_count"] == 1
        assert call_count == 2


def test_midea_operational_status_computation():
    from midea_client import _compute_operational_status

    # 1. Device OFF
    status, comp, fan = _compute_operational_status(power=False, tank_full=False, defrosting=False, mode=1, current_humidity=65, target_humidity=45)
    assert status == "off"
    assert comp is False
    assert fan is False

    # 2. Tank full (takes priority over power/defrost/humidity)
    status, comp, fan = _compute_operational_status(power=True, tank_full=True, defrosting=False, mode=1, current_humidity=65, target_humidity=45)
    assert status == "tank_full"
    assert comp is False
    assert fan is False

    # 3. Defrosting (compressor paused, fan running)
    status, comp, fan = _compute_operational_status(power=True, tank_full=False, defrosting=True, mode=1, current_humidity=65, target_humidity=45)
    assert status == "defrosting"
    assert comp is False
    assert fan is True

    # 4. Continuous mode (compressor runs even if humidity is satisfied)
    status, comp, fan = _compute_operational_status(power=True, tank_full=False, defrosting=False, mode=2, current_humidity=35, target_humidity=50)
    assert status == "dehumidifying"
    assert comp is True
    assert fan is False

    # 5. Active dehumidification (current humidity > target humidity)
    status, comp, fan = _compute_operational_status(power=True, tank_full=False, defrosting=False, mode=1, current_humidity=55, target_humidity=45)
    assert status == "dehumidifying"
    assert comp is True
    assert fan is False

    # 6. Satisfied humidity setpoint (current humidity <= target humidity -> fan only)
    status, comp, fan = _compute_operational_status(power=True, tank_full=False, defrosting=False, mode=1, current_humidity=42, target_humidity=45)
    assert status == "fan_only"
    assert comp is False
    assert fan is True

    status, comp, fan = _compute_operational_status(power=True, tank_full=False, defrosting=False, mode=1, current_humidity=45, target_humidity=45)
    assert status == "fan_only"
    assert comp is False
    assert fan is True

