"""
LG ThinQ cloud account credentials (Personal Access Token, Country Code, Email) per location.

Persists credentials encrypted at /data/thinq-creds.json (AES-256-GCM via crypto_util)
and provides load/save/clear helpers. thinq_client uses load() to authenticate
against LG ThinQ Connect API (api-aic.lgthinq.com / api-eic.lgthinq.com / api-kic.lgthinq.com).
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import crypto_util

log = logging.getLogger("thinq_creds")

PATH = os.environ.get("JACKERY_THINQ_CREDS_FILE", "/data/thinq-creds.json")


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
    """Return dict of {location_id: {pat, country, email}} or empty dict."""
    try:
        with open(PATH) as f:
            blob = json.load(f)
    except FileNotFoundError:
        return {}
    except Exception as e:
        log.warning("thinq creds file %s unreadable: %s", PATH, e)
        return {}

    if not isinstance(blob, dict) or "ct" not in blob:
        return {}
    pt = crypto_util.decrypt(blob)
    if pt is None:
        return {}
    try:
        data: Any = json.loads(pt.decode())
    except Exception as e:
        log.error("thinq creds invalid JSON after decrypt: %s", e)
        return {}

    if not isinstance(data, dict):
        return {}

    # Support flat format {pat, country, email} or multi-location format {loc_id: {pat, country, email}}
    if "pat" in data or "token" in data:
        token = str(data.get("pat") or data.get("token") or "").strip()
        country = str(data.get("country") or "CA").strip().upper()
        email = str(data.get("email") or "").strip()
        return {"maison": {"pat": token, "country": country, "email": email}}

    result: dict[str, dict[str, str]] = {}
    for loc_id, cred in data.items():
        if isinstance(cred, dict):
            token = str(cred.get("pat") or cred.get("token") or "").strip()
            if token:
                result[str(loc_id).strip().lower()] = {
                    "pat": token,
                    "country": str(cred.get("country") or "CA").strip().upper(),
                    "email": str(cred.get("email") or "").strip(),
                }
    return result


def load(location_id: str) -> dict[str, str] | None:
    """Return {pat, country, email} for specific location_id or None."""
    norm_id = (location_id or "").strip().lower()
    return load_all().get(norm_id)


def save(location_id: str, pat: str, country: str = "CA", email: str = "") -> bool:
    """Encrypt and save LG ThinQ credentials for a specific location."""
    norm_id = (location_id or "").strip().lower()
    if not norm_id or not pat.strip():
        return False

    current = load_all()
    current[norm_id] = {
        "pat": pat.strip(),
        "country": (country or "CA").strip().upper(),
        "email": email.strip(),
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
        log.error("failed to save thinq creds: %s", e)
        return False


def clear(location_id: str | None = None) -> bool:
    """Remove LG ThinQ credentials for a location, or all locations if None."""
    if location_id is None:
        try:
            os.remove(PATH)
            return True
        except FileNotFoundError:
            return True
        except Exception as e:
            log.error("failed to delete thinq creds file: %s", e)
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
            log.error("failed to update thinq creds after removal: %s", e)
            return False
    return True
