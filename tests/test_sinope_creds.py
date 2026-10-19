import os
import tempfile
import pytest

import sinope_creds
import crypto_util


@pytest.fixture(autouse=True)
def temp_creds(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        kp = os.path.join(td, ".key")
        cp = os.path.join(td, "sinope-creds.json")
        monkeypatch.setattr(crypto_util, "KEY_PATH", kp)
        monkeypatch.setattr(sinope_creds, "PATH", cp)
        yield


def test_sinope_creds_lifecycle():
    assert not sinope_creds.has_credentials()
    assert sinope_creds.load() is None

    # Save
    ok = sinope_creds.save("user@example.com", "secretpass123")
    assert ok is True
    assert sinope_creds.has_credentials()

    # Load
    creds = sinope_creds.load()
    assert creds is not None
    assert creds["email"] == "user@example.com"
    assert creds["password"] == "secretpass123"

    # Clear
    assert sinope_creds.clear() is True
    assert not sinope_creds.has_credentials()
    assert sinope_creds.load() is None
