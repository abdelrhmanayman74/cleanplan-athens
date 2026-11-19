"""Clip greece-latest.osm.pbf to an Athens bounding box using pyosmium (no osmium-tool needed).

Keeps every way that has at least one node inside the bbox (complete, with all its nodes) so the
walking network is not cut mid-street at the border. Relations are dropped: the OSRM foot profile
does not need them.

Usage:  uv run python scripts/clip_pbf.py osrm-data/greece-latest.osm.pbf osrm-data/athens.osm.pbf
"""

from __future__ import annotations

import sys
import time

import osmium

S, W, N, E = 37.88, 23.62, 38.08, 23.86


def inside(lat: float, lng: float) -> bool:
    return S <= lat <= N and W <= lng <= E


def main(src: str, dst: str) -> None:
    t0 = time.time()
    kept = 0
    with osmium.BackReferenceWriter(dst, ref_src=src, overwrite=True) as writer:
        for obj in osmium.FileProcessor(src, osmium.osm.NODE | osmium.osm.WAY).with_locations():
            if obj.is_way():
                for n in obj.nodes:
                    loc = n.location
                    if loc.valid() and inside(loc.lat, loc.lon):
                        writer.add_way(obj)
                        kept += 1
                        break
    print(f"kept {kept} ways in {time.time() - t0:.0f}s -> {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
