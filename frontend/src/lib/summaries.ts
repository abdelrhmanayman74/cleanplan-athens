import type { ChangeResult, Cleaner } from '../api/types';
import type { DictKey } from '../i18n/dict';
import { firstName, genitiveWithArticle } from './greek';
import { fmtSigned } from './format';

type T = (k: DictKey, v?: Record<string, string | number>) => string;

/** Net change in the plan's walking minutes. The single source for every "+N′ walking" figure. */
export const walkDelta = (res: ChangeResult) => res.kpis_after.walk_minutes - res.kpis_before.walk_minutes;

export function absenceSummary(res: ChangeResult, absent: Cleaner | undefined, t: T, lang: string): string {
  const id = absent?.id;
  const fromAbsent = res.changes.filter((c) => c.from_cleaner === id);
  const moved = fromAbsent.filter((c) => c.to_cleaner);
  const k = new Set(moved.map((c) => c.to_cleaner)).size;
  const other = Math.max(0, res.churn - fromAbsent.length);
  const who = absent ? (lang === 'el' ? genitiveWithArticle(absent.name) : firstName(absent.name)) : '';
  const colleagues = k === 1 ? t('absence.colleagueOne') : t('absence.colleagues', { k });
  const vars = { n: moved.length, who, colleagues, walk: `${fmtSigned(Math.round(walkDelta(res)), lang)}′`, other };
  return moved.length === 1 ? t('absence.summaryOne', vars) : t('absence.summary', vars);
}

/** New visits come with from_cleaner = null; anything else is a move of an existing visit. */
export function insertSummary(res: ChangeResult, cleaner: Cleaner | undefined, days: string, t: T, lang: string): string {
  const others = res.changes.filter((c) => c.from_cleaner !== null).length;
  const who = cleaner ? (lang === 'el' ? genitiveWithArticle(cleaner.name) : firstName(cleaner.name)) : '';
  const vars = { who, days, walk: `${fmtSigned(Math.round(walkDelta(res)), lang)}′`, n: others };
  return others === 0 ? t('insert.done', vars) : t('insert.doneOthers', vars);
}
