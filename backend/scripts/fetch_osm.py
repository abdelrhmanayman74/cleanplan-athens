"""Step 1 of the data pipeline: fetch real addressed buildings and rail stations from Overpass.

Outputs (raw, cached so the pipeline is reproducible offline once fetched):
    data/raw/buildings_<slug>.json   one Overpass response per neighbourhood
    data/raw/stations.json           metro / tram / rail stations in the Athens bbox

Usage:  uv run python scripts/fetch_osm.py [--force]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"

USER_AGENT = "cleanplan-demo/0.1 (route-planning demo; synthetic data)"
MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

# Neighbourhood centres (approximate) and fetch radius in metres.
NEIGHBORHOODS = [
    ("pagkrati", "Παγκράτι", 37.9676, 23.7465, 750),
    ("kypseli", "Κυψέλη", 38.0000, 23.7405, 700),
    ("ampelokipoi", "Αμπελόκηποι", 37.9875, 23.7605, 650),
    ("kolonaki", "Κολωνάκι", 37.9785, 23.7425, 550),
    ("zografou", "Ζωγράφου", 37.9745, 23.7700, 750),
    ("kallithea", "Καλλιθέα", 37.9555, 23.7020, 800),
    ("neos_kosmos", "Νέος Κόσμος", 37.9575, 23.7290, 650),
    ("gkyzi", "Γκύζη", 37.9935, 23.7505, 500),
]

ATHENS_BBOX = (37.88, 23.62, 38.08, 23.86)  # south, west, north, east


def overpass(query: str, retries_per_mirror: int = 2) -> dict:
    last_err: Exception | None = None
    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=httpx.Timeout(100, connect=15)) as client:
        for mirror in MIRRORS:
            for attempt in range(retries_per_mirror):
                try:
                    r = client.post(mirror, data={"data": query})
                    if r.status_code == 200:
                        return r.json()
                    last_err = RuntimeError(f"{mirror} -> HTTP {r.status_code}")
                except (httpx.HTTPError, json.JSONDecodeError) as e:  # network or bad payload
                    last_err = e
                print(f"  overpass retry ({mirror}, attempt {attempt + 1}): {last_err}", file=sys.stderr)
                time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"all Overpass mirrors failed: {last_err}")


def buildings_query(lat: float, lng: float, radius: int) -> str:
    return f"""
[out:json][timeout:120];
(
  way["building"]["addr:street"]["addr:housenumber"](around:{radius},{lat},{lng});
);
out center tags;
"""


def stations_query() -> str:
    s, w, n, e = ATHENS_BBOX
    bbox = f"{s},{w},{n},{e}"
    return f"""
[out:json][timeout:120];
(
  node["railway"="station"]({bbox});
  node["railway"="halt"]({bbox});
  node["railway"="tram_stop"]({bbox});
  node["public_transport"="station"]["station"~"subway|light_rail|train"]({bbox});
);
out body;
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="re-download even if cached")
    args = ap.parse_args()
    RAW.mkdir(parents=True, exist_ok=True)

    for slug, name, lat, lng, radius in NEIGHBORHOODS:
        out = RAW / f"buildings_{slug}.json"
        if out.exists() and not args.force:
            print(f"cached {out.name}")
            continue
        print(f"fetching buildings in {name} …")
        data = overpass(buildings_query(lat, lng, radius))
        data["_meta"] = {"slug": slug, "name": name, "center": [lat, lng], "radius_m": radius}
        out.write_text(json.dumps(data, ensure_ascii=False))
        print(f"  {len(data.get('elements', []))} elements")
        time.sleep(2)  # be polite

    out = RAW / "stations.json"
    if not out.exists() or args.force:
        print("fetching stations …")
        data = overpass(stations_query())
        out.write_text(json.dumps(data, ensure_ascii=False))
        print(f"  {len(data.get('elements', []))} elements")


if __name__ == "__main__":
    main()
