import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { el, en, type DictKey } from './dict';
import { ApiError } from '../api/client';
import type { DayKey, Frequency } from '../api/types';
import { splitDay, WEEKDAYS } from '../lib/days';

export type Lang = 'el' | 'en';
type Vars = Record<string, string | number>;

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: DictKey, vars?: Vars) => string;
  /** chip "Α·Δευ", short "Δευ Α", caption "Δευτέρα (Εβδ. Α)", long "Δευτέρα · Εβδομάδα Α". */
  dayLabel: (k: DayKey, style?: 'chip' | 'long' | 'short' | 'caption' | 'weekday') => string;
  freqLabel: (f: Frequency, pattern: DayKey[]) => string;
  patternLabel: (pattern: DayKey[]) => string;
  /** Translates a backend code (`reason.needs_overtime`, `issue.street_not_found`, …), else `fallback`. */
  tCode: (prefix: CodePrefix, code: string | undefined, fallback: string, vars?: Vars) => string;
  /** User-facing text for a thrown error, translated when the backend sent a known code. */
  errorText: (e: unknown) => string;
}

type CodePrefix = 'reason' | 'issue' | 'error';
const hasKey = (k: string): k is DictKey => k in el;

const Ctx = createContext<I18nCtx | null>(null);

function readLang(): Lang {
  try {
    const q = new URLSearchParams(window.location.search).get('lang');
    if (q === 'en' || q === 'el') return q;
    const s = localStorage.getItem('cp.lang');
    if (s === 'en' || s === 'el') return s;
  } catch { /* storage unavailable */ }
  return 'el';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readLang);
  useEffect(() => {
    document.documentElement.lang = lang;
    try { localStorage.setItem('cp.lang', lang); } catch { /* ignore */ }
  }, [lang]);

  const t = useCallback((key: DictKey, vars?: Vars) => {
    let s: string = (lang === 'el' ? el : en)[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
    return s;
  }, [lang]);

  const dayLabel = useCallback((k: DayKey, style: 'chip' | 'long' | 'short' | 'caption' | 'weekday' = 'long') => {
    const { week, day } = splitDay(k);
    const w = t(`week.${week}` as DictKey);
    if (style === 'weekday') return t(`dayShort.${day}` as DictKey);
    if (style === 'caption') return `${t(`day.${day}` as DictKey)} (${t('day.weekShort', { w })})`;
    if (style === 'chip') return `${w}·${t(`dayShort.${day}` as DictKey)}`;
    if (style === 'short') return `${t(`dayShort.${day}` as DictKey)} ${w}`;
    return `${t(`day.${day}` as DictKey)} · ${t('day.week', { w })}`;
  }, [t]);

  const patternLabel = useCallback((pattern: DayKey[]) => {
    const weeks = new Set(pattern.map((p) => splitDay(p).week));
    const days = [...new Set(pattern.map((p) => splitDay(p).day))]
      .sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b))
      .map((d) => t(`dayShort.${d}` as DictKey)).join('/');
    if (weeks.size === 1) return `${t('day.weekShort', { w: t(`week.${[...weeks][0]}` as DictKey) })} ${days}`;
    return days;
  }, [t]);

  const freqLabel = useCallback((f: Frequency, pattern: DayKey[]) => {
    const base = t(`freq.${f}` as DictKey);
    return pattern.length ? `${base} · ${patternLabel(pattern)}` : base;
  }, [t, patternLabel]);

  const tCode = useCallback((prefix: CodePrefix, code: string | undefined, fallback: string, vars?: Vars) => {
    const key = `${prefix}.${code}`;
    return code && hasKey(key) ? t(key, vars) : fallback;
  }, [t]);

  const errorText = useCallback((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    return e instanceof ApiError ? tCode('error', e.code, t('common.error', { msg })) : t('common.error', { msg });
  }, [t, tCode]);

  const value = useMemo(
    () => ({ lang, setLang: setLangState, t, dayLabel, freqLabel, patternLabel, tCode, errorText }),
    [lang, t, dayLabel, freqLabel, patternLabel, tCode, errorText],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useI18n outside provider');
  return c;
}
