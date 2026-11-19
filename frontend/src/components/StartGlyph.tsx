import type { Cleaner } from '../api/types';
import { startGlyph } from '../lib/stations';
import { Icon } from './Icon';

/** Marker letter for a cleaner's start point (Μ, Η, Τ, Π) or a house icon for home starts. */
export function StartGlyph({ start, size = 12 }: { start: Cleaner['start']; size?: number }) {
  const g = startGlyph(start);
  return g ? <span className="metro-glyph" aria-hidden>{g}</span> : <Icon name="home" size={size} />;
}
