"""Unit tests for the automation rule engine.

Edge-trigger semantics, retry-on-failure, per-Jackery-device routing.
kasa_client.set_state is monkey-patched so no real network calls happen.
"""

from __future__ import annotations

import importlib

import pytest


@pytest.fixture()
def engine_with_fake_kasa(isolated_data, monkeypatch):
    """Reload the automation module against the isolated /data and
       patch kasa_client.set_state so we can introspect what would be called."""
    import automation
    import crypto_util
    import kasa_client
    importlib.reload(crypto_util)
    importlib.reload(kasa_client)
    importlib.reload(automation)

    calls: list[tuple[str, bool]] = []
    fail_next: list[Exception] = []

    async def fake_set_state(host: str, on: bool):
        if fail_next:
            raise fail_next.pop(0)
        calls.append((host, on))
        return {"host": host, "on": on}

    monkeypatch.setattr(kasa_client, "set_state", fake_set_state)
    return automation.AutomationEngine(), calls, fail_next


# ---------- _matches operator semantics ----------
def test_matches_lt():
    from automation import _matches
    assert _matches({"operator": "<", "value": 20}, 19.9) is True
    assert _matches({"operator": "<", "value": 20}, 20.0) is False
    assert _matches({"operator": "<", "value": 20}, 50) is False


def test_matches_lte():
    from automation import _matches
    assert _matches({"operator": "<=", "value": 20}, 20) is True
    assert _matches({"operator": "<=", "value": 20}, 21) is False


def test_matches_eq_with_tolerance():
    from automation import EQUALS_TOLERANCE, _matches
    assert _matches({"operator": "=", "value": 50}, 50.0) is True
    assert _matches({"operator": "=", "value": 50}, 50.0 + EQUALS_TOLERANCE) is True
    assert _matches({"operator": "=", "value": 50}, 50.0 + EQUALS_TOLERANCE + 0.01) is False


def test_matches_gte_and_gt():
    from automation import _matches
    assert _matches({"operator": ">=", "value": 80}, 80) is True
    assert _matches({"operator": ">=", "value": 80}, 79.99) is False
    assert _matches({"operator": ">",  "value": 80}, 80.01) is True
    assert _matches({"operator": ">",  "value": 80}, 80) is False


def test_matches_unknown_operator_returns_false():
    from automation import _matches
    assert _matches({"operator": "BAD", "value": 50}, 50) is False


# ---------- _validate ----------
def test_validate_rejects_bad_operator(isolated_data):
    import automation
    importlib.reload(automation)
    with pytest.raises(automation.AutomationError):
        automation._validate({
            "operator": "approximately",
            "value": 20,
            "action": "off",
            "kasa_host": "1.2.3.4",
        })


def test_validate_rejects_bad_action(isolated_data):
    import automation
    importlib.reload(automation)
    with pytest.raises(automation.AutomationError):
        automation._validate({
            "operator": "<",
            "value": 20,
            "action": "explode",
            "kasa_host": "1.2.3.4",
        })


def test_validate_rejects_missing_host(isolated_data):
    import automation
    importlib.reload(automation)
    with pytest.raises(automation.AutomationError):
        automation._validate({
            "operator": "<",
            "value": 20,
            "action": "off",
            "kasa_host": "",
        })


def test_validate_assigns_id_when_missing(isolated_data):
    import automation
    importlib.reload(automation)
    rule = automation._validate({
        "operator": "<", "value": 20, "action": "off",
        "kasa_host": "1.2.3.4",
    })
    assert "id" in rule and len(rule["id"]) == 8


