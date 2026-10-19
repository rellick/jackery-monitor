"""
Tesla integration client: Tesla Wall Connector (Gen 3 Local API) and Model Y
via official Tesla Fleet & Owner API.

Features:
- Direct local LAN polling of Tesla Wall Connector Gen 3 (no cloud, zero rate limits)
- Official Tesla Fleet API & OAuth2 integration (100% free, no paid subscriptions)
- Automatic OAuth refresh token rotation and token renewal
- Vehicle sleep detection (does not wake sleeping cars to prevent phantom battery drain)
- Multi-location geofencing (Maison vs Chalet vs Away)
- Intelligent charging source inference:
  * Wall Connector (Maison / Chalet)
  * Mobile Connector (120V Level 1 vs 240V NEMA 14-50 Level 2)
  * Supercharger / DC Fast Charging
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import time
from typing import Any

import httpx

from errors import ConfigError, IntegrationError, TransientError
import location
import locations
import tesla_creds

log = logging.getLogger("tesla_client")

DEFAULT_TIMEOUT = 10.0
TESLA_AUTH_URL = "https://auth.tesla.com/oauth2/v3/token"
FLEET_API_URLS = {
    "na": "https://fleet-api.prd.na.vn.cloud.tesla.com",
    "eu": "https://fleet-api.prd.eu.vn.cloud.tesla.com",
}
OWNER_API_FALLBACK = "https://owner-api.teslamotors.com"
VEHICLE_CACHE_PATH = os.environ.get("JACKERY_TESLA_VEHICLE_CACHE", "/data/tesla-vehicle-cache.json")


def haversine_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate distance in meters between two lat/lon coordinates using Haversine formula."""
    try:
        r = 6371000.0  # Earth radius in meters
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        dphi = math.radians(lat2 - lat1)
        dlambda = math.radians(lon2 - lon1)
        a = math.sin(dphi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2.0) ** 2
        return 2.0 * r * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))
    except Exception:
        return 999999.0


