"""Customer list import (.xlsx / .csv) with offline geocoding and validation."""

from __future__ import annotations

import io
import re
import unicodedata

import pandas as pd

from app.domain import FREQUENCIES
from app.geocoder import AddressIndex, Issue, normalize

COLUMNS = ["street", "number", "postcode", "frequency", "floors", "has_lift"]
GREEK_COLUMNS = ["Οδός", "Αριθμός", "Τ.Κ.", "Συχνότητα", "Όροφοι", "Ανελκυστήρας"]
# header (normalised: no accents, lowercase, letters only) -> column
_HEADER_ALIASES = {
    **{c.replace("_", ""): c for c in COLUMNS},
    "οδοσ": "street", "αριθμοσ": "number", "αρ": "number", "τκ": "postcode", "ταχυδρομικοσκωδικασ": "postcode",
    "συχνοτητα": "frequency", "οροφοι": "floors", "ανελκυστηρασ": "has_lift", "ασανσερ": "has_lift", "lift": "has_lift",
}  # fmt: skip
FREQUENCY_LABELS_EL = {"3w": "3 φορές/εβδ.", "2w": "2 φορές/εβδ.", "1w": "1 φορά/εβδ.", "biweekly": "Κάθε 2 εβδ."}
_TRUE = {"1", "true", "yes", "y", "ναι", "ν", "x", "✓"}
_FALSE = {"0", "false", "no", "n", "οχι", "όχι", "ο", ""}


