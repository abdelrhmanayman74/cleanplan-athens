import { usePlanner } from '../state/PlannerContext';
import { useI18n } from '../i18n/I18n';
import { Icon } from './Icon';

export function ToastHost() {
  const { toast, dismissToast } = usePlanner();
  const { t } = useI18n();
  if (!toast) return null;
  return (
    <div className={`toast toast-${toast.tone}`} role="status" aria-live="polite" key={toast.id}>
      <Icon name={toast.tone === 'success' ? 'check' : toast.tone === 'info' ? 'info' : 'alert'} size={18} />
      <span className="toast-text">{toast.text}</span>
      <button className="btn btn-ghost btn-icon btn-xs" onClick={dismissToast} aria-label={t('common.close')}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
