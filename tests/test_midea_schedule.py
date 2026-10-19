import pytest
from unittest.mock import AsyncMock, MagicMock
from zoneinfo import ZoneInfo
from datetime import datetime

import midea_schedule


def test_midea_schedule_get_and_set(tmp_path, monkeypatch):
    sched_file = str(tmp_path / "midea-schedules.json")
    monkeypatch.setattr(midea_schedule, "SCHEDULES_FILE", sched_file)

    # 1. Initially default schedule
    dev_id = "150633095041182"
    s = midea_schedule.get_schedule(dev_id)
    assert s["device_id"] == dev_id
    assert s["timezone"] == "America/Toronto"
    assert s["schedule_enabled"] is False
    assert s["events"] == []

    # 2. Save new schedule with valid timezone
    new_sched = {
        "timezone": "America/New_York",
        "schedule_enabled": True,
        "events": [
            {
                "id": "e1",
                "name": "Morning Start",
                "enabled": True,
                "days": [1, 2, 3, 4, 5],
                "time": "07:30",
                "power": True,
                "target_humidity": 45,
                "fan_speed": 80,
                "mode": 1,
            },
            {
                "id": "e2",
                "name": "Night Stop",
                "enabled": True,
                "days": [1, 2, 3, 4, 5, 6, 7],
                "time": "22:00",
                "power": False,
            },
        ],
    }
    saved = midea_schedule.set_schedule(dev_id, new_sched)
    assert saved["timezone"] == "America/New_York"
    assert saved["schedule_enabled"] is True
    assert len(saved["events"]) == 2
    assert saved["events"][0]["time"] == "07:30"
    assert saved["events"][0]["power"] is True
    assert saved["events"][0]["fan_speed"] == 80
    assert saved["events"][1]["power"] is False

    # 3. Reload from disk
    loaded = midea_schedule.get_schedule(dev_id)
    assert loaded["timezone"] == "America/New_York"
    assert len(loaded["events"]) == 2

    # 4. Verify lookup works when querying with 'midea_' prefix
    prefixed_loaded = midea_schedule.get_schedule(f"midea_{dev_id}")
    assert prefixed_loaded["device_id"] == dev_id
    assert prefixed_loaded["timezone"] == "America/New_York"
    assert len(prefixed_loaded["events"]) == 2

    # 5. Invalid timezone should raise ValueError
    with pytest.raises(ValueError):
        midea_schedule.set_schedule(dev_id, {"timezone": "Invalid/Fake_Zone"})


@pytest.mark.asyncio
async def test_midea_schedule_execution(tmp_path, monkeypatch):
    sched_file = str(tmp_path / "midea-schedules.json")
    monkeypatch.setattr(midea_schedule, "SCHEDULES_FILE", sched_file)
    midea_schedule._executed_events.clear()

    dev_id = "150633095041182"
    # Set schedule for America/Toronto
    midea_schedule.set_schedule(
        dev_id,
        {
            "timezone": "America/Toronto",
            "schedule_enabled": True,
            "events": [
                {
                    "id": "e_active",
                    "name": "Turn On",
                    "enabled": True,
                    "days": [1, 2, 3, 4, 5, 6, 7],
                    "time": "14:15",
                    "power": True,
                    "target_humidity": 40,
                    "fan_speed": 80,
                    "mode": 1,
                }
            ],
        },
    )

    mock_client = MagicMock()
    mock_client.control_device = AsyncMock(return_value={"status": "ok"})

    # Case A: Current simulated time does NOT match (e.g. 14:14)
    fake_time_no_match = datetime(2026, 10, 13, 14, 14, 0, tzinfo=ZoneInfo("America/Toronto"))
    with monkeypatch.context() as m:
        m.setattr(midea_schedule, "datetime", MagicMock(now=MagicMock(return_value=fake_time_no_match)))
        executed = await midea_schedule.check_and_execute_schedules(mock_client)
        assert len(executed) == 0
        mock_client.control_device.assert_not_called()

    # Case B: Current simulated time MATCHES (14:15 on Tuesday, day 2)
    fake_time_match = datetime(2026, 10, 13, 14, 15, 0, tzinfo=ZoneInfo("America/Toronto"))
    with monkeypatch.context() as m:
        m.setattr(midea_schedule, "datetime", MagicMock(now=MagicMock(return_value=fake_time_match)))
        executed = await midea_schedule.check_and_execute_schedules(mock_client)
        assert len(executed) == 1
        assert executed[0]["device_id"] == dev_id
        assert executed[0]["event_id"] == "e_active"
        mock_client.control_device.assert_called_once_with(
            dev_id, running=True, target_humidity=40, fan_speed=80, mode=1
        )

    # Case C: Same minute again (edge trigger) -> should not fire again
    with monkeypatch.context() as m:
        m.setattr(midea_schedule, "datetime", MagicMock(now=MagicMock(return_value=fake_time_match)))
        executed2 = await midea_schedule.check_and_execute_schedules(mock_client)
        assert len(executed2) == 0
        # Call count remains 1
        assert mock_client.control_device.call_count == 1
