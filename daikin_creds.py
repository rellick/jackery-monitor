"""
Daikin One Open API cloud account credentials (email, integrator_token, api_key).

Persists credentials encrypted at /data/daikin-creds.json (AES-256-GCM via crypto_util)
and provides load/save/clear helpers. daikin_client uses load() to authenticate
against https://integrator-api.daikinskyport.com/v1/token.
"""

from __future__ import annotations

import json
import logging
import os

import crypto_util

log = logging.getLogger("daikin_creds")

PATH = os.environ.get("JACKERY_DAIKIN_CREDS_FILE", "/data/daikin-creds.json")


def has_credentials() -> bool:
    """Cheap existence check — does NOT decrypt."""
    try:
        return os.path.getsize(PATH) > 0
    except OSError:
        return False


def load() -> dict | None:
    """Return {email, integrator_token, api_key} or None if no creds saved / unreadable."""
    try:
        with open(PATH) as f:
            blob = json.load(f)
    except FileNotFoundError:
        return None
    except Exception as e:
        log.warning("daikin creds file %s unreadable: %s", PATH, e)
        return None
    if not isinstance(blob, dict) or "ct" not in blob:
        return None
    pt = crypto_util.decrypt(blob)
    if pt is None:
        return None
    try:
        d = json.loads(pt.decode())
    except Exception as e:
        log.error("daikin creds invalid JSON after decrypt: %s", e)
        return None
    if d.get("email") and d.get("integrator_token") and d.get("api_key"):
        return {
            "email": str(d["email"]).strip(),
            "integrator_token": str(d["integrator_token"]).strip(),
            "api_key": str(d["api_key"]).strip(),
        }
    return None


def save(email: str, integrator_token: str, api_key: str) -> bool:
    """Encrypt and save Daikin credentials atomically."""
    payload = json.dumps({
        "email": email.strip(),
        "integrator_token": integrator_token.strip(),
        "api_key": api_key.strip(),
    }).encode()
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
        log.error("failed to save daikin creds: %s", e)
        return False


def clear() -> bool:
    """Remove Daikin credentials file."""
    try:
        os.remove(PATH)
        return True
    except FileNotFoundError:
        return True
    except Exception as e:
        log.error("failed to delete daikin creds: %s", e)
        return False
