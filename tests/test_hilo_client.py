import json
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
import httpx

from hilo_client import (
    HiloClient,
    HiloConfigError,
    HiloTransientError,
    _get_code_challenge,
    _get_code_verifier,
)


def test_pkce_helpers():
    verifier = _get_code_verifier()
    assert len(verifier) >= 40
    challenge = _get_code_challenge(verifier)
    assert len(challenge) > 20
    assert "=" not in challenge


@pytest.mark.asyncio
async def test_hilo_login_success(monkeypatch, tmp_path):
    session_file = tmp_path / "hilo-session.json"
    monkeypatch.setattr("hilo_client.SESSION_PATH", session_file)

    client = HiloClient()

    # Mock authorize response with SETTINGS
    html_body = """
    <html>
    <script>
    var SETTINGS = {"transId": "tx-12345", "csrf": "csrf-secret-abc"};
    </script>
    </html>
    """

    auth_res = MagicMock()
    auth_res.status_code = 200
    auth_res.text = html_body
    auth_res.raise_for_status = MagicMock()

    sa_res = MagicMock()
    sa_res.status_code = 200
    sa_res.json.return_value = {"status": "200"}
    sa_res.raise_for_status = MagicMock()

    conf_res = MagicMock()
    conf_res.status_code = 302
    conf_res.headers = {
        "Location": "https://my.home-assistant.io/redirect/oauth?code=mock_auth_code_xyz"
    }

    token_res = MagicMock()
    token_res.status_code = 200
    token_res.json.return_value = {
        "access_token": "mock_access_token_111",
        "refresh_token": "mock_refresh_token_222",
        "expires_in": 3600,
    }
    token_res.raise_for_status = MagicMock()

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get, \
         patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_get.side_effect = [auth_res, conf_res]
        mock_post.side_effect = [sa_res, token_res]

        sess = await client.login("maison", "user@example.com", "mypassword")
        assert sess["access_token"] == "mock_access_token_111"
        assert sess["refresh_token"] == "mock_refresh_token_222"
        assert "maison" in client._sessions


@pytest.mark.asyncio
async def test_hilo_login_invalid_credentials(monkeypatch, tmp_path):
    session_file = tmp_path / "hilo-session.json"
    monkeypatch.setattr("hilo_client.SESSION_PATH", session_file)

    client = HiloClient()

    html_body = '<script>var SETTINGS = {"transId": "tx-1", "csrf": "csrf-1"};</script>'
    auth_res = MagicMock()
    auth_res.status_code = 200
    auth_res.text = html_body
    auth_res.raise_for_status = MagicMock()

    sa_res = MagicMock()
    sa_res.status_code = 200
    sa_res.json.return_value = {
        "status": "400",
        "errorCode": "AADB2C90053",
        "message": "Invalid email or password.",
    }
    sa_res.raise_for_status = MagicMock()

    with patch("httpx.AsyncClient.get", new_callable=AsyncMock) as mock_get, \
         patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_get.return_value = auth_res
        mock_post.return_value = sa_res

        with pytest.raises(HiloConfigError) as exc_info:
            await client.login("maison", "user@example.com", "wrongpassword")
        assert "Invalid email or password" in str(exc_info.value)