class TeslaClient:
    """Manages communication with local Wall Connectors and official Tesla API."""

    def __init__(self, timeout: float = DEFAULT_TIMEOUT) -> None:
        self.timeout = timeout
        self._cached_wall_connectors: dict[str, dict[str, Any]] = {}
        self._cached_vehicles: list[dict[str, Any]] = self._load_persisted_vehicles()
        self._cached_energy_sites: dict[str, dict[str, Any]] = {}
        self._cached_site_info: dict[str, dict[str, Any]] = {}
        self._cloud_site_geolocations: dict[str, tuple[float, float]] = {}
        self._last_twc_poll_ts: float = 0.0
        self._last_vehicle_poll_ts: float = 0.0
        self._token_lock = asyncio.Lock()

    def _load_persisted_vehicles(self) -> list[dict[str, Any]]:
        """Load last-known vehicle state from disk so sleep and reboots don't zero out stats."""
        try:
            if os.path.exists(VEHICLE_CACHE_PATH):
                with open(VEHICLE_CACHE_PATH, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    if isinstance(data, list):
                        log.info("Hydrated %d vehicle(s) from persisted cache", len(data))
                        return data
        except Exception as e:
            log.debug("Could not load persisted vehicle cache: %s", e)
        return []

    def _save_persisted_vehicles(self) -> None:
        """Persist vehicle state to disk so battery SOC and location survive restarts."""
        try:
            os.makedirs(os.path.dirname(VEHICLE_CACHE_PATH) or ".", exist_ok=True)
            with open(VEHICLE_CACHE_PATH, "w", encoding="utf-8") as f:
                json.dump(self._cached_vehicles, f, indent=2, ensure_ascii=False)
        except Exception as e:
            log.debug("Could not save vehicle cache: %s", e)

    # ---------- Wall Connector (Local REST API) ----------

    async def poll_wall_connector(self, ip: str, location_id: str = "maison") -> dict[str, Any]:
        """Poll a local Tesla Gen 3 Wall Connector on LAN."""
        if not ip or not ip.strip():
            return {}

        clean_ip = ip.strip()
        loc_cfg = locations.get_location(location_id)
        loc_name = loc_cfg.get("name", location_id.capitalize()) if loc_cfg else location_id.capitalize()

        base_url = f"http://{clean_ip}"
        now = time.time()

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as http:
                # Fetch vitals
                res_vitals = await http.get(f"{base_url}/api/1/vitals")
                if res_vitals.status_code != 200:
                    log.warning("Tesla Wall Connector (%s) vitals returned HTTP %d", clean_ip, res_vitals.status_code)
                    return {"online": False, "ip": clean_ip, "location_id": location_id}

                vitals = res_vitals.json()

                # Fetch version / serial
                serial_num = ""
                firmware = ""
                try:
                    res_ver = await http.get(f"{base_url}/api/1/version")
                    if res_ver.status_code == 200:
                        ver_data = res_ver.json()
                        serial_num = ver_data.get("serial_number") or ""
                        firmware = ver_data.get("firmware_version") or ""
                except Exception as e:
                    log.debug("TWC version call failed: %s", e)

                # Fetch lifetime energy
                lifetime_wh = 0.0
                try:
                    res_life = await http.get(f"{base_url}/api/1/lifetime")
                    if res_life.status_code == 200:
                        lifetime_wh = float(res_life.json().get("energy_wh") or 0.0)
                except Exception as e:
                    log.debug("TWC lifetime call failed: %s", e)

                contactor_closed = bool(vitals.get("contactor_closed", False))
                vehicle_connected = bool(vitals.get("vehicle_connected", False))
                grid_v = float(vitals.get("grid_v") or vitals.get("voltageA_v") or 240.0)
                current_a = float(vitals.get("vehicle_current_a") or vitals.get("currentA_a") or 0.0)

                # Active charging power
                power_w = round(grid_v * current_a, 1) if contactor_closed else 0.0
                session_wh = float(vitals.get("session_energy_wh") or 0.0)

                handle_temp_c = float(vitals.get("handle_temp_c")) if vitals.get("handle_temp_c") is not None else None
                pcba_temp_c = float(vitals.get("pcba_temp_c")) if vitals.get("pcba_temp_c") is not None else None

                dev_sn = f"tesla_twc_{location_id}"
                record = {
                    "device_id": f"twc_{serial_num or location_id}",
                    "device_sn": dev_sn,
                    "name": f"Wall Connector ({loc_name})",
                    "device_type": "ev_charger",
                    "charger_type": "wall_connector",
                    "location_id": location_id,
                    "location_name": loc_name,
                    "ip": clean_ip,
                    "serial_number": serial_num,
                    "firmware_version": firmware,
                    "online": True,
                    "vehicle_connected": vehicle_connected,
                    "contactor_closed": contactor_closed,
                    "is_charging": contactor_closed and (power_w > 50.0),
                    "grid_v": round(grid_v, 1),
                    "current_a": round(current_a, 1),
                    "power_w": power_w,
                    "session_s": int(vitals.get("session_s") or 0),
                    "session_energy_wh": round(session_wh, 1),
                    "lifetime_energy_wh": round(lifetime_wh, 1),
                    "handle_temp_c": handle_temp_c,
                    "pcba_temp_c": pcba_temp_c,
                    "evse_state": vitals.get("evse_state"),
                    "last_seen": int(now),
                    "raw_vitals": vitals,
                }
                self._cached_wall_connectors[location_id] = record
                return record

        except Exception as e:
            log.warning("Tesla Wall Connector (%s) poll error: %s", clean_ip, e)
            cached = self._cached_wall_connectors.get(location_id, {})
            if cached:
                cached["online"] = False
                return cached
            return {
                "device_sn": f"tesla_twc_{location_id}",
                "name": f"Wall Connector ({loc_name})",
                "device_type": "ev_charger",
                "location_id": location_id,
                "ip": clean_ip,
                "online": False,
                "last_seen": int(now),
            }

    # ---------- Official Tesla OAuth Token Management ----------

    async def get_valid_access_token(self, creds: dict[str, Any] | None = None) -> str | None:
        """Return a valid unexpired access token, refreshing if necessary."""
        if creds is None:
            creds = tesla_creds.load()

        access_token = creds.get("access_token")
        refresh_token = creds.get("refresh_token")
        token_expires_at = float(creds.get("token_expires_at") or 0.0)

        # 1. Use existing access token if still fresh (> 2 minutes remaining)
        # or if token_expires_at is 0 (directly provided access token)
        now = time.time()
        if access_token and (token_expires_at == 0.0 or token_expires_at > now + 120.0):
            return access_token

        # 2. If no refresh token, return whatever access token we have
        if not refresh_token:
            return access_token or None

        # 3. Single-flight lock to avoid parallel duplicate refresh requests
        async with self._token_lock:
            # Re-check in case another task refreshed while waiting for lock
            fresh_creds = tesla_creds.load()
            fresh_tok = fresh_creds.get("access_token")
            fresh_exp = float(fresh_creds.get("token_expires_at") or 0.0)
            if fresh_tok and (fresh_exp == 0.0 or fresh_exp > time.time() + 120.0):
                return fresh_tok

            try:
                new_tok = await self._refresh_access_token(fresh_creds)
                return new_tok
            except Exception as e:
                log.error("Failed to refresh Tesla access token: %s", e)
                # Fallback to existing access_token if present
                return fresh_tok or access_token or None

    async def _refresh_access_token(self, creds: dict[str, Any]) -> str:
        """Exchange refresh token for new access_token & rotated refresh_token."""
        refresh_token = creds.get("refresh_token")
        if not refresh_token:
            raise ConfigError("No Tesla refresh token configured")

        client_id = creds.get("client_id") or tesla_creds.DEFAULT_CLIENT_ID
        client_secret = creds.get("client_secret") or ""
        region = creds.get("region") or tesla_creds.DEFAULT_REGION
        fleet_audience = FLEET_API_URLS.get(region.lower(), FLEET_API_URLS["na"])

        payload: dict[str, str] = {
            "grant_type": "refresh_token",
            "client_id": client_id,
            "refresh_token": refresh_token,
            "audience": fleet_audience,
        }
        if client_secret:
            payload["client_secret"] = client_secret
        else:
            payload["scope"] = "openid email offline_access"

        async with httpx.AsyncClient(timeout=self.timeout) as http:
            res = await http.post(
                TESLA_AUTH_URL,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                data=payload,
            )
            # If audience parameter was rejected or returned non-200, try fallback without audience
            if res.status_code != 200 and "audience" in payload:
                log.info("Token refresh with audience returned HTTP %d, falling back without audience", res.status_code)
                fallback_payload = dict(payload)
                del fallback_payload["audience"]
                res = await http.post(
                    TESLA_AUTH_URL,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    data=fallback_payload,
                )

            if res.status_code in (401, 403):
                raise ConfigError(f"Tesla refresh token rejected by auth server (HTTP {res.status_code})")
            if res.status_code != 200:
                raise IntegrationError(f"Tesla auth server returned HTTP {res.status_code}: {res.text}")

            data = res.json()
            new_access = data.get("access_token")
            new_refresh = data.get("refresh_token") or refresh_token  # Keep old if not rotated
            expires_in = int(data.get("expires_in") or 28800)

            if not new_access:
                raise IntegrationError("Tesla auth response missing access_token")

            # Persist rotated tokens immediately
            tesla_creds.update_tokens(new_access, new_refresh, expires_in)
            log.info("Successfully refreshed and rotated Tesla OAuth access token (valid for %ds)", expires_in)
            return new_access

    # ---------- Official Tesla Fleet / Owner API Telemetry ----------

    def _get_base_urls(self, region: str = "na") -> list[str]:
        """Return candidate base URLs in priority order."""
        primary = FLEET_API_URLS.get(region.lower(), FLEET_API_URLS["na"])
        return [OWNER_API_FALLBACK, primary]

    async def poll_tesla_api(self, creds: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        """Poll vehicles using official Tesla API (/api/1/products and Fleet API)."""
        if creds is None:
            creds = tesla_creds.load()

        access_token = await self.get_valid_access_token(creds)
        if not access_token:
            return self._cached_vehicles

        region = creds.get("region") or tesla_creds.DEFAULT_REGION
        base_urls = self._get_base_urls(region)
        now = time.time()
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "User-Agent": "TeslaApp/4.34.0",
        }

        vehicles: list[dict[str, Any]] = []

        async with httpx.AsyncClient(timeout=self.timeout) as http:
            # 1. Discover vehicles and energy sites
            vehicle_list: list[dict[str, Any]] = []
            working_base_url: str | None = None

            for base_url in base_urls:
                for endpoint in ["/api/1/products", "/api/1/vehicles"]:
                    try:
                        res = await http.get(f"{base_url}{endpoint}", headers=headers)
                        if res.status_code == 200:
                            data = res.json()
                            raw_items = data.get("response") or data.get("vehicles") or []
                            vehicle_list = [v for v in raw_items if v.get("device_type") == "vehicle" or "vin" in v]
                            # Cache energy sites if present (e.g. Wall Connectors)
                            for item in raw_items:
                                if item.get("resource_type") == "wall_connector":
                                    site_id = str(item.get("energy_site_id") or "")
                                    if site_id:
                                        self._cached_energy_sites[site_id] = item
                            working_base_url = base_url
                            break
                        elif res.status_code in (401, 403):
                            log.debug("Tesla API returned %d on %s%s", res.status_code, base_url, endpoint)
                    except Exception as e:
                        log.debug("Failed checking %s%s: %s", base_url, endpoint, e)
                if working_base_url:
                    break

            if working_base_url is None:
                log.warning("Could not reach any Tesla API endpoint with current token")
                return self._cached_vehicles

            # 2. Process each vehicle
            for v in vehicle_list:
                vin = v.get("vin")
                if not vin:
                    continue
                v_name = v.get("display_name") or v.get("name") or "Model Y"
                car_state = v.get("state")  # "online", "asleep", "offline"
                is_asleep = car_state in ("asleep", "offline")
                v_target = v.get("id_s") or str(v.get("id") or "") or vin

                cached_v = next((c for c in self._cached_vehicles if c.get("vin") == vin), None)

                # If the car is asleep / offline:
                if is_asleep:
                    if cached_v and cached_v.get("battery_level") is not None:
                        cached_copy = dict(cached_v)
                        cached_copy["online"] = False
                        cached_copy["is_asleep"] = True
                        cached_copy["charging_state"] = "Stopped" if cached_copy.get("is_plugged_in") else "Asleep"
                        cached_copy["is_charging"] = False
                        cached_copy["power_w"] = 0.0
                        cached_copy["last_seen"] = int(now)
                        # If location is not yet known, optionally query cloud location cache
                        if cached_copy.get("location_id") in (None, "unknown"):
                            try:
                                loc_res = await http.get(
                                    f"{working_base_url}/api/1/vehicles/{v_target}/vehicle_data?endpoints=location_data",
                                    headers=headers,
                                )
                                if loc_res.status_code == 200:
                                    loc_data = loc_res.json().get("response") or {}
                                    drive = loc_data.get("drive_state") or {}
                                    lat = drive.get("latitude")
                                    lon = drive.get("longitude")
                                    if lat is not None and lon is not None:
                                        cached_copy["latitude"] = lat
                                        cached_copy["longitude"] = lon
                                        loc_id, loc_name = self._resolve_vehicle_location(lat, lon)
                                        cached_copy["location_id"] = loc_id
                                        cached_copy["location_name"] = loc_name
                            except Exception as e:
                                log.debug("Failed refreshing offline car location: %s", e)
                        vehicles.append(cached_copy)
                        continue
                    else:
                        # Initial discovery: car is asleep/offline with no cached battery level.
                        # Wake it up once to initialize telemetry.
                        log.info("Vehicle %s is asleep without cached telemetry; waking to initialize", vin[-6:])
                        woken = await self._wake_and_fetch(http, working_base_url, v_target, vin, v_name, headers, now)
                        if woken:
                            vehicles.append(woken)
                            continue
                        norm = self._normalize_vehicle(vin, v_name, {}, int(now), is_asleep=True)
                        vehicles.append(norm)
                        continue

                # 3. Fetch detailed vehicle_data when car is online
                try:
                    data_res = await http.get(
                        f"{working_base_url}/api/1/vehicles/{v_target}/vehicle_data",
                        headers=headers,
                    )
                    if data_res.status_code == 200:
                        v_data = data_res.json().get("response") or data_res.json()
                        # Also fetch location_data to obtain GPS coordinates
                        try:
                            loc_res = await http.get(
                                f"{working_base_url}/api/1/vehicles/{v_target}/vehicle_data?endpoints=location_data",
                                headers=headers,
                            )
                            if loc_res.status_code == 200:
                                loc_data = loc_res.json().get("response") or loc_res.json()
                                if "drive_state" in loc_data:
                                    v_data["drive_state"] = {**(v_data.get("drive_state") or {}), **loc_data["drive_state"]}
                        except Exception as e:
                            log.debug("Failed fetching vehicle location_data: %s", e)

                        norm_veh = self._normalize_vehicle(vin, v_name, v_data, int(now), is_asleep=False)
                        vehicles.append(norm_veh)
                    elif data_res.status_code == 408:
                        # 408 = vehicle is asleep / offline
                        if cached_v and cached_v.get("battery_level") is not None:
                            cached_copy = dict(cached_v)
                            cached_copy["online"] = False
                            cached_copy["is_asleep"] = True
                            cached_copy["is_charging"] = False
                            cached_copy["power_w"] = 0.0
                            cached_copy["last_seen"] = int(now)
                            vehicles.append(cached_copy)
                        else:
                            norm = self._normalize_vehicle(vin, v_name, {}, int(now), is_asleep=True)
                            vehicles.append(norm)
                    else:
                        log.warning("Tesla vehicle_data (%s) returned HTTP %d", vin[-6:], data_res.status_code)
                        if cached_v:
                            vehicles.append(cached_v)
                except Exception as e:
                    log.warning("Failed fetching vehicle_data for %s: %s", vin[-6:], e)
                    if cached_v:
                        vehicles.append(cached_v)

        if vehicles:
            self._cached_vehicles = vehicles
            self._save_persisted_vehicles()
        self._last_vehicle_poll_ts = now
        return self._cached_vehicles

    async def _wake_and_fetch(
        self,
        http: httpx.AsyncClient,
        base_url: str,
        v_target: str,
        vin: str,
        v_name: str,
        headers: dict[str, str],
        now_ts: float,
    ) -> dict[str, Any] | None:
        """Send wake_up request to vehicle and poll until online, then fetch vehicle_data."""
        try:
            wake_res = await http.post(f"{base_url}/api/1/vehicles/{v_target}/wake_up", headers=headers)
            log.info("Wake_up call for %s returned HTTP %d", vin[-6:], wake_res.status_code)
            for attempt in range(8):
                await asyncio.sleep(2.0)
                status_res = await http.get(f"{base_url}/api/1/vehicles/{v_target}", headers=headers)
                if status_res.status_code == 200:
                    v_info = status_res.json().get("response") or status_res.json()
                    if v_info.get("state") == "online":
                        log.info("Vehicle %s is online after wake_up (attempt %d)", vin[-6:], attempt + 1)
                        r1 = await http.get(f"{base_url}/api/1/vehicles/{v_target}/vehicle_data", headers=headers)
                        r2 = await http.get(f"{base_url}/api/1/vehicles/{v_target}/vehicle_data?endpoints=location_data", headers=headers)
                        if r1.status_code == 200:
                            v_payload = r1.json().get("response") or r1.json()
                            if r2.status_code == 200:
                                loc_data = r2.json().get("response") or r2.json()
                                if "drive_state" in loc_data:
                                    v_payload["drive_state"] = {**(v_payload.get("drive_state") or {}), **loc_data["drive_state"]}
                            return self._normalize_vehicle(vin, v_name, v_payload, int(now_ts), is_asleep=False)
        except Exception as e:
            log.warning("Wake-up flow failed for %s: %s", vin[-6:], e)
        return None

    async def wake_vehicle(self, vin: str) -> dict[str, Any] | None:
        """Explicitly wake up a vehicle by VIN, fetch fresh telemetry, and update cache."""
        creds = tesla_creds.load()
        access_token = await self.get_valid_access_token(creds)
        if not access_token:
            raise ConfigError("No valid Tesla access token available")

        region = creds.get("region") or tesla_creds.DEFAULT_REGION
        base_urls = self._get_base_urls(region)
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "User-Agent": "TeslaApp/4.34.0",
        }
        now = time.time()

        async with httpx.AsyncClient(timeout=self.timeout) as http:
            for base_url in base_urls:
                try:
                    res = await http.get(f"{base_url}/api/1/vehicles", headers=headers)
                    if res.status_code == 200:
                        vehicles_raw = res.json().get("response") or res.json().get("vehicles") or []
                        target_veh = next((v for v in vehicles_raw if v.get("vin") == vin), None)
                        if not target_veh:
                            continue
                        v_target = target_veh.get("id_s") or str(target_veh.get("id") or "") or vin
                        v_name = target_veh.get("display_name") or target_veh.get("name") or "Model Y"

                        woken = await self._wake_and_fetch(http, base_url, v_target, vin, v_name, headers, now)
                        if woken:
                            idx = next((i for i, c in enumerate(self._cached_vehicles) if c.get("vin") == vin), None)
                            if idx is not None:
                                self._cached_vehicles[idx] = woken
                            else:
                                self._cached_vehicles.append(woken)
                            self._save_persisted_vehicles()
                            return woken
                except Exception as e:
                    log.warning("Manual wake failed on %s: %s", base_url, e)

        return None

    def _normalize_vehicle(
        self,
        vin: str,
        name: str,
        state_data: dict[str, Any],
        now_ts: int,
        is_asleep: bool = False,
    ) -> dict[str, Any]:
        """Normalize raw Tesla vehicle state into an application EV record."""
        charge = state_data.get("charge_state") or {}
        drive = state_data.get("drive_state") or {}
        v_state = state_data.get("vehicle_state") or {}

        car_lat = drive.get("latitude")
        car_lon = drive.get("longitude")

        charging_state = str(charge.get("charging_state") or ("Asleep" if is_asleep else "Disconnected"))
        is_charging = charging_state.upper() == "CHARGING"
        is_plugged_in = charging_state.upper() in ("CHARGING", "COMPLETE", "STOPPED", "STARTING")

        battery_level = charge.get("battery_level")  # % (e.g. 78)
        battery_range_mi = charge.get("battery_range")
        battery_range_km = round(float(battery_range_mi) * 1.60934, 1) if battery_range_mi is not None else None

        charger_power_kw = float(charge.get("charger_power") or 0.0)
        charger_voltage = float(charge.get("charger_voltage") or 0.0)
        charger_actual_current = float(charge.get("charger_actual_current") or 0.0)
        if charger_voltage > 0 and charger_actual_current > 0:
            charger_power_w = round(charger_voltage * charger_actual_current, 1)
        else:
            charger_power_w = round(charger_power_kw * 1000.0, 1)
        charge_energy_added = float(charge.get("charge_energy_added") or 0.0)
        time_to_full_charge = float(charge.get("time_to_full_charge") or 0.0)

        # Geofence location resolution
        matched_loc_id, matched_loc_name = self._resolve_vehicle_location(car_lat, car_lon)

        # Infer charger source
        charger_type, charger_name = self._infer_charger(
            matched_loc_id=matched_loc_id,
            is_charging=is_charging,
            charger_voltage=charger_voltage,
            charger_current=charger_actual_current,
            charger_power_kw=charger_power_kw,
            fast_charger_present=bool(charge.get("fast_charger_present")),
        )

        return {
            "device_id": f"tesla_vehicle_{vin}",
            "device_sn": f"tesla_vehicle_{vin[-6:]}",
            "vin": vin,
            "name": name,
            "device_type": "ev_vehicle",
            "model": "Model Y",
            "online": not is_asleep,
            "is_asleep": is_asleep,
            "battery_level": battery_level,
            "battery_range_km": battery_range_km,
            "charging_state": charging_state,
            "is_charging": is_charging,
            "is_plugged_in": is_plugged_in,
            "charger_power_kw": charger_power_kw,
            "power_w": charger_power_w,
            "charger_voltage": charger_voltage,
            "charger_actual_current": charger_actual_current,
            "charge_energy_added_kwh": charge_energy_added,
            "time_to_full_charge_hours": time_to_full_charge,
            "location_id": matched_loc_id,
            "location_name": matched_loc_name,
            "charger_type": charger_type,
            "charger_name": charger_name,
            "latitude": car_lat,
            "longitude": car_lon,
            "odometer_km": round(float(v_state.get("odometer") or 0.0) * 1.60934, 1) if v_state.get("odometer") else None,
            "locked": bool(v_state.get("locked", True)),
            "last_seen": now_ts,
            "raw_state": state_data,
        }

    def _resolve_vehicle_location(self, car_lat: float | None, car_lon: float | None) -> tuple[str, str]:
        """Match vehicle GPS against configured locations (Maison, Chalet)."""
        if car_lat is None or car_lon is None:
            return "unknown", "Unknown Location"

        creds = tesla_creds.load()
        geofences = creds.get("geofences") or {}

        # 1. Check Maison (geofences, creds, location.get, or defaults)
        maison_candidates: list[tuple[float, float]] = []
        if geofences.get("maison", {}).get("lat") and geofences.get("maison", {}).get("lon"):
            maison_candidates.append((float(geofences["maison"]["lat"]), float(geofences["maison"]["lon"])))
        if creds.get("maison_lat") and creds.get("maison_lon"):
            maison_candidates.append((float(creds["maison_lat"]), float(creds["maison_lon"])))
        try:
            saved_loc = location.get()
            if saved_loc and saved_loc.get("latitude") and saved_loc.get("longitude"):
                maison_candidates.append((float(saved_loc["latitude"]), float(saved_loc["longitude"])))
        except Exception:
            pass
        maison_candidates.append((45.548963, -73.243405))

        for m_lat, m_lon in maison_candidates:
            dist = haversine_distance_m(car_lat, car_lon, m_lat, m_lon)
            if dist <= 300.0:
                return "maison", "Maison"

        # 2. Check Chalet (geofences, creds, cloud sites, or defaults)
        chalet_candidates: list[tuple[float, float]] = []
        if geofences.get("chalet", {}).get("lat") and geofences.get("chalet", {}).get("lon"):
            chalet_candidates.append((float(geofences["chalet"]["lat"]), float(geofences["chalet"]["lon"])))
        if creds.get("chalet_lat") and creds.get("chalet_lon"):
            chalet_candidates.append((float(creds["chalet_lat"]), float(creds["chalet_lon"])))
        if "chalet" in self._cloud_site_geolocations:
            chalet_candidates.append(self._cloud_site_geolocations["chalet"])
        chalet_candidates.append((46.273102, -73.868019))

        for c_lat, c_lon in chalet_candidates:
            dist = haversine_distance_m(car_lat, car_lon, c_lat, c_lon)
            if dist <= 350.0:
                return "chalet", "Chalet"

        return "away", "Away / On the Road"

    def _infer_charger(
        self,
        matched_loc_id: str,
        is_charging: bool,
        charger_voltage: float,
        charger_current: float,
        charger_power_kw: float,
        fast_charger_present: bool,
    ) -> tuple[str, str]:
        """Infer charger hardware (Wall Connector vs Mobile Connector vs Supercharger)."""
        if not is_charging:
            return "none", "Not Charging"

        if fast_charger_present or charger_voltage > 350.0:
            return "supercharger", "Tesla Supercharger"

        # A. At Maison
        if matched_loc_id == "maison":
            maison_twc = self._cached_wall_connectors.get("maison")
            if maison_twc and (maison_twc.get("contactor_closed") or maison_twc.get("power_w", 0) > 100.0):
                return "wall_connector", "Wall Connector (Maison)"
            else:
                # Car is charging at Maison, but Wall Connector contactor is open -> Mobile Connector!
                if charger_voltage < 150.0:
                    return "mobile_connector", "Mobile Connector (120V Level 1)"
                else:
                    return "mobile_connector", "Mobile Connector (240V NEMA 14-50)"

        # B. At Chalet
        if matched_loc_id == "chalet":
            chalet_twc = self._cached_wall_connectors.get("chalet")
            if chalet_twc and (
                chalet_twc.get("contactor_closed")
                or chalet_twc.get("power_w", 0) > 50.0
                or chalet_twc.get("is_charging")
                or chalet_twc.get("vehicle_connected")
            ):
                return "wall_connector", "Wall Connector (Chalet)"
            elif chalet_twc and not chalet_twc.get("is_charging") and chalet_twc.get("online"):
                # Wall Connector is online on cloud and reporting idle, while car is charging -> Mobile Connector!
                if charger_voltage < 150.0:
                    return "mobile_connector", "Mobile Connector (120V Level 1)"
                else:
                    return "mobile_connector", "Mobile Connector (240V NEMA 14-50)"
            else:
                if charger_voltage >= 200.0 and (charger_current >= 30.0 or charger_power_kw >= 7.0):
                    return "wall_connector", "Wall Connector (Chalet)"
                elif charger_voltage < 150.0:
                    return "mobile_connector", "Mobile Connector (120V Level 1)"
                else:
                    return "mobile_connector", "Mobile Connector (240V NEMA 14-50)"

        # C. Away / Other
        if charger_power_kw >= 30.0:
            return "supercharger", "DC Fast Charger"
        return "destination", "Destination / Public AC Charger"

    async def poll_cloud_wall_connector(
        self, site_id: str, site_info: dict[str, Any], location_id: str = "chalet"
    ) -> dict[str, Any] | None:
        """Poll a Wall Connector via Tesla cloud live_status API when no LAN IP is reachable."""
        creds = tesla_creds.load()
        access_token = await self.get_valid_access_token(creds)
        if not access_token:
            return None

        headers = {
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "User-Agent": "TeslaApp/4.34.0",
        }
        loc_cfg = locations.get_location(location_id)
        loc_name = loc_cfg.get("name", location_id.capitalize()) if loc_cfg else location_id.capitalize()
        now = time.time()

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as http:
                # Cache site_info and geolocation if available
                if site_id not in self._cached_site_info:
                    try:
                        s_res = await http.get(f"{OWNER_API_FALLBACK}/api/1/energy_sites/{site_id}/site_info", headers=headers)
                        if s_res.status_code == 200:
                            s_data = s_res.json().get("response") or {}
                            self._cached_site_info[site_id] = s_data
                            geo = s_data.get("geolocation") or {}
                            lat = geo.get("latitude")
                            lon = geo.get("longitude")
                            if lat and lon and location_id:
                                self._cloud_site_geolocations[location_id] = (float(lat), float(lon))
                    except Exception as e:
                        log.debug("Failed fetching site_info for %s: %s", site_id, e)

                res = await http.get(
                    f"{OWNER_API_FALLBACK}/api/1/energy_sites/{site_id}/live_status",
                    headers=headers,
                )
                if res.status_code == 200:
                    data = res.json().get("response") or {}
                    wcs = data.get("wall_connectors") or []
                    wc = wcs[0] if wcs else {}
                    power_w = float(wc.get("wall_connector_power") or 0.0)
                    wc_state = wc.get("wall_connector_state")
                    ocpp_st = wc.get("ocpp_status")
                    is_charging = (wc_state in (3, 4, 11)) or (power_w > 50.0)
                    # ocpp_status: 1 = Available (unplugged), 2 = Preparing (plugged in), 3 = Charging
                    # wall_connector_state: 2 = Standby/Ready (unplugged), 3+ = Connected/Charging
                    vehicle_connected = bool(
                        is_charging
                        or (ocpp_st is not None and ocpp_st > 1)
                        or (wc_state is not None and wc_state > 2)
                    )
                    serial = site_info.get("components", {}).get("wall_connectors", [{}])[0].get("serial_number") or ""
                    site_name = site_info.get("site_name") or f"Wall Connector ({loc_name})"

                    record = {
                        "device_id": f"twc_{serial or location_id}",
                        "device_sn": f"tesla_twc_{location_id}",
                        "name": site_name,
                        "device_type": "ev_charger",
                        "charger_type": "wall_connector",
                        "location_id": location_id,
                        "location_name": loc_name,
                        "serial_number": serial,
                        "online": True,
                        "is_cloud": True,
                        "contactor_closed": is_charging,
                        "vehicle_connected": vehicle_connected,
                        "is_charging": is_charging,
                        "power_w": power_w,
                        "last_seen": int(now),
                        "raw_cloud_status": data,
                    }
                    self._cached_wall_connectors[location_id] = record
                    return record
        except Exception as e:
            log.warning("Failed to poll cloud Wall Connector (%s): %s", site_id, e)
        return None

    # ---------- Combined Poll & Discovery ----------

    async def poll_all(self, force: bool = False) -> list[dict[str, Any]]:
        """Poll local Wall Connector(s) and official Tesla vehicle API."""
        creds = tesla_creds.load()
        maison_ip = creds.get("maison_twc_ip") or tesla_creds.DEFAULT_MAISON_TWC_IP
        chalet_ip = creds.get("chalet_twc_ip")

        devices: list[dict[str, Any]] = []

        # 1. Poll Maison Wall Connector (fast local LAN)
        if maison_ip:
            try:
                twc_maison = await self.poll_wall_connector(maison_ip, "maison")
                if twc_maison and twc_maison.get("online"):
                    devices.append(twc_maison)
            except Exception as e:
                log.warning("Failed to poll Maison TWC: %s", e)

        # 2. Poll Chalet Wall Connector (if IP configured)
        if chalet_ip:
            try:
                twc_chalet = await self.poll_wall_connector(chalet_ip, "chalet")
                if twc_chalet and twc_chalet.get("online"):
                    devices.append(twc_chalet)
            except Exception as e:
                log.warning("Failed to poll Chalet TWC: %s", e)

        # 3. Poll Tesla Vehicle API (which also populates self._cached_energy_sites)
        if tesla_creds.has_tesla_vehicle_auth():
            try:
                vehicles = await self.poll_tesla_api(creds)
                devices.extend(vehicles)
            except Exception as e:
                log.warning("Failed to poll Tesla API: %s", e)

        # 4. If Chalet TWC not already connected via LAN, check discovered cloud energy sites
        if not any(d.get("device_sn") == "tesla_twc_chalet" and d.get("online") for d in devices):
            for site_id, s_info in self._cached_energy_sites.items():
                s_name = (s_info.get("site_name") or "").lower()
                if "chalet" in s_name:
                    cloud_twc = await self.poll_cloud_wall_connector(site_id, s_info, "chalet")
                    if cloud_twc:
                        devices.append(cloud_twc)
                    break

        return devices

    def get_cached_devices(self, location_id: str | None = None) -> list[dict[str, Any]]:
        """Return combined cached Wall Connectors and Vehicles."""
        all_devs: list[dict[str, Any]] = list(self._cached_wall_connectors.values()) + list(self._cached_vehicles)
        if location_id:
            norm_id = location_id.strip().lower()
            return [d for d in all_devs if d.get("location_id") == norm_id]
        return all_devs

    async def test_credentials(
        self,
        refresh_token: str | None = None,
        access_token: str | None = None,
        client_id: str | None = None,
        client_secret: str | None = None,
        maison_twc_ip: str | None = None,
    ) -> dict[str, Any]:
        """Test connectivity to Wall Connector and official Tesla API."""
        result: dict[str, Any] = {
            "wall_connector": {"ok": False, "message": "Not tested"},
            "tesla_api": {"ok": False, "message": "Not configured"},
        }

        # 1. Test Wall Connector
        test_ip = (maison_twc_ip or tesla_creds.DEFAULT_MAISON_TWC_IP).strip()
        if test_ip:
            try:
                async with httpx.AsyncClient(timeout=4.0) as http:
                    res = await http.get(f"http://{test_ip}/api/1/vitals")
                    if res.status_code == 200:
                        v = res.json()
                        result["wall_connector"] = {
                            "ok": True,
                            "ip": test_ip,
                            "grid_v": v.get("grid_v"),
                            "vehicle_connected": bool(v.get("vehicle_connected")),
                            "contactor_closed": bool(v.get("contactor_closed")),
                        }
                    else:
                        result["wall_connector"] = {"ok": False, "message": f"HTTP {res.status_code}"}
            except Exception as e:
                result["wall_connector"] = {"ok": False, "message": str(e)}

        # 2. Test Tesla API
        current = tesla_creds.load()
        effective_tok = access_token.strip() if access_token is not None else None
        effective_refresh = refresh_token.strip() if refresh_token is not None else None

        if effective_tok and effective_tok.startswith("••"):
            effective_tok = current.get("access_token")
        if effective_refresh and effective_refresh.startswith("••"):
            effective_refresh = current.get("refresh_token")

        if not effective_refresh and not effective_tok:
            effective_refresh = current.get("refresh_token")
            effective_tok = current.get("access_token")

        if effective_refresh or effective_tok:
            try:
                test_creds = dict(current)
                if effective_refresh:
                    test_creds["refresh_token"] = effective_refresh
                if effective_tok:
                    test_creds["access_token"] = effective_tok
                    test_creds["token_expires_at"] = time.time() + 28800.0
                if client_id:
                    test_creds["client_id"] = client_id
                if client_secret and not client_secret.startswith("••"):
                    test_creds["client_secret"] = client_secret

                async def _verify_token(tok: str) -> tuple[bool, int, list[str], str]:
                    base_urls = self._get_base_urls(test_creds.get("region", "na"))
                    headers = {
                        "Authorization": f"Bearer {tok}",
                        "Accept": "application/json",
                        "User-Agent": "TeslaApp/4.34.0",
                    }
                    last_err = "401 Unauthorized"
                    async with httpx.AsyncClient(timeout=6.0) as http:
                        for b_url in base_urls:
                            for endpoint in ["/api/1/products", "/api/1/vehicles"]:
                                try:
                                    r = await http.get(f"{b_url}{endpoint}", headers=headers)
                                    if r.status_code == 200:
                                        d = r.json()
                                        raw_items = d.get("response") or d.get("vehicles") or []
                                        v_list = [v for v in raw_items if v.get("device_type") == "vehicle" or "vin" in v]
                                        v_names = [v.get("display_name") or v.get("name") or "Model Y" for v in v_list]
                                        return True, 200, v_names, ""
                                    elif r.status_code in (401, 403):
                                        last_err = f"HTTP {r.status_code}"
                                        continue
                                    elif r.status_code in (404, 412):
                                        continue
                                    else:
                                        last_err = f"HTTP {r.status_code}"
                                except Exception as ex:
                                    last_err = str(ex)
                    return False, 0, [], last_err

                verified = False
                api_error_msg = None

                # Test directly provided access token first
                if effective_tok:
                    ok, code, names, err = await _verify_token(effective_tok)
                    if ok:
                        result["tesla_api"] = {
                            "ok": True,
                            "vehicle_count": len(names),
                            "vehicles": names,
                        }
                        verified = True
                    else:
                        api_error_msg = err

                # If direct access token was missing or didn't work, and refresh token is available, try refreshing
                if not verified and effective_refresh:
                    try:
                        refreshed_token = await self._refresh_access_token(test_creds)
                        ok, code, names, err = await _verify_token(refreshed_token)
                        if ok:
                            result["tesla_api"] = {
                                "ok": True,
                                "vehicle_count": len(names),
                                "vehicles": names,
                            }
                            verified = True
                        else:
                            result["tesla_api"] = {"ok": False, "message": f"Tesla API error: {err}"}
                    except Exception as ref_err:
                        err_str = str(ref_err)
                        if api_error_msg:
                            result["tesla_api"] = {"ok": False, "message": f"Access token error: {api_error_msg}; Refresh error: {err_str}"}
                        else:
                            result["tesla_api"] = {"ok": False, "message": f"Token refresh failed: {err_str}"}
                elif not verified and not effective_refresh:
                    result["tesla_api"] = {"ok": False, "message": f"Tesla API error: {api_error_msg or 'Invalid access token'}"}

            except Exception as e:
                result["tesla_api"] = {"ok": False, "message": str(e)}

        return result
