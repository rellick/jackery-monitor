"""
Midea / Danby cloud account credentials (email, password, app_name) per location.

Persists credentials encrypted at /data/midea-creds.json (AES-256-GCM via crypto_util)
and provides load/save/clear helpers. midea_client uses load() to authenticate
against Midea Cloud (MSmartHome / NetHome Plus) and extract local LAN device keys.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import crypto_util

log = logging.getLogger("midea_creds")

PATH = os.environ.get("JACKERY_MIDEA_CREDS_FILE", "/data/midea-creds.json")


def has_credentials(location_id: str | None = None) -> bool:
    """Check if credentials file exists and has entries."""
    all_creds = load_all()
    if not all_creds:
        return False
    if location_id:
        return location_id.strip().lower() in all_creds
    return len(all_creds) > 0


def configured_locations() -> list[str]:
    """Return list of location IDs with saved credentials."""
    return list(load_all().keys())


def load_all() -> dict[str, dict[str, str]]:
    """Return dict of {location_id: {email, password, app_name}} or empty dict."""
    try:
        with open(PATH) as f:
            blob = json.load(f)
    except FileNotFoundError:
        return {}
    except Exception as e:
        log.warning("midea creds file %s unreadable: %s", PATH, e)
        return {}

    if not isinstance(blob, dict) or "ct" not in blob:
        return {}
    pt = crypto_util.decrypt(blob)
    if pt is None:
        return {}
    try:
        data: Any = json.loads(pt.decode())
    except Exception as e:
        log.error("midea creds invalid JSON after decrypt: %s", e)
        return {}

    if not isinstance(data, dict):
        return {}

    # Support flat format {email, password, app_name} or multi-location format {loc_id: {email, password, app_name}}
    if "email" in data and "password" in data:
        email = str(data.get("email") or "").strip()
        pwd = str(data.get("password") or "")
        app_name = str(data.get("app_name") or "MSmartHome").strip()
        return {"maison": {"email": email, "password": pwd, "app_name": app_name}}

    result: dict[str, dict[str, str]] = {}
    for loc_id, cred in data.items():
        if isinstance(cred, dict):
            email = str(cred.get("email") or "").strip()
            pwd = str(cred.get("password") or "")
            app_name = str(cred.get("app_name") or "MSmartHome").strip()
            if email and pwd:
                result[str(loc_id).strip().lower()] = {
                    "email": email,
                    "password": pwd,
                    "app_name": app_name,
                }
    return result


def load(location_id: str = "maison") -> dict[str, str] | None:
    """Return {email, password, app_name} for specific location_id or None."""
    norm_id = (location_id or "").strip().lower()
    return load_all().get(norm_id)


def save(location_id: str, email: str, password: str, app_name: str = "MSmartHome") -> bool:
    """Encrypt and save Midea credentials for a specific location atomically."""
    norm_id = (location_id or "").strip().lower()
    if not norm_id or not email.strip() or not password:
        return False

    current = load_all()
    current[norm_id] = {
        "email": email.strip(),
        "password": password,
        "app_name": (app_name or "MSmartHome").strip(),
    }

    payload = json.dumps(current).encode()
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
        log.error("failed to save midea creds: %s", e)
        return False


def clear(location_id: str | None = None) -> bool:
    """Remove Midea credentials for a location, or all locations if None."""
    if location_id is None:
        try:
            os.remove(PATH)
            return True
        except FileNotFoundError:
            return True
        except Exception as e:
            log.error("failed to delete midea creds file: %s", e)
            return False

    norm_id = location_id.strip().lower()
    current = load_all()
    if norm_id in current:
        del current[norm_id]
        if not current:
            return clear(None)
        payload = json.dumps(current).encode()
        blob = crypto_util.encrypt(payload)
        try:
            tmp = PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(blob, f)
            os.replace(tmp, PATH)
            return True
        except Exception as e:
            log.error("failed to update midea creds after removal: %s", e)
            return False
    return True
