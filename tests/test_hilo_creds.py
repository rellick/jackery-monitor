import os
import tempfile
import pytest

import hilo_creds
import crypto_util


@pytest.fixture(autouse=True)
def temp_creds(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        kp = os.path.join(td, ".key")
        cp = os.path.join(td, "hilo-creds.json")
        monkeypatch.setattr(crypto_util, "KEY_PATH", kp)
        monkeypatch.setattr(hilo_creds, "PATH", cp)
        yield


def test_hilo_creds_multi_location():
    # Empty state
    assert not hilo_creds.has_credentials()
    assert hilo_creds.configured_locations() == []
    assert hilo_creds.load("maison") is None
    assert hilo_creds.load("chalet") is None

    # Save maison
    ok_m = hilo_creds.save("maison", "maison@example.com", "pass_maison_123")
    assert ok_m is True
    assert hilo_creds.has_credentials()
    assert hilo_creds.has_credentials("maison")
    assert not hilo_creds.has_credentials("chalet")
    assert hilo_creds.configured_locations() == ["maison"]

    m_creds = hilo_creds.load("maison")
    assert m_creds is not None
    assert m_creds["email"] == "maison@example.com"
    assert m_creds["password"] == "pass_maison_123"

    # Save chalet
    ok_c = hilo_creds.save("chalet", "chalet@example.com", "pass_chalet_456")
    assert ok_c is True
    assert hilo_creds.has_credentials("chalet")
    assert set(hilo_creds.configured_locations()) == {"maison", "chalet"}

    c_creds = hilo_creds.load("chalet")
    assert c_creds is not None
    assert c_creds["email"] == "chalet@example.com"
    assert c_creds["password"] == "pass_chalet_456"

    # Load all
    all_creds = hilo_creds.load_all()
    assert len(all_creds) == 2
    assert "maison" in all_creds and "chalet" in all_creds

    # Clear maison only
    assert hilo_creds.clear("maison") is True
    assert not hilo_creds.has_credentials("maison")
    assert hilo_creds.has_credentials("chalet")
    assert hilo_creds.configured_locations() == ["chalet"]

    # Clear all
    assert hilo_creds.clear() is True
    assert not hilo_creds.has_credentials()
    assert hilo_creds.configured_locations() == []
