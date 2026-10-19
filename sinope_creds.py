"""
Sinopé / Neviweb cloud-account credentials (email + password).

Persists credentials encrypted at /data/sinope-creds.json (AES-256-GCM via crypto_util)
and provides load/save/clear helpers. sinope_client uses load() to authenticate
against https://neviweb.com/api/login.
"""

from __future__ import annotations

import json
import logging
import os

import crypto_util

log = logging.getLogger("sinope_creds")

PATH = os.environ.get("JACKERY_SINOPE_CREDS_FILE", "/data/sinope-creds.json")


def has_credentials() -> bool:
    """Cheap existence check — does NOT decrypt."""
    try:
        return os.path.getsize(PATH) > 0
    except OSError:
        return False


def load() -> dict | None:
    """Return {email, password} or None if no creds saved / unreadable."""
    try:
        with open(PATH) as f:
            blob = json.load(f)
    except FileNotFoundError:
        return None
    except Exception as e:
        log.warning("sinope creds file %s unreadable: %s", PATH, e)
        return None
    if not isinstance(blob, dict) or "ct" not in blob:
        return None
    pt = crypto_util.decrypt(blob)
    if pt is None:
        return None
    try:
        d = json.loads(pt.decode())
    except Exception as e:
        log.error("sinope creds invalid JSON after decrypt: %s", e)
        return None
    if d.get("email") and d.get("password"):
        return {"email": str(d["email"]), "password": str(d["password"])}
    return None


def save(email: str, password: str) -> bool:
    """Encrypt and save Sinopé credentials atomically."""
    payload = json.dumps({"email": email.strip(), "password": password}).encode()
    blob = crypto_util.encrypt(payload)
    try:
        os.makedirs(os.path.dirname(PATH) or ".", exist_ok=True)
        tmp = PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(blob, f)
        try:
            os.chmod(tmp, 0o600)
        except Exception:
            pass
        os.replace(tmp, PATH)
        return True
    except Exception as e:
        log.error("failed to save sinope creds: %s", e)
        return False


def clear() -> bool:
    """Remove Sinopé credentials file."""
    try:
        os.remove(PATH)
        return True
    except FileNotFoundError:
        return True
    except Exception as e:
        log.error("failed to delete sinope creds: %s", e)
        return False
