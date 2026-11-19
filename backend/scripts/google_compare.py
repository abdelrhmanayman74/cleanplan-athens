"""Compare precomputed OSRM foot times with Google Routes (WALK) on ≤ 200 pairs inside one territory.

Runs only if GOOGLE_MAPS_API_KEY is set (cost: one element per pair, well inside the free tier).
Writes data/google_compare.json, which the API serves at /api/provider-compare.

Usage:  GOOGLE_MAPS_API_KEY=... uv run python scripts/google_compare.py [--cleaner c05] [--pairs 200]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.data import DATA_DIR, load_dataset  # noqa: E402
from app.travel import GoogleRoutesProvider  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cleaner", default=None, help="territory to sample (default: the largest)")
    ap.add_argument("--pairs", type=int, default=200)
    args = ap.parse_args()
    if not os.environ.get("GOOGLE_MAPS_API_KEY"):
        print("GOOGLE_MAPS_API_KEY not set: nothing to do.")
        return

    ds = load_dataset()
    plan = json.loads((DATA_DIR / "default_plan.json").read_text())
    members: dict[str, list[str]] = {}
    for a in plan["assignments"]:
        members.setdefault(a["cleaner_id"], []).append(a["building_id"])
    cid = args.cleaner or max(members, key=lambda c: len(members[c]))
    ids = members[cid]
    rng = np.random.default_rng(0)
    # one request with n origins x n destinations; keep n*(n-1) <= pairs
    n = int(min(len(ids), np.floor((1 + np.sqrt(1 + 4 * args.pairs)) / 2)))
    sample = sorted(rng.choice(ids, size=n, replace=False).tolist())
    pts = [(ds.building_by_id[b]["lat"], ds.building_by_id[b]["lng"]) for b in sample]

    google = GoogleRoutesProvider().matrix(pts, pts)
    osrm = ds.provider.sub_matrix(ds.building_nodes(sample), ds.building_nodes(sample))
    pairs = []
    for i in range(n):
        for j in range(n):
            if i != j and np.isfinite(google[i, j]):
                pairs.append(
                    {
                        "from": sample[i],
                        "to": sample[j],
                        "osrm_min": round(osrm[i, j] / 60, 2),
                        "google_min": round(google[i, j] / 60, 2),
                    }
                )
    diff = [abs(p["osrm_min"] - p["google_min"]) for p in pairs]
    out = {
        "pairs": pairs,
        "mean_abs_diff_min": round(float(np.mean(diff)), 2) if diff else None,
        "note": f"{len(pairs)} walking pairs inside territory {cid}: OSRM foot (precomputed) vs Google Routes WALK.",
    }
    (DATA_DIR / "google_compare.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
    print(out["note"], "mean |diff| =", out["mean_abs_diff_min"], "min")


if __name__ == "__main__":
    main()
