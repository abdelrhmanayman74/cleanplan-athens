import type { Cleaner } from '../api/types';

type Start = Cleaner['start'];

export const isHomeStart = (s: Start) => s.mode === 'home' || s.kind === 'home' || /^(οικία|σπίτι|home)/i.test(s.label.trim());

/** One-letter marker for a start point: Μ metro, Η ΗΣΑΠ (line 1), Τ tram, Π suburban rail; null for home. */
export function startGlyph(s: Start): string | null {
  if (isHomeStart(s)) return null;
  return { isap: 'Η', tram: 'Τ', rail: 'Π' }[s.mode as string] ?? 'Μ';
}
