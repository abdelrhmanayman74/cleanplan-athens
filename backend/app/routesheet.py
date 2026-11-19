"""Mobile route sheet for one cleaner and day, with Google Maps walking links."""

from __future__ import annotations

from urllib.parse import quote

from app.data import Dataset

GMAPS_MAX_WAYPOINTS = 9
WEEKDAY_EL = {"Mon": "Δευτέρα", "Tue": "Τρίτη", "Wed": "Τετάρτη", "Thu": "Πέμπτη", "Fri": "Παρασκευή"}
WEEK_EL = {"A": "Εβδομάδα Α", "B": "Εβδομάδα Β"}


def _ll(p: tuple[float, float]) -> str:
    return f"{p[0]:.6f},{p[1]:.6f}"


def google_maps_urls(points: list[tuple[float, float]]) -> list[str]:
    """Walking directions through `points` (origin, stops…, destination), split so that each link has
    at most 9 intermediate waypoints; consecutive links share their boundary point."""
    if len(points) < 2:
        return []
    urls = []
    i = 0
    while i < len(points) - 1:
        j = min(i + GMAPS_MAX_WAYPOINTS + 1, len(points) - 1)
        seg = points[i : j + 1]
        url = (
            f"https://www.google.com/maps/dir/?api=1&origin={_ll(seg[0])}&destination={_ll(seg[-1])}&travelmode=walking"
        )
        if len(seg) > 2:
            url += "&waypoints=" + quote("|".join(_ll(p) for p in seg[1:-1]), safe=",|")
        urls.append(url)
        i = j
    return urls


def date_label(day_key: str) -> str:
    week, day = day_key.split("-")
    return f"{WEEK_EL[week]} · {WEEKDAY_EL[day]}"


def route_sheet(ds: Dataset, plan: dict, cleaner_id: str, day_key: str) -> dict:
    cleaner = next((c for c in plan["cleaners"] if c["id"] == cleaner_id), None)
    route = next((r for r in plan["routes"] if r["cleaner_id"] == cleaner_id and r["day_key"] == day_key), None)
    if cleaner is None or route is None:
        raise KeyError(f"no route for {cleaner_id} / {day_key}")
    public_buildings = {b["id"]: b for b in ds.public_buildings()}
    stops = [{**s, "building": public_buildings[s["building_id"]]} for s in route["stops"]]
    start = (cleaner["start"]["lat"], cleaner["start"]["lng"])
    pts = [start, *[(s["building"]["lat"], s["building"]["lng"]) for s in stops], start]
    urls = google_maps_urls(pts) if stops else []
    return {
        "cleaner": cleaner,
        "day_key": day_key,
        "date_label": date_label(day_key),
        "route": route,
        "stops": stops,
        "google_maps_url": urls[0] if urls else "",
        "google_maps_urls": urls,
    }
