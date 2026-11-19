import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import type { KPIs, PlanParams, WorkforceEstimate } from '../api/types';
import { fmtEur, fmtNumber, fmtPct, fmtUsd } from '../lib/format';
import { shiftStats } from '../lib/planStats';
import { useI18n } from '../i18n/I18n';
import { usePlanner } from '../state/PlannerContext';
import { Icon } from './Icon';
import { Skeleton } from './Skeleton';

/** A small ⓘ that reveals a sentence on hover, focus or tap. */
export function InfoTip({ text }: { text: string }) {
  return (
    <span className="info-tip" tabIndex={0} role="note" aria-label={text}>
      <Icon name="info" size={14} />
      <span className="info-pop" aria-hidden>{text}</span>
    </span>
  );
}

export function KpiGrid({ kpis, params, solveSeconds }: { kpis: KPIs; params: PlanParams; solveSeconds: number }) {
  const { t, lang } = useI18n();
  const ok = kpis.frequency_violations === 0;
  const shiftHours = (params.daily_minutes ?? 480) / 60;
  return (
    <>
      <div className="kpi-grid">
        <div className="kpi kpi-hero">
          <div className="kpi-label"><Icon name="users" size={14} /> {t('kpi.cleaners')}</div>
          <div className="kpi-answer">
            {t('kpi.staffAnswer', { n: kpis.cleaners, h: fmtNumber(shiftHours, lang, shiftHours % 1 ? 1 : 0) })}
            <InfoTip text={t('kpi.staffInfo', { lb: kpis.lower_bound_cleaners })} />
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label"><Icon name="walk" size={14} /> {t('kpi.walkHours')}</div>
          <div className="kpi-value">{fmtNumber(kpis.walk_minutes / 60, lang, 0)}<small>{t('unit.hoursLong')}</small></div>
        </div>
        <div className="kpi">
          <div className="kpi-label"><Icon name="gauge" size={14} /> {t('kpi.margin')}</div>
          <div className="kpi-value">{fmtPct(1 - kpis.utilization, lang)}</div>
          <div className="meter"><span style={{ width: `${Math.min(100, kpis.utilization * 100)}%` }} /></div>
          <div className="kpi-foot">{t('kpi.marginFoot')}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label"><Icon name="route" size={14} /> {t('kpi.avgWalk')}</div>
          <div className="kpi-value">{fmtNumber(kpis.avg_walk_per_visit, lang, 1)}<small>{t('kpi.minutes')}</small></div>
          <div className="kpi-foot">{t('kpi.visits', { n: fmtNumber(kpis.visits, lang) })}</div>
        </div>
        <div className={`kpi ${ok ? 'kpi-ok' : 'kpi-bad'}`}>
          <div className="kpi-label"><Icon name="calendar" size={14} /> {t('kpi.violations')}</div>
          <div className="kpi-value">
            {kpis.frequency_violations}
            {ok && <span className="ok-check"><Icon name="check" size={16} /></span>}
          </div>
          {ok && <div className="kpi-foot">{t('kpi.violationsOk')}</div>}
        </div>
      </div>
      <p className="kpi-statement">
        <Icon name="clock" size={14} className="inline-icon" /> {t('kpi.computedIn', { s: fmtNumber(Math.round(solveSeconds), lang) })}
        {kpis.unassigned > 0 && <span className="warn-text"> · {t('kpi.unassigned')}: {kpis.unassigned}</span>}
      </p>
    </>
  );
}

interface CompareRow {
  label: string;
  naive: number;
  ours: number;
  fmt: (n: number) => string;
  /** Draws a tick at this value on both bars (e.g. the shift length). */
  limit?: number;
}

