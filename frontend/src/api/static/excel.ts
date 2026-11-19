// Browser version of backend/app/export.py: the 2-week schedule as .xlsx, same sheets and columns.

import type { Building, Plan } from '../types';

const HEADERS = ['Καθαριστής/-τρια', 'Ημέρα', 'Σειρά', 'Άφιξη', 'Αναχώρηση', 'Διεύθυνση', 'Περιοχή',
  'Εργασία (λεπτά)', 'Περπάτημα από προηγούμενη (λεπτά)', 'Ωράριο', 'Πρόσβαση'];
const WIDTHS = [24, 11, 7, 8, 11, 30, 18, 15, 17, 13, 40];
const SHEETS: [string, string][] = [['A', 'Εβδομάδα Α'], ['B', 'Εβδομάδα Β']];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const WEEKDAY_EL: Record<string, string> = { Mon: 'Δευτέρα', Tue: 'Τρίτη', Wed: 'Τετάρτη', Thu: 'Πέμπτη', Fri: 'Παρασκευή' };
const BAND = '#F3EFE8';

const clock = (m: number) => {
  const r = Math.round(m);
  return `${String(Math.floor(r / 60)).padStart(2, '0')}:${String(r % 60).padStart(2, '0')}`;
};

type Cell = { value: string | number; fontWeight?: 'bold'; backgroundColor?: string; wrap?: boolean } | null;

export async function scheduleWorkbook(plan: Plan, buildingById: Map<string, Building>): Promise<Blob> {
  const { default: writeXlsxFile } = await import('write-excel-file/browser');
  const routes = new Map(plan.routes.map((r) => [`${r.cleaner_id}|${r.day_key}`, r]));
  const cleaners = [...plan.cleaners].sort((a, b) => (a.id < b.id ? -1 : 1));
  const sheets = SHEETS.map(([week, title]) => {
    const data: Cell[][] = [HEADERS.map((h) => ({ value: h, fontWeight: 'bold', wrap: true }))];
    let shade = false;
    for (const c of cleaners) {
      for (const d of WEEKDAYS) {
        const r = routes.get(`${c.id}|${week}-${d}`);
        if (!r?.stops.length) continue;
        shade = !shade;
        const bg = shade ? BAND : undefined;
        r.stops.forEach((s, i) => {
          const b = buildingById.get(s.building_id)!;
          const tw = b.time_window;
          const row: (string | number)[] = [
            i === 0 ? c.name : '', i === 0 ? WEEKDAY_EL[d] : '', i + 1, clock(s.arrival), clock(s.depart),
            `${b.street} ${b.number}`.trim() || b.name, b.neighborhood, b.service_minutes, Math.round(s.walk_from_prev),
            tw ? `${clock(tw[0])}–${clock(tw[1])}` : '', b.access_note ?? '',
          ];
          data.push(row.map((value) => ({ value, backgroundColor: bg })));
        });
        data.push(['', '', '', clock(r.end_time), '', `Επιστροφή: ${c.start.label}`, '', '', '', '', ''].map((value) => ({ value })));
      }
    }
    return { data, sheet: title, columns: WIDTHS.map((width) => ({ width })), stickyRowsCount: 1 };
  });
  return writeXlsxFile(sheets).toBlob();
}
