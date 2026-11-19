import { useRef, useState } from 'react';
import { IS_MOCK } from '../api';
import type { ImportResult } from '../api/types';
import { fmtPct } from '../lib/format';
import { useI18n } from '../i18n/I18n';
import { usePlanner } from '../state/PlannerContext';
import type { DictKey } from '../i18n/dict';
import { Icon } from './Icon';

function summaryCounts(r: ImportResult) {
  const s = r.summary;
  const obj = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
  const num = (k: string) => (typeof obj[k] === 'number' ? (obj[k] as number) : undefined);
  const matched = num('matched') ?? r.rows.filter((x) => x.matched).length;
  const total = num('total') ?? r.rows.length;
  return { total, matched, unmatched: num('unmatched') ?? total - matched, text: typeof s === 'string' ? s : null };
}

export function ImportPanel() {
  const { api, flyTo, showImportPins } = usePlanner();
  const { t, lang, tCode, errorText } = useI18n();
  const [res, setRes] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [fileName, setFileName] = useState('');
  const input = useRef<HTMLInputElement>(null);

  const upload = async (f: File | undefined) => {
    if (!f || !api) return;
    setBusy(true); setErr(null); setFileName(f.name);
    try {
      const r = await api.importFile(f);
      setRes(r);
      // matched addresses appear as pins on the map, framed by the map
      showImportPins(r.rows.flatMap((x) => (x.matched && x.lat != null && x.lng != null ? [{ lat: x.lat, lng: x.lng, label: x.matched_label ?? '' }] : [])));
    } catch (e) { setErr(errorText(e)); setRes(null); showImportPins([]); } finally { setBusy(false); }
  };

  const counts = res ? summaryCounts(res) : null;
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h3><Icon name="file" size={16} /> {t('import.title')}</h3></div>
        <p className="hint">{t('import.desc')}</p>
        <button
          type="button"
          className={`dropzone ${drag ? 'is-drag' : ''}`}
          onClick={() => input.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files[0]); }}
          disabled={busy}
        >
          {busy ? <span className="spinner" /> : <Icon name="upload" size={22} />}
          <span>{busy ? t('import.uploading') : fileName || t('import.drop')}</span>
          <span className="small muted">.xlsx · .csv</span>
        </button>
        <input ref={input} type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden
          onChange={(e) => { upload(e.target.files?.[0]); e.target.value = ''; }} />
        <a className="btn btn-link btn-xs" href={api?.importSampleUrl() ?? '#'} download>
          <Icon name="download" size={14} /> {t('import.sample')}
        </a>
        {IS_MOCK && <p className="hint fine">{t('import.mockNote')}</p>}
        {err && <div className="callout callout-warning small">{err}</div>}
      </div>

      {res && counts && (
        <div className="card">
          <div className="import-stats">
            <div><span className="stat-k">{t('import.total')}</span><span className="stat-v">{counts.total}</span></div>
            <div><span className="stat-k">{t('import.matched')}</span><span className="stat-v ok-text">{counts.matched}</span></div>
            <div><span className="stat-k">{t('import.unmatched')}</span><span className="stat-v warn-text">{counts.unmatched}</span></div>
          </div>
          {counts.text && <p className="hint">{counts.text}</p>}
          <div className="table-wrap">
            <table className="table import-table">
              <thead>
                <tr><th>{t('import.colAddress')}</th><th>{t('import.colStatus')}</th><th className="num">{t('import.colConfidence')}</th></tr>
              </thead>
              <tbody>
                {res.rows.map((r, i) => (
                  <tr key={i} className={r.matched ? '' : 'row-bad'}>
                    <td>
                      <div className="strong">{r.input.street} {r.input.number}</div>
                      <div className="small muted">{r.input.postcode}</div>
                      {r.frequency
                        ? <span className="tag tag-sm">{t(`freqShort.${r.frequency}` as DictKey)}</span>
                        : r.input.frequency && <span className="tag tag-sm">{r.input.frequency}</span>}
                    </td>
                    <td>
                      {r.matched ? (
                        <button className="btn btn-link btn-xs match-link" onClick={() => r.lat != null && r.lng != null && flyTo(r.lat, r.lng, 17)} disabled={r.lat == null}>
                          <Icon name="check" size={13} /> {r.matched_label ?? t('import.ok')}
                        </button>
                      ) : (
                        <span className="warn-text small"><Icon name="alert" size={13} className="inline-icon" /> {t('import.notFound')}</span>
                      )}
                      {r.issues?.length
                        ? r.issues.map((x) => <div key={x.code} className="small muted">{tCode('issue', x.code, x.text, { v: x.value ?? '' })}</div>)
                        : r.issue && <div className="small muted">{r.issue}</div>}
                    </td>
                    <td className="num">
                      <span className="conf">
                        <span className="conf-track"><span className={`conf-fill ${r.confidence >= 0.85 ? 'hi' : r.confidence >= 0.6 ? 'mid' : 'lo'}`} style={{ width: `${Math.round(r.confidence * 100)}%` }} /></span>
                        <span>{fmtPct(r.confidence, lang)}</span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
