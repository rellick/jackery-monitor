"""
Daikin One Open API Client.

Interfaces with the Daikin One / Skyport Open API (https://integrator-api.daikinskyport.com)
to discover, monitor, and control Daikin smart thermostats (Daikin One+, One Touch,
One Lite, and compatible heat pump communicating systems).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
import time
from typing import Any, Callable, Coroutine

import httpx

import daikin_creds
import locations
from errors import ConfigError, IntegrationError, TransientError

log = logging.getLogger("daikin_client")

HOST = "https://integrator-api.daikinskyport.com"
TOKEN_URL = f"{HOST}/v1/token"
DEVICES_URL = f"{HOST}/v1/devices"
DEVICE_INFO_URL = f"{HOST}/v1/devices/{{device_id}}"
DEVICE_MSP_URL = f"{HOST}/v1/devices/{{device_id}}/msp"
DEVICE_SCHEDULE_URL = f"{HOST}/v1/devices/{{device_id}}/schedule"
DEVICE_FAN_URL = f"{HOST}/v1/devices/{{device_id}}/fan"

AIRCLEAN_PATH = Path(os.environ.get("JACKERY_DAIKIN_AIRCLEAN_FILE", "/data/daikin-airclean.json"))
DEFAULT_AIRCLEAN_DURATION_S = 3 * 3600  # 3 hours (10,800 seconds)

DEFAULT_REQUEST_TIMEOUT = 15.0
MIN_POLL_INTERVAL_S = 60.0  # Guard against tight polling loops (API doc recommends >= 3 min)

EQUIPMENT_STATUS_MAP: dict[int, str] = {
    0: "Off",
    1: "Cooling",
    2: "Overcool (Dehum)",
    3: "Heating",
    4: "Fan Circulating",
    5: "Idle",
}

MODE_MAP: dict[int, str] = {
    0: "off",
    1: "heat",
    2: "cool",
    3: "auto",
    4: "emergency_heat",
}

FAN_CIRCULATE_MAP: dict[int, str] = {
    0: "off",
    1: "always_on",
    2: "schedule",
}

FAN_SPEED_MAP: dict[int, str] = {
    0: "low",
    1: "medium",
    2: "high",
}


class DaikinError(IntegrationError, RuntimeError):
    """Base error for Daikin Open API failures."""


class DaikinTransientError(DaikinError, TransientError):
    """Temporary failure: network timeout, rate limit, server busy."""


class DaikinConfigError(DaikinError, ConfigError):
    """Auth failed or credentials missing."""


def _extract_float(val: Any) -> float | None:
    if val is None or isinstance(val, bool):
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _extract_int(val: Any) -> int | None:
    if val is None or isinstance(val, bool):
        return None
    try:
        return int(round(float(val)))
    except (ValueError, TypeError):
        return None


class DaikinClient:
    def __init__(self, request_timeout: float = DEFAULT_REQUEST_TIMEOUT) -> None:
        self._request_timeout = request_timeout
        self._access_token: str | None = None
        self._token_expires_at: float = 0.0
        self._last_poll_ts: float = 0.0
        self._cached_devices: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()
        self._air_clean_jobs: dict[str, dict[str, Any]] = {}
        self._air_clean_tasks: dict[str, asyncio.Task] = {}
        self._on_air_clean_change: Callable[[], Coroutine[Any, Any, None]] | None = None

    def has_credentials(self) -> bool:
        return daikin_creds.has_credentials()

    async def get_valid_token(self, force_refresh: bool = False) -> tuple[str, str]:
        """
        Return (access_token, api_key), requesting or refreshing token if necessary.
        Raises DaikinConfigError if credentials missing or invalid.
        """
        creds = daikin_creds.load()
        if not creds:
            raise DaikinConfigError("No Daikin credentials configured")

        email = creds["email"]
        integrator_token = creds["integrator_token"]
        api_key = creds["api_key"]

        now = time.time()
        if (
            not force_refresh
            and self._access_token
            and now < self._token_expires_at
        ):
            return self._access_token, api_key

        # Request new bearer token
        headers = {
            "Content-Type": "application/json",
            "x-api-key": api_key,
        }
        payload = {
            "email": email,
            "integratorToken": integrator_token,
        }

        try:
            async with httpx.AsyncClient(timeout=self._request_timeout) as client:
                res = await client.post(TOKEN_URL, json=payload, headers=headers)
        except httpx.TimeoutException as e:
            raise DaikinTransientError(f"Daikin token request timed out: {e}") from e
        except Exception as e:
            raise DaikinTransientError(f"Network error connecting to Daikin: {e}") from e

        if res.status_code in (401, 403):
            raise DaikinConfigError(
                f"Daikin authentication failed (HTTP {res.status_code}): please verify email, integrator token, and API key"
            )
        if res.status_code != 200:
            raise DaikinTransientError(
                f"Daikin token endpoint error: HTTP {res.status_code} {res.text}"
            )

        try:
            data = res.json()
        except Exception as e:
            raise DaikinTransientError(f"Invalid JSON from Daikin token endpoint: {e}") from e

        token = data.get("accessToken")
        if not token:
            raise DaikinConfigError("Daikin response did not include accessToken")

        expires_in = int(data.get("accessTokenExpiresIn") or 900)
        self._access_token = token
        # Buffer 60s to refresh slightly before expiration
        self._token_expires_at = now + max(60, expires_in - 60)
        log.info("Acquired Daikin access token (valid for %ds)", expires_in)
        return token, api_key

    async def _request(
        self,
        method: str,
        url: str,
        json_data: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """Execute authenticated request with automatic retry on 401."""
        token, api_key = await self.get_valid_token()
        headers = {
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "Authorization": f"Bearer {token}",
        }

        async with httpx.AsyncClient(timeout=self._request_timeout) as client:
            try:
                res = await client.request(method, url, json=json_data, headers=headers)
            except httpx.TimeoutException as e:
                raise DaikinTransientError(f"Request to {url} timed out: {e}") from e
            except Exception as e:
                raise DaikinTransientError(f"Network error on {url}: {e}") from e

            # If 401, token may have expired early or been revoked — refresh once
            if res.status_code == 401:
                log.info("Daikin returned 401 Unauthorized; refreshing token and retrying...")
                token, api_key = await self.get_valid_token(force_refresh=True)
                headers["Authorization"] = f"Bearer {token}"
                headers["x-api-key"] = api_key
                try:
                    res = await client.request(method, url, json=json_data, headers=headers)
                except Exception as e:
                    raise DaikinTransientError(f"Network error on retry to {url}: {e}") from e

            return res

    async def test_credentials(
        self,
        email: str,
        integrator_token: str,
        api_key: str,
    ) -> dict[str, Any]:
        """Test authentication and discover available locations/devices."""
        headers = {
            "Content-Type": "application/json",
            "x-api-key": api_key.strip(),
        }
        payload = {
            "email": email.strip(),
            "integratorToken": integrator_token.strip(),
        }

        try:
            async with httpx.AsyncClient(timeout=self._request_timeout) as client:
                res = await client.post(TOKEN_URL, json=payload, headers=headers)
        except Exception as e:
            return {"ok": False, "error": f"Connection failed: {e}"}

        if res.status_code in (401, 403):
            return {
                "ok": False,
                "error": "Authentication failed: invalid email, integrator token, or API key",
            }
        if res.status_code != 200:
            return {"ok": False, "error": f"API error: HTTP {res.status_code}"}

        try:
            tok_data = res.json()
            access_token = tok_data.get("accessToken")
        except Exception as e:
            return {"ok": False, "error": f"Failed to parse token response: {e}"}

        if not access_token:
            return {"ok": False, "error": "No access token in response"}

        # Fetch devices with the token
        dev_headers = {
            "Content-Type": "application/json",
            "x-api-key": api_key.strip(),
            "Authorization": f"Bearer {access_token}",
        }
        try:
            async with httpx.AsyncClient(timeout=self._request_timeout) as client:
                dev_res = await client.get(DEVICES_URL, headers=dev_headers)
            if dev_res.status_code == 200:
                dev_data = dev_res.json()
                loc_names = [l.get("locationName") for l in dev_data if isinstance(l, dict) and l.get("locationName")]
                total_devs = sum(len(l.get("devices") or []) for l in dev_data if isinstance(l, dict))
                return {
                    "ok": True,
                    "locations": loc_names,
                    "device_count": total_devs,
                }
            return {"ok": True, "locations": [], "device_count": 0}
        except Exception as e:
            log.warning("test_credentials device query failed: %s", e)
            return {"ok": True, "locations": [], "device_count": 0}

    async def fetch_devices(self) -> list[dict[str, Any]]:
        """Query /v1/devices to list locations and their thermostats."""
        res = await self._request("GET", DEVICES_URL)
        if res.status_code != 200:
            raise DaikinTransientError(f"Failed to fetch Daikin devices: HTTP {res.status_code} {res.text}")
        try:
            data = res.json()
            return data if isinstance(data, list) else []
        except Exception as e:
            raise DaikinTransientError(f"Invalid JSON from Daikin devices endpoint: {e}") from e

    async def fetch_device_info(self, device_id: str) -> dict[str, Any]:
        """Query /v1/devices/<id> to get current thermostat state & telemetry."""
        url = DEVICE_INFO_URL.format(device_id=device_id)
        res = await self._request("GET", url)
        if res.status_code != 200:
            raise DaikinTransientError(f"Failed to fetch Daikin device {device_id}: HTTP {res.status_code} {res.text}")
        try:
            data = res.json()
            return data if isinstance(data, dict) else {}
        except Exception as e:
            raise DaikinTransientError(f"Invalid JSON for device {device_id}: {e}") from e

    def _format_device(
        self,
        meta: dict[str, Any],
        raw_attrs: dict[str, Any],
        location_name: str,
    ) -> dict[str, Any]:
        """Convert raw Daikin device attributes into standardized system dictionary."""
        dev_id = str(meta.get("id") or "")
        dev_name = str(meta.get("name") or "Daikin Thermostat")
        model = str(meta.get("model") or "Daikin One")
        fw_ver = str(meta.get("firmwareVersion") or "")

        # Temperatures & Setpoints (°C)
        temp_indoor_c = _extract_float(raw_attrs.get("tempIndoor"))
        temp_outdoor_c = _extract_float(raw_attrs.get("tempOutdoor"))
        hum_indoor = _extract_float(raw_attrs.get("humIndoor"))
        hum_outdoor = _extract_float(raw_attrs.get("humOutdoor"))

        heat_setpoint_c = _extract_float(raw_attrs.get("heatSetpoint"))
        cool_setpoint_c = _extract_float(raw_attrs.get("coolSetpoint"))
        setpoint_delta = _extract_float(raw_attrs.get("setpointDelta")) or 2.0
        setpoint_min = _extract_float(raw_attrs.get("setpointMinimum")) or 10.0
        setpoint_max = _extract_float(raw_attrs.get("setpointMaximum")) or 32.0

        # Equipment & Mode status
        eq_status = _extract_int(raw_attrs.get("equipmentStatus"))
        if eq_status is None:
            eq_status = 0
        eq_status_desc = EQUIPMENT_STATUS_MAP.get(eq_status, "Unknown")

        mode = _extract_int(raw_attrs.get("mode"))
        if mode is None:
            mode = 0
        mode_desc = MODE_MAP.get(mode, "unknown")

        mode_limit = _extract_int(raw_attrs.get("modeLimit")) or 0
        mode_em_heat = bool(_extract_int(raw_attrs.get("modeEmHeatAvailable")) == 1)

        # Fan settings
        fan = _extract_int(raw_attrs.get("fan")) or 0
        fan_circulate = _extract_int(raw_attrs.get("fanCirculate")) or 0
        fan_circulate_speed = _extract_int(raw_attrs.get("fanCirculateSpeed")) or 0

        schedule_enabled = bool(raw_attrs.get("scheduleEnabled") is True)
        geofencing_enabled = bool(raw_attrs.get("geofencingEnabled") is True)

        # Map to configured location slug (e.g. "maison", "chalet")
        loc_cfg = locations.location_for_name(location_name)
        location_id = loc_cfg.get("id") if loc_cfg else location_name.lower().replace(" ", "-")

        # Active power estimate: when heat pump is running (heat: status 3, cool: status 1),
        # estimate based on status (or 0 if idle). Daikin doesn't provide real-time wattage
        # directly in Open API without external CT clamp, but we track active status.
        power_w = 0.0
        if eq_status in (1, 2, 3):  # Cool, Overcool, Heat
            # Nominal active running indicator (power can be updated if CT sensor added)
            power_w = 1200.0 if eq_status == 3 else 1000.0
        elif eq_status == 4:  # Fan
            power_w = 80.0

        is_online = temp_indoor_c is not None

        return {
            "id": dev_id,
            "device_sn": f"daikin_{dev_id}",
            "name": dev_name,
            "brand": "daikin",
            "device_type": "thermostat",
            "model": model,
            "firmware_version": fw_ver,
            "location_id": location_id,
            "location_name": location_name,
            "is_online": is_online,
            "temp_indoor_c": temp_indoor_c,
            "temp_outdoor_c": temp_outdoor_c,
            "hum_indoor": hum_indoor,
            "hum_outdoor": hum_outdoor,
            "equipment_status": eq_status,
            "equipment_status_desc": eq_status_desc,
            "mode": mode,
            "mode_desc": mode_desc,
            "mode_limit": mode_limit,
            "mode_em_heat_available": mode_em_heat,
            "heat_setpoint_c": heat_setpoint_c,
            "cool_setpoint_c": cool_setpoint_c,
            "setpoint_delta": setpoint_delta,
            "setpoint_min": setpoint_min,
            "setpoint_max": setpoint_max,
            "fan": fan,
            "fan_circulate": fan_circulate,
            "fan_circulate_desc": FAN_CIRCULATE_MAP.get(fan_circulate, "off"),
            "fan_circulate_speed": fan_circulate_speed,
            "fan_circulate_speed_desc": FAN_SPEED_MAP.get(fan_circulate_speed, "low"),
            "schedule_enabled": schedule_enabled,
            "geofencing_enabled": geofencing_enabled,
            "air_clean": self.get_air_clean_state(dev_id),
            "power_w": power_w,
            "last_update_ts": time.time(),
        }

    async def poll_all_devices(self, force: bool = False) -> list[dict[str, Any]]:
        """Poll all Daikin thermostats across all locations."""
        async with self._lock:
            now = time.time()
            if not force and (now - self._last_poll_ts < MIN_POLL_INTERVAL_S) and self._cached_devices:
                return list(self._cached_devices.values())

            if not daikin_creds.has_credentials():
                return []

            try:
                locations_list = await self.fetch_devices()
            except Exception as e:
                log.warning("Daikin poll failed to fetch devices: %s", e)
                return list(self._cached_devices.values())

            all_results: list[dict[str, Any]] = []
            for loc in locations_list:
                loc_name = str(loc.get("locationName") or "Home")
                devs = loc.get("devices") or []
                for d in devs:
                    did = d.get("id")
                    if not did:
                        continue
                    try:
                        attrs = await self.fetch_device_info(did)
                        formatted = self._format_device(d, attrs, loc_name)
                        all_results.append(formatted)
                        self._cached_devices[str(did)] = formatted
                    except Exception as e:
                        log.debug("Daikin failed fetching device %s: %s", did, e)

            self._last_poll_ts = time.time()
            return all_results

    def get_cached_devices(self, location_id: str | None = None) -> list[dict[str, Any]]:
        """Return the latest cached device records, optionally filtered by location ID."""
        devs = list(self._cached_devices.values())
        for d in devs:
            did = str(d.get("id") or "")
            d["air_clean"] = self.get_air_clean_state(did)
        if not location_id or location_id.lower() == "all":
            return devs
        norm_loc = location_id.strip().lower()
        return [d for d in devs if d.get("location_id", "").strip().lower() == norm_loc]

    async def set_msp(
        self,
        device_id: str,
        mode: int,
        heat_setpoint: float,
        cool_setpoint: float,
    ) -> dict[str, Any]:
        """
        Update thermostat operating mode, heating setpoint, and cooling setpoint.
        Endpoint: PUT /v1/devices/<id>/msp
        All 3 fields are required by Daikin API.
        """
        # Validate and clamp
        cached = self._cached_devices.get(str(device_id))
        delta = (cached.get("setpoint_delta") if cached else 2.0) or 2.0
        sp_min = (cached.get("setpoint_min") if cached else 10.0) or 10.0
        sp_max = (cached.get("setpoint_max") if cached else 32.0) or 32.0

        heat_sp = round(max(sp_min, min(sp_max, float(heat_setpoint))), 1)
        cool_sp = round(max(sp_min, min(sp_max, float(cool_setpoint))), 1)

        # Enforce delta: heatSetpoint must be lower than coolSetpoint by at least delta
        if heat_sp > cool_sp - delta:
            if mode == 1:  # Heat
                cool_sp = min(sp_max, heat_sp + delta)
            elif mode == 2:  # Cool
                heat_sp = max(sp_min, cool_sp - delta)
            else:  # Auto or other
                cool_sp = min(sp_max, heat_sp + delta)

        payload = {
            "mode": int(mode),
            "heatSetpoint": heat_sp,
            "coolSetpoint": cool_sp,
        }

        url = DEVICE_MSP_URL.format(device_id=device_id)
        res = await self._request("PUT", url, json_data=payload)
        if res.status_code != 200:
            raise DaikinTransientError(
                f"Failed to update mode/setpoint: HTTP {res.status_code} {res.text}"
            )

        # Optimistic cache update
        if cached:
            cached["mode"] = int(mode)
            cached["mode_desc"] = MODE_MAP.get(int(mode), "unknown")
            cached["heat_setpoint_c"] = heat_sp
            cached["cool_setpoint_c"] = cool_sp
            cached["schedule_enabled"] = False  # API turns off schedule on manual setpoint change
            cached["last_update_ts"] = time.time()

        return {"ok": True, "payload": payload}

    async def set_schedule(self, device_id: str, schedule_enabled: bool) -> dict[str, Any]:
        """
        Enable or disable thermostat schedule.
        Endpoint: PUT /v1/devices/<id>/schedule
        """
        payload = {"scheduleEnabled": bool(schedule_enabled)}
        url = DEVICE_SCHEDULE_URL.format(device_id=device_id)
        res = await self._request("PUT", url, json_data=payload)
        if res.status_code != 200:
            raise DaikinTransientError(
                f"Failed to update schedule: HTTP {res.status_code} {res.text}"
            )

        cached = self._cached_devices.get(str(device_id))
        if cached:
            cached["schedule_enabled"] = bool(schedule_enabled)
            cached["last_update_ts"] = time.time()

        return {"ok": True, "schedule_enabled": schedule_enabled}

    async def set_fan(
        self,
        device_id: str,
        fan_circulate: int,
        fan_circulate_speed: int = 0,
    ) -> dict[str, Any]:
        """
        Update fan circulate mode (0: off, 1: always on, 2: schedule) and speed (0: low, 1: med, 2: high).
        Endpoint: PUT /v1/devices/<id>/fan
        """
        payload = {
            "fanCirculate": int(fan_circulate),
            "fanCirculateSpeed": int(fan_circulate_speed),
        }
        url = DEVICE_FAN_URL.format(device_id=device_id)
        res = await self._request("PUT", url, json_data=payload)
        if res.status_code != 200:
            raise DaikinTransientError(
                f"Failed to update fan settings: HTTP {res.status_code} {res.text}"
            )

        cached = self._cached_devices.get(str(device_id))
        if cached:
            cached["fan_circulate"] = int(fan_circulate)
            cached["fan_circulate_desc"] = FAN_CIRCULATE_MAP.get(int(fan_circulate), "off")
            cached["fan_circulate_speed"] = int(fan_circulate_speed)
            cached["fan_circulate_speed_desc"] = FAN_SPEED_MAP.get(int(fan_circulate_speed), "low")
            cached["last_update_ts"] = time.time()

        return {"ok": True, "payload": payload}

    def set_broadcast_callback(
        self, cb: Callable[[], Coroutine[Any, Any, None]] | None
    ) -> None:
        """Register async callback to be called whenever air clean state changes."""
        self._on_air_clean_change = cb

    def _trigger_broadcast(self) -> None:
        if self._on_air_clean_change:
            try:
                res = self._on_air_clean_change()
                if asyncio.iscoroutine(res):
                    asyncio.create_task(res)
            except Exception as e:
                log.debug("on_air_clean_change error: %s", e)

    def _load_air_clean_jobs(self) -> dict[str, dict[str, Any]]:
        if not AIRCLEAN_PATH.exists():
            return {}
        try:
            with open(AIRCLEAN_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except Exception as e:
            log.warning("Failed to load Daikin air clean state from %s: %s", AIRCLEAN_PATH, e)
        return {}

    def _save_air_clean_jobs(self) -> None:
        try:
            AIRCLEAN_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp_path = AIRCLEAN_PATH.with_suffix(".tmp")
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(self._air_clean_jobs, f, indent=2)
            tmp_path.replace(AIRCLEAN_PATH)
        except Exception as e:
            log.warning("Failed to save Daikin air clean state to %s: %s", AIRCLEAN_PATH, e)

    def get_air_clean_state(self, device_id: str) -> dict[str, Any]:
        """Return the current air clean status and remaining duration for device."""
        did = str(device_id)
        job = self._air_clean_jobs.get(did)
        if not job:
            return {"active": False}
        now = time.time()
        rem_s = max(0, int(job["expires_at"] - now))
        return {
            "active": True,
            "started_at": job["started_at"],
            "duration_s": job["duration_s"],
            "expires_at": job["expires_at"],
            "remaining_s": rem_s,
            "previous_fan_circulate": job.get("previous_fan_circulate", 0),
            "previous_fan_circulate_speed": job.get("previous_fan_circulate_speed", 0),
        }

    async def _air_clean_timer_worker(self, device_id: str, sleep_s: float) -> None:
        """Sleep until air clean expires, then revert fan settings."""
        did = str(device_id)
        try:
            if sleep_s > 0:
                await asyncio.sleep(sleep_s)
            log.info("Air clean timer expired for %s; restoring previous fan settings...", did)
            await self.stop_air_clean(did, revert_fan=True)
        except asyncio.CancelledError:
            log.debug("Air clean timer cancelled for %s", did)
        except Exception as e:
            log.warning("Error in air clean timer worker for %s: %s", did, e)

    async def init_air_clean(self) -> None:
        """Hydrate active air clean jobs on startup and resume timers or revert expired jobs."""
        saved_jobs = self._load_air_clean_jobs()
        if not saved_jobs:
            return

        now = time.time()
        to_revert: list[tuple[str, int, int]] = []

        for did, job in list(saved_jobs.items()):
            if not isinstance(job, dict):
                continue
            expires_at = float(job.get("expires_at", 0))
            prev_circ = int(job.get("previous_fan_circulate", 0))
            prev_speed = int(job.get("previous_fan_circulate_speed", 0))

            if now >= expires_at:
                log.info("Daikin air clean expired while offline for %s; queuing fan revert...", did)
                to_revert.append((did, prev_circ, prev_speed))
            else:
                rem_s = expires_at - now
                log.info("Resuming Daikin air clean timer for %s (%.0fs remaining)...", did, rem_s)
                self._air_clean_jobs[did] = job
                self._air_clean_tasks[did] = asyncio.create_task(
                    self._air_clean_timer_worker(did, rem_s)
                )

        self._save_air_clean_jobs()

        for did, prev_circ, prev_speed in to_revert:
            try:
                await self.set_fan(did, prev_circ, prev_speed)
            except Exception as e:
                log.warning("Failed reverting expired air clean for %s: %s", did, e)

    async def start_air_clean(
        self,
        device_id: str,
        duration_s: int = DEFAULT_AIRCLEAN_DURATION_S,
    ) -> dict[str, Any]:
        """
        Start Air Clean mode: set fan to Continuous Medium for duration_s (default 3h),
        recording previous fan mode & speed to restore once expired or stopped.
        """
        did = str(device_id)
        existing_job = self._air_clean_jobs.get(did)

        if existing_job:
            prev_circ = existing_job.get("previous_fan_circulate", 0)
            prev_speed = existing_job.get("previous_fan_circulate_speed", 0)
            old_task = self._air_clean_tasks.pop(did, None)
            if old_task and not old_task.done():
                old_task.cancel()
        else:
            cached = self._cached_devices.get(did)
            if cached:
                prev_circ = cached.get("fan_circulate", 0)
                prev_speed = cached.get("fan_circulate_speed", 0)
            else:
                try:
                    attrs = await self.fetch_device_info(did)
                    prev_circ = _extract_int(attrs.get("fanCirculate")) or 0
                    prev_speed = _extract_int(attrs.get("fanCirculateSpeed")) or 0
                except Exception:
                    prev_circ = 0
                    prev_speed = 0

        # Set fan to Continuous (1) Medium (1)
        await self.set_fan(did, fan_circulate=1, fan_circulate_speed=1)

        now = time.time()
        job = {
            "device_id": did,
            "active": True,
            "started_at": now,
            "duration_s": int(duration_s),
            "expires_at": now + duration_s,
            "previous_fan_circulate": int(prev_circ),
            "previous_fan_circulate_speed": int(prev_speed),
        }
        self._air_clean_jobs[did] = job
        self._save_air_clean_jobs()

        self._air_clean_tasks[did] = asyncio.create_task(
            self._air_clean_timer_worker(did, duration_s)
        )

        state_dict = self.get_air_clean_state(did)
        cached = self._cached_devices.get(did)
        if cached:
            cached["air_clean"] = state_dict

        self._trigger_broadcast()
        return state_dict

    async def stop_air_clean(
        self,
        device_id: str,
        revert_fan: bool = True,
    ) -> dict[str, Any]:
        """Stop air clean job and optionally revert fan back to previous settings."""
        did = str(device_id)
        task = self._air_clean_tasks.pop(did, None)
        if task and task is not asyncio.current_task() and not task.done():
            task.cancel()

        job = self._air_clean_jobs.pop(did, None)
        self._save_air_clean_jobs()

        cached = self._cached_devices.get(did)
        if cached:
            cached["air_clean"] = {"active": False}

        if job and revert_fan:
            prev_circ = int(job.get("previous_fan_circulate", 0))
            prev_speed = int(job.get("previous_fan_circulate_speed", 0))
            try:
                await self.set_fan(did, prev_circ, prev_speed)
            except Exception as e:
                log.warning("Failed reverting fan settings on air clean stop for %s: %s", did, e)

        self._trigger_broadcast()
        return {"active": False}

    def cancel_air_clean(self, device_id: str) -> None:
        """Cancel air clean job without reverting fan settings (e.g. user manually altered fan)."""
        did = str(device_id)
        task = self._air_clean_tasks.pop(did, None)
        if task and not task.done():
            task.cancel()
        if did in self._air_clean_jobs:
            self._air_clean_jobs.pop(did, None)
            self._save_air_clean_jobs()
            cached = self._cached_devices.get(did)
            if cached:
                cached["air_clean"] = {"active": False}
            self._trigger_broadcast()
