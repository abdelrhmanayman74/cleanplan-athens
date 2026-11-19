"""Walking travel-time providers.

Every optimiser component asks a `TravelTimeProvider` for walking durations (seconds). The demo uses
four interchangeable implementations:

* `PrecomputedMatrixProvider` – runtime default. Reads the OSRM foot matrix computed offline
  (`data/matrix.npy`), so the API never needs a routing server.
* `OSRMProvider` – used by the offline scripts to build that matrix and the leg geometries.
* `HaversineProvider` – great-circle distance x detour factor (calibrated against OSRM). Used for
  points that are not in the matrix, e.g. a new building in the what-if "insert" flow. Estimates only.
* `GoogleRoutesProvider` – Google Routes API "Compute Route Matrix" (travelMode WALK). Only used if
  `GOOGLE_MAPS_API_KEY` is set; never called otherwise.
"""

from __future__ import annotations

import math
import os
import time
from collections.abc import Sequence
from typing import Protocol, runtime_checkable

import numpy as np

LatLng = tuple[float, float]

EARTH_RADIUS_M = 6_371_008.8
DEFAULT_WALK_SPEED_MPS = 5 / 3.6  # the OSRM foot profile walking speed (5 km/h)
DEFAULT_DETOUR_FACTOR = 1.30  # overwritten by the calibrated value stored in data/meta.json


@runtime_checkable
class TravelTimeProvider(Protocol):
    name: str
    exact: bool  # True when durations come from a real street network

    def matrix(self, sources: Sequence[LatLng], destinations: Sequence[LatLng]) -> np.ndarray:
        """Walking durations in seconds, shape (len(sources), len(destinations))."""
        ...


