"""Excel export of the 2-week schedule: one sheet per week, one block of rows per cleaner and day."""

from __future__ import annotations

import io

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from app.data import Dataset
from app.domain import DAY_KEYS
from app.routesheet import WEEKDAY_EL

HEADERS = ["Καθαριστής/-τρια", "Ημέρα", "Σειρά", "Άφιξη", "Αναχώρηση", "Διεύθυνση", "Περιοχή",
           "Εργασία (λεπτά)", "Περπάτημα από προηγούμενη (λεπτά)", "Ωράριο", "Πρόσβαση"]  # fmt: skip
WIDTHS = [24, 11, 7, 8, 11, 30, 18, 15, 17, 13, 40]
SHEETS = {"A": "Εβδομάδα Α", "B": "Εβδομάδα Β"}


def _clock(m: float) -> str:
    m = round(m)
    return f"{m // 60:02d}:{m % 60:02d}"


def schedule_workbook(ds: Dataset, plan: dict) -> bytes:
    cleaners = {c["id"]: c for c in plan["cleaners"]}
    routes = {(r["cleaner_id"], r["day_key"]): r for r in plan["routes"]}
    wb = Workbook()
    wb.remove(wb.active)
    band = PatternFill("solid", fgColor="F3EFE8")
    for week, title in SHEETS.items():
        ws = wb.create_sheet(title)
        ws.append(HEADERS)
        for cell in ws[1]:
            cell.font = Font(bold=True)
            cell.alignment = Alignment(vertical="center", wrap_text=True)
        ws.freeze_panes = "A2"
        shade = False
        for cid in sorted(cleaners):
            for day in (d for d in DAY_KEYS if d.startswith(week)):
                r = routes.get((cid, day))
                if not r or not r["stops"]:
                    continue
                shade = not shade
                start = cleaners[cid]["start"]["label"]
                for i, s in enumerate(r["stops"], 1):
                    b = ds.building_by_id[s["building_id"]]
                    tw = b.get("time_window")
                    ws.append([
                        cleaners[cid]["name"] if i == 1 else "",
                        WEEKDAY_EL[day.split("-")[1]] if i == 1 else "",
                        i, _clock(s["arrival"]), _clock(s["depart"]),
                        f"{b['street']} {b['number']}".strip() or b["name"], b["neighborhood"],
                        b["service_minutes"], round(s["walk_from_prev"]),
                        f"{_clock(tw[0])}–{_clock(tw[1])}" if tw else "", b.get("access_note", ""),
                    ])  # fmt: skip
                    if shade:
                        for cell in ws[ws.max_row]:
                            cell.fill = band
                ws.append(["", "", "", _clock(r["end_time"]), "", f"Επιστροφή: {start}", "", "", "", "", ""])
        for i, w in enumerate(WIDTHS, 1):
            ws.column_dimensions[get_column_letter(i)].width = w
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
