"""
Per-device timezone and schedule engine for Danby / Midea smart dehumidifiers.

Schedules persist to /data/midea-schedules.json.
Each dehumidifier can have a specific IANA timezone (default: America/Toronto)
and a list of weekly scheduled events (power on/off, target setpoint, fan speed, mode).
"""

from __future__ import annotations

import asyncio
from datetime import datetime
import json
import logging
import os
import time
import uuid
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from typing import Any

log = logging.getLogger("midea.schedule")

SCHEDULES_FILE = os.environ.get("JACKERY_MIDEA_SCHEDULES_FILE", "/data/midea-schedules.json")
DEFAULT_TIMEZONE = "America/Toronto"

# In-memory execution cache: {(device_id, event_id, action, minute_stamp): timestamp}
_executed_events: dict[tuple[str, str, str, str], float] = {}


def _clean_time(val: Any, default: str | None = None) -> str | None:
    """Normalize time string to 'HH:MM' format or return default."""
    if val is None:
        return default
    clean = str(val).strip()
    if not clean:
        return default
    parts = clean.split(":")
    if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
        h = max(0, min(23, int(parts[0])))
        m = max(0, min(59, int(parts[1])))
        return f"{h:02d}:{m:02d}"
    return default


def is_event_active(ev: dict[str, Any], local_now: datetime) -> bool:
    """Check if an event/period is currently active at local_now."""
    if not ev.get("enabled", True):
        return False
    start_time = _clean_time(ev.get("start_time") or ev.get("time"))
    end_time = _clean_time(ev.get("end_time"))
    if not start_time or not end_time or start_time == end_time:
        return False

    raw_days = ev.get("days", [1, 2, 3, 4, 5, 6, 7])
    days = [int(d) for d in raw_days if str(d).isdigit() and 1 <= int(d) <= 7]
    if not days:
        days = [1, 2, 3, 4, 5, 6, 7]

    current_iso_day = local_now.isoweekday()
    prev_iso_day = (current_iso_day - 2) % 7 + 1
    current_hm = local_now.strftime("%H:%M")

    if end_time > start_time:
        # Same day period (e.g. 10:01 to 16:00)
        return (current_iso_day in days) and (start_time <= current_hm < end_time)
    else:
        # Overnight period (e.g. 20:02 to 06:00)
        if current_iso_day in days and current_hm >= start_time:
            return True
        if prev_iso_day in days and current_hm < end_time:
            return True
        return False


def validate_timezone(tz_name: str | None) -> str:
    """Validate IANA timezone string or fallback to DEFAULT_TIMEZONE."""
    if not tz_name or not str(tz_name).strip():
        return DEFAULT_TIMEZONE
    clean = str(tz_name).strip()
    try:
        ZoneInfo(clean)
        return clean
    except (ZoneInfoNotFoundError, Exception) as e:
        raise ValueError(f"Invalid timezone '{clean}': {e}") from e


def load_all() -> dict[str, dict[str, Any]]:
    """Load all device schedules from disk."""
    if not os.path.exists(SCHEDULES_FILE):
        return {}
    try:
        with open(SCHEDULES_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception as e:
        log.warning("failed to load midea schedules from %s: %s", SCHEDULES_FILE, e)
        return {}


def save_all(data: dict[str, Any]) -> None:
    """Save all device schedules to disk atomically."""
    os.makedirs(os.path.dirname(SCHEDULES_FILE) or ".", exist_ok=True)
    tmp_path = f"{SCHEDULES_FILE}.tmp.{os.getpid()}"
    try:
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp_path, SCHEDULES_FILE)
    except Exception as e:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        log.error("failed to save midea schedules to %s: %s", SCHEDULES_FILE, e)
        raise


def get_schedule(device_id: str) -> dict[str, Any]:
    """Retrieve schedule and timezone for a specific device."""
    dev_id = str(device_id).strip()
    clean_id = dev_id.removeprefix("midea_")
    all_scheds = load_all()
    item = all_scheds.get(clean_id) or all_scheds.get(f"midea_{clean_id}") or all_scheds.get(dev_id) or {}

    tz_str = item.get("timezone", DEFAULT_TIMEZONE)
    try:
        tz = ZoneInfo(tz_str)
    except Exception:
        tz = ZoneInfo(DEFAULT_TIMEZONE)

    raw_events = list(item.get("events", []))
    clean_events: list[dict[str, Any]] = []
    for ev in raw_events:
        if not isinstance(ev, dict):
            continue
        ev_copy = dict(ev)
        if not ev_copy.get("time") and ev_copy.get("start_time"):
            ev_copy["time"] = ev_copy["start_time"]
        clean_events.append(ev_copy)

    return {
        "device_id": clean_id,
        "timezone": tz_str,
        "schedule_enabled": bool(item.get("schedule_enabled", False)),
        "events": clean_events,
    }


