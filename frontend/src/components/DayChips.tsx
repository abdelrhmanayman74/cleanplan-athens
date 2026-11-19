import { DAY_KEYS } from '../lib/days';
import { useI18n } from '../i18n/I18n';
import type { DictKey } from '../i18n/dict';
import { usePlanner } from '../state/PlannerContext';

const WEEKS = ['A', 'B'] as const;

export function DayChips() {
  const { day, setDay } = usePlanner();
  const { t, dayLabel } = useI18n();
  return (
    <div className="day-chips" role="tablist" aria-label="day" data-tour="days">
      <button role="tab" aria-selected={day === 'ALL'} className={`chip chip-all ${day === 'ALL' ? 'is-active' : ''}`} onClick={() => setDay('ALL')}>
        {t('day.allShort')}
      </button>
      {WEEKS.map((w) => (
        <div className="chip-group" role="group" key={w} aria-label={t('day.week', { w: t(`week.${w}` as DictKey) })}>
          <span className="chip-group-label">{t('day.weekGroup', { w: t(`week.${w}` as DictKey) })}</span>
          {DAY_KEYS.filter((k) => k.startsWith(w)).map((k) => (
            <button key={k} role="tab" aria-selected={day === k} title={dayLabel(k)} className={`chip ${day === k ? 'is-active' : ''}`} onClick={() => setDay(k)}>
              {dayLabel(k, 'weekday')}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