@pytest.mark.asyncio
async def test_hilo_poll_location(monkeypatch, tmp_path):
    session_file = tmp_path / "hilo-session.json"
    monkeypatch.setattr("hilo_client.SESSION_PATH", session_file)

    client = HiloClient()
    # Pre-populate valid token
    client._sessions["maison"] = {
        "access_token": "valid_token",
        "refresh_token": "valid_refresh",
        "expires_at": 9999999999,
        "email": "user@example.com",
    }

    mock_locs = [
        {"id": 1001, "locationHiloId": "loc:hilo:1001", "name": "Maison"}
    ]

    mock_digital_twin_devices = [
        {
            "deviceType": "Gateway",
            "hiloId": "Gateway:00:11:22:33:44:55",
            "physicalAddress": "00:11:22:33:44:55",
            "connectionStatus": "CONNECTED",
            "controllerSoftwareVersion": "2.4.1",
        },
        {
            "deviceType": "BasicSmartMeter",
            "hiloId": "BasicSmartMeter:AA:BB:CC:DD:EE:FF",
            "physicalAddress": "AA:BB:CC:DD:EE:FF",
            "connectionStatus": "CONNECTED",
            "zigBeeChannel": 15,
            "power": {"value": 2450.0, "kind": "W"},
        },
        {
            "deviceType": "Meter",
            "hiloId": "Meter:00:22:33:44:55:66",
            "physicalAddress": "00:22:33:44:55:66",
            "connectionStatus": "CONNECTED",
            "zigBeeChannel": 19,
            "power": {"value": 1.45, "kind": "KILOWATT"},
        },
        {
            "deviceType": "LowVoltageThermostat",
            "hiloId": "LowVoltageThermostat:11:22:33:44:55:66",
            "physicalAddress": "11:22:33:44:55:66",
            "connectionStatus": "CONNECTED",
            "mode": "Heat",
            "ambientTemperature": {"value": 21.0, "kind": "C"},
            "ambientTempSetpoint": {"value": 22.0, "kind": "C"},
            "power": {"value": 1500.0, "kind": "W"},
        },
    ]

    mock_challenges = [
        {
            "id": 55,
            "period": "PM",
            "progress": "scheduled",
            "isParticipating": True,
            "reward": 4.50,
            "parameters": {"mode": "ambitious"},
            "consumption": {"baselineWh": 12000.0, "currentWh": 3000.0},
            "phases": {
                "preheatStartDateUTC": "2026-10-13T20:00:00Z",
                "preheatEndDateUTC": "2026-10-13T22:00:00Z",
                "reductionStartDateUTC": "2026-10-13T22:00:00Z",
                "reductionEndDateUTC": "2026-10-14T02:00:00Z",
                "recoveryStartDateUTC": "2026-10-14T02:00:00Z",
                "recoveryEndDateUTC": "2026-10-14T03:00:00Z",
            },
        }
    ]

    with patch.object(client, "get_locations", new_callable=AsyncMock) as mock_get_locs, \
         patch.object(client, "query_digital_twin", new_callable=AsyncMock) as mock_dt, \
         patch.object(client, "get_challenges", new_callable=AsyncMock) as mock_ch:
        mock_get_locs.return_value = mock_locs
        mock_dt.return_value = mock_digital_twin_devices
        mock_ch.return_value = mock_challenges

        res = await client.poll_location("maison", force=True)
        assert res["location_id"] == "maison"
        assert len(res["meters"]) == 2
        m1 = res["meters"][0]
        assert m1["device_type"] == "smart_meter"
        assert m1["power_w"] == 2450.0
        assert m1["online"] is True
        assert m1["mac"] == "AA:BB:CC:DD:EE:FF"

        m2 = res["meters"][1]
        assert m2["device_type"] == "smart_meter"
        assert m2["power_w"] == 1450.0  # 1.45 kW * 1000
        assert m2["online"] is True
        assert m2["zigbee_channel"] == 19

        assert len(res["devices"]) == 2  # Gateway + Thermostat
        assert len(res["challenges"]) == 1
        ch = res["challenges"][0]
        assert ch["event_id"] == 55
        assert ch["period"] == "PM"
        assert ch["reward"] == 4.50
        assert ch["baseline_kwh"] == 12.0
        assert ch["current_kwh"] == 3.0

        # Verify caching
        cached_meters = client.get_cached_meters("maison")
        assert len(cached_meters) == 2
        assert cached_meters[0]["power_w"] == 2450.0
        assert cached_meters[1]["power_w"] == 1450.0

        cached_ch = client.get_cached_challenges("maison")
        assert len(cached_ch) == 1
