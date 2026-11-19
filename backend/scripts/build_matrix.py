"""Step 3 of the data pipeline: precompute OSRM foot travel times and leg geometries.

Needs a running osrm-routed (scripts/build_osrm.sh serve). After this step the API never needs OSRM.

Reads   data/buildings.json, data/stations.json
Writes  data/nodes.json         node order of the matrix: buildings first, then stations
        data/matrix.npy         int32 walking seconds, shape (N, N)
        data/legs.json.gz       {"i-j": encoded polyline} for i<j (geometry is direction independent on foot)
        data/meta.json          calibration of the Haversine fallback + dataset stats
        data/buildings.json     updated in place with `isolated`

Usage:  uv run python scripts/build_matrix.py [--osrm http://localhost:5000] [--k 40] [--station-k 80]
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.travel import DEFAULT_WALK_SPEED_MPS, OSRMProvider, haversine_m  # noqa: E402

DATA = ROOT / "data"
ISOLATION_SECONDS = 15 * 60


def leg_key(i: int, j: int) -> str:
    return f"{min(i, j)}-{max(i, j)}"


def fetch_legs(
    osrm: OSRMProvider, coords: np.ndarray, pairs: list[tuple[int, int]], workers: int = 4
) -> dict[str, str]:
    def one(p: tuple[int, int]) -> tuple[str, str]:
        i, j = p
        _, geom = osrm.route(tuple(coords[i]), tuple(coords[j]))
        return leg_key(i, j), geom

    out: dict[str, str] = {}
    with ThreadPoolExecutor(workers) as ex:
        for k, g in ex.map(one, pairs):
            out[k] = g
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--osrm", default="http://localhost:5000")
    ap.add_argument("--k", type=int, default=40, help="nearest building neighbours with cached geometry")
    ap.add_argument("--station-k", type=int, default=80, help="nearest buildings per station with cached geometry")
    args = ap.parse_args()

    buildings = json.loads((DATA / "buildings.json").read_text())
    stations = json.loads((DATA / "stations.json").read_text())
    nodes = [{"id": b["id"], "kind": "building", "lat": b["lat"], "lng": b["lng"]} for b in buildings]
    nodes += [{"id": s["id"], "kind": "station", "lat": s["lat"], "lng": s["lng"]} for s in stations]
    coords = np.array([[n["lat"], n["lng"]] for n in nodes])
    nb = len(buildings)
    osrm = OSRMProvider(args.osrm)

    t0 = time.time()
    sec = osrm.matrix([tuple(c) for c in coords], [tuple(c) for c in coords])
    print(f"matrix {sec.shape} in {time.time() - t0:.1f}s, unreachable pairs: {int(np.isnan(sec).sum())}")

    hav = haversine_m(coords, coords)
    mask = (hav > 150) & ~np.isnan(sec)
    sec_per_m = float(np.median(sec[mask] / hav[mask]))
    detour = sec_per_m * DEFAULT_WALK_SPEED_MPS
    # Unreachable pairs (should be none) fall back to the calibrated straight-line estimate.
    sec = np.where(np.isnan(sec), hav * sec_per_m, sec)
    np.fill_diagonal(sec, 0)
    mat = np.rint(sec).astype(np.int32)
    np.save(DATA / "matrix.npy", mat)
    (DATA / "nodes.json").write_text(json.dumps(nodes, ensure_ascii=False))

    # isolated: walk to the 3rd-nearest neighbouring building is more than 15 minutes
    bb = mat[:nb, :nb].astype(float)
    np.fill_diagonal(bb, np.inf)
    third = np.sort(bb, axis=1)[:, 2]
    for b, t in zip(buildings, third):
        b["isolated"] = bool(t > ISOLATION_SECONDS)
    (DATA / "buildings.json").write_text(json.dumps(buildings, ensure_ascii=False, indent=0))

    # leg geometries: k nearest building neighbours + station -> nearest buildings
    pairs: set[tuple[int, int]] = set()
    order = np.argsort(bb, axis=1)
    for i in range(nb):
        for j in order[i, : args.k]:
            pairs.add((min(i, int(j)), max(i, int(j))))
    for s in range(nb, len(nodes)):
        for j in np.argsort(mat[s, :nb])[: args.station_k]:
            pairs.add((int(j), s))
    t0 = time.time()
    legs = fetch_legs(osrm, coords, sorted(pairs))
    with gzip.open(DATA / "legs.json.gz", "wt", encoding="utf-8") as f:
        json.dump(legs, f)
    print(f"{len(legs)} leg geometries in {time.time() - t0:.1f}s")

    meta = {
        "nodes": len(nodes),
        "buildings": nb,
        "stations": len(stations),
        "haversine_sec_per_m": sec_per_m,
        "haversine_detour_factor": detour,
        "walk_speed_mps": DEFAULT_WALK_SPEED_MPS,
        "isolated_buildings": int(sum(b["isolated"] for b in buildings)),
        "osrm_profile": "foot (osrm-backend v5.27.1, /opt/foot.lua)",
        "osm_extract": "Geofabrik greece-latest.osm.pbf, clipped to Athens bbox",
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (DATA / "meta.json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
