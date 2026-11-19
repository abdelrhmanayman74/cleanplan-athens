import type { Api } from './types';
import { httpApi } from './client';

export const IS_MOCK = import.meta.env.VITE_MOCK === '1';
/** Static build (GitHub Pages): replays results precomputed by the real optimiser. */
export const IS_STATIC = import.meta.env.VITE_STATIC === '1';

let apiPromise: Promise<Api> | null = null;

/** The real HTTP client; the static replay with VITE_STATIC=1; the in-browser mock with VITE_MOCK=1. */
export function getApi(): Promise<Api> {
  if (!apiPromise) {
    apiPromise = IS_STATIC
      ? import('./static/staticApi').then((m) => m.createStaticApi())
      : IS_MOCK
        ? import('./mock/mockApi').then((m) => m.createMockApi())
        : Promise.resolve(httpApi);
  }
  return apiPromise;
}
