import type { DayKey } from '../api/types';

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const DAY_KEYS: DayKey[] = ['A', 'B'].flatMap((w) => WEEKDAYS.map((d) => `${w}-${d}`));

export function splitDay(k: DayKey): { week: 'A' | 'B'; day: Weekday; index: number } {
  const [w, d] = k.split('-');
  return { week: w === 'B' ? 'B' : 'A', day: d as Weekday, index: WEEKDAYS.indexOf(d as Weekday) };
}

export function minutesToClock(m: number): string {
  const mm = Math.round(m);
  const h = Math.floor(mm / 60), r = mm % 60;
  return `${String(h).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}
