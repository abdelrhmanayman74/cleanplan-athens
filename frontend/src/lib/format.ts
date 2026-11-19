export function fmtNumber(n: number, lang: string, digits = 0): string {
  return new Intl.NumberFormat(lang === 'el' ? 'el-GR' : 'en-GB', {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(n);
}

export function fmtPct(x: number, lang: string, digits = 0): string {
  return `${fmtNumber(x * 100, lang, digits)}%`;
}

export function fmtUsd(n: number, lang: string): string {
  return new Intl.NumberFormat(lang === 'el' ? 'el-GR' : 'en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: n < 100 ? 2 : 0,
  }).format(n);
}

export function fmtSigned(n: number, lang: string, digits = 0): string {
  const s = fmtNumber(Math.abs(n), lang, digits);
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
}

/** Whole minutes for walking legs and totals: "3′", or "<1 λεπτό" instead of "0′". */
export function fmtMinutes(m: number, lang: string): string {
  if (m < 0.5) return lang === 'el' ? '<1 λεπτό' : '<1 min';
  return `${fmtNumber(Math.round(m), lang)}′`;
}

/** Duration as hours and minutes: "5ώ 17λ", "8ώ" (en: "5h 17m", "8h"). */
export function fmtHM(m: number, lang: string): string {
  const total = Math.round(m);
  const h = Math.floor(total / 60), r = total % 60;
  const [hu, mu] = lang === 'el' ? ['ώ', 'λ'] : ['h', 'm'];
  if (!h) return `${r}${mu}`;
  return r ? `${h}${hu} ${r}${mu}` : `${h}${hu}`;
}

/** Rough duration for slack and margins: "~40′", "~1 ώρα", "~1,5 ώρες". */
export function fmtApprox(m: number, lang: string): string {
  if (m < 52.5) return `~${fmtNumber(Math.max(5, Math.round(m / 5) * 5), lang)}′`;
  const h = Math.round((m / 60) * 2) / 2;
  const unit = lang === 'el' ? (h === 1 ? 'ώρα' : 'ώρες') : h === 1 ? 'hour' : 'hours';
  return `~${fmtNumber(h, lang, h % 1 ? 1 : 0)} ${unit}`;
}

/** Masks a phone number for display: "6923852145" -> "69•• ••• 145". */
export function maskPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length < 6 ? '•••' : `${d.slice(0, 2)}•• ••• ${d.slice(-3)}`;
}

export function fmtEur(n: number, lang: string): string {
  return new Intl.NumberFormat(lang === 'el' ? 'el-GR' : 'en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
}