def haversine_m(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Pairwise great-circle distances (metres) between (n,2) and (m,2) arrays of [lat, lng]."""
    a = np.radians(np.asarray(a, dtype=float))[:, None, :]
    b = np.radians(np.asarray(b, dtype=float))[None, :, :]
    dlat = b[..., 0] - a[..., 0]
    dlng = b[..., 1] - a[..., 1]
    h = np.sin(dlat / 2) ** 2 + np.cos(a[..., 0]) * np.cos(b[..., 0]) * np.sin(dlng / 2) ** 2
    return 2 * EARTH_RADIUS_M * np.arcsin(np.sqrt(np.clip(h, 0, 1)))


class HaversineProvider:
    """Straight-line distance times a detour factor, divided by walking speed. An estimate."""

    name = "haversine"
    exact = False

    def __init__(self, detour_factor: float = DEFAULT_DETOUR_FACTOR, speed_mps: float = DEFAULT_WALK_SPEED_MPS):
        self.detour_factor = detour_factor
        self.speed_mps = speed_mps

    def matrix(self, sources: Sequence[LatLng], destinations: Sequence[LatLng]) -> np.ndarray:
        d = haversine_m(
            np.array(sources, dtype=float).reshape(-1, 2), np.array(destinations, dtype=float).reshape(-1, 2)
        )
        return d * self.detour_factor / self.speed_mps


class PrecomputedMatrixProvider:
    """OSRM foot durations precomputed for a fixed set of nodes (buildings + stations).

    Points that are not one of the known nodes fall back to `fallback` (Haversine by default).
    """

    name = "osrm-foot (precomputed)"
    exact = True

    def __init__(self, coords: np.ndarray, seconds: np.ndarray, fallback: TravelTimeProvider | None = None):
        self.coords = np.asarray(coords, dtype=float)
        self.seconds = seconds
        self.fallback = fallback or HaversineProvider()
        self._index = {self._key(c): i for i, c in enumerate(self.coords)}

    @staticmethod
    def _key(p: Sequence[float]) -> tuple[float, float]:
        return (round(float(p[0]), 6), round(float(p[1]), 6))

    def index_of(self, p: LatLng) -> int | None:
        return self._index.get(self._key(p))

    def sub_matrix(self, src_idx: Sequence[int], dst_idx: Sequence[int]) -> np.ndarray:
        return self.seconds[np.ix_(np.asarray(src_idx), np.asarray(dst_idx))].astype(float)

    def matrix(self, sources: Sequence[LatLng], destinations: Sequence[LatLng]) -> np.ndarray:
        si = [self.index_of(p) for p in sources]
        di = [self.index_of(p) for p in destinations]
        if all(i is not None for i in si) and all(j is not None for j in di):
            return self.sub_matrix(si, di)
        out = self.fallback.matrix(sources, destinations)
        for r, i in enumerate(si):
            if i is None:
                continue
            for c, j in enumerate(di):
                if j is not None:
                    out[r, c] = self.seconds[i, j]
        return out


class OSRMProvider:
    """Talks to an osrm-routed instance (foot profile). Used only by offline scripts."""

    name = "osrm-foot"
    exact = True

    def __init__(self, base_url: str = "http://localhost:5000", chunk: int = 400):
        import httpx  # imported lazily: the runtime API does not need it

        self.base_url = base_url.rstrip("/")
        self.chunk = chunk
        self._client = httpx.Client(timeout=60)

    @staticmethod
    def _coord_str(points: Sequence[LatLng]) -> str:
        return ";".join(f"{lng:.6f},{lat:.6f}" for lat, lng in points)

    def matrix(self, sources: Sequence[LatLng], destinations: Sequence[LatLng]) -> np.ndarray:
        out = np.zeros((len(sources), len(destinations)), dtype=float)
        for s0 in range(0, len(sources), self.chunk):
            src = list(sources[s0 : s0 + self.chunk])
            for d0 in range(0, len(destinations), self.chunk):
                dst = list(destinations[d0 : d0 + self.chunk])
                pts = src + dst
                params = {
                    "sources": ";".join(str(i) for i in range(len(src))),
                    "destinations": ";".join(str(len(src) + j) for j in range(len(dst))),
                    "annotations": "duration",
                }
                r = self._client.get(f"{self.base_url}/table/v1/foot/{self._coord_str(pts)}", params=params)
                r.raise_for_status()
                body = r.json()
                if body.get("code") != "Ok":
                    raise RuntimeError(f"OSRM table failed: {body.get('code')} {body.get('message')}")
                durations = np.array(
                    [[math.nan if v is None else v for v in row] for row in body["durations"]], dtype=float
                )
                out[s0 : s0 + len(src), d0 : d0 + len(dst)] = durations
        return out

    def route(self, a: LatLng, b: LatLng) -> tuple[float, str]:
        """Duration (s) and encoded polyline (precision 5) of the walking path a -> b."""
        import httpx

        for attempt in range(4):  # osrm-routed occasionally resets keep-alive connections under load
            try:
                r = self._client.get(
                    f"{self.base_url}/route/v1/foot/{self._coord_str([a, b])}",
                    params={"overview": "full", "geometries": "polyline"},
                )
                r.raise_for_status()
                break
            except httpx.TransportError:  # the server recycled the connection: retry on a new one
                if attempt == 3:
                    raise
                time.sleep(0.5 * (attempt + 1))
        body = r.json()
        route = body["routes"][0]
        return float(route["duration"]), route["geometry"]


class GoogleRoutesProvider:
    """Google Routes API, Compute Route Matrix, travelMode WALK.

    Reads GOOGLE_MAPS_API_KEY. Requests are chunked to 25x25 = 625 elements (the per-request limit).
    Billing is per element; see app/solver/cost.py for the estimate shown in the UI.
    """

    name = "google-routes-walk"
    exact = True
    ENDPOINT = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix"
    CHUNK = 25

    def __init__(self, api_key: str | None = None):
        self.api_key = api_key or os.environ.get("GOOGLE_MAPS_API_KEY")
        if not self.api_key:
            raise RuntimeError("GOOGLE_MAPS_API_KEY is not set")
        import httpx

        self._client = httpx.Client(timeout=120)

    @staticmethod
    def _wp(p: LatLng) -> dict:
        return {"waypoint": {"location": {"latLng": {"latitude": p[0], "longitude": p[1]}}}}

    def matrix(self, sources: Sequence[LatLng], destinations: Sequence[LatLng]) -> np.ndarray:
        out = np.full((len(sources), len(destinations)), np.nan)
        headers = {
            "X-Goog-Api-Key": self.api_key,
            "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition",
            "Content-Type": "application/json",
        }
        for s0 in range(0, len(sources), self.CHUNK):
            src = sources[s0 : s0 + self.CHUNK]
            for d0 in range(0, len(destinations), self.CHUNK):
                dst = destinations[d0 : d0 + self.CHUNK]
                body = {
                    "origins": [self._wp(p) for p in src],
                    "destinations": [self._wp(p) for p in dst],
                    "travelMode": "WALK",
                }
                r = self._client.post(self.ENDPOINT, json=body, headers=headers)
                r.raise_for_status()
                for el in r.json():
                    if el.get("condition") == "ROUTE_EXISTS" and "duration" in el:
                        out[s0 + el["originIndex"], d0 + el["destinationIndex"]] = float(el["duration"].rstrip("s"))
        return out


def provider_from_env(default: TravelTimeProvider) -> TravelTimeProvider:
    """`TRAVEL_PROVIDER=google` (plus GOOGLE_MAPS_API_KEY) switches live travel times to Google."""
    if os.environ.get("TRAVEL_PROVIDER", "").lower() == "google" and os.environ.get("GOOGLE_MAPS_API_KEY"):
        return GoogleRoutesProvider()
    return default
