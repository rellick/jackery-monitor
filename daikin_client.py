"""
Daikin One API Client (Dual-Mode: Mobile Skyport API + Open API Fallback).

Interfaces with:
1. Daikin Skyport Mobile API (https://api.daikinskyport.com) via email + password
   - Provides native Away / Leaf mode ("absence" / geofencingAway)
   - Real-time heat pump demand %, fan CFM, outdoor compressor metrics
2. Daikin One Open API (https://integrator-api.daikinskyport.com) via integrator_token + api_key
   - Kept in reserve as automatic fallback if the mobile API is unavailable or unconfigured.
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

# Mobile Skyport API (primary for native absence mode & rich telemetry)
MOBILE_HOST = "https://api.daikinskyport.com"
MOBILE_LOGIN_URL = f"{MOBILE_HOST}/users/auth/login"
MOBILE_REFRESH_URL = f"{MOBILE_HOST}/users/auth/token"
MOBILE_LOCATIONS_URL = f"{MOBILE_HOST}/locations"
MOBILE_DEVICES_URL = f"{MOBILE_HOST}/devices"
MOBILE_DEVICE_DATA_URL = f"{MOBILE_HOST}/deviceData/{{device_id}}"

# Official Open API (fallback / standby)
OPENAPI_HOST = "https://integrator-api.daikinskyport.com"
TOKEN_URL = f"{OPENAPI_HOST}/v1/token"
DEVICES_URL = f"{OPENAPI_HOST}/v1/devices"
DEVICE_INFO_URL = f"{OPENAPI_HOST}/v1/devices/{{device_id}}"
DEVICE_MSP_URL = f"{OPENAPI_HOST}/v1/devices/{{device_id}}/msp"
DEVICE_SCHEDULE_URL = f"{OPENAPI_HOST}/v1/devices/{{device_id}}/schedule"
DEVICE_FAN_URL = f"{OPENAPI_HOST}/v1/devices/{{device_id}}/fan"
DEVICE_GEOFENCING_URL = f"{OPENAPI_HOST}/v1/devices/{{device_id}}/geofencing"

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
    """Base error for Daikin Open/Mobile API failures."""


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
        self._mobile_access_token: str | None = None
        self._mobile_refresh_token: str | None = None
        self._mobile_token_expires_at: float = 0.0
        self._backend_in_use: str = "none"  # "mobile", "open_api", or "none"
        self._last_poll_ts: float = 0.0
        self._cached_devices: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()
        self._air_clean_jobs: dict[str, dict[str, Any]] = {}
        self._air_clean_tasks: dict[str, asyncio.Task] = {}
        self._on_air_clean_change: Callable[[], Coroutine[Any, Any, None]] | None = None

    def has_credentials(self) -> bool:
        return daikin_creds.has_credentials()

    def get_active_backend(self) -> str:
        """Return currently active backend ('mobile', 'open_api', or 'none')."""
        creds = daikin_creds.load()
        if not creds:
            return "none"
        if self._backend_in_use != "none":
            return self._backend_in_use
        return "mobile" if creds.get("password") else ("open_api" if creds.get("api_key") else "none")

    # ---------- Mobile Skyport API Authentication ----------

    async def get_mobile_token(self, force_refresh: bool = False) -> str:
        """
        Authenticate via api.daikinskyport.com with email + password.
        Uses refresh token if available and still valid.
        """
        creds = daikin_creds.load()
        if not creds or not creds.get("password"):
            raise DaikinConfigError("No Daikin password configured for Mobile API")

        email = creds["email"]
        password = creds["password"]
        now = time.time()

        if not force_refresh and self._mobile_access_token and now < self._mobile_token_expires_at:
            return self._mobile_access_token

        # Attempt token refresh first if available
        if not force_refresh and self._mobile_refresh_token:
            try:
                async with httpx.AsyncClient(timeout=self._request_timeout) as client:
                    res = await client.post(
                        MOBILE_REFRESH_URL,
                        json={"email": email, "refreshToken": self._mobile_refresh_token},
                        headers={"Content-Type": "application/json", "Accept": "application/json"},
                    )
                if res.status_code == 200:
                    data = res.json()
                    tok = data.get("accessToken")
                    if tok:
                        self._mobile_access_token = tok
                        exp = int(data.get("accessTokenExpiresIn") or 3600)
                        self._mobile_token_expires_at = now + max(60, exp - 60)
                        if data.get("refreshToken"):
                            self._mobile_refresh_token = data["refreshToken"]
                        return tok
            except Exception as e:
                log.debug("Mobile token refresh failed (%s); doing full login", e)

        # Full login with email + password
        try:
            async with httpx.AsyncClient(timeout=self._request_timeout) as client:
                res = await client.post(
                    MOBILE_LOGIN_URL,
                    json={"email": email, "password": password},
                    headers={"Content-Type": "application/json", "Accept": "application/json"},
                )
        except httpx.TimeoutException as e:
            raise DaikinTransientError(f"Mobile login request timed out: {e}") from e
        except Exception as e:
            raise DaikinTransientError(f"Network error on Daikin mobile login: {e}") from e

        if res.status_code in (400, 401, 403):
            err_msg = "Invalid email or password"
            try:
                err_msg = res.json().get("message") or err_msg
            except Exception:
                pass
            raise DaikinConfigError(f"Daikin mobile authentication failed: {err_msg}")
        if res.status_code != 200:
            raise DaikinTransientError(f"Daikin mobile login error: HTTP {res.status_code} {res.text}")

        data = res.json()
        tok = data.get("accessToken")
        if not tok:
            raise DaikinConfigError("Daikin mobile login response missing accessToken")

        exp = int(data.get("accessTokenExpiresIn") or 3600)
        self._mobile_access_token = tok
        self._mobile_refresh_token = data.get("refreshToken")
        self._mobile_token_expires_at = now + max(60, exp - 60)
        log.info("Acquired Daikin Mobile API access token (valid for %ds)", exp)
        return tok

    async def _request_mobile(
        self,
        method: str,
        url: str,
        json_data: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """Execute request to api.daikinskyport.com with Bearer token & auto-retry on 401."""
        token = await self.get_mobile_token()
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
        }
        async with httpx.AsyncClient(timeout=self._request_timeout) as client:
            try:
                res = await client.request(method, url, json=json_data, headers=headers)
            except httpx.TimeoutException as e:
                raise DaikinTransientError(f"Mobile request to {url} timed out: {e}") from e
            except Exception as e:
                raise DaikinTransientError(f"Network error on {url}: {e}") from e

            if res.status_code == 401:
                log.info("Mobile API returned 401; refreshing token...")
                token = await self.get_mobile_token(force_refresh=True)
                headers["Authorization"] = f"Bearer {token}"
                try:
                    res = await client.request(method, url, json=json_data, headers=headers)
                except Exception as e:
                    raise DaikinTransientError(f"Network error on retry to {url}: {e}") from e

            return res

    # ---------- Open API Authentication (Fallback) ----------

    async def get_valid_token(self, force_refresh: bool = False) -> tuple[str, str]:
        """
        Return (access_token, api_key) for official Open API.
        Raises DaikinConfigError if credentials missing or invalid.
        """
        creds = daikin_creds.load()
        if not creds:
            raise DaikinConfigError("No Daikin credentials configured")

        email = creds["email"]
        integrator_token = creds.get("integrator_token")
        api_key = creds.get("api_key")

        if not integrator_token or not api_key:
            raise DaikinConfigError("Missing integrator_token or api_key for Open API")

        now = time.time()
        if (
            not force_refresh
            and self._access_token
            and now < self._token_expires_at
        ):
            return self._access_token, api_key

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
                f"Daikin Open API authentication failed (HTTP {res.status_code})"
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
        self._token_expires_at = now + max(60, expires_in - 60)
        log.info("Acquired Daikin Open API access token (valid for %ds)", expires_in)
        return token, api_key

    async def _request(
        self,
        method: str,
        url: str,
        json_data: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """Execute authenticated request on Open API with automatic retry on 401."""
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

            if res.status_code == 401:
                log.info("Daikin Open API returned 401; refreshing token...")
                token, api_key = await self.get_valid_token(force_refresh=True)
                headers["Authorization"] = f"Bearer {token}"
                headers["x-api-key"] = api_key
                try:
                    res = await client.request(method, url, json=json_data, headers=headers)
                except Exception as e:
                    raise DaikinTransientError(f"Network error on retry to {url}: {e}") from e

            return res

    # ---------- Test Credentials (Dual-Mode) ----------

    async def test_credentials(
        self,
        email: str,
        password: str | None = None,
        integrator_token: str | None = None,
        api_key: str | None = None,
    ) -> dict[str, Any]:
        """Test authentication against Mobile API and/or Open API."""
        results: dict[str, Any] = {
            "ok": False,
            "mobile_ok": False,
            "open_api_ok": False,
            "locations": [],
            "device_count": 0,
        }

        # 1. Test Mobile API if password provided
        if email and password:
            try:
                async with httpx.AsyncClient(timeout=self._request_timeout) as client:
                    m_res = await client.post(
                        MOBILE_LOGIN_URL,
                        json={"email": email.strip(), "password": password.strip()},
                        headers={"Content-Type": "application/json", "Accept": "application/json"},
                    )
                if m_res.status_code == 200:
                    data = m_res.json()
                    tok = data.get("accessToken")
                    if tok:
                        results["mobile_ok"] = True
                        results["ok"] = True
                        # Retrieve locations and device count
                        headers = {"Authorization": f"Bearer {tok}", "Accept": "application/json"}
                        l_res = await client.get(MOBILE_LOCATIONS_URL, headers=headers)
                        d_res = await client.get(MOBILE_DEVICES_URL, headers=headers)
                        if l_res.status_code == 200 and isinstance(l_res.json(), list):
                            results["locations"] = [loc.get("name") for loc in l_res.json() if loc.get("name")]
                        if d_res.status_code == 200 and isinstance(d_res.json(), list):
                            results["device_count"] = len(d_res.json())
                else:
                    results["mobile_error"] = f"Mobile login failed: HTTP {m_res.status_code}"
            except Exception as e:
                results["mobile_error"] = f"Mobile connection error: {e}"

        # 2. Test Open API if integrator_token + api_key provided
        if email and integrator_token and api_key:
            try:
                headers = {"Content-Type": "application/json", "x-api-key": api_key.strip()}
                payload = {"email": email.strip(), "integratorToken": integrator_token.strip()}
                async with httpx.AsyncClient(timeout=self._request_timeout) as client:
                    o_res = await client.post(TOKEN_URL, json=payload, headers=headers)
                if o_res.status_code == 200:
                    tok = o_res.json().get("accessToken")
                    if tok:
                        results["open_api_ok"] = True
                        results["ok"] = True
                        if not results["locations"]:
                            dev_headers = {
                                "Content-Type": "application/json",
                                "x-api-key": api_key.strip(),
                                "Authorization": f"Bearer {tok}",
                            }
                            dev_res = await client.get(DEVICES_URL, headers=dev_headers)
                            if dev_res.status_code == 200 and isinstance(dev_res.json(), list):
                                dev_data = dev_res.json()
                                results["locations"] = [l.get("locationName") for l in dev_data if l.get("locationName")]
                                results["device_count"] = sum(len(l.get("devices") or []) for l in dev_data)
                else:
                    results["open_api_error"] = f"Open API token failed: HTTP {o_res.status_code}"
            except Exception as e:
                results["open_api_error"] = f"Open API error: {e}"

        return results

    # ---------- Formatting Helpers ----------

    def _format_mobile_device(
        self,
        meta: dict[str, Any],
        raw_attrs: dict[str, Any],
        location_name: str,
    ) -> dict[str, Any]:
        """Convert raw Daikin mobile API deviceData attributes into standardized system dictionary."""
        dev_id = str(meta.get("id") or "")
        dev_name = str(meta.get("name") or "Daikin Thermostat")
        model = str(meta.get("model") or "Daikin One")
        fw_ver = str(meta.get("firmwareVersion") or "")

        temp_indoor_c = _extract_float(raw_attrs.get("tempIndoor"))
        temp_outdoor_c = _extract_float(raw_attrs.get("tempOutdoor"))
        hum_indoor = _extract_float(raw_attrs.get("humIndoor"))
        hum_outdoor = _extract_float(raw_attrs.get("humOutdoor"))

        heat_setpoint_c = _extract_float(raw_attrs.get("hspActive"))
        if heat_setpoint_c is None:
            heat_setpoint_c = _extract_float(raw_attrs.get("hspHome"))
        if heat_setpoint_c is None:
            heat_setpoint_c = _extract_float(raw_attrs.get("heatSetpoint"))

        cool_setpoint_c = _extract_float(raw_attrs.get("cspActive"))
        if cool_setpoint_c is None:
            cool_setpoint_c = _extract_float(raw_attrs.get("cspHome"))
        if cool_setpoint_c is None:
            cool_setpoint_c = _extract_float(raw_attrs.get("coolSetpoint"))

        setpoint_delta = _extract_float(raw_attrs.get("setpointDelta")) or 2.0
        setpoint_min = _extract_float(raw_attrs.get("setpointMinimum")) or 10.0
        setpoint_max = _extract_float(raw_attrs.get("setpointMaximum")) or 32.0

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

        fan = _extract_int(raw_attrs.get("fan")) or 0
        fan_circulate = _extract_int(raw_attrs.get("fanCirculate")) or 0
        fan_circulate_speed = _extract_int(raw_attrs.get("fanCirculateSpeed")) or 0

        schedule_enabled = bool(raw_attrs.get("schedEnabled") is True or raw_attrs.get("scheduleEnabled") is True)
        geofencing_enabled = bool(raw_attrs.get("geofencingEnabled") is True)
        # Native leaf/away state
        geofencing_away = bool(raw_attrs.get("geofencingAway") is True or raw_attrs.get("geofencingAway") == "True")

        away_heat_sp = _extract_float(raw_attrs.get("hspAway"))
        away_cool_sp = _extract_float(raw_attrs.get("cspAway"))

        # Granular compressor & airflow telemetry
        ct_heat_demand = _extract_float(raw_attrs.get("ctOutdoorHeatRequestedDemand"))
        heatpump_demand_pct = round(ct_heat_demand / 2.0, 1) if ct_heat_demand is not None else None

        ct_cool_demand = _extract_float(raw_attrs.get("ctOutdoorCoolRequestedDemand"))
        cooling_demand_pct = round(ct_cool_demand / 2.0, 1) if ct_cool_demand is not None else None

        ct_fan_demand = _extract_float(raw_attrs.get("ctAHFanCurrentDemandStatus"))
        fan_demand_pct = round(ct_fan_demand / 2.0, 1) if ct_fan_demand is not None else None

        ct_aux_demand = _extract_float(raw_attrs.get("ctAHHeatRequestedDemand"))
        aux_heat_demand_pct = round(ct_aux_demand / 2.0, 1) if ct_aux_demand is not None else None

        fan_cfm = None
        raw_cfm = _extract_int(raw_attrs.get("ctAHCurrentIndoorAirflow"))
        if raw_cfm is not None and raw_cfm != 65535:
            fan_cfm = raw_cfm
        else:
            raw_ifc_cfm = _extract_int(raw_attrs.get("ctIFCIndoorBlowerAirflow"))
            if raw_ifc_cfm is not None and raw_ifc_cfm != 65535:
                fan_cfm = raw_ifc_cfm

        power_w = 0.0
        raw_power = _extract_float(raw_attrs.get("ctIndoorPower"))
        if raw_power is not None and raw_power > 0:
            power_w = raw_power
        elif eq_status in (1, 2, 3):
            base_w = 1200.0 if eq_status == 3 else 1000.0
            if heatpump_demand_pct is not None and heatpump_demand_pct > 0:
                power_w = round(base_w * (heatpump_demand_pct / 100.0), 1)
            else:
                power_w = base_w
        elif eq_status == 4:
            power_w = 80.0

        loc_cfg = locations.location_for_name(location_name)
        location_id = loc_cfg.get("id") if loc_cfg else location_name.lower().replace(" ", "-")

        state_details = {
            "geofencing_away": geofencing_away,
            "away_heat_setpoint_c": away_heat_sp,
            "away_cool_setpoint_c": away_cool_sp,
            "heatpump_demand_pct": heatpump_demand_pct,
            "cooling_demand_pct": cooling_demand_pct,
            "fan_demand_pct": fan_demand_pct,
            "fan_cfm": fan_cfm,
            "aux_heat_demand_pct": aux_heat_demand_pct,
            "backend": "mobile",
        }

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
            "is_online": temp_indoor_c is not None,
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
            "geofencing_away": geofencing_away,
            "away_heat_setpoint_c": away_heat_sp,
            "away_cool_setpoint_c": away_cool_sp,
            "heatpump_demand_pct": heatpump_demand_pct,
            "cooling_demand_pct": cooling_demand_pct,
            "fan_demand_pct": fan_demand_pct,
            "fan_cfm": fan_cfm,
            "aux_heat_demand_pct": aux_heat_demand_pct,
            "state_details": state_details,
            "backend": "mobile",
            "air_clean": self.get_air_clean_state(dev_id),
            "power_w": power_w,
            "last_update_ts": time.time(),
        }

    def _format_device(
        self,
        meta: dict[str, Any],
        raw_attrs: dict[str, Any],
        location_name: str,
    ) -> dict[str, Any]:
        """Convert raw Daikin Open API device attributes into standardized system dictionary."""
        dev_id = str(meta.get("id") or "")
        dev_name = str(meta.get("name") or "Daikin Thermostat")
        model = str(meta.get("model") or "Daikin One")
        fw_ver = str(meta.get("firmwareVersion") or "")

        temp_indoor_c = _extract_float(raw_attrs.get("tempIndoor"))
        temp_outdoor_c = _extract_float(raw_attrs.get("tempOutdoor"))
        hum_indoor = _extract_float(raw_attrs.get("humIndoor"))
        hum_outdoor = _extract_float(raw_attrs.get("humOutdoor"))

        heat_setpoint_c = _extract_float(raw_attrs.get("heatSetpoint"))
        cool_setpoint_c = _extract_float(raw_attrs.get("coolSetpoint"))
        setpoint_delta = _extract_float(raw_attrs.get("setpointDelta")) or 2.0
        setpoint_min = _extract_float(raw_attrs.get("setpointMinimum")) or 10.0
        setpoint_max = _extract_float(raw_attrs.get("setpointMaximum")) or 32.0

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

        fan = _extract_int(raw_attrs.get("fan")) or 0
        fan_circulate = _extract_int(raw_attrs.get("fanCirculate")) or 0
        fan_circulate_speed = _extract_int(raw_attrs.get("fanCirculateSpeed")) or 0

        schedule_enabled = bool(raw_attrs.get("scheduleEnabled") is True)
        geofencing_enabled = bool(raw_attrs.get("geofencingEnabled") is True)

        loc_cfg = locations.location_for_name(location_name)
        location_id = loc_cfg.get("id") if loc_cfg else location_name.lower().replace(" ", "-")

        power_w = 0.0
        if eq_status in (1, 2, 3):
            power_w = 1200.0 if eq_status == 3 else 1000.0
        elif eq_status == 4:
            power_w = 80.0

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
            "is_online": temp_indoor_c is not None,
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
            "geofencing_away": False,
            "state_details": {"backend": "open_api"},
            "backend": "open_api",
            "air_clean": self.get_air_clean_state(dev_id),
            "power_w": power_w,
            "last_update_ts": time.time(),
        }

    # ---------- Polling Loop (Mobile First with Open API Fallback) ----------

    async def poll_all_devices(self, force: bool = False) -> list[dict[str, Any]]:
        """
        Poll Daikin thermostats.
        1. Tries Mobile API first if password configured (provides native leaf / absence & rich telemetry).
        2. Falls back seamlessly to Open API if mobile unconfigured or encountering errors.
        """
        async with self._lock:
            now = time.time()
            if not force and (now - self._last_poll_ts < MIN_POLL_INTERVAL_S) and self._cached_devices:
                return list(self._cached_devices.values())

            creds = daikin_creds.load()
            if not creds:
                return []

            # 1. Attempt Mobile API if password present
            if creds.get("password"):
                try:
                    all_results = await self._poll_via_mobile()
                    if all_results:
                        self._backend_in_use = "mobile"
                        self._last_poll_ts = time.time()
                        return all_results
                except Exception as e:
                    log.warning("Daikin Mobile poll failed (%s); trying Open API fallback...", e)

            # 2. Open API Fallback if api_key present
            if creds.get("api_key") and creds.get("integrator_token"):
                try:
                    all_results = await self._poll_via_openapi()
                    self._backend_in_use = "open_api"
                    self._last_poll_ts = time.time()
                    return all_results
                except Exception as e:
                    log.warning("Daikin Open API fallback poll failed: %s", e)

            return list(self._cached_devices.values())

    async def _poll_via_mobile(self) -> list[dict[str, Any]]:
        """Poll devices using api.daikinskyport.com."""
        loc_res = await self._request_mobile("GET", MOBILE_LOCATIONS_URL)
        loc_map: dict[str, str] = {}
        if loc_res.status_code == 200 and isinstance(loc_res.json(), list):
            for l in loc_res.json():
                lid = str(l.get("id") or "")
                lname = str(l.get("name") or "Home")
                if lid:
                    loc_map[lid] = lname

        dev_res = await self._request_mobile("GET", MOBILE_DEVICES_URL)
        if dev_res.status_code != 200:
            raise DaikinTransientError(f"Mobile devices query failed: HTTP {dev_res.status_code}")

        dev_list = dev_res.json()
        if not isinstance(dev_list, list):
            return []

        all_results: list[dict[str, Any]] = []
        for d in dev_list:
            did = str(d.get("id") or "")
            if not did:
                continue
            loc_id = str(d.get("locationId") or "")
            loc_name = loc_map.get(loc_id) or "Home"
            try:
                data_url = MOBILE_DEVICE_DATA_URL.format(device_id=did)
                data_res = await self._request_mobile("GET", data_url)
                if data_res.status_code == 200:
                    raw_attrs = data_res.json()
                    formatted = self._format_mobile_device(d, raw_attrs, loc_name)
                    all_results.append(formatted)
                    self._cached_devices[did] = formatted
            except Exception as e:
                log.debug("Failed fetching mobile deviceData for %s: %s", did, e)

        return all_results

    async def _poll_via_openapi(self) -> list[dict[str, Any]]:
        """Poll devices using integrator-api.daikinskyport.com."""
        locations_list = await self.fetch_devices()
        all_results: list[dict[str, Any]] = []
        for loc in locations_list:
            loc_name = str(loc.get("locationName") or "Home")
            devs = loc.get("devices") or []
            for d in devs:
                did = str(d.get("id") or "")
                if not did:
                    continue
                try:
                    attrs = await self.fetch_device_info(did)
                    formatted = self._format_device(d, attrs, loc_name)
                    all_results.append(formatted)
                    self._cached_devices[did] = formatted
                except Exception as e:
                    log.debug("Open API failed fetching device %s: %s", did, e)

        return all_results

    async def fetch_devices(self) -> list[dict[str, Any]]:
        """Query Open API /v1/devices."""
        res = await self._request("GET", DEVICES_URL)
        if res.status_code != 200:
            raise DaikinTransientError(f"Failed to fetch Daikin devices: HTTP {res.status_code}")
        data = res.json()
        return data if isinstance(data, list) else []

    async def fetch_device_info(self, device_id: str) -> dict[str, Any]:
        """Query Open API /v1/devices/<id>."""
        url = DEVICE_INFO_URL.format(device_id=device_id)
        res = await self._request("GET", url)
        if res.status_code != 200:
            raise DaikinTransientError(f"Failed to fetch Daikin device {device_id}: HTTP {res.status_code}")
        data = res.json()
        return data if isinstance(data, dict) else {}

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

    # ---------- Device Controls (Away / Mode / Setpoint / Fan / Schedule) ----------

    async def set_away(
        self,
        device_id: str,
        away: bool,
        heat_setpoint: float | None = None,
        cool_setpoint: float | None = None,
        saved_state: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """
        Toggle thermostat Away (Absence / leaf) mode.
        - Mobile API: toggles native 'geofencingAway' (turns ON/OFF the leaf on the screen!).
        - Open API Fallback: applies manual setback / schedule restore.
        """
        did = str(device_id)
        cached = self._cached_devices.get(did)
        creds = daikin_creds.load() or {}

        # 1. Try Mobile API if password configured
        if creds.get("password"):
            try:
                url = MOBILE_DEVICE_DATA_URL.format(device_id=did)
                if away:
                    payload: dict[str, Any] = {"geofencingAway": True}
                    if heat_setpoint is not None:
                        payload["hspAway"] = round(float(heat_setpoint), 1)
                    if cool_setpoint is not None:
                        payload["cspAway"] = round(float(cool_setpoint), 1)
                else:
                    payload = {
                        "schedEnabled": True,
                        "schedOverride": 0,
                        "geofencingAway": False,
                    }
                res = await self._request_mobile("PUT", url, json_data=payload)
                if res.status_code == 200:
                    if cached:
                        cached["geofencing_away"] = bool(away)
                        if away and heat_setpoint is not None:
                            cached["heat_setpoint_c"] = float(heat_setpoint)
                        cached["last_update_ts"] = time.time()
                    log.info("Set Daikin %s Away=%s via Mobile API", did, away)
                    return {"ok": True, "backend": "mobile", "geofencing_away": bool(away)}
            except Exception as e:
                log.warning("Mobile API set_away failed (%s); attempting Open API fallback...", e)

        # 2. Open API Fallback
        if away:
            cur_mode = int(cached.get("mode") if cached and cached.get("mode") is not None else 3)
            if cur_mode == 0:
                cur_mode = 1
            h_sp = float(heat_setpoint or 16.0)
            c_sp = float(cool_setpoint or 25.0)
            res = await self.set_msp(device_id=did, mode=cur_mode, heat_setpoint=h_sp, cool_setpoint=c_sp)
            return {"ok": True, "backend": "open_api", "msp": res}
        else:
            prev = saved_state or {}
            was_sched = prev.get("schedule_enabled", True)
            if was_sched:
                res = await self.set_schedule(did, True)
            else:
                res = await self.set_msp(
                    device_id=did,
                    mode=int(prev.get("mode", 3)),
                    heat_setpoint=float(prev.get("heat_setpoint_c", 20.0)),
                    cool_setpoint=float(prev.get("cool_setpoint_c", 22.0)),
                )
            return {"ok": True, "backend": "open_api", "restore": res}

    async def set_msp(
        self,
        device_id: str,
        mode: int,
        heat_setpoint: float,
        cool_setpoint: float,
    ) -> dict[str, Any]:
        """Update thermostat operating mode, heating setpoint, and cooling setpoint."""
        did = str(device_id)
        cached = self._cached_devices.get(did)
        delta = (cached.get("setpoint_delta") if cached else 2.0) or 2.0
        sp_min = (cached.get("setpoint_min") if cached else 10.0) or 10.0
        sp_max = (cached.get("setpoint_max") if cached else 32.0) or 32.0

        heat_sp = round(max(sp_min, min(sp_max, float(heat_setpoint))), 1)
        cool_sp = round(max(sp_min, min(sp_max, float(cool_setpoint))), 1)

        if heat_sp > cool_sp - delta:
            if mode == 1:
                cool_sp = min(sp_max, heat_sp + delta)
            elif mode == 2:
                heat_sp = max(sp_min, cool_sp - delta)
            else:
                cool_sp = min(sp_max, heat_sp + delta)

        creds = daikin_creds.load() or {}

        # 1. Try Mobile API
        if creds.get("password"):
            try:
                url = MOBILE_DEVICE_DATA_URL.format(device_id=did)
                mobile_payload = {
                    "mode": int(mode),
                    "hspActive": heat_sp,
                    "cspActive": cool_sp,
                    "hspHome": heat_sp,
                    "cspHome": cool_sp,
                    "schedOverride": 1,
                }
                res = await self._request_mobile("PUT", url, json_data=mobile_payload)
                if res.status_code == 200:
                    if cached:
                        cached["mode"] = int(mode)
                        cached["mode_desc"] = MODE_MAP.get(int(mode), "unknown")
                        cached["heat_setpoint_c"] = heat_sp
                        cached["cool_setpoint_c"] = cool_sp
                        cached["schedule_enabled"] = False
                        cached["last_update_ts"] = time.time()
                    return {"ok": True, "payload": mobile_payload, "backend": "mobile"}
            except Exception as e:
                log.warning("Mobile set_msp failed (%s); falling back to Open API", e)

        # 2. Open API Fallback
        payload = {
            "mode": int(mode),
            "heatSetpoint": heat_sp,
            "coolSetpoint": cool_sp,
        }
        url = DEVICE_MSP_URL.format(device_id=did)
        res = await self._request("PUT", url, json_data=payload)
        if res.status_code != 200:
            raise DaikinTransientError(f"Failed to update mode/setpoint: HTTP {res.status_code} {res.text}")

        if cached:
            cached["mode"] = int(mode)
            cached["mode_desc"] = MODE_MAP.get(int(mode), "unknown")
            cached["heat_setpoint_c"] = heat_sp
            cached["cool_setpoint_c"] = cool_sp
            cached["schedule_enabled"] = False
            cached["last_update_ts"] = time.time()

        return {"ok": True, "payload": payload, "backend": "open_api"}

    async def set_schedule(self, device_id: str, schedule_enabled: bool) -> dict[str, Any]:
        """Enable or disable thermostat schedule."""
        did = str(device_id)
        cached = self._cached_devices.get(did)
        creds = daikin_creds.load() or {}

        # 1. Try Mobile API
        if creds.get("password"):
            try:
                url = MOBILE_DEVICE_DATA_URL.format(device_id=did)
                mobile_payload = {
                    "schedEnabled": bool(schedule_enabled),
                    "schedOverride": 0 if schedule_enabled else 1,
                    "geofencingAway": False,
                }
                res = await self._request_mobile("PUT", url, json_data=mobile_payload)
                if res.status_code == 200:
                    if cached:
                        cached["schedule_enabled"] = bool(schedule_enabled)
                        cached["geofencing_away"] = False
                        cached["last_update_ts"] = time.time()
                    return {"ok": True, "schedule_enabled": schedule_enabled, "backend": "mobile"}
            except Exception as e:
                log.warning("Mobile set_schedule failed (%s); trying Open API", e)

        # 2. Open API Fallback
        payload = {"scheduleEnabled": bool(schedule_enabled)}
        url = DEVICE_SCHEDULE_URL.format(device_id=did)
        res = await self._request("PUT", url, json_data=payload)
        if res.status_code != 200:
            raise DaikinTransientError(f"Failed to update schedule: HTTP {res.status_code} {res.text}")

        if cached:
            cached["schedule_enabled"] = bool(schedule_enabled)
            cached["last_update_ts"] = time.time()

        return {"ok": True, "schedule_enabled": schedule_enabled, "backend": "open_api"}

    async def set_fan(
        self,
        device_id: str,
        fan_circulate: int,
        fan_circulate_speed: int = 0,
    ) -> dict[str, Any]:
        """Update fan circulate mode (0: off, 1: always on, 2: schedule) and speed (0: low, 1: med, 2: high)."""
        did = str(device_id)
        cached = self._cached_devices.get(did)
        creds = daikin_creds.load() or {}

        # 1. Try Mobile API
        if creds.get("password"):
            try:
                url = MOBILE_DEVICE_DATA_URL.format(device_id=did)
                mobile_payload = {
                    "fanCirculate": int(fan_circulate),
                    "fanCirculateSpeed": int(fan_circulate_speed),
                }
                res = await self._request_mobile("PUT", url, json_data=mobile_payload)
                if res.status_code == 200:
                    if cached:
                        cached["fan_circulate"] = int(fan_circulate)
                        cached["fan_circulate_desc"] = FAN_CIRCULATE_MAP.get(int(fan_circulate), "off")
                        cached["fan_circulate_speed"] = int(fan_circulate_speed)
                        cached["fan_circulate_speed_desc"] = FAN_SPEED_MAP.get(int(fan_circulate_speed), "low")
                        cached["last_update_ts"] = time.time()
                    return {"ok": True, "payload": mobile_payload, "backend": "mobile"}
            except Exception as e:
                log.warning("Mobile set_fan failed (%s); trying Open API", e)

        # 2. Open API Fallback
        payload = {
            "fanCirculate": int(fan_circulate),
            "fanCirculateSpeed": int(fan_circulate_speed),
        }
        url = DEVICE_FAN_URL.format(device_id=did)
        res = await self._request("PUT", url, json_data=payload)
        if res.status_code != 200:
            raise DaikinTransientError(f"Failed to update fan settings: HTTP {res.status_code} {res.text}")

        if cached:
            cached["fan_circulate"] = int(fan_circulate)
            cached["fan_circulate_desc"] = FAN_CIRCULATE_MAP.get(int(fan_circulate), "off")
            cached["fan_circulate_speed"] = int(fan_circulate_speed)
            cached["fan_circulate_speed_desc"] = FAN_SPEED_MAP.get(int(fan_circulate_speed), "low")
            cached["last_update_ts"] = time.time()

        return {"ok": True, "payload": payload, "backend": "open_api"}

    # ---------- Air Clean Mode (Timed Medium Fan) ----------

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
        """Start Air Clean mode: set fan to Continuous Medium for duration_s (default 3h)."""
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
        """Cancel air clean job without reverting fan settings."""
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
