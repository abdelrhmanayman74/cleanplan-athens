#!/usr/bin/env bash
# Build the OSRM foot (walking) graph for Athens and optionally start osrm-routed.
#   scripts/build_osrm.sh          # download + clip + extract/partition/customize
#   scripts/build_osrm.sh serve    # start osrm-routed on :5000 (container name: cleanplan-osrm)
set -euo pipefail
cd "$(dirname "$0")/.."
DATA=osrm-data
IMG=ghcr.io/project-osrm/osrm-backend:v5.27.1
mkdir -p "$DATA"

if [[ "${1:-}" == "serve" ]]; then
  docker rm -f cleanplan-osrm >/dev/null 2>&1 || true
  docker run -d --name cleanplan-osrm -p 5000:5000 -v "$PWD/$DATA:/data" "$IMG" \
    osrm-routed --algorithm mld --max-table-size 2000 /data/athens.osrm
  echo "osrm-routed starting on http://localhost:5000"
  exit 0
fi

[[ -f "$DATA/greece-latest.osm.pbf" ]] || \
  curl -sSL -A "cleanplan-demo/0.1" -o "$DATA/greece-latest.osm.pbf" \
    https://download.geofabrik.de/europe/greece-latest.osm.pbf

[[ -f "$DATA/athens.osm.pbf" ]] || \
  uv run python scripts/clip_pbf.py "$DATA/greece-latest.osm.pbf" "$DATA/athens.osm.pbf"

docker run --rm -v "$PWD/$DATA:/data" "$IMG" osrm-extract -p /opt/foot.lua /data/athens.osm.pbf
docker run --rm -v "$PWD/$DATA:/data" "$IMG" osrm-partition /data/athens.osrm
docker run --rm -v "$PWD/$DATA:/data" "$IMG" osrm-customize /data/athens.osrm
echo "OSRM foot graph ready: $DATA/athens.osrm"
