import os
import tempfile
import pytest

import daikin_creds
import crypto_util


@pytest.fixture(autouse=True)
def temp_creds(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        kp = os.path.join(td, ".key")
        cp = os.path.join(td, "daikin-creds.json")
        monkeypatch.setattr(crypto_util, "KEY_PATH", kp)
        monkeypatch.setattr(daikin_creds, "PATH", cp)
        yield


def test_daikin_creds_lifecycle():
    assert not daikin_creds.has_credentials()
    assert daikin_creds.load() is None

    # Save
    ok = daikin_creds.save("user@example.com", "tok_xyz_123", "api_key_456")
    assert ok is True
    assert daikin_creds.has_credentials()

    # Load
    creds = daikin_creds.load()
    assert creds is not None
    assert creds["email"] == "user@example.com"
    assert creds["integrator_token"] == "tok_xyz_123"
    assert creds["api_key"] == "api_key_456"

    # Clear
    assert daikin_creds.clear() is True
    assert not daikin_creds.has_credentials()
    assert daikin_creds.load() is None
