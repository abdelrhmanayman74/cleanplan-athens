import { useI18n } from '../i18n/I18n';
import { RealityNote } from './Landing';

export function Footer() {
  const { t } = useI18n();
  return (
    <footer className="footer">
      <span>{t('footer.note')}</span>
      <RealityNote />
      <span className="footer-sep" aria-hidden>·</span>
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">{t('footer.osm')}</a>
      <span className="footer-sep" aria-hidden>·</span>
      <span className="footer-stack">{t('footer.stack')}</span>
    </footer>
  );
}