def set_schedule(device_id: str, schedule_data: dict[str, Any]) -> dict[str, Any]:
    """Validate and persist schedule configuration for a specific device."""
    dev_id = str(device_id).strip()
    clean_id = dev_id.removeprefix("midea_")
    tz = validate_timezone(schedule_data.get("timezone", DEFAULT_TIMEZONE))
    sched_enabled = bool(schedule_data.get("schedule_enabled", False))

    raw_events = schedule_data.get("events", [])
    clean_events: list[dict[str, Any]] = []

    for idx, ev in enumerate(raw_events):
        if not isinstance(ev, dict):
            continue
        ev_id = str(ev.get("id") or f"evt_{uuid.uuid4().hex[:8]}")
        ev_name = str(ev.get("name") or f"Événement {idx + 1}")
        ev_enabled = bool(ev.get("enabled", True))

        # Days: list of ints [1..7] (1=Monday ... 7=Sunday)
        raw_days = ev.get("days", [1, 2, 3, 4, 5, 6, 7])
        clean_days = [int(d) for d in raw_days if str(d).isdigit() and 1 <= int(d) <= 7]
        if not clean_days:
            clean_days = [1, 2, 3, 4, 5, 6, 7]

        # Time: HH:MM format for single event
        raw_time = str(ev.get("time") or ev.get("start_time") or "08:00").strip()
        clean_time = _clean_time(raw_time, default="08:00")

        power = bool(ev.get("power", True))
        tgt_hum = max(30, min(80, int(ev.get("target_humidity", 50) or 50)))
        fan_speed = 80 if int(ev.get("fan_speed", 40) or 40) >= 70 else 40
        mode = 2 if int(ev.get("mode", 1) or 1) == 2 else 1

        clean_events.append({
            "id": ev_id,
            "name": ev_name,
            "enabled": ev_enabled,
            "days": clean_days,
            "time": clean_time,
            "power": power,
            "target_humidity": tgt_hum,
            "fan_speed": fan_speed,
            "mode": mode,
        })

    saved_record = {
        "device_id": clean_id,
        "timezone": tz,
        "schedule_enabled": sched_enabled,
        "events": clean_events,
    }

    all_scheds = load_all()
    all_scheds.pop(f"midea_{clean_id}", None)
    all_scheds[clean_id] = saved_record
    save_all(all_scheds)

    return get_schedule(clean_id)


async def check_and_execute_schedules(client: Any) -> list[dict[str, Any]]:
    """Evaluate all enabled device schedules against their respective local timezone times."""
    now_ts = time.time()
    # Prune execution history older than 2 hours
    expired_keys = [k for k, ts in _executed_events.items() if now_ts - ts > 7200]
    for k in expired_keys:
        _executed_events.pop(k, None)

    all_scheds = load_all()
    executed: list[dict[str, Any]] = []

    for dev_id, item in all_scheds.items():
        if not item.get("schedule_enabled"):
            continue

        tz_str = item.get("timezone", DEFAULT_TIMEZONE)
        try:
            tz = ZoneInfo(tz_str)
        except Exception:
            tz = ZoneInfo(DEFAULT_TIMEZONE)

        local_now = datetime.now(tz)
        current_iso_day = local_now.isoweekday()  # 1=Monday ... 7=Sunday
        current_hm = local_now.strftime("%H:%M")
        minute_key = local_now.strftime("%Y%m%d_%H%M")

        for ev in item.get("events", []):
            if not ev.get("enabled"):
                continue

            ev_id = ev.get("id")
            if not ev_id:
                continue

            ev_days = ev.get("days", [])
            ev_time = _clean_time(ev.get("time") or ev.get("start_time"))

            # --- Check single event trigger ---
            if current_iso_day in ev_days and ev_time == current_hm:
                cache_key = (str(dev_id), str(ev_id), "trigger", minute_key)
                if cache_key not in _executed_events:
                    _executed_events[cache_key] = now_ts
                    power = bool(ev.get("power", True))
                    action_str = "Régler / Allumer" if power else "Arrêter"
                    log.info(
                        "Executing schedule event '%s' (%s) for Midea device %s at %s (%s)",
                        ev.get("name"), action_str, dev_id, current_hm, tz_str,
                    )

                    ctrl_kwargs: dict[str, Any] = {"running": power}
                    if power:
                        if "target_humidity" in ev:
                            ctrl_kwargs["target_humidity"] = ev["target_humidity"]
                        if "fan_speed" in ev:
                            ctrl_kwargs["fan_speed"] = ev["fan_speed"]
                        if "mode" in ev:
                            ctrl_kwargs["mode"] = ev["mode"]

                    try:
                        target_dev_id = str(dev_id).removeprefix("midea_")
                        res = await client.control_device(target_dev_id, **ctrl_kwargs)
                        executed.append({
                            "device_id": target_dev_id,
                            "event_id": ev_id,
                            "action": "power_on" if power else "power_off",
                            "name": ev.get("name"),
                            "result": res,
                        })
                    except Exception as e:
                        log.error("Failed executing schedule '%s' for device %s: %s", ev.get("name"), dev_id, e)

    return executed
