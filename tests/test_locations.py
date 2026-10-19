import os
import tempfile
import pytest

import locations


@pytest.fixture(autouse=True)
def temp_locations(monkeypatch):
    with tempfile.TemporaryDirectory() as td:
        lp = os.path.join(td, "locations.json")
        monkeypatch.setattr(locations, "LOCATIONS_PATH", lp)
        yield


def test_locations_defaults_and_get():
    locs = locations.list_locations()
    assert len(locs) >= 2
    ids = [l["id"] for l in locs]
    assert "maison" in ids
    assert "chalet" in ids

    maison = locations.get_location("maison")
    assert maison is not None
    assert maison["name"] == "Maison"
    assert maison["plan_id"] == "hq-tarif-d-tdt"

    chalet = locations.get_location("CHALET")  # case-insensitive
    assert chalet is not None
    assert chalet["plan_id"] == "hq-tarif-flex-d"


def test_locations_upsert_and_save():
    new_loc = {
        "id": "studio",
        "name": "Studio",
        "neviweb_name": "Studio",
        "plan_id": "flat-default",
        "is_default": False,
        "assigned_jackerys": [],
    }
    locations.upsert_location(new_loc)
    assert locations.get_location("studio") is not None

    # Update
    new_loc["name"] = "Studio Paris"
    locations.upsert_location(new_loc)
    assert locations.get_location("studio")["name"] == "Studio Paris"


def test_assign_jackery_to_location():
    sn = "J1000P12345"
    assert locations.assign_jackery_to_location(sn, "maison") is True
    assert locations.location_for_jackery(sn)["id"] == "maison"

    # Re-assign to chalet
    assert locations.assign_jackery_to_location(sn, "chalet") is True
    assert locations.location_for_jackery(sn)["id"] == "chalet"
    assert sn not in (locations.get_location("maison").get("assigned_jackerys") or [])


def test_plan_for_location():
    plan_maison = locations.plan_for_location("maison")
    assert plan_maison.get("currency") == "CAD"
    assert plan_maison.get("type") == "tou"

    plan_chalet = locations.plan_for_location("chalet")
    assert plan_chalet.get("currency") == "CAD"
    assert any(s.get("rate") == 0.55832 for s in plan_chalet.get("tou_rates", []))