/** Naive split vs our plan on the same buildings and the same team. Every metric: lower is better. */
export function BaselineCompare() {
  const { plan, baseline, buildingById } = usePlanner();
  const { t, lang } = useI18n();
  const ours = useMemo(() => (plan ? shiftStats(plan, buildingById) : null), [plan, buildingById]);
  if (!plan || !ours) return null;
  if (!baseline) return <div className="card"><Skeleton h={18} w="60%" /><div style={{ height: 10 }} /><Skeleton h={70} /></div>;

  const shift = plan.params.daily_minutes ?? 480;
  const hours = (m: number) => `${fmtNumber(m / 60, lang, 0)} ${t('unit.hoursLong')}`;
  const minutes = (m: number) => `${fmtNumber(m, lang, 0)}′`;
  const count = (n: number) => fmtNumber(n, lang, 0);
  const b = baseline;
  const rows: CompareRow[] = [
    { label: t('baseline.walk'), naive: b.kpis.walk_minutes, ours: plan.kpis.walk_minutes, fmt: hours },
    ...(b.overtime_routes != null ? [{ label: t('baseline.overtimeRoutes'), naive: b.overtime_routes, ours: ours.overtimeRoutes, fmt: count }] : []),
    ...(b.overtime_minutes != null ? [{ label: t('baseline.overtimeHours'), naive: b.overtime_minutes, ours: ours.overtimeMinutes, fmt: hours }] : []),
    ...(b.time_window_violations != null ? [{ label: t('baseline.windows'), naive: b.time_window_violations, ours: ours.windowViolations, fmt: count }] : []),
    { label: t('baseline.longest', { m: shift }), naive: b.kpis.max_route_minutes, ours: ours.longestDay, fmt: minutes, limit: shift },
  ];

  return (
    <div className="card" data-tour="baseline">
      <div className="card-head">
        <h3>{t('baseline.title')}</h3>
      </div>
      <p className="compare-team"><Icon name="users" size={14} /> {t('baseline.team', { n: plan.kpis.cleaners })}</p>
      <div className="compare">
        {rows.map((r) => {
          const max = Math.max(r.naive, r.ours, r.limit ?? 0) || 1;
          const eliminated = r.naive > 0 && r.fmt(r.ours) === r.fmt(0);
          const delta = r.naive ? (r.ours - r.naive) / r.naive : 0;
          const bar = (v: number, cls: string, name: string, strong?: boolean) => (
            <div className="cbar">
              <span className="cbar-name">{name}</span>
              <span className="cbar-track">
                <span className={`cbar-fill ${cls}`} style={{ width: `${(v / max) * 100}%` }} />
                {r.limit != null && <span className="cbar-limit" style={{ left: `${(r.limit / max) * 100}%` }} />}
              </span>
              <span className={`cbar-val ${strong ? 'strong' : ''}`}>{r.fmt(v)}</span>
            </div>
          );
          return (
            <div className="compare-row" key={r.label}>
              <div className="compare-label">
                <span>{r.label}</span>
                {eliminated ? (
                  <span className="badge badge-success"><Icon name="check" size={12} /> {t('baseline.none')}</span>
                ) : Math.abs(delta) >= 0.005 && (
                  <span className={`badge ${delta < 0 ? 'badge-success' : 'badge-warning'}`}>
                    {`${delta > 0 ? '+' : '−'}${fmtNumber(Math.abs(delta) * 100, lang, 0)}%`}
                  </span>
                )}
              </div>
              <div className="compare-bars">
                {bar(r.naive, 'cbar-naive', t('baseline.naive'))}
                {bar(r.ours, 'cbar-ours', t('baseline.ours'), true)}
              </div>
            </div>
          );
        })}
      </div>
      {b.overtime_minutes != null && b.overtime_minutes > ours.overtimeMinutes && (
        <OvertimeAvoided hours={(b.overtime_minutes - ours.overtimeMinutes) / 60} />
      )}
      <p className="hint">{t('baseline.desc')}</p>
    </div>
  );
}

const MONTH_PER_HORIZON = 365 / 12 / 14; // the plan covers 2 weeks

/** Overtime the naive split would need, in €/month at an editable hourly cost (example on demo data). */
function OvertimeAvoided({ hours }: { hours: number }) {
  const { t, lang } = useI18n();
  const [rate, setRate] = useState(10);
  const perMonth = hours * MONTH_PER_HORIZON;
  return (
    <div className="overtime-avoided">
      <div className="ot-top">
        <span>{t('overtime.title')}</span>
        <strong className="ok-text">{fmtEur(perMonth * rate, lang)}{t('overtime.perMonth')}</strong>
      </div>
      <div className="small muted ot-calc">
        {t('overtime.calc', { h: fmtNumber(perMonth, lang) })}
        <label className="ot-rate">
          <input type="number" min={1} max={100} step={0.5} value={rate} onChange={(e) => setRate(Math.max(0, +e.target.value || 0))} aria-label={t('overtime.rate')} />
          €/{t('overtime.hour')}
        </label>
      </div>
      <div className="small muted">{t('overtime.example')}</div>
    </div>
  );
}

