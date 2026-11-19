import type { DayKey } from '../api/types';
import { WEEKDAYS } from '../lib/days';
import { useI18n } from '../i18n/I18n';
import type { DictKey } from '../i18n/dict';

/** 2×5 calendar (weeks A/B × Mon–Fri) with the visit days filled in. */
export function VisitGrid({ pattern, color, highlight }: { pattern: DayKey[]; color: string; highlight?: DayKey | null }) {
  const { t } = useI18n();
  const set = new Set(pattern);
  return (
    <div className="visit-grid" role="table">
      <div className="vg-row vg-head" role="row">
        <span role="columnheader" />
        {WEEKDAYS.map((d) => <span key={d} role="columnheader">{t(`dayShort.${d}` as DictKey)}</span>)}
      </div>
      {(['A', 'B'] as const).map((w) => (
        <div className="vg-row" role="row" key={w}>
          <span className="vg-week" role="rowheader">{t('day.weekShort', { w: t(`week.${w}` as DictKey) })}</span>
          {WEEKDAYS.map((d) => {
            const k = `${w}-${d}`;
            const on = set.has(k);
            return (
              <span
                key={k} role="cell" aria-label={on ? '✓' : '–'}
                className={`vg-cell ${on ? 'on' : ''} ${highlight === k ? 'is-today' : ''}`}
                style={on ? { background: color, borderColor: color } : undefined}
              >
                {on ? '✓' : ''}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}