# ---------- evaluate ----------
@pytest.mark.asyncio
async def test_evaluate_fires_on_edge_transition(engine_with_fake_kasa):
    eng, calls, _fail = engine_with_fake_kasa
    eng.upsert({
        "name": "low-batt off",
        "operator": "<", "value": 20, "action": "off",
        "kasa_host": "1.2.3.4",
        "jackery_device_sn": "A",
    })

    # SOC well above threshold → no edge, no fire.
    fired = await eng.evaluate({"A": 50}, active_sn="A")
    assert fired == [] and calls == []

    # Drop below threshold → edge transition → fires once.
    fired = await eng.evaluate({"A": 15}, active_sn="A")
    assert len(fired) == 1
    assert calls == [("1.2.3.4", False)]

    # Stay below → no re-fire.
    fired = await eng.evaluate({"A": 10}, active_sn="A")
    assert fired == []
    assert calls == [("1.2.3.4", False)]

    # Climb back above → state resets.
    await eng.evaluate({"A": 50}, active_sn="A")
    # Cross again → fires again.
    fired = await eng.evaluate({"A": 15}, active_sn="A")
    assert len(fired) == 1
    assert calls == [("1.2.3.4", False), ("1.2.3.4", False)]


@pytest.mark.asyncio
async def test_evaluate_retries_on_action_failure(engine_with_fake_kasa):
    """Failed action must NOT consume the edge — retry on next eval."""
    eng, calls, fail_next = engine_with_fake_kasa
    eng.upsert({
        "name": "test",
        "operator": "<", "value": 20, "action": "off",
        "kasa_host": "1.2.3.4",
        "jackery_device_sn": "A",
    })
    # Prime: prior reading high so SOC=15 is a transition.
    await eng.evaluate({"A": 50}, active_sn="A")

    # First eval at low SOC: action fails.
    fail_next.append(RuntimeError("device offline"))
    fired = await eng.evaluate({"A": 15}, active_sn="A")
    assert fired == []  # no successful fires
    assert calls == []  # action threw, nothing recorded

    # Second eval at low SOC: action succeeds → fires now.
    fired = await eng.evaluate({"A": 15}, active_sn="A")
    assert len(fired) == 1
    assert calls == [("1.2.3.4", False)]


@pytest.mark.asyncio
async def test_evaluate_routes_to_correct_device(engine_with_fake_kasa):
    eng, calls, _ = engine_with_fake_kasa
    eng.upsert({
        "name": "5K low",
        "operator": "<", "value": 20, "action": "off",
        "kasa_host": "1.2.3.4",
        "jackery_device_sn": "FIVE_K",
    })
    eng.upsert({
        "name": "HP3 high",
        "operator": ">=", "value": 80, "action": "on",
        "kasa_host": "5.6.7.8",
        "jackery_device_sn": "HP_3K",
    })

    # Prime both rules' edge state at non-matching values.
    await eng.evaluate({"FIVE_K": 50, "HP_3K": 50}, active_sn="FIVE_K")
    assert calls == []

    # 5K crosses low; HP3 still mid → only first rule fires.
    await eng.evaluate({"FIVE_K": 15, "HP_3K": 50}, active_sn="FIVE_K")
    assert calls == [("1.2.3.4", False)]

    # HP3 crosses high; 5K still low (no edge, already fired) → only HP3 fires.
    await eng.evaluate({"FIVE_K": 15, "HP_3K": 85}, active_sn="FIVE_K")
    assert calls == [("1.2.3.4", False), ("5.6.7.8", True)]


@pytest.mark.asyncio
async def test_evaluate_skips_disabled_rules(engine_with_fake_kasa):
    eng, calls, _ = engine_with_fake_kasa
    eng.upsert({
        "name": "test",
        "operator": "<", "value": 20, "action": "off",
        "kasa_host": "1.2.3.4",
        "jackery_device_sn": "A",
        "enabled": False,
    })
    await eng.evaluate({"A": 50}, active_sn="A")
    fired = await eng.evaluate({"A": 15}, active_sn="A")
    assert fired == [] and calls == []


