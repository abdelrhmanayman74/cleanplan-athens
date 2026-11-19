import { Link } from 'react-router-dom';
import { useMemo, useState } from 'react';
import { DAY_KEYS } from '../lib/days';
import { fmtHM } from '../lib/format';
import { useI18n } from '../i18n/I18n';
import { routeKey, usePlanner } from '../state/PlannerContext';
import { Icon } from './Icon';
import { StartGlyph } from './StartGlyph';

/** "Εξαγωγή σε Excel": the 2-week schedule of this session, one sheet per week. */
function ExportButton() {
  const { api, showToast } = usePlanner();
  const { t, errorText } = useI18n();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!api) return;
    setBusy(true);
    try {
      const url = URL.createObjectURL(await api.exportSchedule());
      const a = Object.assign(document.createElement('a'), { href: url, download: 'cleanplan_schedule.xlsx' });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      showToast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn btn-link btn-xs" onClick={run} disabled={busy}>
      {busy ? <span className="spinner" /> : <Icon name="download" size={13} />} {t('export.excel')}
    </button>
  );
}

function LoadLegend() {
  const { t } = useI18n();
  return (
    <div className="load-legend small muted">
      <span><i className="lg-work" /> {t('cleaners.work')}</span>
      <span><i className="lg-walk" /> {t('cleaners.walk')}</span>
      <span><i className="lg-break" /> {t('cleaners.break')}</span>
    </div>
  );
}

export function CleanerList() {
  const { api, cleaners, plan, day, routeByKey, focus, setFocus, scenario, setHoverCleaner, openAbsence } = usePlanner();
  const { t, dayLabel, lang } = useI18n();
  const [expanded, setExpanded] = useState(false); // phone only: the list starts collapsed

  const buildingCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of plan?.assignments ?? []) m.set(a.cleaner_id, (m.get(a.cleaner_id) ?? 0) + 1);
    return m;
  }, [plan]);

  const received = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of scenario?.result.changes ?? []) if (c.to_cleaner) m.set(c.to_cleaner, (m.get(c.to_cleaner) ?? 0) + 1);
    return m;
  }, [scenario]);

  const rows = cleaners.map((c) => {
    let walk = 0, service = 0, total = 0, stops = 0, n = 0;
    const days = day === 'ALL' ? DAY_KEYS : [day];
    for (const d of days) {
      const r = routeByKey.get(`${c.id}|${d}`);
      if (!r || !r.stops.length) continue;
      walk += r.walk_minutes; service += r.service_minutes; total += r.total_minutes; stops += r.stops.length; n++;
    }
    const div = day === 'ALL' ? Math.max(1, n) : 1;
    const firstDay = day !== 'ALL' && routeByKey.get(`${c.id}|${day}`)?.stops.length
      ? day
      : DAY_KEYS.find((d) => routeByKey.get(`${c.id}|${d}`)?.stops.length) ?? 'A-Mon';
    return { c, walk: walk / div, service: service / div, total: total / div, stops: Math.round(stops / div), hasRoute: n > 0, firstDay };
  });

  const scenarioDay = scenario?.kind === 'absence' ? scenario.day : null;

  return (
    <section className={`cleaners ${expanded ? 'is-expanded' : ''}`} data-tour="cleaners">
      <button className="btn btn-secondary btn-block cleaners-toggle" onClick={() => setExpanded(true)}>
        {t('cleaners.title')} ({cleaners.length}) <Icon name="chevronRight" size={14} />
      </button>
      <div className="section-head">
        <h2>{t('cleaners.title')}</h2>
        <span className="muted small">{t('cleaners.count', { n: cleaners.length })}</span>
        {focus
          ? <button className="btn btn-link btn-xs" onClick={() => setFocus(null)}>{t('cleaners.clearFocus')}</button>
          : <ExportButton />}
      </div>
      <p className="hint">{day === 'ALL' ? t('cleaners.hintAll') : t('cleaners.hintDay', { day: dayLabel(day, 'caption') })}</p>
      <LoadLegend />
      <ul className="cleaner-list" onMouseLeave={() => setHoverCleaner(null)}>
        {rows.map(({ c, walk, service, total, stops, hasRoute, firstDay }, idx) => {
          const shift = c.daily_minutes || 480;
          const isAbsent = scenario?.kind === 'absence' && scenario.cleanerId === c.id && (day === 'ALL' || day === scenarioDay);
          const changed = scenario && day !== 'ALL' && scenario.changedKeys.has(routeKey({ cleaner_id: c.id, day_key: day }));
          const unchanged = scenario && day !== 'ALL' && hasRoute && !changed && !isAbsent;
          const brk = Math.max(0, total - walk - service);
          const pct = (v: number) => `${Math.min(100, (v / shift) * 100)}%`;
          const absenceDay = day !== 'ALL' && hasRoute ? day : firstDay;
          return (
            <li
              key={c.id}
              className={`cleaner-row ${focus === c.id ? 'is-focus' : ''} ${focus && focus !== c.id ? 'is-dim' : ''} ${unchanged ? 'is-unchanged' : ''}`}
              onMouseEnter={() => setHoverCleaner(c.id)}
            >
              <button className="cleaner-main" onClick={() => setFocus(focus === c.id ? null : c.id)} title={t('cleaners.focusHint')} aria-pressed={focus === c.id}>
                <span className="dot dot-lg" style={{ background: c.color }} />
                <span className="cleaner-text">
                  <span className="cleaner-name">
                    {c.name}
                    {isAbsent && <span className="badge badge-warning">{t('cleaners.absent')}</span>}
                    {changed && !isAbsent && received.get(c.id) && scenario?.kind === 'absence' && (
                      <span className="badge badge-accent">{t('cleaners.received', { n: received.get(c.id)! })}</span>
                    )}
                    {changed && scenario?.kind === 'insert' && <span className="badge badge-accent">+1</span>}
                    {unchanged && <span className="badge badge-muted">{t('cleaners.unchanged')}</span>}
                  </span>
                  <span className="cleaner-sub">
                    <span className="cleaner-start"><StartGlyph start={c.start} /> {c.start.label}</span>
                    <span className="muted">{hasRoute ? t('cleaners.stops', { n: stops }) : t('cleaners.buildings', { n: buildingCount.get(c.id) ?? 0 })}</span>
                  </span>
                  <span className="load-bar" aria-hidden>
                    {hasRoute && !isAbsent ? (
                      <>
                        <span className="seg seg-work" style={{ width: pct(service), background: c.color }} />
                        <span className="seg seg-walk" style={{ width: pct(walk), background: c.color }} />
                        <span className="seg seg-break" style={{ width: pct(brk) }} />
                      </>
                    ) : null}
                  </span>
                </span>
                <span className="cleaner-mins">
                  {hasRoute && !isAbsent
                    ? t('cleaners.of', { a: fmtHM(total, lang), b: fmtHM(shift, lang) })
                    : <span className="muted small">{t('cleaners.noRoute')}</span>}
                </span>
              </button>
              <span className="cleaner-actions">
                <Link
                  className="btn btn-link btn-xs"
                  to={`/sheet/${encodeURIComponent(c.id)}/${encodeURIComponent(firstDay)}${api?.shareQuery() ?? ''}`}
                  aria-label={`${t('cleaners.sheet')} · ${c.name}`}
                  data-tour={idx === 0 ? 'sheet-btn' : undefined}
                >
                  {t('cleaners.sheet')} →
                </Link>
                {hasRoute && !scenario && (
                  <button className="btn btn-link btn-xs muted-link" onClick={() => openAbsence(c.id, absenceDay)}>
                    {t('cleaners.markAbsent')}
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
