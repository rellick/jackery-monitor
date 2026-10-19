"""EnergyDB: schema migration + solar tracking + history round-trip."""
from __future__ import annotations

import sqlite3
import time

import pytest

from energy_db import EnergyDB


@pytest.fixture()
def db(tmp_path):
    return EnergyDB(str(tmp_path / "energy.db"))


def test_record_and_history_includes_solar(db):
    sn = "TEST-001"
    db.upsert_device(sn, "Test 5000", 13, "Explorer 5000 Plus")
    # Two readings 5 min apart, 600 W solar in, 200 W load.
    t0 = time.time() - 600
    db.record(sn, t0, input_w=600, output_w=200, battery_pct=80, solar_w=600)
    db.record(sn, t0 + 300, input_w=600, output_w=200, battery_pct=80, solar_w=600)
    rows = db.history(sn, hours=24, bucket_s=60)
    assert rows
    # Total solar Wh ≈ 600W * 5min = 50 Wh; allow some slack for trapezoid.
    total_solar = sum(r["solar_wh"] for r in rows)
    assert 40 < total_solar < 60
    assert any(r["solar_w"] > 0 for r in rows)


def test_record_works_without_solar_arg_for_back_compat(db):
    sn = "TEST-002"
    db.upsert_device(sn, "Old call site", 22, "Explorer 5000 Plus")
    t0 = time.time() - 600
    db.record(sn, t0, input_w=400, output_w=100, battery_pct=60)
    db.record(sn, t0 + 300, input_w=400, output_w=100, battery_pct=60)
    rows = db.history(sn, hours=24, bucket_s=60)
    assert rows
    # Solar defaulted to 0 → all solar columns zero.
    assert all(r["solar_wh"] == 0 for r in rows)
    assert all(r["solar_w"] == 0 for r in rows)


def test_capacity_override_round_trip(db):
    sn = "TEST-CAP"
    db.upsert_device(sn, "Test 5000+B5000", 13, "Explorer 5000 Plus")
    assert db.get_capacity_override(sn) is None
    assert db.set_capacity_override(sn, 10080) is True
    assert db.get_capacity_override(sn) == 10080
    # Override surfaces in list_devices()
    devs = db.list_devices()
    me = next(d for d in devs if d["device_sn"] == sn)
    assert me["capacity_wh_override"] == 10080
    # Clear via None
    assert db.set_capacity_override(sn, None) is True
    assert db.get_capacity_override(sn) is None


def test_capacity_override_rejects_out_of_range(db):
    sn = "TEST-CAP-RANGE"
    db.upsert_device(sn, "Tester", 13, "Explorer 5000 Plus")
    assert db.set_capacity_override(sn, 100) is False     # too small
    assert db.set_capacity_override(sn, 500_000) is False  # too large
    assert db.set_capacity_override(sn, "abc") is False    # not a number
    assert db.get_capacity_override(sn) is None