@pytest.mark.asyncio
async def test_evaluate_handles_missing_device_data(engine_with_fake_kasa):
    """Rule for device 'A' shouldn't fire (or crash) when only 'B' has data."""
    eng, calls, _ = engine_with_fake_kasa
    eng.upsert({
        "name": "test",
        "operator": "<", "value": 20, "action": "off",
        "kasa_host": "1.2.3.4",
        "jackery_device_sn": "A",
    })
    fired = await eng.evaluate({"B": 5}, active_sn="B")
    assert fired == [] and calls == []


# ---------- CRUD ----------
def test_crud(isolated_data):
    import automation
    importlib.reload(automation)
    eng = automation.AutomationEngine()
    assert eng.list_rules() == []
    rule = eng.upsert({
        "name": "test",
        "operator": "<", "value": 20, "action": "off",
        "kasa_host": "1.2.3.4",
    })
    assert len(eng.list_rules()) == 1
    # Update by id
    eng.upsert({**rule, "name": "renamed"})
    assert eng.list_rules()[0]["name"] == "renamed"
    # Delete
    assert eng.delete(rule["id"]) is True
    assert eng.list_rules() == []
    # Delete nonexistent
    assert eng.delete("nope") is False


async def test_engine_calls_firing_recorder_on_successful_fire(
    isolated_data, monkeypatch,
):
    """The recorder callback is the persistence hook — wired in
    server.py to EnergyDB.record_automation_fire. A failed Kasa toggle
    must NOT invoke the recorder (no log row for a fire that didn't
    happen). A successful one must pass the rule + SOC context through.

    `async def` test (auto-collected by pytest-asyncio) so the
    AutomationEngine's asyncio.Lock() can attach to the running loop
    on Python 3.9 — calling asyncio.run() repeatedly closes the
    default loop and breaks downstream tests that build their own
    asyncio.Lock at module import."""
    import importlib

    import automation
    import crypto_util
    import kasa_client
    importlib.reload(crypto_util)
    importlib.reload(kasa_client)
    importlib.reload(automation)

    fail_next: list[Exception] = []

    async def fake_set_state(host: str, on: bool):
        if fail_next:
            raise fail_next.pop(0)
        return {"host": host, "on": on}

    monkeypatch.setattr(kasa_client, "set_state", fake_set_state)

    recorded: list[dict] = []

    def recorder(**kwargs):
        recorded.append(kwargs)

    eng = automation.AutomationEngine(firing_recorder=recorder)
    rule = eng.upsert({
        "name": "low-batt off",
        "operator": "<", "value": 20, "action": "off",
        "kasa_host": "PLUG", "jackery_device_sn": "SN-A",
    })

    # Successful fire — recorder gets called with the right context.
    await eng.evaluate({"SN-A": 15}, active_sn="SN-A")
    assert len(recorded) == 1
    r = recorded[0]
    assert r["rule_id"] == rule["id"]
    assert r["rule_name"] == "low-batt off"
    assert r["action"] == "off"
    assert r["kasa_host"] == "PLUG"
    assert r["jackery_sn"] == "SN-A"
    assert r["soc_at_fire"] == pytest.approx(15.0)
    assert r["operator"] == "<"
    assert r["threshold"] == pytest.approx(20.0)

    # Re-firing on the same edge state is a no-op (edge already consumed).
    await eng.evaluate({"SN-A": 14}, active_sn="SN-A")
    assert len(recorded) == 1

    # SOC goes back above threshold then below — fresh edge, fresh log row.
    await eng.evaluate({"SN-A": 50}, active_sn="SN-A")
    await eng.evaluate({"SN-A": 12}, active_sn="SN-A")
    assert len(recorded) == 2

    # Now make the Kasa call fail. The toggle didn't actually happen,
    # so the recorder MUST NOT be invoked.
    await eng.evaluate({"SN-A": 50}, active_sn="SN-A")  # reset edge
    fail_next.append(RuntimeError("boom"))
    await eng.evaluate({"SN-A": 10}, active_sn="SN-A")
    assert len(recorded) == 2  # unchanged — failed toggle isn't logged


