import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { I18nProvider } from './i18n/I18n';
import { PlannerProvider } from './state/PlannerContext';
import { ThemeProvider } from './state/theme';
import { Planner } from './pages/Planner';
import { RouteSheet } from './pages/RouteSheet';

export default function App() {
  return (
    <ThemeProvider>
      <I18nProvider>
        <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Routes>
            <Route path="/" element={<PlannerProvider><Planner /></PlannerProvider>} />
            <Route path="/sheet/:cleanerId/:dayKey" element={<RouteSheet />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </I18nProvider>
    </ThemeProvider>
  );
}
