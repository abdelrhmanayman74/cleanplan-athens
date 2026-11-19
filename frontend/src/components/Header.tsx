import { Link } from 'react-router-dom';
import { IS_MOCK } from '../api';
import { useI18n } from '../i18n/I18n';
import { useTheme } from '../state/theme';
import { Icon } from './Icon';
import { Logo } from './Logo';

export function Header({ onTour }: { onTour?: () => void }) {
  const { t, lang, setLang } = useI18n();
  const { theme, toggle } = useTheme();
  return (
    <header className="topbar">
      <Link to="/" className="brand" aria-label="CleanPlan">
        <Logo />
        <span className="brand-text">
          <span className="brand-name">CleanPlan</span>
          <span className="brand-sub">{t('app.subtitle')}</span>
        </span>
      </Link>
      <div className="topbar-actions">
        {IS_MOCK && <span className="badge badge-muted mock-badge">{t('app.mockBadge')}</span>}
        {onTour && (
          <button className="btn btn-primary btn-sm" onClick={onTour} data-tour-start>
            <Icon name="play" size={12} fill /> <span className="tour-long">{t('app.tour')}</span><span className="tour-short">{t('app.tourShort')}</span>
          </button>
        )}
        <button className="btn btn-ghost btn-sm btn-lang" onClick={() => setLang(lang === 'el' ? 'en' : 'el')} aria-label={t('app.langToggleAria')}>
          {t('app.langToggle')}
        </button>
        <button className="btn btn-ghost btn-icon" onClick={toggle} aria-label={theme === 'light' ? t('app.themeDark') : t('app.themeLight')} title={theme === 'light' ? t('app.themeDark') : t('app.themeLight')}>
          <Icon name={theme === 'light' ? 'moon' : 'sun'} size={17} />
        </button>
      </div>
    </header>
  );
}
