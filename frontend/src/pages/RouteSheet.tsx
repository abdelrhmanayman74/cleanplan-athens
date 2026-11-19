import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { getApi } from '../api';
import type { RouteSheet as Sheet } from '../api/types';
import { cleanerColor } from '../lib/colors';
import { DAY_KEYS, minutesToClock } from '../lib/days';
import { fmtMinutes, maskPhone } from '../lib/format';
import { useI18n } from '../i18n/I18n';
import { useTheme } from '../state/theme';
import { Footer } from '../components/Footer';
import { Icon } from '../components/Icon';
import { Logo } from '../components/Logo';
import { Skeleton } from '../components/Skeleton';
import { SheetMap } from '../components/SheetMap';
import { StartGlyph } from '../components/StartGlyph';
import { isHomeStart } from '../lib/stations';

/** Stops marked done on this device: building id -> time of day ("07:41"). */
type Done = Record<string, string>;
function loadDone(key: string): Done {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Done) : {};
  } catch { return {}; }
}
const nowClock = () => new Date().toLocaleTimeString('el-GR', { hour: '2-digit', minute: '2-digit', hour12: false });
const walkTo = (lat: number, lng: number) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lng.toFixed(6)}&travelmode=walking`;

export function RouteSheet() {
  const { cleanerId = '', dayKey = 'A-Mon' } = useParams();
  // The query string carries the sender's scenario (a session id on the server version, the shift
  // and absence in the static build), so a link shows the same plan on any device.
  const { search } = useLocation();
  const { t, dayLabel, lang, setLang } = useI18n();
  const { theme, toggle } = useTheme();
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const storeKey = `cp.done.${cleanerId}.${dayKey}`;
  const [done, setDone] = useState<Done>(() => loadDone(storeKey));

  useEffect(() => {
    let off = false;
    setSheet(null); setErr(null); setDone(loadDone(storeKey));
    getApi().then((a) => a.routeSheet(cleanerId, dayKey, search)).then((s) => !off && setSheet(s)).catch((e) => !off && setErr(String(e?.message ?? e)));
    return () => { off = true; };
  }, [cleanerId, dayKey, storeKey, search]);

  useEffect(() => {
    if (sheet) document.title = `${sheet.cleaner.name} · ${dayLabel(dayKey)} · CleanPlan`;
    return () => { document.title = 'CleanPlan'; };
  }, [sheet, dayKey, dayLabel]);

  const toggleDone = (id: string) => {
    setDone((prev) => {
      const n = { ...prev };
      if (n[id]) delete n[id]; else n[id] = nowClock();
      try { localStorage.setItem(storeKey, JSON.stringify(n)); } catch { /* demo only */ }
      return n;
    });
  };
  const doneCount = Object.keys(done).length;

  const idx = DAY_KEYS.indexOf(dayKey);
  const prev = idx > 0 ? DAY_KEYS[idx - 1] : null;
  const next = idx >= 0 && idx < DAY_KEYS.length - 1 ? DAY_KEYS[idx + 1] : null;
  const color = sheet ? cleanerColor(sheet.cleaner.id) : 'var(--accent)';
  const shareUrl = window.location.href;
  const shareText = sheet ? `${t('sheet.shareText', { name: sheet.cleaner.name, day: dayLabel(dayKey) })}\n${shareUrl}` : shareUrl;
  const urls = useMemo(() => (sheet ? (sheet.google_maps_urls?.length ? sheet.google_maps_urls : [sheet.google_maps_url]).filter(Boolean) : []), [sheet]);

  return (
    <div className="sheet-page">
      <header className="sheet-bar no-print">
        <Link to="/" className="btn btn-ghost btn-sm"><Icon name="chevronLeft" size={16} /> {t('sheet.back')}</Link>
        <span className="grow" />
        <button className="btn btn-ghost btn-sm btn-lang" onClick={() => setLang(lang === 'el' ? 'en' : 'el')} aria-label={t('app.langToggleAria')}>{t('app.langToggle')}</button>
        <button className="btn btn-ghost btn-icon" onClick={toggle} aria-label={theme === 'light' ? t('app.themeDark') : t('app.themeLight')}>
          <Icon name={theme === 'light' ? 'moon' : 'sun'} size={17} />
        </button>
      </header>

      <main className="sheet">
        {err && (
          <div className="card callout-warning">
            <p>{t('sheet.notFound')}</p>
            <p className="small mono muted">{err}</p>
          </div>
        )}

        {!sheet && !err && (
          <div className="stack" aria-busy="true">
            <Skeleton h={128} r={14} />
            <Skeleton h={44} r={10} />
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} h={96} r={12} />)}
          </div>
        )}

        {sheet && (
          <>
            <section className="sheet-hero" style={{ ['--c' as string]: color }}>
              <div className="sheet-hero-top">
                <Logo size={22} />
                <span className="eyebrow">{dayLabel(dayKey)}</span>
              </div>
              <h1>{sheet.cleaner.name}</h1>
              <div className="sheet-sub">{sheet.date_label && sheet.date_label !== dayLabel(dayKey) && lang === 'el' ? sheet.date_label : dayLabel(dayKey)}</div>
              <div className="sheet-facts">
                <div>
                  <span className="k">{t('sheet.shift')}</span>
                  <span className="v">{minutesToClock(sheet.route.start_time)}–{minutesToClock(sheet.route.end_time)}</span>
                </div>
                <div>
                  <span className="k">{t('sheet.start')}</span>
                  <span className="v"><StartGlyph start={sheet.cleaner.start} size={13} /> {sheet.cleaner.start.label}</span>
                </div>
                <div>
                  <span className="k">{t('sheet.stops')}</span>
                  <span className="v">{sheet.stops.length}</span>
                </div>
                <div>
                  <span className="k">{t('sheet.walkTotal')}</span>
                  <span className="v">{fmtMinutes(sheet.route.walk_minutes, lang)}</span>
                </div>
                <div>
                  <span className="k">{t('sheet.workTotal')}</span>
                  <span className="v">{fmtMinutes(sheet.route.service_minutes, lang)}</span>
                </div>
              </div>
              <div className="small sheet-break">{t('sheet.breakNote')}</div>
            </section>

            {sheet.note && <p className="callout small no-print">{t('sheet.noteScenario')}</p>}
            {sheet.stops.length > 0 && <SheetMap sheet={sheet} color={color} />}

            <section className="sheet-actions no-print">
              {urls.map((u, i) => (
                <a key={u} className="btn btn-primary btn-block" href={u} target="_blank" rel="noreferrer">
                  <Icon name="external" size={15} /> {urls.length > 1 ? t('sheet.mapsPart', { i: i + 1, n: urls.length }) : t('sheet.maps')}
                </a>
              ))}
              <div className="share-row">
                <a className="btn btn-secondary" href={`viber://forward?text=${encodeURIComponent(shareText)}`}>
                  <Icon name="share" size={15} /> {t('sheet.viber')}
                </a>
                <a className="btn btn-secondary" href={`https://wa.me/?text=${encodeURIComponent(shareText)}`} target="_blank" rel="noreferrer">
                  <Icon name="share" size={15} /> {t('sheet.whatsapp')}
                </a>
                <button className="btn btn-ghost" onClick={() => window.print()}><Icon name="print" size={15} /> {t('sheet.print')}</button>
              </div>
            </section>

            <div className="sheet-progress no-print">
              <div className="progress-track"><span className="progress-fill ok" style={{ width: `${(doneCount / Math.max(1, sheet.stops.length)) * 100}%` }} /></div>
              <span className="small muted">{t('sheet.progress', { d: doneCount, n: sheet.stops.length })}</span>
            </div>

            <ol className="stops">
              {sheet.stops.map((s, i) => {
                const b = s.building;
                const doneAt = done[s.building_id];
                return (
                  <li key={s.building_id} className={`stop-card ${doneAt ? 'is-done' : ''}`}>
                    {s.walk_from_prev > 0 && (
                      <div className="walk-leg"><Icon name="walk" size={13} /> {t('sheet.walkFrom', { n: fmtMinutes(s.walk_from_prev, lang) })}</div>
                    )}
                    <div className="stop-body">
                      <span className="stop-n" style={{ background: color }}>{i + 1}</span>
                      <div className="stop-main">
                        <div className="stop-top">
                          <span className="stop-time">{minutesToClock(s.arrival)}–{minutesToClock(s.depart)}</span>
                          {b.time_window && <span className="badge badge-warning">{t('sheet.morningOnly')}</span>}
                        </div>
                        <a className="stop-addr" href={walkTo(b.lat, b.lng)} target="_blank" rel="noreferrer">
                          {b.street} {b.number} <Icon name="external" size={13} className="inline-icon" />
                        </a>
                        <div className="small muted">{b.neighborhood}{b.postcode ? ` · ${b.postcode}` : ''} · {t('sheet.work', { n: fmtMinutes(b.service_minutes, lang) })}</div>
                        <div className="stop-access"><Icon name="key" size={13} /> {b.access_note}</div>
                        <div className="tags">{b.tasks.map((x) => <span className="tag" key={x}>{x}</span>)}</div>
                        {b.manager?.name && (
                          <div className="small stop-phone">
                            <Icon name="phone" size={12} /> {t('building.manager')}: {b.manager.name}
                            {b.manager.phone && b.manager.phone !== '—' ? ` · ${maskPhone(b.manager.phone)}` : ''}
                          </div>
                        )}
                      </div>
                    </div>
                    <button className={`btn btn-sm checkin no-print ${doneAt ? 'is-done' : ''}`} onClick={() => toggleDone(s.building_id)} aria-pressed={!!doneAt}>
                      <Icon name="check" size={14} /> {doneAt ? t('sheet.done', { time: doneAt }) : t('sheet.markDone')}
                    </button>
                  </li>
                );
              })}
              <li className="stop-card stop-end">
                <div className="stop-body">
                  <span className="stop-n stop-n-end">{isHomeStart(sheet.cleaner.start) ? <Icon name="home" size={12} /> : <StartGlyph start={sheet.cleaner.start} />}</span>
                  <div className="stop-main">
                    <div className="stop-time">{minutesToClock(sheet.route.end_time)}</div>
                    <div className="stop-addr">{t('sheet.end')}</div>
                    <div className="small muted">{sheet.cleaner.start.label}</div>
                  </div>
                </div>
              </li>
            </ol>
            <p className="hint fine no-print">{t('sheet.demoNote')}</p>
          </>
        )}

        <nav className="sheet-days no-print">
          {prev ? <Link className="btn btn-ghost btn-sm" to={`/sheet/${encodeURIComponent(cleanerId)}/${prev}${search}`}><Icon name="chevronLeft" size={14} /> {dayLabel(prev, 'short')}</Link> : <span />}
          {next ? <Link className="btn btn-ghost btn-sm" to={`/sheet/${encodeURIComponent(cleanerId)}/${next}${search}`}>{dayLabel(next, 'short')} <Icon name="chevronRight" size={14} /></Link> : <span />}
        </nav>
      </main>
      <Footer />
    </div>
  );
}
