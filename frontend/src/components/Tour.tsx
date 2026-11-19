import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useI18n } from '../i18n/I18n';
import type { DictKey } from '../i18n/dict';
import { usePlanner } from '../state/PlannerContext';
import { Icon } from './Icon';

interface Step { target: string; n: 1 | 2 | 3 | 4 | 5 }
const STEPS: Step[] = [
  { target: 'map', n: 1 },
  { target: 'baseline', n: 2 },
  { target: 'absence', n: 3 },
  { target: 'newbuilding', n: 4 },
  { target: 'sheet-btn', n: 5 },
];
const TOUR_DAY = 'A-Tue';

export function Tour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const p = usePlanner();
  const { t, errorText } = useI18n();
  const navigate = useNavigate();
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [busy, setBusy] = useState(false);
  const base = STEPS[i];
  const step = base.n === 3 && p.scenario?.kind === 'absence' ? { ...base, target: 'scenario-result' } : base;

  // prepare the UI for each step
  useEffect(() => {
    if (!open) return;
    p.selectBuilding(null);
    if (step.n === 1) { p.setTab('plan'); p.setFocus(null); if (!p.scenario) p.setDay(TOUR_DAY); }
    if (step.n === 2) p.setTab('kpi');
    if (step.n === 3 || step.n === 4) p.setTab('scenarios');
    if (step.n === 5) p.setTab('plan');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, i]);

  useEffect(() => { if (open) setI(0); }, [open]);

  // track the highlighted element
  useLayoutEffect(() => {
    if (!open) return;
    let raf = 0, scrolled = false;
    const tick = () => {
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (el) {
        if (!scrolled) { el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); scrolled = true; }
        const r = el.getBoundingClientRect();
        setRect((prev) => (prev && Math.abs(prev.top - r.top) < 0.5 && Math.abs(prev.left - r.left) < 0.5 && Math.abs(prev.height - r.height) < 0.5 && Math.abs(prev.width - r.width) < 0.5 ? prev : r));
      } else setRect(null);
      raf = window.setTimeout(tick, 120) as unknown as number;
    };
    tick();
    return () => window.clearTimeout(raf);
  }, [open, step.target]);

  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setI((x) => Math.min(STEPS.length - 1, x + 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);

  const example = useCallback(async () => {
    setBusy(true);
    try {
      if (step.n === 3) {
        if (p.scenario) await p.resetPlan();
        // the same showcase as the "Δοκιμάστε" button; fall back to a busy route on another plan
        const routes = p.routesByDay.get(TOUR_DAY) ?? [];
        const demo = p.meta?.demo_absence
          ?? (() => {
            const r = routes.slice().sort((a, b) => b.stops.length - a.stops.length)[Math.min(2, routes.length - 1)];
            return r ? { cleaner_id: r.cleaner_id, day_key: TOUR_DAY } : null;
          })();
        if (demo) await p.applyAbsence(demo.cleaner_id, demo.day_key);
      } else if (step.n === 4) {
        if (p.scenario) await p.resetPlan();
        p.setInsert({ frequency: '2w', service_minutes: 35 });
        await p.findCandidates({ lat: 37.96905, lng: 23.74415 });
      } else if (step.n === 5) {
        const c = p.cleaners[0];
        if (c) { onClose(); navigate(`/sheet/${encodeURIComponent(c.id)}/${p.day === 'ALL' ? TOUR_DAY : p.day}${p.api?.shareQuery() ?? ''}`); }
      }
    } catch (e) {
      p.showToast(errorText(e), 'error');
    } finally {
      setBusy(false);
    }
  }, [step.n, p, errorText, navigate, onClose]);

  if (!open) return null;
  const pad = 6;
  const hole = rect ? { top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 } : null;
  const vw = window.innerWidth, vh = window.innerHeight;
  const cardW = Math.min(360, vw - 32);
  let style: React.CSSProperties = { width: cardW };
  if (vw < 760 || !hole) {
    style = { ...style, left: (vw - cardW) / 2, bottom: 16 };
  } else if (hole.width > vw * 0.5) {
    style = { ...style, left: hole.left + 24, bottom: Math.max(16, vh - (hole.top + hole.height) + 24) };
  } else if (vw - (hole.left + hole.width) > cardW + 32) {
    style = { ...style, left: hole.left + hole.width + 16, top: Math.min(Math.max(190, hole.top), vh - 280) };
  } else {
    style = { ...style, left: Math.max(16, hole.left - cardW - 16), top: Math.min(Math.max(190, hole.top), vh - 280) };
  }
  const last = i === STEPS.length - 1;

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label={t(`tour.${step.n}.title` as DictKey)}>
      {hole ? <div className="tour-hole" style={hole} /> : <div className="tour-dim" />}
      <div className="tour-card" style={style}>
        <div className="tour-top">
          <span className="eyebrow">{t('tour.step', { i: i + 1, n: STEPS.length })}</span>
          <button className="btn btn-ghost btn-icon btn-xs" onClick={onClose} aria-label={t('tour.skip')}><Icon name="x" size={14} /></button>
        </div>
        <h3>{t(`tour.${step.n}.title` as DictKey)}</h3>
        <p>{t(`tour.${step.n}.body` as DictKey)}</p>
        <div className="tour-dots" aria-hidden>{STEPS.map((_, k) => <span key={k} className={k === i ? 'on' : ''} />)}</div>
        <div className="tour-actions">
          {step.n >= 3 && (
            <button className="btn btn-secondary btn-sm" onClick={example} disabled={busy}>
              {busy ? <span className="spinner" /> : <Icon name="play" size={11} fill />} {t('tour.try')}
            </button>
          )}
          <span className="grow" />
          {i > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setI(i - 1)}>{t('tour.back')}</button>}
          <button className="btn btn-primary btn-sm" onClick={() => (last ? onClose() : setI(i + 1))}>{last ? t('tour.done') : t('tour.next')}</button>
        </div>
      </div>
    </div>
  );
}
