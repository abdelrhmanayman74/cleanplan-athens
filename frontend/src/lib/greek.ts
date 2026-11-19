// Tiny helpers so Greek sentences read naturally ("της Μαρίας", "του Γιώργου").

export function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] ?? full;
}

/** Genitive with article for a Greek first name. Heuristic but covers common names. */
export function genitiveWithArticle(name: string): string {
  const n = firstName(name);
  const lower = n.toLowerCase();
  const rules: [RegExp, (s: string) => string, string][] = [
    [/ος$/, (s) => s.slice(0, -2) + 'ου', 'του'],
    [/ός$/, (s) => s.slice(0, -2) + 'ού', 'του'],
    [/ης$/, (s) => s.slice(0, -2) + 'η', 'του'],
    [/ής$/, (s) => s.slice(0, -2) + 'ή', 'του'],
    [/ας$/, (s) => s.slice(0, -2) + 'α', 'του'],
    [/άς$/, (s) => s.slice(0, -2) + 'ά', 'του'],
    [/[αά]$/, (s) => s + 'ς', 'της'],
    [/[ηή]$/, (s) => s + 'ς', 'της'],
    [/[ωώ]$/, (s) => s, 'της'],
  ];
  for (const [re, fn, art] of rules) if (re.test(lower)) return `${art} ${fn(n)}`;
  return `του/της ${n}`;
}

/** Nominative with article: "ο Γιώργος", "η Μαρία" (first name only). */
export function withArticle(name: string): string {
  const n = firstName(name);
  return `${/(ος|ός|ης|ής|ας|άς)$/.test(n.toLowerCase()) ? 'ο' : 'η'} ${n}`;
}
