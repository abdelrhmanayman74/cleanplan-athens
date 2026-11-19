import type {
  Api, Baseline, Building, ChangeResult, Cleaner, CostEstimate, DayKey, ImportResult,
  InsertCandidate, Meta, NearestAddress, NewBuilding, Plan, PlanParams, ProviderCompare, RouteSheet, WorkforceEstimate,
} from './types';
import { getSessionId, sessionFromUrl, sessionQuery } from './session';

/** `code` is the backend's stable error code (e.g. "solver_busy"), translated by the UI. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  let message = res.statusText || `HTTP ${res.status}`;
  let code: string | undefined;
  try {
    const detail = (await res.json())?.detail;
    if (typeof detail === 'string') message = detail;
    else if (detail && typeof detail === 'object' && 'message' in detail) ({ message, code } = detail);
    else if (detail) message = JSON.stringify(detail);
  } catch { /* not JSON */ }
  return new ApiError(res.status, message, code);
}

async function request<T>(path: string, init?: RequestInit, sessionId = getSessionId()): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('X-Session-Id', sessionId);
  if (init?.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const res = await fetch(`/api${path}`, { ...init, headers });
  if (!res.ok) throw await errorFrom(res);
  return res.json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const httpApi: Api = {
  features: { replay: false, absenceOnStandardPlanOnly: false },
  shareQuery: () => sessionQuery(),
  meta: () => request<Meta>('/meta'),
  buildings: () => request<Building[]>('/buildings'),
  cleaners: () => request<Cleaner[]>('/cleaners'),
  currentPlan: () => request<Plan>('/plan/current'),
  replan: (params: PlanParams) => post<Plan>('/plan', params),
  baseline: () => request<Baseline>('/plan/baseline'),
  absence: (cleaner_id: string, day_key: DayKey) => post<ChangeResult>('/plan/absence', { cleaner_id, day_key }),
  insertCandidates: (b: NewBuilding) => post<{ candidates: InsertCandidate[] }>('/plan/insert-candidates', b),
  insertCommit: (building: NewBuilding, candidate: InsertCandidate) =>
    post<ChangeResult>('/plan/insert-commit', { building, candidate }),
  reset: () => post<Plan>('/plan/reset'),
  workforce: (daily_minutes: number, target_utilization: number) =>
    request<WorkforceEstimate>(
      `/workforce/estimate?daily_minutes=${encodeURIComponent(daily_minutes)}&target_utilization=${encodeURIComponent(target_utilization)}`,
    ),
  routeSheet: (cleaner_id: string, day_key: DayKey, context?: string) =>
    request<RouteSheet>(
      `/route-sheet/${encodeURIComponent(cleaner_id)}/${encodeURIComponent(day_key)}`,
      undefined,
      sessionFromUrl(context ?? '') ?? getSessionId(),
    ),
  costEstimate: () => request<CostEstimate>('/cost-estimate'),
  importFile: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<ImportResult>('/import', { method: 'POST', body: fd });
  },
  importSampleUrl: () => '/api/import/sample',
  reverseGeocode: (lat: number, lng: number) =>
    request<NearestAddress>(`/geocode/reverse?lat=${lat}&lng=${lng}`).catch(() => null),
  exportSchedule: async () => {
    const res = await fetch('/api/plan/export.xlsx', { headers: { 'X-Session-Id': getSessionId() } });
    if (!res.ok) throw await errorFrom(res);
    return res.blob();
  },
  providerCompare: () => request<ProviderCompare>('/provider-compare').catch(() => null),
};
