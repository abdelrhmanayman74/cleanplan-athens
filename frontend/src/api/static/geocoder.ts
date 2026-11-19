// Browser port of backend/app/geocoder.py and the row checks of backend/app/importer.py, so the
// static build matches imported addresses exactly like the server (same keys, same scores).

import type { Frequency, ImportIssue, ImportResult, ImportRow, NearestAddress } from '../types';
import { SequenceMatcher, getCloseMatches } from './difflib';
import { haversineM } from './geo';

export interface AddressRow { street: string; number: string; postcode: string | null; neighborhood: string; lat: number; lng: number }

const GREEK_TO_LATIN: Record<string, string> = {
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x',
  ο: 'o', π: 'p', ρ: 'r', σ: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
};
const DIGRAPHS: [string, string][] = [
  ['kh', 'x'], ['ch', 'x'], ['ou', 'u'], ['oy', 'u'], ['ay', 'av'], ['ey', 'ev'], ['ai', 'e'], ['ei', 'i'], ['oi', 'i'],
  ['yi', 'i'], ['mp', 'b'], ['nt', 'd'], ['gk', 'g'], ['gg', 'g'], ['ks', 'x'], ['ph', 'f'], ['w', 'o'], ['y', 'i'], ['c', 'k'],
];
const STOPWORDS = new Set(['οδος', 'οδοσ', 'λεωφ', 'λεωφοροσ', 'πλατεια', 'πλ', 'odos', 'leof', 'leoforos', 'plateia', 'str', 'street']);

/** Contract normalisation: NFD, strip combining marks, lowercase, final ς -> σ. */
export function normalize(s: string): string {
  return String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ');
}

/** Normalised, transliterated, phonetically flattened key for fuzzy matching. */
export function latinKey(s: string): string {
  let k = normalize(s).replace(/[^\p{L}\p{N}_\s]/gu, ' ');
  k = k.split(/\s+/).filter((w) => w && !STOPWORDS.has(w)).join(' ');
  k = [...k].map((ch) => GREEK_TO_LATIN[ch] ?? ch).join('');
  for (const [a, b] of DIGRAPHS) k = k.split(a).join(b);
  return k.replace(/\s+/g, ' ').trim();
}

function numberRange(n: string): [number, number] | null {
  const nums = (String(n).match(/\d+/g) ?? []).slice(0, 2).map(Number);
  return nums.length ? [Math.min(...nums), Math.max(...nums)] : null;
}

const issue = (code: string, text: string, value?: string): ImportIssue => (value === undefined ? { code, text } : { code, text, value });
const round2 = (x: number) => Math.round(x * 100) / 100;

interface Match { matched: boolean; confidence: number; lat?: number; lng?: number; label?: string; issues: ImportIssue[] }

export class AddressIndex {
  private byStreet = new Map<string, AddressRow[]>();
  private keys: string[];

  constructor(private rows: AddressRow[]) {
    for (const r of rows) {
      const k = latinKey(r.street);
      const list = this.byStreet.get(k);
      if (list) list.push(r); else this.byStreet.set(k, [r]);
    }
    this.keys = [...this.byStreet.keys()];
  }

  nearest(lat: number, lng: number): NearestAddress {
    let best = 0, bd = Infinity;
    this.rows.forEach((r, i) => {
      const d = haversineM(lat, lng, r.lat, r.lng);
      if (d < bd) { bd = d; best = i; }
    });
    const r = this.rows[best];
    return { street: r.street, number: r.number, neighborhood: r.neighborhood, label: `${r.street} ${r.number}, ${r.neighborhood}`, distance_m: Math.round(bd) };
  }

  private notFound(key: string): ImportIssue {
    const loose = getCloseMatches(key, this.keys, 1, 0.5);
    if (loose.length) {
      const name = this.byStreet.get(loose[0])![0].street;
      return issue('street_suggestion', `street not found; did you mean ${name}?`, name);
    }
    return issue('street_not_found', 'street not found in the local OSM address index');
  }

  lookup(street: string, number: string, postcode?: string): Match {
    const key = latinKey(street ?? '');
    if (!key) return { matched: false, confidence: 0, issues: [issue('missing_street', 'missing street')] };
    let streetKey = key, streetScore = 1;
    if (!this.byStreet.has(key)) {
      const close = getCloseMatches(key, this.keys, 1, 0.72);
      if (!close.length) return { matched: false, confidence: 0, issues: [this.notFound(key)] };
      streetKey = close[0];
      streetScore = new SequenceMatcher().setSeqs(key, streetKey).ratio();
    }
    const pc = String(postcode ?? '').replace(/\D/g, '');
    const want = numberRange(number);
    const numNorm = normalize(String(number ?? '')).trim();
    let best: { key: [number, number, string]; c: AddressRow; score: number } | null = null;
    for (const c of this.byStreet.get(streetKey)!) {
      const have = numberRange(c.number);
      let score: number, gap: number;
      if (normalize(c.number).trim() === numNorm) { score = 1; gap = 0; }
      else if (!want || !have) continue;
      else if (have[0] <= want[0] && want[0] <= have[1]) { score = 0.95; gap = 0; }
      else {
        gap = Math.min(Math.abs(want[0] - have[0]), Math.abs(want[0] - have[1]));
        score = Math.max(0.3, 0.9 - 0.05 * gap - (gap % 2 === 0 ? 0 : 0.15));
      }
      const bonus = pc && (c.postcode ?? '') === pc ? 0.02 : 0;
      const k: [number, number, string] = [score + bonus, -gap, c.number];
      // Python max() keeps the first of equal keys
      if (!best || k[0] > best.key[0] || (k[0] === best.key[0] && (k[1] > best.key[1] || (k[1] === best.key[1] && k[2] > best.key[2])))) {
        best = { key: k, c, score };
      }
    }
    if (!best) return { matched: false, confidence: round2(0.4 * streetScore), issues: [issue('number_not_found', 'house number not found')] };
    const { c, score } = best;
    const issues: ImportIssue[] = [];
    if (streetScore < 1) issues.push(issue('street_approximate', `street matched approximately (${c.street})`, c.street));
    if (score < 0.95) issues.push(issue('number_nearest', `nearest number on the street used (${c.number})`, c.number));
    const confidence = round2(streetScore * score);
    const label = `${c.street} ${c.number}${c.postcode ? `, ${c.postcode}` : ''} (${c.neighborhood})`;
    return { matched: confidence >= 0.5, confidence, lat: c.lat, lng: c.lng, label, issues };
  }
}

