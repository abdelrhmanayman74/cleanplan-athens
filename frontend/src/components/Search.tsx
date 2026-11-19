import { useMemo, useRef, useState } from 'react';
import { normalizeSearch } from '../lib/normalize';
import { useI18n } from '../i18n/I18n';
import { usePlanner } from '../state/PlannerContext';
import { Icon } from './Icon';

export function Search() {
  const { buildings, selectBuilding, cleanerById, assignmentByBuilding, setTab } = usePlanner();
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const index = useMemo(
    () => buildings.map((b) => ({ b, key: normalizeSearch(`${b.street} ${b.number} ${b.neighborhood} ${b.name} ${b.postcode ?? ''}`) })),
    [buildings],
  );
  const results = useMemo(() => {
    const terms = normalizeSearch(q).split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    return index.filter((x) => terms.every((tm) => x.key.includes(tm))).slice(0, 40).map((x) => x.b);
  }, [q, index]);

  const choose = (id: string) => {
    selectBuilding(id, true);
    setTab('plan');
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div className="search" data-tour="search">
      <Icon name="search" size={16} className="search-icon" />
      <input
        ref={inputRef}
        type="search"
        value={q}
        placeholder={t('search.placeholder')}
        aria-label={t('search.placeholder')}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, results.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === 'Enter' && results[active]) choose(results[active].id);
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && q.trim() && (
        <div className="search-results" role="listbox">
          <div className="search-count">{results.length ? t('search.results', { n: results.length >= 40 ? '40+' : results.length }) : t('search.noResults')}</div>
          {results.map((b, i) => {
            const c = cleanerById.get(assignmentByBuilding.get(b.id)?.cleaner_id ?? '');
            return (
              <button
                key={b.id} role="option" aria-selected={i === active}
                className={`search-item ${i === active ? 'is-active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(b.id)}
              >
                <span className="dot" style={{ background: c?.color ?? 'var(--text-3)' }} />
                <span className="search-item-main">
                  <span className="search-item-title">{b.street} {b.number}</span>
                  <span className="search-item-sub">{b.neighborhood}{b.postcode ? ` · ${b.postcode}` : ''}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
