"""Loads the precomputed dataset (buildings, stations, OSRM matrix, leg geometries) from data/."""

from __future__ import annotations

import copy
import gzip
import json
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

import numpy as np
import polyline

from app.travel import HaversineProvider, PrecomputedMatrixProvider, TravelTimeProvider

DATA_DIR = Path(__file__).resolve().parents[1] / "data"


@dataclass
class Dataset:
    """Everything the solver needs about the world. Node indices address rows of `seconds`.

    Buildings occupy nodes [0, n_buildings), stations follow. Buildings added at runtime (what-if
    insert) are appended after the stations with Haversine-estimated travel times.
    """

    buildings: list[dict]
    stations: list[dict]
    seconds: np.ndarray  # int32 walking seconds between nodes
    coords: np.ndarray  # (N, 2) lat, lng
    legs: dict[str, str]  # "i-j" (i<j) -> encoded polyline, OSRM foot geometry
    meta: dict
    node_of: dict[str, int] = field(default_factory=dict)  # building/station id -> node index
    estimated_nodes: set[int] = field(default_factory=set)  # nodes whose travel times are estimates

    def __post_init__(self) -> None:
        if not self.node_of:
            n = len(self.buildings)
            self.node_of = {b["id"]: i for i, b in enumerate(self.buildings)}
            self.node_of.update({s["id"]: n + i for i, s in enumerate(self.stations)})
        self.building_by_id = {b["id"]: b for b in self.buildings}
        self.station_by_id = {s["id"]: s for s in self.stations}
        self.haversine = HaversineProvider(
            detour_factor=self.meta.get("haversine_detour_factor", 1.3),
            speed_mps=self.meta.get("walk_speed_mps", 5 / 3.6),
        )

    # ---- travel -------------------------------------------------------------------------------
    @property
    def provider(self) -> PrecomputedMatrixProvider:
        return PrecomputedMatrixProvider(self.coords, self.seconds, fallback=self.haversine)

    def min_incoming_minutes(self) -> np.ndarray:
        """Per node, the shortest walk (minutes) arriving from any other node: a lower bound per visit."""
        if getattr(self, "_min_in", None) is None or len(self._min_in) != len(self.seconds):
            sec = self.seconds.astype(float)
            np.fill_diagonal(sec, np.inf)
            self._min_in = sec.min(axis=0) / 60.0
        return self._min_in

    def station_nodes(self) -> list[int]:
        return [self.node_of[s["id"]] for s in self.stations]

    def building_nodes(self, ids: list[str] | None = None) -> list[int]:
        ids = ids if ids is not None else [b["id"] for b in self.buildings]
        return [self.node_of[i] for i in ids]

    # ---- geometry -----------------------------------------------------------------------------
    def leg(self, a: int, b: int) -> tuple[list[tuple[float, float]], bool]:
        """Walking path between two nodes as [(lat, lng)], and whether it is the exact OSRM path."""
        if a == b:
            return [tuple(self.coords[a])], True
        enc = self.legs.get(f"{min(a, b)}-{max(a, b)}")
        start, end = tuple(self.coords[a]), tuple(self.coords[b])
        if enc is None:
            return [start, end], False
        pts = _decode(enc)
        if a > b:
            pts = pts[::-1]
        return [start, *pts, end], True

    def path(self, nodes: list[int]) -> tuple[str, bool]:
        """Encoded polyline (precision 5) through `nodes`, built from cached legs."""
        pts: list[tuple[float, float]] = []
        exact = True
        for a, b in zip(nodes, nodes[1:]):
            seg, ok = self.leg(a, b)
            exact &= ok
            pts.extend(seg if not pts else seg[1:])
        if not pts and nodes:
            pts = [tuple(self.coords[nodes[0]])]
        return polyline.encode(pts, 5), exact

    # ---- what-if ------------------------------------------------------------------------------
    def with_building(self, b: dict, provider: TravelTimeProvider | None = None) -> Dataset:
        """Copy of the dataset with one more building. Its travel times come from `provider`
        (Haversine estimate by default; Google Routes when configured), never from the OSRM matrix."""
        provider = provider or self.haversine
        n = len(self.coords)
        p = [(float(b["lat"]), float(b["lng"]))]
        others = [tuple(c) for c in self.coords]
        row = provider.matrix(p, others)[0]
        col = provider.matrix(others, p)[:, 0]
        fallback_row = self.haversine.matrix(p, others)[0]
        fallback_col = self.haversine.matrix(others, p)[:, 0]
        row = np.where(np.isfinite(row), row, fallback_row)
        col = np.where(np.isfinite(col), col, fallback_col)
        sec = np.zeros((n + 1, n + 1), dtype=self.seconds.dtype)
        sec[:n, :n] = self.seconds
        sec[n, :n] = np.rint(row)
        sec[:n, n] = np.rint(col)
        node_of = dict(self.node_of)
        node_of[b["id"]] = n
        return Dataset(
            buildings=[*self.buildings, b],
            stations=self.stations,
            seconds=sec,
            coords=np.vstack([self.coords, p]),
            legs=self.legs,
            meta=self.meta,
            node_of=node_of,
            estimated_nodes=self.estimated_nodes | {n},
        )

    def public_buildings(self) -> list[dict]:
        return [{k: v for k, v in b.items() if k != "osm_id"} for b in self.buildings]


@lru_cache(maxsize=200_000)
def _decode(enc: str) -> list[tuple[float, float]]:
    return [tuple(p) for p in polyline.decode(enc, 5)]


@lru_cache(maxsize=1)
def _load_base(data_dir: str) -> Dataset:
    d = Path(data_dir)
    buildings = json.loads((d / "buildings.json").read_text())
    stations = json.loads((d / "stations.json").read_text())
    nodes = json.loads((d / "nodes.json").read_text())
    seconds = np.load(d / "matrix.npy")
    legs_path = d / "legs.json.gz"
    legs = json.loads(gzip.open(legs_path, "rt", encoding="utf-8").read()) if legs_path.exists() else {}
    meta = json.loads((d / "meta.json").read_text())
    assert [n["id"] for n in nodes] == [b["id"] for b in buildings] + [s["id"] for s in stations], (
        "nodes.json out of sync"
    )
    coords = np.array([[n["lat"], n["lng"]] for n in nodes])
    return Dataset(buildings, stations, seconds, coords, legs, meta)


def load_dataset(data_dir: Path = DATA_DIR) -> Dataset:
    """A fresh (deep-copied building list) dataset; heavy arrays are shared and treated read-only."""
    base = _load_base(str(data_dir))
    return Dataset(
        buildings=copy.deepcopy(base.buildings),
        stations=base.stations,
        seconds=base.seconds,
        coords=base.coords,
        legs=base.legs,
        meta=base.meta,
    )
