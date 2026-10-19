import pytest
import crypto_util
import tesla_creds


def test_tesla_creds_defaults_and_save(tmp_path, monkeypatch):
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    creds_file = tmp_path / "tesla-creds.json"
    monkeypatch.setattr(tesla_creds, "PATH", str(creds_file))

    # 1. When no file exists, returns defaults with Maison IP
    assert tesla_creds.has_credentials() is True  # default Maison TWC IP is present
    assert tesla_creds.has_tesla_vehicle_auth() is False
    data = tesla_creds.load()
    assert data["maison_twc_ip"] == tesla_creds.DEFAULT_MAISON_TWC_IP
    assert data["refresh_token"] == ""
    assert data["client_id"] == "ownerapi"
    assert data["region"] == "na"

    # 2. Save credentials
    ok = tesla_creds.save(
        refresh_token="test_refresh_token_12345",
        client_id="custom_client_id",
        client_secret="custom_secret",
        region="na",
        maison_twc_ip="192.168.86.41",
        chalet_twc_ip="10.8.0.50",
        chalet_lat=46.12,
        chalet_lon=-74.15,
        geofences={"chalet": {"lat": 46.12, "lon": -74.15, "radius_m": 350.0}},
    )
    assert ok is True
    assert creds_file.exists()
    assert tesla_creds.has_tesla_vehicle_auth() is True

    # Verify loaded data matches
    loaded = tesla_creds.load()
    assert loaded["refresh_token"] == "test_refresh_token_12345"
    assert loaded["client_id"] == "custom_client_id"
    assert loaded["client_secret"] == "custom_secret"
    assert loaded["maison_twc_ip"] == "192.168.86.41"
    assert loaded["chalet_twc_ip"] == "10.8.0.50"
    assert loaded["chalet_lat"] == 46.12
    assert loaded["chalet_lon"] == -74.15
    assert loaded["geofences"]["chalet"]["lat"] == 46.12

    # 3. Test token rotation / update
    assert tesla_creds.update_tokens(access_token="new_access_tok", refresh_token="rotated_refresh_tok", expires_in=28800) is True
    updated = tesla_creds.load()
    assert updated["access_token"] == "new_access_tok"
    assert updated["refresh_token"] == "rotated_refresh_tok"
    assert updated["token_expires_at"] > 0

    # 4. Clear credentials
    assert tesla_creds.clear() is True
    assert not creds_file.exists()
