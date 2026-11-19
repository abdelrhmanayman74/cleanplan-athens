"""Exports everything the static (GitHub Pages) build of the demo needs into frontend/public/static-data/.

The static site has no server: it replays results computed here by the real optimiser, with the same
functions the API uses, so its numbers match the server version exactly. Only what depends on user
input (a new building, an imported file) is computed in the browser.

Writes (all JSON minified):
  meta.json                 /api/meta, plus the shifts and targets that have precomputed plans
  buildings.json            /api/buildings
  nodes.json                [lat, lng] per matrix node (buildings, then stations)
  matrix.u16                OSRM walking seconds, uint16 little-endian, nodes x nodes (for new-building insertion)
  plans/<minutes>.json      {plan, baseline, cost} for every shift length the re-plan slider offers (target 85 %)
  workforce.json            /api/workforce/estimate for every slider combination, keyed "<minutes>|<target>"
  absences/<day_key>.json   every single-day absence on the default plan, as a diff to apply to it
  address_index.json        offline geocoder index (loaded only for import and pin labels)
  import_template.xlsx      /api/import/sample

Usage:  uv run python scripts/export_static.py [--out ../frontend/public/static-data]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.data import DATA_DIR, load_dataset  # noqa: E402
from app.domain import DAY_KEYS, FREQUENCIES, PATTERNS  # noqa: E402
from app.importer import sample_workbook  # noqa: E402
from app.main import DATA_NOTE  # noqa: E402
from app.solver.baseline import solve_baseline  # noqa: E402
from app.solver.estimates import cost_estimate, workforce_estimate  # noqa: E402
from app.solver.optimizer import solve_plan  # noqa: E402
from app.solver.plan import Params  # noqa: E402
from app.solver.routing import shutdown_pool  # noqa: E402
from app.solver.whatif import apply_absence  # noqa: E402
from app.state import PlanStore  # noqa: E402

# the workforce panel's sliders (frontend/src/components/KpiPanel.tsx)
SHIFT_MINUTES = list(range(240, 541, 30))  # 4-9 h in half-hour steps
TARGETS = [round(0.60 + i / 100, 2) for i in range(36)]  # 60-95 % in 1 % steps
REPLAN_TARGET = 0.85


def dump(path: Path, obj) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text, encoding="utf-8")
    return len(text.encode())


def strip(d: dict) -> dict:
    return {k: v for k, v in d.items() if k != "dataset_fingerprint"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=ROOT.parent / "frontend" / "public" / "static-data")
    ap.add_argument("--skip-plans", action="store_true", help="reuse plans/ from a previous run")
    args = ap.parse_args()
    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    log = lambda *a: print(*a, flush=True)  # noqa: E731

    store = PlanStore(DATA_DIR, log=lambda *_: None)
    ds = store.base_ds
    default = strip(store.default_plan)
    params = store.default_state.params

    meta = {
        "day_keys": DAY_KEYS,
        "frequencies": FREQUENCIES,
        "patterns": PATTERNS,
        "neighborhoods": sorted({b["neighborhood"] for b in ds.buildings}),
        "data_note": DATA_NOTE,
        "travel_provider": ds.provider.name + "; new addresses: haversine (estimate, computed in the browser)",
        "stations": [{k: st[k] for k in ("id", "name", "kind", "lat", "lng")} for st in ds.stations],
        "dataset": {
            k: ds.meta.get(k)
            for k in ("buildings", "stations", "haversine_detour_factor", "osm_extract", "osrm_profile", "built_at")
        },
        "provider_compare": False,
        "demo_absence": default.get("demo_absence"),
        # static build only
        "static": {
            "replan_minutes": SHIFT_MINUTES,
            "replan_target": REPLAN_TARGET,
            "default_minutes": params.daily_minutes,
            "walk_speed_mps": ds.haversine.speed_mps,
            "detour_factor": ds.haversine.detour_factor,
            "break_minutes": params.break_minutes,
        },
    }
    sizes = {"meta.json": dump(out / "meta.json", meta)}
    sizes["buildings.json"] = dump(out / "buildings.json", ds.public_buildings())
    sizes["nodes.json"] = dump(out / "nodes.json", [[round(a, 6), round(b, 6)] for a, b in ds.coords.tolist()])
    assert ds.seconds.max() < 65535
    (out / "matrix.u16").write_bytes(ds.seconds.astype("<u2").tobytes())
    sizes["matrix.u16"] = (out / "matrix.u16").stat().st_size
    sizes["address_index.json"] = dump(out / "address_index.json", store.address_index.rows)
    (out / "import_template.xlsx").write_bytes(sample_workbook(ds.buildings, store.address_index))

    # workforce estimates for every slider position
    wf = {
        f"{m}|{t:.2f}": workforce_estimate(ds, m, t, params.break_minutes, solved=None)
        for m in SHIFT_MINUTES
        for t in TARGETS
    }
    sizes["workforce.json"] = dump(out / "workforce.json", wf)

    # one full plan per re-plan shift length, with its baseline and API cost
    for m in SHIFT_MINUTES:
        path = out / "plans" / f"{m}.json"
        if args.skip_plans and path.exists():
            continue
        p = Params(daily_minutes=m, target_utilization=REPLAN_TARGET)
        if p == params:
            plan = default
        else:
            t0 = time.perf_counter()
            plan = solve_plan(load_dataset(), p, log=lambda *_: None)
            log(f"  {m} min: {plan['kpis']['cleaners']} cleaners in {time.perf_counter() - t0:.1f}s")
        base = solve_baseline(load_dataset(), p, plan["kpis"]["cleaners"], plan["kpis"]["lower_bound_cleaners"])
        sizes[f"plans/{m}.json"] = dump(path, {"plan": plan, "baseline": base, "cost": cost_estimate(ds, plan)})
    shutdown_pool()

    # every single-day absence on the default plan, as a diff: the routes that changed and the rest
    # of the ChangeResult; the client swaps those routes into the default plan
    per_day: dict[str, dict] = {d: {} for d in DAY_KEYS}
    for r in default["routes"]:
        if not r["stops"]:
            continue
        res = apply_absence(ds, default, params, r["cleaner_id"], r["day_key"])
        after = res["plan"]
        before_routes = {(x["cleaner_id"], x["day_key"]): x for x in default["routes"]}
        changed = [x for x in after["routes"] if x != before_routes[(x["cleaner_id"], x["day_key"])]]
        per_day[r["day_key"]][r["cleaner_id"]] = {
            "id": after["id"],
            "routes": changed,
            "unassigned": after["unassigned"][len(default["unassigned"]) :],
            "changes": res["changes"],
            "churn": res["churn"],
            "untouched_routes": res["untouched_routes"],
            "kpis_after": res["kpis_after"],
            "message": res["message"],
        }
    for d, cases in per_day.items():
        sizes[f"absences/{d}.json"] = dump(out / "absences" / f"{d}.json", cases)

    total = sum(f.stat().st_size for f in out.rglob("*") if f.is_file())
    biggest = max((f.stat().st_size, f.relative_to(out)) for f in out.rglob("*") if f.is_file())
    log(f"wrote {out}: {total / 1e6:.1f} MB in total, largest {biggest[1]} ({biggest[0] / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
