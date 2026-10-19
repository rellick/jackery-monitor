"""
Location / Site configuration for multi-home setups (e.g. Maison and Chalet).

Stores locations at /data/locations.json. Each location maps:
  - id: unique slug (e.g. "maison", "chalet")
  - name: friendly label ("Maison", "Chalet")
  - neviweb_name: corresponding location name in Neviweb (for automatic Sinopé device mapping)
  - plan_id: utility rate plan preset ID (e.g. "hq-tarif-d-tdt", "hq-tarif-flex-d")
  - assigned_jackerys: list of Jackery serial numbers physically located at this home
  - is_default: bool
"""

from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any

import cost

log = logging.getLogger("locations")

LOCATIONS_PATH = os.environ.get("JACKERY_LOCATIONS_FILE", "/data/locations.json")

_lock = threading.Lock()

DEFAULT_LOCATIONS: list[dict[str, Any]] = [
    {
        "id": "maison",
        "name": "Maison",
        "neviweb_name": "Maison",
        "plan_id": "hq-tarif-d-tdt",
        "is_default": True,
        "assigned_jackerys": [],
    },
    {
        "id": "chalet",
        "name": "Chalet",
        "neviweb_name": "Chalet",
        "plan_id": "hq-tarif-flex-d",
        "is_default": False,
        "assigned_jackerys": [],
    },
]


def _load_raw() -> list[dict[str, Any]]:
    try:
        with open(LOCATIONS_PATH) as f:
            data = json.load(f)
        if isinstance(data, dict) and "locations" in data:
            return list(data["locations"])
        if isinstance(data, list):
            return data
    except FileNotFoundError:
        pass
    except Exception as e:
        log.warning("locations file %s unreadable: %s; using defaults", LOCATIONS_PATH, e)
    return [dict(loc) for loc in DEFAULT_LOCATIONS]


def list_locations() -> list[dict[str, Any]]:
    """Return all configured locations."""
    with _lock:
        return _load_raw()


def get_location(location_id: str) -> dict[str, Any] | None:
    """Find a location by ID (case-insensitive)."""
    loc_id_norm = (location_id or "").strip().lower()
    for loc in list_locations():
        if loc.get("id", "").strip().lower() == loc_id_norm:
            return loc
    return None


def get_default_location() -> dict[str, Any]:
    """Return the default location or the first available one."""
    locs = list_locations()
    for loc in locs:
        if loc.get("is_default"):
            return loc
    return locs[0] if locs else dict(DEFAULT_LOCATIONS[0])


def save_locations(locations: list[dict[str, Any]]) -> bool:
    """Persist the locations list to disk atomically."""
    with _lock:
        try:
            os.makedirs(os.path.dirname(LOCATIONS_PATH) or ".", exist_ok=True)
            tmp = LOCATIONS_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"locations": locations}, f, indent=2)
            os.replace(tmp, LOCATIONS_PATH)
            return True
        except Exception as e:
            log.error("failed to save locations: %s", e)
            return False


def upsert_location(loc_data: dict[str, Any]) -> dict[str, Any]:
    """Add or update a location."""
    loc_id = (loc_data.get("id") or "").strip().lower()
    if not loc_id:
        raise ValueError("location id required")
    locs = list_locations()
    updated = False
    for i, existing in enumerate(locs):
        if existing.get("id", "").strip().lower() == loc_id:
            locs[i] = {**existing, **loc_data}
            updated = True
            break
    if not updated:
        locs.append(loc_data)
    save_locations(locs)
    return get_location(loc_id) or loc_data


def assign_jackery_to_location(device_sn: str, location_id: str) -> bool:
    """Assign a Jackery device serial number to a location, unassigning from others."""
    device_sn = (device_sn or "").strip()
    location_id = (location_id or "").strip().lower()
    if not device_sn:
        return False
    locs = list_locations()
    changed = False
    for loc in locs:
        assigned = list(loc.get("assigned_jackerys") or [])
        if loc.get("id", "").strip().lower() == location_id:
            if device_sn not in assigned:
                assigned.append(device_sn)
                loc["assigned_jackerys"] = assigned
                changed = True
        else:
            if device_sn in assigned:
                assigned.remove(device_sn)
                loc["assigned_jackerys"] = assigned
                changed = True
    if changed:
        save_locations(locs)
    return True


def location_for_jackery(device_sn: str) -> dict[str, Any] | None:
    """Return the location containing the given Jackery SN, or None."""
    device_sn = (device_sn or "").strip()
    if not device_sn:
        return None
    for loc in list_locations():
        if device_sn in (loc.get("assigned_jackerys") or []):
            return loc
    return None


def location_for_name(name: str) -> dict[str, Any] | None:
    """Map external location name (Daikin, Neviweb, etc.) to our location config."""
    name_norm = (name or "").strip().lower()
    if not name_norm:
        return None
    for loc in list_locations():
        if (loc.get("name") or "").strip().lower() == name_norm:
            return loc
        if (loc.get("id") or "").strip().lower() == name_norm:
            return loc
        if (loc.get("daikin_name") or "").strip().lower() == name_norm:
            return loc
        if (loc.get("neviweb_name") or "").strip().lower() == name_norm:
            return loc
    return None


def location_for_daikin_name(daikin_loc_name: str) -> dict[str, Any] | None:
    """Map Daikin location name (e.g. 'Maison', 'Chalet') to our location config."""
    return location_for_name(daikin_loc_name)


def location_for_neviweb_name(neviweb_loc_name: str) -> dict[str, Any] | None:
    """Map Neviweb location name (e.g. 'Maison', 'Chalet') to our location config."""
    name_norm = (neviweb_loc_name or "").strip().lower()
    if not name_norm:
        return None
    for loc in list_locations():
        if (loc.get("neviweb_name") or "").strip().lower() == name_norm:
            return loc
        if (loc.get("name") or "").strip().lower() == name_norm:
            return loc
        if (loc.get("id") or "").strip().lower() == name_norm:
            return loc
    return None


def plan_for_location(location_id: str | None) -> dict[str, Any]:
    """Resolve the cost plan for a location (preset or saved custom plan)."""
    if not location_id:
        return cost.get_plan()
    loc = get_location(location_id)
    if not loc:
        return cost.get_plan()
    plan_id = loc.get("plan_id")
    if plan_id and plan_id in cost.PRESETS:
        preset_plan = cost.PRESETS[plan_id].get("plan")
        if preset_plan:
            return dict(preset_plan)
    return cost.get_plan()