export function WorkforcePanel() {
  const { api, plan, replan, replanning, resetPlan, replanned, showToast } = usePlanner();
  const { t, lang, dayLabel, errorText } = useI18n();
  const planShift = (plan?.params.daily_minutes ?? 480) / 60;
  const planTarget = plan?.params.target_utilization ?? 0.85;
  const [hours, setHours] = useState(planShift);
  const [target, setTarget] = useState(planTarget);
  const [est, setEst] = useState<WorkforceEstimate | null>(null);
  const [base, setBase] = useState<WorkforceEstimate | null>(null);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const reqId = useRef(0);

  // the sliders start from the current plan's shift and target
  useEffect(() => { setHours(planShift); setTarget(planTarget); }, [plan?.id, planShift, planTarget]);
  // the analytic estimate at the plan's own settings, to calibrate estimates for other settings
  useEffect(() => {
    if (!api || !plan) return;
    api.workforce(Math.round(planShift * 60), planTarget).then(setBase).catch(() => {});
  }, [api, plan, planShift, planTarget]);

  useEffect(() => {
    if (!api) return;
    const id = ++reqId.current;
    setLoading(true);
    const h = window.setTimeout(() => {
      api.workforce(Math.round(hours * 60), target)
        .then((e) => { if (id === reqId.current) setEst(e); })
        .catch(() => {})
        .finally(() => { if (id === reqId.current) setLoading(false); });
    }, 180);
    return () => window.clearTimeout(h);
  }, [api, hours, target, plan?.id]);

  useEffect(() => {
    if (!replanning) { setElapsed(0); return; }
    const t0 = Date.now();
    const h = window.setInterval(() => setElapsed((Date.now() - t0) / 1000), 200);
    return () => window.clearInterval(h);
  }, [replanning]);

  const run = async () => {
    try {
      const p = await replan({ daily_minutes: Math.round(hours * 60), target_utilization: target });
      showToast(t('workforce.replanDone', { s: fmtNumber(p.solve_seconds, lang, 1), n: p.kpis.cleaners }), 'success');
    } catch (e) {
      // 429: another visitor's solve is running (one at a time on the shared demo server)
      showToast(errorText(e), e instanceof ApiError && e.status === 429 ? 'warning' : 'error');
    }
  };

  // One staffing answer. At the plan's own settings it is the solved number; otherwise the quick
  // estimate scaled by how far the estimate was from the solve at the plan's settings.
  const atPlan = Math.abs(hours - planShift) < 1e-6 && Math.abs(target - planTarget) < 1e-6;
  const targets = api?.features.replanTargets;
  const targetUnavailable = !!targets && !targets.some((x) => Math.abs(x - target) < 1e-6);
  const solved = plan?.kpis.cleaners ?? 0;
  const estimate = est && base?.estimate ? Math.round((est.estimate * solved) / base.estimate) : est?.estimate;
  const hLabel = fmtNumber(hours, lang, hours % 1 ? 1 : 0);
  return (
    <div className="card" data-tour="workforce">
      <div className="card-head"><h3>{t('workforce.title')}</h3></div>
      <label className="slider">
        <span className="slider-top"><span>{t('workforce.shift')}</span><strong>{t('workforce.hours', { n: hLabel })}</strong></span>
        <input type="range" min={4} max={9} step={0.5} value={hours} onChange={(e) => setHours(+e.target.value)} disabled={replanning} />
        <span className="slider-scale"><span>4</span><span>9</span></span>
      </label>
      <label className="slider">
        <span className="slider-top"><span>{t('workforce.target')}</span><strong>{fmtPct(target, lang)}</strong></span>
        <input type="range" min={0.6} max={0.95} step={0.01} value={target} onChange={(e) => setTarget(+e.target.value)} disabled={replanning} />
        <span className="slider-scale"><span>60%</span><span>95%</span></span>
      </label>
      <div className={`wf-answer ${loading ? 'is-loading' : ''}`} aria-live="polite">
        {atPlan
          ? t('workforce.answer', { n: solved, h: hLabel })
          : estimate != null ? t('workforce.answerEst', { n: estimate, h: hLabel }) : '–'}
        {est && <InfoTip text={t('workforce.info', { lb: est.lower_bound, day: dayLabel(est.busiest_day), bh: fmtNumber(est.busiest_day_load / 60, lang, 0) })} />}
      </div>
      {!atPlan && <p className="hint">{t('workforce.estNote')}</p>}
      {targetUnavailable && <p className="hint warn-text">{t('error.static_replan', { p: fmtPct(targets![0], lang) })}</p>}
      <div className="row gap-sm wrap">
        <button className="btn btn-primary" onClick={run} disabled={replanning || !api || atPlan || targetUnavailable}>
          {replanning ? <span className="spinner" /> : <Icon name="reset" size={15} />}
          {replanning ? t('workforce.replanning') : t('workforce.replan')}
        </button>
        {replanned && !replanning && (
          <button className="btn btn-ghost" onClick={() => resetPlan()}>{t('workforce.resetPlan')}</button>
        )}
      </div>
      {replanning ? (
        <div className="progress" aria-live="polite">
          <div className="progress-track"><span className="progress-fill" style={{ width: `${Math.min(96, (1 - Math.exp(-elapsed / 18)) * 100)}%` }} /></div>
          <span className="small muted">{t('workforce.elapsed', { s: fmtNumber(elapsed, lang, 0) })}</span>
        </div>
      ) : (
        <p className="hint">{t('workforce.replanHint')}</p>
      )}
    </div>
  );
}