# ---------- find_conflicting_rules ----------
def _rule(**overrides):
    base = {
        "id": "r1", "name": "rule", "enabled": True,
        "trigger": "battery_percent", "operator": "<", "value": 20,
        "action": "off", "kasa_host": "1.1.1.1", "kasa_alias": "plug",
        "jackery_device_sn": None,
    }
    base.update(overrides)
    return base


def test_find_conflicting_rules_matches_same_host():
    from automation import find_conflicting_rules
    rules = [
        _rule(id="a", kasa_host="1.1.1.1"),
        _rule(id="b", kasa_host="2.2.2.2"),  # different host — no conflict
    ]
    out = find_conflicting_rules(
        rules, smart_charge_kasa_host="1.1.1.1",
        smart_charge_device_sn="SN-A",
    )
    assert [r["id"] for r in out] == ["a"]


def test_find_conflicting_rules_skips_disabled():
    from automation import find_conflicting_rules
    rules = [
        _rule(id="a", kasa_host="1.1.1.1", enabled=False),
        _rule(id="b", kasa_host="1.1.1.1", enabled=True),
    ]
    out = find_conflicting_rules(
        rules, smart_charge_kasa_host="1.1.1.1",
        smart_charge_device_sn="SN-A",
    )
    assert [r["id"] for r in out] == ["b"]


def test_find_conflicting_rules_filters_by_device_sn():
    from automation import find_conflicting_rules
    rules = [
        _rule(id="a", kasa_host="1.1.1.1", jackery_device_sn="SN-A"),
        _rule(id="b", kasa_host="1.1.1.1", jackery_device_sn="SN-B"),
        # Null sn means "any active device" — counts as conflict.
        _rule(id="c", kasa_host="1.1.1.1", jackery_device_sn=None),
    ]
    out = find_conflicting_rules(
        rules, smart_charge_kasa_host="1.1.1.1",
        smart_charge_device_sn="SN-A",
    )
    assert sorted(r["id"] for r in out) == ["a", "c"]


def test_find_conflicting_rules_empty_when_host_unset():
    from automation import find_conflicting_rules
    rules = [_rule(kasa_host="1.1.1.1")]
    # No smart-charge plug configured → no possible conflict.
    assert find_conflicting_rules(
        rules, smart_charge_kasa_host=None, smart_charge_device_sn="SN-A",
    ) == []
    assert find_conflicting_rules(
        rules, smart_charge_kasa_host="", smart_charge_device_sn="SN-A",
    ) == []


def test_find_conflicting_rules_case_insensitive_host():
    from automation import find_conflicting_rules
    rules = [_rule(id="a", kasa_host="HostA")]
    out = find_conflicting_rules(
        rules, smart_charge_kasa_host="hosta",
        smart_charge_device_sn="SN-A",
    )
    assert [r["id"] for r in out] == ["a"]


# ---------- disable_many ----------
def test_disable_many_flips_enabled_and_resets_edge_state(isolated_data):
    import automation
    importlib.reload(automation)
    eng = automation.AutomationEngine()
    a = eng.upsert(_rule(id="a", kasa_host="1.1.1.1", enabled=True))
    b = eng.upsert(_rule(id="b", kasa_host="2.2.2.2", enabled=True))
    # Simulate a previous fire so last_state is set; disable_many must
    # reset it so a re-enable later doesn't suppress the next edge.
    eng.rules[0]["last_state"] = True

    disabled = eng.disable_many([a["id"], b["id"]])
    assert sorted(disabled) == sorted([a["id"], b["id"]])
    rules_by_id = {r["id"]: r for r in eng.list_rules()}
    assert rules_by_id[a["id"]]["enabled"] is False
    assert rules_by_id[a["id"]]["last_state"] is None
    assert rules_by_id[b["id"]]["enabled"] is False


