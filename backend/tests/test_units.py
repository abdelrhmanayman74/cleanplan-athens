from urllib.parse import parse_qs, urlparse

import numpy as np

from app.domain import DAY_KEYS, PATTERNS, min_gap_ok, pattern_is_valid
from app.geocoder import AddressIndex, normalize
from app.routesheet import google_maps_urls
from app.solver.timeline import build_schedule


def test_patterns_are_valid_and_spaced():
    assert len(DAY_KEYS) == 10
    for f, pats in PATTERNS.items():
        for p in pats:
            assert pattern_is_valid(f, p) and min_gap_ok(p)
    assert len(PATTERNS["2w"]) == 6 and len(PATTERNS["biweekly"]) == 10
    assert not min_gap_ok(["A-Mon", "A-Tue"])


def test_normalize_matches_contract():
    assert normalize("Φορμίωνος") == "φορμιωνοσ"
    assert normalize("ΆΓΙΟΣ") == "αγιοσ"


def test_geocoder_accent_case_and_greeklish():
    idx = AddressIndex(
        [
            {
                "street": "Φορμίωνος",
                "number": "42",
                "postcode": "11633",
                "neighborhood": "Παγκράτι",
                "lat": 37.96,
                "lng": 23.75,
            },
            {
                "street": "Ευελπίδων",
                "number": "13",
                "postcode": None,
                "neighborhood": "Κυψέλη",
                "lat": 37.99,
                "lng": 23.73,
            },
        ]
    )
    for q in ["ΦΟΡΜΙΩΝΟΣ", "φορμιωνος", "Formionos"]:
        m = idx.lookup(q, "42")
        assert m.matched and m.confidence >= 0.95
    m = idx.lookup("Evelpidon", "11")
    assert m.matched and 0.5 <= m.confidence < 0.95 and "nearest number" in m.issue
    assert not idx.lookup("Nowhere Street", "1").matched


def test_google_maps_links_split_after_nine_waypoints():
    pts = [(37.9 + i / 1000, 23.7) for i in range(14)]  # origin + 12 stops + destination
    urls = google_maps_urls(pts)
    assert len(urls) == 2
    for u in urls:
        q = parse_qs(urlparse(u).query)
        assert q["travelmode"] == ["walking"] and q["api"] == ["1"]
        assert len(q.get("waypoints", [""])[0].split("|")) <= 9
    first, second = (parse_qs(urlparse(u).query) for u in urls)
    assert first["destination"] == second["origin"]


def test_break_never_pushes_a_window_stop_late():
    sec = np.full((4, 4), 300)
    np.fill_diagonal(sec, 0)
    s = build_schedule(
        [1, 2, 3], 0, ["a", "b", "c"], [120.0, 60.0, 60.0], [None, (420, 720), None], sec, 420.0, 900.0, 30.0
    )
    assert s.feasible
    b = s.stops[1]
    assert b.depart <= 720
    assert s.break_after >= 1
    assert s.end_time == 420 + 4 * 5 + 240 + 30


def test_import_accepts_greek_headers_and_frequency_labels():
    from app.importer import _column, parse_frequency

    assert [_column(h) for h in ["Οδός", "ΑΡΙΘΜΟΣ", "Τ.Κ.", "Συχνότητα", "όροφοι", "Ανελκυστήρας", "has_lift"]] == [
        "street", "number", "postcode", "frequency", "floors", "has_lift", "has_lift",
    ]  # fmt: skip
    cases = {"2w": "2w", "2 φορές/εβδ.": "2w", "1 φορά/εβδομάδα": "1w", "Κάθε 2 εβδομάδες": "biweekly", "daily": None}
    assert {k: parse_frequency(k) for k in cases} == cases
