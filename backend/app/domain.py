"""Domain rules shared by the data pipeline, the solver and the API (see CONTRACT.md)."""

from __future__ import annotations

from typing import Literal

WEEKS = ("A", "B")
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri")
DAY_KEYS: list[str] = [f"{w}-{d}" for w in WEEKS for d in WEEKDAYS]
DAY_INDEX: dict[str, int] = {k: i for i, k in enumerate(DAY_KEYS)}

Frequency = Literal["3w", "2w", "1w", "biweekly"]
FREQUENCIES: list[str] = ["3w", "2w", "1w", "biweekly"]

SHIFT_START = 7 * 60  # 07:00, minutes from midnight
DEFAULT_DAILY_MINUTES = 480
DEFAULT_BREAK_MINUTES = 30
DEFAULT_TARGET_UTILIZATION = 0.85
MORNING_WINDOW = (420, 720)

_WEEKLY_2W = [("Mon", "Wed"), ("Mon", "Thu"), ("Mon", "Fri"), ("Tue", "Thu"), ("Tue", "Fri"), ("Wed", "Fri")]


def _both_weeks(days: tuple[str, ...]) -> list[str]:
    return [f"{w}-{d}" for w in WEEKS for d in days]


def _build_patterns() -> dict[str, list[list[str]]]:
    return {
        "3w": [_both_weeks(("Mon", "Wed", "Fri"))],
        "2w": [_both_weeks(p) for p in _WEEKLY_2W],
        "1w": [_both_weeks((d,)) for d in WEEKDAYS],
        "biweekly": [[f"{w}-{d}"] for w in WEEKS for d in WEEKDAYS],
    }


PATTERNS: dict[str, list[list[str]]] = _build_patterns()
VISITS_PER_HORIZON: dict[str, int] = {f: len(p[0]) for f, p in PATTERNS.items()}


def pattern_is_valid(frequency: str, days: list[str]) -> bool:
    """True if `days` is exactly one of the allowed patterns for `frequency`."""
    return sorted(days, key=DAY_INDEX.__getitem__) in PATTERNS.get(frequency, [])


def min_gap_ok(days: list[str], min_gap: int = 2) -> bool:
    """Visits inside the same week must be at least `min_gap` weekdays apart."""
    for w in WEEKS:
        idx = sorted(WEEKDAYS.index(d.split("-")[1]) for d in days if d.startswith(w + "-"))
        if any(b - a < min_gap for a, b in zip(idx, idx[1:])):
            return False
    return True


def fmt_time(minutes: float) -> str:
    m = int(round(minutes))
    return f"{m // 60:02d}:{m % 60:02d}"