def test_disable_many_skips_already_disabled_and_unknown(isolated_data):
    import automation
    importlib.reload(automation)
    eng = automation.AutomationEngine()
    a = eng.upsert(_rule(id="a", kasa_host="1.1.1.1", enabled=False))
    b = eng.upsert(_rule(id="b", kasa_host="2.2.2.2", enabled=True))

    # `a` is already disabled; "ghost" doesn't exist. Only `b` should
    # appear in the returned list.
    disabled = eng.disable_many([a["id"], "ghost", b["id"]])
    assert disabled == [b["id"]]


def test_disable_many_empty_input_returns_empty(isolated_data):
    import automation
    importlib.reload(automation)
    eng = automation.AutomationEngine()
    eng.upsert(_rule(id="a", kasa_host="1.1.1.1", enabled=True))
    assert eng.disable_many([]) == []
    assert eng.disable_many(None) == []  # type: ignore[arg-type]
    # And the rule remained enabled.
    assert eng.list_rules()[0]["enabled"] is True


# ---------- Time of day parsing & formatting ----------
def test_parse_time_of_day():
    from automation import AutomationError, _format_time_of_day, _parse_time_of_day

    assert _parse_time_of_day("20:00") == 1200
    assert _parse_time_of_day("20:30") == 1230
    assert _parse_time_of_day("08:15") == 495
    assert _parse_time_of_day("8:15") == 495
    assert _parse_time_of_day("20h00") == 1200
    assert _parse_time_of_day("20h") == 1200
    assert _parse_time_of_day("8h30") == 510
    assert _parse_time_of_day("8:30 PM") == 1230
    assert _parse_time_of_day("8:30pm") == 1230
    assert _parse_time_of_day("8pm") == 1200
    assert _parse_time_of_day("12:00 AM") == 0
    assert _parse_time_of_day("12:00 PM") == 720
    assert _parse_time_of_day("23:59") == 1439
    assert _parse_time_of_day("00:00") == 0
    assert _parse_time_of_day("20:00:00") == 1200
    assert _parse_time_of_day(1200) == 1200

    assert _format_time_of_day(1200) == "20:00"
    assert _format_time_of_day(0) == "00:00"
    assert _format_time_of_day(495) == "08:15"

    with pytest.raises(AutomationError):
        _parse_time_of_day("")
    with pytest.raises(AutomationError):
        _parse_time_of_day("bad:time")
    with pytest.raises(AutomationError):
        _parse_time_of_day("25:00")
    with pytest.raises(AutomationError):
        _parse_time_of_day("20:65")


# ---------- Compound & Time-of-day condition matching ----------
def test_matches_time_of_day():
    import time

    from automation import _matches

    # Fix UTC reference: 2026-06-01 20:00:00 UTC (hour 20, min 0)
    # 2026-06-01 20:00:00 UTC timestamp = 1780344000
    # Let's create an exact UTC timestamp for 20:00:
    # time.gmtime(ts) -> tm_hour=20, tm_min=0
    ref_gm = (2026, 6, 1, 20, 0, 0, 0, 0, 0)
    import calendar
    ts_2000 = calendar.timegm(ref_gm)  # exactly 20:00 at tz_offset=0

    # Test >= 20:00 at 20:00
    rule = {
        "conditions": [{"type": "time_of_day", "operator": ">=", "value": "20:00"}]
    }
    assert _matches(rule, soc=None, now_ts=ts_2000, tz_offset=0) is True

    # Test < 20:00 at 20:00 -> False
    rule_lt = {
        "conditions": [{"type": "time_of_day", "operator": "<", "value": "20:00"}]
    }
    assert _matches(rule_lt, soc=None, now_ts=ts_2000, tz_offset=0) is False

    # Test = 20:00 at 20:00 -> True
    rule_eq = {
        "conditions": [{"type": "time_of_day", "operator": "=", "value": "20:00"}]
    }
    assert _matches(rule_eq, soc=None, now_ts=ts_2000, tz_offset=0) is True

    # Test at 20:01 (ts + 60)
    assert _matches(rule_eq, soc=None, now_ts=ts_2000 + 60, tz_offset=0) is False
    assert _matches(rule, soc=None, now_ts=ts_2000 + 60, tz_offset=0) is True

    # Test timezone offset: with tz_offset = -14400 (-4h, EDT):
    # local time is 16:00, so >= 20:00 is False
    assert _matches(rule, soc=None, now_ts=ts_2000, tz_offset=-14400) is False
    # But >= 16:00 is True
    rule_16 = {
        "conditions": [{"type": "time_of_day", "operator": ">=", "value": "16:00"}]
    }
    assert _matches(rule_16, soc=None, now_ts=ts_2000, tz_offset=-14400) is True