class TableError(ValueError):
    """The file was read but cannot be imported; `code` is stable for the UI."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _column(header: object) -> str:
    """Maps English or Greek headers ("Οδός", "Τ.Κ.", "has_lift") to the canonical column name."""
    key = re.sub(r"[^\w]|_", "", normalize(str(header)))
    return _HEADER_ALIASES.get(key, str(header).strip().lower())


def parse_frequency(value: str) -> str | None:
    """'2w', '2 φορές/εβδ.', 'Κάθε 2 εβδομάδες', 'biweekly' -> frequency code; None if not understood."""
    v = normalize(value).strip()
    if v in FREQUENCIES:
        return v
    if "καθε 2" in v or "15ημερ" in v or "δεκαπενθ" in v or "every 2" in v:
        return "biweekly"
    m = re.match(r"^([123])\s*(φορ|×|x|times|/)", v)
    return f"{m.group(1)}w" if m else None


def read_table(filename: str, content: bytes) -> pd.DataFrame:
    name = (filename or "").lower()
    if name.endswith(".csv"):
        df = pd.read_csv(io.BytesIO(content), dtype=str, keep_default_na=False, sep=None, engine="python")
    else:
        df = pd.read_excel(io.BytesIO(content), dtype=str, keep_default_na=False)
    df.columns = [_column(c) for c in df.columns]
    missing = [c for c in ("street", "number") if c not in df.columns]
    if missing:
        raise TableError(
            "missing_columns", f"missing required column(s): {', '.join(missing)}; expected {', '.join(COLUMNS)}"
        )
    return df


def import_rows(df: pd.DataFrame, index: AddressIndex) -> dict:
    rows = []
    for _, rec in df.iterrows():
        raw = {c: str(rec.get(c, "")).strip() for c in df.columns}
        m = index.lookup(raw.get("street", ""), raw.get("number", ""), raw.get("postcode"))
        issues = list(m.issues)
        freq = parse_frequency(raw.get("frequency", ""))
        if raw.get("frequency") and freq is None:
            text = f"unknown frequency '{raw['frequency']}' (use {', '.join(FREQUENCIES)})"
            issues.append(Issue("unknown_frequency", text, raw["frequency"]))
        floors = raw.get("floors", "")
        if floors:
            try:
                f = int(float(floors))
                if not 1 <= f <= 20:
                    issues.append(Issue("floors_out_of_range", f"floors out of range: {floors}", floors))
            except ValueError:
                issues.append(Issue("floors_not_number", f"floors is not a number: {floors}", floors))
        lift = raw.get("has_lift", "").lower()
        if lift and lift not in _TRUE | _FALSE:
            issues.append(Issue("has_lift_unknown", f"has_lift not understood: {raw['has_lift']}", raw["has_lift"]))
        row = {"input": raw, "matched": m.matched, "confidence": m.confidence}
        if freq:
            row["frequency"] = freq  # extra field: the parsed frequency code
        if m.lat is not None:
            row.update({"lat": m.lat, "lng": m.lng, "matched_label": m.label})
        if issues:
            row["issue"] = "; ".join(i.text for i in issues)  # English, kept for API clients
            row["issues"] = [i.public() for i in issues]
        rows.append(row)
    matched = sum(r["matched"] for r in rows)
    summary = {
        "total": len(rows),
        "matched": matched,
        "exact": sum(1 for r in rows if r["matched"] and r["confidence"] >= 0.95),
        "needs_review": sum(1 for r in rows if r["matched"] and r["confidence"] < 0.95),
        "unmatched": len(rows) - matched,
        "with_issues": sum(1 for r in rows if "issue" in r),
        "geocoder": "offline index of OpenStreetMap addresses (no external service)",
    }
    return {"rows": rows, "summary": summary}


def sample_workbook(buildings: list[dict], index: AddressIndex) -> bytes:
    """A realistic import file with Greek headers: 12 addresses written the way people type them
    (capitals, no accents, Greeklish, abbreviations) that all match, and one typo that does not
    match but gets a "did you mean" suggestion."""
    picks = buildings[::83][:12]
    labels = FREQUENCY_LABELS_EL
    rows = []
    for i, b in enumerate(picks):
        street = b["street"]
        if i == 1:
            street = street.upper()
        elif i == 2:
            street = "".join(ch for ch in unicodedata.normalize("NFD", street) if not unicodedata.combining(ch)).lower()
        elif i == 3:
            street = greeklish(street)
        elif i == 4:
            street = f"Οδός {street}"
        rows.append(
            [
                street,
                b["number"],
                b["postcode"] or "",
                labels[b["frequency"]],
                b["floors"],
                "ναι" if b["has_lift"] else "όχι",
            ]
        )
    typo = _typo_with_suggestion(index, picks)
    rows.insert(7, [typo, "12", "", labels["1w"], 5, "ναι"])
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as xw:
        pd.DataFrame(rows, columns=GREEK_COLUMNS).to_excel(xw, index=False, sheet_name="Πολυκατοικίες")
        ws = xw.sheets["Πολυκατοικίες"]
        for col, width in zip("ABCDEF", (30, 10, 9, 16, 9, 14)):
            ws.column_dimensions[col].width = width
    return buf.getvalue()


def greeklish(s: str) -> str:
    """How people type Greek in Latin letters: "Τσαλδάρη Κωνσταντίνου" -> "Tsaldari Konstantinou"."""
    s = normalize(s).replace("ου", "ou").replace("ευ", "ef").replace("αυ", "av")
    return s.translate(_GREEKLISH).title()


_GREEKLISH = str.maketrans(
    {**dict(zip("αβγδεζηικλμνοπρστυφω", "avgdeziiklmnoprstyfo")), "θ": "th", "ξ": "x", "χ": "ch", "ψ": "ps"}
)


def _typo_with_suggestion(index: AddressIndex, avoid: list[dict]) -> str:
    """A misspelt street (two letters swapped and one dropped) that misses the index but has a suggestion."""
    used = {b["street"] for b in avoid}
    for r in index.rows[::37]:
        name = r["street"]
        if name in used or len(name) < 9:
            continue
        typo = name[:2] + name[3] + name[2] + name[4:-3] + name[-2:]
        m = index.lookup(typo, "12")
        if not m.matched and m.issues and m.issues[0].code == "street_suggestion" and m.issues[0].value == name:
            return typo
    return "Οδός Που Δεν Υπάρχει"
