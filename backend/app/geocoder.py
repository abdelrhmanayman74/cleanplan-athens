"""Offline fuzzy geocoder over the OSM addresses fetched by the data pipeline (no external service).

Matching is accent- and case-insensitive (NFD, strip combining marks, lowercase, final ς -> σ, as in
the frontend) and also works for Greeklish input ("Formionos 42") by comparing Latin
transliterations.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass, field
from difflib import SequenceMatcher, get_close_matches
from pathlib import Path

import numpy as np

from app.travel import haversine_m

_GREEK_TO_LATIN = str.maketrans(
    {
        "α": "a",
        "β": "v",
        "γ": "g",
        "δ": "d",
        "ε": "e",
        "ζ": "z",
        "η": "i",
        "θ": "th",
        "ι": "i",
        "κ": "k",
        "λ": "l",
        "μ": "m",
        "ν": "n",
        "ξ": "x",
        "ο": "o",
        "π": "p",
        "ρ": "r",
        "σ": "s",
        "τ": "t",
        "υ": "y",
        "φ": "f",
        "χ": "ch",
        "ψ": "ps",
        "ω": "o",
    }
)
_DIGRAPHS = [
    ("kh", "x"),
    ("ch", "x"),
    ("ou", "u"),
    ("oy", "u"),
    ("ay", "av"),
    ("ey", "ev"),
    ("ai", "e"),
    ("ei", "i"),
    ("oi", "i"),
    ("yi", "i"),
    ("mp", "b"),
    ("nt", "d"),
    ("gk", "g"),
    ("gg", "g"),
    ("ks", "x"),
    ("ph", "f"),
    ("w", "o"),
    ("y", "i"),
    ("c", "k"),
]
_STOPWORDS = {
    "οδος",
    "οδοσ",
    "λεωφ",
    "λεωφοροσ",
    "πλατεια",
    "πλ",
    "odos",
    "leof",
    "leoforos",
    "plateia",
    "str",
    "street",
}


def normalize(s: str) -> str:
    """Contract normalisation: NFD, strip combining marks, lowercase, final ς -> σ."""
    s = unicodedata.normalize("NFD", str(s))
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return s.lower().replace("ς", "σ")


def latin_key(s: str) -> str:
    """Normalised, transliterated, phonetically flattened key for fuzzy matching."""
    s = normalize(s)
    s = re.sub(r"[^\w\s]", " ", s)
    words = [w for w in s.split() if w not in _STOPWORDS]
    s = " ".join(words).translate(_GREEK_TO_LATIN)
    for a, b in _DIGRAPHS:
        s = s.replace(a, b)
    return re.sub(r"\s+", " ", s).strip()


def _number_range(n: str) -> tuple[int, int] | None:
    """'42' -> (42, 42); '42-44' -> (42, 44); '42Α' -> (42, 42); no digits -> None."""
    nums = [int(x) for x in re.findall(r"\d+", str(n))[:2]]
    if not nums:
        return None
    return (min(nums), max(nums))


@dataclass(frozen=True)
class Issue:
    """A data-quality note: a stable `code` the UI translates, an optional `value`, English `text`."""

    code: str
    text: str
    value: str | None = None

    def public(self) -> dict:
        return {"code": self.code, "text": self.text, **({"value": self.value} if self.value is not None else {})}


@dataclass
class Match:
    matched: bool
    confidence: float
    lat: float | None = None
    lng: float | None = None
    label: str | None = None
    issues: list[Issue] = field(default_factory=list)

    @property
    def issue(self) -> str | None:
        return "; ".join(i.text for i in self.issues) or None


class AddressIndex:
    def __init__(self, rows: list[dict]):
        self.rows = rows
        self.by_street: dict[str, list[dict]] = {}
        for r in rows:
            self.by_street.setdefault(latin_key(r["street"]), []).append(r)
        self.street_keys = list(self.by_street)
        self._coords: np.ndarray | None = None

    def nearest(self, lat: float, lng: float) -> dict:
        """The closest indexed address: {street, number, neighborhood, label, distance_m}."""
        if self._coords is None:
            self._coords = np.array([[r["lat"], r["lng"]] for r in self.rows])
        d = haversine_m(np.array([[lat, lng]]), self._coords)[0]
        i = int(np.argmin(d))
        r = self.rows[i]
        return {
            "street": r["street"],
            "number": r["number"],
            "neighborhood": r["neighborhood"],
            "label": f"{r['street']} {r['number']}, {r['neighborhood']}",
            "distance_m": round(float(d[i])),
        }

    @classmethod
    def load(cls, path: Path) -> AddressIndex:
        return cls(json.loads(path.read_text()))

    def _not_found(self, key: str) -> Issue:
        """Street unknown; if a looser match exists, offer it as a suggestion instead of guessing."""
        loose = get_close_matches(key, self.street_keys, n=1, cutoff=0.5)
        if loose:
            name = self.by_street[loose[0]][0]["street"]
            return Issue("street_suggestion", f"street not found; did you mean {name}?", name)
        return Issue("street_not_found", "street not found in the local OSM address index")

    def lookup(self, street: str, number: str, postcode: str | None = None) -> Match:
        key = latin_key(street or "")
        if not key:
            return Match(False, 0.0, issues=[Issue("missing_street", "missing street")])
        if key in self.by_street:
            street_key, street_score = key, 1.0
        else:
            close = get_close_matches(key, self.street_keys, n=1, cutoff=0.72)
            if not close:
                return Match(False, 0.0, issues=[self._not_found(key)])
            street_key = close[0]
            street_score = SequenceMatcher(None, key, street_key).ratio()
        cands = self.by_street[street_key]
        pc = re.sub(r"\D", "", str(postcode or ""))
        want = _number_range(number)
        num_norm = normalize(str(number or "")).strip()
        scored = []
        for c in cands:
            have = _number_range(c["number"])
            if normalize(c["number"]).strip() == num_norm:
                score, gap = 1.0, 0
            elif want is None or have is None:
                continue
            elif have[0] <= want[0] <= have[1]:
                score, gap = 0.95, 0  # inside a range such as 42-44
            else:
                gap = min(abs(want[0] - have[0]), abs(want[0] - have[1]))
                score = max(0.3, 0.9 - 0.05 * gap - (0 if gap % 2 == 0 else 0.15))
            bonus = 0.02 if pc and (c.get("postcode") or "") == pc else 0.0
            scored.append((score + bonus, -gap, c["number"], c, score))
        if not scored:
            return Match(
                False, round(0.4 * street_score, 2), issues=[Issue("number_not_found", "house number not found")]
            )
        _, _, _, c, num_score = max(scored, key=lambda t: (t[0], t[1], t[2]))
        issues = []
        if street_score < 1.0:
            issues.append(Issue("street_approximate", f"street matched approximately ({c['street']})", c["street"]))
        if num_score < 0.95:
            issues.append(Issue("number_nearest", f"nearest number on the street used ({c['number']})", c["number"]))
        confidence = round(street_score * num_score, 2)
        label = (
            f"{c['street']} {c['number']}"
            + (f", {c['postcode']}" if c.get("postcode") else "")
            + f" ({c['neighborhood']})"
        )
        return Match(confidence >= 0.5, confidence, c["lat"], c["lng"], label, issues)