def test_matches_compound_and_conditions():
    import calendar

    from automation import _matches

    rule = {
        "conditions": [
            {"type": "time_of_day", "operator": ">=", "value": "20:00"},
            {"type": "time_of_day", "operator": "<", "value": "23:00"},
            {"type": "battery_percent", "operator": ">=", "value": 30},
        ]
    }

    # Helper to generate timestamp for given hour and minute (UTC, tz_offset=0)
    def make_ts(hour: int, minute: int) -> float:
        return float(calendar.timegm((2026, 6, 1, hour, minute, 0, 0, 0, 0)))

    # 1. 20:30 and SOC=50 -> All match -> True
    assert _matches(rule, soc=50, now_ts=make_ts(20, 30), tz_offset=0) is True

    # 2. 19:59 and SOC=50 -> Time < 20:00 fails -> False
    assert _matches(rule, soc=50, now_ts=make_ts(19, 59), tz_offset=0) is False

    # 3. 23:00 and SOC=50 -> Time < 23:00 fails (curr_min=1380 not < 1380) -> False
    assert _matches(rule, soc=50, now_ts=make_ts(23, 0), tz_offset=0) is False

    # 4. 20:30 and SOC=29 -> Battery >= 30 fails -> False
    assert _matches(rule, soc=29, now_ts=make_ts(20, 30), tz_offset=0) is False

    # 5. 20:30 and SOC=30 -> True (boundary)
    assert _matches(rule, soc=30, now_ts=make_ts(20, 30), tz_offset=0) is True


# ---------- Validation of compound rules ----------
def test_validate_compound_conditions(isolated_data):
    import automation
    importlib.reload(automation)

    clean = automation._validate({
        "name": "Evening load",
        "action": "on",
        "kasa_host": "192.168.1.100",
        "conditions": [
            {"type": "time_of_day", "operator": ">=", "value": "20h00"},
            {"type": "time_of_day", "operator": "<", "value": "23:00"},
            {"type": "battery_percent", "operator": ">=", "value": "30"},
        ],
    })

    assert len(clean["conditions"]) == 3
    assert clean["conditions"][0] == {"type": "time_of_day", "operator": ">=", "value": "20:00"}
    assert clean["conditions"][1] == {"type": "time_of_day", "operator": "<", "value": "23:00"}
    assert clean["conditions"][2] == {"type": "battery_percent", "operator": ">=", "value": 30.0}
    # Top-level mirrors the battery condition for backward compatibility
    assert clean["trigger"] == "battery_percent"
    assert clean["operator"] == ">="
    assert clean["value"] == 30.0


def test_validate_rejects_empty_conditions(isolated_data):
    import automation
    importlib.reload(automation)

    with pytest.raises(automation.AutomationError):
        automation._validate({
            "name": "Bad",
            "action": "on",
            "kasa_host": "1.2.3.4",
            "conditions": [],
        })


def test_validate_rejects_invalid_condition_type(isolated_data):
    import automation
    importlib.reload(automation)

    with pytest.raises(automation.AutomationError):
        automation._validate({
            "name": "Bad",
            "action": "on",
            "kasa_host": "1.2.3.4",
            "conditions": [
                {"type": "wind_speed", "operator": ">", "value": 10},
            ],
        })


