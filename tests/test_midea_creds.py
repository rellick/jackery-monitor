import pytest
import crypto_util
import midea_creds


def test_midea_creds_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    monkeypatch.setattr(midea_creds, "PATH", str(tmp_path / "midea-creds.json"))

    assert midea_creds.has_credentials() is False
    assert midea_creds.load_all() == {}

    # Save credentials for Maison
    ok = midea_creds.save("maison", "user@example.com", "secretpass123", app_name="MSmartHome")
    assert ok is True
    assert midea_creds.has_credentials() is True
    assert midea_creds.has_credentials("maison") is True
    assert midea_creds.has_credentials("chalet") is False
    assert midea_creds.configured_locations() == ["maison"]

    m_cred = midea_creds.load("maison")
    assert m_cred is not None
    assert m_cred["email"] == "user@example.com"
    assert m_cred["password"] == "secretpass123"
    assert m_cred["app_name"] == "MSmartHome"

    # Save credentials for Chalet
    ok2 = midea_creds.save("chalet", "chalet@example.com", "chaletpass", app_name="NetHome Plus")
    assert ok2 is True
    assert midea_creds.has_credentials("chalet") is True
    assert sorted(midea_creds.configured_locations()) == ["chalet", "maison"]

    # Delete Maison
    midea_creds.clear("maison")
    assert midea_creds.has_credentials("maison") is False
    assert midea_creds.has_credentials("chalet") is True

    # Clear all
    midea_creds.clear()
    assert midea_creds.has_credentials() is False
    assert midea_creds.load_all() == {}
