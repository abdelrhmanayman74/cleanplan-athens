// Categorical cleaner colours. Generated in OKLCH with golden-angle hue steps,
// skipping the UI accent's hue band (Aegean blue, ~hue 235–265° in OKLCH) so a
// route is never confused with selected UI. Consecutive indices differ strongly
// in hue and lightness, and neighbouring territories get consecutive indices.

const ACCENT_BAND: [number, number] = [210, 288]; // OKLCH hue degrees reserved for the accent
const LIGHTNESS = [0.55, 0.65, 0.47];
// Muted (about 60 % of full saturation) so routes sit calmly on the stone-coloured basemap next
// to the Aegean-blue accent; hue and lightness steps keep neighbouring territories distinct.
const CHROMA = 0.105;

function oklchToHex(L: number, C: number, hDeg: number): string | null {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  if (lin.some((v) => v < -0.0005 || v > 1.0005)) return null;
  return '#' + lin.map((v) => {
    const c = Math.max(0, Math.min(1, v));
    const g = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
    return Math.round(g * 255).toString(16).padStart(2, '0');
  }).join('');
}

function inGamut(L: number, C: number, h: number): string {
  for (let c = C; c > 0.02; c -= 0.01) {
    const hex = oklchToHex(L, c, h);
    if (hex) return hex;
  }
  return oklchToHex(L, 0.02, h) ?? '#777777';
}

const ALLOWED = 360 - (ACCENT_BAND[1] - ACCENT_BAND[0]);
function hueAt(i: number): number {
  const t = ((i * 137.508) % 360) / 360; // golden-angle spread over the allowed arc
  const h = (ACCENT_BAND[1] + t * ALLOWED) % 360;
  return h;
}

const cache: string[] = [];
export function paletteColor(i: number): string {
  if (!cache[i]) cache[i] = inGamut(LIGHTNESS[i % LIGHTNESS.length], CHROMA, hueAt(i));
  return cache[i];
}

/** A cleaner's colour, keyed by id ("c05" -> 5th colour) so every page agrees. */
export function cleanerColor(id: string, fallbackIndex = 0): string {
  const n = parseInt(id.replace(/\D/g, ''), 10);
  return paletteColor(Number.isFinite(n) && n > 0 ? n - 1 : fallbackIndex);
}
