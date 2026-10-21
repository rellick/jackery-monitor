"""
Sinopé / Neviweb Cloud API Client.

Interfaces with the Neviweb portal (https://neviweb.com/api) to poll device telemetry
for Sinopé Wi-Fi thermostats, load controllers, water heaters, and smart switches.
References Claude Gélinas' open-source neviweb/sinope implementations.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any

import httpx

import locations
import sinope_creds
from errors import ConfigError, IntegrationError, TransientError

log = logging.getLogger("sinope_client")

HOST = "https://neviweb.com"
LOGIN_URL = f"{HOST}/api/login"
LOGOUT_URL = f"{HOST}/api/logout"
LOCATIONS_URL = f"{HOST}/api/locations?account$id="
DEVICES_URL = f"{HOST}/api/devices?location$id="
GROUPS_URL = f"{HOST}/api/groups?location$id="
DEVICE_ATTR_URL = f"{HOST}/api/device/{{device_id}}/attribute"
SESSION_PATH = Path("/data/sinope-session.json")

DEFAULT_REQUEST_TIMEOUT = 15.0
MIN_POLL_INTERVAL_S = 60.0  # Guard against tight polling loops; Neviweb rate limits


class SinopeError(IntegrationError, RuntimeError):
    """Base error for Sinopé / Neviweb failures."""


class SinopeTransientError(SinopeError, TransientError):
    """Temporary failure: network timeout, server busy."""


class SinopeConfigError(SinopeError, ConfigError):
    """Auth failed or credentials missing."""


def _extract_number(val: Any) -> float | None:
    if isinstance(val, dict):
        if "value" in val:
            val = val.get("value")
        elif "percent" in val:
            val = val.get("percent")
        else:
            return None
    if val is None or isinstance(val, bool):
        return None
    try:
        return float(val)
    except (ValueError, TypeError):
        return None


def _extract_int(val: Any) -> int | None:
    num = _extract_number(val)
    return int(round(num)) if num is not None else None


def _extract_str(val: Any) -> str | None:
    if isinstance(val, dict):
        val = val.get("value") or val.get("status") or val.get("state")
    if val is None:
        return None
    return str(val)


def _is_offline(raw_attrs: dict[str, Any]) -> bool:
    if not raw_attrs:
        return False
    if "error" in raw_attrs and isinstance(raw_attrs["error"], dict):
        code = str(raw_attrs["error"].get("code", "")).upper()
        if "COMM" in code or "TIMEOUT" in code or "OFFLINE" in code:
            return True
    for v in raw_attrs.values():
        if isinstance(v, dict) and isinstance(v.get("error"), dict):
            code = str(v["error"].get("code", "")).upper()
            if "COMM" in code or "TIMEOUT" in code or "OFFLINE" in code:
                return True
    return False


def _classify_device_type(raw_dev: dict[str, Any], raw_attrs: dict[str, Any]) -> tuple[str, str]:
    """Returns (device_type, model_display_str)."""
    sku = str(raw_dev.get("sku") or "").upper()
    family = str(raw_dev.get("family") or "")
    sig = raw_dev.get("signature") or {}
    sig_model = str(sig.get("model") or "")
    dev_name = str(raw_dev.get("name") or "").lower()

    # Determine model string for display
    model_name = sku or sig_model or family or "Sinopé Device"

    # 1. Water leak sensors
    if (
        sku.startswith("WL")
        or family.startswith("505")
        or family in ("4210", "42102")
        or "fuite" in dev_name
        or "leak" in dev_name
        or "détecteur" in dev_name
        or "capteur" in dev_name
    ):
        return "leak_sensor", model_name

    # 2. Water valves
    if (
        sku.startswith("VA")
        or sku.startswith("ACT")
        or family.startswith("315")
        or "valve" in dev_name
    ):
        return "valve", model_name

    # 3. Thermostats
    if (
        sku.startswith("TH")
        or family.startswith("112")
        or family.startswith("131")
        or family.startswith("738")
        or "roomSetpoint" in raw_attrs
        or "thermostat" in dev_name
    ):
        return "thermostat", model_name

    # 4. Load Controllers
    if (
        sku.startswith("RM")
        or sku.startswith("MC")
        or family.startswith("215")
        or "calypso" in model_name.lower()
        or "chauffe-eau" in dev_name
        or "load" in dev_name
        or "controller" in dev_name
    ):
        return "controller", model_name

    # 5. Smart Switches / Dimmers
    if (
        sku.startswith("SW")
        or sku.startswith("SP")
        or sku.startswith("DM")
        or family in ("2120", "2130", "2140")
        or "switch" in dev_name
        or "gradateur" in dev_name
    ):
        return "switch", model_name

    # Fallbacks
    if "roomSetpoint" in raw_attrs:
        return "thermostat", model_name
    if "onOff" in raw_attrs:
        return "controller", model_name
    return "load", model_name


class SinopeClient:
    def __init__(self, timeout: float = DEFAULT_REQUEST_TIMEOUT) -> None:
        self.timeout = timeout
        self._session_id: str | None = None
        self._account_id: str | None = None
        self._cookies: dict[str, str] = {}
        self._cached_locations: list[dict[str, Any]] = []
        self._cached_devices: list[dict[str, Any]] = []
        self._cached_telemetry: dict[str, dict[str, Any]] = {}
        self._last_poll_ts: float = 0.0
        self._lock = asyncio.Lock()
        self._load_session()

    def _load_session(self) -> None:
        try:
            if SESSION_PATH.exists():
                data = json.loads(SESSION_PATH.read_text(encoding="utf-8"))
                sid = data.get("session_id")
                if sid:
                    self._session_id = str(sid)
                    self._account_id = str(data.get("account_id")) if data.get("account_id") else None
                    self._cookies = data.get("cookies") or {}
                    log.info("Restored persisted Neviweb session for account %s", self._account_id)
        except Exception as e:
            log.debug("Failed to load persisted Neviweb session: %s", e)

    def _save_session(self) -> None:
        try:
            if self._session_id:
                SESSION_PATH.parent.mkdir(parents=True, exist_ok=True)
                SESSION_PATH.write_text(
                    json.dumps({
                        "session_id": self._session_id,
                        "account_id": self._account_id,
                        "cookies": self._cookies,
                        "saved_at": time.time(),
                    }),
                    encoding="utf-8",
                )
        except Exception as e:
            log.debug("Failed to save Neviweb session: %s", e)

    def _clear_session(self) -> None:
        self._session_id = None
        self._account_id = None
        self._cookies.clear()
        try:
            if SESSION_PATH.exists():
                SESSION_PATH.unlink()
        except Exception:
            pass

    async def logout(self) -> None:
        if self._session_id:
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    await client.get(
                        LOGOUT_URL,
                        headers=self._get_headers(),
                        cookies=self._cookies,
                    )
            except Exception as e:
                log.debug("Error during Neviweb logout: %s", e)
        self._clear_session()

    def _get_headers(self) -> dict[str, str]:
        headers = {
            "Content-Type": "application/json",
            "User-Agent": "JackeryMonitor/1.0",
        }
        if self._session_id:
            headers["Session-Id"] = self._session_id
        return headers

    async def login(self, email: str | None = None, password: str | None = None) -> bool:
        """Authenticate against Neviweb and store the session token & cookies."""
        if not email or not password:
            creds = sinope_creds.load()
            if not creds:
                raise SinopeConfigError("No Sinopé credentials configured")
            email = creds["email"]
            password = creds["password"]

        payload = {
            "username": email.strip(),
            "email": email.strip(),
            "password": password,
            "interface": "neviweb",
            "stayConnected": 1,
        }
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                res = await client.post(
                    LOGIN_URL,
                    json=payload,
                    headers={"User-Agent": "JackeryMonitor/1.0", "Content-Type": "application/json"},
                )
        except Exception as e:
            raise SinopeTransientError(f"Connection to Neviweb failed: {e}") from e

        if res.status_code in (401, 403):
            self._session_id = None
            raise SinopeConfigError("Sinopé authentication rejected (invalid email or password)")

        if res.status_code != 200:
            self._session_id = None
            raise SinopeTransientError(f"Neviweb login error: HTTP {res.status_code}")

        data = res.json() or {}
        if "error" in data:
            err = data.get("error") or {}
            code = err.get("code") or "UNKNOWN"
            if code == "USRBADLOGIN":
                self._session_id = None
                raise SinopeConfigError("Invalid Neviweb email/username or password")
            elif code == "ACCSESSEXC":
                raise SinopeTransientError("Too many active sessions on Neviweb (please wait a few minutes)")
            elif code == "ACCRATELIMIT":
                raise SinopeTransientError("Neviweb login rate limit reached; please wait a few minutes")
            else:
                self._session_id = None
                raise SinopeError(f"Neviweb login error: {code}")

        session_id = data.get("session") or res.headers.get("Session-Id")
        if not session_id:
            raise SinopeError("Neviweb login response did not contain a session identifier")

        self._session_id = str(session_id)
        if "account" in data and isinstance(data["account"], dict):
            self._account_id = str(data["account"].get("id"))
        self._cookies = dict(res.cookies)
        self._save_session()
        log.info("Successfully authenticated with Neviweb for %s (account %s)", email, self._account_id)
        return True

    async def test_credentials(self, email: str, password: str) -> dict[str, Any]:
        """Test credentials without persisting session state."""
        try:
            payload = {
                "username": email.strip(),
                "email": email.strip(),
                "password": password,
                "interface": "neviweb",
                "stayConnected": 1,
            }
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                res = await client.post(
                    LOGIN_URL,
                    json=payload,
                    headers={"User-Agent": "JackeryMonitor/1.0", "Content-Type": "application/json"},
                )
                if res.status_code in (401, 403):
                    return {"ok": False, "error": "Invalid email or password"}
                if res.status_code != 200:
                    return {"ok": False, "error": f"Neviweb returned HTTP {res.status_code}"}

                data = res.json() or {}
                if "error" in data:
                    err = data.get("error") or {}
                    code = err.get("code") or "UNKNOWN"
                    if code == "USRBADLOGIN":
                        return {"ok": False, "error": "Invalid Neviweb email or password"}
                    elif code == "ACCSESSEXC":
                        return {"ok": False, "error": "Too many active sessions on Neviweb (please wait a few minutes)"}
                    elif code == "ACCRATELIMIT":
                        return {"ok": False, "error": "Neviweb login rate limit reached; please wait a few minutes"}
                    return {"ok": False, "error": f"Neviweb error: {code}"}

                session_id = data.get("session") or res.headers.get("Session-Id")
                if not session_id:
                    return {"ok": False, "error": "Login succeeded but no session returned"}

                account_id = ""
                if "account" in data and isinstance(data["account"], dict):
                    account_id = str(data["account"].get("id"))

                # Try fetching locations to verify account scope
                loc_url = f"{LOCATIONS_URL}{account_id}" if account_id else LOCATIONS_URL
                loc_res = await client.get(
                    loc_url,
                    headers={"Session-Id": str(session_id), "User-Agent": "JackeryMonitor/1.0"},
                    cookies=res.cookies,
                )
                locs = loc_res.json() if loc_res.status_code == 200 else []
                return {
                    "ok": True,
                    "locations": [{"id": l.get("id"), "name": l.get("name")} for l in (locs if isinstance(locs, list) else [])],
                }
        except Exception as e:
            return {"ok": False, "error": str(e)}

    async def _request_with_reauth(self, method: str, url: str, **kwargs) -> httpx.Response:
        """Execute HTTP request, transparently re-authenticating on 401/403 or session expiry."""
        if not self._session_id:
            await self.login()

        headers = kwargs.pop("headers", {})
        headers.update(self._get_headers())
        cookies = kwargs.pop("cookies", self._cookies)

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            res = await client.request(method, url, headers=headers, cookies=cookies, **kwargs)
            needs_reauth = False
            if res.status_code in (401, 403):
                needs_reauth = True
            elif res.status_code == 200:
                try:
                    j = res.json()
                    if isinstance(j, dict) and j.get("error", {}).get("code") == "USRSESSEXP":
                        needs_reauth = True
                except Exception:
                    pass

            if needs_reauth:
                log.info("Neviweb session expired; renewing session...")
                self._clear_session()
                await self.login()
                headers.update(self._get_headers())
                res = await client.request(method, url, headers=headers, cookies=self._cookies, **kwargs)

            if res.cookies:
                self._cookies.update(dict(res.cookies))
        return res

    async def fetch_locations(self) -> list[dict[str, Any]]:
        """Fetch all locations (e.g. Maison, Chalet) on the account."""
        if not self._session_id:
            await self.login()
        url = f"{LOCATIONS_URL}{self._account_id}" if self._account_id else LOCATIONS_URL
        res = await self._request_with_reauth("GET", url)
        if res.status_code != 200:
            raise SinopeTransientError(f"Failed to fetch locations: HTTP {res.status_code}")
        data = res.json()
        locs = data if isinstance(data, list) else []
        self._cached_locations = locs
        return locs

    async def fetch_devices_for_location(self, location_id: int | str) -> list[dict[str, Any]]:
        """Fetch all devices registered under a specific location."""
        url = f"{DEVICES_URL}{location_id}"
        res = await self._request_with_reauth("GET", url)
        if res.status_code != 200:
            raise SinopeTransientError(f"Failed to fetch devices for location {location_id}: HTTP {res.status_code}")
        data = res.json()
        return data if isinstance(data, list) else []

    async def fetch_groups_for_location(self, location_id: int | str) -> dict[int | str, str]:
        """Fetch all groups/rooms for a location and return a mapping of group_id -> room_name."""
        url = f"{GROUPS_URL}{location_id}"
        try:
            res = await self._request_with_reauth("GET", url)
            if res.status_code != 200:
                log.warning("Failed to fetch groups for location %s: HTTP %s", location_id, res.status_code)
                return {}
            data = res.json()
            if not isinstance(data, list):
                return {}
            groups: dict[int | str, str] = {}
            for g in data:
                gid = g.get("id")
                gname = g.get("name")
                if gid is not None and gname:
                    name_str = str(gname).strip()
                    groups[gid] = name_str
                    groups[str(gid)] = name_str
            return groups
        except Exception as e:
            log.warning("Error fetching groups for location %s: %s", location_id, e)
            return {}

    async def fetch_device_attributes(self, device_id: int | str) -> dict[str, Any]:
        """Fetch real-time attributes for a single Sinopé device."""
        attrs = [
            "roomTemperature",
            "roomSetpoint",
            "outputPercentDisplay",
            "loadWatt",
            "loadWattNow",
            "activePower",
            "onOff",
            "drStatus",
            "hourlyKwhCount",
            "batteryVoltage",
            "batteryStatus",
            "batteryPercentNormalized",
            "waterLeakStatus",
            "leakAlert",
            "motorPosition",
            "valveStatus",
            "status",
            "closure",
            "waterTemperature",
            "wifiRssi",
        ]
        url = f"{DEVICE_ATTR_URL.format(device_id=device_id)}?attributes={','.join(attrs)}"
        res = await self._request_with_reauth("GET", url)
        if res.status_code != 200:
            log.warning("Failed to fetch attributes for device %s: HTTP %s", device_id, res.status_code)
            return {}
        data = res.json()
        return data if isinstance(data, dict) else {}

    async def fetch_device_consumption(self, device_id: int | str, period: str = "hourly") -> list[dict[str, Any]]:
        """Fetch hourly or daily energy consumption history from Neviweb.

        period: 'hourly' or 'daily'
        Returns list of {'date': iso_str, 'period': wh_float}
        """
        url = f"{HOST}/api/device/{device_id}/consumption/{period}"
        try:
            res = await self._request_with_reauth("GET", url)
            if res.status_code != 200:
                log.warning("Failed to fetch %s consumption for device %s: HTTP %s", period, device_id, res.status_code)
                return []
            data = res.json()
            if not isinstance(data, dict):
                return []
            return data.get("history", [])
        except Exception as e:
            log.warning("Error fetching %s consumption for device %s: %s", period, device_id, e)
            return []

    def _classify_and_format_device(
        self,
        raw_dev: dict[str, Any],
        raw_attrs: dict[str, Any],
        loc_name: str,
        room_name: str | None = None,
    ) -> dict[str, Any]:
        """Convert raw Neviweb device + attributes into a normalized telemetry object."""
        dev_id = str(raw_dev.get("id"))
        device_type, model = _classify_device_type(raw_dev, raw_attrs)

        raw_name = str(raw_dev.get("name") or "").strip()
        sku = str(raw_dev.get("sku") or "").upper().strip()
        sig = raw_dev.get("signature") or {}
        sig_model = str(sig.get("model") or "").upper().strip()

        # If name is missing, equals model/SKU, or is generic, prefer room name
        is_generic = (
            not raw_name
            or raw_name.upper() == sku
            or raw_name.upper() == sig_model
            or raw_name.upper() == model.upper()
            or raw_name.lower().startswith("sinopé")
            or raw_name.lower().startswith("sinope")
        )

        if room_name and is_generic:
            dev_name = room_name
        elif raw_name:
            dev_name = raw_name
        elif room_name:
            dev_name = room_name
        else:
            dev_name = model or f"Sinopé {dev_id}"

        is_online = not _is_offline(raw_attrs)

        # Temperatures & Setpoints (safe extraction from nested dict or bare float)
        room_temp_c = _extract_number(raw_attrs.get("roomTemperature"))
        setpoint_c = _extract_number(raw_attrs.get("roomSetpoint"))
        water_temp_c = _extract_number(
            raw_attrs.get("waterTemperature")
            or raw_attrs.get("waterTemp")
            or raw_attrs.get("tankTemperature")
        )

        # Heating duty cycle % (0 to 100)
        output_pct = _extract_int(raw_attrs.get("outputPercentDisplay"))
        if device_type == "thermostat":
            heat_level_pct = output_pct if output_pct is not None else 0
        else:
            heat_level_pct = output_pct

        # Load wattage & Active power draw (W)
        load_watt = _extract_number(raw_attrs.get("loadWatt"))
        load_watt_now = _extract_number(raw_attrs.get("loadWattNow"))
        active_power = _extract_number(raw_attrs.get("activePower"))

        # Switch status (ON / OFF)
        on_off_raw = raw_attrs.get("onOff")
        if device_type == "thermostat":
            is_on = bool(heat_level_pct and heat_level_pct > 0)
        elif on_off_raw is not None:
            on_off_str = _extract_str(on_off_raw) or ""
            is_on = bool(on_off_raw == 1 or on_off_raw is True or on_off_str.lower() in ("1", "on", "true"))
        else:
            is_on = None

        # Detect water heater controller (RM3500WF, Calypso, etc.)
        is_water_heater = bool(
            sku.startswith("RM")
            or sig_model.startswith("RM")
            or "calypso" in model.lower()
            or "chauffe-eau" in dev_name.lower()
            or "water" in dev_name.lower()
            or water_temp_c is not None
        )

        # Compute active power
        if load_watt_now is not None:
            active_power_w = round(max(0.0, load_watt_now), 1)
        elif active_power is not None:
            active_power_w = round(max(0.0, active_power), 1)
        elif device_type == "thermostat" and load_watt is not None and heat_level_pct is not None:
            active_power_w = round((heat_level_pct / 100.0) * load_watt, 1)
        elif is_water_heater:
            # Water heater controllers (RM3500WF) report real-time power draw via loadWattNow.
            # If loadWattNow is unavailable, fallback to 0.0 to prevent phantom energy accumulation
            # since internal mechanical thermostats cycle elements independently of relay state.
            active_power_w = 0.0
        elif is_on and load_watt is not None:
            active_power_w = round(load_watt, 1)
        else:
            active_power_w = 0.0

        # Demand Response / Peak event status
        dr_raw = raw_attrs.get("drStatus")
        dr_status: str | None = None
        if isinstance(dr_raw, dict):
            dr_active = (
                dr_raw.get("drActive") == "on"
                or dr_raw.get("powerAbsolute") == "on"
                or dr_raw.get("setpoint") == "on"
            )
            dr_status = "active" if dr_active else "idle"
        elif dr_raw is not None:
            dr_status = str(dr_raw)

        # Battery & Water leak / valve attributes
        battery_v = _extract_number(raw_attrs.get("batteryVoltage"))
        battery_pct = _extract_int(
            raw_attrs.get("batteryPercentNormalized")
            or raw_attrs.get("battery")
            or raw_attrs.get("batteryStatus")
        )
        leak_status = _extract_str(
            raw_attrs.get("waterLeakStatus")
            or raw_attrs.get("leakAlert")
            or raw_attrs.get("leak")
            or raw_attrs.get("waterAlarm")
        )
        valve_status = _extract_str(
            raw_attrs.get("valveStatus")
            or raw_attrs.get("closure")
            or raw_attrs.get("motorPosition")
            or raw_attrs.get("status")
        )

        # Map to configured location slug (e.g. "maison", "chalet")
        loc_cfg = locations.location_for_neviweb_name(loc_name)
        location_id = loc_cfg.get("id") if loc_cfg else loc_name.lower().replace(" ", "-")

        return {
            "id": dev_id,
            "device_sn": f"sinope_{dev_id}",
            "name": dev_name,
            "room_name": room_name,
            "brand": "sinope",
            "model": model,
            "device_type": device_type,
            "is_water_heater": is_water_heater,
            "location_id": location_id,
            "location_name": loc_name,
            "is_online": is_online,
            "room_temp_c": room_temp_c,
            "water_temperature_c": water_temp_c,
            "setpoint_c": setpoint_c,
            "heat_level_pct": heat_level_pct,
            "load_watt": load_watt,
            "power_w": active_power_w,
            "is_on": is_on,
            "dr_status": dr_status,
            "battery_v": battery_v,
            "battery_pct": battery_pct,
            "leak_status": leak_status,
            "valve_status": valve_status,
            "last_update_ts": time.time(),
        }

    async def poll_all_devices(self, force: bool = False) -> list[dict[str, Any]]:
        """Poll all devices across all account locations, respecting rate limits."""
        async with self._lock:
            now = time.time()
            if not force and (now - self._last_poll_ts < MIN_POLL_INTERVAL_S) and self._cached_telemetry:
                return list(self._cached_telemetry.values())

            if not sinope_creds.has_credentials():
                return []

            if not self._session_id:
                try:
                    await self.login()
                except Exception as e:
                    log.warning("Sinopé login failed: %s", e)
                    return list(self._cached_telemetry.values())

            try:
                raw_locs = await self.fetch_locations()
            except Exception as e:
                log.warning("Sinopé poll failed to fetch locations: %s", e)
                return list(self._cached_telemetry.values())

            all_results: list[dict[str, Any]] = []
            for loc in raw_locs:
                loc_id = loc.get("id")
                loc_name = loc.get("name") or "Unknown"
                loc_mode = loc.get("mode")
                if not loc_id:
                    continue

                # Sync Neviweb location mode ('home' / 'away') and Neviweb ID into locations store
                try:
                    locations.sync_neviweb_location_state(loc_name, loc_id, loc_mode)
                except Exception as e:
                    log.debug("Failed syncing Neviweb location state for %s: %s", loc_name, e)

                try:
                    devs = await self.fetch_devices_for_location(loc_id)
                except Exception as e:
                    log.warning("Sinopé failed to fetch devices for %s (%s): %s", loc_name, loc_id, e)
                    continue

                groups = await self.fetch_groups_for_location(loc_id)

                for d in devs:
                    did = d.get("id")
                    if not did:
                        continue
                    try:
                        gid = d.get("group$id")
                        room_name = groups.get(gid) if gid is not None else None
                        attrs = await self.fetch_device_attributes(did)
                        formatted = self._classify_and_format_device(d, attrs, loc_name, room_name=room_name)
                        all_results.append(formatted)
                        self._cached_telemetry[str(did)] = formatted
                    except Exception as e:
                        log.debug("Sinopé failed attributes for %s: %s", did, e)

            self._last_poll_ts = time.time()
            return all_results

    def get_cached_devices(self, location_id: str | None = None) -> list[dict[str, Any]]:
        """Return the latest cached device records, optionally filtered by location ID."""
        devs = list(self._cached_telemetry.values())
        if not location_id or location_id.lower() == "all":
            return devs
        norm_loc = location_id.strip().lower()
        return [d for d in devs if d.get("location_id", "").strip().lower() == norm_loc]

    async def set_location_mode(self, location_id_or_name: str | int, mode: str) -> dict[str, Any]:
        """Set native Neviweb location occupancy mode ('home' or 'away') via POST /api/location/{id}/mode."""
        mode_norm = (mode or "").strip().lower()
        if mode_norm not in ("home", "away"):
            raise SinopeError("mode must be 'home' or 'away'")

        # Resolve Neviweb numeric location ID
        neviweb_id: int | str | None = None
        if isinstance(location_id_or_name, int) or str(location_id_or_name).isdigit():
            neviweb_id = int(location_id_or_name)
        else:
            loc_cfg = locations.get_location(str(location_id_or_name)) or locations.location_for_neviweb_name(str(location_id_or_name))
            if loc_cfg and loc_cfg.get("neviweb_id"):
                neviweb_id = loc_cfg["neviweb_id"]
            else:
                target_name = (loc_cfg.get("neviweb_name") if loc_cfg else str(location_id_or_name)).strip().lower()
                raw_locs = self._cached_locations or await self.fetch_locations()
                for rl in raw_locs:
                    if str(rl.get("name") or "").strip().lower() == target_name:
                        neviweb_id = rl.get("id")
                        break

        if not neviweb_id:
            raise SinopeError(f"Could not resolve Neviweb location ID for '{location_id_or_name}'")

        url = f"{HOST}/api/location/{neviweb_id}/mode"
        res = await self._request_with_reauth("POST", url, json={"mode": mode_norm})
        if res.status_code != 200:
            raise SinopeTransientError(f"Failed to set Neviweb location mode for {neviweb_id}: HTTP {res.status_code}")
        data = res.json() if res.content else {}
        if isinstance(data, dict) and "error" in data and data["error"]:
            err = data["error"]
            code = err.get("code") if isinstance(err, dict) else str(err)
            raise SinopeError(f"Neviweb rejected location mode update for {neviweb_id}: {code}")

        # Update cached location mode
        for rl in self._cached_locations:
            if str(rl.get("id")) == str(neviweb_id):
                rl["mode"] = mode_norm

        return {
            "ok": True,
            "neviweb_location_id": neviweb_id,
            "mode": mode_norm,
            "response": data,
        }

    async def set_thermostat_setpoint(self, device_id: int | str, setpoint_c: float) -> dict[str, Any]:
        """Set target room temperature (roomSetpoint) in 0.5°C increments on a Sinopé thermostat."""
        dev_id_str = str(device_id).removeprefix("sinope_").strip()
        if not dev_id_str:
            raise SinopeError("device_id is required")
        # Round to nearest 0.5°C and clamp between 5.0°C and 30.0°C
        rounded = round(float(setpoint_c) * 2.0) / 2.0
        clamped = max(5.0, min(30.0, rounded))

        url = DEVICE_ATTR_URL.format(device_id=dev_id_str)
        payload = {"roomSetpoint": clamped}
        res = await self._request_with_reauth("PUT", url, json=payload)
        if res.status_code != 200:
            raise SinopeTransientError(f"Failed to set Sinopé setpoint for {dev_id_str}: HTTP {res.status_code}")
        data = res.json() if res.content else {}
        if isinstance(data, dict) and "error" in data and data["error"]:
            err = data["error"]
            code = err.get("code") if isinstance(err, dict) else str(err)
            raise SinopeError(f"Neviweb rejected setpoint update for {dev_id_str}: {code}")

        # Optimistically update in-memory cache while preserving duty cycle %
        if dev_id_str in self._cached_telemetry:
            self._cached_telemetry[dev_id_str]["setpoint_c"] = clamped
            self._cached_telemetry[dev_id_str]["last_update_ts"] = time.time()

        return {
            "ok": True,
            "device_id": dev_id_str,
            "device_sn": f"sinope_{dev_id_str}",
            "setpoint_c": clamped,
            "device": self._cached_telemetry.get(dev_id_str),
        }

    async def set_controller_state(self, device_id: int | str, is_on: bool) -> dict[str, Any]:
        """Toggle onOff attribute ('on' or 'off') on a Sinopé load controller or switch."""
        dev_id_str = str(device_id).removeprefix("sinope_").strip()
        if not dev_id_str:
            raise SinopeError("device_id is required")
        url = DEVICE_ATTR_URL.format(device_id=dev_id_str)
        payload = {"onOff": "on" if is_on else "off"}
        res = await self._request_with_reauth("PUT", url, json=payload)
        if res.status_code != 200:
            raise SinopeTransientError(f"Failed to set Sinopé controller state for {dev_id_str}: HTTP {res.status_code}")
        data = res.json() if res.content else {}
        if isinstance(data, dict) and "error" in data and data["error"]:
            err = data["error"]
            code = err.get("code") if isinstance(err, dict) else str(err)
            raise SinopeError(f"Neviweb rejected controller state update for {dev_id_str}: {code}")

        if dev_id_str in self._cached_telemetry:
            self._cached_telemetry[dev_id_str]["is_on"] = bool(is_on)
            if not is_on:
                self._cached_telemetry[dev_id_str]["power_w"] = 0.0
            self._cached_telemetry[dev_id_str]["last_update_ts"] = time.time()

        return {
            "ok": True,
            "device_id": dev_id_str,
            "device_sn": f"sinope_{dev_id_str}",
            "is_on": bool(is_on),
            "device": self._cached_telemetry.get(dev_id_str),
        }

