export function Logo({ size = 28 }: { size?: number }) {
  // A route line visiting three stops inside a rounded tile. No national symbols.
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M8 22c3 0 4-4 8-4s4-6 8-6" fill="none" stroke="var(--accent-contrast)" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="0.1 4.2" />
      <circle cx="8" cy="22" r="2.6" fill="var(--accent-contrast)" />
      <circle cx="16" cy="18" r="2.6" fill="var(--accent-contrast)" />
      <circle cx="24" cy="12" r="2.6" fill="var(--accent-contrast)" />
    </svg>
  );
}