def test_migration_adds_columns_to_pre_v0_1_db(tmp_path):
    """A DB created without solar_wh/last_solar_w should ALTER on open."""
    path = str(tmp_path / "old.db")
    bucket_recent = int((time.time() - 600) // 60) * 60  # within last 24h
    # Simulate the old schema (no solar columns).
    con = sqlite3.connect(path)
    con.executescript("""
      CREATE TABLE devices (device_sn TEXT PRIMARY KEY, name TEXT,
                            model_code INTEGER, model_name TEXT,
                            first_seen INTEGER, last_seen INTEGER);
      CREATE TABLE samples (device_sn TEXT NOT NULL, bucket INTEGER NOT NULL,
                            input_wh REAL NOT NULL DEFAULT 0,
                            output_wh REAL NOT NULL DEFAULT 0,
                            last_input_w INTEGER, last_output_w INTEGER,
                            last_battery_pct INTEGER,
                            sample_count INTEGER NOT NULL DEFAULT 0,
                            PRIMARY KEY (device_sn, bucket));
    """)
    con.execute("INSERT INTO samples VALUES (?, ?, 10, 5, 100, 50, 70, 1)",
                ("SN1", bucket_recent))
    con.commit()
    con.close()

    # Opening EnergyDB on this path should trigger the ALTER TABLE migration.
    db = EnergyDB(path)
    cols = sqlite3.connect(path).execute("PRAGMA table_info(samples)").fetchall()
    col_names = {c[1] for c in cols}
    assert "solar_wh" in col_names
    assert "last_solar_w" in col_names

    # Old row should still be there and history() should not crash on it.
    rows = db.history("SN1", hours=24, bucket_s=60)
    assert any(r["input_wh"] == 10 for r in rows)


def test_history_computes_plug_on_frac_from_decisions(db):
    # The forecaster nets EV charging out of the load profile using the
    # controller's plug-state log (NOT the flaky emeter-derived
    # diverted_wh). history() must surface, per bucket, the fraction of
    # decisions where the plug was ON.
    sn = "TEST-PLUG"
    db.upsert_device(sn, "Test 5000", 13, "Explorer 5000 Plus")
    base = (int(time.time()) - 7200) // 3600 * 3600 + 1800  # mid-bucket
    db.record(sn, base, input_w=0, output_w=1880, battery_pct=50, solar_w=0)
    db.record(sn, base + 60, input_w=0, output_w=1880, battery_pct=50, solar_w=0)
    # 3 ON decisions + 1 OFF, all inside the same 1h bucket -> frac 0.75.
    for i, state in enumerate(["on", "on", "on", "off"]):
        db.record_solar_charge_decision(
            sn,
            {"decided_at": base + i * 30, "mode": "active", "action": "skip",
             "plug_state_before": state, "current_soc_pct": 50},
            executed=False,
        )
    rows = db.history(sn, hours=24, bucket_s=3600)
    bkt = (base // 3600) * 3600
    row = next(r for r in rows if r["ts"] == bkt)
    assert row["solar_charge_plug_on_frac"] == pytest.approx(0.75)


def test_last_battery_full_ts(db):
    """Exercises the scheduler query directly (raw bucket inserts —
    record()'s gap guard drops sparse synthetic samples)."""
    sn = "TEST-BAL"
    db.upsert_device(sn, "Test 5000", 13, "Explorer 5000 Plus")
    now = int(time.time())
    full_t = (now - 2 * 86400) // 60 * 60

    def put(bucket, pct):
        with db._conn() as c:
            c.execute(
                """INSERT OR REPLACE INTO samples
                       (device_sn, bucket, last_battery_pct, sample_count)
                   VALUES (?, ?, ?, 1)""", (sn, bucket, pct))

    put(full_t, 100)
    put(full_t + 60, 100)
    put((now - 3600) // 60 * 60, 50)
    got = db.last_battery_full_ts(sn, full_pct=100)
    assert got == full_t + 60                  # newest >=100 bucket
    # 99% must not count as full at full_pct=100...
    put((now - 1800) // 60 * 60, 99)
    assert db.last_battery_full_ts(sn, full_pct=100) == full_t + 60
    # ...but does at full_pct=99.
    assert db.last_battery_full_ts(sn, full_pct=99) == (now - 1800) // 60 * 60
    # Outside the bounded lookback -> None.
    assert db.last_battery_full_ts(sn, full_pct=100, lookback_days=1) is None
    # Unknown device -> None.
    assert db.last_battery_full_ts("NOPE") is None


def test_weather_forecast_replace_and_get(db):
    now = int(time.time())
    rows = [{"ts": now + 3600, "ghi_w_m2": 500.0, "cloud_cover_pct": 10.0},
            {"ts": now + 7200, "ghi_w_m2": 600.0, "cloud_cover_pct": 5.0}]
    assert db.replace_weather_forecast(rows, fetched_at=now) == 2
    got, fetched = db.get_weather_forecast(since_ts=now)
    assert fetched == now and len(got) == 2 and got[0]["ghi_w_m2"] == 500.0
    # replace is wholesale — old rows gone, new fetched_at recorded.
    db.replace_weather_forecast(
        [{"ts": now + 10800, "ghi_w_m2": 700.0, "cloud_cover_pct": 0.0}],
        fetched_at=now + 60)
    got2, fetched2 = db.get_weather_forecast(since_ts=now)
    assert len(got2) == 1 and fetched2 == now + 60
    # since_ts filters out already-elapsed hours.
    assert db.get_weather_forecast(since_ts=now + 20000) == ([], 0)


def _put_sample(db, sn, bucket, *, input_wh=0.0, output_wh=0.0, solar_wh=0.0,
                ac_input_wh=0.0, diverted_wh=0.0, solar_w=0, output_w=0,
                pct=None):
    """Raw bucket insert (record()'s gap guard drops sparse synthetic
    samples — same pattern as test_last_battery_full_ts, extended with
    the energy columns daily_rollup aggregates)."""
    with db._conn() as c:
        c.execute(
            """INSERT OR REPLACE INTO samples
                   (device_sn, bucket, input_wh, output_wh, solar_wh,
                    ac_input_wh, solar_charge_diverted_wh,
                    last_input_w, last_output_w, last_solar_w,
                    last_ac_input_w, last_battery_pct, sample_count)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0, ?, 1)""",
            (sn, bucket, input_wh, output_wh, solar_wh, ac_input_wh,
             diverted_wh, output_w, solar_w, pct))


def test_daily_rollup_multi_day_values(db):
    sn = "TEST-DAILY"
    db.upsert_device(sn, "Test 5000", 13, "Explorer 5000 Plus")
    now = int(time.time())
    day0 = (now // 86400) * 86400          # start of today, UTC (tz=0)
    day_a = day0 - 86400                   # yesterday
    # Yesterday: two buckets that must merge into one row.
    _put_sample(db, sn, day_a + 3600, input_wh=1000, output_wh=2000,
                solar_wh=1500, ac_input_wh=500, diverted_wh=100,
                solar_w=1200, output_w=800, pct=40)
    _put_sample(db, sn, day_a + 7200, input_wh=200, output_wh=1000,
                solar_wh=500, diverted_wh=50,
                solar_w=3618, output_w=500, pct=90)
    # Today: one bucket with NULL soc (min/max must stay None).
    _put_sample(db, sn, day0 + 60, output_wh=111, solar_wh=333)

    rows = db.daily_rollup(sn, days=7, tz_offset_s=0)
    assert len(rows) == 2
    a, b = rows                            # oldest -> newest
    assert a["date"] < b["date"]
    assert a == {"date": a["date"], "solar_kwh": 2.0, "consumed_kwh": 3.0,
                 "charged_kwh": 1.2, "grid_kwh": 0.5, "diverted_kwh": 0.15,
                 "peak_solar_w": 3618, "peak_output_w": 800,
                 "min_soc": 40, "max_soc": 90}
    assert b["solar_kwh"] == 0.33 and b["consumed_kwh"] == 0.11
    assert b["min_soc"] is None and b["max_soc"] is None
    assert b["peak_solar_w"] == 0 and b["peak_output_w"] == 0


def test_daily_rollup_local_day_boundary(db):
    # A bucket at 23:30 LOCAL (UTC-7 -> 06:30 UTC the next day) must land
    # on the local date, not the UTC date.
    sn = "TEST-DAILY-TZ"
    db.upsert_device(sn, "Test 5000", 13, "Explorer 5000 Plus")
    tz = -25200
    now = int(time.time())
    local_day = ((now + tz) // 86400) - 1  # yesterday, local
    bucket = (local_day * 86400 + 23 * 3600 + 30 * 60) - tz  # 23:30 local
    _put_sample(db, sn, bucket, solar_wh=1000, pct=50)

    from datetime import datetime, timezone
    local_date = datetime.fromtimestamp(
        local_day * 86400, tz=timezone.utc).strftime("%Y-%m-%d")
    utc_date = datetime.fromtimestamp(
        bucket, tz=timezone.utc).strftime("%Y-%m-%d")
    assert utc_date != local_date          # boundary actually straddled

    rows = db.daily_rollup(sn, days=7, tz_offset_s=tz)
    assert len(rows) == 1
    assert rows[0]["date"] == local_date
    assert rows[0]["solar_kwh"] == 1.0


def test_daily_rollup_days_bound_excludes_old_rows(db):
    sn = "TEST-DAILY-BOUND"
    db.upsert_device(sn, "Test 5000", 13, "Explorer 5000 Plus")
    now = int(time.time())
    old_bucket = ((now - 10 * 86400) // 60) * 60
    recent_bucket = ((now - 3600) // 60) * 60
    _put_sample(db, sn, old_bucket, solar_wh=5000, pct=10)
    _put_sample(db, sn, recent_bucket, solar_wh=250, pct=60)

    rows = db.daily_rollup(sn, days=5, tz_offset_s=0)
    assert len(rows) == 1
    assert rows[0]["solar_kwh"] == 0.25
    # Widening the window brings the old day back.
    assert len(db.daily_rollup(sn, days=30, tz_offset_s=0)) == 2


def test_daily_rollup_empty_device(db):
    assert db.daily_rollup("TEST-DAILY-NONE") == []


def test_history_omits_plug_on_frac_when_no_decisions(db):
    # Buckets with no decision coverage must not carry the field — the
    # forecaster then falls back to raw output / recorded diverted_wh.
    sn = "TEST-NODEC"
    db.upsert_device(sn, "Test 5000", 13, "Explorer 5000 Plus")
    base = (int(time.time()) - 7200) // 3600 * 3600 + 1800
    db.record(sn, base, input_w=0, output_w=300, battery_pct=50, solar_w=0)
    db.record(sn, base + 60, input_w=0, output_w=300, battery_pct=50, solar_w=0)
    rows = db.history(sn, hours=24, bucket_s=3600)
    assert all("solar_charge_plug_on_frac" not in r for r in rows)


def test_battery_temp_c_recording_and_history(db):
    sn = "TEST-TEMP"
    db.upsert_device(sn, "Test 1000", 5, "Explorer 1000 Plus")
    base = (int(time.time()) - 3600) // 60 * 60
    db.record(sn, base, input_w=100, output_w=50, battery_pct=80, battery_temp_c=25.4)
    db.record(sn, base + 60, input_w=100, output_w=50, battery_pct=81, battery_temp_c=26.0)
    rows = db.history(sn, hours=2, bucket_s=60)
    assert len(rows) >= 1
    # Check that the bucket has the recorded average temperature
    temp_rows = [r for r in rows if r.get("battery_temp_c") is not None]
    assert temp_rows[-1]["battery_temp_c"] == 26.0


def test_location_load_history(db):
    sn1 = "SINOPE-TH1"
    sn2 = "SINOPE-CTRL1"
    db.upsert_device(sn1, "Salon Thermostat", brand="sinope", device_type="thermostat", location_id="maison")
    db.upsert_device(sn2, "Water Heater", brand="sinope", device_type="controller", location_id="maison")
    now = int(time.time())
    bkt = (now - 1800) // 600 * 600
    db.record_load(sn1, bkt, power_w=1500, temp_c=21.5)
    db.record_load(sn2, bkt, power_w=3000, temp_c=None)

    rows = db.location_load_history("maison", hours=2, bucket_s=600)
    assert len(rows) >= 1
    r = rows[-1]
    assert r["total_w"] == 4500
    assert r["thermostat_w"] == 1500
    assert r["controller_w"] == 3000
    assert r["avg_temp_c"] == 21.5
    assert r["device_count"] == 2


def test_fan_runtime_summary(db):
    sn = "DAIKIN-FAN-TEST"
    db.upsert_device(sn, "Daikin Thermostat", brand="daikin", device_type="thermostat", location_id="maison")
    now = int(time.time())
    start = (now - 25 * 60) // 60 * 60

    # Record 10 samples with equipment_status = 3 (heating)
    for i in range(10):
        t = start + i * 60
        db.record_thermostat(sn, t, power_w=1200, temp_c=21.0, outdoor_temp_c=12.0, equipment_status=3)

    # Record 15 samples with equipment_status = 4 (fan circulating)
    for i in range(10, 25):
        t = start + i * 60
        db.record_thermostat(sn, t, power_w=80, temp_c=21.0, outdoor_temp_c=12.0, equipment_status=4)

    summary = db.fan_runtime_summary(sn, hours=1)
    assert summary["circulating_min"] == 15
    assert summary["total_fan_min"] == 25
    assert summary["window_hours"] == 1


def test_record_metered_hourly_consumption(db):
    sn = "SINOPE-RM3500-TEST"
    db.upsert_device(sn, "Water Heater", brand="sinope", device_type="controller", location_id="maison")
    now = int(time.time())
    hour_start = (now - 3600) // 3600 * 3600

    # Record 1500 Wh for this hour
    db.record_metered_hourly_consumption(sn, hour_start, wh=1500.0, water_temp_c=58.5)

    totals = db.totals(sn)
    assert totals["lifetime"]["output_wh"] == pytest.approx(1500.0, rel=1e-2)

    rows = db.history(sn, hours=2, bucket_s=3600)
    assert len(rows) >= 1
    hour_row = next((r for r in rows if r["ts"] == hour_start), None)
    assert hour_row is not None
    assert hour_row["output_wh"] == pytest.approx(1500.0, rel=1e-2)
    assert hour_row["battery_temp_c"] == pytest.approx(58.5, rel=1e-2)

    # Test delete_device_samples
    del_count = db.delete_device_samples(sn)
    assert del_count == 60  # 60 minute buckets deleted
    assert db.totals(sn)["lifetime"]["output_wh"] == 0.0


def test_record_dehumidifier_and_summary(db):
    sn = "midea_150633095041182"
    db.upsert_device(sn, "Danby Dehumidifier", brand="danby", device_type="dehumidifier", location_id="maison")
    now = int(time.time())
    start = (now - 30 * 60) // 60 * 60

    # 10 minutes compressor running (status="dehumidifying", eq_status=1)
    for i in range(10):
        t = start + i * 60
        db.record_dehumidifier(sn, t, current_humidity=55, target_humidity=45, operational_status="dehumidifying", temp_c=21.0, fan_speed=40)

    # 10 minutes fan only (status="fan_only", eq_status=2)
    for i in range(10, 20):
        t = start + i * 60
        db.record_dehumidifier(sn, t, current_humidity=42, target_humidity=45, operational_status="fan_only", temp_c=21.2, fan_speed=40)

    # 10 minutes off (status="off", eq_status=0)
    for i in range(20, 30):
        t = start + i * 60
        db.record_dehumidifier(sn, t, current_humidity=43, target_humidity=45, operational_status="off", temp_c=21.5, fan_speed=40)

    summary = db.dehumidifier_runtime_summary(sn, hours=1)
    assert summary["compressor_min"] == 10
    assert summary["fan_only_min"] == 10
    assert summary["off_min"] == 10
    assert summary["window_hours"] == 1
    assert summary["energy_kwh"] > 0


def test_record_thinq_appliance_cooking_and_subzones(db):
    sn = "thinq_maison_oven_123"
    db.upsert_device(sn, "LG Double Oven Range", brand="thinq", device_type="cooking", location_id="maison")
    now = int(time.time()) // 60 * 60

    norm_dev = {
        "category": "cooking",
        "online": True,
        "is_cooking": True,
        "run_state": "COOKING",
        "current_temp_c": 195.0,
        "target_temp_c": 200.0,
        "remaining_min": 25,
        "sub_zones": [
            {
                "id": "LEFT_FRONT",
                "name": "Left Front",
                "zone_type": "burner",
                "power_level": 7,
                "state": "ON",
                "is_active": True,
            },
            {
                "id": "UPPER",
                "name": "Upper Cavity",
                "zone_type": "cavity",
                "power_level": 0,
                "state": "COOKING",
                "target_temp_c": 200.0,
                "current_temp_c": 195.0,
                "is_active": True,
            },
        ],
    }

    db.record_thinq_appliance(sn, now, norm_dev)
    db.record_thinq_appliance(sn, now + 60, norm_dev)

    rows = db.history(sn, hours=1, bucket_s=60)
    assert len(rows) >= 1
    r = rows[-1]
    assert r["output_w"] >= 2500  # Burner lvl 7 (1400W) + Oven cavity (1500W)
    assert r["equipment_status"] == 1
    assert r["battery_temp_c"] == 195.0
    assert r["outdoor_temp_c"] == 200.0
    assert "LEFT_FRONT" in (r.get("state_json") or "")


def test_record_thinq_appliance_laundry_and_refrigeration(db):
    w_sn = "thinq_maison_washer_456"
    now = int(time.time()) // 60 * 60
    norm_washer = {
        "category": "laundry",
        "online": True,
        "is_running": True,
        "run_state": "SPINNING",
        "current_step": "Spin",
        "course": "Heavy Duty",
        "remaining_min": 12,
        "door_locked": True,
        "raw_type": "WASHER",
    }
    db.record_thinq_appliance(w_sn, now, norm_washer)
    rows_w = db.history(w_sn, hours=1, bucket_s=60)
    assert len(rows_w) >= 1
    assert rows_w[-1]["equipment_status"] == 3  # spinning
    assert rows_w[-1]["output_w"] == 650.0

    f_sn = "thinq_maison_fridge_789"
    norm_fridge = {
        "category": "refrigeration",
        "online": True,
        "fridge_temp_c": 3.0,
        "freezer_temp_c": -18.0,
        "express_freeze": True,
        "door_opened": False,
        "eco_friendly": False,
    }
    db.record_thinq_appliance(f_sn, now, norm_fridge)
    rows_f = db.history(f_sn, hours=1, bucket_s=60)
    assert len(rows_f) >= 1
    assert rows_f[-1]["equipment_status"] == 1  # express freeze
    assert rows_f[-1]["output_w"] == 160.0
    assert rows_f[-1]["battery_temp_c"] == 3.0
    assert rows_f[-1]["outdoor_temp_c"] == -18.0


def test_record_thermostat_preserves_duty_and_state_json(db):
    sn = "sinope_555"
    now = int(time.time()) // 60 * 60
    import json
    st_json = json.dumps({"duty_pct": 65, "setpoint_c": 21.0, "load_watt": 2000})
    db.record_thermostat(
        device_sn=sn,
        ts=now,
        power_w=1300.0,
        temp_c=20.5,
        outdoor_temp_c=21.0,
        equipment_status=65,
        state_json=st_json,
    )
    rows = db.history(sn, hours=1, bucket_s=60)
    assert len(rows) >= 1
    r = rows[-1]
    assert r["output_w"] == 1300
    assert r["equipment_status"] == 65
    assert r["battery_temp_c"] == 20.5
    assert r["outdoor_temp_c"] == 21.0
    assert "duty_pct" in (r.get("state_json") or "")




