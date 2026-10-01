"""Cost / savings: plan validation, TOU rate lookup, savings math."""
from __future__ import annotations

import importlib

import pytest


def _fresh_cost(tmp_path, monkeypatch):
    """Reload cost.py with COST_PATH pointing into tmp_path."""
    monkeypatch.setenv("JACKERY_COST_FILE", str(tmp_path / "cost.json"))
    import cost
    importlib.reload(cost)
    return cost


def test_get_plan_returns_default_when_unset(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    plan = cost.get_plan()
    assert plan["type"] == "flat"
    assert plan["rate_per_kwh"] == 0.30


def test_set_plan_round_trip_flat(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    saved = cost.set_plan({"type": "flat", "rate_per_kwh": 0.42, "currency": "USD"})
    assert saved is not None
    got = cost.get_plan()
    assert got["rate_per_kwh"] == 0.42
    assert got["currency"] == "USD"


def test_set_plan_round_trip_tou(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    plan = {
        "type": "tou",
        "currency": "USD",
        "tou_rates": [
            {"start_hour": 16, "end_hour": 21, "rate": 0.61, "label": "peak"},
            {"start_hour": 0, "end_hour": 16, "rate": 0.31, "label": "off-peak"},
        ],
    }
    assert cost.set_plan(plan) is not None
    got = cost.get_plan()
    assert got["type"] == "tou"
    assert len(got["tou_rates"]) == 2


@pytest.mark.parametrize("bad_plan", [
    {"type": "wat"},
    {"type": "flat", "rate_per_kwh": -1},
    {"type": "flat", "rate_per_kwh": 99},
    {"type": "tou", "tou_rates": []},
    {"type": "tou", "tou_rates": [{"start_hour": -1, "end_hour": 5, "rate": 0.3}]},
    {"type": "tou", "tou_rates": [{"start_hour": 0, "end_hour": 24, "rate": 99}]},
    "not a dict",
])
def test_set_plan_rejects_invalid(tmp_path, monkeypatch, bad_plan):
    cost = _fresh_cost(tmp_path, monkeypatch)
    assert cost.set_plan(bad_plan) is None


def test_rate_at_flat(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    plan = {"type": "flat", "rate_per_kwh": 0.40, "currency": "USD"}
    assert cost.rate_at(plan, 1_700_000_000) == 0.40


def test_rate_at_tou_picks_correct_slot(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    plan = {
        "type": "tou", "currency": "USD",
        "tou_rates": [
            {"start_hour": 16, "end_hour": 21, "rate": 0.61, "label": "peak"},
            {"start_hour": 0, "end_hour": 16, "rate": 0.31, "label": "off-peak"},
            {"start_hour": 21, "end_hour": 24, "rate": 0.31, "label": "off-peak"},
        ],
    }
    # 17:00 UTC → peak slot
    ts_5pm_utc = 1_700_000_000 - (1_700_000_000 % 86400) + 17 * 3600
    assert cost.rate_at(plan, ts_5pm_utc, tz_offset_seconds=0) == 0.61
    # 10:00 UTC → off-peak slot
    ts_10am_utc = ts_5pm_utc - 7 * 3600
    assert cost.rate_at(plan, ts_10am_utc, tz_offset_seconds=0) == 0.31


def test_rate_at_tou_with_timezone_shift(tmp_path, monkeypatch):
    """A 17:00 PDT timestamp should pick peak when tz_offset=-7h.
    Without the offset shift, it'd pick the wrong slot."""
    cost = _fresh_cost(tmp_path, monkeypatch)
    plan = {
        "type": "tou", "currency": "USD",
        "tou_rates": [
            {"start_hour": 16, "end_hour": 21, "rate": 0.61, "label": "peak"},
            {"start_hour": 0, "end_hour": 16, "rate": 0.31, "label": "off-peak"},
        ],
    }
    # UTC 00:00 of a chosen day = 17:00 of the previous day in PDT (-7).
    # So an UTC ts at 00:00 should land in PDT 17:00 = peak.
    ts_midnight_utc = 1_700_000_000 - (1_700_000_000 % 86400)
    assert cost.rate_at(plan, ts_midnight_utc, tz_offset_seconds=-7 * 3600) == 0.61


def test_rate_at_tou_seasonal_picks_summer_or_winter(tmp_path, monkeypatch):
    """A slot with `months: [6,7,8,9]` only applies in summer; the
    matching winter slot covers the rest of the year. PG&E EV2-A has
    distinct rates per season — a Jul peak hour costs more than a Jan
    peak hour."""
    cost = _fresh_cost(tmp_path, monkeypatch)
    plan = {
        "type": "tou", "currency": "USD",
        "tou_rates": [
            {"start_hour": 16, "end_hour": 21, "rate": 0.61,
             "label": "summer peak", "months": [6, 7, 8, 9]},
            {"start_hour": 16, "end_hour": 21, "rate": 0.45,
             "label": "winter peak", "months": [1, 2, 3, 4, 5, 10, 11, 12]},
        ],
    }
    # 2024-07-15 17:00 UTC — Jul, peak hour → summer peak
    import calendar
    summer_ts = calendar.timegm((2024, 7, 15, 17, 0, 0, 0, 0, 0))
    assert cost.rate_at(plan, summer_ts) == 0.61
    # 2024-01-15 17:00 UTC — Jan, peak hour → winter peak
    winter_ts = calendar.timegm((2024, 1, 15, 17, 0, 0, 0, 0, 0))
    assert cost.rate_at(plan, winter_ts) == 0.45


def test_rate_at_tou_year_round_slot_falls_through(tmp_path, monkeypatch):
    """A slot without `months` applies in any month."""
    cost = _fresh_cost(tmp_path, monkeypatch)
    plan = {
        "type": "tou", "currency": "USD",
        "tou_rates": [
            {"start_hour": 0, "end_hour": 24, "rate": 0.30, "label": "anytime"},
        ],
    }
    import calendar
    for month in (1, 5, 7, 11):
        ts = calendar.timegm((2024, month, 1, 12, 0, 0, 0, 0, 0))
        assert cost.rate_at(plan, ts) == 0.30


def test_rate_at_tou_wraparound_slot(tmp_path, monkeypatch):
    """A slot like 22-06 wraps midnight; both 23:00 and 03:00 should match."""
    cost = _fresh_cost(tmp_path, monkeypatch)
    plan = {
        "type": "tou", "currency": "USD",
        "tou_rates": [
            {"start_hour": 22, "end_hour": 6, "rate": 0.20, "label": "super-off-peak"},
            {"start_hour": 6, "end_hour": 22, "rate": 0.50, "label": "day"},
        ],
    }
    base = 1_700_000_000 - (1_700_000_000 % 86400)
    assert cost.rate_at(plan, base + 23 * 3600, 0) == 0.20  # 23:00
    assert cost.rate_at(plan, base + 3 * 3600, 0) == 0.20   # 03:00
    assert cost.rate_at(plan, base + 12 * 3600, 0) == 0.50  # 12:00


def test_compute_savings_flat(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    plan = {"type": "flat", "rate_per_kwh": 0.30, "currency": "USD"}
    history = [
        # Hour 1: 2 kWh out, 1 kWh in (all solar)
        {"ts": 1_700_000_000, "solar_wh": 1000, "ac_input_wh": 0,
         "input_wh": 1000, "output_wh": 2000},
        # Hour 2: 1 kWh out, 0.5 solar + 0.5 from grid
        {"ts": 1_700_003_600, "solar_wh": 500, "ac_input_wh": 500,
         "input_wh": 1000, "output_wh": 1000},
    ]
    out = cost.compute_savings(history, plan)
    # saved (= output * rate):  3.0 kWh * $0.30 = $0.90
    # grid_cost (= ac * rate):  0.5 kWh * $0.30 = $0.15
    # net:                      $0.75
    assert out["solar_savings"] == 0.90
    assert out["grid_cost"] == 0.15
    assert out["net_savings"] == 0.75
    assert out["output_kwh"] == 3.0
    assert out["solar_kwh"] == 1.5
    assert out["grid_kwh"] == 0.5


def test_compute_savings_credits_battery_use_at_active_rate(tmp_path, monkeypatch):
    """1 kWh out at peak (4-9pm) saves more than 1 kWh out at off-peak —
    every Wh from the battery displaces a Wh you'd have bought at the
    rate active when you use it. Storage decouples charging time from
    consumption time, and the savings credit follows consumption."""
    cost = _fresh_cost(tmp_path, monkeypatch)
    plan = {
        "type": "tou", "currency": "USD",
        "tou_rates": [
            {"start_hour": 16, "end_hour": 21, "rate": 0.60, "label": "peak"},
            {"start_hour": 0, "end_hour": 16, "rate": 0.30, "label": "off-peak"},
            {"start_hour": 21, "end_hour": 24, "rate": 0.30, "label": "off-peak"},
        ],
    }
    base = 1_700_000_000 - (1_700_000_000 % 86400)
    history = [
        # 17:00 UTC, 1 kWh out — peak rate ($0.60)
        {"ts": base + 17 * 3600, "solar_wh": 0, "ac_input_wh": 0,
         "input_wh": 0, "output_wh": 1000},
        # 10:00 UTC, 1 kWh out — off-peak rate ($0.30)
        {"ts": base + 10 * 3600, "solar_wh": 0, "ac_input_wh": 0,
         "input_wh": 0, "output_wh": 1000},
    ]
    out = cost.compute_savings(history, plan, tz_offset_seconds=0)
    assert out["solar_savings"] == 0.90  # 1 * 0.60 + 1 * 0.30


def test_compute_savings_handles_storage_drain(tmp_path, monkeypatch):
    """Drawing from previously-stored solar (no input today) still credits
    savings — bug repro for "6 kWh out + 1.7 kWh in only saved $0.52"."""
    cost = _fresh_cost(tmp_path, monkeypatch)
    plan = {"type": "flat", "rate_per_kwh": 0.31, "currency": "USD"}
    history = [
        {"ts": 1_700_000_000, "output_wh": 6000, "input_wh": 1700,
         "ac_input_wh": 0, "solar_wh": 1700},
    ]
    out = cost.compute_savings(history, plan)
    # 6 kWh out * $0.31 = $1.86 saved, 0 grid, $1.86 net
    assert out["solar_savings"] == 1.86
    assert out["grid_cost"] == 0.0
    assert out["net_savings"] == 1.86


def test_compute_savings_falls_back_to_inferred_grid_for_old_rows(tmp_path, monkeypatch):
    """Pre-migration samples won't have ac_input_wh. Fall back to the
    inferred (input - solar) grid estimate so lifetime totals don't
    silently drop pre-migration grid charging."""
    cost = _fresh_cost(tmp_path, monkeypatch)
    plan = {"type": "flat", "rate_per_kwh": 0.30, "currency": "USD"}
    # Old-format row: ac_input_wh missing entirely.
    history = [
        {"ts": 1_700_000_000, "output_wh": 0, "input_wh": 1000, "solar_wh": 200},
    ]
    out = cost.compute_savings(history, plan)
    # input 1.0 - solar 0.2 = 0.8 kWh inferred grid * $0.30 = $0.24
    assert out["grid_cost"] == 0.24


def test_list_presets_returns_id_and_label(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    presets = cost.list_presets()
    assert all("id" in p and "label" in p and "plan" in p for p in presets)
    pge = next((p for p in presets if p["id"] == "pge-ev2a"), None)
    assert pge is not None
    assert pge["plan"]["type"] == "tou"


def test_compute_savings_has_baseline_and_rates(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    plan = {"type": "flat", "rate_per_kwh": 0.20, "currency": "CAD"}
    history = [
        {"ts": 1_700_000_000, "solar_wh": 0, "ac_input_wh": 2000, "output_wh": 1000},
    ]
    out = cost.compute_savings(history, plan)
    assert out["baseline_cost"] == 0.20
    assert out["solar_cost"] == 0.0
    assert out["grid_cost"] == 0.40
    assert out["net_savings"] == -0.20
    assert out["avg_buy_rate"] == 0.20
    assert out["avg_use_rate"] == 0.20


def test_cost_breakdown_aggregations(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    plan = {
        "type": "tou", "currency": "CAD",
        "tou_rates": [
            {"start_hour": 0, "end_hour": 6, "rate": 0.05, "label": "night"},
            {"start_hour": 6, "end_hour": 24, "rate": 0.20, "label": "day"},
        ],
    }
    import calendar
    ts_mon_night = calendar.timegm((2024, 1, 15, 2, 0, 0, 0, 0, 0))
    ts_mon_day   = calendar.timegm((2024, 1, 15, 12, 0, 0, 0, 0, 0))
    ts_tue_night = calendar.timegm((2024, 1, 16, 3, 0, 0, 0, 0, 0))

    history = [
        {"ts": ts_mon_night, "ac_input_wh": 2000, "output_wh": 0, "solar_wh": 0},
        {"ts": ts_mon_day,   "ac_input_wh": 0,    "output_wh": 1500, "solar_wh": 0},
        {"ts": ts_tue_night, "ac_input_wh": 1000, "output_wh": 800, "solar_wh": 0},
    ]

    # Daily breakdown
    daily = cost.cost_breakdown(history, plan, group_by="day")
    assert len(daily) == 2
    mon = next(d for d in daily if d["period"] == "2024-01-15")
    assert mon["grid_cost"] == 0.10
    assert mon["baseline_cost"] == 0.30
    assert mon["net_saved"] == 0.20
    assert mon["avg_buy_rate"] == 0.05
    assert mon["avg_use_rate"] == 0.20

    # Weekly breakdown
    weekly = cost.cost_breakdown(history, plan, group_by="week")
    assert len(weekly) == 1
    assert "2024-W03" in weekly[0]["period"]
    assert weekly[0]["charged_kwh"] == 3.0
    assert weekly[0]["consumed_kwh"] == 2.3

    # Monthly breakdown
    monthly = cost.cost_breakdown(history, plan, group_by="month")
    assert len(monthly) == 1
    assert monthly[0]["period"] == "2024-01"

    # Yearly breakdown
    yearly = cost.cost_breakdown(history, plan, group_by="year")
    assert len(yearly) == 1
    assert yearly[0]["period"] == "2024"


def test_tou_distribution_and_arbitrage_score(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    plan = {
        "type": "tou", "currency": "CAD",
        "tou_rates": [
            {"start_hour": 0, "end_hour": 6, "rate": 0.05, "label": "night"},
            {"start_hour": 6, "end_hour": 24, "rate": 0.20, "label": "day"},
        ],
    }
    import calendar
    ts_night = calendar.timegm((2024, 1, 15, 2, 0, 0, 0, 0, 0))
    ts_day   = calendar.timegm((2024, 1, 15, 12, 0, 0, 0, 0, 0))
    history = [
        {"ts": ts_night, "ac_input_wh": 5000, "output_wh": 0, "solar_wh": 0},
        {"ts": ts_day,   "ac_input_wh": 0,    "output_wh": 4000, "solar_wh": 0},
    ]
    dist = cost.tou_distribution(history, plan)
    tiers = dist["tiers"]
    assert len(tiers) == 2
    night_tier = next(t for t in tiers if t["label"] == "night")
    day_tier = next(t for t in tiers if t["label"] == "day")
    assert night_tier["charged_pct"] == 100.0
    assert night_tier["discharged_pct"] == 0.0
    assert day_tier["charged_pct"] == 0.0
    assert day_tier["discharged_pct"] == 100.0
    assert dist["arbitrage_score"] == 100.0


def test_cost_history_timeseries(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    plan = {"type": "flat", "rate_per_kwh": 0.10, "currency": "USD"}
    history = [
        {"ts": 1_700_000_000, "ac_input_wh": 1000, "output_wh": 500, "battery_pct": 80},
    ]
    # In total mode: all equipment output is included and wall draw is additive
    ts_total = cost.cost_history_timeseries(history, plan, mode="total")
    assert len(ts_total) == 1
    pt = ts_total[0]
    assert pt["ts"] == 1_700_000_000
    assert pt["grid_cost"] == 0.15
    assert pt["baseline_cost"] == 0.05
    assert pt["net_saved"] == -0.10
    assert pt["battery_pct"] == 80
    assert pt["passthrough_kwh"] == 0.5
    assert pt["battery_out_kwh"] == 0.0

    # In battery mode: output only includes energy discharged from battery cells
    ts_battery = cost.cost_history_timeseries(history, plan, mode="battery")
    assert ts_battery[0]["grid_cost"] == 0.10
    assert ts_battery[0]["baseline_cost"] == 0.0
    assert ts_battery[0]["net_saved"] == -0.10
    assert ts_battery[0]["battery_out_kwh"] == 0.0


def test_tag_passthrough_separates_bypass_from_battery_discharge(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    # 1264 Wh battery capacity -> 1% = 12.64 Wh
    # Sequence:
    # 1. 3 hours of AC passthrough: sitting at 85% SOC with 100W output, 0W input
    # 2. 2 hours of battery discharge: SOC drops 85% -> 69% with 100W output, 0W input
    history = [
        # Passthrough at 85%
        {"ts": 1000, "output_wh": 100, "ac_input_wh": 0, "battery_pct": 85},
        {"ts": 4600, "output_wh": 100, "ac_input_wh": 0, "battery_pct": 85},
        {"ts": 8200, "output_wh": 100, "ac_input_wh": 0, "battery_pct": 85},
        # Discharge from 85% to 69% (16% drop = 16 * 12.64 = ~202 Wh expected)
        {"ts": 11800, "output_wh": 100, "ac_input_wh": 0, "battery_pct": 77},
        {"ts": 15400, "output_wh": 100, "ac_input_wh": 0, "battery_pct": 69},
    ]

    tagged = cost.tag_passthrough(history, capacity_wh=1264.0)
    assert len(tagged) == 5

    # First 3 rows should be tagged as passthrough
    assert tagged[0]["passthrough_wh"] == 100
    assert tagged[0]["battery_out_wh"] == 0
    assert tagged[1]["passthrough_wh"] == 100
    assert tagged[1]["battery_out_wh"] == 0
    assert tagged[2]["passthrough_wh"] == 100
    assert tagged[2]["battery_out_wh"] == 0

    # Last 2 rows should be tagged as battery discharge
    assert tagged[3]["battery_out_wh"] == 100
    assert tagged[3]["passthrough_wh"] == 0
    assert tagged[4]["battery_out_wh"] == 100
    assert tagged[4]["passthrough_wh"] == 0


def test_compute_savings_dual_mode_battery_vs_total(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    plan = {
        "type": "tou", "currency": "USD",
        "tou_rates": [
            {"start_hour": 0, "end_hour": 16, "rate": 0.30, "label": "off-peak"},
            {"start_hour": 16, "end_hour": 24, "rate": 0.60, "label": "peak"},
        ],
    }

    # Off-peak: charged 1000 Wh from grid at $0.30 (cost $0.30), then 500 Wh passthrough at 85%
    # Peak: discharged 800 Wh from battery at $0.60 (baseline $0.48), 85% -> 22%
    import calendar
    ts_offpeak_chg = calendar.timegm((2024, 1, 15, 2, 0, 0, 0, 0, 0))
    ts_offpeak_pt1 = calendar.timegm((2024, 1, 15, 4, 0, 0, 0, 0, 0))
    ts_offpeak_pt2 = calendar.timegm((2024, 1, 15, 5, 0, 0, 0, 0, 0))
    ts_peak_dis    = calendar.timegm((2024, 1, 15, 18, 0, 0, 0, 0, 0))

    history = [
        {"ts": ts_offpeak_chg, "ac_input_wh": 1000, "output_wh": 0, "battery_pct": 85},
        {"ts": ts_offpeak_pt1, "ac_input_wh": 0, "output_wh": 250, "battery_pct": 85},
        {"ts": ts_offpeak_pt2, "ac_input_wh": 0, "output_wh": 250, "battery_pct": 85},
        {"ts": ts_peak_dis,    "ac_input_wh": 0, "output_wh": 800, "battery_pct": 22},
    ]

    bat_savings = cost.compute_savings(history, plan, mode="battery", capacity_wh=1264.0)
    tot_savings = cost.compute_savings(history, plan, mode="total", capacity_wh=1264.0)

    # Battery mode:
    # Charged: 1.0 kWh, Discharged: 0.8 kWh -> Efficiency: 80%
    assert bat_savings["grid_kwh"] == 1.0
    assert bat_savings["output_kwh"] == 0.8
    assert bat_savings["grid_cost"] == 0.30
    assert bat_savings["baseline_cost"] == 0.48
    assert bat_savings["net_savings"] == 0.18
    assert bat_savings["efficiency_pct"] == 80.0

    # Total mode:
    # Passthrough (500 Wh @ $0.30 = $0.15) added to BOTH grid and baseline
    # Grid: 1.0 + 0.5 = 1.5 kWh (Cost: $0.30 + $0.15 = $0.45)
    # Output: 0.8 + 0.5 = 1.3 kWh (Baseline: $0.48 + $0.15 = $0.63)
    # Net: $0.63 - $0.45 = $0.18 (IDENTICAL NET SAVINGS!)
    assert tot_savings["grid_kwh"] == 1.5
    assert tot_savings["output_kwh"] == 1.3
    assert tot_savings["grid_cost"] == 0.45
    assert tot_savings["baseline_cost"] == 0.63
    assert tot_savings["net_savings"] == 0.18


def test_tou_distribution_dual_mode(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    plan = {
        "type": "tou", "currency": "USD",
        "tou_rates": [
            {"start_hour": 0, "end_hour": 16, "rate": 0.30, "label": "off-peak"},
            {"start_hour": 16, "end_hour": 24, "rate": 0.60, "label": "peak"},
        ],
    }
    import calendar
    ts_offpeak_chg = calendar.timegm((2024, 1, 15, 2, 0, 0, 0, 0, 0))
    ts_offpeak_pt  = calendar.timegm((2024, 1, 15, 6, 0, 0, 0, 0, 0))
    ts_peak_dis    = calendar.timegm((2024, 1, 15, 18, 0, 0, 0, 0, 0))

    history = [
        {"ts": ts_offpeak_chg, "ac_input_wh": 1000, "output_wh": 0, "battery_pct": 85},
        {"ts": ts_offpeak_pt,  "ac_input_wh": 0, "output_wh": 500, "battery_pct": 85},
        {"ts": ts_peak_dis,    "ac_input_wh": 0, "output_wh": 800, "battery_pct": 22},
    ]

    bat_dist = cost.tou_distribution(history, plan, mode="battery", capacity_wh=1264.0)
    tot_dist = cost.tou_distribution(history, plan, mode="total", capacity_wh=1264.0)

    # In battery mode:
    # Off-peak has 100% of charge (1.0 kWh), 0% discharge.
    # Peak has 0% of charge, 100% of discharge (0.8 kWh).
    bat_off = next(t for t in bat_dist["tiers"] if t["label"] == "off-peak")
    bat_peak = next(t for t in bat_dist["tiers"] if t["label"] == "peak")
    assert bat_off["charged_kwh"] == 1.0
    assert bat_off["discharged_kwh"] == 0.0
    assert bat_peak["charged_kwh"] == 0.0
    assert bat_peak["discharged_kwh"] == 0.8
    assert bat_dist["arbitrage_score"] == 100.0

    # In total mode:
    # Off-peak has 1.5 kWh charged (1.0 chg + 0.5 pt) and 0.5 kWh discharged (0.5 pt).
    tot_off = next(t for t in tot_dist["tiers"] if t["label"] == "off-peak")
    tot_peak = next(t for t in tot_dist["tiers"] if t["label"] == "peak")
    assert tot_off["charged_kwh"] == 1.5
    assert tot_off["discharged_kwh"] == 0.5
    assert tot_peak["discharged_kwh"] == 0.8


def test_easter_sunday_calculation(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    assert cost.easter_sunday(2024) == (3, 31)
    assert cost.easter_sunday(2025) == (4, 20)
    assert cost.easter_sunday(2026) == (4, 5)
    assert cost.easter_sunday(2027) == (3, 28)


def test_get_qc_holidays_matches_official_list(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    import datetime
    hols_2026 = cost.get_qc_holidays(2026)
    # Check fixed holidays
    assert datetime.date(2026, 1, 1) in hols_2026
    assert datetime.date(2026, 1, 2) in hols_2026
    assert datetime.date(2026, 6, 24) in hols_2026
    assert datetime.date(2026, 7, 1) in hols_2026
    assert datetime.date(2026, 12, 24) in hols_2026
    assert datetime.date(2026, 12, 25) in hols_2026
    assert datetime.date(2026, 12, 26) in hols_2026
    assert datetime.date(2026, 12, 31) in hols_2026
    # Check variable holidays in 2026
    assert datetime.date(2026, 4, 3) in hols_2026   # Good Friday
    assert datetime.date(2026, 4, 6) in hols_2026   # Easter Monday
    assert datetime.date(2026, 5, 18) in hols_2026  # Patriotes (Monday before May 25)
    assert datetime.date(2026, 9, 7) in hols_2026   # Labour Day (1st Monday in Sep)
    assert datetime.date(2026, 10, 12) in hols_2026 # Thanksgiving (2nd Monday in Oct)
    assert len(hols_2026) == 13


def test_is_holiday_custom_and_calendar(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    import datetime
    # Plan with custom explicit dates and recurring MM-DD
    plan = {
        "type": "tou",
        "holiday_calendar": "CA-QC",
        "holidays": ["2026-02-14", "11-11"],
    }
    # Hydro-Quebec holiday via calendar
    assert cost.is_holiday(datetime.date(2026, 1, 1), plan) is True
    # Explicit custom date
    assert cost.is_holiday(datetime.date(2026, 2, 14), plan) is True
    # Recurring MM-DD
    assert cost.is_holiday(datetime.date(2026, 11, 11), plan) is True
    assert cost.is_holiday(datetime.date(2027, 11, 11), plan) is True
    # Non-holiday
    assert cost.is_holiday(datetime.date(2026, 2, 15), plan) is False


def test_validation_weekdays_and_holidays(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    # Valid plan with weekdays, holiday rules, and calendar
    valid = {
        "type": "tou",
        "currency": "CAD",
        "holiday_calendar": "CA-QC",
        "holidays": ["2026-05-01", "12-25"],
        "tou_rates": [
            {
                "start_hour": 6, "end_hour": 10, "rate": 0.10, "label": "peak",
                "weekdays": [1, 2, 3, 4, 5], "holidays": "exclude",
            },
            {
                "start_hour": 6, "end_hour": 23, "rate": 0.05, "label": "offpeak",
                "weekdays": [6, 7], "holidays": "include",
            },
            {
                "start_hour": 0, "end_hour": 24, "rate": 0.03, "label": "dynamic holiday",
                "holidays": "only",
            },
        ],
    }
    saved = cost.set_plan(valid)
    assert saved is not None
    assert saved["currency"] == "CAD"
    assert saved["holiday_calendar"] == "CA-QC"
    assert saved["holidays"] == ["12-25", "2026-05-01"]
    assert saved["tou_rates"][0]["weekdays"] == [1, 2, 3, 4, 5]
    assert saved["tou_rates"][0]["holidays"] == "exclude"
    assert saved["tou_rates"][1]["weekdays"] == [6, 7]
    assert saved["tou_rates"][1]["holidays"] == "include"
    assert saved["tou_rates"][2]["holidays"] == "only"

    # Reject invalid weekdays
    bad_weekdays = {
        "type": "tou",
        "tou_rates": [{"start_hour": 0, "end_hour": 24, "rate": 0.1, "weekdays": [0, 8]}],
    }
    assert cost.set_plan(bad_weekdays) is None

    # Reject invalid holidays format in slot
    bad_slot_hol = {
        "type": "tou",
        "tou_rates": [{"start_hour": 0, "end_hour": 24, "rate": 0.1, "holidays": "bogus"}],
    }
    assert cost.set_plan(bad_slot_hol) is None

    # Reject invalid date string in plan holidays
    bad_hol_date = {
        "type": "tou",
        "holidays": ["not-a-date"],
        "tou_rates": [{"start_hour": 0, "end_hour": 24, "rate": 0.1}],
    }
    assert cost.set_plan(bad_hol_date) is None


def test_rate_at_weekday_vs_weekend_and_holiday(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    import calendar
    plan = {
        "type": "tou",
        "holiday_calendar": "CA-QC",
        "tou_rates": [
            {"start_hour": 6, "end_hour": 10, "rate": 0.60, "label": "weekday peak",
             "weekdays": [1, 2, 3, 4, 5], "holidays": "exclude"},
            {"start_hour": 6, "end_hour": 10, "rate": 0.20, "label": "weekend/holiday off-peak",
             "weekdays": [6, 7], "holidays": "include"},
            {"start_hour": 0, "end_hour": 24, "rate": 0.10, "label": "base"},
        ],
    }
    # 2026-04-02 is a Thursday (regular weekday): 08:00 -> peak ($0.60)
    ts_thu = calendar.timegm((2026, 4, 2, 8, 0, 0, 0, 0, 0))
    assert cost.rate_at(plan, ts_thu) == 0.60

    # 2026-04-03 is Good Friday (holiday weekday): 08:00 -> weekend/holiday rate ($0.20)
    ts_good_fri = calendar.timegm((2026, 4, 3, 8, 0, 0, 0, 0, 0))
    assert cost.rate_at(plan, ts_good_fri) == 0.20

    # 2026-04-04 is a Saturday (weekend): 08:00 -> weekend/holiday rate ($0.20)
    ts_sat = calendar.timegm((2026, 4, 4, 8, 0, 0, 0, 0, 0))
    assert cost.rate_at(plan, ts_sat) == 0.20


def test_rate_at_holiday_only_dynamic_pricing(tmp_path, monkeypatch):
    cost = _fresh_cost(tmp_path, monkeypatch)
    import calendar
    plan = {
        "type": "tou",
        "holidays": ["2026-01-15"],  # specific dynamic pricing event
        "tou_rates": [
            {"start_hour": 16, "end_hour": 20, "rate": 0.88, "label": "dynamic event peak",
             "holidays": "only"},
            {"start_hour": 16, "end_hour": 20, "rate": 0.25, "label": "normal peak"},
            {"start_hour": 0, "end_hour": 24, "rate": 0.10, "label": "base"},
        ],
    }
    # Event day (2026-01-15): 18:00 -> dynamic event peak ($0.88)
    ts_event = calendar.timegm((2026, 1, 15, 18, 0, 0, 0, 0, 0))
    assert cost.rate_at(plan, ts_event) == 0.88

    # Non-event day (2026-01-16): 18:00 -> normal peak ($0.25)
    ts_normal = calendar.timegm((2026, 1, 16, 18, 0, 0, 0, 0, 0))
    assert cost.rate_at(plan, ts_normal) == 0.25


def test_hydro_quebec_preset_full_schedule(tmp_path, monkeypatch):
    """Verify Hydro-Québec Tarif D TDT preset across all Tableau 6 & 7 conditions (Tier 2 rates)."""
    cost = _fresh_cost(tmp_path, monkeypatch)
    import calendar
    presets = {p["id"]: p["plan"] for p in cost.list_presets()}
    hq_plan = presets["hq-tarif-d-tdt"]
    assert hq_plan["currency"] == "CAD"
    assert hq_plan["holiday_calendar"] == "CA-QC"

    # WINTER (e.g. January 2026)
    # 2026-01-14 is a Wednesday (regular winter weekday)
    # Night: 02:00 -> 0.04972
    assert cost.rate_at(hq_plan, calendar.timegm((2026, 1, 14, 2, 0, 0, 0, 0, 0))) == 0.04972
    # Morning Peak: 08:00 -> 0.21964
    assert cost.rate_at(hq_plan, calendar.timegm((2026, 1, 14, 8, 0, 0, 0, 0, 0))) == 0.21964
    # Mid-day Off-Peak: 12:00 -> 0.08851
    assert cost.rate_at(hq_plan, calendar.timegm((2026, 1, 14, 12, 0, 0, 0, 0, 0))) == 0.08851
    # Evening Peak: 18:00 -> 0.21964
    assert cost.rate_at(hq_plan, calendar.timegm((2026, 1, 14, 18, 0, 0, 0, 0, 0))) == 0.21964
    # Evening Off-Peak: 21:00 -> 0.08851
    assert cost.rate_at(hq_plan, calendar.timegm((2026, 1, 14, 21, 0, 0, 0, 0, 0))) == 0.08851
    # Late Night: 23:30 -> 0.04972
    assert cost.rate_at(hq_plan, calendar.timegm((2026, 1, 14, 23, 30, 0, 0, 0, 0))) == 0.04972

    # Winter Weekend (2026-01-17 Saturday)
    # 08:00 and 18:00 should be off-peak (0.08851), no peak on weekends!
    assert cost.rate_at(hq_plan, calendar.timegm((2026, 1, 17, 8, 0, 0, 0, 0, 0))) == 0.08851
    assert cost.rate_at(hq_plan, calendar.timegm((2026, 1, 17, 18, 0, 0, 0, 0, 0))) == 0.08851

    # Winter Holiday (2026-01-01 New Year's Day is a Thursday)
    # Peak hours should not apply; charged at off-peak rate 0.08851!
    assert cost.rate_at(hq_plan, calendar.timegm((2026, 1, 1, 8, 0, 0, 0, 0, 0))) == 0.08851
    assert cost.rate_at(hq_plan, calendar.timegm((2026, 1, 1, 18, 0, 0, 0, 0, 0))) == 0.08851

    # SUMMER (e.g. July 2026)
    # 2026-07-08 is a Wednesday (regular summer weekday)
    # Day off-peak: 10:00 -> 0.10652
    assert cost.rate_at(hq_plan, calendar.timegm((2026, 7, 8, 10, 0, 0, 0, 0, 0))) == 0.10652
    # Summer Peak PM: 18:00 -> 0.18576
    assert cost.rate_at(hq_plan, calendar.timegm((2026, 7, 8, 18, 0, 0, 0, 0, 0))) == 0.18576
    # Night: 03:00 -> 0.04972
    assert cost.rate_at(hq_plan, calendar.timegm((2026, 7, 8, 3, 0, 0, 0, 0, 0))) == 0.04972

    # Summer Holiday (2026-07-01 Canada Day is a Wednesday)
    # 18:00 should NOT be peak; should be off-peak 0.10652!
    assert cost.rate_at(hq_plan, calendar.timegm((2026, 7, 1, 18, 0, 0, 0, 0, 0))) == 0.10652

