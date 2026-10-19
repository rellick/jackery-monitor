"""
LG ThinQ Connect Open API Client.

Interfaces with LG's official ThinQ Connect API (api-aic.lgthinq.com)
via Personal Access Tokens (PAT) generated at connect-pat.lgthinq.com.

Supports:
  - Washers, Dryers, WashTowers (cycle state, step, remaining time, door lock)
  - Refrigerators & Freezers (target & current temps, door ajar status, Express Freeze)
  - Ovens, Cooktops, Microwaves (cooking status, heating state, timers)
  - Dishwashers, Air Conditioners, Purifiers
  - Multi-location support (e.g. Maison and Chalet)
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
import time
from typing import Any
import uuid

import httpx

from errors import ConfigError, IntegrationError, TransientError
import locations
import thinq_creds

log = logging.getLogger("thinq_client")

# Official public API key for LG ThinQ Connect API
DEFAULT_API_KEY = "v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3"

DEFAULT_REQUEST_TIMEOUT = 15.0
MIN_POLL_INTERVAL_S = 15.0

# Centralized per-device polling intervals (seconds)
# Prevents an active device from unnecessarily triggering API calls for all other appliances.
INTERVAL_ACTIVE = 60.0          # Actively cooking or running a cycle (oven, cooktop, washer, dryer)
INTERVAL_STANDBY = 240.0        # Cooking & laundry appliances on standby/idle (4 minutes)
INTERVAL_REFRIGERATION = 900.0  # Refrigerator & freezer target setpoints (15 minutes)
INTERVAL_OFFLINE = 600.0        # Unplugged / breaker off / HTTP 416 (10 minutes)

# Regional gateway domain mapping
REGIONS = {
    "aic": ["CA", "US", "MX", "BR", "CL", "CO", "AR", "PE", "EC", "PA", "CR", "GT", "DO", "PR"],
    "eic": [
        "AT", "BE", "BG", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GB",
        "GR", "HR", "HU", "IE", "IS", "IT", "LT", "LU", "LV", "NL", "NO", "PL", "PT",
        "RO", "SE", "SI", "SK", "TR", "UA", "ZA", "AE", "SA", "IL"
    ],
    "kic": ["KR", "JP", "AU", "NZ", "SG", "TW", "TH", "VN", "ID", "PH", "IN", "MY", "HK"],
}


def get_region_code(country_code: str) -> str:
    norm = (country_code or "CA").strip().upper()
    for reg, countries in REGIONS.items():
        if norm in countries:
            return reg
    return "aic"  # Default to Americas


def get_base_url(country_code: str) -> str:
    reg = get_region_code(country_code)
    return f"https://api-{reg}.lgthinq.com"


class ThinQError(IntegrationError, RuntimeError):
    """Base error for LG ThinQ API failures."""


class ThinQConfigError(ThinQError, ConfigError):
    """Authentication or token error."""


class ThinQTransientError(ThinQError, TransientError):
    """Temporary failure: network timeout or rate limit."""


class ThinQClient:
    """Async client managing LG ThinQ Connect API appliances and telemetry."""

    def __init__(self, timeout: float = DEFAULT_REQUEST_TIMEOUT) -> None:
        self.timeout = timeout
        self._cached_devices: dict[str, list[dict[str, Any]]] = {}
        self._last_poll_ts: dict[str, float] = {}
        self._client_ids: dict[str, str] = {}
        self._raw_devices_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
        self._rate_limited_until: dict[str, float] = {}
        self._device_last_poll_ts: dict[str, float] = {}
        self._lock = asyncio.Lock()

    def get_device_poll_interval(self, prev_dev: dict[str, Any] | None) -> float:
        """Determine appropriate poll interval for an appliance based on its last known state."""
        if not prev_dev:
            return 0.0  # Never polled: poll immediately
        if not prev_dev.get("online", True):
            return INTERVAL_OFFLINE
        if prev_dev.get("is_running") or prev_dev.get("is_cooking"):
            return INTERVAL_ACTIVE
        if prev_dev.get("category") == "refrigeration":
            return INTERVAL_REFRIGERATION
        return INTERVAL_STANDBY

    def _get_client_id(self, location_id: str) -> str:
        norm = location_id.strip().lower()
        if norm not in self._client_ids:
            self._client_ids[norm] = f"thinq-open-{uuid.uuid4()}"
        return self._client_ids[norm]

    def _generate_message_id(self) -> str:
        return base64.urlsafe_b64encode(uuid.uuid4().bytes)[:-2].decode("utf-8")

    def _headers(self, token: str, country: str, location_id: str = "maison") -> dict[str, str]:
        return {
            "Authorization": f"Bearer {token.strip()}",
            "x-api-key": DEFAULT_API_KEY,
            "x-country": (country or "CA").strip().upper(),
            "x-client-id": self._get_client_id(location_id),
            "x-message-id": self._generate_message_id(),
            "x-service-phase": "OP",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    async def test_credentials(self, token: str, country: str = "CA") -> dict[str, Any]:
        """Test Personal Access Token against LG ThinQ Connect API."""
        if not token or not token.strip():
            return {"ok": False, "error": "Personal Access Token required"}

        country_norm = (country or "CA").strip().upper()
        base_url = get_base_url(country_norm)
        headers = self._headers(token, country_norm, "test")

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as http:
                res = await http.get(f"{base_url}/devices", headers=headers)
                if res.status_code == 200:
                    data = res.json()
                    devices = data.get("response") or []
                    return {
                        "ok": True,
                        "device_count": len(devices),
                        "devices": devices,
                    }
                else:
                    try:
                        err_json = res.json()
                        err_obj = err_json.get("error") or {}
                        msg = err_obj.get("message") or err_json.get("message") or f"HTTP {res.status_code}"
                    except Exception:
                        msg = f"HTTP {res.status_code}"
                    return {"ok": False, "error": msg}
        except Exception as e:
            log.warning("ThinQ test_credentials exception: %s", e)
            return {"ok": False, "error": str(e)}

    async def get_raw_devices(self, location_id: str, force: bool = False) -> list[dict[str, Any]]:
        """Fetch list of raw device objects from /devices with catalog caching."""
        norm_id = location_id.strip().lower()
        now = time.time()

        rate_limit_until = self._rate_limited_until.get(norm_id, 0.0)
        if rate_limit_until > now:
            raise ThinQTransientError(f"ThinQ rate limit active, retry in {int(rate_limit_until - now)}s")

        if not force and norm_id in self._raw_devices_cache:
            cache_ts, cached_list = self._raw_devices_cache[norm_id]
            if (now - cache_ts) < 1800.0:  # 30-minute cache for static device list
                return cached_list

        cred = thinq_creds.load(norm_id)
        if not cred or not cred.get("pat"):
            raise ThinQConfigError(f"No credentials saved for ThinQ location '{norm_id}'")

        token = cred["pat"]
        country = cred.get("country", "CA")
        base_url = get_base_url(country)
        headers = self._headers(token, country, norm_id)

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as http:
                res = await http.get(f"{base_url}/devices", headers=headers)
                if res.status_code == 200:
                    data = res.json()
                    raw = data.get("response") or []
                    self._raw_devices_cache[norm_id] = (now, raw)
                    return raw
                elif res.status_code in (401, 403, 429):
                    err_code, err_msg = "", ""
                    try:
                        err_json = res.json()
                        err_obj = err_json.get("error") or {}
                        err_code = str(err_obj.get("code") or err_json.get("code") or "")
                        err_msg = str(err_obj.get("message") or err_json.get("message") or "")
                    except Exception:
                        pass
                    if err_code == "1314" or "exceeded user api calls" in err_msg.lower() or res.status_code == 429:
                        self._rate_limited_until[norm_id] = now + 900.0
                        raise ThinQTransientError(f"ThinQ rate limit exceeded (code {err_code or '429'}): {err_msg or 'Exceeded User API calls'}")
                    raise ThinQConfigError(f"ThinQ authentication failed: HTTP {res.status_code} ({err_msg or 'Unauthorized'})")
                else:
                    raise ThinQTransientError(f"ThinQ /devices returned HTTP {res.status_code}")
        except (httpx.TimeoutException, httpx.NetworkError) as e:
            raise ThinQTransientError(f"ThinQ network timeout: {e}") from e

    async def get_device_state(self, location_id: str, device_id: str) -> dict[str, Any] | None:
        """Fetch real-time state for a specific device from /devices/{deviceId}/state.
        Returns state dict if succeeded, {'online': False} if officially disconnected (416),
        or None on rate-limit / transient error (so caller preserves last known state)."""
        norm_id = location_id.strip().lower()
        now = time.time()
        if self._rate_limited_until.get(norm_id, 0.0) > now:
            return None

        cred = thinq_creds.load(norm_id)
        if not cred or not cred.get("pat"):
            return None

        token = cred["pat"]
        country = cred.get("country", "CA")
        base_url = get_base_url(country)
        headers = self._headers(token, country, norm_id)

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as http:
                res = await http.get(f"{base_url}/devices/{device_id}/state", headers=headers)
                if res.status_code == 200:
                    data = res.json()
                    resp = data.get("response")
                    if isinstance(resp, dict):
                        resp["online"] = True
                        return resp
                    elif isinstance(resp, list):
                        return {"_items": resp, "online": True}
                    return {"online": True}
                elif res.status_code == 416:
                    # Appliance is offline or disconnected (LG code 1222)
                    return {"online": False}
                else:
                    err_code, err_msg = "", ""
                    try:
                        err_json = res.json()
                        err_obj = err_json.get("error") or {}
                        err_code = str(err_obj.get("code") or "")
                        err_msg = str(err_obj.get("message") or "")
                    except Exception:
                        pass
                    if err_code == "1314" or "exceeded user api calls" in err_msg.lower() or res.status_code == 429:
                        self._rate_limited_until[norm_id] = now + 900.0
                        log.warning("ThinQ rate limit exceeded (code %s) on %s: %s", err_code or '429', device_id, err_msg)
                    else:
                        log.warning("ThinQ get_device_state(%s) HTTP %d: %s", device_id, res.status_code, err_msg)
                    return None
        except Exception as e:
            log.warning("ThinQ get_device_state(%s) error: %s", device_id, e)
            return None

    async def control_device(self, location_id: str, device_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Send command to appliance via POST /devices/{deviceId}/control."""
        cred = thinq_creds.load(location_id)
        if not cred or not cred.get("pat"):
            raise ThinQConfigError(f"No credentials saved for ThinQ location '{location_id}'")

        token = cred["pat"]
        country = cred.get("country", "CA")
        base_url = get_base_url(country)
        headers = self._headers(token, country, location_id)
        headers["x-conditional-control"] = "true"

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as http:
                res = await http.post(f"{base_url}/devices/{device_id}/control", headers=headers, json=payload)
                if res.status_code == 200:
                    data = res.json()
                    return {"ok": True, "response": data.get("response")}
                else:
                    try:
                        err_json = res.json()
                        msg = err_json.get("error", {}).get("message") or f"HTTP {res.status_code}"
                    except Exception:
                        msg = f"HTTP {res.status_code}"
                    return {"ok": False, "error": msg}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def poll_location(self, location_id: str, force: bool = False, device_id: str | None = None) -> list[dict[str, Any]]:
        """Poll appliances for a specific location using centralized per-device scheduling.
        Returns the list of appliances that were actively polled/updated during this cycle.
        All cached devices remain accessible via get_cached_devices()."""
        norm_id = location_id.strip().lower()
        now = time.time()
        last_poll = self._last_poll_ts.get(norm_id, 0.0)

        rate_limit_until = self._rate_limited_until.get(norm_id, 0.0)
        if rate_limit_until > now:
            return []

        if not force and not device_id and (now - last_poll) < MIN_POLL_INTERVAL_S:
            return []

        async with self._lock:
            if not force and not device_id and (time.time() - self._last_poll_ts.get(norm_id, 0.0)) < MIN_POLL_INTERVAL_S:
                return []

            if not thinq_creds.has_credentials(norm_id):
                return []

            loc_cfg = locations.get_location(norm_id)
            loc_title = loc_cfg.get("name") if loc_cfg else norm_id.capitalize()

            try:
                raw_list = await self.get_raw_devices(norm_id, force=force)
            except Exception as e:
                log.warning("ThinQ poll_location(%s) failed to list devices: %s", norm_id, e)
                return []

            cached = self._cached_devices.get(norm_id, [])
            prev_by_id = {d["device_id"]: d for d in cached if "device_id" in d}

            updated_devices: list[dict[str, Any]] = []
            full_list: list[dict[str, Any]] = []

            for item in raw_list:
                dev_id = item.get("deviceId") or ""
                if not dev_id:
                    continue

                info = item.get("deviceInfo") or {}
                raw_type = info.get("deviceType") or "DEVICE_UNKNOWN"
                model = info.get("modelName") or ""
                alias = info.get("alias") or model or "LG Appliance"

                prev_dev = prev_by_id.get(dev_id)
                last_polled = self._device_last_poll_ts.get(dev_id, 0.0)
                interval = self.get_device_poll_interval(prev_dev)

                is_due = force or (device_id and dev_id == device_id) or (now - last_polled >= interval)

                if is_due:
                    state_dict = await self.get_device_state(norm_id, dev_id)
                    self._device_last_poll_ts[dev_id] = now

                    if state_dict is None and prev_dev:
                        # Transient failure: preserve last known state
                        pres_dev = dict(prev_dev)
                        pres_dev["last_seen"] = int(now)
                        full_list.append(pres_dev)
                    else:
                        norm_dev = self._normalize_device(
                            location_id=norm_id,
                            location_name=loc_title,
                            device_id=dev_id,
                            raw_type=raw_type,
                            model=model,
                            alias=alias,
                            state_data=state_dict if state_dict is not None else {"online": False},
                            now_ts=int(now),
                        )
                        full_list.append(norm_dev)
                        updated_devices.append(norm_dev)
                else:
                    if prev_dev:
                        full_list.append(prev_dev)

            self._cached_devices[norm_id] = full_list
            self._last_poll_ts[norm_id] = now
            if updated_devices:
                log.info("ThinQ poll for '%s': updated %d/%d appliance(s) [%s]",
                         norm_id, len(updated_devices), len(full_list),
                         ", ".join(f"{d['name']} ({'active' if (d.get('is_running') or d.get('is_cooking')) else 'idle'})" for d in updated_devices))
            return updated_devices if not force else full_list

    async def poll_all_locations(self, force: bool = False) -> list[dict[str, Any]]:
        """Poll all configured locations."""
        configured = thinq_creds.configured_locations()
        if not configured:
            return []

        all_devs: list[dict[str, Any]] = []
        for loc_id in configured:
            try:
                devs = await self.poll_location(loc_id, force=force)
                all_devs.extend(devs)
            except Exception as e:
                log.warning("Failed to poll ThinQ location '%s': %s", loc_id, e)
        return all_devs

    def get_cached_devices(self, location_id: str | None = None) -> list[dict[str, Any]]:
        """Return cached normalized devices."""
        if location_id:
            return list(self._cached_devices.get(location_id.strip().lower(), []))
        out: list[dict[str, Any]] = []
        for devs in self._cached_devices.values():
            out.extend(devs)
        return out

    def _normalize_device(
        self,
        location_id: str,
        location_name: str,
        device_id: str,
        raw_type: str,
        model: str,
        alias: str,
        state_data: dict[str, Any] | list[Any],
        now_ts: int,
    ) -> dict[str, Any]:
        """Normalize raw device info & state into a clean, frontend-ready appliance dictionary."""
        dtype_upper = raw_type.upper()
        clean_sn = f"thinq_{location_id}_{re.sub(r'[^a-zA-Z0-9_]', '_', device_id)}"

        # Category mapping
        if any(w in dtype_upper for w in ("WASHER", "DRYER", "WASHTOWER", "WASHCOMBO", "STYLER")):
            category = "laundry"
        elif any(r in dtype_upper for r in ("REFRIGERATOR", "KIMCHI", "WINE_CELLAR")):
            category = "refrigeration"
        elif any(c in dtype_upper for c in ("OVEN", "COOKTOP", "MICROWAVE")):
            category = "cooking"
        elif "DISH_WASHER" in dtype_upper or "DISHWASHER" in dtype_upper:
            category = "dishwasher"
        elif any(a in dtype_upper for a in ("AIR_CONDITIONER", "SYSTEM_BOILER", "AIR_PURIFIER", "DEHUMIDIFIER")):
            category = "climate"
        else:
            category = "other"

        if isinstance(state_data, list):
            items = state_data
            state_dict = {"_items": state_data, "online": True}
        elif isinstance(state_data, dict):
            items = state_data.get("_items") or []
            state_dict = state_data
        else:
            items = []
            state_dict = {"online": False}

        is_online = bool(state_dict.get("online", True))

        record: dict[str, Any] = {
            "device_id": device_id,
            "device_sn": clean_sn,
            "name": alias,
            "model_name": model,
            "raw_type": raw_type,
            "category": category,
            "location_id": location_id,
            "location_name": location_name,
            "online": is_online,
            "last_seen": now_ts,
            "raw_state": state_dict,
        }

        # 1. LAUNDRY (Washer / Dryer / WashTower)
        if category == "laundry":
            op_data = state_dict.get("operation") or state_dict.get("runState") or {}
            raw_state = str(op_data.get("state") or op_data.get("currentState") or op_data or state_dict.get("state") or ("STANDBY" if is_online else "OFF")).upper()

            is_running = is_online and raw_state in ("RUNNING", "WASHING", "RINSING", "SPINNING", "DRYING", "COOLING", "PAUSE")
            is_paused = is_online and raw_state == "PAUSE"
            is_complete = is_online and raw_state in ("COMPLETE", "END")

            timer_data = state_dict.get("timer") or state_dict.get("remainingTime") or {}
            remain_min = None
            if isinstance(timer_data, dict):
                r_hour = timer_data.get("remainHour") or timer_data.get("hour") or 0
                r_min = timer_data.get("remainMinute") or timer_data.get("minute") or 0
                if r_hour or r_min:
                    remain_min = int(r_hour) * 60 + int(r_min)
            elif isinstance(timer_data, (int, float)):
                remain_min = int(timer_data)

            course_data = state_dict.get("course") or state_dict.get("cycle") or {}
            course_name = course_data.get("name") if isinstance(course_data, dict) else str(course_data) if course_data else None

            step_data = state_dict.get("currentStep") or state_dict.get("process") or {}
            current_step = step_data.get("name") if isinstance(step_data, dict) else str(step_data) if step_data else None

            door_lock = state_dict.get("doorLock") or state_dict.get("doorLocked")
            door_locked = bool(door_lock.get("status") if isinstance(door_lock, dict) else door_lock)

            record.update({
                "run_state": raw_state,
                "is_running": is_running,
                "is_paused": is_paused,
                "is_complete": is_complete,
                "course": course_name,
                "current_step": current_step,
                "remaining_min": remain_min,
                "door_locked": door_locked,
                "remote_start": bool(state_dict.get("remoteControl", {}).get("enabled", False)),
            })

        # 2. REFRIGERATION (Fridge / Freezer / Wine Cellar)
        elif category == "refrigeration":
            fridge_c = None
            freezer_c = None
            fridge_f = None
            freezer_f = None

            temp_list = state_dict.get("temperatureInUnits") or []
            if not temp_list or not isinstance(temp_list, list):
                temp_list = state_dict.get("temperature") or []

            if isinstance(temp_list, list):
                for t in temp_list:
                    if not isinstance(t, dict):
                        continue
                    loc = str(t.get("locationName") or "").upper()
                    c_val = t.get("targetTemperatureC")
                    f_val = t.get("targetTemperatureF")

                    unit = str(t.get("unit") or "").upper()
                    if "targetTemperature" in t:
                        try:
                            raw_target = float(t["targetTemperature"])
                            if unit == "F" and f_val is None:
                                f_val = raw_target
                            elif unit == "C" and c_val is None:
                                c_val = raw_target
                        except (ValueError, TypeError):
                            pass

                    # Cross-calculate if one scale is not directly reported
                    if c_val is None and f_val is not None:
                        c_val = (float(f_val) - 32.0) * 5.0 / 9.0
                    elif f_val is None and c_val is not None:
                        f_val = (float(c_val) * 9.0 / 5.0) + 32.0

                    if "FRIDGE" in loc:
                        fridge_c = round(float(c_val), 1) if c_val is not None else None
                        fridge_f = round(float(f_val)) if f_val is not None else None
                    elif "FREEZER" in loc:
                        freezer_c = round(float(c_val), 1) if c_val is not None else None
                        freezer_f = round(float(f_val)) if f_val is not None else None
            elif isinstance(temp_list, dict):
                f_raw = temp_list.get("fridge") or temp_list.get("refrigerator") or state_dict.get("fridgeTemp")
                fz_raw = temp_list.get("freezer") or state_dict.get("freezerTemp")
                if isinstance(f_raw, dict): f_raw = f_raw.get("targetTemperature") or f_raw.get("currentTemperature")
                if isinstance(fz_raw, dict): fz_raw = fz_raw.get("targetTemperature") or fz_raw.get("currentTemperature")
                try:
                    fridge_c = float(f_raw) if f_raw is not None else None
                    if fridge_c is not None: fridge_f = round((fridge_c * 9.0 / 5.0) + 32.0)
                except (ValueError, TypeError):
                    pass
                try:
                    freezer_c = float(fz_raw) if fz_raw is not None else None
                    if freezer_c is not None: freezer_f = round((freezer_c * 9.0 / 5.0) + 32.0)
                except (ValueError, TypeError):
                    pass

            door_data = state_dict.get("doorStatus") or state_dict.get("door") or []
            door_opened = False
            if isinstance(door_data, list):
                door_opened = any(
                    str(d.get("doorState") or d.get("state") or "").upper() in ("OPEN", "OPENED", "TRUE")
                    for d in door_data if isinstance(d, dict)
                )
            elif isinstance(door_data, dict):
                door_opened = any(
                    str(v).upper() in ("OPEN", "OPENED", "TRUE")
                    for v in door_data.values()
                )
            elif isinstance(door_data, str):
                door_opened = door_data.upper() in ("OPEN", "OPENED")

            refrig_obj = state_dict.get("refrigeration") or {}
            express_freeze = False
            if isinstance(refrig_obj, dict) and ("expressMode" in refrig_obj or "expressFreeze" in refrig_obj):
                express_freeze = bool(refrig_obj.get("expressMode", False) or refrig_obj.get("expressFreeze", False))
            elif isinstance(state_dict.get("expressFreeze"), dict):
                express_freeze = bool(state_dict["expressFreeze"].get("status", False))
            elif isinstance(state_dict.get("expressFreeze"), bool):
                express_freeze = state_dict["expressFreeze"]
            elif isinstance(state_dict.get("icePlus"), dict):
                express_freeze = bool(state_dict["icePlus"].get("status", False))
            elif isinstance(state_dict.get("icePlus"), bool):
                express_freeze = state_dict["icePlus"]

            record.update({
                "fridge_temp_c": fridge_c,
                "freezer_temp_c": freezer_c,
                "fridge_temp_f": fridge_f,
                "freezer_temp_f": freezer_f,
                "door_opened": door_opened,
                "express_freeze": express_freeze,
                "eco_friendly": bool(state_dict.get("powerSave", {}).get("powerSaveEnabled") or state_dict.get("ecoFriendly", False)),
            })

        # 3. COOKING (Oven / Cooktop / Microwave)
        elif category == "cooking":
            is_cooking = False
            target_t = None
            current_t = None
            remain_min = None
            sub_zones = []

            is_oven = "OVEN" in dtype_upper
            is_cooktop = "COOKTOP" in dtype_upper or "HOB" in dtype_upper or "INDUCTION" in dtype_upper

            if items:
                # Multi-zone cooktop or double oven
                for it in items:
                    if not isinstance(it, dict):
                        continue
                    loc_raw = it.get("location", {}).get("locationName", "")
                    if loc_raw == "UPPER":
                        friendly_name = "Upper Cavity"
                        zone_type = "cavity"
                    elif loc_raw == "LOWER":
                        friendly_name = "Lower Cavity"
                        zone_type = "cavity"
                    elif loc_raw == "LEFT_REAR":
                        friendly_name = "Left Rear"
                        zone_type = "burner"
                    elif loc_raw == "LEFT_FRONT":
                        friendly_name = "Left Front"
                        zone_type = "burner"
                    elif loc_raw == "CENTER":
                        friendly_name = "Center"
                        zone_type = "burner"
                    elif loc_raw == "RIGHT_REAR":
                        friendly_name = "Right Rear"
                        zone_type = "burner"
                    elif loc_raw == "RIGHT_FRONT":
                        friendly_name = "Right Front"
                        zone_type = "burner"
                    else:
                        friendly_name = loc_raw.replace("_", " ").title() if loc_raw else ("Cavity" if is_oven else "Burner")
                        zone_type = "cavity" if is_oven else "burner"

                    # Zone state & mode
                    op_data = it.get("operation", {})
                    r_state = str(
                        op_data.get("currentState")
                        or it.get("runState", {}).get("currentState")
                        or it.get("cookingZone", {}).get("currentState")
                        or op_data.get("state")
                        or it.get("state")
                        or it.get("currentState")
                        or ""
                    ).upper()

                    cook_mode_raw = str(
                        op_data.get("cookMode")
                        or it.get("cook", {}).get("cookMode")
                        or it.get("cookMode")
                        or ""
                    ).upper()
                    cook_mode = cook_mode_raw if cook_mode_raw not in ("OTHERS", "NONE", "INITIAL") else ""

                    p_lvl_raw = it.get("power", {}).get("powerLevel", 0)
                    try:
                        p_lvl = float(p_lvl_raw or 0)
                    except (ValueError, TypeError):
                        p_lvl = 0.0

                    target_c = None
                    current_c = None
                    t_obj = it.get("temperature", {})
                    t_val = t_obj.get("targetTemperature") or it.get("targetTemperature")
                    if t_val:
                        unit = str(t_obj.get("unit") or it.get("unit") or "C").upper()
                        raw_t = float(t_val)
                        if raw_t > 0:
                            target_c = (raw_t - 32) * 5 / 9 if unit == "F" else raw_t

                    cur_val = (
                        t_obj.get("currentTemperature")
                        or t_obj.get("currentTemp")
                        or it.get("currentTemperature")
                        or it.get("currentTemp")
                    )
                    if cur_val:
                        unit = str(t_obj.get("unit") or it.get("unit") or "C").upper()
                        raw_c = float(cur_val)
                        if raw_c > 0:
                            current_c = (raw_c - 32) * 5 / 9 if unit == "F" else raw_c
                    elif target_c is not None and r_state in (
                        "COOKING_IN_PROGRESS",
                        "COOKING",
                        "WARMING",
                        "COOKING_IS_DONE",
                        "DONE",
                    ):
                        # LG ovens on Connect Open API schema do not report analog thermistor
                        # reading in REST payload; once preheating finishes and oven is cooking/warming,
                        # the cavity is actively regulating at target_c.
                        current_c = target_c

                    t_data = it.get("timer", {})
                    z_timer_min = None
                    if isinstance(t_data, dict):
                        rh = t_data.get("remainHour", 0)
                        rm = t_data.get("remainMinute", 0)
                        if rh or rm:
                            z_timer_min = rh * 60 + rm
                    elif "remainMinute" in it:
                        z_timer_min = int(it.get("remainMinute") or 0)

                    zone_active = (p_lvl > 0) or (r_state and r_state not in ("INITIAL", "OFF", "STANDBY")) or (target_c is not None and target_c > 0)
                    if zone_active:
                        is_cooking = True

                    sub_zones.append({
                        "id": loc_raw,
                        "name": friendly_name,
                        "zone_type": zone_type,
                        "state": r_state if (r_state and r_state != "INITIAL") else ("ON" if zone_active else "OFF"),
                        "cook_mode": cook_mode or None,
                        "power_level": p_lvl,
                        "target_temp_c": round(target_c, 1) if target_c is not None else None,
                        "current_temp_c": round(current_c, 1) if current_c is not None else None,
                        "remaining_min": z_timer_min,
                        "is_active": zone_active,
                    })

                active_zones = [z for z in sub_zones if z["is_active"]]
                if active_zones:
                    desc_parts = []
                    for z in active_zones:
                        if z["power_level"] > 0:
                            desc_parts.append(f"{z['name']}: Lvl {z['power_level']:g}")
                        elif z.get("cook_mode") and z.get("state") not in ("ON", "OFF"):
                            desc_parts.append(f"{z['name']}: {z['state']} ({z['cook_mode'].title()})")
                        elif z.get("cook_mode"):
                            desc_parts.append(f"{z['name']}: {z['cook_mode'].title()}")
                        else:
                            desc_parts.append(f"{z['name']}: {z['state']}")
                    raw_state = ", ".join(desc_parts)
                else:
                    raw_state = "STANDBY" if is_online else "OFF"

                temps = [z["target_temp_c"] for z in sub_zones if z["target_temp_c"]]
                target_t = max(temps) if temps else None
                cur_temps = [z["current_temp_c"] for z in sub_zones if z.get("current_temp_c") is not None]
                current_t = max(cur_temps) if cur_temps else None
                timers = [z["remaining_min"] for z in sub_zones if z["remaining_min"]]
                remain_min = max(timers) if timers else None
            else:
                op_data = state_dict.get("operation") or {}
                raw_state = str(
                    op_data.get("currentState")
                    or op_data.get("state")
                    or state_dict.get("state")
                    or ("STANDBY" if is_online else "OFF")
                ).upper()
                is_cooking = is_online and raw_state in ("COOKING", "PREHEATING", "WARMING", "RUNNING", "COOKING_IN_PROGRESS")

                temp_data = state_dict.get("temperature") or {}
                raw_target = temp_data.get("targetTemperature") or state_dict.get("targetTemp")
                unit = str(temp_data.get("unit") or state_dict.get("unit") or "C").upper()
                if raw_target:
                    rt = float(raw_target)
                    target_t = (rt - 32) * 5 / 9 if unit == "F" and rt > 100 else rt
                else:
                    target_t = None

                raw_cur = temp_data.get("currentTemperature") or state_dict.get("currentTemp")
                if raw_cur:
                    rc = float(raw_cur)
                    current_t = (rc - 32) * 5 / 9 if unit == "F" and rc > 100 else rc
                elif target_t and raw_state in ("COOKING", "COOKING_IN_PROGRESS", "WARMING", "RUNNING", "DONE"):
                    current_t = target_t
                else:
                    current_t = None

                timer_data = state_dict.get("timer") or {}
                if isinstance(timer_data, dict):
                    r_h = timer_data.get("remainHour") or 0
                    r_m = timer_data.get("remainMinute") or 0
                    if r_h or r_m:
                        remain_min = int(r_h) * 60 + int(r_m)

            record.update({
                "run_state": raw_state,
                "is_cooking": is_cooking,
                "target_temp_c": round(target_t, 1) if target_t is not None else None,
                "current_temp_c": round(current_t, 1) if current_t is not None else None,
                "remaining_min": remain_min,
                "sub_zones": sub_zones,
            })

        # 4. DISHWASHER
        elif category == "dishwasher":
            op_data = state_data.get("operation") or {}
            raw_state = str(op_data.get("state") or state_data.get("state") or "STANDBY").upper()
            is_running = raw_state in ("RUNNING", "WASHING", "RINSING", "DRYING", "PAUSE")

            timer_data = state_data.get("timer") or {}
            remain_min = None
            if isinstance(timer_data, dict):
                r_h = timer_data.get("remainHour") or 0
                r_m = timer_data.get("remainMinute") or 0
                if r_h or r_m:
                    remain_min = int(r_h) * 60 + int(r_m)

            record.update({
                "run_state": raw_state,
                "is_running": is_running,
                "remaining_min": remain_min,
            })

        # 5. CLIMATE
        elif category == "climate":
            temp_data = state_data.get("temperature") or {}
            cur_t = temp_data.get("currentTemperature") or state_data.get("currentTemp")
            target_t = temp_data.get("targetTemperature") or state_data.get("targetTemp")
            mode = state_data.get("airConJobMode") or state_data.get("mode") or "COOL"

            record.update({
                "is_on": bool(state_data.get("power", {}).get("status", False) or state_data.get("power", False)),
                "current_temp_c": float(cur_t) if cur_t is not None else None,
                "target_temp_c": float(target_t) if target_t is not None else None,
                "mode": str(mode).upper(),
            })

        return record
