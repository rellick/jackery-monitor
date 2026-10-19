"""
Midea / Danby Smart Dehumidifier Client.

Interfaces with Midea-manufactured smart appliances (including Danby Wi-Fi dehumidifiers,
device type 0xA1) via local LAN protocol and Midea Cloud (MSmartHome / NetHome Plus).
Powered by midea-beautiful-air under the hood.

Features:
  - Discovers dehumidifiers on local LAN and via MSmartHome cloud
  - Real-time room humidity (%) and temperature (°C)
  - Target humidity adjustment (30% to 80%)
  - Power On/Off control
  - Fan speed control (Low / Medium / High)
  - Operation mode (Normal, Continuous, Smart, Laundry)
  - Water tank full (Bucket full) alarm status & defrosting state
  - Multi-location support (Maison / Chalet)
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any

from errors import ConfigError, IntegrationError, TransientError
import locations
import midea_creds

log = logging.getLogger("midea_client")

# Optional location overrides map stored at /data/midea-locations.json
MIDEA_LOCATIONS_FILE = os.environ.get("JACKERY_MIDEA_LOCATIONS_FILE", "/data/midea-locations.json")

# Patch midea_beautiful.crypto to use utf-8 encoding instead of ascii to prevent UnicodeEncodeError
try:
    import midea_beautiful.crypto
    from hashlib import md5, sha256

    def _safe_encrypt_iam_password(self, login_id: str, password: str) -> str:
        md = md5()
        md.update(password.encode("utf-8"))
        md_second = md5()
        md_second.update(md.hexdigest().encode("utf-8"))
        login_hash = login_id + md_second.hexdigest() + self._appkey
        sha = sha256()
        sha.update(login_hash.encode("utf-8"))
        return sha.hexdigest()

    def _safe_encrypt_password(self, login_id: str, password: str) -> str:
        sha = sha256()
        sha.update(password.encode("utf-8"))
        login_hash = login_id + sha.hexdigest() + self._appkey
        sha = sha256()
        sha.update(login_hash.encode("utf-8"))
        return sha.hexdigest()

    midea_beautiful.crypto.Security.encrypt_iam_password = _safe_encrypt_iam_password
    midea_beautiful.crypto.Security.encrypt_password = _safe_encrypt_password
except Exception as e:
    log.warning("failed to patch midea_beautiful crypto: %s", e)

# Patch midea_beautiful.cloud.MideaCloud.appliance_transparent_send
# MSmartHome endpoint /v1/appliance/transparent/send strictly validates parameters and rejects
# unknown properties (such as appVNum, applianceId) with error 9999.
try:
    import json
    import requests
    from datetime import datetime
    from secrets import token_hex
    import midea_beautiful.cloud
    from midea_beautiful.cloud import _encode_as_csv, _decode_from_csv, ProtocolError

    def _safe_appliance_transparent_send(self, appliance_id: str, data: bytes) -> list[bytes]:
        encoded = _encode_as_csv(data)
        order = self._security.aes_encrypt_string(encoded)
        if self._proxied:
            stamp = datetime.now().strftime("%Y%m%d%H%M%S")
            req_id = token_hex(16)
            instant = str(int(time.time()))
            payload = {
                "appId": self._appid,
                "clientType": 1,
                "format": 2,
                "language": "en_US",
                "src": self._appid,
                "stamp": stamp,
                "deviceId": self._device_id,
                "reqId": req_id,
                "uid": self._uid,
                "order": order,
                "funId": "0000",
                "applianceCode": str(appliance_id),
            }
            send_payload = json.dumps(payload)
            sign = self._security.sign_proxied(None, data=send_payload, random=instant)
            headers = {
                "x-recipe-app": str(self._appid),
                "Authorization": self._proxied_auth,
                "sign": sign,
                "secretVersion": "1",
                "random": instant,
                "version": "2.22.0",
                "systemVersion": "8.1.0",
                "platform": "0",
                "Accept-Encoding": "identity",
                "Content-Type": "application/json",
                "uid": self._uid,
                "accessToken": self._header_access_token,
            }
            url = self._api_url + "/v1/appliance/transparent/send"
            res = requests.post(url, data=send_payload, headers=headers, timeout=self.request_timeout)
            res.raise_for_status()
            resp_json = res.json()
            code = int(resp_json.get("code", "0") or 0)
            if code in (40002, 3106) or "token" in str(resp_json.get("msg", "")).lower():
                log.info("Midea access token expired (%s); re-authenticating...", code)
                self._session = {}
                self.authenticate()
                headers["accessToken"] = self._header_access_token
                headers["uid"] = self._uid
                instant = str(int(time.time()))
                headers["random"] = instant
                headers["sign"] = self._security.sign_proxied(None, data=send_payload, random=instant)
                res = requests.post(url, data=send_payload, headers=headers, timeout=self.request_timeout)
                res.raise_for_status()
                resp_json = res.json()
                code = int(resp_json.get("code", "0") or 0)

            if code != 0:
                raise MideaError(f"Cloud transparent send failed: {resp_json.get('msg')} ({resp_json.get('code')})")
            reply_hex = resp_json.get("data", {}).get("reply") or ""
            if not reply_hex:
                return []
            decrypted = self._security.aes_decrypt_string(reply_hex)
            reply = _decode_from_csv(decrypted)
            if len(reply) < 50:
                raise ProtocolError(f"Invalid payload size, was {len(reply)} expected 50 bytes")
            return [reply[40:]]
        else:
            response = self.api_request(
                "/v1/appliance/transparent/send",
                {"order": order, "funId": "0000", "applianceId": str(appliance_id)},
            )
            decrypted = self._security.aes_decrypt_string(response["reply"])
            reply = _decode_from_csv(decrypted)
            if len(reply) < 50:
                raise ProtocolError(f"Invalid payload size, was {len(reply)} expected 50 bytes")
            return [reply[40:]]

    midea_beautiful.cloud.MideaCloud.appliance_transparent_send = _safe_appliance_transparent_send

    orig_handle_api_error = midea_beautiful.cloud.MideaCloud.handle_api_error
    def _safe_handle_api_error(self, error: int, message: str) -> None:
        if error == 40002 or "token" in str(message).lower():
            log.info("Midea token expired (%s: %s); re-authenticating...", error, message)
            self._session = {}
            self.authenticate()
            return
        return orig_handle_api_error(self, error, message)

    midea_beautiful.cloud.MideaCloud.handle_api_error = _safe_handle_api_error
except Exception as e:
    log.warning("failed to patch midea_beautiful appliance_transparent_send: %s", e)


def _connect_to_cloud_safe(email: str, password: str, app_name: str = "MSmartHome") -> tuple[Any, str]:
    """Connect to Midea cloud using persistent device_id and fallback to NetHome Plus on error 65027."""
    import hashlib
    import midea_beautiful
    dev_id = hashlib.md5(f"jackery-midea-{email}".encode()).hexdigest()[:16]
    push_tok = hashlib.sha256(f"jackery-push-{email}".encode()).hexdigest()[:64]

    app_to_try = app_name or "MSmartHome"
    try:
        cloud = midea_beautiful.connect_to_cloud(
            account=email,
            password=password,
            appname=app_to_try,
            device_id=dev_id,
            pushtoken=push_tok,
        )
        return cloud, app_to_try
    except Exception as e:
        err_str = str(e)
        if ("65027" in err_str or "上限" in err_str or "exceeded" in err_str.lower()) and app_to_try == "MSmartHome":
            log.warning("MSmartHome reached device limit (65027); automatically switching to NetHome Plus gateway...")
            cloud = midea_beautiful.connect_to_cloud(
                account=email,
                password=password,
                appname="NetHome Plus",
                device_id=dev_id,
                pushtoken=push_tok,
            )
            return cloud, "NetHome Plus"
        raise


class MideaError(IntegrationError, RuntimeError):
    """Base error for Midea operations."""


class MideaConfigError(MideaError, ConfigError):
    """Credentials or configuration failure."""


class MideaTransientError(MideaError, TransientError):
    """Network or timeout error."""


def _compute_operational_status(
    power: bool,
    tank_full: bool,
    defrosting: bool,
    mode: int,
    current_humidity: float,
    target_humidity: int,
) -> tuple[str, bool, bool]:
    """Return (operational_status, compressor_running, fan_only)."""
    if not power:
        return "off", False, False
    if tank_full:
        return "tank_full", False, False
    if defrosting:
        return "defrosting", False, True
    if mode == 2:  # Continuous mode
        return "dehumidifying", True, False
    if current_humidity > target_humidity:
        return "dehumidifying", True, False
    return "fan_only", False, True


class MideaClient:
    """Async client managing Danby / Midea smart dehumidifiers and telemetry."""

    def __init__(self, timeout: float = 10.0) -> None:
        self.timeout = timeout
        self._cloud_instances: dict[str, Any] = {}  # loc_id -> MideaCloud
        self._lan_devices: dict[str, Any] = {}      # device_id -> LanDevice
        self._device_locations: dict[str, str] = {} # device_id -> loc_id
        self._cached_devices: list[dict[str, Any]] = []
        self._last_poll_ts: float = 0.0
        self._lock = asyncio.Lock()
        self._load_location_mappings()

    async def test_credentials(self, email: str, password: str, app_name: str = "MSmartHome") -> dict[str, Any]:
        """Test Midea cloud authentication and return device count or raise MideaConfigError."""
        def _test_sync() -> dict[str, Any]:
            try:
                cloud, used_app = _connect_to_cloud_safe(email, password, app_name)
                appliances = cloud.list_appliances(force=True)
                return {"ok": True, "device_count": len(appliances), "app_name": used_app}
            except Exception as e:
                raise MideaConfigError(str(e)) from e

        return await asyncio.to_thread(_test_sync)

    def _load_location_mappings(self) -> None:
        try:
            import json
            if os.path.exists(MIDEA_LOCATIONS_FILE):
                with open(MIDEA_LOCATIONS_FILE) as f:
                    data = json.load(f)
                    if isinstance(data, dict):
                        self._device_locations = {str(k): str(v).lower() for k, v in data.items()}
        except Exception as e:
            log.warning("failed to load midea device locations: %s", e)

    def _save_location_mappings(self) -> None:
        try:
            import json
            os.makedirs(os.path.dirname(MIDEA_LOCATIONS_FILE) or ".", exist_ok=True)
            with open(MIDEA_LOCATIONS_FILE, "w") as f:
                json.dump(self._device_locations, f, indent=2)
        except Exception as e:
            log.warning("failed to save midea device locations: %s", e)

    def set_device_location(self, device_id: str, location_id: str) -> None:
        self._device_locations[str(device_id)] = str(location_id).lower()
        self._save_location_mappings()
        for d in self._cached_devices:
            if str(d.get("device_id")) == str(device_id):
                d["location_id"] = str(location_id).lower()

    def get_cached_devices(self) -> list[dict[str, Any]]:
        return list(self._cached_devices)

    def _get_cloud_sync(self, loc_id: str, email: str, password: str, app_name: str) -> Any:
        if loc_id in self._cloud_instances:
            return self._cloud_instances[loc_id]

        cloud, used_app = _connect_to_cloud_safe(email, password, app_name)
        if used_app != app_name:
            try:
                midea_creds.save(loc_id, email, password, used_app)
            except Exception as e:
                log.warning("could not update app_name to %s for %s: %s", used_app, loc_id, e)
        self._cloud_instances[loc_id] = cloud
        return cloud

    def _poll_location_sync(self, loc_id: str, creds: dict[str, str]) -> list[dict[str, Any]]:
        import midea_beautiful
        email = creds["email"]
        password = creds["password"]
        app_name = creds.get("app_name", "MSmartHome")

        try:
            cloud = self._get_cloud_sync(loc_id, email, password, app_name)
        except Exception as e:
            log.error("failed to authenticate Midea cloud for location %s: %s", loc_id, e)
            # Invalidate cloud instance on auth error
            self._cloud_instances.pop(loc_id, None)
            raise MideaConfigError(f"Midea login failed for {loc_id}: {e}") from e

        # Broadcast addresses: universal broadcast + subnet broadcast
        addresses = ["255.255.255.255", "192.168.86.255"]

        # Quick LAN broadcast to discover local IPs of appliances
        lan_ip_map: dict[str, str] = {}
        try:
            from midea_beautiful.scanner import do_find_appliances
            lan_found = do_find_appliances(cloud=None, addresses=addresses, max_retries=2, timeout=1.5)
            for lf in lan_found:
                if lf.appliance_id and lf.address:
                    lan_ip_map[str(lf.appliance_id)] = str(lf.address)
        except Exception as e:
            log.debug("LAN broadcast IP lookup error: %s", e)

        try:
            discovered = midea_beautiful.find_appliances(
                cloud=cloud,
                account=email,
                password=password,
                appname=app_name,
                addresses=addresses,
                retries=2,
                timeout=2.0,
            )
        except Exception as e:
            log.warning("midea discovery warning on %s: %s", loc_id, e)
            discovered = []

        # Ensure all registered cloud appliances are included
        if cloud:
            try:
                cloud_list = cloud.list_appliances(force=True)
                existing_ids = {str(d.appliance_id) for d in discovered}
                for item in cloud_list:
                    app_id = str(item.get("id"))
                    if app_id not in existing_ids:
                        dev = midea_beautiful.lan.LanDevice(
                            appliance_id=app_id,
                            appliance_type=str(item.get("type", "0xA1")),
                        )
                        dev.name = item.get("name")
                        dev.model = item.get("modelNumber")
                        discovered.append(dev)
            except Exception as e:
                log.warning("midea cloud appliance fallback error: %s", e)

        result: list[dict[str, Any]] = []
        for dev in discovered:
            dev_id = str(dev.appliance_id)
            self._lan_devices[dev_id] = dev
            if dev_id not in self._device_locations:
                self._device_locations[dev_id] = loc_id

            # Set discovered LAN address if available
            dev_ip = lan_ip_map.get(dev_id) or str(getattr(dev, "address", "") or "")
            if dev_ip and not getattr(dev, "address", None):
                dev.address = dev_ip

            # Refresh device state via LAN or cloud fallback
            try:
                dev.refresh(cloud=cloud)
            except Exception as e:
                log.warning("midea refresh error for device %s: %s", dev_id, e)
                if "40002" in str(e) or "token" in str(e).lower():
                    self._cloud_instances.pop(loc_id, None)

            state = getattr(dev, "state", None)
            assigned_loc = self._device_locations.get(dev_id, loc_id)

            power = bool(getattr(state, "running", False))
            tank_full = bool(getattr(state, "tank_full", False))
            defrosting = bool(getattr(state, "defrosting", False))
            current_humidity = float(getattr(state, "current_humidity", 0) or 0)
            target_humidity = int(getattr(state, "target_humidity", 50) or 50)
            mode = int(getattr(state, "mode", 1) or 1)

            op_status, compressor_running, fan_only = _compute_operational_status(
                power=power,
                tank_full=tank_full,
                defrosting=defrosting,
                mode=mode,
                current_humidity=current_humidity,
                target_humidity=target_humidity,
            )

            dev_dict: dict[str, Any] = {
                "device_id": dev_id,
                "device_sn": f"midea_{dev_id}",
                "name": str(getattr(dev, "name", "") or getattr(state, "name", "") or f"Danby {dev_id}"),
                "model": str(getattr(state, "model", "") or getattr(dev, "model", "") or "Danby Dehumidifier"),
                "type": str(getattr(state, "type", "0xA1") or "0xA1"),
                "ip": dev_ip,
                "online": bool(getattr(dev, "online", False) or (state and getattr(state, "running", None) is not None)),
                "power": power,
                "compressor_running": compressor_running,
                "fan_only": fan_only,
                "operational_status": op_status,
                "current_humidity": current_humidity,
                "target_humidity": target_humidity,
                "current_temperature": float(getattr(state, "current_temperature", 0.0) or 0.0),
                "tank_full": tank_full,
                "tank_level": getattr(state, "tank_level", None),
                "fan_speed": getattr(state, "fan_speed", 40),
                "mode": mode,
                "pump": bool(getattr(state, "pump", False)),
                "defrosting": defrosting,
                "filter_indicator": bool(getattr(state, "filter_indicator", False)),
                "error_code": int(getattr(state, "error_code", 0) or 0),
                "location_id": assigned_loc,
                "updated_at": time.time(),
            }
            try:
                import midea_schedule
                sched_data = midea_schedule.get_schedule(dev_id)
                dev_dict["schedule_enabled"] = bool(sched_data.get("schedule_enabled", False))
                dev_dict["schedule_events_count"] = len(sched_data.get("events", []))
            except Exception:
                dev_dict["schedule_enabled"] = False
                dev_dict["schedule_events_count"] = 0
            result.append(dev_dict)

        return result

    async def poll_all_locations(self) -> list[dict[str, Any]]:
        """Poll all configured locations in background thread without blocking event loop."""
        all_creds = midea_creds.load_all()
        if not all_creds:
            return []

        async with self._lock:
            all_devices: list[dict[str, Any]] = []
            for loc_id, creds in all_creds.items():
                try:
                    devs = await asyncio.to_thread(self._poll_location_sync, loc_id, creds)
                    all_devices.extend(devs)
                except Exception as e:
                    log.error("failed polling midea location %s: %s", loc_id, e)

            if all_devices:
                self._cached_devices = all_devices
                self._last_poll_ts = time.time()
                self._save_location_mappings()

            return list(self._cached_devices)

    async def set_power(self, device_id: str, power: bool) -> dict[str, Any]:
        """Turn dehumidifier ON or OFF."""
        return await self.control_device(device_id, running=bool(power))

    async def set_target_humidity(self, device_id: str, humidity: int) -> dict[str, Any]:
        """Set target humidity percentage (30-80%)."""
        clamped = max(30, min(80, int(humidity)))
        return await self.control_device(device_id, target_humidity=clamped)

    async def set_fan_speed(self, device_id: str, speed: int | str) -> dict[str, Any]:
        """Set fan speed (e.g. 40 for Low/Silent, 60 for Medium, 80 for High)."""
        val = int(speed) if str(speed).isdigit() else (80 if str(speed).lower() in ("high", "elevee") else 40)
        return await self.control_device(device_id, fan_speed=val)

    async def set_mode(self, device_id: str, mode: int | str) -> dict[str, Any]:
        """Set operation mode (1=Set/Normal, 2=Continuous, 3=Smart, 4=Dryer)."""
        val = int(mode) if str(mode).isdigit() else 1
        return await self.control_device(device_id, mode=val)

    async def control_device(self, device_id: str, **kwargs: Any) -> dict[str, Any]:
        """Apply control state attributes to device."""
        dev_id = str(device_id)
        dev = self._lan_devices.get(dev_id)
        loc_id = self._device_locations.get(dev_id, "maison")
        cloud = self._cloud_instances.get(loc_id)

        if not dev:
            # Refresh devices first
            await self.poll_all_locations()
            dev = self._lan_devices.get(dev_id)
            if not dev:
                raise MideaError(f"Device {dev_id} not found in discovered appliances")

        def _apply_sync() -> None:
            dev.set_state(cloud=cloud, **kwargs)

        await asyncio.to_thread(_apply_sync)

        # Update cached representation
        for d in self._cached_devices:
            if str(d.get("device_id")) == dev_id:
                if "running" in kwargs:
                    d["power"] = bool(kwargs["running"])
                if "target_humidity" in kwargs:
                    d["target_humidity"] = int(kwargs["target_humidity"])
                if "fan_speed" in kwargs:
                    d["fan_speed"] = kwargs["fan_speed"]
                if "mode" in kwargs:
                    d["mode"] = kwargs["mode"]
                op_status, comp_running, fan_only = _compute_operational_status(
                    power=bool(d.get("power", False)),
                    tank_full=bool(d.get("tank_full", False)),
                    defrosting=bool(d.get("defrosting", False)),
                    mode=int(d.get("mode", 1) or 1),
                    current_humidity=float(d.get("current_humidity", 0) or 0),
                    target_humidity=int(d.get("target_humidity", 50) or 50),
                )
                d["operational_status"] = op_status
                d["compressor_running"] = comp_running
                d["fan_only"] = fan_only
                d["updated_at"] = time.time()
                return dict(d)

        return {"device_id": dev_id, "status": "ok"}
