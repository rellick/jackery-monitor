"""
Electricity cost tracking — converts the energy_db history into dollar
savings (solar production avoided buying grid power) and grid cost (what
you actually paid to charge from AC).

Plan storage: /data/cost.json. Two shapes supported:
  - Flat: {"type": "flat", "rate_per_kwh": 0.30, "currency": "USD"}
  - TOU:  {"type": "tou", "currency": "USD",
           "tou_rates": [{"start_hour": 16, "end_hour": 21,
                          "rate": 0.62, "label": "peak",
                          "months": [6, 7, 8, 9]}, ...]}

TOU slots are inclusive of start_hour, exclusive of end_hour, evaluated
in the device's local timezone (from /data/location.json). Slots may
wrap midnight (e.g. start=23, end=7 means 23:00-07:00).

The optional `months` field is a list of 1-12 month numbers; the slot
only applies during those months. Omitting `months` (or empty list)
means year-round. Used to model summer/winter seasons on plans like
PG&E EV2-A where peak rates roughly halve in winter.

Savings model — output-based ("displaced grid"):
  saved      = output_kWh * rate(at_time)   # what grid would have cost
                                            # if you didn't have solar+battery
  grid_cost  = grid_kWh   * rate(at_time)   # paid for grid charging
  net        = saved - grid_cost            # net dollar benefit

This model correctly handles storage timing — using yesterday's stored
solar today still counts as savings, because every Wh out of the battery
displaces a Wh you would otherwise have purchased from grid. Computing
savings from solar input alone (solar_kWh * rate) under-counts on days
when you draw from previously-stored sunshine.

Grid kWh is derived as input_wh - solar_wh (car-input is almost always
zero on these devices and isn't tracked separately).
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
from datetime import date, datetime, timedelta, timezone
from typing import Any

log = logging.getLogger("cost")

COST_PATH = os.environ.get("JACKERY_COST_FILE", "/data/cost.json")

DEFAULT_PLAN: dict[str, Any] = {
    "type": "flat",
    "rate_per_kwh": 0.30,
    "currency": "USD",
}

# Built-in plan presets. Rates are approximate as of 2026-04 — users on
# these utilities should verify current rates and override via custom.
PRESETS: dict[str, dict[str, Any]] = {
    "flat-default": {
        "label": "Flat $0.30/kWh",
        "plan": {"type": "flat", "rate_per_kwh": 0.30, "currency": "USD"},
    },
    "pge-ev2a": {
        "label": "PG&E EV2-A (CA)",
        "plan": {
            "type": "tou",
            "currency": "USD",
            "tou_rates": [
                # SUMMER (Jun-Sep): peak rates much higher. All values
                # approximate; user must edit to match their actual bill.
                {"start_hour": 16, "end_hour": 21, "rate": 0.61,
                 "label": "summer peak",
                 "months": [6, 7, 8, 9]},
                {"start_hour": 15, "end_hour": 16, "rate": 0.51,
                 "label": "summer partial-peak",
                 "months": [6, 7, 8, 9]},
                {"start_hour": 21, "end_hour": 24, "rate": 0.51,
                 "label": "summer partial-peak",
                 "months": [6, 7, 8, 9]},
                {"start_hour": 0, "end_hour": 15, "rate": 0.31,
                 "label": "summer off-peak",
                 "months": [6, 7, 8, 9]},
                # WINTER (Oct-May): same windows, lower peak/partial-peak.
                {"start_hour": 16, "end_hour": 21, "rate": 0.49,
                 "label": "winter peak",
                 "months": [1, 2, 3, 4, 5, 10, 11, 12]},
                {"start_hour": 15, "end_hour": 16, "rate": 0.46,
                 "label": "winter partial-peak",
                 "months": [1, 2, 3, 4, 5, 10, 11, 12]},
                {"start_hour": 21, "end_hour": 24, "rate": 0.46,
                 "label": "winter partial-peak",
                 "months": [1, 2, 3, 4, 5, 10, 11, 12]},
                {"start_hour": 0, "end_hour": 15, "rate": 0.31,
                 "label": "winter off-peak",
                 "months": [1, 2, 3, 4, 5, 10, 11, 12]},
            ],
        },
    },
    "pge-etouc": {
        "label": "PG&E E-TOU-C (CA)",
        "plan": {
            "type": "tou",
            "currency": "USD",
            "tou_rates": [
                # Summer (Jun-Sep): higher peak.
                {"start_hour": 16, "end_hour": 21, "rate": 0.55,
                 "label": "summer peak", "months": [6, 7, 8, 9]},
                {"start_hour": 0, "end_hour": 16, "rate": 0.42,
                 "label": "summer off-peak", "months": [6, 7, 8, 9]},
                {"start_hour": 21, "end_hour": 24, "rate": 0.42,
                 "label": "summer off-peak", "months": [6, 7, 8, 9]},
                # Winter (Oct-May).
                {"start_hour": 16, "end_hour": 21, "rate": 0.45,
                 "label": "winter peak",
                 "months": [1, 2, 3, 4, 5, 10, 11, 12]},
                {"start_hour": 0, "end_hour": 16, "rate": 0.40,
                 "label": "winter off-peak",
                 "months": [1, 2, 3, 4, 5, 10, 11, 12]},
                {"start_hour": 21, "end_hour": 24, "rate": 0.40,
                 "label": "winter off-peak",
                 "months": [1, 2, 3, 4, 5, 10, 11, 12]},
            ],
        },
    },
    "sce-touprime": {
        "label": "SCE TOU-D-PRIME (CA)",
        "plan": {
            "type": "tou",
            "currency": "USD",
            "tou_rates": [
                # Summer (Jun-Sep).
                {"start_hour": 16, "end_hour": 21, "rate": 0.55,
                 "label": "summer peak", "months": [6, 7, 8, 9]},
                {"start_hour": 0, "end_hour": 16, "rate": 0.30,
                 "label": "summer off-peak", "months": [6, 7, 8, 9]},
                {"start_hour": 21, "end_hour": 24, "rate": 0.30,
                 "label": "summer off-peak", "months": [6, 7, 8, 9]},
                # Winter (Oct-May): cheaper everything.
                {"start_hour": 16, "end_hour": 21, "rate": 0.42,
                 "label": "winter peak",
                 "months": [1, 2, 3, 4, 5, 10, 11, 12]},
                {"start_hour": 0, "end_hour": 16, "rate": 0.27,
                 "label": "winter off-peak",
                 "months": [1, 2, 3, 4, 5, 10, 11, 12]},
                {"start_hour": 21, "end_hour": 24, "rate": 0.27,
                 "label": "winter off-peak",
                 "months": [1, 2, 3, 4, 5, 10, 11, 12]},
            ],
        },
    },
    "hq-tarif-d-tdt": {
        "label": "Hydro-Québec Tarif D (différencié)",
        "plan": {
            "type": "tou",
            "currency": "CAD",
            "holiday_calendar": "CA-QC",
            "tou_rates": [
                # WINTER (Dec 1 – Mar 31) — 2nd tier rates (excess beyond daily quota)
                # Night: 23h - 6h (all days)
                {"start_hour": 0, "end_hour": 6, "rate": 0.04972,
                 "label": "winter night", "months": [12, 1, 2, 3]},
                # Peak: 6h - 10h and 16h - 20h (weekdays, excluding holidays)
                {"start_hour": 6, "end_hour": 10, "rate": 0.21964,
                 "label": "winter peak (AM)", "months": [12, 1, 2, 3],
                 "weekdays": [1, 2, 3, 4, 5], "holidays": "exclude"},
                {"start_hour": 16, "end_hour": 20, "rate": 0.21964,
                 "label": "winter peak (PM)", "months": [12, 1, 2, 3],
                 "weekdays": [1, 2, 3, 4, 5], "holidays": "exclude"},
                # Off-peak: 10h - 16h and 20h - 23h (weekdays, excluding holidays)
                {"start_hour": 10, "end_hour": 16, "rate": 0.08851,
                 "label": "winter off-peak", "months": [12, 1, 2, 3],
                 "weekdays": [1, 2, 3, 4, 5], "holidays": "exclude"},
                {"start_hour": 20, "end_hour": 23, "rate": 0.08851,
                 "label": "winter off-peak", "months": [12, 1, 2, 3],
                 "weekdays": [1, 2, 3, 4, 5], "holidays": "exclude"},
                # Off-peak: 6h - 23h (weekends and holidays)
                {"start_hour": 6, "end_hour": 23, "rate": 0.08851,
                 "label": "winter weekend/holiday off-peak", "months": [12, 1, 2, 3],
                 "weekdays": [6, 7], "holidays": "include"},
                # Night: 23h - 24h (all days)
                {"start_hour": 23, "end_hour": 24, "rate": 0.04972,
                 "label": "winter night", "months": [12, 1, 2, 3]},

                # SUMMER (Apr 1 – Nov 30) — 2nd tier rates
                # Night: 23h - 6h (all days)
                {"start_hour": 0, "end_hour": 6, "rate": 0.04972,
                 "label": "summer night", "months": [4, 5, 6, 7, 8, 9, 10, 11]},
                # Off-peak: 6h - 16h (weekdays, excluding holidays)
                {"start_hour": 6, "end_hour": 16, "rate": 0.10652,
                 "label": "summer off-peak", "months": [4, 5, 6, 7, 8, 9, 10, 11],
                 "weekdays": [1, 2, 3, 4, 5], "holidays": "exclude"},
                # Peak: 16h - 20h (weekdays, excluding holidays)
                {"start_hour": 16, "end_hour": 20, "rate": 0.18576,
                 "label": "summer peak", "months": [4, 5, 6, 7, 8, 9, 10, 11],
                 "weekdays": [1, 2, 3, 4, 5], "holidays": "exclude"},
                # Off-peak: 20h - 23h (weekdays, excluding holidays)
                {"start_hour": 20, "end_hour": 23, "rate": 0.10652,
                 "label": "summer off-peak", "months": [4, 5, 6, 7, 8, 9, 10, 11],
                 "weekdays": [1, 2, 3, 4, 5], "holidays": "exclude"},
                # Off-peak: 6h - 23h (weekends and holidays)
                {"start_hour": 6, "end_hour": 23, "rate": 0.10652,
                 "label": "summer weekend/holiday off-peak", "months": [4, 5, 6, 7, 8, 9, 10, 11],
                 "weekdays": [6, 7], "holidays": "include"},
                # Night: 23h - 24h (all days)
                {"start_hour": 23, "end_hour": 24, "rate": 0.04972,
                 "label": "summer night", "months": [4, 5, 6, 7, 8, 9, 10, 11]},
            ],
        },
    },
}

_lock = threading.Lock()


def easter_sunday(year: int) -> tuple[int, int]:
    """Returns (month, day) for Easter Sunday in the given Gregorian year
    using the Meeus/Jones/Butcher algorithm."""
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return month, day


def get_qc_holidays(year: int) -> set[date]:
    """Returns the set of official Hydro-Québec statutory and dynamic holidays
    for Tarif D différencié dans le temps (Régie de l'énergie R-4270-2024 / HQ):
      - 24, 25, 26, 31 décembre
      - 1er et 2 janvier
      - Vendredi saint (Good Friday)
      - Lundi de Pâques (Easter Monday)
      - Journée nationale des patriotes (lundi qui précède le 25 mai)
      - 24 juin (Fête nationale du Québec)
      - 1er juillet (Fête du Canada)
      - Fête du Travail (1er lundi de septembre)
      - Action de grâce (2e lundi d'octobre)
    """
    e_month, e_day = easter_sunday(year)
    easter = date(year, e_month, e_day)
    good_friday = easter - timedelta(days=2)
    easter_monday = easter + timedelta(days=1)

    # Journée nationale des patriotes: Monday preceding May 25 (May 18-24)
    ref_may = date(year, 5, 24)
    patriotes = ref_may - timedelta(days=ref_may.weekday())

    # Fête du Travail: 1st Monday of September
    sept1 = date(year, 9, 1)
    labour_day = sept1 + timedelta(days=(7 - sept1.weekday()) % 7)

    # Action de grâce: 2nd Monday of October (1st Monday + 7 days)
    oct1 = date(year, 10, 1)
    first_mon_oct = oct1 + timedelta(days=(7 - oct1.weekday()) % 7)
    thanksgiving = first_mon_oct + timedelta(days=7)

    return {
        date(year, 1, 1),
        date(year, 1, 2),
        good_friday,
        easter_monday,
        patriotes,
        date(year, 6, 24),
        date(year, 7, 1),
        labour_day,
        thanksgiving,
        date(year, 12, 24),
        date(year, 12, 25),
        date(year, 12, 26),
        date(year, 12, 31),
    }


def is_holiday(dt: datetime | date, plan: dict[str, Any]) -> bool:
    """Check if the given date is considered a holiday under the plan."""
    d = dt.date() if isinstance(dt, datetime) else dt
    # Check custom explicit holidays (e.g. dynamic pricing days or manual overrides)
    for h in plan.get("holidays") or []:
        h_str = str(h).strip()
        if not h_str:
            continue
        if len(h_str) == 10 and h_str == d.isoformat():
            return True
        if len(h_str) == 5 and h_str == f"{d.month:02d}-{d.day:02d}":
            return True

    cal = (plan.get("holiday_calendar") or "").strip().lower()
    if cal in ("ca-qc", "ca_qc", "hydro_quebec", "hydro-quebec", "qc"):
        if d in get_qc_holidays(d.year):
            return True

    return False


def _validate(plan: dict[str, Any]) -> dict[str, Any] | None:
    """Sanity-check a candidate plan; return a normalized copy or None."""
    if not isinstance(plan, dict):
        return None
    plan_type = plan.get("type")
    currency = str(plan.get("currency") or "USD")[:8]
    if plan_type == "flat":
        try:
            rate = float(plan.get("rate_per_kwh") or 0)
        except (TypeError, ValueError):
            return None
        if not 0 <= rate <= 5.0:
            return None
        return {"type": "flat", "rate_per_kwh": rate, "currency": currency}
    if plan_type == "tou":
        slots_in = plan.get("tou_rates") or []
        if not isinstance(slots_in, list) or not slots_in:
            return None
        slots_out: list[dict[str, Any]] = []
        for raw in slots_in:
            if not isinstance(raw, dict):
                return None
            try:
                s = int(raw.get("start_hour"))
                e = int(raw.get("end_hour"))
                rate = float(raw.get("rate"))
            except (TypeError, ValueError):
                return None
            if not (0 <= s <= 24 and 0 <= e <= 24):
                return None
            if not 0 <= rate <= 5.0:
                return None
            label = str(raw.get("label") or "")[:48]
            # Optional `months` filter — list of 1-12. None / empty
            # means year-round.
            months_raw = raw.get("months")
            months: list[int] | None = None
            if months_raw:
                if not isinstance(months_raw, list):
                    return None
                cleaned = []
                for m in months_raw:
                    try:
                        mi = int(m)
                    except (TypeError, ValueError):
                        return None
                    if not 1 <= mi <= 12:
                        return None
                    cleaned.append(mi)
                months = sorted(set(cleaned))

            # Optional `weekdays` filter — list of 1-7 (1=Monday .. 7=Sunday).
            weekdays_raw = raw.get("weekdays")
            weekdays: list[int] | None = None
            if weekdays_raw is not None:
                if not isinstance(weekdays_raw, list):
                    return None
                cleaned_w = []
                for w in weekdays_raw:
                    try:
                        wi = int(w)
                    except (TypeError, ValueError):
                        return None
                    if not 1 <= wi <= 7:
                        return None
                    cleaned_w.append(wi)
                if cleaned_w and len(set(cleaned_w)) < 7:
                    weekdays = sorted(set(cleaned_w))

            # Optional `holidays` filter — "exclude", "include", "only", or bool.
            holidays_raw = raw.get("holidays")
            holidays: str | None = None
            if holidays_raw is False or holidays_raw == "exclude":
                holidays = "exclude"
            elif holidays_raw is True or holidays_raw == "include":
                holidays = "include"
            elif holidays_raw == "only":
                holidays = "only"
            elif holidays_raw is not None:
                return None

            slot_out: dict[str, Any] = {
                "start_hour": s, "end_hour": e,
                "rate": rate, "label": label,
            }
            if months:
                slot_out["months"] = months
            if weekdays:
                slot_out["weekdays"] = weekdays
            if holidays:
                slot_out["holidays"] = holidays
            slots_out.append(slot_out)

        out_plan: dict[str, Any] = {
            "type": "tou",
            "currency": currency,
            "tou_rates": slots_out,
        }
        if plan.get("holiday_calendar"):
            out_plan["holiday_calendar"] = str(plan["holiday_calendar"])[:32]
        if plan.get("holidays"):
            if not isinstance(plan["holidays"], list):
                return None
            valid_hols = []
            for h in plan["holidays"]:
                hs = str(h).strip()
                if re.match(r"^\d{4}-\d{2}-\d{2}$", hs) or re.match(r"^\d{2}-\d{2}$", hs):
                    valid_hols.append(hs)
                else:
                    return None
            if valid_hols:
                out_plan["holidays"] = sorted(set(valid_hols))
        return out_plan
    return None


def get_plan() -> dict[str, Any]:
    """Load the saved plan or fall back to DEFAULT_PLAN."""
    with _lock:
        try:
            with open(COST_PATH) as f:
                data = json.load(f)
        except FileNotFoundError:
            return dict(DEFAULT_PLAN)
        except Exception as e:
            log.warning("cost plan unreadable (%s); using default", e)
            return dict(DEFAULT_PLAN)
    validated = _validate(data)
    return validated or dict(DEFAULT_PLAN)


def set_plan(plan: dict[str, Any]) -> dict[str, Any] | None:
    """Validate and persist a plan. Returns the saved plan, or None on failure."""
    validated = _validate(plan)
    if validated is None:
        return None
    with _lock:
        os.makedirs(os.path.dirname(COST_PATH) or ".", exist_ok=True)
        tmp = COST_PATH + ".tmp"
        with open(tmp, "w") as f:
            json.dump(validated, f, indent=2)
        os.replace(tmp, COST_PATH)
    log.info("cost plan saved (type=%s, currency=%s)",
             validated["type"], validated["currency"])
    return validated


def list_presets() -> list[dict[str, Any]]:
    """For the settings UI dropdown — id, label, plan."""
    return [{"id": k, **v} for k, v in PRESETS.items()]


def _hour_in_slot(hour: int, start: int, end: int) -> bool:
    """Inclusive-start, exclusive-end. Handles wraparound (start>end)."""
    if start <= end:
        return start <= hour < end
    return hour >= start or hour < end


def slot_matches(slot: dict[str, Any], dt: datetime, plan: dict[str, Any]) -> bool:
    """Return True if the slot conditions match the timestamp's local datetime."""
    # 1. Seasonal months check
    slot_months = slot.get("months")
    if slot_months and dt.month not in slot_months:
        return False

    # 2. Weekdays & Holidays check
    slot_weekdays = slot.get("weekdays")
    slot_holidays = slot.get("holidays")
    if slot_holidays is False:
        slot_holidays = "exclude"
    elif slot_holidays is True:
        slot_holidays = "include"

    is_hol = is_holiday(dt, plan)
    iso_wd = dt.isoweekday()  # 1=Monday .. 7=Sunday

    if slot_holidays == "exclude":
        if is_hol:
            return False
        if slot_weekdays and iso_wd not in slot_weekdays:
            return False
    elif slot_holidays == "include":
        matches_wd = (not slot_weekdays) or (iso_wd in slot_weekdays)
        if not (matches_wd or is_hol):
            return False
    elif slot_holidays == "only":
        if not is_hol:
            return False
        if slot_weekdays and iso_wd not in slot_weekdays:
            return False
    else:  # None or unrecognized
        if slot_weekdays and iso_wd not in slot_weekdays:
            return False

    # 3. Hour check
    return _hour_in_slot(dt.hour, int(slot["start_hour"]), int(slot["end_hour"]))


def rate_at(plan: dict[str, Any], ts: float,
            tz_offset_seconds: int = 0) -> float:
    """Return $/kWh active at the given timestamp.

    `tz_offset_seconds` shifts the timestamp before extracting the hour
    so TOU slots are evaluated in the device's local time, not UTC.
    """
    if plan.get("type") == "flat":
        return float(plan.get("rate_per_kwh") or 0)
    if plan.get("type") == "tou":
        local = datetime.fromtimestamp(ts + tz_offset_seconds, tz=timezone.utc)
        for slot in plan.get("tou_rates") or []:
            if slot_matches(slot, local, plan):
                return float(slot["rate"])
    return 0.0


def tag_passthrough(history: list[dict[str, Any]],
                    capacity_wh: float = 1264.0) -> list[dict[str, Any]]:
    """Annotate energy history rows with battery_out_wh and passthrough_wh.

    Jackery units with UPS bypass / AC passthrough (e.g. Explorer 1000 Plus)
    route grid power directly to AC loads when sitting at target SOC (e.g. 85%).
    In this state, Jackery firmware logs AC output (e.g. ~130W) but 0W AC input
    because the battery cells themselves are neither charging nor discharging.

    This function separates true battery discharge from grid passthrough by
    tracking running output Wh against battery SOC changes:
      - If input_wh (or ac_input_wh) > 5W: unit is connected to active grid power;
        any uncommitted output was passthrough.
      - If SOC decreases: battery cells delivered power. Discharged Wh is credited
        up to the expected energy for that SOC drop (delta_soc * Wh/pct).
      - If accumulated output exceeds threshold (> 2% capacity or 25 Wh) with NO
        decrease in SOC: energy could not have come from battery cells, so it is
        tagged as AC passthrough.
      - If no SOC telemetry is available in the history: gracefully falls back to
        treating output as battery discharge.
    """
    if not history:
        return []

    wh_per_pct = (capacity_wh or 1264.0) / 100.0
    pt_threshold = max(25.0, wh_per_pct * 2.0)
    has_soc = any(r.get("battery_pct") is not None for r in history)

    out: list[dict[str, Any]] = []
    if not has_soc:
        for r in history:
            rc = dict(r)
            rc["battery_out_wh"] = float(rc.get("output_wh") or 0.0)
            rc["passthrough_wh"] = 0.0
            out.append(rc)
        return out

    prev_soc: float | None = None
    accum_wh = 0.0
    accum_indices: list[int] = []

    for i, r in enumerate(history):
        rc = dict(r)
        out_wh = float(rc.get("output_wh") or 0.0)
        in_wh = float(rc.get("ac_input_wh") or rc.get("input_wh") or 0.0)
        raw_soc = rc.get("system_soc") if rc.get("system_soc") is not None else rc.get("battery_pct")
        soc = float(raw_soc) if raw_soc is not None else None

        rc["battery_out_wh"] = 0.0
        rc["passthrough_wh"] = 0.0
        out.append(rc)

        if out_wh <= 0.0:
            if soc is not None:
                prev_soc = soc
            continue

        if in_wh > 5.0:
            for idx in accum_indices:
                out[idx]["passthrough_wh"] += out[idx].pop("_accum_temp", 0.0)
            accum_wh = 0.0
            accum_indices = []
            rc["passthrough_wh"] = out_wh
            if soc is not None:
                prev_soc = soc
            continue

        rc["_accum_temp"] = out_wh
        accum_indices.append(i)
        accum_wh += out_wh

        if prev_soc is not None and soc is not None:
            delta_soc = soc - prev_soc
            if delta_soc < 0:
                expected_wh = abs(delta_soc) * wh_per_pct * 1.15
                discharged = min(accum_wh, expected_wh)
                ratio_dis = discharged / accum_wh if accum_wh > 0 else 1.0
                for idx in accum_indices:
                    w = out[idx].pop("_accum_temp", 0.0)
                    out[idx]["battery_out_wh"] = w * ratio_dis
                    out[idx]["passthrough_wh"] = w * (1.0 - ratio_dis)
                accum_wh = 0.0
                accum_indices = []
            elif accum_wh > pt_threshold:
                for idx in accum_indices:
                    out[idx]["passthrough_wh"] += out[idx].pop("_accum_temp", 0.0)
                accum_wh = 0.0
                accum_indices = []
        elif accum_wh > pt_threshold:
            for idx in accum_indices:
                out[idx]["passthrough_wh"] += out[idx].pop("_accum_temp", 0.0)
            accum_wh = 0.0
            accum_indices = []

        if soc is not None:
            prev_soc = soc

    for idx in accum_indices:
        if "_accum_temp" in out[idx]:
            out[idx]["battery_out_wh"] = out[idx].pop("_accum_temp", 0.0)

    return out


def compute_savings(history: list[dict[str, Any]],
                    plan: dict[str, Any] | None = None,
                    tz_offset_seconds: int = 0,
                    mode: str = "battery",
                    capacity_wh: float = 1264.0) -> dict[str, Any]:
    """Walk hourly buckets, integrate savings/cost in dollars.

    Output-based model: each Wh leaving the battery would have been
    purchased from grid without solar+battery; we credit it at the rate
    active *at output time* (so peak-hour discharge gets peak credit).
    Grid charging is subtracted at the rate active *at input time*.

    Supported accounting modes:
      - 'battery': Isolates true battery charging and discharging. Bypasses
        AC grid passthrough so output only counts energy drawn from battery
        cells (accurate roundtrip efficiency).
      - 'total': Includes AC passthrough in consumption and synthesizes grid
        input (grid = max(ac_in, passthrough)). Tracks full appliance electricity
        cost without inflating net savings.
    """
    plan = plan or get_plan()
    tagged = tag_passthrough(history, capacity_wh)
    saved_dollars = 0.0
    grid_cost_dollars = 0.0
    output_kwh_total = 0.0
    solar_kwh_total = 0.0
    grid_kwh_total = 0.0

    for row in tagged:
        ts = row.get("ts")
        if ts is None:
            continue
        rate = rate_at(plan, float(ts), tz_offset_seconds)
        bat_out_wh = float(row.get("battery_out_wh") or 0.0)
        pt_wh = float(row.get("passthrough_wh") or 0.0)
        solar_kwh = float(row.get("solar_wh") or 0.0) / 1000.0
        input_kwh = float(row.get("input_wh") or 0.0) / 1000.0
        ac_in = row.get("ac_input_wh")
        if ac_in is not None:
            raw_grid_kwh = max(0.0, float(ac_in) / 1000.0)
        else:
            raw_grid_kwh = max(0.0, input_kwh - solar_kwh)

        if mode == "total":
            out_kwh = (bat_out_wh + pt_wh) / 1000.0
            grid_kwh = raw_grid_kwh + (pt_wh / 1000.0)
        else:
            out_kwh = bat_out_wh / 1000.0
            grid_kwh = raw_grid_kwh

        saved_dollars += out_kwh * rate
        grid_cost_dollars += grid_kwh * rate
        output_kwh_total += out_kwh
        solar_kwh_total += solar_kwh
        grid_kwh_total += grid_kwh

    efficiency_pct = round((output_kwh_total / grid_kwh_total) * 100, 1) if grid_kwh_total > 0 else None

    return {
        # Key kept as `solar_savings` for UI back-compat; semantics are
        # "what having solar+battery saved you" not "value of today's solar."
        "solar_savings": round(saved_dollars, 2),
        "baseline_cost": round(saved_dollars, 2),
        "solar_cost": 0.0,
        "grid_cost": round(grid_cost_dollars, 2),
        "net_savings": round(saved_dollars - grid_cost_dollars, 2),
        "output_kwh": round(output_kwh_total, 3),
        "solar_kwh": round(solar_kwh_total, 3),
        "grid_kwh": round(grid_kwh_total, 3),
        "avg_buy_rate": round(grid_cost_dollars / grid_kwh_total, 4) if grid_kwh_total > 0 else 0.0,
        "avg_use_rate": round(saved_dollars / output_kwh_total, 4) if output_kwh_total > 0 else 0.0,
        "efficiency_pct": efficiency_pct,
        "mode": mode,
        "currency": plan.get("currency", "USD"),
    }


def cost_breakdown(history: list[dict[str, Any]],
                   plan: dict[str, Any] | None = None,
                   tz_offset_seconds: int = 0,
                   group_by: str = "day",
                   mode: str = "battery",
                   capacity_wh: float = 1264.0) -> list[dict[str, Any]]:
    """Group energy rows into day, week, month, or year buckets with financial metrics."""
    plan = plan or get_plan()
    tagged = tag_passthrough(history, capacity_wh)
    groups: dict[str, dict[str, Any]] = {}

    for row in tagged:
        ts = row.get("ts")
        if ts is None:
            continue
        local_dt = datetime.fromtimestamp(float(ts) + tz_offset_seconds, tz=timezone.utc)

        if group_by == "week":
            iso_year, iso_week, _ = local_dt.isocalendar()
            key = f"{iso_year}-W{iso_week:02d}"
            label = key
        elif group_by == "month":
            key = local_dt.strftime("%Y-%m")
            label = local_dt.strftime("%B %Y")
        elif group_by == "year":
            key = local_dt.strftime("%Y")
            label = key
        else:  # default "day"
            key = local_dt.strftime("%Y-%m-%d")
            label = local_dt.strftime("%b %d, %Y")

        rate = rate_at(plan, float(ts), tz_offset_seconds)
        bat_out_wh = float(row.get("battery_out_wh") or 0.0)
        pt_wh = float(row.get("passthrough_wh") or 0.0)
        solar_kwh = float(row.get("solar_wh") or 0.0) / 1000.0
        input_kwh = float(row.get("input_wh") or 0.0) / 1000.0
        ac_in = row.get("ac_input_wh")
        if ac_in is not None:
            raw_grid_kwh = max(0.0, float(ac_in) / 1000.0)
        else:
            raw_grid_kwh = max(0.0, input_kwh - solar_kwh)

        if mode == "total":
            output_kwh = (bat_out_wh + pt_wh) / 1000.0
            grid_kwh = raw_grid_kwh + (pt_wh / 1000.0)
        else:
            output_kwh = bat_out_wh / 1000.0
            grid_kwh = raw_grid_kwh

        saved_d = output_kwh * rate
        grid_d = grid_kwh * rate

        if key not in groups:
            groups[key] = {
                "period": key,
                "label": label,
                "grid_cost": 0.0,
                "solar_cost": 0.0,
                "baseline_cost": 0.0,
                "charged_kwh": 0.0,
                "consumed_kwh": 0.0,
                "solar_kwh": 0.0,
                "min_ts": float(ts),
                "max_ts": float(ts),
            }
        g = groups[key]
        g["grid_cost"] += grid_d
        g["baseline_cost"] += saved_d
        g["charged_kwh"] += grid_kwh
        g["consumed_kwh"] += output_kwh
        g["solar_kwh"] += solar_kwh
        g["min_ts"] = min(g["min_ts"], float(ts))
        g["max_ts"] = max(g["max_ts"], float(ts))

    out = []
    for key in sorted(groups.keys(), reverse=True):
        g = groups[key]
        if group_by == "week":
            min_d = datetime.fromtimestamp(g["min_ts"] + tz_offset_seconds, tz=timezone.utc)
            max_d = datetime.fromtimestamp(g["max_ts"] + tz_offset_seconds, tz=timezone.utc)
            g["label"] = f"{key} ({min_d.strftime('%b %d')} – {max_d.strftime('%b %d')})"

        grid_cost = round(g["grid_cost"], 2)
        baseline_cost = round(g["baseline_cost"], 2)
        net_saved = round(baseline_cost - grid_cost, 2)
        charged_kwh = round(g["charged_kwh"], 3)
        consumed_kwh = round(g["consumed_kwh"], 3)
        solar_kwh = round(g["solar_kwh"], 3)
        avg_buy_rate = round(grid_cost / charged_kwh, 4) if charged_kwh > 0 else 0.0
        avg_use_rate = round(baseline_cost / consumed_kwh, 4) if consumed_kwh > 0 else 0.0
        efficiency_pct = round((consumed_kwh / charged_kwh) * 100, 1) if charged_kwh > 0 else None

        out.append({
            "period": key,
            "label": g["label"],
            "grid_cost": grid_cost,
            "solar_cost": 0.0,
            "baseline_cost": baseline_cost,
            "net_saved": net_saved,
            "charged_kwh": charged_kwh,
            "consumed_kwh": consumed_kwh,
            "solar_kwh": solar_kwh,
            "avg_buy_rate": avg_buy_rate,
            "avg_use_rate": avg_use_rate,
            "efficiency_pct": efficiency_pct,
            "currency": plan.get("currency", "USD"),
        })
    return out


def tou_distribution(history: list[dict[str, Any]],
                     plan: dict[str, Any] | None = None,
                     tz_offset_seconds: int = 0,
                     mode: str = "battery",
                     capacity_wh: float = 1264.0) -> dict[str, Any]:
    """Calculate energy distribution across TOU rate tiers."""
    plan = plan or get_plan()
    if plan.get("type") != "tou":
        return {
            "tiers": [],
            "arbitrage_score": 0.0,
            "total_charged_kwh": 0.0,
            "total_discharged_kwh": 0.0,
            "currency": plan.get("currency", "USD"),
        }

    tagged = tag_passthrough(history, capacity_wh)
    slots = plan.get("tou_rates") or []
    tier_map: dict[tuple[float, str], dict[str, Any]] = {}
    for s in slots:
        rate = float(s.get("rate") or 0)
        label = str(s.get("label") or f"{rate:.3f}")
        k = (rate, label)
        if k not in tier_map:
            tier_map[k] = {
                "rate": rate,
                "label": label,
                "charged_kwh": 0.0,
                "discharged_kwh": 0.0,
                "charged_cost": 0.0,
                "avoided_cost": 0.0,
            }

    total_charged = 0.0
    total_discharged = 0.0

    for row in tagged:
        ts = row.get("ts")
        if ts is None:
            continue
        local = datetime.fromtimestamp(float(ts) + tz_offset_seconds, tz=timezone.utc)
        matched_slot = None
        for slot in slots:
            if slot_matches(slot, local, plan):
                matched_slot = slot
                break

        if not matched_slot:
            continue

        rate = float(matched_slot.get("rate") or 0)
        label = str(matched_slot.get("label") or f"{rate:.3f}")
        k = (rate, label)
        tier = tier_map.get(k)
        if not tier:
            continue

        bat_out_wh = float(row.get("battery_out_wh") or 0.0)
        pt_wh = float(row.get("passthrough_wh") or 0.0)
        solar_kwh = float(row.get("solar_wh") or 0.0) / 1000.0
        input_kwh = float(row.get("input_wh") or 0.0) / 1000.0
        ac_in = row.get("ac_input_wh")
        if ac_in is not None:
            raw_grid_kwh = max(0.0, float(ac_in) / 1000.0)
        else:
            raw_grid_kwh = max(0.0, input_kwh - solar_kwh)

        if mode == "total":
            output_kwh = (bat_out_wh + pt_wh) / 1000.0
            grid_kwh = raw_grid_kwh + (pt_wh / 1000.0)
        else:
            output_kwh = bat_out_wh / 1000.0
            grid_kwh = raw_grid_kwh

        tier["charged_kwh"] += grid_kwh
        tier["discharged_kwh"] += output_kwh
        tier["charged_cost"] += grid_kwh * rate
        tier["avoided_cost"] += output_kwh * rate
        total_charged += grid_kwh
        total_discharged += output_kwh

    tiers_out = []
    for k in sorted(tier_map.keys(), key=lambda x: x[0]):
        t = tier_map[k]
        c_kwh = round(t["charged_kwh"], 3)
        d_kwh = round(t["discharged_kwh"], 3)
        c_pct = round((c_kwh / total_charged) * 100, 1) if total_charged > 0 else 0.0
        d_pct = round((d_kwh / total_discharged) * 100, 1) if total_discharged > 0 else 0.0
        tiers_out.append({
            "rate": t["rate"],
            "label": t["label"],
            "charged_kwh": c_kwh,
            "charged_pct": c_pct,
            "charged_cost": round(t["charged_cost"], 2),
            "discharged_kwh": d_kwh,
            "discharged_pct": d_pct,
            "avoided_cost": round(t["avoided_cost"], 2),
        })

    active_tiers = [t for t in tiers_out if t["charged_kwh"] > 0 or t["discharged_kwh"] > 0]
    score = 0.0
    if active_tiers and total_charged > 0 and total_discharged > 0:
        cheapest_tier = min(active_tiers, key=lambda t: t["rate"])
        priciest_tier = max(active_tiers, key=lambda t: t["rate"])
        score = round((cheapest_tier["charged_pct"] + priciest_tier["discharged_pct"]) / 2, 1)

    total_charged_cost = sum(t["charged_cost"] for t in tiers_out)
    total_avoided_cost = sum(t["avoided_cost"] for t in tiers_out)
    avg_charge_rate = round(total_charged_cost / total_charged, 4) if total_charged > 0 else None
    avg_discharge_rate = round(total_avoided_cost / total_discharged, 4) if total_discharged > 0 else None

    return {
        "tiers": tiers_out,
        "arbitrage_score": score,
        "total_charged_kwh": round(total_charged, 3),
        "total_discharged_kwh": round(total_discharged, 3),
        "avg_charge_rate": avg_charge_rate,
        "avg_discharge_rate": avg_discharge_rate,
        "currency": plan.get("currency", "USD"),
        "mode": mode,
    }


def cost_history_timeseries(history: list[dict[str, Any]],
                            plan: dict[str, Any] | None = None,
                            tz_offset_seconds: int = 0,
                            mode: str = "battery",
                            capacity_wh: float = 1264.0) -> list[dict[str, Any]]:
    """Transform energy history into time-series cost points for charting."""
    plan = plan or get_plan()
    tagged = tag_passthrough(history, capacity_wh)
    out = []
    for row in tagged:
        ts = row.get("ts")
        if ts is None:
            continue
        rate = rate_at(plan, float(ts), tz_offset_seconds)
        bat_out_wh = float(row.get("battery_out_wh") or 0.0)
        pt_wh = float(row.get("passthrough_wh") or 0.0)
        solar_kwh = float(row.get("solar_wh") or 0.0) / 1000.0
        input_kwh = float(row.get("input_wh") or 0.0) / 1000.0
        ac_in = row.get("ac_input_wh")
        if ac_in is not None:
            raw_grid_kwh = max(0.0, float(ac_in) / 1000.0)
        else:
            raw_grid_kwh = max(0.0, input_kwh - solar_kwh)

        if mode == "total":
            output_kwh = (bat_out_wh + pt_wh) / 1000.0
            grid_kwh = raw_grid_kwh + (pt_wh / 1000.0)
        else:
            output_kwh = bat_out_wh / 1000.0
            grid_kwh = raw_grid_kwh

        saved_d = output_kwh * rate
        grid_d = grid_kwh * rate
        out.append({
            "ts": int(ts),
            "rate": rate,
            "grid_cost": round(grid_d, 4),
            "baseline_cost": round(saved_d, 4),
            "net_saved": round(saved_d - grid_d, 4),
            "grid_kwh": round(grid_kwh, 4),
            "output_kwh": round(output_kwh, 4),
            "passthrough_kwh": round(pt_wh / 1000.0, 4),
            "battery_out_kwh": round(bat_out_wh / 1000.0, 4),
            "battery_pct": row.get("battery_pct"),
        })
    return out


def lifetime_savings(history: list[dict[str, Any]],
                     plan: dict[str, Any] | None = None,
                     tz_offset_seconds: int = 0,
                     mode: str = "battery",
                     capacity_wh: float = 1264.0) -> dict[str, Any]:
    """Alias for compute_savings — same math, just intended over the whole
    sample history. Kept separate so callers self-document intent."""
    return compute_savings(history, plan, tz_offset_seconds, mode=mode, capacity_wh=capacity_wh)


def today_savings(history_today: list[dict[str, Any]],
                  plan: dict[str, Any] | None = None,
                  tz_offset_seconds: int = 0,
                  mode: str = "battery",
                  capacity_wh: float = 1264.0) -> dict[str, Any]:
    """Caller passes only today's hourly buckets (server filters by
    _start_of_day). Same math."""
    return compute_savings(history_today, plan, tz_offset_seconds, mode=mode, capacity_wh=capacity_wh)


__all__ = [
    "COST_PATH",
    "DEFAULT_PLAN",
    "PRESETS",
    "compute_savings",
    "cost_breakdown",
    "cost_history_timeseries",
    "easter_sunday",
    "get_plan",
    "get_qc_holidays",
    "is_holiday",
    "lifetime_savings",
    "list_presets",
    "rate_at",
    "set_plan",
    "slot_matches",
    "tag_passthrough",
    "today_savings",
    "tou_distribution",
]
