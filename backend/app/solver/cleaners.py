"""Synthetic cleaners: Greek names, distinct colours, start point (nearest station or home)."""

from __future__ import annotations

import colorsys

import numpy as np

from app.data import Dataset

FIRST = [
    "Ελένη",
    "Μαρία",
    "Γιώργος",
    "Κατερίνα",
    "Νίκος",
    "Σοφία",
    "Δημήτρης",
    "Αγγελική",
    "Κώστας",
    "Βασιλική",
    "Γιάννης",
    "Δέσποινα",
    "Παναγιώτης",
    "Ιωάννα",
    "Χρήστος",
    "Αναστασία",
    "Μιχάλης",
    "Φωτεινή",
    "Σταύρος",
    "Γεωργία",
    "Θανάσης",
    "Χριστίνα",
    "Αντώνης",
    "Δήμητρα",
    "Βασίλης",
    "Ευαγγελία",
    "Λευτέρης",
    "Ειρήνη",
    "Πέτρος",
    "Ζωή",
    "Άρης",
    "Μαρίνα",
    "Τάσος",
    "Νεφέλη",
    "Στέλιος",
    "Αθηνά",
    "Λάμπρος",
    "Ευτυχία",
    "Φώτης",
    "Ρένα",
]
LAST_M = [
    "Παπαδόπουλος",
    "Αλεξίου",
    "Κωνσταντίνου",
    "Σταματόπουλος",
    "Μαυρίδης",
    "Ραφαηλίδης",
    "Οικονόμου",
    "Χατζηγεωργίου",
    "Μπαλτάς",
    "Τσιμπίδης",
    "Αναγνώστου",
    "Ζαχαρίου",
    "Καλογεράκης",
    "Βλάχος",
    "Δραγούμης",
    "Μελετίου",
    "Σαρρής",
    "Φραγκιαδάκης",
    "Λιάπης",
    "Πολυχρόνης",
]
FEMALE = {
    "Ελένη",
    "Μαρία",
    "Κατερίνα",
    "Σοφία",
    "Αγγελική",
    "Βασιλική",
    "Δέσποινα",
    "Ιωάννα",
    "Αναστασία",
    "Φωτεινή",
    "Γεωργία",
    "Χριστίνα",
    "Δήμητρα",
    "Ευαγγελία",
    "Ειρήνη",
    "Ζωή",
    "Μαρίνα",
    "Νεφέλη",
    "Αθηνά",
    "Ευτυχία",
    "Ρένα",
}
HOME_IF_STATION_FARTHER_THAN_S = 14 * 60  # mean walk from the best station to the territory


def _fem(s: str) -> str:
    for suf, rep in (("ος", "ου"), ("ης", "η"), ("ας", "α")):
        if s.endswith(suf):
            return s[: -len(suf)] + rep
    return s


def cleaner_names(k: int, seed: int) -> list[str]:
    rng = np.random.default_rng(seed + 7)
    firsts = list(rng.permutation(FIRST))
    lasts = list(rng.permutation(LAST_M))
    out = []
    for i in range(k):
        f = firsts[i % len(firsts)]
        last = lasts[(i * 7) % len(lasts)]
        out.append(f"{f} {_fem(last) if f in FEMALE else last}")
    return out


def cleaner_colors(k: int) -> list[str]:
    """Distinct colours: golden-angle hues with alternating lightness/saturation."""
    out = []
    for i in range(k):
        h = (i * 0.618033988749895) % 1.0
        light = (0.42, 0.55, 0.35)[i % 3]
        sat = (0.75, 0.65, 0.85)[(i // 3) % 3]
        r, g, b = colorsys.hls_to_rgb(h, light, sat)
        out.append(f"#{int(r * 255):02x}{int(g * 255):02x}{int(b * 255):02x}")
    return out


# Line 1 (ΗΣΑΠ) stations that are not interchanges; Greeks name these "ΗΣΑΠ <name>".
ISAP_STATIONS = {
    "Μοσχάτο", "Καλλιθέα", "Ταύρος-Ελευθέριος Βενιζέλος", "Πετράλωνα", "Θησείο", "Βικτώρια",
    "Άγιος Νικόλαος", "Κάτω Πατήσια", "Άγιος Ελευθέριος", "Άνω Πατήσια",
}  # fmt: skip
MODE_LABEL = {"metro": "Μετρό", "isap": "ΗΣΑΠ", "tram": "Τραμ", "rail": "Προαστιακός"}


def station_mode(s: dict) -> str:
    """metro | isap | tram | rail, the way a cleaner would name the stop ("Μετρό Σύνταγμα")."""
    if s["kind"] == "metro" and s["name"] in ISAP_STATIONS:
        return "isap"
    return s["kind"] if s["kind"] in MODE_LABEL else "metro"


def choose_start(ds: Dataset, member_nodes: list[int]) -> dict:
    """Station with the lowest mean walk to the territory; 'home' (territory medoid) if all are far."""
    st = np.array(ds.station_nodes())
    mean_walk = (
        ds.seconds[np.ix_(st, member_nodes)].mean(axis=1) / 2 + ds.seconds[np.ix_(member_nodes, st)].mean(axis=0) / 2
    )
    best = int(np.argmin(mean_walk))
    if mean_walk[best] <= HOME_IF_STATION_FARTHER_THAN_S:
        s = ds.stations[best]
        mode = station_mode(s)
        return {
            "lat": s["lat"],
            "lng": s["lng"],
            "label": f"{MODE_LABEL[mode]} {s['name']}",
            "kind": "station",
            "mode": mode,
            "ref": s["id"],
            "node": int(st[best]),
        }
    sub = ds.seconds[np.ix_(member_nodes, member_nodes)]
    med = member_nodes[int(np.argmin(sub.sum(axis=1)))]
    b = ds.buildings[med] if med < len(ds.buildings) else None
    hood = b["neighborhood"] if b else ""
    lat, lng = ds.coords[med]
    return {
        "lat": float(lat),
        "lng": float(lng),
        "label": f"Σπίτι ({hood})",
        "kind": "home",
        "mode": "home",
        "ref": None,
        "node": int(med),
    }