# ---------- Edge-triggered evaluation of compound rules ----------
@pytest.mark.asyncio
async def test_evaluate_compound_rule_edge_trigger(engine_with_fake_kasa):
    import calendar
    eng, calls, _ = engine_with_fake_kasa

    eng.upsert({
        "name": "Evening heating",
        "action": "on",
        "kasa_host": "1.2.3.4",
        "jackery_device_sn": "DEV_1",
        "conditions": [
            {"type": "time_of_day", "operator": ">=", "value": "20:00"},
            {"type": "time_of_day", "operator": "<", "value": "23:00"},
            {"type": "battery_percent", "operator": ">=", "value": 30},
        ],
    })

    def make_ts(hour: int, minute: int, day: int = 1) -> float:
        return float(calendar.timegm((2026, 6, day, hour, minute, 0, 0, 0, 0)))

    # 1. At 19:59 with SOC 50 -> Condition False, no fire
    fired = await eng.evaluate({"DEV_1": 50}, active_sn="DEV_1", now_ts=make_ts(19, 59), tz_offset=0)
    assert fired == [] and calls == []

    # 2. At 20:00 with SOC 50 -> Transition False -> True -> FIRES ONCE!
    fired = await eng.evaluate({"DEV_1": 50}, active_sn="DEV_1", now_ts=make_ts(20, 0), tz_offset=0)
    assert len(fired) == 1
    assert calls == [("1.2.3.4", True)]

    # 3. At 20:15 with SOC 48 -> Still True -> No re-fire
    fired = await eng.evaluate({"DEV_1": 48}, active_sn="DEV_1", now_ts=make_ts(20, 15), tz_offset=0)
    assert fired == []
    assert len(calls) == 1

    # 4. At 21:00 battery drops to 25% -> Condition becomes False!
    fired = await eng.evaluate({"DEV_1": 25}, active_sn="DEV_1", now_ts=make_ts(21, 0), tz_offset=0)
    assert fired == []
    assert len(calls) == 1

    # 5. At 21:30 battery recharges back to 35% -> Condition becomes True -> FIRES AGAIN!
    fired = await eng.evaluate({"DEV_1": 35}, active_sn="DEV_1", now_ts=make_ts(21, 30), tz_offset=0)
    assert len(fired) == 1
    assert calls == [("1.2.3.4", True), ("1.2.3.4", True)]

    # 6. At 23:00 window ends -> Condition becomes False
    fired = await eng.evaluate({"DEV_1": 35}, active_sn="DEV_1", now_ts=make_ts(23, 0), tz_offset=0)
    assert fired == []

    # 7. Next day at 20:00 -> Transition False -> True -> FIRES AGAIN!
    fired = await eng.evaluate({"DEV_1": 40}, active_sn="DEV_1", now_ts=make_ts(20, 0, day=2), tz_offset=0)
    assert len(fired) == 1
    assert len(calls) == 3


@pytest.mark.asyncio
async def test_evaluate_pure_time_rule_without_battery(engine_with_fake_kasa):
    import calendar
    eng, calls, _ = engine_with_fake_kasa

    eng.upsert({
        "name": "Night shutdown",
        "action": "off",
        "kasa_host": "1.2.3.4",
        "conditions": [
            {"type": "time_of_day", "operator": ">=", "value": "23:00"},
        ],
    })

    def make_ts(hour: int, minute: int) -> float:
        return float(calendar.timegm((2026, 6, 1, hour, minute, 0, 0, 0, 0)))

    # Empty soc_by_sn — pure time rule should still evaluate!
    await eng.evaluate({}, now_ts=make_ts(22, 59), tz_offset=0)
    assert calls == []

    fired = await eng.evaluate({}, now_ts=make_ts(23, 0), tz_offset=0)
    assert len(fired) == 1
    assert calls == [("1.2.3.4", False)]

