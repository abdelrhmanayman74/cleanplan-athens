"""Step 2 of the data pipeline: sample ~1000 real addressed buildings and attach SYNTHETIC customer data.

Reads   data/raw/buildings_*.json, data/raw/stations.json   (from scripts/fetch_osm.py)
Writes  data/buildings.json      Building[] (contract type) minus `isolated` (added by build_matrix.py)
        data/stations.json       deduplicated metro / tram / rail stations near the sample
        data/address_index.json  every fetched address, for the offline /api/import geocoder

All randomness uses fixed seeds, so the output is reproducible from the raw Overpass files.
Usage:  uv run python scripts/build_dataset.py [--n 1000]
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.domain import MORNING_WINDOW  # noqa: E402
from app.travel import haversine_m  # noqa: E402

RAW = ROOT / "data" / "raw"
DATA = ROOT / "data"
SEED = 20251119

RESIDENTIAL = {"apartments", "residential", "yes"}
FREQ_MIX = {"1w": 0.55, "2w": 0.25, "biweekly": 0.15, "3w": 0.05}
MORNING_SHARE = 0.15
GRID_M = 70.0  # stratification cell size used to spread the sample out

FIRST_NAMES = [
    "Γιώργος",
    "Νίκος",
    "Κώστας",
    "Δημήτρης",
    "Γιάννης",
    "Παναγιώτης",
    "Βασίλης",
    "Χρήστος",
    "Αντώνης",
    "Μιχάλης",
    "Σταύρος",
    "Θανάσης",
    "Ελένη",
    "Μαρία",
    "Κατερίνα",
    "Σοφία",
    "Αγγελική",
    "Δέσποινα",
    "Βασιλική",
    "Ευαγγελία",
    "Γεωργία",
    "Χριστίνα",
    "Ιωάννα",
    "Αναστασία",
    "Δήμητρα",
    "Φωτεινή",
]
SURNAMES_M = [
    "Παπαδόπουλος",
    "Γεωργίου",
    "Νικολάου",
    "Οικονόμου",
    "Παπαγεωργίου",
    "Βασιλείου",
    "Καραγιάννης",
    "Ιωάννου",
    "Μακρής",
    "Αθανασίου",
    "Πετρόπουλος",
    "Δημητρίου",
    "Κωνσταντίνου",
    "Αλεξίου",
    "Σταματόπουλος",
    "Μιχαηλίδης",
    "Λαμπράκης",
    "Χατζηδάκης",
    "Ζαφειρίου",
    "Παππάς",
]
FEMALE_NAMES = {
    "Ελένη",
    "Μαρία",
    "Κατερίνα",
    "Σοφία",
    "Αγγελική",
    "Δέσποινα",
    "Βασιλική",
    "Ευαγγελία",
    "Γεωργία",
    "Χριστίνα",
    "Ιωάννα",
    "Αναστασία",
    "Δήμητρα",
    "Φωτεινή",
}
ACCESS_NOTES = [
    "Κλειδί στον θυρωρό",
    "Κωδικός εισόδου στο διαχειριστή",
    "Κλειδί στο κουτί κλειδιών δίπλα στην είσοδο",
    "Κουδούνι διαχειριστή, 2ος όροφος",
    "Η είσοδος ανοίγει 07:30 – κλειδί στο περίπτερο της γωνίας",
    "Κλειδί αποθήκης στον 1ο όροφο",
    "Παρκάρισμα καροτσιού στην πίσω είσοδο",
    "Πρόσβαση από την πυλωτή",
    "Τηλεφωνήστε στον διαχειριστή πριν από την άφιξη",
    "Ο κάδος ανακύκλωσης είναι στο υπόγειο",
]


def female_surname(s: str) -> str:
    if s.endswith("ος"):
        return s[:-2] + "ου"
    if s.endswith("ης"):
        return s[:-2] + "η"
    if s.endswith("ας"):
        return s[:-2] + "α"
    return s  # genitive-style surnames (Γεωργίου, Νικολάου …) are the same for women


def greek_person(rng: np.random.Generator) -> str:
    first = FIRST_NAMES[rng.integers(len(FIRST_NAMES))]
    last = SURNAMES_M[rng.integers(len(SURNAMES_M))]
    return f"{first} {female_surname(last) if first in FEMALE_NAMES else last}"


def fake_phone(rng: np.random.Generator) -> str:
    return "69" + "".join(str(d) for d in rng.integers(0, 10, size=8))


def load_raw_buildings() -> tuple[list[dict], dict[str, tuple[str, float, float]]]:
    """All addressed buildings, deduplicated by OSM id, labelled with the nearest neighbourhood centre."""
    by_id: dict[int, dict] = {}
    hoods: dict[str, tuple[str, float, float]] = {}
    for f in sorted(RAW.glob("buildings_*.json")):
        d = json.loads(f.read_text())
        meta = d["_meta"]
        hoods[meta["slug"]] = (meta["name"], *meta["center"])
        for el in d["elements"]:
            c = el.get("center")
            t = el.get("tags", {})
            if not c or "addr:street" not in t or "addr:housenumber" not in t:
                continue
            by_id[el["id"]] = {
                "osm_id": el["id"],
                "lat": round(c["lat"], 6),
                "lng": round(c["lon"], 6),
                "street": t["addr:street"].strip(),
                "number": t["addr:housenumber"].strip(),
                "postcode": (t.get("addr:postcode") or "").replace(" ", "") or None,
                "building": t.get("building"),
                "levels": t.get("building:levels"),
            }
    rows = list(by_id.values())
    centres = np.array([[v[1], v[2]] for v in hoods.values()])
    slugs = list(hoods.keys())
    dist = haversine_m(np.array([[r["lat"], r["lng"]] for r in rows]), centres)
    for r, k in zip(rows, dist.argmin(axis=1)):
        r["slug"] = slugs[k]
        r["neighborhood"] = hoods[slugs[k]][0]
    return rows, hoods


def spread_sample(rows: list[dict], n: int, rng: np.random.Generator) -> list[dict]:
    """Stratified sample: round-robin over ~70 m grid cells so the sample is spread, not clumped."""
    lat0 = np.mean([r["lat"] for r in rows])
    cells: dict[tuple[int, int], list[dict]] = defaultdict(list)
    for r in rows:
        y = r["lat"] * 111_320 / GRID_M
        x = r["lng"] * 111_320 * math.cos(math.radians(lat0)) / GRID_M
        cells[(int(y), int(x))].append(r)
    buckets = list(cells.values())
    for b in buckets:
        rng.shuffle(b)
    rng.shuffle(buckets)
    out: list[dict] = []
    while len(out) < n and any(buckets):
        for b in buckets:
            if b and len(out) < n:
                out.append(b.pop())
    return out


def synth_attributes(r: dict, rng: np.random.Generator) -> dict:
    lv = r.get("levels")
    try:
        floors = int(float(lv)) if lv else None
    except ValueError:
        floors = None
    if floors is None or not 2 <= floors <= 8:
        floors = int(rng.choice([2, 3, 4, 5, 6, 7, 8], p=[0.06, 0.12, 0.2, 0.24, 0.2, 0.12, 0.06]))
    p_lift = 0.25 if floors <= 3 else (0.6 if floors == 4 else 0.85)
    has_lift = bool(rng.random() < p_lift)
    service = 15 + 3.5 * floors + (0 if has_lift else 1.5 * floors) + rng.normal(0, 3)
    service = int(round(min(75, max(15, service))))
    freq = str(rng.choice(list(FREQ_MIX), p=list(FREQ_MIX.values())))
    window = list(MORNING_WINDOW) if rng.random() < MORNING_SHARE else None
    tasks = ["Σκάλες", "Είσοδος"]
    if has_lift:
        tasks.append("Ανελκυστήρας")
    if rng.random() < 0.6:
        tasks.append("Κάδοι")
    if rng.random() < 0.3:
        tasks.append("Τζάμια εισόδου")
    if rng.random() < 0.2:
        tasks.append("Πυλωτή")
    return {
        "floors": floors,
        "has_lift": has_lift,
        "service_minutes": service,
        "frequency": freq,
        "time_window": window,
        "manager": {"name": greek_person(rng), "phone": fake_phone(rng)},
        "access_note": ACCESS_NOTES[rng.integers(len(ACCESS_NOTES))],
        "tasks": tasks,
    }


def build_stations(sample_xy: np.ndarray, max_dist_m: float = 2500) -> list[dict]:
    d = json.loads((RAW / "stations.json").read_text())
    best: dict[str, dict] = {}
    for el in d["elements"]:
        t = el.get("tags", {})
        name = t.get("name:el") or t.get("name")
        if not name:
            continue
        if t.get("railway") == "tram_stop" or t.get("station") == "light_rail" or t.get("tram") == "yes":
            kind = "tram"
        elif t.get("station") == "subway" or t.get("subway") == "yes":
            kind = "metro"
        else:
            kind = "rail"
        key = f"{kind}:{name}"
        if key not in best:  # one node per (kind, name); metro stations have several entrance/platform nodes
            best[key] = {"name": name, "kind": kind, "lat": round(el["lat"], 6), "lng": round(el["lon"], 6)}
    stations = sorted(best.values(), key=lambda s: (s["kind"], s["name"]))
    xy = np.array([[s["lat"], s["lng"]] for s in stations])
    near = haversine_m(xy, sample_xy).min(axis=1) <= max_dist_m
    stations = [s for s, ok in zip(stations, near) if ok]
    for i, s in enumerate(stations):
        s["id"] = f"s{i:03d}"
    return stations


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=1000)
    args = ap.parse_args()
    rng = np.random.default_rng(SEED)

    rows, hoods = load_raw_buildings()
    # Address index: every distinct fetched address (also non-residential), for the importer.
    seen = set()
    index = []
    for r in sorted(rows, key=lambda r: r["osm_id"]):
        key = (r["street"], r["number"])
        if key in seen:
            continue
        seen.add(key)
        index.append({k: r[k] for k in ("street", "number", "postcode", "neighborhood", "lat", "lng")})
    (DATA / "address_index.json").write_text(json.dumps(index, ensure_ascii=False))

    # Candidate pool: residential-type buildings, one per address.
    pool_by_hood: dict[str, list[dict]] = defaultdict(list)
    seen = set()
    for r in sorted(rows, key=lambda r: r["osm_id"]):
        key = (r["street"], r["number"])
        if r["building"] not in RESIDENTIAL or key in seen:
            continue
        seen.add(key)
        pool_by_hood[r["slug"]].append(r)

    # Equal quota per neighbourhood, redistributing what small neighbourhoods cannot fill.
    slugs = sorted(pool_by_hood)
    quota = {s: 0 for s in slugs}
    remaining = args.n
    open_slugs = list(slugs)
    while remaining > 0 and open_slugs:
        share = max(1, remaining // len(open_slugs))
        for s in list(open_slugs):
            take = min(share, len(pool_by_hood[s]) - quota[s], remaining)
            quota[s] += take
            remaining -= take
            if quota[s] >= len(pool_by_hood[s]):
                open_slugs.remove(s)
            if remaining == 0:
                break

    sample: list[dict] = []
    for s in slugs:
        sample += spread_sample(pool_by_hood[s], quota[s], rng)
    sample.sort(key=lambda r: (r["neighborhood"], r["street"], r["number"]))

    buildings = []
    for i, r in enumerate(sample):
        b = {
            "id": f"b{i + 1:04d}",
            "name": f"Πολυκατοικία {r['street']} {r['number']}",
            "street": r["street"],
            "number": r["number"],
            "postcode": r["postcode"],
            "neighborhood": r["neighborhood"],
            "lat": r["lat"],
            "lng": r["lng"],
            "osm_id": r["osm_id"],
        }
        b.update(synth_attributes(r, rng))
        buildings.append(b)
    (DATA / "buildings.json").write_text(json.dumps(buildings, ensure_ascii=False, indent=0))

    stations = build_stations(np.array([[b["lat"], b["lng"]] for b in buildings]))
    (DATA / "stations.json").write_text(json.dumps(stations, ensure_ascii=False, indent=0))

    from collections import Counter

    print(f"{len(buildings)} buildings, {len(stations)} stations, {len(index)} indexed addresses")
    print("per neighbourhood:", dict(Counter(b["neighborhood"] for b in buildings)))
    print("frequency mix:", dict(Counter(b["frequency"] for b in buildings)))
    print("stations by kind:", dict(Counter(s["kind"] for s in stations)))


if __name__ == "__main__":
    main()
