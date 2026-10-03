"""
Battery-state-of-charge automation engine.

A "rule" is: when SOC <op> threshold, turn a Kasa device on or off. Rules
are edge-triggered — the action fires once when the condition transitions
from false to true, NOT on every poll. So a "<20% turn off heater" rule
fires the moment SOC drops below 20%, and won't fire again until SOC has
gone back above 20% and dropped below it again.

Rules persist to /data/automation.json; the schema is the same dict shape
the dashboard uses, so the UI form and the JSON file are 1:1.

Rule schema:
{
  "id":            "8-char hex",
  "name":          "Turn off heater when low",
  "enabled":       true,
  "trigger":       "battery_percent",
  "operator":      "<" | "<=" | "=" | ">=" | ">",
  "value":         20,
  "action":        "off" | "on",
  "kasa_host":     "192.168.1.50",
  "kasa_alias":    "Heater",
  "jackery_device_sn": "ABC123",   # which Jackery device to watch; null = any
  "jackery_device_name": "Explorer 5000 Plus",  # for display only
  "last_fired":    <unix-ts | null>,
  "last_state":    <bool | null>,
  "last_error":    <str | null>,
}
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
import uuid

import kasa_client
from errors import ConfigError

log = logging.getLogger("automation")

RULES_PATH = os.environ.get("JACKERY_RULES_FILE", "/data/automation.json")
EQUALS_TOLERANCE = 0.5   # SOC is noisy; "= 50" matches 49.5..50.5 to avoid flap


VALID_OPERATORS = ("<", "<=", "=", "==", "!=", ">=", ">", "in", "not in")
VALID_ACTIONS = ("on", "off", "enable", "disable", "true", "false")
VALID_TRIGGERS = ("battery_percent", "time_of_day", "day_of_week", "weekday", "day_of_month")
VALID_CONDITION_TYPES = ("battery_percent", "time_of_day", "day_of_week", "day_of_month")
VALID_ACTION_TYPES = ("kasa", "jackery_setting", "setting")

CONDITION_TYPE_ALIASES = {
    "soc": "battery_percent",
    "battery": "battery_percent",
    "battery_soc": "battery_percent",
    "battery_percent": "battery_percent",
    "time": "time_of_day",
    "time_of_day": "time_of_day",
    "tod": "time_of_day",
    "weekday": "day_of_week",
    "weekdays": "day_of_week",
    "day": "day_of_week",
    "day_of_week": "day_of_week",
    "days": "day_of_week",
    "dom": "day_of_month",
    "day_of_month": "day_of_month",
    "month_day": "day_of_month",
    "mday": "day_of_month",
}


def _parse_time_of_day(val: str | int | float) -> int:
    """Parse a time-of-day specification into minute-of-day (0..1439).

    Supports:
      - '20:00', '20:30', '8:15', '08:15'
      - '20h00', '20h', '8h30'
      - '8:30 PM', '8:30pm', '8pm', '12:00 AM', '12:00 PM'
      - '20:00:00'
      - integers/floats (treated as minutes from midnight)
    """
    if isinstance(val, (int, float)):
        val_int = int(val)
        if 0 <= val_int < 1440:
            return val_int
        return val_int % 1440

    s = str(val).strip().lower()
    if not s:
        raise AutomationError("Time of day cannot be empty")

    is_pm = "pm" in s
    is_am = "am" in s
    s = s.replace("pm", "").replace("am", "").strip()
    s = s.replace("h", ":")

    parts = s.split(":")
    try:
        hours = int(parts[0])
        minutes = int(parts[1]) if len(parts) > 1 and parts[1].strip() else 0
    except (TypeError, ValueError):
        raise AutomationError(f"Invalid time format: {val}")

    if is_pm:
        if hours < 12:
            hours += 12
    elif is_am:
        if hours == 12:
            hours = 0

    if not (0 <= hours <= 23) or not (0 <= minutes <= 59):
        raise AutomationError(f"Invalid time of day: {val} (hours 0-23, minutes 0-59)")

    return hours * 60 + minutes


def _format_time_of_day(minute_of_day: int) -> str:
    m = int(minute_of_day) % 1440
    return f"{m // 60:02d}:{m % 60:02d}"


def _resolve_tz_offset(tz_offset: int | None = None, now_ts: float | None = None) -> int:
    if tz_offset is not None:
        return int(tz_offset)
    try:
        import location as device_location
        off = device_location.get_tz_offset()
        if off is not None:
            return int(off)
    except Exception:
        pass
    ts = now_ts if now_ts is not None else time.time()
    return int(getattr(time.localtime(ts), "tm_gmtoff", 0))


def find_conflicting_rules(rules: list[dict], *,
                           smart_charge_kasa_host: str | None,
                           smart_charge_device_sn: str | None,
                           ) -> list[dict]:
    """Return enabled rules that would conflict with smart-charge.

    A rule conflicts when:
      • It targets the SAME Kasa plug smart-charge controls (matching
        `kasa_host`), AND
      • It applies to the smart-charge Jackery (matching device sn, or
        `jackery_device_sn=None` which means "any active device").

    Disabled rules are skipped — they can't fire and won't interfere.
    Returns the rule dicts as-is so callers can show them to the user
    or pass the IDs to a bulk-disable endpoint."""
    if not smart_charge_kasa_host:
        return []
    target_host = smart_charge_kasa_host.strip().lower()
    out: list[dict] = []
    for r in rules or []:
        if not r.get("enabled", True):
            continue
        rule_host = (r.get("kasa_host") or "").strip().lower()
        if rule_host != target_host:
            continue
        rule_sn = r.get("jackery_device_sn") or None
        if rule_sn and smart_charge_device_sn and rule_sn != smart_charge_device_sn:
            continue
        out.append(r)
    return out


class AutomationError(ConfigError, ValueError):
    """Invalid automation rule (bad operator, missing host, etc.).
    Multiple inheritance preserves `except ValueError` callers."""
    pass


def _evaluate_condition(cond: dict, soc: float | None, now_ts: float, tz_offset: int) -> bool:
    raw_type = cond.get("type") or cond.get("trigger") or "battery_percent"
    cond_type = CONDITION_TYPE_ALIASES.get(raw_type, raw_type)
    op = cond.get("operator")
    val = cond.get("value")

    if cond_type == "battery_percent":
        if soc is None:
            return False
        try:
            threshold = float(val)
        except (TypeError, ValueError):
            return False
        if op == "<":
            return soc < threshold
        if op == "<=":
            return soc <= threshold
        if op == "=":
            return abs(soc - threshold) <= EQUALS_TOLERANCE
        if op == ">=":
            return soc >= threshold
        if op == ">":
            return soc > threshold
        return False

    elif cond_type == "time_of_day":
        try:
            target_min = _parse_time_of_day(val)
        except Exception:
            return False
        local_ts = now_ts + tz_offset
        gm = time.gmtime(local_ts)
        curr_min = gm.tm_hour * 60 + gm.tm_min
        if op == "<":
            return curr_min < target_min
        if op == "<=":
            return curr_min <= target_min
        if op == "=":
            return curr_min == target_min
        if op == ">=":
            return curr_min >= target_min
        if op == ">":
            return curr_min > target_min
        return False

    elif cond_type == "day_of_week":
        local_ts = now_ts + tz_offset
        gm = time.gmtime(local_ts)
        isoweekday = gm.tm_wday + 1  # 1=Monday .. 7=Sunday
        is_weekend = isoweekday in (6, 7)
        is_weekday = isoweekday in (1, 2, 3, 4, 5)

        is_hol = False
        try:
            from datetime import date
            import cost
            d = date(gm.tm_year, gm.tm_mon, gm.tm_mday)
            plan = cost.get_plan()
            if plan:
                is_hol = cost.is_holiday(d, plan)
        except Exception:
            pass

        raw_val = str(val).strip().lower()

        def match_single(token: str) -> bool:
            tok = token.strip().lower()
            if tok in ("weekend_or_holiday", "weekend_holiday", "weekends_holidays",
                       "weekends and holidays", "weekend/holiday", "weekends_or_holidays"):
                return is_weekend or is_hol
            if tok in ("weekday_not_holiday", "weekday_excl_holiday",
                       "weekdays excluding holidays", "weekday_no_holiday", "weekdays_not_holidays"):
                return is_weekday and not is_hol
            if tok in ("weekend", "weekends", "sat-sun"):
                return is_weekend
            if tok in ("weekday", "weekdays", "mon-fri"):
                return is_weekday
            if tok in ("holiday", "holidays"):
                return is_hol

            day_names = {
                "mon": 1, "monday": 1,
                "tue": 2, "tuesday": 2,
                "wed": 3, "wednesday": 3,
                "thu": 4, "thursday": 4,
                "fri": 5, "friday": 5,
                "sat": 6, "saturday": 6,
                "sun": 7, "sunday": 7,
            }
            if tok in day_names:
                return isoweekday == day_names[tok]
            try:
                return isoweekday == int(tok)
            except ValueError:
                return False

        tokens = [t for t in raw_val.split(",") if t.strip()]
        is_match = any(match_single(t) for t in tokens)

        if op in ("=", "==", "in"):
            return is_match
        if op in ("!=", "not in"):
            return not is_match

        try:
            int_val = int(raw_val)
            if op == "<":
                return isoweekday < int_val
            if op == "<=":
                return isoweekday <= int_val
            if op == ">=":
                return isoweekday >= int_val
            if op == ">":
                return isoweekday > int_val
        except ValueError:
            pass

        return False

    elif cond_type == "day_of_month":
        import calendar
        local_ts = now_ts + tz_offset
        gm = time.gmtime(local_ts)
        dom = gm.tm_mday  # 1..31
        last_day = calendar.monthrange(gm.tm_year, gm.tm_mon)[1]

        raw_val = str(val).strip().lower()

        def match_single_dom(token: str) -> bool:
            tok = token.strip().lower()
            if tok in ("last", "last_day", "end_of_month"):
                return dom == last_day
            try:
                return dom == int(tok)
            except ValueError:
                return False

        tokens = [t for t in raw_val.split(",") if t.strip()]
        is_match = any(match_single_dom(t) for t in tokens)

        if op in ("=", "==", "in"):
            return is_match
        if op in ("!=", "not in"):
            return not is_match

        try:
            target_num = last_day if raw_val in ("last", "last_day", "end_of_month") else int(raw_val)
            if op == "<":
                return dom < target_num
            if op == "<=":
                return dom <= target_num
            if op == ">=":
                return dom >= target_num
            if op == ">":
                return dom > target_num
        except ValueError:
            pass

        return False

    return False


def _matches(rule: dict, soc: float | None, now_ts: float | None = None, tz_offset: int | None = None) -> bool:
    ts = now_ts if now_ts is not None else time.time()
    tz = _resolve_tz_offset(tz_offset, ts)
    conditions = rule.get("conditions")
    if conditions:
        return all(_evaluate_condition(c, soc, ts, tz) for c in conditions)
    # Legacy fallback: single trigger condition
    legacy_cond = {
        "type": rule.get("trigger") or "battery_percent",
        "operator": rule.get("operator"),
        "value": rule.get("value"),
    }
    return _evaluate_condition(legacy_cond, soc, ts, tz)


def _validate_condition(cond: dict) -> dict:
    if not isinstance(cond, dict):
        raise AutomationError("Each condition must be an object")
    raw_type = cond.get("type") or cond.get("trigger") or "battery_percent"
    cond_type = CONDITION_TYPE_ALIASES.get(raw_type, raw_type)
    if cond_type not in VALID_CONDITION_TYPES:
        raise AutomationError(f"condition type must be one of {VALID_CONDITION_TYPES}")
    op = cond.get("operator")
    if op not in VALID_OPERATORS:
        raise AutomationError(f"operator must be one of {VALID_OPERATORS}")
    val = cond.get("value")
    if val is None or val == "":
        raise AutomationError("condition value is required")

    if cond_type == "battery_percent":
        try:
            val_num = float(val)
        except (TypeError, ValueError):
            raise AutomationError("value must be a number")
        if not (0 <= val_num <= 100):
            raise AutomationError("battery_percent value must be between 0 and 100")
        clean_val = val_num
    elif cond_type == "time_of_day":
        min_of_day = _parse_time_of_day(val)
        clean_val = _format_time_of_day(min_of_day)
    elif cond_type == "day_of_week":
        clean_val = str(val).strip().lower()
        if not clean_val:
            raise AutomationError("day_of_week value cannot be empty")
    elif cond_type == "day_of_month":
        clean_val = str(val).strip().lower()
        if not clean_val:
            raise AutomationError("day_of_month value cannot be empty")
        tokens = [t.strip() for t in clean_val.split(",") if t.strip()]
        if not tokens:
            raise AutomationError("day_of_month value cannot be empty")
        for t in tokens:
            if t in ("last", "last_day", "end_of_month"):
                continue
            try:
                n = int(t)
                if not (1 <= n <= 31):
                    raise ValueError()
            except ValueError:
                raise AutomationError(
                    f"Invalid day_of_month value: '{t}'. Must be between 1 and 31 (or 'last')"
                )
    else:
        clean_val = val

    return {
        "type": cond_type,
        "operator": op,
        "value": clean_val,
    }


def _validate(rule: dict) -> dict:
    """Normalise + reject obviously bad rules. Returns a clean rule dict."""
    name = (rule.get("name") or "").strip() or "Unnamed rule"
    action = (rule.get("action") or "").strip().lower()
    if action not in VALID_ACTIONS:
        raise AutomationError(f"action must be one of {VALID_ACTIONS}")

    raw_action_type = (rule.get("action_type") or "").strip().lower()
    if not raw_action_type:
        if rule.get("setting"):
            action_type = "jackery_setting"
        else:
            action_type = "kasa"
    elif raw_action_type in ("jackery_setting", "setting", "jackery", "device"):
        action_type = "jackery_setting"
    else:
        action_type = "kasa"

    if action_type == "jackery_setting":
        setting = (rule.get("setting") or "battery_saving").strip().lower()
        host = ""
        alias = ""
    else:
        setting = None
        host = (rule.get("kasa_host") or "").strip()
        if not host:
            raise AutomationError("kasa_host is required")
        alias = (rule.get("kasa_alias") or "").strip() or host

    raw_conditions = rule.get("conditions")
    if raw_conditions is not None:
        if not isinstance(raw_conditions, list) or len(raw_conditions) == 0:
            raise AutomationError("conditions must be a non-empty list")
        conditions = [_validate_condition(c) for c in raw_conditions]
    else:
        # Legacy rule format: top-level trigger, operator, value
        trigger = rule.get("trigger") or "battery_percent"
        op = rule.get("operator")
        val = rule.get("value")
        conditions = [_validate_condition({"type": trigger, "operator": op, "value": val})]

    # For backward-compatibility with logs/legacy consumers, populate top-level
    # trigger, operator, and value from the first battery condition, or first condition
    batt_cond = next((c for c in conditions if c["type"] == "battery_percent"), None)
    primary = batt_cond or conditions[0]

    return {
        "id":         (rule.get("id") or uuid.uuid4().hex[:8]),
        "name":       name,
        "enabled":    bool(rule.get("enabled", True)),
        "conditions": conditions,
        "trigger":    primary["type"],
        "operator":   primary["operator"],
        "value":      primary["value"],
        "action":     action,
        "action_type": action_type,
        "setting":    setting,
        "kasa_host":  host,
        "kasa_alias": alias,
        # null means "any/active device" — preserves behavior of pre-multi-
        # device rules. New rules from the UI always set a specific sn.
        "jackery_device_sn":   (rule.get("jackery_device_sn") or None),
        "jackery_device_name": (rule.get("jackery_device_name") or "").strip() or None,
        "last_fired": rule.get("last_fired"),
        "last_state": rule.get("last_state"),
        "last_error": rule.get("last_error"),
    }


class AutomationEngine:
    """Stateful rule store + edge-triggered evaluator. One instance per server."""

    def __init__(self, firing_recorder=None, device_setting_setter=None) -> None:
        """`firing_recorder` is an optional callable invoked on every
        successful firing — server.py wires it to
        `EnergyDB.record_automation_fire` so each fire lands in a
        persistent audit table. Kept as a callback (rather than a
        direct DB import) to avoid a circular dependency and to keep
        unit tests free of DB setup.

        `device_setting_setter` is an optional callable or coroutine
        `(setting, value, device_sn=None)` used to change hardware
        settings on Jackery devices."""
        self.rules: list[dict] = []
        self._lock = asyncio.Lock()
        self._firing_recorder = firing_recorder
        self._device_setting_setter = device_setting_setter
        self._load()

    # ---- persistence ----
    def _load(self) -> None:
        try:
            with open(RULES_PATH) as f:
                data = json.load(f)
            self.rules = list(data.get("rules") or [])
        except FileNotFoundError:
            self.rules = []
        except Exception as e:
            log.warning("rules file %s unreadable: %s; starting empty", RULES_PATH, e)
            self.rules = []

    def _save(self) -> None:
        try:
            os.makedirs(os.path.dirname(RULES_PATH) or ".", exist_ok=True)
            tmp = RULES_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump({"rules": self.rules}, f, indent=2)
            os.replace(tmp, RULES_PATH)
        except Exception as e:
            log.error("failed to save rules: %s", e)

    # ---- CRUD ----
    def list_rules(self) -> list[dict]:
        return list(self.rules)

    def upsert(self, rule: dict) -> dict:
        clean = _validate(rule)
        for i, r in enumerate(self.rules):
            if r["id"] == clean["id"]:
                # Preserve runtime state on edit unless caller passed it explicitly.
                clean["last_fired"] = clean.get("last_fired") or r.get("last_fired")
                clean["last_state"] = clean.get("last_state")
                self.rules[i] = clean
                self._save()
                return clean
        self.rules.append(clean)
        self._save()
        return clean

    def delete(self, rule_id: str) -> bool:
        before = len(self.rules)
        self.rules = [r for r in self.rules if r["id"] != rule_id]
        changed = len(self.rules) != before
        if changed:
            self._save()
        return changed

    def disable_many(self, rule_ids: list[str]) -> list[str]:
        """Set `enabled=false` on the listed rule IDs in one save. Returns
        the IDs that were actually disabled (skips IDs that don't exist
        or were already disabled). Used by the smart-charge "Disable
        conflicting rules" prompt — one round-trip rather than N
        upserts."""
        wanted = set(rule_ids or [])
        if not wanted:
            return []
        disabled: list[str] = []
        for r in self.rules:
            if r.get("id") in wanted and r.get("enabled", True):
                r["enabled"] = False
                # Reset edge state — when re-enabled later, the rule
                # should re-evaluate from scratch rather than carry a
                # stale `last_state` that could suppress an immediate
                # fire.
                r["last_state"] = None
                disabled.append(r["id"])
        if disabled:
            self._save()
        return disabled

    # ---- evaluation ----
    async def evaluate(self, soc_by_sn: dict, active_sn: str | None = None,
                       now_ts: float | None = None, tz_offset: int | None = None) -> list[dict]:
        """Walk all enabled rules. `soc_by_sn` is a dict mapping each Jackery
           device's serial number to its current battery_percent (None for
           devices we don't have data for yet). Each rule is evaluated
           against ITS target device's SOC (if battery conditions are present);
           rules with no target sn fall back to the active device (legacy behavior).

           Edge-triggered: fire (and return) the ones whose condition just
           transitioned from false to true. State is mutated in place and
           persisted on any change."""
        soc_map = soc_by_sn or {}
        if not self.rules:
            return []

        # Fast exit if all enabled rules require battery data and none is available
        def _requires_batt(r: dict) -> bool:
            conds = r.get("conditions")
            if conds:
                return any(
                    CONDITION_TYPE_ALIASES.get(c.get("type", "battery_percent"), c.get("type")) == "battery_percent"
                    for c in conds
                )
            return CONDITION_TYPE_ALIASES.get(r.get("trigger", "battery_percent"), r.get("trigger")) == "battery_percent"

        enabled_rules = [r for r in self.rules if r.get("enabled", True)]
        if not enabled_rules:
            return []
        if not soc_map and all(_requires_batt(r) for r in enabled_rules):
            return []

        ts = now_ts if now_ts is not None else time.time()
        tz = _resolve_tz_offset(tz_offset, ts)
        fired: list[dict] = []
        dirty = False
        async with self._lock:
            for rule in self.rules:
                if not rule.get("enabled", True):
                    rule["last_state"] = None  # reset edge state when disabled
                    continue
                target_sn = rule.get("jackery_device_sn") or active_sn
                soc = soc_map.get(target_sn) if target_sn else None
                if _requires_batt(rule) and soc is None:
                    # No data for this rule's target device; skip without
                    # changing edge state so we don't spuriously fire when
                    # it comes back online.
                    continue
                matches_now = _matches(rule, float(soc) if soc is not None else None, ts, tz)
                last = rule.get("last_state")
                if matches_now and not last:
                    # Edge: transition from false -> true (or unknown -> true)
                    try:
                        action_type = rule.get("action_type") or ("jackery_setting" if rule.get("setting") else "kasa")
                        if action_type == "jackery_setting":
                            setting = rule.get("setting") or "battery_saving"
                            is_on = rule["action"] in ("on", "true", "enable", "1", 1, True)
                            val = 1 if is_on else 0
                            if self._device_setting_setter:
                                res = self._device_setting_setter(setting, val, device_sn=target_sn)
                                if asyncio.iscoroutine(res):
                                    await res
                            else:
                                raise RuntimeError("No device_setting_setter configured on AutomationEngine")
                            log.info("Automation fired: %s [%s] -> set %s to %s",
                                     rule["name"], target_sn, setting, val)
                        else:
                            await kasa_client.set_state(
                                rule["kasa_host"],
                                rule["action"] in ("on", "true", "enable", "1", 1, True),
                            )
                            log.info("Automation fired: %s [%s SOC=%s] -> %s %s",
                                     rule["name"], target_sn, soc,
                                     rule["action"], rule["kasa_alias"])
                        rule["last_fired"] = ts
                        rule["last_error"] = None
                        rule["last_state"] = True   # consume the edge ONLY on success
                        fired.append(rule)
                        # Persist a row to the firings audit table. Best-
                        # effort — DB hiccups shouldn't roll back the
                        # successful action or block subsequent rules.
                        if self._firing_recorder:
                            try:
                                conds = rule.get("conditions") or []
                                batt_cond = next(
                                    (c for c in conds
                                     if CONDITION_TYPE_ALIASES.get(c.get("type", "battery_percent"), c.get("type")) == "battery_percent"),
                                    None,
                                )
                                primary = batt_cond or (conds[0] if conds else {})
                                op = primary.get("operator") or rule.get("operator")
                                val = primary.get("value") or rule.get("value")
                                thresh = float(val) if val is not None and isinstance(val, (int, float)) else None
                                kasa_target = rule.get("kasa_host") if action_type == "kasa" else f"setting:{rule.get('setting', 'battery_saving')}"
                                self._firing_recorder(
                                    rule_id=rule["id"],
                                    rule_name=rule.get("name"),
                                    action=rule["action"],
                                    kasa_host=kasa_target,
                                    jackery_sn=target_sn,
                                    soc_at_fire=float(soc) if soc is not None else None,
                                    operator=op,
                                    threshold=thresh,
                                    fired_at=int(ts),
                                )
                            except Exception as e:
                                log.warning(
                                    "Automation firing audit-log write failed for %s: %s",
                                    rule["name"], e,
                                )
                    except Exception as e:
                        rule["last_error"] = str(e)
                        # Leave last_state unchanged so we retry on the next
                        # poll. Avoids the "stuck failed rule" footgun where
                        # one transient error means the rule never fires
                        # again until the battery exits and re-enters range.
                        log.warning("Automation %s failed (will retry): %s",
                                    rule["name"], e)
                    dirty = True
                else:
                    if last != matches_now:
                        dirty = True  # state changed but didn't fire
                    rule["last_state"] = matches_now
            if dirty:
                self._save()
        return fired
