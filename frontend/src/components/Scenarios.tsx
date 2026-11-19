import { useEffect, useMemo, useState } from 'react';
import type { DayKey, Frequency } from '../api/types';
import { DAY_KEYS } from '../lib/days';
import { fmtApprox, fmtNumber, fmtSigned } from '../lib/format';
import { firstName, withArticle } from '../lib/greek';
import { splitDay } from '../lib/days';
import { roundToTotal } from '../lib/planStats';
import { absenceSummary, insertSummary, walkDelta } from '../lib/summaries';
import { useI18n } from '../i18n/I18n';
import type { DictKey } from '../i18n/dict';
import { draftToNewBuilding, usePlanner } from '../state/PlannerContext';
import { Icon } from './Icon';

/** "Δοκιμάστε: η Μαρία λείπει την Τρίτη": runs the server's suggested showcase absence in one click. */
export function TryAbsenceButton({ className = 'btn btn-primary btn-block', onDone }: { className?: string; onDone?: () => void }) {
  const { api, meta, cleanerById, applyAbsence, showToast, scenario, replanned } = usePlanner();
  const { t, lang, errorText } = useI18n();
  const [busy, setBusy] = useState(false);
  const demo = meta?.demo_absence;
  const c = demo ? cleanerById.get(demo.cleaner_id) : undefined;
  if (!demo || !c || replanned || (scenario && api?.features.absenceOnStandardPlanOnly)) return null;
  const weekday = splitDay(demo.day_key).day;
  const label = t('absence.try', {
    who: lang === 'el' ? withArticle(c.name) : firstName(c.name),
    day: t(`dayOn.${weekday}` as DictKey),
  });
  const run = async () => {
    setBusy(true);
    try {
      await applyAbsence(demo.cleaner_id, demo.day_key);
      onDone?.();
    } catch (e) {
      showToast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className={className} onClick={run} disabled={busy || scenario?.kind === 'absence'} data-tour="try-absence">
      {busy ? <span className="spinner" /> : <Icon name="play" size={12} fill />} {label}
    </button>
  );
}

export function AbsenceScenario() {
  const { api, cleaners, routeByKey, applyAbsence, showToast, day, scenario, absenceDraft, meta, replanned } = usePlanner();
  const { t, dayLabel, errorText } = useI18n();
  const [cid, setCid] = useState(meta?.demo_absence?.cleaner_id ?? '');
  const [d, setD] = useState<DayKey>(meta?.demo_absence?.day_key ?? (day === 'ALL' ? 'A-Mon' : day));
  const [busy, setBusy] = useState(false);
  const hasRoute = !!cid && !!routeByKey.get(`${cid}|${d}`)?.stops.length;
  // the static build has absences precomputed for the standard plan only
  const standardOnly = !!api?.features.absenceOnStandardPlanOnly && (replanned || scenario?.kind === 'insert');

  // "Λείπει…" on a cleaner row pre-fills the form
  useEffect(() => {
    if (!absenceDraft) return;
    setCid(absenceDraft.cleanerId);
    setD(absenceDraft.day);
  }, [absenceDraft]);

  const run = async () => {
    setBusy(true);
    try {
      await applyAbsence(cid, d); // the result card and the map tell the story; no toast
    } catch (e) {
      showToast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card" data-tour="absence">
      <div className="card-head"><h3><Icon name="users" size={16} /> {t('absence.title')}</h3></div>
      <p className="hint">{t('absence.desc')}</p>
      <div className="form-stack">
        <label className="field">
          <span>{t('absence.cleaner')}</span>
          <select value={cid} onChange={(e) => setCid(e.target.value)} disabled={busy}>
            <option value="">{t('absence.choose')}</option>
            {cleaners.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>{t('absence.day')}</span>
          <select value={d} onChange={(e) => setD(e.target.value)} disabled={busy}>
            {DAY_KEYS.map((k) => (
              <option key={k} value={k} disabled={!!cid && !routeByKey.get(`${cid}|${k}`)?.stops.length}>{dayLabel(k)}</option>
            ))}
          </select>
        </label>
      </div>
      {cid && !hasRoute && <p className="hint warn-text">{t('absence.noRoute')}</p>}
      {standardOnly && <p className="hint warn-text">{t('error.absence_standard_only')}</p>}
      <button className="btn btn-primary btn-block" disabled={!hasRoute || busy || scenario?.kind === 'absence' || standardOnly} onClick={run}>
        {busy ? <span className="spinner" /> : <Icon name="check" size={15} />}
        {busy ? t('absence.running') : t('absence.confirm')}
      </button>
    </div>
  );
}

const FREQS: Frequency[] = ['3w', '2w', '1w', 'biweekly'];

export function NewBuildingScenario() {
  const { insert, setInsert, findCandidates, cancelInsert, applyInsert, cleanerById, showToast, setDay, day, setTab } = usePlanner();
  const { t, lang, patternLabel, errorText } = useI18n();
  const [committing, setCommitting] = useState<number | null>(null);

  const find = async () => {
    try { await findCandidates(); } catch (e) { showToast(errorText(e), 'error'); }
  };
  const commit = async (i: number) => {
    const c = insert.candidates?.[i];
    const nb = draftToNewBuilding(insert);
    if (!c || !nb) return;
    setCommitting(i);
    try {
      await applyInsert(nb, c); // summarised in the result card
    } catch (e) {
      showToast(errorText(e), 'error');
    } finally {
      setCommitting(null);
    }
  };

  return (
    <div className="card" data-tour="newbuilding">
      <div className="card-head"><h3><Icon name="building" size={16} /> {t('insert.title')}</h3></div>
      <p className="hint">{t('insert.desc')}</p>

      <div className="row gap-sm wrap">
        <button
          className={`btn ${insert.picking ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => { setInsert({ picking: !insert.picking }); setTab('scenarios'); }}
          aria-pressed={insert.picking}
        >
          <Icon name="pin" size={15} /> {insert.picking ? t('insert.dropping') : t('insert.drop')}
        </button>
        {(insert.pin || insert.picking) && <button className="btn btn-ghost" onClick={cancelInsert}>{t('insert.cancel')}</button>}
      </div>
      {insert.pin && (
        <p className="small muted"><Icon name="pin" size={12} className="inline-icon" /> {insert.address ?? t('insert.pinAt', { lat: insert.pin.lat.toFixed(5), lng: insert.pin.lng.toFixed(5) })}</p>
      )}

      {insert.pin && (
        <>
          <div className="form-grid">
            <label className="field field-wide">
              <span>{t('insert.name')}</span>
              <input value={insert.name} placeholder={t('insert.namePh')} onChange={(e) => setInsert({ name: e.target.value })} />
            </label>
            <label className="field">
              <span>{t('insert.frequency')}</span>
              <select value={insert.frequency} onChange={(e) => setInsert({ frequency: e.target.value as Frequency, candidates: null })}>
                {FREQS.map((f) => <option key={f} value={f}>{t(`freq.${f}` as DictKey)}</option>)}
              </select>
            </label>
            <label className="field">
              <span>{t('insert.service')}</span>
              <input type="number" min={15} max={75} step={5} value={insert.service_minutes}
                onChange={(e) => setInsert({ service_minutes: Math.max(15, Math.min(75, +e.target.value || 15)), candidates: null })} />
            </label>
            <label className="check field-wide">
              <input type="checkbox" checked={insert.morning} onChange={(e) => setInsert({ morning: e.target.checked, candidates: null })} />
              <span>{t('insert.morning')}</span>
            </label>
          </div>
          <button className="btn btn-primary btn-block" onClick={find} disabled={insert.loading}>
            {insert.loading ? <span className="spinner" /> : <Icon name="search" size={15} />}
            {insert.loading ? t('insert.finding') : t('insert.find')}
          </button>
        </>
      )}

      {insert.candidates && (
        <div className="candidates">
          <div className="label">{t('insert.candidates')}</div>
          {insert.candidates.length === 0 && <p className="hint">{t('insert.none')}</p>}
          {insert.candidates.map((c, i) => {
            const cl = cleanerById.get(c.cleaner_id);
            return (
              <div
                key={`${c.cleaner_id}-${c.day_keys.join()}`}
                className={`candidate ${insert.hover === i ? 'is-hover' : ''} ${c.feasible ? '' : 'is-infeasible'}`}
                onMouseEnter={() => { setInsert({ hover: i }); if (day === 'ALL' || !c.day_keys.includes(day)) setDay(c.day_keys[0]); }}
                onMouseLeave={() => setInsert({ hover: null })}
                onFocus={() => setInsert({ hover: i })}
              >
                <span className="cand-rank">{i + 1}</span>
                <div className="cand-main">
                  <div className="cand-name"><span className="dot" style={{ background: cl?.color }} /> {cl?.name ?? c.cleaner_id}</div>
                  <div className="cand-meta">
                    <span className="tag">{patternLabel(c.day_keys)}</span>
                    <span>{t('insert.addedWalk', { n: fmtNumber(c.added_walk_minutes, lang) })}</span>
                    <span className={c.feasible ? 'ok-text' : 'warn-text'}>{c.feasible ? t('insert.slack', { n: fmtApprox(c.slack_after, lang) }) : t('insert.infeasible')}</span>
                  </div>
                </div>
                <button className="btn btn-primary btn-sm" disabled={!c.feasible || committing !== null} onClick={() => commit(i)}>
                  {committing === i ? <span className="spinner" /> : null}{committing === i ? t('insert.committing') : t('insert.commit')}
                </button>
              </div>
            );
          })}
          {insert.candidates.length > 0 && <p className="hint">{t('insert.hoverHint')}</p>}
        </div>
      )}
    </div>
  );
}

export function ScenarioResult() {
  const { scenario, resetPlan, cleanerById, buildingById, showToast } = usePlanner();
  const { t, lang, dayLabel, patternLabel, tCode, errorText } = useI18n();
  const [busy, setBusy] = useState(false);
  // Per-cleaner walking change measured on the routes (after − before), rounded so the lines add up
  // to the headline delta. Receiving routes are re-sequenced, so the per-visit `added_walk` of the
  // insertion step would not add up.
  const perCleaner = useMemo(() => {
    if (!scenario) return [];
    const received = new Map<string, number>();
    for (const c of scenario.result.changes) if (c.to_cleaner) received.set(c.to_cleaner, (received.get(c.to_cleaner) ?? 0) + 1);
    const walk = roundToTotal(scenario.walkByCleaner, walkDelta(scenario.result));
    const ids = new Set([...received.keys(), ...walk.keys()]);
    return [...ids]
      .map((id) => ({ id, n: received.get(id) ?? 0, walk: walk.get(id) ?? 0 }))
      .sort((a, b) => b.n - a.n || b.walk - a.walk);
  }, [scenario]);
  if (!scenario) return null;
  const r = scenario.result;
  const before = r.kpis_before, after = r.kpis_after;
  const summary = scenario.kind === 'absence'
    ? absenceSummary(r, cleanerById.get(scenario.cleanerId), t, lang)
    : insertSummary(r, cleanerById.get(scenario.candidate.cleaner_id), patternLabel(scenario.candidate.day_keys), t, lang);
  const newUnassigned = r.plan.unassigned.filter((u) => scenario.kind !== 'absence' || u.day_key === scenario.day);

  const reset = async () => {
    setBusy(true);
    try { await resetPlan(); } catch (e) { showToast(errorText(e), 'error'); } finally { setBusy(false); }
  };

  return (
    <div className="card card-accent" aria-live="polite" data-tour="scenario-result">
      <div className="card-head">
        <span className="eyebrow">{t('scenario.active')} · {scenario.kind === 'absence' ? `${t('absence.title')} · ${dayLabel(scenario.day)}` : t('insert.title')}</span>
      </div>
      <p className="scenario-summary">{summary}</p>
      <p className="small muted">{t('absence.changedRoutes', { n: r.plan.routes.length - r.untouched_routes, u: r.untouched_routes })}</p>

      <div className="delta-grid">
        <Delta label={t('scenario.walkDelta')} a={before.walk_minutes} b={after.walk_minutes} unit="′" lang={lang} />
        <Delta label={t('scenario.maxRoute')} a={before.max_route_minutes} b={after.max_route_minutes} unit="′" lang={lang} />
        <Delta label={t('scenario.unassigned')} a={before.unassigned} b={after.unassigned} unit="" lang={lang} warnUp />
      </div>

      {perCleaner.length > 0 && (
        <>
          <div className="label">{t('scenario.walkBreakdown', { total: fmtSigned(Math.round(walkDelta(r)), lang) })}</div>
          <ul className="moved-list">
            {perCleaner.map(({ id, n, walk }) => {
              const c = cleanerById.get(id);
              const absent = scenario.kind === 'absence' && id === scenario.cleanerId;
              return (
                <li key={id}>
                  <span className="dot" style={{ background: c?.color }} />
                  <span className="grow">{c?.name}{absent && <> <span className="badge badge-warning">{t('cleaners.absent')}</span></>}</span>
                  <span className="small muted">
                    {n > 0 && <>{t('cleaners.received', { n })} · </>}
                    {t('scenario.walkRoute', { n: fmtSigned(walk, lang) })}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {scenario.kind === 'absence' && (
        newUnassigned.length ? (
          <div className="callout callout-warning">
            <strong>{t('absence.unassignedTitle', { n: newUnassigned.length })}</strong>
            <ul className="plain-list">
              {newUnassigned.map((u) => {
                const b = buildingById.get(u.building_id);
                return <li key={`${u.building_id}-${u.day_key}`}>{b ? `${b.street} ${b.number}, ${b.neighborhood}` : u.building_id} · <span className="small">{tCode('reason', u.reason_code, u.reason)}</span></li>;
              })}
            </ul>
          </div>
        ) : (
          <p className="small ok-text"><Icon name="check" size={14} className="inline-icon" /> {t('absence.unassignedNone')}</p>
        )
      )}

      <button className="btn btn-secondary btn-block" onClick={reset} disabled={busy}>
        {busy ? <span className="spinner" /> : <Icon name="reset" size={15} />} {busy ? t('scenario.resetting') : t('scenario.reset')}
      </button>
    </div>
  );
}

function Delta({ label, a, b, unit, lang, warnUp }: { label: string; a: number; b: number; unit: string; lang: string; warnUp?: boolean }) {
  const d = Math.round(b - a);
  const cls = d === 0 ? 'muted' : warnUp ? (d > 0 ? 'warn-text' : 'ok-text') : 'strong';
  return (
    <div className="delta">
      <span className="delta-label">{label}</span>
      <span className={`delta-value ${cls}`}>{fmtSigned(d, lang)}{unit}</span>
      <span className="delta-sub">{fmtNumber(Math.round(a), lang)} → {fmtNumber(Math.round(b), lang)}</span>
    </div>
  );
}

export function ScenariosTab() {
  return (
    <div className="stack">
      <ScenarioResult />
      <AbsenceScenario />
      <NewBuildingScenario />
    </div>
  );
}