export function CostCard() {
  const { cost } = usePlanner();
  const { t, lang } = useI18n();
  if (!cost) return <div className="card"><Skeleton h={18} w="50%" /><div style={{ height: 10 }} /><Skeleton h={60} /></div>;
  const max = Math.max(cost.naive_cost_usd, cost.our_cost_usd) || 1;
  return (
    <div className="card">
      <div className="card-head"><h3>{t('cost.title')}</h3></div>
      <div className="cost-rows">
        <div className="cost-row">
          <div className="cost-top"><span>{t('cost.naive')}</span><strong>{fmtUsd(cost.naive_cost_usd, lang)}</strong></div>
          <div className="cbar-track"><span className="cbar-fill cbar-naive" style={{ width: `${(cost.naive_cost_usd / max) * 100}%` }} /></div>
          <div className="small muted">{t('cost.elements', { n: fmtNumber(cost.naive_elements, lang) })}</div>
        </div>
        <div className="cost-row">
          <div className="cost-top"><span>{t('cost.ours')}</span><strong className="accent-num">{fmtUsd(cost.our_cost_usd, lang)}</strong></div>
          <div className="cbar-track"><span className="cbar-fill cbar-ours" style={{ width: `${Math.max(1.5, (cost.our_cost_usd / max) * 100)}%` }} /></div>
          <div className="small muted">{t('cost.elements', { n: fmtNumber(cost.our_elements, lang) })}</div>
        </div>
      </div>
      <p className="hint">{t('cost.free', { n: fmtNumber(cost.free_elements_per_month, lang), p: fmtUsd(cost.price_per_1000_usd, lang) })}. {t('cost.perMonth')}.</p>
      <p className="hint">{t('cost.ourNote')}</p>
      <p className="hint fine">{cost.note}</p>
    </div>
  );
}

export function ProviderCard() {
  const { provider } = usePlanner();
  const { t, lang } = useI18n();
  if (!provider) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h3>{t('provider.title')}</h3>
        <span className="badge badge-success">{t('provider.mad', { n: fmtNumber(provider.mean_abs_diff_min, lang, 1) })}</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>{t('provider.from')}</th><th>{t('provider.to')}</th><th className="num">OSRM</th><th className="num">Google</th></tr></thead>
          <tbody>
            {provider.pairs.slice(0, 8).map((p, i) => (
              <tr key={i}><td>{p.from}</td><td>{p.to}</td><td className="num">{p.osrm_min}′</td><td className="num">{p.google_min}′</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint fine">{provider.note}</p>
    </div>
  );
}

export function KpiTab() {
  const { plan } = usePlanner();
  const { t } = useI18n();
  if (!plan) return null;
  return (
    <div className="stack">
      <section data-tour="kpis">
        <div className="section-head"><h2>{t('kpi.title')}</h2></div>
        <KpiGrid kpis={plan.kpis} params={plan.params} solveSeconds={plan.solve_seconds} />
      </section>
      <BaselineCompare />
      <WorkforcePanel />
      <CostCard />
      <ProviderCard />
    </div>
  );
}
