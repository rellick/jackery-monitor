"""
Persisted registry of Kasa devices the user has tested and saved.

Rules in automation.py reference devices by `host`, so deleting a saved
device that's still referenced is allowed but warns the caller — the rule
will start failing on next evaluation, which is visible in the Logs tab.

Storage: /data/kasa_devices.json. Format:
{
  "devices": [
    {"host": "192.168.1.50", "alias": "Heater", "model": "KP125",
     "type": "PLUG", "added": <unix-ts>, "last_tested": <unix-ts>}
  ]
}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time

log = logging.getLogger("kasa_devices")

DEVICES_PATH = os.environ.get("JACKERY_KASA_DEVICES_FILE", "/data/kasa_devices.json")


class KasaRegistry:
    def __init__(self) -> None:
        self.devices: list[dict] = []
        self._lock = asyncio.Lock()
        self._load()

    def _load(self) -> None:
        try:
            with open(DEVICES_PATH) as f:
                data = json.load(f)
            self.devices = list(data.get("devices") or [])
        except FileNotFoundError:
            self.devices = []
        except Exception as e:
            log.warning("kasa devices file %s unreadable: %s; starting empty",
                        DEVICES_PATH, e)
            self.devices = []

    def _save(self) -> None:
        try:
            os.makedirs(os.path.dirname(DEVICES_PATH) or ".", exist_ok=True)
            tmp = DEVICES_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"devices": self.devices}, f, indent=2)
            os.replace(tmp, DEVICES_PATH)
        except Exception as e:
            log.error("failed to save kasa devices: %s", e)

    def list_devices(self, jackery_device_sn: str | None = None) -> list[dict]:
        """All saved Kasa devices, optionally filtered to those assigned
        to a specific Jackery. Devices with no assignment ("unassigned"
        legacy entries) are always returned regardless of filter, so a
        user with pre-assignment data isn't suddenly locked out of their
        own plugs."""
        if jackery_device_sn is None:
            return list(self.devices)
        return [
            d for d in self.devices
            if not d.get("jackery_device_sn") or
               d.get("jackery_device_sn") == jackery_device_sn
        ]

    def get(self, host: str) -> dict | None:
        return next((d for d in self.devices if d.get("host") == host), None)

    def get_device_sn(self, d: dict | str) -> str:
        """Derive standard device_sn (e.g. kasa_3c7895053f14 or kasa_192_168_86_58)."""
        if isinstance(d, str):
            dev = self.get(d)
            if dev:
                d = dev
            else:
                return f"kasa_{d.replace('.', '_')}"
        mac = d.get("mac")
        if mac:
            return f"kasa_{mac.lower().replace(':', '')}"
        host = d.get("host") or "unknown"
        return f"kasa_{host.replace('.', '_')}"

    def upsert(self, host: str, alias: str = "", model: str | None = None,
               type_: str | None = None, mark_tested: bool = False,
               jackery_device_sn: str | None = None,
               location_id: str | None = None,
               mac: str | None = None) -> dict:
        host = (host or "").strip()
        if not host:
            raise ValueError("host is required")
        alias = (alias or "").strip() or host
        now = time.time()
        # Empty string means "explicitly unassign". None means "leave as-is"
        # so a partial save (e.g. just renaming) doesn't accidentally drop
        # the existing assignment.
        normalised_assignment = (
            None if jackery_device_sn is None
            else (jackery_device_sn.strip() or None)
        )
        existing = self.get(host)
        if existing:
            existing["alias"] = alias
            if model is not None:
                existing["model"] = model
            if type_ is not None:
                existing["type"] = type_
            if mac is not None:
                existing["mac"] = mac
            if mark_tested:
                existing["last_tested"] = now
            if jackery_device_sn is not None:
                existing["jackery_device_sn"] = normalised_assignment
            if location_id is not None:
                existing["location_id"] = location_id.strip() or "maison"
        else:
            existing = {
                "host":  host,
                "alias": alias,
                "model": model,
                "type":  type_,
                "mac":   mac,
                "added": now,
                "last_tested": now if mark_tested else None,
                "jackery_device_sn": normalised_assignment,
                "location_id": (location_id or "maison").strip() or "maison",
            }
            self.devices.append(existing)
        self._save()
        return existing

    def delete(self, host: str) -> bool:
        before = len(self.devices)
        self.devices = [d for d in self.devices if d.get("host") != host]
        changed = len(self.devices) != before
        if changed:
            self._save()
        return changed

    def hosts_in_use(self, rules: list[dict]) -> set[str]:
        """Return the set of saved-device hosts referenced by any rule."""
        return {r.get("kasa_host") for r in (rules or []) if r.get("kasa_host")}

    # ---------- probe-result tracking ----------
    # The reconciler loop in server.py periodically probes each saved
    # plug and records the outcome here. The dashboard reads cached
    # state via /api/kasa/saved so it gets fast page loads + a stable
    # signal for "is this plug reachable?" without hammering the LAN
    # every time the user opens a tab.
    def update_probe(self, host: str, *, success: bool,
                     is_on: bool | None = None,
                     error: str | None = None,
                     model: str | None = None,
                     alias: str | None = None,
                     power_w: float | None = None,
                     type_: str | None = None,
                     mac: str | None = None) -> dict | None:
        d = self.get(host)
        if not d:
            return None
        now = time.time()
        if success:
            d["last_seen_ts"] = now
            d["last_error"] = None
            d["consecutive_failures"] = 0
            if is_on is not None:
                d["last_known_is_on"] = is_on
            if power_w is not None:
                d["power_w"] = power_w
            if type_ and not d.get("type"):
                d["type"] = type_
            if mac and not d.get("mac"):
                d["mac"] = mac
            # Don't overwrite a user-edited alias; only fill if empty.
            if model and not d.get("model"):
                d["model"] = model
            if alias and not d.get("alias"):
                d["alias"] = alias
        else:
            # Truncate error so an unbounded stack trace doesn't bloat
            # the JSON file.
            d["last_error"] = (str(error)[:240] if error else "probe failed")
            d["consecutive_failures"] = (d.get("consecutive_failures") or 0) + 1
            d["last_failed_ts"] = now
        self._save()
        return d

    def status_of(self, d: dict) -> str:
        """One of 'online' | 'offline' | 'unknown' (never probed)."""
        if (d.get("consecutive_failures") or 0) > 0:
            return "offline"
        if d.get("last_seen_ts"):
            return "online"
        return "unknown"

    def is_online(self, d: dict) -> bool:
        return self.status_of(d) == "online"

    def offline_count(self) -> int:
        """Number of saved devices currently in the 'offline' state.
        Used by the dashboard to render the Automation tab dot."""
        return sum(1 for d in self.devices if self.status_of(d) == "offline")
