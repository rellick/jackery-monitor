"""
Tesla credentials and EV configuration management.

Stores official Tesla Fleet / Owner API OAuth credentials (refresh token,
access token, optional client_id / client_secret), local Tesla Wall Connector
IP addresses, and location geofences encrypted at /data/tesla-creds.json
(AES-256-GCM via crypto_util).
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

import crypto_util

log = logging.getLogger("tesla_creds")

PATH = os.environ.get("JACKERY_TESLA_CREDS_FILE", "/data/tesla-creds.json")
DEFAULT_MAISON_TWC_IP = "192.168.86.41"
DEFAULT_CLIENT_ID = "ownerapi"
DEFAULT_REGION = "na"  # "na" for North America, "eu" for Europe


def default_creds() -> dict[str, Any]:
    return {
        "refresh_token": "",
        "access_token": "",
        "token_expires_at": 0.0,
        "client_id": DEFAULT_CLIENT_ID,
        "client_secret": "",
        "region": DEFAULT_REGION,
        "maison_twc_ip": DEFAULT_MAISON_TWC_IP,
        "maison_lat": 45.548963,
        "maison_lon": -73.243405,
        "chalet_twc_ip": "",
        "chalet_lat": 46.273102,
        "chalet_lon": -73.868019,
        "geofences": {},
    }


def has_credentials() -> bool:
    """Return True if either vehicle auth or a Wall Connector IP is configured."""
    creds = load()
    if not creds:
        return False
    return bool(creds.get("refresh_token") or creds.get("access_token") or creds.get("maison_twc_ip") or creds.get("chalet_twc_ip"))


def has_tesla_vehicle_auth() -> bool:
    """Return True if a valid Tesla refresh token or access token is configured."""
    creds = load()
    return bool(creds.get("refresh_token") or creds.get("access_token"))


def load() -> dict[str, Any]:
    """Return decrypted credentials dict or default settings."""
    defaults = default_creds()
    try:
        with open(PATH) as f:
            blob = json.load(f)
    except FileNotFoundError:
        return defaults
    except Exception as e:
        log.warning("tesla creds file %s unreadable: %s", PATH, e)
        return defaults

    if not isinstance(blob, dict) or "ct" not in blob:
        return defaults

    pt = crypto_util.decrypt(blob)
    if pt is None:
        return defaults

    try:
        data: Any = json.loads(pt.decode())
    except Exception as e:
        log.error("tesla creds invalid JSON after decrypt: %s", e)
        return defaults

    if not isinstance(data, dict):
        return defaults

    merged = {**defaults, **data}
    if not merged.get("maison_twc_ip"):
        merged["maison_twc_ip"] = DEFAULT_MAISON_TWC_IP
    if not merged.get("client_id"):
        merged["client_id"] = DEFAULT_CLIENT_ID
    if not merged.get("region"):
        merged["region"] = DEFAULT_REGION
    if not merged.get("maison_lat"):
        merged["maison_lat"] = defaults["maison_lat"]
    if not merged.get("maison_lon"):
        merged["maison_lon"] = defaults["maison_lon"]
    if not merged.get("chalet_lat"):
        merged["chalet_lat"] = defaults["chalet_lat"]
    if not merged.get("chalet_lon"):
        merged["chalet_lon"] = defaults["chalet_lon"]

    return merged


def save(
    refresh_token: str | None = None,
    access_token: str | None = None,
    client_id: str | None = None,
    client_secret: str | None = None,
    region: str | None = None,
    maison_twc_ip: str | None = None,
    maison_lat: float | None = None,
    maison_lon: float | None = None,
    chalet_twc_ip: str | None = None,
    chalet_lat: float | None = None,
    chalet_lon: float | None = None,
    geofences: dict[str, Any] | None = None,
) -> bool:
    """Encrypt and persist Tesla credentials."""
    current = load()

    if refresh_token is not None:
        val = refresh_token.strip()
        if not val.startswith("••"):
            current["refresh_token"] = val
    if access_token is not None:
        val = access_token.strip()
        if not val.startswith("••"):
            current["access_token"] = val
            if val:
                current["token_expires_at"] = time.time() + 28800.0
            else:
                current["token_expires_at"] = 0.0
    if client_id is not None:
        current["client_id"] = client_id.strip() or DEFAULT_CLIENT_ID
    if client_secret is not None:
        val = client_secret.strip()
        if not val.startswith("••"):
            current["client_secret"] = val
    if region is not None:
        current["region"] = region.strip().lower() or DEFAULT_REGION
    if maison_twc_ip is not None:
        current["maison_twc_ip"] = maison_twc_ip.strip()
    if maison_lat is not None:
        current["maison_lat"] = maison_lat
    if maison_lon is not None:
        current["maison_lon"] = maison_lon
    if chalet_twc_ip is not None:
        current["chalet_twc_ip"] = chalet_twc_ip.strip()
    if chalet_lat is not None:
        current["chalet_lat"] = chalet_lat
    if chalet_lon is not None:
        current["chalet_lon"] = chalet_lon
    if geofences is not None:
        current["geofences"] = geofences

    try:
        blob = crypto_util.encrypt(json.dumps(current).encode())
        os.makedirs(os.path.dirname(PATH) or ".", exist_ok=True)
        tmp = PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(blob, f)
        os.replace(tmp, PATH)
        return True
    except Exception as e:
        log.error("failed to save tesla credentials: %s", e)
        return False


def update_tokens(access_token: str, refresh_token: str | None = None, expires_in: int = 28800) -> bool:
    """Update rotated OAuth tokens without overwriting other configuration."""
    current = load()
    current["access_token"] = access_token.strip()
    if refresh_token:
        current["refresh_token"] = refresh_token.strip()
    current["token_expires_at"] = time.time() + max(60, expires_in - 300)

    try:
        blob = crypto_util.encrypt(json.dumps(current).encode())
        os.makedirs(os.path.dirname(PATH) or ".", exist_ok=True)
        tmp = PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(blob, f)
        os.replace(tmp, PATH)
        return True
    except Exception as e:
        log.error("failed to update tesla tokens: %s", e)
        return False


def clear() -> bool:
    """Remove Tesla credentials file."""
    try:
        if os.path.exists(PATH):
            os.remove(PATH)
        return True
    except Exception as e:
        log.error("failed to remove tesla credentials: %s", e)
        return False
