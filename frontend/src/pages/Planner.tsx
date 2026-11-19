import { useState } from 'react';
import { fmtNumber } from '../lib/format';
import { useI18n } from '../i18n/I18n';
import type { DictKey } from '../i18n/dict';
import { usePlanner, type Tab } from '../state/PlannerContext';
import { BuildingDrawer } from '../components/BuildingDrawer';
import { CleanerList } from '../components/CleanerList';
import { DayChips } from '../components/DayChips';
import { Footer } from '../components/Footer';
import { Header } from '../components/Header';
import { Icon, type IconName } from '../components/Icon';
import { ImportPanel } from '../components/ImportPanel';
import { KpiTab } from '../components/KpiPanel';
import { MapView } from '../components/MapView';
import { ScenariosTab } from '../components/Scenarios';
import { Search } from '../components/Search';
import { PanelSkeleton } from '../components/Skeleton';
import { ToastHost } from '../components/Toast';
import { Tour } from '../components/Tour';
import { HeadlineStrip, ReplanBanner, WelcomeCard } from '../components/Landing';
import { TryAbsenceButton } from '../components/Scenarios';

const TABS: { id: Tab; icon: IconName }[] = [
  { id: 'plan', icon: 'users' },
  { id: 'kpi', icon: 'gauge' },
  { id: 'scenarios', icon: 'layers' },
  { id: 'import', icon: 'upload' },
];

function PlanSummary() {
  const { plan, setTab } = usePlanner();
  const { t, lang } = useI18n();
  if (!plan) return null;
  const k = plan.kpis;
  return (
    <button className="summary-strip" onClick={() => setTab('kpi')}>
      <span><strong>{fmtNumber(k.walk_minutes / 60, lang)}</strong> <span className="muted">{t('summary.walkHours')}</span></span>
      <span className={k.frequency_violations === 0 ? 'ok-text' : 'warn-text'}>
        <Icon name={k.frequency_violations === 0 ? 'check' : 'alert'} size={14} className="inline-icon" /> {k.frequency_violations} {t('summary.violations')}
      </span>
    </button>
  );
}

export function Planner() {
  const { status, error, reload, tab, setTab, scenario, insert } = usePlanner();
  const { t } = useI18n();
  const [tour, setTour] = useState(false);

  return (
    <div className="app">
      <Header onTour={() => setTour(true)} />
      <main className="planner">
        {status === 'ready' && <WelcomeCard onTour={() => setTour(true)} />}
        <section className="map-area">
          <div className="map-toolbar"><DayChips /></div>
          <MapView />
          {insert.picking && <div className="map-hint"><Icon name="pin" size={14} /> {t('insert.dropping')}</div>}
          <BuildingDrawer />
        </section>
        <aside className="panel" aria-label="panel">
          <div className="panel-top">
            {status === 'ready' && <><HeadlineStrip /><ReplanBanner /></>}
            <Search />
            <nav className="tabs" role="tablist">
              {TABS.map((x) => (
                <button key={x.id} role="tab" aria-selected={tab === x.id} className={`tab ${tab === x.id ? 'is-active' : ''}`} onClick={() => setTab(x.id)}>
                  <Icon name={x.icon} size={15} />
                  <span>{t(`tab.${x.id}` as DictKey)}</span>
                  {x.id === 'scenarios' && scenario && <span className="tab-dot" aria-hidden />}
                </button>
              ))}
            </nav>
          </div>
          <div className="panel-body">
            {status === 'loading' && <PanelSkeleton />}
            {status === 'error' && (
              <div className="card callout-warning">
                <h3>{t('app.errorTitle')}</h3>
                <p className="hint">{t('app.errorBody')}</p>
                <p className="small mono muted">{error}</p>
                <button className="btn btn-primary" onClick={reload}>{t('app.retry')}</button>
              </div>
            )}
            {status === 'ready' && (
              <>
                {tab === 'plan' && (<><PlanSummary /><TryAbsenceButton className="btn btn-secondary btn-block try-absence" /><CleanerList /></>)}
                {tab === 'kpi' && <KpiTab />}
                {tab === 'scenarios' && <ScenariosTab />}
                {tab === 'import' && <ImportPanel />}
              </>
            )}
          </div>
        </aside>
      </main>
      <Footer />
      <ToastHost />
      <Tour open={tour && status === 'ready'} onClose={() => setTour(false)} />
    </div>
  );
}