// ---- importer.py: columns, frequency labels, per-row checks -------------------------------------

const FREQUENCIES: Frequency[] = ['3w', '2w', '1w', 'biweekly'];
const HEADER_ALIASES: Record<string, string> = {
  street: 'street', number: 'number', postcode: 'postcode', frequency: 'frequency', floors: 'floors', haslift: 'has_lift',
  οδοσ: 'street', αριθμοσ: 'number', αρ: 'number', τκ: 'postcode', ταχυδρομικοσκωδικασ: 'postcode',
  συχνοτητα: 'frequency', οροφοι: 'floors', ανελκυστηρασ: 'has_lift', ασανσερ: 'has_lift', lift: 'has_lift',
};
const TRUE = new Set(['1', 'true', 'yes', 'y', 'ναι', 'ν', 'x', '✓']);
const FALSE = new Set(['0', 'false', 'no', 'n', 'οχι', 'όχι', 'ο', '']);

export class TableError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

function column(header: unknown): string {
  const key = normalize(String(header)).replace(/[^\p{L}\p{N}]|_/gu, '');
  return HEADER_ALIASES[key] ?? String(header).trim().toLowerCase();
}

function parseFrequency(value: string): Frequency | null {
  const v = normalize(value).trim();
  if ((FREQUENCIES as string[]).includes(v)) return v as Frequency;
  if (v.includes('καθε 2') || v.includes('15ημερ') || v.includes('δεκαπενθ') || v.includes('every 2')) return 'biweekly';
  const m = v.match(/^([123])\s*(φορ|×|x|times|\/)/);
  return m ? (`${m[1]}w` as Frequency) : null;
}

/** importer.import_rows for a table given as a header row plus data rows. */
export function importRows(table: string[][], index: AddressIndex): ImportResult {
  const [header = [], ...data] = table;
  const cols = header.map(column);
  const missing = ['street', 'number'].filter((c) => !cols.includes(c));
  if (missing.length) {
    throw new TableError('missing_columns', `missing required column(s): ${missing.join(', ')}; expected street, number, postcode, frequency, floors, has_lift`);
  }
  const rows: ImportRow[] = data
    .filter((r) => r.some((x) => String(x ?? '').trim()))
    .map((r) => {
      const raw: Record<string, string> = {};
      cols.forEach((c, i) => { raw[c] = String(r[i] ?? '').trim(); });
      const m = index.lookup(raw.street ?? '', raw.number ?? '', raw.postcode);
      const issues = [...m.issues];
      const freq = parseFrequency(raw.frequency ?? '');
      if (raw.frequency && !freq) issues.push(issue('unknown_frequency', `unknown frequency '${raw.frequency}' (use ${FREQUENCIES.join(', ')})`, raw.frequency));
      if (raw.floors) {
        const f = Math.trunc(Number(raw.floors));
        if (Number.isNaN(f)) issues.push(issue('floors_not_number', `floors is not a number: ${raw.floors}`, raw.floors));
        else if (f < 1 || f > 20) issues.push(issue('floors_out_of_range', `floors out of range: ${raw.floors}`, raw.floors));
      }
      const lift = (raw.has_lift ?? '').toLowerCase();
      if (lift && !TRUE.has(lift) && !FALSE.has(lift)) issues.push(issue('has_lift_unknown', `has_lift not understood: ${raw.has_lift}`, raw.has_lift));
      const row: ImportRow = { input: raw, matched: m.matched, confidence: m.confidence };
      if (freq) row.frequency = freq;
      if (m.lat != null) Object.assign(row, { lat: m.lat, lng: m.lng, matched_label: m.label });
      if (issues.length) { row.issue = issues.map((i) => i.text).join('; '); row.issues = issues; }
      return row;
    });
  const matched = rows.filter((r) => r.matched).length;
  return {
    rows,
    summary: {
      total: rows.length, matched,
      exact: rows.filter((r) => r.matched && r.confidence >= 0.95).length,
      needs_review: rows.filter((r) => r.matched && r.confidence < 0.95).length,
      unmatched: rows.length - matched,
      with_issues: rows.filter((r) => r.issue).length,
      geocoder: 'offline index of OpenStreetMap addresses (in the browser)',
    },
  };
}

/** Minimal CSV reader: sniffs , ; or tab from the header line and honours double quotes. */
export function parseCsv(text: string): string[][] {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const sep = [',', ';', '\t'].reduce((a, b) => (first.split(b).length > first.split(a).length ? b : a));
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
