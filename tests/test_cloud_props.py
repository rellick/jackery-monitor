"""Unit tests for cloud_props_to_telemetry and model capability filtering."""

from __future__ import annotations

from cloud_client import cloud_props_to_telemetry


def test_model_4_explorer_300_plus_pruning():
    raw = {
        "rb": 85,
        "bt": 290,
        "op": 12,
        "lps": 1,
        "cs": 0,    # dummy sent by Jackery cloud
        "sfc": 0,   # dummy sent by Jackery cloud
        "ups": 1,   # dummy sent by Jackery cloud
        "pm": 0,
        "slt": 1,
        "ast": 0,
        "lm": 0,
    }
    tele = cloud_props_to_telemetry(raw, model_code=4)
    assert tele["battery_percent"] == 85
    assert tele["battery_saving"] is True
    assert tele["charge_speed"] is None
    assert tele["super_charge"] is None
    assert tele["ups_on"] is None
    assert tele["super_charge_on"] is None

    settings = tele["settings"]
    assert "battery_saving" in settings
    assert "charge_speed" not in settings
    assert "super_charge" not in settings
    assert "ups_mode" not in settings


def test_model_5_explorer_1000_plus_pruning():
    raw = {
        "rb": 50,
        "bt": 280,
        "op": 100,
        "lps": 0,
        "cs": 1,
        "sfc": 0,   # dummy sent by Jackery cloud if any
        "ups": 1,
        "pm": 0,
    }
    tele = cloud_props_to_telemetry(raw, model_code=5)
    assert tele["battery_saving"] is False
    assert tele["charge_speed"] == 1
    assert tele["super_charge"] is None
    assert tele["ups_on"] is True
    assert tele["super_charge_on"] is None

    settings = tele["settings"]
    assert settings["charge_speed"] == 1
    assert "super_charge" not in settings


def test_model_12_explorer_2000_v2_features_retained():
    raw = {
        "rb": 90,
        "bt": 250,
        "op": 0,
        "lps": 1,
        "cs": 1,
        "sfc": 0,
        "ups": 1,
        "pm": 0,
    }
    tele = cloud_props_to_telemetry(raw, model_code=12)
    assert tele["battery_saving"] is True
    assert tele["charge_speed"] == 1
    assert tele["super_charge"] is False
    assert tele["ups_on"] is True
    assert tele["super_charge_on"] is False

    settings = tele["settings"]
    assert settings["charge_speed"] == 1
    assert settings["super_charge"] is False
