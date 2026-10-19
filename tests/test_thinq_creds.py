import pytest
import crypto_util
import thinq_creds


def test_thinq_creds_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(crypto_util, "KEY_PATH", str(tmp_path / ".key"))
    monkeypatch.setattr(thinq_creds, "PATH", str(tmp_path / "thinq-creds.json"))

    assert thinq_creds.has_credentials() is False
    assert thinq_creds.load_all() == {}

    # Save credentials for Maison
    ok = thinq_creds.save("maison", "pat_token_12345", country="CA", email="user@example.com")
    assert ok is True
    assert thinq_creds.has_credentials() is True
    assert thinq_creds.has_credentials("maison") is True
    assert thinq_creds.has_credentials("chalet") is False
    assert thinq_creds.configured_locations() == ["maison"]

    m_cred = thinq_creds.load("maison")
    assert m_cred is not None
    assert m_cred["pat"] == "pat_token_12345"
    assert m_cred["country"] == "CA"
    assert m_cred["email"] == "user@example.com"

    # Save credentials for Chalet
    ok2 = thinq_creds.save("chalet", "pat_token_67890", country="US", email="chalet@example.com")
    assert ok2 is True
    assert thinq_creds.has_credentials("chalet") is True
    assert sorted(thinq_creds.configured_locations()) == ["chalet", "maison"]

    # Delete Maison
    thinq_creds.clear("maison")
    assert thinq_creds.has_credentials("maison") is False
    assert thinq_creds.has_credentials("chalet") is True

    # Clear all
    thinq_creds.clear()
    assert thinq_creds.has_credentials() is False
    assert thinq_creds.load_all() == {}
