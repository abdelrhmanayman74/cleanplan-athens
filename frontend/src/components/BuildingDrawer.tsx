import { useEffect } from 'react';
import { minutesToClock } from '../lib/days';
import { maskPhone } from '../lib/format';
import { useI18n } from '../i18n/I18n';
import { usePlanner } from '../state/PlannerContext';
import { Icon } from './Icon';
import { VisitGrid } from './VisitGrid';

export function BuildingDrawer() {
  const { selected, selectBuilding, buildingById, assignmentByBuilding, cleanerById, day, setFocus } = usePlanner();
  const { t, freqLabel } = useI18n();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && selectBuilding(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectBuilding]);

  const b = selected ? buildingById.get(selected) : null;
  if (!b) return null;
  const a = assignmentByBuilding.get(b.id);
  const c = a ? cleanerById.get(a.cleaner_id) : undefined;
  const pattern = a?.pattern ?? [];

  return (
    <aside className="drawer" aria-label={b.name}>
      <div className="drawer-head">
        <div>
          <div className="eyebrow">{b.neighborhood}{b.postcode ? ` · ${b.postcode}` : ''}</div>
          <h3 className="drawer-title">{b.name}</h3>
          <div className="muted small">{b.street} {b.number} · {t('building.floors', { n: b.floors })} · {b.has_lift ? t('building.lift') : t('building.noLift')}</div>
        </div>
        <button className="btn btn-ghost btn-icon" onClick={() => selectBuilding(null)} aria-label={t('building.close')}>
          <Icon name="x" size={18} />
        </button>
      </div>

      {b.isolated && (
        <div className="callout callout-warning small">
          <Icon name="alert" size={15} /> {t('building.isolated')}
        </div>
      )}

      <dl className="facts">
        <div>
          <dt>{t('building.frequency')}</dt>
          <dd><strong>{freqLabel(b.frequency, pattern)}</strong></dd>
        </div>
        <div>
          <dt>{t('building.service')}</dt>
          <dd>{t('building.perVisit', { n: b.service_minutes })}</dd>
        </div>
        <div>
          <dt>{t('building.window')}</dt>
          <dd>{b.time_window ? `${minutesToClock(b.time_window[0])}–${minutesToClock(b.time_window[1])}` : t('building.anyTime')}</dd>
        </div>
        {c && (
          <div>
            <dt>{t('building.cleaner')}</dt>
            <dd>
              <button className="btn btn-link btn-xs cleaner-chip" onClick={() => setFocus(c.id)}>
                <span className="dot" style={{ background: c.color }} /> {c.name}
              </button>
            </dd>
          </div>
        )}
        <div>
          <dt>{t('building.manager')}</dt>
          <dd>{b.manager.name}{b.manager.phone && b.manager.phone !== '—' ? ` · ${maskPhone(b.manager.phone)}` : null}</dd>
        </div>
        <div>
          <dt>{t('building.access')}</dt>
          <dd><Icon name="key" size={13} className="inline-icon" /> {b.access_note}</dd>
        </div>
      </dl>

      <div className="drawer-block">
        <div className="label">{t('building.tasks')}</div>
        <div className="tags">{b.tasks.map((x) => <span className="tag" key={x}>{x}</span>)}</div>
      </div>

      <div className="drawer-block">
        <div className="label">{t('building.pattern')}</div>
        <VisitGrid pattern={pattern} color={c?.color ?? 'var(--accent)'} highlight={day === 'ALL' ? null : day} />
        <p className="hint">{t('building.patternHint')}</p>
      </div>
    </aside>
  );
}
