"""
Hilo Cloud API Client.

Interfaces with Hydro-Québec's Hilo smart home platform to poll:
  - Real-time whole-home power draw from Landis+Gyr smart meters (via Hilo Zigbee gateway)
  - Hilo gateway status & connected devices (thermostats, switches, smart plugs)
  - Hilo Défi (peak demand / challenge) events

Multi-location support:
  Allows separate credentials for different locations (e.g. Maison and Chalet).
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import time
from typing import Any
import urllib.parse

import httpx

from errors import ConfigError, IntegrationError, TransientError
import hilo_creds
import locations

log = logging.getLogger("hilo_client")

# Auth Endpoints & Constants
AUTH_HOSTNAME = "connexion.hiloenergie.com"
AUTH_ENDPOINT = "/HiloDirectoryB2C.onmicrosoft.com/B2C_1A_SIGN_IN/oauth2/v2.0/"
AUTH_AUTHORIZE = f"https://{AUTH_HOSTNAME}{AUTH_ENDPOINT}authorize"
AUTH_TOKEN = f"https://{AUTH_HOSTNAME}{AUTH_ENDPOINT}token"
AUTH_SELF_ASSERTED = f"https://{AUTH_HOSTNAME}/HiloDirectoryB2C.onmicrosoft.com/B2C_1A_SIGN_IN/SelfAsserted"
AUTH_CONFIRMED = f"https://{AUTH_HOSTNAME}/HiloDirectoryB2C.onmicrosoft.com/B2C_1A_SIGN_IN/api/CombinedSigninAndSignup/confirmed"
AUTH_CLIENT_ID = "1ca9f585-4a55-4085-8e30-9746a65fa561"
AUTH_SCOPE = "openid https://HiloDirectoryB2C.onmicrosoft.com/hiloapis/user_impersonation offline_access"
AUTH_REDIRECT_URI = "https://my.home-assistant.io/redirect/oauth"
SUBSCRIPTION_KEY = "20eeaedcb86945afa3fe792cea89b8bf"

# API Endpoints
API_HOSTNAME = "api.hiloenergie.com"
API_LOCATIONS_URL = f"https://{API_HOSTNAME}/Automation/v1/api/Locations"
API_CHALLENGE_EVENTS_URL = f"https://{API_HOSTNAME}/challenge/v1/api/Locations/{{loc_id}}/Events"
PLATFORM_GRAPHQL_URL = "https://platform.hiloenergie.com/api/digital-twin/v3/graphql"

SESSION_PATH = Path(os.environ.get("JACKERY_HILO_SESSION_FILE", "/data/hilo-session.json"))

DEFAULT_REQUEST_TIMEOUT = 15.0
MIN_POLL_INTERVAL_S = 45.0  # Smart meter broadcasts Zigbee SEP power every ~60s

# Digital Twin GraphQL Query for location and devices
QUERY_GET_LOCATION = """query getLocation($locationHiloId: String!) {
    getLocation(id:$locationHiloId) {
        hiloId
        lastUpdate
        lastUpdateVersion
        devices {
            deviceType
            hiloId
            physicalAddress
            connectionStatus
            ... on Gateway {
                connectionStatus
                controllerSoftwareVersion
                lastConnectionTime
                willBeConnectedToSmartMeter
                zigBeeChannel
                zigBeePairingModeEnhanced
                smartMeterZigBeeChannel
                smartMeterPairingStatus
            }
            ... on BasicSmartMeter {
                deviceType
                hiloId
                physicalAddress
                connectionStatus
                zigBeeChannel
                power {
                    value
                    kind
                }
            }
            ... on LowVoltageThermostat {
                coolTempSetpoint {
                    value
                }
                fanMode
                fanSpeed
                mode
                currentState
                power {
                    value
                    kind
                }
                ambientHumidity
                gDState
                ambientTemperature {
                    value
                    kind
                }
                ambientTempSetpoint {
                    value
                    kind
                }
                version
                zigbeeVersion
                connectionStatus
            }
            ... on BasicThermostat {
                deviceType
                hiloId
                physicalAddress
                connectionStatus
                ambientHumidity
                gDState
                version
                zigbeeVersion
                ambientTemperature {
                    value
                    kind
                }
                ambientTempSetpoint {
                    value
                    kind
                }
                heatDemand
                power {
                    value
                    kind
                }
                mode
            }
            ... on HeatingFloorThermostat {
                deviceType
                hiloId
                physicalAddress
                connectionStatus
                ambientHumidity
                power {
                    value
                    kind
                }
                ambientTemperature {
                    value
                    kind
                }
                ambientTempSetpoint {
                    value
                    kind
                }
            }
            ... on BasicSwitch {
                deviceType
                hiloId
                physicalAddress
                connectionStatus
                state
                power {
                    value
                    kind
                }
            }
            ... on BasicDimmer {
                deviceType
                hiloId
                physicalAddress
                connectionStatus
                state
                level
                power {
                    value
                    kind
                }
            }
            ... on WaterHeater {
                deviceType
                hiloId
                physicalAddress
                connectionStatus
                probeTemp {
                    value
                    kind
                }
                state
                power {
                    value
                    kind
                }
            }
            ... on BasicEVCharger {
                deviceType
                hiloId
                physicalAddress
                connectionStatus
                status
                power {
                    value
                    kind
                }
            }
        }
    }
}"""


class HiloError(IntegrationError, RuntimeError):
    """Base error for Hilo API failures."""


class HiloTransientError(HiloError, TransientError):
    """Temporary failure: network timeout, upstream error."""


class HiloConfigError(HiloError, ConfigError):
    """Auth failed or credentials missing."""


def _get_code_verifier() -> str:
    """Generate random cryptographic key string for PKCE code verifier."""
    code = base64.urlsafe_b64encode(os.urandom(40)).decode("utf-8")
    return re.sub(r"[^a-zA-Z0-9]+", "", code)


def _get_code_challenge(verifier: str) -> str:
    """Generate SHA-256 code challenge for PKCE."""
    sha = hashlib.sha256(verifier.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(sha).decode("utf-8").replace("=", "")


class HiloClient:
    """Async client managing Hilo Azure B2C authentication, telemetry, and challenges."""

    def __init__(self, timeout: float = DEFAULT_REQUEST_TIMEOUT) -> None:
        self.timeout = timeout
        self._sessions: dict[str, dict[str, Any]] = {}
        self._cached_devices: dict[str, list[dict[str, Any]]] = {}
        self._cached_meters: dict[str, list[dict[str, Any]]] = {}
        self._cached_challenges: dict[str, list[dict[str, Any]]] = {}
        self._last_poll_ts: dict[str, float] = {}
        self._lock = asyncio.Lock()
        self._load_sessions()

    def _load_sessions(self) -> None:
        """Load persisted session tokens from disk."""
        try:
            if SESSION_PATH.exists():
                data = json.loads(SESSION_PATH.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    self._sessions = data
                    log.info("Restored persisted Hilo sessions for locations: %s", list(data.keys()))
        except Exception as e:
            log.debug("Failed to load persisted Hilo session: %s", e)

    def _save_sessions(self) -> None:
        """Persist session tokens to disk."""
        try:
            SESSION_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = str(SESSION_PATH) + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._sessions, f)
            try:
                os.chmod(tmp, 0o600)
            except Exception:
                pass
            os.replace(tmp, SESSION_PATH)
        except Exception as e:
            log.debug("Failed to save Hilo sessions: %s", e)

    def _clear_session(self, location_id: str | None = None) -> None:
        """Clear cached session for a location or all locations."""
        if location_id is None:
            self._sessions.clear()
            try:
                if SESSION_PATH.exists():
                    SESSION_PATH.unlink()
            except Exception:
                pass
        else:
            norm_id = location_id.strip().lower()
            if norm_id in self._sessions:
                del self._sessions[norm_id]
                self._save_sessions()

    async def login(
        self,
        location_id: str,
        email: str | None = None,
        password: str | None = None,
    ) -> dict[str, Any]:
        """
        Authenticate against Hilo Azure B2C portal using PKCE OAuth2 flow.
        Stores access_token and refresh_token for the location.
        """
        norm_id = (location_id or "").strip().lower()
        if not norm_id:
            raise HiloConfigError("Location ID required for Hilo login")

        if not email or not password:
            creds = hilo_creds.load(norm_id)
            if not creds:
                raise HiloConfigError(f"No Hilo credentials configured for location '{norm_id}'")
            email = creds["email"]
            password = creds["password"]

        verifier = _get_code_verifier()
        challenge = _get_code_challenge(verifier)

        auth_params = {
            "client_id": AUTH_CLIENT_ID,
            "response_type": "code",
            "redirect_uri": AUTH_REDIRECT_URI,
            "response_mode": "query",
            "scope": AUTH_SCOPE,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }

        user_agent = (
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
        )

        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            # Step 1: Request authorize page to get B2C transaction ID and CSRF token
            try:
                auth_res = await client.get(
                    AUTH_AUTHORIZE,
                    params=auth_params,
                    headers={"User-Agent": user_agent},
                )
                auth_res.raise_for_status()
            except httpx.HTTPError as e:
                raise HiloTransientError(f"Failed to reach Hilo login portal: {e}") from e

            m_settings = re.search(r"var SETTINGS = ({.*?});", auth_res.text, re.DOTALL)
            if not m_settings:
                raise HiloError("Failed to parse Azure B2C SETTINGS configuration")

            try:
                settings = json.loads(m_settings.group(1))
                trans_id = settings["transId"]
                csrf = settings["csrf"]
            except Exception as e:
                raise HiloError(f"Failed to extract transId or csrf token: {e}") from e

            # Step 2: Submit credentials to SelfAsserted endpoint
            self_asserted_url = (
                f"{AUTH_SELF_ASSERTED}?tx={urllib.parse.quote(trans_id)}&p=B2C_1A_SIGN_IN"
            )
            sa_headers = {
                "X-CSRF-TOKEN": csrf,
                "X-Requested-With": "XMLHttpRequest",
                "User-Agent": user_agent,
            }
            sa_data = {
                "request_type": "RESPONSE",
                "signInName": email,
                "password": password,
            }

            try:
                sa_res = await client.post(self_asserted_url, headers=sa_headers, data=sa_data)
                sa_res.raise_for_status()
                sa_json = sa_res.json()
            except httpx.HTTPError as e:
                raise HiloTransientError(f"Error communicating with Hilo auth: {e}") from e
            except Exception as e:
                raise HiloError(f"Failed to parse auth response: {e}") from e

            if str(sa_json.get("status")) != "200":
                msg = sa_json.get("message") or sa_json.get("errorCode") or "Authentication failed"
                raise HiloConfigError(f"Hilo login error: {msg}")

            # Step 3: Call confirmed endpoint to obtain redirect with authorization code
            confirmed_url = (
                f"{AUTH_CONFIRMED}?csrf_token={urllib.parse.quote(csrf)}"
                f"&tx={urllib.parse.quote(trans_id)}&p=B2C_1A_SIGN_IN"
            )

            # We don't follow redirect so we can read the Location header with auth code
            conf_client = httpx.AsyncClient(
                timeout=self.timeout,
                cookies=client.cookies,
                follow_redirects=False,
            )
            async with conf_client:
                try:
                    conf_res = await conf_client.get(confirmed_url, headers={"User-Agent": user_agent})
                except httpx.HTTPError as e:
                    raise HiloTransientError(f"Failed to get authorization confirmation: {e}") from e

                redirect_url = conf_res.headers.get("Location")
                if not redirect_url:
                    raise HiloError("Missing redirect Location header from Hilo auth confirmation")

                parsed = urllib.parse.urlparse(redirect_url)
                qs = urllib.parse.parse_qs(parsed.query)
                code_list = qs.get("code")
                if not code_list or not code_list[0]:
                    err_desc = qs.get("error_description", ["Unknown auth error"])[0]
                    raise HiloConfigError(f"Hilo auth error during redirect: {err_desc}")
                auth_code = code_list[0]

            # Step 4: Exchange code for OAuth2 access & refresh tokens
            token_data = {
                "grant_type": "authorization_code",
                "client_id": AUTH_CLIENT_ID,
                "code": auth_code,
                "redirect_uri": AUTH_REDIRECT_URI,
                "code_verifier": verifier,
            }

            try:
                token_res = await client.post(AUTH_TOKEN, data=token_data)
                token_res.raise_for_status()
                token_json = token_res.json()
            except httpx.HTTPError as e:
                raise HiloTransientError(f"Token exchange failed: {e}") from e

            access_token = token_json.get("access_token")
            refresh_token = token_json.get("refresh_token")
            expires_in = int(token_json.get("expires_in", 3600))
            if not access_token:
                raise HiloError("No access_token returned by Hilo token endpoint")

            session_record = {
                "access_token": access_token,
                "refresh_token": refresh_token,
                "expires_at": time.time() + expires_in,
                "email": email,
            }
            self._sessions[norm_id] = session_record
            self._save_sessions()
            log.info("Successfully authenticated Hilo for location '%s' (%s)", norm_id, email)
            return session_record

    async def _refresh_token(self, location_id: str) -> str | None:
        """Attempt to refresh OAuth access token using refresh_token."""
        norm_id = location_id.strip().lower()
        sess = self._sessions.get(norm_id)
        if not sess or not sess.get("refresh_token"):
            return None

        refresh_token = sess["refresh_token"]
        token_data = {
            "grant_type": "refresh_token",
            "client_id": AUTH_CLIENT_ID,
            "refresh_token": refresh_token,
        }

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            try:
                res = await client.post(AUTH_TOKEN, data=token_data)
                res.raise_for_status()
                data = res.json()
                access_token = data.get("access_token")
                if not access_token:
                    return None
                sess["access_token"] = access_token
                if data.get("refresh_token"):
                    sess["refresh_token"] = data["refresh_token"]
                sess["expires_at"] = time.time() + int(data.get("expires_in", 3600))
                self._save_sessions()
                log.info("Refreshed Hilo access token for location '%s'", norm_id)
                return access_token
            except Exception as e:
                log.warning("Failed to refresh Hilo token for '%s': %s", norm_id, e)
                return None

    async def get_valid_token(self, location_id: str) -> str:
        """Return a valid access token, refreshing or re-authenticating as needed."""
        norm_id = location_id.strip().lower()
        sess = self._sessions.get(norm_id)
        now = time.time()

        if sess and sess.get("access_token") and sess.get("expires_at", 0) > (now + 300):
            return sess["access_token"]

        if sess and sess.get("refresh_token"):
            refreshed = await self._refresh_token(norm_id)
            if refreshed:
                return refreshed

        # Need full login
        sess_data = await self.login(norm_id)
        return sess_data["access_token"]

    async def test_credentials(
        self,
        location_id: str,
        email: str,
        password: str,
    ) -> dict[str, Any]:
        """
        Verify credentials by executing login and fetching location list.
        Returns {"ok": True, "locations": [...], "meters": [...]} or {"ok": False, "error": "..."}.
        """
        norm_id = (location_id or "").strip().lower()
        try:
            await self.login(norm_id, email, password)
            locs = await self.get_locations(norm_id)
            meters = []
            for loc in locs:
                loc_hilo_id = loc.get("locationHiloId")
                if loc_hilo_id:
                    devs = await self.query_digital_twin(norm_id, loc_hilo_id)
                    meters.extend([d for d in devs if d.get("deviceType") == "BasicSmartMeter"])
            return {
                "ok": True,
                "locations": locs,
                "meter_count": len(meters),
            }
        except Exception as e:
            log.warning("Hilo test_credentials failed for '%s': %s", norm_id, e)
            return {"ok": False, "error": str(e)}

    def _api_headers(self, token: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {token}",
            "Ocp-Apim-Subscription-Key": SUBSCRIPTION_KEY,
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "JackeryMonitor/1.0",
        }

    async def get_locations(self, location_id: str) -> list[dict[str, Any]]:
        """Fetch list of Hilo locations associated with the account."""
        norm_id = location_id.strip().lower()
        token = await self.get_valid_token(norm_id)

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            try:
                res = await client.get(API_LOCATIONS_URL, headers=self._api_headers(token))
                res.raise_for_status()
                data = res.json()
                if isinstance(data, list):
                    return data
                return []
            except httpx.HTTPError as e:
                raise HiloTransientError(f"Failed to fetch Hilo locations: {e}") from e

    async def query_digital_twin(
        self,
        location_id: str,
        location_hilo_id: str,
    ) -> list[dict[str, Any]]:
        """Query Hilo digital twin GraphQL API for real-time device states."""
        norm_id = location_id.strip().lower()
        token = await self.get_valid_token(norm_id)

        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "JackeryMonitor/1.0",
        }
        payload = {
            "query": QUERY_GET_LOCATION,
            "variables": {"locationHiloId": location_hilo_id},
        }

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            try:
                res = await client.post(PLATFORM_GRAPHQL_URL, headers=headers, json=payload)
                res.raise_for_status()
                data = res.json()
                if "errors" in data:
                    log.warning("GraphQL errors in digital twin response: %s", data["errors"])
                loc_data = (data.get("data") or {}).get("getLocation") or {}
                devices = loc_data.get("devices") or []
                return devices
            except httpx.HTTPError as e:
                raise HiloTransientError(f"Failed to query Hilo digital twin: {e}") from e

    async def get_challenges(
        self,
        location_id: str,
        hilo_loc_id: int | str,
    ) -> list[dict[str, Any]]:
        """Fetch Hilo Défi (peak demand challenge) events for a location."""
        norm_id = location_id.strip().lower()
        token = await self.get_valid_token(norm_id)

        url = API_CHALLENGE_EVENTS_URL.format(loc_id=hilo_loc_id)
        # Note: Pyhilo avoids Ocp-Apim-Subscription-Key on challenge endpoint to prevent 401
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "JackeryMonitor/1.0",
        }

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            try:
                res = await client.get(url, headers=headers)
                if res.status_code == 404:
                    return []
                res.raise_for_status()
                data = res.json()
                if isinstance(data, list):
                    return data
                if isinstance(data, dict):
                    return [data]
                return []
            except Exception as e:
                log.debug("Failed to fetch Hilo challenges for %s (%s): %s", norm_id, hilo_loc_id, e)
                return []

    async def poll_location(self, location_id: str, force: bool = False) -> dict[str, Any]:
        """
        Poll smart meters, connected devices, and challenges for a specific location.
        Updates internal cache and returns normalized summary.
        """
        norm_id = location_id.strip().lower()
        now = time.time()
        last_poll = self._last_poll_ts.get(norm_id, 0.0)
        if not force and (now - last_poll) < MIN_POLL_INTERVAL_S:
            return {
                "location_id": norm_id,
                "meters": self._cached_meters.get(norm_id, []),
                "devices": self._cached_devices.get(norm_id, []),
                "challenges": self._cached_challenges.get(norm_id, []),
            }

        async with self._lock:
            # Recheck after lock
            if not force and (time.time() - self._last_poll_ts.get(norm_id, 0.0)) < MIN_POLL_INTERVAL_S:
                return {
                    "location_id": norm_id,
                    "meters": self._cached_meters.get(norm_id, []),
                    "devices": self._cached_devices.get(norm_id, []),
                    "challenges": self._cached_challenges.get(norm_id, []),
                }

            loc_cfg = locations.get_location(norm_id)
            loc_title = loc_cfg.get("name") if loc_cfg else norm_id.capitalize()

            hilo_locs = await self.get_locations(norm_id)
            if not hilo_locs:
                log.warning("No Hilo locations found for '%s'", norm_id)
                return {"location_id": norm_id, "meters": [], "devices": [], "challenges": []}

            # Map matching location: match by name or use first location if only one
            matched_hilo_loc = None
            for hl in hilo_locs:
                h_name = (hl.get("name") or "").strip().lower()
                if h_name == norm_id or h_name == loc_title.lower():
                    matched_hilo_loc = hl
                    break
            if not matched_hilo_loc:
                matched_hilo_loc = hilo_locs[0]

            loc_hilo_id = matched_hilo_loc.get("locationHiloId")
            hilo_numeric_id = matched_hilo_loc.get("id")

            raw_devices: list[dict[str, Any]] = []
            if loc_hilo_id:
                raw_devices = await self.query_digital_twin(norm_id, loc_hilo_id)

            raw_challenges: list[dict[str, Any]] = []
            if hilo_numeric_id:
                raw_challenges = await self.get_challenges(norm_id, hilo_numeric_id)

            normalized_meters: list[dict[str, Any]] = []
            normalized_devices: list[dict[str, Any]] = []

            for d in raw_devices:
                dtype = d.get("deviceType") or "unknown"
                h_id = d.get("hiloId") or ""
                addr = d.get("physicalAddress") or ""
                clean_id = re.sub(r"[^a-zA-Z0-9_]", "_", h_id or addr or "dev")
                power_dict = d.get("power") or {}
                raw_power = power_dict.get("value")
                power_val = float(raw_power) if raw_power is not None else 0.0
                if (power_dict.get("kind") or "").upper() == "KILOWATT":
                    power_val *= 1000.0
                is_connected = (d.get("connectionStatus") == "CONNECTED")

                is_meter = (
                    dtype in ("BasicSmartMeter", "Meter", "SmartMeter")
                    or "meter" in dtype.lower()
                    or "smart_meter" in (addr or "").lower()
                )

                if is_meter:
                    meter_record = {
                        "device_sn": f"hilo_meter_{norm_id}_{clean_id}",
                        "name": f"Compteur HQ — {loc_title}",
                        "location_id": norm_id,
                        "location_name": loc_title,
                        "brand": "hilo",
                        "device_type": "smart_meter",
                        "power_w": power_val,
                        "online": is_connected,
                        "zigbee_channel": d.get("zigBeeChannel"),
                        "mac": addr,
                        "hilo_id": h_id,
                        "last_seen": int(now),
                    }
                    normalized_meters.append(meter_record)
                else:
                    temp_dict = d.get("ambientTemperature") or {}
                    temp_val = float(temp_dict.get("value")) if temp_dict.get("value") is not None else None
                    setpoint_dict = d.get("ambientTempSetpoint") or {}
                    setpoint_val = float(setpoint_dict.get("value")) if setpoint_dict.get("value") is not None else None

                    # Friendly device naming
                    if dtype == "Hub":
                        dev_name = f"Passerelle Hilo ({loc_title})"
                    elif dtype == "HeatingFloor":
                        dev_name = f"Plancher chauffant {addr} ({loc_title})" if addr else f"Plancher chauffant ({loc_title})"
                    elif dtype == "Tstat":
                        dev_name = f"Thermostat {addr} ({loc_title})" if addr else f"Thermostat ({loc_title})"
                    else:
                        dev_name = f"{dtype} ({loc_title})"

                    dev_record = {
                        "device_sn": f"hilo_{norm_id}_{clean_id}",
                        "name": dev_name,
                        "location_id": norm_id,
                        "location_name": loc_title,
                        "brand": "hilo",
                        "device_type": dtype.lower(),
                        "power_w": power_val,
                        "online": is_connected,
                        "temp_c": temp_val,
                        "setpoint_c": setpoint_val,
                        "mode": d.get("mode") or d.get("state"),
                        "mac": addr,
                        "hilo_id": h_id,
                        "last_seen": int(now),
                    }
                    normalized_devices.append(dev_record)

            normalized_challenges: list[dict[str, Any]] = []
            for ev in raw_challenges:
                phases = ev.get("phases") or {}
                params = ev.get("parameters") or {}
                consumption = ev.get("consumption") or {}
                baseline_wh = float(consumption.get("baselineWh") or 0.0)
                current_wh = float(consumption.get("currentWh") or 0.0)
                reward_val = float(ev.get("reward") or 0.0)

                ch_record = {
                    "location_id": norm_id,
                    "location_name": loc_title,
                    "event_id": ev.get("id"),
                    "period": (ev.get("period") or "").upper(),
                    "progress": ev.get("progress") or "unknown",
                    "is_participating": bool(ev.get("isParticipating", True)),
                    "mode": params.get("mode", "standard"),
                    "preheat_start": phases.get("preheatStartDateUTC"),
                    "preheat_end": phases.get("preheatEndDateUTC"),
                    "reduction_start": phases.get("reductionStartDateUTC"),
                    "reduction_end": phases.get("reductionEndDateUTC"),
                    "recovery_start": phases.get("recoveryStartDateUTC"),
                    "recovery_end": phases.get("recoveryEndDateUTC"),
                    "baseline_kwh": round(baseline_wh / 1000.0, 2),
                    "current_kwh": round(current_wh / 1000.0, 2),
                    "reward": reward_val,
                }
                normalized_challenges.append(ch_record)

            self._cached_meters[norm_id] = normalized_meters
            self._cached_devices[norm_id] = normalized_devices
            self._cached_challenges[norm_id] = normalized_challenges
            self._last_poll_ts[norm_id] = now

            log.info(
                "Hilo poll for '%s': %d smart meters, %d devices, %d challenges",
                norm_id,
                len(normalized_meters),
                len(normalized_devices),
                len(normalized_challenges),
            )

            return {
                "location_id": norm_id,
                "meters": normalized_meters,
                "devices": normalized_devices,
                "challenges": normalized_challenges,
            }

    async def poll_all_locations(self, force: bool = False) -> dict[str, Any]:
        """Poll all locations with configured Hilo credentials."""
        configured = hilo_creds.configured_locations()
        if not configured:
            return {"meters": [], "devices": [], "challenges": []}

        all_meters: list[dict[str, Any]] = []
        all_devices: list[dict[str, Any]] = []
        all_challenges: list[dict[str, Any]] = []

        for loc_id in configured:
            try:
                res = await self.poll_location(loc_id, force=force)
                all_meters.extend(res.get("meters", []))
                all_devices.extend(res.get("devices", []))
                all_challenges.extend(res.get("challenges", []))
            except Exception as e:
                log.warning("Failed to poll Hilo location '%s': %s", loc_id, e)

        return {
            "meters": all_meters,
            "devices": all_devices,
            "challenges": all_challenges,
        }

    def get_cached_devices(self, location_id: str | None = None) -> list[dict[str, Any]]:
        """Return cached Hilo devices, optionally filtered by location_id."""
        if location_id:
            return list(self._cached_devices.get(location_id.strip().lower(), []))
        out: list[dict[str, Any]] = []
        for devs in self._cached_devices.values():
            out.extend(devs)
        return out

    def get_cached_meters(self, location_id: str | None = None) -> list[dict[str, Any]]:
        """Return cached Hilo smart meters, optionally filtered by location_id."""
        if location_id:
            return list(self._cached_meters.get(location_id.strip().lower(), []))
        out: list[dict[str, Any]] = []
        for meters in self._cached_meters.values():
            out.extend(meters)
        return out

    def get_cached_challenges(self, location_id: str | None = None) -> list[dict[str, Any]]:
        """Return cached Hilo challenge events, optionally filtered by location_id."""
        if location_id:
            return list(self._cached_challenges.get(location_id.strip().lower(), []))
        out: list[dict[str, Any]] = []
        for chs in self._cached_challenges.values():
            out.extend(chs)
        return out
