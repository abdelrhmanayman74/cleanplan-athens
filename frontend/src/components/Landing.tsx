import { useEffect, useRef, useState } from 'react';
import { IS_STATIC } from '../api';
import { fmtNumber } from '../lib/format';
import { useI18n } from '../i18n/I18n';
import { usePlanner } from '../state/PlannerContext';
import { Icon } from './Icon';
import { TryAbsenceButton } from './Scenarios';

const WELCOME_KEY = 'cp.welcomed';

/** "1.000 πολυκατοικίες · 29 άτομα · καμία χαμένη επίσκεψη · υπολογίστηκε σε 11″" (live values). */
export function HeadlineStrip() {
  const { plan, buildings, setTab } = usePlanner();
  const { t, lang } = useI18n();
  if (!plan) return null;
  const k = plan.kpis;
  const missed = k.unassigned + k.frequency_violations;
  return (
    <button className="headline" onClick={() => setTab('kpi')}>
      <span><strong>{fmtNumber(buildings.length, lang)}</strong> {t('headline.buildings')}</span>
      <span><strong className="accent-num">{k.cleaners}</strong> {t('headline.people')}</span>
      <span className={missed ? 'warn-text' : 'ok-text'}>
        <Icon name={missed ? 'alert' : 'check'} size={13} className="inline-icon" />{' '}
        {missed ? t('headline.missed', { n: missed }) : t('headline.noneMissed')}
      </span>
      <span className="muted">{t('headline.computed', { s: fmtNumber(Math.round(plan.solve_seconds), lang) })}</span>
    </button>
  );
}

/** Shown after a re-plan with another shift: "Σενάριο: βάρδια 7 ωρών · Επαναφορά". */
export function ReplanBanner() {
  const { plan, replanned, resetPlan } = usePlanner();
  const { t, lang } = useI18n();
  if (!plan || !replanned) return null;
  const h = (plan.params.daily_minutes ?? 480) / 60;
  return (
    <div className="banner" role="status">
      <Icon name="layers" size={14} />
      <span>{t('replan.banner', { h: fmtNumber(h, lang, h % 1 ? 1 : 0) })}</span>
      <button className="btn btn-link btn-xs" onClick={() => resetPlan()}>{t('replan.reset')}</button>
    </div>
  );
}

function readWelcomed(): boolean {
  try { return localStorage.getItem(WELCOME_KEY) === '1'; } catch { return false; }
}

/** First-visit card: what the demo shows in three bullets, and a guided or a free start. */
export function WelcomeCard({ onTour }: { onTour: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(() => !readWelcomed());
  if (!open) return null;
  const dismiss = () => {
    setOpen(false);
    try { localStorage.setItem(WELCOME_KEY, '1'); } catch { /* remembered for this page only */ }
  };
  return (
    <section className="welcome card" aria-labelledby="welcome-title" data-tour="welcome">
      <button className="btn btn-ghost btn-icon btn-xs welcome-close" onClick={dismiss} aria-label={t('common.close')}><Icon name="x" size={14} /></button>
      <h2 id="welcome-title">{t('welcome.title')}</h2>
      <ul className="welcome-list">
        <li><Icon name="calendar" size={16} /><span><strong>{t('welcome.1.title')}</strong> {t('welcome.1.body')}</span></li>
        <li><Icon name="users" size={16} /><span><strong>{t('welcome.2.title')}</strong> {t('welcome.2.body')}</span></li>
        <li><Icon name="sheet" size={16} /><span><strong>{t('welcome.3.title')}</strong> {t('welcome.3.body')}</span></li>
      </ul>
      <div className="welcome-actions">
        <button className="btn btn-primary" onClick={() => { dismiss(); onTour(); }}>
          <Icon name="play" size={12} fill /> {t('welcome.tour')}
        </button>
        <button className="btn btn-secondary" onClick={dismiss}>{t('welcome.explore')}</button>
      </div>
      <TryAbsenceButton className="btn btn-link btn-xs welcome-try" onDone={dismiss} />
    </section>
  );
}

/** "Τι είναι πραγματικό;": which parts of the demo are real and which are synthetic. */
export function RealityNote() {
  const { t } = useI18n();
  const replay = IS_STATIC;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);
  return (
    <span className="reality" ref={ref}>
      <button className="btn btn-link btn-xs" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="info" size={13} /> {t('reality.button')}
      </button>
      {open && (
        <div className="reality-pop" role="dialog" aria-label={t('reality.button')}>
          <ul>
            <li className="ok-text"><Icon name="check" size={13} /> {t('reality.addresses')}</li>
            <li className="ok-text"><Icon name="check" size={13} /> {t('reality.network')}</li>
            <li className="ok-text"><Icon name="check" size={13} /> {t('reality.optimiser')}</li>
            {replay && <li><Icon name="info" size={13} /> {t('reality.replay')}</li>}
            <li className="muted"><Icon name="info" size={13} /> {t('reality.synthetic')}</li>
          </ul>
        </div>
      )}
    </span>
  );
}
