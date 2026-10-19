"""
Hilo cloud account credentials (email + password) per location (e.g. Maison and Chalet).

Persists credentials encrypted at /data/hilo-creds.json (AES-256-GCM via crypto_util)
and provides load/save/clear helpers. hilo_client uses load() to authenticate
against Hydro-Québec's Hilo Azure B2C portal (connexion.hiloenergie.com).
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import crypto_util

log = logging.getLogger("hilo_creds")

PATH = os.environ.get("JACKERY_HILO_CREDS_FILE", "/data/hilo-creds.json")


def has_credentials(location_id: str | None = None) -> bool:
    """Cheap existence check — checks if creds file exists and has entries."""
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
    """Return dict of {location_id: {email, password}} or empty dict."""
    try:
        with open(PATH) as f:
            blob = json.load(f)
    except FileNotFoundError:
        return {}
    except Exception as e:
        log.warning("hilo creds file %s unreadable: %s", PATH, e)
        return {}

    if not isinstance(blob, dict) or "ct" not in blob:
        return {}
    pt = crypto_util.decrypt(blob)
    if pt is None:
        return {}
    try:
        data: Any = json.loads(pt.decode())
    except Exception as e:
        log.error("hilo creds invalid JSON after decrypt: %s", e)
        return {}

    if not isinstance(data, dict):
        return {}

    # Support legacy flat format {email, password} or multi-location format {loc_id: {email, password}}
    if "email" in data and "password" in data:
        return {"maison": {"email": str(data["email"]).strip(), "password": str(data["password"])}}

    result: dict[str, dict[str, str]] = {}
    for loc_id, cred in data.items():
        if isinstance(cred, dict) and cred.get("email") and cred.get("password"):
            result[str(loc_id).strip().lower()] = {
                "email": str(cred["email"]).strip(),
                "password": str(cred["password"]),
            }
    return result


def load(location_id: str) -> dict[str, str] | None:
    """Return {email, password} for specific location_id or None."""
    norm_id = (location_id or "").strip().lower()
    return load_all().get(norm_id)


def save(location_id: str, email: str, password: str) -> bool:
    """Encrypt and save Hilo credentials for a specific location."""
    norm_id = (location_id or "").strip().lower()
    if not norm_id:
        return False

    current = load_all()
    current[norm_id] = {
        "email": email.strip(),
        "password": password,
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
        log.error("failed to save hilo creds: %s", e)
        return False


def clear(location_id: str | None = None) -> bool:
    """Remove Hilo credentials for a location, or all locations if None."""
    if location_id is None:
        try:
            os.remove(PATH)
            return True
        except FileNotFoundError:
            return True
        except Exception as e:
            log.error("failed to delete hilo creds file: %s", e)
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
            log.error("failed to update hilo creds after removal: %s", e)
            return False
    return True
